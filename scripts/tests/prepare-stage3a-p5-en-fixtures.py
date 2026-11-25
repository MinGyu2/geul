#!/usr/bin/env python3
"""Prepare reproducible HWP/HWPX endnote fixtures from RHWP's authentic sample."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
RHWP_PIN = "1a76570e833917d15817415a53c09ad61ab3203f"
PATCHES = ["stage3a-p5-endnote-virtual-owner.patch", "stage3a-p5-endnote-owner-paths.patch"]

NODE = r"""
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.resolve(process.env.GEUL_RHWP_TEST_ARTIFACTS || 'public/rhwp');
const release = JSON.parse(fs.readFileSync(path.join(root, 'RELEASE.json')));
const generation = path.join(root, 'generations', release.generation);
const rhwp = require(path.join(generation, 'rhwp.js'));
rhwp.initSync({module: fs.readFileSync(path.join(generation, 'rhwp_bg.wasm'))});
const input = fs.readFileSync(process.argv[1]);
const output = process.argv[2];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const source = new rhwp.HwpDocument(input);
let converted;
try {
  if (source.getSourceFormat() !== 'hwp') throw Error('authentic source fixture is not HWP5');
  const inventory = JSON.parse(source.getNoteInventory());
  const endnotes = inventory.filter(note => note.kind === 'endnote');
  const notes = endnotes.filter(note => note.ownerPath?.sourceType === 'body');
  const tableNotes = endnotes.filter(note => note.ownerPath?.sourceType === 'table');
  if (!notes.length || !tableNotes.length) throw Error('source HWP must contain body and table-owned endnotes');
  const target = notes.find(note => note.editableStarts.some(Number.isSafeInteger));
  const tableTarget = tableNotes.find(note => note.editableStarts.some(Number.isSafeInteger));
  if (!target || !tableTarget) throw Error('source HWP lacks a supported body or table endnote paragraph');
  const tableEdit = JSON.parse(source.getEndnoteEditInfo(tableTarget.section, tableTarget.anchorParagraph,
    tableTarget.control, JSON.stringify(tableTarget.ownerPath)));
  const tableHit = JSON.parse(source.getEndnoteHitInfo(tableTarget.section, tableEdit.virtualParaIndex, 0, tableEdit.pageNum));
  if (tableEdit.ok !== true || tableHit.kind !== 'endnote' || tableHit.instanceId !== tableTarget.instanceId
      || tableHit.number !== tableTarget.number || JSON.stringify(tableHit.ownerPath) !== JSON.stringify(tableTarget.ownerPath))
    throw Error('table-owned source endnote does not resolve to its exact rendered owner');
  const edit = JSON.parse(source.getNoteEditInfo(target.section, target.anchorParagraph, target.control));
  if (edit.ok !== true || edit.kind !== 'endnote') throw Error('source endnote edit location is not exact');
  const hit = JSON.parse(source.getEndnoteHitInfo(target.section, edit.virtualParaIndex, 0, edit.pageNum));
  if (hit.hit !== true || hit.kind !== 'endnote' || hit.instanceId !== target.instanceId
      || hit.number !== target.number || JSON.stringify(hit.ownerPath) !== JSON.stringify(target.ownerPath)) {
    throw Error('source virtual paragraph does not resolve to its exact endnote owner');
  }
  const exported = source.exportHwpxWithReport();
  try {
    const loss = JSON.parse(exported.contentLoss());
    if (loss.count !== 0 || !Array.isArray(loss.losses) || loss.losses.length !== 0) {
      throw Error('HWPX endnote fixture export reports content loss');
    }
    converted = exported.takeBytes();
  } finally { exported.free(); }
  const reopened = new rhwp.HwpDocument(converted);
  try {
    if (reopened.getSourceFormat() !== 'hwpx') throw Error('generated fixture is not HWPX');
    const savedNotes = JSON.parse(reopened.getNoteInventory());
    const savedTableTarget = savedNotes.find(note => note.kind === 'endnote'
      && note.section === tableTarget.section && note.anchorParagraph === tableTarget.anchorParagraph
      && note.control === tableTarget.control && note.instanceId === tableTarget.instanceId
      && note.number === tableTarget.number
      && JSON.stringify(note.ownerPath) === JSON.stringify(tableTarget.ownerPath));
    if (!savedTableTarget || savedTableTarget.texts.join('\n') !== tableTarget.texts.join('\n'))
      throw Error('HWPX export changed table-owned endnote identity or text');
    const savedTableEdit = JSON.parse(reopened.getEndnoteEditInfo(savedTableTarget.section,
      savedTableTarget.anchorParagraph, savedTableTarget.control, JSON.stringify(savedTableTarget.ownerPath)));
    const savedTableHit = JSON.parse(reopened.getEndnoteHitInfo(savedTableTarget.section,
      savedTableEdit.virtualParaIndex, 0, savedTableEdit.pageNum));
    if (savedTableHit.kind !== 'endnote' || savedTableHit.instanceId !== savedTableTarget.instanceId
        || savedTableHit.number !== savedTableTarget.number
        || JSON.stringify(savedTableHit.ownerPath) !== JSON.stringify(savedTableTarget.ownerPath))
      throw Error('HWPX table endnote no longer resolves to its exact source owner');
    const saved = savedNotes.find(note => note.kind === 'endnote' && note.section === target.section
      && note.anchorParagraph === target.anchorParagraph && note.control === target.control
      && note.instanceId === target.instanceId && note.number === target.number
      && JSON.stringify(note.ownerPath) === JSON.stringify(target.ownerPath));
    if (!saved || saved.texts.join('\n') !== target.texts.join('\n')
        || JSON.stringify(saved.editableStarts) !== JSON.stringify(target.editableStarts)) {
      throw Error('HWPX fixture changed endnote identity, paragraphs or editable boundary');
    }
    const hwpxEdit = JSON.parse(reopened.getNoteEditInfo(saved.section, saved.anchorParagraph, saved.control));
    const hwpxHit = JSON.parse(reopened.getEndnoteHitInfo(saved.section, hwpxEdit.virtualParaIndex, 0, hwpxEdit.pageNum));
    if (hwpxHit.kind !== 'endnote' || hwpxHit.instanceId !== saved.instanceId || hwpxHit.number !== saved.number) {
      throw Error('generated HWPX virtual endnote owner does not roundtrip');
    }
    fs.writeFileSync(output, converted, {flag: 'wx'});
    process.stdout.write(JSON.stringify({
      generation: release.generation,
      sourceFormat: source.getSourceFormat(), outputFormat: reopened.getSourceFormat(),
      sourceBytes: input.length, outputBytes: converted.length,
      sourceSha256: sha(input), outputSha256: sha(converted),
      exportLoss: {count: 0, losses: []},
      target: {section: target.section, anchorParagraph: target.anchorParagraph, control: target.control,
        ownerPath: target.ownerPath, instanceId: target.instanceId, number: target.number,
        paraCount: target.paraCount, editableStarts: target.editableStarts},
      sourceEndnoteCount: endnotes.length, bodyEndnoteCount: notes.length,
      tableEndnoteCount: tableNotes.length, tableTarget: {section: tableTarget.section,
        anchorParagraph: tableTarget.anchorParagraph, control: tableTarget.control,
        ownerPath: tableTarget.ownerPath, instanceId: tableTarget.instanceId, number: tableTarget.number},
      hwpxEndnoteCount: savedNotes.filter(note => note.kind === 'endnote').length,
    }));
  } finally { reopened.free(); }
} finally { source.free(); }
"""


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    out = args.out.resolve()
    if out.exists() or out.is_symlink():
        raise RuntimeError(f"refusing to overwrite fixture directory: {out}")
    engine = ROOT / "external/rhwp"
    revision = subprocess.check_output(["git", "-C", str(engine), "rev-parse", "HEAD"], text=True).strip()
    status = subprocess.check_output(["git", "-C", str(engine), "status", "--porcelain"], text=True)
    if revision != RHWP_PIN or status:
        raise RuntimeError("RHWP fixture source must be the exact clean pinned submodule")
    release_path = ROOT / "public/rhwp/RELEASE.json"
    release = json.loads(release_path.read_text())
    if release.get("commit") != RHWP_PIN or release.get("profile") != "release":
        raise RuntimeError("current RHWP artifact is not the pinned Release product")
    patch_names = [item.get("name") for item in release.get("integration", {}).get("patches", [])]
    if not all(name in patch_names for name in PATCHES):
        raise RuntimeError("Release product does not contain the ordered endnote owner patch series")
    generation = ROOT / "public/rhwp/generations" / release["generation"]
    for name, expected in release["artifacts"].items():
        if sha(generation / name) != expected:
            raise RuntimeError(f"RHWP Release artifact hash mismatch: {name}")

    source = engine / "samples/endnote-01.hwp"
    out.mkdir(parents=True)
    hwp_copy = out / "endnote-body.hwp"
    shutil.copy2(source, hwp_copy)
    hwpx_dir = out / "hwpx"
    hwpx_dir.mkdir()
    hwpx = hwpx_dir / "endnote-body.hwpx"
    result = json.loads(subprocess.check_output(
        ["node", "-e", NODE, str(hwp_copy), str(hwpx)], cwd=ROOT, text=True,
    ))
    record = {
        "schemaVersion": 1,
        "rhwpPin": RHWP_PIN,
        "rhwpReleaseGeneration": release["generation"],
        "rhwpPatchCount": len(patch_names),
        "rhwpSourceTreeSha256": release["integration"]["sourceTreeSha256"],
        "hwpFixture": {"path": hwp_copy.relative_to(out).as_posix(), "sha256": sha(hwp_copy)},
        "hwpxFixture": {"path": hwpx.relative_to(out).as_posix(), "sha256": sha(hwpx)},
        "proof": result,
    }
    (out / "fixture-manifest.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(record, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError, KeyError) as error:
        raise SystemExit(str(error))
