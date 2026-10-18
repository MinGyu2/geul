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
  return { ...t, view, input, native, type, paste, compose };
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

  it("data 없는 insertText·insertReplacementText도 새로 들어온 글자만", async () => {
    const t = await mounted();
    t.type("a");
    t.native("insertText", "ab", null);
    t.native("insertReplacementText", "abz", null);
    expect(t.editor.documentText()).toBe("abz가나다");
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
