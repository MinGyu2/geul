// T008 2차 안정화의 표면 경로: 화면 canvas 그리기 실패의 표시·회복(A), 그림 응답을 기다리는 동안 표면이 사라지고 다시 붙음(B),
// 줄마다 나뉜 글자 넣기의 CRLF(textInput.ts). 합성 DOM 이벤트·가짜 canvas이므로 실제 WebKitGTK canvas·입력의 증거가 아니다
// (실제 앱: tests/integration/wordcraft/wordcraft_poc.py).
import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Result } from "../../../adapters/contract";
import type { DocxRender } from "../../../adapters/docx";
import { LanguageProvider } from "../../../language/LanguageContext";
import { MAX_RENDER_ATTEMPTS, RENDER_RETRY_MS } from "./DocxEditorSession";
import { DocxSurface } from "./DocxSurface";
import { flush, readyDocx, stubScreenContext } from "./testing";

const surface = (session: Awaited<ReturnType<typeof readyDocx>>["editor"]) => (
  <LanguageProvider language="ko" onLanguageChange={() => {}}>
    <DocxSurface session={session} zoom={100} />
  </LanguageProvider>
);

async function mounted(options: { screen?: boolean } = {}) {
  const draws = options.screen === false ? null : stubScreenContext();
  const t = await readyDocx();
  const view = render(surface(t.editor));
  await act(flush);
  const input = () => view.container.querySelector<HTMLTextAreaElement>(".rhwp-input")!;
  const page = () => view.container.querySelector<HTMLDivElement>(".docx-page")!;
  return { ...t, view, input, page, draws };
}

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

describe("A 화면 canvas 그리기 실패(표면)", () => {
  it("문맥이 없으면 첫 그림 시간을 남기지 않고 지금 판으로 보이지 않으며, 몇 번 다시 그려 본 뒤 실패를 보이고, 다시 그리기로 PNG를 다시 받지 않고 그린다", async () => {
    const contexts = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const t = await mounted({ screen: false });
    expect(t.editor.isCurrent(0, (96 / 72) * (window.devicePixelRatio || 1))).toBe(true);
    expect(t.page().dataset.current).toBe("false");
    expect(t.editor.firstPaintMs).toBeNull();
    expect(t.input().disabled).toBe(false); // 한 번의 실패로는 멈추지 않음
    for (let i = 1; i < MAX_RENDER_ATTEMPTS; i++) await wait(RENDER_RETRY_MS * i + 30);
    await act(flush);
    const alert = t.view.getByTestId("docx-render-failed");
    expect(alert.dataset.pages).toBe("0");
    expect(t.page().dataset.renderFailed).toBe("true");
    expect(t.input().disabled).toBe(true);
    // 다시 그려 보기에 한도가 있다(끝없이 그리기·알리기를 되풀이하지 않음).
    const attempts = contexts.mock.calls.length;
    expect(attempts).toBe(MAX_RENDER_ATTEMPTS);
    await wait(RENDER_RETRY_MS * MAX_RENDER_ATTEMPTS);
    expect(contexts.mock.calls.length).toBe(attempts);
    contexts.mockRestore();
    const draws = stubScreenContext();
    await act(async () => {
      fireEvent.click(t.view.getByTestId("docx-render-retry"));
      await flush();
    });
    expect(draws).toHaveLength(1);
    expect(draws[0]!.canvas).toBe(t.page().querySelector("canvas"));
    expect(t.view.queryByTestId("docx-render-failed")).toBeNull();
    expect(t.page().dataset.current).toBe("true");
    expect(t.editor.firstPaintMs).not.toBeNull();
    expect(t.input().disabled).toBe(false);
    expect(t.fake.calls.filter((call) => call.method === "render")).toHaveLength(1);
  });

  it("문맥이 잠깐 없다가 돌아오면 사용자 조작 없이 다음 시도에서 그린다", async () => {
    const contexts = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValueOnce(null);
    contexts.mockImplementation(() => ({ drawImage: () => {} }) as unknown as CanvasRenderingContext2D);
    const t = await mounted({ screen: false });
    expect(t.page().dataset.current).toBe("false");
    await wait(RENDER_RETRY_MS + 30);
    await act(flush);
    expect(t.page().dataset.current).toBe("true");
    expect(t.editor.firstPaintMs).not.toBeNull();
    expect(t.view.queryByTestId("docx-render-failed")).toBeNull();
  });
});

describe("B 그림을 기다리는 동안 표면이 사라짐", () => {
  it("탭 전환으로 놓은 뒤 늦게 온 응답(쪽 전체·띠)은 래스터를 만들지 않고, 다시 붙은 표면은 지금 판을 그리며 편집한 내용과 입력이 이어진다", async () => {
    stubScreenContext();
    const t = await readyDocx();
    const original = t.fake.render.bind(t.fake);
    const held: (() => void)[] = [];
    vi.spyOn(t.fake, "render").mockImplementation((...args) => new Promise<Result<DocxRender>>((resolve) => held.push(() => resolve(original(...args)))));
    const tab = () => render(surface(t.editor));
    let view = tab();
    await act(flush);
    expect(held).toHaveLength(1); // 쪽 전체를 기다림
    view.unmount(); // 곧바로 다른 탭으로
    held.shift()!();
    await act(flush);
    expect(t.editor.pageRevision(0)).toBeNull(); // 놓은 표면의 늦은 쪽 전체가 래스터를 다시 만들지 않음
    view = tab(); // 같은 탭으로 돌아옴
    await act(flush);
    held.shift()!();
    await act(flush);
    await act(async () => {
      t.editor.typeText("가");
      await flush();
    });
    expect(held).toHaveLength(1); // 새 판의 띠를 기다림
    view.unmount();
    held.shift()!();
    await act(flush);
    expect(t.editor.pageRevision(0)).toBeNull();
    view = tab();
    await act(flush);
    expect(held).toHaveLength(1);
    held.shift()!();
    await act(flush);
    const page = view.container.querySelector<HTMLDivElement>(".docx-page")!;
    expect(page.dataset.current).toBe("true");
    expect(page.dataset.revision).toBe("1");
    expect(view.container.querySelector("canvas")!.width).toBe(816);
    expect(t.fake.paragraphs[0]).toBe("가가나다");
    await act(async () => {
      t.editor.typeText("나");
      await flush();
    });
    held.shift()?.();
    await act(flush);
    expect(t.fake.paragraphs[0]).toBe("가나가나다");
    expect(t.sessions.get(1)).toMatchObject({ revision: 2, dirty: true });
    expect(page.dataset.revision).toBe("2");
    expect(page.dataset.current).toBe("true");
  });
});

describe("줄마다 나뉜 글자 넣기의 줄바꿈", () => {
  type Event = [inputType: string, data: string | null];
  /** WebKitGTK execCommand('insertText') 실측 순서: beforeinput 뒤(첫 번은 전체 하나, 그 뒤는 조각마다) 조각마다 input. */
  /** interleaved: 실측처럼 input 사이에 microtask가 돈다(WebKit은 나눈 input을 따로 보낸다). */
  async function split(t: Awaited<ReturnType<typeof mounted>>, events: Event[], whole?: string, interleaved = false) {
    const target = t.input();
    act(() => {
      if (whole !== undefined) target.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: whole, bubbles: true, cancelable: true }));
      else for (const [inputType, data] of events) target.dispatchEvent(new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true }));
      if (!interleaved) for (const [inputType, data] of events) target.dispatchEvent(new InputEvent("input", { inputType, data, bubbles: true }));
    });
    if (interleaved) {
      for (const [inputType, data] of events) {
        await act(async () => {
          target.dispatchEvent(new InputEvent("input", { inputType, data, bubbles: true }));
          await Promise.resolve();
        });
      }
    }
    await act(flush);
  }

  it.each([
    ["CRLF", "가\r\n나", [["insertText", "가\r"], ["insertParagraph", null], ["insertText", "나"]], ["가", "나가나다", "abc"]],
    ["CRLF 빈 줄", "가\r\n\r\n나", [["insertText", "가\r"], ["insertParagraph", null], ["insertText", "\r"], ["insertParagraph", null], ["insertText", "나"]], ["가", "", "나가나다", "abc"]],
    ["끝의 CRLF", "가\r\n", [["insertText", "가\r"], ["insertParagraph", null]], ["가", "가나다", "abc"]],
    ["LF", "가\n나", [["insertText", "가"], ["insertParagraph", null], ["insertText", "나"]], ["가", "나가나다", "abc"]],
    ["LF 빈 줄 둘", "가\n\n\n나", [["insertText", "가"], ["insertParagraph", null], ["insertParagraph", null], ["insertParagraph", null], ["insertText", "나"]], ["가", "", "", "나가나다", "abc"]],
    ["CR만(나뉘지 않음)", "가\r나", [["insertText", "가\r나"]], ["가", "나가나다", "abc"]],
  ] as [string, string, Event[], string[]][])("%s: 문단 구조가 원래 글자와 같다(빈 줄은 그대로, CRLF는 하나)", async (_, text, events, paragraphs) => {
    for (const [whole, interleaved] of [[text, false], [undefined, false], [text, true]] as const) {
      const t = await mounted();
      await split(t, events, whole, interleaved);
      expect(t.fake.paragraphs).toEqual(paragraphs);
      expect(t.editor.status.kind).toBe("ready");
      expect(t.sessions.get(1)?.revision).toBe(events.filter(([type]) => type === "insertText" || type === "insertParagraph").length
        - events.filter(([type], index) => type === "insertParagraph" && events[index - 1]?.[1]?.endsWith("\r")).length);
      t.view.unmount();
    }
  });

  it("CRLF 한 번의 붙여넣기(insertFromPaste 하나, data 있음·없음)는 문단 하나로 나눈다", async () => {
    for (const data of ["가\r\n나", null]) {
      const t = await mounted();
      act(() => {
        const target = t.input();
        target.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertFromPaste", data, bubbles: true, cancelable: true }));
        target.value = "가\n나"; // textarea는 값을 LF로 맞춘다
        target.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", data, bubbles: true }));
      });
      await act(flush);
      expect(t.fake.paragraphs).toEqual(["가", "나가나다", "abc"]);
      expect(t.sessions.get(1)?.revision).toBe(1);
      t.view.unmount();
    }
  });

  it("\\r로 끝난 넣기 바로 다음 input이 아니면(다른 input·키·조합 시작·초점 잃음이 사이에 옴) 문단 나누기를 그대로 넣는다", async () => {
    const t = await mounted();
    const paragraph = () => act(() => void t.input().dispatchEvent(new InputEvent("input", { inputType: "insertParagraph", data: null, bubbles: true })));
    await split(t, [["insertText", "a\r"], ["insertText", "b"], ["insertParagraph", null]]);
    expect(t.fake.paragraphs).toEqual(["a", "b", "가나다", "abc"]);
    for (const between of [
      () => void t.input().dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true })),
      () => void t.input().dispatchEvent(new CompositionEvent("compositionstart", { data: "" })),
      () => void t.input().dispatchEvent(new FocusEvent("blur")),
    ]) {
      const before = [...t.fake.paragraphs];
      await split(t, [["insertText", "c\r"]]);
      act(between);
      if (t.editor.composing) act(() => void t.input().dispatchEvent(new CompositionEvent("compositionend", { data: "" })));
      paragraph();
      await act(flush);
      expect(t.fake.paragraphs.length).toBe(before.length + 2); // \r의 문단 하나 + 따로 온 문단 나누기 하나
    }
    // 앞 beforeinput 없이 온 data 없는 문단 나누기도 넣는다(1차 안정화 계약).
    const count = t.fake.paragraphs.length;
    paragraph();
    await act(flush);
    expect(t.fake.paragraphs.length).toBe(count + 1);
  });
});
