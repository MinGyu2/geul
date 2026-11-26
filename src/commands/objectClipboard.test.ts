import { afterEach, describe, expect, it, vi } from "vitest";
import { documentCommandState } from "./capability";
import { runClipboard, type ClipboardEditing, type PlainClipboard } from "./clipboard";
import {
  decodeHwp5ObjectFragment,
  encodeHwp5ObjectFragment,
  createHwp5HwpxPortableClipboardPayload,
  createHwp5PortableShapeClipboardPayload,
  createHwpObjectClipboardPayload,
  createHwpxObjectClipboardPayload,
  createObjectClipboardPayload,
  createRichObjectClipboardPayload,
  MAX_OBJECT_CLIPBOARD_BYTES,
  MAX_HWP5_OBJECT_FRAGMENT_BYTES,
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

describe("DOCX to HWPX portable shape clipboard (v4)", () => {
  const shapeObject = (kind = "ellipse") => ({
    type: "shape", kind, w: 220, h: 130,
    fill: [204, 136, 68], stroke: [17, 34, 51], stroke_width: 1,
    float: {
      wrap: "inline", hRel: "column", vRel: "column", x: 0, y: 0,
      dist: 0, distTop: 0, distBottom: 0, effect: [44.999992, 0, 44.999992, 0],
      rot: 90, flipV: true, alt: { text: "Transfer shape" },
    },
    story: null,
  });
  const engineValue = (shape: unknown = shapeObject(), extras: Record<string, unknown> = {}) => ({
    fragment: {
      blocks: [{ kind: "para", text: "\uFFFC", runs: [{ len: 3 }], objects: [shape] }],
      ...(extras.parts !== undefined ? { parts: extras.parts } : {}),
    },
    media: extras.media ?? [],
  });

  it("maps editable inline primitives, style and transforms into exact bounded HWPX fields", () => {
    const source = engineValue();
    const payload = createRichObjectClipboardPayload("shape", JSON.stringify(source))!;
    expect(payload).toMatchObject({
      kind: "geul.object", version: 4, sourceFormat: "docx", object: "shape",
      portable: {
        kind: "shape", shapeType: "ellipse", width: 7761, height: 4586,
        horzOffset: 0, vertOffset: 0, treatAsChar: true, textWrap: "Square",
        rotationAngle: 90, horzFlip: false, vertFlip: true,
        borderColor: 0x00332211, borderWidth: 35, lineType: 1,
        fillType: "solid", fillBgColor: 0x004488cc, description: "Transfer shape",
      },
    });
    expect(parseObjectClipboardPayload(JSON.stringify(payload))).toEqual(payload);
    expect(objectClipboardPlainText(payload)).toBe("Geul shape [" + payload.token + "]");
    expect(payload.version === 4 && payload.engine).toEqual(source);

    const rectangle = createRichObjectClipboardPayload("shape", JSON.stringify(engineValue(shapeObject("rectangle"))));
    expect(rectangle).toMatchObject({ version: 4, portable: { shapeType: "rectangle" } });
    const lineShape = { ...shapeObject("line"), fill: null };
    const line = createRichObjectClipboardPayload("shape", JSON.stringify(engineValue(lineShape)));
    expect(line).toMatchObject({ version: 4, portable: { shapeType: "line", fillType: "none", borderWidth: 35 } });

    const unrotated = { ...shapeObject("rectangle"), float: { ...shapeObject().float, rot: 0, effect: [0, 0, 0, 0] } };
    expect(createRichObjectClipboardPayload("shape", JSON.stringify(engineValue(unrotated))))
      .toMatchObject({ version: 4, portable: { shapeType: "rectangle", rotationAngle: 0 } });
  });

  it("keeps unsupported DOCX shapes same-format-only and refuses tampered portable mappings", () => {
    const unsupported: unknown[] = [
      shapeObject("triangle"),
      { ...shapeObject(), float: { ...shapeObject().float, wrap: "square" } },
      // Nonzero source effect extents remain rejected after accounting for the
      // zero-source wp:effectExtent compensation caused by the 90-degree turn.
      { ...shapeObject(), float: { ...shapeObject().float, effect: [54.999992, 10, 54.999992, 10] } },
      { ...shapeObject(), effects: { shadow: { blur: 2 } } },
      { ...shapeObject(), story: 7 },
      { ...shapeObject(), customEnvelope: { id: "unknown" } },
    ];
    for (const shape of unsupported) {
      const payload = createRichObjectClipboardPayload("shape", JSON.stringify(engineValue(shape)))!;
      expect(payload.version).toBe(2);
    }
    expect(createRichObjectClipboardPayload("shape", JSON.stringify(engineValue(shapeObject(), { media: [{}] })))?.version).toBe(2);
    expect(createRichObjectClipboardPayload("shape", JSON.stringify(engineValue(shapeObject(), { parts: { 7: {} } })))?.version).toBe(2);

    const payload = createRichObjectClipboardPayload("shape", JSON.stringify(engineValue(shapeObject())))!;
    expect(payload.version).toBe(4);
    if (payload.version !== 4) throw new Error("expected v4");
    for (const raw of [
      { ...payload, portable: { ...payload.portable, width: 9000 } },
      { ...payload, portable: { ...payload.portable, shapeType: "polygon" } },
      { ...payload, extra: true },
      { ...payload, engine: { ...(payload.engine as Record<string, unknown>), media: [{}] } },
    ]) expect(parseObjectClipboardPayload(JSON.stringify(raw))).toBeNull();
  });
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
      lineType: 1,
      fillType: "solid",
      fillBgColor: 0x00826015,
      tbVerticalAlign: "Center",
      tbMargins: { left: 283, right: 283, top: 141, bottom: 141 },
      paragraphs: [{ text: "첫 줄", align: "center", runs: [{ start: 0, end: 3, bold: true }] },
        { text: "둘째 줄", align: "right", runs: [{ start: 0, end: 4, bold: false }] }],
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

    const fragment = Uint8Array.from({ length: 1024 }, (_, i) => i & 0xff);
    const encodedFragment = encodeHwp5ObjectFragment(fragment);
    expect(encodedFragment).not.toBeNull();
    const transferable = createHwpObjectClipboardPayload("shape", 7, 3, encodedFragment!);
    expect(transferable).not.toBeNull();
    expect(parseObjectClipboardPayload(JSON.stringify(transferable))).toEqual(transferable);
    expect([...decodeHwp5ObjectFragment(encodedFragment!)!]).toEqual([...fragment]);
    expect(encodeHwp5ObjectFragment(new Uint8Array(MAX_HWP5_OBJECT_FRAGMENT_BYTES + 1))).toBeNull();
    const maxFragment = encodeHwp5ObjectFragment(new Uint8Array(MAX_HWP5_OBJECT_FRAGMENT_BYTES));
    expect(maxFragment).toHaveLength(4 * Math.ceil(MAX_HWP5_OBJECT_FRAGMENT_BYTES / 3));
    expect(decodeHwp5ObjectFragment(maxFragment!)?.length).toBe(MAX_HWP5_OBJECT_FRAGMENT_BYTES);
    expect(parseObjectClipboardPayload(JSON.stringify(createHwpObjectClipboardPayload("shape", 7, 3, maxFragment!)))).not.toBeNull();
    expect(decodeHwp5ObjectFragment(`${encodedFragment!.slice(0, -4)}****`)).toBeNull();
    expect(parseObjectClipboardPayload(JSON.stringify({ ...transferable, sourceFormat: "hwpx" }))).toBeNull();

    const portableShape = {
      kind: "shape" as const, shapeType: "ellipse" as const, width: 2540, height: 1270,
      horzOffset: 0, vertOffset: 0, treatAsChar: true, textWrap: "Square" as const,
      rotationAngle: 90, horzFlip: true, vertFlip: false, borderColor: 0x00332211, borderWidth: 35,
      lineType: 1 as const, fillType: "solid" as const, fillBgColor: 0x004488cc, description: "HWP5 shape",
    };
    const hwpPortable = createHwp5PortableShapeClipboardPayload(7, 3, portableShape, encodedFragment!);
    expect(hwpPortable).toMatchObject({ version: 5, sourceFormat: "hwp", object: "shape", portable: portableShape });
    expect(parseObjectClipboardPayload(JSON.stringify(hwpPortable))).toEqual(hwpPortable);
    expect(parseObjectClipboardPayload(JSON.stringify({ ...hwpPortable, sourceFormat: "hwpx" }))).toBeNull();
    expect(parseObjectClipboardPayload(JSON.stringify({ ...hwpPortable, portable: { ...portableShape, width: 0 } }))).toBeNull();
    expect(parseObjectClipboardPayload(JSON.stringify({ ...hwpPortable, unexpected: true }))).toBeNull();
    expect(createHwp5PortableShapeClipboardPayload(7, 3, { ...portableShape, shapeType: "polygon" })).toBeNull();

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
      cropRect: { left: 0, top: 0, right: 3600, bottom: 4800 },
      caption: {
        direction: "Bottom",
        vertAlign: "Top",
        width: 3600,
        spacing: 120,
        includeMargin: false,
        paragraphs: [{ text: "그림  caption", align: "justify", autoNumberOffset: 2,
          runs: [{ start: 0, end: 2, bold: false }, { start: 3, end: 11, bold: true, fontSize: 1200, textColor: "#112233" }] }],
      },
    })!;
    expect(picPortable).not.toBeNull();
    expect(parseObjectClipboardPayload(JSON.stringify(picPortable))).toEqual(picPortable);
    const portablePicture = picPortable?.portable;
    if (!portablePicture || portablePicture.kind !== "picture") throw new Error("expected a portable picture");
    const hwp5Picture = createHwp5HwpxPortableClipboardPayload(7, 3, "picture", portablePicture, encodedFragment!);
    if (!hwp5Picture) throw new Error("HWP5 portable picture payload not admitted");
    expect(hwp5Picture).toMatchObject({ version: 6, sourceFormat: "hwp", object: "picture", portable: portablePicture });
    expect(parseObjectClipboardPayload(JSON.stringify(hwp5Picture))).toEqual(hwp5Picture);
    expect(createHwp5HwpxPortableClipboardPayload(7, 3, "shape", portablePicture)).toBeNull();
    expect(parseObjectClipboardPayload(JSON.stringify({ ...hwp5Picture, object: "shape" }))).toBeNull();
    expect(parseObjectClipboardPayload(JSON.stringify({ ...hwp5Picture, unexpected: true }))).toBeNull();
    expect(createHwpxObjectClipboardPayload("picture", 2, 1, {
      ...portablePicture,
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
      lineType: 0,
      fillType: "none",
      tbVerticalAlign: "Top",
      tbMargins: { left: 0, right: 0, top: 0, bottom: 0 },
      paragraphs: [{ text: "abc", align: "left", runs: [{ start: 1, end: 4, bold: true }] }],
    })).toBeNull();
  });
});

