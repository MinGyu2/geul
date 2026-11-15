// Stage 5-A font catalog client: font_catalog, font_refresh, font_register, font_remove, font_user_face.
//
// The backend owns the font system (src-tauri/src/fonts/): one process-wide font database shared with the WordCraft
// layout/PDF engine. Responses cross a trust boundary and are checked strictly; any mismatch is a protocol error. No
// command takes a path: registration opens the backend's native chooser.
import type { Invoke } from "./backend";

export type FontSource = "system" | "user" | "bundled";

export interface FontStyle {
  name: string;
  weight: number;
  italic: boolean;
}

export interface FontFamily {
  id: string;
  family: string;
  localized: { lang: string; name: string }[];
  styles: FontStyle[];
  source: FontSource;
  available: boolean;
  renderable: boolean;
}

export interface UserFontFile {
  id: string;
  families: string[];
  faces: { family: string; style: string }[];
  persisted: boolean;
}

export interface FontStatus {
  provider: string;
  fontconfigAvailable: boolean;
  fontconfigVersion: string | null;
  fontconfigError: string | null;
  systemFaces: number;
  generation: number;
  userFontStorage: boolean;
  skippedUserFonts: string[];
}

export interface FontCatalog {
  status: FontStatus;
  families: FontFamily[];
  generics: { generic: string; family: string | null }[];
  userFonts: UserFontFile[];
}

export interface FontRegistered {
  font: UserFontFile;
  storageFailed: boolean;
  catalog: FontCatalog;
}

export type FontErrorCode =
  | "UnsupportedFont" | "DamagedFont" | "FontTooLarge" | "AlreadyAvailable" | "TooManyFonts" | "NotUserFont"
  | "PlatformUnsupported" | "InvalidRequest" | "Internal" | "Protocol";

export type FontResult<T> = { ok: true; value: T } | { ok: false; error: FontErrorCode };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const MAX_FAMILIES = 100_000;

function parseStyle(v: unknown): FontStyle | null {
  if (!isRecord(v) || !str(v.name, 512) || !count(v.weight) || v.weight > 1000 || typeof v.italic !== "boolean") return null;
  return { name: v.name, weight: v.weight, italic: v.italic };
}

function parseFamily(v: unknown): FontFamily | null {
  if (!isRecord(v) || !str(v.id, 1024) || !str(v.family, 512) || !Array.isArray(v.localized) || !Array.isArray(v.styles)) return null;
  if (v.source !== "system" && v.source !== "user" && v.source !== "bundled") return null;
  if (typeof v.available !== "boolean" || typeof v.renderable !== "boolean") return null;
  const localized: FontFamily["localized"] = [];
  for (const l of v.localized) {
    if (!isRecord(l) || !str(l.lang, 64) || !str(l.name, 512)) return null;
    localized.push({ lang: l.lang, name: l.name });
  }
  const styles = v.styles.map(parseStyle);
  if (styles.some((s) => s === null)) return null;
  return { id: v.id, family: v.family, localized, styles: styles as FontStyle[], source: v.source, available: v.available, renderable: v.renderable };
}

function parseUserFont(v: unknown): UserFontFile | null {
  if (!isRecord(v) || !str(v.id, 512) || !Array.isArray(v.families) || !Array.isArray(v.faces) || typeof v.persisted !== "boolean") return null;
  if (!v.families.every((f) => str(f, 512))) return null;
  const faces: UserFontFile["faces"] = [];
  for (const f of v.faces) {
    if (!isRecord(f) || !str(f.family, 512) || !str(f.style, 512)) return null;
    faces.push({ family: f.family, style: f.style });
  }
  return { id: v.id, families: v.families as string[], faces, persisted: v.persisted };
}

function parseStatus(v: unknown): FontStatus | null {
  if (!isRecord(v) || !str(v.provider, 64) || typeof v.fontconfigAvailable !== "boolean" || !count(v.systemFaces)
    || !count(v.generation) || typeof v.userFontStorage !== "boolean" || !Array.isArray(v.skippedUserFonts)) return null;
  const optional = (x: unknown) => x === null || x === undefined ? null : str(x) ? x : undefined;
  const version = optional(v.fontconfigVersion), error = optional(v.fontconfigError);
  if (version === undefined || error === undefined || !v.skippedUserFonts.every((f) => str(f, 512))) return null;
  return {
    provider: v.provider, fontconfigAvailable: v.fontconfigAvailable, fontconfigVersion: version, fontconfigError: error,
    systemFaces: v.systemFaces, generation: v.generation, userFontStorage: v.userFontStorage, skippedUserFonts: v.skippedUserFonts as string[],
  };
}

export function parseFontCatalog(v: unknown): FontCatalog | null {
  if (!isRecord(v) || !Array.isArray(v.families) || v.families.length > MAX_FAMILIES || !Array.isArray(v.generics) || !Array.isArray(v.userFonts)) return null;
  const status = parseStatus(v.status);
  const families = v.families.map(parseFamily);
  const userFonts = v.userFonts.map(parseUserFont);
  const generics: FontCatalog["generics"] = [];
  for (const g of v.generics) {
    if (!isRecord(g) || !str(g.generic, 64) || !(g.family === null || str(g.family, 512))) return null;
    generics.push({ generic: g.generic, family: g.family as string | null });
  }
  if (!status || families.some((f) => f === null) || userFonts.some((f) => f === null)) return null;
  return { status, families: families as FontFamily[], generics, userFonts: userFonts as UserFontFile[] };
}

function parseRegistered(v: unknown): FontRegistered | null {
  if (!isRecord(v) || typeof v.storageFailed !== "boolean") return null;
  const font = parseUserFont(v.font), catalog = parseFontCatalog(v.catalog);
  return font && catalog ? { font, storageFailed: v.storageFailed, catalog } : null;
}

const CODES: readonly FontErrorCode[] = ["UnsupportedFont", "DamagedFont", "FontTooLarge", "AlreadyAvailable", "TooManyFonts", "NotUserFont",
  "PlatformUnsupported", "InvalidRequest", "Internal"];

async function call<T>(invoke: Invoke, command: string, args: Record<string, unknown> | undefined, parse: (v: unknown) => T | null): Promise<FontResult<T>> {
  let value: unknown;
  try {
    value = await invoke(command, args);
  } catch (reason) {
    const code = isRecord(reason) ? CODES.find((c) => c === reason.code) : undefined;
    return { ok: false, error: code ?? "Protocol" };
  }
  const parsed = parse(value);
  return parsed === null ? { ok: false, error: "Protocol" } : { ok: true, value: parsed };
}

export interface FontBackend {
  catalog(): Promise<FontResult<FontCatalog>>;
  refresh(): Promise<FontResult<FontCatalog>>;
  /** Native chooser; `null` when cancelled. Dialog strings are already translated. */
  register(title: string, accept: string, cancel: string): Promise<FontResult<FontRegistered | null>>;
  remove(family: string): Promise<FontResult<FontCatalog>>;
  /** One registered user face: its face index and font file bytes (for the WebView's FontFace). */
  userFace(family: string, style: string): Promise<FontResult<{ index: number; bytes: Uint8Array }>>;
}

export function createFontBackend(invoke: Invoke): FontBackend {
  return {
    catalog: () => call(invoke, "font_catalog", undefined, parseFontCatalog),
    refresh: () => call(invoke, "font_refresh", undefined, parseFontCatalog),
    register: async (title, accept, cancel) => {
      // `null` (cancelled) is a valid answer, distinct from a malformed one.
      const r = await call(invoke, "font_register", { title, accept, cancel }, (v) => v === null ? { cancelled: true as const } : parseRegistered(v));
      if (!r.ok) return r;
      return { ok: true, value: "cancelled" in r.value ? null : r.value };
    },
    remove: (family) => call(invoke, "font_remove", { family }, parseFontCatalog),
    userFace: (family, style) => call(invoke, "font_user_face", { family, style }, (v) => {
      const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : v instanceof Uint8Array ? v : null;
      if (!bytes || bytes.length < 8) return null;
      const index = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
      return { index, bytes: bytes.subarray(4) };
    }),
  };
}

/** The family's display name in `lang` (its localized name when the font has one for that language). */
export function displayName(family: FontFamily, lang: string): string {
  const prefix = lang.toLowerCase().split("-")[0]!;
  return family.localized.find((l) => l.lang.toLowerCase().split("-")[0] === prefix)?.name ?? family.family;
}
