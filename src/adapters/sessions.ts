// 열린 문서 세션의 프런트엔드 투영(T006).
//
// 백엔드 SessionRegistry가 권한 있는 기록이고, 여기에는 받은 세션 정보와 활성 선택만 둔다. 세션을 만들거나 ID를
// 정하지 않는다. 규칙:
// - 응답은 그 응답의 sessionId 항목에만 반영한다. 활성 문서가 바뀌어도 다른 세션을 고치지 않는다.
// - 목록에 없는(닫았거나 받은 적 없는) 세션의 늦은 응답은 버린다. 백엔드 기록의 sequence가 지금보다 크지 않은 응답도
//   버린다(같은 응답의 중복·늦게 온 옛 상태·옛 revision). revision이 줄어드는 응답과 형식·엔진이 바뀐 응답은 계약
//   위반이므로 버린다.
// - 열기가 끝나면 그 세션을 목록에 넣는다. 활성으로 만드는 것은 그 열기가 가장 최근 요청이고, 요청한 뒤 사용자가
//   다른 문서를 고르지 않았을 때뿐이다(늦게 끝난 이전 열기가 선택을 빼앗지 않음).
// - 선택은 세션을 바꾸지 않으며 revision도 늘리지 않는다.
// - WebView가 다시 시작되면(T007) 백엔드에는 세션이 남아 있지만 WASM 문서 모델은 사라진다. reconcile()은 시작할 때
//   백엔드 목록을 받아 투영을 채우고, loading·ready 세션을 failed로 돌린다(모델이 없는 세션을 편집 가능으로 보이지 않음).
// subscribe/snapshot은 useSyncExternalStore용이다.
import type { DocumentBackend } from "./backend";
import type { CloseOutcome, Result, SessionId, SessionInfo } from "./contract";

export interface SessionsState {
  /** 세션 ID 순. */
  sessions: readonly SessionInfo[];
  activeId: SessionId | null;
}

export type SessionsAction =
  | { type: "opened"; session: SessionInfo; activate: boolean }
  | { type: "updated"; session: SessionInfo }
  | { type: "selected"; sessionId: SessionId }
  | { type: "closed"; sessionId: SessionId };

export const EMPTY_SESSIONS: SessionsState = { sessions: [], activeId: null };

export function reduceSessions(state: SessionsState, action: SessionsAction): SessionsState {
  const index = state.sessions.findIndex((session) =>
    session.sessionId === (action.type === "opened" || action.type === "updated" ? action.session.sessionId : action.sessionId));
  const current = index >= 0 ? state.sessions[index]! : null;
  switch (action.type) {
    case "opened": {
      if (current) return action.activate ? { ...state, activeId: current.sessionId } : state;
      const sessions = [...state.sessions, action.session].sort((a, b) => a.sessionId - b.sessionId);
      return { sessions, activeId: action.activate || state.activeId === null ? action.session.sessionId : state.activeId };
    }
    case "updated": {
      const next = action.session;
      if (!current || next.sequence <= current.sequence || next.revision < current.revision) return state; // 닫힌 세션·늦게 온 응답
      if (next.format !== current.format || next.engine !== current.engine) return state;
      const sessions = state.sessions.map((session, at) => (at === index ? next : session));
      return { ...state, sessions };
    }
    case "selected":
      return current && state.activeId !== current.sessionId ? { ...state, activeId: current.sessionId } : state;
    case "closed": {
      if (!current) return state;
      const sessions = state.sessions.filter((_, at) => at !== index);
      if (state.activeId !== current.sessionId) return { ...state, sessions };
      const neighbor = sessions[Math.min(index, sessions.length - 1)] ?? null; // 닫은 자리의 다음, 없으면 앞 문서
      return { sessions, activeId: neighbor?.sessionId ?? null };
    }
  }
}

export class DocumentSessions {
  private state: SessionsState = EMPTY_SESSIONS;
  private readonly listeners = new Set<() => void>();
  private openRequests = 0;
  private selections = 0;

  constructor(private readonly backend: DocumentBackend) {}

  readonly snapshot = (): SessionsState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private dispatch(action: SessionsAction) {
    const next = reduceSessions(this.state, action);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  async open(path: string): Promise<Result<SessionInfo>> {
    const request = ++this.openRequests;
    const selections = this.selections;
    const result = await this.backend.open(path);
    const activate = request === this.openRequests && selections === this.selections;
    if (result.ok) {
      this.dispatch({ type: "opened", session: result.value, activate });
    } else if (result.error.code === "AlreadyOpen" && activate) {
      this.dispatch({ type: "selected", sessionId: result.error.sessionId }); // 목록에 있을 때만 바뀐다
    }
    return result;
  }

  /** 사용자가 고른 문서를 활성으로 만든다. 진행 중인 열기는 끝나도 이 선택을 빼앗지 않는다. */
  select(sessionId: SessionId): boolean {
    if (!this.state.sessions.some((session) => session.sessionId === sessionId)) return false;
    this.selections += 1;
    this.dispatch({ type: "selected", sessionId });
    return true;
  }

  async close(sessionId: SessionId): Promise<Result<CloseOutcome>> {
    const result = await this.backend.close(sessionId);
    const gone = result.ok || result.error.code === "StaleSession" || result.error.code === "UnknownSession";
    if (gone) this.dispatch({ type: "closed", sessionId });
    return result;
  }

  /** 백엔드 기록으로 세션 하나를 다시 읽는다. 닫힌 세션이면 목록에서 뺀다. */
  async refresh(sessionId: SessionId): Promise<Result<SessionInfo>> {
    const result = await this.backend.session(sessionId);
    if (result.ok) this.applyUpdate(result.value);
    else if (result.error.code === "StaleSession" || result.error.code === "UnknownSession") this.dispatch({ type: "closed", sessionId });
    return result;
  }

  /** 엔진 작업(T007/T008)이나 refresh가 가져온 세션 정보를 규칙에 따라 반영한다. */
  applyUpdate(session: SessionInfo) {
    this.dispatch({ type: "updated", session });
  }

  get(sessionId: SessionId): SessionInfo | null {
    return this.state.sessions.find((session) => session.sessionId === sessionId) ?? null;
  }

  /**
   * 앱(WebView)이 시작할 때 한 번 부른다. 백엔드에 남은 세션을 목록에 넣고, 엔진 모델이 이 WebView에 없는 loading·ready
   * 세션은 failed로 돌린다. 이미 목록에 있는 세션은 바꾸지 않는다.
   */
  async reconcile(): Promise<Result<SessionInfo[]>> {
    const result = await this.backend.sessions();
    if (!result.ok) return result;
    for (const session of result.value) {
      this.dispatch({ type: "opened", session, activate: false });
      if (session.state === "loading" || session.state === "ready") {
        // 목록을 받은 시도의 번호로만 돌린다. 그사이 새 불러오기가 시작됐으면 StaleLoad로 거부되어 그 시도를 건드리지 않는다.
        const failed = await this.backend.setState(session.sessionId, session.loadGeneration, session.state, "failed");
        if (failed.ok) this.applyUpdate(failed.value);
        else if (failed.error.code === "StaleSession" || failed.error.code === "UnknownSession") {
          this.dispatch({ type: "closed", sessionId: session.sessionId });
        }
      }
    }
    return { ok: true, value: [...this.state.sessions] };
  }
}
