// Stage 5-A font catalog client: strict response checks (Rust src-tauri/src/fonts/ serialization).
import { describe, expect, it } from "vitest";
import { createFontBackend, displayName, parseFontCatalog, type FontCatalog } from "./fonts";
import { catalogWire } from "./fonts.fixture";

describe("font catalog client", () => {
  it("accepts the backend catalog and rejects malformed shapes", () => {
    const catalog = parseFontCatalog(catalogWire) as FontCatalog;
    expect(catalog.families.map((f) => f.family)).toEqual(["NanumGothic", "Geul Test", "Source Sans 3"]);
    expect(catalog.status.fontconfigVersion).toBe("2.18.3");
    expect(parseFontCatalog({ ...catalogWire, families: [{ ...catalogWire.families[0], source: "web" }] })).toBeNull();
    expect(parseFontCatalog({ ...catalogWire, families: [{ ...catalogWire.families[0], styles: [{ name: "", weight: 400, italic: false }] }] })).toBeNull();
    expect(parseFontCatalog({ ...catalogWire, userFonts: [{ ...catalogWire.userFonts[0], persisted: "yes" }] })).toBeNull();
    expect(parseFontCatalog({ ...catalogWire, status: { ...catalogWire.status, systemFaces: -1 } })).toBeNull();
    expect(parseFontCatalog(null)).toBeNull();
  });

  it("shows localized family names in a matching interface language", () => {
    const catalog = parseFontCatalog(catalogWire)!;
    expect(displayName(catalog.families[0]!, "ko")).toBe("나눔고딕");
    expect(displayName(catalog.families[0]!, "en")).toBe("NanumGothic");
  });

  it("maps error codes, cancel and the face byte frame", async () => {
    const calls: [string, unknown][] = [];
    let reply: unknown = null;
    let fail: unknown = null;
    const backend = createFontBackend(async (command, args) => {
      calls.push([command, args]);
      if (fail) throw fail;
      return reply;
    });
    // Cancelled chooser: a null answer, not a protocol error.
    expect(await backend.register("t", "a", "c")).toEqual({ ok: true, value: null });
    expect(calls[0]).toEqual(["font_register", { title: "t", accept: "a", cancel: "c" }]);
    fail = { code: "DamagedFont" };
    expect(await backend.register("t", "a", "c")).toEqual({ ok: false, error: "DamagedFont" });
    fail = "command font_register not allowed";
    expect(await backend.remove("X")).toEqual({ ok: false, error: "Protocol" });
    fail = null;
    reply = { font: catalogWire.userFonts[0], storageFailed: true, catalog: catalogWire };
    const registered = await backend.register("t", "a", "c");
    expect(registered.ok && registered.value?.storageFailed).toBe(true);
    reply = new Uint8Array([0, 0, 0, 0, 1, 2, 3, 4]).buffer;
    const face = await backend.userFace("Geul Test", "Regular");
    expect(face).toEqual({ ok: true, value: { index: 0, bytes: new Uint8Array([1, 2, 3, 4]) } });
    expect(calls.at(-1)).toEqual(["font_user_face", { family: "Geul Test", style: "Regular" }]);
    reply = { not: "a catalog" };
    expect(await backend.catalog()).toEqual({ ok: false, error: "Protocol" });
  });
});
