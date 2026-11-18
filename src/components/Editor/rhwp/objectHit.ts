import type { ObjectFrame, ObjectKind } from "../../../commands/objectSelection";

interface ControlHit {
  kind: ObjectKind;
  path: readonly number[];
  frame: ObjectFrame;
  plane: number;
  zOrder: number;
  bodyPicture?: readonly [number, number, number];
}

const kinds = new Map<string, ObjectKind>([
  ["image", "picture"], ["shape", "shape"], ["line", "shape"], ["group", "group"],
  ["ole", "embedded"], ["equation", "equation"],
]);

const index = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function above(a: ControlHit, b: ControlHit): boolean {
  if (a.plane !== b.plane) return a.plane > b.plane;
  if (a.zOrder !== b.zOrder) return a.zOrder > b.zOrder;
  for (let i = 0; i < Math.min(a.path.length, b.path.length); i++) {
    const delta = a.path[i]! - b.path[i]!;
    if (delta !== 0) return delta > 0;
  }
  return a.path.length > b.path.length;
}

function lineContains(control: Record<string, unknown>, x: number, y: number): boolean {
  const { x1, y1, x2, y2 } = control;
  if (!finite(x1) || !finite(y1) || !finite(x2) || !finite(y2)) return false;
  const dx = x2 - x1, dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const at = lengthSquared > 0 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared)) : 0;
  return Math.hypot(x - x1 - at * dx, y - y1 - at * dy) <= 3;
}

/** Resolve visible controls from the same layout tree RHWP uses to paint the canvas. */
export function hitRhwpObject(layout: unknown, page: number, x: number, y: number): ControlHit | null {
  if (!record(layout) || !Array.isArray(layout.controls) || !index(page) || !finite(x) || !finite(y)) return null;
  let top: ControlHit | null = null;
  let ambiguous = false;
  const addresses = new Set<string>();
  const duplicates = new Set<string>();
  for (const control of layout.controls as unknown[]) {
    if (!record(control)) continue;
    const { type, stableIndex: path, plane, zOrder, x: left, y: topEdge, w: width, h: height } = control;
    const kind = typeof type === "string" ? kinds.get(type) : undefined;
    if (!kind || !Array.isArray(path) || path.length === 0 || path.length > 64 || !path.every(index)
      || !index(control.secIdx) || !index(control.paraIdx) || !index(control.controlIdx)) continue;
    const key = path.join(".");
    if (addresses.has(key)) duplicates.add(key);
    addresses.add(key);
    // A background control may share the same area as selectable document text.
    if (control.wrap === "behindText" || control.missing === true) continue;
    if (!finite(left) || !finite(topEdge) || !finite(width) || width < 0 || !finite(height) || height < 0
      || !finite(plane) || !finite(zOrder)) continue;
    const contains = type === "line" ? lineContains(control, x, y)
      : x >= left && x < left + width && y >= topEdge && y < topEdge + height;
    if (!contains) continue;
    const candidate: ControlHit = { kind, path: [...path], plane, zOrder, frame: { page, x: left, y: topEdge, width, height } };
    if (kind === "picture" && path.length === 3 && path[0] === control.secIdx && path[1] === control.paraIdx
      && path[2] === control.controlIdx && !["headerFooter", "noteRef", "cellPath", "cellIdx", "outerTableControlIdx"].some(key => key in control)) {
      candidate.bodyPicture = [control.secIdx, control.paraIdx, control.controlIdx];
    }
    if (!top || above(candidate, top)) {
      top = candidate;
      ambiguous = false;
    } else if (!above(top, candidate)) {
      ambiguous = true;
    }
  }
  return top && !ambiguous && !duplicates.has(top.path.join(".")) ? top : null;
}
