// T010 IME 경계 후속: 빈 끝 뒤 최종 글자를 기다리는 트랜잭션(awaitingCommit)과 보존·수명주기. 편집 세션·작업 공간·ImeInput·
// 명령 경계는 실제 코드이고 백엔드는 가짜다(DOCX: FakeDocx 흉내, HWPX: 응답을 시험이 직접 주는 controlledBackend + 가짜 rhwp 문서).
// 이벤트 순서는 실측 WebKitGTK 2.54 + ibus-hangul의 확정(빈 끝 → 229 keydown → insertFromComposition → 끝)을 재생한다.
import { describe, expect, it } from "vitest";
import type { DocumentBackend } from "../adapters/backend";
import type { Result, SaveOutcome, SessionInfo } from "../adapters/contract";
import { DocumentSessions } from "../adapters/sessions";
import { initialLayout } from "../hooks/layoutState";
import { DocumentWorkspace } from "../components/Editor/documentWorkspace";
import { attachTextInput } from "../components/Editor/textInput";
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
  const docs = [doc];
  const module: RhwpModule = {
    openDocument: (bytes: Uint8Array) => {
      if (first) {
        first = false;
        return doc as unknown as RhwpDocument;
      }
      const exported = bytes.length > 4 && bytes[0] === 0x50;
      const other = new FakeDocument(exported ? new TextDecoder().decode(bytes.subarray(4)).split("\n") : ["가나다", "abc"]);
      other.format = "hwpx";
      docs.push(other);
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
  // docs: 연 가짜 문서 차례(다시 불러온 뒤의 모델은 마지막 것).
  return { workspace, editor, sessions, doc, docs, calls, take, ime };
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

// Lifecycle replay uses the production textarea adapter, IME controller, editor session and workspace.
function inputSurface(editor: ImeSession, context: ImeContext) {
  const input = document.createElement("textarea");
  document.body.append(input);
  const ime = new ImeInput(editor, context);
  const detach = attachTextInput(input, ime, {
    composing: () => editor.composing, handleKey: () => false, mark: () => {},
  });
  const fire = (event: Event) => input.dispatchEvent(event);
  const key229 = (isComposing = false) => {
    const event = new KeyboardEvent("keydown", { isComposing });
    Object.defineProperty(event, "keyCode", { value: 229 });
    fire(event);
  };
  return {
    start: () => fire(new CompositionEvent("compositionstart", { data: "" })),
    preedit: (text: string) => {
      key229(true);
      fire(new InputEvent("input", { inputType: "insertCompositionText", data: text, isComposing: true }));
    },
    empty: () => fire(new CompositionEvent("compositionend", { data: "" })),
    ordinaryKey: () => fire(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight" })),
    pointerDown: () => ime.pointerDown(),
    preeditRaw: (text: string) => fire(new InputEvent("input", { inputType: "insertCompositionText", data: text, isComposing: true })),
    final: (text: string, composing = true) => {
      key229();
      fire(new InputEvent("input", { inputType: "insertFromComposition", data: text, isComposing: composing }));
      fire(new CompositionEvent("compositionend", { data: text }));
    },
    cleanup: () => { detach(); input.remove(); },
  };
}

describe("IME lifecycle ownership through real input path", () => {
  for (const explicitStart of [true, false]) {
    it(`failed DOCX close accepts first new composition (${explicitStart ? "start" : "no start"})`, async () => {
      const t = await docxWorkspace({ closeFails: true });
      const context = new ImeContext();
      const surface = inputSurface(t.editor, context);
      surface.start(); surface.preedit("옛"); surface.empty();
      expect(t.editor.awaitingCommit).toBe(true);
      expect((await t.workspace.close(1, { discard: true })).ok).toBe(false);
      expect(t.editor.editable).toBe(true);
      if (explicitStart) surface.start();
      surface.preedit("새");
      expect(t.editor.composing).toBe(true);
      surface.final("새");
      await flush();
      expect(t.fake.paragraphs[0]).toBe("새가나다");
      expect(t.sessions.get(1)).toMatchObject({ revision: 1, dirty: true });
      surface.cleanup();
    });
  }

  it("failed DOCX close cancels active preview and rejects its late final", async () => {
    const t = await docxWorkspace({ closeFails: true });
    const context = new ImeContext();
    const surface = inputSurface(t.editor, context);
    surface.start(); surface.preedit("옛");
    expect(t.editor.composing).toBe(true);
    expect((await t.workspace.close(1, { discard: true })).ok).toBe(false);
    expect(t.editor.composing).toBe(false);
    surface.ordinaryKey(); // a navigation key cannot make the discarded native tail valid again
    surface.final("옛");
    surface.preedit("새"); surface.final("새");
    await flush();
    expect(t.fake.paragraphs[0]).toBe("새가나다");
    expect(t.sessions.get(1)).toMatchObject({ revision: 1, dirty: true });
    surface.cleanup();
  });
});

// ---- P1 판별 회귀: 폐기 뒤 pointerDown → 시작·229·옛 꼬리 없이 첫 새 preedit ----
// 37b39ae의 pointerDown은 폐기된 문맥에도 끝나지 않은 끊김 기록을 남겼고, 그 기록이 있으면 첫 새 insertCompositionText가
// 폐기 표지를 풀지 못해 버려졌다. 229 keydown·compositionstart·옛 최종 입력은 그 기록을 먼저 지워 결함을 가리므로, 불변식 A
// (새 조합 수락)의 순서에는 넣지 않는다. 불변식 B(옛 꼬리 거절)는 따로 확인한다. 모두 DOM 재생이며 실제 입력기 순서가 아니다.

type Engine = "docx" | "rhwp";
type Lifecycle = "failed close" | "reload";

/** 엔진별 작업 공간: 폐기(닫기 실패·다시 불러오기), 모델 글자, 엔진에 보낸 확정과 revision 확인. */
async function engineCase(engine: Engine) {
  if (engine === "docx") {
    const t = await docxWorkspace({ closeFails: true });
    return {
      editor: t.editor,
      text: () => t.fake.paragraphs[0],
      moveRight: () => t.editor.move("right", false),
      invalidate: async (lifecycle: Lifecycle) => {
        const result = lifecycle === "failed close" ? await t.workspace.close(1, { discard: true }) : await t.editor.load({ discard: true });
        expect(result.ok).toBe(lifecycle === "reload");
        await flush();
      },
      /** 엔진에 보낸 넣기 글자와 문서 revision·dirty. */
      expectCommitted: async (texts: string[]) => {
        await flush();
        const inserted = t.fake.calls.filter((call) => call.method === "edit")
          .flatMap((call) => call.args[3] as { op: string; text?: string }[])
          .filter((op) => op.op.startsWith("insert")).map((op) => op.text);
        expect(inserted).toEqual(texts);
        expect(t.sessions.get(1)).toMatchObject({ revision: texts.length, dirty: texts.length > 0 });
      },
    };
  }
  const t = await hwpxWorkspace();
  let generation = 1;
  return {
    editor: t.editor,
    text: () => t.docs.at(-1)!.paragraphs[0],
    moveRight: () => t.editor.moveHorizontal(1, false),
    invalidate: async (lifecycle: Lifecycle) => {
      if (lifecycle === "failed close") {
        const closing = t.workspace.close(1, { discard: true });
        t.take("close").reply({ ok: false, error: { code: "Protocol" } });
        expect((await closing).ok).toBe(false);
        return;
      }
      const reloading = t.editor.load({ discard: true });
      t.take("load").reply(loaded(undefined, 2));
      await flushRhwp();
      t.take("session").reply(okResult(hwpx({ state: "loading", sequence: 3, loadGeneration: 2 })));
      t.take("setState").reply(okResult(hwpx({ state: "ready", sequence: 4, loadGeneration: 2 })));
      expect((await reloading).ok).toBe(true);
      expect(t.docs).toHaveLength(2);
      generation = 2;
    },
    /** rhwp는 글자를 모델에 넣고 변경 수만 보낸다: 확정마다 revision 하나. */
    expectCommitted: async (texts: string[]) => {
      await flushRhwp();
      expect(t.editor.localRevision).toBe(texts.length);
      let revision = 0;
      while (t.calls.some((call) => call.method === "commit")) {
        const commit = t.take("commit");
        expect(commit.args.slice(0, 3)).toEqual([1, generation, revision]);
        revision += commit.args[3] as number;
        commit.reply(okResult(hwpx({ state: "ready", revision, dirty: true, sequence: 9 + revision, loadGeneration: generation })));
        await flushRhwp();
      }
      expect(revision).toBe(texts.length);
      expect(t.sessions.get(1)).toMatchObject({ revision: texts.length, dirty: texts.length > 0 });
    },
  };
}

/** 빈 끝으로 끝나 최종 글자를 기다리는 옛 거래를 만들고 폐기한다. 폐기 뒤 세대가 바뀌었는지 확인한다. */
async function discardedAwaiting(engine: Engine, lifecycle: Lifecycle) {
  const t = await engineCase(engine);
  const context = new ImeContext();
  const surface = inputSurface(t.editor, context);
  surface.start(); surface.preedit("옛"); surface.empty();
  expect(t.editor.awaitingCommit).toBe(true);
  expect(context.owner).toEqual({ session: t.editor, epoch: t.editor.imeEpoch });
  const before = t.editor.imeEpoch;
  await t.invalidate(lifecycle);
  expect(t.editor.imeEpoch).not.toBe(before);
  expect(t.editor.editable).toBe(true);
  expect(t.editor.awaitingCommit).toBe(false);
  expect(t.text()).toBe("가나다");
  return { ...t, context, surface };
}

describe("P1 invariant A: first new composition after pointerDown on a discarded transaction", () => {
  for (const engine of ["docx", "rhwp"] as const) {
    for (const lifecycle of ["failed close", "reload"] as const) {
      for (const boundary of ["none", "compositionstart"] as const) {
        for (const completion of ["direct", "split"] as const) {
          it(`${engine} ${lifecycle}: pointerDown → ${boundary === "none" ? "no start, no 229" : "compositionstart"} → first preedit (${completion} commit)`, async () => {
            const t = await discardedAwaiting(engine, lifecycle);
            t.surface.pointerDown();
            if (boundary === "compositionstart") t.surface.start();
            t.surface.preeditRaw("새");
            // 첫 새 조합 직후(다른 이벤트 없음).
            expect(t.editor.composing).toBe(true);
            expect(t.context.owner).toEqual({ session: t.editor, epoch: t.editor.imeEpoch });
            expect(t.context.discarded).toBe(false);
            expect(t.context.interrupted).toBeNull();
            if (completion === "direct") t.surface.final("새");
            else { t.surface.empty(); t.surface.final("새"); } // 실측 순서: 빈 끝 → 229 → 최종 글자 → 끝
            expect(t.editor.composing).toBe(false);
            expect(t.editor.awaitingCommit).toBe(false);
            await t.expectCommitted(["새"]);
            expect(t.text()).toBe("새가나다");
            expect(t.editor.editable).toBe(true);
            t.surface.cleanup();
          });
        }
      }
    }
  }

  it("docx failed close: pointerDown on A, then B's no-start preedit on the shared context is accepted", async () => {
    const t = await docxWorkspace({ closeFails: true, two: true });
    const context = new ImeContext();
    const a = inputSurface(t.editor, context);
    a.start(); a.preedit("옛"); a.empty();
    expect((await t.workspace.close(1, { discard: true })).ok).toBe(false);
    a.pointerDown();
    a.cleanup(); // 탭 전환
    const b = t.workspace.docxEditorFor(2)!;
    const bs = inputSurface(b, context);
    bs.preeditRaw("새");
    expect(b.composing).toBe(true);
    expect(context.owner).toEqual({ session: b, epoch: b.imeEpoch });
    expect(context.discarded).toBe(false);
    bs.final("새");
    await flush();
    expect(t.fakes.get(2)!.paragraphs).toEqual(["새둘째"]);
    expect(t.fake.paragraphs[0]).toBe("가나다");
    expect(t.fake.calls.filter((call) => call.method === "edit")).toEqual([]);
    expect(t.sessions.get(2)).toMatchObject({ revision: 1, dirty: true });
    bs.cleanup();
  });
});

describe("P1 invariant B: discarded old final after pointerDown is never committed", () => {
  for (const engine of ["docx", "rhwp"] as const) {
    for (const lifecycle of ["failed close", "reload"] as const) {
      for (const composing of [true, false]) {
        it(`${engine} ${lifecycle}: pointerDown → old final (isComposing=${composing}) → old compositionend`, async () => {
          const t = await discardedAwaiting(engine, lifecycle);
          t.surface.pointerDown();
          t.surface.final("옛", composing); // 229 → insertFromComposition → compositionend("옛")
          expect(t.editor.composing).toBe(false);
          expect(t.editor.awaitingCommit).toBe(false);
          await t.expectCommitted([]);
          expect(t.text()).toBe("가나다");
          expect(t.editor.editable).toBe(true);
          // 옛 꼬리 뒤에도 문서는 새 입력을 받는다(불변식 A와 별개의 회복 확인: 명시적 시작).
          t.surface.start(); t.surface.preedit("새"); t.surface.final("새");
          await t.expectCommitted(["새"]);
          expect(t.text()).toBe("새가나다");
          t.surface.cleanup();
        });
      }
    }
  }
});

describe("P1 boundaries that must stay valid on both engines", () => {
  for (const engine of ["docx", "rhwp"] as const) {
    it(`${engine}: a valid late final after pointerDown goes to the still-open original position once`, async () => {
      const t = await engineCase(engine);
      const context = new ImeContext();
      const surface = inputSurface(t.editor, context);
      surface.start(); surface.preedit("하"); surface.empty();
      surface.pointerDown();
      t.moveRight(); // 클릭이 커서를 옮김
      expect(t.editor.composing).toBe(false);
      expect(t.editor.awaitingCommit).toBe(true);
      surface.final("하");
      expect(t.editor.awaitingCommit).toBe(false);
      await t.expectCommitted(["하"]);
      expect(t.text()).toBe("하가나다");
      surface.cleanup();
    });

    it(`${engine}: two identical consecutive syllables, the second without compositionstart`, async () => {
      const t = await engineCase(engine);
      const surface = inputSurface(t.editor, new ImeContext());
      surface.start(); surface.preedit("하"); surface.final("하");
      surface.preeditRaw("하");
      expect(t.editor.composing).toBe(true);
      surface.final("하");
      await t.expectCommitted(["하", "하"]);
      expect(t.text()).toBe("하하가나다");
      surface.cleanup();
    });

    it(`${engine}: ordinary IME cancellation then a no-start composition`, async () => {
      const t = await engineCase(engine);
      const surface = inputSurface(t.editor, new ImeContext());
      surface.start(); surface.preedit("ㅎ"); surface.empty();
      expect(t.editor.awaitingCommit).toBe(true);
      surface.preeditRaw("가");
      expect(t.editor.awaitingCommit).toBe(false);
      expect(t.editor.composing).toBe(true);
      surface.final("가");
      await t.expectCommitted(["가"]);
      expect(t.text()).toBe("가가나다");
      surface.cleanup();
    });
  }
});

describe("IME generation and shared-context replay", () => {
  for (const composing of [true, false]) {
    it(`reload consumes an old final (${composing}) and accepts a no-start composition`, async () => {
      const t = await docxWorkspace();
      const context = new ImeContext();
      const surface = inputSurface(t.editor, context);
      surface.start(); surface.preedit("옛"); surface.empty();
      expect((await t.editor.load({ discard: true })).ok).toBe(true);
      surface.final("옛", composing);
      await flush();
      expect(t.fake.paragraphs[0]).toBe("가나다");
      expect(t.sessions.get(1)).toMatchObject({ revision: 0, dirty: false });
      surface.preedit("새");
      expect(t.editor.composing).toBe(true);
      surface.final("새", composing);
      await flush();
      expect(t.fake.paragraphs[0]).toBe("새가나다");
      expect(t.sessions.get(1)).toMatchObject({ revision: 1, dirty: true });
      surface.cleanup();
    });
  }

  it("closed A cannot commit into B; B's no-start preedit is accepted", async () => {
    const t = await docxWorkspace({ two: true });
    const context = new ImeContext();
    const a = inputSurface(t.editor, context);
    a.start(); a.preedit("옛"); a.empty();
    expect((await t.workspace.close(1, { discard: true })).ok).toBe(true);
    a.cleanup();
    const b = t.workspace.docxEditorFor(2)!;
    const bs = inputSurface(b, context);
    bs.final("옛", false);
    await flush();
    expect(t.fakes.get(2)!.paragraphs).toEqual(["둘째"]);
    bs.preedit("새");
    expect(b.composing).toBe(true);
    bs.final("새");
    await flush();
    expect(t.fakes.get(2)!.paragraphs).toEqual(["새둘째"]);
    expect(t.sessions.get(2)).toMatchObject({ revision: 1, dirty: true });
    bs.cleanup();
  });

  it("two identical syllables include a no-start second composition", async () => {
    const t = await docxWorkspace();
    const surface = inputSurface(t.editor, new ImeContext());
    surface.start(); surface.preedit("하"); surface.final("하");
    surface.preedit("하");
    expect(t.editor.composing).toBe(true);
    surface.final("하");
    await flush();
    expect(t.fake.paragraphs[0]).toBe("하하가나다");
    expect(t.sessions.get(1)).toMatchObject({ revision: 2, dirty: true });
    surface.cleanup();
  });

  it("window-close failure cancels active DOCX preview and recovers", async () => {
    const t = await docxWorkspace();
    const surface = inputSurface(t.editor, new ImeContext());
    surface.start(); surface.preedit("옛");
    expect(t.workspace.hasUnpreservedChanges).toBe(true);
    t.workspace.setWindowClosing(true);
    t.workspace.setWindowClosing(false);
    expect(t.editor.composing).toBe(false);
    surface.final("옛");
    surface.preedit("새"); surface.final("새");
    await flush();
    expect(t.fake.paragraphs[0]).toBe("새가나다");
    surface.cleanup();
  });

  it("failed rhwp close removes active WASM preedit before accepting new composition", async () => {
    const t = await hwpxWorkspace();
    const context = new ImeContext();
    const surface = inputSurface(t.editor, context);
    surface.start(); surface.preedit("옛");
    expect(t.doc.paragraphs[0]).toBe("옛가나다");
    const closing = t.workspace.close(1, { discard: true });
    t.take("close").reply({ ok: false, error: { code: "Protocol" } });
    expect((await closing).ok).toBe(false);
    expect(t.editor.editable).toBe(true);
    expect(t.doc.paragraphs[0]).toBe("가나다");
    surface.final("옛", false);
    expect(t.doc.paragraphs[0]).toBe("가나다");
    surface.preedit("새");
    expect(t.editor.composing).toBe(true);
    surface.final("새");
    await flushRhwp();
    expect(t.doc.paragraphs[0]).toBe("새가나다");
    expect(t.editor.localRevision).toBe(1);
    const commit = t.take("commit");
    expect(commit.args).toEqual([1, 1, 0, 1]); // discarded preview sent no revision
    commit.reply(okResult(hwpx({ state: "ready", revision: 1, dirty: true, sequence: 3, loadGeneration: 1 })));
    await flushRhwp();
    expect(t.sessions.get(1)).toMatchObject({ revision: 1, dirty: true });
    surface.cleanup();
  });
});

describe("IME tail and cancellation edges", () => {
  it("rhwp failed close after empty end accepts first no-start composition", async () => {
    const t = await hwpxWorkspace();
    const surface = inputSurface(t.editor, new ImeContext());
    surface.start(); surface.preedit("옛"); surface.empty();
    expect(t.editor.awaitingCommit).toBe(true);
    const closing = t.workspace.close(1, { discard: true });
    t.take("close").reply({ ok: false, error: { code: "Protocol" } });
    expect((await closing).ok).toBe(false);
    surface.preedit("새");
    expect(t.editor.composing).toBe(true);
    surface.final("새");
    await flushRhwp();
    expect(t.doc.paragraphs[0]).toBe("새가나다");
    expect(t.editor.localRevision).toBe(1);
    surface.cleanup();
  });

  it("anchored old final with isComposing=false cannot mutate a reloaded DOCX model", async () => {
    const t = await docxWorkspace();
    const context = new ImeContext();
    const ime = new ImeInput(t.editor, context);
    const surface = inputSurface(t.editor, context);
    surface.start(); surface.preedit("옛"); surface.empty();
    ime.pointerDown();
    expect((await t.editor.load({ discard: true })).ok).toBe(true);
    surface.final("옛", false);
    await flush();
    expect(t.fake.paragraphs[0]).toBe("가나다");
    expect(t.sessions.get(1)).toMatchObject({ revision: 0, dirty: false });
    surface.preedit("새"); surface.final("새");
    await flush();
    expect(t.fake.paragraphs[0]).toBe("새가나다");
    surface.cleanup();
  });

  it("ordinary cancellation releases preservation without committing a preview", async () => {
    const t = await docxWorkspace();
    const surface = inputSurface(t.editor, new ImeContext());
    surface.start(); surface.preedit("ㅎ"); surface.empty();
    expect(t.editor.awaitingCommit).toBe(true);
    surface.preedit("가"); // next composition has no compositionstart
    expect(t.editor.awaitingCommit).toBe(false);
    surface.final("가");
    await flush();
    expect(t.fake.paragraphs[0]).toBe("가가나다");
    expect(t.sessions.get(1)).toMatchObject({ revision: 1, dirty: true });
    surface.cleanup();
  });
});

describe("active discard keeps earlier edits", () => {
  it("failed DOCX close preserves a prior committed edit and only discards the active preview", async () => {
    const t = await docxWorkspace({ closeFails: true });
    t.editor.typeText("X");
    await flush();
    expect(t.sessions.get(1)).toMatchObject({ revision: 1, dirty: true });
    const surface = inputSurface(t.editor, new ImeContext());
    surface.start(); surface.preedit("옛");
    expect((await t.workspace.close(1, { discard: true })).ok).toBe(false);
    surface.final("옛", false);
    await flush();
    expect(t.fake.paragraphs[0]).toBe("X가나다");
    surface.preedit("새"); surface.final("새");
    await flush();
    expect(t.fake.paragraphs[0]).toBe("X새가나다");
    expect(t.sessions.get(1)).toMatchObject({ revision: 2, dirty: true });
    surface.cleanup();
  });

  it("failed window close removes rhwp WASM preview and accepts the next composition", async () => {
    const t = await hwpxWorkspace();
    const surface = inputSurface(t.editor, new ImeContext());
    surface.start(); surface.preedit("옛");
    expect(t.workspace.hasUnpreservedChanges).toBe(true);
    t.workspace.setWindowClosing(true);
    t.workspace.setWindowClosing(false);
    expect(t.editor.editable).toBe(true);
    expect(t.doc.paragraphs[0]).toBe("가나다");
    surface.final("옛", false);
    surface.preedit("새"); surface.final("새");
    await flushRhwp();
    expect(t.doc.paragraphs[0]).toBe("새가나다");
    expect(t.editor.localRevision).toBe(1);
    surface.cleanup();
  });

  it("P2: rhwp selected-text composition followed by failed close preserves selection deletion and accepts new input", async () => {
    const t = await hwpxWorkspace();
    const surface = inputSurface(t.editor, new ImeContext());
    // Step 1: Select "나다" (from offset 1, select 2 chars)
    t.editor.moveHorizontal(1, false);
    t.editor.moveHorizontal(1, true);
    t.editor.moveHorizontal(1, true);
    expect(t.editor.hasSelection).toBe(true);

    // Step 2 & 3: Begin Korean composition replacing selection
    surface.start();
    surface.preedit("새");
    expect(t.doc.paragraphs[0]).toBe("가새");
    expect(t.editor.composing).toBe(true);

    // Step 4 & 5: Discard and Close, backend close fails
    const closing = t.workspace.close(1, { discard: true });
    t.take("close").reply({ ok: false, error: { code: "Protocol" } });
    expect((await closing).ok).toBe(false);
    expect(t.editor.editable).toBe(true);

    // Step 6: Verify remaining model: preedit "새" removed, deleted selection "나다" remains deleted
    expect(t.doc.paragraphs[0]).toBe("가");
    expect(t.editor.composing).toBe(false);
    expect(t.editor.localRevision).toBe(1);

    // Commit for selection deletion mutation
    const commit1 = t.take("commit");
    expect(commit1.args).toEqual([1, 1, 0, 1]);
    commit1.reply(okResult(hwpx({ state: "ready", revision: 1, dirty: true, sequence: 3, loadGeneration: 1 })));
    await flushRhwp();
    expect(t.sessions.get(1)).toMatchObject({ revision: 1, dirty: true });

    // Step 7: Obsolete final event is rejected
    surface.final("새", false);
    expect(t.doc.paragraphs[0]).toBe("가");

    // Step 8 & 9: Legitimate new composition works normally
    surface.preedit("글");
    expect(t.editor.composing).toBe(true);
    surface.final("글");
    await flushRhwp();
    expect(t.doc.paragraphs[0]).toBe("가글");
    expect(t.editor.localRevision).toBe(2);

    const commit2 = t.take("commit");
    expect(commit2.args).toEqual([1, 1, 1, 1]);
    commit2.reply(okResult(hwpx({ state: "ready", revision: 2, dirty: true, sequence: 4, loadGeneration: 1 })));
    await flushRhwp();
    expect(t.sessions.get(1)).toMatchObject({ revision: 2, dirty: true });
    surface.cleanup();
  });

  it("P2: rhwp selected-text composition followed by genuine cancellation deletes selection as 1 mutation", async () => {
    const t = await hwpxWorkspace();
    const surface = inputSurface(t.editor, new ImeContext());
    t.editor.moveHorizontal(1, false);
    t.editor.moveHorizontal(1, true);
    t.editor.moveHorizontal(1, true);
    surface.start();
    surface.preedit("새");
    expect(t.doc.paragraphs[0]).toBe("가새");

    // Genuine cancellation (empty end)
    surface.empty();
    await flushRhwp();
    expect(t.doc.paragraphs[0]).toBe("가");
    expect(t.editor.localRevision).toBe(1);

    const commit = t.take("commit");
    expect(commit.args).toEqual([1, 1, 0, 1]);
    commit.reply(okResult(hwpx({ state: "ready", revision: 1, dirty: true, sequence: 3, loadGeneration: 1 })));
    await flushRhwp();
    expect(t.sessions.get(1)).toMatchObject({ revision: 1, dirty: true });
    surface.cleanup();
  });
});
