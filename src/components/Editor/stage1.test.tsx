// Stage 1 frontend integration: view parsing, DOCX session availability/state and operation routing, the shared
// argument validation, the paragraph/margins dialog, ribbon value pickers and the find bar. Document effects
// (actual mutation, undo/redo, save/reopen) are verified against the real engines in Rust
// (src-tauri/src/services/save/stage1_docx_tests.rs).
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parseDocxView, type DocxView } from "../../adapters/docx";
import { commandState, executeCommand, type CommandContext } from "../../commands/commands";
import { documentCommandState } from "../../commands/capability";
import { fromMm } from "../../commands/stage1";
import { initialLayout } from "../../hooks/layoutState";
import { LanguageProvider } from "../../language/LanguageContext";
import { Ribbon } from "../Ribbon/Ribbon";
import { FindBar } from "../FindBar/FindBar";
import { buildStage1Args } from "./Stage1Dialog";
import { flush, readyDocx } from "./wordcraft/testing";

const STAGE1: Pick<DocxView, "chars" | "paragraph" | "page"> = {
  chars: { size: 11, color: "auto", highlight: null, superscript: false, subscript: false },
  paragraph: {
    align: "center", lineSpacing: { rule: "multiple", value: 1.15 }, spaceBefore: 0, spaceAfter: 8,
    indentLeft: 0, indentRight: 0, indentFirst: 0, list: null,
  },
  page: {
    width: 595.3, height: 841.9, landscape: false, marginTop: 72, marginBottom: 72, marginLeft: 72, marginRight: 72,
    columns: 1, columnSpace: 36, paper: "A4",
  },
};

async function stage1Docx() {
  const ready = await readyDocx(["첫 문단", "둘째 문단"]);
  ready.fake.stage1 = structuredClone(STAGE1);
  ready.editor.move("docStart", false);
  await flush();
  return ready;
}

const lastOps = (fake: Awaited<ReturnType<typeof readyDocx>>["fake"]) =>
  fake.calls.filter((c) => c.method === "edit").at(-1)?.args[3];

describe("Stage 1 DOCX view parsing", () => {
  it("accepts reported Stage 1 state and rejects a malformed field instead of inventing one", async () => {
    const { fake } = await stage1Docx();
    const { font, ...rest } = fake.snapshot();
    // Backend shape: the font families travel inside `format`.
    const view = { ...rest, format: { ...rest.format, font: font.family, fontEastAsia: font.eastAsia } };
    expect(parseDocxView(view)?.paragraph?.align).toBe("center");
    expect(parseDocxView({ ...view, paragraph: { ...view.paragraph, align: "middle" } })).toBeNull();
    expect(parseDocxView({ ...view, page: { ...view.page, paper: "A9" } })).toBeNull();
    expect(parseDocxView({ ...view, search: { text: "a", matchCase: false, wholeWord: false, count: 1, current: 1 } })).toBeNull();
    // Mixed values are null, not a fabricated uniform value.
    expect(parseDocxView({ ...view, paragraph: { ...view.paragraph, align: null } })?.paragraph?.align).toBeNull();
  });
});

describe("Stage 1 DOCX session", () => {
  it("reports actual alignment/script state and routes explicit alignment and script operations", async () => {
    const { editor, fake } = await stage1Docx();
    const snapshot = editor.snapshot();
    expect(documentCommandState("paragraph.alignCenter", snapshot)).toEqual({ available: true, pressed: true });
    expect(documentCommandState("paragraph.alignLeft", snapshot)).toEqual({ available: true, pressed: false });
    expect(editor.execute("paragraph.justify").accepted).toBe(true);
    await flush();
    expect(lastOps(fake)).toEqual([{ op: "align", value: "justify" }]);
    expect(editor.execute("format.superscript").accepted).toBe(true);
    await flush();
    expect(lastOps(fake)).toEqual([{ op: "script", value: "superscript" }]);
    fake.stage1!.chars!.superscript = true;
    editor.move("docStart", false); await flush();
    expect(editor.execute("format.superscript").accepted).toBe(true);
    await flush();
    expect(lastOps(fake)).toEqual([{ op: "script", value: "baseline" }]);
  });

  it("validates value commands before queueing", async () => {
    const { editor, fake } = await stage1Docx();
    expect(editor.execute("format.fontSize", { command: "format.fontSize", size: 0 }).accepted).toBe(false);
    expect(editor.execute("format.fontColor", { command: "format.fontColor", color: "red" }).accepted).toBe(false);
    expect(editor.execute("format.fontSize", { command: "format.fontSize", size: 14 }).accepted).toBe(true);
    // While that edit is in flight the session serializes: value commands wait (pendingEdits).
    expect(documentCommandState("format.highlight", editor.snapshot())).toEqual({ available: false, reason: "pendingEdits" });
    await flush();
    expect(editor.execute("format.highlight", { command: "format.highlight", color: "yellow" }).accepted).toBe(true);
    await flush();
    expect(editor.execute("layout.size", { command: "layout.size", name: "A5" }).accepted).toBe(true);
    await flush();
    expect(editor.execute("paragraph.settings", { command: "paragraph.settings", format: {} }).accepted).toBe(false);
    expect(editor.execute("paragraph.settings", { command: "paragraph.settings", format: { indentFirst: -18 } }).accepted).toBe(true);
    await flush();
    expect(fake.stage1Ops).toEqual([
      { op: "fontSize", size: 14 }, { op: "highlight", color: "yellow" }, { op: "pageSetup", setup: { kind: "size", name: "A5" } },
      { op: "paragraph", format: { indentFirst: -18 } },
    ]);
  });

  it("lists need a list item for restart/continue and route list operations", async () => {
    const { editor, fake } = await stage1Docx();
    expect(documentCommandState("paragraph.restartNumbering", editor.snapshot())).toEqual({ available: false, reason: "caretRequired" });
    expect(editor.execute("paragraph.numbering").accepted).toBe(true);
    await flush();
    expect(lastOps(fake)).toEqual([{ op: "list", style: "numbered", off: false }]);
    fake.stage1!.paragraph!.list = { bullets: false, numbering: true, multilevel: false, level: 0 };
    editor.move("docStart", false); await flush();
    expect(documentCommandState("paragraph.numbering", editor.snapshot())).toEqual({ available: true, pressed: true });
    expect(editor.execute("paragraph.restartNumbering").accepted).toBe(true);
    await flush();
    expect(editor.execute("paragraph.increaseIndent").accepted).toBe(true);
    await flush();
    expect(fake.stage1Ops.slice(-2)).toEqual([{ op: "restartNumbering" }, { op: "listIndent", outdent: false }]);
  });

  it("an engine view without Stage 1 state keeps the commands unavailable", async () => {
    const { editor } = await readyDocx(["x"]);
    expect(documentCommandState("paragraph.alignCenter", editor.snapshot())).toEqual({ available: false, reason: "engineUnsupported" });
    expect(documentCommandState("format.fontSize", editor.snapshot())).toEqual({ available: false, reason: "engineUnsupported" });
  });

  it("document protection blocks formatting and replacement but not searching", async () => {
    const { editor, fake } = await stage1Docx();
    fake.formatAccess = "protected";
    editor.move("docStart", false); await flush();
    const snapshot = editor.snapshot();
    expect(documentCommandState("paragraph.alignCenter", snapshot).available).toBe(false);
    expect(documentCommandState("edit.find", snapshot).available).toBe(true);
    expect(documentCommandState("edit.replace", snapshot)).toEqual({ available: false, reason: "protected" });
    const query = { text: "문단", matchCase: false, wholeWord: false };
    expect(editor.search({ kind: "replaceAll", query, with: "x" })).toBe(false);
    expect(editor.search({ kind: "find", query, backward: false })).toBe(true);
    expect(editor.search({ kind: "find", query: { ...query, text: "" }, backward: false })).toBe(false);
    await flush();
    expect(lastOps(fake)).toEqual([{ op: "find", query, backward: false }]);
  });
});

describe("Stage 1 dialog values", () => {
  it("converts millimetres to points and keeps empty fields unchanged", () => {
    expect(buildStage1Args("layout.margins", { top: "25.4", bottom: "20", left: "30", right: "30" })).toEqual({
      command: "layout.margins", top: 72, bottom: fromMm(20), left: fromMm(30), right: fromMm(30),
    });
    expect(buildStage1Args("layout.margins", { top: "", bottom: "20", left: "30", right: "30" })).toBeNull();
    expect(buildStage1Args("paragraph.settings", { rule: "exactly", line: "20", special: "hanging", by: "10" })).toEqual({
      command: "paragraph.settings", format: { lineSpacing: { rule: "exactly", value: 20 }, indentFirst: -fromMm(10) },
    });
    expect(buildStage1Args("paragraph.settings", { before: "-3" })).toBeNull();
    expect(buildStage1Args("paragraph.settings", {})).toBeNull();
  });
});

function contextFor(editor: Awaited<ReturnType<typeof readyDocx>>["editor"], patch: Partial<CommandContext> = {}): CommandContext {
  return { layout: initialLayout, dispatch: vi.fn(), notify: vi.fn(), document: editor, ...patch };
}

describe("Stage 1 UI", () => {
  it("ribbon value pickers show the engine value and apply through the command boundary", async () => {
    const { editor, fake } = await stage1Docx();
    render(<LanguageProvider language="en" onLanguageChange={() => {}}><Ribbon context={contextFor(editor)} format="docx" /></LanguageProvider>);
    const size = screen.getByRole("combobox", { name: "Font Size" }) as HTMLSelectElement;
    expect(size.value).toBe("11");
    fireEvent.change(size, { target: { value: "18" } });
    await flush();
    expect(lastOps(fake)).toEqual([{ op: "fontSize", size: 18 }]);
    expect(screen.getByRole("button", { name: /Align Left/ })).toBeTruthy();
  });

  it("find shortcut opens search; the bar sends model searches and shows the engine's count", async () => {
    const { editor, fake } = await stage1Docx();
    const openSearch = vi.fn();
    expect(commandState("edit.find", contextFor(editor, { openSearch })).available).toBe(true);
    expect(executeCommand("edit.replace", undefined, contextFor(editor, { openSearch }))).toBe(true);
    expect(openSearch).toHaveBeenCalledWith(true);
    const onClose = vi.fn();
    const view = render(<LanguageProvider language="en" onLanguageChange={() => {}}><FindBar context={contextFor(editor)} replace onClose={onClose} /></LanguageProvider>);
    fireEvent.change(screen.getByTestId("find-text"), { target: { value: "문단" } });
    fireEvent.keyDown(screen.getByTestId("find-text"), { key: "Enter" });
    await flush();
    expect(lastOps(fake)).toEqual([{ op: "find", query: { text: "문단", matchCase: false, wholeWord: false }, backward: false }]);
    fake.stage1Search = { text: "문단", matchCase: false, wholeWord: false, count: 2, current: 0 };
    editor.move("docStart", false); await flush();
    view.rerender(<LanguageProvider language="en" onLanguageChange={() => {}}><FindBar context={contextFor(editor)} replace onClose={onClose} /></LanguageProvider>);
    expect(screen.getByTestId("find-count").textContent).toBe("1 of 2");
    fireEvent.change(screen.getByTestId("replace-text"), { target: { value: "단락" } });
    fireEvent.click(screen.getByTestId("replace-all"));
    await flush();
    expect(lastOps(fake)).toEqual([{ op: "replaceAll", query: { text: "문단", matchCase: false, wholeWord: false }, with: "단락" }]);
    fireEvent.click(screen.getByTestId("find-close"));
    await flush();
    expect(onClose).toHaveBeenCalled();
    expect(lastOps(fake)).toEqual([{ op: "clearSearch" }]);
  });
});
