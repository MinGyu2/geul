import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [root, dir] = process.argv.slice(2);
const rhwp = await import(pathToFileURL(join(root, "public/rhwp/rhwp.js")).href);
rhwp.initSync({ module: readFileSync(join(root, "public/rhwp/rhwp_bg.wasm")) });
const out = [];
for (const [file, attr] of [["italic-0.hwpx","italic"],["underline-0.hwpx","underline"],["strikethrough-0.hwpx","strikethrough"],["bold-0.hwpx","bold"],["unedited.hwpx","italic"]]) {
  const d = new rhwp.HwpDocument(readFileSync(join(dir, file)));
  const at = (o) => JSON.parse(d.getCharPropertiesAt(0, 0, o));
  const inside = at(1), outside = at(6);
  out.push({ file, attr, insideId: inside.charShapeId, inside: inside[attr], outsideId: outside.charShapeId, outside: outside[attr] });
  d.free();
}
console.log(JSON.stringify(out));
