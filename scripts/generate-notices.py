#!/usr/bin/env python3
"""Generate the third-party notices for a geul Linux distribution (Stage 5-A S5-5).

    python3 scripts/generate-notices.py --out target/notices [--target x86_64-unknown-linux-gnu]

Collects, from the pinned sources only (offline, locked):
- Rust crates linked into the geul binary for the target: `cargo metadata --locked --offline --filter-platform`,
  walked from `geul` through normal dependencies (build/dev dependencies and proc-macros do not ship);
- Rust crates linked into the shipped RHWP WebAssembly (external/rhwp, wasm32-unknown-unknown, normal deps);
- npm packages bundled into the frontend (package-lock.json, non-dev, reachable from package.json dependencies);
- assets embedded by linked crates: WordCraft OFL fonts (wordcraft-fonts) and hyphenation patterns (wordcraft-proof);
- the engines' own LICENSE/NOTICE files.
Packages whose published sources contain no licence file use the verified, version-pinned resources in
docs/licenses/third-party/manifest.json (exact name + version + Cargo.lock checksum; every file's SHA-256 is checked;
provenance = the upstream commit recorded in the crate's .cargo_vcs_info.json). A package with neither a licence file
nor a matching, intact fallback is reported missing and the generator exits non-zero; nothing is downloaded here.
Writes THIRD_PARTY_NOTICES.md (licence texts) and inventory.json without absolute local paths. geul itself is MIT
(repository LICENSE).
"""
import argparse
import hashlib
import json
import os
import tomllib
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
LICENSE_NAMES = ("LICENSE", "LICENCE", "COPYING", "NOTICE", "UNLICENSE", "COPYRIGHT")
WORDCRAFT_ASSETS = [
    ("WordCraft bundled fonts (wordcraft-fonts)", "Source Sans 3", "external/wordcraft/assets/fonts/OFL-SourceSans3.txt"),
    ("WordCraft bundled fonts (wordcraft-fonts)", "Source Serif 4", "external/wordcraft/assets/fonts/OFL-SourceSerif4.txt"),
    ("WordCraft bundled fonts (wordcraft-fonts)", "Inter", "external/wordcraft/assets/fonts/OFL-Inter.txt"),
    ("WordCraft bundled fonts (wordcraft-fonts)", "JetBrains Mono", "external/wordcraft/assets/fonts/OFL-JetBrainsMono.txt"),
]
# The pattern files carry their own licence headers (WordCraft ATTRIBUTION.md); the header is the notice.
HYPHENATION = ["external/wordcraft/assets/hyphenation/pt.pat", "external/wordcraft/assets/hyphenation/pl.pat",
               "external/wordcraft/assets/hyphenation/it.pat"]


FALLBACKS = ROOT / "docs/licenses/third-party/manifest.json"
REGISTRY = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo")) / "registry" / "src"


def display(path, pinned_root=None):
    """A path for the generated output without local absolute prefixes."""
    path = Path(path).resolve()
    if pinned_root is not None and path.is_relative_to(Path(pinned_root).resolve()):
        return "pinned/" + str(path.relative_to(Path(pinned_root).resolve()))
    if path.is_relative_to(ROOT):
        return str(path.relative_to(ROOT))
    if path.is_relative_to(REGISTRY.resolve()):
        relative = path.relative_to(REGISTRY.resolve())
        return "crates.io/" + "/".join(relative.parts[1:])  # drop the index directory name
    raise ValueError(f"licence file outside the repository and the cargo registry: {path.name}")


def lock_checksums(lockfile):
    data = tomllib.loads(Path(lockfile).read_text())
    return {(p["name"], p["version"]): p.get("checksum") for p in data.get("package", [])}


def apply_fallbacks(sections, manifest_path):
    """Give packages without licence files their verified pinned texts. Returns (problems, used keys)."""
    manifest = json.loads(Path(manifest_path).read_text())
    entries = {(e["name"], e["version"]): e for e in manifest["packages"]}
    problems, used = [], set()
    for section, rows in sections.items():
        for r in rows:
            if r["files"] or r.get("source") == "path":
                continue
            key = (r["name"], r["version"])
            entry = entries.get(key)
            if entry is None:
                problems.append(f"{section}: {r['name']} {r['version']}: no licence file and no pinned fallback")
                continue
            if not r.get("checksum") or entry.get("checksum") != r["checksum"]:
                problems.append(f"{section}: {r['name']} {r['version']}: fallback checksum does not match Cargo.lock")
                continue
            directory = Path(manifest_path).parent / entry["directory"]
            files, bad = [], False
            for f in entry["files"]:
                path = directory / f["file"]
                if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != f["sha256"]:
                    problems.append(f"{section}: {r['name']} {r['version']}: pinned {f['file']} is missing or altered")
                    bad = True
                files.append(path)
            if bad:
                continue
            r["files"] = files
            r["licenseSource"] = {"pinned": True, "repository": entry["vcs"]["repository"], "commit": entry["vcs"]["commit"],
                                  "files": [{"file": f["file"], "source": f["source"], "sha256": f["sha256"]} for f in entry["files"]]}
            if entry.get("mplDerived"):
                r["mplDerived"] = entry["mplDerived"]
            used.add(key)
    return problems, used


def license_files(directory):
    found = []
    for path in sorted(Path(directory).iterdir()):
        if path.is_file() and path.name.upper().startswith(LICENSE_NAMES):
            found.append(path)
    return found


def cargo_packages(manifest, target, root_name, lockfile):
    meta = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--format-version", "1", "--locked", "--offline", "--filter-platform", target,
         "--manifest-path", str(manifest)], cwd=ROOT))
    packages = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    root = next(p["id"] for p in meta["packages"] if p["name"] == root_name and p["source"] is None)
    seen, stack = set(), [root]
    while stack:
        current = stack.pop()
        if current in seen:
            continue
        seen.add(current)
        for dep in nodes[current]["deps"]:
            if not any(kind["kind"] is None for kind in dep["dep_kinds"]):
                continue  # build/dev only: not linked into the shipped artefact
            package = packages[dep["pkg"]]
            if any("proc-macro" in t["kind"] for t in package["targets"]):
                continue
            stack.append(dep["pkg"])
    seen.discard(root)
    checksums = lock_checksums(lockfile)
    rows = []
    for pid in sorted(seen, key=lambda i: (packages[i]["name"], packages[i]["version"])):
        p = packages[pid]
        directory = Path(p["manifest_path"]).parent
        rows.append({"name": p["name"], "version": p["version"], "license": p.get("license") or p.get("license_file"),
                     "source": "path" if p["source"] is None else p["source"].split("+")[0],
                     "repository": p.get("repository"), "checksum": checksums.get((p["name"], p["version"])),
                     "files": license_files(directory)})
    return rows


def npm_packages():
    lock = json.loads((ROOT / "package-lock.json").read_text())
    entries = lock["packages"]
    queue = list(json.loads((ROOT / "package.json").read_text()).get("dependencies", {}))
    seen, rows = set(), []
    while queue:
        name = queue.pop()
        key = f"node_modules/{name}"
        if key in seen or key not in entries:
            continue
        seen.add(key)
        entry = entries[key]
        queue.extend(entry.get("dependencies", {}))
        directory = ROOT / key
        rows.append({"name": name, "version": entry.get("version"), "license": entry.get("license"),
                     "files": license_files(directory) if directory.is_dir() else []})
    return sorted(rows, key=lambda r: r["name"])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--target", default="x86_64-unknown-linux-gnu")
    parser.add_argument("--fallbacks", type=Path, default=FALLBACKS, help="pinned fallback manifest (testing only)")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    sections = {
        "geul (Rust, linked)": cargo_packages(ROOT / "src-tauri/Cargo.toml", args.target, "geul", ROOT / "src-tauri/Cargo.lock"),
        "RHWP WebAssembly (Rust, linked)": cargo_packages(ROOT / "external/rhwp/Cargo.toml", "wasm32-unknown-unknown", "rhwp",
                                                          ROOT / "external/rhwp/Cargo.lock"),
        "Frontend (npm, bundled)": npm_packages(),
    }
    problems, used = apply_fallbacks(sections, args.fallbacks)
    engines = [("WordCraft", ["external/wordcraft/LICENSE-MIT", "external/wordcraft/LICENSE-APACHE", "external/wordcraft/NOTICE"]),
               ("RHWP", ["external/rhwp/LICENSE"])]
    # Path crates of the pinned engines are covered by the engine licence files above.
    missing = problems + [f"{section}: {r['name']} {r['version']}" for section, rows in sections.items() for r in rows
                          if not r["files"] and r.get("source") != "path" and not any(p.startswith(f"{section}: {r['name']} {r['version']}:") for p in problems)]
    lines = ["# Third-party notices — geul (generated)", "",
             "geul itself is licensed under the MIT License (repository `LICENSE`). This file lists third-party material only;",
             "each component keeps its own licence, which geul's MIT licence does not change.",
             "Generated by scripts/generate-notices.py from the pinned sources; regenerate for every release build.", ""]
    for name, files in engines:
        lines += [f"## {name}", ""]
        for f in files:
            lines += [f"### {f}", "", "```", (ROOT / f).read_text(errors="replace").rstrip(), "```", ""]
    lines += ["## Embedded assets", ""]
    for owner, family, f in WORDCRAFT_ASSETS:
        lines += [f"### {family} — {owner} (SIL OFL 1.1)", "", "```", (ROOT / f).read_text(errors="replace").rstrip(), "```", ""]
    for f in HYPHENATION:
        header = [line for line in (ROOT / f).read_text(errors="replace").splitlines()[:60] if line.startswith("%")]
        lines += [f"### Hyphenation patterns {Path(f).name} (wordcraft-proof)", "", "```", "\n".join(header) or "(see file header)", "```", ""]
    texts = {}
    for section, rows in sections.items():
        lines += [f"## {section}", "", "| Package | Version | Declared licence |", "|---|---|---|"]
        lines += [f"| {r['name']} | {r['version']} | {r['license']} |" for r in rows]
        lines.append("")
        for r in rows:
            for f in r["files"]:
                body = Path(f).read_text(errors="replace").rstrip()
                texts.setdefault(body, []).append(f"{r['name']} {r['version']}")
    pinned = [r for rows in sections.values() for r in rows if r.get("licenseSource")]
    if pinned:
        lines += ["## Licence texts from pinned upstream sources", "",
                  "These published packages contain no licence file; their texts below were taken from the upstream commit the",
                  "package was published from (recorded in its .cargo_vcs_info.json) and are integrity-checked by SHA-256:", ""]
        lines += [f"- {r['name']} {r['version']} ({r['license']}): {r['licenseSource']['repository']} @ {r['licenseSource']['commit']} — "
                  + ", ".join(f"{f['file']} <{f['source']}>" for f in r["licenseSource"]["files"]) for r in pinned]
        lines.append("")
    mpl = [r for rows in sections.values() for r in rows if "MPL" in (r["license"] or "")]
    derived = [r for rows in sections.values() for r in rows if r.get("mplDerived")]
    if mpl or derived:
        lines += ["## MPL-2.0 Source Code Form availability (MPL-2.0 section 3.2)", "",
                  "The following MPL-2.0 components are distributed in Executable Form inside geul, unmodified. Their Source Code Form",
                  "is available from crates.io (exact version below) and the listed repository:", ""]
        lines += [f"- {r['name']} {r['version']}: https://crates.io/crates/{r['name']}/{r['version']}"
                  f" ({r.get('repository') or 'repository not declared'})" for r in mpl]
        lines += [f"- {r['name']} {r['version']} (declared {r['license']}) contains MPL-derived code according to its upstream NOTICE: "
                  f"{r['mplDerived']} Source: https://crates.io/crates/{r['name']}/{r['version']}" for r in derived]
        lines.append("")
    if missing:
        lines += ["## UNRESOLVED licence texts", ""] + [f"- {m}" for m in missing] + [""]
    lines += ["## Licence texts", ""]
    for body, owners in texts.items():
        lines += [f"### {', '.join(owners[:12])}{' …' if len(owners) > 12 else ''}", "", "```", body, "```", ""]
    (args.out / "THIRD_PARTY_NOTICES.md").write_text("\n".join(lines) + "\n")
    for rows in sections.values():
        for r in rows:
            r["files"] = [display(f, args.fallbacks.parent) for f in r["files"]]
    manifest_keys = {(e["name"], e["version"]) for e in json.loads(Path(args.fallbacks).read_text())["packages"]}
    inventory = {"target": args.target, "sections": sections, "missingLicenseText": missing,
                 "counts": {k: len(v) for k, v in sections.items()}, "distinctLicenseTexts": len(texts),
                 "ownLicense": "MIT", "mpl": [f"{r['name']} {r['version']}" for r in mpl],
                 "mplDerived": [f"{r['name']} {r['version']}" for r in derived],
                 "pinnedFallbacks": sorted(f"{n} {v}" for n, v in used),
                 "unusedFallbacks": sorted(f"{n} {v}" for n, v in manifest_keys - used)}
    (args.out / "inventory.json").write_text(json.dumps(inventory, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"counts": inventory["counts"], "missingLicenseText": missing, "pinnedFallbacks": inventory["pinnedFallbacks"],
                      "distinctLicenseTexts": len(texts)}, ensure_ascii=False))
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
