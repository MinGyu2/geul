#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FORMATS = ["hwp", "hwpx"];
const STAGES = [
  { name: "pointer-first", cells: ["10", "20", "", "X한글"], expression: null, value: null },
  { name: "formula-first", cells: ["21", "20", "", "X한글"], expression: "=B1+1??%g,;;21", value: "21" },
  { name: "formula-second", cells: ["22", "20", "", "X한글"], expression: "=B1+2??%g,;;22", value: "22" },
];

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const json = value => JSON.parse(value);

function loadRelease() {
  const manifestPath = join(ROOT, "public/rhwp/RELEASE.json");
  const build = JSON.parse(readFileSync(manifestPath, "utf8"));
  requireValue(build?.engine === "rhwp" && build?.profile === "release", "selected RHWP manifest is not a Release build");
  requireValue(/^[0-9a-f]{64}$/.test(build.generation ?? ""), "Release generation must be a 64-character lowercase SHA256");
  const { generation, ...identity } = build;
  requireValue(sha256(`${canonical(identity)}\n`) === generation, "Release generation does not match its manifest identity digest");

  const generationPath = join(ROOT, "public/rhwp/generations", generation);
  requireValue(realpathSync(generationPath) === generationPath, "Release generation path resolves outside its immutable generation directory");
  const immutable = JSON.parse(readFileSync(join(generationPath, "BUILD.json"), "utf8"));
  requireValue(canonical(immutable) === canonical(build), "immutable generation identity differs from RELEASE.json");

  const jsPath = join(generationPath, "rhwp.js");
  const wasmPath = join(generationPath, "rhwp_bg.wasm");
  const js = readFileSync(jsPath);
  const wasm = readFileSync(wasmPath);
  requireValue(/^[0-9a-f]{64}$/.test(build.artifacts?.["rhwp.js"] ?? "")
    && sha256(js) === build.artifacts["rhwp.js"], "Release rhwp.js SHA256 does not match its manifest");
  requireValue(/^[0-9a-f]{64}$/.test(build.artifacts?.["rhwp_bg.wasm"] ?? "")
    && sha256(wasm) === build.artifacts["rhwp_bg.wasm"], "Release rhwp_bg.wasm SHA256 does not match its manifest");

  const engine = createRequire(import.meta.url)(jsPath);
  engine.initSync({ module: wasm });
  return {
    build,
    artifactHashes: { "rhwp.js": sha256(js), "rhwp_bg.wasm": sha256(wasm) },
    engine,
  };
}

function tableControl(doc, context) {
  const tables = json(doc.getControls()).filter(control => control.ctrlId === "tbl");
  requireValue(tables.length === 1, `${context}: expected one table control, found ${tables.length}`);
  const table = tables[0];
  for (const key of ["list", "para", "controlIndex"]) {
    requireValue(Number.isSafeInteger(table[key]) && table[key] >= 0, `${context}: table control has invalid ${key}`);
  }
  requireValue(table.list === 0 && table.para === 1,
    `${context}: expected the fixture table in root list 0 at paragraph 1 (list is not a section index)`);
  const dimensions = json(doc.getTableDimensions(0, table.para, table.controlIndex));
  requireValue(dimensions.rowCount === 2 && dimensions.colCount === 2 && dimensions.cellCount === 4,
    `${context}: expected a 2x2 table, got ${JSON.stringify(dimensions)}`);
  return { section: 0, paragraph: 1, control: table.controlIndex };
}

function inspectDocument(doc, format, stage, expectedFieldId, context) {
  requireValue(doc.getSourceFormat() === format, `${context}: reopened as ${doc.getSourceFormat()}, expected ${format}`);
  const table = tableControl(doc, context);
  const cells = Array.from({ length: 4 }, (_, cell) => {
    const paragraphs = doc.getCellParagraphCount(table.section, table.paragraph, table.control, cell);
    return Array.from({ length: paragraphs }, (_, paragraph) => {
      const length = doc.getCellParagraphLength(table.section, table.paragraph, table.control, cell, paragraph);
      return doc.getTextInCell(table.section, table.paragraph, table.control, cell, paragraph, 0, length);
    }).join("\n");
  });
  assert.deepEqual(cells, stage.cells, `${context}: table cell contents differ`);

  const fields = json(doc.getFieldList());
  if (stage.expression === null) {
    assert.equal(fields.length, 0, `${context}: pointer-first save unexpectedly contains a field`);
    return { table, cells, fields };
  }

  assert.equal(fields.length, 1, `${context}: expected exactly one formula field`);
  const field = fields[0];
  assert.equal(field.fieldType, "formula", `${context}: field type mismatch`);
  assert.equal(field.command, stage.expression, `${context}: formula expression or cached value mismatch`);
  assert.equal(field.value, stage.value, `${context}: formula cache mismatch`);
  assert.ok(Number.isSafeInteger(field.fieldId) && field.fieldId > 0, `${context}: invalid formula field identity`);
  if (expectedFieldId !== undefined) assert.equal(field.fieldId, expectedFieldId, `${context}: formula identity changed`);
  assert.equal(field.location?.sectionIndex, table.section, `${context}: formula section mismatch`);
  assert.equal(field.location?.paraIndex, table.paragraph, `${context}: formula owner paragraph mismatch`);
  assert.deepEqual(field.location?.path, [{
    type: "cell",
    controlIndex: table.control,
    cellIndex: 0,
    paraIndex: 0,
  }], `${context}: formula is not located in top-level A1`);
  return { table, cells, fields };
}

function verifySavedFile(engine, inputDir, format, stage, expectedFieldId) {
  const file = join(inputDir, `${stage.name}.${format}`);
  const input = readFileSync(file);
  const inputHash = sha256(input);
  const original = new engine.HwpDocument(input);
  let report;
  let reopened;
  try {
    const beforeExport = inspectDocument(original, format, stage, expectedFieldId, `${format}/${stage.name}/native-save`);
    report = format === "hwp" ? original.exportHwpWithReport() : original.exportHwpxWithReport();
    const output = report.takeBytes();
    reopened = new engine.HwpDocument(output);
    const afterReopen = inspectDocument(reopened, format, stage, expectedFieldId, `${format}/${stage.name}/engine-reopen`);
    assert.deepEqual(afterReopen.cells, beforeExport.cells, `${format}/${stage.name}: export/reopen changed cells`);
    assert.deepEqual(afterReopen.fields, beforeExport.fields, `${format}/${stage.name}: export/reopen changed field metadata`);
    return {
      format,
      stage: stage.name,
      path: file,
      nativeSaveSha256: inputHash,
      reexportSha256: sha256(output),
      cells: afterReopen.cells,
      fields: afterReopen.fields,
      status: "PASS",
    };
  } finally {
    if (reopened) reopened.free();
    if (report) report.free();
    original.free();
  }
}

function main() {
  const argument = process.argv[2];
  requireValue(typeof argument === "string" && argument.length > 0,
    "usage: node scripts/tests/verify-bottom-pointer.mjs <native-output-dir>");
  const inputDir = resolve(process.cwd(), argument);
  requireValue(existsSync(inputDir), `native output directory does not exist: ${inputDir}`);
  const evidencePath = join(inputDir, "reopen.json");
  requireValue(!existsSync(evidencePath), `refusing to overwrite existing evidence: ${evidencePath}`);

  const { build, artifactHashes, engine } = loadRelease();
  const rows = [];
  const fieldIds = {};
  for (const format of FORMATS) {
    let formulaFieldId;
    for (const stage of STAGES) {
      const row = verifySavedFile(engine, inputDir, format, stage, formulaFieldId);
      if (stage.expression !== null && formulaFieldId === undefined) {
        formulaFieldId = row.fields[0].fieldId;
      }
      rows.push(row);
    }
    fieldIds[format] = formulaFieldId;
  }

  const result = {
    schemaVersion: 1,
    verification: "Release WASM re-export/reopen of real native Tauri save-service outputs",
    nativePublication: "The six input documents were produced by the actual native Tauri save service; this verifier did not publish them.",
    release: {
      generation: build.generation,
      commit: build.commit,
      manifestSha256: sha256(readFileSync(join(ROOT, "public/rhwp/RELEASE.json"))),
      artifacts: artifactHashes,
    },
    formulaFieldIds: fieldIds,
    rows,
    status: "PASS",
  };
  writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`PASS: ${rows.length} native Tauri HWP/HWPX saves re-exported and reopened with exact cells and formula metadata; evidence: ${evidencePath}\n`);
}

main();
