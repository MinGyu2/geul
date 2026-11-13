#!/usr/bin/env node
// Independent Release-WASM oracle for files published by native-t012-phase2.py.
//   node scripts/tests/t012-phase2-native-oracle.mjs NATIVE_OUT GEOMETRY_JSON
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRelease } from "./advanced-production-runtime.mjs";

const [out, geometryPath] = process.argv.slice(2);
if (!out || !geometryPath) throw new Error("usage: t012-phase2-native-oracle.mjs NATIVE_OUT GEOMETRY_JSON");
const geometry = JSON.parse(readFileSync(geometryPath, "utf8"));
const { build, engine } = loadRelease(geometry.build);
const sha = b => createHash("sha256").update(b).digest("hex");
const need = (ok, message) => { if (!ok) throw new Error(message); };
const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
need(result.status === "PASS", "native run did not pass");

/** Every cell list of the document, keyed by its explicit path (never by list number). */
function cells(d) {
  const lists = JSON.parse(d.getCursorModel()).lists, byId = new Map(lists.map(l => [l.listId, l]));
  const out = {};
  for (const l of lists) {
    if (!l.isCell) continue;
    const chain = [];
    for (let at = l; at; at = at.hostListId ? byId.get(at.hostListId) : null) { if (!at.isCell) { chain.length = 0; break; } chain.unshift(at); if (at.hostListId === 0) break; }
    if (!chain.length || chain[0].hostListId !== 0) continue;
    const levels = chain.map((c, i) => ({ controlIndex: c.controlIndex, cellIndex: c.cellIndex, cellParaIndex: i + 1 < chain.length ? chain[i + 1].hostPara : 0 }));
    const path = p => JSON.stringify(levels.map((x, i) => (i + 1 < levels.length ? x : { ...x, cellParaIndex: p })));
    const host = chain[0].hostPara, n = d.getCellParagraphCountByPath(0, host, path(0));
    const paragraphs = Array.from({ length: n }, (_, p) => d.getTextInCellByPath(0, host, path(p), 0, d.getCellParagraphLengthByPath(0, host, path(p))));
    const info = JSON.parse(d.getCellInfoByPath(0, host, path(0)));
    out[`${host}:${levels.map(x => `${x.controlIndex}.${x.cellIndex}.${x.cellParaIndex}`).join(">")}`] = { ...info, paragraphs };
  }
  return out;
}
const rows = [];
for (const row of geometry.fixtures) {
  const fmt = row.format;
  const savedOf = name => result.saved.find(s => s.format === fmt && s.name === name);
  // nested
  const nested = savedOf("nested-save");
  const bytes = readFileSync(nested.path);
  need(sha(bytes) === nested.sha256, `${fmt} nested saved copy changed`);
  const before = new engine.HwpDocument(readFileSync(row.nested.source)), after = new engine.HwpDocument(bytes);
  const a = cells(before), b = cells(after);
  need(after.getSourceFormat() === fmt, `${fmt} reopened format`);
  const key = row.nested.caretSuffix.slice(1).split(">").map(x => x.split("/").join(".")).join(">").replace(/\.\d+$/, ".0");
  const target = Object.keys(a).filter(k => k.endsWith(":" + key) || k.split(":")[1] === key);
  need(target.length === 1, `${fmt} nested target key ${key} not unique`);
  need(JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort()), `${fmt} cell inventory changed`);
  const changed = Object.keys(a).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  need(changed.length === 1 && changed[0] === target[0], `${fmt} changed cells ${changed}`);
  need(b[target[0]].paragraphs.join("|") === `N1한${row.nested.text}`, `${fmt} nested text ${b[target[0]].paragraphs}`);
  need(before.getControls() === after.getControls(), `${fmt} control inventory changed`);
  need(before.getTextFileText().replace(row.nested.text, `N1한${row.nested.text}`) === after.getTextFileText(), `${fmt} flat text differs beyond the nested edit`);
  before.free(); after.free();
  // table
  const table = savedOf("table-save");
  const tb = readFileSync(table.path);
  need(sha(tb) === table.sha256, `${fmt} table saved copy changed`);
  const t = new engine.HwpDocument(tb), c = cells(t);
  const grid = Object.values(c).map(x => `${x.row},${x.col} ${x.rowSpan}x${x.colSpan} ${x.paragraphs.join("|")}`);
  const expected = ["0,0 1x1 c0", "0,1 1x1 c1", "0,2 1x1 c2", "1,0 1x1 c3", "1,1 1x2 c4M|c5", "2,0 1x1 ", "2,1 1x1 ", "2,2 1x1 ", "3,0 1x1 c6", "3,1 1x1 c7", "3,2 1x1 c8"];
  need(JSON.stringify(grid) === JSON.stringify(expected), `${fmt} table grid ${JSON.stringify(grid)}`);
  need(t.getTextRange(0, 0, 0, 4) === "Body", `${fmt} body text`);
  t.free();
  rows.push({ format: fmt, nested: { sha256: nested.sha256, changedCells: changed, text: `N1한${row.nested.text}` }, table: { sha256: table.sha256, grid } });
}
writeFileSync(join(out, "oracle.json"), JSON.stringify({ status: "PASS", engineGeneration: build.generation, rows }, null, 2) + "\n");
console.log("PASS", JSON.stringify(rows.map(r => [r.format, r.nested.changedCells, r.table.grid[4]])));
