#!/usr/bin/env python3
"""Build pinned+patch in a new isolated source checkout; never writes external/ or public/."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
BASELINE = '1a76570e833917d15817415a53c09ad61ab3203f'
DEFAULT_PATCH = ROOT / 'tests/integration/rhwp/evidence/t010-cache-hardening/upstream-rhwp-bounded-image-cache-v2.patch'
CHANGED = ('src/renderer/mod.rs', 'src/renderer/surface_cache.rs', 'src/renderer/render_job.rs', 'src/renderer/web_canvas.rs', 'src/wasm_api.rs')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def export_declared_inputs(source, work):
    """Include pinned static Rust test inputs without exporting unrelated document archives."""
    for directory in ('src', 'tests', 'crates', 'tools', 'bindings'):
        for rust_file in (work / directory).rglob('*.rs'):
            for relative in re.findall(r'include_(?:bytes|str)!\s*\(\s*"([^"\n]+)"', rust_file.read_text(errors='replace')):
                target = (rust_file.parent / relative).resolve()
                if not target.is_relative_to(work) or target.exists():
                    continue
                name = target.relative_to(work).as_posix()
                declared = subprocess.run(['git', '-C', str(source), 'show', BASELINE + ':' + name], capture_output=True)
                if declared.returncode == 0:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(declared.stdout)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--work', type=Path, required=True)
    p.add_argument('--patch', type=Path, default=DEFAULT_PATCH)
    p.add_argument('--toolchain-bin', type=Path)
    p.add_argument('--prepare-only', action='store_true')
    p.add_argument('--baseline-only', action='store_true')
    p.add_argument('--target-dir', type=Path, help='Optional explicit Cargo cache; caller must ensure no concurrent Cargo process uses it')
    p.add_argument('--no-opt', action='store_true', help='Keep Rust release optimization; skip optional wasm-opt')
    a = p.parse_args()
    work = a.work.resolve()
    if work.exists() or work.is_relative_to(ROOT):
        p.error('--work must be a new directory outside the geul working tree')
    source = ROOT / 'external/rhwp'
    before = subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain=v1'], text=True)
    work.mkdir()
    # Stream only the pinned tracked source; copying Git history can dwarf the working tree.
    archive = subprocess.Popen(['git', '-C', str(source), 'archive', BASELINE, '--',
                                'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'rustfmt.toml', 'build.rs',
                                'src', 'crates', 'bindings/Native', 'tools/rhwp-subsecond',
                                'tools/batch-convert', 'tools/llm_verifier', 'tools/diagnostics',
                                'tools/fixture_generators', 'scripts',
                                'tests', 'samples', 'assets', 'saved', 'vendor', 'template',
                                'rhwp-studio/public/samples/issue1949_giant_cell_nested_tables_perf.hwp',
                                'rhwp-studio/src/view/canvaskit/glyph-run-fonts.ts',
                                'mydocs/tech/agent_runtime/version_policy.md',
                                'ttfs', 'LICENSE', 'README.md'], stdout=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=archive.stdout, mode='r|') as stream:
            stream.extractall(work, filter='data')
    finally:
        archive.stdout.close()
        if archive.wait() != 0:
            raise RuntimeError('pinned source export failed')
    subprocess.run(['git', 'init', '--quiet', str(work)], check=True)
    if not a.baseline_only:
        for options in (['--check'], []):
            subprocess.run(['git', '-C', str(work), 'apply', *options, str(a.patch.resolve())], check=True)
    export_declared_inputs(source, work)
    env = dict(os.environ)
    build_tmp = work / 'build-tmp'; build_tmp.mkdir(exist_ok=True)
    env['TMPDIR'] = str(build_tmp)
    if a.toolchain_bin:
        env['PATH'] = str(a.toolchain_bin.resolve()) + os.pathsep + env['PATH']
    env['CARGO_TARGET_DIR'] = str(a.target_dir.resolve() if a.target_dir else work / 'target/pr-review')
    env.setdefault('CARGO_BUILD_JOBS', '2')
    version = lambda cmd: subprocess.check_output(cmd, env=env, text=True).strip()
    manifest = {'schema': 1, 'baseline': BASELINE, 'patchSha256': None if a.baseline_only else sha(a.patch),
                'sourceSha256': {name: sha(work / name) for name in CHANGED if (work / name).is_file()},
                'compiler': version(['rustc', '--version']), 'cargo': version(['cargo', '--version']),
                'wasmPack': version(['wasm-pack', '--version']), 'target': 'wasm32-unknown-unknown',
                'profile': 'release', 'targetCache': 'explicit cache' if a.target_dir else 'isolated target/pr-review', 'sourceExport': 'build/test inputs; documentation/PDF archives excluded', 'buildStatus': 'NOT EXECUTED'}
    package = work / 'test-package'
    command = ['scripts/wasm-pack-locked.sh', '--release', '--target', 'web', '--out-dir', 'test-package']
    if a.no_opt:
        command.insert(2, '--no-opt')
    manifest['wasmOpt'] = not a.no_opt
    manifest['command'] = command
    try:
        if not a.prepare_only:
            subprocess.run(command, cwd=work, env=env, check=True)
            after_sources = {name: sha(work / name) for name in CHANGED if (work / name).is_file()}
            if manifest['sourceSha256'] != after_sources:
                manifest['buildStatus'] = 'STALE'
                raise RuntimeError('source changed during build; artifacts are not verified')
            manifest['buildStatus'] = 'PASS'
            manifest['artifacts'] = {name: sha(package / name) for name in ('rhwp.js', 'rhwp_bg.wasm', 'rhwp.d.ts')}
    except subprocess.CalledProcessError:
        manifest['buildStatus'] = 'FAIL'
        raise
    finally:
        package.mkdir(exist_ok=True)
        (package / 'ENGINE.json').write_text(json.dumps(manifest, indent=2) + '\n')
        after = subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain=v1'], text=True)
        if before != after:
            raise RuntimeError('submodule status changed during isolated build')
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
