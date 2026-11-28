import { useRef, useState, type PointerEvent } from "react";
import type { ObjectEdit, ObjectSelection, ShapePath } from "../../commands/objectSelection";
import { useTranslation } from "../../language/LanguageContext";
import type { ShapeProperties } from "../../commands/objectSelection";
import { pathOverlayGeometry, pathPointFromClientDelta } from "./pathEditTransform";

interface PointDrag {
  owner: string;
  pointer: number;
  index: number;
  clientX: number;
  clientY: number;
}

/** An exact lattice point on the edge nearest its midpoint, when one exists. */
function edgeInteriorPoint(a: ShapePath["points"][number], b: ShapePath["points"][number]) {
  const dx = b.x - a.x, dy = b.y - a.y;
  let steps = Math.abs(dx), remainder = Math.abs(dy);
  while (remainder !== 0) [steps, remainder] = [remainder, steps % remainder];
  if (steps < 2) return undefined;
  const step = Math.floor(steps / 2);
  return { x: a.x + dx / steps * step, y: a.y + dy / steps * step };
}

function canJoinEdges(previous: ShapePath["points"][number], selected: ShapePath["points"][number], next: ShapePath["points"][number]) {
  const ax = selected.x - previous.x, ay = selected.y - previous.y;
  const bx = next.x - selected.x, by = next.y - selected.y;
  return ax * by === ay * bx && ax * bx + ay * by > 0;
}

function defaultCubic(path: ShapePath, point: ShapePath["points"][number]) {
  const dx = point.x + 120 <= path.width ? 120 : point.x >= 120 ? -120 : 0;
  const dy = point.y + 40 <= path.height ? 40 : point.y >= 40 ? -40 : 0;
  return {
    c1x: String(point.x + Math.round(dx / 3)), c1y: String(point.y + dy),
    c2x: String(point.x + Math.round(2 * dx / 3)), c2y: String(point.y + dy),
    x: String(point.x + dx), y: String(point.y),
  };
}

function bezierMidpoint(segment: NonNullable<ShapePath["bezierSegments"]>[number]) {
  const x = Math.round((segment.start.x + 3 * segment.control1.x + 3 * segment.control2.x + segment.end.x) / 8);
  const y = Math.round((segment.start.y + 3 * segment.control1.y + 3 * segment.control2.y + segment.end.y) / 8);
  if ((x === segment.start.x && y === segment.start.y) || (x === segment.end.x && y === segment.end.y)) return undefined;
  return { x, y };
}

export function ShapePointEditor({ path, owner, width, height, scale, shape, editVertices, collinearVertexRemoval, curveTerminalLine, curveLineStructure, curveLineSegments, hwpxEditableCurveSegments, curveCubicStructure, onEdit }: {
  path: ShapePath;
  owner: string;
  width: number;
  height: number;
  scale: number;
  shape?: ShapeProperties;
  editVertices: boolean;
  collinearVertexRemoval: ObjectSelection["collinearVertexRemoval"];
  curveTerminalLine: ObjectSelection["curveTerminalLine"];
  curveLineStructure: ObjectSelection["curveLineStructure"];
  curveLineSegments: ObjectSelection["curveLineSegments"];
  hwpxEditableCurveSegments: ObjectSelection["hwpxEditableCurveSegments"];
  curveCubicStructure: ObjectSelection["curveCubicStructure"];
  onEdit: (edit: Extract<ObjectEdit, { kind: "pathPoint" | "pathVertex" | "pathSegment" }>) => void;
}) {
  const { t } = useTranslation();
  const [vertexIndex, setIndex] = useState(0);
  const [draft, setDraft] = useState<{ owner: string; index: number; x: string; y: string }>();
  const [cubicDraft, setCubicDraft] = useState<{ owner: string; index: number; c1x: string; c1y: string; c2x: string; c2y: string; x: string; y: string }>();
  const [preview, setPreview] = useState<{ owner: string; index: number; x: number; y: number }>();
  const drag = useRef<PointDrag | null>(null);
  const points = path.closed ? path.points.slice(0, -1) : path.points;
  const pathTransform = shape ?? { rotation: 0, flipH: false, flipV: false, widthPt: width / scale, heightPt: height / scale };
  const overlay = pathOverlayGeometry(width, height, scale, pathTransform);
  const index = Math.min(vertexIndex, points.length - 1);
  const selected = points[index]!;
  const hasNext = path.closed || index < points.length - 1;
  const curveMidpoint = path.kind === "curve" ? path.bezierSegments?.[index] && bezierMidpoint(path.bezierSegments[index]!) : undefined;
  const segmentNext = points[index + 1] ?? (path.closed ? points[0] : undefined);
  const ordinaryCurveMidpoint = hwpxEditableCurveSegments?.includes(index) && segmentNext
    ? { x: Math.round((selected.x + segmentNext.x) / 2), y: Math.round((selected.y + segmentNext.y) / 2) }
    : undefined;
  const ordinaryCurveMidpointValid = ordinaryCurveMidpoint
    && (ordinaryCurveMidpoint.x !== selected.x || ordinaryCurveMidpoint.y !== selected.y)
    && (ordinaryCurveMidpoint.x !== segmentNext?.x || ordinaryCurveMidpoint.y !== segmentNext?.y)
    && !points.some(point => point.x === ordinaryCurveMidpoint.x && point.y === ordinaryCurveMidpoint.y)
    ? ordinaryCurveMidpoint : undefined;
  const newVertexCandidate = editVertices && points.length < 256 && hasNext
    ? curveMidpoint ?? ordinaryCurveMidpointValid
      ?? (path.kind === "polygon" ? edgeInteriorPoint(selected, points[(index + 1) % points.length]!) : undefined)
    : undefined;
  const newVertex = newVertexCandidate
    && !points.some(point => point.x === newVertexCandidate.x && point.y === newVertexCandidate.y)
    ? newVertexCandidate : undefined;
  const previousSegmentIndex = index === 0 && path.closed && path.nativeSegmentTypes
    ? path.nativeSegmentTypes.length - 1 : index - 1;
  const nextSegmentIndex = index;
  const sameTypeAtDeletion = previousSegmentIndex !== undefined && previousSegmentIndex >= 0
    && path.nativeSegmentTypes?.[previousSegmentIndex] !== undefined
    && path.nativeSegmentTypes[previousSegmentIndex] === path.nativeSegmentTypes[nextSegmentIndex];
  const removable = editVertices && (path.kind === "curve"
    ? points.length > 3 && (hwpxEditableCurveSegments?.length
      ? sameTypeAtDeletion && (path.closed || (index > 0 && index < points.length - 1))
      : (path.closed || (index > 0 && index < points.length - 1)))
    : points.length > 3 && (!collinearVertexRemoval
      || canJoinEdges(points[(index + points.length - 1) % points.length]!, selected, points[(index + 1) % points.length]!)));
  const previous = points[index - 1], next = points[index + 1];
  const curveNext = next ?? ((curveLineSegments || hwpxEditableCurveSegments) && path.closed ? points[0] : undefined);
  const hwpxNativeCurve = path.kind === "curve" && path.nativeSegmentTypes !== undefined;
  const lineSplitAllowed = curveLineStructure || curveLineSegments?.includes(index) === true;
  const splitWithinLimit = hwpxNativeCurve ? points.length < 256 : path.points.length < 257;
  const split = lineSplitAllowed && splitWithinLimit && !selected.control && curveNext && !curveNext.control
    ? edgeInteriorPoint(selected, curveNext) : undefined;
  const lineJoinAllowed = curveLineStructure || (curveLineSegments?.includes(index - 1) === true
    && curveLineSegments?.includes(index) === true);
  const joinWithinLimit = !hwpxNativeCurve || points.length > 3;
  const canJoin = lineJoinAllowed && joinWithinLimit && previous && next && !previous.control && !selected.control && !next.control
    && canJoinEdges(previous, selected, next);
  const activeDraft = draft?.owner === owner && draft.index === index ? draft : null;
  const rawX = activeDraft?.x ?? String(selected.x), rawY = activeDraft?.y ?? String(selected.y);
  const x = Number(rawX), y = Number(rawY);
  const valid = rawX !== "" && rawY !== "" && Number.isSafeInteger(x) && Number.isSafeInteger(y)
    && x >= 0 && x <= path.width && y >= 0 && y <= path.height && (x !== selected.x || y !== selected.y);
  const cubicDefaults = defaultCubic(path, selected);
  const activeCubicDraft = cubicDraft?.owner === owner && cubicDraft.index === index ? cubicDraft : null;
  const cubic = {
    c1x: activeCubicDraft?.c1x ?? cubicDefaults.c1x, c1y: activeCubicDraft?.c1y ?? cubicDefaults.c1y,
    c2x: activeCubicDraft?.c2x ?? cubicDefaults.c2x, c2y: activeCubicDraft?.c2y ?? cubicDefaults.c2y,
    x: activeCubicDraft?.x ?? cubicDefaults.x, y: activeCubicDraft?.y ?? cubicDefaults.y,
  };
  const cubicPoint = Object.fromEntries(Object.entries(cubic).map(([key, value]) => [key, Number(value)])) as Record<keyof typeof cubic, number>;
  const cubicValid = Object.values(cubic).every(value => value !== "")
    && Object.values(cubicPoint).every(Number.isSafeInteger)
    && cubicPoint.c1x >= 0 && cubicPoint.c1x <= path.width && cubicPoint.c2x >= 0 && cubicPoint.c2x <= path.width
    && cubicPoint.x >= 0 && cubicPoint.x <= path.width && cubicPoint.c1y >= 0 && cubicPoint.c1y <= path.height
    && cubicPoint.c2y >= 0 && cubicPoint.c2y <= path.height && cubicPoint.y >= 0 && cubicPoint.y <= path.height
    && (cubicPoint.x !== selected.x || cubicPoint.y !== selected.y);
  const removableCubic = curveCubicStructure && selected.control && points[index + 1]?.control === true
    && points[index + 2]?.control === false
    && points.filter(point => point.control).length > 2;

  function target(event: PointerEvent<HTMLButtonElement>, current: PointDrag) {
    const point = points[current.index]!;
    const mapped = pathPointFromClientDelta(point, event.clientX - current.clientX, event.clientY - current.clientY,
      scale, path.width, path.height, pathTransform);
    const x = mapped.x;
    const y = mapped.y;
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
    <div className="object-path-points" style={{ left: overlay.left, top: overlay.top, width: overlay.width,
      height: overlay.height, transform: overlay.transform }}>
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
    </div>
    <form className="object-path-coordinates" onMouseDown={event => event.stopPropagation()}
      onSubmit={event => { event.preventDefault(); if (valid) onEdit({ kind: "pathPoint", index, x, y }); }}>
      <label>{t("editor.object.path.x")} <input type="number" value={rawX} min={0} max={path.width} step={1}
        onChange={event => setDraft({ owner, index, x: event.target.value, y: rawY })} /></label>
      <label>{t("editor.object.path.y")} <input type="number" value={rawY} min={0} max={path.height} step={1}
        onChange={event => setDraft({ owner, index, x: rawX, y: event.target.value })} /></label>
      <button type="submit" disabled={!valid}>{t("editor.object.path.apply")}</button>
      {editVertices && <div className="object-path-vertex-actions">
        <button type="button" className="object-path-add-vertex" disabled={!newVertex}
          onClick={() => { if (newVertex) onEdit({ kind: "pathVertex", action: "insert", index, ...newVertex }); }}>
          {t(hwpxEditableCurveSegments ? "editor.object.path.addHwpxAnchor" : "editor.object.path.addVertex")}
        </button>
        <button type="button" className="object-path-remove-vertex" disabled={!removable}
          onClick={() => onEdit({ kind: "pathVertex", action: "remove", index })}>
          {t(hwpxEditableCurveSegments ? "editor.object.path.removeHwpxAnchor" : "editor.object.path.removeVertex")}
        </button>
      </div>}
      {hwpxEditableCurveSegments?.includes(index) && path.nativeSegmentTypes?.[index] &&
        <div className="object-path-vertex-actions">
          <button type="button" className="object-path-convert-hwpx-segment" data-testid="hwpx-curve-segment-convert"
            onClick={() => onEdit({ kind: "pathSegment", action: "convertHwpxType", index,
              expected: path.nativeSegmentTypes![index]!, to: path.nativeSegmentTypes![index] === "LINE" ? "CURVE" : "LINE" })}>
            {t(path.nativeSegmentTypes[index] === "LINE" ? "editor.object.path.convertToCurve" : "editor.object.path.convertToLine")}
          </button>
        </div>}
      {path.kind === "curve" && path.nativeSegmentTypes &&
        <p className="object-path-capability-note" data-testid="hwpx-curve-capability-note">
          {t("editor.object.path.hwpxCurveLimits")}
        </p>}
      {curveTerminalLine && index === points.length - 1 && <div className="object-path-vertex-actions">
        <button type="button" className="object-path-append-line"
          disabled={!curveTerminalLine.append || !valid || (x === points[0]!.x && y === points[0]!.y)}
          onClick={() => onEdit({ kind: "pathSegment", action: "append", x, y })}>
          {t("editor.object.path.appendLine")}
        </button>
        <button type="button" className="object-path-remove-line" disabled={!curveTerminalLine.remove}
          onClick={() => onEdit({ kind: "pathSegment", action: "remove" })}>
          {t("editor.object.path.removeLine")}
        </button>
      </div>}
      {(split || canJoin) && <div className="object-path-vertex-actions">
        {split && <button type="button" className="object-path-split-line"
          onClick={() => onEdit({ kind: "pathSegment", action: "splitLine", index, ...split })}>
          {t("editor.object.path.splitLine")}
        </button>}
        {canJoin && <button type="button" className="object-path-join-lines"
          onClick={() => onEdit({ kind: "pathSegment", action: "joinLines", index })}>
          {t("editor.object.path.joinLines")}
        </button>}
      </div>}
      {curveCubicStructure && !selected.control && index > 0 && points.length <= 254 && <div className="object-path-vertex-actions object-path-cubic-actions">
        {(["c1x", "c1y", "c2x", "c2y", "x", "y"] as const).map(key =>
          <label key={key}>{t(`editor.object.path.cubic.${key}`)} <input type="number" min={0}
            max={key.endsWith("x") ? path.width : path.height} step={1} value={cubic[key]}
            onChange={event => setCubicDraft({ owner, index, ...cubic, [key]: event.target.value })} /></label>)}
        <button type="button" className="object-path-insert-cubic" data-testid="hwp5-cubic-insert"
          disabled={!cubicValid} onClick={() => cubicValid && onEdit({ kind: "pathSegment", action: "insertCubic", index, ...cubicPoint })}>
          {t("editor.object.path.insertCubic")}
        </button>
      </div>}
      {removableCubic && <div className="object-path-vertex-actions">
        <button type="button" className="object-path-remove-cubic" data-testid="hwp5-cubic-remove"
          onClick={() => onEdit({ kind: "pathSegment", action: "removeCubic", index })}>
          {t("editor.object.path.removeCubic")}
        </button>
      </div>}
    </form>
  </>;
}
