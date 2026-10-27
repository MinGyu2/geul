"""Run the unchanged D2 producer (ownership-poc/ime-native.py) with real IBus-Hangul.

Verifies app/candidate/gate identity, starts the PoC Vite server on 1420 (history safety flag), then runs
the producer under a private D-Bus session. Output and logs go to a new raw directory; nothing is replaced.
"""
import argparse,hashlib,json,os,socket,subprocess,sys,time,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[5]; POC=ROOT/'tests/integration/rhwp/ownership-poc'
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
p=argparse.ArgumentParser(); p.add_argument('--raw',type=Path,required=True); p.add_argument('--candidate',type=Path,required=True); p.add_argument('--gates',type=Path,required=True)
a=p.parse_args(); a.raw.mkdir(parents=True,exist_ok=False)
tools={k:Path(os.environ[k]) for k in ('GEUL_TAURI_DRIVER','GEUL_WEBKIT_DRIVER','GEUL_XVFB','GEUL_XDOTOOL','GEUL_IBUS_ROOT','GEUL_HANGUL_ROOT','GEUL_GTK_QUERY','GEUL_GLIB_COMPILE','GEUL_SETXKBMAP')}
app=ROOT/'src-tauri/target/debug/geul'
record={'appSha256':sha(app),'candidate':{n:sha(a.candidate/n) for n in ('rhwp_bg.wasm','rhwp.js','ENGINE.json')},'gates':sha(a.gates/'engine-safety-gates.json'),
        'producerSha256':sha(POC/'ime-native.py'),'undoNativeSha256':sha(ROOT/'tests/integration/rhwp/undo_native.py'),'tools':{k:str(v.resolve()) for k,v in tools.items()},'loadBefore':os.getloadavg()}
if record['candidate']['rhwp_bg.wasm']!='0cb73f70cd98dbef89718534e1bc283f1cb4c200af200703d40b137be1cde956' or record['gates']!='618105f865df35bdffdac2b8d164b493201601abf06f6f51d6cee2ec005277e0': sys.exit('identity mismatch')
env={**os.environ,'VITE_GEUL_TEST_HOOKS':'1','GEUL_T010_OWNERSHIP_POC':'1','GEUL_T010_SCHEDULER_POC':'1','GEUL_T010_DAMAGE_POC':'0','GEUL_T010_CANDIDATE':str(a.candidate.resolve()),
     'GEUL_T010_EVIDENCE':str(a.gates.resolve()),'VITE_GEUL_TEST_RHWP_HISTORY':'1','GEUL_T010_HISTORY_SAFETY_ONLY':'1','WEBKIT_DISABLE_DMABUF_RENDERER':'1','LIBGL_ALWAYS_SOFTWARE':'1'}
with socket.socket() as s: s.bind(('127.0.0.1',1420))
vite=None
try:
    with (a.raw/'vite.log').open('w') as vlog, (a.raw/'producer.log').open('w') as log:
        vite=subprocess.Popen(['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--config','tests/integration/rhwp/ownership-poc/vite.config.mjs'],cwd=ROOT,env=env,stdout=vlog,stderr=subprocess.STDOUT)
        deadline=time.monotonic()+30
        while True:
            if vite.poll() is not None: raise RuntimeError('vite exited')
            try:
                with urllib.request.urlopen('http://localhost:1420',timeout=1) as r:
                    if r.status==200: break
            except OSError:
                if time.monotonic()>deadline: raise RuntimeError('vite timeout')
                time.sleep(.1)
        cmd=['dbus-run-session','--',sys.executable,str(POC/'ime-native.py'),'--app',str(app),'--driver',str(tools['GEUL_TAURI_DRIVER']),'--webkit-driver',str(tools['GEUL_WEBKIT_DRIVER']),
             '--xvfb',str(tools['GEUL_XVFB']),'--xdotool',str(tools['GEUL_XDOTOOL']),'--output',str((a.raw/'result.json').resolve()),'--ibus-root',str(tools['GEUL_IBUS_ROOT'].resolve()),
             '--hangul-root',str(tools['GEUL_HANGUL_ROOT'].resolve()),'--gtk-query',str(tools['GEUL_GTK_QUERY']),'--glib-compile',str(tools['GEUL_GLIB_COMPILE']),'--setxkbmap',str(tools['GEUL_SETXKBMAP'])]
        proc=subprocess.Popen(cmd,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        record['producerExit']=proc.wait(timeout=1800)
except Exception as e: record['error']=f'{type(e).__name__}: {e}'
finally:
    if vite: vite.terminate(); vite.wait(timeout=10)
    record['loadAfter']=os.getloadavg()
    (a.raw/'execution.json').write_text(json.dumps(record,indent=2).replace(str(ROOT),'<workspace>').replace(str(Path.home()),'<home>')+'\n')
print(json.dumps({k:record.get(k) for k in ('producerExit','error')}))
