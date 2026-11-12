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
import { RhwpText } from "../../src/components/Editor/rhwp/rhwpText";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import { preserveSourceCaret, type RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
const wasm = engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const out = resolve(process.env.GEUL_FORMAT_OUT ?? join(root, "src-tauri/target/general-formatting")); mkdirSync(out, { recursive: true });
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
  expect(all).toHaveLength(Number(process.env.GEUL_FORMAT_EXPECTED_CASES ?? 10));
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


it.skipIf(phase !== "bench")("reproducible selection formatting cost on actual Release WASM", { timeout: 300_000 }, async () => {
  const rows = [];
  for (const format of ["hwpx", "hwp"] as const) for (const [name, paragraphs, size, mixed] of [
    ["short", 1, 16, false], ["uniform", 1, 10_000, false], ["mixed", 1, 10_000, true], ["multi", 20, 500, true],
  ] as const) {
    const seed = engine.HwpDocument.createEmpty(); seed.createBlankDocument();
    for (let p = 0; p < paragraphs; p++) {
      if (p) seed.splitParagraph(0, p - 1, seed.getParagraphLength(0, p - 1));
      seed.insertText(0, p, 0, "한글Ab".repeat(Math.ceil(size / 4)).slice(0, size));
      if (mixed) for (let i = 0; i < size; i += 1000) seed.applyCharFormat(0, p, i, Math.min(i + 500, size), '{"bold":true}');
    }
    const bytes = exported(seed, format).bytes; seed.free();
    const { editor, doc, settle } = await open(format, bytes);
    const reader = new RhwpText(doc), from = body(0), to = body(size, paragraphs - 1);
    let reads = 0, batches = 0;
    const property = doc.getCharPropertiesAt!.bind(doc);
    vi.spyOn(doc, "getCharPropertiesAt").mockImplementation((...args) => { reads++; return property(...args); });
    try {
      const batch = (doc as RhwpDocument & { getFormattingRuns?: (...args: number[]) => string }).getFormattingRuns;
      if (batch) vi.spyOn(doc as RhwpDocument & { getFormattingRuns: (...args: number[]) => string }, "getFormattingRuns").mockImplementation((...args) => { batches++; return batch.apply(doc, args); });
      const beforeMemory = wasm.memory.buffer.byteLength;
      const started = performance.now(); const selection = reader.formatSelection(from, to); const analysisMs = performance.now() - started;
      expect(selection).not.toBeNull();
      const analysisCalls = { properties: reads, batches };
      editor.anchor = from; editor.caret = to;
      reads = 0; batches = 0; const cold = performance.now(); editor.snapshot(); const snapshotMs = performance.now() - cold;
      const snapshotCalls = { properties: reads, batches };
      reads = 0; batches = 0; const warm = performance.now(); for (let n = 0; n < 40; n++) editor.snapshot(); const warmMs = performance.now() - warm;
      expect(reads).toBe(0); expect(batches).toBe(0);
      const apply = performance.now(); expect(editor.execute("format.italic").accepted).toBe(true); const applyMs = performance.now() - apply; await settle();
      expect(properties(doc).italic).toBe(true);
      const remove = performance.now(); expect(editor.execute("format.italic").accepted).toBe(true); const removeMs = performance.now() - remove; await settle();
      expect(properties(doc).italic).toBe(false);
      rows.push({ format, name, selected: size * paragraphs, sourceSha256: sha(bytes), analysisMs, analysisCalls, snapshotMs, snapshotCalls, warmMs, applyMs, removeMs,
        memoryBefore: beforeMemory, memoryAfter: wasm.memory.buffer.byteLength, shapes: doc.charShapeCount!(), state: selection!.state });
      const label = process.env.GEUL_FORMAT_BENCH_LABEL ?? "measurement";
      json(join(out, `performance-${label}.json`), { build, rows });
      console.info("format-cost", JSON.stringify(rows.at(-1)));
    } finally { reader.release(); editor.dispose(); vi.restoreAllMocks(); }
  }
  const label = process.env.GEUL_FORMAT_BENCH_LABEL ?? "measurement";
  json(join(out, `performance-${label}.json`), { build, rows });
});


function withoutFlag(value: Record<string, unknown>, flag: string) {
  const rest = { ...value }; delete rest[flag]; if (flag === "underline") delete rest.underlineType; return rest;
}
function exactCharacters(before: ReturnType<typeof model>, after: ReturnType<typeof model>, flag: string,
  selected: (paragraph: number, offset: number, cell: number | null) => boolean, enabled: boolean) {
  expect(after.text).toBe(before.text); expect(after.controls).toEqual(before.controls);
  const compare = (a: Record<string, unknown>[][], b: Record<string, unknown>[][], cell: number | null) => {
    expect(b.map(p => p.length)).toEqual(a.map(p => p.length));
    a.forEach((p, pi) => p.forEach((v, i) => {
      expect(withoutFlag(b[pi]![i]!, flag)).toEqual(withoutFlag(v, flag));
      expect(b[pi]![i]![flag]).toBe(selected(pi, i, cell) ? enabled : v[flag]);
    }));
  };
  compare(before.body, after.body, null);
  before.cells.forEach((table: Record<string, unknown>[][][], ti: number) => table.forEach((cell, ci) => compare(cell, after.cells[ti][ci], ci)));
}
function multilineSource(format: Format) {
  const d = new engine.HwpDocument(source(format));
  try {
    d.deleteText(0, 0, 0, d.getParagraphLength(0, 0)); d.insertText(0, 0, 0, "첫문단 ABC 끝");
    d.deleteText(0, 1, 0, d.getParagraphLength(0, 1)); // empty intermediate paragraph
    d.splitParagraph(0, 1, 0); d.insertText(0, 2, 0, "마지막문단 XYZ 끝");
    for (const p of [0, 2]) d.applyCharFormat(0, p, 2, 4, '{"bold":true,"italic":true,"underline":true,"strikethrough":true,"textColor":"#123456"}');
    const t = JSON.parse(d.getControls()).find((c: {ctrlId: string}) => c.ctrlId === "tbl");
    d.splitParagraphInCell(0, t.para, t.controlIndex, 0, 0, 2);
    d.splitParagraphInCell(0, t.para, t.controlIndex, 0, 1, 0);
    d.insertTextInCell(0, t.para, t.controlIndex, 0, 2, 0, "마지막 셀문단");
    d.applyCharFormatInCell(0, t.para, t.controlIndex, 0, 2, 1, 3, '{"bold":true,"italic":true,"underline":true,"strikethrough":true}');
    return exported(d, format).bytes;
  } finally { d.free(); }
}

describe.skipIf(phase !== "hardening")("exact multi-paragraph formatting and failure boundaries", () => {
  for (const format of ["hwp", "hwpx"] as const) for (const context of ["body", "cell"] as const) {
    it(`${format}/${context}: all four flags, empty paragraph, reverse range, exact outside properties and save`, async () => {
      const ctx = await open(format, multilineSource(format)), { editor, doc, settle } = ctx;
      try {
        // Supplementary code points are inserted after loading a safe HWP original:
        // generated emoji PrvText is an independently unsupported original fixture.
        editor.caret = editor.anchor = body(1); expect(editor.typeText("😀")).toBe(true); await settle();
        const controls = JSON.parse(doc.getControls!()), t = controls.find((c: {ctrlId: string}) => c.ctrlId === "tbl");
        const at = (p: number, offset: number) => context === "body" ? body(offset, p) : {
          section: 0, paragraph: t.para, offset, cell: { parentParagraph: t.para, control: t.controlIndex, cell: 0, cellParagraph: p },
        };
        const from = at(0, 1), to = at(2, 4);
        for (const flag of flags) {
          const before = model(doc), count = doc.charShapeCount!(), revision = editor.snapshot().revision;
          // Reverse selection uses the same exact [from,to) contract.
          editor.anchor = to; editor.caret = from;
          const selection = { caret: editor.caret, anchor: editor.anchor };
          expect(documentCommandState(`format.${flag}`, editor.snapshot())).toEqual({ available: true, pressed: false });
          expect(editor.execute(`format.${flag}`).accepted).toBe(true); await settle();
          const after = model(doc);
          exactCharacters(before, after, flag, (p, i, cell) => (context === "body" ? cell === null : cell === 0)
            && p <= 2 && (p !== 0 || i >= 1) && (p !== 2 || i < 4), true);
          expect({ caret: editor.caret, anchor: editor.anchor }).toEqual(selection);
          expect(editor.snapshot().revision).toBe(revision + 1); expect(ctx.sessions.get(1)!.dirty).toBe(true);
          expect(editor.execute("edit.undo").accepted).toBe(true); await settle(); expect(model(doc)).toEqual(before);
          expect(doc.charShapeCount!()).toBe(count); expect(editor.snapshot().revision).toBe(revision + 2);
          expect(editor.execute("edit.redo").accepted).toBe(true); await settle(); expect(model(doc)).toEqual(after);
          record(`hard-${format}-${context}-${flag}`, format, ctx.original, doc);
          // Whole paragraphs including empty ones are also a single edit, then exact Undo.
          editor.anchor = at(0, 0); editor.caret = at(2, context === "body" ? doc.getParagraphLength(0, 2) : doc.getCellParagraphLength(0, t.para, t.controlIndex, 0, 2));
          const prior = model(doc);
          const values = context === "body" ? prior.body.slice(0, 3).flat() : prior.cells[0][0].slice(0, 3).flat();
          const enabled = !values.every((v: Record<string, unknown>) => v[flag]);
          expect(editor.execute(`format.${flag}`).accepted).toBe(true); await settle();
          exactCharacters(prior, model(doc), flag, (p, _i, cell) => p <= 2 && (context === "body" ? cell === null : cell === 0), enabled);
          expect(editor.execute("edit.undo").accepted).toBe(true); await settle(); expect(model(doc)).toEqual(prior);
        }
        // A new formatting mutation after Undo must invalidate Redo.
        expect(editor.execute("edit.undo").accepted).toBe(true); await settle();
        editor.anchor = from; editor.caret = to;
        expect(editor.execute("format.bold").accepted).toBe(true); await settle(); expect(editor.snapshot().history?.redo).toBe(false);
      } finally { editor.dispose(); }
    });
  }
  for (const format of ["hwp", "hwpx"] as const) for (const context of ["body", "cell"] as const) for (const failure of ["response", "exception", "rollback"] as const) {
    it(`${format}/${context}: later native mutation ${failure}, successful rollback or frozen uncertainty`, async () => {
      const original = multilineSource(format), path = join(out, `failure-${format}-${context}-${failure}.${format}`);
      writeFileSync(path, original);
      const ctx = await open(format, original, true, path), { editor, doc } = ctx;
      const before = model(doc), shapeCount = doc.charShapeCount!(), revision = editor.snapshot().revision;
      const native = doc.applyCharFormat!.bind(doc), nativeCell = doc.applyCharFormatInCell!.bind(doc); let mutations = 0;
      const injected = (result: string) => {
        mutations++;
        if (mutations === 2) { if (failure === "response") return '{"ok":false}'; throw new Error("injected after later real mutation"); }
        return result;
      };
      const apply = context === "body"
        ? vi.spyOn(doc, "applyCharFormat").mockImplementation((...args) => injected(native(...args)))
        : vi.spyOn(doc, "applyCharFormatInCell").mockImplementation((...args) => injected(nativeCell(...args)));
      const restore = failure === "rollback" ? vi.spyOn(doc, "restoreSnapshot").mockImplementation(() => { throw new Error("injected secondary restore failure"); }) : null;
      try {
        const t = JSON.parse(doc.getControls!()).find((c: {ctrlId: string}) => c.ctrlId === "tbl");
        const cell = (p: number, offset: number) => ({ section: 0, paragraph: t.para, offset,
          cell: { parentParagraph: t.para, control: t.controlIndex, cell: 0, cellParagraph: p } });
        editor.anchor = context === "body" ? body(1) : cell(0, 1); editor.caret = context === "body" ? body(4, 2) : cell(2, 4);
        expect(editor.execute("format.bold").accepted).toBe(false); expect(mutations).toBe(2);
        expect(editor.snapshot().revision).toBe(revision); expect(editor.status.kind).toBe("failed");
        expect(ctx.calls.some(c => c.method === "commit")).toBe(false);
        if (failure !== "rollback") {
          expect(model(doc)).toEqual(before); expect(doc.charShapeCount!()).toBe(shapeCount);
          const e = exported(doc, format), fresh = new engine.HwpDocument(e.bytes) as Doc;
          try { expect(model(fresh)).toEqual(before); } finally { fresh.free(); }
        } else expect(model(doc)).not.toEqual(before);
        expect(editor.snapshot().history?.undo ?? false).toBe(false);
        expect(editor.execute("format.italic").accepted).toBe(false); expect(editor.typeText("안전")).toBe(false);
        expect((await editor.save()).ok).toBe(false); expect(ctx.calls.some(c => c.method === "save")).toBe(false);
        expect(sha(readFileSync(path))).toBe(sha(ctx.original));
      } finally { apply.mockRestore(); restore?.mockRestore(); editor.dispose(); }
    });
  }
  it("reload after an edit retires selection/history/format cache and old generation", async () => {
    const ctx = await open("hwpx"), { editor } = ctx;
    try {
      editor.anchor = body(0); editor.caret = body(2); expect(editor.execute("format.bold").accepted).toBe(true); await ctx.settle();
      expect(editor.snapshot().format?.bold).toBe(true); ctx.clearLive();
      const reload = editor.load({ discard: true }); expect(editor.execute("format.bold").accepted).toBe(false);
      ctx.take("load").reply(loaded(ctx.original, 2)); await flush();
      ctx.take("session").reply(ok(info({ format: "hwpx", state: "loading", sequence: 4, loadGeneration: 2 })));
      ctx.take("setState").reply(ok(info({ format: "hwpx", state: "ready", sequence: 5, loadGeneration: 2 }))); await reload;
      expect(editor.snapshot().format).toBeNull(); expect(editor.snapshot().history).toEqual({ undo: false, redo: false });
      editor.anchor = body(0); editor.caret = body(2); expect(editor.snapshot().format?.bold).toBe(false);
      expect(editor.execute("format.italic").accepted).toBe(true); expect(properties(ctx.doc).italic).toBe(true);
    } finally { editor.dispose(); }
  });
});


function pictureIdentity(doc: Doc): string {
  return execFileSync("python3", ["-c", `import sys,io,zipfile,xml.etree.ElementTree as E,json
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); root=E.fromstring(z.read('Contents/section0.xml')); ns={'p':'http://www.hancom.co.kr/hwpml/2011/paragraph'}
print(json.dumps([(parent.attrib.get('charPrIDRef'),E.tostring(pic,encoding='unicode')) for parent in root.iter() for pic in list(parent) if pic.tag=='{'+ns['p']+'}pic'],ensure_ascii=False))`], { input: exported(doc, "hwpx").bytes, encoding: "utf8" });
}
function adjacentSource(format: Format) {
  const d = engine.HwpDocument.createEmpty();
  try {
    d.createBlankDocument(); d.insertText(0, 0, 0, "앞AB뒤CD"); d.splitParagraph(0, 0, 6);
    d.insertText(0, 1, 0, "다른 문단"); d.splitParagraph(0, 1, 6);
    const table = JSON.parse(d.createTable(0, 2, 0, 1, 2));
    d.insertTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, "셀 앞뒤");
    d.insertTextInCell(0, table.paraIdx, table.controlIdx, 1, 0, 0, "다른 셀");
    const pic = JSON.parse(d.insertPicture(0, 0, 2, "[]", readFileSync(join(root, "src-tauri/target/core-evidence/blue.png")), 7200, 4800, 12, 8, "png", ""));
    d.setPictureProperties(0, pic.paraIdx, pic.controlIdx, '{"treatAsChar":true}');
    return exported(d, format).bytes;
  } finally { d.free(); }
}
describe.skipIf(phase !== "hardening")("proven object-adjacent text, independent of clipboard policy", () => {
  for (const format of ["hwp", "hwpx"] as const) for (const side of ["before", "after"] as const) {
    it(`${format}: ${side} object, exact touching boundary and unrelated paragraph/cell`, async () => {
      const ctx = await open(format, adjacentSource(format)), { editor, doc, settle } = ctx;
      try {
        const a = side === "before" ? 0 : 2, b = side === "before" ? 2 : 6;
        editor.anchor = body(a); editor.caret = body(b);
        const clipboard = new RhwpText(doc);
        try { expect(clipboard.selectedText(editor.anchor, editor.caret)).toBeNull(); } finally { clipboard.release(); }
        for (const flag of flags) {
          const before = model(doc), picture = pictureIdentity(doc);
          expect(editor.execute(`format.${flag}`).accepted).toBe(true); await settle();
          expect(pictureIdentity(doc)).toBe(picture);
          const after = model(doc); exactCharacters(before, after, flag, (p, i, cell) => cell === null && p === 0 && i >= a && i < b, true);
          expect(editor.execute("edit.undo").accepted).toBe(true); await settle(); expect(model(doc)).toEqual(before);
          expect(editor.execute("edit.redo").accepted).toBe(true); await settle(); expect(model(doc)).toEqual(after);
        }
        record(`adjacent-${format}-${side}`, format, ctx.original, doc, false);
        // The object is not in either of these selected contexts.
        editor.anchor = body(0, 1); editor.caret = body(2, 1);
        expect(editor.execute("format.bold").accepted).toBe(true); await settle();
        editor.anchor = ctx.cell(0); editor.caret = ctx.cell(2);
        expect(editor.execute("format.italic").accepted).toBe(true); await settle();
        // Crossing the object's zero-text-width stream slot is unsupported.
        editor.anchor = body(1); editor.caret = body(3);
        const before = model(doc), revision = editor.snapshot().revision, history = editor.snapshot().history;
        expect(editor.snapshot().format).toBeNull(); expect(editor.execute("format.bold").accepted).toBe(false);
        expect(model(doc)).toEqual(before); expect(editor.snapshot().revision).toBe(revision); expect(editor.snapshot().history).toEqual(history);
      } finally { editor.dispose(); }
    });
  }
  it("malformed or incomplete batch results stay fail closed", async () => {
    const { editor, doc, settle } = await open("hwpx");
    try {
      const original = model(doc), revision = editor.snapshot().revision;
      for (const bad of [ { length: 29, runs: [] }, { length: doc.getParagraphLength(0, 0), runs: [[0, 1, 0]] },
        { length: doc.getParagraphLength(0, 0), runs: [[0, 3, 16]] } ]) {
        const api = vi.spyOn(doc, "getFormattingRuns").mockReturnValue(JSON.stringify(bad));
        editor.anchor = body(0); editor.caret = body(3); expect(editor.execute("format.bold").accepted).toBe(false);
        api.mockRestore(); editor.caret = body(4); editor.snapshot(); // validate a different key before next response
      }
      expect(model(doc)).toEqual(original); expect(editor.snapshot().revision).toBe(revision); expect(editor.snapshot().history?.undo).toBe(false);
      editor.anchor = body(0); editor.caret = body(2);
      expect(editor.execute("format.bold").accepted).toBe(true); await settle();
    } finally { editor.dispose(); }
  });
});


it.skipIf(phase !== "hardening")("fields outside a text range with unsupported ownership remain unavailable", async () => {
  const seed = new engine.HwpDocument(source("hwpx"));
  seed.insertClickHereField(0, 0, 3, "안내", "메모", "필드", true);
  const bytes = exported(seed, "hwpx").bytes; seed.free();
  const { editor, doc } = await open("hwpx", bytes);
  try {
    editor.anchor = body(0); editor.caret = body(2);
    const before = model(doc), revision = editor.snapshot().revision;
    expect(editor.snapshot().format).toBeNull();
    for (const flag of flags) expect(editor.execute(`format.${flag}`).accepted).toBe(false);
    expect(model(doc)).toEqual(before); expect(editor.snapshot().revision).toBe(revision); expect(editor.snapshot().history?.undo).toBe(false);
  } finally { editor.dispose(); }
});

it.skipIf(phase !== "hardening")("HWPX picture in the adjacent cell does not block plain selected cell text", async () => {
  const raw = adjacentSource("hwpx");
  // Author a valid nested-picture fixture from existing API-generated resources,
  // then canonicalize once before declaring the original used by this test.
  const authored = execFileSync("python3", ["-c", `import sys,io,zipfile,xml.etree.ElementTree as E
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); ns={'p':'http://www.hancom.co.kr/hwpml/2011/paragraph'}
r=E.fromstring(z.read('Contents/section0.xml')); pic=r.find('.//p:pic',ns)
for parent in r.iter():
 if pic in list(parent): parent.remove(pic); break
cells=r.findall('.//p:tc',ns); run=cells[1].find('.//p:run',ns); run.insert(0,pic)
out=io.BytesIO()
with zipfile.ZipFile(out,'w') as w:
 for info in z.infolist(): w.writestr(info,E.tostring(r,encoding='utf-8') if info.filename=='Contents/section0.xml' else z.read(info.filename))
sys.stdout.buffer.write(out.getvalue())`], { input: raw });
  const seed = new engine.HwpDocument(authored), original = exported(seed, "hwpx").bytes; seed.free();
  const ctx = await open("hwpx", original), { editor, doc } = ctx;
  try {
    const controls = JSON.parse(doc.getControls!()); expect(controls.some((c: {list: number; ctrlId: string}) => c.list > 0 && c.ctrlId === "gso")).toBe(true);
    editor.anchor = ctx.cell(0); editor.caret = ctx.cell(2);
    const before = model(doc);
    expect(editor.execute("format.underline").accepted).toBe(true); await ctx.settle();
    const after = model(doc); exactCharacters(before, after, "underline", (p, i, cell) => cell === 0 && p === 0 && i < 2, true);
    const exp = exported(doc, "hwpx"), reopened = new engine.HwpDocument(exp.bytes) as Doc;
    try { expect(model(reopened)).toEqual(after); } finally { reopened.free(); }
    expect(editor.execute("edit.undo").accepted).toBe(true); await ctx.settle(); expect(model(doc)).toEqual(before);
    expect(editor.execute("edit.redo").accepted).toBe(true); await ctx.settle(); expect(model(doc)).toEqual(after);
  } finally { editor.dispose(); }
});

it.skipIf(phase !== "shortbench")("short-selection paired adapter comparison on the same actual Release engine", async () => {
  const path = join(out, "baseline-formatting.ts");
  // Immutable reference implementation, not a hand-written approximate baseline.
  const legacy = execFileSync("git", ["show", "c1186897582ea87f1c4b49a6b00e54cf9631b9f0:src/components/Editor/rhwp/rhwpText.ts"], { encoding: "utf8" })
    .replaceAll('"../../../commands/clipboard"', JSON.stringify(join(root, "src/commands/clipboard.ts")))
    .replaceAll('"./formulaDependencies"', JSON.stringify(join(root, "src/components/Editor/rhwp/formulaDependencies.ts")))
    .replaceAll('"./rhwpModule"', JSON.stringify(join(root, "src/components/Editor/rhwp/rhwpModule.ts")));
  writeFileSync(path, legacy);
  const { RhwpText: Before } = await import(/* @vite-ignore */ path);
  const ctx = await open("hwpx"), a = new Before(ctx.doc), b = new RhwpText(ctx.doc);
  try {
    const before: number[] = [], after: number[] = [];
    for (let n = 0; n < 70; n++) {
      const start = performance.now(), x = a.formatSelection(body(0), body(16)); const mid = performance.now();
      const y = b.formatSelection(body(0), body(16)); const end = performance.now();
      expect(x.state).toEqual(y!.state);
      if (n >= 10) { before.push(mid - start); after.push(end - mid); }
    }
    const stats = (v: number[]) => { v.sort((x, y) => x - y); return { samples: v.length, median: v[Math.floor(v.length / 2)], p95: v[Math.floor(v.length * 0.95)] }; };
    json(join(out, "performance-short-paired.json"), { build, selected: 16, baselineSourceSha256: sha(legacy), before: stats(before), after: stats(after) });
  } finally { a.release(); b.release(); ctx.editor.dispose(); }
});
