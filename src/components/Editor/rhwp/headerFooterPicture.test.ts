import { describe, expect, it } from "vitest";
import { objectEditMatches, objectEditRequest } from "../../../commands/objectSelection";
import { documentCommandState } from "../../../commands/capability";
import { RhwpEditorSession } from "./RhwpEditorSession";
import type { RhwpDocument } from "./rhwpModule";
import { inspectRhwpHeaderFooterPicture } from "./pictureProperties";
import { base, controlledBackend, FakeDocument, flush, info, loaded, ok } from "./testing";
import { DocumentSessions } from "../../../adapters/sessions";

const picture = () => ({
  width: 1000,
  height: 500,
  treatAsChar: false,
  textWrap: "Square",
  horzAlign: "Left",
  vertAlign: "Top",
  horzOffset: 100,
  vertOffset: 200,
  sizeProtect: false,
  hasCaption: false,
  rotationAngle: 0,
  horzFlip: false,
  vertFlip: false,
});

const inlinePicture = () => ({
  ...picture(),
  treatAsChar: true,
  horzOffset: 0,
  vertOffset: 0,
  originalWidth: 1000,
  originalHeight: 500,
  cropLeft: 0,
  cropTop: 0,
  cropRight: 0,
  cropBottom: 0,
});

async function headerPictureSession(initialProperties = picture(), format: "hwp" | "hwpx" = "hwpx") {
  const { backend, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open(`/a.${format}`);
  take("open").reply(ok({ ...base, format, displayName: `a.${format}` }));
  await opening;
  const doc = new FakeDocument(["body"]);
  doc.format = format;
  let properties = initialProperties;
  const snapshots = new Map<number, ReturnType<typeof picture>>();
  const originalSaveSnapshot = doc.saveSnapshot.bind(doc);
  const originalRestoreSnapshot = doc.restoreSnapshot.bind(doc);
  doc.saveSnapshot = () => {
    const id = originalSaveSnapshot();
    snapshots.set(id, { ...properties });
    return id;
  };
  doc.restoreSnapshot = (id: number) => {
    const result = originalRestoreSnapshot(id);
    properties = { ...snapshots.get(id)! };
    return result;
  };
  const engine = doc as unknown as RhwpDocument;
  engine.getSectionCount = () => 1;
  engine.getParaPropertiesAt = () => JSON.stringify({ headType: "None", paraLevel: 0, numberingId: 0, paraShapeId: 0 });
  engine.getBulletList = () => "[]";
  engine.getPageControlLayout = () => JSON.stringify({ controls: [{
    type: "image", x: 50, y: 50, w: 100, h: 50, secIdx: 0,
    paraIdx: 0, controlIdx: 1, stableIndex: [0, 0, 1], plane: 1, zOrder: 0,
    headerFooter: { kind: "header", outerParaIdx: 0, outerControlIdx: 2 },
  }] });
  engine.getControls = () => JSON.stringify([{ ctrlId: "head", userDesc: "머리말", list: 0, para: 0, controlIndex: 2 }]);
  engine.getHeaderFooterPictureProperties = (section, outerParagraph, outerControl, innerParagraph, innerControl) => {
    expect([section, outerParagraph, outerControl, innerParagraph, innerControl]).toEqual([0, 0, 2, 0, 1]);
    return JSON.stringify(properties);
  };
  engine.setHeaderFooterPictureProperties = (section, outerParagraph, outerControl, innerParagraph, innerControl, json) => {
    expect([section, outerParagraph, outerControl, innerParagraph, innerControl]).toEqual([0, 0, 2, 0, 1]);
    properties = { ...properties, ...JSON.parse(json) };
    return '{"ok":true}';
  };
  const module = { openDocument: () => doc as unknown as RhwpDocument, memoryBytes: () => 64 * 1024 * 1024 };
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module, { history: true });
  const loading = editor.load();
  take("load").reply(loaded());
  await flush();
  take("session").reply(ok({ ...base, format, state: "loading", sequence: 1, loadGeneration: 1 }));
  take("setState").reply(ok({ ...base, format, state: "ready", sequence: 2, loadGeneration: 1 }));
  await loading;
  if (format === "hwp") {
    const original = take("original");
    original.reply(ok(new Uint8Array([1])));
    await flush();
    take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
    await flush();
  }
  return { editor, doc: engine, sessions, take, properties: () => ({ ...properties }) };
}

describe("RHWP header picture ownership", () => {
  it("allows an HWP header picture with its own exact baseline when unrelated HWP structure is incomplete", async () => {
    const { editor, doc } = await headerPictureSession(picture(), "hwp");
    expect(doc.getHeaderFooterPictureProperties).toBeTypeOf("function");
    expect(editor.pointAt(0, 60, 60, false, false, true)).toBe(true);
    expect(editor.objectSelection?.operations).toContain("move");
    expect(editor.objectSelection?.editable).toBe(true);
  });

  it("selects and moves only the exact header picture, with Undo and Redo on that story address", async () => {
    const { editor, take, properties, doc, sessions } = await headerPictureSession();
    expect(inspectRhwpHeaderFooterPicture(doc, {
      section: 0, kind: "header", outerParagraph: 0, outerControl: 2, innerParagraph: 0, innerControl: 1,
    })?.movable).toEqual({ horzOffset: 100, vertOffset: 200 });
    expect(sessions.get(1)?.format).toBe("hwpx");
    expect(editor.snapshot().history).not.toBeNull();
    expect(editor.pointAt(0, 60, 60, false, false, true)).toBe(true);
    const selected = editor.objectSelection!;
    expect(selected.operations).toContain("move");
    expect(selected.operations).toContain("deselect");
    expect(selected.operations).not.toContain("delete");
    expect(selected.operations).not.toContain("copy");

    const edit = objectEditRequest(selected, { kind: "nudge", dx: 3, dy: 2 });
    expect(documentCommandState("object.edit", editor.snapshot())).toEqual({ available: true });
    expect(objectEditMatches(edit, selected)).toBe(true);
    expect(editor.execute("object.edit", edit)).toEqual({ accepted: true });
    expect(properties()).toMatchObject({ horzOffset: 400, vertOffset: 400 });
    take("commit").reply({ ok: true, value: info({ state: "ready", revision: 1, dirty: true, sequence: 4 }) });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(editor.execute("edit.undo")).toEqual({ accepted: true });
    expect(properties()).toMatchObject({ horzOffset: 100, vertOffset: 200 });
    take("commit").reply({ ok: true, value: info({ state: "ready", revision: 2, dirty: true, sequence: 5 }) });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(editor.execute("edit.redo")).toEqual({ accepted: true });
    expect(properties()).toMatchObject({ horzOffset: 400, vertOffset: 400 });
    take("commit").reply({ ok: true, value: info({ state: "ready", revision: 3, dirty: true, sequence: 6 }) });
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it("refuses to mutate a header hit when the model says the owner is a footer", async () => {
    const { editor, doc } = await headerPictureSession();
    doc.getControls = () => JSON.stringify([{ ctrlId: "foot", userDesc: "꼬리말", list: 0, para: 0, controlIndex: 2 }]);
    expect(editor.pointAt(0, 60, 60, false, false, true)).toBe(true);
    expect(editor.objectSelection?.operations).not.toContain("move");
    expect(editor.objectSelection?.editable).toBe(false);
  });

  it("resizes an inline header picture and restores the exact geometry through Undo and Redo", async () => {
    const { editor, take, properties } = await headerPictureSession(inlinePicture());
    expect(editor.pointAt(0, 60, 60, false, false, true)).toBe(true);
    const selected = editor.objectSelection!;
    expect(selected.operations).toContain("resize");
    const request = {
      command: "picture.size" as const,
      selectionEpoch: selected.epoch,
      sessionId: selected.sessionId,
      loadGeneration: selected.loadGeneration,
      revision: selected.revision,
      widthPt: 12,
      heightPt: 6,
    };
    expect(editor.execute("picture.size", request)).toEqual({ accepted: true });
    expect(properties()).toMatchObject({ width: 1200, height: 600 });
    take("commit").reply({ ok: true, value: info({ state: "ready", revision: 1, dirty: true, sequence: 4 }) });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(editor.execute("edit.undo")).toEqual({ accepted: true });
    expect(properties()).toMatchObject({ width: 1000, height: 500 });
    take("commit").reply({ ok: true, value: info({ state: "ready", revision: 2, dirty: true, sequence: 5 }) });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(editor.execute("edit.redo")).toEqual({ accepted: true });
    expect(properties()).toMatchObject({ width: 1200, height: 600 });
    take("commit").reply({ ok: true, value: info({ state: "ready", revision: 3, dirty: true, sequence: 6 }) });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});
