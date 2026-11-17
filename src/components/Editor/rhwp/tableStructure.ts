// 표 구조 편집(T012 Phase 2, Stage 2): 행·열 넣기/지우기, 옆·아래 셀과 합치기, 범위 병합, 합친 셀 나누기,
// 병합하지 않은 일반 셀을 행 × 열 격자로 나누기(Stage 2 Phase 2).
//
// 본문 표와 명시적 경로의 중첩 표를 다룬다. 각 연산은
//   1) 엔진에서 읽은 격자(셀 좌표·병합)와 셀마다 문단 digest(글, 그 문단이 소유한 컨트롤 — 필드·그림·개체·
//      자식 표의 하위 구조까지 재귀로)를 읽어 대상과 결과를 미리 계산하고,
//   2) 맞지 않는 모양(걸친 병합, 모델링하지 않는 내용, 지워질 셀을 참조하는 계산식, 크기 한도)은 엔진을 부르기 전에 거절하며,
//   3) 엔진 호출 뒤 표를 다시 읽어 계산한 결과와 셀 하나하나(좌표·병합·문단 digest)가 같은지 확인한다.
//      요청한 연산이 지운 셀(행·열 지우기)의 내용만 사라질 수 있고, 다른 내용은 옮겨진 셀에서 그대로 다시 보여야 한다.
//   4) 계산식 필드는 같은 필드 ID로 옮겨진 셀에 남아야 하며, 절대 참조를 새 좌표로 다시 쓰고 의존 순서로 다시 계산한다.
// 엔진이 성공을 돌려준 것만으로 지원한다고 보지 않는다: 3)·4)가 어긋나면 던지고, 세션이 그 변경을 되돌린다.
import { paragraphFieldMap } from "./fieldOwnership";
import { cachedFormula } from "./formulaDependencies";
import { formulaDependencies, remapFormulaReferences, MAX_FORMULA_CELL_VISITS } from "../../../commands/parameters";
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

/** Dimensions of an ordinary (unmerged 1x1) cell split; merged cells keep the restore (unmerge) contract. */
export interface CellSplit { rows: number; columns: number }
/** Narrowest sub-cell an ordinary split may create: 6 pt in HWPUNIT (the engine enforces the same bound). */
export const MIN_SPLIT_CELL_WIDTH = 600;
/** Largest per-dimension value the shared split dialog accepts (two digits). */
const MAX_SPLIT_DIMENSION = 99;

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
export interface TableFormula { fieldId: number; cell: number; row: number; col: number; expression: string; value: string; paragraph: number; start: number }
/** Proven content of a table (Stage 2): rich cells are compared by paragraph digest. */
export interface TableContent { formulas: readonly TableFormula[]; rich: boolean; caption: string | null }
export interface TableContentOptions {
  /** Supported fields and captions may be preserved and relocated in HWP/HWPX. */
  fields: boolean;
}
export interface TablePlan {
  op: TableStructureOp;
  /** Engine call arguments after (section, paragraph, control). */
  call: readonly (number | boolean)[];
  /** Ordinary cell split: executed through the explicit-path `splitCellInto` engine operation. */
  split?: CellSplit;
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

/** Engine support for splitting an ordinary cell: the explicit-path editor and the cell width reader. */
export function hasOrdinarySplitApi(doc: RhwpDocument, at: TableTarget): boolean {
  return !!doc.editTableByPath && (at.path ? !!doc.getCellPropertiesByPath : !!doc.getCellProperties);
}

/** Width (HWPUNIT) of one cell of the target table, or null when the engine cannot report it. Never throws. */
export function tableCellWidth(doc: RhwpDocument, at: TableTarget, cell: number): number | null {
  try {
    const raw = at.path ? doc.getCellPropertiesByPath!(at.section, at.paragraph, JSON.stringify(pathLevels(at)), cell)
      : doc.getCellProperties!(at.section, at.paragraph, at.control, cell);
    const value: unknown = JSON.parse(raw);
    return isRecord(value) && isIndex(value.width) ? value.width : null;
  } catch { return null; }
}

/**
 * Largest ordinary split of the 1x1 cell `cell`: per-dimension bounds from the table limits (rows, columns,
 * logical cells), the minimum sub-cell width and the dialog's two digits, and the cell budget of the product.
 * Null when the cell is merged or no split of at least two cells fits.
 */
export function ordinarySplitLimits(grid: TableGrid, cell: number, width: number | null): { maxRows: number; maxColumns: number; maxCells: number } | null {
  const at = grid.cells[cell];
  if (!at || at.rowSpan !== 1 || at.colSpan !== 1 || width === null) return null;
  const L = TABLE_STRUCTURE_LIMITS;
  const maxCells = L.cells - grid.cells.length + 1;
  const maxRows = Math.max(0, Math.min(MAX_SPLIT_DIMENSION, L.rows - grid.rows + 1, maxCells));
  const maxColumns = Math.max(0, Math.min(MAX_SPLIT_DIMENSION, L.cols - grid.cols + 1, maxCells, Math.floor(width / MIN_SPLIT_CELL_WIDTH)));
  if (maxRows < 1 || maxColumns < 1 || maxCells < 2 || (maxRows < 2 && maxColumns < 2)) return null;
  return { maxRows, maxColumns, maxCells };
}

/** Whether `split` is a valid ordinary split under `limits` (integers, at least two cells, every bound). */
export function ordinarySplitValid(split: CellSplit, limits: { maxRows: number; maxColumns: number; maxCells: number }): boolean {
  const { rows, columns } = split;
  return Number.isSafeInteger(rows) && Number.isSafeInteger(columns) && rows >= 1 && columns >= 1 && rows * columns >= 2
    && rows <= limits.maxRows && columns <= limits.maxColumns && rows * columns <= limits.maxCells;
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

export function tableTargetPathJson(target: TableTarget): string {
  return target.path ? pathJson(target.path) : JSON.stringify(pathLevels(target));
}

export const RHWP_BORDER_STYLES = [
  "single", "double", "dotted", "dashed", "dotDash", "dashDotDot", "longDash", "circle",
  "thinThick", "thickThin", "triple", "wave", "doubleWave", "thick3d", "thick3dRev", "thin3d", "thin3dRev", "none",
] as const;

const RHWP_STYLE_CODE: Readonly<Record<string, number>> = {
  none: 0, single: 1, dashed: 2, dotted: 3, dotDash: 4, dashDotDot: 5, longDash: 6, circle: 7,
  double: 8, thinThick: 9, thickThin: 10, triple: 11, wave: 12, doubleWave: 13,
  thick3d: 14, thick3dRev: 15, thin3d: 16, thin3dRev: 17,
};
const RHWP_CODE_STYLE: readonly string[] = [
  "none", "single", "dashed", "dotted", "dotDash", "dashDotDot", "longDash", "circle",
  "double", "thinThick", "thickThin", "triple", "wave", "doubleWave",
  "thick3d", "thick3dRev", "thin3d", "thin3dRev",
];

export const RHWP_BORDER_WIDTHS_MM = [
  0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0,
] as const;

export function rhwpBorderStyleToCode(style: string): number | null {
  return Object.prototype.hasOwnProperty.call(RHWP_STYLE_CODE, style) ? RHWP_STYLE_CODE[style]! : null;
}

export function rhwpBorderCodeToStyle(code: number): string | null {
  return Number.isSafeInteger(code) && code >= 0 && code < RHWP_CODE_STYLE.length ? RHWP_CODE_STYLE[code]! : null;
}

export function rhwpBorderWidthToIndex(mm: number): number | null {
  const idx = RHWP_BORDER_WIDTHS_MM.findIndex((w) => Math.abs(w - mm) < 1e-6);
  return idx >= 0 ? idx : null;
}

export function rhwpBorderIndexToWidth(index: number): number | null {
  return Number.isSafeInteger(index) && index >= 0 && index < RHWP_BORDER_WIDTHS_MM.length
    ? RHWP_BORDER_WIDTHS_MM[index]! : null;
}

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
  const ids = new Set<number>();
  for (const field of fields) {
    if (!isIndex(field.fieldId) || field.fieldId === 0 || ids.has(field.fieldId)) return "tableContent";
    ids.add(field.fieldId);
  }
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
 * be read into the paragraph digest; formula fields retain exact paragraph/range/ID ownership so that every expression can be rewritten. Captions and text boxes (non-cell lists) stay
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
        if (!isIndex(part.paraIndex) || !isIndex(field.startCharIdx) || !cached || cached.value !== field.value || !coordinates
          || !isIndex(field.fieldId) || field.fieldId === 0) return "tableFormula";
        formulas.push({ fieldId: field.fieldId, cell: part.cellIndex, row: coordinates.row, col: coordinates.col, expression: cached.expression, value: cached.value,
          paragraph: part.paraIndex, start: field.startCharIdx });
      } else if (field.fieldType !== "clickhere") return "tableContent";
    }
    for (const control of inv.controls) {
      if (!isIndex(control.list)) return "engineUnsupported";
      if (byList.has(control.list)) rich = true;
    }
    if (formulas.length > 1024) return "limit";
    // A caption is not a cell list; the structure operation never owns it, so its whole reported identity
    // (content, shape references, attributes, ownership by this table path) must stay identical.
    let caption: string | null = null;
    if (doc.getTableCaptionByPath) {
      const raw = doc.getTableCaptionByPath(at.section, at.paragraph, JSON.stringify(pathLevels(at)));
      if (raw.length > MAX_JSON) return "limit";
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value) || (value.paragraphs !== null && !Array.isArray(value.paragraphs))) return "engineUnsupported";
      if (value.paragraphs !== null) {
        if (!options.fields) return "tableContent";
        // Text alone is not caption identity: the engine reports paragraph/character shape references,
        // owned control counts and the caption's layout attributes of this table's caption.
        if (!Array.isArray(value.shapes) || !isRecord(value.attrs)) return "engineUnsupported";
        caption = JSON.stringify(value); rich = true;
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
  const fieldMap = paragraphFieldMap(c.inv.controls, c.inv.fields, list, paragraph);
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
      const f = fieldMap.get(control);
      if (!f) throw new Error("field ownership");
      return { ...base, f: f.fieldType === "formula" ? { id: f.fieldId, type: "formula" }
        : { id: f.fieldId, type: f.fieldType, name: f.name, command: f.command, guide: f.guide, editable: f.editableInForm, start: f.startCharIdx, end: f.endCharIdx, startPos: f.startPos, endPos: f.endPos } };
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
      // An ordinary cell needs explicit dimensions (planTableOp); the smallest split must still fit.
      if (at.rowSpan === 1 && at.colSpan === 1)
        return grid.cells.length + 1 > L.cells || (grid.rows + 1 > L.rows && grid.cols + 1 > L.cols) ? "limit" : null;
      return grid.cells.length + at.rowSpan * at.colSpan - 1 > L.cells ? "limit" : null;
  }
}

/**
 * Compute the engine call and the exact expected table. Reads every cell's text (the content the operation must
 * preserve). Throws only if the engine getters fail; a shape the operation is not defined for returns a refusal.
 */
export function planTableOp(doc: RhwpDocument, target: TableTarget, grid: TableGrid, cell: number, op: TableStructureOp, range?: CellRange,
  options: TableContentOptions = { fields: true }, split?: CellSplit): TablePlan | TableStructureRefusal {
  const refusal = op === "mergeCells" && range ? null : tableOpRefusal(grid, cell, op);
  if (refusal) return refusal;
  const ordinary = op === "splitCell" && grid.cells[cell]!.rowSpan === 1 && grid.cells[cell]!.colSpan === 1;
  // Dimensions belong to an ordinary split only: a merged cell is restored to its constituent cells.
  if (split && !ordinary) return "tableShape";
  if (ordinary) {
    if (!split || !hasOrdinarySplitApi(doc, target)) return split ? "engineUnsupported" : "tableShape";
    const limits = ordinarySplitLimits(grid, cell, tableCellWidth(doc, target, cell));
    if (!limits) return "limit";
    if (!ordinarySplitValid(split, limits)) {
      const shaped = Number.isSafeInteger(split.rows) && Number.isSafeInteger(split.columns) && split.rows >= 1 && split.columns >= 1 && split.rows * split.columns >= 2;
      return shaped ? "limit" : "tableShape";
    }
  }
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
  } else if (ordinary && split) {
    // Engine contract (Table::split_cell_into for a 1x1 cell): the grid gains rows-1 rows below and columns-1
    // columns right of the cell; every other cell crossing its row/column widens its span, later cells move.
    // The original cell keeps all paragraphs as the top-left sub-cell; the other sub-cells are empty.
    const extraRows = split.rows - 1, extraCols = split.columns - 1;
    grid.cells.forEach((c, i) => {
      if (i === cell) return put(c.row, c.col, 1, 1, texts[i]!);
      const crossesRow = c.row <= at.row && at.row < c.row + c.rowSpan, crossesCol = c.col <= at.col && at.col < c.col + c.colSpan;
      put(c.row > at.row ? c.row + extraRows : c.row, c.col > at.col ? c.col + extraCols : c.col,
        c.rowSpan + (crossesRow ? extraRows : 0), c.colSpan + (crossesCol ? extraCols : 0), texts[i]!);
    });
    for (let y = 0; y < split.rows; y++) for (let x = 0; x < split.columns; x++) {
      if (y || x) put(at.row + y, at.col + x, 1, 1, EMPTY);
    }
    rows += extraRows; cols += extraCols;
    call = [at.row, at.col, split.rows, split.columns];
    map = (row, col) => ({ row: row > at.row ? row + extraRows : row, col: col > at.col ? col + extraCols : col });
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
  // Engine rule (validate_formula_references): every coordinate a formula reads (cells, range interiors, directions)
  // must be the anchor of a result cell; a position covered by a merge is ambiguous. Refuse such a plan before any
  // engine call instead of mutating and rolling back.
  for (const f of ordered) {
    const deps = formulaDependencies(f.formula, { row: f.row, col: f.col, rows, cols });
    if (!deps || deps.some(d => !cells.has(key(Math.floor(d / cols), d % cols)))) return "tableFormula";
  }
  return { op, call, rows, cols, cells, caret, formulas: ordered, options, caption: content.caption, ...(ordinary && split ? { split: { ...split } } : {}) };
}

/** Dependencies first (operands are recalculated before formulas reading them). Null on a cycle/unknown grammar. */
function formulaOrder<T extends { row: number; col: number; formula: string }>(formulas: T[], rows: number, cols: number): T[] | null {
  // Field identity is the graph node. A dependency coordinate may resolve to exactly
  // one formula; multiple formulas at that coordinate are ambiguous operands.
  const byCoordinate = new Map<number, number[]>();
  formulas.forEach((f, i) => { const key = f.row * cols + f.col; byCoordinate.set(key, [...(byCoordinate.get(key) ?? []), i]); });
  const state = new Map<number, number>(), out: T[] = [];
  let budget = formulas.length;
  for (let root = 0; root < formulas.length; root++) {
    const stack: { key: number; deps: number[]; next: number }[] = [];
    const push = (key: number) => {
      const g = formulas[key]!;
      const edges = formulaDependencies(g.formula, { row: g.row, col: g.col, rows, cols });
      if (!edges || (budget += edges.length) > MAX_FORMULA_CELL_VISITS) return false;
      const deps: number[] = [];
      for (const edge of edges) {
        const matches = byCoordinate.get(edge) ?? [];
        if (matches.length > 1) return false;
        deps.push(...matches);
      }
      state.set(key, 1); stack.push({ key, deps, next: 0 }); return true;
    };
    if (state.get(root) === 2) continue;
    if (!push(root)) return null;
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      if (frame.next === frame.deps.length) { state.set(frame.key, 2); out.push(formulas[frame.key]!); stack.pop(); continue; }
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
  if (plan.split && !doc.editTableByPath) throw new Error("table split API unavailable");
  // An ordinary split always goes through the engine's validated explicit-path operation (body: one level).
  const result: unknown = JSON.parse(plan.split
    ? doc.editTableByPath!(target.section, target.paragraph, target.path ? pathJson(target.path) : JSON.stringify(pathLevels(target)),
      "splitCellInto", JSON.stringify(plan.call))
    : target.path
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
    // Read again after each edit: earlier result lengths may shift later field ranges.
    const current = tableContent(doc, target, grid, plan.options);
    if (typeof current === "string") throw new Error("formula ownership unavailable");
    const owner = current.formulas.find(g => g.fieldId === f.fieldId);
    if (!owner || !doc.insertTableFormulaAt) throw new Error("formula owner lost");
    const path = pathLevels(target).map((l, i, a) => i === a.length - 1
      ? { ...l, cellIndex: owner.cell, cellParaIndex: owner.paragraph } : l);
    const value: unknown = JSON.parse(doc.insertTableFormulaAt(target.section, target.paragraph, JSON.stringify(path), owner.start, f.fieldId, f.formula));
    if (!isRecord(value) || value.ok !== true || value.fieldId !== f.fieldId) throw new Error("formula rewrite rejected");
  }
  verifyFormulaState(doc, target, grid, plan);
  return grid;
}

/**
 * Final-state contract of a structure change with formulas, read back from the engine (never inferred from
 * `ok:true`): exactly the planned field ids, owned by this table at their planned coordinates, holding the
 * rewritten expressions, and cached values that the engine's own read-only evaluation of the final table
 * reproduces unchanged (`changed:false`). Any difference throws; the session restores its snapshot.
 */
function verifyFormulaState(doc: RhwpDocument, target: TableTarget, grid: TableGrid, plan: TablePlan): void {
  if (!plan.formulas.length && !plan.options.fields) return;
  const content = tableContent(doc, target, grid, plan.options);
  if (typeof content === "string" || content.formulas.length !== plan.formulas.length) throw new Error("formula fields differ after rewrite");
  const actual = new Map(content.formulas.map(f => [f.fieldId, f]));
  for (const f of plan.formulas) {
    const found = actual.get(f.fieldId);
    if (!found || found.row !== f.row || found.col !== f.col || found.expression !== f.formula
      || grid.cells[found.cell]?.row !== f.row || grid.cells[found.cell]?.col !== f.col) throw new Error("formula field state differs after rewrite");
    const path = pathLevels(target).map((l, i, a) => i === a.length - 1
      ? { ...l, cellIndex: found.cell, cellParaIndex: found.paragraph } : l);
    const check: unknown = JSON.parse(doc.validateTableFormulaAt!(target.section, target.paragraph, JSON.stringify(path), found.start, f.fieldId, f.formula));
    if (!isRecord(check) || check.ok !== true || check.fieldId !== f.fieldId || check.changed !== false || check.text !== found.value)
      throw new Error("formula value not recalculated");
  }
}
