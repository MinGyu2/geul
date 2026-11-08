import { describe, expect, it } from "vitest";
import { capturePreviewRaster, PREVIEW_LONG_SIDE, rgbOnWhite, synchronouslyPaintable } from "./previewRaster";
import type { RhwpDocument } from "./rhwpModule";

const tree = (...ops: object[]) => JSON.stringify({ type: "group", children: [{ type: "pageBackground" }, ...ops] });

describe("HWP 미리보기 그림 캡처", () => {
  it("동기적으로 그려지는 그림만 받는다", () => {
    expect(synchronouslyPaintable(tree({ type: "textRun" }, { type: "line" }))).toBe(true);
    for (const mime of ["image/png", "image/jpeg", "image/bmp", "image/tiff"]) {
      expect(synchronouslyPaintable(tree({ type: "image", mime, imageBytesOmitted: true }))).toBe(true);
    }
    for (const op of [
      { type: "image", mime: "image/gif" },
      { type: "image", mime: "image/svg+xml" },
      { type: "image" },
      { type: "rawSvg", svg: "<svg/>" },
      { type: "pageBackground", mime: "image/x-wmf" },
    ]) expect(synchronouslyPaintable(tree(op))).toBe(false);
    expect(synchronouslyPaintable("{not json")).toBe(false);
  });

  it("투명도는 흰 바탕에 합성한다", () => {
    expect([...rgbOnWhite(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 128]), 3, 1)])
      .toEqual([0, 0, 0, 255, 255, 255, 255, 127, 127]);
  });

  const fakeDoc = (overrides: Partial<Record<string, unknown>> = {}) => {
    const calls: number[] = [];
    const doc = {
      pageCount: () => 1,
      getPageInfo: () => JSON.stringify({ width: 793.7, height: 1122.5 }),
      getPageLayerTreeWithProfile: () => tree({ type: "textRun" }),
      renderPageToCanvas: (page: number, canvas: HTMLCanvasElement, scale: number) => {
        calls.push(page, scale);
        canvas.width = Math.ceil(793.7 * scale);
        canvas.height = Math.ceil(1122.5 * scale);
      },
      ...overrides,
    } as unknown as RhwpDocument;
    return { doc, calls };
  };
  const fakeCanvas = (context: unknown) => () => {
    const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
    return canvas;
  };

  it("다시 연 문서의 1쪽을 긴 변 1024 배율로 그려 RGB로 돌려주고 Canvas를 해제한다", () => {
    const { doc, calls } = fakeDoc();
    let created: HTMLCanvasElement | null = null;
    const context = { getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }) };
    const raster = capturePreviewRaster(doc, () => (created = fakeCanvas(context)()));
    expect(calls).toEqual([0, PREVIEW_LONG_SIDE / 1122.5]);
    expect(raster).not.toBeNull();
    expect([raster!.width, raster!.height]).toEqual([725, 1024]);
    expect(raster!.rgb.length).toBe(725 * 1024 * 3);
    expect([created!.width, created!.height]).toEqual([0, 0]);
  });

  it("그릴 수 없거나 믿을 수 없으면 null(백엔드는 낡은 미리보기를 계속 거부한다)", () => {
    const context = { getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) };
    const cases: Partial<Record<string, unknown>>[] = [
      { getPageLayerTreeWithProfile: undefined },
      { pageCount: () => 0 },
      { getPageInfo: () => "{}" },
      { getPageInfo: () => JSON.stringify({ width: -1, height: 2 }) },
      { getPageLayerTreeWithProfile: () => tree({ type: "image", mime: "image/gif" }) },
      { renderPageToCanvas: () => { throw new Error("render"); } },
      { renderPageToCanvas: (_p: number, canvas: HTMLCanvasElement) => { canvas.width = 2000; canvas.height = 10; } },
    ];
    for (const overrides of cases) expect(capturePreviewRaster(fakeDoc(overrides).doc, fakeCanvas(context))).toBeNull();
    expect(capturePreviewRaster(fakeDoc().doc, fakeCanvas(null))).toBeNull();
  });
});
