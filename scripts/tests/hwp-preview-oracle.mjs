// Independent verification of a regenerated HWP PrvImage (Stage 5-A S5-6), used by stage4-native-oracle.mjs.
//
// The save service accepts a changed PrvImage only as the exact canonical PNG it encoded for that save from a page-1
// render (services/save/hwp.rs `refresh_previews`, preview.rs `encode_png`). Offline, without the service's in-memory
// evidence, this module proves as much as the published bytes allow:
//  1. completeness/validity: strict canonical decode — signature, exactly IHDR/IDAT/IEND with valid CRCs, IHDR
//     RGB8 non-interlaced, one complete zlib stream consuming the whole IDAT, filter 0 on every row, exact size;
//  2. size: equal to the preview size the published file's own Section0 PAGE_DEF implies (1024 px long side,
//     re-derived here, not taken from geul);
//  3. attribution to this document: the pixels must match an independent render of page 1 of the *published* file
//     (Release RHWP `renderPageSvg` rasterized by librsvg, a different rasterizer from the WebView canvas) by block
//     luminance correlation; an arbitrary, blank or other-document PNG does not;
//  4. regeneration: the original had a PrvImage and the bytes differ from it.
// Not provable offline: byte identity with the PNG the service encoded in memory for that save. That remains the
// product gate (hwp.rs compares the output PrvImage with this save's encoding) and its unit tests; it is reported as
// `serviceIdentity: "product-gate"`, never as independently verified.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crc32, inflateSync } from "node:zlib";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
export const PREVIEW_LONG_SIDE = 1024;
/** Minimum block-luminance correlation with the independent page-1 render (calibrated on Stage 4 publications). */
export const MIN_CORRELATION = 0.8;
const BLOCK = 16;

const sha = (b) => createHash("sha256").update(b).digest("hex");
const fail = (message) => { throw new Error(message); };

/** PrvImage/PrvText streams and Section0's first PAGE_DEF (width, height, landscape) of an HWP file. */
export function hwpFacts(path) {
  const script = `import importlib.util,sys,json,base64,struct
s=importlib.util.spec_from_file_location('d',sys.argv[1]);d=importlib.util.module_from_spec(s);s.loader.exec_module(d)
st=d.cfb_streams(open(sys.argv[2],'rb').read())
pd=next((r[2] for r in d.records(d.unpacked(st,'BodyText/Section0')) if r[0]==73),None)
page=list(struct.unpack_from('<II',pd,0))+[bool(struct.unpack_from('<I',pd,36)[0]&1)] if pd and len(pd)>=40 else None
print(json.dumps({'prvImage':base64.b64encode(st['PrvImage']).decode() if 'PrvImage' in st else None,'pageDef':page}))`;
  const facts = JSON.parse(execFileSync("python3", ["-I", "-c", script, join(ROOT, "scripts/tests/hwp_record_diff.py"), path], { encoding: "utf8" }));
  return { prvImage: facts.prvImage === null ? null : Buffer.from(facts.prvImage, "base64"), pageDef: facts.pageDef };
}

/** The preview size for a PAGE_DEF, re-derived (same rounding contract as the HWP preview: half-up on the short side). */
export function previewDimensions(width, height, landscape) {
  if (!(width > 0 && height > 0)) fail("PAGE_DEF has no size");
  const [w, h] = landscape ? [height, width] : [width, height];
  const major = Math.max(w, h), minor = Math.min(w, h);
  const short = Math.max(1, Math.floor((2 * PREVIEW_LONG_SIDE * minor + major) / (2 * major)));
  return w >= h ? [PREVIEW_LONG_SIDE, short] : [short, PREVIEW_LONG_SIDE];
}

function chunks(png) {
  if (png.length < 8 || !png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) fail("not a PNG signature");
  const out = [];
  for (let at = 8; at < png.length;) {
    if (at + 12 > png.length) fail("truncated chunk header");
    const length = png.readUInt32BE(at), type = png.subarray(at + 4, at + 8).toString("latin1");
    if (at + 12 + length > png.length) fail(`truncated ${type} chunk`);
    const body = png.subarray(at + 8, at + 8 + length);
    if (crc32(png.subarray(at + 4, at + 8 + length)) >>> 0 !== png.readUInt32BE(at + 8 + length)) fail(`bad CRC in ${type}`);
    out.push({ type, body });
    at += 12 + length;
  }
  return out;
}

/** Strict canonical decode (see module header). Returns { width, height, rgb } or throws with the reason. */
export function decodeCanonicalPng(png) {
  const list = chunks(png);
  if (list.map((c) => c.type).join(",") !== "IHDR,IDAT,IEND" || list[2].body.length !== 0) fail(`non-canonical chunks ${list.map((c) => c.type)}`);
  const ihdr = list[0].body;
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  if (ihdr.length !== 13 || ihdr[8] !== 8 || ihdr[9] !== 2 || ihdr[10] || ihdr[11] || ihdr[12]) fail("IHDR is not RGB8, non-interlaced");
  if (!(width >= 1 && width <= PREVIEW_LONG_SIDE && height >= 1 && height <= PREVIEW_LONG_SIDE)) fail(`preview size ${width}x${height} out of range`);
  const row = width * 3, expected = (row + 1) * height;
  let raw;
  try {
    const result = inflateSync(list[1].body, { info: true, maxOutputLength: expected + 1 });
    if (result.engine.bytesWritten !== list[1].body.length) fail("trailing data after the zlib stream");
    raw = result.buffer;
  } catch (error) { fail(`IDAT does not inflate completely (${error.message})`); }
  if (raw.length !== expected) fail(`IDAT holds ${raw.length} bytes, expected ${expected}`);
  const rgb = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    if (raw[y * (row + 1)] !== 0) fail(`row ${y} uses filter ${raw[y * (row + 1)]}, canonical previews use 0`);
    raw.copy(rgb, y * row, y * (row + 1) + 1, (y + 1) * (row + 1));
  }
  return { width, height, rgb };
}

/** General PNG decode for the reference raster (8-bit RGB/RGBA/gray, any filter, non-interlaced). Returns RGB on white. */
export function decodePng(png) {
  const list = chunks(png);
  const ihdr = list.find((c) => c.type === "IHDR").body;
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4), depth = ihdr[8], color = ihdr[9];
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color];
  if (depth !== 8 || !channels || ihdr[12]) fail("unsupported reference PNG");
  const raw = inflateSync(Buffer.concat(list.filter((c) => c.type === "IDAT").map((c) => c.body)));
  const stride = width * channels, px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0, b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y ? px[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      if (pred === undefined) fail(`bad filter ${filter}`);
      px[y * stride + x] = (line[x] + pred) & 255;
    }
  }
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const s = px.subarray(i * channels, (i + 1) * channels);
    const [r, g, b, alpha] = channels >= 3 ? [s[0], s[1], s[2], channels === 4 ? s[3] : 255] : [s[0], s[0], s[0], channels === 2 ? s[1] : 255];
    for (const [k, v] of [r, g, b].entries()) rgb[i * 3 + k] = Math.round((v * alpha + 255 * (255 - alpha)) / 255);
  }
  return { width, height, rgb };
}

/** Independent page-1 reference raster of an HWP at width×height: Release RHWP SVG, rasterized by librsvg. */
export function referenceRaster(engine, bytes, width, height) {
  const d = new engine.HwpDocument(bytes);
  let svg;
  try { svg = d.renderPageSvg(0); } finally { d.free(); }
  const dir = mkdtempSync(join(tmpdir(), "geul-prv-"));
  try {
    writeFileSync(join(dir, "p1.svg"), svg);
    execFileSync("rsvg-convert", ["-w", String(width), "-h", String(height), "-b", "white", "-o", join(dir, "p1.png"), join(dir, "p1.svg")]);
    return decodePng(readFileSync(join(dir, "p1.png")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Pearson correlation of BLOCK×BLOCK mean luminance of two same-size RGB rasters (robust to rasterizer details). */
export function blockCorrelation(a, b) {
  if (a.width !== b.width || a.height !== b.height) fail("raster sizes differ");
  const bw = Math.ceil(a.width / BLOCK), bh = Math.ceil(a.height / BLOCK);
  const means = (img) => {
    const sum = new Float64Array(bw * bh), n = new Float64Array(bw * bh);
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 3, k = Math.floor(y / BLOCK) * bw + Math.floor(x / BLOCK);
      sum[k] += 0.299 * img.rgb[i] + 0.587 * img.rgb[i + 1] + 0.114 * img.rgb[i + 2]; n[k]++;
    }
    return sum.map((s, k) => s / n[k]);
  };
  const [p, q] = [means(a), means(b)];
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const [mp, mq] = [mean(p), mean(q)];
  let num = 0, dp = 0, dq = 0;
  for (let k = 0; k < p.length; k++) { num += (p[k] - mp) * (q[k] - mq); dp += (p[k] - mp) ** 2; dq += (q[k] - mq) ** 2; }
  return dp === 0 || dq === 0 ? 0 : num / Math.sqrt(dp * dq);
}

/** Evidence for a regenerated PrvImage of `published` (an edited save of `original`), or throws with the reason. */
export function verifyRegeneratedPreview(engine, originalPath, publishedPath) {
  const before = hwpFacts(originalPath), after = hwpFacts(publishedPath);
  if (!before.prvImage) fail("original has no PrvImage to regenerate");
  if (!after.prvImage) fail("published file has no PrvImage");
  if (after.prvImage.equals(before.prvImage)) fail("PrvImage was not regenerated");
  if (!after.pageDef) fail("published Section0 has no PAGE_DEF");
  const decoded = decodeCanonicalPng(after.prvImage);
  const [w, h] = previewDimensions(...after.pageDef);
  if (decoded.width !== w || decoded.height !== h) fail(`PrvImage ${decoded.width}x${decoded.height} != ${w}x${h} from PAGE_DEF`);
  const reference = referenceRaster(engine, readFileSync(publishedPath), w, h);
  const correlation = blockCorrelation(decoded, reference);
  if (!(correlation >= MIN_CORRELATION)) fail(`PrvImage does not depict page 1 of the published file (correlation ${correlation.toFixed(3)})`);
  return { sha256: sha(after.prvImage), bytes: after.prvImage.length, width: w, height: h, pageDef: after.pageDef,
    correlation: Number(correlation.toFixed(4)), canonical: true, serviceIdentity: "product-gate" };
}

/**
 * The independent T009 verdict for a published HWP: safe with no findings, or exactly one `partChanged PrvImage`
 * whose regenerated preview passes `verifyRegeneratedPreview`. Any other finding fails.
 */
export function judgeT009(result, engine, originalPath, publishedPath) {
  const findings = Array.isArray(result?.findings) ? result.findings : fail("malformed T009 result");
  if (result.outcome === "safe" && findings.length === 0) return { outcome: "safe", findings, preview: null };
  const previewOnly = findings.length === 1 && findings[0].code === "partChanged" && findings[0].part === "PrvImage";
  if (!previewOnly) fail(`independent T009 findings ${JSON.stringify(findings)}`);
  return { outcome: result.outcome, findings, preview: verifyRegeneratedPreview(engine, originalPath, publishedPath) };
}
