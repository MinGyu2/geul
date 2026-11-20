import { useRef, useState, type PointerEvent } from "react";
import type { ObjectEdit, ShapePath } from "../../commands/objectSelection";
import { useTranslation } from "../../language/LanguageContext";

interface PointDrag {
  owner: string;
  pointer: number;
  index: number;
  clientX: number;
  clientY: number;
}

export function ShapePointEditor({ path, owner, width, height, onEdit }: {
  path: ShapePath;
  owner: string;
  width: number;
  height: number;
  onEdit: (edit: Extract<ObjectEdit, { kind: "pathPoint" }>) => void;
}) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState<{ owner: string; index: number; x: string; y: string }>();
  const [preview, setPreview] = useState<{ owner: string; index: number; x: number; y: number }>();
  const drag = useRef<PointDrag | null>(null);
  const points = path.closed ? path.points.slice(0, -1) : path.points;
  const selected = points[index] ?? points[0]!;
  const activeDraft = draft?.owner === owner && draft.index === index ? draft : null;
  const rawX = activeDraft?.x ?? String(selected.x), rawY = activeDraft?.y ?? String(selected.y);
  const x = Number(rawX), y = Number(rawY);
  const valid = rawX !== "" && rawY !== "" && Number.isSafeInteger(x) && Number.isSafeInteger(y)
    && x >= 0 && x <= path.width && y >= 0 && y <= path.height && (x !== selected.x || y !== selected.y);

  function target(event: PointerEvent<HTMLButtonElement>, current: PointDrag) {
    const point = points[current.index]!;
    const x = Math.round(point.x + (event.clientX - current.clientX) * path.width / width);
    const y = Math.round(point.y + (event.clientY - current.clientY) * path.height / height);
    return { x: Math.min(path.width, Math.max(0, x)), y: Math.min(path.height, Math.max(0, y)) };
  }

  function start(event: PointerEvent<HTMLButtonElement>, index: number) {
    if (event.button !== 0 || width <= 0 || height <= 0) return;
    event.stopPropagation();
    setIndex(index);
    setDraft(undefined);
    drag.current = { owner, pointer: event.pointerId, index, clientX: event.clientX, clientY: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function finish(event: PointerEvent<HTMLButtonElement>, commit: boolean) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    setPreview(undefined);
    if (commit && current.owner === owner && Math.hypot(event.clientX - current.clientX, event.clientY - current.clientY) >= 3) {
      onEdit({ kind: "pathPoint", index: current.index, ...target(event, current) });
    }
  }

  return <>
    {points.map((point, i) => {
      const at = preview?.owner === owner && preview.index === i ? preview : point;
      return <button type="button" key={i} className="object-path-point"
        aria-label={t(point.control ? "editor.object.path.control" : "editor.object.path.vertex", { index: i + 1 })}
        aria-pressed={index === i} data-control={point.control}
        style={{ left: `${at.x / path.width * 100}%`, top: `${at.y / path.height * 100}%` }}
        onFocus={() => setIndex(i)} onClick={() => setIndex(i)}
        onMouseDown={event => event.stopPropagation()} onPointerDown={event => start(event, i)}
        onPointerMove={event => {
          const current = drag.current;
          if (current?.owner === owner && current.pointer === event.pointerId) {
            setPreview({ owner, index: current.index, ...target(event, current) });
          }
        }}
        onPointerUp={event => finish(event, true)} onPointerCancel={event => finish(event, false)}
        onLostPointerCapture={event => finish(event, false)} />;
    })}
    <form className="object-path-coordinates" onMouseDown={event => event.stopPropagation()}
      onSubmit={event => { event.preventDefault(); if (valid) onEdit({ kind: "pathPoint", index, x, y }); }}>
      <label>{t("editor.object.path.x")} <input type="number" value={rawX} min={0} max={path.width} step={1}
        onChange={event => setDraft({ owner, index, x: event.target.value, y: rawY })} /></label>
      <label>{t("editor.object.path.y")} <input type="number" value={rawY} min={0} max={path.height} step={1}
        onChange={event => setDraft({ owner, index, x: rawX, y: event.target.value })} /></label>
      <button type="submit" disabled={!valid}>{t("editor.object.path.apply")}</button>
    </form>
  </>;
}
