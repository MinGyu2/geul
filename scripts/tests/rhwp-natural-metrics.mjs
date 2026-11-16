#!/usr/bin/env node
// Separate-process Release oracle for the Stage 5-A natural-metric native run.
//   --generate DIR   controlled HWP/HWPX fixtures (mixed body line, wrap paragraph, 1x2 table) + geometry.json
//   FILE             saved-file inspection: text, per-character 7-slot families (body and table cells), table shape.
// This process never binds natural fonts: it reports document data only (families, text, structure, page geometry).
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
const root = resolve(import.meta.dirname, "../..");
const build = JSON.parse(readFileSync(join(root, "public/rhwp/RELEASE.json")));
const folder = join(root, "public/rhwp/generations", build.generation);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (build.profile !== "release" || !isDeepStrictEqual(build, JSON.parse(readFileSync(join(folder, "BUILD.json"))))) throw Error("Release identity mismatch");
for (const name of ["rhwp.js", "rhwp_bg.wasm"]) if (sha(readFileSync(join(folder, name))) !== build.artifacts[name]) throw Error("Release hash mismatch");
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });

export const BODY = "한글 Font editing ABC 0123 Wide iiii";
export const WRAP = "W".repeat(100);
export const CELL = ["셀 Cell WWWW iiii", "Other 다른 칸"];

function bytes(d, format) {
  const e = format === "hwp" ? d.exportHwpWithReport() : d.exportHwpxWithReport();
  try { const report = JSON.parse(e.contentLoss()); if (report.count !== 0) throw Error("fixture content loss"); return e.takeBytes(); } finally { e.free(); }
}
function families(table, shapeId) {
  return table.charShapes[shapeId].fontIds.map((id, lang) => table.languages[lang].fonts[id].definition.name);
}
const parseText = (v) => { try { const j = JSON.parse(v); return typeof j === "string" ? j : j.text ?? v; } catch { return v; } };
function locateTable(d) {
  for (let p = 0; p < d.getParagraphCount(0); p++) {
    for (let c = 0; c < 4; c++) {
      try { const dims = JSON.parse(d.getTableDimensions(0, p, c)); if (dims.rowCount) return { paragraph: p, control: c, ...dims }; } catch { /* not a table */ }
    }
  }
  throw Error("no table");
}
function inspect(d) {
  const table = JSON.parse(d.getDocumentFontTable());
  const body = Array.from({ length: d.getParagraphCount(0) }, (_, p) => {
    const length = d.getParagraphLength(0, p);
    const text = d.getTextRange(0, p, 0, length);
    return { text, families: [...text].map((_, i) => families(table, JSON.parse(d.getCharPropertiesAt(0, p, i)).charShapeId)) };
  });
  const t = locateTable(d);
  const cells = Array.from({ length: t.cellCount }, (_, cell) => {
    const length = d.getCellParagraphLength(0, t.paragraph, t.control, cell, 0);
    const text = parseText(d.getTextInCell(0, t.paragraph, t.control, cell, 0, 0, length));
    return { text, families: [...String(text)].map((_, i) => families(table, JSON.parse(d.getCellCharPropertiesAt(0, t.paragraph, t.control, cell, 0, i)).charShapeId)) };
  });
  return { body, table: t, cells };
}

if (process.argv[2] === "--generate") {
  const out = process.argv[3]; if (!out) throw Error("missing output folder"); mkdirSync(out, { recursive: true });
  const geometry = { build, fixtures: [] };
  for (const format of ["hwp", "hwpx"]) {
    const d = engine.HwpDocument.createEmpty();
    try {
      d.createBlankDocument(); d.setPreserveSourceCaret(true);
      const gothic = JSON.parse(d.resolveDocumentFontFamily("NanumGothic"));
      d.resolveDocumentFontFamily("NanumMyeongjo");
      const fontIds = JSON.stringify({ fontIds: gothic });
      d.insertText(0, 0, 0, BODY);
      d.splitParagraph(0, 0, [...BODY].length);
      d.insertText(0, 1, 0, WRAP);
      d.splitParagraph(0, 1, [...WRAP].length);
      const made = JSON.parse(d.createTable(0, 2, 0, 1, 2));
      const p = made.paraIdx, c = made.controlIdx;
      for (const [cell, text] of CELL.entries()) {
        d.insertTextInCell(0, p, c, cell, 0, 0, text);
        d.applyCharFormatInCell(0, p, c, cell, 0, 0, [...text].length, fontIds);
      }
      d.applyCharFormat(0, 0, 0, [...BODY].length, fontIds);
      d.applyCharFormat(0, 1, 0, [...WRAP].length, fontIds);
      const output = bytes(d, format);
      const file = join(out, `natural.${format}`);
      writeFileSync(file, output);
      const reopened = new engine.HwpDocument(output);
      try {
        const page = JSON.parse(reopened.getPageInfo(0));
        const cells = JSON.parse(reopened.getTableCellBboxes(0, p, c, 0));
        const state = inspect(reopened);
        geometry.fixtures.push({ format, source: file, sha256: sha(output), page, table: { paragraph: p, control: c }, cells, state });
      } finally { reopened.free(); }
    } finally { d.free(); }
  }
  writeFileSync(join(out, "geometry.json"), JSON.stringify(geometry, null, 2));
} else {
  const file = process.argv[2]; if (!file) throw Error("usage: rhwp-natural-metrics.mjs FILE | --generate DIR");
  const input = readFileSync(file), d = new engine.HwpDocument(input);
  try {
    const state = inspect(d);
    console.log(JSON.stringify({ sha256: sha(input), generation: build.generation, format: d.getSourceFormat(), pages: d.pageCount(), ...state }));
  } finally { d.free(); }
}
