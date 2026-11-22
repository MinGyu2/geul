#!/usr/bin/env python3
"""Retrieve the public base and reconstruct the exact reviewed WordCraft gitlink.

No remote writes, dirty source patches, local alternates, or replacement revisions.
The ordinary external-integrity checks remain authoritative after preparation.
"""
import base64
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BASE = "dc25d8a27303b35d0ef7d61e56276f7b8f3feab5"
FONT_PIN = "6931bcc12af12ff874a9ebb4c63cebe17b3f8b82"
TABLE_PIN = "23c0dc52d5cf7d197d06c0b539547b9cce364b49"
STABILIZATION_PIN = "dd14a0ae29d90a05a54918db641d97f952260882"
FORMATTING_PIN = "1864d4fd0b5c0afadfe4197563336a08aebd776a"
ALIGNMENT_PIN = "5351d9b48fe073ee7eb5a5204f2ce06a5c78858a"
DIMENSIONS_PIN = "cae8c33058e620c02704a2414600b9cb7ecf0867"
CLIPBOARD_PIN = "76132b73fbe7b774f2fc3742634ee95e7dbb65ed"
MARGINS_PIN = "34d85b9a42153e161d9327a6e0422dfe82c24cc8"
HEADERS_PIN = "f42cd16c06d59c1e951c2475ec824f593887650b"
TABLE_BOUNDS_PIN = "b2c974369dd02d322a5498db484bcf96906dad15"
DOCX_BEZIER_PIN = "3ce76d137b6ac0c0e0dcabd44270d9858c7264b5"
DOCX_PATH_PIN = "656ae2b443004e589675070c0cd092587a1dd89c"
DOCX_PATH_CLOSE_PIN = "15b7fd7c6bbdc8e10343cb867c5cc5a9caf8637f"
DOCX_GROUP_PIN = "40dfd6d27b71c0f8ebcc5fd112b5c1b27481a79f"
PIN = DOCX_GROUP_PIN
REMOTE = "https://github.com/MinGyu2/wordcraft.git"
STEPS = [
    (BASE, FONT_PIN, "patches/wordcraft/system-font-source.patch", "patches/wordcraft/system-font-source.commit"),
    (FONT_PIN, TABLE_PIN, "patches/wordcraft/docx-table-structure.patch", "patches/wordcraft/docx-table-structure.commit"),
    (TABLE_PIN, STABILIZATION_PIN, "patches/wordcraft/docx-table-stabilization.patch", "patches/wordcraft/docx-table-stabilization.commit"),
    (STABILIZATION_PIN, FORMATTING_PIN, "patches/wordcraft/docx-table-formatting.patch", "patches/wordcraft/docx-table-formatting.commit"),
    (FORMATTING_PIN, ALIGNMENT_PIN, "patches/wordcraft/docx-table-alignment.patch", "patches/wordcraft/docx-table-alignment.commit"),
    (ALIGNMENT_PIN, DIMENSIONS_PIN, "patches/wordcraft/docx-table-dimensions.patch", "patches/wordcraft/docx-table-dimensions.commit"),
    (DIMENSIONS_PIN, CLIPBOARD_PIN, "patches/wordcraft/docx-table-clipboard.patch", "patches/wordcraft/docx-table-clipboard.commit"),
    (CLIPBOARD_PIN, MARGINS_PIN, "patches/wordcraft/docx-table-margins-positioning.patch", "patches/wordcraft/docx-table-margins-positioning.commit"),
    (MARGINS_PIN, HEADERS_PIN, "patches/wordcraft/docx-table-headers-pagination.patch", "patches/wordcraft/docx-table-headers-pagination.commit"),
    (HEADERS_PIN, TABLE_BOUNDS_PIN, "patches/wordcraft/docx-table-clipboard-bounds.patch", "patches/wordcraft/docx-table-clipboard-bounds.commit"),
    (TABLE_BOUNDS_PIN, DOCX_BEZIER_PIN, "patches/wordcraft/docx-drawingml-bezier.patch.b64", "patches/wordcraft/docx-drawingml-bezier.commit"),
    (DOCX_BEZIER_PIN, DOCX_PATH_PIN, "patches/wordcraft/docx-path-vertices.patch.b64", "patches/wordcraft/docx-path-vertices.commit"),
    (DOCX_PATH_PIN, DOCX_PATH_CLOSE_PIN, "patches/wordcraft/docx-path-close.patch.b64", "patches/wordcraft/docx-path-close.commit"),
    (DOCX_PATH_CLOSE_PIN, DOCX_GROUP_PIN, "patches/wordcraft/docx-group-children.patch.b64", "patches/wordcraft/docx-group-children.commit"),
]
PATCH = STEPS[0][2]
COMMIT = STEPS[0][3]


def git(path, *args, input=None, env=None):
    return subprocess.check_output(["git", "-C", str(path), *args], input=input, env=env)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def reconstruct(repo):
    """Only writes Git objects and a temporary index; never patches a worktree."""
    actual = BASE
    for parent, target, patch_rel, commit_rel in STEPS:
        commit = (ROOT / commit_rel).read_bytes()
        headers = commit.split(b"\n\n", 1)[0].splitlines()
        require([h for h in headers if h.startswith(b"parent ")] == [b"parent " + parent.encode()],
                f"WordCraft patch parent changed ({commit_rel})")
        require(git(repo, "hash-object", "-t", "commit", "--stdin", input=commit).decode().strip() == target,
                f"WordCraft commit metadata identity changed ({commit_rel})")
        with tempfile.TemporaryDirectory(prefix="geul-wordcraft-index-") as folder:
            env = {**os.environ, "GIT_INDEX_FILE": str(Path(folder) / "index")}
            git(repo, "read-tree", parent, env=env)
            patch_path = ROOT / patch_rel
            if patch_path.name.endswith(".patch.b64"):
                # Preserve exact upstream whitespace while keeping the patch artifact itself clean.
                encoded = b"".join(patch_path.read_bytes().splitlines())
                patch_bytes = base64.b64decode(encoded, validate=True)
                patch_path = Path(folder) / "decoded.patch"
                patch_path.write_bytes(patch_bytes)
            git(repo, "apply", "--cached", "--whitespace=error", str(patch_path), env=env)
            tree = git(repo, "write-tree", env=env).strip()
        require(headers[0] == b"tree " + tree, f"WordCraft patched tree identity mismatch ({patch_rel})")
        actual = git(repo, "hash-object", "-w", "-t", "commit", "--stdin", input=commit).decode().strip()
        require(actual == target, f"WordCraft reconstructed commit identity mismatch ({commit_rel})")
    return actual


def prepare():
    require(git(ROOT, "rev-parse", "--show-toplevel").decode().strip() == str(ROOT),
            "Run from an ordinary geul checkout")
    require(git(ROOT, "ls-tree", "HEAD", "external/wordcraft").split()[:3]
            == [b"160000", b"commit", PIN.encode()], "WordCraft gitlink changed; review bootstrap pin")
    require(git(ROOT, "ls-files", "--stage", "--", "external/wordcraft").split()[:3]
            == [b"160000", PIN.encode(), b"0"], "Staged WordCraft gitlink differs from HEAD")
    path = ROOT / "external/wordcraft"
    require(path.absolute() == path.resolve(), "WordCraft source path must not redirect through symlinks")
    if (path / ".git").exists():
        require(git(path, "rev-parse", "HEAD").decode().strip() == PIN,
                "Existing WordCraft checkout differs; preserving it for review")
        require(not git(path, "status", "--porcelain", "--untracked-files=all"),
                "Existing WordCraft checkout is dirty; preserving it for review")
        return
    require(not path.exists() or (path.is_dir() and not any(path.iterdir())),
            "Uninitialized WordCraft path contains files; preserving them")
    # Construct in isolation first. A failed fetch/patch never creates partial source inputs.
    with tempfile.TemporaryDirectory(prefix="geul-wordcraft-source-") as folder:
        repo = Path(folder) / "repo"
        subprocess.run(["git", "init", "--quiet", str(repo)], check=True)
        git(repo, "fetch", "--depth=1", REMOTE, BASE)
        reconstruct(repo)
        git(repo, "update-ref", "refs/heads/geul-reviewed", PIN)
        # A regular non-shared clone copies objects; no alternates/private object dependency remains.
        subprocess.run(["git", "clone", "--quiet", "--no-local", "--no-checkout", "--branch", "geul-reviewed", str(repo), str(path)], check=True)
        # Discard only this newly created clone's synthetic tracking refs. They
        # were transferred from the temporary reconstruction, not the public fork.
        git(path, "remote", "remove", "origin")
        git(path, "remote", "add", "origin", REMOTE)
        git(path, "checkout", "--quiet", "--detach", PIN)
    git(ROOT, "submodule", "init", "--", "external/wordcraft")
    git(ROOT, "submodule", "absorbgitdirs", "--", "external/wordcraft")
    require(not git(path, "status", "--porcelain", "--untracked-files=all"), "Prepared WordCraft must be clean")
    require(not (Path(git(path, "rev-parse", "--absolute-git-dir").decode().strip()) / "objects/info/alternates").exists(),
            "Prepared WordCraft must not depend on alternates")


if __name__ == "__main__":
    try:
        prepare()
        print(f"WordCraft {PIN}: clean exact dependency prepared")
    except (RuntimeError, OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit(str(exc)) from exc
