// @vitest-environment jsdom
// Stage 3 P3: HWPX shape/text box insertion and outer formatting on the Release engine.
// With GEUL_STAGE3_OUT=<dir>, writes original/edited HWPX bytes and loss reports for `save_check`.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import { hwpReopenEqual, hwpReopenModel } from "../../src/components/Editor/rhwp/hwpReopenModel";
import { objectEditRequest, type ObjectEdit } from "../../src/commands/objectSelection";
import { FIXED_MEMORY_BYTES, controlledBackend, info, loaded, ok, flush } from "../../src/components/Editor/rhwp/testing";

const artifacts = resolve("public/rhwp");
const identity = await readRhwpGeneration(artifacts, "release");
const folder = resolve(artifacts, "generations", identity.generation);
const engine = createRequire(import.meta.url)(resolve(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(resolve(folder, "rhwp_bg.wasm")) });
const out = process.env.GEUL_STAGE3_OUT;
/** The save path's reopen evidence (RhwpEditorSession export check): pages, text and controls equal, no loss. */
function expectReopenEvidence(doc: RhwpDocument, bytes: Uint8Array, report: string) {
  const reopened = new engine.HwpDocument(bytes) as RhwpDocument & { getControls(): string; getTextFileText(): string };
  const live = doc as RhwpDocument & { getControls(): string; getTextFileText(): string };
  try {
    expect(JSON.parse(report)).toMatchObject({ count: 0 });
    expect(reopened.pageCount()).toBe(live.pageCount());
    expect(reopened.getTextFileText()).toBe(live.getTextFileText());
    expect(reopened.getControls()).toBe(live.getControls());
  } finally { reopened.free(); }
}
type Frame = { type: string; x: number; y: number; w: number; h: number; controlIdx: number };
const shapes = (doc: RhwpDocument) => (JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[]).filter(c => c.type === "shape");

function source(format: "hwp" | "hwpx"): Uint8Array {
  const doc = engine.HwpDocument.createEmpty();
  try {
    doc.createBlankDocument();
    doc.insertText(0, 0, 0, "shape anchor paragraph with some text");
    return format === "hwpx" ? doc.exportHwpx() : doc.exportHwp();
  } finally { doc.free(); }
}

async function setup(format: "hwp" | "hwpx", initial?: Uint8Array) {
  const control = controlledBackend();
  const sessions = new DocumentSessions(control.backend);
  const open = sessions.open(`/shape.${format}`);
  const sessionInfo = (patch: Parameters<typeof info>[0]) => info({ ...patch, format });
  control.take("open").reply(ok(sessionInfo({ displayName: `shape.${format}` })));
  await open;
  const bytes = initial ?? source(format);
  const doc = new engine.HwpDocument(bytes) as RhwpDocument;
  let firstOpen = true;
  const editor = new RhwpEditorSession(1, control.backend, sessions,
    async () => ({ openDocument: (input: Uint8Array) => {
      if (!firstOpen) return new engine.HwpDocument(input) as RhwpDocument;
      firstOpen = false;
      return doc;
    }, memoryBytes: () => FIXED_MEMORY_BYTES }), { natural: null });
  const loading = editor.load();
  control.take("load").reply(loaded(bytes));
  await flush();
  control.take("session").reply(ok(sessionInfo({ state: "loading", sequence: 1, loadGeneration: 1 })));
  control.take("setState").reply(ok(sessionInfo({ state: "ready", sequence: 2, loadGeneration: 1 })));
  await loading;
  let revision = 0;
  const confirm = async () => {
    revision += 1;
    const pending = control.take("commit");
    expect(pending.args).toEqual([1, 1, revision - 1, 1]);
    pending.reply(ok(sessionInfo({ state: "ready", revision, dirty: true, loadGeneration: 1, sequence: 2 + revision })));
    await flush();
  };
  const pick = (frame: Frame) => {
    expect(editor.pointAt(0, frame.x + frame.w / 2, frame.y + frame.h / 2, false, false, true)).toBe(true);
    return editor.objectSelection!;
  };
  const edit = (edit: ObjectEdit) => editor.execute("object.edit", objectEditRequest(editor.objectSelection!, edit)).accepted;
  return { editor, doc, bytes, pick, edit, confirm, ...control };
}

const props = (doc: RhwpDocument, control: number) => JSON.parse(doc.getShapeProperties!(0, 0, control));

function hwpShapeInventory(doc: RhwpDocument) {
  const controls: unknown = JSON.parse(doc.getControls!());
  if (!Array.isArray(controls)) throw new Error("HWP controls unavailable");
  const rootShapes = controls.filter((value): value is Record<string, unknown> => !!value && typeof value === "object"
    && !Array.isArray(value) && value.list === 0 && value.para === 0 && value.ctrlId === "gso");
  const indices = rootShapes.map(owner => owner.controlIndex);
  expect(new Set(indices).size).toBe(rootShapes.length);
  return rootShapes.map(owner => {
    expect(Number.isSafeInteger(owner.controlIndex)).toBe(true);
    const value = props(doc, owner.controlIndex as number) as Record<string, unknown>;
    expect(owner.props).toMatchObject({ Width: value.width, Height: value.height, TreatAsChar: value.treatAsChar ? 1 : 0 });
    const family = value.tbVerticalAlign !== undefined ? "textbox"
      : owner.userDesc === "사각형" ? "rectangle"
        : owner.userDesc === "타원" ? "ellipse"
          : owner.userDesc === "직선" ? "line" : "unknown";
    return { family, width: value.width, height: value.height, verticalAlign: value.tbVerticalAlign };
  });
}

describe("Stage 3 shapes on the Release engine", () => {
  it("inserts a rectangle and a text box, formats, moves, resizes, layers and deletes the outer shape", async () => {
    const { editor, doc, bytes, pick, edit, confirm } = await setup("hwpx");
    try {
      expect(editor.execute("insert.shape", { command: "insert.shape", kind: "rectangle" }).accepted).toBe(true);
      await confirm();
      expect(editor.execute("insert.textBox").accepted).toBe(true);
      await confirm();
      const drawn = shapes(doc);
      expect(drawn).toHaveLength(2);
      const rect = drawn.find(s => s.w > 100 && Math.abs(s.h - drawn[0]!.h) < 1 && props(doc, s.controlIdx).tbVerticalAlign === undefined)!;
      const selected = pick(rect);
      expect(selected.kind).toBe("shape");
      expect(selected.operations).toEqual(["deselect", "move", "resize", "delete", "wrap", "fill", "outline", "rotate", "zOrder"]);
      const control = rect.controlIdx;
      expect(edit({ kind: "outline", color: null })).toBe(false);
      expect(edit({ kind: "outline", color: "112233", width: 2 })).toBe(false);
      expect(edit({ kind: "fill", color: "FF8800" })).toBe(true);
      await confirm();
      expect(props(doc, control)).toMatchObject({ fillType: "solid", fillBgColor: 0x0088ff });
      pick(shapes(doc).find(s => s.controlIdx === control)!);
      expect(edit({ kind: "outline", color: "003366" })).toBe(true);
      await confirm();
      pick(shapes(doc).find(s => s.controlIdx === control)!);
      expect(edit({ kind: "rotate", degrees: 30, flipH: true, flipV: false })).toBe(true);
      await confirm();
      expect(props(doc, control)).toMatchObject({ borderColor: 0x663300, rotationAngle: 30, horzFlip: true });
      pick(shapes(doc).find(s => s.controlIdx === control)!);
      expect(edit({ kind: "rotate", degrees: 0, flipH: false, flipV: false })).toBe(true);
      await confirm();
      pick(shapes(doc).find(s => s.controlIdx === control)!);
      expect(edit({ kind: "nudge", dx: 10, dy: 5 })).toBe(true);
      await confirm();
      const moved = props(doc, control);
      expect(moved).toMatchObject({ horzOffset: 1000, vertOffset: 500 });
      pick(shapes(doc).find(s => s.controlIdx === control)!);
      expect(edit({ kind: "bounds", width: 120, height: 40 })).toBe(true);
      await confirm();
      expect(props(doc, control)).toMatchObject({ width: 12000, height: 4000, horzOffset: 1000 });
      pick(shapes(doc).find(s => s.controlIdx === control)!);
      expect(edit({ kind: "layer", front: true })).toBe(true);
      await confirm();
      expect(props(doc, control).zOrder).toBe(2);
      pick(shapes(doc).find(s => s.controlIdx === control)!);
      expect(edit({ kind: "layer", front: false })).toBe(true);
      await confirm();
      expect(props(doc, control).zOrder).toBe(0);
      pick(shapes(doc).find(s => s.controlIdx === control)!);
      expect(edit({ kind: "layer", front: false })).toBe(false);
      const exported = doc.exportHwpxWithReport();
      try {
        const report = exported.contentLoss();
        const edited = exported.takeBytes();
        expectReopenEvidence(doc, edited, report);
        const reopened = new engine.HwpDocument(edited) as RhwpDocument;
        try {
          const all = shapes(reopened).map(s => props(reopened, s.controlIdx));
          expect(all).toHaveLength(2);
          expect(all.find(p => p.tbVerticalAlign === undefined)).toMatchObject({ fillBgColor: 0x0088ff, borderColor: 0x663300, width: 12000, height: 4000, horzOffset: 1000, vertOffset: 500 });
          expect(all.some(p => p.tbVerticalAlign !== undefined)).toBe(true);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "shape-original.hwpx"), bytes);
          writeFileSync(resolve(out, "shape-edited.hwpx"), edited);
          writeFileSync(resolve(out, "shape-report.json"), report);
        }
      } finally { exported.free(); }
      // Delete the rectangle, then undo restores it with its formatting.
      const target = shapes(doc).find(s => props(doc, s.controlIdx).tbVerticalAlign === undefined)!;
      pick(target);
      expect(edit({ kind: "delete" })).toBe(true);
      await confirm();
      expect(shapes(doc)).toHaveLength(1);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(shapes(doc)).toHaveLength(2);
    } finally { editor.dispose(); }
  });

  it("changes overlapping HWPX shape z-order with hit-testing, reopen equality and undo/redo", async () => {
    const { editor, doc, pick, edit, confirm } = await setup("hwpx");
    try {
      expect(editor.execute("insert.shape", { command: "insert.shape", kind: "rectangle" }).accepted).toBe(true);
      await confirm();
      expect(editor.execute("insert.shape", { command: "insert.shape", kind: "ellipse" }).accepted).toBe(true);
      await confirm();

      const initial = shapes(doc);
      expect(initial).toHaveLength(2);
      const [first, second0] = initial as [Frame, Frame];
      // Nudge `second` partially so both an overlapping region and an exposed corner exist.
      pick(second0);
      expect(edit({ kind: "nudge", dx: 40, dy: 20 })).toBe(true);
      await confirm();
      const second = shapes(doc).find(s => s.controlIdx === second0.controlIdx)!;
      const overlapX = first.x + first.w - 5;
      const overlapY = first.y + first.h - 5;
      const exposedX = second.x + second.w - 5;
      const exposedY = second.y + second.h - 5;

      // Initially `second` has higher zOrder and wins overlapping hit-testing.
      expect(editor.pointAt(0, overlapX, overlapY, false, false, true)).toBe(true);
      expect(editor.objectSelection?.address.path).toEqual([0, 0, second.controlIdx]);

      // Send `second` to back -> `first` becomes topmost on overlap.
      expect(edit({ kind: "layer", front: false })).toBe(true);
      await confirm();
      expect(props(doc, second.controlIdx).zOrder).toBeLessThan(props(doc, first.controlIdx).zOrder);
      expect(editor.pointAt(0, overlapX, overlapY, false, false, true)).toBe(true);
      expect(editor.objectSelection?.address.path).toEqual([0, 0, first.controlIdx]);

      // Select `second` via its exposed corner and bring it back to front -> `second` wins overlap again.
      expect(editor.pointAt(0, exposedX, exposedY, false, false, true)).toBe(true);
      expect(editor.objectSelection?.address.path).toEqual([0, 0, second.controlIdx]);
      expect(edit({ kind: "layer", front: true })).toBe(true);
      await confirm();
      expect(props(doc, second.controlIdx).zOrder).toBeGreaterThan(props(doc, first.controlIdx).zOrder);
      expect(editor.pointAt(0, overlapX, overlapY, false, false, true)).toBe(true);
      expect(editor.objectSelection?.address.path).toEqual([0, 0, second.controlIdx]);

      // Send `second` to back, export HWPX and independently reopen.
      expect(edit({ kind: "layer", front: false })).toBe(true);
      await confirm();
      const exported = doc.exportHwpxWithReport();
      try {
        const bytes = exported.takeBytes();
        const report = exported.contentLoss();
        expectReopenEvidence(doc, bytes, report);
        const reopened = new engine.HwpDocument(bytes) as RhwpDocument;
        try {
          expect(reopened.getPageControlLayout!(0)).toBe(doc.getPageControlLayout!(0));
          expect(reopened.getPageLayerTree!(0)).toBe(doc.getPageLayerTree!(0));
          expect(props(reopened, second.controlIdx).zOrder).toBe(props(doc, second.controlIdx).zOrder);
          expect(props(reopened, first.controlIdx).zOrder).toBe(props(doc, first.controlIdx).zOrder);
          const reopenedShapes = shapes(reopened);
          expect(reopenedShapes.map(s => s.controlIdx)).toEqual([second.controlIdx, first.controlIdx]);
        } finally { reopened.free(); }
      } finally { exported.free(); }

      // Undo/Redo preserve stacking order transitions.
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(props(doc, second.controlIdx).zOrder).toBeGreaterThan(props(doc, first.controlIdx).zOrder);
      expect(editor.pointAt(0, overlapX, overlapY, false, false, true)).toBe(true);
      expect(editor.objectSelection?.address.path).toEqual([0, 0, second.controlIdx]);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(props(doc, second.controlIdx).zOrder).toBeLessThan(props(doc, first.controlIdx).zOrder);
      expect(editor.pointAt(0, overlapX, overlapY, false, false, true)).toBe(true);
      expect(editor.objectSelection?.address.path).toEqual([0, 0, first.controlIdx]);
    } finally { editor.dispose(); }
  });

  it("resizes an HWPX table-cell picture through its owned layout path", async () => {
    const docSource = new engine.HwpDocument(source("hwpx")) as RhwpDocument;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAADAAAABACAIAAADTQmMRAAAATklEQVR4nO3OMQ0AIBAAsVfCjH8pKMIFx9CkAjpnr69MPhASEhKqB0JCQkL1QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF4XmIMR3l0LcAAAAAElFTkSuQmCC", "base64");
    const table = JSON.parse(docSource.createTable!(0, 0, 1, 1, 2));
    const host = table.paraIdx as number, control = table.controlIdx as number;
    const path = JSON.stringify([{ controlIndex: control, cellIndex: 0, cellParaIndex: 0 }]);
    let bytes: Uint8Array;
    try {
      docSource.insertTextInCell(0, host, control, 0, 0, 0, "owned cell");
      docSource.insertTextInCell(0, host, control, 1, 0, 0, "sibling");
      expect(JSON.parse(docSource.insertPictureInCellByPath!(0, host, path, 2, png, 3600, 4800, 48, 64, "png", ""))).toMatchObject({ ok: true, controlIdx: 0 });
      bytes = docSource.exportHwpx();
    } finally { docSource.free(); }

    const { editor, doc, confirm } = await setup("hwpx", bytes);
    const picture = (file: RhwpDocument) => JSON.parse(file.getCellPictureByPath!(0, host, path, 0));
    try {
      const before = picture(doc);
      const frame = JSON.parse(doc.getPageControlLayout!(0)).controls.find((item: Frame) => item.type === "image");
      expect(frame).toBeDefined();
      expect(editor.pointAt(0, frame.x + frame.w / 2, frame.y + frame.h / 2, false, false, true)).toBe(true);
      const selected = editor.objectSelection!;
      expect(selected.operations).toEqual(["deselect", "resize"]);
      expect(editor.execute("object.edit", objectEditRequest(selected, { kind: "bounds", width: 42, height: 42 })).accepted).toBe(true);
      await confirm();
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(picture(doc)).toEqual(before);
      expect(editor.redo()).toBe(true);
      await confirm();

      const exported = doc.exportHwpxWithReport();
      try {
        const report = exported.contentLoss(), output = exported.takeBytes();
        expect(JSON.parse(report)).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(picture(reopened)).toEqual({ ...before, width: 4200, height: 4200 });
          expect(reopened.getTextInCell(0, host, control, 0, 0, 0, 10)).toBe("owned cell");
          expect(reopened.getTextInCell(0, host, control, 1, 0, 0, 7)).toBe("sibling");
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "p2-cell-picture-original.hwpx"), bytes);
          writeFileSync(resolve(out, "p2-cell-picture-edited.hwpx"), output);
          writeFileSync(resolve(out, "p2-cell-picture-report.json"), report);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("edits one owned HWPX text box with Hangul composition and paragraph alignment", async () => {
    const { editor, doc, confirm } = await setup("hwpx");
    try {
      expect(editor.execute("insert.textBox").accepted).toBe(true);
      await confirm();
      expect(editor.execute("insert.textBox").accepted).toBe(true);
      await confirm();

      const [target, sibling] = shapes(doc);
      expect(target).toBeDefined();
      expect(sibling).toBeDefined();
      const control = target!.controlIdx;
      const otherControl = sibling!.controlIdx;
      const lock = doc as RhwpDocument & { setControlLock(para: number, index: number, locked: boolean): string };
      expect(JSON.parse(lock.setControlLock(0, otherControl, true))).toMatchObject({ ok: true });
      const original = doc.exportHwpx();
      const lockedCaret = JSON.parse(doc.getCursorRectInCell(0, 0, otherControl, 0, 0, 0));
      expect(editor.pointAt(lockedCaret.pageIndex, lockedCaret.x + 1, lockedCaret.y + lockedCaret.height / 2, false)).toBe(false);
      const paragraphAt = (d: RhwpDocument, index: number) =>
        d.getTextInCell(0, 0, index, 0, 0, 0, d.getCellParagraphLength(0, 0, index, 0, 0));
      const body = doc.getTextRange(0, 0, 0, doc.getParagraphLength(0, 0));
      const cursor = JSON.parse(doc.getCursorRectInCell(0, 0, control, 0, 0, 0));
      expect(editor.pointAt(cursor.pageIndex, cursor.x + 1, cursor.y + cursor.height / 2, false)).toBe(true);
      expect(editor.enter()).toBe(false);

      editor.beginComposition();
      editor.updateComposition("하");
      editor.updateComposition("한");
      expect(editor.endComposition("한글")).toBe("한글");
      await confirm();
      expect(paragraphAt(doc, control)).toBe("한글");
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(paragraphAt(doc, control)).toBe("");
      expect(editor.redo()).toBe(true);
      await confirm();

      expect(editor.moveHorizontal(-1, true)).toBe(true);
      expect(editor.selectionRects()).not.toHaveLength(0);
      expect(editor.moveHorizontal(1, false)).toBe(true);
      expect(editor.execute("paragraph.alignCenter").accepted).toBe(true);
      await confirm();
      const alignment = (d: RhwpDocument) => JSON.parse(d.getCellParaPropertiesAt!(0, 0, control, 0, 0)).alignment;
      expect(alignment(doc)).toBe("center");
      const exported = doc.exportHwpxWithReport();
      try {
        const bytes = exported.takeBytes();
        const report = exported.contentLoss();
        expect(JSON.parse(report)).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(bytes) as RhwpDocument;
        try {
          expect(paragraphAt(reopened, control)).toBe("한글");
          expect(paragraphAt(reopened, otherControl)).toBe("");
          expect(reopened.getTextRange(0, 0, 0, reopened.getParagraphLength(0, 0))).toBe(body);
          expect(alignment(reopened)).toBe("center");
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "p2-textbox-original.hwpx"), original);
          writeFileSync(resolve(out, "p2-textbox-edited.hwpx"), bytes);
          writeFileSync(resolve(out, "p2-textbox-report.json"), report);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("edits a plain HWP text box after SAFE preflight and preserves the outer object", async () => {
    const { editor, doc, bytes, take, confirm } = await setup("hwp");
    try {
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      expect(editor.execute("insert.textBox").accepted).toBe(true);
      await confirm();
      const control = shapes(doc)[0]!.controlIdx;
      const originalWithBox = doc.exportHwp();
      const outer = props(doc, control);
      const base = doc.getTextRange(0, 0, 0, doc.getParagraphLength(0, 0));
      const at = JSON.parse(doc.getCursorRectInCell(0, 0, control, 0, 0, 0));
      expect(editor.pointAt(at.pageIndex, at.x + 1, at.y + at.height / 2, false)).toBe(true);
      expect(editor.typeText("본문과 별도")).toBe(true);
      await confirm();
      expect(editor.execute("paragraph.alignCenter").accepted).toBe(true);
      await confirm();
      const exported = doc.exportHwpWithReport();
      try {
        const report = exported.contentLoss();
        const edited = exported.takeBytes();
        expect(JSON.parse(report)).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(edited) as RhwpDocument;
        try {
          expect(reopened.getTextInCell(0, 0, control, 0, 0, 0, 6)).toBe("본문과 별도");
          expect(reopened.getTextRange(0, 0, 0, reopened.getParagraphLength(0, 0))).toBe(base);
          expect(JSON.parse(reopened.getCellParaPropertiesAt!(0, 0, control, 0, 0)).alignment).toBe("center");
          expect(props(reopened, control)).toEqual(outer);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "p2-hwp-before.hwp"), bytes);
          writeFileSync(resolve(out, "p2-hwp-existing.hwp"), originalWithBox);
          writeFileSync(resolve(out, "p2-hwp-edited.hwp"), edited);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("inserts the four supported HWP shape families after SAFE preflight and reopens them without loss", async () => {
    const { editor, doc, bytes, confirm, take, calls } = await setup("hwp");
    try {
      const baseline = hwpReopenModel(doc);
      expect(baseline.complete).toBe(true);
      const bodyText = (file: RhwpDocument) => file.getTextRange(0, 0, 0, file.getParagraphLength(0, 0));
      const originalText = bodyText(doc);
      expect(editor.execute("insert.shape", { command: "insert.shape", kind: "rectangle" }).accepted).toBe(false);
      expect(editor.execute("insert.textBox").accepted).toBe(false);
      expect(shapes(doc)).toHaveLength(0);
      expect(calls.filter(call => call.method === "commit")).toEqual([]);

      // Match the editor's normal load-time original preflight, then admit the same actions only
      // after the owned original has a SAFE verdict.
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();

      const insertShape = async (kind: "rectangle" | "ellipse" | "line") => {
        expect(editor.execute("insert.shape", { command: "insert.shape", kind }).accepted).toBe(true);
        await confirm();
      };
      await insertShape("rectangle");
      await insertShape("ellipse");
      await insertShape("line");
      expect(editor.execute("insert.textBox").accepted).toBe(true);
      await confirm();

      const liveShapes = hwpShapeInventory(doc);
      expect(liveShapes).toHaveLength(4);
      expect(liveShapes.map(shape => shape.family).sort()).toEqual(["ellipse", "line", "rectangle", "textbox"]);
      expect(liveShapes).toContainEqual({ family: "rectangle", width: 10800, height: 7200, verticalAlign: undefined });
      expect(liveShapes).toContainEqual({ family: "ellipse", width: 10800, height: 7200, verticalAlign: undefined });
      expect(liveShapes).toContainEqual({ family: "line", width: 10800, height: 100, verticalAlign: undefined });
      expect(liveShapes).toContainEqual({ family: "textbox", width: 10800, height: 7200, verticalAlign: "Center" });
      expect(bodyText(doc)).toBe(originalText);

      // Undo/Redo the most recent insertion once; each history application is its own revision.
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(hwpShapeInventory(doc).map(shape => shape.family).sort()).toEqual(["ellipse", "line", "rectangle"]);
      expect(editor.redo()).toBe(true);
      await confirm();

      const exported = doc.exportHwpWithReport();
      try {
        const report = exported.contentLoss();
        const edited = exported.takeBytes();
        expect(JSON.parse(report)).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(edited) as RhwpDocument & { getControls(): string; getTextFileText(): string };
        try {
          const reopenedModel = hwpReopenModel(reopened);
          expect(reopenedModel.complete).toBe(true);
          expect(hwpReopenEqual(hwpReopenModel(doc), reopenedModel, baseline.structure)).toBe(true);
          expect(bodyText(reopened)).toBe(originalText);
          expect(reopened.getTextFileText()).toBe(doc.getTextFileText!());
          expect(hwpShapeInventory(reopened)).toEqual(liveShapes);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "p1-shapes-original.hwp"), bytes);
          writeFileSync(resolve(out, "p1-shapes-edited.hwp"), edited);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });
});
