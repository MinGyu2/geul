"""Fresh public retrieval + exact commit reconstruction, without local engine objects."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class WordcraftReproduction(unittest.TestCase):
    def test_fresh_public_base_exact_clean_source_and_compile(self):
        # The protected runner replaces /tmp with a private tmpfs. Keep the independent
        # checkout under an ordinary project artifact parent, outside that hidden mount.
        (ROOT / "target").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="font-reproduction-", dir=ROOT / "target") as folder:
            root = Path(folder) / "geul"
            subprocess.run(["git", "clone", "--quiet", "--no-local", "--no-recurse-submodules", str(ROOT), str(root)], check=True)
            for name in ["scripts/prepare-wordcraft.py", "scripts/cargo-geul.py",
                         "patches/wordcraft/system-font-source.patch", "patches/wordcraft/system-font-source.commit",
                         "patches/wordcraft/docx-table-structure.patch", "patches/wordcraft/docx-table-structure.commit",
                         "patches/wordcraft/docx-table-stabilization.patch", "patches/wordcraft/docx-table-stabilization.commit"]:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, target)
            source = root / "external/wordcraft"
            self.assertFalse((source / ".git").exists())
            spec = importlib.util.spec_from_file_location("fresh_wordcraft", root / "scripts/prepare-wordcraft.py")
            w = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(w)
            # prepare() fetches ONLY the public HTTPS base; no engine object is copied from ROOT.
            w.prepare()
            self.assertEqual(w.git(source, "rev-parse", "HEAD").decode().strip(), w.PIN)
            self.assertEqual(w.git(source, "rev-parse", "HEAD^" ).decode().strip(), w.TABLE_PIN)
            self.assertEqual(w.git(source, "rev-parse", "HEAD~2").decode().strip(), w.FONT_PIN)
            self.assertEqual(w.git(source, "rev-parse", "HEAD~3").decode().strip(), w.BASE)
            self.assertEqual(w.git(source, "status", "--porcelain", "--untracked-files=all"), b"")
            metadata = Path(w.git(source, "rev-parse", "--absolute-git-dir").decode().strip())
            self.assertFalse((metadata / "objects/info/alternates").exists())
            self.assertEqual(w.git(source, "for-each-ref", "refs/remotes"), b"")
            self.assertEqual(w.git(source, "remote", "get-url", "origin").decode().strip(), w.REMOTE)
            for parent, target_rev, patch_rel, _ in w.STEPS:
                self.assertEqual(w.git(source, "diff", "--binary", "--full-index", parent, target_rev, "--"),
                                 (root / patch_rel).read_bytes())
            # Audited exact content, including FontDb::global, table structure commands, and 1x1 cell split.
            self.assertIn(b"pub trait SystemFontSource", (source / "crates/fonts/src/fontdb.rs").read_bytes())
            self.assertIn(b"table.mergeCells", (source / "crates/engine/src/cmd/table.rs").read_bytes())
            self.assertIn(b"split_cell_grid", (source / "crates/doc/src/table.rs").read_bytes())
            w.prepare()  # idempotent; no worktree patch or network needed
            subprocess.run(["python3", "scripts/external-integrity.py", "--require", "external/wordcraft",
                            "--writable", "target/wordcraft-reproduction", "--report", "target/wordcraft-reproduction/integrity.json",
                            "--", "cargo", "check", "--manifest-path", str(source / "Cargo.toml"),
                            "-p", "wordcraft-fonts", "--locked", "--offline", "--target-dir", str(root / "target/wordcraft-reproduction")],
                           cwd=root, env=os.environ.copy(), check=True)
            self.assertEqual(w.git(source, "status", "--porcelain", "--untracked-files=all"), b"")
            # Patch tampering fails the exact-tree check. Existing source/index stays clean.
            patch = root / w.PATCH
            patch.write_bytes(patch.read_bytes().replace(b"pub trait SystemFontSource", b"pub trait DifferentSource"))
            with self.assertRaisesRegex(RuntimeError, "tree identity mismatch"):
                w.reconstruct(source)
            self.assertEqual(w.git(source, "status", "--porcelain", "--untracked-files=all"), b"")
            # User work is preserved rather than reset/reapplied.
            marker = source / "user-work.txt"
            marker.write_text("preserve me")
            with self.assertRaisesRegex(RuntimeError, "dirty"):
                w.prepare()
            self.assertEqual(marker.read_text(), "preserve me")


if __name__ == "__main__":
    unittest.main()
