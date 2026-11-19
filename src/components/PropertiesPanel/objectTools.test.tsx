import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../../adapters/contract";
import { executeCommand } from "../../commands/commands";
import type { ObjectSelection } from "../../commands/objectSelection";
import { initialLayout } from "../../hooks/layoutState";
import { LanguageProvider } from "../../language/LanguageContext";
import { documentPanelState, type DocumentPanelState } from "../Editor/documentPanels";
import { flush, readyDocx } from "../Editor/wordcraft/testing";
import { PropertiesPanel } from "./PropertiesPanel";

const info: SessionInfo = { sessionId: 1, format: "docx", engine: "wordcraft", revision: 3, state: "ready",
  displayName: "a.docx", dirty: false, sequence: 1, loadGeneration: 2 } as SessionInfo;
const selection = (patch: Partial<ObjectSelection> = {}): ObjectSelection => ({
  kind: "picture", address: { engine: "wordcraft", position: "body:1:0" },
  frame: { page: 0, x: 10, y: 10, width: 120, height: 60 }, epoch: 4,
  sessionId: 1 as ObjectSelection["sessionId"], loadGeneration: 2, revision: 3, editable: true,
  operations: ["deselect", "move", "resize", "delete", "crop", "wrap", "altText"],
  picture: { widthPt: 120, heightPt: 60, wrap: "inline", crop: [0.1, 0, 0, 0], description: "old" }, ...patch,
});
const shapeSelection = (patch: Partial<ObjectSelection>): ObjectSelection => {
  const { picture: _picture, ...rest } = selection(patch);
  void _picture;
  return { ...rest, kind: "shape" };
};
const panel = (object: ObjectSelection, extra: Partial<DocumentPanelState> = {}) => {
  const onObjectEdit = vi.fn();
  const state: DocumentPanelState = { info, status: "ready", pageCount: 1, page: 0, caret: null, objectSelection: object,
    selection: "none", selectedText: null, paragraphStyle: null, format: null, canNavigate: true,
    pending: false, composing: false, unpreserved: false, ...extra };
  render(<LanguageProvider language="en" onLanguageChange={vi.fn()}>
    <PropertiesPanel state={state} onClose={vi.fn()} onObjectEdit={onObjectEdit} />
  </LanguageProvider>);
  return onObjectEdit;
};
const request = (edit: unknown) => ({ command: "object.edit", selectionEpoch: 4, sessionId: 1, loadGeneration: 2, revision: 3, edit });

describe("object tools in the properties panel", () => {
  it("sends crop, crop reset, wrap, description, position, size and delete as identity-bound object edits", () => {
    const onEdit = panel(selection());
    fireEvent.change(screen.getByLabelText("Right"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply crop" }));
    expect(onEdit).toHaveBeenLastCalledWith(request({ kind: "crop", left: 0.1, top: 0, right: 0.2, bottom: 0 }));
    fireEvent.click(screen.getByRole("button", { name: "Reset crop" }));
    expect(onEdit).toHaveBeenLastCalledWith(request({ kind: "crop", left: 0, top: 0, right: 0, bottom: 0 }));
    fireEvent.change(screen.getByLabelText("Text wrapping"), { target: { value: "square" } });
    expect(onEdit).toHaveBeenLastCalledWith(request({ kind: "wrap", wrap: "square" }));
    fireEvent.change(screen.getByLabelText("Alternative text (description)"), { target: { value: "새 설명" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply description" }));
    expect(onEdit).toHaveBeenLastCalledWith(request({ kind: "altText", text: "새 설명" }));
    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "topRight" } });
    expect(onEdit).toHaveBeenLastCalledWith(request({ kind: "position", preset: "topRight" }));
    fireEvent.change(screen.getByLabelText("Width (pt)"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Resize picture" }));
    expect(onEdit).toHaveBeenLastCalledWith(request({ kind: "bounds", width: 60, height: 30 }));
    fireEvent.click(screen.getByRole("button", { name: "Delete object" }));
    expect(onEdit).toHaveBeenLastCalledWith(request({ kind: "delete" }));
  });

  it("refuses an out-of-range crop and hides controls the object does not admit", () => {
    const onEdit = panel(selection({ operations: ["deselect", "crop"], address: { engine: "rhwp", path: [0, 0, 2] } }));
    fireEvent.change(screen.getByLabelText("Left"), { target: { value: "46" } });
    expect(screen.getByRole("button", { name: "Apply crop" })).toBeDisabled();
    expect(screen.queryByLabelText("Text wrapping")).toBeNull();
    expect(screen.queryByLabelText("Position")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete object" })).toBeNull();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("disables every tool while edits are pending or composing", () => {
    panel(selection(), { pending: true });
    expect(screen.getByRole("button", { name: "Delete object" })).toBeDisabled();
    expect(screen.getByLabelText("Text wrapping")).toBeDisabled();
  });

  it("sends shape fill, line, rotation and layer edits; RHWP lines carry the color only", () => {
    const shape = { fill: "156082", outline: "0E405A", outlineWidth: 1, rotation: 0, flipH: false, flipV: false, widthPt: 108, heightPt: 72 };
    const onEdit = panel(shapeSelection({ shape,
      operations: ["deselect", "fill", "outline", "rotate", "zOrder"] }));
    fireEvent.click(screen.getByRole("button", { name: "No fill" }));
    expect(onEdit).toHaveBeenLastCalledWith(request({ kind: "fill", color: null }));
    fireEvent.change(screen.getByLabelText("Line width (pt)"), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply line" }));
    expect(onEdit).toHaveBeenLastCalledWith(request({ kind: "outline", color: "0E405A", width: 2.5 }));
    fireEvent.change(screen.getByLabelText("Rotation (degrees)"), { target: { value: "45" } });
    fireEvent.click(screen.getByLabelText("Flip vertical"));
    fireEvent.click(screen.getByRole("button", { name: "Apply rotation" }));
    expect(onEdit).toHaveBeenLastCalledWith(request({ kind: "rotate", degrees: 45, flipH: false, flipV: true }));
    fireEvent.click(screen.getByRole("button", { name: "Send to back" }));
    expect(onEdit).toHaveBeenLastCalledWith(request({ kind: "layer", front: false }));
  });

  it("omits the line width for RHWP shapes", () => {
    const shape = { fill: null, outline: "000000", outlineWidth: 0.12, rotation: 0, flipH: false, flipV: false, widthPt: 108, heightPt: 72 };
    const onEdit = panel(shapeSelection({ shape, address: { engine: "rhwp", path: [0, 0, 1] },
      operations: ["deselect", "outline"] }));
    expect(screen.queryByLabelText("Line width (pt)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply line" }));
    expect(onEdit).toHaveBeenLastCalledWith(request({ kind: "outline", color: "000000" }));
  });

  it("edits chart title, type and data and SmartArt items and layout as model edits", () => {
    const { picture: _p, ...base } = selection();
    void _p;
    const chart: ObjectSelection = { ...base, kind: "chart", operations: ["deselect", "chart"],
      graphic: { kind: "chart", plot: "line", title: "Revenue", labels: ["Q1", "Q2"], series: [{ name: "S", values: ["1", "2"] }] } };
    const onEdit = panel(chart);
    fireEvent.change(screen.getByLabelText("Chart title"), { target: { value: "매출" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply title" }));
    expect(onEdit).toHaveBeenLastCalledWith(request({ kind: "chartTitle", text: "매출" }));
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "bar" } });
    expect(onEdit).toHaveBeenLastCalledWith(request({ kind: "chartType", plot: "bar" }));
    fireEvent.change(screen.getByLabelText("Category 2"), { target: { value: "2분기" } });
    fireEvent.change(screen.getByLabelText("Series 1 · category 1 value"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Series 1 · category 2 value"), { target: { value: "7.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply data" }));
    expect(onEdit).toHaveBeenLastCalledWith(request({ kind: "chartData", categories: ["Q1", "2분기"], series: [{ name: "S", values: [null, 7.5] }] }));
    fireEvent.change(screen.getByLabelText("Series 1 · category 2 value"), { target: { value: "abc" } });
    expect(screen.getByRole("button", { name: "Apply data" })).toBeDisabled();
  });

  it("parses SmartArt outline indentation and refuses a skipped level", () => {
    const { picture: _p, ...base } = selection();
    void _p;
    const art: ObjectSelection = { ...base, kind: "smartArt", operations: ["deselect", "smartArt"],
      graphic: { kind: "smartArt", layout: "process", items: [{ text: "Plan", level: 0 }] } };
    const onEdit = panel(art);
    const box = screen.getByLabelText("Items (one per line, two leading spaces = one level)");
    fireEvent.change(box, { target: { value: "Plan\n  Detail\nDo" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply items" }));
    expect(onEdit).toHaveBeenLastCalledWith(request({ kind: "smartArtItems", items: [{ text: "Plan", level: 0 }, { text: "Detail", level: 1 }, { text: "Do", level: 0 }] }));
    fireEvent.change(box, { target: { value: "Plan\n      Deep" } });
    expect(screen.getByRole("button", { name: "Apply items" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Layout"), { target: { value: "cycle" } });
    expect(onEdit).toHaveBeenLastCalledWith(request({ kind: "smartArtLayout", layout: "cycle" }));
  });

  it("routes chart and SmartArt UI edits through executeCommand and DocxEditorSession to the backend", async () => {
    const { editor, fake, sessions } = await readyDocx();
    fake.objectView = {
      kind: "chart",
      address: { engine: "wordcraft", position: "body:0:0" },
      frame: { page: 0, x: 72, y: 72, width: 200, height: 120 },
      epoch: 3,
      operations: ["chart"],
      graphic: { kind: "chart", plot: "column", title: "Old", labels: ["A"], series: [{ name: "S", values: ["1"] }] },
    };
    await editor.load({ discard: true });
    const ctx = { layout: initialLayout, dispatch: vi.fn(), notify: vi.fn(), document: editor };
    const { rerender } = render(
      <LanguageProvider language="en" onLanguageChange={vi.fn()}>
        <PropertiesPanel state={documentPanelState(editor, sessions.get(1) ?? null)} onClose={vi.fn()}
          onObjectEdit={req => { executeCommand("object.edit", undefined, ctx, req); }} />
      </LanguageProvider>,
    );
    fireEvent.change(screen.getByLabelText("Chart title"), { target: { value: "New Title" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply title" }));
    await flush();
    expect(fake.objectEdits).toContainEqual({ position: "body:0:0", epoch: 3, edit: { kind: "chartTitle", text: "New Title" } });

    fake.objectView = {
      kind: "smartArt",
      address: { engine: "wordcraft", position: "body:1:0" },
      frame: { page: 0, x: 72, y: 200, width: 200, height: 120 },
      epoch: 4,
      operations: ["smartArt"],
      graphic: { kind: "smartArt", layout: "process", items: [{ text: "Step 1", level: 0 }] },
    };
    await editor.load({ discard: true });
    rerender(
      <LanguageProvider language="en" onLanguageChange={vi.fn()}>
        <PropertiesPanel state={documentPanelState(editor, sessions.get(1) ?? null)} onClose={vi.fn()}
          onObjectEdit={req => { executeCommand("object.edit", undefined, ctx, req); }} />
      </LanguageProvider>,
    );
    fireEvent.change(screen.getByLabelText("Layout"), { target: { value: "radial" } });
    await flush();
    expect(fake.objectEdits).toContainEqual({ position: "body:1:0", epoch: 4, edit: { kind: "smartArtLayout", layout: "radial" } });
  });
});
