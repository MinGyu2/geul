#!/usr/bin/env node
// Separate-process Release reopen oracle and small controlled native fixtures.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
const root = resolve(import.meta.dirname, "../..");
const build = JSON.parse(readFileSync(join(root, "public/rhwp/RELEASE.json")));
const folder = join(root, "public/rhwp/generations", build.generation);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
if (build.profile !== "release" || !isDeepStrictEqual(build, JSON.parse(readFileSync(join(folder, "BUILD.json"))))) throw Error("Release identity mismatch");
for (const name of ["rhwp.js", "rhwp_bg.wasm"]) if (sha(readFileSync(join(folder, name))) !== build.artifacts[name]) throw Error("Release hash mismatch");
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
function bytes(d, format) {
  const e = format === "hwp" ? d.exportHwpWithReport() : d.exportHwpxWithReport();
  try { const report = JSON.parse(e.contentLoss()); if (report.count !== 0) throw Error("fixture content loss"); return e.takeBytes(); } finally { e.free(); }
}
if (process.argv[2] === "--generate") {
  const out = process.argv[3]; if (!out) throw Error("missing output folder"); mkdirSync(out, { recursive: true });
  for (const format of ["hwp", "hwpx"]) {
    const d = engine.HwpDocument.createEmpty();
    try {
      d.createBlankDocument(); d.setPreserveSourceCaret(true);
      const ids = JSON.parse(d.resolveDocumentFontFamily("NanumGothic"));
      d.resolveDocumentFontFamily("NanumMyeongjo");
      const text = "한글 Font editing ABC 0123"; d.insertText(0, 0, 0, text);
      d.applyCharFormat(0, 0, 0, [...text].length, JSON.stringify({ fontIds: ids }));
      writeFileSync(join(out, `font.${format}`), bytes(d, format));
    } finally { d.free(); }
  }
  writeFileSync(join(out, "generation.json"), JSON.stringify(build, null, 2));
} else {
  const file = process.argv[2]; if (!file) throw Error("usage: rhwp-font-editing.mjs FILE | --generate DIR");
  const input = readFileSync(file), d = new engine.HwpDocument(input);
  try {
    const table = JSON.parse(d.getDocumentFontTable());
    const body = Array.from({ length: d.getParagraphCount(0) }, (_, p) => {
      const text = d.getTextRange(0, p, 0, d.getParagraphLength(0, p));
      const families = [...text].map((_, i) => {
        const shape = table.charShapes[JSON.parse(d.getCharPropertiesAt(0, p, i)).charShapeId];
        return shape.fontIds.map((id, lang) => table.languages[lang].fonts[id].definition.name);
      });
      return { text, families };
    });
    console.log(JSON.stringify({ sha256: sha(input), generation: build.generation, artifacts: build.artifacts,
      format: d.getSourceFormat(), pages: d.pageCount(), body, table }));
  } finally { d.free(); }
}
