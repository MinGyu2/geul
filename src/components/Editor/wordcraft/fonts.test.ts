// Stage 5-A: DOCX session font command and font-database change handling (fake backend; the real WordCraft font
// formatting, layout and PDF are tested in Rust adapters/wordcraft/font_tests.rs).
import { describe, expect, it } from "vitest";
import { executeCommand, type CommandContext } from "../../../commands/commands";
import { initialLayout } from "../../../hooks/layoutState";
import { FAKE_FONT, flush, readyDocx } from "./testing";

describe("DOCX font command", () => {
  it("applies a family to the selection as one engine edit, reports it back and undoes it", async () => {
    const { editor, fake } = await readyDocx();
    expect(editor.snapshot().font).toEqual({ family: FAKE_FONT });
    expect(editor.snapshot().parameters?.["format.font"]).toEqual({ font: { family: FAKE_FONT } });
    editor.selectAll();
    await flush();
    expect(editor.execute("format.font", { command: "format.font", family: " Noto Sans CJK KR " }).accepted).toBe(true);
    await flush();
    const edits = fake.calls.filter((c) => c.method === "edit");
    expect(edits.at(-1)!.args[3]).toEqual([{ op: "font", name: "Noto Sans CJK KR" }]);
    expect(editor.snapshot().font).toEqual({ family: "Noto Sans CJK KR" });
    expect(editor.revision).toBe(1);
    expect(editor.execute("edit.undo").accepted).toBe(true);
    await flush();
    expect(editor.snapshot().font).toEqual({ family: FAKE_FONT });
  });

  it("rejects invalid families and wrong argument shapes before the engine", async () => {
    const { editor, fake } = await readyDocx();
    const before = fake.calls.length;
    for (const family of ["", "  ", "a,b", "x\"y", "a\u0000b", "가".repeat(43)]) {
      expect(editor.execute("format.font", { command: "format.font", family }).accepted, family).toBe(false);
    }
    expect(editor.execute("format.font").accepted).toBe(false);
    expect(fake.calls.length).toBe(before);
  });

  it("is blocked by formatting protection and goes only to the session it was issued for", async () => {
    const { editor, fake } = await readyDocx();
    fake.formatAccess = "protected";
    await editor.fontsChanged(); // fetch a fresh view (protection reported by the backend)
    expect(editor.snapshot().parameters?.["format.font"]).toBeUndefined();
    const notices: string[] = [];
    const context: CommandContext = { layout: initialLayout, dispatch: () => {}, notify: (m) => notices.push(m.key), document: editor };
    expect(executeCommand("format.font", undefined, context, { command: "format.font", family: "X" })).toBe(false);
    expect(fake.calls.filter((c) => c.method === "edit")).toHaveLength(0);
    // The picker has no free-form dialog: a call without a family is refused.
    fake.formatAccess = "allowed";
    await editor.fontsChanged();
    expect(executeCommand("format.font", undefined, { ...context, document: editor })).toBe(false);
  });

  it("redraws every page in full when the font database changes, without a new revision", async () => {
    const { editor, fake } = await readyDocx();
    const views = () => fake.calls.filter((c) => c.method === "view").length;
    const before = views();
    fake.fontGeneration = 1;
    await editor.fontsChanged();
    expect(views()).toBe(before + 1);
    expect(editor.view?.fontGeneration).toBe(1);
    expect(editor.revision).toBe(0);
    expect(editor.isCurrent(0, 1)).toBe(false);
  });
});
