// 문서 명령의 가용성 결정(T010). 레지스트리의 엔진 지원과 편집 세션의 지금 상태(DocumentCommandSnapshot)만으로 정하는 순수
// 함수다. 화면(리본·단축키)과 편집 세션의 실행 직전 재확인이 같은 함수를 쓴다.
//
// 규칙(docs/architecture/command-registry.md):
// - 열린 문서가 없으면 noDocument, 그 엔진이 지원하지 않으면 engineUnsupported(편집 세션에 보내지 않음).
// - 저장은 불러온 세션이면 기존 저장 절차(T009)에 넘긴다. 조합·대기 중 편집·보존 판정은 그 절차가 검사하고 결과를 보인다.
// - 편집 명령은 편집할 수 있고(notReady) 조합 중이 아닐 때(composing)만 한다. 보낼 편집이 있으면 같은 세션 대기열 뒤에 넣는다
//   (엔진이 순서대로 실행). 실행 취소는 엔진 기록에 단계가 있거나 앞선 편집이 아직 대기 중일 때, 다시 실행은 기록에 단계가
//   있을 때만 한다. 엔진이 다시 확인하므로 낡은 보기로 보낸 요청도 바뀌는 것이 없으면 아무것도 바꾸지 않는다.
import { commandDefinition, type DocumentCommandId } from "./registry";
import type { CharFormatFlag, DocumentCommandSnapshot } from "./target";

export type UnavailableReason =
  | "noDocument" | "notImplemented" | "engineUnsupported" | "notReady" | "composing" | "pendingEdits" | "saving"
  | "nothingToUndo" | "nothingToRedo" | "limit";

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
    return snapshot.saving ? unavailable("saving") : ENABLED;
  }
  if (!snapshot.editable) return unavailable("notReady");
  if (snapshot.composing) return unavailable("composing");
  if (id === "edit.undo" || id === "edit.redo") {
    // 지원한다고 선언했는데 엔진이 기록을 알려 주지 않으면 하지 않는다(기록을 화면에서 만들지 않음).
    if (!snapshot.history) return unavailable("engineUnsupported");
    if (id === "edit.undo") return snapshot.history.undo || snapshot.pending ? ENABLED : unavailable("nothingToUndo");
    return snapshot.history.redo ? ENABLED : unavailable("nothingToRedo");
  }
  const flag = FORMAT_FLAG[id];
  if (!flag || !snapshot.format) return unavailable("engineUnsupported");
  return { available: true, pressed: snapshot.format[flag] };
}
