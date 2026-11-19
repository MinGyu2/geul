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

export const HWPX_PORTABLE_SHAPE_TYPES = ["rectangle", "ellipse", "line", "textbox"] as const;
export type HwpxPortableShapeType = typeof HWPX_PORTABLE_SHAPE_TYPES[number];

const HWPX_WRAP_VALUES = ["Square", "Tight", "Through", "TopAndBottom", "BehindText", "InFrontOfText"] as const;
const HWPX_TB_VERTICAL_ALIGNS = ["Top", "Center", "Bottom"] as const;
const HWPX_PARA_ALIGNS = ["left", "center", "right", "justify"] as const;

export interface HwpxPortableParagraph {
  text: string;
  align?: typeof HWPX_PARA_ALIGNS[number];
}

export interface HwpxPortableShape {
  shapeType: HwpxPortableShapeType;
  width: number;
  height: number;
  horzOffset: number;
  vertOffset: number;
  treatAsChar: boolean;
  textWrap: typeof HWPX_WRAP_VALUES[number];
  rotationAngle: number;
  horzFlip: boolean;
  vertFlip: boolean;
  borderColor: number;
  borderWidth: number;
  fillType: "none" | "solid";
  fillBgColor?: number;
  description?: string;
  tbVerticalAlign?: typeof HWPX_TB_VERTICAL_ALIGNS[number];
  tbMargins?: { left: number; right: number; top: number; bottom: number };
  paragraphs?: readonly HwpxPortableParagraph[];
}

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

/**
 * v3 (Stage 3 P4): RHWP HWPX structural copy of one body object (`picture`, `shape`, `textBox`,
 * `group`), bound to the live document identity for lossless same-document structural clone and
 * optionally carrying a portable shape/textBox snapshot for cross-document HWPX paste.
 */
export interface ObjectClipboardPayloadV3 {
  kind: "geul.object";
  version: 3;
  sourceFormat: "hwpx";
  object: RichObjectKind;
  sourceSessionId: number;
  sourceGeneration: number;
  portable?: HwpxPortableShape;
  token: string;
}

export type ObjectClipboardPayload = ObjectClipboardPayloadV1 | ObjectClipboardPayloadV2 | ObjectClipboardPayloadV3;

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

export function createHwpxObjectClipboardPayload(
  object: RichObjectKind,
  sourceSessionId: number,
  sourceGeneration: number,
  portable?: HwpxPortableShape,
): ObjectClipboardPayloadV3 | null {
  if (!intInRange(sourceSessionId, 0, Number.MAX_SAFE_INTEGER) || !intInRange(sourceGeneration, 0, Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  if (portable !== undefined && !validHwpxPortableShape(portable, object)) return null;
  return {
    kind: "geul.object",
    version: 3,
    sourceFormat: "hwpx",
    object,
    sourceSessionId,
    sourceGeneration,
    ...(portable !== undefined ? { portable } : {}),
    token: token(),
  };
}

export function objectClipboardPlainText(payload: ObjectClipboardPayload): string {
  return payload.version === 1 ? `Geul ${payload.object.shape} [${payload.token}]` : `Geul ${payload.object} [${payload.token}]`;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const intInRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

function validHwpxPortableShape(raw: unknown, kind: RichObjectKind): raw is HwpxPortableShape {
  if (!record(raw)) return false;
  const shapeType = HWPX_PORTABLE_SHAPE_TYPES.find(t => t === raw.shapeType);
  if (!shapeType) return false;
  if (kind === "textBox" ? shapeType !== "textbox" : kind !== "shape" || shapeType === "textbox") return false;
  if (!intInRange(raw.width, 1, 2_000_000) || !intInRange(raw.height, 1, 2_000_000)
    || !intInRange(raw.horzOffset, -1_000_000, 2_000_000) || !intInRange(raw.vertOffset, -1_000_000, 2_000_000)
    || typeof raw.treatAsChar !== "boolean"
    || !HWPX_WRAP_VALUES.some(w => w === raw.textWrap)
    || !intInRange(raw.rotationAngle, 0, 359)
    || typeof raw.horzFlip !== "boolean" || typeof raw.vertFlip !== "boolean"
    || !intInRange(raw.borderColor, 0, 0xFFFFFFFF) || !intInRange(raw.borderWidth, 0, 7200)
    || (raw.fillType !== "none" && raw.fillType !== "solid")) return false;
  if (raw.fillType === "solid" ? !intInRange(raw.fillBgColor, 0, 0xFFFFFFFF) : raw.fillBgColor !== undefined) return false;
  if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > 4096)) return false;
  if (raw.tbVerticalAlign !== undefined && !HWPX_TB_VERTICAL_ALIGNS.some(a => a === raw.tbVerticalAlign)) return false;
  if (raw.tbMargins !== undefined) {
    if (!record(raw.tbMargins) || Object.keys(raw.tbMargins).length !== 4
      || !intInRange(raw.tbMargins.left, 0, 100_000) || !intInRange(raw.tbMargins.right, 0, 100_000)
      || !intInRange(raw.tbMargins.top, 0, 100_000) || !intInRange(raw.tbMargins.bottom, 0, 100_000)) return false;
  }
  if (raw.paragraphs !== undefined) {
    if (shapeType !== "textbox" || !Array.isArray(raw.paragraphs) || raw.paragraphs.length < 1 || raw.paragraphs.length > 1024) return false;
    for (const para of raw.paragraphs) {
      if (!record(para) || typeof para.text !== "string" || para.text.length > 65536 || /[\r\n]/.test(para.text)) return false;
      if (para.align !== undefined && !HWPX_PARA_ALIGNS.some(a => a === para.align)) return false;
      const keys = Object.keys(para);
      if (keys.some(k => k !== "text" && k !== "align")) return false;
    }
  }
  const allowedKeys = new Set(["shapeType", "width", "height", "horzOffset", "vertOffset", "treatAsChar", "textWrap",
    "rotationAngle", "horzFlip", "vertFlip", "borderColor", "borderWidth", "fillType", "fillBgColor",
    "description", "tbVerticalAlign", "tbMargins", "paragraphs"]);
  return Object.keys(raw).every(key => allowedKeys.has(key));
}

/** Envelope validation of untrusted clipboard text. v2/v3 content is checked again by the engine/session. */
export function parseObjectClipboardPayload(serialized: string): ObjectClipboardPayload | null {
  if (typeof serialized !== "string" || serialized.length > MAX_OBJECT_CLIPBOARD_BYTES) return null;
  try {
    const raw: unknown = JSON.parse(serialized);
    if (!record(raw) || raw.kind !== "geul.object"
      || typeof raw.token !== "string" || !/^[0-9a-f]{24}$/.test(raw.token)) return null;
    if (raw.version === 3) {
      if (raw.sourceFormat !== "hwpx") return null;
      const object = RICH_OBJECT_KINDS.find(kind => kind === raw.object);
      const allowedKeys = new Set(["kind", "version", "sourceFormat", "object", "sourceSessionId", "sourceGeneration", "portable", "token"]);
      if (!object || Object.keys(raw).some(key => !allowedKeys.has(key))
        || !intInRange(raw.sourceSessionId, 0, Number.MAX_SAFE_INTEGER)
        || !intInRange(raw.sourceGeneration, 0, Number.MAX_SAFE_INTEGER)) return null;
      if (raw.portable !== undefined && !validHwpxPortableShape(raw.portable, object)) return null;
      return {
        kind: "geul.object",
        version: 3,
        sourceFormat: "hwpx",
        object,
        sourceSessionId: raw.sourceSessionId,
        sourceGeneration: raw.sourceGeneration,
        ...(raw.portable !== undefined ? { portable: raw.portable } : {}),
        token: raw.token,
      };
    }
    if (raw.sourceFormat !== "docx") return null;
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
