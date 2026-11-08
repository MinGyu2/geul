// @vitest-environment jsdom
// HWP preview capture with the selected Release WASM (2026-11-08): page-1 classification on real engine layer
// trees, and the raster's source — the reopened exact export bytes the backend receives, never the live session.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "../../src/components/Editor/rhwp/rhwpModule";
import { classifyFirstPage, synchronouslyPaintable } from "../../src/components/Editor/rhwp/previewRaster";
import { base, controlledBackend, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";

const captured = vi.hoisted(() => ({ docs: [] as unknown[] }));
vi.mock("../../src/components/Editor/rhwp/previewRaster", async (actual) => {
  const real = await actual<typeof import("../../src/components/Editor/rhwp/previewRaster")>();
  // jsdom has no 2D canvas: record which document is captured and return a marker raster.
  return { ...real, capturePreviewRaster: (doc: unknown) => { captured.docs.push(doc); return { width: 1, height: 1, rgb: new Uint8Array([1, 2, 3]) }; } };
});

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
const exports = engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const sample = (name: string) => new Uint8Array(readFileSync(join(root, "external/rhwp/samples", name)));
const tree = (doc: RhwpDocument) => doc.getPageLayerTreeWithProfile!(0, "screen", true, true);

describe("page-1 classification on real engine layer trees", () => {
  it("separates blank pages, text, tables, images and a blank page 1 before later content", () => {
    const blank = engine.HwpDocument.createEmpty(); blank.createBlankDocument();
    try {
      expect(classifyFirstPage(tree(blank))).toBe("blank");
      blank.insertText(0, 0, 0, "   ");
      expect(classifyFirstPage(tree(blank))).toBe("content"); // whitespace-only: fail closed
      blank.deleteText(0, 0, 0, 3);
      expect(classifyFirstPage(tree(blank))).toBe("blank");
      blank.insertText(0, 0, 0, "둘째 쪽");
      blank.insertPageBreak(0, 0, 0);
      expect(blank.pageCount()).toBe(2);
      expect(classifyFirstPage(tree(blank))).toBe("blank"); // page 1 empty, text on page 2
    } finally { blank.free(); }
    const genuine = new engine.HwpDocument(sample("re-align-left-hancom.hwp"));
    try {
      expect(classifyFirstPage(tree(genuine))).toBe("content");
      genuine.deleteText(0, 0, 0, genuine.getParagraphLength(0, 0));
      expect(classifyFirstPage(tree(genuine))).toBe("blank");
    } finally { genuine.free(); }
    const table = new engine.HwpDocument(sample("calc-cell.hwp"));
    try { expect(classifyFirstPage(tree(table))).toBe("content"); } finally { table.free(); }
    for (const [name, sync] of [["HWP5-nopassword-123456.hwp", true], ["el-school-001.hwp", false], ["hwp3-sample14-hwp5.hwp", false]] as const) {
      const doc = new engine.HwpDocument(sample(name));
      try {
        expect(classifyFirstPage(tree(doc)), name).toBe("content");
        expect(synchronouslyPaintable(tree(doc)), name).toBe(sync);
      } finally { doc.free(); }
    }
  });
});

describe("preview raster source", () => {
  it("captures page 1 of the reopened exact bytes sent to the backend, not the live document", async () => {
    const original = sample("re-align-left-hancom.hwp");
    const opened = new Map<unknown, Uint8Array>();
    const { backend, take, calls } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const opening = sessions.open("/a.hwp"); take("open").reply(ok({ ...base, format: "hwp" })); await opening;
    const module: RhwpModule = { openDocument: b => { const doc = new engine.HwpDocument(b); opened.set(doc, new Uint8Array(b)); return doc; }, memoryBytes: () => exports.memory.buffer.byteLength };
    const editor = new RhwpEditorSession(1, backend, sessions, async () => module);
    const loading = editor.load(); take("load").reply(loaded(original)); await flush();
    take("session").reply(ok(info({ format: "hwp", state: "loading", sequence: 1, loadGeneration: 1 })));
    take("setState").reply(ok(info({ format: "hwp", state: "ready", sequence: 2, loadGeneration: 1 }))); await loading;
    const live = [...opened.keys()][0];
    let sequence = 2;
    for (let i = 0; i < 100; i++) {
      editor.deleteForward(); await flush();
      while (calls.some(c => c.method === "commit")) { const c = take("commit"); c.reply(ok(info({ format: "hwp", state: "ready", loadGeneration: 1, sequence: ++sequence, revision: Number(c.args[2]) + Number(c.args[3]), dirty: true }))); await flush(); }
    }
    captured.docs.length = 0;
    const saving = editor.save();
    if (calls.some(c => c.method === "original")) { take("original").reply(ok(original)); await flush(); take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true })); await flush(); }
    const request = take("save");
    expect(captured.docs).toHaveLength(1);
    const source = captured.docs[0];
    expect(source).not.toBe(live);
    expect(opened.get(source)).toEqual(request.args[3]); // the exact output bytes in the save request
    expect(request.args[7]).toEqual({ width: 1, height: 1, rgb: new Uint8Array([1, 2, 3]) });
    request.reply({ ok: false, error: { code: "SaveFailure", stage: "write" } }); await saving;
    editor.dispose();
  });
});
