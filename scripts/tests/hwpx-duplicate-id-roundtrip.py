#!/usr/bin/env python3
"""Real-WASM regression for repeated imported HWPX paragraph ids.

Hancom writers repeat ``hp:p@id`` (most paragraphs carry ``id="0"``). The
patched engine must keep every imported value exactly, give new paragraphs
fresh ids, and still refuse missing/invalid ids. Excess or aliased duplicates
cannot be produced through the public editing API; their refusal is covered by
the Rust unit tests in ``patches/rhwp/hwpx-duplicate-paragraph-ids.patch``.

Only upstream public samples are read; results go to a new ignored directory.
"""
import argparse
import collections
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[2]
HP = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
LIFECYCLE = "external/rhwp/saved/hwpx-01-saved.hwpx"
DEFAULT_SAMPLES = (LIFECYCLE, "external/rhwp/saved/s-hwpx-02.hwpx", "external/rhwp/samples/hwpx/hwpx-02.hwpx",
                   "external/rhwp/tools/forms/간이기안문_서식.hwpx", "external/rhwp/samples/셀보호.hwpx")

CODE = r"""
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [pkg, source, out, k] = process.argv.slice(2), K = Number(k);
const m = await import(pathToFileURL(resolve(pkg, 'rhwp.js')));
m.initSync({module: readFileSync(resolve(pkg, 'rhwp_bg.wasm'))});
const ok = s => { const r = JSON.parse(s); assert.equal(r.ok, true, s); return r; };
const text = d => Array.from({length: d.getSectionCount()}, (_, s) =>
  Array.from({length: d.getParagraphCount(s)}, (_, p) => d.getTextRange(s, p, 0, d.getParagraphLength(s, p))));
const steps = {};
const emit = (d, name) => {
  const expected = {text: text(d), controls: d.getControls(), pages: d.pageCount()};
  const e = d.exportHwpxWithReport();
  try {
    const loss = JSON.parse(e.contentLoss()); assert.equal(loss.count, 0, JSON.stringify(loss));
    const b = e.takeBytes(); writeFileSync(resolve(out, name + '.hwpx'), b);
    const r = new m.HwpDocument(b);
    try { assert.deepEqual({text: text(r), controls: r.getControls(), pages: r.pageCount()}, expected); } finally { r.free(); }
    steps[name] = {paragraphs: expected.text[0].length, reopenEqual: true};
  } finally { e.free(); }
};
const d = new m.HwpDocument(readFileSync(source));
try {
  const before = text(d);
  emit(d, 'original'); emit(d, 'repeat');
  ok(d.insertText(0, K, 0, '검증한글😀'));
  assert.equal(text(d)[0][K], '검증한글😀' + before[0][K]);
  emit(d, 'insert');
  ok(d.splitParagraph(0, K, 2));
  assert.deepEqual(text(d)[0].slice(K, K + 2), ['검증', '한글😀' + before[0][K]]);
  emit(d, 'split'); emit(d, 'split-repeat');
  // Copy two imported repeated-id paragraphs (K-1 and K, both id "0") and
  // paste at the end of K+1: K+1 absorbs the first, one new paragraph (a copy
  // of K, '검증') is inserted at K+2. The copy must not carry id "0".
  ok(d.copySelection(0, K - 1, 0, K, d.getParagraphLength(0, K)));
  ok(d.pasteInternal(0, K + 1, d.getParagraphLength(0, K + 1)));
  assert.equal(text(d)[0][K + 2], '검증');
  emit(d, 'copy');
  // Merge the pasted copy back into K+1; its new id disappears again.
  ok(d.mergeParagraph(0, K + 2));
  emit(d, 'merge'); emit(d, 'merge-repeat');
} finally { d.free(); }
console.log(JSON.stringify({status: 'PASS', steps}));
"""


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def parts(path):
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None, path
        return {name: archive.read(name) for name in archive.namelist()}


def sections(path):
    entries = parts(path)
    names = sorted((n for n in entries if n.startswith("Contents/section") and n.endswith(".xml")),
                   key=lambda n: int(n[len("Contents/section"):-4]))
    return [ET.fromstring(entries[n]) for n in names]


def top_ids(path):
    return [[p.attrib["id"] for p in root.findall(HP + "p")] for root in sections(path)]


def all_ids(path):
    return collections.Counter(p.attrib["id"] for root in sections(path) for p in root.iter(HP + "p"))


def pick_paragraph(path):
    """First plain-text section-0 paragraph (>=2 chars) whose id and whose
    preceding plain paragraph's id are both repeated in the source."""
    counts = all_ids(path)
    paras = sections(path)[0].findall(HP + "p")
    plain = lambda p: all(child.tag == HP + "t" for run in p.findall(HP + "run") for child in run)
    for index, para in enumerate(paras[1:], start=1):
        texts = "".join(t.text or "" for t in para.iter(HP + "t"))
        previous = paras[index - 1]
        if (counts[para.attrib["id"]] > 1 and counts[previous.attrib["id"]] > 1 and plain(para)
                and plain(previous) and len(texts) >= 2):
            return index, para.attrib["id"]
    raise AssertionError(f"no plain repeated-id paragraph in {path}")


def write_parts(path, entries, source):
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(path, "w") as archive:
        for info in original.infolist():
            archive.writestr(info, entries[info.filename])


def lifecycle(package, source, out):
    k, repeated = pick_paragraph(source)
    result = subprocess.run(["node", "--input-type=module", "-", str(package), str(source), str(out), str(k)],
                            input=CODE, text=True, capture_output=True, cwd=ROOT)
    (out / "node.log").write_text(result.stdout + result.stderr)
    assert result.returncode == 0, result.stderr[-2000:]
    src_top, src_all = top_ids(source), all_ids(source)
    fresh_floor = max(int(v) for v in src_all)
    read = lambda name: (top_ids(out / f"{name}.hwpx"), all_ids(out / f"{name}.hwpx"))
    original, original_all = read("original")
    # Every imported value, including the repeated ones, survives exactly.
    assert original == src_top and original_all == src_all, "imported ids changed on unedited export"
    assert read("repeat") == (original, original_all)
    assert parts(out / "repeat.hwpx") == parts(out / "original.hwpx"), "repeated unedited export not byte-stable"
    inserted, inserted_all = read("insert")
    assert (inserted, inserted_all) == (original, original_all), "text insertion changed paragraph ids"
    split, split_all = read("split")
    assert split[0][:k + 1] == original[0][:k + 1] and split[0][k + 2:] == original[0][k + 1:]
    new_id = split[0][k + 1]
    assert int(new_id) > fresh_floor and new_id not in src_all, (new_id, fresh_floor)
    assert split_all - collections.Counter({new_id: 1}) == original_all
    assert read("split-repeat") == (split, split_all), "fresh id not stable across repeated export"
    copied, copied_all = read("copy")
    assert len(copied[0]) == len(split[0]) + 1
    copy_id = copied[0][k + 2]
    # The copy of an imported id "0" paragraph gets a currently unused id
    # (pre-existing clone remap allocator) and never adds another repeat.
    assert copy_id not in split_all, (copy_id, split_all.most_common(3))
    assert copied_all - collections.Counter({copy_id: 1}) == split_all
    assert copied_all[repeated] == src_all[repeated]
    assert copied[0][:k + 2] == split[0][:k + 2] and copied[0][k + 3:] == split[0][k + 2:]
    merged, merged_all = read("merge")
    assert (merged, merged_all) == (split, split_all), "merging the copy back did not restore ids"
    assert read("merge-repeat") == (merged, merged_all)
    return {"source": str(source.relative_to(ROOT)), "sourceSha256": sha(source), "editedParagraph": k,
            "repeatedId": repeated, "sourceRepeats": {v: c for v, c in src_all.items() if c > 1},
            "freshIdFloor": fresh_floor, "splitNewId": new_id, "copyNewId": copy_id,
            "node": json.loads(result.stdout.splitlines()[-1])}


def negatives(package, source, out):
    spec = importlib.util.spec_from_file_location("probe", ROOT / "scripts/tests/hwpx-textdir-roundtrip.py")
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    cases = []
    for name, value in (("missing", None), ("invalid", "bad"), ("negative", "-1"), ("overflow", "4294967296"),
                        ("empty", "")):
        entries = parts(source)
        root = ET.fromstring(entries["Contents/section0.xml"])
        para = next(root.iter(HP + "p"))
        if value is None:
            para.attrib.pop("id")
        else:
            para.set("id", value)
        entries["Contents/section0.xml"] = ET.tostring(root, encoding="utf-8")
        path = out / f"negative-{name}.hwpx"
        write_parts(path, entries, source)
        before = sha(path)
        actual = probe.export(package, path, out / f"negative-{name}-out.hwpx")
        diagnostic = actual["diagnostic"] or {}
        assert actual["returncode"] != 0 and diagnostic.get("stage") == "export" and diagnostic.get("opened"), actual
        assert "HWPX paragraph id missing or invalid" in diagnostic["error"], diagnostic
        assert not (out / f"negative-{name}-out.hwpx").exists() and sha(path) == before
        cases.append({"name": name, "readable": True, "exportRefused": diagnostic["error"]})
    return cases


def survey(package, checker, samples, out):
    spec = importlib.util.spec_from_file_location("probe", ROOT / "scripts/tests/hwpx-textdir-roundtrip.py")
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    rows = []
    for rel in samples:
        source = ROOT / rel
        output = out / f"survey-{hashlib.sha256(rel.encode()).hexdigest()[:12]}.hwpx"
        actual = probe.export(package, source, output)
        row = {"sample": rel, "sha256": sha(source), "repeatedIds": sum(c for c in all_ids(source).values() if c > 1),
               "exported": actual["returncode"] == 0}
        if actual["returncode"] == 0:
            assert all_ids(output) == all_ids(source) and top_ids(output) == top_ids(source), rel
            verdict = subprocess.run([str(checker), "preflight", "hwpx", str(source), str(output),
                                      str(output) + ".loss.json"], capture_output=True, text=True, check=True)
            row["preflight"] = json.loads(verdict.stdout)
        else:
            row["error"] = (actual["diagnostic"] or {}).get("error")
        rows.append(row)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, help="rhwp web package; default: published Release generation")
    parser.add_argument("--checker", type=Path, default=ROOT / "src-tauri/target/debug/examples/save_check")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--sample", action="append", help="survey sample (repeatable)")
    parser.add_argument("--expect-safe", action="append", default=[], help="survey sample that must preflight safe")
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=False)
    if args.package is None:
        identity = json.loads((ROOT / "public/rhwp/RELEASE.json").read_text())
        args.package = ROOT / "public/rhwp/generations" / identity["generation"]
        for name, digest in identity["artifacts"].items():
            assert sha(args.package / name) == digest, name
    args.package = args.package.resolve()
    lifecycle_out = args.out / "lifecycle"
    lifecycle_out.mkdir()
    report = {"status": "RUNNING", "package": {n: sha(args.package / n) for n in ("rhwp.js", "rhwp_bg.wasm")}}
    report["lifecycle"] = lifecycle(args.package, ROOT / LIFECYCLE, lifecycle_out)
    report["negative"] = negatives(args.package, ROOT / LIFECYCLE, args.out)
    report["survey"] = survey(args.package, args.checker.resolve(), args.sample or list(DEFAULT_SAMPLES), args.out)
    for row in report["survey"]:
        if row["sample"] in args.expect_safe:
            assert row.get("preflight", {}).get("outcome") == "safe", row
    report["status"] = "PASS"
    (args.out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"status": "PASS", "survey": [(r["sample"], r.get("preflight", {}).get("outcome"),
                                                     [(f["code"], f.get("part")) for f in r.get("preflight", {}).get("findings", [])])
                                                    for r in report["survey"]]}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
