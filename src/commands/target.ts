// 열린 문서에 대한 명령의 대상(T010). 편집 세션(RhwpEditorSession·DocxEditorSession)이 구현한다: 명령은 그 세션의 편집
// 경로(T007·T008 대기열, T009 저장 절차)로만 실행되고, 레지스트리는 엔진 함수를 직접 부르지 않는다.
//
// 상태 권한: 세션 수명주기·revision·dirty는 백엔드 SessionRegistry가 정하고(DocumentSessions가 투영), 실행 취소 기록·선택·서식은
// 각 엔진이 가진다. 여기의 스냅숏은 그 값을 읽어 가용성을 정할 뿐 따로 기억하지 않는다.
import type { EngineId, SessionId } from "../adapters/contract";
import type { DocxFormatAccess } from "../adapters/docx";
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
  /**
   * IME 트랜잭션이 끝나지 않음: 조합 중이거나, 앱이 먼저 확정한 조합이 입력기의 최종 글자를 기다림(provisional, T010 안정화).
   * 그 사이의 문서 명령은 입력기의 최종 글자로 고치는 정보(ReplaceInserted)를 깨뜨린다.
   */
  composing: boolean;
  /** 보내는 중이거나 보낼 연산이 있음(이동·선택 포함, 백엔드 확정 전). */
  pending: boolean;
  /**
   * 보내는 중·보낼 연산을 엔진 기록(history)에 차례로 적용했을 때 예상하는 기록(T010 안정화 P2-A). 대기 연산이 없으면 null.
   * 글자 넣기·지우기·서식 등 바꾸는 연산은 실행 취소 단계를 더하고 다시 실행 기록을 버리며(WordCraft는 성공한 바꾸는 명령마다
   * 기록 지점을 남김), 실행 취소는 다시 실행 단계를, 다시 실행은 실행 취소 단계를 만든다. 이동·클릭·선택·표지는 바꾸지 않는다.
   * 실제로 단계가 생겼는지는 엔진이 실행할 때 정한다(엔진이 거부한 연산은 단계를 만들지 않음). 앱이 따로 가진 기록이 아니다.
   */
  queuedHistory: { undo: boolean; redo: boolean } | null;
  /** 저장 사전 검사·저장 중. */
  saving: boolean;
  /** 엔진의 실행 취소 기록. 엔진에 기록이 없으면 null. */
  history: { undo: boolean; redo: boolean } | null;
  /** 선택(없으면 다음 입력)의 글자 서식. 엔진이 알려 주지 않으면 null. */
  format: Readonly<Record<CharFormatFlag, boolean>> | null;
  /** 문서 보호가 직접 글자 서식을 허용하는지(엔진이 알려 주면). null이면 서식 상태가 없는 엔진. */
  formatAccess: DocxFormatAccess | null;
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
