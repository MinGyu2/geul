// Stage 5-A: user faces delivered to the WebView (RHWP Canvas) from the backend registration.
import { describe, expect, it } from "vitest";
import type { FontBackend, FontCatalog } from "../adapters/fonts";
import { parseFontCatalog } from "../adapters/fonts";
import { catalogWire } from "../adapters/fonts.fixture";
import { styleDescriptors, WebFontBridge } from "./webFonts";

class FakeFace {
  loaded = false;
  constructor(readonly family: string, readonly bytes: Uint8Array, readonly descriptors: FontFaceDescriptors, private readonly reject = false) {}
  async load() { if (this.reject) throw new Error("bad font"); this.loaded = true; return this as unknown as FontFace; }
}

function setup(index = 0) {
  const requests: string[] = [];
  const backend = {
    userFace: async (family: string, style: string) => {
      requests.push(`${family}/${style}`);
      return { ok: true as const, value: { index, bytes: new Uint8Array([1, 2, 3]) } };
    },
  } as unknown as FontBackend;
  const set = new Set<FontFace>();
  const created: FakeFace[] = [];
  const bridge = new WebFontBridge(backend, { add: (f) => set.add(f), delete: (f) => set.delete(f) },
    (family, bytes, descriptors) => { const f = new FakeFace(family, bytes, descriptors, family === "Broken"); created.push(f); return f as unknown as FontFace; });
  return { bridge, set, created, requests };
}

const catalog = parseFontCatalog(catalogWire)!;
const withUser = (fonts: FontCatalog["userFonts"]): FontCatalog => ({ ...catalog, userFonts: fonts });

describe("WebFontBridge", () => {
  it("loads registered user faces once and removes them when unregistered", async () => {
    const { bridge, set, created, requests } = setup();
    expect(await bridge.sync(catalog)).toBe(true);
    expect(created.map((f) => [f.family, f.descriptors])).toEqual([["Geul Test", { weight: "400", style: "normal" }]]);
    expect(set.size).toBe(1);
    expect(await bridge.sync(catalog)).toBe(false);
    expect(requests).toEqual(["Geul Test/Regular"]);
    expect(await bridge.sync(withUser([]))).toBe(true);
    expect(set.size).toBe(0);
  });

  it("skips collection faces beyond the first and faces the WebView refuses", async () => {
    const collection = setup(1);
    expect(await collection.bridge.sync(catalog)).toBe(false);
    expect(collection.set.size).toBe(0);
    const broken = setup();
    expect(await broken.bridge.sync(withUser([{ id: "b.ttf", families: ["Broken"], faces: [{ family: "Broken", style: "Bold Italic" }], persisted: true }]))).toBe(false);
    expect(broken.set.size).toBe(0);
  });

  it("derives CSS descriptors from style names", () => {
    expect(styleDescriptors("Bold Italic")).toEqual({ weight: "700", style: "italic" });
    expect(styleDescriptors("SemiBold")).toEqual({ weight: "600", style: "normal" });
    expect(styleDescriptors("Light Oblique")).toEqual({ weight: "300", style: "italic" });
  });
});
