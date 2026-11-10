import { describe, expect, it } from "vitest";
import { hwpReopenEqual, hwpReopenModel } from "./hwpReopenModel";
import type { RhwpDocument } from "./rhwpModule";
import { FakeDocument } from "./testing";

function model() {
  const state = {
    paragraphs: ["ABC", "DEF"], headType: "None", numberingId: 1, paraShapeId: 0,
    bullet: "•", cells: ["one", "two"], coordinates: [0, 1], width: 7200, inline: true,
    controls: [] as unknown[],
  };
  const doc = Object.assign(new FakeDocument(state.paragraphs), {
    getSectionCount: () => 1,
    getParaPropertiesAt: () => JSON.stringify({ headType: state.headType, paraLevel: 0, numberingId: state.numberingId, paraShapeId: state.paraShapeId, alignment: "left" }),
    getBulletList: () => JSON.stringify([{ id: state.numberingId, char: state.bullet, rawCode: state.bullet.charCodeAt(0) }]),
    getControls: () => JSON.stringify(state.controls),
    getTableDimensions: () => JSON.stringify({ rowCount: 1, colCount: 2, cellCount: 2 }),
    getTableProperties: () => JSON.stringify({ textWrap: "TopAndBottom", borderType: 1 }),
    getCellInfo: (_s: number, _p: number, _c: number, cell: number) => JSON.stringify({ row: 0, col: state.coordinates[cell], rowSpan: 1, colSpan: 1 }),
    getCellProperties: () => JSON.stringify({ borderType: 1, width: 3000 }),
    getCellParagraphCount: () => 1,
    getCellParagraphLength: (_s: number, _p: number, _c: number, cell: number) => state.cells[cell]!.length,
    getTextInCell: (_s: number, _p: number, _c: number, cell: number) => state.cells[cell],
    getPictureProperties: () => JSON.stringify({ width: state.width, height: 4800, treatAsChar: state.inline }),
  }) as unknown as RhwpDocument;
  return { doc, state };
}
const table = { ctrlId: "tbl", userDesc: "표", list: 0, para: 0, controlIndex: 0, pos: 0, props: {} };
const picture = { ...table, ctrlId: "gso", userDesc: "그림" };

describe("HWP detailed independent reopen evidence", () => {
  it("distinguishes paragraph boundaries even with identical concatenated text", () => {
    const live = model(), fresh = model(); (fresh.doc as unknown as FakeDocument).paragraphs.splice(0, 2, "A", "BCDEF");
    const a = hwpReopenModel(live.doc), b = hwpReopenModel(fresh.doc);
    expect(hwpReopenEqual(a, b, a.structure)).toBe(false);
  });
  it("compares table cell order, coordinates and text", () => {
    const live = model(), fresh = model(); live.state.controls = [table]; fresh.state.controls = [table];
    const a = hwpReopenModel(live.doc);
    expect(hwpReopenEqual(a, hwpReopenModel(fresh.doc), "new table")).toBe(true);
    fresh.state.cells = ["two", "one"];
    expect(hwpReopenEqual(a, hwpReopenModel(fresh.doc), a.structure)).toBe(false);
    fresh.state.cells = ["one", "two"]; fresh.state.coordinates = [1, 0];
    expect(hwpReopenEqual(a, hwpReopenModel(fresh.doc), a.structure)).toBe(false);
  });
  it("resolves bullet definition IDs and ignores ParaShape interning IDs", () => {
    const live = model(), fresh = model(); live.state.headType = fresh.state.headType = "Bullet";
    fresh.state.numberingId = 7; fresh.state.paraShapeId = 9;
    const a = hwpReopenModel(live.doc);
    expect(hwpReopenEqual(a, hwpReopenModel(fresh.doc), "new bullet")).toBe(true);
    fresh.state.bullet = "◆";
    expect(hwpReopenEqual(a, hwpReopenModel(fresh.doc), a.structure)).toBe(false);
    fresh.state.headType = "None";
    expect(hwpReopenEqual(a, hwpReopenModel(fresh.doc), a.structure)).toBe(false);
  });
  it("checks picture dimensions and inline state beyond raw controls", () => {
    const live = model(), fresh = model(); live.state.controls = [picture]; fresh.state.controls = [picture];
    const a = hwpReopenModel(live.doc); fresh.state.width++;
    expect(hwpReopenEqual(a, hwpReopenModel(fresh.doc), a.structure)).toBe(false);
    fresh.state.width--; fresh.state.inline = false;
    expect(hwpReopenEqual(a, hwpReopenModel(fresh.doc), a.structure)).toBe(false);
  });
  it("requires missing detailed APIs for changed structures while keeping legacy edits", () => {
    const live = model(); live.state.controls = [table]; delete live.doc.getCellInfo;
    const a = hwpReopenModel(live.doc);
    expect(a.complete).toBe(false);
    expect(hwpReopenEqual(a, a, a.structure)).toBe(true);
    expect(hwpReopenEqual(a, a, "new table")).toBe(false);
  });
  it("rejects malformed or unbounded model data", () => {
    const live = model(); live.doc.getSectionCount = () => Number.MAX_SAFE_INTEGER;
    expect(() => hwpReopenModel(live.doc)).toThrow("HWP model count");
  });
});
