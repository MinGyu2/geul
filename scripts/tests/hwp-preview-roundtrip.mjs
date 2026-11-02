#!/usr/bin/env node
// Stage 1 native-engine integration probe. Generates a private fixture at runtime,
// verifies the pinned RHWP bytes, then sends the exported HWP through geul's actual
// preservation/save service test and reopens its published file in the same WASM.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = resolve(process.argv[2] ?? "target/four-stage/stage1");
mkdirSync(out, { recursive: true });
const build = JSON.parse(readFileSync(join(root, "public/rhwp/BUILD.json"), "utf8"));
assert.equal(build.engine, "rhwp");
assert.equal(build.commit, "1a76570e833917d15817415a53c09ad61ab3203f");
assert.equal(execFileSync("git", ["-C", join(root, "external/rhwp"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), build.commit);
const artifactHashes = {};
for (const name of ["rhwp.js", "rhwp_bg.wasm"]) {
  artifactHashes[name] = createHash("sha256").update(readFileSync(join(root, "public/rhwp", name))).digest("hex");
  assert.equal(artifactHashes[name], build.artifacts[name], `${name} matches pinned BUILD.json`);
}
execFileSync("node", [join(root, "tests/fixtures/rhwp/generate.mjs"), out], { cwd: root, stdio: "ignore" });
const rhwp = await import(pathToFileURL(join(root, "public/rhwp/rhwp.js")).href);
rhwp.initSync({ module: readFileSync(join(root, "public/rhwp/rhwp_bg.wasm")) });
const originalPath = join(out, "basic-ko.hwp");
const original = readFileSync(originalPath);
const exportHwp = (doc, filename, lossname) => {
  const exported = doc.exportHwpWithReport();
  try {
    const report = exported.contentLoss();
    const bytes = exported.takeBytes();
    writeFileSync(join(out, filename), bytes);
    writeFileSync(join(out, lossname), report);
    return { bytes, report: JSON.parse(report) };
  } finally { exported.free(); }
};
const snapshot = (doc) => ({
  format: doc.getSourceFormat(), pages: doc.pageCount(), paragraphs: doc.getParagraphCount(0),
  text: doc.getTextFileText(), controls: doc.getControls(),
  bold: JSON.parse(doc.getCharPropertiesAt(0, 1, 1)).bold ?? null,
});
let doc;
try {
  doc = new rhwp.HwpDocument(original);
  const beforeEdit = snapshot(doc);
  assert.equal(beforeEdit.format, "hwp");
  assert.equal(beforeEdit.bold, true, "generated bold run is present before editing");
  assert.match(beforeEdit.text, /셀 하나/);
  assert.match(beforeEdit.text, /Cell two/);
  const unedited = exportHwp(doc, "unedited.hwp", "loss0.json");
  assert.deepEqual(unedited.report, { schemaVersion: 1, outputFormat: "hwp", count: 0, losses: [] });

  const oldText = "한글 문단입니다. Korean paragraph.";
  const oldLength = doc.getParagraphLength(0, 0);
  assert.equal(Array.from(oldText).length, oldLength, "the original first paragraph is the targeted edit");
  doc.deleteText(0, 0, 0, oldLength);
  const replacement = "교체한 한글 내용 😀";
  const extractedReplacement = "교체한 한글 내용 &#128512;";
  doc.insertText(0, 0, 0, replacement);
  const editedSnapshot = snapshot(doc);
  assert.equal(editedSnapshot.bold, true);
  assert.ok(editedSnapshot.text.includes(extractedReplacement));
  assert.doesNotMatch(editedSnapshot.text, /한글 문단입니다\. Korean paragraph\./);
  assert.match(editedSnapshot.text, /셀 하나/);
  assert.match(editedSnapshot.text, /Cell two/);
  assert.match(editedSnapshot.text, /표 다음 문단 End\./);
  assert.equal(editedSnapshot.controls, beforeEdit.controls, "table/control references are unchanged");
  const edited = exportHwp(doc, "edited.hwp", "loss1.json");
  assert.equal(edited.report.count, 0);
  const reopen = new rhwp.HwpDocument(edited.bytes);
  let editedReopen;
  try {
    editedReopen = snapshot(reopen);
    assert.deepEqual(editedReopen, editedSnapshot, "edited export reopens with equal model/text/controls/pages/formatting");
    assert.ok(editedReopen.text.includes(extractedReplacement));
    // Persist evidence from this run, never rely on an earlier output directory.
    writeFileSync(join(out, "reopen.json"), JSON.stringify({
      formatEqual: editedReopen.format === editedSnapshot.format,
      pagesEqual: editedReopen.pages === editedSnapshot.pages,
      textEqual: editedReopen.text === editedSnapshot.text,
      controlsEqual: editedReopen.controls === editedSnapshot.controls,
    }));
  } finally { reopen.free(); }

  // Use the executable path reported by the protected `test --lib --no-run` build.
  const runnerPath = process.env.GEUL_TEST_BINARY ?? process.argv[3];
  assert.ok(runnerPath, "supply GEUL_TEST_BINARY or the test executable as the second argument");
  const runner = resolve(runnerPath);
  const tmp = join(root, "target/four-stage/tmp");
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  chmodSync(tmp, 0o700);
  execFileSync(runner, ["--ignored", "--exact", "services::save::tests::hwp_preview_real_wasm_save_probe", "--nocapture"], {
    cwd: root, env: { ...process.env, GEUL_HWP_PREVIEW_DIR: out, TMPDIR: tmp }, stdio: "inherit",
  });
  const published = readFileSync(join(out, "published.hwp"));
  const final = new rhwp.HwpDocument(published);
  let publishedSnapshot;
  try { publishedSnapshot = snapshot(final); }
  finally { final.free(); }
  assert.deepEqual(publishedSnapshot, editedSnapshot, "geul's actually published file reopens to the edited model");
  assert.equal(published.indexOf(Buffer.from(oldText, "utf16le")), -1,
    "deleted preview text bytes do not remain anywhere in the published CFB");
  console.log(JSON.stringify({ status: "PASS", engineCommit: build.commit, engineGeneration: build.generation,
    artifactHashes, sourceBytes: original.length, rawEditedBytes: edited.bytes.length, publishedBytes: published.length,
    edit: "replace the complete first paragraph with Korean and emoji", reopenedEqual: true,
    boldKept: publishedSnapshot.bold, tableTextKept: true, deletedPreviewBytesAbsent: true,
    backendActualSaveProbe: "PASS" }, null, 2));
} finally { doc?.free(); }
