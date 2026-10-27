"""T010 rhwp formatting in the real app (test-activation build only; never a product activation).

Real tauri app + WebKitGTK + X11 keys (xdotool) on generated basic-ko fixtures. HWPX: Shift+Right selection, Ctrl+B,
Ctrl+Z/Ctrl+Y, ribbon italic button, Ctrl+S save, then the saved file is reopened in a fresh engine instance and its
character properties are read. HWP: the same keys/button must change nothing. Process scope: child subreaper.
"""
import base64,hashlib,importlib.util,json,os,select,shlex,shutil,socket,subprocess,sys,tempfile,time,urllib.request,uuid
from pathlib import Path
root=Path(__file__).resolve().parents[5]
sys.path[:0]=[str(root/'tests/e2e'),str(root/'tests/integration/rhwp'),str(root/'tests/integration/rhwp/ownership-poc')]
import process_scope
scope=process_scope.Scope().enable()
import tauri_smoke as smoke, rhwp_poc as poc, native_probe
helper_spec=importlib.util.spec_from_file_location('geul_smoke_verdict',root/'tests/integration/rhwp/ownership-poc/smoke_verdict.py')
helper=importlib.util.module_from_spec(helper_spec); helper_spec.loader.exec_module(helper)
raw=Path(os.environ['GEUL_SMOKE_RAW']).resolve(); raw.mkdir(parents=True,exist_ok=False); out=raw/'format.json'
xvfb=os.environ['GEUL_XVFB']; xdotool=os.environ['GEUL_XDOTOOL']; webkit=os.environ['GEUL_WEBKIT_DRIVER']; driver=os.environ['GEUL_TAURI_DRIVER']; dbus=os.environ['GEUL_DBUS_DAEMON']
candidate=Path(os.environ['GEUL_T010_CANDIDATE']); gates=Path(os.environ['GEUL_T010_EVIDENCE']); app=root/'src-tauri/target/debug/geul'
result={'status':'FAIL','stage':'preflight','official':False,'kind':'T010 rhwp format commands native','failures':[],'attemptId':uuid.uuid4().hex,'checks':{},'cleanup':{},'observations':{}}
teardown_start=len(smoke.TEARDOWN); owned=[]
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
result['sourceSha256']={'runner':sha(__file__),'session':sha(root/'src/components/Editor/rhwp/RhwpEditorSession.ts'),'registry':sha(root/'src/commands/registry.ts'),'text':sha(root/'src/components/Editor/rhwp/rhwpText.ts')}
def port():
 with socket.socket() as s: s.bind(('127.0.0.1',0)); return s.getsockname()[1]
def key(*keys): subprocess.run(['env','-u','LD_LIBRARY_PATH',xdotool,'key','--delay','40',*keys],check=True,capture_output=True,timeout=10); time.sleep(.25)
def check(name,ok,detail=None):
 result['checks'][name]=bool(ok)
 if detail is not None: result['observations'][name]=detail
HOOK=r"""
  p.charAt=(s,para,o)=>{if(!active)throw Error('no active document');const v=JSON.parse(active.getCharPropertiesAt(s,para,o));return {bold:v.bold,italic:v.italic,underline:v.underline,strikethrough:v.strikethrough};};
  p.reopenChars=(b64,offsets)=>{const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));const d=new mod.HwpDocument(bytes);
    try{return {format:d.getSourceFormat(),chars:offsets.map(o=>{const v=JSON.parse(d.getCharPropertiesAt(0,0,o));return {bold:v.bold,italic:v.italic};})};}finally{d.free();}};
"""
try:
 if sha(app)!='0fda84b2f91f686c26b235a48250e70892d4f16e9fd66d974f8c621a67c116cd': raise RuntimeError('app identity mismatch')
 if sha(candidate/'rhwp_bg.wasm')!='0cb73f70cd98dbef89718534e1bc283f1cb4c200af200703d40b137be1cde956': raise RuntimeError('candidate mismatch')
 with socket.socket() as s: s.bind(('127.0.0.1',1420))
 with tempfile.TemporaryDirectory(prefix='geul-format-native-') as td:
  work=Path(td); fixtures=work/'fixtures'; subprocess.run(['node',str(root/'tests/fixtures/rhwp/generate.mjs'),str(fixtures)],check=True,timeout=30,capture_output=True)
  for k in ('XDG_CONFIG_HOME','XDG_CACHE_HOME','TMPDIR','XDG_RUNTIME_DIR'):
   (work/k).mkdir(mode=0o700); os.environ[k]=str(work/k)
  os.environ.update({'VITE_GEUL_TEST_HOOKS':'1','GEUL_T010_OWNERSHIP_POC':'1','GEUL_T010_SCHEDULER_POC':'1','GEUL_T010_CANDIDATE':str(candidate),'GEUL_T010_EVIDENCE':str(gates),
                     'VITE_GEUL_TEST_RHWP_HISTORY':'1','GEUL_T010_HISTORY_SAFETY_ONLY':'1','VITE_GEUL_TEST_RHWP_FORMAT':'1',
                     'WEBKIT_DISABLE_DMABUF_RENDERER':'1','LIBGL_ALWAYS_SOFTWARE':'1','GDK_BACKEND':'x11','WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS':'1','NO_AT_BRIDGE':'1','GTK_A11Y':'none'})
  os.environ['PATH']=str(Path(webkit).parent)+os.pathsep+os.environ['PATH']
  bus=subprocess.Popen([dbus,'--session','--nofork','--nopidfile','--print-address=1'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True);owned.append(bus)
  try:
   if not select.select([bus.stdout],[],[],10)[0]: raise RuntimeError('dbus timeout')
   os.environ['DBUS_SESSION_BUS_ADDRESS']=bus.stdout.readline().strip()
   display=subprocess.Popen([xvfb,'-displayfd','1','-screen','0','1280x1024x24','-nolisten','tcp'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True);owned.append(display)
   try:
    if not select.select([display.stdout],[],[],10)[0]: raise RuntimeError('Xvfb timeout')
    os.environ['DISPLAY']=':'+display.stdout.readline().strip()
    log=(raw/'vite.log').open('xb');vite=subprocess.Popen(['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--config','tests/integration/rhwp/ownership-poc/vite.config.mjs'],cwd=root,env=os.environ,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);owned.append(vite)
    try:
     deadline=time.monotonic()+30
     while True:
      if vite.poll() is not None: raise RuntimeError('vite exited')
      try:
       with urllib.request.urlopen('http://localhost:1420',timeout=1) as r:
        if r.status==200: break
      except OSError:
       if time.monotonic()>deadline: raise RuntimeError('vite timeout')
       time.sleep(.1)
     a,b=port(),port()
     while b==a: b=port()
     wrapper=work/'driver-wrapper';wrapper.write_text('#!/bin/sh\nexec '+shlex.quote(driver)+' --native-port '+str(b)+' "$@"\n');wrapper.chmod(0o700)
     smoke.APP=str(app);smoke.DRIVER_LOG=str(raw/'driver.log')
     with smoke.tauri_driver(str(wrapper),a,str(work/'data')) as start:
      d=start()
      try:
       result['stage']='hwpx-open'
       smoke.wait_until(d,"return !!document.querySelector('.document-bar__open')",timeout=30)
       doc=work/'format.hwpx'; shutil.copy(fixtures/'basic-ko.hwpx',doc); original=sha(doc)
       poc.open_document(d,doc)
       probe=native_probe.INSTALL.replace("import('/rhwp/rhwp.js')",'Promise.resolve(window.__geulOwnership.probeEngine())')
       marker="  p.owners = () =>"
       if marker not in probe: raise RuntimeError('probe boundary changed')
       native_probe.install(d,probe.replace(marker,HOOK+marker,1))
       windows=subprocess.check_output([xdotool,'search','--onlyvisible','--name','^geul'],text=True,timeout=10).split();subprocess.run([xdotool,'windowfocus','--sync',windows[-1]],check=True,timeout=10)
       d.native_key_tool=xdotool
       poc.click_paragraph_start(d); key('Home')
       chars=lambda: [d.js('return window.__rhwpProbe.charAt(0,0,arguments[0])',o) for o in (0,1,2,3)]
       initial=chars(); s0=poc.status(d)
       check('noSelectionDisabled',all(poc.command_button(d,c)['disabled'] for c in ('format.bold','format.italic','format.underline','format.strikethrough')))
       key('shift+Right','shift+Right','shift+Right')
       bold_state=poc.command_button(d,'format.bold')
       check('selectionEnabled',not bold_state['disabled'] and bold_state['pressed']=='false',bold_state)
       result['stage']='ctrl-b'
       key('ctrl+b'); smoke.wait_until(d,"const e=document.querySelector('[data-testid=rhwp-status]');return e&&Number(e.dataset.localRevision)===Number(arguments[0])+1&&e.dataset.revision===e.dataset.localRevision",s0['localRevision'],timeout=20)
       after_b=chars(); s1=poc.status(d)
       check('ctrlBoldApplied',[c['bold'] for c in after_b]==[True,True,True,False] and [c['bold'] for c in initial]==[False]*4,{'before':initial,'after':after_b})
       check('textUnchanged',s1.get('paragraphText')==s0.get('paragraphText') and s1.get('dirty')=='true',{k:s1.get(k) for k in ('revision','localRevision','dirty')})
       check('pressedAfterBold',poc.command_button(d,'format.bold')['pressed']=='true')
       result['stage']='undo-redo'
       key('ctrl+z'); time.sleep(.5); undone=chars()
       key('ctrl+y'); time.sleep(.5); redone=chars()
       check('undoRedoFormat',[c['bold'] for c in undone][:3]==[False]*3 and [c['bold'] for c in redone][:3]==[True]*3,{'undone':undone,'redone':redone})
       result['stage']='ribbon-italic'
       key('Home'); key('shift+Right','shift+Right','shift+Right')
       rev=poc.status(d)['localRevision']
       poc.press_button(d,'[data-command="format.italic"]')
       smoke.wait_until(d,"const e=document.querySelector('[data-testid=rhwp-status]');return e&&Number(e.dataset.localRevision)===Number(arguments[0])+1&&e.dataset.revision===e.dataset.localRevision",rev,timeout=20)
       ital=chars()
       check('ribbonItalicApplied',[c['italic'] for c in ital]==[True,True,True,False] and [c['bold'] for c in ital][:3]==[True]*3,ital)
       result['stage']='save'
       d.js("document.querySelector('.rhwp-input').focus()"); key('ctrl+s')
       smoke.wait_until(d,f"const e=document.querySelector('{poc.SAVE_RESULT}'); return e && ['saved','failed'].includes(e.dataset.state)",timeout=60)
       saved=d.js(f"return {{...document.querySelector('{poc.SAVE_RESULT}').dataset}}"); s2=poc.status(d)
       check('saved',saved.get('state')=='saved' and s2.get('dirty')=='false' and sha(doc)!=original,{'save':saved,'dirty':s2.get('dirty')})
       reopened=d.js('return window.__rhwpProbe.reopenChars(arguments[0],[0,1,2,3])',base64.b64encode(doc.read_bytes()).decode())
       check('savedFileReopenedWithFormat',reopened['format']=='hwpx' and [(c['bold'],c['italic']) for c in reopened['chars']]==[(True,True)]*3+[(False,False)],reopened)
       result['savedSha256']=sha(doc)
       check('hwpxClosed',poc.close_tab(d,doc.name))
       result['stage']='hwp'
       hdoc=work/'format.hwp'; shutil.copy(fixtures/'basic-ko.hwp',hdoc); horiginal=sha(hdoc)
       poc.open_document(d,hdoc); poc.click_paragraph_start(d); key('Home'); key('shift+Right','shift+Right','shift+Right')
       hs0=poc.status(d); hstates={c:poc.command_button(d,c) for c in ('format.bold','format.italic')}
       key('ctrl+b'); time.sleep(.8)
       poc.press_button(d,'[data-command="format.italic"]'); time.sleep(.5)
       hs1=poc.status(d); hchars=chars()
       keep=('revision','localRevision','dirty','paragraphText')
       check('hwpUnchanged',all(hstates[c]['disabled'] for c in hstates) and all(hs0.get(k)==hs1.get(k) for k in keep)
             and not any(c['bold'] or c['italic'] for c in hchars) and sha(hdoc)==horiginal,{'states':hstates,'before':{k:hs0.get(k) for k in keep},'after':{k:hs1.get(k) for k in keep}})
       check('hwpClosed',poc.close_tab(d,hdoc.name))
       result['stage']='shutdown'
      finally:
       smoke.end_session(d)
     helper.attach_teardown(result,smoke.TEARDOWN,teardown_start)
    finally:
     helper.stop_owned(vite,'vite',result); log.close()
   finally:
    helper.stop_owned(display,'xvfb',result)
  finally:
   helper.stop_owned(bus,'dbus',result)
except Exception as e:
 helper.attach_teardown(result,smoke.TEARDOWN,teardown_start); helper.failure(result,result['stage'],e)
finally:
 rec=scope.teardown(owned_pids=[p.pid for p in owned]); result['processScope']=rec
 if not rec['cleanupSucceeded']: helper.failure(result,'process-scope',RuntimeError('scope cleanup incomplete'))
 complete=bool(result['checks']) and all(result['checks'].values())
 ok=helper.finalize(result,complete)
 result['status']='PASS' if ok and complete and rec['cleanupSucceeded'] and not result['failures'] else 'FAIL'
 result['readinessVerdict']='test-activation build only; no product activation'
 helper.persist_result(result,out)
 print(json.dumps({k:result.get(k) for k in ('status','stage','failures','checks','cleanupStatus')},ensure_ascii=False))
sys.exit(0 if result['status']=='PASS' else 1)
