#!/usr/bin/env python3
"""Run actual pinned/candidate rhwp WASM in Chrome or WebKitGTK; noncompletion is FAIL."""
import argparse
from contextlib import ExitStack
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def engine(source, destination):
    destination.mkdir()
    identity = {}
    for name in ('rhwp.js', 'rhwp_bg.wasm'):
        shutil.copy2(source / name, destination / name)
        identity[name] = sha(destination / name)
    for name in ('ENGINE.json', 'BUILD.json'):
        if (source / name).is_file():
            identity[name] = json.loads((source / name).read_text())
    return identity


def multisection_fixture(destination):
    """Deterministic three-section fixture from the pinned public blank template."""
    with zipfile.ZipFile(ROOT / 'external/rhwp/saved/blank_hwpx.hwpx') as source:
        files = {name: source.read(name) for name in source.namelist()}
    package = files['Contents/content.hpf'].decode()
    package = package.replace('</opf:manifest>', ''.join(
        f'<opf:item id="section{i}" href="Contents/section{i}.xml" media-type="application/xml"/>'
        for i in (1, 2)) + '</opf:manifest>')
    package = package.replace('</opf:spine>', ''.join(
        f'<opf:itemref idref="section{i}"/>' for i in (1, 2)) + '</opf:spine>')
    files['Contents/content.hpf'] = package.encode()
    section = files['Contents/section0.xml'].decode()
    for i in range(3):
        body = section.replace('<hp:t/>', f'<hp:t>section {i}</hp:t>')
        body = body.replace('<hp:t></hp:t>', f'<hp:t>section {i}</hp:t>')
        if i == 1:
            body = body.replace('width="59528" height="84186"', 'width="84186" height="59528"')
        files[f'Contents/section{i}.xml'] = body.encode()
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as target:
        for name, data in files.items():
            target.writestr(zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0)), data)


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def request(base, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(base + path, data=data, method=method, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(r, timeout=30) as response:
        return json.load(response).get('value')


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)


def validate_result(value, require_ownership=False, require_scheduler=False):
    """Independently validate mandatory gates; a browser's top-level PASS is not proof."""
    if value.get('schema') != 1 or value.get('status') not in ('PASS', 'FAIL'):
        raise RuntimeError('invalid completion status')
    if value.get('error'):
        if value['status'] == 'PASS':
            raise RuntimeError('PASS containing browser error')
        return
    if value.get('historical', {}).get('draws') != 50 or len(value.get('historical', {}).get('candidate', {}).get('results', {})) != 12:
        raise RuntimeError('incomplete historical scenario result')
    formats = value.get('formats', [])
    if len(formats) != 2 or {f.get('format') for f in formats} != {'hwp', 'hwpx'}:
        raise RuntimeError('incomplete HWP/HWPX load result')
    gates = [value.get(name, {}).get('status') for name in ('pending', 'concurrent', 'historical')]
    gates += [f.get('status') for f in formats]
    if any(g not in ('PASS', 'FAIL') for g in gates):
        raise RuntimeError('incomplete safety scenario result')
    required = [(value['pending'], 'requests'), (value['concurrent'], 'loadAttempts'),
                (value['concurrent'], 'notifications'), (value['concurrent'], 'pixelMismatchCount')]
    required += [(f, 'pixelMismatchCount') for f in formats]
    for row, name in required:
        n = row.get(name)
        if isinstance(n, bool) or not isinstance(n, (int, float)) or not 0 <= n < float('inf'):
            raise RuntimeError('missing or invalid required measurement: ' + name)
    for name in ('during', 'reduced', 'trimmedWhilePending', 'afterClosedCallbacks', 'afterFinalTrim'):
        row = value['pending'].get(name, {}).get('images', {})
        if any(type(row.get(k)) is not int or row[k] < 0 for k in ('bytes', 'entries', 'pendingEntries')):
            raise RuntimeError('missing required pending measurement: ' + name)
    if require_ownership and 'ownership' not in value:
        raise RuntimeError('missing required ownership gate')
    if 'ownership' in value:
        ownership = value['ownership']
        rows = ownership.get('tests', [])
        if ownership.get('status') not in ('PASS', 'FAIL') or not rows or any(t.get('status') not in ('PASS', 'FAIL') for t in rows):
            raise RuntimeError('incomplete ownership result')
        gates += [ownership['status']] + [t['status'] for t in rows]
        checkpoints = ownership.get('checkpoints', [])
        if not checkpoints:
            raise RuntimeError('missing ownership measurements')
        for checkpoint in checkpoints:
            job = checkpoint.get('jobs', {})
            fields = ('pendingCount', 'inFlightEstimatedBytes', 'readyLeaseCount', 'transientEstimatedBytes',
                      'ownedEstimatedBytes', 'activeLeaseEstimatedBytes', 'temporaryCanvasBytes',
                      'peakTemporaryCanvasBytes', 'loadAttempts', 'completionNotifications', 'retryCount',
                      'cancellations', 'errors', 'resourceLimits', 'maxOwnedBytes', 'maxPending', 'maxResources', 'maxFrameBytes',
                      'backupImageDataBytes', 'peakBackupImageDataBytes', 'peakStagingBytes', 'maxStagingBytes')
            if any(type(job.get(k)) is not int or job[k] < 0 for k in fields):
                raise RuntimeError('missing or invalid ownership measurement')
            if value['status'] == 'PASS' and (job['pendingCount'] > job['maxPending'] or
                    job['ownedEstimatedBytes'] > job['maxOwnedBytes'] or
                    job['peakTemporaryCanvasBytes'] > job['maxFrameBytes'] or job['temporaryCanvasBytes'] != 0 or
                    job['backupImageDataBytes'] != 0 or job['peakBackupImageDataBytes'] > job['maxFrameBytes'] or
                    job['peakStagingBytes'] > job['maxStagingBytes']):
                raise RuntimeError('ownership measurement violates resource budget')

    if require_scheduler and 'scheduler' not in value:
        raise RuntimeError('missing mandatory scheduler gate')
    if 'scheduler' in value:
        scheduler = value['scheduler']; rows = scheduler.get('tests', [])
        required_names = {'count-saturation-admits', 'bytes-saturation-admits',
                          'notification-progress-cancel-one', 'notification-progress-cancel-both',
                          'notification-progress-dispose', 'notification-progress-replace',
                          'notification-progress-mutate', 'notification-progress-shared-owner',
                          'notification-progress-complete', 'notification-progress-error',
                          'notification-progress-budget', 'notification-progress-trim',
                          'notification-progress-competition', 'notification-progress-deadline',
                          'active-saturation-waits-without-publication', 'active-owner-release-progress',
                          'intrinsic-active-byte-limit-explicit', 'resident-eviction-during-shared-draw',
                          'shared-resident-close-one-preserves-pixels'}
        if scheduler.get('status') not in ('PASS', 'FAIL') or not required_names <= {r.get('name') for r in rows}:
            raise RuntimeError('incomplete scheduler scenarios')
        gates += [scheduler['status']] + [r.get('status') for r in rows]
        for row in rows:
            if row.get('status') not in ('PASS', 'FAIL'):
                raise RuntimeError('invalid scheduler subtest status')
            if value['status'] == 'PASS' and (row.get('pixelMismatchCount', 0) != 0 or
                    row.get('notifications', 0) > 5 or row.get('requiredPendingCount', 0) > 0):
                raise RuntimeError('scheduler pixel/publication/notification violation')
        points = scheduler.get('checkpoints', [])
        if not points:
            raise RuntimeError('missing scheduler accounting')
        for point in points:
            job = point.get('jobs', {})
            if require_scheduler and any(type(job.get(k)) is not int or job[k] < 0 for k in
                    ('uniqueResourceCount', 'activeLeaseCount', 'capacityNotifications', 'listenerNotifications',
                     'pendingCount', 'ownedEstimatedBytes', 'activeJobs', 'maxPending', 'maxOwnedBytes', 'maxResources')):
                raise RuntimeError('missing scheduler measurements')
            if require_scheduler and (job['maxPending'] != 2 or job['maxResources'] != 256 or job['maxOwnedBytes'] != 256 << 20):
                raise RuntimeError('scheduler declared limits changed')
            if value['status'] == 'PASS' and (job.get('uniqueResourceCount', 0) > job.get('maxResources', 0) or
                    job.get('pendingCount', 0) > job.get('maxPending', 0) or
                    job.get('ownedEstimatedBytes', 0) > job.get('maxOwnedBytes', 0) or
                    job.get('activeJobs', 0) > 8):
                raise RuntimeError('scheduler resource limit violation')

    if value['status'] == 'PASS' and (any(g != 'PASS' for g in gates) or value.get('unhandledErrors')):
        raise RuntimeError('top-level PASS contradicts mandatory subordinate gate')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--pinned', type=Path, required=True, help='Explicit web package directory')
    p.add_argument('--candidate', type=Path, required=True)
    p.add_argument('--browser', choices=('chrome', 'webkit'), required=True)
    p.add_argument('--chrome', default=shutil.which('google-chrome') or shutil.which('chromium'))
    p.add_argument('--webkit-driver', default=shutil.which('WebKitWebDriver'))
    p.add_argument('--xvfb', default=shutil.which('Xvfb'))
    p.add_argument('--timeout', type=float, default=120)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    result = {'schema': 1, 'browser': a.browser, 'status': 'FAIL'}
    with ExitStack() as stack:
        temporary = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='geul-cache-browser-')))
        web = temporary / 'web'; web.mkdir()
        result['identities'] = {name: engine(source.resolve(), web / name) for name, source in [('pinned', a.pinned), ('candidate', a.candidate)]}
        for name in ('index.html', 'browser.mjs', 'historical.mjs', 'fixtures.mjs', 'historical-expected.json', 'ownership.mjs', 'job-historical.mjs', 'scheduler.mjs'):
            shutil.copy2(HERE / name, web / name)
        multisection_fixture(web / 'multisection.hwpx')
        result['testSourcesSha256'] = {path.name: sha(path) for path in web.iterdir() if path.is_file()}
        result['testSourcesSha256']['run.py'] = sha(HERE / 'run.py')
        event = threading.Event()
        received = []
        held_images = {}

        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(web), **kwargs)

            def log_message(self, *_args):
                pass

            def end_headers(self):
                self.send_header('Cache-Control', 'no-store')
                super().end_headers()

            def do_GET(self):
                from urllib.parse import urlparse, parse_qs
                parsed = urlparse(self.path); query = parse_qs(parsed.query)
                if parsed.path in ('/held-image.svg', '/release-image'):
                    key = query.get('key', [''])[0]
                    signal = held_images.setdefault(key, threading.Event())
                    if parsed.path == '/release-image':
                        signal.set(); self.send_response(204); self.end_headers(); return
                    signal.wait(20)
                    self.send_response(200); self.send_header('Content-Type', 'image/svg+xml'); self.end_headers()
                    try:
                        self.wfile.write(b'invalid image' if 'error' in query else __import__('base64').b64decode(query['data'][0].split(',',1)[1]) if 'data' in query else b'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>')
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    return
                super().do_GET()

            def do_POST(self):
                if self.path != '/result':
                    self.send_error(404); return
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 4 << 20:
                    self.send_error(413); return
                value = json.loads(self.rfile.read(size))
                received.append(value)
                self.send_response(204); self.end_headers(); event.set()

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        stack.callback(server.server_close)
        stack.callback(server.shutdown)
        url = f'http://127.0.0.1:{server.server_port}/index.html'
        log_path = temporary / 'browser.log'
        log = stack.enter_context(log_path.open('wb'))
        try:
            if a.browser == 'chrome':
                if not a.chrome:
                    raise RuntimeError('Chrome unavailable')
                result['version'] = subprocess.check_output([a.chrome, '--version'], text=True).strip()
                args = [a.chrome, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
                        '--no-sandbox', f'--user-data-dir={temporary / "chrome"}', url]
                browser = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT, env={**os.environ, 'TMPDIR': str(temporary)})
                stack.callback(stop, browser)
            else:
                if not a.webkit_driver:
                    raise RuntimeError('WebKitWebDriver unavailable')
                env = {**os.environ, 'TMPDIR': str(temporary), 'LIBGL_ALWAYS_SOFTWARE': '1', 'WEBKIT_DISABLE_DMABUF_RENDERER': '1',
                       'XDG_DATA_HOME': str(temporary / 'data'), 'XDG_CACHE_HOME': str(temporary / 'cache'),
                       'XDG_CONFIG_HOME': str(temporary / 'config')}
                if a.xvfb:
                    # -displayfd obtains a free display without reusing another task's X server.
                    display_file = stack.enter_context((temporary / 'display').open('w+b'))
                    xvfb = subprocess.Popen([a.xvfb, '-displayfd', str(display_file.fileno()), '-screen', '0', '1280x1024x24', '-dpi', '96'],
                                            pass_fds=(display_file.fileno(),), stdout=log, stderr=subprocess.STDOUT)
                    stack.callback(stop, xvfb)
                    deadline = time.monotonic() + 10
                    while display_file.seek(0) == 0:
                        number = display_file.read().decode().strip()
                        if number: break
                        if time.monotonic() > deadline: raise RuntimeError('Xvfb startup timeout')
                        time.sleep(0.05)
                    env.update(DISPLAY=':' + number, GDK_BACKEND='x11')
                    env.pop('WAYLAND_DISPLAY', None)
                port = free_port(); base = f'http://127.0.0.1:{port}'
                driver = subprocess.Popen([a.webkit_driver, f'--port={port}'], env=env, stdout=log, stderr=subprocess.STDOUT)
                stack.callback(stop, driver)
                deadline = time.monotonic() + 15
                while True:
                    try:
                        request(base, 'GET', '/status'); break
                    except (OSError, urllib.error.URLError):
                        if time.monotonic() > deadline: raise RuntimeError('WebKit driver startup timeout')
                        time.sleep(0.1)
                session = request(base, 'POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'MiniBrowser'}}})
                sid = session['sessionId']
                stack.callback(request, base, 'DELETE', '/session/' + sid)
                result['version'] = {k: v for k, v in session['capabilities'].items() if k != 'webkit:processID'}
                request(base, 'POST', '/session/' + sid + '/url', {'url': url})
                browser = driver
            deadline = time.monotonic() + a.timeout
            while not event.wait(0.25):
                if browser.poll() is not None:
                    raise RuntimeError(f'browser exited before completion: {browser.returncode}')
                if time.monotonic() > deadline:
                    raise RuntimeError('browser test timed out before final result; FAIL')
            # Collect immediately duplicated completion posts before accepting the one-shot result.
            # A result is final: the page must not submit another completion.
            event.wait(0.1)
            time.sleep(0.1)
            if len(received) != 1:
                raise RuntimeError('invalid or duplicate result')
            value = received[0]
            candidate_manifest = result['identities']['candidate'].get('ENGINE.json', {})
            require_ownership = candidate_manifest.get('rendererJobAPI') is True or 'src/renderer/render_job.rs' in candidate_manifest.get('sourceSha256', {})
            result['run'] = value  # Preserve rejected payload for failure diagnosis.
            validate_result(value, require_ownership=require_ownership, require_scheduler=candidate_manifest.get('schedulerAPI') is True)
            result['status'] = value['status']
        except Exception as e:
            result['error'] = str(e).replace(str(temporary), '<temporary>')
        finally:
            a.output.parent.mkdir(parents=True, exist_ok=True)
            a.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'browser': a.browser, 'status': result['status'], 'error': result.get('error')}))
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
