// Tests the actual preflight/load/helper/wrapper boundaries using isolated files.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const names = ["BUILD.json", "rhwp.js", "rhwp_bg.wasm"];
const recordPath = "tests/integration/rhwp/evidence/t010-native-evidence-final-integrity/protected-runtime-inputs.json";
const hash = (data) => createHash("sha256").update(data).digest("hex");
const originals = Object.fromEntries(names.map((name) => [name, hash(readFileSync(join(root, "public/rhwp", name)))]));

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "geul-engine-identity-"));
  t.after(() => {
    for (const name of names) assert.equal(hash(readFileSync(join(root, "public/rhwp", name))), originals[name]);
    rmSync(dir, { recursive: true, force: true });
  });
  const here = join(dir, "tests/integration/rhwp");
  mkdirSync(here, { recursive: true });
  for (const name of ["production-identity.mjs", "formcharpr-save.mjs", "formcharpr_save.py"]) {
    copyFileSync(join(root, "tests/integration/rhwp", name), join(here, name));
  }
  mkdirSync(dirname(join(dir, recordPath)), { recursive: true });
  copyFileSync(join(root, recordPath), join(dir, recordPath));
  mkdirSync(join(dir, "public/rhwp"), { recursive: true });
  for (const name of names) symlinkSync(join(root, "public/rhwp", name), join(dir, "public/rhwp", name));
  mkdirSync(join(dir, "tests/poc/t010-phase0"), { recursive: true });
  copyFileSync(join(root, "tests/poc/t010-phase0/analysis.mjs"), join(dir, "tests/poc/t010-phase0/analysis.mjs"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  return { dir, here, record: JSON.parse(readFileSync(join(dir, recordPath))) };
}

function replace(s, name, data) {
  const file = join(s.dir, "public/rhwp", name);
  rmSync(file); // Remove only the sandbox symlink; never write through it.
  writeFileSync(file, data);
}

function sentinelJs(s) {
  const script = `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(join(s.dir, "imported"))}, 'bad');
export function initSync() {writeFileSync(${JSON.stringify(join(s.dir, "initialized"))}, 'bad');}`;
  replace(s, "rhwp.js", script);
  // Test-only authorized sentinel reaches the WASM check. This is never production metadata.
  s.record["입력"]["public/rhwp/rhwp.js"] = hash(script);
  writeFileSync(join(s.dir, recordPath), JSON.stringify(s.record));
}

function run(args) {
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

function rejectEveryBoundary(s, diagnostic) {
  const gate = pathToFileURL(join(s.here, "production-identity.mjs")).href;
  const evidence = join(s.dir, "success.json");
  const load = `import {loadVerifiedRhwp} from ${JSON.stringify(gate)}; await loadVerifiedRhwp();`;
  const checks = [
    run([join(s.here, "production-identity.mjs")]),
    run(["--input-type=module", "-e", load]),
    run([join(s.here, "formcharpr-save.mjs"), "verify", "missing-input", "missing-output", "missing-target", evidence, "8"]),
  ];
  // The Python entry must fail before its existing generator executes or a save is invoked.
  mkdirSync(join(s.dir, "tests/fixtures/rhwp"), { recursive: true });
  writeFileSync(join(s.dir, "tests/fixtures/rhwp/generate.mjs"),
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(s.dir, "document-created"))}, 'bad');`);
  checks.push(spawnSync("python3", [join(s.here, "formcharpr_save.py"), "--evidence", evidence], { encoding: "utf8" }));
  for (const result of checks) {
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, diagnostic);
    assert.doesNotMatch(result.stdout + result.stderr, /PASS/);
  }
  for (const marker of ["imported", "initialized", "document-created", "success.json"]) {
    assert.equal(existsSync(join(s.dir, marker)), false, `failure crossed boundary: ${marker}`);
  }
}

test("correct independent artifacts pass preflight and load/init the engine", async (t) => {
  const s = sandbox(t);
  const result = run([join(s.here, "production-identity.mjs")]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "PASS");
  const gate = pathToFileURL(join(s.here, "production-identity.mjs")).href;
  const loaded = run(["--input-type=module", "-e", `import {loadVerifiedRhwp} from ${JSON.stringify(gate)};
    const rhwp=await loadVerifiedRhwp(); if(typeof rhwp.HwpDocument !== 'function') throw Error('missing engine');`]);
  assert.equal(loaded.status, 0, loaded.stderr);
});

test("modified WASM with correct BUILD revision fails before any engine import", (t) => {
  const s = sandbox(t); sentinelJs(s);
  const bytes = readFileSync(join(root, "public/rhwp/rhwp_bg.wasm"));
  bytes[bytes.length - 1] ^= 1;
  replace(s, "rhwp_bg.wasm", bytes);
  rejectEveryBoundary(s, /rhwp_bg\.wasm: SHA-256 mismatch/);
});

test("modified JS with correct BUILD revision fails before execution", (t) => {
  const s = sandbox(t);
  replace(s, "rhwp.js", `throw Error('unverified JS executed');`);
  rejectEveryBoundary(s, /rhwp\.js: SHA-256 mismatch/);
});

for (const name of names) {
  test(`missing ${name} fails closed`, (t) => {
    const s = sandbox(t);
    if (name !== "rhwp.js") sentinelJs(s);
    rmSync(join(s.dir, "public/rhwp", name));
    rejectEveryBoundary(s, new RegExp(`${name.replaceAll(".", "\\.")}: artifact unavailable`));
  });
}

test("malformed BUILD fails before engine execution", (t) => {
  const s = sandbox(t); sentinelJs(s); replace(s, "BUILD.json", "{");
  rejectEveryBoundary(s, /BUILD\.json: malformed JSON/);
});

test("wrong pinned revision fails even with a matching test-only BUILD hash", (t) => {
  const s = sandbox(t); sentinelJs(s);
  const build = JSON.stringify({ engine: "rhwp", commit: "0".repeat(40) });
  replace(s, "BUILD.json", build);
  s.record["입력"]["public/rhwp/BUILD.json"] = hash(build);
  writeFileSync(join(s.dir, recordPath), JSON.stringify(s.record));
  rejectEveryBoundary(s, /BUILD\.json: unexpected pinned revision/);
});

test("incorrect expected hash metadata fails", (t) => {
  const s = sandbox(t); sentinelJs(s);
  s.record["입력"]["public/rhwp/rhwp_bg.wasm"] = "0".repeat(64);
  writeFileSync(join(s.dir, recordPath), JSON.stringify(s.record));
  rejectEveryBoundary(s, /rhwp_bg\.wasm: SHA-256 mismatch/);
});

test("malformed expected hash metadata fails", (t) => {
  const s = sandbox(t); sentinelJs(s);
  s.record["입력"]["public/rhwp/rhwp_bg.wasm"] = null;
  writeFileSync(join(s.dir, recordPath), JSON.stringify(s.record));
  rejectEveryBoundary(s, /rhwp_bg\.wasm: invalid expected SHA-256 metadata/);
});

test("BUILD bytes matter even when its engine/revision fields are unchanged", (t) => {
  const s = sandbox(t); sentinelJs(s);
  replace(s, "BUILD.json", readFileSync(join(root, "public/rhwp/BUILD.json"), "utf8") + "\n");
  rejectEveryBoundary(s, /BUILD\.json: SHA-256 mismatch/);
});
