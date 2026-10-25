"""독립 임시 디렉터리의 생성 바이트와 고정 서브모듈 샘플을 대조한다."""
from pathlib import Path
import argparse, hashlib, json, subprocess, sys, tempfile, zipfile
ROOT=Path(__file__).resolve().parents[6]
sys.path.insert(0,str(ROOT/'tests/integration/rhwp/ownership-poc'))
import native_d1_result as c


def main():
    a=argparse.ArgumentParser();a.add_argument('--output',type=Path,required=True);args=a.parse_args()
    if args.output.exists():raise SystemExit('기존 증거 보존')
    runs=[];dates=[]
    for _ in range(3):
        with tempfile.TemporaryDirectory(prefix='geul-independent-fixtures-') as tmp:
            subprocess.run(['node',str(ROOT/'tests/fixtures/rhwp/generate.mjs'),tmp],check=True,capture_output=True)
            runs.append({n:hashlib.sha256((Path(tmp)/n).read_bytes()).hexdigest() for n in c.SAMPLES[:2]})
            with zipfile.ZipFile(Path(tmp)/'basic-ko.hwpx') as z:dates.append(sorted(set(i.date_time for i in z.infolist())))
    pinned=c.pinned_samples_valid(ROOT)
    samples={n:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for n,p in c.PINNED_FIXTURES.items()}
    expected={n:c.FIXTURE_SHA256[n] for n in c.SAMPLES[:2]}
    report={'분류':'VERIFIED 실제 독립 생성 3회 및 Git blob/작업 바이트 비교','생성':runs,'ZIP시각':dates,
            '생성바이트결정성':all(r==expected for r in runs),'고정샘플':samples,'고정gitlink_HEAD_blob_작업바이트일치':pinned,
            'RHWP고정revision':c.RHWP_REVISION,'입력':{n:hashlib.sha256((ROOT/n).read_bytes()).hexdigest() for n in
            ('tests/fixtures/rhwp/generate.mjs','public/rhwp/rhwp.js','public/rhwp/rhwp_bg.wasm','public/rhwp/BUILD.json')}}
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    if not pinned or not report['생성바이트결정성']:raise SystemExit(1)


if __name__=='__main__':main()
