#!/usr/bin/env python3
"""Protect Tauri builds; dev protects compilation and preserves GUI file access."""
import importlib.util
import os
import re
import subprocess
import tomllib
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("integrity", ROOT / "scripts/external-integrity.py")
integrity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(integrity)


path_spec = importlib.util.spec_from_file_location("release_paths", ROOT / "scripts/check-release-paths.py")
release_paths = importlib.util.module_from_spec(path_spec)
path_spec.loader.exec_module(release_paths)


def cargo_configs(env):
    home = Path(env.get("HOME", str(Path.home())))
    cargo = Path(env.get("CARGO_HOME", str(home / ".cargo"))).absolute()
    for directory in dict.fromkeys([ROOT / "src-tauri/.cargo", ROOT / ".cargo", *[p / ".cargo" for p in ROOT.parents], cargo]):
        # Cargo prefers the extensionless legacy file if both exist.
        path = directory / "config"
        if not path.is_file():
            path = directory / "config.toml"
        if path.is_file():
            yield path, tomllib.loads(path.read_text())


def release_environment(env):
    """Compose Cargo's effective flags without shell quoting or losing Nix linker settings."""
    env = dict(env)
    configs = list(cargo_configs(env))
    for path, config in configs:
        if config.get("build", {}).get("target"):
            raise RuntimeError(f"Release gate requires an explicit --target, not build.target in {path}")
        if any(key in config.get("env", {}) for key in ("RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS")):
            raise RuntimeError(f"Release flags cannot safely compose Cargo [env] overrides in {path}")
    # https://doc.rust-lang.org/cargo/reference/config.html#buildrustflags
    if "CARGO_ENCODED_RUSTFLAGS" in env:
        flags = env["CARGO_ENCODED_RUSTFLAGS"].split("\x1f") if env["CARGO_ENCODED_RUSTFLAGS"] else []
    elif "RUSTFLAGS" in env:
        flags = env["RUSTFLAGS"].split()  # Cargo splits whitespace, not shell-quoted words.
    else:
        if any("rustflags" in config.get("build", {}) or
               any("rustflags" in target for target in config.get("target", {}).values()) for _, config in configs) or any(
               k == "CARGO_BUILD_RUSTFLAGS" or k.startswith("CARGO_TARGET_") and k.endswith("_RUSTFLAGS") for k in env):
            raise RuntimeError("Release cannot safely flatten configured target/cfg rustflags; supply their effective flags via RUSTFLAGS or CARGO_ENCODED_RUSTFLAGS")
        flags = []
    if any(not flag or flag.startswith(("--remap-path-prefix", "--remap-path-scope")) for flag in flags):
        raise RuntimeError("Inherited remapping/empty arguments conflict with the Release remapping policy")
    home = Path(env.get("HOME", str(Path.home()))).absolute()
    cargo = Path(env.get("CARGO_HOME", str(home / ".cargo"))).absolute()
    # rustc uses the LAST matching prefix. Broad home first, specific source roots last.
    mappings = [(home, "/src/home"), (cargo, "/src/cargo"), (ROOT, "/src/geul")]
    for source, virtual in mappings:
        for prefix in dict.fromkeys((str(source), str(source.resolve()))):
            if prefix == "/" or "\x1f" in prefix:
                raise RuntimeError("Unsafe Release source prefix")
            flags.append(f"--remap-path-prefix={prefix}={virtual}")
    env.pop("RUSTFLAGS", None)
    env["CARGO_ENCODED_RUSTFLAGS"] = "\x1f".join(flags)
    # Nix's linker wrapper whitespace-splits these variables. Remove only a
    # nonexistent private -rpath directory (a stale dev-shell output), never a
    # live library directory or the store paths needed by the application.
    roots = release_paths.private_roots(env)
    for key in list(env):
        if not key.startswith("NIX_LDFLAGS"):
            continue
        tokens = env[key].split()
        retained = []
        index = 0
        while index < len(tokens):
            if tokens[index] == "-rpath":
                if index + 1 == len(tokens):
                    raise RuntimeError(f"Malformed {key}: missing -rpath value")
                values = []
                for value in tokens[index + 1].split(":"):
                    _, private = release_paths.scan_paths(value.encode(), roots)
                    if private:
                        if not Path(value).is_absolute() or os.path.lexists(value):
                            raise RuntimeError(f"Private runtime directory in {key} requires dependency review; refusing to remove it")
                    else:
                        values.append(value)
                if values:
                    retained.extend(["-rpath", ":".join(values)])
                index += 2
            else:
                retained.append(tokens[index])
                index += 1
        if retained != tokens:
            env[key] = " ".join(retained)
    return env


def release_artifact(args, env):
    # Reject output/profile overrides instead of checking an unrelated old binary.
    forbidden = {"--profile", "--target-dir", "--manifest-path", "--config", "--bin", "--example", "--test", "--bench", "--lib", "--package", "-p", "--workspace"}
    separator = args.index("--") if "--" in args else len(args)
    if any(a.split("=", 1)[0] in forbidden for a in args[separator + 1:]):
        raise RuntimeError("Release gate requires the standard geul executable/profile/output")
    target = env.get("CARGO_BUILD_TARGET")
    for index, arg in enumerate(args):
        if arg in {"--target", "-t"}:
            target = args[index + 1] if index + 1 < len(args) else ""
        elif arg.startswith("--target="):
            target = arg.split("=", 1)[1]
    binary = ROOT / "src-tauri/target"
    if target is not None:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", target):
            raise RuntimeError("Unsupported Release target path")
        binary /= target
    return binary / "release/geul"


def project_command(command, artifact=None):
    # bwrap's private-root mode may start the payload in `/`. Tauri and its
    # frontend hook need the verified project root, inside the same protection.
    if artifact is None:
        return [sys.executable, "-c",
                "import os, sys; os.chdir(sys.argv[1]); os.execv(sys.argv[2], sys.argv[2:])",
                str(ROOT), *command]
    # Runs only INSIDE the proven read-only sandbox. Remove just the previous
    # final output, not dependency caches: Cargo must produce this build's file.
    return [sys.executable, "-c",
            "import os, pathlib, sys\nos.chdir(sys.argv[1])\np=pathlib.Path(sys.argv[2])\n"
            "if p.is_symlink(): raise RuntimeError('Release artifact must not be a symlink')\n"
            "p.unlink(missing_ok=True)\nos.execv(sys.argv[3], sys.argv[3:])",
            str(ROOT), str(artifact), *command]


def main():
    args = sys.argv[1:]
    if args and args[0] == "--":
        args = args[1:]
    if not args or args[0] not in {"build", "dev"}:
        raise RuntimeError("Usage: npm run tauri -- build|dev [Tauri arguments]")
    executable = ROOT / "node_modules/.bin/tauri"
    if not executable.exists():
        raise RuntimeError("The locked npm dependencies must already be installed")
    # The caller cannot silently replace the protected Cargo runner.
    if any(arg.split("=", 1)[0] in {"--runner", "-r"} for arg in args):
        raise RuntimeError("Tauri uses the protected Cargo runner")
    dev = args[0] == "dev"
    if dev:
        args = [args[0], "--runner", str(ROOT / "scripts/cargo-geul.py"), *args[1:]]
    separator = args.index("--") if "--" in args else len(args)
    runner_args = args[separator + 1:]
    args = [*args[:separator], "--", *[flag for flag in ["--locked", "--offline"] if flag not in runner_args], *runner_args]
    writable = [ROOT / p for p in ["target/rhwp-wasm", "src-tauri/target", "src-tauri/gen", "src-tauri/permissions/autogenerated", "dist", "node_modules/.vite", "node_modules/.vite-temp"]]
    env = {**os.environ, "CARGO_TARGET_DIR": str(ROOT / "src-tauri/target"), "CARGO_NET_OFFLINE": "true"}
    # Override inherited frontend-only/debug settings for a real product build.
    env["GEUL_RHWP_PROFILE"] = "debug" if dev or "--debug" in args else "release"
    if "RUST_TOOLCHAIN" in env:
        env["RUSTUP_TOOLCHAIN"] = env["RUST_TOOLCHAIN"]
    if dev:
        # Tauri uses `cargo run`. Our runner splits protected compilation from
        # application execution so saving user documents remains functional.
        integrity.dependencies(["external/wordcraft"])
        env["GEUL_TAURI_RUNNER"] = "1"
        os.execvpe(str(executable), [str(executable), *args], env)
    release = "--debug" not in args and "-d" not in args
    artifact = None
    if release:
        artifact = release_artifact(args, env)
        env = release_environment(env)
    integrity.run_readonly([project_command([str(executable), *args], artifact)], writable, ROOT / "target/rhwp-wasm/tauri-integrity.json",
                           env=env, required=["external/wordcraft"], require_clean=True)
    if release:
        # A compilation exit code is not acceptance. Scanner errors also fail the build.
        report = ROOT / "src-tauri/target/release-paths.json"
        subprocess.run([sys.executable, str(ROOT / "scripts/check-release-paths.py"), str(artifact), "--report", str(report)],
                       env=env, check=True)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as exc:
        sys.exit(str(exc))
