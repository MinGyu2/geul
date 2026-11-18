import { MAX_OBJECT_CLIPBOARD_BYTES, OBJECT_CLIPBOARD_MIME, objectClipboardPlainText, parseObjectClipboardPayload } from "./objectClipboard";
/**
 * Validated common structural clipboard representation for multi-cell table copy, cut, and paste
 * across DOCX (WordCraft) and HWP/HWPX (RHWP).
 *
 * Payloads crossing clipboard boundaries are treated as untrusted input: schema, bounds,
 * rectangular grid coverage, text validity, and formatting values are strictly validated
 * before any document mutation occurs.
 */
import { validClipboardText } from "./clipboard";

export const TABLE_CLIPBOARD_MIME = "application/x-geul-table-cells+json";
export const MAX_TABLE_CLIPBOARD_ROWS = 512;
export const MAX_TABLE_CLIPBOARD_COLS = 64;
export const MAX_TABLE_CLIPBOARD_CELLS = 4096;
export const MAX_TABLE_CLIPBOARD_BYTES = 2 * 1024 * 1024;
export const MAX_TABLE_CLIPBOARD_PARAGRAPHS_PER_CELL = 256;
export const MAX_TABLE_CLIPBOARD_RUNS_PER_PARAGRAPH = 1024;

export type TableClipboardSourceFormat = "docx" | "hwpx" | "hwp";
export type TableClipboardHAlign = "left" | "center" | "right" | "justify";
export type TableClipboardVAlign = "top" | "middle" | "bottom";

export interface TableClipboardBorderEdge {
  style: string;
  widthPt: number;
  color: string | null;
}

export interface TableClipboardCellBorders {
  top?: TableClipboardBorderEdge;
  bottom?: TableClipboardBorderEdge;
  left?: TableClipboardBorderEdge;
  right?: TableClipboardBorderEdge;
}

export interface TableClipboardRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontFamily?: string;
  fontSizePt?: number;
  color?: string;
  highlight?: string | null;
}

export interface TableClipboardParagraph {
  align?: TableClipboardHAlign | null;
  runs: TableClipboardRun[];
}

export interface TableClipboardCellFormatting {
  shadingColor?: string | null;
  verticalAlign?: TableClipboardVAlign | null;
  borders?: TableClipboardCellBorders;
}

export interface TableClipboardCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  paragraphs: TableClipboardParagraph[];
  formatting?: TableClipboardCellFormatting;
}

export interface TableCellClipboardPayload {
  kind: "geul.tableCells";
  version: 1;
  sourceFormat: TableClipboardSourceFormat;
  rows: number;
  cols: number;
  cells: TableClipboardCell[];
  plainText: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const HEX_COLOR = /^#[0-9A-F]{6}$/;
const BORDER_SIDES = ["top", "bottom", "left", "right"] as const;
const H_ALIGNS = new Set<string>(["left", "center", "right", "justify"]);
const V_ALIGNS = new Set<string>(["top", "middle", "bottom"]);
const SOURCE_FORMATS = new Set<string>(["docx", "hwpx", "hwp"]);
const ALLOWED_BORDER_STYLES = new Set<string>([
  "single", "double", "dotted", "dashed", "thick", "triple", "dotDash", "wave", "none",
  "dashDotDot", "longDash", "circle", "thinThick", "thickThin", "doubleWave",
  "thick3d", "thick3dRev", "thin3d", "thin3dRev",
]);

function normalizeHex(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().toUpperCase();
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return HEX_COLOR.test(withHash) ? withHash : undefined;
}

/** Canonical TSV plain-text representation of a validated cell grid (non-empty for >= 2 cells). */
export function buildTableClipboardPlainText(rows: number, cols: number, cells: readonly TableClipboardCell[]): string {
  const byCoord = new Map<string, TableClipboardCell>();
  for (const cell of cells) byCoord.set(`${cell.row},${cell.col}`, cell);
  const rowStrings: string[] = [];
  for (let r = 0; r < rows; r++) {
    const colStrings: string[] = [];
    for (let c = 0; c < cols; c++) {
      const cell = byCoord.get(`${r},${c}`);
      if (!cell) {
        colStrings.push("");
        continue;
      }
      const paraTexts = cell.paragraphs.map((p) => p.runs.map((run) => run.text).join(""));
      colStrings.push(paraTexts.join(" "));
    }
    rowStrings.push(colStrings.join("\t"));
  }
  return rowStrings.join("\n");
}

function parseBorderEdge(raw: unknown): TableClipboardBorderEdge | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.style !== "string" || !ALLOWED_BORDER_STYLES.has(raw.style)) return null;
  if (typeof raw.widthPt !== "number" || !Number.isFinite(raw.widthPt) || raw.widthPt < 0 || raw.widthPt > 48) return null;
  const color = raw.color === undefined ? null : normalizeHex(raw.color);
  if (color === undefined) return null;
  return { style: raw.style, widthPt: Math.round(raw.widthPt * 100) / 100, color };
}

function parseRun(raw: unknown): TableClipboardRun | null {
  if (!isRecord(raw) || typeof raw.text !== "string") return null;
  if (/[\r\n]/.test(raw.text) || !validClipboardText(raw.text)) return null;
  const out: TableClipboardRun = { text: raw.text };
  for (const flag of ["bold", "italic", "underline", "strikethrough"] as const) {
    if (raw[flag] !== undefined) {
      if (typeof raw[flag] !== "boolean") return null;
      if (raw[flag]) out[flag] = true;
    }
  }
  if (raw.fontFamily !== undefined) {
    if (typeof raw.fontFamily !== "string") return null;
    const fam = raw.fontFamily.trim();
    if (!fam || fam.length > 128) return null;
    out.fontFamily = fam;
  }
  if (raw.fontSizePt !== undefined) {
    if (typeof raw.fontSizePt !== "number" || !Number.isFinite(raw.fontSizePt) || raw.fontSizePt < 1 || raw.fontSizePt > 1638) {
      return null;
    }
    out.fontSizePt = Math.round(raw.fontSizePt * 100) / 100;
  }
  if (raw.color !== undefined) {
    const color = normalizeHex(raw.color);
    if (!color) return null;
    out.color = color;
  }
  if (raw.highlight !== undefined) {
    const highlight = normalizeHex(raw.highlight);
    if (highlight === undefined) return null;
    out.highlight = highlight;
  }
  return out;
}

function parseParagraph(raw: unknown): TableClipboardParagraph | null {
  if (!isRecord(raw) || !Array.isArray(raw.runs) || raw.runs.length > MAX_TABLE_CLIPBOARD_RUNS_PER_PARAGRAPH) return null;
  let align: TableClipboardHAlign | null | undefined;
  if (raw.align !== undefined) {
    if (raw.align === null) align = null;
    else if (typeof raw.align === "string" && H_ALIGNS.has(raw.align)) align = raw.align as TableClipboardHAlign;
    else return null;
  }
  const runs: TableClipboardRun[] = [];
  for (const r of raw.runs) {
    const parsed = parseRun(r);
    if (!parsed) return null;
    runs.push(parsed);
  }
  return { ...(align !== undefined ? { align } : {}), runs };
}

function parseFormatting(raw: unknown): TableClipboardCellFormatting | null {
  if (!isRecord(raw)) return null;
  const out: TableClipboardCellFormatting = {};
  if (raw.shadingColor !== undefined) {
    const c = normalizeHex(raw.shadingColor);
    if (c === undefined) return null;
    out.shadingColor = c;
  }
  if (raw.verticalAlign !== undefined) {
    if (raw.verticalAlign === null) out.verticalAlign = null;
    else if (typeof raw.verticalAlign === "string" && V_ALIGNS.has(raw.verticalAlign)) {
      out.verticalAlign = raw.verticalAlign as TableClipboardVAlign;
    } else return null;
  }
  if (raw.borders !== undefined) {
    if (!isRecord(raw.borders)) return null;
    const borders: TableClipboardCellBorders = {};
    for (const side of BORDER_SIDES) {
      if (raw.borders[side] !== undefined) {
        const edge = parseBorderEdge(raw.borders[side]);
        if (!edge) return null;
        borders[side] = edge;
      }
    }
    out.borders = borders;
  }
  return out;
}

/**
 * Strictly validate an untrusted structural table-cell payload (object or JSON string).
 * Rejects oversized payloads, invalid geometry, overlaps/gaps, invalid text, and malformed properties.
 */
export function parseTableClipboardPayload(input: unknown): TableCellClipboardPayload | null {
  let raw: unknown = input;
  if (typeof input === "string") {
    if (input.length === 0 || input.length > MAX_TABLE_CLIPBOARD_BYTES) return null;
    try { raw = JSON.parse(input); } catch { return null; }
  }
  if (!isRecord(raw)) return null;
  if (raw.kind !== "geul.tableCells" || raw.version !== 1) return null;
  if (typeof raw.sourceFormat !== "string" || !SOURCE_FORMATS.has(raw.sourceFormat)) return null;
  if (!isInt(raw.rows, 1, MAX_TABLE_CLIPBOARD_ROWS) || !isInt(raw.cols, 1, MAX_TABLE_CLIPBOARD_COLS)) return null;
  const rows: number = raw.rows;
  const cols: number = raw.cols;
  if (rows * cols < 2 || rows * cols > MAX_TABLE_CLIPBOARD_CELLS) return null;
  if (!Array.isArray(raw.cells) || raw.cells.length < 2 || raw.cells.length > rows * cols) return null;

  const covered = Array.from({ length: rows }, () => new Uint8Array(cols));
  const cells: TableClipboardCell[] = [];
  for (const item of raw.cells) {
    if (!isRecord(item)) return null;
    if (!isInt(item.row, 0, rows - 1) || !isInt(item.col, 0, cols - 1)) return null;
    if (!isInt(item.rowSpan, 1, rows - item.row) || !isInt(item.colSpan, 1, cols - item.col)) return null;
    if (!Array.isArray(item.paragraphs) || item.paragraphs.length < 1 || item.paragraphs.length > MAX_TABLE_CLIPBOARD_PARAGRAPHS_PER_CELL) {
      return null;
    }
    for (let r = item.row; r < item.row + item.rowSpan; r++) {
      for (let c = item.col; c < item.col + item.colSpan; c++) {
        if (covered[r]![c] !== 0) return null;
        covered[r]![c] = 1;
      }
    }
    const paragraphs: TableClipboardParagraph[] = [];
    for (const p of item.paragraphs) {
      const parsed = parseParagraph(p);
      if (!parsed) return null;
      paragraphs.push(parsed);
    }
    let formatting: TableClipboardCellFormatting | undefined;
    if (item.formatting !== undefined) {
      const parsed = parseFormatting(item.formatting);
      if (!parsed) return null;
      formatting = parsed;
    }
    cells.push({
      row: item.row,
      col: item.col,
      rowSpan: item.rowSpan,
      colSpan: item.colSpan,
      paragraphs,
      ...(formatting ? { formatting } : {}),
    });
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (covered[r]![c] !== 1) return null;
    }
  }
  const plainText = buildTableClipboardPlainText(rows, cols, cells);
  if (!plainText || !validClipboardText(plainText)) return null;
  if (typeof raw.plainText === "string" && raw.plainText.replace(/\r\n/g, "\n") !== plainText) {
    return null;
  }
  const normalized: TableCellClipboardPayload = {
    kind: "geul.tableCells",
    version: 1,
    sourceFormat: raw.sourceFormat as TableClipboardSourceFormat,
    rows,
    cols,
    cells,
    plainText,
  };
  if (JSON.stringify(normalized).length > MAX_TABLE_CLIPBOARD_BYTES) return null;
  return normalized;
}

/**
 * Bounded in-app structured clipboard store, bound to the OS clipboard's plain-text content.
 * Used when the host runtime clipboard only transports plain text (e.g., Linux WebKitGTK).
 * If the OS clipboard plain text changes externally (or is cleared), the stored structured
 * entry is invalidated and ignored.
 */
let storedStructuredClipboard: { mime: string; data: string; plainText: string } | null = null;
/** Changes whenever the stored entry is replaced, invalidated or cleared (identity for async callers). */
let storedStructuredVersion = 0;
export const structuredClipboardVersion = (): number => storedStructuredVersion;

export function rememberStructuredClipboard(mime: string, data: string, plainText: string): boolean {
  if (!plainText || !validClipboardText(plainText)) return false;
  if (mime === TABLE_CLIPBOARD_MIME) {
    if (data.length > MAX_TABLE_CLIPBOARD_BYTES || !parseTableClipboardPayload(data)) return false;
  } else if (mime === OBJECT_CLIPBOARD_MIME) {
    if (data.length > MAX_OBJECT_CLIPBOARD_BYTES) return false;
    const shape = parseObjectClipboardPayload(data);
    if (!shape || objectClipboardPlainText(shape) !== plainText) return false;
  } else return false;
  storedStructuredClipboard = { mime, data, plainText: plainText.replace(/\r\n/g, "\n") };
  storedStructuredVersion += 1;
  return true;
}

export function recallStructuredClipboard(mime: string, observedPlainText: string): string | null {
  if (!storedStructuredClipboard || mime !== storedStructuredClipboard.mime) return null;
  if (observedPlainText.replace(/\r\n/g, "\n") !== storedStructuredClipboard.plainText) {
    storedStructuredClipboard = null;
    storedStructuredVersion += 1;
    return null;
  }
  return storedStructuredClipboard.data;
}

export function clearStructuredClipboard(): void {
  storedStructuredClipboard = null;
  storedStructuredVersion += 1;
}

/** Nearest RHWP border width (mm) for a point value. */
export function ptToNearestRhwpMm(widthPt: number): number {
  const mm = widthPt * 25.4 / 72;
  const choices = [0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0];
  let best = choices[0]!;
  let bestDiff = Math.abs(mm - best);
  for (const c of choices) {
    const d = Math.abs(mm - c);
    if (d < bestDiff) { best = c; bestDiff = d; }
  }
  return best;
}

export function rhwpMmToPt(mm: number): number {
  return Math.round((mm * 72 / 25.4) * 100) / 100;
}
