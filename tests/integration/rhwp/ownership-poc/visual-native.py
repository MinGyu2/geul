#!/usr/bin/env python3
"""Candidate D1: actual native history, attached Canvas RGBA and interaction matrix."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import native
import undo_native as history
import native_probe
from native import smoke, poc
ROOT = HERE.parents[3]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'webkit-driver', 'xvfb', 'xdotool', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    result = {'status': 'RUNNING', 'tests': [], 'scope': 'actual candidate native body/cell/multisection UndoRedo and attached Canvas RGBA'}
    def check(name, ok, **data):
        result['tests'].append({'name': name, 'status': 'PASS' if ok else 'FAIL', **data})
        if not ok: raise RuntimeError(name)
    display = subprocess.Popen([str(args.xvfb), '-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        os.environ.update(DISPLAY=':' + display.stdout.readline().strip(), GDK_BACKEND='x11', WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS='1', NO_AT_BRIDGE='1', GTK_A11Y='none')
        os.environ['PATH'] = str(args.webkit_driver.parent) + os.pathsep + os.environ['PATH']
        with tempfile.TemporaryDirectory(prefix='geul-candidate-safety-') as folder:
            work = Path(folder)
            for name in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR'):
                target = work / name; target.mkdir(); os.environ[name] = str(target)
            fixtures = work / 'fixtures'
            subprocess.run(['node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), str(fixtures)], check=True, capture_output=True)
            subprocess.run(['node', str(HERE / 'generate.mjs'), str(work)], check=True, capture_output=True)
            smoke.APP = str(args.app.resolve())
            with smoke.tauri_driver(str(args.driver.resolve()), 4489, str(work / 'data')) as start:
                d = start()
                try:
                    smoke.wait_until(d, "return !!document.querySelector('.document-bar__open')", timeout=30)
                    # Bootstrap the real loader, then instrument its authoritative class.
                    poc.open_document(d, fixtures / 'basic-ko.hwpx')
                    smoke.wait_until(d, 'return window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)', timeout=30)
                    d.js("window.__aliasDiagnostic=null;import('/__ownership_candidate__/rhwp.js').then(m=>window.__aliasDiagnostic={sameConstructor:m.HwpDocument===window.__geulOwnership.probeEngine().HwpDocument,resources:performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname==='/__ownership_candidate__/rhwp.js').map(e=>new URL(e.name).pathname+new URL(e.name).search)})")
                    smoke.wait_until(d, 'return !!window.__aliasDiagnostic', timeout=10)
                    result['observerAliasDiagnostic'] = d.js('return window.__aliasDiagnostic')
                    install = native_probe.INSTALL.replace("import('/rhwp/rhwp.js')", 'Promise.resolve(window.__geulOwnership.probeEngine())').replace('/rhwp/rhwp_bg.wasm', '/__ownership_candidate__/rhwp_bg.wasm')
                    native_probe.install(d, install)
                    check('bootstrap-clean-close', poc.close_tab(d, 'basic-ko.hwpx'))
                    windows = subprocess.check_output([str(args.xdotool), 'search', '--onlyvisible', '--name', '^geul'], text=True).split()
                    subprocess.run([str(args.xdotool), 'windowfocus', '--sync', windows[-1]], check=True)
                    d.native_key_tool = str(args.xdotool)
                    result['visualReferences']=[]
                    def frame(label,page):
                        smoke.wait_until(d,'return window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)',timeout=30)
                        history.stable_digest(d,page)
                        row=d.js('return window.__rhwpProbe.fullFrameCheck(arguments[0])',page)
                        result['visualReferences'].append({'name':label,**row})
                        check(label+'-full-reference-exact',row.get('verified') and row['pixels']==0,reference=row)
                    original_full_redraw=history.full_redraw
                    redraw_count=0
                    def check_before_full_redraw(driver):
                        nonlocal redraw_count
                        redraw_count+=1
                        frame('before-full-redraw-'+str(redraw_count),history.caret_page(driver))
                        original_full_redraw(driver)
                    history.full_redraw=check_before_full_redraw
                    original_type=history.poc.type_ascii
                    type_count=0
                    def checked_type(driver,text):
                        nonlocal type_count
                        value=original_type(driver,text);type_count+=1
                        frame('native-type-'+str(type_count),history.caret_page(driver))
                        return value
                    history.poc.type_ascii=checked_type
                    original_same_content=history.same_content
                    def exact_transition(driver,page,reference,name):
                        value=original_same_content(driver,page,reference,name)
                        frame('transition-'+reference+'-'+name,page)
                        return value
                    history.same_content=exact_transition
                    for fmt in ('hwp','hwpx'):
                        path=fixtures/('basic-ko.'+fmt)
                        history.scenario_render_basic(d,path,fmt,None)
                        frame(fmt+'-body-and-cell-final',0)
                        history.close_discard(d,path.name)
                        poc.open_document(d,path);poc.click_paragraph_start(d);poc.type_ascii(d,'XY')
                        poc.press(d,'Left',shift=True)
                        frame(fmt+'-typed-selection',0)
                        check(fmt+'-selection-visible',d.js('return document.querySelectorAll(".rhwp-selection").length>0'))
                        selection=d.js("""const key=document.querySelector('[data-testid=rhwp-status]').dataset.caret;
                          const gs=window.__rhwpProbe.selectionAt(key),vs=[...document.querySelectorAll('.rhwp-selection')];
                          return !!gs&&gs.length===vs.length&&gs.every((g,i)=>{const c=document.querySelectorAll('.rhwp-page__canvas')[g.pageIndex],r=c.getBoundingClientRect(),v=vs[i].getBoundingClientRect();
                            const p=window.__rhwpProbe.cursor(key).page,sx=r.width/p.width,sy=r.height/p.height;
                            return Math.abs(v.left-r.left-g.x*sx)<=1&&Math.abs(v.top-r.top-g.y*sy)<=1&&Math.abs(v.width-g.width*sx)<=1&&Math.abs(v.height-g.height*sy)<=1;});""")
                        check(fmt+'-selection-engine-geometry',selection)
                        _,changed=history.history_key(d,'z')
                        check(fmt+'-selected-undo-caret',changed and history.caret_matches_engine(d) and d.js('return document.querySelectorAll(".rhwp-selection").length===0'))
                        _,changed=history.history_key(d,'y');frame(fmt+'-redo-displayed',0)
                        before=int(poc.status(d)['localRevision']);generation=d.js('return window.__geulOwnership.stats().sessions[0].generation');poc.set_zoom(d,125);frame(fmt+'-zoom125',0)
                        check(fmt+'-zoom-keeps-revision-caret',int(poc.status(d)['localRevision'])==before and history.caret_matches_engine(d) and d.js('return window.__geulOwnership.stats().sessions[0].generation')==generation)
                        scroll=d.js("const s=document.querySelector('.editor__scroll');s.scrollTop=25;return s.scrollTop")
                        frame(fmt+'-scrolled-frame',0)
                        check(fmt+'-scroll-stable',d.js("return document.querySelector('.editor__scroll').scrollTop")==scroll)
                        d.js('window.__geulOwnership.trim();window.__geulOwnership.repaint()')
                        frame(fmt+'-trim-history-frame',0)
                        _,changed=history.history_key(d,'z');frame(fmt+'-undo-after-trim',0)
                        check(fmt+'-undo-after-trim-revision',changed and int(poc.status(d)['localRevision'])>before)
                        history.close_discard(d,path.name);poc.set_zoom(d,100)
                    for path,_ in history.MULTI:
                        history.scenario_render_multi(d,path,work)
                    result['engineIdentity']=d.js('return window.__geulOwnership.identity')
                    result['adapterCounters']=d.js('return window.__geulOwnership.counters')
                    d.js('window.__geulOwnership.trim()')
                    check('native-final-resource-cleanup',d.js('const s=window.__geulOwnership.stats();return s.subscribers===0&&s.jobs.activeLeaseCount===0&&s.jobs.pendingCount===0&&s.jobs.uniqueResourceCount===0&&s.jobs.expiryTimerActive===false'))
                    result['status'] = 'PASS'
                finally:
                    try:
                        result['lastObserved'] = d.js("const e=document.querySelector('[data-testid=rhwp-status]');return {status:e?Object.fromEntries(['status','uncertain','revision','localRevision','dirty','history'].map(k=>[k,e.dataset[k]])):null,identity:window.__geulOwnership?.identity,owners:window.__rhwpProbe?.owners(),snapshotCalls:window.__rhwpProbe?.calls.filter(c=>/Snapshot/.test(c.name)).slice(-20),throwAfterDiscard:window.__rhwpProbe?.throwAfterDiscard,jobs:window.__geulOwnership?.stats().jobs}")
                    except Exception: pass
                    smoke.end_session(d)
    except Exception as error:
        result['status']='FAIL';result['error']=str(error)
    finally:
        display.terminate(); display.wait(timeout=10)
        result['existingSaveAssertions'] = poc.RESULTS
        result['historyGates'] = history.GATES
        result['historyChecks'] = history.RESULTS
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2).replace(str(ROOT), '<workspace>').replace(str(Path.home()), '<home>') + '\n')
    return 0 if result['status']=='PASS' else 1


if __name__=='__main__':
    raise SystemExit(main())
