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
Writes THIRD_PARTY_NOTICES.md (license texts) and inventory.json, and exits non-zero when a shipped package has no
license text in its sources (the notice would be incomplete). geul's own license is not decided (README) and is
reported, not invented.
"""
import argparse
import json
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


def license_files(directory):
    found = []
    for path in sorted(Path(directory).iterdir()):
        if path.is_file() and path.name.upper().startswith(LICENSE_NAMES):
            found.append(path)
    return found


def cargo_packages(manifest, target, root_name):
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
    rows = []
    for pid in sorted(seen, key=lambda i: (packages[i]["name"], packages[i]["version"])):
        p = packages[pid]
        directory = Path(p["manifest_path"]).parent
        rows.append({"name": p["name"], "version": p["version"], "license": p.get("license") or p.get("license_file"),
                     "source": "path" if p["source"] is None else p["source"].split("+")[0],
                     "repository": p.get("repository"), "authors": p.get("authors") or [],
                     "files": [str(f) for f in license_files(directory)]})
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
                     "files": [str(f) for f in license_files(directory)] if directory.is_dir() else []})
    return sorted(rows, key=lambda r: r["name"])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--target", default="x86_64-unknown-linux-gnu")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    sections = {
        "geul (Rust, linked)": cargo_packages(ROOT / "src-tauri/Cargo.toml", args.target, "geul"),
        "RHWP WebAssembly (Rust, linked)": cargo_packages(ROOT / "external/rhwp/Cargo.toml", "wasm32-unknown-unknown", "rhwp"),
        "Frontend (npm, bundled)": npm_packages(),
    }
    engines = [("WordCraft", ["external/wordcraft/LICENSE-MIT", "external/wordcraft/LICENSE-APACHE", "external/wordcraft/NOTICE"]),
               ("RHWP", ["external/rhwp/LICENSE"])]
    missing = [f"{section}: {r['name']} {r['version']}" for section, rows in sections.items() for r in rows
               if not r["files"] and r.get("source") != "path"]
    # Path crates of the pinned engines are covered by the engine licence files above.
    lines = ["# Third-party notices — geul (generated)", "",
             "geul itself: licence NOT YET DECIDED by the project owner (README). This file covers third-party material only.",
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
    mpl = [r for rows in sections.values() for r in rows if "MPL" in (r["license"] or "")]
    if mpl:
        lines += ["## MPL-2.0 Source Code Form availability (MPL-2.0 section 3.2)", "",
                  "The following MPL-2.0 components are distributed in Executable Form inside geul. Their Source Code Form is",
                  "available, unmodified, from the listed repositories and from crates.io (`cargo download`/registry index):", ""]
        lines += [f"- {r['name']} {r['version']}: {r.get('repository') or 'https://crates.io/crates/' + r['name']}"
                  f" (https://crates.io/crates/{r['name']}/{r['version']})" for r in mpl]
        lines.append("")
    absent = [r for rows in sections.values() for r in rows if not r["files"] and r.get("source") != "path"]
    if absent:
        lines += ["## Packages whose published sources contain no licence file (UNRESOLVED)", "",
                  "Declared licence and authors from the package manifest; the full notice must be confirmed from upstream.", ""]
        lines += [f"- {r['name']} {r['version']}: {r['license']}; authors: {', '.join(r.get('authors') or []) or 'not declared'};"
                  f" repository: {r.get('repository') or 'not declared'}" for r in absent]
        lines.append("")
    lines += ["## Licence texts", ""]
    for body, owners in texts.items():
        lines += [f"### {', '.join(owners[:12])}{' …' if len(owners) > 12 else ''}", "", "```", body, "```", ""]
    (args.out / "THIRD_PARTY_NOTICES.md").write_text("\n".join(lines) + "\n")
    inventory = {"target": args.target, "sections": sections, "missingLicenseText": missing,
                 "counts": {k: len(v) for k, v in sections.items()}, "distinctLicenseTexts": len(texts),
                 "ownLicense": "undecided", "mpl": [f"{r['name']} {r['version']}" for r in mpl]}
    (args.out / "inventory.json").write_text(json.dumps(inventory, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"counts": inventory["counts"], "missingLicenseText": missing, "distinctLicenseTexts": len(texts)}, ensure_ascii=False))
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
