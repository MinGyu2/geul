// @vitest-environment jsdom
// HWP insert.table / insert.image / paragraph.bullets through the real product session
// (RhwpEditorSession.execute / executeImage), the selected Release WASM and the production
// T009 checker. Backend replies are controlled; the exact product save payloads are written
// as a case corpus that the explicit Rust test `hwp_contract_real_engine_publication`
// publishes through the production save service (with preview regeneration), and the
// `verify` phase reopens the actual published files with a fresh engine.
//
//   GEUL_HWP_PRODUCT_PHASE=generate|repeat|verify  GEUL_HWP_PRODUCT_DIR=<dir>
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { documentCommandState } from "../../src/commands/capability";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import { hwpReopenEqual, hwpReopenModel } from "../../src/components/Editor/rhwp/hwpReopenModel";
import type { RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, fail, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";

const captured = vi.hoisted(() => ({ docs: [] as unknown[] }));
vi.mock("../../src/components/Editor/rhwp/previewRaster", async actual => {
  const real = await actual<typeof import("../../src/components/Editor/rhwp/previewRaster")>();
  // jsdom has no 2D canvas: record the captured document and return a marker raster. The
  // publication corpus carries an independent rsvg raster of the same exported bytes.
  return { ...real, capturePreviewRaster: (doc: unknown) => { captured.docs.push(doc); return { width: 1, height: 1, rgb: new Uint8Array([1, 2, 3]) }; } };
});

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const out = resolve(process.env.GEUL_HWP_PRODUCT_DIR ?? join(root, "src-tauri/target/hwp-product-commands/engine"));
const phase = process.env.GEUL_HWP_PRODUCT_PHASE ?? "generate";
const checker = join(root, "src-tauri/target/debug/examples/save_check");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const png = new Uint8Array(readFileSync(join(root, "src-tauri/target/core-evidence/blue.png")));
const jpg = new Uint8Array(readFileSync(join(root, "src-tauri/target/core-evidence/orange.jpg")));
const picture = (bytes: Uint8Array) => async () => ({ data: Buffer.from(bytes).toString("base64"), width: 12, height: 8 });
mkdirSync(out, { recursive: true });

type Doc = RhwpDocument & Record<string, (...args: never[]) => unknown>;
function exportHwp(d: RhwpDocument) { const e = d.exportHwpWithReport(); try { return { bytes: e.takeBytes(), loss: e.contentLoss() }; } finally { e.free(); } }
function source(text: string, edit?: (d: Doc) => void): Uint8Array {
  const d = engine.HwpDocument.createEmpty() as Doc; d.createBlankDocument(); d.insertText(0, 0, 0, text);
  try { edit?.(d); return exportHwp(d).bytes; } finally { d.free(); }
}
const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;
function state(d: RhwpDocument) {
  const controls = JSON.parse(d.getControls!()) as { ctrlId: string; userDesc: string; para: number; controlIndex: number }[];
  return { format: d.getSourceFormat(), pages: d.pageCount(), text: d.getTextFileText!(), controls,
    paragraphs: Array.from({ length: d.getParagraphCount(0) }, (_, p) => parse(d.getParaPropertiesAt!(0, p))), bullets: d.getBulletList!() };
}
function check(mode: "preflight" | "saved", original: Uint8Array, output: Uint8Array, loss: string, reopen = true) {
  const dir = join(out, ".check"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.hwp"), original); writeFileSync(join(dir, "b.hwp"), output); writeFileSync(join(dir, "loss.json"), loss);
  return JSON.parse(execFileSync(checker, [mode, "hwp", join(dir, "a.hwp"), join(dir, "b.hwp"), join(dir, "loss.json"), ...(mode === "saved" ? [String(reopen)] : [])], { encoding: "utf8" }));
}

async function open(bytes: Uint8Array, patch?: (d: Doc) => void, answerProbe = true) {
  const { backend, take, calls } = controlledBackend(), sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwp"); take("open").reply(ok(base)); await opening;
  let doc: Doc | undefined;
  const editor = new RhwpEditorSession(1, backend, sessions, async () => ({ openDocument: (b: Uint8Array) => {
    // The first document is the live session model; preflight/reopen documents are separate instances.
    const opened = new engine.HwpDocument(b) as Doc; patch?.(opened); doc ??= opened; return opened;
  } }));
  const loading = editor.load(); take("load").reply(loaded(bytes)); await flush();
  take("session").reply(ok(info({ state: "loading", sequence: 1 })));
  take("setState").reply(ok(info({ state: "ready", sequence: 2 }))); await loading;
  // HWP structural eligibility needs the original-document preflight the session starts at load:
  // answer it with the production checker's real verdict on the session's exact no-op export.
  let probe: { preflight: { outcome: string; findings: { code: string }[] }; unedited: Uint8Array; noopLoss: string } | null = null;
  const reply = async () => {
    if (!calls.some(c => c.method === "original")) return null;
    take("original").reply(ok(bytes)); await flush();
    const pf = take("preflight");
    const unedited = pf.args[2] as Uint8Array, noopLoss = JSON.stringify(pf.args[3]);
    probe = { preflight: check("preflight", bytes, unedited, noopLoss), unedited, noopLoss };
    pf.reply(ok({ preservation: probe.preflight, platformSupported: true })); await flush();
    return probe;
  };
  if (answerProbe) await reply();
  const ctx = { editor, take, calls, sequence: 2, get doc() { return doc!; }, get probe() { return probe; }, reply,
    async settle() { await flush(); while (calls.some(c => c.method === "commit")) {
      const call = take("commit"); call.reply(ok(info({ state: "ready", revision: Number(call.args[2]) + Number(call.args[3]), dirty: true, sequence: ++ctx.sequence }))); await flush();
    } } };
  return ctx;
}
type Ctx = Awaited<ReturnType<typeof open>>;
const available = (ctx: Ctx, id: "insert.table" | "insert.image" | "paragraph.bullets") => documentCommandState(id, ctx.editor.snapshot());

/** Drive the product Save: real preflight/raw-saved verdicts from the production checker; controlled backend replies. */
async function save(ctx: Ctx, original: Uint8Array, publish = true) {
  captured.docs.length = 0;
  const saving = ctx.editor.save(); await flush();
  let unedited: Uint8Array, noopLoss: string, preflight: { outcome: string; findings: { code: string }[] };
  if (ctx.calls.some(c => c.method === "original")) {
    ctx.take("original").reply(ok(original)); await flush();
    const pf = ctx.take("preflight");
    unedited = pf.args[2] as Uint8Array; noopLoss = JSON.stringify(pf.args[3]);
    preflight = check("preflight", original, unedited, noopLoss);
    pf.reply(ok({ preservation: preflight, platformSupported: true })); await flush();
  } else {
    // Save reused the SAFE eligibility preflight of this original (no second preflight).
    if (!ctx.probe) throw new Error("save skipped preflight without an eligibility verdict");
    ({ unedited, noopLoss, preflight } = ctx.probe);
  }
  if (preflight.outcome !== "safe") return { result: await saving, preflight, unedited, noopLoss };
  const call = ctx.take("save");
  const [, , revision, output, contentLoss, reopen, , preview] = call.args as [number, number, number, Uint8Array, unknown, Record<string, boolean>, unknown, unknown];
  const loss = JSON.stringify(contentLoss);
  const reopenEqual = Object.values(reopen).every(Boolean);
  const raw = check("saved", original, output, loss, reopenEqual);
  const structural = raw.findings.every((f: { code: string }) => f.code === "previewStale");
  if (publish && reopenEqual && structural) call.reply(ok({ session: info({ state: "ready", revision, dirty: false, sequence: ++ctx.sequence }), durable: true }));
  else call.reply(fail({ code: "UnsafeSave", preservation: raw }));
  const result = await saving;
  return { result, preflight, unedited, noopLoss, output, loss, reopen, reopenEqual, raw, preview, revision };
}
type Saved = Awaited<ReturnType<typeof save>>;

const cases: { id: string; negative?: boolean; expectedCode?: string }[] = [];
function record(id: string, original: Uint8Array, s: Saved, ctx: Ctx, extra: Record<string, unknown> = {}, negative?: string) {
  const dir = join(out, id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "original.hwp"), original); writeFileSync(join(dir, "noop.hwp"), s.unedited); writeFileSync(join(dir, "noop-loss.json"), s.noopLoss);
  writeFileSync(join(dir, "edited.hwp"), s.output!); writeFileSync(join(dir, "loss.json"), s.loss!);
  // Independent page-1 raster of the exact output bytes (the service resamples and validates it).
  const reopened = new engine.HwpDocument(s.output!) as Doc;
  try {
    const page = parse(reopened.getPageInfo!(0) as string) as { width: number; height: number };
    const long = Math.max(page.width, page.height);
    writeFileSync(join(dir, "render.svg"), reopened.renderPageSvgWithProfile!(0, "screen") as string);
    execFileSync("rsvg-convert", ["--background-color", "white", "--width", String(Math.round(page.width / long * 1024)), "--height", String(Math.round(page.height / long * 1024)),
      "--output", join(dir, "render.png"), join(dir, "render.svg")], { timeout: 30000 });
  } finally { reopened.free(); }
  const model = hwpReopenModel(ctx.doc);
  writeFileSync(join(dir, "proof.json"), JSON.stringify({ engineGeneration: build.generation, wasmSha256: build.artifacts["rhwp_bg.wasm"],
    originalSha256: sha(original), noopSha256: sha(s.unedited), editedSha256: sha(s.output!), reopenEqual: s.reopenEqual, productReopen: s.reopen,
    revision: s.revision, live: state(ctx.doc), hwpModel: model.model, hwpStructure: model.structure, preflight: s.preflight, raw: s.raw,
    source: "RhwpEditorSession product command + save payload (controlled backend replies)", ...extra }, null, 2));
  cases.push(negative ? { id, negative: true, expectedCode: negative } : { id });
  writeFileSync(join(out, phase === "repeat" ? "cases-repeat.json" : "cases-first.json"), JSON.stringify(cases, null, 2));
  writeFileSync(join(out, "cases.json"), JSON.stringify(cases, null, 2));
}
function expectPublishable(s: Saved, ctx: Ctx) {
  expect(s.preflight.outcome).toBe("safe");
  expect(s.reopenEqual, JSON.stringify(s.reopen)).toBe(true);
  // Structural HWP output is unsafe only for the stale original preview, which the service regenerates.
  const codes = s.raw.findings.map((f: { code: string }) => f.code);
  expect(codes.length).toBeGreaterThan(0); expect(codes.every((c: string) => c === "previewStale"), codes.join()).toBe(true);
  expect(s.preview).not.toBeNull();
  expect(captured.docs).toHaveLength(1); expect(captured.docs[0]).not.toBe(ctx.doc); // reopened export, not the live model
  expect(s.result.ok).toBe(true);
  expect(ctx.editor.snapshot().revision).toBe(s.revision);
}
const text = "앞 문장 Before | 뒤 문장 After";

describe.runIf(phase === "generate")("HWP product command availability", () => {
  it("supported HWP enables all three; HWPX-only gates no longer apply", async () => {
    const ctx = await open(source(text));
    try {
      for (const id of ["insert.table", "insert.image", "paragraph.bullets"] as const) expect(available(ctx, id), id).toMatchObject({ available: true });
      expect(available(ctx, "paragraph.bullets")).toEqual({ available: true, pressed: false });
    } finally { ctx.editor.dispose(); }
  });
  it.each(["getCellInfo", "getPictureProperties", "getBulletList", "getSectionCount"])("missing detailed reopen API %s disables HWP structural commands", async api => {
    const ctx = await open(source(text), d => { (d as Record<string, unknown>)[api] = undefined; });
    try {
      for (const id of ["insert.table", "insert.image", "paragraph.bullets"] as const) expect(available(ctx, id).available, id).toBe(false);
      expect(available(ctx, "insert.table")).toEqual({ available: false, reason: "engineUnsupported" });
      expect(ctx.editor.execute("insert.table", { command: "insert.table", rows: 2, cols: 2 }).accepted).toBe(false);
      expect(ctx.editor.execute("paragraph.bullets").accepted).toBe(false);
    } finally { ctx.editor.dispose(); }
  });
  it("missing table APIs disable only insert.table", async () => {
    const ctx = await open(source(text), d => { (d as Record<string, unknown>).createTable = undefined; });
    try {
      expect(available(ctx, "insert.table")).toEqual({ available: false, reason: "engineUnsupported" });
      expect(available(ctx, "insert.image").available).toBe(true);
    } finally { ctx.editor.dispose(); }
  });
  it("IME composition, pending edits, selection and cell context are re-checked at execution", async () => {
    const ctx = await open(source(text));
    try {
      ctx.editor.beginComposition();
      for (const id of ["insert.table", "insert.image", "paragraph.bullets"] as const) expect(available(ctx, id)).toEqual({ available: false, reason: "composing" });
      expect(ctx.editor.execute("insert.table", { command: "insert.table", rows: 1, cols: 1 }).accepted).toBe(false);
      expect(ctx.editor.execute("paragraph.bullets").accepted).toBe(false);
      expect(await ctx.editor.executeImage(() => true, picture(png))).toBe("stale");
      ctx.editor.endComposition(""); await ctx.settle();
      expect(ctx.editor.typeText("x")).toBe(true); // queued, commit not yet answered
      expect(available(ctx, "insert.table")).toEqual({ available: false, reason: "pendingEdits" });
      expect(available(ctx, "insert.image").available).toBe(false);
      expect(available(ctx, "paragraph.bullets").available).toBe(false);
      await ctx.settle();
      expect(ctx.editor.moveHorizontal(1, true)).toBe(true);
      expect(available(ctx, "insert.table")).toEqual({ available: false, reason: "caretRequired" });
      expect(available(ctx, "insert.image").available).toBe(false);
      expect(available(ctx, "paragraph.bullets").available).toBe(true); // selection-based
      expect(ctx.editor.moveHorizontal(-1, false)).toBe(true);
      expect(ctx.editor.execute("insert.table", { command: "insert.table", rows: 1, cols: 2 }).accepted).toBe(true); await ctx.settle();
      expect(ctx.editor.caret.cell).toBeDefined();
      for (const id of ["insert.table", "insert.image", "paragraph.bullets"] as const) expect(available(ctx, id).available, id).toBe(false); // no nested objects/lists in cells
    } finally { ctx.editor.dispose(); }
  });
  it("table dimensions beyond the T009 subset are refused before mutation", async () => {
    const ctx = await open(source(text));
    try {
      const before = ctx.editor.snapshot().revision;
      for (const [rows, cols] of [[33, 1], [1, 17], [17, 16], [0, 2]]) expect(ctx.editor.execute("insert.table", { command: "insert.table", rows, cols }).accepted, `${rows}x${cols}`).toBe(false);
      await ctx.settle();
      expect(ctx.editor.snapshot().revision).toBe(before);
      expect(JSON.parse(ctx.doc.getControls!()).filter((c: { ctrlId: string }) => c.ctrlId === "tbl")).toHaveLength(0);
    } finally { ctx.editor.dispose(); }
  });
  it("raw (non-normalized) createTable output is refused and stops editing", async () => {
    const ctx = await open(source(text), d => { (d as Record<string, unknown>).setTableProperties = () => "{\"ok\":true}"; });
    try {
      expect(available(ctx, "insert.table").available).toBe(true);
      expect(ctx.editor.execute("insert.table", { command: "insert.table", rows: 2, cols: 2 }).accepted).toBe(false);
      expect(ctx.editor.snapshot().editable).toBe(false); // uncertain model: fail closed, nothing to save
    } finally { ctx.editor.dispose(); }
  });
  it("a picture that does not become inline is refused", async () => {
    const ctx = await open(source(text), d => { (d as Record<string, unknown>).setPictureProperties = () => "{\"ok\":true}"; });
    try {
      expect(await ctx.editor.executeImage(() => true, picture(png))).toBe("failed");
      expect(ctx.editor.snapshot().editable).toBe(false);
    } finally { ctx.editor.dispose(); }
  });
  it("chooser cancellation, stale ownership and invalid input never insert", async () => {
    const ctx = await open(source(text));
    try {
      const revision = ctx.editor.snapshot().revision, controls = ctx.doc.getControls!();
      expect(await ctx.editor.executeImage(() => true, async () => null)).toBe("cancelled");
      // Document switched while the chooser was open.
      let owned = true;
      expect(await ctx.editor.executeImage(() => owned, async () => { owned = false; return picture(png)(); })).toBe("stale");
      // The model changed while the chooser was open.
      expect(await ctx.editor.executeImage(() => true, async () => { ctx.editor.typeText("y"); return picture(png)(); })).toBe("stale");
      await ctx.settle();
      // Not PNG/JPEG bytes; oversize dimensions.
      expect(await ctx.editor.executeImage(() => true, async () => ({ data: Buffer.from("GIF89a....").toString("base64"), width: 12, height: 8 }))).toBe("failed");
      expect(await ctx.editor.executeImage(() => true, async () => ({ data: Buffer.from(png).toString("base64"), width: 9000, height: 8 }))).toBe("failed");
      expect(JSON.parse(ctx.doc.getControls!()).filter((c: { userDesc: string }) => c.userDesc === "그림")).toHaveLength(0);
      expect(ctx.doc.getControls!()).toBe(controls);
      expect(ctx.editor.snapshot().revision).toBe(revision + 1); // only the typed "y"
    } finally { ctx.editor.dispose(); }
  });
  it("an original the preflight refused disables the HWP structural commands", async () => {
    const opaque = join(root, "target/hwp-record-investigation/opaque-middle.hwp");
    const original = new Uint8Array(readFileSync(existsSync(opaque) ? opaque : join(root, "src-tauri/target/hwp-boundary-hardening/engine/B6/original.hwp")));
    const ctx = await open(original, undefined, false);
    try {
      expect(available(ctx, "insert.table")).toEqual({ available: false, reason: "originalChecking" }); // probe pending
      ctx.take("original").reply(ok(original)); await flush();
      const pf = ctx.take("preflight");
      pf.reply(ok({ preservation: { outcome: "unknown", findings: [{ code: "originalMalformed", part: "DocInfo" }] }, platformSupported: true })); await flush();
      for (const id of ["insert.table", "insert.image", "paragraph.bullets"] as const) expect(available(ctx, id), id).toEqual({ available: false, reason: "originalUnverified" });
    } finally { ctx.editor.dispose(); }
  });
});

describe.runIf(phase === "generate")("HWP product insertions publish through T009", () => {
  it("table: dispatcher command, normalized subset, cell entry, dirty/revision, export", async () => {
    const original = source(text), ctx = await open(original);
    try {
      ctx.editor.moveHorizontal(1, false); ctx.editor.moveHorizontal(1, false); ctx.editor.moveHorizontal(1, false);
      expect(ctx.editor.execute("insert.table", { command: "insert.table", rows: 2, cols: 3 }).accepted).toBe(true); await ctx.settle();
      const cell = ctx.editor.caret.cell!;
      expect(cell).toMatchObject({ cell: 0, cellParagraph: 0 });
      expect(parse(ctx.doc.getTableDimensions(0, cell.parentParagraph, cell.control))).toEqual({ rowCount: 2, colCount: 3, cellCount: 6 });
      expect(parse(ctx.doc.getTableProperties!(0, cell.parentParagraph, cell.control))).toMatchObject({ textWrap: "TopAndBottom", horzRelTo: "Column", outerLeft: 283, treatAsChar: false });
      expect(ctx.editor.typeText("첫 셀")).toBe(true); expect(ctx.editor.moveCell(1)).toBe(true); expect(ctx.editor.typeText("Second")).toBe(true); await ctx.settle();
      expect(ctx.editor.snapshot().revision).toBe(3);
      const s = await save(ctx, original);
      expectPublishable(s, ctx);
      record("P-table", original, s, ctx, { table: { rows: 2, cols: 3 } });
    } finally { ctx.editor.dispose(); }
  });
  it.each([["png", png], ["jpg", jpg]] as const)("picture %s: native chooser payload, inline embedded resource, export", async (ext, bytes) => {
    const original = source(text), ctx = await open(original);
    try {
      writeFileSync(join(out, `input.${ext}`), bytes);
      expect(available(ctx, "insert.image").available).toBe(true);
      expect(await ctx.editor.executeImage(() => true, picture(bytes))).toBe("inserted"); await ctx.settle();
      expect(ctx.editor.snapshot().revision).toBe(1);
      const pic = JSON.parse(ctx.doc.getControls!()).filter((c: { userDesc: string }) => c.userDesc === "그림");
      expect(pic).toHaveLength(1); expect(pic[0].props).toMatchObject({ TreatAsChar: 1 });
      expect(parse(ctx.doc.getPictureProperties!(0, pic[0].para, pic[0].controlIndex))).toMatchObject({ treatAsChar: true });
      expect(Buffer.from(ctx.doc.getControlImageData!(0, pic[0].para, "[]", pic[0].controlIndex) as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
      const s = await save(ctx, original);
      expectPublishable(s, ctx);
      record(`P-image-${ext}`, original, s, ctx, { inputSha256: sha(bytes), inputFile: `input.${ext}` });
    } finally { ctx.editor.dispose(); }
  });
  it("bullets: one paragraph, multiple paragraphs, remove, reapply, definition reuse", async () => {
    const original = source(text, d => d.splitParagraph(0, 0, 10)), ctx = await open(original);
    try {
      const head = (p: number) => parse(ctx.doc.getParaPropertiesAt!(0, p));
      expect(ctx.editor.execute("paragraph.bullets").accepted).toBe(true); await ctx.settle();
      expect(head(0)).toMatchObject({ headType: "Bullet", paraLevel: 0 }); expect(head(1).headType).toBe("None");
      expect(JSON.parse(ctx.doc.getBulletList!())).toEqual([{ id: head(0).numberingId, char: "•", rawCode: 0x2022 }]);
      expect(available(ctx, "paragraph.bullets")).toEqual({ available: true, pressed: true });
      ctx.editor.moveLineEdge("start", false);
      while (ctx.editor.caret.paragraph < 1 || ctx.editor.caret.offset < 3) expect(ctx.editor.moveHorizontal(1, true)).toBe(true);
      expect(available(ctx, "paragraph.bullets")).toEqual({ available: true, pressed: false }); // mixed selection applies
      expect(ctx.editor.execute("paragraph.bullets").accepted).toBe(true); await ctx.settle();
      expect([head(0).headType, head(1).headType]).toEqual(["Bullet", "Bullet"]);
      expect(ctx.editor.execute("paragraph.bullets").accepted).toBe(true); await ctx.settle(); // remove both
      expect([head(0).headType, head(1).headType]).toEqual(["None", "None"]);
      expect(ctx.editor.execute("paragraph.bullets").accepted).toBe(true); await ctx.settle(); // reapply, reuse definition
      expect([head(0).headType, head(1).headType]).toEqual(["Bullet", "Bullet"]);
      expect(JSON.parse(ctx.doc.getBulletList!())).toHaveLength(1);
      expect(ctx.doc.getTextFileText!()).not.toContain("•"); // structural, not a glyph in the text
      expect(ctx.editor.snapshot().revision).toBe(4);
      const s = await save(ctx, original);
      expectPublishable(s, ctx);
      record("P-bullets", original, s, ctx);
    } finally { ctx.editor.dispose(); }
  });
  it("bullets: continuation on Enter and Enter on an empty item exits the list", async () => {
    const original = source(text), ctx = await open(original);
    try {
      expect(ctx.editor.execute("paragraph.bullets").accepted).toBe(true); await ctx.settle();
      ctx.editor.moveLineEdge("end", false);
      expect(ctx.editor.enter()).toBe(true); expect(ctx.editor.typeText("다음 Next")).toBe(true); await ctx.settle();
      expect(ctx.editor.enter()).toBe(true); await ctx.settle();
      expect(ctx.editor.enter()).toBe(true); await ctx.settle(); // empty item → list exit
      const head = (p: number) => parse(ctx.doc.getParaPropertiesAt!(0, p)).headType;
      expect([head(0), head(1), head(2)]).toEqual(["Bullet", "Bullet", "None"]);
      const s = await save(ctx, original);
      expectPublishable(s, ctx);
      record("P-bullets-enter", original, s, ctx);
    } finally { ctx.editor.dispose(); }
  });
  it("bullets: removing existing bullets keeps definitions", async () => {
    const original = source(text, d => { d.splitParagraph(0, 0, 10); const id = d.ensureDefaultBullet!("•"); for (const p of [0, 1]) d.applyParaFormat!(0, p, JSON.stringify({ headType: "Bullet", numberingId: id, paraLevel: 0 })); });
    const ctx = await open(original);
    try {
      expect(available(ctx, "paragraph.bullets")).toEqual({ available: true, pressed: true });
      ctx.editor.moveLineEdge("start", false);
      while (ctx.editor.caret.paragraph < 1 || ctx.editor.caret.offset < 1) expect(ctx.editor.moveHorizontal(1, true)).toBe(true);
      expect(ctx.editor.execute("paragraph.bullets").accepted).toBe(true); await ctx.settle();
      expect([0, 1].map(p => parse(ctx.doc.getParaPropertiesAt!(0, p)).headType)).toEqual(["None", "None"]);
      expect(JSON.parse(ctx.doc.getBulletList!())).toHaveLength(1);
      const s = await save(ctx, original);
      expectPublishable(s, ctx);
      record("P-bullets-off", original, s, ctx);
    } finally { ctx.editor.dispose(); }
  });
  it("combined: table + cell text, inline PNG, bullets on two paragraphs in one document", async () => {
    const original = source(text, d => d.splitParagraph(0, 0, 10)), ctx = await open(original);
    try {
      ctx.editor.moveLineEdge("start", false);
      while (ctx.editor.caret.paragraph < 1 || ctx.editor.caret.offset < 1) expect(ctx.editor.moveHorizontal(1, true)).toBe(true);
      expect(ctx.editor.execute("paragraph.bullets").accepted).toBe(true); await ctx.settle();
      ctx.editor.moveLineEdge("end", false); // collapse at end of paragraph 1
      expect(await ctx.editor.executeImage(() => true, picture(png))).toBe("inserted"); await ctx.settle();
      expect(ctx.editor.execute("insert.table", { command: "insert.table", rows: 2, cols: 2 }).accepted).toBe(true); await ctx.settle();
      expect(ctx.editor.typeText("혼합 셀 Mixed")).toBe(true); await ctx.settle();
      const s = await save(ctx, original);
      expectPublishable(s, ctx);
      expect(ctx.editor.snapshot().revision).toBe(4);
      record("P-combined", original, s, ctx, { inputSha256: sha(png), inputFile: "input.png" });
    } finally { ctx.editor.dispose(); }
  });
  it("unsafe source (OPAQUE-001): insertion refused at save, original bytes kept, revision not acknowledged", async () => {
    const opaque = join(root, "target/hwp-record-investigation/opaque-middle.hwp");
    if (!existsSync(opaque)) throw new Error("OPAQUE-001 fixture missing: " + opaque);
    const original = new Uint8Array(readFileSync(opaque)), ctx = await open(original);
    try {
      expect(ctx.editor.execute("insert.table", { command: "insert.table", rows: 2, cols: 2 }).accepted).toBe(true); await ctx.settle();
      const s = await save(ctx, original);
      expect(s.preflight.outcome).toBe("safe");
      expect(s.raw.outcome).not.toBe("safe");
      expect(s.raw.findings.map((f: { code: string }) => f.code)).toContain("recordsChanged");
      expect(s.result).toMatchObject({ ok: false, error: { code: "UnsafeSave" } });
      expect(ctx.editor.saveState).toMatchObject({ kind: "failed" });
      expect(ctx.editor.snapshot().revision).toBe(1); // committed edit stays unsaved
      record("N-opaque-table", original, s, ctx, {}, "recordsChanged");
    } finally { ctx.editor.dispose(); }
  });
});

const sample = (name: string) => new Uint8Array(readFileSync(join(root, "external/rhwp/samples", name)));
const negatives: Record<string, unknown> = {};
const noteNegative = (id: string, value: unknown) => { negatives[id] = value; writeFileSync(join(out, "product-negatives.json"), JSON.stringify(negatives, null, 2)); };

describe.runIf(phase === "generate")("Phase 4: genuine Hancom original and further fail-closed product paths", () => {
  // Measured on the selected engine: of 108 complete + preflight-SAFE single-section samples only 6 accept
  // these insertions under T009 (target/hwp-phase3-phase4/sample-insertion-matrix.json). test-image.hwp is one
  // of them and already embeds a picture; h-pen-01.hwp is SAFE as an original but its edited reserialization
  // is refused (N7 below).
  it("P-sample: table + bullets + inline PNG on test-image.hwp (existing embedded picture, non-empty previews)", async () => {
    const original = sample("test-image.hwp"), ctx = await open(original);
    try {
      expect(ctx.probe?.preflight.outcome).toBe("safe");
      for (const id of ["insert.table", "insert.image", "paragraph.bullets"] as const) expect(available(ctx, id).available, id).toBe(true);
      expect(ctx.editor.execute("paragraph.bullets").accepted).toBe(true); await ctx.settle();
      ctx.editor.moveLineEdge("end", false);
      expect(await ctx.editor.executeImage(() => true, picture(png))).toBe("inserted"); await ctx.settle();
      expect(ctx.editor.execute("insert.table", { command: "insert.table", rows: 2, cols: 2 }).accepted).toBe(true); await ctx.settle();
      expect(ctx.editor.typeText("한컴 원본 셀")).toBe(true); await ctx.settle();
      const s = await save(ctx, original);
      expectPublishable(s, ctx);
      record("P-sample", original, s, ctx, { inputSha256: sha(png), inputFile: "input.png", source: "external/rhwp/samples/test-image.hwp" });
    } finally { ctx.editor.dispose(); }
  });
  it("N7: a preflight-SAFE Hancom original whose edited reserialization T009 refuses (h-pen-01.hwp)", async () => {
    const original = sample("h-pen-01.hwp"), ctx = await open(original);
    try {
      expect(ctx.probe?.preflight.outcome).toBe("safe");
      expect(available(ctx, "insert.table").available).toBe(true); // no reliable pre-mutation signal exists
      expect(ctx.editor.execute("insert.table", { command: "insert.table", rows: 2, cols: 2 }).accepted).toBe(true); await ctx.settle();
      const s = await save(ctx, original);
      expect(s.raw.outcome).toBe("unsafe");
      expect(s.raw.findings.map((f: { code: string }) => f.code)).toContain("recordsChanged");
      expect(s.result).toMatchObject({ ok: false, error: { code: "UnsafeSave" } });
      expect(ctx.editor.saveState).toMatchObject({ kind: "failed" });
      expect(ctx.editor.snapshot().revision).toBe(1);
      record("N7-hancom-reserialization", original, s, ctx, { source: "external/rhwp/samples/h-pen-01.hwp" }, "recordsChanged");
    } finally { ctx.editor.dispose(); }
  });
  it("P-table-max: the 256-cell limit (32×8) inserts, compares within budget and publishes", async () => {
    const original = source(text), ctx = await open(original);
    try {
      expect(ctx.editor.execute("insert.table", { command: "insert.table", rows: 32, cols: 8 }).accepted).toBe(true); await ctx.settle();
      for (let i = 0; i < 255; i++) expect(ctx.editor.moveCell(1)).toBe(true);
      expect(ctx.editor.typeText("마지막 셀 256")).toBe(true); await ctx.settle();
      let started = performance.now();
      const model = hwpReopenModel(ctx.doc); const modelMs = performance.now() - started;
      expect(model.complete).toBe(true);
      started = performance.now();
      const s = await save(ctx, original); const saveMs = performance.now() - started;
      expectPublishable(s, ctx);
      expect(modelMs).toBeLessThan(2000); expect(saveMs).toBeLessThan(15000);
      record("P-table-max", original, s, ctx, { table: { rows: 32, cols: 8 }, timing: { reopenModelMs: Math.round(modelMs), productSaveMs: Math.round(saveMs) } });
    } finally { ctx.editor.dispose(); }
  });
  it("N-raw-table (engine-direct, not producible by the product): raw createTable output for the Rust corpus", async () => {
    const original = source(text), ctx = await open(original);
    try {
      // The product refuses this state before mutation; this case exercises T009 on the raw bytes.
      const t = JSON.parse(ctx.doc.createTable!(0, 0, 3, 2, 2) as string);
      ctx.doc.insertTextInCell(0, t.paraIdx, t.controlIdx, 0, 0, 0, "raw");
      const exported = exportHwp(ctx.doc), noop = (() => { const d = new engine.HwpDocument(original) as Doc; try { return exportHwp(d); } finally { d.free(); } })();
      const preflight = check("preflight", original, noop.bytes, noop.loss);
      const raw = check("saved", original, exported.bytes, exported.loss, false);
      expect(raw.outcome).not.toBe("safe");
      expect(raw.findings.map((f: { code: string }) => f.code)).toContain("recordsChanged");
      record("N-raw-table", original, { result: { ok: false } as never, preflight, unedited: noop.bytes, noopLoss: noop.loss, output: exported.bytes,
        loss: exported.loss, reopen: {}, reopenEqual: false, raw, preview: null, revision: 0 }, ctx, { source: "engine direct createTable without normalization" }, "recordsChanged");
    } finally { ctx.editor.dispose(); }
  });
  it("N8: an unsafe original (real preflight) refuses even a plain-text save without publication", async () => {
    const original = sample("hwpers_test4_complex_table.hwp"), ctx = await open(original);
    try {
      expect(ctx.probe?.preflight.outcome).toBe("unsafe");
      expect(available(ctx, "insert.table")).toEqual({ available: false, reason: "originalUnverified" });
      expect(ctx.editor.typeText("x")).toBe(true); await ctx.settle();
      const saving = ctx.editor.save(); await flush();
      // No reusable SAFE verdict: Save runs its own preflight, which is refused again.
      ctx.take("original").reply(ok(original)); await flush();
      const pf = ctx.take("preflight");
      const preflight = check("preflight", original, pf.args[2] as Uint8Array, JSON.stringify(pf.args[3]));
      pf.reply(ok({ preservation: preflight, platformSupported: true }));
      const result = await saving;
      expect(result).toMatchObject({ ok: false, error: { code: "UnsafeSave" } });
      expect(ctx.calls.some(c => c.method === "save")).toBe(false);
      expect(ctx.editor.saveState).toMatchObject({ kind: "failed" });
      expect(ctx.editor.snapshot().revision).toBe(1);
      noteNegative("N8-unsafe-original", { preflight: preflight.outcome, findings: preflight.findings, saveRequested: false, revision: 1 });
    } finally { ctx.editor.dispose(); }
  });
  it("N13: an edit while the save is pending stays unsaved after publication", async () => {
    const original = source(text), ctx = await open(original);
    try {
      expect(ctx.editor.execute("paragraph.bullets").accepted).toBe(true); await ctx.settle();
      const saving = ctx.editor.save(); await flush();
      const call = ctx.take("save"); const revision = call.args[2] as number;
      expect(ctx.editor.typeText("늦은 ")).toBe(true); await ctx.settle(); // revision moves on during the save
      call.reply(ok({ session: info({ state: "ready", revision: revision + 1, dirty: true, sequence: ++ctx.sequence }), durable: true }));
      expect((await saving).ok).toBe(true);
      expect(ctx.editor.saveState).toMatchObject({ kind: "saved", revision, changedSince: true });
      expect(ctx.editor.snapshot().revision).toBe(revision + 1);
      noteNegative("N13-revision-during-save", { savedRevision: revision, current: revision + 1, changedSince: true });
    } finally { ctx.editor.dispose(); }
  });
});

describe.runIf(phase === "repeat")("HWP second save cycle from the actual publication", () => {
  it("reopen the published combined document with a fresh engine, edit again, export", async () => {
    const published = new Uint8Array(readFileSync(join(out, "P-combined", "published.hwp")));
    const proof = JSON.parse(readFileSync(join(out, "P-combined", "proof.json"), "utf8"));
    const ctx = await open(published);
    try {
      expect(ctx.probe?.preflight.outcome).toBe("safe"); // current load-generation eligibility re-established
      for (const id of ["insert.table", "insert.image", "paragraph.bullets"] as const) expect(available(ctx, id).available, id).toBe(true);
      const fresh = hwpReopenModel(ctx.doc);
      expect(fresh.model).toBe(proof.hwpModel); expect(fresh.structure).toBe(proof.hwpStructure); expect(fresh.complete).toBe(true);
      // Another supported edit: plain text in the body, then an inline JPEG at the end of the last paragraph.
      expect(ctx.editor.typeText("후속 ")).toBe(true); await ctx.settle();
      const last = ctx.doc.getParagraphCount(0) - 1;
      while (ctx.editor.caret.paragraph < last) expect(ctx.editor.moveHorizontal(1, false)).toBe(true);
      ctx.editor.moveLineEdge("end", false);
      writeFileSync(join(out, "input.jpg"), jpg);
      expect(await ctx.editor.executeImage(() => true, picture(jpg))).toBe("inserted"); await ctx.settle();
      const s = await save(ctx, published);
      expectPublishable(s, ctx);
      record("P-combined-2", published, s, ctx, { inputSha256: sha(jpg), inputFile: "input.jpg" });
    } finally { ctx.editor.dispose(); }
  });
});

describe.runIf(phase === "verify")("actual HWP publications reopen independently", () => {
  it("every published positive case matches the live product model and embeds the selected image bytes", () => {
    const manifest = [
      ...JSON.parse(readFileSync(join(out, "cases-first.json"), "utf8")),
      ...(existsSync(join(out, "cases-repeat.json")) ? JSON.parse(readFileSync(join(out, "cases-repeat.json"), "utf8")) : []),
    ] as { id: string; negative?: boolean }[];
    const results: unknown[] = [];
    for (const { id, negative } of manifest) {
      const dir = join(out, id), proof = JSON.parse(readFileSync(join(dir, "proof.json"), "utf8"));
      if (negative) {
        expect(existsSync(join(dir, "published.hwp")), id).toBe(false);
        results.push({ id, negative: true, publicationPrevented: true }); continue;
      }
      const bytes = new Uint8Array(readFileSync(join(dir, "published.hwp")));
      const d = new engine.HwpDocument(bytes) as Doc;
      try {
        const current = state(d);
        expect(Buffer.from(bytes.subarray(0, 8)).toString("hex"), id).toBe("d0cf11e0a1b11ae1"); // CFB signature
        expect(current.format, id).toBe("hwp"); expect(current.pages, id).toBe(proof.live.pages);
        expect(current.paragraphs, id).toEqual(proof.live.paragraphs);
        expect(current.text, id).toBe(proof.live.text);
        expect(current.controls, id).toEqual(proof.live.controls);
        expect(current.bullets, id).toBe(proof.live.bullets);
        const model = hwpReopenModel(d);
        expect(model.complete, id).toBe(true);
        expect(hwpReopenEqual({ model: proof.hwpModel, structure: proof.hwpStructure, complete: true }, model, null), id).toBe(true);
        const images: string[] = [];
        for (const c of current.controls.filter(c => c.userDesc === "그림")) images.push(sha(d.getControlImageData!(0, c.para, "[]", c.controlIndex) as Uint8Array));
        if (proof.inputSha256) expect(images, id).toContain(proof.inputSha256);
        results.push({ id, publishedSha256: sha(bytes), reopenComplete: true, modelEqual: true, embeddedImageSha256: images, inputSha256: proof.inputSha256 ?? null });
      } finally { d.free(); }
    }
    // Second cycle keeps the first publication's table, cells and bullet definitions.
    if (existsSync(join(out, "P-combined-2", "published.hwp"))) {
      const first = new engine.HwpDocument(new Uint8Array(readFileSync(join(out, "P-combined", "published.hwp")))) as Doc;
      const second = new engine.HwpDocument(new Uint8Array(readFileSync(join(out, "P-combined-2", "published.hwp")))) as Doc;
      try {
        const a = JSON.parse(hwpReopenModel(first).model), b = JSON.parse(hwpReopenModel(second).model);
        expect(b.tables).toEqual(a.tables);
        expect(b.pictures.slice(0, a.pictures.length)).toEqual(a.pictures);
        expect(b.pictures).toHaveLength(a.pictures.length + 1);
        expect(second.getBulletList!()).toBe(first.getBulletList!());
        results.push({ id: "P-combined-2 vs P-combined", tablesPreserved: true, picturesPreserved: a.pictures.length, picturesAdded: 1, bulletDefinitionsPreserved: true });
      } finally { first.free(); second.free(); }
    }
    expect(results.filter(r => !(r as { negative?: boolean }).negative).length).toBeGreaterThanOrEqual(7);
    writeFileSync(join(out, "published-reopen.json"), JSON.stringify({ result: "PASS", engineGeneration: build.generation, results }, null, 2));
  });
});
