// Stage 5-A natural-metric binder: resolution through the shared catalog, exact sources, fail-closed paths.
import { describe, expect, it } from "vitest";
import type { FontBackend, FontCatalog, FontFamily } from "../adapters/fonts";
import { catalogFamily, MAX_NATURAL_FACES, MAX_REQUESTS, NaturalFontService, pickStyle, type NaturalFontDocument } from "./naturalFonts";

const family = (name: string, styles: [string, number][], localized: { lang: string; name: string }[] = []): FontFamily => ({
  id: name, family: name, localized, source: "system", available: true, renderable: true,
  styles: styles.map(([n, weight]) => ({ name: n, weight, italic: n.includes("Italic") })),
});
const catalog = (generation: number, families: FontFamily[]): FontCatalog => ({
  status: { provider: "fontconfig", fontconfigAvailable: true, fontconfigVersion: "2", fontconfigError: null, systemFaces: 9, generation,
    userFontStorage: true, skippedUserFonts: [] },
  families, generics: [{ generic: "sans-serif", family: "Hangul Sans" }], userFonts: [],
});
const FAMILIES = [
  family("Latin Serif", [["Regular", 400], ["Bold", 700], ["Italic", 400]]),
  family("Hangul Sans", [["Regular", 400]], [{ lang: "ko", name: "한글 산스" }]),
  family("Medium Only", [["Medium", 500]]),
];

class FakeFace {
  constructor(readonly family: string, readonly bytes: Uint8Array, readonly descriptors: FontFaceDescriptors) {}
  async load() { if (this.family === "refuse") throw new Error("x"); return this as unknown as FontFace; }
}

function setup(requests: { key: string; members: string[]; regular?: boolean; bold?: boolean }[], options: { refuseWeb?: string; collection?: string; truncated?: boolean } = {}) {
  const fetched: string[] = [];
  const backend = {
    faceData: async (f: string, s: string) => { fetched.push(`${f}/${s}`); return { ok: true as const, value: { index: f === options.collection ? 1 : 0, bytes: new TextEncoder().encode(`${f}/${s}`) } }; },
  } as unknown as FontBackend;
  const set = new Set<FontFace>();
  const created: FakeFace[] = [];
  const service = new NaturalFontService({ add: (f) => set.add(f), delete: (f) => set.delete(f) }, (alias, bytes, d) => {
    const face = new FakeFace(new TextDecoder().decode(bytes) === options.refuseWeb ? "refuse" : alias, bytes, d);
    created.push(face); return face as unknown as FontFace;
  });
  const staged: [string, string, boolean, string][] = [];
  let committed: number | null = null, cleared = 0;
  const doc: NaturalFontDocument = {
    getNaturalFontRequests: () => JSON.stringify({ truncated: options.truncated ?? false, requests: requests.map((r) => ({ regular: true, bold: false, ...r })) }),
    beginNaturalFontSet: () => { staged.length = 0; },
    stageNaturalFontFace: (key, alias, bold, _italic, bytes) => {
      if (new TextDecoder().decode(bytes).startsWith("Hangul Sans") && options.refuseWeb === "engine") throw new Error("unsupported-variation");
      staged.push([key, alias, bold, new TextDecoder().decode(bytes)]); return "{}";
    },
    commitNaturalFontSet: (n) => { if (n !== staged.length) throw new Error("count"); committed = n; return JSON.stringify({ generation: 7 }); },
    clearNaturalFonts: () => { cleared++; return true; },
  };
  return { service, backend, doc, staged, created, set, fetched, state: () => ({ committed, cleared }) };
}

describe("natural font binder", () => {
  it("resolves members through typographic or localized catalog names and picks upright styles", () => {
    const c = catalog(1, FAMILIES);
    expect(catalogFamily(c, "한글 산스")?.family).toBe("Hangul Sans");
    expect(catalogFamily(c, "latin serif")?.family).toBe("Latin Serif");
    expect(catalogFamily(c, "Missing")).toBeNull();
    expect(pickStyle(FAMILIES[0]!, 700, 600, 1000)?.name).toBe("Bold");
    expect(pickStyle(FAMILIES[2]!, 400, 100, 599)?.name).toBe("Medium");
    expect(pickStyle(FAMILIES[2]!, 700, 600, 1000)).toBeNull();
  });

  it("binds each key to exact sources, loads the same bytes as WebView faces, adds a Korean fallback and commits once", async () => {
    const t = setup([{ key: "Missing,Latin Serif", members: ["Missing", "Latin Serif"], bold: true }, { key: "Unknown", members: ["Unknown"] }]);
    t.service.configure(t.backend, catalog(1, FAMILIES));
    const result = await t.service.bind(t.doc, () => true);
    expect(result.status).toBe("bound");
    expect(result.unbound).toEqual(["Unknown"]);
    expect(result.bound).toEqual([{ key: "Missing,Latin Serif", family: "Latin Serif", styles: ["Regular", "Bold"], alias: expect.stringMatching(/^__geul_nf_\d+$/) }]);
    expect(result.fallbacks.map((f) => f.family)).toEqual(["Hangul Sans"]);
    expect(t.staged.map(([k, , b, src]) => [k, b, src])).toEqual([["Missing,Latin Serif", false, "Latin Serif/Regular"],
      ["Missing,Latin Serif", true, "Latin Serif/Bold"], ["", false, "Hangul Sans/Regular"]]);
    expect(t.state().committed).toBe(3);
    // The WebView face for every staged source has the identical bytes and the bound weight descriptor.
    expect(t.created.map((f) => [new TextDecoder().decode(f.bytes), f.descriptors.weight])).toEqual([["Latin Serif/Regular", "400"],
      ["Latin Serif/Bold", "700"], ["Hangul Sans/Regular", "400"]]);
    expect(t.created.every((f, i) => f.family === t.staged[i]![1])).toBe(true);
  });

  it("keys that resolve to the same installed family share one staged face (one parse, one alias)", async () => {
    const t = setup([{ key: "Latin Serif", members: ["Latin Serif"] }, { key: "Alias,Latin Serif", members: ["Alias", "Latin Serif"] }]);
    t.service.configure(t.backend, catalog(1, FAMILIES));
    const result = await t.service.bind(t.doc, () => true);
    expect(t.staged.filter(([, , , src]) => src === "Latin Serif/Regular").map(([k]) => k)).toEqual(["Latin Serif\nAlias,Latin Serif"]);
    expect(new Set(result.bound.map((b) => b.alias)).size).toBe(1);
    expect(t.fetched.filter((f) => f === "Latin Serif/Regular")).toHaveLength(1);
  });

  it("never commits for a stale document, and leaves unresolved documents on legacy metrics", async () => {
    const t = setup([{ key: "Latin Serif", members: ["Latin Serif"] }]);
    t.service.configure(t.backend, catalog(1, FAMILIES));
    expect((await t.service.bind(t.doc, () => false)).status).toBe("stale");
    expect(t.state().committed).toBeNull();
    const u = setup([{ key: "Nope", members: ["Nope"] }]);
    u.service.configure(u.backend, catalog(1, FAMILIES));
    expect((await u.service.bind(u.doc, () => true)).status).toBe("unbound");
    expect(u.state()).toEqual({ committed: null, cleared: 1 });
    const n = setup([{ key: "Latin Serif", members: ["Latin Serif"] }]);
    expect((await n.service.bind(n.doc, () => true)).status).toBe("unsupported"); // no catalog yet
  });

  it("a face the WebView refuses is not measured; an engine-refused fallback tries the next candidate", async () => {
    const t = setup([{ key: "Latin Serif", members: ["Latin Serif"] }], { refuseWeb: "Latin Serif/Regular" });
    t.service.configure(t.backend, catalog(1, FAMILIES));
    const r = await t.service.bind(t.doc, () => true);
    expect(r.status).toBe("unbound");
    expect(t.staged).toEqual([]);
    const e = setup([{ key: "Latin Serif", members: ["Latin Serif"] }], { refuseWeb: "engine" });
    e.service.configure(e.backend, catalog(1, FAMILIES));
    const bound = await e.service.bind(e.doc, () => true);
    expect(bound.status).toBe("bound");
    expect(bound.fallbacks).toEqual([]); // the only Korean candidate was refused by the engine
  });

  it("a non-first collection face is never bound (the WebView would paint face 0)", async () => {
    const t = setup([{ key: "Latin Serif", members: ["Latin Serif"] }], { collection: "Latin Serif" });
    t.service.configure(t.backend, catalog(1, FAMILIES));
    const r = await t.service.bind(t.doc, () => true);
    expect(r.unbound).toEqual(["Latin Serif"]);
    expect(t.staged.filter(([k]) => k === "Latin Serif")).toEqual([]);
  });

  it("a new catalog generation re-resolves; old faces are released when their lease is, not by a generation window", async () => {
    const t = setup([{ key: "Latin Serif", members: ["Latin Serif"] }]);
    t.service.configure(t.backend, catalog(1, FAMILIES));
    const first = await t.service.bind(t.doc, () => true);
    const gen1 = new Set(t.set);
    t.service.configure(t.backend, catalog(2, FAMILIES));
    const second = await t.service.bind(t.doc, () => true);
    t.service.configure(t.backend, catalog(3, FAMILIES));
    expect([...gen1].every((f) => t.set.has(f))).toBe(true); // still leased: survives two newer generations
    t.service.release(first.lease);
    expect([...gen1].some((f) => t.set.has(f))).toBe(false); // released with its last lease
    expect(t.fetched.filter((f) => f === "Latin Serif/Regular")).toHaveLength(2);
    t.service.release(second.lease);
    t.service.release(second.lease); // idempotent
    expect(t.service.retained().every((r) => r.refs === 0)).toBe(true);
  });
});

describe("natural font request limit accounting", () => {
  // Unresolvable keys (no catalog family) stay on legacy metrics without fetching anything.
  const missing = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ key: `Missing ${from + i}`, members: [`Missing ${from + i}`] }));
  const bound = { key: "Latin Serif", members: ["Latin Serif"] };

  it.each([[127, 0], [128, 0], [129, 1], [512, 512 - MAX_REQUESTS]])("B1-B4: %i reported requests -> %i omitted, bounded processing", async (n, omittedCount) => {
    const requests = [bound, ...missing(n - 1)];
    const t = setup(requests);
    t.service.configure(t.backend, catalog(1, FAMILIES));
    const r = await t.service.bind(t.doc, () => true);
    expect(MAX_REQUESTS).toBe(128);
    expect(r.omitted).toHaveLength(omittedCount);
    expect(r.omitted).toEqual(requests.slice(MAX_REQUESTS).map((q) => q.key)); // identities preserved, engine order
    expect(r.bound.length + r.unbound.length).toBe(Math.min(n, MAX_REQUESTS)); // nothing beyond the limit considered
    expect(r.status).toBe("bound");
    expect(r.complete).toBe(false); // the missing families stay on legacy metrics
    expect(t.fetched.length).toBeLessThanOrEqual(2);
  });

  it("B2/B5: a fully bound boundary is complete; the engine truncation flag forbids completeness", async () => {
    const t = setup([bound]);
    t.service.configure(t.backend, catalog(1, FAMILIES));
    const full = await t.service.bind(t.doc, () => true);
    expect([full.status, full.complete, full.omitted, full.engineTruncated]).toEqual(["bound", true, [], false]);
    const tr = setup([bound], { truncated: true });
    tr.service.configure(tr.backend, catalog(1, FAMILIES));
    const truncated = await tr.service.bind(tr.doc, () => true);
    expect([truncated.status, truncated.engineTruncated, truncated.complete]).toEqual(["bound", true, false]);
    expect(truncated.omitted).toEqual([]); // no fabricated names for families the engine did not enumerate
  });

  it("B6: resolvable keys inside the limit bind; an excess resolvable key is omitted, not staged or borrowed", async () => {
    const requests = [...missing(MAX_REQUESTS - 1), bound, { key: "Excess Latin", members: ["Latin Serif"] }];
    const t = setup(requests);
    t.service.configure(t.backend, catalog(1, FAMILIES));
    const r = await t.service.bind(t.doc, () => true);
    expect(r.bound.map((b) => b.key)).toEqual(["Latin Serif"]);
    expect(r.omitted).toEqual(["Excess Latin"]);
    expect(t.staged.some(([k]) => k.split("\n").includes("Excess Latin"))).toBe(false);
    expect(r.complete).toBe(false);
  });

  it("B7: staging stops at the face limit; the committed set and the result report it", async () => {
    const families = Array.from({ length: 70 }, (_, i) => family(`F${i}`, [["Regular", 400]]));
    const t = setup(families.map((f) => ({ key: f.family, members: [f.family] })));
    t.service.configure(t.backend, catalog(1, families));
    const r = await t.service.bind(t.doc, () => true);
    expect(t.state().committed).toBe(MAX_NATURAL_FACES);
    expect(t.staged).toHaveLength(MAX_NATURAL_FACES);
    expect(r.bound).toHaveLength(MAX_NATURAL_FACES);
    expect(r.unbound).toHaveLength(70 - MAX_NATURAL_FACES);
    expect([r.status, r.faceLimited, r.complete]).toEqual(["bound", true, false]);
  });

  it("B8: a new catalog generation recalculates bound, unbound and omitted keys from the current requests", async () => {
    const requests = [bound, { key: "Later Font", members: ["Later Font"] }, ...missing(MAX_REQUESTS)];
    const t = setup(requests);
    t.service.configure(t.backend, catalog(1, FAMILIES));
    const first = await t.service.bind(t.doc, () => true);
    expect(first.unbound).toContain("Later Font");
    t.service.configure(t.backend, catalog(2, [...FAMILIES, family("Later Font", [["Regular", 400]])]));
    const second = await t.service.bind(t.doc, () => true);
    expect(second.bound.map((b) => b.key).sort()).toEqual(["Later Font", "Latin Serif"]);
    expect(second.unbound).not.toContain("Later Font");
    expect(second.omitted).toEqual(first.omitted);
    expect(second.omitted).toHaveLength(2);
  });

  it("an oversized or malformed request list fails closed", async () => {
    const t = setup(missing(1025));
    t.service.configure(t.backend, catalog(1, FAMILIES));
    expect((await t.service.bind(t.doc, () => true)).status).toBe("failed");
    expect(t.state().committed).toBeNull();
  });
});
