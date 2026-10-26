// rhwp 기록의 메모리 감시 계약(T010 교정, docs/architecture/rhwp-undo-redo.md "T010 교정: 메모리 감시"). 읽은 값은 0 이상의 안전한
// 정수이고 같은 모듈에서 줄지 않아야 한다. 없음·예외·NaN·Infinity·음수·소수·다른 타입·감소는 "측정 불가"이며 0 같은 그럴듯한 값으로
// 바꾸지 않는다. 측정 불가는 unavailable(예산 초과 limit과 구별), 스냅숏을 새로 찍는 모든 경로(새 그룹, 실행 취소의 지금 상태)에서
// 엔진을 부르기 전에 거절한다. 세션은 기록을 끄고 편집은 계속한다(엔진은 믿을 수 있음). 진짜 찍기 trap은 지금처럼 불확실.
import { describe, expect, it } from "vitest";
import { DocumentSessions } from "../../../adapters/sessions";
import { HISTORY_BUDGET_BYTES, HistoryRefused, RhwpHistory } from "./rhwpHistory";
import { RhwpEditorSession } from "./RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
import { base, controlledBackend, FakeDocument, flush, info, loaded, ok } from "./testing";

const MiB = 1024 * 1024;
const START = 64 * MiB;

function engine() {
  let next = 0;
  const store = new Set<number>();
  const e = {
    saves: 0, restores: 0, discards: 0,
    saveSnapshot: () => { e.saves += 1; store.add(next); return next++; },
    restoreSnapshot: (id: number) => {
      if (!store.has(id)) throw new Error(`스냅샷 ${id} 없음`);
      e.restores += 1;
      return "{}";
    },
    discardSnapshot: (id: number) => { e.discards += 1; store.delete(id); },
    snapshotCapacity: () => 100,
    get stored() { return store.size; },
  };
  return e;
}

/** 시험이 정하는 측정값 열. read가 함수면 부르고, 값이면 돌려준다. */
function probe(...initial: unknown[]) {
  const p = { value: (initial.length ? initial[0] : START) as unknown, calls: 0, read: () => { p.calls += 1; if (typeof p.value === "function") return (p.value as () => unknown)(); return p.value; } };
  return p;
}
const thrower = () => { throw new Error("memory"); };
const INVALID: [string, unknown][] = [
  ["없음(null)", null], ["없음(undefined)", undefined], ["예외", thrower], ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY],
  ["음수", -1], ["소수", START + 0.5], ["문자열", String(START)], ["bigint", BigInt(START)], ["안전 정수 밖", 2 ** 53],
];

function history(p = probe()) {
  const e = engine();
  const h = new RhwpHistory(e, 10, () => 0, p.read as () => number);
  return { e, h, p };
}
function group(h: RhwpHistory, k: number) {
  h.begin("other", null, () => null);
  h.commit(`g${k}`);
}

describe("RhwpHistory 측정 계약", () => {
  it.each(INVALID)("시작 측정이 %s이면 기록을 만들지 않는다(unavailable)", (_label, value) => {
    const e = engine();
    const p = probe(value);
    expect(() => new RhwpHistory(e, 10, () => 0, p.read as () => number)).toThrow(new HistoryRefused("unavailable"));
    expect(e.saves).toBe(0);
  });

  it.each(INVALID)("유효한 시작 뒤 %s: 새 그룹을 찍기 전에 unavailable로 거절, 엔진·시간선·트랜잭션 그대로", (_label, value) => {
    const { e, h, p } = history();
    group(h, 0);
    const before = { saves: e.saves, discards: e.discards, steps: h.steps, refs: h.referenced() };
    p.value = value;
    let refused: unknown;
    try { h.begin("other", null, () => null); } catch (error) { refused = error; }
    expect(refused).toBeInstanceOf(HistoryRefused);
    expect((refused as HistoryRefused).reason).toBe("unavailable");
    expect({ saves: e.saves, discards: e.discards, steps: h.steps, refs: h.referenced() }).toEqual(before);
    expect(h.transactionOpen).toBe(false);
    expect(h.violations()).toEqual([]);
  });

  it("감소(단조성 위반)는 측정 불가다", () => {
    const { e, h, p } = history();
    group(h, 0);
    p.value = START - 1;
    expect(() => h.begin("other", null, () => null)).toThrow(new HistoryRefused("unavailable"));
    expect(e.saves).toBe(1);
  });

  it("경계: 정확히 예산만큼 자라면 받고, 1바이트 넘으면 limit(측정 불가와 구별)", () => {
    const { e, h, p } = history();
    p.value = START + HISTORY_BUDGET_BYTES;
    group(h, 0);
    expect(e.saves).toBe(1);
    p.value = START + HISTORY_BUDGET_BYTES + 1;
    expect(() => h.begin("other", null, () => null)).toThrow(new HistoryRefused("limit"));
    expect(e.saves).toBe(1);
  });

  it("실행 취소의 지금 상태 찍기: 측정 불가면 복원 전에 거절(문서·커서·저장소 그대로), 예산 초과는 I2 자리라 받는다", () => {
    const { e, h, p } = history();
    group(h, 0);
    group(h, 1);
    p.value = Number.NaN;
    expect(() => h.undo(() => null)).toThrow(new HistoryRefused("unavailable"));
    expect(e.restores).toBe(0);
    expect(e.saves).toBe(2);
    expect(h.steps).toEqual({ undo: 2, redo: 0 });
    p.value = START + HISTORY_BUDGET_BYTES + MiB;
    h.undo(() => null);
    expect(e.saves).toBe(3);
    expect(h.steps).toEqual({ undo: 1, redo: 1 });
    expect(h.violations()).toEqual([]);
  });

  it("다시 실행 가지가 있을 때: 할당 없는 실행 취소·다시 실행·새 편집 시작은 측정하지 않는다, 할당하는 다음 그룹은 거절", () => {
    const { e, h, p } = history();
    group(h, 0);
    group(h, 1);
    h.undo(() => null); // 지금 상태를 찍음(유효 측정)
    const calls = p.calls;
    p.value = thrower;
    h.undo(() => null); // 대상이 이미 찍혀 있어 할당 없음
    h.redo();
    expect(p.calls).toBe(calls);
    expect(h.steps).toEqual({ undo: 1, redo: 1 });
    h.begin("other", null, () => null); // 다시 실행 가지 위: 지금 상태가 이미 있다(할당 없음)
    h.commit("x"); // 다시 실행을 버림
    expect(h.steps).toEqual({ undo: 2, redo: 0 });
    expect(() => h.begin("other", null, () => null)).toThrow(new HistoryRefused("unavailable"));
    expect(h.violations()).toEqual([]);
    const live = e.stored;
    const refs = h.referenced().length;
    expect(refs).toBeGreaterThan(0);
    h.release(true);
    expect(e.stored).toBe(live - refs); // 참조 ID를 모두 버림(감시 실패와 무관하게 엔진을 믿을 수 있음)
  });
});

/** 선형 메모리 측정을 시험이 정하는 세션. */
async function session(memory: unknown | "absent") {
  const { backend, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwp");
  take("open").reply(ok(base));
  await opening;
  const doc = new FakeDocument(["가나다", "abc"]);
  const p = probe(memory);
  const module: RhwpModule = memory === "absent"
    ? { openDocument: () => doc as unknown as RhwpDocument }
    : { openDocument: () => doc as unknown as RhwpDocument, memoryBytes: p.read as () => number };
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module, { history: true });
  const loading = editor.load();
  take("load").reply(loaded());
  await flush();
  take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
  take("setState").reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
  await loading;
  return { editor, doc, p };
}

describe("세션: 측정을 믿을 수 없으면 기록을 켜지 않거나 끈다(편집은 계속)", () => {
  it.each([["모듈에 측정 없음", "absent"], ["시작 측정 예외", thrower], ["시작 측정 NaN", Number.NaN], ["시작 측정 음수", -1]] as [string, unknown][])(
    "%s: 기록 없음(unavailable — limit 아님), 편집은 스냅숏 없이 됨",
    async (_label, memory) => {
      const { editor, doc } = await session(memory);
      expect(editor.snapshot().history).toBeNull();
      expect(editor.snapshot().historyLimited).toBe(false);
      expect(editor.typeText("x")).toBe(true);
      expect(doc.snapshots).toEqual([]);
      expect(editor.hasUncertainChanges).toBe(false);
    },
  );

  it.each([["null", null], ["예외", thrower], ["Infinity", Number.POSITIVE_INFINITY], ["감소", START - MiB]] as [string, unknown][])(
    "유효한 시작 뒤 %s: 다음 그룹에서 기록을 끄고(스냅숏 버림) 그 편집은 한다, revision +1, 불확실 아님",
    async (_label, value) => {
      const { editor, doc, p } = await session(START);
      editor.typeText("x");
      expect(doc.snapshots.length).toBe(1);
      const revision = editor.localRevision;
      p.value = value;
      editor.moveHorizontal(1, false);
      expect(editor.typeText("y")).toBe(true);
      expect(doc.paragraphs[0]).toContain("y");
      expect(editor.localRevision).toBe(revision + 1);
      expect(editor.snapshot().history).toBeNull();
      expect(editor.snapshot().historyLimited).toBe(false);
      expect(editor.snapshot().editable).toBe(true);
      expect(editor.hasUncertainChanges).toBe(false);
      expect(doc.snapshots).toEqual([]);
      expect(editor.undo()).toBe(false);
    },
  );

  it("실행 취소 중 측정 불가: 문서·revision 그대로, 기록을 끔(unavailable)", async () => {
    const { editor, doc, p } = await session(START);
    editor.typeText("x");
    const text = [...doc.paragraphs];
    const revision = editor.localRevision;
    p.value = thrower;
    expect(editor.undo()).toBe(false);
    expect(doc.paragraphs).toEqual(text);
    expect(editor.localRevision).toBe(revision);
    expect(editor.snapshot().history).toBeNull();
    expect(editor.snapshot().historyLimited).toBe(false);
    expect(editor.typeText("z")).toBe(true);
  });

  it("측정이 유효해도 진짜 찍기 trap은 지금처럼 불확실·편집 멈춤", async () => {
    const { editor, doc } = await session(START);
    doc.failSnapshot = true;
    expect(editor.typeText("a")).toBe(false);
    expect(editor.hasUncertainChanges).toBe(true);
    expect(editor.status.kind).toBe("failed");
  });
});
