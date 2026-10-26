import { readFileSync } from "node:fs"; import { join } from "node:path"; import { pathToFileURL } from "node:url"; import zlib from "node:zlib";
const [root, src] = process.argv.slice(2);
const rhwp = await import(pathToFileURL(join(root, "public/rhwp/rhwp.js")).href);
rhwp.initSync({ module: readFileSync(join(root, "public/rhwp/rhwp_bg.wasm")) });
const d = new rhwp.HwpDocument(readFileSync(src));
d.applyCharFormat(0,0,0,4,JSON.stringify({italic:true})); d.applyCharFormat(0,0,0,4,JSON.stringify({italic:false}));
const x = d.exportHwpxWithReport(); const b = Buffer.from(x.takeBytes()); x.free();
// find header.xml in zip (local headers)
let i=0, out=null; while ((i=b.indexOf(Buffer.from([0x50,0x4b,3,4]),i))>=0){const m=b.readUInt16LE(i+8),cs=b.readUInt32LE(i+18),n=b.readUInt16LE(i+26),e=b.readUInt16LE(i+28);const name=b.slice(i+30,i+30+n).toString();const data=b.slice(i+30+n+e,i+30+n+e+cs);if(name==='Contents/header.xml')out=m===8?zlib.inflateRawSync(data).toString():data.toString();i+=4;}
console.log(JSON.stringify({ charPr: (out.match(/<hh:charPr /g)||[]).length, itemCnt: out.match(/charProperties itemCnt="(\d+)"/)[1], idAt0: JSON.parse(d.getCharPropertiesAt(0,0,1)).charShapeId }));
