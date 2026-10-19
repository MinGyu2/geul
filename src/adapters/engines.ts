// 엔진 어댑터 경계(T006). 엔진마다 문서 모델·렌더링·편집 이력을 따로 가진다(FR-004). 공통 문서 모델은 두지 않는다.
//
// 작업 구분:
// - 이 경계는 리본 등 화면 명령(T010 명령 레지스트리)을 엔진에 보내는 자리다. engine·formats,
//   capability(모든 문서 명령을 "엔진 연결 전"으로 사용할 수 없다고 보고), execute·save(EngineUnavailable, 가짜 성공 없음).
// - 원본 형식 저장(T009)은 이 경계를 거치지 않는다: 편집 세션(RhwpEditorSession·DocxEditorSession의 checkSave·save)이 엔진 출력을
//   만들고 백엔드 저장 서비스(src-tauri/src/services/save/)가 검사·교체한다. 이 save는 T010에서 명령으로 묶을 때까지 쓰지 않는다.
// - 엔진에 문서를 불러오기와 본문 입력(문자·삭제·문단 나누기·커서·선택·IME)은 편집 표면이 맡는다(T007 rhwp:
//   src/components/Editor/rhwp/, 세션 수명주기는 DocumentSessions·백엔드). 그래서 T006의 load는 이 경계에서 뺐다.
//   편집 표면도 변경을 백엔드에 revision으로 확정하므로 revision 권한은 하나다.
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
