import type { ObjectFrame, ObjectKind } from "../../../commands/objectSelection";

export interface CellPictureAddress {
  section: number;
  paragraph: number;
  path: string;
  control: number;
}

export interface CellShapeAddress {
  section: number;
  paragraph: number;
  path: string;
  control: number;
}

export interface HeaderFooterPictureAddress {
  section: number;
  kind: "header" | "footer";
  outerParagraph: number;
  outerControl: number;
  innerParagraph: number;
  innerControl: number;
}

/** Exact header/footer owner plus the local object location within that story. */
export interface HeaderFooterShapeAddress {
  section: number;
  kind: "header" | "footer";
  outerParagraph: number;
  outerControl: number;
  innerParagraph: number;
  innerControl: number;
  /** Canonical RHWP table-cell path; omitted for an object directly in the story paragraph. */
  cellPath?: string;
}

interface ControlHit {
  kind: ObjectKind;
  path: readonly number[];
  frame: ObjectFrame;
  plane: number;
  zOrder: number;
  bodyPicture?: readonly [number, number, number];
  headerFooterPicture?: HeaderFooterPictureAddress;
  headerFooterShape?: HeaderFooterShapeAddress;
  cellPicture?: CellPictureAddress;
  cellShape?: CellShapeAddress;
  bodyEmbedded?: readonly [number, number, number];
  bodyShape?: readonly [number, number, number];
  bodyGroup?: readonly [number, number, number];
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
  let topIdentity: string | null = null;
  let ambiguous = false;
  const identities = new Set<string>();
  const duplicates = new Set<string>();
  for (const control of layout.controls as unknown[]) {
    if (!record(control)) continue;
    const { type, stableIndex, plane, zOrder, x: left, y: topEdge, w: width, h: height } = control;
    const kind = typeof type === "string" ? kinds.get(type) : undefined;
    if (!kind || !index(control.secIdx) || !index(control.paraIdx) || !index(control.controlIdx)) continue;
    const body = !["headerFooter", "noteRef", "cellPath", "cellIdx", "outerTableControlIdx"].some(key => key in control);
    const address = [control.secIdx, control.paraIdx, control.controlIdx] as const;
    // RHWP's raw OLE preview nodes can carry the actual control address
    // without a renderer sort path. Only the direct body form is unambiguous.
    const path = Array.isArray(stableIndex) && stableIndex.length === 0 && kind === "embedded" && body
      ? address : stableIndex;
    if (!Array.isArray(path) || path.length === 0 || path.length > 64 || !path.every(index)) continue;
    const story = control.headerFooter;
    // Layout paths are local to a repeated header/footer story. Qualify those
    // identities with their exact owner so the first header image does not
    // alias the first footer image (both can be [section, 0, 0]).
    const identity = record(story) && (story.kind === "header" || story.kind === "footer")
      && index(story.outerParaIdx) && index(story.outerControlIdx)
      ? JSON.stringify(["story", story.kind, control.secIdx, story.outerParaIdx, story.outerControlIdx,
        control.paraIdx, control.controlIdx])
      : JSON.stringify(["path", path]);
    if (identities.has(identity)) duplicates.add(identity);
    identities.add(identity);
    // A background control may share the same area as selectable document text.
    if (control.wrap === "behindText" || control.missing === true) continue;
    if (!finite(left) || !finite(topEdge) || !finite(width) || width < 0 || !finite(height) || height < 0
      || !finite(plane) || !finite(zOrder)) continue;
    const contains = type === "line" ? lineContains(control, x, y)
      : x >= left && x < left + width && y >= topEdge && y < topEdge + height;
    if (!contains) continue;
    const candidate: ControlHit = { kind, path: [...path], plane, zOrder,
      frame: { page, x: left, y: topEdge, width, height } };
    // A record that claims any non-body story owner must never be reinterpreted
    // through a coincident body address, even when that owner is malformed.
    const hasStoryOwner = Object.prototype.hasOwnProperty.call(control, "headerFooter");
    if (body && !hasStoryOwner && path.length === 3 && address.every((index, i) => path[i] === index)) {
      if (kind === "picture") candidate.bodyPicture = address;
      if (kind === "embedded") candidate.bodyEmbedded = address;
      if (kind === "shape") candidate.bodyShape = address;
      if (kind === "group") candidate.bodyGroup = address;
    }
    if (kind === "picture" && record(control.headerFooter)) {
      const owner = control.headerFooter;
      if ((owner.kind === "header" || owner.kind === "footer")
        && index(owner.outerParaIdx) && index(owner.outerControlIdx)) {
        candidate.headerFooterPicture = {
          section: control.secIdx,
          kind: owner.kind,
          outerParagraph: owner.outerParaIdx,
          outerControl: owner.outerControlIdx,
          innerParagraph: control.paraIdx,
          innerControl: control.controlIdx,
        };
      }
    }
    if (kind !== "picture" && record(control.headerFooter)) {
      const owner = control.headerFooter;
      if ((owner.kind === "header" || owner.kind === "footer")
        && index(owner.outerParaIdx) && index(owner.outerControlIdx)) {
        let cellPath: string | undefined;
        let validCellPath = true;
        if (Object.prototype.hasOwnProperty.call(control, "cellPath")) {
          const raw = control.cellPath;
          const entries: { controlIndex: number; cellIndex: number; cellParaIndex: number }[] = [];
          if (!Array.isArray(raw) || raw.length < 1 || raw.length > 64
            || ("parentParaIdx" in control && control.parentParaIdx !== control.paraIdx)) validCellPath = false;
          else {
            for (const entry of raw as unknown[]) {
              if (!record(entry) || !index(entry.controlIndex) || !index(entry.cellIndex) || !index(entry.cellParaIndex)) {
                validCellPath = false;
                break;
              }
              entries.push({ controlIndex: entry.controlIndex, cellIndex: entry.cellIndex, cellParaIndex: entry.cellParaIndex });
            }
            const last = entries.at(-1);
            if (!last || last.controlIndex !== control.outerTableControlIdx || last.cellIndex !== control.cellIdx
              || last.cellParaIndex !== control.cellParaIdx) validCellPath = false;
            const expected = [control.secIdx, control.paraIdx,
              ...entries.flatMap(entry => [entry.controlIndex, entry.cellIndex, entry.cellParaIndex]), control.controlIdx];
            if (path.length !== expected.length || !expected.every((value, i) => path[i] === value)) validCellPath = false;
            if (validCellPath) cellPath = JSON.stringify(entries);
          }
        } else if ("cellIdx" in control || "cellParaIdx" in control || "outerTableControlIdx" in control
          || "parentParaIdx" in control) {
          validCellPath = false;
        }
        if (validCellPath) {
          candidate.headerFooterShape = {
            section: control.secIdx,
            kind: owner.kind,
            outerParagraph: owner.outerParaIdx,
            outerControl: owner.outerControlIdx,
            innerParagraph: control.paraIdx,
            innerControl: control.controlIdx,
            ...(cellPath !== undefined ? { cellPath } : {}),
          };
        }
      }
    }
    // The renderer exposes the model path independently of the sorting key.
    // Admit table-cell picture paths up to the nested table limit (64 levels)
    // and require the explicit cellPath and layout sort path to agree at every segment.
    if (kind === "picture" && !("headerFooter" in control) && !("noteRef" in control)
      && control.parentParaIdx === control.paraIdx && Array.isArray(control.cellPath)
      && control.cellPath.length >= 1 && control.cellPath.length <= 64) {
      const normalized: { controlIndex: number; cellIndex: number; cellParaIndex: number }[] = [];
      let validPath = true;
      for (const entry of control.cellPath as unknown[]) {
        if (!record(entry) || !index(entry.controlIndex) || !index(entry.cellIndex) || !index(entry.cellParaIndex)) {
          validPath = false;
          break;
        }
        normalized.push({
          controlIndex: entry.controlIndex,
          cellIndex: entry.cellIndex,
          cellParaIndex: entry.cellParaIndex,
        });
      }
      if (validPath && normalized.length > 0) {
        const inner = normalized[normalized.length - 1]!;
        if (inner.controlIndex === control.outerTableControlIdx
          && inner.cellIndex === control.cellIdx
          && inner.cellParaIndex === control.cellParaIdx) {
          const expected = [
            control.secIdx,
            control.paraIdx,
            ...normalized.flatMap(e => [e.controlIndex, e.cellIndex, e.cellParaIndex]),
            control.controlIdx,
          ];
          if (path.length === expected.length && expected.every((value, i) => value === path[i])) {
            candidate.cellPicture = {
              section: control.secIdx,
              paragraph: control.paraIdx,
              control: control.controlIdx,
              path: JSON.stringify(normalized),
            };
          }
        }
      }
    }
    if (kind === "shape" && !("headerFooter" in control) && !("noteRef" in control)
      && control.parentParaIdx === control.paraIdx && Array.isArray(control.cellPath)
      && control.cellPath.length >= 1 && control.cellPath.length <= 64) {
      const normalized: { controlIndex: number; cellIndex: number; cellParaIndex: number }[] = [];
      let validPath = true;
      for (const entry of control.cellPath as unknown[]) {
        if (!record(entry) || !index(entry.controlIndex) || !index(entry.cellIndex) || !index(entry.cellParaIndex)) {
          validPath = false;
          break;
        }
        normalized.push({
          controlIndex: entry.controlIndex,
          cellIndex: entry.cellIndex,
          cellParaIndex: entry.cellParaIndex,
        });
      }
      const expected = [
        control.secIdx,
        control.paraIdx,
        ...normalized.flatMap(entry => [entry.controlIndex, entry.cellIndex, entry.cellParaIndex]),
        control.controlIdx,
      ];
      if (validPath && path.length === expected.length && expected.every((value, i) => path[i] === value)) {
        candidate.cellShape = {
          section: control.secIdx,
          paragraph: control.paraIdx,
          control: control.controlIdx,
          path: JSON.stringify(normalized),
        };
      }
    }
    if (!top || above(candidate, top)) {
      top = candidate;
      topIdentity = identity;
      ambiguous = false;
    } else if (!above(top, candidate)) {
      ambiguous = true;
    }
  }
  return top && !ambiguous && topIdentity !== null && !duplicates.has(topIdentity) ? top : null;
}
