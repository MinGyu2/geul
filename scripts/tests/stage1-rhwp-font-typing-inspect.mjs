#!/usr/bin/env node
// Independent Release-WASM inspection of a real HWP/HWPX save from S1-FONT-TYPING.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const build = JSON.parse(readFileSync(join(root, "public/rhwp/RELEASE.json")));
const folder = join(root, "public/rhwp/generations", build.generation);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
for (const name of ["rhwp.js", "rhwp_bg.wasm"]) {
  if (sha(readFileSync(join(folder, name))) !== build.artifacts[name]) throw Error(`Release hash mismatch: ${name}`);
}
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
if (process.argv[2] === "--add-reference") {
  const sourcePath = resolve(process.argv[3] ?? ""), outputPath = resolve(process.argv[4] ?? "");
  if (!sourcePath || !outputPath) throw Error("usage: stage1-rhwp-font-typing-inspect.mjs --add-reference INPUT OUTPUT");
  const doc = new engine.HwpDocument(readFileSync(sourcePath));
  try {
    if (doc.getParagraphCount(0) < 2 || doc.getTextRange(0, 1, 0, doc.getParagraphLength(0, 1)) !== "Second paragraph") {
      throw Error("source fixture paragraph 1 is not the expected 10 pt reference paragraph");
    }
    doc.insertText(0, 1, doc.getParagraphLength(0, 1), "ㅎ");
    const output = doc.getSourceFormat() === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
    try {
      const loss = JSON.parse(output.contentLoss());
      if (loss.count !== 0) throw Error(`reference fixture export reports content loss: ${JSON.stringify(loss)}`);
      writeFileSync(outputPath, output.takeBytes());
    } finally { output.free(); }
    console.log(JSON.stringify({ status: "PASS", format: doc.getSourceFormat(), sourceSha256: sha(readFileSync(sourcePath)),
      fixtureSha256: sha(readFileSync(outputPath)), referenceText: "Second paragraphㅎ", referenceSize100thPt: 1000 }));
  } finally { doc.free(); }
  process.exit(0);
}
const file = resolve(process.argv[2] ?? "");
if (!file || !["hwp", "hwpx"].includes(file.split(".").at(-1))) throw Error("usage: stage1-rhwp-font-typing-inspect.mjs FILE.hwp|FILE.hwpx");
const format = file.split(".").at(-1);
const input = readFileSync(file);
const doc = new engine.HwpDocument(input);
try {
  const paragraphs = Array.from({ length: doc.getParagraphCount(0) }, (_, paragraph) => {
    const length = doc.getParagraphLength(0, paragraph);
    const text = doc.getTextRange(0, paragraph, 0, length);
    const characters = Array.from({ length }, (_, offset) => ({
      text: text.slice(offset, offset + 1),
      properties: JSON.parse(doc.getCharPropertiesAt(0, paragraph, offset)),
    }));
    return { paragraph, text, characters };
  });
  const svg = doc.renderPageSvgWithProfile(0, "screen");
  const svgPath = join(dirname(file), `${basename(file)}.render.svg`);
  writeFileSync(svgPath, svg);
  console.log(JSON.stringify({
    status: "PASS",
    format,
    sourceFormat: doc.getSourceFormat(),
    inputSha256: sha(input),
    releaseGeneration: build.generation,
    releaseWasmSha256: build.artifacts["rhwp_bg.wasm"],
    paragraphs,
    render: { svgPath, svgSha256: sha(Buffer.from(svg)), pageCount: doc.pageCount() },
  }));
} finally {
  doc.free();
}
