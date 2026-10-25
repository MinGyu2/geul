"""격리 소스만 빌드한다. 기존 후보·submodule·public을 쓰지 않고 전후 전체 Rust 소스 신원을 비교한다."""
from pathlib import Path
import argparse, hashlib, json, os, subprocess, sys
ROOT=Path(__file__).resolve().parents[4]
PIN='1a76570e833917d15817415a53c09ad61ab3203f'

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def sources(root):
    paths=sorted((root/'src').rglob('*.rs'))
    rows=[(p.relative_to(root).as_posix(),sha(p)) for p in paths]
    digest=hashlib.sha256(b''.join(n.encode()+b'\0'+h.encode()+b'\n' for n,h in rows)).hexdigest()
    return rows,digest

def main():
    a=argparse.ArgumentParser();a.add_argument('--source',type=Path,required=True);a.add_argument('--toolchain-bin',type=Path,required=True)
    a.add_argument('--target-dir',type=Path,required=True);a.add_argument('--attempt',type=int,required=True);args=a.parse_args()
    source=args.source.resolve();assert not source.is_relative_to(ROOT) and (source/'src/renderer/preparation.rs').is_file()
    package=source/f'candidate-attempt{args.attempt}'
    if package.exists():raise SystemExit('이전 빌드 보존')
    before,digest=sources(source)
    env={**os.environ,'PATH':str(args.toolchain_bin.resolve())+os.pathsep+os.environ['PATH'],'CARGO_TARGET_DIR':str(args.target_dir.resolve()),'CARGO_NET_OFFLINE':'true','CARGO_BUILD_JOBS':'2'}
    # Host linker configuration must not leak into wasm compilation.
    env.pop('RUSTFLAGS',None)
    cmd=['scripts/wasm-pack-locked.sh','--release','--no-opt','--target','web','--out-dir',package.name]
    p=subprocess.run(cmd,cwd=source,env=env)
    after,after_digest=sources(source)
    manifest={'schema':1,'baseline':PIN,'buildStatus':'PASS' if p.returncode==0 and before==after else 'FAIL',
        'sourceStableDuringBuild':before==after,'sourceTreeSha256':digest,'sourceTreeSha256After':after_digest,
        'sourceSha256':dict(before),'compiler':subprocess.check_output(['rustc','--version'],env=env,text=True).strip(),
        'cargo':subprocess.check_output(['cargo','--version'],env=env,text=True).strip(),'wasmPack':subprocess.check_output(['wasm-pack','--version'],env=env,text=True).strip(),
        'target':'wasm32-unknown-unknown','profile':'release','wasmOpt':False,'command':cmd,
        'rendererJobAPI':True,'schedulerAPI':True,'stabilizationAPI':True,'explicitPatchFullFallbackAPI':True,'fractionalPatchFullFallbackAPI':True,
        'preparationAPI':True,'preparationDefaultEnabled':False,'scope':'명시적 Full 준비 실험; 다른 경로는 기존 호환 계약'}
    if manifest['buildStatus']=='PASS':manifest['artifacts']={n:sha(package/n) for n in ('rhwp.js','rhwp_bg.wasm','rhwp.d.ts')}
    package.mkdir(exist_ok=True);(package/'ENGINE.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    print(manifest['buildStatus'],digest,manifest.get('artifacts'),flush=True)
    return 0 if manifest['buildStatus']=='PASS' else 1

if __name__=='__main__':raise SystemExit(main())
