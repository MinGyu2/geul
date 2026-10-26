"""Run unchanged official D4 producer against an independently identified experimental engine.

No D1 trust-anchor substitution: this is D4 only. Every attempt has separate output;
preparation off/on is explicit and never enables a product build.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import secrets
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[5]
HERE = Path(__file__).resolve().parent
P = 'tests/integration/rhwp/ownership-poc/'
sys.path.insert(0, str(ROOT / P))
import native_d1_result as identity


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def failure(errors, stage, error):
    errors.append({'stage': stage, 'type': type(error).__name__, 'message': str(error)})


def producer_result(output, errors):
    """Decode without altering partial producer evidence. Fail closed on shape."""
    try:
        data = output.read_bytes()
    except FileNotFoundError as error:
        failure(errors, 'producer-missing', error)
        return None
    except OSError as error:
        failure(errors, 'producer-read', error)
        return None
    try:
        producer = identity.loads_strict(data.decode('utf-8'))
    except (ValueError, UnicodeError) as error:
        failure(errors, 'producer-json', error)
        return None
    if (not isinstance(producer, dict)
        or type(producer.get('measurementComplete')) is not bool
        or producer.get('status') not in ('PASS', 'FAIL')
        or not isinstance(producer.get('measurements'), dict)
        or not isinstance(producer.get('measurements', {}).get('perf'), list)
        or not isinstance(producer.get('gates'), list)):
        failure(errors, 'producer-structure', ValueError('invalid producer result structure'))
        return None
    rows, gates = producer['measurements']['perf'], producer['gates']
    complete = len(rows) == 4 and len(gates) == 8 and all(
        isinstance(row, dict) and all(
            isinstance(row.get(key), dict) and row[key].get('n') == count and row[key].get('timeouts') == 0
            for key, count in [('groupStart', 30), ('extend', 30), ('undo', 25), ('redo', 20), ('afterUndo', 5)])
        for row in rows)
    if (producer['measurementComplete'] != complete or
        (producer['status'] == 'PASS' and (not complete or any(not isinstance(g, dict) or g.get('result') != 'PASS' for g in gates)))):
        failure(errors, 'producer-structure', ValueError('inconsistent measurement completion or verdict'))
        return None
    return producer


def cleanup_process(label, process, forced, errors):
    if process is None:
        return
    try:
        if process.poll() is not None:
            return
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            forced.append(label)
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)
    except Exception as error:
        failure(errors, 'cleanup-' + label, error)


def final_evidence(output, before, digests, errors):
    producer = None
    try:
        producer = producer_result(output, errors)
    except Exception as error:
        failure(errors, 'producer-postprocess', error)
    after = None
    try:
        after = digests()
    except Exception as error:
        failure(errors, 'dependency-digest', error)
    return producer, after


def write_record(record, result):
    serialized = json.dumps(result, ensure_ascii=False, indent=2).replace(str(ROOT), '<workspace>').replace(str(Path.home()), '<home>') + '\n'
    # Exclusive creation preserves every earlier attempt. If storage itself fails,
    # emit the complete record to stderr; never report successful persistence.
    try:
        with record.open('x') as stream:
            stream.write(serialized)
    except Exception:
        print(serialized, file=sys.stderr, flush=True)
        raise


def observe_marker(marker, seen, errors, proc=Path('/proc')):
    try:
        for p in proc.iterdir():
            if not p.name.isdigit():
                continue
            try:
                if marker not in (p/'environ').read_bytes():
                    continue
                data = (p/'stat').read_text().rsplit(')', 1)[1].split()
                seen[int(p.name)] = {'start': data[19], 'role': (p/'comm').read_text().strip()}
            except (OSError, ValueError, IndexError):
                continue
    except Exception as error:
        failure(errors, 'observer', error)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--preparation', choices=('off', 'on'), required=True)
    parser.add_argument('--attempt', type=int, required=True)
    args = parser.parse_args()
    stem = f'native-d4-{args.preparation}-attempt{args.attempt}'
    output = HERE / f'{stem}.json'
    record = HERE / f'{stem}-execution.json'
    if output.exists() or record.exists():
        parser.error('preserve previous attempts')
    candidate = args.candidate.resolve()
    expected = json.loads(subprocess.check_output(['git', 'show',
        '47eb616:tests/integration/rhwp/evidence/t010-render-preparation-runtime/candidate-identity.json'], cwd=ROOT))['artifacts']
    if any(sha(candidate / name) != digest for name, digest in expected.items()):
        parser.error('experimental candidate differs from committed independent identity')
    if not identity.pinned_samples_valid(ROOT):
        parser.error('pinned fixture identity mismatch')
    with tempfile.TemporaryDirectory(prefix='geul-d4-independent-fixtures-') as tmp:
        subprocess.run(['node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), tmp], check=True, capture_output=True)
        if any(sha(Path(tmp) / name) != identity.FIXTURE_SHA256[name] for name in identity.SAMPLES[:2]):
            parser.error('independent generated fixture mismatch')
    app = ROOT / 'src-tauri/target/debug/geul'
    driver = ROOT / 'src-tauri/target/release/tauri-driver'
    webkit = Path('/nix/store/p7h9r90h1vmk4wq1964nhd8vfp0kf27b-webkitgtk-2.54.1+abi=4.1/bin/WebKitWebDriver')
    xvfb = Path('/nix/store/7yz3bnmll7fy11n0xci85mbhnf6p5669-xvfb-21.1.23/bin/Xvfb')
    xdotool = Path('/nix/store/kyp2r08w6hs0l1zj3cya6d2ciba9v47h-xdotool-3.20211022.1/bin/xdotool')
    for path in [app, driver, webkit, xvfb, xdotool]:
        if not path.is_file():
            parser.error('missing native prerequisite: ' + path.name)
    config = P + 'vite.config.mjs' if args.preparation == 'off' else 'tests/integration/rhwp/render-preparation/native-vite.config.mjs'
    dependencies = [ROOT / (P + name) for name in ['history-perf.py', 'session.mjs', 'vite.config.mjs', 'native.py']]
    dependencies += [Path(__file__), ROOT / config, ROOT / 'tests/integration/rhwp/undo_native.py', ROOT / 'tests/integration/rhwp/native_probe.py', ROOT / 'tests/e2e/tauri_smoke.py', app, driver]
    def digests():
        return {str(p.relative_to(ROOT)): sha(p) for p in dependencies} | {'tree:src': identity.tree_digest(ROOT, 'src'), 'tree:src-tauri/src': identity.tree_digest(ROOT, 'src-tauri/src')} | {f'candidate/{n}': sha(candidate/n) for n in expected}
    before = digests()
    source_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    token = secrets.token_hex(16)
    marker = ('GEUL_NATIVE_OBSERVE=' + token).encode() + b'\0'
    env = {**os.environ, 'VITE_GEUL_TEST_HOOKS': '1', 'VITE_GEUL_TEST_RHWP_HISTORY': '1',
           'GEUL_T010_HISTORY_PERF_ONLY': '1', 'GEUL_T010_OWNERSHIP_POC': '1', 'GEUL_T010_SCHEDULER_POC': '1',
           'GEUL_T010_DAMAGE_POC': '0', 'GEUL_T010_CANDIDATE': str(candidate),
           'GEUL_T010_EVIDENCE': str(ROOT / 'tests/integration/rhwp/evidence/t010-render-preparation-runtime/engine-gates'),
           'GEUL_NATIVE_OBSERVE': token}
    seen = {}
    stop = threading.Event()
    errors = []
    def sample():
        observe_marker(marker, seen, errors)
    def observe():
        while not stop.wait(.1):
            sample()
    thread = threading.Thread(target=observe, daemon=True)
    thread.start()
    native = vite = None
    code = None
    launch_failure = None
    started = time.monotonic()
    try:
        with open('/tmp/geul-'+stem+'-vite.log', 'w') as log:
            vite = subprocess.Popen(['node', 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--strictPort', '--config', config], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic()+30
            while True:
                if vite.poll() is not None:
                    raise RuntimeError('Vite preflight exited')
                try:
                    with urllib.request.urlopen('http://localhost:1420', timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    if time.monotonic()>deadline:
                        raise RuntimeError('Vite startup timeout')
                    time.sleep(.1)
            command = ['dbus-run-session', '--', 'python3', P+'history-perf.py', '--app', str(app), '--driver', str(driver), '--webkit-driver', str(webkit), '--xvfb', str(xvfb), '--xdotool', str(xdotool), '--output', str(output)]
            with open('/tmp/geul-'+stem+'-producer.log', 'w') as log2:
                native = subprocess.Popen(command, cwd=ROOT, env=env, stdout=log2, stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    code = native.wait(timeout=600)
                except Exception as error:
                    failure(errors, 'process-wait', error)
                    raise
    except Exception as error:
        launch_failure = type(error).__name__ + ': ' + str(error)
    finally:
        forced = []
        for label, process in [('native', native), ('vite', vite)]:
            cleanup_process(label, process, forced, errors)
        time.sleep(1)
        sample()
        stop.set()
        try:
            thread.join(timeout=5)
            if thread.is_alive():
                failure(errors, 'observer-join', RuntimeError('observer did not stop'))
        except Exception as error:
            failure(errors, 'observer-join', error)
        observed = dict(seen)
        survivors = []
        for pid, info in observed.items():
            try:
                data = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
                if data[19] == info['start']:
                    survivors.append({'pid': pid, 'role': info['role'], 'state': data[0]})
            except FileNotFoundError:
                pass
            except (OSError, ValueError, IndexError) as error:
                failure(errors, 'observer-survivor-check', error)
        producer, after = final_evidence(output, before, digests, errors)
        result = {'scope': 'current-source native D4, unchanged producer boundary; experimental engine, NOT D1 approval',
                  'preparation': args.preparation, 'attempt': args.attempt, 'parentExit': code, 'error': launch_failure,
                  'elapsedSeconds': time.monotonic()-started, 'inputsBefore': before, 'inputsAfter': after,
                  'inputsStable': before == after, 'sourceCommit': source_commit,
                  'candidateIdentity': expected, 'fixtureSha256': identity.FIXTURE_SHA256,
                  'processCleanup': {'observed': len(observed), 'roles': sorted({i['role'] for i in observed.values()}), 'survivors': survivors, 'forcedKill': forced, 'observerErrors': [e for e in errors if e['stage'].startswith('observer')], 'postLaunchErrors': errors},
                  'measurementComplete': producer.get('measurementComplete') if producer else False,
                  'producerStatus': producer.get('status') if producer else None,
                  'verdict': 'PASS' if code == 0 and producer and producer.get('status') == 'PASS' and producer.get('measurementComplete') is True and before == after and not (survivors or forced or errors or launch_failure) else 'FAIL'}
        write_record(record, result)
        print(json.dumps({k:result[k] for k in ['preparation','parentExit','measurementComplete','producerStatus','verdict','error']}), flush=True)
    return 0 if result['verdict'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
