// @vitest-environment jsdom
// Stage 3 P1: HWPX picture move/nudge/delete through `object.edit` on the Release engine.
// With GEUL_STAGE3_OUT=<dir>, writes original/edited documents and loss reports for `save_check` and native acceptance.
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
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAADYAAAAbCAIAAAC4FetiAAAAN0lEQVR4nO3OUQkAIBBAsethFvv3MIklBN/HYAE2Z+24+T5QVFRUbFFUrFBUrFBUrFBUrFB84QIyEvyvRSPr3QAAAABJRU5ErkJggg==", "base64");
type Frame = { x: number; y: number; w: number; h: number };
const images = (doc: RhwpDocument) => JSON.parse(doc.getPageControlLayout!(0)).controls
  .filter((control: { type: string }) => control.type === "image") as Frame[];
const out = process.env.GEUL_STAGE3_OUT;

function captionEvidence(bytes: Uint8Array, directory: string) {
  const caption = new engine.HwpDocument(bytes);
  let captioned: Uint8Array;
  try {
    expect(JSON.parse(caption.setPictureProperties(0, 0, 2, '{"hasCaption":true}')).ok).toBe(true);
    captioned = caption.exportHwp();
    writeFileSync(resolve(directory, "gso-caption.hwp"), captioned);
  } finally { caption.free(); }
  const mutate = (name: string, picture: boolean, properties: object) => {
    const opened = new engine.HwpDocument(captioned);
    try {
      expect(JSON.parse(opened.getPictureProperties(0, 0, 2)).hasCaption).toBe(true);
      const result = picture ? opened.setPictureProperties(0, 0, 2, JSON.stringify(properties))
        : opened.setShapeProperties(0, 0, 4, JSON.stringify(properties));
      expect(JSON.parse(result).ok).toBe(true);
      writeFileSync(resolve(directory, name + ".hwp"), opened.exportHwp());
    } finally { opened.free(); }
  };
  mutate("gso-caption-unrelated", false, { borderColor: 0x112233 });
  mutate("gso-caption-moved", true, { horzOffset: 1000 });
  mutate("gso-caption-resized", true, { width: 5000 });

  const shapeCaptionDoc = new engine.HwpDocument(bytes);
  let shapeCaptioned: Uint8Array;
  try {
    expect(JSON.parse(shapeCaptionDoc.setShapeProperties(0, 0, 4, '{"hasCaption":true}')).ok).toBe(true);
    shapeCaptioned = shapeCaptionDoc.exportHwp();
    writeFileSync(resolve(directory, "gso-caption-shape.hwp"), shapeCaptioned);
  } finally { shapeCaptionDoc.free(); }
  const openedShapeCap = new engine.HwpDocument(shapeCaptioned);
  try {
    expect(JSON.parse(openedShapeCap.getShapeProperties(0, 0, 4)).hasCaption).toBe(true);
    expect(JSON.parse(openedShapeCap.setShapeProperties(0, 0, 4, JSON.stringify({
      fillType: "solid", fillBgColor: 0x996633, borderColor: 0x442277,
      horzOffset: 4300, vertOffset: 7800, width: 8600, height: 4400, rotationAngle: 20,
    }))).ok).toBe(true);
    writeFileSync(resolve(directory, "gso-caption-shape-edited.hwp"), openedShapeCap.exportHwp());
  } finally { openedShapeCap.free(); }
}
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

/** One inline picture (control 2) and one floating picture (control 3) in the first paragraph. */
function source(format: "hwp" | "hwpx", withShape = false): Uint8Array {
  const doc = engine.HwpDocument.createEmpty();
  try {
    doc.createBlankDocument();
    doc.insertText(0, 0, 0, "seed text for the anchor paragraph ");
    let offset = 5;
    const props = ['{"treatAsChar":true}',
      '{"treatAsChar":false,"textWrap":"Square","horzRelTo":"Para","vertRelTo":"Para","horzAlign":"Left","vertAlign":"Top","horzOffset":20000,"vertOffset":3000}'];
    for (const [i, size] of [4050, 3600].entries()) {
      const inserted = JSON.parse(doc.insertPicture(0, 0, offset, "[]", png, size, size / 2, 54, 27, "png", ""));
      expect(inserted.ok).toBe(true);
      expect(JSON.parse(doc.setPictureProperties(0, inserted.paraIdx, inserted.controlIdx, props[i])).ok).toBe(true);
      offset = inserted.logicalOffset;
    }
    if (withShape) {
      const rect = JSON.parse(doc.createShapeControl(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: offset, shapeType: "rectangle",
        width: 7200, height: 3600, treatAsChar: false, textWrap: "Square", horzOffset: 4000, vertOffset: 8000,
      })));
      expect(rect.ok).toBe(true);
      expect(JSON.parse(doc.setShapeProperties(0, rect.paraIdx, rect.controlIdx, JSON.stringify({ textWrap: "Square" }))).ok).toBe(true);
      doc.splitParagraph(0, 0, doc.getParagraphLength(0, 0));
      const table = JSON.parse(doc.createTable(0, 1, 0, 1, 2));
      expect(table.ok).toBe(true);
      doc.setTableProperties(0, table.paraIdx, table.controlIdx, '{"textWrap":"TopAndBottom"}');
      doc.insertTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, "Preserved cell");
    }
    return format === "hwpx" ? doc.exportHwpx() : doc.exportHwp();
  } finally { doc.free(); }
}

async function setup(format: "hwp" | "hwpx", approveHwp = false, withShape = false, customBytes?: Uint8Array) {
  const control = controlledBackend();
  const sessions = new DocumentSessions(control.backend);
  const open = sessions.open(`/object.${format}`);
  const sessionInfo = (patch: Parameters<typeof info>[0]) => info({ ...patch, format });
  control.take("open").reply(ok(sessionInfo({ displayName: `object.${format}` })));
  await open;
  const bytes = customBytes ?? source(format, withShape);
  let doc: RhwpDocument | undefined;
  const editor = new RhwpEditorSession(1, control.backend, sessions,
    async () => ({ openDocument: (b: Uint8Array) => { const d = new engine.HwpDocument(b) as RhwpDocument; doc ??= d; return d; }, memoryBytes: () => FIXED_MEMORY_BYTES }), { natural: null });
  const loading = editor.load();
  control.take("load").reply(loaded(bytes));
  await flush();
  control.take("session").reply(ok(sessionInfo({ state: "loading", sequence: 1, loadGeneration: 1 })));
  control.take("setState").reply(ok(sessionInfo({ state: "ready", sequence: 2, loadGeneration: 1 })));
  await loading;
  if (format === "hwp" && approveHwp) {
    control.take("original").reply(ok(bytes));
    await flush();
    control.take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
    await flush();
  }
  const pick = (frame: Frame) => {
    expect(editor.pointAt(0, frame.x + frame.w / 2, frame.y + frame.h / 2, false, false, true)).toBe(true);
    return editor.objectSelection!;
  };
  const edit = (edit: ObjectEdit) => editor.execute("object.edit", objectEditRequest(editor.objectSelection!, edit)).accepted;
  const confirm = async (revision: number) => {
    const pending = control.take("commit");
    expect(pending.args).toEqual([1, 1, revision - 1, 1]);
    pending.reply(ok(sessionInfo({ state: "ready", revision, dirty: true, loadGeneration: 1, sequence: 2 + revision })));
    await flush();
  };
  return { editor, doc: doc!, bytes, pick, edit, confirm, ...control };
}

const offsets = (doc: RhwpDocument, control: number) => {
  const props = JSON.parse(doc.getPictureProperties!(0, 0, control));
  return { horzOffset: props.horzOffset as number, vertOffset: props.vertOffset as number, width: props.width as number, height: props.height as number };
};

describe("Stage 3 HWPX object edit on the Release engine", () => {
  it("moves and nudges a floating picture, deletes an inline one, with stale refusal, undo/redo and reopen", async () => {
    const { editor, doc, bytes, pick, edit, confirm, calls } = await setup("hwpx");
    try {
      // Inline: 40.5 pt wide; floating: 36 pt wide (layout order is the paint order, not the control order).
      const byWidth = (frames: Frame[]) => [...frames].sort((a, b) => b.w - a.w);
      const [inline, floating] = byWidth(images(doc));
      expect(offsets(doc, 3)).toMatchObject({ horzOffset: 20000, vertOffset: 3000 });
      const selected = pick(floating!);
      expect(selected.operations).toEqual(["deselect", "move", "delete", "crop", "wrap", "altText"]);
      const inlineSelection = pick(inline!);
      expect(inlineSelection.operations).toEqual(["deselect", "resize", "delete", "crop", "wrap", "altText"]);
      // Moving an inline picture is not offered; a stale floating selection is refused.
      expect(edit({ kind: "nudge", dx: 5, dy: 0 })).toBe(false);
      expect(editor.execute("object.edit", objectEditRequest(selected, { kind: "nudge", dx: 5, dy: 0 })).accepted).toBe(false);
      expect(calls.filter(call => call.method === "commit")).toEqual([]);

      const moving = pick(floating!);
      const ratio = moving.picture!.widthPt * 100 / moving.frame.width;
      expect(edit({ kind: "bounds", x: moving.frame.x + 30, y: moving.frame.y + 15 })).toBe(true);
      await confirm(1);
      expect(offsets(doc, 3)).toMatchObject({ horzOffset: 20000 + Math.round(30 * ratio), vertOffset: 3000 + Math.round(15 * ratio), width: 3600, height: 1800 });
      const moved = byWidth(images(doc))[1]!;
      expect(moved.x).toBeCloseTo(floating!.x + 30, 0);
      pick(moved);
      expect(edit({ kind: "nudge", dx: -2, dy: 3 })).toBe(true);
      await confirm(2);
      const afterNudge = offsets(doc, 3);
      expect(afterNudge).toMatchObject({ horzOffset: 20000 + Math.round(30 * ratio) - 200, vertOffset: 3000 + Math.round(15 * ratio) + 300 });

      expect(editor.undo()).toBe(true);
      await confirm(3);
      expect(offsets(doc, 3).horzOffset).toBe(20000 + Math.round(30 * ratio));
      expect(editor.redo()).toBe(true);
      await confirm(4);
      expect(offsets(doc, 3)).toEqual(afterNudge);

      pick(byWidth(images(doc))[0]!);
      expect(edit({ kind: "delete" })).toBe(true);
      await confirm(5);
      expect(images(doc)).toHaveLength(1);
      expect(editor.objectSelection).toBeNull();
      // The surviving picture is now control 2 of the paragraph.
      expect(offsets(doc, 2)).toEqual(afterNudge);

      const exported = doc.exportHwpxWithReport();
      try {
        const report = exported.contentLoss();
        const edited = exported.takeBytes();
        expectReopenEvidence(doc, edited, report);
        const reopened = new engine.HwpDocument(edited) as RhwpDocument;
        try {
          expect(images(reopened)).toHaveLength(1);
          expect(offsets(reopened, 2)).toEqual(afterNudge);
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "object-original.hwpx"), bytes);
          writeFileSync(resolve(out, "object-edited.hwpx"), edited);
          if (report) writeFileSync(resolve(out, "object-report.json"), report);
        }
      } finally { exported.free(); }

      expect(editor.undo()).toBe(true);
      await confirm(6);
      expect(images(doc)).toHaveLength(2);
    } finally { editor.dispose(); }
  });

  it("changes HWPX picture wrapping, description and crop with readback, undo and reopen", async () => {
    const { editor, doc, bytes, pick, edit, confirm, calls } = await setup("hwpx");
    try {
      const byWidth = (frames: Frame[]) => [...frames].sort((a, b) => b.w - a.w);
      const inline = () => byWidth(images(doc))[0]!;
      const selected = pick(inline());
      expect(selected.operations).toEqual(["deselect", "resize", "delete", "crop", "wrap", "altText"]);
      expect(selected.picture!.crop).toEqual([0, 0, 0, 0]);
      // Characters the RHWP JSON reader cannot carry verbatim, and no-op edits, are refused up front.
      expect(edit({ kind: "altText", text: 'quote " inside' })).toBe(false);
      expect(edit({ kind: "wrap", wrap: "inline" })).toBe(false);
      expect(edit({ kind: "position", preset: "topLeft" })).toBe(false);
      expect(calls.filter(call => call.method === "commit")).toEqual([]);

      expect(edit({ kind: "altText", text: "시험 그림 설명" })).toBe(true);
      await confirm(1);
      pick(inline());
      expect(edit({ kind: "crop", left: 0.1, top: 0, right: 0.2, bottom: 0.05 })).toBe(true);
      await confirm(2);
      const cropped = pick(inline());
      expect(cropped.picture!.description).toBe("시험 그림 설명");
      expect(cropped.picture!.crop![0]).toBeCloseTo(0.1, 3);
      expect(cropped.picture!.crop![2]).toBeCloseTo(0.2, 3);
      expect(cropped.picture!.widthPt).toBe(40.5);
      expect(edit({ kind: "wrap", wrap: "topAndBottom" })).toBe(true);
      await confirm(3);
      const props = JSON.parse(doc.getPictureProperties!(0, 0, 2));
      expect(props).toMatchObject({ treatAsChar: false, textWrap: "TopAndBottom", description: "시험 그림 설명", width: 4050, height: 2025 });

      const exported = doc.exportHwpxWithReport();
      try {
        const report = exported.contentLoss();
        const edited = exported.takeBytes();
        expectReopenEvidence(doc, edited, report);
        const reopened = new engine.HwpDocument(edited) as RhwpDocument;
        try {
          expect(JSON.parse(reopened.getPictureProperties!(0, 0, 2))).toMatchObject({
            treatAsChar: false, textWrap: "TopAndBottom", description: "시험 그림 설명",
            cropLeft: props.cropLeft, cropRight: props.cropRight, cropBottom: props.cropBottom, width: 4050, height: 2025 });
        } finally { reopened.free(); }
        if (out) {
          mkdirSync(out, { recursive: true });
          writeFileSync(resolve(out, "format-original.hwpx"), bytes);
          writeFileSync(resolve(out, "format-edited.hwpx"), edited);
          writeFileSync(resolve(out, "format-report.json"), report);
        }
      } finally { exported.free(); }

      // Crop reset and back in line, then undo both.
      pick(byWidth(images(doc))[0]!);
      expect(edit({ kind: "crop", left: 0, top: 0, right: 0, bottom: 0 })).toBe(true);
      await confirm(4);
      pick(byWidth(images(doc))[0]!);
      expect(edit({ kind: "wrap", wrap: "inline" })).toBe(true);
      await confirm(5);
      expect(JSON.parse(doc.getPictureProperties!(0, 0, 2))).toMatchObject({ treatAsChar: true, cropLeft: 0, cropRight: 0 });
      expect(editor.undo()).toBe(true);
      await confirm(6);
      expect(editor.undo()).toBe(true);
      await confirm(7);
      expect(JSON.parse(doc.getPictureProperties!(0, 0, 2))).toMatchObject({ treatAsChar: false, cropLeft: props.cropLeft });
    } finally { editor.dispose(); }
  });

  it("offers no mutation for HWP pictures before original preflight and refuses object.edit", async () => {
    const { editor, doc, pick, edit, calls } = await setup("hwp");
    try {
      const initial = images(doc);
      for (const frame of initial) expect(pick(frame).operations).toEqual(["deselect"]);
      expect(edit({ kind: "delete" })).toBe(false);
      expect(edit({ kind: "nudge", dx: 1, dy: 1 })).toBe(false);
      expect(editor.undo()).toBe(false);
      expect(images(doc)).toEqual(initial);
      expect(calls.filter(call => call.method === "commit")).toEqual([]);
    } finally { editor.dispose(); }
  });

  it("edits and deletes HWP pictures and shapes after SAFE preflight with reopen equality and undo/redo", async () => {
    const { editor, doc, bytes, pick, edit, confirm } = await setup("hwp", true, true);
    try {
      const baseline = hwpReopenModel(doc).structure;
      if (out) {
        mkdirSync(out, { recursive: true });
        writeFileSync(resolve(out, "gso-original.hwp"), bytes);
        captionEvidence(bytes, out);
        const noop = doc.exportHwpWithReport();
        try {
          writeFileSync(resolve(out, "gso-noop.hwp"), noop.takeBytes());
          writeFileSync(resolve(out, "gso-noop-report.json"), noop.contentLoss());
          writeFileSync(resolve(out, "gso-layout.json"), doc.getPageControlLayout!(0));
        } finally { noop.free(); }
      }
      const byWidth = (frames: Frame[]) => [...frames].sort((a, b) => b.w - a.w);
      const [inlinePic, floatingPic] = byWidth(images(doc));
      const shapes = () => JSON.parse(doc.getPageControlLayout!(0)).controls
        .filter((control: { type: string }) => control.type === "shape") as Frame[];

      expect(pick(floatingPic!).operations).toEqual(["deselect", "move", "delete", "crop", "wrap", "altText"]);
      expect(edit({ kind: "nudge", dx: 4, dy: -2 })).toBe(true);
      await confirm(1);

      expect(pick(inlinePic!).operations).toEqual(["deselect", "resize", "delete", "crop", "wrap", "altText"]);
      expect(edit({ kind: "altText", text: "HWP 그림 설명" })).toBe(true);
      await confirm(2);
      pick(byWidth(images(doc))[0]!);
      expect(edit({ kind: "bounds", width: 50, height: 25 })).toBe(true);
      await confirm(3);

      expect(pick(shapes()[0]!).operations).toEqual(["deselect", "move", "resize", "delete", "wrap", "fill", "outline", "rotate"]);
      expect(edit({ kind: "fill", color: "336699" })).toBe(true);
      await confirm(4);
      pick(shapes()[0]!);
      expect(edit({ kind: "rotate", degrees: 20, flipH: true, flipV: true })).toBe(true);
      await confirm(5);
      pick(shapes()[0]!);
      expect(edit({ kind: "bounds", width: 86, height: 44 })).toBe(true);
      await confirm(6);
      pick(shapes()[0]!);
      expect(edit({ kind: "nudge", dx: 3, dy: -2 })).toBe(true);
      await confirm(7);
      pick(shapes()[0]!);
      expect(edit({ kind: "outline", color: "772244" })).toBe(true);
      await confirm(8);
      pick(shapes()[0]!);
      expect(edit({ kind: "wrap", wrap: "topAndBottom" })).toBe(true);
      await confirm(9);
      pick(byWidth(images(doc))[0]!);
      expect(edit({ kind: "crop", left: 0.1, top: 0, right: 0.2, bottom: 0 })).toBe(true);
      await confirm(10);
      pick(byWidth(images(doc))[0]!);
      expect(edit({ kind: "wrap", wrap: "topAndBottom" })).toBe(true);
      await confirm(11);

      const exported = doc.exportHwpWithReport();
      try {
        const report = exported.contentLoss();
        const edited = exported.takeBytes();
        expectReopenEvidence(doc, edited, report);
        const reopened = new engine.HwpDocument(edited) as RhwpDocument;
        try {
          expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline)).toBe(true);
          expect(JSON.parse(reopened.getPictureProperties!(0, 0, 2))).toMatchObject({
            width: 5000, height: 2500, description: "HWP 그림 설명",
            cropLeft: 405, cropRight: 810, textWrap: "TopAndBottom", treatAsChar: false,
          });
          expect(JSON.parse(reopened.getShapeProperties!(0, 0, 4))).toMatchObject({
            width: 8600, height: 4400, horzOffset: 4300, vertOffset: 7800,
            fillType: "solid", fillBgColor: 0x996633, borderColor: 0x442277,
            rotationAngle: 20, horzFlip: true, vertFlip: true, textWrap: "TopAndBottom",
          });
        } finally { reopened.free(); }
        if (out) {
          writeFileSync(resolve(out, "gso-edited.hwp"), edited);
          writeFileSync(resolve(out, "gso-edited-report.json"), report);
        }
      } finally { exported.free(); }

      expect(editor.undo()).toBe(true);
      await confirm(12);
      expect(JSON.parse(doc.getPictureProperties!(0, 0, 2))).toMatchObject({ treatAsChar: true });
      expect(editor.redo()).toBe(true);
      await confirm(13);
      expect(JSON.parse(doc.getPictureProperties!(0, 0, 2))).toMatchObject({ treatAsChar: false, textWrap: "TopAndBottom" });

      // Delete floating picture (leaving inline picture sharing the same BinData) and delete shape.
      pick(byWidth(images(doc))[1]!);
      expect(edit({ kind: "delete" })).toBe(true);
      await confirm(14);
      expect(images(doc)).toHaveLength(1);
      pick(shapes()[0]!);
      expect(edit({ kind: "delete" })).toBe(true);
      await confirm(15);
      expect(shapes()).toHaveLength(0);

      const deletedExport = doc.exportHwpWithReport();
      try {
        const delReport = deletedExport.contentLoss();
        const delBytes = deletedExport.takeBytes();
        expectReopenEvidence(doc, delBytes, delReport);
        const reopenedDel = new engine.HwpDocument(delBytes) as RhwpDocument;
        try {
          expect(images(reopenedDel)).toHaveLength(1);
          expect(JSON.parse(reopenedDel.getPageControlLayout!(0)).controls.filter((c: { type: string }) => c.type === "shape")).toHaveLength(0);
          expect(JSON.parse(reopenedDel.getPictureProperties!(0, 0, 2))).toMatchObject({
            width: 5000, height: 2500, description: "HWP 그림 설명",
          });
        } finally { reopenedDel.free(); }
        if (out) {
          writeFileSync(resolve(out, "gso-deleted.hwp"), delBytes);
          writeFileSync(resolve(out, "gso-deleted-report.json"), delReport);
        }
      } finally { deletedExport.free(); }

      // Undo restores deleted shape and picture; Redo restores the deletions.
      expect(editor.undo()).toBe(true);
      await confirm(16);
      expect(shapes()).toHaveLength(1);
      expect(editor.undo()).toBe(true);
      await confirm(17);
      expect(images(doc)).toHaveLength(2);
      expect(editor.redo()).toBe(true);
      await confirm(18);
      expect(images(doc)).toHaveLength(1);
      expect(editor.redo()).toBe(true);
      await confirm(19);
      expect(shapes()).toHaveLength(0);
    } finally { editor.dispose(); }
  });

  it("edits outer properties of caption-bearing HWP pictures and shapes while preserving captions and blocking deletion", async () => {
    const seed = new engine.HwpDocument(source("hwp", true)) as RhwpDocument;
    let captionedBytes: Uint8Array;
    try {
      expect(JSON.parse(seed.setPictureProperties!(0, 0, 2, '{"hasCaption":true}')).ok).toBe(true);
      expect(JSON.parse(seed.setShapeProperties!(0, 0, 4, '{"hasCaption":true}')).ok).toBe(true);
      captionedBytes = seed.exportHwp!();
    } finally { seed.free(); }

    const { editor, doc, pick, edit, confirm } = await setup("hwp", true, true, captionedBytes);
    let seq = 0;
    try {
      const baseline = hwpReopenModel(doc).structure;
      const shapes = () => JSON.parse(doc.getPageControlLayout!(0)).controls
        .filter((control: { type: string }) => control.type === "shape") as Frame[];
      const pic = () => [...images(doc)].sort((a, b) => b.w - a.w)[0]!;

      // Captioned inline picture: outer ops permitted, delete excluded & refused.
      expect(pick(pic()).operations).toEqual(["deselect", "resize", "crop", "wrap", "altText"]);
      expect(edit({ kind: "delete" })).toBe(false);
      expect(edit({ kind: "altText", text: "캡션 그림 outer" })).toBe(true);
      await confirm(++seq);
      pick(pic());
      expect(edit({ kind: "bounds", width: 52, height: 26 })).toBe(true);
      await confirm(++seq);

      // Captioned shape: outer ops permitted, delete excluded & refused.
      expect(pick(shapes()[0]!).operations).toEqual(["deselect", "move", "resize", "wrap", "fill", "outline", "rotate"]);
      expect(edit({ kind: "delete" })).toBe(false);
      expect(edit({ kind: "fill", color: "336699" })).toBe(true);
      await confirm(++seq);
      pick(shapes()[0]!);
      expect(edit({ kind: "nudge", dx: 4, dy: -2 })).toBe(true);
      await confirm(++seq);
      pick(shapes()[0]!);
      expect(edit({ kind: "bounds", width: 84, height: 42 })).toBe(true);
      await confirm(++seq);
      pick(shapes()[0]!);
      expect(edit({ kind: "rotate", degrees: 25, flipH: false, flipV: false })).toBe(true);
      await confirm(++seq);

      const exported = doc.exportHwpWithReport!();
      let edited: Uint8Array;
      try {
        const report = exported.contentLoss();
        edited = exported.takeBytes();
        expectReopenEvidence(doc, edited, report);
      } finally { exported.free(); }

      const reopened = new engine.HwpDocument(edited) as RhwpDocument;
      try {
        expect(hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), baseline)).toBe(true);
        expect(JSON.parse(reopened.getPictureProperties!(0, 0, 2))).toMatchObject({
          hasCaption: true, width: 5200, height: 2600, description: "캡션 그림 outer",
        });
        expect(JSON.parse(reopened.getShapeProperties!(0, 0, 4))).toMatchObject({
          hasCaption: true, width: 8400, height: 4200,
          horzOffset: 4400, vertOffset: 7800, fillType: "solid", fillBgColor: 0x996633, rotationAngle: 25,
        });
      } finally { reopened.free(); }

      // Undo/Redo restores rotation & size while keeping caption attached.
      expect(editor.undo()).toBe(true);
      await confirm(++seq);
      expect(JSON.parse(doc.getShapeProperties!(0, 0, 4))).toMatchObject({ hasCaption: true, rotationAngle: 0, width: 8400 });
      expect(editor.redo()).toBe(true);
      await confirm(++seq);
      expect(JSON.parse(doc.getShapeProperties!(0, 0, 4))).toMatchObject({ hasCaption: true, rotationAngle: 25, width: 8400 });
    } finally { editor.dispose(); }
  });
});
