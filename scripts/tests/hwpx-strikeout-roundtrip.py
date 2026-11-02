#!/usr/bin/env python3
"""Real-WASM regression for the HWPX ``hh:strikeout shape="3D"`` placeholder.

Hancom writes the *inactive* strikeout as ``shape="3D"`` (not drawn; rhwp's
whitelist keeps it inactive). The serializer used to rewrite it as
``shape="NONE"``. With ``patches/rhwp/hwpx-strikeout-3d-placeholder.patch`` the
source spelling is kept while strikeout stays inactive; enabling strikeout
writes the real shape and derived charPr use the standard ``NONE``. Each
negative asserts its own cause on a safe baseline. Only upstream public
samples are read; results go to a new ignored directory.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


charpr = module("charpr", "scripts/tests/hwpx-charpr-presence-roundtrip.py")
oracle, part, rewrite, sha = charpr.oracle, charpr.part, charpr.rewrite, charpr.sha
HH, EXPLICIT, HEADER_FINDING = charpr.HH, charpr.EXPLICIT, charpr.HEADER_FINDING

# Real documents whose charPr spell the inactive strikeout "3D" (one per observed color).
REAL_3D = ("external/rhwp/samples/issue5543_carried_anchor_ladder.hwpx",                     # #FF0000
           "external/rhwp/samples/issue6269/156739836_public_sector_jobs_stats.hwpx",       # none
           "external/rhwp/samples/issue5941/3240179_efficiency_test_orgs.hwpx")             # #0000FF

CODE = r"""
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [pkg, source, out] = process.argv.slice(2);
const m = await import(pathToFileURL(resolve(pkg, 'rhwp.js')));
m.initSync({module: readFileSync(resolve(pkg, 'rhwp_bg.wasm'))});
const ok = s => { const r = JSON.parse(s); if (r.ok !== true) throw new Error(s); return r; };
const text = d => Array.from({length: d.getSectionCount()}, (_, s) =>
  Array.from({length: d.getParagraphCount(s)}, (_, p) => d.getTextRange(s, p, 0, d.getParagraphLength(s, p))));
const result = {};
const emit = (d, name) => {
  let e;
  try {
    const expected = JSON.stringify({text: text(d), controls: d.getControls()});
    e = d.exportHwpxWithReport();
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
  d = new m.HwpDocument(readFileSync(source));
  emit(d, 'noedit.hwpx'); emit(d, 'repeat.hwpx');
  // Paragraph 0 runs reference charPr 0 (the 3D one); the caller checks it.
  ok(d.insertText(0, 0, 0, '한글'));
  emit(d, 'insert.hwpx');
  ok(d.applyCharFormat(0, 0, 0, 1, '{"strikethrough":true}'));
  emit(d, 'strike.hwpx');
  ok(d.applyCharFormat(0, 0, 1, 2, '{"italic":true}'));
  emit(d, 'italic.hwpx');
} catch (err) { result.error = String(err?.message ?? err); } finally { d?.free(); }
console.log(JSON.stringify(result));
"""


def strikeouts(path):
    root = oracle.parse(part(path, "Contents/header.xml"))
    return {c.get("id"): (None if c.find(HH + "strikeout") is None else dict(c.find(HH + "strikeout").attrib))
            for c in root.iter(HH + "charPr")}


def check_saved(checker, source, output):
    result = subprocess.run([str(checker), "saved", "hwpx", str(source), str(output), str(output) + ".loss.json", "true"],
                            capture_output=True, text=True, check=True)
    verdict = json.loads(result.stdout)
    return verdict["outcome"], sorted(f"{f['code']}:{f.get('part')}" for f in verdict.get("findings", []))


def strike_0(attributes):
    """Replace charPr id 0's strikeout attributes (the fixture spells all children)."""
    return charpr.char_pr_0(lambda body: re.sub(r"<hh:strikeout [^>]*/>", lambda _: f"<hh:strikeout {attributes}/>", body, count=1))


def real_documents(package, checker, out):
    rows = []
    for index, rel in enumerate(REAL_3D):
        source = ROOT / rel
        before = strikeouts(source)
        assert any(v and v.get("shape") == "3D" for v in before.values()), rel
        folder = out / f"real-{index}"
        steps, output, verdict = charpr.outcome(package, checker, source, folder)
        assert output is not None, (rel, steps)
        assert strikeouts(output) == before, (rel, "strikeout attributes changed")
        assert part(folder / "neg-repeat.hwpx", "Contents/header.xml") == part(output, "Contents/header.xml")
        rows.append({"sample": rel, "charPr3D": sum(1 for v in before.values() if v and v.get("shape") == "3D"),
                     "colors": sorted({v["color"] for v in before.values() if v and v.get("shape") == "3D"}),
                     "headerEqual": oracle.equal(part(source, "Contents/header.xml"), part(output, "Contents/header.xml")),
                     "preflight": verdict})
    return rows


def safe_baseline(package, checker, out):
    """3D on a safe fixture: the unedited export must stay safe (cause isolated)."""
    report = {}
    _, _, baseline = charpr.outcome(package, checker, EXPLICIT, out / "control")
    assert baseline == ("safe", []), baseline
    fixtures = {
        "3d-red": strike_0('shape="3D" color="#FF0000"'),
        "3d-none-color": strike_0('shape="3D" color="none"'),
        "active-dash-blue": strike_0('shape="DASH" color="#0000FF"'),
    }
    for name, change in fixtures.items():
        fixture = out / f"{name}.hwpx"
        rewrite(EXPLICIT, fixture, header=change)
        _, output, verdict = charpr.outcome(package, checker, fixture, out / name)
        assert verdict == ("safe", []), (name, verdict)
        assert strikeouts(output) == strikeouts(fixture), name
        report[name] = verdict
    # Edits on the 3D fixture.
    fixture = out / "3d-red.hwpx"
    folder = out / "edit"
    folder.mkdir()
    run = subprocess.run(["node", "--input-type=module", "-", str(package), str(fixture), str(folder)],
                         input=CODE, text=True, capture_output=True, cwd=ROOT)
    (folder / "node.log").write_text(run.stdout + run.stderr)
    assert run.returncode == 0, run.stderr[-2000:]
    steps = json.loads(run.stdout.splitlines()[-1])
    assert all(v == "exported" for v in steps.values()), steps
    source = strikeouts(fixture)
    HP = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
    first = oracle.parse(part(folder / "insert.hwpx", "Contents/section0.xml")).find(HP + "p")
    owners = [r.get("charPrIDRef") for r in first.findall(HP + "run") if "한글" in "".join(t.text or "" for t in r.iter(HP + "t"))]
    assert owners == ["0"], ("inserted text must use the 3D charPr 0", owners)
    assert strikeouts(folder / "insert.hwpx") == source, "text insertion changed strikeout"
    strike, italic = strikeouts(folder / "strike.hwpx"), strikeouts(folder / "italic.hwpx")
    for current in (strike, italic):
        assert all(current[c] == source[c] for c in source), "original charPr strikeout changed"
    added_strike = [v for c, v in strike.items() if c not in source]
    assert added_strike and all(v["shape"] not in ("3D", "NONE") for v in added_strike), added_strike
    added_italic = [v for c, v in italic.items() if c not in strike]
    assert added_italic and all(v["shape"] == "NONE" for v in added_italic), added_italic
    report["edits"] = {"appendedStrike": added_strike, "appendedItalic": added_italic,
                       "savedCheck": {name: check_saved(checker, fixture, folder / name)
                                      for name in ("insert.hwpx", "strike.hwpx", "italic.hwpx")}}
    for name, verdict in report["edits"]["savedCheck"].items():
        assert verdict == ("safe", []), (name, verdict)
    return report


def hwp5(package, baseline, out):
    rows = []
    for sample in ("external/rhwp/samples/투명도0-50.hwp", "external/rhwp/samples/143E433F503322BD33.hwp"):
        headers = []
        for label, pkg in (("baseline", baseline), ("candidate", package)):
            folder = out / f"hwp5-{label}-{len(rows)}"
            folder.mkdir()
            charpr.node(pkg, ROOT / sample, folder, "convert")
            headers.append(part(folder / "convert-noedit.hwpx", "Contents/header.xml"))
        assert headers[0] == headers[1], f"{sample}: HWP5-origin header changed"
        rows.append({"sample": sample, "headerIdentical": True})
    return rows


def negatives(package, checker, out):
    rows = []
    cases = {
        "unknown-shape": strike_0('shape="4D" color="#000000"'),
        "absent-shape-attribute": strike_0('color="#000000"'),
        "invalid-color": strike_0('shape="3D" color="red"'),
        "conflicting-duplicate": charpr.char_pr_0(lambda body: re.sub(
            r"<hh:strikeout [^>]*/>", lambda _: '<hh:strikeout shape="3D" color="#000000"/><hh:strikeout shape="SOLID" color="#000000"/>', body, count=1)),
    }
    for name, change in cases.items():
        fixture = out / f"negative-{name}.hwpx"
        rewrite(EXPLICIT, fixture, header=change)
        assert part(fixture, "Contents/header.xml") != part(EXPLICIT, "Contents/header.xml"), name
        before = sha(fixture)
        steps, output, verdict = charpr.outcome(package, checker, fixture, out / f"negative-{name}")
        assert verdict == ("unsafe", [HEADER_FINDING]), (name, steps, verdict)
        assert charpr.confined_to_char_pr(fixture, output, "0")
        assert sha(fixture) == before
        rows.append({"name": name, "result": verdict, "differenceConfinedToCharPr": "0"})
    fixture = out / "negative-malformed.hwpx"
    rewrite(EXPLICIT, fixture, header=strike_0('shape="3D" color="#000000"><broken'))
    before = sha(fixture)
    steps, output, _ = charpr.outcome(package, checker, fixture, out / "negative-malformed")
    assert output is None and steps.get("errorStage") == "open" and "XML" in steps.get("error", ""), steps
    assert sha(fixture) == before
    rows.append({"name": "malformed-strikeout", "stage": "open", "diagnostic": steps["error"]})
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, help="rhwp web package; default: published Release generation")
    parser.add_argument("--baseline", type=Path, required=True, help="previous engine package for the HWP5-origin A/B")
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
    args.package, checker = args.package.resolve(), args.checker.resolve()
    report = {"status": "RUNNING", "package": {n: sha(args.package / n) for n in ("rhwp.js", "rhwp_bg.wasm")}}
    report["real"] = real_documents(args.package, checker, args.out)
    report["safeBaseline"] = safe_baseline(args.package, checker, args.out)
    report["hwp5"] = hwp5(args.package, args.baseline.resolve(), args.out)
    report["negative"] = negatives(args.package, checker, args.out)
    report["status"] = "PASS"
    (args.out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"status": "PASS", "real": [(r["sample"].split("/")[-1], r["headerEqual"], r["preflight"]) for r in report["real"]],
                      "edits": report["safeBaseline"]["edits"]["savedCheck"], "negative": [(r["name"], r.get("result") or r.get("stage")) for r in report["negative"]]},
                     ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
