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
  it("preserves aspect ratio at min and max limits for wide and tall pictures across all corners", () => {
    // Prompt counterexample: tall 1:10 picture dragged to max width 4000 must clamp to 400x4000, not 4000x4000.
    const tall = { x: 50, y: 60, width: 100, height: 1000 };
    const tallMax = resizeBox(tall, "se", 3900, 0, true);
    expect(tallMax).toEqual({ x: 50, y: 60, width: 400, height: 4000 });
    expect(tallMax.width / tallMax.height).toBeCloseTo(tall.width / tall.height, 6);

    // Tall picture shrunk past min width (min=2): clamps to 2x20 keeping 1:10 ratio and fixed bottom-right corner.
    const tallMin = resizeBox(tall, "nw", 500, 0, true);
    expect(tallMin).toEqual({ x: 50 + 100 - 2, y: 60 + 1000 - 20, width: 2, height: 20 });
    expect(tallMin.x + tallMin.width).toBe(tall.x + tall.width);
    expect(tallMin.y + tallMin.height).toBe(tall.y + tall.height);

    // Wide 10:1 picture constrained by max width (4000x400) and min height (20x2).
    const wide = { x: 100, y: 200, width: 1000, height: 100 };
    const wideMax = resizeBox(wide, "ne", 0, -5000, true);
    expect(wideMax).toEqual({ x: 100, y: 200 + 100 - 400, width: 4000, height: 400 });
    expect(wideMax.width / wideMax.height).toBeCloseTo(wide.width / wide.height, 6);
    expect(wideMax.x).toBe(wide.x);
    expect(wideMax.y + wideMax.height).toBe(wide.y + wide.height);

    const wideMin = resizeBox(wide, "sw", 0, -500, true);
    expect(wideMin).toEqual({ x: 100 + 1000 - 20, y: 200, width: 20, height: 2 });
    expect(wideMin.x + wideMin.width).toBe(wide.x + wide.width);
    expect(wideMin.y).toBe(wide.y);
  });
  it("handles degenerate, unsatisfiable, and non-finite inputs safely without NaN or distortion", () => {
    const valid = { x: 10, y: 20, width: 100, height: 50 };
    expect(resizeBox(valid, "se", Number.NaN, 10, true)).toEqual(valid);
    expect(resizeBox(valid, "nw", 10, Number.POSITIVE_INFINITY, true)).toEqual(valid);
    expect(resizeBox({ x: 0, y: 0, width: 0, height: 50 }, "se", 10, 10, true)).toEqual({ x: 0, y: 0, width: 0, height: 50 });
    // Aspect ratio 1:3000 cannot fit both dimensions inside [2, 4000].
    const impossible = { x: 10, y: 20, width: 1, height: 3000 };
    expect(resizeBox(impossible, "se", 100, 100, true)).toEqual(impossible);
    // Out-of-bounds initial box whose aspect ratio IS satisfiable scales cleanly into [2, 4000].
    const tiny = { x: 10, y: 20, width: 1, height: 2 };
    expect(resizeBox(tiny, "se", 0, 0, true)).toEqual({ x: 10, y: 20, width: 2, height: 4 });
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
  it("validates polygon vertex positions and rejects mixed insertion and deletion fields", () => {
    expect(validObjectEdit({ kind: "pathVertex", action: "insert", index: 2, x: 20, y: 30 })).toBe(true);
    expect(validObjectEdit({ kind: "pathVertex", action: "remove", index: 2 })).toBe(true);
    for (const edit of [
      { kind: "pathVertex", action: "remove", index: 2, x: 20 },
      { kind: "pathVertex", action: "insert", index: 256, x: 20, y: 30 },
      { kind: "pathVertex", action: "insert", index: 2, x: 20.5, y: 30 },
    ]) expect(validObjectEdit(edit)).toBe(false);
  });
  it("validates DrawingML path control requests against the current selected geometry", () => {
    const selected = selection({
      kind: "shape",
      operations: ["deselect", "pathPoint"],
      drawingMlPaths: [{ viewportWidth: 1000, viewportHeight: 800, segments: [
        { command: "moveTo", points: [{ x: 0, y: 0, control: false }] },
        { command: "cubicBezTo", points: [
          { x: 200, y: 100, control: true },
          { x: 400, y: 300, control: true },
          { x: 800, y: 700, control: false },
        ] },
      ] }],
    });
    const request = objectEditRequest(selected, { kind: "docxPathPoint", path: 0, segment: 1, point: 0, x: 250, y: 150 });
    expect(validObjectEdit(request.edit)).toBe(true);
    expect(objectEditMatches(request, selected)).toBe(true);
    expect(objectEditMatches(objectEditRequest(selected, { kind: "docxPathPoint", path: 0, segment: 2, point: 0, x: 250, y: 150 }), selected)).toBe(false);
    const outside = objectEditRequest(selected, { kind: "docxPathPoint", path: 0, segment: 1, point: 0, x: -1, y: 150 });
    expect(validObjectEdit(outside.edit)).toBe(true);
    expect(objectEditMatches(outside, selected)).toBe(false);
    expect(validObjectEdit({ kind: "docxPathPoint", path: 0, segment: 1, point: 3, x: 250, y: 150 })).toBe(false);
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
  const rhwp = { engine: "rhwp", path: [0, 0, 2] } as const;

  it("edits a DOCX Bezier control point in its original viewport coordinates", () => {
    const selected = selection({
      kind: "shape",
      address: { engine: "wordcraft", position: "body:1:0" },
      operations: ["deselect", "pathPoint"],
      drawingMlPaths: [{ viewportWidth: 1000, viewportHeight: 800, segments: [
        { command: "moveTo", points: [{ x: 0, y: 0, control: false }] },
        { command: "cubicBezTo", points: [
          { x: 200, y: 100, control: true },
          { x: 400, y: 300, control: true },
          { x: 800, y: 700, control: false },
        ] },
      ] }],
    });
    const { onEdit, pageDown } = frame({ selection: selected });

    fireEvent.click(screen.getByRole("button", { name: "Edit points" }));
    drag(screen.getByTestId("docx-path-point-0-1-0"), [20, 10], [36, 26]);

    expect(onEdit).toHaveBeenCalledExactlyOnceWith({ kind: "docxPathPoint", path: 0, segment: 1, point: 0, x: 300, y: 260 }, 7);
    expect(pageDown).not.toHaveBeenCalled();
  });

  it.each(["picture", "shape", "group"] as const)("does not offer uncommittable leading-edge resizing for a movable RHWP %s", kind => {
    const selected = selection({ kind, address: rhwp });
    const mixed = objectEditRequest(selected, { kind: "bounds", x: 90, y: 195, width: 90, height: 45 });
    const { onEdit } = frame({ selection: selected });

    expect(screen.getAllByRole("button", { name: /Resize from/ }).map(handle => handle.dataset.handle))
      .toEqual(["e", "se", "s"]);
    expect(objectEditMatches(mixed, selected)).toBe(false);
    drag(screen.getByTestId("object-handle-e"), [0, 0], [20, 0]);
    drag(screen.getByTestId("object-handle-s"), [0, 0], [0, 20]);
    drag(screen.getByTestId("object-move"), [0, 0], [20, -10]);
    expect(onEdit.mock.calls).toEqual([
      [{ kind: "bounds", width: 90, height: 40 }, 7],
      [{ kind: "bounds", width: 80, height: 50 }, 7],
      [{ kind: "bounds", x: 110, y: 195 }, 7],
    ]);
  });

  it("keeps all eight handles for a resize-only RHWP inline picture", () => {
    const { onEdit } = frame({ selection: selection({ address: rhwp, operations: ["deselect", "resize"] }) });
    expect(screen.getAllByRole("button", { name: /Resize from/ })).toHaveLength(8);
    drag(screen.getByTestId("object-handle-nw"), [0, 0], [40, 20]);
    expect(onEdit).toHaveBeenCalledExactlyOnceWith({ kind: "bounds", width: 60, height: 30 }, 7);
  });

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

  it("commits one ratio-preserving edit per corner drag at limits and keeps the opposite corner fixed", () => {
    const tallSelection = selection({
      frame: { page: 0, x: 100, y: 200, width: 100, height: 1000 },
    });
    const { onEdit } = frame({ selection: tallSelection });
    // scale=2: clientX delta 8000 => dx = 4000 pt, hitting max height 4000 -> width 400, height 4000.
    drag(screen.getByTestId("object-handle-nw"), [0, 0], [-8000, 0]);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenLastCalledWith(
      { kind: "bounds", width: 400, height: 4000, x: -200, y: -2800 },
      7,
    );
  });
});

it("adds an exact interior point on the chosen closing edge and removes the selected vertex", () => {
  const vertices = [[10, 10], [31, 21], [26, 44], [10, 34], [10, 10]];
  const { onEdit } = frame({ selection: selection({
    kind: "shape", address: { engine: "rhwp", path: [0, 0, 2] }, operations: ["deselect", "pathPoint", "pathVertex"],
    shapePath: { kind: "polygon", closed: true, width: 60, height: 60,
      points: vertices.map(([x, y]) => ({ x: x!, y: y!, control: false })) },
  }) });
  fireEvent.click(screen.getByRole("button", { name: "Edit points" }));
  const add = screen.getByRole<HTMLButtonElement>("button", { name: "Add vertex on next edge" });
  expect(add.disabled).toBe(true); // The first edge has no interior lattice point.
  fireEvent.click(screen.getByRole("button", { name: "Vertex 4" }));
  fireEvent.click(add);
  expect(onEdit).toHaveBeenLastCalledWith({ kind: "pathVertex", action: "insert", index: 3, x: 10, y: 22 }, 7);
  fireEvent.click(screen.getByRole("button", { name: "Remove vertex" }));
  expect(onEdit).toHaveBeenLastCalledWith({ kind: "pathVertex", action: "remove", index: 3 }, 7);
});

it("only enables HWP5 vertex removal when joining collinear edges", () => {
  const vertices = [[10, 10], [30, 10], [50, 10], [20, 40], [10, 10]];
  const { onEdit } = frame({ selection: selection({
    kind: "shape", address: { engine: "rhwp", path: [0, 0, 2] }, operations: ["deselect", "pathPoint", "pathVertex"],
    collinearVertexRemoval: true,
    shapePath: { kind: "polygon", closed: true, width: 60, height: 60,
      points: vertices.map(([x, y]) => ({ x: x!, y: y!, control: false })) },
  }) });
  fireEvent.click(screen.getByRole("button", { name: "Edit points" }));
  const remove = screen.getByRole<HTMLButtonElement>("button", { name: "Remove vertex" });
  expect(remove.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Vertex 2" }));
  expect(remove.disabled).toBe(false);
  fireEvent.click(remove);
  expect(onEdit).toHaveBeenCalledExactlyOnceWith({ kind: "pathVertex", action: "remove", index: 1 }, 7);
});

it("offers terminal line edits only at the final HWP5 endpoint", () => {
  const { onEdit } = frame({ selection: selection({
    kind: "shape", address: { engine: "rhwp", path: [0, 0, 3] }, operations: ["deselect", "pathPoint", "pathSegment"],
    curveTerminalLine: { append: true, remove: true },
    shapePath: { kind: "curve", closed: false, width: 100, height: 100, points: [
      { x: 10, y: 10, control: false }, { x: 20, y: 20, control: true }, { x: 30, y: 25, control: true },
      { x: 50, y: 50, control: false }, { x: 70, y: 55, control: false },
    ] },
  }) });
  fireEvent.click(screen.getByRole("button", { name: "Edit points" }));
  expect(screen.queryByRole("button", { name: "Append line to coordinates" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Vertex 5" }));
  const append = screen.getByRole<HTMLButtonElement>("button", { name: "Append line to coordinates" });
  expect(append.disabled).toBe(true);
  fireEvent.change(screen.getByRole("spinbutton", { name: "X (HWPUNIT)" }), { target: { value: "85" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Y (HWPUNIT)" }), { target: { value: "60" } });
  expect(append.disabled).toBe(false);
  fireEvent.click(append);
  expect(onEdit).toHaveBeenLastCalledWith({ kind: "pathSegment", action: "append", x: 85, y: 60 }, 7);
  fireEvent.click(screen.getByRole("button", { name: "Remove final line" }));
  expect(onEdit).toHaveBeenLastCalledWith({ kind: "pathSegment", action: "remove" }, 7);
});

it("edits flat-group child positions and left/top-anchored sizes with ownership and protection checks", () => {
  const { onEdit } = frame({ selection: selection({
    kind: "group",
    address: { engine: "rhwp", path: [0, 0, 2] },
    frame: { page: 0, x: 5, y: 5, width: 117, height: 49 },
    operations: ["deselect", "move", "resize", "groupChildGeometry"],
    groupChildren: {
      parentId: 0,
      width: 11700,
      height: 4900,
      children: [
        {
          index: 0, kind: "rectangle", id: 2112144572, instId: 1038402749,
          x: 0, y: 0, width: 5200, height: 4100,
          sizeProtect: false, locked: false, canMove: true, canResize: true,
        },
        {
          index: 1, kind: "ellipse", id: 2112169928, instId: 1038428105,
          x: 6500, y: 800, width: 5200, height: 4100,
          sizeProtect: true, locked: false, canMove: true, canResize: false,
        },
      ],
    },
  }) });
  expect(validObjectEdit({ kind: "groupChildMove", index: 0, id: 2112144572, instId: 1038402749, x: 100, y: 200 })).toBe(true);
  expect(validObjectEdit({ kind: "groupChildResize", index: 0, id: 2112144572, instId: 1038402749, width: 0, height: 100 })).toBe(false);
  expect(validObjectEdit({ kind: "groupChildMove", index: 0, id: 2112144572, instId: 1038402749, x: -1, y: 0 })).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Edit group children" }));
  expect(screen.queryByTestId("object-handle-nw")).toBeNull();
  const childHandles = [...document.querySelectorAll(".object-group-child-handle")].map(e => (e as HTMLElement).dataset.handle);
  expect(childHandles).toEqual(["e", "se", "s"]);

  const moveBtn = screen.getByRole<HTMLButtonElement>("button", { name: "Move child" });
  const resizeBtn = screen.getByRole<HTMLButtonElement>("button", { name: "Resize child" });
  expect(moveBtn.disabled).toBe(true);
  expect(resizeBtn.disabled).toBe(true);

  fireEvent.change(screen.getByRole("spinbutton", { name: "X (HWPUNIT)" }), { target: { value: "500" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Y (HWPUNIT)" }), { target: { value: "300" } });
  expect(moveBtn.disabled).toBe(false);
  fireEvent.click(moveBtn);
  expect(onEdit).toHaveBeenLastCalledWith({
    kind: "groupChildMove", index: 0, id: 2112144572, instId: 1038402749, x: 500, y: 300,
  }, 7);

  fireEvent.change(screen.getByRole("spinbutton", { name: "Width (HWPUNIT)" }), { target: { value: "4800" } });
  fireEvent.click(resizeBtn);
  expect(onEdit).toHaveBeenLastCalledWith({
    kind: "groupChildResize", index: 0, id: 2112144572, instId: 1038402749, width: 4800, height: 4100,
  }, 7);

  // Switch to size-protected ellipse: resize handles disappear, move input stays enabled.
  fireEvent.click(screen.getByRole("button", { name: "Ellipse 2" }));
  expect(document.querySelectorAll(".object-group-child-handle")).toHaveLength(0);
  expect(screen.getByRole<HTMLInputElement>("spinbutton", { name: "Width (HWPUNIT)" }).disabled).toBe(true);
  expect(screen.getByRole<HTMLInputElement>("spinbutton", { name: "X (HWPUNIT)" }).disabled).toBe(false);

  // Escape exits group-child editing mode cleanly.
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("button", { name: "Finish child editing" })).toBeNull();
  expect(screen.getByRole("button", { name: "Edit group children" })).toBeTruthy();
});

it("manages group-child resize and move pointer capture, outside-handle drags, and safe cancellation (U1-U8)", () => {
  const { onEdit } = frame({ selection: selection({
    kind: "group",
    address: { engine: "rhwp", path: [0, 0, 2] },
    // scale=2 in frame(): rendered container size is 234 x 98 px -> 50 HWPUNIT / px
    frame: { page: 0, x: 5, y: 5, width: 117, height: 49 },
    operations: ["deselect", "move", "resize", "groupChildGeometry"],
    groupChildren: {
      parentId: 0,
      width: 11700,
      height: 4900,
      children: [
        {
          index: 0, kind: "rectangle", id: 2112144572, instId: 1038402749,
          x: 0, y: 0, width: 5200, height: 4100,
          sizeProtect: false, locked: false, canMove: true, canResize: true,
        },
        {
          index: 1, kind: "ellipse", id: 2112169928, instId: 1038428105,
          x: 6500, y: 800, width: 5200, height: 4100,
          sizeProtect: false, locked: false, canMove: true, canResize: true,
        },
      ],
    },
  }) });

  fireEvent.click(screen.getByRole("button", { name: "Edit group children" }));
  // U8: Unsupported north/west resize handles are never rendered.
  expect(["nw", "n", "ne", "sw", "w"].map(h => document.querySelector(`[data-handle="${h}"]`))).toEqual([null, null, null, null, null]);

  const seHandle = document.querySelector('.object-group-child-handle[data-handle="se"]') as HTMLButtonElement;
  const setCapture = vi.fn();
  const hasCapture = vi.fn(() => true);
  const releaseCapture = vi.fn();
  seHandle.setPointerCapture = setCapture;
  seHandle.hasPointerCapture = hasCapture;
  seHandle.releasePointerCapture = releaseCapture;

  // U1 & U2 & U3: Resize acquires capture, continues tracking far outside the handle, and commits once.
  fireEvent.pointerDown(seHandle, { pointerId: 42, button: 0, clientX: 100, clientY: 100 });
  expect(setCapture).toHaveBeenCalledWith(42);
  // Secondary pointer must not hijack active drag
  fireEvent.pointerDown(seHandle, { pointerId: 99, button: 0, clientX: 200, clientY: 200 });
  fireEvent.pointerMove(seHandle, { pointerId: 42, clientX: 110, clientY: 108 });
  const previewFrame = document.querySelector(".object-group-child-frame") as HTMLElement;
  expect(previewFrame.style.width).toBe(`${(5200 + 500) / 11700 * 100}%`);
  fireEvent.pointerUp(seHandle, { pointerId: 42, clientX: 110, clientY: 108 });
  // Follow-up lostPointerCapture after normal pointerUp must not duplicate or fail
  fireEvent.lostPointerCapture(seHandle, { pointerId: 42 });
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onEdit).toHaveBeenLastCalledWith({
    kind: "groupChildResize", index: 0, id: 2112144572, instId: 1038402749, width: 5700, height: 4500,
  }, 7);

  // U4: PointerCancel clears preview & drag without emitting a mutation.
  fireEvent.pointerDown(seHandle, { pointerId: 7, button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(seHandle, { pointerId: 7, clientX: 120, clientY: 112 });
  fireEvent.pointerCancel(seHandle, { pointerId: 7 });
  fireEvent.pointerUp(seHandle, { pointerId: 7, clientX: 120, clientY: 112 });
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect((document.querySelector(".object-group-child-frame") as HTMLElement).style.width).toBe(`${5200 / 11700 * 100}%`);

  // U5: LostPointerCapture mid-drag cancels cleanly without emitting a mutation.
  fireEvent.pointerDown(seHandle, { pointerId: 8, button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(seHandle, { pointerId: 8, clientX: 120, clientY: 112 });
  fireEvent.lostPointerCapture(seHandle, { pointerId: 8 });
  fireEvent.pointerUp(seHandle, { pointerId: 8, clientX: 120, clientY: 112 });
  expect(onEdit).toHaveBeenCalledTimes(1);

  // U6: Subsequent drag after cancellation works normally.
  fireEvent.pointerDown(seHandle, { pointerId: 9, button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(seHandle, { pointerId: 9, clientX: 90, clientY: 94 });
  fireEvent.pointerUp(seHandle, { pointerId: 9, clientX: 90, clientY: 94 });
  expect(onEdit).toHaveBeenCalledTimes(2);
  expect(onEdit).toHaveBeenLastCalledWith({
    kind: "groupChildResize", index: 0, id: 2112144572, instId: 1038402749, width: 4700, height: 3800,
  }, 7);

  // U7: Move dragging retains its existing pointer capture + commit behavior.
  const rectChild = document.querySelector('.object-group-child[data-index="0"]') as HTMLButtonElement;
  const moveCapture = vi.fn();
  rectChild.setPointerCapture = moveCapture;
  drag(rectChild, [10, 10], [18, 16]);
  expect(moveCapture).toHaveBeenCalledWith(1);
  expect(onEdit).toHaveBeenCalledTimes(3);
  expect(onEdit).toHaveBeenLastCalledWith({
    kind: "groupChildMove", index: 0, id: 2112144572, instId: 1038402749, x: 400, y: 300,
  }, 7);
});
