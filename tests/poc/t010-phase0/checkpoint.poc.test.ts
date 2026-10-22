// T010 Phase 2 선행 PoC B2(시험 전용): 커서·선택 체크포인트가 구조 편집과 스냅숏 복원을 지나도 정확한가. 실제 rhwp WASM 문서와
// 제품 위치 계층(RhwpText — 세션이 쓰는 본문/셀 API 선택)으로, 체크포인트 찍기 → 스냅숏 → 구조 편집 → 복원 → 체크포인트 검증 →
// 후속 편집을 한다. 숫자 오프셋이 범위 안이라는 것은 정확함의 증거가 아니므로, 체크포인트는 위치 + 주변 글 지문(앞뒤 8글자) + 셀이면
// 셀 수·셀 문단 수를 함께 갖고, 복원 뒤 그 지문이 같을 때만 "정확"이다. 아니면 내용을 바꾸지 않는 대체(문서 처음, 선택 없음).
//   npx vitest run --config tests/poc/t010-phase0/vitest.config.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RhwpDocument } from "../../../src/components/Editor/rhwp/rhwpModule";
import { RhwpText, type DocPosition } from "../../../src/components/Editor/rhwp/rhwpText";

const ROOT = resolve(__dirname, "../../..");
type Doc = RhwpDocument & { saveSnapshot(): number; restoreSnapshot(id: number): string; getTextFileText(): string; free(): void };
let engine: { HwpDocument: new (bytes: Uint8Array) => Doc };
const fixtures: Record<string, Uint8Array> = {};
let scratch: string;

beforeAll(async () => {
  scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "geul-t010-b2-"));
  execFileSync("node", [join(ROOT, "tests/fixtures/rhwp/generate.mjs"), scratch]);
  for (const fmt of ["hwp", "hwpx"]) fixtures[fmt] = new Uint8Array(readFileSync(join(scratch, `basic-ko.${fmt}`)));
  const mod = await import(/* @vite-ignore */ pathToFileURL(join(ROOT, "public/rhwp/rhwp.js")).href);
  mod.initSync({ module: readFileSync(join(ROOT, "public/rhwp/rhwp_bg.wasm")) });
  engine = mod;
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Checkpoint {
  caret: DocPosition;
  anchor: DocPosition;
  marks: { caret: Mark; anchor: Mark };
}
interface Mark { before: string; after: string; paragraphs: number; cells: number | null }
const FINGER = 8;

function mark(text: RhwpText, at: DocPosition): Mark {
  const start = Math.max(0, at.offset - FINGER);
  return {
    before: text.text({ ...at, offset: start }, at.offset - start),
    after: text.text(at, Math.min(FINGER, text.paragraphLength(at) - at.offset)),
    paragraphs: text.paragraphCount(at),
    cells: text.cellCount(at),
  };
}
const capture = (text: RhwpText, caret: DocPosition, anchor = caret): Checkpoint => ({ caret, anchor, marks: { caret: mark(text, caret), anchor: mark(text, anchor) } });

/** 구조상 그 문서에 있는 위치인가(엔진 질의가 던지거나 범위 밖이면 아님). */
function structurallyValid(text: RhwpText, at: DocPosition): boolean {
  try {
    if (at.cell) {
      const cells = text.cellCount(at);
      if (cells === null || at.cell.cell >= cells || at.cell.cellParagraph >= text.paragraphCount(at)) return false;
    } else if (at.paragraph >= text.paragraphCount(at)) return false;
    return at.offset >= 0 && at.offset <= text.paragraphLength(at);
  } catch {
    return false;
  }
}
type Restored = { kind: "exact"; caret: DocPosition; anchor: DocPosition } | { kind: "fallback"; caret: DocPosition; anchor: DocPosition; reason: string };
const START: DocPosition = { section: 0, paragraph: 0, offset: 0 };
/** 복원한 문서에 체크포인트를 둔다: 구조·지문이 모두 맞으면 exact, 아니면 문서 처음(내용을 바꾸지 않음). */
function restoreCheckpoint(text: RhwpText, cp: Checkpoint): Restored {
  for (const key of ["caret", "anchor"] as const) {
    if (!structurallyValid(text, cp[key])) return { kind: "fallback", caret: START, anchor: START, reason: `${key}: structure` };
    if (JSON.stringify(mark(text, cp[key])) !== JSON.stringify(cp.marks[key])) return { kind: "fallback", caret: START, anchor: START, reason: `${key}: fingerprint` };
  }
  return { kind: "exact", caret: cp.caret, anchor: cp.anchor };
}

const BODY = (paragraph: number, offset: number): DocPosition => ({ section: 0, paragraph, offset });
const CELL = (cell: number, cellParagraph: number, offset: number): DocPosition => ({ section: 0, paragraph: 2, offset, cell: { parentParagraph: 2, control: 0, cell, cellParagraph } });

function open(fmt: string) {
  const doc = new engine.HwpDocument(fixtures[fmt]);
  return { doc, text: new RhwpText(doc) };
}

describe.each(["hwp", "hwpx"])("B2 체크포인트(%s, 실제 WASM)", (fmt) => {
  /** 공통 절차: 체크포인트 → 스냅숏 → 구조 편집 → 복원 → 검증 → 후속 편집(체크포인트 자리에 'Q'를 넣어 그 자리 글로 확인). */
  function roundTrip(caret: DocPosition, anchor: DocPosition, mutate: (t: RhwpText) => void) {
    const { doc, text } = open(fmt);
    const cp = capture(text, caret, anchor);
    const textBefore = doc.getTextFileText();
    const id = doc.saveSnapshot();
    mutate(text);
    expect(doc.getTextFileText()).not.toBe(textBefore);
    doc.restoreSnapshot(id);
    expect(doc.getTextFileText()).toBe(textBefore);
    const restored = restoreCheckpoint(text, cp);
    expect(restored.kind).toBe("exact");
    // 후속 편집: 그 자리에 넣으면 바로 앞이 체크포인트 앞 글, 바로 뒤가 Q와 체크포인트 뒤 글이다.
    text.insert(restored.caret, "Q");
    const after = mark(text, { ...restored.caret, offset: restored.caret.offset + 1 });
    expect(after.before.endsWith(cp.marks.caret.before.slice(-(FINGER - 1)) + "Q")).toBe(true);
    expect(text.text({ ...restored.caret, offset: restored.caret.offset + 1 }, cp.marks.caret.after.length)).toBe(cp.marks.caret.after);
    doc.free();
    return { cp, restored };
  }

  it("넣기·지우기", () => {
    roundTrip(BODY(0, 3), BODY(0, 3), (t) => { t.insert(BODY(0, 0), "앞앞"); t.delete(BODY(0, 5), 2); });
  });
  it("문단 나누기(앞 문단에서): 뒤 문단의 체크포인트", () => {
    roundTrip(BODY(1, 2), BODY(1, 2), (t) => t.split(BODY(0, 2)));
  });
  it("문단 합치기", () => {
    roundTrip(BODY(1, 1), BODY(1, 1), (t) => t.mergeIntoPrevious(BODY(1, 0), 1));
  });
  it("선택 바꾸기: 앵커·커서 둘 다 정확, 선택한 글도 같음", () => {
    const { doc, text } = open(fmt);
    const selected = text.text(BODY(0, 1), 4);
    doc.free();
    roundTrip(BODY(0, 5), BODY(0, 1), (t) => { t.deleteRange(BODY(0, 1), BODY(0, 5)); t.insert(BODY(0, 1), "새"); });
    const again = open(fmt);
    expect(again.text.text(BODY(0, 1), 4)).toBe(selected);
    again.doc.free();
  });
  it("여러 문단에 걸친 선택(지우면 문단이 합쳐짐)", () => {
    roundTrip(BODY(1, 3), BODY(0, 2), (t) => t.deleteRange(BODY(0, 2), BODY(1, 3)));
  });
  it("표 셀 안 편집: 셀 경로·셀 수·셀 문단 수까지 같음", () => {
    const { cp } = roundTrip(CELL(1, 0, 2), CELL(1, 0, 2), (t) => { t.insert(CELL(1, 0, 0), "셀앞"); t.split(CELL(1, 0, 3)); });
    expect(cp.marks.caret.cells).toBe(4);
  });
  it("셀 끝 경계(오프셋 = 길이)", () => {
    const { text, doc } = open(fmt);
    const end = text.paragraphLength(CELL(0, 0, 0));
    doc.free();
    roundTrip(CELL(0, 0, end), CELL(0, 0, end), (t) => t.delete(CELL(0, 0, 0), 2));
  });

  // ---- 복원한 구조와 맞지 않는 체크포인트(대체 계약) ----

  it("구조 불일치: 나누기 뒤 상태에서 찍은 체크포인트(새 문단)를 나누기 전 상태에 쓰면 대체(내용 그대로)", () => {
    const { doc, text } = open(fmt);
    const id = doc.saveSnapshot();
    const count = text.paragraphCount(BODY(0, 0));
    text.split(BODY(count - 1, 1));
    const late = capture(text, BODY(count, 0)); // 나누기로 생긴 문단
    doc.restoreSnapshot(id);
    const before = doc.getTextFileText();
    const r = restoreCheckpoint(text, late);
    expect(r).toMatchObject({ kind: "fallback", caret: START, reason: "caret: structure" });
    expect(doc.getTextFileText()).toBe(before);
    doc.free();
  });
  it("숫자로는 범위 안이지만 다른 자리: 넣기 뒤 상태의 체크포인트는 지문이 달라 대체", () => {
    const { doc, text } = open(fmt);
    const id = doc.saveSnapshot();
    text.insert(BODY(0, 0), "XYZ");
    const late = capture(text, BODY(0, 4));
    doc.restoreSnapshot(id);
    expect(structurallyValid(text, BODY(0, 4))).toBe(true); // 오프셋은 유효
    const r = restoreCheckpoint(text, late);
    expect(r).toMatchObject({ kind: "fallback", reason: "caret: fingerprint" });
    doc.free();
  });
  it("셀 구조 불일치: 셀 안 나누기로 생긴 셀 문단의 체크포인트는 대체", () => {
    const { doc, text } = open(fmt);
    const id = doc.saveSnapshot();
    text.split(CELL(0, 0, 1));
    const late = capture(text, CELL(0, 1, 0));
    doc.restoreSnapshot(id);
    expect(restoreCheckpoint(text, late)).toMatchObject({ kind: "fallback", reason: "caret: structure" });
    doc.free();
  });
  it("없는 셀 번호·없는 표 문단의 위치는 구조상 아님(엔진 질의 예외도 아님으로)", () => {
    const { doc, text } = open(fmt);
    expect(structurallyValid(text, CELL(9, 0, 0))).toBe(false);
    expect(structurallyValid(text, { section: 0, paragraph: 0, offset: 0, cell: { parentParagraph: 0, control: 0, cell: 0, cellParagraph: 0 } })).toBe(false);
    expect(structurallyValid(text, BODY(99, 0))).toBe(false);
    doc.free();
  });
});
