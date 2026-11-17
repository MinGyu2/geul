// Independent reopen oracle for the Stage 1 P1/F native acceptance: a fresh Release-WASM engine reads a saved
// HWP/HWPX file and reports body text, per-character superscript/size, paragraph list heads and embedded fonts.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(new URL("../..", import.meta.url).pathname);
const release = JSON.parse(readFileSync(join(root, "public/rhwp/RELEASE.json"), "utf8"));
const folder = join(root, "public/rhwp/generations", release.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const doc = new engine.HwpDocument(new Uint8Array(readFileSync(process.argv[2])));
try {
  const body = Array.from({ length: doc.getParagraphCount(0) }, (_, p) => {
    const n = doc.getParagraphLength(0, p), para = JSON.parse(doc.getParaPropertiesAt(0, p));
    const chars = Array.from({ length: n }, (_, i) => JSON.parse(doc.getCharPropertiesAt(0, p, i)));
    return { text: n ? doc.getTextRange(0, p, 0, n) : "", headType: para.headType, numberingId: para.numberingId,
      superscript: chars.map(c => c.superscript === true), fontSize: chars.map(c => c.fontSize) };
  });
  const embedded = doc.getEmbeddedFonts ? JSON.parse(doc.getEmbeddedFonts()) : [];
  console.log(JSON.stringify({ generation: release.generation, format: doc.getSourceFormat(), body, embedded }));
} finally { doc.free(); }
