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
//   조정한다(문서 모델은 하나). 기록은 레지스트리가 rhwp 실행 취소를 지원으로 두는 빌드(지금은 시험 활성화 빌드)에서만 켠다: 제품
//   빌드는 쓸 수 없는 실행 취소를 위해 그룹 시작마다 스냅숏을 찍거나 붙들지 않는다(세션 선택 `history`로 시험이 명시할 수 있음).
//   글자 서식은 보존 검사가 저장을 막으므로 받지 않는다.
import { trace } from "../imeTrace";
import type { DocumentBackend, ReopenEvidence } from "../../../adapters/backend";
import type { DocumentError, Result, SaveCheck, SaveOutcome, SessionInfo } from "../../../adapters/contract";
import { blockedBy, type SaveCheckRecord, type SaveState } from "../saveState";
import { documentCommandState } from "../../../commands/capability";
import { commandDefinition, type DocumentCommandId } from "../../../commands/registry";
import type { CommandDispatch, DocumentCommandSnapshot, DocumentCommandTarget } from "../../../commands/target";
import type { DocumentSessions } from "../../../adapters/sessions";
import { changedBand, summarizeLayerTree, type PaintBox, type PaintedPage } from "./paintDiff";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
import {
  captureCheckpoint, historyBudget, HistoryFailure, HistoryRefused, placeCheckpoint, RhwpHistory, type HistoryKind,
} from "./rhwpHistory";
import { ZOOM_STEPS } from "../../../hooks/layoutState";
import { drawsAtRequestedScale, fitsRenderBudget, MAX_PAGE_EXTENT } from "./renderBudget";
export { MAX_PAGE_EXTENT } from "./renderBudget";
import {
  charCount,
  compare,
  paragraphOf,
  parsePosition,
  RhwpText,
  sameContext,
  withParagraph,
  type CaretRect,
  type DocPosition,
  type PageRect,
} from "./rhwpText";

export type EditorStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "failed"; error: DocumentError }
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
const MAX_SAMPLES = 1000;

/** 레지스트리가 rhwp 실행 취소·다시 실행을 지원으로 선언했는지(빌드 때 정해짐 — 제품 빌드는 아니다). */
const RHWP_HISTORY_DECLARED = (["edit.undo", "edit.redo"] as const)
  .every((id) => commandDefinition(id)?.engines?.rhwp.level === "supported");

/** 모듈 WASM 선형 메모리 크기. 모르거나 읽지 못하면 null. */
function moduleMemory(module: RhwpModule): number | null {
  try {
    const bytes = module.memoryBytes?.();
    return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
  } catch {
    return null;
  }
}

export class RhwpEditorSession implements DocumentCommandTarget {
  readonly engine = "rhwp" as const;
  status: EditorStatus = { kind: "idle" };
  pages: PageSize[] = [];
  caret: DocPosition = START;
  anchor: DocPosition = START;
  /** 모델이 바뀔 때마다 는다(다시 그리기 판단용, revision과 무관). */
  modelVersion = 0;
  /** 첫 페이지를 그리기까지 걸린 시간(바이트를 받은 뒤부터, ms). */
  firstPaintMs: number | null = null;
  loadStartedAt = 0;
  lastRoundTrip: RoundTripReport | null = null;
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
  private readonly renderCanvases = new Set<HTMLCanvasElement>();
  private text: RhwpText | null = null;
  private module: RhwpModule | null = null;
  private preferredX = -1;
  private committed = 0;
  private pending = 0;
  private committingEpoch: number | null = null;
  /** 로컬 비동기 작업 소유권. reload 시작(백엔드 응답 전)·dispose에서 무효화한다. */
  private epoch = 0;
  private imeSerial = 0;
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
  /** Canvas마다 마지막으로 그린 쪽·배율·그리기 입력 요약(그 자리 다시 그리기의 조건과 바뀐 띠 비교). 놓은 Canvas(releaseRendering, 크기 0)는 쓰지 않고 전체 그리기로 다시 기록한다. */
  private drawnAt = new WeakMap<HTMLCanvasElement, { page: number; scale: number; painted: PaintedPage | null }>();
  private readonly samples: number[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly sessionId: number,
    private readonly backend: DocumentBackend,
    private readonly sessions: DocumentSessions,
    private readonly loadModule: () => Promise<RhwpModule>,
    /** history: 실행 취소 기록을 켤지. 없으면 레지스트리가 rhwp 실행 취소·다시 실행을 지원으로 선언했을 때만(빌드 때 정해짐). */
    private readonly options: { history?: boolean } = {},
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  /** 백엔드가 확인한 revision + 아직 확정하지 않은 변경 수. */
  get localRevision() {
    return this.committed + this.pending;
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
    // ready를 요청하기 전에 화면에 필요한 정보(페이지 크기)를 모두 얻고 검사한다. 엔진이 문서를 읽었더라도 페이지
    // 정보가 없거나 잘못되면 그릴 준비가 안 된 것이므로(render 단계) ready가 되지 않는다.
    let pages: PageSize[];
    try {
      pages = readPages(doc);
    } catch {
      doc.free();
      return this.failLoading(epoch, generation, { code: "EngineFailure", engine: "rhwp", stage: "render" });
    }
    // 큰 배율에서만 예산을 넘는 문서는 받아들이고 표면이 표시 한도로 다룬다. 가장 작은 배율로도 그릴 수 없으면 편집할
    // 표면을 내놓을 수 없으므로 ready 전에 거부한다(올바른 문서이므로 엔진 실패와 구분).
    if (!fitsRenderBudget(pages, MIN_DISPLAY_SCALE)) {
      doc.free();
      return this.failLoading(epoch, generation, { code: "RenderLimit" });
    }
    if (!this.owns(epoch)) {
      doc.free();
      return closed;
    }
    const ready = await this.backend.setState(this.sessionId, generation, "loading", "ready");
    if (!this.owns(epoch)) {
      doc.free();
      return closed;
    }
    if (!ready.ok) {
      doc.free();
      this.generation = generation;
      this.handleBackendRejection(ready.error);
      return { ok: false, error: ready.error };
    }
    this.doc = doc;
    this.text = new RhwpText(doc);
    this.startHistory(doc, loaded.value.bytes.length);
    this.generation = generation;
    this.committed = ready.value.revision;
    this.pending = 0;
    this.modified = false;
    this.caret = this.anchor = START;
    this.preferredX = -1;
    this.pages = pages;
    this.modelVersion += 1;
    this.sessions.applyUpdate(ready.value);
    this.setStatus({ kind: "ready" });
    return LOADED;
  }

  /**
   * 불러오기 중 엔진 단계가 실패했다: 이 시도의 `loading → failed` 전이를 보내고 결과를 기다린 뒤 failed로 둔다. 전이는
   * 편집 중 실패와 같은 기록으로 남겨, 거부됐으면(백엔드가 아직 loading일 수 있음) 다음 reload가 settleFailure로 먼저
   * 확인한다. 쓰지 못한 임시 문서는 부르는 쪽이 이미 놓았다.
   */
  private async failLoading(epoch: number, generation: number, error: DocumentError): Promise<Result<null>> {
    if (!this.owns(epoch)) return { ok: false, error };
    const failure = this.reportFailure(generation, "loading");
    this.failure = failure;
    const result = await failure.result;
    if (!this.owns(epoch)) return { ok: false, error };
    if (this.failure === failure && (result.ok || failureAcknowledged(result.error))) this.failure = null; // 확인됨
    this.setStatus({ kind: "failed", error });
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
  }

  renderPage(page: number, canvas: HTMLCanvasElement, scale: number): boolean {
    if (!this.prepareRendering(scale) || !this.doc) return false;
    const doc = this.doc;
    try {
      const started = import.meta.env.VITE_GEUL_TEST_HOOKS === "1" ? performance.now() : 0;
      const painted = this.paintedSummary(doc, page);
      trace("rhwp:paint-summary", () => ({ page, ms: performance.now() - started }));
      const drawStarted = import.meta.env.VITE_GEUL_TEST_HOOKS === "1" ? performance.now() : 0;
      if (!this.repaintInPlace(doc, page, canvas, scale, painted)) doc.renderPageToCanvas(page, canvas, scale);
      trace("rhwp:paint-draw", () => ({ page, ms: performance.now() - drawStarted }));
      this.drawnAt.set(canvas, { page, scale, painted });
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
  private paintedSummary(doc: RhwpDocument, page: number): PaintedPage | null {
    if (!doc.getPageLayerTreeWithProfile) return null;
    try {
      const started = import.meta.env.VITE_GEUL_TEST_HOOKS === "1" ? performance.now() : 0;
      const json = doc.getPageLayerTreeWithProfile(page, "screen", true, true);
      trace("rhwp:layer-json", () => ({ page, ms: performance.now() - started, chars: json.length }));
      return summarizeLayerTree(json);
    } catch {
      return null;
    }
  }

  /**
   * 이 배율로 이미 그린 같은 쪽 Canvas면 그 자리에서 다시 그린다(같은 페인트, Canvas 크기를 다시 정하지 않음).
   * `renderPageToCanvas`는 그릴 때마다 Canvas 크기를 다시 정해 bitmap을 새로 잡는데, 조합 키마다 그리면 그 비용이
   * 실제 IME 입력 지연의 큰 몫이었다(7차). 8차: 마지막으로 그 Canvas에 그린 그리기 입력과 지금 입력을 비교해(paintDiff.ts)
   * 바뀐 띠만 다시 그리고, 바뀐 것이 없으면 그리지 않는다. 비교할 수 없으면 쪽 전체. 조건이 맞지 않거나(9차: 엔진이 배율을
   * 바꾸는 쪽 포함) 엔진이 거부하면(그리기 전 예외) false를 돌려 원래의 전체 그리기를 쓴다. 진짜 그리기 실패는 그 전체 그리기에서
   * 다시 드러난다.
   */
  private repaintInPlace(doc: RhwpDocument, page: number, canvas: HTMLCanvasElement, scale: number, painted: PaintedPage | null): boolean {
    const size = this.pages[page];
    const drawn = this.drawnAt.get(canvas);
    if (!doc.renderPagePatchToCanvasFilteredWithProfile || !size || !drawn || drawn.page !== page || drawn.scale !== scale
      || canvas.width === 0 || canvas.height === 0) {
      return false;
    }
    const band = painted && drawn.painted ? changedBand(drawn.painted, painted, size.width, size.height) : "page";
    if (band === null) return true; // 이 Canvas는 이미 지금 모델을 보여 준다
    // 그 자리에서 다시 그리기는 엔진이 요청한 배율 그대로 그릴 때만(9차). 엔진이 배율을 줄이면(한 변이 16,384 px를 넘는 쪽) Canvas
    // 변환이 요청 배율과 달라, 요청 배율로 맞춘 띠 경계·fillRect 제한이 실제로 잘라 낸 곳과 어긋났다(실측: 300×6000 쪽, 요청 4.16 →
    // 엔진 2.73에서 띠 위쪽이 배경 없이 투명하게 남아 RGB 87,188 px가 다름). 쪽 전체 패치도 그 배율에서는 처음 그리기와 달랐다
    // (300×9000, 엔진 1.82: 표 괘선 자리 9 px, 채널 차 최대 6, 원인 미확인). 그때는 처음 그리기와 같은 전체 그리기를 쓴다.
    if (!drawsAtRequestedScale(size, scale)) return false;
    let rect: PaintBox = { x: 0, y: 0, width: size.width, height: size.height };
    if (band !== "page") {
      // 띠의 위아래를 Canvas 픽셀 경계에 맞춘다(바깥쪽으로). 소수 픽셀 경계에서는 지우기·다시 그리기가 그 줄을 일부만 덮어
      // 앞뒤 픽셀이 섞였다(실측: 띠 끝 두 줄만 RGB가 다름).
      const top = Math.floor(band.y * scale) / scale;
      const bottom = Math.min(size.height, Math.ceil((band.y + band.height) * scale) / scale);
      rect = { x: band.x, y: top, width: band.width, height: bottom - top };
    }
    const restore = rect.height < size.height ? confineFills(canvas, rect, scale) : null;
    try {
      doc.renderPagePatchToCanvasFilteredWithProfile(page, canvas, scale, "all", "screen", rect.x, rect.y, rect.width, rect.height);
      return true;
    } catch {
      return false;
    } finally {
      restore?.();
    }
  }

  caretRect(): CaretRect | null {
    return this.text?.caret(this.caret) ?? null;
  }

  selectionRects(): PageRect[] {
    if (!this.text || !this.hasSelection || !sameContext(this.anchor, this.caret)) return [];
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

  private ordered(): [DocPosition, DocPosition] {
    return compare(this.anchor, this.caret) <= 0 ? [this.anchor, this.caret] : [this.caret, this.anchor];
  }

  // ---- 문서 변경 ----

  /**
   * 엔진 모델을 바꾼다. 성공하면(count면) 변경 1개를 확정 대기열에 넣는다. 그 뒤의 화면 갱신 준비가 실패해도 변경은
   * 이미 모델에 있으므로 센 채로 편집을 멈춘다. apply가 예외를 던지면 여러 엔진 호출 중 일부가 이미 모델을 바꿨을 수
   * 있으므로 세지 않고(확정하지 않음) 모델을 uncertain으로 표시한 뒤 편집을 멈춘다.
   */
  private mutate(apply: Mutation, count = true, kind: HistoryKind = "other", start: string | null = null): boolean {
    if (!this.editable || !this.doc) return false;
    this.settleProvisional(); // 기다리던 조합은 이 변경보다 먼저 끝난 변경이다
    if (!this.editable) return false;
    const doc = this.doc;
    // 실행 취소 기록: 바꾸는 첫 엔진 호출 직전에 트랜잭션을 연다(지금 상태 스냅숏 = 그룹의 before). 이미 열려 있으면 그대로(조합).
    if (!this.beginHistory(kind, start)) return false;
    let next: ReturnType<Mutation>;
    const started = import.meta.env.VITE_GEUL_TEST_HOOKS === "1" ? performance.now() : 0;
    try {
      next = apply();
      trace("rhwp:text-mutation", () => ({ ms: performance.now() - started }));
    } catch {
      // 진행 중인 조합도 이 실패로 끝난다. 그 조합은 성공한 변경으로 세지 않는다(markFailed가 세지 않게 먼저 비움).
      this.composition = null;
      this.uncertain = true;
      this.lastRoundTrip = null;
      this.modelVersion += 1;
      this.failEditing();
      return false;
    }
    this.modified = true;
    this.lastRoundTrip = null; // 이전 모델의 내보내기 검사 결과는 더 이상 이 모델의 것이 아니다
    this.modelVersion += 1;
    if ("caret" in next) {
      this.caret = next.caret;
      this.anchor = next.anchor;
    } else this.caret = this.anchor = next;
    this.preferredX = -1;
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
   * 문서를 열 때: 이 빌드가 rhwp 실행 취소를 쓰고(`options.history`, 없으면 레지스트리 선언) 예산(원본 크기 대용 — 보수적이지 않음,
   * rhwpHistory.ts historyBudget)이 최소 깊이를 담을 때만 기록을 켠다. 모듈이 선형 메모리 크기를 알려 주면 증가 감시를 붙인다. 기록을
   * 만들지 못해도 문서 세션은 그대로다.
   */
  private startHistory(doc: RhwpDocument, bytes: number) {
    this.history = null;
    this.historyOff = null;
    if (!(this.options.history ?? RHWP_HISTORY_DECLARED)) return;
    const module = this.module;
    try {
      const budget = historyBudget(bytes, doc.snapshotCapacity());
      if (!budget.enabled) {
        this.historyOff = "limit";
        return;
      }
      const memory = module && moduleMemory(module) !== null ? () => moduleMemory(module) ?? 0 : null;
      this.history = new RhwpHistory(doc, budget.depth, undefined, memory);
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
    let checkpoint;
    try {
      checkpoint = direction === "undo" ? history.undo(() => captureCheckpoint(text, this.caret, this.anchor)) : history.redo();
    } catch (error) {
      if (error instanceof HistoryFailure && error.uncertain) {
        // 엔진이 문서를 바꿨는지 알 수 없다(찍기·복원 trap): 되돌림을 보장하지 않고 편집을 멈춘다.
        this.uncertain = true;
        this.lastRoundTrip = null;
        this.modelVersion += 1;
        this.failEditing();
        return false;
      }
      // 엔진을 부르기 전 거절, 또는 바꾸기 전 오류("스냅샷 N 없음" — 기록의 셈이 엔진과 어긋남): 문서는 그대로다.
      if (error instanceof HistoryFailure) this.dropHistory("unavailable");
      this.emit();
      return false;
    }
    this.history?.boundary();
    this.modified = true;
    this.lastRoundTrip = null;
    this.modelVersion += 1;
    const placed = placeCheckpoint(text, checkpoint);
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

  private deleteSelectionRaw(): DocPosition {
    const [from, to] = this.ordered();
    this.text!.deleteRange(from, to);
    return from;
  }

  typeText(text: string): boolean {
    if (!text || this.composition) return false;
    const start = this.hasSelection ? null : RhwpEditorSession.positionKey(this.caret);
    return this.mutate(() => {
      const at = this.hasSelection ? this.deleteSelectionRaw() : this.caret;
      this.text!.insert(at, text);
      return { ...at, offset: at.offset + charCount(text) };
    }, true, "typing", start);
  }

  backspace(): boolean {
    if (this.hasSelection) return this.mutate(() => this.deleteSelectionRaw());
    const at = this.caret;
    const text = this.text;
    if (!text) return false;
    if (at.offset > 0) {
      // 오프셋 단위가 유니코드 스칼라이므로 앞 글자 하나는 1이다(서로게이트 쌍을 나누지 않음).
      return this.mutate(() => {
        text.delete({ ...at, offset: at.offset - 1 }, 1);
        return { ...at, offset: at.offset - 1 };
      }, true, "deleteBack", RhwpEditorSession.positionKey(at));
    }
    const paragraph = paragraphOf(at);
    if (paragraph === 0) return false; // 문맥의 처음: 바꿀 것이 없음(변경 아님)
    return this.mutate(() => {
      const previous = withParagraph(at, paragraph - 1, 0);
      const joinAt = text.paragraphLength(previous);
      text.mergeIntoPrevious(at, paragraph);
      return withParagraph(at, paragraph - 1, joinAt);
    });
  }

  deleteForward(): boolean {
    if (this.hasSelection) return this.mutate(() => this.deleteSelectionRaw());
    const at = this.caret;
    const text = this.text;
    if (!text) return false;
    if (at.offset < text.paragraphLength(at)) {
      return this.mutate(() => {
        text.delete(at, 1);
        return at;
      }, true, "deleteForward", RhwpEditorSession.positionKey(at));
    }
    const paragraph = paragraphOf(at);
    if (paragraph + 1 >= text.paragraphCount(at)) return false;
    return this.mutate(() => {
      text.mergeIntoPrevious(at, paragraph + 1);
      return at;
    });
  }

  enter(): boolean {
    return this.mutate(() => {
      const at = this.hasSelection ? this.deleteSelectionRaw() : this.caret;
      this.text!.split(at);
      return withParagraph(at, paragraphOf(at) + 1, 0);
    });
  }

  // ---- IME 조합 ----

  /**
   * 조합을 시작한다. 선택이 있으면 지운 뒤에(엔진 호출 성공) 조합이 생긴다. 지우기가 예외면 조합은 없다(uncertain).
   * 지운 뒤 화면 갱신이 실패하면 markFailed가 이 조합(지운 것)을 변경 1개로 세고 끝낸다.
   */
  beginComposition(): void {
    if (!this.editable || this.composition) return;
    this.settleProvisional();
    if (!this.editable) return;
    if (!this.hasSelection) {
      this.composition = { anchor: this.caret, text: "", deletedSelection: false };
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
      if (text) this.text!.insert(composition.anchor, text);
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
    if (composition.text !== "" || composition.deletedSelection) this.recordMutation();
    else this.cancelHistory(); // 문서를 바꾸지 않은 조합: 단계 없음, 찍은 스냅숏만 버림
  }

  /** 기다리던 조합을 지금 모델 그대로(고치지 않고) 한 번 센다. 다른 변경·새 조합·편집 중지 전에 부른다. */
  private settleProvisional() {
    const provisional = this.provisional;
    if (!provisional) return;
    this.provisional = null;
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
        if (finalText) this.text!.insert(at, finalText);
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

  /** 지금 커서 자리(ImeSession: 끊긴 조합의 늦은 확정을 넣을 자리로 기억). */
  markCaret(): DocPosition {
    return this.caret;
  }

  /**
   * 이미 끝낸 위치(at)에 늦게 확정된 글자를 넣는다(조합 중 클릭 뒤 IME가 보낸 확정). 변경 하나로 세고, 커서·선택
   * 기준점은 같은 문단의 그 위치 뒤에 있을 때만 넣은 글자만큼 민다(커서를 확정 위치로 옮기지 않음).
   */
  insertCommittedAt(at: DocPosition, text: string): boolean {
    if (!text || this.composition) return false;
    const length = charCount(text);
    const shift = (position: DocPosition): DocPosition =>
      sameContext(position, at) && paragraphOf(position) === paragraphOf(at) && position.offset >= at.offset
        ? { ...position, offset: position.offset + length }
        : position;
    return this.mutate(() => {
      this.text!.insert(at, text);
      return { caret: shift(this.caret), anchor: shift(this.anchor) };
    });
  }

  // ---- 커서 이동 ----

  private moveTo(position: DocPosition, extend: boolean, keepPreferredX = false) {
    if (extend && !sameContext(this.anchor, position)) return; // 선택은 한 문맥(본문 또는 한 셀) 안에서만
    this.history?.boundary(); // 이동·클릭·선택은 타자 그룹을 끊는다
    this.caret = position;
    if (!extend) this.anchor = position;
    if (!keepPreferredX) this.preferredX = -1;
    this.emit();
  }

  moveHorizontal(delta: -1 | 1, extend: boolean): boolean {
    const text = this.text;
    if (!text || !this.editable) return false;
    if (!extend && this.hasSelection && sameContext(this.anchor, this.caret)) {
      const [from, to] = this.ordered();
      this.moveTo(delta < 0 ? from : to, false);
      return true;
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
    this.moveTo(next, extend);
    return true;
  }

  moveVertical(delta: -1 | 1, extend: boolean): boolean {
    const moved = this.text?.vertical(this.caret, delta, this.preferredX);
    if (!moved || !this.editable) return false;
    if (extend && !sameContext(this.anchor, moved.position)) return false;
    this.moveTo(moved.position, extend, true);
    this.preferredX = moved.preferredX;
    return true;
  }

  moveLineEdge(edge: "start" | "end", extend: boolean): boolean {
    const line = this.text?.line(this.caret);
    if (!line || !this.editable) return false;
    const length = this.text!.paragraphLength(this.caret);
    const offset = edge === "start" ? line.start : Math.min(line.end, length);
    this.moveTo({ ...this.caret, offset }, extend);
    return true;
  }

  /** 표 셀 사이 이동(Tab). 표 밖이거나 더 갈 셀이 없으면 false. */
  moveCell(delta: -1 | 1): boolean {
    const at = this.caret;
    const cells = this.text?.cellCount(at);
    if (!at.cell || cells === null || cells === undefined || !this.editable) return false;
    const target = at.cell.cell + delta;
    if (target < 0 || target >= cells) return false;
    this.moveTo({ ...at, offset: 0, cell: { ...at.cell, cell: target, cellParagraph: 0 } }, false);
    return true;
  }

  /** 페이지 좌표(배율 1)를 클릭했다. extend면 선택을 넓힌다. */
  pointAt(page: number, x: number, y: number, extend: boolean): boolean {
    if (!this.doc || !this.editable) return false;
    let position: DocPosition | null;
    try {
      position = parsePosition(JSON.parse(this.doc.hitTest(page, x, y)));
    } catch {
      position = null;
    }
    if (!position) return false;
    // 셀 위치는 그 컨트롤이 실제 표일 때만(엔진이 표가 아닌 컨트롤 안을 셀처럼 돌려주는 경우가 있다 — 그 자리에 쓰면 엔진 예외로 편집이 멈춤).
    if (position.cell && this.text?.cellCount(position) === null) return false;
    this.moveTo(position, extend);
    return true;
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
  private exportAndCompare(format: "hwp" | "hwpx"): {
    report: RoundTripReport;
    bytes: Uint8Array | null;
    contentLoss: unknown;
    reopen: ReopenEvidence;
  } | null {
    const doc = this.doc;
    const module = this.module;
    if (!doc || !module) return null;
    let output: Uint8Array | null = null;
    let contentLoss: unknown = null;
    const report: RoundTripReport = {
      format, failure: "export", bytes: 0, reopenedFormat: null, formatEqual: false, lossValid: false, lossCount: -1, losses: [],
      pagesEqual: false, textEqual: false, controlsEqual: false, passed: false,
    };
    let reopened: RhwpDocument | null = null;
    try {
      let bytes: Uint8Array;
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
        exported.free();
      }
      output = bytes;
      report.bytes = bytes.length;
      report.failure = "reopen";
      reopened = module.openDocument(bytes);
      const reopenedFormat: unknown = reopened.getSourceFormat();
      report.reopenedFormat = typeof reopenedFormat === "string" ? reopenedFormat : null;
      report.formatEqual = report.reopenedFormat === format && hasSignature(bytes, format);
      const controls = (d: RhwpDocument) => (d as unknown as { getControls(): string }).getControls();
      const textOf = (d: RhwpDocument) => (d as unknown as { getTextFileText(): string }).getTextFileText();
      report.pagesEqual = reopened.pageCount() === doc.pageCount();
      report.textEqual = textOf(reopened) === textOf(doc);
      report.controlsEqual = controls(reopened) === controls(doc);
      report.failure = null;
    } catch {
      // report.failure가 실패한 단계를 가리킨다.
    } finally {
      reopened?.free();
    }
    report.passed = report.failure === null && report.lossValid && report.lossCount === 0 && report.formatEqual
      && report.pagesEqual && report.textEqual && report.controlsEqual;
    const reopen: ReopenEvidence = {
      formatEqual: report.failure === null && report.formatEqual,
      pagesEqual: report.failure === null && report.pagesEqual,
      textEqual: report.failure === null && report.textEqual,
      controlsEqual: report.failure === null && report.controlsEqual,
    };
    return { report, bytes: output, contentLoss, reopen };
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
      // 기록은 지역·동기라 대기 확정에 영향받지 않는다(queuedHistory 없음). 열린 트랜잭션(조합)은 composing이 막는다.
      history: this.history ? { undo: this.history.canUndo, redo: this.history.canRedo } : null,
      historyLimited: this.history === null && this.historyOff === "limit",
      format: null, formatAccess: null,
    };
  }

  /** 명령을 이 세션에서 실행한다. 지금 상태로 다시 확인해 할 수 없으면(rhwp가 지원하지 않는 명령 포함) 아무것도 바꾸지 않는다. */
  execute(command: DocumentCommandId): CommandDispatch {
    // 레지스트리 가용성(엔진 지원 표 포함)을 실행 직전에 다시 확인한다. rhwp 실행 취소는 그 표가 지원으로 바뀌기 전에는 오지 않는다.
    if (!documentCommandState(command, this.snapshot()).available) return { accepted: false };
    if (command === "edit.undo" || command === "edit.redo") return { accepted: command === "edit.undo" ? this.undo() : this.redo() };
    if (command !== "file.save") return { accepted: false };
    void this.save();
    return { accepted: true };
  }

  // ---- 저장(T009) ----

  private setSave(state: SaveState) {
    this.saveState = state;
    this.emit();
  }

  /** 지금 저장을 시작할 수 없는 이유(없으면 null). */
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
      this.setSave(checked.ok ? { kind: "idle" } : { kind: "failed", error: checked.error });
    }
    return checked;
  }

  /**
   * 보존 사전 검사: 백엔드가 확인한 원본 바이트를 새 WASM 문서로 열어(편집 모델과 무관) 편집 없이 같은 형식으로 내보내고,
   * 그 출력과 손실 보고를 백엔드가 원본과 비교한다. 결과는 `serial`이 아직 지금 요청일 때만 이 시도에 대해 기억한다.
   */
  private async preflight(serial: number): Promise<Result<SaveCheck>> {
    const blocker = this.saveBlocker();
    if (blocker && blocker.code === "SaveNotReady" && blocker.reason === "state") return { ok: false, error: blocker };
    const module = this.module!;
    const format = this.sessions.get(this.sessionId)?.format;
    if (format !== "hwp" && format !== "hwpx") return { ok: false, error: { code: "SaveNotReady", reason: "state" } };
    const { epoch, generation } = this;
    const original = await this.backend.original(this.sessionId, generation);
    if (!original.ok) return original;
    if (!this.owns(epoch)) return { ok: false, error: { code: "StaleSession", sessionId: this.sessionId } };
    let unedited: Uint8Array;
    let contentLoss: unknown;
    let fresh: RhwpDocument | null = null;
    try {
      fresh = module.openDocument(original.value);
      const exported = format === "hwp" ? fresh.exportHwpWithReport() : fresh.exportHwpxWithReport();
      try {
        try {
          contentLoss = JSON.parse(exported.contentLoss());
        } catch {
          contentLoss = null;
        }
        unedited = exported.takeBytes();
      } finally {
        exported.free();
      }
    } catch {
      return { ok: false, error: { code: "EngineFailure", engine: "rhwp", stage: "export" } };
    } finally {
      fresh?.free();
    }
    const checked = await this.backend.preflight(this.sessionId, generation, unedited, contentLoss);
    if (!this.owns(epoch)) return { ok: false, error: { code: "StaleSession", sessionId: this.sessionId } };
    if (checked.ok && serial === this.checkSerial) {
      this.saveCheck = { generation, check: checked.value };
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
  async save(): Promise<Result<SaveOutcome>> {
    const fail = (error: DocumentError): Result<SaveOutcome> => {
      if (this.owns(epoch)) this.setSave({ kind: "failed", error });
      return { ok: false, error };
    };
    const epoch = this.epoch;
    if (this.saving) return { ok: false, error: { code: "SaveInProgress", sessionId: this.sessionId } };
    const blocker = this.saveBlocker();
    if (blocker) return fail(blocker);
    const format = this.sessions.get(this.sessionId)?.format;
    if (format !== "hwp" && format !== "hwpx") return fail({ code: "SaveNotReady", reason: "state" });
    this.saving = true;
    try {
      const generation = this.generation;
      let check = this.saveCheck?.generation === generation ? this.saveCheck.check : null;
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
      const exported = this.exportAndCompare(format);
      if (!exported?.bytes) return fail({ code: "SaveFailure", stage: "export" });
      const result = await this.backend.save(this.sessionId, generation, revision, exported.bytes, exported.contentLoss, exported.reopen);
      if (!this.owns(epoch)) return result;
      if (!result.ok) return fail(result.error);
      this.sessions.applyUpdate(result.value.session);
      // 저장하는 동안 시작해 아직 끝나지 않은 IME 트랜잭션(기다림 포함)의 글자는 이 저장에 없다.
      const changedSince = this.localRevision !== revision || this.imeUnsettled;
      // 저장한 판 뒤에 편집이 없고 교체의 내구성까지 확인했으면 이 모델은 디스크의 파일과 같다(닫기·다시 불러오기에 버리기
      // 확인이 필요 없음). 내구성을 확인하지 못했으면(교체는 됨) 저장하지 않은 편집으로 남긴다(백엔드도 dirty로 둔다).
      if (!changedSince && result.value.durable) this.modified = false;
      // 원본이 바뀌었다: 다음 저장은 새 원본으로 다시 검사한다. 그 전에 시작한 검사의 늦은 결과도 버린다.
      this.checkSerial += 1;
      this.saveCheck = null;
      this.setSave({ kind: "saved", revision, durable: result.value.durable, changedSince });
      return result;
    } finally {
      this.saving = false;
    }
  }

  /** 커서 위치를 짧은 문자열로(진단 표시용). 예: "0:3:5", 셀이면 "0:2:1@0/3/0". */
  static positionKey(position: DocPosition): string {
    const c = position.cell;
    return `${position.section}:${position.paragraph}:${position.offset}${c ? `@${c.control}/${c.cell}/${c.cellParagraph}` : ""}`;
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
    this.releaseRendering();
    // 기록의 스냅숏은 문서 객체 안에 있어 free와 함께 사라진다: 엔진을 다시 부르지 않고 참조만 버린다.
    this.history?.release(false);
    this.history = null;
    this.historyOff = null;
    this.doc?.free();
    this.doc = null;
    this.text = null;
    this.composition = null;
    this.provisional = null;
    this.awaiting = false;
  }

  /** 세션을 닫을 때. 모델을 버리고 이후의 늦은 응답은 무시한다. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    this.imeSerial += 1;
    this.checkSerial += 1;
    this.saveCheck = null;
    this.committingEpoch = null;
    this.failure = null;
    this.releaseDocument();
    this.status = { kind: "closed" };
    this.emit();
    this.listeners.clear();
  }
}

/**
 * 띠 다시 그리기 동안 그 Canvas의 fillRect를 띠와 겹치는 부분만 그리게 한다(돌려놓는 함수를 돌려줌).
 * rhwp의 패치 그리기는 띠로 잘라 내고(clip) 그리지만 쪽 배경을 쪽 전체 fillRect로 다시 칠한다. WebKit은 잘라 낸 영역이 아니라
 * 그린 사각형 전체를 바뀐 곳으로 보아(실측: 50×50으로 잘라 낸 전체 fillRect가 전체 칠하기와 같은 frame 비용) Canvas 전체를
 * 다시 합성했다. 잘라 낸 결과와 같은 픽셀이므로(띠는 Canvas 픽셀 경계에 맞춤) 겹치는 부분만 칠한다. 지금 변환이 확대·이동이
 * 아니면(회전·기울임·뒤집기) 그대로 칠한다(잘라 내기가 같은 결과를 지킴).
 * scale은 엔진이 실제로 그리는 배율이어야 한다: 띠(쪽 좌표) × scale이 엔진의 잘라 내기와 같은 Canvas 픽셀이 되는 조건이다.
 * 그래서 엔진이 요청 배율을 그대로 쓸 때만 부른다(drawsAtRequestedScale, 9차). 돌려놓기는 그리기가 던져도 부른다(finally).
 */
function confineFills(canvas: HTMLCanvasElement, band: PaintBox, scale: number): (() => void) | null {
  const context = canvas.getContext("2d");
  if (!context || typeof context.getTransform !== "function") return null;
  const original = context.fillRect;
  const device = { left: band.x * scale, top: band.y * scale, right: (band.x + band.width) * scale, bottom: (band.y + band.height) * scale };
  context.fillRect = function (x: number, y: number, width: number, height: number) {
    const m = this.getTransform();
    if (m.b !== 0 || m.c !== 0 || m.a <= 0 || m.d <= 0) return original.call(this, x, y, width, height);
    // 띠(Canvas 픽셀)를 지금 사용자 좌표로 옮겨 겹치는 부분만.
    const left = Math.max(Math.min(x, x + width), (device.left - m.e) / m.a);
    const right = Math.min(Math.max(x, x + width), (device.right - m.e) / m.a);
    const top = Math.max(Math.min(y, y + height), (device.top - m.f) / m.d);
    const bottom = Math.min(Math.max(y, y + height), (device.bottom - m.f) / m.d);
    if (right <= left || bottom <= top) return;
    original.call(this, left, top, right - left, bottom - top);
  };
  return () => {
    // 인스턴스에 둔 것만 지운다(원래의 prototype 메서드로 돌아감).
    delete (context as unknown as { fillRect?: unknown }).fillRect;
    if (context.fillRect !== original) context.fillRect = original;
  };
}
