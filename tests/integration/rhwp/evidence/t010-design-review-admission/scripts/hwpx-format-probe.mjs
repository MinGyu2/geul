import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [root, src, out] = process.argv.slice(2);
const rhwp = await import(pathToFileURL(join(root, "public/rhwp/rhwp.js")).href);
rhwp.initSync({ module: readFileSync(join(root, "public/rhwp/rhwp_bg.wasm")) });
const bytes = readFileSync(src);
const cases = [["bold",0,0,4],["italic",0,0,4],["underline",0,0,4],["strikethrough",0,0,4],["bold",1,0,5],["boldoff",1,0,5],["bold2",0,0,4]];
for (const [attr,p,s,e] of cases) {
  const d = new rhwp.HwpDocument(bytes);
  if (attr === "boldoff") d.applyCharFormat(0,p,s,e,JSON.stringify({bold:false}));
  else if (attr === "bold2") { d.applyCharFormat(0,p,s,e,JSON.stringify({bold:true})); d.applyCharFormat(0,p,s,e,JSON.stringify({bold:false})); }
  else d.applyCharFormat(0,p,s,e,JSON.stringify({[attr]:true}));
  const x = d.exportHwpxWithReport(); const b = x.takeBytes(); const loss = x.contentLoss(); x.free(); d.free();
  writeFileSync(join(out, `${attr}-${p}.hwpx`), b); console.log(attr, p, b.length, loss);
}
const d = new rhwp.HwpDocument(bytes); const x = d.exportHwpxWithReport(); writeFileSync(join(out,"unedited.hwpx"), x.takeBytes()); x.free(); d.free();
