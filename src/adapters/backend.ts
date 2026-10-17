// 문서 세션 백엔드 클라이언트. Tauri 명령 document_open·document_close·document_session·document_sessions(T006),
// document_load·document_set_state·document_commit(T007)을 부른다.
//
// `invoke`는 주입한다(테스트는 가짜, 앱은 Tauri의 invoke). document_load는 경로가 아니라 세션 ID만 보내고, 백엔드가
// 판별한 파일을 다시 확인한 바이트를 원시 응답(ArrayBuffer)으로 받는다.
import {
  parseBackendError,
  parseCloseOutcome,
  parseSessionInfo,
  type CloseOutcome,
  type Result,
  type SessionId,
  type SessionInfo,
  type SessionState,
} from "./contract";

export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface DocumentBackend {
  /** 파일 형식을 판별하고 세션을 만든다. 엔진에 문서를 불러오지는 않는다. */
  open(path: string): Promise<Result<SessionInfo>>;
  close(sessionId: SessionId): Promise<Result<CloseOutcome>>;
  session(sessionId: SessionId): Promise<Result<SessionInfo>>;
  sessions(): Promise<Result<SessionInfo[]>>;
  /** 엔진에 넘길 문서 바이트(identified·failed → loading). */
  load(sessionId: SessionId): Promise<Result<Uint8Array>>;
  /** 상태 전이: loading→ready, loading→failed, ready→failed. */
  setState(sessionId: SessionId, from: SessionState, to: SessionState): Promise<Result<SessionInfo>>;
  /** 엔진 모델에서 성공한 변경 count개를 기준 revision 위에 확정한다. */
  commit(sessionId: SessionId, baseRevision: number, count: number): Promise<Result<SessionInfo>>;
}

const PROTOCOL = { ok: false, error: { code: "Protocol" } } as const;

async function call<T>(invoke: Invoke, command: string, args: Record<string, unknown> | undefined, parse: (value: unknown) => T | null): Promise<Result<T>> {
  let value: unknown;
  try {
    value = await invoke(command, args);
  } catch (reason) {
    // 계약에 있는 오류만 그대로 넘긴다. 문자열 거부(인자 형식 오류·권한 거부 등)는 내용을 버리고 Protocol로 바꾼다.
    const error = parseBackendError(reason);
    return error ? { ok: false, error } : PROTOCOL;
  }
  const parsed = parse(value);
  return parsed === null ? PROTOCOL : { ok: true, value: parsed };
}

/** 응답이 요청한 세션에 대한 것인지까지 확인한다. */
const forSession = <T extends { sessionId: SessionId }>(parse: (value: unknown) => T | null, sessionId: SessionId) =>
  (value: unknown) => {
    const parsed = parse(value);
    return parsed?.sessionId === sessionId ? parsed : null;
  };

function parseList(value: unknown): SessionInfo[] | null {
  if (!Array.isArray(value)) return null;
  const sessions = value.map(parseSessionInfo);
  if (sessions.some((session) => session === null)) return null;
  const ids = sessions.map((session) => session!.sessionId);
  return new Set(ids).size === ids.length ? (sessions as SessionInfo[]) : null;
}

function parseBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value instanceof Uint8Array ? value : null;
}

export function createTauriBackend(invoke: Invoke): DocumentBackend {
  return {
    open: (path) => call(invoke, "document_open", { path }, parseSessionInfo),
    close: (sessionId) => call(invoke, "document_close", { sessionId }, forSession(parseCloseOutcome, sessionId)),
    session: (sessionId) => call(invoke, "document_session", { sessionId }, forSession(parseSessionInfo, sessionId)),
    sessions: () => call(invoke, "document_sessions", undefined, parseList),
    load: (sessionId) => call(invoke, "document_load", { sessionId }, parseBytes),
    setState: (sessionId, from, to) =>
      call(invoke, "document_set_state", { sessionId, from, to }, forSession(parseSessionInfo, sessionId)),
    commit: (sessionId, baseRevision, count) =>
      call(invoke, "document_commit", { sessionId, baseRevision, count }, forSession(parseSessionInfo, sessionId)),
  };
}
