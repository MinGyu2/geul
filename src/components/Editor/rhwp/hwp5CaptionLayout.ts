import { CAPTION_SIDES, CAPTION_VERTICAL_ALIGNS, type CaptionSide, type CaptionVerticalAlign } from "../../../commands/objectSelection";

export interface Hwp5CaptionLayout {
  side: CaptionSide;
  verticalAlign: CaptionVerticalAlign;
  /** Whether this unrotated floating owner can render and accept a lateral caption. */
  lateral: boolean;
}

/** Read only the canonical, modeled HWP5 caption fields needed by the layout controls. */
export function inspectHwp5CaptionLayout(raw: unknown): Hwp5CaptionLayout | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const { captionDirection: side, captionVertAlign: verticalAlign } = value;
  const width = value.width, captionWidth = value.captionWidth, spacing = value.captionSpacing;
  const maxWidth = value.captionMaxWidth;
  if (value.hasCaption !== true || "externalPath" in value
    || !CAPTION_SIDES.some(option => option === side)
    || !CAPTION_VERTICAL_ALIGNS.some(option => option === verticalAlign)
    || !Number.isSafeInteger(width) || (width as number) <= 0 || (width as number) > 0xffff_ffff
    || !Number.isSafeInteger(captionWidth) || (captionWidth as number) < 0 || (captionWidth as number) > 0xffff_ffff
    || !Number.isSafeInteger(maxWidth) || (maxWidth as number) < 0 || (maxWidth as number) > 0xffff_ffff
    || !Number.isSafeInteger(spacing) || (spacing as number) < -0x8000 || (spacing as number) > 0x7fff
    || typeof value.captionIncludeMargin !== "boolean"
    || typeof value.treatAsChar !== "boolean" || typeof value.textWrap !== "string"
    || !Number.isSafeInteger(value.rotationAngle) || typeof value.horzFlip !== "boolean" || typeof value.vertFlip !== "boolean") {
    return undefined;
  }
  const lateral = value.treatAsChar === false && value.textWrap === "Square"
    && value.rotationAngle === 0 && value.horzFlip === false && value.vertFlip === false
    && value.captionIncludeMargin === false && (captionWidth as number) > 0 && (spacing as number) >= 0
    && (width as number) + (captionWidth as number) + (spacing as number) <= 0x7fff_ffff;
  return { side: side as CaptionSide, verticalAlign: verticalAlign as CaptionVerticalAlign, lateral };
}
