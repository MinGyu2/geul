#!/usr/bin/env python3
"""P3-B: GTK clipboard read limits in the actual app (bounded fixtures only).

Run inside scripts/tests/native-ibus-session.py. A separate X11 process owns CLIPBOARD;
the app reads it through the production `clipboard_read_text` IPC (GTK request_text).
Records the result and the app process's resident/peak memory per case, so the
transient GTK allocation for oversized payloads is characterised, not assumed away.
Fixtures stay at or below 12 MiB.
"""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/e2e'))
import tauri_smoke as smoke  # noqa: E402

MiB = 1024 * 1024


def memory(pid):
    fields = {}
    for line in Path(f'/proc/{pid}/status').read_text().splitlines():
        key, _, value = line.partition(':')
        if key in ('VmRSS', 'VmHWM'):
            fields[key] = int(value.split()[0])  # kB
    return fields


def main():
    p = argparse.ArgumentParser()
    for name in ('app', 'driver', 'out'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--port', type=int, default=4493)
    args = p.parse_args()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    smoke.APP = str(Path(args.app).resolve())
    smoke.DRIVER_LOG = out / 'driver.log'
    report = {'appSha256': hashlib.sha256(Path(args.app).read_bytes()).hexdigest(), 'cases': [], 'checks': []}

    def check(name, ok, detail=None):
        report['checks'].append({'name': name, 'pass': bool(ok), 'detail': detail})
        print(name, 'PASS' if ok else 'FAIL', flush=True)
        if not ok:
            raise smoke.Failure(f'{name}: {detail!r}')

    fixtures = {
        'korean-small': '한😀글\n끝\t'.encode() * 100,
        'scalar-boundary': ('가' * MiB).encode(),            # 1,048,576 scalars, 3 MiB
        'scalar-over': ('가' * (MiB + 1)).encode(),          # one scalar over
        'byte-boundary': ('😀' * MiB).encode(),              # exactly 4 MiB
        'byte-over': ('😀' * MiB + 'a').encode(),            # one byte over
        'oversized-12mib': b'a' * (12 * MiB),
    }
    expected = {'korean-small': 'ok', 'scalar-boundary': 'ok', 'scalar-over': 'TooLarge', 'byte-boundary': 'ok',
                'byte-over': 'TooLarge', 'oversized-12mib': 'TooLarge'}
    try:
        with tempfile.TemporaryDirectory(prefix='geul-clip-limits-') as data, \
                smoke.tauri_driver(args.driver, args.port, data) as start, contextlib.ExitStack() as life:
            d = start()
            life.callback(d.quit)
            smoke.wait_until(d, "return document.querySelector('footer.statusbar')!==null", timeout=40)
            pids = smoke.app_processes()
            check('single app process', len(pids) == 1, pids)
            pid = pids[0]

            def read():
                d.js("window.__lim=null;const t0=performance.now();window.__TAURI_INTERNALS__.invoke('clipboard_read_text').then(v=>window.__lim={ok:true,len:v.length,sha:null,ms:performance.now()-t0,v},e=>window.__lim={ok:false,error:String(e),ms:performance.now()-t0})")
                smoke.wait_until(d, 'return window.__lim!==null', timeout=30)
                return d.js("const r=window.__lim;return r.ok?{ok:true,scalars:[...r.v].length,bytes:new TextEncoder().encode(r.v).length,ms:r.ms}:r")

            def owner(arg, delay=None):
                argv = [sys.executable, str(Path(__file__).with_name('x11-clipboard-owner.py')), arg]
                if delay is not None:
                    argv.append(str(delay))
                proc = subprocess.Popen(argv, stdout=subprocess.PIPE, text=True)
                if not select.select([proc.stdout], [], [], 15)[0]:
                    raise smoke.Failure('owner did not start')
                json.loads(proc.stdout.readline())
                return proc

            def stop(proc):
                if proc.poll() is None:
                    proc.terminate()
                proc.wait(timeout=5)

            with tempfile.TemporaryDirectory(prefix='clip-fixtures-') as fx:
                for name, payload in fixtures.items():
                    path = Path(fx, name)
                    path.write_bytes(payload)
                    proc = owner('@' + str(path))
                    try:
                        before = memory(pid)
                        result = read()
                        after = memory(pid)
                    finally:
                        stop(proc)
                    case = {'case': name, 'payloadBytes': len(payload), 'result': result, 'memoryKbBefore': before,
                            'memoryKbAfter': after, 'peakGrowthKb': after['VmHWM'] - before['VmHWM']}
                    report['cases'].append(case)
                    print(json.dumps(case), flush=True)
                    if expected[name] == 'ok':
                        text = payload.decode()
                        check(name + ' complete text returned', result.get('ok') and result['bytes'] == len(payload)
                              and result['scalars'] == len(text), result)
                    else:
                        check(name + ' refused TooLarge without truncation', result == {**result, 'ok': False}
                              and 'TooLarge' in result.get('error', ''), result)

            # Slow owner: answers after 7 s; the bridge gives up at 5 s (Unavailable), UI stays responsive.
            proc = owner('SLOW', delay=7)
            try:
                started = time.monotonic()
                d.js("window.__lim=null;const t0=performance.now();window.__TAURI_INTERNALS__.invoke('clipboard_read_text').then(v=>window.__lim={ok:true,v,ms:performance.now()-t0},e=>window.__lim={ok:false,error:String(e),ms:performance.now()-t0})")
                time.sleep(1)
                responsive = d.js('return document.querySelector("footer.statusbar")!==null')
                smoke.wait_until(d, 'return window.__lim!==null', timeout=20)
                slow = d.js('return window.__lim')
                slow['wallSeconds'] = round(time.monotonic() - started, 2)
            finally:
                stop(proc)
            report['cases'].append({'case': 'slow-owner', 'result': slow, 'uiResponsive': responsive})
            check('slow owner times out as Unavailable near 5 s', not slow['ok'] and 'Unavailable' in slow['error']
                  and 4.5 <= slow['ms'] / 1000 <= 7, slow)
            check('UI thread not blocked during slow read', responsive)

            # Owner disappears after the request arrives.
            proc = owner('GONE', delay=30)
            try:
                d.js("window.__lim=null;window.__TAURI_INTERNALS__.invoke('clipboard_read_text').then(v=>window.__lim={ok:true,v},e=>window.__lim={ok:false,error:String(e)})")
                if not select.select([proc.stdout], [], [], 10)[0]:
                    raise smoke.Failure('request did not reach owner')
                check('request reached owner before it vanished', proc.stdout.readline().strip() == 'TEXT_REQUEST')
                proc.kill()
                proc.wait(timeout=5)
                smoke.wait_until(d, 'return window.__lim!==null', timeout=20)
                gone = d.js('return window.__lim')
            finally:
                stop(proc)
            report['cases'].append({'case': 'owner-vanished', 'result': gone})
            check('vanished owner yields failure or empty, never partial text', (not gone['ok']) or gone['v'] == '', gone)

            # No owner at all: empty text, not an error (Paste then does nothing).
            empty = read()
            report['cases'].append({'case': 'no-owner', 'result': empty})
            check('no clipboard owner reads as empty', empty.get('ok') and empty['bytes'] == 0, empty)
            report['finalMemoryKb'] = memory(pid)
        report['status'] = 'PASS'
        return 0
    except Exception as e:
        report['status'] = 'FAIL'
        report['error'] = str(e)
        return 1
    finally:
        (out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({k: report.get(k) for k in ('status', 'error')}, ensure_ascii=False))


if __name__ == '__main__':
    sys.exit(main())
