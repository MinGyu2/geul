// @vitest-environment jsdom
// Stage 3-B portable HWPX clipboard on the Release engine.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import type { PlainClipboard } from "../../src/commands/clipboard";
import { OBJECT_CLIPBOARD_MIME, createHwpxObjectClipboardPayload, parseObjectClipboardPayload } from "../../src/commands/objectClipboard";
import { objectEditRequest, type ObjectEdit } from "../../src/commands/objectSelection";
import { clearStructuredClipboard } from "../../src/commands/tableClipboard";
import { FIXED_MEMORY_BYTES, controlledBackend, info, loaded, ok, flush } from "../../src/components/Editor/rhwp/testing";

const artifacts = resolve("public/rhwp");
const identity = await readRhwpGeneration(artifacts, "release");
const folder = resolve(artifacts, "generations", identity.generation);
const engine = createRequire(import.meta.url)(resolve(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(resolve(folder, "rhwp_bg.wasm")) });
/** The save path's reopen evidence (RhwpEditorSession export check): pages, text and controls equal, no loss. */
function expectReopenEvidence(doc: RhwpDocument, bytes: Uint8Array, report: string, verify: (reopened: RhwpDocument) => void) {
  const reopened = new engine.HwpDocument(bytes) as RhwpDocument & { getControls(): string; getTextFileText(): string };
  const live = doc as RhwpDocument & { getControls(): string; getTextFileText(): string };
  try {
    expect(JSON.parse(report)).toMatchObject({ count: 0 });
    expect(reopened.pageCount()).toBe(live.pageCount());
    expect(reopened.getTextFileText()).toBe(live.getTextFileText());
    expect(reopened.getControls()).toBe(live.getControls());
    verify(reopened);
  } finally { reopened.free(); }
}
type Frame = { type: string; x: number; y: number; w: number; h: number; controlIdx: number };
const shapes = (doc: RhwpDocument) => (JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[]).filter(c => c.type === "shape" || c.type === "line");

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
  return { editor, doc, bytes, pick, edit, confirm, sessions, ...control };
}

const props = (doc: RhwpDocument, control: number) => JSON.parse(doc.getShapeProperties!(0, 0, control));

describe("HWPX object clipboard fidelity boundary", () => {
  for (const kind of ["caption", "mixed", "rectangle", "ellipse", "line", "noOutline", "plainTextBox"] as const) it(`B3.2: pastes cross-document HWPX ${kind} faithfully with Undo/Redo and reopen`, async () => {
    const fixture = engine.HwpDocument.createEmpty();
    fixture.createBlankDocument(); fixture.insertText(0, 0, 0, "seed");
    const box = kind === "mixed" || kind === "plainTextBox";
    const shapeType = box ? "textbox" : kind === "ellipse" || kind === "line" ? kind : "rectangle";
    const result = JSON.parse(fixture.createShapeControl(JSON.stringify({sectionIdx:0, paraIdx:0, charOffset:0, shapeType, width:5000, height:3000, treatAsChar:false, textWrap:"Square", horzOffset:2000, vertOffset:2000})));
    expect(result.ok).toBe(true);
    if (kind === "noOutline" || kind === "line") {
      expect(JSON.parse(fixture.setShapeProperties(0, 0, result.controlIdx,
        JSON.stringify({ lineType: kind === "noOutline" ? 0 : 1, borderWidth: kind === "noOutline" ? 33 : 0 }))).ok).toBe(true);
    }
    if (kind === "caption") {
      expect(JSON.parse(fixture.setShapeProperties(0, 0, result.controlIdx, '{"hasCaption":true,"captionDirection":"Top","fillType":"solid","fillBgColor":11223344}')).ok).toBe(true);
      const capLen = fixture.getCellParagraphLength(0, 0, result.controlIdx, 65534, 0);
      expect(JSON.parse(fixture.insertTextInCell(0, 0, result.controlIdx, 65534, 0, capLen, "cap bold")).ok).toBe(true);
      const capPath0 = JSON.stringify([{ controlIndex: result.controlIdx, cellIndex: 65534, cellParaIndex: 0 }]);
      expect(JSON.parse(fixture.applyCharFormatInCellByPath(0, 0, capPath0, capLen + 4, capLen + 8, '{"bold":true}')).ok).toBe(true);
      expect(JSON.parse(fixture.splitParagraphInCell(0, 0, result.controlIdx, 65534, 0, capLen + 8)).ok).toBe(true);
      expect(JSON.parse(fixture.insertTextInCell(0, 0, result.controlIdx, 65534, 1, 0, "cap line 2")).ok).toBe(true);
      const capPath1 = JSON.stringify([{ controlIndex: result.controlIdx, cellIndex: 65534, cellParaIndex: 1 }]);
      expect(JSON.parse(fixture.applyParaFormatInCellByPath(0, 0, capPath1, '{"alignment":"right"}')).ok).toBe(true);
      expect(JSON.parse(fixture.applyCharFormatInCellByPath(0, 0, capPath1, 0, 10, '{"italic":true}')).ok).toBe(true);
    }
    const textboxLayout = kind === "mixed"
      ? { tbVerticalAlign: "Bottom", tbMarginLeft: 0, tbMarginRight: 240, tbMarginTop: 120, tbMarginBottom: 160 }
      : { tbVerticalAlign: "Center", tbMarginLeft: 90, tbMarginRight: 110, tbMarginTop: 130, tbMarginBottom: 150 };
    if (box) {
      expect(JSON.parse(fixture.setShapeProperties(0, 0, result.controlIdx, JSON.stringify(textboxLayout))).ok).toBe(true);
      expect(JSON.parse(fixture.insertTextInCell(0,0,result.controlIdx,0,0,0,kind === "mixed" ? "😀lain bold" : "plain bold")).ok).toBe(true);
      if (kind === "mixed") {
        const boxPath0 = JSON.stringify([{ controlIndex: result.controlIdx, cellIndex: 0, cellParaIndex: 0 }]);
        const fontIds = JSON.parse(fixture.resolveDocumentFontFamily("Geul Portable Test Face"));
        expect(JSON.parse(fixture.applyCharFormatInCellByPath(0, 0, boxPath0, 6, 10, JSON.stringify({
          bold: true, italic: true, underline: true, strikethrough: true, fontSize: 1400,
          textColor: "#cc2200", shadeColor: "#ffff00", fontIds,
        }))).ok).toBe(true);
        expect(JSON.parse(fixture.applyParaFormatInCellByPath(0,0,boxPath0,'{"alignment":"center"}')).ok).toBe(true);
        expect(JSON.parse(fixture.splitParagraphInCell(0,0,result.controlIdx,0,0,10)).ok).toBe(true);
        expect(JSON.parse(fixture.insertTextInCell(0,0,result.controlIdx,0,1,0,"second line")).ok).toBe(true);
        expect(JSON.parse(fixture.splitParagraphInCell(0,0,result.controlIdx,0,1,11)).ok).toBe(true);
      }
    }
    const bytes = fixture.exportHwpx(); fixture.free();
    const src = await setup("hwpx", bytes); const dst = await setup("hwpx");
    let payload = "", plain = "";
    const clip: PlainClipboard = {readText: async () => plain, writeText: async () => {}, writeStructured: async (_m,d,t) => {payload=d; plain=t;}, readStructured: async m => m === OBJECT_CLIPBOARD_MIME ? payload : null};
    try {
      const frame = shapes(src.doc)[0]!; src.pick(frame);
      if (kind === "caption") expect(props(src.doc,frame.controlIdx).hasCaption).toBe(true);
      if (kind === "mixed") expect(JSON.parse(src.doc.getCellCharPropertiesAt!(0,0,frame.controlIdx,0,0,7)).bold).toBe(true);
      const sourceBefore = src.doc.exportHwpx();
      expect(await src.editor.executeClipboard("edit.copy", () => true, clip)).toBe(true);
      const parsed = parseObjectClipboardPayload(payload);
      expect(parsed).toMatchObject({version:3, sourceFormat:"hwpx", object:box ? "textBox" : "shape"});
      expect(parsed && parsed.version === 3 ? parsed.portable : undefined).toBeDefined();
      if (kind === "caption") {
        const tampered = JSON.parse(payload);
        const p0 = tampered.portable.caption.paragraphs[0];
        expect(p0.autoNumberOffset).toBe(2);
        expect(p0.runs.map(({ start, end }: { start: number; end: number }) => [start, end]))
          .toEqual([[0, 2], [3, 8], [8, 12]]);
        const complete = p0.runs;
        p0.runs = complete.slice(1); // Missing ordinary prefix.
        await expectRefused(dst, objectClip(JSON.stringify(tampered)).clipboard);
        p0.runs = [{ ...complete[0], end: 3 }, ...complete.slice(1)]; // Crosses atno.
        await expectRefused(dst, objectClip(JSON.stringify(tampered)).clipboard);
      }

      expect(await dst.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true);
      await dst.confirm();
      expect(src.doc.exportHwpx()).toEqual(sourceBefore);

      const sourceShape = props(src.doc, frame.controlIdx);
      const verifyPasted = (doc: RhwpDocument, count: number) => {
        const pasted = shapes(doc);
        expect(pasted).toHaveLength(count);
        for (const { controlIdx } of pasted) {
          expect(props(doc, controlIdx)).toMatchObject({
            width: 5000, height: 3000, lineType: kind === "noOutline" ? 0 : 1, borderWidth: kind === "line" ? 0 : 33,
            borderColor: sourceShape.borderColor, fillType: sourceShape.fillType, hasCaption: kind === "caption",
          });
          const text = (cell: number, p: number) => doc.getTextInCell!(0, 0, controlIdx, cell, p, 0,
            doc.getCellParagraphLength!(0, 0, controlIdx, cell, p));
          const style = (cell: number, p: number, at: number) =>
            JSON.parse(doc.getCellCharPropertiesAt!(0, 0, controlIdx, cell, p, at));
          const align = (cellIndex: number, cellParaIndex: number) => JSON.parse(doc.getCellParaPropertiesAtByPath!(0, 0,
            JSON.stringify([{ controlIndex: controlIdx, cellIndex, cellParaIndex }]))).alignment;
          if (kind === "caption") {
            expect(props(doc, controlIdx)).toMatchObject({ captionDirection: "Top", fillBgColor: 11223344 });
            expect(doc.getCellParagraphCount!(0, 0, controlIdx, 65534)).toBe(2);
            const sourceLen = src.doc.getCellParagraphLength!(0, 0, frame.controlIdx, 65534, 0);
            expect(text(65534, 0)).toBe(src.doc.getTextInCell!(0, 0, frame.controlIdx, 65534, 0, 0, sourceLen));
            expect(text(65534, 1)).toBe("cap line 2");
            expect(style(65534, 0, sourceLen - 1).bold).toBe(true);
            expect(style(65534, 1, 0).italic).toBe(true);
            expect(align(65534, 1)).toBe("right");
          }
          if (box) {
            expect(props(doc, controlIdx)).toMatchObject(textboxLayout);
            expect(text(0, 0)).toBe(kind === "mixed" ? "😀lain bold" : "plain bold");
          }
          if (kind === "mixed") {
            expect(doc.getCellParagraphCount!(0, 0, controlIdx, 0)).toBe(3);
            expect(text(0, 1)).toBe("second line");
            expect(text(0, 2)).toBe("");
            expect(style(0, 0, 6)).toMatchObject({
              bold: true, italic: true, underline: true, strikethrough: true, fontSize: 1400,
              textColor: "#cc2200", shadeColor: "#ffff00",
              fontFamilies: Array(7).fill("Geul Portable Test Face"),
            });
            expect(style(0, 0, 5)).toMatchObject({ bold: false, italic: false, fontFamily: "함초롬바탕" });
            expect(align(0, 0)).toBe("center");
          }
        }
        if (kind === "caption") {
          const atno = JSON.parse(doc.getControls!()).filter((control: { ctrlId: string }) => control.ctrlId === "atno");
          expect(atno).toHaveLength(count);
          for (const control of atno) expect(control).toMatchObject({ ctrlCh: 18, para: 0, pos: 2 });
        }
      };
      verifyPasted(dst.doc, 1);

      // Repeated cross-doc paste creates a second independent object; Undo/Redo works cleanly.
      expect(await dst.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true);
      await dst.confirm();
      expect(shapes(dst.doc)).toHaveLength(2);
      expect(dst.editor.undo()).toBe(true);
      await dst.confirm();
      verifyPasted(dst.doc, 1);
      expect(dst.editor.redo()).toBe(true);
      await dst.confirm();
      verifyPasted(dst.doc, 2);

      const exported = dst.doc.exportHwpxWithReport();
      try {
        expectReopenEvidence(dst.doc, exported.takeBytes(), exported.contentLoss(), reopened => verifyPasted(reopened, 2));
      } finally { exported.free(); }
    } finally {src.editor.dispose(); dst.editor.dispose();}
  });

  it.each([false, true])("B3.2: preserves picture bytes and properties with caption=%s", async hasCaption => {
    const srcBytes = pictureFixture(hasCaption);
    const expected = {
      width: 4200, height: 2100, borderType: 0, borderColor: 0, borderWidth: 0,
      cropLeft: hasCaption ? 120 : 0, cropTop: hasCaption ? 60 : 0,
      cropRight: hasCaption ? 720 : 600, cropBottom: hasCaption ? 90 : 0,
      cropRect: hasCaption ? { left: 120, top: 60, right: 3480, bottom: 2010 }
        : { left: 0, top: 0, right: 3600, bottom: 4800 },
      cropReferenceWidth: 3600, cropReferenceHeight: 4800,
      description: "b32-alt", hasCaption, ...(hasCaption ? { captionSpacing: 150 } : {}),
    };

    const src = await setup("hwpx", srcBytes); const dst = await setup("hwpx");
    let payload = "", plain = "";
    const clip: PlainClipboard = { readText: async () => plain, writeText: async () => {}, writeStructured: async (_m, d, t) => { payload = d; plain = t; }, readStructured: async m => m === OBJECT_CLIPBOARD_MIME ? payload : null };
    try {
      const sourceBefore = src.doc.exportHwpx();
      const picFrame = (JSON.parse(src.doc.getPageControlLayout!(0)).controls as Frame[]).find(c => c.type === "image")!;
      expect(JSON.parse(src.doc.getPictureProperties!(0, 0, picFrame.controlIdx))).toMatchObject(expected);
      src.pick(picFrame);
      expect(await src.editor.executeClipboard("edit.copy", () => true, clip)).toBe(true);
      expect(await dst.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true);
      await dst.confirm();

      const dstPics = (JSON.parse(dst.doc.getPageControlLayout!(0)).controls as Frame[]).filter(c => c.type === "image");
      expect(dstPics).toHaveLength(1);
      const dPicCtrl = dstPics[0]!.controlIdx;
      const dPicProps = JSON.parse(dst.doc.getPictureProperties!(0, 0, dPicCtrl));
      expect(dPicProps).toMatchObject(expected);
      expect(Buffer.from(dst.doc.getControlImageData!(0, 0, "[]", dPicCtrl))).toEqual(picturePng);
      const dCapLen = hasCaption ? dst.doc.getCellParagraphLength!(0, 0, dPicCtrl, 0, 0) : 0;
      if (hasCaption) expect(dst.doc.getTextInCell!(0, 0, dPicCtrl, 0, 0, 0, dCapLen)).toContain("pic cap");
      expect(src.doc.exportHwpx()).toEqual(sourceBefore);

      const exported = dst.doc.exportHwpxWithReport();
      try {
        expectReopenEvidence(dst.doc, exported.takeBytes(), exported.contentLoss(), reopened => {
          expect(JSON.parse(reopened.getPictureProperties!(0, 0, dPicCtrl))).toMatchObject(expected);
          expect(Buffer.from(reopened.getControlImageData!(0, 0, "[]", dPicCtrl))).toEqual(picturePng);
          if (hasCaption) expect(reopened.getTextInCell!(0, 0, dPicCtrl, 0, 0, 0, dCapLen))
            .toBe(dst.doc.getTextInCell!(0, 0, dPicCtrl, 0, 0, 0, dCapLen));
        });
      } finally { exported.free(); }

      // Only one fixture is needed to test the forged MIME.
      if (!hasCaption) return;
      const beforeTamper = dst.doc.exportHwpx();
      const snapshot = dst.editor.snapshot();
      const tamperedMime = JSON.parse(payload);
      tamperedMime.portable.mime = "image/jpeg";
      expect(parseObjectClipboardPayload(JSON.stringify(tamperedMime))).toBeNull();
      const badClip: PlainClipboard = { readText: async () => "fallback", writeText: async () => {}, readStructured: async () => JSON.stringify(tamperedMime) };
      expect(await dst.editor.executeClipboard("edit.paste", () => true, badClip)).toBe(false);
      expect(dst.doc.exportHwpx()).toEqual(beforeTamper);
      expect(dst.editor.snapshot()).toEqual(snapshot);
    } finally { src.editor.dispose(); dst.editor.dispose(); }
  });
  it("retains same-document structural clone and undo/redo", async () => {
    const src = await setup("hwpx");
    let payload = "", plain = "";
    const clip: PlainClipboard = {readText: async () => plain, writeText: async () => {}, writeStructured: async (_m,d,t) => {payload=d; plain=t;}, readStructured: async m => m === OBJECT_CLIPBOARD_MIME ? payload : null};
    try {
      expect(src.editor.execute("insert.shape", {command:"insert.shape",kind:"rectangle"}).accepted).toBe(true); await src.confirm();
      src.pick(shapes(src.doc)[0]!); expect(await src.editor.executeClipboard("edit.copy", () => true, clip)).toBe(true);
      expect(src.editor.execute("object.deselect").accepted).toBe(true);
      expect(await src.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true); await src.confirm();
      expect(shapes(src.doc)).toHaveLength(2);
      expect(src.editor.undo()).toBe(true); await src.confirm(); expect(shapes(src.doc)).toHaveLength(1);
      expect(src.editor.redo()).toBe(true); await src.confirm(); expect(shapes(src.doc)).toHaveLength(2);
      const reopened = new engine.HwpDocument(src.doc.exportHwpx()) as RhwpDocument;
      try { expect(shapes(reopened)).toHaveLength(2); } finally { reopened.free(); }
    } finally {src.editor.dispose();}
  });
  it("routes missing MIME object markers without text downgrade", async () => {
    const src = await setup("hwpx"), dst = await setup("hwpx");
    let plain = "";
    const clip: PlainClipboard = {readText: async () => plain, writeText: async t => { plain = t; }};
    try {
      clearStructuredClipboard();
      expect(src.editor.execute("insert.shape", {command:"insert.shape",kind:"rectangle"}).accepted).toBe(true); await src.confirm();
      src.pick(shapes(src.doc)[0]!);
      expect(await src.editor.executeClipboard("edit.copy", () => true, clip)).toBe(true);
      expect(src.editor.execute("object.deselect").accepted).toBe(true);
      expect(await src.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true); await src.confirm();
      expect(shapes(src.doc)).toHaveLength(2); // same-document remembered object
      clearStructuredClipboard();
      const srcBytes = src.doc.exportHwpx(), srcSnapshot = src.editor.snapshot();
      const before = dst.doc.exportHwpx(), snapshot = dst.editor.snapshot();
      expect(await src.editor.executeClipboard("edit.paste", () => true, clip)).toBe(false);
      expect(src.doc.exportHwpx()).toEqual(srcBytes); expect(src.editor.snapshot()).toEqual(srcSnapshot);
      expect(await dst.editor.executeClipboard("edit.paste", () => true, clip)).toBe(false);
      expect(dst.doc.exportHwpx()).toEqual(before); expect(dst.editor.snapshot()).toEqual(snapshot);
      plain = "Geul shape notes";
      expect(await dst.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true); await dst.confirm();
      expect(dst.doc.getTextFileText!()).toContain("Geul shape notes");
    } finally {clearStructuredClipboard(); src.editor.dispose(); dst.editor.dispose();}
  });

});

const picturePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAADAAAABACAIAAADTQmMRAAAATklEQVR4nO3OMQ0AIBAAsVfCjH8pKMIFx9CkAjpnr69MPhASEhKqB0JCQkL1QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF4XmIMR3l0LcAAAAAElFTkSuQmCC",
  "base64",
);

function pictureFixture(hasCaption = false): Uint8Array {
  const doc = new engine.HwpDocument(source("hwpx")) as RhwpDocument;
  try {
    const pic = JSON.parse(doc.insertPicture!(0, 0, 0, "[]", picturePng, 4200, 2100, 48, 64, "png", "b32-alt"));
    expect(pic.ok).toBe(true);
    expect(JSON.parse(doc.setPictureProperties!(0, 0, pic.controlIdx, JSON.stringify({
      treatAsChar: false, textWrap: "Square", horzOffset: 1000, vertOffset: 1200,
      ...(hasCaption ? {
        cropLeft: 120, cropTop: 60, cropRight: 720, cropBottom: 90,
        hasCaption: true, captionDirection: "Bottom", captionSpacing: 150,
      } : {}),
    }))).ok).toBe(true);
    if (hasCaption) {
      const len = doc.getCellParagraphLength!(0, 0, pic.controlIdx, 0, 0);
      expect(JSON.parse(doc.insertTextInCell!(0, 0, pic.controlIdx, 0, 0, len, "pic cap")).ok).toBe(true);
    }
    return doc.exportHwpx();
  } finally { doc.free(); }
}

function portableFixture(kind: "textbox" | "rectangle" = "textbox", lineType = 1): Uint8Array {
  const doc = new engine.HwpDocument(source("hwpx")) as RhwpDocument;
  try {
    const created = JSON.parse(doc.createShapeControl!(JSON.stringify({
      sectionIdx: 0, paraIdx: 0, charOffset: 0, shapeType: kind,
      width: 5000, height: 3000, treatAsChar: false, textWrap: "Square", horzOffset: 2000, vertOffset: 2000,
    })));
    expect(created.ok).toBe(true);
    expect(JSON.parse(doc.setShapeProperties!(0, 0, created.controlIdx, JSON.stringify({ lineType }))).ok).toBe(true);
    if (kind === "textbox") expect(JSON.parse(doc.insertTextInCell!(0, 0, created.controlIdx, 0, 0, 0, "abcd")).ok).toBe(true);
    return doc.exportHwpx();
  } finally { doc.free(); }
}

function objectClip(data = "") {
  let payload = data;
  let plain = "clipboard text must not be inserted";
  const clipboard: PlainClipboard = {
    readText: async () => plain,
    writeText: async () => {},
    readStructured: async mime => mime === OBJECT_CLIPBOARD_MIME ? payload : null,
    writeStructured: async (_mime, raw, text) => { payload = raw; plain = text; },
  };
  return { clipboard, payload: () => payload };
}

function textboxEnvelope(fontFamily?: string) {
  return createHwpxObjectClipboardPayload("textBox", 100, 1, {
    kind: "shape", shapeType: "textbox", width: 5000, height: 3000, horzOffset: 2000, vertOffset: 2000,
    treatAsChar: false, textWrap: "Square", rotationAngle: 0, horzFlip: false, vertFlip: false,
    lineType: 1, borderColor: 0, borderWidth: 33, fillType: "none",
    tbVerticalAlign: "Top", tbMargins: { left: 283, right: 283, top: 283, bottom: 283 },
    paragraphs: [{ text: "abcd", align: "right", runs: [{ start: 0, end: 4, bold: true, ...(fontFamily ? { fontFamily } : {}) }] }],
  })!;
}

async function expectRefused(dst: Awaited<ReturnType<typeof setup>>, clipboard: PlainClipboard) {
  const bytes = dst.doc.exportHwpx();
  const fonts = dst.doc.getDocumentFontTable!();
  const objects = dst.doc.getControls!();
  const layout = shapes(dst.doc);
  const text = dst.doc.getTextFileText!();
  const snapshot = dst.editor.snapshot();
  const session = dst.sessions.get(1);
  const pending = [...dst.calls];
  expect(session).toMatchObject({ revision: 0, dirty: false });
  expect(await dst.editor.executeClipboard("edit.paste", () => true, clipboard)).toBe(false);
  expect(dst.calls).toEqual(pending);
  expect(dst.editor.snapshot()).toEqual(snapshot);
  expect(dst.sessions.get(1)).toEqual(session);
  expect(dst.doc.getTextFileText!()).toBe(text);
  expect(dst.doc.getDocumentFontTable!()).toBe(fonts);
  expect(dst.doc.getControls!()).toBe(objects);
  expect(shapes(dst.doc)).toEqual(layout);
  expect(dst.doc.exportHwpx()).toEqual(bytes);
  expect(dst.editor.undo()).toBe(false);
  expect(dst.editor.redo()).toBe(false);
}

describe("B3.2 portable refusals and rollback", () => {
  const family = "Geul Rollback Test Face";

  it.each(["unavailable", "throws after registration", "short array", "invalid ID", "different family"])(
    "refuses an explicit family with resolver %s", async mode => {
      const dst = await setup("hwpx", portableFixture("rectangle"));
      const envelope = textboxEnvelope(family);
      expect(envelope).not.toBeNull();
      const clip = objectClip(JSON.stringify(envelope));
      const resolveFont = dst.doc.resolveDocumentFontFamily!.bind(dst.doc);
      const create = vi.spyOn(dst.doc, "createShapeControl");
      try {
        if (mode === "unavailable") {
          Object.defineProperty(dst.doc, "resolveDocumentFontFamily", { value: undefined });
        } else {
          vi.spyOn(dst.doc, "resolveDocumentFontFamily").mockImplementation(name => {
            const ids = JSON.parse(resolveFont(name));
            // Exercise rollback after genuine engine mutation, including font table registration.
            expect(dst.doc.getDocumentFontTable!()).toContain(family);
            if (mode === "throws after registration") throw new Error("injected resolver failure");
            if (mode === "short array") return JSON.stringify(ids.slice(0, 6));
            if (mode === "invalid ID") return JSON.stringify([65536, ...ids.slice(1)]);
            return JSON.stringify(Array(7).fill(0)); // valid IDs, different family
          });
        }
        await expectRefused(dst, clip.clipboard);
        expect(create).toHaveBeenCalledOnce();
      } finally { dst.editor.dispose(); }
    },
  );

  it.each(["missing", "no-op"])("refuses a destination alignment setter that is %s", async mode => {
    const dst = await setup("hwpx", portableFixture("rectangle"));
    const clip = objectClip(JSON.stringify(textboxEnvelope()));
    try {
      if (mode === "missing") {
        Object.defineProperty(dst.doc, "applyParaFormatInCellByPath", { value: undefined });
        Object.defineProperty(dst.doc, "applyParaFormatInCell", { value: undefined });
      } else {
        vi.spyOn(dst.doc, "applyParaFormatInCellByPath").mockReturnValue('{"ok":true}');
      }
      await expectRefused(dst, clip.clipboard);
    } finally { dst.editor.dispose(); }
  });

  it("refuses a character formatting setter reporting success without applying it", async () => {
    const dst = await setup("hwpx", portableFixture("rectangle"));
    const clip = objectClip(JSON.stringify(textboxEnvelope(family)));
    try {
      const setter = vi.spyOn(dst.doc, "applyCharFormatInCellByPath").mockReturnValue('{"ok":true}');
      await expectRefused(dst, clip.clipboard);
      expect(setter).toHaveBeenCalledOnce();
    } finally { dst.editor.dispose(); }
  });

  it("keeps the destination's default font when the payload has no family requirement", async () => {
    const dst = await setup("hwpx");
    const clip = objectClip(JSON.stringify(textboxEnvelope()));
    Object.defineProperty(dst.doc, "resolveDocumentFontFamily", { value: undefined });
    try {
      expect(await dst.editor.executeClipboard("edit.paste", () => true, clip.clipboard)).toBe(true);
      await dst.confirm();
      const file = new engine.HwpDocument(dst.doc.exportHwpx()) as RhwpDocument;
      try {
        expect(JSON.parse(file.getCellCharPropertiesAt!(0, 0, shapes(file)[0]!.controlIdx, 0, 0, 3)))
          .toMatchObject({ bold: true, fontFamilies: Array(7).fill("함초롬바탕") });
      } finally { file.free(); }
    } finally { dst.editor.dispose(); }
  });

  const invalidRuns = [
    ["leading gap", [[1, 4]]],
    ["interior gap", [[0, 1], [2, 4]]],
    ["trailing gap", [[0, 3]]],
    ["overlap", [[0, 3], [2, 4]]],
    ["out of bounds", [[0, 5]]],
    ["incorrect ordering", [[2, 4], [0, 2]]],
  ] as const;

  it.each(invalidRuns)("refuses source inventory and clipboard payload with %s", async (_label, spans) => {
    const src = await setup("hwpx", portableFixture());
    const dst = await setup("hwpx", portableFixture("rectangle"));
    const clip = objectClip();
    try {
      src.pick(shapes(src.doc)[0]!);
      const before = src.doc.exportHwpx();
      const original = src.doc.getFormattingRunsByPath!.bind(src.doc);
      vi.spyOn(src.doc, "getFormattingRunsByPath").mockImplementation((...args) => {
        const data = JSON.parse(original(...args));
        data.fontRuns = spans.map(([start, end]) => [start, end, data.fontRuns[0][2], 1]);
        return JSON.stringify(data);
      });
      expect(await src.editor.executeClipboard("edit.copy", () => true, clip.clipboard)).toBe(true);
      expect(parseObjectClipboardPayload(clip.payload())).not.toHaveProperty("portable");
      await expectRefused(dst, clip.clipboard);
      expect(src.doc.exportHwpx()).toEqual(before);

      const tampered = JSON.parse(JSON.stringify(textboxEnvelope()));
      tampered.portable.paragraphs[0].runs = spans.map(([start, end]) => ({ start, end, bold: true }));
      await expectRefused(dst, objectClip(JSON.stringify(tampered)).clipboard);
    } finally { src.editor.dispose(); dst.editor.dispose(); }
  });

  it.each(["dotted outline", "unreadable alignment"] as const)("refuses cross-document paste from a source with %s", async reason => {
    // Release ShapeBorderLine uses 3 for DOT, which is also the HWPX round-trip mapping.
    const src = await setup("hwpx", reason === "dotted outline" ? portableFixture("rectangle", 3) : portableFixture());
    const dst = await setup("hwpx", portableFixture("rectangle"));
    const clip = objectClip();
    try {
      const frame = shapes(src.doc)[0]!;
      if (reason === "dotted outline") expect(props(src.doc, frame.controlIdx).lineType).toBe(3);
      else vi.spyOn(src.doc, "getCellParaPropertiesAtByPath").mockReturnValue("{}");
      src.pick(frame);
      const before = src.doc.exportHwpx();
      expect(await src.editor.executeClipboard("edit.copy", () => true, clip.clipboard)).toBe(true);
      expect(parseObjectClipboardPayload(clip.payload())).not.toHaveProperty("portable");
      await expectRefused(dst, clip.clipboard);
      expect(src.doc.exportHwpx()).toEqual(before);
    } finally { src.editor.dispose(); dst.editor.dispose(); }
  });
});

describe("B3.2 portable textbox and picture property evidence", () => {
  const badTextboxProperties = [
    ["tbVerticalAlign", "Outside"], ["tbVerticalAlign", undefined],
    ["tbMarginLeft", undefined], ["tbMarginRight", null], ["tbMarginTop", "32"],
    ["tbMarginBottom", 0.5], ["tbMarginLeft", 32768],
  ] as const;
  const badPictureProperties = [
    ["borderColor", undefined], ["borderColor", null], ["borderWidth", undefined], ["borderWidth", 0.5],
    ["borderType", undefined], ["borderType", "0"], ["borderType", 1],
    ["cropLeft", undefined], ["cropTop", null], ["cropRight", -1], ["cropBottom", "0"],
    ["cropBottom", 2_000_001], ["cropReferenceWidth", 1800],
  ] as const;

  for (const kind of ["picture", "textbox"] as const) {
    const getter = kind === "picture" ? "getPictureProperties" : "getShapeProperties";
    const bad = kind === "picture" ? badPictureProperties : badTextboxProperties;
    it.each(bad)(`${kind} refuses ${getter}.%s = %s without destination mutation`, async (key, value) => {
      const src = await setup("hwpx", kind === "picture" ? pictureFixture(true) : portableFixture());
      const dst = await setup("hwpx", portableFixture("rectangle"));
      const clip = objectClip();
      try {
        const frames = JSON.parse(src.doc.getPageControlLayout!(0)).controls as Frame[];
        const frame = frames.find(f => f.type === (kind === "picture" ? "image" : "shape"))!;
        expect(src.pick(frame).kind).toBe(kind === "picture" ? "picture" : "textBox");
        const before = src.doc.exportHwpx();
        const original = src.doc[getter]!.bind(src.doc);
        expect(JSON.parse(original(0, 0, frame.controlIdx))[key]).not.toBe(value);
        vi.spyOn(src.doc, getter).mockImplementation((...args) =>
          JSON.stringify({ ...JSON.parse(original(...args)), [key]: value }));
        const insert = vi.spyOn(dst.doc, kind === "picture" ? "insertPicture" : "createShapeControl");
        expect(await src.editor.executeClipboard("edit.copy", () => true, clip.clipboard)).toBe(true);
        expect(parseObjectClipboardPayload(clip.payload())).toMatchObject({ version: 3, sourceFormat: "hwpx" });
        expect(parseObjectClipboardPayload(clip.payload())).not.toHaveProperty("portable");
        await expectRefused(dst, clip.clipboard);
        expect(insert).not.toHaveBeenCalled();
        expect(src.doc.exportHwpx()).toEqual(before);
      } finally { src.editor.dispose(); dst.editor.dispose(); }
    });
  }

  it.each(["NONE", "SOLID", "missing crop edge", "omitted crop"] as const)(
    "handles real HWPX picture metadata %s", async property => {
      // Insert input XML the existing setters cannot produce, while opening
      // the package and running the clipboard against the real Release model.
      const bytes = execFileSync("python3", ["-c", `
import io, re, sys, zipfile
case = sys.argv[1]
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as src:
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as dst:
        for entry in src.infolist():
            data = src.read(entry)
            if entry.filename == 'Contents/section0.xml':
                if case in ('NONE', 'SOLID'):
                    line = f'<hp:lineShape color="#000000" width="0" style="{case}"/>'.encode()
                    assert b'<hp:imgRect>' in data
                    data = data.replace(b'<hp:imgRect>', line + b'<hp:imgRect>', 1)
                else:
                    replacement = b'<hp:imgClip left="0" right="3600" top="0"/>' if case == 'missing crop edge' else b''
                    data, count = re.subn(rb'<hp:imgClip [^>]*/>', replacement, data)
                    assert count == 1
            dst.writestr(entry, data)
    sys.stdout.buffer.write(out.getvalue())
`, property], { input: pictureFixture() });
      const src = await setup("hwpx", bytes);
      const dst = await setup("hwpx");
      const clip = objectClip();
      try {
        const picture = (doc: RhwpDocument) =>
          (JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[]).find(f => f.type === "image")!;
        const frame = picture(src.doc);
        const before = src.doc.exportHwpx();
        const none = property === "omitted crop";
        const expected = {
          borderType: property === "SOLID" ? -1 : 0, borderColor: 0, borderWidth: 0,
          cropRect: property === "missing crop edge" ? null
            : { left: 0, top: 0, right: none ? 0 : 3600, bottom: none ? 0 : 4800 },
        };
        expect(JSON.parse(src.doc.getPictureProperties!(0, 0, frame.controlIdx))).toMatchObject(expected);
        src.pick(frame);
        expect(await src.editor.executeClipboard("edit.copy", () => true, clip.clipboard)).toBe(true);
        if (property === "SOLID" || property === "missing crop edge") {
          expect(parseObjectClipboardPayload(clip.payload())).not.toHaveProperty("portable");
          await expectRefused(dst, clip.clipboard);
        } else {
          expect(await dst.editor.executeClipboard("edit.paste", () => true, clip.clipboard)).toBe(true);
          await dst.confirm();
          const reopened = new engine.HwpDocument(dst.doc.exportHwpx()) as RhwpDocument;
          try {
            expect(JSON.parse(reopened.getPictureProperties!(0, 0, picture(reopened).controlIdx))).toMatchObject(expected);
          } finally { reopened.free(); }
        }
        expect(src.doc.exportHwpx()).toEqual(before);
      } finally { src.editor.dispose(); dst.editor.dispose(); }
    },
  );
});
