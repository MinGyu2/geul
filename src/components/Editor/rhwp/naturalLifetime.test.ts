// Stage 5-A: WebView faces used by a document's committed natural-font snapshot stay retained for as long as that
// snapshot is active (document leases), across any number of catalog generations; they are released only after a
// newer snapshot is adopted, or the document is reloaded/disposed. Stale bindings never attach ownership.
import { describe, expect, it } from "vitest";
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

/** Natural engine surface on top of the editing fake: tracks the aliases its committed snapshot paints with. */
function natural(doc: FakeDocument, options: { failCommit?: () => boolean; onCommit?: () => void } = {}) {
  const engine = { active: [] as string[], pending: [] as string[], commits: 0 };
  Object.assign(doc, {
    getNaturalFontRequests: () => JSON.stringify({ truncated: false, requests: [{ key: "Doc Font", members: ["Doc Font"], regular: true, bold: false }] }),
    beginNaturalFontSet: () => { engine.pending = []; },
    stageNaturalFontFace: (_k: string, alias: string) => { engine.pending.push(alias); return "{}"; },
    commitNaturalFontSet: (n: number) => {
      if (options.failCommit?.() || n !== engine.pending.length) throw new Error("refused");
      engine.active = engine.pending; engine.commits += 1; options.onCommit?.();
      return JSON.stringify({ generation: engine.commits });
    },
    clearNaturalFonts: () => { engine.active = []; return true; },
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
    take("load").reply(loaded(new Uint8Array([1]), generation));
    await flush();
    take("session").reply(ok(info({ state: "loading", sequence, loadGeneration: generation })));
    take("setState").reply(ok(info({ state: "ready", sequence: sequence + 1, loadGeneration: generation })));
    await loading;
    await flush();
  };
  await load(1, 1);
  return { editor, load };
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
