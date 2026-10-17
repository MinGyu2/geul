// rhwp 편집 세션 하나(T007, R-A). WebView의 WASM 문서 모델·커서·선택·IME 조합 상태를 가지고, 문서를 바꾼 결과를
// 백엔드에 revision으로 확정한다.
//
// 소유와 순서(docs/architecture/editor-surface-decision.md "T007 결과"):
// - 세션 ID·수명주기·revision의 권한은 백엔드(SessionRegistry)에 있다. 이 객체는 세션마다 하나뿐인 쓰는 쪽이며,
//   WASM 호출은 JS 스레드에서 동기로 끝나므로 같은 세션의 변경은 일어난 순서대로 하나씩 적용된다.
// - 변경이 성공하면 pending을 1 늘리고, 확정은 한 번에 하나만 보낸다(base = 백엔드가 마지막으로 확인한 revision,
//   count = 그 뒤 성공한 변경 수). 응답을 기다리는 동안의 변경은 다음 확정에 묶인다. 그래서 확정이 순서를 바꿔
//   도착하거나 중복될 수 없고, revision은 성공한 변경마다 정확히 1씩 는다(다시 그리기·선택·실패한 변경은 확정 안 함).
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
// - 저장이 없으므로(T009) 편집한 모델(확정했거나 확정 대기·조합 중인 변경)은 닫기·다시 불러오기 전에 사용자가
//   버리기를 명시해야 한다(`hasUnpreservedChanges`, `load({ discard })`).
// - IME 조합 중에는 조합 문자열을 문서에 바로 넣어 보여 주고(rhwp-studio와 같은 방식), 조합이 끝날 때 한 번만 변경으로
//   센다. 조합이 글자 없이 끝나면(취소) 넣었던 글자를 지우므로 변경이 아니다. 선택을 지우고 시작한 조합은 변경이다.
// - 저장은 없다(T009). 내보내기 검사는 메모리에서만 내보내고 다시 열어 비교한다(파일을 쓰지 않음).
import type { DocumentBackend } from "../../../adapters/backend";
import type { DocumentError, Result, SessionInfo } from "../../../adapters/contract";
import type { DocumentSessions } from "../../../adapters/sessions";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
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

const LOADED = { ok: true, value: null } as const;

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
export const MAX_PAGE_EXTENT = 16_384;

const isPageExtent = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_PAGE_EXTENT;

/**
 * 문서의 페이지 크기 목록. 엔진 오류는 그대로 던지고, 계약에 맞지 않는 값도 던진다(호출하는 쪽이 단계별 실패로 다룸).
 * - 쪽 수는 1 이상의 정수다(rhwp page_count는 빈 문서도 1을 돌려준다). 쪽마다 엔진에 실제로 묻으므로 쪽 수에 따른
 *   할당은 엔진이 가진 페이지만큼이다(임의의 쪽 수 상한은 두지 않음).
 * - 쪽 정보는 JSON 객체이고 pageIndex가 그 쪽 번호, width·height가 유한한 양수(MAX_PAGE_EXTENT 이하)다. 0·빈 값으로
 *   바꿔 넣지 않는다.
 */
function readPages(doc: RhwpDocument): PageSize[] {
  const count = doc.pageCount();
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("page count");
  const pages: PageSize[] = [];
  for (let page = 0; page < count; page++) {
    const info: unknown = JSON.parse(doc.getPageInfo(page));
    if (typeof info !== "object" || info === null || Array.isArray(info)) throw new Error("page info");
    const { pageIndex, width, height } = info as { pageIndex?: unknown; width?: unknown; height?: unknown };
    if (pageIndex !== page || !isPageExtent(width) || !isPageExtent(height)) throw new Error("page info");
    pages.push({ width, height });
  }
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

export class RhwpEditorSession {
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

  private doc: RhwpDocument | null = null;
  private text: RhwpText | null = null;
  private module: RhwpModule | null = null;
  private preferredX = -1;
  private committed = 0;
  private pending = 0;
  private committing = false;
  /** 지금 모델을 만든 불러오기 시도 번호(백엔드가 준 값, 0 = 없음). */
  private generation = 0;
  /** 지금 모델을 불러온 뒤 문서를 바꾼 적이 있음(성공한 변경, 확정 여부와 무관, 실패해도 유지). */
  private modified = false;
  /** 엔진 편집 함수가 예외를 던져 모델이 일부만 바뀌었을 수 있음(성공한 변경으로 세지 않음). */
  private uncertain = false;
  private loadingPromise: Promise<Result<null>> | null = null;
  private closing = false;
  private disposed = false;
  private composition: { anchor: DocPosition; text: string; deletedSelection: boolean } | null = null;
  private readonly samples: number[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly sessionId: number,
    private readonly backend: DocumentBackend,
    private readonly sessions: DocumentSessions,
    private readonly loadModule: () => Promise<RhwpModule>,
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
    return this.status.kind === "ready" && this.doc !== null && !this.closing;
  }

  /** 닫는 중에는 편집을 막는다(백엔드 닫기가 실패하면 false로 되돌려 다시 편집할 수 있다). */
  setClosing(closing: boolean) {
    if (this.closing === closing || this.disposed) return;
    this.closing = closing;
    this.emit();
  }

  get composing() {
    return this.composition !== null;
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
   * 저장하지 않은 편집이 이 모델에 있음: 불러온 뒤 바꾼 적이 있거나, 바뀌었는지 알 수 없거나(편집 중 엔진 예외),
   * 확정을 기다리거나 보내는 중이거나, 조합 중.
   * 저장 기능이 없으므로(T009) 닫기·다시 불러오기는 사용자가 버리기를 명시해야 한다.
   */
  get hasUnpreservedChanges() {
    return this.doc !== null
      && (this.modified || this.uncertain || this.pending > 0 || this.committing || this.composition !== null);
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
    this.releaseDocument();
    this.generation = 0;
    this.modified = false;
    this.uncertain = false;
    this.pending = 0;
    this.lastRoundTrip = null;
    this.pages = [];
    this.status = { kind: "loading" };
    this.firstPaintMs = null;
    this.emit();
    const loaded = await this.backend.load(this.sessionId);
    if (this.disposed) return closed;
    void this.sessions.refresh(this.sessionId); // loading(또는 실패 시 failed) 상태를 투영에 반영
    if (!loaded.ok) {
      this.setStatus({ kind: "failed", error: loaded.error });
      return loaded;
    }
    const generation = loaded.value.generation;
    this.loadStartedAt = performance.now();
    let doc: RhwpDocument;
    try {
      this.module ??= await this.loadModule();
    } catch {
      return this.failLoading(generation, { code: "EngineFailure", engine: "rhwp", stage: "init" });
    }
    if (this.disposed) return closed;
    try {
      doc = this.module.openDocument(loaded.value.bytes);
    } catch {
      return this.failLoading(generation, { code: "EngineFailure", engine: "rhwp", stage: "parse" });
    }
    // ready를 요청하기 전에 화면에 필요한 정보(페이지 크기)를 모두 얻고 검사한다. 엔진이 문서를 읽었더라도 페이지
    // 정보가 없거나 잘못되면 그릴 준비가 안 된 것이므로(render 단계) ready가 되지 않는다.
    let pages: PageSize[];
    try {
      pages = readPages(doc);
    } catch {
      doc.free();
      return this.failLoading(generation, { code: "EngineFailure", engine: "rhwp", stage: "render" });
    }
    if (this.disposed) {
      doc.free();
      return closed;
    }
    const ready = await this.backend.setState(this.sessionId, generation, "loading", "ready");
    if (this.disposed) {
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

  private async failLoading(generation: number, error: DocumentError): Promise<Result<null>> {
    const failed = await this.backend.setState(this.sessionId, generation, "loading", "failed");
    if (this.disposed) return { ok: false, error };
    if (failed.ok) this.sessions.applyUpdate(failed.value);
    this.setStatus({ kind: "failed", error });
    return { ok: false, error };
  }

  private setStatus(status: EditorStatus) {
    this.status = status;
    this.emit();
  }

  /**
   * 렌더링(표면이 부른다). 엔진이 그리지 못하면 빈 편집 영역을 정상처럼 두지 않고 편집을 멈춘다(render 단계 실패).
   */
  renderPage(page: number, canvas: HTMLCanvasElement, scale: number): boolean {
    if (!this.doc) return false;
    try {
      this.doc.renderPageToCanvas(page, canvas, scale);
      if (page === 0 && this.firstPaintMs === null) {
        this.firstPaintMs = performance.now() - this.loadStartedAt;
        queueMicrotask(() => this.emit()); // 그리는 중이 아니라 다음에 상태 표시를 갱신
      }
      return true;
    } catch {
      if (this.status.kind === "ready") void this.markFailed({ code: "EngineFailure", engine: "rhwp", stage: "render" });
      return false;
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
  private mutate(apply: Mutation, count = true): boolean {
    if (!this.editable || !this.doc) return false;
    const doc = this.doc;
    let next: ReturnType<Mutation>;
    try {
      next = apply();
    } catch {
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
    try {
      this.pages = readPages(doc);
    } catch {
      void this.markFailed({ code: "EngineFailure", engine: "rhwp", stage: "render" });
      return true;
    }
    this.emit();
    return true;
  }

  private recordMutation() {
    this.modified = true;
    this.pending += 1;
    void this.flushCommits();
  }

  private deleteSelectionRaw(): DocPosition {
    const [from, to] = this.ordered();
    this.text!.deleteRange(from, to);
    return from;
  }

  typeText(text: string): boolean {
    if (!text || this.composition) return false;
    return this.mutate(() => {
      const at = this.hasSelection ? this.deleteSelectionRaw() : this.caret;
      this.text!.insert(at, text);
      return { ...at, offset: at.offset + charCount(text) };
    });
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
      });
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
      });
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

  beginComposition(): void {
    if (!this.editable || this.composition) return;
    let deletedSelection = false;
    if (this.hasSelection) {
      if (!this.mutate(() => this.deleteSelectionRaw(), false)) return;
      deletedSelection = true;
    }
    this.composition = { anchor: this.caret, text: "", deletedSelection };
  }

  /** 조합 문자열이 바뀌었다(입력 이벤트). 문서의 조합 범위를 새 문자열로 바꾼다. 변경으로 세지 않는다. */
  updateComposition(text: string): void {
    const composition = this.composition;
    if (!composition || composition.text === text) return;
    const ok = this.mutate(() => {
      const current = charCount(composition.text);
      if (current > 0) this.text!.delete(composition.anchor, current);
      if (text) this.text!.insert(composition.anchor, text);
      return { ...composition.anchor, offset: composition.anchor.offset + charCount(text) };
    }, false);
    if (ok) composition.text = text;
    else this.composition = null;
  }

  /** 조합이 끝났다. 최종 문자열(취소면 "")을 남기고, 문서가 바뀌었으면 변경 1개로 센다. */
  endComposition(finalText: string): string {
    const composition = this.composition;
    if (!composition) return "";
    this.updateComposition(finalText);
    const committed = this.composition?.text ?? "";
    this.composition = null;
    if (committed !== "" || composition.deletedSelection) this.recordMutation();
    this.emit();
    return committed;
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
    this.moveTo(position, extend);
    return true;
  }

  // ---- 확정·실패·정리 ----

  private async flushCommits() {
    if (this.committing) return;
    this.committing = true;
    try {
      while (this.pending > 0 && !this.disposed && this.status.kind === "ready") {
        const count = this.pending;
        const result = await this.backend.commit(this.sessionId, this.generation, this.committed, count);
        if (this.disposed) return;
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
      this.committing = false;
    }
  }

  private handleBackendRejection(error: DocumentError) {
    if (error.code === "StaleSession" || error.code === "UnknownSession") {
      this.dispose();
      return;
    }
    if (error.code === "StaleLoad") {
      // 이 모델은 더 새로운 불러오기 시도로 대체됐다. 그 시도의 상태를 건드리지 않고 편집만 멈춘다.
      this.composition = null;
      this.setStatus({ kind: "failed", error });
      void this.sessions.refresh(this.sessionId);
      return;
    }
    void this.markFailed(error);
  }

  private failEditing() {
    void this.markFailed({ code: "EngineFailure", engine: "rhwp", stage: "edit" });
  }

  /**
   * 편집을 멈추고 세션을 failed로 돌린다. 모델은 표시용으로만 남긴다. 확정하지 못한 변경(pending)은 지우지 않는다:
   * 그 편집은 모델에 있고 저장되지 않았으므로, 다시 불러오기·닫기 전에 버리기 확인이 필요하다.
   */
  private async markFailed(error: DocumentError) {
    if (this.status.kind === "failed" || this.disposed) return;
    this.composition = null;
    this.setStatus({ kind: "failed", error });
    const info: SessionInfo | null = this.sessions.get(this.sessionId);
    const from = info?.state === "loading" ? "loading" : "ready";
    const failed = await this.backend.setState(this.sessionId, this.generation, from, "failed");
    if (!this.disposed && failed.ok) this.sessions.applyUpdate(failed.value);
  }

  /**
   * 메모리에서 원본 형식으로 내보내고 다시 열어 형식·쪽 수·본문 텍스트·컨트롤 배치를 비교한다(파일을 쓰지 않음).
   * 형식은 요청한 확장자가 아니라 다시 연 문서와 내보낸 바이트로 확인한다. 손실 보고가 올바른 모양이고 0건이며
   * 비교가 모두 같을 때만 passed. 실패해도 내보낸 객체·다시 연 문서는 놓는다.
   * 결과는 지금 모델에 대한 것이며, 문서를 바꾸면 지운다.
   */
  roundTrip(format: "hwp" | "hwpx"): RoundTripReport | null {
    const doc = this.doc;
    const module = this.module;
    if (!doc || !module) return null;
    const report: RoundTripReport = {
      format, failure: "export", bytes: 0, reopenedFormat: null, formatEqual: false, lossValid: false, lossCount: -1, losses: [],
      pagesEqual: false, textEqual: false, controlsEqual: false, passed: false,
    };
    let reopened: RhwpDocument | null = null;
    try {
      let bytes: Uint8Array;
      const exported = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
      try {
        const loss = parseLoss(exported.contentLoss());
        if (loss) Object.assign(report, { lossValid: true, lossCount: loss.count, losses: loss.losses });
        bytes = exported.takeBytes();
      } finally {
        exported.free();
      }
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
    this.lastRoundTrip = report;
    this.emit();
    return report;
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
    this.doc?.free();
    this.doc = null;
    this.text = null;
    this.composition = null;
  }

  /** 세션을 닫을 때. 모델을 버리고 이후의 늦은 응답은 무시한다. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseDocument();
    this.status = { kind: "closed" };
    this.emit();
    this.listeners.clear();
  }
}

