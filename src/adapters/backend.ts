// 문서 세션 백엔드 클라이언트. Tauri 명령 document_open·document_close·document_session·document_sessions(T006),
// document_load·document_set_state·document_commit(T007)을 부른다.
//
// `invoke`는 주입한다(테스트는 가짜, 앱은 Tauri의 invoke). document_load는 경로가 아니라 세션 ID만 보내고, 백엔드가
// 판별한 파일을 다시 확인한 바이트를 원시 응답(ArrayBuffer)으로 받는다. 응답 앞 8바이트는 이번 불러오기 시도 번호
// (u64 little-endian)이고, 그 뒤가 문서 바이트다. 이 시도의 상태 전이·확정은 그 번호를 함께 보낸다.
//
// 저장(T009, rhwp 세션): document_original은 사전 검사용 원본 바이트(원시 응답), document_preflight·document_save는 원시 요청
// 본문 프레임(saveFrame — 백엔드 services/save/commands.rs와 같은 모양)을 보낸다. 경로는 보내지 않는다.
import {
  parseBackendError,
  parseCloseOutcome,
  parseSaveCheck,
  parseSaveOutcome,
  parseSessionInfo,
  type CloseOutcome,
  type SaveCheck,
  type SaveOutcome,
  type Result,
  type SessionId,
  type SessionInfo,
  type SessionState,
} from "./contract";

/** Tauri invoke: 인자는 이름 있는 값 또는 원시 본문(Uint8Array). */
export type Invoke = (command: string, args?: Record<string, unknown> | Uint8Array) => Promise<unknown>;

/** document_load 응답: 이번 불러오기 시도 번호와 문서 바이트. */
export interface LoadedBytes {
  generation: number;
  bytes: Uint8Array;
}

/** document_load 응답 머리(시도 번호 u64 LE)의 길이. 백엔드 `LOAD_HEADER_LEN`과 같다. */
export const LOAD_HEADER_LEN = 8;

export interface DocumentBackend {
  /** 파일 형식을 판별하고 세션을 만든다. 엔진에 문서를 불러오지는 않는다. */
  open(path: string): Promise<Result<SessionInfo>>;
  close(sessionId: SessionId): Promise<Result<CloseOutcome>>;
  session(sessionId: SessionId): Promise<Result<SessionInfo>>;
  sessions(): Promise<Result<SessionInfo[]>>;
  /** 엔진에 넘길 문서 바이트(identified·failed → loading). */
  load(sessionId: SessionId): Promise<Result<LoadedBytes>>;
  /** 상태 전이: loading→ready, loading→failed, ready→failed. generation은 그 불러오기 시도의 번호. */
  setState(sessionId: SessionId, generation: number, from: SessionState, to: SessionState): Promise<Result<SessionInfo>>;
  /** 엔진 모델에서 성공한 변경 count개를 기준 revision 위에 확정한다. generation은 그 모델을 만든 불러오기 시도의 번호. */
  commit(sessionId: SessionId, generation: number, baseRevision: number, count: number): Promise<Result<SessionInfo>>;
  /** 사전 검사용 원본 바이트(T009): 불러온 파일과 같은 파일·지문·내용일 때만(아니면 FileConflict). */
  original(sessionId: SessionId, generation: number): Promise<Result<Uint8Array>>;
  /** 편집 없는 엔진 출력과 그 손실 보고로 보존 사전 검사(T009). 결과는 백엔드가 그 원본에 대해 기억한다. */
  preflight(sessionId: SessionId, generation: number, unedited: Uint8Array, contentLoss: unknown): Promise<Result<SaveCheck>>;
  /** 편집한 엔진 출력을 원본 형식으로 저장(T009). revision은 그 출력이 나타내는 판, reopen은 다시 열어 비교한 결과. */
  save(sessionId: SessionId, generation: number, revision: number, output: Uint8Array, contentLoss: unknown, reopen: ReopenEvidence): Promise<Result<SaveOutcome>>;
}

/** 엔진 출력을 다시 열어 편집 모델과 비교한 결과(넷 다 참이어야 저장한다). */
export interface ReopenEvidence {
  formatEqual: boolean;
  pagesEqual: boolean;
  textEqual: boolean;
  controlsEqual: boolean;
}

/** 저장 요청 프레임 머리: "GSV1"·세션·시도·판(u64 LE 셋)·메타 길이(u32 LE). 백엔드 FRAME_MAGIC과 같다. */
const FRAME_MAGIC = [0x47, 0x53, 0x56, 0x31];
const FRAME_HEADER = 4 + 8 * 3 + 4;

/** 안전한 정수를 u64 LE로(BigInt 없이, 빌드 대상 safari13). */
function writeU64(view: DataView, at: number, value: number) {
  view.setUint32(at, value % 0x1_0000_0000, true);
  view.setUint32(at + 4, Math.floor(value / 0x1_0000_0000), true);
}

/** 저장·사전 검사 요청 본문(백엔드 parse_frame과 같은 모양). */
export function saveFrame(sessionId: SessionId, generation: number, revision: number, meta: unknown, payload: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const frame = new Uint8Array(FRAME_HEADER + json.length + payload.length);
  frame.set(FRAME_MAGIC, 0);
  const view = new DataView(frame.buffer);
  writeU64(view, 4, sessionId);
  writeU64(view, 12, generation);
  writeU64(view, 20, revision);
  view.setUint32(28, json.length, true);
  frame.set(json, FRAME_HEADER);
  frame.set(payload, FRAME_HEADER + json.length);
  return frame;
}

const parseRaw = (value: unknown): Uint8Array | null =>
  value instanceof ArrayBuffer ? new Uint8Array(value) : value instanceof Uint8Array ? value : null;

const PROTOCOL = { ok: false, error: { code: "Protocol" } } as const;

export async function call<T>(invoke: Invoke, command: string, args: Record<string, unknown> | Uint8Array | undefined, parse: (value: unknown) => T | null): Promise<Result<T>> {
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

export function parseLoaded(value: unknown): LoadedBytes | null {
  const raw = value instanceof ArrayBuffer ? new Uint8Array(value) : value instanceof Uint8Array ? value : null;
  if (!raw || raw.length < LOAD_HEADER_LEN) return null;
  // BigInt 없이 읽는다(빌드 대상 safari13). 아래·위 32비트, 위는 2^21 미만이어야 Number로 정확하다.
  const view = new DataView(raw.buffer, raw.byteOffset, LOAD_HEADER_LEN);
  const low = view.getUint32(0, true);
  const high = view.getUint32(4, true);
  if (high >= 0x200000) return null; // Number.MAX_SAFE_INTEGER(2^53 - 1)를 넘는다
  const generation = high * 0x1_0000_0000 + low;
  // 0은 "불러온 적 없음"이므로 응답에 올 수 없다.
  if (generation < 1) return null;
  return { generation, bytes: raw.subarray(LOAD_HEADER_LEN) };
}

export function createTauriBackend(invoke: Invoke): DocumentBackend {
  return {
    open: (path) => call(invoke, "document_open", { path }, parseSessionInfo),
    close: (sessionId) => call(invoke, "document_close", { sessionId }, forSession(parseCloseOutcome, sessionId)),
    session: (sessionId) => call(invoke, "document_session", { sessionId }, forSession(parseSessionInfo, sessionId)),
    sessions: () => call(invoke, "document_sessions", undefined, parseList),
    load: (sessionId) => call(invoke, "document_load", { sessionId }, parseLoaded),
    setState: (sessionId, loadGeneration, from, to) =>
      call(invoke, "document_set_state", { sessionId, loadGeneration, from, to }, forSession(parseSessionInfo, sessionId)),
    commit: (sessionId, loadGeneration, baseRevision, count) =>
      call(invoke, "document_commit", { sessionId, loadGeneration, baseRevision, count }, forSession(parseSessionInfo, sessionId)),
    original: (sessionId, loadGeneration) => call(invoke, "document_original", { sessionId, loadGeneration }, parseRaw),
    preflight: (sessionId, generation, unedited, contentLoss) =>
      call(invoke, "document_preflight", saveFrame(sessionId, generation, 0, { contentLoss }, unedited), parseSaveCheck),
    save: (sessionId, generation, revision, output, contentLoss, reopen) =>
      call(invoke, "document_save", saveFrame(sessionId, generation, revision, { contentLoss, reopen }, output), (value) => {
        const outcome = parseSaveOutcome(value);
        return outcome?.session.sessionId === sessionId ? outcome : null;
      }),
  };
}
