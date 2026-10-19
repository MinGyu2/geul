// T008 안정화의 표면 경로: 숨긴 textarea 붙여넣기(beforeinput → input, data 없음) → ImeInput → 편집 세션 → 연산, 그림 실패
// 안내와 다시 그리기, 넣지 못한 입력 안내, 표면이 사라질 때 쪽 그림 놓기. 합성 DOM 이벤트이므로 실제 WebKitGTK 붙여넣기의
// 증거가 아니다(실제 앱: tests/integration/wordcraft/wordcraft_poc.py).
import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../../../language/LanguageContext";
import { MAX_RENDER_ATTEMPTS, RENDER_RETRY_MS } from "./DocxEditorSession";
import { DocxSurface } from "./DocxSurface";
import { flush, readyDocx, stubScreenContext } from "./testing";

async function mounted(text?: string[]) {
  stubScreenContext(); // jsdom canvas에는 2D 문맥이 없다
  const t = await readyDocx(text);
  const view = render(
    <LanguageProvider language="ko" onLanguageChange={() => {}}>
      <DocxSurface session={t.editor} zoom={100} />
    </LanguageProvider>,
  );
  await act(flush);
  const input = view.container.querySelector<HTMLTextAreaElement>(".rhwp-input")!;
  /** WebKitGTK textarea 붙여넣기: data 없는 insertFromPaste, 값은 textarea가 LF로 맞춘다. */
  const paste = async (text: string) => {
    act(() => {
      input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertFromPaste", bubbles: true, cancelable: true }));
      input.value = input.value.slice(0, input.selectionStart) + text + input.value.slice(input.selectionEnd);
      input.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", data: null, bubbles: true }));
    });
    await act(flush);
  };
  return { ...t, view, input, paste };
}

describe("T008 안정화 표면", () => {
  it("textarea에 여러 줄을 붙여넣으면 문단으로 들어가고 편집이 이어진다", async () => {
    const t = await mounted();
    await t.paste("첫째\n둘째\t탭\n");
    expect(t.fake.paragraphs).toEqual(["첫째", "둘째\t탭", "가나다", "abc"]);
    expect(t.editor.status.kind).toBe("ready");
    await t.paste("더");
    expect(t.fake.paragraphs[2]).toBe("더가나다");
  });

  it("실측 WebKitGTK 순서: 줄바꿈 글자 넣기가 beforeinput 하나 뒤 줄마다 insertText·insertParagraph로 와도 줄을 잃지 않는다", async () => {
    const t = await mounted();
    act(() => {
      t.input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "첫째\n둘째\n셋째", bubbles: true, cancelable: true }));
      for (const [inputType, data] of [["insertText", "첫째"], ["insertParagraph", null], ["insertText", "둘째"], ["insertParagraph", null], ["insertText", "셋째"]] as const) {
        t.input.dispatchEvent(new InputEvent("input", { inputType, data, bubbles: true }));
      }
    });
    await act(flush);
    expect(t.fake.paragraphs).toEqual(["첫째", "둘째", "셋째가나다", "abc"]);
  });

  it("넣을 수 없는 글자의 붙여넣기는 넣지 않고 안내한다", async () => {
    const t = await mounted();
    await t.paste("a\u0007b");
    const notice = t.view.getByTestId("docx-input-notice");
    expect(notice.dataset.notice).toBe("pasteUnsupported");
    expect(t.fake.paragraphs[0]).toBe("가나다");
    await t.paste("x");
    expect(t.view.queryByTestId("docx-input-notice")).toBeNull();
  });

  it("그리지 못한 쪽은 안내와 쪽 표시로 보이고, 다시 그리기로 이어 간다", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const t = await mounted();
    t.fake.renderError = { code: "InvalidRequest" };
    await act(async () => {
      t.editor.typeText("가");
      await flush();
    });
    for (let i = 0; i < MAX_RENDER_ATTEMPTS; i++) {
      now += RENDER_RETRY_MS * MAX_RENDER_ATTEMPTS;
      await act(async () => {
        t.editor.requestPages([0], (96 / 72) * (window.devicePixelRatio || 1));
        await flush();
      });
    }
    const alert = t.view.getByTestId("docx-render-failed");
    expect(alert.dataset.pages).toBe("0");
    expect(t.view.container.querySelector(".docx-page")!.getAttribute("data-render-failed")).toBe("true");
    expect(t.input.disabled).toBe(true);
    t.fake.renderError = null;
    await act(async () => {
      fireEvent.click(t.view.getByTestId("docx-render-retry"));
      await flush();
    });
    expect(t.view.queryByTestId("docx-render-failed")).toBeNull();
    expect(t.view.container.querySelector(".docx-page")!.getAttribute("data-current")).toBe("true");
    expect(t.input.disabled).toBe(false);
    vi.restoreAllMocks();
  });

  it("표면이 사라지면 화면 canvas와 화면 밖 래스터를 놓는다", async () => {
    const t = await mounted();
    const canvas = t.view.container.querySelector("canvas")!;
    expect(canvas.width).toBe(816);
    expect(t.editor.pageRevision(0)).toBe(0);
    t.view.unmount();
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
    expect(t.editor.pageRevision(0)).toBeNull();
  });
});
