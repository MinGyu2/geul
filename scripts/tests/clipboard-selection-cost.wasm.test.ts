// @vitest-environment jsdom
// P2-B: cost of clipboard availability for large RHWP selections on the actual
// approved Release WASM. Counts engine control-inventory reads (getControls, the
// first step of every full selected-text extraction) per command snapshot and
// records bounded wall-clock timings. Evidence is printed; assertions are on
// counts and correctness, never on machine-dependent timings.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { documentCommandState } from "../../src/commands/capability";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });

type Seed = (d: RhwpDocument) => void;
async function open(seed: Seed) {
  const s = engine.HwpDocument.createEmpty(); s.createBlankDocument(); seed(s);
  const e = s.exportHwpWithReport(); const bytes = e.takeBytes(); e.free(); s.free();
  const { backend, take, calls } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwp"); take("open").reply(ok({ ...base, format: "hwp" })); await opening;
  let doc!: RhwpDocument;
  const editor = new RhwpEditorSession(1, backend, sessions, async () => ({ openDocument: b => (doc = new engine.HwpDocument(b)) }));
  const loading = editor.load(); take("load").reply(loaded(bytes)); await flush();
  take("session").reply(ok(info({ format: "hwp", state: "loading", sequence: 1 })));
  take("setState").reply(ok(info({ format: "hwp", state: "ready", sequence: 2 }))); await loading;
  let sequence = 2;
  const settle = async () => {
    await flush();
    while (calls.some(c => c.method === "commit")) {
      const call = take("commit"); call.reply(ok(info({ format: "hwp", state: "ready", revision: Number(call.args[2]) + Number(call.args[3]), dirty: true, sequence: ++sequence })));
      await flush();
    }
  };
  // Observation-only wrapper: same call, same arguments, counted.
  let reads = 0;
  const original = doc.getControls!.bind(doc);
  doc.getControls = () => { reads += 1; return original(); };
  return { editor, doc, settle, reads: () => reads };
}

const paragraphsOf = (count: number, size: number): Seed => d => {
  const line = "한😀글a".repeat(Math.ceil(size / 4)).slice(0, size);
  for (let p = 0; p < count; p++) {
    if (p > 0) d.splitParagraph(0, p - 1, d.getParagraphLength(0, p - 1));
    d.insertText(0, p, 0, line);
  }
};

const SNAPSHOTS = 40; // one ribbon render asks every document command button
const scenarios: [string, Seed, (d: RhwpDocument) => { a: object; b: object }][] = [
  ["empty selection", paragraphsOf(1, 100), () => ({ a: { section: 0, paragraph: 0, offset: 5 }, b: { section: 0, paragraph: 0, offset: 5 } })],
  ["small 10", paragraphsOf(1, 100), () => ({ a: { section: 0, paragraph: 0, offset: 0 }, b: { section: 0, paragraph: 0, offset: 10 } })],
  ["600 scalars", paragraphsOf(1, 600), d => ({ a: { section: 0, paragraph: 0, offset: 0 }, b: { section: 0, paragraph: 0, offset: d.getParagraphLength(0, 0) } })],
  ["200 paragraphs x 500", paragraphsOf(200, 500), d => ({ a: { section: 0, paragraph: 0, offset: 0 }, b: { section: 0, paragraph: 199, offset: d.getParagraphLength(0, 199) } })],
  ["one paragraph 200k", paragraphsOf(1, 200_000), d => ({ a: { section: 0, paragraph: 0, offset: 0 }, b: { section: 0, paragraph: 0, offset: d.getParagraphLength(0, 0) } })],
];

describe("P2-B clipboard availability cost (actual Release WASM)", () => {
  for (const [name, seed, range] of scenarios) it(name, { timeout: 120_000 }, async () => {
    const { editor, doc, reads } = await open(seed);
    const { a, b } = range(doc);
    editor.anchor = a as never; editor.caret = b as never;
    const first = reads();
    const start = performance.now();
    let selection = false;
    for (let i = 0; i < SNAPSHOTS; i++) selection = editor.snapshot().clipboard!.selection;
    const ms = performance.now() - start;
    const perSnapshot = (reads() - first) / SNAPSHOTS;
    console.log(`[P2-B] ${name}: ${SNAPSHOTS} snapshots ${ms.toFixed(1)} ms, getControls/snapshot ${perSnapshot}, selection ${selection}`);
    const empty = JSON.stringify(a) === JSON.stringify(b);
    expect(selection).toBe(!empty);
    // Unchanged session state: at most one extraction for the whole render.
    expect(reads() - first).toBeLessThanOrEqual(empty ? 0 : 1);
  });

  it("invalidates on selection change (including a return to earlier coordinates) and on mutation", async () => {
    const { editor, settle, reads } = await open(paragraphsOf(2, 50));
    const p0 = { section: 0, paragraph: 0, offset: 0 };
    editor.anchor = p0; editor.caret = { section: 0, paragraph: 0, offset: 4 };
    expect(editor.snapshot().clipboard!.selection).toBe(true);
    let before = reads();
    editor.snapshot(); expect(reads()).toBe(before);
    // Selection change, including a return to earlier coordinates after a change.
    editor.caret = { section: 0, paragraph: 1, offset: 3 };
    expect(editor.snapshot().clipboard!.selection).toBe(true); expect(reads()).toBe(before + 1);
    editor.caret = { section: 0, paragraph: 0, offset: 4 }; before = reads();
    expect(editor.snapshot().clipboard!.selection).toBe(true); expect(reads()).toBe(before + 1);
    // Mutation through the session (model version) recomputes.
    before = reads();
    expect(await editor.executeClipboard("edit.cut", () => true, { readText: async () => "", writeText: async () => {} })).toBe(true);
    // Execution extracts and validates the full text afresh; the availability cache is never the source.
    expect(reads()).toBeGreaterThan(before);
    await settle();
    expect(editor.snapshot().clipboard!.selection).toBe(false);
    expect(documentCommandState("edit.copy", editor.snapshot()).available).toBe(false);
  });
});
