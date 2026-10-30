import { afterEach, describe, expect, test } from "vitest";
import { build, createServer } from "vite";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, type BuildIdentity } from "../../src/components/Editor/rhwp/rhwpArtifactIdentity";
import { copyRhwpGeneration, readRhwpGeneration, rhwpGenerationPlugin } from "../rhwpAssets";
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const folders: string[] = [];
function fixture(profile: "release" | "debug", label = profile) {
  const js = `export const label = '${label}';`, wasm = Buffer.from([0,97,115,109,1,0,0,0]);
  const identity: BuildIdentity = {schemaVersion: 1, engine: "rhwp", commit: "1".repeat(40), profile, tools: {cargo:"1.99.0",rustc:"1.99.0","wasm-bindgen":"0.2.127"}, sourceFingerprint: hash(label), artifacts: {"rhwp.js":hash(js),"rhwp_bg.wasm":hash(wasm)}, generation:""};
  const unsigned = Object.fromEntries(Object.entries(identity).filter(([key]) => key !== "generation"));
  identity.generation = hash(canonical(unsigned) + "\n");
  return {identity, js, wasm};
}
const release = fixture("release"), debug = fixture("debug");
function root() {const p = mkdtempSync(join(tmpdir(), "geul-assets-")); folders.push(p); mkdirSync(join(p,"public/rhwp"),{recursive:true}); writeFileSync(join(p,"index.html"),"<html><body>test</body></html>"); return p;}
function install(p: string, item = release, pointer = item.identity.profile.toUpperCase()+".json") {
  const dir = join(p,"public/rhwp/generations",item.identity.generation); mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,"BUILD.json"),canonical(item.identity)); writeFileSync(join(dir,"rhwp.js"),item.js); writeFileSync(join(dir,"rhwp_bg.wasm"),item.wasm);
  writeFileSync(join(p,"public/rhwp",pointer),canonical(item.identity));
}
const options = (p: string) => ({root:p,configFile:false as const,logLevel:"silent" as const,plugins:[rhwpGenerationPlugin()]});
afterEach(()=>{for(const p of folders.splice(0))rmSync(p,{recursive:true,force:true});});
describe("RHWP profile contract through Vite",()=>{
  test("explicit Rust Release without Binaryen remains a valid product",async()=>{
    const p=root(), item=fixture("release");item.identity.schemaVersion=2;item.identity.optimization={tool:"none",version:null,flags:[]};
    const unsigned=Object.fromEntries(Object.entries(item.identity).filter(([key])=>key!=="generation"));item.identity.generation=hash(canonical(unsigned)+"\n");
    install(p,item);await build(options(p));expect(JSON.parse(readFileSync(join(p,"dist/rhwp/BUILD.json"),"utf8"))).toEqual(item.identity);
  });
  test("release ignores stale Debug legacy selector and copies one generation",async()=>{
    const p=root();install(p);install(p,debug);install(p,debug,"BUILD.json");
    await build(options(p));
    expect(JSON.parse(readFileSync(join(p,"dist/rhwp/BUILD.json"),"utf8"))).toEqual(release.identity);
    expect(readdirSync(join(p,"dist/rhwp/generations"))).toEqual([release.identity.generation]);
  });
  test("Debug in Release pointer is rejected by actual build",async()=>{const p=root();install(p,debug,"RELEASE.json");await expect(build(options(p))).rejects.toThrow("selector contains debug");});
  test("missing Release fails actual product build",async()=>{const p=root();install(p,debug);await expect(build(options(p))).rejects.toThrow("requires release");});
  test("explicit frontend-only build needs no engine",async()=>{const p=root();await build({...options(p),mode:"frontend-only"});expect(readdirSync(join(p,"dist"))).toEqual(["index.html"]);});
  test("dev server serves Debug pointer and immutable paths",async()=>{
    const p=root();install(p);install(p,debug);install(p,release,"BUILD.json");const server=await createServer({...options(p),server:{port:0,host:"127.0.0.1"}});
    try{await server.listen();const base=server.resolvedUrls!.local[0]!;const identity=await (await fetch(base+"rhwp/BUILD.json")).json();expect(identity).toEqual(debug.identity);for(const query of ["", "?import"]){const response=await fetch(base+"rhwp/generations/"+identity.generation+"/rhwp.js"+query);expect(response.status).toBe(200);expect(await response.text()).toBe(debug.js);}}finally{await server.close();}
  });
  test("Debug absence explicitly falls back to Release",async()=>{const p=root();install(p);expect(await readRhwpGeneration(join(p,"public/rhwp"),"debug")).toEqual(release.identity);});
  test.each(["BUILD.json","rhwp.js","rhwp_bg.wasm"])("rejects corrupted or mixed %s",async name=>{const p=root();install(p);writeFileSync(join(p,"public/rhwp/generations",release.identity.generation,name),name==="BUILD.json"?canonical(debug.identity):"mixed");await expect(readRhwpGeneration(join(p,"public/rhwp"))).rejects.toThrow();});
  test("captured identity survives subsequent selector switch",async()=>{const p=root();install(p);const selected=await readRhwpGeneration(join(p,"public/rhwp"));install(p,fixture("release","new"));await copyRhwpGeneration(join(p,"public/rhwp"),join(p,"output"),selected);expect(JSON.parse(readFileSync(join(p,"output/BUILD.json"),"utf8"))).toEqual(release.identity);});
});
