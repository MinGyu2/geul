// P6-OTHER-CAP: the RHWP group owns a real caption list, but selection must expose only
// caption operations whose exact group/caption owner can be proven.
// @vitest-environment jsdom
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentSessions } from "../../src/adapters/sessions";
import { objectEditRequest } from "../../src/commands/objectSelection";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import { readRhwpGeneration } from "../rhwpAssets";
import { FIXED_MEMORY_BYTES, controlledBackend, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";

const assets = resolve("public/rhwp");
const identity = await readRhwpGeneration(assets, "release");
const generation = resolve(assets, "generations", identity.generation);
const engine = createRequire(import.meta.url)(resolve(generation, "rhwp.js"));
engine.initSync({ module: readFileSync(resolve(generation, "rhwp_bg.wasm")) });

type GroupFactory = RhwpDocument & {
  groupShapes(json: string): string;
  setControlLock(para: number, index: number, locked: boolean): string;
};
type Frame = { type: string; x: number; y: number; w: number; h: number; stableIndex: [number, number, number] };

function groupWithCaption(locked = false, format: "hwp" | "hwpx" = "hwpx") {
  const doc = engine.HwpDocument.createEmpty() as GroupFactory;
  try {
    doc.createBlankDocument();
    doc.insertText(0, 0, 0, "group caption anchor");
    const add = (shapeType: string, x: number) => JSON.parse(doc.createShapeControl!(JSON.stringify({
      sectionIdx: 0, paraIdx: 0, charOffset: 0, shapeType,
      width: 4200, height: 3000, treatAsChar: false, textWrap: "Square", horzOffset: x, vertOffset: 2400,
    }))) as { ok: boolean; controlIdx: number };
    const rect = add("rectangle", 800);
    const ellipse = add("ellipse", 5400);
    expect(rect.ok && ellipse.ok).toBe(true);
    const grouped = JSON.parse(doc.groupShapes(JSON.stringify({ sectionIdx: 0, targets: [
      { paraIdx: 0, controlIdx: rect.controlIdx }, { paraIdx: 0, controlIdx: ellipse.controlIdx },
    ] }))) as { ok: boolean; controlIdx: number };
    expect(grouped.ok).toBe(true);
    expect(JSON.parse(doc.setShapeProperties!(0, 0, grouped.controlIdx, JSON.stringify({
      width: 20000, height: 4000, hasCaption: true, captionDirection: "Bottom", captionVertAlign: "Top", captionWidth: 20000,
      captionSpacing: 100, captionIncludeMargin: false,
    }))).ok).toBe(true);
    const length = doc.getCellParagraphLength!(0, 0, grouped.controlIdx, 65534, 0);
    expect(JSON.parse(doc.insertTextInCell!(0, 0, grouped.controlIdx, 65534, 0, length, "Group-owned caption")).ok).toBe(true);
    if (locked) expect(JSON.parse(doc.setControlLock(0, grouped.controlIdx, true)).ok).toBe(true);
    const properties = JSON.parse(doc.getShapeProperties!(0, 0, grouped.controlIdx));
    expect(properties).toMatchObject({ hasCaption: true, captionDirection: "Bottom", captionWidth: 20000 });
    const count = doc.getCellParagraphCount!(0, 0, grouped.controlIdx, 65534);
    expect(count).toBe(1);
    expect(doc.getTextInCell!(0, 0, grouped.controlIdx, 65534, 0, 0, doc.getCellParagraphLength!(0, 0, grouped.controlIdx, 65534, 0)))
      .toContain("Group-owned caption");
    return format === "hwp" ? doc.exportHwp!() : doc.exportHwpx!();
  } finally {
    doc.free();
  }
}

async function openSession(bytes: Uint8Array, format: "hwp" | "hwpx" = "hwpx") {
  const control = controlledBackend();
  const sessions = new DocumentSessions(control.backend);
  const opening = sessions.open("/group-caption.hwpx");
  control.take("open").reply(ok(info({ displayName: `group-caption.${format}`, format })));
  await opening;

  let doc: RhwpDocument | undefined;
  const editor = new RhwpEditorSession(1, control.backend, sessions,
    async () => ({
      openDocument: (data: Uint8Array) => {
        const opened = new engine.HwpDocument(data) as RhwpDocument;
        doc ??= opened;
        return opened;
      },
      memoryBytes: () => FIXED_MEMORY_BYTES,
    }), { natural: null });
  const loading = editor.load();
  control.take("load").reply(loaded(bytes));
  await flush();
  control.take("session").reply(ok(info({ format, state: "loading", sequence: 1, loadGeneration: 1 })));
  control.take("setState").reply(ok(info({ format, state: "ready", sequence: 2, loadGeneration: 1 })));
  await loading;
  if (format === "hwp") {
    control.take("original").reply(ok(bytes));
    await flush();
    control.take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
    await flush();
  }
  const confirm = async (revision: number) => {
    const pending = control.take("commit");
    pending.reply(ok(info({ format: "hwpx", state: "ready", revision, dirty: true, loadGeneration: 1, sequence: revision + 2 })));
    await flush();
  };
  return { control, doc: doc!, editor, confirm };
}

describe("P6-OTHER-CAP HWPX group ownership", () => {
  it("edits the group-owned caption text through its exact caption address and reopens it", async () => {
    const { doc, editor, confirm } = await openSession(groupWithCaption());
    try {
      const text = () => doc.getTextInCell!(0, 0, 2, 65534, 0, 0, doc.getCellParagraphLength!(0, 0, 2, 65534, 0));
      const before = text();
      const controlsBefore = doc.getControls!();
      const end = doc.getCellParagraphLength!(0, 0, 2, 65534, 0);
      const cursor = JSON.parse(doc.getCursorRectInCell(0, 0, 2, 65534, 0, end));
      expect(editor.pointAt(cursor.pageIndex, cursor.x, cursor.y + cursor.height / 2, false)).toBe(true);
      expect(editor.caret.cell).toMatchObject({ parentParagraph: 0, control: 2, cell: 65534, cellParagraph: 0, caption: true });
      expect(text()).toContain("Group-owned caption");

      expect(editor.typeText(" edited")).toBe(true);
      await confirm(1);
      expect(text()).toBe(before + " edited");
      expect(editor.undo()).toBe(true);
      await confirm(2);
      expect(text()).toBe(before);
      expect(editor.redo()).toBe(true);
      await confirm(3);

      const exported = doc.exportHwpxWithReport!();
      try {
        const loss = exported.contentLoss(), bytes = exported.takeBytes();
        expect(JSON.parse(loss)).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(bytes) as RhwpDocument;
        try {
          expect(reopened.getControls!()).toBe(controlsBefore);
          expect(reopened.getTextInCell!(0, 0, 2, 65534, 0, 0,
            reopened.getCellParagraphLength!(0, 0, 2, 65534, 0))).toBe(before + " edited");
          expect(JSON.parse(reopened.getShapeProperties!(0, 0, 2))).toMatchObject({ hasCaption: true, captionDirection: "Bottom" });
        } finally { reopened.free(); }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("exposes the owned group caption placement for safe editing after reopen", async () => {
    const { doc, editor, confirm } = await openSession(groupWithCaption());
    try {
      const frame = (JSON.parse(doc!.getPageControlLayout!(0)).controls as Frame[]).find(item => item.type === "group");
      expect(frame).toBeDefined();
      expect(editor.pointAt(0, frame!.x + frame!.w / 2, frame!.y + frame!.h / 2, false, false, true)).toBe(true);
      const selected = editor.objectSelection!;
      expect(selected.kind).toBe("group");
      expect(selected.captionSide).toBe("Bottom");
      expect(selected.captionSpacing).toBe(100);
      expect(selected.operations).toContain("captionSide");
      expect(editor.execute("object.edit", objectEditRequest(selected, { kind: "captionSide", side: "Right" })).accepted).toBe(true);
      await confirm(1);
      expect(JSON.parse(doc.getShapeProperties!(0, 0, 2))).toMatchObject({ captionDirection: "Right", captionSpacing: 100 });
      expect(editor.undo()).toBe(true);
      await confirm(2);
      expect(JSON.parse(doc.getShapeProperties!(0, 0, 2))).toMatchObject({ captionDirection: "Bottom", captionSpacing: 100 });
      expect(editor.redo()).toBe(true);
      await confirm(3);
      expect(JSON.parse(doc.getShapeProperties!(0, 0, 2))).toMatchObject({ captionDirection: "Right", captionSpacing: 100 });

      const exported = doc.exportHwpxWithReport!();
      try {
        expect(JSON.parse(exported.contentLoss())).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(exported.takeBytes()) as RhwpDocument;
        try {
          expect(JSON.parse(reopened.getShapeProperties!(0, 0, 2))).toMatchObject({
            shapeType: "group", captionDirection: "Right", captionSpacing: 100,
          });
          expect(reopened.getControls!()).toBe(doc.getControls!());
          const frame = (JSON.parse(reopened.getPageControlLayout!(0)).controls as Frame[]).find(item => item.type === "group");
          const captionLength = reopened.getCellParagraphLength!(0, 0, 2, 65534, 0);
          const caret = JSON.parse(reopened.getCursorRectInCell(0, 0, 2, 65534, 0, captionLength));
          expect(frame).toBeDefined();
          expect(caret.x).toBeGreaterThan(frame!.x + frame!.w);
        } finally { reopened.free(); }
      } finally { exported.free(); }
    } finally {
      editor.dispose();
    }
  });

  it("does not expose or mutate a locked group's caption", async () => {
    const { doc, editor } = await openSession(groupWithCaption(true));
    try {
      const frame = (JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[]).find(item => item.type === "group");
      expect(frame).toBeDefined();
      expect(editor.pointAt(0, frame!.x + frame!.w / 2, frame!.y + frame!.h / 2, false, false, true)).toBe(true);
      const selected = editor.objectSelection!;
      expect(selected.kind).toBe("group");
      expect(selected.captionSide).toBeUndefined();
      expect(selected.operations).not.toContain("captionSide");
      expect(editor.execute("object.edit", objectEditRequest(selected, { kind: "captionSide", side: "Right" })).accepted).toBe(false);
      expect(JSON.parse(doc.getShapeProperties!(0, 0, 2))).toMatchObject({ hasCaption: true, captionDirection: "Bottom" });
    } finally {
      editor.dispose();
    }
  });

  it("edits a HWP5 group-owned caption and preserves it through Undo/Redo and CFB reopen", async () => {
    const { doc, editor, confirm } = await openSession(groupWithCaption(false, "hwp"), "hwp");
    try {
      const text = () => doc.getTextInCell!(0, 0, 2, 65534, 0, 0,
        doc.getCellParagraphLength!(0, 0, 2, 65534, 0));
      const before = text();
      const controlsBefore = doc.getControls!();
      const end = doc.getCellParagraphLength!(0, 0, 2, 65534, 0);
      const cursor = JSON.parse(doc.getCursorRectInCell(0, 0, 2, 65534, 0, end));
      expect(editor.pointAt(cursor.pageIndex, cursor.x, cursor.y + cursor.height / 2, false)).toBe(true);
      expect(editor.caret.cell).toMatchObject({ parentParagraph: 0, control: 2, cell: 65534, cellParagraph: 0, caption: true });
      expect(editor.typeText(" edited")).toBe(true);
      await confirm(1);
      expect(text()).toBe(before + " edited");
      expect(editor.undo()).toBe(true);
      await confirm(2);
      expect(text()).toBe(before);
      expect(editor.redo()).toBe(true);
      await confirm(3);

      const exported = doc.exportHwpWithReport!();
      try {
        expect(JSON.parse(exported.contentLoss())).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(exported.takeBytes()) as RhwpDocument;
        try {
          expect(reopened.getControls!()).toBe(controlsBefore);
          expect(reopened.getTextInCell!(0, 0, 2, 65534, 0, 0,
            reopened.getCellParagraphLength!(0, 0, 2, 65534, 0))).toBe(before + " edited");
          expect(JSON.parse(reopened.getShapeProperties!(0, 0, 2))).toMatchObject({ shapeType: "group", hasCaption: true });
        } finally { reopened.free(); }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });
});
