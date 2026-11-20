import { afterEach, describe, expect, it, vi } from "vitest";
import { documentCommandState } from "./capability";
import { runClipboard, type ClipboardEditing, type PlainClipboard } from "./clipboard";
import {
  createHwpObjectClipboardPayload,
  createHwpxObjectClipboardPayload,
  createObjectClipboardPayload,
  createRichObjectClipboardPayload,
  MAX_OBJECT_CLIPBOARD_BYTES,
  OBJECT_CLIPBOARD_MIME,
  objectClipboardPlainText,
  parseObjectClipboardPayload,
} from "./objectClipboard";
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
  it("routes Linux structured copy and paste through native MIME without inserting fallback text", async () => {
    const object = createObjectClipboardPayload("rectangle");
    const data = JSON.stringify(object), plainText = objectClipboardPlainText(object);
    const invoke = vi.fn(async (command: string, args: { mime: string }) =>
      command === "clipboard_read_structured" && args.mime === OBJECT_CLIPBOARD_MIME ? data : null);
    vi.stubGlobal("isTauri", true);
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    const agent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Linux");
    try {
      const doc = target();
      const editing = {
        read: async () => null, remove: vi.fn(() => false), insert: vi.fn(() => false),
        readStructured: async () => ({ status: "ok" as const, mime: OBJECT_CLIPBOARD_MIME, data, plainText }),
        insertStructured: vi.fn<NonNullable<ClipboardEditing["insertStructured"]>>(async () => "ok"),
      };
      expect(await runClipboard(doc, "edit.copy", editing, () => true)).toBe(true);
      expect(invoke).toHaveBeenCalledWith("clipboard_write_structured", {
        mime: OBJECT_CLIPBOARD_MIME, data, plainText,
      }, undefined);
      expect(await runClipboard(doc, "edit.paste", editing, () => true)).toBe(true);
      expect(editing.insertStructured).toHaveBeenCalledWith(OBJECT_CLIPBOARD_MIME, data);
      expect(editing.insert).not.toHaveBeenCalled();
      expect(invoke.mock.calls.map(([command]) => command)).toEqual([
        "clipboard_write_structured", "clipboard_read_structured", "clipboard_read_structured",
      ]);
    } finally {
      agent.mockRestore();
      vi.unstubAllGlobals();
    }
  });

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
    // Even restoring the marker text later does not resurrect the forgotten payload or degrade to text.
    system = plainText;
    expect(await runClipboard(docx, "edit.paste", editing, () => true, clipboard)).toBe(false);
    expect(insertStructured).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledOnce();
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

  it("validates HWPX v3 envelopes and keeps cross-engine and v2 hwpx envelopes rejected", () => {
    const portable = createHwpxObjectClipboardPayload("textBox", 1, 2, {
      shapeType: "textbox",
      width: 10800,
      height: 7200,
      horzOffset: 0,
      vertOffset: 0,
      treatAsChar: false,
      textWrap: "Square",
      rotationAngle: 0,
      horzFlip: false,
      vertFlip: false,
      borderColor: 0x005a400e,
      borderWidth: 100,
      fillType: "solid",
      fillBgColor: 0x00826015,
      tbVerticalAlign: "Center",
      tbMargins: { left: 283, right: 283, top: 141, bottom: 141 },
      paragraphs: [{ text: "첫 줄", align: "center" }, { text: "둘째 줄", align: "right" }],
    })!;
    expect(portable.version).toBe(3);
    expect(portable.sourceFormat).toBe("hwpx");
    expect(parseObjectClipboardPayload(JSON.stringify(portable))).toEqual(portable);
    expect(objectClipboardPlainText(portable)).toBe(`Geul textBox [${portable.token}]`);

    // Wrong sourceFormat, mismatched portable shapeType/kind, or v3 tagged as docx must fail.
    expect(parseObjectClipboardPayload(JSON.stringify({ ...portable, sourceFormat: "docx" }))).toBeNull();
    expect(parseObjectClipboardPayload(JSON.stringify({ ...portable, object: "shape" }))).toBeNull();
    expect(parseObjectClipboardPayload(JSON.stringify({ ...portable, portable: { ...portable.portable, rotationAngle: 360 } }))).toBeNull();

    // RHWP capability gating: shape selection allows copy/cut only when clipboard.shape is exposed.
    const rhwpTarget = {
      ...target("rhwp").snapshot(),
      objectSelection: {
        kind: "textBox" as const,
        frame: { page: 0, x: 10, y: 10, width: 100, height: 60 },
        address: { engine: "rhwp" as const, path: [0, 0, 0] },
        epoch: 1,
        sessionId: 1,
        loadGeneration: 1,
        revision: 3,
        editable: true,
        operations: ["deselect" as const, "move" as const, "delete" as const, "copy" as const, "cut" as const],
      },
      clipboard: { selection: true, writable: true, shape: { cutAllowed: true }, key: "hwpx-obj" },
    };
    expect(documentCommandState("edit.copy", rhwpTarget)).toEqual({ available: true });
    expect(documentCommandState("edit.cut", rhwpTarget)).toEqual({ available: true });
    expect(documentCommandState("edit.paste", rhwpTarget)).toEqual({ available: false, reason: "protected" });

    const hwpPayload = createHwpObjectClipboardPayload("group", 7, 3)!;
    expect(hwpPayload).toMatchObject({
      kind: "geul.object",
      version: 3,
      sourceFormat: "hwp",
      object: "group",
      sourceSessionId: 7,
      sourceGeneration: 3,
    });
    expect(parseObjectClipboardPayload(JSON.stringify(hwpPayload))).toEqual(hwpPayload);
    expect(parseObjectClipboardPayload(JSON.stringify({
      ...hwpPayload,
      portable: { shapeType: "rectangle", width: 100, height: 100, horzOffset: 0, vertOffset: 0, treatAsChar: false, textWrap: "Square", rotationAngle: 0, horzFlip: false, vertFlip: false, borderColor: 0, borderWidth: 33, fillType: "none" },
    }))).toBeNull();

    const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAADAAAABACAIAAADTQmMRAAAATklEQVR4nO3OMQ0AIBAAsVfCjH8pKMIFx9CkAjpnr69MPhASEhKqB0JCQkL1QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF4XmIMR3l0LcAAAAAElFTkSuQmCC";
    const picPortable = createHwpxObjectClipboardPayload("picture", 2, 1, {
      kind: "picture",
      mime: "image/png",
      bytesBase64: pngB64,
      width: 3600,
      height: 2400,
      naturalWidth: 48,
      naturalHeight: 64,
      horzOffset: 100,
      vertOffset: 200,
      treatAsChar: false,
      textWrap: "Square",
      borderColor: 0,
      borderWidth: 0,
      borderType: 0,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
      caption: {
        direction: "Bottom",
        vertAlign: "Top",
        width: 3600,
        spacing: 120,
        includeMargin: false,
        paragraphs: [{ text: "그림  caption", autoNumberOffset: 2, runs: [{ start: 4, end: 11, bold: true, fontSize: 1200, textColor: "#112233" }] }],
      },
    })!;
    expect(picPortable).not.toBeNull();
    expect(parseObjectClipboardPayload(JSON.stringify(picPortable))).toEqual(picPortable);
    expect(createHwpxObjectClipboardPayload("picture", 2, 1, {
      ...(picPortable.portable as any),
      mime: "image/jpeg",
    })).toBeNull();
    expect(createHwpxObjectClipboardPayload("textBox", 2, 1, {
      shapeType: "textbox",
      width: 5000,
      height: 3000,
      horzOffset: 0,
      vertOffset: 0,
      treatAsChar: false,
      textWrap: "Square",
      rotationAngle: 0,
      horzFlip: false,
      vertFlip: false,
      borderColor: 0,
      borderWidth: 0,
      fillType: "none",
      paragraphs: [{ text: "abc", runs: [{ start: 1, end: 4, bold: true }] }],
    })).toBeNull();
  });
});

