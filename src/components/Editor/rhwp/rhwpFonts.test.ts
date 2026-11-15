import { expect, it } from "vitest";
import { documentFontTable, existingFontFamilies, resolveExistingFontIds } from "./rhwpFonts";
import { RhwpText } from "./rhwpText";
import type { DocumentFontTable } from "./rhwpFonts";
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

function tableWithSelectedFamily(ids = [0, 1, 2, 3, 4, 5, 6]) {
  const value = inventory();
  for (const [language, selectedId] of ids.entries()) {
    value.languages[language]!.fonts = Array.from({ length: selectedId + 1 }, (_, id) => ({ id,
      definition: { name: id === selectedId ? "Selected Family" : `Language ${language} face ${id}`, raw_data: null } }));
  }
  value.charShapes[0]!.fontIds = ids;
  return value;
}

it("resolves the selected family independently to each language slot's document ID without mutation", () => {
  const value = tableWithSelectedFamily([3, 0, 5, 2, 1, 4, 6]);
  const before = JSON.stringify(value);
  const table = documentFontTable(doc(value));
  expect(table).not.toBeNull();
  expect(resolveExistingFontIds(table!, "Selected Family")).toEqual([3, 0, 5, 2, 1, 4, 6]);
  expect(JSON.stringify(value)).toBe(before);
});

it("rejects a missing or ambiguous per-language face rather than inventing an ID", () => {
  const missing = tableWithSelectedFamily();
  missing.languages[4]!.fonts[4]!.definition.name = "Different Family";
  expect(resolveExistingFontIds(documentFontTable(doc(missing))!, "Selected Family")).toBeNull();

  const ambiguous = tableWithSelectedFamily();
  ambiguous.languages[2]!.fonts.push({ id: ambiguous.languages[2]!.fonts.length, definition: { name: "Selected Family", raw_data: null } });
  expect(resolveExistingFontIds(documentFontTable(doc(ambiguous))!, "Selected Family")).toBeNull();
});

it("rejects invalid family names and malformed font inventories", () => {
  const table = documentFontTable(doc(tableWithSelectedFamily()));
  expect(table).not.toBeNull();
  for (const family of ["", "   ", " Selected Family ", "bad,family", `x${"a".repeat(128)}`])
    expect(resolveExistingFontIds(table!, family), family).toBeNull();
  expect(resolveExistingFontIds(table!, null as unknown as string)).toBeNull();

  const malformed = tableWithSelectedFamily();
  malformed.languages[0]!.fonts[0]!.id = 99;
  expect(resolveExistingFontIds(malformed as unknown as DocumentFontTable, "Selected Family")).toBeNull();
});

it("lists bounded exact family names defined once in all seven language slots", () => {
  const value = inventory();
  for (const slot of value.languages) {
    slot.fonts = [{ id: 0, definition: { name: "Selected Family", raw_data: null } },
      ...Array.from({ length: 305 }, (_, id) => ({ id: id + 1, definition: { name: `Document Family ${id}`, raw_data: null } }))];
    slot.fonts.push({ id: slot.fonts.length, definition: { name: "bad,family", raw_data: null } });
  }
  // This spelling is unique in six slots but ambiguous in HANGUL, so it must not be offered.
  value.languages[0]!.fonts.push({ id: value.languages[0]!.fonts.length, definition: { name: "Ambiguous Family", raw_data: null } });
  for (const slot of value.languages.slice(1)) slot.fonts.push({ id: slot.fonts.length, definition: { name: "Ambiguous Family", raw_data: null } });
  value.languages[0]!.fonts.push({ id: value.languages[0]!.fonts.length, definition: { name: "Ambiguous Family", raw_data: null } });
  const table = documentFontTable(doc(value));
  expect(table).not.toBeNull();
  const families = existingFontFamilies(table!);
  expect(families).toHaveLength(300);
  expect(families[0]).toBe("Selected Family");
  expect(families.at(-1)).toBe("Document Family 298");
  expect(families).not.toContain("Document Family 299");
  expect(families).not.toContain("bad,family");
  expect(families).not.toContain("Ambiguous Family");
});

it("fails closed for a forged font table passed to the display helper", () => {
  expect(existingFontFamilies({ languages: [], charShapes: [] } as unknown as DocumentFontTable)).toEqual([]);
});
