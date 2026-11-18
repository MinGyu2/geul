import { BASIC_SHAPES, type BasicShape } from "./objectSelection";

export const OBJECT_CLIPBOARD_MIME = "application/x-geul-object+json";
export const MAX_OBJECT_CLIPBOARD_BYTES = 2048;

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

export interface ObjectClipboardPayload {
  kind: "geul.object";
  version: 1;
  sourceFormat: "docx";
  object: ClipboardShape;
  token: string;
}

function standardShape(shape: BasicShape): ClipboardShape {
  return {
    kind: "shape", shape, widthPt: 108, heightPt: shape === "line" ? 1 : 72, placement: "inline",
    fill: shape === "line" ? null : "#156082", outline: "#0E405A", outlinePt: 1,
  };
}

export function createObjectClipboardPayload(shape: BasicShape): ObjectClipboardPayload {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, "0")).join("");
  return { kind: "geul.object", version: 1, sourceFormat: "docx", object: standardShape(shape), token };
}

export function objectClipboardPlainText(payload: ObjectClipboardPayload): string {
  return `Geul ${payload.object.shape} [${payload.token}]`;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function parseObjectClipboardPayload(serialized: string): ObjectClipboardPayload | null {
  if (typeof serialized !== "string" || serialized.length > MAX_OBJECT_CLIPBOARD_BYTES) return null;
  try {
    const raw: unknown = JSON.parse(serialized);
    if (!record(raw) || Object.keys(raw).length !== 5 || raw.kind !== "geul.object" || raw.version !== 1 || raw.sourceFormat !== "docx"
      || typeof raw.token !== "string" || !/^[0-9a-f]{24}$/.test(raw.token) || !record(raw.object)) return null;
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
