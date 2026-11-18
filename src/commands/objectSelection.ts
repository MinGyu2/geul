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

export interface ObjectHit {
  kind: ObjectKind;
  address: { engine: "wordcraft"; position: string } | { engine: "rhwp"; path: readonly number[] };
  frame: ObjectFrame;
  epoch: number;
}

export interface ObjectSelection extends ObjectHit {
  sessionId: SessionId;
  loadGeneration: number;
  revision: number;
  editable: boolean;
  operations: readonly ("deselect" | "delete" | "move" | "resize")[];
}
