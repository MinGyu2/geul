// T010 Phase 2 커서 체크포인트 시험(선행 PoC B2를 제품 함수로 바꿈, 2026-10-22 안정화 B4): 제품 rhwpHistory.ts의
// captureCheckpoint·placeCheckpoint를 실제 rhwp WASM 문서와 제품 위치 계층(RhwpText)으로 직접 부른다(시험 안에 같은 알고리즘을 두지
// 않음). 체크포인트 찍기 → 스냅숏 → 구조 편집 → 복원 → 배치 → 후속 편집. 숫자 오프셋이 범위 안이라는 것은 정확함의 증거가 아니므로,
// 체크포인트는 위치 + 주변 글 지문(앞뒤 8글자) + 문맥의 문단 수·셀 수를 갖고, 복원 뒤 그것이 같을 때만 정확(exact)이다. 아니면 내용을
// 바꾸지 않는 대체(문서 처음, 선택 없음).
//   npx vitest run --config tests/poc/t010-phase0/vitest.config.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RhwpDocument } from "../../../src/components/Editor/rhwp/rhwpModule";
import { captureCheckpoint, placeCheckpoint, type Checkpoint } from "../../../src/components/Editor/rhwp/rhwpHistory";
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

const FINGER = 8;
const START: DocPosition = { section: 0, paragraph: 0, offset: 0 };
const capture = (text: RhwpText, caret: DocPosition, anchor = caret): Checkpoint => {
  const cp = captureCheckpoint(text, caret, anchor);
  if (!cp) throw new Error("체크포인트를 찍지 못함");
  return cp;
};
const restoreCheckpoint = (text: RhwpText, cp: Checkpoint | null) => placeCheckpoint(text, cp);

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
    expect(restored.exact).toBe(true);
    // 후속 편집: 그 자리에 넣으면 바로 앞이 체크포인트 앞 글, 바로 뒤가 Q와 체크포인트 뒤 글이다.
    text.insert(restored.caret, "Q");
    const after = capture(text, { ...restored.caret, offset: restored.caret.offset + 1 }).marks.caret;
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
    expect(r).toEqual({ exact: false, caret: START, anchor: START });
    expect(doc.getTextFileText()).toBe(before);
    doc.free();
  });
  it("숫자로는 범위 안이지만 다른 자리: 넣기 뒤 상태의 체크포인트는 지문이 달라 대체", () => {
    const { doc, text } = open(fmt);
    const id = doc.saveSnapshot();
    text.insert(BODY(0, 0), "XYZ");
    const late = capture(text, BODY(0, 4));
    doc.restoreSnapshot(id);
    expect(BODY(0, 4).offset).toBeLessThanOrEqual(text.paragraphLength(BODY(0, 0))); // 오프셋은 범위 안
    const before = doc.getTextFileText();
    const r = restoreCheckpoint(text, late);
    expect(r).toEqual({ exact: false, caret: START, anchor: START }); // 지문이 달라 대체
    expect(doc.getTextFileText()).toBe(before);
    doc.free();
  });
  it("셀 구조 불일치: 셀 안 나누기로 생긴 셀 문단의 체크포인트는 대체", () => {
    const { doc, text } = open(fmt);
    const id = doc.saveSnapshot();
    text.split(CELL(0, 0, 1));
    const late = capture(text, CELL(0, 1, 0));
    doc.restoreSnapshot(id);
    expect(restoreCheckpoint(text, late)).toEqual({ exact: false, caret: START, anchor: START });
    doc.free();
  });
  it("없는 셀 번호·표가 아닌 문단·없는 문단의 체크포인트는 대체(엔진 질의 예외도 대체로)", () => {
    const { doc, text } = open(fmt);
    const real = capture(text, BODY(0, 1));
    const before = doc.getTextFileText();
    for (const bad of [CELL(9, 0, 0), { section: 0, paragraph: 0, offset: 0, cell: { parentParagraph: 0, control: 0, cell: 0, cellParagraph: 0 } }, BODY(99, 0), BODY(0, 999)]) {
      // 지문은 다른 자리의 것을 그대로 두고 위치만 바꾼 체크포인트(구조 검사가 먼저 막아야 함).
      expect(restoreCheckpoint(text, { ...real, caret: bad as DocPosition, anchor: bad as DocPosition })).toEqual({ exact: false, caret: START, anchor: START });
    }
    expect(restoreCheckpoint(text, null)).toEqual({ exact: false, caret: START, anchor: START });
    expect(doc.getTextFileText()).toBe(before);
    doc.free();
  });

  // ---- 모호한 경우(지문의 한계) ----

  it("같은 문단이 되풀이되어도 체크포인트는 자기 상태에서는 정확하다(좌표 + 문단 수)", () => {
    const { doc, text } = open(fmt);
    const same = text.text(BODY(0, 0), text.paragraphLength(BODY(0, 0)));
    text.split(BODY(0, 0));
    text.insert(BODY(0, 0), same); // [A, A, ...]
    const cp = capture(text, BODY(1, 3));
    const id = doc.saveSnapshot();
    text.mergeIntoPrevious(BODY(1, 0), 1); // 구조가 바뀜
    doc.restoreSnapshot(id);
    expect(restoreCheckpoint(text, cp).exact).toBe(true);
    doc.free();
  });

  it("한계(문서화): 문단 수가 같고 앞뒤 8글자가 같으면 다른 상태의 같은 좌표를 정확으로 본다 — 체크포인트는 그 스냅숏 상태와 짝으로만 쓴다", () => {
    const { doc, text } = open(fmt);
    const same = text.text(BODY(0, 0), text.paragraphLength(BODY(0, 0)));
    text.split(BODY(0, 0));
    text.insert(BODY(0, 0), same); // [A, A, B, ...]
    const cp = capture(text, BODY(1, 3)); // 둘째 A
    // 다른 상태: 첫 A를 지우고 그 자리에 A를 새로 넣음(문단 수·좌표의 글이 같다) — 의미로는 다른 문단이지만 지문이 같다.
    text.deleteRange(BODY(0, 0), BODY(0, text.paragraphLength(BODY(0, 0))));
    text.insert(BODY(0, 0), same);
    expect(restoreCheckpoint(text, cp).exact).toBe(true);
    doc.free();
  });

  it("셀 내용이 비슷해도 셀 번호·셀 문단 수가 지문에 들어 다른 셀 구조는 대체", () => {
    const { doc, text } = open(fmt);
    text.insert(CELL(0, 0, 0), "같은글");
    text.insert(CELL(1, 0, 0), "같은글");
    const cp = capture(text, CELL(1, 0, 2));
    const id = doc.saveSnapshot();
    text.split(CELL(1, 0, 1)); // 셀 1의 문단 수가 바뀜
    const moved = capture(text, CELL(1, 0, 1));
    doc.restoreSnapshot(id);
    expect(restoreCheckpoint(text, cp).exact).toBe(true);
    expect(restoreCheckpoint(text, moved).exact).toBe(false);
    doc.free();
  });
});
