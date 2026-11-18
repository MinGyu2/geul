// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../../language/LanguageContext";
import { objectEditMatches, objectEditRequest, objectKeyEdit, validObjectEdit, type ObjectSelection } from "../../commands/objectSelection";
import { ObjectSelectionFrame, resizeBox } from "./ObjectSelectionFrame";

const selection = (patch: Partial<ObjectSelection> = {}): ObjectSelection => ({
  kind: "picture", address: { engine: "wordcraft", position: "body:1:0" },
  frame: { page: 0, x: 100, y: 200, width: 80, height: 40 }, epoch: 7,
  sessionId: 1 as ObjectSelection["sessionId"], loadGeneration: 2, revision: 3, editable: true,
  operations: ["deselect", "move", "resize", "delete"], ...patch,
});

function frame(props: Partial<Parameters<typeof ObjectSelectionFrame>[0]> = {}) {
  const onEdit = vi.fn();
  const pageDown = vi.fn();
  render(<LanguageProvider language="en" onLanguageChange={() => {}}>
    <div onMouseDown={pageDown} onPointerDown={pageDown}>
      <ObjectSelectionFrame selection={selection()} scale={2} onEdit={onEdit} {...props} />
    </div>
  </LanguageProvider>);
  return { onEdit, pageDown };
}

const drag = (target: Element, from: [number, number], to: [number, number], options: { shiftKey?: boolean } = {}) => {
  fireEvent.pointerDown(target, { pointerId: 1, button: 0, clientX: from[0], clientY: from[1] });
  fireEvent.pointerMove(target, { pointerId: 1, clientX: to[0], clientY: to[1], ...options });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: to[0], clientY: to[1], ...options });
};

describe("resizeBox", () => {
  const start = { x: 10, y: 20, width: 100, height: 50 };
  it("keeps the opposite edge fixed and clamps to the object limits", () => {
    expect(resizeBox(start, "e", 30, 99, false)).toEqual({ x: 10, y: 20, width: 130, height: 50 });
    expect(resizeBox(start, "nw", 20, 10, false)).toEqual({ x: 30, y: 30, width: 80, height: 40 });
    expect(resizeBox(start, "w", 500, 0, false)).toEqual({ x: 108, y: 20, width: 2, height: 50 });
    expect(resizeBox(start, "s", 0, 1e6, false).height).toBe(4000);
  });
  it("preserves the aspect ratio from a corner when asked", () => {
    expect(resizeBox(start, "se", 100, 0, true)).toEqual({ x: 10, y: 20, width: 200, height: 100 });
    expect(resizeBox(start, "e", 100, 0, true)).toEqual({ x: 10, y: 20, width: 200, height: 50 });
  });
});

describe("object edit requests", () => {
  it("validates untrusted edits by shape and limits", () => {
    expect(validObjectEdit({ kind: "bounds", width: 10, height: 10 })).toBe(true);
    expect(validObjectEdit({ kind: "bounds", x: 1, y: 2 })).toBe(true);
    for (const bad of [null, [], { kind: "bounds" }, { kind: "bounds", x: 1 }, { kind: "bounds", width: 1 },
      { kind: "bounds", width: 4001 }, { kind: "bounds", width: Number.NaN }, { kind: "bounds", width: 10, extra: 1 },
      { kind: "nudge", dx: 0, dy: 0 }, { kind: "nudge", dx: 289, dy: 0 }, { kind: "delete", now: true }, { kind: "rotate" }]) {
      expect(validObjectEdit(bad)).toBe(false);
    }
  });
  it("binds a request to the selection identity and its allowed operations", () => {
    const selected = selection({ operations: ["deselect", "resize"] });
    const resize = objectEditRequest(selected, { kind: "bounds", width: 50, height: 25 });
    expect(objectEditMatches(resize, selected)).toBe(true);
    expect(objectEditMatches(objectEditRequest(selected, { kind: "delete" }), selected)).toBe(false);
    expect(objectEditMatches(objectEditRequest(selected, { kind: "bounds", x: 1, y: 1 }), selected)).toBe(false);
    for (const stale of [{ epoch: 8 }, { revision: 4 }, { loadGeneration: 3 }, { sessionId: 9 as ObjectSelection["sessionId"] }]) {
      expect(objectEditMatches(resize, { ...selected, ...stale })).toBe(false);
    }
  });
  it("maps keys to nudges and deletion only where the object allows them", () => {
    expect(objectKeyEdit("ArrowLeft", false, selection())).toEqual({ kind: "nudge", dx: -1, dy: 0 });
    expect(objectKeyEdit("ArrowDown", true, selection())).toEqual({ kind: "nudge", dx: 0, dy: 10 });
    expect(objectKeyEdit("Delete", false, selection())).toEqual({ kind: "delete" });
    expect(objectKeyEdit("ArrowLeft", false, selection({ operations: ["deselect", "resize"] }))).toBeNull();
    expect(objectKeyEdit("Backspace", false, selection({ operations: ["deselect"] }))).toBeNull();
    expect(objectKeyEdit("a", false, selection())).toBeNull();
    expect(objectKeyEdit("Delete", false, null)).toBeNull();
  });
});

describe("ObjectSelectionFrame", () => {
  it("shows labelled handles and commits one move per drag without reaching the page", () => {
    const { onEdit, pageDown } = frame();
    expect(screen.getAllByRole("button", { name: /Resize from/ })).toHaveLength(8);
    drag(screen.getByTestId("object-move"), [0, 0], [20, -10]);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith({ kind: "bounds", x: 110, y: 195 }, 7);
    expect(pageDown).not.toHaveBeenCalled();
  });

  it("resizes from a corner keeping the picture aspect ratio, Shift frees it", () => {
    const { onEdit } = frame();
    drag(screen.getByTestId("object-handle-se"), [0, 0], [80, 0]);
    expect(onEdit).toHaveBeenLastCalledWith({ kind: "bounds", width: 120, height: 60 }, 7);
    drag(screen.getByTestId("object-handle-se"), [0, 0], [80, 0], { shiftKey: true });
    expect(onEdit).toHaveBeenLastCalledWith({ kind: "bounds", width: 120, height: 40 }, 7);
    drag(screen.getByTestId("object-handle-nw"), [0, 0], [40, 20], { shiftKey: true });
    expect(onEdit).toHaveBeenLastCalledWith({ kind: "bounds", width: 60, height: 30, x: 120, y: 210 }, 7);
  });

  it("treats a click as no edit and abandons a drag on Escape or pointer cancel", () => {
    const { onEdit } = frame();
    const body = screen.getByTestId("object-move");
    drag(body, [0, 0], [1, 1]);
    fireEvent.pointerDown(body, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 30, clientY: 30 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(body, { pointerId: 1, clientX: 30, clientY: 30 });
    fireEvent.pointerDown(body, { pointerId: 2, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(body, { pointerId: 2, clientX: 30, clientY: 30 });
    fireEvent.pointerCancel(body, { pointerId: 2 });
    fireEvent.pointerUp(body, { pointerId: 2, clientX: 30, clientY: 30 });
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("offers no handles for read-only objects and only resize handles for inline-only objects", () => {
    frame({ selection: selection({ operations: ["deselect"], editable: false }) });
    expect(screen.queryByTestId("object-move")).toBeNull();
    expect(screen.queryByTestId("object-handle-se")).toBeNull();
  });

  it("does not move the corner of an object that cannot move", () => {
    const { onEdit } = frame({ selection: selection({ operations: ["deselect", "resize"] }) });
    expect(screen.queryByTestId("object-move")).toBeNull();
    drag(screen.getByTestId("object-handle-nw"), [0, 0], [40, 20], { shiftKey: true });
    expect(onEdit).toHaveBeenLastCalledWith({ kind: "bounds", width: 60, height: 30 }, 7);
  });
});
