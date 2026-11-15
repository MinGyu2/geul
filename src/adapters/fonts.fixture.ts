// Stage 5-A test fixture: a catalog as the backend serializes it (src-tauri/src/fonts/catalog.rs).
export const catalogWire = {
  status: {
    provider: "fontconfig", fontconfigAvailable: true, fontconfigVersion: "2.18.3", fontconfigError: null,
    systemFaces: 3, generation: 7, userFontStorage: true, skippedUserFonts: [],
  },
  families: [
    { id: "system:nanumgothic", family: "NanumGothic", localized: [{ lang: "ko", name: "나눔고딕" }], styles: [{ name: "Regular", weight: 400, italic: false }, { name: "Bold", weight: 700, italic: false }], source: "system", available: true, renderable: true },
    { id: "user:geul test", family: "Geul Test", localized: [], styles: [{ name: "Regular", weight: 400, italic: false }], source: "user", available: true, renderable: true },
    { id: "bundled:source sans 3", family: "Source Sans 3", localized: [], styles: [{ name: "Regular", weight: 400, italic: false }], source: "bundled", available: true, renderable: true },
  ],
  generics: [{ generic: "sans-serif", family: "NanumGothic" }, { generic: "serif", family: null }],
  userFonts: [{ id: "Geul-Test.ttf", families: ["Geul Test"], faces: [{ family: "Geul Test", style: "Regular" }], persisted: true }],
};
