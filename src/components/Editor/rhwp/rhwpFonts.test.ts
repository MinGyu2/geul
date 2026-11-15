import { expect, it } from "vitest";
import { documentFontTable } from "./rhwpFonts";
import { RhwpText } from "./rhwpText";
import type { RhwpDocument } from "./rhwpModule";

const inventory = () => ({ schemaVersion: 1,
  languages: ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"].map((language, languageIndex) => ({
    language, languageIndex, fonts: [{ id: 0, definition: { name: `First ${languageIndex}`, raw_data: [1, 2, 3] } },
      { id: 1, definition: { name: `Second ${languageIndex}`, raw_data: null } }],
  })), charShapes: [{ id: 0, fontIds: [1, 0, 1, 0, 1, 0, 1] }],
});
function doc(value: unknown) {
  return { getDocumentFontTable: () => JSON.stringify(value), getParagraphLength: () => 4,
    getCharPropertiesAt: () => JSON.stringify({ charShapeId: 0, fontFamilies: Array(7).fill("untrusted display family") }) } as unknown as RhwpDocument;
}
it("document font inventory resolves selected language IDs rather than display names", () => {
  const d = doc(inventory()), text = new RhwpText(d);
  const refs = text.fontReferences({ section: 0, paragraph: 0, offset: 2 });
  expect(refs?.fontIds).toEqual([1, 0, 1, 0, 1, 0, 1]);
  expect(refs?.faces.map(f => f.definition.name)).toEqual(["Second 0", "First 1", "Second 2", "First 3", "Second 4", "First 5", "Second 6"]);
  expect(refs?.faces[1]?.definition.raw_data).toEqual([1, 2, 3]);
  expect(text.fontReferences({ section: 0, paragraph: 0, offset: 5 })).toBeNull();
});
it("document font inventory fails closed for invalid slots IDs references and missing APIs", () => {
  const mutations = [
    (v: ReturnType<typeof inventory>) => { v.languages.pop(); },
    (v: ReturnType<typeof inventory>) => { v.languages[0]!.languageIndex = 1; },
    (v: ReturnType<typeof inventory>) => { v.languages[0]!.fonts[0]!.id = 1; },
    (v: ReturnType<typeof inventory>) => { v.charShapes[0]!.fontIds[0] = 2; },
    (v: ReturnType<typeof inventory>) => { v.charShapes[0]!.fontIds[0] = -1; },
    (v: ReturnType<typeof inventory>) => { v.charShapes[0]!.id = 9; },
    (v: ReturnType<typeof inventory>) => { v.languages[0]!.fonts[0]!.definition.name = ""; },
  ];
  for (const mutate of mutations) { const v = inventory(); mutate(v); expect(documentFontTable(doc(v))).toBeNull(); }
  expect(documentFontTable({} as RhwpDocument)).toBeNull();
  expect(documentFontTable({ getDocumentFontTable: () => "{" } as RhwpDocument)).toBeNull();
});
