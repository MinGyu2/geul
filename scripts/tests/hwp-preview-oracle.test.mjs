// Stage 5-A S5-6: positive and negative controls for the regenerated-PrvImage oracle (hwp-preview-oracle.mjs).
//   node --test scripts/tests/hwp-preview-oracle.test.mjs
// Uses the real Stage 4 native publications (ignored target/stage4-native, see docs/architecture/stage567-…);
// skipped when they are absent. Tampered copies are written to target/stage5a/s5-6 by rewriting one CFB stream in
// place (same sector chain, size field updated), so every other byte of the published file is unchanged.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { deflateSync, crc32 } from "node:zlib";
import { loadRelease } from "./advanced-production-runtime.mjs";
import { decodeCanonicalPng, hwpFacts, judgeT009, previewDimensions, previewMatchesReference, verifyRegeneratedPreview } from "./hwp-preview-oracle.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const CHECKER = join(ROOT, "src-tauri/target/debug/examples/save_check");
const RUN = join(ROOT, "target/stage4-native/run2");
const ORIGINAL = join(RUN, "undo-save.hwp"); // the file composite-save.hwp replaced (Stage 4 run order)
const PUBLISHED = join(RUN, "composite-save.hwp");
const OUT = join(ROOT, "target/stage5a/s5-6");
const available = existsSync(PUBLISHED) && existsSync(ORIGINAL) && existsSync(CHECKER);
const { engine } = loadRelease();

/** Rewrite stream `name` (root storage) of a CFB file in place. Regular streams must stay ≥ the mini cutoff. */
function replaceStream(bytes, name, data) {
  const out = Buffer.from(bytes);
  const ss = 1 << out.readUInt16LE(30), ms = 1 << out.readUInt16LE(32);
  const nFat = out.readUInt32LE(44), dirStart = out.readUInt32LE(48), cutoff = out.readUInt32LE(56), miniFatStart = out.readUInt32LE(60);
  const sector = (i) => (i + 1) * ss;
  const difat = Array.from({ length: 109 }, (_, i) => out.readUInt32LE(76 + 4 * i)).slice(0, nFat);
  assert.equal(out.readUInt32LE(72), 0, "fixture uses no DIFAT sectors");
  const fat = difat.flatMap((s) => Array.from({ length: ss / 4 }, (_, i) => out.readUInt32LE(sector(s) + 4 * i)));
  const chain = (start, table) => { const c = []; while (start < 0xfffffffa && c.length < table.length) { c.push(start); start = table[start]; } return c; };
  const dirSectors = chain(dirStart, fat);
  const entryAt = (i) => sector(dirSectors[Math.floor((i * 128) / ss)]) + ((i * 128) % ss);
  let found = -1, root = entryAt(0);
  for (let i = 0; i < (dirSectors.length * ss) / 128; i++) {
    const at = entryAt(i), length = out.readUInt16LE(at + 64);
    if (length > 2 && out.toString("utf16le", at, at + length - 2) === name && out[at + 66] === 2) { found = at; break; }
  }
  assert.ok(found >= 0, `${name} stream`);
  const size = out.readUInt32LE(found + 120), start = out.readUInt32LE(found + 116);
  if (size >= cutoff) {
    assert.ok(data.length >= cutoff, "replacement stays a regular stream");
    const sectors = chain(start, fat);
    assert.ok(data.length <= sectors.length * ss, "replacement fits the existing chain");
    sectors.forEach((s, k) => { if (k * ss < data.length) data.copy(out, sector(s), k * ss, Math.min(data.length, (k + 1) * ss)); });
  } else {
    assert.equal(data.length, size, "mini streams are replaced with the same length");
    const miniFat = chain(miniFatStart, fat).flatMap((s) => Array.from({ length: ss / 4 }, (_, i) => out.readUInt32LE(sector(s) + 4 * i)));
    const ministream = chain(out.readUInt32LE(root + 116), fat);
    chain(start, miniFat).forEach((m, k) => {
      const offset = m * ms, at = sector(ministream[Math.floor(offset / ss)]) + (offset % ss);
      data.copy(out, at, k * ms, Math.min(data.length, (k + 1) * ms));
    });
  }
  out.writeUInt32LE(data.length, found + 120);
  return out;
}

/** A canonical RGB8 preview PNG (same layout as the service encoder) of `rgb`. */
function canonicalPng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const chunk = (type, body) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(body.length); head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

function t009(published) {
  const loss = join(OUT, "loss0.json");
  writeFileSync(loss, JSON.stringify({ schemaVersion: 1, outputFormat: "hwp", count: 0, losses: [] }));
  return JSON.parse(execFileSync(CHECKER, ["saved", "hwp", ORIGINAL, published, loss, "true"], { encoding: "utf8" }));
}

function tampered(name, stream, data) {
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, name);
  writeFileSync(path, replaceStream(readFileSync(PUBLISHED), stream, data));
  return path;
}

test("the real Stage 4 publication's regenerated PrvImage is verified", { skip: !available }, () => {
  const result = t009(PUBLISHED);
  assert.deepEqual(result.findings, [{ code: "partChanged", part: "PrvImage" }]);
  const judged = judgeT009(result, engine, ORIGINAL, PUBLISHED);
  assert.equal(judged.preview.canonical, true);
  assert.equal(judged.preview.serviceIdentity, "product-gate");
  assert.ok(judged.preview.correlation > 0.95, `correlation ${judged.preview.correlation}`);
  assert.deepEqual([judged.preview.width, judged.preview.height], previewDimensions(...hwpFacts(PUBLISHED).pageDef));
});

test("a PNG-signature-only malformed PrvImage is rejected (the former oracle accepted it)", { skip: !available }, () => {
  const original = hwpFacts(PUBLISHED).prvImage;
  const forged = Buffer.alloc(original.length, 0x41);
  original.copy(forged, 0, 0, 8); // keeps exactly the PNG signature
  const path = tampered("signature-only.hwp", "PrvImage", forged);
  const result = t009(path);
  assert.deepEqual(result.findings, [{ code: "partChanged", part: "PrvImage" }], "offline T009 alone cannot tell");
  assert.equal(hwpFacts(path).prvImage.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.throws(() => judgeT009(result, engine, ORIGINAL, path), /bad CRC|truncated|signature/);
  // Truncated real PNG with a valid signature and IEND is rejected too.
  const truncated = Buffer.concat([original.subarray(0, original.length - 4000), Buffer.from("0000000049454e44ae426082", "hex")]);
  const padded = Buffer.concat([truncated, Buffer.alloc(original.length - truncated.length)]);
  assert.throws(() => decodeCanonicalPng(padded));
});

test("a valid canonical PNG of the right size that does not depict the document is rejected", { skip: !available }, () => {
  const { pageDef, prvImage } = hwpFacts(PUBLISHED);
  const [w, h] = previewDimensions(...pageDef);
  // A text-like page from another "document": dark bars at other places, sized to fit the existing sector chain.
  let png;
  for (let lines = 20; lines < 400; lines += 10) {
    const rgb = Buffer.alloc(w * h * 3, 255);
    for (let l = 0; l < lines; l++) {
      const y0 = 600 + (l * 7) % 380, x0 = 80 + ((l * 131) % 500), len = 40 + ((l * 53) % 120);
      for (let y = y0; y < y0 + 3 && y < h; y++) for (let x = x0; x < Math.min(w, x0 + len); x++) rgb.fill((l * 37) % 120, (y * w + x) * 3, (y * w + x) * 3 + 3);
    }
    png = canonicalPng(w, h, rgb);
    if (png.length >= 4096) break;
  }
  assert.ok(png.length >= 4096 && png.length <= Math.ceil(prvImage.length / 512) * 512, `forged size ${png.length}`);
  assert.deepEqual([decodeCanonicalPng(png).width, decodeCanonicalPng(png).height], [w, h], "the forged PNG is itself canonical and complete");
  const path = tampered("unrelated-preview.hwp", "PrvImage", png);
  const result = t009(path);
  assert.deepEqual(result.findings, [{ code: "partChanged", part: "PrvImage" }]);
  assert.throws(() => verifyRegeneratedPreview(engine, ORIGINAL, path), /does not depict page 1/);
});

test("an output with an additional unsafe T009 finding is rejected even with a valid preview", { skip: !available }, () => {
  const facts = execFileSync("python3", ["-I", "-c", `import importlib.util,sys,base64
s=importlib.util.spec_from_file_location('d',sys.argv[1]);d=importlib.util.module_from_spec(s);s.loader.exec_module(d)
print(base64.b64encode(d.cfb_streams(open(sys.argv[2],'rb').read())['PrvText']).decode())`, join(ROOT, "scripts/tests/hwp_record_diff.py"), PUBLISHED], { encoding: "utf8" });
  const text = Buffer.from(facts.trim(), "base64");
  assert.ok(text.length >= 4);
  const changed = Buffer.from(text);
  changed.writeUInt16LE(changed.readUInt16LE(0) === 0x0041 ? 0x0042 : 0x0041, 0); // one UTF-16 code unit
  const path = tampered("extra-finding.hwp", "PrvText", changed);
  const result = t009(path);
  assert.ok(result.findings.length > 1, `findings ${JSON.stringify(result.findings)}`);
  assert.throws(() => judgeT009(result, engine, ORIGINAL, path), /independent T009 findings/);
  // A malformed or unrelated verdict object is never accepted either.
  assert.throws(() => judgeT009({ outcome: "unsafe", findings: [{ code: "partChanged", part: "BodyText/Section0" }] }, engine, ORIGINAL, PUBLISHED));
  assert.throws(() => judgeT009({}, engine, ORIGINAL, PUBLISHED));
});

test("PAGE_DEF preview sizes follow the half-up short-side contract", () => {
  assert.deepEqual(previewDimensions(59528, 84186, false), [724, 1024]);
  assert.deepEqual(previewDimensions(59528, 84186, true), [1024, 724]);
  assert.deepEqual(previewDimensions(1000, 1000, false), [1024, 1024]);
  assert.throws(() => previewDimensions(0, 10, false));
});

test("a genuinely blank page 1 is judged per RGB channel, not by correlation or luminance", () => {
  const [w, h] = [362, 512];
  const raster = (rgb, mark, noise = 0) => {
    const data = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) data[i * 3 + c] = Math.min(255, Math.max(0, rgb[c] + (noise ? ((i * 13 + c * 5) % (noise + 1)) - (noise >> 1) : 0)));
    if (mark) for (let y = 40; y < 60; y++) for (let x = 20; x < 200; x++) data.fill(0, (y * w + x) * 3, (y * w + x) * 3 + 3);
    return { width: w, height: h, rgb: data };
  };
  const blank = { correlation: null, blankPage: true };
  assert.deepEqual(previewMatchesReference(raster([255, 255, 255]), raster([255, 255, 255])), blank, "white = white");
  assert.deepEqual(previewMatchesReference(raster([0, 0, 0]), raster([0, 0, 0])), blank, "black = black");
  assert.deepEqual(previewMatchesReference(raster([250, 250, 250], false, 2), raster([251, 251, 251])), blank, "same colour, ±1 channel noise");
  // Equal luminance (0.299·255 ≈ 76.2 vs 76), visibly different colours: rejected.
  assert.throws(() => previewMatchesReference(raster([255, 0, 0]), raster([76, 76, 76])), /blank colours/);
  assert.throws(() => previewMatchesReference(raster([0, 0, 255]), raster([255, 255, 255])), /blank colours/);
  assert.throws(() => previewMatchesReference(raster([255, 255, 255]), raster([249, 255, 255])), /blank colours/, "a 6-level channel shift is a different colour");
  assert.throws(() => previewMatchesReference(raster([255, 255, 255]), raster([255, 255, 255], true)), /uniform preview of a page with content/);
  assert.throws(() => previewMatchesReference(raster([255, 255, 255], true), raster([255, 255, 255])), /content in a preview of a blank page/);
  assert.throws(() => previewMatchesReference(raster([255, 255, 255], false, 6), raster([255, 255, 255])), /content in a preview of a blank page/, "noise beyond the uniform range is not blank");
  // Content on both sides still goes through the correlation threshold.
  assert.equal(previewMatchesReference(raster([255, 255, 255], true), raster([255, 255, 255], true)).blankPage, false);
});
