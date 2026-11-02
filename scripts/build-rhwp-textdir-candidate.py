#!/usr/bin/env python3
"""Build the isolated HWPX preservation candidate; never publish app assets.

Uses the same pinned patched inputs, target cache and protected build boundary
as the supported application build. Promotion requires separate acceptance.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "target/hwpx-preservation-candidate"
CACHE = ROOT / "target/rhwp-wasm"


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


integrity = module("integrity", ROOT / "scripts/external-integrity.py")
patches = module("patches", ROOT / "scripts/rhwp-patches.py")


def main():
    source, integration = patches.prepare(integrity)
    tools = {name: shutil.which(name) for name in ("cargo", "rustc", "wasm-bindgen")}
    patches.require(all(tools.values()), "provide installed cargo, rustc and wasm-bindgen on PATH")
    versions = {name: subprocess.check_output([path, "--version"], text=True).strip() for name, path in tools.items()}
    patches.require(versions["wasm-bindgen"] == "wasm-bindgen 0.2.127", "wasm-bindgen must match Cargo.lock")
    package = OUT / "web"
    integrity.artifact_paths([package, CACHE])
    package.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "CARGO_TARGET_DIR": str(CACHE), "RUSTC": tools["rustc"],
           "CARGO_BUILD_JOBS": "2", "CARGO_NET_OFFLINE": "true"}
    commands = [[tools["cargo"], "build", "--manifest-path", str(source / "Cargo.toml"), "--package", "rhwp", "--lib",
                 "--target", "wasm32-unknown-unknown", "--release", "--locked", "--offline"],
                [tools["wasm-bindgen"], str(CACHE / "wasm32-unknown-unknown/release/rhwp.wasm"),
                 "--target", "web", "--out-dir", str(package), "--out-name", "rhwp"]]
    integrity.run_readonly(commands, [CACHE, package], package / "build-integrity.json", env=env,
                           require_clean=True, required=["external/rhwp"])
    patches.verify_unchanged(integrity, integration)
    (OUT / "candidate.json").write_text(json.dumps({
        "status": "CANDIDATE_NOT_ACCEPTED", "baseCommit": patches.PIN, "integration": integration,
        "tools": versions, "commands": commands,
        "artifacts": {name: integrity.sha(package / name) for name in ("rhwp.js", "rhwp_bg.wasm")},
        "productAssetsChanged": False,
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
