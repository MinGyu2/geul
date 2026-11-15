#!/usr/bin/env node
// Stage 5-A font package: independent inspection of native-font-acceptance.py output.
//   node scripts/tests/font-acceptance-inspect.mjs NATIVE_OUT
// Reads the saved DOCX files with its own ZIP reader (central directory + raw inflate) and the PDFs with its own object /
// xref / content-stream parser (helpers adapted from pdf-export-inspect.mjs). No geul, WordCraft or krilla code runs.
// Checks: the requested families are stored in word/document.xml; DOCX PDFs embed the fonts, name the selected font in
// /BaseFont, map every shown glyph through ToUnicode (Korean and English text extract), show no glyph 0 (.notdef), and have
// the page count the editor laid out; HWP/HWPX raster PDFs keep one image per page. Writes inspect.json.
import { inflateRawSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
if (!out) throw new Error("usage: font-acceptance-inspect.mjs NATIVE_OUT");
const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
if (result.status !== "PASS") throw new Error("native run did not pass");
const failures = [];
const need = (ok, message) => { if (!ok) failures.push(message); return ok; };

/** One ZIP entry's bytes (stored or deflated), via the central directory. */
function zipEntry(bytes, name) {
  let eocd = bytes.length - 22;
  while (eocd >= 0 && bytes.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("no ZIP end record");
  let at = bytes.readUInt32LE(eocd + 16);
  const count = bytes.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const method = bytes.readUInt16LE(at + 10), size = bytes.readUInt32LE(at + 20);
    const nameLen = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    if (bytes.toString("utf8", at + 46, at + 46 + nameLen) === name) {
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const raw = bytes.subarray(start, start + size);
      return method === 0 ? raw : inflateRawSync(raw);
    }
    at += 46 + nameLen + extra + comment;
  }
  throw new Error(`no ZIP entry ${name}`);
}

function objects(bytes) {
  const text = bytes.toString("latin1");
  const found = new Map();
  for (const m of text.matchAll(/(\d+) (\d+) obj\b/g)) {
    const start = m.index + m[0].length;
    const end = text.indexOf("endobj", start);
    need(end > 0, `object ${m[1]} has no endobj`);
    found.set(Number(m[1]), { body: text.slice(start, end), start });
  }
  for (const [, obj] of [...found]) {
    if (!/\/Type\s*\/ObjStm/.test(obj.body)) continue;
    const n = Number(/\/N\s+(\d+)/.exec(obj.body)[1]), first = Number(/\/First\s+(\d+)/.exec(obj.body)[1]);
    const s = obj.body.indexOf("stream") + 6;
    const raw = Buffer.from(obj.body.slice(s, obj.body.lastIndexOf("endstream")).replace(/^\r?\n/, ""), "latin1");
    const data = inflateSync(raw).toString("latin1");
    const header = data.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const next = i + 1 < n ? header[2 * i + 3] : data.length - first;
      found.set(header[2 * i], { body: data.slice(first + header[2 * i + 1], first + next) });
    }
  }
  return found;
}

/** Decoded stream data of an object body ("<<dict>> stream ... endstream"). */
function streamData(body) {
  const at = body.indexOf("stream");
  need(at >= 0, "object has no stream");
  let start = at + 6;
  if (body[start] === "\r") start++;
  if (body[start] === "\n") start++;
  const raw = Buffer.from(body.slice(start, body.lastIndexOf("endstream")), "latin1");
  return /\/FlateDecode/.test(body.slice(0, at)) ? inflateSync(raw) : raw;
}

/** ToUnicode CMap: code (hex, as written) → text. bfchar and bfrange (both forms). */
function parseCMap(text) {
  const map = new Map();
  const utf16 = (hex) => Buffer.from(hex.length % 4 ? hex.padStart(hex.length + 4 - (hex.length % 4), "0") : hex, "hex").swap16().toString("utf16le");
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(m[1], 16), utf16(m[2]));
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g)) {
      const [lo, hi] = [parseInt(m[1], 16), parseInt(m[2], 16)];
      if (m[3].startsWith("[")) [...m[3].matchAll(/<([0-9A-Fa-f]+)>/g)].forEach((d, k) => map.set(lo + k, utf16(d[1])));
      else { const base = Buffer.from(m[3].slice(1, -1), "hex"); for (let c = lo; c <= hi; c++) { const b = Buffer.from(base); b.writeUInt16BE((b.readUInt16BE(b.length - 2) + c - lo) & 0xffff, b.length - 2); map.set(c, b.swap16().toString("utf16le")); } }
    }
  return map;
}

/** Literal "( … )" (with escapes) or hex "< … >" PDF string at `i`; returns [bytes, next index]. */
function pdfString(src, i) {
  if (src[i] === "<") { const end = src.indexOf(">", i); return [Buffer.from(src.slice(i + 1, end).replace(/\s/g, ""), "hex"), end + 1]; }
  const out = [];
  let depth = 0;
  for (i++; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const n = src[++i];
      if (/[0-7]/.test(n)) { let o = n; while (o.length < 3 && /[0-7]/.test(src[i + 1])) o += src[++i]; out.push(parseInt(o, 8) & 255); }
      else out.push({ n: 10, r: 13, t: 9, b: 8, f: 12 }[n] ?? n.charCodeAt(0));
    } else if (c === "(") { depth++; out.push(40); } else if (c === ")") { if (depth-- === 0) return [Buffer.from(out), i + 1]; out.push(41); } else out.push(c.charCodeAt(0));
  }
  throw new Error("unterminated string");
}

let notdefShows = 0;

/** Text of one page's content: Tj/TJ strings decoded through the current font's ToUnicode (2-byte codes for
 *  Type0 fonts, 1-byte otherwise). Returns { text, unmapped }. */
function pageText(content, fonts) {
  let font = null, text = "", unmapped = 0;
  const show = (bytes) => {
    if (!font) { unmapped += bytes.length; return; }
    for (let k = 0; k < bytes.length; k += font.width) {
      const code = font.width === 2 ? bytes.readUInt16BE(k) : bytes[k];
      if (font.width === 2 && code === 0) notdefShows++; // CID 0 is .notdef (Identity encodings)
      const value = font.cmap.get(code);
      if (value === undefined) unmapped++; else text += value;
    }
  };
  const src = content.toString("latin1");
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === "(" || (c === "<" && src[i + 1] !== "<")) {
      const [bytes, next] = pdfString(src, i);
      const op = /^\s*(Tj|'|")/.exec(src.slice(next, next + 4));
      if (op) show(bytes);
      i = next;
    } else if (c === "[") {
      const end = (() => { let j = i + 1; while (src[j] !== "]") { if (src[j] === "(" || src[j] === "<") j = pdfString(src, j)[1]; else j++; } return j; })();
      if (/^\s*TJ/.test(src.slice(end + 1, end + 5))) {
        for (let j = i + 1; j < end;) { if (src[j] === "(" || src[j] === "<") { const [b, n] = pdfString(src, j); show(b); j = n; } else j++; }
        text += " ";
      }
      i = end + 1;
    } else if (c === "/") {
      const m = /^\/([^\s/<>[\]()]+)\s+[-\d.]+\s+Tf/.exec(src.slice(i, i + 64));
      if (m) font = fonts.get(m[1]) ?? null;
      i += m ? m[0].length : 1;
    } else i++;
  }
  return { text, unmapped };
}

function inspectPdf(path) {
  const bytes = readFileSync(path);
  const objs = objects(bytes);
  const deref = (ref) => objs.get(Number(/(\d+)\s+0\s+R/.exec(ref)[1]))?.body ?? "";
  const catalog = [...objs.values()].find((o) => /\/Type\s*\/Catalog/.test(o.body)).body;
  const pages = [];
  const walk = (body, depth = 0) => {
    if (depth > 32) throw new Error("page tree too deep");
    if (/\/Type\s*\/Pages\b/.test(body)) for (const kid of /\/Kids\s*\[([^\]]*)\]/.exec(body)[1].match(/\d+\s+0\s+R/g) ?? []) walk(deref(kid), depth + 1);
    else if (/\/Type\s*\/Page\b/.test(body)) pages.push(body);
  };
  walk(deref(/\/Pages\s+(\d+\s+0\s+R)/.exec(catalog)[1]));
  const notdefBefore = notdefShows;
  const rows = pages.map((body) => {
    const resources = /\/Resources\s+(\d+\s+0\s+R)/.exec(body) ? deref(/\/Resources\s+(\d+\s+0\s+R)/.exec(body)[1]) : body;
    const fonts = new Map();
    const fontDict = /\/Font\s*<<([^>]*)>>/.exec(resources)?.[1] ?? "";
    for (const [, name, ref] of fontDict.matchAll(/\/([^\s/<>[\]]+)\s+(\d+\s+0\s+R)/g)) {
      const fb = deref(ref);
      const toUnicode = /\/ToUnicode\s+(\d+\s+0\s+R)/.exec(fb);
      const cmap = toUnicode ? parseCMap(streamData(deref(toUnicode[1])).toString("latin1")) : new Map();
      const width = /\/Subtype\s*\/Type0/.test(fb) ? 2 : 1;
      fonts.set(name, { width, cmap, baseFont: /\/BaseFont\s*\/([^\s/<>[\]]+)/.exec(fb)?.[1] ?? null });
    }
    const contents = /\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/.exec(body)?.[1].match(/\d+\s+0\s+R/g) ?? [];
    const content = Buffer.concat(contents.map((ref) => streamData(deref(ref))));
    const { text, unmapped } = pageText(content, fonts);
    const scripts = (re) => [...fonts.values()].filter((f) => [...f.cmap.values()].some((v) => re.test(v))).map((f) => f.baseFont);
    const xobjects = /\/XObject\s*<<([^>]*)>>/.exec(resources)?.[1].match(/\d+\s+0\s+R/g) ?? [];
    const images = xobjects.map(deref).filter((b) => /\/Subtype\s*\/Image/.test(b)).length;
    return { text, unmapped, images, hangulFonts: scripts(/[가-힣]/), latinFonts: scripts(/[A-Za-z]/) };
  });
  const baseFonts = [...new Set([...objs.values()].flatMap((o) => [...o.body.matchAll(/\/BaseFont\s*\/([^\s/<>[\]]+)/g)].map((m) => m[1])))];
  const fontFiles = [...objs.values()].filter((o) => /\/FontFile[23]?\s/.test(o.body)).length;
  return { pages: rows, baseFonts, fontFiles, zeroCodes: notdefShows - notdefBefore };
}

const report = { docx: [], pdf: [] };
for (const row of result.docx) {
  const xml = zipEntry(readFileSync(join(out, "docs", row.document)), "word/document.xml").toString("utf8");
  const ascii = (xml.match(new RegExp(`w:ascii="${row.family}"`, "g")) ?? []).length;
  const eastAsia = (xml.match(new RegExp(`w:eastAsia="${row.family}"`, "g")) ?? []).length;
  const otherAscii = [...new Set([...xml.matchAll(/w:ascii="([^"]+)"/g)].map((m) => m[1]))].filter((f) => f !== row.family);
  report.docx.push({ document: row.document, family: row.family, asciiRuns: ascii, eastAsiaRuns: eastAsia, otherAsciiFamilies: otherAscii });
  need(ascii > 0, `${row.document}: requested family not stored in document.xml`);

  const pdf = inspectPdf(join(out, "pdf", row.export.pdf));
  const text = pdf.pages.map((p) => p.text).join("\n");
  const compact = text.replace(/\s+/g, "");
  const ps = row.family.replace(/\s+/g, "");
  const named = pdf.baseFonts.filter((b) => b.replace(/^[A-Z]{6}\+/, "").toLowerCase().startsWith(ps.toLowerCase()));
  const latinInFamily = pdf.pages.some((p) => p.latinFonts.some((b) => b && b.replace(/^[A-Z]{6}\+/, "").toLowerCase().startsWith(ps.toLowerCase())));
  const entry = {
    pdf: row.export.pdf, pages: pdf.pages.length, editorPages: row.pagesAfter, baseFonts: pdf.baseFonts, fontFiles: pdf.fontFiles,
    selectedFontEmbedded: named, latinTextInSelectedFont: latinInFamily,
    hangulFonts: [...new Set(pdf.pages.flatMap((p) => p.hangulFonts))], unmapped: pdf.pages.reduce((n, p) => n + p.unmapped, 0),
    zeroGlyphShows: pdf.zeroCodes, koreanExtracted: compact.includes("한글문단입니다"), englishExtracted: compact.includes("Koreanparagraph"),
  };
  report.pdf.push(entry);
  need(entry.pages === entry.editorPages, `${entry.pdf}: ${entry.pages} pages, editor laid out ${entry.editorPages}`);
  need(entry.fontFiles > 0, `${entry.pdf}: no embedded font program`);
  need(named.length > 0 && latinInFamily, `${entry.pdf}: selected font ${row.family} not embedded/used for Latin text`);
  need(entry.hangulFonts.length > 0, `${entry.pdf}: no font maps Hangul through ToUnicode`);
  need(entry.unmapped === 0, `${entry.pdf}: ${entry.unmapped} shown glyph codes without ToUnicode`);
  need(entry.zeroGlyphShows === 0, `${entry.pdf}: .notdef glyphs shown`);
  need(entry.koreanExtracted && entry.englishExtracted, `${entry.pdf}: Korean/English text not extractable`);
}
for (const row of result.rhwp) {
  const pdf = inspectPdf(join(out, "pdf", row.export.pdf));
  const entry = { pdf: row.export.pdf, pages: pdf.pages.length, imagesPerPage: pdf.pages.map((p) => p.images) };
  report.pdf.push(entry);
  need(pdf.pages.length > 0 && pdf.pages.every((p) => p.images === 1), `${entry.pdf}: raster PDF must have one image per page`);
}
report.status = failures.length ? "FAIL" : "PASS";
report.failures = failures;
writeFileSync(join(out, "inspect.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ status: report.status, failures }, null, 2));
process.exit(failures.length ? 1 : 0);
