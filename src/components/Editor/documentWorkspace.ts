// 열린 문서와 엔진 편집 세션의 연결(T007).
//
// - 세션 목록·활성 선택은 DocumentSessions(백엔드 투영)이 가진다. 여기서는 rhwp 세션마다 편집 세션(WASM 모델)을
//   하나만 만들고, 세션이 목록에서 사라지면(닫기·늦게 알게 된 닫힘) 그 모델을 버린다.
// - 열기 → 판별(백엔드) → rhwp면 바로 엔진에 불러온다. DOCX(WordCraft)는 T008 전이라 불러오지 않는다.
// - 닫기: 저장 기능이 없으므로(T009) 편집한 모델(확정했거나 확정 대기·조합 중인 변경)은 `discard: true` 없이 닫지
//   않는다(UnpreservedChanges). 닫는 동안은 편집을 막고, 백엔드가 닫았다고 답한 뒤에(목록에서 빠질 때) 모델을 버린다.
//   백엔드 닫기가 실패하면 모델을 그대로 두고 편집을 다시 허용한다. 같은 세션의 닫기를 되풀이하면 진행 중인 닫기
//   하나를 기다린다(백엔드 닫기·정리는 한 번).
import type { DocumentBackend } from "../../adapters/backend";
import type { CloseOutcome, Result, SessionId, SessionInfo } from "../../adapters/contract";
import type { DocumentSessions } from "../../adapters/sessions";
import { RhwpEditorSession } from "./rhwp/RhwpEditorSession";
import { loadRhwpModule, type RhwpModule } from "./rhwp/rhwpModule";
import type { WindowClosePort } from "./windowClose";

export class DocumentWorkspace {
  private readonly editors = new Map<SessionId, RhwpEditorSession>();
  private readonly closing = new Map<SessionId, Promise<Result<CloseOutcome>>>();
  private started = false;
  private windowClosing = false;

  constructor(
    readonly sessions: DocumentSessions,
    private readonly backend: DocumentBackend,
    private readonly loadModule: () => Promise<RhwpModule> = () => loadRhwpModule(),
    readonly windowClose?: WindowClosePort,
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
    if (result.ok && result.value.engine === "rhwp") void this.editorFor(result.value.sessionId)?.load();
    return result;
  }

  /** rhwp 세션의 편집 세션(없으면 만든다). 목록에 없거나 rhwp가 아니면 null. */
  editorFor(sessionId: SessionId): RhwpEditorSession | null {
    const info = this.sessions.get(sessionId);
    if (!info || info.engine !== "rhwp") return null;
    let editor = this.editors.get(sessionId);
    if (!editor) {
      editor = new RhwpEditorSession(sessionId, this.backend, this.sessions, this.loadModule);
      editor.setClosing(this.windowClosing);
      this.editors.set(sessionId, editor);
    }
    return editor;
  }

  /** 모든 탭을 함께 보호한다. backend dirty보다 앞선 pending·조합·uncertain도 포함한다. */
  get hasUnpreservedChanges() {
    return this.sessions.snapshot().sessions.some(info => info.dirty || this.editors.get(info.sessionId)?.hasUnpreservedChanges);
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
    if (editor?.hasUnpreservedChanges && !options.discard) {
      return Promise.resolve({ ok: false, error: { code: "UnpreservedChanges", sessionId } });
    }
    const closing = this.runClose(sessionId, editor ?? null).finally(() => this.closing.delete(sessionId));
    this.closing.set(sessionId, closing);
    return closing;
  }

  private async runClose(sessionId: SessionId, editor: RhwpEditorSession | null): Promise<Result<CloseOutcome>> {
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
