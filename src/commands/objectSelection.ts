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
}

export interface ObjectSelection extends ObjectHit {
  sessionId: SessionId;
  loadGeneration: number;
  revision: number;
  editable: boolean;
  operations: readonly ("deselect" | "delete" | "move" | "resize")[];
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
