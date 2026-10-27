"""T010 native decoded-resource lease diagnostic (test-only, not an official gate).

Real tauri app + WebKitGTK + candidate 0cb73f70 under Xvfb, real chemical HWP fixture. Positive
image leases are created on test-owned documents (shared module pool/caches) and on the app-owned
document; ownership transitions are read from engine counters (lease-probe.js) and evaluated by
ownership-poc/lease_verdict.py. The harness is a child subreaper (ownership-poc/process_scope.py)
with its own private D-Bus daemon, so every descendant stays in its process tree until teardown.
"""
import base64,hashlib,importlib.util,json,os,select,shlex,shutil,socket,subprocess,sys,tempfile,time,urllib.request,uuid
from pathlib import Path
root=Path(__file__).resolve().parents[5]; here=Path(__file__).resolve().parent
sys.path[:0]=[str(root/'tests/e2e'),str(root/'tests/integration/rhwp'),str(root/'tests/integration/rhwp/ownership-poc')]
import process_scope
scope=process_scope.Scope().enable()  # before any child: no descendant can leave the tree
import tauri_smoke as smoke, rhwp_poc as poc, undo_native as history, native_probe, lease_verdict
helper_spec=importlib.util.spec_from_file_location('geul_smoke_verdict',root/'tests/integration/rhwp/ownership-poc/smoke_verdict.py')
helper=importlib.util.module_from_spec(helper_spec); helper_spec.loader.exec_module(helper)
failure,record_pending,stop_owned,persist_result,finalize,attach_teardown=helper.failure,helper.record_pending,helper.stop_owned,helper.persist_result,helper.finalize,helper.attach_teardown
raw=Path(os.environ['GEUL_SMOKE_RAW']).resolve(); raw.mkdir(parents=True,exist_ok=False); out=raw/'lease.json'
xvfb=os.environ['GEUL_XVFB']; xdotool=os.environ['GEUL_XDOTOOL']; webkit=os.environ['GEUL_WEBKIT_DRIVER']; driver=os.environ['GEUL_TAURI_DRIVER']; dbus=os.environ['GEUL_DBUS_DAEMON']
candidate=Path(os.environ['GEUL_T010_CANDIDATE']); gates=Path(os.environ['GEUL_T010_EVIDENCE']); app=root/'src-tauri/target/debug/geul'
CHEM=root/'external/rhwp/samples/rnote/연구노트(화학).hwp'
SVG=root/'external/rhwp/samples/issue3460/svg_picture_repro.hwpx'  # real SVG pictures: browser image (async DOM) path
result={'status':'FAIL','stage':'preflight','official':False,'kind':'T010 native lease ownership diagnostic','checks':{},'owned':{},'failures':[],'attemptId':uuid.uuid4().hex,
        'steps':{},'outcomes':{},'comparisons':{}}
observations_complete=False; recorded=set(); teardown_start=len(smoke.TEARDOWN); owned_popen=[]
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
result['sourceSha256']={name:sha(path) for name,path in {'runner':Path(__file__),'probe':here/'lease-probe.js','verdict':root/'tests/integration/rhwp/ownership-poc/lease_verdict.py',
    'scope':root/'tests/integration/rhwp/ownership-poc/process_scope.py','helper':root/'tests/integration/rhwp/ownership-poc/smoke_verdict.py',
    'session':root/'tests/integration/rhwp/ownership-poc/session.mjs','nativeProbe':root/'tests/integration/rhwp/native_probe.py'}.items()}
def port():
 with socket.socket() as s: s.bind(('127.0.0.1',0)); return s.getsockname()[1]
def step(label,row,extra=None):
 if not isinstance(row,dict) or 'jobs' not in row: raise RuntimeError('missing checkpoint '+label)
 row=dict(row); row.update(extra or {}); result['steps'][label]=row
 if 'outcome' in row: result['outcomes'][label]=row['outcome']
 return row
def wait_js(d,expr,timeout=20,*args): smoke.wait_until(d,expr,*args,timeout=timeout)
def app_idle(d): wait_js(d,'return window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)',30)
def trim(d,label): app_idle(d); return step(label,d.js('return window.__rhwpProbe.lease.trim(arguments[0])',label))
def hold(d,n=8): d.js('return window.__rhwpProbe.lease.hold(arguments[0])',n)
def unhold(d): return d.js('return window.__rhwpProbe.lease.unhold()')
def release(d): return d.js('return window.__rhwpProbe.lease.release()')
def loads_idle(d): wait_js(d,'return JSON.parse(window.__rhwpProbe.lease&&window.__geulOwnership.probeEngine().rendererJobStats()).pendingCount===0',30)
def poll_until(d,doc,job,label,limit=400):
 for _ in range(limit):
  r=d.js('return window.__rhwpProbe.lease.poll(arguments[0],arguments[1],arguments[2])',doc,job,label)
  if r['outcome']!='PENDING': return step(label,r['snap'])
  time.sleep(.02)
 return step(label,r['snap'])
try:
 if sha(app)!='0fda84b2f91f686c26b235a48250e70892d4f16e9fd66d974f8c621a67c116cd': raise RuntimeError('app identity mismatch')
 if sha(candidate/'ENGINE.json')!='a9ccd5a2c3fd7fa1cb9be6a810c2d2ec428abc0f917a93630230211d754b6069': raise RuntimeError('candidate manifest mismatch')
 for name,expected in {'engine-safety-gates.json':'618105f865df35bdffdac2b8d164b493201601abf06f6f51d6cee2ec005277e0','chrome.json':'5843af773371b642dc6f39dd70494ad9028fd2de754afee37c90a9bcf5219d07','webkit.json':'2303f87d6e4d7fbf3f70a4facff0ed1244fab5bd2694a0918ac2b44b9bd61d59'}.items():
  if sha(gates/name)!=expected: raise RuntimeError('gate identity mismatch '+name)
 for name,expected in {'rhwp.js':'37cea466d25ecbd12c5586cdeddada1c97aa4fd45860e857160e12e83e668e5d','rhwp_bg.wasm':'0cb73f70cd98dbef89718534e1bc283f1cb4c200af200703d40b137be1cde956','rhwp.d.ts':'9d46972b79edcf09c9d87e732cd5c91ea4bfded79457639162b0c7d6e7530cb1'}.items():
  if sha(candidate/name)!=expected: raise RuntimeError('candidate identity mismatch '+name)
 chem_sha=sha(CHEM); svg_sha=sha(SVG); result['fixtureSha256']={'svg':svg_sha,'chemical':chem_sha}
 with socket.socket() as s: s.bind(('127.0.0.1',1420))
 with tempfile.TemporaryDirectory(prefix='geul-lease-native-') as td:
  work=Path(td); doc=work/'lease-svg.hwpx'; shutil.copyfile(SVG,doc)
  if sha(doc)!=svg_sha: raise RuntimeError('fixture copy mismatch')
  for key in ('XDG_CONFIG_HOME','XDG_CACHE_HOME','TMPDIR','XDG_RUNTIME_DIR'):
   (work/key).mkdir(mode=0o700);os.environ[key]=str(work/key)
  env={'VITE_GEUL_TEST_HOOKS':'1','GEUL_T010_OWNERSHIP_POC':'1','GEUL_T010_SCHEDULER_POC':'1','GEUL_T010_CANDIDATE':str(candidate),'GEUL_T010_EVIDENCE':str(gates),'VITE_GEUL_TEST_RHWP_HISTORY':'1','GEUL_T010_HISTORY_PERF_ONLY':'1','WEBKIT_DISABLE_DMABUF_RENDERER':'1','LIBGL_ALWAYS_SOFTWARE':'1','GDK_BACKEND':'x11','WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS':'1','NO_AT_BRIDGE':'1','GTK_A11Y':'none'}
  os.environ.update(env);os.environ['PATH']=str(Path(webkit).parent)+os.pathsep+os.environ['PATH']
  result['stage']='dbus'
  bus=subprocess.Popen([dbus,'--session','--nofork','--nopidfile','--print-address=1'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True);owned_popen.append(bus);result['owned']['dbus']=bus.pid
  try:
   if not select.select([bus.stdout],[],[],10)[0]: raise RuntimeError('dbus timeout')
   address=bus.stdout.readline().strip()
   if not address.startswith('unix:'): raise RuntimeError('invalid bus address')
   os.environ['DBUS_SESSION_BUS_ADDRESS']=address
   result['stage']='display'; display=subprocess.Popen([xvfb,'-displayfd','1','-screen','0','1280x1024x24','-nolisten','tcp'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True); owned_popen.append(display); result['owned']['xvfb']=display.pid
   try:
    if not select.select([display.stdout],[],[],10)[0]: raise RuntimeError('Xvfb timeout')
    number=display.stdout.readline().strip()
    if not number.isdigit(): raise RuntimeError('invalid display')
    os.environ['DISPLAY']=':'+number
    result['stage']='vite'; log=None;vite=None
    try:
     log=(raw/'vite.log').open('xb');vite=subprocess.Popen(['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--config','tests/integration/rhwp/ownership-poc/vite.config.mjs'],cwd=root,env=os.environ,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);owned_popen.append(vite);result['owned']['vite']=vite.pid
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
     result['stage']='webdriver'; smoke.APP=str(app);smoke.DRIVER_LOG=str(raw/'driver.log')
     with smoke.tauri_driver(str(wrapper),a,str(work/'data')) as start:
      d=start()
      try:
       result['checks']['webdriver']=True;result['stage']='document';scope.observe()
       wait_js(d,"return !!document.querySelector('.document-bar__open')",30)
       poc.open_document(d,doc);wait_js(d,'return !!window.__geulOwnership && window.__geulOwnership.stats().sessions.some(s=>s.canvases>0&&!s.active&&!s.queued)',60)
       ident=d.js('return window.__geulOwnership.identity');result['candidate']=ident
       if ident['wasmSha256']!='0cb73f70cd98dbef89718534e1bc283f1cb4c200af200703d40b137be1cde956':raise RuntimeError('runtime candidate mismatch')
       probe=native_probe.INSTALL.replace("import('/rhwp/rhwp.js')",'Promise.resolve(window.__geulOwnership.probeEngine())')
       marker="  p.owners = () =>"
       if marker not in probe: raise RuntimeError('probe injection boundary changed')
       native_probe.install(d,probe.replace(marker,(here/'lease-probe.js').read_text()+marker,1))
       poc.click_paragraph_start(d); scope.observe()
       result['stage']='test-documents'
       d.js('window.__rhwpProbe.lease.load(["X","Y"],arguments[0],arguments[1],null)',svg_sha,base64.b64encode(SVG.read_bytes()).decode()); wait_js(d,'return window.__rhwpProbe.lease.loaded!==null',60)
       loaded=d.js('return window.__rhwpProbe.lease.loaded'); result['testDocuments']=loaded
       if not loaded.get('ok'): raise RuntimeError('test document load failed')
       result['stage']='scan'; trim(d,'scan-trim'); loads_idle(d)
       page=None; scan=[]
       for candidate_page in range(min(40,loaded['pages']['X'])):
        hold(d); r=d.js('return window.__rhwpProbe.lease.begin("X","scan",arguments[0],"scan")',candidate_page); unhold(d)
        scan.append({'page':candidate_page,'outcome':r['outcome'],'leases':r['snap']['jobs']['activeLeaseCount'],'pending':r['snap']['jobs']['pendingCount']})
        if r['outcome']=='PENDING':
         d.js('return window.__rhwpProbe.lease.cancel("X",arguments[0],"scan-cancel")',r['id'])
         if r['snap']['jobs']['activeLeaseCount']>0 and r['snap']['jobs']['pendingCount']>0: page=candidate_page
        release(d); loads_idle(d)
        if page is not None: break
       result['scan']=scan
       if page is None: raise RuntimeError('no page with in-flight image leases')
       result['leasePage']=page
       loads_idle(d); trim(d,'trimmed')
       result['stage']='acquire'
       hold(d); x1=d.js('return window.__rhwpProbe.lease.begin("X","x1",arguments[0],"acquire-X")',page); result['unusedHolds']={'acquire-X':unhold(d)}; step('acquire-X',x1['snap'])
       y1=d.js('return window.__rhwpProbe.lease.begin("Y","y1",arguments[0],"acquire-Y")',page); step('acquire-Y',y1['snap'])
       step('cancel-X',d.js('return window.__rhwpProbe.lease.cancel("X",arguments[0],"cancel-X")',x1['id'])['snap'])
       step('cancel-X-again',d.js('return window.__rhwpProbe.lease.cancel("X",arguments[0],"cancel-X-again")',x1['id'])['snap'])
       step('poll-X-canceled',d.js('return window.__rhwpProbe.lease.poll("X",arguments[0],"poll-X-canceled")',x1['id'])['snap'])
       result['stage']='ready'; result['released']={'ready':release(d)}; loads_idle(d)
       step('ready-Y',d.js('return window.__rhwpProbe.lease.snap("ready-Y")'))
       poll_until(d,'Y',y1['id'],'complete-Y')
       step('reference',d.js('return window.__rhwpProbe.lease.reference("X","ref",arguments[0])',page))
       result['comparisons']['y1-vs-ref']=d.js('return window.__rhwpProbe.lease.compare("y1","ref")')
       result['stage']='reuse'
       x2=d.js('return window.__rhwpProbe.lease.begin("X","x2",arguments[0],"reuse-X-begin")',page)
       if x2['outcome']=='PENDING': poll_until(d,'X',x2['id'],'reuse-X')
       else: step('reuse-X',x2['snap'])
       result['comparisons']['x2-vs-ref']=d.js('return window.__rhwpProbe.lease.compare("x2","ref")')
       result['stage']='pressure'; loads_idle(d)
       original=trim(d,'trim-2')['cache']
       lease_bytes=result['steps']['ready-Y']['jobs']['activeLeaseEstimatedBytes']
       small=max(1,lease_bytes//2)
       step('budget-small',d.js('return window.__rhwpProbe.lease.setBudget(arguments[0],arguments[1],arguments[2],"budget-small")',original['decoded']['maxBytes'],small,original['images']['maxEntries']))
       hold(d); x3=d.js('return window.__rhwpProbe.lease.begin("X","x3",arguments[0],"pressure-X")',page); result['unusedHolds']['pressure-X']=unhold(d); step('pressure-X',x3['snap'])
       y3=d.js('return window.__rhwpProbe.lease.begin("Y","y3",arguments[0],"pressure-Y")',page); step('pressure-Y',y3['snap'])
       result['released']['pressure']=release(d); loads_idle(d); poll_until(d,'Y',y3['id'],'pressure-Y-complete'); poll_until(d,'X',x3['id'],'pressure-X-complete')
       result['comparisons']['x3-vs-ref']=d.js('return window.__rhwpProbe.lease.compare("x3","ref")')
       result['comparisons']['y3-vs-ref']=d.js('return window.__rhwpProbe.lease.compare("y3","ref")')
       app_idle(d)
       restored=d.js('return window.__rhwpProbe.lease.setBudget(arguments[0],arguments[1],arguments[2],"budget-restored")',original['decoded']['maxBytes'],original['images']['maxBytes'],original['images']['maxEntries'])
       step('budget-restored',restored,{'restoredEqualsOriginal':all(restored['cache'][k][f]==original[k][f] for k in ('decoded','images') for f in ('maxBytes','maxEntries'))})
       result['stage']='free'; loads_idle(d); trim(d,'close-baseline')
       hold(d); y4=d.js('return window.__rhwpProbe.lease.begin("Y","y4",arguments[0],"close-acquire-Y")',page); result['unusedHolds']['close-acquire-Y']=unhold(d); step('close-acquire-Y',y4['snap'])
       step('free:X',d.js('return window.__rhwpProbe.lease.free("X")')); step('free:Y',d.js('return window.__rhwpProbe.lease.free("Y")'))
       result['released']['after-free']=release(d)  # late load events now target freed owners
       time.sleep(3); step('late-after-free',d.js('return window.__rhwpProbe.lease.snap("late-after-free")'))
       result['stage']='app-replacement'; loads_idle(d); app_idle(d)
       windows=subprocess.check_output([xdotool,'search','--onlyvisible','--name','^geul'],text=True,timeout=10).split();subprocess.run([xdotool,'windowfocus','--sync',windows[-1]],check=True,timeout=10)
       d.native_key_tool=xdotool
       before=poc.status(d); result['appBefore']={k:before.get(k) for k in ('revision','localRevision','status')}
       app_page=page
       trim(d,'app-trim')
       hold(d); acq=d.js('return window.__rhwpProbe.lease.appBegin(arguments[0],"app","app-acquire")',app_page); result['unusedHolds']['app-acquire']=unhold(d); step('app-acquire',acq['snap']); result['appPages']=acq['appPages']
       step('app-before-input',d.js('return window.__rhwpProbe.lease.snap("app-before-input")'))
       poc.type_ascii(d,'a'); result['released']['app-replacement']=release(d); app_idle(d)
       after=poc.status(d); result['appAfter']={k:after.get(k) for k in ('revision','localRevision','status')}
       if int(after['localRevision'])!=int(before['localRevision'])+1: raise RuntimeError('native input did not produce exactly one revision')
       stale=d.js('return window.__rhwpProbe.lease.appPollHeld("app-stale-poll")'); step('app-stale-poll',stale['snap'],{'channelDifferences':stale['channelDifferences']})
       d.js('window.__rhwpProbe.lease.appForget()')
       result['comparisons']['app-visible']=d.js('return window.__rhwpProbe.fullFrameCheck(0)')
       result['stage']='app-close'; loads_idle(d); trim(d,'app-close-trim')
       hold(d); step('app-close-acquire',d.js('return window.__rhwpProbe.lease.appBegin(arguments[0],"app2","app-close-acquire")',app_page)['snap']); result['unusedHolds']['app-close-acquire']=unhold(d)
       d.js('window.__rhwpProbe.lease.appForget()')
       history.close_discard(d,doc.name); wait_js(d,'return window.__geulOwnership.stats().sessions.length===0',30)
       step('app-closed',d.js('return window.__rhwpProbe.lease.snap("app-closed")'))
       result['released']['after-close']=release(d)
       time.sleep(3); step('app-late',d.js('return window.__rhwpProbe.lease.snap("app-late")'))
       result['resourceAfterClose']=d.js('return window.__geulOwnership.stats()')
       # Decoded leases (Rust-decoded PNG/JPEG backings) are retained across polls only by a preparing job.
       result['stage']='decoded'
       d.js('window.__rhwpProbe.lease.load(["P"],arguments[0],null,"/complex-hwp.hwp")',chem_sha); wait_js(d,'return window.__rhwpProbe.lease.loaded!==null',60)
       loaded_p=d.js('return window.__rhwpProbe.lease.loaded'); result['decodedDocument']=loaded_p
       if not loaded_p.get('ok'): raise RuntimeError('decoded document load failed')
       prep_original=trim(d,'P-baseline')['jobs']['preparation']['enabled']; result['preparationOriginal']=prep_original
       step('P-preparation-on',d.js('return window.__rhwpProbe.lease.preparation(true,"P-preparation-on")'))
       ppage=None; pscan=[]
       for candidate_page in range(loaded_p['pages']['P']):
        trim(d,'P-scan-trim')
        r=d.js('return window.__rhwpProbe.lease.begin("P","pscan",arguments[0],"P-scan","decoded")',candidate_page)
        pscan.append({'page':candidate_page,'outcome':r['outcome'],'polls':r['polls'],'decoded':r['snap']['jobs']['maxJobLeaseEntries']})
        if r['outcome']=='PENDING':
         d.js('return window.__rhwpProbe.lease.cancel("P",arguments[0],"P-scan-cancel")',r['id'])
         if r['snap']['jobs']['maxJobLeaseEntries']>0: ppage=candidate_page; break
       result['decodedScan']=pscan
       if ppage is None: raise RuntimeError('no page with a retained decoded lease')
       result['decodedPage']=ppage
       trim(d,'P-trim-1')
       p1=d.js('return window.__rhwpProbe.lease.begin("P","p1",arguments[0],"P-acquire","decoded")',ppage); step('P-acquire',p1['snap'])
       step('P-cancel',d.js('return window.__rhwpProbe.lease.cancel("P",arguments[0],"P-cancel")',p1['id'])['snap'])
       trim(d,'P-trim-2')
       p2=d.js('return window.__rhwpProbe.lease.begin("P","p2",arguments[0],"P-acquire-2","decoded")',ppage); step('P-acquire-2',p2['snap'])
       poll_until(d,'P',p2['id'],'P-complete')
       step('P-reference',d.js('return window.__rhwpProbe.lease.reference("P","pref",arguments[0])',ppage))
       result['comparisons']['p2-vs-ref']=d.js('return window.__rhwpProbe.lease.compare("p2","pref")')
       trim(d,'P-trim-3')
       p3=d.js('return window.__rhwpProbe.lease.begin("P","p3",arguments[0],"P-free-acquire","decoded")',ppage); step('P-free-acquire',p3['snap'])
       step('free:P',d.js('return window.__rhwpProbe.lease.free("P")'))
       time.sleep(1); step('P-late',d.js('return window.__rhwpProbe.lease.snap("P-late")'))
       # Resident eviction while a live preparing job still leases the backing (decoded path).
       result['stage']='decoded-eviction'
       a_bytes=result['steps']['P-complete']['cache']['decoded']['bytes']
       d.js('window.__rhwpProbe.lease.load(["E","Q"],arguments[0],null,"/complex-hwp.hwp")',chem_sha); wait_js(d,'return window.__rhwpProbe.lease.loaded!==null',60)
       if not d.js('return window.__rhwpProbe.lease.loaded.ok'): raise RuntimeError('eviction documents load failed')
       bpage=None; sizes=[]
       for candidate_page in range(loaded_p['pages']['P']):
        if candidate_page==ppage: continue
        trim(d,'E-size-trim'); r=d.js('return window.__rhwpProbe.lease.begin("Q","qsize",arguments[0],"E-size","decoded")',candidate_page)
        row=poll_until(d,'Q',r['id'],'E-size') if r['outcome']=='PENDING' else step('E-size',r['snap'])
        size=row['cache']['decoded']['bytes']; sizes.append({'page':candidate_page,'outcome':row['outcome'],'decodedBytes':size,'entries':row['cache']['decoded']['entries']})
        if row['outcome']=='COMPLETE' and row['cache']['decoded']['entries']==1 and 0<size<a_bytes: bpage=candidate_page; break
       result['evictionSizeScan']=sizes
       if bpage is None: raise RuntimeError('no smaller distinct decoded image page')
       result['evictionPages']={'leased':ppage,'evicting':bpage,'leasedBytes':a_bytes}
       base=trim(d,'E-trim')['cache']
       # Entry-count pressure (max 1 entry): A is admitted resident, inserting B must evict it. A byte budget
       # equal to A was tried in attempt 4 and made A itself non-resident (per-entry limit), not an eviction.
       step('E-budget',d.js('return window.__rhwpProbe.lease.setBudget(arguments[0],arguments[1],arguments[2],"E-budget")',base['decoded']['maxBytes'],base['images']['maxBytes'],1))
       e1=d.js('return window.__rhwpProbe.lease.begin("E","e1",arguments[0],"E-acquire","decoded")',ppage); step('E-acquire',e1['snap'])
       # The decoded cache admits by access frequency (surface_cache::admits): B must be requested more
       # often than the leased A before inserting B evicts A. Repeat real Q renders of page B (bounded).
       evict_before=result['steps']['E-acquire']['cache']['decoded']['evictions']; result['evictionRequests']=0
       for _ in range(40):
        q1=d.js('return window.__rhwpProbe.lease.begin("Q","q1",arguments[0],"E-evict-begin","decoded")',bpage)
        row=poll_until(d,'Q',q1['id'],'E-evict') if q1['outcome']=='PENDING' else step('E-evict',q1['snap'])
        result['evictionRequests']+=1
        if row['outcome']!='COMPLETE' or row['cache']['decoded']['evictions']>evict_before: break
       poll_until(d,'E',e1['id'],'E-complete')
       result['comparisons']['e1-vs-ref']=d.js('return window.__rhwpProbe.lease.compare("e1","pref")')
       step('E-restored',d.js('return window.__rhwpProbe.lease.setBudget(arguments[0],arguments[1],arguments[2],"E-restored")',base['decoded']['maxBytes'],base['images']['maxBytes'],base['decoded']['maxEntries']),
            {'restoredEqualsOriginal':True})
       step('free:E',d.js('return window.__rhwpProbe.lease.free("E")')); step('free:Q',d.js('return window.__rhwpProbe.lease.free("Q")'))
       result['steps']['E-restored']['restoredEqualsOriginal']=all(result['steps']['E-restored']['cache'][k]['maxBytes']==base[k]['maxBytes'] for k in ('decoded','images'))
       restored_p=d.js('return window.__rhwpProbe.lease.preparation(arguments[0],"P-restored")',prep_original)
       step('P-restored',restored_p,{'restoredEqualsOriginal':restored_p['jobs']['preparation']['enabled']==prep_original})
       result['fixtureUnchanged']=sha(doc)==svg_sha and sha(SVG)==svg_sha and sha(CHEM)==chem_sha
       verdict=lease_verdict.evaluate(result['steps'],result['outcomes'],result['comparisons']); result['leaseVerdict']=verdict
       result['checks'].update({'lease.'+k:v for k,v in verdict['checks'].items()}); result['checks']['fixtureUnchanged']=result['fixtureUnchanged']
       scope.observe(); result['stage']='shutdown'
      finally:
       if sys.exc_info()[1] is None: result['stage']='webdriver-session-delete'
       smoke.end_session(d)
     attach_teardown(result,smoke.TEARDOWN,teardown_start)
     observations_complete=all(v is True for v in result['checks'].values())
     if not observations_complete: raise RuntimeError('lease observations failed: '+', '.join(k for k,v in result['checks'].items() if v is not True))
    finally:
     record_pending(result,result['stage'],recorded)
     scope.observe(); stop_owned(vite,'vite',result)
     try:
      if log: log.close()
     except Exception as e: failure(result,'vite-log-close',e)
   finally:
    record_pending(result,result['stage'],recorded); stop_owned(display,'xvfb',result)
  finally:
   stop_owned(bus,'dbus',result)
except Exception as e:
 attach_teardown(result,smoke.TEARDOWN,teardown_start)
 if id(e) not in recorded: failure(result,result['stage'],e)
 for note in getattr(e,'__notes__',[]): failure(result,'secondary-cleanup',RuntimeError(note))
finally:
 ok=finalize(result,observations_complete)
 scope_record=scope.teardown(owned_pids=[p.pid for p in owned_popen]); result['processScope']=scope_record
 if not scope_record['cleanupSucceeded']: failure(result,'process-scope',RuntimeError('subreaper scope cleanup incomplete'))
 result['status']='PASS' if ok and scope_record['cleanupSucceeded'] and not result['failures'] else 'FAIL'
 result['executionStatus']=result['status']; result['readinessVerdict']='DIAGNOSTIC (not an official T010 gate)'
 result['cleanupScope']='child subreaper: every descendant of this harness (private dbus-daemon, Xvfb, Vite, tauri-driver, WebKitWebDriver, geul, WebKit helpers) stays in its tree until teardown'
 saved=persist_result(result,out)
 print(json.dumps({k:v for k,v in result.items() if k in ('status','stage','failures','checks','leasePage','processScope','cleanupStatus')},ensure_ascii=False))
sys.exit(0 if saved and result['status']=='PASS' else 1)
