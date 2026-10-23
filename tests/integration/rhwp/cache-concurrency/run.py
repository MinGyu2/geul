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
        for name in ('index.html', 'browser.mjs', 'historical.mjs', 'fixtures.mjs', 'historical-expected.json'):
            shutil.copy2(HERE / name, web / name)
        result['testSourcesSha256'] = {path.name: sha(path) for path in web.iterdir() if path.is_file()}
        result['testSourcesSha256']['run.py'] = sha(HERE / 'run.py')
        event = threading.Event()
        received = []

        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(web), **kwargs)

            def log_message(self, *_args):
                pass

            def end_headers(self):
                self.send_header('Cache-Control', 'no-store')
                super().end_headers()

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
                browser = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT)
                stack.callback(stop, browser)
            else:
                if not a.webkit_driver:
                    raise RuntimeError('WebKitWebDriver unavailable')
                env = {**os.environ, 'LIBGL_ALWAYS_SOFTWARE': '1', 'WEBKIT_DISABLE_DMABUF_RENDERER': '1',
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
            if len(received) != 1 or received[0].get('schema') != 1:
                raise RuntimeError('invalid or duplicate result')
            value = received[0]
            if value.get('status') not in ('PASS', 'FAIL'):
                raise RuntimeError('invalid completion status')
            if not value.get('error'):
                if value.get('historical', {}).get('draws') != 50 or len(value.get('historical', {}).get('candidate', {}).get('results', {})) != 12:
                    raise RuntimeError('incomplete historical scenario result')
                if len(value.get('formats', [])) != 2 or any(f.get('status') not in ('PASS', 'FAIL') for f in value['formats']):
                    raise RuntimeError('incomplete HWP/HWPX load result')
                if any(value.get(name, {}).get('status') not in ('PASS', 'FAIL') for name in ('pending', 'concurrent', 'historical')):
                    raise RuntimeError('incomplete safety scenario result')
            result['run'] = value
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
