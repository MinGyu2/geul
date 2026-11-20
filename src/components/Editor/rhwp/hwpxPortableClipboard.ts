import {
  HWPX_CAPTION_DIRECTIONS, HWPX_CAPTION_VERT_ALIGNS, HWPX_PARA_ALIGNS, HWPX_PICTURE_MIMES,
  HWPX_TB_VERTICAL_ALIGNS, HWPX_WRAP_VALUES, MAX_HWPX_PICTURE_BYTES, coversHwpxPortableText, decodePortableImageBytes, validHwpxPortablePictureCrop,
  type HwpxPortableCaption, type HwpxPortableCharRun, type HwpxPortableObject, type HwpxPortableParagraph,
  type HwpxPortablePicture, type HwpxPortablePictureMime, type HwpxPortableShapeType, type RichObjectKind,
} from "../../../commands/objectClipboard";
import { fontFamilyProblem } from "../../../commands/parameters";
import { documentFontTable, type DocumentFontTable } from "./rhwpFonts";
import { inspectRhwpPicture } from "./pictureProperties";
import { inspectRhwpShape } from "./shapeProperties";
import type { RhwpDocument } from "./rhwpModule";

const EXT_BY_MIME: Record<HwpxPortablePictureMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/webp": "webp",
};

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function imageNaturalSize(mime: HwpxPortablePictureMime, bytes: Uint8Array): { width: number; height: number } | null {
  const u16be = (at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
  const u16le = (at: number) => bytes[at]! | (bytes[at + 1]! << 8);
  const u32be = (at: number) => ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
  const u32le = (at: number) => (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
  let w = 0, h = 0;
  if (mime === "image/png" && bytes.length >= 24) {
    w = u32be(16); h = u32be(20);
  } else if (mime === "image/gif" && bytes.length >= 10) {
    w = u16le(6); h = u16le(8);
  } else if (mime === "image/bmp" && bytes.length >= 26) {
    w = u32le(18);
    const rawH = u32le(22) | 0;
    h = Math.abs(rawH);
  } else if (mime === "image/jpeg") {
    let i = 2;
    while (i + 3 < bytes.length) {
      if (bytes[i] !== 0xff) break;
      while (i < bytes.length && bytes[i] === 0xff) i += 1;
      if (i >= bytes.length) break;
      const marker = bytes[i]!;
      i += 1;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (i + 1 >= bytes.length) break;
      const len = u16be(i);
      if (len < 2 || i + len > bytes.length) break;
      if (marker >= 0xc0 && marker <= 0xc3 && len >= 7) {
        h = u16be(i + 3); w = u16be(i + 5);
        break;
      }
      i += len;
    }
  } else if (mime === "image/webp" && bytes.length >= 30) {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === "VP8 " && bytes.length >= 30) {
      w = u16le(26) & 0x3fff; h = u16le(28) & 0x3fff;
    } else if (chunk === "VP8L" && bytes.length >= 25) {
      const b = u32le(21);
      w = (b & 0x3fff) + 1; h = ((b >> 14) & 0x3fff) + 1;
    } else if (chunk === "VP8X" && bytes.length >= 30) {
      w = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
      h = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1;
    }
  }
  return w >= 1 && w <= 20_000 && h >= 1 && h <= 20_000 ? { width: w, height: h } : null;
}

type RunStyle = Omit<HwpxPortableCharRun, "start" | "end">;

function readCharStyleAt(
  doc: RhwpDocument,
  sec: number,
  para: number,
  pathJson: string,
  offset: number,
  fonts: DocumentFontTable | null,
  expectedShapeId?: number,
): RunStyle | null {
  if (!doc.getCellCharPropertiesAtByPath) return null;
  try {
    const raw = JSON.parse(doc.getCellCharPropertiesAtByPath(sec, para, pathJson, offset));
    const { charShapeId, bold, italic, underline, strikethrough, fontSize, textColor, shadeColor } = raw;
    const hex = /^#[0-9a-fA-F]{6}$/;
    if (!Number.isSafeInteger(charShapeId) || (expectedShapeId !== undefined && charShapeId !== expectedShapeId)
      || typeof bold !== "boolean" || typeof italic !== "boolean" || typeof underline !== "boolean"
      || typeof strikethrough !== "boolean" || !Number.isSafeInteger(fontSize) || fontSize < 100 || fontSize > 409_600
      || typeof textColor !== "string" || !hex.test(textColor)
      || typeof shadeColor !== "string" || (shadeColor !== "none" && !hex.test(shadeColor))) return null;

    if ((underline && (raw.underlineType !== "Bottom" || raw.underlineShape !== 0 || raw.underlineColor !== "#000000"))
      || (strikethrough && (raw.strikeShape !== 0 || raw.strikeColor !== "#000000"))
      || raw.shadowType !== 0 || raw.outlineType !== 0 || raw.emphasisDot !== 0
      || raw.subscript !== false || raw.superscript !== false || raw.emboss !== false || raw.engrave !== false
      || raw.kerning !== false || raw.fillType !== "none"
      || !["borderLeft", "borderRight", "borderTop", "borderBottom"].every(key => raw[key]?.type === 0)
      || !Object.entries({ ratios: 100, spacings: 0, relativeSizes: 100, charOffsets: 0 }).every(([key, value]) =>
        Array.isArray(raw[key]) && raw[key].length === 7 && raw[key].every((slot: unknown) => slot === value))) return null;

    // The display getter reports the Hangul primary name. The portable family applies
    // to all seven slots, so read the actual CHAR_SHAPE references and face names.
    const ids = fonts?.charShapes[charShapeId]?.fontIds;
    const family = ids && fonts?.languages[0]!.fonts[ids[0]!]!.definition.name;
    const uniformFamily = ids && family && fonts && family === family.trim() && fontFamilyProblem(family) === null
      && ids.every((id, lang) => fonts.languages[lang]!.fonts[id]!.definition.name === family);
    return { bold, italic, underline, strikethrough, fontSize,
      textColor: textColor.toLowerCase(), shadeColor: shadeColor.toLowerCase(),
      ...(uniformFamily ? { fontFamily: family } : {}) };
  } catch {
    return null;
  }
}

function sameRunStyle(a: RunStyle, b: RunStyle): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline
    && a.strikethrough === b.strikethrough && a.fontSize === b.fontSize
    && a.textColor === b.textColor && a.shadeColor === b.shadeColor && a.fontFamily === b.fontFamily;
}

function readParagraphRuns(
  doc: RhwpDocument,
  sec: number,
  para: number,
  pathJson: string,
  length: number,
  fonts: DocumentFontTable | null,
  requireFont: boolean,
  forbiddenOffset?: number,
): HwpxPortableCharRun[] | null {
  if (length === 0 || (length === 1 && forbiddenOffset === 0)) return [];
  if (requireFont && !fonts) return null;
  const merged: HwpxPortableCharRun[] = [];
  const pushSpan = (start: number, end: number, style: RunStyle) => {
    const prev = merged[merged.length - 1];
    if (prev && prev.end === start && sameRunStyle(prev, style)) {
      prev.end = end;
    } else {
      merged.push({ start, end, ...style });
    }
  };

  if (forbiddenOffset === undefined && doc.getFormattingRunsByPath) {
    try {
      const parsed = JSON.parse(doc.getFormattingRunsByPath(sec, para, pathJson, 0, length));
      if (parsed.length !== length || !Array.isArray(parsed.runs)
        || !parsed.runs.every((span: unknown) => Array.isArray(span) && span.length === 3)
        || !coversHwpxPortableText(parsed.runs, length)) return null;
      // The boolean-mask inventory can merge spans with different colors, sizes or faces.
      if (parsed.fontRuns !== null) {
        const spans = parsed.fontRuns;
        if (!Array.isArray(spans) || spans.length > 4096
          || !spans.every(span => Array.isArray(span) && span.length === 4
            && Number.isSafeInteger(span[2]) && Number.isSafeInteger(span[3]) && span[3] >= 0 && span[3] < 7)
          || !coversHwpxPortableText(spans, length)) return null;
        for (const [start, end, id] of spans) {
          const style = readCharStyleAt(doc, sec, para, pathJson, start, fonts, id);
          if (!style || (requireFont && !style.fontFamily)) return null;
          pushSpan(start, end, style);
        }
        return merged;
      }
    } catch {
      return null;
    }
  }

  // The caption's protected atno marker is excluded from ordinary formatting.
  // With no full shape inventory, prove every required position individually.
  if (length > 512) return null;
  for (let offset = 0; offset < length; offset += 1) {
    if (offset === forbiddenOffset) continue;
    const style = readCharStyleAt(doc, sec, para, pathJson, offset, fonts);
    if (!style || (requireFont && !style.fontFamily)) return null;
    pushSpan(offset, offset + 1, style);
  }
  return merged;
}

function readParagraphAlign(doc: RhwpDocument, sec: number, para: number, pathJson: string) {
  if (!doc.getCellParaPropertiesAtByPath) return undefined;
  try {
    const raw = JSON.parse(doc.getCellParaPropertiesAtByPath(sec, para, pathJson)) as { alignment?: unknown };
    return HWPX_PARA_ALIGNS.find(a => a === raw.alignment);
  } catch {
    return undefined;
  }
}

function findCaptionAtnoSlots(
  doc: RhwpDocument,
  sec: number,
  para: number,
  control: number,
  isShape: boolean,
): { paraCount: number; slotInPara0: number; para0Text: string } | null {
  if (!doc.getControls || !doc.getCursorModel || !doc.getCellParagraphCount || !doc.getCellParagraphLength || !doc.getTextInCell) {
    return null;
  }
  try {
    const controls = JSON.parse(doc.getControls()) as Record<string, unknown>[];
    const model = JSON.parse(doc.getCursorModel()) as { lists?: Record<string, unknown>[] };
    if (!Array.isArray(controls) || !Array.isArray(model?.lists)) return null;
    const expectedListCell = isShape ? 1 : 0;
    const owners = model.lists.filter(list => list.isCell === false && list.hostListId === 0
      && list.sectionIndex === sec && list.hostPara === para && list.controlIndex === control
      && list.cellIndex === expectedListCell);
    if (owners.length !== 1) return null;
    const list = owners[0]!;
    const listId = list.listId;
    const paraCount = list.paraCount;
    if (typeof listId !== "number" || listId < 2 || typeof paraCount !== "number" || paraCount < 1 || paraCount > 64) return null;
    if (model.lists.some(child => child.hostListId === listId)) return null;
    const cellArg = isShape ? 65534 : 0;
    if (doc.getCellParagraphCount(sec, para, control, cellArg) !== paraCount) return null;
    const inList = controls.filter(ctrl => ctrl.list === listId);
    if (inList.length !== 1) return null;
    const atno = inList[0]!;
    if (atno.para !== 0 || atno.ctrlId !== "atno" || atno.ctrlCh !== 18
      || typeof atno.controlIndex !== "number" || typeof atno.pos !== "number") return null;
    const p0Len = doc.getCellParagraphLength(sec, para, control, cellArg, 0);
    if (!Number.isSafeInteger(p0Len) || p0Len < 1 || p0Len > 65536) return null;
    const p0Text = doc.getTextInCell(sec, para, control, cellArg, 0, 0, p0Len);
    if (typeof p0Text !== "string") return null;
    const slot = atno.pos - atno.controlIndex * 8;
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= p0Len || Array.from(p0Text)[slot] !== " ") return null;
    return { paraCount, slotInPara0: slot, para0Text: p0Text };
  } catch {
    return null;
  }
}

function readPortableParagraph(
  doc: RhwpDocument, sec: number, para: number, pathJson: string,
  text: string, length: number, fonts: DocumentFontTable | null, requireFont: boolean, autoNumberOffset?: number,
): HwpxPortableParagraph | undefined {
  if (typeof text !== "string" || /[\r\n\uFFFC]/.test(text) || Array.from(text).length !== length) return undefined;
  const align = readParagraphAlign(doc, sec, para, pathJson);
  const runs = readParagraphRuns(doc, sec, para, pathJson, length, fonts, requireFont, autoNumberOffset);
  if (!align || !runs) return undefined;
  return { text, align, ...(runs.length ? { runs } : {}),
    ...(autoNumberOffset !== undefined ? { autoNumberOffset } : {}) };
}

function extractHwpxCaption(
  doc: RhwpDocument,
  sec: number,
  para: number,
  control: number,
  isShape: boolean,
  rawProps: Record<string, unknown>,
  requireFont: boolean,
): HwpxPortableCaption | undefined {
  const direction = HWPX_CAPTION_DIRECTIONS.find(d => d === rawProps.captionDirection);
  const vertAlign = HWPX_CAPTION_VERT_ALIGNS.find(v => v === rawProps.captionVertAlign);
  const width = Number.isSafeInteger(rawProps.captionWidth) ? rawProps.captionWidth as number : undefined;
  const spacing = Number.isSafeInteger(rawProps.captionSpacing) ? rawProps.captionSpacing as number : undefined;
  const includeMargin = typeof rawProps.captionIncludeMargin === "boolean" ? rawProps.captionIncludeMargin : undefined;
  if (!direction || !vertAlign || width === undefined || spacing === undefined || includeMargin === undefined) return undefined;

  const capInfo = findCaptionAtnoSlots(doc, sec, para, control, isShape);
  if (!capInfo || !doc.getCellParagraphLength || !doc.getTextInCell) return undefined;
  const cellIndex = isShape ? 65534 : 0;
  const paragraphs: HwpxPortableParagraph[] = [];
  const fonts = documentFontTable(doc);
  for (let p = 0; p < capInfo.paraCount; p += 1) {
    const len = doc.getCellParagraphLength(sec, para, control, cellIndex, p);
    if (!Number.isSafeInteger(len) || len < 0 || len > 65536) return undefined;
    const text = p === 0 ? capInfo.para0Text : (len > 0 ? doc.getTextInCell(sec, para, control, cellIndex, p, 0, len) : "");
    const path = JSON.stringify([{ controlIndex: control, cellIndex, cellParaIndex: p }]);
    const paragraph = readPortableParagraph(doc, sec, para, path, text, len, fonts, requireFont, p === 0 ? capInfo.slotInPara0 : undefined);
    if (!paragraph) return undefined;
    paragraphs.push(paragraph);
  }
  return { direction, vertAlign, width, spacing, includeMargin, paragraphs };
}

function hasPortableLineGeometry(
  doc: RhwpDocument, [section, paragraph, control]: readonly [number, number, number],
  shape: { width: number; height: number; rotationAngle: number; horzFlip: boolean; vertFlip: boolean },
): boolean {
  // createShapeControl constructs a line from (0,0) to (width,height).
  // RHWP's page layout exposes the endpoints at 96 DPI, rounded to 0.1 px.
  if (!doc.getPageControlLayout || shape.rotationAngle !== 0 || shape.horzFlip || shape.vertFlip) return false;
  try {
    for (let page = 0; page < doc.pageCount(); page += 1) {
      const layout = JSON.parse(doc.getPageControlLayout(page));
      const line = layout.controls.find((c: Record<string, unknown>) => c.type === "line"
        && c.secIdx === section && c.paraIdx === paragraph && c.controlIdx === control);
      if (line) return Math.abs(line.x2 - line.x1 - shape.width / 75) <= 0.1
        && Math.abs(line.y2 - line.y1 - shape.height / 75) <= 0.1;
    }
  } catch {
    return false;
  }
  return false;
}

export function extractHwpxPortableObject(
  doc: RhwpDocument, address: readonly [number, number, number], kind: RichObjectKind,
): HwpxPortableObject | undefined {
  return readPortableObject(doc, address, kind, true);
}

function readPortableObject(
  doc: RhwpDocument, address: readonly [number, number, number], kind: RichObjectKind, requireFont: boolean,
): HwpxPortableObject | undefined {
  if (kind === "group") return undefined;
  const [sec, para, control] = address;

  if (kind === "picture") {
    if (!doc.getPictureProperties || !doc.getControlImageData || !doc.getControlImageMime) return undefined;
    const inspected = inspectRhwpPicture(doc, address);
    if (!inspected) return undefined;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(doc.getPictureProperties(sec, para, control)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    if ("externalPath" in raw && raw.externalPath) return undefined;
    const mimeRaw = doc.getControlImageMime(sec, para, "[]", control);
    const mime = HWPX_PICTURE_MIMES.find(m => m === mimeRaw);
    if (!mime) return undefined;
    let bytes: Uint8Array;
    try {
      bytes = doc.getControlImageData(sec, para, "[]", control);
    } catch {
      return undefined;
    }
    if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > MAX_HWPX_PICTURE_BYTES) return undefined;
    const bytesBase64 = encodeBase64(bytes);
    if (!decodePortableImageBytes(mime, bytesBase64)) return undefined;
    const nat = imageNaturalSize(mime, bytes);
    if (!nat) return undefined;
    const int = (key: string) => Number.isSafeInteger(raw[key]) ? raw[key] as number : undefined;
    const width = int("width"), height = int("height"), horzOffset = int("horzOffset"), vertOffset = int("vertOffset");
    const { borderColor, borderWidth, borderType } = raw;
    const textWrap = HWPX_WRAP_VALUES.find(w => w === raw.textWrap);
    // HWPX picture serialization cannot reproduce a picture lineShape. The
    // getter accounts for even a zero-width visible border in its eligibility.
    if (width === undefined || height === undefined || horzOffset === undefined || vertOffset === undefined
      || typeof raw.treatAsChar !== "boolean" || !textWrap
      || borderColor !== 0 || borderWidth !== 0 || borderType !== 0) return undefined;
    const crop = { left: raw.cropLeft, top: raw.cropTop, right: raw.cropRight, bottom: raw.cropBottom };
    const cropRect = raw.cropRect;
    if (!validHwpxPortablePictureCrop(crop, cropRect, width, height, nat.width, nat.height)) return undefined;
    // The zero rectangle is the engine's uncropped sentinel. A nonempty
    // rectangle needs the same image reference as the destination constructor.
    const rect = cropRect as HwpxPortablePicture["cropRect"];
    if (rect.right !== 0 && (raw.cropReferenceWidth !== nat.width * 75
      || raw.cropReferenceHeight !== nat.height * 75)) return undefined;
    const description = typeof raw.description === "string" && raw.description.length > 0 ? raw.description : undefined;
    let caption: HwpxPortableCaption | undefined;
    if (raw.hasCaption === true) {
      caption = extractHwpxCaption(doc, sec, para, control, false, raw, requireFont);
      if (!caption) return undefined;
    }
    return {
      kind: "picture", mime, bytesBase64, width, height,
      naturalWidth: nat.width, naturalHeight: nat.height,
      horzOffset, vertOffset, treatAsChar: raw.treatAsChar, textWrap,
      borderColor, borderWidth, borderType, crop: crop as HwpxPortablePicture["crop"], cropRect: rect,
      ...(description ? { description } : {}),
      ...(caption ? { caption } : {}),
    };
  }

  const shape = inspectRhwpShape(doc, address);
  if (!shape || !doc.getShapeProperties || !doc.getControls) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(doc.getShapeProperties(sec, para, control)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const controls = JSON.parse(doc.getControls()) as { list?: number; section?: number; para?: number; controlIndex?: number; userDesc?: string }[];
  const owner = controls.find(c => (c.list ?? 0) === 0 && (c.section ?? 0) === sec && c.para === para && c.controlIndex === control);
  let shapeType: HwpxPortableShapeType | undefined;
  if (shape.textBox && (owner?.userDesc === "사각형" || owner?.userDesc === "글상자")) {
    shapeType = "textbox";
  } else if (owner?.userDesc === "사각형") {
    shapeType = "rectangle";
  } else if (owner?.userDesc === "타원") {
    shapeType = "ellipse";
  } else if (owner?.userDesc === "직선" || owner?.userDesc === "선") {
    shapeType = "line";
  }
  if (!shapeType || (!!shape.textBox !== (shapeType === "textbox"))) return undefined;
  if (shapeType !== "textbox" && ["tbMarginLeft", "tbMarginRight", "tbMarginTop", "tbMarginBottom"].some(key => key in raw)) return undefined;
  if ((raw.roundRate !== undefined && raw.roundRate !== 0) || raw.shadowType !== 0) return undefined;
  if (shapeType === "line" && !hasPortableLineGeometry(doc, address, shape.raw)) return undefined;
  // ShapeBorderLine: 0 is NONE and 1 is SOLID, including a visible zero-width hairline.
  // The constructor uses a round cap and no arrows. Other visible outline details
  // have no representation in the portable subset.
  if (raw.lineType !== 0 && raw.lineType !== 1) return undefined;
  if (raw.lineType === 1 && (raw.lineEndShape !== 1 || raw.arrowStart !== 0
    || raw.arrowEnd !== 0 || raw.borderOutlineStyle !== 0)) return undefined;
  if (raw.connectorType !== undefined) return undefined;
  if (kind === "textBox" ? shapeType !== "textbox" : shapeType === "textbox") return undefined;

  const textWrap = HWPX_WRAP_VALUES.find(w => w === shape.raw.textWrap);
  if (!textWrap || (shape.raw.fillType !== "none" && shape.raw.fillType !== "solid")) return undefined;
  if (shape.raw.fillType === "solid" && (raw.fillAlpha !== 0 || typeof raw.fillPatType !== "number" || raw.fillPatType > 0)) return undefined;

  let tbVerticalAlign: typeof HWPX_TB_VERTICAL_ALIGNS[number] | undefined;
  let tbMargins: { left: number; right: number; top: number; bottom: number } | undefined;
  let paragraphs: HwpxPortableParagraph[] | undefined;

  if (shapeType === "textbox") {
    if (!doc.getCellParagraphCount || !doc.getCellParagraphLength || !doc.getTextInCell || !doc.getCellInlineContextByPath) return undefined;
    tbVerticalAlign = HWPX_TB_VERTICAL_ALIGNS.find(a => a === raw.tbVerticalAlign);
    const { tbMarginLeft: left, tbMarginRight: right, tbMarginTop: top, tbMarginBottom: bottom } = raw;
    // The getter always emits all four signed i16 HWPUNIT margins. Only the
    // supported nonnegative subset can enter a portable snapshot.
    const margin = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 32767;
    if (!tbVerticalAlign || !margin(left) || !margin(right) || !margin(top) || !margin(bottom)) return undefined;
    tbMargins = { left, right, top, bottom };
    const count = doc.getCellParagraphCount(sec, para, control, 0);
    if (!Number.isSafeInteger(count) || count < 1 || count > 1024) return undefined;
    paragraphs = [];
    const fonts = documentFontTable(doc);
    for (let p = 0; p < count; p += 1) {
      const len = doc.getCellParagraphLength(sec, para, control, 0, p);
      if (!Number.isSafeInteger(len) || len < 0 || len > 65536) return undefined;
      const pathJson = JSON.stringify([{ controlIndex: control, cellIndex: 0, cellParaIndex: p }]);
      try {
        const inline = JSON.parse(doc.getCellInlineContextByPath(sec, para, pathJson, 0, len)) as { containsControl?: boolean; hasPictures?: boolean; length?: number };
        if (inline.containsControl || inline.hasPictures || (typeof inline.length === "number" && inline.length !== len)) return undefined;
      } catch {
        return undefined;
      }
      const text = len > 0 ? doc.getTextInCell(sec, para, control, 0, p, 0, len) : "";
      const paragraph = readPortableParagraph(doc, sec, para, pathJson, text, len, fonts, requireFont);
      if (!paragraph) return undefined;
      paragraphs.push(paragraph);
    }
  }

  let caption: HwpxPortableCaption | undefined;
  if (shape.hasCaption) {
    caption = extractHwpxCaption(doc, sec, para, control, true, raw, requireFont);
    if (!caption) return undefined;
  }

  const normRot = ((Math.round(shape.raw.rotationAngle) % 360) + 360) % 360;
  return {
    kind: "shape",
    shapeType,
    width: shape.raw.width,
    height: shape.raw.height,
    horzOffset: shape.raw.horzOffset,
    vertOffset: shape.raw.vertOffset,
    treatAsChar: shape.raw.treatAsChar,
    textWrap,
    rotationAngle: normRot,
    horzFlip: shape.raw.horzFlip,
    vertFlip: shape.raw.vertFlip,
    borderColor: shape.raw.borderColor >>> 0,
    borderWidth: shape.raw.borderWidth,
    lineType: raw.lineType,
    fillType: shape.raw.fillType,
    ...(shape.raw.fillType === "solid" && shape.raw.fillBgColor !== undefined ? { fillBgColor: shape.raw.fillBgColor >>> 0 } : {}),
    ...(shape.raw.description ? { description: shape.raw.description } : {}),
    ...(tbVerticalAlign ? { tbVerticalAlign } : {}),
    ...(tbMargins ? { tbMargins } : {}),
    ...(paragraphs ? { paragraphs } : {}),
    ...(caption ? { caption } : {}),
  };
}

function applyRunFormatting(
  doc: RhwpDocument,
  sec: number,
  paraIdx: number,
  controlIdx: number,
  cellIndex: number,
  cellParaIndex: number,
  run: HwpxPortableCharRun,
  resolvedFonts: Map<string, readonly number[]>,
) {
  const { start, end, fontFamily, ...format } = run;
  const props: Record<string, unknown> = format;
  if (fontFamily !== undefined) {
    let ids = resolvedFonts.get(fontFamily);
    if (!ids) {
      if (!doc.resolveDocumentFontFamily) throw new Error("portable font resolver unavailable");
      const result: unknown = JSON.parse(doc.resolveDocumentFontFamily(fontFamily));
      const table = documentFontTable(doc);
      if (!table || !Array.isArray(result) || result.length !== table.languages.length
        || !result.every((id, lang) => Number.isSafeInteger(id) && id >= 0 && id <= 65535
          && table.languages[lang]!.fonts[id]?.definition.name === fontFamily)) {
        throw new Error("portable font mapping does not match the requested family");
      }
      ids = result;
      resolvedFonts.set(fontFamily, ids);
    }
    props.fontIds = ids;
  }
  if (Object.keys(props).length === 0) return;
  if (!doc.applyCharFormatInCellByPath) throw new Error("applyCharFormatInCellByPath unavailable");
  const pathJson = JSON.stringify([{ controlIndex: controlIdx, cellIndex, cellParaIndex }]);
  const res = JSON.parse(doc.applyCharFormatInCellByPath(sec, paraIdx, pathJson, start, end, JSON.stringify(props))) as { ok?: boolean };
  if (res.ok !== true) throw new Error("applyCharFormatInCellByPath failed");
}

function applyParaAlign(
  doc: RhwpDocument,
  sec: number,
  paraIdx: number,
  controlIdx: number,
  cellIndex: number,
  cellParaIndex: number,
  align: HwpxPortableParagraph["align"],
) {
  const pathJson = JSON.stringify([{ controlIndex: controlIdx, cellIndex, cellParaIndex }]);
  if (doc.applyParaFormatInCellByPath) {
    const res = JSON.parse(doc.applyParaFormatInCellByPath(sec, paraIdx, pathJson, JSON.stringify({ alignment: align }))) as { ok?: boolean };
    if (res.ok !== true) throw new Error("applyParaFormatInCellByPath failed");
  } else if (doc.applyParaFormatInCell) {
    const res = JSON.parse(doc.applyParaFormatInCell(sec, paraIdx, controlIdx, cellIndex, cellParaIndex, JSON.stringify({ alignment: align }))) as { ok?: boolean };
    if (res.ok !== true) throw new Error("applyParaFormatInCell failed");
  } else {
    throw new Error("portable paragraph alignment API unavailable");
  }
  if (readParagraphAlign(doc, sec, paraIdx, pathJson) !== align) throw new Error("portable paragraph alignment mismatch");
}

function populateCaption(
  doc: RhwpDocument,
  sec: number,
  paraIdx: number,
  controlIdx: number,
  isShape: boolean,
  caption: HwpxPortableCaption,
  resolvedFonts: Map<string, readonly number[]>,
) {
  if (!doc.insertTextInCell || !doc.deleteTextInCell || !doc.splitParagraphInCell) {
    throw new Error("caption cell APIs unavailable");
  }
  const cellIndex = isShape ? 65534 : 0;
  const slotInfo = findCaptionAtnoSlots(doc, sec, paraIdx, controlIdx, isShape);
  if (!slotInfo) throw new Error("destination caption atno slot missing");

  const p0 = caption.paragraphs[0]!;
  const srcSlot = p0.autoNumberOffset!;
  const srcChars = Array.from(p0.text);
  const dstChars = Array.from(slotInfo.para0Text);
  const srcPrefix = srcChars.slice(0, srcSlot).join("");
  const srcSuffix = srcChars.slice(srcSlot + 1).join("");
  const dstPrefix = dstChars.slice(0, slotInfo.slotInPara0).join("");
  const curSlot = slotInfo.slotInPara0;
  const afterLen = dstChars.length - (curSlot + 1);
  // Insert replacement suffix after existing trailing characters first so the +8 char_offsets jump at `atno` stays intact.
  if (srcSuffix.length > 0) {
    const res = JSON.parse(doc.insertTextInCell(sec, paraIdx, controlIdx, cellIndex, 0, curSlot + 1 + afterLen, srcSuffix)) as { ok?: boolean };
    if (res.ok !== true) throw new Error("insertTextInCell suffix failed");
  }
  if (afterLen > 0) {
    const res = JSON.parse(doc.deleteTextInCell(sec, paraIdx, controlIdx, cellIndex, 0, curSlot + 1, afterLen)) as { ok?: boolean };
    if (res.ok !== true) throw new Error("deleteTextInCell suffix failed");
  }
  if (dstPrefix !== srcPrefix) {
    if (srcPrefix.length > 0) {
      const res = JSON.parse(doc.insertTextInCell(sec, paraIdx, controlIdx, cellIndex, 0, 0, srcPrefix)) as { ok?: boolean };
      if (res.ok !== true) throw new Error("insertTextInCell prefix failed");
    }
    if (curSlot > 0) {
      const res = JSON.parse(doc.deleteTextInCell(sec, paraIdx, controlIdx, cellIndex, 0, srcSlot, curSlot)) as { ok?: boolean };
      if (res.ok !== true) throw new Error("deleteTextInCell prefix failed");
    }
  }
  applyParaAlign(doc, sec, paraIdx, controlIdx, cellIndex, 0, p0.align);
  for (const run of p0.runs ?? []) {
    applyRunFormatting(doc, sec, paraIdx, controlIdx, cellIndex, 0, run, resolvedFonts);
  }

  let prevLen = doc.getCellParagraphLength!(sec, paraIdx, controlIdx, cellIndex, 0);
  for (let p = 1; p < caption.paragraphs.length; p += 1) {
    const splitRes = JSON.parse(doc.splitParagraphInCell(sec, paraIdx, controlIdx, cellIndex, p - 1, prevLen)) as { ok?: boolean };
    if (splitRes.ok !== true) throw new Error("splitParagraphInCell caption failed");
    const para = caption.paragraphs[p]!;
    if (para.text.length > 0) {
      const ins = JSON.parse(doc.insertTextInCell(sec, paraIdx, controlIdx, cellIndex, p, 0, para.text)) as { ok?: boolean };
      if (ins.ok !== true) throw new Error("insertTextInCell caption failed");
    }
    applyParaAlign(doc, sec, paraIdx, controlIdx, cellIndex, p, para.align);
    for (const run of para.runs ?? []) {
      applyRunFormatting(doc, sec, paraIdx, controlIdx, cellIndex, p, run, resolvedFonts);
    }
    prevLen = Array.from(para.text).length;
  }
}

function createPortableObject(
  doc: RhwpDocument,
  at: { section: number; paragraph: number; offset: number },
  portable: HwpxPortableObject,
  resolvedFonts: Map<string, readonly number[]>,
): { paraIdx: number; controlIdx: number } {
  if (portable.kind === "picture") {
    if (!doc.insertPicture || !doc.setPictureProperties) throw new Error("picture insert APIs unavailable");
    const bytes = decodePortableImageBytes(portable.mime, portable.bytesBase64);
    if (!bytes) throw new Error("invalid portable picture bytes");
    const ext = EXT_BY_MIME[portable.mime];
    const created = JSON.parse(doc.insertPicture(
      at.section, at.paragraph, at.offset, "[]", bytes,
      portable.width, portable.height, portable.naturalWidth, portable.naturalHeight,
      ext, portable.description ?? "",
    )) as { ok?: boolean; paraIdx?: number; controlIdx?: number };
    if (created.ok !== true || !Number.isSafeInteger(created.paraIdx) || !Number.isSafeInteger(created.controlIdx)) {
      throw new Error("insertPicture failed");
    }
    const paraIdx = created.paraIdx!;
    const controlIdx = created.controlIdx!;
    const props: Record<string, unknown> = {
      treatAsChar: portable.treatAsChar,
      textWrap: portable.textWrap,
      horzOffset: portable.horzOffset,
      vertOffset: portable.vertOffset,
      portableCropRect: true,
      cropLeft: portable.cropRect.left,
      cropTop: portable.cropRect.top,
      cropRight: portable.cropRect.right,
      cropBottom: portable.cropRect.bottom,
      description: portable.description ?? "",
      ...(portable.caption ? {
        hasCaption: true,
        captionDirection: portable.caption.direction,
        captionVertAlign: portable.caption.vertAlign,
        captionWidth: portable.caption.width,
        captionSpacing: portable.caption.spacing,
        captionIncludeMargin: portable.caption.includeMargin,
      } : {}),
    };
    const updated = JSON.parse(doc.setPictureProperties(at.section, paraIdx, controlIdx, JSON.stringify(props))) as { ok?: boolean };
    if (updated.ok !== true) throw new Error("setPictureProperties failed");
    if (portable.caption) populateCaption(doc, at.section, paraIdx, controlIdx, false, portable.caption, resolvedFonts);
    return { paraIdx, controlIdx };
  }

  if (!doc.createShapeControl || !doc.setShapeProperties) throw new Error("shape insert APIs unavailable");
  const created = JSON.parse(doc.createShapeControl(JSON.stringify({
    sectionIdx: at.section,
    paraIdx: at.paragraph,
    charOffset: at.offset,
    width: portable.width,
    height: portable.height,
    horzOffset: portable.horzOffset,
    vertOffset: portable.vertOffset,
    treatAsChar: portable.treatAsChar,
    textWrap: portable.textWrap,
    shapeType: portable.shapeType,
    lineFlipX: false,
    lineFlipY: false,
    polygonPoints: [],
  }))) as { ok?: boolean; paraIdx?: number; controlIdx?: number };
  if (created.ok !== true || !Number.isSafeInteger(created.paraIdx) || !Number.isSafeInteger(created.controlIdx)) {
    throw new Error("createShapeControl failed");
  }
  const paraIdx = created.paraIdx!;
  const controlIdx = created.controlIdx!;
  const props: Record<string, unknown> = {
    textWrap: portable.textWrap,
    rotationAngle: portable.rotationAngle,
    horzFlip: portable.horzFlip,
    vertFlip: portable.vertFlip,
    borderColor: portable.borderColor,
    borderWidth: portable.borderWidth,
    lineType: portable.lineType,
    fillType: portable.fillType,
    ...(portable.fillType === "solid" && portable.fillBgColor !== undefined ? { fillBgColor: portable.fillBgColor } : {}),
    description: portable.description ?? "",
    ...(portable.tbVerticalAlign ? { tbVerticalAlign: portable.tbVerticalAlign } : {}),
    ...(portable.tbMargins ? {
      tbMarginLeft: portable.tbMargins.left,
      tbMarginRight: portable.tbMargins.right,
      tbMarginTop: portable.tbMargins.top,
      tbMarginBottom: portable.tbMargins.bottom,
    } : {}),
    ...(portable.caption ? {
      hasCaption: true,
      captionDirection: portable.caption.direction,
      captionVertAlign: portable.caption.vertAlign,
      captionWidth: portable.caption.width,
      captionSpacing: portable.caption.spacing,
      captionIncludeMargin: portable.caption.includeMargin,
    } : {}),
  };
  const updated = JSON.parse(doc.setShapeProperties(at.section, paraIdx, controlIdx, JSON.stringify(props))) as { ok?: boolean };
  if (updated.ok !== true) throw new Error("setShapeProperties failed");

  if (portable.shapeType === "textbox" && portable.paragraphs) {
    if (!doc.insertTextInCell || !doc.splitParagraphInCell) throw new Error("textbox cell APIs unavailable");
    let prevLen = 0;
    for (let p = 0; p < portable.paragraphs.length; p += 1) {
      if (p > 0) {
        const splitRes = JSON.parse(doc.splitParagraphInCell(at.section, paraIdx, controlIdx, 0, p - 1, prevLen)) as { ok?: boolean };
        if (splitRes.ok !== true) throw new Error("splitParagraphInCell textbox failed");
      }
      const para = portable.paragraphs[p]!;
      if (para.text.length > 0) {
        const ins = JSON.parse(doc.insertTextInCell(at.section, paraIdx, controlIdx, 0, p, 0, para.text)) as { ok?: boolean };
        if (ins.ok !== true) throw new Error("insertTextInCell textbox failed");
      }
      applyParaAlign(doc, at.section, paraIdx, controlIdx, 0, p, para.align);
      for (const run of para.runs ?? []) {
        applyRunFormatting(doc, at.section, paraIdx, controlIdx, 0, p, run, resolvedFonts);
      }
      prevLen = Array.from(para.text).length;
    }
  }

  if (portable.caption) populateCaption(doc, at.section, paraIdx, controlIdx, true, portable.caption, resolvedFonts);
  return { paraIdx, controlIdx };
}

function verifyPortableParagraphs(
  expected: readonly HwpxPortableParagraph[], actual: readonly HwpxPortableParagraph[] | undefined,
): void {
  if (actual?.length !== expected.length) throw new Error("portable paragraph count mismatch");
  for (const [i, source] of expected.entries()) {
    const target = actual[i]!;
    if (source.text !== target.text || source.align !== target.align || source.autoNumberOffset !== target.autoNumberOffset) {
      throw new Error("portable paragraph text, alignment or atno mismatch");
    }
    const appliedRuns = target.runs ?? [];
    let index = 0;
    for (const { start, end, ...style } of source.runs ?? []) {
      let offset = start;
      while (offset < end) {
        const applied = appliedRuns[index];
        if (!applied || applied.start > offset || applied.end <= offset
          || !(Object.keys(style) as (keyof RunStyle)[]).every(key => (key === "textColor" || key === "shadeColor"
            ? style[key]?.toLowerCase() === applied[key] : style[key] === applied[key]))) {
          throw new Error("portable character formatting mismatch");
        }
        offset = applied.end;
        if (offset <= end) index += 1;
      }
    }
  }
}

export function insertHwpxPortableObject(
  doc: RhwpDocument,
  at: { section: number; paragraph: number; offset: number },
  portable: HwpxPortableObject,
): { paraIdx: number; controlIdx: number } {
  const baseline = doc.charShapeCount?.();
  const result = createPortableObject(doc, at, portable, new Map());
  if (baseline !== undefined && doc.compactAppendedCharShapes) {
    // Run inside the same history transaction. Engine errors must reach rollback.
    const compacted = JSON.parse(doc.compactAppendedCharShapes(baseline)) as { ok?: boolean };
    if (compacted.ok !== true) throw new Error("portable character shape compaction failed");
  }
  const kind = portable.kind === "picture" ? "picture" : portable.shapeType === "textbox" ? "textBox" : "shape";
  const applied = readPortableObject(doc, [at.section, result.paraIdx, result.controlIdx], kind, false);
  if (!applied) throw new Error("portable object verification failed");
  const { caption, ...object } = portable;
  const actual = applied as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(object)) {
    if (key === "paragraphs" || (key === "kind" && value === undefined)) continue;
    if (key === "crop" || key === "cropRect" || key === "tbMargins") {
      const fields = actual[key] as Record<string, unknown> | undefined;
      if (!fields || !Object.entries(value).every(([side, n]) => fields[side] === n)) {
        throw new Error("portable object geometry mismatch");
      }
    } else if (actual[key] !== value) {
      throw new Error(`portable object property mismatch: ${key}`);
    }
  }
  if (portable.kind !== "picture" && portable.paragraphs) {
    verifyPortableParagraphs(portable.paragraphs, applied.kind === "picture" ? undefined : applied.paragraphs);
  }
  if (caption) {
    const { paragraphs, ...properties } = caption;
    const appliedCaption = applied.caption;
    if (!appliedCaption || !(Object.keys(properties) as (keyof typeof properties)[]).every(key => properties[key] === appliedCaption[key])) {
      throw new Error("portable caption properties mismatch");
    }
    verifyPortableParagraphs(paragraphs, appliedCaption.paragraphs);
  }
  return result;
}
