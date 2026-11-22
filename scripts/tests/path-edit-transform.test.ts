import { describe, expect, it } from "vitest";
import { pathOverlayGeometry, pathPointFromClientDelta } from "../../src/components/Editor/pathEditTransform";

describe("transformed shape path editing", () => {
  it("centers the unturned path frame inside the rotated visible bounds", () => {
    expect(pathOverlayGeometry(50, 100, 1, {
      rotation: 90, flipH: false, flipV: false, widthPt: 100, heightPt: 50,
    })).toEqual({
      left: -25, top: 25, width: 100, height: 50, transform: "rotate(90deg) scaleX(1) scaleY(1)",
    });
  });

  it("maps pointer travel through a quarter turn to the original path axes", () => {
    expect(pathPointFromClientDelta(
      { x: 100, y: 200 }, 0, 10, 1, 1000, 500,
      { rotation: 90, flipH: false, flipV: false, widthPt: 100, heightPt: 50 },
    )).toEqual({ x: 200, y: 200 });
  });

  it("inverts a horizontal reflection before converting to original coordinates", () => {
    expect(pathPointFromClientDelta(
      { x: 500, y: 200 }, -2, 0, 1, 1000, 500,
      { rotation: 0, flipH: true, flipV: false, widthPt: 100, heightPt: 50 },
    )).toEqual({ x: 520, y: 200 });
  });

  it("keeps arbitrary rotation, two flips, and anisotropic path viewports reversible", () => {
    const shape = { rotation: 37, flipH: true, flipV: false, widthPt: 120, heightPt: 80 };
    const radians = shape.rotation * Math.PI / 180;
    const dx = 4, dy = -7;
    const fx = -1, fy = 1;
    const displayedX = Math.cos(radians) * fx * dx - Math.sin(radians) * fy * dy;
    const displayedY = Math.sin(radians) * fx * dx + Math.cos(radians) * fy * dy;
    expect(pathPointFromClientDelta({ x: 300, y: 200 }, displayedX, displayedY, 1, 1000, 500, shape))
      .toEqual({ x: 300 + Math.round(dx * 1000 / shape.widthPt), y: 200 + Math.round(dy * 500 / shape.heightPt) });
  });
});
