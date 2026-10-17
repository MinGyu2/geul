// 열린 문서와 엔진 편집 세션의 연결(T007).
//
// - 세션 목록·활성 선택은 DocumentSessions(백엔드 투영)이 가진다. 여기서는 rhwp 세션마다 편집 세션(WASM 모델)을
//   하나만 만들고, 세션이 목록에서 사라지면(닫기·늦게 알게 된 닫힘) 그 모델을 버린다.
// - 열기 → 판별(백엔드) → rhwp면 바로 엔진에 불러온다. DOCX(WordCraft)는 T008 전이라 불러오지 않는다.
// - 닫기는 편집 세션을 먼저 멈추고(이후 늦은 확정 응답 무시) 백엔드 세션을 닫는다.
import type { DocumentBackend } from "../../adapters/backend";
import type { CloseOutcome, Result, SessionId, SessionInfo } from "../../adapters/contract";
import type { DocumentSessions } from "../../adapters/sessions";
import { RhwpEditorSession } from "./rhwp/RhwpEditorSession";
import { loadRhwpModule, type RhwpModule } from "./rhwp/rhwpModule";

export class DocumentWorkspace {
  private readonly editors = new Map<SessionId, RhwpEditorSession>();
  private started = false;

  constructor(
    readonly sessions: DocumentSessions,
    private readonly backend: DocumentBackend,
    private readonly loadModule: () => Promise<RhwpModule> = () => loadRhwpModule(),
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
      this.editors.set(sessionId, editor);
    }
    return editor;
  }

  async close(sessionId: SessionId): Promise<Result<CloseOutcome>> {
    this.editors.get(sessionId)?.dispose();
    this.editors.delete(sessionId);
    return this.sessions.close(sessionId);
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
