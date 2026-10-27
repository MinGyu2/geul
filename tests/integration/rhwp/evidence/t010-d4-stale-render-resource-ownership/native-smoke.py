import hashlib,importlib.util,json,os,select,shlex,socket,subprocess,sys,tempfile,time,urllib.request,uuid
from pathlib import Path
root=Path(__file__).resolve().parents[5]; sys.path[:0]=[str(root/'tests/e2e'),str(root/'tests/integration/rhwp')]
import tauri_smoke as smoke, rhwp_poc as poc, undo_native as history, native_probe
helper_spec=importlib.util.spec_from_file_location('geul_smoke_verdict',root/'tests/integration/rhwp/ownership-poc/smoke_verdict.py')
helper=importlib.util.module_from_spec(helper_spec); helper_spec.loader.exec_module(helper)
failure,record_pending,stop_owned,verify_fixture,verify_unchanged,verify_observation,persist_result,finalize,assess_oracle,attach_teardown=(helper.failure,helper.record_pending,helper.stop_owned,helper.verify_fixture,helper.verify_unchanged,helper.verify_observation,helper.persist_result,helper.finalize,helper.assess_oracle,helper.attach_teardown)
raw=Path(os.environ['GEUL_SMOKE_RAW']).resolve(); raw.mkdir(parents=True,exist_ok=False); out=raw/'smoke.json'
if out.exists(): raise SystemExit('preserve existing smoke evidence')
xvfb=os.environ['GEUL_XVFB']; xdotool=os.environ['GEUL_XDOTOOL']; webkit=os.environ['GEUL_WEBKIT_DRIVER']; driver=os.environ['GEUL_TAURI_DRIVER']
candidate=Path(os.environ['GEUL_T010_CANDIDATE']); gates=Path(os.environ['GEUL_T010_EVIDENCE']); app=root/'src-tauri/target/debug/geul'
result={'status':'FAIL','stage':'preflight','official':False,'checks':{},'owned':{},'failures':[],'attemptId':uuid.uuid4().hex}; observations_complete=False; recorded=set(); teardown_start=len(smoke.TEARDOWN)
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
result['sourceSha256']={name:sha(path) for name,path in {'runner':Path(__file__),'helper':root/'tests/integration/rhwp/ownership-poc/smoke_verdict.py','validator':root/'tests/integration/rhwp/ownership-poc/lifecycle-trace.mjs','session':root/'tests/integration/rhwp/ownership-poc/session.mjs'}.items()}
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
  doc=fixture/'basic-ko.hwpx'; before=verify_fixture(doc,result)
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
   result['stage']='vite'; log=None;vite=None
   try:
    log=(raw/'vite.log').open('xb');vite=subprocess.Popen(['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--config','tests/integration/rhwp/ownership-poc/vite.config.mjs'],cwd=root,env=os.environ,stdout=log,stderr=subprocess.STDOUT);result['owned']['vite']=vite.pid
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
      result['checks']['document']=True
      oracle_enabled=os.environ.get('GEUL_FULL_FRAME_ORACLE')=='1';result['oracleEnabled']=oracle_enabled
      if oracle_enabled:
       probe=native_probe.INSTALL.replace("import('/rhwp/rhwp.js')",'Promise.resolve(window.__geulOwnership.probeEngine())')
       native_probe.install(d,probe)
      poc.click_paragraph_start(d)
      windows=subprocess.check_output([xdotool,'search','--onlyvisible','--name','^geul'],text=True,timeout=10).split();subprocess.run([xdotool,'windowfocus','--sync',windows[-1]],check=True,timeout=10)
      d.native_key_tool=xdotool;d.js(history.MEASURE)
      d.js("window.__nativeKeyTimes=[];window.__nativeInputTimes=[];window.addEventListener('keydown',e=>window.__nativeKeyTimes.push(e.timeStamp),true);document.addEventListener('input',e=>{if(e.target?.classList?.contains('rhwp-input'))window.__nativeInputTimes.push(e.timeStamp)},true);import('/tests/integration/rhwp/ownership-poc/lifecycle-trace.mjs').then(m=>{window.__life=m.installLifecycleTrace(window);}).catch(e=>{window.__lifeError=String(e)});")
      smoke.wait_until(d,'return !!window.__life || !!window.__lifeError',timeout=10)
      if d.js('return window.__lifeError||null'):raise RuntimeError('trace install failed')
      result['stage']='native-input'
      before_status=poc.status(d); before_sessions=d.js('return window.__geulOwnership.stats().sessions'); before_count=d.js('return window.__stages.length')
      if len(before_sessions)!=1 or before_status.get('status')!='ready': raise RuntimeError('unexpected document/session state')
      before_state={'document':str(before_sessions[0]['sessionId'])+':'+str(before_sessions[0]['generation']),'localRevision':int(before_status['localRevision']),'revision':int(before_status['revision']),'modelVersion':before_sessions[0]['modelVersion']}
      poc.type_ascii(d,'a');smoke.wait_until(d,'return window.__stages?.length>arguments[0]',before_count,timeout=15)
      after_status=poc.status(d); after_sessions=d.js('return window.__geulOwnership.stats().sessions')
      if after_status.get('status')!='ready': raise RuntimeError('editor is not ready after input')
      if len(after_sessions)!=1: raise RuntimeError('unexpected session count')
      after_state={'document':str(after_sessions[0]['sessionId'])+':'+str(after_sessions[0]['generation']),'localRevision':int(after_status['localRevision']),'revision':int(after_status['revision']),'modelVersion':after_sessions[0]['modelVersion']}
      stage=d.js('return window.__stages.at(-1)'); keys=d.js('return window.__nativeKeyTimes'); inputs=d.js('return window.__nativeInputTimes'); count=d.js('return window.__stages.length')
      verify_observation(before_state,after_state,stage,before_count,count,len(keys),len(inputs),keys[0] if len(keys)==1 else None,inputs[0] if len(inputs)==1 else None)
      result['revisionObservation']={'before':before_state,'after':after_state,'timelineCountBefore':before_count,'timelineCountAfter':count}
      result['checks'].update(nativeKey=True,revision=True,raf=True)
      result['timeline']={k:stage['at'][k] for k in ['key','input','observed','raf1','end']};d.js('window.__measureStop?.()')
      result['checks']['canvas']=d.js("const c=document.querySelector('.rhwp-page__canvas');return !!c && c.width>0 && c.height>0")
      result['stage']='visible-frame';smoke.wait_until(d,'return window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)',timeout=30)
      result['trace']=d.js('return window.__life.snapshot()')
      if oracle_enabled:
       state_before=poc.status(d); stats=d.js('return window.__geulOwnership.stats().sessions')
       attached=d.js("const c=document.querySelectorAll('.rhwp-page__canvas')[0];return c?{page:0,connected:c.isConnected,width:c.width,height:c.height}:null")
       try: comparison=d.js('return window.__rhwpProbe.fullFrameCheck(0)')
       except Exception as error:
        result['oracleAssessment']={'status':'FAIL','errors':['oracle exception: '+type(error).__name__]};raise
       state_after=poc.status(d); stats_after=d.js('return window.__geulOwnership.stats().sessions')
       result['trace']=d.js('return window.__life.snapshot()')
       completed=[r for r in result['trace']['records'] if r.get('session')==stats[0]['sessionId'] and r.get('generation')==stats[0]['generation']]
       stable=state_before.get('localRevision')==state_after.get('localRevision')==str(after_state['localRevision']) and len(stats_after)==1 and stats_after[0]['sessionId']==stats[0]['sessionId'] and stats_after[0]['generation']==stats[0]['generation'] and stats_after[0]['modelVersion']==stats[0]['modelVersion']
       result['visibleFrame']={'comparison':comparison if isinstance(comparison,dict) else {'invalidType':type(comparison).__name__},'attached':attached,'modelVersion':stats[0]['modelVersion'],'revisionStable':stable,'completedJobs':[r for r in completed if r.get('event')=='complete']}
       result['oracleAssessment']=assess_oracle(True,comparison,attached,after_state['modelVersion'],stats[0]['modelVersion'],stable,completed)
      else:
       result['visibleFrame']={'verified':False,'reason':'full-frame oracle not executed'}
       result['oracleAssessment']=assess_oracle(False,None,None,None,None,None,None)
      result['fixtureUnchanged']=verify_unchanged(doc,before)
      if result['oracleAssessment']['status']=='FAIL': raise RuntimeError('oracle failed: '+', '.join(result['oracleAssessment']['errors']))
      d.js('window.__life.stop()');result['stage']='shutdown'
     finally:
      if sys.exc_info()[1] is None: result['stage']='webdriver-session-delete'
      smoke.end_session(d)
      if sys.exc_info()[1] is None: result['stage']='webdriver-process-cleanup'
    attach_teardown(result,smoke.TEARDOWN,teardown_start)
    if not all(result['checks'].values()) or not result['fixtureUnchanged'] or not result['trace']['captureComplete'] or result['trace']['lifecycleValid'] != 'VALID': raise RuntimeError('smoke observations incomplete or invalid')
    observations_complete=True # visibility correctness remains unverified
   finally:
    record_pending(result,result['stage'],recorded)
    stop_owned(vite,'vite',result)
    try:
     if log: log.close()
    except Exception as e: failure(result,'vite-log-close',e)
  finally:
   record_pending(result,result['stage'],recorded)
   stop_owned(display,'xvfb',result)
except Exception as e:
 if result.get('oracleEnabled') is True and 'oracleAssessment' not in result: result['oracleAssessment']={'status':'FAIL','errors':['oracle incomplete at '+str(result['stage'])+': '+type(e).__name__]}
 attach_teardown(result,smoke.TEARDOWN,teardown_start)
 if id(e) not in recorded: failure(result,result['stage'],e)
 for note in getattr(e,'__notes__',[]): failure(result,'secondary-cleanup',RuntimeError(note))
finally:
 finalize(result,observations_complete)
 saved=persist_result(result,out)
 print(json.dumps({k:v for k,v in result.items() if k not in ('trace','teardown')}))

sys.exit(0 if saved and result['status']=='PARTIAL' else 1)
