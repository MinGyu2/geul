// Stage 5-A: registered user fonts in the WebView (RHWP Canvas text and any CSS that names them).
//
// RHWP paints HWP/HWPX text on a Canvas with CSS font-family chains whose first entry is the document's font name. System
// fonts reach the WebView through the platform's own font configuration (WebKitGTK uses fontconfig); geul's user fonts are
// private to the app, so their bytes are delivered here from the same registration the Rust font database holds — never a
// second persistence authority, never a file path or URL exposed to the page (FontFace takes the bytes; no CSP change).
import type { FontBackend, FontCatalog } from "../adapters/fonts";

/** Most user faces loaded into the WebView at once. */
export const MAX_WEB_FACES = 256;

export interface FontFaceSetLike {
  add(face: FontFace): unknown;
  delete(face: FontFace): unknown;
}

type CreateFace = (family: string, bytes: Uint8Array, descriptors: FontFaceDescriptors) => FontFace;

/** CSS descriptors implied by a style name ("Bold Italic", "SemiBold"). */
export function styleDescriptors(style: string): FontFaceDescriptors {
  const s = style.toLowerCase().replace(/[^a-z]/g, "");
  const table: [string, number][] = [["extralight", 200], ["ultralight", 200], ["semibold", 600], ["demibold", 600], ["extrabold", 800],
    ["ultrabold", 800], ["hairline", 100], ["thin", 100], ["light", 300], ["medium", 500], ["bold", 700], ["black", 900], ["heavy", 900]];
  const weight = table.find(([k]) => s.includes(k))?.[1] ?? 400;
  return { weight: String(weight), style: s.includes("italic") || s.includes("oblique") ? "italic" : "normal" };
}

export class WebFontBridge {
  private readonly loaded = new Map<string, FontFace>();
  private running: Promise<boolean> = Promise.resolve(false);

  constructor(
    private readonly backend: FontBackend,
    private readonly fonts: FontFaceSetLike | null = typeof document !== "undefined" && "fonts" in document ? document.fonts : null,
    private readonly create: CreateFace = (family, bytes, descriptors) => new FontFace(family, bytes as unknown as BufferSource, descriptors),
  ) {}

  /** Families currently loaded (tests, diagnostics). */
  loadedKeys(): string[] {
    return [...this.loaded.keys()];
  }

  /** Match the WebView's user faces to `catalog`. Resolves to whether anything was added or removed. Calls run one at a time. */
  sync(catalog: FontCatalog): Promise<boolean> {
    this.running = this.running.then(() => this.apply(catalog), () => this.apply(catalog));
    return this.running;
  }

  private async apply(catalog: FontCatalog): Promise<boolean> {
    const fonts = this.fonts;
    if (!fonts) return false;
    const wanted = new Map<string, { family: string; style: string }>();
    for (const file of catalog.userFonts) {
      for (const face of file.faces) {
        if (wanted.size >= MAX_WEB_FACES) break;
        wanted.set(`${file.id}\n${face.family}\n${face.style}`, face);
      }
    }
    let changed = false;
    for (const [key, face] of this.loaded) {
      if (!wanted.has(key)) {
        fonts.delete(face);
        this.loaded.delete(key);
        changed = true;
      }
    }
    for (const [key, { family, style }] of wanted) {
      if (this.loaded.has(key)) continue;
      const result = await this.backend.userFace(family, style);
      // Collections: FontFace reads only the first face of a file; other faces stay engine-only.
      if (!result.ok || result.value.index !== 0) continue;
      try {
        const face = this.create(family, result.value.bytes, styleDescriptors(style));
        await face.load();
        fonts.add(face);
        this.loaded.set(key, face);
        changed = true;
      } catch {
        // A face the WebView refuses stays unavailable to Canvas; the Rust engines still use it.
      }
    }
    return changed;
  }
}
