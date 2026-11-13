// 표 구조 편집(T012 Phase 2, Stage 2): 행·열 넣기/지우기, 옆·아래 셀과 합치기, 범위 병합, 합친 셀 나누기.
//
// 본문 표와 명시적 경로의 중첩 표를 다룬다. 각 연산은
//   1) 엔진에서 읽은 격자(셀 좌표·병합)와 셀마다 문단 digest(글, 그 문단이 소유한 컨트롤 — 필드·그림·개체·
//      자식 표의 하위 구조까지 재귀로)를 읽어 대상과 결과를 미리 계산하고,
//   2) 맞지 않는 모양(걸친 병합, 모델링하지 않는 내용, 지워질 셀을 참조하는 계산식, 크기 한도)은 엔진을 부르기 전에 거절하며,
//   3) 엔진 호출 뒤 표를 다시 읽어 계산한 결과와 셀 하나하나(좌표·병합·문단 digest)가 같은지 확인한다.
//      요청한 연산이 지운 셀(행·열 지우기)의 내용만 사라질 수 있고, 다른 내용은 옮겨진 셀에서 그대로 다시 보여야 한다.
//   4) 계산식 필드는 같은 필드 ID로 옮겨진 셀에 남아야 하며, 절대 참조를 새 좌표로 다시 쓰고 의존 순서로 다시 계산한다.
// 엔진이 성공을 돌려준 것만으로 지원한다고 보지 않는다: 3)·4)가 어긋나면 던지고, 세션이 그 변경을 되돌린다.
import { cachedFormula } from "./formulaDependencies";
import { formulaDependencies, remapFormulaReferences } from "../../../commands/parameters";
import { tableLayoutConsistent, type TableCellCoordinates } from "./hwpReopenModel";
import type { RhwpDocument } from "./rhwpModule";
import { pathJson, type CellRef } from "./rhwpText";

export type TableStructureOp =
  | "insertRowAbove" | "insertRowBelow" | "insertColumnLeft" | "insertColumnRight"
  | "deleteRow" | "deleteColumn" | "mergeRight" | "mergeBelow" | "mergeCells" | "splitCell";
export const TABLE_STRUCTURE_OPS: readonly TableStructureOp[] = [
  "insertRowAbove", "insertRowBelow", "insertColumnLeft", "insertColumnRight",
  "deleteRow", "deleteColumn", "mergeRight", "mergeBelow", "mergeCells", "splitCell",
];

/** Why an operation is refused before any engine call. */
export type TableStructureRefusal = "tableFormula" | "tableContent" | "tableShape" | "limit" | "engineUnsupported";

/** Bounds of a table this module restructures (before and after the operation). */
export const TABLE_STRUCTURE_LIMITS = Object.freeze({ rows: 512, cols: 64, cells: 4096 });

export interface TableTarget { section: number; paragraph: number; control: number; path?: CellRef }

function cellPath(at: TableTarget, index: number): string {
  const c = at.path!;
  const levels = JSON.parse(pathJson(c)) as { cellIndex: number; cellParaIndex: number }[];
  levels[levels.length - 1]!.cellIndex = index;
  levels[levels.length - 1]!.cellParaIndex = 0;
  return JSON.stringify(levels);
}

export interface CellRange { startRow: number; startCol: number; endRow: number; endCol: number }

/** A rectangle includes whole existing spans. Partial overlap is never silently expanded. */
export function rectangularRange(grid: TableGrid, first: number, last: number): CellRange | null {
  const a = grid.cells[first], b = grid.cells[last];
  if (!a || !b || first === last) return null;
  const startRow = Math.min(a.row, b.row), startCol = Math.min(a.col, b.col);
  const endRow = Math.max(a.row + a.rowSpan, b.row + b.rowSpan) - 1;
  const endCol = Math.max(a.col + a.colSpan, b.col + b.colSpan) - 1;
  for (const c of grid.cells) {
    const r = c.row + c.rowSpan - 1, col = c.col + c.colSpan - 1;
    if (c.row <= endRow && r >= startRow && c.col <= endCol && col >= startCol
      && (c.row < startRow || r > endRow || c.col < startCol || col > endCol)) return null;
  }
  return { startRow, startCol, endRow, endCol };
}
export interface TableGrid {
  rows: number;
  cols: number;
  /** Cells in engine order (row-major). */
  cells: readonly TableCellCoordinates[];
}
/** One formula field of the table: its field id, physical cell and coordinate, expression. */
export interface TableFormula { fieldId: number; cell: number; row: number; col: number; expression: string }
/** Proven content of a table (Stage 2): rich cells are compared by paragraph digest. */
export interface TableContent { formulas: readonly TableFormula[]; rich: boolean; caption: string | null }
export interface TableContentOptions {
  /** Fields (formula/ClickHere) and captions may be kept/relocated: HWPX. HWP keeps refusing them. */
  fields: boolean;
}
export interface TablePlan {
  op: TableStructureOp;
  /** Engine call arguments after (section, paragraph, control). */
  call: readonly (number | boolean)[];
  /** Expected table after the operation. */
  rows: number;
  cols: number;
  /** Expected cells keyed "row,col": spans and exact paragraph texts. */
  cells: ReadonlyMap<string, { rowSpan: number; colSpan: number; paragraphs: readonly string[] }>;
  /** Where the caret goes: a logical coordinate of the result table. */
  caret: { row: number; col: number };
  /** Formula fields after the operation (rewritten references at their new coordinates), in recalculation order. */
  formulas: readonly { fieldId: number; row: number; col: number; formula: string }[];
  /** Content rules the result must satisfy again. */
  options: TableContentOptions;
  /** The table caption, unchanged by every structure operation. */
  caption: string | null;
}

type Fields = Record<string, unknown>;
const isRecord = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);
const isIndex = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const MAX_JSON = 8 * 1024 * 1024;
// Proof reads are bounded before crossing WASM/JS or allocating scalar arrays.
// Snapshots and rendering retain their independent resource admission checks.
const MAX_TABLE_TEXT = 4 * 1024 * 1024;
const MAX_TABLE_PARAGRAPHS = 100_000;
class TableTextBudgetExceeded extends Error {}
const textBudget = () => ({ chars: MAX_TABLE_TEXT, paragraphs: MAX_TABLE_PARAGRAPHS });

const API: Record<TableStructureOp, keyof RhwpDocument> = {
  insertRowAbove: "insertTableRow", insertRowBelow: "insertTableRow",
  insertColumnLeft: "insertTableColumn", insertColumnRight: "insertTableColumn",
  deleteRow: "deleteTableRow", deleteColumn: "deleteTableColumn",
  mergeRight: "mergeTableCells", mergeBelow: "mergeTableCells", mergeCells: "mergeTableCells", splitCell: "splitTableCell",
};

export function hasTableStructureApi(doc: RhwpDocument, op: TableStructureOp): boolean {
  return typeof doc[API[op]] === "function" && !!doc.getCellInfo && !!doc.getControls && !!doc.getCursorModel && !!doc.getFieldList;
}

/** Geometry of the explicitly owned table, or a refusal. Never throws. */
export function readTableGrid(doc: RhwpDocument, at: TableTarget): TableGrid | TableStructureRefusal {
  try {
    if (!doc.getCellInfo) return "engineUnsupported";
    const size: unknown = JSON.parse(at.path ? doc.getTableDimensionsByPath!(at.section, at.paragraph, pathJson(at.path))
      : doc.getTableDimensions(at.section, at.paragraph, at.control));
    if (!isRecord(size) || !isIndex(size.rowCount) || !isIndex(size.colCount) || !isIndex(size.cellCount)) return "engineUnsupported";
    const { rowCount: rows, colCount: cols, cellCount } = size;
    if (rows < 1 || cols < 1 || cellCount < 1) return "tableShape";
    if (rows > TABLE_STRUCTURE_LIMITS.rows || cols > TABLE_STRUCTURE_LIMITS.cols || cellCount > TABLE_STRUCTURE_LIMITS.cells) return "limit";
    const cells: TableCellCoordinates[] = [];
    for (let cell = 0; cell < cellCount; cell++) {
      const info: unknown = JSON.parse(at.path ? doc.getCellInfoByPath!(at.section, at.paragraph, cellPath(at, cell))
        : doc.getCellInfo(at.section, at.paragraph, at.control, cell));
      if (!isRecord(info) || ![info.row, info.col, info.rowSpan, info.colSpan].every(isIndex)) return "engineUnsupported";
      cells.push({ row: info.row as number, col: info.col as number, rowSpan: info.rowSpan as number, colSpan: info.colSpan as number });
    }
    // Engine order must be row-major: the plan relies on it for merged paragraph order and cell indices.
    for (let i = 1; i < cells.length; i++) {
      const a = cells[i - 1]!, b = cells[i]!;
      if (a.row > b.row || (a.row === b.row && a.col >= b.col)) return "tableShape";
    }
    return tableLayoutConsistent(rows, cols, cells) ? { rows, cols, cells } : "tableShape";
  } catch { return "engineUnsupported"; }
}

const pathLevels = (at: TableTarget) => at.path ? JSON.parse(pathJson(at.path)) as { controlIndex: number; cellIndex: number; cellParaIndex: number }[]
  : [{ controlIndex: at.control, cellIndex: 0, cellParaIndex: 0 }];

interface Inventory {
  controls: Fields[];
  lists: Fields[];
  fields: Fields[];
}
function inventory(doc: RhwpDocument): Inventory | TableStructureRefusal {
  if (!doc.getControls || !doc.getCursorModel || !doc.getFieldList) return "engineUnsupported";
  const [controlsRaw, modelRaw, fieldsRaw] = [doc.getControls(), doc.getCursorModel(), doc.getFieldList()];
  if (controlsRaw.length > MAX_JSON || modelRaw.length > MAX_JSON || fieldsRaw.length > MAX_JSON) return "limit";
  const controls: unknown = JSON.parse(controlsRaw), model: unknown = JSON.parse(modelRaw), fields: unknown = JSON.parse(fieldsRaw);
  if (!Array.isArray(controls) || !isRecord(model) || !Array.isArray(model.lists) || !Array.isArray(fields)) return "engineUnsupported";
  if (!controls.every(isRecord) || !model.lists.every(isRecord) || !fields.every(isRecord)) return "engineUnsupported";
  return { controls, lists: model.lists, fields };
}

/** Cursor list id of every cell of the target table, resolved level by level through explicit ownership. */
function cellLists(inv: Inventory, at: TableTarget, grid: TableGrid): Map<number, number> | TableStructureRefusal {
  let host = 0, hostPara = at.paragraph;
  if (at.path?.nested) {
    for (const level of [at.path, ...at.path.nested].slice(0, -1)) {
      const matches = inv.lists.filter(l => l.isCell === true && l.sectionIndex === at.section
        && l.hostListId === host && l.hostPara === hostPara && l.controlIndex === level.control && l.cellIndex === level.cell);
      if (matches.length !== 1 || !isIndex(matches[0]!.listId)) return "tableContent";
      host = matches[0]!.listId as number; hostPara = level.cellParagraph;
    }
  }
  const lists = new Map<number, number>(), ids = new Set<number>();
  for (const list of inv.lists) {
    if (list.hostListId !== host || list.sectionIndex !== at.section || list.hostPara !== hostPara || list.controlIndex !== at.control) continue;
    // A caption (or any non-cell list of the table) has no proven relocation contract here.
    if (list.isCell !== true || !isIndex(list.listId) || list.listId < 2 || !isIndex(list.cellIndex)
      || list.cellIndex >= grid.cells.length || lists.has(list.cellIndex) || ids.has(list.listId)) return "tableContent";
    lists.set(list.cellIndex, list.listId); ids.add(list.listId);
  }
  return lists.size === grid.cells.length ? lists : "tableContent";
}

/** Whether a field location lies at or below the target table; returns its depth relation. */
function fieldOwner(field: Fields, at: TableTarget): "cell" | "below" | null {
  const location = field.location;
  if (!isRecord(location) || location.sectionIndex !== at.section || location.paraIndex !== at.paragraph || !Array.isArray(location.path)) return null;
  const levels = pathLevels(at), path = location.path as unknown[];
  if (path.length < levels.length) return null;
  const owned = levels.every((level, i) => {
    const entry = path[i];
    return isRecord(entry) && entry.controlIndex === level.controlIndex
      && (i === levels.length - 1 || (entry.cellIndex === level.cellIndex && entry.paraIndex === level.cellParaIndex));
  });
  return !owned ? null : path.length === levels.length ? "cell" : "below";
}

/**
 * Content eligibility of the whole table (Stage 2). Every cell is exactly one cursor list owned by this table.
 * Cell controls (nested tables, pictures and other objects, fields) are admitted when their whole subtree can
 * be read into the paragraph digest; formula fields additionally need the full-paragraph ownership the engine
 * validator proves, so that their references can be rewritten. Captions and text boxes (non-cell lists) stay
 * refused. Never throws; an unreadable inventory is a refusal.
 */
export function tableContent(doc: RhwpDocument, at: TableTarget, grid: TableGrid, options: TableContentOptions): TableContent | TableStructureRefusal {
  try {
    const inv = inventory(doc);
    if (typeof inv === "string") return inv;
    const lists = cellLists(inv, at, grid);
    if (typeof lists === "string") return lists;
    const byList = new Map([...lists].map(([cell, list]) => [list, cell]));
    const formulas: TableFormula[] = [];
    let rich = false;
    for (const field of inv.fields) {
      const owner = fieldOwner(field, at);
      if (!owner) continue;
      if (!options.fields) return "tableFormula";
      rich = true;
      if (owner === "below") continue; // a field of a nested table keeps its own table's coordinates
      const location = field.location as Fields, part = (location.path as Fields[])[(location.path as unknown[]).length - 1]!;
      if (part.type !== "cell" || !isIndex(part.cellIndex) || !lists.has(part.cellIndex)) return "tableContent";
      if (field.fieldType === "formula") {
        const cached = cachedFormula(field.command);
        const coordinates = grid.cells[part.cellIndex];
        if (part.paraIndex !== 0 || !cached || cached.value !== field.value || field.startCharIdx !== 0 || !coordinates
          || !isIndex(field.fieldId) || field.fieldId === 0) return "tableFormula";
        formulas.push({ fieldId: field.fieldId, cell: part.cellIndex, row: coordinates.row, col: coordinates.col, expression: cached.expression });
      } else if (field.fieldType !== "clickhere") return "tableContent";
    }
    for (const control of inv.controls) {
      if (!isIndex(control.list)) return "engineUnsupported";
      if (byList.has(control.list)) rich = true;
    }
    if (formulas.length > 1024) return "limit";
    // A caption is not a cell list; the structure operation never owns it and it must stay byte-for-byte.
    let caption: string | null = null;
    if (doc.getTableCaptionByPath) {
      const raw = doc.getTableCaptionByPath(at.section, at.paragraph, JSON.stringify(pathLevels(at)));
      if (raw.length > MAX_JSON) return "limit";
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value) || (value.paragraphs !== null && !Array.isArray(value.paragraphs))) return "engineUnsupported";
      if (value.paragraphs !== null) {
        if (!options.fields) return "tableContent";
        caption = JSON.stringify(value.paragraphs); rich = true;
      }
    } else if (options.fields) return "engineUnsupported";
    return { formulas, rich, caption };
  } catch { return "engineUnsupported"; }
}

/** Compatibility predicate for body/nested plain-or-rich tables with the default (field-relocating) options. */
export function tableContentRefusal(doc: RhwpDocument, at: TableTarget, grid: TableGrid, options: TableContentOptions = { fields: true }): TableStructureRefusal | null {
  const content = tableContent(doc, at, grid, options);
  return typeof content === "string" ? content : null;
}

interface DigestContext { doc: RhwpDocument; at: TableTarget; inv: Inventory; budget: { chars: number; paragraphs: number; nodes: number } }

/** Text of one paragraph through its explicit path (or the body-level cell API at depth one). */
function paragraphText(c: DigestContext, path: readonly { controlIndex: number; cellIndex: number; cellParaIndex: number }[]): string {
  const { doc, at, budget } = c;
  const body = path.length === 1 && !at.path;
  const last = path[path.length - 1]!, raw = JSON.stringify(path);
  const length = body ? doc.getCellParagraphLength(at.section, at.paragraph, last.controlIndex, last.cellIndex, last.cellParaIndex)
    : doc.getCellParagraphLengthByPath!(at.section, at.paragraph, raw);
  if (!isIndex(length)) throw new Error("cell paragraph length");
  if (length > budget.chars) throw new TableTextBudgetExceeded();
  budget.chars -= length;
  const text = body ? doc.getTextInCell(at.section, at.paragraph, last.controlIndex, last.cellIndex, last.cellParaIndex, 0, length)
    : doc.getTextInCellByPath!(at.section, at.paragraph, raw, 0, length);
  if (typeof text !== "string" || Array.from(text).length !== length) throw new Error("cell paragraph text");
  return text;
}
function paragraphCount(c: DigestContext, path: readonly { controlIndex: number; cellIndex: number; cellParaIndex: number }[]): number {
  const { doc, at, budget } = c;
  const last = path[path.length - 1]!;
  const count = path.length === 1 && !at.path ? doc.getCellParagraphCount(at.section, at.paragraph, last.controlIndex, last.cellIndex)
    : doc.getCellParagraphCountByPath!(at.section, at.paragraph, JSON.stringify(path));
  if (!isIndex(count) || count < 1) throw new Error("cell paragraph count");
  if (count > budget.paragraphs) throw new TableTextBudgetExceeded();
  budget.paragraphs -= count;
  return count;
}

/**
 * Digest of one cell paragraph: its text and every control it owns, each with its kind, position and properties,
 * a field's identity (formula expressions are compared through the separate rewrite proof, not here), and a child
 * table's complete grid and paragraph digests (recursively). Lists are matched by explicit ownership, never by id.
 */
function paragraphDigest(c: DigestContext, path: { controlIndex: number; cellIndex: number; cellParaIndex: number }[], list: number): string {
  if (--c.budget.nodes < 0) throw new TableTextBudgetExceeded();
  const paragraph = path[path.length - 1]!.cellParaIndex;
  const text = paragraphText(c, path);
  const owned = c.inv.controls.filter(control => control.list === list && control.para === paragraph);
  if (!owned.length) return JSON.stringify([text]);
  const parts = owned.map(control => {
    if (!isIndex(control.controlIndex)) throw new Error("control index");
    const base = { k: control.ctrlId, d: control.userDesc, i: control.controlIndex, p: control.pos, props: control.props };
    if (control.ctrlId === "tbl") {
      const tablePath = [...path, { controlIndex: control.controlIndex as number, cellIndex: 0, cellParaIndex: 0 }];
      const raw = JSON.stringify(tablePath);
      const size: unknown = JSON.parse(c.doc.getTableDimensionsByPath!(c.at.section, c.at.paragraph, raw));
      if (!isRecord(size) || !isIndex(size.cellCount) || size.cellCount > TABLE_STRUCTURE_LIMITS.cells) throw new Error("child table");
      const cells: unknown[] = [];
      for (let cell = 0; cell < size.cellCount; cell++) {
        tablePath[tablePath.length - 1] = { controlIndex: control.controlIndex as number, cellIndex: cell, cellParaIndex: 0 };
        const info: unknown = JSON.parse(c.doc.getCellInfoByPath!(c.at.section, c.at.paragraph, JSON.stringify(tablePath)));
        const child = c.inv.lists.filter(l => l.isCell === true && l.hostListId === list && l.hostPara === paragraph
          && l.controlIndex === control.controlIndex && l.cellIndex === cell);
        if (child.length !== 1 || !isIndex(child[0]!.listId)) throw new Error("child cell ownership");
        const paragraphs: string[] = [];
        for (let p = 0, n = paragraphCount(c, tablePath); p < n; p++) {
          const cellPath = tablePath.map((l, i) => i === tablePath.length - 1 ? { ...l, cellParaIndex: p } : l);
          paragraphs.push(paragraphDigest(c, cellPath, child[0]!.listId as number));
        }
        cells.push([info, paragraphs]);
      }
      return { ...base, size, cells };
    }
    if (control.ctrlId === "") {
      const fields = c.inv.fields.filter(f => f.listId === list && f.paraInList === paragraph);
      if (fields.length !== 1) throw new Error("field ownership");
      const f = fields[0]!;
      return { ...base, f: f.fieldType === "formula" ? { id: f.fieldId, type: "formula" }
        : { id: f.fieldId, type: f.fieldType, name: f.name, command: f.command, guide: f.guide, start: f.startCharIdx, end: f.endCharIdx } };
    }
    // Pictures, shapes and other objects: no owned text lists (a list hosted by the object is refused).
    if (c.inv.lists.some(l => l.hostListId === list && l.hostPara === paragraph && l.controlIndex === control.controlIndex)) throw new Error("object text list");
    return base;
  });
  return JSON.stringify([text, parts]);
}

/** Paragraph digests of one cell of the target table. Plain cells reduce to the paragraph texts. */
function cellDigests(c: DigestContext, cell: number, list: number): string[] {
  const levels = pathLevels(c.at);
  levels[levels.length - 1] = { ...levels[levels.length - 1]!, cellIndex: cell, cellParaIndex: 0 };
  const out: string[] = [];
  for (let p = 0, n = paragraphCount(c, levels); p < n; p++) {
    levels[levels.length - 1] = { ...levels[levels.length - 1]!, cellParaIndex: p };
    out.push(paragraphDigest(c, [...levels], list));
  }
  return out;
}

function tableDigests(doc: RhwpDocument, at: TableTarget, grid: TableGrid): string[][] {
  const inv = inventory(doc);
  if (typeof inv === "string") throw new Error(`table inventory: ${inv}`);
  const lists = cellLists(inv, at, grid);
  if (typeof lists === "string") throw new Error(`table ownership: ${lists}`);
  const c: DigestContext = { doc, at, inv, budget: { ...textBudget(), nodes: MAX_TABLE_PARAGRAPHS } };
  return grid.cells.map((_, index) => cellDigests(c, index, lists.get(index)!));
}
const EMPTY_PARAGRAPH = JSON.stringify([""]);

const key = (row: number, col: number) => `${row},${col}`;

/** Index of the cell covering a logical coordinate. */
export function cellCovering(grid: TableGrid, row: number, col: number): number {
  return grid.cells.findIndex(c => row >= c.row && row < c.row + c.rowSpan && col >= c.col && col < c.col + c.colSpan);
}

/**
 * Geometry-only eligibility of one operation at `cell` (index in `grid`): null when the operation is defined for
 * this shape. Used for command availability; `planTableOp` repeats it and adds the content of every cell.
 */
export function tableOpRefusal(grid: TableGrid, cell: number, op: TableStructureOp): TableStructureRefusal | null {
  const at = grid.cells[cell];
  if (!at) return "tableShape";
  const L = TABLE_STRUCTURE_LIMITS;
  switch (op) {
    case "insertRowAbove": case "insertRowBelow":
      return grid.rows + 1 > L.rows || grid.cells.length + grid.cols > L.cells ? "limit" : null;
    case "insertColumnLeft": case "insertColumnRight":
      return grid.cols + 1 > L.cols || grid.cells.length + grid.rows > L.cells ? "limit" : null;
    case "deleteRow":
      return grid.rows < 2 ? "tableShape" : null;
    case "deleteColumn":
      return grid.cols < 2 ? "tableShape" : null;
    case "mergeRight": {
      const next = grid.cells.find(c => c.row === at.row && c.col === at.col + at.colSpan);
      return next && next.rowSpan === at.rowSpan ? null : "tableShape";
    }
    case "mergeBelow": {
      const next = grid.cells.find(c => c.col === at.col && c.row === at.row + at.rowSpan);
      return next && next.colSpan === at.colSpan ? null : "tableShape";
    }
    case "mergeCells": return "tableShape"; // requires an explicit range, checked by planTableOp
    case "splitCell":
      if (at.rowSpan === 1 && at.colSpan === 1) return "tableShape";
      return grid.cells.length + at.rowSpan * at.colSpan - 1 > L.cells ? "limit" : null;
  }
}

/**
 * Compute the engine call and the exact expected table. Reads every cell's text (the content the operation must
 * preserve). Throws only if the engine getters fail; a shape the operation is not defined for returns a refusal.
 */
export function planTableOp(doc: RhwpDocument, target: TableTarget, grid: TableGrid, cell: number, op: TableStructureOp, range?: CellRange,
  options: TableContentOptions = { fields: true }): TablePlan | TableStructureRefusal {
  const refusal = op === "mergeCells" && range ? null : tableOpRefusal(grid, cell, op);
  if (refusal) return refusal;
  const content = tableContent(doc, target, grid, options);
  if (typeof content === "string") return content;
  const at = grid.cells[cell]!;
  let texts: string[][];
  try { texts = tableDigests(doc, target, grid); }
  catch (error) { if (error instanceof TableTextBudgetExceeded) return "limit"; throw error; }
  const cells = new Map<string, { rowSpan: number; colSpan: number; paragraphs: readonly string[] }>();
  const put = (row: number, col: number, rowSpan: number, colSpan: number, paragraphs: readonly string[]) => {
    cells.set(key(row, col), { rowSpan, colSpan, paragraphs });
  };
  const EMPTY = [EMPTY_PARAGRAPH];
  const isEmpty = (paragraphs: readonly string[]) => paragraphs.length === 1 && paragraphs[0] === EMPTY_PARAGRAPH;
  // Where each original logical coordinate goes (null: removed or absorbed by this operation).
  let map: (row: number, col: number) => { row: number; col: number } | null = (row, col) => ({ row, col });
  let { rows, cols } = grid;
  let call: (number | boolean)[];
  let caret = { row: at.row, col: at.col };
  if (op === "insertRowAbove" || op === "insertRowBelow") {
    const below = op === "insertRowBelow";
    // The engine inserts relative to one grid row: the first row of the cell (above) or its last row (below).
    const reference = below ? at.row + at.rowSpan - 1 : at.row, inserted = below ? reference + 1 : reference;
    const covered = new Array<boolean>(cols).fill(false);
    grid.cells.forEach((c, i) => {
      const spans = c.row < inserted && c.row + c.rowSpan > inserted;
      if (spans) for (let x = c.col; x < c.col + c.colSpan; x++) covered[x] = true;
      put(c.row >= inserted ? c.row + 1 : c.row, c.col, c.rowSpan + (spans ? 1 : 0), c.colSpan, texts[i]!);
    });
    for (let x = 0; x < cols; x++) if (!covered[x]) put(inserted, x, 1, 1, EMPTY);
    rows += 1; call = [reference, below];
    caret = { row: at.row >= inserted ? at.row + 1 : at.row, col: at.col };
    map = (row, col) => ({ row: row >= inserted ? row + 1 : row, col });
  } else if (op === "insertColumnLeft" || op === "insertColumnRight") {
    const right = op === "insertColumnRight";
    const reference = right ? at.col + at.colSpan - 1 : at.col, inserted = right ? reference + 1 : reference;
    const covered = new Array<boolean>(rows).fill(false);
    grid.cells.forEach((c, i) => {
      const spans = c.col < inserted && c.col + c.colSpan > inserted;
      if (spans) for (let y = c.row; y < c.row + c.rowSpan; y++) covered[y] = true;
      put(c.row, c.col >= inserted ? c.col + 1 : c.col, c.rowSpan, c.colSpan + (spans ? 1 : 0), texts[i]!);
    });
    for (let y = 0; y < rows; y++) if (!covered[y]) put(y, inserted, 1, 1, EMPTY);
    cols += 1; call = [reference, right];
    caret = { row: at.row, col: at.col >= inserted ? at.col + 1 : at.col };
    map = (row, col) => ({ row, col: col >= inserted ? col + 1 : col });
  } else if (op === "deleteRow") {
    grid.cells.forEach((c, i) => {
      if (c.row === at.row && c.rowSpan === 1) return;
      const spans = c.row <= at.row && c.row + c.rowSpan > at.row;
      put(c.row > at.row ? c.row - 1 : c.row, c.col, c.rowSpan - (spans ? 1 : 0), c.colSpan, texts[i]!);
    });
    rows -= 1; call = [at.row];
    caret = { row: Math.min(at.row, rows - 1), col: at.col };
    map = (row, col) => row === at.row ? null : { row: row > at.row ? row - 1 : row, col };
  } else if (op === "deleteColumn") {
    grid.cells.forEach((c, i) => {
      if (c.col === at.col && c.colSpan === 1) return;
      const spans = c.col <= at.col && c.col + c.colSpan > at.col;
      put(c.row, c.col > at.col ? c.col - 1 : c.col, c.rowSpan, c.colSpan - (spans ? 1 : 0), texts[i]!);
    });
    cols -= 1; call = [at.col];
    caret = { row: at.row, col: Math.min(at.col, cols - 1) };
    map = (row, col) => col === at.col ? null : { row, col: col > at.col ? col - 1 : col };
  } else if (op === "mergeCells" && range) {
    const { startRow, startCol, endRow, endCol } = range;
    const first = cellCovering(grid, startRow, startCol), last = cellCovering(grid, endRow, endCol);
    const proven = rectangularRange(grid, first, last);
    if (!proven || JSON.stringify(proven) !== JSON.stringify(range)) return "tableShape";
    const merged: string[] = [];
    grid.cells.forEach((c, i) => {
      const inside = c.row >= startRow && c.row <= endRow && c.col >= startCol && c.col <= endCol;
      if (!inside) put(c.row, c.col, c.rowSpan, c.colSpan, texts[i]!);
      else if (i === first || !isEmpty(texts[i]!)) merged.push(...texts[i]!);
    });
    put(startRow, startCol, endRow - startRow + 1, endCol - startCol + 1, merged);
    call = [startRow, startCol, endRow, endCol]; caret = { row: startRow, col: startCol };
    map = (row, col) => row >= startRow && row <= endRow && col >= startCol && col <= endCol && (row !== startRow || col !== startCol)
      ? null : { row, col };
  } else if (op === "mergeRight" || op === "mergeBelow") {
    const next = op === "mergeRight"
      ? grid.cells.findIndex(c => c.row === at.row && c.col === at.col + at.colSpan)
      : grid.cells.findIndex(c => c.col === at.col && c.row === at.row + at.rowSpan);
    const other = grid.cells[next]!;
    const endRow = op === "mergeRight" ? at.row + at.rowSpan - 1 : other.row + other.rowSpan - 1;
    const endCol = op === "mergeRight" ? other.col + other.colSpan - 1 : at.col + at.colSpan - 1;
    // Engine contract (Table::merge_cells): the absorbed cell's paragraphs follow the anchor's, unless the
    // absorbed cell is a single empty paragraph.
    const absorbed = texts[next]!;
    const merged = isEmpty(absorbed) ? texts[cell]! : [...texts[cell]!, ...absorbed];
    map = (row, col) => row >= at.row && row <= endRow && col >= at.col && col <= endCol && (row !== at.row || col !== at.col)
      ? null : { row, col };
    grid.cells.forEach((c, i) => {
      if (i === next) return;
      if (i === cell) put(c.row, c.col, endRow - c.row + 1, endCol - c.col + 1, merged);
      else put(c.row, c.col, c.rowSpan, c.colSpan, texts[i]!);
    });
    call = [at.row, at.col, endRow, endCol];
  } else {
    grid.cells.forEach((c, i) => put(c.row, c.col, i === cell ? 1 : c.rowSpan, i === cell ? 1 : c.colSpan, texts[i]!));
    for (let y = at.row; y < at.row + at.rowSpan; y++) for (let x = at.col; x < at.col + at.colSpan; x++) {
      if (y !== at.row || x !== at.col) put(y, x, 1, 1, EMPTY);
    }
    call = [at.row, at.col];
  }
  // Formula fields: the field moves with its cell; deleted cells delete their own fields. A formula that
  // stays must still reference existing cells after the change, and a formula cell absorbed by a merge
  // would stop being paragraph zero of its cell — both are refused before any engine call.
  const formulas: { fieldId: number; row: number; col: number; formula: string }[] = [];
  for (const f of content.formulas) {
    const moved = map(f.row, f.col);
    const deleted = !moved && (op === "deleteRow" || op === "deleteColumn");
    if (deleted) continue;
    if (!moved) return "tableFormula";
    const formula = remapFormulaReferences(f.expression, { row: f.row, col: f.col, rows: grid.rows, cols: grid.cols },
      { row: moved.row, col: moved.col, rows, cols }, map);
    if (formula === null) return "tableFormula";
    formulas.push({ fieldId: f.fieldId, row: moved.row, col: moved.col, formula });
  }
  const ordered = formulaOrder(formulas, rows, cols);
  if (!ordered) return "tableFormula";
  return { op, call, rows, cols, cells, caret, formulas: ordered, options, caption: content.caption };
}

/** Dependencies first (operands are recalculated before formulas reading them). Null on a cycle/unknown grammar. */
function formulaOrder<T extends { row: number; col: number; formula: string }>(formulas: T[], rows: number, cols: number): T[] | null {
  const byKey = new Map(formulas.map(f => [f.row * cols + f.col, f]));
  const state = new Map<number, number>(), out: T[] = [];
  for (const f of formulas) {
    const stack: { key: number; deps: number[]; next: number }[] = [];
    const push = (key: number) => {
      const g = byKey.get(key)!;
      const deps = formulaDependencies(g.formula, { row: g.row, col: g.col, rows, cols });
      if (!deps) return false;
      state.set(key, 1); stack.push({ key, deps: deps.filter(d => byKey.has(d)), next: 0 }); return true;
    };
    const root = f.row * cols + f.col;
    if (state.get(root) === 2) continue;
    if (!push(root)) return null;
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      if (frame.next === frame.deps.length) { state.set(frame.key, 2); out.push(byKey.get(frame.key)!); stack.pop(); continue; }
      const dep = frame.deps[frame.next++]!;
      if (state.get(dep) === 1) return null;
      if (state.get(dep) !== 2 && !push(dep)) return null;
    }
  }
  return out;
}

/**
 * Execute a plan and prove the result. Throws on any engine refusal or on any difference between the table the
 * engine produced and the planned one (dimensions, coverage, every cell's coordinates, spans and paragraph texts).
 * Returns the result grid.
 */
export function applyTablePlan(doc: RhwpDocument, target: TableTarget, plan: TablePlan): TableGrid {
  const method = doc[API[plan.op]] as ((...args: unknown[]) => string) | undefined;
  if (typeof method !== "function") throw new Error("table structure API unavailable");
  const result: unknown = JSON.parse(target.path
    ? doc.editTableByPath!(target.section, target.paragraph, pathJson(target.path), plan.op,
      JSON.stringify(plan.call.map(v => typeof v === "boolean" ? Number(v) : v)))
    : method.call(doc, target.section, target.paragraph, target.control, ...plan.call));
  if (!isRecord(result) || result.ok !== true) throw new Error("table structure operation rejected");
  const grid = readTableGrid(doc, target);
  if (typeof grid === "string") throw new Error(`table structure result unreadable: ${grid}`);
  if (grid.rows !== plan.rows || grid.cols !== plan.cols || grid.cells.length !== plan.cells.size) throw new Error("table structure result differs");
  const digests = tableDigests(doc, target, grid);
  grid.cells.forEach((c, index) => {
    const expected = plan.cells.get(key(c.row, c.col));
    const actual = digests[index]!;
    if (!expected || expected.rowSpan !== c.rowSpan || expected.colSpan !== c.colSpan
      || expected.paragraphs.length !== actual.length || expected.paragraphs.some((text, i) => text !== actual[i])) {
      throw new Error("table structure result differs");
    }
  });
  const content = tableContent(doc, target, grid, plan.options);
  if (typeof content === "string" || content.caption !== plan.caption) throw new Error("table structure result content differs");
  // Every surviving formula is still owned by the same field at its planned coordinate; then its references
  // are rewritten and it is recalculated through the existing engine field replacement, dependencies first.
  const surviving = new Map(content.formulas.map(f => [f.fieldId, f]));
  if (surviving.size !== plan.formulas.length) throw new Error("formula fields differ");
  for (const f of plan.formulas) {
    const found = surviving.get(f.fieldId);
    if (!found || found.row !== f.row || found.col !== f.col) throw new Error("formula field moved unexpectedly");
  }
  for (const f of plan.formulas) {
    const value: unknown = JSON.parse(target.path
      ? doc.insertTableFormulaFieldByPath!(target.section, target.paragraph, pathJson(target.path), f.row, f.col, f.formula)
      : doc.insertTableFormulaField!(target.section, target.paragraph, target.control, f.row, f.col, f.formula));
    if (!isRecord(value) || value.ok !== true || value.fieldId !== f.fieldId) throw new Error("formula rewrite rejected");
  }
  return grid;
}
