import type { GraphicProperties } from "./graphicProperties";
import type { SessionId } from "../adapters/contract";

export const OBJECT_KINDS = ["picture", "shape", "textBox", "chart", "smartArt", "group", "embedded", "equation"] as const;
export type ObjectKind = typeof OBJECT_KINDS[number];

export interface ObjectFrame {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const PICTURE_WRAPS = ["inline", "square", "tight", "through", "topAndBottom", "behindText", "inFrontOfText"] as const;
export interface PictureProperties {
  widthPt: number;
  heightPt: number;
  wrap: typeof PICTURE_WRAPS[number];
  description?: string;
}

export interface ObjectHit {
  kind: ObjectKind;
  address: { engine: "wordcraft"; position: string } | { engine: "rhwp"; path: readonly number[] };
  frame: ObjectFrame;
  epoch: number;
  picture?: PictureProperties;
  graphic?: GraphicProperties;
}

export interface ObjectSelection extends ObjectHit {
  sessionId: SessionId;
  loadGeneration: number;
  revision: number;
  editable: boolean;
  operations: readonly ObjectOperation[];
}

export type ObjectOperation = "deselect" | "delete" | "move" | "resize" | "copy" | "cut";
export const MUTATING_OBJECT_OPERATIONS = ["move", "resize", "delete"] as const;

/** Stage 3 object mutation. Coordinates are page points (zoom 1) on the selected object's page. */
export type ObjectEdit =
  | { kind: "bounds"; x?: number; y?: number; width?: number; height?: number }
  | { kind: "nudge"; dx: number; dy: number }
  | { kind: "delete" };

export const OBJECT_SIDE_LIMITS = { min: 2, max: 4000 } as const;
export const MAX_NUDGE_PT = 288;

export interface ObjectEditRequest {
  selectionEpoch: number;
  sessionId: SessionId;
  loadGeneration: number;
  revision: number;
  edit: ObjectEdit;
}

export function objectEditOperation(edit: ObjectEdit): "move" | "resize" | "delete" {
  if (edit.kind === "delete") return "delete";
  if (edit.kind === "nudge" || edit.x !== undefined) return "move";
  return "resize";
}

const finite = (value: unknown, limit: number): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;

/** Shape check of an untrusted edit (values only; ownership is checked by the session). */
export function validObjectEdit(edit: unknown): edit is ObjectEdit {
  if (!edit || typeof edit !== "object" || Array.isArray(edit)) return false;
  const value = edit as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  if (value.kind === "delete") return keys === "kind";
  if (value.kind === "nudge") return keys === "dx,dy,kind" && finite(value.dx, MAX_NUDGE_PT) && finite(value.dy, MAX_NUDGE_PT) && (value.dx !== 0 || value.dy !== 0);
  if (value.kind !== "bounds") return false;
  const allowed = ["height", "kind", "width", "x", "y"];
  if (!Object.keys(value).every(key => allowed.includes(key))) return false;
  if (("x" in value) !== ("y" in value)) return false;
  if ("x" in value && !(finite(value.x, 14400) && finite(value.y, 14400))) return false;
  for (const side of ["width", "height"] as const) {
    if (side in value && !(finite(value[side], OBJECT_SIDE_LIMITS.max) && (value[side] as number) >= OBJECT_SIDE_LIMITS.min)) return false;
  }
  return "x" in value || "width" in value || "height" in value;
}

export function objectEditMatches(request: ObjectEditRequest, selection: ObjectSelection): boolean {
  return request.selectionEpoch === selection.epoch && request.sessionId === selection.sessionId
    && request.loadGeneration === selection.loadGeneration && request.revision === selection.revision
    && validObjectEdit(request.edit) && selection.operations.includes(objectEditOperation(request.edit));
}

export interface PictureResizeRequest {
  selectionEpoch: number;
  sessionId: SessionId;
  loadGeneration: number;
  revision: number;
  widthPt: number;
  heightPt: number;
}

export function pictureResizeMatches(request: PictureResizeRequest, selection: ObjectSelection): boolean {
  return request.selectionEpoch === selection.epoch && request.sessionId === selection.sessionId
    && request.loadGeneration === selection.loadGeneration && request.revision === selection.revision;
}

export const BASIC_SHAPES = ["rectangle", "ellipse", "line"] as const;
export type BasicShape = typeof BASIC_SHAPES[number];

/** The `object.edit` request for `selection` (the epoch a drag started on, by default the current one). */
export function objectEditRequest(selection: ObjectSelection, edit: ObjectEdit, epoch = selection.epoch): { command: "object.edit" } & ObjectEditRequest {
  return { command: "object.edit", selectionEpoch: epoch, sessionId: selection.sessionId, loadGeneration: selection.loadGeneration, revision: selection.revision, edit };
}

/** Keyboard access for a selected object: arrows nudge (Shift: 10 pt), Delete/Backspace remove. */
export function objectKeyEdit(key: string, shift: boolean, selection: ObjectSelection | null): ObjectEdit | null {
  if (!selection) return null;
  const step = shift ? 10 : 1;
  const nudge: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  const delta = nudge[key];
  if (delta && selection.operations.includes("move")) return { kind: "nudge", dx: delta[0], dy: delta[1] };
  if ((key === "Delete" || key === "Backspace") && selection.operations.includes("delete")) return { kind: "delete" };
  return null;
}
