#!/usr/bin/env python3
"""Controlled detached-Canvas/decoded-cache ownership experiment (diagnostic; separate from the lifecycle run).

Phase A repeats open/close without any trim and idles, so delayed GC alone would show up as fewer
detached Canvases. Phase B calls the existing explicit trim (cancel sessions, trimRendererCaches(0)).
Phase C reopens once to show the cache refills within its declared budget. No forced GC.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(HERE))
import native  # noqa: F401  (sets import paths)
import native_probe
import undo_native as history
import lifecycle_evidence
from native import smoke, poc

spec = importlib.util.spec_from_file_location('lifecycle_driver', HERE / 'lifecycle-continuous-native.py')
driver_module = importlib.util.module_from_spec(spec); spec.loader.exec_module(driver_module)
CYCLES = 5


def surfaces_accounted(point):
    failures = []
    lifecycle_evidence.check_point(point, 'point', True, failures)
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'webkit-driver', 'xvfb', 'xdotool', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--expected-wasm', required=True)
    args = parser.parse_args()
    if args.output.exists(): parser.error('preserve previous diagnostic output before repeating')
    result = {'status': 'RUNNING', 'points': [], 'startedAt': time.time(), 'cleanup': dict.fromkeys(lifecycle_evidence.CLEANUP_STEPS, False),
              'scope': 'chemical HWP open/close x5 without trim, idle 10s, explicit trim, idle 10s, reopen/close; diagnostic only'}
    display = subprocess.Popen([str(args.xvfb), '-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        os.environ.update(DISPLAY=':' + display.stdout.readline().strip(), GDK_BACKEND='x11', WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS='1', NO_AT_BRIDGE='1', GTK_A11Y='none', LIBGL_ALWAYS_SOFTWARE='1', WEBKIT_DISABLE_DMABUF_RENDERER='1')
        os.environ['PATH'] = str(args.webkit_driver.parent) + os.pathsep + os.environ['PATH']
        with tempfile.TemporaryDirectory(prefix='geul-cache-trim-') as folder:
            work = Path(folder)
            for name in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR'):
                target = work / name; target.mkdir(); os.environ[name] = str(target)
            fixtures = work / 'fixtures'
            subprocess.run(['node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), str(fixtures)], check=True, capture_output=True)
            document = history.S / 'rnote/연구노트(화학).hwp'
            copy = work / document.name; copy.write_bytes(document.read_bytes())
            smoke.APP = str(args.app.resolve())
            with smoke.tauri_driver(str(args.driver.resolve()), 4489, str(work / 'data')) as start:
                d = start()
                try:
                    smoke.wait_until(d, "return !!document.querySelector('.document-bar__open')", timeout=30)
                    poc.open_document(d, fixtures / 'basic-ko.hwpx')
                    native_probe.install(d, native_probe.INSTALL.replace("import('/rhwp/rhwp.js')", 'Promise.resolve(window.__geulOwnership.probeEngine())').replace('/rhwp/rhwp_bg.wasm', '/__ownership_candidate__/rhwp_bg.wasm'))
                    history.close_discard(d, 'basic-ko.hwpx')
                    result['engineIdentity'] = d.js('return window.__geulOwnership.identity')
                    poc.set_zoom(d, 50)
                    def sample(phase):
                        value = history.memory_sample(d)
                        value['processes'] = driver_module.with_generation(value['processes'])
                        value.update(phase=phase, renderer=d.js('return window.__geulOwnership.stats()'), at=round(time.time() - result['startedAt'], 2))
                        # Recorded for reading only; classify() recomputes ownership from the raw counters.
                        value['ownershipFailures'] = surfaces_accounted(value) if not phase.startswith('opened') else None
                        result['points'].append(value)
                        return value
                    def cycle(phase):
                        poc.open_document(d, copy, expected='ready')
                        smoke.wait_until(d, "return document.querySelector('.rhwp-page__canvas')?.width>0", timeout=30)
                        time.sleep(1); sample('opened-' + phase)
                        history.close_discard(d, copy.name); time.sleep(2); sample('closed-' + phase)
                    sample('baseline')
                    for index in range(CYCLES): cycle(f'A{index}')
                    time.sleep(10); sample('idle10s-without-trim')
                    d.js('window.__geulOwnership.trim()')
                    sample('trim+0s'); time.sleep(2); sample('trim+2s'); time.sleep(8); sample('trim+10s')
                    cycle('C0')
                    result['engineIdentityAtEnd'] = d.js('return window.__geulOwnership.identity')
                finally:
                    smoke.end_session(d); result['cleanup']['sessionEnded'] = True
            result['cleanup']['driverStopped'] = True
    except Exception as error:
        result['error'] = str(error)
    finally:
        try:
            display.terminate(); display.wait(timeout=10); result['cleanup']['displayTerminated'] = True
        except Exception as error:
            result.setdefault('error', 'display cleanup: ' + str(error))
        result.update(classify(result, args.expected_wasm), elapsedSeconds=round(time.time() - result['startedAt'], 2))
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2).replace(str(ROOT), '<workspace>').replace(str(Path.home()), '<home>') + '\n')
    return 0 if result['status'] == 'PASS' else 1


PHASES = ['baseline', *[f'{k}-A{i}' for i in range(CYCLES) for k in ('opened', 'closed')], 'idle10s-without-trim',
          'trim+0s', 'trim+2s', 'trim+10s', 'opened-C0', 'closed-C0']
TRIMMED = ('trim+0s', 'trim+2s', 'trim+10s')


def classify(result, expected_wasm):
    """Fail closed: every phase present once in order, ownership recomputed from the raw counters (a stored
    ownershipFailures field is never trusted), one stable (pid, startTime) WebProcess, and a populated cache that
    idle keeps, explicit trim empties and a reopen repopulates."""
    try:
        return classify_checked(result, expected_wasm)
    except (AttributeError, KeyError, TypeError, ValueError) as error:
        return {'status': 'FAIL', 'failures': [f'malformed result: {type(error).__name__}: {error}'[:300]], 'summary': {}}


def classify_checked(result, expected_wasm):
    if not isinstance(result, dict): return {'status': 'FAIL', 'failures': ['result is not an object'], 'summary': {}}
    failures = []
    raw = result.get('points')
    points = raw if isinstance(raw, list) and all(isinstance(p, dict) for p in raw) else []
    if [p.get('phase') for p in points] != PHASES or len(points) != len(raw if isinstance(raw, list) else []):
        failures.append('phases missing, malformed, duplicated, reordered or unexpected')
    if result.get('error'): failures.append('run error: ' + str(result['error'])[:200])
    for key in ('engineIdentity', 'engineIdentityAtEnd'):
        if not isinstance(result.get(key), dict) or result[key].get('wasmSha256') != expected_wasm: failures.append(key + ' != expected WASM')
    cleanup = result.get('cleanup') if isinstance(result.get('cleanup'), dict) else {}
    if any(cleanup.get(step) is not True for step in lifecycle_evidence.CLEANUP_STEPS): failures.append('run cleanup incomplete')
    identities = set()
    for point in points:
        phase = str(point.get('phase'))
        # Opened states legitimately hold documents/jobs: structure, identity, RSS and bounds only.
        lifecycle_evidence.check_point(point, phase, not phase.startswith('opened'), failures)
        identities.add(lifecycle_evidence.process_identity(point.get('processes'), phase, []))
    if not points or len(identities) != 1 or None in identities: failures.append(f'WebProcess identity not stable/verified: {sorted(map(str, identities))[:4]}')
    by_phase = {p.get('phase'): p for p in points}
    def decoded(phase): return by_phase[phase]['renderer']['cache']['decoded']
    def images(phase): return by_phase[phase]['renderer']['cache']['images']
    def detached(phase): return by_phase[phase]['engineSurfaces']['detachedCanvases']
    if not failures:
        last = f'closed-A{CYCLES - 1}'
        if not (decoded(last)['entries'] > 0 and decoded(last)['bytes'] > 0 and detached(last) > 0):
            failures.append('cache was not populated before trim; an empty cache cannot prove release')
        if (decoded('idle10s-without-trim')['entries'], detached('idle10s-without-trim')) != (decoded(last)['entries'], detached(last)):
            failures.append('idle without trim did not retain the cache-owned surfaces')
        kept = [phase for phase in TRIMMED if decoded(phase)['entries'] or decoded(phase)['bytes'] or detached(phase)
                or images(phase)['entries'] or images(phase)['bytes'] or by_phase[phase]['engineSurfaces']['imageCount']]
        if kept: failures.append('explicit trim left decoded/image cache entries or engine surfaces: ' + ', '.join(kept))
        if not (decoded('closed-C0')['entries'] > 0 and detached('closed-C0') > 0):
            failures.append('reopen did not repopulate the decoded cache')
    def summary(point):
        try:
            return {'detachedCanvases': point['engineSurfaces']['detachedCanvases'], 'externrefSlots': point['engineSurfaces']['externrefSlots'],
                    'decodedEntries': point['renderer']['cache']['decoded']['entries'], 'decodedMiB': round(point['renderer']['cache']['decoded']['bytes'] / 2**20, 2),
                    'imageEntries': point['renderer']['cache']['images']['entries'],
                    'rssMiB': round(point['aggregateRssBytes'] / 2**20, 1), 'wasmMiB': round(point['wasmBytes'] / 2**20, 2)}
        except (KeyError, TypeError):
            return None
    summaries = {p.get('phase'): summary(p) for p in points}
    missing = [str(phase) for phase, value in summaries.items() if value is None]
    if missing: failures.append('summary evidence not computable for: ' + ', '.join(missing))
    return {'status': 'FAIL' if failures else 'PASS', 'failures': failures,
            'imageCachePopulatedBeforeTrim': bool(not failures and images(f'closed-A{CYCLES - 1}')['entries']),
            'summary': summaries}

if __name__ == '__main__':
    raise SystemExit(main())
