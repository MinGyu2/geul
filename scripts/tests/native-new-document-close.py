#!/usr/bin/env python3
"""Native WM close requests during New, with real backend publication.

A WM_DELETE_WINDOW ClientMessage goes directly to the actual GTK toplevel.
This works under bare Xvfb without an EWMH window manager; windowclose/windowkill
would bypass confirmation and are deliberately not used here.
"""
import argparse
import ctypes
import hashlib
import re
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time
import traceback

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


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['app','out']: parser.add_argument('--'+name,type=Path,required=True)
    for name in ['driver','xdotool','ibus']: parser.add_argument('--'+name,required=True)
    parser.add_argument('--mode',choices=['selection','publication','dirty-selection'],required=True)
    parser.add_argument('--port',type=int,default=4444)
    parser.add_argument('--documents',type=Path)
    args=parser.parse_args();args.out.mkdir(parents=True,exist_ok=False)
    report={'status':'RUNNING','negative':[], 'mode':args.mode,'appSha256':module.native.sha(args.app),'harnessSha256':module.native.sha(__file__),
            'sourceHead':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
            'sourceDiffSha256':hashlib.sha256(subprocess.check_output(['git','diff','HEAD','--','src','src-tauri'],cwd=ROOT)).hexdigest()}
    smoke.APP=str(args.app.resolve());smoke.DRIVER_LOG=args.out/'driver.log'
    d=None
    try:
        with smoke.tauri_driver(args.driver,args.port,str(args.out/'data')) as start:
            d=start(); test=module.Safety(args,d,report)
            test.wait("return document.querySelector('.document-bar')!==null",timeout=60)
            window=test.command(args.xdotool,'search','--onlyvisible','--name','^geul$').split()[-1]
            test.command(args.xdotool,'windowfocus','--sync',window)
            identity=test.async_js("return await(await fetch('/rhwp/BUILD.json')).json()")
            assert identity['ok']; report['rhwpIdentity']=identity['value']
            test.workspace()
            test.async_js("window.__ndCloseObserved=0;window.__ndStopClose=await window.__ndWorkspace.windowClose.listen(()=>window.__ndCloseObserved++);return true")
            path=args.out/'closing.docx'
            original_hash=None
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
                test.new('docx',path)
                test.wait('return window.__ndPending===true')
            assert not path.exists()
            # Observe the same app PIDs until they exit; never kill a user app.
            pids=set(smoke.app_processes())
            assert pids
            request_native_close(args.xdotool,window)
            if args.mode=='dirty-selection':
                test.wait("return document.querySelector('[data-testid=discard-dialog]')!==null")
                report['modalDiagnostic']=d.js("return {count:document.querySelectorAll('[aria-modal=true]').length,focus:document.activeElement?.textContent}")
                assert report['modalDiagnostic']['count']==1,'new-format dialog must yield to window-close confirmation'
                d.click('[data-testid=discard-cancel]')
                test.wait("return document.querySelector('[data-testid=new-document-dialog]')!==null")
                assert d.js("return document.querySelector('input[name=new-document-format]:checked')?.value")=='hwpx'
                request_native_close(args.xdotool,window)
                test.wait("return document.querySelector('[data-testid=discard-dialog]')!==null")
                # Confirm with native keys: a WebDriver click response can race
                # the successful destruction of its own browsing context.
                test.key('Tab','Return')
            if args.mode=='publication':
                test.wait("return window.__ndCloseObserved>0 && window.__ndWorkspace.windowClosing===true")
                test.resume()
            deadline=time.monotonic()+20
            while pids.intersection(smoke.app_processes()) and time.monotonic()<deadline:
                time.sleep(.1)
            if pids.intersection(smoke.app_processes()):
                report['closeDiagnostic']=d.js("return {events:window.__ndCloseObserved,closing:window.__ndWorkspace.windowClosing,busy:window.__ndWorkspace.fileBusy,dialog:!!document.querySelector('[aria-modal=true]')}")
                raise AssertionError('native close did not complete')
            assert path.exists()==(args.mode=='publication')
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
        report.update(status='FAIL',error=str(error),trace=traceback.format_exc())
    finally:
        report['teardown']=smoke.TEARDOWN
        (args.out/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'status':report['status'],'mode':args.mode,'error':report.get('error')}))
    return 0 if report['status']=='PASS' else 1


if __name__=='__main__':sys.exit(main())
