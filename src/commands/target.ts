// 열린 문서에 대한 명령의 대상(T010). 편집 세션(RhwpEditorSession·DocxEditorSession)이 구현한다: 명령은 그 세션의 편집
// 경로(T007·T008 대기열, T009 저장 절차)로만 실행되고, 레지스트리는 엔진 함수를 직접 부르지 않는다.
//
// 상태 권한: 세션 수명주기·revision·dirty는 백엔드 SessionRegistry가 정하고(DocumentSessions가 투영), 실행 취소 기록·선택·서식은
// 각 엔진이 가진다. 여기의 스냅숏은 그 값을 읽어 가용성을 정할 뿐 따로 기억하지 않는다.
import type { EngineId, SessionId } from "../adapters/contract";
import type { DocxFormatAccess } from "../adapters/docx";
import type { Message } from "../language";
import type { DocumentCommandId } from "./registry";

export type CharFormatFlag = "bold" | "italic" | "underline" | "strikethrough";

/**
 * 대기 연산을 적용한 뒤 실행 취소(또는 다시 실행) 한 단계를 엔진이 가질지(T010 마무리 안정화): available = 적어도 한 단계가 있다고
 * 안다, none = 없다고 안다, unknown = 엔진 응답 전에는 알 수 없다(엔진이 단계 수를 알려 주지 않고 타자는 한 단계로 묶이므로).
 */
export type QueuedStep = "available" | "none" | "unknown";

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
   * 보내는 중·보낼 연산을 엔진 기록(history)에 차례로 적용한 예상(T010 안정화 P2-A, 마무리 안정화에서 단계를 소비하도록 고침). 대기
   * 연산이 없으면 null. 앱이 따로 가진 기록이 아니라 엔진 보기의 기록에서 알 수 있는 것만 센다(DocxEditorSession.queuedHistory).
   */
  queuedHistory: { undo: QueuedStep; redo: QueuedStep } | null;
  /** 저장 사전 검사·저장 중. */
  saving: boolean;
  /** 엔진의 실행 취소 기록. 엔진에 기록이 없으면 null. */
  history: { undo: boolean; redo: boolean } | null;
  /** 기록을 쓸 수 있는 엔진인데 이 문서에서는 한도(기록 메모리 예산 등)로 껐다(history는 null, 이유 limit — T010 Phase 2 rhwp). */
  historyLimited?: boolean;
  /** 선택(없으면 다음 입력)의 글자 서식. 엔진이 알려 주지 않으면 null. */
  format: Readonly<Record<CharFormatFlag, boolean>> | null;
  /** 문서 보호가 직접 글자 서식을 허용하는지(엔진이 알려 주면). null이면 서식 상태가 없는 엔진. */
  formatAccess: DocxFormatAccess | null;
  /**
   * 값 입력 명령(T012·T013)의 문맥. 명령 ID마다 그 명령을 지금 실행할 수 있을 때만 값이 있다(세션이 엔진·선택으로 판정 — 없으면
   * 그 명령은 막힘). 판정 이유가 있으면 `parameterReasons`에 둔다.
   */
  parameters?: Partial<Record<ParameterCommandId, CommandParameterContext>>;
  /** 값 입력 명령을 지금 할 수 없는 이유(세션이 아는 것, 예: 선택 없음·표 밖). */
  parameterReasons?: Partial<Record<ParameterCommandId, "selectionRequired" | "notInTable" | "caretRequired" | "engineUnsupported" | "pendingEdits">>;
  /**
   * 값 없이 실행하는 문맥 명령(T013 목차 넣기·갱신 등)을 지금 할 수 있는지. 세션이 엔진 보기로 판정한다. 없으면 `actionReasons`의
   * 이유 또는 engineUnsupported.
   */
  actions?: Partial<Record<ActionCommandId, { pressed?: boolean }>>;
  actionReasons?: Partial<Record<ActionCommandId, "caretRequired" | "tocRequired" | "revisionsRequired" | "pendingEdits">>;
}

/** 값 입력 없이 세션 문맥으로만 가용성이 정해지는 문서 명령. */
export type ActionCommandId = "references.toc" | "references.updateToc"
  | "review.trackChanges" | "review.acceptChange" | "review.rejectChange" | "review.acceptAll" | "review.rejectAll";

/**
 * 사용자 값이 필요한 문서 명령(T012·T013)의 값. 명령마다 정해진 모양 하나이며 화면(입력 창)과 세션이 같은 검증
 * (`validateCommandArgs`, src/commands/parameters.ts)을 거친다. 전역 대기 인자 없이 실행 요청에 함께 넘긴다.
 */
export type DocumentCommandArgs =
  /** 장평(%) — rhwp 글자 모양 `ratios`(7개 언어 모두 같은 값). */
  | { command: "hangul.charWidth"; percent: number }
  /** 자간(%) — rhwp 글자 모양 `spacings`(7개 언어 모두 같은 값). */
  | { command: "hangul.charSpacing"; percent: number }
  /** 표 계산식(읽기 전용 계산, 셀에 쓰지 않음). */
  | { command: "hangul.tableFormula"; formula: string }
  /** 새 메모 글(T013, WordCraft `review.newComment`). 한 줄, 비어 있지 않음. */
  | { command: "review.comment"; text: string }
  /** 새 각주·미주 글(T013, WordCraft `references.footnote`·`references.endnote`). 한 줄, 비어 있지 않음. */
  | { command: "references.footnote"; text: string }
  | { command: "references.endnote"; text: string };

/** 값이 필요한 문서 명령. */
export type ParameterCommandId = DocumentCommandArgs["command"];

/**
 * 값 입력 명령의 지금 문맥(세션이 엔진에서 읽은 값). 입력 창의 처음 값·검증 범위에 쓴다. 엔진이 알려 주지 않으면 없다.
 */
export interface CommandParameterContext {
  /** 선택 첫 글자의 장평·자간(한글 언어 값, %). */
  charShape?: { width: number; spacing: number };
  /** 커서가 있는 표 셀(0부터)과 표 크기. */
  tableCell?: { row: number; col: number; rows: number; cols: number };
}

/**
 * 명령을 받은 결과. accepted면 세션의 편집 경로에 넣었다(완료·실패는 세션이 처리하고 보인다). `message`가 있으면 실행 경계가
 * 상태 표시줄에 알린다(예: 읽기 전용 계산 결과).
 */
export type CommandDispatch = { accepted: true; message?: Message } | { accepted: false; message?: Message };

export interface DocumentCommandTarget {
  readonly sessionId: SessionId;
  readonly engine: EngineId;
  snapshot(): DocumentCommandSnapshot;
  /**
   * 명령을 이 세션에 실행한다. 레지스트리가 가용성을 확인한 뒤 부르지만, 세션은 자기 상태로 다시 확인하고 맞지 않으면
   * 아무것도 바꾸지 않고 거절한다(accepted: false).
   */
  execute(command: DocumentCommandId, args?: DocumentCommandArgs): CommandDispatch;
}
