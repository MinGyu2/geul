#!/usr/bin/env node
// Formula-field lifecycle against the product's hash-verified RHWP WASM generation.
// Usage: node scripts/tests/table-formula-runtime.mjs <new-run-dir> [RELEASE.json|DEBUG.json]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { claimRunDirectory, requireRunDirectory, writeNew, writeNewOrIdentical } from "./evidenceOutput.mjs";

const root = process.cwd();
const [runArg, pointer = "RELEASE.json"] = process.argv.slice(2).filter(v => !v.startsWith("--"));
const published = process.argv.includes("--published");
if (!runArg) throw new Error("usage: table-formula-runtime.mjs <new-run-dir> [RELEASE.json|DEBUG.json]");
const out = resolve(runArg);
if (published) requireRunDirectory(out); else claimRunDirectory(out);
const product = "src/components/Editor/rhwp";
for (const name of ["rhwpArtifactIdentity", "rhwpModule"]) {
  const source = readFileSync(join(root, product, `${name}.ts`), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
    .replace('"./rhwpArtifactIdentity"', '"./rhwpArtifactIdentity.mjs"');
  writeNewOrIdentical(join(out, `${name}.mjs`), code);
}
const { loadRhwpModule } = await import(pathToFileURL(join(out, "rhwpModule.mjs")));
const build = JSON.parse(readFileSync(join(root, "public/rhwp", pointer)));
const module = await loadRhwpModule(
  url => import(pathToFileURL(join(root, "public", url))),
  async url => new Response(readFileSync(join(root, "public", url === "/rhwp/BUILD.json" ? `/rhwp/${pointer}` : url))),
);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const snapshot = doc => ({ format: doc.getSourceFormat(), pages: doc.pageCount(), text: doc.getTextFileText(),
  controls: JSON.parse(doc.getControls()), fields: JSON.parse(doc.getFieldList()) });
const formulaFields = doc => JSON.parse(doc.getFieldList()).filter(field => field.fieldType === "formula" || field.command?.includes("??%g,;;"));
const exportDoc = (doc, fmt) => {
  const value = fmt === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
  try { return { bytes: Buffer.from(value.takeBytes()), loss: JSON.parse(value.contentLoss()) }; }
  finally { value.free(); }
};
const saveEvidence = (doc, fmt, name) => {
  const value = exportDoc(doc, fmt);
  const file = join(out, `${name}.${fmt}`);
  writeNew(file, value.bytes);
  const loss = join(out, `${name}.${fmt}.loss.json`);
  writeNew(loss, JSON.stringify(value.loss, null, 2) + "\n");
  return { ...value, file, loss, lossReport: value.loss };
};
const cellIndex = (doc, parent, control, row, col) => {
  const { cellCount } = JSON.parse(doc.getTableDimensions(0, parent, control));
  for (let cell = 0; cell < cellCount; cell++) {
    const info = JSON.parse(doc.getCellInfo(0, parent, control, cell));
    if (info.row === row && info.col === col) return cell;
  }
  throw new Error(`table cell ${row},${col} missing`);
};
const fieldAt = (doc, control, cell) => {
  const found = formulaFields(doc).filter(field => field.location?.path?.some(path =>
    path.type === "cell" && path.controlIndex === control && path.cellIndex === cell));
  assert.equal(found.length, 1, `expected one formula field at cell ${cell}`);
  return found[0];
};
const visibleCellText = (doc, parent, control, cell) => {
  const length = doc.getCellParagraphLength(0, parent, control, cell, 0);
  return doc.getTextInCell(0, parent, control, cell, 0, 0, length);
};
const validate = (doc, parent, control, row, col, formula) => {
  const value = JSON.parse(doc.validateTableFormulaField(0, parent, control, row, col, formula));
  if (value?.ok === false) { assert.deepEqual(value, { ok: false }); return value; }
  assert.deepEqual(Object.keys(value).sort(), ["changed", "command", "fieldId", "ok", "text"]);
  assert.equal(value.ok, true);
  assert.equal(typeof value.changed, "boolean");
  assert.ok(Number.isSafeInteger(value.fieldId) && value.fieldId > 0);
  assert.equal(value.command, `${formula.trim()}??%g,;;${value.text}`);
  assert.ok(typeof value.text === "string" && value.text.length > 0);
  return value;
};
const insert = (doc, parent, control, row, col, formula, prepared) => {
  const value = JSON.parse(doc.insertTableFormulaField(0, parent, control, row, col, formula));
  assert.deepEqual(value, prepared, "insert result differs from read-only preparation");
  return value;
};
const checkField = (doc, parent, control, cell, result, formula) => {
  const field = fieldAt(doc, control, cell);
  assert.equal(field.fieldType, "formula");
  assert.equal(field.fieldId, result.fieldId);
  assert.equal(field.command, `${formula}??%g,;;${result.text}`);
  assert.equal(field.value, result.text);
  assert.equal(visibleCellText(doc, parent, control, cell), result.text);
  return field;
};
const caseFor = (doc, fmt, name, edit) => {
  const before = saveEvidence(doc, fmt, `${name}-unedited`);
  const work = join(out, `work-${name}`);
  mkdirSync(work);
  const target = join(work, `document.${fmt}`);
  writeNew(target, before.bytes);
  const result = edit();
  const output = saveEvidence(doc, fmt, `${name}-output`);
  const reopened = module.openDocument(output.bytes);
  try {
    const live = snapshot(doc), after = snapshot(reopened);
    return {
      result,
      case: { name, fmt, mode: "save", target, unedited: before.file, uneditedLoss: before.lossPath ?? before.loss,
        output: output.file, outputLoss: output.loss,
        reopen: { formatEqual: after.format === live.format, pagesEqual: after.pages === live.pages,
          textEqual: after.text === live.text, controlsEqual: JSON.stringify(after.controls) === JSON.stringify(live.controls) } },
    };
  } finally { reopened.free(); }
};
const verifyReopen = (doc, bytes, fmt) => {
  const reopened = module.openDocument(bytes);
  try {
    assert.equal(reopened.getSourceFormat(), fmt);
    assert.deepEqual(snapshot(reopened), snapshot(doc));
  } finally { reopened.free(); }
};
if (published) {
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json")));
  assert.equal(manifest.build.generation, build.generation, "publication must be reopened with the generating WASM");
  const results = JSON.parse(readFileSync(join(out, "results.json"))).results;
  const rows = [];
  for (const c of manifest.cases) {
    const result = results.find(r => r.name === c.name);
    assert.ok(result, "missing save result");
    const refusal = c.name.startsWith("fixture-hwp-");
    assert.equal(result.save.ok, !refusal);
    assert.equal(result.sessionAfter.dirty, refusal);
    assert.equal(result.sessionAfter.revision, 1);
    assert.deepEqual(result.dirAfter, [`document.${c.fmt}`]);
    if (refusal) {
      assert.equal(result.targetEqualsOriginal, true);
      assert.deepEqual(readFileSync(c.target), readFileSync(c.unedited));
    } else {
      assert.equal(result.save.durable, true);
      assert.equal(result.targetEqualsOutput, true);
      assert.equal(Object.values(c.reopen).every(Boolean), true);
      // In each same-path chain the second save is now on disk. Reopen every
      // actual published target against the final output for that target.
      const final = manifest.cases.filter(v => v.target === c.target).at(-1);
      const actual = module.openDocument(readFileSync(c.target));
      const expected = module.openDocument(readFileSync(final.output));
      try { assert.deepEqual(snapshot(actual), snapshot(expected)); }
      finally { actual.free(); expected.free(); }
    }
    rows.push({ name: c.name, published: !refusal, originalPreserved: refusal ? true : undefined });
  }
  writeNew(join(out, "published-reopen.json"), JSON.stringify({ status: "PASS", build, rows }, null, 2) + "\n");
  console.log("PASS: actual published files reopened; original bytes retained after refusal");
  process.exit(0);
}
const cases = [], evidence = [], invalidCount = { attempts: 0, refused: 0 };
const fixture = readFileSync(join(root, "external/rhwp/samples/calc-cell.hwp"));
for (const fmt of ["hwp", "hwpx"]) {
  const source = module.openDocument(fixture);
  let normalized;
  try {
    const original = saveEvidence(source, fmt, `fixture-${fmt}-normalized`);
    normalized = module.openDocument(original.bytes);
    assert.equal(normalized.getSourceFormat(), fmt);
    evidence.push({ kind: "fixture-normalization", fmt, source: "Hancom HWP; HWPX is internal engine conversion",
      inputSha256: hash(fixture), normalizedSha256: hash(original.bytes), loss: original.lossReport });
  } finally { source.free(); }
  try {
    assert.equal(JSON.parse(normalized.getTableDimensions(0, 0, 2)).rowCount >= 3, true);
    const targetCell = cellIndex(normalized, 0, 2, 2, 3);
    const originalField = fieldAt(normalized, 2, targetCell);
    const unrelated = formulaFields(normalized).filter(field => field.fieldId !== originalField.fieldId);
    const first = caseFor(normalized, fmt, `fixture-${fmt}-first`, () => {
      const prepared = validate(normalized, 0, 2, 2, 3, "=SUM(A1:D1)");
      assert.equal(prepared.ok, true);
      const result = insert(normalized, 0, 2, 2, 3, "=SUM(A1:D1)", prepared);
      const field = checkField(normalized, 0, 2, targetCell, result, "=SUM(A1:D1)");
      assert.equal(field.fieldId, originalField.fieldId, "replacement must preserve formula field identity");
      assert.deepEqual(formulaFields(normalized).filter(item => item.fieldId !== field.fieldId), unrelated,
        "unrelated formula fields changed");
      return result;
    });
    verifyReopen(normalized, readFileSync(first.case.output), fmt);
    cases.push(first.case);
    const firstDoc = module.openDocument(readFileSync(first.case.output));
    try {
      const second = caseFor(firstDoc, fmt, `fixture-${fmt}-second`, () => {
        const prepared = validate(firstDoc, 0, 2, 2, 3, "=1+2");
        const result = insert(firstDoc, 0, 2, 2, 3, "=1+2", prepared);
        checkField(firstDoc, 0, 2, targetCell, result, "=1+2");
        assert.equal(result.command, "=1+2??%g,;;3");
        assert.equal(result.text, "3");
        return result;
      });
      verifyReopen(firstDoc, readFileSync(second.case.output), fmt);
      const reopenedSecond = module.openDocument(readFileSync(second.case.output));
      try {
        const field = fieldAt(reopenedSecond, 2, targetCell);
        assert.equal(field.command, "=1+2??%g,;;3");
        assert.equal(field.value, "3");
        assert.equal(field.fieldId, first.result.fieldId);
      } finally { reopenedSecond.free(); }
      cases.push(second.case);
      const invalid = ["", "=SUM", "=SUM(", "=SUM(A1,,B1)", "=1+", "=SUM(A1:ZZ999)", "=A0", "=NOPE(A1)",
        "=SUM(1.2.3)", `=${"(".repeat(17)}1${")".repeat(17)}`, `=${"1+".repeat(128)}1`];
      const before = snapshot(firstDoc), stable = exportDoc(firstDoc, fmt).bytes;
      for (const formula of invalid) {
        invalidCount.attempts++;
        assert.deepEqual(validate(firstDoc, 0, 2, 2, 3, formula), { ok: false }, `accepted invalid formula ${formula}`);
        assert.throws(() => firstDoc.insertTableFormulaField(0, 0, 2, 2, 3, formula), `insert accepted invalid formula ${formula}`);
        assert.deepEqual(snapshot(firstDoc), before, `invalid formula changed model ${formula}`);
        assert.deepEqual(exportDoc(firstDoc, fmt).bytes, stable, `invalid formula changed serialized bytes ${formula}`);
        invalidCount.refused++;
      }
    } finally { firstDoc.free(); }
  } finally { normalized.free(); }
}

for (const fmt of ["hwp", "hwpx"]) {
  const created = module.createEmptyDocument();
  try {
    // Same valid template initialization as geul's production New command.
    // Bare createEmpty's HWP header is not a publishable HWP5 document.
    created.createBlankDocument();
    const table = JSON.parse(created.createTable(0, 0, 0, 2, 2));
    assert.equal(table.ok, true);
    const originalControl = table.controlIdx;
    for (const [row, col, text] of [[0, 0, "10"], [0, 1, "20"]]) {
      const cell = cellIndex(created, table.paraIdx, originalControl, row, col);
      assert.equal(JSON.parse(created.insertTextInCell(0, table.paraIdx, originalControl, cell, 0, 0, text)).ok, true);
    }
    const seed = saveEvidence(created, fmt, `created-${fmt}-normalized`);
    const doc = module.openDocument(seed.bytes);
    try {
      const controls = JSON.parse(doc.getControls()).filter(c => c.ctrlId === "tbl");
      assert.equal(controls.length, 1);
      const control = controls[0].controlIndex;
      const a2 = cellIndex(doc, table.paraIdx, control, 1, 0), b2 = cellIndex(doc, table.paraIdx, control, 1, 1);
      const first = caseFor(doc, fmt, `created-${fmt}-first`, () => {
        const prepared = validate(doc, table.paraIdx, control, 1, 1, "=SUM(A1:B1)");
        assert.equal(prepared.ok, true);
        const result = insert(doc, table.paraIdx, control, 1, 1, "=SUM(A1:B1)", prepared);
        checkField(doc, table.paraIdx, control, b2, result, "=SUM(A1:B1)");
        assert.equal(result.text, "30");
        return result;
      });
      verifyReopen(doc, readFileSync(first.case.output), fmt);
      cases.push(first.case);
      const secondDoc = module.openDocument(readFileSync(first.case.output));
      try {
        const second = caseFor(secondDoc, fmt, `created-${fmt}-second`, () => {
          const prepared = validate(secondDoc, table.paraIdx, control, 1, 0, "=A1*2");
          const result = insert(secondDoc, table.paraIdx, control, 1, 0, "=A1*2", prepared);
          checkField(secondDoc, table.paraIdx, control, a2, result, "=A1*2");
          assert.equal(result.text, "20");
          assert.equal(formulaFields(secondDoc).length, 2);
          return result;
        });
        verifyReopen(secondDoc, readFileSync(second.case.output), fmt);
        cases.push(second.case);
        const recalculated = module.openDocument(readFileSync(second.case.output));
        try {
          const snapshotId = recalculated.saveSnapshot();
          const before = formulaFields(recalculated);
          const sourceCell = cellIndex(recalculated, table.paraIdx, control, 0, 0);
          recalculated.deleteTextInCell(0, table.paraIdx, control, sourceCell, 0, 0, 2);
          recalculated.insertTextInCell(0, table.paraIdx, control, sourceCell, 0, 0, '11');
          for (const [row, col, expression, expected] of [[1,1,'=SUM(A1:B1)','31'],[1,0,'=A1*2','22']]) {
            const prepared = validate(recalculated, table.paraIdx, control, row, col, expression);
            const result = insert(recalculated, table.paraIdx, control, row, col, expression, prepared);
            assert.equal(result.text, expected);
          }
          const output = saveEvidence(recalculated, fmt, `created-${fmt}-recalculated`);
          verifyReopen(recalculated, output.bytes, fmt);
          recalculated.restoreSnapshot(snapshotId);
          assert.deepEqual(formulaFields(recalculated), before);
          recalculated.discardSnapshot(snapshotId);
          evidence.push({ kind: 'dependency-edit-explicit-recalculation-and-snapshot', fmt, status: 'PASS' });
        } finally { recalculated.free(); }
      } finally { secondDoc.free(); }
    } finally { doc.free(); }
  } finally { created.free(); }
}

assert.equal(invalidCount.attempts, invalidCount.refused);
writeNew(join(out, "manifest.json"), JSON.stringify({ schemaVersion: 1, build, cases }, null, 2) + "\n");
writeNew(join(out, "summary.json"), JSON.stringify({ status: "PASS", build, cases: cases.length, invalidFormulaAttempts: invalidCount,
  fixtureNormalizations: evidence, notes: ["All exports came from the selected hash-verified WASM generation.",
    "The HWPX fixture began as Hancom HWP and is an internal conversion, not a Hancom-authored HWPX compatibility fixture."] }, null, 2) + "\n");
console.log(JSON.stringify({ status: "PASS", generation: build.generation, cases: cases.length, invalidFormulaAttempts: invalidCount }, null, 2));
