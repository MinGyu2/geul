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

  it("rejects invalid engine addresses, an out-of-range page, and text selection mixed with object selection", () => {
    expect(parseDocxView({ ...view, object: { ...object, position: "body:not-a-path:1" } })).toBeNull();
    expect(parseDocxView({ ...view, object: { ...object, position: "body:0:-1" } })).toBeNull();
    expect(parseDocxView({ ...view, object: { ...object, position: "body:0:1", frame: { ...object.frame, page: 1 } } })).toBeNull();
    expect(parseDocxView({ ...view, object: { ...object, frame: { ...object.frame, page: 0.5 } } })).toBeNull();
    expect(parseDocxView({ ...view, object, caret: { page: 0, x: 72, y: 72, height: 18 } })).toBeNull();
    expect(parseDocxView({ ...view, object, selection: [{ page: 0, x: 1, y: 2, width: 3, height: 4 }] })).toBeNull();
  });
});
