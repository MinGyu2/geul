#!/usr/bin/env node
// Current-generation integration probe. Generated documents/logs remain ignored.
// Usage: node scripts/tests/new-document-runtime.mjs <new-run-dir> [RELEASE.json|DEBUG.json] [--prepared|--published]
// The first phase claims a new (or empty) run directory; --prepared and --published continue the same
// run and only add new files. No phase replaces an existing output (scripts/tests/evidenceOutput.mjs).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { claimRunDirectory, requireRunDirectory, writeNew, writeNewOrIdentical } from "./evidenceOutput.mjs";

const root = process.cwd();
const positional = process.argv.slice(2).filter(value => !value.startsWith("--"));
if (!positional[0]) throw new Error("usage: new-document-runtime.mjs <new-run-dir> [RELEASE.json|DEBUG.json] [--prepared|--published]");
const out = resolve(positional[0]);
const pointer = positional[1] ?? "RELEASE.json";
const prepared = process.argv.includes("--prepared");
if (prepared || process.argv.includes("--published")) requireRunDirectory(out);
else claimRunDirectory(out);
const product = "src/components/Editor/rhwp";
for (const name of ["rhwpArtifactIdentity", "rhwpModule", "createBlank"]) {
  const source = readFileSync(join(root, product, `${name}.ts`), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
    .replace('"./rhwpArtifactIdentity"', '"./rhwpArtifactIdentity.mjs"');
  writeNewOrIdentical(join(out, `${name}.mjs`), code);
}
const { loadRhwpModule } = await import(pathToFileURL(join(out, "rhwpModule.mjs")));
const { createRhwpBlank } = await import(pathToFileURL(join(out, "createBlank.mjs")));
const build = JSON.parse(readFileSync(join(root, "public/rhwp", pointer)));
const module = await loadRhwpModule(
  url => import(pathToFileURL(join(root, "public", url))),
  async url => new Response(readFileSync(join(root, "public", url === "/rhwp/BUILD.json" ? `/rhwp/${pointer}` : url))),
);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const snapshot = d => ({ format: d.getSourceFormat(), pages: d.pageCount(), sections: d.getSectionCount(),
  text: d.getTextFileText(), controls: d.getControls(),
  paragraphs: Array.from({ length: d.getParagraphCount(0) }, (_, p) => d.getTextRange(0, p, 0, d.getParagraphLength(0, p))),
});
if (process.argv.includes("--published")) {
  for (const format of ["hwp", "hwpx"]) {
    for (const [index, expected] of [[1, ["한글", "문단  English"]], [2, ["수정문단  English"]]]) {
      const doc = module.openDocument(readFileSync(join(out, `published-${index}.${format}`)));
      try {
        assert.equal(doc.getSourceFormat(), format);
        assert.deepEqual(snapshot(doc).paragraphs, expected);
      } finally { doc.free(); }
    }
  }
  writeNew(join(out, "published-reopen.json"), JSON.stringify({ status: "PASS", build, formats: ["hwp", "hwpx"], saves: 2 }) + "\n");
  console.log("Rust published HWP/HWPX: two independent final reopens PASS");
  process.exit(0);
}
const emit = (d, format, name) => {
  const e = format === "hwp" ? d.exportHwpWithReport() : d.exportHwpxWithReport();
  try {
    const report = JSON.parse(e.contentLoss());
    assert.deepEqual(report, { schemaVersion: 1, outputFormat: format, count: 0, losses: [] });
    const bytes = e.takeBytes();
    writeNew(join(out, `${name}.${format}`), bytes);
    writeNew(join(out, `${name}.${format}.loss.json`), JSON.stringify(report));
    const reopened = module.openDocument(bytes);
    try { assert.deepEqual(snapshot(reopened), snapshot(d)); } finally { reopened.free(); }
    return bytes;
  } finally { e.free(); }
};
// Phase 1 edits the raw blank (raw-*); --prepared edits Rust's prepared bytes (unedited/first-save/
// second-save, consumed by the Rust safe-save test). Distinct names keep both phases' outputs.
const stem = name => prepared ? name : `raw-${name}`;
const report = { status: "RUNNING", build, prepared, formats: [], candidates: [] };
// Compare both original candidates using this facade's module, not a second class.
const generated = await import(pathToFileURL(join(root, "public/rhwp/generations", build.generation, "rhwp.js")));
for (const candidate of prepared ? [] : ["empty", "template"]) {
  const doc = module.createEmptyDocument();
  const row = { candidate, formats: [] };
  try {
    if (candidate === "template") assert.equal(typeof doc.createBlankDocument(), "string");
    for (const format of ["hwp", "hwpx"]) {
      let reopened;
      const value = { format, status: "FAIL" };
      try {
        const e = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
        try { reopened = module.openDocument(e.takeBytes()); } finally { e.free(); }
        assert.ok(reopened instanceof generated.HwpDocument);
        reopened.insertText(0, 0, 0, "한글 English");
        reopened.splitParagraph(0, 0, 2);
        emit(reopened, format, `${candidate}-edited`);
        value.status = "PASS";
      } catch (e) { value.error = String(e); } finally { reopened?.free(); }
      row.formats.push(value);
    }
  } finally { doc.free(); }
  report.candidates.push(row);
}
for (const format of ["hwp", "hwpx"]) {
  const created = createRhwpBlank(module, format);
  const repeat = createRhwpBlank(module, format);
  assert.deepEqual(created, repeat, "deterministic blank bytes and loss report");
  // Deterministic: the prepared phase re-checks the same raw blank and never replaces it.
  writeNewOrIdentical(join(out, `blank.${format}`), created.bytes);
  writeNewOrIdentical(join(out, `blank.${format}.loss.json`), JSON.stringify(created.contentLoss));
  const finalBytes = prepared ? readFileSync(join(out, `prepared.${format}`)) : created.bytes;
  const doc = module.openDocument(finalBytes);
  try {
    assert.equal(doc.getSourceFormat(), format);
    assert.deepEqual(snapshot(doc).paragraphs, [""]);
    emit(doc, format, stem("unedited"));
    assert.equal(JSON.parse(doc.insertText(0, 0, 0, "한글 English")).ok, true);
    assert.equal(JSON.parse(doc.splitParagraph(0, 0, 2)).ok, true);
    doc.insertText(0, 1, 0, "문단 ");
    assert.deepEqual(snapshot(doc).paragraphs, ["한글", "문단  English"]);
    emit(doc, format, stem("first-save"));
    doc.mergeParagraph(0, 1);
    doc.deleteText(0, 0, 0, 2);
    doc.insertText(0, 0, 0, "수정");
    assert.deepEqual(snapshot(doc).paragraphs, ["수정문단  English"]);
    emit(doc, format, stem("second-save"));
    report.formats.push({ format, blankBytes: created.bytes.length, blankSha256: hash(created.bytes), finalSha256: hash(finalBytes),
      firstInsert: "PASS", split: "PASS", merge: "PASS", deleteInsert: "PASS", twoSavesReopen: "PASS" });
  } finally { doc.free(); }
}
report.status = "PASS";
// Real WASM resource ownership under an injected export-report failure.
for (const fail of [false, true]) {
  const live = new Set();
  const exports = new Set();
  const track = doc => {
    live.add(doc);
    const release = doc.free.bind(doc);
    doc.free = () => { assert.ok(live.delete(doc)); release(); };
    const emit = doc.exportHwpxWithReport.bind(doc);
    doc.exportHwpxWithReport = () => {
      const result = emit();
      exports.add(result);
      const free = result.free.bind(result);
      result.free = () => { assert.ok(exports.delete(result)); free(); };
      if (fail) result.contentLoss = () => '{"safe":true}';
      return result;
    };
    return doc;
  };
  const owned = { createEmptyDocument: () => track(module.createEmptyDocument()), openDocument: b => track(module.openDocument(b)) };
  if (fail) assert.throws(() => createRhwpBlank(owned, "hwpx"));
  else createRhwpBlank(owned, "hwpx");
  assert.equal(live.size, 0);
  assert.equal(exports.size, 0);
}
report.resourceLifecycle = "PASS: success and invalid loss report release documents and export results";
writeNew(join(out, prepared ? "runtime-prepared.json" : "runtime.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
