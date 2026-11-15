#!/usr/bin/env python3
"""Retrieve the public base and reconstruct the exact reviewed WordCraft gitlink.

No remote writes, dirty source patches, local alternates, or replacement revisions.
The ordinary external-integrity checks remain authoritative after preparation.
"""
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PIN = "6931bcc12af12ff874a9ebb4c63cebe17b3f8b82"
BASE = "dc25d8a27303b35d0ef7d61e56276f7b8f3feab5"
REMOTE = "https://github.com/MinGyu2/wordcraft.git"
PATCH = "patches/wordcraft/system-font-source.patch"
COMMIT = "patches/wordcraft/system-font-source.commit"


def git(path, *args, input=None, env=None):
    return subprocess.check_output(["git", "-C", str(path), *args], input=input, env=env)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def reconstruct(repo):
    """Only writes Git objects and a temporary index; never patches a worktree."""
    commit = (ROOT / COMMIT).read_bytes()
    headers = commit.split(b"\n\n", 1)[0].splitlines()
    require([h for h in headers if h.startswith(b"parent ")] == [b"parent " + BASE.encode()],
            "WordCraft patch parent changed")
    require(git(repo, "hash-object", "-t", "commit", "--stdin", input=commit).decode().strip() == PIN,
            "WordCraft commit metadata identity changed")
    with tempfile.TemporaryDirectory(prefix="geul-wordcraft-index-") as folder:
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(folder) / "index")}
        git(repo, "read-tree", BASE, env=env)
        git(repo, "apply", "--cached", "--whitespace=error", str(ROOT / PATCH), env=env)
        tree = git(repo, "write-tree", env=env).strip()
    require(headers[0] == b"tree " + tree, "WordCraft patched tree identity mismatch")
    actual = git(repo, "hash-object", "-w", "-t", "commit", "--stdin", input=commit).decode().strip()
    require(actual == PIN, "WordCraft reconstructed commit identity mismatch")
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
