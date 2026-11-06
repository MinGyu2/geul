// @vitest-environment jsdom
// Actual App/dialog/workspace and selected Release WASM. Backend load replies are
// controlled; canvas painting alone is stubbed. This does not prove publication.
import "../../src/test/setup";
import { createElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import { DocumentSessions } from "../../src/adapters/sessions";
import { DocumentWorkspace } from "../../src/components/Editor/documentWorkspace";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "../../src/components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";
import { readRhwpGeneration } from "../rhwpAssets";

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const engine = createRequire(import.meta.url)(join(root, "public/rhwp/generations", build.generation, "rhwp.js"));
const wasm = engine.initSync({ module: readFileSync(join(root, "public/rhwp/generations", build.generation, "rhwp_bg.wasm")) });
const fields = (doc: RhwpDocument) => JSON.parse(doc.getFieldList!());
const bytes = (doc: RhwpDocument, format: "hwp" | "hwpx") => {
  const report = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
  try { return report.takeBytes(); } finally { report.free(); }
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function setup(format: "hwp" | "hwpx") {
  vi.stubGlobal("__APP_VERSION__", "test");
  vi.spyOn(RhwpEditorSession.prototype, "renderPage").mockImplementation(function (this: RhwpEditorSession, page, canvas, scale) {
    const size = this.pages[page]!; canvas.width = size.width * scale; canvas.height = size.height * scale;
    return true;
  });
  const seed = engine.HwpDocument.createEmpty(); seed.createBlankDocument(); seed.createTable(0, 0, 0, 2, 2);
  const source = bytes(seed, format); seed.free();
  const { backend, calls, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const docs: RhwpDocument[] = [];
  const module: RhwpModule = { openDocument: b => { const doc = new engine.HwpDocument(b); docs.push(doc); return doc; }, memoryBytes: () => wasm.memory.buffer.byteLength };
  const workspace = new DocumentWorkspace(sessions, backend, async () => module);
  const view = render(createElement(App, { initialLanguage: "en", settingsStore: { read: () => null, write: () => true }, documentWorkspace: workspace }));
  await act(async () => { take("sessions").reply(ok([])); await flush(); });
  let sequence = 0;
  const sessionInfo = (id: number, generation: number, state: "ready" | "loading") => info({ sessionId: id, displayName: `${id}.${format}`, format, state, loadGeneration: generation, sequence: ++sequence });
  const finishLoad = async (id: number, generation: number) => {
    take("load").reply(loaded(source, generation)); await flush();
    take("session").reply(ok(sessionInfo(id, generation, "loading")));
    take("setState").reply(ok(sessionInfo(id, generation, "ready"))); await flush();
  };
  const open = async (id: number) => {
    await act(async () => {
      const opening = workspace.open(`/${id}.${format}`);
      take("open").reply(ok({ ...base, sessionId: id, displayName: `${id}.${format}`, format })); await opening; await flush();
      await finishLoad(id, 1);
    });
    return workspace.editorFor(id)!;
  };
  const editor = await open(1);
  // Use engine cursor geometry to move the real session into the result cell.
  const selectCell = () => act(() => {
    const doc = docs.at(-1)!;
    const control = JSON.parse((doc as RhwpDocument & { getControls(): string }).getControls()).find((c: { ctrlId: string }) => c.ctrlId === "tbl").controlIndex;
    const rect = JSON.parse(doc.getCursorRectInCell!(0, 0, control, 3, 0, 0));
    editor.pointAt(rect.pageIndex, rect.x + 1, rect.y + rect.height / 2, false);
    expect(editor.caret.cell?.cell).toBe(3);
  });
  const openDialog = () => {
    selectCell();
    fireEvent.click(screen.getByRole("tab", { name: "Hangul Tools" }));
    const button = view.container.querySelector('[data-command="hangul.insertTableFormula"]')!;
    expect(button.getAttribute("aria-disabled")).not.toBe("true"); fireEvent.click(button);
    const input = screen.getByTestId("command-input-value");
    fireEvent.change(input, { target: { value: "=2" } });
    return input;
  };
  return { ...view, workspace, sessions, editor, docs, calls, take, finishLoad, open, openDialog, format };
}

describe.each(["hwp", "hwpx"] as const)("old formula input ownership (%s)", format => {
  it("rejects an open dialog after same-session reload, even at the same revision", async () => {
    const ctx = await setup(format);
    try {
      const oldDoc = ctx.docs[0]!, free = vi.spyOn(oldDoc, "free");
      const input = ctx.openDialog();
      const execute = vi.spyOn(ctx.editor, "execute");
      await act(async () => {
        const loading = ctx.editor.load(); await ctx.finishLoad(1, 2); expect((await loading).ok).toBe(true);
      });
      expect(ctx.workspace.editorFor(1)).toBe(ctx.editor); expect(free).toHaveBeenCalledTimes(1);
      expect(ctx.editor.snapshot()).toMatchObject({ loadGeneration: 2, revision: 0 });
      const newDoc = ctx.docs[1]!, before = bytes(newDoc, format), session = ctx.sessions.get(1);
      expect(screen.getByTestId("command-input-value")).toBe(input);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.queryByTestId("command-input-dialog")).toBeNull();
      expect(screen.getByRole("contentinfo")).toHaveTextContent("nothing was applied");
      expect(execute).not.toHaveBeenCalled(); expect(fields(newDoc)).toEqual([]);
      expect(bytes(newDoc, format)).toEqual(before); expect(ctx.sessions.get(1)).toEqual(session);
      expect(ctx.sessions.get(1)).toMatchObject({ revision: 0, dirty: false });
      expect(ctx.editor.localRevision).toBe(0); expect(ctx.editor.hasUnpreservedChanges).toBe(false);
      expect(ctx.editor.snapshot().history).toEqual({ undo: false, redo: false });
      expect(ctx.calls.some(c => c.method === "commit")).toBe(false);
      await act(async () => { const loading = ctx.editor.load(); await ctx.finishLoad(1, 3); await loading; });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(execute).not.toHaveBeenCalled(); expect(fields(ctx.docs[2]!)).toEqual([]);
    } finally { ctx.unmount(); ctx.editor.dispose(); }
  });
  it.each(["switch", "close"] as const)("discards old input on document %s and cannot revive it", async transition => {
    const ctx = await setup(format);
    try {
      const input = ctx.openDialog(), execute = vi.spyOn(ctx.editor, "execute");
      if (transition === "switch") {
        const other = await ctx.open(2);
        expect(screen.queryByTestId("command-input-dialog")).toBeNull();
        fireEvent.keyDown(input, { key: "Enter" });
        expect(other.localRevision).toBe(0); expect(fields(ctx.docs[1]!)).toEqual([]);
        expect(ctx.sessions.get(2)).toMatchObject({ revision: 0, dirty: false });
        expect(ctx.sessions.get(1)).toMatchObject({ revision: 0, dirty: false });
        act(() => { ctx.sessions.select(1); });
        expect(screen.queryByTestId("command-input-dialog")).toBeNull();
        expect(fields(ctx.docs[0]!)).toEqual([]); other.dispose();
      } else {
        const free = vi.spyOn(ctx.docs[0]!, "free");
        await act(async () => {
          const closing = ctx.workspace.close(1, { discard: true });
          ctx.take("close").reply(ok({ sessionId: 1, alreadyClosed: false })); await closing;
        });
        expect(ctx.workspace.editorFor(1)).toBeNull(); expect(free).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId("command-input-dialog")).toBeNull();
        fireEvent.keyDown(input, { key: "Enter" });
      }
      expect(execute).not.toHaveBeenCalled(); expect(ctx.calls.some(c => c.method === "commit")).toBe(false);
    } finally { ctx.unmount(); ctx.editor.dispose(); }
  });
});
