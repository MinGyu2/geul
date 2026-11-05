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
  if (parentParaIndex === undefined) {
    // 표 셀 안의 개체(그림 등)를 가리키는 결과는 셀 경로를 다른 모양(`cellPath: [[컨트롤, 셀, 셀 문단]]`, `innerControlIdx`)으로만 준다
    // (고정 rhwp 실측, 여러 구역 문서 예제). 본문 위치로 읽으면 구역 첫 문단으로 커서가 튄다 — 이 모양은 다루지 않는다.
    if (value.cellPath !== undefined || value.innerControlIdx !== undefined) return null;
    return { section: sectionIndex, paragraph: paragraphIndex, offset: charOffset };
  }
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
  /** 불러온 직후의 글자 모양 수(T012 Stage 5 정리 기준). 엔진이 알려 주지 않으면 null(정리하지 않음 — 저장 검사가 판정). */
  private readonly charShapeBaseline: number | null;

  constructor(private readonly doc: RhwpDocument) {
    const count = doc.charShapeCount?.();
    this.charShapeBaseline = Number.isSafeInteger(count) && (count as number) >= 0 ? (count as number) : null;
  }

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

  /**
   * 같은 문맥(본문 또는 한 셀)의 [from, to) 범위에 글자 서식을 적용한다. 문단마다 그 문단 안의 범위만 넘긴다(빈 범위는 건너뜀).
   * 엔진에 서식 함수가 없으면 아무것도 바꾸기 전에 던진다.
   */
  format(from: DocPosition, to: DocPosition, props: string): void {
    const c = from.cell;
    if (c ? !this.doc.applyCharFormatInCell : !this.doc.applyCharFormat) throw new Error("char format unavailable");
    const first = paragraphOf(from), last = paragraphOf(to);
    for (let paragraph = first; paragraph <= last; paragraph += 1) {
      const at = withParagraph(from, paragraph, 0);
      const start = paragraph === first ? from.offset : 0;
      const end = paragraph === last ? to.offset : this.paragraphLength(at);
      if (end <= start) continue;
      if (c) this.doc.applyCharFormatInCell!(from.section, c.parentParagraph, c.control, c.cell, paragraph, start, end, props);
      else this.doc.applyCharFormat!(from.section, paragraph, start, end, props);
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
    const value = json(this.doc.compactAppendedCharShapes(this.charShapeBaseline));
    if (!isRecord(value) || value.ok !== true || !isIndex(value.before) || !isIndex(value.after) || (value.after as number) > (value.before as number)) {
      throw new Error("char shape compaction response invalid");
    }
  }

  /** 위치 글자의 서식(굵게·기울임·밑줄·취소선). 읽을 수 없으면 null. */
  charFormat(at: DocPosition): Record<"bold" | "italic" | "underline" | "strikethrough", boolean> | null {
    const c = at.cell;
    try {
      const value = json(c
        ? this.doc.getCellCharPropertiesAt!(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset)
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
      const value = json(c
        ? this.doc.getCellCharPropertiesAt!(at.section, c.parentParagraph, c.control, c.cell, c.cellParagraph, at.offset)
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
      const info = json(this.doc.getCellInfo(at.section, c.parentParagraph, c.control, c.cell));
      const size = json(this.doc.getTableDimensions(at.section, c.parentParagraph, c.control));
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

  /**
   * 커서 셀 기준의 표 계산식을 읽기 전용으로 계산한다(T012, `writeResult=false` — 문서를 바꾸지 않음). 결과가 유한한 수가 아니거나
   * 엔진이 계산 오류를 내면 null(WASM trap은 던짐). 결과 문자열은 계산 값일 뿐 표가 바뀌었다는 근거가 아니다.
   */
  evaluateFormula(at: DocPosition, row: number, col: number, formula: string): number | null {
    const c = at.cell;
    if (!c || !this.doc.evaluateTableFormula) return null;
    try {
      const value = json(this.doc.evaluateTableFormula(at.section, c.parentParagraph, c.control, row, col, formula, false));
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
