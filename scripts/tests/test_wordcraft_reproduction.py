"""Fresh public retrieval + exact commit reconstruction, without local engine objects."""
import importlib.util
import base64
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
            for name in ["scripts/prepare-wordcraft.py", "scripts/cargo-geul.py"]:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, target)
            patch_dir = root / "patches/wordcraft"
            patch_dir.mkdir(parents=True, exist_ok=True)
            for artifact in (ROOT / "patches/wordcraft").iterdir():
                if artifact.is_file():
                    shutil.copyfile(artifact, patch_dir / artifact.name)
            source = root / "external/wordcraft"
            self.assertFalse((source / ".git").exists())
            spec = importlib.util.spec_from_file_location("fresh_wordcraft", root / "scripts/prepare-wordcraft.py")
            w = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(w)
            # Model the integration commit under test without changing the caller's checkout.
            subprocess.run(["git", "-C", str(root), "update-index", "--add", "--cacheinfo",
                            f"160000,{w.PIN},external/wordcraft"], check=True)
            tree = subprocess.check_output(["git", "-C", str(root), "write-tree"], text=True).strip()
            commit_env = {**os.environ, "GIT_AUTHOR_NAME": "WordCraft reproduction test",
                          "GIT_AUTHOR_EMAIL": "wordcraft-reproduction@example.invalid",
                          "GIT_COMMITTER_NAME": "WordCraft reproduction test",
                          "GIT_COMMITTER_EMAIL": "wordcraft-reproduction@example.invalid"}
            integration_commit = subprocess.check_output(
                ["git", "-C", str(root), "commit-tree", tree, "-p", "HEAD", "-m",
                 "test: use reconstructed WordCraft pin"], text=True, env=commit_env).strip()
            subprocess.run(["git", "-C", str(root), "update-ref", "HEAD", integration_commit], check=True)
            # prepare() fetches ONLY the public HTTPS base; no engine object is copied from ROOT.
            w.prepare()
            self.assertEqual(w.git(source, "rev-parse", "HEAD").decode().strip(), w.PIN)
            expected_history = [target for _, target, _, _ in w.STEPS]
            actual_history = w.git(source, "rev-list", "--reverse", f"{w.BASE}..{w.PIN}").decode().splitlines()
            self.assertEqual(actual_history, expected_history)
            self.assertEqual(w.git(source, "status", "--porcelain", "--untracked-files=all"), b"")
            metadata = Path(w.git(source, "rev-parse", "--absolute-git-dir").decode().strip())
            self.assertFalse((metadata / "objects/info/alternates").exists())
            self.assertEqual(w.git(source, "for-each-ref", "refs/remotes"), b"")
            self.assertEqual(w.git(source, "remote", "get-url", "origin").decode().strip(), w.REMOTE)
            for parent, target_rev, patch_rel, _ in w.STEPS:
                expected_patch = (root / patch_rel).read_bytes()
                if patch_rel.endswith(".patch.b64"):
                    expected_patch = base64.b64decode(b"".join(expected_patch.splitlines()), validate=True)
                generated_patches = [
                    w.git(source, "diff", "--binary", parent, target_rev, "--"),
                    w.git(source, "diff", "--binary", "--full-index", parent, target_rev, "--"),
                ]
                self.assertIn(expected_patch, generated_patches)
            # Audited exact content, including FontDb::global, table structure commands, and 1x1 cell split.
            self.assertIn(b"pub trait SystemFontSource", (source / "crates/fonts/src/fontdb.rs").read_bytes())
            self.assertIn(b"table.mergeCells", (source / "crates/engine/src/cmd/table.rs").read_bytes())
            self.assertIn(b"split_cell_grid", (source / "crates/doc/src/table.rs").read_bytes())
            self.assertIn(b"note_pictures_move_only_within_their_owned_paragraphs",
                          (source / "crates/engine/src/cmd/objects.rs").read_bytes())
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
