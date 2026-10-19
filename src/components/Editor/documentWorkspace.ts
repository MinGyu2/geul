// 열린 문서와 엔진 편집 세션의 연결(T007).
//
// - 세션 목록·활성 선택은 DocumentSessions(백엔드 투영)이 가진다. 여기서는 rhwp 세션마다 편집 세션(WASM 모델)을
//   하나만 만들고, 세션이 목록에서 사라지면(닫기·늦게 알게 된 닫힘) 그 모델을 버린다.
// - 열기 → 판별(백엔드) → 엔진에 바로 불러온다. rhwp는 WebView의 WASM(T007), DOCX(WordCraft)는 백엔드의 네이티브 엔진(T008,
//   DocxEditorSession은 백엔드 모델의 편집 표면 상태만 가진다). 세션마다 편집 세션은 하나다.
// - 닫기: 저장 기능이 없으므로(T009) 편집한 모델(확정했거나 확정 대기·조합 중인 변경)은 `discard: true` 없이 닫지
//   않는다(UnpreservedChanges). 백엔드 기록의 dirty도 본다: 편집 세션 객체가 아직 없는 세션(WebView를 다시 시작한 뒤 아직
//   보지 않은 DOCX 탭 — 모델은 백엔드에 남아 있음)도 같은 기준으로 보호한다(T008 안정화). 닫는 동안은 편집을 막고, 백엔드가 닫았다고 답한 뒤에(목록에서 빠질 때) 모델을 버린다.
//   백엔드 닫기가 실패하면 모델을 그대로 두고 편집을 다시 허용한다. 같은 세션의 닫기를 되풀이하면 진행 중인 닫기
//   하나를 기다린다(백엔드 닫기·정리는 한 번).
import type { DocumentBackend } from "../../adapters/backend";
import type { DocxBackend } from "../../adapters/docx";
import type { CloseOutcome, Result, SessionId, SessionInfo } from "../../adapters/contract";
import type { DocumentSessions } from "../../adapters/sessions";
import { RhwpEditorSession } from "./rhwp/RhwpEditorSession";
import { loadRhwpModule, type RhwpModule } from "./rhwp/rhwpModule";
import type { WindowClosePort } from "./windowClose";
import { DocxEditorSession, type DecodeImage } from "./wordcraft/DocxEditorSession";

/** 엔진별 편집 세션(세션마다 하나). */
export type EngineEditor = RhwpEditorSession | DocxEditorSession;

export class DocumentWorkspace {
  private readonly editors = new Map<SessionId, EngineEditor>();
  private readonly closing = new Map<SessionId, Promise<Result<CloseOutcome>>>();
  private started = false;
  private windowClosing = false;

  constructor(
    readonly sessions: DocumentSessions,
    private readonly backend: DocumentBackend,
    private readonly loadModule: () => Promise<RhwpModule> = () => loadRhwpModule(),
    readonly windowClose?: WindowClosePort,
    private readonly docxBackend?: DocxBackend,
    private readonly decodeImage?: DecodeImage,
  ) {
    sessions.subscribe(() => this.sync());
  }

  /** 앱 시작 때 한 번: 백엔드에 남은 세션(WebView 재시작)을 맞춘다. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.sessions.reconcile();
  }

  async open(path: string): Promise<Result<SessionInfo>> {
    const result = await this.sessions.open(path);
    if (result.ok) void this.anyEditorFor(result.value.sessionId)?.load();
    return result;
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

  setWindowClosing(closing: boolean) {
    this.windowClosing = closing;
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
    const closing = this.runClose(sessionId, editor ?? null).finally(() => this.closing.delete(sessionId));
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
    for (const [sessionId, editor] of this.editors) {
      if (!this.sessions.get(sessionId)) {
        editor.dispose();
        this.editors.delete(sessionId);
      }
    }
  }
}
