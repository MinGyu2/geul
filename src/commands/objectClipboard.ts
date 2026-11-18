import { BASIC_SHAPES, type BasicShape } from "./objectSelection";

export const OBJECT_CLIPBOARD_MIME = "application/x-geul-object+json";
/** v2 payloads carry media bytes (base64, at most 8 MiB decoded in the engine). */
export const MAX_OBJECT_CLIPBOARD_BYTES = 12 * 1024 * 1024;
const MAX_V1_BYTES = 2048;

interface ClipboardShape {
  kind: "shape";
  shape: BasicShape;
  widthPt: number;
  heightPt: number;
  placement: "inline";
  fill: string | null;
  outline: string;
  outlinePt: number;
}

/** v1 (Stage 3 partial): a standard basic shape rebuilt by the insert command. */
export interface ObjectClipboardPayloadV1 {
  kind: "geul.object";
  version: 1;
  sourceFormat: "docx";
  object: ClipboardShape;
  token: string;
}

export const RICH_OBJECT_KINDS = ["picture", "shape", "textBox", "group"] as const;
export type RichObjectKind = typeof RICH_OBJECT_KINDS[number];

/**
 * v2 (Stage 3 P5): the engine's structural copy of one drawing — a WordCraft fragment with the
 * drawing and its text box story, plus the media it uses (bytes, SHA-256). `engine` is opaque to
 * the frontend and validated in full by the engine before any mutation.
 */
export interface ObjectClipboardPayloadV2 {
  kind: "geul.object";
  version: 2;
  sourceFormat: "docx";
  object: RichObjectKind;
  engine: unknown;
  token: string;
}

export type ObjectClipboardPayload = ObjectClipboardPayloadV1 | ObjectClipboardPayloadV2;

function standardShape(shape: BasicShape): ClipboardShape {
  return {
    kind: "shape", shape, widthPt: 108, heightPt: shape === "line" ? 1 : 72, placement: "inline",
    fill: shape === "line" ? null : "#156082", outline: "#0E405A", outlinePt: 1,
  };
}

const token = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, "0")).join("");

export function createObjectClipboardPayload(shape: BasicShape): ObjectClipboardPayloadV1 {
  return { kind: "geul.object", version: 1, sourceFormat: "docx", object: standardShape(shape), token: token() };
}

/** Wrap the engine's serialized payload (`docx_selection_object`). */
export function createRichObjectClipboardPayload(object: RichObjectKind, engineJson: string): ObjectClipboardPayloadV2 | null {
  if (engineJson.length > MAX_OBJECT_CLIPBOARD_BYTES) return null;
  try {
    const engine: unknown = JSON.parse(engineJson);
    if (!record(engine)) return null;
    return { kind: "geul.object", version: 2, sourceFormat: "docx", object, engine, token: token() };
  } catch {
    return null;
  }
}

export function objectClipboardPlainText(payload: ObjectClipboardPayload): string {
  return payload.version === 1 ? `Geul ${payload.object.shape} [${payload.token}]` : `Geul ${payload.object} [${payload.token}]`;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Envelope validation of untrusted clipboard text. v2 content is checked again by the engine. */
export function parseObjectClipboardPayload(serialized: string): ObjectClipboardPayload | null {
  if (typeof serialized !== "string" || serialized.length > MAX_OBJECT_CLIPBOARD_BYTES) return null;
  try {
    const raw: unknown = JSON.parse(serialized);
    if (!record(raw) || raw.kind !== "geul.object" || raw.sourceFormat !== "docx"
      || typeof raw.token !== "string" || !/^[0-9a-f]{24}$/.test(raw.token)) return null;
    if (raw.version === 2) {
      const object = RICH_OBJECT_KINDS.find(kind => kind === raw.object);
      if (Object.keys(raw).length !== 6 || !object || !record(raw.engine)) return null;
      const engine = raw.engine;
      if (Object.keys(engine).sort().join(",") !== "fragment,media" || !record(engine.fragment) || !Array.isArray(engine.media)
        || engine.media.length > 16) return null;
      return { kind: "geul.object", version: 2, sourceFormat: "docx", object, engine, token: raw.token };
    }
    if (raw.version !== 1 || serialized.length > MAX_V1_BYTES || Object.keys(raw).length !== 5 || !record(raw.object)) return null;
    const object = raw.object;
    const shape = BASIC_SHAPES.find(shape => shape === object.shape);
    if (!shape) return null;
    const expected = standardShape(shape);
    const properties = Object.entries(expected);
    if (Object.keys(object).length !== properties.length || properties.some(([key, value]) => object[key] !== value)) return null;
    return { kind: "geul.object", version: 1, sourceFormat: "docx", object: expected, token: raw.token };
  } catch {
    return null;
  }
}
