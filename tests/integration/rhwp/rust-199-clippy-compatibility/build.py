"""기존 Rust1.99와 wasm-bindgen만 호출해 격리 후보를 만들고 모든 workspace 입력 신원을 확인한다."""
import argparse
import json
import os
from pathlib import Path
import subprocess
from identity import snapshot, rhwp_src_digest, sha, PIN


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--target-dir', type=Path, required=True)
    p.add_argument('--bindgen', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--record-dir', type=Path, required=True)
    a = p.parse_args()
    source, output = a.source.resolve(), a.output.resolve()
    if output.exists() or a.record_dir.exists():
        p.error('이전 후보/빌드 기록 보존: 새 출력과 기록 경로 필요')
    compiler = subprocess.check_output(['rustc', '--version'], text=True).strip()
    cargo = subprocess.check_output(['cargo', '--version'], text=True).strip()
    if not compiler.startswith('rustc 1.99.0 ') or not cargo.startswith('cargo 1.99.0 '):
        p.error('설치된 Rust/Cargo1.99.0만 허용')
    before, digest = snapshot(source)
    a.record_dir.mkdir(parents=True, exist_ok=True)
    (a.record_dir / 'build-inputs-before.json').write_text(json.dumps(before, indent=1) + '\n')
    env = os.environ | {'CARGO_NET_OFFLINE': 'true', 'CARGO_INCREMENTAL': '0', 'CARGO_BUILD_JOBS': '2',
                       'CARGO_TARGET_DIR': str(a.target_dir.resolve())}
    env.pop('RUSTFLAGS', None)
    command = ['cargo', 'build', '--locked', '--offline', '--release', '--target', 'wasm32-unknown-unknown', '--lib']
    with (a.record_dir / 'wasm-build.log').open('w') as log:
        built = subprocess.run(command, cwd=source, env=env, stdout=log, stderr=subprocess.STDOUT)
    after, after_digest = snapshot(source)
    if built.returncode or before != after:
        raise RuntimeError(f'빌드 실패 또는 소스 변경: exit={built.returncode}, stable={before == after}')
    bindgen_version = subprocess.check_output([str(a.bindgen), '--version'], text=True).strip()
    if bindgen_version != 'wasm-bindgen 0.2.127':
        p.error('고정 lock과 맞는 기존 wasm-bindgen0.2.127 필요')
    output.mkdir(parents=True)
    bindgen = [str(a.bindgen), '--target', 'web', '--out-dir', str(output), '--out-name', 'rhwp',
               str(a.target_dir.resolve() / 'wasm32-unknown-unknown/release/rhwp.wasm')]
    subprocess.run(bindgen, check=True)
    if snapshot(source)[0] != before:
        raise RuntimeError('glue 생성 중 소스 신원 변경')
    manifest = {'schema': 1, 'baseline': PIN, 'buildStatus': 'PASS', 'sourceStableDuringBuild': True,
                'sourceTreeSha256': digest, 'sourceTreeSha256After': after_digest,
                'sourceCoverage': 'Rust + Cargo metadata for src/crates/declared tools/bindings; identity.py',
                'sourceInputCount': len(before), 'rhwpSrcTreeSha256': rhwp_src_digest(source),
                'compiler': compiler, 'cargo': cargo, 'sysroot': subprocess.check_output(['rustc', '--print', 'sysroot'], text=True).strip(),
                'wasmBindgen': bindgen_version, 'target': 'wasm32-unknown-unknown', 'profile': 'release', 'wasmOpt': False,
                'command': command, 'artifacts': {n: sha(output / n) for n in ('rhwp.js', 'rhwp_bg.wasm', 'rhwp.d.ts')},
                'preparationAPI': True, 'preparationDefaultEnabled': False, 'rendererJobAPI': True, 'schedulerAPI': True,
                'stabilizationAPI': True, 'explicitPatchFullFallbackAPI': True, 'fractionalPatchFullFallbackAPI': True}
    (output / 'ENGINE.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps({'status': 'PASS', 'sourceTreeSha256': digest, 'artifacts': manifest['artifacts']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
