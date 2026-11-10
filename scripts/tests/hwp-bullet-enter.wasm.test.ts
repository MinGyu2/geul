// @vitest-environment jsdom
// Enter on an existing empty structural bullet while the HWP original-document preflight (structural
// eligibility) is CHECKING / SAFE / BLOCKED / ERROR, versus continuation, ordinary paragraphs and HWPX.
// Selected Release WASM; preflight replies use the production checker's verdict or controlled outcomes.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { documentCommandState } from "../../src/commands/capability";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, fail, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const out = resolve(process.env.GEUL_BULLET_ENTER_DIR ?? join(root, "target/hwp-bullet-enter"));
mkdirSync(out, { recursive: true });
const checker = join(root, "src-tauri/target/debug/examples/save_check");
type Doc = RhwpDocument & Record<string, (...args: never[]) => unknown>;

/** p0 "첫 항목" (bullet), p1 empty (bullet), p2 "일반" (no heading). */
function source(format: "hwp" | "hwpx"): Uint8Array {
  const d = engine.HwpDocument.createEmpty() as Doc; d.createBlankDocument();
  d.insertText(0, 0, 0, "첫 항목일반"); d.splitParagraph(0, 0, 4); d.splitParagraph(0, 0, 4);
  const id = d.ensureDefaultBullet!("•");
  for (const p of [0, 1]) d.applyParaFormat!(0, p, JSON.stringify({ headType: "Bullet", numberingId: id, paraLevel: 0 }));
  const e = format === "hwp" ? d.exportHwpWithReport() : d.exportHwpxWithReport();
  try { return e.takeBytes(); } finally { e.free(); d.free(); }
}
const exportOf = (d: RhwpDocument) => { const e = d.exportHwpWithReport(); try { return { bytes: e.takeBytes(), loss: e.contentLoss() }; } finally { e.free(); } };
function verdict(mode: "preflight" | "saved", original: Uint8Array, output: Uint8Array, loss: string, reopen = true) {
  writeFileSync(join(out, ".a"), original); writeFileSync(join(out, ".b"), output); writeFileSync(join(out, ".l"), loss);
  return JSON.parse(execFileSync(checker, [mode, "hwp", join(out, ".a"), join(out, ".b"), join(out, ".l"), ...(mode === "saved" ? [String(reopen)] : [])], { encoding: "utf8" }));
}

async function open(format: "hwp" | "hwpx" = "hwp", patch?: (d: Doc) => void) {
  const bytes = source(format);
  const { backend, take, calls } = controlledBackend(), sessions = new DocumentSessions(backend);
  const opening = sessions.open(`/a.${format}`); take("open").reply(ok({ ...base, format })); await opening;
  let live: Doc | undefined;
  const editor = new RhwpEditorSession(1, backend, sessions, async () => ({ openDocument: (b: Uint8Array) => { const d = new engine.HwpDocument(b) as Doc; if (!live) { patch?.(d); live = d; } return d; } }));
  let generation = 0, sequence = 0;
  const load = async () => {
    live = undefined; generation += 1;
    const loading = editor.load(); take("load").reply(loaded(bytes, generation)); await flush();
    take("session").reply(ok(info({ format, state: "loading", sequence: ++sequence, loadGeneration: generation })));
    take("setState").reply(ok(info({ format, state: "ready", sequence: ++sequence, loadGeneration: generation }))); await loading;
  };
  await load();
  const ctx = {
    editor, take, calls, bytes, load, get doc() { return live!; },
    async answer(mode: "real" | "unsafe" | "unknown" | "transport") {
      if (!calls.some(c => c.method === "original")) return "none";
      const o = take("original");
      if (mode === "transport") { o.reply(fail({ code: "Protocol" })); await flush(); return "transport"; }
      o.reply(ok(bytes)); await flush();
      if (!calls.some(c => c.method === "preflight")) return "dropped";
      const pf = take("preflight");
      const preservation = mode === "real" ? verdict("preflight", bytes, pf.args[2] as Uint8Array, JSON.stringify(pf.args[3]))
        : { outcome: mode, findings: [{ code: mode === "unsafe" ? "recordsChanged" : "originalMalformed", part: "DocInfo" }] };
      pf.reply(ok({ preservation, platformSupported: true })); await flush();
      return preservation.outcome as string;
    },
    async settle() {
      await flush();
      while (calls.some(c => c.method === "commit")) {
        const call = take("commit"); call.reply(ok(info({ format, state: "ready", revision: Number(call.args[2]) + Number(call.args[3]), dirty: true, sequence: ++sequence, loadGeneration: generation }))); await flush();
      }
    },
    observe() {
      const d = live!, n = d.getParagraphCount(0);
      const paragraphs = Array.from({ length: n }, (_, p) => {
        const props = JSON.parse(d.getParaPropertiesAt!(0, p));
        return { text: d.getTextRange(0, p, 0, d.getParagraphLength(0, p)), headType: props.headType, numberingId: props.numberingId };
      });
      return { paragraphs, bullets: d.getBulletList!(), caret: { paragraph: editor.caret.paragraph, offset: editor.caret.offset },
        revision: editor.snapshot().revision, editable: editor.snapshot().editable,
        bulletsCommand: documentCommandState("paragraph.bullets", editor.snapshot()) };
    },
    at(paragraph: number, offset: number) { editor.caret = editor.anchor = { section: 0, paragraph, offset }; },
  };
  return ctx;
}
type Ctx = Awaited<ReturnType<typeof open>>;
const records: Record<string, unknown> = {};
const note = (id: string, value: unknown) => { records[id] = value; writeFileSync(join(out, "bullet-enter.json"), JSON.stringify({ engineGeneration: build.generation, records }, null, 2)); };
async function pressEmptyBullet(ctx: Ctx, id: string) {
  ctx.at(1, 0);
  const before = ctx.observe(); const result = ctx.editor.enter(); await ctx.settle();
  const after = ctx.observe(); note(id, { result, before, after });
  return { result, before, after };
}
/** The exit outcome: no new paragraph; p1 stays empty and loses the bullet; caret stays on p1. */
function expectExit(r: Awaited<ReturnType<typeof pressEmptyBullet>>) {
  expect(r.result).toBe(true);
  expect(r.after.paragraphs).toHaveLength(r.before.paragraphs.length);
  expect(r.after.paragraphs.map(p => p.headType)).toEqual(["Bullet", "None", "None"]);
  expect(r.after.paragraphs.map(p => p.text)).toEqual(r.before.paragraphs.map(p => p.text));
  expect(r.after.bullets).toBe(r.before.bullets); // definitions untouched
  expect(r.after.caret).toEqual({ paragraph: 1, offset: 0 });
  expect(r.after.revision).toBe(r.before.revision + 1);
}

describe("HWP empty-bullet Enter is independent of the original-preflight timing", () => {
  it("A1 CHECKING: Enter exits the existing empty bullet (no ordinary split)", async () => {
    const ctx = await open();
    try {
      expect(ctx.observe().bulletsCommand).toEqual({ available: false, reason: "originalChecking" });
      const r = await pressEmptyBullet(ctx, "A1-checking");
      expectExit(r);
      expect(ctx.observe().bulletsCommand).toEqual({ available: false, reason: "originalChecking" }); // new insertions still wait
      // Preflight completes after the Enter: the exit stays, the new-insertion command becomes available.
      expect(await ctx.answer("real")).toBe("safe");
      expect(ctx.observe().bulletsCommand.available).toBe(true);
      // The exited state is a publishable output under the unchanged T009 rules (preview regeneration aside).
      const exported = exportOf(ctx.doc);
      const raw = verdict("saved", ctx.bytes, exported.bytes, exported.loss, true);
      expect(raw.findings.map((f: { code: string }) => f.code).every((c: string) => c === "previewStale"), JSON.stringify(raw)).toBe(true);
      note("A1-export", { rawFindings: raw.findings });
    } finally { ctx.editor.dispose(); }
  });
  it("A2 SAFE: identical outcome", async () => {
    const ctx = await open();
    try { expect(await ctx.answer("real")).toBe("safe"); expectExit(await pressEmptyBullet(ctx, "A2-safe")); }
    finally { ctx.editor.dispose(); }
  });
  it.each([["A3 BLOCKED", "unsafe"], ["A4 UNKNOWN", "unknown"], ["A4 ERROR", "transport"]] as const)("%s: identical outcome; Save stays refused by the original preflight", async (id, mode) => {
    const ctx = await open();
    try {
      await ctx.answer(mode);
      expect(ctx.observe().bulletsCommand).toEqual({ available: false, reason: "originalUnverified" });
      expectExit(await pressEmptyBullet(ctx, id));
      if (mode !== "transport") {
        const saving = ctx.editor.save(); await flush();
        ctx.take("original").reply(ok(ctx.bytes)); await flush();
        ctx.take("preflight").reply(ok({ preservation: { outcome: mode, findings: [{ code: "recordsChanged", part: "DocInfo" }] }, platformSupported: true }));
        expect(await saving).toMatchObject({ ok: false, error: { code: "UnsafeSave" } });
        expect(ctx.calls.some(c => c.method === "save")).toBe(false);
      }
    } finally { ctx.editor.dispose(); }
  });
  it("stale preflight after reload: the new generation is CHECKING and Enter still exits", async () => {
    const ctx = await open();
    try {
      await ctx.load();
      expect(await ctx.answer("real")).toBe("dropped"); // generation-1 probe is stale
      expect(ctx.observe().bulletsCommand).toEqual({ available: false, reason: "originalChecking" });
      expectExit(await pressEmptyBullet(ctx, "stale-reload"));
    } finally { ctx.editor.dispose(); }
  });
  it("A5 continuation: Enter at the end of a nonempty bullet splits into a new bullet item (CHECKING and SAFE)", async () => {
    for (const answer of [false, true]) {
      const ctx = await open();
      try {
        if (answer) await ctx.answer("real");
        ctx.at(0, 4); const result = ctx.editor.enter(); await ctx.settle();
        const after = ctx.observe(); note(`A5-${answer ? "safe" : "checking"}`, { result, after });
        expect(result).toBe(true);
        expect(after.paragraphs.map(p => [p.text, p.headType])).toEqual([["첫 항목", "Bullet"], ["", "Bullet"], ["", "Bullet"], ["일반", "None"]]);
        expect(after.caret).toEqual({ paragraph: 1, offset: 0 });
      } finally { ctx.editor.dispose(); }
    }
  });
  it("A6 ordinary paragraph: Enter splits normally", async () => {
    const ctx = await open();
    try {
      ctx.at(2, 2); const result = ctx.editor.enter(); await ctx.settle();
      const after = ctx.observe(); note("A6", { result, after });
      expect(result).toBe(true);
      expect(after.paragraphs.map(p => [p.text, p.headType])).toEqual([["첫 항목", "Bullet"], ["", "Bullet"], ["일반", "None"], ["", "None"]]);
    } finally { ctx.editor.dispose(); }
  });
  it("A7 HWPX parity: same exit, no preflight involved", async () => {
    const ctx = await open("hwpx");
    try {
      expect(ctx.calls.some(c => c.method === "original")).toBe(false);
      expectExit(await pressEmptyBullet(ctx, "A7-hwpx"));
    } finally { ctx.editor.dispose(); }
  });
  it("A8 pending edit: the exit still applies in order after queued input; IME composition is not split", async () => {
    const ctx = await open();
    try {
      ctx.at(0, 4); expect(ctx.editor.typeText("!")).toBe(true); // commit pending
      ctx.at(1, 0); expect(ctx.editor.enter()).toBe(true); await ctx.settle();
      expect(ctx.observe().paragraphs.map(p => [p.text, p.headType])).toEqual([["첫 항목!", "Bullet"], ["", "None"], ["일반", "None"]]);
    } finally { ctx.editor.dispose(); }
    const ime = await open();
    try {
      ime.at(1, 0); ime.editor.beginComposition(); ime.editor.updateComposition("가");
      const before = ime.observe(); const result = ime.editor.enter(); await ime.settle();
      note("A8-ime", { result, before, after: ime.observe() });
      // Enter during an open composition is the existing IME contract (composition settles first); no extra split.
      expect(ime.observe().paragraphs.length).toBeLessThanOrEqual(before.paragraphs.length + 1);
    } finally { ime.editor.dispose(); }
  });
  it("documents without static structural eligibility keep the ordinary split, deterministically", async () => {
    const ctx = await open("hwp", d => { (d as Record<string, unknown>).getCellInfo = undefined; });
    try {
      expect(ctx.calls.some(c => c.method === "original")).toBe(false);
      const r = await pressEmptyBullet(ctx, "static-unsupported");
      expect(r.result).toBe(true);
      expect(r.after.paragraphs).toHaveLength(4); // ordinary split, as before this change
    } finally { ctx.editor.dispose(); }
  });
  it("a failed exit (engine refusal) records no revision and stops editing (fail closed)", async () => {
    const ctx = await open("hwp", d => { (d as Record<string, unknown>).applyParaFormat = () => "{\"ok\":false}"; });
    try {
      await ctx.answer("real");
      ctx.at(1, 0); const before = ctx.observe().revision;
      expect(ctx.editor.enter()).toBe(false); await ctx.settle();
      expect(ctx.editor.snapshot().revision).toBe(before);
      expect(ctx.editor.snapshot().editable).toBe(false);
      expect(ctx.calls.some(c => c.method === "commit")).toBe(false);
    } finally { ctx.editor.dispose(); }
  });
});
