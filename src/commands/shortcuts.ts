// 단축키를 명령 레지스트리로 실행한다(T010). App이 창의 keydown에 붙인다.
//
// - IME를 지킨다: 조합 중 키(isComposing, keyCode 229)는 보지 않는다. 조합이 없을 때만 Ctrl+Z 등을 명령으로 받는다.
// - 문서 범위 단축키(scope "document")는 편집 표면의 숨긴 입력(.rhwp-input, rhwp·WordCraft 표면이 함께 씀)이나 입력 칸 밖에서만
//   받는다. 다른 입력 칸(경로 입력 등)의 Ctrl+Z·Ctrl+B는 그 칸이 처리한다. 전역 단축키(Ctrl+F1)는 어디서나 받는다.
// - 레지스트리에 있는 단축키를 받으면 쓸 수 없는 명령이어도 브라우저 기본 동작(숨긴 textarea의 되돌리기·저장 대화상자 등)을
//   막는다. 쓸 수 없으면 이유만 알린다(executeCommand).
import { executeCommand, type CommandContext } from "./commands";
import { commandForShortcut, eventShortcut } from "./registry";

export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** 문서 범위 단축키를 받을 자리(편집 표면의 입력, 또는 글자 입력 칸 밖). */
export function isDocumentShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest(".rhwp-input")) return true;
  return target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") === null;
}

/** 단축키면 명령을 실행하고 true(기본 동작을 막음), 아니면 false. */
export function handleShortcut(event: KeyboardEvent, context: CommandContext, mac = isMac()): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return false;
  const key = eventShortcut(event, mac);
  const command = key ? commandForShortcut(key) : undefined;
  if (!command) return false;
  if (command.scope !== "global" && !isDocumentShortcutTarget(event.target)) return false;
  event.preventDefault();
  executeCommand(command.id, command.labelKey, context);
  return true;
}
