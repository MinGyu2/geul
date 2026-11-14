// @vitest-environment jsdom
// Focused Stage 2 implementation regression; product defaults, actual Release WASM.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { documentCommandState } from "../../src/commands/capability";
import type { DocumentCommandArgs } from "../../src/commands/target";
import type { DocumentCommandId } from "../../src/commands/registry";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import { HWP_TABLE_NORMALIZATION } from "../../src/components/Editor/rhwp/hwpReopenModel";
import { RhwpText, pathJson, withCell, type DocPosition } from "../../src/components/Editor/rhwp/rhwpText";
import { preserveSourceCaret, type RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import { planTableOp, rectangularRange } from "../../src/components/Editor/rhwp/tableStructure";
import { base, controlledBackend, fail, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";

vi.mock("../../src/components/Editor/rhwp/previewRaster", async actual => {
  const real = await actual<typeof import("../../src/components/Editor/rhwp/previewRaster")>();
  // jsdom has no 2D canvas; the Rust service regenerates/validates HWP previews (only previewStale is tolerated below).
  return { ...real, capturePreviewRaster: () => ({ width: 1, height: 1, rgb: new Uint8Array([1, 2, 3]) }) };
});

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
const wasm = engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const out = join(root, "target/stage2-focused"); mkdirSync(out, { recursive: true });
type Doc = RhwpDocument & { createBlankDocument(): void; getTextFileText(): string };
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
function exported(d: RhwpDocument, format: "hwp" | "hwpx") {
  const e = format === "hwp" ? d.exportHwpWithReport() : d.exportHwpxWithReport();
  try { return { loss: e.contentLoss(), bytes: e.takeBytes() }; } finally { e.free(); }
}
/** Text of a deep fixture's innermost cell: numbered words, so dropped or duplicated page fragments are detectable. */
const DEEP_WORDS = Array.from({ length: 1000 }, (_, i) => `w${i}`).join(" ");
function fixture(format: "hwp" | "hwpx", emptyWrapper = false, nestedGuard = false, rich = false, multiFields = false, deep = 0, rowWords = DEEP_WORDS) {
  const d = engine.HwpDocument.createEmpty() as Doc;
  try {
    d.createBlankDocument();
    const t = JSON.parse(d.createTable!(0, 0, 0, emptyWrapper ? 1 : rich ? 3 : 2, emptyWrapper ? 1 : 2));
    d.setTableProperties!(0, t.paraIdx, t.controlIdx, JSON.stringify(format === "hwp" ? HWP_TABLE_NORMALIZATION : { textWrap: "TopAndBottom" }));
    // Rich: column A holds 1, 2 and an empty formula target; B1 holds a picture.
    const texts = rich ? ["1", "", "2", "", "", ""] : emptyWrapper ? [] : ["outer0", "outer1", "outer2", "outer3"];
    texts.forEach((value, i) => value && d.insertTextInCell(0, t.paraIdx, t.controlIdx, i, 0, 0, value));
    if (rich && format === "hwp") {
      // HWP field-rich original: a formula (B3 = A1+A2) and a ClickHere field (B1).
      expect(JSON.parse(d.insertTableFormulaField!(0, t.paraIdx, t.controlIdx, 2, 1, "=SUM(A1:A2)")).ok).toBe(true);
      expect(JSON.parse((d as unknown as Record<string, (...a: unknown[]) => string>).insertClickHereFieldInCell!(0, t.paraIdx, t.controlIdx, 1, 0, 0, false, "guide", "memo", "nm", true)).ok).toBe(true);
    }
    if (multiFields) {
      // Two disjoint recognized fields in the same paragraph, on either side of a space.
      const api = d as unknown as Record<string, (...a: unknown[]) => string>;
      const first = (JSON.parse(d.getFieldList!()) as { fieldId: number; fieldType: string }[]).find(f => f.fieldType === "clickhere")!;
      api.setFieldValue!(first.fieldId, "first");
      d.insertTextInCell(0, t.paraIdx, t.controlIdx, 1, 0, 5, " ");
      const second = JSON.parse(api.insertClickHereFieldInCell!(0, t.paraIdx, t.controlIdx, 1, 0, 6, false, "second", "note", "nm2", true));
      expect(second.ok).toBe(true); api.setFieldValue!(second.fieldId, "second");
    }
    if (rich && format === "hwpx") {
      // The engine's cell picture is Hancom's floating sibling of the table paragraph (not a cell control).
      expect(JSON.parse(d.insertPicture!(0, t.paraIdx, 0, JSON.stringify([{ controlIndex: t.controlIdx, cellIndex: 1, cellParaIndex: 0 }]),
        PNG, 600, 600, 1, 1, "png", "")).ok).toBe(true);
    }
    if (rich) {
      d.setTableProperties!(0, t.paraIdx, t.controlIdx, JSON.stringify({ hasCaption: true }));
      d.insertTextInCellByPath!(0, t.paraIdx, JSON.stringify([{ controlIndex: t.controlIdx, cellIndex: 65534, cellParaIndex: 0 }]), 0, "Cap");
    }
    if (deep) {
      // An existing document with `deep` table levels: every level is labelled, the innermost holds DEEP_WORDS.
      let path = [{ controlIndex: t.controlIdx, cellIndex: 0, cellParaIndex: 0 }];
      for (let level = 2; level <= deep; level++) {
        const child = JSON.parse(d.createTableInCellByPath!(0, t.paraIdx, JSON.stringify(path), 0, 1, 1));
        path = [...path, { controlIndex: child.controlIdx, cellIndex: 0, cellParaIndex: 0 }];
      }
      for (let level = 1; level < deep; level++) d.insertTextInCellByPath!(0, t.paraIdx, JSON.stringify(path.slice(0, level)), 0, `L${level}`);
      d.insertTextInCellByPath!(0, t.paraIdx, JSON.stringify(path), 0, rowWords);
    }
    if (nestedGuard) {
      const host = [{ controlIndex: t.controlIdx, cellIndex: 0, cellParaIndex: 0 }];
      const child = JSON.parse(d.createTableInCellByPath!(0, t.paraIdx, JSON.stringify(host), 3, 2, 2));
      d.insertTextInCellByPath!(0, t.paraIdx, JSON.stringify([...host,
        { controlIndex: child.controlIdx, cellIndex: 0, cellParaIndex: 0 }]), 0, "guard");
    }
    return exported(d, format).bytes;
  } finally { d.free(); }
}
async function open(format: "hwp" | "hwpx" = "hwpx", emptyWrapper = false, nestedGuard = false, rich = false, multiFields = false, deep = 0, rowWords = DEEP_WORDS) {
  const original = fixture(format, emptyWrapper, nestedGuard, rich, multiFields, deep, rowWords), { backend, take, calls } = controlledBackend();
  const sessions = new DocumentSessions(backend), opening = sessions.open(`/stage2.${format}`);
  take("open").reply(ok({ ...base, format })); await opening;
  let doc!: Doc;
  const editor = new RhwpEditorSession(1, backend, sessions, async () => ({
    openDocument: bytes => { const d = preserveSourceCaret(new engine.HwpDocument(bytes)) as Doc; doc ??= d; return d; },
    memoryBytes: () => wasm.memory.buffer.byteLength,
  }));
  const loading = editor.load(); take("load").reply(loaded(original)); await flush();
  take("session").reply(ok(info({ format, state: "loading", sequence: 1 })));
  take("setState").reply(ok(info({ format, state: "ready", sequence: 2 }))); await loading;
  if (format === "hwp" && calls.some(c => c.method === "original")) {
    take("original").reply(ok(original)); await flush();
    const call = take("preflight");
    writeFileSync(join(out, "original.hwp"), original);
    writeFileSync(join(out, "noop.hwp"), call.args[2] as Uint8Array);
    writeFileSync(join(out, "noop-loss.json"), JSON.stringify(call.args[3]));
    const proof = JSON.parse(execFileSync(join(root, "src-tauri/target/debug/examples/save_check"),
      ["preflight", "hwp", join(out, "original.hwp"), join(out, "noop.hwp"), join(out, "noop-loss.json")], { encoding: "utf8" }));
    expect(proof.outcome, JSON.stringify(proof)).toBe("safe");
    call.reply(ok({ preservation: proof, platformSupported: true })); await flush();
  }
  const t = JSON.parse(doc.getControls!()).find((c: { ctrlId: string; list: number }) => c.ctrlId === "tbl" && c.list === 0);
  const at: DocPosition = { section: 0, paragraph: t.para, offset: 0,
    cell: { parentParagraph: t.para, control: t.controlIndex, cell: 0, cellParagraph: 0 } };
  const place = (p: DocPosition) => { editor.anchor = editor.caret = p; };
  let sequence = 2;
  const settle = async () => { await flush(); while (calls.some(c => c.method === "commit")) {
    const c = take("commit"); c.reply(ok(info({ format, state: "ready", dirty: true,
      revision: Number(c.args[2]) + Number(c.args[3]), sequence: ++sequence }))); await flush();
  } };
  const run = async (command: DocumentCommandId, args?: DocumentCommandArgs) => {
    expect(documentCommandState(command, editor.snapshot()).available, command).toBe(true);
    expect(editor.execute(command, args).accepted, command).toBe(true); await settle();
    expect(editor.snapshot().editable).toBe(true);
  };
  /** Product Save: the session's own export, loss report and live/reopen comparison, judged by the real T009 checker. */
  const save = async () => {
    const saving = editor.save(); await flush();
    if (calls.some(c => c.method === "original")) {
      take("original").reply(ok(original)); await flush();
      const pf = take("preflight");
      pf.reply(ok({ preservation: check(format, "preflight", original, pf.args[2] as Uint8Array, JSON.stringify(pf.args[3])), platformSupported: true }));
      await flush();
    }
    const call = take("save");
    const [, , revision, output, contentLoss, reopen] = call.args as [number, number, number, Uint8Array, unknown, Record<string, boolean>];
    const reopenEqual = Object.values(reopen).every(Boolean);
    const raw = check(format, "saved", original, output, JSON.stringify(contentLoss), reopenEqual);
    // The service regenerates stale HWP previews; anything else is a real refusal.
    const publishable = reopenEqual && raw.findings.every(f => f.code === "previewStale") && (format === "hwp" || raw.outcome === "safe");
    if (publishable) call.reply(ok({ session: info({ format, state: "ready", revision, dirty: false, sequence: ++sequence }), durable: true }));
    else call.reply(fail({ code: "UnsafeSave", preservation: raw as never }));
    await saving;
    return { output, reopen, raw, publishable };
  };
  return { original, editor, doc, at, place, settle, run, save };
}
function check(format: "hwp" | "hwpx", mode: "preflight" | "saved", original: Uint8Array, output: Uint8Array, loss: string, reopen = true) {
  writeFileSync(join(out, `a.${format}`), original); writeFileSync(join(out, `b.${format}`), output); writeFileSync(join(out, "check-loss.json"), loss);
  return JSON.parse(execFileSync(join(root, "src-tauri/target/debug/examples/save_check"), [mode, format, join(out, `a.${format}`),
    join(out, `b.${format}`), join(out, "check-loss.json"), ...(mode === "saved" ? [String(reopen)] : [])], { encoding: "utf8" })) as
    { outcome: string; findings: { code: string; part?: string }[] };
}

function checkHwpx(original: Uint8Array, doc: Doc) {
  const e = exported(doc, "hwpx");
  writeFileSync(join(out, "original.hwpx"), original); writeFileSync(join(out, "edited.hwpx"), e.bytes);
  writeFileSync(join(out, "loss.json"), e.loss);
  const result = JSON.parse(execFileSync(join(root, "src-tauri/target/debug/examples/save_check"),
    ["saved", "hwpx", join(out, "original.hwpx"), join(out, "edited.hwpx"), join(out, "loss.json"), "true"], { encoding: "utf8" }));
  expect(result.outcome, JSON.stringify(result)).toBe("safe");
  const reopened = new engine.HwpDocument(new Uint8Array(readFileSync(join(out, "edited.hwpx")))) as Doc;
  expect(reopened.getTextFileText()).toBe(doc.getTextFileText());
  return reopened;
}

describe("Stage 2 table paths", () => {
  it("product nested creation/structure/range merge/formatting/history and HWPX preservation", async () => {
    const c = await open(), { editor, doc, at, place, run, settle } = c;
    try {
      place({ ...at, offset: 4 }); editor.caret = { ...at, offset: 6 };
      await run("format.bold");
      place({ ...at, offset: 3 });
      await run("insert.table", { command: "insert.table", rows: 2, cols: 2 });
      const nested = editor.caret;
      expect(nested.cell!.nested).toHaveLength(1);
      expect(doc.getTextInCell(0, at.paragraph, at.cell!.control, 0, 0, 0, 6)).toBe("outer0");
      for (let i = 0; i < 6; i++) expect(JSON.parse(doc.getCellCharPropertiesAt!(0, at.paragraph,
        at.cell!.control, 0, 0, i)).bold).toBe(i >= 4);
      const text = new RhwpText(doc);
      expect(text.ownsNestedCell(nested)).toBe(true);
      for (let i = 0; i < 4; i++) {
        place(withCell(nested, i)); expect(editor.typeText(`n${i}`)).toBe(true); await settle();
      }
      place(nested);
      for (const op of ["insertRowAbove", "insertRowBelow", "insertColumnLeft", "insertColumnRight", "deleteRow", "deleteColumn"] as const) {
        await run(`table.${op}`); await run("edit.undo");
      }
      for (const op of ["mergeRight", "mergeBelow"] as const) {
        place(nested); await run(`table.${op}`); await run("edit.undo");
      }
      // Real Shift+pointAt routes the selection through ownership checks, without
      // substituting geometry for the target of the subsequent engine mutation.
      place(nested);
      const rect = text.caret(withCell(nested, 3))!;
      expect(editor.pointAt(rect.page, rect.x + 1, rect.y + rect.height / 2, true)).toBe(true);
      expect(editor.selectionRects().length).toBeGreaterThan(0);
      const beforeMerge = doc.getTextFileText();
      expect(editor.typeText("must not replace a cell range")).toBe(false);
      editor.beginComposition(); expect(editor.composing).toBe(false);
      await run("table.mergeCells");
      expect(JSON.parse(doc.getTableDimensionsByPath!(0, at.paragraph, pathJson(editor.caret.cell!))).cellCount).toBe(1);
      expect(Array.from({ length: text.paragraphCount(editor.caret) }, (_, p) => text.text({ ...editor.caret,
        cell: { ...editor.caret.cell!, nested: [{ ...editor.caret.cell!.nested![0]!, cellParagraph: p }] } }, 2))).toEqual(["n0", "n1", "n2", "n3"]);
      await run("edit.undo"); expect(doc.getTextFileText()).toBe(beforeMerge);
      await run("edit.redo");
      for (const op of ["deleteRow", "deleteColumn"] as const) {
        await run(`table.${op}`); await run("edit.undo");
      }
      await run("table.splitCell");
      place(nested); editor.caret = { ...nested, offset: 2 };
      for (const flag of ["bold", "italic", "underline", "strikethrough"] as const) await run(`format.${flag}`);
      await run("hangul.charWidth", { command: "hangul.charWidth", percent: 120 });
      await run("hangul.charSpacing", { command: "hangul.charSpacing", percent: 5 });
      expect(JSON.parse(doc.getCellCharPropertiesAtByPath!(0, at.paragraph, pathJson(nested.cell!), 0))).toMatchObject({
        bold: true, italic: true, underline: true, strikethrough: true, ratios: [120,120,120,120,120,120,120] });
      for (let cell = 0; cell < 4; cell++) expect(doc.getTextInCell(0, at.paragraph,
        at.cell!.control, cell, 0, 0, 6)).toBe(`outer${cell}`);
      const reopened = checkHwpx(c.original, doc);
      try {
        expect(new RhwpText(reopened).ownsNestedCell(nested)).toBe(true);
        expect(JSON.parse(reopened.getCellCharPropertiesAtByPath!(0, at.paragraph, pathJson(nested.cell!), 0)).bold).toBe(true);
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  it("depth fifteen, line-aware Home/End, strict path budget and HWP/HWPX engine roundtrip", async () => {
    const c = await open("hwpx", true), { editor, doc, at, place, run, settle } = c;
    try {
      place(at);
      for (let depth = 1; depth < 15; depth++) await run("insert.table", { command: "insert.table", rows: 1, cols: 1 });
      const deep = editor.caret;
      expect(deep.cell!.nested).toHaveLength(14);
      // Creation stops at the HWPX reader envelope (15 table levels) so the result reopens in both formats.
      expect(documentCommandState("insert.table", editor.snapshot()).available).toBe(false);
      expect(editor.typeText("long paragraph repeated words ".repeat(20))).toBe(true); await settle();
      const text = new RhwpText(doc), line = text.line({ ...deep, offset: 10 })!;
      expect(line.end).toBeLessThan(text.paragraphLength(deep));
      place({ ...deep, offset: 10 }); expect(editor.moveLineEdge("end", false)).toBe(true);
      expect(editor.caret.offset).toBe(line.end);
      expect(editor.moveLineEdge("start", false)).toBe(true); expect(editor.caret.offset).toBe(line.start);
      const rect = text.caret(editor.caret)!;
      expect(rect).not.toBeNull();
      expect(editor.pointAt(rect.page, rect.x + 1, rect.y + rect.height / 2, false)).toBe(true);
      expect(editor.caret.cell!.nested).toHaveLength(14);
      const content = doc.getTextFileText();
      for (const path of ['[{"controlIndex":0}]', 'garbage', JSON.stringify(Array.from({ length: 65 }, () => ({ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 })))]) {
        expect(() => doc.insertTextInCellByPath!(0, at.paragraph, path, 0, "bad")).toThrow();
        expect(doc.getTextFileText()).toBe(content);
      }
      for (const format of ["hwp", "hwpx"] as const) {
        const e = exported(doc, format); writeFileSync(join(out, `deep.${format}`), e.bytes);
        const re = new engine.HwpDocument(new Uint8Array(readFileSync(join(out, `deep.${format}`)))) as Doc;
        try {
          expect(re.getTextFileText()).toBe(content);
          expect(new RhwpText(re).ownsNestedCell(deep)).toBe(true);
          expect(new RhwpText(re).paragraphLength(deep)).toBe(text.paragraphLength(deep));
        } finally { re.free(); }
      }
    } finally { editor.dispose(); }
  });

  type RowDoc = Doc & {
    getPageRenderTree(page: number): string;
    getPageDef(section: number): string;
    getPageLayerTree(page: number): string;
    insertParagraph(section: number, paragraph: number): string;
    setPageDef(section: number, json: string): string;
  };
  type Box = { x: number; y: number; w: number; h: number };
  type RenderNode = { type: string; text?: string; bbox: Box; children?: RenderNode[] };
  const numbered = (count: number) => Array.from({ length: count }, (_, i) => `w${i}`).join(" ");
  /** Check the visible body and every owning cell/table, not merely raw JSON text. */
  function visibleRow(d: RowDoc, expected: string) {
    const pages: { words: string[]; tables: Box[]; body: Box; hasText: boolean; labels: string[] }[] = [];
    for (let page = 0; page < d.pageCount(); page++) {
      const tree = JSON.parse(d.getPageRenderTree(page)) as RenderNode;
      const body = tree.children!.find(n => n.type === "Body")!;
      let text = "", hasText = false; const tables: Box[] = [];
      const inside = (b: Box, owner: Box) => {
        expect(b.y).toBeGreaterThanOrEqual(owner.y - 0.5);
        expect(b.y + b.h).toBeLessThanOrEqual(owner.y + owner.h + 0.5);
        expect(b.x).toBeGreaterThanOrEqual(owner.x - 0.5);
        expect(b.x + b.w).toBeLessThanOrEqual(owner.x + owner.w + 0.5);
      };
      const walk = (n: RenderNode, owners: Box[]) => {
        if (n.type === "Table") {
          tables.push(n.bbox); inside(n.bbox, body.bbox);
          for (const owner of owners) inside(n.bbox, owner);
        }
        if (n.type === "Table" || n.type === "Cell") owners = [...owners, n.bbox];
        if (n.type === "TextRun" && n.text?.trim()) {
          // Partial nested paint retains translated lines outside the cell clip.
          // They are not visible content; require every visible line to fit fully.
          if (owners.some(owner => n.bbox.y + n.bbox.h <= owner.y || n.bbox.y >= owner.y + owner.h)) return;
          hasText = true; text += n.text; inside(n.bbox, body.bbox);
          for (const owner of owners) inside(n.bbox, owner);
        }
        for (const child of n.children ?? []) walk(child, owners);
      };
      walk(body, []);
      pages.push({ words: text.match(/w\d+/g) ?? [], tables, body: body.bbox, hasText, labels: text.match(/L\d+/g) ?? [] });
    }
    expect(pages.flatMap(p => p.words)).toEqual(expected.split(" "));
    expect(d.getTextFileText().match(/w\d+/g)).toEqual(expected.split(" "));
    expect(pages.flatMap(p => p.labels)).toEqual(d.getTextFileText().match(/L\d+/g) ?? []);
    expect(pages.every(p => p.hasText)).toBe(true);
    expect(pages.length).toBeLessThan(6);
    return pages;
  }

  it.each([[1, 600], [4, 500], [4, 1000]])("row pagination boundary depth %i words %i: visible fragments and continuation ownership", (depth, count) => {
    const words = numbered(count), d = new engine.HwpDocument(fixture("hwpx", true, false, false, false, depth, words)) as RowDoc;
    try {
      const pages = visibleRow(d, words);
      expect(pages.length).toBeGreaterThan(1);
      const control = JSON.parse(d.getControls!()).find((c: { ctrlId: string; list: number }) => c.ctrlId === "tbl" && c.list === 0);
      const at: DocPosition = { section: 0, paragraph: control.para, offset: words.length,
        cell: { parentParagraph: control.para, control: control.controlIndex, cell: 0, cellParagraph: 0,
          ...(depth > 1 ? { nested: Array.from({ length: depth - 1 }, () => ({ control: 0, cell: 0, cellParagraph: 0 })) } : {}) } };
      const text = new RhwpText(d), caret = text.caret(at)!;
      expect(text.ownsNestedCell(at)).toBe(true);
      expect(caret.page).toBe(pages.length - 1);
      expect(caret.y + caret.height).toBeLessThanOrEqual(pages[caret.page]!.body.y + pages[caret.page]!.body.h + 0.5);
      if (depth === 1) for (const pageBreak of [1, 2]) {
        d.setTableProperties!(0, control.para, control.controlIndex, JSON.stringify({ pageBreak }));
        expect(visibleRow(d, words).length).toBe(2);
      }
    } finally { d.free(); }
  });

  it("row pagination boundary sweep uses measured physical height, including midpage insertion", () => {
    const words = numbered(600), d = new engine.HwpDocument(fixture("hwpx", true, false, false, false, 1, words)) as RowDoc;
    try {
      const pageDef = JSON.parse(d.getPageDef(0)) as { height: number };
      d.setPageDef(0, JSON.stringify({ height: pageDef.height + 75000 }));
      visibleRow(d, words);
      // The render-tree summary rounds to 0.1px, which can put the nominal
      // equality case below the true boundary. Use the product paint layer's
      // 0.001px boxes and round the page size upward to a real HWPUNIT (1/75px).
      type Layer = { bounds: { y: number; height: number }; groupKind?: { kind: string }; child?: Layer; children?: Layer[] };
      const layer = JSON.parse(d.getPageLayerTree(0)) as { root: Layer };
      const find = (n: Layer, kind: string): Layer | undefined => n.groupKind?.kind === kind ? n
        : [n.child, ...(n.children ?? [])].filter((c): c is Layer => !!c).map(c => find(c, kind)).find(Boolean);
      const body = find(layer.root, "body")!.bounds, table = find(layer.root, "table")!.bounds;
      const bottom = table.y + table.height - body.y;
      const nonBodyHeight = (pageDef.height + 75000) / 75 - body.height;
      for (const slack of [0.6, 0, -0.6, -20]) {
        const height = Math.ceil((nonBodyHeight + bottom + slack) * 75);
        d.setPageDef(0, JSON.stringify({ height }));
        const layout = visibleRow(d, words);
        expect(layout.length, JSON.stringify({ slack, height, bottom, nonBodyHeight })).toBe(slack >= 0 ? 1 : 2);
      }
      d.setPageDef(0, JSON.stringify({ height: pageDef.height }));
      // Preceding text occupies half the page; a smaller row that fits a fresh
      // page must defer intact under None instead of forcing an in-row cut.
      const small = new engine.HwpDocument(fixture("hwpx", true, false, false, false, 1, numbered(350))) as RowDoc;
      try {
        small.insertParagraph(0, 0);
        small.insertText(0, 0, 0, "prefix\n".repeat(20));
        const deferred = visibleRow(small, numbered(350));
        expect(deferred.map(page => page.words.length)).toEqual([0, 350]);
        expect(deferred[0]!.tables).toHaveLength(0);
        expect(deferred[1]!.tables).toHaveLength(1);
      } finally { small.free(); }
    } finally { d.free(); }
  });

  it.each(["hwp", "hwpx"] as const)("row pagination boundary product edit/reflow/history and %s preservation", async format => {
    const words = numbered(580), c = await open(format, true, false, false, false, 1, words);
    const { editor, doc, at, place, settle, run } = c;
    try {
      const before = visibleRow(doc as RowDoc, words);
      expect(before.length).toBe(1);
      const tail = " " + numbered(40).replace(/w(\d+)/g, (_, i: string) => `w${580 + Number(i)}`);
      place({ ...at, offset: words.length });
      const revision = editor.snapshot().revision;
      expect(editor.typeText(tail)).toBe(true); await settle();
      expect(editor.snapshot().revision).toBeGreaterThan(revision);
      const after = visibleRow(doc as RowDoc, words + tail);
      expect(after.length).toBe(2);
      const caret = new RhwpText(doc).caret(editor.caret)!;
      expect(caret.page).toBe(1);
      expect(editor.pointAt(caret.page, caret.x, caret.y + caret.height / 2, false)).toBe(true);
      expect(editor.caret.cell).toMatchObject(at.cell!);
      await run("edit.undo"); expect(visibleRow(doc as RowDoc, words).length).toBe(1);
      await run("edit.redo"); expect(visibleRow(doc as RowDoc, words + tail).length).toBe(2);
      const saved = await c.save();
      expect(saved.publishable, JSON.stringify(saved.raw)).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as RowDoc;
      try {
        expect(visibleRow(reopened, words + tail).length).toBe(2);
        expect(new RhwpText(reopened).ownsNestedCell(at)).toBe(true);
        expect(JSON.parse(reopened.getTableDimensionsByPath!(0, at.paragraph, pathJson(at.cell!)))).toMatchObject({ rowCount: 1, colCount: 1 });
      } finally { reopened.free(); }
    } finally { doc.free(); }
  });

  /** Every page's render tree: deepest Table nesting, and the numbered deep words in page order. */
  function deepLayout(d: RhwpDocument & { pageCount(): number; getPageRenderTree(page: number): string }) {
    type Node = { type: string; text?: string; bbox: { x: number; y: number; w: number; h: number }; children?: Node[] };
    let nesting = 0; const words: string[] = [], tables: Node["bbox"][][] = [];
    for (let page = 0; page < d.pageCount(); page++) {
      /** Returns whether `n` contains a Table; a Table without a descendant Table ends one bounds chain. */
      const walk = (n: Node, depth: number, chain: Node["bbox"][]): boolean => {
        if (n.type === "Table") { depth++; chain = [...chain, n.bbox]; if (depth > nesting) nesting = depth; }
        if (n.type === "TextRun" && n.text) words.push(...n.text.split(/\s+/).filter(w => /^w\d+$/.test(w)));
        let inner = false;
        for (const c of n.children ?? []) inner = walk(c, depth, chain) || inner;
        if (n.type === "Table" && !inner) tables.push(chain);
        return inner || n.type === "Table";
      };
      walk(JSON.parse(d.getPageRenderTree(page)), 0, []);
    }
    return { pages: d.pageCount(), nesting, words, tables };
  }

  it("existing 16-level HWP document: full layout, deep editing/IME/Undo/Redo, product T009 save and reopen", async () => {
    const DEPTH = 16, c = await open("hwp", true, false, false, false, DEPTH), { editor, doc, at, place, run, settle } = c;
    try {
      const nested = Array.from({ length: DEPTH - 1 }, () => ({ control: 0, cell: 0, cellParagraph: 0 }));
      const deep: DocPosition = { ...at, offset: 0, cell: { ...at.cell!, nested } };
      const text = new RhwpText(doc);
      expect(text.ownsNestedCell(deep)).toBe(true);
      expect(text.text(deep, 6)).toBe("w0 w1 ");
      // Measured and paginated from real content: all 16 levels, every word exactly once in order, across pages.
      const layout = deepLayout(doc as never);
      expect(layout.nesting).toBe(DEPTH);
      expect(layout.pages).toBeGreaterThan(1);
      expect(layout.words).toEqual(DEEP_WORDS.split(" "));
      // Parent/child bounds nest on every page (no zero-height or escaping child).
      for (const chain of layout.tables) for (let i = 1; i < chain.length; i++) {
        const [o, n] = [chain[i - 1]!, chain[i]!];
        expect(n.h).toBeGreaterThan(0);
        expect(n.x).toBeGreaterThanOrEqual(o.x); expect(n.x + n.w).toBeLessThanOrEqual(o.x + o.w + 0.5);
        expect(n.y).toBeGreaterThanOrEqual(o.y - 0.5); expect(n.y + n.h).toBeLessThanOrEqual(o.y + o.h + 0.5);
      }
      const last = text.caret({ ...deep, offset: text.paragraphLength(deep) })!;
      expect(last.page).toBeGreaterThan(0);
      // Caret by pointer: the hit resolves to the same explicit 16-level path.
      const first = text.caret({ ...deep, offset: 1 })!;
      expect(editor.pointAt(first.page, first.x + 1, first.y + first.height / 2, false)).toBe(true);
      expect(editor.caret.cell!.nested).toEqual(nested);
      // Insert/delete, Undo/Redo, IME and formatting at level 16.
      const before = doc.getTextFileText(), length = text.paragraphLength(deep);
      place({ ...deep, offset: 2 }); expect(editor.typeText("XY")).toBe(true); await settle();
      expect(text.text(deep, 6)).toBe("w0XY w");
      expect(editor.caret).toMatchObject({ offset: 4, cell: { nested } });
      expect(editor.backspace()).toBe(true); await settle();
      expect(text.text(deep, 5)).toBe("w0X w");
      await run("edit.undo"); await run("edit.undo");
      expect(doc.getTextFileText()).toBe(before);
      await run("edit.redo"); await run("edit.redo");
      expect(text.text(deep, 5)).toBe("w0X w");
      place({ ...deep, offset: 3 });
      editor.beginComposition(); expect(editor.composing).toBe(true);
      editor.updateComposition("가"); editor.endComposition("가"); await settle();
      expect(text.text(deep, 6)).toBe("w0X가 w");
      expect(text.paragraphLength(deep)).toBe(length + 2);
      place({ ...deep, offset: 0 }); editor.caret = { ...deep, offset: 2 };
      expect(editor.selectionRects().length).toBeGreaterThan(0);
      await run("format.bold");
      expect(JSON.parse(doc.getCellCharPropertiesAtByPath!(0, at.paragraph, pathJson(deep.cell!), 0)).bold).toBe(true);
      expect(new RhwpText(doc).ownsNestedCell(deep)).toBe(true);
      const edited = doc.getTextFileText(), relaid = deepLayout(doc as never);
      expect(relaid.nesting).toBe(DEPTH);
      // "w0X가" no longer matches the word pattern (the bold "w0" may form its own run); every other word stays once, in order.
      expect(relaid.words.filter(w => w !== "w0")).toEqual(DEEP_WORDS.split(" ").slice(1));
      // Product save: live/reopen comparison and the real T009 checker; then an independent engine reopen.
      const saved = await c.save();
      expect(saved.publishable, JSON.stringify(saved.raw)).toBe(true);
      const re = new engine.HwpDocument(saved.output) as Doc;
      try {
        expect(re.getTextFileText()).toBe(edited);
        const rt = new RhwpText(re);
        expect(rt.ownsNestedCell(deep)).toBe(true);
        expect(rt.text(deep, 6)).toBe("w0X가 w");
        expect(JSON.parse(re.getTableDimensionsByPath!(0, at.paragraph, pathJson(deep.cell!)))).toMatchObject({ rowCount: 1, colCount: 1 });
        expect(JSON.parse(re.getCellCharPropertiesAtByPath!(0, at.paragraph, pathJson(deep.cell!), 0)).bold).toBe(true);
        expect(deepLayout(re as never).nesting).toBe(DEPTH);
      } finally { re.free(); }
    } finally { editor.dispose(); }
  }, 30_000);

  it("existing 12-level HWPX document edits and saves; a 16-level HWPX is refused instead of opening empty", async () => {
    const DEPTH = 12, c = await open("hwpx", true, false, false, false, DEPTH), { editor, doc, at, place, settle } = c;
    try {
      const nested = Array.from({ length: DEPTH - 1 }, () => ({ control: 0, cell: 0, cellParagraph: 0 }));
      const deep: DocPosition = { ...at, offset: 0, cell: { ...at.cell!, nested } };
      const layout = deepLayout(doc as never);
      expect(layout.nesting).toBe(DEPTH);
      expect(layout.words).toEqual(DEEP_WORDS.split(" "));
      place({ ...deep, offset: 2 }); expect(editor.typeText("Z")).toBe(true); await settle();
      const reopened = checkHwpx(c.original, doc);
      try { expect(new RhwpText(reopened).text(deep, 4)).toBe("w0Z "); } finally { reopened.free(); }
    } finally { editor.dispose(); }
    // Beyond the HWPX reader envelope: an explicit nesting refusal, never a silently empty section.
    const over = fixture("hwpx", true, false, false, false, 16);
    expect(() => new engine.HwpDocument(over)).toThrow(/nesting/i);
  }, 30_000);

  it.each(["hwp", "hwpx"] as const)("%s: product body-table rectangular merge invokes the engine and reopens", async format => {
    const { editor, doc, at, place, run } = await open(format);
    try {
      place(at); editor.caret = withCell(at, 3);
      await run("table.mergeCells");
      expect(JSON.parse(doc.getTableDimensions(0, at.paragraph, at.cell!.control)).cellCount).toBe(1);
      expect(doc.getCellParagraphCount(0, at.paragraph, at.cell!.control, 0)).toBe(4);
      const saved = exported(doc, format);
      writeFileSync(join(out, `range.${format}`), saved.bytes);
      const reopened = new engine.HwpDocument(new Uint8Array(readFileSync(join(out, `range.${format}`)))) as Doc;
      try {
        expect(reopened.getTextFileText()).toBe(doc.getTextFileText());
        expect(JSON.parse(reopened.getTableDimensions(0, at.paragraph, at.cell!.control))).toMatchObject({ rowCount: 2, colCount: 2, cellCount: 1 });
        expect(reopened.getCellParagraphCount(0, at.paragraph, at.cell!.control, 0)).toBe(4);
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  it("HWP: original nested table evolves, new nested table, nested metrics; product save passes T009 and reopens", async () => {
    const { editor, doc, at, place, run, settle, save } = await open("hwp", false, true);
    try {
      // The original nested table (created in cell 0 before export) is part of a complete reopen baseline.
      const child = { ...at, cell: { ...at.cell!, nested: [{ control: 0, cell: 0, cellParagraph: 0 }] } };
      place(child); editor.caret = { ...child, offset: 5 };
      await run("hangul.charWidth", { command: "hangul.charWidth", percent: 120 });
      place(child); await run("table.insertRowBelow");
      place(withCell(child, 3)); expect(editor.typeText("셀")).toBe(true); await settle();
      // A new nested table in another outer cell, edited and restructured before the save.
      place(withCell(at, 1)); await run("insert.table", { command: "insert.table", rows: 2, cols: 2 });
      const created = editor.caret;
      expect(created.cell!.nested).toHaveLength(1);
      expect(editor.typeText("new")).toBe(true); await settle();
      await run("table.insertColumnRight");
      // HWP nested formula: persistent insertion, replacement, recalculation after a nested structure change.
      place(withCell(created, 2));
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=1+2" });
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=2*3" });
      const nestedFormula = () => (JSON.parse(doc.getFieldList!()) as { fieldId: number; fieldType: string; command: string; location: { path: unknown[] } }[])
        .filter(f => f.fieldType === "formula");
      expect(nestedFormula().map(f => [f.command, f.location.path.length])).toEqual([["=2*3??%g,;;6", 2]]);
      const formulaId = nestedFormula()[0]!.fieldId;
      place(withCell(created, 0)); await run("table.insertRowAbove");
      expect(nestedFormula().map(f => [f.fieldId, f.command])).toEqual([[formulaId, "=2*3??%g,;;6"]]);
      // A newly inserted outer cell can own a newly created child; it cannot
      // borrow an original child merely because its bytes still occur globally.
      place(withCell(at, 3)); await run("table.insertRowBelow");
      place(withCell(at, 4)); await run("insert.table", { command: "insert.table", rows: 1, cols: 1 });
      const fresh = editor.caret;
      place(withCell(at, 5)); await run("table.insertColumnRight");
      const freshMoved = { ...fresh, cell: { ...fresh.cell!, cell: 6 } };
      expect(JSON.parse(doc.getTableDimensionsByPath!(0, at.paragraph, pathJson(freshMoved.cell)))).toMatchObject({ rowCount: 1, colCount: 1 });
      const saved = await save();
      expect(Object.values(saved.reopen).every(Boolean), JSON.stringify(saved.reopen)).toBe(true);
      expect(saved.raw.findings.every(f => f.code === "previewStale"), JSON.stringify(saved.raw)).toBe(true);
      expect(saved.publishable).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        expect(reopened.getTextFileText()).toBe(doc.getTextFileText());
        expect(JSON.parse(reopened.getTableDimensionsByPath!(0, at.paragraph, pathJson(child.cell)))).toMatchObject({ rowCount: 3, colCount: 2 });
        expect(JSON.parse(reopened.getCellCharPropertiesAtByPath!(0, at.paragraph, pathJson(child.cell), 0)).ratios[0]).toBe(120);
        expect(JSON.parse(reopened.getTableDimensionsByPath!(0, at.paragraph, pathJson(created.cell!)))).toMatchObject({ rowCount: 3, colCount: 3 });
        expect((JSON.parse(reopened.getFieldList!()) as { fieldId: number; fieldType: string; command: string; location: { path: unknown[] } }[])
          .filter(f => f.fieldType === "formula").map(f => [f.fieldId, f.command, f.location.path.length])).toEqual([[formulaId, "=2*3??%g,;;6", 2]]);
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  it("A1/A2: empty nested cells select and merge; a refused cross-context extension reports false and keeps state", async () => {
    const { editor, doc, at, place, run } = await open();
    try {
      place(at); await run("insert.table", { command: "insert.table", rows: 2, cols: 2 });
      const nested = editor.caret, text = new RhwpText(doc);
      // No text anywhere in the nested table: ownership comes from table/cell provenance, not TextRuns.
      const rect = text.caret(withCell(nested, 3))!;
      expect(editor.pointAt(rect.page, rect.x + 1, rect.y + rect.height / 2, true)).toBe(true);
      expect(editor.selectionRects()).toHaveLength(4);
      // Shift+click outside the anchor's table (the trailing body paragraph): refused, reported, no state change.
      const body = text.caret({ section: 0, paragraph: at.paragraph + 1, offset: 0 });
      const before = [editor.anchor, editor.caret];
      if (body) expect(editor.pointAt(body.page, body.x + 1, body.y + body.height / 2, true)).toBe(false);
      expect([editor.anchor, editor.caret]).toEqual(before);
      await run("table.mergeCells");
      expect(JSON.parse(doc.getTableDimensionsByPath!(0, at.paragraph, pathJson(editor.caret.cell!))).cellCount).toBe(1);
    } finally { editor.dispose(); }
  });

  it("HWPX rich table: picture, child table, ClickHere-free formulas relocate; nested formula; save and reopen", async () => {
    const c = await open("hwpx", false, false, true), { editor, doc, at, place, run, settle } = c;
    try {
      const control = at.cell!.control, para = at.paragraph;
      place(withCell(at, 3)); await run("insert.table", { command: "insert.table", rows: 1, cols: 2 });
      const child = editor.caret;
      expect(editor.typeText("7")).toBe(true); await settle();
      // Nested formula through the product: same evaluator/field model, explicit path ownership.
      const nestedCell = withCell(child, 1);
      place(nestedCell);
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=A1*2" });
      expect(doc.getTextInCellByPath!(0, para, pathJson(nestedCell.cell!), 0, 2)).toBe("14");
      // Body formula in A3 reading A1:A2.
      place(withCell(at, 4));
      const caption = () => doc.getTableCaptionByPath!(0, para, JSON.stringify([{ controlIndex: control, cellIndex: 0, cellParaIndex: 0 }]));
      const captionBefore = caption();
      expect(captionBefore).toContain("Cap");
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=SUM(A1:A2)" });
      expect(doc.getTextInCell(0, para, control, 4, 0, 0, 1)).toBe("3");
      // Insert a row above the first row: the formula moves to A4, references become A2:A3, value is recalculated.
      place(withCell(at, 0)); await run("table.insertRowAbove");
      const fields = () => (JSON.parse(doc.getFieldList!()) as { fieldType: string; command: string; value: string; location: { path: unknown[] } }[])
        .filter(f => f.fieldType === "formula");
      expect(fields().map(f => f.command).sort()).toEqual(["=A1*2??%g,;;14", "=SUM(A2:A3)??%g,;;3"]);
      expect(JSON.parse(doc.getTableDimensions(0, para, control))).toMatchObject({ rowCount: 4, colCount: 2 });
      // The caption is kept; the floating picture and the child table are preserved (the child moved row 1 → row 2).
      expect(caption()).toBe(captionBefore);
      const ctl = JSON.parse(doc.getControls!()) as { ctrlId: string; userDesc: string }[];
      expect(ctl.filter(x => x.ctrlId === "gso").length).toBe(1);
      expect(ctl.filter(x => x.ctrlId === "tbl").length).toBe(2);
      // A deletion whose formula references would dangle is refused before any engine call.
      place(withCell(at, 2));
      expect(documentCommandState("table.deleteRow", editor.snapshot()).available).toBe(true);
      const beforeRefusal = doc.getTextFileText();
      expect(editor.execute("table.deleteRow").accepted).toBe(false);
      expect(doc.getTextFileText()).toBe(beforeRefusal);
      // Deleting the inserted empty first row restores the references; Undo/Redo stays coherent.
      place(withCell(at, 0)); await run("table.deleteRow");
      expect(fields().map(f => f.command).sort()).toEqual(["=A1*2??%g,;;14", "=SUM(A1:A2)??%g,;;3"]);
      await run("edit.undo"); expect(fields().map(f => f.command).sort()).toEqual(["=A1*2??%g,;;14", "=SUM(A2:A3)??%g,;;3"]);
      await run("edit.redo");
      // Nested structure change rewrites the nested formula's references (column inserted left of A).
      place(withCell(child, 0)); await run("table.insertColumnLeft");
      expect(fields().map(f => f.command).sort()).toEqual(["=B1*2??%g,;;14", "=SUM(A1:A2)??%g,;;3"]);
      const reopened = checkHwpx(c.original, doc);
      try {
        expect((JSON.parse(reopened.getFieldList!()) as { fieldType: string; command: string }[]).filter(f => f.fieldType === "formula")
          .map(f => f.command).sort()).toEqual(["=B1*2??%g,;;14", "=SUM(A1:A2)??%g,;;3"]);
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  it("T009 HWP: child tables follow an explicit cell correspondence; unjustified loss is refused", () => {
    // Original: 2x2 body table, child table in cell (0,0). Outputs are produced by the engine's own operations.
    const original = fixture("hwp", false, true);
    const variant = (edit: (d: Doc, para: number, control: number) => void) => {
      const d = new engine.HwpDocument(original) as Doc;
      try {
        const t = JSON.parse(d.getControls!()).find((c: { ctrlId: string; list: number }) => c.ctrlId === "tbl" && c.list === 0);
        edit(d, t.para, t.controlIndex);
        const e = exported(d, "hwp");
        return check("hwp", "saved", original, e.bytes, e.loss, true);
      } finally { d.free(); }
    };
    const accepted = (r: ReturnType<typeof check>) => r.findings.every(f => f.code === "previewStale");
    const host = (control: number) => JSON.stringify([{ controlIndex: control, cellIndex: 0, cellParaIndex: 0 }]);
    // 1. Deleting the other row keeps the child in its surviving cell.
    { const r = variant((d, p, c) => d.deleteTableRow!(0, p, c, 1)); expect(accepted(r), JSON.stringify(r)).toBe(true); }
    // 2. Deleting the row that owns the child legitimately removes it.
    expect(accepted(variant((d, p, c) => d.deleteTableRow(0, p, c, 0))), "owner deleted").toBe(true);
    // 3. Same cell-count reduction, but the child disappears from its surviving cell: refused.
    const lost = variant((d, p, c) => { d.deleteTableRow(0, p, c, 1); (d as unknown as Record<string, (...a: unknown[]) => string>).deleteCellTableControlByPath!(0, p, host(c), 0); });
    expect(accepted(lost), JSON.stringify(lost)).toBe(false);
    expect(lost.outcome).toBe("unsafe");
    // 4. A merge keeps the absorbed/anchor children; losing the child during the merge is refused.
    expect(accepted(variant((d, p, c) => d.mergeTableCells!(0, p, c, 0, 0, 0, 1))), "merge retained").toBe(true);
    expect(accepted(variant((d, p, c) => { d.mergeTableCells!(0, p, c, 0, 0, 0, 1);
      (d as unknown as Record<string, (...a: unknown[]) => string>).deleteCellTableControlByPath!(0, p, host(c), 0); })), "merge lost").toBe(false);
  });

  it("HWP field-rich captioned table: structure ops move formula/ClickHere fields and rewrite references; T009 save and reopen", async () => {
    const { editor, doc, at, place, run, save } = await open("hwp", false, false, true);
    try {
      const control = at.cell!.control, para = at.paragraph;
      const caption = () => doc.getTableCaptionByPath!(0, para, JSON.stringify([{ controlIndex: control, cellIndex: 0, cellParaIndex: 0 }]));
      const fields = (d: RhwpDocument) => (JSON.parse(d.getFieldList!()) as { fieldId: number; fieldType: string; command: string; value: string; location: unknown }[])
        .map(f => ({ id: f.fieldId, type: f.fieldType, command: f.command, location: f.location })).sort((a, b) => a.id - b.id);
      const captionBefore = caption(), clickBefore = fields(doc).find(f => f.type === "clickhere")!;
      expect(captionBefore).toContain("Cap");
      place(withCell(at, 0)); await run("table.insertRowAbove");
      place(withCell(at, 0)); editor.caret = withCell(at, 1); await run("table.mergeCells");
      await run("table.splitCell");
      place(withCell(at, 0)); await run("table.insertColumnLeft");
      const formula = fields(doc).find(f => f.type === "formula")!;
      expect(formula.command).toBe("=SUM(B2:B3)??%g,;;3");
      const click = fields(doc).find(f => f.type === "clickhere")!;
      expect([click.id, click.command]).toEqual([clickBefore.id, clickBefore.command]);
      expect(caption()).toBe(captionBefore);
      // A reference that would dangle refuses the deletion before any engine call.
      place(withCell(at, 3)); const unchanged = doc.getTextFileText();
      expect(editor.execute("table.deleteRow").accepted).toBe(false);
      expect(doc.getTextFileText()).toBe(unchanged);
      const saved = await save();
      expect(Object.values(saved.reopen).every(Boolean), JSON.stringify(saved.reopen)).toBe(true);
      expect(saved.raw.findings.every(f => f.code === "previewStale"), JSON.stringify(saved.raw)).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        expect(fields(reopened)).toEqual(fields(doc));
        expect(reopened.getTableCaptionByPath!(0, para, JSON.stringify([{ controlIndex: control, cellIndex: 0, cellParaIndex: 0 }]))).toBe(captionBefore);
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  it("HWP field-only replacement uses real T009 and persists identity/cache", async () => {
    const { editor, doc, at, place, run, save } = await open("hwp");
    try {
      const fields = () => JSON.parse(doc.getFieldList!()) as { fieldId: number; fieldType: string; command: string; value: string }[];
      place(withCell(at, 0));
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=1+2" });
      const id = fields().find(f => f.fieldType === "formula")!.fieldId;
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=SUM(B?:B?)+6" });
      const saved = await save();
      expect(saved.publishable, JSON.stringify(saved)).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        const field = (JSON.parse(reopened.getFieldList!()) as { fieldId: number; fieldType: string; command: string; value: string }[]).find(f => f.fieldType === "formula")!;
        expect([field.fieldId, field.command, field.value]).toEqual([id, "=SUM(B?:B?)+6??%g,;;6", "6"]);
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  it("HWP multiple fields: explicit control positions/ranges survive composite product save/reopen", async () => {
    const { editor, doc, at, place, run, save } = await open("hwp", false, false, true, true);
    const clickFields = (d: RhwpDocument) => (JSON.parse(d.getFieldList!()) as Record<string, unknown>[]).filter(f => f.fieldType === "clickhere").sort((a, b) => Number(a.controlIndex) - Number(b.controlIndex));
    const metadata = (d: RhwpDocument) => clickFields(d).map(f => ({ ...f, location: undefined, listId: undefined }));
    try {
      const initial = metadata(doc);
      expect(initial).toHaveLength(2);
      expect(new Set(initial.map(f => f.fieldId)).size).toBe(2);
      expect(initial.map(f => f.controlIndex)).toEqual([0, 1]);
      expect(initial[0]!.endCharIdx).toBeLessThanOrEqual(initial[1]!.startCharIdx as number);
      place(withCell(at, 0)); await run("table.insertRowAbove");
      place(withCell(at, 0)); await run("table.insertColumnLeft");
      expect(metadata(doc)).toEqual(initial);
      await run("edit.undo"); await run("edit.redo");
      expect(metadata(doc)).toEqual(initial);
      const saved = await save();
      expect(saved.publishable, JSON.stringify(saved)).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try { expect(clickFields(reopened)).toEqual(clickFields(doc)); } finally { reopened.free(); }
      // A partial engine mutation that drops exactly one of the two fields must
      // fail the digest proof and restore both independent identities/ranges.
      const before = clickFields(doc), text = doc.getTextFileText();
      const insert = doc.insertTableRow!.bind(doc);
      doc.insertTableRow = (...args) => {
        const result = insert(...args);
        const api = doc as unknown as Record<string, (...a: unknown[]) => string>;
        api.removeFieldAtInCell!(0, at.paragraph, at.cell!.control, 8, 0, 0, false);
        return result;
      };
      place(withCell(at, 0));
      expect(editor.execute("table.insertRowAbove").accepted).toBe(false);
      expect(clickFields(doc)).toEqual(before);
      expect(doc.getTextFileText()).toBe(text);
    } finally { editor.dispose(); }
  });

  it("T009 HWP: a field lost from a surviving cell during a structure change is refused", () => {
    const original = fixture("hwp", false, false, true);
    const d = new engine.HwpDocument(original) as Doc;
    try {
      const t = JSON.parse(d.getControls!()).find((c: { ctrlId: string; list: number }) => c.ctrlId === "tbl" && c.list === 0);
      d.insertTableRow!(0, t.para, t.controlIndex, 0, false);
      // The ClickHere field of B1 (now B2) disappears although its cell survives.
      (d as unknown as Record<string, (...a: unknown[]) => string>).removeFieldAtInCell!(0, t.para, t.controlIndex, 3, 0, 0, false);
      expect((JSON.parse(d.getFieldList!()) as { fieldType: string }[]).some(f => f.fieldType === "clickhere")).toBe(false);
      const e = exported(d, "hwp");
      const result = check("hwp", "saved", original, e.bytes, e.loss, true);
      expect(result.outcome, JSON.stringify(result)).toBe("unsafe");
      expect(result.findings.some(f => f.code !== "previewStale")).toBe(true);
    } finally { d.free(); }
  });

  it("formula rewrite success without the applied final state is detected and rolled back", async () => {
    const { editor, doc, at, place, run } = await open("hwpx", false, false, true);
    try {
      place(withCell(at, 4));
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=SUM(A1:A2)" });
      const before = doc.getTextFileText(), fields = doc.getFieldList!();
      // The engine answers like a successful replacement (same response shape) but leaves the field unchanged.
      doc.insertTableFormulaField = (...args) => doc.validateTableFormulaField!(...args);
      place(withCell(at, 0));
      expect(documentCommandState("table.insertRowAbove", editor.snapshot()).available).toBe(true);
      expect(editor.execute("table.insertRowAbove").accepted).toBe(false);
      expect(doc.getTextFileText()).toBe(before);
      expect(doc.getFieldList!()).toBe(fields);
      expect(JSON.parse(doc.getTableDimensions(0, at.paragraph, at.cell!.control)).rowCount).toBe(3);
    } finally { editor.dispose(); }
  });

  it("a partial nested engine failure restores the exact before snapshot", async () => {
    const c = await open(), { editor, doc, at, place, run } = c;
    try {
      place(at); await run("insert.table", { command: "insert.table", rows: 2, cols: 2 });
      const before = doc.getTextFileText(), path = pathJson(editor.caret.cell!);
      const dimensions = doc.getTableDimensionsByPath!(0, at.paragraph, path);
      const apply = doc.editTableByPath!.bind(doc);
      doc.editTableByPath = (...args) => { apply(...args); throw new Error("after mutation"); };
      expect(editor.execute("table.insertRowAbove").accepted).toBe(false);
      expect(doc.getTextFileText()).toBe(before);
      expect(doc.getTableDimensionsByPath!(0, at.paragraph, path)).toBe(dimensions);
      expect(editor.snapshot().editable).toBe(false);
    } finally { editor.dispose(); }
  });

  it("bounds structural proof reads before allocating a large cell string", () => {
    const doc = { getCellParagraphCount: () => 1, getCellParagraphLength: () => 4 * 1024 * 1024 + 1,
      getTextInCell: () => { throw new Error("must not allocate an over-budget string"); },
      getControls: () => "[]", getFieldList: () => "[]", getTableCaptionByPath: () => '{"paragraphs":null}',
      getCursorModel: () => JSON.stringify({ lists: [{ listId: 2, isCell: true, hostListId: 0, sectionIndex: 0, hostPara: 0, controlIndex: 0, cellIndex: 0 }] }),
    } as unknown as RhwpDocument;
    const grid = { rows: 1, cols: 1, cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1 }] };
    expect(planTableOp(doc, { section: 0, paragraph: 0, control: 0 }, grid, 0, "insertRowBelow")).toBe("limit");
  });

  it("rectangles reject partial merged spans and accept whole spans", () => {
    const grid = { rows: 2, cols: 3, cells: [
      { row: 0, col: 0, rowSpan: 1, colSpan: 2 }, { row: 0, col: 2, rowSpan: 1, colSpan: 1 },
      { row: 1, col: 0, rowSpan: 1, colSpan: 1 }, { row: 1, col: 1, rowSpan: 1, colSpan: 1 }, { row: 1, col: 2, rowSpan: 1, colSpan: 1 },
    ] };
    expect(rectangularRange(grid, 1, 3)).toBeNull();
    expect(rectangularRange(grid, 0, 4)).toEqual({ startRow: 0, startCol: 0, endRow: 1, endCol: 2 });
  });
});
