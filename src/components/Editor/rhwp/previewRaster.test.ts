import { describe, expect, it } from "vitest";
import { capturePreviewRaster, classifyFirstPage, PREVIEW_LONG_SIDE, rgbOnWhite, synchronouslyPaintable } from "./previewRaster";
import type { RhwpDocument } from "./rhwpModule";

const tree = (...ops: object[]) => JSON.stringify({ type: "group", children: [{ type: "pageBackground" }, ...ops] });
// Real layer-tree shape (rhwp paint/json.rs): nodes are group/clipRect/leaf, paint ops live in leaf `ops`.
const background = { type: "pageBackground", backgroundColor: "#ffffff", borderWidth: 0 };
const emptyRun = { type: "textRun", text: "", clusters: [] };
const layer = (...ops: object[]) => JSON.stringify({ root: { kind: "group", children: [{ kind: "clipRect", child: { kind: "leaf", ops } }] } });

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

  it("1쪽 그리기 목록으로 빈 쪽·내용·알 수 없음을 구별한다", () => {
    expect(classifyFirstPage(layer(background, emptyRun, emptyRun))).toBe("blank");
    expect(classifyFirstPage(layer(background, { ...emptyRun, text: "  " }))).toBe("content");
    expect(classifyFirstPage(layer(background, { ...emptyRun, text: "", clusters: [{}] }))).toBe("content");
    expect(classifyFirstPage(layer(background, { type: "line" }))).toBe("content");
    expect(classifyFirstPage(layer(background, { type: "rectangle" }))).toBe("content");
    expect(classifyFirstPage(layer(background, { type: "image", mime: "image/png" }))).toBe("content");
    expect(classifyFirstPage(layer({ ...background, image: { fillMode: "tile" } }))).toBe("content");
    expect(classifyFirstPage(layer({ ...background, gradient: {} }))).toBe("content");
    expect(classifyFirstPage(layer({ ...background, borderColor: "#000000", borderWidth: 1 }))).toBe("content");
    expect(classifyFirstPage(layer(emptyRun))).toBe("unknown"); // no page background at all
    expect(classifyFirstPage(layer(background, { notAnOp: true }))).toBe("unknown");
    expect(classifyFirstPage(JSON.stringify({ root: { kind: "mystery" } }))).toBe("unknown");
    expect(classifyFirstPage(JSON.stringify({}))).toBe("unknown");
    expect(classifyFirstPage("{")).toBe("unknown");
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
      getPageLayerTreeWithProfile: () => layer(background, { type: "textRun", text: "가", clusters: [{}] }),
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

  const inked = (w: number, h: number) => { const data = new Uint8ClampedArray(w * h * 4).fill(255); data[0] = 0; return { data }; };
  it("다시 연 문서의 1쪽을 긴 변 1024 배율로 그려 RGB로 돌려주고 Canvas를 해제한다", () => {
    const { doc, calls } = fakeDoc();
    let created: HTMLCanvasElement | null = null;
    const context = { getImageData: (_x: number, _y: number, w: number, h: number) => inked(w, h) };
    const raster = capturePreviewRaster(doc, () => (created = fakeCanvas(context)()));
    expect(calls).toEqual([0, PREVIEW_LONG_SIDE / 1122.5]);
    expect(raster).not.toBeNull();
    expect([raster!.width, raster!.height]).toEqual([725, 1024]);
    expect(raster!.rgb.length).toBe(725 * 1024 * 3);
    expect([created!.width, created!.height]).toEqual([0, 0]);
    expect(raster!.blankPage).toBeUndefined();
  });

  it("한 색 렌더는 1쪽 그리기 목록이 빈 쪽일 때만 blankPage로 보낸다", () => {
    const white = { getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }) };
    const blank = capturePreviewRaster(fakeDoc({ getPageLayerTreeWithProfile: () => layer(background, emptyRun) }).doc, fakeCanvas(white));
    expect(blank?.blankPage).toBe(true);
    // Nonblank page rendered white (failed render), or an unknown tree: nothing is sent.
    expect(capturePreviewRaster(fakeDoc().doc, fakeCanvas(white))).toBeNull();
    expect(capturePreviewRaster(fakeDoc({ getPageLayerTreeWithProfile: () => layer(background, { type: "line" }) }).doc, fakeCanvas(white))).toBeNull();
    expect(capturePreviewRaster(fakeDoc({ getPageLayerTreeWithProfile: () => JSON.stringify({ root: { kind: "x" } }) }).doc, fakeCanvas(white))).toBeNull();
    // A blank paint list with a non-uniform render still sends pixels, marked blank (the backend only uses the mark for uniform renders).
    const inkedContext = { getImageData: (_x: number, _y: number, w: number, h: number) => inked(w, h) };
    expect(capturePreviewRaster(fakeDoc({ getPageLayerTreeWithProfile: () => layer(background, emptyRun) }).doc, fakeCanvas(inkedContext))?.blankPage).toBe(true);
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
