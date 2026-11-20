import type { GroupChildFill, ShapePath, ShapeProperties } from "../../../commands/objectSelection";
import type { RhwpDocument } from "./rhwpModule";

/** HWP colors are 0x00BBGGRR. */
export const bgrToHex = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]
  .map(part => part.toString(16).padStart(2, "0")).join("").toUpperCase();
export const hexToBgr = (hex: string) => {
  const n = Number.parseInt(hex, 16);
  return ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff);
};

export interface RhwpShapeInspection {
  properties: ShapeProperties;
  /** Engine values of the fields Stage 3 edits; compared after each edit. */
  raw: { width: number; height: number; horzOffset: number; vertOffset: number; rotationAngle: number; horzFlip: boolean; vertFlip: boolean;
    borderColor: number; borderWidth: number; fillType: string; fillBgColor?: number; treatAsChar: boolean; textWrap: string; description: string };
  /** Floating with a plain left/top offset. */
  movable: boolean;
  /** Solid or no fill (gradient/picture fills are not edited). */
  fillEditable: boolean;
  solidOutline: boolean;
  textBox: boolean;
  hasCaption: boolean;
  sizeProtected: boolean;
}

/** Read an HWPX/HWP body shape through RHWP `getShapeProperties`; undefined if not a modeled drawing. */
export function inspectRhwpShape(doc: Pick<RhwpDocument, "getShapeProperties">, address: readonly [number, number, number]): RhwpShapeInspection | undefined {
  if (!doc.getShapeProperties) return undefined;
  try {
    const value: unknown = JSON.parse(doc.getShapeProperties(...address));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const v = value as Record<string, unknown>;
    const int = (key: string) => Number.isSafeInteger(v[key]) ? v[key] as number : undefined;
    const width = int("width"), height = int("height"), horzOffset = int("horzOffset"), vertOffset = int("vertOffset");
    const rotationAngle = int("rotationAngle"), borderColor = int("borderColor"), borderWidth = int("borderWidth");
    const { treatAsChar, horzFlip, vertFlip, fillType, textWrap } = v;
    if (width === undefined || height === undefined || width <= 0 || height <= 0 || horzOffset === undefined || vertOffset === undefined
      || rotationAngle === undefined || borderColor === undefined || borderWidth === undefined || typeof treatAsChar !== "boolean"
      || typeof horzFlip !== "boolean" || typeof vertFlip !== "boolean" || typeof fillType !== "string" || typeof textWrap !== "string") return undefined;
    const fillBgColor = int("fillBgColor");
    const description = typeof v.description === "string" ? v.description : "";
    return {
      properties: {
        fill: fillType === "solid" && fillBgColor !== undefined ? bgrToHex(fillBgColor) : null,
        outline: bgrToHex(borderColor), outlineWidth: borderWidth / 100,
        rotation: rotationAngle, flipH: horzFlip, flipV: vertFlip, widthPt: width / 100, heightPt: height / 100,
      },
      raw: { width, height, horzOffset, vertOffset, rotationAngle, horzFlip, vertFlip, borderColor, borderWidth, fillType,
        ...(fillBgColor !== undefined ? { fillBgColor } : {}), treatAsChar, textWrap, description },
      movable: !treatAsChar && v.horzAlign === "Left" && v.vertAlign === "Top",
      fillEditable: fillType === "none" || (fillType === "solid" && fillBgColor !== undefined),
      solidOutline: v.lineType === 1 && borderWidth >= 1 && borderWidth <= 7200
        && v.hasCaption === false && !("tbVerticalAlign" in v),
      textBox: "tbVerticalAlign" in v,
      hasCaption: v.hasCaption === true,
      sizeProtected: v.sizeProtect !== false,
    };
  } catch {
    return undefined;
  }
}

export interface RhwpGroupInspection {
  raw: { width: number; height: number; horzOffset: number; vertOffset: number; treatAsChar: boolean; textWrap: string; description: string };
  widthPt: number;
  heightPt: number;
  movable: boolean;
  hasCaption: boolean;
  sizeProtected: boolean;
  groupFlatDeletable: boolean;
}

/** Read an HWPX/HWP body group container (`"그리기"`) through RHWP `getShapeProperties`. */
export function inspectRhwpGroup(doc: Pick<RhwpDocument, "getShapeProperties">, address: readonly [number, number, number]): RhwpGroupInspection | undefined {
  if (!doc.getShapeProperties) return undefined;
  try {
    const value: unknown = JSON.parse(doc.getShapeProperties(...address));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const v = value as Record<string, unknown>;
    if ("borderColor" in v || "fillType" in v || "tbVerticalAlign" in v) return undefined;
    const int = (key: string) => Number.isSafeInteger(v[key]) ? v[key] as number : undefined;
    const width = int("width"), height = int("height"), horzOffset = int("horzOffset"), vertOffset = int("vertOffset");
    const { treatAsChar, textWrap } = v;
    if (width === undefined || height === undefined || width <= 0 || height <= 0
      || horzOffset === undefined || vertOffset === undefined || typeof treatAsChar !== "boolean"
      || typeof textWrap !== "string") return undefined;
    const description = typeof v.description === "string" ? v.description : "";
    return {
      raw: { width, height, horzOffset, vertOffset, treatAsChar, textWrap, description },
      widthPt: width / 100,
      heightPt: height / 100,
      movable: !treatAsChar && v.horzAlign === "Left" && v.vertAlign === "Top",
      hasCaption: v.hasCaption === true,
      sizeProtected: v.sizeProtect !== false,
      groupFlatDeletable: v.groupFlatDeletable === true,
    };
  } catch {
    return undefined;
  }
}

const within = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;

export function inspectRhwpShapePath(doc: RhwpDocument, address: readonly [number, number, number], portable = false): ShapePath | undefined {
  try {
    const raw = portable ? doc.getPortablePolygonPath?.(...address) : doc.getEditableShapePath?.(...address);
    if (!raw) return undefined;
    const value = JSON.parse(raw);
    const { kind, width, height, points, closed } = value ?? {};
    if ((kind !== "polygon" && kind !== "curve")
      || !within(width, 2_000_000) || width === 0 || !within(height, 2_000_000) || height === 0
      || typeof closed !== "boolean" || !Array.isArray(points) || points.length < 3 || points.length > 257
      || !points.every(p => p && within(p.x, width) && within(p.y, height) && typeof p.control === "boolean")) return undefined;
    return { kind, width, height, points, closed };
  } catch {
    return undefined;
  }
}

export function inspectRhwpGroupFills(doc: RhwpDocument, address: readonly [number, number, number]): GroupChildFill[] | undefined {
  if (!doc.getEditableGroupFills) return undefined;
  try {
    const children: unknown = JSON.parse(doc.getEditableGroupFills(...address));
    if (!Array.isArray(children) || !children.length || children.length > 128
      || !children.every((child, i) => child && within(child.index, 127) && within(child.color, 0xff_ffff)
        && (child.kind === "rectangle" || child.kind === "ellipse") && (i === 0 || child.index > children[i - 1].index))) return undefined;
    return children.map(child => ({ index: child.index, kind: child.kind, color: bgrToHex(child.color) }));
  } catch {
    return undefined;
  }
}
