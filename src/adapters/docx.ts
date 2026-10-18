// WordCraft(DOCX) 세션 백엔드 클라이언트(T008, W-A). Tauri 명령 docx_load·docx_view·docx_edit·docx_render·docx_roundtrip을
// 부른다(Rust `src-tauri/src/adapters/wordcraft/`와 직렬화 형식이 같아야 한다).
//
// - 문서 모델은 백엔드에 있다. 프런트엔드는 보기(쪽 크기·커서·선택, pt 단위)와 쪽 그림(PNG)만 받고, 편집은 허용한 연산
//   (DocxOp)으로만 보낸다. 임의의 WordCraft 명령 ID는 보낼 수 없다(백엔드가 역직렬화에서 거부).
// - 수명주기·revision은 백엔드가 정한다. 응답의 세션 정보는 DocumentSessions.applyUpdate로 반영한다.
// - 응답은 신뢰 경계를 넘어온 값이므로 모양을 검사하고, 맞지 않으면 Protocol 오류로 다룬다(backend.ts와 같음).
import { call, type Invoke } from "./backend";
import { parseSessionInfo, type Result, type SessionId, type SessionInfo } from "./contract";

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
  collapsed: boolean;
  inTable: boolean;
  /** 커서·기준점 자리 키(`story:path:off`). 비교·검사용. */
  caretKey: string;
  anchorKey: string;
  /** 커서 문단의 글자(검사 훅 빌드에서만 화면 속성으로 노출). */
  paragraphText: string;
  /** 커서의 문단 안 위치(문자 단위). */
  caretOffset: number;
}

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

/** 허용한 편집·이동(백엔드 `DocxOp`). 좌표는 쪽 왼쪽 위 기준 pt. */
export type DocxOp =
  | { op: "insertText"; text: string }
  | { op: "backspace" }
  | { op: "deleteForward" }
  | { op: "newParagraph" }
  | { op: "tab"; back: boolean }
  | { op: "move"; to: MoveTarget; extend: boolean }
  | { op: "pointer"; page: number; x: number; y: number; extend: boolean; beforeInsert: boolean }
  | { op: "selectAll" }
  | { op: "mark"; id: number }
  | { op: "insertAt"; mark: number; text: string }
  | { op: "replaceInserted"; expected: string; text: string };

/** 한 요청의 연산 수 상한(백엔드 MAX_OPS와 같음). */
export const MAX_DOCX_OPS = 256;
/** docx_render 응답 머리 길이: revision u64, 기준 판 u64(모두 1이면 쪽 전체), 띠 첫 줄 u32, 줄 수 u32(LE). 백엔드와 같다. */
export const RENDER_HEADER_LEN = 24;

export interface DocxBackend {
  /** 엔진에 불러온다(identified·failed → ready). reloadGeneration이 있으면 그 시도의 ready 모델을 버리고 다시 불러온다. */
  load(sessionId: SessionId, reloadGeneration?: number): Promise<Result<DocxState>>;
  view(sessionId: SessionId, generation: number): Promise<Result<DocxState>>;
  edit(sessionId: SessionId, generation: number, baseRevision: number, ops: DocxOp[]): Promise<Result<DocxEdited>>;
  /** 쪽 그림. scale은 pt당 픽셀, base는 이미 가진 같은 배율 그림의 판(있으면 바뀐 띠만 받는다). */
  render(sessionId: SessionId, generation: number, revision: number, page: number, scale: number, base?: number): Promise<Result<DocxRender>>;
  roundTrip(sessionId: SessionId, generation: number, revision: number): Promise<Result<DocxRoundTrip>>;
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

const VIEW_KEYS = ["pages", "caret", "selection", "collapsed", "inTable", "caretKey", "anchorKey", "paragraphText", "caretOffset"];

export function parseDocxView(value: unknown): DocxView | null {
  if (!isRecord(value) || !hasExactly(value, VIEW_KEYS)) return null;
  const { pages, caret, selection, collapsed, inTable, caretKey, anchorKey, paragraphText, caretOffset } = value;
  if (!Array.isArray(pages) || pages.length === 0 || !Array.isArray(selection)) return null;
  const parsedPages = pages.map(parsePage);
  const parsedSelection = selection.map(parseRect);
  const parsedCaret = caret === null ? null : parseCaret(caret);
  if (parsedPages.some((page) => page === null) || parsedSelection.some((rect) => rect === null)) return null;
  if (caret !== null && parsedCaret === null) return null;
  const pageCount = parsedPages.length;
  // 커서·선택은 있는 쪽만 가리킨다.
  if ((parsedCaret && parsedCaret.page >= pageCount) || parsedSelection.some((rect) => rect!.page >= pageCount)) return null;
  if (typeof collapsed !== "boolean" || typeof inTable !== "boolean") return null;
  if (typeof caretKey !== "string" || typeof anchorKey !== "string" || typeof paragraphText !== "string" || !isCount(caretOffset)) return null;
  return {
    pages: parsedPages as DocxPage[],
    caret: parsedCaret,
    selection: parsedSelection as DocxRect[],
    collapsed, inTable, caretKey, anchorKey, paragraphText, caretOffset,
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
  };
}
