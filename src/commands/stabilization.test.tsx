// T010 안정화: 앱이 먼저 확정한 IME 조합과 명령(P1-A), 확인 창이 열린 동안의 명령(P1-B), 보내는 중인 작업과 실행 취소 가용성
// (P2-A). 편집 세션·ImeInput·App은 실제 코드이고 백엔드는 FakeDocx 흉내다(엔진 동작의 증거가 아님). 실제 ibus-hangul 입력의
// 순서는 tests/integration/wordcraft/wordcraft_poc.py가 따로 본다.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../App";
import type { DocumentBackend } from "../adapters/backend";
import type { Result, SessionInfo } from "../adapters/contract";
import { DocumentSessions } from "../adapters/sessions";
import { initialLayout } from "../hooks/layoutState";
import type { Message } from "../language";
import { DocumentWorkspace } from "../components/Editor/documentWorkspace";
import { ImeContext, ImeInput } from "../components/Editor/rhwp/imeInput";
import { decodeFake, FakeDocx, flush, readyDocx } from "../components/Editor/wordcraft/testing";
import { commandState, executeCommand, type CommandContext } from "./commands";
import { handleShortcut } from "./shortcuts";
import type { DocumentCommandTarget } from "./target";

const edits = (fake: FakeDocx) => fake.calls.filter((call) => call.method === "edit").map((call) => call.args[3]);

function contextFor(document: DocumentCommandTarget | null, patch: Partial<CommandContext> = {}) {
  const notices: Message[] = [];
  const context: CommandContext = {
    layout: initialLayout, dispatch: () => {}, notify: (message) => notices.push(message), document, ...patch,
  };
  return { context, notices };
}

/** 보이던 조합 '하'를 초점 잃음으로 앱이 먼저 확정한다(입력기의 끝은 아직 오지 않음). */
async function provisional(text: string[] = ["가나다", "abc"]) {
  const harness = await readyDocx(text);
  const ime = new ImeInput(harness.editor, new ImeContext());
  ime.keyDown(true);
  ime.compositionStart();
  ime.input("하", "insertCompositionText", true);
  ime.blur();
  await flush();
  return { ...harness, ime };
}

/** 입력기가 그 조합을 끝내며 보내는 꼬리(실측 WebKitGTK 2.54 + ibus-hangul 순서, imeInput.ts). */
function tail(ime: ImeInput, finalText: string) {
  ime.keyDown(true);
  ime.input("", "deleteCompositionText", true);
  ime.compositionEnd("");
  ime.keyDown(true);
  ime.input(finalText, "insertFromComposition", true);
  ime.compositionEnd(finalText);
}

describe("P1-A 앱이 먼저 확정한 조합과 문서 명령", () => {
  it("입력기의 끝을 기다리는 동안 서식·실행 취소는 하지 않고, 입력기의 최종 글자로 고친다", async () => {
    const { editor, fake, ime } = await provisional();
    const { context, notices } = contextFor(editor);
    expect(editor.snapshot().composing).toBe(true);
    for (const id of ["format.bold", "edit.undo", "edit.redo"]) {
      expect(commandState(id, context)).toMatchObject({ available: false, reason: "composing" });
      expect(executeCommand(id, undefined, context)).toBe(false);
    }
    expect(editor.execute("format.bold")).toEqual({ accepted: false });
    tail(ime, "한");
    await flush();
    expect(edits(fake)).toEqual([[{ op: "insertText", text: "하" }], [{ op: "replaceInserted", expected: "하", text: "한" }]]);
    expect(fake.paragraphs[0]).toBe("한가나다");
    expect(notices.map((notice) => notice.key)).toEqual(Array(3).fill("command.unavailable.composing"));
    // 조합이 끝나면 다시 쓸 수 있다.
    expect(commandState("edit.undo", context)).toEqual({ available: true });
    expect(executeCommand("edit.undo", undefined, context)).toBe(true);
    await flush();
    expect(edits(fake).at(-1)).toEqual([{ op: "undo" }]);
  });

  it("최종 글자가 같으면 고치지 않고 한 번만 넣으며, 반복한 명령도 아무것도 바꾸지 않는다", async () => {
    const { editor, fake, ime } = await provisional();
    const { context } = contextFor(editor);
    for (let i = 0; i < 3; i++) expect(executeCommand("format.bold", undefined, context)).toBe(false);
    tail(ime, "하");
    await flush();
    expect(edits(fake)).toEqual([[{ op: "insertText", text: "하" }]]);
    expect(fake.paragraphs[0]).toBe("하가나다");
    expect(fake.info.revision).toBe(1);
  });

  it("입력기의 끝 없이 새 입력이 시작되면(keydown) 그 조합을 모델 그대로 끝내고 단축키를 받는다", async () => {
    const { editor, fake, ime } = await provisional();
    const { context } = contextFor(editor);
    ime.keyDown(false); // 수식 키 없는 키(예: ←): 새 입력의 시작(imeInput 규칙). Ctrl 등은 textInput이 경계로 보내지 않는다(imeBoundary.test)
    expect(editor.snapshot().composing).toBe(false);
    expect(executeCommand("edit.undo", undefined, context)).toBe(true);
    await flush();
    expect(edits(fake)).toEqual([[{ op: "insertText", text: "하" }], [{ op: "undo" }]]);
    expect(fake.paragraphs[0]).toBe("가나다");
  });

  it("빈 최종 글자(입력기가 취소)는 앱이 넣은 글자를 그대로 두고 한 번 센다", async () => {
    const { editor, fake, ime } = await provisional();
    ime.keyDown(true);
    ime.input("", "deleteCompositionText", true);
    ime.compositionEnd("");
    expect(editor.snapshot().composing).toBe(true); // 빈 끝 뒤 확정 절반을 기다림
    ime.keyDown(false);
    await flush();
    expect(editor.snapshot().composing).toBe(false);
    expect(edits(fake)).toEqual([[{ op: "insertText", text: "하" }]]);
  });
});

describe("P1-A 문서 전환·같은 음절", () => {
  it("조합 중 문서를 바꾸면 그 문서의 조합만 기다리고, 다른 문서의 명령은 그 문서에만 간다", async () => {
    const a = await readyDocx(["첫 문서"]);
    const b = await readyDocx(["둘째 문서"]);
    const context = new ImeContext();
    const imeA = new ImeInput(a.editor, context);
    const imeB = new ImeInput(b.editor, context);
    imeA.keyDown(true);
    imeA.compositionStart();
    imeA.input("하", "insertCompositionText", true);
    imeA.detach(); // 표면이 사라짐(탭 전환)
    await flush();
    expect(a.editor.snapshot().composing).toBe(true);
    expect(b.editor.snapshot().composing).toBe(false);
    b.editor.move("right", true);
    await flush();
    expect(executeCommand("format.bold", undefined, contextFor(b.editor).context)).toBe(true);
    expect(executeCommand("format.bold", undefined, contextFor(a.editor).context)).toBe(false);
    tail(imeB, "한"); // 입력기의 꼬리는 새 표면에 도착한다
    await flush();
    expect(edits(a.fake)).toEqual([[{ op: "insertText", text: "하" }], [{ op: "replaceInserted", expected: "하", text: "한" }]]);
    expect(a.fake.paragraphs[0]).toBe("한첫 문서");
    expect(edits(b.fake).flat()).toEqual([{ op: "move", to: "right", extend: true }, { op: "format", format: "bold" }]);
    expect(b.fake.paragraphs[0]).toBe("둘째 문서");
  });

  it("같은 음절을 연달아 확정해도 둘 다 남고, 끝난 뒤의 서식은 바로 실행된다", async () => {
    const { editor, fake, ime } = await provisional();
    tail(ime, "하");
    ime.keyDown(true);
    ime.compositionStart();
    ime.input("하", "insertCompositionText", true);
    ime.compositionEnd("하");
    await flush();
    expect(editor.snapshot().composing).toBe(false);
    expect(executeCommand("format.bold", undefined, contextFor(editor).context)).toBe(true);
    await flush();
    expect(edits(fake).flat()).toEqual([
      { op: "insertText", text: "하" }, { op: "insertText", text: "하" }, { op: "format", format: "bold" },
    ]);
    expect(fake.paragraphs[0]).toBe("하하가나다");
  });
});

// ---- P2-A ----

describe("P2-A 보내는 중인 작업과 실행 취소 가용성", () => {
  it("기록이 비었을 때 이동·선택·표지만 보내는 중이면 실행 취소를 쓸 수 없다", async () => {
    const { editor, fake } = await readyDocx();
    const { context } = contextFor(editor);
    fake.hold = true;
    editor.move("right", false);
    expect(editor.snapshot().pending).toBe(true);
    expect(commandState("edit.undo", context)).toEqual({ available: false, reason: "nothingToUndo" });
    editor.move("right", true);
    editor.selectAll();
    editor.markCaret();
    expect(commandState("edit.undo", context)).toEqual({ available: false, reason: "nothingToUndo" });
    expect(executeCommand("edit.undo", undefined, context)).toBe(false);
    // 글자 넣기가 보내는 중이면 그 뒤에 넣을 수 있다(엔진이 순서대로 실행).
    editor.typeText("가");
    expect(commandState("edit.undo", context)).toEqual({ available: true });
    fake.release();
    await flush();
    fake.release();
    await flush();
    expect((edits(fake).flat() as { op: string }[]).some((op) => op.op === "undo")).toBe(false);
  });
});

describe("P2-A 대기 예상과 엔진 결과(FakeDocx 흉내)", () => {
  const release = async (fake: FakeDocx) => {
    for (let i = 0; i < 4; i++) {
      fake.release();
      await flush();
    }
  };

  it("엔진이 거부한 넣기 뒤의 실행 취소는 보내지만 엔진이 아무것도 바꾸지 않고, 응답 뒤에는 쓸 수 없다", async () => {
    const { editor, fake } = await readyDocx();
    const { context } = contextFor(editor);
    fake.refuseText = () => true;
    fake.hold = true;
    editor.typeText("가");
    expect(commandState("edit.undo", context)).toEqual({ available: true }); // 엔진만 거부를 안다
    expect(executeCommand("edit.undo", undefined, context)).toBe(true);
    await release(fake);
    expect(fake.paragraphs[0]).toBe("가나다");
    expect(fake.info.revision).toBe(0);
    expect(commandState("edit.undo", context)).toEqual({ available: false, reason: "nothingToUndo" });
  });

  it("실행 취소 바로 뒤(응답 전)의 다시 실행은 같은 대기열 뒤에 들어가 원래대로 돌린다", async () => {
    const { editor, fake } = await readyDocx();
    const { context } = contextFor(editor);
    editor.typeText("가");
    await flush();
    fake.hold = true;
    expect(executeCommand("edit.undo", undefined, context)).toBe(true);
    // 실행 취소가 하나뿐인 아는 단계를 썼다: 다시 실행은 하나 생기고, 남은 실행 취소 단계는 응답 전에 모른다(마무리 안정화).
    expect(editor.snapshot().queuedHistory).toEqual({ undo: "unknown", redo: "available" });
    expect(executeCommand("edit.redo", undefined, context)).toBe(true);
    await release(fake);
    expect(edits(fake).slice(1)).toEqual([[{ op: "undo" }], [{ op: "redo" }]]);
    expect(fake.paragraphs[0]).toBe("가가나다");
    expect(fake.info.revision).toBe(3);
  });

  it("되풀이한 실행 취소는 엔진 기록만큼만 되돌리고 나머지는 아무것도 바꾸지 않는다", async () => {
    const { editor, fake } = await readyDocx();
    const { context } = contextFor(editor);
    editor.typeText("가");
    await flush();
    fake.hold = true;
    for (let i = 0; i < 3; i++) executeCommand("edit.undo", undefined, context);
    await release(fake);
    expect(fake.paragraphs[0]).toBe("가나다");
    expect(fake.info.revision).toBe(2); // 넣기 1 + 실제로 바뀐 실행 취소 1
    expect(commandState("edit.undo", context)).toEqual({ available: false, reason: "nothingToUndo" });
  });

  it("대기 중에 다시 불러오면 대기한 실행 취소는 보내지 않고 새 모델의 기록으로 정한다", async () => {
    const { editor, fake } = await readyDocx();
    const { context } = contextFor(editor);
    fake.hold = true;
    editor.typeText("가");
    expect(executeCommand("edit.undo", undefined, context)).toBe(true);
    const reloading = editor.load({ discard: true });
    await release(fake);
    expect((await reloading).ok).toBe(true);
    await release(fake);
    expect((edits(fake).flat() as { op: string }[]).map((op) => op.op)).toEqual(["insertText"]);
    expect(editor.snapshot()).toMatchObject({ loadGeneration: 2, queuedHistory: null, history: { undo: false, redo: false } });
    expect(fake.paragraphs[0]).toBe("가나다");
  });
});

// ---- P2-B ----

describe("P2-B 문서 보호와 서식(FakeDocx 흉내 — 엔진 판정은 Rust 시험)", () => {
  it("엔진이 언제나 거부하는 보호면 서식 명령을 보내지 않고 이유를 알린다", async () => {
    const { editor, fake } = await readyDocx();
    fake.formatAccess = "protected";
    editor.move("right", true);
    await flush();
    const { context, notices } = contextFor(editor);
    expect(commandState("format.bold", context)).toEqual({ available: false, reason: "protected" });
    expect(executeCommand("format.bold", undefined, context)).toBe(false);
    expect(edits(fake).flat()).toEqual([{ op: "move", to: "right", extend: true }]);
    expect(notices.map((notice) => notice.key)).toEqual(["command.unavailable.protected"]);
  });

  it("편집 가능 영역만 허용하는 보호에서 엔진이 거부하면 문서·revision·기록이 그대로이고 거부를 알린다", async () => {
    const { editor, fake } = await readyDocx();
    fake.formatAccess = "regions";
    fake.refuseFormat = true;
    editor.move("right", true);
    await flush();
    const { context } = contextFor(editor);
    expect(commandState("format.bold", context)).toEqual({ available: true, pressed: false });
    expect(executeCommand("format.bold", undefined, context)).toBe(true);
    await flush();
    expect(editor.inputNotice).toBe("commandRejected");
    expect(fake.info).toMatchObject({ revision: 0, dirty: false });
    expect(editor.snapshot().history).toEqual({ undo: false, redo: false });
    expect(commandState("format.bold", context)).toEqual({ available: true, pressed: false });
    // 다음 입력이 알림을 지운다.
    editor.typeText("가");
    expect(editor.inputNotice).toBeNull();
  });
});

// ---- P1-B ----

function workspaceWithDocx() {
  const fake = new FakeDocx();
  const ok = <T,>(value: T): Promise<Result<T>> => Promise.resolve({ ok: true, value });
  const backend = {
    open: () => ok<SessionInfo>({ ...fake.info }),
    session: () => ok({ ...fake.info }),
    sessions: () => ok([]),
    close: (sessionId: number) => ok({ sessionId, alreadyClosed: false }),
  } as unknown as DocumentBackend;
  const sessions = new DocumentSessions(backend);
  const workspace = new DocumentWorkspace(sessions, backend, undefined, undefined, fake, decodeFake);
  return { fake, sessions, workspace };
}

describe("P1-B 확인 창이 열린 동안의 명령", () => {
  it("버리기 확인 창에 초점이 있으면 Ctrl+Z·Ctrl+B·Ctrl+S·Ctrl+F1이 문서·배치를 바꾸지 않는다", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
    const { fake, workspace } = workspaceWithDocx();
    render(<App documentWorkspace={workspace} />);
    await act(async () => {
      await workspace.open("/a.docx");
      await flush();
    });
    const editor = workspace.docxEditorFor(1)!;
    await act(async () => {
      editor.typeText("가");
      await flush();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "a.docx 닫기" }));
      await flush();
    });
    const dialog = screen.getByRole("alertdialog");
    const cancel = screen.getByTestId("discard-cancel");
    expect(document.activeElement).toBe(cancel);
    const before = { edits: edits(fake).length, ribbon: screen.queryByRole("tabpanel") !== null };
    for (const [code, key] of [["KeyZ", "z"], ["KeyB", "b"], ["KeyS", "s"], ["F1", "F1"]]) {
      await act(async () => {
        fireEvent.keyDown(cancel, { code, key, ctrlKey: true });
        await flush();
      });
    }
    expect(edits(fake)).toHaveLength(before.edits);
    expect(fake.calls.filter((call) => ["preflight", "save"].includes(call.method))).toEqual([]);
    expect(screen.queryByRole("tabpanel") !== null).toBe(before.ribbon);
    expect(dialog).toBeInTheDocument();
    expect(document.activeElement).toBe(cancel);
    // 취소하면 창이 닫히고 문서 명령을 다시 쓸 수 있다.
    await act(async () => {
      fireEvent.click(cancel);
      await flush();
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const input = document.querySelector<HTMLTextAreaElement>(".rhwp-input")!;
    await act(async () => {
      fireEvent.keyDown(input, { code: "KeyZ", key: "z", ctrlKey: true });
      await flush();
    });
    expect(edits(fake).at(-1)).toEqual([{ op: "undo" }]);
  });

  it("막힌 문맥에서는 단추·단축키 모두 실행하지 않는다(문서·배치 명령)", () => {
    let dispatched = 0;
    const executed: string[] = [];
    const target: DocumentCommandTarget = {
      sessionId: 1, engine: "wordcraft",
      snapshot: () => ({
        sessionId: 1, engine: "wordcraft", loadGeneration: 1, revision: 1, loaded: true, editable: true, composing: false,
        pending: false, queuedHistory: null, saving: false, history: { undo: true, redo: true },
        format: { bold: false, italic: false, underline: false, strikethrough: false }, formatAccess: "allowed",
      }),
      execute: (command) => {
        executed.push(command);
        return { accepted: true };
      },
    };
    const { context } = contextFor(target, { dispatch: () => void dispatched++, modal: true });
    for (const id of ["edit.undo", "format.bold", "file.save", "view.ribbon", "view.zoomIn"]) {
      expect(commandState(id, context)).toEqual({ available: false, reason: "dialogOpen" });
      expect(executeCommand(id, undefined, context)).toBe(false);
    }
    const event = new KeyboardEvent("keydown", { code: "KeyZ", key: "z", ctrlKey: true, cancelable: true });
    Object.defineProperty(event, "target", { value: document.body });
    expect(handleShortcut(event, context, false)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(executed).toEqual([]);
    expect(dispatched).toBe(0);
  });
});
