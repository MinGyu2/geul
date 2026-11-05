// @vitest-environment jsdom
// Real generated WASM, typed session transaction/history boundary. Not native UI proof.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
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
async function open(format: "hwp" | "hwpx") {
  const seed = engine.HwpDocument.createEmpty();
  seed.createBlankDocument();
  const placed = JSON.parse(seed.createTable(0, 0, 0, 2, 2));
  seed.insertTextInCell(0, placed.paraIdx, placed.controlIdx, 0, 0, 0, "10");
  seed.insertTextInCell(0, placed.paraIdx, placed.controlIdx, 1, 0, 0, "20");
  const original = bytes(seed, format); seed.free();
  const { backend, take, calls } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open(`/a.${format}`); take("open").reply(ok({ ...base, format })); await opening;
  let doc!: RhwpDocument;
  let memoryFault = false;
  const module: RhwpModule = { openDocument: b => (doc = new engine.HwpDocument(b)), memoryBytes: () => memoryFault ? NaN : exports.memory.buffer.byteLength };
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module, { history: true });
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
          ? { code: "StaleLoad", sessionId: 1, generation: 1 } : { code: "StaleSession", sessionId: 1 } });
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
