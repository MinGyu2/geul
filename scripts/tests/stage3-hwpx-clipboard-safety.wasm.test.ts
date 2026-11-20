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
    const norm = (s: string) => (JSON.parse(s) as Record<string, unknown>[]).map(c =>
      c.ctrlId === "atno" ? { ...c, pos: "atno" } : c);
    expect(norm(reopened.getControls())).toEqual(norm(live.getControls()));
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

describe("HWPX object clipboard fidelity boundary", () => {
  for (const kind of ["caption", "mixed", "plainShape", "plainTextBox"] as const) it(`B3.2: pastes cross-document HWPX ${kind} faithfully with Undo/Redo and reopen`, async () => {
    const fixture = engine.HwpDocument.createEmpty();
    fixture.createBlankDocument(); fixture.insertText(0, 0, 0, "seed");
    const box = kind === "mixed" || kind === "plainTextBox";
    const result = JSON.parse(fixture.createShapeControl(JSON.stringify({sectionIdx:0, paraIdx:0, charOffset:0, shapeType:box ? "textbox" : "rectangle", width:5000, height:3000, treatAsChar:false, textWrap:"Square", horzOffset:2000, vertOffset:2000})));
    expect(result.ok).toBe(true);
    if (kind === "caption") {
      expect(JSON.parse(fixture.setShapeProperties(0, 0, result.controlIdx, '{"hasCaption":true,"captionDirection":"Top","fillType":"solid","fillBgColor":11223344}')).ok).toBe(true);
      const capLen = fixture.getCellParagraphLength(0, 0, result.controlIdx, 65534, 0);
      expect(JSON.parse(fixture.insertTextInCell(0, 0, result.controlIdx, 65534, 0, capLen, "cap bold")).ok).toBe(true);
      const capPath0 = JSON.stringify([{ controlIndex: result.controlIdx, cellIndex: 65534, cellParaIndex: 0 }]);
      expect(JSON.parse(fixture.applyCharFormatInCellByPath(0, 0, capPath0, capLen + 4, capLen + 8, '{"bold":true}')).ok).toBe(true);
      expect(JSON.parse(fixture.splitParagraphInCell(0, 0, result.controlIdx, 65534, 0, capLen + 8)).ok).toBe(true);
      expect(JSON.parse(fixture.insertTextInCell(0, 0, result.controlIdx, 65534, 1, 0, "cap line 2")).ok).toBe(true);
    }
    if (box) {
      expect(JSON.parse(fixture.insertTextInCell(0,0,result.controlIdx,0,0,0,"plain bold")).ok).toBe(true);
      if (kind === "mixed") {
        const boxPath0 = JSON.stringify([{ controlIndex: result.controlIdx, cellIndex: 0, cellParaIndex: 0 }]);
        expect(JSON.parse(fixture.applyCharFormatInCellByPath(0,0,boxPath0,6,10,'{"bold":true,"italic":true,"fontSize":1400,"textColor":"#cc2200","shadeColor":"#ffff00"}')).ok).toBe(true);
        expect(JSON.parse(fixture.applyParaFormatInCellByPath(0,0,boxPath0,'{"alignment":"center"}')).ok).toBe(true);
        expect(JSON.parse(fixture.splitParagraphInCell(0,0,result.controlIdx,0,0,10)).ok).toBe(true);
        expect(JSON.parse(fixture.insertTextInCell(0,0,result.controlIdx,0,1,0,"second line")).ok).toBe(true);
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

      expect(await dst.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true);
      await dst.confirm();
      expect(src.doc.exportHwpx()).toEqual(sourceBefore);

      const pasted = shapes(dst.doc);
      expect(pasted).toHaveLength(1);
      const pastedCtrl = pasted[0]!.controlIdx;
      if (kind === "caption") {
        expect(props(dst.doc, pastedCtrl).hasCaption).toBe(true);
        expect(props(dst.doc, pastedCtrl).captionDirection).toBe("Top");
        expect(dst.doc.getCellParagraphCount!(0, 0, pastedCtrl, 65534)).toBe(2);
        const p0Len = dst.doc.getCellParagraphLength!(0, 0, pastedCtrl, 65534, 0);
        expect(dst.doc.getTextInCell!(0, 0, pastedCtrl, 65534, 0, 0, p0Len)).toContain("cap bold");
        expect(JSON.parse(dst.doc.getCellCharPropertiesAt!(0, 0, pastedCtrl, 65534, 0, p0Len - 1)).bold).toBe(true);
        const p1Len = dst.doc.getCellParagraphLength!(0, 0, pastedCtrl, 65534, 1);
        expect(dst.doc.getTextInCell!(0, 0, pastedCtrl, 65534, 1, 0, p1Len)).toBe("cap line 2");
      }
      if (box) {
        const len0 = dst.doc.getCellParagraphLength!(0, 0, pastedCtrl, 0, 0);
        expect(dst.doc.getTextInCell!(0, 0, pastedCtrl, 0, 0, 0, len0)).toBe("plain bold");
      }
      if (kind === "mixed") {
        expect(dst.doc.getCellParagraphCount!(0, 0, pastedCtrl, 0)).toBe(2);
        const c6 = JSON.parse(dst.doc.getCellCharPropertiesAt!(0, 0, pastedCtrl, 0, 0, 7));
        expect(c6).toMatchObject({ bold: true, italic: true, fontSize: 1400, textColor: "#cc2200", shadeColor: "#ffff00" });
        expect(JSON.parse(dst.doc.getCellCharPropertiesAt!(0, 0, pastedCtrl, 0, 0, 1)).bold).toBe(false);
        const boxPath0 = JSON.stringify([{ controlIndex: pastedCtrl, cellIndex: 0, cellParaIndex: 0 }]);
        expect(JSON.parse(dst.doc.getCellParaPropertiesAtByPath!(0, 0, boxPath0)).alignment).toBe("center");
      }

      // Repeated cross-doc paste creates a second independent object; Undo/Redo works cleanly.
      expect(await dst.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true);
      await dst.confirm();
      expect(shapes(dst.doc)).toHaveLength(2);
      expect(dst.editor.undo()).toBe(true);
      await dst.confirm();
      expect(shapes(dst.doc)).toHaveLength(1);
      expect(dst.editor.redo()).toBe(true);
      await dst.confirm();
      expect(shapes(dst.doc)).toHaveLength(2);

      const exported = dst.doc.exportHwpxWithReport();
      try {
        expectReopenEvidence(dst.doc, exported.takeBytes(), exported.contentLoss());
      } finally { exported.free(); }
    } finally {src.editor.dispose(); dst.editor.dispose();}
  });

  it("B3.2: pastes cross-doc captioned HWPX picture and rejects tampered/unsupported portable payloads", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAADAAAABACAIAAADTQmMRAAAATklEQVR4nO3OMQ0AIBAAsVfCjH8pKMIFx9CkAjpnr69MPhASEhKqB0JCQkL1QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF4XmIMR3l0LcAAAAAElFTkSuQmCC",
      "base64",
    );
    const fix = engine.HwpDocument.createEmpty();
    fix.createBlankDocument(); fix.insertText(0, 0, 0, "pic src");
    const pic = JSON.parse(fix.insertPicture(0, 0, 0, "[]", png, 4200, 2100, 48, 64, "png", "b32-alt"));
    expect(pic.ok).toBe(true);
    expect(JSON.parse(fix.setPictureProperties(0, 0, pic.controlIdx, JSON.stringify({
      treatAsChar: false, textWrap: "Square", horzOffset: 1000, vertOffset: 1200,
      cropLeft: 120, cropTop: 60, hasCaption: true, captionDirection: "Bottom", captionSpacing: 150,
    }))).ok).toBe(true);
    const cap0Len = fix.getCellParagraphLength(0, 0, pic.controlIdx, 0, 0);
    expect(JSON.parse(fix.insertTextInCell(0, 0, pic.controlIdx, 0, 0, cap0Len, "pic cap")).ok).toBe(true);
    const srcBytes = fix.exportHwpx(); fix.free();

    const src = await setup("hwpx", srcBytes); const dst = await setup("hwpx");
    let payload = "", plain = "";
    const clip: PlainClipboard = { readText: async () => plain, writeText: async () => {}, writeStructured: async (_m, d, t) => { payload = d; plain = t; }, readStructured: async m => m === OBJECT_CLIPBOARD_MIME ? payload : null };
    try {
      const picFrame = (JSON.parse(src.doc.getPageControlLayout!(0)).controls as Frame[]).find(c => c.type === "image")!;
      src.pick(picFrame);
      expect(await src.editor.executeClipboard("edit.copy", () => true, clip)).toBe(true);
      expect(await dst.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true);
      await dst.confirm();

      const dstPics = (JSON.parse(dst.doc.getPageControlLayout!(0)).controls as Frame[]).filter(c => c.type === "image");
      expect(dstPics).toHaveLength(1);
      const dPicCtrl = dstPics[0]!.controlIdx;
      const dPicProps = JSON.parse(dst.doc.getPictureProperties!(0, 0, dPicCtrl));
      expect(dPicProps).toMatchObject({ width: 4200, height: 2100, cropLeft: 120, cropTop: 60, description: "b32-alt", hasCaption: true, captionSpacing: 150 });
      expect(Buffer.from(dst.doc.getControlImageData!(0, 0, "[]", dPicCtrl))).toEqual(png);
      const dCapLen = dst.doc.getCellParagraphLength!(0, 0, dPicCtrl, 0, 0);
      expect(dst.doc.getTextInCell!(0, 0, dPicCtrl, 0, 0, 0, dCapLen)).toContain("pic cap");

      const exported = dst.doc.exportHwpxWithReport();
      try {
        expectReopenEvidence(dst.doc, exported.takeBytes(), exported.contentLoss());
      } finally { exported.free(); }

      // Tampered MIME (PNG bytes labeled image/jpeg) and malformed run ranges must fail closed without mutating dst.
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
