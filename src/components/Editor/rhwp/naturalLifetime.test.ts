// Stage 5-A: WebView faces used by a document's committed natural-font snapshot stay retained for as long as that
// snapshot is active (document leases), across any number of catalog generations; they are released only after a
// newer snapshot is adopted, or the document is reloaded/disposed. Stale bindings never attach ownership.
import { describe, expect, it, vi } from "vitest";
import type { FontBackend, FontCatalog, FontFamily } from "../../../adapters/fonts";
import { DocumentSessions } from "../../../adapters/sessions";
import { MAX_RETAINED_FACES, NaturalFontService } from "../../../fonts/naturalFonts";
import { RhwpEditorSession } from "./RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
import { base, controlledBackend, FakeDocument, FIXED_MEMORY_BYTES, flush, info, loaded, ok } from "./testing";

const family = (name: string): FontFamily => ({ id: name, family: name, localized: [], source: "system", available: true, renderable: true,
  styles: [{ name: "Regular", weight: 400, italic: false }] });
const catalog = (generation: number): FontCatalog => ({
  status: { provider: "fontconfig", fontconfigAvailable: true, fontconfigVersion: "2", fontconfigError: null, systemFaces: 1, generation,
    userFontStorage: true, skippedUserFonts: [] },
  families: [family("Doc Font")], generics: [], userFonts: [],
});

class FakeFace {
  constructor(readonly family: string, readonly descriptors: FontFaceDescriptors) {}
  async load() { return this as unknown as FontFace; }
}

type CommitMode = "ok" | "reject" | "malformed" | "invalid" | "missingGeneration" | "unsafeGeneration" | "unchangedReturn" | "mutateThrow";
type StatusMode = "ok" | "throw" | "garbage" | "missingIdentity" | "sameDifferent" | "higherUnrelated";

/** Natural engine surface on top of the editing fake, modelled on the pinned RHWP contract: a refusal throws a string
 *  before adoption; adoption bumps a per-document monotonic generation; getNaturalFontStatus reports the active
 *  snapshot's generation and each family key's alias/faces. `active` lists the aliases the snapshot paints with. */
function natural(doc: FakeDocument, options: { failCommit?: () => boolean; onCommit?: () => void; commit?: () => CommitMode; status?: () => StatusMode } = {}) {
  type Entry = { key: string; alias: string; bold: boolean };
  const engine = { active: [] as string[], entries: [] as Entry[], pending: [] as Entry[], commits: 0, generation: 0, statusReads: 0 };
  const adopt = () => {
    engine.generation += 1; engine.entries = engine.pending; engine.active = engine.pending.map((e) => e.alias);
    engine.commits += 1; options.onCommit?.();
  };
  Object.assign(doc, {
    getNaturalFontRequests: () => JSON.stringify({ truncated: false, requests: [{ key: "Doc Font", members: ["Doc Font"], regular: true, bold: false }] }),
    beginNaturalFontSet: () => { engine.pending = []; },
    stageNaturalFontFace: (key: string, alias: string, bold: boolean) => {
      for (const k of key.split("\n")) engine.pending.push({ key: k, alias, bold });
      return "{}";
    },
    commitNaturalFontSet: (n: number) => {
      const mode = options.commit?.() ?? "ok";
      if (options.failCommit?.() || mode === "reject" || n !== new Set(engine.pending.map((e) => `${e.alias}\n${e.bold}`)).size) {
        engine.pending = [];
        throw "natural font commit failed: count-mismatch"; // wasm-bindgen throws the HwpError string
      }
      if (mode === "unchangedReturn") return "{}";
      adopt();
      if (mode === "mutateThrow") throw new WebAssembly.RuntimeError("unreachable"); // trap after adoption
      if (mode === "malformed") return "{not json";
      if (mode === "missingGeneration") return "{}";
      if (mode === "unsafeGeneration") return JSON.stringify({ generation: Number.MAX_SAFE_INTEGER + 1 });
      if (mode === "invalid") return JSON.stringify({ ok: true, generation: "?" });
      return JSON.stringify({ ok: true, generation: engine.generation, pageCount: 1 });
    },
    clearNaturalFonts: () => { engine.generation += 1; engine.entries = []; engine.active = []; return true; },
    getNaturalFontStatus: () => {
      engine.statusReads += 1;
      const mode = options.status?.() ?? "ok";
      if (mode === "throw") throw new WebAssembly.RuntimeError("unreachable");
      if (mode === "garbage") return "{";
      if (mode === "missingIdentity") return JSON.stringify({ generation: engine.generation });
      // Defensive inconsistent readbacks, not normal engine adoption behavior.
      if (mode === "sameDifferent" || mode === "higherUnrelated") return JSON.stringify({
        active: true, generation: engine.generation - (mode === "sameDifferent" ? 1 : 0),
        families: [{ family: "Doc Font", alias: "unrelated", faces: [{ bold: false }] }], fallbacks: [],
      });
      if (engine.entries.length === 0) return JSON.stringify({ active: false, generation: engine.generation });
      const families = new Map<string, { family: string; alias: string; faces: { bold: boolean; italic: boolean }[] }>();
      const fallbacks = new Map<string, { alias: string; faces: { bold: boolean; italic: boolean }[] }>();
      for (const e of engine.entries) {
        if (e.key === "") { const f = fallbacks.get(e.alias) ?? { alias: e.alias, faces: [] }; f.faces.push({ bold: e.bold, italic: false }); fallbacks.set(e.alias, f); }
        else { const f = families.get(e.key) ?? { family: e.key, alias: e.alias, faces: [] }; f.faces.push({ bold: e.bold, italic: false }); families.set(e.key, f); }
      }
      return JSON.stringify({ active: true, generation: engine.generation, families: [...families.values()], fallbacks: [...fallbacks.values()] });
    },
  });
  return engine;
}

function service() {
  const set = new Set<FakeFace>();
  let gate: Promise<void> | null = null;
  const backend = {
    faceData: async (f: string, s: string) => { if (gate) await gate; return { ok: true as const, value: { index: 0, bytes: new TextEncoder().encode(`${f}/${s}`) } }; },
  } as unknown as FontBackend;
  const binder = new NaturalFontService({ add: (f) => set.add(f as unknown as FakeFace), delete: (f) => set.delete(f as unknown as FakeFace) },
    (alias, _bytes, d) => new FakeFace(alias, d) as unknown as FontFace);
  const aliases = () => new Set([...set].map((f) => f.family));
  return { binder, backend, set, aliases, hold: () => { let open!: () => void; gate = new Promise((r) => { open = r; }); return () => { gate = null; open(); }; } };
}

/** A session whose module opens a fresh FakeDocument per load (actual replacement document on reload). */
async function open(binder: NaturalFontService, docs: FakeDocument[]) {
  const { backend, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwp");
  take("open").reply(ok(base));
  await opening;
  let next = 0;
  const module: RhwpModule = { openDocument: () => docs[next++] as unknown as RhwpDocument, memoryBytes: () => FIXED_MEMORY_BYTES };
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module, { history: true, natural: binder });
  const load = async (generation: number, sequence: number) => {
    const loading = editor.load();
    await flush(); // failed sessions acknowledge the failure transition before requesting load
    take("load").reply(loaded(new Uint8Array([1]), generation));
    await flush();
    take("session").reply(ok(info({ state: "loading", sequence, loadGeneration: generation })));
    take("setState").reply(ok(info({ state: "ready", sequence: sequence + 1, loadGeneration: generation })));
    await loading;
    await flush();
  };
  await load(1, 1);
  return { editor, load, take };
}

/** A9: every alias the engine snapshot paints with has a retained WebView face. */
const consistent = (engine: { active: string[] }, aliases: Set<string>) => engine.active.every((a) => aliases.has(a));

describe("natural font face lifetime", () => {
  it("A1/A2/A9: a deferred document keeps its generation-1 face through generations 2 and 3, released after adoption", async () => {
    const s = service();
    s.binder.configure(s.backend, catalog(1));
    const doc = new FakeDocument(["가나다"]); const engine = natural(doc);
    const { editor } = await open(s.binder, [doc]);
    const gen1 = engine.active[0]!;
    expect(gen1).toBeDefined();
    editor.beginComposition(); editor.updateComposition("한");
    for (const g of [2, 3]) { s.binder.configure(s.backend, catalog(g)); editor.fontsChanged(); await flush(); }
    expect(engine.active).toEqual([gen1]); // deferred: the committed snapshot is unchanged ...
    expect(s.aliases().has(gen1)).toBe(true); // ... and its face survives two newer generations
    expect(consistent(engine, s.aliases())).toBe(true);
    editor.endComposition("한");
    await flush();
    expect(engine.active).toHaveLength(1);
    expect(engine.active[0]).not.toBe(gen1); // generation 3 adopted
    expect(s.aliases().has(gen1)).toBe(false); // old face released only after adoption
    expect(consistent(engine, s.aliases())).toBe(true);
    expect(s.binder.retained().every((r) => r.generation === 3)).toBe(true);
  });

  it("A3/A4: two documents share a face; closing one keeps it, releasing both makes it collectable", async () => {
    const s = service();
    s.binder.configure(s.backend, catalog(1));
    const a = new FakeDocument(["a"]), b = new FakeDocument(["b"]);
    const ea = natural(a), eb = natural(b);
    const first = await open(s.binder, [a]);
    const second = await open(s.binder, [b]);
    expect(ea.active).toEqual(eb.active);
    const shared = ea.active[0]!;
    expect(s.binder.retained().find((r) => r.key.includes(shared))?.refs).toBe(2);
    first.editor.dispose();
    expect(s.aliases().has(shared)).toBe(true);
    expect(consistent(eb, s.aliases())).toBe(true);
    second.editor.dispose();
    expect(s.binder.retained().find((r) => r.key.includes(shared))?.refs).toBe(0);
    s.binder.configure(s.backend, catalog(2)); // unreferenced old-generation faces are now released
    expect(s.aliases().has(shared)).toBe(false);
    expect(s.binder.retained()).toEqual([]);
  });

  it("A5: a refused binding keeps the previous snapshot and its face; the refused attempt leases nothing", async () => {
    const s = service();
    s.binder.configure(s.backend, catalog(1));
    let refuse = false;
    const doc = new FakeDocument(["가"]); const engine = natural(doc, { failCommit: () => refuse });
    const { editor } = await open(s.binder, [doc]);
    const gen1 = engine.active[0]!;
    refuse = true;
    s.binder.configure(s.backend, catalog(2)); editor.fontsChanged(); await flush();
    expect(editor.naturalFontStatus?.status).toBe("failed");
    expect(engine.active).toEqual([gen1]);
    expect(s.aliases().has(gen1)).toBe(true);
    expect(consistent(engine, s.aliases())).toBe(true);
    expect(s.binder.retained().filter((r) => r.generation === 2).every((r) => r.refs === 0)).toBe(true);
  });

  it("A6: a binding still pending when a replacement document loads never attaches ownership to the new document", async () => {
    const s = service();
    s.binder.configure(s.backend, catalog(1));
    const oldDoc = new FakeDocument(["old"]), newDoc = new FakeDocument(["new"]);
    const oldEngine = natural(oldDoc), newEngine = natural(newDoc);
    const { editor, load } = await open(s.binder, [oldDoc, newDoc]);
    const released = s.hold();
    s.binder.configure(s.backend, catalog(2)); editor.fontsChanged(); // pending on the gated font fetch
    await flush();
    await load(2, 3); // actual reload: a different engine document
    released();
    await flush(); await flush();
    expect(oldEngine.commits).toBe(1); // the stale binding never committed to the old document
    expect(oldDoc.freed).toBe(true);
    expect(newEngine.active).toHaveLength(1); // the new document bound itself with the newest catalog
    expect(consistent(newEngine, s.aliases())).toBe(true);
    const refs = s.binder.retained().reduce((n, r) => n + r.refs, 0);
    expect(refs).toBe(1); // only the new document's lease
    editor.dispose();
    expect(s.binder.retained().reduce((n, r) => n + r.refs, 0)).toBe(0);
  });

  it("A7: disposal while a binding is pending, or right as it commits, restores no ownership", async () => {
    const s = service();
    s.binder.configure(s.backend, catalog(1));
    const doc = new FakeDocument(["x"]); natural(doc);
    const pending = await open(s.binder, [doc]);
    const released = s.hold();
    s.binder.configure(s.backend, catalog(2)); pending.editor.fontsChanged(); await flush();
    pending.editor.dispose();
    released(); await flush(); await flush();
    expect(s.binder.retained().reduce((n, r) => n + r.refs, 0)).toBe(0);

    const s2 = service();
    s2.binder.configure(s2.backend, catalog(1));
    const racing = new FakeDocument(["y"]);
    let editorRef: RhwpEditorSession | null = null;
    let disposeOnCommit = false;
    natural(racing, { onCommit: () => { if (disposeOnCommit) editorRef?.dispose(); } });
    const r = await open(s2.binder, [racing]);
    editorRef = r.editor;
    disposeOnCommit = true;
    s2.binder.configure(s2.backend, catalog(2)); r.editor.fontsChanged(); await flush(); await flush();
    expect(s2.binder.retained().reduce((n, x) => n + x.refs, 0)).toBe(0); // committed to a document that is now gone
  });

  it("A8: many catalog refreshes keep retained faces bounded to the live lease plus the current generation", async () => {
    const s = service();
    const doc = new FakeDocument(["z"]); const engine = natural(doc);
    s.binder.configure(s.backend, catalog(1));
    const { editor } = await open(s.binder, [doc]);
    for (let g = 2; g <= 40; g++) {
      s.binder.configure(s.backend, catalog(g)); editor.fontsChanged(); await flush();
      expect(s.binder.retained().length).toBeLessThanOrEqual(2);
      expect(consistent(engine, s.aliases())).toBe(true);
    }
    expect(s.set.size).toBeLessThanOrEqual(2);
    expect(MAX_RETAINED_FACES).toBe(256);
    editor.dispose();
  });

  it("A8: Undo/Redo and derived relayout do not release the active lease", async () => {
    const s = service();
    s.binder.configure(s.backend, catalog(1));
    const doc = new FakeDocument(["가나다"]); const engine = natural(doc);
    const { editor } = await open(s.binder, [doc]);
    const gen1 = engine.active[0]!;
    editor.typeText("라"); await flush();
    editor.undo(); await flush(); editor.redo(); await flush();
    s.binder.configure(s.backend, catalog(1)); // same generation: no-op
    expect(s.aliases().has(gen1)).toBe(true);
    expect(s.binder.retained().find((r) => r.key.includes(gen1))?.refs).toBe(1);
  });
});

describe("ambiguous natural commit outcomes", () => {
  const refs = (s: ReturnType<typeof service>) => s.binder.retained().reduce((n, r) => n + r.refs, 0);

  async function scenario(mode: CommitMode, status: StatusMode = "ok") {
    const s = service();
    s.binder.configure(s.backend, catalog(1));
    let commit: CommitMode = "ok", readback: StatusMode = "ok", reads = 0;
    const doc = new FakeDocument(["가"]);
    const engine = natural(doc, { commit: () => commit, status: () => ++reads === 1 ? "ok" : readback });
    const { editor } = await open(s.binder, [doc]);
    const before = engine.active[0]!;
    const layout = editor.layoutVersion;
    commit = mode; readback = status; reads = 0;
    s.binder.configure(s.backend, catalog(2)); editor.fontsChanged(); await flush();
    commit = "ok"; readback = "ok";
    s.binder.configure(s.backend, catalog(3)); // a later catalog change collects every unleased older face
    return { s, engine, editor, doc, before, layout, set: (m: CommitMode) => { commit = m; } };
  }

  it.each(["malformed", "invalid", "missingGeneration", "unsafeGeneration"] as const)("T2/T3: an adopted snapshot whose commit response is %s is confirmed by readback and keeps its faces", async (mode) => {
    const { s, engine, editor, before, layout } = await scenario(mode);
    expect(engine.commits).toBe(2); // the engine did adopt the generation-2 candidate
    expect(engine.active[0]).not.toBe(before);
    expect(consistent(engine, s.aliases())).toBe(true); // its face survives the generation-3 cleanup
    expect(editor.naturalFontStatus).toMatchObject({ status: "bound", commitResponse: "invalid", generation: engine.generation });
    expect(editor.layoutVersion).toBe(layout + 2); // fontsChanged repaint + relayout for the adopted snapshot
    expect(s.aliases().has(before)).toBe(false); // the replaced snapshot's face released after adoption
    editor.dispose();
    expect(refs(s)).toBe(0);
  });

  it.each(["reject", "unchangedReturn"] as const)("T4/T6: %s before adoption keeps the previous snapshot and releases the candidate", async (mode) => {
    const { s, engine, editor, before } = await scenario(mode);
    expect(engine.active).toEqual([before]);
    expect(consistent(engine, s.aliases())).toBe(true);
    expect(editor.naturalFontStatus).toMatchObject({ status: "failed", commitResponse: "invalid" });
    expect(s.binder.retained().filter((r) => r.generation === 2)).toEqual([]); // candidate released and collected
    editor.fontsChanged(); await flush(); // the session stays usable and rebinds normally
    expect(engine.commits).toBe(2);
    editor.dispose();
    expect(refs(s)).toBe(0);
  });

  it.each([["mutateThrow", "ok"], ["mutateThrow", "throw"], ["mutateThrow", "garbage"], ["reject", "garbage"], ["mutateThrow", "missingIdentity"], ["malformed", "sameDifferent"], ["malformed", "higherUnrelated"]] as const)(
    "T5/T7-T9: commit %s with readback %s is uncertain: both snapshots' faces stay owned, the session stops, disposal releases",
    async (mode, status) => {
      const { s, engine, editor, doc, before, layout } = await scenario(mode, status);
      expect(editor.naturalFontStatus).toMatchObject({ status: "uncertain", commitResponse: "invalid" });
      expect(editor.status.kind).toBe("failed"); // no editing or painting with a possibly mismatched binding
      expect(s.aliases().has(before)).toBe(true); // previous snapshot's face protected
      expect(consistent(engine, s.aliases())).toBe(true); // whatever the engine adopted is protected
      expect(refs(s)).toBe(2);
      expect(editor.layoutVersion).toBe(layout + 1); // only fontsChanged invalidation, no adopted-layout refresh
      const paint = vi.spyOn(doc, "renderPageToCanvas");
      const paragraphs = [...doc.paragraphs];
      editor.typeText("unsafe"); editor.beginComposition(); editor.updateComposition("unsafe"); editor.endComposition("unsafe");
      editor.undo(); editor.redo();
      expect(doc.paragraphs).toEqual(paragraphs);
      expect(editor.prepareRendering(1)).toBe(false);
      expect(editor.renderPage(0, {} as HTMLCanvasElement, 1)).toBe(false);
      expect(paint).not.toHaveBeenCalled();
      const commits = engine.commits;
      for (let i = 0; i < 5; i++) { s.binder.configure(s.backend, catalog(4 + i)); editor.fontsChanged(); await flush(); } // T10: no retry, no accumulation
      expect(engine.commits).toBe(commits);
      expect(refs(s)).toBe(2);
      editor.dispose();
      expect(refs(s)).toBe(0);
      editor.dispose(); // idempotent
      expect(s.binder.retained().every((r) => r.refs === 0)).toBe(true);
    });

  it("T1: a normal commit transfers exactly one lease and reports no response problem", async () => {
    const { s, engine, editor, before, layout } = await scenario("ok");
    expect(editor.naturalFontStatus?.status).toBe("bound");
    expect(editor.naturalFontStatus?.commitResponse).toBeUndefined();
    expect(engine.statusReads).toBe(2); // pre-commit identity only; no successful-path readback
    expect(editor.layoutVersion).toBe(layout + 2);
    expect(editor.naturalFontStatus).toMatchObject({ complete: true, styleGaps: [] });
    expect(refs(s)).toBe(1);
    expect(s.aliases().has(before)).toBe(false);
    expect(consistent(engine, s.aliases())).toBe(true);
    editor.dispose();
  });

  it("T7: disposal while a malformed response is handled leaves no lease and no double release", async () => {
    const s = service();
    s.binder.configure(s.backend, catalog(1));
    const doc = new FakeDocument(["x"]);
    let editorRef: RhwpEditorSession | null = null, mode: CommitMode = "ok", disposeOnCommit = false;
    natural(doc, { commit: () => mode, onCommit: () => { if (disposeOnCommit) editorRef?.dispose(); } });
    const { editor } = await open(s.binder, [doc]);
    editorRef = editor; mode = "malformed"; disposeOnCommit = true;
    s.binder.configure(s.backend, catalog(2)); editor.fontsChanged(); await flush(); await flush();
    expect(refs(s)).toBe(0);
    expect(s.binder.retained().every((r) => r.refs >= 0)).toBe(true);
  });

  it.each(["malformed", "mutateThrow"] as const)("a superseded adopted %s commit obeys the uncertain-state guard", async (response) => {
    const s = service();
    s.binder.configure(s.backend, catalog(1));
    const doc = new FakeDocument(["x"]);
    let editorRef: RhwpEditorSession | null = null, mode: CommitMode = "ok", supersede = false;
    const engine = natural(doc, { commit: () => mode, onCommit: () => {
      if (supersede) { supersede = false; mode = "ok"; s.binder.configure(s.backend, catalog(3)); editorRef?.fontsChanged(); }
    } });
    const { editor } = await open(s.binder, [doc]);
    editorRef = editor; mode = response; supersede = true;
    s.binder.configure(s.backend, catalog(2)); editor.fontsChanged();
    await flush(); await flush(); await flush();
    expect(engine.commits).toBe(response === "malformed" ? 3 : 2);
    expect(consistent(engine, s.aliases())).toBe(true);
    expect(refs(s)).toBe(response === "malformed" ? 1 : 2);
    expect(editor.naturalFontStatus?.status).toBe(response === "malformed" ? "bound" : "uncertain");
    editor.dispose();
    expect(refs(s)).toBe(0);
  });

  it("T10: reload releases both uncertain leases before binding the replacement document", async () => {
    const s = service();
    s.binder.configure(s.backend, catalog(1));
    const oldDoc = new FakeDocument(["old"]), newDoc = new FakeDocument(["new"]);
    let mode: CommitMode = "ok";
    natural(oldDoc, { commit: () => mode });
    const replacement = natural(newDoc);
    const { editor, load, take } = await open(s.binder, [oldDoc, newDoc]);
    const oldLease = editor.naturalFontStatus!.lease!;
    mode = "mutateThrow";
    s.binder.configure(s.backend, catalog(2)); editor.fontsChanged(); await flush();
    const candidateLease = editor.naturalFontStatus!.lease!;
    expect(editor.status.kind).toBe("failed");
    expect(refs(s)).toBe(2);
    take("setState").reply(ok(info({ state: "failed", sequence: 3, loadGeneration: 1 })));
    await load(2, 4);
    expect(oldDoc.freed).toBe(true);
    expect(oldLease.released).toBe(true);
    expect(candidateLease.released).toBe(true);
    expect(editor.naturalFontStatus?.lease).not.toBe(candidateLease);
    expect(editor.naturalFontStatus?.status).toBe("bound");
    expect(consistent(replacement, s.aliases())).toBe(true);
    expect(refs(s)).toBe(1);
    editor.dispose(); editor.dispose();
    expect(refs(s)).toBe(0);
  });

  it("T9: a refused or uncertain commit in one document never releases a face the other document uses", async () => {
    const s = service();
    s.binder.configure(s.backend, catalog(1));
    const a = new FakeDocument(["a"]), b = new FakeDocument(["b"]);
    let mode: CommitMode = "ok", readback: StatusMode = "ok";
    const ea = natural(a), eb = natural(b, { commit: () => mode, status: () => readback });
    const first = await open(s.binder, [a]);
    const second = await open(s.binder, [b]);
    const shared = ea.active[0]!;
    mode = "reject"; second.editor.fontsChanged(); await flush();
    expect(s.aliases().has(shared)).toBe(true);
    mode = "mutateThrow"; readback = "throw"; s.binder.configure(s.backend, catalog(2)); second.editor.fontsChanged(); await flush();
    expect(second.editor.naturalFontStatus?.status).toBe("uncertain");
    s.binder.configure(s.backend, catalog(3));
    expect(consistent(ea, s.aliases())).toBe(true);
    expect(consistent(eb, s.aliases())).toBe(true);
    second.editor.dispose();
    expect(consistent(ea, s.aliases())).toBe(true);
    first.editor.dispose();
    expect(refs(s)).toBe(0);
  });

  it("T10: repeated refused commits do not accumulate leases or faces", async () => {
    const { s, editor, set } = await scenario("ok");
    set("reject");
    for (let g = 4; g < 14; g++) { s.binder.configure(s.backend, catalog(g)); editor.fontsChanged(); await flush(); }
    expect(editor.naturalFontStatus?.status).toBe("failed");
    expect(refs(s)).toBe(1); // only the adopted snapshot's lease
    expect(s.binder.retained().length).toBeLessThanOrEqual(2);
    editor.dispose();
    expect(refs(s)).toBe(0);
  });
});
