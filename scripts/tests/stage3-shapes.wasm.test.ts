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
import { documentCommandState } from "../../src/commands/capability";
import type { PlainClipboard } from "../../src/commands/clipboard";
import { OBJECT_CLIPBOARD_MIME, createRichObjectClipboardPayload, parseObjectClipboardPayload } from "../../src/commands/objectClipboard";
import { objectEditRequest, type ObjectEdit } from "../../src/commands/objectSelection";
import { clearStructuredClipboard } from "../../src/commands/tableClipboard";
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
      expect(selected.operations).toEqual(["deselect", "move", "resize", "delete", "wrap", "fill", "outline", "rotate", "zOrder", "copy", "cut"]);
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

  it("edits an existing HWP polygon outline and geometry cleanly while keeping T009 outline fixtures", async () => {
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
      const ops = pick(shapes(doc)[0]!).operations;
      expect(ops).toContain("outline");
      expect(ops).toContain("resize");
      expect(ops).toContain("rotate");
      expect(ops).toContain("fill");
      expect(ops).toContain("wrap");
      expect(ops).toContain("delete");
      const before = props(doc, control);
      expect(before.rotationAngle).toBe(30);
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

  it.each(["hwp", "hwpx"] as const)("edits %s polygon and curve outer geometry, transforms, and deletion cleanly", async format => {
    const fixture = new engine.HwpDocument(source(format)) as RhwpDocument;
    let baseHwpx: Uint8Array;
    try {
      const created = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 2, shapeType: "polygon",
        width: 10800, height: 7200, treatAsChar: false, textWrap: "Square", horzOffset: 0, vertOffset: 0,
      })));
      expect(JSON.parse(fixture.setShapeProperties!(0, 0, created.controlIdx, '{"textWrap":"Square"}')))
        .toMatchObject({ ok: true });
      baseHwpx = fixture.exportHwpx();
    } finally { fixture.free(); }

    // Turn the polygon copy into a document holding BOTH an unlocked polygon and an unlocked curve.
    const tmpDir = mkdirSync(resolve("/tmp", `geul-p3-curve-${format}-${Date.now()}`), { recursive: true })!;
    const inZip = resolve(tmpDir, "in.hwpx");
    const outZip = resolve(tmpDir, "out.hwpx");
    writeFileSync(inZip, baseHwpx);
    const { execFileSync } = await import("node:child_process");
    execFileSync("python3", ["-c", `import sys, zipfile, re
with zipfile.ZipFile(sys.argv[1]) as zin:
    items = [(i.filename, zin.read(i.filename)) for i in zin.infolist()]
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as zout:
    for name, data in items:
        if name == 'Contents/section0.xml':
            xml = data.decode('utf-8')
            m = re.search(r'<hp:polygon\\b.*?</hp:polygon>', xml, re.S)
            assert m, 'missing polygon'
            poly = re.sub(r'zOrder="[^"]*"', 'zOrder="1"', m.group(0), count=1)
            curve = re.sub(r'^<hp:polygon\\b', '<hp:curve', poly, count=1)
            curve = re.sub(r'</hp:polygon>$', '</hp:curve>', curve, count=1)
            curve = re.sub(r'id="\\d+"', 'id="999001"', curve, count=1)
            curve = re.sub(r'zOrder="[^"]*"', 'zOrder="2"', curve, count=1)
            curve = re.sub(r'<hp:offset\\b[^>]*/>', '<hp:offset x="15000" y="0"/>', curve, count=1)
            segs = '<hp:seg type="CURVE" x1="0" y1="0" x2="10800" y2="7200"/><hp:seg type="CURVE" x1="10800" y1="7200" x2="0" y2="7200"/>'
            curve = re.sub(r'(?:<hc:pt\\b[^>]*/>)+', segs, curve, count=1)
            assert '<hp:seg ' in curve, 'failed to inject curve segs'
            xml = xml.replace(m.group(0), poly + curve, 1)
            data = xml.encode('utf-8')
        zout.writestr(name, data)
`, inZip, outZip]);
    const hwpxWithBoth = new Uint8Array(readFileSync(outZip));
    let bytes: Uint8Array;
    const converter = new engine.HwpDocument(hwpxWithBoth) as RhwpDocument;
    try {
      const gsoIndices = (JSON.parse(converter.getControls!()) as { list: number; para: number; ctrlId: string; controlIndex: number }[])
        .filter(c => c.list === 0 && c.para === 0 && c.ctrlId === "gso")
        .map(c => c.controlIndex);
      expect(gsoIndices).toHaveLength(2);
      expect(JSON.parse(converter.setShapeProperties!(0, 0, gsoIndices[1]!, '{"textWrap":"Square"}'))).toMatchObject({ ok: true });
      if (format === "hwp") {
        // Canonical HWP5 curve serialization writes `cnt - 1` segment_types when section raw_stream is rebuilt.
        const hwpOnce = converter.exportHwp();
        const canonical = new engine.HwpDocument(hwpOnce) as RhwpDocument;
        try {
          expect(JSON.parse(canonical.setShapeProperties!(0, 0, gsoIndices[1]!, '{"horzOffset":20000,"vertOffset":12000}'))).toMatchObject({ ok: true });
          bytes = canonical.exportHwp();
        } finally { canonical.free(); }
      } else {
        expect(JSON.parse(converter.setShapeProperties!(0, 0, gsoIndices[1]!, '{"horzOffset":20000,"vertOffset":12000}'))).toMatchObject({ ok: true });
        bytes = converter.exportHwpx();
      }
    } finally { converter.free(); }

    const { editor, doc, pick, edit, confirm, take } = await setup(format, bytes);
    try {
      const baseline = hwpReopenModel(doc);
      expect(baseline.complete).toBe(true);
      if (format === "hwp") {
        take("original").reply(ok(bytes));
        await flush();
        take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
        await flush();
      }
      const frames = shapes(doc);
      expect(frames).toHaveLength(2);
      const polyIdx = frames[0]!.controlIdx;
      const curveIdx = frames[1]!.controlIdx;
      const frameOf = (index: number) => shapes(doc).find(f => f.controlIdx === index)!;
      for (const index of [polyIdx, curveIdx]) {
        const sel = pick(frameOf(index));
        expect(sel.operations).toEqual(expect.arrayContaining(["move", "resize", "delete", "wrap", "fill", "outline", "rotate", "zOrder"]));
      }

      // Edit curve geometry, rotation/flip, fill, and outline; verify exact preservation + Undo/Redo.
      pick(frameOf(curveIdx));
      const beforeCurve = props(doc, curveIdx);
      expect(edit({ kind: "bounds", width: 150, height: 90 })).toBe(true);
      await confirm();
      pick(frameOf(curveIdx));
      expect(edit({ kind: "nudge", dx: 12, dy: 8 })).toBe(true);
      await confirm();
      pick(frameOf(curveIdx));
      expect(edit({ kind: "rotate", degrees: 45, flipH: true, flipV: false })).toBe(true);
      await confirm();
      pick(frameOf(curveIdx));
      expect(edit({ kind: "fill", color: "2288CC" })).toBe(true);
      await confirm();
      pick(frameOf(curveIdx));
      expect(edit({ kind: "outline", color: "AA3311", width: 1.5 })).toBe(true);
      await confirm();

      const expectedCurve = {
        ...beforeCurve,
        width: 15000,
        height: 9000,
        horzOffset: beforeCurve.horzOffset + 1200,
        vertOffset: beforeCurve.vertOffset + 800,
        rotationAngle: 45,
        horzFlip: true,
        vertFlip: false,
        fillType: "solid",
        fillBgColor: 0xCC8822,
        borderColor: 0x1133AA,
        borderWidth: 150,
      };
      expect(props(doc, curveIdx)).toEqual(expectedCurve);

      // Edit polygon wrap cleanly, and verify geometry+transform+style+wrap save & reopen BEFORE layer reordering.
      pick(frameOf(polyIdx));
      expect(edit({ kind: "wrap", wrap: "topAndBottom" })).toBe(true);
      await confirm();

      expect(editor.undo()).toBe(true);
      await confirm();
      expect(editor.redo()).toBe(true);
      await confirm();

      const exported = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
      const liveCurve = props(doc, curveIdx);
      expect(liveCurve).toMatchObject(expectedCurve);
      try {
        const report = exported.contentLoss(), output = exported.takeBytes();
        expectReopenEvidence(doc, output, report);
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
          expect(props(reopened, curveIdx)).toEqual(liveCurve);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, `p3-poly-curve-original.${format}`), bytes);
          writeFileSync(resolve(out, `p3-poly-curve-edited.${format}`), output);
          writeFileSync(resolve(out, `p3-poly-curve-report.${format}.json`), report);
        }
      } finally { exported.free(); }

      // Restore Square wrap plane so both shapes share one HWP drawing plane, then test zOrder front/undo.
      pick(frameOf(polyIdx));
      expect(edit({ kind: "wrap", wrap: "square" })).toBe(true);
      await confirm();
      pick(frameOf(polyIdx));
      expect(edit({ kind: "layer", front: true })).toBe(true);
      await confirm();
      expect(editor.undo()).toBe(true);
      await confirm();

      // Delete the curve and verify Undo restores both shapes.
      pick(frameOf(curveIdx));
      expect(edit({ kind: "delete" })).toBe(true);
      await confirm();
      expect(shapes(doc)).toHaveLength(1);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(shapes(doc)).toHaveLength(2);
    } finally {
      editor.dispose();
    }
  });

  it.each(["hwp", "hwpx"] as const)("edits outer geometry, position, and wrap of an existing %s group while keeping children intact", async format => {
    const fixture = new engine.HwpDocument(source(format)) as RhwpDocument & {
      groupShapes(json: string): string;
    };
    let bytes: Uint8Array, groupControl: number;
    try {
      const rect = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 2, shapeType: "rectangle",
        width: 5000, height: 4000, treatAsChar: false, textWrap: "Square", horzOffset: 0, vertOffset: 0,
      })));
      const ell = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 3, shapeType: "ellipse",
        width: 5000, height: 4000, treatAsChar: false, textWrap: "Square", horzOffset: 6000, vertOffset: 1000,
      })));
      const grouped = JSON.parse(fixture.groupShapes(JSON.stringify({
        sectionIdx: 0,
        targets: [{ paraIdx: 0, controlIdx: rect.controlIdx }, { paraIdx: 0, controlIdx: ell.controlIdx }],
      })));
      expect(grouped).toMatchObject({ ok: true });
      groupControl = grouped.controlIdx;
      expect(JSON.parse(fixture.setShapeProperties!(0, 0, groupControl, '{"textWrap":"Square","horzOffset":500,"vertOffset":500}'))).toMatchObject({ ok: true });
      bytes = format === "hwp" ? fixture.exportHwp() : fixture.exportHwpx();
    } finally { fixture.free(); }

    const { editor, doc, edit, confirm, take } = await setup(format, bytes);
    try {
      const baseline = hwpReopenModel(doc);
      expect(baseline.complete).toBe(true);
      if (format === "hwp") {
        take("original").reply(ok(bytes));
        await flush();
        take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
        await flush();
      }
      const groupFrame = () => (JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[]).find(c => c.type === "group")!;
      const pickGroup = () => {
        const frame = groupFrame();
        expect(frame).toBeDefined();
        expect(editor.pointAt(0, frame.x + frame.w / 2, frame.y + frame.h / 2, false, false, true)).toBe(true);
        return editor.objectSelection!;
      };
      const sel = pickGroup();
      expect(sel.kind).toBe("group");
      expect(sel.operations).toContain("move");
      expect(sel.operations).toContain("resize");
      expect(sel.operations).toContain("wrap");
      if (format === "hwpx") {
        expect(sel.operations).toContain("delete");
      } else {
        expect(sel.operations).not.toContain("delete");
      }

      const before = props(doc, groupControl);
      expect(edit({ kind: "bounds", x: sel.frame.x, y: sel.frame.y - 10, width: 110, height: 60 })).toBe(false);
      expect(props(doc, groupControl)).toEqual(before);
      expect(editor.snapshot().history?.undo).toBe(false);
      expect(edit({ kind: "bounds", width: 160, height: 80 })).toBe(true);
      await confirm();
      pickGroup();
      expect(edit({ kind: "nudge", dx: 10, dy: 5 })).toBe(true);
      await confirm();
      pickGroup();
      expect(edit({ kind: "wrap", wrap: "topAndBottom" })).toBe(true);
      await confirm();

      const expected = {
        ...before,
        width: 16000,
        height: 8000,
        horzOffset: before.horzOffset + 1000,
        vertOffset: before.vertOffset + 500,
        textWrap: "TopAndBottom",
      };
      expect(props(doc, groupControl)).toEqual(expected);
      expect(editor.undo()).toBe(true);
      await confirm();
      expect(props(doc, groupControl).textWrap).toBe("Square");
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(props(doc, groupControl)).toEqual(expected);

      const exported = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
      try {
        const report = exported.contentLoss(), output = exported.takeBytes();
        expectReopenEvidence(doc, output, report);
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try {
          expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline.structure)).toBe(true);
          expect(props(reopened, groupControl)).toEqual(expected);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, `p3-group-original.${format}`), bytes);
          writeFileSync(resolve(out, `p3-group-edited.${format}`), output);
          writeFileSync(resolve(out, `p3-group-report.${format}.json`), report);
        }
      } finally { exported.free(); }

      if (format === "hwpx") {
        pickGroup();
        expect(edit({ kind: "delete" })).toBe(true);
        await confirm();
        expect(JSON.parse(doc.getPageControlLayout!(0)).controls.some((c: { type: string }) => c.type === "group")).toBe(false);
        expect(editor.undo()).toBe(true);
        await confirm();
        expect(groupFrame()).toBeDefined();
      } else {
        const locks = doc as RhwpDocument & { setControlLock(para: number, index: number, locked: boolean): string };
        expect(JSON.parse(locks.setControlLock(0, groupControl, true))).toMatchObject({ ok: true });
        expect(pickGroup().operations).toEqual(["deselect"]);
        expect(edit({ kind: "bounds", width: 120, height: 60 })).toBe(false);
      }
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

  it("copies, cuts, and pastes HWPX body pictures, shapes, text boxes, and groups with unique IDs, cross-doc, HWP5, and DOCX refusal", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAADYAAAAbCAIAAAC4FetiAAAAN0lEQVR4nO3OUQkAIBBAsethFvv3MIklBN/HYAE2Z+24+T5QVFRUbFFUrFBUrFBUrFBUrFB84QIyEvyvRSPr3QAAAABJRU5ErkJggg==",
      "base64",
    );
    const makeMemoryClipboard = (): { clip: PlainClipboard; reset: () => void; mimes: () => Map<string, string> } => {
      let plain = "";
      const structured = new Map<string, string>();
      return {
        clip: {
          readText: async () => plain,
          writeText: async text => { plain = text; structured.clear(); },
          readStructured: async mime => structured.get(mime) ?? null,
          writeStructured: async (mime, data, text) => { plain = text; structured.clear(); structured.set(mime, data); },
        },
        reset: () => { plain = ""; structured.clear(); },
        mimes: () => new Map(structured),
      };
    };

    // Build an HWPX fixture containing 1 picture, 1 rectangle shape, 1 multi-paragraph textBox, and 1 group.
    type ExtendedFixtureDoc = RhwpDocument & {
      createBlankDocument(): void;
      groupShapes(json: string): string;
    };
    let bytes: Uint8Array;
    const fixture = engine.HwpDocument.createEmpty() as ExtendedFixtureDoc;
    try {
      fixture.createBlankDocument();
      fixture.insertText(0, 0, 0, "clipboard seed");
      const pic = JSON.parse(fixture.insertPicture!(0, 0, 0, "[]", png, 4200, 2100, 54, 27, "png", "copied-pic"));
      expect(pic.ok).toBe(true);
      expect(JSON.parse(fixture.setPictureProperties!(0, 0, pic.controlIdx,
        '{"treatAsChar":false,"textWrap":"Square","horzRelTo":"Para","vertRelTo":"Para","horzOffset":2000,"vertOffset":2000}')).ok).toBe(true);

      const rect = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 1, shapeType: "rectangle",
        width: 5000, height: 3200, treatAsChar: false, textWrap: "Square", horzOffset: 2000, vertOffset: 10000,
      })));
      expect(rect.ok).toBe(true);
      expect(JSON.parse(fixture.setShapeProperties!(0, 0, rect.controlIdx, JSON.stringify({
        textWrap: "Square", fillType: "solid", fillBgColor: 0x00aabbcc, borderColor: 0x00112233, borderWidth: 150,
      }))).ok).toBe(true);

      const box = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 2, shapeType: "textbox",
        width: 8000, height: 4200, treatAsChar: false, textWrap: "Square", horzOffset: 2000, vertOffset: 18000,
      })));
      expect(box.ok).toBe(true);
      expect(JSON.parse(fixture.setShapeProperties!(0, 0, box.controlIdx, JSON.stringify({
        textWrap: "Square", fillType: "solid", fillBgColor: 0x00ffeecc, borderColor: 0x00334455, borderWidth: 100,
        tbVerticalAlign: "Center", tbMarginLeft: 200, tbMarginRight: 200, tbMarginTop: 100, tbMarginBottom: 100,
      }))).ok).toBe(true);
      expect(JSON.parse(fixture.insertTextInCell(0, 0, box.controlIdx, 0, 0, 0, "첫 문단")).ok).toBe(true);
      expect(JSON.parse(fixture.splitParagraphInCell(0, 0, box.controlIdx, 0, 0, 4)).ok).toBe(true);
      expect(JSON.parse(fixture.insertTextInCell(0, 0, box.controlIdx, 0, 1, 0, "둘째 문단")).ok).toBe(true);
      expect(JSON.parse(fixture.applyParaFormatInCell!(0, 0, box.controlIdx, 0, 0, '{"alignment":"center"}')).ok).toBe(true);
      expect(JSON.parse(fixture.applyParaFormatInCell!(0, 0, box.controlIdx, 0, 1, '{"alignment":"right"}')).ok).toBe(true);

      const g1 = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 3, shapeType: "rectangle",
        width: 3000, height: 2200, treatAsChar: false, textWrap: "Square", horzOffset: 20000, vertOffset: 2000,
      })));
      const g2 = JSON.parse(fixture.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 4, shapeType: "ellipse",
        width: 2400, height: 2400, treatAsChar: false, textWrap: "Square", horzOffset: 24000, vertOffset: 2000,
      })));
      const grouped = JSON.parse(fixture.groupShapes(JSON.stringify({
        sectionIdx: 0, targets: [{ paraIdx: 0, controlIdx: g1.controlIdx }, { paraIdx: 0, controlIdx: g2.controlIdx }],
      })));
      expect(grouped.ok).toBe(true);
      expect(JSON.parse(fixture.setShapeProperties!(0, 0, grouped.controlIdx, '{"textWrap":"Square","horzOffset":20000,"vertOffset":2000}')).ok).toBe(true);

      bytes = fixture.exportHwpx();
    } finally { fixture.free(); }

    clearStructuredClipboard();
    const { clip, mimes } = makeMemoryClipboard();
    const layoutFrames = (doc: RhwpDocument) => (JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[]);
    const listControls = (doc: RhwpDocument) => JSON.parse(doc.getControls!()) as {
      list: number; para: number; controlIndex: number; ctrlId: string; userDesc: string;
    }[];
    const shapePropsAt = (doc: RhwpDocument, para: number, control: number) =>
      JSON.parse(doc.getShapeProperties!(0, para, control)) as Record<string, unknown>;

    const src = await setup("hwpx", bytes);
    let copiedTextBoxMime!: string;
    let copiedPicMime!: string;
    let copiedGroupMime!: string;
    try {
      const picFrames = () => layoutFrames(src.doc).filter(f => f.type === "image");
      const groupFrames = () => layoutFrames(src.doc).filter(f => f.type === "group");
      const shapeFrames = () => layoutFrames(src.doc).filter(f => f.type === "shape");

      // 1. Picture copy -> deselect -> paste (unique control + BinData survival + cascade).
      const selPic = src.pick(picFrames()[0]!);
      expect(selPic.operations).toContain("copy");
      expect(selPic.operations).toContain("cut");
      expect(documentCommandState("edit.copy", src.editor.snapshot())).toEqual({ available: true });
      expect(documentCommandState("edit.cut", src.editor.snapshot())).toEqual({ available: true });
      expect(documentCommandState("edit.paste", src.editor.snapshot())).toEqual({ available: false, reason: "protected" });
      expect(await src.editor.executeClipboard("edit.copy", () => true, clip)).toBe(true);
      copiedPicMime = mimes().get(OBJECT_CLIPBOARD_MIME)!;
      const parsedPic = parseObjectClipboardPayload(copiedPicMime);
      expect(parsedPic).toMatchObject({ version: 3, sourceFormat: "hwpx", object: "picture" });
      expect(parsedPic && parsedPic.version === 3 ? parsedPic.portable : undefined).toBeUndefined();

      expect(src.editor.execute("object.deselect").accepted).toBe(true);
      expect(await src.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true);
      await src.confirm();
      expect(picFrames()).toHaveLength(2);

      // 2. Rectangle shape cut -> deselect -> paste -> recreated with unique scInstId.
      const rectFrame = shapeFrames().find(f => src.pick(f).kind === "shape")!;
      expect(rectFrame).toBeDefined();
      expect(documentCommandState("edit.cut", src.editor.snapshot())).toEqual({ available: true });
      const beforeCutIds = new Set(listControls(src.doc)
        .filter(c => c.list === 0 && c.userDesc === "사각형")
        .map(c => shapePropsAt(src.doc, c.para, c.controlIndex).scInstId));
      const shapeCountBefore = shapeFrames().length;
      expect(await src.editor.executeClipboard("edit.cut", () => true, clip)).toBe(true);
      await src.confirm();
      expect(shapeFrames()).toHaveLength(shapeCountBefore - 1);
      expect(await src.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true);
      await src.confirm();
      expect(shapeFrames()).toHaveLength(shapeCountBefore);
      const rectCtrls = listControls(src.doc).filter(c => c.list === 0 && c.userDesc === "사각형");
      expect(new Set(rectCtrls.map(c => shapePropsAt(src.doc, c.para, c.controlIndex).scInstId)).size).toBe(rectCtrls.length);
      expect(rectCtrls.some(c => !beforeCutIds.has(shapePropsAt(src.doc, c.para, c.controlIndex).scInstId))).toBe(true);

      // 3. TextBox copy -> paste in same doc.
      const boxFrame = shapeFrames().find(f => src.pick(f).kind === "textBox")!;
      expect(boxFrame).toBeDefined();
      expect(await src.editor.executeClipboard("edit.copy", () => true, clip)).toBe(true);
      copiedTextBoxMime = mimes().get(OBJECT_CLIPBOARD_MIME)!;
      const parsedBox = parseObjectClipboardPayload(copiedTextBoxMime);
      expect(parsedBox && parsedBox.version === 3 ? parsedBox.portable : undefined).toBeUndefined();
      const boxCountBefore = shapeFrames().filter(f => src.pick(f).kind === "textBox").length;
      expect(src.editor.execute("object.deselect").accepted).toBe(true);
      expect(await src.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true);
      await src.confirm();
      const boxCtrls = listControls(src.doc).filter(c => c.list === 0 && (c.userDesc === "사각형" || c.userDesc === "글상자"))
        .filter(c => shapePropsAt(src.doc, c.para, c.controlIndex).tbVerticalAlign !== undefined);
      expect(boxCtrls).toHaveLength(boxCountBefore + 1);
      expect(new Set(boxCtrls.map(c => shapePropsAt(src.doc, c.para, c.controlIndex).scInstId)).size).toBe(boxCtrls.length);

      // 4. Group copy -> paste in same doc -> Undo / Redo.
      const selGroup = src.pick(groupFrames()[0]!);
      expect(selGroup.kind).toBe("group");
      expect(await src.editor.executeClipboard("edit.copy", () => true, clip)).toBe(true);
      copiedGroupMime = mimes().get(OBJECT_CLIPBOARD_MIME)!;
      expect(src.editor.execute("object.deselect").accepted).toBe(true);
      expect(await src.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true);
      await src.confirm();
      expect(groupFrames()).toHaveLength(2);
      const groupCtrls = listControls(src.doc).filter(c => c.list === 0 && c.userDesc === "그리기");
      expect(new Set(groupCtrls.map(c => `${c.para}:${c.controlIndex}`)).size).toBe(2);

      expect(src.editor.undo()).toBe(true);
      await src.confirm();
      expect(groupFrames()).toHaveLength(1);
      expect(src.editor.redo()).toBe(true);
      await src.confirm();
      expect(groupFrames()).toHaveLength(2);

      const exported = src.doc.exportHwpxWithReport();
      try {
        const report = exported.contentLoss();
        const edited = exported.takeBytes();
        expect(JSON.parse(report)).toMatchObject({ count: 0 });
        expectReopenEvidence(src.doc, edited, report);
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "p4-clipboard-original.hwpx"), bytes);
          writeFileSync(resolve(out, "p4-clipboard-edited.hwpx"), edited);
          writeFileSync(resolve(out, "p4-clipboard-report.hwpx.json"), report);
        }
      } finally { exported.free(); }
    } finally { src.editor.dispose(); }

    // Cross-document HWPX portable paste + fail-closed refusals (cross-doc picture/group, DOCX v2, HWP5).
    const dst = await setup("hwpx");
    try {
      const boxObj = parseObjectClipboardPayload(copiedTextBoxMime)!;
      const boxClipboard: PlainClipboard = {
        readText: async () => `Geul textBox [${boxObj.token}]`,
        writeText: async () => undefined,
        readStructured: async mime => mime === OBJECT_CLIPBOARD_MIME ? copiedTextBoxMime : null,
      };
      expect(await dst.editor.executeClipboard("edit.paste", () => true, boxClipboard)).toBe(false);
      // Cross-doc picture, cross-doc group, and DOCX v2 payload must all fail closed without mutating dst.
      for (const rejectedPayload of [
        copiedPicMime,
        copiedGroupMime,
        JSON.stringify(createRichObjectClipboardPayload("shape", JSON.stringify({ fragment: {}, media: [] }))!),
      ]) {
        const badClip: PlainClipboard = {
          readText: async () => "fallback",
          writeText: async () => undefined,
          readStructured: async mime => mime === OBJECT_CLIPBOARD_MIME ? rejectedPayload : null,
        };
        expect(await dst.editor.executeClipboard("edit.paste", () => true, badClip)).toBe(false);
      }
      expect(dst.calls.filter(c => c.method === "commit")).toHaveLength(0);
      expect(dst.editor.snapshot().revision).toBe(0);
    } finally { dst.editor.dispose(); }

    // HWP5 documents must never offer copy/cut on selected objects or accept HWPX v3 object paste.
    let hwpBytes: Uint8Array;
    const hwpFix = engine.HwpDocument.createEmpty() as ExtendedFixtureDoc;
    try {
      hwpFix.createBlankDocument();
      hwpFix.insertText(0, 0, 0, "hwp target");
      const r = JSON.parse(hwpFix.createShapeControl!(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 0, shapeType: "rectangle",
        width: 4000, height: 3000, treatAsChar: false, textWrap: "Square", horzOffset: 2000, vertOffset: 2000,
      })));
      expect(r.ok).toBe(true);
      hwpBytes = hwpFix.exportHwp();
    } finally { hwpFix.free(); }

    const hwp = await setup("hwp", hwpBytes);
    try {
      const hwpRect = layoutFrames(hwp.doc).find(f => f.type === "shape")!;
      const hwpSel = hwp.pick(hwpRect);
      expect(hwpSel.operations).not.toContain("copy");
      expect(hwpSel.operations).not.toContain("cut");
      expect(hwp.editor.snapshot().clipboard?.shape).toBeUndefined();
      expect(documentCommandState("edit.copy", hwp.editor.snapshot())).toEqual({ available: false, reason: "protected" });
      expect(hwp.editor.execute("object.deselect").accepted).toBe(true);
      const boxClip: PlainClipboard = {
        readText: async () => "fallback",
        writeText: async () => undefined,
        readStructured: async mime => mime === OBJECT_CLIPBOARD_MIME ? copiedTextBoxMime : null,
      };
      expect(await hwp.editor.executeClipboard("edit.paste", () => true, boxClip)).toBe(false);
    } finally { hwp.editor.dispose(); }
  });
});
