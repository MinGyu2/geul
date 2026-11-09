import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runClipboard, validClipboardText, MAX_CLIPBOARD_CHARS, type ClipboardCommand, type PlainClipboard } from "./clipboard";
import { documentCommandState } from "./capability";
import type { DocumentCommandSnapshot, DocumentCommandTarget } from "./target";
import { commandDefinition, commandForShortcut, SHORTCUT_PROBLEMS } from "./registry";
import { handleShortcut } from "./shortcuts";
import { commandState, executeCommand, type CommandContext } from "./commands";
import { initialLayout } from "../hooks/layoutState";

function harness() {
  let state: DocumentCommandSnapshot = {
    sessionId: 1, engine: "wordcraft", loadGeneration: 1, revision: 2, loaded: true, editable: true,
    composing: false, pending: false, saving: false, queuedHistory: null, history: null, format: null, formatAccess: null,
    clipboard: { key: "selection-1", selection: true, writable: true },
  };
  const target: DocumentCommandTarget = { sessionId: 1, engine: "wordcraft", snapshot: () => state, execute: () => ({ accepted: false }) };
  const events: string[] = [];
  const editing = { read: vi.fn(async () => "한😀글\n" + "a".repeat(600)),
    remove: vi.fn(() => { events.push("delete"); return true; }), insert: vi.fn(() => true) };
  const clipboard: PlainClipboard = { readText: vi.fn(async () => "paste"), writeText: vi.fn(async () => { events.push("write"); }) };
  let owner = true;
  const run = (command: ClipboardCommand) => runClipboard(target, command, editing, () => owner, clipboard);
  return { target, editing, clipboard, events, run, patch: (p: Partial<DocumentCommandSnapshot>) => { state = { ...state, ...p }; },
    switch: () => { owner = false; } };
}
function deferred() { let finish!: () => void; const promise = new Promise<void>(r => { finish = r; }); return { promise, finish }; }

describe("plain clipboard transaction", () => {
  let previous: PropertyDescriptor | undefined;
  beforeEach(() => {
    previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => "", writeText: async () => {} } });
  });
  afterEach(() => {
    if (previous) Object.defineProperty(navigator, "clipboard", previous);
    else Reflect.deleteProperty(navigator, "clipboard");
  });
  it("missing browser clipboard access disables the corresponding command", () => {
    const h = harness();
    const context: CommandContext = { document: h.target, layout: initialLayout, notify: vi.fn(), dispatch: vi.fn() };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } });
    expect(commandState("edit.paste", context).available).toBe(false);
    expect(commandState("edit.copy", context).available).toBe(true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    expect(commandState("edit.cut", context).available).toBe(false);
  });
  it("registers all commands and platform shortcuts without conflicts", () => {
    for (const [id, key] of [["copy", "C"], ["cut", "X"], ["paste", "V"]]) {
      expect(commandDefinition(`edit.${id}`)?.kind).toBe("document");
      expect(commandForShortcut(`Mod+Key${key}`)?.id).toBe(`edit.${id}`);
      expect(commandDefinition(`edit.${id}`)?.engines?.rhwp.level).toBe("supported");
    }
    expect(SHORTCUT_PROBLEMS).toEqual([]);
  });
  it("copies full >500 character Unicode text without changing state", async () => {
    const h = harness(), before = h.target.snapshot();
    expect(await h.run("edit.copy")).toBe(true);
    expect(h.clipboard.writeText).toHaveBeenCalledWith("한😀글\n" + "a".repeat(600));
    expect(h.target.snapshot()).toEqual(before);
    expect(h.editing.remove).not.toHaveBeenCalled();
  });
  it("writes successfully before deleting", async () => {
    const h = harness(); expect(await h.run("edit.cut")).toBe(true); expect(h.events).toEqual(["write", "delete"]);
  });
  it("write failure never deletes or reports success", async () => {
    const h = harness(); h.clipboard.writeText = vi.fn(async () => { throw Error("denied"); });
    expect(await h.run("edit.cut")).toBe(false); expect(h.editing.remove).not.toHaveBeenCalled();
  });
  it.each(["selection", "revision", "generation", "pending", "IME", "save", "close", "readonly", "document"])("cancels cut on %s change during write", async kind => {
    const h = harness(), gate = deferred(); h.clipboard.writeText = vi.fn(() => gate.promise);
    const result = h.run("edit.cut"); await Promise.resolve();
    if (kind === "selection") h.patch({ clipboard: { key: "selection-2", selection: true, writable: true } });
    if (kind === "revision") h.patch({ revision: 3, clipboard: { key: "rev3", selection: true, writable: true } });
    if (kind === "generation") h.patch({ loadGeneration: 2, clipboard: { key: "gen2", selection: true, writable: true } });
    if (kind === "pending") h.patch({ pending: true });
    if (kind === "IME") h.patch({ composing: true });
    if (kind === "save") h.patch({ saving: true });
    if (kind === "close") h.patch({ loaded: false });
    if (kind === "readonly") h.patch({ editable: false });
    if (kind === "document") h.switch();
    gate.finish(); expect(await result).toBe(false); expect(h.editing.remove).not.toHaveBeenCalled();
  });
  it("serializes repeated invocation through a single transaction", async () => {
    const h = harness(), gate = deferred(); h.clipboard.writeText = vi.fn(() => gate.promise);
    const first = h.run("edit.cut"); await Promise.resolve();
    expect(await h.run("edit.cut")).toBe(false); gate.finish(); expect(await first).toBe(true);
    expect(h.editing.remove).toHaveBeenCalledTimes(1);
  });
  it.each(["", "bad\uFFFC", "bad\u0000", "\ud800", "a".repeat(MAX_CLIPBOARD_CHARS + 1)])("rejects empty/unsupported/large paste", async text => {
    const h = harness(); h.clipboard.readText = vi.fn(async () => text);
    expect(await h.run("edit.paste")).toBe(false); expect(h.editing.insert).not.toHaveBeenCalled();
  });
  it("accepts newlines, tabs and Unicode", () => expect(validClipboardText("한😀\r\n\t글")).toBe(true));
  it("paste read failure does not insert", async () => {
    const h = harness(); h.clipboard.readText = vi.fn(async () => { throw Error("unavailable"); });
    expect(await h.run("edit.paste")).toBe(false); expect(h.editing.insert).not.toHaveBeenCalled();
  });
  it("paste document switch cancels and later requests read fresh clipboard", async () => {
    const h = harness(), gate = deferred(); h.clipboard.readText = vi.fn(async () => { await gate.promise; return "old"; });
    const first = h.run("edit.paste"); h.switch(); gate.finish(); expect(await first).toBe(false);
    expect(h.editing.insert).not.toHaveBeenCalled();
    const next = harness(); next.clipboard.readText = vi.fn().mockResolvedValueOnce("one").mockResolvedValueOnce("two");
    expect(await next.run("edit.paste")).toBe(true); expect(await next.run("edit.paste")).toBe(true);
    expect(next.editing.insert.mock.calls).toEqual([["one"], ["two"]]);
  });
  it("allows readable read-only copy while refusing cut/paste", () => {
    const h = harness(); h.patch({ editable: false });
    expect(documentCommandState("edit.copy", h.target.snapshot()).available).toBe(true);
    for (const id of ["edit.cut", "edit.paste"] as const) expect(documentCommandState(id, h.target.snapshot()).available).toBe(false);
  });
  it.each(["edit.copy", "edit.cut", "edit.paste"] as const)("blocks %s for IME, pending and save", id => {
    for (const p of [{ composing: true }, { pending: true }, { saving: true }]) {
      const h = harness(); h.patch(p); expect(documentCommandState(id, h.target.snapshot()).available).toBe(false);
    }
  });
  it("empty and unsupported selection cannot copy/cut", async () => {
    const h = harness(); h.patch({ clipboard: { key: "empty", selection: false, writable: true } });
    expect(await h.run("edit.copy")).toBe(false); expect(await h.run("edit.cut")).toBe(false); expect(h.editing.read).not.toHaveBeenCalled();
  });
  it("keyboard and ribbon dispatch exactly once, modal blocks, external fields keep native default", async () => {
    const h = harness(); h.target.executeClipboard = vi.fn(async () => true);
    const context: CommandContext = { document: h.target, layout: initialLayout, notify: vi.fn(), dispatch: vi.fn(), clipboardOwner: () => () => true };
    const key = (target: HTMLElement, code: string) => { const e = new KeyboardEvent("keydown", { code, ctrlKey: true, bubbles: true, cancelable: true });
      target.addEventListener("keydown", event => handleShortcut(event, context, false), { once: true }); target.dispatchEvent(e); return e; };
    const editor = document.createElement("textarea"); editor.className = "rhwp-input";
    expect(key(editor, "KeyV").defaultPrevented).toBe(true); expect(h.target.executeClipboard).toHaveBeenCalledTimes(1);
    executeCommand("edit.paste", undefined, context); expect(h.target.executeClipboard).toHaveBeenCalledTimes(2);
    context.modal = true; expect(key(editor, "KeyX").defaultPrevented).toBe(true); expect(h.target.executeClipboard).toHaveBeenCalledTimes(2);
    for (const el of [document.createElement("input"), document.createElement("textarea"), document.createElement("div")]) {
      if (el.tagName === "DIV") el.setAttribute("contenteditable", "true");
      for (const code of ["KeyC", "KeyX", "KeyV"]) expect(key(el, code).defaultPrevented).toBe(false);
    }
    await Promise.resolve();
  });
  it("composing clipboard chords suppress native default without dispatch, including keyCode229", () => {
    const h = harness(); h.target.executeClipboard = vi.fn(async () => true);
    const context: CommandContext = { document: h.target, layout: initialLayout, notify: vi.fn(), dispatch: vi.fn(), clipboardOwner: () => () => true };
    const input = document.createElement("textarea"); input.className = "rhwp-input";
    for (const code of ["KeyC", "KeyX", "KeyV"]) for (const marker of [{ isComposing: true }, { keyCode: 229 }]) {
      const e = new KeyboardEvent("keydown", { code, ctrlKey: true, bubbles: true, cancelable: true, ...marker });
      input.addEventListener("keydown", event => handleShortcut(event, context, false), { once: true }); input.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
    }
    expect(h.target.executeClipboard).not.toHaveBeenCalled();
  });

});
