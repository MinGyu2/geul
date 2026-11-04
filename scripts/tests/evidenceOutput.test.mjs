// node --test scripts/tests/evidenceOutput.test.mjs
// Would fail under the previous unconditional writeFileSync/mkdirSync({recursive}) behavior.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claimRunDirectory, writeNew, writeNewOrIdentical } from "./evidenceOutput.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "geul-evidence-"));

test("an existing evidence file is never overwritten", () => {
  const dir = scratch();
  try {
    const path = join(dir, "prepared.hwp");
    writeFileSync(path, "original evidence");
    assert.throws(() => writeNew(path, "regenerated"), { code: "EEXIST" });
    assert.throws(() => writeNewOrIdentical(path, "regenerated"), /refusing to replace/);
    assert.equal(readFileSync(path, "utf8"), "original evidence");
    writeNewOrIdentical(path, "original evidence"); // identical intermediate is accepted unchanged
    assert.equal(readFileSync(path, "utf8"), "original evidence");
  } finally { rmSync(dir, { recursive: true }); }
});

test("a run claims only a new or empty directory", () => {
  const dir = scratch();
  try {
    const run = join(dir, "runs", "one");
    claimRunDirectory(run); // new (parents created)
    writeNew(join(run, "runtime.json"), "{}");
    assert.throws(() => claimRunDirectory(run), /non-empty/);
    assert.equal(readFileSync(join(run, "runtime.json"), "utf8"), "{}");
    const empty = join(dir, "empty");
    mkdirSync(empty);
    claimRunDirectory(empty);
    claimRunDirectory(join(dir, "runs", "two")); // a separate execution directory works
  } finally { rmSync(dir, { recursive: true }); }
});
