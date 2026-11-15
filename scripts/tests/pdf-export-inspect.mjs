#!/usr/bin/env node
// Stage 5-A S5-4: independent structural inspection of PDFs produced by native-pdf-export.py.
//   node scripts/tests/pdf-export-inspect.mjs NATIVE_OUT
// Parses each PDF without geul/krilla code (header, startxref → xref table/stream, every page object and its
// MediaBox, image XObjects, embedded font names) and compares page count, order and size with the source document:
// HWP/HWPX through the independent Release RHWP WASM (pageCount/getPageInfo, 96 px/in), DOCX through WordCraft's
// declared A4 section size of the fixture. Raster PDFs must have exactly one full-page image per page; vector PDFs
// must embed fonts. Visual inspection (pdf.js) is recorded separately in docs/quality-matrix.md.
import { inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { loadRelease } from "./advanced-production-runtime.mjs";

const out = process.argv[2];
if (!out) throw new Error("usage: pdf-export-inspect.mjs NATIVE_OUT");
const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
if (result.status !== "PASS") throw new Error("native run did not pass");
const { build, engine } = loadRelease();
const need = (ok, message) => { if (!ok) throw new Error(message); };

/** All objects "n g obj ... endobj", plus objects inside object streams. */
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

/** Text of one page's content: Tj/TJ strings decoded through the current font's ToUnicode (2-byte codes for
 *  Type0 fonts, 1-byte otherwise). Returns { text, unmapped }. */
function pageText(content, fonts) {
  let font = null, text = "", unmapped = 0;
  const show = (bytes) => {
    if (!font) { unmapped += bytes.length; return; }
    for (let k = 0; k < bytes.length; k += font.width) {
      const code = font.width === 2 ? bytes.readUInt16BE(k) : bytes[k];
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

function inspect(path) {
  const bytes = readFileSync(path);
  const text = bytes.toString("latin1");
  need(text.startsWith("%PDF-1."), `${path}: not a PDF header`);
  const tail = text.slice(-1024);
  need(/%%EOF\s*$/.test(tail), `${path}: no %%EOF trailer`);
  const startxref = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail)?.[1] ?? NaN);
  need(Number.isInteger(startxref) && startxref < bytes.length, `${path}: bad startxref`);
  const at = text.slice(startxref, startxref + 64);
  need(at.startsWith("xref") || /^\d+ \d+ obj/.test(at), `${path}: startxref does not point at an xref table/stream`);
  const objs = objects(bytes);
  const deref = (ref) => objs.get(Number(/(\d+)\s+0\s+R/.exec(ref)[1]))?.body ?? "";
  // Page tree order: from the catalog's /Pages, depth first through /Kids.
  const catalog = [...objs.values()].find(o => /\/Type\s*\/Catalog/.test(o.body)).body;
  const pages = [];
  const walk = (body, depth = 0) => {
    need(depth < 32, "page tree too deep");
    if (/\/Type\s*\/Pages\b/.test(body)) {
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(body)[1].match(/\d+\s+0\s+R/g) ?? [];
      for (const kid of kids) walk(deref(kid), depth + 1);
    } else if (/\/Type\s*\/Page\b/.test(body)) pages.push(body);
  };
  walk(deref(/\/Pages\s+(\d+\s+0\s+R)/.exec(catalog)[1]));
  const declared = Number(/\/Count\s+(\d+)/.exec(deref(/\/Pages\s+(\d+\s+0\s+R)/.exec(catalog)[1]))[1]);
  const rows = pages.map((body) => {
    const box = /\/MediaBox\s*\[([^\]]*)\]/.exec(body)[1].trim().split(/\s+/).map(Number);
    const resources = /\/Resources\s+(\d+\s+0\s+R)/.exec(body) ? deref(/\/Resources\s+(\d+\s+0\s+R)/.exec(body)[1]) : body;
    const xobjects = /\/XObject\s*<<([^>]*)>>/.exec(resources)?.[1].match(/\d+\s+0\s+R/g) ?? [];
    const images = xobjects.map(deref).filter(b => /\/Subtype\s*\/Image/.test(b))
      .map(b => ({ width: Number(/\/Width\s+(\d+)/.exec(b)[1]), height: Number(/\/Height\s+(\d+)/.exec(b)[1]) }));
    const fonts = new Map();
    const fontDict = /\/Font\s*<<([^>]*)>>/.exec(resources)?.[1] ?? "";
    for (const [, name, ref] of fontDict.matchAll(/\/([^\s/<>[\]]+)\s+(\d+\s+0\s+R)/g)) {
      const body = deref(ref);
      const toUnicode = /\/ToUnicode\s+(\d+\s+0\s+R)/.exec(body);
      fonts.set(name, { width: /\/Subtype\s*\/Type0/.test(body) ? 2 : 1, cmap: toUnicode ? parseCMap(streamData(deref(toUnicode[1])).toString("latin1")) : new Map(),
        baseFont: /\/BaseFont\s*\/([^\s/<>[\]]+)/.exec(body)?.[1] ?? null });
    }
    const contents = /\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/.exec(body)?.[1].match(/\d+\s+0\s+R/g) ?? [];
    const content = Buffer.concat(contents.map((ref) => streamData(deref(ref))));
    const { text, unmapped } = pageText(content, fonts);
    const hangulFonts = [...fonts.values()].filter((f) => [...f.cmap.values()].some((v) => /[\uac00-\ud7a3]/.test(v))).map((f) => f.baseFont);
    return { width: box[2] - box[0], height: box[3] - box[1], images, text, unmapped, hangulFonts };
  });
  const fonts = [...new Set([...objs.values()].flatMap(o => [...o.body.matchAll(/\/BaseFont\s*\/([^\s/<>[\]]+)/g)].map(m => m[1])))];
  const fontFiles = [...objs.values()].filter(o => /\/FontFile[23]?\s/.test(o.body)).length;
  return { bytes: bytes.length, declaredCount: declared, pages: rows, fonts, fontFiles };
}

function expected(row) {
  if (row.format === "docx") {
    // Independent of WordCraft: explicit page breaks in word/document.xml (+1). Valid as an exact count only for
    // fixtures whose pages never overflow (rich-ko.docx); the editor's own status-bar count is compared too.
    const xml = execFileSync("python3", ["-I", "-c", "import zipfile,sys;print(zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode())", row.source], { encoding: "utf8" });
    const breaks = (xml.match(/<w:br w:type="page"\/>/g) ?? []).length;
    return { pages: breaks + 1, sizes: [[595.3, 841.9]] }; // fixture sectPr: 11906×16838 twips (A4)
  }
  const d = new engine.HwpDocument(readFileSync(row.source));
  try {
    const sizes = Array.from({ length: d.pageCount() }, (_, p) => { const i = JSON.parse(d.getPageInfo(p)); return [i.width * 0.75, i.height * 0.75]; });
    return { pages: sizes.length, sizes };
  } finally { d.free(); }
}

/** Phrases each page of a known DOCX fixture must contain as extractable text (rich-ko.docx, make_docx design). */
const EXPECTED_TEXT = {
  "rich-ko.docx": [
    ["글 PDF 내보내기 시험 문서", "첫 쪽: 한글 문단입니다.", "굵게", "기울임", "밑줄", "빨간 글자", "Korean and English text.", "항목", "사과", "노랑", "그림:"],
    ["둘째 쪽: 다람쥐 헌 쳇바퀴에 타고파."],
    ["셋째 쪽: 마지막 쪽입니다. 끝."],
  ],
};

const report = [];
for (const row of result.positive) {
  const got = inspect(row.pdf);
  const want = expected(row);
  const raster = row.format !== "docx";
  need(got.declaredCount === got.pages.length, `${row.pdf}: /Count ${got.declaredCount} != ${got.pages.length} page objects`);
  const noticePages = Number(/(\d+)쪽/.exec(row.notice.split("PDF로 내보냈습니다")[1] ?? "")?.[1]);
  need(noticePages === got.pages.length, `${row.pdf}: product reported ${noticePages} pages, file has ${got.pages.length}`);
  if (want.pages !== null) need(got.pages.length === want.pages, `${row.pdf}: ${got.pages.length} pages, source has ${want.pages}`);
  got.pages.forEach((page, i) => {
    const [w, h] = want.sizes[Math.min(i, want.sizes.length - 1)];
    need(Math.abs(page.width - w) < 0.6 && Math.abs(page.height - h) < 0.6, `${row.pdf} page ${i + 1}: ${page.width}×${page.height} != ${w}×${h}`);
    if (raster) {
      need(page.images.length === 1, `${row.pdf} page ${i + 1}: ${page.images.length} images (raster page expects 1)`);
      const scale = page.images[0].width / page.width;
      need(Math.abs(page.images[0].height / page.height - scale) < 0.02 && scale > 2.6, `${row.pdf} page ${i + 1}: raster ${JSON.stringify(page.images[0])} does not cover the page at ≥192 px/in`);
    }
  });
  const editorPages = Number(/(\d+)쪽 중/.exec(row.notice)?.[1]);
  need(editorPages === got.pages.length, `${row.pdf}: editor shows ${editorPages} pages, file has ${got.pages.length}`);
  let text = null;
  if (!raster) {
    need(got.fonts.length > 0 && got.fontFiles === got.fonts.length, `${row.pdf}: fonts not embedded ${JSON.stringify(got)}`);
    // Extractable text through the embedded ToUnicode maps, page by page and in order.
    const squash = (v) => v.replace(/\s+/g, "");
    const phrases = EXPECTED_TEXT[basename(row.source)] ?? [];
    phrases.forEach((pagePhrases, i) => pagePhrases.forEach((phrase) =>
      need(squash(got.pages[i]?.text ?? "").includes(squash(phrase)), `${row.pdf} page ${i + 1}: text lacks ${JSON.stringify(phrase)}`)));
    need(got.pages.every((p) => p.unmapped === 0), `${row.pdf}: glyph codes without ToUnicode mapping`);
    text = { pages: got.pages.map((p) => p.text.length), hangulFonts: [...new Set(got.pages.flatMap((p) => p.hangulFonts))], phrases: phrases.flat().length };
  }
  report.push({ format: row.format, pdf: row.pdf, pdfSha256: row.pdfSha256, pages: got.pages.length,
    sizes: [...new Set(got.pages.map(p => `${p.width.toFixed(1)}x${p.height.toFixed(1)}`))],
    raster, rasterPixels: raster ? [...new Set(got.pages.map(p => `${p.images[0].width}x${p.images[0].height}`))] : null,
    images: got.pages.reduce((n, p) => n + p.images.length, 0), fonts: got.fonts, bytes: got.bytes, editorPages, sourcePages: want.pages, text });
}
writeFileSync(join(out, "inspect.json"), JSON.stringify({ status: "PASS", engineGeneration: build.generation, rows: report }, null, 2) + "\n");
console.log("PASS", JSON.stringify(report.map(r => [r.format, r.pages, r.sizes, r.rasterPixels ?? r.fonts])));
