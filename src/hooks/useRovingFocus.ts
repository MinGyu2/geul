import { useCallback, type KeyboardEvent } from "react";

type Orientation = "horizontal" | "vertical";

/**
 * WAI-ARIA 탭 목록·도구 모음의 roving tabindex 키보드 이동.
 * 컨테이너 안에서 `selector`에 맞는 요소 사이를 화살표·Home·End로 이동한다.
 * 반환된 핸들러를 컨테이너의 onKeyDown에 연결하고, 요소의 tabIndex는 호출자가 관리한다.
 */
export function useRovingFocus(selector: string, orientation: Orientation = "horizontal",
                               onMove?: (element: HTMLElement) => void) {
  return useCallback((event: KeyboardEvent<HTMLElement>) => {
    const next = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
    const previous = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
    if (![next, previous, "Home", "End"].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(selector));
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (current < 0 || items.length === 0) return;
    let index: number;
    if (event.key === next) index = (current + 1) % items.length;
    else if (event.key === previous) index = (current - 1 + items.length) % items.length;
    else if (event.key === "Home") index = 0;
    else index = items.length - 1;
    event.preventDefault();
    const target = items[index];
    if (!target) return;
    for (const item of items) item.tabIndex = item === target ? 0 : -1;
    target.focus();
    onMove?.(target);
  }, [selector, orientation, onMove]);
}
