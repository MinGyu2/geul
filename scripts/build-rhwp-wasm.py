#!/usr/bin/env python3
"""Build the pinned RHWP library without changing dependency sources."""
import argparse
import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("integrity", ROOT / "scripts/external-integrity.py")
integrity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(integrity)
artifact_spec = importlib.util.spec_from_file_location("artifacts", ROOT / "scripts/rhwp-artifacts.py")
artifacts = importlib.util.module_from_spec(artifact_spec)
artifact_spec.loader.exec_module(artifacts)


publish = artifacts.atomic_file


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dev", action="store_true")
    args = parser.parse_args()
    target = ROOT / "target/rhwp-wasm"
    integrity.artifact_paths([target, ROOT / "public/rhwp"])
    target.mkdir(parents=True, exist_ok=True)
    # Cargo's cache lock alone does not serialize wasm-bindgen/publication.
    with artifacts.locked(target / "build.lock"):
        if len(list(target.glob("web-*"))) >= artifacts.MAX_GENERATIONS:
            raise RuntimeError("Interrupted build staging limit reached; inspect retained generated artifacts explicitly")
        with tempfile.TemporaryDirectory(dir=target, prefix="web-") as folder:
            build(args.dev, Path(folder))


def build(dev, staging):
    engine = ROOT / "external/rhwp"
    target = ROOT / "target/rhwp-wasm"
    out = ROOT / "public/rhwp"
    # Fail before mkdir/copy if an output directory redirects into source files.
    integrity.artifact_paths([target, out])
    # Resolve tools before touching the current product artifacts.
    tools = {name: shutil.which(name) for name in ["cargo", "rustc", "wasm-bindgen"]}
    if not all(tools.values()):
        raise RuntimeError("Install/provide cargo, rustc (prefer 1.99.0), wasm32-unknown-unknown and the locked wasm-bindgen CLI on PATH; no automatic installation")
    versions = {name: subprocess.check_output([path, "--version"], text=True).strip() for name, path in tools.items()}
    deps = integrity.dependencies(["external/rhwp"])
    if "external/rhwp" not in deps:
        raise RuntimeError("RHWP must be a Git-tracked external submodule")
    lock = tomllib.loads((engine / "Cargo.lock").read_text())
    bindgen_version = next(p["version"] for p in lock["package"] if p["name"] == "wasm-bindgen")
    if versions["wasm-bindgen"] != f"wasm-bindgen {bindgen_version}":
        raise RuntimeError(f"wasm-bindgen CLI must match Cargo.lock: {bindgen_version}")
    optimization = {"tool": "none", "version": None, "flags": []}
    optimizer = None
    if not dev:
        optimizer = shutil.which("wasm-opt")
        if not optimizer:
            raise RuntimeError("Release requires wasm-opt 117 on PATH; optimization is never silently skipped")
        optimizer_version = subprocess.check_output([optimizer, "--version"], text=True).strip()
        if not re.fullmatch(r"wasm-opt version 117(?: \([^\n]*\))?", optimizer_version):
            raise RuntimeError("Expected the recorded wasm-pack Binaryen baseline: wasm-opt 117")
        optimization = {"tool": "wasm-opt", "version": "117", "flags": list(artifacts.OPT_FLAGS)}
    profile = "debug" if dev else "release"
    env = {**os.environ, "CARGO_TARGET_DIR": str(target), "RUSTC": tools["rustc"],
           "GIT_OPTIONAL_LOCKS": "0", "CARGO_NET_OFFLINE": "true", "BINARYEN_CORES": "2"}
    command = [tools["cargo"], "build", "--manifest-path", str(engine / "Cargo.toml"),
               "--package", "rhwp", "--lib", "--target", "wasm32-unknown-unknown", "--locked", "--offline"]
    if not dev:
        command.append("--release")
    # Generate in target first. Only publish a successfully built, verified pair.
    commands = [command, [tools["wasm-bindgen"], str(target / "wasm32-unknown-unknown" / profile / "rhwp.wasm"),
                          "--target", "web", "--out-dir", str(staging), "--out-name", "rhwp"]]
    if dev:
        commands[1].append("--debug")
    if optimizer:
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js required to validate optimizer WASM ABI")
        commands += [[optimizer, str(staging / "rhwp_bg.wasm"), "-o", str(staging / "rhwp_bg.optimized.wasm"), *artifacts.OPT_FLAGS],
                     [node, str(ROOT / "scripts/check-wasm-interface.mjs"), str(staging / "rhwp_bg.wasm"), str(staging / "rhwp_bg.optimized.wasm"), str(staging / "interface.json")]]
    before = integrity.run_readonly(commands, [target], target / "external-integrity.json", env=env, require_clean=True, required=["external/rhwp"])
    interface = None
    if optimizer:
        interface = json.loads((staging / "interface.json").read_text())
        (staging / "rhwp_bg.optimized.wasm").replace(staging / "rhwp_bg.wasm")
    inputs = [engine / "Cargo.toml", engine / "Cargo.lock", ROOT / ".gitmodules",
              *[ROOT / "scripts" / name for name in ["build-rhwp-wasm.sh", "build-rhwp-wasm.py", "external-integrity.py", "rhwp-artifacts.py", "check-wasm-interface.mjs"]]]
    # Record Cargo configuration in the search path as well as compiler flags.
    cargo_home = Path(env.get("CARGO_HOME", str(Path.home() / ".cargo"))).resolve()
    for directory in [*[base / ".cargo" for base in [ROOT, *ROOT.parents]], cargo_home]:
        for name in ["config", "config.toml"]:
            path = directory / name
            if path.is_file() and path not in inputs:
                inputs.append(path)
    local_report = {
        "engine": "rhwp", "commit": deps["external/rhwp"]["revision"],
        "integration": "upstream-unmodified", "profile": profile, "tools": versions,
        "geulHead": integrity.git(ROOT, "rev-parse", "HEAD").decode().strip(),
        "dependencies": before["dependencies"], "commands": commands,
        "inputs": {str(p.relative_to(ROOT)) if p.is_relative_to(ROOT) else str(p): integrity.sha(p) for p in inputs},
        "environment": {k: env[k] for k in [
            "CARGO_HOME", "CARGO_TARGET_DIR", "CARGO_NET_OFFLINE", "CARGO_BUILD_JOBS",
            "CARGO_ENCODED_RUSTFLAGS", "RUSTFLAGS", "RUSTC", "RUSTC_WRAPPER",
            "RUSTC_WORKSPACE_WRAPPER", "RUSTUP_TOOLCHAIN", "SOURCE_DATE_EPOCH",
        ] if k in env},
        "artifacts": {name: integrity.sha(staging / name) for name in artifacts.ARTIFACTS},
        "integrityReport": "target/rhwp-wasm/external-integrity.json",
        "optimization": optimization, "wasmInterface": interface,
        "optimizerExecutableSha256": integrity.sha(Path(optimizer)) if optimizer else None,
    }
    # Local paths/configuration and diagnostic detail stay outside public assets.
    publish((json.dumps(local_report, indent=2) + "\n").encode(), target / "build-report.json")
    source_fingerprint = artifacts.fingerprint({
        "repositoryInputs": {k: v for k, v in local_report["inputs"].items() if not Path(k).is_absolute()},
        "cargoConfiguration": [v for k, v in local_report["inputs"].items() if Path(k).is_absolute()],
        "codegen": {k: env[k] for k in ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "SOURCE_DATE_EPOCH"] if k in env},
        "optimizerExecutableSha256": local_report["optimizerExecutableSha256"],
    })
    identity = artifacts.make_identity(
        deps["external/rhwp"]["revision"], profile,
        {name: version.split()[1] for name, version in versions.items()},
        source_fingerprint, local_report["artifacts"], optimization=optimization,
    )
    artifacts.publish_generation(staging, out, identity, target)
    print(json.dumps({"status": "PASS", "generation": identity["generation"], "artifacts": identity["artifacts"], "externalUnchanged": True}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, OSError, subprocess.CalledProcessError, StopIteration) as exc:
        sys.exit(str(exc))
