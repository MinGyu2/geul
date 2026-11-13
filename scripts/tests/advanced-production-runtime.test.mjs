import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("saved evidence rejects absent or altered fields, including equally empty inventories", () => {
  withTempDoc(fixture("hwp"), doc => {
    const source = inspectRequiredTail(doc);
    assert.throws(() => compareRequiredTail(source, { ...source, fields: [] }));
    assert.throws(() => compareRequiredTail(source, { ...source, paragraphs: ["altered"] }));
    assert.throws(() => compareRequiredTail({ paragraphs: [""], fields: [] }, { paragraphs: [""], fields: [] }));
    assert.doesNotThrow(() => compareRequiredTail(source, structuredClone(source)));
  });
});
