// 표 구조 편집(T012 Phase 2): 행·열 넣기/지우기, 옆·아래 셀과 합치기, 합친 셀 나누기.
//
// 본문 표와 명시적 경로의 중첩 표 중 셀에 글 문단만 있는 표를 다룬다. 각 연산은
//   1) 엔진에서 읽은 격자(셀 좌표·병합)로 대상과 결과를 미리 계산하고,
//   2) 맞지 않는 모양(걸친 병합, 필드·개체·중첩 표가 있는 셀, 크기 한도)은 엔진을 부르기 전에 거절하며,
//   3) 엔진 호출 뒤 표를 다시 읽어 계산한 결과와 셀 하나하나(좌표·병합·문단 글)가 같은지 확인한다.
// 엔진이 성공을 돌려준 것만으로 지원한다고 보지 않는다: 3)이 어긋나면 던지고, 세션이 그 변경을 되돌린다.
// 계산식 참조(A1, LEFT 등)는 행·열이 바뀌면 다른 셀을 가리키므로, 필드가 있는 표는 구조를 바꾸지 않는다.
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

/**
 * Content eligibility of the whole table: every cell is exactly one cursor list owned by this table, and no cell
 * list holds a control (field, picture, nested table, …). A field anywhere in the table — formulas reference cells
 * by coordinate — is reported separately. Never throws; an unreadable inventory is a refusal.
 */
export function tableContentRefusal(doc: RhwpDocument, at: TableTarget, grid: TableGrid): TableStructureRefusal | null {
  try {
    if (!doc.getControls || !doc.getCursorModel || !doc.getFieldList) return "engineUnsupported";
    const [controlsRaw, modelRaw, fieldsRaw] = [doc.getControls(), doc.getCursorModel(), doc.getFieldList()];
    if (controlsRaw.length > MAX_JSON || modelRaw.length > MAX_JSON || fieldsRaw.length > MAX_JSON) return "limit";
    const controls: unknown = JSON.parse(controlsRaw), model: unknown = JSON.parse(modelRaw), fields: unknown = JSON.parse(fieldsRaw);
    if (!Array.isArray(controls) || !isRecord(model) || !Array.isArray(model.lists) || !Array.isArray(fields)) return "engineUnsupported";
    for (const field of fields) {
      if (!isRecord(field) || !isRecord(field.location) || !Array.isArray(field.location.path)) return "engineUnsupported";
      const location = field.location;
      const levels = at.path ? JSON.parse(pathJson(at.path)) as Fields[] : [{ controlIndex: at.control }];
      if (field.location.sectionIndex === at.section && field.location.paraIndex === at.paragraph
        && levels.every((level, i) => {
          const entry: unknown = (location.path as unknown[])[i];
          return isRecord(entry) && entry.controlIndex === level.controlIndex
            && (i === levels.length - 1 || (entry.cellIndex === level.cellIndex && entry.cellParaIndex === level.cellParaIndex));
        })) return "tableFormula";
    }
    let host = 0, hostPara = at.paragraph;
    if (at.path?.nested) {
      const levels = [at.path, ...at.path.nested];
      for (const level of levels.slice(0, -1)) {
        const matches = model.lists.filter(l => isRecord(l) && l.isCell === true && l.sectionIndex === at.section
          && l.hostListId === host && l.hostPara === hostPara && l.controlIndex === level.control && l.cellIndex === level.cell);
        if (matches.length !== 1 || !isRecord(matches[0]) || !isIndex(matches[0].listId)) return "tableContent";
        host = matches[0].listId; hostPara = level.cellParagraph;
      }
    }
    const lists = new Set<number>(), seen = new Set<number>();
    for (const list of model.lists) {
      if (!isRecord(list) || list.hostListId !== host || list.sectionIndex !== at.section || list.hostPara !== hostPara
        || list.controlIndex !== at.control) continue;
      if (list.isCell !== true || !isIndex(list.listId) || list.listId < 2 || !isIndex(list.cellIndex)
        || list.cellIndex >= grid.cells.length || seen.has(list.cellIndex) || lists.has(list.listId)) return "tableContent";
      seen.add(list.cellIndex); lists.add(list.listId);
    }
    if (lists.size !== grid.cells.length) return "tableContent"; // a caption or an unlisted cell: ownership not proven
    for (const control of controls) {
      if (!isRecord(control) || !isIndex(control.list)) return "engineUnsupported";
      if (lists.has(control.list)) return "tableContent";
    }
    return null;
  } catch { return "engineUnsupported"; }
}

function cellTexts(doc: RhwpDocument, at: TableTarget, cell: number, budget = textBudget()): string[] {
  const path = at.path ? cellPath(at, cell) : null;
  const count = path ? doc.getCellParagraphCountByPath!(at.section, at.paragraph, path)
    : doc.getCellParagraphCount(at.section, at.paragraph, at.control, cell);
  if (!isIndex(count) || count < 1) throw new Error("cell paragraph count");
  if (count > budget.paragraphs) throw new TableTextBudgetExceeded();
  budget.paragraphs -= count;
  const out: string[] = [];
  for (let p = 0; p < count; p++) {
    const levels = path ? JSON.parse(path) as { cellParaIndex: number }[] : null;
    if (levels) levels[levels.length - 1]!.cellParaIndex = p;
    const paraPath = levels ? JSON.stringify(levels) : null;
    const length = paraPath ? doc.getCellParagraphLengthByPath!(at.section, at.paragraph, paraPath)
      : doc.getCellParagraphLength(at.section, at.paragraph, at.control, cell, p);
    if (!isIndex(length)) throw new Error("cell paragraph length");
    if (length > budget.chars) throw new TableTextBudgetExceeded();
    budget.chars -= length;
    const text = paraPath ? doc.getTextInCellByPath!(at.section, at.paragraph, paraPath, 0, length)
      : doc.getTextInCell(at.section, at.paragraph, at.control, cell, p, 0, length);
    if (typeof text !== "string" || Array.from(text).length !== length) throw new Error("cell paragraph text");
    out.push(text);
  }
  return out;
}

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
export function planTableOp(doc: RhwpDocument, target: TableTarget, grid: TableGrid, cell: number, op: TableStructureOp, range?: CellRange): TablePlan | TableStructureRefusal {
  const refusal = op === "mergeCells" && range ? null : tableOpRefusal(grid, cell, op);
  if (refusal) return refusal;
  const at = grid.cells[cell]!;
  let texts: string[][];
  const budget = textBudget();
  try { texts = grid.cells.map((_, index) => cellTexts(doc, target, index, budget)); }
  catch (error) { if (error instanceof TableTextBudgetExceeded) return "limit"; throw error; }
  const cells = new Map<string, { rowSpan: number; colSpan: number; paragraphs: readonly string[] }>();
  const put = (row: number, col: number, rowSpan: number, colSpan: number, paragraphs: readonly string[]) => {
    cells.set(key(row, col), { rowSpan, colSpan, paragraphs });
  };
  const EMPTY = [""];
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
  } else if (op === "deleteRow") {
    grid.cells.forEach((c, i) => {
      if (c.row === at.row && c.rowSpan === 1) return;
      const spans = c.row <= at.row && c.row + c.rowSpan > at.row;
      put(c.row > at.row ? c.row - 1 : c.row, c.col, c.rowSpan - (spans ? 1 : 0), c.colSpan, texts[i]!);
    });
    rows -= 1; call = [at.row];
    caret = { row: Math.min(at.row, rows - 1), col: at.col };
  } else if (op === "deleteColumn") {
    grid.cells.forEach((c, i) => {
      if (c.col === at.col && c.colSpan === 1) return;
      const spans = c.col <= at.col && c.col + c.colSpan > at.col;
      put(c.row, c.col > at.col ? c.col - 1 : c.col, c.rowSpan, c.colSpan - (spans ? 1 : 0), texts[i]!);
    });
    cols -= 1; call = [at.col];
    caret = { row: at.row, col: Math.min(at.col, cols - 1) };
  } else if (op === "mergeCells" && range) {
    const { startRow, startCol, endRow, endCol } = range;
    const first = cellCovering(grid, startRow, startCol), last = cellCovering(grid, endRow, endCol);
    const proven = rectangularRange(grid, first, last);
    if (!proven || JSON.stringify(proven) !== JSON.stringify(range)) return "tableShape";
    const merged: string[] = [];
    grid.cells.forEach((c, i) => {
      const inside = c.row >= startRow && c.row <= endRow && c.col >= startCol && c.col <= endCol;
      if (!inside) put(c.row, c.col, c.rowSpan, c.colSpan, texts[i]!);
      else if (i === first || !(texts[i]!.length === 1 && texts[i]![0] === "")) merged.push(...texts[i]!);
    });
    put(startRow, startCol, endRow - startRow + 1, endCol - startCol + 1, merged);
    call = [startRow, startCol, endRow, endCol]; caret = { row: startRow, col: startCol };
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
    const merged = absorbed.length === 1 && absorbed[0] === "" ? texts[cell]! : [...texts[cell]!, ...absorbed];
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
  return { op, call, rows, cols, cells, caret };
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
  const budget = textBudget();
  grid.cells.forEach((c, index) => {
    const expected = plan.cells.get(key(c.row, c.col));
    const actual = cellTexts(doc, target, index, budget);
    if (!expected || expected.rowSpan !== c.rowSpan || expected.colSpan !== c.colSpan
      || expected.paragraphs.length !== actual.length || expected.paragraphs.some((text, i) => text !== actual[i])) {
      throw new Error("table structure result differs");
    }
  });
  if (tableContentRefusal(doc, target, grid) !== null) throw new Error("table structure result content differs");
  return grid;
}
