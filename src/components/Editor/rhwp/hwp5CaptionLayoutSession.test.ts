import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DocumentSessions } from "../../../adapters/sessions";
import { documentCommandState } from "../../../commands/capability";
import { objectEditMatches, objectEditRequest, type ObjectEdit } from "../../../commands/objectSelection";
import { readRhwpGeneration } from "../../../../scripts/rhwpAssets";
import { RhwpEditorSession } from "./RhwpEditorSession";
import type { RhwpDocument } from "./rhwpModule";
import { FIXED_MEMORY_BYTES, controlledBackend, info, loaded, ok, flush } from "./testing";

const artifacts = resolve(process.env.GEUL_RHWP_TEST_ARTIFACTS ?? "public/rhwp");
const identity = await readRhwpGeneration(artifacts, "release");
const folder = resolve(artifacts, "generations", identity.generation);
const engine = createRequire(import.meta.url)(resolve(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(resolve(folder, "rhwp_bg.wasm")) });

type Frame = { type: string; x: number; y: number; w: number; h: number; controlIdx: number };
type HwpTestDocument = RhwpDocument & {
  createBlankDocument(): void;
  createShapeControl(json: string): string;
  setControlLock(para: number, control: number, locked: boolean): string;
  exportHwp(): Uint8Array;
};

function fixtureBytes(options: { captionWidth?: number; locked?: boolean } = {}) {
  const doc = engine.HwpDocument.createEmpty() as HwpTestDocument;
  try {
    doc.createBlankDocument();
    doc.insertText(0, 0, 0, "HWP5 caption layout anchor");
    const created = JSON.parse(doc.createShapeControl(JSON.stringify({
      sectionIdx: 0, paraIdx: 0, charOffset: 0, shapeType: "rectangle", width: 6000, height: 3200,
      treatAsChar: false, textWrap: "Square", horzOffset: 4000, vertOffset: 3000,
    }))) as { ok: boolean; controlIdx: number };
    expect(created).toMatchObject({ ok: true, controlIdx: 2 });
    expect(JSON.parse(doc.setShapeProperties!(0, 0, created.controlIdx, JSON.stringify({
      hasCaption: true, captionDirection: "Bottom", captionVertAlign: "Top",
      captionWidth: options.captionWidth ?? 2400, captionSpacing: 100,
    }))).ok).toBe(true);
    if (options.locked) expect(JSON.parse(doc.setControlLock(0, created.controlIdx, true)).ok).toBe(true);
    return doc.exportHwp();
  } finally {
    doc.free();
  }
}

async function setup(bytes: Uint8Array) {
  const control = controlledBackend();
  const sessions = new DocumentSessions(control.backend);
  const opened = sessions.open("/hwp5-caption.hwp");
  const sessionInfo = (patch: Parameters<typeof info>[0]) => info({ ...patch, format: "hwp" });
  control.take("open").reply(ok(sessionInfo({ displayName: "hwp5-caption.hwp" })));
  await opened;
  const doc = new engine.HwpDocument(bytes) as HwpTestDocument;
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
  const shape = () => (JSON.parse(doc.getPageControlLayout!(0)).controls as Frame[]).find(item => item.type === "shape")!;
  const pick = () => {
    const frame = shape();
    expect(editor.pointAt(0, frame.x + frame.w / 2, frame.y + frame.h / 2, false, false, true)).toBe(true);
    return editor.objectSelection!;
  };
  const edit = (value: ObjectEdit) => editor.execute("object.edit", objectEditRequest(editor.objectSelection!, value));
  const prepare = async () => {
    control.take("original").reply(ok(bytes));
    await flush();
    control.take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
    await flush();
  };
  return { control, doc, editor, shape, pick, edit, confirm, prepare };
}

describe("HWP5 caption layout editing", () => {
  it("changes owned shape direction and alignment with history and lossless reopen", async () => {
    const bytes = fixtureBytes();
    const { doc, editor, pick, edit, confirm, prepare } = await setup(bytes);
    try {
      await prepare();
      const initial = pick();
      expect(initial.captionSide).toBe("Bottom");
      expect(initial.captionLateral).toBe(true);
      expect(initial.operations).toContain("captionSide");
      expect(initial.operations).not.toContain("captionVerticalAlign");
      const request = objectEditRequest(initial, { kind: "captionSide", side: "Right" });
      expect(objectEditMatches(request, initial)).toBe(true);
      expect(documentCommandState("object.edit", editor.snapshot())).toEqual({ available: true });
      const setter = vi.spyOn(doc, "setShapeProperties");
      const edited = editor.execute("object.edit", request);
      expect(setter).toHaveBeenCalled();
      expect(edited).toEqual({ accepted: true });
      await confirm();
      expect(setter).toHaveBeenCalledWith(0, 0, 2, JSON.stringify({ hasCaption: true, captionDirection: "Right" }));
      setter.mockRestore();
      const right = JSON.parse(doc.getShapeProperties!(0, 0, 2));
      expect(right).toMatchObject({ captionDirection: "Right", captionVertAlign: "Top", captionWidth: 2400 });
      const alignSelection = pick();
      expect(alignSelection.captionVerticalAlign).toBe("Top");
      expect(alignSelection.operations).toContain("captionVerticalAlign");
      expect(edit({ kind: "captionVerticalAlign", align: "Center" })).toEqual({ accepted: true });
      await confirm();
      const centered = JSON.parse(doc.getShapeProperties!(0, 0, 2));
      expect(centered).toEqual({ ...right, captionVertAlign: "Center" });

      expect(editor.undo()).toBe(true);
      await confirm();
      expect(JSON.parse(doc.getShapeProperties!(0, 0, 2))).toEqual(right);
      expect(editor.redo()).toBe(true);
      await confirm();
      expect(JSON.parse(doc.getShapeProperties!(0, 0, 2))).toEqual(centered);
      const exported = doc.exportHwpWithReport();
      try {
        const report = exported.contentLoss(), output = exported.takeBytes();
        expect(JSON.parse(report)).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(output) as RhwpDocument;
        try { expect(JSON.parse(reopened.getShapeProperties!(0, 0, 2))).toEqual(centered); }
        finally { reopened.free(); }
      } finally { exported.free(); }
    } finally {
      editor.dispose();
    }
  });

  it("rejects lateral placement outside the safe geometry envelope and locked caption owners", async () => {
    for (const options of [{ captionWidth: 0 }, { locked: true }]) {
      const bytes = fixtureBytes(options);
      const { doc, editor, pick, edit, prepare } = await setup(bytes);
      try {
        await prepare();
        const selection = pick();
        const before = doc.exportHwp();
        if (options.locked) {
          expect(selection.captionSide).toBeUndefined();
          expect(selection.operations).not.toContain("captionSide");
        } else {
          expect(selection.captionSide).toBe("Bottom");
          expect(selection.captionLateral).toBeUndefined();
          expect(edit({ kind: "captionSide", side: "Right" }).accepted).toBe(false);
          expect(edit({ kind: "captionVerticalAlign", align: "Center" }).accepted).toBe(false);
        }
        expect(doc.exportHwp()).toEqual(before);
        expect(editor.snapshot().revision).toBe(0);
        expect(editor.snapshot().history).toMatchObject({ undo: false, redo: false });
      } finally {
        editor.dispose();
      }
    }
  });
});
