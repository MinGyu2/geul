// 문서 세션 IPC 계약(T006). Rust `src-tauri/src/document/`의 직렬화 형식과 같아야 한다.
//
// - 형식 판별·엔진 배정·세션 ID·revision은 백엔드가 정한다. 프런트엔드는 받은 값을 검사만 하고 바꾸지 않는다.
//   ENGINE_FOR_FORMAT은 응답이 라우팅 규칙(FR-004)과 어긋나는지 확인하는 데만 쓴다.
// - 응답은 신뢰 경계를 넘어온 값이므로 모양을 검사한다. 맞지 않으면 null을 돌려주고, 호출하는 쪽은
//   `Protocol` 오류로 다룬다.
// - 오류에는 code와 고정된 세부 값만 있다(경로·문서 내용·운영체제 오류 문구 없음). 화면 문구는 code로 번역한다.

export const DOCUMENT_FORMATS = ["hwp", "hwpx", "docx"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export const ENGINES = ["rhwp", "wordcraft"] as const;
export type EngineId = (typeof ENGINES)[number];

/** 형식별 담당 엔진(백엔드 `Format::engine`과 같음). */
export const ENGINE_FOR_FORMAT: Record<DocumentFormat, EngineId> = { hwp: "rhwp", hwpx: "rhwp", docx: "wordcraft" };

/** 백엔드가 발급하는 세션 ID. 1부터 늘어나며 이 실행 동안 다시 쓰지 않는다. */
export type SessionId = number;

/**
 * 세션 수명주기. T006에는 형식만 확정한 "identified"뿐이며, 엔진에 문서를 불러왔다는 뜻이 아니다.
 * 엔진 불러오기 상태는 T007/T008에서 추가한다.
 */
export type SessionState = "identified";

export interface SessionInfo {
  sessionId: SessionId;
  format: DocumentFormat;
  engine: EngineId;
  /** 엔진 문서 모델의 판. 열 때 0, 문서를 바꾸는 연산이 성공할 때만 늘어난다(다시 그리기·선택으로는 늘지 않음). */
  revision: number;
  state: SessionState;
  /** 파일 이름(경로 없음). */
  displayName: string;
}

export interface CloseOutcome {
  sessionId: SessionId;
  /** 이미 닫힌 세션을 다시 닫았으면 true(오류가 아님). */
  alreadyClosed: boolean;
}

export type UnsupportedKind =
  | "extension" | "hwp3" | "hwp-version" | "legacy-word" | "other-ole" | "word-variant" | "other-ooxml" | "other-zip"
  | "ambiguous" | "unknown";
export type ParseProblem = "empty" | "truncated" | "corrupt-container" | "missing-part" | "invalid-part";
export type LimitKind = "file-size" | "entry-count" | "metadata-size" | "part-size" | "session-count" | "pending-opens";

/** 백엔드가 보내는 오류. */
export type BackendError =
  | { code: "InvalidPath"; reason: "empty" | "relative" | "too-long" | "contains-nul" }
  | { code: "Unreadable"; reason: "not-found" | "permission-denied" | "not-a-file" | "io" }
  | { code: "UnsupportedFormat"; kind: UnsupportedKind }
  | { code: "ExtensionMismatch"; declared: DocumentFormat; detected: DocumentFormat }
  | { code: "Encrypted"; format?: DocumentFormat }
  | { code: "ParseFailure"; format?: DocumentFormat; reason: ParseProblem }
  | { code: "ResourceLimit"; limit: LimitKind }
  | { code: "AlreadyOpen" | "UnknownSession" | "StaleSession"; sessionId: SessionId }
  | { code: "Internal" };

/** 어댑터 작업 중 엔진이 맡을 것(T007/T008에서 구현). */
export type EngineOperation = "load" | "execute" | "save";

/**
 * 프런트엔드에서 만드는 오류.
 * - EngineUnavailable: 엔진이 아직 연결되지 않아 그 작업을 할 수 없음(T006의 모든 엔진 작업).
 * - Protocol: 응답이 계약과 맞지 않거나, 계약 밖의 거부(인자 형식 오류·권한 거부 등)를 받음.
 * 계획의 UnsupportedCommand(T010), UnsafeSave·SaveFailure·FileConflict(T009/T014)는 해당 작업에서 추가한다.
 */
export type ClientError = { code: "EngineUnavailable"; engine: EngineId; operation: EngineOperation } | { code: "Protocol" };

export type DocumentError = BackendError | ClientError;

export type Result<T> = { ok: true; value: T } | { ok: false; error: DocumentError };

// ---- 응답 검사 ----

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);
const isSessionId = (value: unknown): value is SessionId => Number.isSafeInteger(value) && (value as number) >= 1;
const hasOnly = (value: Fields, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));

export function parseSessionInfo(value: unknown): SessionInfo | null {
  if (!isRecord(value) || !hasOnly(value, ["sessionId", "format", "engine", "revision", "state", "displayName"])) return null;
  const { sessionId, format, engine, revision, state, displayName } = value;
  if (!isSessionId(sessionId) || !oneOf(DOCUMENT_FORMATS, format) || !oneOf(ENGINES, engine)) return null;
  if (ENGINE_FOR_FORMAT[format] !== engine) return null; // 라우팅 규칙과 어긋난 응답
  if (!Number.isSafeInteger(revision) || (revision as number) < 0 || state !== "identified") return null;
  if (typeof displayName !== "string") return null;
  return { sessionId, format, engine, revision: revision as number, state, displayName };
}

export function parseCloseOutcome(value: unknown): CloseOutcome | null {
  if (!isRecord(value) || !hasOnly(value, ["sessionId", "alreadyClosed"])) return null;
  const { sessionId, alreadyClosed } = value;
  if (!isSessionId(sessionId) || typeof alreadyClosed !== "boolean") return null;
  return { sessionId, alreadyClosed };
}

const ERROR_FIELDS: Record<BackendError["code"], Record<string, readonly string[] | "format" | "session" | "optional-format">> = {
  InvalidPath: { reason: ["empty", "relative", "too-long", "contains-nul"] },
  Unreadable: { reason: ["not-found", "permission-denied", "not-a-file", "io"] },
  UnsupportedFormat: {
    kind: ["extension", "hwp3", "hwp-version", "legacy-word", "other-ole", "word-variant", "other-ooxml", "other-zip", "ambiguous", "unknown"],
  },
  ExtensionMismatch: { declared: "format", detected: "format" },
  Encrypted: { format: "optional-format" },
  ParseFailure: { format: "optional-format", reason: ["empty", "truncated", "corrupt-container", "missing-part", "invalid-part"] },
  ResourceLimit: { limit: ["file-size", "entry-count", "metadata-size", "part-size", "session-count", "pending-opens"] },
  AlreadyOpen: { sessionId: "session" },
  UnknownSession: { sessionId: "session" },
  StaleSession: { sessionId: "session" },
  Internal: {},
};

export function parseBackendError(value: unknown): BackendError | null {
  if (!isRecord(value) || typeof value.code !== "string" || !Object.prototype.hasOwnProperty.call(ERROR_FIELDS, value.code)) return null;
  const fields = ERROR_FIELDS[value.code as BackendError["code"]];
  if (!hasOnly(value, ["code", ...Object.keys(fields)])) return null;
  for (const [key, rule] of Object.entries(fields)) {
    const field = value[key];
    const valid =
      rule === "format" ? oneOf(DOCUMENT_FORMATS, field)
      : rule === "optional-format" ? field === undefined || oneOf(DOCUMENT_FORMATS, field)
      : rule === "session" ? isSessionId(field)
      : oneOf(rule, field);
    if (!valid) return null;
  }
  return value as BackendError;
}
