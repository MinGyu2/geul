#!/usr/bin/env python3
"""Real-WASM regression for OPF spine ``linear`` preservation in content.hpf.

The HWPX serializer used to write ``linear="yes"`` on every spine itemref.
Older Hancom packages omit the attribute and some packages mark items
``linear="no"`` (non-linear); both were rewritten. With
``patches/rhwp/hwpx-spine-linear.patch`` each itemref keeps the original
presence and value; unknown or conflicting values refuse export. Results go to
a new ignored directory; only upstream public samples are read.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


probe = module("probe", "scripts/tests/hwpx-textdir-roundtrip.py")
oracle = module("oracle", "scripts/tests/hwpx_xml_oracle.py")

# sample -> (content.hpf must be canonically equal, generic probe edit applies).
# The probe inserts a marker at section 0 paragraph 0 and requires the control
# snapshot to stay unchanged; it does not apply to every document (same result
# on the engine without this patch), so those samples get unedited and repeat
# export checks only.
SAMPLES = {
    "external/rhwp/saved/blank_hwpx.hwpx": (True, True),                        # all absent
    "external/rhwp/samples/hwpx/2026_oss_rst.hwpx": (False, False),             # all absent, 3 sections
    "external/rhwp/samples/hwpx/21761835_jeonjik_exemption_table.hwpx": (False, True),  # no + yes
    "external/rhwp/samples/hwpx/156160455-social-pig-farm-income.hwpx": (False, False),  # absent + yes
    "external/rhwp/samples/task3307/issue3307_outline_number.hwpx": (False, False),      # absent/no/yes + scripts
    "external/rhwp/samples/issue7418/list_marker_head_synthetic.hwpx": (True, True),     # all yes
}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def content_hpf(path):
    with zipfile.ZipFile(path) as archive:
        return archive.read("Contents/content.hpf")


def spine(path):
    root = oracle.parse(content_hpf(path))
    return [(e.get("idref"), e.get("linear")) for e in root.iter()
            if isinstance(e.tag, str) and e.tag.endswith("}itemref")]


def preflight(checker, source, output):
    result = subprocess.run([str(checker), "preflight", "hwpx", str(source), str(output), str(output) + ".loss.json"],
                            capture_output=True, text=True, check=True)
    verdict = json.loads(result.stdout)
    return verdict["outcome"], sorted(f"{f['code']}:{f.get('part')}" for f in verdict.get("findings", []))


def positives(package, checker, out):
    rows = []
    for index, (rel, (equal_expected, editable)) in enumerate(SAMPLES.items()):
        source = ROOT / rel
        row = {"sample": rel, "sha256": sha(source), "spine": spine(source)}
        for edit in (False, True) if editable else (False,):
            tag = "edit" if edit else "noedit"
            output = out / f"{index}-{tag}.hwpx"
            result = probe.export(package, source, output, edit=edit)
            assert result["returncode"] == 0, (rel, result["diagnostic"])
            assert spine(output) == row["spine"], (rel, tag, spine(output), row["spine"])
            row[tag] = {"contentHpfEqual": oracle.equal(content_hpf(source), content_hpf(output))}
            if not edit:
                repeat = out / f"{index}-repeat.hwpx"
                assert probe.export(package, source, repeat)["returncode"] == 0
                assert content_hpf(repeat) == content_hpf(output), (rel, "repeat export not stable")
                row[tag]["preflight"] = preflight(checker, source, output)
        if equal_expected:
            assert row["noedit"]["contentHpfEqual"] and row["edit"]["contentHpfEqual"], row
            assert "partChanged:Contents/content.hpf" not in row["noedit"]["preflight"][1], row
        rows.append(row)
    return rows


def negatives(package, out):
    source = ROOT / "external/rhwp/saved/blank_hwpx.hwpx"
    original = content_hpf(source).decode("utf-8")
    needle = '<opf:itemref idref="section0"/>'
    assert original.count(needle) == 1, "fixture spine form changed"
    cases = {
        "unknown-value": (original.replace(needle, '<opf:itemref idref="section0" linear="maybe"/>'),
                          "unsupported OPF spine linear value"),
        "conflicting-duplicate": (original.replace(needle, needle + '<opf:itemref idref="section0" linear="no"/>'),
                                  "conflicting OPF spine linear values"),
    }
    rows = []
    for name, (text, expected) in cases.items():
        path = out / f"negative-{name}.hwpx"
        with zipfile.ZipFile(source) as a, zipfile.ZipFile(path, "w") as b:
            for info in a.infolist():
                data = text.encode("utf-8") if info.filename == "Contents/content.hpf" else a.read(info.filename)
                b.writestr(info, data)
        before = sha(path)
        result = probe.export(package, path, out / f"negative-{name}-out.hwpx")
        diagnostic = result["diagnostic"] or {}
        assert result["returncode"] != 0 and diagnostic.get("stage") == "export" and diagnostic.get("opened"), result
        assert expected in diagnostic["error"], diagnostic
        assert sha(path) == before and not (out / f"negative-{name}-out.hwpx").exists()
        rows.append({"name": name, "readable": True, "exportRefused": diagnostic["error"]})
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, help="rhwp web package; default: published Release generation")
    parser.add_argument("--checker", type=Path, default=ROOT / "src-tauri/target/debug/examples/save_check")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=False)
    if args.package is None:
        identity = json.loads((ROOT / "public/rhwp/RELEASE.json").read_text())
        args.package = ROOT / "public/rhwp/generations" / identity["generation"]
        for name, digest in identity["artifacts"].items():
            assert sha(args.package / name) == digest, name
    args.package = args.package.resolve()
    report = {"status": "RUNNING", "package": {n: sha(args.package / n) for n in ("rhwp.js", "rhwp_bg.wasm")}}
    report["positive"] = positives(args.package, args.checker.resolve(), args.out)
    report["negative"] = negatives(args.package, args.out)
    report["status"] = "PASS"
    (args.out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"status": "PASS", "samples": [(r["sample"].split("/")[-1], r["noedit"]["contentHpfEqual"], "edit" in r,
                                                    r["noedit"]["preflight"]) for r in report["positive"]]},
                     ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
