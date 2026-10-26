// rhwp 실행 취소 기록(T010 Phase 2). 1부: RhwpHistory 알고리즘 경계(엔진 흉내 — 고정 rhwp의 상한·말없는 넘침 지우기·"없음"
// 오류를 그대로 흉내, 실제 엔진 증거는 tests/integration/rhwp/undo.wasm.test.ts·tests/poc/t010-phase0/history_boundary.mjs).
// 2부: RhwpEditorSession 통합의 상태 전이(가짜 문서 FakeDocument — 실패 주입·revision·IME 거절·명령 상태).
import { describe, expect, it } from "vitest";
import { documentCommandState } from "../../../commands/capability";
import type { DocumentCommandSnapshot } from "../../../commands/target";
import {
  HISTORY_IDLE_MS, HistoryFailure, HistoryRefused, RhwpHistory, historyBudget, type SnapshotEngine,
} from "./rhwpHistory";
import { FakeDocument, flush, info, ok, readySession } from "./testing";

/** 알고리즘 시험의 선형 메모리 측정: 늘 같은 유효 값(감시는 memoryMonitoring.test.ts가 따로 본다). */
const FIXED_MEMORY = () => 0;
const NOW = () => performance.now();

/** 고정 rhwp 스냅숏 저장소 흉내. 상태는 정수(편집마다 바뀜). capacity는 바꿀 수 있다(고정 판이 바뀐 경우). */
function engine(initialCapacity = 100) {
  let state = 0;
  let next = 0;
  let store: [number, number][] = [];
  const e = {
    capacity: initialCapacity,
    saves: 0,
    saveSnapshot: () => {
      e.saves += 1;
      store.push([next, state]);
      while (store.length > e.capacity) store.shift();
      return next++;
    },
    restoreSnapshot: (id: number) => {
      const hit = store.find(([sid]) => sid === id);
      if (!hit) throw new Error(`렌더링 오류: 스냅샷 ${id} 없음`);
      state = hit[1];
      return '{"ok":true}';
    },
    discardSnapshot: (id: number) => {
      store = store.filter(([sid]) => sid !== id);
    },
    snapshotCapacity: () => e.capacity,
    edit: (k: number) => {
      state = state * 31 + k + 1;
    },
    get state() { return state; },
    has: (id: number) => store.some(([sid]) => sid === id),
    get size() { return store.length; },
  };
  return e satisfies SnapshotEngine;
}

function group(history: RhwpHistory, e: ReturnType<typeof engine>, k: number) {
  history.begin("other", `g${k}`, () => null);
  e.edit(k);
  history.commit(`g${k}-end`);
}

describe("RhwpHistory 알고리즘(엔진 흉내)", () => {
  it.each([4, 5])("깊이 %i: 10그룹 → 정확히 깊이만큼 실행 취소 → 모두 다시 실행, 상태가 그 시점과 같음", (depth) => {
    const e = engine();
    const h = new RhwpHistory(e, depth, NOW, FIXED_MEMORY);
    const timeline = [e.state];
    for (let k = 0; k < 10; k++) {
      group(h, e, k);
      timeline.push(e.state);
      expect(h.violations()).toEqual([]);
    }
    let undone = 0;
    while (h.canUndo) {
      h.undo(() => null);
      undone += 1;
      expect(e.state).toBe(timeline[10 - undone]);
      expect(h.violations()).toEqual([]);
    }
    expect(undone).toBe(depth);
    expect(() => h.undo(() => null)).toThrow(HistoryRefused);
    while (h.canRedo) h.redo();
    expect(e.state).toBe(timeline[10]);
    expect(() => h.redo()).toThrow(HistoryRefused);
    for (const id of h.referenced()) expect(e.has(id)).toBe(true);
  });

  it("깊이 상한 97(스냅숏 98) · 누적 할당 130회: 엔진 저장소가 98을 넘지 않고 참조 ID가 모두 남음", () => {
    const e = engine();
    const h = new RhwpHistory(e, 97, NOW, FIXED_MEMORY);
    for (let k = 0; k < 130; k++) group(h, e, k);
    for (let k = 0; k < 97; k++) h.undo(() => null);
    expect(h.canUndo).toBe(false);
    expect(e.saves).toBeGreaterThan(100);
    expect(e.size).toBeLessThanOrEqual(98);
    for (const id of h.referenced()) expect(e.has(id)).toBe(true);
    expect(h.violations()).toEqual([]);
  });

  it("다시 실행은 할당하지 않고, 실행 취소 뒤 새 편집은 다시 실행 스냅숏을 엔진에서 버림", () => {
    const e = engine();
    const h = new RhwpHistory(e, 5, NOW, FIXED_MEMORY);
    for (let k = 0; k < 4; k++) group(h, e, k);
    h.undo(() => null);
    h.undo(() => null);
    const saves = e.saves;
    h.redo();
    h.undo(() => null);
    expect(e.saves).toBe(saves);
    const before = e.size;
    group(h, e, 99);
    expect(h.canRedo).toBe(false);
    expect(e.size).toBeLessThan(before + 1);
    expect(h.violations()).toEqual([]);
  });

  it("엔진 상한이 줄면: 실행 취소 대상(ID 보호)은 남기고 가장 오래된 과거를 지움", () => {
    const e = engine();
    const h = new RhwpHistory(e, 5, NOW, FIXED_MEMORY);
    const timeline = [e.state];
    for (let k = 0; k < 3; k++) {
      group(h, e, k);
      timeline.push(e.state);
    }
    e.capacity = 5; // limit = 3, live 3 → 지금 상태를 찍으려면 하나를 지워야 함
    h.undo(() => null);
    expect(e.state).toBe(timeline[2]);
    expect(h.steps).toEqual({ undo: 1, redo: 1 });
    for (const id of h.referenced()) expect(e.has(id)).toBe(true);
  });

  it("지울 수 있는 후보가 없으면 엔진을 부르기 전에 거절하고 상태·기록이 그대로", () => {
    const e = engine();
    const h = new RhwpHistory(e, 5, NOW, FIXED_MEMORY);
    group(h, e, 0);
    e.capacity = 3; // limit 1: 대상만 남아 지금 상태를 찍을 자리가 없음
    const state = e.state;
    const saves = e.saves;
    expect(() => h.undo(() => null)).toThrow(expect.objectContaining({ reason: "limit" }));
    expect([e.state, e.saves, h.steps.undo, h.state]).toEqual([state, saves, 1, "ok"]);
  });

  it("이어 쓰기: 같은 종류·이어진 자리·쉼 ≤ 1.5초만, 쉼이 길면 새 단계", () => {
    const e = engine();
    let now = 0;
    const h = new RhwpHistory(e, 10, () => now, FIXED_MEMORY);
    for (const [start, end] of [["a", "b"], ["b", "c"], ["c", "d"]]) {
      h.begin("typing", start!, () => null);
      e.edit(1);
      h.commit(end!);
      now += 100;
    }
    expect(h.steps.undo).toBe(1);
    now += HISTORY_IDLE_MS + 1;
    h.begin("typing", "d", () => null);
    h.commit("e");
    expect(h.steps.undo).toBe(2);
    h.begin("deleteBack", "e", () => null); // 다른 종류
    h.commit("d");
    h.begin("typing", null, () => null); // 선택 바꾸기(이어 쓰지 않음)
    h.commit("x");
    expect(h.steps.undo).toBe(4);
    h.boundary();
    h.begin("typing", "x", () => null);
    h.commit("y");
    expect(h.steps.undo).toBe(5);
  });

  it("취소한 트랜잭션은 찍은 스냅숏을 버리고 단계를 만들지 않음 / 트랜잭션 중 실행 취소 거절", () => {
    const e = engine();
    const h = new RhwpHistory(e, 5, NOW, FIXED_MEMORY);
    group(h, e, 0);
    h.begin("typing", "z", () => null);
    expect(() => h.undo(() => null)).toThrow(expect.objectContaining({ reason: "transaction" }));
    h.cancel();
    expect([h.steps.undo, h.live, e.size]).toEqual([1, 1, 1]);
  });

  it("실패: 찍기 예외는 불확실·broken, 기록 밖에서 버려진 ID는 '없음'(불확실 아님), 그 밖의 복원 예외는 불확실", () => {
    const e1 = engine();
    const h1 = new RhwpHistory({ ...e1, snapshotCapacity: () => 100, saveSnapshot: () => { throw new Error("RuntimeError: unreachable"); } }, 5, NOW, FIXED_MEMORY);
    expect(() => h1.begin("other", "a", () => null)).toThrow(expect.objectContaining({ kind: "snapshot-failed", uncertain: true }));
    expect(h1.state).toBe("broken");
    const e2 = engine();
    const h2 = new RhwpHistory(e2, 5, NOW, FIXED_MEMORY);
    group(h2, e2, 0);
    e2.discardSnapshot(h2.referenced()[0]!);
    const state = e2.state;
    expect(() => h2.undo(() => null)).toThrow(expect.objectContaining({ kind: "snapshot-missing", uncertain: false }));
    expect(e2.state).toBe(state);
    const e3 = engine();
    const h3 = new RhwpHistory({ ...e3, snapshotCapacity: () => 100, saveSnapshot: e3.saveSnapshot, restoreSnapshot: () => { throw new Error("RuntimeError: unreachable"); } }, 5, NOW, FIXED_MEMORY);
    group(h3, e3, 0);
    expect(() => h3.undo(() => null)).toThrow(HistoryFailure);
    expect(h3.state).toBe("broken");
  });

  it("무작위 2만 단계(깊이 4·5·97): 매 단계 불변식, 엔진 저장소 ≤ 상한 − 2, 끝에 참조 ID 모두 남음", () => {
    for (const depth of [4, 5, 97]) {
      const e = engine();
      const h = new RhwpHistory(e, depth, NOW, FIXED_MEMORY);
      let seed = 7 + depth;
      const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
      let end = 0;
      for (let step = 0; step < 20000; step++) {
        const r = rand();
        try {
          if (r < 0.35) {
            h.begin("typing", `p${end}`, () => null);
            e.edit(step);
            end += 1;
            h.commit(`p${end}`);
          } else if (r < 0.5) {
            h.boundary();
            group(h, e, step);
          } else if (r < 0.55) {
            h.begin("other", `c${step}`, () => null);
            h.cancel();
          } else if (r < 0.8) {
            if (h.canUndo) h.undo(() => null);
          } else if (h.canRedo) h.redo();
        } catch (error) {
          if (!(error instanceof HistoryRefused)) throw error;
        }
        expect(h.violations()).toEqual([]);
        expect(e.size).toBeLessThanOrEqual(98);
      }
      for (const id of h.referenced()) expect(e.has(id)).toBe(true);
    }
  });

  it("예산: 자르기 전에 최소 깊이 확인(아주 큰 문서는 끔), 경계 raw 5 → 깊이 4, raw 4 → 끔", () => {
    const MB = 1024 * 1024;
    expect(historyBudget(300 * MB, 100).enabled).toBe(false);
    expect(historyBudget(256 * MB / 7, 100)).toEqual({ enabled: true, depth: 4, snapshots: 5 });
    expect(historyBudget(256 * MB / 6, 100).enabled).toBe(false);
    expect(historyBudget(13_000, 100)).toEqual({ enabled: true, depth: 50, snapshots: 51 });
    expect(historyBudget(13_000, 6).enabled).toBe(false);
  });
});

// ---- 2부: 세션 통합(가짜 문서) ----

const undoCount = (s: { editor: { snapshot(): DocumentCommandSnapshot } }) => s.editor.snapshot().history;

describe("RhwpEditorSession 실행 취소 통합(가짜 문서)", () => {
  it("실행 취소·다시 실행: 내용·커서 복원, 변경 1개씩(revision을 줄이지 않음), modified 남음, 모델 판 올림", async () => {
    const { editor, doc } = await readySession(["가나다", "abc"]);
    editor.typeText("x");
    expect(doc.paragraphs[0]).toBe("x가나다");
    const version = editor.modelVersion;
    expect(editor.undo()).toBe(true);
    expect(doc.paragraphs[0]).toBe("가나다");
    expect(editor.caret).toEqual({ section: 0, paragraph: 0, offset: 0 });
    expect(editor.localRevision).toBe(2);
    expect(editor.modelVersion).toBeGreaterThan(version);
    expect(editor.hasUnpreservedChanges).toBe(true);
    expect(undoCount({ editor })).toEqual({ undo: false, redo: true });
    expect(editor.redo()).toBe(true);
    expect(doc.paragraphs[0]).toBe("x가나다");
    expect(editor.caret).toEqual({ section: 0, paragraph: 0, offset: 1 });
    expect(editor.localRevision).toBe(3);
    expect(editor.redo()).toBe(false);
    expect(editor.localRevision).toBe(3);
  });

  it("이어 친 글자는 한 단계, 이동이 끊고, Backspace 연속은 한 단계", async () => {
    const { editor, doc } = await readySession(["가나다"]);
    for (const ch of "abc") editor.typeText(ch);
    editor.moveHorizontal(-1, false);
    editor.moveHorizontal(1, false);
    editor.typeText("d");
    editor.backspace();
    editor.backspace();
    expect(editor.localRevision).toBe(6);
    expect(editor.undo()).toBe(true); // ⌫⌫
    expect(doc.paragraphs[0]).toBe("abcd가나다");
    expect(editor.undo()).toBe(true); // d
    expect(doc.paragraphs[0]).toBe("abc가나다");
    expect(editor.undo()).toBe(true); // abc
    expect(doc.paragraphs[0]).toBe("가나다");
    expect(editor.undo()).toBe(false);
  });

  it("실행 취소 뒤 새 편집은 다시 실행을 버림", async () => {
    const { editor } = await readySession(["가"]);
    editor.typeText("a");
    editor.undo();
    editor.typeText("b");
    expect(editor.redo()).toBe(false);
    expect(editor.snapshot().history).toEqual({ undo: true, redo: false });
  });

  it("조합: 시작만 한 상태(갱신 전)에도 실행 취소 거절, 갱신은 단계가 아니고 끝에서 단계 1", async () => {
    const { editor, doc } = await readySession(["가"]);
    editor.typeText("a");
    editor.moveHorizontal(1, false);
    editor.beginComposition(); // 아직 모델을 바꾸지 않음 — 기록의 트랜잭션도 아직 없다
    expect(editor.undo()).toBe(false);
    expect(editor.snapshot().composing).toBe(true);
    expect(doc.paragraphs[0]).toBe("a가");
    editor.updateComposition("ㄴ");
    editor.updateComposition("나");
    expect(editor.undo()).toBe(false);
    editor.endComposition("나");
    expect(doc.paragraphs[0]).toBe("a가나");
    expect(editor.undo()).toBe(true);
    expect(doc.paragraphs[0]).toBe("a가");
    expect(editor.undo()).toBe(true);
    expect(doc.paragraphs[0]).toBe("가");
  });

  it("선택 없이 조합 취소는 단계를 만들지 않고, 선택을 지운 뒤 취소는 실행 취소가 지운 글자를 되살림", async () => {
    const { editor, doc } = await readySession(["가나다"]);
    editor.beginComposition();
    editor.updateComposition("ㄱ");
    editor.endComposition("");
    expect(editor.snapshot().history).toEqual({ undo: false, redo: false });
    editor.moveHorizontal(1, true);
    editor.moveHorizontal(1, true);
    editor.beginComposition();
    editor.updateComposition("ㄱ");
    editor.endComposition("");
    expect(doc.paragraphs[0]).toBe("다");
    expect(editor.undo()).toBe(true);
    expect(doc.paragraphs[0]).toBe("가나다");
    expect(editor.caret.offset).toBe(2);
    expect(editor.anchor.offset).toBe(0);
  });

  it("provisional: 최종 글자를 기다리는 동안 실행 취소 거절(실행 명령 경로도), 해결 뒤 단계 1", async () => {
    const { editor, doc } = await readySession(["가"]);
    editor.typeText("a");
    editor.beginComposition();
    editor.updateComposition("하");
    editor.endComposition("하", { provisional: true });
    expect(editor.undo()).toBe(false);
    expect(editor.execute("edit.undo")).toEqual({ accepted: false });
    editor.resolveProvisional("한");
    expect(doc.paragraphs[0]).toBe("a한가");
    // 바로 이어 친 글자(a)와 그 끝 자리에서 시작한 조합(한)은 한 타자 그룹이다(설계 §6) — 실행 취소 한 번에 둘 다.
    expect(editor.snapshot().history).toEqual({ undo: true, redo: false });
    expect(editor.undo()).toBe(true);
    expect(doc.paragraphs[0]).toBe("가");
    expect(editor.undo()).toBe(false);
  });

  it("다시 불러오기·닫기는 기록을 비운다(스냅숏은 문서와 함께 놓음)", async () => {
    const s = await readySession(["가"]);
    s.editor.typeText("a");
    s.editor.undo();
    const reloading = s.editor.load({ discard: true });
    s.take("load").reply({ ok: true, value: { generation: 2, bytes: new Uint8Array([1]) } });
    await flush();
    s.take("session").reply(ok(info({ state: "loading", sequence: 3, loadGeneration: 2 })));
    s.take("setState").reply(ok(info({ state: "ready", sequence: 4, loadGeneration: 2 })));
    await reloading;
    expect(s.editor.snapshot().history).toEqual({ undo: false, redo: false });
    expect(s.doc.freed).toBe(true);
    s.editor.dispose();
    expect(s.editor.snapshot().history).toBeNull();
  });

  it("스냅숏 찍기 실패: 편집하지 않고 불확실·편집 멈춤(저장 차단)", async () => {
    const { editor, doc } = await readySession(["가"]);
    doc.failSnapshot = true;
    expect(editor.typeText("a")).toBe(false);
    expect(doc.paragraphs[0]).toBe("가");
    expect(editor.hasUncertainChanges).toBe(true);
    expect(editor.status.kind).toBe("failed");
    expect(editor.snapshot().history).toBeNull();
  });

  it("복원 예외: 불확실·편집 멈춤, revision을 세지 않음", async () => {
    const { editor, doc } = await readySession(["가"]);
    editor.typeText("a");
    doc.failRestore = true;
    const revision = editor.localRevision;
    expect(editor.undo()).toBe(false);
    expect(editor.hasUncertainChanges).toBe(true);
    expect(editor.status.kind).toBe("failed");
    expect(editor.localRevision).toBe(revision);
  });

  it("기록 밖에서 지워진 스냅숏(없음): 문서 그대로, 불확실 아님, 기록만 끄고 편집은 계속", async () => {
    const { editor, doc } = await readySession(["가"]);
    editor.typeText("a");
    doc.snapshots = [];
    expect(editor.undo()).toBe(false);
    expect(doc.paragraphs[0]).toBe("a가");
    expect(editor.hasUncertainChanges).toBe(false);
    expect(editor.status.kind).toBe("ready");
    expect(editor.snapshot().history).toBeNull();
    expect(editor.typeText("b")).toBe(true);
  });

  it("복원 뒤 쪽 정보 실패: 변경은 센 채로 편집 멈춤(render)", async () => {
    const { editor, doc } = await readySession(["가"]);
    editor.typeText("a");
    const original = doc.getPageInfo.bind(doc);
    doc.getPageInfo = () => { throw new Error("render"); };
    expect(editor.undo()).toBe(true);
    expect(editor.localRevision).toBe(2);
    expect(editor.status).toMatchObject({ kind: "failed", error: { code: "EngineFailure", stage: "render" } });
    doc.getPageInfo = original;
  });

  it("백엔드 확정 거절 뒤 기록을 쓰지 않음", async () => {
    const { editor, take } = await readySession(["가"]);
    editor.typeText("a");
    take("commit").reply({ ok: false, error: { code: "RevisionMismatch", sessionId: 1, revision: 5 } });
    await flush();
    expect(editor.status.kind).toBe("failed");
    expect(editor.undo()).toBe(false);
    expect(editor.snapshot().history).toBeNull();
  });

  it("큰 문서(예산 밖)는 기록을 끄고 limit으로 알림", () => {
    const base = { sessionId: 1, engine: "wordcraft", loadGeneration: 1, revision: 0, loaded: true, editable: true, composing: false,
      pending: false, queuedHistory: null, saving: false, history: null, format: null, formatAccess: null } as const;
    expect(documentCommandState("edit.undo", { ...base, historyLimited: true })).toEqual({ available: false, reason: "limit" });
    expect(documentCommandState("edit.undo", { ...base })).toEqual({ available: false, reason: "engineUnsupported" });
  });

  it("레지스트리가 rhwp 실행 취소를 지원으로 바꾸기 전에는 execute가 거절한다(세션 기록이 있어도)", async () => {
    const { editor, doc } = await readySession(["가"]);
    editor.typeText("a");
    expect(editor.snapshot().history).toEqual({ undo: true, redo: false });
    expect(editor.execute("edit.undo")).toEqual({ accepted: false });
    expect(doc.paragraphs[0]).toBe("a가");
  });
});

void FakeDocument;


describe("스냅숏 폐기 예외의 실패 계약", () => {
  function failing(depth = 2) {
    const e = engine();
    let fails = false;
    const calls: number[] = [];
    const h = new RhwpHistory({ ...e, snapshotCapacity: () => e.capacity, discardSnapshot(id) {
      calls.push(id);
      if (fails) throw new Error("RuntimeError: unreachable");
      e.discardSnapshot(id);
    } }, depth, NOW, FIXED_MEMORY);
    return { e, h, calls, fail: () => { fails = true; } };
  }
  it.each(["reserve", "redo", "cancel", "release", "commit"] as const)("%s: 폐기 실패는 즉시 중단·typed uncertain, 같은 ID 재폐기 없음", (boundary) => {
    const { e, h, calls, fail } = failing();
    group(h, e, 0);
    let operation: () => void;
    if (boundary === "reserve") {
      group(h, e, 1);
      e.capacity = 4; // 현재 limit=2: 새 그룹을 찍으려면 과거를 먼저 버림
      operation = () => h.begin("other", null, () => null);
    } else if (boundary === "redo") {
      group(h, e, 1); h.undo(() => null);
      h.begin("other", null, () => null); e.edit(3);
      operation = () => h.commit("end");
    } else if (boundary === "cancel") {
      h.begin("other", null, () => null);
      operation = () => h.cancel();
    } else if (boundary === "release") operation = () => h.release(true);
    else {
      group(h, e, 1); h.begin("other", null, () => null); e.edit(3);
      operation = () => h.commit("end");
    }
    fail();
    expect(operation).toThrow(expect.objectContaining({ kind: "discard-failed", uncertain: true }));
    expect(h.state).toBe("broken");
    expect([h.canUndo, h.canRedo]).toEqual([false, false]);
    const attempts = [...calls];
    h.release(true); h.release(false);
    expect(calls).toEqual(attempts);
    expect(h.live).toBe(0);
  });

  it.each(["reserve", "commit", "redo", "cancel", "drop"] as const)("세션 %s: 안전하지 않은 편집·저장 차단, stale 검사 무효화", async (boundary) => {
    const s = await readySession(["abc"]);
    if (boundary === "reserve" || boundary === "commit") {
      for (let k = 0; k < 50; k++) { s.editor.typeText("x"); s.editor.endHistoryGroup(); }
    } else s.editor.typeText("x");
    if (boundary === "redo") s.editor.undo();
    if (boundary === "cancel") { s.editor.endHistoryGroup(); s.editor.beginComposition(); s.editor.updateComposition("가"); }
    if (boundary === "reserve") s.doc.snapshotCapacity = () => 52;
    s.doc.discardSnapshot = () => { throw new Error("RuntimeError: unreachable"); };
    const before = s.doc.paragraphs[0];
    if (boundary === "cancel") expect(() => s.editor.endComposition("")).not.toThrow();
    else if (boundary === "drop") expect(() => (s.editor as unknown as { dropHistory(r: "unavailable"): void }).dropHistory("unavailable")).not.toThrow();
    else expect(() => s.editor.typeText("y")).not.toThrow();
    expect(s.editor.status.kind).toBe("failed");
    expect(s.editor.editable).toBe(false);
    expect(s.editor.snapshot().history).toBeNull();
    expect(s.editor.lastRoundTrip).toBeNull();
    expect(s.editor.typeText("unsafe")).toBe(false);
    expect(s.editor.undo()).toBe(false);
    if (boundary === "reserve" || boundary === "drop") expect(s.doc.paragraphs[0]).toBe(before);
    expect((await s.editor.save()).ok).toBe(false);
    s.editor.dispose();
    expect(s.doc.freed).toBe(true);
  });
});

it.each([false,true])("Undo 뒤 같은 내용 스냅숏 재사용: 새 편집의 커서/선택을 before로 갱신(selection=%s)", async selected => {
  const {editor,doc}=await readySession(["abc"]);
  editor.typeText("x");expect(editor.undo()).toBe(true);
  editor.moveHorizontal(1,false);if(selected)editor.moveHorizontal(1,true);
  const caret={...editor.caret},anchor={...editor.anchor};
  editor.typeText("y");expect(editor.undo()).toBe(true);
  expect(doc.paragraphs).toEqual(["abc"]);
  expect(editor.caret).toEqual(caret);expect(editor.anchor).toEqual(anchor);
  expect(editor.redo()).toBe(true);editor.dispose();
});


it("snapshot 재사용 뒤 선택 없는 IME 취소는 기존 Redo/checkpoint를 바꾸지 않음", async () => {
  const {editor,doc}=await readySession(["abc"]);
  editor.typeText("x");expect(editor.undo()).toBe(true);
  editor.moveHorizontal(1,false);
  editor.beginComposition();editor.updateComposition("가");editor.endComposition("");
  expect(doc.paragraphs).toEqual(["abc"]);expect(editor.localRevision).toBe(2);
  expect(editor.redo()).toBe(true);expect(editor.undo()).toBe(true);
  expect(doc.paragraphs).toEqual(["abc"]);expect(editor.caret.offset).toBe(0);
  editor.dispose();
});
