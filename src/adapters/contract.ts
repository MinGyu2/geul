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
 * 세션 수명주기(백엔드 `SessionState`). "identified"는 형식만 확정한 상태이며 엔진이 문서를 읽었다는 뜻이 아니다.
 * "loading" → "ready"(엔진이 문서를 불러와 편집할 수 있음) | "failed"(불러오기 실패, 엔진 오류, WebView 재시작으로 모델을
 * 잃음). "failed"에서는 다시 불러올 수 있다(확정하지 않은 편집은 없다).
 */
export const SESSION_STATES = ["identified", "loading", "ready", "failed"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export interface SessionInfo {
  sessionId: SessionId;
  format: DocumentFormat;
  engine: EngineId;
  /** 엔진 문서 모델의 판. 열 때 0, 문서를 바꾸는 연산이 성공할 때만 늘어난다(다시 그리기·선택으로는 늘지 않음). */
  revision: number;
  state: SessionState;
  /** 파일 이름(경로 없음). */
  displayName: string;
  /** "ready"가 된 뒤 확정한 변경이 있음(저장은 T009). */
  dirty: boolean;
  /** 백엔드 세션 기록이 바뀐 횟수. 더 작거나 같은 값의 응답은 늦게 온 것이다. */
  sequence: number;
  /**
   * 불러오기 시도 번호(0 = 아직 불러오지 않음). document_load마다 1씩 늘며, 상태 전이·확정은 이 번호를 함께 보내야 한다.
   * 다른 번호의 요청은 `StaleLoad`로 거부된다(옛 시도가 새 시도의 상태를 바꾸지 못함).
   */
  loadGeneration: number;
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
  | { code: "InvalidState"; sessionId: SessionId; state: SessionState }
  | { code: "RevisionMismatch"; sessionId: SessionId; revision: number }
  | { code: "StaleLoad"; sessionId: SessionId; loadGeneration: number }
  /** 백엔드가 모델을 가진 엔진(T008 WordCraft)이 그 단계에서 실패함. 엔진 메시지는 담지 않는다. */
  | { code: "EngineFailure"; engine: EngineId; stage: BackendEngineStage }
  | { code: "FileChanged" }
  | { code: "InvalidRequest" }
  | { code: "Internal" };

/** 어댑터 작업 중 엔진이 맡을 것(T007/T008에서 구현). */
export type EngineOperation = "load" | "execute" | "save";

/** 엔진 작업 단계(EngineFailure가 어디서 났는지). */
export type EngineStage = "init" | "parse" | "render" | "edit" | "export";
/** 백엔드 엔진(T008 WordCraft)이 보내는 단계. */
export const BACKEND_ENGINE_STAGES = ["parse", "render", "edit", "export"] as const;
export type BackendEngineStage = (typeof BACKEND_ENGINE_STAGES)[number];

/**
 * 프런트엔드에서 만드는 오류.
 * - EngineUnavailable: 엔진이 아직 연결되지 않아 그 작업을 할 수 없음(WordCraft 전체, 두 엔진의 저장).
 * - EngineFailure: 연결한 엔진(WASM)이 그 단계에서 실패함. 엔진 메시지는 담지 않는다(문서 내용이 섞일 수 있음).
 *   백엔드 엔진(WordCraft)의 실패는 같은 모양으로 백엔드가 보낸다(BackendError).
 * - Protocol: 응답이 계약과 맞지 않거나, 계약 밖의 거부(인자 형식 오류·권한 거부 등)를 받음.
 * - UnpreservedChanges: 보존하지 않은 편집(확정했거나 확정 대기·조합 중인 변경)이 있어 닫기·다시 불러오기를 하지 않음.
 *   저장 기능이 없으므로(T009) 사용자가 버리기를 명시적으로 고른 경우에만 진행한다.
 * - RenderLimit: 엔진은 문서를 올바르게 읽었지만, 지원하는 가장 작은 배율로도 화면 bitmap 픽셀 예산을 넘어 그릴 수 없음
 *   (쪽이 너무 크거나 많음). 문서 손상(EngineFailure parse·render)과 구분한다. 배율만 큰 경우는 오류가 아니라 표시 한도다.
 * 계획의 UnsupportedCommand(T010), UnsafeSave·SaveFailure·FileConflict(T009/T014)는 해당 작업에서 추가한다.
 */
export type ClientError =
  | { code: "EngineUnavailable"; engine: EngineId; operation: EngineOperation }
  | { code: "EngineFailure"; engine: EngineId; stage: EngineStage }
  | { code: "Protocol" }
  | { code: "UnpreservedChanges"; sessionId: SessionId }
  | { code: "RenderLimit" };

export type DocumentError = BackendError | ClientError;

export type Result<T> = { ok: true; value: T } | { ok: false; error: DocumentError };

// ---- 응답 검사 ----

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);
const isSessionId = (value: unknown): value is SessionId => Number.isSafeInteger(value) && (value as number) >= 1;
const hasOnly = (value: Fields, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function parseSessionInfo(value: unknown): SessionInfo | null {
  const keys = ["sessionId", "format", "engine", "revision", "state", "displayName", "dirty", "sequence", "loadGeneration"];
  if (!isRecord(value) || !hasOnly(value, keys)) return null;
  const { sessionId, format, engine, revision, state, displayName, dirty, sequence, loadGeneration } = value;
  if (!isSessionId(sessionId) || !oneOf(DOCUMENT_FORMATS, format) || !oneOf(ENGINES, engine)) return null;
  if (ENGINE_FOR_FORMAT[format] !== engine) return null; // 라우팅 규칙과 어긋난 응답
  if (!isCount(revision) || !oneOf(SESSION_STATES, state) || !isCount(sequence) || !isCount(loadGeneration)) return null;
  if (typeof displayName !== "string" || typeof dirty !== "boolean") return null;
  return { sessionId, format, engine, revision, state, displayName, dirty, sequence, loadGeneration };
}

export function parseCloseOutcome(value: unknown): CloseOutcome | null {
  if (!isRecord(value) || !hasOnly(value, ["sessionId", "alreadyClosed"])) return null;
  const { sessionId, alreadyClosed } = value;
  if (!isSessionId(sessionId) || typeof alreadyClosed !== "boolean") return null;
  return { sessionId, alreadyClosed };
}

const ERROR_FIELDS: Record<
  BackendError["code"],
  Record<string, readonly string[] | "format" | "session" | "optional-format" | "count">
> = {
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
  InvalidState: { sessionId: "session", state: SESSION_STATES },
  RevisionMismatch: { sessionId: "session", revision: "count" },
  StaleLoad: { sessionId: "session", loadGeneration: "count" },
  EngineFailure: { engine: ENGINES, stage: BACKEND_ENGINE_STAGES },
  FileChanged: {},
  InvalidRequest: {},
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
      : rule === "count" ? isCount(field)
      : oneOf(rule, field);
    if (!valid) return null;
  }
  return value as BackendError;
}
