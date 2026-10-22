#!/usr/bin/env node
// T010 Phase 2 선행 PoC B1(시험 전용): 고정 rhwp `saveSnapshot`(native `save_snapshot_native`)은 복제 전에
// `flush_cell_format_vpos`(표 셀 글자 서식이 미뤄 둔 줄 위치 사다리 반영)를 부른다. 스냅숏 찍기가 편집 없이 관찰 가능한 문서
// 상태(본문·셀 구조·서식·줄 위치·내보내기 바이트·T009 판정)를 바꾸는지 실제 WASM으로 본다.
//
//   node tests/poc/t010-phase0/snapshot_side_effects.mjs [--out 결과.json]
//
// 셀 상태: 표 첫 셀을 두 문단으로 나누고 첫 문단 앞 글자에 큰 글자 크기(2400)를 걸어 미뤄 둔 줄 위치 갱신을 만든다(배치 모드에서는
// endBatch까지 미뤄짐). 비교는 같은 편집을 한 별도 문서(스냅숏 없음)와 하고, 내보내기 자체의 정규화는 "두 번 내보내기"로 따로 잰다.
// T009 판정은 실제 `save_check`(services::save::service::check_saved). 실패가 있으면 종료 코드 1.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const rhwp = await import(pathToFileURL(join(root, "public/rhwp/rhwp.js")).href);
rhwp.initSync({ module: readFileSync(join(root, "public/rhwp/rhwp_bg.wasm")) });
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "geul-t010-b1-"));
execFileSync("node", [join(root, "tests/fixtures/rhwp/generate.mjs"), scratch]);
execFileSync("cargo", ["build", "--quiet", "--locked", "--manifest-path", join(root, "src-tauri/Cargo.toml"), "--example", "save_check"]);
const saveCheck = join(root, "src-tauri/target/debug/examples/save_check");
const T = { sec: 0, para: 2, control: 0, cell: 0 };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const results = [];
const record = (name, status, detail) => {
  results.push({ name, status, detail });
  console.log(`[${status}] ${name} ${JSON.stringify(detail).slice(0, 260)}`);
};

/** 셀 첫 문단 둘로 나누고 글을 넣은 뒤 첫 문단 앞 3글자를 크게: 셀 문단에 cell_format_vpos_dirty·pending을 남기는 경로. */
function cellFormatting(doc) {
  doc.insertTextInCell(T.sec, T.para, T.control, T.cell, 0, 0, "가나다라마바사 ");
  doc.splitParagraphInCell(T.sec, T.para, T.control, T.cell, 0, 4); // 세션 rhwpText.split과 같은 호출(메타 인자 없음)
  doc.insertTextInCell(T.sec, T.para, T.control, T.cell, 1, 0, "둘째 줄 ");
  doc.applyCharFormatInCell(T.sec, T.para, T.control, T.cell, 0, 0, 3, JSON.stringify({ fontSize: 2400 }));
}

/** 관찰 가능한 상태: 본문 글·컨트롤·쪽 수·셀 문단(글·길이·서식·줄 정보 — 줄 정보에 세로 위치가 있다)·본문 문단 런. */
function capture(doc) {
  const cell = [];
  const count = doc.getCellParagraphCount(T.sec, T.para, T.control, T.cell);
  for (let p = 0; p < count; p++) {
    const len = doc.getCellParagraphLength(T.sec, T.para, T.control, T.cell, p);
    const lines = [];
    for (let o = 0; o <= len; o++) lines.push(doc.getLineInfoInCell(T.sec, T.para, T.control, T.cell, p, o));
    // 커서 사각형(쪽 좌표 y·높이)은 줄 위치(vpos 사다리)를 드러낸다 — getLineInfoInCell은 세로 위치를 주지 않는다.
    const rect = doc.getCursorRectInCell(T.sec, T.para, T.control, T.cell, p, 0);
    cell.push({ len, text: doc.getTextInCell(T.sec, T.para, T.control, T.cell, p, 0, len), props: doc.getCellCharPropertiesAt(T.sec, T.para, T.control, T.cell, p, 0), lines, rect });
  }
  const runs = [];
  for (let p = 0; p < doc.getParagraphCount(0); p++) {
    const len = doc.getParagraphLength(0, p);
    runs.push(len ? doc.getCharShapeRuns(0, p, 0, len) : "[]");
  }
  return { text: doc.getTextFileText(), controls: doc.getControls(), pages: doc.pageCount(), cell, runs, cursor: doc.getCursorRectInCell(T.sec, T.para, T.control, T.cell, 1, 2) };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function exportDoc(doc, fmt) {
  const e = fmt === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
  try { return { bytes: e.takeBytes(), loss: e.contentLoss() }; } finally { e.free(); }
}

/** 실제 T009 저장 판정(원본 픽스처 대 출력): 근거 코드만. */
function verdict(fmt, original, exported, name) {
  const out = join(scratch, `${name}.${fmt}`);
  writeFileSync(out, exported.bytes);
  writeFileSync(`${out}.loss.json`, exported.loss);
  let stdout;
  try {
    stdout = execFileSync(saveCheck, ["saved", fmt, original, out, `${out}.loss.json`, "true"]).toString();
  } catch (error) {
    stdout = error.stdout.toString(); // 판정이 safe가 아니면 1
  }
  const v = JSON.parse(stdout);
  return { outcome: v.outcome, findings: v.findings.map((f) => `${f.code}:${f.part ?? ""}`) };
}

for (const fmt of ["hwp", "hwpx"]) {
  const original = join(scratch, `basic-ko.${fmt}`);
  const src = readFileSync(original);
  // 0) 의미 있는 상태인지: 큰 글자 서식이 셀 줄 정보(세로 위치·높이)를 실제로 바꾸는가(서식 없는 같은 편집과 비교).
  const plain = new rhwp.HwpDocument(src);
  plain.insertTextInCell(T.sec, T.para, T.control, T.cell, 0, 0, "가나다라마바사 ");
  plain.splitParagraphInCell(T.sec, T.para, T.control, T.cell, 0, 4);
  plain.insertTextInCell(T.sec, T.para, T.control, T.cell, 1, 0, "둘째 줄 ");
  const formatted = new rhwp.HwpDocument(src);
  cellFormatting(formatted);
  const plainLines = capture(plain).cell.map((p) => p.rect);
  const formattedLines = capture(formatted).cell.map((p) => p.rect);
  record(`${fmt}: 셀 글자 서식이 셀 문단 위치(커서 사각형)를 바꾼다(시험 상태가 의미 있음)`, !same(plainLines, formattedLines) ? "PASS" : "FAIL",
    { plain: plainLines, formatted: formattedLines });
  plain.free(); formatted.free();
  // 1) 배치 아님(세션과 같음): 편집 → 내보내기 → 찍기 → 내보내기.
  const a = new rhwp.HwpDocument(src);
  cellFormatting(a);
  const stateBefore = capture(a);
  const e1 = exportDoc(a, fmt);
  const e1b = exportDoc(a, fmt); // 내보내기 자체의 정규화(두 번 내보내기)
  const id = a.saveSnapshot();
  const stateAfter = capture(a);
  const e2 = exportDoc(a, fmt);
  // 대조: 같은 편집, 스냅숏 없음(별도 문서).
  const c = new rhwp.HwpDocument(src);
  cellFormatting(c);
  const ec = exportDoc(c, fmt);
  const stateControl = capture(c);
  // 다시 열기: 스냅숏 뒤 출력과 대조 출력을 각각 열어 비교.
  const r2 = new rhwp.HwpDocument(e2.bytes), rc = new rhwp.HwpDocument(ec.bytes);
  const reopenSame = same(capture(r2), capture(rc));
  r2.free(); rc.free();
  const v1 = verdict(fmt, original, e1, `${fmt}-before`), v2 = verdict(fmt, original, e2, `${fmt}-after`), vc = verdict(fmt, original, ec, `${fmt}-control`);
  // 찍은 상태로 복원(뒤에 다른 편집): 찍기 전 내보내기와 같은가.
  a.insertText(0, 0, 0, "뒤 편집");
  a.restoreSnapshot(id);
  const e3 = exportDoc(a, fmt);
  record(`${fmt}: 배치 아님 — 찍기 전후 모델 상태 같음`, same(stateBefore, stateAfter) ? "PASS" : "FAIL", { cellParagraphs: stateBefore.cell.length });
  record(`${fmt}: 배치 아님 — 찍기 전후 내보내기 바이트 같음`, sha(e1.bytes) === sha(e2.bytes) ? "PASS" : "FAIL", { before: sha(e1.bytes).slice(0, 12), after: sha(e2.bytes).slice(0, 12), exportTwiceSame: sha(e1.bytes) === sha(e1b.bytes) });
  record(`${fmt}: 배치 아님 — 스냅숏 없는 같은 편집과 바이트·상태 같음`, sha(e2.bytes) === sha(ec.bytes) && same(stateAfter, stateControl) ? "PASS" : "FAIL", {});
  record(`${fmt}: 다시 연 문서가 대조와 같음`, reopenSame ? "PASS" : "FAIL", {});
  record(`${fmt}: T009 판정이 찍기 전·후·대조 모두 같음`, same(v1, v2) && same(v2, vc) ? "PASS" : "FAIL", { before: v1, after: v2, control: vc });
  record(`${fmt}: 다른 편집 뒤 복원하면 찍기 전 내보내기와 바이트 같음`, sha(e3.bytes) === sha(e1.bytes) ? "PASS" : "FAIL", {});
  a.free(); c.free();

  // 2) 배치 모드(세션은 쓰지 않음 — 미뤄 둔 갱신이 실제로 남는 경로): 배치 안에서 찍기가 결과를 바꾸는가.
  const b = new rhwp.HwpDocument(src);
  b.beginBatch();
  cellFormatting(b);
  const inBatchBefore = capture(b);
  b.saveSnapshot();
  const inBatchAfter = capture(b);
  b.endBatch();
  const eb = exportDoc(b, fmt);
  const d = new rhwp.HwpDocument(src);
  d.beginBatch();
  cellFormatting(d);
  d.endBatch();
  const ed = exportDoc(d, fmt);
  record(`${fmt}: 배치 — 배치 안에서 찍기 전후 관찰 상태`, same(inBatchBefore, inBatchAfter) ? "PASS" : "OBSERVED-DIFF",
    { changedCellLines: inBatchBefore.cell.map((p, i) => JSON.stringify(p.lines) !== JSON.stringify(inBatchAfter.cell[i]?.lines)) });
  record(`${fmt}: 배치 — endBatch 뒤 내보내기는 스냅숏 유무와 같음`, sha(eb.bytes) === sha(ed.bytes) && same(capture(b), capture(d)) ? "PASS" : "FAIL", {});
  b.free(); d.free();
}

rmSync(scratch, { recursive: true, force: true });
const failed = results.filter((r) => r.status === "FAIL");
console.log(`\n실패 ${failed.length} / ${results.length}`);
const outArg = process.argv.indexOf("--out");
if (outArg > 0) writeFileSync(process.argv[outArg + 1], JSON.stringify({ rhwpCommit: JSON.parse(readFileSync(join(root, "public/rhwp/BUILD.json"), "utf8")).commit, results }, null, 1) + "\n");
process.exit(failed.length ? 1 : 0);
