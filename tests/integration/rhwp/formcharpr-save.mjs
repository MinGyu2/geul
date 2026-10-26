// Optional real-engine test helper. Uses the existing pinned production WASM, never rebuilds it.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { zipEntries, charPrs } from "../../poc/t010-phase0/analysis.mjs";
import { loadVerifiedRhwp } from "./production-identity.mjs";

const rhwp = await loadVerifiedRhwp();

function inspect(file) {
  const bytes = readFileSync(file);
  const doc = new rhwp.HwpDocument(bytes);
  try {
    const exported = doc.exportHwpxWithReport();
    let loss, serialized;
    try { loss = JSON.parse(exported.contentLoss()); serialized = exported.takeBytes(); }
    finally { exported.free(); }
    const parts = zipEntries(Buffer.from(serialized));
    const section = parts.get("Contents/section0.xml").toString("utf8");
    const forms = [...section.matchAll(/<hp:checkBtn\b([^>]*)>([\s\S]*?)<\/hp:checkBtn>/g)]
      .filter((m) => m[1].includes('name="GeulGoldenForm"'));
    assert.equal(forms.length, 1, "interpreted model must retain exactly one named form");
    const inCell = [...section.matchAll(/<hp:tc\b[\s\S]*?<\/hp:tc>/g)]
      .some((m) => m[0].includes('name="GeulGoldenForm"'));
    const id = Number(/<hp:formCharPr\b[^>]*charPrIDRef="(\d+)"/.exec(forms[0][2])[1]);
    const header = parts.get("Contents/header.xml").toString("utf8");
    const shape = charPrs(header).find((s) => Number(/\bid="(\d+)"/.exec(s)[1]) === id);
    assert.ok(shape, "interpreted form shape must be defined");
    const direct = [];
    const surrounding = [];
    for (let p = 0; p < doc.getParagraphCount(0); p++) {
      for (let offset = 0; offset < doc.getParagraphLength(0, p); offset++) {
        surrounding.push(JSON.parse(doc.getCharPropertiesAt(0, p, offset)));
      }
      for (let c = 0; c < 4; c++) {
        const info = JSON.parse(doc.getFormObjectInfo(0, p, c));
        if (info.ok && info.name === "GeulGoldenForm") direct.push(info);
      }
    }
    const cell = [];
    // API-generated fixture has a 2x2 table at paragraph 2/control 0.
    for (let c = 0; c < 4; c++) {
      for (let p = 0; p < doc.getCellParagraphCount(0, 2, 0, c); p++) {
        for (let offset = 0; offset < doc.getCellParagraphLength(0, 2, 0, c, p); offset++) {
          cell.push(JSON.parse(doc.getCellCharPropertiesAt(0, 2, 0, c, p, offset)));
        }
      }
    }
    const re = new rhwp.HwpDocument(serialized);
    let reopen;
    try {
      reopen = { formatEqual: re.getSourceFormat() === doc.getSourceFormat(), pagesEqual: re.pageCount() === doc.pageCount(),
        textEqual: re.getTextFileText() === doc.getTextFileText(), controlsEqual: re.getControls() === doc.getControls() };
    } finally { re.free(); }
    return { id, inCell, italic: /<hh:italic\b/.test(shape), direct, surrounding,
      text: doc.getTextFileText(), controls: doc.getControls(),
      cell, loss, reopen };
  } finally { doc.free(); }
}

const [mode, original, output, target, result, expectedId] = process.argv.slice(2);
const before = inspect(original);
const expected = inspect(output);
assert.equal(before.id, 0);
assert.equal(before.italic, false);
assert.equal(expected.id, Number(expectedId));
assert.notEqual(before.id, expected.id);
assert.equal(expected.italic, true);
assert.deepEqual(before.surrounding, expected.surrounding);
assert.deepEqual(before.cell, expected.cell);
assert.equal(before.text, expected.text);
assert.equal(before.controls, expected.controls);
assert.equal(before.inCell, expected.inCell);
assert.equal(expected.direct.length, expected.inCell ? 0 : 1);
assert.ok(Object.values(expected.reopen).every(Boolean));
if (mode === "prepare") {
  writeFileSync(`${original}.loss.json`, JSON.stringify(before.loss));
  writeFileSync(`${output}.loss.json`, JSON.stringify(expected.loss));
  writeFileSync(result, JSON.stringify(expected.reopen));
} else {
  assert.equal(mode, "verify");
  assert.deepEqual(readFileSync(target), readFileSync(output), "reopen exact published bytes");
  const saved = inspect(target);
  assert.deepEqual(saved, expected);
  if (saved.direct.length) {
    assert.equal(saved.direct.length, 1);
    assert.equal(Number(saved.direct[0].properties.CharShapeID), saved.id);
  }
  // Cell forms have no indexed detail API. Re-export walks the actual parsed Control::Form,
  // so its formCharPr + resolved charPr is evidence of engine interpretation, not input XML.
  writeFileSync(result, JSON.stringify({ status: "PASS", publishedBytesEqual: true,
    formCount: 1, inCell: saved.inCell, charShapeId: saved.id, italic: saved.italic,
    directPropertiesObserved: saved.direct.length === 1, interpretedReexportObserved: true,
    surroundingTextEqual: true, surroundingFormattingEqual: true,
    reopen: saved.reopen }));
}
