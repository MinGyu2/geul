"""Public RHWP artifact identity; local build diagnostics never belong here."""
import hashlib
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

ARTIFACTS = ("rhwp.js", "rhwp_bg.wasm")
PUBLIC_FIELDS = {"schemaVersion", "engine", "commit", "profile", "tools", "sourceFingerprint", "generation", "artifacts"}
HEX256 = re.compile(r"[0-9a-f]{64}")
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?")
MAX_GENERATIONS = 6
OPT_FLAGS = ("-O",)


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def fingerprint(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_identity(identity):
    if not isinstance(identity, dict):
        raise ValueError("Unexpected public identity fields")
    schema = identity.get("schemaVersion")
    if set(identity) != PUBLIC_FIELDS | ({"optimization"} if schema == 2 else set()):
        raise ValueError("Unexpected public identity fields")
    if type(schema) is not int or schema not in (1, 2) or identity["engine"] != "rhwp":
        raise ValueError("Unsupported artifact schema/engine")
    if not isinstance(identity["commit"], str) or not re.fullmatch(r"[0-9a-f]{40}", identity["commit"]):
        raise ValueError("Invalid engine commit")
    if identity["profile"] not in ("debug", "release"):
        raise ValueError("Invalid build profile")
    if schema == 2:
        optimization = identity["optimization"]
        expected = ({"tool": "none", "version": None, "flags": []} if identity["profile"] == "debug" else
                    {"tool": "wasm-opt", "version": "117", "flags": list(OPT_FLAGS)})
        if optimization != expected:
            raise ValueError("Unsupported optimization configuration")
    tools = identity["tools"]
    if not isinstance(tools, dict) or set(tools) != {"cargo", "rustc", "wasm-bindgen"}:
        raise ValueError("Invalid public tool identities")
    if any(not isinstance(v, str) or not VERSION.fullmatch(v) for v in tools.values()):
        raise ValueError("Tool identities must contain versions only")
    hashes = identity["artifacts"]
    if not isinstance(hashes, dict) or set(hashes) != set(ARTIFACTS):
        raise ValueError("Invalid artifact names")
    for value in [*hashes.values(), identity["sourceFingerprint"], identity["generation"]]:
        if not isinstance(value, str) or not HEX256.fullmatch(value):
            raise ValueError("Invalid identity digest")
    if identity["generation"] != fingerprint({k: v for k, v in identity.items() if k != "generation"}):
        raise ValueError("Artifact generation does not match identity")
    return identity


def make_identity(commit, profile, tools, source_fingerprint, hashes, *, optimization=None):
    identity = {"schemaVersion": 1, "engine": "rhwp", "commit": commit,
                "profile": profile, "tools": tools, "sourceFingerprint": source_fingerprint,
                "artifacts": hashes}
    if optimization is not None:
        identity["schemaVersion"] = 2
        identity["optimization"] = optimization
    identity["generation"] = fingerprint(identity)
    return validate_identity(identity)


def verify_files(directory, identity):
    validate_identity(identity)
    for name in ARTIFACTS:
        path = Path(directory) / name
        if path.is_symlink() or not path.is_file() or file_hash(path) != identity["artifacts"][name]:
            raise ValueError(f"Missing or invalid generated artifact: {name}")


@contextmanager
def locked(path):
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def atomic_file(source, destination):
    temporary = None
    try:
        if len(list(destination.parent.glob(".rhwp-*"))) >= MAX_GENERATIONS:
            raise RuntimeError("Interrupted artifact staging limit reached; inspect retained output files explicitly")
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=".rhwp-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(source)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o644)
        temporary.replace(destination)
        sync_directory(destination.parent)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def publish_generation(source, out, identity, workspace):
    """Install immutable files, then atomically switch the single selector.

    Retention is bounded by refusing a seventh generation, never by deleting
    something a cached page may still use. Retire old artifacts only while all
    consumers/builds are stopped. Interrupted staging is local to target/.
    """
    source, out, workspace = Path(source), Path(out), Path(workspace)
    verify_files(source, identity)
    out.mkdir(parents=True, exist_ok=True)
    generations = out / "generations"
    if generations.is_symlink():
        raise ValueError("Generation directory must not be a symlink")
    generations.mkdir(exist_ok=True)
    generation = generations / identity["generation"]
    with locked(workspace / "publication.lock"):
        if generation.exists() or generation.is_symlink():
            if generation.is_symlink() or not generation.is_dir():
                raise ValueError("Invalid immutable generation directory")
            verify_files(generation, identity)
            if (generation / "BUILD.json").read_bytes() != encoded(identity):
                raise ValueError("Immutable generation identity differs")
        else:
            if len(list(generations.iterdir())) >= MAX_GENERATIONS:
                raise RuntimeError("Generation retention limit reached; retire generated artifacts explicitly with all consumers stopped")
            if len(list(workspace.glob("publication-*"))) >= MAX_GENERATIONS:
                raise RuntimeError("Interrupted publication staging limit reached; inspect retained artifact staging explicitly")
            with tempfile.TemporaryDirectory(dir=workspace, prefix="publication-") as folder:
                pending = Path(folder) / "generation"
                pending.mkdir()
                for name in ARTIFACTS:
                    shutil.copyfile(source / name, pending / name)
                atomic_file(encoded(identity), pending / "BUILD.json")
                verify_files(pending, identity)
                for name in ARTIFACTS:
                    with (pending / name).open("rb") as stream:
                        os.fsync(stream.fileno())
                sync_directory(pending)
                # Atomic directory install; EXDEV/permission errors leave the
                # active selector and previous generation completely intact.
                os.replace(pending, generation)
                sync_directory(generations)
        atomic_file(encoded(identity), out / "BUILD.json")
    return generation
