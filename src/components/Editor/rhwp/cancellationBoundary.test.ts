// 실제 IME 아님: native 취소 trace의 keyup까지 DOM 어댑터·명령 경로에서 재생한다.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as registry from "../../../commands/registry";
import { executeCommand, type CommandContext } from "../../../commands/commands";
import { handleShortcut } from "../../../commands/shortcuts";
import { initialLayout } from "../../../hooks/layoutState";
import { attachTextInput } from "../textInput";
import { ImeContext, ImeInput } from "./imeInput";
import { readySession } from "./testing";

afterEach(() => vi.restoreAllMocks());
async function setup(selected = true) {
  const original = registry.commandDefinition;
  vi.spyOn(registry, "commandDefinition").mockImplementation((id) => {
    const def = original(id);
    return def && (id === "edit.undo" || id === "edit.redo")
      ? { ...def, engines: { wordcraft: { level: "supported" }, rhwp: { level: "supported" } } } : def;
  });
  const s = await readySession(["가나다"]);
  if (selected) { s.editor.moveHorizontal(1, true); s.editor.moveHorizontal(1, true); }
  const context = new ImeContext();
  const ime = new ImeInput(s.editor, context);
  const input = document.createElement("textarea"); input.className = "rhwp-input"; document.body.append(input);
  const detach = attachTextInput(input, ime, { composing: () => s.editor.composing, handleKey: () => false, mark: () => {} });
  const commands: CommandContext = { layout: initialLayout, dispatch: () => {}, notify: () => {}, document: s.editor };
  const fire = (e: Event) => input.dispatchEvent(e);
  const keyUp = (code = "Backspace", isComposing = false) => fire(new KeyboardEvent("keyup", { code, keyCode: code === "Backspace" ? 8 : 35, isComposing }));
  const start = () => { fire(new CompositionEvent("compositionstart")); compose("ㄱ"); };
  const compose = (text: string) => fire(new InputEvent("input", { data: text, inputType: "insertCompositionText", isComposing: true }));
  const empty = () => { fire(new InputEvent("input", { inputType: "deleteCompositionText", isComposing: true })); fire(new CompositionEvent("compositionend", { data: "" })); };
  const final = (text = "간") => { fire(new InputEvent("input", { inputType: "insertFromComposition", data: text, isComposing: true })); fire(new CompositionEvent("compositionend", { data: text })); };
  const undo = () => executeCommand("edit.undo", undefined, commands);
  const cleanup = () => { detach(); input.remove(); s.editor.dispose(); };
  return { ...s, ime, context, fire, keyUp, start, compose, empty, final, undo, commands, cleanup };
}

describe("rhwp 취소 keyup과 Undo 계약", () => {
  it("선택 삭제 취소의 Backspace release 뒤 실제 shortcut → 선택 복원, revision+1, Redo가 삭제를 복원", async () => {
    const s = await setup(); s.start(); s.empty();
    expect(s.editor.snapshot().composing).toBe(true);
    s.keyUp(); expect(s.editor.snapshot().composing).toBe(false);
    expect(s.doc.paragraphs[0]).toBe("다");
    const rev = s.editor.localRevision;
    expect(handleShortcut(new KeyboardEvent("keydown", { code: "KeyZ", key: "z", ctrlKey: true, cancelable: true }), s.commands, false)).toBe(true);
    expect(s.doc.paragraphs[0]).toBe("가나다"); expect(s.editor.localRevision).toBe(rev + 1);
    expect([s.editor.anchor.offset, s.editor.caret.offset]).toEqual([0, 2]);
    expect(s.editor.redo()).toBe(true); expect(s.doc.paragraphs[0]).toBe("다");
    expect(s.editor.undo()).toBe(true); expect(s.undo()).toBe(false); // 반복 의도를 저장하지 않음
    s.cleanup();
  });
  it("선택 없이 취소하면 revision·Undo 단계가 생기지 않음", async () => {
    const s = await setup(false); s.start(); s.empty(); s.keyUp();
    expect(s.doc.paragraphs[0]).toBe("가나다"); expect(s.editor.localRevision).toBe(0);
    expect(s.undo()).toBe(false); expect(s.editor.snapshot().composing).toBe(false); s.cleanup();
  });
  it("활성 조합 중 Ctrl+Z/keyup은 거절하고 이후 확정만 정상적으로 Undo", async () => {
    const s = await setup(); s.start(); s.keyUp(); expect(s.undo()).toBe(false);
    s.final(); expect(s.doc.paragraphs[0]).toBe("간다"); expect(s.undo()).toBe(true);
    expect(s.doc.paragraphs[0]).toBe("가나다"); s.cleanup();
  });
  it("빈 끝과 late final 사이 반복 Ctrl+Z는 거절되고 예약되지 않음, 최종 음절이 남고 그 뒤 명시적 Undo/Redo", async () => {
    const s = await setup(); s.start(); s.empty();
    expect(s.undo()).toBe(false); expect(s.undo()).toBe(false); s.final();
    expect(s.doc.paragraphs[0]).toBe("간다");
    expect(s.editor.snapshot().composing).toBe(false); expect(s.undo()).toBe(true);
    expect(s.doc.paragraphs[0]).toBe("가나다"); expect(s.editor.redo()).toBe(true);
    expect(s.doc.paragraphs[0]).toBe("간다"); s.cleanup();
  });
  it.each(["imeKeyUp", "otherKeyUp", "newInput", "newComposition", "blur", "detach", "pointer", "close", "reloadEpoch"] as const)("%s는 옛 취소 keyup 증거를 무효화하고 명령을 예약하지 않음", async (kind) => {
    const s = await setup(); s.start(); s.empty(); expect(s.undo()).toBe(false);
    if (kind === "imeKeyUp") s.keyUp("Backspace", true);
    if (kind === "otherKeyUp") s.keyUp("End");
    if (kind === "newInput") { s.ime.keyDown(); s.ime.input("x", "insertText", false); }
    if (kind === "newComposition") s.start();
    if (kind === "blur") s.ime.blur();
    if (kind === "detach") s.ime.detach();
    if (kind === "pointer") s.ime.pointerDown();
    if (kind === "close") s.editor.setClosing(true);
    if (kind === "reloadEpoch") s.editor.dispose();
    const before = s.doc.paragraphs[0], rev = s.editor.localRevision;
    s.keyUp();
    expect(s.doc.paragraphs[0]).toBe(before); expect(s.editor.localRevision).toBe(rev);
    if (["imeKeyUp", "otherKeyUp", "blur", "detach", "pointer"].includes(kind)) expect(s.editor.awaitingCommit).toBe(true);
    s.cleanup();
  });
  it("취소 경계 뒤 늦은 옛 확정은 복원한 선택이나 다른 탭을 바꾸지 않음; 새 조합은 수락", async () => {
    const s = await setup(); s.start(); s.empty(); s.keyUp(); expect(s.undo()).toBe(true);
    s.final(); expect(s.doc.paragraphs[0]).toBe("가나다");
    const other = await readySession(["other"]); const otherIme = new ImeInput(other.editor, s.context);
    otherIme.input("간", "insertFromComposition", true); otherIme.compositionEnd("간");
    expect(other.doc.paragraphs[0]).toBe("other");
    s.start(); s.final("하"); expect(s.doc.paragraphs[0]).toBe("하다");
    other.editor.dispose(); s.cleanup();
  });
  it("rapid syllables와 ReplaceInserted의 다른 최종 글자 교정은 한 번씩 남음", async () => {
    const s = await setup(false); s.start(); s.empty(); s.final("가"); s.start(); s.empty(); s.final("나");
    s.start(); s.ime.pointerDown(); s.empty(); s.final("한");
    expect(s.doc.paragraphs[0]).toBe("가나한가나다"); expect(s.editor.localRevision).toBe(3);
    s.cleanup();
  });
});
