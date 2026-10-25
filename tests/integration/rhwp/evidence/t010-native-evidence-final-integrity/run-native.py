"""엄격 native D1 schema 3 / manifest v3 실행. 이전 wrapper의 소유·정리·관찰 producer 보존."""
from pathlib import Path
import argparse,subprocess,os,json,sys,time,urllib.request,socket,hashlib,tempfile,threading,secrets
root=Path(__file__).resolve().parents[5];here=Path(__file__).resolve().parent
P='tests/integration/rhwp/ownership-poc/';script='performance-visual-native.py'
sys.path.insert(0,str(root/P))
import native_d1_result as contract
a=argparse.ArgumentParser(description=__doc__)
a.add_argument('--attempt',type=int,required=True);a.add_argument('--candidate',type=Path,required=True)
a.add_argument('--expected-wasm',required=True);a.add_argument('--output-dir',type=Path,default=here)
args=a.parse_args();attempt,candidate,expected,out=args.attempt,args.candidate,args.expected_wasm,args.output_dir
gates=root/'tests/integration/rhwp/evidence/t010-decoded-lease-contract-finalization/engine-gates'
output=out/f'native-d1-attempt{attempt}.json';lifecycle=out/f'native-d1-attempt{attempt}-lifecycle.json'
verdict_path=out/f'native-d1-attempt{attempt}-wrapper-verdict.json'
if any(p.exists() for p in (output,lifecycle,verdict_path)):raise SystemExit('preserve previous result')
tools={k:os.environ[k] for k in ('GEUL_TAURI_DRIVER','GEUL_WEBKIT_DRIVER','GEUL_XVFB','GEUL_XDOTOOL')}
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
wasm_before=sha(candidate/'rhwp_bg.wasm')
try:trusted=contract.load_trust_anchor(root)
except (OSError,ValueError,KeyError,subprocess.CalledProcessError) as error:raise SystemExit(f'trust anchor unavailable ({type(error).__name__}); not run')
if expected!=trusted['rhwp_bg.wasm']:raise SystemExit(f'--expected-wasm {expected} != committed trust anchor {trusted["rhwp_bg.wasm"]}; not run')
if wasm_before!=expected:raise SystemExit(f'candidate WASM {wasm_before} != expected {expected}; not run')
if Path(__file__).resolve()!=root/contract.NATIVE_WRAPPER:raise SystemExit('authoritative wrapper path mismatch')
manifest=contract.CURRENT_MANIFEST
def digest():return contract.dependency_digests(root,candidate,manifest)
# Preflight precedes Vite execution. Missing inputs must not launch the harness.
preflight=digest()
v=contract.Verdict();contract.check_dependencies(v,preflight,preflight,manifest,trusted)
if v.failures:raise SystemExit('dependency preflight failed: '+str(v.failures))
if not contract.pinned_samples_valid(root):raise SystemExit('pinned samples invalid')
with tempfile.TemporaryDirectory(prefix='geul-independent-fixture-check-') as fixture_dir:
 subprocess.run(['node',str(root/'tests/fixtures/rhwp/generate.mjs'),fixture_dir],check=True,capture_output=True)
 for name in contract.SAMPLES[:2]:
  if sha(Path(fixture_dir)/name)!=contract.FIXTURE_SHA256[name]:raise SystemExit('generated fixture identity mismatch: '+name)
token=secrets.token_hex(16)
env=dict(os.environ);env.update(VITE_GEUL_TEST_HOOKS='1',GEUL_T010_OWNERSHIP_POC='1',GEUL_T010_SCHEDULER_POC='1',GEUL_T010_DAMAGE_POC='0',GEUL_T010_CANDIDATE=str(candidate),GEUL_T010_EVIDENCE=str(gates),VITE_GEUL_TEST_RHWP_HISTORY='1',GEUL_NATIVE_OBSERVE=token)
env['GEUL_T010_HISTORY_SAFETY_ONLY']='1'
marker=f'GEUL_NATIVE_OBSERVE={token}'.encode()+b'\0'
t0=time.monotonic();events=[];seen={};stop=threading.Event();samples=[0];observer_error=[None]
def stat(pid):
 text=Path(f'/proc/{pid}/stat').read_text();head,tail=text.rsplit(')',1);fields=tail.split()
 return head.split('(',1)[1],fields[0],int(fields[1]),int(fields[2])
def observe():
 try:
  while True:
   now=round(time.monotonic()-t0,2);alive=set()
   for entry in Path('/proc').iterdir():
    if not entry.name.isdigit():continue
    pid=int(entry.name)
    if pid in seen and 'gone' in seen[pid]:continue  # a reused PID is not the owned process
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
 except Exception as error:
  observer_error[0]=f'{type(error).__name__}: {error}'[:300]
def sanitize(text):
 text=text.replace(str(root),'<workspace>')
 for private,label in ((os.environ.get('GEUL_EVIDENCE_SCRATCH'),'<scratch>'),(str(Path.home()),'<home>')):
  if private:text=text.replace(private,label)
 return text
observer=threading.Thread(target=observe,daemon=True);observer.start()
harness_exit=None;before=preflight;after=None;wasm_after=None;evidence_errors=[];lifecycle_record=None;wrapper_error=None
with socket.socket() as port:
 port.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
 port.bind(('127.0.0.1',1420))
serve=['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--config',P+'vite.config.mjs']
logs=Path(tempfile.gettempdir());load=[os.getloadavg()]
cmd=['dbus-run-session','--','python3',P+script,'--app',str(root/'src-tauri/target/debug/geul'),'--driver',tools['GEUL_TAURI_DRIVER'],'--webkit-driver',tools['GEUL_WEBKIT_DRIVER'],'--xvfb',tools['GEUL_XVFB'],'--xdotool',tools['GEUL_XDOTOOL'],'--output',str(output)]
start=time.monotonic()
try:
 with open(logs/f'geul-final-integrity-vite-d1-{attempt}.log','w') as log:
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
   start=time.monotonic();events.append({'t':round(start-t0,2),'event':'harness-start'})
   with open(logs/f'geul-final-integrity-native-d1-{attempt}.log','w') as native_log:p=subprocess.run(cmd,cwd=root,env=env,stdout=native_log,stderr=subprocess.STDOUT)
   harness_exit=p.returncode
   events.append({'t':round(time.monotonic()-t0,2),'event':'harness-exit','exit':p.returncode});load.append(os.getloadavg())
   after=digest();wasm_after=sha(candidate/'rhwp_bg.wasm')
  finally:
   process.terminate()
   try:process.wait(timeout=10)
   except subprocess.TimeoutExpired:process.kill();process.wait(timeout=10)
except Exception as error:
 wrapper_error=f'{type(error).__name__}: {error}'[:300]
finally:
 time.sleep(1);stop.set();observer.join(5)
 owned=sorted(seen.values(),key=lambda r:r['firstSeen'])
 lifecycle_record={'schema':2,'attempt':attempt,'observer':'read-only /proc sampling, 100 ms; processes carrying this attempt token only',
  'samples':samples[0],'observerError':observer_error[0],'observerStopped':not observer.is_alive(),
  'loadAverage':{'start':load[0],'end':load[-1]},'cpuCount':os.cpu_count(),
  'processes':owned,'events':events,'leftAtEnd':[r for r in owned if 'gone' not in r]}
 try:lifecycle.write_text(json.dumps(lifecycle_record,indent=1)+'\n')
 except OSError as error:evidence_errors.append(f'lifecycle write: {type(error).__name__}: {error}'[:300])
if wrapper_error:evidence_errors.append('wrapper: '+wrapper_error)
# Read the harness JSON without replacing it when it is missing or malformed.
result=None;result_error='missing'
if output.exists():
 try:
  result=contract.loads_strict(output.read_text());result_error=None
  if not isinstance(result,dict):result_error=f'top-level {type(result).__name__}';result=None
 except (OSError,UnicodeDecodeError,ValueError) as error:result_error=f'{type(error).__name__}: {error}'[:300]
verdict=contract.validate(harness_exit=harness_exit,result=result,result_error=result_error,expected_wasm=expected,
 candidate_wasm_before=wasm_before,candidate_wasm_after=wasm_after,dependencies_before=before,dependencies_after=after,
 lifecycle=lifecycle_record,trusted_identity=trusted,manifest_version=manifest,attempt=attempt,evidence_errors=evidence_errors)
if result is not None:
 result.update(parentExit=harness_exit,executedDependenciesStable=before is not None and before==after,executedDependencySha256=before,executedDependencySha256After=after,dependencyManifest=manifest,candidateWasmSha256=expected,command=cmd,activationFlags={k:v for k,v in env.items() if k.startswith(('GEUL_T010','VITE_GEUL'))},elapsedSeconds=time.monotonic()-start,wrapperVerdict=verdict)
 try:output.write_text(sanitize(json.dumps(result,ensure_ascii=False,indent=2))+'\n')
 except OSError as error:
  verdict=contract.validate(harness_exit=harness_exit,result=result,result_error=None,expected_wasm=expected,
   candidate_wasm_before=wasm_before,candidate_wasm_after=wasm_after,dependencies_before=before,dependencies_after=after,
   lifecycle=lifecycle_record,trusted_identity=trusted,manifest_version=manifest,attempt=attempt,evidence_errors=evidence_errors+[f'result write: {type(error).__name__}: {error}'[:300]])
record={'schema':1,'record':'wrapper verdict (not harness output)','attempt':attempt,'harnessExit':harness_exit,
 'resultFile':output.name if output.exists() else None,'resultError':result_error,'resultRewritten':result is not None,
 'lifecycleFile':lifecycle.name if lifecycle.exists() else None,'verdict':verdict}
try:verdict_path.write_text(sanitize(json.dumps(record,ensure_ascii=False,indent=2))+'\n')
except OSError as error:
 print(f'wrapper verdict not written: {type(error).__name__}: {error}',file=sys.stderr)
 verdict={**verdict,'status':'FAIL'}
code=contract.exit_code(verdict,harness_exit)
if code==0 and not verdict_path.exists():code=3
print(attempt,harness_exit,verdict['status'],verdict['categories'],[f['invariant'] for f in verdict['failures']][:5],flush=True)
raise SystemExit(code)
