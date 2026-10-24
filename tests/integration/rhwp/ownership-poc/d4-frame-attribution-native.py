#!/usr/bin/env python3
"""D4 frame attribution (diagnostic; never an official D4 result).

Runs the unchanged undo_native.scenario_perf/MEASURE per official fixture, plus one extra observer: a
MutationObserver on data-local-revision records the commit time, the next three RAFs, and one
MessageChannel task after each, so main-thread rendering-update work (rafX -> taskX) is separated from
waiting for the next frame (taskX -> next raf). The observer perturbs scheduling slightly, so this run's
MEASURE values are not official. The actual graphics backend is recorded from /proc: DRM device fds,
their fdinfo engine counters (GPU work evidence) and loaded GL/DRI libraries.
"""
import argparse
import hashlib
import json
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
    const r = {kind: key?.kind ?? window.__nextKind ?? null, key: key?.t ?? null, rev: performance.now()}; key = null;
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


def classify(result):
    complete = len(result.get('documents', [])) == 4
    for doc in result.get('documents', []):
        records = [r for r in doc.get('observer', []) if r.get('kind') == 'groupStart']
        complete = complete and doc.get('groupStart', {}).get('n') == 30 and doc['groupStart'].get('timeouts') == 0 \
            and len(records) == 30 and all(all(isinstance(r.get(k), (int, float)) for k in ('rev', 'rafA', 'taskA', 'rafB', 'taskB', 'rafC')) for r in records)
    return {'measurementComplete': complete, 'status': 'DIAGNOSTIC_COMPLETE' if complete and not result.get('error') else 'FAIL',
            'officialD4': 'not evaluated: diagnostic observer perturbs scheduling; official result stays the first valid official run'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'webkit-driver', 'xvfb', 'xdotool', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--graphics', choices=tuple(GRAPHICS), required=True)
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
                            'observer': d.js('return window.__frameAttr.records'), 'backendBefore': backend_before, 'backendAfter': graphics_backend()})
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
        result.update(classify(result))
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=1).replace(str(ROOT), '<workspace>').replace(str(Path.home()), '<home>') + '\n')
    return 0 if result['status'] == 'DIAGNOSTIC_COMPLETE' else 1


if __name__ == '__main__':
    raise SystemExit(main())
