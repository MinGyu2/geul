"""Native strict D1 for the unchanged decoded-lease candidate with a read-only process-lifecycle observer.

Same harness, flags and tools as t010-decoded-lease-contract-finalization/run-native.py. Differences:
- engine gates are read from that directory (same candidate WASM ca5c0b84…; not regenerated);
- every run is a numbered attempt (native-d1-attemptN.json) and is never retried or overwritten;
- an observer thread samples /proc every 100 ms and records only processes whose environment carries this
  attempt's random GEUL_NATIVE_OBSERVE token (inherited by Vite, dbus, tauri-driver, WebKitWebDriver, the app
  and WebKit helpers). It reads comm/stat only, never signals anything, and stores no command lines or
  environment values. The harness's own cleanup contract (30 s, then SIGTERM, then FAIL) is unchanged.
Usage: python3 run-native.py ATTEMPT CANDIDATE_PACKAGE EXPECTED_WASM_SHA256
"""
from pathlib import Path
import subprocess,os,json,sys,time,urllib.request,socket,hashlib,tempfile,threading,secrets
root=Path(__file__).resolve().parents[5];out=Path(__file__).resolve().parent
attempt=int(sys.argv[1]);candidate=Path(sys.argv[2]);expected=sys.argv[3]
gates=out.parent/'t010-decoded-lease-contract-finalization'/'engine-gates'
P='tests/integration/rhwp/ownership-poc/';script='performance-visual-native.py'
output=out/f'native-d1-attempt{attempt}.json';lifecycle=out/f'native-d1-attempt{attempt}-lifecycle.json'
if output.exists() or lifecycle.exists():raise SystemExit('preserve previous result')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(candidate/'rhwp_bg.wasm')==expected
relevant=[root/(P+n) for n in ('session.mjs','vite.config.mjs','native.py','generate.mjs',script)]+[root/n for n in ('tests/integration/rhwp/undo_native.py','tests/integration/rhwp/native_probe.py','tests/integration/rhwp/rhwp_poc.py','tests/e2e/tauri_smoke.py','tests/fixtures/rhwp/generate.mjs','src-tauri/target/debug/geul')]+[candidate/n for n in ('rhwp.js','rhwp_bg.wasm','ENGINE.json')]
relevant += [gates/n for n in ('engine-safety-gates.json','chrome.json','webkit.json')]
def digest():return {str(p.relative_to(root) if p.is_relative_to(root) else p.name):sha(p) for p in relevant}
token=secrets.token_hex(16)
env=dict(os.environ);env.update(VITE_GEUL_TEST_HOOKS='1',GEUL_T010_OWNERSHIP_POC='1',GEUL_T010_SCHEDULER_POC='1',GEUL_T010_DAMAGE_POC='0',GEUL_T010_CANDIDATE=str(candidate),GEUL_T010_EVIDENCE=str(gates),VITE_GEUL_TEST_RHWP_HISTORY='1',GEUL_NATIVE_OBSERVE=token)
env['GEUL_T010_HISTORY_SAFETY_ONLY']='1'
marker=f'GEUL_NATIVE_OBSERVE={token}'.encode()+b'\0'
t0=time.monotonic();events=[];seen={};stop=threading.Event();samples=[0]
def stat(pid):
 text=Path(f'/proc/{pid}/stat').read_text();head,tail=text.rsplit(')',1);fields=tail.split()
 return head.split('(',1)[1],fields[0],int(fields[1]),int(fields[2])
def observe():
 while True:
  now=round(time.monotonic()-t0,2);alive=set()
  for entry in Path('/proc').iterdir():
   if not entry.name.isdigit():continue
   pid=int(entry.name)
   try:
    if pid not in seen and marker not in (entry/'environ').read_bytes():continue
    comm,state,ppid,pgid=stat(pid)
   except (OSError,ValueError,IndexError):continue
   alive.add(pid);row=seen.get(pid)
   if row is None:
    seen[pid]=row={'pid':pid,'comm':comm,'firstSeen':now,'ppid':ppid,'pgid':pgid,'states':{}}
    events.append({'t':now,'event':'appeared','pid':pid,'comm':comm,'ppid':ppid})
   elif row['ppid']!=ppid:
    events.append({'t':now,'event':'reparented','pid':pid,'comm':row['comm'],'from':row['ppid'],'to':ppid});row['ppid']=ppid
   row['states'][state]=row['states'].get(state,0)+1;row['lastSeen']=now
  for pid,row in seen.items():
   if 'gone' not in row and pid not in alive:
    row['gone']=now;events.append({'t':now,'event':'gone','pid':pid,'comm':row['comm']})
  samples[0]+=1
  if stop.is_set():break
  time.sleep(0.1)
observer=threading.Thread(target=observe,daemon=True);observer.start()
with socket.socket() as port:
 port.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
 port.bind(('127.0.0.1',1420))
serve=['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--config',P+'vite.config.mjs']
logs=Path(tempfile.gettempdir());load=[os.getloadavg()]
with open(logs/f'geul-readiness-vite-d1-{attempt}.log','w') as log:
 process=subprocess.Popen(serve,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
 try:
  deadline=time.monotonic()+30
  while True:
   if process.poll() is not None:raise RuntimeError('Vite exited')
   try:
    with urllib.request.urlopen('http://localhost:1420',timeout=1) as r:
     if r.status==200:break
   except OSError:
    if time.monotonic()>deadline:raise RuntimeError('Vite timeout')
    time.sleep(.1)
  cmd=['dbus-run-session','--','python3',P+script,'--app',str(root/'src-tauri/target/debug/geul'),'--driver',os.environ['GEUL_TAURI_DRIVER'],'--webkit-driver','/nix/store/p7h9r90h1vmk4wq1964nhd8vfp0kf27b-webkitgtk-2.54.1+abi=4.1/bin/WebKitWebDriver','--xvfb','/nix/store/7yz3bnmll7fy11n0xci85mbhnf6p5669-xvfb-21.1.23/bin/Xvfb','--xdotool','/nix/store/kyp2r08w6hs0l1zj3cya6d2ciba9v47h-xdotool-3.20211022.1/bin/xdotool','--output',str(output)]
  before=digest();start=time.monotonic();events.append({'t':round(start-t0,2),'event':'harness-start'})
  with open(logs/f'geul-readiness-native-d1-{attempt}.log','w') as native_log:p=subprocess.run(cmd,cwd=root,env=env,stdout=native_log,stderr=subprocess.STDOUT)
  events.append({'t':round(time.monotonic()-t0,2),'event':'harness-exit','exit':p.returncode});load.append(os.getloadavg())
  result=json.loads(output.read_text()) if output.exists() else dict(status='FAIL',error='no result')
  result.update(parentExit=p.returncode,executedDependenciesStable=digest()==before,executedDependencySha256=before,candidateWasmSha256=expected,command=cmd,activationFlags={k:v for k,v in env.items() if k.startswith(('GEUL_T010','VITE_GEUL'))},elapsedSeconds=time.monotonic()-start)
  text=json.dumps(result,ensure_ascii=False,indent=2).replace(str(root),'<workspace>')
  for private,label in ((os.environ.get('GEUL_EVIDENCE_SCRATCH'),'<scratch>'),(str(Path.home()),'<home>')):
   if private:text=text.replace(private,label)
  output.write_text(text+'\n')
  print(attempt,p.returncode,result.get('status'),result.get('error'),result.get('executedDependenciesStable'),flush=True)
 finally:
  process.terminate()
  try:process.wait(timeout=10)
  except subprocess.TimeoutExpired:process.kill();process.wait(timeout=10)
  time.sleep(1);stop.set();observer.join(5)
  owned=sorted(seen.values(),key=lambda r:r['firstSeen'])
  lifecycle.write_text(json.dumps({'schema':1,'attempt':attempt,'observer':'read-only /proc sampling, 100 ms; processes carrying this attempt token only',
   'samples':samples[0],'loadAverage':{'start':load[0],'end':load[-1]},'cpuCount':os.cpu_count(),
   'processes':owned,'events':events,'leftAtEnd':[r for r in owned if 'gone' not in r]},indent=1)+'\n')
raise SystemExit(p.returncode)
