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
                        value['ownershipFailures'] = surfaces_accounted(value) if phase.startswith(('closed', 'idle', 'trim', 'baseline')) else None
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


def classify(result, expected_wasm):
    """Measurement complete + every settled point accounted; trim must release every cache-owned surface."""
    points = {p['phase']: p for p in result.get('points', [])}
    expected = ['baseline', *[f'{k}-A{i}' for i in range(CYCLES) for k in ('opened', 'closed')], 'idle10s-without-trim',
                'trim+0s', 'trim+2s', 'trim+10s', 'opened-C0', 'closed-C0']
    failures = []
    if result.get('error'): failures.append('run error: ' + str(result['error'])[:200])
    if [p.get('phase') for p in result.get('points', [])] != expected: failures.append('phases incomplete or reordered')
    for key in ('engineIdentity', 'engineIdentityAtEnd'):
        if (result.get(key) or {}).get('wasmSha256') != expected_wasm: failures.append(key + ' != expected WASM')
    if any(p.get('ownershipFailures') for p in points.values()): failures.append('settled point with unaccounted surface/cleanup')
    identities = {tuple((r.get('pid'), r.get('startTime')) for r in p.get('processes', [])) for p in points.values()}
    if len(identities) != 1 or any(None in pair for ident in identities for pair in ident): failures.append('WebProcess identity changed or unverified')
    if any(result.get('cleanup', {}).get(step) is not True for step in lifecycle_evidence.CLEANUP_STEPS): failures.append('run cleanup incomplete')
    def surf(phase): return points.get(phase, {}).get('engineSurfaces') or {}
    def decoded(phase): return points.get(phase, {}).get('renderer', {}).get('cache', {}).get('decoded', {})
    trimmed = [phase for phase in ('trim+0s', 'trim+2s', 'trim+10s') if surf(phase).get('detachedCanvases') != 0 or decoded(phase).get('entries') != 0]
    if trimmed: failures.append('explicit trim left cache entries or detached Canvases: ' + ', '.join(trimmed))
    return {'status': 'FAIL' if failures else 'PASS', 'failures': failures,
            'summary': {phase: {'detachedCanvases': surf(phase).get('detachedCanvases'), 'externrefSlots': surf(phase).get('externrefSlots'),
                                'decodedEntries': decoded(phase).get('entries'), 'decodedMiB': round(decoded(phase).get('bytes', 0) / 2**20, 2),
                                'rssMiB': round(points[phase]['aggregateRssBytes'] / 2**20, 1), 'wasmMiB': round(points[phase]['wasmBytes'] / 2**20, 2)}
                        for phase in expected if phase in points}}


if __name__ == '__main__':
    raise SystemExit(main())
