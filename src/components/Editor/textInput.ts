// 편집 표면의 숨긴 textarea 이벤트 해석(T007에서 RhwpSurface로부터 옮김, T008 WordCraft 표면과 함께 씀). 동작은 옮기기 전과 같다.
//
// - 조합 이벤트 해석(조합 하나는 끝이 한 번, 클릭·초점 잃음으로 끝낸 조합의 늦은 확정)은 ImeInput(rhwp/imeInput.ts)이 맡는다.
//   여기서는 DOM 이벤트를 넘기고 textarea 값을 다룬다. 엔진별 키(이동·지우기·표 Tab)는 표면이 handleKey로 준다.
// - 조합 중(keyCode 229) 방향키 등은 조합이 끝난 뒤(compositionend) handleKey로 처리한다.
// - 단축키(Ctrl·Meta·Alt)는 명령 레지스트리(T010) 몫이라 처리하지 않는다.
import { keyKind, trace } from "./imeTrace";
import type { ImeInput } from "./rhwp/imeInput";

export interface TextInputHandlers {
  /** 편집 세션이 조합 중인지. */
  composing(): boolean;
  /** 조합이 아닌 키. 처리했으면 true(기본 동작을 막음). */
  handleKey(event: KeyboardEvent): boolean;
  /** 입력 이벤트 시각을 기록한다(입력 반영 시간). */
  mark(event: Event): void;
  /** 리스너를 떼며 조합을 정리한 직후(controller.detach 뒤). */
  detached?(): void;
  /**
   * data 없는 문단 나누기 input(insertParagraph·insertLineBreak)을 앞 beforeinput 없이 와도 "\n" 하나로 넣는다(T008 안정화, DOCX
   * 표면만). 실측 WebKitGTK 2.54: 줄바꿈이 있는 글자 넣기(execCommand insertText)는 beforeinput 하나 뒤에 insertText·insertParagraph
   * input을 줄마다 나눠 보내, 비교할 앞 상태가 없는 insertParagraph가 버려졌다(줄이 합쳐짐). 끄면(rhwp) 동작은 그대로다.
   * 나눌 때 CRLF의 \r은 앞 조각 끝에 글자로 남는다(실측 2차 안정화: "가\r\n나" → insertText "가\r", insertParagraph, insertText "나",
   * 문단 하나가 더 생김). 그 \r은 넣는 쪽(textOps)이 문단 나누기로 바꾸므로, 바로 다음 input으로 온 insertParagraph는 그 줄바꿈의
   * 나머지 반이다(넣지 않음). WebKit은 나눈 input 사이에 microtask를 돌리므로(실측) 시간이 아니라 이벤트 순서로 정한다: 다른 input·
   * 키·조합 시작·초점 잃음이 사이에 오면 잊는다. 빈 줄(LF 둘)은 그대로 둘이다.
   */
  paragraphBreaks?: boolean;
}

/** 문단 나누기 input(textarea에서는 둘 다 줄바꿈). */
const PARAGRAPH_INPUT_TYPES = new Set(["insertParagraph", "insertLineBreak"]);

/** 조합 계열 input: 글자는 data로만 읽는다(값에는 앞서 확정한 글자가 쌓여 있다). */
export const IME_INPUT_TYPES = new Set(["insertCompositionText", "insertFromComposition", "deleteCompositionText"]);
/**
 * 숨긴 textarea 안의 범위를 바꾸는 input(9차). 바꾸는 범위는 textarea의 것인데 textarea는 문서가 아니고 방향키·클릭으로 옮긴
 * 문서 커서도 따르지 않아, 문서의 어느 범위를 바꿀지 정할 수 없다. 커서에 넣으면 원래 글자가 남은 채 덧붙는다(8차까지). 그래서
 * 받지 않는다: 조합 중이 아니면 beforeinput에서 막고, 조합 중이어도 문서·조합에 넣지 않는다.
 */
export const REPLACEMENT_INPUT_TYPES = new Set(["insertReplacementText", "insertTranspose"]);
/**
 * data 없는 넣기에서 새로 들어온 글자: 바뀌기 전 값의 선택 앞(start 전)과 뒤(end 뒤)가 지금 값의 앞뒤에 그대로 있으면 그 사이.
 * 바뀌기 전 상태가 없거나 앞뒤가 맞지 않으면(알 수 없는 편집) ""(넣지 않음). 쌓인 값을 새 글자로 보지 않는다.
 */
function insertedText(before: { value: string; start: number; end: number } | null, value: string): string {
  if (!before) return "";
  const head = before.value.slice(0, before.start);
  const tail = before.value.slice(before.end);
  if (value.length < head.length + tail.length || !value.startsWith(head) || !value.endsWith(tail)) return "";
  return value.slice(head.length, value.length - tail.length);
}
/** 숨긴 textarea에 쌓인 값을 비우는 길이(조합이 없을 때만). */
export const TRIM_LENGTH = 256;
const NAVIGATION_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Enter", "Tab", "Escape"]);

/** textarea에 키보드·IME 리스너를 붙이고, 뗄 함수를 돌려준다. */
export function attachTextInput(input: HTMLTextAreaElement, controller: ImeInput, handlers: TextInputHandlers): () => void {
  const { handleKey, mark } = handlers;
  let pendingNavigation: KeyboardEvent | null = null;
  /** 바로 앞 input이 \r로 끝난 insertText였고 그 뒤 키·조합·초점 변화가 없다(paragraphBreaks). */
  let afterCarriageReturn = false;
  const onKeyDown = (event: KeyboardEvent) => {
    trace("dom:keydown", () => ({ key: keyKind(event), composing: event.isComposing }));
    afterCarriageReturn = false;
    // Ctrl·Meta·Alt를 누른 키(수식 키 자체 포함)는 명령 레지스트리(T010) 몫이고 IME 트랜잭션의 새 입력 경계가 아니다(T010 마무리
    // 안정화 경계 A): 경계로 보면 앱이 먼저 확정한 조합이 입력기의 최종 글자 전에 끝나, 늦게 온 최종 글자가 새 입력으로 한 번 더
    // 들어갔다(재생: Ctrl+B → "하한", Ctrl+Z → "하하"). 끝나지 않은 트랜잭션 동안 명령은 composing으로 거절되고, 트랜잭션은
    // 입력기의 끝·새 조합·글자 입력·수식 키 없는 키로 끝난다.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    controller.keyDown(event.isComposing || event.keyCode === 229);
    trace("ime:keyDown", () => controller.phase());
    if (event.isComposing || event.keyCode === 229) {
      if (NAVIGATION_KEYS.has(event.code) || NAVIGATION_KEYS.has(event.key)) pendingNavigation = event;
      return;
    }
    if (handleKey(event)) event.preventDefault();
  };
  const onCompositionStart = (event: CompositionEvent) => {
    trace("dom:compositionstart");
    afterCarriageReturn = false;
    mark(event);
    controller.compositionStart();
    trace("ime:compositionStart", () => controller.phase());
  };
  // 글자는 이벤트(data)에서 읽는다: 조합 입력의 data는 지금 조합 문자열 전체, 확정·일반 입력은 넣은 글자다(실측
  // WebKitGTK 2.54 + ibus). 초점 있는 textarea의 값을 키마다 비우면 WebKitGTK가 입력기 문맥을 다시 맞추느라 frame마다
  // 수십 ms를 써 실제 IME 입력이 밀렸다(7차). 그래서 값은 쌓아 두고 문서의 근거로 쓰지 않는다:
  // - data가 없는 넣기(붙여넣기 등)는 beforeinput 때의 값·선택(바뀌기 전)과 지금 값을 비교해, 선택 앞뒤로 남은 부분 사이에
  //   새로 들어온 글자만 넣는다(8차: 쌓인 값을 통째로 넣어 앞서 넣은 글자가 다시 들어가던 결함). 비교할 수 없으면 넣지 않는다.
  // - 넣기가 아닌 입력(지우기·되돌리기·서식, 예: Ctrl+Backspace·Ctrl+X·Ctrl+Z)과 textarea 범위 바꾸기(insertReplacementText 등,
  //   9차)는 문서에 아무것도 넣지 않는다. 조합 중이 아니면 beforeinput에서 막아 숨긴 값이 어긋나지 않게 한다(T007 범위 밖의
  //   네이티브 편집, 문서 지우기는 키로 처리).
  // 쌓인 값은 조합이 없을 때 가끔(TRIM_LENGTH) 비운다.
  let snapshot: { value: string; start: number; end: number } | null = null;
  const onBeforeInput = (event: Event) => {
    const { inputType = "", isComposing = false } = event as InputEvent;
    trace("dom:beforeinput", () => ({ inputType, composing: isComposing, length: ((event as InputEvent).data ?? "").length }));
    const composing = handlers.composing() || isComposing;
    if (!composing && (REPLACEMENT_INPUT_TYPES.has(inputType) || (!IME_INPUT_TYPES.has(inputType) && !inputType.startsWith("insert")))) {
      event.preventDefault();
      snapshot = null;
      return;
    }
    snapshot = { value: input.value, start: input.selectionStart, end: input.selectionEnd };
  };
  const onInput = (event: Event) => {
    const { inputType = "", isComposing = false, data = null } = event as InputEvent;
    trace("dom:input", () => ({ inputType, composing: isComposing, length: (data ?? "").length }));
    const before = snapshot;
    snapshot = null;
    const crlf = afterCarriageReturn && inputType === "insertParagraph";
    afterCarriageReturn = false;
    if (REPLACEMENT_INPUT_TYPES.has(inputType)) return; // 막지 못했어도(취소 불가) 문서는 그대로
    mark(event);
    const composing = handlers.composing() || isComposing;
    let text: string;
    if (composing || IME_INPUT_TYPES.has(inputType)) text = data ?? "";
    else if (!inputType.startsWith("insert")) text = "";
    else if (data !== null) text = data;
    else if (handlers.paragraphBreaks && PARAGRAPH_INPUT_TYPES.has(inputType)) text = crlf ? "" : "\n";
    else text = insertedText(before, input.value);
    afterCarriageReturn = !!handlers.paragraphBreaks && !composing && inputType === "insertText" && text.endsWith("\r");
    controller.input(text, inputType, isComposing);
    trace("ime:input", () => controller.phase());
    if (!composing && !handlers.composing() && input.value.length > TRIM_LENGTH) input.value = "";
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    trace("dom:compositionend", () => ({ length: (event.data ?? "").length }));
    mark(event);
    const finalText = event.data ?? "";
    controller.compositionEnd(finalText);
    trace("ime:compositionEnd", () => controller.phase());
    const pending = pendingNavigation;
    pendingNavigation = null;
    if (pending) handleKey(pending);
  };
  input.addEventListener("keydown", onKeyDown);
  input.addEventListener("compositionstart", onCompositionStart);
  input.addEventListener("beforeinput", onBeforeInput);
  input.addEventListener("input", onInput);
  input.addEventListener("compositionend", onCompositionEnd);
  const onBlur = () => {
    trace("dom:blur");
    afterCarriageReturn = false;
    controller.blur();
    trace("ime:blur", () => controller.phase());
    input.value = "";
  };
  input.addEventListener("blur", onBlur);
  return () => {
    input.removeEventListener("blur", onBlur);
    controller.detach();
    trace("ime:detach", () => controller.phase());
    handlers.detached?.();
    input.removeEventListener("keydown", onKeyDown);
    input.removeEventListener("compositionstart", onCompositionStart);
    input.removeEventListener("beforeinput", onBeforeInput);
    input.removeEventListener("input", onInput);
    input.removeEventListener("compositionend", onCompositionEnd);
  };
}
