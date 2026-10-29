#!/usr/bin/env python3
"""Run builds/tests with read-only sources and verify every external dependency.

Linux/bubblewrap is required; there is deliberately no unprotected fallback.
Only explicitly named artifact directories, Cargo cache bookkeeping, and /tmp
are writable. Registry and Git dependency sources remain read-only.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
GIT_ENV = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}


def git(repo, *args):
    return subprocess.check_output(
        ["git", "-C", str(repo), *args], env=GIT_ENV
    )


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def inventory(path):
    """Include ignored/untracked files, modes and links; never follow symlinks."""
    result = {}

    def visit(item):
        mode = item.lstat().st_mode
        key = str(item.relative_to(path))
        if stat.S_ISLNK(mode):
            value = [mode, os.readlink(item)]
        elif stat.S_ISREG(mode):
            value = [mode, sha(item)]
        elif stat.S_ISDIR(mode):
            value = [mode]
        else:
            raise RuntimeError(f"Unsupported external file type: {item}")
        result[key] = value
        if stat.S_ISDIR(mode):
            for child in sorted(item.iterdir()):
                visit(child)

    visit(path)
    return result


def dependencies():
    result = {}

    def visit(repo, prefix=""):
        for entry in git(repo, "ls-tree", "-rz", "HEAD").split(b"\0"):
            if not entry:
                continue
            header, raw_path = entry.split(b"\t", 1)
            mode, _, revision = header.split()
            rel = os.fsdecode(raw_path)
            if mode != b"160000" or (not prefix and not rel.startswith("external/")):
                continue
            name = prefix + rel
            path = ROOT / name
            if path.is_symlink() or not (path / ".git").exists():
                raise RuntimeError(f"Missing initialized external submodule: {name}")
            actual = git(path, "rev-parse", "HEAD").decode().strip()
            if actual != revision.decode():
                raise RuntimeError(f"Pinned revision mismatch: {name}: {actual} != {revision.decode()}")
            staged = git(repo, "ls-files", "--stage", "--", rel).split()
            if staged[:3] != [b"160000", revision, b"0"]:
                raise RuntimeError(f"Staged external revision differs from HEAD: {name}")
            metadata = Path(git(path, "rev-parse", "--absolute-git-dir").decode().strip())
            result[name] = {
                "revision": actual,
                "tree": git(path, "rev-parse", "HEAD^{tree}").decode().strip(),
                "status": git(path, "status", "--porcelain=v1", "--untracked-files=all").decode(),
                "trackedDiffSha256": hashlib.sha256(git(path, "diff", "HEAD", "--binary", "--no-ext-diff")).hexdigest(),
                "gitDirectory": str(metadata),
            }
            visit(path, name + "/")

    visit(ROOT)
    return result


def snapshot():
    deps = dependencies()
    return {
        "dependencies": deps,
        "externalFiles": inventory(ROOT / "external"),
        "gitMetadata": {name: inventory(Path(info["gitDirectory"])) for name, info in deps.items()},
    }


def artifact_paths(writable):
    """Validate before creating directories or writing any artifact."""
    paths = [Path(p).absolute() for p in writable]
    git_dir = Path(git(ROOT, "rev-parse", "--absolute-git-dir").decode().strip())
    for path in paths:
        if path != path.resolve() or not path.is_relative_to(ROOT) or path == ROOT or any(
            path.is_relative_to(p) or p.is_relative_to(path)
            for p in [ROOT / "external", git_dir]
        ):
            raise RuntimeError(f"Unsafe writable artifact directory: {path}")
    return paths


def run_readonly(commands, writable, report, *, env=None, require_clean=False):
    bwrap = shutil.which("bwrap")
    if not bwrap:
        raise RuntimeError("bubblewrap (bwrap) required; refusing an unprotected build")
    paths = artifact_paths(writable)
    for path in paths:
        path.mkdir(parents=True, exist_ok=True)
    report = Path(report).resolve()
    if not any(report.is_relative_to(p) for p in paths):
        raise RuntimeError("Integrity report must be in an explicit artifact directory")
    before = snapshot()
    if require_clean and any(info["status"] for info in before["dependencies"].values()):
        raise RuntimeError("External sources have local changes; preserve/review them before building")
    report.write_text(json.dumps({"status": "RUNNING", "commands": commands, "before": before}, indent=2) + "\n")
    sandbox = [bwrap, "--die-with-parent", "--unshare-net", "--ro-bind", "/", "/",
               "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"]
    for path in paths:
        sandbox += ["--bind", str(path), str(path)]
    # Cargo updates cache locks/usage data even offline. Its actual dependency
    # sources, archives and indexes must never become a writable overlay.
    cargo_home = Path((env or os.environ).get("CARGO_HOME", str(Path.home() / ".cargo"))).resolve()
    if cargo_home.is_dir():
        git_dir = Path(git(ROOT, "rev-parse", "--absolute-git-dir").decode().strip())
        if cargo_home.is_relative_to(ROOT / "external") or any(
            p.is_relative_to(cargo_home) or cargo_home.is_relative_to(p)
            for p in [ROOT, git_dir]
        ):
            raise RuntimeError("CARGO_HOME overlaps repository sources")
        sandbox += ["--bind", str(cargo_home), str(cargo_home)]
        for name in ["registry", "git"]:
            path = cargo_home / name
            if path.exists():
                sandbox += ["--ro-bind", str(path), str(path)]
    results = []
    error = None
    try:
        for command in commands:
            completed = subprocess.run(sandbox + ["--", *command], cwd=ROOT, env=env)
            results.append(completed.returncode)
            if completed.returncode:
                break
    except BaseException as exc:
        error = repr(exc)
    finally:
        after_error = None
        try:
            after = snapshot()
        except (RuntimeError, OSError, subprocess.CalledProcessError) as exc:
            # A damaged revision/index or deleted source is itself a failure,
            # even when a complete after-snapshot can no longer be obtained.
            after = None
            after_error = repr(exc)
        unchanged = after_error is None and before == after
        success = unchanged and error is None and len(results) == len(commands) and all(c == 0 for c in results)
        report.write_text(json.dumps({
            "status": "PASS" if success else "FAILED", "readOnlySandbox": True,
            "unchanged": unchanged, "commands": commands, "exitCodes": results,
            "error": error, "afterSnapshotError": after_error, "before": before, "after": after,
        }, indent=2) + "\n")
    if not unchanged:
        raise RuntimeError(f"BUILD-SYSTEM FAILURE: external sources changed; no automatic restoration. See {report}")
    if not success:
        raise RuntimeError(f"Protected command failed: exits={results}, error={error}; see {report}")
    return before


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--writable", action="append", default=[])
    parser.add_argument("--report", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("command required after --")
    run_readonly([command], args.writable, args.report)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))
