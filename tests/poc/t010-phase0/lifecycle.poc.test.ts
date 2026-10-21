// T010 Phase 0 PoC(시험 전용): 실제 rhwp WASM 문서로 RhwpEditorSession의 편집·IME 조합·확정 수명주기를 관찰한다.
// 백엔드는 시험용 controlledBackend(응답을 시험이 줌)이고, 입력은 세션 메서드 호출(DOM·실제 입력기 아님)이다. 실행 취소는
// 제품에 없으므로 통합하지 않고, 같은 실제 문서에서 엔진 스냅숏을 세션 경계(조합 시작 전·확정 뒤)에 찍어 복원 결과만 본다.
// 관찰값은 PHASE0_LIFECYCLE_OUT(있으면)에 JSON으로 쓴다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentSessions } from "../../../src/adapters/sessions";
import { RhwpEditorSession } from "../../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "../../../src/components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, flush, info, loaded, ok } from "../../../src/components/Editor/rhwp/testing";

const ROOT = resolve(__dirname, "../../..");
type Engine = { HwpDocument: new (bytes: Uint8Array) => RhwpDocument & Record<string, (...args: never[]) => unknown> };
let engine: Engine;
let fixture: Uint8Array;
let scratch: string;
const observed: Record<string, unknown> = {};

beforeAll(async () => {
  scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "geul-t010-p0-c-"));
  execFileSync("node", [join(ROOT, "tests/fixtures/rhwp/generate.mjs"), scratch]);
  fixture = new Uint8Array(readFileSync(join(scratch, "basic-ko.hwp")));
  const mod = await import(/* @vite-ignore */ pathToFileURL(join(ROOT, "public/rhwp/rhwp.js")).href);
  mod.initSync({ module: readFileSync(join(ROOT, "public/rhwp/rhwp_bg.wasm")) });
  engine = mod as Engine;
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (process.env.PHASE0_LIFECYCLE_OUT) writeFileSync(process.env.PHASE0_LIFECYCLE_OUT, JSON.stringify(observed, null, 1));
});

/** 실제 WASM 문서로 연 세션(불러오기 응답은 시험이 준다). */
async function realSession() {
  const { backend, calls, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwp");
  take("open").reply(ok(base));
  await opening;
  const docs: RhwpDocument[] = [];
  const module: RhwpModule = { openDocument: (bytes) => { const d = new engine.HwpDocument(bytes); docs.push(d); return d; } };
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module);
  const loading = editor.load();
  take("load").reply(loaded(fixture));
  await flush();
  take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
  take("setState").reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
  await loading;
  return { editor, calls, take, docs, sessions };
}

/** 세션의 관찰 가능한 수명주기 값(비공개 필드는 시험에서만 읽는다). */
function state(editor: RhwpEditorSession) {
  const e = editor as unknown as { committed: number; pending: number; modified: boolean; uncertain: boolean; committingEpoch: number | null };
  return {
    localRevision: editor.localRevision, committed: e.committed, pending: e.pending, modified: e.modified, uncertain: e.uncertain,
    unpreserved: editor.hasUnpreservedChanges, composing: editor.composing, awaitingEnd: editor.awaitingCompositionEnd,
    modelVersion: editor.modelVersion, paragraph0: editor.caretParagraphText().slice(0, 12),
  };
}
const commits = (calls: { method: string; args: unknown[] }[]) => calls.filter((c) => c.method === "commit").map((c) => c.args);

describe("Phase 0 C: 실제 WASM 문서의 편집·조합 수명주기", () => {
  it("C1 일반 글자 하나: 변경 1개, 확정 응답 뒤 committed 1", async () => {
    const { editor, take } = await realSession();
    const before = state(editor);
    expect(editor.typeText("가")).toBe(true);
    const sent = state(editor);
    const commit = take("commit");
    commit.reply(ok(info({ state: "ready", revision: 1, dirty: true, sequence: 3, loadGeneration: 1 })));
    await flush();
    observed.C1 = { before, sent, commitArgs: commit.args, after: state(editor) };
    expect(commit.args).toEqual([1, 1, 0, 1]);
    expect(state(editor)).toMatchObject({ committed: 1, pending: 0, modified: true, paragraph0: "가한글 문단입니다. K".slice(0, 12) });
  });

  it("C2 완성된 조합: 갱신 동안은 세지 않고 끝에서 변경 1개", async () => {
    const { editor, calls } = await realSession();
    const steps: unknown[] = [];
    editor.beginComposition();
    steps.push({ step: "begin", ...state(editor) });
    for (const t of ["ㄱ", "가", "간"]) { editor.updateComposition(t); steps.push({ step: `update ${t}`, ...state(editor) }); }
    editor.endComposition("간");
    steps.push({ step: "end", ...state(editor) });
    observed.C2 = { steps, commits: commits(calls) };
    expect(commits(calls)).toEqual([[1, 1, 0, 1]]);
    expect(steps.slice(1, 4).every((s) => (s as { pending: number }).pending === 0)).toBe(true);
  });

  it("C3 선택 없이 취소: 문서는 그대로, 변경 0개 — modified는?", async () => {
    const { editor, calls } = await realSession();
    const before = state(editor);
    editor.beginComposition();
    editor.updateComposition("가");
    const during = state(editor);
    editor.endComposition("");
    observed.C3 = { before, during, after: state(editor), commits: commits(calls) };
    expect(commits(calls)).toEqual([]);
    expect(state(editor).paragraph0).toBe(before.paragraph0);
  });

  it("C4 선택을 지운 뒤 취소: 지우기만 변경 1개", async () => {
    const { editor, calls } = await realSession();
    editor.moveHorizontal(1, true);
    editor.moveHorizontal(1, true);
    const before = state(editor);
    editor.beginComposition();
    const afterBegin = state(editor);
    editor.updateComposition("가");
    editor.endComposition("");
    observed.C4 = { before, afterBegin, after: state(editor), commits: commits(calls) };
    expect(commits(calls)).toEqual([[1, 1, 0, 1]]);
  });

  it("C5 선택을 조합으로 바꿈: 지우기+조합이 변경 1개", async () => {
    const { editor, calls } = await realSession();
    editor.moveHorizontal(1, true);
    editor.beginComposition();
    editor.updateComposition("새");
    editor.endComposition("새");
    observed.C5 = { after: state(editor), commits: commits(calls) };
    expect(commits(calls)).toEqual([[1, 1, 0, 1]]);
  });

  it("C6 앱이 먼저 확정한 조합 뒤 다른 최종 글자: 고친 뒤 변경 1개", async () => {
    const { editor, calls } = await realSession();
    editor.beginComposition();
    editor.updateComposition("하");
    editor.endComposition("하", { provisional: true });
    const provisional = state(editor);
    editor.resolveProvisional("한");
    observed.C6 = { provisional, after: state(editor), commits: commits(calls) };
    expect(provisional).toMatchObject({ pending: 0, awaitingEnd: true });
    expect(commits(calls)).toEqual([[1, 1, 0, 1]]);
    expect(state(editor).paragraph0.startsWith("한한글")).toBe(true);
  });

  it("C7 확정을 보내는 중에 끝난 조합: 다음 확정에 묶여 간다", async () => {
    const { editor, calls, take } = await realSession();
    editor.typeText("a");
    const first = take("commit");
    editor.beginComposition();
    editor.updateComposition("가");
    editor.endComposition("가");
    const whilePending = state(editor);
    first.reply(ok(info({ state: "ready", revision: 1, dirty: true, sequence: 3, loadGeneration: 1 })));
    await flush();
    const second = take("commit");
    second.reply(ok(info({ state: "ready", revision: 2, dirty: true, sequence: 4, loadGeneration: 1 })));
    await flush();
    observed.C7 = { whilePending, firstArgs: first.args, secondArgs: second.args, after: state(editor), remaining: commits(calls) };
    expect([first.args, second.args]).toEqual([[1, 1, 0, 1], [1, 1, 1, 1]]);
    expect(state(editor)).toMatchObject({ committed: 2, pending: 0 });
  });

  it("C8 다시 불러오기·닫기: 새 문서·세대, 이전 값은 버린다", async () => {
    const { editor, take, docs } = await realSession();
    editor.typeText("x");
    const pendingCommit = take("commit");
    const before = state(editor);
    const reloading = editor.load({ discard: true });
    take("load").reply(loaded(fixture, 2));
    await flush();
    take("session").reply(ok(info({ state: "loading", sequence: 3, loadGeneration: 2 })));
    take("setState").reply(ok(info({ state: "ready", sequence: 4, loadGeneration: 2 })));
    await reloading;
    pendingCommit.reply(ok(info({ state: "ready", revision: 1, dirty: true, sequence: 5, loadGeneration: 1 }))); // 늦은 옛 응답
    await flush();
    const afterReload = state(editor);
    editor.dispose();
    observed.C8 = { before, afterReload, docsOpened: docs.length, statusAfterDispose: editor.status };
    expect(afterReload).toMatchObject({ pending: 0, committed: 0, paragraph0: "한글 문단입니다. Kore".slice(0, 12) });
  });

  it("C-snap: 조합 경계에 찍은 엔진 스냅숏으로 되돌리면 조합 전 문서가 된다(세션 밖, 통합 아님)", async () => {
    const { editor, docs } = await realSession();
    const doc = docs[0] as unknown as { saveSnapshot(): number; restoreSnapshot(id: number): string; getTextFileText(): string };
    const text0 = doc.getTextFileText();
    const id = doc.saveSnapshot(); // 미래 기록이 찍을 자리: beginComposition 전
    editor.beginComposition();
    editor.updateComposition("가");
    editor.endComposition("간");
    const text1 = doc.getTextFileText();
    doc.restoreSnapshot(id);
    const text2 = doc.getTextFileText();
    // 세션은 복원을 모른다: modelVersion·pending·커서는 그대로(미래 통합이 맞춰야 할 것).
    observed.Csnap = { changed: text1 !== text0, restoredEqual: text2 === text0, sessionAfterRestore: state(editor) };
    expect(text1).not.toBe(text0);
    expect(text2).toBe(text0);
  });
});
