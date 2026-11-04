#!/usr/bin/env python3
"""Native T023 failure/concurrency probe; reuses the real app/chooser harness.
Controlled IPC delay/corruption affects only this test WebView. File writes,
engine loads and session operations still execute the production backend.
"""
import argparse
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import traceback
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('new_document', ROOT / 'scripts/tests/native-new-document.py')
native = importlib.util.module_from_spec(spec); spec.loader.exec_module(native)
smoke = native.smoke


class Safety(native.Acceptance):
    def record(self, name, **details):
        self.report['negative'].append({'case': name, 'status': 'PASS', **details})
        self.write()

    def write(self):
        (self.args.out / 'result.json').write_text(json.dumps(self.report, ensure_ascii=False, indent=2) + '\n')

    def invoke_new(self, fmt, path, payload=b'', report=None):
        meta = json.dumps({'path': str(path), 'format': fmt, 'contentLoss': report}).encode()
        frame = b'GNC1' + struct.pack('<I', len(meta)) + meta + payload
        return self.async_js("return await window.__TAURI_INTERNALS__.invoke('document_new',Uint8Array.from(atob(arguments[0]),c=>c.charCodeAt(0)))", base64.b64encode(frame).decode())

    def rejects(self, name, fmt, path, payload=b'', report=None, code=None):
        before = self.sessions()
        existing = path.read_bytes() if path.is_file() else None
        response = self.invoke_new(fmt, path, payload, report)
        assert not response['ok'], (name, response)
        if code:
            assert response['error']['code'] == code, (name, response)
        assert self.sessions() == before, name
        if existing is None:
            assert not path.exists(), name
        else:
            assert path.read_bytes() == existing, name
        self.record(name, error=response['error']['code'], published=False, targetUnchanged=True, registered=False)

    def backend_negatives(self):
        protected = self.args.out / 'existing.docx'
        protected.write_bytes(b'unchanged existing user file')
        self.rejects('existing destination', 'docx', protected, code='FileConflict')
        symlink = self.args.out / 'symlink.docx'; symlink.symlink_to(protected)
        self.rejects('existing symbolic link', 'docx', symlink, code='FileConflict')
        assert symlink.is_symlink()
        self.rejects('wrong extension', 'hwp', self.args.out / 'wrong.docx', b'x', {}, 'ExtensionMismatch')
        raw = (self.args.fixtures / 'blank.hwpx').read_bytes()
        loss = {'schemaVersion': 1, 'outputFormat': 'hwpx', 'count': 0, 'losses': []}
        self.rejects('wrong actual format', 'hwp', self.args.out / 'wrong.hwp', raw, {**loss, 'outputFormat': 'hwp'})
        self.rejects('invalid structure', 'hwpx', self.args.out / 'broken.hwpx', raw[:100], loss)
        modified = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(raw)) as source, zipfile.ZipFile(modified, 'w') as output:
            for item in source.infolist():
                value = source.read(item.filename)
                if item.filename == 'Contents/section0.xml':
                    value = value.replace(b'charPrIDRef="0"', b'charPrIDRef="99"')
                output.writestr(item, value)
        self.rejects('invalid internal reference', 'hwpx', self.args.out / 'reference.hwpx', modified.getvalue(), loss)
        for label, report in [('inconsistent loss report', {**loss, 'count': 1}),
                              ('wrong loss format', {**loss, 'outputFormat': 'hwp'}),
                              ('untrusted safe assertion', {'safe': True, 'blank': True})]:
            self.rejects(label, 'hwpx', self.args.out / (label.replace(' ', '-') + '.hwpx'), raw, report)
        denied = self.args.out / 'denied'; denied.mkdir(mode=0o500)
        try:
            self.rejects('insufficient directory permissions', 'docx', denied / 'denied.docx')
        finally: denied.chmod(0o700)

        before = self.sessions(); created = []
        for index in range(65):
            path = self.args.out / f'capacity-{index}.docx'
            response = self.invoke_new('docx', path)
            assert path.exists()
            if not response['ok']:
                assert response['error']['code'] == 'FilePublishedUnregistered', response
                assert len(self.sessions()) == 64
                self.record('capacity/registration failure after publication', published=True, durability='not exposed by registration-failure response', registered=False, retainedFile=True)
                break
            created.append(response['value']['sessionId'])
        else: raise AssertionError('capacity bound was not reached')
        for session_id in created:
            response = self.async_js("return await window.__TAURI_INTERNALS__.invoke('document_close',{sessionId:arguments[0]})", session_id)
            assert response['ok'], response
        assert self.sessions() == before

    def active(self):
        return self.d.js("return document.querySelector('.document-tab__select[aria-selected=true]')?.dataset.session")

    def select(self, name):
        self.d.js("window.__ndTab=[...document.querySelectorAll('.document-tab__select')].find(e=>e.textContent.includes(arguments[0]));window.__ndTab.dataset.ndTarget='yes'", name)
        self.d.click('[data-nd-target=yes]')
        self.d.js("delete window.__ndTab.dataset.ndTarget")

    def workspace(self):
        # Bind the actual already-running workspace from React owner props.
        # Never import a second module, replace Tauri's frozen IPC internals, or
        # create another model/session to make the acceptance probe pass.
        self.d.js("""const host=document.querySelector('.app');
        const key=Object.getOwnPropertyNames(host).find(k=>k.startsWith('__reactFiber$'));
        const found=new Set();for(let f=host[key];f;f=f.return){
          const w=f.memoizedProps?.documents;
          if(w&&typeof w.newDocument==='function'&&w.sessions&&w.filePort&&w.backend)found.add(w);
        }if(found.size!==1)throw Error('actual workspace ownership unavailable');
        window.__ndWorkspace=[...found][0];""")

    def delay(self, command):
        self.workspace()
        self.d.js("""const owner=arguments[0]==='document_new'?window.__ndWorkspace.filePort:window.__ndWorkspace.backend;
        const method=arguments[0]==='document_new'?'createDocument':'load';
        window.__ndOwner=owner;window.__ndMethod=method;window.__ndOriginal=owner[method];
        window.__ndPending=false;window.__ndResume=null;let held=false;
        const replacement=(...args)=>{
          if(!held){held=true;window.__ndPending=true;return new Promise((resolve,reject)=>{
            window.__ndResume=()=>{window.__ndPending=false;window.__ndOriginal.apply(owner,args).then(resolve,reject)};
          })}return window.__ndOriginal.apply(owner,args);
        };owner[method]=replacement;if(owner[method]!==replacement)throw Error('delay hook was not installed');""", command)

    def resume(self):
        self.d.js("window.__ndOwner[window.__ndMethod]=window.__ndOriginal;window.__ndResume()")

    def cancellations_and_concurrency(self):
        for fmt in ['docx', 'hwp']:
            self.open(fmt, self.args.documents / ('created.' + fmt))
        initial = self.sessions(); active = self.active()
        self.key('ctrl+n')
        self.wait("return document.querySelector('[data-testid=new-document-dialog]')!==null")
        self.key('ctrl+n')
        assert self.d.js("return document.querySelectorAll('[data-testid=new-document-dialog]').length") == 1
        self.key('Escape')
        self.wait("return document.querySelector('[data-testid=new-document-dialog]')===null")
        assert self.sessions() == initial and self.active() == active
        self.record('format cancellation and duplicate Ctrl+N', published=False, registered=False, activeTabPreserved=True)
        self.key('ctrl+n')
        self.wait("return document.querySelector('[data-testid=new-document-dialog]')!==null")
        self.key('Tab', 'Tab', 'Return')
        self.wait("return document.querySelector('[data-testid=new-document-dialog]')===null")
        self.key('Escape')
        self.wait("return !document.querySelector('[data-testid=document-new-docx]')?.disabled")
        assert self.sessions() == initial and self.active() == active
        self.record('destination cancellation', published=False, registered=False, activeTabPreserved=True)

        late = self.args.out / 'late.hwp'
        self.delay('document_new')
        self.new('hwp', late)
        self.wait('return window.__ndPending===true')
        assert not late.exists()
        self.select('created.docx')
        selected = self.active()
        self.resume()
        self.wait("return !document.querySelector('[data-testid=document-new-docx]')?.disabled", timeout=60)
        assert late.exists() and len(self.sessions()) == len(initial) + 1
        assert self.active() == selected
        self.wait("return document.activeElement?.closest('.docx-surface')!==null")
        self.record('tab switch and late creation completion', published=True, registered=True, activeTabPreserved=True, focusPreserved=True)

        self.engine('xkb:us::eng'); self.key('End'); self.type(' unsaved')
        self.wait("return document.querySelector('[data-testid=docx-status]')?.dataset.dirty==='true'")
        self.delay('document_load')
        modal = self.args.out / 'modal.hwp'
        self.new('hwp', modal)
        self.wait('return window.__ndPending===true')
        self.d.js("window.__ndClose=[...document.querySelectorAll('.document-tab__close')].find(e=>e.getAttribute('aria-label').includes('created.docx'));window.__ndClose.dataset.ndClose='yes'")
        self.d.click('[data-nd-close=yes]')
        self.wait("return document.querySelector('[data-testid=discard-dialog]')!==null")
        self.resume()
        self.ready('hwp', modal.name)
        assert self.d.js("return document.activeElement===document.querySelector('[data-testid=discard-cancel]')")
        self.record('modal owns focus during late engine readiness', published=True, registered=True, focusPreserved=True)
        self.d.click('[data-testid=discard-cancel]')

    def ime_and_failure(self):
        self.d.click('.rhwp-page')
        self.engine('hangul'); self.type('gk')
        self.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.composing==='true'")
        owner = self.active(); count = len(self.sessions())
        self.d.js("window.__ndIme=[];for(const type of ['keydown','compositionend'])document.addEventListener(type,e=>window.__ndIme.push({type,key:e.key??'',composing:e.isComposing??null}),true)")
        before_sessions = self.sessions()
        self.key('ctrl+n')
        opened = self.d.exists('[data-testid=new-document-dialog]')
        if opened:
            # GTK may commit preedit BEFORE delivering Ctrl+N. Starting New
            # after that commit is allowed; the original owner must retain it.
            self.text_is('hwp', '하')
            events = self.d.js('return window.__ndIme')
            end = next(i for i,e in enumerate(events) if e['type']=='compositionend')
            shortcut = next(i for i,e in enumerate(events) if e['type']=='keydown' and e['key'].lower()=='n')
            assert end < shortcut, events
            self.key('Escape')
            self.wait("return document.querySelector('[data-testid=new-document-dialog]')===null")
        self.key('End'); self.text_is('hwp', '하')
        assert self.active() == owner and len(self.sessions()) == count
        self.record('IME ownership across native Ctrl+N', published=False, registered=False, text='하', owningSessionPreserved=True, selectionOpenedAfterNativeCommit=opened)
        assert all(next(s for s in self.sessions() if s['sessionId']==old['sessionId'])['revision']==old['revision'] for old in before_sessions if str(old['sessionId'])!=owner)
        self.save('hwp')

        self.engine('xkb:us::eng')
        broken = self.args.out / 'editor-load-failed.hwp'
        self.workspace()
        self.d.js("""window.__ndOwner=window.__ndWorkspace.backend;window.__ndOriginal=window.__ndOwner.load;let broken=false;
        window.__ndOwner.load=(...args)=>{
          const result=window.__ndOriginal.apply(window.__ndOwner,args);
          if(!broken){broken=true;return result.then(reply=>{
            if(!reply.ok)return reply;const bytes=reply.value.bytes.slice();bytes.fill(0,0,16);
            return {ok:true,value:{...reply.value,bytes}};
          })}return result;
        };""")
        self.new('hwp', broken)
        self.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.status==='failed'", timeout=60)
        self.wait("return document.querySelector('footer.statusbar')?.textContent.includes('파일은 만들어졌지만')")
        assert broken.exists()
        self.d.js("window.__ndOwner.load=window.__ndOriginal")
        self.record('editor load failure after publication/registration', published=True, registered=True, fileRetained=True, distinctUserMessage=True)


    def export_failure(self):
        self.open('hwp',self.args.documents/'created.hwp')
        before=self.sessions();active=self.active();path=self.args.out/'export-failed.hwpx'
        self.workspace()
        self.d.js("""const w=window.__ndWorkspace;window.__ndLoader=w.loadModule;
        window.__ndPublisher=w.filePort.createDocument;window.__ndPublisherCalls=0;
        window.__ndAllocated=0;window.__ndFreed=0;
        w.filePort.createDocument=(...args)=>{window.__ndPublisherCalls++;return window.__ndPublisher(...args)};
        w.loadModule=async()=>{const m=await window.__ndLoader();window.__ndModule=m;
          window.__ndFactory=m.createEmptyDocument;m.createEmptyDocument=()=>{
            const d=window.__ndFactory();window.__ndAllocated++;const free=d.free.bind(d);
            d.free=()=>{window.__ndFreed++;free()};
            d.exportHwpxWithReport=()=>{throw Error('controlled native creation export failure')};return d;
          };return m;
        };""")
        try:
            self.new('hwpx',path)
            self.wait("return window.__ndWorkspace.fileBusy===false")
            message=json.loads((ROOT/'src/language/ko.json').read_text())['document.error.EngineFailure']
            self.wait("return document.querySelector('footer.statusbar')?.textContent.includes(arguments[0])",message)
            assert not path.exists() and self.sessions()==before and self.active()==active
            counts=self.d.js("return {allocated:window.__ndAllocated,freed:window.__ndFreed,publisherCalls:window.__ndPublisherCalls}")
            assert counts=={'allocated':1,'freed':1,'publisherCalls':0},counts
            self.record('native WASM export failure',published=False,registered=False,activeTabPreserved=True,**counts)
        finally:
            self.d.js("window.__ndModule.createEmptyDocument=window.__ndFactory;window.__ndWorkspace.loadModule=window.__ndLoader;window.__ndWorkspace.filePort.createDocument=window.__ndPublisher")

    def unconfirmed_publication(self):
        # Only the successful IPC response is altered. The real file is
        # published; Rust's separate DirSync fault tests cover actual fsync errors.
        self.workspace()
        self.d.js("""const w=window.__ndWorkspace;
        window.__ndCreate=w.filePort.createDocument;
        window.__ndLoads=[w.backend,w.docxBackend].map(owner=>({owner,load:owner.load}));
        window.__ndLoadCalls=0;
        for(const {owner,load} of window.__ndLoads)owner.load=(...a)=>{window.__ndLoadCalls++;return load.apply(owner,a)};
        w.filePort.createDocument=async(...a)=>{const r=await window.__ndCreate.apply(w.filePort,a);
          return r.ok?{ok:true,value:{...r.value,dirty:true}}:r};""")
        try:
            for fmt in ['docx','hwp','hwpx']:
                path=self.args.out/('unconfirmed.'+fmt)
                before=len(self.sessions())
                self.new(fmt,path)
                self.wait('return window.__ndWorkspace.fileBusy===false')
                self.wait("return document.querySelector('footer.statusbar')?.textContent.includes('자동 열기를 보류')")
                state=self.d.js("const w=window.__ndWorkspace;return w.sessions.get(w.sessions.snapshot().activeId)")
                assert state['format']==fmt and state['dirty'] and state['state']=='identified' and state['loadGeneration']==0,state
                assert path.is_file() and len(self.sessions())==before+1
                assert self.d.js('return window.__ndLoadCalls')==0
                assert not self.d.exists('.rhwp-input')
                self.record('reported durability uncertainty '+fmt,published=True,registered=True,fileRetained=True,
                            automaticLoadDeferred=True,loadCalls=0,simulation='response dirty=true; actual DirSync injection is Rust-only')
                self.d.click('.document-tab__select[aria-selected=true] + .document-tab__close')
                self.wait("return document.querySelector('[data-testid=discard-confirm]')!==null")
                self.d.click('[data-testid=discard-confirm]')
                self.wait('return window.__ndWorkspace.sessions.snapshot().sessions.length===arguments[0]',before)
                assert path.is_file()
        finally:
            self.d.js("window.__ndWorkspace.filePort.createDocument=window.__ndCreate;for(const {owner,load} of window.__ndLoads)owner.load=load")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['app', 'out', 'fixtures', 'documents']:
        parser.add_argument('--' + name, type=Path, required=True)
    for name in ['driver', 'xdotool', 'ibus']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--port', type=int, default=4444)
    parser.add_argument('--phase',choices=['all','backend','concurrency','ime','export','uncertainty'],default='all')
    args = parser.parse_args(); args.out.mkdir(parents=True, exist_ok=False)
    report = {'status': 'RUNNING', 'negative': [], 'sourceHead': subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
              'appSha256': native.sha(args.app), 'harnessSha256': native.sha(__file__),
              'sourceDiffSha256': hashlib.sha256(subprocess.check_output(['git','diff','HEAD','--','src','src-tauri'],cwd=ROOT)).hexdigest()}
    smoke.APP = str(args.app.resolve()); smoke.DRIVER_LOG = args.out/'driver.log'
    d = None
    try:
        with smoke.tauri_driver(args.driver, args.port, str(args.out/'data')) as start:
            d=start(); test=Safety(args,d,report)
            test.wait("return document.querySelector('.document-bar')!==null",timeout=60)
            window=test.command(args.xdotool,'search','--onlyvisible','--name','^geul$').split()[-1]
            test.command(args.xdotool,'windowfocus','--sync',window)
            identity=test.async_js("return await(await fetch('/rhwp/BUILD.json')).json()")
            assert identity['ok']; report['rhwpIdentity']=identity['value']
            try:
                if args.phase in ('all','backend'):test.backend_negatives()
                if args.phase in ('all','concurrency'):test.cancellations_and_concurrency()
                if args.phase=='ime':
                    test.open('docx',args.documents/'created.docx')
                    test.new('hwp',args.out/'ime.hwp');test.ready('hwp','ime.hwp')
                if args.phase in ('all','ime'):test.ime_and_failure()
                if args.phase in ('all','export'):test.export_failure()
                if args.phase in ('all','uncertainty'):test.unconfirmed_publication()
                while d.exists('.document-tab__close'):
                    count=d.js("return document.querySelectorAll('.document-tab__close').length")
                    # Native pointer input also avoids WebKitWebDriver's
                    # element-click transport resetting while a failed editor
                    # panel is unmounted; all close assertions still apply.
                    rect=d.js("const r=document.querySelector('.document-tab__close').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}")
                    test.command(args.xdotool,'mousemove','--window',window,str(round(rect['x'])),str(round(rect['y'])))
                    test.command(args.xdotool,'click','1')
                    if d.exists('[data-testid=discard-dialog]'):
                        d.click('[data-testid=discard-confirm]')
                    test.wait("return document.querySelectorAll('.document-tab__close').length<arguments[0]",count)
            except Exception:
                report['failureDom']=d.js("return {status:[...document.querySelectorAll('[data-testid$=status]')].map(e=>({...e.dataset})),focus:document.activeElement?.outerHTML,notice:document.querySelector('footer.statusbar')?.textContent}")
                d.screenshot(args.out/'failure.png')
                raise
            finally:
                d.quit();d=None
        report['status']='PASS'
    except Exception as error:
        report.update(status='FAIL',error=str(error),trace=traceback.format_exc())
    finally:
        report['teardown']=smoke.TEARDOWN
        (args.out/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'status':report['status'],'cases':len(report['negative']),'error':report.get('error')},ensure_ascii=False))
    return 0 if report['status']=='PASS' else 1


if __name__=='__main__':
    sys.exit(main())
