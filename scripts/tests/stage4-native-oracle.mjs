#!/usr/bin/env node
// Independent Release-WASM (+ HWP T009 save_check) oracle for files published by native-stage4.py.
//   node scripts/tests/stage4-native-oracle.mjs GEOMETRY_JSON NATIVE_OUT [NATIVE_OUT...]
// Every published copy is reopened from its actual bytes and compared with the expected model derived from the
// fixture (cell texts, nested cells, table geometry, formula field IDs/commands/caches/ranges, inline picture
// instance and BinData digest, character format, unchanged fixture bytes). HWP copies are also judged by the
// independent T009 checker against the original fixture.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRelease } from "./advanced-production-runtime.mjs";

const [geometryPath, ...outs] = process.argv.slice(2);
if (!geometryPath || !outs.length) throw new Error("usage: stage4-native-oracle.mjs GEOMETRY_JSON NATIVE_OUT [NATIVE_OUT...]");
const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const CHECKER = join(ROOT, "src-tauri/target/debug/examples/save_check");
const geometry = JSON.parse(readFileSync(geometryPath, "utf8"));
const { build, engine } = loadRelease(geometry.build);
const sha = b => createHash("sha256").update(b).digest("hex");
const need = (ok, message) => { if (!ok) throw new Error(message); };
const PNG_SHA = "b27055105808701195fb56d4afb1c14135b04b065593d2107ac150779344240a";
const path1 = (control, cell) => JSON.stringify([{ controlIndex: control, cellIndex: cell, cellParaIndex: 0 }]);

function model(bytes, format) {
  const d = new engine.HwpDocument(bytes);
  try {
    need(d.getSourceFormat() === format, `reopened format ${d.getSourceFormat()} != ${format}`);
    const t = JSON.parse(d.getControls()).find(c => c.ctrlId === "tbl" && c.list === 0);
    const dims = JSON.parse(d.getTableDimensionsByPath(0, t.para, path1(t.controlIndex, 0)));
    const cells = [];
    for (let i = 0; i < dims.cellCount; i++) {
      const p = path1(t.controlIndex, i), n = d.getCellParagraphCountByPath(0, t.para, p);
      const paragraphs = Array.from({ length: n }, (_, k) => {
        const q = JSON.stringify([{ controlIndex: t.controlIndex, cellIndex: i, cellParaIndex: k }]);
        return d.getTextInCellByPath(0, t.para, q, 0, d.getCellParagraphLengthByPath(0, t.para, q));
      });
      const info = JSON.parse(d.getCellInfoByPath(0, t.para, p));
      cells.push({ row: info.row, col: info.col, rowSpan: info.rowSpan, colSpan: info.colSpan, text: paragraphs.join("|") });
    }
    const nested = {};
    for (const l of JSON.parse(d.getCursorModel()).lists) {
      if (!l.isCell || l.hostListId === 0) continue;
      const host = JSON.parse(d.getCursorModel()).lists.find(h => h.listId === l.hostListId);
      if (!host?.isCell || host.hostListId !== 0) continue;
      const q = JSON.stringify([{ controlIndex: host.controlIndex, cellIndex: host.cellIndex, cellParaIndex: l.hostPara }, { controlIndex: l.controlIndex, cellIndex: l.cellIndex, cellParaIndex: 0 }]);
      nested[`${host.cellIndex}>${l.cellIndex}`] = d.getTextInCellByPath(0, host.hostPara, q, 0, d.getCellParagraphLengthByPath(0, host.hostPara, q));
    }
    const fields = JSON.parse(d.getFieldList()).filter(f => f.fieldType === "formula")
      .map(f => ({ fieldId: f.fieldId, command: f.command, value: f.value, cell: f.location.path.at(-1).cellIndex, para: f.location.path.at(-1).paraIndex, start: f.startCharIdx, end: f.endCharIdx }))
      .sort((a, b) => a.fieldId - b.fieldId);
    const pictures = [];
    for (let i = 0; i < dims.cellCount; i++) {
      try { const p = JSON.parse(d.getCellPictureByPath(0, t.para, path1(t.controlIndex, i), 0)); if (p.ok) pictures.push({ cell: i, instanceId: p.instanceId, binDataId: p.binDataId, sha256: p.sha256, byteLength: p.byteLength, position: p.position, treatAsChar: p.treatAsChar }); } catch { /* no picture */ }
    }
    const bolds = Array.from({ length: dims.cellCount }, (_, cell) => Array.from({ length: d.getCellParagraphLengthByPath(0, t.para, path1(t.controlIndex, cell)) },
      (_, o) => JSON.parse(d.getCellCharPropertiesAtByPath(0, t.para, path1(t.controlIndex, cell), o)).bold));
    const bold = cell => bolds[cell];
    const controls = JSON.parse(d.getControls()).map(c => c.ctrlId).sort().join(",");
    return { body: d.getTextRange(0, 0, 0, 4), dims, cells, nested, fields, pictures, bold, controls, flat: d.getTextFileText() };
  } finally { d.free(); }
}

function t009(format, original, published, name, out) {
  if (format !== "hwp") return null;
  // The publisher's loss report is not stored with the file: use the Release engine's own report for the
  // published bytes and require it to declare no content loss.
  const d = new engine.HwpDocument(readFileSync(published));
  let loss;
  try { const e = d.exportHwpWithReport(); try { loss = e.contentLoss(); } finally { e.free(); } } finally { d.free(); }
  const parsed = JSON.parse(loss);
  need((parsed.count ?? parsed.losses?.length ?? -1) === 0, `${name}.hwp published-file loss report ${loss}`);
  const lossPath = join(out, `${name}.loss.json`);
  writeFileSync(lossPath, loss);
  const raw = execFileSync(CHECKER, ["saved", "hwp", original, published, lossPath, "true"], { encoding: "utf8" });
  const result = JSON.parse(raw);
  writeFileSync(join(out, `${name}.t009.json`), raw);
  // The save service accepts a changed PrvImage only as the exact PNG it encoded for that save from the
  // page-1 render (hwp::refresh_previews); an offline check cannot reproduce that encoding. Every other part
  // must be judged safe, and the regenerated preview must be a PNG.
  const previewOnly = result.findings.length === 1 && result.findings[0].code === "partChanged" && result.findings[0].part === "PrvImage";
  if (previewOnly) {
    const head = execFileSync("python3", ["-I", "-c", `import importlib.util,sys
s=importlib.util.spec_from_file_location('d',sys.argv[1]);d=importlib.util.module_from_spec(s);s.loader.exec_module(d)
print(d.cfb_streams(open(sys.argv[2],'rb').read())['PrvImage'][:8].hex())`, join(ROOT, "scripts/tests/hwp_record_diff.py"), published], { encoding: "utf8" }).trim();
    need(head === "89504e470d0a1a0a", `${name}.hwp regenerated PrvImage is not a PNG (${head})`);
  }
  need((result.outcome === "safe" && result.findings.length === 0) || previewOnly, `${name}.hwp independent T009 ${raw}`);
  return { original, outcome: result.outcome, findings: result.findings, bodySafe: true, regeneratedPreviewPng: previewOnly };
}

const rows = [];
for (const out of outs) {
  const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  need(result.status === "PASS", `${out}: native run did not pass`);
  for (const saved of result.saved) {
    const row = geometry.fixtures.find(r => r.format === saved.format), fmt = saved.format;
    const bytes = readFileSync(saved.path);
    need(sha(bytes) === saved.sha256, `${saved.path} changed after the native run`);
    const isStale = saved.name.startsWith("stale");
    const fixture = isStale ? row.stale : row.compound;
    const original = readFileSync(fixture.source);
    need(sha(original) === fixture.sha256, `${fmt} fixture bytes changed`);
    const before = model(original, fmt), after = model(bytes, fmt);
    need(after.body === "Body", `${saved.name}.${fmt} body ${after.body}`);
    need(after.controls === before.controls, `${saved.name}.${fmt} control inventory ${after.controls} != ${before.controls}`);
    const check = { format: fmt, name: saved.name, sha256: saved.sha256, path: saved.path };
    if (isStale) {
      need(JSON.stringify(after.cells.map(c => c.text)) === JSON.stringify(["11", "22"]), `${fmt} stale cells ${JSON.stringify(after.cells)}`);
      need(after.fields.length === 1 && after.fields[0].fieldId === before.fields[0].fieldId
        && after.fields[0].command === "=A1*2??%g,;;22" && after.fields[0].value === "22" && after.fields[0].cell === 1, `${fmt} stale field ${JSON.stringify(after.fields)}`);
      check.fields = after.fields;
    } else {
      const inserted = saved.name !== "undo-save";
      // Undo state: the 3×3 table with every cell edit; Redo state: the same plus an empty row after row 0.
      const texts = ["10", "20", "서식대상", "합 30 배 50 끝", "그림P", "중첩", "본문입력!", "", ""];
      const expected = inserted ? [...texts.slice(0, 3), "", "", "", ...texts.slice(3)] : texts;
      const shift = inserted ? 3 : 0;
      need(after.dims.rowCount === (inserted ? 4 : 3) && after.dims.colCount === 3, `${saved.name}.${fmt} dims ${JSON.stringify(after.dims)}`);
      need(JSON.stringify(after.cells.map(c => c.text)) === JSON.stringify(expected), `${saved.name}.${fmt} cells ${JSON.stringify(after.cells.map(c => c.text))}`);
      need(after.cells.every((c, i) => c.row === Math.floor(i / 3) && c.col === i % 3 && c.rowSpan === 1 && c.colSpan === 1), `${saved.name}.${fmt} geometry ${JSON.stringify(after.cells)}`);
      need(JSON.stringify(after.nested) === JSON.stringify({ [`${5 + shift}>0`]: "내부0", [`${5 + shift}>1`]: "내부1" }), `${saved.name}.${fmt} nested ${JSON.stringify(after.nested)}`);
      // Fields: same IDs; the first is untouched, the second was replaced through the product dialog.
      const [f1, f2] = [before.fields.find(f => f.command.startsWith("=A1+B1")), before.fields.find(f => f.command.startsWith("=B1*2"))];
      const a1 = after.fields.find(f => f.fieldId === f1.fieldId), a2 = after.fields.find(f => f.fieldId === f2.fieldId);
      need(after.fields.length === 2 && a1 && a2, `${saved.name}.${fmt} field IDs ${JSON.stringify(after.fields)}`);
      need(a1.command === f1.command && a1.value === "30" && a1.cell === 3 + shift && a1.para === 0 && a1.start === f1.start && a1.end === f1.end, `${saved.name}.${fmt} first field ${JSON.stringify(a1)}`);
      need(a2.command === "=A1*5??%g,;;50" && a2.value === "50" && a2.cell === 3 + shift && a2.para === 0 && a2.start === f2.start && a2.end === f2.end, `${saved.name}.${fmt} second field ${JSON.stringify(a2)}`);
      // Picture: same instance and BinData, still at logical position 2 of its cell, now followed by "P".
      const [p0] = before.pictures;
      need(before.pictures.length === 1 && p0.sha256 === PNG_SHA, `${fmt} fixture picture ${JSON.stringify(before.pictures)}`);
      need(after.pictures.length === 1 && JSON.stringify({ ...after.pictures[0], cell: 0 }) === JSON.stringify({ ...p0, cell: 0 }) && after.pictures[0].cell === 4 + shift,
        `${saved.name}.${fmt} picture ${JSON.stringify(after.pictures)} vs ${JSON.stringify(p0)}`);
      // Character format: C1 bold in full, fixture was not bold; the Korean IME cell is not bold.
      need(before.bold(2).every(b => b === false) && after.bold(2).length === 4 && after.bold(2).every(b => b === true), `${saved.name}.${fmt} C1 bold ${after.bold(2)}`);
      need(after.bold(6 + shift).every(b => b === false), `${saved.name}.${fmt} IME cell format`);
      need(!after.flat.includes("입력입력") && (after.flat.match(/입력/g) ?? []).length === 1 && !after.flat.includes("Z"), `${saved.name}.${fmt} Korean/refused text ${after.flat}`);
      Object.assign(check, { dims: after.dims, fields: after.fields, picture: after.pictures[0] });
    }
    // T009 judges a publication against the file it replaced: the fixture, or this run's earlier publication.
    const predecessor = result.saved.slice(0, result.saved.indexOf(saved)).filter(p => p.format === fmt && p.name.startsWith("stale") === isStale).at(-1);
    check.t009 = t009(fmt, predecessor?.path ?? fixture.source, saved.path, `${saved.name}`, out);
    rows.push(check);
  }
}
writeFileSync(join(outs.at(-1), "oracle.json"), JSON.stringify({ status: "PASS", engineGeneration: build.generation, checker: sha(readFileSync(CHECKER)), outs, rows }, null, 2) + "\n");
console.log("PASS", rows.length, JSON.stringify(rows.map(r => [r.format, r.name, r.t009 ? (r.t009.regeneratedPreviewPng ? "body-safe+regenerated-PrvImage" : r.t009.outcome) : "hwpx-reopen"])));
