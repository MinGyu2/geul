// Binary API/geometry check. Native Canvas RGBA acceptance is a separate check.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';

const { values } = parseArgs({ options: Object.fromEntries(
  ['before', 'after', 'sample', 'output'].map(name => [name, { type: 'string' }]),
) });
for (const name of ['before', 'after', 'sample', 'output']) assert.ok(values[name], '--' + name + ' required');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = readFileSync(values.sample);
async function open(folder) {
  const base = resolve(folder), wasm = readFileSync(base + '/rhwp_bg.wasm');
  const mod = await import(pathToFileURL(base + '/rhwp.js').href);
  mod.initSync({ module: wasm });
  return { doc: new mod.HwpDocument(bytes), wasmSha256: sha(wasm) };
}
function query(doc, para) {
  try { return { status: 'PASS', rect: JSON.parse(doc.getCursorRect(0, para, 0)) }; }
  catch (error) { return { status: 'FAIL', error: String(error) }; }
}
function paintTree(node) {
  const { children, ...own } = node;
  return { ...own, children: (children || []).filter(child =>
    child.type !== 'TextLine' || child.children?.length,
  ).map(paintTree) };
}
const before = await open(values.before), after = await open(values.after);
const result = {
  status: 'RUNNING', scope: 'Node WASM/no browser font provider; API and render-tree geometry, not raster acceptance',
  fixtureSha256: sha(bytes), sourceSha256: sha(readFileSync(new URL(import.meta.url))),
  beforeWasmSha256: before.wasmSha256, afterWasmSha256: after.wasmSha256, rows: [],
};
try {
  assert.equal(before.doc.pageCount(), 24); assert.equal(after.doc.pageCount(), 24);
  for (let para = 0; para < 24; para++) {
    assert.equal(after.doc.getParagraphLength(0, para), 0);
    const previous = query(before.doc, para), current = query(after.doc, para);
    const oldTree = JSON.parse(before.doc.getPageRenderTree(para));
    const newTree = JSON.parse(after.doc.getPageRenderTree(para));
    const row = { paragraph: para, before: previous, after: current };
    result.rows.push(row);
    assert.equal(current.status, 'PASS', 'original paragraph ' + para);
    assert.deepEqual(paintTree(newTree), paintTree(oldTree), 'paint geometry paragraph ' + para);
    if (previous.status === 'PASS') assert.deepEqual(current.rect, previous.rect, 'existing object caret');
    else {
      assert.equal(current.rect.pageIndex, para);
      for (const [key, expected] of [['x', 37.8], ['y', 37.8], ['height', 13.3]])
        assert.ok(Math.abs(current.rect[key] - expected) <= 0.15, key + ' original stored line');
    }
    row.paintGeometryUnchanged = true;
  }
  const repaired = result.rows.filter(row => row.before.status === 'FAIL').length;
  assert.equal(repaired, 21, 'independent original fixture failure inventory');
  result.repaired = repaired; result.existingUnchanged = 3; result.status = 'PASS';
} catch (error) {
  result.status = 'FAIL'; result.error = String(error); process.exitCode = 1;
} finally {
  before.doc.free(); after.doc.free();
  writeFileSync(values.output, JSON.stringify(result, null, 2) + '\n');
}
console.log(result.status, 'repaired', result.repaired, 'unchanged', result.existingUnchanged);
