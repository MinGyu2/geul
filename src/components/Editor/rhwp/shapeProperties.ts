import type { EditableGroupChildren, GroupChildFill, GroupChildPathStep, ShapePath, ShapeProperties } from "../../../commands/objectSelection";
import type { RhwpDocument } from "./rhwpModule";
import type { HeaderFooterShapeAddress } from "./objectHit";

/** HWP colors are 0x00BBGGRR. */
export const bgrToHex = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]
  .map(part => part.toString(16).padStart(2, "0")).join("").toUpperCase();
export const hexToBgr = (hex: string) => {
  const n = Number.parseInt(hex, 16);
  return ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff);
};

export interface RhwpShapeInspection {
  properties: ShapeProperties;
  shapeType: string;
  /** Engine values of the fields Stage 3 edits; compared after each edit. */
  raw: { shapeType: string; width: number; height: number; horzOffset: number; vertOffset: number; rotationAngle: number; horzFlip: boolean; vertFlip: boolean;
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
    const shapeType = typeof v.shapeType === "string" ? v.shapeType : "unknown";
    const width = int("width"), height = int("height"), horzOffset = int("horzOffset"), vertOffset = int("vertOffset");
    const rotationAngle = int("rotationAngle"), borderColor = int("borderColor"), borderWidth = int("borderWidth");
    const { treatAsChar, horzFlip, vertFlip, fillType, textWrap } = v;
    if (width === undefined || height === undefined || width <= 0 || height <= 0 || horzOffset === undefined || vertOffset === undefined
      || rotationAngle === undefined || borderColor === undefined || borderWidth === undefined || typeof treatAsChar !== "boolean"
      || typeof horzFlip !== "boolean" || typeof vertFlip !== "boolean" || typeof fillType !== "string" || typeof textWrap !== "string") return undefined;
    const fillBgColor = int("fillBgColor");
    const description = typeof v.description === "string" ? v.description : "";
    return {
      shapeType,
      properties: {
        fill: fillType === "solid" && fillBgColor !== undefined ? bgrToHex(fillBgColor) : null,
        outline: bgrToHex(borderColor), outlineWidth: borderWidth / 100,
        rotation: rotationAngle, flipH: horzFlip, flipV: vertFlip, widthPt: width / 100, heightPt: height / 100,
      },
      raw: { shapeType, width, height, horzOffset, vertOffset, rotationAngle, horzFlip, vertFlip, borderColor, borderWidth, fillType,
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

/** Read a shape through its exact header/footer owner, including an optional table-cell path. */
export function inspectRhwpHeaderFooterShape(
  doc: Pick<RhwpDocument, "getHeaderFooterShapeProperties">,
  address: HeaderFooterShapeAddress,
): RhwpShapeInspection | undefined {
  if (!doc.getHeaderFooterShapeProperties) return undefined;
  return inspectRhwpShape({
    getShapeProperties: () => doc.getHeaderFooterShapeProperties!(
      address.section, address.kind, address.outerParagraph, address.outerControl,
      address.innerParagraph, address.cellPath ?? "[]", address.innerControl,
    ),
  }, [address.section, address.innerParagraph, address.innerControl]);
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

function parseHwpxSegmentTypes(raw: unknown, expectedCount: number): ("LINE" | "CURVE")[] | undefined {
  if (!Array.isArray(raw) || raw.length !== expectedCount) return undefined;
  const types: ("LINE" | "CURVE")[] = [];
  for (const segment of raw) {
    if (!Array.isArray(segment)) return undefined;
    const typeAttributes = segment.filter((attribute): attribute is [string, string] =>
      Array.isArray(attribute) && attribute.length === 2
      && typeof attribute[0] === "string" && typeof attribute[1] === "string"
      && attribute[0] === "type");
    if (typeAttributes.length !== 1
      || (typeAttributes[0]![1] !== "LINE" && typeAttributes[0]![1] !== "CURVE")) return undefined;
    types.push(typeAttributes[0]![1]);
  }
  return types;
}

export function hwpxExactLineSegmentIndices(segmentTypes: readonly ("LINE" | "CURVE")[], closed: boolean): number[] {
  return segmentTypes.flatMap((type, index) => {
    if (type !== "LINE") return [];
    const previous = index > 0 ? segmentTypes[index - 1] : closed ? segmentTypes.at(-1) : undefined;
    const next = index + 1 < segmentTypes.length ? segmentTypes[index + 1] : closed ? segmentTypes[0] : undefined;
    return previous !== "CURVE" && next !== "CURVE" ? [index] : [];
  });
}

export function inspectRhwpShapePath(doc: RhwpDocument, address: readonly [number, number, number], portable = false): ShapePath | undefined {
  try {
    const raw = portable ? doc.getPortablePolygonPath?.(...address) : doc.getEditableShapePath?.(...address);
    if (!raw) return undefined;
    const value = JSON.parse(raw);
    const { kind, width, height, points, closed, curveModel, bezierSegments: rawBeziers,
      segments: rawNativeSegments } = value ?? {};
    if ((kind !== "polygon" && kind !== "curve")
      || !within(width, 2_000_000) || width === 0 || !within(height, 2_000_000) || height === 0
      || typeof closed !== "boolean" || !Array.isArray(points) || points.length < 3 || points.length > 257
      || !points.every(p => p && within(p.x, width) && within(p.y, height) && typeof p.control === "boolean")) return undefined;
    let bezierSegments: ShapePath["bezierSegments"];
    if (curveModel !== undefined || rawBeziers !== undefined) {
      const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 4_000_000;
      if (kind !== "curve" || curveModel !== "catmull-rom-derived-bezier"
        || !Array.isArray(rawBeziers) || rawBeziers.length !== points.length - 1
        || !rawBeziers.every((segment, index) => {
          const coordinates = [segment?.start, segment?.control1, segment?.control2, segment?.end];
          return coordinates.every(point => point && finite(point.x) && finite(point.y))
            && segment.start.x === points[index].x && segment.start.y === points[index].y
            && segment.end.x === points[index + 1].x && segment.end.y === points[index + 1].y;
        })) return undefined;
      bezierSegments = rawBeziers.map(segment => ({
        start: { x: segment.start.x, y: segment.start.y },
        control1: { x: segment.control1.x, y: segment.control1.y },
        control2: { x: segment.control2.x, y: segment.control2.y },
        end: { x: segment.end.x, y: segment.end.y },
      }));
    }
    let nativeSegmentTypes: ShapePath["nativeSegmentTypes"];
    if (rawNativeSegments !== undefined) {
      if (kind !== "curve") return undefined;
      const parsed = parseHwpxSegmentTypes(rawNativeSegments, points.length - 1);
      if (!parsed) return undefined;
      nativeSegmentTypes = parsed;
    }
    return {
      kind, width, height, points: points.map(({ x, y, control }) => ({ x, y, control })), closed,
      ...(nativeSegmentTypes ? { nativeSegmentTypes } : {}),
      ...(bezierSegments ? { curveModel: "catmull-rom-derived-bezier" as const, bezierSegments } : {}),
    };
  } catch {
    return undefined;
  }
}

export function inspectRhwpHwpxCurveEditableSegments(
  doc: RhwpDocument, address: readonly [number, number, number], segmentCount: number,
): number[] | undefined {
  if (!doc.getHwpxEditableCurveSegments || !doc.editHwpxCurveVertex
    || !within(segmentCount, 256) || segmentCount === 0) return undefined;
  try {
    const value: unknown = JSON.parse(doc.getHwpxEditableCurveSegments(...address));
    if (!Array.isArray(value) || value.length !== segmentCount
      || !value.every((index, position) => index === position)) return undefined;
    return value as number[];
  } catch { return undefined; }
}

export function inspectRhwpCurveTerminalLine(doc: RhwpDocument, address: readonly [number, number, number]) {
  if (!doc.getCurveTerminalLineEdits || !doc.editCurveTerminalLine) return undefined;
  try {
    const value = JSON.parse(doc.getCurveTerminalLineEdits(...address));
    if (typeof value?.append !== "boolean" || typeof value?.remove !== "boolean") return undefined;
    return { append: value.append as boolean, remove: value.remove as boolean };
  } catch { return undefined; }
}

export function inspectRhwpHwpxCurveLineSegments(
  doc: RhwpDocument, address: readonly [number, number, number], segmentCount: number,
  segmentTypes: readonly ("LINE" | "CURVE")[] | undefined, closed: boolean,
): number[] | undefined {
  if (!doc.getHwpxCurveLineSegments || !doc.editHwpxCurveLine || !within(segmentCount, 256)
    || !segmentTypes || segmentTypes.length !== segmentCount) return undefined;
  try {
    const value: unknown = JSON.parse(doc.getHwpxCurveLineSegments(...address));
    const expected = hwpxExactLineSegmentIndices(segmentTypes, closed);
    if (!Array.isArray(value) || value.length > segmentCount
      || !value.every((index, position) => within(index, Math.max(0, segmentCount - 1))
        && (position === 0 || index > value[position - 1]))
      || JSON.stringify(value) !== JSON.stringify(expected)) return undefined;
    return value as number[];
  } catch { return undefined; }
}

export function inspectRhwpHwpxCurveSegments(
  doc: RhwpDocument, address: readonly [number, number, number], segmentCount: number,
): number[] | undefined {
  if (!doc.getHwpxCurveSegments || !doc.editHwpxCurveAnchor || !within(segmentCount, 256) || segmentCount === 0) return undefined;
  try {
    const value: unknown = JSON.parse(doc.getHwpxCurveSegments(...address));
    if (!Array.isArray(value) || value.length !== segmentCount
      || !value.every((index, position) => index === position)) return undefined;
    return value as number[];
  } catch { return undefined; }
}

/** Preview the same derived cubic handles after an anchor insertion/removal. */
export function deriveHwpxCurveBezierSegments(
  points: readonly { x: number; y: number }[], closed: boolean,
): NonNullable<ShapePath["bezierSegments"]> | undefined {
  if (points.length < 2 || (closed && (points.length < 4
    || points[0]!.x !== points[points.length - 1]!.x || points[0]!.y !== points[points.length - 1]!.y))) return undefined;
  const anchors = closed ? points.slice(0, -1) : points;
  if (closed && anchors.length < 3) return undefined;
  return Array.from({ length: anchors.length - 1 + (closed ? 1 : 0) }, (_, index) => {
    const start = index;
    const end = closed ? (index + 1) % anchors.length : index + 1;
    const previous = index > 0 ? index - 1 : closed ? anchors.length - 1 : start;
    const next = end + 1 < anchors.length ? end + 1 : closed ? 0 : end;
    const p0 = anchors[start]!, p1 = anchors[end]!, pPrev = anchors[previous]!, pNext = anchors[next]!;
    return {
      start: { x: p0.x, y: p0.y },
      control1: { x: p0.x + (p1.x - pPrev.x) / 6, y: p0.y + (p1.y - pPrev.y) / 6 },
      control2: { x: p1.x - (pNext.x - p0.x) / 6, y: p1.y - (pNext.y - p0.y) / 6 },
      end: { x: p1.x, y: p1.y },
    };
  });
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

export function inspectRhwpGroupChildren(doc: RhwpDocument, address: readonly [number, number, number]): EditableGroupChildren | undefined {
  if (!doc.getEditableGroupChildren) return undefined;
  try {
    const value: unknown = JSON.parse(doc.getEditableGroupChildren(...address));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const { parentId, width, height, children } = value as Record<string, unknown>;
    const u32 = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 0xffff_ffff;
    if (!u32(parentId) || !within(width, 2_000_000) || width === 0 || !within(height, 2_000_000) || height === 0
      || !Array.isArray(children) || !children.length || children.length > 128) return undefined;
    const seen = new Set<string>();
    const parsed = children.map((raw, i) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const c = raw as Record<string, unknown>;
      const baseKeys = "canMove,canResize,height,id,index,instId,kind,locked,sizeProtect,width,x,y";
      const pathKeys = "canMove,canResize,height,id,index,instId,kind,locked,path,sizeProtect,width,x,y";
      const rawPath = c.path;
      const validPath = rawPath === undefined || (Array.isArray(rawPath) && rawPath.length >= 2 && rawPath.length <= 64
        && rawPath.every(step => !!step && typeof step === "object" && !Array.isArray(step)
          && Object.keys(step).sort().join(",") === "id,index,instId"
          && u32((step as Record<string, unknown>).index) && within((step as Record<string, unknown>).index, 127)
          && u32((step as Record<string, unknown>).id) && u32((step as Record<string, unknown>).instId))
        && (rawPath.at(-1) as GroupChildPathStep).id === c.id
        && (rawPath.at(-1) as GroupChildPathStep).instId === c.instId);
      if (Object.keys(c).sort().join(",") !== (rawPath === undefined ? baseKeys : pathKeys) || !validPath) return null;
      if (c.index !== i || (c.kind !== "rectangle" && c.kind !== "ellipse") || !u32(c.id) || !u32(c.instId)
        || !within(c.x, width) || !within(c.y, height) || !within(c.width, width) || c.width === 0
        || !within(c.height, height) || c.height === 0 || (c.x as number) + (c.width as number) > width
        || (c.y as number) + (c.height as number) > height
        || typeof c.sizeProtect !== "boolean" || typeof c.locked !== "boolean"
        || typeof c.canMove !== "boolean" || typeof c.canResize !== "boolean") return null;
      const key = `${c.id}:${c.instId}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        index: c.index as number,
        kind: c.kind as "rectangle" | "ellipse",
        id: c.id as number,
        instId: c.instId as number,
        x: c.x as number,
        y: c.y as number,
        width: c.width as number,
        height: c.height as number,
        sizeProtect: c.sizeProtect as boolean,
        locked: c.locked as boolean,
        canMove: c.canMove as boolean,
        canResize: c.canResize as boolean,
        ...(rawPath ? { path: rawPath as GroupChildPathStep[] } : {}),
      };
    });
    if (parsed.some(item => !item) || !parsed.some(item => item!.canMove || item!.canResize)) return undefined;
    return { parentId, width, height, children: parsed as NonNullable<typeof parsed[number]>[] };
  } catch {
    return undefined;
  }
}
