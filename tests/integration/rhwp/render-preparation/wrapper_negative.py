"""실제 wrapper 코드를 격리 저장소와 가짜 native 하네스로 시험한다. 실제 D1 실행과 구분한다."""
from pathlib import Path
import argparse, hashlib, json, os, shutil, subprocess, sys, tempfile
ROOT=Path(__file__).resolve().parents[4]
P='tests/integration/rhwp/ownership-poc/'
sys.path.insert(0,str(ROOT/P))
sys.path.insert(0,str(ROOT/'tests/integration/rhwp/render-preparation'))
import native_result as c
from test_evidence_contract import NativeContractTests
CANDIDATE_FILES=c.baseline.CANDIDATE_FILES
PINNED_FIXTURES=c.baseline.PINNED_FIXTURES
RHWP_REVISION=c.baseline.RHWP_REVISION


def git(root,*args):
    return subprocess.check_output(['git','-C',str(root),'-c','user.name=fixture','-c','user.email=fixture@example.invalid',*args],stderr=subprocess.PIPE)


def run(candidate,kind):
    with tempfile.TemporaryDirectory(prefix='geul-final-wrapper-fake-') as tmp:
        base=Path(tmp);r=base/'root';r.mkdir();pkg=base/'candidate';pkg.mkdir();tools=base/'bin';tools.mkdir()
        for n in c.DEPENDENCIES:
            if n.startswith('tree:') or n in CANDIDATE_FILES:continue
            p=r/n;p.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(ROOT/n,p)
        for n in CANDIDATE_FILES:shutil.copyfile(candidate/n,pkg/n)
        anchor=r/c.TRUST_ANCHOR['path'];anchor.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/c.TRUST_ANCHOR['path'],anchor)
        (r/'src').mkdir();(r/'src/main.ts').write_text('export {};')
        git(r,'init','-q');git(r,'add','--','package.json','tsconfig.json','src','tests','public')
        git(r,'update-index','--add','--cacheinfo','160000,'+RHWP_REVISION+',external/rhwp')
        git(r,'commit','-q','-m','controlled fixture')
        gitdir=git(ROOT/'external/rhwp','rev-parse','--absolute-git-dir').decode().strip()
        (r/'external/rhwp/.git').write_text('gitdir: '+gitdir+'\n')
        node=shutil.which('node')
        (tools/'node').write_text('#!'+sys.executable+'\n'+f'''import os,sys,http.server
if len(sys.argv)>1 and sys.argv[1].endswith('generate.mjs'):os.execv({node!r},[{node!r},*sys.argv[1:]])
class H(http.server.BaseHTTPRequestHandler):
 def do_GET(self):self.send_response(200);self.end_headers();self.wfile.write(b'ok')
 def log_message(self,*args):pass
http.server.HTTPServer(('127.0.0.1',1420),H).serve_forever()
''')
        # Real basic generator code and its public engine execute, independently of fake harness results.
        shutil.copyfile(ROOT/'tests/fixtures/rhwp/generate.mjs',r/'tests/fixtures/rhwp/generate.mjs')
        (tools/'geul').write_text('#!'+sys.executable+'\nimport time\ntime.sleep(0.6)\n');(tools/'geul').chmod(0o755)
        arguments=NativeContractTests().arguments();result=arguments['result'];expected=arguments['expected_wasm']
        if kind=='wrong-fixture':result['documents'][0]['sourceSha256']='0'*64
        if kind=='missing-fixture-hash':result['documents'][1].pop('sourceSha256')
        if kind=='forced-kill':result['teardown'][0].update(driverKilled=True,driverExit=-9)
        (tools/'dbus-run-session').write_text('#!'+sys.executable+'\n'+'''import os,json,subprocess,sys
from pathlib import Path
if os.environ['CASE']!='no-geul':subprocess.run([os.environ['FAKE_APP'],'0.6'],check=True)
p=Path(sys.argv[sys.argv.index('--output')+1]);text=os.environ['RESULT']
if os.environ['CASE']=='duplicate-json':text=text[:-1]+',"status":"PASS"}'
if os.environ['CASE']=='dependency-changed':Path('tests/e2e/tauri_smoke.py').write_text('changed')
p.write_text(text)
raise SystemExit(1 if os.environ['CASE']=='harness-exit1' else 0)
''')
        for n in ('node','dbus-run-session'):(tools/n).chmod(0o755)
        if kind=='missing-package':(r/'package.json').unlink()
        if kind=='untracked-src':(r/'src/extra.ts').write_text('export {};')
        if kind=='missing-sample':(r/next(iter(PINNED_FIXTURES.values()))).unlink()
        env={**os.environ,'PATH':str(tools)+os.pathsep+os.environ['PATH'],'CASE':kind,'RESULT':json.dumps(result),
             'FAKE_APP':str(tools/'geul'),'GEUL_EVIDENCE_SCRATCH':str(base),'TMPDIR':str(base),
             **{k:'controlled-fake' for k in ('GEUL_TAURI_DRIVER','GEUL_WEBKIT_DRIVER','GEUL_XVFB','GEUL_XDOTOOL')}}
        proc=subprocess.run([sys.executable,str(r/c.NATIVE_WRAPPER),'--attempt','1','--candidate',str(pkg),'--expected-wasm',expected],cwd=r,env=env,capture_output=True,text=True,timeout=60)
        vp=(r/c.NATIVE_WRAPPER).parent/'native-d1-attempt1-wrapper-verdict.json'
        verdict=json.loads(vp.read_text())['verdict'] if vp.exists() else None
        return {'경우':kind,'wrapper종료':proc.returncode,'상태':verdict['status'] if verdict else '실행 전 거부',
                '범주':verdict['categories'] if verdict else [],'stderr_SHA256':hashlib.sha256(proc.stderr.encode()).hexdigest(), '진단':proc.stderr[-800:].replace(str(base),'<임시>')}


def main():
    a=argparse.ArgumentParser();a.add_argument('--candidate',required=True,type=Path);a.add_argument('--output',required=True,type=Path);args=a.parse_args()
    if args.output.exists():raise SystemExit('기존 증거 보존')
    cases=('complete-pass','wrong-fixture','missing-fixture-hash','forced-kill','duplicate-json','dependency-changed','harness-exit1','no-geul','missing-package','untracked-src','missing-sample')
    rows=[]
    for case in cases:
        row=run(args.candidate,case);rows.append(row);print(case,row['wrapper종료'],flush=True)
    args.output.write_text(json.dumps({'분류':'VERIFIED 통제된 가짜 하네스; 실제 native D1 아님','검사':rows},ensure_ascii=False,indent=2)+'\n')
    if any((r['wrapper종료']==0)!=(r['경우']=='complete-pass') for r in rows):raise SystemExit(1)


if __name__=='__main__':main()
