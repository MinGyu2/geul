#!/usr/bin/env node
// Independent saved-file oracle: opens HWP/HWPX files with the hash-verified RHWP Release generation
// (public/rhwp/RELEASE.json) outside the application and prints every body paragraph.
//   node scripts/tests/rhwp-paragraphs.mjs FILE...
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
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const files = process.argv.slice(2).map((file) => {
  const doc = new engine.HwpDocument(new Uint8Array(readFileSync(file)));
  try {
    const paragraphs = [];
    const sections = typeof doc.getSectionCount === "function" ? doc.getSectionCount() : 1;
    for (let s = 0; s < sections; s++) {
      for (let p = 0; p < doc.getParagraphCount(s); p++) paragraphs.push(doc.getTextRange(s, p, 0, doc.getParagraphLength(s, p)));
    }
    return { file, sha256: sha(file), format: doc.getSourceFormat(), pages: doc.pageCount(), paragraphs };
  } finally { doc.free(); }
});
process.stdout.write(JSON.stringify({ generation: pointer.generation, wasm: pointer.artifacts["rhwp_bg.wasm"], files }) + "\n");
