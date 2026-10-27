"""T010 D4 diagnostic: identity and pixel effect of the render jobs per key on the chemical document (not a gate).

Same app, candidate, env, fixture (basic-ko.hwp, zoom 50) and native X11 xdotool keys as the official
history-perf run. Arms, interleaved in rotated blocks of 10 (30 samples each):
  null    key into a test-only <input> outside the editor; no document, engine, IPC or canvas work
  canvas  same key, and the input handler re-publishes the visible page Canvas exactly like the app's
          publish (full getImageData readback + drawImage of identical pixels); still no engine or IPC
  editor  official-style group start: Right, then 'a' into the real editor (engine, history, render, IPC)
Endpoint identical to undo_native.MEASURE: keydown.timeStamp -> first RAF tick that observes the arm's
marker -> RAF -> RAF(end). Nothing is deducted. Process scope: child subreaper (process_scope.py).
"""
import shutil,hashlib,importlib.util,json,math,os,select,shlex,socket,subprocess,sys,tempfile,time,urllib.request,uuid
from pathlib import Path
root=Path(__file__).resolve().parents[5]
sys.path[:0]=[str(root/'tests/e2e'),str(root/'tests/integration/rhwp'),str(root/'tests/integration/rhwp/ownership-poc')]
import process_scope
scope=process_scope.Scope().enable()
import tauri_smoke as smoke, rhwp_poc as poc, native_probe
helper_spec=importlib.util.spec_from_file_location('geul_smoke_verdict',root/'tests/integration/rhwp/ownership-poc/smoke_verdict.py')
helper=importlib.util.module_from_spec(helper_spec); helper_spec.loader.exec_module(helper)
raw=Path(os.environ['GEUL_SMOKE_RAW']).resolve(); raw.mkdir(parents=True,exist_ok=False); out=raw/'chemical-jobs.json'
xvfb=os.environ['GEUL_XVFB']; xdotool=os.environ['GEUL_XDOTOOL']; webkit=os.environ['GEUL_WEBKIT_DRIVER']; driver=os.environ['GEUL_TAURI_DRIVER']; dbus=os.environ['GEUL_DBUS_DAEMON']
candidate=Path(os.environ['GEUL_T010_CANDIDATE']); gates=Path(os.environ['GEUL_T010_EVIDENCE']); app=root/'src-tauri/target/debug/geul'
ARMS=tuple(os.environ.get('GEUL_FF_ARMS','null,canvas,editor').split(',')); BLOCK=10; BLOCKS=3
result={'status':'FAIL','stage':'preflight','official':False,'kind':'T010 D4 chemical render-job identity diagnostic','failures':[],'attemptId':uuid.uuid4().hex,'samples':[],'cleanup':{},'environment':{},'arms':list(ARMS)}
teardown_start=len(smoke.TEARDOWN); recorded=set(); owned=[]
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
result['sourceSha256']={'runner':sha(__file__),'scope':sha(root/'tests/integration/rhwp/ownership-poc/process_scope.py'),'session':sha(root/'tests/integration/rhwp/ownership-poc/session.mjs')}
def port():
 with socket.socket() as s: s.bind(('127.0.0.1',0)); return s.getsockname()[1]
def pct(values):
 v=sorted(values); n=len(v)
 return {'n':n,**({'p50':v[math.ceil(.5*n)-1],'p95':v[math.ceil(.95*n)-1],'max':v[-1]} if n else {})}

PROBE=r"""
if(!window.__cj){
  const cj=window.__cj={samples:[],cur:null};
  const mod=window.__geulOwnership.probeEngine(), proto=mod.HwpDocument.prototype;
  const hash=c=>{if(!c||!c.width)return null;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let h=2166136261>>>0;for(let i=0;i<d.length;i+=16)h=Math.imul(h^d[i]^(d[i+1]<<8)^(d[i+2]<<16),16777619)>>>0;return h;};
  const canvases=()=>[...document.querySelectorAll('.rhwp-page__canvas')];
  for(const name of ['beginRenderJob','beginRenderPatchJob']){const orig=proto[name];proto[name]=function(page,canvas,...rest){
    const id=orig.call(this,page,canvas,...rest);
    if(cj.cur)cj.cur.jobs.push({name,page,canvasIndex:canvases().indexOf(canvas),id,at:performance.now()-cj.cur.key,before:hash(canvas),canvas});
    return id;};}
  const poll=proto.pollRenderJob;proto.pollRenderJob=function(id){const r=poll.call(this,id);
    if(cj.cur&&r!=='PENDING'){const j=cj.cur.jobs.find(x=>x.id===id&&x.outcome===undefined);if(j){j.outcome=r;j.after=hash(j.canvas);j.doneAt=performance.now()-cj.cur.key;}}return r;};
  window.addEventListener('keydown',e=>{if(e.key==='a'&&!e.ctrlKey)cj.cur={key:e.timeStamp,jobs:[]};},true);
  cj.finish=()=>{const s=cj.cur;cj.cur=null;if(s){s.jobs.forEach(j=>delete j.canvas);s.visible=canvases().map(c=>{const r=c.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight;});cj.samples.push(s);}return s;};
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
  doc=work/'chem.hwp'; shutil.copyfile(root/'external/rhwp/samples/rnote/연구노트(화학).hwp',doc); result['fixtureSha256']=sha(doc)
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
       d.js(PROBE); result['stage']='measure'
       for _ in range(20):
        poc.press(d,'Right'); poc.type_ascii(d,'a')
        smoke.wait_until(d,'return window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)',timeout=30); time.sleep(.3)
        d.js('return window.__cj.finish()')
       result['samples']=d.js('return window.__cj.samples')
       rows=result['samples']
       result['summary']={'samples':len(rows),'jobsPerKey':sorted({len(r['jobs']) for r in rows}),
         'jobs':[{'pages':[j['page'] for j in r['jobs']],'canvas':[j['canvasIndex'] for j in r['jobs']],'changed':[j['before']!=j['after'] for j in r['jobs']],'outcomes':[j.get('outcome') for j in r['jobs']],'names':[j['name'] for j in r['jobs']]} for r in rows]}
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
