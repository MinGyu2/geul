// @vitest-environment jsdom
// Focused Stage 2 implementation regression; product defaults, actual Release WASM.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
import { base, controlledBackend, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
const wasm = engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const out = join(root, "target/stage2-focused"); mkdirSync(out, { recursive: true });
type Doc = RhwpDocument & { createBlankDocument(): void; getTextFileText(): string };
function exported(d: RhwpDocument, format: "hwp" | "hwpx") {
  const e = format === "hwp" ? d.exportHwpWithReport() : d.exportHwpxWithReport();
  try { return { loss: e.contentLoss(), bytes: e.takeBytes() }; } finally { e.free(); }
}
function fixture(format: "hwp" | "hwpx", emptyWrapper = false, nestedGuard = false) {
  const d = engine.HwpDocument.createEmpty() as Doc;
  try {
    d.createBlankDocument();
    const t = JSON.parse(d.createTable!(0, 0, 0, emptyWrapper ? 1 : 2, emptyWrapper ? 1 : 2));
    d.setTableProperties!(0, t.paraIdx, t.controlIdx, JSON.stringify(format === "hwp" ? HWP_TABLE_NORMALIZATION : { textWrap: "TopAndBottom" }));
    for (let i = 0; i < (emptyWrapper ? 0 : 4); i++) d.insertTextInCell(0, t.paraIdx, t.controlIdx, i, 0, 0, `outer${i}`);
    if (nestedGuard) {
      const host = [{ controlIndex: t.controlIdx, cellIndex: 0, cellParaIndex: 0 }];
      const child = JSON.parse(d.createTableInCellByPath!(0, t.paraIdx, JSON.stringify(host), 3, 2, 2));
      d.insertTextInCellByPath!(0, t.paraIdx, JSON.stringify([...host,
        { controlIndex: child.controlIdx, cellIndex: 0, cellParaIndex: 0 }]), 0, "guard");
    }
    return exported(d, format).bytes;
  } finally { d.free(); }
}
async function open(format: "hwp" | "hwpx" = "hwpx", emptyWrapper = false, nestedGuard = false) {
  const original = fixture(format, emptyWrapper, nestedGuard), { backend, take, calls } = controlledBackend();
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
  return { original, editor, doc, at, place, settle, run };
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

  it("depth six, line-aware Home/End, strict path budget and HWP/HWPX engine roundtrip", async () => {
    const c = await open("hwpx", true), { editor, doc, at, place, run, settle } = c;
    try {
      place(at);
      for (let depth = 1; depth < 6; depth++) await run("insert.table", { command: "insert.table", rows: 1, cols: 1 });
      const deep = editor.caret;
      expect(deep.cell!.nested).toHaveLength(5);
      expect(editor.typeText("long paragraph repeated words ".repeat(20))).toBe(true); await settle();
      const text = new RhwpText(doc), line = text.line({ ...deep, offset: 10 })!;
      expect(line.end).toBeLessThan(text.paragraphLength(deep));
      place({ ...deep, offset: 10 }); expect(editor.moveLineEdge("end", false)).toBe(true);
      expect(editor.caret.offset).toBe(line.end);
      expect(editor.moveLineEdge("start", false)).toBe(true); expect(editor.caret.offset).toBe(line.start);
      const rect = text.caret(editor.caret)!;
      expect(rect).not.toBeNull();
      expect(editor.pointAt(rect.page, rect.x + 1, rect.y + rect.height / 2, false)).toBe(true);
      expect(editor.caret.cell!.nested).toHaveLength(5);
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

  it("HWP nested metrics retain the original-preservation gate without mutation", async () => {
    const { editor, doc, at, place } = await open("hwp", false, true);
    try {
      const child = { ...at, cell: { ...at.cell!, nested: [{ control: 0, cell: 0, cellParagraph: 0 }] } };
      place(child); editor.caret = { ...child, offset: 1 };
      const before = doc.getTextFileText(), revision = editor.localRevision;
      for (const command of ["hangul.charWidth", "hangul.charSpacing"] as const) {
        expect(documentCommandState(command, editor.snapshot()).available).toBe(false);
        expect(editor.execute(command, { command, percent: command === "hangul.charWidth" ? 120 : 5 }).accepted).toBe(false);
      }
      expect(doc.getTextFileText()).toBe(before);
      expect(editor.localRevision).toBe(revision);
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
      getTextInCell: () => { throw new Error("must not allocate an over-budget string"); } } as unknown as RhwpDocument;
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
