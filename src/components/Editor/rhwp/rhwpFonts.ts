import type { RhwpDocument } from "./rhwpModule";

export interface DocumentFontFace { readonly id: number; readonly definition: Readonly<Record<string, unknown>> & { readonly name: string } }
export interface DocumentFontTable {
  readonly schemaVersion: 1;
  readonly languages: readonly { readonly languageIndex: number; readonly language: string; readonly fonts: readonly DocumentFontFace[] }[];
  readonly charShapes: readonly { readonly id: number; readonly fontIds: readonly number[] }[];
}
const LANGUAGES = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const index = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** A read-only snapshot of this engine document. Never resolve IDs from catalog/CSS order.
 * This validates the IR inventory, not the original HWP records or HWPX header preservation. */
export function documentFontTable(doc: RhwpDocument): DocumentFontTable | null {
  try {
    const text = doc.getDocumentFontTable?.();
    if (typeof text !== "string" || text.length > 8 * 1024 * 1024) return null;
    const value: unknown = JSON.parse(text);
    if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.languages) || value.languages.length !== 7
      || !Array.isArray(value.charShapes) || value.charShapes.length > 65_536) return null;
    let count = 0;
    for (const [lang, slot] of value.languages.entries()) {
      if (!record(slot) || slot.languageIndex !== lang || slot.language !== LANGUAGES[lang] || !Array.isArray(slot.fonts)
        || slot.fonts.length > 65_536 || (count += slot.fonts.length) > 100_000) return null;
      for (const [id, face] of slot.fonts.entries()) {
        if (!record(face) || face.id !== id || !record(face.definition) || typeof face.definition.name !== "string"
          || face.definition.name.length === 0 || face.definition.name.length > 4096) return null;
      }
    }
    for (const [id, shape] of value.charShapes.entries()) {
      if (!record(shape) || shape.id !== id || !Array.isArray(shape.fontIds) || shape.fontIds.length !== 7) return null;
      for (const [lang, fontId] of shape.fontIds.entries()) {
        const slot = value.languages[lang] as { fonts: unknown[] };
        if (!index(fontId) || fontId > 65535 || fontId >= slot.fonts.length) return null;
      }
    }
    return value as unknown as DocumentFontTable;
  } catch { return null; }
}
