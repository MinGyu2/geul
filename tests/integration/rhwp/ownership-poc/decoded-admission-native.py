#!/usr/bin/env python3
"""Decoded-cache admission attribution for one native D4 fixture; diagnostic only.

Uses the canonical scenario and frame boundary with additional observer overhead.
Records operation names, dimensions, IDs and timings, never image/document data.
The existing probe, scenario, candidate binary and product files stay unchanged.
"""
import argparse
import importlib.util
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
import native
import native_probe
import undo_native as history
from native import smoke, poc


def diagnostic_install():
    source = HERE / 'render-phases-native.py'
    spec = importlib.util.spec_from_file_location('render_phases_observer', source)
    phases = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(phases)
    script = phases.diagnostic_install()
    marker = '  p.selectionAt ='
    assert script.count(marker) == 1
    script = script.replace(marker, '  p.jobPages = new Map();\n' + marker)
    marker = 'const doc=tracked(this), start=performance.now(); let value,completed=false;'
    assert script.count(marker) == 1
    script = script.replace(marker, marker + "const cacheBefore=name==='pollRenderJob'?JSON.parse(mod.rendererCacheStats()):null;")
    marker = '        p.calls.push({name,ms:performance.now()-start,at:start,'
    assert script.count(marker) == 1
    script = script.replace(marker, """        if(name==='beginRenderJob'&&completed){p.jobPages.set(value,args[0]);if(p.jobPages.size>256)p.jobPages.delete(p.jobPages.keys().next().value);}
        const page=name==='pollRenderJob'?(p.jobPages.get(args[0])??null):null;
        const cacheAfter=name==='pollRenderJob'?JSON.parse(mod.rendererCacheStats()):null;
        p.calls.push({name,ms:performance.now()-start,at:start,
          ...(name==='beginRenderJob'&&completed?{job:value,page:args[0]}:{}),
          ...(name==='pollRenderJob'?{job:args[0],page,decodedBefore:cacheBefore.decoded,decodedAfter:cacheAfter.decoded}:{}),""")
    marker = '        if(p.calls.length>20000) p.calls.splice(0,10000);'
    assert script.count(marker) == 1
    script = script.replace(marker, "        if(name==='pollRenderJob'&&completed&&value!=='PENDING')p.jobPages.delete(args[0]);\n" + marker)
    return script


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'webkit-driver', 'xvfb', 'xdotool', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise RuntimeError('Preserve previous diagnostic output before repeating')
    result = {'status': 'RUNNING', 'scope': 'single chemical HWP; decoded cache before/after every poll and actual job page; additional observer overhead; no official D4 acceptance',
              'protocol': 'unchanged undo_native.scenario_perf/MEASURE', 'observerSourceSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    result['observerDependenciesSha256'] = {str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [HERE/'render-phases-native.py',HERE.parent/'native_probe.py',HERE.parent/'undo_native.py',HERE/'session.mjs']}
    def save():
        clean=json.dumps(result,ensure_ascii=False,indent=2).replace(str(ROOT),'<workspace>').replace(str(Path.home()),'<home>')
        temporary=args.output.with_name(args.output.name+'.update.'+str(os.getpid()))
        temporary.write_text(clean+'\n');os.replace(temporary,args.output)
    display = subprocess.Popen([str(args.xvfb), '-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        os.environ.update(DISPLAY=':' + display.stdout.readline().strip(), GDK_BACKEND='x11', WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS='1', NO_AT_BRIDGE='1', GTK_A11Y='none', LIBGL_ALWAYS_SOFTWARE='1', WEBKIT_DISABLE_DMABUF_RENDERER='1')
        os.environ['PATH'] = str(args.webkit_driver.parent) + os.pathsep + os.environ['PATH']
        with tempfile.TemporaryDirectory(prefix='geul-render-phases-') as folder:
            work = Path(folder)
            for name in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR'):
                target = work / name; target.mkdir(); os.environ[name] = str(target)
            fixtures = work / 'fixtures'
            subprocess.run(['node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), str(fixtures)], check=True, capture_output=True)
            smoke.APP = str(args.app.resolve())
            smoke.DRIVER_LOG = '/tmp/geul-admission-native-driver.log'
            with smoke.tauri_driver(str(args.driver.resolve()), 4489, str(work / 'data')) as start:
                driver = start()
                driver.base = 'http://127.0.0.1:4445'
                result['transport'] = 'tauri session creation then same native WebKitWebDriver session4445 directly; no retries'
                try:
                    smoke.wait_until(driver, "return !!document.querySelector('.document-bar__open')", timeout=30)
                    poc.open_document(driver, fixtures / 'basic-ko.hwpx')
                    native_probe.install(driver, diagnostic_install())
                    result['engineIdentity'] = driver.js('return window.__geulOwnership.identity')
                    save()
                    history.close_discard(driver, 'basic-ko.hwpx')
                    windows = subprocess.check_output([str(args.xdotool), 'search', '--onlyvisible', '--name', '^geul'], text=True).split()
                    subprocess.run([str(args.xdotool), 'windowfocus', '--sync', windows[-1]], check=True)
                    driver.native_key_tool = str(args.xdotool)
                    driver.busy_probe = False
                    fixture = next(p for p in history.LARGE if p.name == '연구노트(화학).hwp')
                    history.scenario_perf(driver, fixture, work)
                    result['rawStages'] = driver.js('return window.__stages')
                    result['engineIdentity'] = driver.js('return window.__geulOwnership.identity')
                    result['adapterCounters'] = driver.js('return window.__geulOwnership.counters')
                    result['sourceSha256'] = hashlib.sha256(fixture.read_bytes()).hexdigest()
                finally:
                    smoke.end_session(driver)
        row = history.REPORT['perf'][0]
        result['measurementComplete'] = all(row.get(k, {}).get('n') == n and row[k]['timeouts'] == 0 for k, n in [('groupStart', 30), ('extend', 30), ('undo', 25), ('redo', 20), ('afterUndo', 5)])
        result['status'] = 'PASS' if result['measurementComplete'] else 'FAIL'
    except Exception as error:
        result.update(status='FAIL', error=str(error))
        if callable(getattr(error,'diagnostic',None)):result['driverDiagnostic']=error.diagnostic()
    finally:
        display.terminate(); display.wait(timeout=10)
        result.update(measurements=history.REPORT, gates=history.GATES)
        result['officialGateStatus'] = 'PASS' if history.GATES and all(g['result'] == 'PASS' for g in history.GATES) else 'FAIL'
        save()
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
