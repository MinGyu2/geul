import { describe, expect, it } from "vitest";
import { HwpEvidenceError, hwpReopenEqual, hwpReopenModel, tableLayoutConsistent } from "./hwpReopenModel";
import type { RhwpDocument } from "./rhwpModule";
import { FakeDocument } from "./testing";

// Shapes follow the selected Release RHWP generation's getter output (fields abbreviated
// to the required set plus a few optional presentation fields).
const border = { type: 1, width: 1, color: "#000000" };
const borders = { borderLeft: border, borderRight: border, borderTop: border, borderBottom: border };
type Override = Record<string, unknown> | unknown[] | string | null;
function model() {
  const state = {
    paragraphs: ["ABC", "DEF"], headType: "None", numberingId: 1, paraShapeId: 0,
    bullet: "•", cells: ["one", "two"], coordinates: [0, 1], width: 7200, inline: true,
    controls: [] as unknown[], rows: 1, cols: 2, extraParagraphs: {} as Record<number, string[]>,
    cursorLists: [] as unknown[], fields: [] as unknown[],
    validation: { ok: true, changed: false, fieldId: 1, text: "0", command: "=0??%g,;;0" } as Record<string, unknown>,
    para: null as Override, bullets: null as Override, dims: null as Override, tableProps: null as Override,
    cellInfo: null as Override, cellProps: null as Override, picture: null as Override,
  };
  const encode = (override: Override, value: unknown) => typeof override === "string" ? override
    : JSON.stringify(override === null ? value : override);
  const doc = Object.assign(new FakeDocument(state.paragraphs), {
    getSectionCount: () => 1,
    getParaPropertiesAt: () => encode(state.para, { alignment: "justify", paraShapeId: state.paraShapeId, headType: state.headType, paraLevel: 0, numberingId: state.numberingId }),
    getBulletList: () => encode(state.bullets, [{ id: state.numberingId, char: state.bullet, rawCode: state.bullet.charCodeAt(0) }]),
    getControls: () => JSON.stringify(state.controls),
    getCursorModel: () => JSON.stringify({ lists: state.cursorLists }),
    getFieldList: () => JSON.stringify(state.fields),
    validateTableFormulaField: () => JSON.stringify(state.validation),
    getTableDimensions: () => encode(state.dims, { rowCount: state.rows, colCount: state.cols, cellCount: state.cells.length }),
    getTableProperties: () => encode(state.tableProps, { cellSpacing: 0, paddingLeft: 510, paddingRight: 510, paddingTop: 141, paddingBottom: 141, repeatHeader: false, borderFillId: 3, ...borders, tableWidth: 41952, tableHeight: 2564, treatAsChar: false, textWrap: "TopAndBottom" }),
    getCellInfo: (_s: number, _p: number, _c: number, cell: number) => encode(state.cellInfo, { row: 0, col: state.coordinates[cell], rowSpan: 1, colSpan: 1 }),
    getCellProperties: () => encode(state.cellProps, { width: 13984, height: 282, paddingLeft: 510, paddingRight: 510, paddingTop: 141, paddingBottom: 141, verticalAlign: 1, isHeader: false, borderFillId: 3, ...borders }),
    getCellParagraphCount: (_s: number, _p: number, _c: number, cell: number) => 1 + (state.extraParagraphs[cell]?.length ?? 0),
    getCellParagraphLength: (_s: number, _p: number, _c: number, cell: number, paragraph = 0) => {
      const text = paragraph === 0 ? state.cells[cell] : state.extraParagraphs[cell]?.[paragraph - 1];
      return text?.length ?? 0;
    },
    getTextInCell: (_s: number, _p: number, _c: number, cell: number, paragraph = 0, start = 0, length?: number) => {
      const text = paragraph === 0 ? state.cells[cell] : state.extraParagraphs[cell]?.[paragraph - 1];
      return text?.slice(start, length === undefined ? undefined : start + length) ?? "";
    },
    getPictureProperties: () => encode(state.picture, { width: state.width, height: 4800, treatAsChar: state.inline, textWrap: "Square", originalWidth: 7200 }),
  }) as unknown as RhwpDocument;
  return { doc, state };
}
const tableProps = { Lock: 0, TreatAsChar: 0, AllowOverlap: 0, TextWrap: 1, Width: 41952, Height: 2564, HorzOffset: 0, VertOffset: 0 };
const table = { ctrlId: "tbl", userDesc: "표", list: 0, para: 0, controlIndex: 0, pos: 0, props: tableProps };
const picture = { ...table, ctrlId: "gso", userDesc: "그림", props: { ...tableProps, TreatAsChar: 1, TextWrap: 0, Width: 7200, Height: 4800 } };

const formulaFieldControl = { ctrlId: "", userDesc: "", list: 2, para: 0, controlIndex: 0, ctrlCh: 0, pos: 0, props: {} };
const clickHereFieldControl = { ...formulaFieldControl, list: 3, para: 1 };
function cellFieldModels(kind: "formula" | "clickhere" = "formula") {
  const live = model(), fresh = model();
  const list = (listId: number, cellIndex: number, paraCount: number, row: number, col: number) => ({
    listId, hostListId: 0, sectionIndex: 0, hostPara: 0, controlIndex: 0, cellIndex, paraCount,
    row, col, rowSpan: 1, colSpan: 1, cellCount: 2, isCell: true,
  });
  const field = kind === "formula" ? {
    fieldId: 1, listId: 2, paraInList: 0, fieldType: "formula", cellField: false, editableInForm: true,
    name: "", guide: "", command: "=A1+B1??%g,;;30", value: "30",
    startCharIdx: 0, endCharIdx: 2, startPos: 0, endPos: 2,
    location: { sectionIndex: 0, paraIndex: 0, path: [{ type: "cell", controlIndex: 0, cellIndex: 0, paraIndex: 0 }] },
  } : {
    fieldId: 2, listId: 3, paraInList: 1, fieldType: "clickhere", cellField: false, editableInForm: true,
    name: "tail field", guide: "tail guide", command: "Clickhere:tail", value: "tail",
    startCharIdx: 0, endCharIdx: 4, startPos: 0, endPos: 4,
    location: { sectionIndex: 0, paraIndex: 0, path: [{ type: "cell", controlIndex: 0, cellIndex: 1, paraIndex: 1 }] },
  };
  for (const fixture of [live, fresh]) {
    fixture.state.cells[kind === "formula" ? 0 : 1] = kind === "formula" ? "30" : "two";
    fixture.state.controls = [table, kind === "formula" ? formulaFieldControl : clickHereFieldControl];
    fixture.state.cursorLists = kind === "formula"
      ? [list(2, 0, 1, 0, 0)]
      : [list(3, 1, 2, 0, 1)];
    if (kind === "clickhere") fixture.state.extraParagraphs[1] = ["tail"];
    fixture.state.fields = [JSON.parse(JSON.stringify(field))];
  }
  return { live, fresh, field: live.state.fields[0] as Record<string, unknown>, baseline: hwpReopenModel(model().doc).structure };
}

/** Live/reopened pair carrying the same new structure (as after a supported insertion). */
function inserted(control: unknown) {
  const live = model(), fresh = model();
  live.state.controls = [control]; fresh.state.controls = [control];
  return { live, fresh, baseline: hwpReopenModel(model().doc).structure };
}

describe("HWP detailed independent reopen evidence", () => {
  it("distinguishes paragraph boundaries even with identical concatenated text", () => {
    const live = model(), fresh = model(); (fresh.doc as unknown as FakeDocument).paragraphs.splice(0, 2, "A", "BCDEF");
    const a = hwpReopenModel(live.doc), b = hwpReopenModel(fresh.doc);
    expect(hwpReopenEqual(a, b, a.structure)).toBe(false);
  });
  it("compares table cell order, coordinates and text", () => {
    const live = model(), fresh = model(); live.state.controls = [table]; fresh.state.controls = [table];
    const a = hwpReopenModel(live.doc);
    expect(a.complete).toBe(true);
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
    expect(a.complete).toBe(true);
    expect(hwpReopenEqual(a, hwpReopenModel(fresh.doc), "new bullet")).toBe(true);
    fresh.state.bullet = "◆";
    expect(hwpReopenEqual(a, hwpReopenModel(fresh.doc), a.structure)).toBe(false);
    fresh.state.headType = "None";
    expect(hwpReopenEqual(a, hwpReopenModel(fresh.doc), a.structure)).toBe(false);
  });
  it("checks picture dimensions and inline state beyond raw controls", () => {
    const live = model(), fresh = model(); live.state.controls = [picture]; fresh.state.controls = [picture];
    const a = hwpReopenModel(live.doc);
    expect(a.complete).toBe(true);
    expect(hwpReopenEqual(a, hwpReopenModel(fresh.doc), "new picture")).toBe(true);
    fresh.state.width++;
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
  it("keeps an unchanged legacy document without optional APIs comparable", () => {
    const live = model(); delete live.doc.getBulletList; delete live.doc.getPictureProperties;
    live.state.controls = [picture];
    const a = hwpReopenModel(live.doc);
    expect(a.complete).toBe(false);
    expect(hwpReopenEqual(a, hwpReopenModel(live.doc), a.structure)).toBe(true);
  });
  it("rejects malformed or unbounded model data", () => {
    const live = model(); live.doc.getSectionCount = () => Number.MAX_SAFE_INTEGER;
    expect(() => hwpReopenModel(live.doc)).toThrow("HWP model count");
  });
});

describe("required HWP reopen evidence fields", () => {
  // Empty objects from feature getters previously left `complete` true.
  it.each([
    ["getCellInfo", "cellInfo", table],
    ["getCellProperties", "cellProps", table],
    ["getTableProperties", "tableProps", table],
    ["getTableDimensions", "dims", table],
    ["getPictureProperties", "picture", picture],
    ["getParaPropertiesAt", "para", null],
  ] as const)("%s returning {} is not complete evidence", (_name, key, control) => {
    const { live } = inserted(control ?? table);
    if (!control) live.state.controls = [];
    live.state[key] = {};
    expect(() => hwpReopenModel(live.doc)).toThrow(HwpEvidenceError);
  });
  it("a structural insertion cannot pass with an empty getter result on either side", () => {
    const { live, fresh, baseline } = inserted(table);
    const a = hwpReopenModel(live.doc);
    expect(hwpReopenEqual(a, hwpReopenModel(fresh.doc), baseline)).toBe(true);
    fresh.state.cellInfo = {};
    let equal = false;
    try { equal = hwpReopenEqual(a, hwpReopenModel(fresh.doc), baseline); } catch { /* refused */ }
    expect(equal).toBe(false);
  });
  it.each([
    ["missing headType", { paraShapeId: 0, paraLevel: 0, numberingId: 1 }],
    ["unknown headType", { paraShapeId: 0, headType: "Star", paraLevel: 0, numberingId: 1 }],
    ["missing numberingId", { paraShapeId: 0, headType: "Bullet", paraLevel: 0 }],
    ["string numberingId", { paraShapeId: 0, headType: "Bullet", paraLevel: 0, numberingId: "1" }],
    ["negative numberingId", { paraShapeId: 0, headType: "Bullet", paraLevel: 0, numberingId: -1 }],
    ["invalid level", { paraShapeId: 0, headType: "Bullet", paraLevel: 9, numberingId: 1 }],
    ["fractional level", { paraShapeId: 0, headType: "Bullet", paraLevel: 0.5, numberingId: 1 }],
  ])("rejects bullet paragraph with %s", (_name, para) => {
    const live = model(); live.state.para = para;
    expect(() => hwpReopenModel(live.doc)).toThrow(HwpEvidenceError);
  });
  it.each([
    ["missing char", [{ id: 1, rawCode: 8226 }]],
    ["numeric char", [{ id: 1, char: 8226, rawCode: 8226 }]],
    ["missing rawCode", [{ id: 1, char: "•" }]],
    ["zero id", [{ id: 0, char: "•", rawCode: 8226 }]],
    ["null entry", [null]],
  ])("rejects malformed bullet definition: %s", (_name, bullets) => {
    const live = model(); live.state.bullets = bullets as unknown as Record<string, unknown>;
    expect(() => hwpReopenModel(live.doc)).toThrow();
  });
  it("an unknown bullet definition ID is incomplete and fails a structural change", () => {
    const live = model(); live.state.headType = "Bullet"; live.state.bullets = [];
    const a = hwpReopenModel(live.doc);
    expect(a.complete).toBe(false);
    expect(hwpReopenEqual(a, a, "before bullets")).toBe(false);
    live.state.numberingId = 0; live.state.bullets = [{ id: 1, char: "•", rawCode: 8226 }];
    expect(hwpReopenModel(live.doc).complete).toBe(false); // Bullet with ID 0 never resolves
  });
  it.each([
    ["string width", "picture", { width: "7200", height: 4800, treatAsChar: true, textWrap: "Square" }, picture],
    ["number treatAsChar", "picture", { width: 7200, height: 4800, treatAsChar: 1, textWrap: "Square" }, picture],
    ["null height", "picture", { width: 7200, height: null, treatAsChar: true, textWrap: "Square" }, picture],
    ["negative width", "picture", { width: -1, height: 4800, treatAsChar: true, textWrap: "Square" }, picture],
    ["huge width", "picture", { width: 2 ** 40, height: 4800, treatAsChar: true, textWrap: "Square" }, picture],
    ["string rowSpan", "cellInfo", { row: 0, col: 0, rowSpan: "1", colSpan: 1 }, table],
    ["fractional row", "cellInfo", { row: 0.5, col: 0, rowSpan: 1, colSpan: 1 }, table],
    ["boolean isHeader as number", "cellProps", { width: 1, height: 1, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0, verticalAlign: 1, isHeader: 0, ...borders }, table],
    ["missing borders", "cellProps", { width: 1, height: 1, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0, verticalAlign: 1, isHeader: false }, table],
    ["unknown textWrap", "tableProps", { cellSpacing: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0, repeatHeader: false, ...borders, tableWidth: 1, tableHeight: 1, treatAsChar: false, textWrap: "Around" }, table],
    ["string treatAsChar", "tableProps", { cellSpacing: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0, repeatHeader: false, ...borders, tableWidth: 1, tableHeight: 1, treatAsChar: "false", textWrap: "TopAndBottom" }, table],
    ["string rowCount", "dims", { rowCount: "1", colCount: 2, cellCount: 2 }, table],
    ["negative colCount", "dims", { rowCount: 1, colCount: -2, cellCount: 2 }, table],
  ] as const)("rejects invalid field type/value: %s", (_name, key, value, control) => {
    const { live } = inserted(control); live.state[key] = value as Record<string, unknown>;
    expect(() => hwpReopenModel(live.doc)).toThrow();
  });
  it.each([
    ["null", "null"], ["array", "[]"], ["malformed JSON", "{\"row\":"], ["number", "7"],
  ])("rejects %s instead of an object", (_name, raw) => {
    const { live } = inserted(table); live.state.cellInfo = raw;
    expect(() => hwpReopenModel(live.doc)).toThrow();
  });
  it("rejects a controls/bullets result of the wrong array/object shape", () => {
    const live = model(); live.doc.getControls = () => "{}";
    expect(() => hwpReopenModel(live.doc)).toThrow("HWP controls");
    const other = model(); other.state.bullets = { id: 1 };
    expect(() => hwpReopenModel(other.doc)).toThrow("HWP bullets");
  });
  it("rejects control props missing required numeric flags", () => {
    const { live } = inserted({ ...table, props: {} });
    expect(() => hwpReopenModel(live.doc)).toThrow(HwpEvidenceError);
  });
  it.each([
    ["zero rows", { rowCount: 0, colCount: 2, cellCount: 2 }],
    ["cellCount above grid", { rowCount: 1, colCount: 1, cellCount: 2 }],
  ])("invalid table dimensions (%s) are not complete evidence", (_name, dims) => {
    const { live, baseline } = inserted(table); live.state.dims = dims;
    const a = hwpReopenModel(live.doc);
    expect(a.complete).toBe(false);
    expect(hwpReopenEqual(a, a, baseline)).toBe(false);
  });
  it("excessive table dimensions are refused", () => {
    const { live } = inserted(table); live.state.dims = { rowCount: 5000, colCount: 2, cellCount: 2 };
    expect(() => hwpReopenModel(live.doc)).toThrow("HWP model count");
  });
  it("duplicate cell coordinates are not complete evidence", () => {
    const { live, baseline } = inserted(table); live.state.coordinates = [0, 0];
    const a = hwpReopenModel(live.doc);
    expect(a.complete).toBe(false);
    expect(hwpReopenEqual(a, a, baseline)).toBe(false);
    expect(hwpReopenEqual(a, a, a.structure)).toBe(true); // an unchanged legacy table keeps the raw comparison
  });
  it.each([
    ["zero span", { row: 0, col: 0, rowSpan: 0, colSpan: 1 }],
    ["span past grid", { row: 0, col: 0, rowSpan: 1, colSpan: 3 }],
    ["row past grid", { row: 1, col: 0, rowSpan: 1, colSpan: 1 }],
  ])("invalid cell spans (%s) are not complete evidence", (_name, info) => {
    const { live, baseline } = inserted(table); live.state.cellInfo = info;
    const a = hwpReopenModel(live.doc);
    expect(a.complete).toBe(false);
    expect(hwpReopenEqual(a, a, baseline)).toBe(false);
  });
  it("table layout consistency covers missing cells and merged spans", () => {
    expect(tableLayoutConsistent(2, 2, [{ row: 0, col: 0, rowSpan: 1, colSpan: 1 }, { row: 0, col: 1, rowSpan: 1, colSpan: 1 }, { row: 1, col: 0, rowSpan: 1, colSpan: 2 }])).toBe(true);
    expect(tableLayoutConsistent(2, 2, [{ row: 0, col: 0, rowSpan: 1, colSpan: 1 }, { row: 0, col: 1, rowSpan: 1, colSpan: 1 }, { row: 1, col: 0, rowSpan: 1, colSpan: 1 }])).toBe(false);
    expect(tableLayoutConsistent(1, 2, [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }, { row: 0, col: 1, rowSpan: 1, colSpan: 1 }])).toBe(false);
  });
  it("disagreeing control wrap bits (raw TBL-001) are not complete evidence", () => {
    const { live, baseline } = inserted({ ...table, props: { ...tableProps, TextWrap: 0 } });
    const a = hwpReopenModel(live.doc);
    expect(a.complete).toBe(false);
    expect(hwpReopenEqual(a, a, baseline)).toBe(false);
  });
  it.each([
    ["zero width", { width: 0 }],
    ["control size disagreement", { width: 7300 }],
    ["control inline disagreement", { inline: false }],
  ])("picture %s is not complete evidence", (_name, change) => {
    const { live, baseline } = inserted(picture); Object.assign(live.state, change);
    const a = hwpReopenModel(live.doc);
    expect(a.complete).toBe(false);
    expect(hwpReopenEqual(a, a, baseline)).toBe(false);
  });
  it("valid complete structural insertion evidence passes", () => {
    const live = model(), fresh = model();
    for (const m of [live, fresh]) { m.state.controls = [table, { ...picture, para: 1 }]; m.state.headType = "Bullet"; }
    fresh.state.numberingId = 3;
    const a = hwpReopenModel(live.doc), b = hwpReopenModel(fresh.doc);
    expect(a.complete && b.complete).toBe(true);
    expect(hwpReopenEqual(a, b, hwpReopenModel(model().doc).structure)).toBe(true);
  });
});

describe("joined HWP cell-field reopen evidence", () => {
  it("accepts a sole full paragraph-zero formula field validated against its owning cell", () => {
    const { live, fresh, baseline } = cellFieldModels("formula");
    const a = hwpReopenModel(live.doc), b = hwpReopenModel(fresh.doc);
    expect(a.complete).toBe(true);
    expect(b.complete).toBe(true);
    expect(hwpReopenEqual(a, b, baseline)).toBe(true);
  });

  it("accepts an untouched ClickHere field in a later cell paragraph", () => {
    const { live, fresh, baseline } = cellFieldModels("clickhere");
    const a = hwpReopenModel(live.doc), b = hwpReopenModel(fresh.doc);
    expect(a.complete).toBe(true);
    expect(b.complete).toBe(true);
    expect(hwpReopenEqual(a, b, baseline)).toBe(true);
  });

  it.each([
    "missing field metadata",
    "duplicate field metadata",
    "duplicate paragraph control",
    "wrong field list",
    "wrong field location",
    "wrong cursor-list cell owner",
    "nested field location",
    "unsupported field type",
    "field text differs from paragraph",
    "cached result disagrees",
    "engine probe returns another field",
  ])("keeps %s incomplete and refuses a changed inventory", name => {
    const { live, fresh, baseline, field } = cellFieldModels("formula");
    switch (name) {
      case "missing field metadata": live.state.fields = []; break;
      case "duplicate field metadata": live.state.fields.push(JSON.parse(JSON.stringify(field))); break;
      case "duplicate paragraph control": live.state.controls.push({ ...formulaFieldControl }); break;
      case "wrong field list": field.listId = 99; break;
      case "wrong field location":
        ((field.location as Record<string, unknown>).path as Record<string, unknown>[])[0]!.cellIndex = 1;
        break;
      case "wrong cursor-list cell owner": live.state.cursorLists[0] = { ...(live.state.cursorLists[0] as object), cellIndex: 1 };
        break;
      case "nested field location":
        ((field.location as Record<string, unknown>).path as unknown[]).push({ type: "cell", controlIndex: 1, cellIndex: 0, paraIndex: 0 });
        break;
      case "unsupported field type": (field as Record<string, unknown>).fieldType = "unknown";
        break;
      case "field text differs from paragraph": live.state.cells[0] = "31";
        break;
      case "cached result disagrees": field.command = "=A1+B1??%g,;;29";
        break;
      case "engine probe returns another field": live.state.validation.fieldId = 2;
        break;
    }
    const a = hwpReopenModel(live.doc), b = hwpReopenModel(fresh.doc);
    expect(a.complete).toBe(false);
    expect(hwpReopenEqual(a, b, baseline)).toBe(false);
  });

  it("compares recognized formula and ClickHere metadata, not only cached/display text", () => {
    {
      const { live, fresh, baseline } = cellFieldModels("formula");
      const a = hwpReopenModel(live.doc);
      (fresh.state.fields[0] as Record<string, unknown>).command = "=A1+B1+1??%g,;;30";
      const b = hwpReopenModel(fresh.doc);
      expect(a.complete && b.complete).toBe(true);
      expect(hwpReopenEqual(a, b, baseline)).toBe(false);
    }
    {
      const { live, fresh, baseline } = cellFieldModels("clickhere");
      const a = hwpReopenModel(live.doc);
      const changed = fresh.state.fields[0] as Record<string, unknown>;
      changed.name = "renamed field";
      changed.guide = "different guide";
      const b = hwpReopenModel(fresh.doc);
      expect(a.complete && b.complete).toBe(true);
      expect(hwpReopenEqual(a, b, baseline)).toBe(false);
    }
  });
});
