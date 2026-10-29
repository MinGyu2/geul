#!/usr/bin/env python3
"""Build the pinned RHWP library without changing dependency sources."""
import argparse
import importlib.util
import json
import os
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


def publish(source, destination):
    """Replace generated files without following a pre-existing output symlink."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=".rhwp-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(source)
        temporary.chmod(0o644)
        temporary.replace(destination)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dev", action="store_true")
    args = parser.parse_args()
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
    deps = integrity.dependencies()
    if "external/rhwp" not in deps:
        raise RuntimeError("RHWP must be a Git-tracked external submodule")
    lock = tomllib.loads((engine / "Cargo.lock").read_text())
    bindgen_version = next(p["version"] for p in lock["package"] if p["name"] == "wasm-bindgen")
    if versions["wasm-bindgen"] != f"wasm-bindgen {bindgen_version}":
        raise RuntimeError(f"wasm-bindgen CLI must match Cargo.lock: {bindgen_version}")
    profile = "debug" if args.dev else "release"
    env = {**os.environ, "CARGO_TARGET_DIR": str(target), "RUSTC": tools["rustc"],
           "GIT_OPTIONAL_LOCKS": "0", "CARGO_NET_OFFLINE": "true"}
    command = [tools["cargo"], "build", "--manifest-path", str(engine / "Cargo.toml"),
               "--package", "rhwp", "--lib", "--target", "wasm32-unknown-unknown", "--locked", "--offline"]
    if not args.dev:
        command.append("--release")
    # Generate in target first. Only publish a successfully built, verified pair.
    staging = target / "web"
    staging.mkdir(parents=True, exist_ok=True)
    commands = [command, [tools["wasm-bindgen"], str(target / "wasm32-unknown-unknown" / profile / "rhwp.wasm"),
                          "--target", "web", "--out-dir", str(staging), "--out-name", "rhwp"]]
    before = integrity.run_readonly(commands, [target], target / "external-integrity.json", env=env, require_clean=True)
    out.mkdir(parents=True, exist_ok=True)
    for name in ["rhwp.js", "rhwp_bg.wasm"]:
        publish((staging / name).read_bytes(), out / name)
    inputs = [engine / "Cargo.toml", engine / "Cargo.lock", ROOT / ".gitmodules",
              *[ROOT / "scripts" / name for name in ["build-rhwp-wasm.sh", "build-rhwp-wasm.py", "external-integrity.py"]]]
    # Record Cargo configuration in the search path as well as compiler flags.
    cargo_home = Path(env.get("CARGO_HOME", str(Path.home() / ".cargo"))).resolve()
    for directory in [*[base / ".cargo" for base in [ROOT, *ROOT.parents]], cargo_home]:
        for name in ["config", "config.toml"]:
            path = directory / name
            if path.is_file() and path not in inputs:
                inputs.append(path)
    identity = {
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
        "artifacts": {name: integrity.sha(out / name) for name in ["rhwp.js", "rhwp_bg.wasm"]},
        "integrityReport": "target/rhwp-wasm/external-integrity.json",
    }
    publish((json.dumps(identity, indent=2) + "\n").encode(), out / "BUILD.json")
    print(json.dumps({"status": "PASS", "artifacts": identity["artifacts"], "externalUnchanged": True}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError, StopIteration) as exc:
        sys.exit(str(exc))
