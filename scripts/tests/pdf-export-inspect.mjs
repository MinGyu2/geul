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
import { join } from "node:path";
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
    return { width: box[2] - box[0], height: box[3] - box[1], images };
  });
  const fonts = [...new Set([...objs.values()].flatMap(o => [...o.body.matchAll(/\/BaseFont\s*\/([^\s/<>[\]]+)/g)].map(m => m[1])))];
  const fontFiles = [...objs.values()].filter(o => /\/FontFile[23]?\s/.test(o.body)).length;
  return { bytes: bytes.length, declaredCount: declared, pages: rows, fonts, fontFiles };
}

function expected(row) {
  if (row.format === "docx") return { pages: null, sizes: [[595.3, 841.9]] }; // fixture sectPr: 11906×16838 twips (A4)
  const d = new engine.HwpDocument(readFileSync(row.source));
  try {
    const sizes = Array.from({ length: d.pageCount() }, (_, p) => { const i = JSON.parse(d.getPageInfo(p)); return [i.width * 0.75, i.height * 0.75]; });
    return { pages: sizes.length, sizes };
  } finally { d.free(); }
}

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
  if (!raster) need(got.fonts.length > 0 && got.fontFiles === got.fonts.length, `${row.pdf}: fonts not embedded ${JSON.stringify(got)}`);
  report.push({ format: row.format, pdf: row.pdf, pdfSha256: row.pdfSha256, pages: got.pages.length,
    sizes: [...new Set(got.pages.map(p => `${p.width.toFixed(1)}x${p.height.toFixed(1)}`))],
    raster, rasterPixels: raster ? [...new Set(got.pages.map(p => `${p.images[0].width}x${p.images[0].height}`))] : null,
    images: got.pages.reduce((n, p) => n + p.images.length, 0), fonts: got.fonts, bytes: got.bytes });
}
writeFileSync(join(out, "inspect.json"), JSON.stringify({ status: "PASS", engineGeneration: build.generation, rows: report }, null, 2) + "\n");
console.log("PASS", JSON.stringify(report.map(r => [r.format, r.pages, r.sizes, r.rasterPixels ?? r.fonts])));
