// T010 IME 경계 후속: 빈 끝 뒤 최종 글자를 기다리는 트랜잭션(awaitingCommit)과 보존·수명주기. 편집 세션·작업 공간·ImeInput·
// 명령 경계는 실제 코드이고 백엔드는 가짜다(DOCX: FakeDocx 흉내, HWPX: 응답을 시험이 직접 주는 controlledBackend + 가짜 rhwp 문서).
// 이벤트 순서는 실측 WebKitGTK 2.54 + ibus-hangul의 확정(빈 끝 → 229 keydown → insertFromComposition → 끝)을 재생한다.
import { describe, expect, it } from "vitest";
import type { DocumentBackend } from "../adapters/backend";
import type { Result, SaveOutcome, SessionInfo } from "../adapters/contract";
import { DocumentSessions } from "../adapters/sessions";
import { initialLayout } from "../hooks/layoutState";
import { DocumentWorkspace } from "../components/Editor/documentWorkspace";
import { ImeContext, ImeInput, type ImeSession } from "../components/Editor/rhwp/imeInput";
import type { RhwpDocument, RhwpModule } from "../components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, FakeDocument, flush as flushRhwp, info, loaded, ok as okResult } from "../components/Editor/rhwp/testing";
import { decodeFake, FakeDocx, flush } from "../components/Editor/wordcraft/testing";
import { commandState, executeCommand, type CommandContext } from "./commands";
import type { DocumentCommandTarget } from "./target";

/** 조합 '하'를 보인 뒤 입력기의 빈 끝까지(최종 글자는 아직). */
function emptyEnd(ime: ImeInput, text = "하") {
  ime.keyDown(true);
  ime.compositionStart();
  ime.input(text, "insertCompositionText", true);
  ime.keyDown(true);
  ime.input("", "deleteCompositionText", true);
  ime.compositionEnd("");
}

/** 입력기 확정의 뒤 반쪽. */
function finalHalf(ime: ImeInput, text = "하") {
  ime.keyDown(true);
  ime.input(text, "insertFromComposition", true);
  ime.compositionEnd(text);
}

const saveCalls = (fake: FakeDocx) => fake.calls.filter((call) => ["preflight", "save"].includes(call.method)).map((call) => call.method);

function commands(document: DocumentCommandTarget) {
  const notices: string[] = [];
  const context: CommandContext = { layout: initialLayout, dispatch: () => {}, notify: (message) => notices.push(message.key), document };
  return { context, notices };
}

/** DOCX 문서 하나(또는 둘)를 연 작업 공간. closeFails면 백엔드 닫기가 실패한다. */
async function docxWorkspace(options: { closeFails?: boolean; two?: boolean } = {}) {
  const fakes = new Map<number, FakeDocx>([[1, new FakeDocx()]]);
  if (options.two) {
    const second = new FakeDocx(["둘째"]);
    second.info = { ...second.info, sessionId: 2, displayName: "b.docx" };
    fakes.set(2, second);
  }
  const closed: number[] = [];
  const done = <T,>(value: T): Promise<Result<T>> => Promise.resolve({ ok: true, value });
  const backend = {
    open: (path: string) => done<SessionInfo>({ ...fakes.get(path === "/b.docx" ? 2 : 1)!.info }),
    session: (id: number) => done({ ...fakes.get(id)!.info }),
    sessions: () => done([]),
    close: (sessionId: number) => {
      if (options.closeFails) return Promise.resolve({ ok: false, error: { code: "Internal" } });
      closed.push(sessionId);
      return done({ sessionId, alreadyClosed: false });
    },
  } as unknown as DocumentBackend;
  const docx = new Proxy({} as FakeDocx, {
    get: (_, method: keyof FakeDocx) => (id: number, ...rest: unknown[]) =>
      (fakes.get(id)![method] as (...args: unknown[]) => unknown).call(fakes.get(id), id, ...rest),
  });
  const sessions = new DocumentSessions(backend);
  const workspace = new DocumentWorkspace(sessions, backend, undefined, undefined, docx, decodeFake);
  await workspace.open("/a.docx");
  if (options.two) await workspace.open("/b.docx");
  await flush();
  const editor = workspace.docxEditorFor(1)!;
  const ime = new ImeInput(editor, new ImeContext());
  return { workspace, sessions, editor, fake: fakes.get(1)!, fakes, ime, closed };
}

describe("DOCX: 최종 글자를 기다리는 트랜잭션의 보존", () => {
  it("깨끗한 문서도 기다리는 동안은 저장하지 않은 입력이고, 닫기·다시 불러오기·창 닫기는 버리기 확인을 요구한다", async () => {
    const t = await docxWorkspace();
    expect(t.editor.hasUnpreservedChanges).toBe(false);
    emptyEnd(t.ime);
    await flush();
    expect(t.editor.awaitingCommit).toBe(true);
    expect(t.editor.snapshot().composing).toBe(true);
    expect(t.editor.hasUnpreservedChanges).toBe(true);
    expect(t.workspace.hasUnpreservedChanges).toBe(true); // 창 닫기 요청은 버리기 확인을 띄운다
    expect(await t.workspace.close(1)).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    expect(t.closed).toEqual([]);
    expect(await t.editor.load()).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    expect(t.fake.calls.filter((call) => call.method === "load")).toHaveLength(1); // 처음 불러오기뿐
    expect(t.editor.status.kind).toBe("ready");
    // 그대로 남은 트랜잭션은 최종 글자로 끝난다.
    finalHalf(t.ime);
    await flush();
    expect(t.fake.paragraphs[0]).toBe("하가나다");
    expect(t.sessions.get(1)).toMatchObject({ revision: 1, dirty: true });
  });

  it("저장(직접·Ctrl+S·리본)은 시작하지 않고 같은 이유를 보이며 백엔드 검사·저장을 부르지 않는다", async () => {
    const t = await docxWorkspace();
    emptyEnd(t.ime);
    await flush();
    expect(await t.editor.save()).toEqual({ ok: false, error: { code: "SaveNotReady", reason: "composing" } });
    expect(t.editor.saveState).toEqual({ kind: "failed", error: { code: "SaveNotReady", reason: "composing" } });
    const { context, notices } = commands(t.editor);
    expect(commandState("file.save", context)).toEqual({ available: false, reason: "composing" });
    expect(executeCommand("file.save", undefined, context)).toBe(false);
    expect(notices).toEqual(["command.unavailable.composing"]);
    expect(saveCalls(t.fake)).toEqual([]);
    expect(t.editor.awaitingCommit).toBe(true); // 저장 요청이 기다림을 지우지 않는다
  });

  it("사전 검사를 기다리는 사이 기다림이 생기면 저장 직전 다시 확인해 백엔드 저장을 부르지 않는다", async () => {
    const t = await docxWorkspace();
    t.fake.hold = true;
    const saving = t.editor.save();
    await flush();
    expect(saveCalls(t.fake)).toEqual(["preflight"]);
    emptyEnd(t.ime);
    t.fake.release();
    expect(await saving).toEqual({ ok: false, error: { code: "SaveNotReady", reason: "composing" } });
    expect(saveCalls(t.fake)).toEqual(["preflight"]);
    expect(t.fake.saved).toBeNull();
    expect(t.editor.awaitingCommit).toBe(true);
  });

  it("백엔드 저장이 가는 동안 기다림이 생기면 저장 결과는 그 뒤 입력이 남았다고 보이고 보존 대상으로 남는다", async () => {
    const t = await docxWorkspace();
    t.fake.hold = true;
    const saving = t.editor.save();
    await flush();
    t.fake.release(); // 사전 검사
    await flush();
    expect(saveCalls(t.fake)).toEqual(["preflight", "save"]);
    emptyEnd(t.ime);
    t.fake.release(); // 저장
    const result = await saving;
    expect(result.ok).toBe(true);
    expect(t.fake.saved).toEqual(["가나다", "abc"]); // 저장한 것은 그 판(기다리는 글자 없음)
    expect(t.editor.saveState).toMatchObject({ kind: "saved", revision: 0, changedSince: true });
    expect(t.editor.hasUnpreservedChanges).toBe(true);
    t.fake.hold = false;
    finalHalf(t.ime);
    await flush();
    expect(t.sessions.get(1)).toMatchObject({ revision: 1, dirty: true });
  });

  it("최종 글자가 들어가면 기다림이 끝나고 저장이 보통처럼 된다", async () => {
    const t = await docxWorkspace();
    emptyEnd(t.ime);
    finalHalf(t.ime);
    await flush();
    expect(t.editor.awaitingCommit).toBe(false);
    expect((await t.editor.save()).ok).toBe(true);
    expect(t.fake.saved).toEqual(["하가나다", "abc"]);
    expect(t.editor.hasUnpreservedChanges).toBe(false);
  });

  it("진짜 취소 뒤 새 입력의 시작(수식 키 없는 키)으로 풀리고, 글자·revision·dirty를 만들지 않는다", async () => {
    const t = await docxWorkspace();
    emptyEnd(t.ime, "ㅎ");
    t.ime.keyDown(false); // 예: End
    await flush();
    expect(t.editor.awaitingCommit).toBe(false);
    expect(t.editor.hasUnpreservedChanges).toBe(false);
    expect(t.sessions.get(1)).toMatchObject({ revision: 0, dirty: false });
    expect(t.fake.calls.filter((call) => call.method === "edit")).toEqual([]);
    expect((await t.editor.save()).ok).toBe(true);
  });

  it("버리기를 확인한 닫기는 진행하고, 늦게 온 최종 글자는 닫힌 문서·다른 문서에 들어가지 않는다", async () => {
    const t = await docxWorkspace({ two: true });
    t.sessions.select(1);
    emptyEnd(t.ime);
    await flush();
    expect((await t.workspace.close(1, { discard: true })).ok).toBe(true);
    expect(t.closed).toEqual([1]);
    expect(t.editor.status.kind).toBe("closed");
    const b = t.workspace.docxEditorFor(2)!;
    finalHalf(new ImeInput(b, (t.ime as unknown as { context: ImeContext }).context));
    await flush();
    expect(t.fake.calls.filter((call) => call.method === "edit")).toEqual([]);
    expect(t.fakes.get(2)!.calls.filter((call) => call.method === "edit")).toEqual([]);
    expect(t.fakes.get(2)!.paragraphs).toEqual(["둘째"]);
  });

  it("버리기를 확인한 닫기가 실패하면 문서는 그대로 쓸 수 있고(기다림은 사용자가 버린 것), 늦은 최종 글자는 넣지 않는다", async () => {
    const t = await docxWorkspace({ closeFails: true });
    emptyEnd(t.ime);
    await flush();
    expect((await t.workspace.close(1, { discard: true })).ok).toBe(false);
    expect(t.editor.status.kind).toBe("ready");
    expect(t.editor.editable).toBe(true);
    expect(t.editor.awaitingCommit).toBe(false);
    finalHalf(t.ime);
    await flush();
    expect(t.fake.calls.filter((call) => call.method === "edit")).toEqual([]);
    t.editor.typeText("가");
    await flush();
    expect(t.fake.paragraphs[0]).toBe("가가나다");
  });

  it("창 닫기: 승인 뒤(창 닫는 중) 기다림은 버리고, 창 닫기가 실패하면 편집을 다시 받으며 늦은 최종 글자는 넣지 않는다", async () => {
    const t = await docxWorkspace();
    emptyEnd(t.ime);
    await flush();
    expect(t.workspace.hasUnpreservedChanges).toBe(true); // 창 닫기 요청 → 버리기 확인
    t.workspace.setWindowClosing(true); // 사용자가 확인함
    expect(t.editor.awaitingCommit).toBe(false);
    t.workspace.setWindowClosing(false); // native 닫기 실패
    expect(t.editor.editable).toBe(true);
    finalHalf(t.ime);
    await flush();
    expect(t.fake.calls.filter((call) => call.method === "edit")).toEqual([]);
    expect(t.editor.hasUnpreservedChanges).toBe(false);
  });

  it("두 문서: A의 기다림은 B의 보존·저장을 막지 않는다(창 닫기는 A 때문에 확인을 요구)", async () => {
    const t = await docxWorkspace({ two: true });
    emptyEnd(t.ime);
    await flush();
    const b = t.workspace.docxEditorFor(2)!;
    expect(b.hasUnpreservedChanges).toBe(false);
    expect(b.snapshot().composing).toBe(false);
    expect((await b.save()).ok).toBe(true);
    expect(t.workspace.hasUnpreservedChanges).toBe(true);
    expect((await t.workspace.close(2)).ok).toBe(true);
    expect(await t.workspace.close(1)).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
  });
});

// ---- rhwp(HWPX) ----

const hwpx = (patch: Partial<SessionInfo>): SessionInfo => info({ format: "hwpx", displayName: "a.hwpx", ...patch });
const safeCheck = { preservation: { outcome: "safe" as const, findings: [] }, platformSupported: true };

async function hwpxWorkspace() {
  const { backend, calls, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwpx");
  take("open").reply(okResult({ ...base, format: "hwpx", displayName: "a.hwpx" }));
  await opening;
  const doc = new FakeDocument(["가나다", "abc"]);
  doc.format = "hwpx";
  let first = true;
  const module: RhwpModule = {
    openDocument: (bytes: Uint8Array) => {
      if (first) {
        first = false;
        return doc as unknown as RhwpDocument;
      }
      const exported = bytes.length > 4 && bytes[0] === 0x50;
      const other = new FakeDocument(exported ? new TextDecoder().decode(bytes.subarray(4)).split("\n") : ["가나다", "abc"]);
      other.format = "hwpx";
      return other as unknown as RhwpDocument;
    },
  };
  const workspace = new DocumentWorkspace(sessions, backend, async () => module);
  const editor = workspace.editorFor(1)!;
  const loading = editor.load();
  take("load").reply(loaded());
  await flushRhwp();
  take("session").reply(okResult(hwpx({ state: "loading", sequence: 1, loadGeneration: 1 })));
  take("setState").reply(okResult(hwpx({ state: "ready", sequence: 2, loadGeneration: 1 })));
  await loading;
  const ime = new ImeInput(editor as unknown as ImeSession, new ImeContext());
  return { workspace, editor, sessions, doc, calls, take, ime };
}

describe("rhwp: 최종 글자를 기다리는 트랜잭션의 보존", () => {
  it("빈 끝으로 조합 글자를 지운 깨끗한 모델도 기다리는 동안은 보존 대상이다(modified와 무관)", async () => {
    const t = await hwpxWorkspace();
    emptyEnd(t.ime);
    await flushRhwp();
    expect(t.doc.paragraphs[0]).toBe("가나다"); // 빈 끝이 조합 글자를 지웠다(변경 아님)
    expect(t.editor.awaitingCommit).toBe(true);
    expect(t.editor.snapshot().composing).toBe(true);
    expect(t.editor.hasUnpreservedChanges).toBe(true);
    expect(await t.editor.load()).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    expect(await t.workspace.close(1)).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    expect(t.calls.map((call) => call.method)).not.toContain("close");
    expect(t.workspace.hasUnpreservedChanges).toBe(true);
  });

  it("저장은 시작하지 않고(원본 읽기도 안 함) 같은 이유를 보이며, 최종 글자 뒤에는 한 번 들어간다", async () => {
    const t = await hwpxWorkspace();
    emptyEnd(t.ime);
    expect(await t.editor.save()).toEqual({ ok: false, error: { code: "SaveNotReady", reason: "composing" } });
    expect(t.calls.map((call) => call.method).filter((method) => ["original", "preflight", "save"].includes(method))).toEqual([]);
    const { context } = commands(t.editor);
    expect(commandState("file.save", context)).toEqual({ available: false, reason: "composing" });
    finalHalf(t.ime);
    await flushRhwp();
    expect(t.doc.paragraphs[0]).toBe("하가나다");
    expect(t.editor.awaitingCommit).toBe(false);
  });

  it("백엔드 저장이 가는 동안 기다림이 생기면 그 저장 뒤에도 보존 대상이고 '그 뒤 편집 있음'으로 보인다", async () => {
    const t = await hwpxWorkspace();
    const saving = t.editor.save();
    t.take("original").reply(okResult(new Uint8Array([1])));
    await flushRhwp();
    t.take("preflight").reply(okResult(safeCheck));
    await flushRhwp();
    const save = t.take("save");
    emptyEnd(t.ime);
    save.reply(okResult({ session: hwpx({ state: "ready", revision: 0, dirty: false, sequence: 3, loadGeneration: 1 }), bytes: 9, durable: true } satisfies SaveOutcome));
    expect((await saving).ok).toBe(true);
    expect(t.editor.saveState).toMatchObject({ kind: "saved", changedSince: true });
    expect(t.editor.hasUnpreservedChanges).toBe(true);
    expect(await t.editor.load()).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
  });
});
