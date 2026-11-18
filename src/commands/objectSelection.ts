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
export type PictureWrap = typeof PICTURE_WRAPS[number];
export interface PictureProperties {
  widthPt: number;
  heightPt: number;
  wrap: PictureWrap;
  description?: string;
  /** Crop fractions of the original picture, [left, top, right, bottom]. */
  crop?: readonly [number, number, number, number];
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

export const MUTATING_OBJECT_OPERATIONS = ["move", "resize", "delete", "crop", "wrap", "altText"] as const;
export type MutatingObjectOperation = typeof MUTATING_OBJECT_OPERATIONS[number];
export type ObjectOperation = "deselect" | "copy" | "cut" | MutatingObjectOperation;
export const POSITION_PRESETS = ["topLeft", "topCenter", "topRight", "middleLeft", "middleCenter", "middleRight", "bottomLeft", "bottomCenter", "bottomRight"] as const;
export type PositionPreset = typeof POSITION_PRESETS[number];
export const MAX_CROP_FRACTION = 0.45;
export const MAX_ALT_TEXT_CHARS = 1024;

/** Stage 3 object mutation. Coordinates are page points (zoom 1) on the selected object's page. */
export type ObjectEdit =
  | { kind: "bounds"; x?: number; y?: number; width?: number; height?: number }
  | { kind: "nudge"; dx: number; dy: number }
  | { kind: "delete" }
  | { kind: "crop"; left: number; top: number; right: number; bottom: number }
  | { kind: "wrap"; wrap: PictureWrap }
  | { kind: "altText"; text: string }
  | { kind: "position"; preset: PositionPreset };

export const OBJECT_SIDE_LIMITS = { min: 2, max: 4000 } as const;
export const MAX_NUDGE_PT = 288;

export interface ObjectEditRequest {
  selectionEpoch: number;
  sessionId: SessionId;
  loadGeneration: number;
  revision: number;
  edit: ObjectEdit;
}

export function objectEditOperation(edit: ObjectEdit): MutatingObjectOperation {
  switch (edit.kind) {
    case "delete": return "delete";
    case "nudge": case "position": return "move";
    case "crop": return "crop";
    case "wrap": return "wrap";
    case "altText": return "altText";
    case "bounds": return edit.x !== undefined ? "move" : "resize";
  }
}

/** Alt text the engines store verbatim: bounded, no control characters or object placeholders. */
export function validAltText(text: string): boolean {
  const chars = Array.from(text);
  return chars.length <= MAX_ALT_TEXT_CHARS && chars.every(char => {
    const code = char.codePointAt(0)!;
    return code >= 0x20 && !(code >= 0x7f && code <= 0x9f) && code !== 0xfffc;
  });
}

const finite = (value: unknown, limit: number): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;

/** Shape check of an untrusted edit (values only; ownership is checked by the session). */
export function validObjectEdit(edit: unknown): edit is ObjectEdit {
  if (!edit || typeof edit !== "object" || Array.isArray(edit)) return false;
  const value = edit as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  if (value.kind === "delete") return keys === "kind";
  if (value.kind === "crop") return keys === "bottom,kind,left,right,top"
    && (["left", "top", "right", "bottom"] as const).every(side => finite(value[side], MAX_CROP_FRACTION) && (value[side] as number) >= 0);
  if (value.kind === "wrap") return keys === "kind,wrap" && PICTURE_WRAPS.some(wrap => wrap === value.wrap);
  if (value.kind === "position") return keys === "kind,preset" && POSITION_PRESETS.some(preset => preset === value.preset);
  if (value.kind === "altText") return keys === "kind,text" && typeof value.text === "string"
    && validAltText(value.text);
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
