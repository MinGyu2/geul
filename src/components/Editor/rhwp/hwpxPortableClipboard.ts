import {
  HWPX_CAPTION_DIRECTIONS, HWPX_CAPTION_VERT_ALIGNS, HWPX_PARA_ALIGNS, HWPX_PICTURE_MIMES,
  HWPX_TB_VERTICAL_ALIGNS, HWPX_WRAP_VALUES, MAX_HWPX_PICTURE_BYTES, decodePortableImageBytes,
  type HwpxPortableCaption, type HwpxPortableCharRun, type HwpxPortableObject, type HwpxPortableParagraph,
  type HwpxPortablePictureMime, type HwpxPortableShapeType, type RichObjectKind,
} from "../../../commands/objectClipboard";
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
): RunStyle | null {
  if (!doc.getCellCharPropertiesAtByPath) return null;
  try {
    const raw = JSON.parse(doc.getCellCharPropertiesAtByPath(sec, para, pathJson, offset)) as Record<string, unknown>;
    const style: RunStyle = {};
    if (typeof raw.bold === "boolean" && raw.bold) style.bold = true;
    else if (raw.bold === false) style.bold = false;
    if (typeof raw.italic === "boolean") style.italic = raw.italic;
    if (typeof raw.underline === "boolean") style.underline = raw.underline;
    if (typeof raw.strikethrough === "boolean") style.strikethrough = raw.strikethrough;
    if (typeof raw.fontSize === "number" && Number.isSafeInteger(raw.fontSize) && raw.fontSize >= 100 && raw.fontSize <= 409_600) {
      style.fontSize = raw.fontSize;
    }
    if (typeof raw.textColor === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.textColor)) {
      style.textColor = raw.textColor.toLowerCase();
    }
    if (typeof raw.shadeColor === "string" && (raw.shadeColor === "none" || /^#[0-9a-fA-F]{6}$/.test(raw.shadeColor))) {
      style.shadeColor = raw.shadeColor === "none" ? "none" : raw.shadeColor.toLowerCase();
    }
    if (typeof raw.fontFamily === "string" && raw.fontFamily.length >= 1 && raw.fontFamily.length <= 256
      && raw.fontFamily.trim() === raw.fontFamily && !/[\x00-\x1f"\\{}\uFFFC]/.test(raw.fontFamily)) {
      style.fontFamily = raw.fontFamily;
    }
    return style;
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
  control: number,
  cellIndex: number,
  cellParaIndex: number,
  length: number,
  forbiddenOffset?: number,
): HwpxPortableCharRun[] | null {
  if (length <= 0) return [];
  const pathJson = JSON.stringify([{ controlIndex: control, cellIndex, cellParaIndex }]);
  const merged: HwpxPortableCharRun[] = [];
  const pushSpan = (start: number, end: number, style: RunStyle) => {
    if (start >= end) return;
    const prev = merged[merged.length - 1];
    if (prev && prev.end === start && sameRunStyle(prev, style)) {
      prev.end = end;
      return;
    }
    merged.push({ start, end, ...style });
  };

  if (forbiddenOffset === undefined && doc.getFormattingRunsByPath) {
    try {
      const parsed = JSON.parse(doc.getFormattingRunsByPath(sec, para, pathJson, 0, length)) as {
        runs?: [number, number, number][];
        fontRuns?: [number, number, number, number][] | null;
      };
      const spans = Array.isArray(parsed.fontRuns) ? parsed.fontRuns : parsed.runs;
      if (Array.isArray(spans) && spans.length <= 4096) {
        const byShapeId = new Map<number, RunStyle>();
        for (const span of spans) {
          const [start, end, key] = span;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > length) return null;
          let style = Array.isArray(parsed.fontRuns) ? byShapeId.get(key) : undefined;
          if (!style) {
            style = readCharStyleAt(doc, sec, para, pathJson, start) ?? undefined;
            if (!style) return null;
            if (Array.isArray(parsed.fontRuns)) byShapeId.set(key, style);
          }
          pushSpan(start, end, style);
        }
        return merged;
      }
    } catch {
      // Fall through to bounded character scan if getFormattingRunsByPath rejects inline markers.
    }
  }

  if (length > 512) return null;
  for (let offset = 0; offset < length; offset += 1) {
    if (offset === forbiddenOffset) continue;
    const style = readCharStyleAt(doc, sec, para, pathJson, offset);
    if (!style) return null;
    pushSpan(offset, offset + 1, style);
  }
  return merged;
}

function readParagraphAlign(doc: RhwpDocument, sec: number, para: number, control: number, cellIndex: number, cellParaIndex: number) {
  if (!doc.getCellParaPropertiesAtByPath) return undefined;
  try {
    const raw = JSON.parse(doc.getCellParaPropertiesAtByPath(sec, para, JSON.stringify([{ controlIndex: control, cellIndex, cellParaIndex }]))) as { alignment?: unknown };
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
    if (slot < 0 || slot >= p0Text.length || p0Text[slot] !== " ") return null;
    return { paraCount, slotInPara0: slot, para0Text: p0Text };
  } catch {
    return null;
  }
}

function extractHwpxCaption(
  doc: RhwpDocument,
  sec: number,
  para: number,
  control: number,
  isShape: boolean,
  rawProps: Record<string, unknown>,
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
  for (let p = 0; p < capInfo.paraCount; p += 1) {
    const len = doc.getCellParagraphLength(sec, para, control, cellIndex, p);
    if (!Number.isSafeInteger(len) || len < 0 || len > 65536) return undefined;
    const text = p === 0 ? capInfo.para0Text : (len > 0 ? doc.getTextInCell(sec, para, control, cellIndex, p, 0, len) : "");
    if (typeof text !== "string" || /[\r\n\uFFFC]/.test(text)) return undefined;
    const align = readParagraphAlign(doc, sec, para, control, cellIndex, p);
    const runs = readParagraphRuns(doc, sec, para, control, cellIndex, p, len, p === 0 ? capInfo.slotInPara0 : undefined);
    if (!runs) return undefined;
    paragraphs.push({
      text,
      ...(align ? { align } : {}),
      ...(runs.length > 0 ? { runs } : {}),
      ...(p === 0 ? { autoNumberOffset: capInfo.slotInPara0 } : {}),
    });
  }
  return { direction, vertAlign, width, spacing, includeMargin, paragraphs };
}

export function extractHwpxPortableObject(
  doc: RhwpDocument,
  address: readonly [number, number, number],
  kind: RichObjectKind,
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
    const borderColor = int("borderColor") ?? 0, borderWidth = int("borderWidth") ?? 0, borderType = int("borderType") ?? 0;
    const textWrap = HWPX_WRAP_VALUES.find(w => w === raw.textWrap);
    if (width === undefined || height === undefined || horzOffset === undefined || vertOffset === undefined
      || typeof raw.treatAsChar !== "boolean" || !textWrap) return undefined;
    const crop = {
      left: int("cropLeft") ?? 0, top: int("cropTop") ?? 0,
      right: int("cropRight") ?? 0, bottom: int("cropBottom") ?? 0,
    };
    const description = typeof raw.description === "string" && raw.description.length > 0 ? raw.description : undefined;
    let caption: HwpxPortableCaption | undefined;
    if (raw.hasCaption === true) {
      caption = extractHwpxCaption(doc, sec, para, control, false, raw);
      if (!caption) return undefined;
    }
    return {
      kind: "picture", mime, bytesBase64, width, height,
      naturalWidth: nat.width, naturalHeight: nat.height,
      horzOffset, vertOffset, treatAsChar: raw.treatAsChar, textWrap,
      borderColor, borderWidth, borderType, crop,
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
  if (shape.textBox) {
    shapeType = "textbox";
  } else if (owner?.userDesc === "사각형") {
    shapeType = "rectangle";
  } else if (owner?.userDesc === "타원") {
    shapeType = "ellipse";
  } else if (owner?.userDesc === "직선" || owner?.userDesc === "선") {
    shapeType = "line";
  }
  if (!shapeType) return undefined;
  if (kind === "textBox" ? shapeType !== "textbox" : shapeType === "textbox") return undefined;

  const textWrap = HWPX_WRAP_VALUES.find(w => w === shape.raw.textWrap);
  if (!textWrap || (shape.raw.fillType !== "none" && shape.raw.fillType !== "solid")) return undefined;

  let tbVerticalAlign: typeof HWPX_TB_VERTICAL_ALIGNS[number] | undefined;
  let tbMargins: { left: number; right: number; top: number; bottom: number } | undefined;
  let paragraphs: HwpxPortableParagraph[] | undefined;

  if (shapeType === "textbox") {
    if (!doc.getCellParagraphCount || !doc.getCellParagraphLength || !doc.getTextInCell || !doc.getCellInlineContextByPath) return undefined;
    tbVerticalAlign = HWPX_TB_VERTICAL_ALIGNS.find(a => a === raw.tbVerticalAlign) ?? "Top";
    const int = (key: string) => Number.isSafeInteger(raw[key]) ? raw[key] as number : 0;
    tbMargins = {
      left: int("tbMarginLeft"), right: int("tbMarginRight"),
      top: int("tbMarginTop"), bottom: int("tbMarginBottom"),
    };
    const count = doc.getCellParagraphCount(sec, para, control, 0);
    if (!Number.isSafeInteger(count) || count < 1 || count > 1024) return undefined;
    paragraphs = [];
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
      if (typeof text !== "string" || /[\r\n\uFFFC]/.test(text)) return undefined;
      const align = readParagraphAlign(doc, sec, para, control, 0, p);
      const runs = readParagraphRuns(doc, sec, para, control, 0, p, len);
      if (!runs) return undefined;
      paragraphs.push({
        text,
        ...(align ? { align } : {}),
        ...(runs.length > 0 ? { runs } : {}),
      });
    }
  }

  let caption: HwpxPortableCaption | undefined;
  if (shape.hasCaption) {
    caption = extractHwpxCaption(doc, sec, para, control, true, raw);
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
  offsetShift = 0,
) {
  if (!doc.applyCharFormatInCellByPath) throw new Error("applyCharFormatInCellByPath unavailable");
  const start = run.start + offsetShift;
  const end = run.end + offsetShift;
  if (start >= end) return;
  const props: Record<string, unknown> = {};
  if (run.bold !== undefined) props.bold = run.bold;
  if (run.italic !== undefined) props.italic = run.italic;
  if (run.underline !== undefined) props.underline = run.underline;
  if (run.strikethrough !== undefined) props.strikethrough = run.strikethrough;
  if (run.fontSize !== undefined) props.fontSize = run.fontSize;
  if (run.textColor !== undefined) props.textColor = run.textColor;
  if (run.shadeColor !== undefined) props.shadeColor = run.shadeColor;
  if (run.fontFamily !== undefined && doc.resolveDocumentFontFamily) {
    try {
      const fontIds = JSON.parse(doc.resolveDocumentFontFamily(run.fontFamily)) as unknown;
      if (Array.isArray(fontIds) && fontIds.length === 7) props.fontIds = fontIds;
    } catch {
      // Keep destination's default font if destination's font table cannot resolve custom family.
    }
  }
  if (Object.keys(props).length === 0) return;
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
  align: string | undefined,
) {
  if (!align) return;
  const pathJson = JSON.stringify([{ controlIndex: controlIdx, cellIndex, cellParaIndex }]);
  if (doc.applyParaFormatInCellByPath) {
    const res = JSON.parse(doc.applyParaFormatInCellByPath(sec, paraIdx, pathJson, JSON.stringify({ alignment: align }))) as { ok?: boolean };
    if (res.ok !== true) throw new Error("applyParaFormatInCellByPath failed");
  } else if (doc.applyParaFormatInCell) {
    const res = JSON.parse(doc.applyParaFormatInCell(sec, paraIdx, controlIdx, cellIndex, cellParaIndex, JSON.stringify({ alignment: align }))) as { ok?: boolean };
    if (res.ok !== true) throw new Error("applyParaFormatInCell failed");
  }
}

function populateCaption(
  doc: RhwpDocument,
  sec: number,
  paraIdx: number,
  controlIdx: number,
  isShape: boolean,
  caption: HwpxPortableCaption,
) {
  if (!doc.insertTextInCell || !doc.deleteTextInCell || !doc.splitParagraphInCell) {
    throw new Error("caption cell APIs unavailable");
  }
  const cellIndex = isShape ? 65534 : 0;
  const slotInfo = findCaptionAtnoSlots(doc, sec, paraIdx, controlIdx, isShape);
  if (!slotInfo) throw new Error("destination caption atno slot missing");

  const p0 = caption.paragraphs[0]!;
  const srcSlot = p0.autoNumberOffset!;
  const srcPrefix = p0.text.slice(0, srcSlot);
  const rawSuffix = p0.text.slice(srcSlot + 1);
  const dstPrefix = slotInfo.para0Text.slice(0, slotInfo.slotInPara0);
  // RHWP initializes an in-memory caption as `"그림 " + atno`, whereas reopened HWPX parses
  // `"그림" + atno + " "`. Preserving the `"그림 "` prefix + trailing space avoids an extra space on save/reopen.
  const keepSpaceTransition = srcPrefix + " " === dstPrefix && rawSuffix.startsWith(" ");
  const srcSuffix = keepSpaceTransition ? rawSuffix.slice(1) : rawSuffix;
  let curSlot = slotInfo.slotInPara0;
  const afterLen = slotInfo.para0Text.length - (curSlot + 1);
  if (afterLen > 0) {
    const res = JSON.parse(doc.deleteTextInCell(sec, paraIdx, controlIdx, cellIndex, 0, curSlot + 1, afterLen)) as { ok?: boolean };
    if (res.ok !== true) throw new Error("deleteTextInCell suffix failed");
  }
  if (!keepSpaceTransition && curSlot > 0 && dstPrefix !== srcPrefix) {
    const res = JSON.parse(doc.deleteTextInCell(sec, paraIdx, controlIdx, cellIndex, 0, 0, curSlot)) as { ok?: boolean };
    if (res.ok !== true) throw new Error("deleteTextInCell prefix failed");
    curSlot = 0;
  }
  if (curSlot === 0 && srcPrefix.length > 0) {
    const res = JSON.parse(doc.insertTextInCell(sec, paraIdx, controlIdx, cellIndex, 0, 0, srcPrefix)) as { ok?: boolean };
    if (res.ok !== true) throw new Error("insertTextInCell prefix failed");
    curSlot = srcPrefix.length;
  }
  if (srcSuffix.length > 0) {
    const res = JSON.parse(doc.insertTextInCell(sec, paraIdx, controlIdx, cellIndex, 0, curSlot + 1, srcSuffix)) as { ok?: boolean };
    if (res.ok !== true) throw new Error("insertTextInCell suffix failed");
  }
  const suffixShift = keepSpaceTransition ? curSlot - srcSlot - 1 : curSlot - srcSlot;
  applyParaAlign(doc, sec, paraIdx, controlIdx, cellIndex, 0, p0.align);
  for (const run of p0.runs ?? []) {
    if (run.end <= srcSlot) {
      applyRunFormatting(doc, sec, paraIdx, controlIdx, cellIndex, 0, run, 0);
    } else if (run.start > srcSlot) {
      const shiftedStart = Math.max(curSlot + 1, run.start + suffixShift);
      const shiftedEnd = run.end + suffixShift;
      if (shiftedStart < shiftedEnd) {
        applyRunFormatting(doc, sec, paraIdx, controlIdx, cellIndex, 0, { ...run, start: shiftedStart, end: shiftedEnd }, 0);
      }
    }
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
      applyRunFormatting(doc, sec, paraIdx, controlIdx, cellIndex, p, run);
    }
    prevLen = para.text.length;
  }
}

export function insertHwpxPortableObject(
  doc: RhwpDocument,
  at: { section: number; paragraph: number; offset: number },
  portable: HwpxPortableObject,
): { paraIdx: number; controlIdx: number } {
  const charBaseline = doc.charShapeCount?.();
  try {
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
        borderColor: portable.borderColor,
        borderWidth: portable.borderWidth,
        borderType: portable.borderType,
        cropLeft: portable.crop.left,
        cropTop: portable.crop.top,
        cropRight: portable.crop.right,
        cropBottom: portable.crop.bottom,
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
      if (portable.caption) populateCaption(doc, at.section, paraIdx, controlIdx, false, portable.caption);
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
      rotationAngle: portable.rotationAngle,
      horzFlip: portable.horzFlip,
      vertFlip: portable.vertFlip,
      borderColor: portable.borderColor,
      borderWidth: portable.borderWidth,
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
          applyRunFormatting(doc, at.section, paraIdx, controlIdx, 0, p, run);
        }
        prevLen = para.text.length;
      }
    }

    if (portable.caption) populateCaption(doc, at.section, paraIdx, controlIdx, true, portable.caption);
    return { paraIdx, controlIdx };
  } finally {
    if (charBaseline !== undefined && doc.compactAppendedCharShapes) {
      try { doc.compactAppendedCharShapes(charBaseline); } catch { /* best-effort compaction */ }
    }
  }
}
