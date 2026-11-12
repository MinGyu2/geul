#!/usr/bin/env node
// Independent saved-file oracle for character formatting: opens HWP/HWPX files with the hash-verified
// RHWP Release generation (public/rhwp/RELEASE.json) outside the application and prints, for every body
// paragraph and table-cell paragraph, the text and one flag letter set per character
// (B bold, I italic, U underline, S strikethrough, - none). Also prints first-page geometry of each cell
// start so a native pointer click can be aimed without any in-app hook.
//   node scripts/tests/rhwp-char-flags.mjs FILE...
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const pointer = JSON.parse(readFileSync(join(root, "public/rhwp/RELEASE.json"), "utf8"));
const folder = join(root, "public/rhwp/generations", pointer.generation);
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
for (const name of ["rhwp.js", "rhwp_bg.wasm"]) {
  if (sha(join(folder, name)) !== pointer.artifacts[name]) throw new Error(`Release artifact hash mismatch: ${name}`);
}
const metadata = JSON.parse(readFileSync(join(folder, "BUILD.json"), "utf8"));
if (!isDeepStrictEqual(metadata, pointer) || pointer.profile !== "release") throw new Error("Release metadata mismatch");
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });

const letters = (json) => {
  const v = JSON.parse(json);
  return (v.bold ? "B" : "") + (v.italic ? "I" : "") + (v.underline ? "U" : "") + (v.strikethrough ? "S" : "") || "-";
};
const files = process.argv.slice(2).map((file) => {
  const doc = new engine.HwpDocument(new Uint8Array(readFileSync(file)));
  try {
    const body = [];
    for (let p = 0; p < doc.getParagraphCount(0); p++) {
      const n = doc.getParagraphLength(0, p);
      body.push({ text: doc.getTextRange(0, p, 0, n), flags: Array.from({ length: n }, (_, i) => letters(doc.getCharPropertiesAt(0, p, i))) });
    }
    const tables = JSON.parse(doc.getControls()).filter((c) => c.ctrlId === "tbl").map((c) => {
      const size = JSON.parse(doc.getTableDimensions(0, c.para, c.controlIndex));
      return { paragraph: c.para, control: c.controlIndex, cells: Array.from({ length: size.cellCount }, (_, cell) => {
        const n = doc.getCellParagraphLength(0, c.para, c.controlIndex, cell, 0);
        return { text: doc.getTextInCell(0, c.para, c.controlIndex, cell, 0, 0, n),
          flags: Array.from({ length: n }, (_, i) => letters(doc.getCellCharPropertiesAt(0, c.para, c.controlIndex, cell, 0, i))),
          start: JSON.parse(doc.getCursorRectInCell(0, c.para, c.controlIndex, cell, 0, 0)) };
      }) };
    });
    return { file, sha256: sha(file), format: doc.getSourceFormat(), pages: doc.pageCount(), page: JSON.parse(doc.getPageInfo(0)), body, tables };
  } finally { doc.free(); }
});
process.stdout.write(JSON.stringify({ generation: pointer.generation, artifacts: pointer.artifacts, files }) + "\n");
