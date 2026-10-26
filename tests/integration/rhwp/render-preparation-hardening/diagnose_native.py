"""native D1 연결 끊김 진단 실행(승인 증거 아님).

기존 producer(performance-visual-native.py)와 공식/후보 wrapper를 수정하지 않는다. 관찰 전략만 바꾼다:
tests/e2e/tauri_smoke.DRIVER_LOG를 설정해 tauri-driver·WebKitWebDriver·앱의 stdout/stderr를 보존하고,
WebDriver 끊김 예외의 진단(diagnostic())을 결과와 함께 남긴다. 결과는 strict D1 verdict로 재분류하지 않는다.
"""
from pathlib import Path
import argparse, json, os, runpy, subprocess, sys, time, urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
POC = ROOT / 'tests/integration/rhwp/ownership-poc'
PRODUCER = POC / 'performance-visual-native.py'


def shim(argv):
    """dbus 세션 안에서 실행된다. producer 모듈 상태만 설정하고 producer main을 그대로 호출한다."""
    log = Path(argv[0])
    sys.path.insert(0, str(POC))
    import native  # noqa: F401  (producer와 같은 smoke 모듈 객체)
    from native import smoke
    smoke.DRIVER_LOG = log
    lost = []
    original = smoke.DriverLost.__init__

    def record(self, *args, **kw):
        original(self, *args, **kw)
        lost.append(self.diagnostic())
    smoke.DriverLost.__init__ = record
    sys.argv = [str(PRODUCER), *argv[1:]]
    try:
        runpy.run_path(str(PRODUCER), run_name='__main__')
    except SystemExit as exit:
        code = exit.code
    else:
        code = 0
    finally:
        log.with_suffix('.lost.json').write_text(json.dumps(lost, ensure_ascii=False, indent=1, default=str) + '\n')
    raise SystemExit(code)


def strict_json(path):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError('duplicate JSON key: ' + key)
            value[key] = item
        return value
    def invalid(value):
        raise ValueError('non-finite JSON: ' + value)
    return json.loads(path.read_text(), object_pairs_hook=pairs, parse_constant=invalid)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--candidate', type=Path, required=True)
    p.add_argument('--gates', type=Path, required=True, help='후보의 engine-gates 디렉터리(기존 증거, 읽기 전용)')
    p.add_argument('--label', required=True)
    p.add_argument('--output-dir', type=Path, required=True)
    p.add_argument('--sample', help='진단 전용 단일 fixture')
    a = p.parse_args(argv)
    if not a.label or Path(a.label).name != a.label or a.label in ('.', '..'):
        p.error('label must be a single directory name')
    out = a.output_dir.resolve() / a.label
    if out.exists():
        p.error('기존 진단 결과 보존')
    out.mkdir(parents=True)
    record = {'schema': 1, 'record': 'native disconnect diagnostic (not acceptance evidence)', 'label': a.label,
              'loadStart': os.getloadavg()}
    started = time.monotonic()
    record['status'] = 'FAIL'
    try:
        tools = {k: os.environ[k] for k in ('GEUL_TAURI_DRIVER', 'GEUL_WEBKIT_DRIVER', 'GEUL_XVFB', 'GEUL_XDOTOOL')}
        env = dict(os.environ)
        env.update(VITE_GEUL_TEST_HOOKS='1', GEUL_T010_OWNERSHIP_POC='1', GEUL_T010_SCHEDULER_POC='1', GEUL_T010_DAMAGE_POC='0',
                   GEUL_T010_CANDIDATE=str(a.candidate.resolve()), GEUL_T010_EVIDENCE=str(a.gates.resolve()),
                   VITE_GEUL_TEST_RHWP_HISTORY='1', GEUL_T010_HISTORY_SAFETY_ONLY='1')
        serve = ['node', 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--config',
                 'tests/integration/rhwp/render-preparation/native-vite.config.mjs']
        cmd = ['dbus-run-session', '--', sys.executable, str(Path(__file__).resolve()), '--shim', str(out / 'driver.log'),
               '--app', str(ROOT / 'src-tauri/target/debug/geul'), '--driver', tools['GEUL_TAURI_DRIVER'],
               '--webkit-driver', tools['GEUL_WEBKIT_DRIVER'], '--xvfb', tools['GEUL_XVFB'], '--xdotool', tools['GEUL_XDOTOOL'],
               '--output', str(out / 'result.json'), *(['--sample', a.sample] if a.sample else [])]
        with open(out / 'vite.log', 'w') as vite_log:
            vite = subprocess.Popen(serve, cwd=ROOT, env=env, stdout=vite_log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 30
                while True:
                    if vite.poll() is not None:
                        raise RuntimeError('Vite exited')
                    try:
                        with urllib.request.urlopen('http://localhost:1420', timeout=1) as r:
                            if r.status == 200:
                                break
                    except OSError:
                        if time.monotonic() > deadline:
                            raise RuntimeError('Vite timeout')
                        time.sleep(.1)
                with open(out / 'producer.log', 'w') as producer_log:
                    record['harnessExit'] = subprocess.run(cmd, cwd=ROOT, env=env, stdout=producer_log, stderr=subprocess.STDOUT).returncode
            finally:
                vite.terminate()
                try:
                    vite.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    vite.kill()
                    vite.wait(timeout=10)
        result = strict_json(out / 'result.json')
        if not isinstance(result, dict):
            raise ValueError('result must be an object')
        record.update(producerStatus=result.get('status'), assertions=len(result.get('tests', [])),
                      references=len(result.get('visualReferences', [])), cleanup=result.get('cleanup'))
        if record.get('harnessExit') != 0:
            raise ValueError('producer exited unsuccessfully')
        if result.get('status') != 'PASS' or result.get('error'):
            raise ValueError('producer did not report PASS')
        for field in ('tests', 'visualReferences'):
            if not isinstance(result.get(field), list) or not result[field]:
                raise ValueError('missing required ' + field)
        if any(not isinstance(row, dict) or row.get('status') != 'PASS' for row in result['tests']):
            raise ValueError('failed diagnostic assertion')
        if not isinstance(result.get('cleanup'), dict) or any(
                result['cleanup'].get(step) is not True
                for step in ('sessionEnded', 'driverStopped', 'displayTerminated')):
            raise ValueError('diagnostic cleanup incomplete')
        for name in ('driver.log', 'producer.log', 'vite.log'):
            if not (out / name).is_file():
                raise ValueError('missing required output: ' + name)
        if strict_json(out / 'driver.lost.json') != []:
            raise ValueError('driver loss recorded')
        record['status'] = 'PASS'
    except Exception as error:
        record['error'] = f'{type(error).__name__}: {error}'
    finally:
        record.update(elapsedSeconds=round(time.monotonic() - started, 2), loadEnd=os.getloadavg())
    (out / 'summary.json').write_text(json.dumps(record, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps(record, ensure_ascii=False))
    return 0 if record['status'] == 'PASS' else 1


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--shim':
        shim(sys.argv[2:])
    raise SystemExit(main())
