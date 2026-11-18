import type { PictureProperties } from "../../../commands/objectSelection";
import type { RhwpDocument } from "./rhwpModule";

const HWPUNIT_PER_POINT = 100;
const wrapByEngineName = {
  Square: "square",
  Tight: "tight",
  Through: "through",
  TopAndBottom: "topAndBottom",
  BehindText: "behindText",
  InFrontOfText: "inFrontOfText",
} as const;

export interface RhwpPictureInspection {
  properties: PictureProperties;
  simpleInline: boolean;
  /** A floating picture whose position is a plain left/top offset (moved by changing the offsets). */
  movable?: { horzOffset: number; vertOffset: number };
}

export function inspectRhwpPicture(
  doc: Pick<RhwpDocument, "getPictureProperties">,
  address: readonly [number, number, number],
): RhwpPictureInspection | undefined {
  if (!doc.getPictureProperties) return undefined;
  try {
    const props: unknown = JSON.parse(doc.getPictureProperties(...address));
    if (!props || typeof props !== "object" || Array.isArray(props)) return undefined;
    const values = props as Record<string, unknown>;
    const { width, height, treatAsChar, textWrap, description } = values;
    if (typeof width !== "number" || typeof height !== "number"
      || ![width, height].every(side => Number.isSafeInteger(side) && side > 0 && side <= 0xffffffff)
      || typeof treatAsChar !== "boolean") return undefined;
    const mode = Object.entries(wrapByEngineName).find(([name]) => name === textWrap)?.[1];
    const wrap = treatAsChar ? "inline" : mode;
    if (!wrap) return undefined;
    return {
      properties: {
        widthPt: width / HWPUNIT_PER_POINT, heightPt: height / HWPUNIT_PER_POINT, wrap,
        ...(typeof description === "string" && description.length <= 4096 ? { description } : {}),
      },
      ...(!treatAsChar && values.horzAlign === "Left" && values.vertAlign === "Top"
        && Number.isSafeInteger(values.horzOffset) && Number.isSafeInteger(values.vertOffset)
        && values.hasCaption === false && !("externalPath" in values) && values.rotationAngle === 0
        ? { movable: { horzOffset: values.horzOffset as number, vertOffset: values.vertOffset as number } } : {}),
      simpleInline: treatAsChar && values.sizeProtect === false && values.hasCaption === false
        && values.horzFlip === false && values.vertFlip === false && !("externalPath" in values)
        && ["rotationAngle", "horzOffset", "vertOffset", "cropLeft", "cropTop", "cropRight", "cropBottom"].every(key => values[key] === 0),
    };
  } catch {
    return undefined;
  }
}
