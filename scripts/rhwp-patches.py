"""Reproducible, immutable build inputs for the pinned RHWP patch series."""
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PIN = "1a76570e833917d15817415a53c09ad61ab3203f"
SERIES = ("patches/rhwp/hwpx-textdir-ltr.patch", "patches/rhwp/hwpx-duplicate-paragraph-ids.patch")
SOURCE = ROOT / "target/rhwp-patched-source"
MANIFEST = ROOT / "target/rhwp-patched-source.json"
BUILD_PATHS = ("Cargo.toml", "Cargo.lock", "build.rs", "src", "assets", "crates", "vendor",
               "tools/rhwp-subsecond", "bindings/Native", "tools/batch-convert",
               "tools/llm_verifier/verdict_protocol", "tools/llm_verifier/claim_bind",
               "tools/llm_verifier/criteria_decomp", "saved/blank2010.hwp")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def hashes(integrity):
    return {str(path.relative_to(SOURCE)): integrity.sha(path)
            for path in sorted(SOURCE.rglob("*")) if path.is_file()}


def patch_identity(integrity):
    return [{"path": name, "sha256": integrity.sha(ROOT / name)} for name in SERIES]


def seal(integrity):
    """Record already prepared inputs; callers must verify provenance before sealing."""
    record = {"pin": PIN, "patches": patch_identity(integrity), "files": hashes(integrity)}
    with tempfile.NamedTemporaryFile(mode="w", dir=MANIFEST.parent, prefix="rhwp-source-", suffix=".json.tmp", delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(record, stream, indent=2)
        stream.write("\n")
    temporary.replace(MANIFEST)
    return record


def prepare(integrity):
    integrity.artifact_paths([SOURCE, MANIFEST])
    engine = ROOT / "external/rhwp"
    require(integrity.git(engine, "rev-parse", "HEAD").decode().strip() == PIN, "RHWP patch base does not match pinned commit")
    require(not integrity.git(engine, "status", "--porcelain"), "RHWP source must remain clean")
    patches = patch_identity(integrity)
    if SOURCE.exists():
        require(MANIFEST.is_file() and not MANIFEST.is_symlink(), "Prepared RHWP input manifest is missing")
        record = json.loads(MANIFEST.read_text())
        require(record["pin"] == PIN and record["patches"] == patches, "Prepared RHWP patch identity changed; preserve and inspect existing source")
        require(record["files"] == hashes(integrity), "Prepared RHWP source changed; refusing stale/unreviewed build")
    else:
        SOURCE.mkdir(parents=True)
        archive = subprocess.Popen(["git", "-C", str(engine), "archive", PIN, *BUILD_PATHS], stdout=subprocess.PIPE)
        try:
            with tarfile.open(fileobj=archive.stdout, mode="r|") as stream:
                stream.extractall(SOURCE, filter="data")
        finally:
            archive.stdout.close()
        require(archive.wait() == 0, "Pinned RHWP build input export failed")
        for patch in SERIES:
            for mode in (["--check"], []):
                subprocess.run(["git", "apply", "--unsafe-paths", *mode,
                                "--directory=" + str(SOURCE), str(ROOT / patch)], cwd=ROOT, check=True)
        record = seal(integrity)
    tree = hashlib.sha256((json.dumps(record["files"], sort_keys=True) + "\n").encode()).hexdigest()
    return SOURCE, {"kind": "patched-upstream", "sourceTreeSha256": tree,
                    "patches": [{"name": Path(p["path"]).name, "sha256": p["sha256"]} for p in patches]}


def verify_unchanged(integrity, identity):
    _, current = prepare(integrity)
    require(current == identity, "RHWP build mutated source identity")
