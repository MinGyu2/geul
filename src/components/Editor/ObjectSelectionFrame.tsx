import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { OBJECT_SIDE_LIMITS, type ObjectEdit, type ObjectFrame, type ObjectSelection } from "../../commands/objectSelection";
import { useTranslation } from "../../language/LanguageContext";

export const RESIZE_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type ResizeHandle = typeof RESIZE_HANDLES[number];

/** Pointer travel (CSS px) below which a press is a click, not a drag. */
const DRAG_THRESHOLD_PX = 3;

type Box = Pick<ObjectFrame, "x" | "y" | "width" | "height">;

/**
 * The frame after dragging `handle` by (dx, dy) page points. Corner handles keep the aspect ratio
 * when `keepAspect`; sides are clamped to the object limits and the opposite edge stays put.
 */
export function resizeBox(start: Box, handle: ResizeHandle, dx: number, dy: number, keepAspect: boolean): Box {
  const { min, max } = OBJECT_SIDE_LIMITS;
  const clamp = (side: number) => Math.min(max, Math.max(min, side));
  const west = handle.includes("w"), east = handle.includes("e");
  const north = handle.startsWith("n"), south = handle.startsWith("s");
  let width = start.width + (east ? dx : west ? -dx : 0);
  let height = start.height + (south ? dy : north ? -dy : 0);
  width = clamp(width);
  height = clamp(height);
  if (keepAspect && (west || east) && (north || south) && start.width > 0 && start.height > 0) {
    const ratio = start.width / start.height;
    // Follow the axis the pointer moved further along (relative to the size).
    if (Math.abs(width / start.width - 1) >= Math.abs(height / start.height - 1)) height = clamp(width / ratio);
    else width = clamp(height * ratio);
  }
  return {
    width, height,
    x: west ? start.x + start.width - width : start.x,
    y: north ? start.y + start.height - height : start.y,
  };
}

interface Drag {
  owner: string;
  pointer: number;
  epoch: number;
  handle: ResizeHandle | "move";
  startX: number;
  startY: number;
  box: Box;
  moved: boolean;
}

export interface ObjectSelectionFrameProps {
  selection: ObjectSelection;
  /** CSS px per page point. */
  scale: number;
  /** Commit one completed drag (one history step). `epoch` is the selection the drag started on. */
  onEdit?: (edit: ObjectEdit, epoch: number) => void;
}

export function ObjectSelectionFrame({ selection, scale, onEdit }: ObjectSelectionFrameProps) {
  const { t } = useTranslation();
  // The preview belongs to one selection/document/zoom; any change of those abandons it.
  const owner = `${selection.sessionId}:${selection.loadGeneration}:${selection.epoch}:${scale}`;
  const [previewState, setPreviewState] = useState<{ owner: string; box: Box } | null>(null);
  const preview = previewState?.owner === owner ? previewState.box : null;
  const setPreview = (box: Box | null) => setPreviewState(box ? { owner, box } : null);
  const drag = useRef<Drag | null>(null);
  const canMove = Boolean(onEdit) && selection.operations.includes("move");
  const canResize = Boolean(onEdit) && selection.operations.includes("resize");
  const keepAspect = selection.kind === "picture";

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !drag.current) return;
      // Escape ends the drag only; the object stays selected.
      event.preventDefault();
      event.stopPropagation();
      drag.current = null;
      setPreviewState(null);
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, []);

  const start = (event: ReactPointerEvent<HTMLElement>, handle: Drag["handle"]) => {
    if (event.button !== 0) return;
    // The page underneath must not move the caret or start a text selection.
    event.preventDefault();
    event.stopPropagation();
    const { x, y, width, height } = selection.frame;
    drag.current = { owner, pointer: event.pointerId, epoch: selection.epoch, handle, startX: event.clientX, startY: event.clientY, box: { x, y, width, height }, moved: false };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* capture is best effort */ }
  };
  const boxFor = (current: Drag, event: ReactPointerEvent<HTMLElement>): Box => {
    const dx = (event.clientX - current.startX) / scale, dy = (event.clientY - current.startY) / scale;
    if (current.handle === "move") return { ...current.box, x: current.box.x + dx, y: current.box.y + dy };
    return resizeBox(current.box, current.handle, dx, dy, keepAspect !== event.shiftKey);
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    event.stopPropagation();
    if (current.owner !== owner) { drag.current = null; return; }
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_THRESHOLD_PX) return;
    current.moved = true;
    setPreview(boxFor(current, event));
  };
  const end = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    event.stopPropagation();
    drag.current = null;
    setPreview(null);
    if (!current.moved || !onEdit || current.owner !== owner) return;
    const box = boxFor(current, event);
    const round = (v: number) => Math.round(v * 100) / 100;
    if (current.handle === "move") {
      onEdit({ kind: "bounds", x: round(box.x), y: round(box.y) }, current.epoch);
      return;
    }
    const edit: ObjectEdit = { kind: "bounds", width: round(box.width), height: round(box.height) };
    // A west/north handle also moves the top-left corner (only where the object can move).
    if ((box.x !== current.box.x || box.y !== current.box.y) && canMove) Object.assign(edit, { x: round(box.x), y: round(box.y) });
    onEdit(edit, current.epoch);
  };
  const cancel = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    setPreview(null);
  };
  const swallow = (event: React.MouseEvent) => { event.preventDefault(); event.stopPropagation(); };

  const box = preview ?? selection.frame;
  const kind = t(`editor.object.kind.${selection.kind}`);
  const mutable = canMove || canResize || selection.operations.includes("delete");
  const label = mutable ? "editor.object.editable" : selection.editable ? "editor.object.selected" : "editor.object.readOnly";
  return (
    <div className="object-selection-frame" data-object-kind={selection.kind} data-dragging={preview ? "true" : undefined}
      style={{ left: box.x * scale, top: box.y * scale, width: box.width * scale, height: box.height * scale }}>
      <span role="status" className="object-selection-frame__label">{t(label, { kind })}</span>
      {canMove && (
        <div className="object-selection-frame__body" role="button" aria-label={t("editor.object.move", { kind })}
          data-testid="object-move" onPointerDown={event => start(event, "move")} onPointerMove={move} onPointerUp={end} onPointerCancel={cancel} onLostPointerCapture={cancel} onMouseDown={swallow} />
      )}
      {canResize && RESIZE_HANDLES.map(handle => (
        <div key={handle} className={`object-selection-frame__handle object-selection-frame__handle--${handle}`}
          role="button" aria-label={t(`editor.object.handle.${handle}`)} data-handle={handle} data-testid={`object-handle-${handle}`}
          onPointerDown={event => start(event, handle)} onPointerMove={move} onPointerUp={end} onPointerCancel={cancel} onLostPointerCapture={cancel} onMouseDown={swallow} />
      ))}
    </div>
  );
}
