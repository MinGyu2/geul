// @vitest-environment jsdom
// Focused implementation evidence, not Stage 5/6 acceptance. No VITE test flags.
// Generate exact exports; the ignored Rust test publishes them; verify reopens published bytes.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
const out = join(root, "src-tauri/target/general-formatting"); mkdirSync(out, { recursive: true });
const phase = process.env.GEUL_FORMAT_PHASE ?? "generate";
const flags = ["bold", "italic", "underline", "strikethrough"] as const;
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
  if (format === "hwp" && phase !== "seed") return new Uint8Array(readFileSync(join(out, "seed-prepared.hwp")));
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
async function open(format: Format, original = source(format), answer = true) {
  const { backend, take, calls } = controlledBackend(), sessions = new DocumentSessions(backend);
  const opening = sessions.open(`/a.${format}`); take("open").reply(ok({ ...base, format })); await opening;
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
  return { editor, doc, original, settle, cell, cellProps, calls, sessions, take };
}
const cases: { id: string; format: Format }[] = [];
function record(id: string, format: Format, original: Uint8Array, doc: Doc) {
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
    cases.push({ id, format }); json(join(out, "cases.json"), cases);
  } finally { re.free(); }
}

describe.skipIf(phase !== "generate")("general formatting production path, actual Release WASM", () => {
  for (const format of ["hwpx", "hwp"] as const) {
    it(`${format}: four flags, mixed selection, cell isolation, history, export`, async () => {
      const { editor, doc, original, settle, cell, cellProps } = await open(format);
      try {
        if (format === "hwp") expect(doc.canFormatCharacters!()).toBe(true);
        for (const flag of flags) {
          const command = `format.${flag}` as const;
          editor.anchor = body(0); editor.caret = body(1);
          expect(editor.execute(command).accepted).toBe(true); await settle();
          editor.caret = body(3); // first character on, later characters off: mixed must apply.
          expect(documentCommandState(command, editor.snapshot())).toEqual({ available: true, pressed: false });
          const selection = { caret: editor.caret, anchor: editor.anchor };
          const previous = editor.snapshot().revision;
          expect(editor.execute(command).accepted).toBe(true);
          expect(editor.execute(command).accepted).toBe(false); // pending commit
          await settle(); expect(editor.snapshot().revision).toBe(previous + 1);
          expect([0, 1, 2, 3].map(i => properties(doc, 0, i)[flag])).toEqual([true, true, true, false]);
          expect({ caret: editor.caret, anchor: editor.anchor }).toEqual(selection);
          expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
          expect([0, 1, 2].map(i => properties(doc, 0, i)[flag])).toEqual([true, false, false]);
          expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
          expect(documentCommandState(command, editor.snapshot())).toEqual({ available: true, pressed: true });
          expect(editor.execute(command).accepted).toBe(true); await settle();
          expect([0, 1, 2].map(i => properties(doc, 0, i)[flag])).toEqual([false, false, false]);
          editor.anchor = cell(0); editor.caret = cell(2);
          const beforeRender = doc.renderPageSvgWithProfile(0, "screen");
          expect(editor.execute(command).accepted).toBe(true); await settle();
          expect(doc.renderPageSvgWithProfile(0, "screen")).not.toBe(beforeRender);
          expect([cellProps(0)[flag], cellProps(1)[flag], cellProps(2)[flag], cellProps(0, 1)[flag]]).toEqual([true, true, false, false]);
          expect(editor.execute("edit.undo").accepted).toBe(true); await settle(); expect(cellProps(0)[flag]).toBe(false);
          expect(doc.renderPageSvgWithProfile(0, "screen")).toBe(beforeRender);
          expect(editor.execute("edit.redo").accepted).toBe(true); await settle(); expect(cellProps(0)[flag]).toBe(true);
          record(`${format}-${flag}`, format, original, doc);
        }
        // New formatting invalidates redo; repeated edits reuse compaction and snapshot ownership.
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        editor.anchor = body(1); editor.caret = body(3, 1);
        expect(editor.execute("format.bold").accepted).toBe(true); await settle();
        expect(editor.snapshot().history?.redo).toBe(false);
        const count = doc.charShapeCount!();
        editor.anchor = body(0); editor.caret = body(2);
        for (let i = 0; i < 20; i++) { expect(editor.execute("format.italic").accepted).toBe(true); await settle(); }
        expect(doc.charShapeCount!()).toBeLessThanOrEqual(count + 2);
        record(`${format}-multi-repeat`, format, original, doc);
      } finally { editor.dispose(); }
    });
    it(`${format}: invalid/cross-cell/IME/missing API/failure/session isolation`, async () => {
      const { editor, doc, settle, cell } = await open(format);
      try {
        const initial = model(doc);
        for (const [a, b] of [[body(-1), body(1)], [body(0), body(999)], [body(0), body(0)], [cell(0), cell(1, 1)], [body(0), body(1, 999)]]) {
          editor.anchor = a; editor.caret = b;
          expect(editor.execute("format.bold").accepted).toBe(false);
        }
        expect(model(doc)).toEqual(initial);
        editor.anchor = body(0); editor.caret = body(2);
        const originalApply = doc.applyCharFormat!.bind(doc);
        const api = vi.spyOn(doc, "applyCharFormat").mockImplementation((...args) => { originalApply(...args); return '{"ok":false}'; });
        expect(editor.execute("format.bold").accepted).toBe(false);
        expect(model(doc)).toEqual(initial); expect(editor.snapshot().revision).toBe(0); expect(editor.status.kind).toBe("failed");
        api.mockRestore();
      } finally { editor.dispose(); }
      const second = await open(format);
      try {
        second.editor.beginComposition(); second.editor.updateComposition("한");
        expect(second.editor.execute("format.bold").accepted).toBe(false);
        expect(second.doc.getTextRange(0, 0, 0, 1)).toBe("한");
        second.editor.endComposition("한"); await second.settle();
        expect(second.doc.getTextRange(0, 0, 0, 2)).toBe("한한");
        second.editor.anchor = body(0); second.editor.caret = body(1);
        const api = vi.spyOn(second.doc, "applyCharFormat");
        Object.defineProperty(second.doc, "applyCharFormat", { value: undefined, configurable: true });
        expect(second.editor.execute("format.bold").accepted).toBe(false); api.mockRestore();
        second.editor.dispose(); expect(second.editor.execute("format.bold").accepted).toBe(false);
      } finally { second.editor.dispose(); }
      await settle();
    });
  }
});

it.skipIf(phase !== "generate")("HWP source eligibility refuses old shapes, range annotations and opaque records before mutation", async () => {
  for (const kind of ["unsupported", "range", "opaque"]) {
    const original = new Uint8Array(readFileSync(join(out, `seed-${kind}.hwp`)));
    const { editor, doc } = await open("hwp", original);
    try {
      expect(doc.canFormatCharacters!()).toBe(false);
      const before = model(doc);
      editor.anchor = body(0); editor.caret = body(2);
      for (const flag of flags) expect(editor.execute(`format.${flag}`).accepted).toBe(false);
      expect(model(doc)).toEqual(before); expect(editor.snapshot().revision).toBe(0);
    } finally { editor.dispose(); }
  }
});

it.skipIf(phase !== "generate")("existing decoration variants, inactive sessions and IME finalization barriers", async () => {
  for (const format of ["hwpx", "hwp"] as const) {
    const seed = new engine.HwpDocument(source(format));
    seed.applyCharFormat(0, 0, 0, 1, JSON.stringify({ underlineType: "Top", underlineShape: 3, underlineColor: "#123456", strikethrough: true, strikeShape: 3, strikeColor: "#654321" }));
    const prepared = exported(seed, format).bytes; seed.free();
    const { editor, doc, settle, sessions } = await open(format, prepared);
    try {
      const first = properties(doc), original = model(doc);
      editor.anchor = body(0); editor.caret = body(3);
      for (const flag of ["underline", "strikethrough"] as const) {
        expect(editor.execute(`format.${flag}`).accepted).toBe(true); await settle();
        expect(properties(doc)).toEqual(first); // already active variant is never rewritten
      }
      // Another active document invalidates a retained command target synchronously.
      sessions.acceptOpen(sessions.beginOpen(), ok({ ...base, sessionId: 2 }));
      const before = model(doc);
      expect(editor.execute("format.bold").accepted).toBe(false); expect(model(doc)).toEqual(before);
      sessions.select(1);
      editor.setAwaitingCommit(true);
      expect(editor.execute("format.bold").accepted).toBe(false); editor.setAwaitingCommit(false);
      editor.caret = editor.anchor = body(0);
      editor.beginComposition(); editor.updateComposition("가"); editor.endComposition("가", { provisional: true });
      expect(editor.execute("format.bold").accepted).toBe(false);
      editor.resolveProvisional("각"); await settle();
      expect(doc.getTextRange(0, 0, 0, 1)).toBe("각");
      expect(doc.getTextFileText().length).toBeGreaterThan(original.text.length);
    } finally { editor.dispose(); }
  }
});

it.skipIf(phase !== "generate")("typing retains load-owned eligibility; publication ownership survives Undo/Redo", async () => {
  const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  try {
    for (const format of ["hwp", "hwpx"] as const) {
      const { editor, doc, original, settle, take, calls, sessions } = await open(format);
      try {
        expect(editor.typeText("새")).toBe(true); await settle();
        editor.anchor = body(0); editor.caret = body(2);
        for (const flag of flags) { expect(editor.execute(`format.${flag}`).accepted).toBe(true); await settle(); }
        // Drive the real Save exporter, shape-publication proof and owned prefix.
        // Backend acknowledgement is controlled here; actual filesystem publication
        // is separately required by general_formatting_real_publication + verify.
        const saving = editor.save(); await flush();
        if (calls.some(c => c.method === "original")) {
          take("original").reply(ok(original)); await flush();
          const pf = take("preflight");
          pf.reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true })); await flush();
        }
        const call = take("save"), bytes = call.args[3] as Uint8Array;
        expect(Object.values(call.args[5] as object).every(Boolean)).toBe(true);
        const reopened = new engine.HwpDocument(bytes) as Doc;
        try { expect(model(reopened)).toEqual(model(doc)); } finally { reopened.free(); }
        const publishedCount = doc.charShapeCount!(), revision = editor.snapshot().revision;
        call.reply(ok({ session: info({ format, state: "ready", revision, dirty: false, sequence: sessions.get(1)!.sequence + 1 }), durable: true }));
        expect((await saving).ok).toBe(true);
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        expect(properties(doc).strikethrough).toBe(false); expect(properties(doc).underline).toBe(true);
        expect(doc.charShapeCount!()).toBeGreaterThanOrEqual(publishedCount);
        expect(editor.execute("edit.redo").accepted).toBe(true); await settle();
        expect(properties(doc).strikethrough).toBe(true);
      } finally { editor.dispose(); }
    }
  } finally { context.mockRestore(); }
});

it.skipIf(phase !== "verify")("fresh engine reopens actual service-published bytes with all character properties intact", () => {
  const all = JSON.parse(readFileSync(join(out, "cases.json"), "utf8")) as typeof cases;
  expect(all).toHaveLength(10);
  for (const { id, format } of all) {
    const dir = join(out, id), doc = new engine.HwpDocument(readFileSync(join(dir, `published.${format}`))) as Doc;
    try {
      const proof = JSON.parse(readFileSync(join(dir, "proof.json"), "utf8"));
      expect(proof.generation).toBe(build.generation);
      expect(model(doc)).toEqual(proof.model);
    } finally { doc.free(); }
  }
});

it.skipIf(phase !== "seed")("prepare exact-source renderer evidence for a nonblank original HWP preview", () => {
  const bytes = source("hwp"), d = new engine.HwpDocument(bytes) as Doc;
  try {
    writeFileSync(join(out, "seed.hwp"), bytes);
    const page = JSON.parse(d.getPageInfo(0)), long = Math.max(page.width, page.height);
    writeFileSync(join(out, "seed.svg"), d.renderPageSvgWithProfile(0, "screen"));
    execFileSync("rsvg-convert", ["--background-color", "white", "--width", String(Math.round(page.width / long * 1024)), "--height", String(Math.round(page.height / long * 1024)),
      "--output", join(out, "seed.png"), join(out, "seed.svg")]);
    json(join(out, "identity.json"), build);
  } finally { d.free(); }
});
