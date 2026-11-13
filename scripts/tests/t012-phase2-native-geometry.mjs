#!/usr/bin/env node
// T012 Phase 2 native fixtures + click geometry, from the hash-verified Release WASM only.
//   node scripts/tests/t012-phase2-native-geometry.mjs OUT_DIR
// Writes nested.{hwp,hwpx} (pinned sample / its Release HWPX export), table.{hwp,hwpx} (plain 3×3) and
// geometry.json with the page rectangle of the nested target cell and of table cells.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRelease } from "./advanced-production-runtime.mjs";

const out = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: t012-phase2-native-geometry.mjs OUT_DIR");
mkdirSync(out, { recursive: true });
const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const { build, engine } = loadRelease();
const sha = b => createHash("sha256").update(b).digest("hex");
const exported = (d, f) => { const e = f === "hwp" ? d.exportHwpWithReport() : d.exportHwpxWithReport(); try { return e.takeBytes(); } finally { e.free(); } };
const sample = new Uint8Array(readFileSync(join(ROOT, "external/rhwp/samples/inner-table-01.hwp")));
const rows = [];
for (const format of ["hwp", "hwpx"]) {
  let nested = sample;
  if (format === "hwpx") { const d = new engine.HwpDocument(sample); nested = exported(d, "hwpx"); d.free(); }
  const seed = engine.HwpDocument.createEmpty(); seed.createBlankDocument();
  seed.insertText(0, 0, 0, "Body"); seed.splitParagraph(0, 0, 4);
  const t = JSON.parse(seed.createTable(0, 1, 0, 3, 3));
  seed.setTableProperties(0, t.paraIdx, t.controlIdx, JSON.stringify(format === "hwp"
    ? { textWrap: "TopAndBottom", horzRelTo: "Column", outerLeft: 283, outerRight: 283, outerTop: 283, outerBottom: 283 } : { textWrap: "TopAndBottom" }));
  for (let i = 0; i < 9; i++) seed.insertTextInCell(0, t.paraIdx, t.controlIdx, i, 0, 0, `c${i}`);
  const table = exported(seed, format); seed.free();
  const files = { nested: join(out, `nested.${format}`), table: join(out, `table.${format}`) };
  writeFileSync(files.nested, nested); writeFileSync(files.table, table);
  const d = new engine.HwpDocument(nested);
  const lists = JSON.parse(d.getCursorModel()).lists, byId = new Map(lists.map(l => [l.listId, l]));
  const inner = lists.find(l => l.isCell && l.hostListId !== 0 && byId.get(l.hostListId)?.hostListId === 0 && l.cellIndex === 0);
  const outer = byId.get(inner.hostListId);
  const path = JSON.stringify([{ controlIndex: outer.controlIndex, cellIndex: outer.cellIndex, cellParaIndex: inner.hostPara },
    { controlIndex: inner.controlIndex, cellIndex: 0, cellParaIndex: 0 }]);
  const rect = JSON.parse(d.getCursorRectByPath(0, outer.hostPara, path, 0));
  const nestedText = d.getTextInCellByPath(0, outer.hostPara, path, 0, d.getCellParagraphLengthByPath(0, outer.hostPara, path));
  const nestedGeometry = { pageIndex: rect.pageIndex, x: rect.x, y: rect.y, height: rect.height, page: JSON.parse(d.getPageInfo(rect.pageIndex)) };
  // Expected caret key suffix of the nested cell (RhwpEditorSession.positionKey).
  const caretSuffix = `@${outer.controlIndex}/${outer.cellIndex}/${inner.hostPara}>${inner.controlIndex}/0/0`;
  d.free();
  const td = new engine.HwpDocument(table);
  const tc = JSON.parse(td.getControls()).find(c => c.ctrlId === "tbl");
  const cells = Array.from({ length: 9 }, (_, i) => {
    const r = JSON.parse(td.getCursorRectInCell(0, tc.para, tc.controlIndex, i, 0, 0));
    return { pageIndex: r.pageIndex, x: r.x, y: r.y, height: r.height, page: JSON.parse(td.getPageInfo(r.pageIndex)) };
  });
  td.free();
  rows.push({ format, nested: { source: files.nested, sha256: sha(nested), geometry: nestedGeometry, caretSuffix, text: nestedText },
    table: { source: files.table, sha256: sha(table), cells } });
}
writeFileSync(join(out, "geometry.json"), JSON.stringify({ build, nestedSource: { path: "external/rhwp/samples/inner-table-01.hwp", sha256: sha(sample) }, fixtures: rows }, null, 2) + "\n");
console.log(JSON.stringify(rows.map(r => ({ format: r.format, nested: r.nested.sha256, table: r.table.sha256, suffix: r.nested.caretSuffix }))));
