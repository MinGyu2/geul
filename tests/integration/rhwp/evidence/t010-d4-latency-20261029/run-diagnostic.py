#!/usr/bin/env python3
"""Own the dev server and an existing native diagnostic in one process lifetime.

This launcher does not change or replace the official D4 producer/MEASURE.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[5]
POC = ROOT / 'tests/integration/rhwp/ownership-poc'
sys.path.insert(0, str(POC))
from process_scope import Scope


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['candidate', 'gates', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--expected-wasm', required=True)
    parser.add_argument('--mode', choices=['input-delay', 'matrix', 'viewport', 'official'], required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    candidate, gates = args.candidate.resolve(), args.gates.resolve()
    if sha(candidate / 'rhwp_bg.wasm') != args.expected_wasm:
        raise ValueError('independent expected WASM mismatch')
    tool = {key: Path(os.environ['GEUL_' + key]) for key in ['TAURI_DRIVER', 'WEBKIT_DRIVER', 'XVFB', 'XDOTOOL']}
    files = {str(p.relative_to(ROOT)): p for base in [ROOT / 'src', POC] for p in base.rglob('*')
             if p.is_file() and p.suffix in ['.ts', '.tsx', '.css', '.py', '.mjs', '.json']}
    for name in ['tests/integration/rhwp/undo_native.py', 'tests/integration/rhwp/native_probe.py',
                 'tests/e2e/tauri_smoke.py', 'vite.config.ts', 'package-lock.json', 'src-tauri/target/debug/geul']:
        files[name] = ROOT / name
    files['launcher'] = Path(__file__).resolve()
    files.update(tool)
    for base, label in [(candidate, 'candidate'), (gates, 'gate')]:
        files.update({label + '/' + str(p.relative_to(base)): p for p in base.iterdir() if p.is_file()})
    snapshot = lambda: {key: sha(path) for key, path in files.items()}
    before = snapshot()
    record = {'status': 'FAIL', 'official': False, 'mode': args.mode, 'inputsBefore': before}
    env = dict(os.environ, GEUL_T010_OWNERSHIP_POC='1', GEUL_T010_SCHEDULER_POC='1',
               VITE_GEUL_TEST_HOOKS='1', GEUL_T010_DAMAGE_POC='0', GEUL_T010_CANDIDATE=str(candidate),
               GEUL_T010_EVIDENCE=str(gates), LIBGL_ALWAYS_SOFTWARE='1', WEBKIT_DISABLE_DMABUF_RENDERER='1', GDK_BACKEND='x11')
    for key in ['GEUL_T010_PAGE_IDENTITY_POC', 'GEUL_T010_HISTORY_PERF_ONLY', 'GEUL_T010_HISTORY_SAFETY_ONLY',
                'VITE_GEUL_TEST_RHWP_HISTORY', 'GEUL_T010_D4_TRACE']:
        env[key] = '0' if args.mode == 'matrix' else '1'
    if args.mode == 'official':
        env['GEUL_T010_D4_TRACE'] = '0'  # no additional observer in official measurements
    producers = {'viewport': Path(__file__).with_name('viewport-native.py'), 'input-delay': POC / 'd4-input-delay-native.py',
                 'official': POC / 'history-perf.py', 'matrix': POC / 'native.py'}
    producer_path = producers[args.mode]
    files['producer'] = producer_path
    before = snapshot()
    record['inputsBefore'] = before
    command = ['dbus-run-session', '--', sys.executable, str(producer_path),
               '--app', str(ROOT / 'src-tauri/target/debug/geul'), '--driver', str(tool['TAURI_DRIVER']),
               '--webkit-driver', str(tool['WEBKIT_DRIVER']), '--xvfb', str(tool['XVFB']),
               '--output', str(out / 'result.json'), '--driver-log', str(out / 'driver.log')]
    if args.mode in ['input-delay', 'viewport']:
        command += ['--xdotool', str(tool['XDOTOOL']), '--expected-wasm', args.expected_wasm]
    elif args.mode == 'official':
        command += ['--xdotool', str(tool['XDOTOOL'])]
    else:
        command += ['--scheduler', '--extended', '--matrix', '--evidence-dir', str(gates)]
    serve = ['node', 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--config',
             'tests/integration/rhwp/ownership-poc/vite.config.mjs', '--port', '1420', '--strictPort']
    record.update(command=command, serverCommand=serve)
    scope = Scope().enable()
    vite = producer = None
    try:
        with (out / 'vite.log').open('x') as log, (out / 'producer.log').open('x') as producer_log:
            vite = subprocess.Popen(serve, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
            record['serverPid'] = vite.pid
            deadline = time.monotonic() + 30
            while True:
                if vite.poll() is not None:
                    raise RuntimeError('owned Vite exited before readiness')
                try:
                    with urllib.request.urlopen('http://localhost:1420/__ownership_candidate__/ENGINE.json', timeout=1) as response:
                        actual = json.load(response)
                    if actual['artifacts']['rhwp_bg.wasm'] != args.expected_wasm:
                        raise ValueError('server candidate identity mismatch')
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError('server readiness failed; producer was not started')
                    time.sleep(.1)
            record['serverReady'] = True
            producer = subprocess.Popen(command, cwd=ROOT, env=env, stdout=producer_log, stderr=subprocess.STDOUT)
            started = time.monotonic()
            if args.mode == 'official':
                producer.wait(timeout=600)
            while producer.poll() is None:
                scope.observe()
                if time.monotonic() - started > 600:
                    raise RuntimeError('diagnostic producer timeout')
                time.sleep(1)
            record['producerExit'] = producer.returncode
            value = json.loads((out / 'result.json').read_text())
            record['producerStatus'] = value.get('status')
            expected = 'DIAGNOSTIC_COMPLETE' if args.mode == 'input-delay' else 'PASS'
            record['status'] = 'PASS' if producer.returncode == 0 and value.get('status') == expected else 'FAIL'
    except Exception as error:
        record['error'] = type(error).__name__ + ': ' + str(error)
    finally:
        for child in [producer, vite]:
            if child is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=10)
        record['processScope'] = scope.teardown(owned_pids=[child.pid for child in [producer, vite] if child is not None])
        record['inputsAfter'] = snapshot()
        record['sourceStableDuringRun'] = before == record['inputsAfter']
        if not record['sourceStableDuringRun'] or not record['processScope']['cleanupSucceeded']:
            record['status'] = 'FAIL'
        (out / 'execution.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({key: value for key, value in record.items() if key not in ['inputsBefore', 'inputsAfter', 'processScope']}))
    return 0 if record['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
