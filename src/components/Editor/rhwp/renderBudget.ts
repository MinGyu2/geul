// T007은 전체 쪽을 그린다. 임의의 쪽 수 대신 실제 RGBA backing store의 픽셀 예산으로 제한한다.
// 엔진/WASM·레이아웃·GPU 복사본 전체의 메모리 상한은 아니다.
export const MAX_PAGE_EXTENT = 16_384;
export const MAX_CANVAS_PIXELS = 16 * 1024 * 1024; // RGBA 64 MiB / canvas
export const MAX_RENDER_PIXELS = 32 * 1024 * 1024; // RGBA 128 MiB / active surface

interface Size { width: number; height: number }

/** pinned rhwp wasm_api.rs normalize_canvas_scale + scaled_canvas_extent(ceil)와 같은 계산. */
export function bitmapPixels(page: Size, requestedScale: number): number {
  if (!Number.isFinite(requestedScale) || requestedScale <= 0) throw Error("render scale");
  const scale = Math.min(Math.max(0.25, Math.min(12, requestedScale)), MAX_PAGE_EXTENT / page.width, MAX_PAGE_EXTENT / page.height);
  // getPageInfo는 CSS px를 소수 첫째 자리로 반올림하지만 renderer tree는 원래 소수다.
  // 각 변에 1 CSS px 여유를 두어 예산을 과소 추정하지 않는다.
  const width = Math.min(MAX_PAGE_EXTENT, Math.ceil((page.width + 1) * scale));
  const height = Math.min(MAX_PAGE_EXTENT, Math.ceil((page.height + 1) * scale));
  const pixels = width * height;
  if (pixels > MAX_CANVAS_PIXELS) throw Error("canvas pixel budget");
  return pixels;
}

export function checkRenderBudget(pages: readonly Size[], scale: number): void {
  let total = 0;
  for (const page of pages) {
    total += bitmapPixels(page, scale);
    if (total > MAX_RENDER_PIXELS) throw Error("surface pixel budget");
  }
}
