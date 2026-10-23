// Explicit test-only package selection; production loaders never import this module.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function testPackage(root: string): string {
  const supplied = process.env.GEUL_RHWP_TEST_PACKAGE;
  if (!supplied) return join(root, "public/rhwp");
  const folder = resolve(supplied);
  const identity = JSON.parse(readFileSync(join(folder, "ENGINE.json"), "utf8"));
  if (identity.baseline !== "1a76570e833917d15817415a53c09ad61ab3203f"
      || identity.buildStatus !== "PASS" || !identity.sourceStableDuringBuild) throw new Error("unverified test engine");
  for (const name of ["rhwp.js", "rhwp_bg.wasm", "rhwp.d.ts"]) {
    const hash = createHash("sha256").update(readFileSync(join(folder, name))).digest("hex");
    if (hash !== identity.artifacts[name]) throw new Error("test engine artifact mismatch: " + name);
  }
  return folder;
}

export function loadTestEngine(root: string) {
  // Native Node loader also supports isolated packages outside Vite's workspace.
  return createRequire(import.meta.url)(join(testPackage(root), "rhwp.js"));
}
