"""RHWP src뿐 아니라 변경된 workspace crate와 빌드 메타데이터도 신원에 포함한다."""
import hashlib
from pathlib import Path

ROOTS = ('src', 'crates', 'bindings/Native', 'tools/rhwp-subsecond', 'tools/batch-convert',
         'tools/llm_verifier', 'tools/diagnostics', 'tools/fixture_generators')
PIN = '1a76570e833917d15817415a53c09ad61ab3203f'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def files(root):
    root = Path(root)
    names = {p.relative_to(root).as_posix() for directory in ROOTS for p in (root / directory).rglob('*.rs')}
    names.update(p.relative_to(root).as_posix() for directory in ROOTS for p in (root / directory).rglob('Cargo.toml'))
    names.update(('Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'rustfmt.toml', 'build.rs'))
    return sorted(names)


def digest(rows):
    return hashlib.sha256(b''.join(n.encode() + b'\0' + h.encode() + b'\n' for n, h in rows)).hexdigest()


def snapshot(root):
    rows = [(name, sha(Path(root) / name)) for name in files(root)]
    return dict(rows), digest(rows)


def rhwp_src_digest(root):
    # Preserve the established Path ordering (not string ordering at '.' versus '/').
    root = Path(root)
    rows = [(p.relative_to(root).as_posix(), sha(p)) for p in sorted((root / 'src').rglob('*.rs'))]
    return digest(rows)
