import { afterEach, describe, expect, it, vi } from "vitest";
import { runClipboard, type ClipboardEditing, type PlainClipboard } from "./clipboard";
import { createObjectClipboardPayload, createRichObjectClipboardPayload, MAX_OBJECT_CLIPBOARD_BYTES, OBJECT_CLIPBOARD_MIME, objectClipboardPlainText, parseObjectClipboardPayload } from "./objectClipboard";
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

describe("rich object clipboard (v2)", () => {
  const engine = JSON.stringify({ fragment: { blocks: [] }, media: [{ name: "image1.png", sha256: "00".repeat(32), data: "AAAA" }] });

  it("wraps the engine payload in a bounded versioned envelope and rejects malformed envelopes", () => {
    const payload = createRichObjectClipboardPayload("picture", engine)!;
    expect(payload).toMatchObject({ kind: "geul.object", version: 2, sourceFormat: "docx", object: "picture" });
    expect(parseObjectClipboardPayload(JSON.stringify(payload))).toEqual(payload);
    expect(objectClipboardPlainText(payload)).toBe(`Geul picture [${payload.token}]`);
    for (const raw of [
      { ...payload, object: "chart" }, { ...payload, sourceFormat: "hwpx" }, { ...payload, extra: 1 },
      { ...payload, engine: { fragment: {}, media: [], path: "/etc/passwd" } }, { ...payload, engine: { fragment: [], media: [] } },
      { ...payload, engine: { fragment: {}, media: Array.from({ length: 17 }, () => ({})) } }, { ...payload, token: "x" },
    ]) expect(parseObjectClipboardPayload(JSON.stringify(raw))).toBeNull();
    expect(createRichObjectClipboardPayload("shape", "not json")).toBeNull();
    expect(createRichObjectClipboardPayload("shape", "[1]")).toBeNull();
    expect(parseObjectClipboardPayload("x".repeat(MAX_OBJECT_CLIPBOARD_BYTES + 1))).toBeNull();
  });

  it("recalls the in-app payload only while the system clipboard still holds its marker text", async () => {
    const payload = createRichObjectClipboardPayload("textBox", engine)!;
    const data = JSON.stringify(payload), plainText = objectClipboardPlainText(payload);
    const insertStructured = vi.fn<NonNullable<ClipboardEditing["insertStructured"]>>(async () => "ok");
    const insert = vi.fn(() => true);
    const editing = {
      read: vi.fn(async () => null), remove: vi.fn(() => false), insert, insertStructured, removeStructured: vi.fn(() => true),
      readStructured: async () => ({ status: "ok" as const, mime: OBJECT_CLIPBOARD_MIME, data, plainText }),
    };
    let system = "";
    const clipboard: PlainClipboard = { writeText: vi.fn(async (text: string) => { system = text; }), readText: vi.fn(async () => system) };
    const docx = target();
    expect(await runClipboard(docx, "edit.copy", editing, () => true, clipboard)).toBe(true);
    expect(system).toBe(plainText);
    expect(await runClipboard(docx, "edit.paste", editing, () => true, clipboard)).toBe(true);
    expect(insertStructured).toHaveBeenLastCalledWith(OBJECT_CLIPBOARD_MIME, data);
    // Another application replaced the clipboard: the stale object is not pasted, the text is.
    system = "copied elsewhere";
    expect(await runClipboard(docx, "edit.paste", editing, () => true, clipboard)).toBe(true);
    expect(insertStructured).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledWith("copied elsewhere");
    // Even restoring the marker text later does not resurrect the forgotten payload.
    system = plainText;
    expect(await runClipboard(docx, "edit.paste", editing, () => true, clipboard)).toBe(true);
    expect(insertStructured).toHaveBeenCalledOnce();
  });

  it("carries grouped v2 objects in the envelope and refuses unsupported RHWP destination without mutation", async () => {
    const groupPayload = createRichObjectClipboardPayload("group", engine)!;
    expect(groupPayload.object).toBe("group");
    expect(parseObjectClipboardPayload(JSON.stringify(groupPayload))).toEqual(groupPayload);
    expect(objectClipboardPlainText(groupPayload)).toBe(`Geul group [${groupPayload.token}]`);

    const data = JSON.stringify(groupPayload), plainText = objectClipboardPlainText(groupPayload);
    const insertStructured = vi.fn<NonNullable<ClipboardEditing["insertStructured"]>>(async (mime) =>
      mime === OBJECT_CLIPBOARD_MIME ? "rejected" : "ok",
    );
    const insert = vi.fn(() => true);
    const editing = {
      read: vi.fn(async () => null), remove: vi.fn(() => false), insert, insertStructured,
      readStructured: async () => ({ status: "ok" as const, mime: OBJECT_CLIPBOARD_MIME, data, plainText }),
    };
    const clipboard: PlainClipboard = {
      writeText: vi.fn(async () => undefined),
      readText: vi.fn(async () => plainText),
      readStructured: vi.fn(async mime => mime === OBJECT_CLIPBOARD_MIME ? data : null),
    };
    expect(await runClipboard(target("rhwp"), "edit.paste", editing, () => true, clipboard)).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });
});

