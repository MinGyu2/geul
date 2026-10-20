// 문서 명령의 가용성 결정(T010). 레지스트리의 엔진 지원과 편집 세션의 지금 상태(DocumentCommandSnapshot)만으로 정하는 순수
// 함수다. 화면(리본·단축키)과 편집 세션의 실행 직전 재확인이 같은 함수를 쓴다.
//
// 규칙(docs/architecture/command-registry.md):
// - 열린 문서가 없으면 noDocument, 그 엔진이 지원하지 않으면 engineUnsupported(편집 세션에 보내지 않음).
// - 저장은 불러온 세션이면 기존 저장 절차(T009)에 넘긴다. 끝나지 않은 IME 트랜잭션(composing)이면 그 절차도 거절하므로 같은
//   이유(composing)로 쓸 수 없다고 보인다. 대기 중 편집·보존 판정은 그 절차가 검사하고 결과를 보인다.
// - 확인 창(모달)이 열려 있으면 어떤 명령도 하지 않는다(dialogOpen, T010 안정화 P1-B).
// - 편집 명령은 편집할 수 있고(notReady) IME 트랜잭션이 끝났을 때(composing — 조합 중이거나 앱이 먼저 확정한 조합이 입력기의 최종
//   글자를 기다리는 동안)만 한다. 보낼 편집이 있으면 같은 세션 대기열 뒤에 넣는다(엔진이 순서대로 실행). 실행 취소는 엔진 기록에
//   단계가 있을 때, 다시 실행은 다시 실행 단계가 있을 때 한다. 대기 중인 연산이 있으면 그것을 엔진 기록에 적용한 예상
//   (queuedHistory, 이동·선택·표지는 기록을 바꾸지 않고, 실행 취소·다시 실행은 아는 단계를 쓴다)으로 정한다. 남은 단계를 엔진
//   응답 전에 알 수 없으면(unknown) 응답까지 기다린다(pendingEdits). 엔진이 다시 확인하므로 예상이 어긋나도(엔진이 거부한 넣기 등)
//   바뀌는 것이 없으면 아무것도 바꾸지 않는다.
// - 서식은 문서 보호가 언제나 거부하는 상태(formatAccess "protected")면 protected. 편집 가능 영역만 허용하는 보호("regions")는
//   선택이 영역 안인지 엔진만 판정하므로 보내고, 엔진이 거부하면 세션이 알린다.
import { commandDefinition, type DocumentCommandId } from "./registry";
import type { CharFormatFlag, DocumentCommandSnapshot } from "./target";

export type UnavailableReason =
  | "noDocument" | "notImplemented" | "engineUnsupported" | "notReady" | "composing" | "pendingEdits" | "saving"
  | "nothingToUndo" | "nothingToRedo" | "limit" | "protected" | "dialogOpen";

export type CommandState =
  | { available: true; pressed?: boolean }
  | { available: false; reason: UnavailableReason };

export const ENABLED: CommandState = { available: true };
export const unavailable = (reason: UnavailableReason): CommandState => ({ available: false, reason });

/** 서식 명령이 켜고 끄는 글자 서식. */
export const FORMAT_FLAG: Partial<Record<DocumentCommandId, CharFormatFlag>> = {
  "format.bold": "bold",
  "format.italic": "italic",
  "format.underline": "underline",
  "format.strikethrough": "strikethrough",
};

export function documentCommandState(id: DocumentCommandId, snapshot: DocumentCommandSnapshot | null): CommandState {
  if (!snapshot) return unavailable("noDocument");
  if (commandDefinition(id)?.engines?.[snapshot.engine]?.level !== "supported") return unavailable("engineUnsupported");
  if (id === "file.save") {
    if (!snapshot.loaded) return unavailable("notReady");
    if (snapshot.saving) return unavailable("saving");
    // 끝나지 않은 IME 트랜잭션(조합·provisional·최종 글자 기다림)은 저장 절차도 SaveNotReady{composing}으로 막는다: 가용성도 같게
    // 보여 단축키·리본이 실패할 저장을 시작하지 않는다(T010 IME 경계 후속). 대기 편집·불확실 모델은 그대로 저장 절차가 판정한다.
    return snapshot.composing ? unavailable("composing") : ENABLED;
  }
  if (!snapshot.editable) return unavailable("notReady");
  if (snapshot.composing) return unavailable("composing");
  if (id === "edit.undo" || id === "edit.redo") {
    // 지원한다고 선언했는데 엔진이 기록을 알려 주지 않으면 하지 않는다(기록을 화면에서 만들지 않음).
    if (!snapshot.history) return unavailable("engineUnsupported");
    const direction = id === "edit.undo" ? "undo" : "redo";
    const step = snapshot.queuedHistory?.[direction] ?? (snapshot.history[direction] ? "available" : "none");
    if (step === "available") return ENABLED;
    // 앞선 실행 취소·다시 실행이 남은 단계를 썼는지 엔진 응답 전에는 모른다: 응답까지 기다린다(넘치는 요청을 보내지 않음).
    if (step === "unknown") return unavailable("pendingEdits");
    return unavailable(id === "edit.undo" ? "nothingToUndo" : "nothingToRedo");
  }
  const flag = FORMAT_FLAG[id];
  if (!flag || !snapshot.format) return unavailable("engineUnsupported");
  if (snapshot.formatAccess === "protected") return unavailable("protected");
  return { available: true, pressed: snapshot.format[flag] };
}
