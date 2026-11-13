// @vitest-environment jsdom
// T012 Phase 2: nested-table direct editing and table structure commands through the real product session
// (RhwpEditorSession: pointAt / typing / IME / execute / save), the selected Release WASM and the production
// T009 checker (`save_check`). Backend replies are controlled; the exact product save payloads are written as
// case corpora that the real save service then publishes:
//   HWP  → Rust `hwp_contract_real_engine_publication` (GEUL_HWP_CONTRACT_DIR=<dir>/hwp)
//   HWPX → `t010_phase0_save_service` generic driver (GEUL_T010_MANIFEST=<dir>/hwpx/manifest.json)
// Phases (GEUL_T012P2_PHASE): generate → [publish] → repeat (edits the PUBLISHED files again) → [publish] → verify
// (fresh engine reopens every published file and compares it with the model recorded at save time).
// No VITE_GEUL_TEST_* flag: the production default is the subject.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { documentCommandState } from "../../src/commands/capability";
import type { DocumentCommandId } from "../../src/commands/registry";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import { hwpReopenModel } from "../../src/components/Editor/rhwp/hwpReopenModel";
import { preserveSourceCaret, type RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import { parsePosition, sameContext, type DocPosition } from "../../src/components/Editor/rhwp/rhwpText";
import { base, controlledBackend, fail, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";

const captured = vi.hoisted(() => ({ docs: [] as unknown[] }));
vi.mock("../../src/components/Editor/rhwp/previewRaster", async actual => {
  const real = await actual<typeof import("../../src/components/Editor/rhwp/previewRaster")>();
  // jsdom has no 2D canvas: the publication corpus carries an independent rsvg raster of the same bytes.
  return { ...real, capturePreviewRaster: (doc: unknown) => { captured.docs.push(doc); return { width: 1, height: 1, rgb: new Uint8Array([1, 2, 3]) }; } };
});

type Format = "hwp" | "hwpx";
const FORMATS: Format[] = ["hwp", "hwpx"];
const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
const wasm = engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const out = resolve(process.env.GEUL_T012P2_DIR ?? join(root, "target/t012-phase2-20261113/engine"));
const phase = process.env.GEUL_T012P2_PHASE ?? "generate";
const checker = join(root, "src-tauri/target/debug/examples/save_check");
const NESTED_SAMPLE = join(root, "external/rhwp/samples/inner-table-01.hwp");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
mkdirSync(out, { recursive: true });

// Engine methods outside the product interface (fixtures/diagnostics only).
type Doc = RhwpDocument & { [name: string]: ((...args: any[]) => any) | undefined }; // eslint-disable-line @typescript-eslint/no-explicit-any
const text = (d: RhwpDocument) => (d as Doc).getTextFileText!() as string;
function exported(d: RhwpDocument, format: Format) {
  const e = format === "hwp" ? d.exportHwpWithReport() : d.exportHwpxWithReport();
  try { return { loss: e.contentLoss(), bytes: e.takeBytes() }; } finally { e.free(); }
}
function check(format: Format, mode: "preflight" | "saved", original: Uint8Array, output: Uint8Array, loss: string, reopen = true) {
  const dir = join(out, ".check"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `a.${format}`), original); writeFileSync(join(dir, `b.${format}`), output); writeFileSync(join(dir, "loss.json"), loss);
  return JSON.parse(execFileSync(checker, [mode, format, join(dir, `a.${format}`), join(dir, `b.${format}`), join(dir, "loss.json"),
    ...(mode === "saved" ? [String(reopen)] : [])], { encoding: "utf8" })) as { outcome: "safe" | "unsafe" | "unknown"; findings: { code: string; part?: string }[] };
}

// ---- fixtures (provenance recorded in fixtures.json) ----
/** Nested tables: the pinned engine sample for HWP; its Release-engine HWPX export for HWPX. */
function nestedFixture(format: Format): Uint8Array {
  const sample = new Uint8Array(readFileSync(NESTED_SAMPLE));
  if (format === "hwp") return sample;
  const d = new engine.HwpDocument(sample) as Doc;
  try { return exported(d, "hwpx").bytes; } finally { d.free(); }
}
/** Body text + a plain 3×3 table (cells c0…c8) in the normalized form the product creates. */
function tableFixture(format: Format, edit?: (d: Doc, paragraph: number, control: number) => void): Uint8Array {
  const d = engine.HwpDocument.createEmpty() as Doc; d.createBlankDocument!();
  try {
    d.insertText(0, 0, 0, "Body"); d.splitParagraph(0, 0, 4);
    const t = JSON.parse(d.createTable!(0, 1, 0, 3, 3)) as { paraIdx: number; controlIdx: number };
    d.setTableProperties!(0, t.paraIdx, t.controlIdx, JSON.stringify(format === "hwp"
      ? { textWrap: "TopAndBottom", horzRelTo: "Column", outerLeft: 283, outerRight: 283, outerTop: 283, outerBottom: 283 } : { textWrap: "TopAndBottom" }));
    for (let i = 0; i < 9; i++) d.insertTextInCell(0, t.paraIdx, t.controlIdx, i, 0, 0, `c${i}`);
    edit?.(d, t.paraIdx, t.controlIdx);
    return exported(d, format).bytes;
  } finally { d.free(); }
}

// ---- product session harness ----
async function open(format: Format, bytes: Uint8Array) {
  const { backend, take, calls } = controlledBackend(), sessions = new DocumentSessions(backend);
  const opening = sessions.open(`/a.${format}`); take("open").reply(ok({ ...base, format })); await opening;
  let doc: Doc | undefined;
  const editor = new RhwpEditorSession(1, backend, sessions, async () => ({
    // Same open policy as the production module; the first document is the live session model.
    openDocument: (b: Uint8Array) => { const opened = preserveSourceCaret(new engine.HwpDocument(b) as Doc); doc ??= opened; return opened; },
    memoryBytes: () => wasm.memory.buffer.byteLength,
  }));
  const loading = editor.load(); take("load").reply(loaded(bytes)); await flush();
  take("session").reply(ok(info({ format, state: "loading", sequence: 1 })));
  take("setState").reply(ok(info({ format, state: "ready", sequence: 2 })));
  expect(await loading, JSON.stringify(editor.status)).toEqual({ ok: true, value: null });
  // HWP structural eligibility: answer the load-time original preflight with the production checker's real verdict.
  let probe: { preflight: ReturnType<typeof check>; unedited: Uint8Array; noopLoss: string } | null = null;
  if (calls.some(c => c.method === "original")) {
    take("original").reply(ok(bytes)); await flush();
    const pf = take("preflight");
    const unedited = pf.args[2] as Uint8Array, noopLoss = JSON.stringify(pf.args[3]);
    probe = { preflight: check(format, "preflight", bytes, unedited, noopLoss), unedited, noopLoss };
    pf.reply(ok({ preservation: probe.preflight, platformSupported: true })); await flush();
  }
  const ctx = { format, editor, take, calls, sequence: 2, original: bytes, get doc() { return doc!; }, probe,
    /** After a publication the session re-checks its new original (HWP): answer with the checker's real verdict. */
    async adopt(next: Uint8Array) {
      ctx.original = next; await flush();
      if (!calls.some(c => c.method === "original")) return;
      take("original").reply(ok(next)); await flush();
      const pf = take("preflight");
      const unedited = pf.args[2] as Uint8Array, noopLoss = JSON.stringify(pf.args[3]);
      ctx.probe = { preflight: check(format, "preflight", next, unedited, noopLoss), unedited, noopLoss };
      pf.reply(ok({ preservation: ctx.probe.preflight, platformSupported: true })); await flush();
    },
    async settle() { await flush(); while (calls.some(c => c.method === "commit")) {
      const call = take("commit"); call.reply(ok(info({ format, state: "ready", revision: Number(call.args[2]) + Number(call.args[3]), dirty: true, sequence: ++ctx.sequence }))); await flush();
    } } };
  return ctx;
}
type Ctx = Awaited<ReturnType<typeof open>>;
const state = (ctx: Ctx, id: DocumentCommandId) => documentCommandState(id, ctx.editor.snapshot());
const run = async (ctx: Ctx, id: DocumentCommandId) => { const r = ctx.editor.execute(id); await ctx.settle(); return r.accepted; };

/** Product Save with the real preflight / raw-saved verdicts of the production checker. */
async function save(ctx: Ctx, publish = true) {
  const { format, original } = ctx;
  captured.docs.length = 0;
  const saving = ctx.editor.save(); await flush();
  let unedited: Uint8Array, noopLoss: string, preflight: ReturnType<typeof check>;
  if (ctx.calls.some(c => c.method === "original")) {
    ctx.take("original").reply(ok(original)); await flush();
    const pf = ctx.take("preflight");
    unedited = pf.args[2] as Uint8Array; noopLoss = JSON.stringify(pf.args[3]);
    preflight = check(format, "preflight", original, unedited, noopLoss);
    pf.reply(ok({ preservation: preflight, platformSupported: true })); await flush();
  } else {
    if (!ctx.probe) throw new Error("save skipped preflight without an eligibility verdict");
    ({ unedited, noopLoss, preflight } = ctx.probe);
  }
  if (preflight.outcome !== "safe") return { result: await saving, preflight, unedited, noopLoss };
  const call = ctx.take("save");
  const [, , revision, output, contentLoss, reopen] = call.args as [number, number, number, Uint8Array, unknown, Record<string, boolean>];
  const loss = JSON.stringify(contentLoss);
  const reopenEqual = Object.values(reopen).every(Boolean);
  const raw = check(format, "saved", original, output, loss, reopenEqual);
  // The service regenerates stale HWP previews; anything else is a real refusal.
  const publishable = reopenEqual && raw.findings.every(f => f.code === "previewStale") && (format === "hwp" || raw.outcome === "safe");
  if (publish && publishable) call.reply(ok({ session: info({ format, state: "ready", revision, dirty: false, sequence: ++ctx.sequence }), durable: true }));
  else call.reply(fail({ code: "UnsafeSave", preservation: raw as never }));
  const result = await saving;
  return { result, preflight, unedited, noopLoss, output, loss, reopen, reopenEqual, raw, revision, publishable };
}
type Saved = Awaited<ReturnType<typeof save>>;

/** Model of a document for the independent reopen comparison: flat text, control inventory, every body-level
 * table (geometry + cell paragraphs) and every nested cell (path + paragraphs). */
function model(d: RhwpDocument) {
  const m = hwpReopenModel(d);
  const parsed = JSON.parse(m.model) as { tables: { dimensions: unknown; cells: { coordinates: unknown; paragraphs: string[] }[] }[]; nested: unknown[] };
  return { text: text(d), pages: d.pageCount(), controls: d.getControls!(),
    tables: parsed.tables.map(t => ({ dimensions: t.dimensions, cells: t.cells.map(c => ({ coordinates: c.coordinates, paragraphs: c.paragraphs })) })),
    nested: parsed.nested };
}

const manifests: Record<Format, { id: string; negative?: boolean; expectedCode?: string }[]> = { hwp: [], hwpx: [] };
const hwpxCases: Record<string, unknown>[] = [];
/** Write one product save as a publication case for the real save service of its format. */
function record(id: string, ctx: Ctx, s: Saved, negative?: string) {
  const { format, original } = ctx;
  const dir = join(out, format, id); mkdirSync(dir, { recursive: true });
  const proof = { engineGeneration: build.generation, wasmSha256: build.artifacts["rhwp_bg.wasm"], originalSha256: sha(original),
    noopSha256: sha(s.unedited), editedSha256: sha(s.output!), reopenEqual: s.reopenEqual, productReopen: s.reopen, revision: s.revision,
    preflight: s.preflight, raw: s.raw, expected: model(ctx.doc), phase,
    source: "RhwpEditorSession product edits + save payload (controlled backend replies)" };
  writeFileSync(join(dir, `original.${format}`), original); writeFileSync(join(dir, `noop.${format}`), s.unedited); writeFileSync(join(dir, "noop-loss.json"), s.noopLoss);
  writeFileSync(join(dir, `edited.${format}`), s.output!); writeFileSync(join(dir, "loss.json"), s.loss!);
  writeFileSync(join(dir, "proof.json"), JSON.stringify(proof, null, 2));
  if (format === "hwp") {
    // Independent page-1 raster of the exact output bytes (the service resamples and validates it).
    const reopened = new engine.HwpDocument(s.output!) as Doc;
    try {
      const page = JSON.parse(reopened.getPageInfo(0)) as { width: number; height: number };
      const long = Math.max(page.width, page.height);
      writeFileSync(join(dir, "render.svg"), reopened.renderPageSvgWithProfile!(0, "screen") as string);
      execFileSync("rsvg-convert", ["--background-color", "white", "--width", String(Math.round(page.width / long * 1024)),
        "--height", String(Math.round(page.height / long * 1024)), "--output", join(dir, "render.png"), join(dir, "render.svg")], { timeout: 30000 });
    } finally { reopened.free(); }
  } else {
    // The generic service driver publishes over `target` (a working copy of the original).
    copyFileSync(join(dir, `original.${format}`), join(dir, "target.hwpx"));
    hwpxCases.push({ name: id, fmt: "hwpx", mode: "save", target: join(dir, "target.hwpx"), unedited: join(dir, "noop.hwpx"),
      uneditedLoss: join(dir, "noop-loss.json"), output: join(dir, "edited.hwpx"), outputLoss: join(dir, "loss.json"), reopen: s.reopen,
      ...(negative ? { negative: true, expectedCode: negative } : {}) });
    writeFileSync(join(out, "hwpx", phase === "repeat" ? "manifest-repeat.json" : "manifest.json"), JSON.stringify({ cases: hwpxCases }, null, 2));
  }
  manifests[format].push(negative ? { id, negative: true, expectedCode: negative } : { id });
  writeFileSync(join(out, format, phase === "repeat" ? "cases-repeat.json" : "cases-first.json"), JSON.stringify(manifests[format], null, 2));
  if (format === "hwp") writeFileSync(join(out, format, "cases.json"), JSON.stringify(manifests[format], null, 2));
}
function expectPublishable(s: Saved) {
  expect(s.preflight.outcome).toBe("safe");
  expect(s.reopenEqual, JSON.stringify(s.reopen)).toBe(true);
  expect(s.publishable, JSON.stringify(s.raw)).toBe(true);
  expect(s.result.ok).toBe(true);
}
/** The published file of an earlier case (written by the real save service). */
function published(format: Format, id: string): Uint8Array {
  const path = join(out, format, id, format === "hwp" ? "published.hwp" : "target.hwpx");
  if (!existsSync(path)) throw new Error(`published file missing: ${path} (run the publication step first)`);
  return new Uint8Array(readFileSync(path));
}

// ---- positions ----
type List = { listId: number; isCell: boolean; hostListId: number; sectionIndex: number; hostPara: number; controlIndex: number; cellIndex: number; paraCount: number };
/** First cell of the first table nested directly in a body-level cell, as an explicit path. */
function nestedTarget(d: RhwpDocument) {
  const lists = (JSON.parse(d.getCursorModel!()) as { lists: List[] }).lists;
  const byId = new Map(lists.map(l => [l.listId, l]));
  const inner = lists.find(l => l.isCell && l.hostListId !== 0 && byId.get(l.hostListId)?.isCell && byId.get(l.hostListId)!.hostListId === 0 && l.cellIndex === 0)!;
  const outer = byId.get(inner.hostListId)!;
  const at: DocPosition = { section: inner.sectionIndex, paragraph: outer.hostPara, offset: 0,
    cell: { parentParagraph: outer.hostPara, control: outer.controlIndex, cell: outer.cellIndex, cellParagraph: inner.hostPara,
      nested: [{ control: inner.controlIndex, cell: inner.cellIndex, cellParagraph: 0 }] } };
  const path = JSON.stringify([{ controlIndex: outer.controlIndex, cellIndex: outer.cellIndex, cellParaIndex: inner.hostPara },
    { controlIndex: inner.controlIndex, cellIndex: inner.cellIndex, cellParaIndex: 0 }]);
  return { at, path, outer, inner };
}
const nestedText = (d: RhwpDocument, t: ReturnType<typeof nestedTarget>, paragraph = 0) => {
  const path = JSON.stringify((JSON.parse(t.path) as { cellParaIndex: number }[]).map((l, i, all) => (i + 1 < all.length ? l : { ...l, cellParaIndex: paragraph })));
  return d.getTextInCellByPath!(t.at.section, t.outer.hostPara, path, 0, d.getCellParagraphLengthByPath!(t.at.section, t.outer.hostPara, path));
};
/** Everything except the target nested cell: parent table cells and all other nested cells. */
function others(d: RhwpDocument, t: ReturnType<typeof nestedTarget>) {
  const m = model(d);
  const key = JSON.stringify(JSON.parse(t.path).map((l: { controlIndex: number; cellIndex: number }) => [l.controlIndex, l.cellIndex]));
  const nested = (m.nested as { host: number; levels: { controlIndex: number; cellIndex: number }[]; paragraphs: string[] }[])
    .filter(n => !(n.host === t.outer.hostPara && JSON.stringify(n.levels.map(l => [l.controlIndex, l.cellIndex])) === key));
  expect(nested.length).toBe(m.nested.length - 1); // the target is one distinct nested cell of the model
  // The parent cell hosting the nested table keeps its own paragraph texts too (m.tables covers it).
  return JSON.stringify({ tables: m.tables, nested, controls: m.controls });
}
const tableOf = (d: RhwpDocument) => (JSON.parse(d.getControls!()) as { ctrlId: string; para: number; controlIndex: number }[]).find(c => c.ctrlId === "tbl")!;
const cellAt = (ctx: Ctx, index: number, offset = 0): DocPosition => {
  const t = tableOf(ctx.doc);
  return { section: 0, paragraph: t.para, offset, cell: { parentParagraph: t.para, control: t.controlIndex, cell: index, cellParagraph: 0 } };
};
const place = (ctx: Ctx, at: DocPosition) => { ctx.editor.anchor = ctx.editor.caret = at; };
function grid(d: RhwpDocument) {
  const t = tableOf(d), size = JSON.parse(d.getTableDimensions(0, t.para, t.controlIndex)) as { rowCount: number; colCount: number; cellCount: number };
  const cells = Array.from({ length: size.cellCount }, (_, i) => {
    const c = JSON.parse(d.getCellInfo!(0, t.para, t.controlIndex, i)) as { row: number; col: number; rowSpan: number; colSpan: number };
    const paragraphs = Array.from({ length: d.getCellParagraphCount(0, t.para, t.controlIndex, i) }, (_, p) =>
      d.getTextInCell(0, t.para, t.controlIndex, i, p, 0, d.getCellParagraphLength(0, t.para, t.controlIndex, i, p)));
    return `${c.row},${c.col} ${c.rowSpan}x${c.colSpan} ${paragraphs.join("|")}`;
  });
  return { rows: size.rowCount, cols: size.colCount, cells };
}
const STRUCTURE = ["table.insertRowAbove", "table.insertRowBelow", "table.insertColumnLeft", "table.insertColumnRight",
  "table.deleteRow", "table.deleteColumn", "table.mergeRight", "table.mergeBelow", "table.splitCell"] as const;

describe.runIf(phase === "generate")("T012 Phase 2 product session (Release WASM)", () => {
  it("records fixture provenance", () => {
    const fixtures = Object.fromEntries(FORMATS.flatMap(format => [[`nested.${format}`, sha(nestedFixture(format))], [`table.${format}`, sha(tableFixture(format))]]));
    writeFileSync(join(out, "fixtures.json"), JSON.stringify({ engineGeneration: build.generation, wasmSha256: build.artifacts["rhwp_bg.wasm"],
      nestedSource: { path: "external/rhwp/samples/inner-table-01.hwp", sha256: sha(new Uint8Array(readFileSync(NESTED_SAMPLE))),
        hwpx: "Release-engine HWPX export of the same sample" }, fixtures }, null, 2));
    expect(Object.keys(fixtures)).toHaveLength(4);
  });

  it("parses nested positions without confusing parent and nested cells", () => {
    const hit = { sectionIndex: 0, paragraphIndex: 0, charOffset: 2, parentParaIndex: 3, controlIndex: 2, cellIndex: 13, cellParaIndex: 4,
      cellPath: [{ controlIndex: 2, cellIndex: 13, cellParaIndex: 4 }, { controlIndex: 0, cellIndex: 5, cellParaIndex: 1 }] };
    const nested = parsePosition(hit)!;
    expect(nested.cell).toEqual({ parentParagraph: 3, control: 2, cell: 13, cellParagraph: 4, nested: [{ control: 0, cell: 5, cellParagraph: 1 }] });
    const parent = parsePosition({ ...hit, cellPath: [hit.cellPath[0]] })!;
    expect(parent.cell).toEqual({ parentParagraph: 3, control: 2, cell: 13, cellParagraph: 4 });
    expect(sameContext(nested, parent)).toBe(false); // nested cell ≠ its parent cell
    const sibling = parsePosition({ ...hit, cellPath: [hit.cellPath[0], { controlIndex: 0, cellIndex: 6, cellParaIndex: 0 }] })!;
    expect(sameContext(nested, sibling)).toBe(false); // ≠ sibling cell of the same nested table
    const otherTable = parsePosition({ ...hit, cellPath: [hit.cellPath[0], { controlIndex: 1, cellIndex: 5, cellParaIndex: 1 }] })!;
    expect(sameContext(nested, otherTable)).toBe(false); // ≠ same cell index of another table in the parent cell
    expect(sameContext(nested, parsePosition({ ...hit, charOffset: 0, cellPath: [hit.cellPath[0], { controlIndex: 0, cellIndex: 5, cellParaIndex: 0 }] })!)).toBe(true);
    // Refused shapes: first level disagreeing with the scalar fields, too deep, malformed levels.
    expect(parsePosition({ ...hit, cellPath: [{ controlIndex: 2, cellIndex: 12, cellParaIndex: 4 }, hit.cellPath[1]] })).toBeNull();
    expect(parsePosition({ ...hit, cellPath: [hit.cellPath[0], ...Array.from({ length: 4 }, () => hit.cellPath[1])] })).toBeNull();
    expect(parsePosition({ ...hit, cellPath: [hit.cellPath[0], { controlIndex: 0, cellIndex: -1, cellParaIndex: 0 }] })).toBeNull();
    expect(parsePosition({ ...hit, cellPath: [hit.cellPath[0], { controlIndex: 0, cellIndex: 5, cellParaIndex: 1, extra: 1 }] })).toBeNull();
    expect(parsePosition({ ...hit, cellPath: "x" })).toBeNull();
  });

  it.each(FORMATS)("%s: edits a nested cell directly; parent and sibling cells are untouched; Undo/Redo; save", async format => {
    const original = nestedFixture(format);
    const ctx = await open(format, original), { editor, doc } = ctx;
    const t = nestedTarget(doc);
    const before = nestedText(doc, t), rest = others(doc, t), all = JSON.stringify(model(doc));
    expect(before.length).toBeGreaterThan(0);
    // Cursor placement by a real click: the engine's hit test path is proven against the cursor lists.
    const rect = JSON.parse(doc.getCursorRectByPath!(t.at.section, t.outer.hostPara, t.path, 0)) as { pageIndex: number; x: number; y: number; height: number };
    expect(editor.pointAt(rect.pageIndex, rect.x + 0.5, rect.y + rect.height / 2, false)).toBe(true);
    expect(editor.caret.cell?.nested).toHaveLength(1);
    expect(sameContext(editor.caret, t.at)).toBe(true);
    expect(editor.caretRect()).not.toBeNull();
    // Advanced commands and structure commands stay closed inside the nested table, with a reason.
    for (const id of ["hangul.charWidth", "hangul.charSpacing", "hangul.tableFormula", "hangul.insertTableFormula", ...STRUCTURE] as const) {
      expect(state(ctx, id), id).toEqual({ available: false, reason: "nestedTable" });
    }
    place(ctx, t.at);
    // 1. plain insertion
    expect(editor.typeText("중첩")).toBe(true); await ctx.settle();
    expect(nestedText(doc, t)).toBe(`중첩${before}`);
    expect(others(doc, t)).toBe(rest);
    // 2. selection replacement inside the nested cell
    editor.endHistoryGroup();
    editor.anchor = { ...t.at, offset: 0 }; editor.caret = { ...t.at, offset: 2 };
    expect(editor.selectionRects().length).toBeGreaterThan(0);
    expect(editor.typeText("AB")).toBe(true); await ctx.settle();
    expect(nestedText(doc, t)).toBe(`AB${before}`);
    // 3. Backspace / Delete
    editor.endHistoryGroup();
    expect(editor.backspace()).toBe(true); await ctx.settle();
    expect(nestedText(doc, t)).toBe(`A${before}`);
    place(ctx, { ...t.at, offset: 0 });
    expect(editor.deleteForward()).toBe(true); await ctx.settle();
    expect(nestedText(doc, t)).toBe(before);
    // 4. paragraph split and merge inside the nested cell
    place(ctx, { ...t.at, offset: 1 });
    expect(editor.enter()).toBe(true); await ctx.settle();
    expect(doc.getCellParagraphCountByPath!(t.at.section, t.outer.hostPara, t.path)).toBe(2);
    expect([nestedText(doc, t, 0), nestedText(doc, t, 1)]).toEqual([Array.from(before)[0], Array.from(before).slice(1).join("")]);
    expect(editor.caret.cell?.nested?.[0]?.cellParagraph).toBe(1);
    expect(editor.backspace()).toBe(true); await ctx.settle();
    expect(doc.getCellParagraphCountByPath!(t.at.section, t.outer.hostPara, t.path)).toBe(1);
    expect(nestedText(doc, t)).toBe(before);
    expect(JSON.stringify(model(doc))).toBe(all); // exact original content after the inverse edits
    // 5. IME composition (조합 중 갱신 → 확정): no duplicate, no loss
    place(ctx, { ...t.at, offset: 0 });
    editor.beginComposition(); editor.updateComposition("ㅎ"); editor.updateComposition("하"); editor.updateComposition("한");
    expect(nestedText(doc, t)).toBe(`한${before}`);
    expect(editor.endComposition("한")).toBe("한"); await ctx.settle();
    expect(nestedText(doc, t)).toBe(`한${before}`);
    expect(others(doc, t)).toBe(rest);
    // 6. caret movement between nested cells stays in the nested table
    expect(editor.moveCell(1)).toBe(true);
    expect(editor.caret.cell).toMatchObject({ control: t.outer.controlIndex, cell: t.outer.cellIndex, nested: [{ control: t.inner.controlIndex, cell: 1, cellParagraph: 0 }] });
    expect(editor.moveCell(-1)).toBe(true);
    expect(sameContext(editor.caret, t.at)).toBe(true);
    expect(editor.moveVertical(1, false)).toBe(true);
    expect(editor.caret.cell?.nested).toHaveLength(1); // still an owned nested cell (not the parent)
    // 7. Undo to the original, Redo to the edited state
    const edited = JSON.stringify(model(doc));
    let undone = 0; while (editor.undo()) { undone += 1; await ctx.settle(); }
    expect(undone).toBeGreaterThan(0);
    expect(JSON.stringify(model(doc))).toBe(all);
    let redone = 0; while (editor.redo()) { redone += 1; await ctx.settle(); }
    expect(redone).toBe(undone);
    expect(JSON.stringify(model(doc))).toBe(edited);
    expect(nestedText(doc, t)).toBe(`한${before}`);
    // 8. save: real preflight + raw verdict; payload goes to the real service as a case
    const s = await save(ctx); expectPublishable(s);
    const reopened = new engine.HwpDocument(s.output!) as Doc;
    try { expect(JSON.stringify(model(reopened))).toBe(edited); expect(nestedText(reopened, t)).toBe(`한${before}`); } finally { reopened.free(); }
    record("nested-text", ctx, s);
  }, 120_000);

  it.each(FORMATS)("%s: a nested path the model does not own is refused without mutation or history", async format => {
    const ctx = await open(format, nestedFixture(format)), { editor, doc } = ctx;
    const t = nestedTarget(doc), all = JSON.stringify(model(doc));
    const cell = t.at.cell!;
    const bogus: DocPosition[] = [
      { ...t.at, cell: { ...cell, nested: [{ control: 7, cell: 0, cellParagraph: 0 }] } }, // no such table control in the host paragraph
      { ...t.at, cell: { ...cell, nested: [{ control: cell.nested![0]!.control, cell: 9999, cellParagraph: 0 }] } }, // cell out of range
      { ...t.at, cell: { ...cell, cellParagraph: cell.cellParagraph + 1 } }, // another host paragraph of the parent cell
      { ...t.at, cell: { ...cell, cell: 0 } }, // another parent cell (no nested table there)
      { ...t.at, cell: { ...cell, nested: [...cell.nested!, ...Array.from({ length: 4 }, () => ({ control: 0, cell: 0, cellParagraph: 0 }))] } }, // too deep
    ];
    for (const at of bogus) {
      place(ctx, at);
      expect(editor.typeText("X")).toBe(false);
      expect(editor.caret).toEqual({ section: 0, paragraph: 0, offset: 0 }); // the caret left the unowned cell
      await ctx.settle();
    }
    expect(JSON.stringify(model(doc))).toBe(all);
    expect(editor.snapshot().history).toEqual({ undo: false, redo: false });
    expect(editor.snapshot().revision).toBe(0);
    expect(ctx.calls.filter(c => c.method === "commit")).toHaveLength(0);
    // A table hosting nested tables is not restructured (cells hold controls): each command says why.
    place(ctx, { section: t.at.section, paragraph: t.outer.hostPara, offset: 0,
      cell: { parentParagraph: t.outer.hostPara, control: t.outer.controlIndex, cell: 0, cellParagraph: 0 } });
    for (const id of STRUCTURE) {
      const st = state(ctx, id);
      expect(st.available, id).toBe(false);
      if (format === "hwpx") expect(st, id).toEqual({ available: false, reason: "tableContent" });
      expect(editor.execute(id).accepted, id).toBe(false);
    }
    expect(JSON.stringify(model(doc))).toBe(all);
  }, 120_000);

  it.each(FORMATS)("%s: row and column insertion/deletion, merge and split — one Undo step each, save", async format => {
    const ctx = await open(format, tableFixture(format)), { editor, doc } = ctx;
    if (format === "hwp") expect(ctx.probe?.preflight.outcome).toBe("safe");
    const steps: { id: (typeof STRUCTURE)[number]; cell: number; expect: ReturnType<typeof grid>; caret: number }[] = [
      { id: "table.insertRowBelow", cell: 4, caret: 4, expect: { rows: 4, cols: 3, cells: [
        "0,0 1x1 c0", "0,1 1x1 c1", "0,2 1x1 c2", "1,0 1x1 c3", "1,1 1x1 c4", "1,2 1x1 c5", "2,0 1x1 ", "2,1 1x1 ", "2,2 1x1 ", "3,0 1x1 c6", "3,1 1x1 c7", "3,2 1x1 c8"] } },
      { id: "table.insertRowAbove", cell: 0, caret: 3, expect: { rows: 5, cols: 3, cells: [
        "0,0 1x1 ", "0,1 1x1 ", "0,2 1x1 ", "1,0 1x1 c0", "1,1 1x1 c1", "1,2 1x1 c2", "2,0 1x1 c3", "2,1 1x1 c4", "2,2 1x1 c5",
        "3,0 1x1 ", "3,1 1x1 ", "3,2 1x1 ", "4,0 1x1 c6", "4,1 1x1 c7", "4,2 1x1 c8"] } },
      { id: "table.insertColumnRight", cell: 3, caret: 4, expect: { rows: 5, cols: 4, cells: [
        "0,0 1x1 ", "0,1 1x1 ", "0,2 1x1 ", "0,3 1x1 ", "1,0 1x1 c0", "1,1 1x1 ", "1,2 1x1 c1", "1,3 1x1 c2", "2,0 1x1 c3", "2,1 1x1 ", "2,2 1x1 c4", "2,3 1x1 c5",
        "3,0 1x1 ", "3,1 1x1 ", "3,2 1x1 ", "3,3 1x1 ", "4,0 1x1 c6", "4,1 1x1 ", "4,2 1x1 c7", "4,3 1x1 c8"] } },
      { id: "table.insertColumnLeft", cell: 4, caret: 6, expect: { rows: 5, cols: 5, cells: [
        "0,0 1x1 ", "0,1 1x1 ", "0,2 1x1 ", "0,3 1x1 ", "0,4 1x1 ", "1,0 1x1 ", "1,1 1x1 c0", "1,2 1x1 ", "1,3 1x1 c1", "1,4 1x1 c2",
        "2,0 1x1 ", "2,1 1x1 c3", "2,2 1x1 ", "2,3 1x1 c4", "2,4 1x1 c5", "3,0 1x1 ", "3,1 1x1 ", "3,2 1x1 ", "3,3 1x1 ", "3,4 1x1 ",
        "4,0 1x1 ", "4,1 1x1 c6", "4,2 1x1 ", "4,3 1x1 c7", "4,4 1x1 c8"] } },
      { id: "table.deleteRow", cell: 0, caret: 0, expect: { rows: 4, cols: 5, cells: [
        "0,0 1x1 ", "0,1 1x1 c0", "0,2 1x1 ", "0,3 1x1 c1", "0,4 1x1 c2", "1,0 1x1 ", "1,1 1x1 c3", "1,2 1x1 ", "1,3 1x1 c4", "1,4 1x1 c5",
        "2,0 1x1 ", "2,1 1x1 ", "2,2 1x1 ", "2,3 1x1 ", "2,4 1x1 ", "3,0 1x1 ", "3,1 1x1 c6", "3,2 1x1 ", "3,3 1x1 c7", "3,4 1x1 c8"] } },
      { id: "table.deleteColumn", cell: 0, caret: 0, expect: { rows: 4, cols: 4, cells: [
        "0,0 1x1 c0", "0,1 1x1 ", "0,2 1x1 c1", "0,3 1x1 c2", "1,0 1x1 c3", "1,1 1x1 ", "1,2 1x1 c4", "1,3 1x1 c5",
        "2,0 1x1 ", "2,1 1x1 ", "2,2 1x1 ", "2,3 1x1 ", "3,0 1x1 c6", "3,1 1x1 ", "3,2 1x1 c7", "3,3 1x1 c8"] } },
      // merge c1 with c2 (both non-empty: the absorbed paragraphs follow), then with the row below (c4|c5 after merging those)
      { id: "table.mergeRight", cell: 2, caret: 2, expect: { rows: 4, cols: 4, cells: [
        "0,0 1x1 c0", "0,1 1x1 ", "0,2 1x2 c1|c2", "1,0 1x1 c3", "1,1 1x1 ", "1,2 1x1 c4", "1,3 1x1 c5",
        "2,0 1x1 ", "2,1 1x1 ", "2,2 1x1 ", "2,3 1x1 ", "3,0 1x1 c6", "3,1 1x1 ", "3,2 1x1 c7", "3,3 1x1 c8"] } },
      { id: "table.mergeRight", cell: 5, caret: 5, expect: { rows: 4, cols: 4, cells: [
        "0,0 1x1 c0", "0,1 1x1 ", "0,2 1x2 c1|c2", "1,0 1x1 c3", "1,1 1x1 ", "1,2 1x2 c4|c5",
        "2,0 1x1 ", "2,1 1x1 ", "2,2 1x1 ", "2,3 1x1 ", "3,0 1x1 c6", "3,1 1x1 ", "3,2 1x1 c7", "3,3 1x1 c8"] } },
      { id: "table.mergeBelow", cell: 2, caret: 2, expect: { rows: 4, cols: 4, cells: [
        "0,0 1x1 c0", "0,1 1x1 ", "0,2 2x2 c1|c2|c4|c5", "1,0 1x1 c3", "1,1 1x1 ",
        "2,0 1x1 ", "2,1 1x1 ", "2,2 1x1 ", "2,3 1x1 ", "3,0 1x1 c6", "3,1 1x1 ", "3,2 1x1 c7", "3,3 1x1 c8"] } },
      // an empty absorbed cell adds nothing
      { id: "table.mergeRight", cell: 0, caret: 0, expect: { rows: 4, cols: 4, cells: [
        "0,0 1x2 c0", "0,2 2x2 c1|c2|c4|c5", "1,0 1x1 c3", "1,1 1x1 ",
        "2,0 1x1 ", "2,1 1x1 ", "2,2 1x1 ", "2,3 1x1 ", "3,0 1x1 c6", "3,1 1x1 ", "3,2 1x1 c7", "3,3 1x1 c8"] } },
      { id: "table.splitCell", cell: 1, caret: 1, expect: { rows: 4, cols: 4, cells: [
        "0,0 1x2 c0", "0,2 1x1 c1|c2|c4|c5", "0,3 1x1 ", "1,0 1x1 c3", "1,1 1x1 ", "1,2 1x1 ", "1,3 1x1 ",
        "2,0 1x1 ", "2,1 1x1 ", "2,2 1x1 ", "2,3 1x1 ", "3,0 1x1 c6", "3,1 1x1 ", "3,2 1x1 c7", "3,3 1x1 c8"] } },
    ];
    const bodyText = doc.getTextRange(0, 0, 0, 4);
    const states: string[] = [JSON.stringify(model(doc))];
    let saves = 0;
    for (const [index, step] of steps.entries()) {
      place(ctx, cellAt(ctx, step.cell));
      expect(state(ctx, step.id), `${index} ${step.id}`).toEqual({ available: true });
      const revision = editor.snapshot().revision;
      expect(await run(ctx, step.id), `${index} ${step.id}`).toBe(true);
      expect(grid(doc), `${index} ${step.id}`).toEqual(step.expect);
      expect(editor.snapshot().revision).toBe(revision + 1); // one mutation
      // The caret is a valid cell of the new table (never a stale index), at offset 0.
      expect(editor.caret, `${index} ${step.id}`).toEqual(cellAt(ctx, step.caret));
      expect(editor.caretRect()).not.toBeNull();
      expect(doc.getTextRange(0, 0, 0, 4)).toBe(bodyText);
      states.push(JSON.stringify(model(doc)));
      // one Undo step = exactly this structure change; Redo restores it
      expect(editor.undo()).toBe(true); await ctx.settle();
      expect(JSON.stringify(model(doc))).toBe(states[index]);
      expect(editor.caretRect()).not.toBeNull();
      expect(editor.redo()).toBe(true); await ctx.settle();
      expect(JSON.stringify(model(doc))).toBe(states[index + 1]);
      expect(grid(doc)).toEqual(step.expect);
      // typing into a new/changed cell works and is part of the saved state
      if (step.id === "table.insertRowBelow") {
        place(ctx, cellAt(ctx, 7));
        expect(editor.typeText("새행")).toBe(true); await ctx.settle();
        expect(grid(doc).cells[7]).toBe("2,1 1x1 새행");
        expect(editor.backspace() && editor.backspace()).toBe(true); await ctx.settle();
        editor.endHistoryGroup();
      }
      // save after the insert block, the delete block and the merge/split block (repeated save of changed structure)
      if ([3, 5, 10].includes(index)) {
        const s = await save(ctx); expectPublishable(s);
        const reopened = new engine.HwpDocument(s.output!) as Doc;
        try { expect(grid(reopened)).toEqual(step.expect); expect(JSON.stringify(model(reopened))).toBe(JSON.stringify(model(doc))); } finally { reopened.free(); }
        record(`structure-${++saves}-${step.id.slice(6)}`, ctx, s);
        await ctx.adopt(s.output!); // the session's next original is what it just published
        if (format === "hwp") expect(ctx.probe?.preflight.outcome).toBe("safe");
      }
    }
    expect(saves).toBe(3);
  }, 240_000);

  it.each(FORMATS)("%s: unsupported shapes and contents refuse before any engine call", async format => {
    // (a) geometry: deleting a row/column crossed by a merged cell, merging unequal neighbours, splitting an unmerged cell
    const merged = tableFixture(format, (d, p, c) => { d.mergeTableCells!(0, p, c, 0, 0, 1, 0); });
    const ctx = await open(format, merged), { editor, doc } = ctx;
    const all = JSON.stringify(model(doc));
    expect(grid(doc).cells.slice(0, 3)).toEqual(["0,0 2x1 c0|c3", "0,1 1x1 c1", "0,2 1x1 c2"]);
    const refused: [number, (typeof STRUCTURE)[number]][] = [
      [1, "table.deleteRow"], // row 0 is crossed by the 2×1 cell
      [0, "table.deleteRow"],
      [0, "table.mergeRight"], // right neighbour spans one row, the cell two
      [1, "table.mergeBelow"], [1, "table.splitCell"], [8 - 1, "table.mergeRight"], // last column / unmerged
    ];
    place(ctx, cellAt(ctx, 1)); // row 0, col 1
    expect(state(ctx, "table.deleteColumn")).toEqual({ available: true }); // column 1 is not crossed: independent of the row refusal
    for (const [cell, id] of refused) {
      place(ctx, cellAt(ctx, cell));
      if (id === "table.mergeBelow") { expect(state(ctx, id).available).toBe(true); continue; } // (0,1)+(1,1): same width → allowed
      expect(state(ctx, id), `${cell} ${id}`).toEqual({ available: false, reason: "tableShape" });
      expect(editor.execute(id).accepted).toBe(false);
    }
    // a selection, a body caret
    editor.anchor = cellAt(ctx, 1, 0); editor.caret = cellAt(ctx, 1, 1);
    expect(state(ctx, "table.insertRowBelow")).toEqual({ available: false, reason: "notInTable" });
    place(ctx, { section: 0, paragraph: 0, offset: 0 });
    for (const id of STRUCTURE) { expect(state(ctx, id), id).toEqual({ available: false, reason: "notInTable" }); expect(editor.execute(id).accepted).toBe(false); }
    await ctx.settle();
    expect(JSON.stringify(model(doc))).toBe(all);
    expect(editor.snapshot().history).toEqual({ undo: false, redo: false });
    expect(editor.snapshot().revision).toBe(0);
    // (b) content: a formula field anywhere in the table blocks every structure command (references are coordinates)
    const ctx2 = await open(format, tableFixture(format)), doc2 = ctx2.doc;
    place(ctx2, cellAt(ctx2, 8));
    expect(ctx2.editor.execute("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=SUM(A1:B1)" }).accepted).toBe(true);
    await ctx2.settle();
    const withFormula = JSON.stringify(model(doc2)), revision = ctx2.editor.snapshot().revision;
    for (const cell of [0, 8]) {
      place(ctx2, cellAt(ctx2, cell));
      for (const id of STRUCTURE) {
        expect(state(ctx2, id), id).toEqual({ available: false, reason: "tableFormula" });
        expect(ctx2.editor.execute(id).accepted).toBe(false);
      }
    }
    await ctx2.settle();
    expect(JSON.stringify(model(doc2))).toBe(withFormula);
    expect(ctx2.editor.snapshot().revision).toBe(revision);
    expect(JSON.parse(doc2.getFieldList!())).toHaveLength(1);
  }, 120_000);

  it("hwp: a restructured table that is not plain is refused by the checker even if the session guard is bypassed", async () => {
    // The original table holds a formula field. The session refuses to restructure it (tableFormula); here the
    // engine is called directly, behind the session, to produce the output the guard exists to prevent. The
    // production checker must refuse it; the case goes to the real service, which must keep the original file.
    const original = tableFixture("hwp", (d, p, c) => {
      const r = JSON.parse(d.insertTableFormulaField!(0, p, c, 2, 2, "=SUM(A1:B1)") as string) as { ok: boolean };
      if (r.ok !== true) throw new Error("fixture formula");
    });
    const ctx = await open("hwp", original), { editor, doc } = ctx;
    expect(ctx.probe?.preflight.outcome).toBe("safe");
    place(ctx, cellAt(ctx, 4));
    expect(state(ctx, "table.insertRowBelow")).toEqual({ available: false, reason: "tableFormula" });
    const t = tableOf(doc);
    expect(JSON.parse(doc.insertTableRow!(0, t.para, t.controlIndex, 1, true)).ok).toBe(true); // not a product path
    place(ctx, { section: 0, paragraph: 0, offset: 0 });
    expect(editor.typeText("x")).toBe(true); await ctx.settle(); // a legitimate edit makes the session dirty
    const s = await save(ctx);
    expect(s.preflight.outcome).toBe("safe");
    expect(s.publishable).toBe(false);
    expect(s.raw!.findings.map(f => f.code)).toContain("recordsChanged");
    expect(s.result.ok).toBe(false);
    expect(editor.snapshot().revision).toBeGreaterThan(0); // nothing was published
    record("negative-nonplain-restructure", ctx, s, "recordsChanged");
  }, 120_000);
});

describe.runIf(phase === "repeat")("T012 Phase 2 repeated edits of the PUBLISHED files", () => {
  it.each(FORMATS)("%s: nested cell of the published document is edited and saved again", async format => {
    const original = published(format, "nested-text");
    const ctx = await open(format, original), { editor, doc } = ctx;
    const t = nestedTarget(doc), before = nestedText(doc, t), rest = others(doc, t);
    expect(before.startsWith("한")).toBe(true); // the first publication's edit is in the published file
    place(ctx, { ...t.at, offset: 1 });
    expect(editor.typeText("글")).toBe(true); await ctx.settle();
    expect(nestedText(doc, t)).toBe(`한글${before.slice(1)}`);
    expect(others(doc, t)).toBe(rest);
    const s = await save(ctx); expectPublishable(s);
    record("nested-text-again", ctx, s);
  }, 120_000);

  it.each(FORMATS)("%s: the published restructured table is changed and saved again", async format => {
    const original = published(format, "structure-3-splitCell");
    const ctx = await open(format, original), { editor, doc } = ctx;
    if (format === "hwp") expect(ctx.probe?.preflight.outcome).toBe("safe");
    const before = grid(doc);
    expect(before).toMatchObject({ rows: 4, cols: 4 });
    expect(before.cells[1]).toBe("0,2 1x1 c1|c2|c4|c5");
    place(ctx, cellAt(ctx, 14)); // last row
    expect(await run(ctx, "table.deleteRow")).toBe(true);
    place(ctx, cellAt(ctx, 0)); // 1×2 cell "c0"
    expect(await run(ctx, "table.splitCell")).toBe(true);
    place(ctx, cellAt(ctx, 1));
    expect(editor.typeText("다시")).toBe(true); await ctx.settle();
    expect(grid(doc)).toEqual({ rows: 3, cols: 4, cells: [
      "0,0 1x1 c0", "0,1 1x1 다시", "0,2 1x1 c1|c2|c4|c5", "0,3 1x1 ", "1,0 1x1 c3", "1,1 1x1 ", "1,2 1x1 ", "1,3 1x1 ",
      "2,0 1x1 ", "2,1 1x1 ", "2,2 1x1 ", "2,3 1x1 "] });
    const s = await save(ctx); expectPublishable(s);
    record("structure-again", ctx, s);
  }, 120_000);
});

describe.runIf(phase === "verify")("T012 Phase 2 published files reopen independently", () => {
  it.each(FORMATS)("%s: every published file equals the model recorded at save time; refused cases kept the original", format => {
    const results: Record<string, unknown>[] = [];
    for (const list of ["cases-first.json", "cases-repeat.json"]) {
      const cases = JSON.parse(readFileSync(join(out, format, list), "utf8")) as { id: string; negative?: boolean }[];
      expect(cases.length).toBeGreaterThan(0);
      for (const { id, negative } of cases) {
        const dir = join(out, format, id);
        const proof = JSON.parse(readFileSync(join(dir, "proof.json"), "utf8")) as { expected: ReturnType<typeof model>; originalSha256: string; editedSha256: string };
        const original = new Uint8Array(readFileSync(join(dir, `original.${format}`)));
        expect(sha(original)).toBe(proof.originalSha256);
        if (negative) {
          expect(existsSync(join(dir, "published.hwp"))).toBe(false);
          results.push({ id, negative: true, originalSha256: sha(original), published: false });
          continue;
        }
        const bytes = published(format, id);
        const d = new engine.HwpDocument(bytes) as Doc;
        try {
          expect(d.getSourceFormat()).toBe(format);
          const actual = model(d);
          expect(actual, id).toEqual(proof.expected);
          results.push({ id, publishedSha256: sha(bytes), originalSha256: sha(original), pages: actual.pages, tables: actual.tables.length, nestedCells: actual.nested.length, equal: true });
        } finally { d.free(); }
      }
    }
    writeFileSync(join(out, format, "published-reopen.json"), JSON.stringify({ engineGeneration: build.generation, results }, null, 2));
    expect(results.filter(r => r.equal).length).toBeGreaterThanOrEqual(6);
  }, 120_000);
});
