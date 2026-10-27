#!/usr/bin/env python3
"""Chrome-shaped launcher for the same diagnostic page in real WebKitGTK/MiniBrowser.

No synthetic input is used. This is not the Tauri native D4 producer.
"""
import json
import hashlib
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request


def request(base, method, path, data=None):
    body = None if data is None else json.dumps(data).encode()
    with urllib.request.urlopen(urllib.request.Request(base+path, data=body, method=method,
            headers={'Content-Type': 'application/json'}), timeout=10) as response:
        result = json.load(response)
    value = result['value']
    if isinstance(value, dict) and 'error' in value: raise RuntimeError(str(value))
    return value


def main():
    driver = os.environ['GEUL_D4_WEBKIT_DRIVER']; xvfb = os.environ['GEUL_D4_XVFB']
    if '--version' in sys.argv:
        print('version API unavailable; WebKitWebDriver sha256='+hashlib.sha256(Path(driver).read_bytes()).hexdigest())
        return 0
    url = sys.argv[-1]
    if not url.startswith('http://127.0.0.1:'): raise ValueError('local diagnostic URL required')
    stop = threading.Event(); signal.signal(signal.SIGTERM, lambda *_: stop.set())
    with tempfile.TemporaryDirectory(prefix='geul-d4-webkit-') as tmp:
        with (Path(tmp)/'display').open('w+b') as display:
            x = subprocess.Popen([xvfb, '-displayfd', str(display.fileno()), '-screen', '0', '1280x1024x24', '-dpi', '96'],
                                 pass_fds=(display.fileno(),), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            web = None; session = None; cleanup = False
            try:
                deadline = time.monotonic()+10
                while True:
                    display.seek(0); number = display.read().decode().strip()
                    if number: break
                    if x.poll() is not None or time.monotonic()>deadline: raise RuntimeError('Xvfb did not start')
                    time.sleep(.1)
                with socket.socket() as port:
                    port.bind(('127.0.0.1', 0)); address = port.getsockname()[1]
                base = 'http://127.0.0.1:'+str(address)
                env = {**os.environ, 'DISPLAY': ':'+number, 'GDK_BACKEND': 'x11',
                    'WEBKIT_DISABLE_DMABUF_RENDERER': '1', 'WEBKIT_DISABLE_COMPOSITING_MODE': '1', 'LIBGL_ALWAYS_SOFTWARE': '1'}
                env.pop('WAYLAND_DISPLAY', None)
                web = subprocess.Popen(['dbus-run-session', '--', driver, '--port='+str(address)], env=env, start_new_session=True)
                deadline = time.monotonic()+15
                while True:
                    try: request(base, 'GET', '/status'); break
                    except OSError:
                        if web.poll() is not None or time.monotonic()>deadline: raise
                        time.sleep(.1)
                opened = request(base, 'POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'MiniBrowser'}}})
                print('BROWSER_CAPABILITIES '+json.dumps(opened['capabilities']), flush=True)
                session = opened['sessionId']
                request(base, 'POST', '/session/'+session+'/url', {'url': url})
                while not stop.wait(.2):
                    if web.poll() is not None: raise RuntimeError('WebKit driver exited early')
            finally:
                try:
                    if session: request(base, 'DELETE', '/session/'+session)
                    cleanup = True
                finally:
                    if web:
                        try: os.killpg(web.pid, signal.SIGTERM)
                        except ProcessLookupError: pass
                        try: web.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            os.killpg(web.pid, signal.SIGKILL); web.wait()
                    x.terminate()
                    try: x.wait(timeout=5)
                    except subprocess.TimeoutExpired: x.kill(); x.wait()
                if not cleanup: raise RuntimeError('WebKit session cleanup failed')
    return 0


if __name__ == '__main__': sys.exit(main())
