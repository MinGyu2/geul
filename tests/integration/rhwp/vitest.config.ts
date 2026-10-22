// T010 Phase 2 실제 rhwp WASM 통합 시험 설정. 고정 rhwp 빌드 산출물(public/rhwp, scripts/build-rhwp-wasm.sh)이 있어야 하므로 저장소
// `npm test`(src/**)에는 넣지 않는다(CI는 submodule을 받지 않는다).
//   npx vitest run --config tests/integration/rhwp/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["tests/integration/rhwp/**/*.wasm.test.ts"],
    testTimeout: 120_000,
  },
});
