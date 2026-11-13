import type { RhwpDocument } from "./rhwpModule";
import { canonical } from "./rhwpArtifactIdentity";
import { cachedFormula } from "./formulaDependencies";

type JsonObject = Record<string, unknown>;
export interface HwpReopenModel { model: string; structure: string; complete: boolean }

/** A getter result whose required fields are missing or of the wrong JSON type. */
export class HwpEvidenceError extends Error {
  constructor(what: string) { super(`HWP model evidence: ${what}`); this.name = "HwpEvidenceError"; }
}

// Required fields, taken from the selected RHWP generation's serializers
// (getParaPropertiesAt / getBulletList / getTable*/getCell* / getPictureProperties and
// the getControls `props` set). Other fields are optional presentation metadata:
// they are compared verbatim when present but never required.
const HEAD_TYPES = new Set(["None", "Outline", "Number", "Bullet"]);
const TEXT_WRAPS = new Set(["Square", "TopAndBottom", "BehindText", "InFrontOfText"]);
// Control props expose attr bits 21–22; the parser maps 0–3 to these wrap modes.
const CONTROL_WRAP = ["Square", "TopAndBottom", "BehindText", "InFrontOfText"] as const;
const HWPUNIT_MAX = 0x7fff_ffff;
const MAX_TABLE_ROWS = 4096, MAX_TABLE_COLS = 4096, MAX_TABLE_COVERAGE = 1_000_000;

const isObject = (v: unknown): v is JsonObject => !!v && typeof v === "object" && !Array.isArray(v);
const isInt = (v: unknown, min = -HWPUNIT_MAX - 1, max = HWPUNIT_MAX): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

/** Throw unless `o[key]` exists with the required JSON type. Returns the value. */
function field(o: JsonObject, key: string, type: "int" | "uint" | "boolean" | "string" | "border", what: string): unknown {
  const v = o[key];
  const valid = type === "int" ? isInt(v)
    : type === "uint" ? isInt(v, 0)
      : type === "boolean" ? typeof v === "boolean"
        : type === "string" ? typeof v === "string"
          : isObject(v) && isInt(v.type, 0) && isInt(v.width, 0) && typeof v.color === "string";
  if (!valid) throw new HwpEvidenceError(`${what}.${key}`);
  return v;
}
const fields = (o: JsonObject, what: string, type: Parameters<typeof field>[2], ...keys: string[]) => {
  for (const key of keys) field(o, key, type, what);
};
const BORDERS = ["borderLeft", "borderRight", "borderTop", "borderBottom"];

/** Paragraph properties: heading kind, level and numbering reference are required. */
export function checkParaProperties(o: JsonObject): void {
  if (typeof o.headType !== "string" || !HEAD_TYPES.has(o.headType)) throw new HwpEvidenceError("paragraph.headType");
  if (!isInt(o.paraLevel, 0, 7)) throw new HwpEvidenceError("paragraph.paraLevel");
  if (!isInt(o.numberingId, 0, 65535)) throw new HwpEvidenceError("paragraph.numberingId");
  field(o, "paraShapeId", "uint", "paragraph");
}
/** Bullet definition from getBulletList. */
export function checkBulletDefinition(o: JsonObject): void {
  if (!isInt(o.id, 1, 65535)) throw new HwpEvidenceError("bullet.id");
  if (typeof o.char !== "string" || o.char.length < 1 || o.char.length > 2) throw new HwpEvidenceError("bullet.char");
  if (!isInt(o.rawCode, 0, 0x10ffff)) throw new HwpEvidenceError("bullet.rawCode");
}
export function checkTableDimensions(o: JsonObject): void { fields(o, "table", "uint", "rowCount", "colCount", "cellCount"); }
export function checkTableProperties(o: JsonObject): void {
  if (typeof o.textWrap !== "string" || !TEXT_WRAPS.has(o.textWrap)) throw new HwpEvidenceError("table.textWrap");
  fields(o, "table", "boolean", "treatAsChar", "repeatHeader");
  fields(o, "table", "uint", "tableWidth", "tableHeight");
  fields(o, "table", "int", "cellSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom");
  fields(o, "table", "border", ...BORDERS);
}
export function checkCellInfo(o: JsonObject): void { fields(o, "cell", "uint", "row", "col", "rowSpan", "colSpan"); }
export function checkCellProperties(o: JsonObject): void {
  fields(o, "cell", "uint", "width", "height", "verticalAlign");
  fields(o, "cell", "int", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom");
  field(o, "isHeader", "boolean", "cell");
  fields(o, "cell", "border", ...BORDERS);
}
export function checkPictureProperties(o: JsonObject): void {
  fields(o, "picture", "uint", "width", "height");
  field(o, "treatAsChar", "boolean", "picture");
  if (typeof o.textWrap !== "string") throw new HwpEvidenceError("picture.textWrap");
}
/** getControls `props` for tables/pictures (all numeric, 0/1 flags). */
export function checkControlProps(o: JsonObject): void {
  if (!isInt(o.TreatAsChar, 0, 1)) throw new HwpEvidenceError("control.TreatAsChar");
  if (!isInt(o.TextWrap, 0, 3)) throw new HwpEvidenceError("control.TextWrap");
  fields(o, "control", "uint", "Width", "Height");
}

export interface TableCellCoordinates { row: number; col: number; rowSpan: number; colSpan: number }
/**
 * Structural consistency of a table: positive bounded dimensions, every cell in range
 * with positive spans, no overlap and exact coverage of the rows×cols grid.
 * Returns false for a state the reopen evidence cannot vouch for (not an exception, so
 * unchanged legacy tables keep the raw comparison); malformed types throw earlier.
 */
export function tableLayoutConsistent(rows: number, cols: number, cells: readonly TableCellCoordinates[]): boolean {
  if (rows < 1 || cols < 1 || rows > MAX_TABLE_ROWS || cols > MAX_TABLE_COLS) return false;
  if (cells.length < 1 || cells.length > rows * cols || rows * cols > MAX_TABLE_COVERAGE) return false;
  const covered = new Set<number>();
  for (const { row, col, rowSpan, colSpan } of cells) {
    if (rowSpan < 1 || colSpan < 1 || row + rowSpan > rows || col + colSpan > cols) return false;
    for (let r = row; r < row + rowSpan; r++) for (let c = col; c < col + colSpan; c++) {
      const key = r * cols + c;
      if (covered.has(key)) return false;
      covered.add(key);
    }
  }
  return covered.size === rows * cols;
}

// ---- Newly inserted HWP objects (the T009 restricted subset) ----

/**
 * Live-model normalization after `createTable` on HWP. The engine leaves the live CommonObjAttr
 * (wrap bits, horizontal reference and outer margins) different from the CTRL_HEADER bytes it
 * serializes (attr 0x082a2210 — horizontal reference Column — and 283 HWPUNIT margins, the form the
 * T009 table proof accepts). Restating that serialized default makes the live model equal to its own
 * export without changing the bytes; wrap-only normalization leaves a detectable reopen difference.
 */
export const HWP_TABLE_NORMALIZATION = Object.freeze({
  textWrap: "TopAndBottom", horzRelTo: "Column", outerLeft: 283, outerRight: 283, outerTop: 283, outerBottom: 283,
});
export const HWP_TABLE_LIMITS = Object.freeze({ rows: 32, cols: 16, cells: 256 });

function controlProps(doc: RhwpDocument, section: number, paragraph: number, control: number, kind: string): JsonObject | null {
  let global = paragraph;
  for (let s = 0; s < section; s++) global += doc.getParagraphCount(s);
  const raw: unknown = JSON.parse(doc.getControls!());
  if (!Array.isArray(raw)) return null;
  const match = raw.find(c => isObject(c) && c.ctrlId === kind && c.list === 0 && c.para === global && c.controlIndex === control);
  if (!isObject(match) || !isObject(match.props)) return null;
  checkControlProps(match.props);
  return match.props;
}
const readObject = (raw: unknown): JsonObject => {
  if (typeof raw !== "string") throw new HwpEvidenceError("getter result");
  const value: unknown = JSON.parse(raw);
  if (!isObject(value)) throw new HwpEvidenceError("object");
  return value;
};

/** A freshly inserted HWP table is the supported basic subset in its normalized form. Never throws. */
export function insertedBasicTable(doc: RhwpDocument, section: number, paragraph: number, control: number, rows: number, cols: number): boolean {
  try {
    if (!doc.getTableProperties || !doc.getCellInfo || !doc.getControls) return false;
    if (rows < 1 || cols < 1 || rows > HWP_TABLE_LIMITS.rows || cols > HWP_TABLE_LIMITS.cols || rows * cols > HWP_TABLE_LIMITS.cells) return false;
    const dimensions = readObject(doc.getTableDimensions(section, paragraph, control));
    checkTableDimensions(dimensions);
    if (dimensions.rowCount !== rows || dimensions.colCount !== cols || dimensions.cellCount !== rows * cols) return false;
    const cells: TableCellCoordinates[] = [];
    for (let cell = 0; cell < rows * cols; cell++) {
      const info = readObject(doc.getCellInfo(section, paragraph, control, cell));
      checkCellInfo(info);
      if (info.rowSpan !== 1 || info.colSpan !== 1) return false; // no merged cells in the insertion path
      if (doc.getCellParagraphCount(section, paragraph, control, cell) !== 1) return false;
      cells.push(info as unknown as TableCellCoordinates);
    }
    if (!tableLayoutConsistent(rows, cols, cells)) return false;
    const properties = readObject(doc.getTableProperties(section, paragraph, control));
    checkTableProperties(properties);
    for (const [key, value] of Object.entries(HWP_TABLE_NORMALIZATION)) if (properties[key] !== value) return false;
    if (properties.treatAsChar !== false) return false;
    const props = controlProps(doc, section, paragraph, control, "tbl");
    return !!props && CONTROL_WRAP[props.TextWrap as number] === "TopAndBottom" && props.TreatAsChar === 0;
  } catch { return false; }
}

/**
 * Stage 2: a freshly created nested table (createTableInCellByPath) is the basic inline form the
 * T009 nested-table proof accepts: exact uniform grid, one paragraph per cell, treat-as-char and
 * a control/common wrap agreement. `tablePath` names the table (any cell). Never throws.
 */
export function insertedNestedTable(doc: RhwpDocument, section: number, host: number, tablePath: readonly { controlIndex: number; cellIndex: number; cellParaIndex: number }[], rows: number, cols: number): boolean {
  try {
    if (!doc.getTablePropertiesByPath || !doc.getCellInfoByPath || !doc.getTableDimensionsByPath || !doc.getCellParagraphCountByPath) return false;
    if (rows < 1 || cols < 1 || rows > HWP_TABLE_LIMITS.rows || cols > HWP_TABLE_LIMITS.cols || rows * cols > HWP_TABLE_LIMITS.cells) return false;
    const path = (cell: number) => JSON.stringify(tablePath.map((l, i) => i === tablePath.length - 1 ? { ...l, cellIndex: cell, cellParaIndex: 0 } : l));
    const dimensions = readObject(doc.getTableDimensionsByPath(section, host, path(0)));
    checkTableDimensions(dimensions);
    if (dimensions.rowCount !== rows || dimensions.colCount !== cols || dimensions.cellCount !== rows * cols) return false;
    const cells: TableCellCoordinates[] = [];
    for (let cell = 0; cell < rows * cols; cell++) {
      const info = readObject(doc.getCellInfoByPath(section, host, path(cell)));
      checkCellInfo(info);
      if (info.rowSpan !== 1 || info.colSpan !== 1 || doc.getCellParagraphCountByPath(section, host, path(cell)) !== 1) return false;
      cells.push(info as unknown as TableCellCoordinates);
    }
    if (!tableLayoutConsistent(rows, cols, cells)) return false;
    const properties = readObject(doc.getTablePropertiesByPath(section, host, path(0)));
    checkTableProperties(properties);
    return properties.treatAsChar === true;
  } catch { return false; }
}

/** A freshly inserted HWP picture is inline (treatAsChar) with positive size agreeing with its control. Never throws. */
export function insertedInlinePicture(doc: RhwpDocument, section: number, paragraph: number, control: number): boolean {
  try {
    if (!doc.getPictureProperties || !doc.getControls) return false;
    const picture = readObject(doc.getPictureProperties(section, paragraph, control));
    checkPictureProperties(picture);
    if (picture.treatAsChar !== true || (picture.width as number) < 1 || (picture.height as number) < 1) return false;
    const props = controlProps(doc, section, paragraph, control, "gso");
    return !!props && props.TreatAsChar === 1 && props.Width === picture.width && props.Height === picture.height;
  } catch { return false; }
}

/** A blank getControls kind is not evidence of a field. Independently join the
 * cursor-list owner, sole paragraph control and complete field record. Only
 * first-paragraph formulas and ClickHere fields (any paragraph) are
 * covered; nested/ambiguous/unknown controls still make the model incomplete. */
function cellFieldEvidence(doc: RhwpDocument, controls: unknown[], json: (raw: unknown) => unknown): Map<unknown, JsonObject> {
  const proven = new Map<unknown, JsonObject>();
  if (!doc.getFieldList || !doc.getCursorModel || !doc.getSectionCount || !doc.validateTableFormulaField) return proven;
  const model = json(doc.getCursorModel()), fields = json(doc.getFieldList());
  if (!isObject(model) || !Array.isArray(model.lists) || model.lists.length > 4096 || !Array.isArray(fields) || fields.length > 4096) return proven;
  const lists = new Map<number, JsonObject>(), ids = new Set<number>();
  const owners = new Map<string, number>(), tables = new Set<string>(), byParagraph = new Map<string, JsonObject | null>();
  for (const c of controls) if (isObject(c)) {
    const key = `${c.list}/${c.para}`;
    owners.set(key, (owners.get(key) ?? 0) + 1);
    if (c.ctrlId === "tbl" && c.list === 0) tables.add(`${c.para}/${c.controlIndex}`);
  }
  const sectionCount = doc.getSectionCount();
  if (!isInt(sectionCount, 1, 4096)) return proven;
  const bases = [0];
  for (let s = 0; s < sectionCount; s++) bases.push(bases[s]! + doc.getParagraphCount(s));
  for (const list of model.lists) {
    if (!isObject(list) || !isInt(list.listId, 2) || lists.has(list.listId)) return proven;
    lists.set(list.listId, list);
  }
  for (const f of fields) {
    if (!isObject(f) || !isInt(f.fieldId, 1, 0xffffffff) || ids.has(f.fieldId)) return proven;
    ids.add(f.fieldId);
    const key = `${f.listId}/${f.paraInList}`;
    byParagraph.set(key, byParagraph.has(key) ? null : f);
  }
  for (const c of controls) {
    if (!isObject(c) || c.ctrlId !== "" || c.ctrlCh !== 0 || c.userDesc !== "" || c.controlIndex !== 0 || c.pos !== 0
      || !isObject(c.props) || Object.keys(c.props).length || !isInt(c.list, 2) || !isInt(c.para, 0)) continue;
    const list = lists.get(c.list);
    if (!list || list.isCell !== true
      || ![list.sectionIndex, list.hostPara, list.controlIndex, list.cellIndex, list.paraCount].every(v => isInt(v, 0))
      || c.para >= (list.paraCount as number)) continue;
    // Stage 2: the cell may belong to a nested table. Its ownership chain must be cell lists up
    // to a body-level table; every level must match the field's location path exactly.
    const chain: JsonObject[] = [list];
    while (chain[0]!.hostListId !== 0 && chain.length < 64) {
      const parent = isInt(chain[0]!.hostListId, 2) ? lists.get(chain[0]!.hostListId) : undefined;
      if (!parent || parent.isCell !== true || ![parent.sectionIndex, parent.hostPara, parent.controlIndex, parent.cellIndex].every(v => isInt(v, 0))) break;
      chain.unshift(parent);
    }
    if (chain[0]!.hostListId !== 0 || (chain.length > 1 && (!doc.getCellParagraphCountByPath || !doc.getCellParagraphLengthByPath
      || !doc.getTextInCellByPath || !doc.validateTableFormulaFieldByPath))) continue;
    if (owners.get(`${c.list}/${c.para}`) !== 1) continue;
    const f = byParagraph.get(`${c.list}/${c.para}`);
    if (!f) continue;
    const loc = f.location;
    const root = chain[0]!;
    if (!isObject(loc) || loc.sectionIndex !== root.sectionIndex || loc.paraIndex !== root.hostPara || !Array.isArray(loc.path) || loc.path.length !== chain.length) continue;
    const located = chain.every((level, i) => {
      const entry: unknown = (loc.path as unknown[])[i];
      const paragraph = i + 1 < chain.length ? chain[i + 1]!.hostPara : c.para;
      return isObject(entry) && entry.type === "cell" && entry.controlIndex === level.controlIndex && entry.cellIndex === level.cellIndex && entry.paraIndex === paragraph;
    });
    if (!located || f.cellField !== false || typeof f.editableInForm !== "boolean"
      || ![f.name, f.guide, f.command, f.value].every(v => typeof v === "string")
      || ![f.startCharIdx, f.endCharIdx, f.startPos, f.endPos].every(v => isInt(v, 0))) continue;
    const s = root.sectionIndex as number, p = root.hostPara as number, ctrl = list.controlIndex as number, cell = list.cellIndex as number;
    if (s >= sectionCount || !tables.has(`${bases[s]! + p}/${root.controlIndex}`)) continue;
    const pathTo = (k: number, paragraph: number) => JSON.stringify(chain.map((level, i) => i + 1 < chain.length
      ? { controlIndex: level.controlIndex, cellIndex: level.cellIndex, cellParaIndex: chain[i + 1]!.hostPara }
      : { controlIndex: level.controlIndex, cellIndex: k, cellParaIndex: paragraph }));
    const nestedCell = chain.length > 1;
    const paraCount = nestedCell ? doc.getCellParagraphCountByPath!(s, p, pathTo(cell, 0)) : doc.getCellParagraphCount(s, p, ctrl, cell);
    if (paraCount !== list.paraCount) continue;
    const length = nestedCell ? doc.getCellParagraphLengthByPath!(s, p, pathTo(cell, c.para)) : doc.getCellParagraphLength(s, p, ctrl, cell, c.para);
    if ((f.startCharIdx as number) > (f.endCharIdx as number) || (f.endCharIdx as number) > length
      || Array.from(f.value as string).length !== (f.endCharIdx as number) - (f.startCharIdx as number)) continue;
    const covered = (f.endCharIdx as number) - (f.startCharIdx as number);
    if ((nestedCell ? doc.getTextInCellByPath!(s, p, pathTo(cell, c.para), f.startCharIdx as number, covered)
      : doc.getTextInCell(s, p, ctrl, cell, c.para, f.startCharIdx as number, covered)) !== f.value) continue;
    if (f.fieldType === "formula") {
      const cache = cachedFormula(f.command);
      if (c.para !== 0 || f.startCharIdx !== 0 || f.endCharIdx !== length || !cache || cache.value !== f.value
        || !Number.isFinite(Number(cache.value)) || !isInt(list.row, 0) || !isInt(list.col, 0)) continue;
      // The engine independently proves sole full-paragraph field-range/control
      // linkage. Validation is read-only; it must identify this exact field.
      const probe = json(nestedCell ? doc.validateTableFormulaFieldByPath!(s, p, pathTo(0, 0), list.row, list.col, "=0")
        : doc.validateTableFormulaField(s, p, ctrl, list.row, list.col, "=0"));
      if (!isObject(probe) || Object.keys(probe).sort().join(",") !== "changed,command,fieldId,ok,text" || typeof probe.changed !== "boolean"
        || probe.ok !== true || probe.fieldId !== f.fieldId || probe.text !== "0" || probe.command !== "=0??%g,;;0") continue;
    } else if (f.fieldType !== "clickhere" || !(f.command as string).startsWith("Clickhere:")) continue;
    proven.set(c, f);
  }
  return proven;
}

/** Supplement the raw controls/text comparison with the supported HWP model.
 * No mutation, image hash supplied by the caller, or inferred WASM API is used.
 * Optional APIs may be absent for legacy edits; a changed structural inventory
 * requires complete evidence. The Rust preservation proof remains authoritative.
 *
 * Error strategy: a present getter whose result is not JSON, has the wrong JSON
 * shape, or lacks a required field / has a wrongly typed required field throws
 * (HwpEvidenceError or SyntaxError) — the export flow then records a failed reopen and
 * never publishes. A well-typed but unverifiable state (absent optional API, nested or
 * unknown control, unresolved bullet reference, inconsistent table layout, picture
 * dimensions out of range, control/property disagreement) clears `complete`, which
 * fails the comparison whenever the structural inventory changed.
 */
export function hwpReopenModel(doc: RhwpDocument): HwpReopenModel {
  let budget = 32 * 1024 * 1024;
  let nodes = 100_000;
  let complete = !!doc.getSectionCount && !!doc.getParaPropertiesAt;
  const spend = (n: number) => { budget -= n; if (budget < 0) throw new Error("HWP comparison budget"); };
  const count = (n: unknown, max = 100_000): number => {
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > max) throw new Error("HWP model count");
    return n;
  };
  const node = () => { if (--nodes < 0) throw new Error("HWP comparison nodes"); };
  const json = (raw: unknown): unknown => {
    if (typeof raw !== "string") throw new HwpEvidenceError("getter result");
    spend(raw.length * 2); return JSON.parse(raw);
  };
  const object = (v: unknown): JsonObject => {
    if (!isObject(v)) throw new Error("HWP model object");
    return v;
  };
  const optional = (read: (() => string) | undefined, check: (o: JsonObject) => void) => {
    if (!read) { complete = false; return null; }
    const value = object(json(read()));
    check(value);
    return value;
  };
  const controls = json(doc.getControls!());
  if (!Array.isArray(controls) || controls.length > 100_000) throw new Error("HWP controls");
  const cellFields = controls.some(c => isObject(c) && c.list !== 0 && c.ctrlId === "") ? cellFieldEvidence(doc, controls, json) : new Map<unknown, JsonObject>();
  const bullets = doc.getBulletList ? json(doc.getBulletList()) : null;
  if (bullets !== null && !Array.isArray(bullets)) throw new Error("HWP bullets");
  if (Array.isArray(bullets) && bullets.length > 65535) throw new Error("HWP bullets");
  const bulletById = new Map<number, JsonObject>();
  if (Array.isArray(bullets)) for (const value of bullets) {
    const b = object(value);
    checkBulletDefinition(b);
    const id = b.id as number;
    if (bulletById.has(id)) throw new Error("HWP bullet definition");
    const definition = { ...b }; delete definition.id;
    bulletById.set(id, definition);
  }
  const headings: unknown[] = [];
  const sections: unknown[] = [];
  const sectionCount = doc.getSectionCount ? count(doc.getSectionCount(), 4096) : 1;
  for (let s = 0; s < sectionCount; s++) {
    const paragraphs: unknown[] = [];
    for (let p = 0, n = count(doc.getParagraphCount(s)); p < n; p++) {
      node();
      const properties = optional(doc.getParaPropertiesAt && (() => doc.getParaPropertiesAt!(s, p)), checkParaProperties);
      if (properties) {
        // Serialization may intern equivalent ParaShapes under another index.
        delete properties.paraShapeId;
        if (properties.headType === "Bullet") {
          // Definitions may be interned/renumbered: compare the resolved definition.
          const definition = (properties.numberingId as number) >= 1 ? bulletById.get(properties.numberingId as number) : undefined;
          if (!definition) complete = false;
          else { delete properties.numberingId; properties.bullet = definition; }
        }
        if (properties.headType !== "None") headings.push(properties);
      }
      const length = count(doc.getParagraphLength(s, p), 2_000_000);
      const text = doc.getTextRange(s, p, 0, length);
      if (typeof text !== "string") throw new HwpEvidenceError("paragraph text");
      spend(text.length * 2);
      paragraphs.push({ text, properties });
    }
    sections.push(paragraphs);
  }
  const tables: unknown[] = [];
  const pictures: unknown[] = [];
  const inventory: unknown[] = [];
  const fields: unknown[] = [];
  let paragraphBase = 0;
  const sectionEnds = Array.from({ length: sectionCount }, (_, s) => {
    paragraphBase += count(doc.getParagraphCount(s)); return paragraphBase;
  });
  // Stage 2: tables inside cells, addressed by their explicit cell-list ownership chain.
  const cursorLists = controls.some(c => isObject(c) && c.list !== 0 && c.ctrlId === "tbl") && doc.getCursorModel
    ? cursorListMap(object(json(doc.getCursorModel()))) : null;
  for (const value of controls) {
    node(); const c = object(value);
    if (c.ctrlId === "secd" || c.ctrlId === "cold") continue;
    inventory.push({ kind: c.ctrlId, type: c.userDesc, list: c.list, props: c.props });
    const field = cellFields.get(c);
    if (field) { fields.push(field); continue; }
    if (c.list !== 0 && c.ctrlId === "tbl" && cursorLists) {
      const table = nestedTableModel(doc, c, cursorLists, spend, node, count);
      if (table) { tables.push(table); continue; }
    }
    if (c.list !== 0) { complete = false; continue; } // other nested controls retain raw comparison
    const global = count(c.para);
    // getControls uses global root paragraph numbers; table APIs use section-local ones.
    let low = 0, high = sectionEnds.length;
    while (low < high) { const mid = (low + high) >>> 1; if (global < sectionEnds[mid]!) high = mid; else low = mid + 1; }
    const section = low;
    if (section === sectionEnds.length) throw new Error("HWP control location");
    const p = global - (section === 0 ? 0 : sectionEnds[section - 1]!);
    const control = count(c.controlIndex);
    if (c.ctrlId === "tbl") {
      const props = object(c.props); checkControlProps(props);
      const dimensions = object(json(doc.getTableDimensions(section, p, control)));
      checkTableDimensions(dimensions);
      const rows = count(dimensions.rowCount, MAX_TABLE_ROWS), cols = count(dimensions.colCount, MAX_TABLE_COLS);
      const cellCount = count(dimensions.cellCount);
      const cells: unknown[] = [];
      const layout: TableCellCoordinates[] = [];
      for (let cell = 0; cell < cellCount; cell++) {
        node(); const paragraphs: string[] = [];
        const paragraphCount = count(doc.getCellParagraphCount(section, p, control, cell));
        if (paragraphCount < 1) complete = false; // every HWP cell holds at least one paragraph
        for (let cp = 0; cp < paragraphCount; cp++) {
          node(); const length = count(doc.getCellParagraphLength(section, p, control, cell, cp), 2_000_000);
          const text = doc.getTextInCell(section, p, control, cell, cp, 0, length);
          if (typeof text !== "string") throw new HwpEvidenceError("cell text");
          spend(text.length * 2); paragraphs.push(text);
        }
        const coordinates = optional(doc.getCellInfo && (() => doc.getCellInfo!(section, p, control, cell)), checkCellInfo);
        if (coordinates) layout.push(coordinates as unknown as TableCellCoordinates);
        const properties = optional(doc.getCellProperties && (() => doc.getCellProperties!(section, p, control, cell)), checkCellProperties);
        // Resolved border/fill attributes, rather than a serialization-local ID.
        if (properties) delete properties.borderFillId;
        cells.push({ coordinates, properties, paragraphs });
      }
      if (layout.length === cellCount && !tableLayoutConsistent(rows, cols, layout)) complete = false;
      const properties = optional(doc.getTableProperties && (() => doc.getTableProperties!(section, p, control)), checkTableProperties);
      if (properties) {
        delete properties.borderFillId;
        // The control attr bits and the common wrap mode must agree (raw TBL-001 does not).
        if (CONTROL_WRAP[props.TextWrap as number] !== properties.textWrap
          || (props.TreatAsChar === 1) !== properties.treatAsChar) complete = false;
      }
      tables.push({ dimensions, properties, cells });
    } else if (c.ctrlId === "gso" && c.userDesc === "그림") {
      const props = object(c.props); checkControlProps(props);
      const picture = optional(doc.getPictureProperties && (() => doc.getPictureProperties!(section, p, control)), checkPictureProperties);
      if (picture) {
        const { width, height } = picture as { width: number; height: number };
        if (width < 1 || height < 1 || width > HWPUNIT_MAX || height > HWPUNIT_MAX
          || props.Width !== width || props.Height !== height
          || (props.TreatAsChar === 1) !== picture.treatAsChar) complete = false;
      }
      pictures.push(picture);
    } else complete = false;
  }
  // T012 Phase 2 — nested table cells. The body-level table model above reads one level only, so text typed
  // into a table inside a cell would otherwise be covered by the flat text comparison alone. Every cell list whose
  // host chain is cells all the way up to a body-level table is read through its explicit path (never by list
  // number, which serialization may renumber): geometry and each paragraph's text. Lists hosted by anything else
  // (text boxes, captions, notes) stay outside this model as before. Nested controls still clear `complete` above.
  const nested: unknown[] = [];
  if (doc.getCursorModel && doc.getCellParagraphCountByPath && doc.getCellParagraphLengthByPath && doc.getTextInCellByPath && doc.getCellInfoByPath) {
    const cursor = object(json(doc.getCursorModel()));
    if (!Array.isArray(cursor.lists) || cursor.lists.length > 100_000) throw new Error("HWP cursor lists");
    const byId = new Map<number, JsonObject>();
    for (const value of cursor.lists) {
      const list = object(value);
      if (!isInt(list.listId, 0) || byId.has(list.listId)) throw new Error("HWP cursor list");
      byId.set(list.listId, list);
    }
    for (const list of byId.values()) {
      if (list.isCell !== true || list.hostListId === 0) continue;
      const chain: JsonObject[] = [];
      let at: JsonObject | undefined = list;
      while (at && at.isCell === true && chain.length <= 8) {
        chain.unshift(at);
        if (at.hostListId === 0) break;
        at = isInt(at.hostListId, 2) ? byId.get(at.hostListId) : undefined;
      }
      if (!at || at.isCell !== true || at.hostListId !== 0 || chain.length < 2 || chain.length > 8) continue;
      if (!chain.every(l => [l.sectionIndex, l.hostPara, l.controlIndex, l.cellIndex, l.paraCount].every(v => isInt(v, 0)))) throw new Error("HWP cursor list");
      node();
      const section = chain[0]!.sectionIndex as number, host = chain[0]!.hostPara as number;
      // Level i's paragraph is the paragraph hosting level i+1's table; the last level's is set per paragraph.
      const levels = chain.map((l, i) => ({ controlIndex: l.controlIndex as number, cellIndex: l.cellIndex as number,
        cellParaIndex: i + 1 < chain.length ? chain[i + 1]!.hostPara as number : 0 }));
      const path = (paragraph: number) => JSON.stringify(levels.map((l, i) => (i + 1 < levels.length ? l : { ...l, cellParaIndex: paragraph })));
      const paragraphCount = count(doc.getCellParagraphCountByPath(section, host, path(0)));
      if (paragraphCount !== list.paraCount) throw new Error("HWP nested cell paragraphs");
      const paragraphs: string[] = [];
      for (let p = 0; p < paragraphCount; p++) {
        node();
        const length = count(doc.getCellParagraphLengthByPath(section, host, path(p)), 2_000_000);
        const text = doc.getTextInCellByPath(section, host, path(p), 0, length);
        if (typeof text !== "string") throw new HwpEvidenceError("nested cell text");
        spend(text.length * 2); paragraphs.push(text);
      }
      const coordinates = object(json(doc.getCellInfoByPath(section, host, path(0))));
      checkCellInfo(coordinates);
      nested.push({ section, host, levels, coordinates, paragraphs });
    }
  }
  return { model: canonical({ sections, tables, pictures, fields, nested }), structure: canonical({ inventory, headings }), complete };
}

function cursorListMap(cursor: JsonObject): Map<number, JsonObject> {
  if (!Array.isArray(cursor.lists) || cursor.lists.length > 100_000) throw new Error("HWP cursor lists");
  const byId = new Map<number, JsonObject>();
  for (const value of cursor.lists) {
    if (!isObject(value) || !isInt(value.listId, 0) || byId.has(value.listId)) throw new Error("HWP cursor list");
    byId.set(value.listId, value);
  }
  return byId;
}

/**
 * Complete model of one nested table control (Stage 2), or null when its ownership or any
 * required getter cannot be proven (the caller then clears `complete`). The host chain must
 * be cell lists all the way to a body-level table; the table is then read only through its
 * explicit path, with the same required-field checks as a body table.
 */
function nestedTableModel(doc: RhwpDocument, c: JsonObject, lists: Map<number, JsonObject>,
  spend: (n: number) => void, node: () => void, count: (n: unknown, max?: number) => number): JsonObject | null {
  if (!doc.getTableDimensionsByPath || !doc.getCellInfoByPath || !doc.getCellPropertiesByPath || !doc.getTablePropertiesByPath
    || !doc.getCellParagraphCountByPath || !doc.getCellParagraphLengthByPath || !doc.getTextInCellByPath) return null;
  if (!isInt(c.list, 2) || !isInt(c.para, 0) || !isInt(c.controlIndex, 0) || !isObject(c.props)) return null;
  const chain: JsonObject[] = [];
  let at = lists.get(c.list);
  while (at && at.isCell === true && chain.length < 64) {
    chain.unshift(at);
    if (at.hostListId === 0) break;
    at = isInt(at.hostListId, 2) ? lists.get(at.hostListId) : undefined;
  }
  if (!at || at.hostListId !== 0 || !chain.length
    || !chain.every(l => [l.sectionIndex, l.hostPara, l.controlIndex, l.cellIndex, l.paraCount].every(v => isInt(v, 0)))) return null;
  if ((c.para as number) >= (chain[chain.length - 1]!.paraCount as number)) return null;
  checkControlProps(c.props);
  const section = chain[0]!.sectionIndex as number, host = chain[0]!.hostPara as number;
  const levels = chain.map((l, i) => ({ controlIndex: l.controlIndex as number, cellIndex: l.cellIndex as number,
    cellParaIndex: i + 1 < chain.length ? chain[i + 1]!.hostPara as number : c.para as number }));
  const tablePath = (cell: number, paragraph = 0) => JSON.stringify([...levels, { controlIndex: c.controlIndex, cellIndex: cell, cellParaIndex: paragraph }]);
  const dimensions = readObject(doc.getTableDimensionsByPath(section, host, tablePath(0)));
  checkTableDimensions(dimensions);
  const rows = count(dimensions.rowCount, MAX_TABLE_ROWS), cols = count(dimensions.colCount, MAX_TABLE_COLS);
  const cellCount = count(dimensions.cellCount);
  const cells: unknown[] = [], layout: TableCellCoordinates[] = [];
  for (let cell = 0; cell < cellCount; cell++) {
    node();
    const coordinates = readObject(doc.getCellInfoByPath(section, host, tablePath(cell)));
    checkCellInfo(coordinates); layout.push(coordinates as unknown as TableCellCoordinates);
    const properties = readObject(doc.getCellPropertiesByPath(section, host, tablePath(0), cell));
    checkCellProperties(properties); delete properties.borderFillId;
    const paragraphs: string[] = [];
    const paragraphCount = count(doc.getCellParagraphCountByPath(section, host, tablePath(cell)));
    if (paragraphCount < 1) return null;
    for (let p = 0; p < paragraphCount; p++) {
      node();
      const length = count(doc.getCellParagraphLengthByPath(section, host, tablePath(cell, p)), 2_000_000);
      const text = doc.getTextInCellByPath(section, host, tablePath(cell, p), 0, length);
      if (typeof text !== "string") throw new HwpEvidenceError("nested cell text");
      spend(text.length * 2); paragraphs.push(text);
    }
    cells.push({ coordinates, properties, paragraphs });
  }
  if (!tableLayoutConsistent(rows, cols, layout)) return null;
  const properties = readObject(doc.getTablePropertiesByPath(section, host, tablePath(0)));
  checkTableProperties(properties); delete properties.borderFillId;
  if (CONTROL_WRAP[c.props.TextWrap as number] !== properties.textWrap
    || (c.props.TreatAsChar === 1) !== properties.treatAsChar) return null;
  return { section, host, levels, control: c.controlIndex, dimensions, properties, cells };
}

export function hwpReopenEqual(live: HwpReopenModel, reopened: HwpReopenModel, baseline: string | null): boolean {
  const changed = baseline === null || live.structure !== baseline;
  return live.model === reopened.model && live.structure === reopened.structure
    && (!changed || (live.complete && reopened.complete));
}
