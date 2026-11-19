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

async function setup(format: "hwp" | "hwpx") {
  const control = controlledBackend();
  const sessions = new DocumentSessions(control.backend);
  const open = sessions.open(`/shape.${format}`);
  const sessionInfo = (patch: Parameters<typeof info>[0]) => info({ ...patch, format });
  control.take("open").reply(ok(sessionInfo({ displayName: `shape.${format}` })));
  await open;
  const bytes = source(format);
  const doc = new engine.HwpDocument(bytes) as RhwpDocument;
  const editor = new RhwpEditorSession(1, control.backend, sessions,
    async () => ({ openDocument: () => doc, memoryBytes: () => FIXED_MEMORY_BYTES }), { natural: null });
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

describe("Stage 3 HWPX shapes on the Release engine", () => {
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

  it("does not offer HWP shape insertion", async () => {
    const { editor, doc, calls } = await setup("hwp");
    try {
      expect(editor.execute("insert.shape", { command: "insert.shape", kind: "rectangle" }).accepted).toBe(false);
      expect(editor.execute("insert.textBox").accepted).toBe(false);
      expect(shapes(doc)).toHaveLength(0);
      expect(calls.filter(call => call.method === "commit")).toEqual([]);
    } finally { editor.dispose(); }
  });
});
