// 8차: 숨긴 textarea에 쌓인 값과 data 없는 input(붙여넣기·지우기·되돌리기)의 해석. 합성 이벤트·가짜 엔진의 상태 기계 검증이다
// (실제 WebKitGTK 붙여넣기는 rhwp_poc.py 등 실제 앱에서 따로 확인).
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "../../../language/LanguageContext";
import { RhwpSurface } from "./RhwpSurface";
import { readySession } from "./testing";

async function mounted(text = ["가나다"]) {
  const t = await readySession(text);
  const view = render(
    <LanguageProvider language="ko" onLanguageChange={() => {}}>
      <RhwpSurface session={t.editor} zoom={100} />
    </LanguageProvider>,
  );
  const input = view.container.querySelector<HTMLTextAreaElement>(".rhwp-input")!;
  const fire = (event: Event) => act(() => void input.dispatchEvent(event));
  /** WebKit 순서: beforeinput(바뀌기 전 값·선택) → 값이 바뀜 → input. */
  const native = (inputType: string, nextValue: string, data: string | null, isComposing = false) => {
    fire(new InputEvent("beforeinput", { inputType, data, isComposing, cancelable: true }));
    input.value = nextValue;
    input.setSelectionRange(nextValue.length, nextValue.length);
    fire(new InputEvent("input", { inputType, data, isComposing }));
  };
  const type = (text: string) => native("insertText", input.value + text, text);
  const paste = (text: string) => native("insertFromPaste", input.value + text, null);
  const compose = (syllable: string) => {
    const before = input.value;
    fire(new CompositionEvent("compositionstart", { data: "" }));
    native("insertCompositionText", before + syllable, syllable, true);
    native("deleteCompositionText", before, null, true);
    fire(new CompositionEvent("compositionend", { data: "" }));
    native("insertFromComposition", before + syllable, syllable, true);
    fire(new CompositionEvent("compositionend", { data: syllable }));
  };
  /** textarea 범위 바꾸기(예: 맞춤법 고치기). 바뀌기 전 beforeinput이 막혔는지 돌려준다(막혔으면 값도 그대로). */
  const replace = (nextValue: string, data: string | null, { inputType = "insertReplacementText", isComposing = false } = {}) => {
    const before = new InputEvent("beforeinput", { inputType, data, isComposing, cancelable: true });
    fire(before);
    if (!before.defaultPrevented) input.value = nextValue;
    fire(new InputEvent("input", { inputType, data, isComposing }));
    return before.defaultPrevented;
  };
  return { ...t, view, input, fire, native, type, paste, compose, replace };
}

describe("data 없는 input과 쌓인 textarea 값", () => {
  it("'a'를 친 뒤 'bc' 붙여넣기: 'abc' 한 번(앞서 넣은 'a'를 다시 넣지 않음)", async () => {
    const t = await mounted();
    t.type("a");
    expect(t.editor.documentText()).toBe("a가나다");
    t.paste("bc");
    expect(t.editor.documentText()).toBe("abc가나다");
    expect(t.editor.localRevision).toBe(2);
  });

  it("'abc'를 친 뒤 같은 'abc' 붙여넣기: 둘 다 남는다(같은 글자열을 버리지 않음)", async () => {
    const t = await mounted();
    t.type("a"); t.type("b"); t.type("c");
    t.paste("abc");
    expect(t.editor.documentText()).toBe("abcabc가나다");
  });

  it("한글 조합 뒤 붙여넣기, 연속 조합 뒤 붙여넣기", async () => {
    const t = await mounted();
    t.compose("한"); t.compose("글");
    t.paste("xy");
    t.compose("가");
    t.paste("가");
    expect(t.editor.documentText()).toBe("한글xy가가가나다");
    expect(t.editor.localRevision).toBe(5);
  });

  it("여러 줄·보조 평면 글자 붙여넣기는 그 글자만 한 번", async () => {
    const t = await mounted();
    t.type("a");
    t.paste("줄1\n줄2😀");
    expect(t.editor.documentText()).toBe("a줄1\n줄2😀가나다");
  });

  it("textarea 안에서 선택한 글자를 바꾸는 붙여넣기는 새 글자만 넣는다(textarea 값은 문서가 아님)", async () => {
    const t = await mounted();
    t.type("a"); t.type("b"); t.type("c");
    t.input.setSelectionRange(0, 3); // 예: Ctrl+A
    t.native("insertFromPaste", "XY", null);
    expect(t.editor.documentText()).toBe("abcXY가나다");
  });

  it("문서 선택이 있으면 붙여넣기가 그 선택을 바꾼다", async () => {
    const t = await mounted();
    t.type("a");
    t.editor.moveHorizontal(-1, true); // 'a' 선택
    t.paste("Q");
    expect(t.editor.documentText()).toBe("Q가나다");
  });

  it("data 없는 insertText도 새로 들어온 글자만", async () => {
    const t = await mounted();
    t.type("a");
    t.native("insertText", "ab", null);
    expect(t.editor.documentText()).toBe("ab가나다");
  });

  for (const inputType of ["deleteContentBackward", "deleteWordBackward", "deleteByCut", "historyUndo", "historyRedo"]) {
    it(`${inputType}(data 없음)은 문서에 글자를 넣지 않는다`, async () => {
      const t = await mounted();
      t.type("a"); t.type("b");
      const revision = t.editor.localRevision;
      t.native(inputType, inputType === "historyRedo" ? "abab" : "a", null);
      expect(t.editor.documentText()).toBe("ab가나다");
      expect(t.editor.localRevision).toBe(revision);
    });
  }

  it("지우기 뒤의 붙여넣기도 새 글자만(지워진 textarea 값과 어긋나도)", async () => {
    const t = await mounted();
    t.type("a"); t.type("b");
    t.native("deleteWordBackward", "", null);
    t.paste("zz");
    expect(t.editor.documentText()).toBe("abzz가나다");
  });
});

describe("붙여넣기와 다른 입력 경계", () => {
  it("blur·focus 뒤(값을 비운 뒤) 붙여넣기는 그 글자만", async () => {
    const t = await mounted();
    t.type("a");
    act(() => t.input.blur());
    act(() => t.input.focus());
    t.paste("bc");
    expect(t.editor.documentText()).toBe("abc가나다");
  });

  it("표면을 다시 만든 뒤(탭 전환·다시 불러오기와 같은 새 textarea) 붙여넣기는 그 글자만", async () => {
    const t = await mounted();
    t.type("a");
    t.view.unmount();
    const view = render(
      <LanguageProvider language="ko" onLanguageChange={() => {}}>
        <RhwpSurface session={t.editor} zoom={100} />
      </LanguageProvider>,
    );
    const input = view.container.querySelector<HTMLTextAreaElement>(".rhwp-input")!;
    act(() => void input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertFromPaste", cancelable: true })));
    input.value = "bc";
    act(() => void input.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste" })));
    expect(t.editor.documentText()).toBe("abc가나다");
  });

  it("앞 확정 요청이 응답을 기다리는 동안의 붙여넣기는 다음 확정에 묶인다(revision 회계 그대로)", async () => {
    const t = await mounted();
    t.type("a");
    t.paste("bc");
    t.paste("de");
    const commits = t.calls.filter((call) => call.method === "commit");
    expect(commits.map((call) => call.args[3])).toEqual([1]); // 첫 요청은 아직 응답 대기
    expect(t.editor.localRevision).toBe(3);
    expect(t.editor.documentText()).toBe("abcde가나다");
  });

  it("조합 중 클릭(입력기의 끝을 기다림) 바로 뒤 붙여넣기: 앞 조합 1개를 세고 붙여넣기는 클릭한 곳에 한 번", async () => {
    const t = await mounted(["가나다", "abc"]);
    t.input.value = "ㅎ";
    act(() => void t.input.dispatchEvent(new CompositionEvent("compositionstart", { data: "" })));
    act(() => void t.input.dispatchEvent(new InputEvent("input", { data: "ㅎ", inputType: "insertCompositionText", isComposing: true })));
    const page = t.view.container.querySelector<HTMLDivElement>(".rhwp-page")!;
    act(() => void page.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 20, clientY: 25 })));
    expect(t.editor.awaitingCompositionEnd).toBe(true);
    t.paste("XY");
    expect(t.editor.awaitingCompositionEnd).toBe(false);
    expect(t.doc.paragraphs).toEqual(["ㅎ가나다", "abXYc"]);
    expect(t.editor.localRevision).toBe(2);
  });
});

// 9차: textarea 범위를 바꾸는 input(insertReplacementText·insertTranspose)은 문서의 어느 범위인지 정할 수 없어 받지 않는다.
// 실제 WebKitGTK 2.54 + ibus-hangul에서는 이 이벤트가 나오지 않았다(한자 변환도 조합 이벤트로 옴, editor-surface-decision.md "T007 9차").
describe("textarea 범위 바꾸기", () => {
  it("쌓인 글자의 일부를 바꾸는 data 있는 바꾸기: 막고, 문서에 덧붙이지 않으며, 다음 입력은 그대로", async () => {
    const t = await mounted();
    t.type("t"); t.type("e"); t.type("h");
    const revision = t.editor.localRevision;
    expect(t.replace("the", "the")).toBe(true);
    expect(t.editor.documentText()).toBe("teh가나다");
    expect(t.editor.localRevision).toBe(revision);
    expect(t.input.value).toBe("teh");
    t.type("!");
    expect(t.editor.documentText()).toBe("teh!가나다");
    expect(t.editor.localRevision).toBe(revision + 1);
  });

  it("data 없는 바꾸기도(끝에 붙는 모양이어도) 넣지 않는다", async () => {
    const t = await mounted();
    t.type("a"); t.type("b");
    expect(t.replace("abz", null)).toBe(true);
    expect(t.replace("the", null)).toBe(true);
    expect(t.editor.documentText()).toBe("ab가나다");
    t.paste("cd");
    expect(t.editor.documentText()).toBe("abcd가나다");
  });

  it("insertTranspose(글자 바꿔 놓기)도 같다", async () => {
    const t = await mounted();
    t.type("a"); t.type("b");
    expect(t.replace("ba", null, { inputType: "insertTranspose" })).toBe(true);
    expect(t.editor.documentText()).toBe("ab가나다");
  });

  it("막히지 않고 값이 바뀌어도(취소 불가) 문서는 그대로이고, 다음 붙여넣기는 새 글자만", async () => {
    const t = await mounted();
    t.type("a");
    act(() => void t.input.dispatchEvent(new InputEvent("input", { inputType: "insertReplacementText", data: "A" })));
    t.input.value = "A";
    expect(t.editor.documentText()).toBe("a가나다");
    t.paste("bc");
    expect(t.editor.documentText()).toBe("abc가나다");
  });

  it("한글 조합으로 확정한 글자를 바꾸는 바꾸기: 한 조합은 변경 하나로 남고 글자는 그대로", async () => {
    const t = await mounted();
    t.compose("한");
    expect(t.editor.localRevision).toBe(1);
    expect(t.replace("韓", "韓")).toBe(true);
    expect(t.editor.documentText()).toBe("한가나다");
    expect(t.editor.localRevision).toBe(1);
    t.compose("글");
    expect(t.editor.documentText()).toBe("한글가나다");
    expect(t.editor.localRevision).toBe(2);
  });

  it("조합 중에 온 바꾸기는 조합을 바꾸지 않는다(조합은 끝까지 한 트랜잭션)", async () => {
    const t = await mounted();
    t.fire(new CompositionEvent("compositionstart", { data: "" }));
    t.native("insertCompositionText", "하", "하", true);
    expect(t.replace("x", "x", { isComposing: true })).toBe(false); // 조합 중에는 막지 않는다
    expect(t.editor.composing).toBe(true);
    expect(t.editor.documentText()).toBe("하가나다"); // 보이는 조합도 그대로
    t.native("insertCompositionText", "한", "한", true);
    t.native("deleteCompositionText", "", null, true);
    t.fire(new CompositionEvent("compositionend", { data: "" }));
    t.native("insertFromComposition", "한", "한", true);
    t.fire(new CompositionEvent("compositionend", { data: "한" }));
    expect(t.editor.documentText()).toBe("한가나다");
    expect(t.editor.localRevision).toBe(1);
  });

  it("조합 중 클릭(입력기의 끝을 기다림) 뒤의 바꾸기는 기다림을 끝내지 않고, 뒤의 붙여넣기가 앞 조합을 센다", async () => {
    const t = await mounted(["가나다", "abc"]);
    t.input.value = "ㅎ";
    t.fire(new CompositionEvent("compositionstart", { data: "" }));
    t.fire(new InputEvent("input", { data: "ㅎ", inputType: "insertCompositionText", isComposing: true }));
    const page = t.view.container.querySelector<HTMLDivElement>(".rhwp-page")!;
    act(() => void page.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 20, clientY: 25 })));
    expect(t.editor.awaitingCompositionEnd).toBe(true);
    t.replace("ㅎX", "X");
    expect(t.editor.awaitingCompositionEnd).toBe(true);
    expect(t.doc.paragraphs).toEqual(["ㅎ가나다", "abc"]);
    t.paste("XY");
    expect(t.doc.paragraphs).toEqual(["ㅎ가나다", "abXYc"]);
    expect(t.editor.localRevision).toBe(2);
  });

  it("문서 선택이 있어도 선택을 지우거나 바꾸지 않는다", async () => {
    const t = await mounted();
    t.type("a");
    t.editor.moveHorizontal(-1, true);
    expect(t.replace("Q", "Q")).toBe(true);
    expect(t.editor.documentText()).toBe("a가나다");
    expect(t.editor.hasSelection).toBe(true);
    t.paste("Q");
    expect(t.editor.documentText()).toBe("Q가나다");
  });

  it("앞 확정이 응답을 기다리는 동안의 바꾸기는 확정 회계를 바꾸지 않는다", async () => {
    const t = await mounted();
    t.type("a");
    t.replace("b", "b");
    t.type("c");
    expect(t.calls.filter((call) => call.method === "commit").map((call) => call.args[3])).toEqual([1]);
    expect(t.editor.localRevision).toBe(2);
    expect(t.editor.documentText()).toBe("ac가나다");
  });

  it("blur·focus 뒤와 표면을 다시 만든 뒤(탭 전환)의 바꾸기도 넣지 않는다", async () => {
    const t = await mounted();
    t.type("a");
    act(() => t.input.blur());
    act(() => t.input.focus());
    expect(t.replace("x", "x")).toBe(true);
    t.view.unmount();
    const view = render(
      <LanguageProvider language="ko" onLanguageChange={() => {}}>
        <RhwpSurface session={t.editor} zoom={100} />
      </LanguageProvider>,
    );
    const input = view.container.querySelector<HTMLTextAreaElement>(".rhwp-input")!;
    const before = new InputEvent("beforeinput", { inputType: "insertReplacementText", data: "y", cancelable: true });
    act(() => void input.dispatchEvent(before));
    act(() => void input.dispatchEvent(new InputEvent("input", { inputType: "insertReplacementText", data: "y" })));
    expect(before.defaultPrevented).toBe(true);
    expect(t.editor.documentText()).toBe("a가나다");
    act(() => void input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "z", cancelable: true })));
    input.value = "z";
    act(() => void input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "z" })));
    expect(t.editor.documentText()).toBe("az가나다");
  });
});
