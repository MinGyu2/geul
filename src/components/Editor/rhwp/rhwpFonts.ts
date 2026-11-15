import type { RhwpDocument } from "./rhwpModule";
import { fontFamilyProblem } from "../../../commands/parameters";

export interface DocumentFontFace { readonly id: number; readonly definition: Readonly<Record<string, unknown>> & { readonly name: string } }
export interface DocumentFontTable {
  readonly schemaVersion: 1;
  readonly languages: readonly { readonly languageIndex: number; readonly language: string; readonly fonts: readonly DocumentFontFace[] }[];
  readonly charShapes: readonly { readonly id: number; readonly fontIds: readonly number[] }[];
}
const LANGUAGES = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"];
const MAX_DOCUMENT_FAMILIES = 300;
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

/** Families whose document-owned definitions are unambiguous in every language slot.
 * This is a bounded picker-display list; it does not infer system availability or renderer fallback. */
export function existingFontFamilies(table: DocumentFontTable): readonly string[] {
  try {
    // Validate once at the boundary: callers may hold a stale or forged runtime value despite the TS type.
    const serialized = JSON.stringify(table);
    if (typeof serialized !== "string") return [];
    const validated = documentFontTable({ getDocumentFontTable: () => serialized } as RhwpDocument);
    if (!validated) return [];

    const counts = validated.languages.map((slot) => {
      const byName = new Map<string, number>();
      for (const face of slot.fonts) {
        const name = face.definition.name;
        if (name !== name.trim() || fontFamilyProblem(name) !== null) continue;
        byName.set(name, (byName.get(name) ?? 0) + 1);
      }
      return byName;
    });
    const families: string[] = [];
    for (const [name, count] of counts[0] ?? []) {
      if (count !== 1 || !counts.every((slot) => slot.get(name) === 1)) continue;
      families.push(name);
      if (families.length === MAX_DOCUMENT_FAMILIES) break;
    }
    return families;
  } catch { return []; }
}

/** Resolve an explicitly selected family to its existing document-owned ID in every language slot.
 * Matching is exact and independent per slot: ordinals may differ. Missing or ambiguous definitions
 * fail closed; this helper never appends faces or invents renderer fallback IDs. */
export function resolveExistingFontIds(table: DocumentFontTable, family: string): readonly number[] | null {
  try {
    if (typeof family !== "string" || family !== family.trim() || fontFamilyProblem(family) !== null) return null;
    // Reuse the bounded inventory validator because callers may pass a forged/stale table at runtime.
    const serialized = JSON.stringify(table);
    if (typeof serialized !== "string") return null;
    const validated = documentFontTable({ getDocumentFontTable: () => serialized } as RhwpDocument);
    if (!validated) return null;
    const ids: number[] = [];
    for (const slot of validated.languages) {
      const matches = slot.fonts.filter(face => face.definition.name === family);
      if (matches.length !== 1) return null;
      ids.push(matches[0]!.id);
    }
    return ids;
  } catch { return null; }
}
