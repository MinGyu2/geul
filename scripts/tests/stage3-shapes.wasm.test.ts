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
import { ImeInput } from "../../src/components/Editor/rhwp/imeInput";
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
      expect(edit({ kind: "outline", color: "112233", width: 0 })).toBe(false);
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

  it("edits only the solid outline of an existing HWP polygon", async () => {
    const fixture = new engine.HwpDocument(source("hwp")) as RhwpDocument;
    let bytes: Uint8Array, control: number;
    try {
      const created = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 2, shapeType: "polygon",
        width: 10800, height: 7200, treatAsChar: false, textWrap: "Square", horzOffset: 0, vertOffset: 0,
      })));
      control = created.controlIdx;
      expect(JSON.parse(fixture.setShapeProperties!(0, 0, control, '{"textWrap":"Square","rotationAngle":30}')))
        .toMatchObject({ ok: true });
      bytes = fixture.exportHwp();
    } finally { fixture.free(); }
    const { editor, doc, pick, edit, confirm, take } = await setup("hwp", bytes);
    try {
      const baseline = hwpReopenModel(doc);
      expect(baseline.complete).toBe(true);
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      expect(pick(shapes(doc)[0]!).operations).toEqual(["deselect", "outline"]);
      const before = props(doc, control);
      expect(before.rotationAngle).toBe(30);
      expect(edit({ kind: "bounds", width: 100, height: 60 })).toBe(false);
      expect(edit({ kind: "delete" })).toBe(false);
      expect(edit({ kind: "outline", color: "334455", width: 2.45 })).toBe(true);
      await confirm();
      const expected = { ...before, borderColor: 0x554433, borderWidth: 245 };
      expect(props(doc, control)).toEqual(expected);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(props(doc, control)).toEqual(before);
      expect(editor.redo()).toBe(true);
      await confirm();
      const exported = doc.exportHwpWithReport();
      try {
        const report = exported.contentLoss(), output = exported.takeBytes();
        expectReopenEvidence(doc, output, report);
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(props(reopened, control)).toEqual(expected);
          expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "p3-polygon-original.hwp"), bytes);
          writeFileSync(resolve(out, "p3-polygon-edited.hwp"), output);
          writeFileSync(resolve(out, "p3-polygon-report.json"), report);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("reorders existing HWP basic shapes without moving their anchors", async () => {
    const fixture = new engine.HwpDocument(source("hwp")) as RhwpDocument;
    let bytes: Uint8Array;
    try {
      for (const [i, shapeType] of ["rectangle", "ellipse"].entries()) {
        const added = JSON.parse(fixture.createShapeControl!(JSON.stringify({
          sectionIdx: 0, paraIdx: 0, charOffset: 2 + i, shapeType, width: 10800, height: 7200,
          treatAsChar: false, textWrap: "Square", horzOffset: i * 4000, vertOffset: i * 2000,
        })));
        expect(JSON.parse(fixture.setShapeProperties!(0, 0, added.controlIdx, '{"textWrap":"Square"}'))).toMatchObject({ ok: true });
      }
      bytes = fixture.exportHwp();
    } finally { fixture.free(); }
    const { editor, doc, pick, edit, confirm, take, calls } = await setup("hwp", bytes);
    try {
      const baseline = hwpReopenModel(doc);
      expect(baseline.complete).toBe(true);
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      const [first, second] = shapes(doc) as [Frame, Frame];
      const a = props(doc, first.controlIdx), b = props(doc, second.controlIdx);
      const overlap = [first.x + first.w - 10, first.y + first.h - 10] as const;
      const top = () => {
        expect(editor.pointAt(0, ...overlap, false, false, true)).toBe(true);
        return editor.objectSelection?.address.path;
      };
      expect(top()).toEqual([0, 0, second.controlIdx]);
      expect(editor.objectSelection!.operations).toContain("zOrder");
      expect(edit({ kind: "layer", front: false })).toBe(true);
      await confirm();
      const lowered = { ...b, zOrder: a.zOrder - 1 };
      expect(props(doc, second.controlIdx)).toEqual(lowered);
      expect(props(doc, first.controlIdx)).toEqual(a);
      expect(top()).toEqual([0, 0, first.controlIdx]);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(top()).toEqual([0, 0, second.controlIdx]);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(top()).toEqual([0, 0, first.controlIdx]);
      const exported = doc.exportHwpWithReport();
      try {
        const report = exported.contentLoss(), output = exported.takeBytes();
        expectReopenEvidence(doc, output, report);
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
          expect(props(reopened, first.controlIdx)).toEqual(a);
          expect(props(reopened, second.controlIdx)).toEqual(lowered);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "p3-layer-original.hwp"), bytes);
          writeFileSync(resolve(out, "p3-layer-edited.hwp"), output);
          writeFileSync(resolve(out, "p3-layer-report.json"), report);
        }
      } finally { exported.free(); }
      const exposed = shapes(doc).find(frame => frame.controlIdx === second.controlIdx)!;
      expect(editor.pointAt(0, exposed.x + exposed.w - 4, exposed.y + exposed.h - 4, false, false, true)).toBe(true);
      expect(editor.objectSelection?.address.path).toEqual([0, 0, second.controlIdx]);
      expect(edit({ kind: "layer", front: false })).toBe(false);
      expect(calls.filter(call => call.method === "commit")).toEqual([]);
      expect(edit({ kind: "layer", front: true })).toBe(true);
      await confirm();
      expect(top()).toEqual([0, 0, second.controlIdx]);
      const owner = pick(second);
      const lock = doc as RhwpDocument & { setControlLock(para: number, index: number, locked: boolean): string };
      expect(JSON.parse(lock.setControlLock(0, first.controlIdx, true))).toMatchObject({ ok: true });
      expect(editor.execute("object.edit", objectEditRequest(owner, { kind: "layer", front: false })).accepted).toBe(false);
    } finally { editor.dispose(); }
  });

  it("saves a newly inserted HWP rectangle with an edited outline width", async () => {
    const { editor, doc, bytes, take, confirm, pick, edit } = await setup("hwp");
    try {
      const original = hwpReopenModel(doc);
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      expect(editor.execute("insert.shape", { command: "insert.shape", kind: "rectangle" }).accepted).toBe(true);
      await confirm();
      const frame = shapes(doc)[0]!;
      const before = props(doc, frame.controlIdx);
      expect(pick(frame).shape?.outlineWidthEditable).toBe(true);
      expect(edit({ kind: "outline", color: "000000", width: 2.45 })).toBe(true);
      await confirm();
      const expected = { ...before, borderWidth: 245 };
      expect(props(doc, frame.controlIdx)).toEqual(expected);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(props(doc, frame.controlIdx)).toEqual(before);
      expect(editor.redo()).toBe(true);
      await confirm();
      const exported = doc.exportHwpWithReport();
      try {
        const edited = exported.takeBytes(), report = exported.contentLoss();
        expectReopenEvidence(doc, edited, report);
        const reopened = new engine.HwpDocument(edited) as RhwpDocument;
        try {
          expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), original.structure)).toBe(true);
          expect(props(reopened, frame.controlIdx)).toEqual(expected);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "combined-outline-original.hwp"), bytes);
          writeFileSync(resolve(out, "combined-outline-edited.hwp"), edited);
          writeFileSync(resolve(out, "combined-outline-report.json"), report);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it.each(["hwp", "hwpx"] as const)("persists an existing %s solid outline width", async format => {
    const originalDoc = new engine.HwpDocument(source(format)) as RhwpDocument;
    let original: Uint8Array;
    try {
      const created = JSON.parse(originalDoc.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 0, shapeType: "rectangle", width: 10800, height: 7200,
        treatAsChar: false, textWrap: "Square", horzOffset: 0, vertOffset: 0,
      })));
      expect(JSON.parse(originalDoc.setShapeProperties!(0, 0, created.controlIdx, '{"textWrap":"Square"}'))).toMatchObject({ ok: true });
      original = format === "hwp" ? originalDoc.exportHwp() : originalDoc.exportHwpx();
    } finally { originalDoc.free(); }

    const { editor, doc, pick, edit, confirm, take } = await setup(format, original);
    try {
      if (format === "hwp") {
        take("original").reply(ok(original));
        await flush();
        take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
        await flush();
      }
      const frame = shapes(doc)[0]!, before = props(doc, frame.controlIdx);
      expect(pick(frame).shape?.outlineWidthEditable).toBe(true);
      expect(edit({ kind: "outline", color: "000000", width: 0 })).toBe(false);
      expect(edit({ kind: "outline", color: "000000", width: 2.45 })).toBe(true);
      await confirm();
      expect(props(doc, frame.controlIdx)).toEqual({ ...before, borderWidth: 245 });
      const exported = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
      try {
        const output = exported.takeBytes(), report = exported.contentLoss();
        expect(JSON.parse(report)).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try { expect(props(reopened, frame.controlIdx)).toEqual({ ...before, borderWidth: 245 }); }
        finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, `p3-width-original.${format}`), original);
          writeFileSync(resolve(out, `p3-width-edited.${format}`), output);
          writeFileSync(resolve(out, `p3-width-${format}-report.json`), report);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it.each(["hwp", "hwpx"] as const)("resizes an %s table-cell picture through its owned layout path", async format => {
    const docSource = new engine.HwpDocument(source(format)) as RhwpDocument;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAADAAAABACAIAAADTQmMRAAAATklEQVR4nO3OMQ0AIBAAsVfCjH8pKMIFx9CkAjpnr69MPhASEhKqB0JCQkL1QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF4XmIMR3l0LcAAAAAElFTkSuQmCC", "base64");
    const table = JSON.parse(docSource.createTable!(0, 0, 1, 1, 2));
    const host = table.paraIdx as number, control = table.controlIdx as number;
    const path = JSON.stringify([{ controlIndex: control, cellIndex: 0, cellParaIndex: 0 }]);
    let bytes: Uint8Array;
    try {
      docSource.insertTextInCell(0, host, control, 0, 0, 0, "owned cell");
      docSource.insertTextInCell(0, host, control, 1, 0, 0, "sibling");
      expect(JSON.parse(docSource.insertPictureInCellByPath!(0, host, path, 2, png, 3600, 4800, 48, 64, "png", ""))).toMatchObject({ ok: true, controlIdx: 0 });
      bytes = format === "hwp" ? docSource.exportHwp() : docSource.exportHwpx();
    } finally { docSource.free(); }

    const { editor, doc, confirm, take } = await setup(format, bytes);
    const picture = (file: RhwpDocument) => JSON.parse(file.getCellPictureByPath!(0, host, path, 0));
    try {
      const baseline = format === "hwp" ? hwpReopenModel(doc) : null;
      if (baseline) {
        expect(baseline.complete).toBe(true);
        take("original").reply(ok(bytes));
        await flush();
        take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
        await flush();
      }
      const before = picture(doc);
      const frame = JSON.parse(doc.getPageControlLayout!(0)).controls.find((item: Frame) => item.type === "image");
      expect(frame).toBeDefined();
      expect(editor.pointAt(0, frame.x + frame.w / 2, frame.y + frame.h / 2, false, false, true)).toBe(true);
      const selected = editor.objectSelection!;
      expect(selected.operations).toEqual(
        format === "hwpx" ? ["deselect", "resize", "delete", "crop", "altText"] : ["deselect", "resize"],
      );
      expect(editor.execute("object.edit", objectEditRequest(selected, { kind: "bounds", width: 42, height: 42 })).accepted).toBe(true);
      await confirm();
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(picture(doc)).toEqual(before);
      expect(editor.redo()).toBe(true);
      await confirm();

      const exported = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
      try {
        const report = exported.contentLoss(), output = exported.takeBytes();
        expect(JSON.parse(report)).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          if (baseline) {
            expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
          }
          expect(picture(reopened)).toEqual({ ...before, width: 4200, height: 4200 });
          expect(reopened.getTextInCell(0, host, control, 0, 0, 0, 10)).toBe("owned cell");
          expect(reopened.getTextInCell(0, host, control, 1, 0, 0, 7)).toBe("sibling");
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, `p2-cell-picture-original.${format}`), bytes);
          writeFileSync(resolve(out, `p2-cell-picture-edited.${format}`), output);
          writeFileSync(resolve(out, `p2-cell-picture-${format}-report.json`), report);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it.each(["hwp", "hwpx"] as const)("resizes a depth-2 nested %s table-cell picture through its multi-level owned layout path", async format => {
    const docSource = new engine.HwpDocument(source(format)) as RhwpDocument;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAADAAAABACAIAAADTQmMRAAAATklEQVR4nO3OMQ0AIBAAsVfCjH8pKMIFx9CkAjpnr69MPhASEhKqB0JCQkL1QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF4XmIMR3l0LcAAAAAElFTkSuQmCC", "base64");
    const outer = JSON.parse(docSource.createTable!(0, 0, 1, 1, 2));
    const host = outer.paraIdx as number, outerCtrl = outer.controlIdx as number;
    const cell0Path = JSON.stringify([{ controlIndex: outerCtrl, cellIndex: 0, cellParaIndex: 0 }]);
    const inner = JSON.parse(docSource.createTableInCellByPath!(0, host, cell0Path, 0, 1, 2));
    const innerCtrl = inner.controlIdx as number;
    const nestedPath = JSON.stringify([
      { controlIndex: outerCtrl, cellIndex: 0, cellParaIndex: 0 },
      { controlIndex: innerCtrl, cellIndex: 0, cellParaIndex: 0 },
    ]);
    let bytes: Uint8Array;
    try {
      docSource.insertTextInCellByPath!(0, host, nestedPath, 0, "deep cell");
      docSource.insertTextInCell(0, host, outerCtrl, 1, 0, 0, "outer sibling");
      expect(JSON.parse(docSource.insertPictureInCellByPath!(0, host, nestedPath, 2, png, 3000, 2400, 48, 64, "png", ""))).toMatchObject({ ok: true, controlIdx: 0 });
      bytes = format === "hwp" ? docSource.exportHwp() : docSource.exportHwpx();
    } finally { docSource.free(); }

    const { editor, doc, confirm, take } = await setup(format, bytes);
    const picture = (file: RhwpDocument) => JSON.parse(file.getCellPictureByPath!(0, host, nestedPath, 0));
    try {
      const baseline = hwpReopenModel(doc);
      expect(baseline.complete).toBe(true);
      if (format === "hwp") {
        take("original").reply(ok(bytes));
        await flush();
        take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
        await flush();
      }
      const before = picture(doc);
      const frame = JSON.parse(doc.getPageControlLayout!(0)).controls.find((item: Frame) => item.type === "image");
      expect(frame).toBeDefined();
      expect(editor.pointAt(0, frame.x + frame.w / 2, frame.y + frame.h / 2, false, false, true)).toBe(true);
      const selected = editor.objectSelection!;
      expect(selected.operations).toEqual(
        format === "hwpx" ? ["deselect", "resize", "delete", "crop", "altText"] : ["deselect", "resize"],
      );
      expect(editor.execute("object.edit", objectEditRequest(selected, { kind: "bounds", width: 42, height: 36 })).accepted).toBe(true);
      await confirm();
      expect(picture(doc)).toEqual({ ...before, width: 4200, height: 3600 });
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(picture(doc)).toEqual(before);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(picture(doc)).toEqual({ ...before, width: 4200, height: 3600 });

      const exported = format === "hwp" ? doc.exportHwpWithReport!() : doc.exportHwpxWithReport!();
      try {
        const report = exported.contentLoss(), output = exported.takeBytes();
        expect(JSON.parse(report)).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
          expect(picture(reopened)).toEqual({ ...before, width: 4200, height: 3600 });
          expect(reopened.getTextInCellByPath!(0, host, nestedPath, 0, 9)).toBe("deep cell");
          expect(reopened.getTextInCell(0, host, outerCtrl, 1, 0, 0, 13)).toBe("outer sibling");
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, `p2-nested-cell-picture-original.${format}`), bytes);
          writeFileSync(resolve(out, `p2-nested-cell-picture-edited.${format}`), output);
          writeFileSync(resolve(out, `p2-nested-cell-picture-${format}-report.json`), report);
        }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("edits crop, altText, and deletion on an HWPX table-cell picture with undo, redo, and reopen", async () => {
    const docSource = new engine.HwpDocument(source("hwpx")) as RhwpDocument;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAADAAAABACAIAAADTQmMRAAAATklEQVR4nO3OMQ0AIBAAsVfCjH8pKMIFx9CkAjpnr69MPhASEhKqB0JCQkL1QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF4XmIMR3l0LcAAAAAElFTkSuQmCC", "base64");
    const table = JSON.parse(docSource.createTable!(0, 0, 1, 1, 2));
    const host = table.paraIdx as number, control = table.controlIdx as number;
    const path = JSON.stringify([{ controlIndex: control, cellIndex: 0, cellParaIndex: 0 }]);
    let bytes: Uint8Array;
    try {
      docSource.insertTextInCell(0, host, control, 0, 0, 0, "hwpx cell");
      expect(JSON.parse(docSource.insertPictureInCellByPath!(0, host, path, 2, png, 3600, 4800, 48, 64, "png", ""))).toMatchObject({ ok: true, controlIdx: 0 });
      bytes = docSource.exportHwpx();
    } finally { docSource.free(); }

    const { editor, doc, confirm } = await setup("hwpx", bytes);
    const props = (d: RhwpDocument) => JSON.parse(d.getCellPicturePropertiesByPath!(0, host, path, 0));
    const imageFrame = () => JSON.parse(doc.getPageControlLayout!(0)).controls.find((item: Frame) => item.type === "image") as Frame | undefined;
    try {
      const baseline = hwpReopenModel(doc);
      expect(baseline.complete).toBe(true);
      const selectCellPic = () => {
        const frame = imageFrame()!;
        expect(frame).toBeDefined();
        expect(editor.pointAt(0, frame.x + frame.w / 2, frame.y + frame.h / 2, false, false, true)).toBe(true);
        return editor.objectSelection!;
      };
      expect(editor.execute("object.edit", objectEditRequest(selectCellPic(), { kind: "altText", text: "셀 그림 설명" })).accepted).toBe(true);
      await confirm();
      expect(editor.execute("object.edit", objectEditRequest(selectCellPic(), { kind: "crop", left: 0.1, top: 0, right: 0.2, bottom: 0 })).accepted).toBe(true);
      await confirm();
      expect(props(doc)).toMatchObject({ description: "셀 그림 설명" });
      expect(props(doc).cropLeft).toBeGreaterThan(0);

      const exportedEdited = doc.exportHwpxWithReport!();
      try {
        const editedBytes = exportedEdited.takeBytes();
        expect(JSON.parse(exportedEdited.contentLoss())).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(editedBytes) as RhwpDocument;
        try {
          expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
          expect(props(reopened)).toMatchObject({ description: "셀 그림 설명", cropLeft: props(doc).cropLeft, cropRight: props(doc).cropRight });
        } finally { reopened.free(); }
      } finally { exportedEdited.free(); }

      expect(editor.execute("object.edit", objectEditRequest(selectCellPic(), { kind: "delete" })).accepted).toBe(true);
      await confirm();
      expect(imageFrame()).toBeUndefined();
      const exportedDeleted = doc.exportHwpxWithReport!();
      try {
        const deletedBytes = exportedDeleted.takeBytes();
        expect(JSON.parse(exportedDeleted.contentLoss())).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(deletedBytes) as RhwpDocument;
        try {
          expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
          expect(JSON.parse(reopened.getPageControlLayout!(0)).controls.some((c: { type: string }) => c.type === "image")).toBe(false);
        } finally { reopened.free(); }
      } finally { exportedDeleted.free(); }

      expect(editor.undo()).toBe(true);
      await confirm();
      expect(imageFrame()).toBeDefined();
      expect(props(doc)).toMatchObject({ description: "셀 그림 설명" });
    } finally { editor.dispose(); }
  });

  it("requires an explicit HWP GSO unlock and preserves independent size protection", async () => {
    const { editor, doc, bytes, take, confirm, pick, edit, calls } = await setup("hwp");
    try {
      take("original").reply(ok(bytes));
      await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();
      expect(editor.execute("insert.shape", { command: "insert.shape", kind: "rectangle" }).accepted).toBe(true);
      await confirm();
      const frame = shapes(doc)[0]!, index = frame.controlIdx;
      const inventory = doc.getControls!.bind(doc);
      const lock = (locked: boolean) => {
        const controls = doc as RhwpDocument & { setControlLock(para: number, index: number, locked: boolean): string };
        expect(JSON.parse(controls.setControlLock(0, index, locked))).toMatchObject({ ok: true });
      };
      expect(JSON.parse(inventory()).find((c: { controlIndex: number }) => c.controlIndex === index)?.props.Lock).toBe(0);
      expect(pick(frame).operations).toContain("resize");
      lock(true);
      expect(JSON.parse(inventory()).find((c: { controlIndex: number }) => c.controlIndex === index)?.props.Lock).toBe(1);
      expect(edit({ kind: "bounds", width: 90, height: 60 })).toBe(false);
      expect(pick(frame).operations).toEqual(["deselect"]);
      lock(false);
      for (const props of [undefined, {}, { Lock: 2 }, { Lock: false }, { Lock: "0" }]) {
        expect(pick(frame).operations).toContain("outline");
        doc.getControls = () => JSON.stringify(JSON.parse(inventory()).map((c: { ctrlId: string }) =>
          c.ctrlId === "gso" ? { ...c, props } : c));
        expect(edit({ kind: "outline", color: "333333" })).toBe(false);
        expect(pick(frame).operations).toEqual(["deselect"]);
        doc.getControls = inventory;
      }
      expect(JSON.parse(doc.setShapeProperties!(0, 0, index, '{"sizeProtect":true}'))).toMatchObject({ ok: true });
      expect(props(doc, index).sizeProtect).toBe(true);
      const protectedFrame = shapes(doc)[0]!;
      expect(pick(protectedFrame).operations).toContain("outline");
      expect(editor.objectSelection!.operations).not.toContain("resize");
      expect(edit({ kind: "bounds", width: 90, height: 60 })).toBe(false);
      expect(calls.filter(call => call.method === "commit")).toEqual([]);
      expect(edit({ kind: "outline", color: "333333" })).toBe(true);
      await confirm();
    } finally { editor.dispose(); }
  });

  it("binds delayed text-box IME commits to one live owner", async () => {
    const { editor, doc, confirm, calls } = await setup("hwpx");
    try {
      for (let i = 0; i < 2; i++) {
        expect(editor.execute("insert.textBox").accepted).toBe(true);
        await confirm();
      }
      const [first, second] = shapes(doc).map(frame => frame.controlIdx);
      const moveToBox = (index: number) => {
        const cursor = JSON.parse(doc.getCursorRectInCell(0, 0, index, 0, 0, 0));
        expect(editor.pointAt(cursor.pageIndex, cursor.x + 1, cursor.y + cursor.height / 2, false)).toBe(true);
      };
      const contents = (index: number) =>
        doc.getTextInCell(0, 0, index, 0, 0, 0, doc.getCellParagraphLength(0, 0, index, 0, 0));
      const ime = new ImeInput(editor);
      moveToBox(first!);
      ime.pointerDown();
      moveToBox(second!);
      ime.input("한", "insertFromComposition", false);
      ime.compositionEnd("한");
      ime.compositionEnd("한");
      await confirm();
      expect(contents(first!)).toBe("한");
      expect(contents(second!)).toBe("");
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(contents(first!)).toBe("");
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(contents(first!)).toBe("한");

      moveToBox(first!);
      const lockedTarget = editor.markCaret();
      moveToBox(second!);
      const locks = doc as RhwpDocument & { setControlLock(para: number, index: number, locked: boolean): string };
      expect(JSON.parse(locks.setControlLock(0, first!, true))).toMatchObject({ ok: true });
      const beforeRefusal = editor.localRevision;
      expect(editor.insertCommittedAt(lockedTarget, "글")).toBe(false);
      expect(contents(first!)).toBe("한");
      expect(contents(second!)).toBe("");

      const cancelled = new ImeInput(editor);
      cancelled.pointerDown();
      cancelled.compositionEnd("");
      expect(editor.localRevision).toBe(beforeRefusal);
      expect(calls.filter(call => call.method === "commit")).toEqual([]);

      const staleTarget = editor.markCaret();
      expect(editor.typeText("새")).toBe(true);
      await confirm();
      expect(editor.insertCommittedAt(staleTarget, "옛")).toBe(false);
      expect(contents(second!)).toBe("새");

      moveToBox(second!);
      const removedTarget = editor.markCaret();
      {
        const frame = shapes(doc).find(item => item.controlIdx === second)!;
        expect(editor.pointAt(0, frame.x + frame.w / 2, frame.y + frame.h / 2, false, false, true)).toBe(true);
        expect(editor.execute("object.edit", objectEditRequest(editor.objectSelection!, { kind: "delete" })).accepted).toBe(true);
        await confirm();
      }
      expect(editor.insertCommittedAt(removedTarget, "옛")).toBe(false);
      expect(shapes(doc).map(frame => frame.controlIdx)).toHaveLength(1);

      const finalTarget = editor.markCaret();
      const other = await setup("hwpx");
      try { expect(other.editor.insertCommittedAt(finalTarget, "옛")).toBe(false); }
      finally { other.editor.dispose(); }
      editor.dispose();
      expect(editor.insertCommittedAt(finalTarget, "옛")).toBe(false);
    } finally { editor.dispose(); }
  });

  it.each(["hwp", "hwpx"] as const)("edits the second existing paragraph of an owned %s text box", async format => {
    const fixture = new engine.HwpDocument(source(format)) as RhwpDocument;
    let bytes: Uint8Array, control: number;
    try {
      const created = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 2, shapeType: "textbox",
        width: 10800, height: 7200, treatAsChar: true, textWrap: "Square", horzOffset: 0, vertOffset: 0,
      })));
      control = created.controlIdx;
      fixture.insertTextInCell(0, 0, control, 0, 0, 0, "first");
      fixture.splitParagraphInCell(0, 0, control, 0, 0, 5);
      fixture.insertTextInCell(0, 0, control, 0, 1, 0, "second");
      bytes = format === "hwp" ? fixture.exportHwp() : fixture.exportHwpx();
    } finally { fixture.free(); }
    const { editor, doc, take, confirm, calls } = await setup(format, bytes);
    const paragraphs = (file: RhwpDocument) => [0, 1].map(p =>
      file.getTextInCell(0, 0, control, 0, p, 0, file.getCellParagraphLength(0, 0, control, 0, p)));
    try {
      const baseline = format === "hwp" ? hwpReopenModel(doc) : null;
      if (baseline) {
        expect(baseline.complete).toBe(true);
        take("original").reply(ok(bytes));
        await flush();
        take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
        await flush();
      }
      const cursor = JSON.parse(doc.getCursorRectInCell(0, 0, control, 0, 1, 0));
      expect(editor.pointAt(cursor.pageIndex, cursor.x + 1, cursor.y + cursor.height / 2, false)).toBe(true);
      expect(editor.caret.cell?.cellParagraph).toBe(1);
      expect(editor.enter()).toBe(false);
      expect(editor.backspace()).toBe(false); // No implicit join at the paragraph boundary.
      expect(calls.filter(call => call.method === "commit")).toEqual([]);
      expect(editor.typeText("새 ")).toBe(true);
      await confirm();
      expect(paragraphs(doc)).toEqual(["first", "새 second"]);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(paragraphs(doc)).toEqual(["first", "second"]);
      expect(editor.redo()).toBe(true);
      await confirm();
      const exported = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
      try {
        const output = exported.takeBytes(), report = exported.contentLoss();
        expectReopenEvidence(doc, output, report);
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(paragraphs(reopened)).toEqual(["first", "새 second"]);
          if (baseline) expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, `p2-multipara-original.${format}`), bytes);
          writeFileSync(resolve(out, `p2-multipara-edited.${format}`), output);
          writeFileSync(resolve(out, `p2-multipara-${format}-report.json`), report);
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
