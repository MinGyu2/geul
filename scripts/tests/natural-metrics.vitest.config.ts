// Release-WASM natural font metric tests (requires a built, authenticated Release generation).
// Kept outside the ordinary frontend-only test collection.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    environment: "jsdom",
    include: ["scripts/tests/natural-metrics.wasm.test.ts"],
  },
});
