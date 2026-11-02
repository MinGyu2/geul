#!/usr/bin/env python3
"""Derived charPr must not inherit the HWPX inactive-strikeout "3D" spelling.

``patches/rhwp/hwpx-strikeout-3d-placeholder.patch`` keeps a source charPr's
``<hh:strikeout shape="3D"/>`` and clears the provenance in
``CharShapeMods::apply_to``. HTML paste (``css_to_char_shape_id``) and the CLI
table-cell recolor (``recolor_cell_text_black``) clone a charPr directly; with
``patches/rhwp/hwpx-strike3d-derived-styles.patch`` a newly allocated definition
writes the standard ``"NONE"`` while the source charPr and reused equal charPr
keep their own spelling. Exercises the real WASM ``pasteHtml`` and the real
``rhwp edit set-cell`` command. Only upstream public samples are read; results go
to a new ignored directory.
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


strike = module("strike", "scripts/tests/hwpx-strikeout-roundtrip.py")
charpr, oracle, part, rewrite, sha = strike.charpr, strike.oracle, strike.part, strike.rewrite, strike.sha
HH = charpr.HH
HP = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
TABLE_SAMPLE = ROOT / "external/rhwp/samples/issue7418/condense_cell_synthetic.hwpx"

PASTE = r"""
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [pkg, source, out] = process.argv.slice(2);
const m = await import(pathToFileURL(resolve(pkg, 'rhwp.js')));
m.initSync({module: readFileSync(resolve(pkg, 'rhwp_bg.wasm'))});
const text = d => Array.from({length: d.getSectionCount()}, (_, s) =>
  Array.from({length: d.getParagraphCount(s)}, (_, p) => d.getTextRange(s, p, 0, d.getParagraphLength(s, p))));
const exportTo = (d, name) => {
  const e = d.exportHwpxWithReport();
  try {
    const loss = JSON.parse(e.contentLoss());
    if (loss.count !== 0) throw new Error('content loss ' + JSON.stringify(loss));
    const b = e.takeBytes(); writeFileSync(resolve(out, name), b); writeFileSync(resolve(out, name + '.loss.json'), JSON.stringify(loss));
    return b;
  } finally { e.free(); }
};
const d = new m.HwpDocument(readFileSync(source));
const result = {};
try {
  result.paste = JSON.parse(d.pasteHtml(0, 0, 0,
    '<span style="font-weight:bold">굵게</span><span style="text-decoration:line-through">취소</span>'));
  const expected = JSON.stringify(text(d));
  const bytes = exportTo(d, 'pasted.hwpx'); exportTo(d, 'pasted-repeat.hwpx');
  const r = new m.HwpDocument(bytes);
  try {
    if (JSON.stringify(text(r)) !== expected) throw new Error('reopen differs');
    exportTo(r, 'reopened-export.hwpx');
  } finally { r.free(); }
  result.text = text(d)[0][0];
} finally { d.free(); }
console.log(JSON.stringify(result));
"""


def char_prs(path):
    root = oracle.parse(part(path, "Contents/header.xml"))
    return {c.get("id"): c for c in root.iter(HH + "charPr")}


def strikeout(char_pr):
    child = char_pr.find(HH + "strikeout")
    return None if child is None else dict(child.attrib)


def html_paste(package, checker, out):
    fixture = out / "html-3d-red.hwpx"
    rewrite(charpr.EXPLICIT, fixture, header=strike.strike_0('shape="3D" color="#FF0000"'))
    run = subprocess.run(["node", "--input-type=module", "-", str(package), str(fixture), str(out)],
                         input=PASTE, text=True, capture_output=True, cwd=ROOT)
    (out / "paste.node.log").write_text(run.stdout + run.stderr)
    assert run.returncode == 0, run.stderr[-2000:]
    node = json.loads(run.stdout.splitlines()[-1])
    assert node["paste"]["ok"] is True and node["text"].startswith("굵게취소"), node
    source, pasted = char_prs(fixture), char_prs(out / "pasted.hwpx")
    for cid, cpr in source.items():
        assert oracle.canonical_events(cpr) == oracle.canonical_events(pasted[cid]), ("source charPr changed", cid)
    assert strikeout(pasted["0"]) == {"shape": "3D", "color": "#FF0000"}
    new = {cid: c for cid, c in pasted.items() if cid not in source}
    bold = [c for c in new.values() if c.find(HH + "bold") is not None]
    active = [c for c in new.values() if strikeout(c) and strikeout(c)["shape"] not in ("NONE", "3D")]
    assert len(bold) == 1 and strikeout(bold[0]) == {"shape": "NONE", "color": "#FF0000"}, [strikeout(c) for c in bold]
    assert len(active) == 1 and strikeout(active[0]) == {"shape": "SOLID", "color": "#FF0000"}
    assert all(strikeout(c)["shape"] != "3D" for c in new.values()), "derived charPr kept 3D"
    assert part(out / "pasted-repeat.hwpx", "Contents/header.xml") == part(out / "pasted.hwpx", "Contents/header.xml")
    reopened = char_prs(out / "reopened-export.hwpx")
    assert {k: strikeout(v) for k, v in reopened.items()} == {k: strikeout(v) for k, v in pasted.items()}
    saved = strike.check_saved(checker, fixture, out / "pasted.hwpx")
    assert "partChanged:Contents/header.xml" not in saved[1], saved
    return {"newCharPr": {cid: {"bold": c.find(HH + "bold") is not None, "strikeout": strikeout(c)} for cid, c in new.items()},
            "sourceCharPr0": strikeout(pasted["0"]), "checkSaved": saved}


def table_cells(path):
    """First cell of every table in section 0 (the fixture's tables are 1x1)."""
    section = oracle.parse(part(path, "Contents/section0.xml"))
    return [next(table.iter(HP + "tc")) for table in section.iter(HP + "tbl")]


def run_cli(cli, source, output, table):
    command = [str(cli), "edit", "set-cell", str(source), "--table", str(table), "--row", "0", "--col", "0",
               "--text", "한글", "-o", str(output)]
    result = subprocess.run(command, capture_output=True, text=True, cwd=ROOT)
    assert result.returncode == 0 and output.exists(), (command, result.stdout[-500:], result.stderr[-500:])
    return command


def table_cell(cli, out):
    fixture = out / "cell-3d-blue.hwpx"

    def mutate(header):
        match = re.search(r'<hh:charPr id="7"[^>]*>.*?</hh:charPr>', header, flags=re.S)
        changed = match[0].replace('textColor="#000000"', 'textColor="#0000FF"', 1)
        changed = re.sub(r"<hh:strikeout [^>]*/>", '<hh:strikeout shape="3D" color="#000000"/>', changed, count=1)
        assert changed != match[0]
        return header[:match.start()] + changed + header[match.end():]
    rewrite(TABLE_SAMPLE, fixture, header=mutate)
    cells = table_cells(fixture)
    assert len(cells) >= 2 and all({r.get("charPrIDRef") for r in c.iter(HP + "run")} == {"7"} for c in cells[:2])
    first = out / "cell-edit-1.hwpx"
    commands = [run_cli(cli, fixture, first, 0)]
    source, edited = char_prs(fixture), char_prs(first)
    for cid, cpr in source.items():
        assert oracle.canonical_events(cpr) == oracle.canonical_events(edited[cid]), ("source charPr changed", cid)
    assert strikeout(edited["7"]) == {"shape": "3D", "color": "#000000"}
    after = table_cells(first)
    refs = [r.get("charPrIDRef") for r in after[0].iter(HP + "run")]
    assert len(set(refs)) == 1 and refs[0] not in source, refs
    black = edited[refs[0]]
    assert black.get("textColor") == "#000000" and strikeout(black) == {"shape": "NONE", "color": "#000000"}, strikeout(black)
    assert "".join(t.text or "" for t in after[0].iter(HP + "t")) == "한글"
    for index in range(1, len(cells)):
        assert oracle.canonical_events(cells[index]) == oracle.canonical_events(after[index]), ("other table changed", index)
    # Recoloring another table's cell reuses the new black definition.
    second = out / "cell-edit-2.hwpx"
    commands.append(run_cli(cli, first, second, 1))
    again = char_prs(second)
    assert again.keys() == edited.keys(), "equal black style was not reused"
    assert {r.get("charPrIDRef") for r in table_cells(second)[1].iter(HP + "run")} == {refs[0]}
    return {"sourceCharPr7": strikeout(edited["7"]), "newBlackCharPr": refs[0], "newStrikeout": strikeout(black),
            "reusedOnSecondTable": True, "commands": [[Path(c).name if i == 0 else c for i, c in enumerate(cmd)] for cmd in commands]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, help="rhwp web package; default: published Release generation")
    parser.add_argument("--cli", type=Path, help="rhwp CLI binary built from the same patch series (table-cell case)")
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
    report = {"status": "RUNNING", "package": {n: sha(args.package / n) for n in ("rhwp.js", "rhwp_bg.wasm")}}
    (args.out / "html").mkdir()
    report["htmlPaste"] = html_paste(args.package.resolve(), args.checker.resolve(), args.out / "html")
    if args.cli:
        (args.out / "cell").mkdir()
        report["cli"] = sha(args.cli)
        report["tableCell"] = table_cell(args.cli.resolve(), args.out / "cell")
    else:
        report["tableCell"] = "NOT RUN (no --cli)"
    report["status"] = "PASS"
    (args.out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
