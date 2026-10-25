#!/usr/bin/env python3
"""Run decoded-lease.mjs against a baseline and a candidate web package in Chrome or WebKitGTK.

Browser completion is required; the page's own PASS is re-validated here. Packages are copied
to a temporary server root; external/, public/ and the product are never written.
"""
import argparse
from contextlib import ExitStack
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
import sys
sys.path.insert(0, str(HERE))
from run import engine, free_port, request, stop  # noqa: E402

# Authoritative named contract for decoded-lease.mjs. Each arm runs its tests in this order;
# checkpoints are the candidate ledger snapshots the tests assert on (extra snapshots, such as
# eviction attempts, are allowed but must be unique and satisfy the same equations).
BASELINE_TESTS = (
    'baseline-raw-handle-invalidated-by-unrelated-eviction', 'baseline-pending-job-handle-invalidated',
    'baseline-pending-job-redecodes-after-eviction', 'baseline-full-frame-exact',
    'baseline-temporary-released-before-pending-return', 'baseline-zero-budget-temporary-released',
)
CANDIDATE_TESTS_1 = (
    'cache-only-eviction-disposes-backing', 'job-lease-survives-unrelated-eviction',
    'evicted-leased-backing-counted-once-nonresident', 'leased-job-completes-without-redecode',
    'last-job-release-disposes-evicted-backing', 'decoded-cache-policy-identical-to-baseline',
    'leased-full-frame-exact', 'nonresident-temporary-retained-across-pending',
    'nonresident-temporary-released-at-completion', 'zero-budget-synchronous-temporary-released',
    'shared-jobs-one-backing', 'shared-cancel-one-keeps-backing', 'shared-final-cancel-disposes',
    'cancel-pending-releases', 'close-pending-releases', 'mutation-releases', 'stale-generation-releases',
    'expiry-releases', 'resource-error-releases', 'repeated-terminal-no-double-release',
    'pressure-many-images-bounded', 'cross-engine-full-frame-exact', 'pressure-revocation-bounds-nonresident',
    'pressure-full-frame-exact', 'decoded-release-no-false-capacity-notification',
)
CANDIDATE_TESTS_2 = CANDIDATE_TESTS_1 + (
    'tiny-images-job-lease-entries-bounded', 'tiny-images-shared-across-jobs-bounded',
    'tiny-images-cancel-keeps-shared-backing', 'tiny-images-full-frame-exact',
    'tiny-images-cache-pressure-bounded', 'tiny-images-cache-pressure-full-frame-exact',
    'malformed-preflight-matches-baseline', 'oversize-header-refused-before-allocation',
    'legacy-sync-tiny-images-exact',
)
LIFECYCLE = ('cancel-pending-releases', 'close-pending-releases', 'mutation-releases',
             'stale-generation-releases', 'expiry-releases', 'resource-error-releases')
CHECKPOINTS_1 = (
    's0-after', 's1-pending', 's1-evicted', 's1-complete', 's1-trimmed', 's2-pending', 's2-complete', 's2-sync',
    's3-shared', 's3-cancel-one', 's3-cancel-both',
    *(f'{name}-{phase}' for name in LIFECYCLE for phase in ('pending', 'after')),
    'repeat-before', 'repeat-after', 's5a-pending', 's5b-pending', 's5b-stats', 's5b-revocations', 's5b-complete',
    's6-before', 's6-after',
)
CHECKPOINTS_2 = CHECKPOINTS_1 + (
    's7-before', 's7-a-pending', 's7-b-pending', 's7-cancel-a', 's7-complete', 's8-pending', 's8-complete',
    's8-trimmed', 's9-before', 's9-after', 's10-before', 's10-after', 's11-before', 's11-after',
)
CONTRACTS = {
    1: {'baseline': BASELINE_TESTS, 'candidate': CANDIDATE_TESTS_1 + ('final-ledger-zero',),
        'checkpoints': CHECKPOINTS_1 + ('final',), 'metadata': False},
    2: {'baseline': BASELINE_TESTS, 'candidate': CANDIDATE_TESTS_2 + ('final-ledger-zero',),
        'checkpoints': CHECKPOINTS_2 + ('final',), 'metadata': True},
}
CURRENT_CONTRACT = 2
MIB = 1 << 20
# Declared limits (source constants); a result reporting other values is rejected.
JOB_LIMITS = {'maxPending': 2, 'maxResources': 256, 'maxOwnedBytes': 256 * MIB, 'maxFrameBytes': 64 * MIB,
              'maxStagingBytes': 128 * MIB}
MAX_NONRESIDENT = 96 * MIB
MAX_JOB_DECODED_LEASES = 256
MAX_JOBS = 8
LEDGER_INTS = ('uniqueBytes', 'uniqueCount', 'residentBytes', 'residentCount', 'nonresidentBytes', 'nonresidentCount',
               'jobLeaseReferences', 'jobLeaseReferenceBytes', 'reservedBytes', 'peakUniquePlusReservedBytes',
               'maxNonresidentBytes', 'decodedCacheMaxBytes', 'decodedCacheMaxEntries', 'created', 'disposed',
               'refusedReservations', 'unenforcedOverLimit', 'accountingErrors', 'unreservedDecodes')
LEDGER_INTS_2 = ('rejectedCommits', 'postDecodeReservations', 'preallocationRejections')
JOB_INTS = ('activeJobs', 'ownedEstimatedBytes', 'pendingCount', 'capacityNotifications', 'listenerNotifications',
            'decodedRevocations', 'decodedSharedLookups', 'decodedRegistryLive', *JOB_LIMITS)
JOB_INTS_2 = ('decodedRegistryEntries', 'decodedAttachRefusals', 'maxJobDecodedLeases', 'maxJobLeaseEntries')


class Invalid(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Invalid(message)


def is_int(value):
    return type(value) is int and value >= 0


def check_ledger(label, point, metadata):
    require(type(point) is dict and set(point) == {'label', 'decodedLedger', 'jobs'}, f'malformed checkpoint {label}')
    l, jobs = point['decodedLedger'], point['jobs']
    require(type(l) is dict and type(jobs) is dict, f'malformed ledger objects at {label}')
    for name in LEDGER_INTS + (LEDGER_INTS_2 if metadata else ()):
        require(is_int(l.get(name)), f'invalid ledger field {name} at {label}')
    for name in JOB_INTS + (JOB_INTS_2 if metadata else ()):
        require(is_int(jobs.get(name)), f'invalid job field {name} at {label}')
    require(jobs.get('decodedLedger') == l, f'ledger copy differs from job statistics at {label}')
    require(l['maxNonresidentBytes'] == MAX_NONRESIDENT and all(jobs[k] == v for k, v in JOB_LIMITS.items()),
            f'declared limits changed at {label}')
    require(l['uniqueBytes'] == l['residentBytes'] + l['nonresidentBytes'], f'unique != resident + nonresident bytes at {label}')
    require(l['uniqueCount'] == l['residentCount'] + l['nonresidentCount'], f'unique != resident + nonresident count at {label}')
    require(l['created'] - l['disposed'] == l['uniqueCount'], f'created - disposed != live backings at {label}')
    require(l['accountingErrors'] == 0 and l['reservedBytes'] == 0, f'accounting error or open reservation at {label}')
    require(l['nonresidentBytes'] <= l['maxNonresidentBytes'], f'nonresident budget exceeded at {label}')
    require(l['residentBytes'] <= l['decodedCacheMaxBytes'] and l['residentCount'] <= l['decodedCacheMaxEntries'],
            f'resident cache budget exceeded at {label}')
    require(l['uniqueBytes'] <= l['decodedCacheMaxBytes'] + l['maxNonresidentBytes'], f'unique bound exceeded at {label}')
    require(l['peakUniquePlusReservedBytes'] >= l['uniqueBytes'], f'peak below current at {label}')
    require(jobs['decodedRegistryLive'] <= l['uniqueCount'], f'registry reports more live backings than exist at {label}')
    if metadata:
        require(jobs['maxJobDecodedLeases'] == MAX_JOB_DECODED_LEASES, f'declared lease entry limit changed at {label}')
        require(jobs['maxJobLeaseEntries'] <= MAX_JOB_DECODED_LEASES, f'job lease entries exceed the bound at {label}')
        require(l['jobLeaseReferences'] <= MAX_JOBS * MAX_JOB_DECODED_LEASES, f'job lease references exceed the bound at {label}')
        require(jobs['decodedRegistryLive'] <= jobs['decodedRegistryEntries'], f'inconsistent registry counters at {label}')
        require(l['rejectedCommits'] == 0 and l['preallocationRejections'] == 0, f'unexpected size mismatch at {label}')


def validate(value, contract=CURRENT_CONTRACT):
    """A PASS must prove every named test and checkpoint of `contract` was supplied and holds."""
    require(type(value) is dict and value.get('schema') == 1 and value.get('status') in ('PASS', 'FAIL'),
            'invalid completion status')
    if value['status'] != 'PASS':
        return
    spec = CONTRACTS[contract]
    require(value.get('contract', 1) == contract, 'result contract differs from the served test contract')
    require('error' not in value, 'top-level PASS carries an error')
    tests = value.get('tests')
    require(type(tests) is list and all(type(t) is dict for t in tests), 'malformed tests')
    for t in tests:
        require(type(t.get('name')) is str and t.get('arm') in ('baseline', 'candidate'), 'malformed test identity')
        require(t.get('status') == 'PASS', f'check {t.get("arm")}:{t.get("name")} is not PASS')
    actual = [(t['arm'], t['name']) for t in tests]
    expected = [('baseline', n) for n in spec['baseline']] + [('candidate', n) for n in spec['candidate']]
    if actual != expected:
        seen, duplicate = set(), []
        for item in actual:
            if item in seen:
                duplicate.append(item)
            seen.add(item)
        missing = sorted(set(expected) - seen)
        unexpected = sorted(seen - set(expected))
        raise Invalid('test contract mismatch: ' + json.dumps({'missing': missing, 'duplicate': duplicate,
                                                               'unexpected': unexpected,
                                                               'outOfOrder': not (missing or duplicate or unexpected)}))
    ledger = value.get('ledger')
    require(type(ledger) is list and ledger, 'ledger observations are missing')
    labels = []
    for point in ledger:
        require(type(point) is dict and type(point.get('label')) is str, 'malformed checkpoint label')
        require(point['label'].startswith('candidate:'), 'ledger checkpoint attributed to the wrong arm')
        labels.append(point['label'].removeprefix('candidate:'))
    require(len(labels) == len(set(labels)), 'duplicate ledger checkpoint')
    position = {label: i for i, label in enumerate(labels)}
    missing = [c for c in spec['checkpoints'] if c not in position]
    require(not missing, 'missing ledger checkpoints: ' + ', '.join(missing))
    order = [position[c] for c in spec['checkpoints']]
    require(order == sorted(order), 'ledger checkpoints out of order')
    require(labels[-1] == 'final', 'final cleanup checkpoint is not last')
    for label, point in zip(labels, ledger):
        check_ledger(label, point, spec['metadata'])
    final = ledger[-1]
    l, jobs = final['decodedLedger'], final['jobs']
    require(l['uniqueBytes'] == l['uniqueCount'] == l['residentBytes'] == l['nonresidentBytes'] == 0
            and l['jobLeaseReferences'] == l['jobLeaseReferenceBytes'] == 0 and l['created'] == l['disposed'] > 0,
            'final checkpoint does not prove released decoded backings')
    require(jobs['activeJobs'] == jobs['ownedEstimatedBytes'] == jobs['pendingCount'] == jobs['decodedRegistryLive'] == 0,
            'final checkpoint has active jobs or owned resources')
    if spec['metadata']:
        require(jobs['decodedRegistryEntries'] == jobs['maxJobLeaseEntries'] == 0, 'final checkpoint keeps lease metadata')
    transitions = value.get('transitions')
    require(type(transitions) is list and [t.get('arm') if type(t) is dict else None for t in transitions]
            == ['baseline', 'candidate'], 'cleanup transitions are incomplete')
    require(transitions[1].get('cleanup', {}).get('jobs') == jobs, 'candidate cleanup differs from the final checkpoint')


def outcome(value, contract=CURRENT_CONTRACT):
    """Recorded status: only a fully validated PASS is PASS; anything malformed raises."""
    validate(value, contract)
    return value['status']


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--baseline', type=Path, required=True)
    p.add_argument('--candidate', type=Path, required=True)
    p.add_argument('--browser', choices=('chrome', 'webkit'), required=True)
    p.add_argument('--chrome', default=shutil.which('google-chrome') or shutil.which('chromium'))
    p.add_argument('--webkit-driver', default=shutil.which('WebKitWebDriver'))
    p.add_argument('--xvfb', default=shutil.which('Xvfb'))
    p.add_argument('--timeout', type=float, default=180)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    if a.output.exists():
        p.error('preserve previous output')
    result = {'schema': 1, 'browser': a.browser, 'status': 'FAIL'}
    with ExitStack() as stack:
        temporary = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='geul-decoded-lease-')))
        web = temporary / 'web'; web.mkdir()
        result['identities'] = {name: engine(source.resolve(), web / name)
                                for name, source in (('baseline', a.baseline), ('candidate', a.candidate))}
        (web / 'index.html').write_text('<!doctype html><meta charset="utf-8"><title>decoded lease</title>'
                                        '<script type="module" src="/decoded-lease.mjs"></script>')
        for name in ('decoded-lease.mjs', 'fixtures.mjs'):
            shutil.copy2(HERE / name, web / name)
        result['testSourcesSha256'] = {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(web.iterdir()) if f.is_file()}
        result['testSourcesSha256']['decoded_lease_run.py'] = hashlib.sha256((HERE / 'decoded_lease_run.py').read_bytes()).hexdigest()
        event, received, held = threading.Event(), [], {}

        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(web), **kwargs)

            def log_message(self, *_args):
                pass

            def end_headers(self):
                self.send_header('Cache-Control', 'no-store')
                super().end_headers()

            def do_GET(self):
                parsed = urlparse(self.path); query = parse_qs(parsed.query)
                if parsed.path in ('/held-image.svg', '/release-image'):
                    signal = held.setdefault(query.get('key', [''])[0], threading.Event())
                    if parsed.path == '/release-image':
                        signal.set(); self.send_response(204); self.end_headers(); return
                    signal.wait(30)
                    self.send_response(200); self.send_header('Content-Type', 'image/svg+xml'); self.end_headers()
                    try:
                        import base64
                        body = b'invalid image' if 'error' in query else base64.b64decode(query['data'][0].split(',', 1)[1])
                        self.wfile.write(body)
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    return
                super().do_GET()

            def do_POST(self):
                size = int(self.headers.get('Content-Length', '0'))
                if self.path != '/result' or not 0 < size <= 8 << 20:
                    self.send_error(400); return
                received.append(json.loads(self.rfile.read(size)))
                self.send_response(204); self.end_headers(); event.set()

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        stack.callback(server.server_close); stack.callback(server.shutdown)
        url = f'http://127.0.0.1:{server.server_port}/index.html'
        log = stack.enter_context((temporary / 'browser.log').open('wb'))
        try:
            if a.browser == 'chrome':
                if not a.chrome:
                    raise RuntimeError('Chrome unavailable')
                result['version'] = subprocess.check_output([a.chrome, '--version'], text=True).strip()
                browser = subprocess.Popen([a.chrome, '--headless=new', '--disable-gpu', '--no-first-run',
                                            '--no-default-browser-check', '--no-sandbox',
                                            f'--user-data-dir={temporary / "chrome"}', url],
                                           stdout=log, stderr=subprocess.STDOUT, env={**os.environ, 'TMPDIR': str(temporary)})
                stack.callback(stop, browser)
            else:
                if not a.webkit_driver:
                    raise RuntimeError('WebKitWebDriver unavailable')
                env = {**os.environ, 'TMPDIR': str(temporary), 'LIBGL_ALWAYS_SOFTWARE': '1', 'WEBKIT_DISABLE_DMABUF_RENDERER': '1',
                       'XDG_DATA_HOME': str(temporary / 'data'), 'XDG_CACHE_HOME': str(temporary / 'cache'),
                       'XDG_CONFIG_HOME': str(temporary / 'config')}
                if a.xvfb:
                    display_file = stack.enter_context((temporary / 'display').open('w+b'))
                    xvfb = subprocess.Popen([a.xvfb, '-displayfd', str(display_file.fileno()), '-screen', '0', '1280x1024x24'],
                                            pass_fds=(display_file.fileno(),), stdout=log, stderr=subprocess.STDOUT)
                    stack.callback(stop, xvfb)
                    deadline = time.monotonic() + 10
                    while True:
                        display_file.seek(0); number = display_file.read().decode().strip()
                        if number: break
                        if time.monotonic() > deadline: raise RuntimeError('Xvfb startup timeout')
                        time.sleep(0.05)
                    env.update(DISPLAY=':' + number, GDK_BACKEND='x11'); env.pop('WAYLAND_DISPLAY', None)
                port = free_port(); base = f'http://127.0.0.1:{port}'
                browser = subprocess.Popen([a.webkit_driver, f'--port={port}'], env=env, stdout=log, stderr=subprocess.STDOUT)
                stack.callback(stop, browser)
                deadline = time.monotonic() + 15
                while True:
                    try:
                        request(base, 'GET', '/status'); break
                    except (OSError, urllib.error.URLError):
                        if time.monotonic() > deadline: raise RuntimeError('WebKit driver startup timeout')
                        time.sleep(0.1)
                session = request(base, 'POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'MiniBrowser'}}})
                stack.callback(request, base, 'DELETE', '/session/' + session['sessionId'])
                result['version'] = {k: v for k, v in session['capabilities'].items() if k != 'webkit:processID'}
                request(base, 'POST', '/session/' + session['sessionId'] + '/url', {'url': url})
            deadline = time.monotonic() + a.timeout
            while not event.wait(0.25):
                if browser.poll() is not None:
                    raise RuntimeError(f'browser exited before completion: {browser.returncode}')
                if time.monotonic() > deadline:
                    raise RuntimeError('browser test timed out before final result; FAIL')
            time.sleep(0.2)
            if len(received) != 1:
                raise RuntimeError('invalid or duplicate result')
            result['run'] = received[0]
            result['status'] = outcome(received[0])
            result['contract'] = CURRENT_CONTRACT
        except Exception as error:  # noqa: BLE001 - every failure is a recorded FAIL
            result['error'] = str(error).replace(str(temporary), '<temporary>')
        finally:
            a.output.parent.mkdir(parents=True, exist_ok=True)
            a.output.write_text(json.dumps(result, indent=2, ensure_ascii=False).replace(str(ROOT), '<workspace>') + '\n')
    print(json.dumps({'browser': a.browser, 'status': result['status'], 'error': result.get('error')}))
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
