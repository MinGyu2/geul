import { parseGraphicProperties } from "../commands/graphicProperties";
import { BASIC_SHAPES, MUTATING_OBJECT_OPERATIONS, OBJECT_KINDS, PICTURE_WRAPS, type DrawingMlShapePath, type MutatingObjectOperation, type ObjectEdit, type ObjectHit, type PictureProperties, type BasicShape, type ShapeProperties } from "../commands/objectSelection";
// WordCraft(DOCX) 세션 백엔드 클라이언트(T008, W-A). Tauri 명령 docx_load·docx_view·docx_edit·docx_render·docx_roundtrip을
// 부른다(Rust `src-tauri/src/adapters/wordcraft/`와 직렬화 형식이 같아야 한다).
//
// - 문서 모델은 백엔드에 있다. 프런트엔드는 보기(쪽 크기·커서·선택, pt 단위)와 쪽 그림(PNG)만 받고, 편집은 허용한 연산
//   (DocxOp)으로만 보낸다. 임의의 WordCraft 명령 ID는 보낼 수 없다(백엔드가 역직렬화에서 거부).
// - 수명주기·revision은 백엔드가 정한다. 응답의 세션 정보는 DocumentSessions.applyUpdate로 반영한다.
// - 응답은 신뢰 경계를 넘어온 값이므로 모양을 검사하고, 맞지 않으면 Protocol 오류로 다룬다(backend.ts와 같음).
import { PAPER_NAMES, type CharState, type ListStyle, type PageState, type ParagraphAlign, type ParagraphState, type SearchOptions, type SearchState } from "../commands/stage1";
import { call, type Invoke } from "./backend";
import {
  parsePdfExported,
  type PdfExported,
  parseSaveCheck,
  parseSaveOutcome,
  parseSessionInfo,
  type Result,
  type SaveCheck,
  type SaveOutcome,
  type SessionId,
  type SessionInfo,
} from "./contract";

export interface DocxPage {
  width: number;
  height: number;
}

/** 커서 막대(쪽 page의 x, y에서 높이 height, pt). */
export interface DocxCaret {
  page: number;
  x: number;
  y: number;
  height: number;
}

export interface DocxRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocxView {
  pages: DocxPage[];
  caret: DocxCaret | null;
  selection: DocxRect[];
  object?: ObjectHit & { clipboardShape?: { shape: BasicShape; cutAllowed: boolean }; operations: readonly MutatingObjectOperation[] };
  collapsed: boolean;
  inTable: boolean;
  /** 커서·기준점 자리 키(`story:path:off`). 비교·검사용. */
  caretKey: string;
  anchorKey: string;
  /** 커서 문단의 글자(검사 훅 빌드에서만 화면 속성으로 노출). */
  paragraphText: string;
  /** Optional bounded actual text; absence means unsupported selection shape. */
  selectionText?: string;
  clipboardTextAvailable?: boolean;
  clipboardTableCellsAvailable?: boolean;
  paragraphStyle?: string;
  /** 커서의 문단 안 위치(문자 단위). */
  caretOffset: number;
  /** WordCraft 실행 취소 기록(T010): 되돌릴·다시 할 단계가 있고 그 단계가 문서 보호를 풀지 않음. */
  history: DocxHistory;
  /** 선택(없으면 다음 입력)의 글자 서식(T010). 선택 전체가 그 서식이면 true. */
  format: DocxFormat;
  /**
   * 문서 보호가 직접 글자 서식을 허용하는지(T010 안정화, 백엔드가 WordCraft 보호 상태에서 정함). protected는 엔진이 언제나
   * 거부, regions는 편집 가능 영역 안의 변경만 엔진이 받는다(실행할 때 판정).
   */
  formatAccess: DocxFormatAccess;
  /**
   * 백엔드가 정하는 추적 문서 정책(Rust `DocxView::tracked_read_only`는 언제나 직렬화한다). true면 읽기·선택·탐색만 허용한다.
   * 필수 키다: 빠지거나 불리언이 아니면 보기 전체를 거부해 추적 문서가 편집 가능해 보이지 않게 한다.
   */
  trackedReadOnly: boolean;
  /** 본문에 엔진이 갱신할 수 있는 목차가 있음(T013 `references.updateToc` 가용성, 백엔드 `DocxModel::has_toc`). */
  hasToc: boolean;
  bullets?: boolean | null;
  imageInsertionAllowed?: boolean;
  drawingInsertionAllowed?: boolean;
  textBoxEditing?: boolean;
  /** 변경 내용 추적이 켜져 있음(T013 Stage 3, 리본 단추 눌림). */
  tracking: boolean;
  /** 추적된 변경이 있음(수락·거절 가용성, 백엔드 `DocxModel::has_revisions`). */
  hasRevisions: boolean;
  /** Stage 5-A: the selection's stored font families (null = mixed). */
  font: DocxFont;
  /** Stage 5-A: font database generation the layout reflects; pages are redrawn when it changes. */
  fontGeneration: number;
  /** Stage 1: size/color/highlight/script, paragraph formatting + list state, page setup, open search. */
  chars?: CharState;
  paragraph?: ParagraphState;
  page?: PageState;
  search?: SearchState;
  /** Stage 1 F: embedded fonts (font table embed slots). */
  embeddedFonts?: DocxEmbeddedFont[];
  /** Stage 2 Phase 1: current table geometry and per-command eligibility when inside a table. */
  table?: DocxTableView;
}

export type DocxTableAction =
  | "insertRowAbove" | "insertRowBelow" | "insertColumnLeft" | "insertColumnRight"
  | "deleteRow" | "deleteColumn" | "mergeRight" | "mergeBelow" | "mergeCells" | "splitCell";

export type DocxTableRefusal = "tableShape" | "tableContent" | "limit" | null;
export type DocxTableFormatRefusal = "tableShape" | "protected" | "crossTable" | "partialOverhang" | null;
export type DocxTableBorderKind = "all" | "outside" | "inside" | "none" | "top" | "bottom" | "left" | "right";

export interface DocxCellBorderEdge {
  style: string;
  width: number;
  color: string | null;
}

export interface DocxCellBordersView {
  top: DocxCellBorderEdge | null;
  bottom: DocxCellBorderEdge | null;
  left: DocxCellBorderEdge | null;
  right: DocxCellBorderEdge | null;
}

export interface DocxMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface DocxTableView {
  rows: number;
  cols: number;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  selectedCells: number;
  insertRowAbove: DocxTableRefusal;
  insertRowBelow: DocxTableRefusal;
  insertColumnLeft: DocxTableRefusal;
  insertColumnRight: DocxTableRefusal;
  deleteRow: DocxTableRefusal;
  deleteColumn: DocxTableRefusal;
  mergeRight: DocxTableRefusal;
  mergeBelow: DocxTableRefusal;
  mergeCells: DocxTableRefusal;
  splitCell: DocxTableRefusal;
  maxSplitRows: number;
  maxSplitColumns: number;
  hasInsideBorders: boolean;
  cellShadingRefusal: DocxTableFormatRefusal;
  cellBordersRefusal: DocxTableFormatRefusal;
  cellShading: string | null;
  cellShadingMixed: boolean;
  hasCellShading: boolean;
  cellBorders: DocxCellBordersView | null;
  supportedBorderStyles: string[];
  cellAlignHorizontal: "left" | "center" | "right" | "justify" | null;
  cellAlignHorizontalMixed: boolean;
  cellAlignVertical: "top" | "middle" | "bottom" | null;
  cellAlignVerticalMixed: boolean;
  cellAlignmentRefusal: DocxTableFormatRefusal;
  colWidth: number | null;
  colWidthMixed: boolean;
  rowHeight: number | null;
  rowHeightMixed: boolean;
  rowHeightRule: "atLeast" | "exact" | null;
  selectedCols: number;
  selectedRows: number;
  columnWidthRefusal: DocxTableFormatRefusal;
  rowHeightRefusal: DocxTableFormatRefusal;
  tableCellMargins: DocxMargins;
  cellMargins: DocxMargins | null;
  cellMarginsMixed: boolean;
  cellMarginsUsesDefault: boolean;
  cellMarginsOverrideMixed: boolean;
  cellMarginsRefusal: DocxTableFormatRefusal;
  tableAlign: "left" | "center" | "right";
  tableIndentPt: number;
  tablePositioningRefusal: DocxTableFormatRefusal;
  leadingHeaderRows: number;
  rowHeader: boolean | null;
  rowHeaderMixed: boolean;
  canEnableHeader: boolean;
  repeatHeaderRefusal: DocxTableFormatRefusal;
  rowBreakMode: "cell" | "row" | null;
  rowBreakMixed: boolean;
  rowBreakRefusal: DocxTableFormatRefusal;
}

export interface DocxFont {
  /** Requested (stored) family of the whole selection; null when mixed. */
  family: string | null;
  /** East Asian family (`w:eastAsia`); null when mixed. */
  eastAsia: string | null;
}

export type DocxFormatAccess = "allowed" | "protected" | "regions";

export interface DocxHistory {
  undo: boolean;
  redo: boolean;
}

export type DocxCharFormat = "bold" | "italic" | "underline" | "strikethrough";
export type DocxFormat = Record<DocxCharFormat, boolean>;

export interface DocxState {
  session: SessionInfo;
  view: DocxView;
}

export interface DocxEdited extends DocxState {
  /** 실행에 성공한 연산 수. */
  applied: number;
  /** 엔진이 거부해 없던 일이 된 연산의 위치. */
  rejected: number[];
}

export interface DocxRoundTrip {
  sessionId: SessionId;
  revision: number;
  bytes: number;
  pages: number;
  reopenedPages: number;
  pagesEqual: boolean;
  textEqual: boolean;
  modelEqual: boolean;
  passed: boolean;
}

export interface DocxRender {
  /** 그린 모델의 revision. */
  revision: number;
  /** 띠의 기준 판(그 판 그림의 y부터 height줄을 png로 바꾸면 이 판). null이면 쪽 전체. */
  base: number | null;
  y: number;
  height: number;
  /** height가 0이면 비어 있다(기준 판과 같은 그림). */
  png: Uint8Array;
}

export type MoveTarget = "left" | "right" | "up" | "down" | "lineStart" | "lineEnd" | "docStart" | "docEnd";

/**
 * 허용한 편집·이동(백엔드 `DocxOp`). 좌표는 쪽 왼쪽 위 기준 pt. insertText는 한 문단 안의 글자(탭·줄바꿈 없음), pasteText는 붙여넣은
 * 글자 조각("\n" = 문단 나누기, "\t" = 탭 글자, chain이면 같은 요청의 바로 앞 연산이 거부됐을 때 백엔드가 건너뜀),
 * deleteSelection은 선택이 있을 때만 지운다.
 */
export type DocxOp =
  | { op: "insertText"; text: string }
  | { op: "pasteText"; text: string; chain: boolean }
  | { op: "deleteSelection"; selection?: { anchorKey: string; caretKey: string } }
  | { op: "backspace" }
  | { op: "deleteForward" }
  | { op: "newParagraph" }
  | { op: "tab"; back: boolean }
  | { op: "move"; to: MoveTarget; extend: boolean }
  | { op: "pointer"; page: number; x: number; y: number; extend: boolean; beforeInsert: boolean; drag?: boolean; selectObject?: boolean }
  | { op: "deselectObject" }
  | { op: "leaveTextBox" }
  | { op: "shape"; kind: BasicShape }
  | { op: "cutShape"; position: string; epoch: number }
  | { op: "objectEdit"; position: string; epoch: number; edit: ObjectEdit }
  /** Stage 3 P5: the engine part of a v2 object clipboard payload (validated by the engine). */
  | { op: "pasteObject"; payload: unknown }
  | { op: "pasteHwpxPolygon"; polygon: { width: number; height: number; points: [number, number][]; fill: string; description: string } }
  | { op: "pasteHwpxShape"; shape: {
    kind: BasicShape; width: number; height: number; fill: string | null; stroke: string | null;
    strokeWidth: number; rotationAngle: number; horzFlip: boolean; vertFlip: boolean; description: string;
  } }
  | { op: "textBox" }
  | { op: "selectAll" }
  | { op: "mark"; id: number }
  | { op: "insertAt"; mark: number; text: string }
  | { op: "replaceInserted"; expected: string; text: string }
  /** 엔진(WordCraft Session) 기록의 한 단계 되돌리기·다시 실행(T010). 기록이 없으면 바뀌지 않는다. */
  | { op: "undo" }
  | { op: "redo" }
  /** 선택의 글자 서식 켜고 끄기(선택이 없으면 다음 입력의 서식, T010). */
  | { op: "format"; format: DocxCharFormat }
  /** Stage 5-A: font family for the selection (WordCraft `format.font`; a CJK font is also the East Asian font). */
  | { op: "font"; name: string }
  /** Stage 1 F: embed a face of the shared font database (font table embed slot + obfuscated font part). */
  | { op: "embedFont"; family: string; style: string }
  /** 새 메모(T013, WordCraft `review.newComment`): 본문 안의 비어 있지 않은 선택에 한 줄 메모. 글자 수는 MAX_DOCX_COMMENT_CHARS 이하. */
  | { op: "comment"; text: string }
  | { op: "footnote"; text: string }
  | { op: "endnote"; text: string }
  | { op: "bullets" }
  | { op: "image"; data: string }
  | { op: "table"; rows: number; cols: number }
  | { op: "toc" }
  | { op: "updateToc" }
  | { op: "trackChanges"; value: boolean }
  | { op: "acceptChange" }
  | { op: "rejectChange" }
  | { op: "acceptAll" }
  | { op: "rejectAll" }
  // Stage 1 (backend `stage1.rs`).
  | { op: "align"; value: ParagraphAlign }
  | { op: "fontSize"; size: number }
  | { op: "fontColor"; color: string }
  | { op: "highlight"; color: string }
  | { op: "script"; value: "superscript" | "subscript" | "baseline" }
  | { op: "paragraph"; format: DocxParagraphFormat }
  | { op: "list"; style: ListStyle; off: boolean }
  | { op: "listIndent"; outdent: boolean }
  | { op: "restartNumbering" }
  | { op: "continueNumbering" }
  | { op: "pageSetup"; setup: DocxPageSetup }
  | { op: "find"; query: SearchOptions; backward: boolean }
  | { op: "replace"; query: SearchOptions; with: string }
  | { op: "replaceAll"; query: SearchOptions; with: string }
  | { op: "clearSearch" }
  | { op: "tableStructure"; action: DocxTableAction; target: { anchorKey: string; caretKey: string }; rows?: number; columns?: number }
  | { op: "tableShading"; target: { anchorKey: string; caretKey: string }; color: string | null }
  | { op: "tableBorders"; target: { anchorKey: string; caretKey: string }; kind: DocxTableBorderKind; style?: string; width?: number; color?: string | null }
  | { op: "tableAlignment"; target: { anchorKey: string; caretKey: string }; horizontal?: "left" | "center" | "right" | "justify"; vertical?: "top" | "middle" | "bottom" }
  | { op: "tableColumnWidth"; target: { anchorKey: string; caretKey: string }; width?: number; distribute: boolean }
  | { op: "tableRowHeight"; target: { anchorKey: string; caretKey: string }; height?: number; rule?: "atLeast" | "exact"; clear: boolean; distribute: boolean }
  | {
      op: "tableCellMargins";
      target: { anchorKey: string; caretKey: string };
      scope: "cell" | "table";
      top?: number;
      right?: number;
      bottom?: number;
      left?: number;
      reset: boolean;
    }
  | {
      op: "tablePositioning";
      target: { anchorKey: string; caretKey: string };
      align?: "left" | "center" | "right";
      indentPt?: number;
    }
  | {
      op: "tableRepeatHeader";
      target: { anchorKey: string; caretKey: string };
      repeat: boolean;
    }
  | {
      op: "tableRowBreak";
      target: { anchorKey: string; caretKey: string };
      mode: "cell" | "row";
    }
  | { op: "cutTableCells"; target: { anchorKey: string; caretKey: string } }
  | {
      op: "pasteTableCells";
      target: { anchorKey: string; caretKey: string };
      payload: {
        rows: number;
        cols: number;
        cells: import("../commands/tableClipboard").TableClipboardCell[];
      };
    };

/** Backend `ParagraphFormat` (camelCase fields, line spacing tagged by `rule`). */
export interface DocxParagraphFormat {
  lineSpacing?: { rule: "multiple" | "atLeast" | "exactly"; value: number };
  spaceBefore?: number; spaceAfter?: number; indentLeft?: number; indentRight?: number; indentFirst?: number;
}
export type DocxPageSetup =
  | { kind: "margins"; top: number; bottom: number; left: number; right: number }
  | { kind: "orientation"; landscape: boolean }
  | { kind: "size"; name: string }
  | { kind: "columns"; count: number; space: number };

/** 메모 글자 수 상한(문자 단위, 백엔드 MAX_COMMENT_CHARS와 같음). */
export const MAX_DOCX_COMMENT_CHARS = 1000;

/** 한 요청의 연산 수 상한(백엔드 MAX_OPS와 같음). */
export const MAX_DOCX_OPS = 256;
/** 한 연산의 글자 수 상한(유니코드 문자 단위, 백엔드 MAX_TEXT_CHARS와 같음). */
export const MAX_DOCX_TEXT_CHARS = 4096;
/**
 * 붙여넣기 하나의 글자 수 상한(문자 단위) = 한 요청에 들어가는 조각만큼(1 Mi자). 조각마다 백엔드가 문서 모델을 복제·비교하므로
 * 총량을 묶는다(측정: 개발 빌드 엔진에서 한도만큼 넣기 약 0.36 s, 그 결과 683쪽 문서의 배치 약 2.8 s).
 */
export const MAX_DOCX_PASTE_CHARS = MAX_DOCX_OPS * MAX_DOCX_TEXT_CHARS;
/** docx_render 응답 머리 길이: revision u64, 기준 판 u64(모두 1이면 쪽 전체), 띠 첫 줄 u32, 줄 수 u32(LE). 백엔드와 같다. */
export const RENDER_HEADER_LEN = 24;

export interface DocxBackend {
  /** 엔진에 불러온다(identified·failed → ready). reloadGeneration이 있으면 그 시도의 ready 모델을 버리고 다시 불러온다. */
  load(sessionId: SessionId, reloadGeneration?: number): Promise<Result<DocxState>>;
  selectionText?(sessionId: SessionId, generation: number, revision: number, anchorKey: string, caretKey: string): Promise<Result<string>>;
  selectionTableCells?(sessionId: SessionId, generation: number, revision: number, anchorKey: string, caretKey: string): Promise<Result<string>>;
  /** Stage 3 P5: structured clipboard payload of the selected drawing (`docx_selection_object`). */
  selectionObject?(sessionId: SessionId, generation: number, revision: number, position: string, epoch: number): Promise<Result<string>>;
  view(sessionId: SessionId, generation: number): Promise<Result<DocxState>>;
  edit(sessionId: SessionId, generation: number, baseRevision: number, ops: DocxOp[]): Promise<Result<DocxEdited>>;
  /** 쪽 그림. scale은 pt당 픽셀, base는 이미 가진 같은 배율 그림의 판(있으면 바뀐 띠만 받는다). */
  render(sessionId: SessionId, generation: number, revision: number, page: number, scale: number, base?: number): Promise<Result<DocxRender>>;
  roundTrip(sessionId: SessionId, generation: number, revision: number): Promise<Result<DocxRoundTrip>>;
  /** 저장 사전 검사(T009): 백엔드가 원본을 다시 읽어 편집 없는 WordCraft 왕복과 비교하고 결과를 기억한다. */
  preflight(sessionId: SessionId, generation: number): Promise<Result<SaveCheck>>;
  /** 원본 형식 저장(T009): 그 판의 모델을 내보내 검사한 뒤 원본을 바꾼다. */
  save(sessionId: SessionId, generation: number, revision: number, destination?: string): Promise<Result<SaveOutcome>>;
  /** Durable private snapshot; never clears document dirty state. */
  checkpoint?(sessionId: SessionId, generation: number, revision: number): Promise<Result<SaveOutcome>>;
  /** PDF export (Stage 5-A): the engine's vector PDF of exactly that revision, written to a chosen .pdf path. */
  exportPdf?(sessionId: SessionId, generation: number, revision: number, destination: string, overwriteGrant?: string | null): Promise<Result<PdfExported>>;
}

// ---- 응답 검사 ----

type Fields = Record<string, unknown>;
const isRecord = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactly = (value: Fields, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isFinite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isPositive = (value: unknown): value is number => isFinite(value) && value > 0;

function parsePage(value: unknown): DocxPage | null {
  if (!isRecord(value) || !hasExactly(value, ["width", "height"])) return null;
  return isPositive(value.width) && isPositive(value.height) ? { width: value.width, height: value.height } : null;
}

function parseCaret(value: unknown): DocxCaret | null {
  if (!isRecord(value) || !hasExactly(value, ["page", "x", "y", "height"])) return null;
  const { page, x, y, height } = value;
  return isCount(page) && isFinite(x) && isFinite(y) && isFinite(height) && height >= 0 ? { page, x, y, height } : null;
}

function parseRect(value: unknown): DocxRect | null {
  if (!isRecord(value) || !hasExactly(value, ["page", "x", "y", "width", "height"])) return null;
  const { page, x, y, width, height } = value;
  return isCount(page) && isFinite(x) && isFinite(y) && isFinite(width) && isFinite(height) && width >= 0 && height >= 0
    ? { page, x, y, width, height }
    : null;
}

const VIEW_KEYS = [
  "pages", "caret", "selection", "collapsed", "inTable", "caretKey", "anchorKey", "paragraphText", "caretOffset", "history", "format",
  "formatAccess", "trackedReadOnly", "hasToc", "tracking", "hasRevisions", "fontGeneration",
];
const FORMAT_ACCESS: readonly DocxFormatAccess[] = ["allowed", "protected", "regions"];
const FORMAT_KEYS: readonly DocxCharFormat[] = ["bold", "italic", "underline", "strikethrough"];

function parseHistory(value: unknown): DocxHistory | null {
  if (!isRecord(value) || !hasExactly(value, ["undo", "redo"])) return null;
  const { undo, redo } = value;
  return typeof undo === "boolean" && typeof redo === "boolean" ? { undo, redo } : null;
}

function parseFormat(value: unknown): DocxFormat | null {
  if (!isRecord(value) || !hasExactly(value, [...FORMAT_KEYS, "font", "fontEastAsia"])) return null;
  const { bold, italic, underline, strikethrough } = value;
  return [bold, italic, underline, strikethrough].every((flag) => typeof flag === "boolean")
    ? { bold: bold as boolean, italic: italic as boolean, underline: underline as boolean, strikethrough: strikethrough as boolean }
    : null;
}

const fontName = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;

function parseFont(value: unknown): DocxFont | null {
  if (!isRecord(value)) return null;
  const family = fontName(value.font), eastAsia = fontName(value.fontEastAsia);
  return family === undefined || eastAsia === undefined ? null : { family, eastAsia };
}

const ALIGNS: readonly ParagraphAlign[] = ["left", "center", "right", "justify"];
const num = (value: unknown): number | null | undefined => value === null ? null : isFinite(value) ? value : undefined;

function parseChars(value: unknown): CharState | undefined {
  if (!isRecord(value) || !hasExactly(value, ["size", "color", "highlight", "superscript", "subscript"])) return undefined;
  const size = num(value.size);
  const text = (v: unknown) => v === null ? null : typeof v === "string" && /^([0-9A-Fa-f]{6}|auto)$/.test(v) ? v.toUpperCase().replace("AUTO", "auto") : undefined;
  const color = text(value.color), highlight = text(value.highlight);
  if (size === undefined || color === undefined || highlight === undefined
    || typeof value.superscript !== "boolean" || typeof value.subscript !== "boolean") return undefined;
  return { size, color, highlight, superscript: value.superscript, subscript: value.subscript };
}

function parseParagraph(value: unknown): ParagraphState | undefined {
  const keys = ["align", "lineSpacing", "spaceBefore", "spaceAfter", "indentLeft", "indentRight", "indentFirst", "list"];
  if (!isRecord(value) || !hasExactly(value, keys)) return undefined;
  const align = value.align === null ? null : ALIGNS.find((a) => a === value.align);
  const line = value.lineSpacing;
  const lineSpacing = line === null ? null : isRecord(line) && hasExactly(line, ["rule", "value"])
    && (line.rule === "multiple" || line.rule === "atLeast" || line.rule === "exactly") && isFinite(line.value)
    ? { rule: line.rule, value: line.value } as ParagraphState["lineSpacing"] : undefined;
  const numbers = ["spaceBefore", "spaceAfter", "indentLeft", "indentRight", "indentFirst"].map((k) => num(value[k]));
  const l = value.list;
  const list = l === null ? null : isRecord(l) && hasExactly(l, ["bullets", "numbering", "multilevel", "level"])
    && typeof l.bullets === "boolean" && typeof l.numbering === "boolean" && typeof l.multilevel === "boolean" && isCount(l.level) && l.level <= 8
    ? { bullets: l.bullets, numbering: l.numbering, multilevel: l.multilevel, level: l.level } : undefined;
  if (align === undefined || lineSpacing === undefined || list === undefined || numbers.some((n) => n === undefined)) return undefined;
  const [spaceBefore, spaceAfter, indentLeft, indentRight, indentFirst] = numbers as (number | null)[];
  return { align, lineSpacing, spaceBefore: spaceBefore!, spaceAfter: spaceAfter!, indentLeft: indentLeft!, indentRight: indentRight!, indentFirst: indentFirst!, list };
}

function parsePageSetup(value: unknown): PageState | undefined {
  const keys = ["width", "height", "landscape", "marginTop", "marginBottom", "marginLeft", "marginRight", "columns", "columnSpace", "paper"];
  if (!isRecord(value) || !hasExactly(value, keys)) return undefined;
  const lengths = ["width", "height", "marginTop", "marginBottom", "marginLeft", "marginRight", "columnSpace"];
  if (!lengths.every((k) => isFinite(value[k])) || typeof value.landscape !== "boolean" || !isCount(value.columns)) return undefined;
  const paper = value.paper === null ? null : PAPER_NAMES.find((p) => p === value.paper);
  if (paper === undefined) return undefined;
  return {
    width: value.width as number, height: value.height as number, landscape: value.landscape, marginTop: value.marginTop as number,
    marginBottom: value.marginBottom as number, marginLeft: value.marginLeft as number, marginRight: value.marginRight as number,
    columns: value.columns, columnSpace: value.columnSpace as number, paper,
  };
}

function parseSearch(value: unknown): SearchState | undefined {
  if (!isRecord(value) || !hasExactly(value, ["text", "matchCase", "wholeWord", "count", "current"])) return undefined;
  const { text, matchCase, wholeWord, count, current } = value;
  if (typeof text !== "string" || typeof matchCase !== "boolean" || typeof wholeWord !== "boolean" || !isCount(count)) return undefined;
  if (current !== null && !(isCount(current) && current < count)) return undefined;
  return { text, matchCase, wholeWord, count, current };
}

export interface DocxEmbeddedFont { family: string; slot: string; fontKey: string | null; part: string | null }

function parseEmbeddedFonts(value: unknown): DocxEmbeddedFont[] | undefined {
  if (!Array.isArray(value) || value.length > 4096) return undefined;
  const out: DocxEmbeddedFont[] = [];
  for (const e of value) {
    if (!isRecord(e) || !hasExactly(e, ["family", "slot", "fontKey", "part"]) || typeof e.family !== "string" || typeof e.slot !== "string"
      || !(e.fontKey === null || typeof e.fontKey === "string") || !(e.part === null || typeof e.part === "string")) return undefined;
    out.push({ family: e.family, slot: e.slot, fontKey: e.fontKey as string | null, part: e.part as string | null });
  }
  return out;
}

const TABLE_ACTION_KEYS: readonly DocxTableAction[] = [
  "insertRowAbove", "insertRowBelow", "insertColumnLeft", "insertColumnRight",
  "deleteRow", "deleteColumn", "mergeRight", "mergeBelow", "mergeCells", "splitCell",
];
const TABLE_REFUSALS = new Set(["tableShape", "tableContent", "limit"]);
const TABLE_FORMAT_REFUSALS = new Set(["tableShape", "protected", "crossTable", "partialOverhang"]);

function parseCellBorderEdge(value: unknown): DocxCellBorderEdge | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactly(value, ["style", "width", "color"])) return undefined;
  if (typeof value.style !== "string" || !isFinite(value.width)) return undefined;
  if (value.color !== null && typeof value.color !== "string") return undefined;
  return value as unknown as DocxCellBorderEdge;
}

function parseCellBordersView(value: unknown): DocxCellBordersView | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactly(value, ["top", "bottom", "left", "right"])) return undefined;
  for (const side of ["top", "bottom", "left", "right"] as const) {
    if (parseCellBorderEdge(value[side]) === undefined) return undefined;
  }
  return value as unknown as DocxCellBordersView;
}

function parseDocxMargins(value: unknown): DocxMargins | undefined {
  if (!isRecord(value) || !hasExactly(value, ["top", "right", "bottom", "left"])) return undefined;
  for (const side of ["top", "right", "bottom", "left"] as const) {
    if (typeof value[side] !== "number" || !Number.isFinite(value[side])) return undefined;
  }
  return value as unknown as DocxMargins;
}

function parseTableView(value: unknown): DocxTableView | undefined {
  const keys = [
    "rows", "cols", "row", "col", "rowSpan", "colSpan", "selectedCells",
    ...TABLE_ACTION_KEYS,
    "maxSplitRows", "maxSplitColumns",
    "hasInsideBorders", "cellShadingRefusal", "cellBordersRefusal",
    "cellShading", "cellShadingMixed", "hasCellShading", "cellBorders", "supportedBorderStyles",
    "cellAlignHorizontal", "cellAlignHorizontalMixed", "cellAlignVertical", "cellAlignVerticalMixed", "cellAlignmentRefusal",
    "colWidth", "colWidthMixed", "rowHeight", "rowHeightMixed", "rowHeightRule",
    "selectedCols", "selectedRows", "columnWidthRefusal", "rowHeightRefusal",
    "tableCellMargins", "cellMargins", "cellMarginsMixed", "cellMarginsUsesDefault", "cellMarginsOverrideMixed", "cellMarginsRefusal",
    "tableAlign", "tableIndentPt", "tablePositioningRefusal",
    "leadingHeaderRows", "rowHeader", "rowHeaderMixed", "canEnableHeader", "repeatHeaderRefusal",
    "rowBreakMode", "rowBreakMixed", "rowBreakRefusal",
  ];
  if (!isRecord(value) || !hasExactly(value, keys)) return undefined;
  for (const k of ["rows", "cols", "row", "col", "rowSpan", "colSpan", "selectedCells", "maxSplitRows", "maxSplitColumns", "selectedCols", "selectedRows", "leadingHeaderRows"] as const) {
    if (!isCount(value[k])) return undefined;
  }
  for (const k of TABLE_ACTION_KEYS) {
    const v = value[k];
    if (v !== null && (typeof v !== "string" || !TABLE_REFUSALS.has(v))) return undefined;
  }
  for (const k of ["hasInsideBorders", "cellShadingMixed", "hasCellShading", "cellAlignHorizontalMixed", "cellAlignVerticalMixed", "colWidthMixed", "rowHeightMixed", "cellMarginsMixed", "cellMarginsUsesDefault", "cellMarginsOverrideMixed", "rowHeaderMixed", "canEnableHeader", "rowBreakMixed"] as const) {
    if (typeof value[k] !== "boolean") return undefined;
  }
  for (const k of ["cellShadingRefusal", "cellBordersRefusal", "cellAlignmentRefusal", "columnWidthRefusal", "rowHeightRefusal", "cellMarginsRefusal", "tablePositioningRefusal", "repeatHeaderRefusal", "rowBreakRefusal"] as const) {
    const v = value[k];
    if (v !== null && (typeof v !== "string" || !TABLE_FORMAT_REFUSALS.has(v))) return undefined;
  }
  if (value.rowHeader !== null && typeof value.rowHeader !== "boolean") return undefined;
  if (value.rowBreakMode !== null && value.rowBreakMode !== "cell" && value.rowBreakMode !== "row") return undefined;
  if (value.cellAlignHorizontal !== null && (typeof value.cellAlignHorizontal !== "string" || !["left", "center", "right", "justify"].includes(value.cellAlignHorizontal))) return undefined;
  if (value.cellAlignVertical !== null && (typeof value.cellAlignVertical !== "string" || !["top", "middle", "bottom"].includes(value.cellAlignVertical))) return undefined;
  if (value.colWidth !== null && (typeof value.colWidth !== "number" || !Number.isFinite(value.colWidth))) return undefined;
  if (value.rowHeight !== null && (typeof value.rowHeight !== "number" || !Number.isFinite(value.rowHeight))) return undefined;
  if (value.rowHeightRule !== null && (typeof value.rowHeightRule !== "string" || !["atLeast", "exact"].includes(value.rowHeightRule))) return undefined;
  if (value.cellShading !== null && typeof value.cellShading !== "string") return undefined;
  if (parseCellBordersView(value.cellBorders) === undefined) return undefined;
  if (!Array.isArray(value.supportedBorderStyles) || !value.supportedBorderStyles.every((s) => typeof s === "string")) return undefined;
  if (parseDocxMargins(value.tableCellMargins) === undefined) return undefined;
  if (value.cellMargins !== null && parseDocxMargins(value.cellMargins) === undefined) return undefined;
  if (typeof value.tableAlign !== "string" || !["left", "center", "right"].includes(value.tableAlign)) return undefined;
  if (typeof value.tableIndentPt !== "number" || !Number.isFinite(value.tableIndentPt)) return undefined;
  return value as unknown as DocxTableView;
}

const STAGE1_VIEW: readonly [string, (value: unknown) => unknown][] = [
  ["chars", parseChars], ["paragraph", parseParagraph], ["page", parsePageSetup], ["search", parseSearch], ["embeddedFonts", parseEmbeddedFonts], ["table", parseTableView],
];

export function parseDocxView(value: unknown): DocxView | null {
  if (!isRecord(value)) return null;
  // Stage 1 fields are validated when present; a malformed one rejects the whole view.
  const stage1: Record<string, unknown> = {};
  for (const [key, parse] of STAGE1_VIEW) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const parsed = parse(value[key]);
    if (parsed === undefined) return null;
    stage1[key] = parsed;
  }
  const base = parseDocxBaseView(Object.fromEntries(Object.entries(value).filter(([key]) => !STAGE1_VIEW.some(([k]) => k === key))));
  return base && { ...base, ...stage1 };
}

function parseShapeView(raw: unknown): ShapeProperties | null {
  if (!isRecord(raw) || !hasExactly(raw, ["fill", "outline", "outlineWidth", "rotation", "flipH", "flipV", "widthPt", "heightPt"])) return null;
  const color = (c: unknown): c is string | null => c === null || (typeof c === "string" && /^[0-9A-F]{6}$/.test(c));
  const { fill, outline, outlineWidth, rotation, flipH, flipV, widthPt, heightPt } = raw;
  if (!color(fill) || !color(outline) || typeof outlineWidth !== "number" || !Number.isFinite(outlineWidth) || outlineWidth < 0
    || typeof rotation !== "number" || !Number.isFinite(rotation) || typeof flipH !== "boolean" || typeof flipV !== "boolean"
    || !isPositive(widthPt) || !isPositive(heightPt)) return null;
  return { fill, outline, outlineWidth, rotation, flipH, flipV, widthPt, heightPt };
}

function parsePictureView(raw: unknown): PictureProperties | null {
  if (!isRecord(raw) || !hasExactly(raw, ["widthPt", "heightPt", "wrap", "crop", ...("description" in raw ? ["description"] : [])])) return null;
  const { widthPt, heightPt, description, crop } = raw;
  const wrap = PICTURE_WRAPS.find(wrap => wrap === raw.wrap);
  if (!isPositive(widthPt) || !isPositive(heightPt) || !wrap) return null;
  if ("description" in raw && (typeof description !== "string" || description.length > 4096)) return null;
  if (!Array.isArray(crop) || crop.length !== 4 || !crop.every(side => typeof side === "number" && Number.isFinite(side) && side >= 0 && side <= 1)) return null;
  return { widthPt, heightPt, wrap, crop: crop as [number, number, number, number], ...(typeof description === "string" ? { description } : {}) };
}

const MAX_DOCX_GROUP_CHILDREN = 1000;
const MAX_DOCX_GROUP_COORDINATE_PT = 14_400;
const MAX_DOCX_GROUP_ID = 0xffff_ffff;

function parseGroupChildren(raw: unknown): NonNullable<ObjectHit["groupChildren"]> | null {
  if (!isRecord(raw) || !hasExactly(raw, ["parentId", "width", "height", "children"])) return null;
  const { parentId, width, height, children } = raw;
  const isU32 = (value: unknown): value is number => isCount(value) && value <= MAX_DOCX_GROUP_ID;
  const isGroupExtent = (value: unknown): value is number => isPositive(value) && value <= MAX_DOCX_GROUP_COORDINATE_PT;
  if (!isU32(parentId) || !isGroupExtent(width) || !isGroupExtent(height)
    || !Array.isArray(children) || children.length > MAX_DOCX_GROUP_CHILDREN) return null;

  const parsed: NonNullable<ObjectHit["groupChildren"]>["children"][number][] = [];
  let previousIndex = -1;
  for (const child of children) {
    if (!isRecord(child) || !hasExactly(child, [
      "index", "kind", "id", "instId", "x", "y", "width", "height", "sizeProtect", "locked", "canMove", "canResize",
    ])) return null;
    const { index, kind, id, instId, x, y, width: childWidth, height: childHeight,
      sizeProtect, locked, canMove, canResize } = child;
    if (!isCount(index) || index >= MAX_DOCX_GROUP_CHILDREN || index <= previousIndex
      || !isU32(id) || !isU32(instId)
      || ![x, y].every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate)
        && coordinate >= 0 && coordinate <= MAX_DOCX_GROUP_COORDINATE_PT)
      || !isGroupExtent(childWidth) || !isGroupExtent(childHeight)
      || (x as number) + childWidth > width + 0.001 || (y as number) + childHeight > height + 0.001
      || ![sizeProtect, locked, canMove, canResize].every((flag) => typeof flag === "boolean")
      || !["rectangle", "ellipse", "picture", "group", "shape", "textBox"].includes(String(kind))) return null;
    previousIndex = index;
    parsed.push({
      index,
      kind: kind as NonNullable<ObjectHit["groupChildren"]>["children"][number]["kind"],
      id,
      instId,
      x: x as number,
      y: y as number,
      width: childWidth,
      height: childHeight,
      sizeProtect: sizeProtect as boolean,
      locked: locked as boolean,
      canMove: canMove as boolean,
      canResize: canResize as boolean,
    });
  }
  return { parentId, width, height, children: parsed };
}

const DRAWINGML_PATH_COMMANDS = ["moveTo", "lnTo", "quadBezTo", "cubicBezTo", "close"] as const;
const MAX_DRAWINGML_PATHS = 256;
const MAX_DRAWINGML_POINTS = 5_000;
const MAX_DRAWINGML_COORDINATE = 1_000_000_000_000;

function parseDrawingMlPaths(raw: unknown): DrawingMlShapePath[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DRAWINGML_PATHS) return null;
  const paths: DrawingMlShapePath[] = [];
  let segmentCount = 0, pointCount = 0;
  for (const path of raw) {
    if (!isRecord(path) || !hasExactly(path, ["viewportWidth", "viewportHeight", "segments"])) return null;
    const { viewportWidth, viewportHeight, segments } = path;
    if (!Number.isSafeInteger(viewportWidth) || !Number.isSafeInteger(viewportHeight)
      || (viewportWidth as number) < 1 || (viewportHeight as number) < 1
      || (viewportWidth as number) > MAX_DRAWINGML_COORDINATE || (viewportHeight as number) > MAX_DRAWINGML_COORDINATE
      || !Array.isArray(segments) || segments.length === 0) return null;
    segmentCount += segments.length;
    if (segmentCount > MAX_DRAWINGML_POINTS) return null;
    const parsedSegments: DrawingMlShapePath["segments"][number][] = [];
    for (const segment of segments) {
      if (!isRecord(segment) || !hasExactly(segment, ["command", "points"])) return null;
      const command = DRAWINGML_PATH_COMMANDS.find((name) => name === segment.command);
      if (!command || !Array.isArray(segment.points)) return null;
      const pointLimit = command === "moveTo" || command === "lnTo" ? 1
        : command === "quadBezTo" ? 2 : command === "cubicBezTo" ? 3 : 0;
      if (segment.points.length !== pointLimit) return null;
      const parsedPoints: DrawingMlShapePath["segments"][number]["points"][number][] = [];
      for (const [index, point] of segment.points.entries()) {
        if (!isRecord(point) || !hasExactly(point, ["x", "y", "control"])) return null;
        const { x, y, control } = point;
        if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)
          || (x as number) < 0 || (y as number) < 0
          || (x as number) > (viewportWidth as number) || (y as number) > (viewportHeight as number)
          || typeof control !== "boolean") return null;
        const isControl = command === "quadBezTo" && index === 0 || command === "cubicBezTo" && index < 2;
        if (control !== isControl) return null;
        parsedPoints.push({ x: x as number, y: y as number, control });
      }
      pointCount += parsedPoints.length;
      if (pointCount > MAX_DRAWINGML_POINTS) return null;
      parsedSegments.push({ command, points: parsedPoints });
    }
    paths.push({ viewportWidth: viewportWidth as number, viewportHeight: viewportHeight as number, segments: parsedSegments });
  }
  return paths;
}

function parseDocxBaseView(value: unknown): DocxView | null {
  if (!isRecord(value) || !hasExactly(value, [...VIEW_KEYS, ...["object", "selectionText", "paragraphStyle", "clipboardTextAvailable", "clipboardTableCellsAvailable", "imageInsertionAllowed", "drawingInsertionAllowed", "textBoxEditing", "bullets"].filter((key) => Object.prototype.hasOwnProperty.call(value, key))])) return null;
  if (Object.prototype.hasOwnProperty.call(value, "imageInsertionAllowed") && typeof value.imageInsertionAllowed !== "boolean") return null;
  if ("drawingInsertionAllowed" in value && typeof value.drawingInsertionAllowed !== "boolean") return null;
  if ("textBoxEditing" in value && typeof value.textBoxEditing !== "boolean") return null;
  if (Object.prototype.hasOwnProperty.call(value, "bullets") && typeof value.bullets !== "boolean" && value.bullets !== null) return null;
  if (value.clipboardTextAvailable !== undefined && typeof value.clipboardTextAvailable !== "boolean") return null;
  if (value.clipboardTableCellsAvailable !== undefined && typeof value.clipboardTableCellsAvailable !== "boolean") return null;
  if (Object.prototype.hasOwnProperty.call(value, "paragraphStyle") && typeof value.paragraphStyle !== "string") return null;
  if (Object.prototype.hasOwnProperty.call(value, "selectionText") && (typeof value.selectionText !== "string" || Array.from(value.selectionText).length > 500)) return null;
  const { pages, caret, selection, collapsed, inTable, caretKey, anchorKey, paragraphText, caretOffset, trackedReadOnly, hasToc, tracking, hasRevisions } = value;
  if (![trackedReadOnly, hasToc, tracking, hasRevisions].every((flag) => typeof flag === "boolean")) return null;
  const history = parseHistory(value.history);
  const format = parseFormat(value.format);
  const font = parseFont(value.format);
  const formatAccess = FORMAT_ACCESS.find((access) => access === value.formatAccess);
  if (!history || !format || !font || !formatAccess || !isCount(value.fontGeneration)) return null;
  if (!Array.isArray(pages) || pages.length === 0 || !Array.isArray(selection)) return null;
  const parsedPages = pages.map(parsePage);
  const parsedSelection = selection.map(parseRect);
  const parsedCaret = caret === null ? null : parseCaret(caret);
  if (parsedPages.some((page) => page === null) || parsedSelection.some((rect) => rect === null)) return null;
  if (caret !== null && parsedCaret === null) return null;
  const pageCount = parsedPages.length;
  let object: DocxView["object"];
  if (Object.prototype.hasOwnProperty.call(value, "object")) {
    const raw = value.object;
    if (!isRecord(raw) || !hasExactly(raw, ["kind", "position", "frame", "epoch", "operations", ...("picture" in raw ? ["picture"] : []), ...("graphic" in raw ? ["graphic"] : []), ...("clipboardShape" in raw ? ["clipboardShape"] : []), ...("shape" in raw ? ["shape"] : []), ...("convertShape" in raw ? ["convertShape"] : []), ...("drawingMlPaths" in raw ? ["drawingMlPaths"] : []), ...("groupChildren" in raw ? ["groupChildren"] : [])])) return null;
    const kind = OBJECT_KINDS.find((kind) => kind === raw.kind);
    const frame = parseRect(raw.frame);
    if (!kind || !frame || frame.page >= pageCount || !isCount(raw.epoch) || raw.epoch === 0
      || typeof raw.position !== "string" || raw.position.length > 256
      || !/^(body|part\d+):\d+(\.\d+)*:\d+$/.test(raw.position)) return null;
    const operations = raw.operations;
    if (!Array.isArray(operations) || operations.length > MUTATING_OBJECT_OPERATIONS.length
      || !operations.every((op, i) => MUTATING_OBJECT_OPERATIONS.some(known => known === op) && operations.indexOf(op) === i)) return null;
    object = { kind, frame, epoch: raw.epoch, address: { engine: "wordcraft", position: raw.position }, operations: operations as MutatingObjectOperation[] };
    if ("convertShape" in raw) {
      if (kind !== "shape" || (raw.convertShape !== "rectangle" && raw.convertShape !== "ellipse")) return null;
      object.convertShape = raw.convertShape;
    }
    if ("picture" in raw) {
      const picture = parsePictureView(raw.picture);
      if (kind !== "picture" || !picture) return null;
      object.picture = picture;
    }
    if ("graphic" in raw) {
      const graphic = parseGraphicProperties(raw.graphic);
      if (!graphic || graphic.kind !== kind) return null;
      object.graphic = graphic;
    }
    if ("shape" in raw) {
      const shape = parseShapeView(raw.shape);
      if (!shape || (kind !== "shape" && kind !== "textBox" && kind !== "group")) return null;
      object.shape = shape;
    }
    if ("drawingMlPaths" in raw) {
      const drawingMlPaths = parseDrawingMlPaths(raw.drawingMlPaths);
      if (kind !== "shape" || !drawingMlPaths) return null;
      object.drawingMlPaths = drawingMlPaths;
    }
    if ("groupChildren" in raw) {
      const groupChildren = parseGroupChildren(raw.groupChildren);
      if (kind !== "group" || !groupChildren) return null;
      object.groupChildren = groupChildren;
    }
    if (operations.includes("groupChildGeometry") && !object.groupChildren) return null;
    if (operations.includes("pathPoint") && !object.drawingMlPaths) return null;
    if ("clipboardShape" in raw) {
      const shapeView = raw.clipboardShape;
      if (kind !== "shape" || !isRecord(shapeView) || !hasExactly(shapeView, ["shape", "cutAllowed"])
        || typeof shapeView.cutAllowed !== "boolean") return null;
      const shape = BASIC_SHAPES.find(shape => shape === shapeView.shape);
      if (!shape) return null;
      object.clipboardShape = { shape, cutAllowed: shapeView.cutAllowed };
    }
    if (parsedCaret || parsedSelection.length > 0) return null;
  }
  // 커서·선택은 있는 쪽만 가리킨다.
  if ((parsedCaret && parsedCaret.page >= pageCount) || parsedSelection.some((rect) => rect!.page >= pageCount)) return null;
  if (typeof collapsed !== "boolean" || typeof inTable !== "boolean") return null;
  if (typeof caretKey !== "string" || typeof anchorKey !== "string" || typeof paragraphText !== "string" || !isCount(caretOffset)) return null;
  return {
    ...(typeof value.clipboardTextAvailable === "boolean" ? { clipboardTextAvailable: value.clipboardTextAvailable } : {}),
    ...(typeof value.clipboardTableCellsAvailable === "boolean" ? { clipboardTableCellsAvailable: value.clipboardTableCellsAvailable } : {}),
    ...(typeof value.imageInsertionAllowed === "boolean" ? { imageInsertionAllowed: value.imageInsertionAllowed } : {}),
    ...(typeof value.drawingInsertionAllowed === "boolean" ? { drawingInsertionAllowed: value.drawingInsertionAllowed } : {}),
    ...(typeof value.textBoxEditing === "boolean" ? { textBoxEditing: value.textBoxEditing } : {}),
    ...(typeof value.bullets === "boolean" || value.bullets === null ? { bullets: value.bullets } : {}),
    pages: parsedPages as DocxPage[],
    caret: parsedCaret,
    ...(object ? { object } : {}),
    selection: parsedSelection as DocxRect[],
    collapsed, inTable, caretKey, anchorKey, paragraphText, caretOffset, history, format, formatAccess, trackedReadOnly: trackedReadOnly as boolean, hasToc: hasToc as boolean,
    tracking: tracking as boolean, hasRevisions: hasRevisions as boolean, font, fontGeneration: value.fontGeneration as number,
    ...(typeof value.selectionText === "string" ? { selectionText: value.selectionText } : {}),
    ...(typeof value.paragraphStyle === "string" ? { paragraphStyle: value.paragraphStyle } : {}),
  };
}

/** 세션 정보가 그 세션의 WordCraft 세션이어야 한다. */
const docxSession = (value: unknown, sessionId: SessionId): SessionInfo | null => {
  const session = parseSessionInfo(value);
  return session?.sessionId === sessionId && session.engine === "wordcraft" ? session : null;
};

export function parseDocxState(value: unknown, sessionId: SessionId): DocxState | null {
  if (!isRecord(value) || !hasExactly(value, ["session", "view"])) return null;
  const session = docxSession(value.session, sessionId);
  const view = parseDocxView(value.view);
  return session && view ? { session, view } : null;
}

export function parseDocxEdited(value: unknown, sessionId: SessionId, opCount: number): DocxEdited | null {
  if (!isRecord(value) || !hasExactly(value, ["session", "view", "applied", "rejected"])) return null;
  const session = docxSession(value.session, sessionId);
  const view = parseDocxView(value.view);
  const { applied, rejected } = value;
  if (!session || !view || !isCount(applied) || !Array.isArray(rejected)) return null;
  if (!rejected.every((index) => isCount(index) && index < opCount)) return null;
  if (new Set(rejected).size !== rejected.length || applied + rejected.length !== opCount) return null;
  return { session, view, applied, rejected: rejected as number[] };
}

const ROUND_TRIP_KEYS = ["sessionId", "revision", "bytes", "pages", "reopenedPages", "pagesEqual", "textEqual", "modelEqual", "passed"];

export function parseDocxRoundTrip(value: unknown, sessionId: SessionId, revision: number): DocxRoundTrip | null {
  if (!isRecord(value) || !hasExactly(value, ROUND_TRIP_KEYS)) return null;
  const { bytes, pages, reopenedPages, pagesEqual, textEqual, modelEqual, passed } = value;
  if (value.sessionId !== sessionId || value.revision !== revision) return null;
  if (!isCount(bytes) || !isCount(pages) || !isCount(reopenedPages)) return null;
  if (![pagesEqual, textEqual, modelEqual, passed].every((flag) => typeof flag === "boolean")) return null;
  // passed는 세 비교가 모두 참일 때만 참이다(백엔드 계약). 어긋나면 통과로 보지 않는다.
  if (passed !== (pagesEqual && textEqual && modelEqual)) return null;
  return { sessionId, revision, bytes, pages, reopenedPages, pagesEqual: pagesEqual as boolean, textEqual: textEqual as boolean, modelEqual: modelEqual as boolean, passed: passed as boolean };
}

/** 머리의 u64 하나(Number로 정확한 범위만). 모든 비트가 1이면 "쪽 전체"(-1). */
function readU64(view: DataView, at: number): number | null {
  const low = view.getUint32(at, true);
  const high = view.getUint32(at + 4, true);
  if (low === 0xffffffff && high === 0xffffffff) return -1;
  if (high >= 0x200000) return null; // Number로 정확하지 않음
  return high * 0x1_0000_0000 + low;
}

export function parseDocxRender(value: unknown): DocxRender | null {
  const raw = value instanceof ArrayBuffer ? new Uint8Array(value) : value instanceof Uint8Array ? value : null;
  if (!raw || raw.length < RENDER_HEADER_LEN) return null;
  const view = new DataView(raw.buffer, raw.byteOffset, RENDER_HEADER_LEN);
  const revision = readU64(view, 0);
  const base = readU64(view, 8);
  const y = view.getUint32(16, true);
  const height = view.getUint32(20, true);
  const png = raw.subarray(RENDER_HEADER_LEN);
  if (revision === null || revision < 0 || base === null || (base >= 0 && base > revision)) return null;
  // 쪽 전체는 PNG가 있어야 하고 첫 줄이 0, 띠는 줄 수가 0일 때만 PNG가 없다.
  if (base < 0 ? y !== 0 || height === 0 || png.length === 0 : (height === 0) !== (png.length === 0)) return null;
  return { revision, base: base < 0 ? null : base, y, height, png };
}

export function createDocxBackend(invoke: Invoke): DocxBackend {
  return {
    load: (sessionId, reloadGeneration) =>
      call(invoke, "docx_load", { sessionId, reloadGeneration: reloadGeneration ?? null }, (value) => parseDocxState(value, sessionId)),
    selectionText: (sessionId, loadGeneration, revision, anchorKey, caretKey) =>
      call(invoke, "docx_selection_text", { sessionId, loadGeneration, revision, anchorKey, caretKey }, value =>
        typeof value === "string" && value.length <= 2 * 1024 * 1024 && [...value].length <= 1024 * 1024 ? value : null),
    selectionTableCells: (sessionId, loadGeneration, revision, anchorKey, caretKey) =>
      call(invoke, "docx_selection_table_cells", { sessionId, loadGeneration, revision, anchorKey, caretKey }, value =>
        typeof value === "string" && value.length <= 2 * 1024 * 1024 ? value : null),
    selectionObject: (sessionId, loadGeneration, revision, position, epoch) =>
      call(invoke, "docx_selection_object", { sessionId, loadGeneration, revision, position, epoch }, value =>
        typeof value === "string" && value.length <= 12 * 1024 * 1024 ? value : null),
    view: (sessionId, loadGeneration) =>
      call(invoke, "docx_view", { sessionId, loadGeneration }, (value) => parseDocxState(value, sessionId)),
    edit: (sessionId, loadGeneration, baseRevision, ops) =>
      call(invoke, "docx_edit", { sessionId, loadGeneration, baseRevision, ops }, (value) => parseDocxEdited(value, sessionId, ops.length)),
    render: (sessionId, loadGeneration, revision, page, scale, base) =>
      call(invoke, "docx_render", { sessionId, loadGeneration, revision, page, scale, base: base ?? null }, (value) => {
        const parsed = parseDocxRender(value);
        return parsed && parsed.revision === revision ? parsed : null;
      }),
    roundTrip: (sessionId, loadGeneration, revision) =>
      call(invoke, "docx_roundtrip", { sessionId, loadGeneration, revision }, (value) => parseDocxRoundTrip(value, sessionId, revision)),
    preflight: (sessionId, loadGeneration) => call(invoke, "docx_preflight", { sessionId, loadGeneration }, parseSaveCheck),
    checkpoint: (sessionId, loadGeneration, revision) =>
      call(invoke, "docx_checkpoint", { sessionId, loadGeneration, revision }, (value) => {
        const outcome = parseSaveOutcome(value);
        return outcome?.session.sessionId === sessionId && outcome.session.loadGeneration === loadGeneration
          && outcome.session.revision === revision && outcome.durable ? outcome : null;
      }),
    exportPdf: (sessionId, loadGeneration, revision, destination, overwriteGrant) =>
      call(invoke, "docx_export_pdf", { sessionId, loadGeneration, revision, destination, overwriteGrant: overwriteGrant ?? null },
        (value) => { const parsed = parsePdfExported(value, sessionId, loadGeneration, revision); return parsed && !parsed.raster ? parsed : null; }),
    save: (sessionId, loadGeneration, revision, destination) =>
      call(invoke, destination === undefined ? "docx_save" : "docx_save_as", { sessionId, loadGeneration, revision, ...(destination === undefined ? {} : { destination }) }, (value) => {
        const outcome = parseSaveOutcome(value);
        return outcome?.session.sessionId === sessionId && outcome.session.revision >= revision ? outcome : null;
      }),
  };
}
