"""T010 준비 runtime 하드닝 재현을 실제 Chrome/WebKit에서 한 후보에 대해 실행한다.

기존 render-preparation/run.py와 그 계약은 바꾸지 않는다. 결과는 진단/회귀 증거이며
공식 D4 MEASURE나 native D1이 아니다. 기존 출력 파일은 덮어쓰지 않는다.
"""
from contextlib import ExitStack
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse, hashlib, json, os, shutil, subprocess, sys, tempfile, threading, time, urllib.error

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(HERE.parent / 'cache-concurrency'))
from run import engine, free_port, request, stop  # noqa: E402
sys.path.insert(0, str(HERE.parent / 'ownership-poc'))
from native_d1_result import loads_strict  # noqa: E402

from validation import validate_run, validate_identity  # noqa: E402

RUNTIME = HERE.parent / 'render-preparation/runtime.mjs'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--candidate', type=Path, required=True)
    p.add_argument('--browser', choices=('chrome', 'webkit'), required=True)
    p.add_argument('--chrome', default=shutil.which('google-chrome'))
    p.add_argument('--webkit-driver', default=shutil.which('WebKitWebDriver'))
    p.add_argument('--xvfb')
    p.add_argument('--timeout', type=float, default=300)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    if a.output.exists():
        p.error('기존 실행 증거 보존')
    inputs = lambda: {'hardening.mjs': sha(HERE / 'hardening.mjs'), 'run.py': sha(HERE / 'run.py'), 'runtime.mjs': sha(RUNTIME), 'validation.py': sha(HERE / 'validation.py'),
                      **{'candidate/' + n: sha(a.candidate / n) for n in ('rhwp.js', 'rhwp_bg.wasm', 'rhwp.d.ts', 'ENGINE.json')}}
    before = inputs()
    result = {'schema': 1, 'browser': a.browser, 'status': 'FAIL'}
    received, complete = [], threading.Event()
    with ExitStack() as stack:
        tmp = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='geul-preparation-hardening-')))
        web = tmp / 'web'
        web.mkdir()
        result['identity'] = engine(a.candidate.resolve(), web / 'candidate')
        shutil.copyfile(HERE / 'hardening.mjs', web / 'hardening.mjs')
        shutil.copyfile(RUNTIME, web / 'runtime.mjs')
        (web / 'index.html').write_text('<!doctype html><meta charset="utf-8"><script type="module" src="/hardening.mjs"></script>\n')

        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kw):
                super().__init__(*args, directory=str(web), **kw)

            def log_message(self, *args):
                pass

            def end_headers(self):
                self.send_header('Cache-Control', 'no-store')
                super().end_headers()

            def do_POST(self):
                size = int(self.headers.get('Content-Length', '0'))
                if self.path != '/result' or not 0 < size < 16 << 20:
                    self.send_error(400)
                    return
                try:
                    value = loads_strict(self.rfile.read(size).decode())
                except ValueError:
                    self.send_error(400)
                    return
                received.append(value)
                self.send_response(204)
                self.end_headers()
                complete.set()

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        stack.callback(server.server_close)
        stack.callback(server.shutdown)
        url = f'http://127.0.0.1:{server.server_port}/index.html'
        log = stack.enter_context((tmp / 'browser.log').open('w+b'))
        try:
            if a.browser == 'chrome':
                if not a.chrome:
                    raise RuntimeError('Chrome 없음')
                result['browserVersion'] = subprocess.check_output([a.chrome, '--version'], text=True).strip()
                browser = subprocess.Popen([a.chrome, '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
                                            '--no-first-run', '--user-data-dir=' + str(tmp / 'profile'), url], stdout=log, stderr=subprocess.STDOUT)
                stack.callback(stop, browser)
            else:
                env = {**os.environ, 'TMPDIR': str(tmp), 'LIBGL_ALWAYS_SOFTWARE': '1', 'WEBKIT_DISABLE_DMABUF_RENDERER': '1',
                       'XDG_DATA_HOME': str(tmp / 'data'), 'XDG_CACHE_HOME': str(tmp / 'cache'), 'XDG_CONFIG_HOME': str(tmp / 'config')}
                if a.xvfb:
                    display = stack.enter_context((tmp / 'display').open('w+b'))
                    xvfb = subprocess.Popen([a.xvfb, '-displayfd', str(display.fileno()), '-screen', '0', '1280x1024x24', '-dpi', '96'],
                                            pass_fds=(display.fileno(),), stdout=log, stderr=subprocess.STDOUT)
                    stack.callback(stop, xvfb)
                    deadline = time.monotonic() + 10
                    while True:
                        display.seek(0)
                        number = display.read().decode().strip()
                        if number:
                            break
                        if time.monotonic() > deadline:
                            raise RuntimeError('Xvfb 시작 실패')
                        time.sleep(.05)
                    env.update(DISPLAY=':' + number, GDK_BACKEND='x11')
                    env.pop('WAYLAND_DISPLAY', None)
                port = free_port()
                base = f'http://127.0.0.1:{port}'
                browser = subprocess.Popen([a.webkit_driver, f'--port={port}'], env=env, stdout=log, stderr=subprocess.STDOUT)
                stack.callback(stop, browser)
                deadline = time.monotonic() + 15
                while True:
                    try:
                        request(base, 'GET', '/status')
                        break
                    except (OSError, urllib.error.URLError):
                        if time.monotonic() > deadline:
                            raise RuntimeError('WebKit driver 시작 실패')
                        time.sleep(.1)
                session = request(base, 'POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'MiniBrowser'}}})
                stack.callback(request, base, 'DELETE', '/session/' + session['sessionId'])
                result['browserVersion'] = {k: v for k, v in session['capabilities'].items() if k != 'webkit:processID'}
                request(base, 'POST', '/session/' + session['sessionId'] + '/url', {'url': url})
            deadline = time.monotonic() + a.timeout
            while not complete.wait(.25):
                if browser.poll() is not None:
                    raise RuntimeError('브라우저 조기 종료')
                if time.monotonic() > deadline:
                    raise RuntimeError('브라우저 완료 결과 없음, 시간 초과')
            if len(received) != 1:
                raise RuntimeError('중복 완료 결과')
            run = result['run'] = received[0]
            validate_run(run)
            result['status'] = 'PASS'
        except Exception as error:
            result['error'] = str(error).replace(str(tmp), '<temporary>')[:1500]
        finally:
            log.seek(0)
            result['browserLogTail'] = log.read().decode(errors='replace')[-1500:].replace(str(tmp), '<temporary>')
            after = inputs()
            result.update(inputsBefore=before, inputsAfter=after, executedDependenciesStable=before == after)
            try:
                validate_identity(result['identity'], before, after)
            except (ValueError, TypeError, AttributeError) as error:
                result['status'] = 'FAIL'
                result['identityError'] = str(error)
            text = json.dumps(result, ensure_ascii=False, indent=1).replace(str(ROOT), '<workspace>').replace(str(Path.home()), '<home>')
            a.output.parent.mkdir(parents=True, exist_ok=True)
            a.output.write_text(text + '\n')
    print(a.browser, result['status'], result.get('failedChecks'), result.get('error'), flush=True)
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
