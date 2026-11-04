// 열린 문서와 엔진 편집 세션의 연결(T007).
//
// - 세션 목록·활성 선택은 DocumentSessions(백엔드 투영)이 가진다. 여기서는 rhwp 세션마다 편집 세션(WASM 모델)을
//   하나만 만들고, 세션이 목록에서 사라지면(닫기·늦게 알게 된 닫힘) 그 모델을 버린다.
// - 열기 → 판별(백엔드) → 엔진에 바로 불러온다. rhwp는 WebView의 WASM(T007), DOCX(WordCraft)는 백엔드의 네이티브 엔진(T008,
//   DocxEditorSession은 백엔드 모델의 편집 표면 상태만 가진다). 세션마다 편집 세션은 하나다.
// - 닫기: 저장하지 않은 편집한 모델(저장 뒤 바꾼 확정 변경, 확정 대기·조합 중인 변경 — 저장은 T009)은 `discard: true` 없이 닫지
//   않는다(UnpreservedChanges). 백엔드 기록의 dirty도 본다: 편집 세션 객체가 아직 없는 세션(WebView를 다시 시작한 뒤 아직
//   보지 않은 DOCX 탭 — 모델은 백엔드에 남아 있음)도 같은 기준으로 보호한다(T008 안정화). 닫는 동안은 편집을 막고, 백엔드가 닫았다고 답한 뒤에(목록에서 빠질 때) 모델을 버린다.
//   백엔드 닫기가 실패하면 모델을 그대로 두고 편집을 다시 허용한다. 같은 세션의 닫기를 되풀이하면 진행 중인 닫기
//   하나를 기다린다(백엔드 닫기·정리는 한 번).
import type { DocumentBackend } from "../../adapters/backend";
import type { DocxBackend } from "../../adapters/docx";
import type { CloseOutcome, DocumentError, DocumentFormat, Result, SaveOutcome, SessionId, SessionInfo } from "../../adapters/contract";
import type { DocumentSessions } from "../../adapters/sessions";
import type { FileDialogRequest, FilePort } from "./filePort";
import type { RecoveryCandidate, RecoveryPort } from "./recoveryPort";
import { RhwpEditorSession } from "./rhwp/RhwpEditorSession";
import { loadRhwpModule, type RhwpModule } from "./rhwp/rhwpModule";
import type { WindowClosePort } from "./windowClose";
import { DocxEditorSession, type DecodeImage } from "./wordcraft/DocxEditorSession";
import { createRhwpBlank } from "./rhwp/createBlank";
import { captureSurfaceFocus, releaseSurfaceFocus, setSurfaceFocusLease, type SurfaceFocusLease } from "./surfaceFocus";

/** 엔진별 편집 세션(세션마다 하나). */
export type EngineEditor = RhwpEditorSession | DocxEditorSession;

export type FileDialogText = Pick<FileDialogRequest, "title" | "accept" | "cancel">;

export type RecoveryCheckpointStatus =
  | { sessionId: SessionId; revision: number; kind: "waiting" | "capturing" | "protected" }
  | { sessionId: SessionId; revision: number; kind: "failed"; error: DocumentError };

const CHECKPOINT_DEBOUNCE_MS = 2000;

export class DocumentWorkspace {
  private readonly editors = new Map<SessionId, EngineEditor>();
  private readonly closing = new Map<SessionId, Promise<Result<CloseOutcome>>>();
  private readonly listeners = new Set<() => void>();
  private readonly recoveryListeners = new Set<() => void>();
  private readonly editorUnsubscribers = new Map<SessionId, () => void>();
  private readonly checkpointTimers = new Map<SessionId, ReturnType<typeof setTimeout>>();
  private readonly checkpointJobs = new Map<SessionId, number>();
  private checkpointLane: Promise<unknown> = Promise.resolve();
  private readonly checkpointStates = new Map<SessionId, RecoveryCheckpointStatus>();
  private fileOperation: "open" | "new" | "saveAs" | "restore" | "recovery" | null = null;
  private started = false;
  private windowClosing = false;
  private cancelFormatSelection: (() => void) | undefined;

  constructor(
    readonly sessions: DocumentSessions,
    private readonly backend: DocumentBackend,
    private readonly loadModule: () => Promise<RhwpModule> = () => loadRhwpModule(),
    readonly windowClose?: WindowClosePort,
    private readonly docxBackend?: DocxBackend,
    private readonly decodeImage?: DecodeImage,
    private readonly filePort?: FilePort,
    private readonly recoveryPort?: RecoveryPort,
  ) {
    sessions.subscribe(() => {
      this.sync();
      this.emit();
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly fileBusySnapshot = (): boolean => this.fileOperation !== null;

  readonly subscribeRecovery = (listener: () => void): (() => void) => {
    this.recoveryListeners.add(listener);
    return () => this.recoveryListeners.delete(listener);
  };

  get fileBusy(): boolean {
    return this.fileOperation !== null;
  }

  get supportsNativeFiles(): boolean {
    return this.filePort !== undefined;
  }

  get supportsRecovery(): boolean {
    return this.recoveryPort !== undefined;
  }

  get recoveryCheckpointStatuses(): readonly RecoveryCheckpointStatus[] {
    return [...this.checkpointStates.values()].sort((a, b) => a.sessionId - b.sessionId);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private emitRecovery() {
    for (const listener of this.recoveryListeners) listener();
  }

  private beginFileOperation(operation: "open" | "new" | "saveAs" | "restore" | "recovery"): boolean {
    if (this.fileOperation !== null || this.windowClosing) return false;
    this.fileOperation = operation;
    this.emit();
    return true;
  }

  private endFileOperation() {
    this.fileOperation = null;
    this.emit();
  }

  /** 앱 시작 때 한 번: 백엔드에 남은 세션(WebView 재시작)을 맞춘다. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.sessions.reconcile();
  }

  async open(path: string): Promise<Result<SessionInfo>> {
    if (!this.beginFileOperation("open")) return { ok: false, error: { code: "Protocol" } };
    try {
      const result = await this.sessions.open(path);
      this.loadOpened(result);
      return result;
    } finally {
      this.endFileOperation();
    }
  }

  /** Open through the OS chooser. Cancellation releases its ordering reservation and changes no session. */
  async openDialog(text: FileDialogText): Promise<Result<SessionInfo> | null> {
    if (!this.beginFileOperation("open")) return { ok: false, error: { code: "Protocol" } };
    const ticket = this.sessions.beginOpen();
    try {
      if (!this.filePort) {
        this.sessions.cancelOpen(ticket);
        return { ok: false, error: { code: "Protocol" } };
      }
      const chosen = await this.filePort.chooseFile({ mode: "open", ...text });
      if (!chosen.ok) {
        this.sessions.cancelOpen(ticket);
        return chosen;
      }
      if (chosen.value === null) {
        this.sessions.cancelOpen(ticket);
        return null;
      }
      return this.acceptAndLoad(ticket, await this.backend.open(chosen.value));
    } finally {
      this.endFileOperation();
    }
  }

  /** Select format, then destination, then create-only publication and engine load. */
  async newDocument(text: FileDialogText, chooseFormat: () => Promise<DocumentFormat | null>): Promise<Result<SessionInfo> | null> {
    const activeId = this.sessions.snapshot().activeId;
    if (activeId !== null && this.editors.get(activeId)?.snapshot().composing) {
      return { ok: false, error: { code: "SaveNotReady", reason: "composing" } };
    }
    if (!this.beginFileOperation("new")) return { ok: false, error: { code: "Protocol" } };
    const ticket = this.sessions.beginOpen();
    let focus: SurfaceFocusLease | undefined;
    try {
      if (!this.filePort) {
        this.sessions.cancelOpen(ticket);
        return { ok: false, error: { code: "Protocol" } };
      }
      const cancelled = new Promise<null>(resolve => { this.cancelFormatSelection = () => resolve(null); });
      const format = await Promise.race([chooseFormat(), cancelled]);
      this.cancelFormatSelection = undefined;
      if (format === null || this.windowClosing) { this.sessions.cancelOpen(ticket); return null; }
      const chosen = await this.filePort.chooseFile({ mode: "save", format, ...text });
      if (!chosen.ok) {
        this.sessions.cancelOpen(ticket);
        return chosen;
      }
      if (chosen.value === null) {
        this.sessions.cancelOpen(ticket);
        return null;
      }
      if (this.windowClosing) { this.sessions.cancelOpen(ticket); return null; }
      focus = captureSurfaceFocus();
      let blank;
      if (format !== "docx") {
        try { blank = createRhwpBlank(await this.loadModule(), format); }
        catch { this.sessions.cancelOpen(ticket); return { ok: false, error: { code: "EngineFailure", engine: "rhwp", stage: "export" } }; }
      }
      if (this.windowClosing) { this.sessions.cancelOpen(ticket); return null; }
      const created = await this.filePort.createDocument(format, chosen.value, blank);
      // Publication cannot be cancelled once started. A successful response means the file is
      // published and registered, so it becomes an ordinary open session even while the window is
      // closing: the close decision then sees it like every other tab (no fabricated registration
      // failure, no unconditional backend close that would hide an unconfirmed publication).
      const accepted = this.sessions.acceptOpen(ticket, created);
      if (accepted.ok) {
        // dirty at revision/generation zero means publication durability is
        // unconfirmed, not an editable in-memory mutation. Keep that protected
        // session and report the file outcome without misclassifying the normal
        // reload guard as an engine failure or clearing it through an auto-load.
        if (accepted.value.dirty) return accepted;
        // No engine load or focus claim for a window that is being destroyed.
        if (this.windowClosing) return accepted;
        const editor = this.anyEditorFor(accepted.value.sessionId);
        if (!editor) return { ok: false, error: { code: "FileCreatedEditorFailed", sessionId: accepted.value.sessionId } };
        setSurfaceFocusLease(editor, focus);
        focus = undefined;
        const loaded = await editor.load();
        if (!loaded.ok) {
          releaseSurfaceFocus(editor);
          return { ok: false, error: { code: "FileCreatedEditorFailed", sessionId: accepted.value.sessionId } };
        }
      }
      return accepted;
    } catch {
      this.sessions.cancelOpen(ticket);
      return { ok: false, error: { code: "Protocol" } };
    } finally {
      this.cancelFormatSelection = undefined;
      focus?.dispose();
      this.endFileOperation();
    }
  }

  /** Compatibility for callers that already selected DOCX; uses the same pipeline. */
  newDocx(text: FileDialogText): Promise<Result<SessionInfo> | null> {
    return this.newDocument(text, async () => "docx");
  }

  async waitForFiles(): Promise<void> {
    if (!this.fileBusy) return;
    await new Promise<void>(resolve => {
      const stop = this.subscribe(() => { if (!this.fileBusy) { stop(); resolve(); } });
    });
  }

  /** Save the captured editor to a new destination, keeping engine checks and session identity in the save path. */
  async saveAs(sessionId: SessionId, text: FileDialogText): Promise<Result<SaveOutcome> | null> {
    if (!this.beginFileOperation("saveAs")) return { ok: false, error: { code: "Protocol" } };
    const session = this.sessions.get(sessionId);
    const editor = session ? this.anyEditorFor(sessionId) : null;
    try {
      if (!this.filePort) return { ok: false, error: { code: "Protocol" } };
      if (!session || !editor) return { ok: false, error: { code: "UnknownSession", sessionId } };
      const destination = await this.filePort.chooseFile({ mode: "save", format: session.format, ...text });
      if (!destination.ok) return destination;
      if (destination.value === null) return null;
      if (this.sessions.get(sessionId) === null || this.editors.get(sessionId) !== editor) {
        return { ok: false, error: { code: "StaleSession", sessionId } };
      }
      return await editor.save(destination.value);
    } finally {
      this.endFileOperation();
    }
  }

  async listRecovery(): Promise<Result<RecoveryCandidate[]>> {
    if (!this.recoveryPort) return { ok: false, error: { code: "Protocol" } };
    try {
      return await this.recoveryPort.list();
    } catch {
      return { ok: false, error: { code: "Protocol" } };
    }
  }

  /** Restore always chooses a fresh destination and opens that new file as a new backend session. */
  async restoreRecovery(candidate: RecoveryCandidate, text: FileDialogText): Promise<Result<SessionInfo> | null> {
    if (!this.beginFileOperation("restore")) return { ok: false, error: { code: "Protocol" } };
    const ticket = this.sessions.beginOpen();
    try {
      if (!candidate.valid || !candidate.format || !this.filePort || !this.recoveryPort) {
        this.sessions.cancelOpen(ticket);
        return { ok: false, error: { code: "InvalidRequest" } };
      }
      const chosen = await this.filePort.chooseFile({ mode: "save", format: candidate.format, ...text });
      if (!chosen.ok) {
        this.sessions.cancelOpen(ticket);
        return chosen;
      }
      if (chosen.value === null) {
        this.sessions.cancelOpen(ticket);
        return null;
      }
      const restored = await this.recoveryPort.restore(candidate.id, chosen.value);
      if (!restored.ok) {
        this.sessions.cancelOpen(ticket);
        return restored;
      }
      return this.acceptAndLoad(ticket, await this.backend.open(restored.value));
    } finally {
      this.endFileOperation();
    }
  }

  async discardRecovery(id: string): Promise<Result<null>> {
    if (!this.beginFileOperation("recovery")) return { ok: false, error: { code: "Protocol" } };
    try {
      if (!this.recoveryPort) return { ok: false, error: { code: "Protocol" } };
      return await this.recoveryPort.discard(id);
    } catch {
      return { ok: false, error: { code: "Protocol" } };
    } finally {
      this.endFileOperation();
    }
  }

  /** Explicit retry of a failed revision; automatic retry waits for a newer settled revision. */
  retryRecoveryCheckpoint(sessionId: SessionId): Promise<Result<SaveOutcome> | null> {
    const editor = this.editors.get(sessionId);
    if (!editor || !(editor instanceof DocxEditorSession) || !this.recoveryPort) return Promise.resolve(null);
    this.cancelCheckpointTimer(sessionId);
    const info = this.sessions.get(sessionId);
    const snapshot = editor.snapshot();
    if (!info?.dirty || !this.checkpointReady(snapshot)) return Promise.resolve(null);
    return this.captureCheckpoint(sessionId, editor, snapshot.revision);
  }

  private acceptAndLoad(ticket: ReturnType<DocumentSessions["beginOpen"]>, result: Result<SessionInfo>): Result<SessionInfo> {
    const accepted = this.sessions.acceptOpen(ticket, result);
    this.loadOpened(accepted);
    return accepted;
  }

  private loadOpened(result: Result<SessionInfo>) {
    if (result.ok) void this.anyEditorFor(result.value.sessionId)?.load();
  }

  /** rhwp 세션의 편집 세션(없으면 만든다). 목록에 없거나 rhwp가 아니면 null. */
  editorFor(sessionId: SessionId): RhwpEditorSession | null {
    const editor = this.anyEditorFor(sessionId);
    return editor instanceof RhwpEditorSession ? editor : null;
  }

  /** WordCraft 세션의 편집 세션(없으면 만든다). 목록에 없거나 WordCraft가 아니거나 DOCX 백엔드가 없으면 null. */
  docxEditorFor(sessionId: SessionId): DocxEditorSession | null {
    const editor = this.anyEditorFor(sessionId);
    return editor instanceof DocxEditorSession ? editor : null;
  }

  /** 세션 엔진의 편집 세션(없으면 만든다). */
  anyEditorFor(sessionId: SessionId): EngineEditor | null {
    const info = this.sessions.get(sessionId);
    if (!info) return null;
    let editor = this.editors.get(sessionId);
    if (!editor) {
      if (info.engine === "rhwp") editor = new RhwpEditorSession(sessionId, this.backend, this.sessions, this.loadModule);
      else if (this.docxBackend) editor = new DocxEditorSession(sessionId, this.docxBackend, this.sessions, this.decodeImage);
      else return null;
      editor.setClosing(this.windowClosing);
      this.editors.set(sessionId, editor);
      if (editor instanceof DocxEditorSession && this.recoveryPort) {
        const docxEditor = editor;
        this.editorUnsubscribers.set(sessionId, docxEditor.subscribe(() => this.observeCheckpoint(sessionId, docxEditor)));
        this.observeCheckpoint(sessionId, docxEditor);
      }
    }
    return editor;
  }

  /** 모든 탭을 함께 보호한다. backend dirty보다 앞선 pending·조합·uncertain도 포함한다. */
  get hasUnpreservedChanges() {
    return this.sessions.snapshot().sessions.some(info => this.unpreserved(info.sessionId));
  }

  /** 세션 하나의 미보존 편집: 백엔드 기록의 dirty 또는 편집 세션의 보내는 중·조합 중·uncertain. */
  private unpreserved(sessionId: SessionId): boolean {
    return (this.sessions.get(sessionId)?.dirty ?? false) || (this.editors.get(sessionId)?.hasUnpreservedChanges ?? false);
  }

  private checkpointReady(snapshot: ReturnType<DocxEditorSession["snapshot"]>): boolean {
    return snapshot.loaded && !snapshot.composing && !snapshot.pending && !snapshot.saving;
  }

  private setCheckpointStatus(status: RecoveryCheckpointStatus | null, sessionId?: SessionId) {
    const id = status?.sessionId ?? sessionId;
    if (id === undefined) return;
    const before = this.checkpointStates.get(id);
    if (status === null) {
      if (!before) return;
      this.checkpointStates.delete(id);
      this.emitRecovery();
      return;
    }
    if (before && before.kind === status.kind && before.revision === status.revision
      && (before.kind !== "failed" || (status.kind === "failed" && JSON.stringify(before.error) === JSON.stringify(status.error)))) return;
    this.checkpointStates.set(id, status);
    this.emitRecovery();
  }

  private cancelCheckpointTimer(sessionId: SessionId) {
    const timer = this.checkpointTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.checkpointTimers.delete(sessionId);
  }

  private observeCheckpoint(sessionId: SessionId, editor: DocxEditorSession) {
    if (!this.recoveryPort || this.editors.get(sessionId) !== editor) return;
    const info = this.sessions.get(sessionId);
    const snapshot = editor.snapshot();
    const status = this.checkpointStates.get(sessionId);
    if (!info?.dirty) {
      this.cancelCheckpointTimer(sessionId);
      if (!this.checkpointJobs.has(sessionId)) this.setCheckpointStatus(null, sessionId);
      return;
    }
    if (!this.checkpointReady(snapshot)) {
      this.cancelCheckpointTimer(sessionId);
      if (status?.kind === "waiting") this.setCheckpointStatus(null, sessionId);
      return;
    }
    if (this.checkpointJobs.has(sessionId)) return;
    if (status?.revision === snapshot.revision) return; // don't retry the same failed or protected revision automatically
    this.cancelCheckpointTimer(sessionId);
    this.setCheckpointStatus({ sessionId, revision: snapshot.revision, kind: "waiting" });
    const timer = setTimeout(() => {
      this.checkpointTimers.delete(sessionId);
      void this.captureCheckpoint(sessionId, editor, snapshot.revision);
    }, CHECKPOINT_DEBOUNCE_MS);
    this.checkpointTimers.set(sessionId, timer);
  }

  /** Serialize background exports across tabs; queued work rechecks ownership and IME before capturing. */
  private captureCheckpoint(sessionId: SessionId, editor: DocxEditorSession, revision: number): Promise<Result<SaveOutcome> | null> {
    const run = () => this.captureCheckpointNow(sessionId, editor, revision);
    const job = this.checkpointLane.then(run, run);
    this.checkpointLane = job;
    return job;
  }

  private async captureCheckpointNow(sessionId: SessionId, editor: DocxEditorSession, revision: number): Promise<Result<SaveOutcome> | null> {
    if (!this.recoveryPort || this.editors.get(sessionId) !== editor || this.checkpointJobs.has(sessionId)) return null;
    const info = this.sessions.get(sessionId);
    const snapshot = editor.snapshot();
    if (!info?.dirty || snapshot.revision !== revision || !this.checkpointReady(snapshot)) {
      this.observeCheckpoint(sessionId, editor);
      return null;
    }
    this.cancelCheckpointTimer(sessionId);
    this.checkpointJobs.set(sessionId, revision);
    this.setCheckpointStatus({ sessionId, revision, kind: "capturing" });
    let result: Result<SaveOutcome>;
    try {
      result = await editor.checkpoint();
    } catch {
      result = { ok: false, error: { code: "Protocol" } };
    }
    if (this.checkpointJobs.get(sessionId) === revision) this.checkpointJobs.delete(sessionId);
    if (this.editors.get(sessionId) !== editor) return result;
    const currentInfo = this.sessions.get(sessionId);
    const current = editor.snapshot();
    const protectedResult = result.ok && result.value.durable
      && result.value.session.sessionId === sessionId
      && result.value.session.loadGeneration === snapshot.loadGeneration
      && result.value.session.revision === revision;
    if (protectedResult) this.setCheckpointStatus({ sessionId, revision, kind: "protected" });
    else this.setCheckpointStatus({
      sessionId,
      revision,
      kind: "failed",
      error: result.ok ? { code: "Protocol" } : result.error,
    });
    if (!currentInfo?.dirty) this.setCheckpointStatus(null, sessionId);
    else if (current.revision !== revision) this.observeCheckpoint(sessionId, editor);
    return result;
  }

  setWindowClosing(closing: boolean) {
    this.windowClosing = closing;
    if (closing) this.cancelFormatSelection?.();
    for (const [id, editor] of this.editors) editor.setClosing(closing || this.closing.has(id));
  }

  /** 세션을 닫는다. 저장하지 않은 편집이 있으면 discard: true일 때만 닫는다. */
  close(sessionId: SessionId, options: { discard?: boolean } = {}): Promise<Result<CloseOutcome>> {
    const inFlight = this.closing.get(sessionId);
    if (inFlight) return inFlight;
    const editor = this.editors.get(sessionId);
    if (this.unpreserved(sessionId) && !options.discard) {
      return Promise.resolve({ ok: false, error: { code: "UnpreservedChanges", sessionId } });
    }
    const closing = this.runClose(sessionId, editor ?? null).then(async result => {
      if (result.ok && options.discard && this.recoveryPort) {
        // A confirmed per-tab discard may forget this process' snapshots, but only after close succeeded.
        try { await this.recoveryPort.forgetSession(sessionId); } catch { /* the recovery center can still offer retained records */ }
      }
      return result;
    }).finally(() => this.closing.delete(sessionId));
    this.closing.set(sessionId, closing);
    return closing;
  }

  private async runClose(sessionId: SessionId, editor: EngineEditor | null): Promise<Result<CloseOutcome>> {
    editor?.setClosing(true);
    // 성공(또는 이미 닫힘)이면 DocumentSessions가 목록에서 빼고, sync()가 편집 세션을 버린다.
    const result = await this.sessions.close(sessionId);
    if (!result.ok && this.sessions.get(sessionId)) editor?.setClosing(this.windowClosing);
    return result;
  }

  private sync() {
    let recoveryChanged = false;
    for (const [sessionId, editor] of this.editors) {
      if (!this.sessions.get(sessionId)) {
        this.editorUnsubscribers.get(sessionId)?.();
        this.editorUnsubscribers.delete(sessionId);
        this.cancelCheckpointTimer(sessionId);
        this.checkpointJobs.delete(sessionId);
        recoveryChanged ||= this.checkpointStates.delete(sessionId);
        releaseSurfaceFocus(editor);
        editor.dispose();
        this.editors.delete(sessionId);
      }
    }
    if (recoveryChanged) this.emitRecovery();
  }
}
