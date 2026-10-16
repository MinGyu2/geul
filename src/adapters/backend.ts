// 문서 세션 백엔드 클라이언트(T006). Tauri 명령 document_open·document_close·document_session·document_sessions를 부른다.
//
// `invoke`는 주입한다(테스트는 가짜, 앱은 Tauri의 invoke). 지금은 화면에서 문서를 여는 흐름이 없어 앱이 이 클라이언트를
// 쓰지 않는다. 열기 흐름(대화상자·편집 표면)을 붙이는 T007/T008/T009에서 연결한다.
import {
  parseBackendError,
  parseCloseOutcome,
  parseSessionInfo,
  type CloseOutcome,
  type Result,
  type SessionId,
  type SessionInfo,
} from "./contract";

export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface DocumentBackend {
  /** 파일 형식을 판별하고 세션을 만든다. 엔진에 문서를 불러오지는 않는다. */
  open(path: string): Promise<Result<SessionInfo>>;
  close(sessionId: SessionId): Promise<Result<CloseOutcome>>;
  session(sessionId: SessionId): Promise<Result<SessionInfo>>;
  sessions(): Promise<Result<SessionInfo[]>>;
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

export function createTauriBackend(invoke: Invoke): DocumentBackend {
  return {
    open: (path) => call(invoke, "document_open", { path }, parseSessionInfo),
    close: (sessionId) => call(invoke, "document_close", { sessionId }, forSession(parseCloseOutcome, sessionId)),
    session: (sessionId) => call(invoke, "document_session", { sessionId }, forSession(parseSessionInfo, sessionId)),
    sessions: () => call(invoke, "document_sessions", undefined, parseList),
  };
}
