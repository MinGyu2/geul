// Stage 1 F: document font embedding helpers shared by the sessions and the dialog. The backend
// (src-tauri/src/fonts/embedding.rs) is authoritative for permissions and slots; this mirrors its DOCX slot rule
// so the session can recognise the result in the engine view.
import type { FontBackend, FontEmbedInfo, FontResult } from "../adapters/fonts";

/** DOCX embed slot of a face style (ECMA-376 w:embedRegular|Bold|Italic|BoldItalic), or null (no slot). */
export function docxSlot(style: string): string | null {
  const s = style.toLowerCase().replace(/[-_]/g, " ").trim();
  if (["regular", "normal", "book", "roman"].includes(s)) return "embedRegular";
  if (s === "bold") return "embedBold";
  if (s === "italic" || s === "oblique") return "embedItalic";
  if (["bold italic", "bold oblique", "bolditalic"].includes(s)) return "embedBoldItalic";
  return null;
}


let source: FontBackend | null = null;

/** The font backend the RHWP session asks for embeddable font programs (set with the font catalog). */
export function configureEmbedding(backend: FontBackend | null): void {
  source = backend;
}

/** The program bytes of an embeddable face (the backend refuses faces whose license does not permit it). */
export async function embedFontData(family: string, style: string): Promise<Uint8Array | null> {
  const r = await source?.embedData(family, style);
  return r?.ok ? r.value : null;
}

export async function embedFontInfo(family: string, style: string): Promise<FontResult<FontEmbedInfo> | null> {
  return source ? source.embedInfo(family, style) : null;
}
