/* Build 64-paragraph caption fixtures from the Stage 3 body picture inputs. */
const fs = require("node:fs");
const path = require("node:path");

const directory = process.argv[2];
if (!directory) throw Error("fixture directory required");
const root = path.resolve(__dirname, "../..");
const assets = path.join(root, "public/rhwp");
const release = JSON.parse(fs.readFileSync(path.join(assets, "RELEASE.json")));
const enginePath = path.join(assets, "generations", release.generation);
const engine = require(path.join(enginePath, "rhwp.js"));
engine.initSync({module: fs.readFileSync(path.join(enginePath, "rhwp_bg.wasm"))});

function requireOk(result, description) {
  if (JSON.parse(result).ok !== true) throw Error(description + ": " + result);
}

for (const format of ["hwp", "hwpx"]) {
  const doc = new engine.HwpDocument(fs.readFileSync(path.join(directory, `p3-position-original.${format}`)));
  try {
    const picture = [0, 0, 2];
    requireOk(doc.setPictureProperties(...picture, '{"hasCaption":true}'), "create picture caption");
    for (let p = 0; p < 63; ++p) {
      const end = doc.getCellParagraphLength(...picture, 0, p);
      requireOk(doc.splitParagraphInCell(...picture, 0, p, end), "split caption");
      requireOk(doc.insertTextInCell(...picture, 0, p + 1, 0, "x"), "fill caption");
    }
    const output = format === "hwp" ? doc.exportHwp() : doc.exportHwpx();
    fs.writeFileSync(path.join(directory, `c13-original.${format}`), output);
  } finally {
    doc.free();
  }
}
