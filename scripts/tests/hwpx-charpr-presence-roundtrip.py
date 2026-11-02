#!/usr/bin/env python3
"""Real-WASM regression for HWPX ``hh:charPr`` default-child presence.

Older Hancom HWPX omits default-valued ``hh:underline``/``hh:strikeout``/
``hh:outline``/``hh:shadow``; the serializer used to write all four for every
charPr. With ``patches/rhwp/hwpx-charpr-child-presence.patch`` an omitted child
stays omitted while its values are unchanged, an explicit child is kept, and an
edited value is always written. HWP5-origin shapes keep every child.
Only upstream public samples are read; results go to a new ignored directory.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[2]
HH = "{http://www.hancom.co.kr/hwpml/2011/head}"
HP = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
FOUR = ("underline", "strikeout", "outline", "shadow")
BLANK = ROOT / "external/rhwp/saved/blank_hwpx.hwpx"
EXPLICIT = ROOT / "external/rhwp/samples/issue7418/list_marker_head_synthetic.hwpx"


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


oracle = module("oracle", "scripts/tests/hwpx_xml_oracle.py")

CODE = r"""
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [pkg, source, out, mode] = process.argv.slice(2);
const m = await import(pathToFileURL(resolve(pkg, 'rhwp.js')));
m.initSync({module: readFileSync(resolve(pkg, 'rhwp_bg.wasm'))});
const ok = s => { const r = JSON.parse(s); if (r.ok !== true) throw new Error(s); return r; };
const text = d => Array.from({length: d.getSectionCount()}, (_, s) =>
  Array.from({length: d.getParagraphCount(s)}, (_, p) => d.getTextRange(s, p, 0, d.getParagraphLength(s, p))));
const result = {};
const emit = (d, name, hwp = false) => {
  let e;
  try {
    const expected = JSON.stringify({text: text(d), controls: d.getControls()});
    e = hwp ? d.exportHwpWithReport() : d.exportHwpxWithReport();
    const loss = JSON.parse(e.contentLoss());
    if (loss.count !== 0) throw new Error('content loss ' + JSON.stringify(loss));
    const b = e.takeBytes(); writeFileSync(resolve(out, name), b); writeFileSync(resolve(out, name + '.loss.json'), JSON.stringify(loss));
    const r = new m.HwpDocument(b);
    try { if (JSON.stringify({text: text(r), controls: r.getControls()}) !== expected) throw new Error('reopen differs'); } finally { r.free(); }
    result[name] = 'exported';
  } catch (err) { result[name] = 'refused: ' + String(err?.message ?? err); } finally { e?.free(); }
};
let d;
try {
  if (mode === 'blank-hwp5') {
    d = m.HwpDocument.createEmpty(); d.createBlankDocument();
    ok(d.insertText(0, 0, 0, '한글 HWP5'));
    emit(d, 'hwp5-blank.hwpx');
  } else {
    d = new m.HwpDocument(readFileSync(source));
    emit(d, mode + '-noedit.hwpx'); emit(d, mode + '-repeat.hwpx');
    if (mode === 'edit') {
      ok(d.insertText(0, 0, 0, '한글😀'));
      emit(d, 'edit-insert.hwpx');
      ok(d.applyCharFormat(0, 0, 0, 2, '{"underline":true}'));
      emit(d, 'edit-underline.hwpx'); emit(d, 'edit-underline-repeat.hwpx');
      ok(d.applyCharFormat(0, 0, 2, 4, '{"bold":true}'));
      emit(d, 'edit-bold.hwpx');
    }
  }
} catch (err) { result.error = String(err?.message ?? err); } finally { d?.free(); }
console.log(JSON.stringify(result));
"""


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def part(path, name):
    with zipfile.ZipFile(path) as archive:
        return archive.read(name)


def char_prs(path):
    root = oracle.parse(part(path, "Contents/header.xml"))
    return {c.get("id"): c for c in root.iter(HH + "charPr")}


def children(char_pr):
    return [c.tag.split("}")[1] for c in char_pr]


def node(package, source, out, mode):
    result = subprocess.run(["node", "--input-type=module", "-", str(package), str(source), str(out), mode],
                            input=CODE, text=True, capture_output=True, cwd=ROOT)
    (out / f"{mode}.node.log").write_text(result.stdout + result.stderr)
    assert result.returncode == 0, result.stderr[-2000:]
    return json.loads(result.stdout.splitlines()[-1])


def preflight(checker, source, output):
    result = subprocess.run([str(checker), "preflight", "hwpx", str(source), str(output), str(output) + ".loss.json"],
                            capture_output=True, text=True, check=True)
    verdict = json.loads(result.stdout)
    return verdict["outcome"], sorted(f"{f['code']}:{f.get('part')}" for f in verdict.get("findings", []))


def header_equal(source, output):
    return oracle.equal(part(source, "Contents/header.xml"), part(output, "Contents/header.xml"))


def rewrite(source, path, header=None, section=None):
    with zipfile.ZipFile(source) as a, zipfile.ZipFile(path, "w") as b:
        for info in a.infolist():
            data = a.read(info.filename)
            if info.filename == "Contents/header.xml" and header:
                data = header(data.decode("utf-8")).encode("utf-8")
            if info.filename == "Contents/section0.xml" and section:
                data = section(data.decode("utf-8")).encode("utf-8")
            b.writestr(info, data)


def positives(package, checker, out):
    report = {}
    # 1. Target: every charPr omits the four default children.
    assert all(not set(FOUR) & set(children(c)) for c in char_prs(BLANK).values())
    steps = node(package, BLANK, out, "edit")
    assert all(v == "exported" for v in steps.values()), steps
    noedit = out / "edit-noedit.hwpx"
    assert header_equal(BLANK, noedit), "unedited header changed"
    assert part(out / "edit-repeat.hwpx", "Contents/header.xml") == part(noedit, "Contents/header.xml")
    outcome = preflight(checker, BLANK, noedit)
    assert "partChanged:Contents/header.xml" not in outcome[1], outcome
    assert header_equal(BLANK, out / "edit-insert.hwpx"), "text insertion changed header"
    # Formatting appends charPr; every original charPr stays identical.
    original = char_prs(BLANK)
    for name in ("edit-underline.hwpx", "edit-bold.hwpx"):
        current = char_prs(out / name)
        for cid, cpr in original.items():
            assert oracle.canonical_events(cpr) == oracle.canonical_events(current[cid]), (name, cid)
        report[name] = {cid: children(c) for cid, c in current.items() if cid not in original}
        assert report[name], f"{name}: formatting appended no charPr"
    underlined = [c for cid, c in char_prs(out / "edit-underline.hwpx").items() if cid not in original]
    assert any(c.find(HH + "underline") is not None and c.find(HH + "underline").get("type") == "BOTTOM" for c in underlined)
    assert all(c.find(HH + t) is None for c in underlined for t in ("strikeout", "outline", "shadow"))
    assert part(out / "edit-underline-repeat.hwpx", "Contents/header.xml") == part(out / "edit-underline.hwpx", "Contents/header.xml")
    refs = {r.get("charPrIDRef") for r in oracle.parse(part(out / "edit-bold.hwpx", "Contents/section0.xml")).iter(HP + "run")}
    assert refs <= set(char_prs(out / "edit-bold.hwpx")), refs
    report["blank"] = {"preflightNoEdit": outcome, "steps": steps}

    # 2. Mixed presence and non-default values in one header.
    def mixed(header):
        ids = re.findall(r'<hh:charPr id="(\d+)"', header)
        assert len(ids) >= 3
        def add(cid, extra):
            return re.sub(rf'(<hh:charPr id="{cid}"[^>]*>.*?)(</hh:charPr>)', lambda m: m[1] + extra + m[2], header, count=1, flags=re.S)
        header = add(ids[0], '<hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:shadow type="NONE" color="#000000" offsetX="0" offsetY="0"/>')
        header = add(ids[1], '<hh:underline type="BOTTOM" shape="DOT" color="#FF0000"/><hh:outline type="SOLID"/>')
        return header
    fixture = out / "mixed.hwpx"
    rewrite(BLANK, fixture, header=mixed)
    steps = node(package, fixture, out, "mixed")
    assert steps["mixed-noedit.hwpx"] == "exported", steps
    assert header_equal(fixture, out / "mixed-noedit.hwpx"), "mixed presence not preserved"
    report["mixed"] = {cid: children(c) for cid, c in list(char_prs(fixture).items())[:3]}

    # 3. Explicit children (Hancom 13 output) unchanged and still safe.
    steps = node(package, EXPLICIT, out, "explicit")
    assert steps["explicit-noedit.hwpx"] == "exported", steps
    assert all(set(FOUR) <= set(children(c)) for c in char_prs(EXPLICIT).values())
    assert header_equal(EXPLICIT, out / "explicit-noedit.hwpx")
    report["explicit"] = {"preflight": preflight(checker, EXPLICIT, out / "explicit-noedit.hwpx")}
    assert report["explicit"]["preflight"][0] == "safe", report["explicit"]

    # 4. HWP5-origin shapes keep every child.
    steps = node(package, BLANK, out, "blank-hwp5")
    assert steps["hwp5-blank.hwpx"] == "exported", steps
    assert all(set(FOUR) <= set(children(c)) for c in char_prs(out / "hwp5-blank.hwpx").values())
    return report


def hwp5_unchanged(package, baseline, out):
    """HWP5 -> HWPX output identical between the baseline and this engine."""
    if baseline is None:
        return "NOT RUN (no --baseline package)"
    rows = []
    for sample in ("external/rhwp/samples/투명도0-50.hwp", "external/rhwp/samples/143E433F503322BD33.hwp",
                   "external/rhwp/samples/156636617_240617 2024년 5월 월간 수출입 현황(확정치).hwp"):
        source = ROOT / sample
        if not source.exists():
            continue
        outputs = []
        for label, pkg in (("baseline", baseline), ("candidate", package)):
            folder = out / f"hwp5-{label}"
            folder.mkdir(exist_ok=True)
            node(pkg, source, folder, "convert")
            outputs.append(folder / "convert-noedit.hwpx")
        assert all(p.exists() for p in outputs), sample
        same = part(outputs[0], "Contents/header.xml") == part(outputs[1], "Contents/header.xml")
        assert same, f"{sample}: HWP5-origin header changed"
        rows.append({"sample": sample, "headerIdentical": True})
    assert rows, "no HWP5 sample available"
    return rows


def negatives(package, checker, out):
    rows = []
    cases = {
        "unknown-child": dict(header=lambda h: h.replace("</hh:charPr>", "<hh:unknownChild/></hh:charPr>", 1)),
        "conflicting-duplicate-child": dict(header=lambda h: h.replace(
            "</hh:charPr>", '<hh:underline type="BOTTOM" shape="SOLID" color="#000000"/><hh:underline type="NONE" shape="SOLID" color="#000000"/></hh:charPr>', 1)),
        "invalid-enum": dict(header=lambda h: h.replace(
            "</hh:charPr>", '<hh:underline type="CENTER" shape="SOLID" color="#000000"/></hh:charPr>', 1)),
        "missing-charPr-reference": dict(section=lambda s: re.sub(r'charPrIDRef="\d+"', 'charPrIDRef="77"', s, count=1)),
        "malformed-header": dict(header=lambda h: h[: len(h) // 2]),
    }
    for name, change in cases.items():
        fixture = out / f"negative-{name}.hwpx"
        rewrite(BLANK, fixture, **change)
        before = sha(fixture)
        folder = out / f"negative-{name}"
        folder.mkdir()
        steps = node(package, fixture, folder, "neg")
        output = folder / "neg-noedit.hwpx"
        if steps.get("neg-noedit.hwpx") == "exported":
            verdict = preflight(checker, fixture, output)
            assert verdict[0] != "safe", (name, verdict)
        else:
            verdict = ("export refused", [steps.get("neg-noedit.hwpx") or steps.get("error")])
        assert sha(fixture) == before
        rows.append({"name": name, "result": verdict})
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, help="rhwp web package; default: published Release generation")
    parser.add_argument("--baseline", type=Path, help="previous engine package for the HWP5-origin A/B check")
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
    report["hwp5"] = hwp5_unchanged(args.package, args.baseline.resolve() if args.baseline else None, args.out)
    report["negative"] = negatives(args.package, args.checker.resolve(), args.out)
    report["status"] = "PASS"
    (args.out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"status": "PASS", "appended": {k: v for k, v in report["positive"].items() if k.startswith("edit-")},
                      "hwp5": report["hwp5"], "negative": report["negative"]}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
