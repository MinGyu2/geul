// @vitest-environment jsdom
// Real generated WASM, typed session transaction/history boundary. Not native UI proof.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "../../src/components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";
import { commandDefinition } from "../../src/commands/registry";

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
const exports = engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const enabled = commandDefinition("hangul.insertTableFormula")?.engines?.rhwp.level === "supported";
const at = { section: 0, paragraph: 0, offset: 0, cell: { parentParagraph: 0, control: 0, cell: 3, cellParagraph: 0 } };
const fields = (doc: RhwpDocument) => JSON.parse((doc as RhwpDocument & { getFieldList(): string }).getFieldList());
const bytes = (doc: RhwpDocument, format: "hwp" | "hwpx") => {
  const report = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
  try { return report.takeBytes(); } finally { report.free(); }
};
async function open(format: "hwp" | "hwpx", rows = 2, cols = 2, merged = false) {
  const seed = engine.HwpDocument.createEmpty();
  seed.createBlankDocument();
  const placed = JSON.parse(seed.createTable(0, 0, 0, rows, cols));
  seed.insertTextInCell(0, placed.paraIdx, placed.controlIdx, 0, 0, 0, "10");
  seed.insertTextInCell(0, placed.paraIdx, placed.controlIdx, 1, 0, 0, "20");
  if (merged) seed.mergeTableCells(0, placed.paraIdx, placed.controlIdx, 0, 0, 0, 1);
  const original = bytes(seed, format); seed.free();
  const { backend, take, calls } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open(`/a.${format}`); take("open").reply(ok({ ...base, format })); await opening;
  let doc!: RhwpDocument;
  let memoryFault = false;
  const module: RhwpModule = { openDocument: b => (doc = new engine.HwpDocument(b)), memoryBytes: () => memoryFault ? NaN : exports.memory.buffer.byteLength };
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module);
  const loading = editor.load(); take("load").reply(loaded(original)); await flush();
  take("session").reply(ok(info({ format, state: "loading", sequence: 1, loadGeneration: 1 })));
  take("setState").reply(ok(info({ format, state: "ready", sequence: 2, loadGeneration: 1 }))); await loading;
  const control = JSON.parse((doc as RhwpDocument & { getControls(): string }).getControls()).find((c: { ctrlId: string }) => c.ctrlId === "tbl").controlIndex;
  editor.caret = editor.anchor = { ...at, cell: { ...at.cell, control } };
  let sequence = 2;
  const settle = async () => {
    await flush();
    while (calls.some(c => c.method === "commit")) {
      const call = take("commit");
      const revision = Number(call.args[2]) + Number(call.args[3]);
      call.reply(ok(info({ format, state: "ready", loadGeneration: 1, sequence: ++sequence, revision, dirty: true })));
      await flush();
    }
  };
  let disk = original;
  const beginSave = async () => {
    const uneditedDoc = new engine.HwpDocument(disk);
    let unedited: Uint8Array, uneditedLoss: unknown;
    try { const e = format === "hwp" ? uneditedDoc.exportHwpWithReport() : uneditedDoc.exportHwpxWithReport();
      try { uneditedLoss = JSON.parse(e.contentLoss()); unedited = e.takeBytes(); } finally { e.free(); }
    } finally { uneditedDoc.free(); }
    const saving = editor.save();
    if (calls.some(c => c.method === "original")) {
      take("original").reply(ok(disk)); await flush();
      take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true })); await flush();
    }
    const request = take("save");
    const output = request.args[3] as Uint8Array;
    const result = { original: disk, unedited: unedited!, uneditedLoss: uneditedLoss!, output, outputLoss: request.args[4], reopen: request.args[5] };
    return { result, request, saving, finish: async (durable = true, failure = false) => {
      request.reply(failure ? { ok: false, error: { code: "SaveFailure", stage: "write" } } : ok({
        session: info({ format, state: "ready", loadGeneration: 1, sequence: ++sequence,
          revision: editor.localRevision, dirty: editor.localRevision !== Number(request.args[2]) || !durable }),
        bytes: output.length, durable,
      }));
      const response = await saving;
      expect(response.ok).toBe(!failure);
      if (!failure) disk = output;
      return result;
    } };
  };
  const save = async () => {
    const pending = await beginSave();
    return pending.finish();
  };
  return { editor, doc, sessions, calls, take, settle, save, beginSave, fault: () => { memoryFault = true; } };
}
const insert = (editor: RhwpEditorSession, formula: string) => editor.execute("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula });

describe.runIf(enabled)("persistent formula typed commands with actual Release WASM", () => {
  it.each(["hwp", "hwpx"] as const)("%s: create/replace, undo/redo/new edit, invalid refusal, reopen", async format => {
    const { editor, doc, settle, sessions } = await open(format);
    try {
      expect(insert(editor, "=SUM(A1:B1)").accepted).toBe(true); await settle();
      expect(fields(doc)).toMatchObject([{ command: "=SUM(A1:B1)??%g,;;30", value: "30" }]);
      const revision = editor.localRevision;
      const snapshot = bytes(doc, format), backend = sessions.get(1);
      for (const formula of ["=SUM", "=SUM()", "=1/0", "=SUM(A1:Z999)", "=IF(1,2,A9)", "=1+", "=SUM(A1,,B1)"]) {
        expect(insert(editor, formula).accepted, formula).toBe(false);
        expect(bytes(doc, format)).toEqual(snapshot);
        expect(editor.localRevision).toBe(revision);
        expect(sessions.get(1)).toEqual(backend);
        expect(editor.snapshot().history).toEqual({ undo: true, redo: false });
      }
      expect(insert(editor, "=SUM(A1:B1)").accepted).toBe(true);
      expect(editor.localRevision).toBe(revision); // exact no-op has no dirty/history step
      expect(insert(editor, "=1+2").accepted).toBe(true); await settle();
      expect(fields(doc)[0].value).toBe("3");
      expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
      expect(fields(doc)[0].value).toBe("30");
      expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
      expect(fields(doc)[0].value).toBe("3");
      expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
      expect(insert(editor, "=A1*2").accepted).toBe(true); await settle();
      expect(editor.snapshot().history).toEqual({ undo: true, redo: false });
      const reopened = new engine.HwpDocument(bytes(doc, format));
      try {
        expect(fields(reopened)).toEqual(fields(doc));
        reopened.insertTableFormulaField(0, 0, editor.caret.cell!.control, 1, 1, "=A1*3");
        const twice = new engine.HwpDocument(bytes(reopened, format));
        try { expect(fields(twice)[0]).toMatchObject({ command: "=A1*3??%g,;;30", value: "30" }); }
        finally { twice.free(); }
      } finally { reopened.free(); }
      editor.beginComposition(); editor.updateComposition("한");
      const before = editor.localRevision;
      expect(insert(editor, "=1+2").accepted).toBe(false);
      expect(editor.localRevision).toBe(before);
    } finally { editor.dispose(); }
  });
  it("refuses before mutation when required history measurement fails", async () => {
    const { editor, doc, fault } = await open("hwpx");
    try {
      const before = bytes(doc, "hwpx"); fault();
      expect(insert(editor, "=1+2").accepted).toBe(false);
      expect(bytes(doc, "hwpx")).toEqual(before);
      expect(editor.localRevision).toBe(0);
      expect(editor.hasUnpreservedChanges).toBe(false);
      expect(editor.hasUncertainChanges).toBe(false);
      expect(editor.snapshot().history).toBeNull();
    } finally { editor.dispose(); }
  });
});


describe.runIf(commandDefinition("hangul.charWidth")?.engines?.rhwp.level === "supported")("metrics after publication", () => {
  it.each(["hwp", "hwpx"] as const)("%s keeps published shape IDs for a second save in the same session", async format => {
    const { editor, doc, settle, save } = await open(format);
    const cell = { ...editor.caret.cell!, cell: 0 };
    const select = () => { editor.anchor = { ...at, cell, offset: 0 }; editor.caret = { ...at, cell, offset: 1 }; };
    try {
      select(); expect(editor.execute("hangul.charWidth", { command: "hangul.charWidth", percent: 150 }).accepted).toBe(true); await settle();
      const first = await save();
      select(); expect(editor.execute("hangul.charSpacing", { command: "hangul.charSpacing", percent: 10 }).accepted).toBe(true); await settle();
      const second = await save();
      expect(editor.hasUnpreservedChanges).toBe(false);
      expect(editor.hasUncertainChanges).toBe(false);
      const folder = process.env.GEUL_POSTSAVE_OUT;
      if (folder) {
        mkdirSync(folder, { recursive: true });
        const cases = [first, second].map((result, i) => {
          const stem = join(folder, `${format}-${i}`);
          writeFileSync(stem + ".original", result.original);
          writeFileSync(stem + ".unedited", result.unedited);
          writeFileSync(stem + ".unedited.loss.json", JSON.stringify(result.uneditedLoss));
          writeFileSync(stem + ".output", result.output);
          writeFileSync(stem + ".output.loss.json", JSON.stringify(result.outputLoss));
          return { name: `${format}-${i}`, fmt: format, mode: "save", unedited: stem + ".unedited", uneditedLoss: stem + ".unedited.loss.json", output: stem + ".output", outputLoss: stem + ".output.loss.json", reopen: result.reopen };
        });
        writeFileSync(join(folder, `${format}-cases.json`), JSON.stringify(cases));
      }
      // An older snapshot keeps its own table. A new format must never trap
      // merely because the protected publication prefix is now longer.
      expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
      select(); expect(editor.execute("hangul.charWidth", { command: "hangul.charWidth", percent: 180 }).accepted).toBe(true); await settle();
      expect(editor.hasUncertainChanges).toBe(false);
      expect(editor.status.kind).toBe("ready");
      expect(bytes(doc, format).length).toBeGreaterThan(0);
    } finally { editor.dispose(); }
  });
});


describe.runIf(commandDefinition("hangul.charWidth")?.engines?.rhwp.level === "supported")("in-flight metric publication", () => {
  it.each(["hwp", "hwpx"] as const)("%s protects exported IDs during later width/spacing and a second save", async format => {
    const { editor, doc, settle, beginSave, save } = await open(format);
    const cell = { ...editor.caret.cell!, cell: 0 };
    const metric = async (command: "hangul.charWidth" | "hangul.charSpacing", percent: number) => {
      editor.anchor = { ...at, cell, offset: 0 }; editor.caret = { ...at, cell, offset: 1 };
      expect(editor.execute(command, { command, percent }).accepted).toBe(true); await settle();
    };
    try {
      await metric("hangul.charWidth", 150);
      const count = doc.charShapeCount!();
      const first = await beginSave();
      await metric("hangul.charWidth", 160);
      await metric("hangul.charSpacing", 10);
      // The exported width=150 definition has no live reference now, but is owned by the pending publication.
      expect(doc.charShapeCount!()).toBeGreaterThan(count);
      await first.finish();
      expect(editor.saveState).toMatchObject({ kind: "saved", changedSince: true });
      expect(editor.hasUnpreservedChanges).toBe(true);
      await metric("hangul.charSpacing", 20);
      expect(doc.charShapeCount!()).toBeGreaterThan(count);
      const second = await save();
      expect(editor.hasUnpreservedChanges).toBe(false);
      const folder = process.env.GEUL_RACE_OUT;
      if (folder) {
        mkdirSync(folder, { recursive: true });
        const cases = [first.result, second].map((result, i) => {
          const stem = join(folder, `${format}-${i}`);
          for (const [suffix, value] of [["original", result.original], ["unedited", result.unedited], ["output", result.output]] as const)
            writeFileSync(stem + "." + suffix, value);
          writeFileSync(stem + ".unedited.loss.json", JSON.stringify(result.uneditedLoss));
          writeFileSync(stem + ".output.loss.json", JSON.stringify(result.outputLoss));
          return { name: `${format}-${i}`, fmt: format, mode: "save", original: stem + ".original",
            unedited: stem + ".unedited", uneditedLoss: stem + ".unedited.loss.json", output: stem + ".output", outputLoss: stem + ".output.loss.json", reopen: result.reopen };
        });
        writeFileSync(join(folder, `${format}-cases.json`), JSON.stringify(cases));
      }
    } finally { editor.dispose(); }
  });
});


describe.runIf(enabled)("pending publication transitions", () => {
  const operations = ["none", "width", "spacing", "width-spacing", "undo", "redo", "formula", "failure", "non-durable", "stale-load", "stale-session", "close", "switch"] as const;
  for (const format of ["hwp", "hwpx"] as const) it.each(operations)(`${format}: %s`, async operation => {
    const { editor, doc, settle, beginSave, save, sessions, take } = await open(format);
    const formulaAt = editor.caret;
    const cell = { ...formulaAt.cell!, cell: 0 };
    const metric = async (command: "hangul.charWidth" | "hangul.charSpacing", percent: number) => {
      editor.anchor = { ...at, cell, offset: 0 }; editor.caret = { ...at, cell, offset: 1 };
      expect(editor.execute(command, { command, percent }).accepted).toBe(true); await settle();
    };
    try {
      await metric("hangul.charWidth", 150);
      if (operation === "redo") { expect(editor.redo()).toBe(false); expect(editor.undo()).toBe(true); await settle(); }
      const pending = await beginSave();
      const count = doc.charShapeCount!();
      if (["width", "width-spacing", "failure", "non-durable"].includes(operation)) await metric("hangul.charWidth", 160);
      if (["spacing", "width-spacing"].includes(operation)) await metric("hangul.charSpacing", 10);
      if (operation === "undo") { expect(editor.undo()).toBe(true); await settle(); }
      if (operation === "redo") { expect(editor.redo()).toBe(true); await settle(); }
      if (operation === "formula") { editor.caret = editor.anchor = formulaAt; expect(insert(editor, "=1+2").accepted).toBe(true); await settle(); }
      if (operation === "close") {
        editor.dispose();
        const state = editor.saveState;
        await pending.finish();
        expect(editor.status.kind).toBe("closed"); expect(editor.saveState).toEqual(state);
        return;
      }
      if (operation === "stale-load" || operation === "stale-session") {
        pending.request.reply({ ok: false, error: operation === "stale-load"
          ? { code: "StaleLoad", sessionId: 1, loadGeneration: 1 } : { code: "StaleSession", sessionId: 1 } });
        expect((await pending.saving).ok).toBe(false);
        await metric("hangul.charSpacing", 10);
        expect(doc.charShapeCount!()).toBe(count); // failed publication did not become a permanent prefix
        return;
      }
      if (operation === "switch") {
        const opening = sessions.open(`/other.${format}`);
        take("open").reply(ok({ ...base, sessionId: 2, format })); await opening;
        expect(sessions.snapshot().activeId).toBe(2);
      }
      await pending.finish(operation !== "non-durable", operation === "failure");
      expect(editor.hasUncertainChanges).toBe(false);
      if (operation === "failure") {
        await metric("hangul.charSpacing", 10);
        expect(doc.charShapeCount!()).toBe(count); // release failed publication's protection
      } else {
        expect(editor.saveState).toMatchObject({ kind: "saved", changedSince: !["none", "switch"].includes(operation) });
        expect(editor.hasUnpreservedChanges).toBe(!["none", "switch"].includes(operation));
      }
      // Undo restores a pre-publication table: second-save reconciliation is Work B2.
      if (operation !== "undo" && operation !== "redo") {
        await save(); expect(editor.hasUnpreservedChanges).toBe(false);
      }
    } finally { editor.dispose(); }
  });
});

function recordHistorySaves(format: "hwp" | "hwpx", scenario: string, results: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["save"]>>[]) {
  const folder = process.env.GEUL_HISTORY_SAVE_OUT;
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  const cases = results.map((result, i) => {
    const stem = join(folder, `${format}-${scenario}-${i}`);
    for (const [suffix, value] of [["original", result.original], ["unedited", result.unedited], ["output", result.output]] as const)
      writeFileSync(stem + "." + suffix, value);
    writeFileSync(stem + ".unedited.loss.json", JSON.stringify(result.uneditedLoss));
    writeFileSync(stem + ".output.loss.json", JSON.stringify(result.outputLoss));
    return { name: `${format}-${scenario}-${i}`, fmt: format, mode: "save", original: stem + ".original",
      unedited: stem + ".unedited", uneditedLoss: stem + ".unedited.loss.json", output: stem + ".output", outputLoss: stem + ".output.loss.json", reopen: result.reopen };
  });
  writeFileSync(join(folder, `${format}-${scenario}-cases.json`), JSON.stringify(cases));
}

describe.runIf(enabled)("pre-publication history", () => {
  it.each(["hwp", "hwpx"] as const)("%s restores the published definitions while preserving Undo's formatting", async format => {
    const { editor, doc, settle, save } = await open(format);
    const cell = { ...editor.caret.cell!, cell: 0 };
    const select = () => { editor.anchor = { ...at, cell, offset: 0 }; editor.caret = { ...at, cell, offset: 1 }; };
    try {
      select(); expect(editor.execute("hangul.charWidth", { command: "hangul.charWidth", percent: 150 }).accepted).toBe(true); await settle();
      const count = doc.charShapeCount!();
      const first = await save();
      expect(editor.undo()).toBe(true); await settle();
      const second = await save();
      recordHistorySaves(format, "A", [first, second]);
      expect(doc.charShapeCount!()).toBeGreaterThanOrEqual(count);
      expect(JSON.parse(doc.getCellCharPropertiesAt!(0, 0, cell.control, 0, 0, 0)).ratios).toEqual(Array(7).fill(100));
      expect(editor.snapshot().history).toEqual({ undo: false, redo: true });
    } finally { editor.dispose(); }
  });
});

describe.runIf(enabled)("publication-aware history branches", () => {
  for (const format of ["hwp", "hwpx"] as const) it.each(["B", "C", "D", "E", "F", "G", "H", "in-flight-branch"] as const)(`${format}: %s`, async scenario => {
    const { editor, doc, settle, save, beginSave } = await open(format);
    const cell = { ...editor.caret.cell!, cell: 0 };
    const select = () => { editor.anchor = { ...at, cell, offset: 0 }; editor.caret = { ...at, cell, offset: 1 }; };
    const metric = async (command: "hangul.charWidth" | "hangul.charSpacing", percent: number) => {
      select(); expect(editor.execute(command, { command, percent }).accepted).toBe(true); await settle();
    };
    const travel = async (direction: "undo" | "redo") => { expect(editor[direction]()).toBe(true); await settle(); };
    const results: Awaited<ReturnType<typeof save>>[] = [];
    const publish = async (width: number, spacing: number) => {
      const result = await save(); results.push(result);
      const reopened = new engine.HwpDocument(result.output);
      try {
        const properties = JSON.parse(reopened.getCellCharPropertiesAt(0, 0, cell.control, 0, 0, 0));
        expect(properties.ratios).toEqual(Array(7).fill(width));
        expect(properties.spacings).toEqual(Array(7).fill(spacing));
        expect(reopened.getTextFileText()).toBe((doc as RhwpDocument & { getTextFileText(): string }).getTextFileText());
      } finally { reopened.free(); }
      expect(editor.hasUnpreservedChanges).toBe(false);
      expect(editor.hasUncertainChanges).toBe(false);
    };
    try {
      await metric("hangul.charWidth", 150);
      if (scenario === "B" || scenario === "H") await metric("hangul.charSpacing", 10);
      if (scenario === "in-flight-branch") {
        const pending = await beginSave();
        await travel("undo"); await metric("hangul.charWidth", 180);
        results.push(await pending.finish());
        expect(editor.hasUnpreservedChanges).toBe(true);
        await publish(180, 0);
      } else {
        await publish(150, scenario === "B" || scenario === "H" ? 10 : 0);
        if (scenario === "G") { await metric("hangul.charWidth", 160); await publish(160, 0); }
        await travel("undo");
        if (scenario === "C") await travel("redo");
        if (scenario === "D") await metric("hangul.charWidth", 180);
        if (scenario === "E") {
          editor.caret = editor.anchor = { ...at, cell, offset: 0 };
          expect(editor.typeText("가")).toBe(true); await settle();
        }
        if (scenario === "F") {
          const pending = await beginSave(); await pending.finish(true, true);
          expect(editor.hasUnpreservedChanges).toBe(true);
          await travel("redo");
        }
        const width = scenario === "D" ? 180 : ["B", "C", "F", "G", "H"].includes(scenario) ? 150 : 100;
        await publish(width, 0);
        if (scenario === "G" || scenario === "H") {
          await travel("undo"); await publish(100, 0);
          await travel("redo"); await publish(150, 0);
        }
      }
      // A new branch after any publication still preserves its intended state and serializes safely.
      await metric("hangul.charWidth", 190); await publish(190, 0);
      expect(editor.snapshot().history?.redo).toBe(false);
      recordHistorySaves(format, scenario, results);
    } finally { editor.dispose(); }
  });
});


describe("formula reliability with the selected Release WASM", () => {
  it.each(["hwp", "hwpx"] as const)("%s: LOG10 calculates, refuses invalid inputs atomically, and survives reopen", async format => {
    const { editor, doc, settle, sessions } = await open(format);
    try {
      for (const [formula, expected] of [["=LOG10(100)", "2"], ["=LOG10(A1)", "1"], ["=LOG(1)", "0"], ["=SUM(A1:B1)", "30"]]) {
        expect(insert(editor, formula!).accepted, formula).toBe(true); await settle();
        expect(fields(doc)[0]).toMatchObject({ value: expected });
        const revision = editor.localRevision;
        expect(insert(editor, formula!).accepted).toBe(true); await settle();
        expect(editor.localRevision).toBe(revision); // stable explicit recalculation
        const reopened = new engine.HwpDocument(bytes(doc, format));
        try { expect(fields(reopened)).toEqual(fields(doc)); } finally { reopened.free(); }
      }
      const before = bytes(doc, format), revision = editor.localRevision;
      const session = sessions.get(1), history = editor.snapshot().history;
      for (const formula of ["=LOG10(", "=LOG10()", "=LOG10(A1", "=LOG10(A1,B1)", "=NOPE(1)", "=C1", "=B2", "=SUM(A1:B2)"]) {
        expect(insert(editor, formula).accepted, formula).toBe(false);
        expect(bytes(doc, format)).toEqual(before);
        expect(editor.localRevision).toBe(revision);
        expect(sessions.get(1)).toEqual(session);
        expect(editor.snapshot().history).toEqual(history);
      }
    } finally { editor.dispose(); }
  });

});


describe.each(["hwp", "hwpx"] as const)("bounded persistent dependencies (%s)", format => {
  async function fixture(merged = false) {
    const ctx = await open(format, 2, 3, merged);
    const select = (cell: number) => { ctx.editor.caret = ctx.editor.anchor = { ...at, cell: { ...ctx.editor.caret.cell!, cell } }; };
    const apply = async (cell: number, formula: string) => {
      select(cell); expect(insert(ctx.editor, formula).accepted, formula).toBe(true); await ctx.settle();
    };
    const refuse = (cell: number, formula: string) => {
      select(cell);
      const before = bytes(ctx.doc, format), revision = ctx.editor.localRevision, session = ctx.sessions.get(1);
      const history = ctx.editor.snapshot().history, dirty = ctx.editor.hasUnpreservedChanges;
      const snapshot = vi.spyOn(ctx.doc, "saveSnapshot"), free = vi.spyOn(ctx.doc, "free");
      try {
        expect(insert(ctx.editor, formula).accepted, formula).toBe(false);
        expect(bytes(ctx.doc, format)).toEqual(before);
        expect(ctx.editor.localRevision).toBe(revision); expect(ctx.sessions.get(1)).toEqual(session);
        expect(ctx.editor.snapshot().history).toEqual(history); expect(snapshot).not.toHaveBeenCalled();
        expect(ctx.editor.hasUnpreservedChanges).toBe(dirty); expect(ctx.editor.hasUncertainChanges).toBe(false);
        expect(ctx.editor.status.kind).toBe("ready"); expect(free).not.toHaveBeenCalled();
        expect(ctx.calls.some(c => c.method === "commit" || c.method === "save")).toBe(false);
      } finally { snapshot.mockRestore(); free.mockRestore(); }
    };
    return { ...ctx, select, apply, refuse };
  }
  it.each([
    [[[0, "=B1+1"]], 1, "=A1+1"],
    [[[0, "=B1+1"], [1, "=C1+1"]], 2, "=A1+1"],
    [[[0, "=SUM(B1:C1)"]], 2, "=A1+1"],
    [[[0, "=B1+1"], [1, "=2"]], 1, "=A1+1"],
    [[[0, "=SUM(RIGHT)"]], 1, "=SUM(LEFT)"],
    [[[0, "=SUM(B?:C?)"]], 2, "=A?+1"],
    [[[0, "=?2+1"]], 3, "=?1+1"],
    [[[0, "=SUM(A2:C2)"]], 3, "=SUM(ABOVE)"],
  ] as const)("refuses closing edges %j -> %s", async (setup, destination, formula) => {
    const ctx = await fixture();
    try { for (const [cell, expression] of setup) await ctx.apply(cell, expression); ctx.refuse(destination, formula); }
    finally { ctx.editor.dispose(); }
  });
  it("keeps direct self-reference refused with no history or document change", async () => {
    const ctx = await fixture();
    try { for (const formula of ["=A1", "=?1", "=A?", "=SUM(C2:A1)"]) ctx.refuse(0, formula); }
    finally { ctx.editor.dispose(); }
  });
  it("supports acyclic replacement, stable recalculation, undo/redo and two exports/reopens", async () => {
    const ctx = await fixture();
    try {
      await ctx.apply(0, "=B1+1"); await ctx.apply(1, "=C1+1"); await ctx.apply(2, "=2");
      // Recalculate in dependency order: C1=2, B1=3, A1=4.
      await ctx.apply(1, "=C1+1"); await ctx.apply(0, "=B1+1");
      expect(fields(ctx.doc).map((f: { value: string }) => f.value)).toEqual(["4", "3", "2"]);
      const revision = ctx.editor.localRevision;
      for (let i = 0; i < 3; i++) { await ctx.apply(1, "=C1+1"); await ctx.apply(0, "=B1+1"); }
      expect(ctx.editor.localRevision).toBe(revision);
      await ctx.apply(1, "=5"); await ctx.apply(0, "=B1+1");
      expect(fields(ctx.doc).map((f: { value: string }) => f.value)).toEqual(["6", "5", "2"]);
      expect(ctx.editor.execute("edit.undo").accepted).toBe(true); await ctx.settle();
      expect(fields(ctx.doc)[0].value).toBe("4");
      expect(ctx.editor.execute("edit.redo").accepted).toBe(true); await ctx.settle();
      expect(fields(ctx.doc)[0].value).toBe("6");
      const reopened = new engine.HwpDocument(bytes(ctx.doc, format));
      try {
        expect(fields(reopened)).toEqual(fields(ctx.doc));
        const { RhwpText } = await import("../../src/components/Editor/rhwp/rhwpText");
        const text = new RhwpText(reopened), position = { ...at, cell: { ...ctx.editor.caret.cell!, cell: 0 } };
        const prepared = text.prepareFormula(position, 0, 0, "=B1+2"); expect(prepared).not.toBeNull();
        text.insertFormula(position, 0, 0, "=B1+2", prepared!);
        const second = new engine.HwpDocument(bytes(reopened, format));
        try { expect(fields(second)).toEqual(fields(reopened)); expect(fields(second)[0]).toMatchObject({ fieldId: fields(ctx.doc)[0].fieldId, command: "=B1+2??%g,;;7", value: "7" }); }
        finally { second.free(); }
      } finally { reopened.free(); }
    } finally { ctx.editor.dispose(); }
  });
  it.each(["missing", "malformed", "encoding", "nested", "duplicate", "location"])("fails closed for %s field metadata", async mode => {
    const ctx = await fixture();
    try {
      await ctx.apply(0, "=B1+1");
      const original = ctx.doc.getFieldList!();
      const data = JSON.parse(original);
      if (mode === "encoding") data[0].command = "=B1+1??%.2f,;;21";
      if (mode === "nested") data[0].location.path.push({ type: "cell", controlIndex: 0, cellIndex: 0, paraIndex: 0 });
      if (mode === "duplicate") data.push(data[0]);
      if (mode === "location") delete data[0].location;
      const spy = vi.spyOn(ctx.doc, "getFieldList").mockReturnValue(mode === "missing" ? "[]" : mode === "malformed" ? "{" : JSON.stringify(data));
      try { ctx.refuse(1, "=A1+1"); } finally { spy.mockRestore(); }
      expect(ctx.doc.getFieldList!()).toBe(original);
    } finally { ctx.editor.dispose(); }
  });
  it("fails closed for an actual engine-merged table", async () => {
    const ctx = await fixture(true);
    try { ctx.refuse(3, "=2"); } finally { ctx.editor.dispose(); }
  });
  it("refuses merged or incomplete geometry rather than assuming row-major ownership", async () => {
    const ctx = await fixture();
    try {
      const original = ctx.doc.getCellInfo!.bind(ctx.doc);
      const spy = vi.spyOn(ctx.doc, "getCellInfo").mockImplementation((...args) => JSON.stringify({ ...JSON.parse(original(...args)), colSpan: 2 }));
      try { ctx.refuse(0, "=B1+1"); } finally { spy.mockRestore(); }
    } finally { ctx.editor.dispose(); }
  });
});
