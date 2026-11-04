// 경계 C의 누름 규칙(editorFocus.ts) 단위 시험: 편집 입력에 초점이 있을 때만, 글자 입력 요소·스크롤바 누름은 빼고 mousedown 기본
// 동작(초점 이동)을 막는다. jsdom에는 배치가 없어 스크롤 크기·상자를 직접 준다.
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { keepEditorFocusOnPointerDown } from "./editorFocus";

function setup() {
  const view = render(
    <div>
      <textarea className="rhwp-input" aria-label="editor" />
      <input aria-label="path" />
      <div data-testid="surface" onMouseDown={keepEditorFocusOnPointerDown}>
        <div data-testid="empty">빈 곳</div>
        <button type="button">단추</button>
        <input aria-label="ribbon field" />
        <div data-testid="scroller">넘치는 줄</div>
      </div>
    </div>,
  );
  const get = (id: string) => view.getByTestId(id);
  return { view, get, editor: view.getByLabelText("editor"), path: view.getByLabelText("path") };
}

/** 가로로 넘치는(스크롤바 높이 10px) 120×40 상자. */
function makeScroller(element: HTMLElement) {
  Object.defineProperties(element, {
    scrollWidth: { configurable: true, value: 400 },
    clientWidth: { configurable: true, value: 120 },
    scrollHeight: { configurable: true, value: 30 },
    clientHeight: { configurable: true, value: 30 },
    clientLeft: { configurable: true, value: 0 },
    clientTop: { configurable: true, value: 0 },
  });
  element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 120, bottom: 40, width: 120, height: 40, x: 0, y: 0, toJSON: () => ({}) });
}

afterEach(() => (document.activeElement as HTMLElement | null)?.blur());

describe("keepEditorFocusOnPointerDown", () => {
  it("편집 입력에 초점이 있으면 빈 곳·단추 누름의 기본 동작을 막는다", () => {
    const { get, editor, view } = setup();
    editor.focus();
    expect(fireEvent.mouseDown(get("empty"))).toBe(false);
    expect(fireEvent.mouseDown(view.getByRole("button"))).toBe(false);
  });

  it("편집 입력에 초점이 없으면(다른 입력 칸·초점 없음) 막지 않는다", () => {
    const { get, path } = setup();
    expect(fireEvent.mouseDown(get("empty"))).toBe(true);
    path.focus();
    expect(fireEvent.mouseDown(get("empty"))).toBe(true);
  });

  it("누른 곳이 글자 입력 요소면 막지 않는다(그 요소가 초점을 받아야 함)", () => {
    const { editor, view } = setup();
    editor.focus();
    expect(fireEvent.mouseDown(view.getByLabelText("ribbon field"))).toBe(true);
  });

  it("스크롤되는 요소의 스크롤바 위 누름은 막지 않고 내용 위 누름은 막는다", () => {
    const { get, editor } = setup();
    const scroller = get("scroller");
    makeScroller(scroller);
    editor.focus();
    expect(fireEvent.mouseDown(scroller, { clientX: 60, clientY: 35 })).toBe(true); // 아래 10px = 가로 스크롤바
    expect(fireEvent.mouseDown(scroller, { clientX: 60, clientY: 15 })).toBe(false); // 내용
  });

  it("전파는 멈추지 않는다", () => {
    const { get, editor, view } = setup();
    editor.focus();
    let reached = false;
    view.container.addEventListener("mousedown", () => { reached = true; });
    fireEvent.mouseDown(get("empty"));
    expect(reached).toBe(true);
  });
});
