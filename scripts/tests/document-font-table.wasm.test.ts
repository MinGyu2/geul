import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { documentFontTable } from "../../src/components/Editor/rhwp/rhwpFonts";
import { RhwpText } from "../../src/components/Editor/rhwp/rhwpText";
import type { RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });

function exportBytes(doc: RhwpDocument, format: "hwp" | "hwpx") {
  const out = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
  try { return out.takeBytes(); } finally { out.free(); }
}
function source(format: "hwp" | "hwpx") {
  const d = engine.HwpDocument.createEmpty();
  try { d.createBlankDocument(); d.insertText(0, 0, 0, "Font inventory 한글"); return exportBytes(d, format); }
  finally { d.free(); }
}
it.each(["hwp", "hwpx"] as const)("document font inventory reads loaded %s owned IDs without mutation", format => {
  const d = new engine.HwpDocument(source(format)) as RhwpDocument;
  try {
    const before = exportBytes(d, format), table = documentFontTable(d);
    expect(table).not.toBeNull(); expect(table!.languages).toHaveLength(7);
    const selected = new RhwpText(d).fontReferences({ section: 0, paragraph: 0, offset: 1 });
    expect(selected).not.toBeNull();
    const props = JSON.parse(d.getCharPropertiesAt!(0, 0, 1));
    expect(selected!.charShapeId).toBe(props.charShapeId);
    expect(selected!.faces.map(face => face.definition.name)).toEqual(props.fontFamilies);
    expect(exportBytes(d, format)).toEqual(before);
    const reopened = new engine.HwpDocument(before) as RhwpDocument;
    try { expect(documentFontTable(reopened)).toEqual(table); } finally { reopened.free(); }
  } finally { d.free(); }
});
it.each(["hwp", "hwpx"] as const)("document font inventory rejects an invalid %s language reference", format => {
  const d = new engine.HwpDocument(source(format)) as RhwpDocument;
  try {
    expect(documentFontTable(d)).not.toBeNull();
    d.applyCharFormat!(0, 0, 0, 1, JSON.stringify({ fontIds: Array(7).fill(65535) }));
    expect(() => d.getDocumentFontTable!()).toThrow();
    expect(documentFontTable(d)).toBeNull();
  } finally { d.free(); }
});
