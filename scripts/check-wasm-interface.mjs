// Validate generated binaries and reject optimizer changes to the JS/WASM ABI.
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const [beforePath, afterPath, reportPath] = process.argv.slice(2);
const before = await WebAssembly.compile(readFileSync(beforePath));
const after = await WebAssembly.compile(readFileSync(afterPath));
const sorted = (values) => values.map((value) => JSON.stringify(value)).sort();
const beforeExports = sorted(WebAssembly.Module.exports(before));
const afterExports = sorted(WebAssembly.Module.exports(after));
assert.deepEqual(afterExports, beforeExports, "wasm-opt changed exports");
const beforeImports = new Set(sorted(WebAssembly.Module.imports(before)));
const afterImports = sorted(WebAssembly.Module.imports(after));
assert(afterImports.every((entry) => beforeImports.has(entry)), "wasm-opt added runtime imports");
writeFileSync(reportPath, JSON.stringify({ valid: true, exportCount: afterExports.length,
  importsBefore: [...beforeImports], importsAfter: afterImports, exports: afterExports }, null, 2) + "\n");
