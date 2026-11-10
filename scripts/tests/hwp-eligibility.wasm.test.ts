// @vitest-environment jsdom
// Phase 3 HWP structural-command eligibility (insert.table / insert.image / paragraph.bullets)
// with the selected Release WASM: load-time reopen-model completeness and the original-document
// T009 preflight lifecycle (real `save_check` verdicts as the controlled preflight replies).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { documentCommandState } from "../../src/commands/capability";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import { hwpReopenModel } from "../../src/components/Editor/rhwp/hwpReopenModel";
import type { RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, fail, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const out = resolve(process.env.GEUL_PHASE3_DIR ?? join(root, "target/hwp-phase3-phase4/phase3"));
mkdirSync(out, { recursive: true });
const checker = join(root, "src-tauri/target/debug/examples/save_check");
const sample = (name: string) => new Uint8Array(readFileSync(join(root, "external/rhwp/samples", name)));
const IDS = ["insert.table", "insert.image", "paragraph.bullets"] as const;
type Id = typeof IDS[number];

function blank(text = "앞 문장 Before | 뒤 문장 After"): Uint8Array {
  const d = engine.HwpDocument.createEmpty(); d.createBlankDocument(); d.insertText(0, 0, 0, text);
  const e = d.exportHwpWithReport(); try { return e.takeBytes(); } finally { e.free(); d.free(); }
}
function verdict(original: Uint8Array, unedited: Uint8Array, loss: unknown) {
  writeFileSync(join(out, ".a.hwp"), original); writeFileSync(join(out, ".b.hwp"), unedited); writeFileSync(join(out, ".l.json"), JSON.stringify(loss));
  return JSON.parse(execFileSync(checker, ["preflight", "hwp", join(out, ".a.hwp"), join(out, ".b.hwp"), join(out, ".l.json")], { encoding: "utf8" }));
}

async function open(bytes: Uint8Array, format: "hwp" | "hwpx" = "hwp") {
  const { backend, take, calls } = controlledBackend(), sessions = new DocumentSessions(backend);
  const opening = sessions.open(format === "hwp" ? "/a.hwp" : "/a.hwpx"); take("open").reply(ok({ ...base, format })); await opening;
  let live: RhwpDocument | undefined;
  const editor = new RhwpEditorSession(1, backend, sessions, async () => ({ openDocument: (b: Uint8Array) => { const d = new engine.HwpDocument(b); live ??= d; return d; } }));
  let generation = 0, sequence = 0;
  const load = async (data: Uint8Array) => {
    live = undefined; generation += 1;
    const loading = editor.load(); take("load").reply(loaded(data, generation)); await flush();
    take("session").reply(ok(info({ format, state: "loading", sequence: ++sequence, loadGeneration: generation })));
    take("setState").reply(ok(info({ format, state: "ready", sequence: ++sequence, loadGeneration: generation }))); await loading;
  };
  await load(bytes);
  const ctx = {
    editor, take, calls, bytes, load, backend, get live() { return live!; }, get generation() { return generation; },
    state: (id: Id) => documentCommandState(id, editor.snapshot()),
    states: () => Object.fromEntries(IDS.map(id => [id, documentCommandState(id, editor.snapshot())])),
    probing: () => calls.some(c => c.method === "original"),
    /** Answer a pending original-preflight probe. Returns false if none was requested. */
    async answer(mode: "real" | "safe" | "unsafe" | "unknown" | "transport" = "real", original = bytes) {
      if (!calls.some(c => c.method === "original")) return false;
      const o = take("original");
      if (mode === "transport") { o.reply(fail({ code: "Protocol" })); await flush(); return true; }
      o.reply(ok(original)); await flush();
      // A stale probe stops before asking the backend preflight (ownership lost while waiting).
      if (!calls.some(c => c.method === "preflight")) return "dropped";
      const pf = take("preflight");
      const preservation = mode === "real" ? verdict(original, pf.args[2] as Uint8Array, pf.args[3])
        : { outcome: mode, findings: mode === "safe" ? [] : [{ code: mode === "unsafe" ? "recordsChanged" : "originalMalformed", part: "DocInfo" }] };
      pf.reply(ok({ preservation, platformSupported: true })); await flush();
      return preservation.outcome;
    },
    async settle() {
      await flush();
      while (calls.some(c => c.method === "commit")) {
        const call = take("commit"); call.reply(ok(info({ format, state: "ready", revision: Number(call.args[2]) + Number(call.args[3]), dirty: true, sequence: ++sequence, loadGeneration: generation }))); await flush();
      }
    },
  };
  return ctx;
}
const results: Record<string, unknown> = {};
const note = (id: string, value: unknown) => { results[id] = value; writeFileSync(join(out, "phase3-eligibility.json"), JSON.stringify({ engineGeneration: build.generation, results }, null, 2)); };
const allAvailable = (s: Record<string, { available: boolean }>) => IDS.every(id => s[id]!.available);
const noneAvailable = (s: Record<string, { available: boolean }>) => IDS.every(id => !s[id]!.available);

describe("A1–A10 HWP structural eligibility", () => {
  it("A1/A4 complete baseline + SAFE original preflight enables all three (engine-made and Hancom sample)", async () => {
    for (const [name, bytes] of [["blank", blank()], ["h-pen-01.hwp", sample("h-pen-01.hwp")]] as const) {
      const ctx = await open(bytes);
      try {
        expect(hwpReopenModel(ctx.live).complete, name).toBe(true);
        const before = ctx.states();
        expect(noneAvailable(before), name).toBe(true); // CHECKING
        expect(before["insert.table"]).toEqual({ available: false, reason: "originalChecking" });
        expect(await ctx.answer("real"), name).toBe("safe");
        const after = ctx.states();
        expect(allAvailable(after), name).toBe(true);
        note(`A1-${name}`, { checking: before, safe: after });
      } finally { ctx.editor.dispose(); }
    }
  });
  it("A2/A3 non-null but incomplete baseline never enables structural commands (no probe needed)", async () => {
    const bytes = sample("2010-01-06.hwp");
    const ctx = await open(bytes);
    try {
      expect(hwpReopenModel(ctx.live).complete).toBe(false);
      expect(ctx.probing()).toBe(false);
      const s = ctx.states();
      expect(s["insert.table"]).toEqual({ available: false, reason: "engineUnsupported" });
      expect(noneAvailable(s)).toBe(true);
      expect(ctx.editor.execute("insert.table", { command: "insert.table", rows: 1, cols: 1 }).accepted).toBe(false);
      expect(ctx.editor.typeText("일반 ")).toBe(true); // ordinary editing stays available
      note("A2-2010-01-06.hwp", { complete: false, states: s, ordinaryTyping: true });
    } finally { ctx.editor.dispose(); }
  });
  it.each([["A5", "hwpers_test4_complex_table.hwp", "unsafe"], ["A6", "hwp3-empty-cell.hwp", "unknown"]] as const)(
    "%s original preflight %s (real verdict) disables structural commands", async (id, name, expected) => {
      const ctx = await open(sample(name));
      try {
        expect(hwpReopenModel(ctx.live).complete).toBe(true);
        expect(await ctx.answer("real")).toBe(expected);
        const s = ctx.states();
        expect(s["insert.table"]).toEqual({ available: false, reason: "originalUnverified" });
        expect(noneAvailable(s)).toBe(true);
        expect(ctx.editor.execute("paragraph.bullets").accepted).toBe(false);
        note(`${id}-${name}`, { verdict: expected, states: s });
      } finally { ctx.editor.dispose(); }
    });
  it("A7/A8 unchecked/checking: one probe per load, ordinary typing allowed, commands wait", async () => {
    const ctx = await open(blank());
    try {
      expect(ctx.calls.filter(c => c.method === "original")).toHaveLength(1);
      for (let i = 0; i < 20; i++) ctx.editor.snapshot(); // command-state queries do not start probes
      expect(ctx.calls.filter(c => c.method === "original")).toHaveLength(1);
      expect(ctx.state("paragraph.bullets")).toEqual({ available: false, reason: "originalChecking" });
      expect(ctx.editor.typeText("가")).toBe(true); await ctx.settle();
      expect(ctx.editor.execute("insert.table", { command: "insert.table", rows: 1, cols: 1 }).accepted).toBe(false);
      expect(await ctx.answer("real")).toBe("safe");
      expect(allAvailable(ctx.states())).toBe(true);
      note("A7-A8", { probesPerLoad: 1, typingWhileChecking: true });
    } finally { ctx.editor.dispose(); }
  });
  it("A9/A10 reload resets eligibility; a stale probe reply cannot enable the new generation", async () => {
    const first = blank("첫 문서"), second = blank("둘째 문서");
    const ctx = await open(first);
    try {
      expect(await ctx.answer("real")).toBe("safe");
      expect(allAvailable(ctx.states())).toBe(true);
      // Reload while a fresh probe (generation 2) is pending; first answer a stale request.
      await ctx.load(second);
      expect(noneAvailable(ctx.states())).toBe(true);
      expect(ctx.state("insert.table")).toEqual({ available: false, reason: "originalChecking" });
      // Generation 3 load before generation 2's probe is answered: the generation-2 reply is stale.
      await ctx.load(first);
      const pending = ctx.calls.filter(c => c.method === "original").map(c => c.args[1]);
      expect(pending).toEqual([2, 3]);
      expect(await ctx.answer("safe", second)).toBe("dropped"); // the generation-2 request is stale
      expect(noneAvailable(ctx.states())).toBe(true);
      expect(await ctx.answer("real", first)).toBe("safe");
      expect(allAvailable(ctx.states())).toBe(true);
      note("A9-A10", { staleReplyIgnored: true, pendingGenerations: pending });
    } finally { ctx.editor.dispose(); }
  });
  it("transport failure leaves commands unavailable; a valid manual check recovers", async () => {
    const ctx = await open(blank());
    try {
      expect(await ctx.answer("transport")).toBe(true);
      expect(ctx.state("insert.image")).toEqual({ available: false, reason: "originalUnverified" });
      expect(ctx.probing()).toBe(false); // no automatic retry loop
      for (let i = 0; i < 5; i++) ctx.editor.snapshot();
      expect(ctx.probing()).toBe(false);
      const checking = ctx.editor.checkSave(); await flush();
      expect(await ctx.answer("real")).toBe("safe"); await checking;
      expect(allAvailable(ctx.states())).toBe(true);
      note("transport-retry", { recoveredByManualCheck: true });
    } finally { ctx.editor.dispose(); }
  });
  it("a later manual check returning unsafe revokes eligibility and execution re-checks", async () => {
    const ctx = await open(blank());
    try {
      expect(await ctx.answer("real")).toBe("safe");
      expect(ctx.state("insert.table").available).toBe(true);
      const checking = ctx.editor.checkSave(); await flush();
      await ctx.answer("unsafe"); await checking;
      expect(ctx.state("insert.table")).toEqual({ available: false, reason: "originalUnverified" });
      expect(ctx.editor.execute("insert.table", { command: "insert.table", rows: 1, cols: 1 }).accepted).toBe(false);
    } finally { ctx.editor.dispose(); }
  });
  it("probe after dispose/close never resurrects eligibility or throws", async () => {
    const ctx = await open(blank());
    ctx.editor.dispose();
    expect(await ctx.answer("safe")).toBe("dropped");
    expect(ctx.editor.snapshot().actions?.["insert.image"]).toBeUndefined();
  });
  it("the first Save reuses the SAFE probe instead of a second preflight; a publication re-probes", async () => {
    const ctx = await open(blank());
    try {
      expect(await ctx.answer("real")).toBe("safe");
      expect(ctx.editor.execute("paragraph.bullets").accepted).toBe(true); await ctx.settle();
      const saving = ctx.editor.save(); await flush();
      expect(ctx.calls.some(c => c.method === "original" || c.method === "preflight")).toBe(false);
      const call = ctx.take("save");
      call.reply(ok({ session: info({ state: "ready", revision: call.args[2] as number, dirty: false, sequence: 99, loadGeneration: ctx.generation }), durable: true }));
      expect((await saving).ok).toBe(true); await flush();
      // The published file is the new original: eligibility is re-established for it.
      expect(ctx.calls.filter(c => c.method === "original")).toHaveLength(1);
      expect(ctx.state("insert.table")).toEqual({ available: false, reason: "originalChecking" });
      note("save-reuse", { preflightsBeforeFirstSave: 1, reprobeAfterPublication: true });
    } finally { ctx.editor.dispose(); }
  });
  it("a save with an unknown publication outcome re-establishes eligibility and never reuses the old verdict", async () => {
    const ctx = await open(blank());
    try {
      expect(await ctx.answer("real")).toBe("safe");
      expect(ctx.editor.execute("paragraph.bullets").accepted).toBe(true); await ctx.settle();
      const backend = ctx.backend as unknown as { save: unknown }, realSave = backend.save;
      backend.save = () => Promise.reject(new Error("transport"));
      await expect(ctx.editor.save()).rejects.toThrow("transport");
      backend.save = realSave;
      expect(ctx.state("insert.table")).toEqual({ available: false, reason: "originalChecking" });
      expect(ctx.calls.filter(c => c.method === "original")).toHaveLength(1); // one re-probe
      expect(await ctx.answer("real")).toBe("safe");
      expect(ctx.state("insert.table").available).toBe(true);
      note("transport-save", { reprobe: 1 });
    } finally { ctx.editor.dispose(); }
  });
  it("HWPX is unaffected: no probe, commands available at once", async () => {
    const d = engine.HwpDocument.createEmpty(); d.createBlankDocument(); d.insertText(0, 0, 0, "HWPX");
    const e = d.exportHwpxWithReport(), bytes = e.takeBytes(); e.free(); d.free();
    const ctx = await open(bytes, "hwpx");
    try {
      expect(ctx.probing()).toBe(false);
      expect(allAvailable(ctx.states())).toBe(true);
      note("hwpx", { probe: false, states: ctx.states() });
    } finally { ctx.editor.dispose(); }
  });
});
