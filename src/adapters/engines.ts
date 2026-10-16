// 엔진 어댑터 경계(T006). 엔진마다 문서 모델·렌더링·편집 이력을 따로 가진다(FR-004). 공통 문서 모델은 두지 않는다.
//
// 작업 구분:
// - T006에서 동작: engine·formats, capability(모든 문서 명령을 "엔진 연결 전"으로 사용할 수 없다고 보고).
// - T007(rhwp)/T008(WordCraft)에서 구현: load(엔진에 문서 불러오기), execute(문서 명령), save(원본 형식 저장).
//   지금은 아무것도 바꾸지 않고 EngineUnavailable을 돌려준다(가짜 성공·가짜 문서 없음).
// - 렌더링·커서·선택·IME는 편집 표면마다 다르므로(docs/architecture/editor-surface-decision.md) 이 계약에 넣지 않고
//   T007/T008 PoC 결과로 정한다.
// 이 메서드 이름과 인자는 이 앱의 계약이며 rhwp·WordCraft의 공개 API가 아니다.
import { ENGINE_FOR_FORMAT, type DocumentFormat, type EngineId, type EngineOperation, type Result, type SessionId, type SessionInfo } from "./contract";

export type Capability = { state: "supported" } | { state: "unavailable"; reason: "engine-not-integrated" };

/** 문서를 바꾸는 요청. revision은 요청한 쪽이 알고 있는 판이며, 엔진의 판과 다르면 실행하지 않아야 한다. */
export interface ExecuteRequest {
  sessionId: SessionId;
  revision: number;
  commandId: string;
  args?: unknown;
}

/** 문서를 바꾼 결과. 어느 세션의 몇 번째 판인지로 늦게 도착한 응답을 가려낸다(sessions.ts). */
export interface RevisionResult {
  sessionId: SessionId;
  revision: number;
}

export interface EngineAdapter {
  readonly engine: EngineId;
  readonly formats: readonly DocumentFormat[];
  capability(session: SessionInfo, commandId: string): Capability;
  load(session: SessionInfo): Promise<Result<SessionInfo>>;
  execute(request: ExecuteRequest): Promise<Result<RevisionResult>>;
  save(session: SessionInfo): Promise<Result<RevisionResult>>;
}

const NOT_INTEGRATED: Capability = { state: "unavailable", reason: "engine-not-integrated" };

/** 아직 연결하지 않은 엔진. 모든 작업을 거부하고 어떤 상태도 바꾸지 않는다. */
function unintegratedAdapter(engine: EngineId): EngineAdapter {
  const formats = (Object.keys(ENGINE_FOR_FORMAT) as DocumentFormat[]).filter((format) => ENGINE_FOR_FORMAT[format] === engine);
  const unavailable = (operation: EngineOperation) =>
    Promise.resolve({ ok: false, error: { code: "EngineUnavailable", engine, operation } } as const);
  return {
    engine,
    formats,
    capability: () => NOT_INTEGRATED,
    load: () => unavailable("load"),
    execute: () => unavailable("execute"),
    save: () => unavailable("save"),
  };
}

const ADAPTERS: Record<EngineId, EngineAdapter> = {
  rhwp: unintegratedAdapter("rhwp"),
  wordcraft: unintegratedAdapter("wordcraft"),
};

/** 세션의 엔진(백엔드가 정함)에 맞는 어댑터. 형식으로 다시 고르지 않는다. */
export function adapterFor(session: Pick<SessionInfo, "engine">): EngineAdapter {
  return ADAPTERS[session.engine];
}
