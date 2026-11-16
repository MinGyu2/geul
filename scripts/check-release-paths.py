#!/usr/bin/env python3
"""Fail-closed privacy gate for native Linux Release ELF executables.

Counts are byte occurrences, not unique paths or `strings` lines. Reports can
contain private evidence: write them only to ignored artifact directories.
Portability requires separate target-distribution execution evidence.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def private_roots(env, root=ROOT):
    home = Path(env.get("HOME", str(Path.home()))).absolute()
    cargo = Path(env.get("CARGO_HOME", str(home / ".cargo"))).absolute()
    roots = [("privateProject", root), ("privateCargo", cargo), ("developerHome", home)]
    # Also cover resolved paths when the checkout or cache is reached through a symlink.
    return sorted({(kind, str(p)) for kind, path in roots for p in (path, path.resolve())
                   if str(p) != "/"}, key=lambda pair: (-len(pair[1]), pair))


def scan_paths(data, roots):
    counts = {k: 0 for k in ("privateProject", "privateCargo", "developerHome", "otherPrivateHome",
                             "virtualSource", "systemRuntime", "nixStore", "buildSystemSource")}
    patterns = [(kind, re.escape(path.encode())) for kind, path in roots]
    patterns += [("otherPrivateHome", rb"(?:/(?:home|Users)/[^/\s\x00:]+|/root|[A-Za-z]:[\\/]Users[\\/][^\\/\s\x00:]+)")]
    # Matching roots directly also finds adjacent/packed strings that strings(1) merges.
    matcher = re.compile(b"|".join(b"(?P<p%d>" % i + value + rb")(?=[/\\\x00\s:]|$)"
                                     for i, (_, value) in enumerate(patterns)))
    findings = []
    tail_pattern = re.compile(rb"[^\x00\s\x01-\x1f\"'<>\[\]:;]*")
    for match in matcher.finditer(data):
        kind = patterns[int(match.lastgroup[1:])][0]
        counts[kind] += 1
        tail = tail_pattern.match(data, match.start(), match.start() + 1024)
        findings.append({"category": kind, "offset": match.start(),
                         "path": tail[0][:1024].decode("utf-8", "replace")})
    for kind, pattern in [("virtualSource", rb"/src/(?:geul|cargo|home)(?=/|\x00)"),
                          ("systemRuntime", rb"/(?:usr/(?:lib|share|bin)|lib64|lib|etc|run)(?=/|\x00)"),
                          ("nixStore", rb"/nix/store/"), ("buildSystemSource", rb"/(?:rustc|build)/")]:
        counts[kind] = len(re.findall(pattern, data))
    return counts, findings


def inspect_elf(path, data):
    expected_machine = {"x86_64": 62, "aarch64": 183}.get(platform.machine())
    if len(data) < 64 or data[:7] != b"\x7fELF\x02\x01\x01":
        raise RuntimeError("Expected a nonempty ELF64 little-endian executable")
    elf_type, machine, version, entry = struct.unpack_from("<HHIQ", data, 16)
    if elf_type not in (2, 3) or version != 1 or not entry or machine != expected_machine:
        raise RuntimeError("Unsupported ELF type/architecture or missing executable entry point")
    outputs = {}
    for key, flag in [("header", "-hW"), ("program", "-lW"), ("dynamic", "-dW"), ("sections", "-SW")]:
        result = subprocess.run(["readelf", flag, str(path)], capture_output=True, text=True,
                                encoding="utf-8", errors="strict", env={**os.environ, "LC_ALL": "C"}, timeout=30)
        if result.returncode or result.stderr.strip() or not result.stdout.strip():
            raise RuntimeError(f"readelf {flag} inspection failed: {result.stderr.strip()}")
        outputs[key] = result.stdout
    interpreter = re.findall(r"\[Requesting program interpreter: ([^\]\n]+)\]", outputs["program"])
    needed = re.findall(r"\(NEEDED\).*?\[([^\]\n]+)\]", outputs["dynamic"])
    if len(interpreter) != 1 or not needed or "Dynamic section at offset" not in outputs["dynamic"]:
        raise RuntimeError("Expected an inspectable dynamically linked Linux executable")
    runtime = re.findall(r"\((?:RUNPATH|RPATH)\).*?\[([^\]\n]*)\]", outputs["dynamic"])
    return {"architecture": platform.machine(), "interpreter": interpreter[0],
            "rpathRunpath": [p for value in runtime for p in value.split(":")], "needed": needed,
            "debugSections": bool(re.search(r"\.(?:z?debug_)", outputs["sections"])),
            "symbolTable": ".symtab" in outputs["sections"]}


def check(path, env=None, root=ROOT):
    env = dict(os.environ if env is None else env)
    report = {"privacyStatus": "ERROR", "runtimePathStatus": "ERROR", "portabilityStatus": "NOT VERIFIED"}
    try:
        path = Path(path).absolute()
        if path.is_symlink() or not path.is_file() or not os.access(path, os.X_OK):
            raise RuntimeError("Artifact must be an existing regular executable, not a symlink")
        data = path.read_bytes()
        roots = private_roots(env, root)
        counts, findings = scan_paths(data, roots)
        elf = inspect_elf(path, data)
        runtime_findings = []
        for value in [elf["interpreter"], *elf["rpathRunpath"], *elf["needed"]]:
            _, private = scan_paths(value.encode(), roots)
            runtime_findings += private
        report.update({"artifact": str(path), "sha256": hashlib.sha256(data).hexdigest(), "size": len(data),
                       "counts": counts, "forbiddenCount": len(findings), "findings": findings,
                       "elf": elf, "runtimePrivateCount": len(runtime_findings),
                       "privacyStatus": "FAIL" if findings else "PASS",
                       "runtimePathStatus": "FAIL" if runtime_findings else "PASS"})
        if elf["interpreter"].startswith("/nix/store/") or counts["nixStore"]:
            report["portabilityReason"] = "Nix store runtime dependencies; Debian/Ubuntu portability is not established"
        # Detect replacement during inspection, rather than certifying different bytes.
        if path.read_bytes() != data:
            raise RuntimeError("Artifact changed during inspection")
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        report.update(privacyStatus="ERROR", runtimePathStatus="ERROR", error=str(exc))
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("--report", type=Path, help="JSON evidence (use an ignored target/ path)")
    args = parser.parse_args(argv)
    result = check(args.executable)
    text = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    if args.report:
        args.report.write_text(text)
    print(text, end="")
    return 0 if result["privacyStatus"] == result["runtimePathStatus"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
