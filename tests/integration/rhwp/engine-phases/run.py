#!/usr/bin/env python3
"""Fresh real-time Chrome diagnostic, explicitly separate from official native D4."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]


def validate(result, config=None):
    check_order = config is not None or 'requestConfig' in result
    config = config or result.get('requestConfig', {'arms': ['baseline', 'off', 'on'], 'trials': 3})
    arms = set(config['arms'])
    if arms not in ({'baseline', 'off', 'on'}, {'baseline', 'off', 'on', 'candidate'}) or config['trials'] not in (3, 8):
        raise ValueError('unsupported diagnostic matrix')
    if result.get('status') != 'DIAGNOSTIC_COMPLETE' or result.get('official') is not False:
        raise ValueError('diagnostic did not complete')
    rows = result.get('rows', [])
    expected = {(s, p, t) for s, pages in [('basic-ko.hwp', [0]), ('basic-ko.hwpx', [0]),
        ('chemical.hwp', [0,14,15,16,19,20,21,23]), ('asset.hwpx', [0])]
        for p in pages for t in range(config['trials'])}
    if len(rows) != len(expected) or {(r['sample'],r['page'],r['trial']) for r in rows} != expected:
        raise ValueError('incomplete/duplicate measurement matrix')
    for row in rows:
        if check_order and (len(row.get('armOrder', [])) != len(arms) or set(row['armOrder']) != arms):
            raise ValueError('incomplete arm execution order')
        if row.get('exactRGBA') is not True: raise ValueError('RGBA disagreement')
        if set(row.get('arms', {})) != arms: raise ValueError('missing arm')
        for arm in arms:
            r = row['arms'][arm]
            if type(r.get('polls')) is not int or not 1 <= r['polls'] <= 512: raise ValueError('invalid poll count')
            for key in ['ms', 'queueMs', 'afterPublicationRaf1Ms', 'afterPublicationRaf2Ms']:
                value = r.get(key)
                if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                    raise ValueError('invalid wall timing')
            if r['outcome'] != 'COMPLETE' or r['traceComplete'] is not True or r['dropped'] != 0:
                raise ValueError('job/trace incomplete')
        phases = row['arms']['on']['phases']
        if not phases or not any(p['name'] == 'poll.total' for p in phases):
            raise ValueError('missing total phase')
        ids = {p['id'] for p in phases}
        if len(ids) != len(phases): raise ValueError('duplicate span')
        for phase in phases:
            if phase['parent'] is not None and phase['parent'] not in ids: raise ValueError('missing parent')
            for key in ['at','ms']:
                value = phase[key]
                if type(value) not in (int,float) or not math.isfinite(value):
                    raise ValueError('invalid timing')
            if phase['ms'] < 0: raise ValueError('negative monotonic span')
            context = phase.get('context', {})
            if any(context.get(k) != row[k] for k in ['sample', 'page', 'trial']) or context.get('arm') != 'on':
                raise ValueError('wrong span context')
            if phase['parent'] is not None:
                parent = next(p for p in phases if p['id'] == phase['parent'])
                if parent['at'] > phase['at'] or phase['at'] + phase['ms'] > parent['at'] + parent['ms'] + 0.01:
                    raise ValueError('span outside parent')
        if not any(p['parent'] is None and p['name'] == 'poll.total' for p in phases):
            raise ValueError('missing root poll')
    if check_order:
        for sample, page in {(r['sample'], r['page']) for r in rows}:
            group = [r for r in rows if r['sample'] == sample and r['page'] == page]
            for arm in arms:
                counts = [sum(r['armOrder'][position] == arm for r in group) for position in range(len(arms))]
                if max(counts) - min(counts) > 1: raise ValueError('unbalanced arm order')
    if set(result.get('cleanup', {})) != arms: raise ValueError('missing cleanup')
    for cleanup in result['cleanup'].values():
        j,c=cleanup['jobs'],cleanup['cache']
        if j['activeJobs'] != 0 or j['activeLeaseCount'] != 0 or j['ownedEstimatedBytes'] != 0 or c['decoded']['bytes'] != 0 or c['images']['bytes'] != 0:
            raise ValueError('resource leak')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['baseline','phase','chrome','fixtures','output']:p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--candidate', type=Path)
    p.add_argument('--trials', type=int, choices=[3, 8], default=3)
    p.add_argument('--backend', choices=['chrome', 'webkit'], default='chrome')
    a=p.parse_args()
    if a.output.exists():p.error('preserve previous output')
    bases={'baseline':a.baseline.resolve(),'off':a.phase.resolve(),'on':a.phase.resolve()}
    if a.candidate: bases['candidate']=a.candidate.resolve()
    config={'arms':list(bases),'trials':a.trials}
    fixtures={'basic-ko.hwp':a.fixtures/'basic-ko.hwp','basic-ko.hwpx':a.fixtures/'basic-ko.hwpx',
              'chemical.hwp':ROOT/'external/rhwp/samples/rnote/연구노트(화학).hwp',
              'asset.hwpx':ROOT/'external/rhwp/samples/issue6031/3249937_asset_management_rules.hwpx'}
    inputs={'harness':Path(__file__),'browser':HERE/'browser.mjs','browserLauncher':a.chrome.resolve(),**fixtures}
    for label,base in bases.items():
        for f in base.rglob('*'):
            if f.is_file():inputs[label+'/'+str(f.relative_to(base))]=f
    hashes=lambda:{k:hashlib.sha256(f.read_bytes()).hexdigest() for k,f in inputs.items()}
    load_before=os.getloadavg()
    before=hashes();received=[];complete=threading.Event()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_POST(self):
            size=int(self.headers.get('Content-Length','0'))
            if self.path!='/result' or not 0<size<8<<20:self.send_error(400);return
            try: row=json.loads(self.rfile.read(size))
            except (ValueError,UnicodeError):self.send_error(400);return
            received.append(row);self.send_response(204);self.end_headers();complete.set()
        def do_GET(self):
            name=self.path.split('?')[0];data=None;mime='text/javascript'
            if name=='/config.json':data=json.dumps(config).encode();mime='application/json'
            elif name=='/':data=b'<script type="module" src="/browser.mjs"></script>';mime='text/html'
            elif name=='/browser.mjs':data=(HERE/'browser.mjs').read_bytes()
            elif name.startswith('/fixtures/') and name[10:] in fixtures:data=fixtures[name[10:]].read_bytes();mime='application/octet-stream'
            else:
                for label,base in bases.items():
                    prefix='/'+label+'/'
                    if name.startswith(prefix):
                        f=(base/name[len(prefix):]).resolve()
                        if f.is_relative_to(base) and f.is_file():data=f.read_bytes();mime='application/wasm' if f.suffix=='.wasm' else 'text/javascript'
            if data is None:self.send_error(404);return
            self.send_response(200);self.send_header('Content-Type',mime);self.end_headers();self.wfile.write(data)
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.daemon_threads=True
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();result={}
    try:
        with tempfile.TemporaryDirectory(prefix='geul-engine-phases-') as profile,tempfile.TemporaryFile(mode='w+') as log:
            process=subprocess.Popen([str(a.chrome),'--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking','--disable-component-update','--disable-sync','--user-data-dir='+profile,'http://127.0.0.1:'+str(server.server_port)],stdout=log,stderr=log)
            try:
                deadline=time.monotonic()+240
                while not complete.wait(1):
                    if process.poll() is not None or time.monotonic()>deadline:raise RuntimeError('no complete browser result')
                time.sleep(.2)
                if len(received)!=1:raise ValueError('duplicate completion')
                result=received[0];validate(result,config)
            except Exception as error:
                result=received[0] if received else {'status':'FAIL'};result.update(status='FAIL',validationError=str(error))
            finally:
                process.terminate()
                try:process.wait(timeout=10)
                except subprocess.TimeoutExpired:process.kill();process.wait(timeout=10)
                result['browserExitAfterStop']=process.returncode
                if process.returncode not in (0, -15): result.update(status='FAIL', launcherError='browser launcher failed during shutdown')
                log.seek(0);result['browserLogTail']=log.read()[-1500:]
        result.update(system={'loadBefore':load_before,'loadAfter':os.getloadavg(),'logicalCpuCount':os.cpu_count(),'allowedCpuCount':len(os.sched_getaffinity(0))},requestConfig=config,identities=before,executedDependenciesStable=hashes()==before,browserBackend=a.backend,official=False)
        try: result['browserVersion']=subprocess.check_output([str(a.chrome),'--version'],text=True).strip()
        except Exception as error: result.update(status='FAIL',browserMetadataError=str(error))
        if not result['executedDependenciesStable']:result['status']='FAIL'
        a.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        print(result['status'],result.get('validationError'),flush=True)
        return 0 if result['status']=='DIAGNOSTIC_COMPLETE' else 1
    finally:server.shutdown();server.server_close();thread.join()


if __name__=='__main__':raise SystemExit(main())
