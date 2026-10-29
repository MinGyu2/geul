import { act, fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { LanguageProvider } from "../../../language/LanguageContext";
import { RhwpSurface } from "./RhwpSurface";
import { readySession } from "./testing";

it("안 바뀐 쪽 Canvas를 보존하면서 배율·커서 쪽·포인터 좌표를 갱신한다", async () => {
  const { editor, doc } = await readySession();
  editor.pages = [{ width: 800, height: 1000 }, { width: 600, height: 900 }];
  doc.getCursorRect = (_section, paragraph, offset) => JSON.stringify({ pageIndex: paragraph, x: offset * 8, y: 20, height: 20 });
  const point = vi.spyOn(editor, "pointAt").mockReturnValue(true);
  const surface = (zoom: number) => <LanguageProvider language="ko" onLanguageChange={() => {}}><RhwpSurface session={editor} zoom={zoom} /></LanguageProvider>;
  const view = render(surface(50));
  try {
    const canvases = Array.from(view.container.querySelectorAll<HTMLCanvasElement>(".rhwp-page__canvas"));
    expect(canvases).toHaveLength(2);
    vi.spyOn(canvases[1]!, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20 } as DOMRect);
    const second = view.container.querySelector<HTMLDivElement>('[data-page="1"]')!;
    fireEvent.mouseDown(second, { button: 0, clientX: 30, clientY: 50 });
    expect(point).toHaveBeenLastCalledWith(1, 40, 60, false);fireEvent.mouseUp(window);
    act(() => { editor.caret = editor.anchor = { section: 0, paragraph: 1, offset: 1 };view.rerender(surface(100)); });
    expect(Array.from(view.container.querySelectorAll(".rhwp-page__canvas"))).toEqual(canvases);
    expect(second.style.width).toBe("600px");expect(second.style.height).toBe("900px");
    expect(view.container.querySelector(".rhwp-caret")?.closest(".rhwp-page")).toBe(second);
    fireEvent.mouseDown(second, { button: 0, clientX: 30, clientY: 50, shiftKey: true });
    expect(point).toHaveBeenLastCalledWith(1, 20, 30, true);fireEvent.mouseUp(window);
    act(() => { editor.caret = editor.anchor = { section: 0, paragraph: 0, offset: 0 };editor.pages = editor.pages.slice(0, 1);view.rerender(surface(100)); });
    expect(view.container.querySelectorAll(".rhwp-page__canvas")).toHaveLength(1);
    expect(canvases[1]!.isConnected).toBe(false);
    expect(view.container.querySelector(".rhwp-caret")?.closest(".rhwp-page")?.getAttribute("data-page")).toBe("0");
  } finally { view.unmount();editor.dispose(); }
});
