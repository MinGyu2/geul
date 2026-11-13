#!/usr/bin/env node
// Controlled fixtures, then read-only geometry/saved-file verification for T012.
// Every engine operation uses the selected, hash-verified Release WASM.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RELEASE = join(ROOT, "public/rhwp/RELEASE.json");
const FORMATS = ["hwp", "hwpx"];
const STAGES = [
  "width-first-save", "metrics-second-save", "formula-first-save",
  "formula-replaced-save", "formula-recalculated-save", "body-width-save", "body-spacing-save", "native-formula",
];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const same = (left, right) => canonical(left) === canonical(right);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const json = value => JSON.parse(value);

export function loadRelease(expectedBuild) {
  const build = JSON.parse(readFileSync(RELEASE, "utf8"));
  requireValue(build?.profile === "release" && /^[0-9a-f]{64}$/.test(build.generation ?? ""), "selected RHWP manifest is not a Release identity");
  const { generation: expectedGeneration, ...identity } = build;
  requireValue(build.engine === "rhwp" && sha256(canonical(identity) + "\n") === expectedGeneration,
    "selected RHWP generation does not match its identity digest");
  if (expectedBuild) requireValue(same(build, expectedBuild), "selected Release changed since geometry capture");
  const generation = join(ROOT, "public/rhwp/generations", build.generation);
  const immutable = JSON.parse(readFileSync(join(generation, "BUILD.json"), "utf8"));
  requireValue(same(immutable, build), "immutable RHWP generation identity differs from RELEASE.json");
  const jsPath = join(generation, "rhwp.js");
  const wasmPath = join(generation, "rhwp_bg.wasm");
  const js = readFileSync(jsPath);
  const wasm = readFileSync(wasmPath);
  requireValue(sha256(js) === build.artifacts?.["rhwp.js"], "Release rhwp.js SHA256 does not match manifest");
  requireValue(sha256(wasm) === build.artifacts?.["rhwp_bg.wasm"], "Release rhwp_bg.wasm SHA256 does not match manifest");
  const engine = createRequire(import.meta.url)(jsPath);
  engine.initSync({ module: wasm });
  return { build, engine };
}

function writeNew(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function withDocument(engine, path, action) {
  const doc = new engine.HwpDocument(readFileSync(path));
  try { return action(doc); } finally { doc.free(); }
}

function tableControl(doc) {
  const tables = json(doc.getControls()).filter(control => control.ctrlId === "tbl");
  requireValue(tables.length === 1, `expected one table control, found ${tables.length}`);
  const table = tables[0];
  for (const key of ["list", "para", "controlIndex"]) requireValue(Number.isInteger(table[key]), `table control has no integer ${key}`);
  return { section: table.list, para: table.para, controlIndex: table.controlIndex };
}

function fixturesMode(outDir, complex = false) {
  const { build, engine } = loadRelease();
  mkdirSync(outDir);
  const outputs = [];
  for (const format of FORMATS) {
    const seed = engine.HwpDocument.createEmpty();
    try {
      seed.createBlankDocument(); seed.insertText(0, 0, 0, "Body text"); seed.splitParagraph(0, 0, 9);
      const table = json(seed.createTable(0, 1, 0, 2, 2));
      requireValue(table.ok === true, "fixture table creation refused");
      seed.insertTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, "10");
      seed.insertTextInCell(0, table.paraIdx, table.controlIdx, 1, 0, 0, "20");
      if (complex) {
        requireValue(json(seed.splitParagraphInCell(0, table.paraIdx, table.controlIdx, 3, 0, 0)).ok === true, "fixture paragraph split refused");
        requireValue(json(seed.insertClickHereFieldInCell(0, table.paraIdx, table.controlIdx, 3, 1, 0, false, "Independent tail", "", "tail", true)).ok === true, "fixture ClickHere insertion refused");
        inspectRequiredTail(seed);
      }
      const output = format === "hwp" ? seed.exportHwpWithReport() : seed.exportHwpxWithReport();
      try {
        requireValue(json(output.contentLoss()).count === 0, "fixture export reported loss");
        const source = join(outDir, `created-${format}-normalized.${format}`);
        writeFileSync(source, output.takeBytes(), { flag: "wx" });
        const sourceTail = withDocument(engine, source, doc => {
          requireValue(doc.getSourceFormat() === format && doc.getTextRange(0, 0, 0, 9) === "Body text", "fixture body did not reopen");
          return complex ? inspectRequiredTail(doc) : undefined;
        });
        outputs.push({ format, source, sha256: sha256(readFileSync(source)), sourceTail });
      } finally { output.free(); }
    } finally { seed.free(); }
  }
  writeNew(join(outDir, "fixtures.json"), { build, complex, scope: "controlled generated fixtures, not Hancom authored", outputs });
}

function captureGeometry(engine, format, source) {
  return withDocument(engine, source, doc => {
    const control = tableControl(doc);
    const dimensions = json(doc.getTableDimensions(control.section, control.para, control.controlIndex));
    requireValue(dimensions.rowCount === 2 && dimensions.colCount === 2 && dimensions.cellCount === 4,
      `${format} fixture is not the expected 2x2 table`);
    const cells = [];
    for (let cell = 0; cell < 4; cell += 1) {
      const rect = json(doc.getCursorRectInCell(control.section, control.para, control.controlIndex, cell, 0, 0));
      const page = json(doc.getPageInfo(rect.pageIndex));
      requireValue([rect.x, rect.y, rect.height, rect.pageIndex, page.width, page.height].every(Number.isFinite),
        `${format} cell ${cell} has invalid cursor/page geometry`);
      cells.push({ x: rect.x, y: rect.y, height: rect.height, pageIndex: rect.pageIndex, page });
    }
    const bodyParagraph = Array.from({ length: doc.getParagraphCount(0) }, (_, index) => index).find(index =>
      doc.getTextRange(0, index, 0, doc.getParagraphLength(0, index)) === "Body text");
    requireValue(bodyParagraph !== undefined, `${format} fixture has no independent body paragraph`);
    const rect = json(doc.getCursorRect(0, bodyParagraph, 0));
    const body = { ...rect, page: json(doc.getPageInfo(rect.pageIndex)), paragraph: bodyParagraph };
    return { format, source, sha256: sha256(readFileSync(source)), cells, body, sourceTail: inspectRequiredTail(doc) };
  });
}

function geometryMode(outPath, fixtureDir) {
  const { build, engine } = loadRelease();
  const fixtures = [
    ["hwp", "created-hwp-normalized.hwp"],
    ["hwpx", "created-hwpx-normalized.hwpx"],
  ].map(([format, name]) => captureGeometry(engine, format, resolve(fixtureDir, name)));
  writeNew(outPath, { build, fixtures });
}

/** Geometry of one cell of a genuine fixture, for the stale-preview native stage. */
function cellGeometryMode(outPath, source, cellText) {
  const { build, engine } = loadRelease();
  const cell = Number(cellText);
  const geometry = withDocument(engine, source, doc => {
    const control = tableControl(doc);
    const rect = json(doc.getCursorRectInCell(control.section, control.para, control.controlIndex, cell, 0, 0));
    return { x: rect.x, y: rect.y, height: rect.height, pageIndex: rect.pageIndex, page: json(doc.getPageInfo(rect.pageIndex)) };
  });
  writeNew(outPath, { build, source, sha256: sha256(readFileSync(source)), cell, geometry });
}

function textInCell(doc, control, cell) {
  const paragraphs = doc.getCellParagraphCount(control.section, control.para, control.controlIndex, cell);
  return Array.from({ length: paragraphs }, (_, paragraph) => {
    const length = doc.getCellParagraphLength(control.section, control.para, control.controlIndex, cell, paragraph);
    return doc.getTextInCell(control.section, control.para, control.controlIndex, cell, paragraph, 0, length);
  }).join("\n");
}

function inspectSnapshot(engine, format, path, stage, originalHash) {
  const hash = sha256(readFileSync(path));
  const observed = withDocument(engine, path, doc => {
    requireValue(doc.getSourceFormat() === format, `${format}/${stage} reopened in another format`);
    const control = tableControl(doc);
    const dimensions = json(doc.getTableDimensions(control.section, control.para, control.controlIndex));
    requireValue(dimensions.rowCount === 2 && dimensions.colCount === 2 && dimensions.cellCount === 4,
      `${format}/${stage} did not preserve the 2x2 table`);
    const cellTexts = [0, 1, 2, 3].map(cell => textInCell(doc, control, cell));
    requireValue(cellTexts[1] === "20", `${format}/${stage} did not preserve B1 text 20`);
    const properties = json(doc.getCellCharPropertiesAt(control.section, control.para, control.controlIndex, 1, 0, 0));
    requireValue(Array.isArray(properties.ratios) && properties.ratios.length === 7, `${format}/${stage} has invalid seven-language width values`);
    requireValue(Array.isArray(properties.spacings) && properties.spacings.length === 7, `${format}/${stage} has invalid seven-language spacing values`);
    const bodyIndex = Array.from({ length: doc.getParagraphCount(0) }, (_, index) => index).find(index =>
      doc.getTextRange(0, index, 0, doc.getParagraphLength(0, index)) === "Body text");
    requireValue(bodyIndex !== undefined, `${format}/${stage} independent body text missing`);
    const bodyProperties = json(doc.getCharPropertiesAt(0, bodyIndex, 0));
    const bodyFormatted = ["body-width-save", "body-spacing-save", "native-formula"].includes(stage);
    requireValue(same(bodyProperties.ratios, Array(7).fill(bodyFormatted ? 125 : 100)), `${format}/${stage} body width lost`);
    requireValue(same(bodyProperties.spacings, Array(7).fill(["body-spacing-save", "native-formula"].includes(stage) ? -7 : 0)),
      `${format}/${stage} body spacing lost`);
    const fields = json(doc.getFieldList());
    const formulaFields = fields.filter(field => field.fieldType === "formula");
    if (stage === "width-first-save" || stage === "metrics-second-save") {
      requireValue(formulaFields.length === 0, `${format}/${stage} unexpectedly contains a formula field`);
      requireValue(cellTexts[0] === "10" && cellTexts[2] === "", `${format}/${stage} has unexpected source-cell text`);
      return { fieldInventory: fields, dimensions, cellTexts, ratios: properties.ratios, spacings: properties.spacings, formulaFields, bodyProperties };
    }
    requireValue(formulaFields.length === 1, `${format}/${stage} must contain exactly one formula field`);
    const formula = formulaFields[0];
    const expected = stage === "formula-first-save"
      ? { expression: "=SUM(A1:B1)", value: "30" }
      : stage === "formula-replaced-save"
        ? { expression: "=SUM(A1:B1)+1", value: "31" }
        : { expression: "=SUM(A1:B1)+1", value: "32" };
    requireValue(formula.fieldType === "formula", `${format}/${stage} field is not a formula`);
    requireValue(formula.command === `${expected.expression}??%g,;;${expected.value}` && formula.value === expected.value,
      `${format}/${stage} formula expression/cached result mismatch`);
    const locationPath = formula.location?.path;
    requireValue(Number.isSafeInteger(formula.fieldId) && formula.fieldId > 0, `${format}/${stage} has invalid field identity`);
    requireValue(formula.location?.sectionIndex === control.section && formula.location?.paraIndex === control.para
      && Array.isArray(locationPath) && locationPath.length === 1 && locationPath[0].type === "cell"
      && locationPath[0].controlIndex === control.controlIndex && locationPath[0].cellIndex === 3 && locationPath[0].paraIndex === 0,
    `${format}/${stage} formula is not owned by B2`);
    const expectedSource = ["formula-first-save", "formula-replaced-save"].includes(stage) ? "10" : "11";
    requireValue(cellTexts[0] === expectedSource && cellTexts[2] === "한글", `${format}/${stage} did not preserve source edit and Korean input`);
    return {
      fieldInventory: fields, dimensions, cellTexts, ratios: properties.ratios, spacings: properties.spacings, bodyProperties,
      formulaFields: formulaFields.map(field => ({ fieldId: field.fieldId, fieldType: field.fieldType, command: field.command, value: field.value })),
    };
  });
  const expectedRatios = stage === "width-first-save" ? Array(7).fill(150) : Array(7).fill(180);
  const expectedSpacings = stage === "width-first-save" ? Array(7).fill(0) : Array(7).fill(10);
  requireValue(same(observed.ratios, expectedRatios), `${format}/${stage} did not preserve all seven width values`);
  requireValue(same(observed.spacings, expectedSpacings), `${format}/${stage} did not preserve all seven spacing values`);
  return { format, stage, path, sha256: hash, originalSha256: originalHash, ...observed };
}

/** Required structure, independently read from the Release document APIs. */
export function inspectRequiredTail(doc) {
  const t = tableControl(doc);
  const count = doc.getCellParagraphCount(t.section, t.para, t.controlIndex, 3);
  requireValue(count === 2, "required trailing paragraph missing or duplicated");
  const text = doc.getTextInCell(t.section, t.para, t.controlIndex, 3, 1, 0,
    doc.getCellParagraphLength(t.section, t.para, t.controlIndex, 3, 1));
  const inventory = json(doc.getFieldList());
  const fields = inventory.filter(f => f.fieldType !== "formula");
  requireValue(fields.length === 1, "required ClickHere field missing or duplicated");
  const f = fields[0];
  requireValue(f.fieldType === "clickhere" && f.name === "tail" && f.guide === "Independent tail"
    && f.command === "Clickhere:set:59:Direction:wstring:16:Independent tail HelpState:wstring:0:  "
    && f.value === "" && f.cellField === false && f.editableInForm === true,
  "malformed required ClickHere field");
  requireValue(Number.isSafeInteger(f.fieldId) && f.fieldId > 0, "invalid trailing field identity");
  requireValue(same(f.location, { sectionIndex: t.section, paraIndex: t.para,
    path: [{ type: "cell", controlIndex: t.controlIndex, cellIndex: 3, paraIndex: 1 }] }),
  "incorrect trailing field location");
  const lists = json(doc.getCursorModel()).lists.filter(l => l.listId === f.listId);
  requireValue(lists.length === 1 && lists[0].isCell === true && lists[0].hostListId === 0
    && lists[0].sectionIndex === t.section && lists[0].hostPara === t.para
    && lists[0].controlIndex === t.controlIndex && lists[0].cellIndex === 3
    && lists[0].paraCount === count && f.paraInList === 1, "incorrect trailing cursor-list owner");
  const owners = json(doc.getControls()).filter(c => c.list === f.listId && c.para === f.paraInList);
  requireValue(owners.length === 1 && owners[0].ctrlId === "" && owners[0].ctrlCh === 0
    && owners[0].pos === 0 && owners[0].controlIndex === 0, "incorrect trailing control owner");
  requireValue(f.startCharIdx === 0 && f.endCharIdx === 0 && f.startPos === 8 && f.endPos === 24
    && text === f.value, "trailing field range disagrees with cell text");
  return { paragraphCount: count, paragraphs: [text], fields };
}

export function compareRequiredTail(source, saved) {
  requireValue(source?.fields?.length === 1 && saved?.fields?.length === 1,
    "required source/saved field absent");
  requireValue(same(source, saved), "changed independent trailing paragraphs/fields");
}

function verifyFormat(engine, fixture, nativeDir) {
  requireValue(FORMATS.includes(fixture.format), `unsupported format ${fixture.format}`);
  requireValue(Array.isArray(fixture.cells) && fixture.cells.length === 4, `${fixture.format} geometry does not contain four cells`);
  const sourceHash = sha256(readFileSync(fixture.source));
  requireValue(sourceHash === fixture.sha256, `${fixture.format} immutable source hash changed`);
  withDocument(engine, fixture.source, inspectRequiredTail);
  const rows = STAGES.map(stage => inspectSnapshot(engine, fixture.format,
    join(nativeDir, `${stage}.${fixture.format}`), stage, sourceHash));
  const originalTail = withDocument(engine, fixture.source, inspectRequiredTail);
  for (const row of rows) {
    row.requiredTail = withDocument(engine, row.path, inspectRequiredTail);
    compareRequiredTail(originalTail, row.requiredTail);
  }
  requireValue(sha256(readFileSync(fixture.source)) === sourceHash, `${fixture.format} source fixture changed during verification`);
  const firstFormulaId = rows[2].formulaFields[0].fieldId;
  for (const row of rows.slice(3)) requireValue(row.formulaFields[0].fieldId === firstFormulaId,
    `${fixture.format}/${row.stage} replaced the persistent formula field identity`);
  requireValue(same(rows.at(-2).cellTexts, rows.at(-1).cellTexts)
    && same(rows.at(-2).formulaFields, rows.at(-1).formulaFields)
    && same(rows.at(-2).ratios, rows.at(-1).ratios)
    && same(rows.at(-2).spacings, rows.at(-1).spacings)
    && same(rows.at(-2).bodyProperties, rows.at(-1).bodyProperties),
  `${fixture.format} reopened final document does not retain the recalculated semantic state`);
  return { format: fixture.format, source: fixture.source, sourceSha256: sourceHash, sourceTail: originalTail, stages: rows };
}

function verifyMode(geometryPath, nativeDir, resultPath) {
  const geometry = JSON.parse(readFileSync(geometryPath, "utf8"));
  requireValue(Array.isArray(geometry.fixtures) && geometry.fixtures.length === 2, "geometry must contain HWP and HWPX fixtures");
  requireValue(new Set(geometry.fixtures.map(fixture => fixture.format)).size === 2, "geometry contains duplicate formats");
  const { build, engine } = loadRelease(geometry.build);
  const formats = new Set(geometry.fixtures.map(fixture => fixture.format));
  requireValue(FORMATS.every(format => formats.has(format)), "geometry must contain both HWP and HWPX");
  const fixtures = FORMATS.map(format => verifyFormat(engine, geometry.fixtures.find(fixture => fixture.format === format), nativeDir));
  writeNew(resultPath, {
    status: "PASS",
    scope: "internal Release-WASM verification of actual native-harness saved files; no Hancom Office compatibility claim",
    build,
    geometry: resolve(geometryPath),
    fixtures,
  });
}

function main(argv) {
  const [mode, ...args] = argv;
  if (mode === "fixtures" && args.length === 1) return fixturesMode(resolve(args[0]));
  if (mode === "fixtures-complex" && args.length === 1) return fixturesMode(resolve(args[0]), true);
  if (mode === "geometry" && args.length === 2) return geometryMode(resolve(args[0]), resolve(args[1]));
  if (mode === "cell-geometry" && args.length === 3) return cellGeometryMode(resolve(args[0]), resolve(args[1]), args[2]);
  if (mode === "verify" && args.length === 3) return verifyMode(resolve(args[0]), resolve(args[1]), resolve(args[2]));
  throw new Error("usage: advanced-production-runtime.mjs fixtures <out-dir> | geometry <out-json> <fixture-dir> | cell-geometry <out-json> <source> <cell> | verify <geometry-json> <native-out-dir> <result-json>");
}

try {
  if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
