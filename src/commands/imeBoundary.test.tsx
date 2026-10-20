// T010 마무리 안정화: IME 트랜잭션 경계와 명령. 편집 입력(textInput)·ImeInput·DocxEditorSession·단축키 처리는 실제 코드이고,
// 이벤트는 실측 WebKitGTK 2.54 + ibus-hangul 순서(imeInput.ts·editor-surface-decision.md)를 그대로 재생한다(백엔드는 FakeDocx 흉내).
// 실제 입력기에서 그 순서가 나오는지는 tests/integration/wordcraft/wordcraft_poc.py --ime-commands가 본다.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../App";
import type { DocumentBackend } from "../adapters/backend";
import type { Result, SessionInfo } from "../adapters/contract";
import { DocumentSessions } from "../adapters/sessions";
import { initialLayout } from "../hooks/layoutState";
import { DocumentWorkspace } from "../components/Editor/documentWorkspace";
import { ImeContext, ImeInput } from "../components/Editor/rhwp/imeInput";
import { attachTextInput } from "../components/Editor/textInput";
import { decodeFake, FakeDocx, flush, readyDocx } from "../components/Editor/wordcraft/testing";
import type { CommandContext } from "./commands";
import { handleShortcut } from "./shortcuts";

const edits = (fake: FakeDocx) => fake.calls.filter((call) => call.method === "edit").flatMap((call) => call.args[3] as object[]);

/** 편집 입력 하나를 실제 textInput으로 붙인 DOCX 세션과, 창의 단축키 처리(App과 같은 순서: 편집 입력 다음 창). */
async function surface() {
  const { editor, fake } = await readyDocx();
  const ime = new ImeInput(editor, new ImeContext());
  const input = document.createElement("textarea");
  input.className = "rhwp-input";
  document.body.append(input);
  const detach = attachTextInput(input, ime, { composing: () => editor.composing, handleKey: () => false, mark: () => {} });
  const notices: string[] = [];
  const context: CommandContext = {
    layout: initialLayout, dispatch: () => {}, notify: (message) => notices.push(message.key), document: editor,
  };
  const onKey = (event: KeyboardEvent) => void handleShortcut(event, context, false);
  window.addEventListener("keydown", onKey);
  input.focus();
  const fire = (event: Event) => input.dispatchEvent(event);
  const composition = (text: string) => {
    fire(new KeyboardEvent("keydown", { keyCode: 229, isComposing: true, bubbles: true } as KeyboardEventInit));
    fire(new InputEvent("beforeinput", { inputType: "insertCompositionText", data: text, isComposing: true, cancelable: true }));
    fire(new InputEvent("input", { inputType: "insertCompositionText", data: text, isComposing: true }));
  };
  /** 입력기가 끝내며 보내는 꼬리(빈 끝 + 확정 절반, 실측 순서). */
  const tail = (finalText: string) => {
    fire(new KeyboardEvent("keydown", { keyCode: 229, isComposing: true, bubbles: true } as KeyboardEventInit));
    fire(new InputEvent("input", { inputType: "deleteCompositionText", isComposing: true }));
    fire(new CompositionEvent("compositionend", { data: "" }));
    fire(new KeyboardEvent("keydown", { keyCode: 229, bubbles: true } as KeyboardEventInit));
    fire(new InputEvent("input", { inputType: "insertFromComposition", data: finalText, isComposing: true }));
    fire(new CompositionEvent("compositionend", { data: finalText }));
  };
  const chord = (code: string, key: string) =>
    fire(new KeyboardEvent("keydown", { code, key, ctrlKey: true, bubbles: true, cancelable: true }));
  const cleanup = () => {
    window.removeEventListener("keydown", onKey);
    detach();
    input.remove();
  };
  return { editor, fake, ime, input, fire, composition, tail, chord, notices, cleanup };
}

describe("경계 A: 수식 키 단축키는 IME 트랜잭션의 새 입력 경계가 아니다", () => {
  it("페이지 클릭으로 앱이 먼저 확정한 조합 뒤 Ctrl+B는 거절되고, 늦게 온 최종 글자로 한 번만 고친다(두 번 넣지 않음)", async () => {
    const t = await surface();
    t.fire(new CompositionEvent("compositionstart", { data: "" }));
    t.composition("하");
    t.ime.pointerDown(); // 표면이 페이지 누름에서 부름(초점은 편집 입력에 남음)
    await flush();
    t.chord("ControlLeft", "Control");
    t.chord("KeyB", "b");
    await flush();
    expect(t.editor.snapshot().composing).toBe(true);
    expect(t.notices).toEqual(["command.unavailable.composing"]);
    t.tail("한");
    await flush();
    expect(edits(t.fake)).toEqual([
      { op: "insertText", text: "하" }, { op: "replaceInserted", expected: "하", text: "한" },
    ]);
    expect(t.fake.paragraphs[0]).toBe("한가나다");
    // 트랜잭션이 끝났으므로 같은 단축키가 이제 실행된다.
    t.chord("KeyB", "b");
    await flush();
    expect(edits(t.fake).at(-1)).toEqual({ op: "format", format: "bold" });
    t.cleanup();
  });

  it("같은 순서에서 Ctrl+Z도 미완료 트랜잭션을 되돌리지 않는다", async () => {
    const t = await surface();
    t.fire(new CompositionEvent("compositionstart", { data: "" }));
    t.composition("하");
    t.ime.pointerDown();
    await flush();
    t.chord("KeyZ", "z");
    t.tail("하");
    await flush();
    expect(edits(t.fake)).toEqual([{ op: "insertText", text: "하" }]);
    expect(t.fake.paragraphs[0]).toBe("하가나다");
    expect(t.fake.info.revision).toBe(1);
    t.cleanup();
  });

  it("수식 키가 아닌 키(새 입력)는 여전히 경계다: 앱이 확정한 글자를 그대로 한 번 센다", async () => {
    const t = await surface();
    t.fire(new CompositionEvent("compositionstart", { data: "" }));
    t.composition("하");
    t.ime.pointerDown();
    await flush();
    t.fire(new KeyboardEvent("keydown", { key: "ArrowLeft", code: "ArrowLeft", bubbles: true }));
    await flush();
    expect(t.editor.snapshot().composing).toBe(false);
    expect(edits(t.fake)).toEqual([{ op: "insertText", text: "하" }]);
    t.cleanup();
  });

  it("빈 끝 뒤 확정 절반이 오기 전의 Ctrl+Z는 확정을 잃게 하지 않는다(편집 입력에 초점이 남은 경우)", async () => {
    const t = await surface();
    t.fire(new CompositionEvent("compositionstart", { data: "" }));
    t.composition("하");
    // 입력기가 확정을 시작했다(빈 끝까지만 옴).
    t.fire(new KeyboardEvent("keydown", { keyCode: 229, isComposing: true, bubbles: true } as KeyboardEventInit));
    t.fire(new InputEvent("input", { inputType: "deleteCompositionText", isComposing: true }));
    t.fire(new CompositionEvent("compositionend", { data: "" }));
    t.chord("KeyZ", "z"); // 기록이 없어 거절(아무것도 바꾸지 않음)
    t.fire(new KeyboardEvent("keydown", { keyCode: 229, bubbles: true } as KeyboardEventInit));
    t.fire(new InputEvent("input", { inputType: "insertFromComposition", data: "하", isComposing: true }));
    t.fire(new CompositionEvent("compositionend", { data: "하" }));
    await flush();
    expect(t.fake.paragraphs[0]).toBe("하가나다");
    expect(edits(t.fake)).toEqual([{ op: "insertText", text: "하" }]);
    t.cleanup();
  });
});

// ---- 경계 C: 명령 단추와 편집 입력 초점 ----

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
  return { fake, workspace: new DocumentWorkspace(sessions, backend, undefined, undefined, fake, decodeFake) };
}

describe("경계 C: 편집 입력에 초점이 있을 때 명령 단추는 초점을 가져가지 않는다", () => {
  it("리본·빠른 실행 단추를 눌러도 편집 입력이 초점을 지키고(늦은 IME 이벤트가 편집 입력에 닿음) 명령은 실행된다", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
    const { fake, workspace } = workspaceWithDocx();
    render(<App documentWorkspace={workspace} />);
    await act(async () => {
      await workspace.open("/a.docx");
      await flush();
    });
    const input = document.querySelector<HTMLTextAreaElement>(".rhwp-input")!;
    input.focus();
    const bold = screen.getByRole("button", { name: "굵게" });
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => void bold.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    await act(async () => {
      fireEvent.click(bold);
      await flush();
    });
    expect(edits(fake).at(-1)).toEqual({ op: "format", format: "bold" });
    expect(document.activeElement).toBe(input);
  });

  it("편집 입력에 초점이 없으면 단추는 보통처럼 초점을 받는다(키보드·접근성 동작 그대로)", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
    render(<App documentWorkspace={null} />);
    const bold = screen.getByRole("button", { name: "굵게" });
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => void bold.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(false);
  });
});
