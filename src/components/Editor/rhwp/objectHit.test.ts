import { describe, expect, it } from "vitest";
import { hitRhwpObject } from "./objectHit";

const control = (overrides: Record<string, unknown> = {}) => ({
  type: "image",
  x: 20,
  y: 30,
  w: 100,
  h: 60,
  secIdx: 0,
  paraIdx: 2,
  controlIdx: 3,
  stableIndex: [2, 3],
  plane: 1,
  zOrder: 0,
  ...overrides,
});

const layout = (...controls: unknown[]) => ({ controls });

describe("RHWP object hit testing", () => {
  it("returns the hit object's format kind, owned address, and page frame", () => {
    expect(hitRhwpObject(layout(control()), 4, 25, 40)).toEqual({
      kind: "picture",
      path: [2, 3],
      plane: 1,
      zOrder: 0,
      frame: { page: 4, x: 20, y: 30, width: 100, height: 60 },
    });
    expect(hitRhwpObject(layout(control({ type: "shape" })), 0, 25, 40)?.kind).toBe("shape");
    expect(hitRhwpObject(layout(control({ type: "group" })), 0, 25, 40)?.kind).toBe("group");
  });

  it("selects the visually topmost control by plane, z-order, then engine path", () => {
    const back = control({ stableIndex: [0], plane: 0, zOrder: 9 });
    const front = control({ type: "shape", stableIndex: [1], plane: 1, zOrder: 0 });
    expect(hitRhwpObject(layout(front, back), 0, 25, 40)?.path).toEqual([1]);

    const lowerZ = control({ stableIndex: [1], plane: 1, zOrder: 1 });
    const higherZ = control({ type: "shape", stableIndex: [2], plane: 1, zOrder: 2 });
    expect(hitRhwpObject(layout(lowerZ, higherZ), 0, 25, 40)?.path).toEqual([2]);

    const lowerPath = control({ stableIndex: [1, 2], plane: 1, zOrder: 2 });
    const higherPath = control({ type: "shape", stableIndex: [1, 3], plane: 1, zOrder: 2 });
    expect(hitRhwpObject(layout(lowerPath, higherPath), 0, 25, 40)?.path).toEqual([1, 3]);
  });

  it("refuses overlapping controls whose stacking order is tied", () => {
    const a = control({ stableIndex: [4], plane: 1, zOrder: 2 });
    const b = control({ type: "shape", stableIndex: [4], plane: 1, zOrder: 2 });
    expect(hitRhwpObject(layout(a, b), 0, 25, 40)).toBeNull();
  });

  it("refuses missing or duplicate engine object identity", () => {
    expect(hitRhwpObject(layout(control({ stableIndex: undefined })), 0, 25, 40)).toBeNull();
    expect(hitRhwpObject(layout(control({ controlIdx: undefined })), 0, 25, 40)).toBeNull();
    expect(hitRhwpObject(layout(control(), control({ type: "shape" })), 0, 25, 40)).toBeNull();
  });

  it("does not grab controls behind text or missing-picture placeholders", () => {
    expect(hitRhwpObject(layout(control({ wrap: "behindText" })), 0, 25, 40)).toBeNull();
    expect(hitRhwpObject(layout(control({ missing: true })), 0, 25, 40)).toBeNull();
  });

  it("rejects invalid points, pages, bounds, and unknown object types", () => {
    expect(hitRhwpObject(layout(control()), -1, 25, 40)).toBeNull();
    expect(hitRhwpObject(layout(control()), 0, Number.NaN, 40)).toBeNull();
    expect(hitRhwpObject(layout(control({ w: -1 })), 0, 25, 40)).toBeNull();
    expect(hitRhwpObject(layout(control({ type: "table" })), 0, 25, 40)).toBeNull();
    expect(hitRhwpObject({}, 0, 25, 40)).toBeNull();
  });
});
