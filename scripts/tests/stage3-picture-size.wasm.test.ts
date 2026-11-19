// @vitest-environment jsdom
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import { FIXED_MEMORY_BYTES, controlledBackend, info, loaded, ok, flush } from "../../src/components/Editor/rhwp/testing";

const artifacts = resolve("public/rhwp");
const identity = await readRhwpGeneration(artifacts, "release");
const folder = resolve(artifacts, "generations", identity.generation);
const engine = createRequire(import.meta.url)(resolve(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(resolve(folder, "rhwp_bg.wasm")) });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAADYAAAAbCAIAAAC4FetiAAAAN0lEQVR4nO3OUQkAIBBAsethFvv3MIklBN/HYAE2Z+24+T5QVFRUbFFUrFBUrFBUrFBUrFB84QIyEvyvRSPr3QAAAABJRU5ErkJggg==", "base64");
const layout = (doc: RhwpDocument) => JSON.parse(doc.getPageControlLayout!(0)).controls
  .filter((control: { type: string }) => control.type === "image") as { x: number; y: number; w: number; h: number }[];

function source(format: "hwp" | "hwpx"): Uint8Array {
  const doc = engine.HwpDocument.createEmpty();
  try {
    doc.createBlankDocument();
    doc.insertText(0, 0, 0, "seed ");
    let offset = 5;
    for (const size of [4050, 3600]) {
      const inserted = JSON.parse(doc.insertPicture(0, 0, offset, "[]", png, size, size / 2, 54, 27, "png", ""));
      expect(inserted.ok).toBe(true);
      expect(JSON.parse(doc.setPictureProperties(0, inserted.paraIdx, inserted.controlIdx, '{"treatAsChar":true}')).ok).toBe(true);
      offset = inserted.logicalOffset;
    }
    return format === "hwpx" ? doc.exportHwpx() : doc.exportHwp();
  } finally { doc.free(); }
}

async function setup(format: "hwp" | "hwpx", approveHwp = false) {
  const control = controlledBackend();
  const sessions = new DocumentSessions(control.backend);
  const open = sessions.open(`/picture.${format}`);
  const sessionInfo = (patch: Parameters<typeof info>[0]) => info({ ...patch, format });
  control.take("open").reply(ok(sessionInfo({ displayName: `picture.${format}` })));
  await open;
  const bytes = source(format);
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
  const pick = (index: number) => {
    const frame = layout(doc!)[index]!;
    expect(editor.pointAt(0, frame.x + frame.w / 2, frame.y + frame.h / 2, false, false, true)).toBe(true);
    const selected = editor.objectSelection!;
    return {
      command: "picture.size" as const,
      selectionEpoch: selected.epoch, sessionId: selected.sessionId,
      loadGeneration: selected.loadGeneration, revision: selected.revision,
      widthPt: 61, heightPt: 30.5,
    };
  };
  const confirm = async (revision: number) => {
    const pending = control.take("commit");
    expect(pending.args).toEqual([1, 1, revision - 1, 1]);
    pending.reply(ok(sessionInfo({ state: "ready", revision, dirty: true, loadGeneration: 1, sequence: 2 + revision })));
    await flush();
  };
  return { editor, doc: doc!, pick, confirm, ...control };
}

describe("Stage 3 HWPX picture size on the Release engine", () => {
  it("rejects stale and invalid size requests and replays one actual size edit with undo and redo", async () => {
    const { editor, doc, pick, confirm, calls } = await setup("hwpx");
    try {
      const initial = layout(doc);
      const old = pick(1);
      const request = pick(0);
      expect(editor.execute("picture.size", old).accepted).toBe(false);
      expect(editor.execute("picture.size", { ...request, widthPt: Infinity }).accepted).toBe(false);
      expect(editor.execute("picture.size", { ...request, widthPt: 4000 }).accepted).toBe(false);
      expect(calls.filter(call => call.method === "commit")).toEqual([]);
      expect(layout(doc)).toEqual(initial);
      expect(editor.execute("picture.size", request).accepted).toBe(true);
      await confirm(1);
      expect(layout(doc)[1]).toMatchObject({ w: initial[1]!.w, h: initial[1]!.h });
      expect(JSON.parse(doc.getPictureProperties!(0, 0, 2))).toMatchObject({ width: 6100, height: 3050 });
      expect(editor.undo()).toBe(true);
      await confirm(2);
      expect(layout(doc)).toEqual(initial);
      expect(editor.redo()).toBe(true);
      await confirm(3);
      const exported = doc.exportHwpxWithReport();
      try {
        const reopened = new engine.HwpDocument(exported.takeBytes()) as RhwpDocument;
        try {
          expect(JSON.parse(reopened.getPictureProperties!(0, 0, 2))).toMatchObject({ width: 6100, height: 3050 });
          expect(JSON.parse(reopened.getPictureProperties!(0, 0, 3))).toMatchObject({ width: 3600, height: 1800 });
        } finally { reopened.free(); }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("refuses the same size operation on HWP before original preflight and history", async () => {
    const { editor, doc, pick, calls } = await setup("hwp");
    try {
      const initial = layout(doc);
      expect(editor.execute("picture.size", pick(0)).accepted).toBe(false);
      expect(editor.undo()).toBe(false);
      expect(layout(doc)).toEqual(initial);
      expect(calls.filter(call => call.method === "commit")).toEqual([]);
    } finally { editor.dispose(); }
  });

  it("resizes an HWP inline picture after SAFE preflight with undo/redo and reopen equality", async () => {
    const { editor, doc, pick, confirm } = await setup("hwp", true);
    try {
      const initial = layout(doc);
      expect(editor.execute("picture.size", pick(0)).accepted).toBe(true);
      await confirm(1);
      expect(JSON.parse(doc.getPictureProperties!(0, 0, 2))).toMatchObject({ width: 6100, height: 3050 });
      expect(editor.undo()).toBe(true);
      await confirm(2);
      expect(layout(doc)).toEqual(initial);
      expect(editor.redo()).toBe(true);
      await confirm(3);
      const exported = doc.exportHwpWithReport();
      try {
        const reopened = new engine.HwpDocument(exported.takeBytes()) as RhwpDocument;
        try {
          expect(JSON.parse(reopened.getPictureProperties!(0, 0, 2))).toMatchObject({ width: 6100, height: 3050 });
        } finally { reopened.free(); }
      } finally { exported.free(); }
    } finally { editor.dispose(); }
  });

  it("resizes a rotated HWP picture with matrix regeneration, undo/redo and reopen equality", async () => {
    const srcDoc = engine.HwpDocument.createEmpty();
    let rotatedBytes: Uint8Array;
    try {
      srcDoc.createBlankDocument();
      srcDoc.insertText(0, 0, 0, "seed ");
      const ins = JSON.parse(srcDoc.insertPicture(0, 0, 5, "[]", png, 4050, 2025, 54, 27, "png", ""));
      expect(ins.ok).toBe(true);
      expect(JSON.parse(srcDoc.setPictureProperties(0, ins.paraIdx, ins.controlIdx, JSON.stringify({ treatAsChar: true, rotationAngle: 30 }))).ok).toBe(true);
      rotatedBytes = srcDoc.exportHwp();
    } finally { srcDoc.free(); }

    const control = controlledBackend();
    const sessions = new DocumentSessions(control.backend);
    const open = sessions.open("/rotated.hwp");
    const sessionInfo = (patch: Parameters<typeof info>[0]) => info({ ...patch, format: "hwp" });
    control.take("open").reply(ok(sessionInfo({ displayName: "rotated.hwp" })));
    await open;
    let doc: RhwpDocument | undefined;
    const editor = new RhwpEditorSession(1, control.backend, sessions,
      async () => ({ openDocument: (b: Uint8Array) => { const d = new engine.HwpDocument(b) as RhwpDocument; doc ??= d; return d; }, memoryBytes: () => FIXED_MEMORY_BYTES }),
      { natural: null });
    try {
      const loading = editor.load();
      control.take("load").reply(loaded(rotatedBytes));
      await flush();
      control.take("session").reply(ok(sessionInfo({ state: "loading", sequence: 1, loadGeneration: 1 })));
      control.take("setState").reply(ok(sessionInfo({ state: "ready", sequence: 2, loadGeneration: 1 })));
      await loading;
      control.take("original").reply(ok(rotatedBytes));
      await flush();
      control.take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
      await flush();

      const confirm = async (revision: number) => {
        const pending = control.take("commit");
        expect(pending.args).toEqual([1, 1, revision - 1, 1]);
        pending.reply(ok(sessionInfo({ state: "ready", revision, dirty: true, loadGeneration: 1, sequence: 2 + revision })));
        await flush();
      };
      const initial = layout(doc!);
      const frame = initial[0]!;
      expect(editor.pointAt(0, frame.x + frame.w / 2, frame.y + frame.h / 2, false, false, true)).toBe(true);
      const sel = editor.objectSelection!;
      expect(sel.operations).toContain("resize");
      expect(editor.execute("picture.size", {
        command: "picture.size", selectionEpoch: sel.epoch, sessionId: sel.sessionId,
        loadGeneration: sel.loadGeneration, revision: sel.revision, widthPt: 67.8, heightPt: 55.8,
      }).accepted).toBe(true);
      await confirm(1);
      expect(JSON.parse(doc!.getPictureProperties!(0, 0, 2))).toMatchObject({ width: 6780, height: 5580, rotationAngle: 30 });

      const exported = doc!.exportHwpWithReport();
      try {
        const editedBytes = exported.takeBytes();
        expect(JSON.parse(exported.contentLoss())).toMatchObject({ count: 0 });
        const reopened = new engine.HwpDocument(editedBytes) as RhwpDocument;
        try {
          expect(JSON.parse(reopened.getPictureProperties!(0, 0, 2))).toMatchObject({ width: 6780, height: 5580, rotationAngle: 30 });
        } finally { reopened.free(); }
        if (process.env.GEUL_STAGE3_OUT) {
          mkdirSync(process.env.GEUL_STAGE3_OUT, { recursive: true });
          writeFileSync(resolve(process.env.GEUL_STAGE3_OUT, "rotated-pic-orig.hwp"), rotatedBytes);
          writeFileSync(resolve(process.env.GEUL_STAGE3_OUT, "rotated-pic-edited.hwp"), editedBytes);
        }
      } finally { exported.free(); }

      expect(editor.undo()).toBe(true);
      await confirm(2);
      expect(JSON.parse(doc!.getPictureProperties!(0, 0, 2))).toMatchObject({ width: 4520, height: 3779, rotationAngle: 30 });
      expect(editor.redo()).toBe(true);
      await confirm(3);
      expect(JSON.parse(doc!.getPictureProperties!(0, 0, 2))).toMatchObject({ width: 6780, height: 5580, rotationAngle: 30 });
    } finally { editor.dispose(); }
  });
});
