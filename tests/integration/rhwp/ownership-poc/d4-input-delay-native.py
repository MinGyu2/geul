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
from d4_evidence import validate
import undo_native as history
from native import smoke

FIXTURE = ('연구노트(화학).hwp', 'rnote/연구노트(화학).hwp', '6717eca43c6fdd9b0530530cf17d33b6687da0c462a433d37eb652afb5394f91')
EVENTS = r"""
if (!window.__inputDelay) {
  const E = window.__inputDelay = {keys: [], inputs: [], right: [], requests: [], effects: [], taskWitnesses: []};
  window.__d4RenderRequest = row => { if(E.requests.length<4096)E.requests.push(row); };
  window.__d4SurfaceEffect = row => { if(E.effects.length<4096)E.effects.push(row); };
  window.addEventListener('keydown', e => { if (!e.ctrlKey && e.key.length === 1) E.keys.push({t: e.timeStamp, seen: performance.now()}); }, true);
  window.addEventListener('keydown', e => { if(e.key === 'ArrowRight') { const r={t:e.timeStamp,seen:performance.now(),before:window.__geulOwnership?.stats()}; E.right.push(r); queueMicrotask(()=>{r.microtask=window.__geulOwnership?.stats()}); } }, true);
  window.addEventListener('keydown', e => { if(e.key==='ArrowRight') { const r=E.right.at(-1); if(r){r.bubbled=performance.now();r.after=window.__geulOwnership?.stats();} } });
  document.addEventListener('input', e => { if (e.target?.classList?.contains('rhwp-input')) E.inputs.push({t: e.timeStamp, seen: performance.now()}); }, true);
}
"""


def diagnostic_install():
    """Two counter snapshots per poll; numeric IDs only, no retained resources.

    Question: does THIS blocking poll miss/evict decoded images? Right-key
    observations ask whether modelVersion changes, without changing MEASURE.
    """
    script = native_probe.INSTALL.replace("import('/rhwp/rhwp.js')", 'Promise.resolve(window.__geulOwnership.probeEngine())')
    script = script.replace('  for (const name of [', '  const jobPages=new Map();\n  for (const name of [', 1)
    script = script.replace('value=original.apply(this,args);completed=true;', '''
        const before=name==='pollRenderJob'?window.__geulOwnership.stats():null;
        const wallStart=performance.now();
        value=original.apply(this,args);completed=true;
        const wallMs=performance.now()-wallStart;
        if(name==='beginRenderJob'){jobPages.set(value,args[0]);if(jobPages.size>512)jobPages.delete(jobPages.keys().next().value);}
        if(name==='pollRenderJob')p.lastRenderDiagnostic={id:args[0],page:jobPages.get(args[0])??null,
          before,after:window.__geulOwnership.stats(),wallStart,wallMs};
        // One zero-delay witness after a long poll: can a task run before delayed input?
        // Bounded, no self-reposting loop and no image/document retention.
        if(name==='pollRenderJob' && wallMs>=20 && window.__inputDelay?.taskWitnesses.length<128) {
          const row={pollStart:wallStart,posted:performance.now(),ran:null};
          window.__inputDelay.taskWitnesses.push(row);setTimeout(()=>{row.ran=performance.now();},0);
        }
        ''')
    token = "...(name==='pollRenderJob'&&completed?{outcome:value}:{})"
    assert token in script
    script = script.replace(token, "...(name==='pollRenderJob'&&completed?{outcome:value,diagnostic:p.lastRenderDiagnostic}:{})")
    script = script.replace('p.calls.splice(0,10000);', '{p.calls.splice(0,10000);p.callDropped=(p.callDropped||0)+10000;}')
    return script


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'webkit-driver', 'xvfb', 'xdotool', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--expected-wasm', required=True)
    parser.add_argument('--driver-log', type=Path)
    args = parser.parse_args()
    smoke.DRIVER_LOG = args.driver_log
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
                    native_probe.install(d, diagnostic_install())
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
                    result['probeCalls'] = d.js("return window.__rhwpProbe.calls.map(c=>({name:c.name,at:c.at,ms:c.ms,outcome:c.outcome??null,diagnostic:c.diagnostic??null}))")
                    result['traceSpans'] = d.js("return (window.__geulTrace?.records||[]).map(r=>({name:r[2],at:r[1],ms:typeof r[3]?.ms==='number'?r[3].ms:null}))")
                    result['probeCallDropped'] = d.js('return window.__rhwpProbe.callDropped||0')
                    result['traceDropped'] = d.js('return window.__geulTrace?.dropped ?? null')
                    result['engineIdentity'] = d.js('return window.__geulOwnership?.identity||null')
                finally:
                    smoke.end_session(d)
    except Exception as error:
        result['error'] = str(error)
        result['transportProcesses'] = smoke.owned_processes()
        result['driverLogTail'] = args.driver_log.read_text(errors='replace')[-8000:] if args.driver_log and args.driver_log.exists() else None
    finally:
        display.terminate(); display.wait(timeout=10)
        result['classification'] = validate(result, args.expected_wasm, expected_sha)
        result['status'] = result['classification']['status']
        result['officialD4'] = 'not evaluated: busy probe perturbs scheduling'
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=1).replace(str(ROOT), '<workspace>').replace(str(Path.home()), '<home>') + '\n')
    return 0 if result['status'] == 'DIAGNOSTIC_COMPLETE' else 1


if __name__ == '__main__':
    raise SystemExit(main())
