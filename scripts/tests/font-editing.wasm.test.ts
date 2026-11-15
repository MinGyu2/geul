// Actual authenticated Release engine + independent Rust T009 checker.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { documentFontTable } from "../../src/components/Editor/rhwp/rhwpFonts";
import { HWP_TABLE_NORMALIZATION } from "../../src/components/Editor/rhwp/hwpReopenModel";
import { RhwpText } from "../../src/components/Editor/rhwp/rhwpText";
import { DocumentSessions } from "../../src/adapters/sessions";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import { base, controlledBackend, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";
import { preserveSourceCaret, type RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
const wasm = engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const out = join(root, "target/font-completion/font-editing"); mkdirSync(out, { recursive: true });
type Format = "hwp" | "hwpx";
function exported(d: RhwpDocument, format: Format) {
  const e = format === "hwp" ? d.exportHwpWithReport() : d.exportHwpxWithReport();
  try { return { bytes: e.takeBytes(), loss: JSON.parse(e.contentLoss()) }; } finally { e.free(); }
}
function source(format: Format) {
  const d = engine.HwpDocument.createEmpty();
  try { d.createBlankDocument(); preserveSourceCaret(d); d.insertText(0, 0, 0, "한글 Font editing text"); return exported(d, format).bytes; }
  finally { d.free(); }
}
function opened(bytes: Uint8Array): RhwpDocument { return preserveSourceCaret(new engine.HwpDocument(bytes)); }
const at = (offset: number) => ({ section: 0, paragraph: 0, offset });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function family(d: RhwpDocument, offset = 1) {
  const table = documentFontTable(d)!;
  const id = JSON.parse(d.getCharPropertiesAt!(0, 0, offset)).charShapeId as number;
  return table.charShapes[id]!.fontIds.map((font, lang) => table.languages[lang]!.fonts[font]!.definition.name);
}
function apply(text: RhwpText, name: string, start = 0, end = 8) {
  const action = text.prepareFont(at(start), at(end), name);
  expect(typeof action).toBe("function"); (action as () => void)();
}
it.each(["hwp", "hwpx"] as const)("font editing %s existing and registered definitions survive independent save proof and reopen", format => {
  for (const added of [false, true]) {
    const original = source(format), d = opened(original), text = new RhwpText(d);
    try {
      expect(d.canFormatFonts!()).toBe(true);
      const before = documentFontTable(d)!;
      const name = added ? "Geul Registered Test" : before.languages[0]!.fonts.map(f => f.definition.name)
        .find(n => n !== family(d)[0] && before.languages.every(slot => slot.fonts.filter(f => f.definition.name === n).length === 1))!;
      expect(typeof name).toBe("string");
      apply(text, name);
      expect(family(d)).toEqual(Array(7).fill(name));
      expect(text.selectionFont(at(0), at(8))).toEqual({ family: name });
      expect(text.selectionFont(at(0), at(15))).toEqual({ family: null });
      const after = documentFontTable(d)!;
      for (let lang = 0; lang < 7; lang++) {
        expect(after.languages[lang]!.fonts.slice(0, before.languages[lang]!.fonts.length)).toEqual(before.languages[lang]!.fonts);
        expect(after.languages[lang]!.fonts.length).toBe(before.languages[lang]!.fonts.length + Number(added));
      }
      const output = exported(d, format), reopened = opened(output.bytes);
      try {
        expect(family(reopened)).toEqual(Array(7).fill(name));
        const prefix = d.capturePublishingFontShapePrefix!(reopened); prefix.free();
      } finally { reopened.free(); }
      const id = `${format}-${added ? "new" : "existing"}`, path = join(out, id); mkdirSync(path, { recursive: true });
      writeFileSync(join(path, `original.${format}`), original); writeFileSync(join(path, `edited.${format}`), output.bytes);
      writeFileSync(join(path, "loss.json"), JSON.stringify(output.loss));
      const proof = JSON.parse(execFileSync(join(root, "src-tauri/target/debug/examples/save_check"),
        ["saved", format, join(path, `original.${format}`), join(path, `edited.${format}`), join(path, "loss.json"), "true"], { encoding: "utf8" }));
      writeFileSync(join(path, "proof.json"), JSON.stringify({ build, name, original: hash(original), output: hash(output.bytes), proof }, null, 2));
      expect(proof.outcome, JSON.stringify(proof)).toBe("safe");
    } finally { text.release(); d.free(); }
  }
});
it.each(["hwp", "hwpx"] as const)("font editing %s snapshots and publication preserve font identity across branches", format => {
  const original = source(format), d = opened(original), text = new RhwpText(d);
  try {
    const before = family(d), initial = d.saveSnapshot();
    apply(text, "Geul Registered A"); const edited = d.saveSnapshot();
    d.restoreSnapshot(initial); text.reconcilePublishedCharShapes(); expect(family(d)).toEqual(before);
    d.restoreSnapshot(edited); text.reconcilePublishedCharShapes(); expect(family(d)).toEqual(Array(7).fill("Geul Registered A"));
    const bytes = exported(d, format).bytes, reopened = opened(bytes);
    const count = d.charShapeCount!();
    let release: () => void;
    try { release = text.protectPublishingCharShapes(count, reopened); } finally { reopened.free(); }
    d.restoreSnapshot(initial); text.reconcilePublishedCharShapes(); expect(family(d)).toEqual(before);
    apply(text, "Geul Registered B");
    text.markPublishedCharShapes(count); release!(); text.prepareExport();
    expect(family(d)).toEqual(Array(7).fill("Geul Registered B"));
    const saved = opened(bytes);
    try { expect(family(saved)).toEqual(Array(7).fill("Geul Registered A")); } finally { saved.free(); }
    const next = exported(d, format), nextOpen = opened(next.bytes);
    try { const prefix = d.capturePublishingFontShapePrefix!(nextOpen); prefix.free(); } finally { nextOpen.free(); }
    const stable = exported(d, format).bytes;
    for (const name of ["", "bad,font", "x".repeat(129)]) expect(() => d.resolveDocumentFontFamily!(name)).toThrow();
    expect(exported(d, format).bytes).toEqual(stable);
    d.discardSnapshot(initial); d.discardSnapshot(edited);
  } finally { text.release(); d.free(); }
});

async function session(format: Format) {
  const original = source(format), { backend, take, calls } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open(`/font.${format}`); take("open").reply(ok({ ...base, format })); await opening;
  let doc!: RhwpDocument;
  const editor = new RhwpEditorSession(1, backend, sessions, async () => ({
    openDocument: bytes => { const next = opened(bytes); doc ??= next; return next; },
    memoryBytes: () => wasm.memory.buffer.byteLength,
  }));
  const loading = editor.load(); take("load").reply(loaded(original)); await flush();
  take("session").reply(ok(info({ format, loadGeneration: 1, state: "loading", sequence: 1 })));
  take("setState").reply(ok(info({ format, loadGeneration: 1, state: "ready", sequence: 2 }))); await loading;
  // Both formats must prove the unchanged original independently before fonts are enabled.
  take("original").reply(ok(original)); await flush();
  const call = take("preflight"), path = join(out, `session-${format}`); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, `original.${format}`), original); writeFileSync(join(path, `noop.${format}`), call.args[2] as Uint8Array);
  writeFileSync(join(path, "loss.json"), JSON.stringify(call.args[3]));
  const proof = JSON.parse(execFileSync(join(root, "src-tauri/target/debug/examples/save_check"),
    ["preflight", format, join(path, `original.${format}`), join(path, `noop.${format}`), join(path, "loss.json")], { encoding: "utf8" }));
  expect(proof.outcome, JSON.stringify(proof)).toBe("safe"); call.reply(ok({ preservation: proof, platformSupported: true })); await flush();
  const settle = async () => { await flush(); while (calls.some(c => c.method === "commit")) {
    const c = take("commit"); c.reply(ok(info({ format, loadGeneration: 1, state: "ready", dirty: true,
      revision: Number(c.args[2]) + Number(c.args[3]), sequence: sessions.get(1)!.sequence + 1 }))); await flush();
  } };
  return { editor, doc, sessions, take, settle };
}
it.each(["hwp", "hwpx"] as const)("font session %s command ownership IME pending edits and Undo Redo", async format => {
  const { editor, doc, sessions, take, settle } = await session(format);
  const apply = () => editor.execute("format.font", { command: "format.font", family: "Geul Session Font" });
  try {
    expect(apply().accepted).toBe(false); // collapsed selection is display-only.
    editor.anchor = at(0); editor.caret = at(8);
    const before = family(doc), beforeBytes = exported(doc, format).bytes;
    editor.setAwaitingCommit(true); expect(apply().accepted).toBe(false); editor.setAwaitingCommit(false);
    expect(exported(doc, format).bytes).toEqual(beforeBytes);
    expect(apply().accepted).toBe(true);
    expect(apply().accepted).toBe(false); // same command cannot enter while its revision is pending.
    await settle(); expect(family(doc)).toEqual(Array(7).fill("Geul Session Font"));
    expect(editor.execute("edit.undo").accepted).toBe(true); await settle(); expect(family(doc)).toEqual(before);
    expect(editor.execute("edit.redo").accepted).toBe(true); await settle(); expect(family(doc)).toEqual(Array(7).fill("Geul Session Font"));
    const revision = editor.snapshot().revision;
    expect(apply().accepted).toBe(true); await settle(); expect(editor.snapshot().revision).toBe(revision); // no-op.
    const other = sessions.open(`/other.${format}`); take("open").reply(ok({ ...base, sessionId: 2, format })); await other;
    expect(apply().accepted).toBe(false); sessions.select(1);
    expect(family(doc)).toEqual(Array(7).fill("Geul Session Font"));
    const output = exported(doc, format), fresh = opened(output.bytes);
    try { expect(family(fresh)).toEqual(Array(7).fill("Geul Session Font")); } finally { fresh.free(); }
  } finally { editor.dispose(); }
  expect(apply().accepted).toBe(false);
});
it.each(["hwp", "hwpx"] as const)("font stale %s load generation refuses mutation before reaching WASM", async format => {
  const { editor, doc, sessions } = await session(format);
  try {
    editor.anchor = at(0); editor.caret = at(8);
    const before = exported(doc, format).bytes, current = sessions.get(1)!;
    sessions.applyUpdate({ ...current, loadGeneration: current.loadGeneration + 1, sequence: current.sequence + 1 });
    expect(editor.execute("format.font", { command: "format.font", family: "Geul Stale Font" }).accepted).toBe(false);
    expect(exported(doc, format).bytes).toEqual(before);
  } finally { editor.dispose(); }
});
it.each(["hwp", "hwpx"] as const)("font cell %s preserves body formatting and safely reopens cell references", format => {
  const originalDoc = engine.HwpDocument.createEmpty();
  let original: Uint8Array, table: { paraIdx: number; controlIdx: number };
  try {
    originalDoc.createBlankDocument(); preserveSourceCaret(originalDoc);
    originalDoc.insertText(0, 0, 0, "Body unchanged"); originalDoc.splitParagraph(0, 0, 14);
    table = JSON.parse(originalDoc.createTable(0, 1, 0, 1, 1));
    originalDoc.insertTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, "Cell font");
    originalDoc.setTableProperties(0, table.paraIdx, table.controlIdx, JSON.stringify(format === "hwp" ? HWP_TABLE_NORMALIZATION : { textWrap: "TopAndBottom" }));
    original = exported(originalDoc, format).bytes;
  } finally { originalDoc.free(); }
  const d = opened(original!), text = new RhwpText(d);
  try {
    const before = family(d), atCell = (offset: number) => ({ section: 0, paragraph: table!.paraIdx, offset,
      cell: { parentParagraph: table!.paraIdx, control: table!.controlIdx, cell: 0, cellParagraph: 0 } });
    const apply = text.prepareFont(atCell(0), atCell(9), "Geul Cell Font");
    expect(typeof apply).toBe("function"); (apply as () => void)();
    expect(family(d)).toEqual(before);
    const output = exported(d, format), fresh = opened(output.bytes);
    try {
      const props = JSON.parse(fresh.getCellCharPropertiesAt!(0, table!.paraIdx, table!.controlIdx, 0, 0, 0));
      expect(props.fontFamilies).toEqual(Array(7).fill("Geul Cell Font"));
      const prefix = d.capturePublishingFontShapePrefix!(fresh); prefix.free();
    } finally { fresh.free(); }
    const path = join(out, `cell-${format}`); mkdirSync(path, { recursive: true });
    writeFileSync(join(path, `original.${format}`), original!); writeFileSync(join(path, `edited.${format}`), output.bytes);
    writeFileSync(join(path, "loss.json"), JSON.stringify(output.loss));
    const proof = JSON.parse(execFileSync(join(root, "src-tauri/target/debug/examples/save_check"),
      ["saved", format, join(path, `original.${format}`), join(path, `edited.${format}`), join(path, "loss.json"), "true"], { encoding: "utf8" }));
    expect(proof.outcome, JSON.stringify(proof)).toBe("safe");
  } finally { text.release(); d.free(); }
});
it.each(["hwp", "hwpx"] as const)("font pending %s save refuses edits and failed publication releases the font lease", async format => {
  const { editor, doc, take, settle } = await session(format);
  try {
    editor.anchor = at(0); editor.caret = at(8);
    expect(editor.execute("format.font", { command: "format.font", family: "Geul Save Font" }).accepted).toBe(true); await settle();
    const before = documentFontTable(doc), saving = editor.save(); await flush();
    const call = take("save");
    expect(editor.execute("format.font", { command: "format.font", family: "Geul Unsafe Concurrent" }).accepted).toBe(false);
    expect(documentFontTable(doc)).toEqual(before);
    call.reply({ ok: false, error: { code: "FileConflict" } });
    expect((await saving).ok).toBe(false);
    expect(editor.execute("format.font", { command: "format.font", family: "Geul After Failure" }).accepted).toBe(true); await settle();
    expect(family(doc)).toEqual(Array(7).fill("Geul After Failure"));
    expect(editor.execute("edit.undo").accepted).toBe(true); await settle(); expect(family(doc)).toEqual(Array(7).fill("Geul Save Font"));
  } finally { editor.dispose(); }
});
it.each(["hwp", "hwpx"] as const)("font language %s mixed Latin slots never report the uniform Hangul family", format => {
  const initial = engine.HwpDocument.createEmpty();
  let original: Uint8Array;
  try { initial.createBlankDocument(); preserveSourceCaret(initial); initial.insertText(0, 0, 0, "ab"); original = exported(initial, format).bytes; }
  finally { initial.free(); }
  const d = opened(original!), text = new RhwpText(d);
  try {
    const before = text.fontReferences(at(0))!, originalLatin = before.faces[1]!.definition.name;
    const ids = JSON.parse(d.resolveDocumentFontFamily!("Geul Latin Only")) as number[];
    const changed = [...before.fontIds]; changed[1] = ids[1]!;
    d.applyCharFormat!(0, 0, 0, 1, JSON.stringify({ fontIds: changed }));
    const refs = text.fontReferences(at(0))!;
    expect(refs.faces[0]!.definition.name).toBe(before.faces[0]!.definition.name);
    expect(refs.languageIndex).toBe(1); expect(refs.faces[refs.languageIndex!]!.definition.name).toBe("Geul Latin Only");
    expect(text.selectionFont(at(0), at(1))).toEqual({ family: "Geul Latin Only" });
    expect(text.selectionFont(at(1), at(2))).toEqual({ family: originalLatin });
    expect(text.selectionFont(at(0), at(2))).toEqual({ family: null });
  } finally { text.release(); d.free(); }
});
