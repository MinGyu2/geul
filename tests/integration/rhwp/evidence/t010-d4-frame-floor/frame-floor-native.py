"""T010 D4 diagnostic: native key -> 3-RAF endpoint with controlled work (not the official producer/gate).

Same app, candidate, env, fixture (basic-ko.hwp, zoom 50) and native X11 xdotool keys as the official
history-perf run. Arms, interleaved in rotated blocks of 10 (30 samples each):
  null    key into a test-only <input> outside the editor; no document, engine, IPC or canvas work
  canvas  same key, and the input handler re-publishes the visible page Canvas exactly like the app's
          publish (full getImageData readback + drawImage of identical pixels); still no engine or IPC
  editor  official-style group start: Right, then 'a' into the real editor (engine, history, render, IPC)
Endpoint identical to undo_native.MEASURE: keydown.timeStamp -> first RAF tick that observes the arm's
marker -> RAF -> RAF(end). Nothing is deducted. Process scope: child subreaper (process_scope.py).
"""
import hashlib,importlib.util,json,math,os,select,shlex,socket,subprocess,sys,tempfile,time,urllib.request,uuid
from pathlib import Path
root=Path(__file__).resolve().parents[5]
sys.path[:0]=[str(root/'tests/e2e'),str(root/'tests/integration/rhwp'),str(root/'tests/integration/rhwp/ownership-poc')]
import process_scope
scope=process_scope.Scope().enable()
import tauri_smoke as smoke, rhwp_poc as poc, native_probe
helper_spec=importlib.util.spec_from_file_location('geul_smoke_verdict',root/'tests/integration/rhwp/ownership-poc/smoke_verdict.py')
helper=importlib.util.module_from_spec(helper_spec); helper_spec.loader.exec_module(helper)
raw=Path(os.environ['GEUL_SMOKE_RAW']).resolve(); raw.mkdir(parents=True,exist_ok=False); out=raw/'frame-floor.json'
xvfb=os.environ['GEUL_XVFB']; xdotool=os.environ['GEUL_XDOTOOL']; webkit=os.environ['GEUL_WEBKIT_DRIVER']; driver=os.environ['GEUL_TAURI_DRIVER']; dbus=os.environ['GEUL_DBUS_DAEMON']
candidate=Path(os.environ['GEUL_T010_CANDIDATE']); gates=Path(os.environ['GEUL_T010_EVIDENCE']); app=root/'src-tauri/target/debug/geul'
ARMS=tuple(os.environ.get('GEUL_FF_ARMS','null,canvas,editor').split(',')); BLOCK=10; BLOCKS=3
result={'status':'FAIL','stage':'preflight','official':False,'kind':'T010 D4 frame-floor diagnostic','failures':[],'attemptId':uuid.uuid4().hex,'samples':[],'cleanup':{},'environment':{},'arms':list(ARMS)}
teardown_start=len(smoke.TEARDOWN); recorded=set(); owned=[]
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
result['sourceSha256']={'runner':sha(__file__),'scope':sha(root/'tests/integration/rhwp/ownership-poc/process_scope.py'),'session':sha(root/'tests/integration/rhwp/ownership-poc/session.mjs')}
def port():
 with socket.socket() as s: s.bind(('127.0.0.1',0)); return s.getsockname()[1]
def pct(values):
 v=sorted(values); n=len(v)
 return {'n':n,**({'p50':v[math.ceil(.5*n)-1],'p95':v[math.ceil(.95*n)-1],'max':v[-1]} if n else {})}

PROBE=r"""
if(!window.__ff){
  const ff=window.__ff={samples:[],arm:null,pending:null,gaps:[]};
  const st=()=>document.querySelector('[data-testid=rhwp-status]');
  const ctl=document.createElement('input');ctl.id='d4-ctl';ctl.setAttribute('aria-label','d4 control');
  Object.assign(ctl.style,{position:'fixed',left:'4px',bottom:'4px',width:'40px',height:'16px',zIndex:2147483647});
  document.body.appendChild(ctl);
  let copy=null;
  const tests={};
  // Diagnostic-only style overrides for the duration of one arm block (removed afterwards).
  const OVERRIDES={cnocaret:'.rhwp-caret,.rhwp-selection,.rhwp-composition{display:none!important}',cnoshadow:'.rhwp-page{box-shadow:none!important}',
    cnoanim:'.rhwp-caret{animation:none!important}',
    clayer:'.rhwp-page__canvas{will-change:transform}',
    cshadowlayer:'.rhwp-page{box-shadow:none!important}.rhwp-page::before{content:"";position:absolute;inset:0;box-shadow:var(--page-shadow);pointer-events:none;z-index:-1}'};
  OVERRIDES.cshadowcomp='.rhwp-page{box-shadow:none!important}.rhwp-page::before{content:"";position:absolute;inset:0;box-shadow:var(--page-shadow);pointer-events:none;z-index:-1;will-change:transform}';
  OVERRIDES.csmall='.rhwp-page{box-shadow:0 1px 3px rgb(15 23 42 / 0.12)!important}';
  OVERRIDES.chard='.rhwp-page{box-shadow:0 1px 0 rgb(15 23 42 / 0.18),0 0 0 1px rgb(15 23 42 / 0.08)!important}';
  OVERRIDES.coutline='.rhwp-page{box-shadow:none!important;outline:1px solid rgb(15 23 42 / 0.12)}';
  for(const k of ['noshadow','layer','shadowlayer','shadowcomp','small','hard','outline'])OVERRIDES['e'+k]=OVERRIDES['c'+k];
  ff.override=arm=>{document.getElementById('d4-override')?.remove();const css=OVERRIDES[arm];if(!css)return null;
    const s=document.createElement('style');s.id='d4-override';s.textContent=css;document.head.appendChild(s);return css;};
  ff.prepareCanvas=()=>{const v=document.querySelectorAll('.rhwp-page__canvas')[0];copy=document.createElement('canvas');copy.width=v.width;copy.height=v.height;copy.getContext('2d').drawImage(v,0,0);
    // Attached test canvases of the same extent next to the page (same paint area class, no engine).
    for(const [name,opts] of [['tdefault',undefined],['twrf',{willReadFrequently:true}]]){const c=document.createElement('canvas');c.width=v.width;c.height=v.height;
      Object.assign(c.style,{position:'fixed',right:'4px',top:name==='twrf'?'300px':'4px',width:(v.width/devicePixelRatio)+'px',height:(v.height/devicePixelRatio/2)+'px'});
      document.body.appendChild(c);const x=c.getContext('2d',opts);x.drawImage(copy,0,0);tests[name]={c,x};}
    return [v.width,v.height];};
  ctl.addEventListener('input',e=>{
    const p=ff.pending;if(!p||p.marker!=null)return;
    const start=performance.now();
    if(ff.arm==='canvas'||(ff.arm[0]==='c'&&ff.arm in OVERRIDES)){const v=document.querySelectorAll('.rhwp-page__canvas')[0],x=v.getContext('2d');x.getImageData(0,0,v.width,v.height);x.drawImage(copy,0,0);}
    if(ff.arm==='pixel'){const v=document.querySelectorAll('.rhwp-page__canvas')[0],x=v.getContext('2d');x.drawImage(copy,0,0,1,1,0,0,1,1);}
    if(ff.arm==='tdefault'||ff.arm==='twrf'){const {c,x}=tests[ff.arm];x.getImageData(0,0,c.width,c.height);x.drawImage(copy,0,0);}
    p.handlerMs=performance.now()-start;p.marker=true;
  });
  window.addEventListener('keydown',e=>{
    if(e.ctrlKey||e.key.length!==1||e.isComposing||!ff.arm)return;
    const key=e.timeStamp,arm=ff.arm,before=st()?.dataset.localRevision;
    const p=ff.pending={arm,key,marker:null,handlerMs:null};
    const tick=()=>{
      const seen=arm[0]==='e'?st()?.dataset.localRevision!==before:p.marker===true;
      if(seen){const observed=performance.now();requestAnimationFrame(()=>{const raf1=performance.now();requestAnimationFrame(()=>{const end=performance.now();
        ff.samples.push({arm,keyToFrame:end-key,observed:observed-key,raf1:raf1-key,end:end-key,handlerMs:p.handlerMs});ff.pending=null;});});}
      else if(performance.now()-key<8000)requestAnimationFrame(tick);
      else {ff.samples.push({arm,keyToFrame:-1});ff.pending=null;}
    };
    requestAnimationFrame(tick);
  },true);
  let last=performance.now();const frame=t=>{ff.gaps.push([ff.arm,t-last]);last=t;if(ff.gaps.length>20000)ff.gaps.shift();requestAnimationFrame(frame);};requestAnimationFrame(frame);
}
"""
try:
 if sha(app)!='0fda84b2f91f686c26b235a48250e70892d4f16e9fd66d974f8c621a67c116cd': raise RuntimeError('app identity mismatch')
 for name,expected in {'rhwp_bg.wasm':'0cb73f70cd98dbef89718534e1bc283f1cb4c200af200703d40b137be1cde956','ENGINE.json':'a9ccd5a2c3fd7fa1cb9be6a810c2d2ec428abc0f917a93630230211d754b6069'}.items():
  if sha(candidate/name)!=expected: raise RuntimeError('candidate identity mismatch '+name)
 if sha(gates/'engine-safety-gates.json')!='618105f865df35bdffdac2b8d164b493201601abf06f6f51d6cee2ec005277e0': raise RuntimeError('gate identity mismatch')
 with socket.socket() as s: s.bind(('127.0.0.1',1420))
 result['environment'].update(loadAverageBefore=os.getloadavg(),cpuAffinity=sorted(os.sched_getaffinity(0)))
 with tempfile.TemporaryDirectory(prefix='geul-frame-floor-') as td:
  work=Path(td); fixtures=work/'fixtures'; subprocess.run(['node',str(root/'tests/fixtures/rhwp/generate.mjs'),str(fixtures)],check=True,timeout=30,capture_output=True)
  doc=fixtures/'basic-ko.hwp'; result['fixtureSha256']=sha(doc)
  for key in ('XDG_CONFIG_HOME','XDG_CACHE_HOME','TMPDIR','XDG_RUNTIME_DIR'):
   (work/key).mkdir(mode=0o700);os.environ[key]=str(work/key)
  os.environ.update({'VITE_GEUL_TEST_HOOKS':'1','GEUL_T010_OWNERSHIP_POC':'1','GEUL_T010_SCHEDULER_POC':'1','GEUL_T010_CANDIDATE':str(candidate),'GEUL_T010_EVIDENCE':str(gates),'VITE_GEUL_TEST_RHWP_HISTORY':'1','GEUL_T010_HISTORY_PERF_ONLY':'1','WEBKIT_DISABLE_DMABUF_RENDERER':'1','LIBGL_ALWAYS_SOFTWARE':'1','GDK_BACKEND':'x11','WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS':'1','NO_AT_BRIDGE':'1','GTK_A11Y':'none'})
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
      if vite.poll() is not None: raise RuntimeError('vite exited before ready')
      try:
       with urllib.request.urlopen('http://localhost:1420',timeout=1) as r:
        if r.status==200: break
      except OSError:
       if time.monotonic()>deadline: raise RuntimeError('vite timeout')
       time.sleep(.1)
     a,b=port(),port()
     while b==a:b=port()
     wrapper=work/'driver-wrapper';wrapper.write_text('#!/bin/sh\nexec '+shlex.quote(driver)+' --native-port '+str(b)+' "$@"\n');wrapper.chmod(0o700)
     smoke.APP=str(app);smoke.DRIVER_LOG=str(raw/'driver.log')
     with smoke.tauri_driver(str(wrapper),a,str(work/'data')) as start:
      d=start()
      try:
       result['stage']='document'
       smoke.wait_until(d,"return !!document.querySelector('.document-bar__open')",timeout=30)
       st=poc.open_document(d,doc)
       if d.js('return window.__geulOwnership.identity.wasmSha256')!='0cb73f70cd98dbef89718534e1bc283f1cb4c200af200703d40b137be1cde956': raise RuntimeError('runtime candidate mismatch')
       native_probe.install(d,native_probe.INSTALL.replace("import('/rhwp/rhwp.js')",'Promise.resolve(window.__geulOwnership.probeEngine())'))
       poc.set_zoom(d,50)
       smoke.wait_until(d,"return document.querySelectorAll('.rhwp-page__canvas').length===Number(arguments[0])",int(st['pages']),timeout=30)
       windows=subprocess.check_output([xdotool,'search','--onlyvisible','--name','^geul'],text=True,timeout=10).split();subprocess.run([xdotool,'windowfocus','--sync',windows[-1]],check=True,timeout=10)
       d.native_key_tool=xdotool
       poc.click_paragraph_start(d)
       for _ in range(3): poc.press(d,'Right'); poc.type_ascii(d,'ab')
       time.sleep(1)
       d.js(PROBE); result['canvasExtent']=d.js('return window.__ff.prepareCanvas()')
       result['stage']='measure'; order=[]
       for block in range(BLOCKS):
        for arm in ARMS[block%3:]+ARMS[:block%3]:
         order.append(arm)
         d.js('window.__ff.override(null)')
         if arm[0]=='e': poc.click_paragraph_start(d)
         else: d.js("document.getElementById('d4-ctl').focus()")
         rev_before=poc.status(d).get('localRevision'); d.js('window.__ff.override(arguments[0])',arm); time.sleep(.3)
         for _ in range(BLOCK):
          count=d.js('return window.__ff.samples.length')
          if arm[0]=='e':
           poc.press(d,'Right'); d.js('window.__ff.arm=arguments[0]',arm); poc.type_ascii(d,'a')
          else:
           d.js('window.__ff.arm=arguments[0]',arm); subprocess.run(['env','-u','LD_LIBRARY_PATH',xdotool,'type','--delay','20','a'],check=True,capture_output=True,timeout=10)
          smoke.wait_until(d,'return window.__ff.samples.length>arguments[0]',count,timeout=15)
          d.js('window.__ff.arm=null'); time.sleep(.3)
         if arm[0]!='e' and poc.status(d).get('localRevision')!=rev_before: raise RuntimeError('control arm changed the document')
       result['blockOrder']=order
       samples=d.js('return window.__ff.samples'); gaps=d.js('return window.__ff.gaps')
       result['samples']=samples
       if any(s['keyToFrame']<0 for s in samples): raise RuntimeError('sample timeout')
       summary={}
       for arm in ARMS:
        rows=[s for s in samples if s['arm']==arm]
        if len(rows)!=BLOCK*BLOCKS: raise RuntimeError('sample count mismatch '+arm)
        summary[arm]={'keyToFrame':pct([round(s['keyToFrame']) for s in rows]),'observed':pct([round(s['observed']) for s in rows]),
                      'observedToRaf1':pct([round(s['raf1']-s['observed']) for s in rows]),'raf1ToEnd':pct([round(s['end']-s['raf1']) for s in rows]),
                      'handlerMs':pct([round(s['handlerMs']) for s in rows if s.get('handlerMs') is not None]),
                      'rafGap':pct([round(g[1]) for g in gaps if g[0]==arm])}
       summary['idleRafGap']=pct([round(g[1]) for g in gaps if g[0] is None])
       result['summary']=summary
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
 result['environment']['loadAverageAfter']=os.getloadavg()
 rec=scope.teardown(owned_pids=[p.pid for p in owned]); result['processScope']=rec
 if not rec['cleanupSucceeded']: helper.failure(result,'process-scope',RuntimeError('scope cleanup incomplete'))
 ok=helper.finalize(result,'summary' in result)  # teardown/cleanup validation of the current attempt
 result['status']='COMPLETE' if ok and rec['cleanupSucceeded'] and not result['failures'] else 'FAIL'
 result['readinessVerdict']='DIAGNOSTIC (not an official D4 gate)'
 helper.persist_result(result,out)
 print(json.dumps({k:result.get(k) for k in ('status','stage','failures','summary','cleanupStatus')},ensure_ascii=False))
sys.exit(0 if result['status']=='COMPLETE' else 1)
