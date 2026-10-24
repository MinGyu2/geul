#!/usr/bin/env python3
"""D1 native history while image decoding, cache eviction and document replacement."""
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
    result = {'status': 'RUNNING', 'tests': [], 'scope': 'actual native HWP/HWPX image history, cancellation, trim, late completion and attached Canvas RGBA'}
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
                    def frame(name):
                        smoke.wait_until(d,'return window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)',timeout=30)
                        history.stable_digest(d,0)
                        row=d.js('return window.__rhwpProbe.fullFrameCheck(0)')
                        result['visualReferences'].append({'name':name,**row})
                        check(name,row.get('verified') and row['pixels']==0,reference=row)
                    hold=r"""window.__historySrcDescriptor=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
                    window.__historyHeld={key:arguments[0],image:null};const desc=window.__historySrcDescriptor;
                    Object.defineProperty(HTMLImageElement.prototype,'src',{...desc,set(value){
                      if(value&&!window.__historyHeld.image){window.__historyHeld.image=this;desc.set.call(this,'/held-image.svg?key='+window.__historyHeld.key+'&data='+encodeURIComponent(value));}
                      else desc.set.call(this,value);
                    }});"""
                    release=r"""const h=window.__historyHeld;Object.defineProperty(HTMLImageElement.prototype,'src',window.__historySrcDescriptor);
                    window.__historyReleased=false;fetch('/release-image?key='+h.key).then(()=>{h.image.dispatchEvent(new Event('load'));window.__historyReleased=true;window.__historyHeld=null;});"""
                    for fmt in ('hwp','hwpx'):
                        image=work/('ownership-'+fmt+'.'+fmt)
                        d.js('window.__geulOwnership.trim()');d.js(hold,'history-initial-'+fmt)
                        poc.open_document(d,image)
                        smoke.wait_until(d,'return !!window.__historyHeld.image&&window.__geulOwnership.stats().jobs.pendingCount>0',timeout=15)
                        before=d.js('return window.__geulOwnership.stats()');base=poc.status(d)
                        check(fmt+'-genuine-pending-history-document',before['jobs']['pendingCount']>0 and before['jobs']['activeJobs']>0,resources=before['jobs'])
                        poc.click_paragraph_start(d);d.js("document.querySelector('.rhwp-input').focus()");base=poc.status(d)
                        edited=poc.type_ascii(d,'R');frame(fmt+'-edit-supersedes-pending-exact')
                        undone,changed=history.history_key(d,'z');frame(fmt+'-undo-images-exact')
                        redone,changed2=history.history_key(d,'y');frame(fmt+'-redo-images-exact')
                        check(fmt+'-pending-history-model-revisions',changed and changed2 and edited['paragraphText']!=base['paragraphText']
                            and undone['paragraphText']==base['paragraphText'] and redone['paragraphText']==edited['paragraphText']
                            and int(base['localRevision'])<int(edited['localRevision'])<int(undone['localRevision'])<int(redone['localRevision'])
                            and redone['dirty']=='true',revisions=[int(x['localRevision']) for x in [base,edited,undone,redone]])
                        d.js(release);smoke.wait_until(d,'return window.__historyReleased')
                        # Real cache eviction, then a held redraw while the last good frame remains visible.
                        prior=history.stable_digest(d,0);d.js(hold,'history-switch-'+fmt)
                        d.js('window.__geulOwnership.trim();window.__geulOwnership.repaint()')
                        smoke.wait_until(d,'return !!window.__historyHeld.image&&window.__geulOwnership.stats().jobs.pendingCount>0',timeout=15)
                        check(fmt+'-trim-pending-preserves-visible-frame',d.js(history.DIGEST,0)==prior)
                        path=fixtures/('basic-ko.'+fmt);poc.open_document(d,path);poc.click_paragraph_start(d)
                        frame(fmt+'-replacement-before-late-exact')
                        history.close_discard(d,image.name)
                        stable=poc.status(d);count=d.js('return window.__geulOwnership.counters.completed')
                        d.js(release);smoke.wait_until(d,'return window.__historyReleased');time.sleep(.3)
                        frame(fmt+'-replacement-after-late-exact')
                        after=poc.status(d)
                        check(fmt+'-late-callback-no-publication-or-mutation',after['paragraphText']==stable['paragraphText']
                            and after['localRevision']==stable['localRevision'] and after['dirty']==stable['dirty']
                            and d.js('return window.__geulOwnership.counters.completed')==count)
                        history.close_discard(d,path.name);d.js('window.__geulOwnership.trim()')
                        clean=d.js('return window.__geulOwnership.stats()')
                        check(fmt+'-history-close-all-resources-zero',clean['subscribers']==0 and clean['jobs']['activeLeaseCount']==0
                            and clean['jobs']['pendingCount']==0 and clean['jobs']['uniqueResourceCount']==0,resources=clean['jobs'])
                    result['engineIdentity'] = d.js('return window.__geulOwnership.identity')
                    d.js('window.__geulOwnership.trim()')
                    check('native-final-resource-cleanup', d.js('const s=window.__geulOwnership.stats();return s.subscribers===0&&s.jobs.activeLeaseCount===0&&s.jobs.pendingCount===0&&s.jobs.uniqueResourceCount===0'))
                    result['status'] = 'PASS'
                finally:
                    try:
                        result['lastObserved'] = d.js("const e=document.querySelector('[data-testid=rhwp-status]');return {status:e?Object.fromEntries(['status','uncertain','revision','localRevision','dirty','history'].map(k=>[k,e.dataset[k]])):null,identity:window.__geulOwnership?.identity,owners:window.__rhwpProbe?.owners(),snapshotCalls:window.__rhwpProbe?.calls.filter(c=>/Snapshot/.test(c.name)).slice(-20),throwAfterDiscard:window.__rhwpProbe?.throwAfterDiscard,jobs:window.__geulOwnership?.stats().jobs}")
                    except Exception: pass
                    try:d.js("if(window.__historySrcDescriptor)Object.defineProperty(HTMLImageElement.prototype,'src',window.__historySrcDescriptor)")
                    except Exception:pass
                    smoke.end_session(d)
    except Exception as error:
        result['status']='FAIL';result['error']=str(error)
    finally:
        display.terminate(); display.wait(timeout=10)
        result['nativeHelperAssertions'] = poc.RESULTS
        result['historyGates'] = history.GATES
        result['historyChecks'] = history.RESULTS
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2).replace(str(ROOT), '<workspace>').replace(str(Path.home()), '<home>') + '\n')
    return 0 if result['status']=='PASS' else 1


if __name__=='__main__':
    raise SystemExit(main())
