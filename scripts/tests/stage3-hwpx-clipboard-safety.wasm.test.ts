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

describe("HWPX object clipboard fidelity boundary", () => {
  for (const kind of ["caption", "mixed", "plainShape", "plainTextBox"] as const) it(`refuses cross-document ${kind} without mutation`, async () => {
    const fixture = engine.HwpDocument.createEmpty();
    fixture.createBlankDocument(); fixture.insertText(0, 0, 0, "seed");
    const box = kind === "mixed" || kind === "plainTextBox";
    const result = JSON.parse(fixture.createShapeControl(JSON.stringify({sectionIdx:0, paraIdx:0, charOffset:0, shapeType:box ? "textbox" : "rectangle", width:5000, height:3000, treatAsChar:false, textWrap:"Square", horzOffset:2000, vertOffset:2000})));
    expect(result.ok).toBe(true);
    if (kind === "caption") expect(JSON.parse(fixture.setShapeProperties(0, 0, result.controlIdx, '{"hasCaption":true}')).ok).toBe(true);
    if (box) {
      expect(JSON.parse(fixture.insertTextInCell(0,0,result.controlIdx,0,0,0,"plain bold")).ok).toBe(true);
      if (kind === "mixed") expect(JSON.parse(fixture.applyCharFormatInCell(0,0,result.controlIdx,0,0,6,10,'{"bold":true}')).ok).toBe(true);
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
      expect(parseObjectClipboardPayload(payload)).toMatchObject({version:3, object:box ? "textBox" : "shape"});
      const before = dst.doc.exportHwpx(); const snapshot = dst.editor.snapshot();
      expect(await dst.editor.executeClipboard("edit.paste", () => true, clip)).toBe(false);
      expect(dst.doc.exportHwpx()).toEqual(before);
      expect(dst.editor.snapshot()).toEqual(snapshot);
      expect(dst.calls.filter(c => c.method === "commit")).toHaveLength(0);
      expect(src.doc.exportHwpx()).toEqual(sourceBefore);
      if (kind === "plainShape") {
        // An old or forged, schema-valid portable snapshot cannot grant admission.
        const parsed = JSON.parse(payload);
        parsed.portable = {shapeType:"rectangle", width:5000,height:3000,horzOffset:2000,vertOffset:2000,treatAsChar:false,textWrap:"Square",rotationAngle:0,horzFlip:false,vertFlip:false,borderColor:0,borderWidth:0,fillType:"none"};
        payload = JSON.stringify(parsed);
        expect(parseObjectClipboardPayload(payload)).not.toBeNull();
        expect(await dst.editor.executeClipboard("edit.paste", () => true, clip)).toBe(false);
        expect(dst.doc.exportHwpx()).toEqual(before); expect(dst.editor.snapshot()).toEqual(snapshot);
      }
    } finally {src.editor.dispose(); dst.editor.dispose();}
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
});
