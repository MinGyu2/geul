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
    const groupHit = hitRhwpObject(layout(control({ type: "group", stableIndex: [0, 2, 3] })), 0, 25, 40);
    expect(groupHit?.kind).toBe("group");
    expect(groupHit?.bodyGroup).toEqual([0, 2, 3]);
    expect(hitRhwpObject(layout(control({ type: "group", stableIndex: [0, 2, 3], cellIdx: 0 })), 0, 25, 40)?.bodyGroup).toBeUndefined();
  });

  it("exposes a body-picture address only when the engine path proves body ownership", () => {
    const body = control({ stableIndex: [0, 2, 3] });
    expect(hitRhwpObject(layout(body), 4, 25, 40)?.bodyPicture).toEqual([0, 2, 3]);

    // A two-entry hit path is still a usable selection identity, but cannot be
    // promoted to the body-only getter address.
    expect(hitRhwpObject(layout(control()), 4, 25, 40)?.bodyPicture).toBeUndefined();
    for (const ownership of [
      { headerFooter: true },
      { noteRef: 1 },
      { cellPath: [0, 1] },
      { cellIdx: 0 },
      { outerTableControlIdx: 8 },
    ]) {
      const hit = hitRhwpObject(layout(control({ stableIndex: [0, 2, 3], ...ownership })), 4, 25, 40);
      expect(hit?.kind).toBe("picture");
      expect(hit?.path).toEqual([0, 2, 3]);
      expect(hit?.bodyPicture).toBeUndefined();
    }
  });

  it("keeps header/footer picture ownership separate from the inner drawing address", () => {
    const hit = hitRhwpObject(layout(control({
      stableIndex: [0, 2, 3],
      secIdx: 2,
      paraIdx: 4,
      controlIdx: 5,
      headerFooter: { kind: "header", outerParaIdx: 8, outerControlIdx: 9 },
    })), 4, 25, 40);
    expect(hit?.headerFooterPicture).toEqual({
      section: 2,
      kind: "header",
      outerParagraph: 8,
      outerControl: 9,
      innerParagraph: 4,
      innerControl: 5,
    });
    expect(hit?.bodyPicture).toBeUndefined();

    const footer = hitRhwpObject(layout(control({
      stableIndex: [0, 2, 3],
      headerFooter: { kind: "footer", outerParaIdx: 8, outerControlIdx: 9 },
    })), 4, 25, 40);
    expect(footer?.headerFooterPicture?.kind).toBe("footer");
  });

  it("does not treat identical layout paths in different stories as duplicate objects", () => {
    const header = control({
      stableIndex: [0, 0, 0],
      secIdx: 0,
      paraIdx: 0,
      controlIdx: 0,
      headerFooter: { kind: "header", outerParaIdx: 0, outerControlIdx: 3 },
    });
    const footer = control({
      stableIndex: [0, 0, 0],
      secIdx: 0,
      paraIdx: 0,
      controlIdx: 0,
      x: 20,
      y: 900,
      headerFooter: { kind: "footer", outerParaIdx: 4, outerControlIdx: 0 },
    });
    expect(hitRhwpObject(layout(header, footer), 0, 25, 40)?.headerFooterPicture).toEqual({
      section: 0,
      kind: "header",
      outerParagraph: 0,
      outerControl: 3,
      innerParagraph: 0,
      innerControl: 0,
    });
    expect(hitRhwpObject(layout(header, footer), 0, 25, 910)?.headerFooterPicture).toEqual({
      section: 0,
      kind: "footer",
      outerParagraph: 4,
      outerControl: 0,
      innerParagraph: 0,
      innerControl: 0,
    });
    expect(hitRhwpObject(layout(header, { ...header }), 0, 25, 40)).toBeNull();
  });

  it("refuses malformed header/footer owners and never promotes them to body pictures", () => {
    for (const headerFooter of [
      true,
      { kind: "masterPage", outerParaIdx: 0, outerControlIdx: 0 },
      { kind: "header", outerParaIdx: -1, outerControlIdx: 0 },
      { kind: "footer", outerParaIdx: 0, outerControlIdx: 1.5 },
    ]) {
      const hit = hitRhwpObject(layout(control({
        body: true,
        stableIndex: [0, 2, 3],
        headerFooter,
      })), 4, 25, 40);
      expect(hit?.headerFooterPicture).toBeUndefined();
      expect(hit?.bodyPicture).toBeUndefined();
    }

    const shape = hitRhwpObject(layout(control({
      type: "shape",
      headerFooter: { kind: "header", outerParaIdx: 0, outerControlIdx: 0 },
    })), 4, 25, 40);
    expect(shape?.headerFooterPicture).toBeUndefined();
    expect(shape?.headerFooterShape).toEqual({
      section: 0,
      kind: "header",
      outerParagraph: 0,
      outerControl: 0,
      innerParagraph: 2,
      innerControl: 3,
    });
    expect(shape?.bodyShape).toBeUndefined();
  });

  it("preserves the complete nested header/footer table path and rejects mismatched paths", () => {
    const owner = { kind: "header", outerParaIdx: 8, outerControlIdx: 9 };
    const cellPath = [{ controlIndex: 3, cellIndex: 4, cellParaIndex: 5 }];
    const nested = control({
      type: "shape",
      secIdx: 0,
      paraIdx: 2,
      controlIdx: 7,
      stableIndex: [0, 2, 3, 4, 5, 7],
      headerFooter: owner,
      parentParaIdx: 2,
      outerTableControlIdx: 3,
      cellIdx: 4,
      cellParaIdx: 5,
      cellPath,
    });
    const hit = hitRhwpObject(layout(nested), 4, 25, 40);
    expect(hit?.headerFooterShape).toEqual({
      section: 0,
      kind: "header",
      outerParagraph: 8,
      outerControl: 9,
      innerParagraph: 2,
      innerControl: 7,
      cellPath: JSON.stringify(cellPath),
    });
    expect(hit?.bodyShape).toBeUndefined();

    // RHWP's current renderer emits the authoritative cell path and stable path,
    // but omits parentParaIdx for header/footer story controls.
    const rendererLayoutShape: Record<string, unknown> = { ...nested };
    delete rendererLayoutShape.parentParaIdx;
    const rendererHit = hitRhwpObject(layout(rendererLayoutShape), 4, 25, 40);
    expect(rendererHit?.headerFooterShape).toEqual(hit?.headerFooterShape);
    expect(rendererHit?.bodyShape).toBeUndefined();

    const mismatchedParent = hitRhwpObject(layout({ ...nested, parentParaIdx: 1 }), 4, 25, 40);
    expect(mismatchedParent?.headerFooterShape).toBeUndefined();
    expect(mismatchedParent?.bodyShape).toBeUndefined();

    const mismatched = { ...nested, stableIndex: [0, 2, 3, 4, 6, 7] };
    const rejected = hitRhwpObject(layout(mismatched), 4, 25, 40);
    expect(rejected?.headerFooterShape).toBeUndefined();
    expect(rejected?.bodyShape).toBeUndefined();
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

  it("resolves multi-level nested table cell pictures only when cellPath and stableIndex agree", () => {
    const nested = control({
      secIdx: 0,
      paraIdx: 1,
      parentParaIdx: 1,
      outerTableControlIdx: 4,
      cellIdx: 2,
      cellParaIdx: 3,
      controlIdx: 5,
      cellPath: [
        { controlIndex: 2, cellIndex: 1, cellParaIndex: 0 },
        { controlIndex: 4, cellIndex: 2, cellParaIndex: 3 },
      ],
      stableIndex: [0, 1, 2, 1, 0, 4, 2, 3, 5],
    });
    expect(hitRhwpObject(layout(nested), 0, 25, 40)?.cellPicture).toEqual({
      section: 0,
      paragraph: 1,
      control: 5,
      path: JSON.stringify([
        { controlIndex: 2, cellIndex: 1, cellParaIndex: 0 },
        { controlIndex: 4, cellIndex: 2, cellParaIndex: 3 },
      ]),
    });

    expect(hitRhwpObject(layout({ ...nested, stableIndex: [0, 1, 2, 1, 0, 99, 2, 3, 5] }), 0, 25, 40)?.cellPicture).toBeUndefined();
    expect(hitRhwpObject(layout({ ...nested, headerFooter: true }), 0, 25, 40)?.cellPicture).toBeUndefined();
    expect(hitRhwpObject(layout({ ...nested, noteRef: 1 }), 0, 25, 40)?.cellPicture).toBeUndefined();
  });

  it("resolves a text-box-owned shape only from its complete stable cell path", () => {
    const cellPath = [
      { controlIndex: 4, cellIndex: 0, cellParaIndex: 2 },
      { controlIndex: 1, cellIndex: 0, cellParaIndex: 0 },
    ];
    const nested = control({
      type: "shape",
      secIdx: 3,
      paraIdx: 7,
      controlIdx: 0,
      parentParaIdx: 7,
      cellPath,
      stableIndex: [3, 7, 4, 0, 2, 1, 0, 0, 0],
    });
    const hit = hitRhwpObject(layout(nested), 0, 25, 40);
    expect(hit?.cellShape).toEqual({
      section: 3,
      paragraph: 7,
      control: 0,
      path: JSON.stringify(cellPath),
    });
    expect(hit?.bodyShape).toBeUndefined();

    expect(hitRhwpObject(layout({
      ...nested,
      stableIndex: [3, 7, 4, 0, 2, 1, 0, 0, 2],
    }), 0, 25, 40)?.cellShape).toBeUndefined();
  });

  it("rejects invalid points, pages, bounds, and unknown object types", () => {
    expect(hitRhwpObject(layout(control()), -1, 25, 40)).toBeNull();
    expect(hitRhwpObject(layout(control()), 0, Number.NaN, 40)).toBeNull();
    expect(hitRhwpObject(layout(control({ w: -1 })), 0, 25, 40)).toBeNull();
    expect(hitRhwpObject(layout(control({ type: "table" })), 0, 25, 40)).toBeNull();
    expect(hitRhwpObject({}, 0, 25, 40)).toBeNull();
  });
});
