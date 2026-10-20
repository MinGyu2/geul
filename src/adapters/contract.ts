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
  /** 저장(T009): 원본이 바뀌거나 사라질 수 있거나(unsafe) 판단 근거가 없음(unknown). 저장하지 않았고 원본은 그대로다. */
  | { code: "UnsafeSave"; preservation: Preservation }
  /** 저장(T009): 이 환경·파일에서는 원본을 안전하게 바꿀 수 없다(원본 그대로). */
  | { code: "SaveUnsupported"; reason: SaveUnsupportedReason }
  /** 저장(T009): 그 단계가 실패함. 원본은 그대로다. */
  | { code: "SaveFailure"; stage: SaveStage; io?: IoProblem }
  /** 저장(T009): 불러온 뒤 디스크의 파일이 바뀜(외부 수정). 덮어쓰지 않았다. */
  | { code: "FileConflict" }
  | { code: "SaveInProgress"; sessionId: SessionId }
  | { code: "InvalidRequest" }
  | { code: "Internal" };

// ---- 저장(T009) ----

export const PRESERVATION_OUTCOMES = ["safe", "unsafe", "unknown"] as const;
/** 보존 판정. unknown(판단 근거 없음)은 안전하지 않은 것으로 다룬다(저장 차단). */
export type PreservationOutcome = (typeof PRESERVATION_OUTCOMES)[number];
export const FINDING_CODES = [
  "partMissing", "partAdded", "partChanged", "recordsChanged", "originalMalformed", "outputMalformed", "packageInvalid",
  "lossReported", "lossReportInvalid", "reopenMismatch", "limitExceeded", "unsupported", "preflightMissing",
  "previewStale",
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];
/** 판정 근거: 코드와 패키지 안 부분 이름(문서 본문이 아님). */
export interface Finding {
  code: FindingCode;
  part?: string;
}
export interface Preservation {
  outcome: PreservationOutcome;
  findings: Finding[];
}
export const SAVE_UNSUPPORTED_REASONS = [
  "platform", "hard-link", "ownership", "read-only", "metadata", "shared-file", "shared-directory",
] as const;
export type SaveUnsupportedReason = (typeof SAVE_UNSUPPORTED_REASONS)[number];
export const SAVE_STAGES = ["export", "validate", "write", "publish"] as const;
export type SaveStage = (typeof SAVE_STAGES)[number];
export const IO_PROBLEMS = ["permission-denied", "storage-full", "read-only", "other"] as const;
export type IoProblem = (typeof IO_PROBLEMS)[number];

/** 저장 사전 검사 응답: 보존 판정과 이 플랫폼에서 원본을 바꿀 수 있는지. */
export interface SaveCheck {
  preservation: Preservation;
  platformSupported: boolean;
}

/** 저장 결과. durable: 교체 뒤 디렉터리 fsync까지 됐는지. */
export interface SaveOutcome {
  session: SessionInfo;
  bytes: number;
  durable: boolean;
}

/** 엔진 작업 단계(EngineFailure가 어디서 났는지). */
export type EngineStage = "init" | "parse" | "render" | "edit" | "export";
/** 백엔드 엔진(T008 WordCraft)이 보내는 단계. */
export const BACKEND_ENGINE_STAGES = ["parse", "render", "edit", "export"] as const;
export type BackendEngineStage = (typeof BACKEND_ENGINE_STAGES)[number];

/**
 * 프런트엔드에서 만드는 오류.
 * - EngineFailure: 연결한 엔진(WASM)이 그 단계에서 실패함. 엔진 메시지는 담지 않는다(문서 내용이 섞일 수 있음).
 *   백엔드 엔진(WordCraft)의 실패는 같은 모양으로 백엔드가 보낸다(BackendError).
 * - Protocol: 응답이 계약과 맞지 않거나, 계약 밖의 거부(인자 형식 오류·권한 거부 등)를 받음.
 * - UnpreservedChanges: 보존하지 않은 편집(저장하지 않은 확정 변경, 확정 대기·조합 중인 변경)이 있어 닫기·다시 불러오기를
 *   하지 않음. 저장(T009)하거나 사용자가 버리기를 명시적으로 고른 경우에만 진행한다.
 * - RenderLimit: 엔진은 문서를 올바르게 읽었지만, 지원하는 가장 작은 배율로도 화면 bitmap 픽셀 예산을 넘어 그릴 수 없음
 *   (쪽이 너무 크거나 많음). 문서 손상(EngineFailure parse·render)과 구분한다. 배율만 큰 경우는 오류가 아니라 표시 한도다.
 * 저장 오류(UnsafeSave·SaveUnsupported·SaveFailure·FileConflict·SaveInProgress, T009)는 백엔드가 보낸다. 명령을 쓸 수 없는 이유(엔진 미지원 등)는 오류가 아니라
 * 명령 가용성으로 알린다(T010, src/commands/capability.ts).
 */
export type ClientError =
  | { code: "EngineFailure"; engine: EngineId; stage: EngineStage }
  | { code: "Protocol" }
  | { code: "UnpreservedChanges"; sessionId: SessionId }
  | { code: "RenderLimit" }
  /**
   * 저장(T009)을 지금 시작할 수 없음: 확정을 기다리는 편집(pending)·조합(composing)이 있거나, 모델이 일부만 바뀌었을 수
   * 있거나(uncertain), 편집할 수 있는 상태가 아님(state). 아무것도 쓰지 않았다.
   */
  | { code: "SaveNotReady"; reason: "pending" | "composing" | "uncertain" | "state" };

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

/** 응답에 담기는 근거 수·부분 이름 길이 상한(백엔드 MAX_FINDINGS·MAX_PART_CHARS). */
const MAX_FINDINGS = 32;
const MAX_PART_CHARS = 128;

export function parsePreservation(value: unknown): Preservation | null {
  if (!isRecord(value) || !hasOnly(value, ["outcome", "findings"])) return null;
  const { outcome, findings } = value;
  if (!oneOf(PRESERVATION_OUTCOMES, outcome) || !Array.isArray(findings) || findings.length > MAX_FINDINGS) return null;
  const parsed: Finding[] = [];
  for (const finding of findings) {
    if (!isRecord(finding) || !hasOnly(finding, ["code", "part"]) || !oneOf(FINDING_CODES, finding.code)) return null;
    const part = finding.part;
    if (part !== undefined && (typeof part !== "string" || [...part].length > MAX_PART_CHARS)) return null;
    parsed.push(part === undefined ? { code: finding.code } : { code: finding.code, part });
  }
  // safe는 근거가 없을 때만, 근거가 없으면 safe(백엔드 규칙). 어긋나면 계약 밖이다.
  if ((outcome === "safe") !== (parsed.length === 0)) return null;
  return { outcome, findings: parsed };
}

export function parseSaveCheck(value: unknown): SaveCheck | null {
  if (!isRecord(value) || !hasOnly(value, ["preservation", "platformSupported"])) return null;
  const preservation = parsePreservation(value.preservation);
  if (!preservation || typeof value.platformSupported !== "boolean") return null;
  return { preservation, platformSupported: value.platformSupported };
}

export function parseSaveOutcome(value: unknown): SaveOutcome | null {
  if (!isRecord(value) || !hasOnly(value, ["session", "bytes", "durable"])) return null;
  const session = parseSessionInfo(value.session);
  if (!session || !isCount(value.bytes) || typeof value.durable !== "boolean") return null;
  return { session, bytes: value.bytes, durable: value.durable };
}

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
  Record<string, readonly string[] | "format" | "session" | "optional-format" | "count" | "preservation" | "optional-io">
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
  UnsafeSave: { preservation: "preservation" },
  SaveUnsupported: { reason: SAVE_UNSUPPORTED_REASONS },
  SaveFailure: { stage: SAVE_STAGES, io: "optional-io" },
  FileConflict: {},
  SaveInProgress: { sessionId: "session" },
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
      : rule === "preservation" ? parsePreservation(field) !== null && (field as Fields).outcome !== "safe"
      : rule === "optional-io" ? field === undefined || oneOf(IO_PROBLEMS, field)
      : oneOf(rule, field);
    if (!valid) return null;
  }
  return value as BackendError;
}
