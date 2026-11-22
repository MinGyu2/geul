import { useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "../../language/LanguageContext";
import type { EditableGroupChildren, GroupChildGeometry, ObjectEdit } from "../../commands/objectSelection";

interface Props {
  group: EditableGroupChildren;
  owner: string;
  width: number;
  height: number;
  docx?: boolean;
  onEdit: (edit: ObjectEdit) => void;
}

type ChildHandle = "e" | "se" | "s";

type DragState =
  | { kind: "move"; owner: string; pointer: number; child: GroupChildGeometry; clientX: number; clientY: number }
  | { kind: "resize"; owner: string; pointer: number; child: GroupChildGeometry; handle: ChildHandle; clientX: number; clientY: number };

type PreviewState = { owner: string; index: number; x: number; y: number; width: number; height: number };

const CHILD_HANDLES: readonly ChildHandle[] = ["e", "se", "s"];
const intInput = (raw: string) => /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
const pointInput = (raw: string) => /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;

export function GroupChildEditor({ group, owner, width, height, docx = false, onEdit }: Props) {
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

  const parse = docx ? pointInput : intInput;
  const nextX = parse(rawX);
  const nextY = parse(rawY);
  const nextW = parse(rawW);
  const nextH = parse(rawH);
  const validNumber = (n: number) => docx ? Number.isFinite(n) : Number.isSafeInteger(n);
  const rounded = (n: number) => docx ? Math.round(n * 100) / 100 : Math.round(n);

  const moveValid = selected.canMove
    && validNumber(nextX) && nextX >= 0 && nextX + selected.width <= group.width + 0.001
    && validNumber(nextY) && nextY >= 0 && nextY + selected.height <= group.height + 0.001
    && (nextX !== selected.x || nextY !== selected.y);
  const resizeValid = selected.canResize
    && validNumber(nextW) && nextW > 0 && selected.x + nextW <= group.width + 0.001
    && validNumber(nextH) && nextH > 0 && selected.y + nextH <= group.height + 0.001
    && (nextW !== selected.width || nextH !== selected.height);

  function computeTarget(event: PointerEvent<HTMLElement>, state: DragState): PreviewState {
    const dx = rounded((event.clientX - state.clientX) * group.width / width);
    const dy = rounded((event.clientY - state.clientY) * group.height / height);
    if (state.kind === "move") {
      const maxX = group.width - state.child.width;
      const maxY = group.height - state.child.height;
      return {
        owner,
        index: state.child.index,
        x: rounded(Math.min(maxX, Math.max(0, state.child.x + dx))),
        y: rounded(Math.min(maxY, Math.max(0, state.child.y + dy))),
        width: state.child.width,
        height: state.child.height,
      };
    }
    const maxW = group.width - state.child.x;
    const maxH = group.height - state.child.y;
    const w = state.handle === "s" ? state.child.width : rounded(Math.min(maxW, Math.max(docx ? 0.01 : 1, state.child.width + dx)));
    const h = state.handle === "e" ? state.child.height : rounded(Math.min(maxH, Math.max(docx ? 0.01 : 1, state.child.height + dy)));
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
      onEdit(moveEdit(current.child, next.x, next.y));
    } else {
      if (next.width === current.child.width && next.height === current.child.height) return;
      onEdit(resizeEdit(current.child, next.width, next.height));
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

  function moveEdit(child: GroupChildGeometry, x: number, y: number): ObjectEdit {
    return docx
      ? { kind: "docxGroupChildMove", index: child.index, id: child.id, instId: child.instId, x, y }
      : child.path
        ? { kind: "nestedGroupChildMove", index: child.index, id: child.id, instId: child.instId, path: child.path, x, y }
        : { kind: "groupChildMove", index: child.index, id: child.id, instId: child.instId, x, y };
  }

  function resizeEdit(child: GroupChildGeometry, width: number, height: number): ObjectEdit {
    return docx
      ? { kind: "docxGroupChildResize", index: child.index, id: child.id, instId: child.instId, width, height }
      : child.path
        ? { kind: "nestedGroupChildResize", index: child.index, id: child.id, instId: child.instId, path: child.path, width, height }
        : { kind: "groupChildResize", index: child.index, id: child.id, instId: child.instId, width, height };
  }

  return <>
    {group.children.map(child => {
      const shown = preview?.owner === owner && preview.index === child.index ? preview : child;
      const isSelected = child.index === index;
      return <button
        type="button"
        key={child.path ? child.path.map(step => `${step.index}:${step.id}:${step.instId}`).join("/") : `${child.id}:${child.instId}`}
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
          onEdit(moveEdit(selected, nextX, nextY));
        } else if (resizeValid) {
          onEdit(resizeEdit(selected, nextW, nextH));
        }
      }}
    >
      <label>{t(docx ? "editor.object.groupChild.x" : "editor.object.path.x")}
        <input type="number" value={rawX} min={0} max={group.width - selected.width} step={docx ? 0.01 : 1} disabled={!selected.canMove}
          onChange={event => updateDraft({ x: event.target.value })} />
        {docx && <span>{t("editor.object.groupChild.points")}</span>}
      </label>
      <label>{t(docx ? "editor.object.groupChild.y" : "editor.object.path.y")}
        <input type="number" value={rawY} min={0} max={group.height - selected.height} step={docx ? 0.01 : 1} disabled={!selected.canMove}
          onChange={event => updateDraft({ y: event.target.value })} />
        {docx && <span>{t("editor.object.groupChild.points")}</span>}
      </label>
      <button type="button" className="object-group-child-apply-move" disabled={!moveValid}
        onClick={() => { if (moveValid) onEdit(moveEdit(selected, nextX, nextY)); }}>
        {t("editor.object.groupChild.applyMove")}
      </button>
      <label>{t(docx ? "editor.object.groupChild.widthPt" : "editor.object.groupChild.width")}
        <input type="number" value={rawW} min={docx ? 0.01 : 1} max={group.width - selected.x} step={docx ? 0.01 : 1} disabled={!selected.canResize}
          onChange={event => updateDraft({ width: event.target.value })} />
        {docx && <span>{t("editor.object.groupChild.points")}</span>}
      </label>
      <label>{t(docx ? "editor.object.groupChild.heightPt" : "editor.object.groupChild.height")}
        <input type="number" value={rawH} min={docx ? 0.01 : 1} max={group.height - selected.y} step={docx ? 0.01 : 1} disabled={!selected.canResize}
          onChange={event => updateDraft({ height: event.target.value })} />
        {docx && <span>{t("editor.object.groupChild.points")}</span>}
      </label>
      <button type="button" className="object-group-child-apply-resize" disabled={!resizeValid}
        onClick={() => { if (resizeValid) onEdit(resizeEdit(selected, nextW, nextH)); }}>
        {t("editor.object.groupChild.applyResize")}
      </button>
    </form>
  </>;
}
