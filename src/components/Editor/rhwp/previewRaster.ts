import type { PreviewRaster } from "../../../adapters/backend";
import type { RhwpDocument } from "./rhwpModule";

// HWP PrvImage regeneration (2026-11-08): render page 1 of the *reopened raw export* (never
// the live session) and hand its pixels to the save service, which resamples them to the
// Hancom size derived from the output's Section0 PAGE_DEF (1024 px longest side), encodes the
// canonical PNG and validates it (src-tauri services/save/preview.rs, hwp.rs). A null result
// sends no raster; a stale original preview then keeps the existing `previewStale` refusal.
//
// Fail-closed inputs (null):
// - no usable page geometry, 2D context, or layer tree;
// - page 1 painting anything the pinned canvas renderer draws asynchronously: `rawSvg`, or an
//   image whose MIME is not decoded synchronously by the engine (`decode_image_to_canvas`
//   uses the `image` crate with bmp/jpeg/png/tiff only; others load through HTMLImageElement
//   and are skipped on a first render), so the capture could silently omit them;
// - a rendered bitmap larger than the backend accepts.

export const PREVIEW_LONG_SIDE = 1024;
const MAX_RASTER_SIDE = PREVIEW_LONG_SIDE + 8; // backend `MAX_RASTER_SIDE`
const SYNCHRONOUS_MIME = new Set(["image/png", "image/jpeg", "image/bmp", "image/tiff"]);

/** Whether every image/raw-SVG paint op of the layer tree is drawn synchronously. */
export function synchronouslyPaintable(layerTreeJson: string): boolean {
  let safe = true;
  try {
    JSON.parse(layerTreeJson, (_key, value: unknown) => {
      if (value && typeof value === "object") {
        const node = value as Record<string, unknown>;
        if (node.type === "rawSvg") safe = false;
        if (node.type === "image" && typeof node.mime !== "string") safe = false;
        if ("mime" in node && !(typeof node.mime === "string" && SYNCHRONOUS_MIME.has(node.mime))) safe = false;
      }
      return value;
    });
  } catch {
    return false;
  }
  return safe;
}

/** RGBA (any alpha) composited onto white as RGB8. */
export function rgbOnWhite(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, o = 0; i < width * height * 4; i += 4, o += 3) {
    const alpha = rgba[i + 3]!;
    for (let c = 0; c < 3; c++) rgb[o + c] = Math.round((rgba[i + c]! * alpha + 255 * (255 - alpha)) / 255);
  }
  return rgb;
}

export function capturePreviewRaster(
  doc: RhwpDocument,
  createCanvas: () => HTMLCanvasElement = () => document.createElement("canvas"),
): PreviewRaster | null {
  if (!doc.getPageLayerTreeWithProfile) return null;
  let canvas: HTMLCanvasElement | null = null;
  try {
    if (doc.pageCount() < 1) return null;
    const info = JSON.parse(doc.getPageInfo(0)) as { width?: unknown; height?: unknown };
    const width = Number(info.width), height = Number(info.height);
    if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) return null;
    if (!synchronouslyPaintable(doc.getPageLayerTreeWithProfile(0, "screen", true, true))) return null;
    canvas = createCanvas();
    doc.renderPageToCanvas(0, canvas, PREVIEW_LONG_SIDE / Math.max(width, height));
    const w = canvas.width, h = canvas.height;
    if (w < 1 || h < 1 || w > MAX_RASTER_SIDE || h > MAX_RASTER_SIDE) return null;
    const context = canvas.getContext("2d");
    if (!context) return null;
    return { width: w, height: h, rgb: rgbOnWhite(context.getImageData(0, 0, w, h).data, w, h) };
  } catch {
    return null;
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
