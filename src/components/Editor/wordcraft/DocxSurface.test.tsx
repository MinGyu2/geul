// DOCX 편집 표면(T008). 실제 WebKitGTK 2.54 + ibus-hangul 이벤트 순서(T007 nativeImeOrder.test.tsx와 같은 기록)를 재생한다.
// 합성 이벤트이므로 표면·상태 기계의 검증일 뿐 native IME 통과 증거가 아니다(실제 앱 시험: tests/integration/wordcraft/).
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "../../../language/LanguageContext";
import { DocxSurface } from "./DocxSurface";
import { CSS_PX_PER_PT } from "./DocxEditorSession";
import { CHAR, flush, LINE, MARGIN, readyDocx } from "./testing";

type Step = ["key", boolean, string?] | ["start"] | ["input", string, string, boolean] | ["end", string];

async function mounted(text?: string[]) {
  const t = await readyDocx(text);
  const view = render(
    <LanguageProvider language="ko" onLanguageChange={() => {}}>
      <DocxSurface session={t.editor} zoom={100} />
    </LanguageProvider>,
  );
  await act(flush);
  const input = view.container.querySelector<HTMLTextAreaElement>(".rhwp-input")!;
  const fire = (event: Event) => act(() => void input.dispatchEvent(event));
  const play = async (steps: Step[]) => {
    for (const step of steps) {
      switch (step[0]) {
        case "key": {
          const key = step[2] ?? "Unidentified";
          const keyCode = key === "Unidentified" ? 229 : 37;
          fire(new KeyboardEvent("keydown", { key, keyCode, isComposing: step[1], shiftKey: false, bubbles: true, cancelable: true }));
          break;
        }
        case "start": fire(new CompositionEvent("compositionstart", { data: "" })); break;
        case "input": {
          const [, value, inputType, isComposing] = step;
          input.value = value;
          fire(new InputEvent("input", { data: inputType === "deleteCompositionText" ? null : value, inputType, isComposing }));
          break;
        }
        case "end":
          input.value = step[1];
          fire(new CompositionEvent("compositionend", { data: step[1] }));
          break;
      }
    }
    await act(flush);
  };
  /** 쪽 좌표(pt)를 누른다(jsdom 쪽 상자 사각형은 0,0). */
  const click = async (x: number, y: number) => {
    const page = view.container.querySelector<HTMLDivElement>(".docx-page")!;
    act(() => void page.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: x * CSS_PX_PER_PT, clientY: y * CSS_PX_PER_PT })));
    await act(flush);
  };
  const key = async (key: string, shiftKey = false) => {
    fire(new KeyboardEvent("keydown", { key, keyCode: 0, shiftKey, bubbles: true, cancelable: true }));
    await act(flush);
  };
  return { ...t, view, input, play, click, key };
}

const nativeCommit = (current: string): Step[] => [
  ["key", true], ["input", "", "deleteCompositionText", true], ["end", ""],
  ["key", false], ["input", current, "insertFromComposition", true], ["end", current],
];
const startWith = (jamo: string): Step[] => [["key", false], ["start"], ["input", jamo, "insertCompositionText", true]];
const update = (text: string): Step[] => [["key", true], ["input", text, "insertCompositionText", true]];

describe("DocxSurface", () => {
  it("쪽 상자는 pt × 배율, 그림을 받아 canvas에 옮기고 커서를 그린다", async () => {
    const t = await mounted();
    const page = t.view.container.querySelector<HTMLDivElement>(".docx-page")!;
    expect(page.style.width).toBe(`${612 * CSS_PX_PER_PT}px`);
    expect(page.dataset.current).toBe("true");
    const canvas = page.querySelector("canvas")!;
    expect([canvas.width, canvas.height]).toEqual([816, 1056]);
    const caret = t.view.getByTestId("docx-caret");
    expect(caret.style.left).toBe(`${MARGIN * CSS_PX_PER_PT}px`);
    expect(t.editor.firstPaintMs).not.toBeNull();
  });

  it("'한글 ': 조합 중 글자는 겹침으로 보이고 모델은 그대로, 음절·공백마다 연산·revision 하나", async () => {
    const t = await mounted();
    await t.play([...startWith("ㅎ"), ...update("하"), ...update("한")]);
    const overlay = t.view.getByTestId("docx-composition");
    expect(overlay.textContent).toBe("한");
    expect(overlay.style.visibility).toBe("visible");
    expect(t.fake.paragraphs[0]).toBe("가나다");
    expect(t.sessions.get(1)?.revision).toBe(0);
    await t.play([...nativeCommit("한"), ...startWith("ㄱ"), ...update("그"), ...update("글")]);
    expect(t.fake.paragraphs[0]).toBe("한가나다");
    expect(overlay.textContent).toBe("글");
    await t.play([...nativeCommit("글"), ["key", false, " "], ["input", " ", "insertText", false]]);
    expect(t.fake.paragraphs[0]).toBe("한글 가나다");
    expect(t.sessions.get(1)?.revision).toBe(3);
    expect(overlay.style.visibility).toBe("hidden");
    expect(t.fake.caret).toEqual({ p: 0, o: 3 });
  });

  it("'가가': 같은 음절의 연속 확정을 모두 남긴다", async () => {
    const t = await mounted();
    await t.play([...startWith("ㄱ"), ...update("가"), ...update("각"), ...nativeCommit("가"), ...startWith("가"), ...nativeCommit("가")]);
    expect(t.fake.paragraphs[0]).toBe("가가가나다");
    expect(t.sessions.get(1)?.revision).toBe(2);
  });

  it("조합 중 ←: 입력기가 확정한 뒤 오는 ArrowLeft로 확정 글자 앞으로 이동한다", async () => {
    const t = await mounted();
    await t.play([...startWith("ㄱ"), ...update("가"), ...nativeCommit("가"), ["key", false, "ArrowLeft"]]);
    expect(t.fake.paragraphs[0]).toBe("가가나다");
    expect(t.fake.caret).toEqual({ p: 0, o: 0 });
  });

  it("조합 중 클릭(mousedown이 입력기 확정보다 먼저): 원래 자리에 한 번, 커서는 클릭한 곳, 꼬리는 넣지 않는다", async () => {
    const t = await mounted();
    await t.play([...startWith("ㅎ"), ...update("하")]);
    // 둘째 문단 'abc'의 b 뒤를 누른다.
    await t.click(MARGIN + 2 * CHAR, MARGIN + LINE + 8);
    await t.play([["key", true], ["input", "", "deleteCompositionText", true], ["end", ""], ["key", true], ["input", "하", "insertFromComposition", true], ["end", "하"]]);
    expect(t.fake.paragraphs).toEqual(["하가나다", "abc"]);
    expect(t.fake.caret).toEqual({ p: 1, o: 2 });
    expect(t.sessions.get(1)?.revision).toBe(1);
    // 클릭 뒤 새 조합은 클릭한 곳에서 시작한다.
    await t.play([...startWith("ㄱ"), ...update("가"), ...nativeCommit("가")]);
    expect(t.fake.paragraphs).toEqual(["하가나다", "ab가c"]);
  });

  it("같은 줄 조합 중 클릭: 넣기 전 화면에서 누른 글자 경계에 커서", async () => {
    const t = await mounted();
    await t.play([...startWith("ㅎ"), ...update("한")]);
    // 화면에는 '가나다'(조합 '한'은 겹침)였고, '나' 뒤(오프셋 2)를 눌렀다.
    await t.click(MARGIN + 2 * CHAR, MARGIN + 8);
    await t.play([["key", true], ["input", "", "deleteCompositionText", true], ["end", ""], ["key", true], ["input", "한", "insertFromComposition", true], ["end", "한"]]);
    expect(t.fake.paragraphs[0]).toBe("한가나다");
    expect(t.fake.caret).toEqual({ p: 0, o: 3 });
  });

  it("키: 화살표·Shift 선택·Home/End·Backspace/Delete·Enter, 표 밖 Tab은 초점 이동에 맡긴다", async () => {
    const t = await mounted();
    await t.key("End");
    expect(t.fake.caret).toEqual({ p: 0, o: 3 });
    await t.key("ArrowLeft", true);
    expect(t.view.container.querySelectorAll(".rhwp-selection")).toHaveLength(1);
    await t.key("Backspace");
    expect(t.fake.paragraphs[0]).toBe("가나");
    await t.key("Home");
    await t.key("Delete");
    await t.key("Enter");
    expect(t.fake.paragraphs).toEqual(["", "나", "abc"]);
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => void t.input.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(false);
  });

  it("bitmap 예산을 넘는 배율은 그리지 않고 안내한다", async () => {
    const t = await readyDocx();
    const view = render(
      <LanguageProvider language="ko" onLanguageChange={() => {}}>
        <DocxSurface session={t.editor} zoom={2000} />
      </LanguageProvider>,
    );
    await act(flush);
    expect(view.getByTestId("docx-render-limit")).toBeTruthy();
    expect(view.container.querySelector(".docx-page")).toBeNull();
    expect(t.editor.editable).toBe(false);
  });
});
