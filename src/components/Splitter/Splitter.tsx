import { useRef, type KeyboardEvent, type PointerEvent } from "react";

interface SplitterProps {
  label: string;
  controls: string;
  /** 패널이 편집 영역의 어느 쪽에 있는지. 오른쪽 패널은 핸들을 왼쪽으로 끌수록 넓어진다. */
  side: "left" | "right";
  value: number;
  min: number;
  max: number;
  initial: number;
  onResize: (width: number) => void;
}

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

/** 키보드(화살표, Shift+화살표, Home/End)와 포인터 드래그로 패널 너비를 조절하는 구분선. */
export function Splitter({ label, controls, side, value, min, max, initial, onResize }: SplitterProps) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const sign = side === "left" ? 1 : -1;
  const clamp = (width: number) => Math.min(max, Math.max(min, width));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let width: number | null = null;
    if (event.key === "ArrowRight") width = value + sign * step;
    else if (event.key === "ArrowLeft") width = value - sign * step;
    else if (event.key === "Home") width = min;
    else if (event.key === "End") width = max;
    else if (event.key === "Enter") width = initial;
    if (width === null) return;
    event.preventDefault();
    onResize(clamp(width));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width: value };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onResize(clamp(drag.current.width + sign * (event.clientX - drag.current.x)));
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drag.current = null;
  };

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={label}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onResize(clamp(initial))}
    />
  );
}
