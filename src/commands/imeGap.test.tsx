// T010 IME 트랜잭션 경계: 입력기의 빈 끝(compositionend "")과 최종 글자(insertFromComposition → compositionend) 사이. 편집 입력
// (textInput)·ImeInput·DocxEditorSession·명령 처리는 실제 코드이고, 이벤트는 실측 WebKitGTK 2.54 + ibus-hangul 순서
// (editor-surface-decision.md "T010 마무리 안정화")를 재생한다. 백엔드는 FakeDocx 흉내(WordCraft 기록 규칙을 따름)이며, 다음 입력
// 서식이 그다음 넣기에 붙는 것은 Rust 시험 `t010_선택이_없으면_서식은_다음_입력에만_…`이 실제 엔진으로 확인한다.
import { describe, expect, it } from "vitest";
import { initialLayout } from "../hooks/layoutState";
import { ImeContext, ImeInput } from "../components/Editor/rhwp/imeInput";
import { attachTextInput } from "../components/Editor/textInput";
import { flush, readyDocx, type FakeDocx } from "../components/Editor/wordcraft/testing";
import type { DocxEditorSession } from "../components/Editor/wordcraft/DocxEditorSession";
import { executeCommand, type CommandContext } from "./commands";
import { handleShortcut } from "./shortcuts";

const ops = (fake: FakeDocx) =>
  (fake.calls.filter((call) => call.method === "edit").flatMap((call) => call.args[3]) as { op: string; text?: string }[])
    .filter((op) => op.op !== "mark")
    .map((op) => (op.text ? `${op.op}:${op.text}` : op.op));

/** 편집 입력 하나를 실제 textInput으로 붙이고(IME 문맥은 함께 씀), 창의 단축키 처리를 그 문서에 둔다. */
function mount(editor: DocxEditorSession, context: ImeContext) {
  const ime = new ImeInput(editor, context);
  const input = document.createElement("textarea");
  input.className = "rhwp-input";
  document.body.append(input);
  const detach = attachTextInput(input, ime, { composing: () => editor.composing, handleKey: () => false, mark: () => {} });
  const notices: string[] = [];
  const commands: CommandContext = {
    layout: initialLayout, dispatch: () => {}, notify: (message) => notices.push(message.key), document: editor,
  };
  const onKey = (event: KeyboardEvent) => void handleShortcut(event, commands, false);
  window.addEventListener("keydown", onKey);
  input.focus();
  const fire = (event: Event) => input.dispatchEvent(event);
  const ime229 = (composing: boolean) =>
    fire(new KeyboardEvent("keydown", { keyCode: 229, isComposing: composing, bubbles: true } as KeyboardEventInit));
  const t = {
    ime, input, notices,
    start: () => fire(new CompositionEvent("compositionstart", { data: "" })),
    compose: (text: string) => {
      ime229(true);
      fire(new InputEvent("input", { inputType: "insertCompositionText", data: text, isComposing: true }));
    },
    /** 입력기 확정의 앞 반쪽: 조합 글자 지우기와 빈 끝. */
    emptyEnd: () => {
      ime229(true);
      fire(new InputEvent("input", { inputType: "deleteCompositionText", isComposing: true }));
      fire(new CompositionEvent("compositionend", { data: "" }));
    },
    /** 입력기 확정의 뒤 반쪽: 최종 글자와 끝. */
    finalHalf: (text: string) => {
      ime229(false);
      fire(new InputEvent("input", { inputType: "insertFromComposition", data: text, isComposing: true }));
      fire(new CompositionEvent("compositionend", { data: text }));
    },
    chord: (code: string, key: string) => fire(new KeyboardEvent("keydown", { code, key, ctrlKey: true, bubbles: true, cancelable: true })),
    key: (key: string) => fire(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true })),
    type: (text: string) => {
      fire(new InputEvent("beforeinput", { inputType: "insertText", data: text, cancelable: true }));
      fire(new InputEvent("input", { inputType: "insertText", data: text }));
    },
    /** 리본·빠른 실행 단추(포인터): 편집 입력 초점은 그대로이고(경계 C) 명령 경계로 바로 간다. */
    button: (id: string) => executeCommand(id, undefined, commands),
    unmount: () => {
      window.removeEventListener("keydown", onKey);
      detach();
      input.remove();
    },
  };
  return t;
}

/** 기록 단계가 있는 문서: 문서 처음에서 문단을 나눈 편집(타자 묶음과 따로인 한 단계). */
async function edited(text?: string[]) {
  const { editor, fake } = await readyDocx(text);
  editor.enter();
  await flush();
  expect(editor.snapshot().history).toEqual({ undo: true, redo: false });
  return { editor, fake };
}

describe("빈 끝과 최종 글자 사이의 명령(앞선 편집이 있는 문서)", () => {
  it("Ctrl+Z는 조합이 끝나지 않았다고 거절되고, 최종 글자가 들어간 뒤에야 그 글자를 되돌린다(앞선 편집을 먼저 되돌리지 않음)", async () => {
    const { editor, fake } = await edited();
    const t = mount(editor, new ImeContext());
    t.start();
    t.compose("하");
    t.emptyEnd();
    expect(editor.snapshot().composing).toBe(true);
    t.chord("KeyZ", "z");
    await flush();
    expect(t.notices).toEqual(["command.unavailable.composing"]);
    t.finalHalf("하");
    await flush();
    expect(editor.snapshot().composing).toBe(false);
    expect(fake.paragraphs).toEqual(["", "하가나다", "abc"]);
    expect(fake.info.revision).toBe(2);
    t.chord("KeyZ", "z");
    await flush();
    expect(ops(fake)).toEqual(["newParagraph", "insertText:하", "undo"]);
    expect(fake.paragraphs).toEqual(["", "가나다", "abc"]);
    expect(editor.snapshot().history).toEqual({ undo: true, redo: true });
    t.unmount();
  });

  it("Ctrl+B·리본 굵게도 최종 글자 전에는 실행되지 않는다(다음 입력 서식이 방금 친 음절에 붙지 않음)", async () => {
    for (const via of ["chord", "button"] as const) {
      const { editor, fake } = await edited();
      const t = mount(editor, new ImeContext());
      t.start();
      t.compose("하");
      t.emptyEnd();
      if (via === "chord") t.chord("KeyB", "b");
      else expect(t.button("format.bold")).toBe(false);
      t.finalHalf("하");
      await flush();
      expect(ops(fake)).toEqual(["newParagraph", "insertText:하"]);
      if (via === "chord") t.chord("KeyB", "b");
      else expect(t.button("format.bold")).toBe(true);
      await flush();
      expect(ops(fake)).toEqual(["newParagraph", "insertText:하", "format"]);
      expect(fake.paragraphs[1]).toBe("하가나다");
      t.unmount();
    }
  });
});

describe("빈 끝 뒤의 다른 순서", () => {
  it("진짜 취소(최종 글자가 오지 않음): 글자·revision을 만들지 않고, 수식 키 없는 키로 다시 명령을 받는다", async () => {
    const { editor, fake } = await edited();
    const t = mount(editor, new ImeContext());
    t.start();
    t.compose("ㅎ");
    t.emptyEnd();
    t.chord("KeyZ", "z");
    await flush();
    expect(editor.snapshot().composing).toBe(true);
    t.key("Escape"); // 새 입력의 시작(입력기가 처리하지 않은 키)
    expect(editor.snapshot().composing).toBe(false);
    t.chord("KeyZ", "z");
    await flush();
    expect(ops(fake)).toEqual(["newParagraph", "undo"]);
    expect(fake.paragraphs).toEqual(["가나다", "abc"]);
    expect(fake.info.revision).toBe(2);
    t.unmount();
  });

  it("진짜 취소 뒤 새 조합·일반 글자 입력도 대기를 끝낸다", async () => {
    const { editor, fake } = await edited();
    const t = mount(editor, new ImeContext());
    t.start();
    t.compose("ㅎ");
    t.emptyEnd();
    t.start(); // 새 조합
    expect(editor.snapshot().composing).toBe(true); // 이제는 진행 중인 조합
    t.compose("가");
    t.finalHalf("가");
    t.type("a");
    await flush();
    expect(editor.snapshot().composing).toBe(false);
    expect(ops(fake)).toEqual(["newParagraph", "insertText:가", "insertText:a"]);
    t.unmount();
  });

  it("빈 끝 뒤 페이지 클릭: 최종 글자는 클릭 전 자리에 한 번 들어가고 그때까지 명령은 거절된다", async () => {
    const { editor, fake } = await edited();
    const t = mount(editor, new ImeContext());
    t.start();
    t.compose("하");
    t.emptyEnd();
    t.ime.pointerDown();
    editor.move("docEnd", false); // 클릭으로 커서가 옮겨 감
    await flush();
    expect(editor.snapshot().composing).toBe(true);
    t.finalHalf("하");
    await flush();
    expect(fake.paragraphs).toEqual(["", "하가나다", "abc"]);
    expect(ops(fake)).toEqual(["newParagraph", "move", "insertAt:하"]);
    expect(editor.snapshot().composing).toBe(false);
    t.unmount();
  });

  it("최종 글자만(시작 없이) 온 확정·되풀이한 끝·같은 음절 둘", async () => {
    const { editor, fake } = await edited();
    const t = mount(editor, new ImeContext());
    t.finalHalf("하"); // 시작·빈 끝 없이 확정만
    t.input.dispatchEvent(new CompositionEvent("compositionend", { data: "하" })); // 되풀이한 끝
    t.start();
    t.compose("하");
    t.emptyEnd();
    t.finalHalf("하"); // 같은 음절 다시
    await flush();
    expect(ops(fake)).toEqual(["newParagraph", "insertText:하", "insertText:하"]);
    expect(fake.paragraphs[1]).toBe("하하가나다");
    expect(editor.snapshot().composing).toBe(false);
    t.unmount();
  });

  it("빈 끝 뒤 문서를 바꾸면 최종 글자는 원래 문서의 원래 자리에 한 번 들어가고 새 문서는 그대로다", async () => {
    const a = await edited(["첫 문서"]);
    const b = await readyDocx(["둘째 문서"]);
    const context = new ImeContext();
    const ta = mount(a.editor, context);
    ta.start();
    ta.compose("하");
    ta.emptyEnd();
    ta.unmount(); // 표면이 사라짐(탭 전환)
    const tb = mount(b.editor, context);
    expect(b.editor.snapshot().composing).toBe(false); // 다른 문서의 명령은 막지 않는다
    expect(a.editor.snapshot().composing).toBe(true);
    tb.finalHalf("하"); // 입력기의 뒤 반쪽은 새 표면에 도착한다
    await flush();
    expect(a.fake.paragraphs).toEqual(["", "하첫 문서"]);
    expect(b.fake.paragraphs).toEqual(["둘째 문서"]);
    expect(ops(b.fake)).toEqual([]);
    expect(a.editor.snapshot().composing).toBe(false);
    tb.unmount();
  });

  it("빈 끝 뒤 페이지 클릭 → 다시 불러오기: 늦게 온 최종 글자는 기억한 자리라도 새 모델에 넣지 않는다", async () => {
    const { editor, fake } = await edited();
    const t = mount(editor, new ImeContext());
    t.start();
    t.compose("하");
    t.emptyEnd();
    t.ime.pointerDown();
    await flush();
    expect((await editor.load({ discard: true })).ok).toBe(true);
    await flush();
    t.finalHalf("하");
    await flush();
    expect(fake.paragraphs).toEqual(["가나다", "abc"]);
    expect(ops(fake)).toEqual(["newParagraph"]);
    expect(editor.snapshot().composing).toBe(false);
    t.unmount();
  });

  it("빈 끝 뒤 다시 불러오면 늦게 온 최종 글자는 새 모델에 들어가지 않는다", async () => {
    const { editor, fake } = await edited();
    const t = mount(editor, new ImeContext());
    t.start();
    t.compose("하");
    t.emptyEnd();
    expect((await editor.load({ discard: true })).ok).toBe(true);
    await flush();
    expect(editor.snapshot().composing).toBe(false);
    t.finalHalf("하");
    await flush();
    expect(fake.paragraphs).toEqual(["가나다", "abc"]);
    expect(fake.info.revision).toBe(1); // 다시 불러오기 전의 판(새 모델에서 편집 없음)
    expect(ops(fake)).toEqual(["newParagraph"]);
    t.unmount();
  });
});
