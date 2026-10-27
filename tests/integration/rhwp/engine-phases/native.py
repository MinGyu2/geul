#!/usr/bin/env python3
"""Run existing native producers on a browser-validated candidate; never approves an anchor."""
import argparse
import hashlib
import json
import os
import signal
import socket
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
POC = HERE.parent/'ownership-poc'


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--candidate', type=Path, required=True); p.add_argument('--gates', type=Path, required=True)
    p.add_argument('--mode', choices=['d1', 'd4'], required=True); p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    if a.output.exists(): p.error('preserve existing native evidence')
    a.output.mkdir(parents=True)
    tools = {key: Path(os.environ[key]) for key in ['GEUL_TAURI_DRIVER','GEUL_WEBKIT_DRIVER','GEUL_XVFB','GEUL_XDOTOOL']}
    app = ROOT/'src-tauri/target/debug/geul'; meta = json.loads((a.candidate/'ENGINE.json').read_text())
    gate = json.loads((a.gates/'engine-safety-gates.json').read_text())
    if meta['buildStatus'] != 'PASS' or meta['sourceStableDuringBuild'] is not True or gate['status'] != 'PASS': raise ValueError('candidate preflight failed')
    if gate['wasmSha256'] != digest(a.candidate/'rhwp_bg.wasm'): raise ValueError('gate artifact mismatch')
    for browser in ['chrome','webkit']:
        value = json.loads((a.gates/(browser+'.json')).read_text())
        if value['status'] != 'PASS' or value['identities']['candidate']['rhwp_bg.wasm'] != gate['wasmSha256']: raise ValueError('browser preflight mismatch')
    files = {'app':app, 'runner':Path(__file__), **{k:v for k,v in tools.items()}}
    for base in [ROOT/'src', POC, HERE.parent/'render-preparation-hardening']:
        for f in base.rglob('*'):
            if f.is_file() and f.suffix in ['.ts','.tsx','.py','.mjs','.json']: files[str(f.relative_to(ROOT))]=f
    for f in [ROOT/'tests/integration/rhwp/undo_native.py',ROOT/'tests/integration/rhwp/native_probe.py',ROOT/'tests/e2e/tauri_smoke.py',ROOT/'vite.config.ts']:
        files[str(f.relative_to(ROOT))]=f
    for base,label in [(a.candidate,'candidate'),(a.gates,'preflight')]:
        for f in base.rglob('*'):
            if f.is_file(): files[label+'/'+str(f.relative_to(base))]=f
    hashes = lambda: {k:digest(v) for k,v in files.items()}
    before=hashes(); result={'officialApproval':False,'mode':a.mode,'status':'FAIL','inputsBefore':before}
    env={**os.environ,'VITE_GEUL_TEST_HOOKS':'1','GEUL_T010_OWNERSHIP_POC':'1','GEUL_T010_SCHEDULER_POC':'1',
         'GEUL_T010_DAMAGE_POC':'0','GEUL_T010_CANDIDATE':str(a.candidate.resolve()),'GEUL_T010_EVIDENCE':str(a.gates.resolve()),
         'VITE_GEUL_TEST_RHWP_HISTORY':'1','GEUL_T010_HISTORY_PERF_ONLY':'1', 'WEBKIT_DISABLE_DMABUF_RENDERER':'1','LIBGL_ALWAYS_SOFTWARE':'1'}
    vite=None
    try:
        if a.mode=='d1':
            cmd=[sys.executable,str(HERE.parent/'render-preparation-hardening/diagnose_native.py'),'--candidate',str(a.candidate.resolve()),
                 '--gates',str(a.gates.resolve()),'--label','producer','--output-dir',str(a.output.resolve())]
            payload=a.output/'producer/result.json'; summary=a.output/'producer/summary.json'
        else:
            payload=a.output/'result.json'; summary=None
            cmd=['dbus-run-session','--',sys.executable,str(POC/'history-perf.py'),'--app',str(app),'--driver',str(tools['GEUL_TAURI_DRIVER']),
                 '--webkit-driver',str(tools['GEUL_WEBKIT_DRIVER']),'--xvfb',str(tools['GEUL_XVFB']),'--xdotool',str(tools['GEUL_XDOTOOL']),
                 '--output',str(payload.resolve())]
        with (a.output/'vite.log').open('w') as v_log, (a.output/'launcher.log').open('w') as log:
            if a.mode=='d4':
                with socket.socket() as reservation: reservation.bind(('127.0.0.1',1420))
                vite=subprocess.Popen(['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--config','tests/integration/rhwp/ownership-poc/vite.config.mjs'],cwd=ROOT,env=env,stdout=v_log,stderr=subprocess.STDOUT)
                deadline=time.monotonic()+30
                while True:
                    if vite.poll() is not None: raise RuntimeError('Vite exited before ready')
                    try:
                        with urllib.request.urlopen('http://localhost:1420',timeout=1) as response:
                            if response.status==200:break
                    except OSError:
                        if time.monotonic()>deadline:raise RuntimeError('Vite readiness timeout')
                        time.sleep(.1)
            process=subprocess.Popen(cmd,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            try: result['producerExit']=process.wait(timeout=900)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid,signal.SIGTERM)
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: os.killpg(process.pid,signal.SIGKILL);process.wait()
                raise RuntimeError('native producer timed out; owned process group stopped')
        if not payload.is_file():raise ValueError('missing producer result')
        value=json.loads(payload.read_text());result.update(producerStatus=value.get('status'),producerResultSha256=digest(payload))
        if summary:
            extra=json.loads(summary.read_text());result['diagnosticSummary']=extra
            if extra.get('status')!='PASS':raise ValueError('native D1 diagnostic failed')
        result['status']='PASS' if result['producerExit']==0 and value.get('status')=='PASS' and not value.get('error') else 'FAIL'
        if a.mode=='d4':result['classification']={k:value.get(k) for k in ['measurementComplete','exitReason','failedGateCount']}
    except Exception as error:result['error']=str(error)
    finally:
        if vite:
            vite.terminate()
            try:vite.wait(timeout=10)
            except subprocess.TimeoutExpired:vite.kill();vite.wait()
        after=hashes();result.update(inputsAfter=after,executedDependenciesStable=before==after)
        if before!=after:result.update(status='FAIL',identityError='executed dependencies changed')
        (a.output/'execution.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(a.mode,result['status'],result.get('error'),flush=True)
    return 0 if result['status']=='PASS' else 1


if __name__=='__main__':sys.exit(main())
