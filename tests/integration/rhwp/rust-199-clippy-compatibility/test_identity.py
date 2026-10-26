"""실제로 발견한 src 경로 순서 회귀와 workspace crate 신원 누락을 막는다."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from identity import rhwp_src_digest, snapshot

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('prior_build_candidate', HERE.parent / 'render-preparation/build_candidate.py')
prior = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prior)


class IdentityTests(unittest.TestCase):
    def test_previous_src_ordering_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ('src/layout.rs', 'src/layout/caret.rs', 'src/lib.rs'):
                p = root / name
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(name)
            self.assertEqual(rhwp_src_digest(root), prior.sources(root)[1])

    def test_crypto_changes_affect_workspace_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ('Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'rustfmt.toml', 'build.rs',
                         'src/lib.rs', 'crates/rhwp-password-crypto/src/lib.rs'):
                p = root / name
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(name)
            before = snapshot(root)[1]
            previous_src = rhwp_src_digest(root)
            (root / 'crates/rhwp-password-crypto/src/lib.rs').write_text('changed crypto')
            self.assertNotEqual(snapshot(root)[1], before)
            self.assertEqual(rhwp_src_digest(root), previous_src)


if __name__ == '__main__':
    unittest.main()
