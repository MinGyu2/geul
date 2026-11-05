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
  const save = async () => {
    const uneditedDoc = new engine.HwpDocument(disk);
    let unedited: Uint8Array, uneditedLoss: unknown;
    try { const e = format === "hwp" ? uneditedDoc.exportHwpWithReport() : uneditedDoc.exportHwpxWithReport();
      try { uneditedLoss = JSON.parse(e.contentLoss()); unedited = e.takeBytes(); } finally { e.free(); }
    } finally { uneditedDoc.free(); }
    const saving = editor.save(); take("original").reply(ok(disk)); await flush();
    take("preflight").reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true })); await flush();
    const request = take("save");
    const output = request.args[3] as Uint8Array;
    const result = { original: disk, unedited: unedited!, uneditedLoss: uneditedLoss!, output, outputLoss: request.args[4], reopen: request.args[5] };
    request.reply(ok({ session: info({ format, state: "ready", loadGeneration: 1, sequence: ++sequence, revision: editor.localRevision, dirty: false }), bytes: output.length, durable: true }));
    expect((await saving).ok).toBe(true); disk = output;
    return result;
  };
  return { editor, doc, sessions, calls, settle, save, fault: () => { memoryFault = true; } };
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
