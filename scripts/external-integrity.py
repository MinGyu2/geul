#!/usr/bin/env python3
"""Run builds/tests with read-only sources and verify every external dependency.

Linux/bubblewrap is required; there is deliberately no unprotected fallback.
Only approved artifact directories, Cargo cache bookkeeping, and /tmp are
writable. The separate fixed `cargo fetch --locked --target <host>` preparation
may populate the cache; builds keep registry/Git sources read-only. Normal
checks hash critical files; --deep explicitly audits all external contents.
"""
import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
GIT_ENV = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}


def git(repo, *args):
    return subprocess.check_output(
        ["git", "-C", str(repo), *args], env=GIT_ENV
    )


def host_target(env):
    rustc = shutil.which("rustc", path=env.get("PATH"))
    if not rustc:
        raise RuntimeError("An installed rustc is required for cache preparation")
    output = subprocess.check_output([rustc, "--version", "--verbose"], env=env, text=True)
    for line in output.splitlines():
        if line.startswith("host: "):
            target = line.removeprefix("host: ")
            if target and all(c.isalnum() or c in "_-" for c in target):
                return target
    raise RuntimeError("Unable to identify installed Rust host target")


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


def dependencies(required=None):
    required = set(required or [])
    result = {}
    git_root = Path(git(ROOT, "rev-parse", "--absolute-git-dir").decode().strip()).resolve()

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
            if path.absolute() != path.resolve() or not path.is_relative_to(ROOT / "external"):
                raise RuntimeError(f"External source path escapes its boundary: {name}")
            if not (path / ".git").exists():
                if any(name == item or name.startswith(item + "/") or item.startswith(name + "/") for item in required):
                    raise RuntimeError(f"Missing required external submodule: {name}")
                continue
            if (path / ".git").is_symlink():
                raise RuntimeError(f"Unsafe external Git metadata link: {name}")
            actual = git(path, "rev-parse", "HEAD").decode().strip()
            if actual != revision.decode():
                raise RuntimeError(f"Pinned revision mismatch: {name}: {actual} != {revision.decode()}")
            staged = git(repo, "ls-files", "--stage", "--", rel).split()
            if staged[:3] != [b"160000", revision, b"0"]:
                raise RuntimeError(f"Staged external revision differs from HEAD: {name}")
            metadata = Path(git(path, "rev-parse", "--absolute-git-dir").decode().strip())
            if metadata != metadata.resolve() or not metadata.is_relative_to(git_root / "modules"):
                raise RuntimeError(f"External Git metadata escapes project: {name}")
            result[name] = {
                "revision": actual,
                "tree": git(path, "rev-parse", "HEAD^{tree}").decode().strip(),
                "status": git(path, "status", "--porcelain=v1", "--untracked-files=all").decode(),
                "trackedDiffSha256": hashlib.sha256(git(path, "diff", "HEAD", "--binary", "--no-ext-diff")).hexdigest(),
                "gitDirectory": str(metadata),
            }
            visit(path, name + "/")

    visit(ROOT)
    missing = required - result.keys()
    if missing:
        raise RuntimeError(f"Required dependency is missing or not Git-pinned: {sorted(missing)}")
    return result


def snapshot(required=None, deep=False):
    deps = dependencies(required)
    git_root = Path(git(ROOT, "rev-parse", "--absolute-git-dir").decode().strip())
    critical = [ROOT / "external/README.md", git_root / "HEAD", git_root / "index", git_root / "config"]
    for name, info in deps.items():
        critical += [ROOT / name / item for item in [".git", "Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]]
        critical += [Path(info["gitDirectory"]) / item for item in ["HEAD", "index", "config", "packed-refs"]]
    result = {"dependencies": deps, "criticalFiles": {str(p): sha(p) for p in critical if p.is_file()}, "deepAudit": deep}
    if deep:
        result["externalFiles"] = inventory(ROOT / "external")
        result["gitMetadata"] = {name: inventory(Path(info["gitDirectory"])) for name, info in deps.items()}
    return result


def artifact_paths(writable):
    """Validate before creating directories or writing any artifact."""
    paths = [Path(p).absolute() for p in writable]
    allowed = [ROOT / p for p in ["target", "src-tauri/target", "src-tauri/gen", "src-tauri/permissions/autogenerated", "dist", "public/rhwp", "node_modules/.vite", "node_modules/.vite-temp"]]
    git_dir = Path(git(ROOT, "rev-parse", "--absolute-git-dir").decode().strip())
    for path in paths:
        if path != path.resolve() or not any(path.is_relative_to(base) for base in allowed) or any(
            path.is_relative_to(p) or p.is_relative_to(path)
            for p in [ROOT / "external", git_dir]
        ):
            raise RuntimeError(f"Unsafe writable artifact directory: {path}")
    for i, path in enumerate(paths):
        if any(path.is_relative_to(other) or other.is_relative_to(path) for other in paths[i + 1:]):
            raise RuntimeError("Overlapping writable mounts are not permitted")
    return paths


def walk_metadata(root):
    """Metadata traversal only; source contents are not read by this alias audit."""
    if not root.exists() and not root.is_symlink():
        return
    yield root, root.lstat()
    if root.is_dir() and not root.is_symlink():
        for child in root.iterdir():
            yield from walk_metadata(child)


def audit_aliases(writable, protected):
    # A pre-existing hardlink could otherwise write an inode through a writable
    # output mount. New cross-mount links are refused by the kernel (EXDEV).
    candidates = set()
    visited = 0
    for root in writable:
        for path, info in walk_metadata(root):
            visited += 1
            if stat.S_ISLNK(info.st_mode) and any(path.resolve().is_relative_to(p) for p in protected):
                raise RuntimeError(f"Writable symlink reaches protected source: {path}")
            if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
                candidates.add((info.st_dev, info.st_ino))
    for root in protected:
        for path, info in walk_metadata(root):
            visited += 1
            if stat.S_ISLNK(info.st_mode) and any(path.resolve().is_relative_to(p) for p in writable):
                raise RuntimeError(f"External source link reaches writable output: {path}")
            if stat.S_ISREG(info.st_mode) and (info.st_dev, info.st_ino) in candidates:
                raise RuntimeError(f"Writable hardlink aliases protected source: {path}")
    return {"metadataEntries": visited, "contentBytesHashed": 0}


def verify_sandbox(policy):
    required = {str(ROOT), str(ROOT / "external"), git(ROOT, "rev-parse", "--absolute-git-dir").decode().strip()}
    if not required.issubset(policy["readOnly"]):
        raise RuntimeError("Incomplete read-only sandbox policy")
    result = {"readOnly": {}, "writable": {}, "denied": []}
    for path in policy["readOnly"]:
        readonly = bool(os.statvfs(path).f_flag & os.ST_RDONLY)
        result["readOnly"][path] = readonly
        if not readonly:
            raise RuntimeError(f"Unsupported sandbox: source mount is writable: {path}")
    for path in policy["writable"]:
        readonly = bool(os.statvfs(path).f_flag & os.ST_RDONLY)
        result["writable"][path] = not readonly
        if readonly:
            raise RuntimeError(f"Sandbox artifact mount is not writable: {path}")
    for path in policy["probes"]:
        # No create/truncate/write: even a failed protection probe cannot damage
        # source bytes. A successful write-open is itself a fail-closed error.
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_APPEND)
        except OSError as exc:
            if exc.errno not in (errno.EROFS, errno.EACCES, errno.EPERM):
                raise
            result["denied"].append({"path": path, "errno": exc.errno})
        else:
            os.close(descriptor)
            raise RuntimeError(f"Unsupported sandbox: source write-open succeeded: {path}")
    return result


def run_readonly(commands, writable, report, *, env=None, require_clean=False, required=None, deep=False, prepare_cache=False):
    started = time.perf_counter()
    bwrap = shutil.which("bwrap")
    if not bwrap:
        raise RuntimeError("bubblewrap (bwrap) required; refusing an unprotected build")
    env = {**(env if env is not None else os.environ), "GIT_OPTIONAL_LOCKS": "0"}
    if prepare_cache:
        cargo = shutil.which("cargo", path=env.get("PATH"))
        expected = [[cargo, "fetch", "--manifest-path", str(ROOT / "src-tauri/Cargo.toml"), "--locked", "--target", host_target(env)]]
        if commands != expected:
            raise RuntimeError("Cache preparation permits only the fixed geul cargo fetch --locked command")
    paths = artifact_paths(writable)
    for path in paths:
        path.mkdir(parents=True, exist_ok=True)
    report = Path(report).absolute()
    if report != report.resolve() or not any(report.is_relative_to(p) for p in paths):
        raise RuntimeError("Integrity report must be in an explicit artifact directory")
    before_at = time.perf_counter()
    before = snapshot(required, deep)
    before_seconds = time.perf_counter() - before_at
    if require_clean and any(info["status"] for info in before["dependencies"].values()):
        raise RuntimeError("External sources have local changes; preserve/review them before building")
    git_dir = Path(git(ROOT, "rev-parse", "--absolute-git-dir").decode().strip())
    # Include metadata of absent/uninitialized working trees as well: their
    # old Git cache must not become writable through an output hardlink.
    protected = [ROOT / "external", git_dir / "modules", git_dir / "HEAD", git_dir / "index", git_dir / "config"]
    read_only = [ROOT, ROOT / "external", git_dir, *[ROOT / name for name in before["dependencies"]]]
    sandbox = [bwrap, "--die-with-parent", "--unshare-pid", "--new-session", "--ro-bind", "/", "/",
               "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"]
    if not prepare_cache:
        sandbox.append("--unshare-net")
    for path in paths:
        sandbox += ["--bind", str(path), str(path)]
    cargo_home = Path(env.get("CARGO_HOME", str(Path.home() / ".cargo"))).absolute()
    bookkeeping = {".global-cache", ".global-cache-shm", ".global-cache-wal", ".global-cache-journal", ".package-cache", ".package-cache-mutate"}
    cache_writes = []
    if cargo_home.is_dir():
        if cargo_home != cargo_home.resolve() or any(p.is_relative_to(cargo_home) or cargo_home.is_relative_to(p) for p in [ROOT, git_dir]):
            raise RuntimeError("Unsafe CARGO_HOME overlaps or redirects protected sources")
        sandbox += ["--bind", str(cargo_home), str(cargo_home)]
        for path in cargo_home.iterdir():
            mutable = path.name in bookkeeping or (prepare_cache and path.name in {"registry", "git"})
            if mutable:
                cache_writes.append(path)
            else:
                sandbox += ["--ro-bind", str(path), str(path)]
                read_only.append(path)
    alias_at = time.perf_counter()
    alias = audit_aliases([*paths, *cache_writes], protected)
    alias_seconds = time.perf_counter() - alias_at
    probes = [ROOT / "external/README.md", git_dir / "index"]
    for name, info in before["dependencies"].items():
        probes += [ROOT / name / p for p in ["Cargo.toml", "Cargo.lock"]]
        probes += [Path(info["gitDirectory"]) / p for p in ["HEAD", "index"]]
    policy = {"readOnly": [str(p) for p in read_only if p.exists()], "writable": [str(p) for p in paths], "probes": [str(p) for p in probes if p.is_file()]}
    report.write_text(json.dumps({"status": "RUNNING", "before": before}, indent=2) + "\n")
    results, proofs = [], []
    error = None
    command_at = time.perf_counter()
    try:
        for number, command in enumerate(commands):
            proof_path = report.with_name(report.stem + f".sandbox-{number}.json")
            child = [sys.executable, str(Path(__file__).resolve()), "--sandbox-child", json.dumps(policy), str(proof_path), *command]
            completed = subprocess.run(sandbox + ["--", *child], cwd=ROOT, env=env)
            results.append(completed.returncode)
            if proof_path.is_file():
                proofs.append(json.loads(proof_path.read_text()))
            if completed.returncode:
                break
    except BaseException as exc:
        error = repr(exc)
    finally:
        command_seconds = time.perf_counter() - command_at
        after_at = time.perf_counter()
        after_error = None
        try:
            after = snapshot(required, deep)
        except (RuntimeError, OSError, subprocess.CalledProcessError) as exc:
            after = None
            after_error = repr(exc)
        after_seconds = time.perf_counter() - after_at
        unchanged = after_error is None and before == after
        success = unchanged and error is None and len(results) == len(commands) and all(c == 0 for c in results) and len(proofs) == len(commands)
        report.write_text(json.dumps({
            "status": "PASS" if success else "FAILED", "readOnlySandbox": True,
            "unchanged": unchanged, "comparison": "deep-content" if deep else "pinned/status/critical-content only; not a full out-of-band content audit",
            "commands": commands, "exitCodes": results, "error": error, "afterSnapshotError": after_error,
            "before": before, "after": after, "sandboxProofs": proofs, "aliasAudit": alias,
            "timings": {"beforeSeconds": before_seconds, "aliasAuditSeconds": alias_seconds, "commandSeconds": command_seconds, "afterSeconds": after_seconds, "totalSeconds": time.perf_counter() - started},
        }, indent=2) + "\n")
    if not unchanged:
        raise RuntimeError(f"BUILD-SYSTEM FAILURE: external identity changed; no automatic restoration. See {report}")
    if not success:
        failure = RuntimeError(f"Protected command/sandbox failed: exits={results}, error={error}; see {report}")
        failure.returncode = results[-1] if results and results[-1] else 1
        raise failure
    return before


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--writable", action="append", default=[])
    parser.add_argument("--report", required=True)
    parser.add_argument("--require", action="append", default=[])
    parser.add_argument("--deep", action="store_true", help="explicit full-content audit, including ignored files/Git metadata")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("command required after --")
    run_readonly([command], args.writable, args.report, required=args.require, deep=args.deep)


if __name__ == "__main__":
    try:
        if sys.argv[1:2] == ["--sandbox-child"]:
            policy = json.loads(sys.argv[2])
            proof = verify_sandbox(policy)
            Path(sys.argv[3]).write_text(json.dumps(proof, indent=2) + "\n")
            os.execvpe(sys.argv[4], sys.argv[4:], os.environ)
        else:
            main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))
