import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { OBJECT_SIDE_LIMITS, supportsAnchoredResize, type ObjectEdit, type ObjectFrame, type ObjectSelection } from "../../commands/objectSelection";
import { useTranslation } from "../../language/LanguageContext";
import { ShapePointEditor } from "./ShapePointEditor";
import { DrawingMlPathEditor } from "./DrawingMlPathEditor";
import { GroupChildEditor } from "./GroupChildEditor";

export const RESIZE_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type ResizeHandle = typeof RESIZE_HANDLES[number];

/** Pointer travel (CSS px) below which a press is a click, not a drag. */
const DRAG_THRESHOLD_PX = 3;

type Box = Pick<ObjectFrame, "x" | "y" | "width" | "height">;

/**
 * The frame after dragging `handle` by (dx, dy) page points. Corner handles keep the aspect ratio
 * when `keepAspect` using a single bounded scale factor; sides stay within the object limits and
 * the opposite edge stays put. Non-finite inputs or unsatisfiable aspect limits return `start`.
 */
export function resizeBox(start: Box, handle: ResizeHandle, dx: number, dy: number, keepAspect: boolean): Box {
  const { min, max } = OBJECT_SIDE_LIMITS;
  const clamp = (side: number) => Math.min(max, Math.max(min, side));
  if (![start.x, start.y, start.width, start.height, dx, dy].every(Number.isFinite)
    || start.width <= 0 || start.height <= 0) {
    return { ...start };
  }
  const west = handle.includes("w"), east = handle.includes("e");
  const north = handle.startsWith("n"), south = handle.startsWith("s");
  const rawWidth = start.width + (east ? dx : west ? -dx : 0);
  const rawHeight = start.height + (south ? dy : north ? -dy : 0);
  let width: number;
  let height: number;
  if (keepAspect && (west || east) && (north || south)) {
    const sMin = Math.max(min / start.width, min / start.height);
    const sMax = Math.min(max / start.width, max / start.height);
    if (!Number.isFinite(sMin) || !Number.isFinite(sMax) || sMin > sMax) {
      return { ...start };
    }
    const sx = rawWidth / start.width;
    const sy = rawHeight / start.height;
    const intended = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
    const scale = Math.min(sMax, Math.max(sMin, intended));
    width = clamp(scale * start.width);
    height = clamp(scale * start.height);
  } else {
    width = clamp(rawWidth);
    height = clamp(rawHeight);
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
  const pathOwner = selection.address.engine === "rhwp" && selection.shapePath && selection.operations.includes("pathPoint")
    ? `${selection.sessionId}:${selection.loadGeneration}:${selection.address.path.join(".")}` : null;
  const drawingMlPathOwner = selection.address.engine === "wordcraft" && selection.drawingMlPaths?.length
    && selection.operations.includes("pathPoint")
    ? `${selection.sessionId}:${selection.loadGeneration}:${selection.address.position}` : null;
  const activePathOwner = pathOwner ?? drawingMlPathOwner;
  const groupChildOwner = selection.address.engine === "rhwp" && selection.groupChildren
    && selection.operations.includes("groupChildGeometry")
    ? `${selection.sessionId}:${selection.loadGeneration}:${selection.address.path.join(".")}` : null;
  const [pathMode, setPathMode] = useState<string | null>(null);
  const [groupChildMode, setGroupChildMode] = useState<string | null>(null);
  const editingPath = !!activePathOwner && activePathOwner === pathMode;
  const editingGroupChildren = !!groupChildOwner && groupChildOwner === groupChildMode;
  const editingSubmode = editingPath || editingGroupChildren;
  const canMove = !editingSubmode && Boolean(onEdit) && selection.operations.includes("move");
  const canResize = !editingSubmode && Boolean(onEdit) && selection.operations.includes("resize");
  const resizeHandles = canMove && !supportsAnchoredResize(selection)
    ? RESIZE_HANDLES.filter(handle => !handle.startsWith("n") && !handle.includes("w"))
    : RESIZE_HANDLES;
  const keepAspect = selection.kind === "picture";

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (!drag.current && !editingPath && !editingGroupChildren)) return;
      event.preventDefault();
      event.stopPropagation();
      drag.current = null;
      setPreviewState(null);
      setPathMode(null);
      setGroupChildMode(null);
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [editingPath, editingGroupChildren]);

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
      {activePathOwner && onEdit && <button type="button" className="object-path-mode" aria-pressed={editingPath}
        onMouseDown={event => event.stopPropagation()} onClick={() => setPathMode(editingPath ? null : activePathOwner)}>
        {t(editingPath ? "editor.object.path.done" : "editor.object.path.edit")}
      </button>}
      {groupChildOwner && onEdit && <button type="button" className="object-group-child-mode" aria-pressed={editingGroupChildren}
        onMouseDown={event => event.stopPropagation()} onClick={() => setGroupChildMode(editingGroupChildren ? null : groupChildOwner)}>
        {t(editingGroupChildren ? "editor.object.groupChild.done" : "editor.object.groupChild.edit")}
      </button>}
      {editingPath && selection.shapePath && onEdit &&
        <ShapePointEditor path={selection.shapePath} owner={owner} width={selection.frame.width * scale}
          height={selection.frame.height * scale} editVertices={selection.operations.includes("pathVertex")}
          collinearVertexRemoval={selection.collinearVertexRemoval}
          curveTerminalLine={selection.curveTerminalLine}
          curveLineStructure={selection.curveLineStructure}
          onEdit={edit => onEdit(edit, selection.epoch)} />}
      {editingPath && selection.drawingMlPaths && onEdit &&
        <DrawingMlPathEditor paths={selection.drawingMlPaths} owner={owner} width={selection.frame.width * scale}
          height={selection.frame.height * scale} onEdit={edit => onEdit(edit, selection.epoch)} />}
      {editingGroupChildren && selection.groupChildren && onEdit &&
        <GroupChildEditor group={selection.groupChildren} owner={owner} width={selection.frame.width * scale}
          height={selection.frame.height * scale} onEdit={edit => onEdit(edit, selection.epoch)} />}
      {canMove && (
        <div className="object-selection-frame__body" role="button" aria-label={t("editor.object.move", { kind })}
          data-testid="object-move" onPointerDown={event => start(event, "move")} onPointerMove={move} onPointerUp={end} onPointerCancel={cancel} onLostPointerCapture={cancel} onMouseDown={swallow} />
      )}
      {canResize && resizeHandles.map(handle => (
        <div key={handle} className={`object-selection-frame__handle object-selection-frame__handle--${handle}`}
          role="button" aria-label={t(`editor.object.handle.${handle}`)} data-handle={handle} data-testid={`object-handle-${handle}`}
          onPointerDown={event => start(event, handle)} onPointerMove={move} onPointerUp={end} onPointerCancel={cancel} onLostPointerCapture={cancel} onMouseDown={swallow} />
      ))}
    </div>
  );
}
