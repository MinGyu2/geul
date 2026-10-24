#!/usr/bin/env python3
"""D4 key->input delay diagnostic for one fixture (nonofficial; never a D4 result).

Question: in the 24-page chemical HWP the official group-start tail is dominated by native keydown -> input event
delivery (150-166 ms). Was the page main thread busy before the input could be dispatched, and with what? Runs the
unchanged undo_native.scenario_perf/MEASURE with its existing --busy-probe (a self-reposting MessageChannel task that
records every >8 ms main-thread gap; it perturbs scheduling, so values here are not official) and additionally keeps
absolute keydown/input times and the read-only probe call log and app trace spans (names and timings only).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(HERE))
import native  # noqa: F401  (sets import paths)
import native_probe
import undo_native as history
from native import smoke

FIXTURE = ('연구노트(화학).hwp', 'rnote/연구노트(화학).hwp', '6717eca43c6fdd9b0530530cf17d33b6687da0c462a433d37eb652afb5394f91')
EVENTS = r"""
if (!window.__inputDelay) {
  const E = window.__inputDelay = {keys: [], inputs: []};
  window.addEventListener('keydown', e => { if (!e.ctrlKey && e.key.length === 1) E.keys.push({t: e.timeStamp, seen: performance.now()}); }, true);
  document.addEventListener('input', e => { if (e.target?.classList?.contains('rhwp-input')) E.inputs.push({t: e.timeStamp, seen: performance.now()}); }, true);
}
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'webkit-driver', 'xvfb', 'xdotool', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--expected-wasm', required=True)
    args = parser.parse_args()
    if args.output.exists(): parser.error('preserve previous diagnostic output before repeating')
    name, relative, expected_sha = FIXTURE
    result = {'status': 'RUNNING', 'sample': name, 'protocol': 'unmodified undo_native.scenario_perf/MEASURE + existing busy probe + absolute key/input times',
              'official': False, 'environment': {'graphics': 'software GL (same as official)', 'display': 'Xvfb 1280x1024x24'}}
    display = subprocess.Popen([str(args.xvfb), '-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        os.environ.update(DISPLAY=':' + display.stdout.readline().strip(), GDK_BACKEND='x11', WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS='1', NO_AT_BRIDGE='1', GTK_A11Y='none',
                          LIBGL_ALWAYS_SOFTWARE='1', WEBKIT_DISABLE_DMABUF_RENDERER='1')
        os.environ['PATH'] = str(args.webkit_driver.parent) + os.pathsep + os.environ['PATH']
        with tempfile.TemporaryDirectory(prefix='geul-d4-input-delay-') as folder:
            work = Path(folder)
            for key in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR'):
                target = work / key; target.mkdir(); os.environ[key] = str(target)
            fixtures = work / 'fixtures'
            subprocess.run(['node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), str(fixtures)], check=True, capture_output=True)
            source = history.S / relative
            result['sourceSha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
            smoke.APP = str(args.app.resolve())
            with smoke.tauri_driver(str(args.driver.resolve()), 4489, str(work / 'data')) as start:
                d = start()
                try:
                    smoke.wait_until(d, "return !!document.querySelector('.document-bar__open')", timeout=30)
                    history.poc.open_document(d, fixtures / 'basic-ko.hwpx')
                    native_probe.install(d, native_probe.INSTALL.replace("import('/rhwp/rhwp.js')", 'Promise.resolve(window.__geulOwnership.probeEngine())'))
                    history.close_discard(d, 'basic-ko.hwpx')
                    windows = subprocess.check_output([str(args.xdotool), 'search', '--onlyvisible', '--name', '^geul'], text=True).split()
                    subprocess.run([str(args.xdotool), 'windowfocus', '--sync', windows[-1]], check=True)
                    d.native_key_tool = str(args.xdotool); d.busy_probe = True
                    d.js(EVENTS)
                    history.scenario_perf(d, source, work)
                    row = history.REPORT['perf'][-1]
                    result['measure'] = {k: row[k] for k in ('groupStart', 'extend', 'undo', 'redo', 'zeroWorkFrameFloorMs')}
                    result['samples'] = row['timelineSamples']
                    result['events'] = d.js('return window.__inputDelay')
                    result['probeCalls'] = d.js("return window.__rhwpProbe.calls.map(c=>({name:c.name,at:c.at,ms:c.ms,outcome:c.outcome??null}))")
                    result['traceSpans'] = d.js("return (window.__geulTrace?.records||[]).map(r=>({name:r[2],at:r[1],ms:typeof r[3]?.ms==='number'?r[3].ms:null}))")
                    result['traceDropped'] = d.js('return window.__geulTrace?.dropped ?? null')
                    result['engineIdentity'] = d.js('return window.__geulOwnership?.identity||null')
                finally:
                    smoke.end_session(d)
    except Exception as error:
        result['error'] = str(error)
    finally:
        display.terminate(); display.wait(timeout=10)
        group = [s for s in result.get('samples', []) if s.get('kind') == 'groupStart']
        complete = (not result.get('error') and result.get('sourceSha256') == expected_sha and (result.get('engineIdentity') or {}).get('wasmSha256') == args.expected_wasm
                    and len(group) == 30 and all(isinstance(s.get('busy'), list) for s in group))
        result['status'] = 'DIAGNOSTIC_COMPLETE' if complete else 'FAIL'
        result['officialD4'] = 'not evaluated: busy probe perturbs scheduling'
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=1).replace(str(ROOT), '<workspace>').replace(str(Path.home()), '<home>') + '\n')
    return 0 if result['status'] == 'DIAGNOSTIC_COMPLETE' else 1


if __name__ == '__main__':
    raise SystemExit(main())
