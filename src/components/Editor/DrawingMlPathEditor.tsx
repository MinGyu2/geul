import { useRef, useState, type PointerEvent } from "react";
import type { DrawingMlShapePath, ObjectEdit } from "../../commands/objectSelection";
import { useTranslation } from "../../language/LanguageContext";

interface EditPoint {
  path: number;
  segment: number;
  point: number;
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
  control: boolean;
  command: DrawingMlShapePath["segments"][number]["command"];
}

interface Drag {
  pointer: number;
  owner: string;
  index: number;
  startX: number;
  startY: number;
  point: EditPoint;
}

export function DrawingMlPathEditor({ paths, owner, width, height, editVertices = false, onEdit }: {
  paths: readonly DrawingMlShapePath[];
  owner: string;
  width: number;
  height: number;
  editVertices?: boolean;
  onEdit: (edit: Extract<ObjectEdit, { kind: "docxPathPoint" | "docxPathVertex" }>) => void;
}) {
  const { t } = useTranslation();
  const points: EditPoint[] = paths.flatMap((path, pathIndex) => path.segments.flatMap((segment, segmentIndex) =>
    segment.points.map((point, pointIndex) => ({
      path: pathIndex, segment: segmentIndex, point: pointIndex,
      x: point.x, y: point.y, viewportWidth: path.viewportWidth, viewportHeight: path.viewportHeight,
      control: point.control, command: segment.command,
    }))));
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [draft, setDraft] = useState<{ owner: string; index: number; x: string; y: string }>();
  const [preview, setPreview] = useState<{ owner: string; index: number; x: number; y: number }>();
  const drag = useRef<Drag | null>(null);
  const selected = points[Math.min(selectedIndex, Math.max(0, points.length - 1))];
  const activeDraft = draft?.owner === owner && draft.index === selectedIndex ? draft : null;
  const rawX = activeDraft?.x ?? String(selected?.x ?? "");
  const rawY = activeDraft?.y ?? String(selected?.y ?? "");
  const x = Number(rawX), y = Number(rawY);
  const valid = selected && rawX !== "" && rawY !== "" && Number.isSafeInteger(x) && Number.isSafeInteger(y)
    && x >= 0 && x <= selected.viewportWidth && y >= 0 && y <= selected.viewportHeight
    && (x !== selected.x || y !== selected.y);
  const selectedPath = selected ? paths[selected.path] : undefined;
  const following = selected && selectedPath ? selectedPath.segments[selected.segment + 1] : undefined;
  const insertion = selected && !selected.control && selectedPath && following
    ? insertionPoint(selected, following, selectedPath)
    : null;
  const canRemove = selected && !selected.control && selected.command === "lnTo" && selectedPath
    && canRemoveVertex(selectedPath.segments, selected.segment);

  function target(event: PointerEvent<HTMLButtonElement>, current: Drag) {
    const { point } = current;
    return {
      x: Math.min(point.viewportWidth, Math.max(0, Math.round(point.x + (event.clientX - current.startX) * point.viewportWidth / width))),
      y: Math.min(point.viewportHeight, Math.max(0, Math.round(point.y + (event.clientY - current.startY) * point.viewportHeight / height))),
    };
  }

  function start(event: PointerEvent<HTMLButtonElement>, index: number, point: EditPoint) {
    if (event.button !== 0 || width <= 0 || height <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedIndex(index);
    setDraft(undefined);
    drag.current = { pointer: event.pointerId, owner, index, startX: event.clientX, startY: event.clientY, point };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* capture is best effort */ }
  }

  function finish(event: PointerEvent<HTMLButtonElement>, commit: boolean) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    setPreview(undefined);
    if (!commit || current.owner !== owner || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 3) return;
    onEdit({ kind: "docxPathPoint", path: current.point.path, segment: current.point.segment, point: current.point.point, ...target(event, current) });
  }

  return <>
    {points.map((point, index) => {
      const at = preview?.owner === owner && preview.index === index ? preview : point;
      const label = t(point.control ? "editor.object.docxPath.control" : "editor.object.docxPath.point", {
        path: point.path + 1, segment: point.segment + 1, point: point.point + 1,
      });
      return <button type="button" key={`${point.path}:${point.segment}:${point.point}`} className="object-path-point"
        aria-label={label} aria-pressed={selectedIndex === index} data-control={point.control}
        data-testid={`docx-path-point-${point.path}-${point.segment}-${point.point}`}
        style={{ left: `${at.x / point.viewportWidth * 100}%`, top: `${at.y / point.viewportHeight * 100}%` }}
        onFocus={() => setSelectedIndex(index)} onClick={() => setSelectedIndex(index)}
        onMouseDown={event => event.stopPropagation()} onPointerDown={event => start(event, index, point)}
        onPointerMove={event => {
          const current = drag.current;
          if (current?.owner === owner && current.pointer === event.pointerId) {
            setPreview({ owner, index: current.index, ...target(event, current) });
          }
        }}
        onPointerUp={event => finish(event, true)} onPointerCancel={event => finish(event, false)}
        onLostPointerCapture={event => finish(event, false)} />;
    })}
    {selected && <form className="object-path-coordinates" data-testid="docx-path-coordinates" onMouseDown={event => event.stopPropagation()}
      onSubmit={event => {
        event.preventDefault();
        if (valid) onEdit({ kind: "docxPathPoint", path: selected.path, segment: selected.segment, point: selected.point, x, y });
      }}>
      <label>{t("editor.object.docxPath.x")} <input aria-label={t("editor.object.docxPath.x")} type="number" min={0} max={selected.viewportWidth} step={1}
        value={rawX} onChange={event => setDraft({ owner, index: selectedIndex, x: event.target.value, y: rawY })} /></label>
      <label>{t("editor.object.docxPath.y")} <input aria-label={t("editor.object.docxPath.y")} type="number" min={0} max={selected.viewportHeight} step={1}
        value={rawY} onChange={event => setDraft({ owner, index: selectedIndex, x: rawX, y: event.target.value })} /></label>
      <button type="submit" disabled={!valid}>{t("editor.object.path.apply")}</button>
      {editVertices && <>
        <button type="button" data-testid="docx-path-insert-vertex" disabled={!insertion || !onEdit}
          onClick={() => insertion && onEdit({ kind: "docxPathVertex", path: selected.path, segment: selected.segment + 1, action: "insert", ...insertion })}>
          {t("editor.object.docxPath.insertVertex")}
        </button>
        <button type="button" data-testid="docx-path-remove-vertex" disabled={!canRemove || !onEdit}
          onClick={() => canRemove && onEdit({ kind: "docxPathVertex", path: selected.path, segment: selected.segment, action: "remove" })}>
          {t("editor.object.docxPath.removeVertex")}
        </button>
      </>}
    </form>}
  </>;
}

function insertionPoint(start: EditPoint, following: DrawingMlShapePath["segments"][number], path: DrawingMlShapePath): { x: number; y: number } | null {
  let end: { x: number; y: number } | undefined;
  if (following.command === "lnTo") end = following.points[0];
  else if (following.command === "close") {
    for (let index = start.segment; index >= 0; index--) {
      const moveTo = path.segments[index];
      if (moveTo?.command === "moveTo") { end = moveTo.points[0]; break; }
    }
  } else return null;
  if (!end) return null;
  const dx = end.x - start.x, dy = end.y - start.y;
  const steps = gcd(Math.abs(dx), Math.abs(dy));
  if (steps < 2) return null;
  const step = Math.floor(steps / 2);
  const x = start.x + dx / steps * step, y = start.y + dy / steps * step;
  return x >= 0 && x <= path.viewportWidth && y >= 0 && y <= path.viewportHeight ? { x, y } : null;
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function canRemoveVertex(segments: DrawingMlShapePath["segments"], selected: number): boolean {
  let start = selected;
  while (start >= 0 && segments[start]?.command !== "moveTo") start--;
  if (start < 0) return false;
  let end = selected + 1;
  while (end < segments.length && segments[end]?.command !== "close" && segments[end]?.command !== "moveTo") end++;
  const closed = segments[end]?.command === "close";
  const vertices = segments.slice(start, end).filter(segment => segment.command !== "close").length;
  return vertices > (closed ? 3 : 2);
}
