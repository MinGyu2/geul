// Native acceptance fixture for native-stage1-p1f.py: node scripts/tests/stage1-p1f-native-fixture.mjs <repo> <out.hwpx>.
// Paragraph 1 uses NanumGothic (an embeddable system face); paragraph 0 keeps one run (see stage1-common-editing.md 5.5).
import { createRequire } from "node:module"; import { readFileSync, writeFileSync } from "node:fs";
const [root, out] = process.argv.slice(2);
const gen = JSON.parse(readFileSync(root + "/public/rhwp/RELEASE.json")).generation, folder = root + "/public/rhwp/generations/" + gen;
const engine = createRequire(import.meta.url)(folder + "/rhwp.js"); engine.initSync({ module: readFileSync(folder + "/rhwp_bg.wasm") });
const d = engine.HwpDocument.createEmpty(); d.createBlankDocument();
const text = "한글 Font editing ABC 0123"; d.insertText(0, 0, 0, text); d.splitParagraph(0, 0, [...text].length); d.insertText(0, 1, 0, "Next paragraph");
const id = d.findOrCreateFontId("NanumGothic"); d.applyCharFormat(0, 1, 0, 14, JSON.stringify({ fontId: id }));
const e = d.exportHwpxWithReport(); writeFileSync(out, e.takeBytes()); e.free(); d.free();
