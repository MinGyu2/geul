import type { PdfPageRaster } from "../../../adapters/backend";
import type { PdfUnavailableReason } from "../../../adapters/contract";
import { classifyFirstPage, synchronouslyPaintable } from "./previewRaster";
import type { RhwpDocument } from "./rhwpModule";

// HWP/HWPX PDF export pages (Stage 5-A S5-4). The pinned RHWP WASM has no PDF writer, so every page is painted with
// the same `renderPageToCanvas` the editor surface uses and handed to the backend as a PNG (services/pdf.rs writes
// one PDF page per raster at the page's physical size). The PDF therefore has no selectable/searchable text.
//
// Fail-closed (nothing is sent, nothing is written):
// - asyncContent: a page paints something the canvas renderer draws asynchronously (`rawSvg`, or an image whose MIME
//   the engine does not decode synchronously — same rule as the HWP preview, previewRaster.ts): a synchronous
//   capture could silently omit it;
// - renderFailed: no layer-tree API, the engine threw, an unexpected bitmap size, a uniform bitmap for a page whose
//   paint list is not provably blank, or a PNG the WebView could not encode;
// - changed: the model, load attempt, committed revision or session state changed between pages (`stillCurrent`);
// - tooLarge: more pages, pixels or bytes than the export limits (backend limits are larger, never smaller).

/** RHWP page units are CSS px at 96 px/in. */
export const PX_TO_PT = 72 / 96;
/** Raster scale per page px: 2 → 192 px/in. Reduced for very large pages to fit PDF_MAX_PAGE_PIXELS. */
export const PDF_SCALE = 2;
const MIN_SCALE = 1;
export const PDF_MAX_PAGE_PIXELS = 16 * 1024 * 1024;
const MAX_SIDE = 12_000; // backend MAX_RASTER_SIDE
export const PDF_MAX_PAGES = 2000; // backend MAX_PAGES
export const PDF_MAX_BYTES = 512 * 1024 * 1024; // below backend MAX_PAYLOAD_BYTES

export interface PdfPageSize { width: number; height: number }

export type PdfCapture = { ok: true; pages: PdfPageRaster[] } | { ok: false; reason: PdfUnavailableReason };

/** Raster scale for a page of `width`×`height` px, or null when even the minimum scale exceeds the limits. */
export function pdfScale(width: number, height: number): number | null {
  const fit = Math.min(PDF_SCALE, Math.sqrt(PDF_MAX_PAGE_PIXELS / (width * height)), (MAX_SIDE - 1) / Math.max(width, height));
  return Number.isFinite(fit) && fit >= MIN_SCALE ? fit : null;
}

export type EncodePng = (canvas: HTMLCanvasElement) => Promise<Uint8Array | null>;

export const encodeCanvasPng: EncodePng = (canvas) => new Promise((resolve) => {
  try {
    canvas.toBlob((blob) => {
      if (!blob) { resolve(null); return; }
      blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), () => resolve(null));
    }, "image/png");
  } catch {
    resolve(null);
  }
});

function uniform(context: CanvasRenderingContext2D, width: number, height: number): boolean {
  const data = context.getImageData(0, 0, width, height).data;
  for (let i = 4; i < data.length; i += 4) {
    if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2] || data[i + 3] !== data[3]) return false;
  }
  return true;
}

/**
 * Paint and encode every page in order. `stillCurrent` is checked before every page and after the last
 * encode (encoding is asynchronous, so edits may happen meanwhile).
 */
export async function capturePdfPages(
  doc: RhwpDocument,
  pages: readonly PdfPageSize[],
  stillCurrent: () => boolean,
  createCanvas: () => HTMLCanvasElement = () => document.createElement("canvas"),
  encode: EncodePng = encodeCanvasPng,
): Promise<PdfCapture> {
  if (pages.length < 1) return { ok: false, reason: "renderFailed" };
  if (pages.length > PDF_MAX_PAGES) return { ok: false, reason: "tooLarge" };
  if (!doc.getPageLayerTreeWithProfile) return { ok: false, reason: "renderFailed" };
  const out: PdfPageRaster[] = [];
  let total = 0;
  for (let index = 0; index < pages.length; index++) {
    if (!stillCurrent()) return { ok: false, reason: "changed" };
    const { width, height } = pages[index]!;
    const scale = pdfScale(width, height);
    if (scale === null) return { ok: false, reason: "tooLarge" };
    let canvas: HTMLCanvasElement | null = null;
    try {
      const layerTree = doc.getPageLayerTreeWithProfile(index, "screen", true, true);
      if (!synchronouslyPaintable(layerTree)) return { ok: false, reason: "asyncContent" };
      const kind = classifyFirstPage(layerTree);
      canvas = createCanvas();
      doc.renderPageToCanvas(index, canvas, scale);
      const w = canvas.width, h = canvas.height;
      // The engine sizes the bitmap ceil(page × scale); anything else is not this page at this scale.
      if (w < 1 || h < 1 || Math.abs(w - width * scale) > 1.5 || Math.abs(h - height * scale) > 1.5) return { ok: false, reason: "renderFailed" };
      const context = canvas.getContext("2d");
      if (!context) return { ok: false, reason: "renderFailed" };
      if (kind !== "blank" && uniform(context, w, h)) return { ok: false, reason: "renderFailed" };
      const png = await encode(canvas);
      if (!png || png.length < 8) return { ok: false, reason: "renderFailed" };
      total += png.length;
      if (total > PDF_MAX_BYTES) return { ok: false, reason: "tooLarge" };
      out.push({ widthPt: width * PX_TO_PT, heightPt: height * PX_TO_PT, pixelWidth: w, pixelHeight: h, png });
    } catch {
      return { ok: false, reason: "renderFailed" };
    } finally {
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
  }
  if (!stillCurrent()) return { ok: false, reason: "changed" };
  return { ok: true, pages: out };
}
