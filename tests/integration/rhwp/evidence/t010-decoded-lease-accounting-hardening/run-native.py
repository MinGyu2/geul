"""Native strict D1 / pending / safety for the decoded-lease hardening candidate; one result per mode, no retries.

Adapted from t010-decoded-resource-lease-accounting/run-native.py: same scripts, flags and tools; only this
evidence directory (gates, outputs) differs, tauri-driver may be given by GEUL_TAURI_DRIVER, and logs go to
the temporary directory. Usage: python3 run-native.py d1|pending|safety CANDIDATE_PACKAGE EXPECTED_WASM_SHA256
"""
from pathlib import Path
import subprocess,os,json,sys,time,urllib.request,socket,hashlib,tempfile
root=Path(__file__).resolve().parents[5];out=Path(__file__).resolve().parent;mode=sys.argv[1]
if mode not in ('d1','pending','safety'): raise SystemExit('only candidate safety verification is in scope')
candidate=Path(sys.argv[2]);expected=sys.argv[3]
gates=out/'engine-gates'
P='tests/integration/rhwp/ownership-poc/'
modes={'d1':('performance-visual-native.py','native-d1.json'),'pending':('history-pending-native.py','native-pending.json'),'safety':('candidate-safety.py','native-safety.json')}
script,name=modes[mode];output=out/name
if output.exists():raise SystemExit('preserve previous result')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(candidate/'rhwp_bg.wasm')==expected
relevant=[root/(P+n) for n in ('session.mjs','vite.config.mjs','native.py','generate.mjs',script)]+[root/n for n in ('tests/integration/rhwp/undo_native.py','tests/integration/rhwp/native_probe.py','tests/integration/rhwp/rhwp_poc.py','tests/e2e/tauri_smoke.py','tests/fixtures/rhwp/generate.mjs','src-tauri/target/debug/geul')]+[candidate/n for n in ('rhwp.js','rhwp_bg.wasm','ENGINE.json')]
relevant += [gates/n for n in ('engine-safety-gates.json','chrome.json','webkit.json')]
def digest():return {str(p):sha(p) for p in relevant}
env=dict(os.environ);env.update(VITE_GEUL_TEST_HOOKS='1',GEUL_T010_OWNERSHIP_POC='1',GEUL_T010_SCHEDULER_POC='1',GEUL_T010_DAMAGE_POC='0',GEUL_T010_CANDIDATE=str(candidate),GEUL_T010_EVIDENCE=str(gates),VITE_GEUL_TEST_RHWP_HISTORY='1')
env['GEUL_T010_HISTORY_SAFETY_ONLY']='1'
with socket.socket() as port:
 port.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
 port.bind(('127.0.0.1',1420))
serve=['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--config',P+'vite.config.mjs']
logs=Path(tempfile.gettempdir())
with open(logs/('geul-decoded-hardening-vite-'+mode+'.log'),'w') as log:
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
  cmd=['dbus-run-session','--','python3',P+script,'--app',str(root/'src-tauri/target/debug/geul'),'--driver',os.environ.get('GEUL_TAURI_DRIVER','/tmp/geul-t010-ownership-tools/bin/tauri-driver'),'--webkit-driver','/nix/store/p7h9r90h1vmk4wq1964nhd8vfp0kf27b-webkitgtk-2.54.1+abi=4.1/bin/WebKitWebDriver','--xvfb','/nix/store/7yz3bnmll7fy11n0xci85mbhnf6p5669-xvfb-21.1.23/bin/Xvfb','--xdotool','/nix/store/kyp2r08w6hs0l1zj3cya6d2ciba9v47h-xdotool-3.20211022.1/bin/xdotool','--output',str(output)]
  before=digest();start=time.monotonic()
  with open(logs/('geul-decoded-hardening-native-'+mode+'.log'),'w') as native_log:p=subprocess.run(cmd,cwd=root,env=env,stdout=native_log,stderr=subprocess.STDOUT)
  result=json.loads(output.read_text()) if output.exists() else dict(status='FAIL',error='no result')
  result.update(parentExit=p.returncode,executedDependenciesStable=digest()==before,executedDependencySha256=before,candidateWasmSha256=expected,command=cmd,activationFlags={k:v for k,v in env.items() if k.startswith(('GEUL_T010','VITE_GEUL'))},elapsedSeconds=time.monotonic()-start)
  text=json.dumps(result,ensure_ascii=False,indent=2).replace(str(root),'<workspace>')
  for private,label in ((os.environ.get('GEUL_EVIDENCE_SCRATCH'),'<scratch>'),(str(Path.home()),'<home>')):
   if private:text=text.replace(private,label)
  output.write_text(text+'\n')
  print(mode,p.returncode,result.get('status'),result.get('error'),result.get('executedDependenciesStable'),flush=True)
 finally:
  process.terminate()
  try:process.wait(timeout=10)
  except subprocess.TimeoutExpired:process.kill();process.wait(timeout=10)
raise SystemExit(p.returncode)
