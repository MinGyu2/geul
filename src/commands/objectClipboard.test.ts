import { afterEach, describe, expect, it, vi } from "vitest";
import { runClipboard, type ClipboardEditing, type PlainClipboard } from "./clipboard";
import { createObjectClipboardPayload, OBJECT_CLIPBOARD_MIME, objectClipboardPlainText, parseObjectClipboardPayload } from "./objectClipboard";
import { clearStructuredClipboard, TABLE_CLIPBOARD_MIME } from "./tableClipboard";
import type { DocumentCommandSnapshot, DocumentCommandTarget } from "./target";

const target = (engine: DocumentCommandSnapshot["engine"] = "wordcraft"): DocumentCommandTarget => ({
  sessionId: 1, engine, execute: () => ({ accepted: false }),
  snapshot: () => ({
    sessionId: 1, engine, loadGeneration: 1, revision: 3, loaded: true, editable: true,
    composing: false, pending: false, saving: false, queuedHistory: null, history: null, format: null, formatAccess: null,
    clipboard: { selection: true, writable: true, key: "owned" },
  }),
});

afterEach(clearStructuredClipboard);

describe("versioned object clipboard", () => {
  it("accepts the full standard shape and rejects invalid geometry, resource injection, version and source", () => {
    const valid = createObjectClipboardPayload("ellipse");
    expect(parseObjectClipboardPayload(JSON.stringify(valid))).toEqual(valid);
    for (const raw of [
      { ...valid, version: 2 }, { ...valid, sourceFormat: "hwp" },
      { ...valid, object: { ...valid.object, widthPt: Infinity } },
      { ...valid, object: { ...valid.object, mediaId: "external" } },
      { ...valid, object: { ...valid.object, fill: "#000000" } },
    ]) expect(parseObjectClipboardPayload(JSON.stringify(raw))).toBeNull();
    expect(parseObjectClipboardPayload(" ".repeat(4096))).toBeNull();
  });

  it("uses the same clipboard transaction for copy, cut and paste and refuses cross-format fallback", async () => {
    const object = createObjectClipboardPayload("rectangle");
    const data = JSON.stringify(object), plainText = objectClipboardPlainText(object);
    const insertStructured = vi.fn<NonNullable<ClipboardEditing["insertStructured"]>>(async () => "ok");
    const insert = vi.fn(() => true), removeStructured = vi.fn(() => true);
    const editing = {
      read: vi.fn(async () => null), remove: vi.fn(() => false), insert, insertStructured, removeStructured,
      readStructured: async () => ({ status: "ok" as const, mime: OBJECT_CLIPBOARD_MIME, data, plainText }),
    };
    const clipboard: PlainClipboard = {
      writeText: vi.fn(async () => undefined), readText: vi.fn(async () => plainText),
    };
    const docx = target();
    expect(await runClipboard(docx, "edit.copy", editing, () => true, clipboard)).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith(plainText);
    expect(removeStructured).not.toHaveBeenCalled();
    expect(await runClipboard(docx, "edit.cut", editing, () => true, clipboard)).toBe(true);
    expect(removeStructured).toHaveBeenCalledOnce();
    expect(await runClipboard(docx, "edit.paste", editing, () => true, clipboard)).toBe(true);
    expect(insertStructured).toHaveBeenCalledWith(OBJECT_CLIPBOARD_MIME, data);
    expect(await runClipboard(target("rhwp"), "edit.paste", {
      ...editing, insertStructured: async () => "rejected",
    }, () => true, clipboard)).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });

  it("refuses malformed custom object MIME and a clipboard write failure with no mutation", async () => {
    const object = createObjectClipboardPayload("line");
    const data = JSON.stringify(object), plainText = objectClipboardPlainText(object);
    const editing = {
      read: vi.fn(async () => null), remove: vi.fn(() => false), insert: vi.fn(() => true),
      removeStructured: vi.fn(() => true), insertStructured: vi.fn<NonNullable<ClipboardEditing["insertStructured"]>>(async () => "ok"),
      readStructured: async () => ({ status: "ok" as const, mime: OBJECT_CLIPBOARD_MIME, data, plainText }),
    };
    const clipboard: PlainClipboard = {
      writeText: vi.fn(async () => { throw new Error("clipboard unavailable"); }), readText: vi.fn(async () => "old"),
      readStructured: vi.fn(async mime => mime === TABLE_CLIPBOARD_MIME ? null : '{"version":2}'),
    };
    const docx = target();
    expect(await runClipboard(docx, "edit.cut", editing, () => true, clipboard)).toBe(false);
    expect(await runClipboard(docx, "edit.paste", editing, () => true, clipboard)).toBe(false);
    expect(editing.removeStructured).not.toHaveBeenCalled();
    expect(editing.insertStructured).not.toHaveBeenCalled();
    expect(editing.insert).not.toHaveBeenCalled();
  });
});
