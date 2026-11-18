import { describe, expect, it } from "vitest";
import { parseDocxView } from "./docx";

const view = {
  pages: [{ width: 612, height: 792 }],
  caret: null,
  selection: [],
  collapsed: true,
  inTable: false,
  caretKey: "body:0:0",
  anchorKey: "body:0:0",
  paragraphText: "가나",
  caretOffset: 0,
  history: { undo: false, redo: false },
  format: { bold: false, italic: false, underline: false, strikethrough: false, font: "Source Serif 4", fontEastAsia: null },
  formatAccess: "allowed",
  trackedReadOnly: false,
  hasToc: false,
  tracking: false,
  hasRevisions: false,
  fontGeneration: 3,
};

const object = {
  kind: "picture",
  position: "body:2.1:128",
  frame: { page: 0, x: 72, y: 80, width: 160, height: 90 },
  epoch: 1,
  operations: ["move", "resize", "delete"],
};

describe("DOCX object view parsing", () => {
  it("accepts an engine-owned object address and its page geometry", () => {
    expect(parseDocxView({ ...view, object })).toMatchObject({
      object: {
        kind: "picture",
        address: { engine: "wordcraft", position: "body:2.1:128" },
        frame: { page: 0, x: 72, y: 80, width: 160, height: 90 },
        epoch: 1,
      },
      caret: null,
      selection: [],
    });
  });

  it("keeps engine picture properties separate from the displayed frame", () => {
    expect(parseDocxView({
      ...view,
      object: {
        ...object,
        frame: { page: 0, x: 72, y: 80, width: 160, height: 90 },
        picture: { widthPt: 144, heightPt: 72, wrap: "square", description: "그림 설명" },
      },
    })?.object).toEqual({
      kind: "picture",
      address: { engine: "wordcraft", position: "body:2.1:128" },
      frame: { page: 0, x: 72, y: 80, width: 160, height: 90 },
      epoch: 1,
      operations: ["move", "resize", "delete"],
      picture: { widthPt: 144, heightPt: 72, wrap: "square", description: "그림 설명" },
    });
  });

  it("rejects missing, unknown or duplicated object operations", () => {
    const withoutOperations = Object.fromEntries(Object.entries(object).filter(([key]) => key !== "operations"));
    expect(parseDocxView({ ...view, object: withoutOperations })).toBeNull();
    expect(parseDocxView({ ...view, object: { ...object, operations: ["rotate"] } })).toBeNull();
    expect(parseDocxView({ ...view, object: { ...object, operations: ["move", "move"] } })).toBeNull();
    expect(parseDocxView({ ...view, object: { ...object, operations: "move" } })).toBeNull();
    expect(parseDocxView({ ...view, object: { ...object, operations: [] } })?.object?.operations).toEqual([]);
  });

  it.each([
    ["zero width", { widthPt: 0, heightPt: 72, wrap: "square" }],
    ["negative height", { widthPt: 72, heightPt: -1, wrap: "square" }],
    ["non-finite width", { widthPt: Number.POSITIVE_INFINITY, heightPt: 72, wrap: "square" }],
    ["unknown wrap", { widthPt: 72, heightPt: 72, wrap: "around" }],
    ["unexpected field", { widthPt: 72, heightPt: 72, wrap: "square", source: "unknown" }],
    ["malformed description", { widthPt: 72, heightPt: 72, wrap: "square", description: 123 }],
  ])("rejects malformed picture properties (%s)", (_name, picture) => {
    expect(parseDocxView({ ...view, object: { ...object, picture } })).toBeNull();
  });

  it("rejects picture properties attached to a non-picture object", () => {
    expect(parseDocxView({
      ...view,
      object: { ...object, kind: "shape", picture: { widthPt: 72, heightPt: 36, wrap: "inline" } },
    })).toBeNull();
  });

  it("rejects invalid engine addresses, an out-of-range page, and text selection mixed with object selection", () => {
    expect(parseDocxView({ ...view, object: { ...object, position: "body:not-a-path:1" } })).toBeNull();
    expect(parseDocxView({ ...view, object: { ...object, position: "body:0:-1" } })).toBeNull();
    expect(parseDocxView({ ...view, object: { ...object, position: "body:0:1", frame: { ...object.frame, page: 1 } } })).toBeNull();
    expect(parseDocxView({ ...view, object: { ...object, frame: { ...object.frame, page: 0.5 } } })).toBeNull();
    expect(parseDocxView({ ...view, object, caret: { page: 0, x: 72, y: 72, height: 18 } })).toBeNull();
    expect(parseDocxView({ ...view, object, selection: [{ page: 0, x: 1, y: 2, width: 3, height: 4 }] })).toBeNull();
  });
});
