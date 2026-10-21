// T010 Phase 0 PoC 전용 Vitest 설정: 이 디렉터리의 *.poc.test.ts만 돈다(저장소 `npm test`의 대상에는 들어가지 않음).
//   npx vitest run --config tests/poc/t010-phase0/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    environment: "jsdom",
    include: ["tests/poc/t010-phase0/**/*.poc.test.ts"],
    testTimeout: 60_000,
  },
});
