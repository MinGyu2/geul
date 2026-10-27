import hashlib,json,os,select,shlex,socket,subprocess,sys,tempfile,time,urllib.request
from pathlib import Path
root=Path(__file__).resolve().parents[5]; sys.path[:0]=[str(root/'tests/e2e'),str(root/'tests/integration/rhwp')]
import tauri_smoke as smoke, rhwp_poc as poc, undo_native as history
raw=Path(os.environ['GEUL_SMOKE_RAW']).resolve(); raw.mkdir(parents=True,exist_ok=False); out=raw/'smoke.json'
if out.exists(): raise SystemExit('preserve existing smoke evidence')
xvfb=os.environ['GEUL_XVFB']; xdotool=os.environ['GEUL_XDOTOOL']; webkit=os.environ['GEUL_WEBKIT_DRIVER']; driver=os.environ['GEUL_TAURI_DRIVER']
candidate=Path(os.environ['GEUL_T010_CANDIDATE']); gates=Path(os.environ['GEUL_T010_EVIDENCE']); app=root/'src-tauri/target/debug/geul'
result={'status':'FAIL','stage':'preflight','official':False,'checks':{},'owned':{}}
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def port():
 with socket.socket() as s: s.bind(('127.0.0.1',0)); return s.getsockname()[1]
try:
 if sha(app) != '0fda84b2f91f686c26b235a48250e70892d4f16e9fd66d974f8c621a67c116cd': raise RuntimeError('app identity mismatch')
 if sha(candidate/'ENGINE.json') != 'a9ccd5a2c3fd7fa1cb9be6a810c2d2ec428abc0f917a93630230211d754b6069': raise RuntimeError('candidate manifest mismatch')
 for name,expected in {'engine-safety-gates.json':'618105f865df35bdffdac2b8d164b493201601abf06f6f51d6cee2ec005277e0','chrome.json':'5843af773371b642dc6f39dd70494ad9028fd2de754afee37c90a9bcf5219d07','webkit.json':'2303f87d6e4d7fbf3f70a4facff0ed1244fab5bd2694a0918ac2b44b9bd61d59'}.items():
  if sha(gates/name)!=expected: raise RuntimeError('gate identity mismatch '+name)
 for name,expected in {'rhwp.js':'37cea466d25ecbd12c5586cdeddada1c97aa4fd45860e857160e12e83e668e5d','rhwp_bg.wasm':'0cb73f70cd98dbef89718534e1bc283f1cb4c200af200703d40b137be1cde956','rhwp.d.ts':'9d46972b79edcf09c9d87e732cd5c91ea4bfded79457639162b0c7d6e7530cb1'}.items():
  if sha(candidate/name)!=expected: raise RuntimeError('candidate identity mismatch '+name)
 with socket.socket() as s: s.bind(('127.0.0.1',1420))
 with tempfile.TemporaryDirectory(prefix='geul-lifecycle-smoke-') as td:
  work=Path(td); fixture=work/'fixtures'; subprocess.run(['node',str(root/'tests/fixtures/rhwp/generate.mjs'),str(fixture)],check=True,timeout=30,capture_output=True)
  doc=fixture/'basic-ko.hwpx'; result['fixtureSha256']=sha(doc); before=sha(doc)
  for key in ('XDG_CONFIG_HOME','XDG_CACHE_HOME','TMPDIR'):
   (work/key).mkdir();os.environ[key]=str(work/key)
  env={'VITE_GEUL_TEST_HOOKS':'1','GEUL_T010_OWNERSHIP_POC':'1','GEUL_T010_SCHEDULER_POC':'1','GEUL_T010_CANDIDATE':str(candidate),'GEUL_T010_EVIDENCE':str(gates),'VITE_GEUL_TEST_RHWP_HISTORY':'1','GEUL_T010_HISTORY_PERF_ONLY':'1','WEBKIT_DISABLE_DMABUF_RENDERER':'1','LIBGL_ALWAYS_SOFTWARE':'1','GDK_BACKEND':'x11','WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS':'1','NO_AT_BRIDGE':'1','GTK_A11Y':'none'}
  os.environ.update(env);os.environ['PATH']=str(Path(webkit).parent)+os.pathsep+os.environ['PATH']
  result['stage']='display'; display=subprocess.Popen([xvfb,'-displayfd','1','-screen','0','1280x1024x24','-nolisten','tcp'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True); result['owned']['xvfb']=display.pid
  try:
   if not select.select([display.stdout],[],[],10)[0]: raise RuntimeError('Xvfb timeout')
   number=display.stdout.readline().strip()
   if not number.isdigit(): raise RuntimeError('invalid display')
   os.environ['DISPLAY']=':'+number; result['display']=number
   result['stage']='vite'; log=(raw/'vite.log').open('xb');vite=subprocess.Popen(['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--config','tests/integration/rhwp/ownership-poc/vite.config.mjs'],cwd=root,env=os.environ,stdout=log,stderr=subprocess.STDOUT);result['owned']['vite']=vite.pid
   try:
    deadline=time.monotonic()+30
    while True:
     if vite.poll() is not None: raise RuntimeError('vite exited '+str(vite.returncode))
     try:
      with urllib.request.urlopen('http://localhost:1420',timeout=1) as r:
       if r.status==200: break
     except OSError:
      if time.monotonic()>deadline: raise RuntimeError('vite timeout')
      time.sleep(.1)
    a,b=port(),port()
    while b==a:b=port()
    wrapper=work/'driver-wrapper';wrapper.write_text('#!/bin/sh\nexec '+shlex.quote(driver)+' --native-port '+str(b)+' "$@"\n');wrapper.chmod(0o700)
    result['ports']={'driver':a,'native':b}; result['stage']='webdriver'; smoke.APP=str(app);smoke.DRIVER_LOG=str(raw/'driver.log')
    with smoke.tauri_driver(str(wrapper),a,str(work/'data')) as start:
     d=start()
     try:
      result['checks']['webdriver']=True;result['stage']='document';result['applicationProcesses']=smoke.owned_processes();result['checks']['appProcess']=any(p['comm']=='geul' for p in result['applicationProcesses']);smoke.wait_until(d,"return !!document.querySelector('.document-bar__open')",timeout=30)
      poc.open_document(d,doc);smoke.wait_until(d,'return !!window.__geulOwnership && window.__geulOwnership.stats().sessions.some(s=>s.canvases>0&&!s.active&&!s.queued)',timeout=30)
      ident=d.js('return window.__geulOwnership.identity');result['candidate']=ident
      if ident['wasmSha256']!='0cb73f70cd98dbef89718534e1bc283f1cb4c200af200703d40b137be1cde956':raise RuntimeError('runtime candidate mismatch')
      result['checks']['document']=True;poc.click_paragraph_start(d)
      windows=subprocess.check_output([xdotool,'search','--onlyvisible','--name','^geul'],text=True,timeout=10).split();subprocess.run([xdotool,'windowfocus','--sync',windows[-1]],check=True,timeout=10)
      d.native_key_tool=xdotool;d.js(history.MEASURE)
      d.js("window.__nativeKeyCount=0;window.addEventListener('keydown',()=>window.__nativeKeyCount++,true);import('/tests/integration/rhwp/ownership-poc/lifecycle-trace.mjs').then(m=>{window.__life=m.installLifecycleTrace(window);}).catch(e=>{window.__lifeError=String(e)});")
      smoke.wait_until(d,'return !!window.__life || !!window.__lifeError',timeout=10)
      if d.js('return window.__lifeError||null'):raise RuntimeError('trace install failed')
      result['stage']='native-input';poc.type_ascii(d,'a');smoke.wait_until(d,'return window.__stages?.length>0',timeout=15)
      stage=d.js('return window.__stages.at(-1)');result['checks'].update(nativeKey=d.js('return window.__nativeKeyCount')>0,revision=True,raf=bool(stage and stage['at']['raf1'] is not None and stage['at']['end'] is not None))
      result['timeline']={k:stage['at'][k] for k in ['key','observed','raf1','end']};result['trace']=d.js('return window.__life.snapshot()');d.js('window.__life.stop();window.__measureStop?.()')
      result['checks']['canvas']=d.js("const c=document.querySelector('.rhwp-page__canvas');return !!c && c.width>0 && c.height>0")
      result['fixtureUnchanged']=sha(doc)==before;result['stage']='shutdown'
     finally:smoke.end_session(d)
    result['teardown']=smoke.TEARDOWN[-1]
    if not all(result['checks'].values()) or not result['fixtureUnchanged'] or not result['trace']['captureComplete'] or result['trace']['lifecycleValid'] != 'VALID': raise RuntimeError('smoke observations incomplete or invalid')
    result['status']='PARTIAL' # visibility correctness requires independent evidence
   finally:
    vite.terminate()
    try:vite.wait(timeout=10)
    except subprocess.TimeoutExpired:vite.kill();vite.wait(timeout=5)
    result['owned']['viteReaped']=vite.returncode;log.close()
  finally:
   display.terminate()
   try:display.wait(timeout=10)
   except subprocess.TimeoutExpired:display.kill();display.wait(timeout=5)
   result['owned']['xvfbReaped']=display.returncode
except Exception as e:result['error']=type(e).__name__+': '+str(e)
finally:
 out.write_text(json.dumps(result,ensure_ascii=True,indent=2));print(json.dumps({k:v for k,v in result.items() if k not in ('trace','teardown')}))

sys.exit(0 if result['status']=='PARTIAL' else 1)
