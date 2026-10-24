#!/usr/bin/env python3
"""Local standalone Chrome phase probe, frozen baseline and isolated instrumented WASM."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import tempfile
import threading


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('baseline','phase','chrome','fixtures','output'):p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--probe',choices=('edit','render'),default='edit')
    a=p.parse_args()
    if a.output.exists():p.error('preserve previous output')
    here=Path(__file__).resolve().parent
    probe=here/('edit-phases-browser.mjs' if a.probe=='edit' else 'render-phases-browser.mjs')
    chemical=here.parents[3]/'external/rhwp/samples/rnote/연구노트(화학).hwp'
    asset=here.parents[3]/'external/rhwp/samples/issue6031/3249937_asset_management_rules.hwpx'
    def hashes():
        paths=[probe,here/'run-edit-phases.py',asset,chemical,a.fixtures/'basic-ko.hwpx']
        paths += [base/f for base in (a.baseline,a.phase) for f in ('rhwp.js','rhwp_bg.wasm')]
        paths += list((a.phase/'snippets').rglob('*.js'))
        return {str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in paths}
    before=hashes()
    received=[]
    completed=threading.Event()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_POST(self):
            size=int(self.headers.get('Content-Length','0'))
            if self.path!='/result' or not 0<size<4<<20:self.send_error(400);return
            received.append(json.loads(self.rfile.read(size)))
            self.send_response(204);self.end_headers();completed.set()
        def do_GET(self):
            name=self.path.split('?')[0];data=None;mime='text/javascript'
            if name=='/':data=b'<body>RUNNING</body><script type="module" src="/probe.mjs"></script>';mime='text/html'
            elif name=='/probe.mjs':data=probe.read_bytes()
            elif name=='/fixtures/chemical.hwp':data=chemical.read_bytes();mime='application/octet-stream'
            elif name=='/fixtures/basic-ko.hwpx':data=(a.fixtures/'basic-ko.hwpx').read_bytes();mime='application/octet-stream'
            elif name=='/fixtures/'+asset.name:data=asset.read_bytes();mime='application/octet-stream'
            else:
                for prefix,base in (('/baseline/',a.baseline),('/phase/',a.phase)):
                    if name.startswith(prefix):
                        target=(base/name[len(prefix):]).resolve()
                        if target.is_relative_to(base.resolve()) and target.is_file():
                            data=target.read_bytes();mime='application/wasm' if target.suffix=='.wasm' else 'text/javascript'
            if data is None:self.send_error(404);return
            self.send_response(200);self.send_header('Content-Type',mime);self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix='geul-d4-phase-chrome-') as profile:
            cmd=[str(a.chrome),'--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--user-data-dir='+profile,'http://127.0.0.1:'+str(server.server_port)]
            with tempfile.TemporaryFile(mode='w+') as log:
                process=subprocess.Popen(cmd,stdout=log,stderr=log)
                try:
                    for _ in range(4):
                        if completed.wait(40):break
                        if process.poll() is not None:break
                        print('phase diagnostic still running',flush=True)
                    result=received[0] if received else {'status':'FAIL','error':'no browser result'}
                finally:
                    process.terminate()
                    try:process.wait(timeout=10)
                    except subprocess.TimeoutExpired:process.kill();process.wait(timeout=10)
                log.seek(0);result['browserLogTail']=log.read()[-2000:]
            returncode=0 if received else 1
            result.update(parentExit=returncode,command=cmd,identities=before,executedDependenciesStable=hashes()==before,
                          browserVersion=subprocess.check_output([str(a.chrome),'--version'],text=True).strip())
            a.output.write_text(json.dumps(result,ensure_ascii=False,indent=2).replace(str(here.parents[3]),'<workspace>')+'\n')
            return 0 if result['status']=='DIAGNOSTIC_COMPLETE' and returncode==0 else 1
    finally:server.shutdown();server.server_close();thread.join()


if __name__=='__main__':raise SystemExit(main())
