#!/usr/bin/env node
// Stage 4 native integration fixtures + click geometry, from the hash-verified Release WASM only.
//   node scripts/tests/stage4-native-geometry.mjs OUT_DIR
// compound.{hwp,hwpx}: one 3×3 body table combining the supported Stage 2 features
//   A1 "10" | B1 "20"                                   | C1 "서식대상" (character-format target)
//   A2 "합 " =A1+B1 " 배 " =B1*2 " 끝" (two inline fields) | B2 "그림" + inline PNG   | C2 "중첩" + nested 1×2 table
//   A3 "본문" (IME target)                               | B3 ""                    | C3 ""
// stale.{hwp,hwpx}: the Stage 3 contract table, A1 "10" | B1 =A1*2 (cache 20).
// geometry.json records fixture hashes, field identities and the page rectangles of every click target.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRelease } from "./advanced-production-runtime.mjs";

const out = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: stage4-native-geometry.mjs OUT_DIR");
mkdirSync(out, { recursive: true });
const { build, engine } = loadRelease();
const sha = b => createHash("sha256").update(b).digest("hex");
const need = (ok, message) => { if (!ok) throw new Error(message); };
const ok = (raw, what) => { const r = JSON.parse(raw); need(r.ok === true, `${what}: ${raw}`); return r; };
const exported = (d, f) => { const e = f === "hwp" ? d.exportHwpWithReport() : d.exportHwpxWithReport(); try { return e.takeBytes(); } finally { e.free(); } };
// Same normalization as hwpReopenModel.HWP_TABLE_NORMALIZATION (product HWP table eligibility).
const HWP_TABLE = { textWrap: "TopAndBottom", horzRelTo: "Column", outerLeft: 283, outerRight: 283, outerTop: 283, outerBottom: 283 };
// Same 48×64 PNG as the Stage 2 cell-inline picture tests.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAADAAAABACAIAAADTQmMRAAAATklEQVR4nO3OMQ0AIBAAsVfCjH8pKMIFx9CkAjpnr69MPhASEhKqB0JCQkL1QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF4XmIMR3l0LcAAAAAElFTkSuQmCC", "base64");
const cellPath = (control, cell, para = 0) => JSON.stringify([{ controlIndex: control, cellIndex: cell, cellParaIndex: para }]);

function table(d, format, rows, cols) {
  const t = ok(d.createTable(0, 1, 0, rows, cols), "createTable");
  d.setTableProperties(0, t.paraIdx, t.controlIdx, JSON.stringify(format === "hwp" ? HWP_TABLE : { textWrap: "TopAndBottom" }));
  return t;
}

function compound(format) {
  const d = engine.HwpDocument.createEmpty();
  try {
    d.createBlankDocument(); d.insertText(0, 0, 0, "Body"); d.splitParagraph(0, 0, 4);
    const t = table(d, format, 3, 3);
    const texts = ["10", "20", "서식대상", "", "그림", "중첩", "본문", "", ""];
    texts.forEach((v, i) => v && d.insertTextInCell(0, t.paraIdx, t.controlIdx, i, 0, 0, v));
    // A2: "합 " [=A1+B1] " 배 " [=B1*2] " 끝"
    d.insertTextInCell(0, t.paraIdx, t.controlIdx, 3, 0, 0, "합  배  끝");
    ok(d.insertTableFormulaAt(0, t.paraIdx, cellPath(t.controlIdx, 3), 5, 0, "=B1*2"), "second formula");
    ok(d.insertTableFormulaAt(0, t.paraIdx, cellPath(t.controlIdx, 3), 2, 0, "=A1+B1"), "first formula");
    ok(d.insertPictureInCellByPath(0, t.paraIdx, cellPath(t.controlIdx, 4), 2, PNG, 3600, 4800, 48, 64, "png", ""), "inline picture");
    const child = ok(d.createTableInCellByPath(0, t.paraIdx, cellPath(t.controlIdx, 5), 2, 1, 2), "nested table");
    for (let c = 0; c < 2; c++)
      d.insertTextInCellByPath(0, t.paraIdx, JSON.stringify([{ controlIndex: t.controlIdx, cellIndex: 5, cellParaIndex: 0 }, { controlIndex: child.controlIdx, cellIndex: c, cellParaIndex: 0 }]), 0, `내부${c}`);
    return exported(d, format);
  } finally { d.free(); }
}

function stale(format) {
  const d = engine.HwpDocument.createEmpty();
  try {
    d.createBlankDocument(); d.insertText(0, 0, 0, "Body"); d.splitParagraph(0, 0, 4);
    const t = table(d, format, 1, 2);
    d.insertTextInCell(0, t.paraIdx, t.controlIdx, 0, 0, 0, "10");
    ok(d.insertTableFormulaAt(0, t.paraIdx, cellPath(t.controlIdx, 1), 0, 0, "=A1*2"), "stale formula");
    return exported(d, format);
  } finally { d.free(); }
}

function describe(bytes, format, targets) {
  const d = new engine.HwpDocument(bytes);
  try {
    need(d.getSourceFormat() === format, `${format} reopened format`);
    const t = JSON.parse(d.getControls()).find(c => c.ctrlId === "tbl" && c.list === 0);
    const rect = (cell, offset) => {
      const r = JSON.parse(d.getCursorRectByPath(0, t.para, cellPath(t.controlIndex, cell), offset));
      return { pageIndex: r.pageIndex, x: r.x, y: r.y, height: r.height, page: JSON.parse(d.getPageInfo(r.pageIndex)) };
    };
    const text = cell => d.getTextInCellByPath(0, t.para, cellPath(t.controlIndex, cell), 0, d.getCellParagraphLengthByPath(0, t.para, cellPath(t.controlIndex, cell)));
    const fields = JSON.parse(d.getFieldList()).filter(f => f.fieldType === "formula")
      .map(f => ({ fieldId: f.fieldId, command: f.command, value: f.value, startCharIdx: f.startCharIdx, location: f.location }));
    const geometry = Object.fromEntries(Object.entries(targets).map(([name, [cell, offset]]) => [name, { cell, offset, rect: rect(cell, offset) }]));
    return { table: { para: t.para, controlIndex: t.controlIndex }, fields, geometry, cells: Object.fromEntries(Object.keys(targets).map(k => [targets[k][0], text(targets[k][0])])) };
  } finally { d.free(); }
}

const rows = [];
for (const format of ["hwp", "hwpx"]) {
  const c = compound(format), s = stale(format);
  const files = { compound: join(out, `compound.${format}`), stale: join(out, `stale.${format}`) };
  writeFileSync(files.compound, c); writeFileSync(files.stale, s);
  const cd = describe(c, format, { ime: [6, 2], format: [2, 0], formulaSecond: [3, 0], picture: [4, 3], nested: [5, 0], source: [0, 2] });
  // The second field's range start is a real engine offset; click there to own that field.
  const second = cd.fields.find(f => f.command.startsWith("=B1*2"));
  need(cd.fields.length === 2 && second, `${format} compound fields ${JSON.stringify(cd.fields)}`);
  Object.assign(cd.geometry, describe(c, format, { formulaSecond: [3, second.startCharIdx], formulaInside: [3, second.startCharIdx + 1] }).geometry);
  const sd = describe(s, format, { source: [0, 2], formula: [1, 0] });
  need(sd.fields.length === 1 && sd.fields[0].value === "20", `${format} stale fixture ${JSON.stringify(sd.fields)}`);
  rows.push({ format, compound: { source: files.compound, sha256: sha(c), ...cd }, stale: { source: files.stale, sha256: sha(s), ...sd } });
}
writeFileSync(join(out, "geometry.json"), JSON.stringify({ build, fixtures: rows }, null, 2) + "\n");
console.log(JSON.stringify(rows.map(r => ({ format: r.format, compound: r.compound.sha256, fields: r.compound.fields.map(f => [f.fieldId, f.command, f.startCharIdx]), cells: r.compound.cells, stale: r.stale.sha256 })), null, 1));
