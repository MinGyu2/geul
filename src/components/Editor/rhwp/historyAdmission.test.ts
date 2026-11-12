// rhwp 기록을 켜는 조건(T010 검토, docs/architecture/rhwp-undo-redo.md "T010 기록 수용·메모리 회계").
// 1) 제품 빌드: 레지스트리가 일반 rhwp 기록을 선언한다(T010 활성화). 세션 선택 없이도 타자·IME 기록을 남긴다.
//    `{ history: false }`만 기록을 끈다.
// 2) 깊이 어림: 원본 크기(보수적이지 않음 — 실측 근거는 설계 문서). 열기 때의 선형 메모리 증가는 그림 많은 문서에서 과대라 쓰지 않는다.
// 3) 증가 감시: 기록을 켠 뒤 선형 메모리가 예산보다 더 자라면 새 그룹을 찍지 않고 기록을 끈다(limit, 편집은 계속).
import { describe, expect, it } from "vitest";
import { commandDefinition } from "../../../commands/registry";
import { DocumentSessions } from "../../../adapters/sessions";
import { HISTORY_BUDGET_BYTES, HistoryRefused, RhwpHistory } from "./rhwpHistory";
import { RhwpEditorSession } from "./RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
import { base, controlledBackend, FakeDocument, flush, info, loaded, ok, readySession } from "./testing";

const MiB = 1024 * 1024;

/** 선형 메모리를 흉내 내는 모듈: 문서를 열 때 openGrowth만큼 자란다. grow()로 시험이 더 키운다. */
async function memorySession(openGrowth: number, bytes = 1024) {
  const { backend, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwp");
  take("open").reply(ok(base));
  await opening;
  const doc = new FakeDocument(["가나다", "abc"]);
  const memory = { bytes: 16 * MiB };
  const module: RhwpModule = {
    openDocument: () => { memory.bytes += openGrowth; return doc as unknown as RhwpDocument; },
    memoryBytes: () => memory.bytes,
  };
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module, { history: true });
  const loading = editor.load();
  take("load").reply(loaded(new Uint8Array(bytes)));
  await flush();
  take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
  take("setState").reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
  await loading;
  return { editor, doc, memory };
}

describe("제품 빌드(일반 history 지원, T010 활성화)의 세션 기록", () => {
  it("레지스트리는 rhwp 실행 취소·다시 실행을 범위 제한 없이(일반 기록) 지원한다", () => {
    expect(commandDefinition("edit.undo")?.engines?.rhwp).toEqual({ level: "supported" });
    expect(commandDefinition("edit.redo")?.engines?.rhwp).toEqual({ level: "supported" });
  });

  it("일반 빌드: 세션 선택 없이도 타자·지우기를 일반 기록 단계로 남기고 실행 취소·다시 실행한다", async () => {
    const { editor, doc } = await readySession(["가나다", "abc"], {});
    expect(editor.advancedHistoryOnly).toBe(false);
    editor.typeText("x");
    expect(doc.snapshots.length).toBe(1);
    expect(editor.snapshot()).toMatchObject({ history: { undo: true, redo: false }, historyLimited: false });
    expect(editor.snapshot().historyScope).toBeUndefined();
    expect(editor.execute("edit.undo")).toEqual({ accepted: true });
    expect(doc.paragraphs[0]).toBe("가나다");
    expect(editor.execute("edit.redo")).toEqual({ accepted: true });
    expect(doc.paragraphs[0]).toBe("x가나다");
  });

  it("기록을 명시적으로 끈 세션은 실행 취소를 하지 않는다", async () => {
    const { editor, doc } = await readySession(["가나다", "abc"], { history: false });
    editor.typeText("x");
    expect(doc.snapshots).toEqual([]);
    expect(editor.snapshot().history).toBeNull();
    expect(editor.execute("edit.undo")).toEqual({ accepted: false });
    expect(doc.paragraphs[0]).toBe("x가나다");
  });

  it("전체 기록을 명시한 시험 구성은 그룹 시작마다 스냅숏을 찍는다(대조)", async () => {
    const { editor, doc } = await readySession(["가나다", "abc"], { history: true });
    editor.typeText("x");
    expect(doc.snapshots.length).toBe(1);
    expect(editor.snapshot().history).toEqual({ undo: true, redo: false });
  });
});

describe("기록 깊이 어림은 원본 크기(열기 선형 메모리 증가는 쓰지 않음)", () => {
  it("열며 선형 메모리가 크게 자라도(그림 많은 문서의 파싱 임시 공간) 원본 크기로 깊이를 정해 기록을 켠다", async () => {
    const { editor, doc } = await memorySession(60 * MiB);
    expect(editor.snapshot().history).not.toBeNull();
    expect(editor.snapshot().historyLimited).toBe(false);
    editor.typeText("x");
    expect(doc.snapshots.length).toBe(1);
  });
});

describe("선형 메모리 증가 감시(새 그룹 찍기 전)", () => {
  it("RhwpHistory: 켠 뒤 증가가 예산을 넘으면 찍지 않고 limit으로 거절, 넘지 않으면 찍음", () => {
    let memory = 100 * MiB;
    let saves = 0;
    const engine = {
      saveSnapshot: () => saves++,
      restoreSnapshot: () => "{}",
      discardSnapshot: () => {},
      snapshotCapacity: () => 100,
    };
    const history = new RhwpHistory(engine, 10, () => 0, () => memory);
    memory += HISTORY_BUDGET_BYTES; // 정확히 예산만큼은 받는다
    history.begin("typing", "a", () => null);
    history.commit("b");
    expect(saves).toBe(1);
    memory += 1;
    expect(() => history.begin("other", null, () => null)).toThrow(HistoryRefused);
    expect(saves).toBe(1);
    expect(history.transactionOpen).toBe(false);
    expect(history.violations()).toEqual([]);
    // 실행 취소의 지금 상태 찍기는 I2의 자리 안이라 막지 않는다(되돌릴 수 있는 기록을 쓸 수 있게).
    history.undo(() => null);
    expect(saves).toBe(2);
    expect(history.steps).toEqual({ undo: 0, redo: 1 });
  });

  it("세션: 감시에 걸리면 기록을 끄고(limit) 그 편집은 그대로 한다 — 문서·revision 계속, 불확실 아님", async () => {
    const { editor, doc, memory } = await memorySession(1 * MiB);
    editor.typeText("x");
    expect(doc.snapshots.length).toBe(1);
    memory.bytes += HISTORY_BUDGET_BYTES + 1;
    editor.moveHorizontal(1, false);
    expect(editor.typeText("y")).toBe(true);
    expect(doc.paragraphs[0]).toContain("y");
    expect(editor.snapshot().history).toBeNull();
    expect(editor.snapshot().historyLimited).toBe(true);
    expect(editor.snapshot().editable).toBe(true);
    expect(doc.snapshots).toEqual([]); // 끈 기록의 스냅숏은 엔진에서도 버렸다
  });
});
