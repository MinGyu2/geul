// 열린 문서 세션의 프런트엔드 투영(T006).
//
// 백엔드 SessionRegistry가 권한 있는 기록이고, 여기에는 받은 세션 정보와 활성 선택만 둔다. 세션을 만들거나 ID를
// 정하지 않는다. 규칙:
// - 응답은 그 응답의 sessionId 항목에만 반영한다. 활성 문서가 바뀌어도 다른 세션을 고치지 않는다.
// - 목록에 없는(닫았거나 받은 적 없는) 세션의 늦은 응답은 버린다. revision이 지금보다 낮은 응답도 버린다(같으면 반영).
//   형식·엔진이 바뀐 응답은 계약 위반이므로 버린다.
// - 열기가 끝나면 그 세션을 목록에 넣는다. 활성으로 만드는 것은 그 열기가 가장 최근 요청이고, 요청한 뒤 사용자가
//   다른 문서를 고르지 않았을 때뿐이다(늦게 끝난 이전 열기가 선택을 빼앗지 않음).
// - 선택은 세션을 바꾸지 않으며 revision도 늘리지 않는다.
// 지금은 화면에 연결하지 않았다(열기 흐름이 생기는 T007~T009에서 연결). subscribe/snapshot은 useSyncExternalStore용이다.
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
      if (!current || next.revision < current.revision) return state; // 닫힌 세션·늦게 온 옛 판
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
}
