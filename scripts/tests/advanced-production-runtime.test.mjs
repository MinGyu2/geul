import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { compareRequiredTail, inspectRequiredTail, loadRelease } from "./advanced-production-runtime.mjs";

const { engine } = loadRelease();

function fixture(format, { field = true, trailing = true } = {}) {
  const doc = engine.HwpDocument.createEmpty();
  doc.createBlankDocument();
  doc.insertText(0, 0, 0, "Body text");
  doc.splitParagraph(0, 0, 9);
  const table = JSON.parse(doc.createTable(0, 1, 0, 2, 2));
  assert.equal(table.ok, true);
  if (trailing) assert.equal(JSON.parse(doc.splitParagraphInCell(0, table.paraIdx, table.controlIdx, 3, 0, 0)).ok, true);
  if (field) assert.equal(JSON.parse(doc.insertClickHereFieldInCell(0, table.paraIdx, table.controlIdx, 3, 1, 0, false,
    "Independent tail", "", "tail", true)).ok, true);
  const output = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
  const bytes = output.takeBytes();
  output.free(); doc.free();
  return bytes;
}

function withTempDoc(bytes, fn) {
  const dir = mkdtempSync(join(tmpdir(), "geul-t012-verifier-"));
  const path = join(dir, "fixture.hwp");
  writeFileSync(path, bytes);
  const doc = new engine.HwpDocument(bytes);
  try { return fn(doc, path); } finally { doc.free(); rmSync(dir, { recursive: true }); }
}

function altered(doc, method, transform) {
  return new Proxy(doc, { get(target, key) {
    if (key === method) return (...args) => JSON.stringify(transform(JSON.parse(target[method](...args))));
    const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
  } });
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtime = join(root, "scripts/tests/advanced-production-runtime.mjs");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function cli(...args) {
  return spawnSync(process.execPath, [runtime, ...args], { cwd: root, encoding: "utf8" });
}

function geometryFixture(dir, complex, format = "hwp") {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `created-${format}-normalized.${format}`);
  writeFileSync(path, fixture(format, complex ? {} : { field: false, trailing: false }));
  return { format, path, sha256: digest(readFileSync(path)) };
}

function fixtureManifest(dir, complex, outputs) {
  writeFileSync(join(dir, "fixtures.json"), JSON.stringify({ build: JSON.parse(readFileSync(join(root, "public/rhwp/RELEASE.json"))), complex, outputs }));
}

test("real Release HWP and HWPX fixtures reopen with the required owned trailing field", () => {
  for (const format of ["hwp", "hwpx"]) withTempDoc(fixture(format), doc => {
    assert.equal(doc.getSourceFormat(), format);
    const tail = inspectRequiredTail(doc);
    assert.equal(tail.paragraphCount, 2);
    assert.equal(tail.fields[0].fieldType, "clickhere");
    assert.deepEqual(tail.fields[0].location.path, [{ type: "cell", controlIndex: 0, cellIndex: 3, paraIndex: 1 }]);
  });
});

test("real source evidence rejects a missing field, missing paragraph, and failed operations", () => {
  withTempDoc(fixture("hwp", { field: false }), doc => assert.throws(() => inspectRequiredTail(doc), /paragraph|field/i));
  withTempDoc(fixture("hwpx", { trailing: false, field: false }), doc => assert.throws(() => inspectRequiredTail(doc), /paragraph/i));
  const doc = engine.HwpDocument.createEmpty();
  try {
    doc.createBlankDocument();
    for (const operation of [
      () => JSON.parse(doc.splitParagraphInCell(0, 900, 900, 99, 99, 0)),
      () => JSON.parse(doc.insertClickHereFieldInCell(0, 900, 900, 99, 99, 0, false, "Independent tail", "", "tail", true)),
    ]) {
      let rejected = false;
      try { rejected = operation().ok !== true; } catch { rejected = true; }
      assert.equal(rejected, true, "invalid operation unexpectedly succeeded");
    }
  } finally { doc.free(); }
});

test("malformed real field inventories are rejected", () => {
  withTempDoc(fixture("hwp"), doc => {
    const defects = [
      field => { field.listId += 100; },
      field => { field.location.path[0].paraIndex = 0; },
      field => { field.startCharIdx = 1; },
      field => { field.location.path.push({ type: "nested" }); },
    ];
    for (const mutate of defects) assert.throws(() => inspectRequiredTail(altered(doc, "getFieldList", rows => {
      mutate(rows.find(field => field.fieldType === "clickhere")); return rows;
    })));
    assert.throws(() => inspectRequiredTail(altered(doc, "getFieldList", rows => [...rows, ...rows])));
  });
});

test("field IDs must be unique across the complete field inventory", () => {
  withTempDoc(fixture("hwp"), doc => {
    const original = JSON.parse(doc.getFieldList());
    const target = original.find(field => field.fieldType === "clickhere");
    const collision = rows => { rows.push({ ...target, fieldType: "formula", fieldId: target.fieldId }); };
    const duplicateFormulas = rows => {
      rows.push({ ...target, fieldType: "formula", fieldId: target.fieldId + 10 });
      rows.push({ ...target, fieldType: "formula", fieldId: target.fieldId + 10 });
    };
    const duplicateTarget = rows => { rows.push({ ...target }); };
    assert.throws(() => inspectRequiredTail(altered(doc, "getFieldList", rows => { duplicateTarget(rows); return rows; })), /duplicate field identity/);
    assert.throws(() => inspectRequiredTail(altered(doc, "getFieldList", rows => { collision(rows); return rows; })), /duplicate field identity/);
    assert.throws(() => inspectRequiredTail(altered(doc, "getFieldList", rows => { duplicateFormulas(rows); return rows; })), /duplicate field identity/);
    const distinct = [...original, { ...target, fieldType: "formula", fieldId: target.fieldId + 20 }];
    assert.doesNotThrow(() => inspectRequiredTail(altered(doc, "getFieldList", () => distinct)));
  });
});

test("field control metadata must match the real Release representation", () => {
  withTempDoc(fixture("hwpx"), doc => {
    assert.doesNotThrow(() => inspectRequiredTail(doc));
    for (const mutate of [
      row => { row.userDesc = "unexpected"; },
      row => { row.props = { unsupported: true }; },
      row => { row.props = null; },
      row => { row.props = []; },
      row => { delete row.props; },
    ]) assert.throws(() => inspectRequiredTail(altered(doc, "getControls", rows => {
      const target = rows.find(row => row.list === JSON.parse(doc.getFieldList()).find(field => field.fieldType === "clickhere").listId && row.para === JSON.parse(doc.getFieldList()).find(field => field.fieldType === "clickhere").paraInList);
      assert.ok(target, "real target control exists");
      mutate(target);
      return rows;
    })), /control owner/);
    assert.throws(() => inspectRequiredTail(altered(doc, "getControls", rows => {
      const target = rows.find(row => row.list === JSON.parse(doc.getFieldList()).find(field => field.fieldType === "clickhere").listId && row.para === JSON.parse(doc.getFieldList()).find(field => field.fieldType === "clickhere").paraInList);
      rows.push({ ...target });
      return rows;
    })), /control owner/);
  });
});

test("ordinary and complex fixture provenance selects strict geometry requirements", () => {
  const dir = mkdtempSync(join(tmpdir(), "geul-t012-geometry-"));
  try {
    const ordinary = [geometryFixture(dir, false, "hwp"), geometryFixture(dir, false, "hwpx")];
    fixtureManifest(dir, false, ordinary.map(({ format, path, sha256 }) => ({ format, source: path, sha256 })));
    let result = cli("geometry", join(dir, "ordinary.json"), dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, "ordinary.json"))).complex, false);

    const complexDir = join(dir, "complex");
    let prepared = cli("fixtures-complex", complexDir);
    assert.equal(prepared.status, 0, prepared.stderr);
    result = cli("geometry", join(dir, "complex.json"), complexDir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, "complex.json"))).complex, true);

    const badDir = join(dir, "bad-complex");
    const bad = geometryFixture(badDir, false, "hwp");
    const hwpx = geometryFixture(badDir, false, "hwpx");
    fixtureManifest(badDir, true, [bad, hwpx].map(({ format, path, sha256 }) => ({ format, source: path, sha256 })));
    result = cli("geometry", join(dir, "missing-field.json"), badDir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required trailing paragraph/);

    const noFieldDir = join(dir, "complex-no-field");
    const n0 = geometryFixture(noFieldDir, false, "hwp");
    const n1 = geometryFixture(noFieldDir, false, "hwpx");
    writeFileSync(n0.path, fixture("hwp", { field: false, trailing: true }));
    writeFileSync(n1.path, fixture("hwpx", { field: false, trailing: true }));
    const noFieldRows = [n0, n1].map(({ format, path }) => ({ format, source: path, sha256: digest(readFileSync(path)) }));
    fixtureManifest(noFieldDir, true, noFieldRows);
    result = cli("geometry", join(dir, "missing-field.json"), noFieldDir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required ClickHere field/);

    const contradictedDir = join(dir, "contradicted");
    const c0 = geometryFixture(contradictedDir, true, "hwp");
    const c1 = geometryFixture(contradictedDir, true, "hwpx");
    fixtureManifest(contradictedDir, false, [c0, c1].map(({ format, path, sha256 }) => ({ format, source: path, sha256 })));
    result = cli("geometry", join(dir, "contradiction.json"), contradictedDir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ordinary fixture contradicts declared mode/);

    const malformedDir = join(dir, "malformed-manifest");
    const m0 = geometryFixture(malformedDir, true, "hwp");
    const m1 = geometryFixture(malformedDir, true, "hwpx");
    fixtureManifest(malformedDir, "complex", [m0, m1].map(({ format, path, sha256 }) => ({ format, source: path, sha256 })));
    result = cli("geometry", join(dir, "malformed.json"), malformedDir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fixture mode/);
    fixtureManifest(malformedDir, true, [m0, m1].map(({ format, path, sha256 }) => ({ format, source: path, sha256: `${sha256}bad` })));
    result = cli("geometry", join(dir, "hash-mismatch.json"), malformedDir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /identity mismatch/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("saved evidence rejects absent or altered fields, including equally empty inventories", () => {
  withTempDoc(fixture("hwp"), doc => {
    const source = inspectRequiredTail(doc);
    assert.throws(() => compareRequiredTail(source, { ...source, fields: [] }));
    assert.throws(() => compareRequiredTail(source, { ...source, paragraphs: ["altered"] }));
    assert.throws(() => compareRequiredTail({ paragraphs: [""], fields: [] }, { paragraphs: [""], fields: [] }));
    assert.doesNotThrow(() => compareRequiredTail(source, structuredClone(source)));
  });
});
