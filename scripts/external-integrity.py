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
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
GIT_ENV = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}
# Sandbox-private tmpfs. Inherited TMPDIR/TMP/TEMP may name host paths that are
# absent or read-only inside the sandbox; libiberty (collect2/lto-plugin) then
# falls back to "./" and aborts on the read-only source tree.
SANDBOX_TMP = "/tmp"
TEMP_VARIABLES = ("TMPDIR", "TMP", "TEMP", "TEMPDIR")


def sandbox_base(launcher, *, network):
    # Under sudo-bwrap, root creates the tmpfs; bwrap's default 0755 mode would
    # leave it unwritable after setpriv drops to the caller. Use normal sticky
    # /tmp semantics. It is a fresh tmpfs, so no host path becomes writable.
    base = [*launcher, "--die-with-parent", "--unshare-pid", "--new-session", "--ro-bind", "/", "/",
            "--dev", "/dev", "--proc", "/proc", "--perms", "1777", "--tmpfs", SANDBOX_TMP]
    return base if network else [*base, "--unshare-net"]


def sandbox_launcher(env):
    """Only namespace setup may be privileged; the build never is.

    Ubuntu runners can restrict unprivileged UID mappings. Their passwordless
    sudo can create the mount/PID/network namespaces without a user namespace.
    setpriv then drops back to the caller, clears groups and all capabilities.
    No automatic retry or unprotected fallback is permitted.
    """
    mode = env.get("GEUL_SANDBOX", "bwrap")
    bwrap = shutil.which("bwrap", path=env.get("PATH"))
    if not bwrap:
        raise RuntimeError("bubblewrap (bwrap) required; refusing an unprotected build")
    if mode == "bwrap":
        return [bwrap], []
    if mode != "sudo-bwrap":
        raise RuntimeError(f"Unsupported GEUL_SANDBOX: {mode}")
    sudo = shutil.which("sudo", path=env.get("PATH"))
    setpriv = shutil.which("setpriv", path=env.get("PATH"))
    environ = shutil.which("env", path=env.get("PATH"))
    if not sudo or not setpriv or not environ or os.getuid() == 0 or os.getgid() == 0:
        raise RuntimeError("sudo-bwrap requires sudo, setpriv, env and a non-root caller")
    setup = [sudo, "-n", "--", bwrap, "--cap-drop", "ALL"]
    for capability in ("CAP_SETUID", "CAP_SETGID", "CAP_SETPCAP"):
        setup += ["--cap-add", capability]
    # Restore the caller environment only AFTER dropping privileges. Loader
    # variables such as LD_PRELOAD must never apply to the root setpriv stage.
    drop = [setpriv, "--reuid", str(os.getuid()), "--regid", str(os.getgid()),
            "--clear-groups", "--bounding-set=-all", "--inh-caps=-all",
            "--ambient-caps=-all", "--no-new-privs", "--", environ, "-i",
            *[f"{key}={value}" for key, value in env.items()]]
    return setup, drop


def git(repo, *args):
    return subprocess.check_output(
        ["git", "-C", str(repo), *args], env=GIT_ENV
    )


def git_directories(repo=None):
    repo = ROOT if repo is None else repo
    paths = [Path(git(repo, "rev-parse", "--absolute-git-dir").decode().strip()),
             Path(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").decode().strip())]
    result = []
    for path in paths:
        resolved = path.resolve(strict=True)
        if not resolved.is_dir():
            raise RuntimeError(f"Uninspectable Git directory: {path}")
        if resolved not in result:
            result.append(resolved)
    return result


def git_metadata_roots(deps):
    """Entire Git trees, including common/worktree/submodule and object stores."""
    if any(GIT_ENV.get(key) for key in ["GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]):
        raise RuntimeError("Redirected Git object environment is unsupported by the protection policy")
    roots = git_directories()
    # Cached submodule repositories remain relevant even without a checkout.
    # Inspect metadata (not object contents), including their alternate stores.
    for directory in list(roots):
        for path, info in walk_metadata(directory / "modules"):
            if path.name == "objects" and (stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                roots.append(path.parent)
    roots += [Path(info["gitDirectory"]).resolve(strict=True) for info in deps.values()]
    objects, seen = [], set()
    for directory in list(roots):
        # Git permits these paths to be symlinks. Protect their real inodes too.
        for name in ["objects", "refs", "logs", "HEAD", "index", "config", "packed-refs"]:
            path = directory / name
            if path.is_symlink():
                roots.append(path.resolve(strict=True))
        if (directory / "objects").exists():
            objects.append((directory / "objects").resolve(strict=True))
    while objects:
        directory = objects.pop()
        if directory in seen:
            continue
        seen.add(directory)
        if not directory.is_dir():
            raise RuntimeError(f"Uninspectable Git object store: {directory}")
        roots.append(directory)
        alternates = directory / "info/alternates"
        if alternates.exists():
            for line in alternates.read_text().splitlines():
                if not line or line.startswith('"'):
                    raise RuntimeError(f"Unsupported Git alternate path in {alternates}")
                objects.append((directory / line).resolve(strict=True))
    return minimal_roots(roots)


def minimal_roots(paths):
    result = []
    for path in sorted(set(paths), key=lambda p: len(p.parts)):
        if not any(path.is_relative_to(parent) for parent in result):
            result.append(path)
    return result


def reject_mount_aliases(writable, protected):
    """Compare filesystem locations, including bind mounts invisible to resolve().

    This runs before mkdir, including for not-yet-existing output descendants.
    A separate device/inode audit handles ordinary hardlinks. No topology cache.
    """
    mounts = []
    def unescape(value):
        return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), value)
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        fields = line.split(" - ", 1)[0].split()
        mounts.append((fields[2], Path(unescape(fields[3])), Path(unescape(fields[4]))))
    if not mounts:
        raise RuntimeError("Unable to inspect mount topology")
    def regions(paths):
        result = []
        for path in paths:
            device, origin, mount = max((m for m in mounts if path.is_relative_to(m[2])), key=lambda m: len(m[2].parts))
            result.append((device, origin / path.relative_to(mount)))
            result.extend((dev, source) for dev, source, target in mounts if target.is_relative_to(path))
        return result
    protected_regions = regions(protected)
    for device, path in regions(writable):
        if any(device == dev and (path.is_relative_to(source) or source.is_relative_to(path)) for dev, source in protected_regions):
            raise RuntimeError(f"Writable mount aliases protected source/Git metadata: {path}")


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
    git_roots = git_directories()

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
            if metadata != metadata.resolve() or not any(metadata.is_relative_to(root / "modules") for root in git_roots):
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
        result["gitMetadata"] = {str(path): inventory(path) for path in git_metadata_roots(deps)}
    return result


def artifact_paths(writable):
    """Validate before creating directories or writing any artifact."""
    paths = [Path(p).absolute() for p in writable]
    allowed = [ROOT / p for p in ["target", "src-tauri/target", "src-tauri/gen", "src-tauri/permissions/autogenerated", "dist", "public/rhwp", "node_modules/.vite", "node_modules/.vite-temp"]]
    git_dirs = git_directories()
    for path in paths:
        if path != path.resolve() or not any(path.is_relative_to(base) for base in allowed) or any(
            path.is_relative_to(p) or p.is_relative_to(path)
            for p in [ROOT / "external", *git_dirs]
        ):
            raise RuntimeError(f"Unsafe writable artifact directory: {path}")
    for i, path in enumerate(paths):
        if any(path.is_relative_to(other) or other.is_relative_to(path) for other in paths[i + 1:]):
            raise RuntimeError("Overlapping writable mounts are not permitted")
    reject_mount_aliases(paths, [ROOT / "external", *git_metadata_roots({})])
    return paths


def walk_metadata(root, *, required=False):
    """Metadata traversal only; source contents are not read by this alias audit."""
    try:
        info = root.lstat()
    except FileNotFoundError:
        if required:
            raise RuntimeError(f"Missing protected path: {root}")
        return
    yield root, info
    if stat.S_ISDIR(info.st_mode):
        # DirEntry avoids repeated is_dir/is_symlink/lstat calls per entry.
        with os.scandir(root) as entries:
            for entry in entries:
                path = Path(entry.path)
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    yield from walk_metadata(path, required=True)
                else:
                    yield path, info


def audit_aliases(writable, protected, *, creation_roots=()):
    # A pre-existing hardlink could otherwise write an inode through a writable
    # output mount. New cross-mount links are refused by the kernel (EXDEV).
    candidates = set()
    directories = set()
    visited = 0
    for root in writable:
        # New output directories may not exist yet. Detect a protected ancestor
        # before creating them, not after mkdir has already touched that inode.
        ancestor = root
        while not ancestor.exists():
            ancestor = ancestor.parent
        info = ancestor.stat()
        if stat.S_ISDIR(info.st_mode):
            directories.add((info.st_dev, info.st_ino))
        for path, info in walk_metadata(root):
            visited += 1
            if stat.S_ISLNK(info.st_mode) and any(path.resolve().is_relative_to(p) for p in protected):
                raise RuntimeError(f"Writable symlink reaches protected source: {path}")
            if stat.S_ISDIR(info.st_mode):
                directories.add((info.st_dev, info.st_ino))
            if stat.S_ISREG(info.st_mode):
                candidates.add((info.st_dev, info.st_ino))
    for root in minimal_roots(protected):
        for path, info in walk_metadata(root, required=True):
            visited += 1
            if stat.S_ISLNK(info.st_mode) and any(path.resolve().is_relative_to(p) for p in [*writable, *creation_roots]):
                raise RuntimeError(f"External source link reaches writable output: {path}")
            if stat.S_ISREG(info.st_mode) and (info.st_dev, info.st_ino) in candidates:
                raise RuntimeError(f"Writable hardlink aliases protected source: {path}")
            if stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) in directories:
                raise RuntimeError(f"Writable directory aliases protected source: {path}")
    return {"metadataEntries": visited, "contentBytesHashed": 0}


def verify_sandbox(policy):
    required = {str(ROOT), str(ROOT / "external"), git(ROOT, "rev-parse", "--absolute-git-dir").decode().strip()}
    if not required.issubset(policy["readOnly"]):
        raise RuntimeError("Incomplete read-only sandbox policy")
    result = {"readOnly": {}, "writable": {}, "denied": []}
    if policy.get("identity"):
        identity = policy["identity"]
        status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
        if (os.getuid(), os.geteuid(), os.getgid(), os.getegid()) != (identity["uid"], identity["uid"], identity["gid"], identity["gid"]):
            raise RuntimeError("Sandbox did not drop build privileges")
        if any(int(status[name].strip(), 16) for name in ["CapEff", "CapPrm", "CapInh", "CapAmb", "CapBnd"]) or status["NoNewPrivs"].strip() != "1":
            raise RuntimeError("Sandbox retained capabilities or privilege escalation")
        result["identity"] = {"uid": os.getuid(), "gid": os.getgid(), "capabilities": 0, "noNewPrivs": True}
    # Linkers and build scripts need a temporary directory writable by the
    # final build identity. Prove it before Cargo starts, rather than letting
    # collect2 abort later with "Cannot create temporary file in ./".
    if any(os.environ.get(name) != SANDBOX_TMP for name in TEMP_VARIABLES):
        raise RuntimeError("Sandbox temporary directory is not the private tmpfs")
    try:
        descriptor, probe = tempfile.mkstemp(prefix="geul-sandbox-", dir=SANDBOX_TMP)
    except OSError as exc:
        raise RuntimeError(f"Sandbox temporary directory is not writable by the build identity: {exc}")
    os.close(descriptor)
    os.unlink(probe)
    result["temporaryDirectory"] = {"path": SANDBOX_TMP, "writable": True}
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
    env = {**(env if env is not None else os.environ), "GIT_OPTIONAL_LOCKS": "0"}
    # Set before the launcher: sudo-bwrap restores exactly this environment.
    env.update(dict.fromkeys(TEMP_VARIABLES, SANDBOX_TMP))
    launcher, drop_privileges = sandbox_launcher(env)
    if prepare_cache:
        cargo = shutil.which("cargo", path=env.get("PATH"))
        expected = [[cargo, "fetch", "--manifest-path", str(ROOT / "src-tauri/Cargo.toml"), "--locked", "--target", host_target(env)]]
        if commands != expected:
            raise RuntimeError("Cache preparation permits only the fixed geul cargo fetch --locked command")
    paths = artifact_paths(writable)
    report = Path(report).absolute()
    if report != report.resolve() or not any(report.is_relative_to(p) for p in paths):
        raise RuntimeError("Integrity report must be in an explicit artifact directory")
    before_at = time.perf_counter()
    before = snapshot(required, deep)
    before_seconds = time.perf_counter() - before_at
    if require_clean and any(info["status"] for info in before["dependencies"].values()):
        raise RuntimeError("External sources have local changes; preserve/review them before building")
    git_dir = Path(git(ROOT, "rev-parse", "--absolute-git-dir").decode().strip())
    # Include the entire parent/common Git tree, not only selected files or
    # initialized submodules. No source or Git object payloads are hashed here.
    protected = minimal_roots([ROOT / "external", *git_metadata_roots(before["dependencies"])])
    read_only = list(dict.fromkeys([ROOT, *git_directories(), *protected, *[ROOT / name for name in before["dependencies"]]]))
    sandbox = sandbox_base(launcher, network=prepare_cache)
    for path in paths:
        sandbox += ["--bind", str(path), str(path)]
    cargo_home = Path(env.get("CARGO_HOME", str(Path.home() / ".cargo"))).absolute()
    bookkeeping = {".global-cache", ".global-cache-shm", ".global-cache-wal", ".global-cache-journal", ".package-cache", ".package-cache-mutate"}
    cache_writes = []
    cache_creation_roots = []
    if cargo_home.is_dir():
        if cargo_home != cargo_home.resolve() or any(p.is_relative_to(cargo_home) or cargo_home.is_relative_to(p) for p in [ROOT, *protected]):
            raise RuntimeError("Unsafe CARGO_HOME overlaps or redirects protected sources")
        reject_mount_aliases([cargo_home], protected)
        cache_creation_roots.append(cargo_home)
        sandbox += ["--bind", str(cargo_home), str(cargo_home)]
        for path in cargo_home.iterdir():
            mutable = path.name in bookkeeping or (prepare_cache and path.name in {"registry", "git"})
            if mutable:
                cache_writes.append(path)
            else:
                sandbox += ["--ro-bind", str(path), str(path)]
                read_only.append(path)
    alias_at = time.perf_counter()
    reject_mount_aliases([*paths, *cache_writes], protected)
    # Cargo may create new bookkeeping files in its parent. Do not scan all
    # read-only registry payloads, but reject protected links into that entire
    # creation boundary, even when the link's target does not yet exist.
    alias = audit_aliases([*paths, *cache_writes], protected, creation_roots=cache_creation_roots)
    alias_seconds = time.perf_counter() - alias_at
    # No output/source mutation is permitted before all alias checks succeed.
    for path in paths:
        path.mkdir(parents=True, exist_ok=True)
    probes = [ROOT / "external/README.md", git_dir / "index"]
    for directory in git_directories():
        probes += [directory / p for p in ["HEAD", "index", "config", "packed-refs", "refs/heads/master", "logs/HEAD"]]
    for name, info in before["dependencies"].items():
        probes += [ROOT / name / p for p in ["Cargo.toml", "Cargo.lock"]]
        probes += [Path(info["gitDirectory"]) / p for p in ["HEAD", "index"]]
    policy = {"readOnly": [str(p) for p in read_only if p.exists()], "writable": [str(p) for p in paths], "probes": [str(p) for p in probes if p.is_file()]}
    if drop_privileges:
        policy["identity"] = {"uid": os.getuid(), "gid": os.getgid()}
    report.write_text(json.dumps({"status": "RUNNING", "before": before}, indent=2) + "\n")
    results, proofs = [], []
    error = None
    command_at = time.perf_counter()
    preflight_seconds = command_at - started
    try:
        for number, command in enumerate(commands):
            proof_path = report.with_name(report.stem + f".sandbox-{number}.json")
            # A proof left by an earlier run must never certify this command.
            proof_path.unlink(missing_ok=True)
            child = [sys.executable, str(Path(__file__).resolve()), "--sandbox-child", json.dumps(policy), str(proof_path), *command]
            completed = subprocess.run(sandbox + ["--", *drop_privileges, *child], cwd=ROOT, env=env)
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
            "status": "PASS" if success else "FAILED", "readOnlySandbox": bool(proofs), "sandboxMode": env.get("GEUL_SANDBOX", "bwrap"),
            "unchanged": unchanged, "comparison": "deep-content" if deep else "pinned/status/critical-content only; not a full out-of-band content audit",
            "commands": commands, "exitCodes": results, "error": error, "afterSnapshotError": after_error,
            "before": before, "after": after, "sandboxProofs": proofs, "aliasAudit": alias, "protectedPaths": [str(p) for p in protected],
            "writableCacheCreationRoots": [str(p) for p in cache_creation_roots],
            "timings": {"preflightSeconds": preflight_seconds, "beforeSeconds": before_seconds, "aliasAuditSeconds": alias_seconds, "commandSeconds": command_seconds, "afterSeconds": after_seconds, "totalSeconds": time.perf_counter() - started},
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
