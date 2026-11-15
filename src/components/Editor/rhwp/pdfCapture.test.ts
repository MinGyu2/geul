// Stage 5-A S5-4: HWP/HWPX PDF page capture (fail-closed rules), the GPD1 frame, the PDF result contract, the
// file.exportPdf command state and the workspace export flow. Real PDF output is accepted on the Linux product
// (docs/quality-matrix.md); these tests cover the frontend contracts only.
import { describe, expect, it, vi } from "vitest";
import { pdfFrame } from "../../../adapters/backend";
import { parsePdfExported } from "../../../adapters/contract";
import { commandState } from "../../../commands/commands";
import { initialLayout } from "../../../hooks/layoutState";
import { capturePdfPages, pdfScale, PDF_MAX_PAGES, PDF_SCALE, PX_TO_PT } from "./pdfCapture";
import type { RhwpDocument } from "./rhwpModule";

const CONTENT_TREE = JSON.stringify({ root: { kind: "leaf", ops: [{ type: "textRun", text: "가", clusters: [{}] }] } });
const BLANK_TREE = JSON.stringify({ root: { kind: "leaf", ops: [{ type: "pageBackground" }] } });
const ASYNC_TREE = JSON.stringify({ root: { kind: "leaf", ops: [{ type: "image", mime: "image/gif" }] } });

/** Fake canvas whose bitmap is uniform or not. */
function fakeCanvas(uniform: boolean) {
  const canvas = { width: 0, height: 0 } as unknown as { width: number; height: number; getContext: () => unknown };
  canvas.getContext = () => ({
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4).fill(255);
      if (!uniform) data[4] = 0;
      return { data } as unknown as ImageData;
    },
  });
  return canvas as unknown as HTMLCanvasElement;
}

function fakeDoc(trees: string[], paint?: (page: number, canvas: HTMLCanvasElement, scale: number) => void) {
  const painted: number[] = [];
  const doc = {
    getPageLayerTreeWithProfile: (page: number) => trees[page]!,
    renderPageToCanvas: (page: number, canvas: HTMLCanvasElement, scale: number) => {
      painted.push(page);
      if (paint) paint(page, canvas, scale);
      else { canvas.width = Math.ceil(794 * scale); canvas.height = Math.ceil(1123 * scale); }
    },
  } as unknown as RhwpDocument;
  return { doc, painted };
}

const A4 = { width: 794, height: 1123 };
const png = vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2]));

describe("HWP/HWPX PDF page capture", () => {
  it("captures every page in order at the page's physical size", async () => {
    const { doc, painted } = fakeDoc([CONTENT_TREE, BLANK_TREE]);
    const result = await capturePdfPages(doc, [A4, A4], () => true, () => fakeCanvas(false), png);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(painted).toEqual([0, 1]);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]).toMatchObject({ widthPt: 794 * PX_TO_PT, heightPt: 1123 * PX_TO_PT,
      pixelWidth: Math.ceil(794 * PDF_SCALE), pixelHeight: Math.ceil(1123 * PDF_SCALE) });
  });

  it("refuses content the canvas renderer paints asynchronously instead of omitting it", async () => {
    const { doc, painted } = fakeDoc([CONTENT_TREE, ASYNC_TREE]);
    expect(await capturePdfPages(doc, [A4, A4], () => true, () => fakeCanvas(false), png)).toEqual({ ok: false, reason: "asyncContent" });
    expect(painted).toEqual([0]);
  });

  it("refuses a uniform bitmap for a page that paints content, but accepts a provably blank page", async () => {
    expect(await capturePdfPages(fakeDoc([CONTENT_TREE]).doc, [A4], () => true, () => fakeCanvas(true), png))
      .toEqual({ ok: false, reason: "renderFailed" });
    expect((await capturePdfPages(fakeDoc([BLANK_TREE]).doc, [A4], () => true, () => fakeCanvas(true), png)).ok).toBe(true);
  });

  it("refuses when the model changes during capture, an encode fails, or the bitmap has the wrong size", async () => {
    let current = true;
    const { doc } = fakeDoc([CONTENT_TREE, CONTENT_TREE]);
    const encode = vi.fn(async () => { current = false; return new Uint8Array(16); });
    expect(await capturePdfPages(doc, [A4, A4], () => current, () => fakeCanvas(false), encode)).toEqual({ ok: false, reason: "changed" });
    expect(await capturePdfPages(fakeDoc([CONTENT_TREE]).doc, [A4], () => true, () => fakeCanvas(false), async () => null))
      .toEqual({ ok: false, reason: "renderFailed" });
    const wrong = fakeDoc([CONTENT_TREE], (_p, canvas) => { canvas.width = 10; canvas.height = 10; });
    expect(await capturePdfPages(wrong.doc, [A4], () => true, () => fakeCanvas(false), png)).toEqual({ ok: false, reason: "renderFailed" });
    const thrower = fakeDoc([CONTENT_TREE], () => { throw new Error("engine"); });
    expect(await capturePdfPages(thrower.doc, [A4], () => true, () => fakeCanvas(false), png)).toEqual({ ok: false, reason: "renderFailed" });
  });

  it("enforces page-count and page-size limits before painting", async () => {
    const pages = Array.from({ length: PDF_MAX_PAGES + 1 }, () => A4);
    const { doc, painted } = fakeDoc([]);
    expect(await capturePdfPages(doc, pages, () => true, () => fakeCanvas(false), png)).toEqual({ ok: false, reason: "tooLarge" });
    expect(painted).toEqual([]);
    expect(pdfScale(794, 1123)).toBe(PDF_SCALE);
    expect(pdfScale(3000, 3000)).toBeLessThan(PDF_SCALE);
    expect(pdfScale(3000, 3000)).toBeGreaterThanOrEqual(1);
    expect(pdfScale(20_000, 20_000)).toBeNull();
    const missing = { renderPageToCanvas: () => undefined } as unknown as RhwpDocument;
    expect(await capturePdfPages(missing, [A4], () => true, () => fakeCanvas(false), png)).toEqual({ ok: false, reason: "renderFailed" });
  });
});

describe("PDF export contract", () => {
  it("frames pages as GPD1 with the save frame header and exact PNG lengths", () => {
    const frame = pdfFrame(3, 2, 9, "/docs/a.pdf", [
      { widthPt: 595.5, heightPt: 842.25, pixelWidth: 2, pixelHeight: 3, png: new Uint8Array([1, 2, 3]) },
      { widthPt: 595.5, heightPt: 842.25, pixelWidth: 2, pixelHeight: 3, png: new Uint8Array([4, 5]) },
    ]);
    expect([...frame.subarray(0, 4)]).toEqual([0x47, 0x50, 0x44, 0x31]);
    const view = new DataView(frame.buffer);
    expect([view.getUint32(4, true), view.getUint32(12, true), view.getUint32(20, true)]).toEqual([3, 2, 9]);
    const metaLength = view.getUint32(28, true);
    const meta = JSON.parse(new TextDecoder().decode(frame.subarray(32, 32 + metaLength)));
    expect(meta).toEqual({ destination: "/docs/a.pdf", overwriteGrant: null, pages: [
      { widthPt: 595.5, heightPt: 842.25, pixelWidth: 2, pixelHeight: 3, length: 3 },
      { widthPt: 595.5, heightPt: 842.25, pixelWidth: 2, pixelHeight: 3, length: 2 },
    ] });
    expect([...frame.subarray(32 + metaLength)]).toEqual([1, 2, 3, 4, 5]);
  });

  it("accepts only a result for the requested session, load and revision", () => {
    const value = { sessionId: 3, loadGeneration: 2, revision: 9, pages: 2, bytes: 100, durable: true, raster: true, retainedReplaced: null };
    expect(parsePdfExported(value, 3, 2, 9)).toEqual(value);
    const retained = { ...value, retainedReplaced: ".geul-save-1-abc.tmp" };
    expect(parsePdfExported(retained, 3, 2, 9)).toEqual(retained);
    expect(parsePdfExported({ ...value, retainedReplaced: "../escape" }, 3, 2, 9)).toBeNull();
    const missing: Partial<typeof value> = { ...value };
    delete missing.retainedReplaced;
    expect(parsePdfExported(missing, 3, 2, 9)).toBeNull();
    expect(parsePdfExported({ ...value, revision: 8 }, 3, 2, 9)).toBeNull();
    expect(parsePdfExported({ ...value, pages: 0 }, 3, 2, 9)).toBeNull();
    expect(parsePdfExported({ ...value, extra: 1 }, 3, 2, 9)).toBeNull();
    expect(parsePdfExported({ ...value, durable: "yes" }, 3, 2, 9)).toBeNull();
  });

  it("file.exportPdf is available only for a settled loaded document with a native dialog", () => {
    const snapshot = { sessionId: 1, engine: "rhwp", loadGeneration: 1, revision: 0, loaded: true, editable: true, composing: false,
      pending: false, queuedHistory: null, saving: false, history: null, format: null, formatAccess: null } as const;
    const target = (patch = {}) => ({ sessionId: 1, engine: "rhwp" as const, snapshot: () => ({ ...snapshot, ...patch }), execute: () => ({ accepted: true }) });
    const files = { busy: false, open: () => undefined, newDocument: () => undefined, saveAs: () => undefined, exportPdf: () => undefined };
    const state = (document: ReturnType<typeof target> | null, f: typeof files | undefined = files) =>
      commandState("file.exportPdf", { layout: initialLayout, document, files: f, modal: false });
    expect(state(target())).toEqual({ available: true });
    expect(state(null)).toEqual({ available: false, reason: "noDocument" });
    expect(state(target({ composing: true }))).toEqual({ available: false, reason: "composing" });
    expect(state(target({ pending: true }))).toEqual({ available: false, reason: "pendingEdits" });
    expect(state(target({ saving: true }))).toEqual({ available: false, reason: "saving" });
    expect(state(target({ loaded: false }))).toEqual({ available: false, reason: "notReady" });
    expect(state(target(), { ...files, busy: true })).toEqual({ available: false, reason: "dialogOpen" });
    const withoutPdf: Partial<typeof files> = { ...files };
    delete withoutPdf.exportPdf;
    expect(state(target(), withoutPdf as typeof files)).toEqual({ available: false, reason: "notImplemented" });
  });
});

describe("workspace PDF export", () => {
  it("exports the settled DOCX revision to the chosen PDF without changing the session or save state", async () => {
    const { DocumentSessions } = await import("../../../adapters/sessions");
    const { DocumentWorkspace } = await import("../documentWorkspace");
    const { decodeFake, FakeDocx, flush } = await import("../wordcraft/testing");
    const fake = new FakeDocx(["가나다"]);
    const backend = {
      open: async () => ({ ok: true, value: { ...fake.info } }),
      sessions: async () => ({ ok: true, value: [] }),
      close: async (sessionId: number) => ({ ok: true, value: { sessionId, alreadyClosed: false } }),
    } as unknown as import("../../../adapters/backend").DocumentBackend;
    const grant = "0123456789abcdef0123456789abcdef";
    const answers = [null, { path: "/docs/out.txt", overwriteGrant: null }, { path: "/docs/out.pdf", overwriteGrant: grant }];
    const choosePdfDestination = vi.fn(async () => ({ ok: true as const, value: answers.shift() ?? null }));
    const releasePdfGrant = vi.fn(async () => ({ ok: true as const, value: null }));
    const files = { chooseFile: vi.fn(), choosePdfDestination, releasePdfGrant, createDocument: vi.fn() };
    const sessions = new DocumentSessions(backend);
    const workspace = new DocumentWorkspace(sessions, backend, undefined, undefined, fake, decodeFake, files);
    await workspace.open("/a.docx");
    await flush();
    const editor = workspace.docxEditorFor(1)!;
    const before = { info: { ...sessions.get(1)! }, save: editor.saveState, revision: editor.snapshot().revision };
    const text = { title: "t", accept: "a", cancel: "c" };
    // Cancel: nothing exported. A non-.pdf name is refused before the backend.
    expect(await workspace.exportPdf(1, text)).toBeNull();
    expect(await workspace.exportPdf(1, text)).toEqual({ ok: false, error: { code: "InvalidRequest" } });
    expect(fake.exportedPdfs).toEqual([]);
    const result = await workspace.exportPdf(1, text);
    expect(result).toMatchObject({ ok: true, value: { sessionId: 1, raster: false } });
    expect(fake.exportedPdfs).toEqual(["/docs/out.pdf"]);
    expect(fake.exportGrants).toEqual([grant]); // the dialog's grant goes only to this export
    expect(choosePdfDestination).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 1, loadGeneration: 1, suggestedName: "a" }));
    expect(files.chooseFile).not.toHaveBeenCalled();
    expect({ info: sessions.get(1), save: editor.saveState, revision: editor.snapshot().revision }).toEqual(before);
    expect(workspace.fileBusy).toBe(false);
    editor.dispose();
  });

  it("releases each early or overlapping workflow grant without letting another export inherit it", async () => {
    const { DocumentSessions } = await import("../../../adapters/sessions");
    const { DocumentWorkspace } = await import("../documentWorkspace");
    const { controlledBackend, FakeDocument, flush, info, loaded, ok, base } = await import("./testing");
    const { backend, take } = controlledBackend();
    const exportPdf = vi.fn(async () => ({ ok: false as const, error: { code: "Protocol" as const } }));
    const documentBackend = { ...backend, exportPdf } as typeof backend;
    const sessions = new DocumentSessions(documentBackend);
    const doc = new FakeDocument(["x"]);
    (doc as unknown as { getPageLayerTreeWithProfile: () => string }).getPageLayerTreeWithProfile = () => ASYNC_TREE;
    const module = {
      openDocument: () => doc as unknown as import("./rhwpModule").RhwpDocument,
      memoryBytes: () => 64 * 1024 * 1024,
    };
    const token1 = "11111111111111111111111111111111";
    const token2 = "22222222222222222222222222222222";
    const token3 = "33333333333333333333333333333333";
    type DestinationResult = import("../../../adapters/contract").Result<import("../filePort").PdfDestination | null>;
    const choices: DestinationResult[] = [
      { ok: true as const, value: { path: "/docs/wrong.txt", overwriteGrant: token1 } },
      { ok: true as const, value: { path: "/docs/async.pdf", overwriteGrant: token2 } },
    ];
    let resolveThird!: (value: DestinationResult) => void;
    const thirdChoice = new Promise<DestinationResult>(resolve => { resolveThird = resolve; });
    const choosePdfDestination = vi.fn(async (): Promise<DestinationResult> => choices.shift() ?? await thirdChoice);
    const releasePdfGrant = vi.fn(async () => ({ ok: true as const, value: null }));
    const files = {
      chooseFile: vi.fn(), choosePdfDestination, releasePdfGrant,
      createDocument: vi.fn(async () => ({ ok: false as const, error: { code: "Protocol" as const } })),
    };
    const workspace = new DocumentWorkspace(sessions, documentBackend, async () => module, undefined, undefined, undefined, files);
    const opening = workspace.open("/docs/a.hwp");
    take("open").reply(ok(base));
    expect((await opening).ok).toBe(true);
    await flush();
    take("load").reply(loaded());
    await flush();
    take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
    take("setState").reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
    await flush();

    const text = { title: "PDF", accept: "Export", cancel: "Cancel" };
    expect(await workspace.exportPdf(1, text)).toEqual({ ok: false, error: { code: "InvalidRequest" } });
    expect(await workspace.exportPdf(1, text)).toEqual({ ok: false, error: { code: "PdfExportUnavailable", reason: "asyncContent" } });
    expect(exportPdf).not.toHaveBeenCalled();

    const pending = workspace.exportPdf(1, text);
    expect(await workspace.exportPdf(1, text)).toEqual({ ok: false, error: { code: "Protocol" } });
    resolveThird({ ok: true, value: { path: "/docs/async-again.pdf", overwriteGrant: token3 } });
    expect(await pending).toEqual({ ok: false, error: { code: "PdfExportUnavailable", reason: "asyncContent" } });
    expect(releasePdfGrant.mock.calls).toEqual([[1, token1], [1, token2], [1, token3]]);
    expect(new Set([token1, token2, token3]).size).toBe(3);
    expect(workspace.fileBusy).toBe(false);
    workspace.editorFor(1)?.dispose();
  });
});
