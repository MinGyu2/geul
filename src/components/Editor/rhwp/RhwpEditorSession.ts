import { POSITION_PRESETS, objectEditMatches, objectEditRequest, pictureResizeMatches, type MutatingObjectOperation, type ObjectEditRequest, type ObjectOperation, type ObjectSelection, type PictureResizeRequest } from "../../../commands/objectSelection";
import { hitRhwpObject, type CellPictureAddress } from "./objectHit";
import { parseGraphicProperties } from "../../../commands/graphicProperties";
import { inspectRhwpPicture } from "./pictureProperties";
import { hexToBgr, inspectRhwpCurveTerminalLine, inspectRhwpGroup, inspectRhwpGroupFills, inspectRhwpShape, inspectRhwpShapePath } from "./shapeProperties";
import { extractHwpxPortableObject, insertHwpxPortableObject, readHwpxPictureCaption } from "./hwpxPortableClipboard";
import { runClipboard, validClipboardText, type ClipboardCommand, type PlainClipboard } from "../../../commands/clipboard";
import {
  OBJECT_CLIPBOARD_MIME, createHwpObjectClipboardPayload, createHwpxObjectClipboardPayload,
  objectClipboardPlainText, parseObjectClipboardPayload, type RichObjectKind,
} from "../../../commands/objectClipboard";
import {
  TABLE_CLIPBOARD_MIME, buildTableClipboardPlainText, parseTableClipboardPayload,
} from "../../../commands/tableClipboard";
// rhwp 편집 세션 하나(T007, R-A). WebView의 WASM 문서 모델·커서·선택·IME 조합 상태를 가지고, 문서를 바꾼 결과를
// 백엔드에 revision으로 확정한다.
//
// 소유와 순서(docs/architecture/editor-surface-decision.md "T007 결과"):
// - 세션 ID·수명주기·revision의 권한은 백엔드(SessionRegistry)에 있다. 이 객체는 세션마다 하나뿐인 쓰는 쪽이며,
//   WASM 호출은 JS 스레드에서 동기로 끝나므로 같은 세션의 변경은 일어난 순서대로 하나씩 적용된다.
// - 변경이 성공하면 pending을 1 늘리고, 확정은 한 번에 하나만 보낸다(base = 백엔드가 마지막으로 확인한 revision,
//   count = 그 뒤 성공한 변경 수). 응답을 기다리는 동안의 변경은 다음 확정에 묶인다. 그래서 확정이 순서를 바꿔
//   도착하거나 중복될 수 없고, revision은 성공한 변경마다 정확히 1씩 는다(다시 그리기·선택·실패한 변경은 확정 안 함).
// - reload 시작·dispose마다 로컬 epoch를 바꾼다. commit dispatcher와 모든 비동기 응답은 그 epoch에만 속하며,
//   옛 epoch의 결과·finally는 새 모델·대기열·확정 소유권·세션 투영을 바꾸지 않는다.
// - 불러오기 시도마다 백엔드가 번호(loadGeneration)를 주고, 그 시도의 상태 전이·확정은 이 번호를 함께 보낸다. 옛 시도의
//   요청은 백엔드가 StaleLoad로 거부한다. 엔진이 문서를 읽고(parse) 올바른 페이지 정보까지 얻은 뒤에야(render 준비)
//   ready를 요청한다. 백엔드의 형식 판별은 컨테이너 확인일 뿐 문서 내용이 올바르다는 증거가 아니다.
// - 백엔드가 확정을 거부하면(RevisionMismatch·InvalidState) 모델이 기록과 어긋났다고 보고 세션을 failed로 돌린다.
//   닫힌 세션(StaleSession·UnknownSession)이면 모델을 버린다. 엔진 편집 함수가 예외를 던지면 일부만 바뀌었을 수 있다
//   (예: 선택 지우기는 됐고 넣기가 실패; 엔진은 되돌리기를 보장하지 않음). 그 변경은 성공으로 세거나 확정하지 않고
//   (revision을 올리지 않음) 모델을 '알 수 없게 바뀜'(uncertain)으로 표시해 편집을 멈추고 failed로 돌린다. 이 모델은
//   수정한 모델처럼 보호한다(버리기 확인 없이 닫거나 다시 불러오지 않음).
//   엔진 변경은 성공했는데 그 뒤 화면 갱신 준비(페이지 정보)·그리기가 실패하면, 변경은 이미 모델에 있으므로 세고
//   (확정 대기열에 넣음) 편집을 멈춘다.
// - 편집을 멈추면(failed) 백엔드에 ready·loading → failed 전이를 보낸다. 다시 불러오기는 그 전이의 결과를 먼저 확인한
//   뒤에만 옛 모델을 놓고 document_load를 보낸다(백엔드가 아직 ready면 불러오기를 InvalidState로 거부하므로). 전이가
//   오류면 한 번 다시 보내 확인하고, 그래도 확인하지 못하면 모델을 놓지 않은 채 그 오류로 끝낸다(`settleFailure`).
//   불러오는 중 엔진이 실패해 보내는 `loading → failed` 전이도 같은 기록(`FailureTransition`)이다(6차): 전이가 거부돼
//   백엔드가 loading에 남았을 수 있으면 다음 reload가 먼저 확인한다(`begin_load`는 identified·failed만 받음).
// - 화면 bitmap 픽셀 예산(renderBudget.ts)은 그리는 배율에 대한 것이다. 배율·DPR 때문에 넘으면 엔진 실패가 아니라 표시
//   한도(`renderLimit`)다: 그리지 않고 편집만 멈추며, 예산 안의 배율로 돌아오면 그대로 이어 간다(모델·revision 그대로).
//   지원하는 가장 작은 배율로도 넘는 문서만 ready 전에 RenderLimit으로 거부한다(문서 손상과 구분).
// - 저장이 없으므로(T009) 편집한 모델(확정했거나 확정 대기·조합 중인 변경)은 닫기·다시 불러오기 전에 사용자가
//   버리기를 명시해야 한다(`hasUnpreservedChanges`, `load({ discard })`).
// - IME 조합 중에는 조합 문자열을 문서에 바로 넣어 보여 주고(rhwp-studio와 같은 방식), 조합이 끝날 때 한 번만 변경으로
//   센다. 조합이 글자 없이 끝나면(취소) 넣었던 글자를 지우므로 변경이 아니다. 선택을 지우고 시작한 조합은 변경이다.
//   조합의 기록(지운 선택·조합 글자)은 엔진 호출이 성공한 뒤에만 바꾸므로, 세는 것은 성공한 엔진 변경뿐이다. 조합 중
//   엔진 호출이 예외를 던지면 그 조합은 세지 않고 끝난다(uncertain). 편집이 다른 이유로 멈추면(화면 갱신 실패·백엔드
//   거부) 그때까지 성공한 조합 변경을 한 번 센다. 끝난 조합은 다시 세지 않는다.
// - 저장은 없다(T009). 내보내기 검사는 메모리에서만 내보내고 다시 열어 비교한다(파일을 쓰지 않음).
// - 명령(T010, src/commands/): 저장(save())과 실행 취소·다시 실행(undo()·redo(), T010 Phase 2). 고정 rhwp에는 엔진이 가진 실행 취소
//   기록이 없어, 문서·스냅숏 내용은 엔진이 갖고 이 세션의 RhwpHistory(rhwpHistory.ts)가 스냅숏 ID·시간선·커서 체크포인트·타자 그룹만
//   조정한다(문서 모델은 하나). 일반 기록과 선택 글자 서식은 제품 capability이며 실제 세션의 IME·기록·소유권·원본 보존 조건으로
//   가용성을 정한다. HWP는 원본 문자 모양을 파생 직렬화할 수 있어야 한다. 저장은 T009 전체 검증을 다시 통과해야 한다.
import { sha256 } from "./rhwpArtifactIdentity";
import { HWP_TABLE_NORMALIZATION, hwpReopenModel, hwpReopenEqual, cellPictureEvidence, insertedBasicTable, insertedInlinePicture, insertedCellPicture, insertedNestedTable } from "./hwpReopenModel";
import { trace } from "../imeTrace";
import type { DocumentBackend, PreviewRaster, ReopenEvidence } from "../../../adapters/backend";
import { capturePreviewRaster } from "./previewRaster";
import { FormulaCacheRefusal } from "./formulaDependencies";
import type { DocumentError, PdfExported, Result, SaveCheck, SaveOutcome, SessionInfo } from "../../../adapters/contract";
import { capturePdfPages, type EncodePng } from "./pdfCapture";
import { naturalFonts, type NaturalBinding, type NaturalFontService, type NaturalLease } from "../../../fonts/naturalFonts";
import { embedFontData } from "../../../fonts/embedding";
import { blockedBy, reportDetachedSaveRejection, type SaveCheckRecord, type SaveState } from "../saveState";
import { documentCommandState, FORMAT_FLAG } from "../../../commands/capability";
import { commandDefinition, type DocumentCommandId } from "../../../commands/registry";
import type {
  CharFormatFlag, CommandDispatch, CommandParameterContext, DocumentCommandArgs, DocumentCommandSnapshot, DocumentCommandTarget,
  EmbedFontResult, EmbeddedFont, ParameterCommandId,
} from "../../../commands/target";
import { documentFontTable, existingFontFamilies, resolveExistingFontIds } from "./rhwpFonts";
import { fontFamilyProblem } from "../../../commands/parameters";
import { validateCommandArgs } from "../../../commands/parameters";
import { ALIGN_COMMANDS, HIGHLIGHT_COLORS, validSearchRequest, type AlignCommandId, type ParagraphAlign, type ListState, type ListStyle, type PageState, type PaperName, type ParagraphState, type SearchOptions, type SearchRequest } from "../../../commands/stage1";

/** Paper sizes in points (portrait), as offered by the shared page setup commands. */
/** Upper bound of the engine's search result JSON (≈ 250k hits). Beyond it the search is reported incomplete and
 * replace-all is refused before mutation (never a partial "replace all"). */
const MAX_SEARCH_JSON = 16 * 1024 * 1024;
/** Replace-all bound: each engine text edit re-paginates (measured ≈ 5 ms per replacement on the Release WASM, growing
 * with paragraph length), so larger sets are refused as a whole before any mutation instead of freezing the editor or
 * replacing only a part. The search count and navigation stay complete. */
export const MAX_RHWP_REPLACE_ALL = 500;

/** Numbering templates (HWP level format strings and number format codes: 0 digit, 2/3 upper/lower roman, 4/5 upper/lower
 * latin, 8 hangul syllable). Each is created at most once per session through the engine's createNumbering. */
const RHWP_NUMBERING = {
  numbered: { formats: ["^1.", "^2.", "^3.", "^4.", "^5.", "^6.", "^7."], codes: [0, 5, 3, 0, 5, 3, 0] },
  numberedParen: { formats: ["^1)", "^2)", "^3)", "^4)", "^5)", "^6)", "^7)"], codes: [0, 5, 3, 0, 5, 3, 0] },
  upperLetter: { formats: ["^1.", "^2.", "^3.", "^4.", "^5.", "^6.", "^7."], codes: [4, 5, 3, 4, 5, 3, 4] },
  lowerLetter: { formats: ["^1)", "^2)", "^3)", "^4)", "^5)", "^6)", "^7)"], codes: [5, 3, 0, 5, 3, 0, 5] },
  lowerRoman: { formats: ["^1.", "^2.", "^3.", "^4.", "^5.", "^6.", "^7."], codes: [3, 5, 0, 3, 5, 0, 3] },
  outline: { formats: ["^1.", "^2.", "^3.", "^4.", "^5.", "^6.", "^7."], codes: [2, 4, 0, 5, 3, 0, 5] },
  multilevel: { formats: ["^1.", "^1.^2.", "^1.^2.^3.", "^1.^2.^3.^4.", "^1.^2.^3.^4.^5.", "^1.^2.^3.^4.^5.^6.", "^1.^2.^3.^4.^5.^6.^7."], codes: [0, 0, 0, 0, 0, 0, 0] },
} as const;
/** Custom bullet characters (engine ensureDefaultBullet reuses an existing definition of the same character). */
type NumberingDef = { levelFormats: string[]; numberFormats: number[] | null; startNumber: number | null };
const RHWP_BULLETS = { bulletCircle: "○", bulletSquare: "▪", bulletDash: "–", bulletCheck: "✓" } as const;

const HWP_PAPER: Record<PaperName, [number, number]> = {
  "A3": [841.89, 1190.55], "A4": [595.28, 841.89], "A5": [419.53, 595.28], "B4 (JIS)": [728.5, 1031.8], "B5 (JIS)": [515.9, 728.5],
  "Letter": [612, 792], "Legal": [612, 1008],
};
import type { DocumentSessions } from "../../../adapters/sessions";
import { summarizeLayerTree } from "./paintDiff";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
import {
  captureCheckpoint, historyBudget, HistoryFailure, HistoryRefused, placeCheckpoint, RhwpHistory, type HistoryKind,
} from "./rhwpHistory";
import { ZOOM_STEPS } from "../../../hooks/layoutState";
import { fitsRenderBudget, MAX_PAGE_EXTENT } from "./renderBudget";
export { MAX_PAGE_EXTENT } from "./renderBudget";
import {
  applyTablePlan, cellCovering, hasOrdinarySplitApi, hasTableStructureApi, ordinarySplitLimits, ordinarySplitValid, planTableOp, readTableGrid,
  RHWP_BORDER_STYLES, RHWP_BORDER_WIDTHS_MM, rhwpBorderCodeToStyle, rhwpBorderIndexToWidth, rhwpBorderStyleToCode, rhwpBorderWidthToIndex,
  tableCellWidth, tableContentRefusal, tableOpRefusal, tableTargetPathJson,
  rectangularRange, TABLE_STRUCTURE_OPS, type CellRange, type CellSplit, type TableGrid, type TableStructureOp, type TableStructureRefusal, type TableTarget,
} from "./tableStructure";
import {
  charCount,
  compare,
  contextKey,
  paragraphOf,
  parsePosition,
  RhwpText,
  sameContext,
  sameTable,
  pathJson,
  MAX_TABLE_DEPTH,
  MAX_CREATED_TABLE_DEPTH,
  innermost,
  withCell,
  withParagraph,
  type CaretRect,
  type DocPosition,
  type PageRect,
} from "./rhwpText";

export type EditorStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "failed"; error: DocumentError; cleanupFailed?: true }
  | { kind: "closed" };

export interface PageSize {
  width: number;
  height: number;
}

export interface RoundTripReport {
  format: "hwp" | "hwpx";
  /** 끝까지 비교하지 못한 단계(null이면 비교까지 마침). */
  failure: "export" | "reopen" | null;
  bytes: number;
  /** 다시 연 문서에 엔진이 매긴 원본 형식(getSourceFormat). 묻지 못했으면 null. */
  reopenedFormat: string | null;
  /**
   * 다시 연 문서가 요청한 형식인지: 엔진이 매긴 형식이 같고 내보낸 바이트가 그 형식의 컨테이너 서명으로 시작한다.
   * (rhwp getSourceFormat은 HWPX·HML이 아닌 것을 모두 "hwp"라고 하므로 HWP 5 CFB 서명을 함께 본다.)
   */
  formatEqual: boolean;
  /** 엔진의 손실 보고가 계약 모양({count, losses[]}, count = losses 수)인지. 아니면 lossCount는 -1. */
  lossValid: boolean;
  lossCount: number;
  losses: unknown[];
  pagesEqual: boolean;
  textEqual: boolean;
  controlsEqual: boolean;
  /** 손실 보고가 올바르고 0건이며 다시 연 형식과 쪽 수·본문·컨트롤 배치가 모두 같을 때만 true. */
  passed: boolean;
}

export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

/** 엔진 모델을 바꾸고 새 커서(선택 없음) 또는 새 커서·선택 기준점을 돌려준다. */
type Mutation = () => DocPosition | { caret: DocPosition; anchor: DocPosition };

/** 진행 중인 IME 조합. 필드는 엔진 호출이 성공한 뒤에만 바꾼다(모델에 실제로 있는 것). */
interface Composition {
  anchor: DocPosition;
  /** 지금 모델의 조합 범위에 있는 글자. */
  text: string;
  /** 조합을 시작하며 선택을 지웠다(성공). */
  deletedSelection: boolean;
}

/** 백엔드에 보낸 failed 전이 하나(markFailed). 다시 불러오기가 그 결과를 확인한다. */
interface FailureTransition {
  generation: number;
  from: "loading" | "ready";
  result: Promise<Result<SessionInfo>>;
}

const LOADED = { ok: true, value: null } as const;

/** 지원하는 가장 작은 화면 배율(zoom 최소값, devicePixelRatio 1 기준). 이것으로도 예산을 넘으면 표시할 수 없다. */
const MIN_DISPLAY_SCALE = ZOOM_STEPS[0] / 100;

/** failed 전이가 거부됐지만 백엔드가 이미 이 불러오기 시도를 ready·loading으로 두지 않음(다시 불러와도 됨). */
const failureAcknowledged = (error: DocumentError) =>
  error.code === "StaleLoad" || (error.code === "InvalidState" && error.state === "failed");

/** 엔진 손실 보고(JSON)를 엄격히 읽는다. 모양이 다르면 null(통과로 보지 않음). */
function parseLoss(json: string): { count: number; losses: unknown[] } | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { count, losses } = value as { count?: unknown; losses?: unknown };
  if (!Number.isSafeInteger(count) || (count as number) < 0 || !Array.isArray(losses)) return null;
  return losses.length === count ? { count: count as number, losses } : null;
}

/**
 * 페이지 한 변의 최대 길이(배율 1, CSS px). rhwp가 canvas 한 변에 허용하는 최대값(wasm_api.rs MAX_CANVAS_DIMENSION)과
 * 같다. 이보다 큰 페이지는 엔진이 100%로도 그리지 못하므로(배율을 낮춰 그림) 편집 가능한 표면으로 내놓지 않는다.
 */
const isPageExtent = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_PAGE_EXTENT;

/**
 * 문서의 페이지 크기 목록. 엔진 오류는 그대로 던지고, 계약에 맞지 않는 값도 던진다(호출하는 쪽이 단계별 실패로 다룸).
 * - 쪽 수는 1 이상의 정수다(rhwp page_count는 빈 문서도 1을 돌려준다). 쪽마다 엔진에 실제로 묻으므로 쪽 수에 따른
 *   할당은 엔진이 가진 페이지만큼이다(임의의 쪽 수 상한은 두지 않음).
 * - 쪽 정보는 JSON 객체이고 pageIndex가 그 쪽 번호, width·height가 유한한 양수(MAX_PAGE_EXTENT 이하)다. 0·빈 값으로
 *   바꿔 넣지 않는다.
 * - bitmap 픽셀 예산은 여기서 보지 않는다(페이지 정보가 올바른지와 별개, 그리는 배율에 따라 다름).
 */
function readPages(doc: RhwpDocument): PageSize[] {
  const started = import.meta.env.VITE_GEUL_TEST_HOOKS === "1" ? performance.now() : 0;
  const count = doc.pageCount();
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("page count");
  const pages: PageSize[] = [];
  // 쪽 번호 계약(고정 rhwp `get_page_info_native`·`find_page`, T010 Phase 2 안정화 실측): 인자 `page`와 그리기·hit test·커서·선택
  // 사각형의 pageIndex는 문서 전체의 물리 순번이고, getPageInfo가 돌려주는 pageIndex는 그 쪽이 속한 구역(sectionIndex) 안의 순번
  // (구역마다 0부터)이다. pageNumber는 보이는 쪽 번호(번호 다시 시작 등)라 검사하지 않는다. 그래서 구역은 줄지 않는 정수로 이어지고,
  // 한 구역의 쪽은 붙어 있으며, 구역 안 순번은 그 구역 첫 쪽에서 0으로 시작해 1씩 는다. 이 모양이 아니면 쪽 정보로 쓰지 않는다.
  let section = -1;
  let local = -1;
  for (let page = 0; page < count; page++) {
    const info: unknown = JSON.parse(doc.getPageInfo(page));
    if (typeof info !== "object" || info === null || Array.isArray(info)) throw new Error("page info");
    const { pageIndex, sectionIndex, width, height } = info as { pageIndex?: unknown; sectionIndex?: unknown; width?: unknown; height?: unknown };
    if (!Number.isSafeInteger(sectionIndex) || (sectionIndex as number) < Math.max(section, 0)) throw new Error("page info");
    local = sectionIndex === section ? local + 1 : 0;
    section = sectionIndex as number;
    if (pageIndex !== local || !isPageExtent(width) || !isPageExtent(height)) throw new Error("page info");
    pages.push({ width, height });
  }
  trace("rhwp:readPages", () => ({ ms: performance.now() - started }));
  return pages;
}

/** 내보낸 바이트가 요청한 형식의 컨테이너 서명으로 시작하는지(HWP 5: CFB, HWPX: ZIP). */
const SIGNATURES = {
  hwp: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  hwpx: [0x50, 0x4b, 0x03, 0x04],
} as const;
const hasSignature = (bytes: Uint8Array, format: "hwp" | "hwpx") =>
  SIGNATURES[format].every((byte, index) => bytes[index] === byte);

const START: DocPosition = { section: 0, paragraph: 0, offset: 0 };
const HWPX_WRAPS = { square: "Square", tight: "Tight", through: "Through", topAndBottom: "TopAndBottom", behindText: "BehindText", inFrontOfText: "InFrontOfText" } as const;
const MAX_SAMPLES = 1000;

/** General typing history declaration (an "advanced" scope would restrict the session to the T012 timeline). */
const RHWP_HISTORY_DECLARED = (["edit.undo", "edit.redo"] as const)
  .every((id) => {
    const support = commandDefinition(id)?.engines?.rhwp;
    return support?.level === "supported" && support.historyScope !== "advanced";
  });

/** 레지스트리가 rhwp 글자 서식을 지원으로 선언했는지(제품 capability — registry.ts `RHWP_FORMAT`). */
const RHWP_FORMAT_DECLARED = (["format.bold", "format.italic", "format.underline", "format.strikethrough"] as const)
  .every((id) => commandDefinition(id)?.engines?.rhwp.level === "supported");

/** Legacy advanced-only timeline bounds. Production general history instead uses
 * historyBudget + measured WASM growth; formula projection has its own V+E budget.
 * Neither policy replaces the original D4 latency result. */
export const ADVANCED_MAX_SOURCE_BYTES = 128 * 1024;
export const ADVANCED_MAX_PAGES = 8;
export const ADVANCED_HISTORY_DEPTH = 4;

export class RhwpEditorSession implements DocumentCommandTarget {
  readonly engine = "rhwp" as const;
  status: EditorStatus = { kind: "idle" };
  pages: PageSize[] = [];
  caret: DocPosition = START;
  anchor: DocPosition = START;
  /** 모델이 바뀔 때마다 는다(다시 그리기 판단용, revision과 무관). */
  modelVersion = 0;
  /** Derived relayout/repaint without a model change (natural font binding, font availability); the surface repaints on it. */
  layoutVersion = 0;
  /** 첫 페이지를 그리기까지 걸린 시간(바이트를 받은 뒤부터, ms). */
  firstPaintMs: number | null = null;
  loadStartedAt = 0;
  lastRoundTrip: RoundTripReport | null = null;
  /** Load-time HWP reopen model of the original: structural inventory + whether its evidence was complete. */
  private hwpBaseline: { structure: string; complete: boolean } | null = null;
  private borderFillBaseline: number | null = null;
  /**
   * Original-document T009 preflight for HWP structural eligibility, owned by `originalOwner()`
   * (epoch, load generation, publication count). null = unchecked for the current owner.
   */
  private hwpOriginal: { owner: string; state: "checking" | "safe" | "blocked" | "error"; check?: SaveCheck; serial?: number } | null = null;
  /** Bumped when a publication replaces the original on disk (a new original identity). */
  private originalSerial = 0;
  /** Instrumentation: eligibility probes started by this session. */
  hwpOriginalProbes = 0;
  /** 마지막 저장 시도의 결과(T009, 화면 표시). */
  saveState: SaveState = { kind: "idle" };
  /** 이 원본에 대한 보존 사전 검사(T009). 다시 불러오거나 저장하면(원본이 바뀜) 버린다. */
  saveCheck: SaveCheckRecord | null = null;
  /**
   * 사전 검사 요청의 소유 번호(T009 안정화). 새 검사·저장 성공·다시 불러오기·닫기마다 올린다. 결과는 그 번호가 그대로일
   * 때만 기억·표시한다(겹친 검사 중 늦게 끝난 옛 요청, 저장 전 원본에 대한 검사가 새 상태를 덮지 못함).
   */
  private checkSerial = 0;
  /**
   * 표면이 요청한 배율(zoom × devicePixelRatio)이 픽셀 예산을 넘어 그리지 않는 동안 그 배율, 아니면 null. 모델은 정상이며
   * 편집만 멈춘다. 예산 안의 배율로 다시 그리면(prepareRendering) null로 돌아온다.
   */
  renderLimit: number | null = null;

  private doc: RhwpDocument | null = null;
  private selectedObject: { selection: ObjectSelection; model: number; layout: number; owner: number; pictureAddress?: readonly [number, number, number]; cellPicture?: CellPictureAddress; shapeAddress?: readonly [number, number, number]; groupAddress?: readonly [number, number, number]; chartAddress?: readonly [number, number, number]; copyControl?: { kind: RichObjectKind; address: readonly [number, number, number] } } | null = null;
  private objectEpoch = 0;
  private lastCopiedObjectToken: string | null = null;

  get objectSelection(): ObjectSelection | null {
    const selected = this.selectedObject;
    if (this.status.kind !== "ready" || !selected || selected.owner !== this.epoch
      || selected.model !== this.modelVersion || selected.layout !== this.layoutVersion
      || selected.selection.revision !== this.committed + this.pending) return null;
    return selected.selection;
  }
  private readonly renderCanvases = new Set<HTMLCanvasElement>();
  private text: RhwpText | null = null;
  /** 쪽 좌표는 zoom/DPR와 무관하다. 모델·문서 소유자·전체 위치가 같을 때만 마지막 성공 질의를 재사용한다. */
  private caretCache: { text: RhwpText; version: number; position: string; value: CaretRect } | null = null;
  /** Bumped by every change that can move paragraphs, cells or controls (anything but in-paragraph typing). */
  private structureVersion = 0;
  /** Nested-cell paths proven against the current model's cursor lists (T012 Phase 2). */
  private nestedProof: { text: RhwpText; version: number; owned: Map<string, boolean> } | null = null;
  private tableCache: { text: RhwpText; version: number; key: string; grid: TableGrid | TableStructureRefusal; content: TableStructureRefusal | null } | null = null;
  private module: RhwpModule | null = null;
  private preferredX = -1;
  private committed = 0;
  private pending = 0;
  private committingEpoch: number | null = null;
  /** 로컬 비동기 작업 소유권. reload 시작(백엔드 응답 전)·dispose에서 무효화한다. */
  private epoch = 0;
  private imeSerial = 0;
  private readonly imeTargets = new WeakMap<object, { at: DocPosition; epoch: number; version: number }>();
  get imeEpoch() { return this.imeSerial; }
  /** 지금 모델을 만든 불러오기 시도 번호(백엔드가 준 값, 0 = 없음). */
  private generation = 0;
  /** 지금 모델을 불러온 뒤 문서를 바꾼 적이 있음(성공한 변경, 확정 여부와 무관, 실패해도 유지). */
  private modified = false;
  /** 엔진 편집 함수가 예외를 던져 모델이 일부만 바뀌었을 수 있음(성공한 변경으로 세지 않음). */
  private uncertain = false;
  private loadingPromise: Promise<Result<null>> | null = null;
  /** 지금 모델의 실패를 백엔드에 알린 전이(다시 불러오기 전에 확인할 것). 확인했거나 보낸 적 없으면 null. */
  private failure: FailureTransition | null = null;
  private closing = false;
  private disposed = false;
  private saving = false;
  /** Secondary engine cleanup failures; never replace the backend publication result. */
  readonly saveCleanupErrors: unknown[] = [];
  /** Raw backend Promise rejections during a save; the adapter normally turns transport failures into Protocol results. */
  readonly saveTransportErrors: unknown[] = [];

  private saveCleanupFailed(error: unknown, epoch: number) {
    this.saveCleanupErrors.push(error);
    if (!this.owns(epoch)) return;
    this.uncertain = true;
    this.checkSerial += 1;
    this.saveCheck = null;
    this.failEditing();
  }

  /**
   * 저장의 결과가 이미 정해진 뒤의 동기 알림. 구독자는 그 안에서 세션을 닫거나 다시 불러올 수 있고(`dispose`는 정리 오류를 던진다),
   * 그 예외가 게시 결과를 가리지 않게 부차 오류로 남긴다. 부른 쪽은 이 뒤에 소유권을 다시 확인한다.
   */
  private notifyAfterSaveResult(notify: () => void) {
    try { notify(); } catch (error) { this.saveCleanupErrors.push(error); }
  }

  private composition: Composition | null = null;
  /** 앱이 먼저 끝낸 보이는 조합(클릭·초점 잃음·표면 사라짐). 글자는 모델에 있고, 입력기의 끝을 기다리며 아직 세지 않았다. */
  private provisional: Composition | null = null;
  /** 입력기의 빈 끝 뒤 최종 글자를 기다림(ImeInput이 정함, T010 IME 경계). 모델을 놓으면(다시 불러오기·닫기) 버린다. */
  private awaiting = false;
  /**
   * 실행 취소 기록(T010 Phase 2, rhwpHistory.ts, docs/architecture/rhwp-undo-redo.md). 문서 내용·스냅숏은 엔진이 갖고 이것은 스냅숏
   * ID·시간선·커서 체크포인트·타자 그룹만 든다. 문서를 열 때 새로 만들고 놓을 때(다시 불러오기·닫기)·편집을 멈출 때 비운다.
   */
  private history: RhwpHistory | null = null;
  /** 기록이 없는 까닭: 문서가 예산 밖(limit) 또는 기록을 쓸 수 없게 됨(unavailable). 기록이 있거나 문서가 없으면 null. */
  private historyOff: "limit" | "unavailable" | null = null;
  /** Source size outside the legacy advanced-only timeline bound. */
  private advancedSourceLimited = false;
  /** 성공한 전체 그리기만 기억한다. 입력·쪽 크기·bitmap·배율이 모두 같을 때만 생략한다. */
  private drawnAt = new WeakMap<HTMLCanvasElement, {
    page: number; scale: number; width: number; height: number;
    bitmapWidth: number; bitmapHeight: number; painted: string | null; model: number; layout: number;
  }>();
  private readonly samples: number[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly sessionId: number,
    private readonly backend: DocumentBackend,
    private readonly sessions: DocumentSessions,
    private readonly loadModule: () => Promise<RhwpModule>,
    /** history: 실행 취소 기록을 켤지. 없으면 레지스트리가 rhwp 실행 취소·다시 실행을 지원으로 선언했을 때만(빌드 때 정해짐). */
    /** format: 글자 서식 명령을 받을지. 없으면 레지스트리 선언(시험 활성화 빌드만). */
    /** natural: Stage 5-A natural-metric binder (default: the application's; null disables binding). */
    private readonly options: { history?: boolean; format?: boolean; natural?: NaturalFontService | null } = {},
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private clipboardVersion = 0;
  private changeVersion = 0;
  readonly changeSnapshot = (): number => this.changeVersion;

  private emit() {
    this.changeVersion += 1;
    if (this.naturalCheckedVersion !== this.modelVersion) this.checkNaturalKeys();
    this.resumeDeferredNaturalFonts();
    for (const listener of this.listeners) listener();
  }

  /** 백엔드가 확인한 revision + 아직 확정하지 않은 변경 수. */
  get localRevision() {
    return this.committed + this.pending;
  }

  /** True only when general typing/IME history is not declared (or a session explicitly opts out). */
  get advancedHistoryOnly(): boolean {
    return !(this.options.history ?? RHWP_HISTORY_DECLARED);
  }

  get hasAdvancedHistory(): boolean {
    return this.advancedHistoryOnly && this.history !== null;
  }

  get editable() {
    return this.status.kind === "ready" && this.doc !== null && !this.closing && this.renderLimit === null;
  }

  /** 닫는 중에는 편집을 막는다(백엔드 닫기가 실패하면 false로 되돌려 다시 편집할 수 있다). */
  setClosing(closing: boolean) {
    if (this.closing === closing || this.disposed) return;
    if (closing) {
      this.imeSerial += 1;
      // preedit은 WASM 문서 모델에 있으므로 닫기 실패를 대비해 실제 범위를 지운다.
      if (this.composition) this.endComposition("");
      if (this.provisional) this.resolveProvisional("");
      // 사용자가 버리기를 확인했거나 버릴 것이 없을 때만 닫는다: 기다리던 최종 글자는 넣지 않는다(닫기가 실패해도 되살리지 않음).
      this.awaiting = false;
    }
    this.closing = closing;
    this.emit();
  }

  get composing() {
    return this.composition !== null;
  }

  get awaitingCommit() {
    return this.awaiting;
  }

  setAwaitingCommit(awaiting: boolean): void {
    if (this.awaiting === awaiting) return;
    this.clipboardVersion += 1;
    this.awaiting = awaiting;
    this.emit();
  }

  /** ImeInput의 같은 거래 취소 증거를 받은 경우만 허용한다(명령 경계에서는 호출하지 않음). */
  confirmCompositionCancellation(): boolean {
    if (!this.awaiting || this.composition || this.provisional || !this.editable || this.uncertain) return false;
    this.setAwaitingCommit(false);
    return true;
  }

  imeDiagnostics(): Record<string, number | boolean> {
    return { session: this.sessionId, generation: this.generation, revision: this.localRevision,
      provisional: this.provisional !== null, historyTransaction: this.history?.transactionOpen ?? false,
      historyUndo: this.history?.steps.undo ?? 0, historyRedo: this.history?.steps.redo ?? 0,
      pendingCommit: this.pending > 0 || this.committingEpoch === this.epoch };
  }

  /** 지금 조합 중인 글자(문서에 보이는 것). */
  get compositionText() {
    return this.composition?.text ?? "";
  }

  /** 지금 조합의 시작 위치. */
  get compositionAnchor(): DocPosition | null {
    return this.composition?.anchor ?? null;
  }

  /**
   * 저장하지 않은 편집이 있음: 백엔드 기록의 dirty(확정한 변경, 교체는 됐지만 내구성을 확인하지 못한 저장 — T009 3차 안정화,
   * SessionRegistry가 정한다), 또는 이 모델에서 불러온(또는 저장한) 뒤 바꾼 적이 있거나, 바뀌었는지 알 수 없거나(편집 중
   * 엔진 예외), 확정을 기다리거나 보내는 중이거나, 조합 중. 닫기·다시 불러오기는 저장(T009)하거나 사용자가 버리기를 명시해야
   * 한다. DOCX 편집 세션·작업 공간과 같은 기준이다.
   */
  get hasUnpreservedChanges() {
    return (this.sessions.get(this.sessionId)?.dirty ?? false) || (this.doc !== null
      && (this.modified || this.uncertain || this.pending > 0 || this.committingEpoch === this.epoch || this.imeUnsettled));
  }

  /**
   * 끝나지 않은 IME 트랜잭션: 조합 중, 앱이 먼저 확정한 조합(provisional), 빈 끝 뒤 입력기의 최종 글자를 기다림(awaiting, T010).
   * modified와 따로 본다(저장이 modified를 지운 뒤에 시작한 기다림도 보호).
   */
  private get imeUnsettled() {
    return this.composition !== null || this.provisional !== null || this.awaiting;
  }

  /** 엔진 편집이 예외로 끝나 모델이 바뀌었는지 알 수 없음(성공한 변경과 구분). */
  get hasUncertainChanges() {
    return this.doc !== null && this.uncertain;
  }

  get hasSelection() {
    return compare(this.anchor, this.caret) !== 0 || !sameContext(this.anchor, this.caret);
  }

  /**
   * 엔진에 문서를 불러온다(identified·failed에서). 동시에 두 번 부르면 같은 작업을 기다린다.
   * 지금 모델에 저장하지 않은 편집이 있으면 `discard: true` 없이는 아무것도 하지 않고 UnpreservedChanges를 돌려준다.
   * 편집을 멈추며 보낸 failed 전이가 끝나지 않았으면 그 결과를 먼저 확인하고, 확인한 뒤에만 지금 모델을 놓는다.
   */
  load(options: { discard?: boolean } = {}): Promise<Result<null>> {
    if (this.loadingPromise) return this.loadingPromise;
    if (this.hasUnpreservedChanges && !options.discard) {
      return Promise.resolve({ ok: false, error: { code: "UnpreservedChanges", sessionId: this.sessionId } });
    }
    const loading = this.runLoad().finally(() => {
      if (this.loadingPromise === loading) this.loadingPromise = null;
    });
    this.loadingPromise = loading;
    return loading;
  }

  private async runLoad(): Promise<Result<null>> {
    const closed = { ok: false, error: { code: "StaleSession", sessionId: this.sessionId } } as const;
    if (this.disposed) return closed;
    if (this.failure) {
      const settled = await this.settleFailure();
      if (settled) return settled;
    }
    const epoch = ++this.epoch;
    this.imeSerial += 1;
    this.naturalDeferred = false; // a deferred binding belonged to the previous document
    this.committingEpoch = null;
    this.failure = null;
    this.checkSerial += 1;
    this.saveCheck = null;
    this.saveState = { kind: "idle" };
    this.releaseDocument();
    this.generation = 0;
    this.modified = false;
    this.uncertain = false;
    this.pending = 0;
    this.lastRoundTrip = null;
    this.renderLimit = null;
    this.pages = [];
    this.status = { kind: "loading" };
    this.firstPaintMs = null;
    this.emit();
    const loaded = await this.backend.load(this.sessionId);
    if (!this.owns(epoch)) return closed;
    void this.sessions.refresh(this.sessionId, () => this.owns(epoch)); // loading(또는 실패 시 failed) 상태를 투영에 반영
    if (!loaded.ok) {
      this.setStatus({ kind: "failed", error: loaded.error });
      return loaded;
    }
    const generation = loaded.value.generation;
    this.generation = generation;
    this.loadStartedAt = performance.now();
    let doc: RhwpDocument;
    try {
      this.module ??= await this.loadModule();
    } catch {
      return this.failLoading(epoch, generation, { code: "EngineFailure", engine: "rhwp", stage: "init" });
    }
    if (!this.owns(epoch)) return closed;
    try {
      doc = this.module.openDocument(loaded.value.bytes);
    } catch {
      return this.failLoading(epoch, generation, { code: "EngineFailure", engine: "rhwp", stage: "parse" });
    }
    let cleanupFailed = false;
    const releaseInitialDocument = () => {
      try { doc.free(); } catch { cleanupFailed = true; }
    };
    // ready를 요청하기 전에 화면에 필요한 정보(페이지 크기)를 모두 얻고 검사한다. 엔진이 문서를 읽었더라도 페이지
    // 정보가 없거나 잘못되면 그릴 준비가 안 된 것이므로(render 단계) ready가 되지 않는다.
    let pages: PageSize[];
    try {
      pages = readPages(doc);
    } catch {
      releaseInitialDocument();
      return this.failLoading(epoch, generation, { code: "EngineFailure", engine: "rhwp", stage: "render" }, cleanupFailed);
    }
    // 큰 배율에서만 예산을 넘는 문서는 받아들이고 표면이 표시 한도로 다룬다. 가장 작은 배율로도 그릴 수 없으면 편집할
    // 표면을 내놓을 수 없으므로 ready 전에 거부한다(올바른 문서이므로 엔진 실패와 구분).
    if (!fitsRenderBudget(pages, MIN_DISPLAY_SCALE)) {
      releaseInitialDocument();
      return this.failLoading(epoch, generation, { code: "RenderLimit" }, cleanupFailed);
    }
    if (!this.owns(epoch)) {
      releaseInitialDocument();
      return closed;
    }
    // Acquire fallible engine resources while the backend still owns a loading state.
    let text: RhwpText;
    try {
      text = new RhwpText(doc);
    } catch {
      releaseInitialDocument();
      return this.failLoading(epoch, generation, { code: "EngineFailure", engine: "rhwp", stage: "init" }, cleanupFailed);
    }
    const release = () => {
      // Detach both resources even if one destructor traps. Cleanup failure must
      // not replace the ready/initialization error or revive a stale session.
      let failed = false;
      for (const cleanup of [() => text.release(), releaseInitialDocument]) {
        try { cleanup(); } catch { failed = true; }
      }
      cleanupFailed ||= failed;
    };
    let ready: Awaited<ReturnType<DocumentBackend["setState"]>>;
    try {
      ready = await this.backend.setState(this.sessionId, generation, "loading", "ready");
    } catch {
      release();
      if (!this.owns(epoch)) return closed;
      return this.failLoading(epoch, generation, { code: "EngineFailure", engine: "rhwp", stage: "init" }, cleanupFailed);
    }
    if (!this.owns(epoch)) {
      release();
      return closed;
    }
    if (!ready.ok) {
      release();
      this.generation = generation;
      this.handleBackendRejection(ready.error);
      if (cleanupFailed && !this.disposed) this.setStatus({ kind: "failed", error: ready.error, cleanupFailed: true });
      return { ok: false, error: ready.error };
    }
    this.doc = doc;
    this.hwpBaseline = null;
    this.hwpOriginal = null;
    this.borderFillBaseline = typeof doc.borderFillCount === "function" ? doc.borderFillCount() : null;
    this.fontSourceSafe = doc.canFormatFonts?.() === true;
    this.formatSourceCache = { key: String(epoch), safe: false };
    try {
      if (doc.getSourceFormat() === "hwp") {
        const { structure, complete } = hwpReopenModel(doc);
        this.hwpBaseline = { structure, complete };
        // Immutable original-document eligibility: ordinary edits may discard the
        // engine's raw section streams. Never infer source safety from edited IR.
        this.formatSourceCache.safe = doc.canFormatCharacters?.() === true;
      }
    } catch { /* no baseline: export requires fresh evidence and structural commands stay unavailable */ }
    this.text = text;
    this.startHistory(doc, loaded.value.bytes.length);
    this.generation = generation;
    this.committed = ready.value.revision;
    this.pending = 0;
    this.modified = false;
    this.caret = this.anchor = START;
    this.pendingChars = null;
    this.preferredX = -1;
    this.pages = pages;
    this.modelVersion += 1;
    this.structureVersion += 1;
    this.sessions.applyUpdate(ready.value);
    this.setStatus({ kind: "ready" });
    this.probeHwpOriginal();
    this.bindNaturalFonts();
    return LOADED;
  }

  /**
   * 불러오기 중 엔진 단계가 실패했다: 이 시도의 `loading → failed` 전이를 보내고 결과를 기다린 뒤 failed로 둔다. 전이는
   * 편집 중 실패와 같은 기록으로 남겨, 거부됐으면(백엔드가 아직 loading일 수 있음) 다음 reload가 settleFailure로 먼저
   * 확인한다. 쓰지 못한 임시 문서는 부르는 쪽이 이미 놓았다.
   */
  private async failLoading(epoch: number, generation: number, error: DocumentError, cleanupFailed = false): Promise<Result<null>> {
    if (!this.owns(epoch)) return { ok: false, error };
    const failure = this.reportFailure(generation, "loading");
    this.failure = failure;
    const result = await failure.result;
    if (!this.owns(epoch)) return { ok: false, error };
    if (this.failure === failure && (result.ok || failureAcknowledged(result.error))) this.failure = null; // 확인됨
    this.setStatus(cleanupFailed ? { kind: "failed", error, cleanupFailed: true } : { kind: "failed", error });
    return { ok: false, error };
  }

  /**
   * 다시 불러오기의 전제: 편집을 멈추며 보낸 failed 전이(markFailed)의 결과를 확인해, 백엔드가 이 불러오기 시도를 더
   * 이상 ready·loading으로 두지 않음을 안다. 응답 전이면 기다린다(먼저 document_load를 보내면 백엔드가 InvalidState로
   * 거부한다). 성공·이미 failed(InvalidState failed)·StaleLoad(더 새 시도가 있음)면 null(진행). 전이가 다른 오류면
   * (응답 유실·투영이 늦어 from이 어긋남 등) 이번 다시 불러오기에서 한 번만 전이를 다시 보내고, 그래도 확인하지 못하면 모델을 놓지 않은 채
   * 그 오류로 끝낸다(다음 다시 불러오기가 다시 확인한다). 기다리는 동안 닫히면 닫힘으로 끝난다.
   */
  private async settleFailure(): Promise<Result<null> | null> {
    const epoch = this.epoch;
    for (let resent = false; this.failure; resent = true) {
      const failure = this.failure;
      const result = await failure.result;
      if (!this.owns(epoch)) return { ok: false, error: { code: "StaleSession", sessionId: this.sessionId } };
      if (result.ok || failureAcknowledged(result.error)) {
        this.failure = null;
        return null;
      }
      if (resent || result.error.code === "StaleSession" || result.error.code === "UnknownSession") {
        this.handleBackendRejection(result.error); // 닫힌 세션이면 모델을 버린다
        if (!this.disposed) this.setStatus({ kind: "failed", error: result.error });
        return { ok: false, error: result.error };
      }
      // 백엔드가 지금 상태를 알려 줬으면(InvalidState ready·loading) 그 상태에서 전이한다(같은 어긋난 요청을 되풀이하지 않음).
      const error = result.error;
      const from = error.code === "InvalidState" && (error.state === "ready" || error.state === "loading") ? error.state : failure.from;
      this.failure = this.reportFailure(failure.generation, from);
    }
    return null;
  }

  private setStatus(status: EditorStatus) {
    this.status = status;
    this.emit();
  }

  /**
   * 렌더링 준비(표면이 그리기 전에 부른다). scale은 그리는 배율(zoom × devicePixelRatio).
   * - 예산 안이면 true(표시 한도였다면 풀어 편집을 이어 간다).
   * - 이 배율로는 픽셀 예산을 넘으면 그리지 않고 이전 backing store를 놓은 뒤 표시 한도(renderLimit)로 편집을 멈춘다.
   *   모델·revision·확정은 그대로다(엔진 실패가 아님). 한도에 들어가기 직전에 beforeLimit을 부른다(표면이 보이는 IME
   *   조합을 그 자리에 확정할 수 있게).
   * - 예산을 계산할 수 없으면(잘못된 배율 등) 빈 편집 영역을 정상처럼 두지 않고 편집을 멈춘다(render 단계 실패).
   */
  prepareRendering(scale: number, beforeLimit?: () => void): boolean {
    if (!this.doc || this.status.kind !== "ready") return false;
    let fits: boolean;
    try {
      fits = fitsRenderBudget(this.pages, scale);
    } catch {
      this.releaseRendering();
      this.markFailed({ code: "EngineFailure", engine: "rhwp", stage: "render" });
      return false;
    }
    if (!fits) {
      this.releaseRendering();
      if (this.renderLimit !== scale) {
        if (this.renderLimit === null) beforeLimit?.();
        this.settleProvisional(); // 편집을 멈추므로 기다리지 않는다(고칠 수 없음): 보이던 조합을 지금 한 번 센다
        this.renderLimit = scale;
        this.emit();
      }
      return false;
    }
    if (this.renderLimit !== null) {
      this.renderLimit = null;
      this.emit();
    }
    return true;
  }

  /** 이 배율로 지금 쪽들을 예산 안에서 그릴 수 있는지(상태를 바꾸지 않음, 안내 문구용). */
  fitsRendering(scale: number): boolean {
    try {
      return fitsRenderBudget(this.pages, scale);
    } catch {
      return false;
    }
  }

  /** zoom 교체·표면 해제·reload·닫기 때 이전 backing store를 새 할당 전에 놓는다. */
  releaseRendering() {
    for (const canvas of this.renderCanvases) {
      canvas.width = 0;
      canvas.height = 0;
    }
    this.renderCanvases.clear();
    this.drawnAt = new WeakMap();
  }

  /**
   * Stage 5-A: fonts available to the WebView changed (a registered user font loaded or removed). The engine's layer tree
   * is unchanged, so the unchanged-page check would skip painting; forget what was drawn so every page is painted again
   * through the Canvas text path with the new fonts. Never changes the document.
   */
  fontsChanged(): void {
    if (this.disposed) return;
    this.drawnAt = new WeakMap();
    this.layoutVersion += 1;
    this.emit();
    this.bindNaturalFonts();
  }

  /** Stage 5-A: outcome of the latest natural-metric binding of this document (null before the first one). `complete`
   *  is false for a partial binding (unbound, omitted beyond MAX_REQUESTS, engine-truncated, face-limited or style-gapped keys use
   *  legacy metrics); a partial "bound" result re-lays out and repaints exactly like a complete one. */
  naturalFontStatus: NaturalBinding | null = null;
  private naturalRequest = 0;
  private naturalKeys: string | null = null;
  private naturalCheckedVersion = -1;

  /** The document's natural-font family keys (with bold use), or null when the engine cannot say. */
  private naturalKeySet(doc: RhwpDocument): string | null {
    try {
      const value = JSON.parse(doc.getNaturalFontRequests?.() ?? "null") as { requests?: { key: string; bold: boolean }[] } | null;
      return Array.isArray(value?.requests) ? JSON.stringify(value.requests.map((r) => [r.key, r.bold])) : null;
    } catch { return null; }
  }

  /** A model change can introduce a family key the committed snapshot does not bind (font change, Undo/Redo, paste):
   *  rebind only when the key set actually changed. */
  private checkNaturalKeys(): void {
    this.naturalCheckedVersion = this.modelVersion;
    const binder = this.options.natural === undefined ? naturalFonts : this.options.natural;
    const doc = this.doc;
    if (!binder?.ready() || !doc || this.disposed || this.naturalKeys === null) return;
    const keys = this.naturalKeySet(doc);
    if (keys !== null && keys !== this.naturalKeys) this.bindNaturalFonts();
  }

  /** A binding was requested while an IME transaction was unsettled; owned by this session's current document and
   *  cleared when the deferred binding starts, on reload and on disposal. */
  private naturalDeferred = false;
  /** Ownership of the WebView faces the current document's committed engine snapshot paints with (NaturalLease). Exactly
   *  one per document; replaced on adoption of a newer snapshot, released on clear, reload and disposal. */
  private naturalLease: NaturalLease | null = null;

  /** The candidate of a commit whose outcome could not be established (status "uncertain"). Kept with
   *  `naturalLease` because the engine may paint with either; at most one per document (binding stops after it);
   *  released only at reload/disposal. */
  private naturalUncertainLease: NaturalLease | null = null;

  private releaseNaturalLease(): void {
    const leases = [this.naturalLease, this.naturalUncertainLease];
    this.naturalLease = null;
    this.naturalUncertainLease = null;
    const binder = this.options.natural === undefined ? naturalFonts : this.options.natural;
    for (const lease of leases) binder?.release(lease);
  }

  /**
   * Bind this document's families to exact installed font sources (naturalFonts.ts). Layout-only: the engine keeps the
   * snapshot across rebuilds/Undo/Redo and the document's stored family names never change. A newer request, a
   * reload, or disposal supersedes an older one.
   *
   * IME: while a transaction is unsettled (composition, app-finished provisional composition, or awaiting the input
   * method's final text — `imeUnsettled`) nothing is committed and the current snapshot stays. The request is recorded
   * (`naturalDeferred`) and resumed once from `emit()` after the transaction settles, using the binder's newest catalog;
   * several requests during one transaction coalesce into that single binding. No timer polling.
   */
  private bindNaturalFonts(): void {
    const binder = this.options.natural === undefined ? naturalFonts : this.options.natural;
    const doc = this.doc;
    // After an uncertain commit the engine's font binding is unknown: no further commit until reload.
    if (!binder || !doc || this.disposed || this.naturalUncertainLease) return;
    const epoch = this.epoch;
    const request = ++this.naturalRequest; // supersedes any in-flight or deferred request
    this.naturalKeys = this.naturalKeySet(doc);
    if (this.imeUnsettled) {
      this.naturalDeferred = true;
      return;
    }
    const current = () => this.doc === doc && this.owns(epoch) && !this.disposed && request === this.naturalRequest
      && this.naturalUncertainLease === null;
    void binder.bind(doc, () => current() && !this.imeUnsettled).then((binding) => {
      const committed = binding.status === "bound" || binding.status === "unbound";
      const sameDocument = this.doc === doc && this.owns(epoch) && !this.disposed;
      if (binding.status === "uncertain") {
        if (!sameDocument) { binder.release(binding.lease); return; } // that engine document is gone
        // The engine may paint with the previous snapshot or this candidate: keep both leases and stop editing and
        // painting (failed state) until a reload or disposal establishes a trustworthy boundary.
        this.naturalUncertainLease = binding.lease ?? null;
        this.naturalFontStatus = binding;
        this.markFailed({ code: "EngineFailure", engine: "rhwp", stage: "render" });
        return;
      }
      if (committed && !sameDocument) {
        binder.release(binding.lease); // the document it was committed to is gone: never attach it to a newer one
        return;
      }
      if (committed) {
        // The engine now holds this snapshot (even if a newer request is already pending): adopt its lease, then give
        // up the previous snapshot's faces.
        const previous = this.naturalLease;
        this.naturalLease = binding.lease ?? null;
        binder.release(previous);
      }
      if (!current() && !committed) return;
      if (binding.status === "stale") {
        // Still the newest request for this document: an IME transaction began after it started. Wait for settlement
        // (emit resumes it; if it already settled, resume now). Each retry needs a new IME transaction: bounded.
        this.naturalDeferred = true;
        this.resumeDeferredNaturalFonts();
        return;
      }
      this.naturalFontStatus = binding;
      if (!committed) return;
      // The engine re-laid out every page: refresh page sizes, caret geometry and painted pages (model unchanged).
      try { this.pages = readPages(doc); } catch {
        this.markFailed({ code: "EngineFailure", engine: "rhwp", stage: "render" });
        return;
      }
      this.caretCache = null;
      this.preferredX = -1;
      this.drawnAt = new WeakMap();
      this.layoutVersion += 1;
      this.emit();
    }, () => undefined);
  }

  /** Start the deferred binding once the IME transaction has fully settled (called from every emit). */
  private resumeDeferredNaturalFonts(): void {
    if (!this.naturalDeferred || this.imeUnsettled || this.disposed || !this.doc) return;
    this.naturalDeferred = false;
    const doc = this.doc, epoch = this.epoch;
    // Not inside the emitting mutation: the next microtask, and only for the same document and load.
    queueMicrotask(() => { if (this.doc === doc && this.owns(epoch) && !this.disposed) this.bindNaturalFonts(); });
  }

  renderPage(page: number, canvas: HTMLCanvasElement, scale: number): boolean {
    if (!this.prepareRendering(scale) || !this.doc) return false;
    const doc = this.doc;
    try {
      const started = import.meta.env.VITE_GEUL_TEST_HOOKS === "1" ? performance.now() : 0;
      const painted = this.paintedSummary(doc, page);
      trace("rhwp:paint-summary", () => ({ page, ms: performance.now() - started }));
      const drawStarted = import.meta.env.VITE_GEUL_TEST_HOOKS === "1" ? performance.now() : 0;
      // FULL_PAGE_ONLY: 백엔드를 추측하지 않는다. pinned 엔진의 쪽 전체 patch도 소수 clip 경계가
      // 전체 렌더와 다르므로 patch API를 호출하지 않는다(엔진 v4·새 WASM 없이 안전한 경로).
      if (!this.isPageUnchanged(page, canvas, scale, painted)) {
        // 엔진은 bitmap을 할당한 뒤 실패할 수도 있다. 첫 paint 실패도 해제 대상에 넣되 성공으로 기록하지 않는다.
        this.renderCanvases.add(canvas);
        doc.renderPageToCanvas(page, canvas, scale);
      }
      trace("rhwp:paint-draw", () => ({ page, ms: performance.now() - drawStarted }));
      const size = this.pages[page]!;
      this.drawnAt.set(canvas, { page, scale, width: size.width, height: size.height,
        bitmapWidth: canvas.width, bitmapHeight: canvas.height, painted, model: this.modelVersion, layout: this.layoutVersion });
      this.renderCanvases.add(canvas);
      if (page === 0 && this.firstPaintMs === null) {
        this.firstPaintMs = performance.now() - this.loadStartedAt;
        queueMicrotask(() => this.emit()); // 그리는 중이 아니라 다음에 상태 표시를 갱신
      }
      return true;
    } catch {
      this.drawnAt.delete(canvas);
      if (this.status.kind === "ready") this.markFailed({ code: "EngineFailure", engine: "rhwp", stage: "render" });
      return false;
    }
  }

  /** 지금 모델의 그 쪽 그리기 입력 요약(비교용). 엔진이 주지 않거나 읽지 못하면 null(그때는 쪽 전체를 그림). */
  private paintedSummary(doc: RhwpDocument, page: number): string | null {
    if (!doc.getPageLayerTreeWithProfile) return null;
    try {
      const started = import.meta.env.VITE_GEUL_TEST_HOOKS === "1" ? performance.now() : 0;
      const json = doc.getPageLayerTreeWithProfile(page, "screen", true, true);
      trace("rhwp:layer-json", () => ({ page, ms: performance.now() - started, chars: json.length }));
      // 기존의 알 수 없는 트리 거부를 유지한다. bbox 밖 변경도 생략하지 않도록 damage 띠 대신
      // 전체 JSON을 비교한다(쪽 치수·출력 옵션 등 잎 밖 입력도 포함).
      return summarizeLayerTree(json) ? json : null;
    } catch {
      return null;
    }
  }

  isObjectHitPageCurrent(page: number, canvas: HTMLCanvasElement, scale: number): boolean {
    const drawn = this.drawnAt.get(canvas);
    return !!drawn && drawn.page === page && drawn.scale === scale &&
      drawn.model === this.modelVersion && drawn.layout === this.layoutVersion &&
      drawn.bitmapWidth === canvas.width && drawn.bitmapHeight === canvas.height &&
      canvas.width > 0 && canvas.height > 0;
  }

  /** 같은 Canvas의 성공한 전체 출력과 입력이 완전히 같을 때만 다시 그리기를 생략한다. */
  private isPageUnchanged(page: number, canvas: HTMLCanvasElement, scale: number, painted: string | null): boolean {
    const size = this.pages[page];
    const drawn = this.drawnAt.get(canvas);
    return !!size && !!drawn && painted !== null && drawn.painted === painted
      && drawn.page === page && drawn.scale === scale
      && drawn.width === size.width && drawn.height === size.height
      && canvas.width > 0 && canvas.height > 0
      && drawn.bitmapWidth === canvas.width && drawn.bitmapHeight === canvas.height;
  }

  caretRect(): CaretRect | null {
    const text = this.text;
    if (!text || this.objectSelection) return null;
    // positionKey의 표시 문자열은 parentParagraph를 생략한다. 캐시에는 셀 경로 전체를 포함한다.
    const at = this.caret;
    const position = `${contextKey(at)}:${at.offset}`;
    const cached = this.caretCache;
    if (cached?.text === text && cached.version === this.modelVersion && cached.position === position) return { ...cached.value };
    const value = text.caret(at);
    // 실패(null)는 기억하지 않는다. 렌더 준비가 뒤에 끝나면 같은 판에서도 다시 질의한다.
    this.caretCache = value ? { text, version: this.modelVersion, position, value: { ...value } } : null;
    return value;
  }

  selectionRects(): PageRect[] {
    if (this.objectSelection || !this.text || !this.hasSelection) return [];
    if (!sameContext(this.anchor, this.caret)) {
      const table = this.caretTable(), range = this.selectedCellRange();
      if (!table || !range || !this.doc?.getTableCellBboxesByPath || !this.caret.cell) return [];
      try {
        const boxes: unknown = JSON.parse(this.doc.getTableCellBboxesByPath(this.caret.section,
          this.caret.cell.parentParagraph, pathJson(this.caret.cell)));
        if (!Array.isArray(boxes) || boxes.length > 16384) return [];
        return boxes.filter(b => b && b.row >= range.startRow && b.row <= range.endRow
          && b.col >= range.startCol && b.col <= range.endCol && Number.isSafeInteger(b.pageIndex)
          && [b.x, b.y, b.w, b.h].every(Number.isFinite))
          .map(b => ({ page: b.pageIndex, x: b.x, y: b.y, width: b.w, height: b.h }));
      } catch { return []; }
    }
    const [from, to] = this.ordered();
    return this.text.selection(from, to);
  }

  /** 조합 중인 글자 범위(밑줄 표시용). */
  compositionRects(): PageRect[] {
    const composition = this.composition;
    if (!this.text || !composition || !composition.text) return [];
    const end = { ...composition.anchor, offset: composition.anchor.offset + charCount(composition.text) };
    return this.text.selection(composition.anchor, end);
  }

  /**
   * Whether `at` names a cell the current model owns. Body and one-level cells keep their existing checks; a nested
   * path is proven once per structural version through the engine's cursor lists (RhwpText.ownsNestedCell).
   */
  private ownsPosition(at: DocPosition): boolean {
    if (at.cell?.caption) return this.ownsHwpPictureCaption(at);
    if (at.cell?.textBox) return this.canEditTextBox(at.section) && this.text?.ownsTextBox(at) === true;
    if (!at.cell?.nested) return true;
    const text = this.text;
    if (!text) return false;
    if (this.nestedProof?.text !== text || this.nestedProof.version !== this.structureVersion) {
      this.nestedProof = { text, version: this.structureVersion, owned: new Map() };
    }
    const key = contextKey(at);
    let owned = this.nestedProof.owned.get(key);
    if (owned === undefined) {
      owned = text.ownsNestedCell(at);
      if (this.nestedProof.owned.size < 64) this.nestedProof.owned.set(key, owned);
    }
    return owned;
  }

  private canEditTextBox(section: number): boolean {
    const format = this.sessions.get(this.sessionId)?.format;
    return !!this.history && (format === "hwpx" || (format === "hwp" && section === 0 && this.structuralFormat()));
  }

  private ownsHwpPictureCaption(at: DocPosition): boolean {
    const format = this.sessions.get(this.sessionId)?.format;
    const allowed = format === "hwpx" || (format === "hwp" && at.section === 0 && this.structuralFormat());
    return allowed && !!this.history && this.text?.ownsPictureCaption(at) === true;
  }

  private ordered(): [DocPosition, DocPosition] {
    return compare(this.anchor, this.caret) <= 0 ? [this.anchor, this.caret] : [this.caret, this.anchor];
  }

  // ---- 문서 변경 ----

  /**
   * 엔진 모델을 바꾼다. 성공하면(count면) 변경 1개를 확정 대기열에 넣는다. 그 뒤의 화면 갱신 준비가 실패해도 변경은
   * 이미 모델에 있으므로 센 채로 편집을 멈춘다. apply가 예외를 던지면 여러 엔진 호출 중 일부가 이미 모델을 바꿨을 수
   * 있으므로 세지 않고(확정하지 않음) 모델을 uncertain으로 표시한 뒤 편집을 멈춘다.
   */
  private mutate(apply: Mutation, count = true, kind: HistoryKind = "other", start: string | null = null, requireHistory = false, recoverable = false): boolean {
    if (this.objectSelection || !this.editable || !this.doc) return false;
    // A cell rectangle is a structural selection, never a cross-owner text deletion.
    if (this.hasSelection && !sameContext(this.anchor, this.caret) && !requireHistory) return false;
    // T012 Phase 2: a nested-cell target must be owned by the current model, level by level, before any engine
    // call. A path that no longer resolves (never expected: only this session changes the model) is refused
    // without touching the document; the caret leaves the unowned cell.
    if (![this.caret, this.anchor, this.composition?.anchor, this.provisional?.anchor].every(at => !at || this.ownsPosition(at))) {
      this.composition = null;
      if (this.provisional) { this.provisional = null; this.cancelHistory(); }
      this.caret = this.anchor = START;
      this.pendingChars = null;
      this.emit();
      return false;
    }
    this.settleProvisional(); // 기다리던 조합은 이 변경보다 먼저 끝난 변경이다
    if (!this.editable) return false;
    const doc = this.doc;
    // 실행 취소 기록: 바꾸는 첫 엔진 호출 직전에 트랜잭션을 연다(지금 상태 스냅숏 = 그룹의 before). 이미 열려 있으면 그대로(조합).
    if (this.advancedHistoryOnly && !requireHistory) {
      // Genuine input is never recorded in the advanced timeline. Retire its
      // snapshots before touching the model, so Undo cannot overwrite later input.
      try { this.history?.forget(); }
      catch (error) { this.historyFailure(error); return false; }
    } else if (!this.beginHistory(kind, start) || (requireHistory && !this.history)) return false;
    let next: ReturnType<Mutation>;
    const started = import.meta.env.VITE_GEUL_TEST_HOOKS === "1" ? performance.now() : 0;
    try {
      next = apply();
      trace("rhwp:text-mutation", () => ({ ms: performance.now() - started }));
    } catch (error) {
      if (requireHistory) {
        // Restore a coherent before state even if a validated engine operation
        // threw after changing the model. A secondary trap still fails closed;
        // successful rollback does not claim the trapped module is healthy.
        try {
          this.history?.rollback(); this.text?.reconcilePublishedCharShapes();
          if (recoverable && !(error instanceof WebAssembly.RuntimeError) && !this.uncertain) {
            this.pendingChars = null; this.pages = readPages(doc); this.emit(); return false;
          }
        } catch (rollbackError) { this.historyFailure(rollbackError); }
      }
      // 진행 중인 조합도 이 실패로 끝난다. 그 조합은 성공한 변경으로 세지 않는다(markFailed가 세지 않게 먼저 비움).
      this.composition = null;
      this.pendingChars = null;
      this.uncertain = true;
      this.lastRoundTrip = null;
      this.modelVersion += 1;
      this.failEditing();
      return false;
    }
    this.modified = true;
    this.lastRoundTrip = null; // 이전 모델의 내보내기 검사 결과는 더 이상 이 모델의 것이 아니다
    this.modelVersion += 1;
    if (kind === "other") this.structureVersion += 1; // paragraphs/cells/controls may have moved (not plain typing)
    if ("caret" in next) {
      this.caret = next.caret;
      this.anchor = next.anchor;
    } else this.caret = this.anchor = next;
    this.preferredX = -1;
    this.reconcilePending();
    if (count) this.recordMutation();
    if (!this.editable) return true; // 기록 정리 trap 뒤 엔진을 더 부르지 않음
    try {
      this.pages = readPages(doc);
    } catch {
      this.markFailed({ code: "EngineFailure", engine: "rhwp", stage: "render" });
      return true;
    }
    this.emit();
    return true;
  }

  private recordMutation() {
    this.modified = true;
    this.pending += 1;
    // 백엔드 확정(위)과 기록 그룹은 따로다: 열린 트랜잭션을 단계로 닫거나 이어 쓰는 그룹에 넣는다(확정 N개 → 단계 1개 가능).
    try {
      this.history?.commit(RhwpEditorSession.positionKey(this.caret));
    } catch (error) {
      this.historyFailure(error);
      return;
    }
    const started = import.meta.env.VITE_GEUL_TEST_HOOKS === "1" ? performance.now() : 0;
    void this.flushCommits();
    trace("rhwp:revision-schedule", () => ({ ms: performance.now() - started }));
  }

  // ---- 실행 취소 기록(T010 Phase 2) ----

  /**
   * 문서를 열 때: 레지스트리가 일반 history를 선언하면(제품·시험 공통) 일반 타자/IME 기록을, 세션이 명시적으로 뺀 경우에만
   * 소문서 고급 전용 timeline을 만든다.
   * 예산(원본 크기 대용 — 보수적이지 않음, rhwpHistory.ts historyBudget)이 최소 깊이를 담고 모듈이 선형 메모리를 잴 때만 켠다. 측정이 없거나 시작 측정이
   * 계약에 어긋나면 감시 없는 기록을 만들지 않고 unavailable로 둔다(RhwpHistory가 읽은 값을 검사한다 — 여기서 대신 채우지 않는다).
   * 기록을 만들지 못해도 문서 세션은 그대로다.
   */
  private startHistory(doc: RhwpDocument, bytes: number) {
    this.history = null;
    this.historyOff = null;
    this.advancedSourceLimited = bytes > ADVANCED_MAX_SOURCE_BYTES;
    if (this.options.history === false) return;
    const module = this.module;
    try {
      if (this.advancedHistoryOnly && (bytes > ADVANCED_MAX_SOURCE_BYTES || doc.pageCount() > ADVANCED_MAX_PAGES)) {
        this.historyOff = "limit";
        return;
      }
      const budget = historyBudget(bytes, doc.snapshotCapacity());
      if (!budget.enabled) {
        this.historyOff = "limit";
        return;
      }
      const read = module?.memoryBytes;
      if (!module || typeof read !== "function") {
        this.historyOff = "unavailable";
        return;
      }
      this.history = new RhwpHistory(doc, this.advancedHistoryOnly ? Math.min(budget.depth, ADVANCED_HISTORY_DEPTH) : budget.depth, () => performance.now(), () => read.call(module));
    } catch {
      this.historyOff = "unavailable";
    }
  }

  /**
   * 트랜잭션을 연다. false = 스냅숏 찍기가 던졌다: Result가 없는 함수라 WASM trap이고, 찍기 전 미뤄 둔 갱신
   * (`flush_cell_format_vpos`)이 모델을 바꿨을 수 있으므로 엔진 예외와 같이 불확실로 두고 편집을 멈춘다(편집은 하지 않았다).
   * 자리를 만들지 못한 거절(엔진을 부르지 않음)은 기록만 끄고 편집은 계속한다.
   */
  private beginHistory(kind: HistoryKind, start: string | null): boolean {
    const history = this.history;
    const text = this.text;
    if (!history || !text) return true;
    try {
      history.begin(kind, start, () => captureCheckpoint(text, this.caret, this.anchor));
      return true;
    } catch (error) {
      if (error instanceof HistoryFailure) {
        this.historyFailure(error);
        return false;
      }
      this.dropHistory(error instanceof HistoryRefused && error.reason === "limit" ? "limit" : "unavailable");
      return this.editable;
    }
  }

  /** Result 없는 스냅숏 정리 trap도 모델 무결성을 보장하지 못한다. 재진입 전에 기록부터 분리한다. */
  private historyFailure(error: unknown) {
    const history = this.history;
    this.history = null;
    this.historyOff = "unavailable";
    history?.release(false);
    if (!(error instanceof HistoryFailure) || error.uncertain) {
      this.composition = null;
      this.provisional = null;
      this.awaiting = false;
      this.imeSerial += 1;
      this.uncertain = true;
      this.lastRoundTrip = null;
      this.modelVersion += 1;
      this.failEditing();
    }
  }

  /** 기록을 먼저 분리해 정리 실패가 재진입·같은 ID 재폐기를 일으키지 않게 한다. */
  private dropHistory(reason: "limit" | "unavailable") {
    const history = this.history;
    this.history = null;
    this.historyOff = reason;
    try {
      history?.release(!this.uncertain);
    } catch (error) {
      this.historyFailure(error);
    }
  }

  private cancelHistory() {
    try {
      this.history?.cancel();
    } catch (error) {
      this.historyFailure(error);
    }
  }

  /** 초점 잃음·표면 사라짐(ImeInput): 타자 그룹을 끊는다. 문서·revision·조합·대기 확정은 바꾸지 않는다(설계 §6). */
  endHistoryGroup(): void {
    this.history?.boundary();
  }

  /** 실행 취소(T010 Phase 2). 성공하면 변경 1개(revision +1, 줄이지 않음). 할 수 없으면 아무것도 바꾸지 않고 false. */
  undo(): boolean {
    return this.travel("undo");
  }

  /** 다시 실행. 실행 취소와 같은 계약. */
  redo(): boolean {
    return this.travel("redo");
  }

  private travel(direction: "undo" | "redo"): boolean {
    const history = this.history;
    const doc = this.doc;
    const text = this.text;
    // IME 트랜잭션(조합·provisional·최종 글자 기다림) 중에는 하지 않는다: 조합 좌표·ReplaceInserted가 복원으로 무효가 된다.
    if (!history || !doc || !text || !this.editable || this.imeUnsettled) return false;
    if (this.advancedHistoryOnly && (this.pending > 0 || this.committingEpoch === this.epoch)) return false;
    let checkpoint;
    try {
      checkpoint = direction === "undo" ? history.undo(() => captureCheckpoint(text, this.caret, this.anchor)) : history.redo();
      try { text.reconcilePublishedCharShapes(); }
      catch { throw new HistoryFailure("restore-failed", true); }
    } catch (error) {
      if (error instanceof HistoryFailure && error.uncertain) {
        // 엔진이 문서를 바꿨는지 알 수 없다(찍기·복원 trap): 되돌림을 보장하지 않고 편집을 멈춘다.
        this.uncertain = true;
        this.lastRoundTrip = null;
        this.modelVersion += 1;
        this.failEditing();
        return false;
      }
      // 엔진을 부르기 전 거절, 또는 바꾸기 전 오류("스냅샷 N 없음" — 기록의 셈이 엔진과 어긋남): 문서는 그대로다. 메모리 측정
      // 불가(unavailable)도 기록을 끈다 — 감시 없이 기록을 이어 쓰지 않는다.
      if (error instanceof HistoryFailure || (error instanceof HistoryRefused && error.reason === "unavailable")) {
        this.dropHistory("unavailable");
      }
      this.emit();
      return false;
    }
    this.history?.boundary();
    this.modified = true;
    this.lastRoundTrip = null;
    this.modelVersion += 1;
    this.structureVersion += 1;
    const placed = placeCheckpoint(text, checkpoint);
    this.pendingChars = null; // Undo/Redo is not ordinary typing: next-input values never survive a history restore
    this.caret = placed.caret;
    this.anchor = placed.anchor;
    this.preferredX = -1;
    this.recordMutation();
    try {
      this.pages = readPages(doc);
    } catch {
      this.markFailed({ code: "EngineFailure", engine: "rhwp", stage: "render" });
      return true;
    }
    this.emit();
    return true;
  }

  private canDeleteSelection(): boolean {
    if (!this.hasSelection) return true;
    const [from, to] = this.ordered();
    return this.text?.canDeleteRange(from, to) ?? false;
  }

  /** Call after canDeleteSelection: caption range deletion joins each selected paragraph boundary. */
  private captionAllowsSplits(added: number): boolean {
    if (!this.caret.cell?.caption) return true;
    if (!this.text) return false;
    try {
      const [from, to] = this.ordered();
      const removed = this.hasSelection ? paragraphOf(to) - paragraphOf(from) : 0;
      const result = this.text.paragraphCount(this.caret) - removed + added;
      return Number.isSafeInteger(result) && result >= 1 && result <= 64;
    } catch { return false; }
  }

  private deleteSelectionRaw(): DocPosition {
    const [from, to] = this.ordered();
    this.text!.deleteRange(from, to);
    return from;
  }

  typeText(text: string): boolean {
    if (!text || this.composition || !validClipboardText(text) || !this.canDeleteSelection() || !this.text?.canInsertText(this.caret)) return false;
    text = text.replace(/\r\n?|\u2029/g, "\n");
    if (text.includes("\n") && this.caret.cell?.textBox) return false;
    if (text.includes("\n") && this.caret.cell?.caption) {
      const added = text.split("\n").length - 1;
      if (!this.captionAllowsSplits(added)) return false;
    }
    if (this.caret.cell?.caption && text.includes("\t")) return false;
    if (text.includes("\n")) return this.mutate(() => {
      let at = this.hasSelection ? this.deleteSelectionRaw() : this.caret;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line) this.insertText(at, line);
        at = { ...at, offset: at.offset + charCount(line) };
        if (i + 1 < lines.length) at = this.splitText(at);
      }
      return at;
    });
    const start = this.hasSelection ? null : RhwpEditorSession.positionKey(this.caret);
    return this.mutate(() => {
      const at = this.hasSelection ? this.deleteSelectionRaw() : this.caret;
      this.insertText(at, text);
      return { ...at, offset: at.offset + charCount(text) };
    }, true, "typing", start);
  }

  backspace(): boolean {
    if (this.objectSelection && this.sessions.get(this.sessionId)?.format === "hwp") return false;
    if (this.hasSelection) return this.canDeleteSelection() && this.mutate(() => this.deleteSelectionRaw());
    const at = this.caret;
    const text = this.text;
    if (!text) return false;
    if (at.offset > 0) {
      if (!text.canDeleteRange({ ...at, offset: at.offset - 1 }, at)) return false;
      // 오프셋 단위가 유니코드 스칼라이므로 앞 글자 하나는 1이다(서로게이트 쌍을 나누지 않음).
      return this.mutate(() => {
        text.delete({ ...at, offset: at.offset - 1 }, 1);
        return { ...at, offset: at.offset - 1 };
      }, true, "deleteBack", RhwpEditorSession.positionKey(at));
    }
    const paragraph = paragraphOf(at);
    if (paragraph === 0) return false; // 문맥의 처음: 바꿀 것이 없음(변경 아님)
    const previousEnd = withParagraph(at, paragraph - 1, text.paragraphLength(withParagraph(at, paragraph - 1, 0)));
    if (!text.canDeleteRange(previousEnd, at)) return false;
    return this.mutate(() => {
      const previous = withParagraph(at, paragraph - 1, 0);
      const joinAt = text.paragraphLength(previous);
      text.mergeIntoPrevious(at, paragraph);
      return withParagraph(at, paragraph - 1, joinAt);
    });
  }

  deleteForward(): boolean {
    // An HWP GSO selection owns the key even when object deletion is unavailable.
    // Never apply Delete to the text caret left behind the selected object.
    if (this.objectSelection && this.sessions.get(this.sessionId)?.format === "hwp") return false;
    if (this.hasSelection) return this.canDeleteSelection() && this.mutate(() => this.deleteSelectionRaw());
    const at = this.caret;
    const text = this.text;
    if (!text) return false;
    if (at.offset < text.paragraphLength(at)) {
      if (!text.canDeleteRange(at, { ...at, offset: at.offset + 1 })) return false;
      return this.mutate(() => {
        text.delete(at, 1);
        return at;
      }, true, "deleteForward", RhwpEditorSession.positionKey(at));
    }
    const paragraph = paragraphOf(at);
    if (paragraph + 1 >= text.paragraphCount(at)) return false;
    if (!text.canDeleteRange(at, withParagraph(at, paragraph + 1, 0))) return false;
    return this.mutate(() => {
      text.mergeIntoPrevious(at, paragraph + 1);
      return at;
    });
  }

  enter(): boolean {
    if (this.caret.cell?.textBox) return this.splitOwnedTextBox();
    if (!this.canDeleteSelection() || !this.text?.canInsertText(this.caret) || !this.captionAllowsSplits(1)) return false;
    // Enter on an existing empty bullet exits the list. That only removes an existing structural heading, so it
    // depends on the load-time eligibility (bulletExitBlocked), not on the asynchronous original preflight:
    // otherwise the same keystroke would split while the preflight is CHECKING and exit once it is SAFE.
    if (!this.bulletExitBlocked() && !this.hasSelection && !this.caret.cell
      && this.doc?.getParagraphLength(this.caret.section, this.caret.paragraph) === 0 && this.doc.getParaPropertiesAt) {
      try { if (JSON.parse(this.doc.getParaPropertiesAt(this.caret.section, this.caret.paragraph)).headType === "Bullet") return this.toggleBullets(true); }
      catch { return false; }
    }
    // Enter on an empty numbered item (body or cell) ends the list: the paragraph leaves the numbering (no new item).
    if (!this.hasSelection && this.text.paragraphLength(this.caret) === 0) {
      const range = this.listRange();
      if (range) {
        try {
          const raw = this.readPara(range.at, paragraphOf(this.caret));
          if (raw.headType === "Number" || (raw.headType === "Bullet" && this.caret.cell)) {
            return this.applyList(() => p => p === paragraphOf(this.caret) ? { headType: "None", numberingId: 0, paraLevel: 0 } : null);
          }
        } catch { return false; }
      }
    }
    return this.mutate(() => {
      const at = this.hasSelection ? this.deleteSelectionRaw() : this.caret;
      return this.splitText(at);
    });
  }

  private splitOwnedTextBox(): boolean {
    const { caret: at, doc, text } = this;
    const c = at.cell;
    if (!c?.textBox || !doc?.getShapeProperties || !text || this.hasSelection || this.imeUnsettled
      || this.sessions.get(this.sessionId)?.format !== "hwpx" || !this.ownsPosition(at)) return false;
    const old = text.textBoxParagraph(at);
    if (!old || !Number.isSafeInteger(at.offset) || at.offset <= 0 || at.offset >= old.styles.length) return false;
    const address = [at.section, c.parentParagraph, c.control] as const;
    let count: number, shape: string;
    try {
      count = text.paragraphCount(at);
      if (count >= 64) return false;
      shape = doc.getShapeProperties(...address);
    } catch { return false; }
    return this.mutate(() => {
      const next = this.splitText(at);
      const left = text.textBoxParagraph(at), right = text.textBoxParagraph(next);
      if (!left || !right || left.styles.length !== at.offset || left.text + right.text !== old.text
        || left.properties !== old.properties || right.properties !== old.properties
        || left.styles.length + right.styles.length !== old.styles.length
        || left.styles.some((style, i) => style !== old.styles[i])
        || right.styles.some((style, i) => style !== old.styles[i + at.offset])
        || text.paragraphCount(next) !== count + 1 || doc.getShapeProperties!(...address) !== shape
        || !this.ownsPosition(next)) throw new Error("text box split did not preserve content or ownership");
      return next;
    }, true, "other", null, true, true);
  }

  // ---- IME 조합 ----

  /**
   * 조합을 시작한다. 선택이 있으면 지운 뒤에(엔진 호출 성공) 조합이 생긴다. 지우기가 예외면 조합은 없다(uncertain).
   * 지운 뒤 화면 갱신이 실패하면 markFailed가 이 조합(지운 것)을 변경 1개로 세고 끝낸다.
   */
  beginComposition(): void {
    if (this.objectSelection || !this.editable || this.composition || !this.canDeleteSelection() || !this.text?.canInsertText(this.caret)) return;
    this.clipboardVersion += 1;
    this.settleProvisional();
    if (!this.editable) return;
    if (!this.hasSelection) {
      this.composition = { anchor: this.caret, text: "", deletedSelection: false };
      if (this.pendingFor(this.caret)) this.pendingChars!.origin = RhwpEditorSession.positionKey(this.caret);
      return;
    }
    this.mutate(() => {
      const at = this.deleteSelectionRaw();
      this.composition = { anchor: at, text: "", deletedSelection: true };
      return at;
    }, false, "typing", null); // 선택 바꾸기는 새 단계(before = 지우기 전)
  }

  /** 조합 문자열이 바뀌었다(입력 이벤트). 문서의 조합 범위를 새 문자열로 바꾼다. 변경으로 세지 않는다. */
  updateComposition(text: string): void {
    const composition = this.composition;
    if (composition) this.replaceComposition(composition, text);
  }

  /**
   * 문서의 조합 범위를 text로 바꾼다. 모델이 조합 기록과 맞으면 true: 바꿨거나, 같거나, 편집할 수 없는 동안이라 바꾸지
   * 않음(모델에는 이전 조합 글자). 엔진 호출이 예외를 던지면 false: mutate가 이 조합을 세지 않고 끝내고 모델을
   * uncertain으로 표시한다. 조합 글자 기록은 엔진 호출이 모두 성공한 뒤에만 바꾼다(그 뒤 화면 갱신이 실패해도 맞음).
   */
  private replaceComposition(composition: Composition, text: string): boolean {
    if (composition.text === text || !this.editable) return true;
    return this.mutate(() => {
      const current = charCount(composition.text);
      if (current > 0) this.text!.delete(composition.anchor, current);
      if (text) this.insertText(composition.anchor, text);
      composition.text = text;
      return { ...composition.anchor, offset: composition.anchor.offset + charCount(text) };
    }, false, "typing", RhwpEditorSession.positionKey(composition.anchor)); // 갱신은 단계가 아님: 정리할 때 닫는다
  }

  /**
   * 조합이 끝났다(확정, 취소면 ""). 최종 문자열로 바꾸고 조합을 정리한 뒤 문서에 남은 조합 글자를 돌려준다.
   * - 성공: 문서가 바뀌었으면(글자를 남김 또는 선택을 지움) 변경 정확히 1개.
   * - 취소: 넣었던 글자를 지운다. 선택을 지우고 시작했으면 그 지우기만 변경 1개.
   * - 엔진 예외(실패·불확실): 세지 않고 ""(조합은 이미 끝남, 모델은 uncertain).
   * 바꾼 뒤 화면 갱신이 실패해 편집이 멈췄으면 markFailed가 이미 이 조합을 셌으므로 다시 세지 않는다.
   */
  endComposition(finalText: string, options: { provisional?: boolean } = {}): string {
    const composition = this.composition;
    if (!composition) return "";
    if (!this.replaceComposition(composition, finalText)) return "";
    if (this.composition === composition) {
      if (options.provisional) {
        // 앱이 먼저 끝낸 조합: 입력기의 최종 글자가 오면(resolveProvisional) 고친 뒤 이 조합 하나로 센다.
        this.composition = null;
        this.provisional = composition;
      } else this.settleComposition();
    }
    this.emit();
    return composition.text;
  }

  /** 진행 중인 조합을 끝내고, 그 조합이 모델에 남긴 변경(모두 성공한 엔진 호출)이 있으면 1개로 센다. */
  private settleComposition() {
    this.settleProvisional();
    const composition = this.composition;
    if (!composition) return;
    this.composition = null;
    this.closePendingOrigin();
    if (composition.text !== "" || composition.deletedSelection) this.recordMutation();
    else this.cancelHistory(); // 문서를 바꾸지 않은 조합: 단계 없음, 찍은 스냅숏만 버림
  }

  /** 기다리던 조합을 지금 모델 그대로(고치지 않고) 한 번 센다. 다른 변경·새 조합·편집 중지 전에 부른다. */
  private settleProvisional() {
    const provisional = this.provisional;
    if (!provisional) return;
    this.provisional = null;
    this.closePendingOrigin();
    if (provisional.text !== "" || provisional.deletedSelection) this.recordMutation();
    else this.cancelHistory();
  }

  /** 입력기의 끝을 기다리는 앱 확정 조합이 있음. */
  get awaitingCompositionEnd() {
    return this.provisional !== null;
  }

  /**
   * 앱이 먼저 끝낸 조합을 입력기의 최종 글자로 끝낸다. 다르면 원래 자리의 글자를 고친다. 그 조합 전체를 변경 하나로 센다
   * (조합 중 갱신과 같은 계약: 끝날 때 한 번). 고치기의 엔진 호출이 예외면 세지 않고 uncertain으로 보호한다(5차 정책).
   * 편집할 수 없는 동안(표시 한도 등)이면 고치지 않고 모델 그대로 센다. finalText가 없으면 그대로 센다.
   */
  resolveProvisional(finalText?: string): void {
    const provisional = this.provisional;
    if (!provisional) return;
    if (finalText !== undefined && finalText !== provisional.text && this.editable) {
      this.provisional = null; // 고치는 동안(mutate) 다른 정리가 이 조합을 따로 세지 않게
      const at = provisional.anchor;
      const removed = charCount(provisional.text);
      const delta = charCount(finalText) - removed;
      const shift = (position: DocPosition): DocPosition =>
        sameContext(position, at) && paragraphOf(position) === paragraphOf(at) && position.offset >= at.offset + removed
          ? { ...position, offset: position.offset + delta }
          : position;
      const changed = this.mutate(() => {
        if (removed > 0) this.text!.delete(at, removed);
        if (finalText) this.insertText(at, finalText);
        provisional.text = finalText;
        return { caret: shift(this.caret), anchor: shift(this.anchor) };
      }, false, "typing", RhwpEditorSession.positionKey(at));
      if (!changed) return; // 엔진 예외: mutate가 uncertain으로 표시하고 편집을 멈췄다(세지 않음)
      // 고친 변경은 성공했다(그 뒤 화면 갱신이 실패해 편집이 멈췄어도 모델에 있으므로 센다, 확정은 보내지 않음).
      this.provisional = provisional;
    }
    this.settleProvisional();
    this.emit();
  }

  /** Capture a one-use position owned by this session for a delayed IME commit. */
  markCaret(): object {
    const target = {};
    this.imeTargets.set(target, { at: this.caret, epoch: this.imeEpoch, version: this.modelVersion });
    return target;
  }

  /**
   * 이미 끝낸 위치(at)에 늦게 확정된 글자를 넣는다(조합 중 클릭 뒤 IME가 보낸 확정). 변경 하나로 세고, 커서·선택
   * 기준점은 같은 문단의 그 위치 뒤에 있을 때만 넣은 글자만큼 민다(커서를 확정 위치로 옮기지 않음).
   */
  insertCommittedAt(target: unknown, text: string): boolean {
    if (!target || typeof target !== "object") return false;
    const captured = this.imeTargets.get(target);
    this.imeTargets.delete(target);
    if (!captured || captured.epoch !== this.imeEpoch || !text || this.composition) return false;
    const { at, version } = captured;
    if (at.cell?.textBox || at.cell?.caption) {
      // A control index may name a different box after any model edit.
      // A caret move alone leaves the captured owner and offset valid.
      if (version !== this.modelVersion || this.provisional || !this.ownsPosition(at)
        || !validClipboardText(text) || /[\r\n\u2029]/u.test(text) || (at.cell.caption && (text.includes("\t") || !this.text?.canInsertText(at)))) return false;
      try {
        if (!this.text || !Number.isSafeInteger(at.offset) || at.offset < 0
          || !(at.offset <= this.text.paragraphLength(at))) return false;
      } catch { return false; }
    }
    this.selectedObject = null; // A late IME commit changes engine addresses.
    const length = charCount(text);
    const shift = (position: DocPosition): DocPosition =>
      sameContext(position, at) && paragraphOf(position) === paragraphOf(at) && position.offset >= at.offset
        ? { ...position, offset: position.offset + length }
        : position;
    return this.mutate(() => {
      this.insertText(at, text);
      return { caret: shift(this.caret), anchor: shift(this.anchor) };
    });
  }

  // ---- 커서 이동 ----

  /** Apply a caret move. false = refused (an extension outside the anchor's text context or table); state unchanged. */
  private moveTo(position: DocPosition, extend: boolean, keepPreferredX = false): boolean {
    if (extend && !sameContext(this.anchor, position) && !sameTable(this.anchor, position)) return false; // 텍스트 문맥 또는 같은 표의 셀 범위만 확장한다.
    this.selectedObject = null;
    this.clipboardVersion += 1;
    this.history?.boundary(); // 이동·클릭·선택은 타자 그룹을 끊는다
    this.caret = position;
    if (!extend) this.anchor = position;
    if (!keepPreferredX) this.preferredX = -1;
    this.reconcilePending();
    this.emit();
    return true;
  }

  moveHorizontal(delta: -1 | 1, extend: boolean): boolean {
    const text = this.text;
    if (!text || !this.editable) return false;
    if (!extend && this.hasSelection && sameContext(this.anchor, this.caret)) {
      const [from, to] = this.ordered();
      return this.moveTo(delta < 0 ? from : to, false);
    }
    const at = this.caret;
    const length = text.paragraphLength(at);
    const paragraph = paragraphOf(at);
    let next: DocPosition | null = null;
    if (delta < 0) {
      if (at.offset > 0) next = { ...at, offset: at.offset - 1 };
      else if (paragraph > 0) {
        const previous = withParagraph(at, paragraph - 1, 0);
        next = { ...previous, offset: text.paragraphLength(previous) };
      }
    } else if (at.offset < length) next = { ...at, offset: at.offset + 1 };
    else if (paragraph + 1 < text.paragraphCount(at)) next = withParagraph(at, paragraph + 1, 0);
    if (!next) return false;
    return this.moveTo(next, extend);
  }

  moveVertical(delta: -1 | 1, extend: boolean): boolean {
    const moved = this.text?.vertical(this.caret, delta, this.preferredX);
    if (!moved || !this.editable) return false;
    if (extend && !sameContext(this.anchor, moved.position)) return false;
    if (!this.ownsPosition(moved.position)) return false;
    if (!this.moveTo(moved.position, extend, true)) return false;
    this.preferredX = moved.preferredX;
    return true;
  }

  moveLineEdge(edge: "start" | "end", extend: boolean): boolean {
    const line = this.text?.line(this.caret);
    if (!line || !this.editable) return false;
    const length = this.text!.paragraphLength(this.caret);
    const offset = edge === "start" ? line.start : Math.min(line.end, length);
    return this.moveTo({ ...this.caret, offset }, extend);
  }

  /** 표 셀 사이 이동(Tab). 표 밖이거나 더 갈 셀이 없으면 false. */
  moveCell(delta: -1 | 1): boolean {
    const at = this.caret;
    const cells = this.text?.cellCount(at);
    if (!at.cell || cells === null || cells === undefined || !this.editable) return false;
    // Tab stays inside the caret's own table: the innermost level of the path, never the parent table.
    const target = innermost(at.cell).cell + delta;
    if (target < 0 || target >= cells) return false;
    const next = withCell(at, target);
    if (!this.ownsPosition(next)) return false;
    return this.moveTo(next, false);
  }

  private bodyDrawingsEqualOnReopen(doc: RhwpDocument, reopened: RhwpDocument, controlsJson: string): boolean {
    try {
      const parsed = JSON.parse(controlsJson) as { ctrlId?: string; list?: number; para?: number; controlIndex?: number; userDesc?: string }[];
      const hwpx = doc.getSourceFormat() === "hwpx";
      const drawings = parsed.filter(c => c.ctrlId === "gso" && c.list === 0
        && (["OLE", "차트", "다각형", "곡선", "그리기"].includes(c.userDesc ?? "") || (hwpx && c.userDesc === "그림"))
        && typeof c.para === "number" && typeof c.controlIndex === "number");
      if (!drawings.length) return true;
      const sectionCount = doc.getSectionCount?.() ?? 1;
      const ends: number[] = [];
      let total = 0;
      for (let s = 0; s < sectionCount; s++) {
        total += doc.getParagraphCount(s);
        ends.push(total);
      }
      for (const c of drawings) {
        const g = c.para!;
        let s = 0;
        while (s < ends.length && g >= ends[s]!) s += 1;
        if (s >= ends.length) continue;
        const p = g - (s === 0 ? 0 : ends[s - 1]!);
        const address = [s, p, c.controlIndex!] as const;
        if (c.userDesc === "다각형" || c.userDesc === "곡선") {
          if (doc.getEditableShapePath?.(...address) !== reopened.getEditableShapePath?.(...address)) return false;
        } else if (c.userDesc === "그리기") {
          if (doc.getEditableGroupFills?.(...address) !== reopened.getEditableGroupFills?.(...address)) return false;
        } else if (c.userDesc === "그림") {
          if (JSON.stringify(readHwpxPictureCaption(doc, address)) !== JSON.stringify(readHwpxPictureCaption(reopened, address))) return false;
        } else {
          const before = this.readChartFrom(doc, address);
          const after = this.readChartFrom(reopened, address);
          if (before && JSON.stringify(before) !== JSON.stringify(after)) return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  private readChartFrom(doc: RhwpDocument | null, address: readonly [number, number, number] | undefined) {
    if (!doc?.getChartData || !address) return undefined;
    try {
      if (address[1] >= doc.getParagraphCount(address[0])) return undefined;
      const raw = JSON.parse(doc.getChartData(...address)) as { ok?: boolean; plot?: unknown; labels?: unknown; series?: unknown };
      if (raw?.ok !== true) return undefined;
      return parseGraphicProperties({ kind: "chart", plot: raw.plot, title: null, labels: raw.labels, series: raw.series });
    } catch {
      return undefined;
    }
  }

  private readChart(address: readonly [number, number, number] | undefined) {
    return this.readChartFrom(this.doc, address);
  }

  /** 페이지 좌표(배율 1)를 클릭했다. extend면 선택을 넓힌다. */
  pointAt(page: number, x: number, y: number, extend: boolean, drag = false, selectObject = false): boolean {
    if (!this.doc || !this.editable || (drag && this.objectSelection)) return false;
    if (selectObject && !extend && !this.imeUnsettled && this.doc.getPageControlLayout) {
      try {
        const hit = hitRhwpObject(JSON.parse(this.doc.getPageControlLayout(page)), page, x, y);
        if (hit) {
          this.clipboardVersion += 1;
          this.history?.boundary();
          const address = hit.bodyPicture;
          const body = address && address[1] < this.doc.getParagraphCount(address[0]);
          const cellPicture = hit.cellPicture && this.readCellPicture(hit.cellPicture);
          const inspected = body ? inspectRhwpPicture(this.doc, address) : cellPicture?.picture;
          const graphic = this.readChart(hit.bodyEmbedded);
          const format = this.sessions.get(this.sessionId)?.format;
          const canEditHwp = format === "hwp" && this.structuralFormat();
          // Stage 3: HWPX always (with history), or HWP when preflight-safe & baseline-complete with field-level T009 proof.
          const canEditGso = format === "hwpx" || canEditHwp;
          const picUnlocked = format === "hwpx" || (canEditHwp && this.isEditableHwpGso(address, false));
          const canPic = Boolean(inspected && this.history && canEditGso && picUnlocked);
          const canResize = canPic && inspected!.simpleInline && !!this.doc.setPictureProperties;
          const canMove = canPic && !!inspected!.movable && !!this.doc.setPictureProperties;
          const canDelete = canPic && !!this.doc.deletePictureControl
            && (format === "hwpx" || inspected!.deletable || this.ownsHwpGsoCaption(address, false));
          const canFormat = canPic && !!this.doc.setPictureProperties && inspected!.plain;
          const operations: MutatingObjectOperation[] = cellPicture
            ? (format === "hwpx"
              ? ["resize", ...(this.doc.deleteCellPictureControlByPath ? ["delete" as const] : []), ...(inspected?.original ? ["crop" as const] : []), "altText"]
              : ["resize"])
            : [...(canMove ? ["move" as const] : []), ...(canResize ? ["resize" as const] : []), ...(canDelete ? ["delete" as const] : []),
              ...(canFormat && inspected!.original ? ["crop" as const] : []), ...(canFormat ? ["wrap" as const, "altText" as const] : [])];
          if (address && canFormat && inspected?.pagePlacement && this.unlockedBodyGso(address) === "그림") {
            operations.push("position");
          }
          const captionSide = format === "hwpx" && address && canPic && this.doc.setPictureProperties
            && this.unlockedBodyGso(address) === "그림" ? readHwpxPictureCaption(this.doc, address)?.side : undefined;
          if (captionSide) operations.push("captionSide");
          // Stage 3 P3: HWPX body shapes/text boxes, and verified HWP rectangle/ellipse/line/polygon/curve body shapes.
          const shapeAddress = hit.bodyShape && hit.bodyShape[1] < this.doc.getParagraphCount(hit.bodyShape[0]) ? hit.bodyShape : undefined;
          const shapeSupported = format === "hwpx" || (canEditHwp && this.isEditableHwpGso(shapeAddress, true));
          const shape = shapeAddress && this.history && canEditGso && shapeSupported && this.doc.setShapeProperties
            ? inspectRhwpShape(this.doc, shapeAddress) : undefined;
          const shapePath = shape && shapeAddress && hit.frame.width > 0 && hit.frame.height > 0 && this.doc.moveShapePathPoint
            ? inspectRhwpShapePath(this.doc, shapeAddress) : undefined;
          if (shapePath) operations.push("pathPoint");
          const curveTerminalLine = format === "hwp" && shapePath?.kind === "curve" && shapeAddress
            ? inspectRhwpCurveTerminalLine(this.doc, shapeAddress) : undefined;
          if (curveTerminalLine?.append || curveTerminalLine?.remove) operations.push("pathSegment");
          if (format === "hwpx" && shapePath?.kind === "polygon" && shapePath.closed && shapeAddress
            && this.doc.editPolygonVertex && this.doc.canEditPolygonVertices?.(...shapeAddress)) operations.push("pathVertex");
          if (shape) {
            operations.push(...(shape.movable ? ["move" as const] : []),
              ...(format === "hwpx" || !shape.sizeProtected ? ["resize" as const] : []),
              ...(this.doc.deleteShapeControl
                && (format !== "hwp" || !shape.hasCaption || this.ownsHwpGsoCaption(shapeAddress, true))
                ? ["delete" as const] : []), "wrap",
              ...(shape.fillEditable ? ["fill" as const] : []), "outline", "rotate",
              ...(this.doc.changeShapeZOrder && (format === "hwpx" || this.hwpShapeLayers(shapeAddress))
                ? ["zOrder" as const] : []));
          }
          const groupAddress = hit.bodyGroup && hit.bodyGroup[1] < this.doc.getParagraphCount(hit.bodyGroup[0]) ? hit.bodyGroup : undefined;
          const groupSupported = format === "hwpx" || (canEditHwp && this.unlockedBodyGso(groupAddress) === "그리기");
          const group = groupAddress && this.history && canEditGso && groupSupported && this.doc.setShapeProperties
            ? inspectRhwpGroup(this.doc, groupAddress) : undefined;
          const groupChildFills = group && groupAddress && this.doc.setGroupChildFill
            ? inspectRhwpGroupFills(this.doc, groupAddress) : undefined;
          if (groupChildFills) operations.push("groupChildFill");
          const groupWrap = group && !group.raw.treatAsChar
            ? group.raw.textWrap === "Square" ? "square"
              : group.raw.textWrap === "TopAndBottom" ? "topAndBottom" : undefined
            : undefined;
          const groupDeletable = !!this.doc.deleteShapeControl
            && (format === "hwpx" || (canEditHwp && !!group?.groupFlatDeletable));
          if (group) {
            operations.push(...(group.movable ? ["move" as const] : []),
              ...(format === "hwpx" || !group.sizeProtected ? ["resize" as const] : []),
              ...(groupDeletable ? ["delete" as const] : []), "wrap");
          }
          const canEditChart = graphic?.kind === "chart" && this.history && this.doc.setChartData
            && (format === "hwpx" || (canEditHwp && this.unlockedBodyGso(hit.bodyEmbedded) === "OLE"));
          const chartAddress = canEditChart ? hit.bodyEmbedded : undefined;
          if (chartAddress) operations.push("chart");
          const copyAddress = group && groupAddress ? groupAddress
            : shape && shapeAddress ? shapeAddress
            : !cellPicture && address && operations.length > 0 ? address : undefined;
          const copyKind: RichObjectKind | null = group ? "group"
            : shape ? (shape.textBox ? "textBox" : "shape")
            : copyAddress ? "picture" : null;
          const canCopyObject = (format === "hwpx" || (format === "hwp" && operations.includes("delete")))
            && operations.length > 0 && !!copyAddress && !!copyKind
            && !!this.doc.copyControl && !!this.doc.pasteControl;
          const clipboardOps: ObjectOperation[] = canCopyObject
            ? ["copy", ...(operations.includes("delete") ? ["cut" as const] : [])]
            : [];
          this.selectedObject = {
            model: this.modelVersion, layout: this.layoutVersion, owner: this.epoch,
            ...(operations.length > 0 && address ? { pictureAddress: address } : {}),
            ...(cellPicture ? { cellPicture: hit.cellPicture } : {}),
            ...(shape && shapeAddress ? { shapeAddress } : {}),
            ...(group && groupAddress ? { groupAddress } : {}),
            ...(chartAddress ? { chartAddress } : {}),
            ...(canCopyObject ? { copyControl: { kind: copyKind!, address: copyAddress! } } : {}),
            selection: {
              kind: graphic?.kind ?? (shape?.textBox ? "textBox" : hit.kind), frame: hit.frame, address: { engine: "rhwp", path: hit.path },
              epoch: ++this.objectEpoch, sessionId: this.sessionId, loadGeneration: this.generation,
              revision: this.committed + this.pending, editable: operations.length > 0,
              operations: ["deselect", ...operations, ...clipboardOps],
              ...(inspected ? { picture: inspected.properties } : {}),
              ...(group ? { groupSize: { widthPt: group.widthPt, heightPt: group.heightPt } } : {}),
              ...(groupWrap ? { groupWrap } : {}),
              ...(shapePath ? { shapePath } : {}),
              ...(curveTerminalLine ? { curveTerminalLine } : {}),
              ...(captionSide ? { captionSide } : {}),
              ...(groupChildFills ? { groupChildFills } : {}),
              ...(graphic ? { graphic } : {}),
              ...(shape ? { shape: {
                ...shape.properties,
                ...(shape.solidOutline && this.isEditableHwpGso(shapeAddress, true) ? { outlineWidthEditable: true } : {}),
              } } : {}),
            },
          };
          this.emit();
          return true;
        }
      } catch { /* Preserve the text hit path if the layout query is unavailable. */ }
    }
    let position: DocPosition | null;
    try {
      const hit = JSON.parse(this.doc.hitTest(page, x, y));
      position = parsePosition(hit, this.canEditTextBox(hit?.sectionIndex));
    } catch {
      position = null;
    }
    if (!position) return false;
    // 셀 위치는 그 컨트롤이 실제 표일 때만(엔진이 표가 아닌 컨트롤 안을 셀처럼 돌려주는 경우가 있다 — 그 자리에 쓰면 엔진 예외로 편집이 멈춤).
    if (position.cell && !position.cell.textBox) {
      if (this.ownsHwpPictureCaption(position)) {
        position = { ...position, cell: { ...position.cell, caption: true } };
      } else if (this.text?.cellCount(position) === null) return false;
    }
    // 중첩 표: 엔진이 준 경로를 화면 좌표와 무관하게 커서 목록으로 다시 증명한다(부모 셀·형제 표로 읽지 않음). 지원 깊이 밖이면 거절.
    if (!this.ownsPosition(position)) return false;
    return this.moveTo(position, extend);
  }

  // ---- 확정·실패·정리 ----

  private owns(epoch: number) {
    return !this.disposed && this.epoch === epoch;
  }

  private async flushCommits() {
    const epoch = this.epoch;
    const generation = this.generation;
    if (this.committingEpoch === epoch) return;
    this.committingEpoch = epoch;
    try {
      while (this.pending > 0 && this.owns(epoch) && this.status.kind === "ready") {
        const count = this.pending;
        const started = import.meta.env.VITE_GEUL_TEST_HOOKS === "1" ? performance.now() : 0;
        const result = await this.backend.commit(this.sessionId, generation, this.committed, count);
        trace("rhwp:commit-ack", () => ({ session: this.sessionId, generation, ms: performance.now() - started }));
        if (!this.owns(epoch)) return;
        if (!result.ok) {
          this.handleBackendRejection(result.error);
          return;
        }
        this.committed = result.value.revision;
        this.pending -= count;
        this.sessions.applyUpdate(result.value);
        this.emit();
      }
    } finally {
      if (this.committingEpoch === epoch) this.committingEpoch = null;
    }
  }

  private handleBackendRejection(error: DocumentError) {
    if (error.code === "StaleSession" || error.code === "UnknownSession") {
      this.dispose();
      return;
    }
    if (error.code === "StaleLoad") {
      // 이 모델은 더 새로운 불러오기 시도로 대체됐다. 그 시도의 상태를 건드리지 않고 편집만 멈춘다.
      this.status = { kind: "failed", error };
      this.settleComposition();
      this.dropHistory("unavailable");
      this.emit();
      const epoch = this.epoch;
      void this.sessions.refresh(this.sessionId, () => this.owns(epoch));
      return;
    }
    this.markFailed(error);
  }

  private failEditing() {
    this.markFailed({ code: "EngineFailure", engine: "rhwp", stage: "edit" });
  }

  /**
   * 편집을 멈추고 세션을 failed로 돌린다(백엔드 전이는 비동기, 다시 불러오기가 그 결과를 확인함). 모델은 표시용으로만
   * 남긴다. 확정하지 못한 변경(pending)은 지우지 않는다: 그 편집은 모델에 있고 저장되지 않았으므로, 다시 불러오기·닫기
   * 전에 버리기 확인이 필요하다. 진행 중인 조합은 여기서 끝나며, 그때까지 성공한 조합 변경은 1개로 센다(확정은 하지 않음).
   */
  private markFailed(error: DocumentError) {
    if (this.status.kind === "failed" || this.disposed) return;
    // 출발 상태는 이 편집 세션이 아는 단계로 정한다(투영은 refresh가 늦게 올 수 있음). ready 요청이 거부된 불러오기면 loading.
    const from = this.status.kind === "loading" ? "loading" : "ready";
    this.status = { kind: "failed", error }; // 조합을 세기 전에: 확정을 보내지 않는다
    this.settleComposition();
    this.dropHistory("unavailable"); // 편집을 멈춘 모델의 기록은 쓰지 않는다(엔진이 불확실하면 스냅숏을 엔진에서 버리지 않음)
    this.failure = this.reportFailure(this.generation, from);
    this.emit();
  }

  /**
   * failed 전이를 보낸다. 응답은 그 epoch일 때만 투영에 반영한다. 요청 Promise가 거부되면(전송 예외) Protocol 결과로
   * 바꿔, 기다리는 쪽이 멈추거나 처리되지 않은 거부로 수명주기 정리를 건너뛰지 않게 한다(확인 안 됨 → 다음 reload가 다시 확인).
   */
  private reportFailure(generation: number, from: "loading" | "ready"): FailureTransition {
    const epoch = this.epoch;
    const sent = this.backend.setState(this.sessionId, generation, from, "failed")
      .catch((): Result<SessionInfo> => ({ ok: false, error: { code: "Protocol" } }));
    const result = sent.then((failed) => {
      if (this.owns(epoch) && failed.ok) this.sessions.applyUpdate(failed.value);
      return failed;
    });
    return { generation, from, result };
  }

  /**
   * 메모리에서 원본 형식으로 내보내고 다시 열어 형식·쪽 수·본문 텍스트·컨트롤 배치를 비교한다(파일을 쓰지 않음).
   * 형식은 요청한 확장자가 아니라 다시 연 문서와 내보낸 바이트로 확인한다. 손실 보고가 올바른 모양이고 0건이며
   * 비교가 모두 같을 때만 passed. 실패해도 내보낸 객체·다시 연 문서는 놓는다.
   * 결과는 지금 모델에 대한 것이며, 문서를 바꾸면 지운다.
   */
  roundTrip(format: "hwp" | "hwpx"): RoundTripReport | null {
    const result = this.exportAndCompare(format);
    if (!result) return null;
    this.lastRoundTrip = result.report;
    this.emit();
    return result.report;
  }

  /**
   * 원본 형식으로 내보내고 다시 열어 비교한다(roundTrip·저장이 함께 씀). bytes·contentLoss(손실 보고 JSON 값, 읽지 못하면
   * null)는 내보내기에 성공했을 때만. reopen은 다시 열어 비교한 네 값이다.
   */
  private exportAndCompare(format: "hwp" | "hwpx", mode: "roundTrip" | "publish" | "checkpoint" = "roundTrip"): {
    report: RoundTripReport;
    bytes: Uint8Array | null;
    contentLoss: unknown;
    reopen: ReopenEvidence;
    charShapeCount: number | null;
    releaseShapes: (() => void) | undefined;
    preview: PreviewRaster | null;
    /** The strict export was refused because a changed formula cache is not proven current. */
    formulaCache?: boolean;
  } | null {
    const doc = this.doc;
    const module = this.module;
    if (!doc || !module) return null;
    // publish: Save/Save As (char-shape publication lease). checkpoint (T014 B): the same strict output and
    // HWP preview evidence, but no publication lease — a recovery record never becomes the published source.
    const publishing = mode === "publish";
    const strict = mode !== "roundTrip";
    let output: Uint8Array | null = null;
    let contentLoss: unknown = null;
    let charShapeCount: number | null = null;
    let releaseShapes: (() => void) | undefined;
    let preview: PreviewRaster | null = null;
    const report: RoundTripReport = {
      format, failure: "export", bytes: 0, reopenedFormat: null, formatEqual: false, lossValid: false, lossCount: -1, losses: [],
      pagesEqual: false, textEqual: false, controlsEqual: false, passed: false,
    };
    let reopened: RhwpDocument | null = null;
    let rebuilt = false;
    let formulaCache = false;
    try {
      let bytes: Uint8Array;
      try { this.text?.prepareExport(); } catch (error) { formulaCache = error instanceof FormulaCacheRefusal; throw error; }
      // HWP: incremental pagination after edits can differ from a fresh layout of the same model (the export
      // reopens with a fresh layout). Rebuild the live derived layout first so page evidence compares like
      // with like; the model itself is unchanged. The display layout is restored below (T010 D1).
      if (format === "hwp" && typeof doc.rebuildLayout === "function") {
        rebuilt = true;
        doc.rebuildLayout();
        try { this.pages = readPages(doc); } catch { /* the comparison below still uses the engine's page count */ }
      }
      const exported = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
      try {
        const raw = exported.contentLoss();
        const loss = parseLoss(raw);
        if (loss) Object.assign(report, { lossValid: true, lossCount: loss.count, losses: loss.losses });
        try {
          contentLoss = JSON.parse(raw);
        } catch {
          contentLoss = null; // 백엔드가 LossReportInvalid로 판정한다
        }
        bytes = exported.takeBytes();
      } finally {
        // 해제 실패는 이 내보내기를 쓰지 않게 하고(바깥 catch), 모듈 상태를 믿을 수 없으므로 정리 실패 정책을 따른다.
        try { exported.free(); } catch (error) {
          this.saveCleanupFailed(error, this.epoch);
          // eslint-disable-next-line no-unsafe-finally -- the primary error shares this stage and the outer catch owns the result
          throw error;
        }
      }
      output = bytes;
      report.bytes = bytes.length;
      report.failure = "reopen";
      // This evidence concerns the raw engine export. For HWP, the save service
      // verifies that final CFB reconstruction changes only PrvText before publication.
      reopened = module.openDocument(bytes);
      // Stage 5-A: measure the reopened evidence with the live document's natural-font snapshot (shared, no bytes) so
      // page evidence compares like with like. A trap fails this evidence closed (reopen stage).
      if (typeof reopened.adoptNaturalFontsFrom === "function" && typeof doc.adoptNaturalFontsFrom === "function") {
        reopened.adoptNaturalFontsFrom(doc);
      }
      const shapeCount = reopened.charShapeCount?.();
      if (Number.isSafeInteger(shapeCount) && (shapeCount as number) >= 0) charShapeCount = shapeCount!;
      const reopenedFormat: unknown = reopened.getSourceFormat();
      report.reopenedFormat = typeof reopenedFormat === "string" ? reopenedFormat : null;
      report.formatEqual = report.reopenedFormat === format && hasSignature(bytes, format);
      const controls = (d: RhwpDocument) => (d as unknown as { getControls(): string }).getControls();
      const textOf = (d: RhwpDocument) => (d as unknown as { getTextFileText(): string }).getTextFileText();
      report.pagesEqual = reopened.pageCount() === doc.pageCount();
      report.textEqual = textOf(reopened) === textOf(doc);
      report.controlsEqual = controls(reopened) === controls(doc);
      if ((format === "hwpx" || format === "hwp") && (doc.getChartData || doc.getEditableShapePath || doc.getEditableGroupFills)) {
        report.controlsEqual &&= this.bodyDrawingsEqualOnReopen(doc, reopened, controls(doc));
      }
      if (format === "hwp") {
        report.controlsEqual &&= hwpReopenEqual(hwpReopenModel(doc), hwpReopenModel(reopened), this.hwpBaseline?.structure ?? null);
      }
      if (publishing) releaseShapes = this.text?.protectPublishingCharShapes(charShapeCount, reopened);
      // HWP: page 1 of the reopened raw export — the same bytes the service validates — for
      // PrvImage regeneration. Failure only omits the raster (stale previews stay refused).
      if (strict && format === "hwp") preview = capturePreviewRaster(reopened);
      report.failure = null;
    } catch {
      // report.failure가 실패한 단계를 가리킨다.
      if (strict) output = null;
    } finally {
      try { reopened?.free(); } catch (error) {
        report.failure = "reopen";
        this.saveCleanupFailed(error, this.epoch);
        if (strict) output = null;
      }
      // T010 D1: the fresh layout was comparison evidence only. A background checkpoint or save must not
      // change the displayed pagination of an unchanged model, and Undo/Redo (snapshot restore = edit-session
      // layout) must return the page the user saw. A trap here leaves the layout unknown: fail closed.
      if (rebuilt && typeof doc.restoreSessionLayout === "function") {
        try {
          doc.restoreSessionLayout();
          this.pages = readPages(doc);
        } catch (error) {
          report.failure ??= "export";
          this.saveCleanupFailed(error, this.epoch);
          if (strict) output = null;
        }
      }
    }
    report.passed = report.failure === null && report.lossValid && report.lossCount === 0 && report.formatEqual
      && report.pagesEqual && report.textEqual && report.controlsEqual;
    const reopen: ReopenEvidence = {
      formatEqual: report.failure === null && report.formatEqual,
      pagesEqual: report.failure === null && report.pagesEqual,
      textEqual: report.failure === null && report.textEqual,
      controlsEqual: report.failure === null && report.controlsEqual,
    };
    return { report, bytes: output, contentLoss, reopen, charShapeCount, releaseShapes, preview: output ? preview : null, ...(formulaCache && !output ? { formulaCache } : {}) };
  }

  // ---- 명령(T010) ----

  /** 명령 가용성을 정하는 지금 상태. 기록은 세션의 RhwpHistory(없거나 꺼졌으면 null), 서식 상태는 없다(null). */
  snapshot(): DocumentCommandSnapshot {
    return {
      sessionId: this.sessionId, engine: this.engine, loadGeneration: this.generation, revision: this.committed,
      loaded: this.status.kind === "ready" && this.doc !== null && !this.closing, editable: this.editable,
      composing: this.imeUnsettled,
      pending: this.pending > 0 || this.committingEpoch === this.epoch, queuedHistory: null,
      saving: this.saving,
      clipboard: this.clipboardState(),
      objectSelection: this.objectSelection,
      // 기록은 지역·동기(queuedHistory 없음). 제품 고급 기록은 pending 확정도 명령 capability에서 거부한다.
      history: this.history ? { undo: this.history.canUndo, redo: this.history.canRedo } : null,
      ...(this.advancedHistoryOnly ? { historyScope: "advanced" as const } : {}),
      historyLimited: this.history === null && this.historyOff === "limit",
      format: this.formatState(), formatAccess: null, font: this.fontState(),
      ...this.parameterState(),
      chars: this.stage1Chars(),
      searchable: this.status.kind === "ready" && !!this.doc?.searchAllText && !!this.text,
      search: this.searchState(),
      actions: { ...this.coreActions(), ...this.stage1Actions(), ...this.stage1ParagraphActions(),
        ...(this.embedFontEligible() ? { "format.embedFont": {} } : {}) },
      paragraph: this.stage1Paragraph(),
      page: this.stage1Page(),
      ...this.embedReasons(this.coreActionReasons()),
      embeddedFonts: this.embeddedFonts(),
    };
  }

  // ---- Stage 1 paragraph alignment and formatting (body paragraphs; bullet-path eligibility) ----

  private paragraphCache: { key: string; value: ParagraphState | null } | null = null;

  /**
   * Selected paragraphs of one owned context: body, a first-level cell, or a nested cell (explicit path). Same
   * eligibility as bullets (structural original proof, editable, no IME/uncertain/pending); the exclusive end at offset
   * zero of a later paragraph is not selected. Nested cells need the path APIs of the stage1-editing engine patch.
   */
  private stage1ParaRange(): { at: DocPosition; first: number; last: number } | null {
    const doc = this.doc;
    if (!doc || !this.structuralFormat() || !this.editable || this.imeUnsettled || this.uncertain || this.pending > 0
      || this.committingEpoch === this.epoch || this.saving || !sameContext(this.anchor, this.caret)
      || !this.ownsPosition(this.caret) || !this.ownsPosition(this.anchor)) return null;
    const c = this.caret.cell;
    if (c?.nested ? !doc.applyParaFormatInCellByPath || !doc.getCellParaPropertiesAtByPath
      : c ? !doc.applyParaFormatInCell || !doc.getCellParaPropertiesAt : !doc.applyParaFormat || !doc.getParaPropertiesAt) return null;
    const [from, to] = this.ordered();
    const first = paragraphOf(from), lastRaw = paragraphOf(to);
    const last = lastRaw > first && to.offset === 0 ? lastRaw - 1 : lastRaw;
    return last - first < 256 ? { at: from, first, last } : null;
  }

  private readPara(at: DocPosition, p: number): Record<string, unknown> {
    const doc = this.doc!, c = at.cell;
    return JSON.parse(c?.nested ? doc.getCellParaPropertiesAtByPath!(at.section, c.parentParagraph, pathJson(c, p))
      : c ? doc.getCellParaPropertiesAt!(at.section, c.parentParagraph, c.control, c.cell, p)
      : doc.getParaPropertiesAt!(at.section, p)) as Record<string, unknown>;
  }

  private applyPara(at: DocPosition, p: number, props: string): void {
    const doc = this.doc!, c = at.cell;
    const raw = c?.nested ? doc.applyParaFormatInCellByPath!(at.section, c.parentParagraph, pathJson(c, p), props)
      : c ? doc.applyParaFormatInCell!(at.section, c.parentParagraph, c.control, c.cell, p, props)
      : doc.applyParaFormat!(at.section, p, props);
    if (JSON.parse(raw).ok !== true) throw new Error("paragraph formatting rejected");
  }

  /** Selected paragraphs' formatting from the engine; null values are mixed. Lengths are reported in points. */
  private stage1Paragraph(): ParagraphState | null {
    const range = this.stage1ParaRange();
    if (!range) return null;
    const key = `${this.epoch}|${this.modelVersion}|${RhwpEditorSession.positionKey(range.at)}|${range.first}|${range.last}`;
    if (this.paragraphCache?.key === key) return this.paragraphCache.value;
    let value: ParagraphState | null;
    try {
      // The engine reports px (96 dpi) with 0.1 px precision: points are shown to 0.1 pt.
      const px = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? Math.round(v * 72 / 96 * 10) / 10 : null;
      const all: (Omit<ParagraphState, "list"> & { list: string })[] = [];
      const lists: (ListState | null)[] = [];
      for (let p = range.first; p <= range.last; p++) {
        const raw = this.readPara(range.at, p);
        const align = ({ justify: "justify", left: "left", right: "right", center: "center" } as Record<string, ParagraphAlign>)[String(raw.alignment)] ?? null;
        const type = raw.lineSpacingType, ls = raw.lineSpacing;
        const lineSpacing = typeof ls !== "number" ? null : type === "Percent" ? { rule: "multiple" as const, value: ls / 100 }
          : type === "Fixed" ? { rule: "exactly" as const, value: px(ls)! } : type === "Minimum" ? { rule: "atLeast" as const, value: px(ls)! } : null;
        const level = Number.isSafeInteger(raw.paraLevel) ? raw.paraLevel as number : 0;
        const list = raw.headType === "Bullet" ? { bullets: true, numbering: false, multilevel: false, level }
          : raw.headType === "Number" && Number.isSafeInteger(raw.numberingId) && (raw.numberingId as number) > 0
            ? { bullets: false, numbering: true, multilevel: this.multilevelNumbering(raw.numberingId as number), level } : null;
        lists.push(list);
        all.push({ align, lineSpacing, spaceBefore: px(raw.spacingBefore), spaceAfter: px(raw.spacingAfter),
          indentLeft: px(raw.marginLeft), indentRight: px(raw.marginRight), indentFirst: px(raw.indent), list: JSON.stringify(list) });
      }
      const same = <K extends keyof Omit<ParagraphState, "list">>(k: K): ParagraphState[K] | null => {
        const first = JSON.stringify(all[0]![k]);
        return all.every(x => JSON.stringify(x[k]) === first) ? all[0]![k] as ParagraphState[K] : null;
      };
      // List state of the caret paragraph (as in DOCX).
      const caretList = lists[Math.min(Math.max(paragraphOf(this.caret) - range.first, 0), lists.length - 1)] ?? null;
      value = { align: same("align"), lineSpacing: same("lineSpacing"), spaceBefore: same("spaceBefore"), spaceAfter: same("spaceAfter"),
        indentLeft: same("indentLeft"), indentRight: same("indentRight"), indentFirst: same("indentFirst"), list: caretList };
    } catch { value = null; }
    this.paragraphCache = { key, value };
    return value;
  }

  // ---- Stage 1 lists (numbering definitions appended with createNumbering; bullets via ensureDefaultBullet) ----

  /**
   * Numbering definitions are read from the engine model (authoritative, never an application-side id cache):
   * after Undo/Redo, reload or a document switch the current model alone decides which ids exist and what they
   * are. Parsed once per model version (keyed by epoch, load generation and modelVersion).
   */
  private numberingCache: { key: string; defs: Map<number, NumberingDef> } | null = null;

  private numberingDefs(): Map<number, NumberingDef> {
    const key = `${this.epoch}|${this.generation}|${this.modelVersion}`;
    if (this.numberingCache?.key === key) return this.numberingCache.defs;
    const defs = new Map<number, NumberingDef>();
    try {
      const list = JSON.parse(this.doc?.getNumberingList?.() ?? "[]") as unknown;
      if (Array.isArray(list)) for (const n of list.slice(0, 65535)) {
        const id = (n as { id?: unknown }).id, levelFormats = (n as { levelFormats?: unknown }).levelFormats;
        const numberFormats = (n as { numberFormats?: unknown }).numberFormats, startNumber = (n as { startNumber?: unknown }).startNumber;
        if (!Number.isSafeInteger(id) || !Array.isArray(levelFormats) || !levelFormats.every(f => typeof f === "string")) continue;
        defs.set(id as number, {
          levelFormats: levelFormats as string[],
          // An engine without numberFormats reports no style identity (null): nothing is then treated as a known style.
          numberFormats: Array.isArray(numberFormats) && numberFormats.every(c => Number.isSafeInteger(c)) ? numberFormats as number[] : null,
          startNumber: Number.isSafeInteger(startNumber) ? startNumber as number : null,
        });
      }
    } catch { /* unreadable: no definitions */ }
    this.numberingCache = { key, defs };
    return defs;
  }

  /** The geul list style a definition is, by exact semantics (level formats, per-level number format codes and start
   * number of the template), or null for any other definition (document-defined or custom). Never by id alone. */
  private numberingStyleOf(id: number): ListStyle | null {
    const def = this.numberingDefs().get(id);
    if (!def?.numberFormats || def.startNumber !== 1) return null;
    for (const [style, t] of Object.entries(RHWP_NUMBERING) as [ListStyle, (typeof RHWP_NUMBERING)[keyof typeof RHWP_NUMBERING]][]) {
      if (t.formats.every((f, i) => def.levelFormats[i] === f) && t.codes.every((c, i) => def.numberFormats![i] === c)) return style;
    }
    return null;
  }

  private multilevelNumbering(id: number): boolean {
    const style = this.numberingStyleOf(id);
    if (style) return style === "multilevel";
    const def = this.numberingDefs().get(id);
    // A level that shows an outer level's number (e.g. "^1.^2.") is multilevel numbering.
    return def?.levelFormats.some((f, i) => [...f.matchAll(/\^(\d)/g)].some(m => Number(m[1]) !== i + 1)) ?? false;
  }

  /** May list items of `style` join the existing definition `id`? Only when it is exactly that style. */
  private compatibleNumbering(id: number, style: ListStyle): boolean {
    return this.numberingStyleOf(id) === style;
  }

  /** The definition of `style`: an existing one of exactly that style in the current model (lowest id; restart copies
   * keep their own), or a new one (createNumbering). */
  private numberingFor(style: ListStyle): number {
    for (const id of [...this.numberingDefs().keys()].sort((a, b) => a - b)) if (this.numberingStyleOf(id) === style) return id;
    return this.createNumberingOf(style);
  }

  private createNumberingOf(style: ListStyle): number {
    const template = RHWP_NUMBERING[style as keyof typeof RHWP_NUMBERING];
    if (!template || !this.doc?.createNumbering) throw new Error("numbering style unavailable");
    const id = this.doc.createNumbering(JSON.stringify({ levelFormats: template.formats, numberFormats: template.codes, startNumber: 1 }));
    if (!Number.isSafeInteger(id) || id < 1 || id > 65535) throw new Error("invalid numbering id");
    this.numberingCache = null; // the model gained a definition inside this mutation
    if (this.numberingStyleOf(id) !== style) throw new Error("created numbering does not match its template");
    return id;
  }

  private listRange(): { at: DocPosition; first: number; last: number } | null {
    const range = this.stage1ParaRange();
    return range && this.doc?.createNumbering && this.doc.ensureDefaultBullet && this.doc.getNumberingList ? range : null;
  }

  /** Previous paragraph of the same context that is a numbered list item (its numbering id and level), if any. */
  private previousNumbered(at: DocPosition, before: number): { id: number; level: number } | null {
    for (let p = before - 1; p >= 0 && p >= before - 64; p--) {
      const raw = this.readPara(at, p);
      if (raw.headType === "Number" && Number.isSafeInteger(raw.numberingId) && (raw.numberingId as number) > 0)
        return { id: raw.numberingId as number, level: Number(raw.paraLevel) || 0 };
      const empty = this.doc!.getParagraphLength(at.section, at.cell ? at.cell.parentParagraph : p) === 0;
      if (!at.cell && !empty) return null; // a plain body paragraph ends the list
      if (at.cell) return null;
    }
    return null;
  }

  /** Apply list membership to the selected paragraphs in one mutation (one history step). */
  private applyList(build: (range: { at: DocPosition; first: number; last: number }) => (p: number) => Record<string, string | number> | null): boolean {
    const range = this.listRange();
    if (!range) return false;
    let props: (p: number) => Record<string, string | number> | null;
    this.history?.boundary();
    const applied = this.mutate(() => {
      props = build(range);
      for (let p = range.first; p <= range.last; p++) {
        const value = props(p);
        if (value) this.applyPara(range.at, p, JSON.stringify(value));
      }
      return { caret: this.caret, anchor: this.anchor };
    }, true, "other", null, true, true);
    this.history?.boundary();
    return applied;
  }

  private executeStage1List(command: DocumentCommandId, args?: DocumentCommandArgs): boolean | null {
    const lists = ["paragraph.numbering", "paragraph.multilevel", "paragraph.listStyle", "paragraph.increaseIndent",
      "paragraph.decreaseIndent", "paragraph.restartNumbering", "paragraph.continueNumbering"];
    if (!lists.includes(command)) return null;
    const range = this.listRange(), state = this.stage1Paragraph();
    if (!range || !state) return false;
    const read = (p: number) => this.readPara(range.at, p);
    const isNumber = (raw: Record<string, unknown>) => raw.headType === "Number" && Number(raw.numberingId) > 0;
    if (command === "paragraph.numbering" || command === "paragraph.multilevel") {
      if (args !== undefined) return false;
      const style: ListStyle = command === "paragraph.multilevel" ? "multilevel" : "numbered";
      const all = Array.from({ length: range.last - range.first + 1 }, (_, i) => read(range.first + i));
      const off = all.every(raw => isNumber(raw) && this.multilevelNumbering(Number(raw.numberingId)) === (style === "multilevel"));
      if (off) return this.applyList(() => () => ({ headType: "None", numberingId: 0, paraLevel: 0 }));
      return this.applyList(r => {
        // Continue the previous list only when its definition is exactly this style; otherwise this style's definition.
        const previous = this.previousNumbered(r.at, r.first);
        const id = previous && this.compatibleNumbering(previous.id, style) ? previous.id : this.numberingFor(style);
        return p => ({ headType: "Number", numberingId: id, paraLevel: isNumber(read(p)) ? Number(read(p).paraLevel) || 0 : 0 });
      });
    }
    if (command === "paragraph.listStyle") {
      if (args?.command !== command || !validateCommandArgs(command, args, this.parameterState().parameters?.[command])) return false;
      const bullet = RHWP_BULLETS[args.style as keyof typeof RHWP_BULLETS];
      return this.applyList(() => {
        if (bullet) {
          const id = this.doc!.ensureDefaultBullet!(bullet);
          if (!Number.isSafeInteger(id) || id < 1 || id > 65535) throw new Error("invalid bullet id");
          return () => ({ headType: "Bullet", numberingId: id, paraLevel: 0 });
        }
        const id = this.numberingFor(args.style);
        return p => ({ headType: "Number", numberingId: id, paraLevel: isNumber(read(p)) ? Number(read(p).paraLevel) || 0 : 0 });
      });
    }
    if (command === "paragraph.increaseIndent" || command === "paragraph.decreaseIndent") {
      if (args !== undefined) return false;
      const delta = command === "paragraph.increaseIndent" ? 1 : -1;
      return this.applyList(() => p => {
        const raw = read(p);
        if (raw.headType === "Number" || raw.headType === "Bullet") {
          const level = Math.min(6, Math.max(0, (Number(raw.paraLevel) || 0) + delta));
          return level === (Number(raw.paraLevel) || 0) ? null : { paraLevel: level };
        }
        // Plain paragraphs: left indent by 10 mm steps (margins are stored doubled, see paragraph settings).
        const left = typeof raw.marginLeft === "number" ? raw.marginLeft * 72 / 96 : 0;
        return { marginLeft: Math.round(Math.max(0, left + delta * 28.35) * 200) };
      });
    }
    const caretPara = paragraphOf(this.caret);
    const here = read(caretPara);
    if (!isNumber(here) || args !== undefined) return false;
    const old = Number(here.numberingId);
    // The run of this list's items from the caret paragraph on (stops at a different list or a non-empty plain paragraph).
    const run = (from: number) => {
      const out: number[] = [];
      const count = range.at.cell ? Number.MAX_SAFE_INTEGER : this.doc!.getParagraphCount(range.at.section);
      for (let p = from; p < count && out.length < 4096; p++) {
        let raw: Record<string, unknown>;
        try { raw = read(p); } catch { break; }
        if (isNumber(raw) && Number(raw.numberingId) === old) out.push(p);
        else if (isNumber(raw) || raw.headType === "Bullet" || this.doc!.getParagraphLength(range.at.section, range.at.cell ? range.at.cell.parentParagraph : p) !== 0) break;
      }
      return out;
    };
    if (command === "paragraph.restartNumbering") {
      // Restart = a new definition of the same style for this item and the following items of the list (HWP numbering
      // counts per definition; the paragraph restart flag of the engine model is not serialized).
      // Restart needs the definition's exact template (a known style in the current model); other definitions keep
      // the documented limitation (refused, never reported as success).
      const style = this.numberingStyleOf(old);
      if (!style) return false;
      const targets = run(caretPara);
      this.history?.boundary();
      const applied = this.mutate(() => {
        const id = this.createNumberingOf(style); // a distinct definition of the same style for the restarted run
        for (const p of targets) this.applyPara(range.at, p, JSON.stringify({ numberingId: id }));
        return { caret: this.caret, anchor: this.anchor };
      }, true, "other", null, true, true);
      this.history?.boundary();
      return applied;
    }
    const previous = this.previousNumberedBefore(range.at, caretPara, old);
    if (!previous) return false;
    const targets = run(caretPara);
    return this.applyList(() => p => targets.includes(p) ? { numberingId: previous } : null);
  }

  /** Nearest earlier numbered list (a different definition of the same style) in the same context, for "continue
   * numbering": continuing never changes the run's numbering style. */
  private previousNumberedBefore(at: DocPosition, before: number, exclude: number): number | null {
    const style = this.numberingStyleOf(exclude);
    if (style === null) return null;
    for (let p = before - 1; p >= 0 && p >= before - 4096; p--) {
      let raw: Record<string, unknown>;
      try { raw = this.readPara(at, p); } catch { return null; }
      const id = Number(raw.numberingId);
      // Lists of another style are skipped (continuing never changes the run's style); an unknown style refuses.
      if (raw.headType === "Number" && id > 0 && id !== exclude && style !== null && this.numberingStyleOf(id) === style) return id;
    }
    return null;
  }

  // ---- Stage 1 F: document font embedding (HWPX: OWPML hh:font isEmbedded + manifest BinData) ----

  private embeddedCache: { key: string; value: EmbeddedFont[] } | null = null;
  /** Embedded font faces of the current model (unique face names), read from the engine (never a session cache). */
  private embeddedFonts(): EmbeddedFont[] {
    const key = `${this.epoch}|${this.generation}|${this.modelVersion}`;
    if (this.embeddedCache?.key === key) return this.embeddedCache.value;
    let value: EmbeddedFont[] = [];
    try {
      const list = JSON.parse(this.doc?.getEmbeddedFonts?.() ?? "[]") as unknown;
      if (Array.isArray(list)) {
        const faces = new Set<string>();
        for (const e of list.slice(0, 4096)) {
          const face = (e as { face?: unknown }).face, bytes = (e as { bytes?: unknown }).bytes;
          if (typeof face === "string" && Number.isSafeInteger(bytes) && (bytes as number) > 0) faces.add(face);
        }
        value = [...faces].map(family => ({ family }));
      }
    } catch { value = []; }
    this.embeddedCache = { key, value };
    return value;
  }

  /** HWP sources report the format limitation; other blocked states use the existing transaction reasons. */
  private embedReasons<T extends { actionReasons?: DocumentCommandSnapshot["actionReasons"] }>(base: T): T {
    if (this.sessions.get(this.sessionId)?.format !== "hwp") return base;
    return { ...base, actionReasons: { ...(base.actionReasons ?? {}), "format.embedFont": "engineUnsupported" } };
  }

  /** HWPX only (HWP 5.0 defines no font-embedding record); same transaction eligibility as other model edits. */
  private embedFontEligible(): boolean {
    const format = this.sessions.get(this.sessionId)?.format;
    return format === "hwpx" && !!this.doc?.embedFont && !!this.doc.getEmbeddedFonts && !!this.history && this.editable
      && !this.imeUnsettled && !this.uncertain && this.pending === 0 && this.committingEpoch !== this.epoch && !this.saving
      && !this.embedding && this.sessions.snapshot().activeId === this.sessionId;
  }

  private embedding = false;
  /**
   * Stage 1 F: embed a face's program into an HWPX document. The bytes come from the backend, which serves only faces
   * whose license permits editable embedding with TrueType outlines; the engine re-checks the permission, the outline
   * format and that the face is a family name of the font used by the document. One history step; resolves after the
   * model mutation succeeded (or was refused).
   */
  async executeEmbedFont(family: string, style: string): Promise<EmbedFontResult> {
    if (!this.embedFontEligible() || !documentCommandState("format.embedFont", this.snapshot()).available) return "stale";
    if (this.embeddedFonts().some(e => e.family === family)) return "unchanged";
    const epoch = this.epoch, version = this.modelVersion;
    this.embedding = true; this.emit();
    let bytes: Uint8Array | null;
    try { bytes = await embedFontData(family, style); }
    catch { bytes = null; }
    finally { this.embedding = false; }
    if (!this.owns(epoch) || version !== this.modelVersion || !this.embedFontEligible()) { this.emit(); return "stale"; }
    if (!bytes) { this.emit(); return "failed"; }
    const doc = this.doc!;
    let created = false;
    this.history?.boundary();
    const applied = this.mutate(() => {
      const result = JSON.parse(doc.embedFont!(family, bytes)) as Record<string, unknown>;
      if (result.ok !== true || !Number.isSafeInteger(result.binDataId) || !Number.isSafeInteger(result.entries) || (result.entries as number) < 1)
        throw new Error("embedFont result");
      created = result.created === true;
      return { caret: this.caret, anchor: this.anchor };
    }, true, "other", null, true, true);
    this.history?.boundary();
    if (!applied) return "failed";
    return this.embeddedFonts().some(e => e.family === family) ? (created ? "embedded" : "unchanged") : "failed";
  }

  private stage1ParagraphActions(): NonNullable<DocumentCommandSnapshot["actions"]> {
    const paragraph = this.stage1Paragraph();
    if (!paragraph) return {};
    const actions: NonNullable<DocumentCommandSnapshot["actions"]> = Object.fromEntries((Object.entries(ALIGN_COMMANDS) as [AlignCommandId, ParagraphAlign][])
      .map(([id, align]) => [id, { pressed: paragraph.align === align }]));
    if (this.listRange()) {
      const list = paragraph.list;
      actions["paragraph.numbering"] = { pressed: !!list?.numbering && !list.multilevel };
      actions["paragraph.multilevel"] = { pressed: !!list?.multilevel };
      actions["paragraph.increaseIndent"] = {};
      actions["paragraph.decreaseIndent"] = {};
      if (list?.numbering) {
        actions["paragraph.continueNumbering"] = {};
        // Restart needs a definition whose exact template is known (read from the current model).
        try {
          const id = Number(this.readPara(this.stage1ParaRange()!.at, paragraphOf(this.caret)).numberingId);
          if (this.numberingStyleOf(id)) actions["paragraph.restartNumbering"] = {};
        } catch { /* unavailable */ }
      }
    }
    return actions;
  }

  /** One engine call per selected paragraph inside one mutation (one history step). */
  private applyStage1Paragraph(props: Record<string, string | number>): boolean {
    const range = this.stage1ParaRange();
    if (!range || !this.stage1Paragraph()) return false;
    const text = JSON.stringify(props);
    this.history?.boundary();
    const applied = this.mutate(() => {
      for (let p = range.first; p <= range.last; p++) this.applyPara(range.at, p, text);
      return { caret: this.caret, anchor: this.anchor };
    }, true, "other", null, true, true);
    this.history?.boundary();
    return applied;
  }

  private executeStage1Paragraph(command: DocumentCommandId, args?: DocumentCommandArgs): boolean | null {
    if (command in ALIGN_COMMANDS) {
      if (args !== undefined) return false;
      return this.applyStage1Paragraph({ alignment: ALIGN_COMMANDS[command as AlignCommandId] });
    }
    if (command !== "paragraph.settings") return null;
    if (args?.command !== command || !validateCommandArgs(command, args, this.parameterState().parameters?.[command])) return false;
    const f = args.format, props: Record<string, string | number> = {};
    // HWP units (as the engine's layout reads them): margins, indent and fixed/minimum line spacing are stored doubled
    // (2 × 100 HWPUNIT per pt); spacing before/after 1×; percent line spacing in percent.
    const hwp2 = (pt: number) => Math.round(pt * 200), hwp1 = (pt: number) => Math.round(pt * 100);
    if (f.lineSpacing) {
      props.lineSpacingType = f.lineSpacing.rule === "multiple" ? "Percent" : f.lineSpacing.rule === "exactly" ? "Fixed" : "Minimum";
      props.lineSpacing = f.lineSpacing.rule === "multiple" ? Math.round(f.lineSpacing.value * 100) : hwp2(f.lineSpacing.value);
    }
    if (f.spaceBefore !== undefined) props.spacingBefore = hwp1(f.spaceBefore);
    if (f.spaceAfter !== undefined) props.spacingAfter = hwp1(f.spaceAfter);
    if (f.indentLeft !== undefined) props.marginLeft = hwp2(f.indentLeft);
    if (f.indentRight !== undefined) props.marginRight = hwp2(f.indentRight);
    if (f.indentFirst !== undefined) props.indent = hwp2(f.indentFirst);
    return this.applyStage1Paragraph(props);
  }

  // ---- Stage 1 page setup (margins, orientation, paper size of the caret's section) ----

  private pageCache: { key: string; value: PageState | null } | null = null;
  /** Same structural eligibility as paragraph edits; one section (the selection must not span sections). */
  private stage1Page(): PageState | null {
    const doc = this.doc;
    if (!doc?.getPageDef || !doc.setPageDef || !this.structuralFormat() || !this.editable || this.imeUnsettled || this.uncertain
      || this.pending > 0 || this.committingEpoch === this.epoch || this.saving || this.caret.section !== this.anchor.section) return null;
    const key = `${this.epoch}|${this.modelVersion}|${this.caret.section}`;
    if (this.pageCache?.key === key) return this.pageCache.value;
    let value: PageState | null;
    try {
      const raw = JSON.parse(doc.getPageDef(this.caret.section)) as Record<string, unknown>;
      const n = (k: string) => { const v = raw[k]; if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error("page def"); return (v as number) / 100; };
      const width = n("width"), height = n("height"), landscape = raw.landscape === true;
      const paper = (Object.entries(HWP_PAPER) as [PaperName, [number, number]][]).find(([, [w, h]]) =>
        Math.abs(Math.min(width, height) - w) < 1 && Math.abs(Math.max(width, height) - h) < 1)?.[0] ?? null;
      const columns = this.columnState(this.caret.section);
      value = { width: landscape ? Math.max(width, height) : width, height: landscape ? Math.min(width, height) : height, landscape,
        marginTop: n("marginTop"), marginBottom: n("marginBottom"), marginLeft: n("marginLeft"), marginRight: n("marginRight"),
        columns: columns?.count ?? 1, columnSpace: columns?.spacing ?? 0, paper };
    } catch { value = null; }
    this.pageCache = { key, value };
    return value;
  }

  /** The section's existing column definition (control `cold` in the section's paragraphs), or null when the section
   * has none: the engine would then add a control without its text slot, so columns are not offered there. */
  private columnState(section: number): { count: number; type: number; spacing: number } | null {
    const doc = this.doc;
    if (!doc?.getColumnDef || !doc.setColumnDef || !doc.getControls) return null;
    try {
      // `getControls` numbers body paragraphs across sections: locate this section's range.
      let base = 0;
      for (let s = 0; s < section; s++) base += doc.getParagraphCount(s);
      const end = base + doc.getParagraphCount(section);
      const controls = JSON.parse(doc.getControls()) as { ctrlId: string; list: number; para: number }[];
      if (!controls.some(c => c.ctrlId === "cold" && c.list === 0 && c.para >= base && c.para < end)) return null;
      const raw = JSON.parse(doc.getColumnDef(section)) as Record<string, unknown>;
      const { columnCount, columnType, spacing } = raw;
      if (!Number.isSafeInteger(columnCount) || !Number.isSafeInteger(columnType) || !Number.isSafeInteger(spacing)) return null;
      return { count: Math.max(1, columnCount as number), type: columnType as number, spacing: (spacing as number) / 100 };
    } catch { return null; }
  }

  private executeStage1Page(command: DocumentCommandId, args?: DocumentCommandArgs): boolean | null {
    if (command === "layout.columns") {
      const page = this.stage1Page(), doc = this.doc, section = this.caret.section;
      const current = this.columnState(section);
      if (!page || !doc || !current || !args || args.command !== command || !validateCommandArgs(command, args, this.parameterState().parameters?.[command])) return false;
      // Same-width columns of the existing definition kind; the spacing is bounded by the text width.
      const spacing = Math.round(args.space * 100);
      if (args.count > 1 && (args.count - 1) * args.space >= page.width - page.marginLeft - page.marginRight - 36) return false;
      this.history?.boundary();
      const applied = this.mutate(() => {
        const result = doc.setColumnDef!(section, args.count, current.type, 1, spacing);
        if (!/"ok"\s*:\s*true/.test(result)) throw new Error("column definition rejected");
        return { caret: this.caret, anchor: this.anchor };
      }, true, "other", null, true, true);
      this.history?.boundary();
      return applied;
    }
    if (command !== "layout.margins" && command !== "layout.orientation" && command !== "layout.size") return null;
    const page = this.stage1Page(), doc = this.doc;
    if (!page || !doc || !args || args.command !== command || !validateCommandArgs(command, args, this.parameterState().parameters?.[command])) return false;
    const unit = (pt: number) => Math.round(pt * 100);
    let props: Record<string, number | boolean>;
    if (args.command === "layout.margins") {
      // The text area must keep at least half an inch (the same rule as the DOCX engine).
      if (args.left + args.right > page.width - 36 || args.top + args.bottom > page.height - 36) return false;
      props = { marginTop: unit(args.top), marginBottom: unit(args.bottom), marginLeft: unit(args.left), marginRight: unit(args.right) };
    } else if (args.command === "layout.orientation") {
      if (args.landscape === page.landscape) return true;
      props = { landscape: args.landscape };
    } else if (args.command === "layout.size") {
      // HWP stores the paper's portrait dimensions; orientation is the landscape flag.
      const [w, h] = HWP_PAPER[args.name];
      props = { width: unit(w), height: unit(h) };
    } else return false;
    const section = this.caret.section, text = JSON.stringify(props);
    this.history?.boundary();
    const applied = this.mutate(() => {
      const result = doc.setPageDef!(section, text);
      if (result && /"ok"\s*:\s*false/.test(result)) throw new Error("page setup rejected");
      return { caret: this.caret, anchor: this.anchor };
    }, true, "other", null, true, true);
    this.history?.boundary();
    return applied;
  }

  // ---- Stage 1 find/replace ----

  private searchQuery: SearchOptions | null = null;
  private searchCache: { key: string; value: { matches: { from: DocPosition; to: DocPosition }[]; complete: boolean } | null } | null = null;

  /**
   * Current matches of the open query, from the engine's own model search (`searchAllText`). Only body paragraphs and
   * first-level table cells are used (equations, text boxes and nested cells are not addressable here); every hit is
   * re-read from the model, must be deletable plain text (no objects inside) and, for whole-word searches, must not
   * touch a letter/digit on either side. Offsets are code points, so surrogate pairs are never split.
   */
  private searchMatches(query: SearchOptions): { from: DocPosition; to: DocPosition }[] | null {
    return this.searchResult(query)?.matches ?? null;
  }

  /** Every match (no navigation cap). `complete` is false only when the engine's result exceeds MAX_SEARCH_JSON; then
   * the list is empty, the count unknown and replace-all is refused before any mutation. */
  private searchResult(query: SearchOptions): { matches: { from: DocPosition; to: DocPosition }[]; complete: boolean } | null {
    const doc = this.doc, text = this.text;
    if (!doc?.searchAllText || !text || !doc.getControls) return null;
    const key = `${this.epoch}|${this.modelVersion}|${JSON.stringify(query)}`;
    if (this.searchCache?.key === key) return this.searchCache.value;
    let value: { matches: { from: DocPosition; to: DocPosition }[]; complete: boolean } | null = null;
    try {
      const raw = doc.searchAllText(query.text, query.matchCase, true);
      const controlsRaw = doc.getControls();
      if (raw.length > MAX_SEARCH_JSON) value = { matches: [], complete: false };
      else if (controlsRaw.length <= 2 * 1024 * 1024) {
        const hits = JSON.parse(raw) as unknown, controls = JSON.parse(controlsRaw) as { ctrlId: string; para: number; controlIndex: number; list: number }[];
        const tables = new Set(controls.filter(c => c.ctrlId === "tbl" && c.list === 0).map(c => `${c.para}:${c.controlIndex}`));
        const word = /[\p{L}\p{N}_]/u;
        const fold = (v: string) => query.matchCase ? v : v.toLowerCase();
        const list: { from: DocPosition; to: DocPosition }[] = [];
        value = { matches: list, complete: true };
        for (const hit of Array.isArray(hits) ? hits as Record<string, unknown>[] : []) {
          const { sec, para, charOffset, length, cellContext } = hit as { sec: number; para: number; charOffset: number; length: number;
            cellContext?: { parentPara: number; ctrlIdx: number; cellIdx: number; cellPara: number } };
          if ("cellPath" in hit || "equationControl" in hit || ![sec, para, charOffset, length].every(n => Number.isSafeInteger(n) && n >= 0) || length === 0) continue;
          if (cellContext && !tables.has(`${cellContext.parentPara}:${cellContext.ctrlIdx}`)) continue;
          const from: DocPosition = cellContext
            ? { section: sec, paragraph: cellContext.parentPara, offset: charOffset,
              cell: { parentParagraph: cellContext.parentPara, control: cellContext.ctrlIdx, cell: cellContext.cellIdx, cellParagraph: cellContext.cellPara } }
            : { section: sec, paragraph: para, offset: charOffset };
          const to = { ...from, offset: charOffset + length };
          if (!this.ownsPosition(from) || !text.canDeleteRange(from, to)) continue;
          const found = text.text(from, length);
          // Re-read from the model: the hit must still be exactly the query text (case folded when requested).
          if (Array.from(found).length !== length || fold(found) !== fold(query.text)) continue;
          if (query.wholeWord) {
            const before = charOffset > 0 ? text.text({ ...from, offset: charOffset - 1 }, 1) : "";
            const end = text.paragraphLength(from);
            const after = charOffset + length < end ? text.text(to, 1) : "";
            if (word.test(before) || word.test(after)) continue;
          }
          list.push({ from, to });
        }
      }
    } catch { value = null; }
    this.searchCache = { key, value };
    return value;
  }

  private searchState(): NonNullable<DocumentCommandSnapshot["search"]> | null {
    const query = this.searchQuery;
    if (!query) return null;
    const result = this.searchResult(query);
    if (!result) return null;
    const matches = result.matches;
    const [a, b] = this.ordered();
    const current = this.hasSelection ? matches.findIndex(m => sameContext(m.from, a) && compare(m.from, a) === 0 && compare(m.to, b) === 0) : -1;
    return { ...query, count: matches.length, current: current < 0 ? null : current, complete: result.complete, replaceAllLimit: MAX_RHWP_REPLACE_ALL };
  }

  /**
   * Replace one match so that the replacement takes the format of the match's first character (defined behaviour for
   * mixed-format matches): insert after that character — engine insertion inherits the character before the caret —
   * then delete the original characters around it.
   */
  private replaceMatch(match: { from: DocPosition; to: DocPosition }, replacement: string): void {
    const length = match.to.offset - match.from.offset;
    if (!replacement) { this.text!.delete(match.from, length); return; }
    const after = { ...match.from, offset: match.from.offset + 1 };
    this.text!.insert(after, replacement);
    this.text!.delete(match.from, 1);
    if (length > 1) this.text!.delete({ ...match.from, offset: match.from.offset + charCount(replacement) }, length - 1);
  }

  search(request: SearchRequest): boolean {
    if (!validSearchRequest(request) || this.status.kind !== "ready" || this.imeUnsettled) return false;
    if (request.kind === "clear") { this.searchQuery = null; this.emit(); return true; }
    if (request.kind !== "find" && (!documentCommandState("edit.replace", this.snapshot()).available || this.pending > 0
      || this.committingEpoch === this.epoch || this.saving || this.uncertain)) return false;
    this.searchQuery = { ...request.query };
    const matches = this.searchMatches(request.query);
    if (!matches) return false;
    const [a, b] = this.ordered();
    if (request.kind === "find") {
      if (matches.length > 0) {
        // Document order across body and cell contexts (`compare` is context-local).
        const order = (p: DocPosition) => [p.section, p.cell ? p.cell.parentParagraph : p.paragraph, p.cell ? 1 : 0,
          p.cell?.control ?? 0, p.cell?.cell ?? 0, p.cell?.cellParagraph ?? 0, p.offset];
        const before = (x: DocPosition, y: DocPosition) => {
          const [ox, oy] = [order(x), order(y)];
          for (let i = 0; i < ox.length; i++) if (ox[i] !== oy[i]) return ox[i]! < oy[i]!;
          return false;
        };
        const current = matches.findIndex(m => compare(m.from, a) === 0 && compare(m.to, b) === 0 && sameContext(m.from, a));
        let at: number;
        if (current >= 0) at = (current + (request.backward ? matches.length - 1 : 1)) % matches.length;
        else if (request.backward) { at = matches.length - 1; for (let i = matches.length - 1; i >= 0; i--) if (!before(a, matches[i]!.to)) { at = i; break; } }
        else at = Math.max(0, matches.findIndex(m => !before(m.from, b)));
        this.anchor = matches[at]!.from; this.caret = matches[at]!.to; this.preferredX = -1; this.reconcilePending();
      }
      this.emit();
      return true;
    }
    const replacement = request.with;
    if (request.kind === "replace") {
      // Stale results never edit: the selection must still be exactly a current match of this query.
      const selected = this.hasSelection ? matches.find(m => sameContext(m.from, a) && compare(m.from, a) === 0 && compare(m.to, b) === 0) : undefined;
      if (!selected) return false;
      this.history?.boundary();
      const applied = this.mutate(() => {
        this.replaceMatch(selected, replacement);
        const end = { ...selected.from, offset: selected.from.offset + Array.from(replacement).length };
        return { caret: end, anchor: end };
      }, true, "other", null, true, true); // engine failure: history rollback, nothing published
      this.history?.boundary();
      if (applied) this.search({ kind: "find", query: request.query, backward: false });
      return applied;
    }
    // Replace all is all-or-nothing: an incomplete enumeration is refused before any mutation.
    if (matches.length === 0 || matches.length > MAX_RHWP_REPLACE_ALL || !this.searchResult(request.query)?.complete) return false;
    // Replace all: one model change and one history step, last match first so earlier positions stay valid.
    const caret = matches[0]!.from;
    this.history?.boundary();
    const applied = this.mutate(() => {
      for (const match of [...matches].reverse()) {
        this.replaceMatch(match, replacement);
      }
      return { caret, anchor: caret };
    }, true, "other", null, true, true); // any failure rolls the whole replace-all back
    this.history?.boundary();
    return applied;
  }

  // ---- Stage 1 character formatting (size, color, highlight/shade, superscript/subscript) ----

  /**
   * Stage 1 next-input formatting at a collapsed caret (session-owned, never stored in the document by itself).
   * Lifecycle (bounded: one insertion point, never a growing position collection):
   * - set: a caret-only format command records `at` = the caret (owned by this epoch/load generation).
   * - follow: text inserted at `at` (typing, paste, IME update/commit, late IME commit) gets the values in the same
   *   mutation and history step, and `at` advances to the end of the insertion; a paragraph split at `at` (Enter,
   *   multi-line paste) moves it to the start of the new paragraph.
   * - IME: while a composition (or app-finished provisional composition) that started at `at` is open, `origin`
   *   keeps its anchor so each update (delete + reinsert at the anchor) and a cancellation keep the values.
   * - invalidate: any caret result other than `at` (caret move, selection, an unrelated or failed mutation),
   *   Undo/Redo, reload, release or document switch (epoch/generation) clears it.
   */
  private pendingChars: { epoch: number; generation: number; at: string; origin: string | null; props: Record<string, string | number | boolean> } | null = null;

  private pendingFor(at: DocPosition): Record<string, string | number | boolean> | null {
    const pending = this.pendingChars;
    if (!pending) return null;
    if (pending.epoch !== this.epoch || pending.generation !== this.generation) { this.pendingChars = null; return null; }
    const key = RhwpEditorSession.positionKey(at);
    return key === pending.at || key === pending.origin ? pending.props : null;
  }

  /** Every session text insertion goes through here (pending next-input values follow the inserted text). */
  private insertText(at: DocPosition, text: string): void {
    this.text!.insert(at, text);
    const props = this.pendingFor(at);
    if (!props || !text) return;
    const length = charCount(text);
    this.text!.formatInserted(at, length, props);
    this.pendingChars!.at = RhwpEditorSession.positionKey({ ...at, offset: at.offset + length });
  }

  /** Every session paragraph split goes through here (pending values move to the new paragraph's start). */
  private splitText(at: DocPosition): DocPosition {
    this.text!.split(at);
    const next = withParagraph(at, paragraphOf(at) + 1, 0);
    if (this.pendingFor(at) && this.pendingChars!.at === RhwpEditorSession.positionKey(at)) this.pendingChars!.at = RhwpEditorSession.positionKey(next);
    return next;
  }

  /** After a caret change: pending values survive only at their insertion point (or an open IME transaction's anchor). */
  private reconcilePending(): void {
    const pending = this.pendingChars;
    if (!pending) return;
    if (pending.epoch !== this.epoch || pending.generation !== this.generation || this.hasSelection) { this.pendingChars = null; return; }
    const key = RhwpEditorSession.positionKey(this.caret);
    const imeOpen = this.composition !== null || this.provisional !== null;
    if (key === pending.at) return;
    if (pending.origin !== null && key === pending.origin) { pending.at = key; return; } // IME update to "" / cancellation
    if (!imeOpen) this.pendingChars = null;
  }

  /** The IME transaction that started at the pending point ended: only the advanced insertion point remains. */
  private closePendingOrigin(): void {
    if (!this.pendingChars || this.composition !== null || this.provisional !== null) return;
    this.pendingChars.origin = null;
    this.reconcilePending();
  }

  /** Test/diagnostic view of the pending next-input state (null when inert). */
  get pendingCharState(): { at: string; props: Record<string, string | number | boolean> } | null {
    const p = this.pendingChars;
    return p && p.epoch === this.epoch && p.generation === this.generation ? { at: p.at, props: { ...p.props } } : null;
  }

  /** Same eligibility as selected-text formatting, at a collapsed, owned caret. */
  private caretFormatEligible(): boolean {
    if (this.hasSelection || !this.text || !this.doc || !this.editable || !this.history || this.imeUnsettled || this.uncertain) return false;
    if (this.pending > 0 || this.committingEpoch === this.epoch || this.saving) return false;
    const format = this.sessions.get(this.sessionId)?.format;
    if ((format !== "hwp" && format !== "hwpx") || this.sessions.snapshot().activeId !== this.sessionId) return false;
    if (format === "hwp" && (!this.structuralFormat() || this.formatSourceCache?.key !== String(this.epoch) || !this.formatSourceCache.safe)) return false;
    if (!this.text.hasCharShapeOwnership || !this.doc.compactAppendedCharShapes) return false;
    const c = this.caret.cell;
    return (c?.nested ? !!this.doc.applyCharFormatInCellByPath : c ? !!this.doc.applyCharFormatInCell : !!this.doc.applyCharFormat)
      && this.ownsPosition(this.caret) && this.text.canInsertText(this.caret);
  }

  private caretCharCache: { key: string; value: ReturnType<RhwpText["stage1Chars"]> } | null = null;
  private caretChars(): ReturnType<RhwpText["stage1Chars"]> {
    if (!this.caretFormatEligible()) return null;
    const key = `${this.epoch}|${this.modelVersion}|${RhwpEditorSession.positionKey(this.caret)}|${JSON.stringify(this.pendingFor(this.caret))}`;
    if (this.caretCharCache?.key !== key) this.caretCharCache = { key, value: this.readCaretChars() };
    return this.caretCharCache.value;
  }

  private readCaretChars(): ReturnType<RhwpText["stage1Chars"]> {
    const raw = this.text!.caretChars(this.caret);
    if (!raw) return null;
    const pending = this.pendingFor(this.caret) ?? {};
    const value = { ...raw, ...pending };
    const hex = (v: unknown) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v.slice(1).toUpperCase() : null;
    const shade = value.shadeColor === "none" ? null : hex(value.shadeColor);
    return {
      size: Number.isSafeInteger(value.fontSize) && (value.fontSize as number) > 0 ? (value.fontSize as number) / 100 : null,
      color: hex(value.textColor), highlight: shade,
      superscript: value.superscript === true, subscript: value.subscript === true,
    };
  }

  /** Record a next-input value at the caret (no document change, no revision). */
  private setPendingChars(props: Record<string, string | number | boolean>): boolean {
    if (!this.caretFormatEligible() || !RhwpText.validChars(props)) return false;
    const key = RhwpEditorSession.positionKey(this.caret);
    const current = this.pendingFor(this.caret);
    const merged = { ...(current ?? {}), ...props };
    // Superscript and subscript are exclusive, as in the engine.
    if (props.superscript === true) merged.subscript = false;
    if (props.subscript === true) merged.superscript = false;
    this.pendingChars = { epoch: this.epoch, generation: this.generation, at: key, origin: null, props: merged };
    this.stage1CharCache = null;
    this.emit();
    return true;
  }

  private stage1CharCache: { key: string; value: ReturnType<RhwpText["stage1Chars"]> } | null = null;
  /** Same eligibility as the general selected-text formatting (selection, IME/history/pending/saving, HWP original proof). */
  private stage1Chars(): ReturnType<RhwpText["stage1Chars"]> {
    if (!this.hasSelection) return this.caretChars();
    if (!this.formatState() || !this.text) return null;
    const [from, to] = this.ordered();
    const key = `${this.epoch}|${this.modelVersion}|${RhwpEditorSession.positionKey(from)}|${RhwpEditorSession.positionKey(to)}`;
    if (this.stage1CharCache?.key !== key) this.stage1CharCache = { key, value: this.text.stage1Chars(from, to) };
    return this.stage1CharCache.value;
  }

  private stage1Actions(): NonNullable<DocumentCommandSnapshot["actions"]> {
    const chars = this.stage1Chars();
    return chars ? { "format.superscript": { pressed: chars.superscript === true }, "format.subscript": { pressed: chars.subscript === true } } : {};
  }

  private applyStage1Chars(props: Parameters<RhwpText["prepareChars"]>[2]): boolean {
    if (!this.hasSelection) return this.setPendingChars(props as Record<string, string | number | boolean>);
    if (!this.stage1Chars()) return false;
    const [from, to] = this.ordered();
    const apply = this.text!.prepareChars(from, to, props);
    if (!apply) return false;
    const caret = this.caret, anchor = this.anchor;
    this.history?.boundary();
    const applied = this.mutate(() => { apply(); return { caret, anchor }; }, true, "other", null, true);
    this.history?.boundary();
    return applied;
  }

  private executeStage1Chars(command: DocumentCommandId, args?: DocumentCommandArgs): boolean | null {
    const chars = this.stage1Chars();
    if (command === "format.superscript" || command === "format.subscript") {
      if (args !== undefined || !chars) return false;
      return command === "format.superscript" ? this.applyStage1Chars({ superscript: !chars.superscript })
        : this.applyStage1Chars({ subscript: !chars.subscript });
    }
    if (command !== "format.fontSize" && command !== "format.fontColor" && command !== "format.highlight") return null;
    if (!args || args.command !== command || !validateCommandArgs(command, args, this.parameterState().parameters?.[command])) return false;
    if (args.command === "format.fontSize") return this.applyStage1Chars({ fontSize: Math.round(args.size * 100) });
    // HWP has no "automatic" text color: automatic is stored as black (the document default).
    if (args.command === "format.fontColor") return this.applyStage1Chars({ textColor: `#${args.color === "auto" ? "000000" : args.color}` });
    if (args.command === "format.highlight") {
      const rgb = HIGHLIGHT_COLORS[args.color];
      // No highlight is the format's own "no shading" value (engine `shadeColor: "none"`, stage1-editing patch),
      // distinct from a white shade.
      return this.applyStage1Chars({ shadeColor: rgb === null ? "none" : `#${rgb}` });
    }
    return false;
  }

  /** Every model change bumps modelVersion (the caret and parameter caches rely on the same rule); the key
   * also covers load generation, committed revision, selection/clipboard and IME epochs and both ends of the
   * selection. One full extraction proves availability per key; only that boolean is retained. Copy/Cut
   * still extract and validate the complete text afresh when they execute. */
  private clipboardProbe: { key: string; text: RhwpText; supported: boolean; writable: boolean } | null = null;
  private structuredSelectionTarget(): { target: TableTarget; range: CellRange; format: "hwp" | "hwpx" } | null {
    const format = this.sessions.get(this.sessionId)?.format;
    if ((format !== "hwp" && format !== "hwpx") || !this.doc || !this.text || this.uncertain
      || !this.hasSelection || sameContext(this.anchor, this.caret)) return null;
    if (!sameTable(this.anchor, this.caret) || !this.ownsPosition(this.anchor) || !this.ownsPosition(this.caret)) return null;
    const table = this.caretTable(), range = this.selectedCellRange();
    if (!table || typeof table.grid === "string" || !range) return null;
    return { target: table.target, range, format };
  }

  private readStructuredCells(): { mime: string; data: string; plainText: string } | null {
    const sel = this.structuredSelectionTarget();
    if (!sel || !this.doc?.extractTableCellsByPath) return null;
    try {
      const raw = this.doc.extractTableCellsByPath(
        sel.target.section, sel.target.paragraph, tableTargetPathJson(sel.target),
        sel.range.startRow, sel.range.startCol, sel.range.endRow, sel.range.endCol,
      );
      const extracted = JSON.parse(raw) as { rows?: number; cols?: number; cells?: unknown[] };
      if (!Number.isSafeInteger(extracted.rows) || !Number.isSafeInteger(extracted.cols) || !Array.isArray(extracted.cells)) {
        return null;
      }
      const plainText = buildTableClipboardPlainText(extracted.rows!, extracted.cols!, extracted.cells as never);
      const payload = parseTableClipboardPayload({
        kind: "geul.tableCells",
        version: 1,
        sourceFormat: sel.format,
        rows: extracted.rows,
        cols: extracted.cols,
        cells: extracted.cells,
        plainText,
      });
      if (!payload) return null;
      return { mime: TABLE_CLIPBOARD_MIME, data: JSON.stringify(payload), plainText: payload.plainText };
    } catch {
      return null;
    }
  }

  private removeStructuredCells(): boolean {
    const sel = this.structuredSelectionTarget();
    const doc = this.doc;
    if (!sel || !doc?.clearTableCellsByPath || !this.editable || !this.history || this.imeUnsettled
      || this.uncertain || this.pending > 0 || this.committingEpoch === this.epoch || this.saving) return false;
    if (sel.format === "hwp" && !this.structuralFormat()) return false;
    const path = tableTargetPathJson(sel.target);
    this.history.boundary();
    const applied = this.mutate(() => {
      const res = JSON.parse(doc.clearTableCellsByPath!(
        sel.target.section, sel.target.paragraph, path,
        sel.range.startRow, sel.range.startCol, sel.range.endRow, sel.range.endCol,
      )) as { ok?: boolean };
      if (res.ok !== true) throw new Error("clearTableCellsByPath failed");
      this.text?.compactAfterCellMutation();
      const nextGrid = readTableGrid(doc, sel.target);
      const anchorIndex = typeof nextGrid === "string" ? 0 : cellCovering(nextGrid, sel.range.startRow, sel.range.startCol);
      const pos = this.caret.cell ? withCell(this.caret, anchorIndex) : this.caret;
      return { caret: pos, anchor: pos };
    }, true, "other", null, true, true);
    this.history.boundary();
    return applied;
  }

  private insertStructuredCells(mime: string, data: string): "ok" | "notTable" | "rejected" {
    if (mime !== TABLE_CLIPBOARD_MIME) return "rejected";
    const payload = parseTableClipboardPayload(data);
    const doc = this.doc;
    const format = this.sessions.get(this.sessionId)?.format;
    if (!payload || !doc || !this.text || !this.editable || !this.history
      || this.imeUnsettled || this.uncertain || this.pending > 0 || this.committingEpoch === this.epoch || this.saving) {
      return "rejected";
    }
    if (format !== "hwp" && format !== "hwpx") return "rejected";
    if (!this.caret.cell) return "notTable";
    if (!doc.applyTableCellsByPath) return "rejected";
    if (format === "hwp" && !this.structuralFormat()) return "rejected";
    if (!this.ownsPosition(this.caret)) return "rejected";

    let startRow: number;
    let startCol: number;
    const table = this.caretTable();
    if (!table || typeof table.grid === "string") return "rejected";

    if (this.hasSelection && !sameContext(this.anchor, this.caret)) {
      if (!sameTable(this.anchor, this.caret) || !this.ownsPosition(this.anchor)) return "rejected";
      const range = this.selectedCellRange();
      if (!range) return "rejected";
      startRow = range.startRow;
      startCol = range.startCol;
    } else {
      const cell = table.grid.cells[innermost(this.caret.cell).cell];
      if (!cell) return "rejected";
      startRow = cell.row;
      startCol = cell.col;
    }

    const endRow = startRow + payload.rows - 1;
    const endCol = startCol + payload.cols - 1;
    if (endRow >= table.grid.rows || endCol >= table.grid.cols) return "rejected";

    // Pre-validate merge boundary & HWP grid compatibility before opening a transaction.
    const intersecting = table.grid.cells.filter(c =>
      c.row + c.rowSpan - 1 >= startRow && c.row <= endRow
      && c.col + c.colSpan - 1 >= startCol && c.col <= endCol,
    );
    if (intersecting.some(c =>
      c.row < startRow || c.col < startCol || c.row + c.rowSpan - 1 > endRow || c.col + c.colSpan - 1 > endCol,
    )) {
      return "rejected";
    }
    const allowMergeRewrite = format === "hwpx";
    if (!allowMergeRewrite) {
      if (intersecting.length !== payload.cells.length) return "rejected";
      const expected = new Map(payload.cells.map(c => [`${c.row},${c.col}`, `${c.rowSpan},${c.colSpan}`]));
      if (intersecting.some(c => expected.get(`${c.row - startRow},${c.col - startCol}`) !== `${c.rowSpan},${c.colSpan}`)) {
        return "rejected";
      }
    }

    // Run fonts: the engine applies only faces that already exist (and refuses any
    // other family atomically). A missing face is registered first through the same
    // owned font path as format.font, inside this paste's history step; without that
    // ownership the paste is refused instead of silently dropping the family.
    const families = [...new Set(payload.cells.flatMap(c => c.paragraphs.flatMap(p =>
      p.runs.flatMap(r => r.fontFamily === undefined ? [] : [r.fontFamily]))))];
    const fontTable = families.length ? documentFontTable(doc) : null;
    if (families.length && (!fontTable || families.some(f => fontFamilyProblem(f) !== null))) return "rejected";
    const missingFonts = fontTable ? families.filter(f => !resolveExistingFontIds(fontTable, f)) : [];
    if (missingFonts.length && !this.fontCreationOwned()) return "rejected";

    const path = tableTargetPathJson(table.target);
    const applySpec = JSON.stringify({
      startRow,
      startCol,
      rows: payload.rows,
      cols: payload.cols,
      allowMergeRewrite,
      cells: payload.cells,
    });
    this.history.boundary();
    const applied = this.mutate(() => {
      for (const family of missingFonts) {
        const raw = JSON.parse(doc.resolveDocumentFontFamily!(family)) as unknown;
        const current = documentFontTable(doc), ids = current && resolveExistingFontIds(current, family);
        if (!ids || !Array.isArray(raw) || raw.length !== 7 || raw.some((id, lang) => id !== ids[lang]))
          throw new Error("document font resolution refused");
      }
      const res = JSON.parse(doc.applyTableCellsByPath!(table.target.section, table.target.paragraph, path, applySpec)) as { ok?: boolean };
      if (res.ok !== true) throw new Error("applyTableCellsByPath failed");
      if (this.borderFillBaseline !== null && typeof doc.compactAppendedBorderFills === "function") {
        const comp = JSON.parse(doc.compactAppendedBorderFills(this.borderFillBaseline)) as { ok?: boolean };
        if (comp.ok !== true) throw new Error("borderFill compaction failed");
      }
      this.text?.compactAfterCellMutation();
      const nextGrid = readTableGrid(doc, table.target);
      const anchorIndex = typeof nextGrid === "string" ? 0 : cellCovering(nextGrid, startRow, startCol);
      const pos = withCell(this.caret, anchorIndex);
      return { caret: pos, anchor: pos };
    }, true, "other", null, true, true);
    this.history.boundary();
    return applied ? "ok" : "rejected";
  }

  private readStructuredObject(): { mime: string; data: string; plainText: string } | null {
    const selected = this.selectedObject;
    const copyControl = selected?.copyControl;
    const doc = this.doc;
    const format = this.sessions.get(this.sessionId)?.format;
    if (!selected || !copyControl || (format !== "hwpx" && format !== "hwp") || this.uncertain
      || !doc?.copyControl || !doc.clipboardHasControl) return null;
    try {
      const [section, para, control] = copyControl.address;
      const res = JSON.parse(doc.copyControl(section, para, "[]", control)) as { ok?: boolean };
      if (res.ok !== true || !doc.clipboardHasControl()) return null;
      const portable = format === "hwpx"
        ? extractHwpxPortableObject(doc, copyControl.address, copyControl.kind)
        : undefined;
      const payload = format === "hwp"
        ? createHwpObjectClipboardPayload(copyControl.kind, this.sessionId, this.generation)
        : createHwpxObjectClipboardPayload(copyControl.kind, this.sessionId, this.generation, portable);
      if (!payload) return null;
      this.lastCopiedObjectToken = payload.token;
      return {
        mime: OBJECT_CLIPBOARD_MIME,
        data: JSON.stringify(payload),
        plainText: objectClipboardPlainText(payload),
      };
    } catch {
      return null;
    }
  }

  private removeStructuredObject(): boolean {
    const selected = this.selectedObject;
    const format = this.sessions.get(this.sessionId)?.format;
    if (!selected?.copyControl || !selected.selection.operations.includes("cut")
      || (format !== "hwpx" && format !== "hwp")) return false;
    return this.editObject(objectEditRequest(selected.selection, { kind: "delete" }));
  }

  private insertStructuredObject(data: string): "ok" | "rejected" {
    const payload = parseObjectClipboardPayload(data);
    const doc = this.doc;
    const format = this.sessions.get(this.sessionId)?.format;
    if (!payload || payload.version !== 3 || (payload.sourceFormat !== "hwpx" && payload.sourceFormat !== "hwp")
      || payload.sourceFormat !== format) return "rejected";
    if (!doc || !this.history || !this.editable || this.imeUnsettled || this.uncertain
      || this.objectSelection || this.hasSelection || this.caret.cell
      || this.pending > 0 || this.committingEpoch === this.epoch || this.saving) return "rejected";
    const at = this.caret;
    if (at.paragraph >= doc.getParagraphCount(at.section)) return "rejected";

    const sameDoc = payload.sourceSessionId === this.sessionId && payload.sourceGeneration === this.generation
      && payload.token === this.lastCopiedObjectToken && !!doc.pasteControl && !!doc.clipboardHasControl?.();
    const portable = !sameDoc && format === "hwpx" ? payload.portable : undefined;

    // HWP5 and non-portable HWPX snapshots (e.g. groups, curves, gradients, or unsafe captions/stories)
    // remain same-document only.
    if (!sameDoc && !portable) return "rejected";
    this.history.boundary();
    const applied = this.mutate(() => {
      const res = sameDoc
        ? JSON.parse(doc.pasteControl!(at.section, at.paragraph, at.offset)) as { ok?: boolean; paraIdx?: unknown; controlIdx?: unknown }
        : insertHwpxPortableObject(doc, at, portable!);
      if ((res as { ok?: boolean }).ok === false || !Number.isSafeInteger(res.paraIdx) || !Number.isSafeInteger(res.controlIdx)) {
        throw new Error("paste object failed");
      }
      const maxPara = Math.max(0, doc.getParagraphCount(at.section) - 1);
      const targetPara = Math.min(res.paraIdx as number, maxPara);
      const targetOffset = Math.min(at.offset, doc.getParagraphLength(at.section, targetPara));
      const nextPos = { section: at.section, paragraph: targetPara, offset: targetOffset };
      return { caret: nextPos, anchor: nextPos };
    }, true, "other", null, true, true);
    this.history.boundary();
    return applied ? "ok" : "rejected";
  }

  private clipboardState(): NonNullable<DocumentCommandSnapshot["clipboard"]> {
    const key = JSON.stringify([this.epoch, this.generation, this.committed, this.modelVersion, this.clipboardVersion,
      this.imeSerial, this.anchor, this.caret, this.structuralKey(), this.selectedObject?.selection.epoch ?? null]);
    if (this.objectSelection) {
      const copyControl = this.selectedObject?.copyControl;
      const format = this.sessions.get(this.sessionId)?.format;
      if (copyControl && !this.uncertain && (format === "hwpx" || format === "hwp")) {
        const cutAllowed = this.editable && this.objectSelection.operations.includes("cut");
        return { key, selection: true, writable: cutAllowed, shape: { cutAllowed } };
      }
      return { key, selection: false, writable: false };
    }
    const text = this.text;
    let supported = false;
    let writable = !this.uncertain && !this.hasSelection;
    if (text && !this.uncertain) {
      const cached = this.clipboardProbe;
      if (cached && cached.key === key && cached.text === text) {
        supported = cached.supported;
        writable = cached.writable;
      } else if (sameContext(this.anchor, this.caret)) {
        supported = !!text.selectedText(this.anchor, this.caret);
        writable = !this.hasSelection || supported;
        this.clipboardProbe = { key, text, supported, writable };
      } else {
        const sel = this.structuredSelectionTarget();
        const structured = sel ? this.readStructuredCells() : null;
        supported = structured !== null;
        writable = supported && !!this.doc?.clearTableCellsByPath && !!this.history
          && (sel!.format !== "hwp" || this.structuralFormat());
        this.clipboardProbe = { key, text, supported, writable };
      }
    }
    return { selection: supported, writable, key };
  }

  executeClipboard(command: ClipboardCommand, owns: () => boolean, clipboard?: PlainClipboard): Promise<boolean> {
    return runClipboard(this, command, {
      read: async () => this.text?.selectedText(this.anchor, this.caret) ?? null,
      remove: () => this.hasSelection && this.canDeleteSelection() && this.mutate(() => this.deleteSelectionRaw()),
      insert: text => this.typeText(text),
      readStructured: async () => {
        if (this.objectSelection) {
          const object = this.readStructuredObject();
          return object ? { status: "ok", ...object } : { status: "rejected" };
        }
        if (!this.hasSelection || sameContext(this.anchor, this.caret)) return { status: "none" };
        const structured = this.readStructuredCells();
        return structured ? { status: "ok", ...structured } : { status: "rejected" };
      },
      removeStructured: () => this.objectSelection ? this.removeStructuredObject() : this.removeStructuredCells(),
      insertStructured: async (mime, data) => mime === OBJECT_CLIPBOARD_MIME
        ? this.insertStructuredObject(data)
        : this.insertStructuredCells(mime, data),
    }, () => owns() && this.sessions.snapshot().activeId === this.sessionId && !this.uncertain, clipboard);
  }

  /**
   * Why the source format does not (yet) admit the structural core features (table, inline picture,
   * bullets), or null when it does. HWPX: always admitted (its own preservation rules). HWP: only the
   * restricted T009 subset can be published, so additionally require
   * (a) every getter the detailed HWP reopen comparison needs,
   * (b) a load-time reopen-model baseline of this document whose evidence was complete — a baseline that
   *     exists but is incomplete (nested/unknown controls, unverifiable tables, unresolved bullets) can
   *     never vouch for a structural change,
   * (c) the selection/caret in section 0 (the verified BodyText/Section0 insertion proof), and
   * (d) a SAFE original-document preflight owned by this epoch, load generation and original identity.
   * Unchecked/checking → "originalChecking"; unsafe/unknown/platform/transport failure → "originalUnverified".
   * SAFE proves only that the original passed preflight: the edited output is still validated by T009 at Save.
   */
  private structuralBlock(): "engineUnsupported" | "originalChecking" | "originalUnverified" | null {
    const format = this.sessions.get(this.sessionId)?.format;
    if (format === "hwpx") return null;
    if (format !== "hwp" || !this.hwpStructuralStatic()) return "engineUnsupported";
    if (this.caret.section !== 0 || this.anchor.section !== 0) return "engineUnsupported";
    const check = this.saveCheck?.generation === this.generation ? this.saveCheck.check : null;
    if (check && blockedBy(check)) return "originalUnverified";
    const original = this.hwpOriginal?.owner === this.originalOwner() ? this.hwpOriginal : null;
    if (!original || original.state === "checking") return "originalChecking";
    return original.state === "safe" ? null : "originalUnverified";
  }
  private structuralFormat(): boolean { return this.structuralBlock() === null; }
  /** Load-time conditions independent of the original preflight: HWP, detailed APIs, complete baseline. */
  private hwpStructuralStatic(): boolean {
    const doc = this.doc;
    return !!doc?.getSectionCount && !!doc.getParaPropertiesAt && !!doc.getBulletList && !!doc.getTableProperties
      && !!doc.getCellInfo && !!doc.getCellProperties && !!doc.getPictureProperties && !!doc.getControls
      && this.hwpBaseline?.complete === true;
  }
  private originalOwner(): string { return `${this.epoch}|${this.generation}|${this.originalSerial}`; }
  /** Cache-key part for the inputs of structuralBlock() that do not bump modelVersion. */
  private structuralKey(): string {
    const check = this.saveCheck?.generation === this.generation ? this.saveCheck.check : null;
    const original = this.hwpOriginal?.owner === this.originalOwner() ? this.hwpOriginal.state : "unchecked";
    return [this.originalOwner(), this.hwpBaseline?.complete, this.caret.section, this.anchor.section,
      check ? blockedBy(check)?.code ?? "safe" : "unchecked", original].join(",");
  }
  /**
   * Start the original-document preflight that HWP structural eligibility needs, once per owner (load or
   * publication). It reuses `preflight` with a serial no Save Check uses, so the visible save state and
   * `saveCheck` stay untouched; a stale completion (other epoch/generation/original) is ignored. There is no
   * automatic retry: a failure stays "originalUnverified" until a manual Save Check, reload or publication.
   */
  private probeHwpOriginal(): void {
    const format = this.sessions.get(this.sessionId)?.format;
    if (this.status.kind !== "ready" || (format === "hwp" ? !this.hwpStructuralStatic()
      : format !== "hwpx" || !this.text?.hasFontOwnership)) return;
    const owner = this.originalOwner();
    if (this.hwpOriginal?.owner === owner) return;
    // `serial`: Save may reuse the verdict only while no save-check invalidation happened since it started.
    const serial = this.checkSerial;
    this.hwpOriginal = { owner, state: "checking" };
    this.hwpOriginalProbes += 1;
    const settle = (next: NonNullable<typeof this.hwpOriginal>) => {
      if (this.disposed || this.originalOwner() !== owner || this.hwpOriginal?.owner !== owner || this.hwpOriginal.state !== "checking") return;
      this.hwpOriginal = next;
      this.emit();
    };
    void this.preflight(-1).then(
      checked => settle(checked.ok ? { owner, state: blockedBy(checked.value) ? "blocked" : "safe", check: checked.value, serial } : { owner, state: "error" }),
      () => settle({ owner, state: "error" }),
    );
  }
  /** A manual Save Check result for the current original also decides structural eligibility (the retry path). */
  private recordOriginalCheck(checked: Result<SaveCheck>): void {
    const owner = this.originalOwner();
    if (!["hwp", "hwpx"].includes(this.sessions.get(this.sessionId)?.format ?? "")) return;
    // Like `saveCheck`, a later check that could not establish safety supersedes an earlier SAFE verdict.
    this.hwpOriginal = checked.ok
      ? { owner, state: blockedBy(checked.value) ? "blocked" : "safe", check: checked.value, serial: this.checkSerial }
      : { owner, state: "error" };
  }

  private parameterCache: { key: string; value: Pick<DocumentCommandSnapshot, "parameters" | "parameterReasons"> } | null = null;

  /**
   * 값 입력 명령(T012)의 문맥. 모델 판·선택·IME·편집 가능이 같으면 다시 읽지 않는다.
   * - 장평·자간: HWP/HWPX, 필수 API/문자 모양 ownership·기록·IME 안정 + 한 문단 안의 같은 문맥 선택.
   *   제품 고급 부분집합은 크기/쪽 수·commit 대기도 검사한다. 여러 문단/문맥 선택은 selectionRequired.
   * - 표 계산: 편집 가능·IME 안정·불확실 아님 + 커서가 표 셀 안이고 엔진이 그 셀의 논리 좌표·표 크기를 알려 줄 때(HWP·HWPX 모두 —
   *   문서를 바꾸지 않는 계산). 셀 밖이면 이유 notInTable.
   */
  /**
   * Whether exiting an existing bullet (Enter on an empty item) is unavailable. HWPX: never. HWP: only the
   * static conditions of structuralBlock() (detailed APIs, complete baseline, section 0) apply — the original
   * preflight state does not, because no new definition or object is introduced; Save still runs the original
   * preflight and the T009 check of the edited output, which keep an unsafe original from being published.
   */
  private bulletExitBlocked(): boolean { return this.structuralBlock() === "engineUnsupported"; }

  private bulletRange(allowPending = false, exit = false): { first: number; last: number; section: number } | null {
    if ((exit ? this.bulletExitBlocked() : !this.structuralFormat()) || !this.editable || this.imeUnsettled || this.uncertain
      || (!allowPending && (this.pending > 0 || this.committingEpoch === this.epoch)) || this.caret.cell || this.anchor.cell
      || this.caret.section !== this.anchor.section || !this.doc?.getParaPropertiesAt || !this.doc.applyParaFormat || !this.doc.ensureDefaultBullet) return null;
    const [first, last] = this.caret.paragraph < this.anchor.paragraph ? [this.caret, this.anchor] : [this.anchor, this.caret];
    const end = last.paragraph > first.paragraph && last.offset === 0 ? last.paragraph - 1 : last.paragraph;
    return end - first.paragraph < 256 ? { section: first.section, first: first.paragraph, last: end } : null;
  }
  private coreActionCache: { key: string; value: NonNullable<DocumentCommandSnapshot["actions"]> } | null = null;
  private coreActions(): NonNullable<DocumentCommandSnapshot["actions"]> {
    const key = [this.epoch, this.modelVersion, this.clipboardVersion, this.pending, this.committingEpoch === this.epoch,
      this.editable, this.imeUnsettled, this.uncertain, this.imageSelecting, this.sessions.get(this.sessionId)?.format,
      this.structuralKey(), this.structureVersion, !!this.history, this.historyOff,
      RhwpEditorSession.positionKey(this.anchor), RhwpEditorSession.positionKey(this.caret)].join("|");
    if (this.coreActionCache?.key === key) return this.coreActionCache.value;
    const actions: NonNullable<DocumentCommandSnapshot["actions"]> = {};
    if (this.structuralFormat() && this.doc?.insertPicture && this.doc.setPictureProperties
      && this.editable && !this.imeUnsettled && !this.uncertain && !this.hasSelection && (!this.caret.cell || this.canInsertCellPicture())
      && !this.pending && this.committingEpoch !== this.epoch && !this.imageSelecting) actions["insert.image"] = {};
    const range = this.bulletRange();
    if (range) {
      try {
        let all = true;
        for (let p = range.first; p <= range.last; p++) all &&= JSON.parse(this.doc!.getParaPropertiesAt!(range.section, p)).headType === "Bullet";
        actions["paragraph.bullets"] = { pressed: all };
      } catch { /* unavailable if the engine cannot report paragraph state */ }
    }
    for (const op of TABLE_STRUCTURE_OPS) if (this.tableOpState(op) === null) actions[`table.${op}`] = {};
    if (this.canInsertShape()) actions["insert.textBox"] = {};
    this.coreActionCache = { key, value: actions };
    return actions;
  }

  // ---- 표 구조(T012 Phase 2) ----

  /** The explicitly owned table of the caret; geometry/content are cached independently of its selected cell. */
  private caretTable(): { target: TableTarget; grid: TableGrid | TableStructureRefusal; content: TableStructureRefusal | null } | null {
    const cell = this.caret.cell, doc = this.doc, text = this.text;
    if (!cell || !doc || !text) return null;
    const target: TableTarget = { section: this.caret.section, paragraph: cell.parentParagraph,
      control: innermost(cell).control, ...(cell.nested ? { path: cell } : {}) };
    const key = `${target.section}:${target.paragraph}:${target.control}:${target.path ? pathJson(withCell(this.caret, 0).cell!) : ""}`;
    const cached = this.tableCache;
    if (cached && cached.text === text && cached.version === this.structureVersion && cached.key === key) return { target, grid: cached.grid, content: cached.content };
    const grid = readTableGrid(doc, target);
    const content = typeof grid === "string" ? null : tableContentRefusal(doc, target, grid, this.tableContentOptions());
    this.tableCache = { text, version: this.structureVersion, key, grid, content };
    return { target, grid, content };
  }

  /** Fields and captions relocate with their cells in both formats; HWP saves are judged by the T009 field/caption model. */
  private tableContentOptions() { return { fields: true }; }

  /**
   * Why a table structure command cannot run now (null = it can). Each operation is judged on its own: the
   * session state, the format's preservation rule (HWP needs the same original proof as other structural
   * edits), an owned table path, the table's content and the operation's own geometry.
   */
  private tableOpState(op: TableStructureOp): NonNullable<DocumentCommandSnapshot["actionReasons"]>["table.splitCell"] | null {
    const doc = this.doc;
    if (!this.editable || !doc || !this.text || this.imeUnsettled || this.uncertain) return "engineUnsupported";
    if (!hasTableStructureApi(doc, op)) return "engineUnsupported";
    if (this.pending > 0 || this.committingEpoch === this.epoch) return "pendingEdits";
    if (!this.caret.cell || (this.hasSelection && op !== "mergeCells")) return "notInTable";
    if (this.caret.cell.nested && (!doc.editTableByPath || !this.ownsPosition(this.caret))) return "engineUnsupported";
    if (!this.history) return this.historyOff === "limit" ? "limit" : "engineUnsupported";
    const block = this.structuralBlock();
    if (block) return block;
    const table = this.caretTable();
    if (!table) return "notInTable";
    if (typeof table.grid === "string") return table.grid;
    if (table.content) return table.content;
    const index = innermost(this.caret.cell).cell;
    if (index >= table.grid.cells.length) return "tableShape";
    if (op === "mergeCells") return this.selectedCellRange() ? null : "tableShape";
    const at = table.grid.cells[index]!;
    // An ordinary (unmerged) cell is split through the dimension dialog: it needs the explicit-path engine
    // operation and at least one split of two cells within the table limits and the minimum cell width.
    if (op === "splitCell" && at.rowSpan === 1 && at.colSpan === 1) {
      if (!hasOrdinarySplitApi(doc, table.target)) return "engineUnsupported";
      return tableOpRefusal(table.grid, index, op) ?? (this.ordinarySplitContext() ? null : "limit");
    }
    return tableOpRefusal(table.grid, index, op);
  }

  /** Dimension bounds of the caret's ordinary cell split (dialog context), or null for merged cells/no valid split. */
  private ordinarySplitContext(): { maxRows: number; maxColumns: number; maxCells: number } | null {
    const doc = this.doc, table = this.caretTable(), cell = this.caret.cell;
    if (!doc || !table || !cell || typeof table.grid === "string" || table.content) return null;
    const index = innermost(cell).cell;
    const at = table.grid.cells[index];
    if (!at || at.rowSpan !== 1 || at.colSpan !== 1 || !hasOrdinarySplitApi(doc, table.target)) return null;
    return ordinarySplitLimits(table.grid, index, tableCellWidth(doc, table.target, index));
  }

  private selectedCellRange(): CellRange | null {
    if (!sameTable(this.anchor, this.caret) || !this.anchor.cell || !this.caret.cell) return null;
    const table = this.caretTable();
    if (!table || typeof table.grid === "string") return null;
    return rectangularRange(table.grid, innermost(this.anchor.cell).cell, innermost(this.caret.cell).cell);
  }

  /**
   * One table structure change = one mutation and one Undo step. The plan (target, engine arguments, exact
   * expected table) is computed from the current model before any engine call; a refusal changes nothing and
   * opens no history transaction. `applyTablePlan` proves the engine's result cell by cell and throws on any
   * difference — `mutate` then rolls the model back to the snapshot taken before the call and stops editing.
   */
  private applyTableOp(op: TableStructureOp, split?: CellSplit): boolean {
    if (this.tableOpState(op) !== null) return false;
    const doc = this.doc!, table = this.caretTable();
    if (!table || typeof table.grid === "string") return false;
    const { target } = table, original = this.caret, cell = this.caret.cell!;
    // Ordinary split: the request must still fit the bounds read from the current table (stale dialogs refuse).
    if (split) {
      const limits = this.ordinarySplitContext();
      if (!limits || !ordinarySplitValid(split, limits)) return false;
    }
    let plan: ReturnType<typeof planTableOp>;
    try { plan = planTableOp(doc, target, table.grid, innermost(cell).cell, op, this.selectedCellRange() ?? undefined, this.tableContentOptions(), split); }
    catch { return false; } // a getter failed: nothing was changed
    if (typeof plan === "string") return false;
    this.history?.boundary();
    const applied = this.mutate(() => {
      const grid = applyTablePlan(doc, target, plan);
      const index = cellCovering(grid, plan.caret.row, plan.caret.col);
      if (index < 0) throw new Error("table caret cell missing");
      // The caret never keeps an index of the old table: it is re-resolved from the proven result grid.
      return withCell(original, index);
    }, true, "other", null, true);
    this.history?.boundary();
    return applied;
  }

  private cellFormattingState():
    | { refusal: NonNullable<DocumentCommandSnapshot["parameterReasons"]>["table.shading"] & string }
    | {
        target: TableTarget;
        rect: { startRow: number; startCol: number; endRow: number; endCol: number };
        tableShading: NonNullable<CommandParameterContext["tableShading"]>;
        tableBorders: NonNullable<CommandParameterContext["tableBorders"]>;
        tableAlignment: NonNullable<CommandParameterContext["tableAlignment"]>;
        tableColumnWidth: NonNullable<CommandParameterContext["tableColumnWidth"]>;
        tableRowHeight: NonNullable<CommandParameterContext["tableRowHeight"]>;
      } {
    const doc = this.doc, text = this.text;
    if (!this.editable || !doc || !text || this.imeUnsettled || this.uncertain) return { refusal: "engineUnsupported" };
    if (!doc.getTableCellFormattingByPath || !doc.formatTableCellsByPath) return { refusal: "engineUnsupported" };
    if (this.pending > 0 || this.committingEpoch === this.epoch) return { refusal: "pendingEdits" };
    if (!this.caret.cell) return { refusal: "notInTable" };
    if (this.hasSelection && (!this.anchor.cell || !sameTable(this.anchor, this.caret))) return { refusal: "tableShape" };
    if (this.caret.cell.nested && !this.ownsPosition(this.caret)) return { refusal: "engineUnsupported" };
    if (!this.history) return { refusal: this.historyOff === "limit" ? "limit" : "engineUnsupported" };
    const block = this.structuralBlock();
    if (block) return { refusal: block };
    const table = this.caretTable();
    if (!table) return { refusal: "notInTable" };
    if (typeof table.grid === "string") return { refusal: table.grid === "tableContent" ? "tableContent" : table.grid === "limit" ? "limit" : table.grid === "engineUnsupported" ? "engineUnsupported" : "tableShape" };
    const first = innermost(this.caret.cell).cell;
    const last = this.hasSelection && this.anchor.cell ? innermost(this.anchor.cell).cell : first;
    if (first >= table.grid.cells.length || last >= table.grid.cells.length) return { refusal: "tableShape" };
    let rect: CellRange;
    let hasInsideBorders = false;
    if (first === last) {
      const c = table.grid.cells[first]!;
      rect = { startRow: c.row, startCol: c.col, endRow: c.row + c.rowSpan - 1, endCol: c.col + c.colSpan - 1 };
    } else {
      const range = rectangularRange(table.grid, first, last);
      if (!range) return { refusal: "tableShape" };
      rect = range;
      const count = table.grid.cells.filter((c) => {
        const cr1 = c.row + c.rowSpan - 1, cc1 = c.col + c.colSpan - 1;
        return cr1 >= range.startRow && c.row <= range.endRow && cc1 >= range.startCol && c.col <= range.endCol;
      }).length;
      hasInsideBorders = count >= 2;
    }
    try {
      const raw = doc.getTableCellFormattingByPath(
        table.target.section, table.target.paragraph, tableTargetPathJson(table.target),
        rect.startRow, rect.startCol, rect.endRow, rect.endCol,
      );
      const info = JSON.parse(raw) as {
        hasZones?: boolean;
        cellCount?: number;
        shading?: { uniform?: boolean; color?: string | null };
        border?: { uniform?: boolean; lineType?: number; width?: number; color?: string };
        alignment?: {
          horizontal?: "left" | "center" | "right" | "justify" | null;
          horizontalMixed?: boolean;
          vertical?: "top" | "middle" | "bottom" | null;
          verticalMixed?: boolean;
        };
        dimensions?: {
          selectedCols?: number;
          selectedRows?: number;
          totalCols?: number;
          totalRows?: number;
          colWidthPt?: number | null;
          colWidthMixed?: boolean;
          rowHeightPt?: number | null;
          rowHeightMixed?: boolean;
        };
      };
      if (info.hasZones) return { refusal: "tableShape" };
      const uniformShade = info.shading?.uniform === true;
      const rawColor = uniformShade && typeof info.shading?.color === "string" ? `#${info.shading.color.toUpperCase()}` : null;
      const edge = info.border?.uniform === true
        && typeof info.border.lineType === "number" && typeof info.border.width === "number"
        ? {
            style: rhwpBorderCodeToStyle(info.border.lineType) ?? "single",
            width: rhwpBorderIndexToWidth(info.border.width) ?? 0.12,
            color: typeof info.border.color === "string" ? `#${info.border.color.toUpperCase()}` : null,
          }
        : null;
      const selectedCells = typeof info.cellCount === "number" ? info.cellCount : 1;
      const hVal = info.alignment?.horizontal ?? null;
      const vVal = info.alignment?.vertical ?? null;
      const dims = info.dimensions;
      return {
        target: table.target,
        rect,
        tableShading: {
          color: rawColor,
          mixed: !uniformShade,
          hasShading: !uniformShade || rawColor !== null,
          selectedCells,
          supportsClear: true,
        },
        tableBorders: {
          hasInsideBorders,
          supportedStyles: RHWP_BORDER_STYLES,
          widthUnit: "mm",
          supportedWidths: RHWP_BORDER_WIDTHS_MM,
          defaultWidth: 0.12,
          current: edge ? { top: edge, bottom: edge, left: edge, right: edge } : null,
        },
        tableAlignment: {
          horizontal: hVal === "left" || hVal === "center" || hVal === "right" || hVal === "justify" ? hVal : null,
          horizontalMixed: info.alignment?.horizontalMixed === true,
          vertical: vVal === "top" || vVal === "middle" || vVal === "bottom" ? vVal : null,
          verticalMixed: info.alignment?.verticalMixed === true,
          selectedCells,
        },
        tableColumnWidth: {
          width: typeof dims?.colWidthPt === "number" ? dims.colWidthPt : null,
          mixed: dims?.colWidthMixed === true,
          minPt: 6,
          maxPt: 1584,
          selectedCols: typeof dims?.selectedCols === "number" ? dims.selectedCols : 1,
          totalCols: typeof dims?.totalCols === "number" ? dims.totalCols : 1,
        },
        tableRowHeight: {
          height: typeof dims?.rowHeightPt === "number" ? dims.rowHeightPt : null,
          mixed: dims?.rowHeightMixed === true,
          rule: "atLeast",
          supportedRules: ["atLeast"],
          supportsAuto: false,
          minPt: 1,
          maxPt: 1584,
          selectedRows: typeof dims?.selectedRows === "number" ? dims.selectedRows : 1,
          totalRows: typeof dims?.totalRows === "number" ? dims.totalRows : 1,
        },
      };
    } catch {
      return { refusal: "tableShape" };
    }
  }

  private applyCellFormatting(args: Extract<DocumentCommandArgs, { command: "table.shading" | "table.borders" | "table.alignment" | "table.columnWidth" | "table.rowHeight" }>): boolean {
    const context = this.parameterState().parameters?.[args.command];
    const fmt = this.cellFormattingState();
    if (!context || "refusal" in fmt || !validateCommandArgs(args.command, args, context)) return false;
    const doc = this.doc!;
    let payload: Record<string, unknown>;
    if (args.command === "table.shading") {
      payload = {
        rect: fmt.rect,
        shading: { color: args.color ? args.color.trim().replace(/^#/, "").toUpperCase() : null },
      };
    } else if (args.command === "table.borders") {
      const style = args.kind === "none" ? "none" : (args.style ?? "single");
      const lineType = rhwpBorderStyleToCode(style);
      const widthIdx = args.width !== undefined ? rhwpBorderWidthToIndex(args.width) : 1;
      if (lineType === null || widthIdx === null) return false;
      const color = args.color ? args.color.trim().replace(/^#/, "").toUpperCase() : "000000";
      payload = {
        rect: fmt.rect,
        borders: { kind: args.kind, lineType, width: widthIdx, color },
      };
    } else if (args.command === "table.alignment") {
      payload = {
        rect: fmt.rect,
        alignment: {
          ...(args.horizontal !== undefined ? { horizontal: args.horizontal } : {}),
          ...(args.vertical !== undefined ? { vertical: args.vertical } : {}),
        },
      };
    } else if (args.command === "table.columnWidth") {
      payload = {
        rect: fmt.rect,
        columnWidth: args.distribute ? { distribute: true } : { widthPt: args.width },
      };
    } else {
      payload = {
        rect: fmt.rect,
        rowHeight: args.distribute ? { distribute: true } : { heightPt: args.height },
      };
    }
    const caret = this.caret, anchor = this.anchor;
    this.history?.boundary();
    const applied = this.mutate(() => {
      const res = JSON.parse(doc.formatTableCellsByPath!(
        fmt.target.section, fmt.target.paragraph, tableTargetPathJson(fmt.target), JSON.stringify(payload),
      )) as { ok?: boolean };
      if (res.ok !== true) throw new Error("cell formatting rejected");
      if (this.borderFillBaseline !== null && typeof doc.compactAppendedBorderFills === "function") {
        const comp = JSON.parse(doc.compactAppendedBorderFills(this.borderFillBaseline)) as { ok?: boolean };
        if (comp.ok !== true) throw new Error("borderFill compaction failed");
      }
      return { caret, anchor };
    }, true, "other", null, true);
    this.history?.boundary();
    return applied;
  }

  private tableMarginsAndPositioningState(): {
    target?: TableTarget;
    rect?: CellRange;
    cellMargins?: NonNullable<CommandParameterContext["tableCellMargins"]>;
    cellMarginsRefusal?: NonNullable<DocumentCommandSnapshot["parameterReasons"]>["table.cellMargins"];
    positioning?: NonNullable<CommandParameterContext["tablePositioning"]>;
    positioningRefusal?: NonNullable<DocumentCommandSnapshot["parameterReasons"]>["table.positioning"];
    repeatHeader?: NonNullable<CommandParameterContext["tableRepeatHeader"]>;
    repeatHeaderRefusal?: NonNullable<DocumentCommandSnapshot["parameterReasons"]>["table.repeatHeader"];
    rowBreak?: NonNullable<CommandParameterContext["tableRowBreak"]>;
    rowBreakRefusal?: NonNullable<DocumentCommandSnapshot["parameterReasons"]>["table.rowBreak"];
  } {
    const doc = this.doc, text = this.text;
    const failAll = (refusal: NonNullable<DocumentCommandSnapshot["parameterReasons"]>["table.cellMargins"]) => ({
      cellMarginsRefusal: refusal,
      positioningRefusal: refusal,
      repeatHeaderRefusal: refusal,
      rowBreakRefusal: refusal,
    });
    if (!this.editable || !doc || !text || this.imeUnsettled || this.uncertain) return failAll("engineUnsupported");
    if (this.pending > 0 || this.committingEpoch === this.epoch) return failAll("pendingEdits");
    if (!this.caret.cell) return failAll("notInTable");
    if (this.hasSelection && (!this.anchor.cell || !sameTable(this.anchor, this.caret))) return failAll("tableShape");
    if (this.caret.cell.nested && !this.ownsPosition(this.caret)) return failAll("engineUnsupported");
    if (!this.history) return failAll(this.historyOff === "limit" ? "limit" : "engineUnsupported");
    const block = this.structuralBlock();
    if (block) return failAll(block);
    const table = this.caretTable();
    if (!table) return failAll("notInTable");
    if (typeof table.grid === "string") {
      const r = table.grid === "tableContent" ? "tableContent"
        : table.grid === "limit" ? "limit"
        : table.grid === "engineUnsupported" ? "engineUnsupported"
        : "tableShape";
      return failAll(r);
    }
    const first = innermost(this.caret.cell).cell;
    const last = this.hasSelection && this.anchor.cell ? innermost(this.anchor.cell).cell : first;
    if (first >= table.grid.cells.length || last >= table.grid.cells.length) return failAll("tableShape");
    let rect: CellRange;
    if (first === last) {
      const c = table.grid.cells[first]!;
      rect = { startRow: c.row, startCol: c.col, endRow: c.row + c.rowSpan - 1, endCol: c.col + c.colSpan - 1 };
    } else {
      const range = rectangularRange(table.grid, first, last);
      if (!range) return failAll("tableShape");
      rect = range;
    }

    const pathJson = tableTargetPathJson(table.target);
    const huToPt = (raw: unknown): number =>
      typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) / 100 : 0;

    let cellMargins: NonNullable<CommandParameterContext["tableCellMargins"]> | undefined;
    let cellMarginsRefusal: NonNullable<DocumentCommandSnapshot["parameterReasons"]>["table.cellMargins"];
    if (!doc.getTableCellMarginsByPath || !doc.setTableCellMarginsByPath) {
      cellMarginsRefusal = "engineUnsupported";
    } else {
      try {
        const parsed = JSON.parse(doc.getTableCellMarginsByPath(
          table.target.section, table.target.paragraph, pathJson,
          rect.startRow, rect.startCol, rect.endRow, rect.endCol,
        )) as {
          table?: { top?: number; right?: number; bottom?: number; left?: number };
          cell?: {
            top?: number | null; right?: number | null; bottom?: number | null; left?: number | null;
            mixed?: boolean; usesTableDefault?: boolean; mixedOverride?: boolean;
          };
        };
        if (parsed.table && parsed.cell) {
          cellMargins = {
            scopeDefaultSupported: true,
            table: {
              top: huToPt(Number(parsed.table.top ?? 0) * 100),
              right: huToPt(Number(parsed.table.right ?? 0) * 100),
              bottom: huToPt(Number(parsed.table.bottom ?? 0) * 100),
              left: huToPt(Number(parsed.table.left ?? 0) * 100),
            },
            cell: {
              top: typeof parsed.cell.top === "number" ? parsed.cell.top : null,
              right: typeof parsed.cell.right === "number" ? parsed.cell.right : null,
              bottom: typeof parsed.cell.bottom === "number" ? parsed.cell.bottom : null,
              left: typeof parsed.cell.left === "number" ? parsed.cell.left : null,
              mixed: parsed.cell.mixed === true,
              usesTableDefault: parsed.cell.usesTableDefault === true,
              mixedOverride: parsed.cell.mixedOverride === true,
            },
            minPt: 0,
            maxPt: 144,
          };
        } else {
          cellMarginsRefusal = "tableShape";
        }
      } catch {
        cellMarginsRefusal = "tableShape";
      }
    }

    let positioning: NonNullable<CommandParameterContext["tablePositioning"]> | undefined;
    let positioningRefusal: NonNullable<DocumentCommandSnapshot["parameterReasons"]>["table.positioning"];
    if (this.caret.cell.nested) {
      positioningRefusal = "tableShape";
    } else if (!doc.getTablePropertiesByPath || !doc.setTablePropertiesByPath) {
      positioningRefusal = "engineUnsupported";
    } else {
      try {
        const props = JSON.parse(doc.getTablePropertiesByPath(
          table.target.section, table.target.paragraph, pathJson,
        )) as {
          horzAlign?: string; horzOffset?: number; treatAsChar?: boolean;
          outerTop?: number; outerRight?: number; outerBottom?: number; outerLeft?: number;
        };
        const rawAlign = String(props.horzAlign ?? "Left").toLowerCase();
        positioning = {
          align: rawAlign === "center" ? "center" : rawAlign === "right" ? "right" : "left",
          indentPt: huToPt(props.horzOffset),
          minIndentPt: -72,
          maxIndentPt: 360,
          supportsIndent: true,
          treatAsCharSupported: true,
          treatAsChar: props.treatAsChar === true,
          outerMargins: {
            top: huToPt(props.outerTop),
            right: huToPt(props.outerRight),
            bottom: huToPt(props.outerBottom),
            left: huToPt(props.outerLeft),
          },
        };
      } catch {
        positioningRefusal = "tableShape";
      }
    }

    let repeatHeader: NonNullable<CommandParameterContext["tableRepeatHeader"]> | undefined;
    let repeatHeaderRefusal: NonNullable<DocumentCommandSnapshot["parameterReasons"]>["table.repeatHeader"];
    let rowBreak: NonNullable<CommandParameterContext["tableRowBreak"]> | undefined;
    let rowBreakRefusal: NonNullable<DocumentCommandSnapshot["parameterReasons"]>["table.rowBreak"];
    if (!doc.getTablePaginationByPath || !doc.setTableHeaderRowsByPath || !doc.setTablePropertiesByPath) {
      repeatHeaderRefusal = rowBreakRefusal = "engineUnsupported";
    } else {
      try {
        const pg = JSON.parse(doc.getTablePaginationByPath(
          table.target.section, table.target.paragraph, pathJson, rect.startRow, rect.endRow,
        )) as {
          pageBreak?: "none" | "cell" | "row";
          leadingHeaderRows?: number;
          rowHeader?: boolean | null;
          rowHeaderMixed?: boolean;
          canEnableHeader?: boolean;
        };
        repeatHeader = {
          repeat: typeof pg.rowHeader === "boolean" ? pg.rowHeader : null,
          mixed: pg.rowHeaderMixed === true,
          leadingHeaderRows: typeof pg.leadingHeaderRows === "number" ? pg.leadingHeaderRows : 0,
          canEnableHeader: pg.canEnableHeader === true,
        };
        const mode = pg.pageBreak === "cell" || pg.pageBreak === "row" || pg.pageBreak === "none" ? pg.pageBreak : "row";
        rowBreak = {
          mode,
          mixed: false,
          supportedModes: ["cell", "row", "none"],
        };
      } catch {
        repeatHeaderRefusal = rowBreakRefusal = "tableShape";
      }
    }

    return {
      target: table.target,
      rect,
      ...(cellMargins ? { cellMargins } : {}),
      ...(cellMarginsRefusal ? { cellMarginsRefusal } : {}),
      ...(positioning ? { positioning } : {}),
      ...(positioningRefusal ? { positioningRefusal } : {}),
      ...(repeatHeader ? { repeatHeader } : {}),
      ...(repeatHeaderRefusal ? { repeatHeaderRefusal } : {}),
      ...(rowBreak ? { rowBreak } : {}),
      ...(rowBreakRefusal ? { rowBreakRefusal } : {}),
    };
  }

  private applyRepeatHeader(args: Extract<DocumentCommandArgs, { command: "table.repeatHeader" }>): boolean {
    const context = this.parameterState().parameters?.["table.repeatHeader"];
    const state = this.tableMarginsAndPositioningState();
    const doc = this.doc;
    if (!context || !state.target || !state.rect || !state.repeatHeader || !doc?.setTableHeaderRowsByPath
      || !validateCommandArgs("table.repeatHeader", args, context)) {
      return false;
    }
    const caret = this.caret, anchor = this.anchor;
    this.history?.boundary();
    const applied = this.mutate(() => {
      const res = JSON.parse(doc.setTableHeaderRowsByPath!(
        state.target!.section, state.target!.paragraph, tableTargetPathJson(state.target!),
        state.rect!.startRow, state.rect!.endRow, args.repeat,
      )) as { ok?: boolean };
      if (res.ok !== true) throw new Error("repeatHeader rejected");
      return { caret, anchor };
      // The engine validates the whole row range before changing any flag, so a
      // refused range (e.g. a header row below the selection) is a recoverable no-op.
    }, true, "other", null, true, true);
    this.history?.boundary();
    return applied;
  }

  private applyRowBreak(args: Extract<DocumentCommandArgs, { command: "table.rowBreak" }>): boolean {
    const context = this.parameterState().parameters?.["table.rowBreak"];
    const state = this.tableMarginsAndPositioningState();
    const doc = this.doc;
    if (!context || !state.target || !state.rowBreak || !doc?.setTablePropertiesByPath
      || !validateCommandArgs("table.rowBreak", args, context)) {
      return false;
    }
    const pageBreakCode = args.mode === "cell" ? 1 : args.mode === "row" ? 2 : 0;
    const caret = this.caret, anchor = this.anchor;
    this.history?.boundary();
    const applied = this.mutate(() => {
      const res = JSON.parse(doc.setTablePropertiesByPath!(
        state.target!.section, state.target!.paragraph, tableTargetPathJson(state.target!),
        JSON.stringify({ pageBreak: pageBreakCode }),
      )) as { ok?: boolean };
      if (res.ok !== true) throw new Error("rowBreak rejected");
      return { caret, anchor };
    }, true, "other", null, true);
    this.history?.boundary();
    return applied;
  }

  private applyCellMargins(args: Extract<DocumentCommandArgs, { command: "table.cellMargins" }>): boolean {
    const context = this.parameterState().parameters?.["table.cellMargins"];
    const state = this.tableMarginsAndPositioningState();
    const doc = this.doc;
    if (!context || !state.target || !state.rect || !state.cellMargins || !doc?.setTableCellMarginsByPath
      || !validateCommandArgs("table.cellMargins", args, context)) {
      return false;
    }
    const payload = {
      scope: args.scope,
      ...(args.scope === "cell" ? { rect: state.rect } : {}),
      ...(args.top !== undefined ? { top: args.top } : {}),
      ...(args.right !== undefined ? { right: args.right } : {}),
      ...(args.bottom !== undefined ? { bottom: args.bottom } : {}),
      ...(args.left !== undefined ? { left: args.left } : {}),
      ...(args.reset ? { reset: true } : {}),
    };
    const caret = this.caret, anchor = this.anchor;
    this.history?.boundary();
    const applied = this.mutate(() => {
      const res = JSON.parse(doc.setTableCellMarginsByPath!(
        state.target!.section, state.target!.paragraph, tableTargetPathJson(state.target!), JSON.stringify(payload),
      )) as { ok?: boolean };
      if (res.ok !== true) throw new Error("cell margins rejected");
      return { caret, anchor };
    }, true, "other", null, true);
    this.history?.boundary();
    return applied;
  }

  private applyTablePositioning(args: Extract<DocumentCommandArgs, { command: "table.positioning" }>): boolean {
    const context = this.parameterState().parameters?.["table.positioning"];
    const state = this.tableMarginsAndPositioningState();
    const doc = this.doc;
    if (!context || !state.target || !state.positioning || !doc?.setTablePropertiesByPath
      || this.caret.cell?.nested || !validateCommandArgs("table.positioning", args, context)) {
      return false;
    }
    const payload: Record<string, unknown> = {};
    if (args.treatAsChar !== undefined) payload.treatAsChar = args.treatAsChar;
    if (args.align !== undefined) {
      payload.horzAlign = args.align === "center" ? "Center" : args.align === "right" ? "Right" : "Left";
    }
    if (args.indentPt !== undefined) payload.horzOffset = Math.round(args.indentPt * 100);
    if (args.outerMargins) {
      if (args.outerMargins.top !== undefined) payload.outerTop = Math.round(args.outerMargins.top * 100);
      if (args.outerMargins.right !== undefined) payload.outerRight = Math.round(args.outerMargins.right * 100);
      if (args.outerMargins.bottom !== undefined) payload.outerBottom = Math.round(args.outerMargins.bottom * 100);
      if (args.outerMargins.left !== undefined) payload.outerLeft = Math.round(args.outerMargins.left * 100);
    }
    const caret = this.caret, anchor = this.anchor;
    this.history?.boundary();
    const applied = this.mutate(() => {
      const res = JSON.parse(doc.setTablePropertiesByPath!(
        state.target!.section, state.target!.paragraph, tableTargetPathJson(state.target!), JSON.stringify(payload),
      )) as { ok?: boolean };
      if (res.ok !== true) throw new Error("table positioning rejected");
      return { caret, anchor };
    }, true, "other", null, true);
    this.history?.boundary();
    return applied;
  }
  /** Distinguish "checking the original" / "original not verified" for the HWP action commands. */
  private coreActionReasons(): Pick<DocumentCommandSnapshot, "actionReasons"> {
    const block = this.structuralBlock();
    const actionReasons: NonNullable<DocumentCommandSnapshot["actionReasons"]> = {};
    for (const op of TABLE_STRUCTURE_OPS) {
      const reason = this.tableOpState(op);
      if (reason) actionReasons[`table.${op}`] = reason;
    }
    if (block === "originalChecking" || block === "originalUnverified") actionReasons["insert.image"] = actionReasons["paragraph.bullets"] = block;
    return { actionReasons };
  }
  private toggleBullets(forceOff = false): boolean {
    const range = this.bulletRange(forceOff, forceOff), doc = this.doc;
    if (!range || !doc) return false;
    let off = true;
    try { for (let p = range.first; p <= range.last; p++) off &&= JSON.parse(doc.getParaPropertiesAt!(range.section, p)).headType === "Bullet"; }
    catch { return false; }
    off ||= forceOff;
    return this.mutate(() => {
      const id = off ? 0 : doc.ensureDefaultBullet!("•");
      if (!Number.isSafeInteger(id) || id < (off ? 0 : 1) || id > 65535) throw new Error("invalid bullet ID");
      for (let p = range.first; p <= range.last; p++) {
        const result = JSON.parse(doc.applyParaFormat!(range.section, p, JSON.stringify({ headType: off ? "None" : "Bullet", numberingId: id, paraLevel: 0 })));
        if (result.ok !== true) throw new Error("bullet formatting rejected");
      }
      return { caret: this.caret, anchor: this.anchor };
    });
  }

  private canInsertCellPicture(): boolean {
    const at = this.caret, doc = this.doc;
    if (!at.cell || at.cell.textBox || at.cell.caption || !this.history || !this.ownsPosition(at) || !doc?.insertPictureInCellByPath
      || !doc.getCellPictureByPath || !doc.canInsertPictureInCellByPath
      || !doc.getCellInlineContextByPath || !doc.insertCellInlineTextByPath) return false;
    try { return doc.canInsertPictureInCellByPath(at.section, at.cell.parentParagraph, pathJson(at.cell), at.offset); }
    catch { return false; }
  }

  private imageSelecting = false;
  async executeImage(owns: () => boolean, pick: () => Promise<import("../../../commands/target").ImportedPicture | null>): Promise<"inserted" | "cancelled" | "stale" | "failed"> {
    if (this.imageSelecting || !owns() || !documentCommandState("insert.image", this.snapshot()).available) return "stale";
    const epoch = this.epoch, version = this.modelVersion, caret = this.clipboardVersion, position = RhwpEditorSession.positionKey(this.caret);
    this.imageSelecting = true; this.emit();
    try {
      const picture = await pick();
      if (picture === null) return "cancelled";
      if (!owns() || !this.owns(epoch) || version !== this.modelVersion || caret !== this.clipboardVersion
        || position !== RhwpEditorSession.positionKey(this.caret)) return "stale";
      const { data, width, height } = picture;
      if (typeof data !== "string" || data.length > Math.ceil(16 * 1024 * 1024 / 3) * 4
        || ![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 8192) || width * height > 16 * 1024 * 1024) return "failed";
      const raw = atob(data), bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
      const ext = bytes[0] === 0x89 && bytes[1] === 0x50 ? "png" : bytes[0] === 0xff && bytes[1] === 0xd8 ? "jpeg" : null;
      if (!ext || !bytes.length || bytes.length > 16 * 1024 * 1024) return "failed";
      const digest = this.caret.cell ? await sha256(bytes.buffer) : null;
      this.imageSelecting = false;
      if (!owns() || !this.owns(epoch) || version !== this.modelVersion || caret !== this.clipboardVersion
        || position !== RhwpEditorSession.positionKey(this.caret)
        || !documentCommandState("insert.image", this.snapshot()).available) return "stale";
      const scale = Math.min(75, 43200 / width, 60000 / height);
      const at = this.caret, doc = this.doc!, hwp = this.sessions.get(this.sessionId)?.format === "hwp";
      // Cells require rollback history; body insertion retains its history-optional contract.
      // When body history is present, keep the existing atomic rollback/Undo step.
      return this.mutate(() => {
        if (at.cell) {
          const path = pathJson(at.cell), host = at.cell.parentParagraph;
          const result = JSON.parse(doc.insertPictureInCellByPath!(at.section, host, path, at.offset, bytes,
            Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), width, height, ext, "")) as Record<string, unknown>;
          if (result.ok !== true || result.section !== at.section || result.paraIdx !== host
            || !Number.isSafeInteger(result.controlIdx)
            || result.position !== at.offset || result.logicalOffset !== at.offset + 1
            || result.sha256 !== digest || result.byteLength !== bytes.length
            || result.width !== Math.max(1, Math.round(width * scale)) || result.height !== Math.max(1, Math.round(height * scale))
            || !insertedCellPicture(doc, at.section, host, path, result.controlIdx as number, result)
          ) throw new Error("cell picture ownership not verified");
          return { ...at, offset: result.logicalOffset as number };
        }
        const result = JSON.parse(doc.insertPicture!(at.section, at.paragraph, at.offset, "[]", bytes,
          Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), width, height, ext, "")) as Record<string, unknown>;
        if (result.ok !== true || !Number.isSafeInteger(result.paraIdx) || !Number.isSafeInteger(result.controlIdx)
          || !Number.isSafeInteger(result.logicalOffset)) throw new Error("invalid picture result");
        const props = JSON.parse(doc.setPictureProperties!(at.section, result.paraIdx as number, result.controlIdx as number, JSON.stringify({ treatAsChar: true }))) as Record<string, unknown>;
        if (props.ok !== true) throw new Error("inline picture rejected");
        if (hwp && !insertedInlinePicture(doc, at.section, result.paraIdx as number, result.controlIdx as number)) throw new Error("inline picture not verified");
        return { section: at.section, paragraph: result.paraIdx as number, offset: result.logicalOffset as number };
      }, true, "other", null, !!at.cell || !!this.history, true) ? "inserted" : "failed";
    } catch { return "failed"; }
    finally { this.imageSelecting = false; if (this.owns(epoch)) this.emit(); }
  }

  /** Stage 3 drawing insertion at a collapsed body caret (not in a cell, header or note). */
  private canInsertShape(): boolean {
    const format = this.sessions.get(this.sessionId)?.format;
    const structural = format === "hwpx" || (format === "hwp" && this.structuralBlock() === null);
    return structural && !!this.doc?.createShapeControl && !!this.doc.getShapeProperties && !!this.doc.setShapeProperties
      && !!this.history && this.editable && !this.imeUnsettled && !this.uncertain && !this.hasSelection && !this.caret.cell
      && this.caret.paragraph < this.doc.getParagraphCount(this.caret.section)
      && this.pending === 0 && this.committingEpoch !== this.epoch && !this.objectSelection;
  }

  private insertShape(shapeType: "rectangle" | "ellipse" | "line" | "textbox"): boolean {
    const doc = this.doc;
    if (!this.canInsertShape() || !doc) return false;
    const at = this.caret;
    const before = doc.getParagraphCount(at.section);
    return this.mutate(() => {
      const textBox = shapeType === "textbox";
      const result = JSON.parse(doc.createShapeControl!(JSON.stringify({
        sectionIdx: at.section, paraIdx: at.paragraph, charOffset: at.offset, shapeType,
        width: 10800, height: shapeType === "line" ? 100 : 7200, treatAsChar: textBox, textWrap: "Square", horzOffset: 0, vertOffset: 0,
      }))) as { ok?: boolean; paraIdx?: unknown; controlIdx?: unknown };
      if (result.ok !== true || result.paraIdx !== at.paragraph || !Number.isSafeInteger(result.controlIdx)
        || doc.getParagraphCount(at.section) !== before) throw new Error("shape creation not verified");
      const address = [at.section, at.paragraph, result.controlIdx as number] as const;
      // RHWP's creation path leaves the packed wrap bits of a floating shape unsynchronised, so the
      // HWPX export would reopen with another wrap. Setting the same wrap through the property path
      // synchronises them (verified by the save path's reopen comparison).
      if (!textBox) {
        const synced = JSON.parse(doc.setShapeProperties!(...address, JSON.stringify({ textWrap: "Square" }))) as { ok?: boolean };
        if (synced.ok !== true) throw new Error("shape wrap not synchronised");
      } else if (this.sessions.get(this.sessionId)?.format === "hwp") {
        // HWP's pinned serializer reopens a new text box with Center vertical alignment (the
        // serialized list attribute 0x20), while the live constructor defaults it to Top. Keep
        // the live model aligned with that supported HWP representation before history capture.
        const synced = JSON.parse(doc.setShapeProperties!(...address, JSON.stringify({ tbVerticalAlign: "Center" }))) as { ok?: boolean };
        if (synced.ok !== true) throw new Error("text box alignment not synchronised");
      }
      const created = inspectRhwpShape(doc, address);
      if (!created || created.raw.width !== 10800 || created.textBox !== textBox
        || (!textBox && (created.raw.textWrap !== "Square" || created.raw.treatAsChar))) throw new Error("created shape not verified");
      if (this.sessions.get(this.sessionId)?.format === "hwp") {
        // HWP insertion is admitted only for body section 0. Prove the new control has one
        // unambiguous root-list owner and is exposed as the requested shape family before the
        // operation enters history. HWPX keeps its existing insertion path unchanged.
        const controls: unknown = JSON.parse(doc.getControls!());
        if (!Array.isArray(controls)) throw new Error("shape owners unavailable");
        const owners = controls.filter((value): value is Record<string, unknown> => !!value && typeof value === "object"
          && !Array.isArray(value) && value.list === 0 && value.para === at.paragraph && value.controlIndex === address[2]);
        if (owners.length !== 1 || owners[0]!.ctrlId !== "gso" || !owners[0]!.props || typeof owners[0]!.props !== "object") {
          throw new Error("shape owner not unique");
        }
        const owner = owners[0]!;
        const family = owner.userDesc;
        const ownerProps = owner.props as Record<string, unknown>;
        const familyMatches = shapeType === "textbox" ? created.textBox && (family === "사각형" || family === "글상자")
          : family === ({ rectangle: "사각형", ellipse: "타원", line: "직선" } as const)[shapeType];
        if (!familyMatches || ownerProps.Width !== created.raw.width || ownerProps.Height !== created.raw.height
          || (ownerProps.TreatAsChar === 1) !== created.raw.treatAsChar) throw new Error("shape family or owner geometry not verified");
        if (textBox) {
          const textBoxProps: unknown = JSON.parse(doc.getShapeProperties!(...address));
          if (!textBoxProps || typeof textBoxProps !== "object" || (textBoxProps as Record<string, unknown>).tbVerticalAlign !== "Center") {
            throw new Error("text box alignment not verified");
          }
        }
      }
      return { caret: at, anchor: at };
    }, true, "other", null, true, true);
  }

  private parameterState(): Pick<DocumentCommandSnapshot, "parameters" | "parameterReasons"> {
    const format = this.sessions.get(this.sessionId)?.format;
    const key = [
      this.modelVersion, RhwpEditorSession.positionKey(this.anchor), RhwpEditorSession.positionKey(this.caret), format,
      this.editable, this.imeUnsettled, this.uncertain, !!this.history, !!this.doc, this.pending, this.saving, this.committingEpoch === this.epoch, this.pages.length,
      this.structuralKey(), this.fontOwnerCurrent(), this.structureVersion, this.historyOff,
    ].join("|");
    if (this.parameterCache?.key === key) return this.parameterCache.value;
    const parameters: Partial<Record<ParameterCommandId, CommandParameterContext>> = {};
    const parameterReasons: NonNullable<DocumentCommandSnapshot["parameterReasons"]> = {};
    const structural = this.structuralFormat();
    if (structural && this.editable && this.doc?.createTable && this.doc.setTableProperties && !this.imeUnsettled && !this.uncertain && !this.hasSelection
      && (!this.caret.cell || this.canCreateNestedTable())
      && this.pending === 0 && this.committingEpoch !== this.epoch) parameters["insert.table"] = {};
    else parameterReasons["insert.table"] = format === "hwp" && (!this.doc?.createTable || !this.doc.setTableProperties) ? "engineUnsupported"
      : !structural ? this.structuralBlock()! : this.pending > 0 ? "pendingEdits" : "caretRequired";
    if (this.canInsertShape()) parameters["insert.shape"] = {};
    else parameterReasons["insert.shape"] = !(format === "hwpx" || format === "hwp") || !this.doc?.createShapeControl
      || !this.doc.getShapeProperties || !this.doc.setShapeProperties ? "engineUnsupported"
      : format === "hwp" && this.structuralBlock() ? this.structuralBlock()!
        : this.pending > 0 ? "pendingEdits" : "caretRequired";
    const usable = this.editable && !!this.doc && !!this.text && !this.imeUnsettled && !this.uncertain;
    // 장평·자간: HWPX, 그리고 엔진이 덧붙인 글자 모양 정리를 지원할 때 HWP(T012 Stage 5 — HWP 저장 규칙은 정리된 덧붙임만 받는다).
    const metricFormat = format === "hwpx" || (format === "hwp" && !!this.doc?.compactAppendedCharShapes);
    // A general-history session already admits and monitors snapshots for this
    // model. Metrics change a selected paragraph; formulas separately validate
    // bounded table geometry/dependencies. Compressed file size/page count are
    // not proxies for either operation's complexity. Keep the legacy limits for
    // an explicitly advanced-only timeline, which has no general-input admission.
    const limited = this.historyOff === "limit" || (this.advancedHistoryOnly
      && (this.advancedSourceLimited || this.pages.length > ADVANCED_MAX_PAGES));
    const pending = this.pending > 0 || this.committingEpoch === this.epoch;
    const ownership = this.options.format === true || !!(this.text?.hasCharShapeOwnership && this.doc?.charShapeCount
      && this.doc.compactAppendedCharShapes && this.doc.captureCharShapePrefix
      && this.doc.capturePublishingCharShapePrefix && this.doc.reconcileCharShapePrefix);
    const advanced = usable && !limited && !pending && !!this.history;
    if (limited || pending) {
      for (const command of ["hangul.charWidth", "hangul.charSpacing", "hangul.insertTableFormula"] as const)
        parameterReasons[command] = limited ? "limit" : "pendingEdits";
    }
    if (advanced && this.options.format !== false && metricFormat) {
      const [from, to] = this.ordered();
      if (this.hasSelection && sameContext(from, to) && paragraphOf(from) === paragraphOf(to)) {
        const api = from.cell?.nested ? this.doc?.applyCharFormatInCellByPath : from.cell ? this.doc?.applyCharFormatInCell : this.doc?.applyCharFormat;
        const charShape = api && ownership && this.text!.canDeleteRange(from, to) && (!from.cell?.nested || this.text!.formatSelection(from, to)) ? this.text!.charShape(from) : null;
        if (charShape) parameters["hangul.charWidth"] = parameters["hangul.charSpacing"] = { charShape };
      } else {
        parameterReasons["hangul.charWidth"] = parameterReasons["hangul.charSpacing"] = "selectionRequired";
      }
    }
    // Font mutation uses the same complete selected-text proof, history, original
    // preflight and save/IME ownership as general formatting. Collapsed edits are
    // deliberately unavailable; caret state is display-only.
    if (this.fontCreationOwned() && this.formatState()) {
      const font = this.fontState();
      if (font) parameters["format.font"] = { font };
    } else parameterReasons["format.font"] = this.hasSelection ? "engineUnsupported" : "selectionRequired";
    const page = this.stage1Page();
    for (const command of ["layout.margins", "layout.orientation", "layout.size"] as const) {
      if (page) parameters[command] = { page };
      else parameterReasons[command] = "engineUnsupported";
    }
    if (page && this.columnState(this.caret.section)) parameters["layout.columns"] = { page };
    else parameterReasons["layout.columns"] = "engineUnsupported";
    const paragraph = this.stage1Paragraph();
    if (paragraph) parameters["paragraph.settings"] = { paragraph };
    else parameterReasons["paragraph.settings"] = "caretRequired";
    if (paragraph && this.listRange()) parameters["paragraph.listStyle"] = { paragraph };
    else parameterReasons["paragraph.listStyle"] = "caretRequired";
    // Stage 1 character values: selected text (general formatting eligibility) or the next input at a collapsed caret.
    const chars = this.stage1Chars();
    for (const command of ["format.fontSize", "format.fontColor", "format.highlight"] as const) {
      if (chars) parameters[command] = { chars };
      else parameterReasons[command] = "engineUnsupported";
    }
    // HWP metrics/formatting additionally require the structural original proof (complete
    // baseline including nested tables, SAFE preflight) — the same rule as body cells.
    if ((this.caret.cell?.nested || this.anchor.cell?.nested) && format === "hwp" && !this.structuralFormat()) {
      for (const command of ["hangul.charWidth", "hangul.charSpacing"] as const) {
        delete parameters[command];
        parameterReasons[command] = "originalUnverified";
      }
    }
    if (usable) {
      const cell = this.caret.cell ? this.text!.tableCell(this.caret) : null;
      if (cell) {
        const context = { tableCell: { row: cell.row, col: cell.col, rows: cell.rows, cols: cell.cols } };
        parameters["hangul.tableFormula"] = context;
        if (advanced && ownership && this.doc?.validateTableFormulaAt && this.doc.insertTableFormulaAt && !this.hasSelection && !this.pending) {
          const formula = this.text!.existingFormula(this.caret);
          // A new HWP field changes the control inventory. It needs a complete
          // original structural proof; replacement of an existing formula keeps
          // the established unchanged-inventory path for legacy documents.
          // A new HWP field changes the control inventory: it needs a complete original structural proof
          // (nested cells additionally the SAFE original preflight, as for other nested structural edits).
          if (format === "hwp" && formula === null && (!this.hwpBaseline?.complete || (this.caret.cell?.nested && !this.structuralFormat())))
            parameterReasons["hangul.insertTableFormula"] = "originalUnverified";
          else parameters["hangul.insertTableFormula"] = formula === null ? context : { ...context, formula };
        }
      }
      else parameterReasons["hangul.tableFormula"] = parameterReasons["hangul.insertTableFormula"] = "notInTable";
    }
    // Ordinary cell split (Stage 2 Phase 2): the dialog context exists only when the command itself is available
    // for an unmerged cell; merged cells run the restore action without a dialog.
    if (this.tableOpState("splitCell") === null) {
      const split = this.ordinarySplitContext();
      if (split) parameters["table.splitCell"] = { tableSplit: split };
    }
    const cellFmt = this.cellFormattingState();
    if ("refusal" in cellFmt) {
      parameterReasons["table.shading"] = parameterReasons["table.borders"] = parameterReasons["table.alignment"]
        = parameterReasons["table.columnWidth"] = parameterReasons["table.rowHeight"] = cellFmt.refusal;
    } else {
      parameters["table.shading"] = { tableShading: cellFmt.tableShading };
      parameters["table.borders"] = { tableBorders: cellFmt.tableBorders };
      parameters["table.alignment"] = { tableAlignment: cellFmt.tableAlignment };
      parameters["table.columnWidth"] = { tableColumnWidth: cellFmt.tableColumnWidth };
      parameters["table.rowHeight"] = { tableRowHeight: cellFmt.tableRowHeight };
    }
    const layoutProps = this.tableMarginsAndPositioningState();
    if (layoutProps.cellMargins) parameters["table.cellMargins"] = { tableCellMargins: layoutProps.cellMargins };
    else if (layoutProps.cellMarginsRefusal) parameterReasons["table.cellMargins"] = layoutProps.cellMarginsRefusal;
    if (layoutProps.positioning) parameters["table.positioning"] = { tablePositioning: layoutProps.positioning };
    else if (layoutProps.positioningRefusal) parameterReasons["table.positioning"] = layoutProps.positioningRefusal;
    if (layoutProps.repeatHeader) parameters["table.repeatHeader"] = { tableRepeatHeader: layoutProps.repeatHeader };
    else if (layoutProps.repeatHeaderRefusal) parameterReasons["table.repeatHeader"] = layoutProps.repeatHeaderRefusal;
    if (layoutProps.rowBreak) parameters["table.rowBreak"] = { tableRowBreak: layoutProps.rowBreak };
    else if (layoutProps.rowBreakRefusal) parameterReasons["table.rowBreak"] = layoutProps.rowBreakRefusal;
    const value = { parameters, parameterReasons };
    this.parameterCache = { key, value };
    return value;
  }

  /**
   * 선택(한 문단 안)의 장평 또는 자간을 7개 언어 모두 같은 값으로 바꾼다(T012). 값은 실행 직전에 다시 검증하고, 글자 서식과 같이 한
   * 변경·한 실행 취소 단계로 `mutate`(기록 스냅숏 → 엔진 → 확정 대기열 → 다시 그리기)에 넣는다. 선택은 그대로 둔다.
   */
  private applyCharShape(args: Extract<DocumentCommandArgs, { command: "hangul.charWidth" | "hangul.charSpacing" }>): boolean {
    const context = this.parameterState().parameters?.[args.command];
    if (!context || !validateCommandArgs(args.command, args, context)) return false;
    const [from, to] = this.ordered();
    const caret = this.caret, anchor = this.anchor;
    this.history?.boundary();
    const applied = this.mutate(() => {
      this.text!.charShapeFormat(from, to, args.command === "hangul.charWidth" ? "ratios" : "spacings", args.percent);
      return { caret, anchor };
    }, true, "other", null, true);
    this.history?.boundary();
    return applied;
  }

  /**
   * 커서 셀 기준의 표 계산식을 읽기 전용으로 계산해 결과를 알린다(T012, 문서·revision·기록을 바꾸지 않음). 엔진의 셀 좌표·표 크기를
   * 다시 읽어 검증한 뒤 부른다. WASM trap이면 모듈 상태를 알 수 없어 편집을 멈춘다.
   */
  private evaluateFormula(args: Extract<DocumentCommandArgs, { command: "hangul.tableFormula" }>): CommandDispatch {
    const context = this.parameterState().parameters?.["hangul.tableFormula"];
    const cell = context?.tableCell;
    if (!cell || !validateCommandArgs(args.command, args, context)) return { accepted: false };
    const label = { key: "command.hangul.tableFormula" as const };
    let result: number | null;
    try {
      result = this.text!.evaluateFormula(this.caret, cell.row, cell.col, args.formula);
    } catch {
      this.uncertain = true;
      this.lastRoundTrip = null;
      this.modelVersion += 1;
      this.failEditing();
      return { accepted: false };
    }
    if (result === null) return { accepted: false, message: { key: "command.result.tableFormulaFailed", vars: { command: label } } };
    const shown = Number.isInteger(result) ? String(result) : String(Number(result.toPrecision(12)));
    return { accepted: true, message: { key: "command.result.tableFormula", vars: { command: label, formula: args.formula, result: shown } } };
  }

  private insertFormula(args: Extract<DocumentCommandArgs, { command: "hangul.insertTableFormula" }>): CommandDispatch {
    const context = this.parameterState().parameters?.[args.command];
    const cell = context?.tableCell;
    if (!cell || !validateCommandArgs(args.command, args, context)) return { accepted: false };
    let prepared;
    try { prepared = this.text!.prepareFormula(this.caret, cell.row, cell.col, args.formula); }
    catch {
      this.uncertain = true; this.lastRoundTrip = null; this.modelVersion += 1; this.failEditing();
      return { accepted: false };
    }
    if (!prepared) return { accepted: false, message: { key: "command.result.tableFormulaFailed", vars: { command: { key: "command.hangul.insertTableFormula" } } } };
    if (!prepared.changed) return { accepted: true };
    const caret = this.caret;
    this.history!.boundary();
    const applied = this.mutate(() => {
      this.text!.insertFormula(caret, cell.row, cell.col, args.formula, prepared);
      return { caret: { ...caret, offset: prepared.end }, anchor: { ...caret, offset: prepared.end } };
    }, true, "other", null, true);
    this.history?.boundary();
    return { accepted: applied };
  }

  private fontSourceSafe = false;
  private fontCache: { key: string; value: { family: string | null; documentFamilies?: readonly string[] } | null } | null = null;

  /** Full-selection family; collapsed display follows the engine's position
   * affinity (the run at the caret; an explicit end run wins at paragraph end). */
  private fontState(): { family: string | null; documentFamilies?: readonly string[] } | null {
    if (!this.doc || !this.text || this.status.kind !== "ready") return null;
    const [from, to] = this.ordered();
    const key = `${this.epoch}|${this.modelVersion}|${RhwpEditorSession.positionKey(from)}|${RhwpEditorSession.positionKey(to)}`;
    if (this.fontCache?.key !== key) {
      const value = this.hasSelection ? this.text.selectionFont(from, to)
        : (() => { const refs = this.text!.fontReferences(this.caret); return refs && refs.languageIndex !== null ? { family: refs.faces[refs.languageIndex]!.definition.name } : null; })();
      const table = documentFontTable(this.doc);
      this.fontCache = { key, value: value && { ...value, documentFamilies: table ? existingFontFamilies(table) : [] } };
    }
    return this.fontCache.value;
  }

  /** Font faces may be added to this document only under the format.font ownership proof. */
  private fontCreationOwned(): boolean {
    const original = this.hwpOriginal?.owner === this.originalOwner() ? this.hwpOriginal : null;
    return this.fontOwnerCurrent() && this.fontSourceSafe && original?.state === "safe" && !!this.text?.hasFontOwnership;
  }

  private fontOwnerCurrent(): boolean {
    const owner = this.sessions.get(this.sessionId);
    return this.sessions.snapshot().activeId === this.sessionId && owner?.engine === "rhwp"
      && owner.state === "ready" && owner.loadGeneration === this.generation && owner.revision === this.committed;
  }

  private applyFont(args: Extract<DocumentCommandArgs, { command: "format.font" }>): boolean {
    if (!this.fontOwnerCurrent() || !this.formatState() || !validateCommandArgs(args.command, args, this.parameterState().parameters?.[args.command])) return false;
    const [from, to] = this.ordered();
    const apply = this.text!.prepareFont(from, to, args.family.trim());
    if (apply === "unchanged") return true;
    if (!apply) return false;
    const caret = this.caret, anchor = this.anchor;
    this.history?.boundary();
    const applied = this.mutate(() => { apply(); return { caret, anchor }; }, true, "other", null, true, true);
    this.history?.boundary();
    return applied;
  }

  private formatSourceCache: { key: string; safe: boolean } | null = null;
  private formatCache: { key: string; value: ReturnType<RhwpText["formatSelection"]> } | null = null;

  /** Full-selection state; runtime checks are shared by ribbon, shortcuts and execution.
   * HWP additionally requires a complete reopen baseline and a SAFE owned original preflight. */
  private formatState(): Readonly<Record<CharFormatFlag, boolean>> | null {
    if (!(this.options.format ?? RHWP_FORMAT_DECLARED)) return null;
    const format = this.sessions.get(this.sessionId)?.format;
    if (format !== "hwp" && format !== "hwpx") return null;
    if (this.sessions.snapshot().activeId !== this.sessionId) return null;
    if (format === "hwp") {
      if (!this.structuralFormat()) return null;
      if (this.formatSourceCache?.key !== String(this.epoch) || !this.formatSourceCache.safe) return null;
    }
    if (!this.editable || !this.doc || !this.text || !this.history || this.imeUnsettled) return null;
    if (this.pending > 0 || this.committingEpoch === this.epoch || this.saving) return null;
    if (!this.text.hasCharShapeOwnership || !this.doc.compactAppendedCharShapes
      || !this.doc.capturePublishingCharShapePrefix || !this.doc.reconcileCharShapePrefix) return null;
    if (this.caret.cell?.nested ? !this.doc.getFormattingRunsByPath || !this.doc.applyCharFormatInCellByPath
      : !this.doc.getFormattingRuns || !(this.caret.cell ? this.doc.applyCharFormatInCell : this.doc.applyCharFormat)) return null;
    if (!this.hasSelection || !sameContext(this.anchor, this.caret)) return null;
    const [from, to] = this.ordered();
    const key = `${this.epoch}|${this.modelVersion}|${RhwpEditorSession.positionKey(this.anchor)}|${RhwpEditorSession.positionKey(this.caret)}`;
    if (this.formatCache?.key !== key) this.formatCache = { key, value: this.text.formatSelection(from, to) };
    return this.formatCache.value?.state ?? null;
  }

  /**
   * 선택 전체에 글자 서식을 켜거나 끈다(모두 켜져 있을 때만 끔). 한 변경·한 실행 취소 단계다: 앞뒤 타자 그룹과 섞이지 않게
   * 기록 경계를 두고 `mutate`(기록 before 스냅숏 → 엔진 → 확정 대기열 → 다시 그리기)로 바꾼다. 선택은 그대로 둔다.
   */
  private applyFormat(flag: CharFormatFlag): boolean {
    const state = this.formatState();
    if (!state) return false;
    const [from, to] = this.ordered();
    const apply = this.text!.prepareFlag(from, to, flag, this.formatCache?.value ?? null);
    if (!apply) return false;
    const caret = this.caret, anchor = this.anchor;
    this.history?.boundary();
    const applied = this.mutate(() => {
      apply();
      return { caret, anchor };
    }, true, "other", null, true);
    this.history?.boundary();
    return applied;
  }

  private canCreateNestedTable(): boolean {
    const c = this.caret.cell;
    // New tables are created only within the engine's reader envelope common to HWP/HWPX (MAX_CREATED_TABLE_DEPTH);
    // deeper existing paths stay addressable for editing up to MAX_TABLE_DEPTH.
    if (!c || c.textBox || c.caption || !this.doc?.createTableInCellByPath || !this.history || !this.ownsPosition(this.caret)
      || 1 + (c.nested?.length ?? 0) >= Math.min(MAX_TABLE_DEPTH, MAX_CREATED_TABLE_DEPTH)) return false;
    const format = this.sessions.get(this.sessionId)?.format;
    if (format !== "hwpx" && (format !== "hwp" || !this.structuralFormat() || !this.doc.getTablePropertiesByPath)) return false;
    // The engine validates control slots before constructing a child. Match that
    // precondition here so a normal unsupported host never opens a transaction.
    try {
      const raw = this.doc.getControls?.();
      const modelRaw = this.doc.getCursorModel?.();
      if (!raw || !modelRaw || raw.length + modelRaw.length > 16 * 1024 * 1024) return false;
      const controls = JSON.parse(raw) as { list: number; para: number }[];
      const model = JSON.parse(modelRaw) as { lists: { sectionIndex: number; hostListId: number; hostPara: number;
        controlIndex: number; cellIndex: number; listId: number; isCell: boolean }[] };
      let host = 0, para = c.parentParagraph;
      for (const level of [c, ...(c.nested ?? [])]) {
        const found = model.lists.filter(l => l.isCell && l.sectionIndex === this.caret.section
          && l.hostListId === host && l.hostPara === para && l.controlIndex === level.control && l.cellIndex === level.cell);
        if (found.length !== 1) return false;
        host = found[0]!.listId; para = level.cellParagraph;
      }
      return !controls.some(control => control.list === host && control.para === para);
    } catch { return false; }
  }

  private unlockedBodyGso(address: readonly [number, number, number] | undefined): string | undefined {
    const doc = this.doc;
    if (!address || !doc?.getControls) return undefined;
    try {
      const [section, para, control] = address;
      let globalPara = para;
      for (let s = 0; s < section; s++) globalPara += doc.getParagraphCount(s);
      const controls = JSON.parse(doc.getControls()) as { ctrlId?: string; userDesc?: string; list?: number; para?: number; controlIndex?: number; props?: { Lock?: unknown } }[];
      const matches = controls.filter(c => c.list === 0 && c.para === globalPara && c.controlIndex === control);
      const owner = matches[0];
      // RHWP emits numeric 0/1 from the common-object lock flag.
      if (matches.length === 1 && owner?.ctrlId === "gso" && owner.props?.Lock === 0) return owner.userDesc;
    } catch { /* An unreadable inventory cannot prove ownership or protection. */ }
    return undefined;
  }

  private isEditableHwpGso(address: readonly [number, number, number] | undefined, shapeOnly: boolean): boolean {
    const kind = this.unlockedBodyGso(address);
    return shapeOnly
      ? kind === "사각형" || kind === "타원" || kind === "직선" || kind === "다각형" || kind === "곡선"
      : kind === "그림";
  }

  private ownsHwpGsoCaption(address: readonly [number, number, number] | undefined, isShape: boolean): boolean {
    if (!address || address[0] !== 0 || !this.text) return false;
    return this.text.ownsPictureCaption({
      section: address[0],
      paragraph: address[1],
      offset: 0,
      cell: { parentParagraph: address[1], control: address[2], cell: isShape ? 65534 : 0, cellParagraph: 0, caption: true },
    });
  }

  /** Existing floating basic shapes in the same drawing plane of Section0. */
  private hwpShapeLayers(address: readonly [number, number, number] | undefined) {
    const doc = this.doc;
    if (!address || address[0] !== 0 || !doc?.getControls || !doc.getShapeProperties) return null;
    try {
      const count = doc.getParagraphCount(0);
      const controls = JSON.parse(doc.getControls()) as { list: number; para: number; controlIndex: number;
        ctrlId: string; userDesc: string; props?: { Lock?: number; TreatAsChar?: number } }[];
      const owners = controls.filter(c => c.list === 0 && c.para < count && c.ctrlId === "gso");
      if (owners.length < 2 || owners.length > 4096) return null;
      const ranks = new Map<string, number>();
      let wrap: string | undefined;
      for (const owner of owners) {
        if (!["사각형", "타원", "직선", "다각형", "곡선"].includes(owner.userDesc) || owner.props?.Lock !== 0
          || owner.props.TreatAsChar !== 0 || !Number.isSafeInteger(owner.para) || owner.para < 0
          || !Number.isSafeInteger(owner.controlIndex) || owner.controlIndex < 0) return null;
        const raw = JSON.parse(doc.getShapeProperties(0, owner.para, owner.controlIndex)) as Record<string, unknown>;
        if (raw.hasCaption !== false || "tbVerticalAlign" in raw || raw.treatAsChar !== false
          || typeof raw.zOrder !== "number" || !Number.isSafeInteger(raw.zOrder) || Math.abs(raw.zOrder) > 1_000_000
          || !["Square", "Tight", "Through", "TopAndBottom"].includes(String(raw.textWrap))
          || (wrap !== undefined && raw.textWrap !== wrap)) return null;
        wrap = String(raw.textWrap);
        const key = `${owner.para}/${owner.controlIndex}`;
        if (ranks.has(key)) return null;
        ranks.set(key, raw.zOrder);
      }
      const values = [...ranks.values()];
      const key = `${address[1]}/${address[2]}`;
      const current = ranks.get(key);
      return current === undefined || new Set(values).size !== values.length
        ? null : { ranks, key, current, min: Math.min(...values), max: Math.max(...values) };
    } catch { return null; }
  }

  private gsoFormatEditable(address: readonly [number, number, number] | undefined, shapeOnly: boolean): boolean {
    const format = this.sessions.get(this.sessionId)?.format;
    if (format === "hwpx") return true;
    return format === "hwp" && this.structuralFormat() && this.isEditableHwpGso(address, shapeOnly);
  }

  /** Stage 3 `object.edit` on the selected HWPX/HWP body picture (or shape / chart): one verified engine call, one history step. */
  private editObject(request: ObjectEditRequest): boolean {
    if (request.edit.kind === "pathPoint" || request.edit.kind === "pathVertex" || request.edit.kind === "pathSegment"
      || request.edit.kind === "groupChildFill") {
      return this.editAdvancedShape(request);
    }
    if (request.edit.kind === "captionSide") return this.editCaptionSide(request);
    if (this.selectedObject?.chartAddress) return this.editChart(request, this.selectedObject.chartAddress);
    if (this.selectedObject?.shapeAddress) return this.editShape(request, this.selectedObject.shapeAddress);
    if (this.selectedObject?.groupAddress) return this.editGroup(request, this.selectedObject.groupAddress);
    if (this.selectedObject?.cellPicture) {
      const cell = this.selectedObject.cellPicture;
      const { edit } = request, selected = this.objectSelection, doc = this.doc;
      if (!selected || !doc || !this.history || !objectEditMatches(request, selected)) return false;
      if (edit.kind === "bounds" && edit.x === undefined && edit.width !== undefined && edit.height !== undefined) {
        return this.resizePicture({ ...request, widthPt: edit.width, heightPt: edit.height });
      }
      if (this.sessions.get(this.sessionId)?.format !== "hwpx") return false;
      const beforeCell = this.readCellPicture(cell);
      const before = beforeCell?.picture, previous = selected.picture;
      if (!before || !previous || before.properties.widthPt !== previous.widthPt || before.properties.heightPt !== previous.heightPt) return false;
      let apply: (() => void) | null = null;
      if (edit.kind === "delete") {
        if (!doc.deleteCellPictureControlByPath) return false;
        apply = () => {
          const result = JSON.parse(doc.deleteCellPictureControlByPath!(cell.section, cell.paragraph, cell.path, cell.control)) as { ok?: boolean };
          if (result.ok !== true) throw new Error("cell picture deletion refused");
        };
      } else if (edit.kind === "crop" && doc.setCellPicturePropertiesByPath && before.original) {
        const amounts = [edit.left * before.original.width, edit.top * before.original.height, edit.right * before.original.width, edit.bottom * before.original.height].map(Math.round);
        const [cropLeft, cropTop, cropRight, cropBottom] = amounts as [number, number, number, number];
        if (JSON.stringify(amounts) === JSON.stringify(before.cropAmounts)) return false;
        apply = () => {
          const result = JSON.parse(doc.setCellPicturePropertiesByPath!(cell.section, cell.paragraph, cell.path, cell.control, JSON.stringify({ cropLeft, cropTop, cropRight, cropBottom }))) as { ok?: boolean };
          const afterCell = this.readCellPicture(cell);
          if (result.ok !== true || !afterCell || JSON.stringify(afterCell.picture.cropAmounts) !== JSON.stringify(amounts)
            || afterCell.picture.properties.widthPt !== previous.widthPt || afterCell.picture.properties.heightPt !== previous.heightPt) {
            throw new Error("cell picture crop did not verify");
          }
        };
      } else if (edit.kind === "altText" && doc.setCellPicturePropertiesByPath) {
        if (/["\\]/.test(edit.text) || edit.text.length > 256 || edit.text === (previous.description ?? "")) return false;
        apply = () => {
          const result = JSON.parse(doc.setCellPicturePropertiesByPath!(cell.section, cell.paragraph, cell.path, cell.control, JSON.stringify({ description: edit.text }))) as { ok?: boolean };
          const afterCell = this.readCellPicture(cell);
          if (result.ok !== true || !afterCell || (afterCell.picture.properties.description ?? "") !== edit.text
            || afterCell.picture.properties.widthPt !== previous.widthPt || afterCell.picture.properties.heightPt !== previous.heightPt) {
            throw new Error("cell picture altText did not verify");
          }
        };
      }
      if (!apply) return false;
      const savedSelection = this.selectedObject;
      this.selectedObject = null;
      const runApply = apply;
      const accepted = this.mutate(() => {
        runApply();
        return { caret: this.caret, anchor: this.anchor };
      }, true, "other", null, true, true);
      if (!accepted && this.status.kind === "ready") {
        this.selectedObject = savedSelection;
        this.emit();
      }
      return accepted;
    }
    const doc = this.doc, selected = this.objectSelection, address = this.selectedObject?.pictureAddress;
    if (!selected || !address || !doc || !objectEditMatches(request, selected) || !this.history
      || !this.gsoFormatEditable(address, false)) return false;
    const format = this.sessions.get(this.sessionId)?.format;
    const { edit } = request;
    if (edit.kind === "bounds" && edit.x === undefined) {
      if (edit.width === undefined || edit.height === undefined) return false;
      return this.resizePicture({ ...request, widthPt: edit.width, heightPt: edit.height });
    }
    const before = inspectRhwpPicture(doc, address);
    const previous = selected.picture;
    if (!before || !previous || before.properties.widthPt !== previous.widthPt || before.properties.heightPt !== previous.heightPt) return false;
    const same = (after: ReturnType<typeof inspectRhwpPicture>, keys: readonly ("size" | "description" | "wrap" | "crop")[]) =>
      !!after && (!keys.includes("size") || (after.properties.widthPt === previous.widthPt && after.properties.heightPt === previous.heightPt))
      && (!keys.includes("description") || after.properties.description === previous.description)
      && (!keys.includes("wrap") || after.properties.wrap === previous.wrap)
      && (!keys.includes("crop") || JSON.stringify(after.properties.crop) === JSON.stringify(previous.crop));
    const set = (props: Record<string, unknown>, verify: (after: ReturnType<typeof inspectRhwpPicture>) => boolean) => () => {
      const result = JSON.parse(doc.setPictureProperties!(...address, JSON.stringify(props))) as { ok?: boolean };
      if (result.ok !== true || !verify(inspectRhwpPicture(doc, address))) throw new Error("picture property did not verify");
    };
    let apply: () => void;
    if (edit.kind === "delete") {
      if (!doc.deletePictureControl || (format === "hwp" && !before.deletable && !this.ownsHwpGsoCaption(address, false))) return false;
      apply = () => {
        const result = JSON.parse(doc.deletePictureControl!(...address)) as { ok?: boolean };
        if (result.ok !== true) throw new Error("picture deletion refused");
      };
    } else if (!doc.setPictureProperties) {
      return false;
    } else if (edit.kind === "altText") {
      // RHWP reads JSON strings without escape handling: refuse characters it cannot carry verbatim.
      if (/["\\]/.test(edit.text) || edit.text.length > 256 || edit.text === (previous.description ?? "")) return false;
      apply = set({ description: edit.text }, after => same(after, ["size", "wrap", "crop"]) && (after!.properties.description ?? "") === edit.text);
    } else if (edit.kind === "wrap") {
      if (edit.wrap === previous.wrap) return false;
      const props = edit.wrap === "inline" ? { treatAsChar: true }
        : { treatAsChar: false, textWrap: HWPX_WRAPS[edit.wrap] };
      apply = set(props, after => same(after, ["size", "description", "crop"]) && after!.properties.wrap === edit.wrap);
    } else if (edit.kind === "crop") {
      const original = before.original;
      if (!original) return false;
      const amounts = [edit.left * original.width, edit.top * original.height, edit.right * original.width, edit.bottom * original.height].map(Math.round);
      const [cropLeft, cropTop, cropRight, cropBottom] = amounts as [number, number, number, number];
      if (JSON.stringify(amounts) === JSON.stringify(before.cropAmounts)) return false;
      apply = set({ cropLeft, cropTop, cropRight, cropBottom }, after => same(after, ["size", "description", "wrap"])
        && JSON.stringify(after!.cropAmounts) === JSON.stringify(amounts));
    } else if (edit.kind === "position") {
      if (!before.pagePlacement || this.unlockedBodyGso(address) !== "그림") return false;
      const index = POSITION_PRESETS.indexOf(edit.preset);
      const placement = {
        horzRelTo: "Page", vertRelTo: "Page",
        horzAlign: ["Left", "Center", "Right"][index % 3],
        vertAlign: ["Top", "Center", "Bottom"][Math.floor(index / 3)],
        horzOffset: 0, vertOffset: 0,
      };
      if (JSON.stringify(placement) === JSON.stringify(before.pagePlacement)) return false;
      apply = set(placement, after => same(after, ["size", "description", "wrap", "crop"])
        && JSON.stringify(after!.pagePlacement) === JSON.stringify(placement));
    } else if (edit.kind !== "bounds" && edit.kind !== "nudge") {
      // Shape formatting and chart/SmartArt model edits do not apply to RHWP pictures.
      return false;
    } else {
      // Move: frame units → HWPUNIT through the same layout sample as the stored size.
      if (edit.kind === "bounds" && (edit.width !== undefined || edit.height !== undefined)) return false;
      const movable = before.movable;
      if (!movable || selected.frame.width <= 0) return false;
      const perFrame = previous.widthPt * 100 / selected.frame.width;
      const dx = edit.kind === "nudge" ? edit.dx * 100 : (edit.x! - selected.frame.x) * perFrame;
      const dy = edit.kind === "nudge" ? edit.dy * 100 : (edit.y! - selected.frame.y) * perFrame;
      const horzOffset = movable.horzOffset + Math.round(dx), vertOffset = movable.vertOffset + Math.round(dy);
      const limit = 0x7fffffff;
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(horzOffset) > limit || Math.abs(vertOffset) > limit
        || (horzOffset === movable.horzOffset && vertOffset === movable.vertOffset)) return false;
      apply = set({ horzOffset, vertOffset }, after => same(after, ["size", "description", "wrap", "crop"])
        && after!.movable?.horzOffset === horzOffset && after!.movable!.vertOffset === vertOffset);
    }
    const savedSelection = this.selectedObject;
    this.selectedObject = null;
    const caret = this.caret, anchor = this.anchor;
    // A caret in the edited paragraph (or inside a deleted control's caption/cell) returns to the paragraph start.
    const owned = (at: DocPosition) => edit.kind === "delete" && at.section === address[0]
      && ((!at.cell && at.paragraph === address[1]) || at.cell?.parentParagraph === address[1])
      ? { section: at.section, paragraph: address[1], offset: 0 } : at;
    const accepted = this.mutate(() => {
      apply();
      return { caret: owned(caret), anchor: owned(anchor) };
    }, true, "other", null, true, true);
    if (!accepted && this.status.kind === "ready") {
      this.selectedObject = savedSelection;
      this.emit();
    }
    return accepted;
  }

  private editAdvancedShape(request: ObjectEditRequest): boolean {
    const selected = this.objectSelection, saved = this.selectedObject, doc = this.doc;
    if (!selected || !saved || !doc?.getShapeProperties || !this.history || this.imeUnsettled
      || !objectEditMatches(request, selected)) return false;
    const { edit } = request;
    const pathEdit = edit.kind === "pathPoint" || edit.kind === "pathVertex" || edit.kind === "pathSegment";
    if (!pathEdit && edit.kind !== "groupChildFill") return false;
    const address = pathEdit ? saved.shapeAddress : saved.groupAddress;
    if (!address || !this.gsoFormatEditable(address, pathEdit)) return false;
    const read = pathEdit ? inspectRhwpShapePath : inspectRhwpGroupFills;
    let apply: () => void;
    let refreshed: Pick<ObjectSelection, "shapePath" | "groupChildFills" | "curveTerminalLine" | "operations">;
    if (edit.kind === "pathPoint") {
      const path = selected.shapePath;
      const point = path?.points[edit.index];
      if (!path || !point || !doc.moveShapePathPoint || edit.x > path.width || edit.y > path.height
        || (edit.x === point.x && edit.y === point.y) || (path.closed && edit.index === path.points.length - 1)) return false;
      refreshed = { operations: selected.operations, shapePath: { ...path, points: path.points.map((p, index) =>
        index === edit.index || (path.closed && edit.index === 0 && index === path.points.length - 1)
          ? { ...p, x: edit.x, y: edit.y } : p) } };
      apply = () => doc.moveShapePathPoint!(...address, edit.index, edit.x, edit.y);
    } else if (edit.kind === "pathVertex") {
      const path = selected.shapePath;
      if (this.sessions.get(this.sessionId)?.format !== "hwpx" || path?.kind !== "polygon" || !path.closed
        || !doc.editPolygonVertex || !doc.canEditPolygonVertices?.(...address) || edit.index >= path.points.length - 1) return false;
      const points = path.points.slice(0, -1);
      if (edit.action === "insert") {
        if (points.length >= 256 || edit.x > path.width || edit.y > path.height) return false;
        points.splice(edit.index + 1, 0, { x: edit.x, y: edit.y, control: false });
        apply = () => doc.editPolygonVertex!(...address, edit.index, true, edit.x, edit.y);
      } else {
        if (points.length <= 3) return false;
        points.splice(edit.index, 1);
        apply = () => doc.editPolygonVertex!(...address, edit.index, false, 0, 0);
      }
      points.push(points[0]!);
      refreshed = { operations: selected.operations, shapePath: { ...path, points } };
    } else if (edit.kind === "pathSegment") {
      const path = selected.shapePath;
      const available = inspectRhwpCurveTerminalLine(doc, address);
      if (this.sessions.get(this.sessionId)?.format !== "hwp" || path?.kind !== "curve" || path.closed
        || !doc.editCurveTerminalLine || !available?.[edit.action]
        || available.append !== selected.curveTerminalLine?.append || available.remove !== selected.curveTerminalLine?.remove) return false;
      const points = path.points.slice();
      if (edit.action === "append") {
        const start = points[0]!, end = points[points.length - 1]!;
        if (edit.x > path.width || edit.y > path.height
          || [start, end].some(point => point.x === edit.x && point.y === edit.y)) return false;
        points.push({ x: edit.x, y: edit.y, control: false });
        apply = () => doc.editCurveTerminalLine!(...address, true, edit.x, edit.y);
      } else {
        points.pop();
        apply = () => doc.editCurveTerminalLine!(...address, false, 0, 0);
      }
      const curveTerminalLine = { append: points.length < 257, remove: points.at(-2)!.control === false };
      refreshed = { operations: selected.operations, shapePath: { ...path, points }, curveTerminalLine };
    } else {
      const children = selected.groupChildFills;
      const child = children?.find(item => item.index === edit.index);
      const color = edit.color.toUpperCase();
      if (!children || !child || !doc.setGroupChildFill || child.color === color) return false;
      refreshed = { operations: selected.operations, groupChildFills: children.map(item => item === child ? { ...item, color } : item) };
      apply = () => doc.setGroupChildFill!(...address, edit.index, hexToBgr(color));
    }
    let before: string;
    try { before = doc.getShapeProperties(...address); } catch { return false; }
    if (JSON.stringify(read(doc, address)) !== JSON.stringify(pathEdit ? selected.shapePath : selected.groupChildFills)) return false;
    const { caret, anchor } = this;
    this.selectedObject = null;
    const accepted = this.mutate(() => {
      apply();
      if (doc.getShapeProperties!(...address) !== before
        || JSON.stringify(read(doc, address)) !== JSON.stringify(refreshed.shapePath ?? refreshed.groupChildFills)) {
        throw new Error("advanced shape edit did not verify");
      }
      if (refreshed.curveTerminalLine) {
        const available = inspectRhwpCurveTerminalLine(doc, address);
        if (JSON.stringify(available) !== JSON.stringify(refreshed.curveTerminalLine)) {
          throw new Error("curve terminal line edit did not verify");
        }
      }
      if (pathEdit && refreshed.shapePath?.kind === "polygon") {
        const canEditVertices = refreshed.shapePath.closed && !!doc.editPolygonVertex && doc.canEditPolygonVertices?.(...address) === true;
        if (edit.kind === "pathVertex" && !canEditVertices) throw new Error("polygon vertex edit did not verify");
        if (canEditVertices !== selected.operations.includes("pathVertex")) {
          refreshed.operations = canEditVertices ? [...selected.operations, "pathVertex"]
            : selected.operations.filter(operation => operation !== "pathVertex");
        }
      }
      return { caret, anchor };
    }, true, "other", null, true, true);
    if (this.status.kind === "ready") {
      if (accepted) {
        this.selectedObject = { ...saved, model: this.modelVersion, layout: this.layoutVersion,
          selection: { ...selected, ...refreshed, epoch: ++this.objectEpoch, revision: this.committed + this.pending } };
      } else this.selectedObject = saved;
      this.emit();
    }
    return accepted;
  }

  private editCaptionSide(request: ObjectEditRequest): boolean {
    const { edit } = request;
    const selection = this.objectSelection, saved = this.selectedObject, doc = this.doc;
    const address = saved?.pictureAddress;
    if (edit.kind !== "captionSide" || !address || !selection || !doc?.setPictureProperties || !doc.getControls
      || this.imeUnsettled || !objectEditMatches(request, selection)
      || this.sessions.get(this.sessionId)?.format !== "hwpx" || this.unlockedBodyGso(address) !== "그림") return false;
    const before = readHwpxPictureCaption(doc, address);
    if (!before || before.side === edit.side || before.side !== selection.captionSide) return false;
    const controls = doc.getControls();
    const { caret, anchor } = this;
    this.selectedObject = null;
    const accepted = this.mutate(() => {
      const result = JSON.parse(doc.setPictureProperties!(...address, JSON.stringify({ hasCaption: true, captionDirection: edit.side })));
      const after = readHwpxPictureCaption(doc, address);
      if (result.ok !== true || !after || after.side !== edit.side || doc.getControls!() !== controls
        || JSON.stringify(after.props) !== JSON.stringify({ ...before.props, captionDirection: edit.side })
        || JSON.stringify(after.caption) !== JSON.stringify({ ...before.caption, direction: edit.side })) {
        throw new Error("caption placement did not preserve its owner or contents");
      }
      return { caret, anchor };
    }, true, "other", null, true, true);
    if (!accepted && this.status.kind === "ready") {
      this.selectedObject = saved;
      this.emit();
    }
    return accepted;
  }

  /** Stage 3 P3 `object.edit` on the selected HWPX/HWP body group container (outer geometry/wrap/delete). */
  private editGroup(request: ObjectEditRequest, address: readonly [number, number, number]): boolean {
    const doc = this.doc, selected = this.objectSelection;
    if (!selected || !doc?.setShapeProperties || !objectEditMatches(request, selected) || !this.history) return false;
    const format = this.sessions.get(this.sessionId)?.format;
    const allowed = format === "hwpx" || (format === "hwp" && this.structuralFormat() && this.unlockedBodyGso(address) === "그리기");
    if (!allowed) return false;
    const before = inspectRhwpGroup(doc, address);
    if (!before || selected.frame.width <= 0) return false;
    const { edit } = request;
    type Raw = typeof before.raw;
    const all: (keyof Raw)[] = ["width", "height", "horzOffset", "vertOffset", "treatAsChar", "textWrap", "description"];
    const except = (...keys: (keyof Raw)[]) => all.filter(key => !keys.includes(key));
    const unchanged = (after: Raw, keep: readonly (keyof Raw)[]) => keep.every(key => after[key] === before.raw[key]);
    let props: Record<string, unknown>, expect: Partial<Raw>, keep: (keyof Raw)[];
    let operation: (() => void) | null = null;
    switch (edit.kind) {
      case "delete":
        if (!doc.deleteShapeControl || (format !== "hwpx" && (format !== "hwp" || !before.groupFlatDeletable))) return false;
        operation = () => {
          const result = JSON.parse(doc.deleteShapeControl!(...address)) as { ok?: boolean };
          if (result.ok !== true) throw new Error("group deletion refused");
        };
        props = {}; expect = {}; keep = [];
        break;
      case "bounds":
        if (edit.x !== undefined) {
          if (!before.movable || edit.width !== undefined || edit.height !== undefined) return false;
          const perFrame = before.raw.width / selected.frame.width;
          const horzOffset = before.raw.horzOffset + Math.round((edit.x - selected.frame.x) * perFrame);
          const vertOffset = before.raw.vertOffset + Math.round((edit.y! - selected.frame.y) * perFrame);
          props = { horzOffset, vertOffset }; expect = props as Partial<Raw>; keep = except("horzOffset", "vertOffset");
        } else {
          if (edit.width === undefined || edit.height === undefined || (format === "hwp" && before.sizeProtected)) return false;
          const width = Math.round(edit.width * 100), height = Math.round(edit.height * 100);
          props = { width, height }; expect = { width, height }; keep = except("width", "height");
        }
        break;
      case "nudge": {
        if (!before.movable) return false;
        const horzOffset = before.raw.horzOffset + Math.round(edit.dx * 100), vertOffset = before.raw.vertOffset + Math.round(edit.dy * 100);
        props = { horzOffset, vertOffset }; expect = props as Partial<Raw>; keep = except("horzOffset", "vertOffset");
        break;
      }
      case "wrap":
        props = edit.wrap === "inline" ? { treatAsChar: true } : { treatAsChar: false, textWrap: HWPX_WRAPS[edit.wrap] };
        expect = edit.wrap === "inline" ? { treatAsChar: true } : { treatAsChar: false, textWrap: HWPX_WRAPS[edit.wrap] };
        keep = except("treatAsChar", "textWrap", "horzOffset", "vertOffset");
        break;
      default:
        return false;
    }
    if (!operation) {
      if (Object.entries(expect).every(([key, value]) => before.raw[key as keyof Raw] === value)) return false;
      operation = () => {
        const result = JSON.parse(doc.setShapeProperties!(...address, JSON.stringify(props))) as { ok?: boolean };
        const after = inspectRhwpGroup(doc, address);
        if (result.ok !== true || !after || !unchanged(after.raw, keep)
          || !Object.entries(expect).every(([key, value]) => after.raw[key as keyof Raw] === value)) throw new Error("group property did not verify");
      };
    }
    const savedSelection = this.selectedObject;
    this.selectedObject = null;
    const caret = this.caret, anchor = this.anchor;
    const owned = (at: DocPosition) => edit.kind === "delete" && at.section === address[0]
      && ((!at.cell && at.paragraph === address[1]) || at.cell?.parentParagraph === address[1])
      ? { section: at.section, paragraph: address[1], offset: 0 } : at;
    const apply = operation;
    const accepted = this.mutate(() => {
      apply();
      return { caret: owned(caret), anchor: owned(anchor) };
    }, true, "other", null, true, true);
    if (!accepted && this.status.kind === "ready") {
      this.selectedObject = savedSelection;
      this.emit();
    }
    return accepted;
  }

  /** Stage 3 B6/B7 `object.edit` (`chartData`) on the selected HWPX/HWP body OOXML chart: one verified engine call, one history step. */
  private editChart(request: ObjectEditRequest, address: readonly [number, number, number]): boolean {
    const doc = this.doc, selected = this.objectSelection;
    if (!selected || !doc?.setChartData || !objectEditMatches(request, selected) || !this.history) return false;
    const format = this.sessions.get(this.sessionId)?.format;
    if (format !== "hwpx" && !(format === "hwp" && this.structuralFormat() && this.unlockedBodyGso(address) === "OLE")) return false;
    const { edit } = request;
    if (edit.kind !== "chartData") return false;
    const before = this.readChart(address);
    if (!before || before.kind !== "chart" || selected.graphic?.kind !== "chart"
      || JSON.stringify(before) !== JSON.stringify(selected.graphic)) return false;
    if (edit.categories.length !== before.labels.length || edit.series.length !== before.series.length) return false;
    for (let si = 0; si < edit.series.length; si += 1) {
      const want = edit.series[si]!, orig = before.series[si]!;
      if (want.values.length !== before.labels.length || !want.values.every(v => typeof v === "number" && Number.isFinite(v))) return false;
      if (orig.name === null && want.name.trim() !== "") return false;
    }
    const payload = {
      structure: true,
      labels: edit.categories,
      series: edit.series.map((want, si) => {
        const orig = before.series[si]!;
        return {
          ...(orig.name !== null ? { name: want.name } : {}),
          values: want.values.map((v, vi) => {
            const prev = orig.values[vi];
            return prev !== null && prev !== undefined && Number(prev) === v ? prev : String(v);
          }),
        };
      }),
    };
    const preview = JSON.parse(doc.setChartData(...address, JSON.stringify({ ...payload, dryRun: true }))) as { ok?: boolean; changedCount?: number };
    if (preview.ok !== true || !(preview.changedCount && preview.changedCount > 0)) return false;

    const savedSelection = this.selectedObject;
    this.selectedObject = null;
    const caret = this.caret, anchor = this.anchor;
    const accepted = this.mutate(() => {
      const result = JSON.parse(doc.setChartData!(...address, JSON.stringify(payload))) as { ok?: boolean; changedCount?: number };
      const after = this.readChart(address);
      if (result.ok !== true || !(result.changedCount && result.changedCount > 0) || !after || after.kind !== "chart"
        || after.series.length !== edit.series.length
        || JSON.stringify(after.labels) !== JSON.stringify(edit.categories)
        || !edit.series.every((want, si) => {
          const got = after.series[si]!;
          const origName = before.series[si]!.name;
          return (origName === null || got.name === want.name)
            && want.values.every((v, vi) => got.values[vi] !== null && Number(got.values[vi]) === v);
        })) {
        throw new Error("chart data edit did not verify");
      }
      return { caret, anchor };
    }, true, "other", null, true, true);
    if (!accepted && this.status.kind === "ready") {
      this.selectedObject = savedSelection;
      this.emit();
    }
    return accepted;
  }

  /** Stage 3 P3 `object.edit` on the selected HWPX/HWP body shape/text box (outer object). */
  private editShape(request: ObjectEditRequest, address: readonly [number, number, number]): boolean {
    const doc = this.doc, selected = this.objectSelection;
    if (!selected || !doc?.setShapeProperties || !objectEditMatches(request, selected) || !this.history) return false;
    const format = this.sessions.get(this.sessionId)?.format;
    if (!this.gsoFormatEditable(address, true)) return false;
    const before = inspectRhwpShape(doc, address);
    if (!before || !selected.shape
      || before.properties.widthPt !== selected.shape.widthPt || before.properties.heightPt !== selected.shape.heightPt) return false;
    const { edit } = request;
    type Raw = typeof before.raw;
    // Fields that must stay exactly as they were for each edit (the edited ones are checked separately).
    const unchanged = (after: Raw, keep: readonly (keyof Raw)[]) => keep.every(key => after[key] === before.raw[key]);
    const all: (keyof Raw)[] = ["width", "height", "horzOffset", "vertOffset", "rotationAngle", "horzFlip", "vertFlip", "borderColor", "borderWidth", "fillType", "fillBgColor", "treatAsChar", "textWrap", "description"];
    const except = (...keys: (keyof Raw)[]) => all.filter(key => !keys.includes(key));
    let props: Record<string, unknown>, expect: Partial<Raw>, keep: (keyof Raw)[];
    let operation: (() => void) | null = null;
    switch (edit.kind) {
      case "delete":
        if (!doc.deleteShapeControl || (format === "hwp" && before.hasCaption && !this.ownsHwpGsoCaption(address, true))) return false;
        operation = () => {
          const result = JSON.parse(doc.deleteShapeControl!(...address)) as { ok?: boolean };
          if (result.ok !== true) throw new Error("shape deletion refused");
        };
        props = {}; expect = {}; keep = [];
        break;
      case "bounds": {
        if (edit.x !== undefined) {
          if (!before.movable || edit.width !== undefined || edit.height !== undefined || selected.frame.width <= 0) return false;
          const perFrame = before.raw.width / selected.frame.width;
          const horzOffset = before.raw.horzOffset + Math.round((edit.x - selected.frame.x) * perFrame);
          const vertOffset = before.raw.vertOffset + Math.round((edit.y! - selected.frame.y) * perFrame);
          props = { horzOffset, vertOffset }; expect = props as Partial<Raw>; keep = except("horzOffset", "vertOffset");
        } else {
          if (edit.width === undefined || edit.height === undefined || (format === "hwp" && before.sizeProtected)) return false;
          const width = Math.round(edit.width * 100), height = Math.round(edit.height * 100);
          props = { width, height }; expect = { width, height }; keep = except("width", "height");
        }
        break;
      }
      case "nudge": {
        if (!before.movable) return false;
        const horzOffset = before.raw.horzOffset + Math.round(edit.dx * 100), vertOffset = before.raw.vertOffset + Math.round(edit.dy * 100);
        props = { horzOffset, vertOffset }; expect = props as Partial<Raw>; keep = except("horzOffset", "vertOffset");
        break;
      }
      case "fill":
        if (!before.fillEditable) return false;
        props = edit.color === null ? { fillType: "none" } : { fillType: "solid", fillBgColor: hexToBgr(edit.color) };
        expect = edit.color === null ? { fillType: "none" } : { fillType: "solid", fillBgColor: hexToBgr(edit.color) };
        keep = except("fillType", "fillBgColor");
        break;
      case "outline": {
        if (edit.color === null) return false;
        const borderColor = hexToBgr(edit.color);
        if (edit.width === undefined) {
          props = expect = { borderColor };
          keep = except("borderColor");
        } else {
          const borderWidth = Math.round(edit.width * 100);
          if (!selected.shape.outlineWidthEditable || !before.solidOutline || !this.isEditableHwpGso(address, true)
            || edit.width < 0.01 || edit.width > 72 || !Number.isSafeInteger(borderWidth)) return false;
          props = expect = { borderColor, borderWidth };
          keep = except("borderColor", "borderWidth");
        }
        break;
      }
      case "rotate": {
        const degrees = Math.round(((edit.degrees % 360) + 360) % 360);
        props = { rotationAngle: degrees, horzFlip: edit.flipH, vertFlip: edit.flipV };
        expect = { rotationAngle: degrees, horzFlip: edit.flipH, vertFlip: edit.flipV };
        keep = except("rotationAngle", "horzFlip", "vertFlip", "width", "height", "horzOffset", "vertOffset");
        break;
      }
      case "wrap":
        props = edit.wrap === "inline" ? { treatAsChar: true } : { treatAsChar: false, textWrap: HWPX_WRAPS[edit.wrap] };
        expect = edit.wrap === "inline" ? { treatAsChar: true } : { treatAsChar: false, textWrap: HWPX_WRAPS[edit.wrap] };
        keep = except("treatAsChar", "textWrap", "horzOffset", "vertOffset");
        break;
      case "layer": {
        if (!doc.changeShapeZOrder || !selected.operations.includes("zOrder")) return false;
        const layers = format === "hwp" ? this.hwpShapeLayers(address) : null;
        if (format === "hwp" && !layers) return false;
        const edge = layers && (edit.front ? layers.max : layers.min);
        const next = edge === null ? null : edge + (edit.front ? 1 : -1);
        if (layers && (layers.current === edge || next === null || Math.abs(next) > 1_000_000)) return false;
        operation = () => {
          const result = JSON.parse(doc.changeShapeZOrder!(...address, edit.front ? "front" : "back")) as { ok?: boolean; moves?: unknown[] };
          if (result.ok !== true) throw new Error("z-order refused");
          if (!Array.isArray(result.moves) || result.moves.length === 0) throw new Error("z-order unchanged");
          const after = inspectRhwpShape(doc, address);
          if (!after || !unchanged(after.raw, all)) throw new Error("z-order changed other fields");
          if (layers) {
            const updated = this.hwpShapeLayers(address);
            if (!updated || updated.current !== next || updated.ranks.size !== layers.ranks.size
              || [...layers.ranks].some(([key, rank]) => key !== layers.key && updated.ranks.get(key) !== rank)) {
              throw new Error("z-order changed another shape");
            }
          }
        };
        props = {}; expect = {}; keep = [];
        break;
      }
      default:
        return false;
    }
    if (!operation) {
      if (Object.entries(expect).every(([key, value]) => before.raw[key as keyof Raw] === value)) return false;
      operation = () => {
        const result = JSON.parse(doc.setShapeProperties!(...address, JSON.stringify(props))) as { ok?: boolean };
        const after = inspectRhwpShape(doc, address);
        if (result.ok !== true || !after || !unchanged(after.raw, keep)
          || !Object.entries(expect).every(([key, value]) => after.raw[key as keyof Raw] === value)) throw new Error("shape property did not verify");
      };
    }
    const savedSelection = this.selectedObject;
    this.selectedObject = null;
    const caret = this.caret, anchor = this.anchor;
    const owned = (at: DocPosition) => edit.kind === "delete" && at.section === address[0]
      && ((!at.cell && at.paragraph === address[1]) || at.cell?.parentParagraph === address[1])
      ? { section: at.section, paragraph: address[1], offset: 0 } : at;
    const apply = operation;
    const accepted = this.mutate(() => {
      apply();
      return { caret: owned(caret), anchor: owned(anchor) };
    }, true, "other", null, true, true);
    if (!accepted && this.status.kind === "ready") {
      this.selectedObject = savedSelection;
      this.emit();
    }
    return accepted;
  }

  private readCellPicture(address: CellPictureAddress) {
    const doc = this.doc;
    const format = this.sessions.get(this.sessionId)?.format;
    if ((format !== "hwpx" && !(format === "hwp" && address.section === 0 && this.structuralFormat()))
      || !this.history || !doc?.getControls || !doc.getCursorModel
      || !doc.getCellPicturePropertiesByPath || !doc.setCellPicturePropertiesByPath) return null;
    const { section, paragraph, path, control } = address;
    try {
      const entries = JSON.parse(path) as { controlIndex: number; cellIndex: number; cellParaIndex: number }[];
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > 64) return null;
      const rawModel = doc.getCursorModel(), rawControls = doc.getControls();
      if (rawModel.length + rawControls.length > 8 * 1024 * 1024) return null;
      const { lists } = JSON.parse(rawModel) as { lists: { listId: number; isCell: boolean; hostListId: number;
        sectionIndex: number; hostPara: number; controlIndex: number; cellIndex: number }[] };
      const controls = JSON.parse(rawControls) as { list: number; para: number; controlIndex: number; ctrlId: string;
        userDesc: string; props?: { Lock?: number; TreatAsChar?: number } }[];
      let currentListId = 0;
      let currentPara = paragraph;
      for (let s = 0; s < section; s++) currentPara += doc.getParagraphCount(s);
      let localHostPara = paragraph;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        if (!entry || !Number.isSafeInteger(entry.controlIndex) || entry.controlIndex < 0
          || !Number.isSafeInteger(entry.cellIndex) || entry.cellIndex < 0
          || !Number.isSafeInteger(entry.cellParaIndex) || entry.cellParaIndex < 0) return null;
        const table = controls.filter(c => c.list === currentListId && c.para === currentPara && c.controlIndex === entry.controlIndex);
        if (table.length !== 1 || table[0]!.ctrlId !== "tbl" || table[0]!.props?.Lock !== 0) return null;
        if (format === "hwp" && i === 0 && table[0]!.props?.TreatAsChar !== 0) return null;
        const owners = lists.filter(l => l.isCell && l.hostListId === currentListId && l.sectionIndex === section
          && l.hostPara === localHostPara && l.controlIndex === entry.controlIndex && l.cellIndex === entry.cellIndex);
        if (owners.length !== 1) return null;
        currentListId = owners[0]!.listId;
        currentPara = entry.cellParaIndex;
        localHostPara = entry.cellParaIndex;
      }
      const child = controls.filter(c => c.list === currentListId && c.para === currentPara && c.controlIndex === control);
      if (child.length !== 1 || child[0]!.userDesc !== "그림" || child[0]!.props?.Lock !== 0) return null;
      const resource = cellPictureEvidence(doc, section, paragraph, path, control);
      const rawPicture = doc.getCellPicturePropertiesByPath(section, paragraph, path, control);
      if (format === "hwp") {
        const { rotationAngle, restrictInPage } = JSON.parse(rawPicture) as { rotationAngle?: unknown; restrictInPage?: unknown };
        // RHWP's picture JSON uses restrictInPage for the flow-with-text flag.
        // That flag can resize the owning cell as a side effect.
        if (child[0]!.ctrlId !== "gso" || rotationAngle !== 0 || restrictInPage !== false) return null;
      }
      const picture = inspectRhwpPicture({ getPictureProperties: () => rawPicture }, [section, paragraph, control]);
      return resource && picture?.deletable && (format !== "hwp" || picture.simpleInline)
        && resource.width === Math.round(picture.properties.widthPt * 100)
        && resource.height === Math.round(picture.properties.heightPt * 100)
        ? { picture, resource } : null;
    } catch { return null; }
  }

  private resizePicture(request: PictureResizeRequest): boolean {
    const doc = this.doc, selected = this.objectSelection, address = this.selectedObject?.pictureAddress;
    const cell = this.selectedObject?.cellPicture;
    if (!selected || !pictureResizeMatches(request, selected) || !doc || !this.history) return false;
    if (!cell && (!address || !doc.setPictureProperties || !this.gsoFormatEditable(address, false))) return false;
    const page = this.pages[selected.frame.page], previous = selected.picture;
    if (!page || !previous || ![request.widthPt, request.heightPt].every(side =>
      typeof side === "number" && Number.isFinite(side) && side >= 2 && side <= 4000)) return false;
    const width = Math.round(request.widthPt * 100), height = Math.round(request.heightPt * 100);
    // The frame and the stored dimensions belong to the same engine layout
    // sample. Using their ratio avoids treating CSS pixels as HWPUNIT.
    if (width * selected.frame.width / (previous.widthPt * 100) > page.width
      || height * selected.frame.height / (previous.heightPt * 100) > page.height
      || (width === Math.round(previous.widthPt * 100) && height === Math.round(previous.heightPt * 100))) return false;
    const cellBefore = cell ? this.readCellPicture(cell) : null;
    const before = cell ? cellBefore?.picture : inspectRhwpPicture(doc, address!);
    if (!before?.simpleInline || before.properties.widthPt !== previous.widthPt || before.properties.heightPt !== previous.heightPt) return false;
    const savedSelection = this.selectedObject;
    this.selectedObject = null;
    const accepted = this.mutate(() => {
      const payload = JSON.stringify({ width, height });
      const result = JSON.parse(cell
        ? doc.setCellPicturePropertiesByPath!(cell.section, cell.paragraph, cell.path, cell.control, payload)
        : doc.setPictureProperties!(...address!, payload)) as { ok?: boolean };
      const cellAfter = cell ? this.readCellPicture(cell) : null;
      if (cellBefore && (!cellAfter || JSON.stringify(cellAfter.resource) !== JSON.stringify({ ...cellBefore.resource, width, height }))) {
        throw new Error("cell picture resource or ownership changed");
      }
      const after = cell ? cellAfter?.picture : inspectRhwpPicture(doc, address!);
      if (result.ok !== true || !after?.simpleInline || after.properties.widthPt !== width / 100
        || after.properties.heightPt !== height / 100 || after.properties.description !== previous.description) {
        throw new Error("picture dimensions did not verify");
      }
      return { caret: this.caret, anchor: this.anchor };
    }, true, "other", null, true, true);
    if (!accepted && this.status.kind === "ready") {
      this.selectedObject = savedSelection;
      this.emit();
    }
    return accepted;
  }

  /** 명령을 이 세션에서 실행한다. 지금 상태로 다시 확인해 할 수 없으면(rhwp가 지원하지 않는 명령 포함) 아무것도 바꾸지 않는다. */
  execute(command: DocumentCommandId, args?: DocumentCommandArgs): CommandDispatch {
    // 레지스트리 가용성(엔진 지원 표 포함)을 실행 직전에 다시 확인한다. rhwp 실행 취소는 그 표가 지원으로 바뀌기 전에는 오지 않는다.
    if (!documentCommandState(command, this.snapshot()).available) return { accepted: false };
    if (command === "picture.size") return { accepted: args?.command === command && this.resizePicture(args) };
    if (command === "object.edit") return { accepted: args?.command === command && this.editObject(args) };
    if (command === "insert.shape") {
      if (args?.command !== command || !validateCommandArgs(command, args, this.snapshot().parameters?.[command])) return { accepted: false };
      return { accepted: this.insertShape(args.kind) };
    }
    if (command === "insert.textBox") return { accepted: args === undefined && this.insertShape("textbox") };
    if (command === "object.deselect") {
      if (args !== undefined) return { accepted: false };
      this.selectedObject = null;
      this.clipboardVersion += 1;
      this.emit();
      return { accepted: true };
    }
    if (command === "paragraph.bullets") return args === undefined ? { accepted: this.toggleBullets() } : { accepted: false };
    if (command === "table.shading" || command === "table.borders" || command === "table.alignment"
      || command === "table.columnWidth" || command === "table.rowHeight") {
      if (args?.command !== command) return { accepted: false };
      return { accepted: this.applyCellFormatting(args) };
    }
    if (command === "table.cellMargins") {
      if (args?.command !== "table.cellMargins") return { accepted: false };
      return { accepted: this.applyCellMargins(args) };
    }
    if (command === "table.positioning") {
      if (args?.command !== "table.positioning") return { accepted: false };
      return { accepted: this.applyTablePositioning(args) };
    }
    if (command === "table.repeatHeader") {
      if (args?.command !== "table.repeatHeader") return { accepted: false };
      return { accepted: this.applyRepeatHeader(args) };
    }
    if (command === "table.rowBreak") {
      if (args?.command !== "table.rowBreak") return { accepted: false };
      return { accepted: this.applyRowBreak(args) };
    }
    if (command === "table.splitCell") {
      // Ordinary cells: explicit validated dimensions from the shared split dialog. Merged cells: restore without
      // arguments. Each form is refused in the other state, so a stale request never changes a different cell shape.
      const context = this.snapshot().parameters?.["table.splitCell"];
      if (args === undefined) return { accepted: !context?.tableSplit && this.applyTableOp("splitCell") };
      if (args.command !== command || !validateCommandArgs(command, args, context)) return { accepted: false };
      return { accepted: this.applyTableOp("splitCell", { rows: args.rows, columns: args.columns }) };
    }
    if (command.startsWith("table.")) {
      const op = TABLE_STRUCTURE_OPS.find(candidate => `table.${candidate}` === command);
      return { accepted: !!op && args === undefined && this.applyTableOp(op) };
    }
    if (command === "insert.table") {
      if (args?.command !== command || !validateCommandArgs(command, args, this.snapshot().parameters?.[command]) || !this.doc?.createTable || !this.doc.setTableProperties) return { accepted: false };
      const at = this.caret, doc = this.doc, hwp = this.sessions.get(this.sessionId)?.format === "hwp";
      if (at.cell) {
        if (!this.canCreateNestedTable()) return { accepted: false };
        return { accepted: this.mutate(() => {
          const value = JSON.parse(doc.createTableInCellByPath!(at.section, at.cell!.parentParagraph,
            pathJson(at.cell!), at.offset, args.rows, args.cols)) as Record<string, unknown>;
          if (value.ok !== true || !Number.isSafeInteger(value.controlIdx) || (value.controlIdx as number) < 0)
            throw new Error("nested table creation rejected");
          const cell = { ...at.cell!, nested: [...(at.cell!.nested ?? []),
            { control: value.controlIdx as number, cell: 0, cellParagraph: 0 }] };
          const next = { ...at, offset: 0, cell };
          if (!this.text!.ownsNestedCell(next) || !this.text!.caret(next)) throw new Error("nested table ownership or layout not proven");
          const grid = readTableGrid(doc, { section: at.section, paragraph: at.paragraph, control: value.controlIdx as number, path: cell });
          if (typeof grid === "string" || grid.rows !== args.rows || grid.cols !== args.cols || grid.cells.length !== args.rows * args.cols)
            throw new Error("nested table geometry differs");
          // HWP: only the basic inline form proven by the T009 nested-table rule is admitted.
          if (hwp && !insertedNestedTable(doc, at.section, cell.parentParagraph, JSON.parse(pathJson(cell)), args.rows, args.cols))
            throw new Error("nested table normalization not verified");
          return next;
        }, true, "other", null, true) };
      }
      return { accepted: this.mutate(() => {
        const result: unknown = JSON.parse(doc.createTable!(at.section, at.paragraph, at.offset, args.rows, args.cols));
        if (!result || typeof result !== "object") throw new Error("invalid table result");
        const value = result as Record<string, unknown>;
        if (value.ok !== true || !Number.isSafeInteger(value.paraIdx) || (value.paraIdx as number) < 0
          || !Number.isSafeInteger(value.controlIdx) || (value.controlIdx as number) < 0) throw new Error("invalid table result");
        // createTable leaves attr/common wrapping bits inconsistent. Reapply the
        // engine's own default through its property API so reopen is identical.
        const props = JSON.parse(doc.setTableProperties!(at.section, value.paraIdx as number, value.controlIdx as number,
          JSON.stringify(hwp ? HWP_TABLE_NORMALIZATION : { textWrap: "TopAndBottom" }))) as Record<string, unknown>;
        if (props.ok !== true) throw new Error("table properties rejected");
        if (hwp && !insertedBasicTable(doc, at.section, value.paraIdx as number, value.controlIdx as number, args.rows, args.cols))
          throw new Error("table normalization not verified");
        return { section: at.section, paragraph: value.paraIdx as number, offset: 0,
          cell: { parentParagraph: value.paraIdx as number, control: value.controlIdx as number, cell: 0, cellParagraph: 0 } };
      }) };
    }
    if (command === "hangul.insertTableFormula") return args?.command === command ? this.insertFormula(args) : { accepted: false };
    if (command === "hangul.charWidth" || command === "hangul.charSpacing" || command === "hangul.tableFormula") {
      if (args?.command !== command) return { accepted: false };
      if (args.command === "hangul.tableFormula") return this.evaluateFormula(args);
      const applied = this.applyCharShape(args);
      return applied ? { accepted: true } : { accepted: false };
    }
    if (command === "format.font") return { accepted: args?.command === command && this.applyFont(args) };
    const stage1 = this.executeStage1Chars(command, args) ?? this.executeStage1Paragraph(command, args) ?? this.executeStage1Page(command, args)
      ?? this.executeStage1List(command, args);
    if (stage1 !== null) return { accepted: stage1 };
    if (args !== undefined) return { accepted: false };
    if (command === "edit.undo" || command === "edit.redo") return { accepted: command === "edit.undo" ? this.undo() : this.redo() };
    const flag = FORMAT_FLAG[command];
    if (flag) return { accepted: this.applyFormat(flag) };
    if (command !== "file.save") return { accepted: false };
    void this.save().catch(reportDetachedSaveRejection);
    return { accepted: true };
  }

  // ---- 저장(T009) ----

  private setSave(state: SaveState) {
    this.saveState = state;
    this.emit();
  }

  /** 지금 저장을 시작할 수 없는 이유(없으면 null). */
  /**
   * PDF export (Stage 5-A S5-4): paint every page of the current model (pdfCapture.ts) and let the backend write the
   * PDF to `destination`. Only from a settled model (no IME transaction, no pending commit, not uncertain/closing);
   * any model, load or revision change during capture refuses the export (nothing written). Never changes the
   * model, history, revision, dirty state or save state. The PDF pages are images (no selectable text).
   */
  async exportPdf(destination: string, overwriteGrant: string | null = null, createCanvas?: () => HTMLCanvasElement, encode?: EncodePng): Promise<Result<PdfExported>> {
    const blocker = this.saveBlocker();
    if (blocker) return { ok: false, error: blocker };
    if (!this.backend.exportPdf) return { ok: false, error: { code: "Protocol" } };
    const doc = this.doc!;
    const { epoch, generation, committed, modelVersion } = this;
    const stillCurrent = () => this.doc === doc && this.epoch === epoch && this.generation === generation
      && this.committed === committed && this.modelVersion === modelVersion && this.saveBlocker() === null;
    const captured = await capturePdfPages(doc, this.pages.slice(), stillCurrent, createCanvas, encode);
    if (!captured.ok) return { ok: false, error: { code: "PdfExportUnavailable", reason: captured.reason } };
    return this.backend.exportPdf(this.sessionId, generation, committed, destination, captured.pages, overwriteGrant);
  }

  private saveBlocker(): DocumentError | null {
    if (this.status.kind !== "ready" || !this.doc || !this.module || this.closing) return { code: "SaveNotReady", reason: "state" };
    if (this.uncertain) return { code: "SaveNotReady", reason: "uncertain" };
    if (this.imeUnsettled) return { code: "SaveNotReady", reason: "composing" };
    if (this.pending > 0 || this.committingEpoch === this.epoch) return { code: "SaveNotReady", reason: "pending" };
    return null;
  }

  /**
   * 사용자가 요청한 보존 사전 검사. 저장 중이면 하지 않는다(`SaveInProgress`). 진행·실패를 저장 결과 자리에 보이며, 더 새
   * 검사·저장·다시 불러오기·닫기가 있었으면 늦게 끝난 이 결과는 상태를 바꾸지 않는다.
   */
  async checkSave(): Promise<Result<SaveCheck>> {
    if (this.saving) return { ok: false, error: { code: "SaveInProgress", sessionId: this.sessionId } };
    const { epoch } = this;
    const serial = ++this.checkSerial;
    this.setSave({ kind: "checking" });
    const checked = await this.preflight(serial);
    if (this.owns(epoch) && serial === this.checkSerial) {
      // 안전을 다시 확인하지 못한 검사 뒤에는 이전의 safe 판정으로 저장을 시작하지 않는다.
      if (!checked.ok) { this.saveCheck = null; this.recordOriginalCheck(checked); }
      this.setSave(checked.ok ? { kind: "idle" } : { kind: "failed", error: checked.error });
    }
    return checked;
  }

  /**
   * 보존 사전 검사: 백엔드가 확인한 원본 바이트를 새 WASM 문서로 열어(편집 모델과 무관) 편집 없이 같은 형식으로 내보내고,
   * 그 출력과 손실 보고를 백엔드가 원본과 비교한다. 결과는 `serial`이 아직 지금 요청일 때만 이 시도에 대해 기억한다.
   *
   * 오류 우선순위: 내보내기 실패가 주 오류이고(EngineFailure export), 정리 실패는 `saveCleanupErrors`에 따로 남긴다. 내보내기는
   * 됐는데 해제만 실패하면 그 출력을 쓰지 않고 SaveNotReady(uncertain)로 끝낸다. 두 해제는 서로 막지 않으며, 해제 실패는 WASM 모듈을
   * 믿을 수 없게 하므로 편집 모델도 멈춘다(saveCleanupFailed). 아직 아무것도 쓰지 않은 단계이므로 백엔드 전송 거부는 Protocol 결과로
   * 바꾼다(reportFailure와 같은 규칙, 원본 거부는 `saveTransportErrors`).
   */
  private async preflight(serial: number): Promise<Result<SaveCheck>> {
    const blocker = this.saveBlocker();
    if (blocker && blocker.code === "SaveNotReady" && blocker.reason === "state") return { ok: false, error: blocker };
    const module = this.module!;
    const format = this.sessions.get(this.sessionId)?.format;
    if (format !== "hwp" && format !== "hwpx") return { ok: false, error: { code: "SaveNotReady", reason: "state" } };
    const { epoch, generation } = this;
    const stale = { ok: false, error: { code: "StaleSession", sessionId: this.sessionId } } as const;
    const rejected = (error: unknown): Result<SaveCheck> => {
      this.saveTransportErrors.push(error);
      return this.owns(epoch) ? { ok: false, error: { code: "Protocol" } } : stale;
    };
    let original: Awaited<ReturnType<DocumentBackend["original"]>>;
    try {
      original = await this.backend.original(this.sessionId, generation);
    } catch (error) {
      return rejected(error);
    }
    if (!this.owns(epoch)) return stale;
    if (!original.ok) return original;
    // 기다리는 동안 더 앞선 검사의 정리 실패 등으로 멈춘 모듈에 문서를 새로 열지 않는다.
    if (this.status.kind !== "ready") return { ok: false, error: { code: "SaveNotReady", reason: "state" } };
    let unedited: Uint8Array | null = null;
    let contentLoss: unknown;
    let fresh: RhwpDocument | null = null;
    let exported: ReturnType<RhwpDocument["exportHwpWithReport"]> | null = null;
    try {
      fresh = module.openDocument(original.value);
      exported = format === "hwp" ? fresh.exportHwpWithReport() : fresh.exportHwpxWithReport();
      try {
        contentLoss = JSON.parse(exported.contentLoss());
      } catch {
        contentLoss = null;
      }
      unedited = exported.takeBytes();
    } catch {
      // unedited가 null로 남는다: 아래에서 내보내기 실패로 끝난다(해제를 먼저 시도한다).
    }
    const cleanupErrors: unknown[] = [];
    for (const owner of [exported, fresh]) {
      try { owner?.free(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) {
      const error: DocumentError = unedited ? { code: "SaveNotReady", reason: "uncertain" } : { code: "EngineFailure", engine: "rhwp", stage: "export" };
      // 구독자는 편집 멈춤 알림 안에서 동기로 세션을 닫거나 새 검사를 시작할 수 있다. 두 자원을 모두 놓은 뒤 한 번만 알린다.
      this.saveCleanupErrors.push(...cleanupErrors.slice(0, -1));
      const invalidated = this.checkSerial + 1;
      this.saveCleanupFailed(cleanupErrors.at(-1), epoch);
      if (!this.owns(epoch)) return stale;
      // 이 실패가 스스로 올린 번호라면 checkSave는 이 결과를 보이지 않으므로 여기서 진행 표시를 끝낸다. 번호가 더 올랐으면 알림 안에서
      // 시작한 새 검사의 자리다. 이 시도가 이미 최신이 아니었어도 실패는 지금 모델의 것이므로 번호로 시도를 비교하지 않는다.
      if (this.checkSerial === invalidated) this.setSave({ kind: "failed", error });
      return { ok: false, error };
    }
    if (!unedited) return { ok: false, error: { code: "EngineFailure", engine: "rhwp", stage: "export" } };
    let checked: Result<SaveCheck>;
    try {
      checked = await this.backend.preflight(this.sessionId, generation, unedited, contentLoss);
    } catch (error) {
      return rejected(error);
    }
    if (!this.owns(epoch)) return { ok: false, error: { code: "StaleSession", sessionId: this.sessionId } };
    if (checked.ok && serial === this.checkSerial) {
      this.saveCheck = { generation, check: checked.value };
      this.recordOriginalCheck(checked);
      this.emit();
    }
    return checked;
  }

  /**
   * 원본 형식으로 저장한다(T009). 확정한 판(백엔드 revision)만 저장한다: 확정을 기다리는 편집·조합·불확실한 모델이 있으면
   * 시작하지 않는다. 이 원본의 사전 검사가 없으면 먼저 한다(safe가 아니면 저장하지 않음). 내보낸 뒤 다시 열어 비교한 결과와
   * 손실 보고를 함께 보내고, 백엔드가 원본을 다시 확인해 교체한다. 저장 중에도 편집은 이어 갈 수 있으며, 그 편집은 저장한
   * 판 뒤의 것이라 저장하지 않은 편집으로 남는다.
   */
  async save(destination?: string): Promise<Result<SaveOutcome>> {
    const fail = (error: DocumentError): Result<SaveOutcome> => {
      if (this.owns(epoch)) this.setSave({ kind: "failed", error });
      return { ok: false, error };
    };
    const epoch = this.epoch;
    // A recovery checkpoint holds the backend save slot briefly; an explicit save waits for it, then rechecks.
    if (this.recoveryJob) {
      await this.recoveryJob.catch(() => undefined);
      if (!this.owns(epoch)) return { ok: false, error: { code: "StaleSession", sessionId: this.sessionId } };
    }
    if (this.saving) return { ok: false, error: { code: "SaveInProgress", sessionId: this.sessionId } };
    const blocker = this.saveBlocker();
    if (blocker) return fail(blocker);
    const format = this.sessions.get(this.sessionId)?.format;
    if (format !== "hwp" && format !== "hwpx") return fail({ code: "SaveNotReady", reason: "state" });
    this.clipboardVersion += 1;
    this.saving = true;
    let releaseShapes: (() => void) | undefined;
    try {
      const generation = this.generation;
      let check = this.saveCheck?.generation === generation ? this.saveCheck.check : null;
      // The HWP eligibility probe already ran this preflight for the current original: reuse its SAFE verdict.
      const original = this.hwpOriginal?.owner === this.originalOwner() ? this.hwpOriginal : null;
      if (!check && original?.state === "safe" && original.check && original.serial === this.checkSerial) check = original.check;
      if (!check) {
        this.setSave({ kind: "checking" });
        const checked = await this.preflight(++this.checkSerial);
        if (!checked.ok) return fail(checked.error);
        check = checked.value;
      }
      const blocked = blockedBy(check);
      if (blocked) return fail(blocked);
      // 사전 검사를 기다리는 사이 편집이 있었을 수 있다: 지금 확정한 판으로 다시 확인한다.
      const later = this.saveBlocker();
      if (later) return fail(later);
      const revision = this.committed;
      this.setSave({ kind: "saving" });
      const exported = this.exportAndCompare(format, "publish");
      releaseShapes = exported?.releaseShapes;
      if (!exported?.bytes) return fail({ code: "SaveFailure", stage: "export", ...(exported?.formulaCache ? { reason: "formulaCache" as const } : {}) });
      let result: Result<SaveOutcome>;
      try {
        result = await this.backend.save(this.sessionId, generation, revision, exported.bytes, exported.contentLoss, exported.reopen, destination, exported.preview);
      } catch (error) {
        // Transport rejection has no known publication outcome: report it as Protocol
        // (not a failed write or a kept original), re-check before any retry, and leave
        // the rejection to this call's owner while releasing the state and owned lease.
        this.saveTransportErrors.push(error);
        if (this.owns(epoch)) {
          this.checkSerial += 1;
          this.saveCheck = null;
          // The original may or may not have been replaced: HWP structural eligibility is re-established.
          this.originalSerial += 1;
          this.hwpOriginal = null;
          this.probeHwpOriginal();
        }
        fail({ code: "Protocol" });
        throw error;
      }
      if (!this.owns(epoch)) return result;
      if (!result.ok) return fail(result.error);
      const published = result.value;
      // 여기부터 게시는 끝난 사실이다. 이 모델을 아직 소유할 때만 표시를 바꾸고, 잃었으면 결과만 돌려준다(남은 prefix는 놓은 쪽이 해제했다).
      this.notifyAfterSaveResult(() => this.sessions.applyUpdate(published.session));
      if (!this.owns(epoch)) return result;
      // 저장하는 동안 시작해 아직 끝나지 않은 IME 트랜잭션(기다림 포함)의 글자는 이 저장에 없다.
      const changedSince = this.localRevision !== revision || this.imeUnsettled;
      // 저장한 판 뒤에 편집이 없고 교체의 내구성까지 확인했으면 이 모델은 디스크의 파일과 같다(닫기·다시 불러오기에 버리기
      // 확인이 필요 없음). 내구성을 확인하지 못했으면(교체는 됨) 저장하지 않은 편집으로 남긴다(백엔드도 dirty로 둔다).
      try {
        this.text?.markPublishedCharShapes(exported.charShapeCount);
        if (typeof this.doc?.borderFillCount === "function") this.borderFillBaseline = this.doc.borderFillCount();
      }
      catch (error) { this.notifyAfterSaveResult(() => this.saveCleanupFailed(error, epoch)); }
      if (!this.owns(epoch)) return result;
      if (!changedSince && published.durable) this.modified = false;
      // 원본이 바뀌었다: 다음 저장은 새 원본으로 다시 검사한다. 그 전에 시작한 검사의 늦은 결과도 버린다.
      this.checkSerial += 1;
      this.saveCheck = null;
      this.originalSerial += 1;
      this.hwpOriginal = null;
      this.notifyAfterSaveResult(() => this.setSave({ kind: "saved", revision, durable: published.durable, changedSince }));
      if (this.owns(epoch)) this.probeHwpOriginal();
      return result;
    } finally {
      try { releaseShapes?.(); }
      catch (error) { this.notifyAfterSaveResult(() => this.saveCleanupFailed(error, epoch)); }
      finally {
        this.saving = false;
        // Every earlier notification of this save ran while `saving` was still true. Announce the settled
        // state (success, failure, transport rejection, cleanup failure) so observers such as recovery
        // checkpoint scheduling re-evaluate it — only while this save still owns the model: a reload or
        // close already notified and invalidated it. Subscriber exceptions never replace the save result.
        if (this.owns(epoch)) this.notifyAfterSaveResult(() => this.emit());
      }
    }
  }

  // ---- 복구 체크포인트(T014 B) ----

  private recoveryJob: Promise<Result<SaveOutcome>> | null = null;

  /** Cheap readiness view for checkpoint scheduling (no WASM calls; runs on every model change). */
  checkpointState(): { loaded: boolean; composing: boolean; pending: boolean; saving: boolean; revision: number; loadGeneration: number } {
    return {
      loaded: this.status.kind === "ready" && this.doc !== null && !this.closing && !this.disposed && !this.uncertain,
      composing: this.imeUnsettled,
      // pending counts every uncommitted change until its commit response arrives. The post-commit emit runs
      // while the commit loop is still unwinding (committingEpoch), so that flag is not used for scheduling;
      // runCheckpoint rechecks the full saveBlocker when the job actually starts.
      pending: this.pending > 0,
      saving: this.saving,
      revision: this.committed,
      loadGeneration: this.generation,
    };
  }

  /**
   * Durable private recovery record of the committed revision `revision` (T014 B). Same preconditions,
   * preflight, strict export/reopen evidence and HWP preview raster as Save, but the backend only validates
   * and writes a create-only recovery record: no save state, dirty flag, published char-shape lease,
   * session path or original file changes here. Rechecks ownership/IME/pending/revision after every await.
   */
  checkpoint(revision: number = this.committed): Promise<Result<SaveOutcome>> {
    if (this.recoveryJob) return this.recoveryJob;
    const job = this.runCheckpoint(revision).finally(() => {
      if (this.recoveryJob === job) this.recoveryJob = null;
    });
    this.recoveryJob = job;
    return job;
  }

  private async runCheckpoint(revision: number): Promise<Result<SaveOutcome>> {
    const epoch = this.epoch;
    const generation = this.generation;
    const stale: Result<SaveOutcome> = { ok: false, error: { code: "StaleSession", sessionId: this.sessionId } };
    const owned = () => this.owns(epoch) && this.generation === generation;
    const blocker = (): DocumentError | null => {
      if (this.saving) return { code: "SaveInProgress", sessionId: this.sessionId };
      const blocked = this.saveBlocker();
      if (blocked) return blocked;
      if (this.committed !== revision) return { code: "RevisionMismatch", sessionId: this.sessionId, revision: this.committed };
      return null;
    };
    const checkpoint = this.backend.checkpoint;
    if (!checkpoint) return { ok: false, error: { code: "Protocol" } };
    const format = this.sessions.get(this.sessionId)?.format;
    if (format !== "hwp" && format !== "hwpx") return { ok: false, error: { code: "SaveNotReady", reason: "state" } };
    const first = blocker();
    if (first) return { ok: false, error: first };
    let check = this.saveCheck?.generation === generation ? this.saveCheck.check : null;
    if (!check) {
      // Current serial: a newer user check, save, reload or close invalidates (and does not adopt) this result.
      const checked = await this.preflight(this.checkSerial);
      if (!owned()) return stale;
      if (!checked.ok) return checked;
      check = checked.value;
    }
    const unsafe = blockedBy(check);
    if (unsafe) return { ok: false, error: unsafe };
    const later = blocker();
    if (later) return { ok: false, error: later };
    const exported = this.exportAndCompare(format, "checkpoint");
    if (!owned()) return stale;
    if (!exported?.bytes) return { ok: false, error: { code: "SaveFailure", stage: "export" } };
    let result: Result<SaveOutcome>;
    try {
      result = await checkpoint.call(this.backend, this.sessionId, generation, revision, exported.bytes, exported.contentLoss, exported.reopen, exported.preview);
    } catch (error) {
      this.saveTransportErrors.push(error);
      result = { ok: false, error: { code: "Protocol" } };
    }
    // A late response never belongs to a reloaded or closed model.
    if (!owned()) return stale;
    return result;
  }

  /** 커서 위치를 짧은 문자열로(진단 표시용). 예: "0:3:5", 셀이면 "0:2:1@0/3/0". */
  static positionKey(position: DocPosition): string {
    const c = position.cell;
    const nested = c?.nested?.map(level => `>${level.control}/${level.cell}/${level.cellParagraph}`).join("") ?? "";
    return `${position.section}:${position.paragraph}:${position.offset}${c ? `@${c.textBox ? "textbox/" : c.caption ? "caption/" : ""}${c.control}/${c.cell}/${c.cellParagraph}${nested}` : ""}`;
  }

  /** 커서가 있는 문단의 글자(진단 표시용, 200자까지). */
  caretParagraphText(): string {
    try {
      const at = this.caret;
      const length = this.text?.paragraphLength(at) ?? 0;
      return this.text ? this.text.text({ ...at, offset: 0 }, Math.min(length, 200)) : "";
    } catch {
      return "";
    }
  }

  /** Bounded, read-only selection preview; cross-paragraph selections are not exposed by this adapter. */
  selectionPreview(): string | null {
    if (!this.text || !this.hasSelection) return null;
    const [from, to] = this.ordered();
    if (!sameContext(from, to) || from.section !== to.section || paragraphOf(from) !== paragraphOf(to)) return null;
    try { return this.text.text(from, Math.min(to.offset - from.offset, 500)); }
    catch { return null; }
  }

  /** 문서 전체 텍스트(검사·진단용, 경로 없음). */
  documentText(): string | null {
    try {
      return this.doc ? (this.doc as unknown as { getTextFileText(): string }).getTextFileText() : null;
    } catch {
      return null;
    }
  }

  // ---- 응답 시간 측정 ----

  recordLatency(milliseconds: number) {
    this.samples.push(milliseconds);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  latency(): LatencyStats | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
    return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1]! };
  }

  private releaseDocument() {
    const doc = this.doc, history = this.history, text = this.text;
    // 먼저 소유 참조를 끊는다. 해제 예외 뒤에도 이전 문서를 편집하거나 재해제하지 않는다.
    this.doc = null;
    this.releaseNaturalLease(); // the engine snapshot dies with the document
    this.history = null;
    this.historyOff = null;
    this.text = null;
    this.caretCache = null;
    this.composition = null;
    this.provisional = null;
    this.pendingChars = null;
    this.awaiting = false;
    const errors: unknown[] = [];
    for (const release of [() => this.releaseRendering(), () => history?.release(false), () => text?.release(), () => doc?.free()]) {
      try { release(); } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      this.uncertain = true;
      this.status = { kind: "failed", error: { code: "EngineFailure", engine: "rhwp", stage: "render" } };
      if (errors.length === 1) throw errors[0];
      throw new AggregateError(errors, "문서 해제 실패", { cause: errors[0] });
    }
  }

  /** 세션을 닫을 때. 모델을 버리고 이후의 늦은 응답은 무시한다. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.naturalDeferred = false;
    this.epoch += 1;
    this.imeSerial += 1;
    this.checkSerial += 1;
    this.saveCheck = null;
    this.committingEpoch = null;
    this.failure = null;
    const errors: unknown[] = [];
    try { this.releaseDocument(); } catch (error) { errors.push(error); }
    this.status = { kind: "closed" };
    try { this.emit(); } catch (error) { errors.push(error); }
    finally { this.listeners.clear(); }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "세션 종료 실패", { cause: errors[0] });
  }
}
