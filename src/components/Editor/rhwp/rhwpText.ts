import { MAX_CLIPBOARD_CHARS, validClipboardText } from "../../../commands/clipboard";
// rhwp 문서 위치와 본문·표 셀 API 선택(T007).
//
// 위치는 (구역, 문단, 글자 오프셋)이고, 표 셀 안이면 셀 경로(부모 문단, 컨트롤, 셀, 셀 문단)를 더한다. 같은 위치를
// 다루는 호출(커서 사각형·삽입·삭제·문단 나누기·줄 정보)은 모두 여기서 본문용/셀용 API를 고르므로, 렌더·hit test·
// 편집이 서로 다른 좌표를 쓰지 않는다. 글자 오프셋은 rhwp의 글자(char, 유니코드 스칼라) 단위다.
// 엔진이 돌려주는 JSON은 신뢰 경계 안이지만 모양을 확인하고, 맞지 않으면 null로 다룬다.
import { cachedFormula, tableFormulaSafety } from "./formulaDependencies";
import type { CharShapePrefix, RhwpDocument } from "./rhwpModule";

/** One further table level inside a cell: the table control of the host paragraph, its cell and that cell's paragraph. */
export interface NestedCell {
  control: number;
  cell: number;
  cellParagraph: number;
}

/**
 * A table cell. Without `nested` this is the one-level form (a cell of a body-level table; `cellParagraph` is the
 * caret paragraph). With `nested` (T012 Phase 2) the caret is in a table inside that cell: `cellParagraph` is then
 * the paragraph of the outer cell that hosts the next table control, and likewise for every entry of `nested`
 * except the last, whose `cellParagraph` is the caret paragraph. The explicit path is the ownership: positions are
 * never resolved from display coordinates, and two positions share a context only if every level names the same
 * table control and cell.
 */
export interface CellRef {
  parentParagraph: number;
  control: number;
  cell: number;
  cellParagraph: number;
  nested?: readonly NestedCell[];
}

/** Supported table depth (outer table + nested levels). Deeper engine paths are refused, not truncated. */
// Matches the engine path decoder's stack envelope. JSON size and ownership
// inventory work have independent budgets; paths are never silently truncated.
export const MAX_TABLE_DEPTH = 64;
export const MAX_CELL_PATH_BYTES = 32 * 1024;
/**
 * Deepest table level the product creates. The patched engine measures/lays out every nesting
 * level its parsers accept (HWP 63 table levels, HWPX 15), and refuses deeper files. Creation
 * stays within the smaller HWPX reader envelope so a created document always reopens in either
 * format; existing deeper HWP paths remain openable/editable up to the engine bound.
 */
export const MAX_CREATED_TABLE_DEPTH = 15;

/** Innermost level of a cell path: the cell and paragraph the caret is actually in. */
export function innermost(cell: CellRef): NestedCell {
  return cell.nested?.length ? cell.nested[cell.nested.length - 1]! : cell;
}
/** Number of table levels of a position (0 = body). */
export const tableDepth = (at: DocPosition) => (at.cell ? 1 + (at.cell.nested?.length ?? 0) : 0);

/** Engine path JSON (`…ByPath`), outermost first. */
export function pathJson(cell: CellRef, paragraph = innermost(cell).cellParagraph): string {
  const levels = [{ controlIndex: cell.control, cellIndex: cell.cell, cellParaIndex: cell.cellParagraph },
    ...(cell.nested ?? []).map(n => ({ controlIndex: n.control, cellIndex: n.cell, cellParaIndex: n.cellParagraph }))];
  levels[levels.length - 1]!.cellParaIndex = paragraph;
  return JSON.stringify(levels);
}

export interface DocPosition {
  section: number;
  /** 본문 문단. 셀 안이면 표를 가진 부모 문단과 같다. */
  paragraph: number;
  offset: number;
  cell?: CellRef;
}

/** 페이지 좌표(배율 1, CSS px)의 커서. */
export interface CaretRect {
  page: number;
  x: number;
  y: number;
  height: number;
}

export interface PageRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FormulaFieldResult { changed: boolean; fieldId: number; text: string; command: string }
function formulaFieldResult(value: unknown, formula: string): FormulaFieldResult {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "changed,command,fieldId,ok,text"
    || value.ok !== true || typeof value.changed !== "boolean" || !isIndex(value.fieldId)
    || value.fieldId === 0 || value.fieldId > 0xffffffff || typeof value.text !== "string" || !Number.isFinite(Number(value.text))
    || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.text) || value.command !== `${formula.trim()}??%g,;;${value.text}`) throw new Error("formula field response invalid");
  return { changed: value.changed, fieldId: value.fieldId, text: value.text, command: value.command as string };
}

type Fields = Record<string, unknown>;
const isRecord = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const isIndex = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 글자 수(유니코드 스칼라). rhwp 오프셋과 같은 단위. */
export const charCount = (text: string) => Array.from(text).length;

export function parseCaretRect(value: unknown): CaretRect | null {
  if (!isRecord(value)) return null;
  const { pageIndex, x, y, height } = value;
  if (!isIndex(pageIndex) || !isNumber(x) || !isNumber(y) || !isNumber(height)) return null;
  return { page: pageIndex, x, y, height };
}

/** hitTest·moveVertical 결과의 위치. 머리말·꼬리말·각주 표식(아주 큰 문단 번호)은 null. */
export function parsePosition(value: unknown): DocPosition | null {
  if (!isRecord(value)) return null;
  const { sectionIndex, paragraphIndex, charOffset, parentParaIndex, controlIndex, cellIndex, cellParaIndex, isTextBox } = value;
  if (!isIndex(sectionIndex) || !isIndex(paragraphIndex) || !isIndex(charOffset)) return null;
  if (paragraphIndex >= 0xffffff00) return null;
  if (parentParaIndex === undefined) {
    // 표 셀 안의 개체(그림 등)를 가리키는 결과는 셀 경로를 다른 모양(`cellPath: [[컨트롤, 셀, 셀 문단]]`, `innerControlIdx`)으로만 준다
    // (고정 rhwp 실측, 여러 구역 문서 예제). 본문 위치로 읽으면 구역 첫 문단으로 커서가 튄다 — 이 모양은 다루지 않는다.
    if (value.cellPath !== undefined || value.innerControlIdx !== undefined) return null;
    return { section: sectionIndex, paragraph: paragraphIndex, offset: charOffset };
  }
  if (isTextBox === true) return null; // 글상자는 이 PoC 범위 밖
  if (!isIndex(parentParaIndex) || !isIndex(controlIndex) || !isIndex(cellIndex) || !isIndex(cellParaIndex)) return null;
  const cell: CellRef = { parentParagraph: parentParaIndex, control: controlIndex, cell: cellIndex, cellParagraph: cellParaIndex };
  if (value.cellPath !== undefined) {
    // The engine repeats the whole path, outermost first. Its first entry must restate the scalar cell fields
    // exactly; anything else (other shapes, extra keys, too deep) is refused rather than read as the outer cell.
    const path = value.cellPath;
    if (!Array.isArray(path) || path.length < 1 || path.length > MAX_TABLE_DEPTH) return null;
    const levels: NestedCell[] = [];
    for (const level of path) {
      if (!isRecord(level) || Object.keys(level).sort().join(",") !== "cellIndex,cellParaIndex,controlIndex"
        || !isIndex(level.controlIndex) || !isIndex(level.cellIndex) || !isIndex(level.cellParaIndex)) return null;
      levels.push({ control: level.controlIndex, cell: level.cellIndex, cellParagraph: level.cellParaIndex });
    }
    const first = levels[0]!;
    if (first.control !== controlIndex || first.cell !== cellIndex || first.cellParagraph !== cellParaIndex) return null;
    if (levels.length > 1) cell.nested = levels.slice(1);
  }
  return { section: sectionIndex, paragraph: parentParaIndex, offset: charOffset, cell };
}

export function parseSelectionRects(value: unknown): PageRect[] | null {
  if (!Array.isArray(value)) return null;
  const rects: PageRect[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { pageIndex, x, y, width, height } = item;
    if (!isIndex(pageIndex) || !isNumber(x) || !isNumber(y) || !isNumber(width) || !isNumber(height)) return null;
    rects.push({ page: pageIndex, x, y, width, height });
  }
  return rects;
}

/**
 * Same editing context: the body of one section, or exactly the same cell. For nested cells every level must name
 * the same table control and cell, and every host paragraph (all levels but the last) must be the same — a nested
 * cell is never the same context as its parent cell or as a cell of a sibling table.
 */
export function sameContext(a: DocPosition, b: DocPosition): boolean {
  if (a.section !== b.section) return false;
  if (a.cell === undefined || b.cell === undefined) return a.cell === b.cell;
  const x = a.cell, y = b.cell, nx = x.nested ?? [], ny = y.nested ?? [];
  if (x.parentParagraph !== y.parentParagraph || x.control !== y.control || x.cell !== y.cell || nx.length !== ny.length) return false;
  if (nx.length && x.cellParagraph !== y.cellParagraph) return false;
  return nx.every((level, i) => level.control === ny[i]!.control && level.cell === ny[i]!.cell
    && (i === nx.length - 1 || level.cellParagraph === ny[i]!.cellParagraph));
}

/** Same explicitly owned table; only the innermost cell may differ. */
export function sameTable(a: DocPosition, b: DocPosition): boolean {
  return !!a.cell && !!b.cell && sameContext(withCell(a, innermost(b.cell).cell), b);
}

/** 같은 문맥(본문 또는 같은 셀)에서 문서 순서 비교. */
export function compare(a: DocPosition, b: DocPosition): number {
  const paraA = paragraphOf(a), paraB = paragraphOf(b);
  return paraA !== paraB ? paraA - paraB : a.offset - b.offset;
}

/** 위치의 문단 번호(본문 문단 또는 가장 안쪽 셀의 문단). */
export const paragraphOf = (position: DocPosition) => (position.cell ? innermost(position.cell).cellParagraph : position.paragraph);

/** 같은 문맥에서 문단 번호만 바꾼 위치(중첩 셀이면 가장 안쪽 단계의 문단). */
export function withParagraph(position: DocPosition, paragraph: number, offset: number): DocPosition {
  const cell = position.cell;
  if (!cell) return { ...position, paragraph, offset };
  if (!cell.nested?.length) return { ...position, offset, cell: { ...cell, cellParagraph: paragraph } };
  const nested = cell.nested.map((level, i) => (i === cell.nested!.length - 1 ? { ...level, cellParagraph: paragraph } : level));
  return { ...position, offset, cell: { ...cell, nested } };
}

/** Same context with another innermost cell (first paragraph, offset 0). */
export function withCell(position: DocPosition, index: number): DocPosition {
  const cell = position.cell;
  if (!cell) return position;
  if (!cell.nested?.length) return { ...position, offset: 0, cell: { ...cell, cell: index, cellParagraph: 0 } };
  const nested = cell.nested.map((level, i) => (i === cell.nested!.length - 1 ? { ...level, cell: index, cellParagraph: 0 } : level));
  return { ...position, offset: 0, cell: { ...cell, nested } };
}

/** Stable identity of a position's context and paragraph path (cache/history keys; not display text). */
export function contextKey(at: DocPosition): string {
  const c = at.cell;
  return c ? `${at.section}:${c.parentParagraph}/${[c, ...(c.nested ?? [])].map(l => `${l.control}.${l.cell}.${l.cellParagraph}`).join(">")}`
    : `${at.section}:body:${at.paragraph}`;
}

const NO_CELL = 0xffffffff; // u32::MAX: rhwp가 본문을 뜻하는 값

/** 위치에 맞는 본문/셀 API를 부른다. 편집 함수는 실패하면 예외를 던진다(엔진 오류). */
export class RhwpText {
  /** Loaded definitions and definitions already published must keep their IDs. */
  private charShapeBaseline: number | null;
  private publishingCharShapes: number | null = null;
  private readonly originalCharShapeCount: number | null;
  private publishedPrefix: CharShapePrefix | null = null;
  private publishingPrefix: CharShapePrefix | null = null;
  private caretPageHint = 0;

  constructor(private readonly doc: RhwpDocument) {
    const count = doc.charShapeCount?.();
    this.charShapeBaseline = Number.isSafeInteger(count) && (count as number) >= 0 ? (count as number) : null;
    this.originalCharShapeCount = this.charShapeBaseline;
    if (this.charShapeBaseline !== null && doc.reconcileCharShapePrefix && doc.captureCharShapePrefix) {
      const prefix = doc.captureCharShapePrefix();
      if (!prefix || typeof prefix.free !== "function") throw new Error("char shape prefix response invalid");
      this.publishedPrefix = prefix;
    }
  }

  /** A validated loaded prefix, not merely the presence of WASM method names. */
  get hasCharShapeOwnership(): boolean {
    return this.charShapeBaseline !== null && this.publishedPrefix !== null;
  }

  /** Protect the exported revision before yielding to the backend. A failed save releases only this lease. */
  protectPublishingCharShapes(count: number | null, exported: RhwpDocument): () => void {
    if (this.publishingPrefix) throw new Error("publication already pending");
    // Older engines without shape tracking retain strict backend preservation.
    if (this.charShapeBaseline === null) return () => {};
    if (!this.publishedPrefix || !this.doc.capturePublishingCharShapePrefix || !isIndex(count)
      || count < this.charShapeBaseline || this.doc.charShapeCount?.() !== count
      || exported.charShapeCount?.() !== count)
      throw new Error("publication character shape identity unavailable");
    const prefix = this.doc.capturePublishingCharShapePrefix(exported);
    if (!prefix || typeof prefix.free !== "function") throw new Error("publication prefix response invalid");
    this.publishingPrefix = prefix;
    this.publishingCharShapes = count;
    return () => {
      if (this.publishingPrefix === prefix) {
        this.publishingPrefix = null;
        this.publishingCharShapes = null;
        prefix.free();
      }
    };
  }

  /** Pin a published revision even if later local edits are still dirty (including non-durable replacement). */
  markPublishedCharShapes(count: number | null): void {
    if (this.publishingPrefix && this.charShapeBaseline !== null && isIndex(count)
      && count === this.publishingCharShapes && count >= this.charShapeBaseline) {
      this.charShapeBaseline = count;
      if (this.publishingPrefix) {
        const previous = this.publishedPrefix;
        this.publishedPrefix = this.publishingPrefix;
        this.publishingPrefix = null;
        this.publishingCharShapes = null;
        previous?.free();
      }
    }
  }

  /** Reconcile only the restored live model. History keeps the original immutable snapshots. */
  reconcilePublishedCharShapes(): void {
    const prefix = this.publishingPrefix ?? this.publishedPrefix;
    if (!prefix || this.originalCharShapeCount === null) return; // older engines retain strict safe refusal
    const result = json(this.doc.reconcileCharShapePrefix!(prefix, this.originalCharShapeCount));
    if (!isRecord(result) || Object.keys(result).join(",") !== "ok" || result.ok !== true)
      throw new Error("char shape reconciliation response invalid");
  }

  /** Remove unused, unpublished definitions left by a failed in-flight save or historical branch. */
  prepareExport(): void { this.compactCharShapes(); }

  release(): void {
    const prefixes = [this.publishingPrefix, this.publishedPrefix];
    this.publishingPrefix = this.publishedPrefix = null;
    const errors: unknown[] = [];
    for (const prefix of prefixes) { try { prefix?.free(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "char shape prefix release failed");
  }

  /** Whether the engine exposes every path operation nested editing needs (never a partial set). */
  get hasNestedEditing(): boolean {
    const d = this.doc;
    return !!(d.getCellParagraphCountByPath && d.getCellParagraphLengthByPath && d.getCursorRectByPath && d.moveVerticalByPath
      && d.getSelectionRectsInCellByPath && d.getTextInCellByPath && d.insertTextInCellByPath && d.deleteTextInCellByPath
      && d.deleteRangeInCellByPath && d.splitParagraphInCellByPath && d.mergeParagraphInCellByPath
      && d.getTableDimensionsByPath && d.getCellInfoByPath && d.getCursorModel);
  }

  /**
   * Ownership proof of a nested cell path, independent of display coordinates: the engine's cursor-list table must
   * contain exactly one chain root cell → … → innermost cell whose host list, host paragraph, table control and cell
   * index equal the path at every level, and every level must be a real table holding that cell. One-level and body
   * positions keep their existing checks (true). Any missing API, ambiguity or mismatch is false.
   */
  ownsNestedCell(at: DocPosition): boolean {
    const c = at.cell;
    if (!c?.nested?.length) return true;
    if (!this.hasNestedEditing || tableDepth(at) > MAX_TABLE_DEPTH || pathJson(c).length > MAX_CELL_PATH_BYTES) return false;
    try {
      const raw = this.doc.getCursorModel!();
      if (raw.length > 8 * 1024 * 1024) return false;
      const model = json(raw);
      if (!isRecord(model) || !Array.isArray(model.lists)) return false;
      const levels = [c, ...c.nested];
      // One bounded inventory pass replaces a full list scan for every depth.
      const owners = new Map<string, Fields | null>();
      for (const l of model.lists) {
        if (!isRecord(l) || l.isCell !== true) continue;
        const key = `${l.sectionIndex}:${l.hostListId}:${l.hostPara}:${l.controlIndex}:${l.cellIndex}`;
        owners.set(key, owners.has(key) ? null : l);
      }
      let host = 0, hostParagraph = c.parentParagraph;
      for (let depth = 0; depth < levels.length; depth++) {
        const level = levels[depth]!;
        const list = owners.get(`${at.section}:${host}:${hostParagraph}:${level.control}:${level.cell}`);
        if (!isRecord(list) || !isIndex(list.listId) || list.listId < 2 || !isIndex(list.paraCount)
          || !isIndex(list.cellCount) || level.cell >= list.cellCount || level.cellParagraph >= list.paraCount) return false;
        const prefix: CellRef = { ...c, nested: c.nested.slice(0, depth) };
        if (depth === 0) delete prefix.nested;
        const size = json(this.doc.getTableDimensionsByPath!(at.section, c.parentParagraph, pathJson(prefix)));
        if (!isRecord(size) || size.cellCount !== list.cellCount) return false;
        if (this.doc.getCellParagraphCountByPath!(at.section, c.parentParagraph, pathJson(prefix)) !== list.paraCount) return false;
        host = list.listId; hostParagraph = level.cellParagraph;
      }
      return true;
    } catch { return false; }
  }

  paragraphCount(at: DocPosition): number {
    const c = at.cell;
    if (c?.nested) return this.doc.getCellParagraphCountByPath!(at.section, c.parentParagraph, pathJson(c));
    return c ? this.doc.getCellParagraphCount(at.section, c.parentParagraph, c.control, c.cell) : this.doc.getParagraphCount(at.section);
  }

  paragraphLength(at: DocPosition): number {
    const c = at.cell;
    if (c?.nested) return this.doc.getCellParagraphLengthByPath!(at.section, c.parentParagraph, pathJson(c));
    return c
      ? this.doc.getCellParagraphLength(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph)
      : this.doc.getParagraphLength(at.section, at.paragraph);
  }

  caret(at: DocPosition): CaretRect | null {
    const c = at.cell;
    try {
      const rect = parseCaretRect(json(
        c?.nested ? (this.doc.getCursorRectByPathNear
          ? this.doc.getCursorRectByPathNear(at.section, c.parentParagraph, pathJson(c), at.offset, this.caretPageHint)
          : this.doc.getCursorRectByPath!(at.section, c.parentParagraph, pathJson(c), at.offset))
        : c
          ? this.doc.getCursorRectInCell(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset)
          : this.doc.getCursorRect(at.section, at.paragraph, at.offset),
      ));
      if (rect) this.caretPageHint = rect.page;
      return rect;
    } catch {
      return null;
    }
  }

  /** Rendered line boundaries in the explicitly owned paragraph, including nested cells. */
  line(at: DocPosition): { start: number; end: number } | null {
    const c = at.cell;
    try {
      let value = json(
        c?.nested ? this.doc.getLineInfoByPath!(at.section, c.parentParagraph, pathJson(c), at.offset) : c
          ? this.doc.getLineInfoInCell(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset)
          : this.doc.getLineInfo(at.section, at.paragraph, at.offset),
      );
      if (!isRecord(value) || !isIndex(value.charStart) || !isIndex(value.charEnd)) return null;
      // The path renderer gives a soft-wrap boundary to the preceding run.
      // Match that visual affinity instead of making Home after End jump lines.
      // Forced breaks remain on the next line (the caret rectangles differ).
      if (c?.nested && at.offset > 0 && value.charStart === at.offset) {
        const here = this.caret(at), previous = this.caret({ ...at, offset: at.offset - 1 });
        if (here && previous && here.page === previous.page && Math.abs(here.y - previous.y) < 0.1) {
          value = json(this.doc.getLineInfoByPath!(at.section, c.parentParagraph, pathJson(c), at.offset - 1));
          if (!isRecord(value) || !isIndex(value.charStart) || !isIndex(value.charEnd)) return null;
        }
      }
      return { start: value.charStart as number, end: value.charEnd as number };
    } catch {
      return null;
    }
  }

  /** 위·아래 줄로 이동한 위치와 유지할 가로 좌표. 같은 문맥을 벗어나면 null. */
  vertical(at: DocPosition, delta: number, preferredX: number): { position: DocPosition; preferredX: number } | null {
    const c = at.cell;
    try {
      const value = json(c?.nested
        ? this.doc.moveVerticalByPath!(at.section, c.parentParagraph, pathJson(c), at.offset, delta, preferredX)
        : this.doc.moveVertical(
        at.section, at.paragraph, at.offset, delta, preferredX,
        c ? c.parentParagraph : NO_CELL, c ? c.control : 0, c ? c.cell : 0, c ? c.cellParagraph : 0,
      ));
      const position = parsePosition(value);
      if (!position || !isRecord(value) || !isNumber(value.preferredX)) return null;
      return { position, preferredX: value.preferredX };
    } catch {
      return null;
    }
  }

  selection(from: DocPosition, to: DocPosition): PageRect[] {
    const c = from.cell;
    try {
      return parseSelectionRects(json(
        c?.nested ? this.doc.getSelectionRectsInCellByPath!(from.section, c.parentParagraph, pathJson(c),
          paragraphOf(from), from.offset, paragraphOf(to), to.offset)
        : c
          ? this.doc.getSelectionRectsInCell(from.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, from.offset, to.cell!.cellParagraph, to.offset)
          : this.doc.getSelectionRects(from.section, from.paragraph, from.offset, to.paragraph, to.offset),
      )) ?? [];
    } catch {
      return [];
    }
  }

  text(at: DocPosition, count: number): string {
    const c = at.cell;
    if (c?.nested) return this.doc.getTextInCellByPath!(at.section, c.parentParagraph, pathJson(c), at.offset, count);
    return c
      ? this.doc.getTextInCell(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset, count)
      : this.doc.getTextRange(at.section, at.paragraph, at.offset, count);
  }

  /** Full text from one coherent body/cell context; verify lengths, never preview/truncate. */
  selectedText(a: DocPosition, b: DocPosition): string | null {
    if (!sameContext(a, b) || compare(a, b) === 0) return null;
    const [from, to] = compare(a, b) < 0 ? [a, b] : [b, a];
    try {
      const start = paragraphOf(from), end = paragraphOf(to);
      // Text APIs omit some nontext controls. Prove the selected paragraphs contain
      // no objects/fields before reading or permitting range deletion.
      if (!this.doc.getControls) return null;
      const raw = this.doc.getControls();
      if (raw.length > 2 * 1024 * 1024) return null;
      const controls: unknown = json(raw);
      if (!Array.isArray(controls) || !controls.every(c => isRecord(c) && isIndex(c.list) && isIndex(c.para) && typeof c.ctrlId === "string")) return null;
      let list = 0, base = 0;
      if (from.cell) {
        if (!this.doc.getCursorModel) return null;
        const modelRaw = this.doc.getCursorModel();
        if (modelRaw.length > 2 * 1024 * 1024) return null;
        const model = json(modelRaw);
        if (!isRecord(model) || !Array.isArray(model.lists)) return null;
        // Walk the explicit path: every level must resolve to exactly one cell list of its host list.
        const c = from.cell;
        let hostParagraph = c.parentParagraph;
        for (const level of [c, ...(c.nested ?? [])]) {
          const matches = model.lists.filter(l => isRecord(l) && l.sectionIndex === from.section && l.hostListId === list
            && l.hostPara === hostParagraph && l.controlIndex === level.control && l.cellIndex === level.cell && l.isCell === true);
          if (matches.length !== 1 || !isRecord(matches[0]) || !isIndex(matches[0].listId) || matches[0].listId < 2) return null;
          list = matches[0].listId; hostParagraph = level.cellParagraph;
        }
      } else {
        for (let section = 0; section < from.section; section++) base += this.doc.getParagraphCount(section);
      }
      if (controls.some(c => c.list === list && c.para >= base + start && c.para <= base + end
        && c.ctrlId !== "secd" && c.ctrlId !== "cold")) return null;
      if (end >= this.paragraphCount(from) || end - start > MAX_CLIPBOARD_CHARS) return null;
      const parts: string[] = [];
      let count = 0;
      for (let p = start; p <= end; p++) {
        const at = withParagraph(from, p, p === start ? from.offset : 0);
        const length = this.paragraphLength(at);
        const until = p === end ? to.offset : length;
        if (!Number.isSafeInteger(length) || length < 0 || until > length || at.offset > until || at.offset < 0) return null;
        count += until - at.offset + (p > start ? 1 : 0);
        if (count > MAX_CLIPBOARD_CHARS) return null;
        const text = this.text(at, until - at.offset);
        if (charCount(text) !== until - at.offset || !validClipboardText(text)) return null;
        parts.push(text);
      }
      const result = parts.join("\n");
      return result || null;
    } catch { return null; }
  }

  insert(at: DocPosition, text: string): void {
    const c = at.cell;
    if (c?.nested) this.nestedResult(this.doc.insertTextInCellByPath!(at.section, c.parentParagraph, pathJson(c), at.offset, text));
    else if (c) this.doc.insertTextInCell(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset, text);
    else this.doc.insertText(at.section, at.paragraph, at.offset, text);
  }

  /** A nested edit must report success explicitly: a path the engine did not resolve never counts as an edit. */
  private nestedResult(raw: string): void {
    const value = json(raw);
    if (!isRecord(value) || value.ok !== true) throw new Error("nested cell edit rejected");
  }

  delete(at: DocPosition, count: number): void {
    const c = at.cell;
    if (c?.nested) this.nestedResult(this.doc.deleteTextInCellByPath!(at.section, c.parentParagraph, pathJson(c), at.offset, count));
    else if (c) this.doc.deleteTextInCell(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset, count);
    else this.doc.deleteText(at.section, at.paragraph, at.offset, count);
  }

  deleteRange(from: DocPosition, to: DocPosition): void {
    const c = from.cell;
    if (c?.nested) this.nestedResult(this.doc.deleteRangeInCellByPath!(from.section, c.parentParagraph, pathJson(c),
      paragraphOf(from), from.offset, paragraphOf(to), to.offset));
    else if (c) this.doc.deleteRangeInCell(from.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, from.offset, to.cell!.cellParagraph, to.offset);
    else this.doc.deleteRange(from.section, from.paragraph, from.offset, to.paragraph, to.offset);
  }

  /**
   * 같은 문맥(본문 또는 한 셀)의 [from, to) 범위에 글자 서식을 적용한다. 문단마다 그 문단 안의 범위만 넘긴다(빈 범위는 건너뜀).
   * 엔진에 서식 함수가 없으면 아무것도 바꾸기 전에 던진다.
   */
  format(from: DocPosition, to: DocPosition, props: string): void {
    const c = from.cell;
    if (c?.nested ? !this.doc.applyCharFormatInCellByPath : c ? !this.doc.applyCharFormatInCell : !this.doc.applyCharFormat) throw new Error("char format unavailable");
    const first = paragraphOf(from), last = paragraphOf(to);
    for (let paragraph = first; paragraph <= last; paragraph += 1) {
      const at = withParagraph(from, paragraph, 0);
      const start = paragraph === first ? from.offset : 0;
      const end = paragraph === last ? to.offset : this.paragraphLength(at);
      if (end <= start) continue;
      const result = json(c?.nested
        ? this.doc.applyCharFormatInCellByPath!(from.section, c.parentParagraph, pathJson(c, paragraph), start, end, props)
        : c ? this.doc.applyCharFormatInCell!(from.section, c.parentParagraph, c.control, c.cell, paragraph, start, end, props)
        : this.doc.applyCharFormat!(from.section, paragraph, start, end, props));
      if (!isRecord(result) || result.ok !== true) throw new Error("char format rejected");
    }
    this.compactCharShapes();
  }

  /**
   * 같은 범위를 이어 바꾸면 남는 중간 글자 모양(이번 세션에 덧붙였고 아무도 가리키지 않는 것)을 엔진이 지우게 한다(T012 Stage 5).
   * 서식 변경과 같은 실행 취소 단계 안에서 부른다(기록은 문서 스냅숏이라 되돌리면 정리 전 표로 돌아감). 엔진이 정리를 거절
   * (`skipped`)하면 아무것도 바뀌지 않고 저장 검사가 판정한다. 응답이 계약과 다르면 엔진 상태를 알 수 없으므로 던진다.
   */
  private compactCharShapes(): void {
    if (this.charShapeBaseline === null || !this.doc.compactAppendedCharShapes) return;
    // An older history snapshot can have a shorter table. Its IDs still belong
    // to that snapshot; do not compact or turn a normal Undo into an engine error.
    // The save service remains authoritative if that snapshot predates publication.
    const baseline = Math.max(this.charShapeBaseline, this.publishingCharShapes ?? 0);
    const count = this.doc.charShapeCount?.();
    if (isIndex(count) && count < baseline) return;
    const value = json(this.doc.compactAppendedCharShapes(baseline));
    if (!isRecord(value) || Object.keys(value).sort().join(",") !== "after,before,ok,skipped"
      || value.ok !== true || !isIndex(value.before) || !isIndex(value.after)
      || (value.after as number) > (value.before as number) || (value.after as number) < baseline
      || !(value.skipped === null || value.skipped === "dangling" || value.skipped === "docinfo-reference")
      || (value.skipped !== null && value.before !== value.after)) {
      throw new Error("char shape compaction response invalid");
    }
  }

  /** Formatting has a separate contract from clipboard extraction: native proof
   * excludes selected control slots, without refusing objects outside the range.
   * Keep the existing scalar budget; additionally bound query/response complexity. */
  formatSelection(from: DocPosition, to: DocPosition): {
    state: Record<"bold" | "italic" | "underline" | "strikethrough", boolean>;
  } | null {
    try {
      const valid = (at: DocPosition) => [at.section, at.paragraph, at.offset,
        ...(at.cell ? [at.cell.parentParagraph, at.cell.control, at.cell.cell, at.cell.cellParagraph] : [])].every(isIndex)
        && (!at.cell || (at.paragraph === at.cell.parentParagraph && this.ownsNestedCell(at)));
      if (!valid(from) || !valid(to) || !sameContext(from, to) || compare(from, to) >= 0
        || !(from.cell?.nested ? this.doc.getFormattingRunsByPath && this.doc.applyCharFormatInCellByPath
          : this.doc.getFormattingRuns && (from.cell ? this.doc.applyCharFormatInCell : this.doc.applyCharFormat))) return null;
      const first = paragraphOf(from), last = paragraphOf(to);
      if (last - first >= 4096 || last >= this.paragraphCount(from)) return null;
      let count = 0, runCount = 0, mask = 15;
      for (let p = first; p <= last; p++) {
        const at = withParagraph(from, p, 0), c = from.cell;
        const length = this.paragraphLength(at), start = p === first ? from.offset : 0;
        const end = p === last ? to.offset : length;
        if (!isIndex(length) || start > end || end > length) return null;
        count += end - start + (p > first ? 1 : 0);
        if (count > MAX_CLIPBOARD_CHARS) return null;
        // The exclusive final paragraph at offset zero is not selected.
        if (p === last && start === end) continue;
        const raw = c?.nested
          ? this.doc.getFormattingRunsByPath!(from.section, c.parentParagraph, pathJson(c, p), start, end)
          : this.doc.getFormattingRuns!(from.section, c ? c.parentParagraph : p,
            c?.control ?? NO_CELL, c?.cell ?? 0, c ? p : 0, start, end);
        if (raw.length > 4 * 1024 * 1024) return null;
        const value = json(raw);
        if (!isRecord(value) || value.length !== length || !Array.isArray(value.runs)) return null;
        let next = start;
        for (const run of value.runs) {
          if (!Array.isArray(run) || run.length !== 3) return null;
          const [a, b, flags] = run as unknown[];
          if (!isIndex(a) || !isIndex(b) || !isIndex(flags)
            || a !== next || b <= next || b > end || flags > 15 || ++runCount > 65_536) return null;
          next = b; mask &= flags;
        }
        if (next !== end) return null;
      }
      return runCount ? { state: { bold: !!(mask & 1), italic: !!(mask & 2), underline: !!(mask & 4), strikethrough: !!(mask & 8) } } : null;
    } catch { return null; }
  }

  /** The session may reuse only its current epoch/model/selection-owned proof.
   * Native enabling preserves decoration variants, so one call per paragraph is
   * enough even for mixed selections. Compaction runs once after the whole edit. */
  prepareFlag(from: DocPosition, to: DocPosition, flag: "bold" | "italic" | "underline" | "strikethrough",
    selection = this.formatSelection(from, to)) {
    if (!selection) return null;
    const props = JSON.stringify({ [flag]: !selection.state[flag] });
    return () => this.format(from, to, props);
  }

  /** 위치 글자의 서식(굵게·기울임·밑줄·취소선). 읽을 수 없으면 null. */
  charFormat(at: DocPosition): Record<"bold" | "italic" | "underline" | "strikethrough", boolean> | null {
    const c = at.cell;
    try {
      const value = json(c?.nested
        ? this.doc.getCellCharPropertiesAtByPath!(at.section, c.parentParagraph, pathJson(c), at.offset)
        : c ? this.doc.getCellCharPropertiesAt!(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset)
        : this.doc.getCharPropertiesAt!(at.section, at.paragraph, at.offset));
      if (!isRecord(value)) return null;
      const flags = ["bold", "italic", "underline", "strikethrough"] as const;
      if (!flags.every((flag) => typeof value[flag] === "boolean")) return null;
      return Object.fromEntries(flags.map((flag) => [flag, value[flag] as boolean])) as Record<(typeof flags)[number], boolean>;
    } catch {
      return null;
    }
  }

  /**
   * 위치 글자의 장평·자간(T012, 한글 언어 값 %). 엔진이 7개 언어 정수 배열을 주지 않으면 null. 값이 언어마다 달라도 한글 값을
   * 보인다(적용은 7개 모두 같은 값으로 한다).
   */
  charShape(at: DocPosition): { width: number; spacing: number } | null {
    const c = at.cell;
    try {
      const value = json(c?.nested
        ? this.doc.getCellCharPropertiesAtByPath!(at.section, c.parentParagraph, pathJson(c), at.offset)
        : c ? this.doc.getCellCharPropertiesAt!(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset)
        : this.doc.getCharPropertiesAt!(at.section, at.paragraph, at.offset));
      if (!isRecord(value)) return null;
      const seven = (array: unknown) => Array.isArray(array) && array.length === 7 && array.every((n) => Number.isSafeInteger(n));
      if (!seven(value.ratios) || !seven(value.spacings)) return null;
      return { width: (value.ratios as number[])[0]!, spacing: (value.spacings as number[])[0]! };
    } catch {
      return null;
    }
  }

  /**
   * 같은 문맥의 [from, to)에 장평(`ratios`) 또는 자간(`spacings`)을 7개 언어 모두 `percent`로 적용한다(T012). 엔진 호출 직전에 범위를
   * 다시 검사한다: rhwp는 범위 밖·정수가 아닌 원소를 말없이 버리고 그 변경을 무시하므로(`json_u8_array`) 여기서 던진다(아무것도
   * 바꾸지 않음). 나머지 글자 모양 속성은 엔진이 원래 모양을 복제해 그대로 둔다.
   */
  charShapeFormat(from: DocPosition, to: DocPosition, key: "ratios" | "spacings", percent: number): void {
    const [min, max] = key === "ratios" ? [50, 200] : [-50, 50];
    if (!Number.isSafeInteger(percent) || percent < min || percent > max) throw new Error("char shape value out of range");
    this.format(from, to, JSON.stringify({ [key]: Array.from({ length: 7 }, () => percent) }));
  }

  /** 커서가 있는 셀의 논리 좌표와 표 크기(T012). 셀 밖이거나 엔진이 알려 주지 않으면 null. */
  tableCell(at: DocPosition): { row: number; col: number; rows: number; cols: number; rowSpan: number; colSpan: number } | null {
    const c = at.cell;
    if (!c || !this.doc.getCellInfo) return null;
    try {
      const info = json(c.nested ? this.doc.getCellInfoByPath!(at.section, c.parentParagraph, pathJson(c))
        : this.doc.getCellInfo(at.section, c.parentParagraph, c.control, c.cell));
      const size = json(c.nested ? this.doc.getTableDimensionsByPath!(at.section, c.parentParagraph, pathJson(c))
        : this.doc.getTableDimensions(at.section, c.parentParagraph, c.control));
      if (!isRecord(info) || !isRecord(size)) return null;
      const { row, col, rowSpan, colSpan } = info;
      const { rowCount, colCount } = size;
      if (![row, col, rowCount, colCount].every(isIndex) || !isIndex(rowSpan) || !isIndex(colSpan)) return null;
      if ((row as number) >= (rowCount as number) || (col as number) >= (colCount as number)) return null;
      return {
        row: row as number, col: col as number, rows: rowCount as number, cols: colCount as number,
        rowSpan: rowSpan as number, colSpan: colSpan as number,
      };
    } catch {
      return null;
    }
  }

  /** Exact cell ownership at every path level; unfamiliar fields are never interpreted or rewritten. */
  existingFormula(at: DocPosition): string | null {
    const cell = at.cell;
    if (!cell || !this.doc.getFieldList) return null;
    if (cell.nested && !this.doc.validateTableFormulaFieldByPath) return null;
    try {
      const fields: unknown = json(this.doc.getFieldList());
      if (!Array.isArray(fields)) return null;
      const levels = [cell, ...(cell.nested ?? [])];
      const matches = fields.filter((field: unknown) => {
        if (!isRecord(field) || !isRecord(field.location) || !Array.isArray(field.location.path)) return false;
        const location = field.location, path = location.path as unknown[];
        return location.sectionIndex === at.section && location.paraIndex === cell.parentParagraph && path.length === levels.length
          && levels.every((level, i) => {
            const part = path[i];
            return isRecord(part) && part.type === "cell" && part.controlIndex === level.control && part.cellIndex === level.cell
              && part.paraIndex === level.cellParagraph;
          });
      });
      if (matches.length !== 1) return null;
      const field: unknown = matches[0];
      if (!isRecord(field) || field.fieldType !== "formula" || typeof field.command !== "string") return null;
      const match = cachedFormula(field.command);
      return match && match.value === field.value && Number.isFinite(Number(match.value)) ? match.expression : null;
    } catch { return null; }
  }

  /** Read-only engine preparation. A normal refusal opens no history transaction. */
  prepareFormula(at: DocPosition, row: number, col: number, formula: string): FormulaFieldResult | null {
    const c = at.cell;
    if (!c || (c.nested ? !this.doc.validateTableFormulaFieldByPath || !this.doc.insertTableFormulaFieldByPath
      : !this.doc.validateTableFormulaField || !this.doc.insertTableFormulaField)) return null;
    if (tableFormulaSafety(this.doc, at, formula) !== "safe") return null;
    const value = json(c.nested ? this.doc.validateTableFormulaFieldByPath!(at.section, c.parentParagraph, pathJson(c), row, col, formula)
      : this.doc.validateTableFormulaField!(at.section, c.parentParagraph, c.control, row, col, formula));
    if (isRecord(value) && Object.keys(value).join(",") === "ok" && value.ok === false) return null;
    return formulaFieldResult(value, formula);
  }

  insertFormula(at: DocPosition, row: number, col: number, formula: string, expected: FormulaFieldResult): void {
    const c = at.cell;
    if (!c || (c.nested ? !this.doc.insertTableFormulaFieldByPath : !this.doc.insertTableFormulaField)) throw new Error("formula field unavailable");
    const value = formulaFieldResult(json(c.nested ? this.doc.insertTableFormulaFieldByPath!(at.section, c.parentParagraph, pathJson(c), row, col, formula)
      : this.doc.insertTableFormulaField!(at.section, c.parentParagraph, c.control, row, col, formula)), formula);
    if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error("formula preparation changed");
  }

  /**
   * 커서 셀 기준의 표 계산식을 읽기 전용으로 계산한다(T012, `writeResult=false` — 문서를 바꾸지 않음). 결과가 유한한 수가 아니거나
   * 엔진이 계산 오류를 내면 null(WASM trap은 던짐). 결과 문자열은 계산 값일 뿐 표가 바뀌었다는 근거가 아니다.
   */
  evaluateFormula(at: DocPosition, row: number, col: number, formula: string): number | null {
    const c = at.cell;
    if (!c || (c.nested ? !this.doc.evaluateTableFormulaByPath : !this.doc.evaluateTableFormula)) return null;
    try {
      const value = json(c.nested ? this.doc.evaluateTableFormulaByPath!(at.section, c.parentParagraph, pathJson(c), row, col, formula)
        : this.doc.evaluateTableFormula!(at.section, c.parentParagraph, c.control, row, col, formula, false));
      if (!isRecord(value) || value.ok !== true || !isNumber(value.result)) return null;
      return value.result;
    } catch (error) {
      // 계산 오류(Result Err)는 문서를 바꾸지 않은 실패다. WASM trap은 모듈 상태를 알 수 없으므로 부르는 쪽이 편집을 멈추게 던진다.
      if (typeof WebAssembly !== "undefined" && error instanceof WebAssembly.RuntimeError) throw error;
      return null;
    }
  }

  /** 위치에서 문단을 나눈다(Enter). */
  split(at: DocPosition): void {
    const c = at.cell;
    if (c?.nested) this.nestedResult(this.doc.splitParagraphInCellByPath!(at.section, c.parentParagraph, pathJson(c), at.offset));
    else if (c) this.doc.splitParagraphInCell(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset);
    else this.doc.splitParagraph(at.section, at.paragraph, at.offset);
  }

  /** `paragraph` 문단을 앞 문단에 붙인다. */
  mergeIntoPrevious(at: DocPosition, paragraph: number): void {
    const c = at.cell;
    if (c?.nested) this.nestedResult(this.doc.mergeParagraphInCellByPath!(at.section, c.parentParagraph, pathJson(c, paragraph)));
    else if (c) this.doc.mergeParagraphInCell(at.section, c.parentParagraph, c.control, c.cell, paragraph);
    else this.doc.mergeParagraph(at.section, paragraph);
  }

  /** 표의 셀 수(병합 셀 포함한 실제 셀 개수). */
  cellCount(at: DocPosition): number | null {
    const c = at.cell;
    if (!c) return null;
    try {
      const value = json(c.nested ? this.doc.getTableDimensionsByPath!(at.section, c.parentParagraph, pathJson(c))
        : this.doc.getTableDimensions(at.section, c.parentParagraph, c.control));
      if (!isRecord(value)) return null;
      if (isIndex(value.cellCount)) return value.cellCount;
      return isIndex(value.rowCount) && isIndex(value.colCount) ? value.rowCount * value.colCount : null;
    } catch {
      return null;
    }
  }
}
