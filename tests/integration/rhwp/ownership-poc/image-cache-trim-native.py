#!/usr/bin/env python3
"""Controlled browser-image cache ownership experiment (diagnostic; separate from lifecycle and D4).

The generated ownership-hwp.hwp holds two SVG pictures, which the engine cannot decode itself, so they go through
the browser-image cache (HtmlImageElement leases). Open until the images are resident and the displayed frame is
exact, close, idle without trim, trim explicitly, then reopen and require exact repopulated frames. No forced GC.
Late image callbacks after trim/replacement are covered by history-pending-native.py.
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
PHASES = ['baseline', 'opened', 'closed', 'idle10s-without-trim', 'trim+0s', 'trim+2s', 'trim+10s', 'reopened', 'reclosed', 'final-trim']
TRIMMED = ('trim+0s', 'trim+2s', 'trim+10s', 'final-trim')
IMAGES = 2
IMAGE_PIXELS = 1200 ** 2 + 1210 ** 2  # generate.mjs: SVG pictures n = 1200 + i * 10, i = 0, 1 (natural size)
FRAMES = ('opened', 'reopened')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'webkit-driver', 'xvfb', 'xdotool', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--expected-wasm', required=True)
    args = parser.parse_args()
    if args.output.exists(): parser.error('preserve previous diagnostic output before repeating')
    result = {'status': 'RUNNING', 'points': [], 'frames': {}, 'startedAt': time.time(), 'cleanup': dict.fromkeys(lifecycle_evidence.CLEANUP_STEPS, False),
              'scope': 'browser-image cache: open (2 SVG pictures) / close / idle 10s / explicit trim / reopen; diagnostic only'}
    display = subprocess.Popen([str(args.xvfb), '-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        os.environ.update(DISPLAY=':' + display.stdout.readline().strip(), GDK_BACKEND='x11', WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS='1', NO_AT_BRIDGE='1', GTK_A11Y='none')
        os.environ['PATH'] = str(args.webkit_driver.parent) + os.pathsep + os.environ['PATH']
        with tempfile.TemporaryDirectory(prefix='geul-image-cache-trim-') as folder:
            work = Path(folder)
            for name in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR'):
                target = work / name; target.mkdir(); os.environ[name] = str(target)
            fixtures = work / 'fixtures'
            subprocess.run(['node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), str(fixtures)], check=True, capture_output=True)
            subprocess.run(['node', str(HERE / 'generate.mjs'), str(work)], check=True, capture_output=True)
            document = work / 'ownership-hwp.hwp'
            smoke.APP = str(args.app.resolve())
            with smoke.tauri_driver(str(args.driver.resolve()), 4489, str(work / 'data')) as start:
                d = start()
                try:
                    smoke.wait_until(d, "return !!document.querySelector('.document-bar__open')", timeout=30)
                    poc.open_document(d, fixtures / 'basic-ko.hwpx')
                    native_probe.install(d, native_probe.INSTALL.replace("import('/rhwp/rhwp.js')", 'Promise.resolve(window.__geulOwnership.probeEngine())').replace('/rhwp/rhwp_bg.wasm', '/__ownership_candidate__/rhwp_bg.wasm'))
                    history.close_discard(d, 'basic-ko.hwpx')
                    result['engineIdentity'] = d.js('return window.__geulOwnership.identity')
                    def sample(phase):
                        value = history.memory_sample(d)
                        value['processes'] = driver_module.with_generation(value['processes'])
                        value.update(phase=phase, renderer=d.js('return window.__geulOwnership.stats()'), at=round(time.time() - result['startedAt'], 2))
                        result['points'].append(value)
                    def settle_images():
                        smoke.wait_until(d, 'const s=window.__geulOwnership.stats();return s.sessions.every(x=>!x.active&&!x.queued)'
                                            '&&s.cache.images.entries>=arguments[0]&&s.cache.images.pendingEntries===0&&s.jobs.pendingCount===0', IMAGES, timeout=30)
                    def frame(name):
                        poc.click_paragraph_start(d)  # hitTest binds the probe to the live document for the reference replay
                        settle_images(); history.stable_digest(d, 0)
                        result['frames'][name] = d.js('return window.__rhwpProbe.fullFrameCheck(0)')
                    d.js('window.__geulOwnership.trim()'); time.sleep(1); sample('baseline')
                    poc.open_document(d, document, expected='ready'); frame('opened'); sample('opened')
                    history.close_discard(d, document.name); time.sleep(2); sample('closed')
                    time.sleep(10); sample('idle10s-without-trim')
                    d.js('window.__geulOwnership.trim()')
                    sample('trim+0s'); time.sleep(2); sample('trim+2s'); time.sleep(8); sample('trim+10s')
                    poc.open_document(d, document, expected='ready'); frame('reopened'); sample('reopened')
                    history.close_discard(d, document.name); time.sleep(2); sample('reclosed')
                    d.js('window.__geulOwnership.trim()'); time.sleep(1); sample('final-trim')
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
    """Fail closed: exact phases, every point structurally valid (settled points also accounted/clean), one stable
    WebProcess, populated image cache kept when closed and idle, emptied by trim, repopulated, exact frames."""
    if not isinstance(result, dict): return {'status': 'FAIL', 'failures': ['result is not an object'], 'summary': {}}
    failures = []
    raw = result.get('points')
    points = raw if isinstance(raw, list) and all(isinstance(p, dict) for p in raw) else []
    phases = [p.get('phase') for p in points]
    if not all(isinstance(phase, str) for phase in phases) or phases != PHASES or len(points) != len(raw if isinstance(raw, list) else []):
        return {'status': 'FAIL', 'failures': ['phases missing, malformed, duplicated, reordered or unexpected'], 'summary': {}}
    if result.get('error'): failures.append('run error: ' + str(result['error'])[:200])
    for key in ('engineIdentity', 'engineIdentityAtEnd'):
        if not isinstance(result.get(key), dict) or result[key].get('wasmSha256') != expected_wasm: failures.append(key + ' != expected WASM')
    cleanup = result.get('cleanup') if isinstance(result.get('cleanup'), dict) else {}
    if any(cleanup.get(step) is not True for step in lifecycle_evidence.CLEANUP_STEPS): failures.append('run cleanup incomplete')
    identities = set()
    for point in points:
        lifecycle_evidence.check_point(point, point['phase'], not point['phase'].startswith(('opened', 'reopened')), failures)
        identities.add(lifecycle_evidence.process_identity(point.get('processes'), point['phase'], []))
    if len(identities) != 1 or None in identities: failures.append(f'WebProcess identity not stable/verified: {sorted(map(str, identities))[:4]}')
    frames = result.get('frames') if isinstance(result.get('frames'), dict) else {}
    inexact = [name for name in FRAMES if not (isinstance(frames.get(name), dict) and frames[name].get('verified') is True
                                               and lifecycle_evidence.count(frames[name].get('pixels')) and frames[name]['pixels'] == 0
                                               and lifecycle_evidence.count(frames[name].get('maxDelta')) and frames[name]['maxDelta'] == 0)]
    if inexact: failures.append('displayed frame not exact with images: ' + ', '.join(inexact))
    by = {p['phase']: p for p in points}
    summary = {}
    if not failures:
        images = {phase: by[phase]['renderer']['cache']['images'] for phase in PHASES}
        surfaces = {phase: by[phase]['engineSurfaces'] for phase in PHASES}
        decoded = {phase: by[phase]['renderer']['cache']['decoded'] for phase in PHASES}
        resident = lambda phase: images[phase]['entries'] - images[phase]['negativeEntries']
        if resident('baseline') or images['baseline']['bytes']: failures.append('image cache not empty at baseline')
        if not (resident('opened') >= IMAGES and images['opened']['bytes'] > 0 and surfaces['opened']['imageCount'] >= IMAGES):
            failures.append('image cache not populated by the open document')
        kept = [phase for phase in ('closed', 'idle10s-without-trim') if (resident(phase), images[phase]['bytes']) != (resident('opened'), images['opened']['bytes'])]
        if kept: failures.append('closed/idle without trim did not keep the cache-owned images: ' + ', '.join(kept))
        left = [phase for phase in TRIMMED if images[phase]['entries'] or images[phase]['bytes'] or surfaces[phase]['imageCount']
                or decoded[phase]['entries'] or decoded[phase]['bytes'] or surfaces[phase]['detachedCanvases']]
        if left: failures.append('explicit trim left image/decoded cache entries or engine surfaces: ' + ', '.join(left))
        if not (resident('reopened') >= IMAGES and surfaces['reopened']['imageCount'] >= IMAGES): failures.append('reopen did not repopulate the image cache')
        # Natural pixels of the two resident SVG images, from the fixture definition, not from the observation itself.
        populated = ('opened', 'closed', 'idle10s-without-trim', 'reopened', 'reclosed')
        wrong = [f"{phase}={surfaces[phase]['imagePixels']}" for phase in populated if surfaces[phase]['imagePixels'] != IMAGE_PIXELS]
        wrong += [f"{phase}={surfaces[phase]['imagePixels']}" for phase in ('baseline', *TRIMMED) if surfaces[phase]['imagePixels']]
        if wrong: failures.append(f'engine image pixels != expected {IMAGE_PIXELS} when resident / 0 when empty: ' + ', '.join(wrong))
        summary = {phase: {'imageEntries': images[phase]['entries'], 'imageNegative': images[phase]['negativeEntries'], 'imageBytes': images[phase]['bytes'],
                           'engineImages': surfaces[phase]['imageCount'], 'imagePixels': surfaces[phase].get('imagePixels'),
                           'decodedEntries': decoded[phase]['entries'], 'decodedNegative': decoded[phase]['negativeEntries'],
                           'rssMiB': round(by[phase]['aggregateRssBytes'] / 2**20, 1)} for phase in PHASES}
    return {'status': 'FAIL' if failures else 'PASS', 'failures': failures, 'summary': summary}


if __name__ == '__main__':
    raise SystemExit(main())
