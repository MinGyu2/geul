#!/usr/bin/env node
// T010 Phase 0 PoC(시험 전용, 제품 코드 아님): 고정 rhwp WASM(public/rhwp/, BUILD.json 커밋)으로 스냅숏·서식 가설을 실제로 확인한다.
//
//   node tests/poc/t010-phase0/rhwp_phase0.mjs <픽스처 디렉터리> <출력 디렉터리> [큰 HWP] [큰 HWPX]
//
// 픽스처 디렉터리: tests/fixtures/rhwp/generate.mjs 출력(basic-ko.hwp·hwpx). 출력 디렉터리에 results.json과 저장 검사(T009
// save_check)에 넣을 내보내기 파일·손실 보고·다시 열기 근거를 쓴다. 큰 문서는 성능 측정에만 쓰고 내용은 기록하지 않는다.
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const rhwp = await import(pathToFileURL(join(root, "public/rhwp/rhwp.js")).href);
const wasm = rhwp.initSync({ module: readFileSync(join(root, "public/rhwp/rhwp_bg.wasm")) });
const [fixtures, out, largeHwp, largeHwpx] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const R = { build: JSON.parse(readFileSync(join(root, "public/rhwp/BUILD.json"), "utf8")), checks: [], files: [] };
const check = (id, status, detail) => {
  R.checks.push({ id, status, detail });
  console.log(`[${status}] ${id} ${JSON.stringify(detail).slice(0, 300)}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tryCall = (f) => { try { return { ok: true, value: f() }; } catch (e) { return { ok: false, error: String(e) }; } };

import { zipEntries, hwpParts, docinfoDiff, sectionDiff, hwpxDiff, charPrs, TAG } from "./analysis.mjs";

// ---------- 엔진 도우미 ----------
const open = (bytes) => new rhwp.HwpDocument(bytes);
function exportDoc(doc, fmt) {
  const e = fmt === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
  try { return { loss: e.contentLoss(), bytes: e.takeBytes() }; } finally { e.free(); }
}
function charShapeCount(bytes, fmt) {
  return fmt === "hwp" ? hwpParts(bytes).docinfo.filter((r) => r.tag === TAG.CHAR_SHAPE).length
    : charPrs(zipEntries(Buffer.from(bytes)).get("Contents/header.xml").toString("utf8")).length;
}
const TABLE = { para: 2, control: 0 };
function capture(doc) {
  const paras = [];
  for (let p = 0; p < doc.getParagraphCount(0); p++) {
    const len = doc.getParagraphLength(0, p);
    paras.push({ len, text: len ? doc.getTextRange(0, p, 0, len) : "",
      runs: len ? JSON.parse(doc.getCharShapeRuns(0, p, 0, len)) : [] });
  }
  const cells = [];
  for (let c = 0; c < 4; c++) {
    const r = tryCall(() => doc.getTextInCell(0, TABLE.para, TABLE.control, c, 0, 0, 50));
    cells.push(r.ok ? r.value : null);
  }
  return { pages: doc.pageCount(), text: doc.getTextFileText(), controls: doc.getControls(), paras, cells };
}
const props = (doc, p, o) => JSON.parse(doc.getCharPropertiesAt(0, p, o));
const cellProps = (doc, c, o) => JSON.parse(doc.getCellCharPropertiesAt(0, TABLE.para, TABLE.control, c, 0, o));
const ORIGINAL = {};
const sigOk = (bytes, fmt) => (fmt === "hwp" ? bytes[0] === 0xd0 && bytes[1] === 0xcf : bytes[0] === 0x50 && bytes[1] === 0x4b);

/** 저장 검사용 파일 묶음: 내보내기·손실 보고·다시 열기 근거(앱 RhwpEditorSession.exportAndCompare와 같은 네 비교). */
function emit(name, doc, fmt) {
  const { bytes, loss } = exportDoc(doc, fmt);
  const file = join(out, `${name}.${fmt}`);
  writeFileSync(file, bytes);
  writeFileSync(`${file}.loss.json`, loss);
  const re = open(bytes);
  let reopen;
  try {
    reopen = { formatEqual: re.getSourceFormat() === fmt && sigOk(bytes, fmt), pagesEqual: re.pageCount() === doc.pageCount(),
      textEqual: re.getTextFileText() === doc.getTextFileText(), controlsEqual: re.getControls() === doc.getControls() };
  } finally { re.free(); }
  const entry = { name, fmt, file, loss: JSON.parse(loss), reopen, charShapes: charShapeCount(bytes, fmt),
    diff: fmt === "hwp" ? { docinfo: docinfoDiff(ORIGINAL[fmt], bytes), sections: sectionDiff(ORIGINAL[fmt], bytes) } : hwpxDiff(ORIGINAL[fmt], bytes) };
  R.files.push(entry);
  return { bytes, entry };
}

// ---------- 실험 ----------
const FORMATS = ["hwp", "hwpx"];
const ATTRS = { bold: "bold", italic: "italic", underline: "underline", strikethrough: "strikethrough" };
const OTHER_KEYS = ["fontFamily", "fontSize", "textColor", "shadeColor", "ratios", "spacings", "relativeSizes", "charOffsets", "fontFamilies", "borderFillId",
  "outlineType", "shadowType", "emboss", "engrave", "subscript", "superscript", "emphasisDot", "kerning"];
const ALL_FORMAT_KEYS = ["bold", "italic", "underline", "underlineType", "strikethrough", "underlineShape", "strikeShape"];
const others = (pr) => Object.fromEntries(OTHER_KEYS.map((k) => [k, pr[k]]));

for (const fmt of FORMATS) {
  const src = readFileSync(join(fixtures, `basic-ko.${fmt}`));
  ORIGINAL[fmt] = src;
  writeFileSync(join(out, `original.${fmt}`), src);
  // E1 입력: 편집 없는 내보내기(사전 검사).
  { const d = open(src); emit("e1-unedited", d, fmt); d.free(); }
  // E 대조군: 글자만 넣은 편집(서식 없음).
  { const d = open(src); d.insertText(0, 0, 0, "가"); emit("e-control-text", d, fmt); d.free(); }

  // ---- A 스냅숏 무결성 ----
  {
    const d = open(src);
    const s0 = capture(d), export0 = exportDoc(d, fmt).bytes;
    const id = d.saveSnapshot();
    d.insertText(0, 0, 3, "삽입");
    d.splitParagraph(0, 0, 5);
    d.mergeParagraph(0, 1);
    d.deleteText(0, 3, 0, 2);
    d.insertTextInCell(0, TABLE.para, TABLE.control, 1, 0, 0, "셀편집");
    d.applyCharFormat(0, 1, 6, 10, JSON.stringify({ italic: true, underline: true }));
    const mutated = capture(d);
    const restored = tryCall(() => d.restoreSnapshot(id));
    const s1 = capture(d);
    const export1 = exportDoc(d, fmt).bytes;
    check(`A1-7 ${fmt}: 여러 편집(넣기·나누기·합치기·지우기·셀·서식) 뒤 복원하면 본문·문단·런·셀·컨트롤·쪽 수가 처음과 같다`,
      restored.ok && !eq(mutated, s0) && eq(s1, s0) ? "CONFIRMED" : "REFUTED", { restored, mutatedDiffers: !eq(mutated, s0), equal: eq(s1, s0) });
    check(`A6 ${fmt}: 복원한 문서의 내보내기 바이트가 편집 전 내보내기와 같다`, Buffer.from(export1).equals(Buffer.from(export0)) ? "CONFIRMED" : "REFUTED",
      { bytes: [export0.length, export1.length], charShapes: [charShapeCount(export0, fmt), charShapeCount(export1, fmt)] });
    emit("a-restored", d, fmt);
    const re = open(export1); const s2 = capture(re); re.free();
    check(`A6 ${fmt}: 복원 뒤 내보내 다시 연 문서가 처음 상태와 같다`, eq(s2, s0) ? "CONFIRMED" : "REFUTED", {});
    // 잘못된 ID: 문서를 바꾸지 않고 실패.
    const bad = tryCall(() => d.restoreSnapshot(987654));
    check(`A ${fmt}: 없는 스냅숏 ID 복원은 오류이고 문서가 그대로다`, !bad.ok && eq(capture(d), s0) ? "CONFIRMED" : "REFUTED", { error: bad.error });
    // 버린 ID.
    d.discardSnapshot(id);
    const gone = tryCall(() => d.restoreSnapshot(id));
    check(`A ${fmt}: 버린 스냅숏 ID는 다시 복원할 수 없다`, !gone.ok ? "CONFIRMED" : "REFUTED", { error: gone.error });
    d.free();
  }
  {
    // 여러 시점 스냅숏: 각 시점으로 정확히 돌아가는지(순서 무관).
    const d = open(src);
    const states = [], ids = [];
    const edits = [() => d.insertText(0, 0, 0, "하나"), () => d.splitParagraph(0, 1, 3), () => d.mergeParagraph(0, 2),
      () => d.insertTextInCell(0, TABLE.para + 0, TABLE.control, 3, 0, 0, "넷"), () => d.applyCharFormat(0, 0, 0, 2, JSON.stringify({ bold: true }))];
    for (const edit of edits) { ids.push(d.saveSnapshot()); states.push(capture(d)); edit(); }
    const last = capture(d);
    const order = [2, 0, 4, 1, 3];
    const results = order.map((k) => { const r = tryCall(() => d.restoreSnapshot(ids[k])); return { k, ok: r.ok, equal: eq(capture(d), states[k]) }; });
    check(`A ${fmt}: 다른 편집 사이 5개 시점 스냅숏을 뒤섞은 순서로 복원해도 각 시점과 같다(나누기·합치기·셀 포함)`,
      results.every((x) => x.ok && x.equal) && !eq(last, states[0]) ? "CONFIRMED" : "REFUTED", results);
    d.free();
  }

  // ---- D 서식 ----
  const formatting = {};
  for (const attr of Object.keys(ATTRS)) {
    const res = {};
    const base = open(src);
    const count0 = charShapeCount(exportDoc(base, fmt).bytes, fmt);
    const runs0 = JSON.parse(base.getCharShapeRuns(0, 1, 0, 15));
    const before = [0, 3, 7].map((o) => props(base, 1, o));
    base.free();
    // D1 일반 선택(문단 0의 0..4, 원래 모양 하나).
    {
      const d = open(src);
      const p0 = props(d, 0, 1);
      const ret = d.applyCharFormat(0, 0, 0, 4, JSON.stringify({ [attr]: true }));
      const p1 = props(d, 0, 1), outside = props(d, 0, 6);
      res.D1 = { ret, target: [p0[attr], p1[attr]], othersSame: eq(others(p0), others(p1)), outsideSame: eq(props(d, 0, 6), p0) || outside[attr] === p0[attr],
        ids: [p0.charShapeId, p1.charShapeId], charShapes: [count0, charShapeCount(exportDoc(d, fmt).bytes, fmt)],
        otherFormatKeysSame: ALL_FORMAT_KEYS.filter((k) => k !== attr && !(attr === "underline" && k === "underlineType")).every((k) => p0[k] === p1[k]) };
      // D3 이미 켠 서식 다시 켜기.
      const idBefore = props(d, 0, 1).charShapeId, cnt = charShapeCount(exportDoc(d, fmt).bytes, fmt);
      d.applyCharFormat(0, 0, 0, 4, JSON.stringify({ [attr]: true }));
      res.D3 = { idSame: props(d, 0, 1).charShapeId === idBefore, countSame: charShapeCount(exportDoc(d, fmt).bytes, fmt) === cnt };
      // D4 끄기: 원래 모양 ID로 돌아가는가, 덧붙인 모양이 남는가.
      d.applyCharFormat(0, 0, 0, 4, JSON.stringify({ [attr]: false }));
      const off = props(d, 0, 1);
      res.D4 = { backToOriginalId: off.charShapeId === p0.charShapeId, id: off.charShapeId, target: off[attr],
        charShapes: charShapeCount(exportDoc(d, fmt).bytes, fmt) };
      if (attr === "bold") emit("e-bold-then-unbold", d, fmt);
      d.free();
    }
    // D2 섞인 서식(문단 1의 3..8: 굵은 0..5와 보통 5..에 걸침).
    {
      const d = open(src);
      d.applyCharFormat(0, 1, 3, 8, JSON.stringify({ [attr]: true }));
      const after = [0, 3, 7].map((o) => props(d, 1, o));
      res.D2 = { runsBefore: runs0, runsAfter: JSON.parse(d.getCharShapeRuns(0, 1, 0, 15)),
        outsideUnchanged: eq(after[0], before[0]), boldKeptWhereItWas: after[1].bold === before[1].bold && after[2].bold === before[2].bold,
        targetSet: after[1][attr] === true && after[2][attr] === true, othersSame: [1, 2].every((i) => eq(others(after[i]), others(before[i]))) };
      d.free();
    }
    // D5 표 셀.
    {
      const d = open(src);
      const c0 = cellProps(d, 0, 0);
      const ret = tryCall(() => d.applyCharFormatInCell(0, TABLE.para, TABLE.control, 0, 0, 0, 2, JSON.stringify({ [attr]: true })));
      const c1 = cellProps(d, 0, 0), c2 = cellProps(d, 0, 3);
      res.D5 = { ret, target: [c0[attr], c1[attr]], outside: c2[attr], othersSame: eq(others(c0), others(c1)), cellText: d.getTextInCell(0, TABLE.para, TABLE.control, 0, 0, 0, 10) };
      d.free();
    }
    // D6 빈(접힌) 범위.
    {
      const d = open(src);
      const s0 = capture(d), e0 = exportDoc(d, fmt).bytes;
      const ret = tryCall(() => d.applyCharFormat(0, 0, 3, 3, JSON.stringify({ [attr]: true })));
      const e1 = exportDoc(d, fmt).bytes;
      res.D6 = { ret, stateSame: eq(capture(d), s0), exportSame: Buffer.from(e0).equals(Buffer.from(e1)), propsAt3: props(d, 0, 3)[attr] };
      d.free();
    }
    // D7 서식 뒤 스냅숏 복원 + E 출력.
    {
      const d = open(src);
      const s0 = capture(d), e0 = exportDoc(d, fmt).bytes;
      const id = d.saveSnapshot();
      d.applyCharFormat(0, 0, 0, 4, JSON.stringify({ [attr]: true }));
      emit(`e-${attr}`, d, fmt);
      d.restoreSnapshot(id);
      const e1 = exportDoc(d, fmt).bytes;
      res.D7 = { stateSame: eq(capture(d), s0), exportSame: Buffer.from(e0).equals(Buffer.from(e1)), charShapes: charShapeCount(e1, fmt) };
      if (attr === "bold") emit("e-bold-snapshot-restored", d, fmt);
      d.discardSnapshot(id);
      d.free();
    }
    formatting[attr] = res;
  }
  // attr 비트와 같음 비교: 내보내 다시 연 문서에서 굵게를 끄면 원래 모양으로 돌아가는가(다시 연 뒤 attr가 굵게 비트를 가짐).
  {
    const d = open(src);
    const id0 = props(d, 0, 1).charShapeId;
    d.applyCharFormat(0, 0, 0, 4, JSON.stringify({ bold: true }));
    const idBold = props(d, 0, 1).charShapeId;
    const exported = exportDoc(d, fmt).bytes;
    d.free();
    const re = open(exported);
    const reBold = props(re, 0, 1);
    const cnt1 = charShapeCount(exportDoc(re, fmt).bytes, fmt);
    re.applyCharFormat(0, 0, 0, 4, JSON.stringify({ bold: false }));
    const reOff = props(re, 0, 1);
    const cnt2 = charShapeCount(exportDoc(re, fmt).bytes, fmt);
    // 원본에 이미 있는 굵은 모양(문단 1의 0..5, id 7)과 같은 모양으로 굵게를 켤 때 재사용하는가.
    const d2 = open(src);
    const boldExisting = props(d2, 1, 0);
    d2.applyCharFormat(0, 1, 6, 9, JSON.stringify({ bold: true }));
    const reuse = props(d2, 1, 7);
    const cnt3 = charShapeCount(exportDoc(d2, fmt).bytes, fmt);
    d2.free();
    formatting.attrEquality = { originalId: id0, boldId: idBold, reopenedBoldId: reBold.charShapeId, reopenedCount: cnt1,
      unboldAfterReopenId: reOff.charShapeId, unboldAfterReopenBackToOriginal: reOff.charShapeId === id0, countAfterUnboldReopened: cnt2,
      existingBoldShape: boldExisting.charShapeId, boldOnPlainNextToExistingBold: reuse.charShapeId, reusedExistingBold: reuse.charShapeId === boldExisting.charShapeId,
      countAfter: cnt3 };
    re.free();
  }
  // 밑줄 종류: 위(Top) 밑줄에 underline:true를 적용하면 종류가 바뀌는가.
  {
    const d = open(src);
    d.applyCharFormat(0, 0, 0, 4, JSON.stringify({ underlineType: "Top" }));
    const top = props(d, 0, 1);
    d.applyCharFormat(0, 0, 0, 4, JSON.stringify({ underline: true }));
    const after = props(d, 0, 1);
    formatting.underlineSubtype = { afterTop: [top.underline, top.underlineType], afterUnderlineTrue: [after.underline, after.underlineType] };
    d.free();
  }
  R[`formatting_${fmt}`] = formatting;
}

// ---- B 스냅숏 수명·용량 ----
{
  const src = readFileSync(join(fixtures, "basic-ko.hwpx"));
  const d = open(src);
  const cap = d.snapshotCapacity();
  // B4 순진한 할당: 상한을 넘기면 가장 오래된 것이 알림 없이 사라진다.
  const ids = [];
  for (let i = 0; i < cap + 20; i++) ids.push(d.saveSnapshot());
  const alive = ids.map((id) => tryCall(() => d.restoreSnapshot(id)).ok);
  check("B4: 상한+20개를 할당하면 가장 오래된 20개가 알림 없이 사라지고 나머지는 복원된다", alive.slice(0, 20).every((x) => !x) && alive.slice(20).every(Boolean)
    ? "CONFIRMED" : "REFUTED", { capacity: cap, evicted: alive.filter((x) => !x).length, firstAlive: alive.indexOf(true) });
  ids.forEach((id) => d.discardSnapshot(id));
  d.free();

  /** studio와 같은 모양의 시험용 기록: 실행 전 before, 되돌릴 때 after를 저장. budget = cap - headroom. */
  function simulate(headroom, script, label) {
    const doc = open(src);
    const budget = cap - headroom;
    const undo = [], redo = [];
    let peak = 0, steps = 0, failures = [];
    const liveIds = () => undo.reduce((n, e) => n + 1 + (e.after != null ? 1 : 0), 0) + redo.reduce((n, e) => n + 1 + (e.after != null ? 1 : 0), 0);
    const trim = () => {
      while (liveIds() > budget && undo.length > 0) { const e = undo.shift(); doc.discardSnapshot(e.before); if (e.after != null) doc.discardSnapshot(e.after); }
    };
    const text = () => doc.getTextFileText();
    const edit = () => {
      for (const e of redo.splice(0)) { doc.discardSnapshot(e.before); if (e.after != null) doc.discardSnapshot(e.after); }
      const before = doc.saveSnapshot(); peak = Math.max(peak, liveIds() + 1);
      const expectBefore = text();
      doc.insertText(0, 0, 0, String(steps++ % 10));
      undo.push({ before, after: null, expectBefore, expectAfter: text() });
      trim();
    };
    const undoOnce = () => {
      const e = undo.pop(); if (!e) return;
      e.after = doc.saveSnapshot(); peak = Math.max(peak, liveIds() + 1);
      const r = tryCall(() => doc.restoreSnapshot(e.before));
      if (!r.ok || text() !== e.expectBefore) failures.push({ op: "undo", error: r.error, textOk: text() === e.expectBefore, live: liveIds() });
      redo.push(e);
      trim();
    };
    const redoOnce = () => {
      const e = redo.pop(); if (!e) return;
      const r = tryCall(() => doc.restoreSnapshot(e.after));
      if (!r.ok || text() !== e.expectAfter) failures.push({ op: "redo", error: r.error, textOk: text() === e.expectAfter, live: liveIds() });
      doc.discardSnapshot(e.after); e.after = null;
      undo.push(e);
      trim();
    };
    script({ edit, undoOnce, redoOnce });
    // 끝: 참조 중인 모든 ID가 복원 가능한지(참조 누수 없음).
    const referenced = [...undo, ...redo].flatMap((e) => [e.before, e.after]).filter((x) => x != null);
    const unrestorable = referenced.filter((id) => !tryCall(() => doc.restoreSnapshot(id)).ok);
    referenced.forEach((id) => doc.discardSnapshot(id));
    const afterDiscard = referenced.filter((id) => tryCall(() => doc.restoreSnapshot(id)).ok);
    doc.free();
    const result = { label, capacity: cap, budget, peakLiveIds: peak, failures: failures.slice(0, 5), failureCount: failures.length,
      referencedAtEnd: referenced.length, unrestorableAtEnd: unrestorable.length, restorableAfterDiscard: afterDiscard.length };
    return result;
  }
  const near = (h) => ({ edit, undoOnce, redoOnce }) => {
    for (let i = 0; i < 3; i++) edit(); undoOnce(); undoOnce(); redoOnce(); // B1·B2·B3 작은 순서
    for (let i = 0; i < 150; i++) edit(); // B4·B5 상한을 넘는 누적 할당
    for (let r = 0; r < 30; r++) { undoOnce(); undoOnce(); redoOnce(); undoOnce(); redoOnce(); redoOnce(); } // B6 상한 근처 왕복
    for (let i = 0; i < 40; i++) undoOnce(); // 깊은 되돌리기(redo 2슬롯씩)
    edit(); // B7 되돌린 뒤 새 편집: redo 폐기
  };
  for (const [h, label] of [[2, "studio와 같은 여유 2"], [0, "여유 0(상한까지)"]]) {
    const r = simulate(h, near(h), label);
    check(`B ${label}: 기록 흉내(실행·되돌리기·다시 실행 ${"≈"}300단계)에서 참조 중인 스냅숏이 모두 복원되고 버린 뒤 남는 것이 없다`,
      r.failureCount === 0 && r.unrestorableAtEnd === 0 && r.restorableAfterDiscard === 0 && r.peakLiveIds <= cap ? "CONFIRMED" : "REFUTED", r);
  }
  // B8 트리밍 없이 상한을 넘기면 참조 중인 ID가 사라지는 정확한 전이.
  {
    const doc = open(src);
    const before = [];
    for (let i = 0; i < cap; i++) { before.push(doc.saveSnapshot()); doc.insertText(0, 0, 0, "x"); }
    const firstOk = tryCall(() => doc.restoreSnapshot(before[0])).ok;
    const extra = doc.saveSnapshot(); // 되돌리기 시점의 after 저장 → 101번째
    const firstAfter = tryCall(() => doc.restoreSnapshot(before[0]));
    check("B8: 참조 100개가 살아 있을 때 되돌리기의 after 저장(101번째)이 가장 오래된 참조를 알림 없이 지운다", firstOk && !firstAfter.ok ? "CONFIRMED" : "REFUTED",
      { firstRestorableBefore: firstOk, firstAfterExtra: firstAfter });
    [...before, extra].forEach((id) => doc.discardSnapshot(id));
    doc.free();
  }
  // 복원 실패 경계: rebuild_derived_state는 Result가 없다(소스). 안전하게 일으킬 방법이 없어 실행하지 않는다.
}

// ---- G 성능·메모리 ----
function percentile(xs, q) { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; }
function measure(label, bytes, fmt, n) {
  const mem0 = wasm.memory.buffer.byteLength;
  let t = performance.now();
  const d = open(bytes);
  const openMs = performance.now() - t;
  const memOpen = wasm.memory.buffer.byteLength;
  const save = [], restore = [], insert = [], ids = [];
  for (let i = 0; i < n; i++) { t = performance.now(); ids.push(d.saveSnapshot()); save.push(performance.now() - t); }
  const memSnaps = wasm.memory.buffer.byteLength;
  for (let i = 0; i < Math.min(n, 20); i++) { t = performance.now(); d.restoreSnapshot(ids[i]); restore.push(performance.now() - t); }
  for (let i = 0; i < 20; i++) { t = performance.now(); d.insertText(0, 0, 0, "가"); insert.push(performance.now() - t); }
  ids.forEach((id) => d.discardSnapshot(id));
  const ids2 = [];
  for (let i = 0; i < n; i++) ids2.push(d.saveSnapshot());
  const memReuse = wasm.memory.buffer.byteLength;
  ids2.forEach((id) => d.discardSnapshot(id));
  t = performance.now();
  const e = exportDoc(d, fmt);
  const exportMs = performance.now() - t;
  t = performance.now();
  const re = open(e.bytes); re.free();
  const reopenMs = performance.now() - t;
  d.free();
  const stat = (xs) => ({ n: xs.length, p50: +percentile(xs, 0.5).toFixed(2), p95: +percentile(xs, 0.95).toFixed(2), max: +Math.max(...xs).toFixed(2) });
  return { label, fmt, fileBytes: bytes.length, pages: null, openMs: +openMs.toFixed(1), saveSnapshotMs: stat(save), restoreSnapshotMs: stat(restore),
    insertTextMs: stat(insert), exportMs: +exportMs.toFixed(1), reopenMs: +reopenMs.toFixed(1),
    wasmMemoryBytes: { beforeOpen: mem0, afterOpen: memOpen, afterNSnapshots: memSnaps, afterDiscardAndReallocate: memReuse },
    perSnapshotGrowthBytesApprox: Math.round((memSnaps - memOpen) / n) };
}
R.performance = [];
for (const fmt of FORMATS) R.performance.push(measure("basic-ko(생성 픽스처)", readFileSync(join(fixtures, `basic-ko.${fmt}`)), fmt, 50));
if (largeHwp) R.performance.push(measure(`큰 실제 문서 ${(statSync(largeHwp).size / 1e6).toFixed(1)}MB`, readFileSync(largeHwp), "hwp", 10));
if (largeHwpx) R.performance.push(measure(`큰 실제 문서 ${(statSync(largeHwpx).size / 1e6).toFixed(1)}MB`, readFileSync(largeHwpx), "hwpx", 10));
for (const p of R.performance) console.log("[perf]", JSON.stringify(p));

writeFileSync(join(out, "results.json"), JSON.stringify(R, null, 1));
console.log(`wrote ${join(out, "results.json")}`);
