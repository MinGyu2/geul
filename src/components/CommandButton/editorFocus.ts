import type { MouseEvent } from "react";

/**
 * 편집 입력(.rhwp-input, rhwp·WordCraft 표면이 함께 씀)에 초점이 있으면 포인터 누름이 초점을 가져가지 않게 한다(T010 마무리 안정화
 * 경계 C). 입력기는 누름에서 조합을 확정하며 그 확정을 두 반쪽(빈 끝 → 최종 글자)으로 보내는데(실측 WebKitGTK 2.54 + ibus-hangul), 그
 * 사이 초점이 단추로 옮겨 가면 뒤 반쪽이 편집할 수 없는 단추로 가 음절이 사라질 수 있다(가설 H1). 초점이 편집 입력에 남으면 늦은
 * 확정도 편집 입력의 IME 규칙(imeInput.ts)이 받는다.
 *
 * 명령 단추(CommandButton)와 리본의 탭·접기 단추(T011)가 같은 규칙을 쓴다. 클릭 자체(명령 실행·탭 고르기)와 키보드 초점 이동(Tab)·
 * 활성화(Enter·Space)는 바꾸지 않는다. 편집 입력 밖(다른 입력 칸·리본 안)에 초점이 있으면 아무것도 막지 않는다.
 */
export function keepEditorFocusOnPointerDown(event: MouseEvent<HTMLElement>): void {
  if (document.activeElement instanceof HTMLElement && document.activeElement.classList.contains("rhwp-input")) event.preventDefault();
}
