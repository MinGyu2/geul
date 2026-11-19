import { paragraphFieldMap } from "./fieldOwnership";
import { MAX_CLIPBOARD_CHARS, validClipboardText } from "../../../commands/clipboard";
// rhwp 문서 위치와 본문·표 셀 API 선택(T007).
//
// 위치는 (구역, 문단, 글자 오프셋)이고, 표 셀 안이면 셀 경로(부모 문단, 컨트롤, 셀, 셀 문단)를 더한다. 같은 위치를
// 다루는 호출(커서 사각형·삽입·삭제·문단 나누기·줄 정보)은 모두 여기서 본문용/셀용 API를 고르므로, 렌더·hit test·
// 편집이 서로 다른 좌표를 쓰지 않는다. 글자 오프셋은 rhwp의 글자(char, 유니코드 스칼라) 단위다.
// 엔진이 돌려주는 JSON은 신뢰 경계 안이지만 모양을 확인하고, 맞지 않으면 null로 다룬다.
import { cachedFormula, publicationFormulas, tableFormulaSafety, validatePublicationFormulaCaches } from "./formulaDependencies";
import type { CharShapePrefix, RhwpDocument } from "./rhwpModule";
import { documentFontTable, resolveExistingFontIds } from "./rhwpFonts";

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
  /** Top-level drawing text story, addressed through RHWP’s paragraph-in-cell API. */
  textBox?: true;
  caption?: true;
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

export interface FormulaFieldResult { changed: boolean; fieldId: number; text: string; command: string; controlIndex: number; start: number; end: number }
function formulaFieldResult(value: unknown, formula: string): FormulaFieldResult {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "changed,command,controlIndex,end,fieldId,ok,start,text"
    || !isIndex(value.controlIndex) || !isIndex(value.start) || !isIndex(value.end) || value.end < value.start
    || value.ok !== true || typeof value.changed !== "boolean" || !isIndex(value.fieldId)
    || value.fieldId === 0 || value.fieldId > 0xffffffff || typeof value.text !== "string" || !Number.isFinite(Number(value.text))
    || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.text) || value.command !== `${formula.trim()}??%g,;;${value.text}`) throw new Error("formula field response invalid");
  return { changed: value.changed, fieldId: value.fieldId, text: value.text, command: value.command as string, controlIndex: value.controlIndex, start: value.start, end: value.end };
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
export function parsePosition(value: unknown, allowTextBox = false): DocPosition | null {
  if (!isRecord(value)) return null;
  const { sectionIndex, paragraphIndex, charOffset, parentParaIndex, controlIndex, cellIndex, cellParaIndex, isTextBox } = value;
  if (!isIndex(sectionIndex) || !isIndex(paragraphIndex) || !isIndex(charOffset)) return null;
  if (paragraphIndex >= 0xffffff00) return null;
  if (parentParaIndex === undefined) {
    if (isTextBox === true) return null;
    // 표 셀 안의 개체(그림 등)를 가리키는 결과는 셀 경로를 다른 모양(`cellPath: [[컨트롤, 셀, 셀 문단]]`, `innerControlIdx`)으로만 준다
    // (고정 rhwp 실측, 여러 구역 문서 예제). 본문 위치로 읽으면 구역 첫 문단으로 커서가 튄다 — 이 모양은 다루지 않는다.
    if (value.cellPath !== undefined || value.innerControlIdx !== undefined) return null;
    return { section: sectionIndex, paragraph: paragraphIndex, offset: charOffset };
  }
  if (isTextBox === true && (!allowTextBox || cellIndex !== 0)) return null;
  if (!isIndex(parentParaIndex) || !isIndex(controlIndex) || !isIndex(cellIndex) || !isIndex(cellParaIndex)) return null;
  const cell: CellRef = { parentParagraph: parentParaIndex, control: controlIndex, cell: cellIndex, cellParagraph: cellParaIndex, ...(isTextBox === true ? { textBox: true } : {}) };
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
    if (levels.length > 1) {
      if (cell.textBox) return null;
      cell.nested = levels.slice(1);
    }
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
  if (x.textBox !== y.textBox || x.caption !== y.caption || x.parentParagraph !== y.parentParagraph || x.control !== y.control || x.cell !== y.cell || nx.length !== ny.length) return false;
  if (nx.length && x.cellParagraph !== y.cellParagraph) return false;
  return nx.every((level, i) => level.control === ny[i]!.control && level.cell === ny[i]!.cell
    && (i === nx.length - 1 || level.cellParagraph === ny[i]!.cellParagraph));
}

/** Same explicitly owned table; only the innermost cell may differ. */
export function sameTable(a: DocPosition, b: DocPosition): boolean {
  return !!a.cell && !!b.cell && !a.cell.textBox && !b.cell.textBox && !a.cell.caption && !b.cell.caption && sameContext(withCell(a, innermost(b.cell).cell), b);
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
  return c ? `${at.section}:${c.parentParagraph}${c.textBox ? ":textbox" : ""}/${[c, ...(c.nested ?? [])].map(l => `${l.control}.${l.cell}.${l.cellParagraph}`).join(">")}`
    : `${at.section}:body:${at.paragraph}`;
}

const NO_CELL = 0xffffffff; // u32::MAX: rhwp가 본문을 뜻하는 값

/** 위치에 맞는 본문/셀 API를 부른다. 편집 함수는 실패하면 예외를 던진다(엔진 오류). */
export class RhwpText {
  /** Loaded definitions and definitions already published must keep their IDs. */
  private charShapeBaseline: number | null;
  private publishingCharShapes: number | null = null;
  private readonly originalCharShapeCount: number | null;
  private readonly originalFontCounts: readonly number[] | null;
  private publishedPrefix: CharShapePrefix | null = null;
  private publishingPrefix: CharShapePrefix | null = null;
  private caretPageHint = 0;
  private readonly formulaBaseline: ReturnType<typeof publicationFormulas> | null;

  constructor(private readonly doc: RhwpDocument) {
    try { this.formulaBaseline = publicationFormulas(doc); } catch { this.formulaBaseline = null; }
    const count = doc.charShapeCount?.();
    this.charShapeBaseline = Number.isSafeInteger(count) && (count as number) >= 0 ? (count as number) : null;
    this.originalCharShapeCount = this.charShapeBaseline;
    this.originalFontCounts = documentFontTable(doc)?.languages.map(slot => slot.fonts.length) ?? null;
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
    const prefix = this.hasFontOwnership ? this.doc.capturePublishingFontShapePrefix!(exported)
      : this.doc.capturePublishingCharShapePrefix(exported);
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
    const result = json(this.doc.reconcileFontShapePrefix && this.originalFontCounts
      ? this.doc.reconcileFontShapePrefix(prefix, this.originalCharShapeCount, JSON.stringify(this.originalFontCounts))
      : this.doc.reconcileCharShapePrefix!(prefix, this.originalCharShapeCount));
    if (!isRecord(result) || Object.keys(result).join(",") !== "ok" || result.ok !== true)
      throw new Error("char shape reconciliation response invalid");
  }

  /** Remove unused, unpublished definitions left by a failed in-flight save or historical branch. */
  prepareExport(): void {
    validatePublicationFormulaCaches(this.doc, this.formulaBaseline);
    this.compactCharShapes();
  }

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

  /** An existing plain paragraph in a top-level, unlocked drawing text box. */
  ownsTextBox(at: DocPosition): boolean {
    const c = at.cell, doc = this.doc;
    if (!c?.textBox || c.nested || c.cell !== 0 || !isIndex(c.cellParagraph)
      || !doc.getControls || !doc.getCursorModel || !doc.getShapeProperties) return false;
    try {
      const rawControls = doc.getControls(), rawLists = doc.getCursorModel();
      if (rawControls.length + rawLists.length > 8 * 1024 * 1024) return false;
      const controls = json(rawControls), model = json(rawLists);
      if (!Array.isArray(controls) || !controls.every(isRecord) || !isRecord(model) || !Array.isArray(model.lists)) return false;
      const lists = model.lists.filter(isRecord);
      const owners = lists.filter(list => list.hostListId === 0 && list.sectionIndex === at.section
        && list.hostPara === c.parentParagraph && list.controlIndex === c.control);
      if (owners.length !== 1) return false;
      const list = owners[0]!;
      if (list.isCell !== false || list.cellIndex !== 0 || !isIndex(list.paraCount)
        || list.paraCount > 64 || c.cellParagraph >= list.paraCount
        || !isIndex(list.listId) || list.listId < 2 || controls.some(ctrl => ctrl.list === list.listId)
        || lists.some(child => child.hostListId === list.listId)) return false;
      let paragraph = c.parentParagraph;
      for (let section = 0; section < at.section; section++) paragraph += doc.getParagraphCount(section);
      const hosts = controls.filter(ctrl => ctrl.list === 0 && ctrl.para === paragraph && ctrl.controlIndex === c.control);
      const host = hosts[0], props = host?.props;
      if (hosts.length !== 1 || host?.ctrlId !== "gso" || !isRecord(props) || props.Lock !== 0) return false;
      const shape = json(doc.getShapeProperties(at.section, c.parentParagraph, c.control));
      return isRecord(shape) && shape.hasCaption === false
        && ["Top", "Center", "Bottom"].includes(String(shape.tbVerticalAlign))
        && doc.getCellParagraphCount(at.section, c.parentParagraph, c.control, 0) === list.paraCount;
    } catch { return false; }
  }

  /** Pictures (`cell === 0`) and shapes (`cell === 65534`) expose their captions through cell APIs.
   * Verify root GSO ownership, lock state, and caption structure before treating a hit as editable. */
  ownsPictureCaption(at: DocPosition): boolean {
    const c = at.cell, doc = this.doc;
    if (!c || c.nested || c.textBox || !isIndex(at.section) || !isIndex(at.offset) || !doc.getControls) return false;
    if (doc.getSectionCount ? at.section >= doc.getSectionCount() : at.section !== 0) return false;
    try {
      let globalPara = c.parentParagraph;
      for (let section = 0; section < at.section; section++) globalPara += doc.getParagraphCount(section);
      const controls = json(doc.getControls());
      if (!Array.isArray(controls) || !controls.every(isRecord)) return false;
      const owners = controls.filter(owner => owner.list === 0 && owner.para === globalPara && owner.controlIndex === c.control);
      const owner = owners[0];
      if (owners.length !== 1 || owner?.ctrlId !== "gso" || !isRecord(owner.props) || owner.props.Lock !== 0) return false;
      const address = [at.section, c.parentParagraph, c.control] as const;
      if (owner.userDesc === "그림") {
        if (c.cell !== 0 || !doc.getPictureProperties) return false;
        const props = json(doc.getPictureProperties(...address));
        if (!isRecord(props) || props.hasCaption !== true || "externalPath" in props) return false;
      } else if (["사각형", "타원", "직선", "다각형", "곡선"].includes(String(owner.userDesc ?? ""))) {
        if (c.cell !== 65534 || !doc.getShapeProperties) return false;
        const props = json(doc.getShapeProperties(...address));
        if (!isRecord(props) || props.hasCaption !== true || props.tbVerticalAlign !== undefined) return false;
      } else {
        return false;
      }
      const paraCount = doc.getCellParagraphCount(...address, c.cell);
      return Number.isSafeInteger(paraCount) && paraCount >= 1 && paraCount <= 64
        && isIndex(c.cellParagraph) && c.cellParagraph < paraCount
        && at.offset <= doc.getCellParagraphLength(...address, c.cell, c.cellParagraph)
        && this.captionControlSlots(at) !== null;
    } catch { return false; }
  }

  /** Owned picture/shape-caption automatic-number placeholder indices for `at.cell.cellParagraph`, or null when unprovable/unsupported. */
  private captionControlSlots(at: DocPosition): number[] | null {
    const c = at.cell, doc = this.doc;
    if (!c || c.nested || c.textBox || (c.cell !== 0 && c.cell !== 65534)
      || !doc.getControls || !doc.getCursorModel) return null;
    try {
      const expectedListCell = c.cell === 65534 ? 1 : 0;
      const rawControls = doc.getControls(), rawLists = doc.getCursorModel();
      if (rawControls.length + rawLists.length > 8 * 1024 * 1024) return null;
      const controls = json(rawControls), model = json(rawLists);
      if (!Array.isArray(controls) || !controls.every(isRecord) || !isRecord(model) || !Array.isArray(model.lists)) return null;
      const owners = model.lists.filter(list => isRecord(list) && list.isCell === false && list.hostListId === 0
        && list.sectionIndex === at.section && list.hostPara === c.parentParagraph && list.controlIndex === c.control
        && list.cellIndex === expectedListCell);
      if (owners.length !== 1) return null;
      const list = owners[0]!;
      if (!isIndex(list.listId) || list.listId < 2 || !Number.isSafeInteger(list.paraCount)
        || (list.paraCount as number) < 1 || (list.paraCount as number) > 64
        || !isIndex(c.cellParagraph) || c.cellParagraph >= (list.paraCount as number)
        || model.lists.some(child => isRecord(child) && child.hostListId === list.listId)) return null;
      const paraCount = list.paraCount as number;
      if (doc.getCellParagraphCount(at.section, c.parentParagraph, c.control, c.cell) !== paraCount) return null;
      const inList = controls.filter(ctrl => ctrl.list === list.listId)
        .sort((a, b) => Number(a.para) - Number(b.para) || Number(a.controlIndex) - Number(b.controlIndex));
      if (inList.length > 1) return null;
      const perPara = new Map<number, number[]>();
      const charsCache = new Map<number, string[]>();
      const atnoCountPerPara = new Map<number, number>();
      for (const ctrl of inList) {
        if (!isIndex(ctrl.para) || (ctrl.para as number) >= paraCount
          || ctrl.ctrlId !== "atno" || ctrl.ctrlCh !== 18
          || !isIndex(ctrl.controlIndex) || !isIndex(ctrl.pos)) return null;
        const p = ctrl.para as number;
        let chars = charsCache.get(p);
        if (!chars) {
          const paraLen = doc.getCellParagraphLength(at.section, c.parentParagraph, c.control, c.cell, p);
          if (!isIndex(paraLen)) return null;
          const captionText = doc.getTextInCell(at.section, c.parentParagraph, c.control, c.cell, p, 0, paraLen);
          if (typeof captionText !== "string") return null;
          chars = Array.from(captionText);
          charsCache.set(p, chars);
        }
        const seen = atnoCountPerPara.get(p) ?? 0;
        const slot = (ctrl.pos as number) - (ctrl.controlIndex as number) * 8 + seen;
        if (slot < 0 || slot >= chars.length || chars[slot] !== " ") return null;
        const slots = perPara.get(p) ?? [];
        slots.push(slot);
        perPara.set(p, slots);
        atnoCountPerPara.set(p, seen + 1);
      }
      return perPara.get(c.cellParagraph) ?? [];
    } catch { return null; }
  }

  paragraphCount(at: DocPosition): number {
    const c = at.cell;
    if (c?.nested) return this.doc.getCellParagraphCountByPath!(at.section, c.parentParagraph, pathJson(c));
    return c ? this.doc.getCellParagraphCount(at.section, c.parentParagraph, c.control, c.cell) : this.doc.getParagraphCount(at.section);
  }

  /** Legacy cell APIs use plain-text offsets; new inline pictures use logical caret slots. */
  private inlineCell(at: DocPosition, count = 0): { length: number; textOffset: number; textCount: number; containsControl: boolean } | null {
    const c = at.cell;
    if (!c || c.textBox || c.caption || !this.doc.getCellInlineContextByPath) return null;
    const value = json(this.doc.getCellInlineContextByPath(at.section, c.parentParagraph, pathJson(c), at.offset, count));
    if (!isRecord(value) || typeof value.hasPictures !== "boolean" || !isIndex(value.length)
      || !isIndex(value.textOffset) || !isIndex(value.textCount) || typeof value.containsControl !== "boolean") throw new Error("invalid cell inline context");
    return value.hasPictures ? value as { length: number; textOffset: number; textCount: number; containsControl: boolean } : null;
  }

  /** One range proof shared by formatting eligibility and application. All offsets are scalars. */
  private textRange(at: DocPosition, count: number): { start: number; end: number; length: number } {
    if (!isIndex(at.offset) || !isIndex(count) || (at.cell && !this.ownsNestedCell(at))) throw new Error("invalid text owner/range");
    const inline = this.inlineCell(at, count), c = at.cell;
    const length = c?.nested ? this.doc.getCellParagraphLengthByPath!(at.section, c.parentParagraph, pathJson(c))
      : c ? this.doc.getCellParagraphLength(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph)
      : this.doc.getParagraphLength(at.section, at.paragraph);
    const start = inline ? inline.textOffset : at.offset;
    if (!isIndex(length) || at.offset + count > (inline?.length ?? length)
      || (inline && (inline.containsControl || inline.textCount !== count)) || start + count > length)
      throw new Error("unsupported text range");
    return { start, end: start + count, length };
  }

  /** Admission only: unsupported inline slots must never open a mutation/history transaction. */
  canDeleteRange(from: DocPosition, to: DocPosition): boolean {
    if (!sameContext(from, to) || compare(from, to) > 0
      || (from.cell?.textBox && paragraphOf(from) !== paragraphOf(to))) return false;
    if (from.cell?.caption) {
      if (!this.ownsPictureCaption(from) || !this.ownsPictureCaption(to)) return false;
      for (let p = paragraphOf(from); p <= paragraphOf(to); p++) {
        const pAt = withParagraph(from, p, 0);
        const slots = this.captionControlSlots(pAt);
        const pStart = p === paragraphOf(from) ? from.offset : 0;
        const pEnd = p === paragraphOf(to) ? to.offset : this.paragraphLength(pAt);
        if (!slots || slots.some(slot => pStart < slot + 1 && pEnd > slot)) return false;
      }
    }
    try {
      for (let p = paragraphOf(from); p <= paragraphOf(to); p++) {
        const at = withParagraph(from, p, p === paragraphOf(from) ? from.offset : 0);
        if (at.cell) {
          const ranges = this.formulaInventory(at).filter(f => f.fieldType === "formula");
          if (ranges.length && paragraphOf(from) !== paragraphOf(to)) return false;
          const start = p === paragraphOf(from) ? from.offset : 0;
          const end = p === paragraphOf(to) ? to.offset : this.paragraphLength(at);
          if (ranges.some(f => !isIndex(f.startCharIdx) || !isIndex(f.endCharIdx)
            || (start < f.endCharIdx && end > f.startCharIdx))) return false;
        }
        if (!this.inlineCell({ ...at, offset: 0 })) continue;
        // The legacy paragraph join API has no proven inline-control ownership contract.
        if (paragraphOf(from) !== paragraphOf(to)) return false;
        this.textRange(at, to.offset - from.offset);
      }
      return true;
    } catch { return false; }
  }

  paragraphLength(at: DocPosition): number {
    const c = at.cell, inline = this.inlineCell({ ...at, offset: 0 });
    if (inline) return inline.length;
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
      const position = parsePosition(value, c?.textBox);
      if (c?.caption && position?.cell && !position.cell.nested && !position.cell.textBox) {
        position.cell.caption = true;
      }
      if ((c?.textBox || c?.caption) && (!position || !sameContext(at, position))) return null;
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
    const inline = this.inlineCell(at, count);
    if (inline) { at = { ...at, offset: inline.textOffset }; count = inline.textCount; }
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
      // Text APIs omit controls. Resolve exact cell ownership before allowing
      // unselected inline pictures; other objects/fields retain the strict refusal.
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
          const expectedCell = c.caption && level.cell === 65534 ? 1 : level.cell;
          const matches = model.lists.filter(l => isRecord(l) && l.sectionIndex === from.section && l.hostListId === list
            && l.hostPara === hostParagraph && l.controlIndex === level.control && l.cellIndex === expectedCell
            && l.isCell === !(c.textBox || c.caption));
          if (matches.length !== 1 || !isRecord(matches[0]) || !isIndex(matches[0].listId) || matches[0].listId < 2) return null;
          list = matches[0].listId; hostParagraph = level.cellParagraph;
        }
      } else {
        for (let section = 0; section < from.section; section++) base += this.doc.getParagraphCount(section);
      }
      if (end >= this.paragraphCount(from) || end - start > MAX_CLIPBOARD_CHARS) return null;
      const parts: string[] = [];
      let count = 0;
      for (let p = start; p <= end; p++) {
        const at = withParagraph(from, p, p === start ? from.offset : 0);
        const length = this.paragraphLength(at);
        const until = p === end ? to.offset : length;
        if (!Number.isSafeInteger(length) || length < 0 || until > length || at.offset > until || at.offset < 0) return null;
        const objects = controls.filter(c => c.list === list && c.para === base + p && c.ctrlId !== "secd" && c.ctrlId !== "cold");
        if (objects.length) {
          if (at.cell?.caption && this.ownsPictureCaption(at) && objects.every(object => object.ctrlId === "atno")) {
            const slots = this.captionControlSlots(at);
            if (!slots || slots.some(slot => at.offset < slot + 1 && until > slot)) return null;
          } else {
            if (!at.cell || !this.inlineCell(at, until - at.offset) || !this.doc.getCellPictureByPath) return null;
            // Only paragraph-owned inline pictures may be outside a plain-text clipboard range.
            for (const object of objects) {
              if (object.ctrlId !== "gso" || !isIndex(object.controlIndex)) return null;
              const levels = [at.cell, ...(at.cell.nested ?? [])];
              const path = pathJson(at.cell), picture = json(this.doc.getCellPictureByPath(at.section, at.cell.parentParagraph, path, object.controlIndex));
              if (!isRecord(picture) || picture.ok !== true || picture.treatAsChar !== true
                || picture.section !== at.section || picture.paraIdx !== at.cell.parentParagraph
                || picture.controlIdx !== object.controlIndex || !Array.isArray(picture.path) || picture.path.length !== levels.length
                || !picture.path.every((level: unknown, i: number) => isRecord(level)
                  && Object.keys(level).sort().join(",") === "cellIndex,cellParaIndex,controlIndex"
                  && level.controlIndex === levels[i]!.control && level.cellIndex === levels[i]!.cell
                  && level.cellParaIndex === levels[i]!.cellParagraph)) return null;
            }
            this.textRange(at, until - at.offset);
            // Native range validation also excludes fields, unknown controls and ambiguous streams.
            if (until > at.offset && !this.formatSelection(at, { ...at, offset: until })) return null;
          }
        }
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

  canInsertText(at: DocPosition): boolean {
    if (!at.cell) return true;
    if (at.cell.caption && !this.captionControlSlots(at)) return false;
    try { return !this.formulaInventory(at).some(f => f.fieldType === "formula" && isIndex(f.startCharIdx)
      && isIndex(f.endCharIdx) && f.startCharIdx < at.offset && at.offset < f.endCharIdx); }
    catch { return false; }
  }

  insert(at: DocPosition, text: string): void {
    const c = at.cell;
    if (c && this.inlineCell(at)) {
      this.nestedResult(this.doc.insertCellInlineTextByPath!(at.section, c.parentParagraph, pathJson(c), at.offset, text));
      return;
    }
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
    const inline = this.inlineCell(at, count);
    if (inline) {
      if (inline.containsControl) throw new Error("inline object selection requires object deletion");
      at = { ...at, offset: inline.textOffset }; count = inline.textCount;
    }
    const c = at.cell;
    if (c?.nested) this.nestedResult(this.doc.deleteTextInCellByPath!(at.section, c.parentParagraph, pathJson(c), at.offset, count));
    else if (c) this.doc.deleteTextInCell(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset, count);
    else this.doc.deleteText(at.section, at.paragraph, at.offset, count);
  }

  deleteRange(from: DocPosition, to: DocPosition): void {
    const c = from.cell;
    if (c && paragraphOf(from) === paragraphOf(to) && this.inlineCell(from, to.offset - from.offset)) {
      this.delete(from, to.offset - from.offset); return;
    }
    if (c) for (let p = paragraphOf(from); p <= paragraphOf(to); p++) {
      if (this.inlineCell(withParagraph(from, p, 0))) throw new Error("cross-paragraph inline object selection unsupported");
    }
    if (c?.textBox || (c?.caption && paragraphOf(from) === paragraphOf(to))) { this.delete(from, to.offset - from.offset); return; }
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
    if (!sameContext(from, to) || compare(from, to) >= 0) throw new Error("invalid formatting range");
    const ranges: { paragraph: number; start: number; end: number }[] = [];
    for (let paragraph = first; paragraph <= last; paragraph += 1) {
      const at = withParagraph(from, paragraph, 0);
      const start = paragraph === first ? from.offset : 0;
      const end = paragraph === last ? to.offset : this.paragraphLength(at);
      if (end <= start) continue;
      const range = this.textRange({ ...at, offset: start }, end - start);
      if (this.inlineCell(at) && !this.formatSelection({ ...at, offset: start }, { ...at, offset: end }))
        throw new Error("inline formatting range not proven");
      ranges.push({ paragraph, start: range.start, end: range.end });
    }
    for (const { paragraph, start, end } of ranges) {
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
    const prefix = this.publishingPrefix ?? this.publishedPrefix;
    if (this.hasFontOwnership && prefix) {
      const result = json(this.doc.compactUnpublishedFonts!(prefix));
      if (!isRecord(result) || Object.keys(result).join(",") !== "ok" || result.ok !== true)
        throw new Error("font compaction response invalid");
    }
  }

  /** Compact appended charShapes/fonts after an external cell paste/clear mutation inside a history step. */
  compactAfterCellMutation(): void {
    this.compactCharShapes();
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
        const range = this.textRange({ ...at, offset: start }, end - start);
        const raw = c?.nested
          ? this.doc.getFormattingRunsByPath!(from.section, c.parentParagraph, pathJson(c, p), range.start, range.end)
          : this.doc.getFormattingRuns!(from.section, c ? c.parentParagraph : p,
            c?.control ?? NO_CELL, c?.cell ?? 0, c ? p : 0, range.start, range.end);
        if (raw.length > 4 * 1024 * 1024) return null;
        const value = json(raw);
        if (!isRecord(value) || value.length !== range.length || !Array.isArray(value.runs)) return null;
        let next = range.start;
        for (const run of value.runs) {
          if (!Array.isArray(run) || run.length !== 3) return null;
          const [a, b, flags] = run as unknown[];
          if (!isIndex(a) || !isIndex(b) || !isIndex(flags)
            || a !== next || b <= next || b > range.end || flags > 15 || ++runCount > 65_536) return null;
          next = b; mask &= flags;
        }
        if (next !== range.end) return null;
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

  /** Stage 1: size/text color/shade/script of the selection. Values are reported only when every selected run uses
   * one character shape (otherwise null = mixed; never inferred from the first character alone). */
  stage1Chars(from: DocPosition, to: DocPosition): {
    size: number | null; color: string | null; highlight: string | null; superscript: boolean | null; subscript: boolean | null;
  } | null {
    const selected = this.selectedFontShapes(from, to);
    if (!selected || selected.samples.size > 256) return selected ? { size: null, color: null, highlight: null, superscript: null, subscript: null } : null;
    // Each property's uniformity is decided independently over every distinct selected character shape:
    // different shapes (fonts, colors…) can still agree on size or script. null = mixed.
    const values: Record<string, unknown>[] = [];
    const c = from.cell;
    for (const { paragraph, offset } of selected.samples.values()) {
      let raw: string;
      try {
        raw = c?.nested ? this.doc.getCellCharPropertiesAtByPath!(from.section, c.parentParagraph, pathJson(c, paragraph), offset)
          : c ? this.doc.getCellCharPropertiesAt!(from.section, c.parentParagraph, c.control, c.cell, paragraph, offset)
          : this.doc.getCharPropertiesAt!(from.section, paragraph, offset);
      } catch { return null; }
      const value = json(raw);
      if (!isRecord(value)) return null;
      values.push(value as Record<string, unknown>);
    }
    const hex = (v: unknown) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v.slice(1).toUpperCase() : null;
    const same = <T,>(read: (v: Record<string, unknown>) => T): T | null => {
      const first = read(values[0]!);
      return values.every(v => read(v) === first) ? first : null;
    };
    const size = same(v => Number.isSafeInteger(v.fontSize) && (v.fontSize as number) > 0 ? (v.fontSize as number) / 100 : -1);
    const shade = same(v => typeof v.shadeColor === "string" ? (v.shadeColor === "none" ? "none" : hex(v.shadeColor) ?? "?") : "?");
    const script = (key: string) => same(v => v[key] === true);
    return {
      size: size === -1 ? null : size, color: same(v => hex(v.textColor)),
      // "none" = no shading (engine reports it only with the shade-none patch); white is a real shade value.
      highlight: shade === "none" || shade === "?" ? null : shade,
      superscript: script("superscript"), subscript: script("subscript"),
    };
  }

  private charProperties(at: DocPosition): Record<string, unknown> | null {
    const c = at.cell;
    try {
      const inline = this.inlineCell(at); if (inline) at = { ...at, offset: inline.textOffset };
      const value = json(c?.nested
        ? this.doc.getCellCharPropertiesAtByPath!(at.section, c.parentParagraph, pathJson(c), at.offset)
        : c ? this.doc.getCellCharPropertiesAt!(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset)
        : this.doc.getCharPropertiesAt!(at.section, at.paragraph, at.offset));
      return isRecord(value) ? value as Record<string, unknown> : null;
    } catch { return null; }
  }

  /** Stage 1 character values for the whole proven selection in one engine call per paragraph (one history step
   * at the session). Only the fixed keys below reach the engine; values are validated here again. */
  prepareChars(from: DocPosition, to: DocPosition, props: Record<string, unknown> & { fontSize?: number; textColor?: string; shadeColor?: string;
    superscript?: boolean; subscript?: boolean }) {
    if (!this.formatSelection(from, to) || !RhwpText.validChars(props)) return null;
    const text = JSON.stringify(props);
    return () => this.format(from, to, text);
  }

  /** Stage 1 character values accepted by the engine boundary: only these keys, validated values. */
  static validChars(props: Record<string, unknown>): boolean {
    const keys = Object.keys(props);
    const color = (v: unknown) => typeof v === "string" && /^#[0-9A-F]{6}$/.test(v);
    if (keys.length < 1 || keys.some(k => !["fontSize", "textColor", "shadeColor", "superscript", "subscript"].includes(k))
      || (props.fontSize !== undefined && !(Number.isSafeInteger(props.fontSize) && (props.fontSize as number) >= 100 && (props.fontSize as number) <= 409_600))
      || (props.textColor !== undefined && !color(props.textColor))
      || (props.shadeColor !== undefined && props.shadeColor !== "none" && !color(props.shadeColor))
      || (props.superscript !== undefined && typeof props.superscript !== "boolean")
      || (props.subscript !== undefined && typeof props.subscript !== "boolean")) return false;
    return true;
  }

  /** Stage 1 caret formatting: the character values the next typed character would take (the shape before the caret,
   * as the engine's insertion inherits it; the first character at a paragraph start). */
  caretChars(at: DocPosition): Record<string, unknown> | null {
    return this.charProperties(at.offset > 0 ? { ...at, offset: at.offset - 1 } : at);
  }

  /** Apply validated Stage 1 values to text just inserted at [at, at+length) (inside the caller's mutation). */
  formatInserted(at: DocPosition, length: number, props: Record<string, unknown>): void {
    if (length <= 0) return;
    if (!RhwpText.validChars(props)) throw new Error("invalid pending character values");
    this.format(at, { ...at, offset: at.offset + length }, JSON.stringify(props));
  }

  get hasFontOwnership(): boolean {
    return this.hasCharShapeOwnership && !!this.originalFontCounts && !!this.doc.resolveDocumentFontFamily
      && !!this.doc.reconcileFontShapePrefix && !!this.doc.compactUnpublishedFonts && !!this.doc.capturePublishingFontShapePrefix;
  }

  /** Read every owned run, including mixed shapes whose general flags are equal.
   * Older generations cannot report a full selection and fail closed. */
  private selectedFontShapes(from: DocPosition, to: DocPosition) {
    if (!this.formatSelection(from, to)) return null;
    const table = documentFontTable(this.doc);
    if (!table) return null;
    const shapes = new Set<number>(), families = new Set<string>();
    /** One engine position (paragraph, engine char offset) per distinct shape, for per-property reads. */
    const samples = new Map<number, { paragraph: number; offset: number }>();
    let runCount = 0;
    try {
      for (let p = paragraphOf(from); p <= paragraphOf(to); p++) {
        const at = withParagraph(from, p, 0), c = from.cell;
        const start = p === paragraphOf(from) ? from.offset : 0;
        const end = p === paragraphOf(to) ? to.offset : this.paragraphLength(at);
        if (start === end) continue;
        const range = this.textRange({ ...at, offset: start }, end - start);
        const raw = c?.nested
          ? this.doc.getFormattingRunsByPath!(from.section, c.parentParagraph, pathJson(c, p), range.start, range.end)
          : this.doc.getFormattingRuns!(from.section, c ? c.parentParagraph : p, c?.control ?? NO_CELL,
            c?.cell ?? 0, c ? p : 0, range.start, range.end);
        const value = json(raw);
        if (!isRecord(value) || value.length !== range.length || !Array.isArray(value.fontRuns)) return null;
        let next = range.start;
        for (const run of value.fontRuns) {
          if (++runCount > 65_536 || !Array.isArray(run) || run.length !== 4 || !run.every(isIndex)
            || run[0] !== next || run[1]! <= next || run[1]! > range.end || !table.charShapes[run[2]!] || run[3]! > 6) return null;
          next = run[1]!; shapes.add(run[2]!);
          if (!samples.has(run[2]!)) samples.set(run[2]!, { paragraph: p, offset: run[0]! });
          const lang = run[3]!, id = table.charShapes[run[2]!]!.fontIds[lang]!;
          families.add(table.languages[lang]!.fonts[id]!.definition.name);
        }
        if (next !== range.end) return null;
      }
      return shapes.size ? { table, shapes, families, samples } : null;
    } catch { return null; }
  }

  /** Inspect the actual language slot in every selected scalar run. The stored
   * family is independent of rendering fallback; null family means mixed. */
  selectionFont(from: DocPosition, to: DocPosition): { family: string | null } | null {
    const selected = this.selectedFontShapes(from, to);
    if (!selected) return null;
    return { family: selected.families.size === 1 ? selected.families.values().next().value! : null };
  }

  prepareFont(from: DocPosition, to: DocPosition, family: string): (() => void) | "unchanged" | null {
    if (!this.hasFontOwnership) return null;
    const selected = this.selectedFontShapes(from, to);
    if (!selected) return null;
    const existing = resolveExistingFontIds(selected.table, family);
    if (existing && [...selected.shapes].every(id => selected.table.charShapes[id]!.fontIds.every((v, lang) => v === existing[lang])))
      return "unchanged";
    return () => {
      const raw = json(this.doc.resolveDocumentFontFamily!(family));
      const table = documentFontTable(this.doc), ids = table && resolveExistingFontIds(table, family);
      if (!ids || !Array.isArray(raw) || raw.length !== 7 || raw.some((id, lang) => id !== ids[lang]))
        throw new Error("document font resolution refused");
      this.format(from, to, JSON.stringify({ fontIds: ids }));
    };
  }

  /** Document-owned IDs/face definitions for the actual selected character, in all seven language slots.
   * Read-only: an inventory is never sufficient evidence for a save or a mutation. */
  fontReferences(at: DocPosition) {
    try {
      if (!isIndex(at.section) || !isIndex(at.paragraph) || !isIndex(at.offset) || at.offset > this.paragraphLength(at)) return null;
      const table = documentFontTable(this.doc);
      if (!table) return null;
      const c = at.cell, inline = this.inlineCell(at);
      const offset = inline ? inline.textOffset : at.offset;
      const value = json(c?.nested
        ? this.doc.getCellCharPropertiesAtByPath!(at.section, c.parentParagraph, pathJson(c), offset)
        : c ? this.doc.getCellCharPropertiesAt!(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, offset)
        : this.doc.getCharPropertiesAt!(at.section, at.paragraph, offset));
      if (!isRecord(value) || !isIndex(value.charShapeId)) return null;
      const shape = table.charShapes[value.charShapeId];
      if (!shape) return null;
      const faces = shape.fontIds.map((id, lang) => table.languages[lang]!.fonts[id]!);
      const languageIndex = isIndex(value.languageIndex) && value.languageIndex < 7 ? value.languageIndex : null;
      return { charShapeId: shape.id, fontIds: shape.fontIds, faces, languageIndex };
    } catch { return null; }
  }

  /** Stage 5-A: the stored font names (7 language slots) of the character at `at`. null when unreadable. */
  fontFamilies(at: DocPosition): string[] | null {
    const c = at.cell;
    try {
      const inline = this.inlineCell(at); if (inline) at = { ...at, offset: inline.textOffset };
      const value = json(c?.nested
        ? this.doc.getCellCharPropertiesAtByPath!(at.section, c.parentParagraph, pathJson(c), at.offset)
        : c ? this.doc.getCellCharPropertiesAt!(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset)
        : this.doc.getCharPropertiesAt!(at.section, at.paragraph, at.offset));
      if (!isRecord(value) || !Array.isArray(value.fontFamilies) || value.fontFamilies.length !== 7) return null;
      const names = value.fontFamilies as unknown[];
      return names.every((n) => typeof n === "string" && n.length > 0 && n.length <= 256) ? names as string[] : null;
    } catch {
      return null;
    }
  }

  /** 위치 글자의 서식(굵게·기울임·밑줄·취소선). 읽을 수 없으면 null. */
  charFormat(at: DocPosition): Record<"bold" | "italic" | "underline" | "strikethrough", boolean> | null {
    const c = at.cell;
    try {
      const inline = this.inlineCell(at); if (inline) at = { ...at, offset: inline.textOffset };
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
      const inline = this.inlineCell(at); if (inline) at = { ...at, offset: inline.textOffset };
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

  /** Complete paragraph field inventory, resolved through every explicit cell path entry. */
  private formulaInventory(at: DocPosition): Fields[] {
    if (at.cell?.textBox || at.cell?.caption) return []; // Non-table stories cannot own a table formula.
    if (!at.cell || !this.doc.getFieldList) throw new Error("formula inventory unavailable");
    const fields: unknown = json(this.doc.getFieldList());
    if (!Array.isArray(fields) || fields.length > 4096 || !fields.every(isRecord)) throw new Error("formula inventory invalid");
    const cell = at.cell, levels = [cell, ...(cell.nested ?? [])];
    return fields.filter(field => {
      if (!isRecord(field.location) || !Array.isArray(field.location.path)) return false;
      const location = field.location, path = location.path as unknown[];
      return location.sectionIndex === at.section && location.paraIndex === cell.parentParagraph && path.length === levels.length
        && levels.every((level, i) => {
          const part = path[i];
          return isRecord(part) && part.type === "cell" && part.controlIndex === level.control && part.cellIndex === level.cell
            && part.paraIndex === level.cellParagraph;
        });
    });
  }

  private formulaTarget(at: DocPosition): Fields | null {
    const offset = this.inlineCell(at)?.textOffset ?? at.offset;
    const fields = this.formulaInventory(at);
    const length = this.paragraphLength(at);
    const matches = fields.filter(f => f.fieldType === "formula" && isIndex(f.startCharIdx) && isIndex(f.endCharIdx)
      && ((f.startCharIdx <= offset && offset < f.endCharIdx)
        || (fields.length === 1 && f.startCharIdx === 0 && f.endCharIdx === length && offset === length)));
    if (matches.length > 1) throw new Error("ambiguous formula target");
    return matches[0] ?? null;
  }

  existingFormula(at: DocPosition): string | null {
    try { const field = this.formulaTarget(at), cache = cachedFormula(field?.command);
      return cache && cache.value === field?.value ? cache.expression : null;
    } catch { return null; }
  }

  /** Read-only preparation, before opening history. ID zero always means insertion. */
  prepareFormula(at: DocPosition, _row: number, _col: number, formula: string): FormulaFieldResult | null {
    const c = at.cell;
    if (!c || !this.doc.validateTableFormulaAt || !this.doc.insertTableFormulaAt) return null;
    const field = this.formulaTarget(at), id = field?.fieldId ?? 0;
    if (!isIndex(id) || tableFormulaSafety(this.doc, at, formula, id) !== "safe") return null;
    const offset = this.inlineCell(at)?.textOffset ?? at.offset;
    const value = json(this.doc.validateTableFormulaAt(at.section, c.parentParagraph, pathJson(c), offset, id, formula));
    if (isRecord(value) && Object.keys(value).join(",") === "ok" && value.ok === false) return null;
    const result = formulaFieldResult(value, formula);
    if (id !== 0 && result.fieldId !== id) throw new Error("formula target changed");
    return result;
  }

  insertFormula(at: DocPosition, _row: number, _col: number, formula: string, expected: FormulaFieldResult): void {
    const c = at.cell;
    if (!c || !this.doc.insertTableFormulaAt) throw new Error("formula field unavailable");
    const before = this.formulaInventory(at), target = this.formulaTarget(at), id = target?.fieldId ?? 0;
    if (!isIndex(id)) throw new Error("formula identity invalid");
    const offset = this.inlineCell(at)?.textOffset ?? at.offset;
    const oldText = this.text({ ...at, offset: 0 }, this.paragraphLength(at));
    const value = formulaFieldResult(json(this.doc.insertTableFormulaAt(at.section, c.parentParagraph, pathJson(c), offset, id, formula)), formula);
    if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error("formula preparation changed");
    const after = this.formulaInventory(at), edited = after.filter(f => f.fieldId === value.fieldId);
    if (!this.doc.getControls || !after.length) throw new Error("formula controls unavailable");
    const controls: unknown = json(this.doc.getControls());
    if (!Array.isArray(controls) || !controls.every(isRecord) || !isIndex(after[0]!.listId) || !isIndex(after[0]!.paraInList))
      throw new Error("formula controls invalid");
    if (paragraphFieldMap(controls, after, after[0]!.listId, after[0]!.paraInList).size !== after.length)
      throw new Error("formula control range differs");
    if (after.length !== before.length + (id === 0 ? 1 : 0) || edited.length !== 1
      || edited[0]!.controlIndex !== value.controlIndex || edited[0]!.startCharIdx !== value.start || edited[0]!.endCharIdx !== value.end
      || edited[0]!.command !== value.command || edited[0]!.value !== value.text) throw new Error("formula inventory differs");
    const start = target?.startCharIdx ?? offset, end = target?.endCharIdx ?? offset;
    if (!isIndex(start) || !isIndex(end)) throw new Error("formula range invalid");
    const chars = Array.from(oldText), updated = [...chars.slice(0, start), ...value.text, ...chars.slice(end)].join("");
    if (this.text({ ...at, offset: 0 }, this.paragraphLength(at)) !== updated) throw new Error("neighboring formula text changed");
    const delta = Array.from(value.text).length - (end - start);
    for (const f of before.filter(f => f.fieldId !== id)) {
      const found = after.find(g => g.fieldId === f.fieldId);
      if (!found || !isIndex(f.startCharIdx) || !isIndex(f.endCharIdx) || !isIndex(f.controlIndex)) throw new Error("lost formula neighbor");
      const shift = f.startCharIdx >= end ? delta : 0;
      if (found.command !== f.command || found.value !== f.value || found.startCharIdx !== f.startCharIdx + shift
        || found.endCharIdx !== f.endCharIdx + shift || found.controlIndex !== f.controlIndex + (id === 0 && f.controlIndex >= value.controlIndex ? 1 : 0)
        || JSON.stringify(found.location) !== JSON.stringify(f.location)) throw new Error("formula neighbor changed");
    }
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
