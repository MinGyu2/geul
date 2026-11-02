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
    ns = '{http://www.idpf.org/2007/opf/}'
    return [(e.get("idref"), e.get("linear")) for e in root.find(ns+'spine')
            if e.tag == ns+'itemref']


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


def mutated_package(source, path, content):
    with zipfile.ZipFile(source) as a, zipfile.ZipFile(path, "w") as b:
        for info in a.infolist():
            b.writestr(info, content if info.filename == "Contents/content.hpf" else a.read(info.filename))


def generated_document(package, out):
    source = ROOT / 'external/rhwp/saved/blank2010.hwp'
    output = out / 'generated-from-hwp5.hwpx'
    result = probe.export(package, source, output)
    assert result['returncode'] == 0, result['diagnostic']
    assert spine(output) == [('header', 'yes'), ('section0', 'yes')]
    repeat = out / 'generated-from-hwp5-repeat.hwpx'
    assert probe.export(package, output, repeat)['returncode'] == 0
    assert content_hpf(repeat) == content_hpf(output)
    return {'source': str(source.relative_to(ROOT)), 'spineDefaults': spine(output), 'repeatStable': True}


def normalized_forms(package, checker, out):
    source = ROOT / 'external/rhwp/samples/issue7418/list_marker_head_synthetic.hwpx'
    original = content_hpf(source).decode('utf-8')
    needle = '<opf:itemref idref="section0" linear="yes"/>'
    assert original.count(needle) == 1
    rows = []
    for name, value, expected in [('decimal-yes', 'y&#101;s', 'yes'), ('hex-yes', '&#x79;es', 'yes'),
                                  ('decimal-no', 'n&#111;', 'no'), ('hex-no', 'n&#x6f;', 'no')]:
        path, output = out / f'{name}.hwpx', out / f'{name}-out.hwpx'
        content = original.replace(needle, f'<opf:itemref idref="section&#48;" linear="{value}"/>')
        mutated_package(source, path, content.encode())
        result = probe.export(package, path, output)
        assert result['returncode'] == 0, (name, result['diagnostic'])
        assert spine(output)[1] == ('section0', expected)
        assert oracle.equal(content_hpf(path), content_hpf(output))
        verdict = preflight(checker, path, output)
        assert verdict == ('safe', []), (name, verdict)
        repeat = out / f'{name}-reopen-export.hwpx'
        assert probe.export(package, output, repeat)['returncode'] == 0
        assert content_hpf(repeat) == content_hpf(output)
        rows.append({'name': name, 'spine': spine(output), 'preflight': verdict, 'reexportStable': True})
    for name, content in [
        ('namespace-alias', original.replace('opf:', 'alias:').replace('xmlns:opf', 'xmlns:alias')),
        ('foreign-outside-spine', original.replace('<opf:metadata>', '<opf:metadata><x:itemref xmlns:x="urn:x" idref="header" linear="maybe"/>')),
    ]:
        path, output = out / f'{name}.hwpx', out / f'{name}-out.hwpx'
        mutated_package(source, path, content.encode())
        result = probe.export(package, path, output)
        assert result['returncode'] == 0, (name, result['diagnostic'])
        assert spine(output) == spine(source)
        rows.append({'name': name, 'spinePreserved': True})
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
    item = '<opf:itemref idref="section0" linear="no"/>'
    invalid_items = {
        'identical-duplicate': needle + needle,
        'missing-idref': '<opf:itemref linear="no"/>',
        'empty-idref': '<opf:itemref idref=""/>',
        'invalid-idref': '<opf:itemref idref="a b"/>',
        'predefined-entity-not-linear': item.replace('"no"', '"n&amp;o"'),
        'unknown-reference': item.replace('"no"', '"n&bad;"'),
        'malformed-reference': item.replace('"no"', '"n&#xZZ;"'),
        'unquoted': item.replace('"no"', 'no'),
        'duplicate-attribute': item.replace('linear="no"', 'linear="no" linear="no"'),
        'malformed-attribute': item.replace('linear="no"', 'linear="no" broken'),
        'unbound-attribute': item.replace('linear=', 'x:linear='),
        'unsupported-attribute': item.replace('linear=', 'other="x" linear='),
        'foreign-in-spine': '<x:itemref xmlns:x="urn:x" idref="section0" linear="no"/>',
        'wrong-parent': '<opf:other>' + item + '</opf:other>',
    }
    cases.update({name: (original.replace(needle, item), None) for name, item in invalid_items.items()})
    cases.update({
        'wrong-root': (original.replace('opf:package', 'opf:other'), None),
        'wrong-namespace': (original.replace('http://www.idpf.org/2007/opf/', 'urn:foreign'), None),
        'truncated': (original.replace('</opf:package>', ''), None),
        'duplicate-spine': (original.replace('</opf:package>', '<opf:spine/></opf:package>'), None),
        'malformed-declaration': (original.replace('version="1.0"', 'version="bad"', 1), None),
        'invalid-encoding': (original.replace('UTF-8', 'latin1', 1), None),
        'invalid-utf8': (original.encode() + b'\xff', None),
    })
    rows = []
    for name, (text, expected) in cases.items():
        path = out / f"negative-{name}.hwpx"
        mutated_package(source, path, text.encode("utf-8") if isinstance(text, str) else text)
        before = sha(path)
        result = probe.export(package, path, out / f"negative-{name}-out.hwpx")
        diagnostic = result["diagnostic"] or {}
        assert result["returncode"] != 0 and diagnostic.get("stage") in ('open', 'export'), result
        if expected:
            assert expected in diagnostic["error"], diagnostic
        assert sha(path) == before and not (out / f"negative-{name}-out.hwpx").exists()
        rows.append({"name": name, "readable": diagnostic.get('opened'), "stage": diagnostic['stage'],
                     "exportRefused": diagnostic["error"], 'sourceSha256': before, 'sourceUnchanged': True})
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
    report["normalized"] = normalized_forms(args.package, args.checker.resolve(), args.out)
    report["generated"] = generated_document(args.package, args.out)
    report["negative"] = negatives(args.package, args.out)
    report["status"] = "PASS"
    (args.out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"status": "PASS", "samples": [(r["sample"].split("/")[-1], r["noedit"]["contentHpfEqual"], "edit" in r,
                                                    r["noedit"]["preflight"]) for r in report["positive"]]},
                     ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
