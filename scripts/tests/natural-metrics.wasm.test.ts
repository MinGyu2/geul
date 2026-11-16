// Stage 5-A natural font metrics against the actual authenticated Release engine.
//
// Expected advances come from an independent sfnt reader below (cmap format 4/12 + hmtx), not from the engine's
// ttf-parser path. Fonts are the OFL fixtures checked into the pinned RHWP submodule (deterministic, not installed
// system fonts): NotoSansKR-Regular (Latin + Hangul) and RHWPExactKerningSmoke (W/A/H/T/V/o only, narrow W).
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { preserveSourceCaret, type RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const out = join(root, "target/font-completion/natural-metrics"); mkdirSync(out, { recursive: true });
const fontPath = (rel: string) => join(root, "external/rhwp", rel);
const NOTO = readFileSync(fontPath("ttfs/opensource/NotoSansKR-Regular.ttf"));
const NOTO_LIGHT = readFileSync(fontPath("ttfs/opensource/NotoSansKR-ExtraLight.ttf"));
const SMOKE = readFileSync(fontPath("tests/fixtures/fonts/RHWPExactKerningSmoke.ttf"));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const evidence: Record<string, unknown> = {
  build: build.generation,
  fonts: { noto: sha(NOTO), notoLight: sha(NOTO_LIGHT), smoke: sha(SMOKE) },
};

// ---- independent sfnt oracle -------------------------------------------------------------------------------------
function oracle(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map<string, number>();
  for (let i = 0, n = v.getUint16(4); i < n; i++) {
    const at = 12 + 16 * i;
    tables.set(String.fromCharCode(...bytes.subarray(at, at + 4)), v.getUint32(at + 8));
  }
  const head = tables.get("head")!, hhea = tables.get("hhea")!, hmtx = tables.get("hmtx")!, cmap = tables.get("cmap")!;
  const upem = v.getUint16(head + 18), metrics = v.getUint16(hhea + 34);
  const glyphs = new Map<number, number>();
  for (let i = 0, n = v.getUint16(cmap + 2); i < n; i++) {
    const sub = cmap + v.getUint32(cmap + 4 + 8 * i + 4), format = v.getUint16(sub);
    if (format === 4) {
      const seg = v.getUint16(sub + 6) / 2, ends = sub + 14, starts = ends + 2 * seg + 2, deltas = starts + 2 * seg, ranges = deltas + 2 * seg;
      for (let k = 0; k < seg; k++) {
        const s = v.getUint16(starts + 2 * k), e = v.getUint16(ends + 2 * k), d = v.getInt16(deltas + 2 * k), r = v.getUint16(ranges + 2 * k);
        for (let c = s; c <= e && c !== 0xffff; c++) {
          let g = r === 0 ? (c + d) & 0xffff : v.getUint16(ranges + 2 * k + r + 2 * (c - s));
          if (r !== 0 && g !== 0) g = (g + d) & 0xffff;
          if (g !== 0 && !glyphs.has(c)) glyphs.set(c, g);
        }
      }
    } else if (format === 12) {
      for (let k = 0, groups = v.getUint32(sub + 12); k < groups; k++) {
        const at = sub + 16 + 12 * k, s = v.getUint32(at), e = v.getUint32(at + 4), g = v.getUint32(at + 8);
        for (let c = s; c <= e; c++) if (!glyphs.has(c)) glyphs.set(c, g + c - s);
      }
    }
  }
  return (ch: string): number | null => {
    const g = glyphs.get(ch.codePointAt(0)!);
    return g === undefined ? null : v.getUint16(hmtx + 4 * Math.min(g, metrics - 1)) / upem;
  };
}
const em = { noto: oracle(NOTO), smoke: oracle(SMOKE), light: oracle(NOTO_LIGHT) };

// ---- engine helpers ----------------------------------------------------------------------------------------------
function blank(text: string): RhwpDocument {
  const d = preserveSourceCaret(engine.HwpDocument.createEmpty()) as RhwpDocument & { createBlankDocument(): string };
  d.createBlankDocument();
  d.insertText(0, 0, 0, text);
  return d;
}
const rect = (d: RhwpDocument, offset: number) => JSON.parse(d.getCursorRect(0, 0, offset)) as { pageIndex: number; x: number; y: number; height: number };
const xs = (d: RhwpDocument, offsets: number[]) => offsets.map((o) => rect(d, o).x);
const keys = (d: RhwpDocument) => (JSON.parse(d.getNaturalFontRequests!()) as { requests: { key: string }[] }).requests.map((r) => r.key);
function bind(d: RhwpDocument, primary: Uint8Array | null, fallback: Uint8Array | null, tag = "a") {
  d.beginNaturalFontSet!();
  let n = 0;
  if (primary) for (const key of keys(d)) { d.stageNaturalFontFace!(key, `__geul_nf_${tag}p`, false, false, primary, 0); n++; }
  if (fallback) { d.stageNaturalFontFace!("", `__geul_nf_${tag}f`, false, false, fallback, 0); n++; }
  return JSON.parse(d.commitNaturalFontSet!(n)) as { generation: number; pageCount: number };
}

describe("RHWP natural font metrics (Release WASM)", () => {
  it("natural caret advances follow independently read font advances, with per-glyph fallback", () => {
    const text = "WWWWWoooo가나다라";
    const d = blank(text);
    try {
      const legacy = xs(d, [0, 5, 9, 13]);
      bind(d, SMOKE, NOTO);
      const x = xs(d, [0, 5, 9, 13]);
      expect(x).not.toEqual(legacy);
      // Size from the W span, then predict o (primary) and Hangul (not in primary → fallback face) spans.
      const size = (x[1]! - x[0]!) / (5 * em.smoke("W")!);
      const predictedO = 4 * em.smoke("o")! * size;
      const predictedHangul = [..."가나다라"].reduce((s, c) => s + em.noto(c)! * size, 0);
      expect(em.smoke("가")).toBeNull();
      expect(Math.abs(x[2]! - x[1]! - predictedO)).toBeLessThan(0.35);
      expect(Math.abs(x[3]! - x[2]! - predictedHangul)).toBeLessThan(0.35);
      // Legacy table/heuristic model would not give these spans.
      expect(Math.abs(legacy[1]! - legacy[0]! - 5 * em.smoke("W")! * size)).toBeGreaterThan(1);
      evidence.advances = { legacy, natural: x, sizePx: size, predictedO, predictedHangul };
      const status = JSON.parse(d.getNaturalFontStatus!());
      expect(status.active).toBe(true);
      expect(status.fallbacks).toHaveLength(1);
    } finally { d.free(); }
  });

  it("two fonts with different advances give different widths and move a controlled line wrap", () => {
    const short = blank("WWWWW"), long = blank("W".repeat(100));
    try {
      const secondLine = (d: RhwpDocument) => {
        const info = JSON.parse(d.getLineInfo(0, 0, 0)) as { lineIndex: number; lineCount: number; charEnd: number };
        expect(info.lineCount).toBeGreaterThanOrEqual(2);
        return info.charEnd; // first character of the second line
      };
      const legacyBreak = secondLine(long);
      bind(short, NOTO, null, "n"); bind(long, NOTO, null, "n");
      const notoWidth = rect(short, 5).x - rect(short, 0).x, notoBreak = secondLine(long);
      bind(short, SMOKE, null, "s"); bind(long, SMOKE, null, "s");
      const smokeWidth = rect(short, 5).x - rect(short, 0).x, smokeBreak = secondLine(long);
      // Widths follow the independently read advance ratio.
      expect(notoWidth / smokeWidth).toBeCloseTo(em.noto("W")! / em.smoke("W")!, 2);
      // The same column holds floor(column / advance) glyphs: predict each break from the other.
      const sizePx = smokeWidth / (5 * em.smoke("W")!);
      const column = (k: number, adv: number) => [k * adv * sizePx, (k + 1) * adv * sizePx] as const; // [fits, overflows]
      const [notoFits, notoOver] = column(notoBreak, em.noto("W")!), [smokeFits, smokeOver] = column(smokeBreak, em.smoke("W")!);
      expect(notoBreak).toBeLessThan(smokeBreak);
      // Both intervals must contain the (unknown) column width: they overlap.
      expect(Math.max(notoFits, smokeFits)).toBeLessThan(Math.min(notoOver, smokeOver) + 0.5);
      evidence.wrap = { legacyBreak, notoBreak, smokeBreak, notoWidth, smokeWidth, sizePx,
        columnInterval: [Math.max(notoFits, smokeFits), Math.min(notoOver, smokeOver)] };
    } finally { short.free(); long.free(); }
  });

  it.each(["hwp", "hwpx"] as const)("an unedited %s document exports byte-identically with and without natural binding", (format) => {
    const source = blank("한글 Natural WWWW oooo " + "W".repeat(80));
    let reopened: RhwpDocument | null = null;
    const exportOf = (d: RhwpDocument) => {
      const e = format === "hwp" ? d.exportHwpWithReport() : d.exportHwpxWithReport();
      try { return e.takeBytes(); } finally { e.free(); }
    };
    try {
      const bytes = exportOf(source);
      reopened = preserveSourceCaret(new engine.HwpDocument(bytes));
      const lines = JSON.parse(reopened.getLineInfo(0, 0, 10)).lineCount;
      const before = sha(exportOf(reopened));
      bind(reopened, NOTO, null, "e");
      expect(JSON.parse(reopened.getLineInfo(0, 0, 10)).lineCount).toBe(lines); // stored rows are document data
      expect(sha(exportOf(reopened))).toBe(before);
      reopened.clearNaturalFonts!();
      expect(sha(exportOf(reopened))).toBe(before);
      evidence[`unedited-${format}`] = { sha256: before, lines };
    } finally { source.free(); reopened?.free(); }
  });

  it("rebuilds, edits, snapshots and adoption keep one natural geometry; clear restores legacy", () => {
    const d = blank("WWWWoooo가나다");
    const other = blank("WWWWoooo가나다");
    try {
      const legacy = xs(d, [0, 4, 8, 11]);
      bind(d, SMOKE, NOTO);
      const natural = xs(d, [0, 4, 8, 11]);
      expect((d as unknown as { restoreSessionLayout(): number }).restoreSessionLayout()).toBeGreaterThan(0);
      expect(xs(d, [0, 4, 8, 11])).toEqual(natural);
      const snap = d.saveSnapshot();
      d.insertText(0, 0, 4, "W");
      const incremental = xs(d, [0, 5, 9, 12]);
      (d as unknown as { restoreSessionLayout(): number }).restoreSessionLayout();
      expect(xs(d, [0, 5, 9, 12])).toEqual(incremental);
      d.restoreSnapshot(snap); d.discardSnapshot(snap);
      expect(xs(d, [0, 4, 8, 11])).toEqual(natural);
      expect(other.adoptNaturalFontsFrom!(d)).toBe(true);
      expect(xs(other, [0, 4, 8, 11])).toEqual(natural);
      expect(d.clearNaturalFonts!()).toBe(true);
      expect(xs(d, [0, 4, 8, 11])).toEqual(legacy);
    } finally { d.free(); other.free(); }
  });

  it("hit testing and selection rectangles use the natural positions", () => {
    const d = blank("WWWWoooo가나다");
    try {
      bind(d, SMOKE, NOTO);
      const offsets = [0, 1, 2, 3, 4, 5, 8, 9, 10, 11];
      const positions = offsets.map((o) => rect(d, o));
      const hits: [number, number][] = [];
      for (const k of [0, 3, 4, 8, 9]) {
        const a = rect(d, k), b = rect(d, k + 1);
        for (const [frac, want] of [[0.25, k], [0.75, k + 1]] as const) {
          const hit = JSON.parse(d.hitTest(a.pageIndex, a.x + frac * (b.x - a.x), a.y + a.height / 2)) as { charOffset: number };
          hits.push([frac, hit.charOffset]);
          expect(hit.charOffset).toBe(want);
        }
      }
      const rects = JSON.parse(d.getSelectionRects(0, 0, 2, 0, 10)) as { x: number; width: number }[];
      expect(rects).toHaveLength(1);
      expect(Math.abs(rects[0]!.x - rect(d, 2).x)).toBeLessThan(0.6);
      expect(Math.abs(rects[0]!.x + rects[0]!.width - rect(d, 10).x)).toBeLessThan(0.6);
      evidence.geometry = { positions, hits, selection: rects };
    } finally { d.free(); }
  });

  it("bad sources and stale stages fail closed without touching layout or document fonts", () => {
    const d = blank("ABC가");
    try {
      const before = xs(d, [0, 4]), fonts = d.getDocumentFontTable!();
      d.beginNaturalFontSet!();
      expect(() => d.stageNaturalFontFace!(keys(d)[0]!, "__geul_nf_bad", false, false, new Uint8Array([1, 2, 3, 4]), 0)).toThrow();
      expect(() => d.stageNaturalFontFace!(keys(d)[0]!, "bad alias", false, false, NOTO, 0)).toThrow();
      expect(() => d.commitNaturalFontSet!(1)).toThrow();
      expect(() => d.commitNaturalFontSet!(0)).toThrow(); // stage consumed
      expect(xs(d, [0, 4])).toEqual(before);
      expect(JSON.parse(d.getNaturalFontStatus!()).active).toBe(false);
      bind(d, NOTO_LIGHT, null, "l");
      expect(d.getDocumentFontTable!()).toBe(fonts); // stored family identities untouched
    } finally { d.free(); }
  });

  it("script coverage: combining marks stay in their cluster; ligatures and RTL are recorded, not claimed", () => {
    const text = "Ae\u0301o 가나 fi \u05e9\u05dc\u05d5\u05dd";
    const d = blank(text);
    try {
      bind(d, NOTO, null, "c");
      const n = [...text].length;
      const x = Array.from({ length: n + 1 }, (_, k) => rect(d, k).x);
      const size = (x[1]! - x[0]!) / em.noto("A")!;
      // e + U+0301 is one cluster: the cluster advances by the base glyph only (the painter draws the cluster as one unit).
      expect(em.noto("\u0301")).not.toBeNull();
      const cluster = x[3]! - x[1]!;
      expect(Math.abs(cluster - em.noto("e")! * size)).toBeLessThan(0.35);
      // Hangul syllables use the bound face.
      expect(Math.abs(x[7]! - x[6]! - em.noto("가")! * size)).toBeLessThan(0.35);
      // Evidence only: "fi" is measured as two glyphs (no ligature substitution in this path); Hebrew is unsupported here.
      evidence.scripts = { x, size, fi: [x[10]! - x[9]!, x[11]! - x[10]!], hebrewCovered: em.noto("\u05e9") !== null };
    } finally { d.free(); }
  });

  it("records evidence", () => {
    writeFileSync(join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
    expect(evidence.advances).toBeTruthy();
  });
});
