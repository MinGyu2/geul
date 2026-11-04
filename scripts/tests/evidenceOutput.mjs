// Evidence output ownership for the new-document runtime probe.
// A run owns one directory: it must be new (or an existing empty directory) when the run starts.
// Every output is created exclusively; an existing file is never replaced. Later phases of the same
// run add new files only, and may re-emit an intermediate only when its bytes are identical.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Start a run: create `dir`, or accept an existing empty directory. Anything else is refused. */
export function claimRunDirectory(dir) {
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (!statSync(dir).isDirectory() || readdirSync(dir).length !== 0) {
      throw new Error(`refusing to reuse non-empty evidence directory ${dir}; choose a new run directory`);
    }
  }
}

/** Continue a run started earlier: the directory must already exist. */
export function requireRunDirectory(dir) {
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a run directory`);
}

/** Create a new output file; fails (EEXIST) instead of overwriting existing evidence. */
export function writeNew(path, data) {
  writeFileSync(path, data, { flag: "wx" });
}

/** Create, or accept an existing byte-identical file (deterministic intermediates). Never replaces. */
export function writeNewOrIdentical(path, data) {
  try {
    writeNew(path, data);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (!readFileSync(path).equals(bytes)) throw new Error(`refusing to replace different existing output ${path}`);
  }
}
