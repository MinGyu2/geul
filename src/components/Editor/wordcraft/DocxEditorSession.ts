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
//   InsertText 하나로 보낸다(조합 하나 = 연산 하나 = revision 하나, 취소는 연산 없음). 선택이 있을 때 시작한 조합은 시작할
//   때 선택을 지운다(rhwp와 같음, 지우기는 따로 한 연산). 끊긴 조합 규칙(imeInput.ts)은 rhwp와 같은 ImeInput이 맡고,
//   이 객체는 ImeSession 계약을 구현한다:
//   · 앱이 먼저 확정한 보이는 조합(클릭·초점 잃음·표면 사라짐)은 그 자리에서 InsertText를 보내고, 바로 뒤 클릭은 넣기 전
//     화면의 좌표로 자리를 찾는다(Pointer.beforeInsert). 입력기의 최종 글자가 다르면 ReplaceInserted로 고친다.
//   · 클릭 직전 커서 자리는 백엔드에 Mark로 기억시키고(markCaret), 늦게 온 확정은 InsertAt으로 그 자리에 넣는다.
// - 저장이 없으므로(T009) 확정한 편집(백엔드 dirty)·보내는 중·조합 중인 입력은 닫기·다시 불러오기 전에 사용자가 버리기를
//   명시해야 한다(`hasUnpreservedChanges`, `load({ discard })`).
// - 쪽 그림은 백엔드가 그린 PNG를 (시도 번호, revision, 배율)로 받아 쪽마다 화면 밖 canvas(래스터)에 둔다. 같은 배율의 앞 판을
//   가지고 있으면 백엔드는 바뀐 줄의 띠만 보내고, 화면 canvas에도 그 띠만 옮긴다. 새 판의 그림이 오기 전까지 옛 그림을 보인다.
import type { DocxBackend, DocxOp, DocxRoundTrip, DocxView, MoveTarget } from "../../../adapters/docx";
import { MAX_DOCX_OPS } from "../../../adapters/docx";
import type { DocumentError, Result, SessionInfo } from "../../../adapters/contract";
import type { DocumentSessions } from "../../../adapters/sessions";
import type { ImeSession } from "../rhwp/imeInput";

export type DocxStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "failed"; error: DocumentError }
  | { kind: "closed" };

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

export class DocxEditorSession implements ImeSession {
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

  private generation = 0;
  private queue: DocxOp[] = [];
  private inFlight = false;
  private epoch = 0;
  private closing = false;
  private disposed = false;
  private composition: { text: string } | null = null;
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
  private readonly rendering = new Set<string>();
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

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private get info(): SessionInfo | null {
    return this.sessions.get(this.sessionId);
  }

  get loadGeneration() {
    return this.generation;
  }

  get editable() {
    return this.status.kind === "ready" && this.view !== null && !this.closing && this.renderLimit === null;
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
    this.composition = null;
    this.provisional = null;
    this.pointerAfterInsert = false;
    this.view = null;
    this.generation = 0;
    this.lastRoundTrip = null;
    this.rejectedOps = 0;
    this.firstPaintMs = null;
    this.releaseImages();
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
    if (!this.editable) return false;
    if (settles) this.provisional = null;
    if (op.op !== "insertText") this.pointerAfterInsert = false;
    const last = this.queue[this.queue.length - 1];
    // 끌기의 연속 위치는 마지막 것만 보내면 된다(같은 결과).
    if (op.op === "pointer" && op.extend && last?.op === "pointer" && last.extend) this.queue[this.queue.length - 1] = op;
    else this.queue.push(op);
    void this.flush();
    return true;
  }

  private async flush() {
    if (this.inFlight || this.queue.length === 0 || this.status.kind !== "ready") return;
    const epoch = this.epoch;
    const batch = this.queue.splice(0, MAX_DOCX_OPS);
    this.inFlight = true;
    const result = await this.backend.edit(this.sessionId, this.generation, this.revision, batch);
    if (epoch !== this.epoch) return;
    this.inFlight = false;
    if (!result.ok) {
      await this.fail(result.error);
      return;
    }
    this.revision = result.value.session.revision;
    this.view = result.value.view;
    this.rejectedOps += result.value.rejected.length;
    this.sessions.applyUpdate(result.value.session);
    this.emit();
    void this.flush();
  }

  typeText(text: string): boolean {
    if (!text || this.composition) return false;
    return this.push({ op: "insertText", text });
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
    if (!this.editable || this.composition) return;
    this.provisional = null;
    // 선택이 있으면 조합을 시작하며 지운다(조합 글자는 그 자리에 겹쳐 보인다).
    if (this.view && !this.view.collapsed) this.push({ op: "backspace" });
    this.composition = { text: "" };
    this.emit();
  }

  updateComposition(text: string): void {
    if (!this.composition || this.composition.text === text) return;
    this.composition.text = text;
    this.emit();
  }

  endComposition(finalText: string, options: { provisional?: boolean } = {}): string {
    if (!this.composition) return "";
    this.composition = null;
    const inserted = finalText !== "" && this.push({ op: "insertText", text: finalText });
    if (inserted && options.provisional) {
      this.provisional = { text: finalText };
      this.pointerAfterInsert = true;
    }
    this.emit();
    return inserted ? finalText : "";
  }

  resolveProvisional(finalText?: string): void {
    const provisional = this.provisional;
    if (!provisional) return;
    this.provisional = null;
    if (finalText !== undefined && finalText !== "" && finalText !== provisional.text) {
      this.push({ op: "replaceInserted", expected: provisional.text, text: finalText });
    }
    this.emit();
  }

  insertCommittedAt(at: unknown, text: string): boolean {
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

  /** 쪽 그림이 지금 모델·배율의 것인지. */
  isCurrent(page: number, scale: number): boolean {
    const raster = this.rasters.get(page);
    return !!raster && raster.generation === this.generation && raster.revision === this.revision && raster.scale === scale;
  }

  /**
   * 지금 판·배율의 그림이 없는 쪽을 백엔드에 그려 달라고 한다(쪽마다 판 하나에 한 번). 같은 배율의 앞 판 그림이 있으면 그 판을
   * 기준으로 보내 바뀐 띠만 받는다.
   */
  requestPages(pages: number[], scale: number) {
    if (this.status.kind !== "ready" || this.renderLimit !== null) return;
    for (const page of pages) {
      if (this.isCurrent(page, scale)) continue;
      const { generation, revision, epoch } = { generation: this.generation, revision: this.revision, epoch: this.epoch };
      const held = this.rasters.get(page);
      const base = held && held.generation === generation && held.scale === scale ? held.revision : undefined;
      const key = `${generation}:${revision}:${page}:${scale}:${base ?? ""}`;
      if (this.rendering.has(key)) continue;
      this.rendering.add(key);
      void this.backend.render(this.sessionId, generation, revision, page, scale, base).then(async (result) => {
        if (!result.ok || epoch !== this.epoch) return; // 옛 판(RevisionMismatch)은 새 판의 요청이 대신한다
        const { base: from, y, height, png } = result.value;
        const bitmap = height > 0 ? await this.decode(png).catch(() => null) : null;
        if (height > 0 && !bitmap) return;
        try {
          if (epoch === this.epoch && this.applyRender(page, { generation, revision, scale, from, y, height, bitmap })) this.emit();
        } finally {
          bitmap?.close();
        }
      }).finally(() => this.rendering.delete(key));
    }
  }

  /** 받은 쪽 그림(전체 또는 띠)을 쪽 래스터에 반영한다. 띠의 기준 판이 지금 래스터가 아니면 버린다(다음 요청이 맞춘다). */
  private applyRender(page: number, render: { generation: number; revision: number; scale: number; from: number | null; y: number; height: number; bitmap: ImageBitmap | null }): boolean {
    const { generation, revision, scale, from, y, height, bitmap } = render;
    const current = this.rasters.get(page);
    if (from === null) {
      if (!bitmap) return false;
      if (current && current.generation === generation && current.scale === scale && current.revision >= revision) return false;
      const backing = current?.backing ?? this.createCanvas();
      if (backing.width !== bitmap.width) backing.width = bitmap.width;
      if (backing.height !== bitmap.height) backing.height = bitmap.height;
      backing.getContext("2d")?.drawImage(bitmap, 0, 0);
      this.rasters.set(page, { generation, revision, scale, backing, width: bitmap.width, height: bitmap.height, bands: [], full: revision });
      return true;
    }
    if (!current || current.generation !== generation || current.scale !== scale || current.revision !== from) return false;
    if (bitmap) current.backing.getContext("2d")?.drawImage(bitmap, 0, y);
    current.bands.push({ from, to: revision, y, height });
    if (current.bands.length > MAX_BANDS) current.bands.shift();
    current.revision = revision;
    return true;
  }

  /**
   * 쪽 래스터를 canvas에 옮긴다. 이 canvas가 같은 래스터의 앞 판을 보이고 있으면 그 뒤 바뀐 띠만 옮기고(키 하나에 Canvas 전체를
   * 다시 합성하지 않음, T007의 띠 다시 그리기와 같은 이유), 아니면 전체를 옮긴다. 처음 그린 시간을 기록한다.
   */
  paint(page: number, canvas: HTMLCanvasElement) {
    const raster = this.rasters.get(page);
    if (!raster) return;
    const shown = this.painted.get(canvas);
    if (shown && shown.raster === raster && shown.revision === raster.revision) return;
    const context = canvas.getContext("2d");
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
      if (bottom > top) context?.drawImage(raster.backing, 0, top, raster.width, bottom - top, 0, top, raster.width, bottom - top);
    } else {
      context?.drawImage(raster.backing, 0, 0);
    }
    this.painted.set(canvas, { raster, revision: raster.revision });
    if (this.firstPaintMs === null) {
      this.firstPaintMs = performance.now() - this.loadStartedAt;
      this.emit(); // 처음 한 번(진단 표시)
    }
  }

  private releaseImages() {
    for (const raster of this.rasters.values()) {
      raster.backing.width = 0;
      raster.backing.height = 0;
    }
    this.rasters.clear();
    this.rendering.clear();
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
