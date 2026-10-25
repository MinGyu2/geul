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

REQUIRED = {
    'baseline-raw-handle-invalidated-by-unrelated-eviction', 'baseline-pending-job-handle-invalidated',
    'baseline-pending-job-redecodes-after-eviction', 'baseline-temporary-released-before-pending-return',
    'cache-only-eviction-disposes-backing',
    'job-lease-survives-unrelated-eviction', 'evicted-leased-backing-counted-once-nonresident',
    'leased-job-completes-without-redecode', 'last-job-release-disposes-evicted-backing',
    'decoded-cache-policy-identical-to-baseline',
    'leased-full-frame-exact', 'nonresident-temporary-retained-across-pending',
    'nonresident-temporary-released-at-completion', 'zero-budget-synchronous-temporary-released',
    'shared-jobs-one-backing', 'shared-cancel-one-keeps-backing', 'shared-final-cancel-disposes',
    'cancel-pending-releases', 'close-pending-releases', 'mutation-releases', 'stale-generation-releases',
    'expiry-releases', 'resource-error-releases', 'repeated-terminal-no-double-release',
    'pressure-many-images-bounded', 'pressure-revocation-bounds-nonresident', 'pressure-full-frame-exact',
    'decoded-release-no-false-capacity-notification', 'cross-engine-full-frame-exact', 'final-ledger-zero',
}


def validate(value):
    if value.get('schema') != 1 or value.get('status') not in ('PASS', 'FAIL'):
        raise RuntimeError('invalid completion status')
    tests = value.get('tests', [])
    names = {t.get('name') for t in tests}
    if value['status'] == 'PASS':
        if not REQUIRED <= names:
            raise RuntimeError('missing required checks: ' + ', '.join(sorted(REQUIRED - names)))
        if any(t.get('status') != 'PASS' for t in tests) or value.get('error'):
            raise RuntimeError('top-level PASS contradicts a check')
        for point in value.get('ledger', []):
            l = point['decodedLedger']
            ints = ('uniqueBytes', 'residentBytes', 'nonresidentBytes', 'reservedBytes', 'maxNonresidentBytes',
                    'decodedCacheMaxBytes', 'accountingErrors', 'created', 'disposed')
            if any(type(l.get(k)) is not int or l[k] < 0 for k in ints):
                raise RuntimeError('invalid ledger measurement at ' + point.get('label', '?'))
            if (l['uniqueBytes'] != l['residentBytes'] + l['nonresidentBytes'] or l['accountingErrors'] != 0
                    or l['nonresidentBytes'] > l['maxNonresidentBytes'] or l['reservedBytes'] != 0
                    or l['uniqueBytes'] > l['decodedCacheMaxBytes'] + l['maxNonresidentBytes']
                    or l['disposed'] > l['created']):
                raise RuntimeError('ledger invariant violated at ' + point.get('label', '?'))
            jobs = point['jobs']
            if jobs['maxPending'] != 2 or jobs['maxResources'] != 256 or jobs['maxOwnedBytes'] != 256 << 20 \
                    or l['maxNonresidentBytes'] != 96 << 20:
                raise RuntimeError('declared limits changed')


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
            validate(received[0])
            result['status'] = received[0]['status']
        except Exception as error:  # noqa: BLE001 - every failure is a recorded FAIL
            result['error'] = str(error).replace(str(temporary), '<temporary>')
        finally:
            a.output.parent.mkdir(parents=True, exist_ok=True)
            a.output.write_text(json.dumps(result, indent=2, ensure_ascii=False).replace(str(ROOT), '<workspace>') + '\n')
    print(json.dumps({'browser': a.browser, 'status': result['status'], 'error': result.get('error')}))
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
