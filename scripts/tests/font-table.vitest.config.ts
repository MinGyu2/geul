// This integration test requires a built, authenticated Release WASM generation.
// Keep it outside the ordinary frontend-only test collection.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    environment: "jsdom",
    include: ["scripts/tests/document-font-table.wasm.test.ts"],
  },
});
