// @vitest-environment jsdom
// Actual selected Release WASM; backend replies are controlled, not real publication.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { RhwpEditorSession, ADVANCED_MAX_SOURCE_BYTES } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "../../src/components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";
import { documentCommandState } from "../../src/commands/capability";
import { RhwpText } from "../../src/components/Editor/rhwp/rhwpText";

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
const wasm = engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const body = (offset: number, paragraph = 0) => ({ section: 0, paragraph, offset });
const bytes = (doc: RhwpDocument, format: "hwp" | "hwpx") => {
  const report = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
  try { return report.takeBytes(); } finally { report.free(); }
};
function largeBodyText() {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let state = 0x01234567;
  const chunks: string[] = [];
  let chunk = "";
  for (let index = 0; index < 160_000; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    chunk += alphabet[(state >>> 26) % alphabet.length];
    if (index % 37 === 36) chunk += " ";
    if (chunk.length >= 2048) { chunks.push(chunk); chunk = ""; }
  }
  if (chunk) chunks.push(chunk);
  return chunks.join("");
}

async function open(format: "hwp" | "hwpx", large = false) {
  const seed = engine.HwpDocument.createEmpty(); seed.createBlankDocument();
  const text = large ? largeBodyText() : "Body text";
  seed.insertText(0, 0, 0, text); seed.splitParagraph(0, 0, text.length);
  const table = JSON.parse(seed.createTable(0, 1, 0, 2, 2));
  seed.insertTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, "10");
  seed.insertTextInCell(0, table.paraIdx, table.controlIdx, 1, 0, 0, "20");
  const original = bytes(seed, format); seed.free();
  const { backend, take, calls } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open(`/a.${format}`); take("open").reply(ok({ ...base, format })); await opening;
  let doc!: RhwpDocument;
  const module: RhwpModule = { openDocument: b => { const d = new engine.HwpDocument(b); doc ??= d; return d; }, memoryBytes: () => wasm.memory.buffer.byteLength };
  // No options and no test flags: the production default is the subject of this test.
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module);
  const loading = editor.load();
  take("load").reply(loaded(original)); await flush();
  take("session").reply(ok(info({ format, state: "loading", sequence: 1 })));
  take("setState").reply(ok(info({ format, state: "ready", sequence: 2 })));
  const result = await loading;
  expect(result, JSON.stringify(editor.status)).toEqual({ ok: true, value: null });
  let sequence = 2;
  const settle = async () => {
    await flush();
    while (calls.some(c => c.method === "commit")) {
      const call = take("commit"), revision = Number(call.args[2]) + Number(call.args[3]);
      call.reply(ok(info({ format, state: "ready", revision, dirty: true, sequence: ++sequence }))); await flush();
    }
  };
  const control = JSON.parse((doc as RhwpDocument & { getControls(): string }).getControls()).find((c: { ctrlId: string }) => c.ctrlId === "tbl");
  const cell = (index: number, offset = 0) => ({ section: 0, paragraph: control.para, offset,
    cell: { parentParagraph: control.para, control: control.controlIndex, cell: index, cellParagraph: 0 } });
  const selectBody = () => { editor.anchor = body(0); editor.caret = body(2); };
  return { editor, doc, settle, cell, selectBody, calls, original, text };
}
const fields = (doc: RhwpDocument) => JSON.parse(doc.getFieldList!()) as { fieldId: number; command: string; value: string }[];
const insert = (editor: RhwpEditorSession, formula: string) => editor.execute("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula });

// Reuse the existing production-save service manifest contract. These are real
// engine bytes/proofs; publication is verified separately, never mocked as safe.
function emitLarge(format: "hwp" | "hwpx", stage: number, original: Uint8Array, doc: RhwpDocument) {
  const out = process.env.GEUL_T012_OUT;
  if (!out) return;
  mkdirSync(out, { recursive: true });
  const stem = join(out, `large-${format}-${stage}`);
  const exported = (d: RhwpDocument) => {
    const e = format === "hwp" ? d.exportHwpWithReport() : d.exportHwpxWithReport();
    try { return { bytes: e.takeBytes(), loss: JSON.parse(e.contentLoss()) }; } finally { e.free(); }
  };
  const before = new engine.HwpDocument(original), output = exported(doc);
  const reopened = new engine.HwpDocument(output.bytes);
  try {
    const noop = exported(before);
    const text = (d: RhwpDocument) => (d as RhwpDocument & { getTextFileText(): string }).getTextFileText();
    const reopen = { formatEqual: reopened.getSourceFormat() === doc.getSourceFormat(), pagesEqual: reopened.pageCount() === doc.pageCount(),
      textEqual: text(reopened) === text(doc), controlsEqual: reopened.getControls!() === doc.getControls!() };
    expect(Object.values(reopen).every(Boolean)).toBe(true);
    for (const [suffix, value] of [["original", original], ["unedited", noop.bytes], ["output", output.bytes]] as const) writeFileSync(stem + "." + suffix, value);
    writeFileSync(stem + ".unedited.loss.json", JSON.stringify(noop.loss));
    writeFileSync(stem + ".output.loss.json", JSON.stringify(output.loss));
    writeFileSync(stem + ".json", JSON.stringify({ cases: [{ name: `large-${format}-${stage}`, fmt: format, mode: "save", target: stem + ".target",
      unedited: stem + ".unedited", uneditedLoss: stem + ".unedited.loss.json", output: stem + ".output", outputLoss: stem + ".output.loss.json", reopen }],
      sourceBytes: original.length, pages: doc.pageCount(), memoryBytes: wasm.memory.buffer.byteLength }));
  } finally { before.free(); reopened.free(); }
}

// This file must be invoked with all four VITE_GEUL_TEST_* flags disabled (the production default is the subject).
describe("production advanced history, actual Release WASM", () => {
  for (const format of ["hwp", "hwpx"] as const) {
    // 2026-11-12 T010 production activation: the production default records general typing/IME history; T012
    // commands keep their pending/IME/bounds refusals inside that shared timeline.
    it(`${format}: body metrics, coherent Undo/Redo, pending refusal, ordinary input history and IME barrier`, async () => {
      const { editor, doc, settle, selectBody, calls } = await open(format);
      const snapshots = vi.spyOn(doc, "saveSnapshot");
      try {
        expect(editor.advancedHistoryOnly).toBe(false);
        expect(editor.typeText("한")).toBe(true); await settle();
        expect(snapshots).toHaveBeenCalledTimes(1);
        expect(editor.snapshot().history).toEqual({ undo: true, redo: false });
        selectBody();
        expect(editor.execute("hangul.charWidth", { command: "hangul.charWidth", percent: 130 }).accepted).toBe(true);
        expect(documentCommandState("hangul.charSpacing", editor.snapshot())).toEqual({ available: false, reason: "pendingEdits" });
        expect(editor.execute("hangul.charSpacing", { command: "hangul.charSpacing", percent: 10 }).accepted).toBe(false);
        await settle();
        const properties = () => JSON.parse(doc.getCharPropertiesAt!(0, 0, 0));
        expect(properties().ratios).toEqual(Array(7).fill(130));
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        expect(properties().ratios).toEqual(Array(7).fill(100));
        expect(doc.getTextRange(0, 0, 0, 1)).toBe("한");
        expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
        expect(properties().ratios).toEqual(Array(7).fill(130));
        selectBody(); expect(editor.execute("hangul.charSpacing", { command: "hangul.charSpacing", percent: -12 }).accepted).toBe(true); await settle();
        expect(properties().spacings).toEqual(Array(7).fill(-12));
        const beforeInput = snapshots.mock.calls.length;
        editor.caret = editor.anchor = body(0);
        expect(editor.typeText("글")).toBe(true); await settle();
        expect(snapshots.mock.calls.length).toBeGreaterThan(beforeInput);
        expect(doc.getTextRange(0, 0, 0, 2)).toBe("글한");
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        expect(doc.getTextRange(0, 0, 0, 1)).toBe("한");
        expect(properties().spacings).toEqual(Array(7).fill(-12));
        expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
        expect(doc.getTextRange(0, 0, 0, 2)).toBe("글한");
        editor.beginComposition(); editor.updateComposition("가");
        expect(editor.execute("hangul.charWidth", { command: "hangul.charWidth", percent: 140 }).accepted).toBe(false);
        expect(documentCommandState("edit.undo", editor.snapshot())).toEqual({ available: false, reason: "composing" });
        expect(editor.execute("edit.undo").accepted).toBe(false);
        expect(editor.undo()).toBe(false);
        editor.endComposition("각"); await settle();
        expect(doc.getTextRange(0, 0, 0, 3)).toBe("글각한");
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        expect(doc.getTextRange(0, 0, 0, 3)).not.toContain("각");
        // Only the pending HWP structural-eligibility original preflight (unanswered here) may be outstanding.
        expect(calls.filter(c => c.method !== "original")).toEqual([]);
      } finally { editor.dispose(); }
    });
    it(`${format}: insertion, replacement, stored expression prefill and explicit recalculation after source edit`, async () => {
      const { editor, doc, settle, cell } = await open(format);
      try {
        editor.caret = editor.anchor = cell(3);
        expect(editor.snapshot().parameters?.["hangul.insertTableFormula"], JSON.stringify(editor.snapshot())).toBeDefined();
        expect(insert(editor, "=SUM(A1:B1)").accepted, JSON.stringify({ at: editor.caret, fields: fields(doc), state: editor.status })).toBe(true); await settle();
        const id = fields(doc)[0]!.fieldId;
        expect(fields(doc)[0]).toMatchObject({ command: "=SUM(A1:B1)??%g,;;30", value: "30" });
        expect(insert(editor, "=SUM(A1:B1)+1").accepted).toBe(true); await settle();
        expect(fields(doc)[0]).toMatchObject({ fieldId: id, command: "=SUM(A1:B1)+1??%g,;;31", value: "31" });
        editor.anchor = cell(0); editor.caret = cell(0, 2);
        expect(editor.typeText("11")).toBe(true); await settle();
        expect(fields(doc)[0]!.value).toBe("31");
        editor.caret = editor.anchor = cell(3);
        expect(editor.snapshot().parameters?.["hangul.insertTableFormula"]?.formula).toBe("=SUM(A1:B1)+1");
        expect(insert(editor, "=SUM(A1:B1)+1").accepted).toBe(true); await settle();
        expect(fields(doc)[0]).toMatchObject({ fieldId: id, command: "=SUM(A1:B1)+1??%g,;;32", value: "32" });
        const before = bytes(doc, format);
        // B2 reading itself would grow on every explicit recalculation; refused by the session, not rewritten.
        for (const bad of ["=1+", "=A99", "=1/0", "=" + "(".repeat(17) + "1" + ")".repeat(17), "=B2+1", "=SUM(A1:B2)", "=SUM(A?:B?)"]) expect(insert(editor, bad).accepted, bad).toBe(false);
        expect(bytes(doc, format)).toEqual(before);
        const reopened = new engine.HwpDocument(before);
        try { expect(fields(reopened)).toEqual(fields(doc)); } finally { reopened.free(); }
      } finally { editor.dispose(); }
    });
  }
  it.each(["hwp", "hwpx"] as const)("large %s document beyond the legacy byte/page limits keeps bounded advanced edits and history", async format => {
    const { editor, doc, settle, cell, text, original } = await open(format, true);
    const actualSource = new Uint8Array(original);
    try {
      expect(original.byteLength).toBeGreaterThan(ADVANCED_MAX_SOURCE_BYTES);
      expect(doc.pageCount()).toBeGreaterThan(8);
      expect(bytes(doc, format)).toEqual(actualSource);
      editor.anchor = body(0, 0); editor.caret = body(2, 0);
      expect(documentCommandState("hangul.charWidth", editor.snapshot())).toEqual({ available: true });
      expect(editor.execute("hangul.charWidth", { command: "hangul.charWidth", percent: 140 }).accepted).toBe(true); await settle();
      editor.anchor = body(0, 0); editor.caret = body(2, 0);
      expect(editor.execute("hangul.charSpacing", { command: "hangul.charSpacing", percent: 10 }).accepted).toBe(true); await settle();

      const target = cell(3);
      editor.caret = editor.anchor = target;
      expect(insert(editor, "=SUM(A1:B1)").accepted).toBe(true); await settle();
      expect(fields(doc)[0]).toMatchObject({ value: "30", command: "=SUM(A1:B1)??%g,;;30" });
      editor.anchor = cell(0); editor.caret = cell(0, 2);
      expect(editor.typeText("11")).toBe(true); await settle();
      editor.caret = editor.anchor = target;
      expect(insert(editor, "=SUM(A1:B1)").accepted).toBe(true); await settle();
      expect(fields(doc)[0]).toMatchObject({ value: "31", command: "=SUM(A1:B1)??%g,;;31" });
      expect(insert(editor, "=SUM(A1:B1)+1").accepted).toBe(true); await settle();
      expect(fields(doc)[0]).toMatchObject({ value: "32", command: "=SUM(A1:B1)+1??%g,;;32" });
      const snapshots = vi.spyOn(doc, "saveSnapshot");
      const refused = bytes(doc, format), revision = editor.localRevision;
      expect(insert(editor, "=B2+1").accepted).toBe(false);
      expect(snapshots).not.toHaveBeenCalled(); snapshots.mockRestore();
      expect(bytes(doc, format)).toEqual(refused);
      expect(editor.localRevision).toBe(revision);

      // Six committed edits are retained by normal T010 history on a large
      // document; T012 does not impose the old four-step advanced-only cap.
      expect(editor.snapshot().history).toEqual({ undo: true, redo: false });
      expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
      expect(fields(doc)[0]).toMatchObject({ value: "31", command: "=SUM(A1:B1)??%g,;;31" });
      expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
      expect(fields(doc)[0]).toMatchObject({ value: "30", command: "=SUM(A1:B1)??%g,;;30" });
      expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
      expect(doc.getTextInCell!(0, editor.caret.cell!.parentParagraph, editor.caret.cell!.control, 0, 0, 0, 2)).toBe("10");
      expect(fields(doc)[0]).toMatchObject({ value: "30", command: "=SUM(A1:B1)??%g,;;30" });
      expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
      expect(fields(doc)).toHaveLength(0);
      expect(JSON.parse(doc.getCharPropertiesAt!(0, 0, 0)).spacings).toEqual(Array(7).fill(10));
      expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
      expect(JSON.parse(doc.getCharPropertiesAt!(0, 0, 0)).spacings).toEqual(Array(7).fill(0));
      expect(JSON.parse(doc.getCharPropertiesAt!(0, 0, 0)).ratios).toEqual(Array(7).fill(140));
      expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
      expect(JSON.parse(doc.getCharPropertiesAt!(0, 0, 0)).ratios).toEqual(Array(7).fill(100));
      expect(editor.snapshot().history).toEqual({ undo: false, redo: true });
      for (let index = 0; index < 6; index += 1) { expect(editor.execute("edit.redo").accepted).toBe(true); await settle(); }
      expect(fields(doc)[0]).toMatchObject({ value: "32", command: "=SUM(A1:B1)+1??%g,;;32" });

      const firstBytes = bytes(doc, format);
      emitLarge(format, 1, original, doc);
      const firstReopen = new engine.HwpDocument(firstBytes);
      try {
        expect(firstReopen.getTextRange(0, 0, 0, text.length)).toBe(text);
        expect(fields(firstReopen)).toEqual(fields(doc));
        const textSession = new RhwpText(firstReopen);
        try {
          const prepared = textSession.prepareFormula(target, 1, 1, "=SUM(A1:B1)+2");
          expect(prepared).not.toBeNull();
          textSession.insertFormula(target, 1, 1, "=SUM(A1:B1)+2", prepared!);
          expect(fields(firstReopen)[0]?.value).toBe("33");
        } finally { textSession.release(); }
        emitLarge(format, 2, firstBytes, firstReopen);
        const secondBytes = bytes(firstReopen, format);
        const secondReopen = new engine.HwpDocument(secondBytes);
        try { expect(fields(secondReopen)).toEqual(fields(firstReopen)); }
        finally { secondReopen.free(); }
      } finally { firstReopen.free(); }
      expect(actualSource).toEqual(original);
    } finally { editor.dispose(); }
  }, 120_000);

  it("formula and metric context reasons remain distinct on small documents", async () => {
    const small = await open("hwpx");
    try {
      expect(documentCommandState("hangul.insertTableFormula", small.editor.snapshot())).toEqual({ available: false, reason: "notInTable" });
      small.editor.caret = small.editor.anchor = body(0);
      expect(documentCommandState("hangul.charWidth", small.editor.snapshot())).toEqual({ available: false, reason: "selectionRequired" });
    } finally { small.editor.dispose(); }
  });
  it("engine failure after an actual metric mutation restores its before state and fails closed", async () => {
    const { editor, doc, selectBody, calls } = await open("hwpx");
    try {
      selectBody(); const before = bytes(doc, "hwpx");
      const apply = doc.applyCharFormat!.bind(doc);
      vi.spyOn(doc, "applyCharFormat").mockImplementation((...args) => { apply(...args); throw new Error("injected after actual mutation"); });
      expect(editor.execute("hangul.charWidth", { command: "hangul.charWidth", percent: 140 }).accepted).toBe(false);
      expect(bytes(doc, "hwpx")).toEqual(before);
      expect(editor.localRevision).toBe(0);
      expect(editor.hasUncertainChanges).toBe(true);
      expect(editor.status.kind).toBe("failed");
      expect((await editor.save()).ok).toBe(false);
      expect(calls.some(c => c.method === "save" || c.method === "commit")).toBe(false);
    } finally { editor.dispose(); }
  });
  it("a discard trap while new input invalidates the Redo branch fails closed and blocks saving", async () => {
    const { editor, doc, selectBody, settle, calls } = await open("hwp");
    try {
      selectBody(); expect(editor.execute("hangul.charWidth", { command: "hangul.charWidth", percent: 140 }).accepted).toBe(true); await settle();
      expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
      expect(editor.snapshot().history?.redo).toBe(true);
      editor.caret = editor.anchor = body(0);
      const discard = doc.discardSnapshot.bind(doc);
      vi.spyOn(doc, "discardSnapshot").mockImplementation(id => { discard(id); throw new Error("injected after actual discard"); });
      editor.typeText("한");
      expect(editor.status.kind).toBe("failed");
      expect(editor.hasUncertainChanges).toBe(true);
      expect(editor.snapshot().history).toBeNull();
      expect(editor.execute("edit.redo").accepted).toBe(false);
      expect((await editor.save()).ok).toBe(false);
      expect(calls.some(c => c.method === "save")).toBe(false);
    } finally { editor.dispose(); }
  });
  it("history allocation trap refuses the advanced mutation and blocks saving an uncertain model", async () => {
    const { editor, doc, selectBody, calls } = await open("hwpx");
    try {
      selectBody(); const before = bytes(doc, "hwpx");
      vi.spyOn(doc, "saveSnapshot").mockImplementation(() => { throw new Error("injected allocation trap"); });
      expect(editor.execute("hangul.charWidth", { command: "hangul.charWidth", percent: 140 }).accepted).toBe(false);
      expect(bytes(doc, "hwpx")).toEqual(before);
      expect(editor.status.kind).toBe("failed");
      expect(editor.hasUncertainChanges).toBe(true);
      expect((await editor.save()).ok).toBe(false);
      expect(calls.some(c => c.method === "save")).toBe(false);
    } finally { editor.dispose(); }
  });
});
