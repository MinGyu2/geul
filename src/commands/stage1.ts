// Stage 1 common document editing: shared command semantics for paragraph alignment, character size/color/
// highlight/script, paragraph spacing and indents, lists, page setup and find/replace. Engines report their
// actual state through the session snapshot; this module only defines the values, their validation (shared by
// the UI and the session immediately before mutation) and the snapshot shapes. It never stores document state.

/** Paragraph alignment command → value. */
export type ParagraphAlign = "left" | "center" | "right" | "justify";
export const ALIGN_COMMANDS = {
  "paragraph.alignLeft": "left",
  "paragraph.alignCenter": "center",
  "paragraph.alignRight": "right",
  "paragraph.justify": "justify",
} as const satisfies Record<string, ParagraphAlign>;
export type AlignCommandId = keyof typeof ALIGN_COMMANDS;

export type ScriptCommandId = "format.superscript" | "format.subscript";

export type ListActionCommandId =
  | "paragraph.numbering" | "paragraph.multilevel" | "paragraph.increaseIndent" | "paragraph.decreaseIndent"
  | "paragraph.restartNumbering" | "paragraph.continueNumbering";

export type Stage1ActionCommandId = AlignCommandId | ScriptCommandId | ListActionCommandId;

export const STAGE1_ACTIONS: readonly Stage1ActionCommandId[] = [
  "paragraph.alignLeft", "paragraph.alignCenter", "paragraph.alignRight", "paragraph.justify",
  "format.superscript", "format.subscript",
  "paragraph.numbering", "paragraph.multilevel", "paragraph.increaseIndent", "paragraph.decreaseIndent",
  "paragraph.restartNumbering", "paragraph.continueNumbering",
];

/** Line spacing: multiple of single spacing, or at least / exactly a number of points. */
export type LineSpacing = { rule: "multiple" | "atLeast" | "exactly"; value: number };

/** Paragraph formatting request: only the given fields change (points; negative first-line = hanging). */
export interface ParagraphFormatArgs {
  lineSpacing?: LineSpacing;
  spaceBefore?: number;
  spaceAfter?: number;
  indentLeft?: number;
  indentRight?: number;
  indentFirst?: number;
}

export const LIST_STYLES = [
  "numbered", "numberedParen", "upperLetter", "lowerLetter", "lowerRoman", "outline", "multilevel",
  "bulletCircle", "bulletSquare", "bulletDash", "bulletCheck",
] as const;
export type ListStyle = (typeof LIST_STYLES)[number];

export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 48, 72] as const;
export const FONT_SIZE_RANGE = { min: 1, max: 1638 } as const;
/** Font colors offered (`RRGGBB`) plus "auto" (automatic/default color). */
export const FONT_COLORS = ["auto", "000000", "C00000", "FF0000", "FFC000", "00B050", "0070C0", "002060", "7030A0", "808080"] as const;
/** Highlight colors (WordprocessingML names; RHWP uses the same RGB as character shading) plus "none". */
export const HIGHLIGHT_COLORS = {
  yellow: "FFFF00", green: "00FF00", cyan: "00FFFF", magenta: "FF00FF", red: "FF0000", lightGray: "C0C0C0", none: null,
} as const satisfies Record<string, string | null>;
export type HighlightColor = keyof typeof HIGHLIGHT_COLORS;

export const PAPER_NAMES = ["A3", "A4", "A5", "B4 (JIS)", "B5 (JIS)", "Letter", "Legal"] as const;
export type PaperName = (typeof PAPER_NAMES)[number];
export const MAX_COLUMNS = 12;
export const MAX_LENGTH_PT = 1584;

export interface ListState { bullets: boolean; numbering: boolean; multilevel: boolean; level: number }

/** The selection's paragraph formatting. null values: mixed across the selection (never invented). */
export interface ParagraphState {
  align: ParagraphAlign | null;
  lineSpacing: LineSpacing | null;
  spaceBefore: number | null;
  spaceAfter: number | null;
  indentLeft: number | null;
  indentRight: number | null;
  indentFirst: number | null;
  list: ListState | null;
}

/** Character formatting beyond the four flags. null: mixed (or not reported). */
export interface CharState {
  size: number | null;
  /** `RRGGBB` or "auto". */
  color: string | null;
  /** `RRGGBB`; null when none or mixed. */
  highlight: string | null;
  /** null: mixed across the selection (pressed state is shown only when uniformly true). */
  superscript: boolean | null;
  subscript: boolean | null;
}

export interface PageState {
  width: number;
  height: number;
  landscape: boolean;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  columns: number;
  columnSpace: number;
  paper: PaperName | null;
}

export interface SearchOptions { text: string; matchCase: boolean; wholeWord: boolean }

/** Search state of the open search: current match count and the selected match (0-based). `complete: false` means the
 * engine could not enumerate every match within its bound: the count is a lower bound and replace-all is refused. */
export interface SearchState extends SearchOptions {
  count: number; current: number | null; complete?: boolean;
  /** Engine bound for replace-all (refused as a whole above it, never partial). Absent: no bound. */
  replaceAllLimit?: number;
}

export type SearchRequest =
  | { kind: "find"; query: SearchOptions; backward: boolean }
  | { kind: "replace"; query: SearchOptions; with: string }
  | { kind: "replaceAll"; query: SearchOptions; with: string }
  | { kind: "clear" };

export const MAX_SEARCH_CHARS = 256;
export const MAX_REPLACE_CHARS = 4096;

/** Search text accepted by both engines: non-empty, bounded, no control characters or object placeholders. */
export function searchTextProblem(text: string, allowEmpty = false, max = MAX_SEARCH_CHARS): "empty" | "tooLong" | "characters" | null {
  if (!allowEmpty && text === "") return "empty";
  if (Array.from(text).length > max) return "tooLong";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\ufffc\u2029]/.test(text)) return "characters";
  return null;
}

export function validSearchRequest(request: SearchRequest): boolean {
  if (request.kind === "clear") return true;
  const { query } = request;
  if (typeof query?.text !== "string" || typeof query.matchCase !== "boolean" || typeof query.wholeWord !== "boolean") return false;
  if (searchTextProblem(query.text) !== null) return false;
  if (request.kind === "find") return typeof request.backward === "boolean";
  return typeof request.with === "string" && searchTextProblem(request.with, true, MAX_REPLACE_CHARS) === null;
}

const finiteIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

export function validParagraphFormat(format: unknown): format is ParagraphFormatArgs {
  if (typeof format !== "object" || format === null) return false;
  const value = format as Record<string, unknown>;
  const allowed = ["lineSpacing", "spaceBefore", "spaceAfter", "indentLeft", "indentRight", "indentFirst"];
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !allowed.includes(key))) return false;
  if (value.lineSpacing !== undefined) {
    const line = value.lineSpacing as Record<string, unknown> | null;
    if (typeof line !== "object" || line === null || Object.keys(line).sort().join(",") !== "rule,value") return false;
    if (line.rule === "multiple" ? !finiteIn(line.value, 0.5, 10)
      : line.rule === "atLeast" || line.rule === "exactly" ? !finiteIn(line.value, 1, MAX_LENGTH_PT) : true) return false;
  }
  for (const key of ["spaceBefore", "spaceAfter"]) if (value[key] !== undefined && !finiteIn(value[key], 0, MAX_LENGTH_PT)) return false;
  for (const key of ["indentLeft", "indentRight", "indentFirst"])
    if (value[key] !== undefined && !finiteIn(value[key], -MAX_LENGTH_PT, MAX_LENGTH_PT)) return false;
  return true;
}

/** Stage 1 parameter command arguments (value shapes shared by the UI and the sessions). */
export type Stage1Args =
  | { command: "format.fontSize"; size: number }
  | { command: "format.fontColor"; color: string }
  | { command: "format.highlight"; color: HighlightColor }
  | { command: "paragraph.listStyle"; style: ListStyle }
  | { command: "paragraph.settings"; format: ParagraphFormatArgs }
  | { command: "layout.margins"; top: number; bottom: number; left: number; right: number }
  | { command: "layout.orientation"; landscape: boolean }
  | { command: "layout.size"; name: PaperName }
  | { command: "layout.columns"; count: number; space: number };

export type Stage1ParameterCommandId = Stage1Args["command"];
export const STAGE1_PARAMETERS: readonly Stage1ParameterCommandId[] = [
  "format.fontSize", "format.fontColor", "format.highlight", "paragraph.listStyle", "paragraph.settings",
  "layout.margins", "layout.orientation", "layout.size", "layout.columns",
];
/** Parameter commands whose values are chosen in a dialog (the others are ribbon value pickers). */
export const STAGE1_DIALOGS: readonly Stage1ParameterCommandId[] = ["paragraph.settings", "layout.margins"];

export function validStage1Args(command: string, args: Record<string, unknown>): boolean {
  const keys = Object.keys(args).sort().join(",");
  switch (command) {
    case "format.fontSize":
      return keys === "command,size" && finiteIn(args.size, FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max);
    case "format.fontColor":
      return keys === "color,command" && typeof args.color === "string" && (args.color === "auto" || /^[0-9A-F]{6}$/.test(args.color));
    case "format.highlight":
      return keys === "color,command" && typeof args.color === "string" && Object.prototype.hasOwnProperty.call(HIGHLIGHT_COLORS, args.color);
    case "paragraph.listStyle":
      return keys === "command,style" && (LIST_STYLES as readonly unknown[]).includes(args.style);
    case "paragraph.settings":
      return keys === "command,format" && validParagraphFormat(args.format);
    case "layout.margins":
      return keys === "bottom,command,left,right,top"
        && [args.top, args.bottom, args.left, args.right].every((v) => finiteIn(v, 0, MAX_LENGTH_PT));
    case "layout.orientation":
      return keys === "command,landscape" && typeof args.landscape === "boolean";
    case "layout.size":
      return keys === "command,name" && (PAPER_NAMES as readonly unknown[]).includes(args.name);
    case "layout.columns":
      return keys === "command,count,space" && Number.isSafeInteger(args.count) && finiteIn(args.count, 1, MAX_COLUMNS)
        && finiteIn(args.space, 0, 300);
    default:
      return false;
  }
}

/** Points ↔ millimetres for the dialogs (documents store points/twips; the UI shows millimetres). */
export const PT_PER_MM = 72 / 25.4;
export const toMm = (pt: number) => Math.round((pt / PT_PER_MM) * 10) / 10;
export const fromMm = (mm: number) => mm * PT_PER_MM;
