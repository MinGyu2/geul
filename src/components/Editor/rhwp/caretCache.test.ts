import { describe, expect, it, vi } from "vitest";
import type { RhwpDocument } from "./rhwpModule";
import { readySession } from "./testing";

describe("동일 모델의 커서 기하 질의", () => {
  it("알림·화면 배율만 바뀌면 성공한 쪽 좌표를 재사용하고 반환 객체는 격리한다", async () => {
    const { editor, doc } = await readySession();
    const query = vi.spyOn(doc, "getCursorRect");
    const first = editor.caretRect()!;
    first.x = 999;
    editor.setAwaitingCommit(true);
    expect(editor.prepareRendering(1.5)).toBe(true);
    expect(editor.caretRect()).toEqual({ page: 0, x: 0, y: 0, height: 16 });
    expect(query).toHaveBeenCalledTimes(1);
    editor.dispose();
    expect(editor.caretRect()).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("이동·동일 위치의 새 모델·Undo/Redo·조합 교체 뒤에는 새 기하를 읽는다", async () => {
    const { editor, doc } = await readySession();
    const query = vi.spyOn(doc, "getCursorRect");
    editor.caretRect();
    editor.moveHorizontal(1, false);
    expect(editor.caretRect()?.x).toBe(10);
    expect(query).toHaveBeenCalledTimes(2);
    editor.typeText("x");
    editor.caret = editor.anchor = { section: 0, paragraph: 0, offset: 1 };
    editor.caretRect();
    expect(query).toHaveBeenCalledTimes(3);
    expect(editor.undo()).toBe(true);
    editor.caretRect();
    expect(query).toHaveBeenCalledTimes(4);
    expect(editor.redo()).toBe(true);
    editor.caretRect();
    expect(query).toHaveBeenCalledTimes(5);
    editor.beginComposition();
    editor.updateComposition("가");
    editor.caretRect();
    const afterFirst = query.mock.calls.length;
    editor.updateComposition("각"); // 같은 커서 오프셋이지만 다른 모델
    editor.caretRect();
    expect(query).toHaveBeenCalledTimes(afterFirst + 1);
    editor.endComposition("각");
    editor.dispose();
  });

  it("실패한 질의는 같은 판에서도 재시도하고, 셀의 전체 경로를 구별한다", async () => {
    const { editor, doc } = await readySession();
    const query = vi.spyOn(doc, "getCursorRect").mockImplementationOnce(() => { throw new Error("not ready"); });
    expect(editor.caretRect()).toBeNull();
    expect(editor.caretRect()?.x).toBe(0);
    expect(query).toHaveBeenCalledTimes(2);
    const cellQuery = vi.fn((_section: number, parent: number) => JSON.stringify({ pageIndex: parent, x: 1, y: 2, height: 16 }));
    Object.assign(doc as unknown as RhwpDocument, { getCursorRectInCell: cellQuery });
    editor.caret = { section: 0, paragraph: 0, offset: 0, cell: { parentParagraph: 1, control: 0, cell: 0, cellParagraph: 0 } };
    expect(editor.caretRect()?.page).toBe(1);
    editor.caret.cell!.parentParagraph = 2;
    expect(editor.caretRect()?.page).toBe(2);
    expect(cellQuery).toHaveBeenCalledTimes(2);
    editor.dispose();
  });
});
