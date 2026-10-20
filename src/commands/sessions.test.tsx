// 명령 레지스트리 ↔ 편집 세션(T010). 편집 세션(DocxEditorSession·RhwpEditorSession)은 실제 코드이고, 백엔드는 가짜다:
// FakeDocx(wordcraft/testing.ts)의 실행 취소·서식은 Rust WordCraft Session을 흉내 낸 것이며 엔진 동작의 증거가 아니다(엔진은
// src-tauri adapters::wordcraft 시험·저장 보존 시험이 확인). 여기서 확인하는 것은 명령이 어느 세션의 어떤 편집 경로로 가는지,
// 쓸 수 없을 때 아무것도 바꾸지 않는지, 화면이 엔진 보기로 상태를 정하는지다.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../App";
import type { DocumentBackend } from "../adapters/backend";
import type { Result, SessionInfo } from "../adapters/contract";
import type { DocxBackend } from "../adapters/docx";
import { DocumentSessions } from "../adapters/sessions";
import { initialLayout } from "../hooks/layoutState";
import type { Message } from "../language";
import { DocumentWorkspace } from "../components/Editor/documentWorkspace";
import { readySession } from "../components/Editor/rhwp/testing";
import { decodeFake, docxInfo, FakeDocx, flush, readyDocx } from "../components/Editor/wordcraft/testing";
import { commandState, executeCommand, type CommandContext } from "./commands";
import type { DocumentCommandTarget } from "./target";

const edits = (fake: FakeDocx) => fake.calls.filter((call) => call.method === "edit").map((call) => call.args[3]);

function contextFor(document: DocumentCommandTarget | null) {
  const notices: Message[] = [];
  const context: CommandContext = { layout: initialLayout, dispatch: () => {}, notify: (message) => notices.push(message), document };
  return { context, notices };
}

describe("WordCraft 세션의 명령(가짜 백엔드 흉내)", () => {
  it("굵게: 선택에 format 연산 하나를 보내고 엔진 보기로 눌림을 정한다. 실행 취소·다시 실행은 엔진 기록 연산이다", async () => {
    const { editor, fake, sessions } = await readyDocx();
    const { context, notices } = contextFor(editor);
    editor.move("right", true);
    editor.move("right", true);
    await flush();
    expect(commandState("format.bold", context)).toEqual({ available: true, pressed: false });
    expect(commandState("edit.undo", context)).toEqual({ available: false, reason: "nothingToUndo" });

    expect(executeCommand("format.bold", undefined, context)).toBe(true);
    await flush();
    expect(edits(fake).at(-1)).toEqual([{ op: "format", format: "bold" }]);
    expect(commandState("format.bold", context)).toEqual({ available: true, pressed: true });
    expect(sessions.get(1)).toMatchObject({ revision: 1, dirty: true });

    expect(executeCommand("edit.undo", undefined, context)).toBe(true);
    await flush();
    expect(edits(fake).at(-1)).toEqual([{ op: "undo" }]);
    expect(commandState("format.bold", context)).toEqual({ available: true, pressed: false });
    expect(commandState("edit.redo", context)).toEqual({ available: true });
    // 되돌리기도 문서를 바꾼 편집이다(백엔드 revision이 는다, 같은 세션·같은 불러오기 시도).
    expect(sessions.get(1)).toMatchObject({ revision: 2, loadGeneration: 1 });

    expect(executeCommand("edit.redo", undefined, context)).toBe(true);
    await flush();
    expect(edits(fake).at(-1)).toEqual([{ op: "redo" }]);
    expect(commandState("format.bold", context)).toEqual({ available: true, pressed: true });
    expect(sessions.get(1)?.revision).toBe(3);
    expect(notices).toEqual([]);
  });

  it("입력 직후(보내는 중) 실행 취소는 같은 대기열 뒤에 들어가 순서대로 실행된다", async () => {
    const { editor, fake } = await readyDocx();
    const { context } = contextFor(editor);
    fake.hold = true;
    editor.typeText("한");
    editor.typeText("글");
    expect(editor.snapshot().pending).toBe(true);
    expect(executeCommand("edit.undo", undefined, context)).toBe(true);
    fake.release();
    await flush();
    fake.release();
    await flush();
    expect(edits(fake)).toEqual([[{ op: "insertText", text: "한" }], [{ op: "insertText", text: "글" }, { op: "undo" }]]);
    // 이어 친 글자는 엔진 기록의 한 단계다(WordCraft 타자 묶기, 흉내도 마무리 안정화부터 따름): 실행 취소가 둘 다 되돌린다.
    expect(fake.paragraphs[0]).toBe("가나다");
  });

  it("되돌릴 기록이 없으면 보내지 않고 이유를 알린다", async () => {
    const { editor, fake } = await readyDocx();
    const { context, notices } = contextFor(editor);
    expect(executeCommand("edit.undo", undefined, context)).toBe(false);
    expect(executeCommand("edit.redo", undefined, context)).toBe(false);
    expect(edits(fake)).toEqual([]);
    expect(notices.map((notice) => notice.key)).toEqual(["command.unavailable.nothingToUndo", "command.unavailable.nothingToRedo"]);
  });

  it("IME 조합 중에는 실행 취소·서식을 하지 않고 조합을 건드리지 않는다", async () => {
    const { editor, fake } = await readyDocx();
    editor.typeText("가");
    await flush();
    const { context, notices } = contextFor(editor);
    editor.beginComposition();
    editor.updateComposition("한");
    const before = edits(fake).length;
    expect(executeCommand("edit.undo", undefined, context)).toBe(false);
    expect(executeCommand("format.bold", undefined, context)).toBe(false);
    // 화면을 거치지 않고 세션에 바로 보내도 세션이 다시 확인해 거절한다.
    expect(editor.execute("edit.undo")).toEqual({ accepted: false });
    expect(edits(fake)).toHaveLength(before);
    expect(editor.composing).toBe(true);
    expect(editor.compositionText).toBe("한");
    expect(notices.map((notice) => notice.key)).toEqual(["command.unavailable.composing", "command.unavailable.composing"]);
    editor.endComposition("한");
    await flush();
    expect(fake.paragraphs[0]).toBe("가한가나다");
  });

  it("닫는 중이면 편집 명령을 보내지 않는다", async () => {
    const { editor, fake } = await readyDocx();
    editor.typeText("가");
    await flush();
    editor.setClosing(true);
    const { context, notices } = contextFor(editor);
    expect(executeCommand("edit.undo", undefined, context)).toBe(false);
    expect(executeCommand("file.save", undefined, context)).toBe(false);
    expect(edits(fake)).toHaveLength(1);
    expect(notices.map((notice) => notice.key)).toEqual(["command.unavailable.notReady", "command.unavailable.notReady"]);
  });

  it("다시 불러오면(새 불러오기 시도) 앞 모델의 기록으로 되돌리지 않는다", async () => {
    const { editor, fake } = await readyDocx();
    editor.typeText("가");
    await flush();
    expect(editor.snapshot().history).toEqual({ undo: true, redo: false });
    // 사용자가 버리기를 확인한 다시 불러오기: 백엔드가 그 모델을 버리고 새 Session을 만든다.
    expect((await editor.load({ discard: true })).ok).toBe(true);
    await flush();
    expect(editor.snapshot()).toMatchObject({ loadGeneration: 2, history: { undo: false, redo: false } });
    const { context } = contextFor(editor);
    expect(executeCommand("edit.undo", undefined, context)).toBe(false);
    expect(edits(fake)).toHaveLength(1);
  });

  it("저장 명령은 기존 저장 절차(사전 검사 → 저장)를 그대로 부르고, 조합 중에는 명령도 저장 절차도 저장하지 않는다", async () => {
    const { editor, fake } = await readyDocx();
    editor.typeText("가");
    await flush();
    const { context, notices } = contextFor(editor);
    editor.beginComposition();
    editor.updateComposition("한");
    // T010 IME 경계 후속: 저장 절차가 막을 조합 중 저장은 가용성에서도 같은 이유로 막는다(처음 T010은 명령을 받아 저장 절차가 실패로 보였음).
    expect(commandState("file.save", context)).toEqual({ available: false, reason: "composing" });
    expect(executeCommand("file.save", undefined, context)).toBe(false);
    expect(notices.map((notice) => notice.key)).toEqual(["command.unavailable.composing"]);
    expect(await editor.save()).toEqual({ ok: false, error: { code: "SaveNotReady", reason: "composing" } }); // 저장 절차의 검사는 그대로
    await flush();
    expect(fake.calls.filter((call) => ["preflight", "save"].includes(call.method))).toEqual([]);
    expect(editor.saveState).toEqual({ kind: "failed", error: { code: "SaveNotReady", reason: "composing" } });
    editor.endComposition("한");
    await flush();

    expect(executeCommand("file.save", undefined, context)).toBe(true);
    expect(commandState("file.save", context)).toEqual({ available: false, reason: "saving" });
    await flush();
    expect(fake.calls.filter((call) => ["preflight", "save"].includes(call.method)).map((call) => call.method)).toEqual(["preflight", "save"]);
    expect(fake.saved).toEqual(["가한가나다", "abc"]);
    expect(editor.saveState).toMatchObject({ kind: "saved", revision: 2 });
  });
});

describe("rhwp 세션의 명령", () => {
  it("실행 취소·서식은 엔진이 지원하지 않아 모델·revision·백엔드 호출을 바꾸지 않는다", async () => {
    const { editor, doc, calls } = await readySession();
    editor.typeText("가");
    const { context, notices } = contextFor(editor);
    const before = { text: [...doc.paragraphs], revision: editor.localRevision, calls: calls.length };
    for (const id of ["edit.undo", "edit.redo", "format.bold", "format.italic", "format.underline", "format.strikethrough"] as const) {
      expect(commandState(id, context)).toEqual({ available: false, reason: "engineUnsupported" });
      expect(executeCommand(id, undefined, context)).toBe(false);
      expect(editor.execute(id)).toEqual({ accepted: false });
    }
    expect({ text: doc.paragraphs, revision: editor.localRevision, calls: calls.length }).toEqual(before);
    expect(new Set(notices.map((notice) => notice.key))).toEqual(new Set(["command.unavailable.engineUnsupported"]));
    expect(editor.snapshot()).toMatchObject({ engine: "rhwp", history: null, format: null });
  });

  it("저장 명령은 rhwp 세션의 저장 절차를 부른다(조합·대기 검사는 그 절차가 한다)", async () => {
    const { editor, take } = await readySession();
    const { context } = contextFor(editor);
    expect(executeCommand("file.save", undefined, context)).toBe(true);
    await flush();
    // 원본을 다시 읽는 사전 검사부터 시작한다(T009 경로). 응답은 주지 않는다(시작만 확인).
    expect(take("original").method).toBe("original");
    expect(commandState("file.save", context)).toEqual({ available: false, reason: "saving" });
  });
});

// ---- 앱: 활성 문서와 단축키 ----

/** DOCX 세션 둘을 여는 작업 공간. 세션마다 가짜 백엔드가 따로다(엔진 모델·기록이 세션마다 따로인 것과 같음). */
function twoDocxWorkspace() {
  const fakes = new Map<number, FakeDocx>([[1, new FakeDocx(["첫 문서"])], [2, new FakeDocx(["둘째 문서"])]]);
  fakes.get(2)!.info = docxInfo({ sessionId: 2, displayName: "b.docx" });
  const byPath = (path: string) => fakes.get(path === "/a.docx" ? 1 : 2)!;
  const ok = <T,>(value: T): Promise<Result<T>> => Promise.resolve({ ok: true, value });
  const backend = {
    open: (path: string) => ok<SessionInfo>({ ...byPath(path).info }),
    session: (id: number) => ok({ ...fakes.get(id)!.info }),
    sessions: () => ok([]),
    close: (sessionId: number) => ok({ sessionId, alreadyClosed: false }),
  } as unknown as DocumentBackend;
  const docx = new Proxy({} as DocxBackend, {
    get: (_, method: keyof DocxBackend) => (id: number, ...rest: unknown[]) =>
      (fakes.get(id)![method] as (...args: unknown[]) => unknown).call(fakes.get(id), id, ...rest),
  });
  const sessions = new DocumentSessions(backend);
  const workspace = new DocumentWorkspace(sessions, backend, undefined, undefined, docx, decodeFake);
  return { fakes, sessions, workspace };
}

describe("앱의 명령 대상", () => {
  it("리본 단추와 Ctrl+B·Ctrl+Z는 활성 탭의 세션에만 가고, 탭을 바꾸면 그 세션의 상태로 다시 정한다", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
    const { fakes, sessions, workspace } = twoDocxWorkspace();
    const user = userEvent.setup();
    render(<App documentWorkspace={workspace} />);
    await act(async () => {
      await workspace.open("/a.docx");
      await workspace.open("/b.docx");
      await flush();
    });
    expect(sessions.snapshot().activeId).toBe(2);
    const bold = screen.getByRole("button", { name: "굵게" });
    const undo = within(screen.getByRole("group", { name: "빠른 실행" })).getByRole("button", { name: "실행 취소" });
    expect(bold).not.toHaveAttribute("aria-disabled");
    expect(bold).toHaveAttribute("aria-pressed", "false");
    expect(undo).toHaveAttribute("aria-disabled", "true");
    expect(undo.title).toContain("되돌릴 편집 없음");

    // 편집 표면의 입력에서 Ctrl+B: 커서만 있으면 다음 입력의 서식(문서는 그대로, revision 그대로).
    const input = document.querySelector<HTMLTextAreaElement>(".rhwp-input")!;
    input.focus();
    await act(async () => {
      await user.keyboard("{Control>}b{/Control}");
      await flush();
    });
    expect(edits(fakes.get(2)!)).toEqual([[{ op: "format", format: "bold" }]]);
    expect(edits(fakes.get(1)!)).toEqual([]);
    expect(bold).toHaveAttribute("aria-pressed", "true");
    expect(sessions.get(2)?.revision).toBe(0);

    await act(async () => {
      workspace.docxEditorFor(2)!.typeText("가");
      await flush();
    });
    expect(undo).not.toHaveAttribute("aria-disabled");
    input.focus();
    await act(async () => {
      await user.keyboard("{Control>}z{/Control}");
      await flush();
    });
    expect(edits(fakes.get(2)!).at(-1)).toEqual([{ op: "undo" }]);
    expect(fakes.get(2)!.paragraphs[0]).toBe("둘째 문서");
    expect(edits(fakes.get(1)!)).toEqual([]);

    // 첫 탭으로 바꾸면 그 세션(기록 없음)의 상태로 정한다.
    await act(async () => {
      sessions.select(1);
      await flush();
    });
    expect(undo).toHaveAttribute("aria-disabled", "true");
    expect(bold).toHaveAttribute("aria-pressed", "false");
    await act(async () => {
      await user.click(bold);
      await flush();
    });
    expect(edits(fakes.get(1)!)).toEqual([[{ op: "format", format: "bold" }]]);
    expect(edits(fakes.get(2)!)).toHaveLength(3);
  });
});
