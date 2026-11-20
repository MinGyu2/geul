import { useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "../../language/LanguageContext";
import type { EditableGroupChildren, GroupChildGeometry, ObjectEdit } from "../../commands/objectSelection";

interface Props {
  group: EditableGroupChildren;
  owner: string;
  width: number;
  height: number;
  onEdit: (edit: ObjectEdit) => void;
}

type ChildHandle = "e" | "se" | "s";

type DragState =
  | { kind: "move"; owner: string; pointer: number; child: GroupChildGeometry; clientX: number; clientY: number }
  | { kind: "resize"; owner: string; pointer: number; child: GroupChildGeometry; handle: ChildHandle; clientX: number; clientY: number };

type PreviewState = { owner: string; index: number; x: number; y: number; width: number; height: number };

const CHILD_HANDLES: readonly ChildHandle[] = ["e", "se", "s"];
const intInput = (raw: string) => /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;

export function GroupChildEditor({ group, owner, width, height, onEdit }: Props) {
  const { t } = useTranslation();
  const initialIndex = group.children.find(c => c.canMove || c.canResize)?.index ?? 0;
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const [draft, setDraft] = useState<{ owner: string; index: number; x: string; y: string; width: string; height: string }>();
  const [preview, setPreview] = useState<PreviewState>();
  const drag = useRef<DragState | null>(null);

  const selected = group.children.find(c => c.index === selectedIndex) ?? group.children[0]!;
  const index = selected.index;
  const currentDraft = draft?.owner === owner && draft.index === index ? draft : undefined;
  const rawX = currentDraft?.x ?? String(selected.x);
  const rawY = currentDraft?.y ?? String(selected.y);
  const rawW = currentDraft?.width ?? String(selected.width);
  const rawH = currentDraft?.height ?? String(selected.height);

  const nextX = intInput(rawX);
  const nextY = intInput(rawY);
  const nextW = intInput(rawW);
  const nextH = intInput(rawH);

  const moveValid = selected.canMove
    && Number.isSafeInteger(nextX) && nextX >= 0 && nextX + selected.width <= group.width
    && Number.isSafeInteger(nextY) && nextY >= 0 && nextY + selected.height <= group.height
    && (nextX !== selected.x || nextY !== selected.y);
  const resizeValid = selected.canResize
    && Number.isSafeInteger(nextW) && nextW >= 1 && selected.x + nextW <= group.width
    && Number.isSafeInteger(nextH) && nextH >= 1 && selected.y + nextH <= group.height
    && (nextW !== selected.width || nextH !== selected.height);

  function computeTarget(event: PointerEvent<HTMLElement>, state: DragState): PreviewState {
    const dx = Math.round((event.clientX - state.clientX) * group.width / width);
    const dy = Math.round((event.clientY - state.clientY) * group.height / height);
    if (state.kind === "move") {
      const maxX = group.width - state.child.width;
      const maxY = group.height - state.child.height;
      return {
        owner,
        index: state.child.index,
        x: Math.min(maxX, Math.max(0, state.child.x + dx)),
        y: Math.min(maxY, Math.max(0, state.child.y + dy)),
        width: state.child.width,
        height: state.child.height,
      };
    }
    const maxW = group.width - state.child.x;
    const maxH = group.height - state.child.y;
    const w = state.handle === "s" ? state.child.width : Math.min(maxW, Math.max(1, state.child.width + dx));
    const h = state.handle === "e" ? state.child.height : Math.min(maxH, Math.max(1, state.child.height + dy));
    return { owner, index: state.child.index, x: state.child.x, y: state.child.y, width: w, height: h };
  }

  function beginCapture(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* capture is best effort */ }
  }

  function startMove(event: PointerEvent<HTMLButtonElement>, child: GroupChildGeometry) {
    if (drag.current || event.button !== 0 || width <= 0 || height <= 0) return;
    event.stopPropagation();
    setSelectedIndex(child.index);
    setDraft(undefined);
    if (!child.canMove) return;
    drag.current = { kind: "move", owner, pointer: event.pointerId, child, clientX: event.clientX, clientY: event.clientY };
    beginCapture(event);
  }

  function startResize(event: PointerEvent<HTMLButtonElement>, handle: ChildHandle) {
    if (drag.current || event.button !== 0 || width <= 0 || height <= 0 || !selected.canResize) return;
    setDraft(undefined);
    drag.current = { kind: "resize", owner, pointer: event.pointerId, child: selected, handle, clientX: event.clientX, clientY: event.clientY };
    beginCapture(event);
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>, commit: boolean) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    setPreview(undefined);
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }
    } catch { /* release is best effort */ }
    if (!commit || current.owner !== owner) return;
    if (Math.hypot(event.clientX - current.clientX, event.clientY - current.clientY) < 3) return;
    const next = computeTarget(event, current);
    if (current.kind === "move") {
      if (next.x === current.child.x && next.y === current.child.y) return;
      onEdit({
        kind: "groupChildMove",
        index: current.child.index,
        id: current.child.id,
        instId: current.child.instId,
        x: next.x,
        y: next.y,
      });
    } else {
      if (next.width === current.child.width && next.height === current.child.height) return;
      onEdit({
        kind: "groupChildResize",
        index: current.child.index,
        id: current.child.id,
        instId: current.child.instId,
        width: next.width,
        height: next.height,
      });
    }
  }

  function updateDraft(patch: Partial<{ x: string; y: string; width: string; height: string }>) {
    setDraft({
      owner,
      index,
      x: patch.x ?? rawX,
      y: patch.y ?? rawY,
      width: patch.width ?? rawW,
      height: patch.height ?? rawH,
    });
  }

  return <>
    {group.children.map(child => {
      const shown = preview?.owner === owner && preview.index === child.index ? preview : child;
      const isSelected = child.index === index;
      return <button
        type="button"
        key={`${child.id}:${child.instId}`}
        className="object-group-child"
        data-kind={child.kind}
        data-index={child.index}
        aria-label={t(`properties.group.child.${child.kind}`, { index: child.index + 1 })}
        aria-pressed={isSelected}
        style={{
          left: `${shown.x / group.width * 100}%`,
          top: `${shown.y / group.height * 100}%`,
          width: `${shown.width / group.width * 100}%`,
          height: `${shown.height / group.height * 100}%`,
        }}
        onFocus={() => { setSelectedIndex(child.index); setDraft(undefined); }}
        onClick={event => { event.stopPropagation(); setSelectedIndex(child.index); setDraft(undefined); }}
        onMouseDown={event => event.stopPropagation()}
        onPointerDown={event => startMove(event, child)}
        onPointerMove={event => {
          const current = drag.current;
          if (current?.kind === "move" && current.owner === owner && current.pointer === event.pointerId) {
            setPreview(computeTarget(event, current));
          }
        }}
        onPointerUp={event => finishDrag(event, true)}
        onPointerCancel={event => finishDrag(event, false)}
        onLostPointerCapture={event => finishDrag(event, false)}
      />;
    })}
    {selected.canResize && (() => {
      const box = preview?.owner === owner && preview.index === index ? preview : selected;
      return <div
        className="object-group-child-frame"
        style={{
          left: `${box.x / group.width * 100}%`,
          top: `${box.y / group.height * 100}%`,
          width: `${box.width / group.width * 100}%`,
          height: `${box.height / group.height * 100}%`,
        }}
      >
        {CHILD_HANDLES.map(handle => <button
          type="button"
          key={handle}
          className={`object-handle handle-${handle} object-group-child-handle`}
          data-handle={handle}
          aria-label={t(`editor.object.groupChild.resize.${handle}`)}
          onMouseDown={event => event.stopPropagation()}
          onPointerDown={event => startResize(event, handle)}
          onPointerMove={event => {
            const current = drag.current;
            if (current?.kind === "resize" && current.owner === owner && current.pointer === event.pointerId) {
              setPreview(computeTarget(event, current));
            }
          }}
          onPointerUp={event => finishDrag(event, true)}
          onPointerCancel={event => finishDrag(event, false)}
          onLostPointerCapture={event => finishDrag(event, false)}
        />)}
      </div>;
    })()}
    <form
      className="object-group-child-coordinates"
      onMouseDown={event => event.stopPropagation()}
      onSubmit={event => {
        event.preventDefault();
        if (moveValid) {
          onEdit({ kind: "groupChildMove", index, id: selected.id, instId: selected.instId, x: nextX, y: nextY });
        } else if (resizeValid) {
          onEdit({ kind: "groupChildResize", index, id: selected.id, instId: selected.instId, width: nextW, height: nextH });
        }
      }}
    >
      <label>{t("editor.object.path.x")}
        <input type="number" value={rawX} min={0} max={group.width - selected.width} step={1} disabled={!selected.canMove}
          onChange={event => updateDraft({ x: event.target.value })} />
      </label>
      <label>{t("editor.object.path.y")}
        <input type="number" value={rawY} min={0} max={group.height - selected.height} step={1} disabled={!selected.canMove}
          onChange={event => updateDraft({ y: event.target.value })} />
      </label>
      <button type="button" className="object-group-child-apply-move" disabled={!moveValid}
        onClick={() => { if (moveValid) onEdit({ kind: "groupChildMove", index, id: selected.id, instId: selected.instId, x: nextX, y: nextY }); }}>
        {t("editor.object.groupChild.applyMove")}
      </button>
      <label>{t("editor.object.groupChild.width")}
        <input type="number" value={rawW} min={1} max={group.width - selected.x} step={1} disabled={!selected.canResize}
          onChange={event => updateDraft({ width: event.target.value })} />
      </label>
      <label>{t("editor.object.groupChild.height")}
        <input type="number" value={rawH} min={1} max={group.height - selected.y} step={1} disabled={!selected.canResize}
          onChange={event => updateDraft({ height: event.target.value })} />
      </label>
      <button type="button" className="object-group-child-apply-resize" disabled={!resizeValid}
        onClick={() => { if (resizeValid) onEdit({ kind: "groupChildResize", index, id: selected.id, instId: selected.instId, width: nextW, height: nextH }); }}>
        {t("editor.object.groupChild.applyResize")}
      </button>
    </form>
  </>;
}
