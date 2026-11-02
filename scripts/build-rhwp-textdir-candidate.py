#!/usr/bin/env python3
"""Build an isolated, reproducible textDir candidate; never publish app assets.

Incomplete Stage 2: independent external-document losses still block acceptance.
Uses the existing WASM target cache and protected build boundary.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
PIN = "1a76570e833917d15817415a53c09ad61ab3203f"
PATCH = ROOT / "patches/rhwp/hwpx-textdir-ltr.patch"
OUT = ROOT / "target/four-stage/stage2-textdir"
SOURCE = OUT / "source"
CACHE = ROOT / "target/rhwp-wasm"
spec = importlib.util.spec_from_file_location("integrity", ROOT / "scripts/external-integrity.py")
integrity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(integrity)


def source_hashes():
    return {str(p.relative_to(SOURCE)): integrity.sha(p)
            for p in sorted(SOURCE.rglob("*")) if p.is_file()}


def main():
    engine = ROOT / "external/rhwp"
    assert integrity.git(engine, "rev-parse", "HEAD").decode().strip() == PIN
    assert not integrity.git(engine, "status", "--porcelain")
    OUT.mkdir(parents=True, exist_ok=True)
    patch_hash = integrity.sha(PATCH)
    identity = OUT / "source.json"
    if SOURCE.exists():
        recorded = json.loads(identity.read_text())
        assert recorded["pin"] == PIN and recorded["patchSha256"] == patch_hash
        assert recorded["files"] == source_hashes(), "candidate source changed"
    else:
        SOURCE.mkdir()
        # Build inputs only: no document corpus, repository copy or new target cache.
        paths = ["Cargo.toml", "Cargo.lock", "build.rs", "src", "assets", "crates", "vendor",
                 "tools/rhwp-subsecond", "bindings/Native", "tools/batch-convert",
                 "tools/llm_verifier/verdict_protocol", "tools/llm_verifier/claim_bind",
                 "tools/llm_verifier/criteria_decomp", "saved/blank2010.hwp"]
        archive = subprocess.Popen(["git", "-C", str(engine), "archive", PIN, *paths], stdout=subprocess.PIPE)
        with tarfile.open(fileobj=archive.stdout, mode="r|") as stream:
            stream.extractall(SOURCE, filter="data")
        assert archive.wait() == 0
        for mode in (["--check"], []):
            subprocess.run(["git", "apply", "--unsafe-paths", *mode,
                            "--directory=" + str(SOURCE), str(PATCH)], cwd=ROOT, check=True)
        identity.write_text(json.dumps({"pin": PIN, "patchSha256": patch_hash,
                                       "files": source_hashes()}, indent=2) + "\n")
    before = source_hashes()
    cargo, rustc, bindgen = (shutil.which(name) for name in ("cargo", "rustc", "wasm-bindgen"))
    assert cargo and rustc and bindgen, "provide existing cargo, rustc and wasm-bindgen on PATH"
    assert subprocess.check_output([bindgen, "--version"], text=True).strip() == "wasm-bindgen 0.2.127"
    manifest = str(SOURCE / "Cargo.toml")
    package = OUT / "web"
    package.mkdir(exist_ok=True)
    env = {**os.environ, "CARGO_TARGET_DIR": str(CACHE), "RUSTC": rustc,
           "CARGO_BUILD_JOBS": "2", "CARGO_NET_OFFLINE": "true"}
    commands = [[cargo, "build", "--manifest-path", manifest, "-p", "rhwp", "--lib",
                 "--target", "wasm32-unknown-unknown", "--release", "--locked", "--offline"],
                [bindgen, str(CACHE / "wasm32-unknown-unknown/release/rhwp.wasm"),
                 "--target", "web", "--out-dir", str(package), "--out-name", "rhwp"]]
    integrity.run_readonly(commands, [CACHE, package], package / "build-integrity.json", env=env,
                           require_clean=True, required=["external/rhwp"])
    assert source_hashes() == before, "build mutated candidate source"
    (OUT / "candidate.json").write_text(json.dumps({
        "status": "CANDIDATE_NOT_ACCEPTED", "baseCommit": PIN, "patchSha256": patch_hash,
        "sourceSha256": hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(),
        "artifacts": {name: integrity.sha(package / name) for name in ("rhwp.js", "rhwp_bg.wasm")},
        "productAssetsChanged": False,
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
