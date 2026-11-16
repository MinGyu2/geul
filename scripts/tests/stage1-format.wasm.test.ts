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
  const controls = JSON.parse(d.getControls!());
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
const cases: { id: string; format: Format; previewRequired: boolean }[] = [];
function record(id: string, format: Format, original: Uint8Array, doc: Doc, previewRequired = true) {
  if (format === "hwp") doc.rebuildLayout!();
  const e = exported(doc, format), re = new engine.HwpDocument(e.bytes) as Doc;
  try {
    expect(model(re)).toEqual(model(doc));
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
    json(join(dir, "proof.json"), { generation: build.generation, originalSha256: sha(original), editedSha256: sha(e.bytes), model: model(re) });
    cases.push({ id, format, previewRequired }); json(join(out, "cases.json"), cases);
  } finally { re.free(); }
}


describe.skipIf(phase !== "generate")("Stage 1 character values, production session path, actual Release WASM", () => {
  for (const format of ["hwpx", "hwp"] as const) {
    it(`${format}: size, color, highlight, scripts; mixed state, cells, history, export`, async () => {
      const { editor, doc, original, settle, cell, cellProps } = await open(format);
      try {
        // Caret-only formatting is not offered (selection required), and nothing changes.
        editor.anchor = body(0); editor.caret = body(0);
        expect(documentCommandState("format.fontSize", editor.snapshot())).toEqual({ available: false, reason: "selectionRequired" });
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
        // Removing the highlight stores white shading and reports no highlight.
        editor.anchor = body(0); editor.caret = body(4);
        expect(editor.execute("format.highlight", { command: "format.highlight", color: "none" }).accepted).toBe(true); await settle();
        expect(properties(doc, 0, 0).shadeColor).toBe("#ffffff");
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

it.skipIf(phase !== "verify")("fresh engine reopens actual service-published Stage 1 bytes with all character properties intact", () => {
  const all = JSON.parse(readFileSync(join(out, "cases.json"), "utf8")) as typeof cases;
  expect(all).toHaveLength(Number(process.env.GEUL_FORMAT_EXPECTED_CASES ?? 10));
  for (const { id, format } of all) {
    const dir = join(out, id), doc = new engine.HwpDocument(readFileSync(join(dir, `published.${format}`))) as Doc;
    try {
      const proof = JSON.parse(readFileSync(join(dir, "proof.json"), "utf8"));
      expect(proof.generation).toBe(build.generation);
      expect(model(doc)).toEqual(proof.model);
      if (id.includes("chars") || id.includes("highlight")) expect(properties(doc, 0, 0).fontSize).toBe(1800);
      else if (id.includes("page")) expect(JSON.parse(doc.getPageDef!(0)).landscape).toBe(true);
      else if (id.includes("paragraph")) expect(JSON.parse(doc.getParaPropertiesAt!(0, 1)).alignment).toBe("right");
      else expect(doc.getTextRange(0, 1, 0, 16)).toBe("SEcond paragraph");
    } finally { doc.free(); }
  }
});
