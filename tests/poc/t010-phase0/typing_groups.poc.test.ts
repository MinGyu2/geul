// T010 Phase 1 설계 검증(시험 전용): 실제 rhwp WASM 문서로 연 RhwpEditorSession을 바꾸지 않고, 시험용 문서 감싸개(Proxy)가
// 바꾸는 엔진 호출 직전에 history_model.mjs의 기록에 "트랜잭션 시작"을 알린다. 세션의 recordMutation 수(localRevision 증가)를 보고
// 시험이 그룹을 닫는다(committed/canceled). 이것은 제품 통합이 아니다: 실행 취소는 세션 밖에서 엔진 스냅숏으로 하고(세션은 모름),
// 백엔드 확정 수(localRevision)가 그룹 묶기와 무관하게 지금 계약대로 세지는지만 본다. 입력은 세션 메서드 호출(입력기 아님).
//   npx vitest run --config tests/poc/t010-phase0/vitest.config.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentSessions } from "../../../src/adapters/sessions";
import { RhwpEditorSession } from "../../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "../../../src/components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, flush, info, loaded, ok } from "../../../src/components/Editor/rhwp/testing";
// @ts-expect-error 시험 전용 JS 모듈(타입 선언 없음)
import { HistoryRefused, SnapshotHistory } from "./history_model.mjs";

const ROOT = resolve(__dirname, "../../..");
type Engine = { HwpDocument: new (bytes: Uint8Array) => RhwpDocument };
type Snap = { saveSnapshot(): number; restoreSnapshot(id: number): string; discardSnapshot(id: number): void; snapshotCapacity(): number; getTextFileText(): string };
let engine: Engine;
let fixture: Uint8Array;
let scratch: string;

/** rhwpText.ts가 부르는 바꾸는 엔진 함수 전부. */
const MUTATING = new Set([
  "insertText", "insertTextInCell", "deleteText", "deleteTextInCell", "deleteRange", "deleteRangeInCell",
  "splitParagraph", "splitParagraphInCell", "mergeParagraph", "mergeParagraphInCell",
]);

beforeAll(async () => {
  scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "geul-t010-groups-"));
  execFileSync("node", [join(ROOT, "tests/fixtures/rhwp/generate.mjs"), scratch]);
  fixture = new Uint8Array(readFileSync(join(scratch, "basic-ko.hwp")));
  const mod = await import(/* @vite-ignore */ pathToFileURL(join(ROOT, "public/rhwp/rhwp.js")).href);
  mod.initSync({ module: readFileSync(join(ROOT, "public/rhwp/rhwp_bg.wasm")) });
  engine = mod as Engine;
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** 실제 WASM 문서의 세션 + 기록 감싸개. act(kind, 동작, {settle})로 사용자 동작 하나를 한다. */
async function setup() {
  const { backend, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwp");
  take("open").reply(ok(base));
  await opening;
  let raw: Snap | null = null;
  let next: { kind: string; start: string } | null = null;
  let history: InstanceType<typeof SnapshotHistory> | null = null;
  const module: RhwpModule = {
    openDocument: (bytes) => {
      const doc = new engine.HwpDocument(bytes);
      raw = doc as unknown as Snap;
      history = new SnapshotHistory(raw, { depth: 20 });
      return new Proxy(doc, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (MUTATING.has(String(key)) && next) history!.mutationStarting(next.kind, next.start);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    },
  };
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module);
  const loading = editor.load();
  take("load").reply(loaded(fixture));
  await flush();
  take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
  take("setState").reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
  await loading;
  const caret = () => JSON.stringify(editor.markCaret());
  /** 사용자 동작 하나. settle=false면 트랜잭션을 열어 둔다(조합 갱신). 세지 않고 끝나면 canceled. */
  const act = (kind: string, run: () => unknown, options: { settle?: boolean; start?: string } = {}) => {
    const before = editor.localRevision;
    next = { kind, start: options.start ?? caret() };
    run();
    next = null;
    if (options.settle === false) return;
    if (editor.localRevision > before) history!.committed(caret());
    else history!.canceled();
  };
  const navigate = (run: () => unknown) => {
    run();
    history!.boundary();
  };
  return { editor, act, navigate, history: () => history!, raw: () => raw!, text: () => raw!.getTextFileText() };
}

describe("Phase 1 설계: 타자 그룹과 백엔드 확정의 분리(실제 WASM 세션 + 시험용 기록 감싸개)", () => {
  it("글자 하나: 확정 1, 기록 단계 1, 실행 취소로 처음 글", async () => {
    const s = await setup();
    const t0 = s.text();
    s.act("typing", () => s.editor.typeText("a"));
    expect([s.editor.localRevision, s.history().cursor]).toEqual([1, 1]);
    s.history().undo();
    expect(s.text()).toBe(t0);
  });

  it("이어 친 세 글자: 확정 3(그룹이 확정을 늦추지 않음), 단계 1", async () => {
    const s = await setup();
    const t0 = s.text();
    for (const ch of "abc") s.act("typing", () => s.editor.typeText(ch));
    expect([s.editor.localRevision, s.history().cursor, s.history().allocations]).toEqual([3, 1, 1]);
    s.history().undo();
    expect(s.text()).toBe(t0);
  });

  it("이전 설계 반례: 세질 때(recordMutation)마다 단계를 닫으면 이어 친 세 글자가 단계 3 — 묶기 계약과 모순", async () => {
    const s = await setup();
    for (const ch of "abc") {
      s.act("typing", () => s.editor.typeText(ch));
      s.history().boundary(); // 이전 설계 §3 규칙 2: 확정 하나 = 기록 단계 하나
    }
    expect([s.editor.localRevision, s.history().cursor]).toEqual([3, 3]);
  });

  it("사이에 이동: 그룹이 끊겨 단계 2", async () => {
    const s = await setup();
    s.act("typing", () => s.editor.typeText("a"));
    s.navigate(() => s.editor.moveHorizontal(-1, false));
    s.navigate(() => s.editor.moveHorizontal(1, false));
    s.act("typing", () => s.editor.typeText("b"));
    expect([s.editor.localRevision, s.history().cursor]).toEqual([2, 2]);
  });

  it("선택 바꾸기: 지우기+넣기가 새 단계 1(before = 지우기 전), 이어 치기는 그 단계에 묶임", async () => {
    const s = await setup();
    const t0 = s.text();
    s.navigate(() => { s.editor.moveHorizontal(1, true); s.editor.moveHorizontal(1, true); });
    s.act("typing", () => s.editor.typeText("Z"), { start: "selection" });
    s.act("typing", () => s.editor.typeText("Y"));
    expect([s.editor.localRevision, s.history().cursor]).toEqual([2, 1]);
    s.history().undo();
    expect(s.text()).toBe(t0);
  });

  it("문단 나누기: 타자를 끊는다(단계 3, 확정 3)", async () => {
    const s = await setup();
    s.act("typing", () => s.editor.typeText("a"));
    s.act("split", () => s.editor.enter());
    s.act("typing", () => s.editor.typeText("b"));
    expect([s.editor.localRevision, s.history().cursor]).toEqual([3, 3]);
  });

  it("Backspace 연속: 넣기와 다른 그룹, 이어진 지우기는 한 단계(단계 2, 확정 5)", async () => {
    const s = await setup();
    for (const ch of "abc") s.act("typing", () => s.editor.typeText(ch));
    const afterTyping = s.text();
    s.act("deleteBack", () => s.editor.backspace());
    s.act("deleteBack", () => s.editor.backspace());
    expect([s.editor.localRevision, s.history().cursor]).toEqual([5, 2]);
    s.history().undo();
    expect(s.text()).toBe(afterTyping);
  });

  it("한국어 조합 완료: 갱신은 단계를 만들지 않고 끝에서 확정 1·단계 1", async () => {
    const s = await setup();
    const t0 = s.text();
    s.act("typing", () => s.editor.beginComposition(), { settle: false });
    for (const t of ["ㄱ", "가", "간"]) s.act("typing", () => s.editor.updateComposition(t), { settle: false });
    expect(s.history().cursor).toBe(0);
    expect(() => s.history().undo()).toThrow(HistoryRefused);
    s.act("typing", () => s.editor.endComposition("간"));
    expect([s.editor.localRevision, s.history().cursor, s.history().allocations]).toEqual([1, 1, 1]);
    s.history().undo();
    expect(s.text()).toBe(t0);
  });

  it("이어진 조합 둘 + 바로 친 글자: 한 그룹(확정 3, 단계 1)", async () => {
    const s = await setup();
    for (const syllable of ["간", "다"]) {
      s.act("typing", () => s.editor.beginComposition(), { settle: false });
      s.act("typing", () => s.editor.updateComposition(syllable), { settle: false });
      s.act("typing", () => s.editor.endComposition(syllable));
    }
    s.act("typing", () => s.editor.typeText("x"));
    expect([s.editor.localRevision, s.history().cursor]).toEqual([3, 1]);
  });

  it("선택 없이 조합 취소: 확정 0, 단계 0, 찍은 스냅숏은 버림", async () => {
    const s = await setup();
    s.act("typing", () => s.editor.beginComposition(), { settle: false });
    s.act("typing", () => s.editor.updateComposition("가"), { settle: false });
    s.act("typing", () => s.editor.endComposition(""));
    expect([s.editor.localRevision, s.history().cursor, s.history().live, s.history().discarded.size]).toEqual([0, 0, 0, 1]);
  });

  it("선택을 지운 뒤 조합 취소: 지우기 확정 1·단계 1, 실행 취소가 지운 글자를 되살림", async () => {
    const s = await setup();
    const t0 = s.text();
    s.navigate(() => { s.editor.moveHorizontal(1, true); s.editor.moveHorizontal(1, true); });
    s.act("typing", () => s.editor.beginComposition(), { settle: false, start: "selection" });
    s.act("typing", () => s.editor.updateComposition("가"), { settle: false });
    s.act("typing", () => s.editor.endComposition(""));
    expect(s.text()).not.toBe(t0);
    expect([s.editor.localRevision, s.history().cursor]).toEqual([1, 1]);
    s.history().undo();
    expect(s.text()).toBe(t0);
  });

  it("provisional 뒤 다른 최종 글자: 기다리는 동안 실행 취소 거부, 해결에서 확정 1·단계 1", async () => {
    const s = await setup();
    const t0 = s.text();
    s.act("typing", () => s.editor.beginComposition(), { settle: false });
    s.act("typing", () => s.editor.updateComposition("하"), { settle: false });
    s.act("typing", () => s.editor.endComposition("하", { provisional: true }), { settle: false });
    expect(s.editor.localRevision).toBe(0);
    expect(() => s.history().undo()).toThrow(HistoryRefused);
    s.act("typing", () => s.editor.resolveProvisional("한"));
    expect([s.editor.localRevision, s.history().cursor]).toEqual([1, 1]);
    s.history().undo();
    expect(s.text()).toBe(t0);
  });

  it("실행 취소 뒤 새 타자: 다시 실행 기록을 버림", async () => {
    const s = await setup();
    s.act("typing", () => s.editor.typeText("a"));
    s.navigate(() => s.editor.moveHorizontal(1, false));
    s.act("typing", () => s.editor.typeText("b"));
    const afterA = (() => { s.history().undo(); return s.text(); })();
    expect(s.history().canRedo).toBe(true);
    s.navigate(() => undefined);
    s.act("typing", () => s.editor.typeText("c"));
    expect(s.history().canRedo).toBe(false);
    expect(s.history().cursor).toBe(2);
    s.history().undo();
    expect(s.text()).toBe(afterA);
  });
});
