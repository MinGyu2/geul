// WordCraft(DOCX) 편집 세션 하나(T008, W-A). 문서 모델은 백엔드(Rust)에 있고, 이 객체는 그 세션의 하나뿐인 편집 표면
// 상태(보기·대기 연산·IME 조합·쪽 그림)를 가진다.
//
// 소유와 순서(docs/architecture/editor-surface-decision.md "T008 결과"):
// - 세션 수명주기·revision의 권한은 백엔드 하나다. 백엔드가 편집을 실행하고 실제로 문서를 바꾼 연산만 revision으로
//   확정한다(문서를 바꾸지 않은 Tab 이동·처음의 Backspace는 세지 않음). 이 객체는 응답의 세션 정보를 투영에 반영할 뿐
//   revision을 직접 올리지 않는다.
// - 편집은 허용한 연산(DocxOp)으로만 보낸다. 요청은 한 번에 하나이고(기준 revision = 마지막 응답의 판), 기다리는 동안의
//   입력은 다음 요청에 순서대로 묶는다. 그래서 순서가 바뀌거나 중복되지 않는다. 엔진이 거부한 연산은 그 연산만 없던 일이
//   된다(rejected).
// - reload·dispose마다 epoch을 바꾼다. 옛 epoch의 응답은 보기·대기열·상태를 바꾸지 않는다.
// - 기대하지 않은 거부(RevisionMismatch·StaleLoad·InvalidState·EngineFailure 등)는 편집을 멈추고 failed로 보인다. 보내지
//   못한 입력은 버린다(문서에 들어가지 않았음을 숨기지 않고 미보존으로 보호). 백엔드 모델이 남아 있으면(ready) 다시
//   불러오기는 사용자가 버리기를 확인한 뒤 백엔드가 그 모델을 버리고 파일에서 새로 읽는다(`docx_load` reloadGeneration).
// - IME: 엔진은 조합을 모른다. 조합 중 글자는 표면이 커서 자리에 겹쳐 그리고(모델은 그대로), 조합이 끝날 때 확정한 글자만
//   InsertText 하나로 보낸다(조합 하나 = 연산 하나 = revision 하나, 취소는 연산 없음). 선택이 보일 때의 조합은 조합 글자가
//   처음 보일 때 선택을 지운다(DeleteSelection, 따로 한 연산). 지울지는 백엔드가 그 연산을 실행할 때의 선택으로 정한다(응답 전
//   보기는 옛 것일 수 있어 Backspace를 보내면 선택을 접은 뒤의 글자를 지웠다, T008 안정화). 미리보기 없이 끝난 빈 조합은 아무것도
//   지우지 않는다. 미리보기가 보인 뒤 취소하면 지운 선택은 남는다(rhwp와 같은 계약: 그 지우기만 변경 1개). 확정 글자의
//   InsertText는 그때 남은 선택을 바꾼다(엔진 동작). 끊긴 조합 규칙(imeInput.ts)은 rhwp와 같은 ImeInput이 맡고,
//   이 객체는 ImeSession 계약을 구현한다:
//   · 앱이 먼저 확정한 보이는 조합(클릭·초점 잃음·표면 사라짐)은 그 자리에서 InsertText를 보내고, 바로 뒤 클릭은 넣기 전
//     화면의 좌표로 자리를 찾는다(Pointer.beforeInsert). 입력기의 최종 글자가 다르면 ReplaceInserted로 고친다.
//   · 클릭 직전 커서 자리는 백엔드에 Mark로 기억시키고(markCaret), 늦게 온 확정은 InsertAt으로 그 자리에 넣는다.
// - 저장하지 않은 확정 편집(백엔드 dirty)·보내는 중·조합 중인 입력은 닫기·다시 불러오기 전에 저장하거나 사용자가 버리기를
//   명시해야 한다(`hasUnpreservedChanges`, `load({ discard })`).
// - 저장(T009): 백엔드가 확정한 판(this.revision)만 저장한다. 보내는 중인 연산·조합이 있으면 시작하지 않는다. 이 원본의 보존
//   사전 검사(docx_preflight)가 없으면 먼저 하고, safe가 아니면 저장하지 않는다. 교체·검사는 백엔드가 하고, 응답의 세션 정보
//   (dirty)를 반영한다. 저장 중에도 편집은 이어 가며, 그 편집은 저장한 판 뒤의 것이라 dirty로 남는다.
// - 글자 넣기·붙여넣기는 textOps.ts가 허용한 연산으로 바꾼다(여러 줄은 문단 나누기, 긴 글자는 4096자 조각). 넣을 수 없는
//   글자·한도 초과·엔진이 일부 조각을 거부한 붙여넣기는 넣은 척하지 않고 inputNotice로 알린다(편집은 이어 감).
// - 쪽 그림은 백엔드가 그린 PNG를 (시도 번호, revision, 배율)로 받아 쪽마다 화면 밖 canvas(래스터)에 둔다. 같은 배율의 앞 판을
//   가지고 있으면 백엔드는 바뀐 줄의 띠만 보내고, 화면 canvas에도 그 띠만 옮긴다. 새 판의 그림이 오기 전까지 옛 그림을 보인다.
// - 그림 실패(T008 안정화): 옛 시도·옛 판(편집이 보내는 중) 응답은 무시한다. 세션을 잃은 오류(InvalidState·EngineFailure·
//   StaleLoad·StaleSession 등, 기다리는 연산 없는 RevisionMismatch)는 편집 실패와 같이 failed. 그 밖의 백엔드 거부·PNG 디코드
//   실패·canvas 문맥 없음·띠 크기 불일치는 그 쪽의 지금 판 실패로 세고, 간격을 두고 MAX_RENDER_ATTEMPTS번까지 다시 받는다. 그래도
//   실패하면 그 쪽을 그리지 못했다고 보이며 편집을 멈춘다(옛 그림을 지금 판으로 표시하지 않음, 확정한 편집은 그대로 보호).
//   멈춤은 그 쪽이 지금 판으로 그려지거나 보이지 않게 될 때까지 이어진다: 멈추며 확정한 조합·보내던 편집으로 판이 바뀌어도
//   풀리지 않고 새 판으로 다시 시도한다(풀리면 같은 조합의 늦은 IME 이벤트가 새 조합으로 한 번 더 들어감). retryRendering()은
//   시도 수를 처음으로 돌린다.
// - 화면 canvas 그리기(T008 2차 안정화): 화면 밖 래스터가 지금 판이어도 화면 canvas에 옮기지 못하면(문맥 없음·문맥이나
//   drawImage 예외) 그 canvas는 그 판을 보인다고 기록하지 않고, 첫 그림 시간도 실제로 그린 때만 남긴다. 실패는 백엔드 그림
//   실패와 따로 센다(PNG를 다시 받지 않고 같은 래스터를 다시 옮겨 봄). 같은 간격·MAX_RENDER_ATTEMPTS번까지 다시 그려 보고,
//   그래도 못 그리면 그 쪽을 그리지 못했다고 보이며 편집을 멈춘다(멈춤은 그 쪽을 화면에 그리거나 보이지 않게 될 때까지).
//   보이지 않는 쪽의 실패는 세지 않는다(다음 그리기에서 다시 옮김). 실패한 canvas는 다음에 쪽 전체를 옮긴다.
// - 그림 수명(T008 2차 안정화): releaseRendering()은 그림 수명(renderLife)을 바꾼다. 그 전에 보낸 요청의 응답·디코드 결과는
//   래스터·실패 상태·알림을 바꾸지 않고(받은 그림은 닫음), 끝난 요청은 자기 요청 기록만 지운다(놓은 뒤 같은 키로 다시 보낸
//   요청을 지우지 않음). 편집 모델의 epoch·불러오기 시도와 따로다: 그림 수명이 바뀌어도 편집·조합·revision은 그대로다.
// - 그림 경로의 예외(T008 2차 안정화): 백엔드 호출 거부는 Protocol 거부로, 디코드 예외는 디코드 실패로, 화면 밖 canvas
//   만들기·크기·문맥·그리기 예외는 그 래스터를 놓고 canvas 실패로 센다(처리되지 않은 거부 없음, 시도 수는 위와 같음).
// - 화면에 보임(T008 3차 안정화): 래스터가 지금 판인 것(isCurrent)과 화면에 보이는 것(isShown)은 다르다. 쪽마다 표면이 마지막으로
//   paint에 준 canvas가 그 쪽의 활성 화면 canvas이고, 그 canvas에 지금 래스터·판을 실제로 옮겼을 때만 보인다(다른 canvas의 기록,
//   놓기 전 기록은 근거가 아님). 놓기는 활성 canvas 기록도 지운다.
// - 정리·알림 예외(T008 3차 안정화): canvas 저장소 놓기(크기 0)는 할 수 있는 만큼만 하고 예외가 나도 기억에서 빼는 일을 막지
//   않는다(래스터 예산). 구독자 하나의 예외는 다른 구독자 알림을 막지 않는다. 그 밖에 그림 요청 처리 중 기대하지 않은 예외는 지금
//   요청이고 그 쪽이 지금 판이 아니면 그 쪽 실패로 세며(시도 수 같음), 어느 경우든 숨기지 않고 창의 오류 보고(reportError)로 넘긴다.
// - 래스터 예산(T008 안정화): 화면 밖 래스터는 MAX_RETAINED_PIXELS까지 기억하고, 넘으면 지금 요청한(보이는) 쪽이 아닌 것부터
//   오래 쓰지 않은 순으로 놓는다(canvas 크기 0). 놓은 쪽의 화면 canvas도 다음 그리기에서 놓는다. 표면이 사라지면
//   releaseRendering()으로 모두 놓는다(T007 rhwp와 같음). 백엔드 래스터 기억은 세션마다 4개(engine.rs MAX_RASTERS).
// - 명령(T010, src/commands/): 실행 취소·다시 실행·글자 서식은 같은 편집 대기열에 연산(undo·redo·format)으로 넣는다. 기록은
//   백엔드의 WordCraft Session이 가지며(앱은 기록을 따로 두지 않음), 가용성·눌림은 엔진 보기(view.history·view.format·
//   view.formatAccess)로 정한다. 저장 명령은 아래 save()를 그대로 부른다. T010 안정화: 앱이 먼저 확정한 조합이 입력기의 최종
//   글자를 기다리는 동안(provisional)은 조합 중과 같이 명령을 받지 않는다(그 사이 연산이 provisional을 지워 최종 글자로 고치지
//   못했다). 엔진이 명령 연산을 거부하면 inputNotice "commandRejected"로 알린다.
import type { DocxBackend, DocxOp, DocxRender, DocxRoundTrip, DocxView, MoveTarget } from "../../../adapters/docx";
import { MAX_DOCX_OPS } from "../../../adapters/docx";
import type { DocumentError, Result, SaveCheck, SaveOutcome, SessionInfo } from "../../../adapters/contract";
import type { DocumentSessions } from "../../../adapters/sessions";
import type { ImeSession } from "../rhwp/imeInput";
import { textOps } from "./textOps";
import { trace } from "../imeTrace";
import { blockedBy, type SaveCheckRecord, type SaveState } from "../saveState";
import { documentCommandState, FORMAT_FLAG } from "../../../commands/capability";
import type { DocumentCommandId } from "../../../commands/registry";
import type { CommandDispatch, DocumentCommandSnapshot, DocumentCommandTarget, QueuedStep } from "../../../commands/target";

export type DocxStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "failed"; error: DocumentError }
  | { kind: "closed" };

/** 넣지 못한 입력의 알림: 넣을 수 없는 글자, 한도 초과(넣지 않음), 엔진이 일부 조각을 거부함(앞부분만 들어감). */
export type DocxInputNotice = "pasteUnsupported" | "pasteTooLarge" | "pasteIncomplete" | "commandRejected";

/**
 * 엔진에서 바꾸는 명령으로 실행되는 연산(T010 안정화 P2-A): 성공하면 실행 취소 지점을 남기고 다시 실행 기록을 버린다(WordCraft
 * `Session::run`). 이동·클릭·선택·표지는 아니다. 실행 취소·다시 실행은 따로 다룬다(queuedHistory).
 */
const MUTATING_OPS: ReadonlySet<DocxOp["op"]> = new Set<DocxOp["op"]>([
  "insertText", "pasteText", "deleteSelection", "backspace", "deleteForward", "newParagraph", "tab", "insertAt", "replaceInserted",
  "format",
]);
/** 명령(T010)이 보낸 연산. 엔진이 거부하면(문서 보호 등) 알린다. */
const COMMAND_OPS: ReadonlySet<DocxOp["op"]> = new Set<DocxOp["op"]>(["undo", "redo", "format"]);

/** 쪽 그림 실패의 원인: 백엔드 거부, PNG 디코드 실패, canvas 문맥 없음, 크기 불일치, 기대하지 않은 예외. */
export type RenderFailureReason = "backend" | "decode" | "canvas" | "size" | "unexpected";

/** 쪽 하나의 래스터(그 판·배율의 쪽 전체 그림)와 그 위에 덮은 띠들. */
interface PageRaster {
  generation: number;
  revision: number;
  scale: number;
  /** 화면 밖 canvas(쪽 전체). 띠는 여기에 덮는다. */
  backing: HTMLCanvasElement;
  width: number;
  height: number;
  /** 쪽 전체를 받은 판. */
  full: number;
  /** 그 뒤 덮은 띠(판 from → to). 화면 canvas가 어느 판을 보이는지에 따라 옮길 줄을 정한다. */
  bands: { from: number; to: number; y: number; height: number }[];
}

/** 기억하는 띠 수. 이보다 오래된 판을 보이는 canvas는 전체를 다시 옮긴다. */
const MAX_BANDS = 64;
/** 화면 밖 쪽 래스터를 기억하는 픽셀 예산(RGBA 128 MiB, T007 활성 표면 예산과 같음). 지금 요청한 쪽은 넘어도 놓지 않는다. */
export const MAX_RETAINED_PIXELS = 32 * 1024 * 1024;
/** 같은 쪽·판·배율의 그림을 받는 횟수와 다시 받기 전 간격(ms, 시도마다 늘어남). */
export const MAX_RENDER_ATTEMPTS = 3;
export const RENDER_RETRY_MS = 250;
/** 그림 요청이 세션을 잃었음을 알리는 오류(편집기 failed·closed). RevisionMismatch는 기다리는 연산이 없을 때만. */
const SESSION_ERRORS = new Set<DocumentError["code"]>(["StaleSession", "UnknownSession", "StaleLoad", "InvalidState", "EngineFailure", "RevisionMismatch"]);

export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

/** PNG 바이트 → 그릴 수 있는 그림. 앱은 createImageBitmap, 시험은 가짜를 쓴다. */
export type DecodeImage = (png: Uint8Array) => Promise<ImageBitmap>;

const decodePng: DecodeImage = (png) => createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));

/** CSS px / pt(96/72). 화면 배율 100%에서 1pt = 4/3 CSS px. */
export const CSS_PX_PER_PT = 96 / 72;
/** 쪽 그림 하나의 픽셀 상한(백엔드 MAX_RENDER_PIXELS, T007 canvas 예산과 같음). */
export const MAX_PAGE_PIXELS = 16 * 1024 * 1024;
const MAX_SAMPLES = 1000;
/** WebView를 다시 시작한 뒤 백엔드에서 불러오는 중인 세션을 다시 확인하는 간격(ms)과 횟수. */
const RESUME_POLL_MS = 300;
const RESUME_POLLS = 200;

const closedError = (sessionId: number): DocumentError => ({ code: "StaleSession", sessionId });

/** 처리하지 못한 예외를 숨기지 않고 창의 오류 보고로 넘긴다(처리되지 않은 거부가 아니며, 그림 상태를 바꾸지 않음). */
function report(error: unknown) {
  if (typeof reportError === "function") reportError(error);
  else setTimeout(() => {
    throw error;
  });
}

/** canvas 저장소를 놓는다(크기 0). 할 수 있는 만큼만: 예외가 나면 그 canvas는 참조가 사라질 때 함께 놓인다. */
function releaseCanvas(canvas: HTMLCanvasElement) {
  try {
    canvas.width = 0;
  } catch {
    // 너비를 바꿀 수 없음: 높이라도 놓아 본다.
  }
  try {
    canvas.height = 0;
  } catch {
    // 아래 호출하는 쪽이 이 canvas를 기억에서 뺀다.
  }
}

export class DocxEditorSession implements ImeSession, DocumentCommandTarget {
  readonly engine = "wordcraft" as const;
  status: DocxStatus = { kind: "idle" };
  view: DocxView | null = null;
  /** 백엔드가 확인한 판(마지막 응답). */
  revision = 0;
  /** 불러오기를 시작해 첫 쪽 그림을 그리기까지(ms). 표면이 기록한다. */
  firstPaintMs: number | null = null;
  loadStartedAt = 0;
  lastRoundTrip: DocxRoundTrip | null = null;
  /** 엔진이 거부해 없던 일이 된 연산 수(이 모델에서). */
  rejectedOps = 0;
  /** 화면 배율·DPR로 그리면 그림 예산을 넘어 그리지 않는 동안 그 배율(pt당 픽셀), 아니면 null. 편집도 멈춘다. */
  renderLimit: number | null = null;
  /** 넣지 못한 입력의 알림(다음 입력까지). */
  inputNotice: DocxInputNotice | null = null;
  /** 마지막 저장 시도의 결과(T009, 화면 표시). */
  saveState: SaveState = { kind: "idle" };
  /** 이 원본에 대한 보존 사전 검사(T009). 다시 불러오거나 저장하면(원본이 바뀜) 버린다. */
  saveCheck: SaveCheckRecord | null = null;
  private saving = false;
  /** 사전 검사 요청의 소유 번호(T009 안정화, rhwp 세션과 같은 규칙): 새 검사·저장 성공·다시 불러오기·닫기마다 올린다. */
  private checkSerial = 0;

  private generation = 0;
  private queue: DocxOp[] = [];
  private inFlight = false;
  /** 보내는 중인 요청의 연산(응답이 오면 비움). */
  private sending: DocxOp[] = [];
  private epoch = 0;
  private closing = false;
  private disposed = false;
  /** 조합 중 글자. shown: 조합 글자가 한 번이라도 보였다(그때 보이던 선택을 지움). */
  private composition: { text: string; shown: boolean } | null = null;
  /** 앱이 먼저 확정한 조합(입력기의 최종 글자를 기다림). */
  private provisional: { text: string } | null = null;
  /** 바로 앞에 보낸 연산이 앱이 확정한 조합의 넣기다(다음 클릭은 넣기 전 화면의 좌표). */
  private pointerAfterInsert = false;
  private nextMark = 1;
  private loadingPromise: Promise<Result<null>> | null = null;
  private resuming = false;
  private readonly rasters = new Map<number, PageRaster>();
  /** canvas마다 마지막으로 옮긴 래스터와 그 판. */
  private readonly painted = new WeakMap<HTMLCanvasElement, { raster: PageRaster; revision: number }>();
  /** 쪽마다 활성 화면 canvas(표면이 마지막으로 paint에 준 것). isShown은 이 canvas에 옮긴 기록만 본다. */
  private readonly screens = new Map<number, HTMLCanvasElement>();
  /** 그림 수명(releaseRendering마다 늘어남). 그 전 수명에 보낸 요청의 결과는 쓰지 않는다. */
  private renderLife = 0;
  /** 보내는 중인 그림 요청(key → 그 요청). 끝난 요청은 자기 기록일 때만 지운다. */
  private readonly rendering = new Map<string, object>();
  /** 쪽마다 화면 canvas 그리기의 실패(그 래스터·판에 대한 시도). 화면 밖 래스터의 실패(failures)와 따로 센다. */
  private readonly paintFailures = new Map<number, { raster: PageRaster; revision: number; attempts: number; retryAt: number; blocking: boolean }>();
  /** 쪽마다 지금 판(key = 시도:판:배율) 그림의 실패. */
  private readonly failures = new Map<number, { key: string; attempts: number; retryAt: number; reason: RenderFailureReason; blocking: boolean }>();
  /** 마지막으로 그림을 요청한 쪽(보이는 쪽·커서 쪽, 래스터 예산에서 놓지 않음)과 배율. */
  private wanted = new Set<number>();
  private scale: number | null = null;
  private readonly samples: number[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly sessionId: number,
    private readonly backend: DocxBackend,
    private readonly sessions: DocumentSessions,
    private readonly decode: DecodeImage = decodePng,
    private readonly createCanvas: () => HTMLCanvasElement = () => document.createElement("canvas"),
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 구독자에게 알린다. 하나가 예외를 내도 나머지는 알림을 받고, 그 예외는 보고한다. */
  private emit() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        report(error);
      }
    }
  }

  private get info(): SessionInfo | null {
    return this.sessions.get(this.sessionId);
  }

  get loadGeneration() {
    return this.generation;
  }

  get editable() {
    return this.status.kind === "ready" && this.view !== null && !this.closing && this.renderLimit === null
      && this.renderFailedPages.length === 0;
  }

  /** 보내는 중이거나 보낼 연산이 있음. */
  get busy() {
    return this.inFlight || this.queue.length > 0;
  }

  get pendingOps() {
    return this.queue.length + (this.inFlight ? 1 : 0);
  }

  /** 저장되지 않은 편집: 확정한 변경(백엔드 dirty), 보내는 중·보낼 입력, 조합 중·입력기 끝을 기다리는 조합. */
  get hasUnpreservedChanges() {
    return (this.info?.dirty ?? false) || this.busy || this.composition !== null || this.provisional !== null;
  }

  setClosing(closing: boolean) {
    if (this.closing === closing || this.disposed) return;
    if (closing) this.provisional = null;
    this.closing = closing;
    this.emit();
  }

  // ---- 불러오기 ----

  /**
   * 엔진에 불러온다(identified·failed, 또는 사용자가 버리기를 확인한 ready). 동시에 두 번 부르면 같은 작업을 기다린다.
   * 저장하지 않은 편집이 있으면 `discard: true` 없이는 아무것도 하지 않고 UnpreservedChanges를 돌려준다.
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
    if (this.disposed) return { ok: false, error: closedError(this.sessionId) };
    const info = this.info;
    // 백엔드에 그 시도의 ready 모델이 있으면(편집 중 실패·사용자 확인) 백엔드가 버리고 다시 읽는다.
    const reload = info?.state === "ready" ? info.loadGeneration : undefined;
    const epoch = this.reset();
    this.setStatus({ kind: "loading" });
    this.loadStartedAt = performance.now();
    const result = await this.backend.load(this.sessionId, reload);
    if (epoch !== this.epoch) return { ok: false, error: closedError(this.sessionId) };
    if (!result.ok) {
      await this.fail(result.error);
      return result;
    }
    this.adopt(result.value.session, result.value.view);
    this.setStatus({ kind: "ready" });
    return { ok: true, value: null };
  }

  /**
   * WebView를 다시 시작한 뒤처럼 백엔드에 모델이 남은 세션(ready)에 다시 붙는다. 불러오는 중(loading)이면 끝날 때까지 기다린다.
   * 이미 붙었거나 그 밖의 상태면 아무것도 하지 않는다.
   */
  async resume(): Promise<void> {
    if (this.resuming || this.status.kind !== "idle" || this.disposed) return;
    this.resuming = true;
    const epoch = this.epoch;
    try {
      for (let poll = 0; poll < RESUME_POLLS; poll++) {
        const info = this.info;
        if (!info || epoch !== this.epoch) return;
        if (info.state === "ready" && info.loadGeneration > 0) {
          this.setStatus({ kind: "loading" });
          const result = await this.backend.view(this.sessionId, info.loadGeneration);
          if (epoch !== this.epoch) return;
          if (result.ok) {
            this.adopt(result.value.session, result.value.view);
            this.setStatus({ kind: "ready" });
          } else await this.fail(result.error);
          return;
        }
        if (info.state !== "loading") return;
        await new Promise((resolve) => setTimeout(resolve, RESUME_POLL_MS));
        await this.sessions.refresh(this.sessionId);
      }
    } finally {
      this.resuming = false;
    }
  }

  private reset(): number {
    this.epoch += 1;
    this.queue = [];
    this.inFlight = false;
    this.sending = [];
    this.composition = null;
    this.provisional = null;
    this.pointerAfterInsert = false;
    this.inputNotice = null;
    this.view = null;
    this.generation = 0;
    this.lastRoundTrip = null;
    this.rejectedOps = 0;
    this.firstPaintMs = null;
    this.checkSerial += 1;
    this.saveCheck = null;
    this.saveState = { kind: "idle" };
    this.releaseRendering();
    return this.epoch;
  }

  private adopt(session: SessionInfo, view: DocxView) {
    this.generation = session.loadGeneration;
    this.revision = session.revision;
    this.view = view;
    this.sessions.applyUpdate(session);
  }

  private setStatus(status: DocxStatus) {
    this.status = status;
    this.emit();
  }

  /** 기대하지 않은 거부: 편집을 멈추고 백엔드 기록을 다시 읽는다. 닫힌 세션이면 closed. */
  private async fail(error: DocumentError) {
    this.queue = [];
    this.inFlight = false;
    this.sending = [];
    this.composition = null;
    this.provisional = null;
    if (error.code === "StaleSession" || error.code === "UnknownSession") {
      this.setStatus({ kind: "closed" });
      await this.sessions.refresh(this.sessionId);
      return;
    }
    this.setStatus({ kind: "failed", error });
    await this.sessions.refresh(this.sessionId);
  }

  // ---- 편집 ----

  private push(op: DocxOp, settles = true): boolean {
    return this.pushAll([op], settles);
  }

  /** 연산들을 대기열에 순서대로 넣고 보낸다(한 입력의 조각들이 한 요청에 함께 가도록 한 번에). */
  private pushAll(ops: DocxOp[], settles = true): boolean {
    trace("docx:push", () => ({ session: this.sessionId, ops: ops.map((op) => op.op).join(","), editable: this.editable,
      settles, provisional: this.provisional !== null }));
    if (!this.editable) return false;
    if (settles) this.provisional = null;
    this.inputNotice = null;
    for (const op of ops) {
      if (op.op !== "insertText") this.pointerAfterInsert = false;
      const last = this.queue[this.queue.length - 1];
      // 끌기의 연속 위치는 마지막 것만 보내면 된다(같은 결과).
      if (op.op === "pointer" && op.extend && last?.op === "pointer" && last.extend) this.queue[this.queue.length - 1] = op;
      else this.queue.push(op);
    }
    void this.flush();
    return true;
  }

  private async flush() {
    if (this.inFlight || this.queue.length === 0 || this.status.kind !== "ready") return;
    const epoch = this.epoch;
    const batch = this.queue.splice(0, MAX_DOCX_OPS);
    this.inFlight = true;
    this.sending = batch;
    trace("docx:send", () => ({ session: this.sessionId, generation: this.generation, base: this.revision,
      ops: batch.map((op) => op.op).join(",") }));
    const result = await this.backend.edit(this.sessionId, this.generation, this.revision, batch);
    trace("docx:response", () => ({ session: this.sessionId, stale: epoch !== this.epoch, ok: result.ok,
      error: result.ok ? null : result.error.code, revision: result.ok ? result.value.session.revision : null,
      applied: result.ok ? result.value.applied : null, rejected: result.ok ? result.value.rejected.length : null }));
    if (epoch !== this.epoch) return;
    this.inFlight = false;
    this.sending = [];
    if (!result.ok) {
      await this.fail(result.error);
      return;
    }
    this.revision = result.value.session.revision;
    this.view = result.value.view;
    this.rejectedOps += result.value.rejected.length;
    const rejected = new Set(result.value.rejected);
    // 엔진이 명령(서식·실행 취소)을 거부했다(문서 보호 등): 그 연산은 없던 일이다. 했다고 보이지 않는다.
    if (batch.some((op, index) => COMMAND_OPS.has(op.op) && rejected.has(index))) this.inputNotice = "commandRejected";
    if (batch.some((op, index) => op.op === "pasteText" && rejected.has(index))) {
      // 엔진이 붙여넣기 조각을 거부했다(그 뒤 chain 조각은 백엔드가 건너뜀): 앞부분만 들어갔다. 다음 요청으로 넘어간 같은
      // 붙여넣기의 남은 조각도 보내지 않는다(같은 붙여넣기의 조각은 이어져 있고, 새 붙여넣기의 첫 조각은 chain이 아니다).
      this.inputNotice = "pasteIncomplete";
      if (batch.at(-1)?.op === "pasteText" && rejected.has(batch.length - 1)) {
        let rest = 0;
        while (this.queue[rest]?.op === "pasteText" && (this.queue[rest] as { chain: boolean }).chain) rest++;
        this.queue.splice(0, rest);
      }
    }
    this.sessions.applyUpdate(result.value.session);
    this.emit();
    void this.flush();
  }

  /** 일반 입력·붙여넣기. 넣을 수 없거나 한도를 넘으면 아무것도 넣지 않고 inputNotice로 알린다(false). */
  typeText(text: string): boolean {
    if (!text || this.composition || !this.editable) return false;
    const plan = textOps(text);
    if (!plan.ok) {
      this.inputNotice = plan.reason;
      this.emit();
      return false;
    }
    const notified = this.inputNotice !== null;
    const pushed = this.pushAll(plan.ops);
    if (notified) this.emit();
    return pushed;
  }

  backspace(): boolean {
    return this.push({ op: "backspace" });
  }

  deleteForward(): boolean {
    return this.push({ op: "deleteForward" });
  }

  enter(): boolean {
    return this.push({ op: "newParagraph" });
  }

  /** 표 안 셀 이동(마지막 셀에서는 WordCraft가 행을 더함). */
  tab(back: boolean): boolean {
    return this.push({ op: "tab", back });
  }

  move(to: MoveTarget, extend: boolean): boolean {
    return this.push({ op: "move", to, extend }, false);
  }

  selectAll(): boolean {
    return this.push({ op: "selectAll" }, false);
  }

  /** 쪽 좌표(pt)를 눌렀다·끌었다. */
  pointAt(page: number, x: number, y: number, extend: boolean): boolean {
    const beforeInsert = this.pointerAfterInsert;
    return this.push({ op: "pointer", page, x, y, extend, beforeInsert }, false);
  }

  // ---- IME(ImeSession) ----

  get composing() {
    return this.composition !== null;
  }

  get compositionText() {
    return this.composition?.text ?? "";
  }

  markCaret(): unknown {
    const id = this.nextMark++;
    return this.push({ op: "mark", id }, false) ? id : null;
  }

  beginComposition(): void {
    trace("docx:beginComposition", () => ({ session: this.sessionId, editable: this.editable, composing: this.composition !== null }));
    if (!this.editable || this.composition) return;
    this.provisional = null;
    this.composition = { text: "", shown: false };
    this.emit();
  }

  updateComposition(text: string): void {
    const composition = this.composition;
    if (!composition || composition.text === text) return;
    if (text && !composition.shown) {
      composition.shown = true;
      // 조합 글자가 처음 보인다: 보이던 선택을 지운다(조합 글자는 그 자리에 겹쳐 보인다). 지울지는 백엔드가 실행할 때의
      // 선택으로 정한다(그사이 접혔으면 아무것도 지우지 않음).
      if (this.view && !this.view.collapsed) this.push({ op: "deleteSelection" });
    }
    composition.text = text;
    this.emit();
  }

  endComposition(finalText: string, options: { provisional?: boolean } = {}): string {
    if (!this.composition) return "";
    this.composition = null;
    const inserted = finalText !== "" && this.push({ op: "insertText", text: finalText });
    trace("docx:endComposition", () => ({ session: this.sessionId, length: [...finalText].length, inserted,
      provisional: !!options.provisional }));
    if (inserted && options.provisional) {
      this.provisional = { text: finalText };
      this.pointerAfterInsert = true;
    }
    this.emit();
    return inserted ? finalText : "";
  }

  resolveProvisional(finalText?: string): void {
    const provisional = this.provisional;
    trace("docx:resolveProvisional", () => ({ session: this.sessionId, pending: provisional !== null,
      finalLength: finalText === undefined ? null : [...finalText].length,
      replace: provisional !== null && finalText !== undefined && finalText !== "" && finalText !== provisional.text }));
    if (!provisional) return;
    this.provisional = null;
    if (finalText !== undefined && finalText !== "" && finalText !== provisional.text) {
      this.push({ op: "replaceInserted", expected: provisional.text, text: finalText });
    }
    this.emit();
  }

  insertCommittedAt(at: unknown, text: string): boolean {
    trace("docx:insertCommittedAt", () => ({ session: this.sessionId, length: [...text].length, composing: this.composition !== null,
      mark: typeof at === "number" }));
    if (!text || this.composition || typeof at !== "number") return false;
    return this.push({ op: "insertAt", mark: at, text });
  }

  // ---- 그림 ----

  /** 이 배율(pt당 픽셀)로 모든 쪽을 예산 안에서 그릴 수 있는지. */
  fitsScale(scale: number): boolean {
    return (this.view?.pages ?? []).every((page) => Math.ceil(page.width * scale) * Math.ceil(page.height * scale) <= MAX_PAGE_PIXELS);
  }

  /** 표면이 그릴 배율을 알린다. 예산을 넘으면 그리지 않고 편집을 멈춘다(배율을 낮추면 이어 감). */
  setScale(scale: number): boolean {
    this.scale = scale;
    const fits = this.fitsScale(scale);
    const limit = fits ? null : scale;
    if (limit !== this.renderLimit) {
      if (limit !== null && this.composition) this.endComposition(this.composition.text);
      this.renderLimit = limit;
      this.emit();
    }
    return fits;
  }

  /** 쪽의 지금 그림 판(없으면 null). 지금 판이 아닐 수 있다. */
  pageRevision(page: number): number | null {
    return this.rasters.get(page)?.revision ?? null;
  }

  /** 쪽 그림(화면 밖 래스터)이 지금 모델·배율의 것인지. */
  isCurrent(page: number, scale: number): boolean {
    const raster = this.rasters.get(page);
    return !!raster && raster.generation === this.generation && raster.revision === this.revision && raster.scale === scale;
  }

  /** 쪽 그림이 지금 판이고, 그 쪽의 활성 화면 canvas에 그 래스터·판을 실제로 옮겼는지(화면에 보이는 판). */
  isShown(page: number, scale: number): boolean {
    const raster = this.rasters.get(page);
    const canvas = this.screens.get(page);
    const shown = canvas && this.painted.get(canvas);
    return this.isCurrent(page, scale) && !!raster && !!shown && shown.raster === raster && shown.revision === raster.revision
      && !this.paintFailures.has(page);
  }

  /** 그림 실패의 비교 키(시도:판:배율). */
  private renderKey(scale: number, generation = this.generation, revision = this.revision) {
    return `${generation}:${revision}:${scale}`;
  }

  /** 다시 시도해도 그리지 못한(보이는) 쪽. 지금 판으로 그려질 때까지 편집을 멈춘다. */
  get renderFailedPages(): number[] {
    if (this.failures.size === 0 && this.paintFailures.size === 0) return [];
    const pages = new Set<number>();
    for (const map of [this.failures, this.paintFailures]) for (const [page, failure] of map) if (failure.blocking) pages.add(page);
    return [...pages].sort((a, b) => a - b);
  }

  /** 그리지 못한 쪽을 처음부터 다시 받고 화면에 다시 옮긴다(사용자가 다시 그리기를 고름). 그려질 때까지 편집은 멈춘 채다. */
  retryRendering() {
    for (const failure of [...this.failures.values(), ...this.paintFailures.values()]) {
      failure.attempts = 0;
      failure.retryAt = 0;
    }
    this.emit();
  }

  /**
   * 지금 판·배율의 그림이 없는 쪽을 백엔드에 그려 달라고 한다(쪽마다 판 하나에 한 번). 같은 배율의 앞 판 그림이 있으면 그 판을
   * 기준으로 보내 바뀐 띠만 받는다. pages는 지금 보이는 쪽(과 커서 쪽)이다: 래스터 예산에서 놓지 않는다.
   */
  requestPages(pages: number[], scale: number) {
    if (this.status.kind !== "ready" || this.renderLimit !== null) return;
    this.scale = scale;
    this.wanted = new Set(pages);
    // 보이지 않게 된 쪽의 실패는 잊는다(다시 보이면 그때의 판으로 새로 받는다).
    for (const map of [this.failures, this.paintFailures]) for (const page of map.keys()) if (!this.wanted.has(page)) map.delete(page);
    for (const page of pages) {
      if (this.isCurrent(page, scale)) continue;
      const { generation, revision } = { generation: this.generation, revision: this.revision };
      const failureKey = this.renderKey(scale);
      const failure = this.failures.get(page);
      if (failure && failure.key !== failureKey) {
        // 판·배율이 바뀌었다: 새 상태로 다시 시도한다. 멈춘 편집은 그려질 때까지 그대로다.
        if (failure.blocking) Object.assign(failure, { key: failureKey, attempts: 0, retryAt: 0 });
        else this.failures.delete(page);
      } else if (failure && (failure.attempts >= MAX_RENDER_ATTEMPTS || performance.now() < failure.retryAt)) continue;
      const held = this.rasters.get(page);
      const base = held && held.generation === generation && held.scale === scale ? held.revision : undefined;
      const key = `${generation}:${revision}:${page}:${scale}:${base ?? ""}`;
      if (this.rendering.has(key)) continue;
      const request = {};
      this.rendering.set(key, request);
      void this.renderPage(page, { generation, revision, scale, base, failureKey })
        .catch(report) // 실패를 세다 난 예외: 숨기지 않는다(기록은 아래에서 이 요청 것만 지움)
        .finally(() => {
          if (this.rendering.get(key) === request) this.rendering.delete(key);
        });
    }
  }

  /**
   * 쪽 하나를 받아 래스터에 반영한다. 응답 뒤·디코드 뒤마다 이 요청이 아직 쓸모 있는지 본다: 옛 시도(epoch)·놓은 그림 수명·이미
   * 멈춘 편집기(failed·closed: 그 원인을 늦은 그림 오류로 덮지 않음)의 결과는 래스터·실패 상태를 바꾸지 않고 버린다.
   */
  private async renderPage(page: number, request: { generation: number; revision: number; scale: number; base: number | undefined; failureKey: string }) {
    const { generation, revision, scale, base, failureKey } = request;
    const { epoch, renderLife } = this;
    const live = () => epoch === this.epoch && renderLife === this.renderLife && this.status.kind === "ready";
    let bitmap: ImageBitmap | null = null;
    try {
      let result: Result<DocxRender>;
      try {
        result = await this.backend.render(this.sessionId, generation, revision, page, scale, base);
      } catch {
        result = { ok: false, error: { code: "Protocol" } }; // IPC 호출 자체가 거부됨
      }
      if (!live()) return;
      if (!result.ok) {
        this.renderRejected(page, failureKey, revision, result.error);
        return;
      }
      const { base: from, y, height, png } = result.value;
      if (height > 0) {
        try {
          bitmap = await this.decode(png);
        } catch {
          bitmap = null;
        }
      }
      if (!live()) return;
      if (height > 0 && !bitmap) {
        this.renderFailed(page, failureKey, "decode");
        return;
      }
      const applied = this.applyRender(page, { generation, revision, scale, from, y, height, bitmap });
      if (applied === "applied") {
        if (this.failures.get(page)?.key === failureKey) this.failures.delete(page); // 멈춤도 풀린다
        this.trimRasters();
        this.emit();
      } else if (applied !== "stale") this.renderFailed(page, failureKey, applied);
    } catch (error) {
      // 기대하지 않은 예외: 지금 요청인데 그 쪽이 지금 판이 아니면 그 쪽 실패로 센다(옛 요청은 지금 상태를 바꾸지 않음).
      report(error);
      if (live() && !this.isCurrent(page, scale)) this.renderFailed(page, failureKey, "unexpected");
    } finally {
      try {
        bitmap?.close();
      } catch (error) {
        report(error); // 앞의 결과·오류를 덮지 않는다
      }
    }
  }

  /** 백엔드가 그림을 거부했다. 옛 판(보내는 중인 편집이 판을 바꿈)은 새 판의 요청이 대신한다. */
  private renderRejected(page: number, key: string, revision: number, error: DocumentError) {
    if (error.code === "RevisionMismatch" && (revision !== this.revision || this.busy)) return;
    if (SESSION_ERRORS.has(error.code)) {
      void this.fail(error);
      return;
    }
    this.renderFailed(page, key, "backend");
  }

  /** 쪽의 지금 판 그림이 실패했다. 간격을 두고 다시 받고, 다 쓰면 그리지 못한 쪽으로 보이며 편집을 멈춘다. */
  private renderFailed(page: number, key: string, reason: RenderFailureReason) {
    const previous = this.failures.get(page);
    // 옛 상태(그사이 판·배율이 바뀜)의 늦은 실패는 지금 상태의 시도로 세지 않는다.
    if (previous && previous.key !== key && (this.scale === null || key !== this.renderKey(this.scale))) return;
    const attempts = previous?.key === key ? previous.attempts + 1 : 1;
    const delay = RENDER_RETRY_MS * attempts;
    const stops = attempts >= MAX_RENDER_ATTEMPTS && !previous?.blocking;
    // 편집을 멈추기 전에 보이는 조합은 그 자리에 확정한다(표시 한도와 같음).
    if (stops && this.composition) this.endComposition(this.composition.text);
    const blocking = attempts >= MAX_RENDER_ATTEMPTS || (previous?.blocking ?? false);
    this.failures.set(page, { key, attempts, reason, retryAt: performance.now() + delay, blocking });
    if (attempts < MAX_RENDER_ATTEMPTS) {
      this.emitLater(delay); // 표면이 다시 요청한다
      return;
    }
    this.emit();
  }

  /** 간격 뒤 알린다(같은 모델·그림 수명일 때만). 표면이 다시 요청하거나 다시 그린다. */
  private emitLater(delay: number) {
    const { epoch, renderLife } = this;
    setTimeout(() => {
      if (epoch === this.epoch && renderLife === this.renderLife) this.emit();
    }, delay);
  }

  /**
   * 받은 쪽 그림(전체 또는 띠)을 쪽 래스터에 반영한다. 옛 판이거나 띠의 기준 판이 지금 래스터가 아니면 버린다(stale, 다음 요청이
   * 맞춘다). canvas 문맥이 없거나 크기가 맞지 않으면 반영하지 않고 실패로 알린다. canvas 만들기·크기·문맥·그리기가 예외를 내면
   * 그 쪽 래스터를 놓는다(반쯤 덮었거나 크기를 바꿔 지워졌을 수 있음: 다음 요청은 쪽 전체를 받는다).
   */
  private applyRender(page: number, render: { generation: number; revision: number; scale: number; from: number | null; y: number; height: number; bitmap: ImageBitmap | null }): "applied" | "stale" | "canvas" | "size" {
    const { generation, revision, scale, from, y, height, bitmap } = render;
    const current = this.rasters.get(page);
    let backing: HTMLCanvasElement | null = null;
    const drop = () => {
      if (this.rasters.get(page)?.backing === backing) this.rasters.delete(page);
      if (backing) releaseCanvas(backing);
    };
    try {
      if (from === null) {
        if (!bitmap) return "size";
        if (bitmap.height !== height || bitmap.width === 0) return "size";
        if (current && current.generation === generation && current.scale === scale && current.revision >= revision) return "stale";
        backing = current?.backing ?? this.createCanvas();
        if (backing.width !== bitmap.width) backing.width = bitmap.width;
        if (backing.height !== bitmap.height) backing.height = bitmap.height;
        const context = backing.getContext("2d");
        if (!context) {
          drop();
          return "canvas";
        }
        context.drawImage(bitmap, 0, 0);
        this.rasters.delete(page); // 최근에 쓴 것을 맨 뒤로(래스터 예산)
        this.rasters.set(page, { generation, revision, scale, backing, width: bitmap.width, height: bitmap.height, bands: [], full: revision });
        return "applied";
      }
      if (!current || current.generation !== generation || current.scale !== scale || current.revision !== from) return "stale";
      if (bitmap) {
        if (bitmap.width !== current.width || bitmap.height !== height || y + height > current.height) return "size";
        backing = current.backing;
        const context = backing.getContext("2d");
        if (!context) return "canvas";
        context.drawImage(bitmap, 0, y);
      } else if (height !== 0) return "size";
    } catch {
      drop();
      return "canvas";
    }
    current.bands.push({ from, to: revision, y, height });
    if (current.bands.length > MAX_BANDS) current.bands.shift();
    current.revision = revision;
    this.rasters.delete(page);
    this.rasters.set(page, current);
    return "applied";
  }

  /** 래스터 예산을 넘으면 지금 요청한 쪽이 아닌 것부터 오래 쓰지 않은 순으로 놓는다. */
  private trimRasters() {
    let total = 0;
    for (const raster of this.rasters.values()) total += raster.width * raster.height;
    for (const [page, raster] of this.rasters) {
      if (total <= MAX_RETAINED_PIXELS) break;
      if (this.wanted.has(page)) continue;
      total -= raster.width * raster.height;
      this.rasters.delete(page);
      releaseCanvas(raster.backing);
    }
  }

  /**
   * 쪽 래스터를 canvas에 옮긴다. 이 canvas가 같은 래스터의 앞 판을 보이고 있으면 그 뒤 바뀐 띠만 옮기고(키 하나에 Canvas 전체를
   * 다시 합성하지 않음, T007의 띠 다시 그리기와 같은 이유), 아니면 전체를 옮긴다. 실제로 옮겼을 때만 그 판을 보인다고 기록하고
   * 처음 그린 시간을 남긴다. 옮기지 못하면(문맥 없음·예외) 화면 그리기 실패로 세고, 간격 뒤 같은 래스터를 다시 옮겨 본다.
   */
  paint(page: number, canvas: HTMLCanvasElement) {
    this.screens.set(page, canvas);
    const raster = this.rasters.get(page);
    if (!raster) {
      // 놓은 쪽(래스터 예산·다시 불러오기): 화면 canvas의 그림도 놓는다.
      if (canvas.width !== 0 || canvas.height !== 0) {
        this.painted.delete(canvas);
        releaseCanvas(canvas);
      }
      return;
    }
    const shown = this.painted.get(canvas);
    if (shown && shown.raster === raster && shown.revision === raster.revision) return;
    const failure = this.paintFailures.get(page);
    const retrying = failure && failure.raster === raster && failure.revision === raster.revision;
    // 같은 래스터·판을 이미 다 시도했거나 간격 전이면 기다린다(새 판이면 다시 시도한다).
    if (retrying && (failure.attempts >= MAX_RENDER_ATTEMPTS || performance.now() < failure.retryAt)) return;
    if (!this.copy(raster, canvas, shown)) {
      this.painted.delete(canvas); // 지워졌거나 반쯤 옮겼을 수 있다: 다음에는 쪽 전체
      this.paintFailed(page, raster);
      return;
    }
    this.painted.set(canvas, { raster, revision: raster.revision });
    let changed = this.paintFailures.delete(page); // 멈춤도 풀린다
    if (this.firstPaintMs === null) {
      this.firstPaintMs = performance.now() - this.loadStartedAt;
      changed = true; // 처음 한 번(진단 표시)
    }
    if (changed) this.emit();
  }

  /** 래스터를 화면 canvas에 옮긴다(앞 판을 보이면 그 뒤 띠만). 문맥이 없거나 예외가 나면 false. */
  private copy(raster: PageRaster, canvas: HTMLCanvasElement, shown: { raster: PageRaster; revision: number } | undefined): boolean {
    try {
      const context = canvas.getContext("2d");
      if (!context) return false;
      // 크기가 같으면 bitmap을 다시 잡지 않는다(width를 다시 넣으면 저장소를 새로 잡고 Canvas 전체를 다시 합성).
      const resized = canvas.width !== raster.width || canvas.height !== raster.height;
      if (canvas.width !== raster.width) canvas.width = raster.width;
      if (canvas.height !== raster.height) canvas.height = raster.height;
      const since = shown && shown.raster === raster && !resized && shown.revision >= raster.full
        ? raster.bands.findIndex((band) => band.from === shown.revision)
        : -1;
      if (since >= 0) {
        const bands = raster.bands.slice(since);
        const top = Math.min(...bands.map((band) => band.y));
        const bottom = Math.max(...bands.map((band) => band.y + band.height));
        if (bottom > top) context.drawImage(raster.backing, 0, top, raster.width, bottom - top, 0, top, raster.width, bottom - top);
      } else {
        context.drawImage(raster.backing, 0, 0);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 쪽 래스터를 화면 canvas에 옮기지 못했다(PNG는 다시 받지 않음). 보이는 쪽만 센다: 간격을 두고 MAX_RENDER_ATTEMPTS번까지 다시
   * 옮겨 보고, 다 쓰면 그리지 못한 쪽으로 보이며 편집을 멈춘다. 멈춘 뒤 판이 바뀌면 새 판으로 다시 시도하되 그릴 때까지 멈춘 채다.
   */
  private paintFailed(page: number, raster: PageRaster) {
    if (!this.wanted.has(page)) return; // 보이지 않는 쪽: 다음 그리기에서 다시 옮긴다(멈추지 않음)
    const previous = this.paintFailures.get(page);
    const same = previous && previous.raster === raster && previous.revision === raster.revision;
    const attempts = same ? previous.attempts + 1 : 1;
    const stops = attempts >= MAX_RENDER_ATTEMPTS && !previous?.blocking;
    // 편집을 멈추기 전에 보이는 조합은 그 자리에 확정한다(백엔드 그림 실패와 같음).
    if (stops && this.composition) this.endComposition(this.composition.text);
    const blocking = attempts >= MAX_RENDER_ATTEMPTS || (previous?.blocking ?? false);
    const delay = RENDER_RETRY_MS * attempts;
    this.paintFailures.set(page, { raster, revision: raster.revision, attempts, retryAt: performance.now() + delay, blocking });
    if (attempts < MAX_RENDER_ATTEMPTS) this.emitLater(delay); // 표면이 다시 그린다
    this.emit();
  }

  /**
   * 모든 쪽 래스터를 놓는다(표면이 사라짐·다시 불러오기). 다시 요청하면 쪽 전체를 새로 받는다. 그림 수명을 바꿔 보내던 요청의 늦은
   * 결과가 래스터를 다시 만들거나 실패로 세지 않게 한다(편집·조합·revision은 그대로).
   */
  releaseRendering() {
    this.renderLife += 1;
    for (const raster of this.rasters.values()) releaseCanvas(raster.backing);
    this.rasters.clear();
    this.screens.clear();
    this.rendering.clear();
    this.failures.clear();
    this.paintFailures.clear();
    this.wanted = new Set();
  }

  // ---- 명령(T010) ----

  /** 명령 가용성을 정하는 지금 상태. 기록·서식은 마지막 응답의 엔진 보기다(보낼 편집 뒤에는 엔진이 다시 정한다). */
  snapshot(): DocumentCommandSnapshot {
    return {
      sessionId: this.sessionId, engine: this.engine, loadGeneration: this.generation, revision: this.revision,
      loaded: this.status.kind === "ready" && !this.closing, editable: this.editable,
      composing: this.composition !== null || this.provisional !== null, pending: this.busy,
      queuedHistory: this.queuedHistory(), saving: this.saving,
      history: this.view?.history ?? null, format: this.view?.format ?? null, formatAccess: this.view?.formatAccess ?? null,
    };
  }

  /**
   * 보내는 중·보낼 연산을 엔진 기록에 차례로 적용한 예상(DocumentCommandSnapshot.queuedHistory). 대기 연산이 없으면 null.
   * 방향마다 "알고 있는 최소 단계 수"와 "그보다 더 있을 수 있는지"만 센다(엔진 보기는 단계가 있는지만 알려 주고, 타자는 한 단계로
   * 묶이므로 단계 수를 앱이 정할 수 없다 — 기록을 따로 만들지 않음):
   * - 엔진 보기에 단계가 있으면 최소 1, 더 있을 수 있음.
   * - 바꾸는 연산: 실행 취소 단계가 적어도 하나(새 단계 또는 이어 친 묶음), 더 있을 수 있음. 다시 실행 기록은 버린다(성공하면
   *   엔진이 버림. 엔진이 거부하면 남지만 그때는 응답 뒤 보기로 맞춘다 — 여기서는 없다고 보아 넘치는 다시 실행을 막는다).
   * - 실행 취소: 아는 단계가 있으면 하나를 쓰고 다시 실행 단계를 하나 더한다. 아는 단계가 없고 더 있을 수만 있으면 결과를 모른다.
   *   다시 실행도 같다(방향만 반대).
   * - 이동·클릭·선택·표지는 기록을 바꾸지 않는다.
   * 예상이 어긋나도(엔진이 거부한 넣기, 보호를 푸는 단계) 엔진이 다시 확인해 아무것도 바꾸지 않는다.
   */
  private queuedHistory(): { undo: QueuedStep; redo: QueuedStep } | null {
    const pending = [...this.sending, ...this.queue];
    if (pending.length === 0 || !this.view) return null;
    const known = (available: boolean) => ({ min: available ? 1 : 0, more: available });
    let undo = known(this.view.history.undo);
    let redo = known(this.view.history.redo);
    const step = (from: { min: number; more: boolean }, to: { min: number; more: boolean }) => {
      if (from.min > 0) {
        from.min -= 1;
        to.min += 1;
      } else if (from.more) {
        to.more = true; // 썼는지 모른다: 반대 방향도 생겼을 수만 있다
      }
    };
    for (const { op } of pending) {
      if (op === "undo") step(undo, redo);
      else if (op === "redo") step(redo, undo);
      else if (MUTATING_OPS.has(op)) [undo, redo] = [{ min: Math.max(undo.min, 1), more: true }, known(false)];
    }
    const state = ({ min, more }: { min: number; more: boolean }): QueuedStep =>
      min > 0 ? "available" : more ? "unknown" : "none";
    return { undo: state(undo), redo: state(redo) };
  }

  /** 명령을 이 세션의 편집 경로에 넣는다. 지금 상태로 다시 확인해 할 수 없으면 아무것도 바꾸지 않는다. */
  execute(command: DocumentCommandId): CommandDispatch {
    if (!documentCommandState(command, this.snapshot()).available) return { accepted: false };
    if (command === "file.save") {
      void this.save();
      return { accepted: true };
    }
    const flag = FORMAT_FLAG[command];
    const op: DocxOp | null = command === "edit.undo" ? { op: "undo" } : command === "edit.redo" ? { op: "redo" }
      : flag ? { op: "format", format: flag } : null;
    return { accepted: op !== null && this.push(op) };
  }

  // ---- 저장(T009) ----

  private setSave(state: SaveState) {
    this.saveState = state;
    this.emit();
  }

  private saveBlocker(): DocumentError | null {
    if (this.status.kind !== "ready" || this.closing) return { code: "SaveNotReady", reason: "state" };
    if (this.composition || this.provisional) return { code: "SaveNotReady", reason: "composing" };
    if (this.busy) return { code: "SaveNotReady", reason: "pending" };
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
    if (epoch === this.epoch && serial === this.checkSerial) {
      this.setSave(checked.ok ? { kind: "idle" } : { kind: "failed", error: checked.error });
    }
    return checked;
  }

  /** 보존 사전 검사(백엔드가 원본을 다시 읽어 편집 없는 WordCraft 왕복과 비교). 결과는 `serial`이 아직 지금 요청일 때만 기억한다. */
  private async preflight(serial: number): Promise<Result<SaveCheck>> {
    if (this.status.kind !== "ready") return { ok: false, error: { code: "SaveNotReady", reason: "state" } };
    const { epoch, generation } = this;
    const checked = await this.backend.preflight(this.sessionId, generation);
    if (epoch !== this.epoch) return { ok: false, error: closedError(this.sessionId) };
    if (checked.ok && serial === this.checkSerial) {
      this.saveCheck = { generation, check: checked.value };
      this.emit();
    }
    return checked;
  }

  /** 원본 형식으로 저장한다(모듈 설명). */
  async save(): Promise<Result<SaveOutcome>> {
    const epoch = this.epoch;
    const fail = (error: DocumentError): Result<SaveOutcome> => {
      if (epoch === this.epoch) this.setSave({ kind: "failed", error });
      return { ok: false, error };
    };
    if (this.saving) return { ok: false, error: { code: "SaveInProgress", sessionId: this.sessionId } };
    const blocker = this.saveBlocker();
    if (blocker) return fail(blocker);
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
      const later = this.saveBlocker();
      if (later) return fail(later);
      const revision = this.revision;
      this.setSave({ kind: "saving" });
      const result = await this.backend.save(this.sessionId, generation, revision);
      if (epoch !== this.epoch) return result;
      if (!result.ok) return fail(result.error);
      this.sessions.applyUpdate(result.value.session);
      // 원본이 바뀌었다(내구성을 확인하지 못했어도 교체는 됨, dirty는 백엔드가 남김): 다음 저장은 새 원본으로 다시 검사하고,
      // 그 전에 시작한 검사의 늦은 결과도 버린다.
      this.checkSerial += 1;
      this.saveCheck = null;
      const changedSince = this.revision !== revision || this.busy || this.composition !== null;
      this.setSave({ kind: "saved", revision, durable: result.value.durable, changedSince });
      return result;
    } finally {
      this.saving = false;
    }
  }

  // ---- 검사 ----

  /** 메모리 안 내보내기 → 다시 읽기 비교(디스크에 쓰지 않음). 보내는 중인 입력이 있으면 하지 않는다. */
  async roundTrip(): Promise<Result<DocxRoundTrip>> {
    if (this.status.kind !== "ready" || this.busy) return { ok: false, error: { code: "InvalidRequest" } };
    const epoch = this.epoch;
    const revision = this.revision;
    const result = await this.backend.roundTrip(this.sessionId, this.generation, revision);
    if (epoch !== this.epoch) return { ok: false, error: closedError(this.sessionId) };
    // 결과는 검사한 판에 대한 것이다. 그사이 문서가 바뀌었으면 보이지 않는다.
    this.lastRoundTrip = result.ok && this.revision === revision ? result.value : null;
    this.emit();
    return result;
  }

  get roundTripCurrent() {
    return this.lastRoundTrip !== null && this.lastRoundTrip.revision === this.revision;
  }

  recordLatency(milliseconds: number) {
    this.samples.push(milliseconds);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    this.emit();
  }

  /** 기록한 지연 표본(오래된 것부터, 최대 MAX_SAMPLES). 검사 훅 빌드의 진단용. */
  latencySamples(): readonly number[] {
    return this.samples;
  }

  latency(): LatencyStats | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
    return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1]! };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
    this.status = { kind: "closed" };
    this.emit();
    this.listeners.clear();
  }
}
