#!/usr/bin/env python3
"""Native WM close requests during New, with real backend publication.

A WM_DELETE_WINDOW ClientMessage goes directly to the actual GTK toplevel.
Mode unconfirmed-publication publishes for real but marks the frontend response
dirty (simulated unconfirmed durability; the Rust session is actually durable).
Real directory-fsync failure is only injected by Rust unit tests (Fault::DirSync).
Mode restore-unopened uses a real DOCX recovery checkpoint, real Rust restore
publication and a real session-capacity open failure; only the destination
chooser result is supplied by the harness.
This works under bare Xvfb without an EWMH window manager; windowclose/windowkill
would bypass confirmation and are deliberately not used here.
"""
import argparse
import ctypes
import hashlib
import re
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback

from native_close_results import finalize

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('new_safety', ROOT/'scripts/tests/native-new-document-safety.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
smoke = module.smoke


def request_native_close(xdotool, window):
    # Resolve the same installed X11 library as the real XTest input client.
    libraries=subprocess.check_output(['ldd',xdotool],text=True)
    match=re.search(r'libX11\.so\.6 => (\S+)',libraries)
    assert match, 'installed X11 client library unavailable'
    x11=ctypes.CDLL(match[1])
    x11.XOpenDisplay.restype=ctypes.c_void_p
    x11.XInternAtom.argtypes=[ctypes.c_void_p,ctypes.c_char_p,ctypes.c_int];x11.XInternAtom.restype=ctypes.c_ulong
    x11.XSendEvent.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_int,ctypes.c_long,ctypes.c_void_p]
    x11.XFlush.argtypes=[ctypes.c_void_p];x11.XCloseDisplay.argtypes=[ctypes.c_void_p]
    class Data(ctypes.Union):
        _fields_=[('b',ctypes.c_char*20),('s',ctypes.c_short*10),('l',ctypes.c_long*5)]
    class Client(ctypes.Structure):
        _fields_=[('type',ctypes.c_int),('serial',ctypes.c_ulong),('send_event',ctypes.c_int),
                  ('display',ctypes.c_void_p),('window',ctypes.c_ulong),('message_type',ctypes.c_ulong),
                  ('format',ctypes.c_int),('data',Data)]
    class Event(ctypes.Union):
        _fields_=[('client',Client),('pad',ctypes.c_long*24)]
    display=x11.XOpenDisplay(None);assert display
    try:
        event=Event();event.client.type=33;event.client.window=int(window);event.client.display=display
        event.client.message_type=x11.XInternAtom(display,b'WM_PROTOCOLS',False);event.client.format=32
        event.client.data.l[0]=x11.XInternAtom(display,b'WM_DELETE_WINDOW',False);event.client.data.l[1]=0
        assert x11.XSendEvent(display,int(window),False,0,ctypes.byref(event))!=0
        x11.XFlush(display)
    finally:x11.XCloseDisplay(display)


def restore_unopened(args,d,test,report,window):
    import shutil
    source=args.out/'edited.docx';shutil.copyfile(args.documents/'created.docx',source)
    test.open('docx',source)
    test.engine('xkb:us::eng');test.key('End');test.type(' recover')
    test.wait("return window.__ndWorkspace.recoveryCheckpointStatuses.some(s=>s.kind==='protected')",timeout=60)
    listed=test.async_js("return await window.__TAURI_INTERNALS__.invoke('recovery_list')")
    assert listed['ok'] and len(listed['value'])==1,listed
    candidate={k:listed['value'][0].get(k) for k in ['id','valid','name','revision','format','createdAt','stale']}
    # Fill the real registry to its 64-session capacity so the restored file cannot be opened.
    count=len(test.sessions());fill=[]
    while count<64:
        target=args.out/f'capacity-{count}.docx'
        response=test.async_js("return await window.__TAURI_INTERNALS__.invoke('document_new',Uint8Array.from(atob(arguments[0]),c=>c.charCodeAt(0)))",
            __import__('base64').b64encode(b'GNC1'+__import__('struct').pack('<I',len(m:=json.dumps({'path':str(target),'format':'docx','contentLoss':None}).encode()))+m).decode())
        assert response['ok'],response;fill.append(response['value']['sessionId']);count+=1
    restored=args.out/'restored.docx'
    d.js("""const w=window.__ndWorkspace;window.__ndRestore=w.recoveryPort.restore;window.__ndRestorePending=false;
    w.filePort.chooseFile=async()=>({ok:true,value:arguments[0]});
    w.recoveryPort.restore=(...a)=>{window.__ndRestorePending=true;return new Promise((resolve,reject)=>{
      window.__ndRestoreResume=()=>{window.__ndRestorePending=false;window.__ndRestore.apply(w.recoveryPort,a).then(resolve,reject)}})};
    window.__ndRestoreResult=null;w.restoreRecovery(arguments[1],{title:'r',accept:'r',cancel:'c'}).then(r=>window.__ndRestoreResult=r);""",str(restored),candidate)
    test.wait('return window.__ndRestorePending===true')
    assert not restored.exists()
    pids=set(smoke.app_processes())
    # The edited tab is unpreserved: confirm the window close, which then waits for the restore.
    request_native_close(args.xdotool,window)
    test.wait("return document.querySelector('[data-testid=discard-dialog]')!==null")
    test.key('Tab','Return')
    test.wait("return window.__ndWorkspace.windowClosing===true && window.__ndWorkspace.fileBusy===true")
    d.js('window.__ndRestoreResume()')
    test.wait('return window.__ndRestoreResult!==null')
    result=d.js('return window.__ndRestoreResult')
    assert result=={'ok':False,'error':{'code':'RestoredUnopened','cause':{'code':'ResourceLimit','limit':'session-count'}}},result
    time.sleep(1)
    assert pids.issubset(set(smoke.app_processes())),'window destroyed on a stale close decision after restore publication'
    assert restored.is_file() and len(test.sessions())==64
    state=d.js("const w=window.__ndWorkspace;return {closing:w.windowClosing,busy:w.fileBusy,notices:w.publicationNoticeCount,dialogs:document.querySelectorAll('[aria-modal=true]').length}")
    assert state=={'closing':False,'busy':False,'notices':1,'dialogs':0},state
    listed=test.async_js("return await window.__TAURI_INTERNALS__.invoke('recovery_list')")
    assert listed['ok'] and [c['id'] for c in listed['value']]==[candidate['id']],'recovery candidate must remain'
    report['negative'].append({'case':'recovery restore published, open failed during confirmed close','status':'PASS','published':True,
        'openFailure':'real ResourceLimit session-count','windowRetained':True,'candidateRetained':True,'chooser':'harness-supplied path'})
    request_native_close(args.xdotool,window)
    test.wait("return document.querySelector('[data-testid=discard-dialog]')!==null")
    assert d.js("return document.querySelectorAll('[aria-modal=true]').length")==1
    test.key('Tab','Return')
    deadline=time.monotonic()+20
    while pids.intersection(smoke.app_processes()) and time.monotonic()<deadline:time.sleep(.1)
    assert not pids.intersection(smoke.app_processes()),'second confirmed close did not complete'
    assert restored.is_file()
    report['negative'].append({'case':'next confirmed close after the notice','status':'PASS','appExited':True,'fileRetained':True})


def recovery_files(args):
    root=args.out/'data'  # tauri-driver app data directory owned by this run
    return {str(p.relative_to(root)):module.native.sha(p) for p in sorted(root.rglob('*')) if p.is_file() and 'recovery' in p.parts}


def checkpoint_candidate(args,d,test):
    import shutil
    source=args.out/'edited.docx';shutil.copyfile(args.documents/'created.docx',source)
    original=module.native.sha(args.documents/'created.docx')
    test.open('docx',source)
    test.engine('xkb:us::eng');test.key('End');test.type(' recover')
    test.wait("return window.__ndWorkspace.recoveryCheckpointStatuses.some(s=>s.kind==='protected')",timeout=60)
    listed=test.async_js("return await window.__TAURI_INTERNALS__.invoke('recovery_list')")
    assert listed['ok'] and len(listed['value'])==1,listed
    candidate={k:listed['value'][0].get(k) for k in ['id','valid','name','revision','format','createdAt','stale']}
    store_before=recovery_files(args);assert store_before,'recovery store not found'
    return candidate,store_before,original


def finish_confirmed_close(args,d,test,report,window,pids,restored,store_before,original):
    deadline=time.monotonic()+20
    while pids.intersection(smoke.app_processes()) and time.monotonic()<deadline:time.sleep(.1)
    assert not pids.intersection(smoke.app_processes()),'confirmed close did not complete after the chooser'
    assert not restored.exists(),'restore published after a confirmed window close'
    assert recovery_files(args)==store_before,'recovery store changed'
    assert module.native.sha(args.documents/'created.docx')==original


def restore_chooser_injected(args,d,test,report,window):
    # Real Tauri close request/destroy, real restore/open ports; only the chooser response is injected.
    candidate,store_before,original=checkpoint_candidate(args,d,test)
    restored=args.out/'restored.docx'
    d.js("""const w=window.__ndWorkspace;window.__ndChooserCalls=0;
    w.filePort.chooseFile=()=>{window.__ndChooserCalls++;return new Promise(resolve=>{window.__ndChoose=resolve})};
    window.__ndRestoreResult='pending';w.restoreRecovery(arguments[0],{title:'r',accept:'r',cancel:'c'}).then(r=>window.__ndRestoreResult=r)""",candidate)
    test.wait('return window.__ndChooserCalls===1')
    pids=set(smoke.app_processes())
    request_native_close(args.xdotool,window)
    test.wait("return document.querySelector('[data-testid=discard-dialog]')!==null")
    assert d.js("return document.querySelectorAll('[aria-modal=true]').length")==1
    test.key('Tab','Return')
    test.wait("return window.__ndWorkspace.windowClosing===true && window.__ndWorkspace.fileBusy===true")
    assert pids.issubset(set(smoke.app_processes())),'window destroyed while the chooser was pending'
    # Resolve after this WebDriver call returns: the corrected close then destroys the browsing context.
    d.js('const v=arguments[0];setTimeout(()=>window.__ndChoose({ok:true,value:v}),100)',str(restored))
    finish_confirmed_close(args,d,test,report,window,pids,restored,store_before,original)
    report['negative'].append({'case':'confirmed close while restore chooser pending (injected chooser response)','status':'PASS',
        'chooser':'test-injected response','closeRequest':'real WM_DELETE_WINDOW','published':False,'recoveryStoreUnchanged':True,'appExited':True})


def restore_already_open(args,d,test,report,window):
    # Real restore publication and real document_open; between them the harness acts as an external
    # process replacing the destination with a symlink to the already-open edited document.
    candidate,store_before,original=checkpoint_candidate(args,d,test)
    restored=args.out/'restored.docx';source=args.out/'edited.docx'
    before=d.js("const w=window.__ndWorkspace;return {sessions:w.sessions.snapshot().sessions.map(s=>s.sessionId),active:w.sessions.snapshot().activeId}")
    d.js("""const w=window.__ndWorkspace;window.__ndOpen=w.backend.open;window.__ndOpenHeld=false;
    w.filePort.chooseFile=async()=>({ok:true,value:arguments[0]});
    w.backend.open=(...a)=>{window.__ndOpenHeld=true;return new Promise((resolve,reject)=>{
      window.__ndOpenResume=()=>{w.backend.open=window.__ndOpen;window.__ndOpen.apply(w.backend,a).then(resolve,reject)}})};
    window.__ndRestoreResult='pending';w.restoreRecovery(arguments[1],{title:'r',accept:'r',cancel:'c'}).then(r=>window.__ndRestoreResult=r)""",str(restored),candidate)
    test.wait('return window.__ndOpenHeld===true')
    assert restored.is_file(),'restore did not publish'
    published=module.native.sha(restored)
    restored.unlink();restored.symlink_to(source)
    d.js('window.__ndOpenResume()')
    test.wait('return window.__ndRestoreResult!=="pending"')
    result=d.js('return window.__ndRestoreResult')
    assert result['ok'] is False and result['error']['code']=='RestoredUnopened' and result['error']['cause']['code']=='AlreadyOpen',result
    assert result['error']['cause']['sessionId'] in before['sessions'],result
    after=d.js("const w=window.__ndWorkspace;return {sessions:w.sessions.snapshot().sessions.map(s=>s.sessionId),active:w.sessions.snapshot().activeId,notices:w.publicationNoticeCount}")
    assert after=={**before,'notices':1},after
    assert recovery_files(args)==store_before and module.native.sha(args.documents/'created.docx')==original
    report['negative'].append({'case':'AlreadyOpen after restore (external symlink replacement before document_open)','status':'PASS',
        'publishedSha256':published,'alreadyOpen':'real Rust registry','adopted':False,'activeTabUnchanged':True,'noticeCount':1})
    pids=set(smoke.app_processes())
    request_native_close(args.xdotool,window)
    test.wait("return document.querySelector('[data-testid=discard-dialog]')!==null")
    test.key('Tab','Return')
    deadline=time.monotonic()+20
    while pids.intersection(smoke.app_processes()) and time.monotonic()<deadline:time.sleep(.1)
    assert not pids.intersection(smoke.app_processes())


def restore_chooser(args,d,test,report,window):
    # Real GTK destination chooser; the window-close request is a real WM_DELETE_WINDOW. The verdict
    # (chooser_close_verdict.classify) is scoped to this X11/Xvfb run, this chooser and these intervals.
    spec=importlib.util.spec_from_file_location('chooser_close_verdict',ROOT/'scripts/tests/chooser_close_verdict.py')
    verdicts=importlib.util.module_from_spec(spec);spec.loader.exec_module(verdicts)
    interval=5.0
    candidate,store_before,original=checkpoint_candidate(args,d,test)
    restored=args.out/'restored.docx'
    count="return Number.isInteger(window.__ndCloseObserved)?window.__ndCloseObserved:null"
    dialog="return document.querySelector('[data-testid=discard-dialog]')!==null"
    obs={'observerInstalled':d.js("return typeof window.__ndStopClose==='function' && Number.isInteger(window.__ndCloseObserved)"),
         'requestSent':False,'intervalSeconds':interval}
    d.js("window.__ndRestoreResult='pending';window.__ndWorkspace.restoreRecovery(arguments[0],{title:'복구 사본을 새 파일로 복원',accept:'복원',cancel:'취소'}).then(r=>window.__ndRestoreResult=r,e=>window.__ndRestoreResult={thrown:String(e)})",candidate)
    deadline=time.monotonic()+15;chooser=''
    while time.monotonic()<deadline and not chooser:
        found=subprocess.run([args.xdotool,'search','--onlyvisible','--name','^복구 사본을 새 파일로 복원$'],capture_output=True,text=True)
        chooser=found.stdout.split()[-1] if found.returncode==0 and found.stdout.strip() else '';time.sleep(.1)
    assert chooser,'native GTK chooser not visible'
    pids=set(smoke.app_processes())
    obs['before']=d.js(count)
    request_native_close(args.xdotool,window)  # asserts XSendEvent accepted the client message
    obs['requestSent']=True

    def observe(baseline):
        # Bounded: stop early only on a delivery signal; otherwise watch the whole interval.
        end=time.monotonic()+interval;seen=False
        while time.monotonic()<end:
            value=d.js(count);seen=d.js(dialog)
            if type(seen) is not bool or seen or value is None or (isinstance(baseline,int) and value!=baseline):break
            time.sleep(.2)
        return d.js(count),seen if type(seen) is not bool else (seen or d.js(dialog))

    obs['during'],obs['dialogDuring']=observe(obs['before'])
    obs['busyDuring']=d.js('return window.__ndWorkspace.fileBusy')
    if not (obs['during']!=obs['before'] or obs['dialogDuring']):
        test.command(args.xdotool,'windowfocus','--sync',chooser);test.key('Escape')
        test.wait('return window.__ndRestoreResult!=="pending"')
        obs['afterCancel'],obs['dialogAfterCancel']=observe(obs['during'])
        obs['restoreResult']=d.js('return window.__ndRestoreResult')
    obs['published']=restored.exists()
    obs['appAlive']=pids.issubset(set(smoke.app_processes()))
    obs['recoveryStoreUnchanged']=recovery_files(args)==store_before
    result,reason=verdicts.classify(obs)
    report['chooserCloseDelivery']={**obs,'verdict':result,'reason':reason,
        'scope':'X11/Xvfb, gtk::FileChooserNative modal run(), bounded observation of the frontend close listener'}

    if result==verdicts.NOT_REACHABLE:
        assert obs['recoveryStoreUnchanged'] and module.native.sha(args.documents/'created.docx')==original
        # Positive control: the same observer sees exactly one event for the next explicit close request,
        # so the zero delta above was not a dead observation channel.
        baseline=d.js(count)
        request_native_close(args.xdotool,window)
        test.wait(dialog)
        control=d.js(count)
        report['chooserCloseDelivery']['positiveControl']={'before':baseline,'after':control}
        assert control==baseline+1,report['chooserCloseDelivery']['positiveControl']
        report['negative'].append({'case':'WM close while the real GTK restore chooser is open','status':verdicts.NOT_REACHABLE,
            'observation':reason,'published':False,'positiveControlDelta':1})
        assert d.js("return document.querySelectorAll('[aria-modal=true]').length")==1
        test.key('Tab','Return')
        deadline=time.monotonic()+20
        while pids.intersection(smoke.app_processes()) and time.monotonic()<deadline:time.sleep(.1)
        assert not pids.intersection(smoke.app_processes())
        return
    if result==verdicts.DELIVERED_DURING and obs['dialogDuring'] and obs['busyDuring']:
        # The reachable transition: confirm the prompt, then complete the real chooser.
        report['chooserCloseDelivery']['transitionAttempted']=True
        report['closeDuringChooser']=d.js("return {dialogs:document.querySelectorAll('[aria-modal=true]').length,busy:window.__ndWorkspace.fileBusy,kind:document.querySelector('[data-testid=discard-dialog]')?.dataset.windowKind}")
        assert report['closeDuringChooser']['dialogs']==1,report['closeDuringChooser']
        d.js("document.querySelector('[data-testid=discard-confirm]').click()")  # GTK chooser holds keyboard focus
        test.wait("return window.__ndWorkspace.windowClosing===true && window.__ndWorkspace.fileBusy===true")
        assert pids.issubset(set(smoke.app_processes())),'window destroyed while the chooser was pending'
        test.command(args.xdotool,'windowfocus','--sync',chooser)
        test.key('ctrl+l','ctrl+a');test.type(str(restored));test.key('Return')
        finish_confirmed_close(args,d,test,report,window,pids,restored,store_before,original)
        report['chooserCloseDelivery']['transitionVerified']=True
        report['negative'].append({'case':'window close confirmed while the real GTK restore chooser was pending','status':'PASS',
            'chooser':'real GTK; destination typed with XTest','closeRequest':'real WM_DELETE_WINDOW','published':False,'appExited':True})
        return
    # A late delivery, an unexpected state or a missing observation is never native coverage.
    raise AssertionError(f'{result}: {reason}')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['app','out']: parser.add_argument('--'+name,type=Path,required=True)
    for name in ['driver','xdotool','ibus']: parser.add_argument('--'+name,required=True)
    parser.add_argument('--mode',choices=['selection','publication','dirty-selection','unconfirmed-publication','restore-unopened','restore-chooser','restore-chooser-injected','restore-already-open'],required=True)
    parser.add_argument('--port',type=int,default=4444)
    parser.add_argument('--documents',type=Path)
    parser.add_argument('--build-identity',type=Path,help='recorded build identity; appSha256 must match this binary')
    args=parser.parse_args();args.out.mkdir(parents=True,exist_ok=False)
    report={'status':'RUNNING','negative':[], 'mode':args.mode,'appSha256':module.native.sha(args.app),'harnessSha256':module.native.sha(__file__),
            'verdictClassifierSha256':module.native.sha(ROOT/'scripts/tests/chooser_close_verdict.py'),
            'reportContractSha256':module.native.sha(ROOT/'scripts/tests/native_close_results.py'),
            'sourceHead':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
            'sourceDiffSha256':hashlib.sha256(subprocess.check_output(['git','diff','HEAD','--','src','src-tauri'],cwd=ROOT)).hexdigest()}
    smoke.APP=str(args.app.resolve());smoke.DRIVER_LOG=args.out/'driver.log'
    report['environment']={'displayServer':'X11', 'gdkBackend':os.environ.get('GDK_BACKEND', 'unspecified'),
        'x11DisplayAvailable':bool(os.environ.get('DISPLAY')), 'gtkChooser':'gtk::FileChooserNative modal run()' if args.mode=='restore-chooser' else 'see scenario chooser evidence',
        'observationIntervalSeconds':5.0 if args.mode=='restore-chooser' else None,
        'intervals':['chooser open','after chooser cancellation'] if args.mode=='restore-chooser' else [],
        'scope':'this GTK implementation and X11 environment only; no Wayland/portal claim'}
    report['buildIdentity']={'status':'UNVERIFIED','reason':'no build identity supplied; sourceHead describes the probe checkout'}
    d=None
    phase='setup'
    try:
        if args.build_identity:
            identity=json.loads(args.build_identity.read_text())
            assert identity['appSha256']==report['appSha256'], 'build identity does not match app binary'
            report['buildIdentity']={'status':'MATCHED BINARY','record':identity}
        with smoke.tauri_driver(args.driver,args.port,str(args.out/'data')) as start:
            d=start(); test=module.Safety(args,d,report)
            test.wait("return document.querySelector('.document-bar')!==null",timeout=60)
            window=test.command(args.xdotool,'search','--onlyvisible','--name','^geul$').split()[-1]
            test.command(args.xdotool,'windowfocus','--sync',window)
            identity=test.async_js("return await(await fetch('/rhwp/BUILD.json')).json()")
            assert identity['ok']; report['rhwpIdentity']=identity['value']
            report['environment']['gtkRuntimeLibraries']=sorted({Path(line.split()[-1]).name
                for pid in smoke.app_processes() for line in Path(f'/proc/{pid}/maps').read_text().splitlines()
                if '/libgtk-' in line})
            test.workspace()
            test.async_js("window.__ndCloseObserved=0;window.__ndStopClose=await window.__ndWorkspace.windowClose.listen(()=>window.__ndCloseObserved++);return true")
            phase='native scenario'
            path=args.out/'closing.docx'
            original_hash=None
            if args.mode in ('restore-unopened','restore-chooser','restore-chooser-injected','restore-already-open'):
                {'restore-unopened':restore_unopened,'restore-chooser':restore_chooser,
                 'restore-chooser-injected':restore_chooser_injected,'restore-already-open':restore_already_open}[args.mode](args,d,test,report,window)
                try:d.quit();report['driverDeleteAfterNativeClose']='ok'
                except Exception as error:report['driverDeleteAfterNativeClose']=str(error)
                d=None
            else:
                if args.mode=='dirty-selection':
                    assert args.documents
                    original_hash=module.native.sha(args.documents/'created.docx')
                    test.open('docx',args.documents/'created.docx')
                    test.engine('xkb:us::eng');test.key('End');test.type(' unsaved')
                    test.wait("return document.querySelector('[data-testid=docx-status]')?.dataset.dirty==='true'")
                if args.mode in ('selection','dirty-selection'):
                    test.key('ctrl+n')
                    test.wait("return document.querySelector('[data-testid=new-document-dialog]')!==null")
                    if args.mode=='dirty-selection':test.key('Up')
                else:
                    test.delay('document_new')
                    if args.mode=='unconfirmed-publication':
                        # Wrap the real publication response; the delay hook calls __ndOriginal at resume time.
                        d.js("const o=window.__ndOriginal;window.__ndOriginal=async function(...a){const r=await o.apply(this,a);if(r.ok)r.value={...r.value,dirty:true};return r}")
                    test.new('docx',path)
                    test.wait('return window.__ndPending===true')
                assert not path.exists()
                # Observe the same app PIDs until they exit; never kill a user app.
                pids=set(smoke.app_processes())
                assert pids
                request_native_close(args.xdotool,window)
                if args.mode=='dirty-selection':
                    test.wait("return document.querySelector('[data-testid=discard-dialog]')!==null")
                    report['modalDiagnostic']=d.js("return {count:document.querySelectorAll('[aria-modal=true]').length,focus:document.activeElement?.textContent,kind:document.querySelector('[data-testid=discard-dialog]')?.dataset.windowKind}")
                    assert report['modalDiagnostic']['kind']=='edits',report['modalDiagnostic']
                    assert report['modalDiagnostic']['count']==1,'new-format dialog must yield to window-close confirmation'
                    d.click('[data-testid=discard-cancel]')
                    test.wait("return document.querySelector('[data-testid=new-document-dialog]')!==null")
                    assert d.js("return document.querySelector('input[name=new-document-format]:checked')?.value")=='hwpx'
                    request_native_close(args.xdotool,window)
                    test.wait("return document.querySelector('[data-testid=discard-dialog]')!==null")
                    # Confirm with native keys: a WebDriver click response can race
                    # the successful destruction of its own browsing context.
                    test.key('Tab','Return')
                if args.mode in ('publication','unconfirmed-publication'):
                    test.wait("return window.__ndCloseObserved>0 && window.__ndWorkspace.windowClosing===true")
                    test.resume()
                if args.mode=='unconfirmed-publication':
                    # The close decision predates this publication: the window must stay and ask again.
                    test.wait("return document.querySelector('[data-testid=discard-dialog]')!==null")
                    time.sleep(1)
                    assert pids.issubset(set(smoke.app_processes())),'window destroyed on a stale close decision'
                    report['staleDecisionDiagnostic']=d.js("return {dialogs:document.querySelectorAll('[aria-modal=true]').length,action:document.querySelector('[data-testid=discard-dialog]')?.dataset.action,kind:document.querySelector('[data-testid=discard-dialog]')?.dataset.windowKind,focus:document.activeElement?.dataset.testid??null,closing:window.__ndWorkspace.windowClosing,busy:window.__ndWorkspace.fileBusy,unpreserved:window.__ndWorkspace.hasUnpreservedChanges,tabs:[...document.querySelectorAll('.document-tab__select')].map(e=>e.textContent)}")
                    diag=report['staleDecisionDiagnostic']
                    assert diag['dialogs']==1 and diag['action']=='window' and diag['kind']=='durability' and diag['focus']=='discard-cancel' and not diag['closing'] and diag['unpreserved'],diag
                    assert path.exists() and any('closing.docx' in tab for tab in diag['tabs']),diag
                    d.click('[data-testid=discard-cancel]')
                    test.wait("return document.querySelector('[data-testid=discard-dialog]')===null")
                    assert pids.issubset(set(smoke.app_processes())),'cancel must keep the window'
                    assert d.js("return window.__ndWorkspace.hasUnpreservedChanges")
                    request_native_close(args.xdotool,window)
                    test.wait("return document.querySelector('[data-testid=discard-dialog]')!==null")
                    assert d.js("return document.querySelectorAll('[aria-modal=true]').length")==1
                    test.key('Tab','Return')
                deadline=time.monotonic()+20
                while pids.intersection(smoke.app_processes()) and time.monotonic()<deadline:
                    time.sleep(.1)
                if pids.intersection(smoke.app_processes()):
                    report['closeDiagnostic']=d.js("return {events:window.__ndCloseObserved,closing:window.__ndWorkspace.windowClosing,busy:window.__ndWorkspace.fileBusy,dialog:!!document.querySelector('[aria-modal=true]')}")
                    raise AssertionError('native close did not complete')
                assert path.exists()==(args.mode in ('publication','unconfirmed-publication'))
                if original_hash is not None:
                    assert module.native.sha(args.documents/'created.docx')==original_hash
                    report['originalFileUnchanged']=True
                if path.exists():
                    import zipfile
                    with zipfile.ZipFile(path) as package:
                        assert package.testzip() is None
                        assert 'word/document.xml' in package.namelist()
                report['negative'].append({'case':'window close during '+args.mode,'status':'PASS','nativeClose':'WM_DELETE_WINDOW to actual GTK toplevel',
                                          'published':path.exists(),'appExited':True,'fileRetained':path.exists()})
                # Native destruction can end the WebDriver browsing context first.
                # Record that transport result separately from the observed app exit.
                try:
                    d.quit();report['driverDeleteAfterNativeClose']='ok'
                except Exception as error:
                    report['driverDeleteAfterNativeClose']=str(error)
                d=None
        report['status']='PASS'
    except Exception as error:
        report.update(status='FAIL',error=str(error),trace=traceback.format_exc(),
                      failureKind='assertion' if phase=='native scenario' and isinstance(error,AssertionError) else 'infrastructure', failurePhase=phase)
    finally:
        report['teardown']=smoke.TEARDOWN
        finalize(report)
        (args.out/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({key:report.get(key) for key in ('status','executionStatus','behaviorVerdict','observationValidity','observerControl','coverageCounts','mode','error')}))
    return 0 if report['status']=='PASS' else 1


if __name__=='__main__':sys.exit(main())
