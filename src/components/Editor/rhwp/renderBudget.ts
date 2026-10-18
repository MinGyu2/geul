// T007은 전체 쪽을 그린다. 임의의 쪽 수 대신 실제 RGBA backing store의 픽셀 예산으로 제한한다.
// 엔진/WASM·레이아웃·GPU 복사본 전체의 메모리 상한은 아니다.
// 예산은 그리는 배율(zoom × devicePixelRatio)에 대한 것이다. 넘으면 RenderBudgetExceeded(문서 모델 손상이 아님)를 던지고,
// 배율 값 자체가 잘못되면 일반 Error를 던진다.
export const MAX_PAGE_EXTENT = 16_384;
export const MAX_CANVAS_PIXELS = 16 * 1024 * 1024; // RGBA 64 MiB / canvas
export const MAX_RENDER_PIXELS = 32 * 1024 * 1024; // RGBA 128 MiB / active surface

interface Size { width: number; height: number }

/** pinned rhwp normalize_canvas_scale의 배율 범위. */
const MIN_ENGINE_SCALE = 0.25;
const MAX_ENGINE_SCALE = 12;

/**
 * 엔진이 이 쪽을 요청한 배율 그대로 그리는지(9차). rhwp는 배율을 0.25..12로 자르고, 한 변이 MAX_PAGE_EXTENT를 넘으면 그 안에
 * 들도록 줄여(normalize_canvas_scale) 그 배율로 Canvas 크기와 변환(setTransform + scale)을 정한다. 그러면 쪽 좌표 → Canvas 픽셀이
 * 요청 배율과 달라진다. 쪽 크기는 getPageInfo의 반올림 값이므로 각 변에 1 CSS px 여유를 두어, 한도 근처는 그대로라고 보지 않는다.
 */
export function drawsAtRequestedScale(page: Size, requestedScale: number): boolean {
  return requestedScale >= MIN_ENGINE_SCALE && requestedScale <= MAX_ENGINE_SCALE
    && (page.width + 1) * requestedScale <= MAX_PAGE_EXTENT && (page.height + 1) * requestedScale <= MAX_PAGE_EXTENT;
}

/** 이 배율로 그리면 per-canvas·전체 픽셀 예산을 넘는다(표시 한도). 엔진 오류·잘못된 페이지 정보와 구분한다. */
export class RenderBudgetExceeded extends Error {}

/** pinned rhwp wasm_api.rs normalize_canvas_scale + scaled_canvas_extent(ceil)와 같은 계산. */
export function bitmapPixels(page: Size, requestedScale: number): number {
  if (!Number.isFinite(requestedScale) || requestedScale <= 0) throw Error("render scale");
  const scale = Math.min(Math.max(MIN_ENGINE_SCALE, Math.min(MAX_ENGINE_SCALE, requestedScale)), MAX_PAGE_EXTENT / page.width, MAX_PAGE_EXTENT / page.height);
  // getPageInfo는 CSS px를 소수 첫째 자리로 반올림하지만 renderer tree는 원래 소수다.
  // 각 변에 1 CSS px 여유를 두어 예산을 과소 추정하지 않는다.
  const width = Math.min(MAX_PAGE_EXTENT, Math.ceil((page.width + 1) * scale));
  const height = Math.min(MAX_PAGE_EXTENT, Math.ceil((page.height + 1) * scale));
  const pixels = width * height;
  if (pixels > MAX_CANVAS_PIXELS) throw new RenderBudgetExceeded("canvas pixel budget");
  return pixels;
}

export function checkRenderBudget(pages: readonly Size[], scale: number): void {
  let total = 0;
  for (const page of pages) {
    total += bitmapPixels(page, scale);
    if (total > MAX_RENDER_PIXELS) throw new RenderBudgetExceeded("surface pixel budget");
  }
}

/** 예산을 넘는 것만 false. 배율이 잘못되는 등 다른 오류는 그대로 던진다. */
export function fitsRenderBudget(pages: readonly Size[], scale: number): boolean {
  try {
    checkRenderBudget(pages, scale);
    return true;
  } catch (error) {
    if (error instanceof RenderBudgetExceeded) return false;
    throw error;
  }
}
