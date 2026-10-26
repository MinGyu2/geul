"""고정 RHWP 및 직전 후보에서 workspace 호환 패치를 각각 독립 적용한다."""
import argparse
import difflib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
from identity import files, snapshot, sha, PIN

ROOT = Path(__file__).resolve().parents[4]


def patch(before, after):
    chunks, changed = [], []
    for name in sorted(set(files(before)) | set(files(after))):
        left, right = before / name, after / name
        a = left.read_text() if left.exists() else ''
        b = right.read_text() if right.exists() else ''
        if a == b:
            continue
        changed.append(name)
        chunks.append(f'diff --git a/{name} b/{name}\n'
                      + ('new file mode 100644\n' if not left.exists() else '')
                      + ''.join(difflib.unified_diff(a.splitlines(True), b.splitlines(True),
                                                    fromfile='a/' + name if left.exists() else '/dev/null', tofile='b/' + name)))
    return ''.join('\n' if line == ' \n' else line for line in ''.join(chunks).splitlines(True)), changed


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--previous', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    if a.output.exists():
        p.error('기존 증거 보존: 새 출력 경로 필요')
    # Export only identity-covered files. No samples or large tool archives are duplicated.
    tracked = set(subprocess.check_output(['git', '-C', str(ROOT / 'external/rhwp'), 'ls-tree', '-r', '--name-only', PIN], text=True).splitlines())
    names = [name for name in files(a.previous) if name in tracked]
    blob = subprocess.check_output(['git', '-C', str(ROOT / 'external/rhwp'), 'archive', PIN, '--', *names])
    a.output.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix='geul-clippy-patch-') as tmp:
        pinned = Path(tmp) / 'pinned'
        pinned.mkdir()
        with tarfile.open(fileobj=io.BytesIO(blob)) as tar:
            tar.extractall(pinned, filter='data')
        expected = snapshot(a.source)[1]
        report = {'schema': 1, 'pinned': PIN, 'sourceTreeSha256': expected,
                  'coverage': 'identity.py: Rust src + workspace crates/tools/bindings + Cargo metadata', 'patches': []}
        for label, base in [('complete', pinned), ('compatibility', a.previous)]:
            text, paths = patch(base, a.source)
            output = a.output / f'upstream-rhwp-rust-199-{label}.patch'
            output.write_text(text)
            check = Path(tmp) / label
            check.mkdir()
            for name in files(base):
                dest = check / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(base / name, dest)
            subprocess.run(['git', 'apply', '--check', str(output.resolve())], cwd=check, check=True)
            subprocess.run(['git', 'apply', str(output.resolve())], cwd=check, check=True)
            actual = snapshot(check)[1]
            if actual != expected:
                raise ValueError('독립 적용 소스 신원 불일치')
            report['patches'].append({'name': label, 'paths': paths, 'sha256': sha(output),
                                      'appliedSourceTreeSha256': actual, 'status': 'PASS'})
        (a.output / 'patch-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n')
    print('PASS', expected)


if __name__ == '__main__':
    main()
