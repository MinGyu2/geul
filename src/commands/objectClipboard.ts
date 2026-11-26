import { BASIC_SHAPES, CAPTION_SIDES, CAPTION_VERTICAL_ALIGNS, type BasicShape } from "./objectSelection";
import { fontFamilyProblem } from "./parameters";

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

export const HWPX_PORTABLE_SHAPE_TYPES = ["rectangle", "ellipse", "line", "textbox", "polygon"] as const;
export type HwpxPortableShapeType = typeof HWPX_PORTABLE_SHAPE_TYPES[number];

export const HWPX_PICTURE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/bmp", "image/webp"] as const;
export type HwpxPortablePictureMime = typeof HWPX_PICTURE_MIMES[number];

export const HWPX_WRAP_VALUES = ["Square", "Tight", "Through", "TopAndBottom", "BehindText", "InFrontOfText"] as const;
export const HWPX_TB_VERTICAL_ALIGNS = ["Top", "Center", "Bottom"] as const;
export const HWPX_PARA_ALIGNS = ["left", "center", "right", "justify"] as const;
export const HWPX_CAPTION_DIRECTIONS = CAPTION_SIDES;
export const HWPX_CAPTION_VERT_ALIGNS = CAPTION_VERTICAL_ALIGNS;

export const MAX_HWPX_PICTURE_BYTES = 8 * 1024 * 1024;
/** Isolated HWPX package for one owned group tree; the JSON envelope stays under the 12 MiB clipboard cap. */
export const MAX_HWPX_GROUP_PACKAGE_BYTES = 8 * 1024 * 1024;
/** Standalone HWP5 object fragments fit the same bounded 12 MiB clipboard envelope. */
export const MAX_HWP5_OBJECT_FRAGMENT_BYTES = 8 * 1024 * 1024;

export interface HwpxPortableCharRun {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number;
  textColor?: string;
  shadeColor?: string;
  fontFamily?: string;
}

export interface HwpxPortableParagraph {
  text: string;
  align: typeof HWPX_PARA_ALIGNS[number];
  runs?: readonly HwpxPortableCharRun[];
  autoNumberOffset?: number;
}

export interface HwpxPortableCaption {
  direction: typeof HWPX_CAPTION_DIRECTIONS[number];
  vertAlign: typeof HWPX_CAPTION_VERT_ALIGNS[number];
  width: number;
  spacing: number;
  includeMargin: boolean;
  paragraphs: readonly HwpxPortableParagraph[];
}

export interface HwpxPortableShape {
  kind?: "shape";
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
  lineType: 0 | 1;
  fillType: "none" | "solid";
  fillBgColor?: number;
  description?: string;
  tbVerticalAlign?: typeof HWPX_TB_VERTICAL_ALIGNS[number];
  tbMargins?: { left: number; right: number; top: number; bottom: number };
  paragraphs?: readonly HwpxPortableParagraph[];
  caption?: HwpxPortableCaption;
  polygonPoints?: readonly { x: number; y: number }[];
}

export interface HwpxPortablePicture {
  kind: "picture";
  mime: HwpxPortablePictureMime;
  bytesBase64: string;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  horzOffset: number;
  vertOffset: number;
  treatAsChar: boolean;
  textWrap: typeof HWPX_WRAP_VALUES[number];
  borderColor: number;
  borderWidth: number;
  borderType: number;
  crop: { left: number; top: number; right: number; bottom: number };
  /** Stored imgClip coordinates in the picture's proven image reference space. */
  cropRect: { left: number; top: number; right: number; bottom: number };
  description?: string;
  caption?: HwpxPortableCaption;
}

export interface HwpxPortableGroup {
  kind: "group";
  /** Base64 HWPX package containing one group and only its referenced embedded resources. */
  packageBase64: string;
}

export type HwpxPortableObject = HwpxPortableShape | HwpxPortablePicture | HwpxPortableGroup;

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
 * v3 (Stage 3 P4 / Stage 3-B): RHWP structural copy of one body object (`picture`, `shape`,
 * `textBox`, `group`), bound to the live document identity for lossless same-document structural
 * clone and optionally carrying a portable HWPX snapshot for cross-document HWPX paste.
 */
export interface ObjectClipboardPayloadV3 {
  kind: "geul.object";
  version: 3;
  sourceFormat: "hwpx" | "hwp";
  object: RichObjectKind;
  sourceSessionId: number;
  sourceGeneration: number;
  portable?: HwpxPortableObject;
  /** Bounded standalone HWP5 CFB fragment for cross-document object transfer. */
  hwpFragmentBase64?: string;
  token: string;
}

/**
 * v4 (P6-DX-HX): a DOCX shape copied with its same-format engine fragment and a
 * separately validated HWPX shape snapshot when the source has an exact supported mapping.
 */
export interface ObjectClipboardPayloadV4 {
  kind: "geul.object";
  version: 4;
  sourceFormat: "docx";
  object: "shape";
  engine: unknown;
  portable: HwpxPortableShape;
  token: string;
}

/**
 * v5 (P6-H5-DX): an HWP5 body primitive with a narrowly validated portable
 * snapshot for DOCX insertion. The CFB fragment remains available for the
 * existing same-format HWP5 transfer path.
 */
export interface ObjectClipboardPayloadV5 {
  kind: "geul.object";
  version: 5;
  sourceFormat: "hwp";
  object: "shape";
  sourceSessionId: number;
  sourceGeneration: number;
  portable: HwpxPortableShape;
  hwpFragmentBase64?: string;
  token: string;
}

export type ObjectClipboardPayload = ObjectClipboardPayloadV1 | ObjectClipboardPayloadV2 | ObjectClipboardPayloadV3 | ObjectClipboardPayloadV4 | ObjectClipboardPayloadV5;

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
export function createRichObjectClipboardPayload(
  object: RichObjectKind, engineJson: string,
): ObjectClipboardPayloadV2 | ObjectClipboardPayloadV4 | null {
  if (engineJson.length > MAX_OBJECT_CLIPBOARD_BYTES) return null;
  try {
    const engine: unknown = JSON.parse(engineJson);
    if (!record(engine)) return null;
    if (object === "shape") {
      const portable = docxEngineShapeToHwpx(engine);
      if (portable) {
        const crossFormat: ObjectClipboardPayloadV4 = {
          kind: "geul.object", version: 4, sourceFormat: "docx", object, engine, portable, token: token(),
        };
        if (JSON.stringify(crossFormat).length <= MAX_OBJECT_CLIPBOARD_BYTES) return crossFormat;
      }
    }
    return { kind: "geul.object", version: 2, sourceFormat: "docx", object, engine, token: token() };
  } catch {
    return null;
  }
}

export function createHwpxObjectClipboardPayload(
  object: RichObjectKind,
  sourceSessionId: number,
  sourceGeneration: number,
  portable?: HwpxPortableObject,
): ObjectClipboardPayloadV3 | null {
  if (!intInRange(sourceSessionId, 0, Number.MAX_SAFE_INTEGER) || !intInRange(sourceGeneration, 0, Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  if (portable !== undefined && !validHwpxPortableObject(portable, object)) return null;
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

export function createHwpObjectClipboardPayload(
  object: RichObjectKind,
  sourceSessionId: number,
  sourceGeneration: number,
  hwpFragmentBase64?: string,
): ObjectClipboardPayloadV3 | null {
  if (!intInRange(sourceSessionId, 0, Number.MAX_SAFE_INTEGER) || !intInRange(sourceGeneration, 0, Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  if (hwpFragmentBase64 !== undefined && !validHwp5ObjectFragmentBase64(hwpFragmentBase64)) return null;
  return {
    kind: "geul.object",
    version: 3,
    sourceFormat: "hwp",
    object,
    sourceSessionId,
    sourceGeneration,
    ...(hwpFragmentBase64 !== undefined ? { hwpFragmentBase64 } : {}),
    token: token(),
  };
}

export function createHwp5PortableShapeClipboardPayload(
  sourceSessionId: number,
  sourceGeneration: number,
  portable: HwpxPortableShape,
  hwpFragmentBase64?: string,
): ObjectClipboardPayloadV5 | null {
  if (!intInRange(sourceSessionId, 0, Number.MAX_SAFE_INTEGER)
    || !intInRange(sourceGeneration, 0, Number.MAX_SAFE_INTEGER)
    || !validHwpxPortableObject(portable, "shape")
    || !["rectangle", "ellipse", "line"].includes(portable.shapeType)
    || (hwpFragmentBase64 !== undefined && !validHwp5ObjectFragmentBase64(hwpFragmentBase64))) return null;
  return {
    kind: "geul.object",
    version: 5,
    sourceFormat: "hwp",
    object: "shape",
    sourceSessionId,
    sourceGeneration,
    portable,
    ...(hwpFragmentBase64 !== undefined ? { hwpFragmentBase64 } : {}),
    token: token(),
  };
}

function validHwp5ObjectFragmentBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 684
    || value.length > 4 * Math.ceil(MAX_HWP5_OBJECT_FRAGMENT_BYTES / 3)
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedLength = (value.length / 4) * 3 - padding;
  return decodedLength >= 512 && decodedLength <= MAX_HWP5_OBJECT_FRAGMENT_BYTES;
}

export function encodeHwp5ObjectFragment(bytes: Uint8Array): string | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < 512 || bytes.length > MAX_HWP5_OBJECT_FRAGMENT_BYTES) return null;
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  const encoded = btoa(binary);
  return validHwp5ObjectFragmentBase64(encoded) ? encoded : null;
}

export function decodeHwp5ObjectFragment(base64: string): Uint8Array | null {
  if (!validHwp5ObjectFragmentBase64(base64)) return null;
  try {
    const raw = atob(base64);
    if (raw.length < 512 || raw.length > MAX_HWP5_OBJECT_FRAGMENT_BYTES) return null;
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/** Exact reserved object marker; without its structured payload it is not document text. */
export function isObjectClipboardPlainText(text: string): boolean {
  const match = /^Geul (rectangle|ellipse|line|picture|shape|textBox|group) \[([0-9a-f]{24})\]$/.exec(text);
  return match !== null && match[0] === text;
}

export function objectClipboardPlainText(payload: ObjectClipboardPayload): string {
  return payload.version === 1 ? `Geul ${payload.object.shape} [${payload.token}]` : `Geul ${payload.object} [${payload.token}]`;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const intInRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => {
  const set = new Set(allowed);
  return Object.keys(value).every(key => set.has(key));
};

const emptyRecord = (value: unknown): boolean => value === undefined || (record(value) && Object.keys(value).length === 0);

function pointToHwpUnit(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const units = Math.round(value * 2540 / 72);
  return intInRange(units, min, max) ? units : null;
}

function docxRgbToHwpx(value: unknown): number | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(channel => intInRange(channel, 0, 255))) return null;
  const [red, green, blue] = value as [number, number, number];
  // HWPX shape properties expose COLORREF ordering (red in the low byte).
  return red | (green << 8) | (blue << 16);
}

/**
 * WordCraft folds `wp:effectExtent` and the rotated frame's overhang into
 * `float.effect` when it reads DOCX. HWPX stores rotation on the shape itself,
 * so admit only the exact f32 compensation produced by `Float::spin_pad` for a
 * zero source effect extent. Any additional source extent remains unsupported.
 */
function docxHasRotationOnlyEffectExtent(value: unknown, width: number, height: number, rotation: number): boolean {
  if (!Array.isArray(value) || value.length !== 4
    || !value.every(part => typeof part === "number" && Number.isFinite(part))) return false;
  const f32 = Math.fround;
  const frameWidth = f32(Math.min(Math.max(width, 0), 4000));
  const frameHeight = f32(Math.min(Math.max(height, 0), 4000));
  const radians = f32(f32(rotation) * f32(Math.PI / 180));
  const sin = f32(Math.sin(radians));
  const cos = f32(Math.cos(radians));
  const turnedWidth = f32(f32(frameWidth * Math.abs(cos)) + f32(frameHeight * Math.abs(sin)));
  const turnedHeight = f32(f32(frameWidth * Math.abs(sin)) + f32(frameHeight * Math.abs(cos)));
  const padX = f32(f32(turnedWidth - frameWidth) / 2);
  const padY = f32(f32(turnedHeight - frameHeight) / 2);
  const xCompensation = f32(Math.max(0, -padX));
  const yCompensation = f32(Math.max(0, -padY));
  const expected = [xCompensation, yCompensation, xCompensation, yCompensation];
  return value.every((part, index) => f32(part) === expected[index]);
}

/**
 * Convert only a model-proven DOCX inline primitive with no nonportable envelope.
 * Floating anchors, custom/freeform geometry, actual effects, attached text,
 * and unknown fields have no exact HWPX mapping in this payload contract and are refused.
 */
function docxEngineShapeToHwpx(engine: unknown): HwpxPortableShape | undefined {
  if (!record(engine) || Object.keys(engine).sort().join(",") !== "fragment,media"
    || !Array.isArray(engine.media) || engine.media.length !== 0 || !record(engine.fragment)
    || !hasOnlyKeys(engine.fragment, ["blocks", "parts"])) return undefined;
  const fragment = engine.fragment;
  if (!Array.isArray(fragment.blocks) || fragment.blocks.length !== 1
    || (fragment.parts !== undefined && (!record(fragment.parts) || Object.keys(fragment.parts).length !== 0))) return undefined;

  const block = fragment.blocks[0];
  if (!record(block) || block.kind !== "para"
    || !hasOnlyKeys(block, ["kind", "text", "runs", "props", "mark", "objects", "section"])) return undefined;
  if (block.text !== "\uFFFC" || !Array.isArray(block.objects) || block.objects.length !== 1
    || !Array.isArray(block.runs) || block.runs.length !== 1
    || !record(block.runs[0]) || block.runs[0].len !== 3 || !emptyRecord(block.runs[0].props)
    || !emptyRecord(block.props) || !emptyRecord(block.mark)
    || (block.section !== undefined && block.section !== null)) return undefined;

  const source = block.objects[0];
  const shapeKeys = ["type", "kind", "w", "h", "fill", "stroke", "stroke_width", "float", "story", "freeform", "effects", "extra"];
  if (!record(source) || source.type !== "shape" || !hasOnlyKeys(source, shapeKeys)
    || (source.story !== undefined && source.story !== null)
    || (source.freeform !== undefined && source.freeform !== null)
    || !emptyRecord(source.effects) || !emptyRecord(source.extra) || !record(source.float)) return undefined;

  const shapeType = source.kind;
  if (shapeType !== "rectangle" && shapeType !== "ellipse" && shapeType !== "line") return undefined;
  const width = pointToHwpUnit(source.w, 1, 2_000_000);
  const height = pointToHwpUnit(source.h, 1, 2_000_000);
  if (width === null || height === null) return undefined;

  const float = source.float;
  const floatKeys = ["wrap", "wrapText", "hRel", "vRel", "x", "y", "hAlign", "vAlign", "dist", "distTop", "distBottom",
    "effect", "rot", "flipH", "flipV", "wrapPolygon", "alt", "hidden"];
  if (!hasOnlyKeys(float, floatKeys) || float.wrap !== "inline"
    || (float.wrapText !== undefined && float.wrapText !== "bothSides")
    || (float.hRel !== undefined && float.hRel !== "column") || (float.vRel !== undefined && float.vRel !== "column")
    || (float.x !== undefined && float.x !== 0) || (float.y !== undefined && float.y !== 0)
    || (float.hAlign !== undefined && float.hAlign !== null) || (float.vAlign !== undefined && float.vAlign !== null)
    || (float.dist !== undefined && float.dist !== 0) || (float.distTop !== undefined && float.distTop !== 0)
    || (float.distBottom !== undefined && float.distBottom !== 0)
    || !docxHasRotationOnlyEffectExtent(float.effect, source.w as number, source.h as number, float.rot === undefined ? 0 : float.rot as number)
    || (float.wrapPolygon !== undefined && float.wrapPolygon !== null)
    || (float.hidden !== undefined && float.hidden !== false)) return undefined;
  const rotation = float.rot === undefined ? 0 : float.rot;
  const horzFlip = float.flipH === undefined ? false : float.flipH;
  const vertFlip = float.flipV === undefined ? false : float.flipV;
  if (!intInRange(rotation, 0, 359) || typeof horzFlip !== "boolean" || typeof vertFlip !== "boolean") return undefined;
  let description: string | undefined;
  if (float.alt !== undefined) {
    if (!record(float.alt) || !hasOnlyKeys(float.alt, ["text", "title", "decorative"])
      || (float.alt.title !== undefined && float.alt.title !== "")
      || (float.alt.decorative !== undefined && float.alt.decorative !== false)) return undefined;
    if (float.alt.text !== undefined) {
      if (typeof float.alt.text !== "string" || float.alt.text.length > 4096) return undefined;
      if (float.alt.text) description = float.alt.text;
    }
  }

  const fill = source.fill === null ? null : docxRgbToHwpx(source.fill);
  const border = source.stroke === null ? null : docxRgbToHwpx(source.stroke);
  const borderWidth = source.stroke === null ? (source.stroke_width === 0 ? 0 : null) : pointToHwpUnit(source.stroke_width, 0, 7200);
  if ((source.fill !== null && fill === null) || (source.stroke !== null && border === null) || borderWidth === null
    || (shapeType === "line" && fill !== null)) return undefined;

  return {
    kind: "shape", shapeType, width, height, horzOffset: 0, vertOffset: 0, treatAsChar: true, textWrap: "Square",
    rotationAngle: rotation, horzFlip, vertFlip,
    borderColor: border ?? 0, borderWidth, lineType: border === null ? 0 : 1,
    fillType: fill === null ? "none" : "solid", ...(fill !== null ? { fillBgColor: fill } : {}),
    ...(description ? { description } : {}),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (record(value)) {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "undefined";
}

const hexColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);

export function decodePortableImageBytes(mime: HwpxPortablePictureMime, base64: string): Uint8Array | null {
  if (typeof base64 !== "string" || base64.length < 12 || base64.length > Math.ceil(MAX_HWPX_PICTURE_BYTES * 4 / 3) + 16
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) return null;
  try {
    const raw = atob(base64);
    if (raw.length < 8 || raw.length > MAX_HWPX_PICTURE_BYTES) return null;
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    if (mime === "image/png") {
      const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      return sig.every((v, i) => bytes[i] === v) ? bytes : null;
    }
    if (mime === "image/jpeg") {
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? bytes : null;
    }
    if (mime === "image/gif") {
      const hdr = String.fromCharCode(...bytes.subarray(0, 6));
      return hdr === "GIF87a" || hdr === "GIF89a" ? bytes : null;
    }
    if (mime === "image/bmp") {
      return bytes[0] === 0x42 && bytes[1] === 0x4d ? bytes : null;
    }
    if (mime === "image/webp") {
      return bytes.length >= 12
        && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
        && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP" ? bytes : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** RHWP cell offsets count Unicode scalar values. The caption control owns one slot. */
export function coversHwpxPortableText(
  spans: readonly (readonly [unknown, unknown])[], length: number, forbiddenOffset?: number,
): boolean {
  let cursor = 0;
  for (const [start, end] of spans) {
    if (cursor === forbiddenOffset) cursor += 1;
    if (start !== cursor || !intInRange(end, cursor + 1, length)
      || (forbiddenOffset !== undefined && cursor < forbiddenOffset && end > forbiddenOffset)) return false;
    cursor = end;
  }
  if (cursor === forbiddenOffset) cursor += 1;
  return cursor === length;
}

function validHwpxPortableRuns(runs: unknown, length: number, forbiddenOffset?: number): runs is readonly HwpxPortableCharRun[] {
  if (!Array.isArray(runs) || runs.length > 4096) return false;
  const runAllowed = new Set(["start", "end", "bold", "italic", "underline", "strikethrough", "fontSize", "textColor", "shadeColor", "fontFamily"]);
  for (const run of runs) {
    if (!record(run) || Object.keys(run).some(k => !runAllowed.has(k))) return false;
    for (const flag of ["bold", "italic", "underline", "strikethrough"] as const) {
      if (run[flag] !== undefined && typeof run[flag] !== "boolean") return false;
    }
    if (run.fontSize !== undefined && !intInRange(run.fontSize, 100, 409_600)) return false;
    if (run.textColor !== undefined && !hexColor(run.textColor)) return false;
    if (run.shadeColor !== undefined && run.shadeColor !== "none" && !hexColor(run.shadeColor)) return false;
    if (run.fontFamily !== undefined && (typeof run.fontFamily !== "string" || run.fontFamily.trim() !== run.fontFamily
      || fontFamilyProblem(run.fontFamily) !== null)) return false;
  }
  return coversHwpxPortableText(runs.map(run => [run.start, run.end]), length, forbiddenOffset);
}

function validHwpxPortableParagraphs(raw: unknown, allowAutoNumber: boolean, maxParas: number): raw is readonly HwpxPortableParagraph[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > maxParas) return false;
  const allowedKeys = new Set(["text", "align", "runs", ...(allowAutoNumber ? ["autoNumberOffset"] : [])]);
  for (let i = 0; i < raw.length; i += 1) {
    const para = raw[i];
    if (!record(para) || typeof para.text !== "string" || para.text.length > 65536 || /[\r\n\uFFFC]/.test(para.text)) return false;
    if (Object.keys(para).some(k => !allowedKeys.has(k))) return false;
    if (!HWPX_PARA_ALIGNS.some(a => a === para.align) || /[\uD800-\uDFFF]/u.test(para.text)) return false;
    const chars = Array.from(para.text);
    let atnoOffset: number | undefined;
    if (allowAutoNumber) {
      if (i === 0) {
        if (!intInRange(para.autoNumberOffset, 0, chars.length - 1) || chars[para.autoNumberOffset] !== " ") return false;
        atnoOffset = para.autoNumberOffset;
      } else if (para.autoNumberOffset !== undefined) {
        return false;
      }
    }
    if (!validHwpxPortableRuns(para.runs === undefined ? [] : para.runs, chars.length, atnoOffset)) return false;
  }
  return true;
}

function validHwpxPortableCaption(raw: unknown): raw is HwpxPortableCaption {
  if (!record(raw)) return false;
  const allowed = new Set(["direction", "vertAlign", "width", "spacing", "includeMargin", "paragraphs"]);
  if (Object.keys(raw).some(k => !allowed.has(k))) return false;
  if (!HWPX_CAPTION_DIRECTIONS.some(d => d === raw.direction)) return false;
  if (!HWPX_CAPTION_VERT_ALIGNS.some(v => v === raw.vertAlign)) return false;
  if (!intInRange(raw.width, 0, 2_000_000) || !intInRange(raw.spacing, -100_000, 100_000) || typeof raw.includeMargin !== "boolean") return false;
  return validHwpxPortableParagraphs(raw.paragraphs, true, 64);
}

/** The destination constructor uses natural pixels × 75 HU as its crop reference
 * and the pasted frame size as the extent of the edge-amount getter. */
export function validHwpxPortablePictureCrop(
  crop: unknown, rect: unknown, width: number, height: number, naturalWidth: number, naturalHeight: number,
): boolean {
  if (!record(crop) || !record(rect) || Object.keys(crop).length !== 4 || Object.keys(rect).length !== 4
    || !intInRange(rect.left, 0, Math.max(width, naturalWidth * 75))
    || !intInRange(rect.top, 0, Math.max(height, naturalHeight * 75))
    || !intInRange(rect.right, 0, Math.max(width, naturalWidth * 75))
    || !intInRange(rect.bottom, 0, Math.max(height, naturalHeight * 75))) return false;
  const empty = rect.left === 0 && rect.top === 0 && rect.right === 0 && rect.bottom === 0;
  return (empty || (rect.left < rect.right && rect.top < rect.bottom))
    && crop.left === rect.left && crop.top === rect.top
    && crop.right === (empty ? 0 : Math.max(0, width - rect.right))
    && crop.bottom === (empty ? 0 : Math.max(0, height - rect.bottom));
}

function validHwpxPortableObject(raw: unknown, kind: RichObjectKind): raw is HwpxPortableObject {
  if (!record(raw)) return false;
  if (raw.kind === "group") {
    if (kind !== "group" || typeof raw.packageBase64 !== "string"
      || raw.packageBase64.length < 8
      || raw.packageBase64.length > Math.ceil(MAX_HWPX_GROUP_PACKAGE_BYTES * 4 / 3) + 16
      || raw.packageBase64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.packageBase64)
      || Object.keys(raw).some(key => key !== "kind" && key !== "packageBase64")) return false;
    try {
      const bytes = atob(raw.packageBase64);
      return bytes.length >= 4 && bytes.length <= MAX_HWPX_GROUP_PACKAGE_BYTES
        && bytes.charCodeAt(0) === 0x50 && bytes.charCodeAt(1) === 0x4b;
    } catch {
      return false;
    }
  }
  if (kind === "group") return false;
  if (raw.kind === "picture") {
    if (kind !== "picture") return false;
    const mime = HWPX_PICTURE_MIMES.find(m => m === raw.mime);
    if (!mime || !decodePortableImageBytes(mime, String(raw.bytesBase64 ?? ""))) return false;
    if (!intInRange(raw.width, 1, 2_000_000) || !intInRange(raw.height, 1, 2_000_000)
      || !intInRange(raw.naturalWidth, 1, 20_000) || !intInRange(raw.naturalHeight, 1, 20_000)
      || !intInRange(raw.horzOffset, -1_000_000, 2_000_000) || !intInRange(raw.vertOffset, -1_000_000, 2_000_000)
      || typeof raw.treatAsChar !== "boolean"
      || !HWPX_WRAP_VALUES.some(w => w === raw.textWrap)
      || raw.borderColor !== 0 || raw.borderWidth !== 0 || raw.borderType !== 0) return false;
    if (!validHwpxPortablePictureCrop(raw.crop, raw.cropRect, raw.width, raw.height, raw.naturalWidth, raw.naturalHeight)) return false;
    if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > 4096)) return false;
    if (raw.caption !== undefined && !validHwpxPortableCaption(raw.caption)) return false;
    const allowedKeys = new Set(["kind", "mime", "bytesBase64", "width", "height", "naturalWidth", "naturalHeight",
      "horzOffset", "vertOffset", "treatAsChar", "textWrap", "borderColor", "borderWidth", "borderType", "crop", "cropRect", "description", "caption"]);
    return Object.keys(raw).every(key => allowedKeys.has(key));
  }
  if (raw.kind !== undefined && raw.kind !== "shape") return false;
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
    || (raw.lineType !== 0 && raw.lineType !== 1)
    || (raw.fillType !== "none" && raw.fillType !== "solid")) return false;
  if (raw.fillType === "solid" ? !intInRange(raw.fillBgColor, 0, 0xFFFFFFFF) : raw.fillBgColor !== undefined) return false;
  if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > 4096)) return false;
  if (shapeType === "polygon") {
    const points = raw.polygonPoints;
    if (raw.rotationAngle !== 0 || raw.horzFlip || raw.vertFlip || raw.caption !== undefined
      || !intInRange(raw.borderColor, 0, 0xffffff)
      || (raw.fillBgColor !== undefined && !intInRange(raw.fillBgColor, 0, 0xffffff))
      || !Array.isArray(points) || points.length < 4 || points.length > 257
      || !points.every(p => record(p) && Object.keys(p).sort().join(",") === "x,y"
        && intInRange(p.x, 0, raw.width as number) && intInRange(p.y, 0, raw.height as number))) return false;
    const vertices = points.slice(0, -1);
    const last = points.at(-1);
    if (points[0].x !== last.x || points[0].y !== last.y
      || new Set(vertices.map(p => `${p.x},${p.y}`)).size !== vertices.length
      || vertices.reduce((area, p, i) => area + p.x * points[i + 1].y - p.y * points[i + 1].x, 0) === 0) return false;
  } else if (raw.polygonPoints !== undefined) return false;
  if (shapeType === "textbox") {
    if (!HWPX_TB_VERTICAL_ALIGNS.some(a => a === raw.tbVerticalAlign)
      || !record(raw.tbMargins) || Object.keys(raw.tbMargins).length !== 4
      || !intInRange(raw.tbMargins.left, 0, 32767) || !intInRange(raw.tbMargins.right, 0, 32767)
      || !intInRange(raw.tbMargins.top, 0, 32767) || !intInRange(raw.tbMargins.bottom, 0, 32767)
      || !validHwpxPortableParagraphs(raw.paragraphs, false, 1024)) return false;
  } else if (raw.tbVerticalAlign !== undefined || raw.tbMargins !== undefined || raw.paragraphs !== undefined) return false;
  if (raw.caption !== undefined && !validHwpxPortableCaption(raw.caption)) return false;
  const allowedKeys = new Set(["kind", "shapeType", "width", "height", "horzOffset", "vertOffset", "treatAsChar", "textWrap",
    "rotationAngle", "horzFlip", "vertFlip", "borderColor", "borderWidth", "lineType", "fillType", "fillBgColor",
    "description", "tbVerticalAlign", "tbMargins", "paragraphs", "caption", "polygonPoints"]);
  return Object.keys(raw).every(key => allowedKeys.has(key));
}

/** Envelope validation of untrusted clipboard text. v2/v3 content is checked again by the engine/session. */
export function parseObjectClipboardPayload(serialized: string): ObjectClipboardPayload | null {
  if (typeof serialized !== "string" || serialized.length > MAX_OBJECT_CLIPBOARD_BYTES) return null;
  try {
    const raw: unknown = JSON.parse(serialized);
    if (!record(raw) || raw.kind !== "geul.object"
      || typeof raw.token !== "string" || !/^[0-9a-f]{24}$/.test(raw.token)) return null;
    if (raw.version === 5) {
      const required = ["kind", "object", "portable", "sourceFormat", "sourceGeneration", "sourceSessionId", "token", "version"];
      const allowed = [...required, "hwpFragmentBase64"];
      if (raw.sourceFormat !== "hwp" || raw.object !== "shape"
        || Object.keys(raw).some(key => !allowed.includes(key))
        || required.some(key => !(key in raw))
        || !intInRange(raw.sourceSessionId, 0, Number.MAX_SAFE_INTEGER)
        || !intInRange(raw.sourceGeneration, 0, Number.MAX_SAFE_INTEGER)
        || !validHwpxPortableObject(raw.portable, "shape")
        || !["rectangle", "ellipse", "line"].includes((raw.portable as HwpxPortableShape).shapeType)
        || (raw.hwpFragmentBase64 !== undefined && !validHwp5ObjectFragmentBase64(raw.hwpFragmentBase64))) return null;
      return {
        kind: "geul.object", version: 5, sourceFormat: "hwp", object: "shape",
        sourceSessionId: raw.sourceSessionId, sourceGeneration: raw.sourceGeneration,
        portable: raw.portable as HwpxPortableShape,
        ...(raw.hwpFragmentBase64 !== undefined ? { hwpFragmentBase64: raw.hwpFragmentBase64 } : {}),
        token: raw.token,
      };
    }
    if (raw.version === 3) {
      if (raw.sourceFormat !== "hwpx" && raw.sourceFormat !== "hwp") return null;
      const object = RICH_OBJECT_KINDS.find(kind => kind === raw.object);
      const allowedKeys = new Set(["kind", "version", "sourceFormat", "object", "sourceSessionId", "sourceGeneration", "portable", "hwpFragmentBase64", "token"]);
      if (!object || Object.keys(raw).some(key => !allowedKeys.has(key))
        || !intInRange(raw.sourceSessionId, 0, Number.MAX_SAFE_INTEGER)
        || !intInRange(raw.sourceGeneration, 0, Number.MAX_SAFE_INTEGER)) return null;
      if (raw.sourceFormat === "hwp" && raw.portable !== undefined) return null;
      if (raw.portable !== undefined && !validHwpxPortableObject(raw.portable, object)) return null;
      if (raw.sourceFormat === "hwpx" && raw.hwpFragmentBase64 !== undefined) return null;
      if (raw.hwpFragmentBase64 !== undefined && !validHwp5ObjectFragmentBase64(raw.hwpFragmentBase64)) return null;
      return {
        kind: "geul.object",
        version: 3,
        sourceFormat: raw.sourceFormat,
        object,
        sourceSessionId: raw.sourceSessionId,
        sourceGeneration: raw.sourceGeneration,
        ...(raw.portable !== undefined ? { portable: raw.portable } : {}),
        ...(raw.hwpFragmentBase64 !== undefined ? { hwpFragmentBase64: raw.hwpFragmentBase64 } : {}),
        token: raw.token,
      };
    }
    if (raw.sourceFormat !== "docx") return null;
    if (raw.version === 4) {
      if (raw.object !== "shape" || Object.keys(raw).sort().join(",") !== "engine,kind,object,portable,sourceFormat,token,version"
        || !record(raw.engine) || !validHwpxPortableObject(raw.portable, "shape")) return null;
      const mapped = docxEngineShapeToHwpx(raw.engine);
      if (!mapped || stableJson(mapped) !== stableJson(raw.portable)) return null;
      return {
        kind: "geul.object", version: 4, sourceFormat: "docx", object: "shape",
        engine: raw.engine, portable: raw.portable as HwpxPortableShape, token: raw.token,
      };
    }
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
