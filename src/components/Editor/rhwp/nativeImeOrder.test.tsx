// 실제 WebKitGTK 2.54.1 + ibus-hangul 1.5.5(두벌식, preedit 사용)가 보낸 DOM 이벤트 순서를 그대로 재생한다(T007 IME 원인
// 규명). 순서는 tao/wry 없는 WebKitGTK 탐침과 실제 앱의 숨긴 textarea에서 xdotool 실제 키로 기록했다
// (editor-surface-decision.md "T007 IME 원인 규명"). 합성 이벤트이므로 앱 상태 기계의 검증일 뿐, native IME 통과 증거가 아니다.
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "../../../language/LanguageContext";
import { RhwpSurface } from "./RhwpSurface";
import { ImeContext } from "./imeInput";
import { flush, info, loaded, ok, readySession } from "./testing";

type Step =
  | ["key", boolean, string?] // keydown(isComposing, key) — 조합 키는 key "Unidentified", keyCode 229
  | ["start"]
  | ["update", string]
  | ["input", string, string, boolean] // textarea 값, inputType, isComposing
  | ["end", string];

async function mounted(text = ["가나다", "abc"], imeContext?: ImeContext) {
  const t = await readySession(text);
  const view = render(
    <LanguageProvider language="ko" onLanguageChange={() => {}}>
      <RhwpSurface session={t.editor} zoom={100} {...(imeContext ? { imeContext } : {})} />
    </LanguageProvider>,
  );
  const input = view.container.querySelector<HTMLTextAreaElement>(".rhwp-input")!;
  const fire = (event: Event) => act(() => void input.dispatchEvent(event));
  const play = (steps: Step[]) => {
    for (const step of steps) {
      switch (step[0]) {
        case "key": {
          const key = step[2] ?? "Unidentified";
          const keyCode = key === "Unidentified" ? 229 : key === " " ? 32 : 37;
          fire(new KeyboardEvent("keydown", { key, keyCode, isComposing: step[1], bubbles: true, cancelable: true }));
          break;
        }
        case "start": fire(new CompositionEvent("compositionstart", { data: "" })); break;
        case "update": fire(new CompositionEvent("compositionupdate", { data: step[1] })); break;
        case "input": {
          const [, value, inputType, isComposing] = step;
          // WebKit은 input 전에 textarea 값을 바꾼다. 조합 지우기(deleteCompositionText)는 조합 글자를 뺀 값이다.
          input.value = value;
          fire(new InputEvent("input", { data: inputType === "deleteCompositionText" ? null : value, inputType, isComposing }));
          break;
        }
        case "end": {
          input.value = step[1]; // compositionend 때 textarea에는 확정 글자(빈 끝이면 비어 있음)
          fire(new CompositionEvent("compositionend", { data: step[1] }));
          break;
        }
      }
    }
  };
  return { ...t, view, input, play };
}

/** 조합 중인 음절 하나를 입력기가 확정할 때(다음 음절의 첫 키·공백·방향키·클릭)의 실제 순서. */
const nativeCommit = (current: string): Step[] => [
  ["key", true],
  ["input", "", "deleteCompositionText", true],
  ["end", ""],
  ["key", false],
  ["input", current, "insertFromComposition", true],
  ["end", current],
];
const startWith = (jamo: string): Step[] => [["key", false], ["start"], ["update", jamo], ["input", jamo, "insertCompositionText", true]];
const update = (text: string): Step[] => [["key", true], ["update", text], ["input", text, "insertCompositionText", true]];

describe("실제 WebKitGTK + ibus-hangul 순서(preedit 사용)", () => {
  it("조합 중 글자가 문서에 보이고 커서가 그 뒤에 있으며, 조합 중 갱신은 revision을 늘리지 않는다", async () => {
    const t = await mounted();
    t.play(startWith("ㅎ"));
    expect(t.doc.paragraphs[0]).toBe("ㅎ가나다");
    t.play(update("하"));
    expect(t.doc.paragraphs[0]).toBe("하가나다");
    t.play(update("한"));
    expect(t.doc.paragraphs[0]).toBe("한가나다");
    expect(t.editor.composing).toBe(true);
    expect(t.editor.caret.offset).toBe(1);
    expect(t.editor.localRevision).toBe(0);
  });

  it("'한글 ': 음절 경계마다 확정 1개, 다음 음절 미리보기는 확정 뒤에 이어지고 공백도 1개", async () => {
    const t = await mounted();
    t.play([...startWith("ㅎ"), ...update("하"), ...update("한")]);
    t.play([...nativeCommit("한"), ...startWith("ㄱ")]);
    expect(t.doc.paragraphs[0]).toBe("한ㄱ가나다");
    expect(t.editor.localRevision).toBe(1);
    expect(t.editor.compositionAnchor?.offset).toBe(1);
    t.play([...update("그"), ...update("글")]);
    t.play([...nativeCommit("글"), ["key", false, " "], ["input", " ", "insertText", false]]);
    expect(t.doc.paragraphs[0]).toBe("한글 가나다");
    expect(t.editor.composing).toBe(false);
    expect(t.editor.caret.offset).toBe(3);
    expect(t.editor.localRevision).toBe(3);
  });

  it("'가가': 같은 음절의 연속 확정을 모두 남긴다", async () => {
    const t = await mounted();
    t.play([...startWith("ㄱ"), ...update("가"), ...update("각")]);
    // 입력기가 '각'을 '가' + 'ㄱ…'으로 나눈다: 확정 '가' 뒤 새 조합 '가'(첫 미리보기부터 '가').
    t.play([...nativeCommit("가"), ...startWith("가")]);
    t.play([...nativeCommit("가"), ["key", false, " "], ["input", " ", "insertText", false]]);
    expect(t.doc.paragraphs[0]).toBe("가가 가나다");
    expect(t.editor.localRevision).toBe(3);
  });

  it("조합 중 ←: 입력기가 확정한 뒤 오는 ArrowLeft로 확정 글자 앞으로 이동한다", async () => {
    const t = await mounted();
    t.play([...startWith("ㄱ"), ...update("가"), ...nativeCommit("가"), ["key", false, "ArrowLeft"]]);
    expect(t.doc.paragraphs[0]).toBe("가가나다");
    expect(t.editor.caret.offset).toBe(0);
    expect(t.editor.localRevision).toBe(1);
  });

  it("조합 중 클릭: 입력기가 mousedown 전에 확정한 음절은 원래 자리에 한 번, 커서는 클릭한 곳", async () => {
    const t = await mounted();
    t.play([...startWith("ㅎ"), ...update("하"), ...update("한")]);
    // 실측: ibus가 버튼 누름에서 조합을 확정하고, 그 이벤트가 페이지의 mousedown보다 먼저 온다.
    t.play(nativeCommit("한"));
    const page = t.view.container.querySelector<HTMLDivElement>(".rhwp-page")!;
    act(() => void page.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 20, clientY: 25 })));
    expect(t.doc.paragraphs).toEqual(["한가나다", "abc"]);
    expect(t.editor.caret).toMatchObject({ paragraph: 1, offset: 2 });
    expect(t.editor.composing).toBe(false);
    expect(t.editor.localRevision).toBe(1);
    // 클릭 뒤 새 조합은 클릭한 곳에서 시작한다.
    t.play([...startWith("ㄱ"), ...update("가"), ...nativeCommit("가")]);
    expect(t.doc.paragraphs).toEqual(["한가나다", "ab가c"]);
    expect(t.editor.localRevision).toBe(2);
  });

  const click = (t: Awaited<ReturnType<typeof mounted>>, clientX: number, clientY: number) => {
    const page = t.view.container.querySelector<HTMLDivElement>(".rhwp-page")!;
    act(() => void page.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX, clientY })));
  };

  it("조합 중 클릭(mousedown이 입력기 확정보다 먼저): 보이는 '하'를 원래 자리에 한 번, 뒤따른 꼬리는 클릭한 곳에 넣지 않는다", async () => {
    const t = await mounted();
    t.play([...startWith("ㅎ"), ...update("하")]);
    // 실측(probe5): 페이지의 mousedown 뒤에 입력기의 확정 꼬리가 온다. 앱은 textarea 값·초점을 건드리지 않는다.
    click(t, 20, 25);
    expect(document.activeElement).toBe(t.input);
    expect(t.input.value).toBe("하");
    t.play(nativeCommit("하"));
    expect(t.doc.paragraphs).toEqual(["하가나다", "abc"]);
    expect(t.editor.caret).toMatchObject({ paragraph: 1, offset: 2 });
    expect(t.editor.localRevision).toBe(1);
    // 꼬리가 끝난 뒤의 새 조합(같은 음절도)은 클릭한 곳에 들어간다.
    t.play([...startWith("ㅎ"), ...update("하"), ...nativeCommit("하")]);
    expect(t.doc.paragraphs).toEqual(["하가나다", "ab하c"]);
    expect(t.editor.localRevision).toBe(2);
  });

  it("조합 중 클릭(페이지가 입력을 따라가지 못함): 입력기의 최종 글자로 원래 자리를 고치고 클릭한 곳은 그대로", async () => {
    const t = await mounted();
    t.play(startWith("ㅎ")); // 페이지에는 'ㅎ'까지만 보였다
    click(t, 20, 25);
    expect(t.doc.paragraphs).toEqual(["ㅎ가나다", "abc"]);
    // 클릭 전에 눌렀지만 늦게 온 'ㅏ'와 입력기의 확정 꼬리
    t.play([...update("하"), ...nativeCommit("하")]);
    expect(t.doc.paragraphs).toEqual(["하가나다", "abc"]);
    expect(t.editor.caret).toMatchObject({ paragraph: 1, offset: 2 });
    expect(t.editor.composing).toBe(false);
    expect(t.editor.localRevision).toBe(1); // 7차: 앱이 먼저 끝낸 'ㅎ'와 입력기 최종 글자로 고침은 한 조합(변경 1개)
  });

  it("꼬리의 빈 끝 뒤에 확정 없이 새 조합이 시작되면(입력기 취소) 앱이 확정한 글자는 남고 새 조합은 클릭한 곳", async () => {
    const t = await mounted();
    t.play([...startWith("ㅎ"), ...update("하")]);
    click(t, 20, 25);
    t.play([["key", true], ["input", "", "deleteCompositionText", true], ["end", ""]]);
    t.play([...startWith("ㄱ"), ...update("가"), ...nativeCommit("가")]);
    expect(t.doc.paragraphs).toEqual(["하가나다", "ab가c"]);
    expect(t.editor.localRevision).toBe(2);
  });
});

describe("창 초점 잃음: WebView 확정 뒤 입력기의 두 번째 확정(실측 WebKitGTK 2.54 + ibus)", () => {
  /** 실측 순서: WebView가 조합을 확정(조합 지우기 → 확정 입력 → 끝)한 뒤 입력기가 같은 글자를 다시 확정하고 blur가 온다. */
  const focusOut = (text: string): Step[] => [
    ["input", "", "deleteCompositionText", true],
    ["input", text, "insertFromComposition", true],
    ["end", text],
    ["key", false],
    ["input", text, "insertFromComposition", true],
    ["end", text],
  ];

  it("조합 중 창 초점을 잃으면 '하'는 원래 자리에 한 번, revision 1", async () => {
    const t = await mounted();
    t.play([...startWith("ㅎ"), ...update("하"), ...focusOut("하")]);
    act(() => t.input.blur());
    expect(t.doc.paragraphs[0]).toBe("하가나다");
    expect(t.editor.localRevision).toBe(1);
    act(() => t.input.focus());
    t.play([["key", false, " "], ["input", " ", "insertText", false]]);
    expect(t.doc.paragraphs[0]).toBe("하 가나다");
    expect(t.editor.localRevision).toBe(2);
  });

  it("돌아와 같은 음절을 새로 조합하면(조합 시작과 함께) 남는다", async () => {
    const t = await mounted();
    t.play([...startWith("ㅎ"), ...update("하"), ...focusOut("하")]);
    t.play([...startWith("ㅎ"), ...update("하"), ...nativeCommit("하")]);
    expect(t.doc.paragraphs[0]).toBe("하하가나다");
    expect(t.editor.localRevision).toBe(2);
  });

  it("WebView 확정 뒤 입력기가 다른 글자를 확정하면 새 입력으로 넣는다(같은 글자만 소비)", async () => {
    const t = await mounted();
    t.play([...startWith("ㅎ"), ...update("하"), ["input", "", "deleteCompositionText", true],
      ["input", "하", "insertFromComposition", true], ["end", "하"], ["key", false],
      ["input", "가", "insertFromComposition", true], ["end", "가"]]);
    expect(t.doc.paragraphs[0]).toBe("하가가나다");
    expect(t.editor.localRevision).toBe(2);
  });
});

describe("클릭이 입력기 확정의 빈 끝과 확정 절반 사이에 옴(실측 게이트)", () => {
  it("확정 절반은 원래 자리에 한 번, 커서는 클릭한 곳", async () => {
    const t = await mounted();
    t.play([...startWith("ㅎ"), ...update("하")]);
    t.play([["key", true], ["input", "", "deleteCompositionText", true], ["end", ""]]);
    const page = t.view.container.querySelector<HTMLDivElement>(".rhwp-page")!;
    act(() => void page.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 20, clientY: 25 })));
    t.play([["key", false], ["input", "하", "insertFromComposition", true], ["end", "하"]]);
    expect(t.doc.paragraphs).toEqual(["하가나다", "abc"]);
    expect(t.editor.caret).toMatchObject({ paragraph: 1, offset: 2 });
    expect(t.editor.localRevision).toBe(1);
  });

  it("빈 끝이 실제 취소였으면(확정 절반 없이 새 조합) 아무것도 넣지 않고 새 조합은 클릭한 곳", async () => {
    const t = await mounted();
    t.play([...startWith("ㅎ"), ...update("하")]);
    t.play([["key", true], ["input", "", "deleteCompositionText", true], ["end", ""]]);
    const page = t.view.container.querySelector<HTMLDivElement>(".rhwp-page")!;
    act(() => void page.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 20, clientY: 25 })));
    t.play([...startWith("ㄱ"), ...update("가"), ...nativeCommit("가")]);
    expect(t.doc.paragraphs).toEqual(["가나다", "ab가c"]);
    expect(t.editor.localRevision).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 7차: 한 조합 = 한 변경(클릭으로 먼저 확정한 뒤 입력기 최종 글자로 고쳐도), isComposing=false 늦은 확정.
describe("조합 트랜잭션 하나는 변경 하나", () => {
  const commits = (t: Awaited<ReturnType<typeof mounted>>) => t.calls.filter((call) => call.method === "commit");
  const click = (t: Awaited<ReturnType<typeof mounted>>) => {
    const page = t.view.container.querySelector<HTMLDivElement>(".rhwp-page")!;
    act(() => void page.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 20, clientY: 25 })));
  };

  it("클릭 뒤 입력기가 다른 글자로 끝내도(ㅎ → 하) 변경 1개·확정 요청 1개(count 1)", async () => {
    const t = await mounted();
    t.play(startWith("ㅎ"));
    click(t);
    t.play([...update("하"), ...nativeCommit("하")]);
    await act(flush);
    expect(t.doc.paragraphs).toEqual(["하가나다", "abc"]);
    expect(t.editor.caret).toMatchObject({ paragraph: 1, offset: 2 });
    expect(t.editor.localRevision).toBe(1);
    expect(commits(t).map((call) => call.args[3])).toEqual([1]);
  });

  it("클릭 뒤 같은 글자로 끝나면 변경 1개, 확정은 입력기의 끝 뒤에 한 번", async () => {
    const t = await mounted();
    t.play([...startWith("ㅎ"), ...update("하")]);
    click(t);
    t.play(nativeCommit("하"));
    await act(flush);
    expect(t.doc.paragraphs).toEqual(["하가나다", "abc"]);
    expect(commits(t).map((call) => call.args[3])).toEqual([1]);
  });

  it("isComposing=false 늦은 확정(insertFromComposition → 끝): 원래 자리에 최종 글자 '하' 하나", async () => {
    const t = await mounted();
    t.play(startWith("ㅎ"));
    click(t);
    t.play([["input", "하", "insertFromComposition", false], ["end", "하"]]);
    await act(flush);
    expect(t.doc.paragraphs).toEqual(["하가나다", "abc"]);
    expect(t.editor.caret).toMatchObject({ paragraph: 1, offset: 2 });
    expect(t.editor.localRevision).toBe(1);
  });

  it("isComposing=false 늦은 확정의 Safari 순서(끝 → 같은 글자 input)도 원래 자리에 '하' 하나", async () => {
    const t = await mounted();
    t.play(startWith("ㅎ"));
    click(t);
    t.play([["end", "하"], ["input", "하", "insertFromComposition", false]]);
    await act(flush);
    expect(t.doc.paragraphs).toEqual(["하가나다", "abc"]);
    expect(t.editor.localRevision).toBe(1);
  });
});

describe("앱이 먼저 끝낸 조합(입력기의 끝을 기다림)의 경계", () => {
  type T = Awaited<ReturnType<typeof mounted>>;
  const commits = (t: T) => t.calls.filter((call) => call.method === "commit");
  const click = (t: T) => {
    const page = t.view.container.querySelector<HTMLDivElement>(".rhwp-page")!;
    act(() => void page.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 20, clientY: 25 })));
  };
  /** 첫 확정 요청에 답한다(백엔드 revision = base + count). */
  const answer = async (t: T) => {
    const call = t.take("commit");
    const revision = (call.args[2] as number) + (call.args[3] as number);
    call.reply(ok(info({ state: "ready", revision, dirty: true, sequence: 10 + revision })));
    await act(flush);
  };

  it("입력기의 끝이 오지 않으면: 기다리는 동안 확정하지 않고 미보존으로 보호, 다음 일반 키에서 모델 그대로 1개", async () => {
    const t = await mounted();
    t.play([...startWith("ㅎ"), ...update("하")]);
    click(t);
    await act(flush);
    expect(t.editor.awaitingCompositionEnd).toBe(true);
    expect(t.editor.hasUnpreservedChanges).toBe(true);
    expect(commits(t)).toEqual([]);
    t.play([["key", false, "ArrowLeft"]]);
    await act(flush);
    expect(t.editor.awaitingCompositionEnd).toBe(false);
    expect(t.doc.paragraphs).toEqual(["하가나다", "abc"]);
    expect(commits(t).map((call) => call.args[3])).toEqual([1]);
  });

  it("입력기의 끝보다 새 조합이 먼저 시작되면 앞 조합 1개 + 새 조합 1개", async () => {
    const t = await mounted();
    t.play([...startWith("ㅎ"), ...update("하")]);
    click(t);
    t.play([...startWith("ㄱ"), ...update("가"), ...nativeCommit("가")]);
    expect(t.doc.paragraphs).toEqual(["하가나다", "ab가c"]);
    expect(t.editor.localRevision).toBe(2);
  });

  it("앞 확정 요청이 아직 응답을 기다리는 동안 고쳐도 다음 확정에 한 번(count 1)", async () => {
    const t = await mounted();
    t.play([["key", false, " "], ["input", " ", "insertText", false]]); // 변경 1: 확정 요청을 보내고 응답 대기
    expect(commits(t).map((call) => call.args[3])).toEqual([1]);
    t.play(startWith("ㅎ"));
    click(t);
    t.play([...update("하"), ...nativeCommit("하")]); // 앞 요청이 진행 중: 고친 조합은 다음 확정에 묶임
    expect(t.editor.localRevision).toBe(2);
    await answer(t);
    expect(commits(t).map((call) => [call.args[2], call.args[3]])).toEqual([[1, 1]]);
    await answer(t);
    expect(t.editor.localRevision).toBe(2);
    expect(t.doc.paragraphs).toEqual([" 하가나다", "abc"]);
  });

  it("고치기의 엔진 호출이 예외면 세지 않고(확정 없음) uncertain으로 보호한다", async () => {
    const t = await mounted();
    t.play(startWith("ㅎ"));
    click(t);
    t.doc.failNext = true;
    t.play([...update("하"), ...nativeCommit("하")]);
    await act(flush);
    expect(t.editor.hasUncertainChanges).toBe(true);
    expect(t.editor.hasUnpreservedChanges).toBe(true);
    expect(t.editor.localRevision).toBe(0);
    expect(commits(t)).toEqual([]);
  });

  it("기다리는 동안 다시 불러오면(버리기) 늦게 온 끝은 새 모델에 아무것도 넣지 않는다", async () => {
    const t = await mounted();
    t.play([...startWith("ㅎ"), ...update("하")]);
    click(t);
    const reloading = t.editor.load({ discard: true });
    t.take("load").reply(loaded(undefined, 2));
    await act(flush);
    t.take("session").reply(ok(info({ state: "loading", sequence: 5, loadGeneration: 2 })));
    t.take("setState").reply(ok(info({ state: "ready", sequence: 6, loadGeneration: 2 })));
    await act(async () => { await reloading; });
    const fresh = t.editor.documentText();
    t.play(nativeCommit("하"));
    await act(flush);
    expect(t.editor.documentText()).toBe(fresh);
    expect(t.editor.awaitingCompositionEnd).toBe(false);
    expect(commits(t)).toEqual([]);
  });

  it("탭 전환: A에서 끝낸 조합의 꼬리가 B 표면에 오면 A만 고치고 A에 1개, B는 그대로", async () => {
    const context = new ImeContext();
    const a = await mounted(["가나다", "abc"], context);
    a.play(startWith("ㅎ"));
    a.view.unmount(); // 표면이 사라짐(detach): 보이던 'ㅎ'를 A에 남기고 끝을 기다림
    const b = await mounted(["xyz"], context);
    b.play([...update("하"), ...nativeCommit("하")]);
    expect(a.doc.paragraphs).toEqual(["하가나다", "abc"]);
    expect(a.editor.localRevision).toBe(1);
    expect(b.doc.paragraphs).toEqual(["xyz"]);
    expect(b.editor.localRevision).toBe(0);
    b.play([...startWith("ㄱ"), ...update("가"), ...nativeCommit("가")]); // B의 새 조합은 받는다
    expect(b.doc.paragraphs).toEqual(["가xyz"]);
  });

  it("초점 잃음(blur)으로 끝낸 조합의 꼬리: 원래 자리에 한 번, 변경 1개", async () => {
    const t = await mounted();
    t.play(startWith("ㅎ"));
    act(() => t.input.blur());
    t.play([...update("하"), ...nativeCommit("하")]);
    expect(t.doc.paragraphs).toEqual(["하가나다", "abc"]);
    expect(t.editor.localRevision).toBe(1);
  });

  it("isComposing=false 늦은 확정 뒤 같은 글자의 붙여넣기는 새 입력이고, 빈 끝·중복 끝은 아무것도 넣지 않는다", async () => {
    const t = await mounted();
    t.play(startWith("ㅎ"));
    click(t);
    t.play([["input", "하", "insertFromComposition", false], ["end", "하"], ["end", "하"], ["end", ""]]);
    t.play([["input", "하", "insertFromPaste", false]]);
    expect(t.doc.paragraphs).toEqual(["하가나다", "ab하c"]);
    expect(t.editor.localRevision).toBe(2);
  });

  it("isComposing=false 늦은 확정이 앱이 끝낸 글자와 같으면 고치지 않고 1개", async () => {
    const t = await mounted();
    t.play([...startWith("ㅎ"), ...update("하")]);
    click(t);
    t.play([["input", "하", "insertFromComposition", false], ["end", "하"]]);
    expect(t.doc.paragraphs).toEqual(["하가나다", "abc"]);
    expect(t.editor.localRevision).toBe(1);
  });
});
