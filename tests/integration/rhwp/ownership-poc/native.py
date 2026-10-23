#!/usr/bin/env python3
"""Conditional real Tauri/WebKitGTK ownership PoC; isolated dev server must already run."""
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
sys.path.insert(0, str(ROOT / 'tests/e2e'))
sys.path.insert(0, str(ROOT / 'tests/integration/rhwp'))
import tauri_smoke as smoke
import rhwp_poc as poc


def rss():
    rows = []
    for process in smoke.owned_processes():
        try:
            values = Path('/proc/' + str(process['pid']) + '/status').read_text().splitlines()
            size = next(int(line.split()[1]) for line in values if line.startswith('VmRSS:'))
            rows.append({'role': process['comm'], 'rssKiB': size})
        except (OSError, StopIteration):
            pass
    return rows


PIXELS = r"""
const bytes=new Uint8Array(arguments[0]),page=arguments[1];window.__ownershipPixelResult=null;
(async()=>{
 const mod=await import('/rhwp/rhwp.js');await mod.default({module_or_path:'/rhwp/rhwp_bg.wasm'});
 const doc=new mod.HwpDocument(bytes),canvas=document.createElement('canvas');
 try{
  doc.renderPageToCanvas(page,canvas,(window.devicePixelRatio||1)*(arguments[2]||1));await new Promise(r=>setTimeout(r,500));
  doc.renderPageToCanvas(page,canvas,(window.devicePixelRatio||1)*(arguments[2]||1));
  const actual=document.querySelectorAll('.rhwp-page__canvas')[page];
  let mismatches=0;
  if(!actual||actual.width!==canvas.width||actual.height!==canvas.height)mismatches=-1;
  else{
   const a=actual.getContext('2d').getImageData(0,0,actual.width,actual.height).data;
   const b=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
   for(let i=0;i<a.length;i+=4)if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2]||a[i+3]!==b[i+3])mismatches++;
  }
  window.__ownershipPixelResult={pixelMismatchCount:mismatches,width:canvas.width,height:canvas.height};
 }finally{doc.free();canvas.width=canvas.height=0;}
})().catch(e=>{window.__ownershipPixelResult={error:String(e)};});
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--extended', action='store_true')
    parser.add_argument('--matrix', action='store_true', help='also compare multi-document budget/scroll/zoom cases')
    for name in ('app', 'driver', 'webkit-driver', 'xvfb', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    evidence = ROOT / 'tests/integration/rhwp/evidence/t010-render-ownership'
    gate = json.loads((evidence / 'engine-safety-gates.json').read_text())
    if gate['status'] != 'PASS':
        raise RuntimeError('engine safety prerequisites failed')
    result = {'status': 'RUNNING', 'classification': 'VERIFIED only for executed checks',
              'target': 'real Tauri/WebKitGTK, gated candidate dev-server injection',
              'expectedWasmSha256': gate['wasmSha256'], 'tests': [], 'budgets': []}

    def save():
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + '\n')

    def check(name, condition, **data):
        result['tests'].append({'name': name, 'status': 'PASS' if condition else 'FAIL', **data})
        save()
        if not condition:
            raise RuntimeError(name)

    display = subprocess.Popen([str(args.xvfb), '-displayfd', '1', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        os.environ['DISPLAY'] = ':' + display.stdout.readline().strip()
        os.environ['PATH'] = str(args.webkit_driver.parent) + os.pathsep + os.environ['PATH']
        os.environ['WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS'] = '1'
        os.environ['NO_AT_BRIDGE'] = '1'
        os.environ['GTK_A11Y'] = 'none'
        with tempfile.TemporaryDirectory(prefix='geul-ownership-native-') as temporary:
            work = Path(temporary)
            for name in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR'):
                folder = work / name; folder.mkdir(); os.environ[name] = str(folder)
            generated = subprocess.run(['node', str(HERE / 'generate.mjs'), str(work)], cwd=ROOT, capture_output=True, text=True)
            if generated.returncode: raise RuntimeError('fixture generation: ' + generated.stderr)
            spec = importlib.util.spec_from_file_location('ownership_browser_runner', HERE.parent / 'cache-concurrency/run.py')
            fixtures = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixtures)
            fixtures.multisection_fixture(work / 'multiple-sections.hwpx')
            smoke.APP = str(args.app.resolve())
            with smoke.tauri_driver(str(args.driver.resolve()), 4487, str(work / 'data')) as start:
                driver = start()
                try:
                    smoke.wait_until(driver, "return !!document.querySelector('.document-bar__open')", timeout=30)
                    check('candidate-dev-origin', driver.js('return location.origin') == 'http://localhost:1420')
                    for format in ('hwp', 'hwpx'):
                        before = driver.js('return window.__geulOwnership?.counters.completed||0')
                        poc.open_document(driver, work / ('ownership-' + format + '.' + format))
                        smoke.wait_until(driver, "return !!window.__geulOwnership && window.__geulOwnership.counters.completed>arguments[0] && window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)", before, timeout=30)
                        loaded = driver.js('return window.__geulOwnership.identity')
                        check(format + '-candidate-identity', loaded['wasmSha256'] == gate['wasmSha256'], identity=loaded)
                        pixels = driver.js("const c=document.querySelector('.rhwp-page__canvas');const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let color=0;for(let i=0;i<p.length;i+=4)if(p[i+3]>200&&Math.max(p[i],p[i+1],p[i+2])-Math.min(p[i],p[i+1],p[i+2])>100)color++;return {width:c.width,height:c.height,color};")
                        check(format + '-images-visible', pixels['color'] > 1000, measurements=pixels)
                        driver.js(PIXELS, list((work / ('ownership-' + format + '.' + format)).read_bytes()), 0)
                        smoke.wait_until(driver, 'return !!window.__ownershipPixelResult', timeout=15)
                        compared = driver.js('return window.__ownershipPixelResult')
                        check(format + '-exact-native-pixels', compared.get('pixelMismatchCount') == 0, measurements=compared)
                    check('two-live-session-listeners', driver.js('return window.__geulOwnership.stats().subscribers') == 2)
                    check('close-one-keeps-other', poc.close_tab(driver, 'ownership-hwp.hwp') and driver.js('return window.__geulOwnership.stats().subscribers') == 1)
                    for mib in (256, 384, 512):
                        driver.js('window.__geulOwnership.budget(arguments[0]);', mib << 20)
                        driver.js('window.__geulOwnership.trim();')
                        samples = []
                        for kind in ('cache-cold', 'warm', 'warm', 'warm'):
                            before = driver.js('return window.__geulOwnership.counters.completed')
                            started = time.monotonic()
                            driver.js('window.__geulOwnership.repaint();')
                            smoke.wait_until(driver, 'return window.__geulOwnership.counters.completed>arguments[0] && window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)', before, timeout=30)
                            samples.append({'kind': kind, 'hostObservedCompletionMs': round((time.monotonic() - started) * 1000, 2)})
                        result['budgets'].append({'requestedMiB': mib, 'split': '75% decoded Canvas /25% browser residents; module browser lease cap remains256MiB', 'samples': samples, 'ownership': driver.js('return window.__geulOwnership.stats()'), 'processRss': rss(), 'officialD4Timing': False})
                        save()
                    check('close-final', poc.close_tab(driver, 'ownership-hwpx.hwpx'))
                    poc.open_document(driver, work / 'multiple-sections.hwpx')
                    smoke.wait_until(driver, 'return document.querySelectorAll(".rhwp-page__canvas").length===3 && [...document.querySelectorAll(".rhwp-page__canvas")].every(c=>c.width>0) && window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)', timeout=30)
                    for page in range(3):
                        driver.js(PIXELS, list((work / 'multiple-sections.hwpx').read_bytes()), page)
                        smoke.wait_until(driver, 'return !!window.__ownershipPixelResult', timeout=15)
                        compared = driver.js('return window.__ownershipPixelResult')
                        check('multisection-native-page-' + str(page), compared.get('pixelMismatchCount') == 0, measurements=compared)
                    if args.extended:
                        for zoom in (150, 50, 100):
                            poc.set_zoom(driver, zoom)
                            smoke.wait_until(driver, 'return window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)', timeout=30)
                            for page in (2, 0):
                                driver.js('document.querySelectorAll(".rhwp-page")[arguments[0]].scrollIntoView({block:"start"})', page)
                                time.sleep(.25)
                                driver.js(PIXELS, list((work / 'multiple-sections.hwpx').read_bytes()), page, zoom / 100)
                                smoke.wait_until(driver, 'return !!window.__ownershipPixelResult', timeout=15)
                                compared = driver.js('return window.__ownershipPixelResult')
                                check('scroll-zoom-' + str(zoom) + '-page-' + str(page), compared.get('pixelMismatchCount') == 0, measurements=compared)
                    check('close-multisection', poc.close_tab(driver, 'multiple-sections.hwpx'))
                    if args.extended:
                        # Hold real image src assignments; do not replace document/model APIs.
                        poc.open_document(driver, work / 'ownership-hwpx.hwpx')
                        smoke.wait_until(driver, 'return window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)', timeout=30)
                        driver.js(r'''window.__heldImages=new Map();window.__lateImages=[];
                          window.__imageSrc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
                          Object.defineProperty(HTMLImageElement.prototype,'src',{...window.__imageSrc,set(value){
                            if(value){window.__heldImages.set(this,value);window.__lateImages.push([this,value]);}
                            else{window.__heldImages.delete(this);window.__imageSrc.set.call(this,value);}
                          }});
                          window.__geulOwnership.trim();window.__geulOwnership.repaint();''')
                        smoke.wait_until(driver, 'return window.__geulOwnership.stats().jobs.pendingCount>0', timeout=10)
                        held = driver.js('return window.__geulOwnership.stats()')
                        before = driver.js('return window.__geulOwnership.counters.completed')
                        poc.set_zoom(driver, 150)
                        smoke.wait_until(driver, 'return window.__lateImages.length>=2 && window.__geulOwnership.stats().jobs.pendingCount>0', timeout=10)
                        check('pending-zoom-no-false-complete', driver.js('return window.__geulOwnership.counters.completed') == before, measurements=held)
                        driver.js('Object.defineProperty(HTMLImageElement.prototype,"src",window.__imageSrc);for(const [image,value] of window.__heldImages)window.__imageSrc.set.call(image,value);window.__heldImages.clear();')
                        smoke.wait_until(driver, 'return window.__geulOwnership.counters.completed>arguments[0] && window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)', before, timeout=30)
                        driver.js(PIXELS, list((work / 'ownership-hwpx.hwpx').read_bytes()), 0, 1.5)
                        smoke.wait_until(driver, 'return !!window.__ownershipPixelResult', timeout=15)
                        check('pending-replacement-latest-pixels', driver.js('return window.__ownershipPixelResult.pixelMismatchCount') == 0)
                        # Block again, close a genuinely PENDING document, then reopen another.
                        driver.js(r'''window.__heldImages.clear();window.__lateImages=[];
                          Object.defineProperty(HTMLImageElement.prototype,'src',{...window.__imageSrc,set(value){
                            if(value){window.__heldImages.set(this,value);window.__lateImages.push([this,value]);}
                            else{window.__heldImages.delete(this);window.__imageSrc.set.call(this,value);}
                          }});window.__geulOwnership.trim();window.__geulOwnership.repaint();''')
                        smoke.wait_until(driver, 'return window.__geulOwnership.stats().jobs.pendingCount>0', timeout=10)
                        check('close-pending-document', poc.close_tab(driver, 'ownership-hwpx.hwpx'))
                        driver.js('Object.defineProperty(HTMLImageElement.prototype,"src",window.__imageSrc)')
                        released = driver.js('return window.__geulOwnership.stats()')
                        check('pending-close-releases-leases', released['subscribers'] == 0 and released['jobs']['pendingCount'] == 0 and released['jobs']['ownedEstimatedBytes'] == 0, measurements=released)
                        poc.open_document(driver, work / 'multiple-sections.hwpx')
                        smoke.wait_until(driver, 'return document.querySelectorAll(".rhwp-page__canvas").length===3 && [...document.querySelectorAll(".rhwp-page__canvas")].every(c=>c.width>0) && window.__geulOwnership.stats().sessions.every(s=>s.canvases===3&&!s.active&&!s.queued)', timeout=30)
                        actual_zoom = driver.js('return parseInt(document.querySelector(".statusbar__zoom-value").textContent)/100')
                        before = driver.js('return window.__geulOwnership.counters.completed')
                        driver.js('for(const [image,value] of window.__lateImages){window.__imageSrc.set.call(image,value);image.dispatchEvent(new Event("load"));}window.__lateImages=[]')
                        time.sleep(.75)
                        driver.js(PIXELS, list((work / 'multiple-sections.hwpx').read_bytes()), 0, actual_zoom)
                        smoke.wait_until(driver, 'return !!window.__ownershipPixelResult', timeout=15)
                        late = driver.js('return {pixels:window.__ownershipPixelResult,completed:window.__geulOwnership.counters.completed}')
                        check('late-load-cannot-paint-reopened-document', late['pixels'].get('pixelMismatchCount') == 0 and late['completed'] == before, measurements=late, completedBefore=before, zoom=actual_zoom)
                        check('close-reopened-document', poc.close_tab(driver, 'multiple-sections.hwpx'))
                    if args.matrix:
                        for name in ('ownership-hwp.hwp', 'ownership-hwpx.hwpx', 'multiple-sections.hwpx'):
                            poc.open_document(driver, work / name)
                        smoke.wait_until(driver, 'return document.querySelectorAll(".rhwp-page__canvas").length===3 && [...document.querySelectorAll(".rhwp-page__canvas")].every(c=>c.width>0) && window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)', timeout=30)
                        result['multiDocumentBudgets'] = []
                        for mib in (256, 384, 512):
                            driver.js('window.__geulOwnership.budget(arguments[0]);window.__geulOwnership.trim()', mib << 20)
                            rows = []
                            for zoom, page in ((50, 2), (100, 0), (150, 2)):
                                poc.set_zoom(driver, zoom)
                                driver.js('document.querySelectorAll(".rhwp-page")[arguments[0]].scrollIntoView({block:"start"})', page)
                                for kind in ('cache-cold', 'warm'):
                                    if kind == 'cache-cold':
                                        driver.js('window.__geulOwnership.trim()')
                                    before = driver.js('return window.__geulOwnership.counters.completed')
                                    started = time.monotonic()
                                    driver.js('window.__geulOwnership.repaint()')
                                    smoke.wait_until(driver, 'return window.__geulOwnership.counters.completed>arguments[0] && window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)', before, timeout=30)
                                    rows.append({'zoom': zoom, 'page': page, 'kind': kind, 'hostObservedCompletionMs': round((time.monotonic() - started) * 1000, 2)})
                                driver.js(PIXELS, list((work / 'multiple-sections.hwpx').read_bytes()), page, zoom / 100)
                                smoke.wait_until(driver, 'return !!window.__ownershipPixelResult', timeout=15)
                                compared = driver.js('return window.__ownershipPixelResult')
                                check(f'multi-budget-{mib}-zoom-{zoom}-page-{page}', compared.get('pixelMismatchCount') == 0, measurements=compared)
                            stats = driver.js('return window.__geulOwnership.stats()')
                            check(f'multi-budget-{mib}-three-subscribers', stats['subscribers'] == 3, measurements={'subscribers': stats['subscribers']})
                            result['multiDocumentBudgets'].append({'requestedMiB': mib, 'samples': rows, 'ownership': stats, 'processRss': rss(), 'officialD4Timing': False})
                            save()
                        for name in ('ownership-hwp.hwp', 'ownership-hwpx.hwpx', 'multiple-sections.hwpx'):
                            check('matrix-close-' + name, poc.close_tab(driver, name))
                    time.sleep(.5)
                    closed = driver.js('return window.__geulOwnership.stats()')
                    check('closed-host-and-transient-zero', closed['subscribers'] == 0 and not closed['sessions'] and closed['jobs']['activeLeaseEstimatedBytes'] == 0, measurements=closed)
                    driver.js('window.__geulOwnership.trim()')
                    final = driver.js('return window.__geulOwnership.stats()')
                    check('pressure-trim-owned-zero', final['jobs']['ownedEstimatedBytes'] == 0 and final['cache']['images']['bytes'] == 0, measurements=final)
                    check('no-host-errors-or-limits', driver.js('return window.__geulOwnership.counters.errors+window.__geulOwnership.counters.limits') == 0)
                    result['processesBeforeExit'] = rss()
                finally:
                    try: result['lastObserved'] = driver.js("return {origin:location.origin,status:[...document.querySelectorAll('[data-testid=rhwp-status]')].map(e=>({status:e.dataset.status,pages:e.dataset.pages,revision:e.dataset.revision,dirty:e.dataset.dirty})),ownership:window.__geulOwnership?{identity:window.__geulOwnership.identity,counters:window.__geulOwnership.counters,stats:window.__geulOwnership.stats()}:null}")
                    except Exception: pass
                    save()
                    smoke.end_session(driver)
        result['status'] = 'PASS'
    except Exception as error:
        result['status'] = 'FAIL'
        if not any(t['status']=='FAIL' for t in result['tests']): result['tests'].append({'name':'runner-completion','status':'FAIL'})
        result['error'] = str(error).replace(str(ROOT), '<workspace>').replace(str(Path.home()), '<home>')
    finally:
        display.terminate(); display.wait(timeout=10)
        result['passed'] = sum(t['status'] == 'PASS' for t in result['tests'])
        result['failed'] = sum(t['status'] == 'FAIL' for t in result['tests'])
        result['skippedOrIgnored'] = 0
        save()
    print(json.dumps({k: result[k] for k in ('status', 'passed', 'failed')}))
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
