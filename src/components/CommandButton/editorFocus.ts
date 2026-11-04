import type { MouseEvent } from "react";

/** 누르면 스스로 초점을 받아야 하는 글자 입력 요소(리본 안에 생겨도 초점을 빼앗지 않음). */
const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/**
 * 누름이 스크롤되는 요소 자신의 스크롤바 위인지(mousedown의 대상은 그 스크롤 요소다). 리본의 탭 줄·패널은 `overflow-x: auto`라
 * 좁은 창에서 스크롤바가 생긴다. 스크롤바 누름의 기본 동작을 막으면 WebKit이 스크롤바 끌기를 하지 않을 수 있어 그대로 둔다.
 */
function onOwnScrollbar(event: MouseEvent<HTMLElement>): boolean {
  const element = event.target;
  if (!(element instanceof HTMLElement)) return false;
  const scrollsX = element.scrollWidth > element.clientWidth;
  const scrollsY = element.scrollHeight > element.clientHeight;
  if (!scrollsX && !scrollsY) return false;
  const box = element.getBoundingClientRect();
  const x = event.clientX - box.left - element.clientLeft;
  const y = event.clientY - box.top - element.clientTop;
  return (scrollsY && x >= element.clientWidth) || (scrollsX && y >= element.clientHeight);
}

/**
 * 편집 입력(.rhwp-input, rhwp·WordCraft 표면이 함께 씀)에 초점이 있으면 포인터 누름이 초점을 가져가지 않게 한다(T010 마무리 안정화
 * 경계 C). 입력기는 누름에서 조합을 확정하며 그 확정을 두 반쪽(빈 끝 → 최종 글자)으로 보내는데(실측 WebKitGTK 2.54 + ibus-hangul), 그
 * 사이 초점이 단추로 옮겨 가면 뒤 반쪽이 편집할 수 없는 단추로 가 음절이 사라질 수 있다(가설 H1). 초점이 편집 입력에 남으면 늦은
 * 확정도 편집 입력의 IME 규칙(imeInput.ts)이 받는다.
 *
 * 초점 이동은 mousedown의 기본 동작이므로 mousedown에서 막는다(pointerdown을 막아도 초점은 옮겨 간다). 명령 단추(CommandButton)와
 * 리본 전체(T011: 리본 `<section>`에 위임 — 탭·접기 단추와 그룹 배경·라벨·패널 같은 빈 곳)가 같은 함수를 쓴다. 빈 곳을 누르면 초점이
 * body로 빠져 이어 친 키가 어디에도 가지 않았다(T011 안정화 A, 실측).
 *
 * 막지 않는 것: 편집 입력에 초점이 없을 때(다른 입력 칸·리본 안 등 — 브라우저 기본 그대로), 누른 곳이 글자 입력 요소일 때(그 요소가
 * 초점을 받아야 함), 스크롤바 누름. 클릭 자체(명령 실행·탭 고르기)와 키보드 초점 이동(Tab)·활성화(Enter·Space)는 바꾸지 않는다.
 * 전파는 멈추지 않는다.
 */
export function keepEditorFocusOnPointerDown(event: MouseEvent<HTMLElement>): void {
  if (!(document.activeElement instanceof HTMLElement && document.activeElement.classList.contains("rhwp-input"))) return;
  if (event.target instanceof Element && event.target.closest(EDITABLE)) return;
  if (onOwnScrollbar(event)) return;
  event.preventDefault();
}
