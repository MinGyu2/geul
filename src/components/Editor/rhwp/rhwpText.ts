// rhwp 문서 위치와 본문·표 셀 API 선택(T007).
//
// 위치는 (구역, 문단, 글자 오프셋)이고, 표 셀 안이면 셀 경로(부모 문단, 컨트롤, 셀, 셀 문단)를 더한다. 같은 위치를
// 다루는 호출(커서 사각형·삽입·삭제·문단 나누기·줄 정보)은 모두 여기서 본문용/셀용 API를 고르므로, 렌더·hit test·
// 편집이 서로 다른 좌표를 쓰지 않는다. 글자 오프셋은 rhwp의 글자(char, 유니코드 스칼라) 단위다.
// 엔진이 돌려주는 JSON은 신뢰 경계 안이지만 모양을 확인하고, 맞지 않으면 null로 다룬다.
import type { RhwpDocument } from "./rhwpModule";

export interface CellRef {
  parentParagraph: number;
  control: number;
  cell: number;
  cellParagraph: number;
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
  if (parentParaIndex === undefined) return { section: sectionIndex, paragraph: paragraphIndex, offset: charOffset };
  if (isTextBox === true) return null; // 글상자는 이 PoC 범위 밖
  if (!isIndex(parentParaIndex) || !isIndex(controlIndex) || !isIndex(cellIndex) || !isIndex(cellParaIndex)) return null;
  if (Array.isArray(value.cellPath) && value.cellPath.length > 1) return null; // 중첩 표는 범위 밖
  return {
    section: sectionIndex,
    paragraph: parentParaIndex,
    offset: charOffset,
    cell: { parentParagraph: parentParaIndex, control: controlIndex, cell: cellIndex, cellParagraph: cellParaIndex },
  };
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

export const sameContext = (a: DocPosition, b: DocPosition) =>
  a.section === b.section &&
  (a.cell === undefined
    ? b.cell === undefined
    : b.cell !== undefined &&
      a.cell.parentParagraph === b.cell.parentParagraph &&
      a.cell.control === b.cell.control &&
      a.cell.cell === b.cell.cell);

/** 같은 문맥(본문 또는 같은 셀)에서 문서 순서 비교. */
export function compare(a: DocPosition, b: DocPosition): number {
  const paraA = a.cell ? a.cell.cellParagraph : a.paragraph;
  const paraB = b.cell ? b.cell.cellParagraph : b.paragraph;
  return paraA !== paraB ? paraA - paraB : a.offset - b.offset;
}

/** 위치의 문단 번호(본문 문단 또는 셀 문단). */
export const paragraphOf = (position: DocPosition) => (position.cell ? position.cell.cellParagraph : position.paragraph);

/** 같은 문맥에서 문단 번호만 바꾼 위치. */
export function withParagraph(position: DocPosition, paragraph: number, offset: number): DocPosition {
  return position.cell
    ? { ...position, offset, cell: { ...position.cell, cellParagraph: paragraph } }
    : { ...position, paragraph, offset };
}

const NO_CELL = 0xffffffff; // u32::MAX: rhwp가 본문을 뜻하는 값

/** 위치에 맞는 본문/셀 API를 부른다. 편집 함수는 실패하면 예외를 던진다(엔진 오류). */
export class RhwpText {
  constructor(private readonly doc: RhwpDocument) {}

  paragraphCount(at: DocPosition): number {
    const c = at.cell;
    return c ? this.doc.getCellParagraphCount(at.section, c.parentParagraph, c.control, c.cell) : this.doc.getParagraphCount(at.section);
  }

  paragraphLength(at: DocPosition): number {
    const c = at.cell;
    return c
      ? this.doc.getCellParagraphLength(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph)
      : this.doc.getParagraphLength(at.section, at.paragraph);
  }

  caret(at: DocPosition): CaretRect | null {
    const c = at.cell;
    try {
      return parseCaretRect(json(
        c
          ? this.doc.getCursorRectInCell(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset)
          : this.doc.getCursorRect(at.section, at.paragraph, at.offset),
      ));
    } catch {
      return null;
    }
  }

  /** 줄의 처음·끝 오프셋. */
  line(at: DocPosition): { start: number; end: number } | null {
    const c = at.cell;
    try {
      const value = json(
        c
          ? this.doc.getLineInfoInCell(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset)
          : this.doc.getLineInfo(at.section, at.paragraph, at.offset),
      );
      if (!isRecord(value) || !isIndex(value.charStart) || !isIndex(value.charEnd)) return null;
      return { start: value.charStart, end: value.charEnd };
    } catch {
      return null;
    }
  }

  /** 위·아래 줄로 이동한 위치와 유지할 가로 좌표. 같은 문맥을 벗어나면 null. */
  vertical(at: DocPosition, delta: number, preferredX: number): { position: DocPosition; preferredX: number } | null {
    const c = at.cell;
    try {
      const value = json(this.doc.moveVertical(
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
        c
          ? this.doc.getSelectionRectsInCell(from.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, from.offset, to.cell!.cellParagraph, to.offset)
          : this.doc.getSelectionRects(from.section, from.paragraph, from.offset, to.paragraph, to.offset),
      )) ?? [];
    } catch {
      return [];
    }
  }

  text(at: DocPosition, count: number): string {
    const c = at.cell;
    return c
      ? this.doc.getTextInCell(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset, count)
      : this.doc.getTextRange(at.section, at.paragraph, at.offset, count);
  }

  insert(at: DocPosition, text: string): void {
    const c = at.cell;
    if (c) this.doc.insertTextInCell(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset, text);
    else this.doc.insertText(at.section, at.paragraph, at.offset, text);
  }

  delete(at: DocPosition, count: number): void {
    const c = at.cell;
    if (c) this.doc.deleteTextInCell(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset, count);
    else this.doc.deleteText(at.section, at.paragraph, at.offset, count);
  }

  deleteRange(from: DocPosition, to: DocPosition): void {
    const c = from.cell;
    if (c) this.doc.deleteRangeInCell(from.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, from.offset, to.cell!.cellParagraph, to.offset);
    else this.doc.deleteRange(from.section, from.paragraph, from.offset, to.paragraph, to.offset);
  }

  /** 위치에서 문단을 나눈다(Enter). */
  split(at: DocPosition): void {
    const c = at.cell;
    if (c) this.doc.splitParagraphInCell(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset);
    else this.doc.splitParagraph(at.section, at.paragraph, at.offset);
  }

  /** `paragraph` 문단을 앞 문단에 붙인다. */
  mergeIntoPrevious(at: DocPosition, paragraph: number): void {
    const c = at.cell;
    if (c) this.doc.mergeParagraphInCell(at.section, c.parentParagraph, c.control, c.cell, paragraph);
    else this.doc.mergeParagraph(at.section, paragraph);
  }

  /** 표의 셀 수(병합 셀 포함한 실제 셀 개수). */
  cellCount(at: DocPosition): number | null {
    const c = at.cell;
    if (!c) return null;
    try {
      const value = json(this.doc.getTableDimensions(at.section, c.parentParagraph, c.control));
      if (!isRecord(value)) return null;
      if (isIndex(value.cellCount)) return value.cellCount;
      return isIndex(value.rowCount) && isIndex(value.colCount) ? value.rowCount * value.colCount : null;
    } catch {
      return null;
    }
  }
}
