#!/usr/bin/env python3
"""D4 frame attribution (diagnostic; never an official D4 result).

Runs the unchanged undo_native.scenario_perf/MEASURE per official fixture, plus one extra observer: a
MutationObserver on data-local-revision records the commit time, the next three RAFs, and one
MessageChannel task posted from each. These are observed intervals only: rafX -> taskX is when the page
next ran a task, which can include any browser rendering-update or scheduling work (and can even fall after
the next RAF); it is not Canvas drawing, GPU or compositor time. The observer perturbs scheduling slightly,
so this run's MEASURE values are not official. Observer records pair with MEASURE samples only by order:
canonical MEASURE exposes no trial identifier. The actual graphics backend is recorded from /proc: DRM
device fds, their fdinfo engine counters (GPU work evidence) and loaded GL/DRI libraries.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
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
from native import smoke

FIXTURES = (('basic-ko.hwp', None), ('basic-ko.hwpx', None), ('연구노트(화학).hwp', 'rnote/연구노트(화학).hwp'),
            ('3249937_asset_management_rules.hwpx', 'issue6031/3249937_asset_management_rules.hwpx'))
EXPECTED_SOURCE_SHA256 = {  # deterministic generated fixtures and pinned public samples (identical in every prior run)
    'basic-ko.hwp': '57c901cc394abf6f58f4838315d1ea2c5ecf8a03d9934d3fc098fd8be6e6e12f',
    'basic-ko.hwpx': '26d434b7b427149110751c6ef5b19e9ecb4818f3ba7eadfe201b5afd3de442a8',
    '연구노트(화학).hwp': '6717eca43c6fdd9b0530530cf17d33b6687da0c462a433d37eb652afb5394f91',
    '3249937_asset_management_rules.hwpx': '97b5d6c571a6b7626321c6a53d797e3511978447497bb73309bd23eaa8e7ea77'}
TIMES = ('key', 'rev', 'task0', 'rafA', 'taskA', 'rafB', 'taskB', 'rafC')
# Orderings guaranteed by how each callback is scheduled. taskA/taskB may legitimately run after the next RAF.
CAUSAL_ORDER = (('key', 'rev'), ('rev', 'task0'), ('rev', 'rafA'), ('rafA', 'taskA'), ('rafA', 'rafB'), ('rafB', 'taskB'), ('rafB', 'rafC'))
GRAPHICS = {'software': {'LIBGL_ALWAYS_SOFTWARE': '1', 'WEBKIT_DISABLE_DMABUF_RENDERER': '1'}, 'gpu': {}}
OBSERVER = r"""
if (!window.__frameAttr) {
  const A = window.__frameAttr = {records: []}, queue = [], channel = new MessageChannel();
  channel.port1.onmessage = () => { const f = queue.shift(); if (f) f(performance.now()); };
  const task = f => { queue.push(f); channel.port2.postMessage(0); };
  let key = null, last = null;
  window.addEventListener('keydown', e => {
    if (e.ctrlKey && (e.code === 'KeyZ' || e.code === 'KeyY')) key = {kind: e.code === 'KeyZ' && !e.shiftKey ? 'undo' : 'redo', t: e.timeStamp};
    else if (!e.ctrlKey && e.key.length === 1) key = {kind: null, t: e.timeStamp};
  }, true);
  new MutationObserver(() => {
    const value = document.querySelector('[data-testid=rhwp-status]')?.dataset.localRevision;
    if (value === last) return; last = value;
    if (!Array.isArray(window.__lat)) return;  // only while the canonical MEASURE is collecting
    const r = {kind: key?.kind ?? window.__nextKind ?? null, key: key?.t ?? null, rev: performance.now(), revision: value}; key = null;
    A.records.push(r); if (A.records.length > 1000) A.records.shift();
    task(t => r.task0 = t);
    requestAnimationFrame(() => { r.rafA = performance.now(); task(t => r.taskA = t);
      requestAnimationFrame(() => { r.rafB = performance.now(); task(t => r.taskB = t);
        requestAnimationFrame(() => { r.rafC = performance.now(); task(t => r.taskC = t); }); }); });
  }).observe(document.body, {subtree: true, attributes: true, attributeFilter: ['data-local-revision']});
}
"""


def graphics_backend():
    """DRM fds (+fdinfo engine counters) and GL/DRI libraries of this session's app/WebKit processes."""
    rows = []
    for process in smoke.owned_processes():
        pid, entry = process['pid'], {'comm': process['comm'], 'drm': [], 'glLibraries': []}
        try:
            for fd in os.listdir(f'/proc/{pid}/fd'):
                try: target = os.readlink(f'/proc/{pid}/fd/{fd}')
                except OSError: continue
                if target.startswith('/dev/dri/'):
                    info = Path(f'/proc/{pid}/fdinfo/{fd}').read_text()
                    fields = dict(line.split(':', 1) for line in info.splitlines() if line.startswith('drm-') and ':' in line)
                    entry['drm'].append({'device': target, **{k: v.strip() for k, v in fields.items() if k.startswith(('drm-driver', 'drm-engine', 'drm-cycles', 'drm-total-cycles', 'drm-client-id'))}})
            maps = Path(f'/proc/{pid}/maps').read_text()
            entry['glLibraries'] = sorted({Path(m).name for m in re.findall(r'(/\S+\.so[\.\d]*)', maps) if re.search(r'gallium|dri|EGL|GLX|libGL|llvmpipe|swrast|iris|gbm|vulkan|libdrm', m)})
        except OSError as error:
            entry['error'] = type(error).__name__
        rows.append(entry)
    return rows


def timestamp(value):
    return type(value) in (int, float) and math.isfinite(value)


def sha256_hex(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def records(value):
    """A required list whose every item is an object; anything else is malformed (None)."""
    return value if isinstance(value, list) and all(isinstance(item, dict) for item in value) else None


def classify(result, expected_wasm):
    """Diagnostic completeness only (never official D4): exact fixtures/order/identity, 30 canonical and 30 observer
    group-start records per document with finite, causally ordered timestamps and unique revisions. Every field is
    type-checked before lookup, hashing or comparison, so malformed JSON yields FAIL rather than an exception."""
    failures, unavailable = [], []
    if not isinstance(result, dict): return {'status': 'FAIL', 'failures': ['result is not an object'], 'unavailableEvidence': []}
    if not sha256_hex(expected_wasm): return {'status': 'FAIL', 'failures': ['expected WASM identity is not a lowercase SHA-256'], 'unavailableEvidence': []}
    if result.get('error'): failures.append('run error: ' + str(result['error'])[:200])
    documents = records(result.get('documents'))
    if documents is None: failures.append('documents missing or malformed'); documents = []
    names = [d.get('sample') for d in documents]
    if names != [name for name, _ in FIXTURES]:
        failures.append('documents missing, duplicated, reordered or unexpected')
    for doc in documents:
        name = doc.get('sample')
        if not isinstance(name, str): continue  # already a failure above; never hash a malformed sample
        if doc.get('sourceSha256') != EXPECTED_SOURCE_SHA256.get(name):
            failures.append(f'{name}: source fixture identity mismatch')
        if 'engineIdentity' not in doc: unavailable.append(f'{name}: per-document engine identity')
        elif not isinstance(doc['engineIdentity'], dict) or doc['engineIdentity'].get('wasmSha256') != expected_wasm:
            failures.append(f'{name}: engine identity missing, malformed or != expected WASM')
        measured, timeline = doc.get('groupStart'), records(doc.get('measureTimeline'))
        group = [s for s in timeline or [] if s.get('kind') == 'groupStart']
        if not isinstance(measured, dict) or type(measured.get('n')) is not int or measured['n'] != 30 \
                or type(measured.get('timeouts')) is not int or measured['timeouts'] != 0 or timeline is None or len(group) != 30 \
                or not all(timestamp(s.get('keyToFrame')) and s['keyToFrame'] >= 0 for s in group):
            failures.append(f'{name}: canonical MEASURE group-start missing, malformed, incomplete or timed out')
        observer = records(doc.get('observer'))
        starts = [r for r in observer or [] if r.get('kind') == 'groupStart']
        if observer is None or len(starts) != 30:
            failures.append(f'{name}: observer group-start records {len(starts)} != 30 or malformed'); continue
        bad = [i for i, r in enumerate(starts) if not all(timestamp(r.get(k)) for k in TIMES)]
        if bad: failures.append(f'{name}: observer records with missing/non-finite/boolean timestamps {bad[:5]}'); continue
        disordered = [i for i, r in enumerate(starts) if any(r[a] > r[b] for a, b in CAUSAL_ORDER)]
        if disordered: failures.append(f'{name}: observer records violate causal callback order {disordered[:5]}')
        revisions = [r.get('revision') for r in starts]
        if all(v is None for v in revisions) and not any('revision' in r for r in starts): unavailable.append(f'{name}: observer revision identifiers')
        elif not all(isinstance(v, str) and v for v in revisions): failures.append(f'{name}: observer revision missing or not a non-empty string')
        elif len(set(revisions)) != len(revisions): failures.append(f'{name}: duplicated observer revisions')
    final = result.get('engineIdentity')
    if not isinstance(final, dict) or final.get('wasmSha256') != expected_wasm: failures.append('final engine identity missing, malformed or != expected WASM')
    status = 'FAIL' if failures else 'INCONCLUSIVE' if unavailable else 'DIAGNOSTIC_COMPLETE'
    return {'measurementComplete': status == 'DIAGNOSTIC_COMPLETE', 'status': status, 'failures': failures, 'unavailableEvidence': unavailable,
            'observerMeasurePairing': 'by order only: canonical MEASURE records no trial identifier; agreement of end times is a consistency check, not identity',
            'officialD4': 'not evaluated: diagnostic observer perturbs scheduling; official result stays the first valid official run'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'webkit-driver', 'xvfb', 'xdotool', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--graphics', choices=tuple(GRAPHICS), required=True)
    parser.add_argument('--expected-wasm', required=True)
    args = parser.parse_args()
    if args.output.exists(): parser.error('preserve previous diagnostic output before repeating')
    result = {'status': 'RUNNING', 'graphicsRequest': args.graphics, 'protocol': 'unmodified undo_native.scenario_perf/MEASURE + revision frame observer', 'documents': [],
              'environment': {'webkitGTK': subprocess.check_output(['pkg-config', '--modversion', 'webkit2gtk-4.1'], text=True).strip(), 'display': 'Xvfb 1280x1024x24 (no physical display)',
                              'GDK_BACKEND': 'x11', 'graphicsEnvironment': GRAPHICS[args.graphics], 'loadAverageBefore': os.getloadavg(),
                              'cpuAffinity': sorted(os.sched_getaffinity(0)), 'debugAppSha256': hashlib.sha256(args.app.read_bytes()).hexdigest()}}
    display = subprocess.Popen([str(args.xvfb), '-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        for name in ('LIBGL_ALWAYS_SOFTWARE', 'WEBKIT_DISABLE_DMABUF_RENDERER'): os.environ.pop(name, None)
        os.environ.update(DISPLAY=':' + display.stdout.readline().strip(), GDK_BACKEND='x11', WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS='1', NO_AT_BRIDGE='1', GTK_A11Y='none', **GRAPHICS[args.graphics])
        os.environ['PATH'] = str(args.webkit_driver.parent) + os.pathsep + os.environ['PATH']
        with tempfile.TemporaryDirectory(prefix='geul-d4-frame-attribution-') as folder:
            work = Path(folder)
            for name in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR'):
                target = work / name; target.mkdir(); os.environ[name] = str(target)
            fixtures = work / 'fixtures'
            subprocess.run(['node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), str(fixtures)], check=True, capture_output=True)
            smoke.APP = str(args.app.resolve())
            for index, (name, relative) in enumerate(FIXTURES):
                source = fixtures / name if relative is None else history.S / relative
                with smoke.tauri_driver(str(args.driver.resolve()), 4489, str(work / ('data-' + str(index)))) as start:
                    d = start()
                    try:
                        smoke.wait_until(d, "return !!document.querySelector('.document-bar__open')", timeout=30)
                        history.poc.open_document(d, fixtures / 'basic-ko.hwpx')
                        native_probe.install(d, native_probe.INSTALL.replace("import('/rhwp/rhwp.js')", 'Promise.resolve(window.__geulOwnership.probeEngine())'))
                        history.close_discard(d, 'basic-ko.hwpx')
                        windows = subprocess.check_output([str(args.xdotool), 'search', '--onlyvisible', '--name', '^geul'], text=True).split()
                        subprocess.run([str(args.xdotool), 'windowfocus', '--sync', windows[-1]], check=True)
                        d.native_key_tool = str(args.xdotool); d.busy_probe = False
                        d.js(OBSERVER)
                        backend_before = graphics_backend()
                        history.scenario_perf(d, source, work)
                        row = history.REPORT['perf'][-1]
                        result['documents'].append({'sample': name, 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'dpr': row['dpr'], 'zoom': row['zoom'],
                            **{k: row[k] for k in ('groupStart', 'extend', 'undo', 'redo', 'afterUndo', 'zeroWorkFrameFloorMs', 'frameGapDuringHistoryAndFollowingInputMs')},
                            'measureTimeline': [{'kind': s['kind'], 'keyToFrame': s['keyToFrame'], 'at': s['at']} for s in row['timelineSamples']],
                            'observer': d.js('return window.__frameAttr.records'), 'backendBefore': backend_before, 'backendAfter': graphics_backend(),
                            'engineIdentity': d.js('return window.__geulOwnership?.identity||null')})
                        result['engineIdentity'] = d.js('return window.__geulOwnership?.identity||null')
                    finally:
                        smoke.end_session(d)
                        args.output.write_text(json.dumps(result, ensure_ascii=False) + '\n')
    except Exception as error:
        result['error'] = str(error)
    finally:
        display.terminate(); display.wait(timeout=10)
        result['nonOfficialGateRows'] = history.GATES
        result['environment']['loadAverageAfter'] = os.getloadavg()
        result.update(classify(result, args.expected_wasm))
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=1).replace(str(ROOT), '<workspace>').replace(str(Path.home()), '<home>') + '\n')
    return 0 if result['status'] == 'DIAGNOSTIC_COMPLETE' else 1


if __name__ == '__main__':
    raise SystemExit(main())
