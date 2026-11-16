// Stage 5-A: RHWP natural font metrics — one exact font source for layout and Canvas paint.
//
// RHWP's own measurement is a table/heuristic model. For each document family key the engine reports
// (getNaturalFontRequests), this binder resolves an installed face through the shared font catalog (the same
// fontconfig/user-font database as everything else — never a path), fetches that face's exact bytes from the backend
// (font_face_data) and:
//   1. stages the bytes into the engine, which keeps only a bounded code point → advance table, and
//   2. loads the same bytes into the WebView as a FontFace under a private alias (`__geul_nf_<n>`).
// The engine paints with `"alias", …fallback aliases, <legacy chain>`, so the glyphs drawn are the glyphs measured.
// Binding never edits the document: the stored family names stay what the document says; a family that cannot be
// resolved exactly stays on the legacy model and is reported as unbound (never presented as natural).
import type { FontBackend, FontCatalog, FontFamily, FontStyle } from "../adapters/fonts";
import type { FontFaceSetLike } from "./webFonts";

/** Engine bound on faces in one snapshot (renderer/natural_metrics.rs). */
export const MAX_NATURAL_FACES = 64;
/** Most font bytes the binder keeps for staging into documents. */
export const MAX_NATURAL_CACHE_BYTES = 256 << 20;
/** Most document family keys one binding considers. Keys beyond it are reported in `omitted` (legacy metrics), never
 *  dropped silently. The engine itself enumerates at most 512 keys and flags the rest as `truncated`. */
export const MAX_REQUESTS = 128;
/** Parse bound on the engine response's request list (above the engine's own 512-key bound). */
const MAX_REPORTED_REQUESTS = 1024;
const MAX_FALLBACK_CANDIDATES = 6;

/** The engine surface this binder needs (a subset of RhwpDocument). */
export interface NaturalFontDocument {
  getNaturalFontRequests?(): string;
  beginNaturalFontSet?(): void;
  stageNaturalFontFace?(family: string, alias: string, bold: boolean, italic: boolean, bytes: Uint8Array, faceIndex: number): string;
  commitNaturalFontSet?(expectedFaces: number): string;
  clearNaturalFonts?(): boolean;
}

export interface NaturalBinding {
  /** bound: a snapshot was committed; unbound: nothing resolvable (legacy metrics); unsupported: engine/host lacks the
   *  surface; stale: the document changed owner before commit (nothing committed); failed: engine refused the commit. */
  status: "bound" | "unbound" | "unsupported" | "stale" | "failed";
  /** Engine snapshot generation after commit. */
  generation: number | null;
  /** key → installed family/styles actually bound. */
  bound: { key: string; family: string; styles: string[]; alias: string }[];
  /** Considered keys left on the legacy model (no exact installed face, or the face staging limit was reached). */
  unbound: string[];
  fallbacks: { family: string; alias: string }[];
  /** Reported keys beyond MAX_REQUESTS that were not considered (legacy metrics), in engine order. */
  omitted: string[];
  /** The engine reported more family keys than it enumerates; their names are unknown here (legacy metrics). */
  engineTruncated: boolean;
  /** Staging reached MAX_NATURAL_FACES; keys that did not fit are in `unbound`. */
  faceLimited: boolean;
  /** True only when every document family key is bound (nothing unbound, omitted or truncated). A "bound" status
   *  with complete=false is a partial binding: bound keys use natural metrics, the rest legacy metrics. */
  complete: boolean;
}

interface Source { family: string; style: string; bold: boolean; alias: string; index: number; bytes: Uint8Array }
interface Request { key: string; members: string[]; regular: boolean; bold: boolean }

type CreateFace = (family: string, bytes: Uint8Array, descriptors: FontFaceDescriptors) => FontFace;

const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

interface Requests { requests: Request[]; omitted: string[]; engineTruncated: boolean }

/** Validate the whole bounded engine response; keep the first MAX_REQUESTS for binding and account for the rest. */
function parseRequests(text: unknown): Requests | null {
  if (typeof text !== "string" || text.length > 4 << 20) return null;
  try {
    const value = JSON.parse(text) as { requests?: unknown; truncated?: unknown };
    if (!Array.isArray(value.requests) || value.requests.length > MAX_REPORTED_REQUESTS) return null;
    if (value.truncated !== undefined && typeof value.truncated !== "boolean") return null;
    const out: Request[] = [];
    const omitted: string[] = [];
    for (const r of value.requests) {
      if (!r || typeof r !== "object") return null;
      const { key, members, regular, bold } = r as Record<string, unknown>;
      if (typeof key !== "string" || !Array.isArray(members) || !members.every((m) => typeof m === "string")
        || typeof regular !== "boolean" || typeof bold !== "boolean") return null;
      if (out.length < MAX_REQUESTS) out.push({ key, members: members as string[], regular, bold });
      else omitted.push(key);
    }
    return { requests: out, omitted, engineTruncated: value.truncated === true };
  } catch { return null; }
}

/** The catalog family a CSS chain member names (typographic or localized name), when it can render. */
export function catalogFamily(catalog: FontCatalog, name: string): FontFamily | null {
  return catalog.families.find((f) => f.available && f.renderable
    && (same(f.family, name) || f.localized.some((l) => same(l.name, name)))) ?? null;
}

/** Upright face closest to `weight` within [min, max] (exact weight first). */
export function pickStyle(family: FontFamily, weight: number, min: number, max: number): FontStyle | null {
  const upright = family.styles.filter((s) => !s.italic && s.weight >= min && s.weight <= max);
  upright.sort((a, b) => Math.abs(a.weight - weight) - Math.abs(b.weight - weight) || a.name.localeCompare(b.name));
  return upright[0] ?? null;
}

export class NaturalFontService {
  private backend: FontBackend | null = null;
  private catalog: FontCatalog | null = null;
  private generation = -1;
  private previousGeneration = -1;
  private readonly sources = new Map<string, Promise<Source | null>>();
  private readonly faces = new Map<string, { generation: number; face: FontFace }>();
  private readonly aliases = new Map<string, string>();
  private cachedBytes = 0;
  private counter = 0;
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fonts: FontFaceSetLike | null = typeof document !== "undefined" && "fonts" in document ? document.fonts : null,
    private readonly create: CreateFace = (family, bytes, descriptors) => new FontFace(family, bytes as unknown as BufferSource, descriptors),
  ) {}

  /** Adopt the current catalog. A new catalog generation (refresh/register/remove) re-resolves every family; faces of
   *  the generation before the previous one are released (the previous one may still be painted until rebound). */
  configure(backend: FontBackend | null, catalog: FontCatalog | null): void {
    this.backend = backend;
    this.catalog = catalog;
    const next = catalog?.status.generation ?? -1;
    if (next === this.generation) return;
    this.previousGeneration = this.generation;
    this.generation = next;
    const keep = new Set([this.generation, this.previousGeneration]);
    for (const [key, entry] of this.faces) {
      if (!keep.has(entry.generation)) { this.fonts?.delete(entry.face); this.faces.delete(key); }
    }
    for (const key of [...this.sources.keys()]) {
      if (!keep.has(Number(key.split("\n")[0]))) {
        void this.sources.get(key)!.then((s) => { if (s) this.cachedBytes -= s.bytes.length; });
        this.sources.delete(key);
      }
    }
    for (const key of [...this.aliases.keys()]) if (!keep.has(Number(key.split("\n")[0]))) this.aliases.delete(key);
  }

  ready(): boolean { return this.backend !== null && this.catalog !== null; }

  /** Bind `doc` to the current catalog. Serialized: one engine stage at a time. `current` is checked before staging
   *  and immediately before commit; a stale document is never committed. */
  bind(doc: NaturalFontDocument, current: () => boolean): Promise<NaturalBinding> {
    const run = this.running.then(() => this.apply(doc, current), () => this.apply(doc, current));
    this.running = run.catch(() => undefined);
    return run;
  }

  private alias(family: string): string {
    const key = `${this.generation}\n${family.toLowerCase()}`;
    let alias = this.aliases.get(key);
    if (!alias) { alias = `__geul_nf_${++this.counter}`; this.aliases.set(key, alias); }
    return alias;
  }

  private source(family: FontFamily, style: FontStyle, bold: boolean): Promise<Source | null> {
    const key = `${this.generation}\n${family.family}\n${style.name}\n${bold}`;
    let pending = this.sources.get(key);
    if (!pending) {
      const backend = this.backend;
      const alias = this.alias(family.family);
      pending = (async () => {
        if (!backend) return null;
        const r = await backend.faceData(family.family, style.name);
        // A WebView FontFace reads only the first face of a collection: any other face would paint different glyphs
        // from the ones measured, so it stays on the legacy model.
        if (!r.ok || r.value.index !== 0 || this.cachedBytes + r.value.bytes.length > MAX_NATURAL_CACHE_BYTES) return null;
        this.cachedBytes += r.value.bytes.length;
        return { family: family.family, style: style.name, bold, alias, index: r.value.index, bytes: r.value.bytes };
      })().catch(() => null);
      this.sources.set(key, pending);
    }
    return pending;
  }

  /** Load the same bytes into the WebView under the alias. False if the WebView refuses the face. */
  private async webFace(source: Source): Promise<boolean> {
    const key = `${this.generation}\n${source.alias}\n${source.bold}`;
    if (this.faces.has(key)) return true;
    if (!this.fonts) return false;
    try {
      const face = this.create(source.alias, source.bytes, { weight: source.bold ? "700" : "400", style: "normal" });
      await face.load();
      this.fonts.add(face);
      this.faces.set(key, { generation: this.generation, face });
      return true;
    } catch { return false; }
  }

  private fallbackCandidates(catalog: FontCatalog): FontFamily[] {
    const korean = (f: FontFamily) => f.localized.some((l) => l.lang.toLowerCase().startsWith("ko"));
    const out: FontFamily[] = [];
    const push = (f: FontFamily | null) => { if (f && korean(f) && !out.includes(f)) out.push(f); };
    for (const g of catalog.generics) if (g.family) push(catalogFamily(catalog, g.family));
    for (const f of [...catalog.families].sort((a, b) => a.family.localeCompare(b.family))) push(f.available && f.renderable ? f : null);
    return out.slice(0, MAX_FALLBACK_CANDIDATES);
  }

  private async apply(doc: NaturalFontDocument, current: () => boolean): Promise<NaturalBinding> {
    const result: NaturalBinding = { status: "unsupported", generation: null, bound: [], unbound: [], fallbacks: [],
      omitted: [], engineTruncated: false, faceLimited: false, complete: false };
    const catalog = this.catalog;
    if (!catalog || !this.backend || !this.fonts || typeof doc.getNaturalFontRequests !== "function"
      || typeof doc.beginNaturalFontSet !== "function" || typeof doc.stageNaturalFontFace !== "function"
      || typeof doc.commitNaturalFontSet !== "function") return result;
    if (!current()) return { ...result, status: "stale" };
    const parsed = parseRequests(doc.getNaturalFontRequests());
    if (!parsed) return { ...result, status: "failed" };
    const { requests } = parsed;
    result.omitted = parsed.omitted;
    result.engineTruncated = parsed.engineTruncated;

    // Resolve and fetch outside the engine (asynchronous); stage only afterwards.
    const plan: { request: Request; family: FontFamily; sources: Source[] }[] = [];
    for (const request of requests) {
      const family = request.members.map((m) => catalogFamily(catalog, m)).find((f) => f !== null) ?? null;
      const regular = family && pickStyle(family, 400, 100, 599);
      if (!family || !regular) { result.unbound.push(request.key); continue; }
      const regularSource = await this.source(family, regular, false);
      if (!regularSource) { result.unbound.push(request.key); continue; }
      const sources = [regularSource];
      const boldStyle = request.bold ? pickStyle(family, 700, 600, 1000) : null;
      const boldSource = boldStyle && boldStyle.name !== regular.name ? await this.source(family, boldStyle, true) : null;
      if (boldSource) sources.push(boldSource);
      plan.push({ request, family, sources });
    }
    if (!current()) return { ...result, status: "stale" };

    // One staged face per installed family/style serves every key resolving to it (parsed once by the engine).
    const groups = new Map<string, { family: FontFamily; sources: Source[]; keys: string[]; boldKeys: string[] }>();
    for (const { request, family, sources } of plan) {
      const group = groups.get(family.family) ?? { family, sources, keys: [], boldKeys: [] };
      if (sources.length > group.sources.length) group.sources = sources;
      group.keys.push(request.key);
      if (request.bold) group.boldKeys.push(request.key);
      groups.set(family.family, group);
    }
    doc.beginNaturalFontSet();
    let staged = 0;
    const stage = (keys: string[], s: Source) => {
      if (staged >= MAX_NATURAL_FACES) { result.faceLimited = true; return false; }
      try { doc.stageNaturalFontFace!(keys.join("\n"), s.alias, s.bold, false, s.bytes, s.index); staged += 1; return true; } catch { return false; }
    };
    for (const { family, sources, keys, boldKeys } of groups.values()) {
      for (let i = 0; i < keys.length; i += 64) {
        const chunk = keys.slice(i, i + 64);
        // Load the WebView face first: a face the WebView cannot paint must not be measured.
        if (!(await this.webFace(sources[0]!)) || !stage(chunk, sources[0]!)) { result.unbound.push(...chunk); continue; }
        const bold = sources[1];
        const boldChunk = chunk.filter((k) => boldKeys.includes(k));
        const boldStaged = !!bold && boldChunk.length > 0 && (await this.webFace(bold)) && stage(boldChunk, bold);
        for (const key of chunk) {
          result.bound.push({ key, family: family.family, styles: boldStaged && boldChunk.includes(key) ? [sources[0]!.style, bold!.style] : [sources[0]!.style], alias: sources[0]!.alias });
        }
      }
    }
    if (result.bound.length > 0) {
      for (const candidate of this.fallbackCandidates(catalog)) {
        const style = pickStyle(candidate, 400, 100, 599);
        const s = style && await this.source(candidate, style, false);
        if (s && (await this.webFace(s)) && stage([""], s)) { result.fallbacks.push({ family: s.family, alias: s.alias }); break; }
      }
    }
    if (!current()) return { ...result, status: "stale" };
    try {
      if (staged === 0) {
        doc.clearNaturalFonts?.();
        return { ...result, status: "unbound" };
      }
      const committed = JSON.parse(doc.commitNaturalFontSet(staged)) as { generation?: unknown };
      const complete = result.unbound.length === 0 && result.omitted.length === 0 && !result.engineTruncated;
      return { ...result, status: "bound", complete, generation: typeof committed.generation === "number" ? committed.generation : null };
    } catch {
      return { ...result, status: "failed" };
    }
  }
}

/** The application's binder (configured by the font controller with the shared catalog). */
export const naturalFonts = new NaturalFontService();
