// @vitest-environment jsdom
// Stage 1 RHWP character values (size, text color, highlight/shade, superscript/subscript): focused evidence through
// the production session path on the actual Release WASM. Same pipeline as general-formatting.wasm.test.ts: generate
// exact exports; the ignored Rust test `general_formatting_real_publication` publishes them; verify reopens them.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { documentCommandState } from "../../src/commands/capability";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import { preserveSourceCaret, type RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import { pathJson } from "../../src/components/Editor/rhwp/rhwpText";
import { configureEmbedding } from "../../src/fonts/embedding";
import type { FontBackend } from "../../src/adapters/fonts";
import { base, controlledBackend, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
const wasm = engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const out = resolve(process.env.GEUL_FORMAT_OUT ?? join(root, "src-tauri/target/stage1-format")); mkdirSync(out, { recursive: true });
const phase = process.env.GEUL_FORMAT_PHASE ?? "generate";
type Format = "hwp" | "hwpx";
type Doc = RhwpDocument & { getTextFileText(): string; renderPageSvgWithProfile(p: number, profile: string): string };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const json = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2));
const body = (offset: number, paragraph = 0) => ({ section: 0, paragraph, offset });
function exported(d: RhwpDocument, format: Format) {
  const e = format === "hwp" ? d.exportHwpWithReport() : d.exportHwpxWithReport();
  try { return { bytes: e.takeBytes(), loss: e.contentLoss() }; } finally { e.free(); }
}
function source(format: Format) {
  // HWP: the prepared nonblank-preview source of the general formatting evidence (an input fixture, generation independent).
  if (format === "hwp") return new Uint8Array(readFileSync(process.env.GEUL_STAGE1_HWP_SEED ?? join(root, "src-tauri/target/general-formatting/seed-prepared.hwp")));
  const d = engine.HwpDocument.createEmpty();
  try {
    d.createBlankDocument(); d.insertText(0, 0, 0, "한글 Mixed text 끝 end"); d.splitParagraph(0, 0, d.getParagraphLength(0, 0));
    d.insertText(0, 1, 0, "Second paragraph"); d.splitParagraph(0, 1, 16);
    const t = JSON.parse(d.createTable(0, 2, 0, 1, 2));
    d.insertTextInCell(0, t.paraIdx, t.controlIdx, 0, 0, 0, "셀 하나 text");
    d.insertTextInCell(0, t.paraIdx, t.controlIdx, 1, 0, 0, "인접 Cell");
    return exported(d, format).bytes;
  } finally { d.free(); }
}
function properties(d: RhwpDocument, p = 0, offset = 0) { return JSON.parse(d.getCharPropertiesAt!(0, p, offset)); }
function model(d: Doc) {
  const read = (n: number, get: (i: number) => string) => Array.from({ length: n }, (_, i) => {
    const value = JSON.parse(get(i)); delete value.charShapeId; return value;
  });
  // Top-level tables only (nested tables are reached through their cells' text in this comparison).
  const controls = JSON.parse(d.getControls!()).filter((c: { list: number }) => c.list === 0);
  return { text: d.getTextFileText(), controls, pages: d.pageCount(),
    body: Array.from({ length: d.getParagraphCount(0) }, (_, p) => read(d.getParagraphLength(0, p), i => d.getCharPropertiesAt!(0, p, i))),
    cells: controls.filter((c: {ctrlId: string}) => c.ctrlId === "tbl").map((c: {para: number; controlIndex: number}) => {
      const size = JSON.parse(d.getTableDimensions(0, c.para, c.controlIndex));
      return Array.from({ length: size.cellCount }, (_, cell) => Array.from({ length: d.getCellParagraphCount(0, c.para, c.controlIndex, cell) }, (_, p) =>
        read(d.getCellParagraphLength(0, c.para, c.controlIndex, cell, p), i => d.getCellCharPropertiesAt!(0, c.para, c.controlIndex, cell, p, i))));
    }) };
}
async function open(format: Format, original = source(format), answer = true, sourcePath?: string) {
  const { backend, take, calls } = controlledBackend(), sessions = new DocumentSessions(backend);
  const opening = sessions.open(sourcePath ?? `/a.${format}`); take("open").reply(ok({ ...base, format })); await opening;
  let doc!: Doc;
  const editor = new RhwpEditorSession(1, backend, sessions, async () => ({
    openDocument: bytes => { const d = preserveSourceCaret(new engine.HwpDocument(bytes)) as Doc; doc ??= d; return d; },
    memoryBytes: () => wasm.memory.buffer.byteLength,
  }));
  const loading = editor.load(); take("load").reply(loaded(original)); await flush();
  take("session").reply(ok(info({ format, state: "loading", sequence: 1 })));
  take("setState").reply(ok(info({ format, state: "ready", sequence: 2 }))); await loading;
  if (format === "hwp" && answer) {
    take("original").reply(ok(original)); await flush();
    const call = take("preflight"), temp = join(out, "preflight"); mkdirSync(temp, { recursive: true });
    writeFileSync(join(temp, "original.hwp"), original); writeFileSync(join(temp, "noop.hwp"), call.args[2] as Uint8Array); json(join(temp, "loss.json"), call.args[3]);
    const result = JSON.parse(execFileSync(join(root, "src-tauri/target/debug/examples/save_check"),
      ["preflight", "hwp", join(temp, "original.hwp"), join(temp, "noop.hwp"), join(temp, "loss.json")], { encoding: "utf8" }));
    expect(result.outcome, JSON.stringify(result)).toBe("safe"); call.reply(ok({ preservation: result, platformSupported: true })); await flush();
  }
  const settle = async () => { await flush(); while (calls.some(c => c.method === "commit")) {
    const c = take("commit"); c.reply(ok(info({ format, state: "ready", dirty: true, revision: Number(c.args[2]) + Number(c.args[3]), sequence: sessions.get(1)!.sequence + 1 }))); await flush();
  } };
  const table = JSON.parse(doc.getControls!()).find((c: {ctrlId: string}) => c.ctrlId === "tbl");
  const cell = (offset: number, index = 0) => ({ section: 0, paragraph: table.para, offset,
    cell: { parentParagraph: table.para, control: table.controlIndex, cell: index, cellParagraph: 0 } });
  const cellProps = (offset: number, index = 0) => JSON.parse(doc.getCellCharPropertiesAt!(0, table.para, table.controlIndex, index, 0, offset));
  return { editor, get doc() { return doc; }, clearLive: () => { doc = undefined!; }, original, settle, cell, cellProps, calls, sessions, take };
}
/** P1-D: exact paragraph properties of a nested-cell paragraph (read through the explicit-path engine API), its
 * containing cell paragraph and the neighbouring top-level cell, plus the containing cell paragraph's length. */
type NestedSpec = { parent: number; path: string; outer: [number, number, number]; neighbor: [number, number, number] };
const PARA_KEYS = ["alignment", "lineSpacing", "lineSpacingType", "marginLeft", "marginRight", "indent", "spacingBefore", "spacingAfter", "headType", "paraLevel"];
function nestedModel(d: RhwpDocument, spec: NestedSpec) {
  const pick = (raw: string) => { const v = JSON.parse(raw); return Object.fromEntries(PARA_KEYS.map(k => [k, v[k]])); };
  const api = d as unknown as { getCellParaPropertiesAtByPath(s: number, p: number, path: string): string; getCellParaPropertiesAt(...a: number[]): string };
  const [c, cell, cp] = spec.outer, [nc, ncell, ncp] = spec.neighbor;
  return { path: JSON.parse(spec.path), nested: pick(api.getCellParaPropertiesAtByPath(0, spec.parent, spec.path)),
    outer: pick(api.getCellParaPropertiesAt(0, spec.parent, c, cell, cp)), neighbor: pick(api.getCellParaPropertiesAt(0, spec.parent, nc, ncell, ncp)),
    outerLength: d.getCellParagraphLength(0, spec.parent, c, cell, cp) };
}
const cases: { id: string; format: Format; previewRequired: boolean; nested?: NestedSpec }[] = [];
function record(id: string, format: Format, original: Uint8Array, doc: Doc, previewRequired = true, nested?: NestedSpec) {
  if (format === "hwp") doc.rebuildLayout!();
  const e = exported(doc, format), re = new engine.HwpDocument(e.bytes) as Doc;
  try {
    expect(model(re)).toEqual(model(doc));
    if (nested) expect(nestedModel(re, nested)).toEqual(nestedModel(doc, nested));
    const fresh = new engine.HwpDocument(original), noop = exported(fresh, format); fresh.free();
    const dir = join(out, id); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `original.${format}`), original); writeFileSync(join(dir, `noop.${format}`), noop.bytes);
    writeFileSync(join(dir, `edited.${format}`), e.bytes); writeFileSync(join(dir, "loss.json"), e.loss); writeFileSync(join(dir, "noop-loss.json"), noop.loss);
    if (format === "hwp") {
      const page = JSON.parse(re.getPageInfo(0)), long = Math.max(page.width, page.height);
      const svg = re.renderPageSvgWithProfile(0, "screen"); expect(svg).not.toMatch(/(?:href|src)=["']https?:/i);
      writeFileSync(join(dir, "render.svg"), svg);
      execFileSync("rsvg-convert", ["--background-color", "white", "--width", String(Math.round(page.width / long * 1024)), "--height", String(Math.round(page.height / long * 1024)),
        "--output", join(dir, "render.png"), join(dir, "render.svg")]);
    }
    json(join(dir, "proof.json"), { generation: build.generation, originalSha256: sha(original), editedSha256: sha(e.bytes), model: model(re),
      ...(nested ? { nested: nestedModel(re, nested) } : {}) });
    cases.push({ id, format, previewRequired, ...(nested ? { nested } : {}) }); json(join(out, "cases.json"), cases);
  } finally { re.free(); }
}


describe.skipIf(phase !== "generate")("Stage 1 character values, production session path, actual Release WASM", () => {
  for (const format of ["hwpx", "hwp"] as const) {
    it(`${format}: size, color, highlight, scripts; mixed state, cells, history, export`, async () => {
      const { editor, doc, original, settle, cell, cellProps } = await open(format);
      try {
        // Caret-only formatting is offered as next-input formatting (covered by the caret scenario below).
        editor.anchor = body(0); editor.caret = body(0);
        expect(documentCommandState("format.fontSize", editor.snapshot())).toEqual({ available: true });
        editor.anchor = body(0); editor.caret = body(4);
        const chars = editor.snapshot().chars!;
        expect(chars.size).toBe(10);
        const before = doc.renderPageSvgWithProfile(0, "screen");
        expect(editor.execute("format.fontSize", { command: "format.fontSize", size: 18 }).accepted).toBe(true); await settle();
        expect([0, 3, 4].map(i => properties(doc, 0, i).fontSize)).toEqual([1800, 1800, 1000]);
        expect(doc.renderPageSvgWithProfile(0, "screen")).not.toBe(before);
        expect(editor.snapshot().chars!.size).toBe(18);
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        expect(properties(doc, 0, 0).fontSize).toBe(1000);
        expect(doc.renderPageSvgWithProfile(0, "screen")).toBe(before);
        expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
          expect(properties(doc, 0, 0).fontSize).toBe(1800);
        expect(editor.execute("format.fontColor", { command: "format.fontColor", color: "C00000" }).accepted).toBe(true); await settle();
        expect(editor.execute("format.highlight", { command: "format.highlight", color: "yellow" }).accepted).toBe(true); await settle();
        expect(editor.execute("format.superscript").accepted).toBe(true); await settle();
        let p = properties(doc, 0, 1);
        expect([p.textColor, p.shadeColor, p.superscript, p.subscript, p.bold]).toEqual(["#c00000", "#ffff00", true, false, false]);
        expect(editor.snapshot().chars).toEqual({ size: 18, color: "C00000", highlight: "FFFF00", superscript: true, subscript: false });
        expect(editor.snapshot().actions?.["format.superscript"]).toEqual({ pressed: true });
        // Subscript replaces superscript (mutually exclusive in the engine and in the save proof).
        expect(editor.execute("format.subscript").accepted).toBe(true); await settle();
        p = properties(doc, 0, 1);
        expect([p.superscript, p.subscript]).toEqual([false, true]);
        // Unselected characters keep everything.
        const untouched = properties(doc, 0, 5);
        expect([untouched.fontSize, untouched.textColor, untouched.superscript, untouched.subscript]).toEqual([1000, "#000000", false, false]);
        // A selection over two character shapes reports mixed values (never the first character's).
        editor.anchor = body(2); editor.caret = body(7);
        expect(editor.snapshot().chars!.size).toBeNull();
        // Table cell: local to the cell; the adjacent cell is unchanged.
        editor.anchor = cell(0); editor.caret = cell(2);
        expect(editor.execute("format.fontSize", { command: "format.fontSize", size: 14 }).accepted).toBe(true); await settle();
        expect([cellProps(0).fontSize, cellProps(1).fontSize, cellProps(2).fontSize, cellProps(0, 1).fontSize]).toEqual([1400, 1400, 1000, 1000]);
        // Invalid values never reach the engine.
        expect(editor.execute("format.fontSize", { command: "format.fontSize", size: 5000 }).accepted).toBe(false);
        expect(editor.execute("format.fontColor", { command: "format.fontColor", color: "red" }).accepted).toBe(false);
        record(`${format}-stage1-chars`, format, original, doc);
        // Removing the highlight stores the format's no-shading value (not white) and reports no highlight.
        editor.anchor = body(0); editor.caret = body(4);
        expect(editor.execute("format.highlight", { command: "format.highlight", color: "none" }).accepted).toBe(true); await settle();
        expect(properties(doc, 0, 0).shadeColor).toBe("none");
        expect(editor.snapshot().chars!.highlight).toBeNull();
        record(`${format}-stage1-highlight-off`, format, original, doc);
      } finally { editor.dispose(); }
    });
  }
});

describe.skipIf(phase !== "generate")("Stage 1 find/replace, production session path, actual Release WASM", () => {
  for (const format of ["hwpx", "hwp"] as const) {
    it(`${format}: model search, options, cells, stale refusal, replace, replace all, history, export`, async () => {
      const { editor, doc, original, settle } = await open(format);
      try {
        const q = (text: string, matchCase = false, wholeWord = false) => ({ text, matchCase, wholeWord });
        expect(editor.snapshot().searchable).toBe(true);
        expect(editor.search({ kind: "find", query: q("text"), backward: false })).toBe(true);
        // Body paragraph and the first table cell (model text, not rendered output).
        expect(editor.snapshot().search).toMatchObject({ count: 2, current: 0 });
        expect(doc.getTextRange(0, 0, editor.anchor.offset, 4)).toBe("text");
        expect(editor.search({ kind: "find", query: q("text"), backward: false })).toBe(true);
        expect(editor.snapshot().search).toMatchObject({ count: 2, current: 1 });
        expect(editor.caret.cell).toBeTruthy();
        expect(editor.search({ kind: "find", query: q("text"), backward: false })).toBe(true);
        expect(editor.snapshot().search!.current).toBe(0); // wraps
        expect(editor.search({ kind: "find", query: q("TEXT", true), backward: false })).toBe(true);
        expect(editor.snapshot().search!.count).toBe(0);
        expect(editor.search({ kind: "find", query: q("Cel", false, true), backward: false })).toBe(true);
        expect(editor.snapshot().search!.count).toBe(0);
        expect(editor.search({ kind: "find", query: q("Cell", true, true), backward: false })).toBe(true);
        expect(editor.snapshot().search!.count).toBe(1);
        expect(editor.search({ kind: "find", query: q("끝"), backward: false })).toBe(true);
        expect(editor.snapshot().search!.count).toBe(1);
        expect(editor.snapshot().revision).toBe(0);
        // Replace the selected match (surrogate pair in the replacement); a stale selection is refused.
        editor.anchor = editor.caret = body(0);
        expect(editor.search({ kind: "find", query: q("text"), backward: false })).toBe(true);
        expect(editor.anchor.cell).toBeUndefined();
        const at = editor.anchor;
        expect(editor.search({ kind: "replace", query: q("text"), with: "글자😀" })).toBe(true); await settle();
        expect(doc.getTextRange(0, 0, at.offset, 3)).toBe("글자😀");
        expect(editor.snapshot().revision).toBe(1);
        editor.anchor = editor.caret = body(0);
        expect(editor.search({ kind: "replace", query: q("text"), with: "x" })).toBe(false);
        expect(editor.snapshot().revision).toBe(1);
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        expect(doc.getTextRange(0, 0, at.offset, 4)).toBe("text");
        expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
        // Replace all: one history step.
        expect(editor.search({ kind: "replaceAll", query: q("e"), with: "E" })).toBe(true); await settle();
        const all = doc.getTextRange(0, 1, 0, 16);
        expect(all).toBe("SEcond paragraph".replace("S", "S"));
        expect(editor.search({ kind: "find", query: q("e", true), backward: false })).toBe(true);
        expect(editor.snapshot().search!.count).toBe(0);
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        expect(doc.getTextRange(0, 1, 0, 16)).toBe("Second paragraph");
        expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
        expect(editor.search({ kind: "replaceAll", query: q("없는"), with: "y" })).toBe(false);
        expect(editor.search({ kind: "clear" })).toBe(true);
        expect(editor.snapshot().search).toBeNull();
        record(`${format}-stage1-replace`, format, original, doc);
      } finally { editor.dispose(); }
    });
  }
});

describe.skipIf(phase !== "generate")("Stage 1 paragraph alignment and formatting, production session path, actual Release WASM", () => {
  for (const format of ["hwpx", "hwp"] as const) {
    it(`${format}: alignment, mixed state, spacing/indents, history, export`, async () => {
      const { editor, doc, original, settle } = await open(format);
      try {
        const para = (p: number) => JSON.parse(doc.getParaPropertiesAt!(0, p));
        const before = [0, 1, 2].map(p => para(p));
        editor.anchor = body(2); editor.caret = body(3, 1);
        expect(editor.snapshot().paragraph?.align).toBe(before[0].alignment === "justify" ? "justify" : editor.snapshot().paragraph?.align);
        const svg = doc.renderPageSvgWithProfile(0, "screen");
        expect(editor.execute("paragraph.alignCenter").accepted).toBe(true); await settle();
        expect([0, 1].map(p => para(p).alignment)).toEqual(["center", "center"]);
        expect(para(2).alignment).toBe(before[2].alignment);
        expect(doc.renderPageSvgWithProfile(0, "screen")).not.toBe(svg);
        expect(editor.snapshot().actions?.["paragraph.alignCenter"]).toEqual({ pressed: true });
        // Mixed selection (centered + unchanged paragraph) reports no uniform alignment.
        editor.anchor = body(0, 1); editor.caret = body(2, 2);
        expect(editor.snapshot().paragraph?.align ?? null).toBe(before[2].alignment === "center" ? "center" : null);
        editor.anchor = body(2); editor.caret = body(3, 1);
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        expect(para(0).alignment).toBe(before[0].alignment);
        expect(doc.renderPageSvgWithProfile(0, "screen")).toBe(svg);
        expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
        expect(para(0).alignment).toBe("center");
        expect(editor.execute("paragraph.alignRight").accepted).toBe(true); await settle();
        expect(para(1).alignment).toBe("right");
        const format_ = { lineSpacing: { rule: "multiple" as const, value: 1.6 }, spaceBefore: 6, spaceAfter: 4, indentLeft: 10, indentRight: 5, indentFirst: -8 };
        expect(editor.execute("paragraph.settings", { command: "paragraph.settings", format: format_ }).accepted).toBe(true); await settle();
        const state = editor.snapshot().paragraph!;
        expect(state.lineSpacing).toEqual({ rule: "multiple", value: 1.6 });
        expect([state.spaceBefore, state.spaceAfter, state.indentLeft, state.indentRight, state.indentFirst]).toEqual([6, 4, 10, 5, -8]);
        expect(state.align).toBe("right"); // unrelated paragraph value preserved
        expect(para(2).lineSpacing).toBe(before[2].lineSpacing);
        expect(editor.execute("paragraph.settings", { command: "paragraph.settings", format: { lineSpacing: { rule: "exactly", value: 18 } } }).accepted).toBe(true); await settle();
        expect(editor.snapshot().paragraph!.lineSpacing).toEqual({ rule: "exactly", value: 18 });
        expect(editor.snapshot().paragraph!.indentLeft).toBe(10);
        expect(editor.execute("paragraph.settings", { command: "paragraph.settings", format: { spaceBefore: -1 } }).accepted).toBe(false);
        // Table cells are not offered for paragraph formatting in RHWP (bullet-path eligibility: body only).
        record(`${format}-stage1-paragraph`, format, original, doc);
      } finally { editor.dispose(); }
    });
  }
});

describe.skipIf(phase !== "generate")("Stage 1 page setup, production session path, actual Release WASM", () => {
  for (const format of ["hwpx", "hwp"] as const) {
    it(`${format}: margins, orientation, paper size, repagination, history, export`, async () => {
      const { editor, doc, original, settle } = await open(format);
      try {
        const def = () => JSON.parse(doc.getPageDef!(0));
        const before = def();
        editor.anchor = editor.caret = body(0);
        const page = editor.snapshot().page!;
        expect(page.paper).toBe("A4");
        expect(editor.execute("layout.size", { command: "layout.size", name: "A5" }).accepted).toBe(true); await settle();
        expect([def().width, def().height]).toEqual([41953, 59528]);
        expect(editor.snapshot().page!.paper).toBe("A5");
        expect(editor.execute("layout.orientation", { command: "layout.orientation", landscape: true }).accepted).toBe(true); await settle();
        expect(def().landscape).toBe(true);
        const info = JSON.parse(doc.getPageInfo(0));
        expect(info.width).toBeGreaterThan(info.height);
        expect(editor.execute("layout.margins", { command: "layout.margins", top: 36, bottom: 40, left: 50, right: 54 }).accepted).toBe(true); await settle();
        expect([def().marginTop, def().marginBottom, def().marginLeft, def().marginRight]).toEqual([3600, 4000, 5000, 5400]);
        expect([def().marginHeader, def().marginFooter]).toEqual([before.marginHeader, before.marginFooter]);
        // Margins leaving no text area are refused without change.
        expect(editor.execute("layout.margins", { command: "layout.margins", top: 300, bottom: 300, left: 10, right: 10 }).accepted).toBe(false);
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        expect(def().marginTop).toBe(before.marginTop);
        expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
        expect(def().marginTop).toBe(3600);
        record(`${format}-stage1-page`, format, original, doc);
      } finally { editor.dispose(); }
    });
  }
});

describe.skipIf(phase !== "generate")("Stage 1 complete search count and all-or-nothing replace all, actual Release WASM", () => {
  function many(format: Format, count: number) {
    const d = engine.HwpDocument.createEmpty();
    try {
      d.createBlankDocument();
      const first = Math.ceil(count / 2);
      // "가😀" matches across two paragraphs (code-point offsets, surrogate pairs) in a mixed-format paragraph.
      d.insertText(0, 0, 0, "가😀b".repeat(first)); d.splitParagraph(0, 0, 3 * first);
      d.insertText(0, 1, 0, "x가😀".repeat(count - first) + " 끝");
      d.applyCharFormat!(0, 0, 0, 9, JSON.stringify({ bold: true }));
      return exported(d, format).bytes;
    } finally { d.free(); }
  }
  // HWPX: an engine-created HWP fails the original preflight (its PrvText changes on an unedited round trip), so the
  // generated large source is HWPX; HWP shares the same session code path (covered by the smaller HWP replace case).
  for (const format of ["hwpx"] as const) {
    it(`${format}: over the bound refused whole (no change); within it complete, one history step, export`, async () => {
      const over = await open(format, many(format, 520), format === "hwp");
      try {
        const q = { text: "가😀", matchCase: true, wholeWord: false };
        expect(over.editor.search({ kind: "find", query: q, backward: false })).toBe(true);
        expect(over.editor.snapshot().search).toMatchObject({ count: 520, complete: true });
        const before = over.doc.getTextRange(0, 0, 0, 30);
        expect(over.editor.search({ kind: "replaceAll", query: q, with: "나" })).toBe(false);
        expect(over.editor.snapshot().revision).toBe(0);
        expect(over.doc.getTextRange(0, 0, 0, 30)).toBe(before);
      } finally { over.editor.dispose(); }
      const { editor, doc, original, settle } = await open(format, many(format, 480), format === "hwp");
      try {
        const q = { text: "가😀", matchCase: true, wholeWord: false };
        expect(editor.search({ kind: "find", query: q, backward: false })).toBe(true);
        expect(editor.snapshot().search).toMatchObject({ count: 480, complete: true });
        const replaced = editor.search({ kind: "replaceAll", query: q, with: "나" });
        expect(replaced).toBe(true); await settle();
        expect(editor.search({ kind: "find", query: q, backward: false })).toBe(true);
        expect(editor.snapshot().search!.count).toBe(0);
        expect(doc.getTextRange(0, 0, 0, 4)).toBe("나b나b");
        expect(doc.getTextRange(0, 1, 240 * 2, 2)).toBe(" 끝");
        expect(properties(doc, 0, 0).bold).toBe(true);
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        expect(editor.search({ kind: "find", query: q, backward: false })).toBe(true);
        expect(editor.snapshot().search!.count).toBe(480);
        expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
        record(`${format}-stage1-replace-many`, format, original, doc, false);
      } finally { editor.dispose(); }
    }, 120_000);
  }
});

describe.skipIf(phase !== "generate")("Stage 1 multicolumn layout, production session path, actual Release WASM", () => {
  for (const format of ["hwpx", "hwp"] as const) {
    it(`${format}: columns on the section's existing definition, page properties kept, history, export`, async () => {
      const { editor, doc, original, settle } = await open(format);
      try {
        const cols = () => JSON.parse(doc.getColumnDef!(0));
        const page = JSON.parse(doc.getPageDef!(0));
        editor.anchor = editor.caret = body(0);
        expect(editor.snapshot().page!.columns).toBe(1);
        const svg = doc.renderPageSvgWithProfile(0, "screen");
        expect(editor.execute("layout.columns", { command: "layout.columns", count: 2, space: 24 }).accepted).toBe(true); await settle();
        expect(cols()).toMatchObject({ columnCount: 2, sameWidth: true, spacing: 2400 });
        expect(editor.snapshot().page!.columns).toBe(2);
        expect(doc.renderPageSvgWithProfile(0, "screen")).not.toBe(svg);
        expect(JSON.parse(doc.getPageDef!(0))).toEqual(page);
        expect(editor.execute("layout.columns", { command: "layout.columns", count: 12, space: 300 }).accepted).toBe(false);
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        expect(cols().columnCount).toBe(1);
        expect(doc.renderPageSvgWithProfile(0, "screen")).toBe(svg);
        expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
        expect(cols().columnCount).toBe(2);
        record(`${format}-stage1-columns`, format, original, doc);
      } finally { editor.dispose(); }
    });
  }
});

describe.skipIf(phase !== "generate")("Stage 1 mixed script state and caret next-input formatting, actual Release WASM", () => {
  for (const format of ["hwpx", "hwp"] as const) {
    it(`${format}: per-property uniformity across shapes; pending caret values for typing and IME; history; export`, async () => {
      const { editor, doc, original, settle } = await open(format);
      try {
        // B1: different shapes (size differs) but uniform superscript → pressed; mixed with normal text → null.
        editor.anchor = body(0); editor.caret = body(4);
        expect(editor.execute("format.superscript").accepted).toBe(true); await settle();
        editor.anchor = body(0); editor.caret = body(2);
        expect(editor.execute("format.fontSize", { command: "format.fontSize", size: 16 }).accepted).toBe(true); await settle();
        editor.anchor = body(0); editor.caret = body(4);
        expect(editor.snapshot().chars).toMatchObject({ size: null, superscript: true, subscript: false });
        expect(editor.snapshot().actions?.["format.superscript"]).toEqual({ pressed: true });
        editor.anchor = body(2); editor.caret = body(7);
        expect(editor.snapshot().chars).toMatchObject({ superscript: null, subscript: false });
        expect(editor.snapshot().actions?.["format.superscript"]).toEqual({ pressed: false });
        // Toggling a mixed selection turns the script on for all of it.
        expect(editor.execute("format.superscript").accepted).toBe(true); await settle();
        expect([2, 6].map(i => properties(doc, 0, i).superscript)).toEqual([true, true]);
        // B2: caret-only values are pending (no document change) and apply to the next typed text only.
        const end = doc.getParagraphLength(0, 1);
        editor.anchor = editor.caret = body(end, 1);
        const revision = editor.snapshot().revision;
        expect(editor.execute("format.fontSize", { command: "format.fontSize", size: 20 }).accepted).toBe(true);
        expect(editor.execute("format.fontColor", { command: "format.fontColor", color: "0070C0" }).accepted).toBe(true);
        expect(editor.execute("format.highlight", { command: "format.highlight", color: "yellow" }).accepted).toBe(true);
        expect(editor.execute("format.subscript").accepted).toBe(true);
        expect(editor.snapshot().revision).toBe(revision);
        expect(editor.snapshot().chars).toMatchObject({ size: 20, color: "0070C0", subscript: true });
        const pendingCaret = editor.caretRect();
        expect(pendingCaret).not.toBeNull();
        // The Ribbon temporarily owns focus. Returning to the same rendered caret is not
        // navigation and must keep the next-input values in both HWP and HWPX sessions.
        expect(editor.pointAt(pendingCaret!.page, pendingCaret!.x, pendingCaret!.y + pendingCaret!.height / 2, false)).toBe(true);
        expect(editor.pendingCharState?.props).toMatchObject({ fontSize: 2000, textColor: "#0070C0", shadeColor: "#FFFF00", subscript: true });
        // Cancelling an in-progress IME composition leaves the same pending values available.
        editor.beginComposition(); editor.updateComposition("ㄱ"); editor.endComposition(""); await settle();
        expect(editor.pendingCharState?.props).toMatchObject({ fontSize: 2000, textColor: "#0070C0", shadeColor: "#FFFF00", subscript: true });
        expect(editor.typeText("가b")).toBe(true); await settle();
        const typed = properties(doc, 1, end);
        expect([typed.fontSize, typed.textColor, typed.shadeColor, typed.subscript]).toEqual([2000, "#0070c0", "#ffff00", true]);
        expect(properties(doc, 1, end + 1).fontSize).toBe(2000);
        expect(properties(doc, 1, end - 1).fontSize).toBe(1000); // existing text untouched
        // Korean IME composition and commit at the pending caret.
        editor.anchor = editor.caret = body(0, 1);
        expect(editor.execute("format.fontSize", { command: "format.fontSize", size: 14 }).accepted).toBe(true);
        editor.beginComposition(); editor.updateComposition("ㅎ"); editor.updateComposition("하"); editor.updateComposition("한");
        editor.endComposition("한"); await settle();
        expect(doc.getTextRange(0, 1, 0, 1)).toBe("한");
        expect(properties(doc, 1, 0).fontSize).toBe(1400);
        expect(properties(doc, 1, 1).fontSize).toBe(1000);
        // Moving the caret makes pending values inert.
        editor.anchor = editor.caret = body(3, 1);
        expect(editor.execute("format.fontSize", { command: "format.fontSize", size: 30 }).accepted).toBe(true);
        editor.anchor = editor.caret = body(5, 1);
        expect(editor.typeText("x")).toBe(true); await settle();
        expect(properties(doc, 1, 5).fontSize).toBe(1000);
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        expect(doc.getTextRange(0, 1, 5, 1)).not.toBe("x");
        record(`${format}-stage1-caret`, format, original, doc);
      } finally { editor.dispose(); }
    });
  }
});

describe.skipIf(phase !== "generate")("P1-A continuous next-input formatting beyond 64 insertions, actual Release WASM", () => {
  for (const format of ["hwpx", "hwp"] as const) {
    it(`${format}: >64 typed chars, paste with newline, IME update/cancel/commit, caret move, Undo/Redo, export`, async () => {
      const { editor, doc, original, settle } = await open(format);
      try {
        const end = doc.getParagraphLength(0, 1);
        editor.anchor = editor.caret = body(end, 1);
        expect(editor.execute("format.fontSize", { command: "format.fontSize", size: 22 }).accepted).toBe(true);
        expect(editor.execute("format.fontColor", { command: "format.fontColor", color: "C00000" }).accepted).toBe(true);
        // 80 single-character insertions: the old position Set stopped following after 64 entries.
        const typed = Array.from({ length: 80 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
        for (const ch of typed) expect(editor.typeText(ch)).toBe(true);
        await settle();
        expect(editor.pendingCharState?.props).toMatchObject({ fontSize: 2200, textColor: "#C00000" });
        const sizes = Array.from({ length: 80 }, (_, i) => properties(doc, 1, end + i));
        expect(sizes.every(p => p.fontSize === 2200 && p.textColor === "#c00000"), JSON.stringify(sizes.map(p => p.fontSize))).toBe(true);
        expect(properties(doc, 1, end - 1).fontSize).toBe(1000);
        // Paste (clipboard insert path = typeText) with a newline: both lines keep the values, across the split.
        expect(editor.typeText("PQ\nRS")).toBe(true); await settle();
        expect([properties(doc, 1, end + 80).fontSize, properties(doc, 1, end + 81).fontSize]).toEqual([2200, 2200]);
        expect([properties(doc, 2, 0).fontSize, properties(doc, 2, 1).fontSize]).toEqual([2200, 2200]);
        expect(editor.caret).toMatchObject({ paragraph: 2, offset: 2 });
        // IME: updates (delete + reinsert at the anchor), a cancellation, then a committed syllable.
        editor.beginComposition(); editor.updateComposition("ㄱ"); editor.updateComposition("");
        editor.endComposition(""); await settle();
        expect(editor.pendingCharState).not.toBeNull();
        editor.beginComposition(); editor.updateComposition("ㄱ"); editor.updateComposition("가"); editor.updateComposition("각");
        editor.endComposition("각"); await settle();
        expect(doc.getTextRange(0, 2, 2, 1)).toBe("각");
        expect(properties(doc, 2, 2).fontSize).toBe(2200);
        for (const ch of "다라") expect(editor.typeText(ch)).toBe(true);
        await settle();
        expect([properties(doc, 2, 3).fontSize, properties(doc, 2, 4).fontSize]).toEqual([2200, 2200]);
        // Caret movement makes the values inert: no stale formatting at an earlier point of the same run (the old
        // position Set kept the start key and re-applied the values there after moving back).
        expect(editor.moveHorizontal(-1, false)).toBe(true);
        expect(editor.pendingCharState).toBeNull();
        expect(editor.moveHorizontal(1, false)).toBe(true);
        expect(editor.pendingCharState).toBeNull();
        editor.anchor = editor.caret = body(3);
        const before3 = properties(doc, 0, 2).fontSize;
        expect(editor.execute("format.fontSize", { command: "format.fontSize", size: 30 }).accepted).toBe(true);
        expect(editor.typeText("x")).toBe(true); await settle();
        expect(properties(doc, 0, 3).fontSize).toBe(3000);
        expect(editor.moveHorizontal(-1, false)).toBe(true);
        expect(editor.pendingCharState).toBeNull();
        expect(editor.typeText("y")).toBe(true); await settle();
        expect(properties(doc, 0, 3).fontSize).toBe(before3); // inherits its neighbour, not the pending 30 pt
        // Undo/Redo restores the model; pending values never revive from history.
        expect(editor.execute("format.fontSize", { command: "format.fontSize", size: 9 }).accepted).toBe(true);
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        expect(editor.pendingCharState).toBeNull();
        expect(doc.getTextRange(0, 0, 3, 1)).toBe("x"); // the "y" typing step was undone
        expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
        expect(doc.getTextRange(0, 0, 3, 2)).toBe("yx");
        expect(editor.pendingCharState).toBeNull();
        record(`${format}-stage1-caret-long`, format, original, doc);
      } finally { editor.dispose(); }
    });
  }
});

type NumberingDef = { id: number; levelFormats: string[]; startNumber: number; numberFormats: number[] };
const numberingOf = (d: RhwpDocument, id: number) => (JSON.parse(d.getNumberingList!()) as NumberingDef[]).find(n => n.id === id);
const numberingStyle = (d: RhwpDocument, p: number) => {
  const para = JSON.parse(d.getParaPropertiesAt!(0, p));
  const def = para.headType === "Number" ? numberingOf(d, para.numberingId) : undefined;
  return { head: para.headType as string, id: para.numberingId as number, codes: def?.numberFormats.slice(0, 2), formats: def?.levelFormats.slice(0, 2) };
};

describe.skipIf(phase !== "generate")("P1-B numbering style compatibility and engine-authoritative definitions, actual Release WASM", () => {
  for (const format of ["hwpx", "hwp"] as const) {
    it(`${format}: decimal/letter/roman never share a definition; continuation; Undo/Redo and stale ids; reopen`, async () => {
      const { editor, doc, original, settle } = await open(format);
      try {
        expect(numberingOf(doc, 1) === undefined || Array.isArray(numberingOf(doc, 1)!.numberFormats)).toBe(true);
        // Paragraph 0 upper-letter; paragraph 1 "numbering" must not join it (both are non-multilevel).
        editor.anchor = editor.caret = body(0);
        expect(editor.execute("paragraph.listStyle", { command: "paragraph.listStyle", style: "upperLetter" }).accepted).toBe(true); await settle();
        const letter = numberingStyle(doc, 0);
        expect(letter.codes?.[0]).toBe(4);
        editor.anchor = editor.caret = body(0, 1);
        expect(editor.execute("paragraph.numbering").accepted).toBe(true); await settle();
        const decimal = numberingStyle(doc, 1);
        expect(decimal.head).toBe("Number");
        expect(decimal.id).not.toBe(letter.id);
        expect(decimal.codes?.[0]).toBe(0);
        expect(numberingStyle(doc, 0)).toEqual(letter); // the letter list is unchanged
        // Same-style continuation: a new paragraph after paragraph 1 joins the decimal definition.
        editor.anchor = editor.caret = body(doc.getParagraphLength(0, 1), 1);
        expect(editor.enter()).toBe(true); await settle();
        expect(editor.typeText("third")).toBe(true); await settle();
        expect(numberingStyle(doc, 2).id).toBe(decimal.id);
        // Roman on paragraph 2: its own definition (roman code 3), not the decimal one.
        expect(editor.execute("paragraph.listStyle", { command: "paragraph.listStyle", style: "lowerRoman" }).accepted).toBe(true); await settle();
        const roman = numberingStyle(doc, 2);
        expect(roman.codes?.[0]).toBe(3);
        expect(new Set([letter.id, decimal.id, roman.id]).size).toBe(3);
        // Continue numbering from a roman item never jumps to a list of another style.
        expect(editor.snapshot().actions?.["paragraph.continueNumbering"]).toEqual({});
        expect(editor.execute("paragraph.continueNumbering").accepted).toBe(false);
        expect(numberingStyle(doc, 2).id).toBe(roman.id);
        // Undo removes the roman definition from the model; applying roman again must not reuse a stale id.
        const defsBefore = (JSON.parse(doc.getNumberingList!()) as NumberingDef[]).length;
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        expect(numberingStyle(doc, 2).id).toBe(decimal.id);
        expect((JSON.parse(doc.getNumberingList!()) as NumberingDef[]).length).toBe(defsBefore - 1);
        expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
        expect(numberingStyle(doc, 2)).toEqual(roman);
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        // A definition matching a template is reused by style (no duplicate), its id is present in the current model.
        expect(editor.execute("paragraph.listStyle", { command: "paragraph.listStyle", style: "lowerRoman" }).accepted).toBe(true); await settle();
        const again = numberingStyle(doc, 2);
        expect(numberingOf(doc, again.id)).toBeDefined();
        expect(again.codes?.[0]).toBe(3);
        expect((JSON.parse(doc.getNumberingList!()) as NumberingDef[]).length).toBe(defsBefore);
        // Restart is offered for an engine-identified template definition and makes a new definition of that style.
        editor.anchor = editor.caret = body(0, 2);
        expect(editor.snapshot().actions?.["paragraph.restartNumbering"]).toEqual({});
        expect(editor.execute("paragraph.restartNumbering").accepted).toBe(true); await settle();
        const restarted = numberingStyle(doc, 2);
        expect(restarted.id).not.toBe(again.id);
        expect(restarted.codes).toEqual(again.codes);
        record(`${format}-stage1-numbering`, format, original, doc);
      } finally { editor.dispose(); }
    });
    it(`${format}: a reopened document's template definitions are identified from the model (no session cache)`, async () => {
      const first = await open(format);
      let bytes: Uint8Array;
      try {
        first.editor.anchor = first.editor.caret = body(0);
        expect(first.editor.execute("paragraph.listStyle", { command: "paragraph.listStyle", style: "upperLetter" }).accepted).toBe(true); await first.settle();
        if (format === "hwp") first.doc.rebuildLayout!();
        bytes = exported(first.doc, format).bytes;
      } finally { first.editor.dispose(); }
      const second = await open(format, bytes!, false);
      try {
        second.editor.anchor = second.editor.caret = body(0);
        if (format === "hwpx") {
          expect(second.editor.snapshot().actions?.["paragraph.restartNumbering"]).toEqual({});
          second.editor.anchor = second.editor.caret = body(0, 1);
          expect(second.editor.execute("paragraph.numbering").accepted).toBe(true); await second.settle();
          expect(numberingStyle(second.doc, 1).codes?.[0]).toBe(0); // decimal, not the reopened letter list
          expect(numberingStyle(second.doc, 1).id).not.toBe(numberingStyle(second.doc, 0).id);
        } else {
          // HWP structural editing needs the original-source proof (not answered here): the state is still read.
          expect(numberingStyle(second.doc, 0).codes?.[0]).toBe(4);
        }
      } finally { second.editor.dispose(); }
    });
  }
});

describe.skipIf(phase !== "generate")("P1-C combined character + paragraph/list changes in one save, actual Release WASM", () => {
  for (const format of ["hwpx", "hwp"] as const) {
    it(`${format}: numbered+size, multilevel+color, custom bullet+superscript, paragraph+char, cell formatting; one export`, async () => {
      const { editor, doc, original, settle, cell, cellProps } = await open(format);
      try {
        const para = (p: number) => JSON.parse(doc.getParaPropertiesAt!(0, p));
        // Table cell formatting first (the table's paragraph index is known now): list + size + alignment in a cell.
        editor.anchor = cell(0); editor.caret = cell(2);
        expect(editor.execute("format.fontSize", { command: "format.fontSize", size: 15 }).accepted).toBe(true); await settle();
        expect(editor.execute("paragraph.numbering").accepted).toBe(true); await settle();
        expect(cellProps(0).fontSize).toBe(1500);
        expect(cellProps(0, 1).fontSize).not.toBe(1500);
        // Body paragraph 0: custom bullet + superscript; paragraph 1: multilevel + color; + paragraph settings.
        editor.anchor = body(0); editor.caret = body(3);
        expect(editor.execute("paragraph.listStyle", { command: "paragraph.listStyle", style: "bulletSquare" }).accepted).toBe(true); await settle();
        expect(editor.execute("format.superscript").accepted).toBe(true); await settle();
        editor.anchor = body(0, 1); editor.caret = body(6, 1);
        expect(editor.execute("paragraph.multilevel").accepted).toBe(true); await settle();
        expect(editor.execute("format.fontColor", { command: "format.fontColor", color: "00B050" }).accepted).toBe(true); await settle();
        expect(editor.execute("paragraph.settings", { command: "paragraph.settings", format: { spaceAfter: 6, lineSpacing: { rule: "multiple", value: 1.5 } } }).accepted).toBe(true); await settle();
        // Numbered list + font size on a new third paragraph.
        editor.anchor = editor.caret = body(doc.getParagraphLength(0, 1), 1);
        expect(editor.enter()).toBe(true); await settle();
        expect(editor.typeText("combined")).toBe(true); await settle();
        editor.anchor = body(0, 2); editor.caret = body(8, 2);
        expect(editor.execute("paragraph.numbering").accepted).toBe(true); await settle();
        expect(editor.execute("format.fontSize", { command: "format.fontSize", size: 13 }).accepted).toBe(true); await settle();
        expect([para(0).headType, para(1).headType, para(2).headType]).toEqual(["Bullet", "Number", "Number"]);
        expect(properties(doc, 0, 1).superscript).toBe(true);
        expect(properties(doc, 1, 1).textColor).toBe("#00b050");
        expect(properties(doc, 2, 1).fontSize).toBe(1300);
        record(`${format}-stage1-combined`, format, original, doc);
      } finally { editor.dispose(); }
    });
  }
});

const fontAsset = (name: string) => new Uint8Array(readFileSync(join(root, "external/wordcraft/assets/fonts", name)));
/** The same font with another OS/2 fsType (in memory only; never written as a font file). */
function withFsType(bytes: Uint8Array, fsType: number) {
  const out = bytes.slice(), view = new DataView(out.buffer);
  for (let i = 0; i < view.getUint16(4); i++) {
    const rec = 12 + i * 16;
    if (String.fromCharCode(...out.subarray(rec, rec + 4)) === "OS/2") view.setUint16(view.getUint32(rec + 8) + 8, fsType);
  }
  return out;
}
const embedded = (d: RhwpDocument) => JSON.parse(d.getEmbeddedFonts!()) as { lang: number; face: string; binDataId: number; bytes: number }[];

describe.skipIf(phase !== "generate")("F HWPX font embedding through the RHWP session, actual Release WASM", () => {
  it("hwpx: embed an original face and a new face; char formatting, Undo/Redo, restricted refusal, export/reopen", async () => {
    const inter = fontAsset("Inter-Regular.ttf"), mono = fontAsset("JetBrainsMono-Regular.ttf");
    let served = inter;
    configureEmbedding({ embedData: async () => ({ ok: true, value: served }) } as unknown as FontBackend);
    // Source: a document that already uses Inter (an original face, inside the protected font prefix).
    const seed = engine.HwpDocument.createEmpty();
    let original: Uint8Array;
    try {
      seed.createBlankDocument(); seed.insertText(0, 0, 0, "Inter text and more"); seed.splitParagraph(0, 0, 19); seed.insertText(0, 1, 0, "Second line");
      const id = seed.findOrCreateFontId("Inter"); seed.applyCharFormat(0, 0, 0, 10, JSON.stringify({ fontId: id }));
      const monoId = seed.findOrCreateFontId("JetBrains Mono"); seed.applyCharFormat(0, 1, 7, 11, JSON.stringify({ fontId: monoId }));
      original = exported(seed, "hwpx").bytes;
    } finally { seed.free(); }
    const { editor, doc, settle } = await open("hwpx", original);
    try {
      expect(documentCommandState("format.embedFont", editor.snapshot())).toEqual({ available: true });
      expect(editor.snapshot().embeddedFonts).toEqual([]);
      // Defence in depth: restricted bytes are refused by the engine; nothing changes.
      served = withFsType(inter, 0x0002);
      const revision = editor.snapshot().revision;
      expect(await editor.executeEmbedFont("Inter", "Regular")).toBe("failed");
      expect(embedded(doc)).toEqual([]);
      expect(editor.snapshot().revision).toBe(revision);
      served = inter;
      expect(await editor.executeEmbedFont("Inter", "Regular")).toBe("embedded"); await settle();
      expect(embedded(doc).map(e => [e.face, e.bytes])).toEqual(Array(7).fill(["Inter", inter.length]));
      expect(editor.snapshot().embeddedFonts).toEqual([{ family: "Inter" }]);
      expect(await editor.executeEmbedFont("Inter", "Regular")).toBe("unchanged");
      // Character formatting afterwards (char-shape + font compaction against the protected prefix) still works.
      editor.anchor = body(0, 1); editor.caret = body(6, 1);
      expect(editor.execute("format.fontSize", { command: "format.fontSize", size: 14 }).accepted).toBe(true); await settle();
      expect(properties(doc, 1, 0).fontSize).toBe(1400);
      expect(embedded(doc).length).toBe(7);
      // Undo the size change and the embed; redo both (snapshot restores reconcile with the font prefix).
      expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
      expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
      expect(embedded(doc)).toEqual([]);
      expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
      expect(embedded(doc).length).toBe(7);
      expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
      expect(properties(doc, 1, 0).fontSize).toBe(1400);
      // A second document face: embedded as a second, distinct resource.
      served = mono;
      expect(await editor.executeEmbedFont("JetBrains Mono", "Regular")).toBe("embedded"); await settle();
      const faces = embedded(doc);
      expect(new Set(faces.map(e => e.face))).toEqual(new Set(["Inter", "JetBrains Mono"]));
      expect(new Set(faces.map(e => e.binDataId)).size).toBe(2);
      // A face the document does not use is refused.
      expect(await editor.executeEmbedFont("Source Serif 4", "Regular")).not.toBe("embedded");
      // The session's strict publication export (Save path) accepts the embedded fonts.
      const publish = (editor as unknown as { exportAndCompare(f: string, m: string): { bytes: Uint8Array | null; report: unknown; releaseShapes?: () => void } })
        .exportAndCompare("hwpx", "publish");
      publish.releaseShapes?.();
      expect(publish.bytes, JSON.stringify(publish.report)).not.toBeNull();
      record("hwpx-stage1-embed-font", "hwpx", original, doc);
      const e = exported(doc, "hwpx"), re = new engine.HwpDocument(e.bytes) as Doc;
      try {
        expect(new Set(embedded(re).map(x => `${x.face}:${x.bytes}`))).toEqual(new Set([`Inter:${inter.length}`, `JetBrains Mono:${mono.length}`]));
        // Rendering uses the embedded programs (@font-face from the document's own bytes).
        expect(re.renderPageSvgWithProfile(0, "screen").length).toBeGreaterThan(0);
      } finally { re.free(); }
    } finally { editor.dispose(); configureEmbedding(null); }
  });
  it("hwp: font embedding is unavailable (HWP 5.0 defines no font-embedding record)", async () => {
    const { editor, doc } = await open("hwp");
    try {
      expect(editor.snapshot().actionReasons?.["format.embedFont"]).toBe("engineUnsupported");
      expect(documentCommandState("format.embedFont", editor.snapshot()).available).toBe(false);
      expect(await editor.executeEmbedFont("Inter", "Regular")).toBe("stale");
      expect(() => doc.embedFont!("Inter", fontAsset("Inter-Regular.ttf"))).toThrow(/only HWPX/);
    } finally { editor.dispose(); }
  });
});

describe.skipIf(phase !== "generate")("Stage 1 lists and cell paragraph formatting, production session path, actual Release WASM", () => {
  for (const format of ["hwpx", "hwp"] as const) {
    it(`${format}: numbered/multilevel/custom lists, levels, restart/continue, Enter exit, cells; history; export`, async () => {
      const { editor, doc, original, settle, cell } = await open(format);
      try {
        const para = (p: number) => JSON.parse(doc.getParaPropertiesAt!(0, p));
        const cellPara = (index = 0) => JSON.parse((doc as unknown as { getCellParaPropertiesAt(...a: number[]): string })
          .getCellParaPropertiesAt(0, cell(0).cell.parentParagraph, cell(0).cell.control, index, 0));
        // First (while the table's paragraph index is known): a list in a table cell; the adjacent cell is untouched.
        editor.anchor = editor.caret = cell(0);
        expect(editor.execute("paragraph.numbering").accepted).toBe(true); await settle();
        expect(cellPara(0).headType).toBe("Number");
        expect(cellPara(1).headType).not.toBe("Number");
        // Cell paragraph formatting.
        expect(editor.execute("paragraph.alignCenter").accepted).toBe(true); await settle();
        expect(cellPara(0).alignment).toBe("center");
        expect(cellPara(1).alignment).not.toBe("center");
        expect(editor.execute("paragraph.settings", { command: "paragraph.settings", format: { spaceBefore: 4, indentLeft: 6 } }).accepted).toBe(true); await settle();
        expect(editor.snapshot().paragraph).toMatchObject({ spaceBefore: 4, indentLeft: 6, align: "center" });
        editor.anchor = body(0); editor.caret = body(3, 1);
        expect(editor.execute("paragraph.numbering").accepted).toBe(true); await settle();
        const [a, b] = [para(0), para(1)];
        expect([a.headType, b.headType]).toEqual(["Number", "Number"]);
        expect(a.numberingId).toBe(b.numberingId);
        expect(editor.snapshot().actions?.["paragraph.numbering"]).toEqual({ pressed: true });
        // Level demotion/promotion.
        editor.anchor = editor.caret = body(0, 1);
        expect(editor.execute("paragraph.increaseIndent").accepted).toBe(true); await settle();
        expect(para(1).paraLevel).toBe(1);
        expect(editor.execute("paragraph.decreaseIndent").accepted).toBe(true); await settle();
        expect(para(1).paraLevel).toBe(0);
        // Restart: a new definition for this item; continue: back to the previous list.
        expect(editor.execute("paragraph.restartNumbering").accepted).toBe(true); await settle();
        expect(para(1).numberingId).not.toBe(para(0).numberingId);
        expect(editor.execute("paragraph.continueNumbering").accepted).toBe(true); await settle();
        expect(para(1).numberingId).toBe(para(0).numberingId);
        // Enter at the end continues the list; Enter on the new empty item ends it.
        editor.anchor = editor.caret = body(doc.getParagraphLength(0, 1), 1);
        expect(editor.enter()).toBe(true); await settle();
        expect(para(2).headType).toBe("Number");
        expect(editor.enter()).toBe(true); await settle();
        expect(para(2).headType).toBe("None");
        // Custom styles: upper-letter numbering on paragraph 1, a custom bullet on paragraph 0.
        editor.anchor = editor.caret = body(0, 1);
        expect(editor.execute("paragraph.listStyle", { command: "paragraph.listStyle", style: "upperLetter" }).accepted).toBe(true); await settle();
        expect(para(1).headType).toBe("Number");
        expect(para(1).numberingId).not.toBe(para(0).numberingId);
        editor.anchor = editor.caret = body(0);
        expect(editor.execute("paragraph.listStyle", { command: "paragraph.listStyle", style: "bulletCircle" }).accepted).toBe(true); await settle();
        expect(para(0).headType).toBe("Bullet");
        // Multilevel on paragraph 1 (toggle on).
        editor.anchor = editor.caret = body(0, 1);
        expect(editor.execute("paragraph.multilevel").accepted).toBe(true); await settle();
        expect(editor.snapshot().paragraph?.list?.multilevel).toBe(true);
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        expect(editor.snapshot().paragraph?.spaceBefore).not.toBe(4);
        expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
        record(`${format}-stage1-lists`, format, original, doc);
      } finally { editor.dispose(); }
    });
    it(`${format}: nested cell paragraph formatting (explicit path), ownership, history, export`, async () => {
      const { editor, doc, original, settle, cell } = await open(format);
      try {
        const len0 = doc.getCellParagraphLength(0, cell(0).cell.parentParagraph, cell(0).cell.control, 0, 0);
        editor.anchor = editor.caret = cell(len0);
        expect(editor.execute("insert.table", { command: "insert.table", rows: 1, cols: 2 }).accepted).toBe(true); await settle();
        expect(editor.caret.cell?.nested?.length).toBe(1);
        const at = editor.caret;
        // State is read through the explicit-path engine API (getCellParaPropertiesAtByPath).
        const nestedAlign = () => { editor.anchor = editor.caret = at; return editor.snapshot().paragraph?.align; };
        const outerAlign = () => { editor.anchor = editor.caret = cell(0); return editor.snapshot().paragraph?.align; };
        const outer = outerAlign();
        editor.anchor = editor.caret = at;
        expect(editor.execute("paragraph.alignRight").accepted).toBe(true); await settle();
        expect(nestedAlign()).toBe("right");
        expect(outerAlign()).toBe(outer); // the containing cell keeps its alignment
        editor.anchor = editor.caret = at;
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        expect(nestedAlign()).not.toBe("right");
        expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
        expect(nestedAlign()).toBe("right");
        // P1-D: further nested paragraph values (indent, spacing, line spacing) through the same path.
        editor.anchor = editor.caret = at;
        const outerBefore = nestedModel(doc, { parent: at.cell!.parentParagraph, path: pathJson(at.cell!), outer: [at.cell!.control, at.cell!.cell, at.cell!.cellParagraph], neighbor: [at.cell!.control, 1, 0] });
        expect(editor.execute("paragraph.settings", { command: "paragraph.settings", format: { indentLeft: 8, indentFirst: 4, spaceBefore: 3, spaceAfter: 5, lineSpacing: { rule: "multiple", value: 1.5 } } }).accepted).toBe(true); await settle();
        const c = at.cell!;
        const spec: NestedSpec = { parent: c.parentParagraph, path: pathJson(c), outer: [c.control, c.cell, c.cellParagraph], neighbor: [c.control, 1, 0] };
        const exact = nestedModel(doc, spec);
        expect(exact.nested).toMatchObject({ alignment: "right", lineSpacingType: "Percent", lineSpacing: 150 });
        expect(exact.nested.marginLeft).not.toBe(outerBefore.nested.marginLeft);
        expect(exact.outer).toEqual(outerBefore.outer); // containing cell paragraph untouched
        expect(exact.neighbor).toEqual(outerBefore.neighbor); // neighbouring cell untouched
        record(`${format}-stage1-nested-cell`, format, original, doc, true, spec);
      } finally { editor.dispose(); }
    });
  }
});

describe.skipIf(phase !== "generate")("Stage 2 Phase 0 HWPX split-run formatting & save preservation, actual Release WASM", () => {
  it("hwpx: split-run paragraph (secPr handoff, cross-boundary, repeated, undo/redo, combined list, table cell); export & publish", async () => {
    const seed = engine.HwpDocument.createEmpty();
    let original: Uint8Array;
    try {
      seed.createBlankDocument();
      seed.insertText(0, 0, 0, "한글 Font editing ABC 0123");
      const fontId = seed.findOrCreateFontId("Inter");
      seed.applyCharFormat(0, 0, 0, 24, JSON.stringify({ fontId }));
      seed.splitParagraph(0, 0, 24);
      seed.insertText(0, 1, 0, "FirstRunSecondRun");
      seed.applyCharFormat(0, 1, 0, 8, JSON.stringify({ bold: true, fontSize: 1400 }));
      seed.applyCharFormat(0, 1, 8, 17, JSON.stringify({ italic: true, textColor: "#0000ff" }));
      seed.splitParagraph(0, 1, 17);
      const t = JSON.parse(seed.createTable(0, 2, 0, 1, 2));
      seed.insertTextInCell(0, t.paraIdx, t.controlIdx, 0, 0, 0, "CellFirstCellSecond");
      seed.applyCharFormatInCell(0, t.paraIdx, t.controlIdx, 0, 0, 0, 9, JSON.stringify({ bold: true }));
      seed.applyCharFormatInCell(0, t.paraIdx, t.controlIdx, 0, 0, 9, 19, JSON.stringify({ textColor: "#c00000" }));
      seed.insertTextInCell(0, t.paraIdx, t.controlIdx, 1, 0, 0, "Neighbor");
      original = exported(seed, "hwpx").bytes;
    } finally { seed.free(); }

    const { editor, doc, settle, cell, cellProps } = await open("hwpx", original);
    try {
      // R1 + original P1/F failure layout: partial selection inside secPr-handoff split paragraph + caret IME.
      editor.anchor = body(5, 0); editor.caret = body(10, 0);
      expect(editor.execute("format.superscript").accepted).toBe(true); await settle();
      expect([4, 5, 9, 10].map(i => properties(doc, 0, i).superscript)).toEqual([false, true, true, false]);
      editor.anchor = editor.caret = body(24, 0);
      expect(editor.execute("format.superscript").accepted).toBe(true);
      expect(editor.typeText("xy")).toBe(true); await settle();
      editor.beginComposition(); editor.updateComposition("ㅎ"); editor.updateComposition("하"); editor.updateComposition("한");
      editor.endComposition("한"); await settle();
      expect(properties(doc, 0, 24).superscript).toBe(true);
      expect(properties(doc, 0, 26).superscript).toBe(true);

      // R2 + R3 + R7: selection crossing existing run boundary, repeated formatting, Undo/Redo, combined numbering.
      editor.anchor = body(4, 1); editor.caret = body(12, 1);
      expect(editor.execute("format.fontSize", { command: "format.fontSize", size: 18 }).accepted).toBe(true); await settle();
      expect(editor.execute("format.fontColor", { command: "format.fontColor", color: "C00000" }).accepted).toBe(true); await settle();
      expect(editor.execute("format.superscript").accepted).toBe(true); await settle();
      expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
      expect(properties(doc, 1, 5).superscript).toBe(false);
      expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
      expect(properties(doc, 1, 5).superscript).toBe(true);
      expect(properties(doc, 1, 3).fontSize).toBe(1400);
      expect(properties(doc, 1, 5).fontSize).toBe(1800);
      expect(properties(doc, 1, 11).fontSize).toBe(1800);
      expect(properties(doc, 1, 13).textColor).toBe("#0000ff");
      expect(editor.execute("paragraph.numbering").accepted).toBe(true); await settle();

      // R6: table cell split-run cross-boundary formatting; neighbor cell untouched.
      editor.anchor = cell(5, 0); editor.caret = cell(14, 0);
      expect(editor.execute("format.highlight", { command: "format.highlight", color: "yellow" }).accepted).toBe(true); await settle();
      expect(editor.execute("format.fontSize", { command: "format.fontSize", size: 16 }).accepted).toBe(true); await settle();
      expect(cellProps(3, 0).shadeColor).not.toBe("#ffff00");
      expect(cellProps(5, 0)).toMatchObject({ shadeColor: "#ffff00", fontSize: 1600, bold: true });
      expect(cellProps(12, 0)).toMatchObject({ shadeColor: "#ffff00", fontSize: 1600, textColor: "#c00000" });
      expect(cellProps(0, 1).fontSize).toBe(1000);

      record("hwpx-stage2p0-split-runs", "hwpx", original, doc);
    } finally { editor.dispose(); }
  });
});

it.skipIf(phase !== "verify")("fresh engine reopens actual service-published Stage 1 bytes with all character properties intact", () => {
  const all = JSON.parse(readFileSync(join(out, "cases.json"), "utf8")) as typeof cases;
  expect(all).toHaveLength(Number(process.env.GEUL_FORMAT_EXPECTED_CASES ?? 20));
  for (const { id, format, nested } of all) {
    const dir = join(out, id), doc = new engine.HwpDocument(readFileSync(join(dir, `published.${format}`))) as Doc;
    try {
      const proof = JSON.parse(readFileSync(join(dir, "proof.json"), "utf8"));
      expect(proof.generation).toBe(build.generation);
      expect(model(doc)).toEqual(proof.model);
      // P1-D: the service-published bytes reopen with the exact nested-cell paragraph properties of the edit model.
      if (nested) expect(nestedModel(doc, nested)).toEqual(proof.nested);
      if (id === "hwpx-stage2p0-split-runs") {
        expect([4, 5, 9, 10, 24, 26].map(i => properties(doc, 0, i).superscript)).toEqual([false, true, true, false, true, true]);
        expect(doc.getTextRange(0, 0, 24, 3)).toBe("xy한");
        expect([properties(doc, 1, 3).fontSize, properties(doc, 1, 5).fontSize, properties(doc, 1, 11).fontSize, properties(doc, 1, 13).textColor]).toEqual([1400, 1800, 1800, "#0000ff"]);
        expect(JSON.parse(doc.getParaPropertiesAt!(0, 1)).headType).toBe("Number");
      } else if (id.includes("nested")) expect(proof.nested?.nested?.alignment).toBe("right");
      if (id.includes("chars") || id.includes("highlight")) expect(properties(doc, 0, 0).fontSize).toBe(1800);
      else if (id.includes("embed-font")) expect(new Set(embedded(doc).map(x => x.face))).toEqual(new Set(["Inter", "JetBrains Mono"]));
      else if (id.includes("combined")) expect([properties(doc, 0, 1).superscript, properties(doc, 1, 1).textColor, properties(doc, 2, 1).fontSize]).toEqual([true, "#00b050", 1300]);
      else if (id.includes("numbering")) expect([0, 1, 2].map(p => numberingStyle(doc, p).codes?.[0])).toEqual([4, 0, 3]);
      else if (id.includes("lists")) expect(JSON.parse(doc.getParaPropertiesAt!(0, 0)).headType).toBe("Bullet");
      else if (id.includes("nested")) expect(doc.pageCount()).toBeGreaterThan(0);
      else if (id.includes("caret-long")) expect([79, 80].map(i => properties(doc, 1, doc.getParagraphLength(0, 1) - 82 + i).fontSize)).toEqual([2200, 2200]);
      else if (id.includes("caret")) expect(properties(doc, 1, 0).fontSize).toBe(1400);
      else if (id.includes("columns")) expect(JSON.parse(doc.getColumnDef!(0)).columnCount).toBe(2);
      else if (id.includes("many")) expect(doc.getTextRange(0, 0, 0, 4)).toBe("나b나b");
      else if (id.includes("page")) expect(JSON.parse(doc.getPageDef!(0)).landscape).toBe(true);
      else if (id.includes("paragraph")) expect(JSON.parse(doc.getParaPropertiesAt!(0, 1)).alignment).toBe("right");
      else if (id !== "hwpx-stage2p0-split-runs") expect(doc.getTextRange(0, 1, 0, 16)).toBe("SEcond paragraph");
    } finally { doc.free(); }
  }
});
