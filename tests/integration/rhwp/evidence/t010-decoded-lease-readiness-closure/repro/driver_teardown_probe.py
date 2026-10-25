#!/usr/bin/env python3
"""Controlled native teardown probe (owned processes only; diagnostic, not a gate).

Starts its own Vite (same config/flags as run-native.py), Xvfb, XDG_DATA_HOME and tauri-driver, opens a
WebDriver session with the test-enabled debug app, waits until the UI is ready, then applies one teardown order:
  delete-wait        DELETE the session, keep tauri-driver running, observe for --window seconds
  delete-terminate   DELETE the session, then immediately SIGTERM tauri-driver (the harness order)
  terminate-only     SIGTERM tauri-driver without DELETE (driver chain dies before ending the session)
Every process is selected by this run's random GEUL_NATIVE_OBSERVE token in its environment; nothing else is
read beyond /proc stat/environ, and only token-carrying processes are ever signalled (final cleanup, recorded).
Usage (repository root): python3 PROBE --driver TAURI_DRIVER --webkit-driver WKD --xvfb XVFB --order ORDER \
  [--repeat N] [--window 30] --output OUT.json
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[6]
P = 'tests/integration/rhwp/ownership-poc/'
APP = ROOT / 'src-tauri/target/debug/geul'
APP_SIDE = ('geul', 'WebKitNetworkPr', 'WebKitWebProces')
GATES = ROOT / 'tests/integration/rhwp/evidence/t010-decoded-lease-contract-finalization/engine-gates'


def owned(marker):
    rows = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if marker not in (entry / 'environ').read_bytes():
                continue
            head, tail = (entry / 'stat').read_text().rsplit(')', 1)
            fields = tail.split()
            rows[int(entry.name)] = {'comm': head.split('(', 1)[1], 'state': fields[0], 'ppid': int(fields[1])}
        except (OSError, ValueError, IndexError):
            continue
    return rows


def call(base, method, path, body=None, timeout=60):
    data = json.dumps(body or {}).encode() if method == 'POST' else None
    request = urllib.request.Request(base + path, data=data, method=method, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read() or b'{}').get('value')


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def run_once(a, order, marker, env, t0):
    events = []
    note = lambda event, **kw: events.append({'t': round(time.monotonic() - t0, 3), 'event': event, **kw})
    with tempfile.TemporaryDirectory(prefix='geul-teardown-probe-') as folder:
        work = Path(folder)
        local = dict(env, XDG_DATA_HOME=str(work / 'data'))
        for name in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR'):
            (work / name).mkdir()
            local[name] = str(work / name)
        port = free_port()
        driver = subprocess.Popen([a.driver, '--port', str(port)], env=local, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        base = f'http://127.0.0.1:{port}'
        deadline = time.monotonic() + 20
        while True:
            try:
                call(base, 'GET', '/status', timeout=1)
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise RuntimeError('tauri-driver did not start')
                time.sleep(0.1)
        session = call(base, 'POST', '/session', {'capabilities': {'alwaysMatch': {'tauri:options': {'application': str(APP)}}}})['sessionId']
        note('session-started')
        deadline = time.monotonic() + 60
        while not call(base, 'POST', f'/session/{session}/execute/sync',
                       {'script': "return !!document.querySelector('.document-bar__open')", 'args': []}):
            if time.monotonic() > deadline:
                raise RuntimeError('UI not ready')
            time.sleep(0.2)
        note('ui-ready', processes=sorted(r['comm'] for r in owned(marker).values()))
        before = {pid: r for pid, r in owned(marker).items() if r['comm'] in ('geul', 'WebKitWebDriver', 'tauri-driver', 'WebKitNetworkPr', 'WebKitWebProces')}
        if order in ('delete-wait', 'delete-terminate'):
            call(base, 'DELETE', f'/session/{session}')
            note('delete-replied', alive=sorted(r['comm'] for pid, r in owned(marker).items() if pid in before))
        if order in ('delete-terminate', 'terminate-only'):
            driver.terminate()
            note('tauri-driver-sigterm')
        # Observe the session's processes (not Vite/Xvfb, which belong to the probe) for the window.
        deadline = time.monotonic() + a.window
        last = None
        while time.monotonic() < deadline:
            now = {pid: r for pid, r in owned(marker).items() if pid in before}
            shape = sorted((r['comm'], r['state'], 'orphan' if r['ppid'] == 1 else 'parented') for r in now.values())
            if shape != last:
                note('observed', processes=shape)
                last = shape
            # Stop once the app side has ended (after 2 s, so the driver chain's state is also recorded).
            if not any(r['comm'] in APP_SIDE for r in now.values()) and time.monotonic() > deadline - a.window + 2:
                break
            time.sleep(0.05)
        # The app and its WebKit helpers must end with the session; the driver chain is judged separately.
        survivors = {pid: r for pid, r in owned(marker).items() if pid in before and r['comm'] in APP_SIDE}
        note('window-end', survivors=sorted((r['comm'], r['state'], r['ppid'] == 1) for r in survivors.values()))
        # Cleanup: the driver first (normal path), then any token-carrying session survivor.
        if driver.poll() is None:
            driver.terminate()
            try:
                driver.wait(timeout=10)
            except subprocess.TimeoutExpired:
                driver.kill()
        driver.wait(timeout=10)
        note('tauri-driver-exit', code=driver.returncode)
        leftover = {pid: r for pid, r in owned(marker).items() if pid in before}
        for pid in leftover:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        if leftover:
            note('cleanup-sigterm', targets=sorted(r['comm'] for r in leftover.values()))
            end = time.monotonic() + 10
            while time.monotonic() < end and any(pid in owned(marker) for pid in leftover):
                time.sleep(0.1)
        remaining = sorted(r['comm'] for pid, r in owned(marker).items() if pid in before)
        note('done', remaining=remaining)
    return {'order': order, 'events': events, 'survivedWindow': bool(survivors),
            'survivors': sorted((r['comm'], r['state'], r['ppid'] == 1) for r in survivors.values()),
            'remainingAfterCleanup': remaining}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--driver', required=True)
    p.add_argument('--webkit-driver', type=Path, required=True)
    p.add_argument('--xvfb', required=True)
    p.add_argument('--order', choices=('delete-wait', 'delete-terminate', 'terminate-only'), required=True)
    p.add_argument('--repeat', type=int, default=1)
    p.add_argument('--window', type=float, default=30)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    if a.output.exists():
        p.error('preserve previous output')
    token = secrets.token_hex(16)
    marker = f'GEUL_NATIVE_OBSERVE={token}'.encode() + b'\0'
    env = dict(os.environ, VITE_GEUL_TEST_HOOKS='1', GEUL_T010_OWNERSHIP_POC='1', GEUL_T010_SCHEDULER_POC='1',
               GEUL_T010_DAMAGE_POC='0', GEUL_T010_EVIDENCE=str(GATES), VITE_GEUL_TEST_RHWP_HISTORY='1',
               GEUL_T010_HISTORY_SAFETY_ONLY='1', GEUL_NATIVE_OBSERVE=token, GDK_BACKEND='x11',
               WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS='1', NO_AT_BRIDGE='1', GTK_A11Y='none')
    env['GEUL_T010_CANDIDATE'] = os.environ['GEUL_T010_CANDIDATE']
    env['PATH'] = str(a.webkit_driver.parent) + os.pathsep + env['PATH']
    t0 = time.monotonic()
    load = [os.getloadavg()]
    display = subprocess.Popen([a.xvfb, '-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
    vite = None
    runs = []
    try:
        env['DISPLAY'] = ':' + display.stdout.readline().strip()
        vite = subprocess.Popen(['node', 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--config', P + 'vite.config.mjs'],
                                cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 30
        while True:
            try:
                with urllib.request.urlopen('http://localhost:1420', timeout=1) as r:
                    if r.status == 200:
                        break
            except OSError:
                if time.monotonic() > deadline:
                    raise RuntimeError('Vite timeout')
                time.sleep(0.1)
        for _ in range(a.repeat):
            try:
                runs.append(run_once(a, a.order, marker, env, t0))
            except Exception as error:  # noqa: BLE001 - a failed probe run is recorded, never retried
                runs.append({'order': a.order, 'error': str(error)})
    finally:
        for process in (vite, display):
            if process:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
        load.append(os.getloadavg())
    report = {'schema': 1, 'kind': 'diagnostic probe (not D1, not a gate)', 'order': a.order, 'window': a.window,
              'loadAverage': {'start': load[0], 'end': load[-1]}, 'cpuCount': os.cpu_count(), 'runs': runs,
              'survivedWindow': sum(bool(r.get('survivedWindow')) for r in runs), 'errors': sum('error' in r for r in runs)}
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(report, indent=1, ensure_ascii=False).replace(str(ROOT), '<workspace>') + '\n')
    print(json.dumps({k: report[k] for k in ('order', 'survivedWindow', 'errors', 'loadAverage')}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
