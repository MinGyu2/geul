// 열린 문서에 대한 명령의 대상(T010). 편집 세션(RhwpEditorSession·DocxEditorSession)이 구현한다: 명령은 그 세션의 편집
// 경로(T007·T008 대기열, T009 저장 절차)로만 실행되고, 레지스트리는 엔진 함수를 직접 부르지 않는다.
//
// 상태 권한: 세션 수명주기·revision·dirty는 백엔드 SessionRegistry가 정하고(DocumentSessions가 투영), 실행 취소 기록·선택·서식은
// 각 엔진이 가진다. 여기의 스냅숏은 그 값을 읽어 가용성을 정할 뿐 따로 기억하지 않는다.
import type { EngineId, SessionId } from "../adapters/contract";
import type { DocumentCommandId } from "./registry";

export type CharFormatFlag = "bold" | "italic" | "underline" | "strikethrough";

/** 명령 가용성을 정하는 편집 세션의 지금 상태. */
export interface DocumentCommandSnapshot {
  sessionId: SessionId;
  engine: EngineId;
  /** 그 세션의 불러오기 시도 번호·백엔드가 확인한 revision(늦은 응답·낡은 요청 판단은 세션·백엔드가 한다). */
  loadGeneration: number;
  revision: number;
  /** 엔진에 불러왔고 닫는 중이 아님(저장할 수 있는 상태). */
  loaded: boolean;
  /** 지금 편집할 수 있음(loaded이고 그림 예산 초과·그림 실패가 아님). */
  editable: boolean;
  /** IME 조합 중. */
  composing: boolean;
  /** 보내는 중이거나 보낼 편집이 있음(백엔드 확정 전). */
  pending: boolean;
  /** 저장 사전 검사·저장 중. */
  saving: boolean;
  /** 엔진의 실행 취소 기록. 엔진에 기록이 없으면 null. */
  history: { undo: boolean; redo: boolean } | null;
  /** 선택(없으면 다음 입력)의 글자 서식. 엔진이 알려 주지 않으면 null. */
  format: Readonly<Record<CharFormatFlag, boolean>> | null;
}

/** 명령을 받은 결과. accepted면 세션의 편집 경로에 넣었다(완료·실패는 세션이 처리하고 보인다). */
export type CommandDispatch = { accepted: true } | { accepted: false };

export interface DocumentCommandTarget {
  readonly sessionId: SessionId;
  readonly engine: EngineId;
  snapshot(): DocumentCommandSnapshot;
  /**
   * 명령을 이 세션에 실행한다. 레지스트리가 가용성을 확인한 뒤 부르지만, 세션은 자기 상태로 다시 확인하고 맞지 않으면
   * 아무것도 바꾸지 않고 거절한다(accepted: false).
   */
  execute(command: DocumentCommandId): CommandDispatch;
}
