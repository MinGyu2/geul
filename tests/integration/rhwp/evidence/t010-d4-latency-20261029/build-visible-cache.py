#!/usr/bin/env python3
"""Build a separately prepared q13+visible-decoded-cache.patch export; never install it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[5]
SCOPE = ['src', 'crates', 'assets', 'bindings', 'vendor', 'scripts', 'saved', 'ttfs']
FILES = ['Cargo.toml', 'Cargo.lock', 'build.rs', 'rustfmt.toml', 'rust-toolchain.toml']
PARENT_WASM = 'a59421b800722e240113c54f335cb768c62a8c2ee648e008c3438d015751305a'
PARENT_SOURCE = '818cb71025b93498b1d891bf2e5507f0ce08a3dfd9f0d25c803a2da48d06e5b3'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inputs(source):
    paths = [p for name in SCOPE for p in (source / name).rglob('*') if p.is_file() and not p.is_symlink()]
    paths += [source / name for name in FILES]
    return {p.relative_to(source).as_posix(): sha(p) for p in sorted(paths)}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['source', 'base-source', 'base-candidate', 'out', 'report']:
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    source, base, parent = args.source.resolve(), args.base_source.resolve(), args.base_candidate.resolve()
    if args.report.exists() or args.out.exists():
        parser.error('preserve existing build outputs')
    if source == base or source == ROOT / 'external/rhwp':
        parser.error('an isolated prepared source export is required')
    identity = json.loads((parent / 'ENGINE.json').read_text())
    before, base_inputs = inputs(source), inputs(base)
    if sha(parent / 'rhwp_bg.wasm') != PARENT_WASM or digest(base_inputs) != PARENT_SOURCE:
        raise ValueError('q13 predecessor identity mismatch')
    changed = [name for name in sorted(set(before) | set(base_inputs)) if before.get(name) != base_inputs.get(name)]
    if changed != sorted('src/renderer/' + name for name in ['surface_cache.rs', 'render_job.rs', 'web_canvas.rs']):
        raise ValueError('unexpected source changes: ' + str(changed))
    patch = Path(__file__).with_name('visible-decoded-cache.patch')
    # Reapply the patch to the three original files, then compare exact bytes.
    import tempfile
    with tempfile.TemporaryDirectory(prefix='geul-visible-patch-') as folder:
        replay = Path(folder)
        for name in changed:
            (replay / name).parent.mkdir(parents=True, exist_ok=True)
            (replay / name).write_bytes((base / name).read_bytes())
        subprocess.run(['git', 'apply', '--no-index', str(patch)], cwd=replay, check=True)
        if any((replay / name).read_bytes() != (source / name).read_bytes() for name in changed):
            raise ValueError('patch replay mismatch')
    protected = {name: sha(ROOT / name) for name in ['public/rhwp/rhwp_bg.wasm', 'Cargo.lock'] if (ROOT / name).is_file()}
    gitlinks = subprocess.check_output(['git', 'ls-files', '--stage', 'external/rhwp', 'external/wordcraft'], cwd=ROOT, text=True)
    command = ['wasm-pack', 'build', str(source), '--release', '--no-opt', '--mode', 'no-install', '--target', 'web', '--out-dir', str(args.out.resolve()), '--locked', '--offline']
    report = {'status': 'RUNNING', 'command': command, 'sourceTreeSha256Before': digest(before), 'sourceSha256Before': before,
              'baseSourceTreeSha256': digest(base_inputs), 'patchSha256': sha(patch), 'changedSourceFiles': changed,
              'compiler': subprocess.check_output(['rustc', '--version'], text=True).strip(), 'protectedBefore': protected, 'gitlinksBefore': gitlinks}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    started = time.monotonic()
    with args.report.with_suffix('.log').open('x') as log:
        run = subprocess.run(command, cwd=ROOT, env=dict(os.environ, CARGO_TARGET_DIR=str(ROOT / 'src-tauri/target'), CARGO_BUILD_JOBS='2'), stdout=log, stderr=subprocess.STDOUT)
    after = inputs(source)
    stable = before == after
    unchanged = protected == {name: sha(ROOT / name) for name in protected} and gitlinks == subprocess.check_output(['git', 'ls-files', '--stage', 'external/rhwp', 'external/wordcraft'], cwd=ROOT, text=True)
    report.update(status='PASS' if run.returncode == 0 and stable and unchanged else 'FAIL', exitCode=run.returncode,
                  sourceStableDuringBuild=stable, protectedUnchanged=unchanged, sourceTreeSha256After=digest(after), elapsedSeconds=round(time.monotonic() - started, 3))
    if report['status'] == 'PASS':
        identity.update(candidate='q15-visible-decoded-cache-preference', productionApproval='NOT_APPROVED', experimental=True,
                        visibleDecodedCachePreference=True, sourcePredecessorTreeSha256=PARENT_SOURCE,
                        sourceTreeSha256=digest(before), sourceTreeSha256After=digest(after), sourceStableDuringBuild=True, buildStatus='PASS',
                        compiler=report['compiler'], sourceIdentityScope=SCOPE + FILES)
        identity['sourcePatches'].append({'path': str(patch.relative_to(ROOT)), 'sha256': sha(patch)})
        identity['artifacts'] = {name: sha(args.out / name) for name in ['rhwp.js', 'rhwp_bg.wasm', 'rhwp.d.ts', 'rhwp_bg.wasm.d.ts']}
        (args.out / 'ENGINE.json').write_text(json.dumps(identity, indent=2) + '\n')
        report.update(artifacts=identity['artifacts'], engineIdentitySha256=sha(args.out / 'ENGINE.json'))
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: value for key, value in report.items() if key != 'sourceSha256Before'}))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
