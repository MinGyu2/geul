// Optional test identity gate. Reuses independent committed production-byte evidence;
// this is neither native D1 candidate approval nor a signature/trust-anchor replacement.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const pin = "1a76570e833917d15817415a53c09ad61ab3203f";
const root = new URL("../../../", import.meta.url);
const record = new URL("./evidence/t010-native-evidence-final-integrity/protected-runtime-inputs.json", import.meta.url);

function readJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`${label}: malformed JSON`); }
}

export function verifyProductionIdentity() {
  const metadata = readJson(readFileSync(record), "independent identity record");
  const expected = metadata?.["입력"];
  const buffers = {};
  const hashes = {};
  for (const name of ["BUILD.json", "rhwp.js", "rhwp_bg.wasm"]) {
    const key = `public/rhwp/${name}`;
    const digest = expected?.[key];
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`${name}: invalid expected SHA-256 metadata`);
    }
    try { buffers[name] = readFileSync(new URL(key, root)); }
    catch { throw new Error(`${name}: artifact unavailable`); }
    if (name === "BUILD.json") {
      const build = readJson(buffers[name], name);
      if (build?.engine !== "rhwp") throw new Error(`${name}: unexpected engine`);
      if (build?.commit !== pin) throw new Error(`${name}: unexpected pinned revision`);
    }
    hashes[name] = createHash("sha256").update(buffers[name]).digest("hex");
    if (hashes[name] !== digest) throw new Error(`${name}: SHA-256 mismatch`);
  }
  return { wasmBytes: buffers["rhwp_bg.wasm"], javascriptUrl: new URL("public/rhwp/rhwp.js", root),
    evidence: { status: "PASS", revision: pin, hashes } };
}

export async function loadVerifiedRhwp() {
  // No executable RHWP import or initialization occurs before every artifact passes.
  // Reuse the checked WASM buffer for initialization; do not read/copy it again.
  const verified = verifyProductionIdentity();
  const rhwp = await import(verified.javascriptUrl.href);
  rhwp.initSync({ module: verified.wasmBytes });
  return rhwp;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { console.log(JSON.stringify(verifyProductionIdentity().evidence)); }
  catch (error) { console.error(`identity verification failed: ${error.message}`); process.exitCode = 1; }
}
