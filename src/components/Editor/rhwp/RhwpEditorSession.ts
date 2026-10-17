// rhwp 편집 세션 하나(T007, R-A). WebView의 WASM 문서 모델·커서·선택·IME 조합 상태를 가지고, 문서를 바꾼 결과를
// 백엔드에 revision으로 확정한다.
//
// 소유와 순서(docs/architecture/editor-surface-decision.md "T007 결과"):
// - 세션 ID·수명주기·revision의 권한은 백엔드(SessionRegistry)에 있다. 이 객체는 세션마다 하나뿐인 쓰는 쪽이며,
//   WASM 호출은 JS 스레드에서 동기로 끝나므로 같은 세션의 변경은 일어난 순서대로 하나씩 적용된다.
// - 변경이 성공하면 pending을 1 늘리고, 확정은 한 번에 하나만 보낸다(base = 백엔드가 마지막으로 확인한 revision,
//   count = 그 뒤 성공한 변경 수). 응답을 기다리는 동안의 변경은 다음 확정에 묶인다. 그래서 확정이 순서를 바꿔
//   도착하거나 중복될 수 없고, revision은 성공한 변경마다 정확히 1씩 는다(다시 그리기·선택·실패한 변경은 확정 안 함).
// - 백엔드가 확정을 거부하면(RevisionMismatch·InvalidState) 모델이 기록과 어긋났다고 보고 세션을 failed로 돌린다.
//   닫힌 세션(StaleSession·UnknownSession)이면 모델을 버린다. 엔진 편집 함수가 예외를 던지면 일부만 바뀌었을 수 있어
//   편집을 멈추고 failed로 돌린다(읽기 전용 표시, 다시 불러오기 가능 — 확정하지 않은 편집은 버려진다).
// - IME 조합 중에는 조합 문자열을 문서에 바로 넣어 보여 주고(rhwp-studio와 같은 방식), 조합이 끝날 때 한 번만 변경으로
//   센다. 조합이 글자 없이 끝나면(취소) 넣었던 글자를 지우므로 변경이 아니다. 선택을 지우고 시작한 조합은 변경이다.
// - 저장은 없다(T009). 내보내기 검사는 메모리에서만 내보내고 다시 열어 비교한다(파일을 쓰지 않음).
import type { DocumentBackend } from "../../../adapters/backend";
import type { DocumentError, SessionInfo } from "../../../adapters/contract";
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
  bytes: number;
  lossCount: number;
  losses: unknown[];
  pagesEqual: boolean;
  textEqual: boolean;
  controlsEqual: boolean;
}

export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

type Mutation = () => DocPosition;

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
  private loadingPromise: Promise<void> | null = null;
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
    return this.status.kind === "ready" && this.doc !== null;
  }

  get composing() {
    return this.composition !== null;
  }

  get hasSelection() {
    return compare(this.anchor, this.caret) !== 0 || !sameContext(this.anchor, this.caret);
  }

  /** 엔진에 문서를 불러온다(identified·failed에서). 동시에 두 번 부르면 같은 작업을 기다린다. */
  load(): Promise<void> {
    this.loadingPromise ??= this.runLoad().finally(() => {
      this.loadingPromise = null;
    });
    return this.loadingPromise;
  }

  private async runLoad() {
    if (this.disposed) return;
    this.releaseDocument();
    this.status = { kind: "loading" };
    this.firstPaintMs = null;
    this.emit();
    const bytes = await this.backend.load(this.sessionId);
    if (this.disposed) return;
    void this.sessions.refresh(this.sessionId); // loading(또는 실패 시 failed) 상태를 투영에 반영
    if (!bytes.ok) {
      this.setStatus({ kind: "failed", error: bytes.error });
      return;
    }
    this.loadStartedAt = performance.now();
    let doc: RhwpDocument;
    try {
      this.module ??= await this.loadModule();
    } catch {
      return this.failLoading({ code: "EngineFailure", engine: "rhwp", stage: "init" });
    }
    try {
      doc = this.module.openDocument(bytes.value);
    } catch {
      return this.failLoading({ code: "EngineFailure", engine: "rhwp", stage: "parse" });
    }
    if (this.disposed) {
      doc.free();
      return;
    }
    const ready = await this.backend.setState(this.sessionId, "loading", "ready");
    if (this.disposed || !ready.ok) {
      doc.free();
      if (!this.disposed && !ready.ok) this.handleBackendRejection(ready.error);
      return;
    }
    this.doc = doc;
    this.text = new RhwpText(doc);
    this.committed = ready.value.revision;
    this.pending = 0;
    this.caret = this.anchor = START;
    this.preferredX = -1;
    this.refreshPages();
    this.sessions.applyUpdate(ready.value);
    this.setStatus({ kind: "ready" });
  }

  private async failLoading(error: DocumentError) {
    const failed = await this.backend.setState(this.sessionId, "loading", "failed");
    if (this.disposed) return;
    if (failed.ok) this.sessions.applyUpdate(failed.value);
    this.setStatus({ kind: "failed", error });
  }

  private setStatus(status: EditorStatus) {
    this.status = status;
    this.emit();
  }

  private refreshPages() {
    const doc = this.doc;
    if (!doc) return;
    const pages: PageSize[] = [];
    const count = doc.pageCount();
    for (let page = 0; page < count; page++) {
      const info = JSON.parse(doc.getPageInfo(page)) as { width?: unknown; height?: unknown };
      pages.push({ width: Number(info.width) || 0, height: Number(info.height) || 0 });
    }
    this.pages = pages;
  }

  /** 렌더링(표면이 부른다). 엔진 오류는 렌더 실패로만 알린다. */
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

  /** 엔진 모델을 바꾼다. 성공하면 변경 1개를 확정 대기열에 넣는다. */
  private mutate(apply: Mutation, count = true): boolean {
    if (!this.editable) return false;
    let next: DocPosition;
    try {
      next = apply();
    } catch {
      this.failEditing();
      return false;
    }
    this.caret = this.anchor = next;
    this.preferredX = -1;
    this.modelChanged();
    if (count) this.recordMutation();
    return true;
  }

  private recordMutation() {
    this.pending += 1;
    void this.flushCommits();
  }

  private modelChanged() {
    this.refreshPages();
    this.modelVersion += 1;
    this.emit();
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
        const result = await this.backend.commit(this.sessionId, this.committed, count);
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
    void this.markFailed(error);
  }

  private failEditing() {
    void this.markFailed({ code: "EngineFailure", engine: "rhwp", stage: "edit" });
  }

  /** 편집을 멈추고 세션을 failed로 돌린다. 모델은 표시용으로만 남긴다. */
  private async markFailed(error: DocumentError) {
    this.composition = null;
    this.pending = 0;
    this.setStatus({ kind: "failed", error });
    const info: SessionInfo | null = this.sessions.get(this.sessionId);
    const from = info?.state === "loading" ? "loading" : "ready";
    const failed = await this.backend.setState(this.sessionId, from, "failed");
    if (!this.disposed && failed.ok) this.sessions.applyUpdate(failed.value);
  }

  /** 메모리에서 원본 형식으로 내보내고 다시 열어 쪽 수·본문 텍스트·컨트롤 배치를 비교한다(파일을 쓰지 않음). */
  roundTrip(format: "hwp" | "hwpx"): RoundTripReport | null {
    const doc = this.doc;
    const module = this.module;
    if (!doc || !module) return null;
    let reopened: RhwpDocument | null = null;
    try {
      const exported = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
      const loss = JSON.parse(exported.contentLoss()) as { count?: number; losses?: unknown[] };
      const bytes = exported.takeBytes();
      exported.free();
      reopened = module.openDocument(bytes);
      const controls = (d: RhwpDocument) => (d as unknown as { getControls(): string }).getControls();
      const textOf = (d: RhwpDocument) => (d as unknown as { getTextFileText(): string }).getTextFileText();
      this.lastRoundTrip = {
        format,
        bytes: bytes.length,
        lossCount: Number(loss.count ?? -1),
        losses: loss.losses ?? [],
        pagesEqual: reopened.pageCount() === doc.pageCount(),
        textEqual: textOf(reopened) === textOf(doc),
        controlsEqual: controls(reopened) === controls(doc),
      };
    } catch {
      this.lastRoundTrip = null;
    } finally {
      reopened?.free();
    }
    this.emit();
    return this.lastRoundTrip;
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

