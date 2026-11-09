// @vitest-environment jsdom
// Actual approved Release WASM. Backend commit replies are controlled here;
// real native T009 publication is covered separately by native-clipboard.py.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import { RhwpText } from "../../src/components/Editor/rhwp/rhwpText";
import type { RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const exported = (d: RhwpDocument, format: "hwp" | "hwpx") => {
  const e = format === "hwp" ? d.exportHwpWithReport() : d.exportHwpxWithReport();
  try { return e.takeBytes(); } finally { e.free(); }
};
const paragraphs = (d: RhwpDocument) => Array.from({ length: d.getParagraphCount(0) }, (_, p) => d.getTextRange(0, p, 0, d.getParagraphLength(0, p)));
async function open(format: "hwp" | "hwpx") {
  const seed = engine.HwpDocument.createEmpty(); seed.createBlankDocument(); seed.insertText(0, 0, 0, "원본");
  const bytes = exported(seed, format); seed.free();
  const { backend, take, calls } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open(`/a.${format}`); take("open").reply(ok({ ...base, format })); await opening;
  let doc!: RhwpDocument;
  const editor = new RhwpEditorSession(1, backend, sessions, async () => ({ openDocument: b => (doc = new engine.HwpDocument(b)) }));
  const loading = editor.load(); take("load").reply(loaded(bytes)); await flush();
  take("session").reply(ok(info({ format, state: "loading", sequence: 1 })));
  take("setState").reply(ok(info({ format, state: "ready", sequence: 2 }))); await loading;
  let sequence = 2;
  const settle = async () => {
    await flush();
    while (calls.some(c => c.method === "commit")) {
      const call = take("commit"); call.reply(ok(info({ format, state: "ready", revision: Number(call.args[2]) + Number(call.args[3]), dirty: true, sequence: ++sequence })));
      await flush();
    }
  };
  return { editor, doc, settle };
}
for (const format of ["hwp", "hwpx"] as const) describe(`clipboard actual ${format.toUpperCase()} WASM`, () => {
  it("replaces selection, splits CRLF/LF/CR into real paragraphs; full copy, cut and independent reopen", async () => {
    const { editor, doc, settle } = await open(format);
    try {
      editor.caret = { section: 0, paragraph: 0, offset: 2 };
      const text = "한😀글".repeat(220) + "\r\n둘\t셋\r끝\n";
      const expected = text.replace(/\r\n?/g, "\n").split("\n");
      let copied = "";
      const clip = { readText: async () => text, writeText: async (value: string) => { copied = value; } };
      expect(await editor.executeClipboard("edit.paste", () => true, clip)).toBe(true); await settle();
      expect(paragraphs(doc)).toEqual(expected); expect(editor.localRevision).toBe(1);
      editor.anchor = { section: 0, paragraph: 0, offset: 0 };
      expect(await editor.executeClipboard("edit.copy", () => true, clip)).toBe(true);
      expect(copied).toBe(expected.join("\n")); expect(editor.localRevision).toBe(1);
      const reopened = new engine.HwpDocument(exported(doc, format));
      try { expect(paragraphs(reopened)).toEqual(expected); } finally { reopened.free(); }
      expect(await editor.executeClipboard("edit.cut", () => true, clip)).toBe(true); await settle();
      expect(paragraphs(doc)).toEqual([""]); expect(editor.localRevision).toBe(2);
      const cut = new engine.HwpDocument(exported(doc, format));
      try { expect(paragraphs(cut)).toEqual([""]); } finally { cut.free(); }
    } finally { editor.dispose(); }
  });
  it("reads cell text across paragraphs and refuses a body selection spanning a table", () => {
    const doc = engine.HwpDocument.createEmpty(); doc.createBlankDocument();
    const table = JSON.parse(doc.createTable(0, 0, 0, 1, 1));
    doc.insertTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, "한😀");
    doc.splitParagraphInCell(0, table.paraIdx, table.controlIdx, 0, 0, 2);
    doc.insertTextInCell(0, table.paraIdx, table.controlIdx, 0, 1, 0, "글끝");
    const reopened = new engine.HwpDocument(exported(doc, format)); doc.free();
    const text = new RhwpText(reopened);
    try {
      const cell = { parentParagraph: table.paraIdx, control: table.controlIdx, cell: 0, cellParagraph: 0 };
      const a = { section: 0, paragraph: table.paraIdx, offset: 1, cell };
      const b = { ...a, cell: { ...cell, cellParagraph: 1 } };
      expect(text.selectedText(a, b)).toBe("😀\n글"); expect(text.selectedText(b, a)).toBe("😀\n글");
      expect(text.selectedText({ section: 0, paragraph: 0, offset: 0 }, { section: 0, paragraph: reopened.getParagraphCount(0) - 1, offset: 0 })).toBeNull();
    } finally { text.release(); reopened.free(); }
  });
});
