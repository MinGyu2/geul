import { loadTestEngine, testPackage } from "./test-package";
// T010 Phase 2 성능 측정(선택 실행, GEUL_PERF=1): 제품 RhwpEditorSession(기록 포함)을 실제 WASM으로 열어 큰 공개 예제(external/rhwp/
// samples — 업스트림 공개 시험 문서)에서 실행 취소·다시 실행·그룹 시작 타자의 시간과 메모리를 잰다. node + jsdom(그리기 없음)
// 이므로 WebView 끝단 지연이 아니다(세션 메서드 시간 = 엔진 복원·스냅숏 + 쪽 정보 다시 읽기).
//   GEUL_PERF=1 [GEUL_PERF_OUT=결과.json] npx vitest run --config tests/integration/rhwp/vitest.config.ts history-perf
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentSessions } from "../../../src/adapters/sessions";
import { RhwpEditorSession } from "../../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "../../../src/components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, flush, info, loaded, ok } from "../../../src/components/Editor/rhwp/testing";

const ROOT = resolve(__dirname, "../../..");
// 세션이 실제로 여는 큰 공개 예제(쪽 정보가 문서 전체 번호인 것 — 여러 구역 문서는 지금 세션이 열지 못한다, 별도 결함).
const SAMPLES = [
  "external/rhwp/samples/rnote/연구노트(화학).hwp",
  "external/rhwp/samples/정책연구용역사업 중간진도보고서(살아있는 간장 기증자의 의학적 선별기준 연구).hwpx",
  "external/rhwp/samples/issue_2148_degenerate_cell_vpos.hwpx",
];
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
  return { n: s.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +s[s.length - 1]!.toFixed(1) };
};

describe.runIf(process.env.GEUL_PERF)("실행 취소 성능(큰 공개 예제, 실제 WASM 세션)", () => {
  it("큰 HWP·HWPX·아주 큰 HWP", async () => {
    const mod = loadTestEngine(ROOT);
    const wasm = mod.initSync({ module: readFileSync(join(testPackage(ROOT), "rhwp_bg.wasm")) }) as { memory: WebAssembly.Memory };
    const rows: unknown[] = [];
    for (const path of SAMPLES) {
      const fmt = path.endsWith(".hwpx") ? "hwpx" : "hwp";
      const bytes = new Uint8Array(readFileSync(join(ROOT, path)));
      const { backend, take } = controlledBackend();
      const sessions = new DocumentSessions(backend);
      const opening = sessions.open(`/big.${fmt}`);
      take("open").reply(ok({ ...base, format: fmt }));
      await opening;
      const module: RhwpModule = { openDocument: (b) => new mod.HwpDocument(b) as RhwpDocument };
      const editor = new RhwpEditorSession(1, backend, sessions, async () => module, { history: true }); // 실행 취소 기록을 켠 구성(시험 활성화 빌드와 같음)
      const t0 = performance.now();
      const loading = editor.load();
      take("load").reply(loaded(bytes));
      await flush();
      take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
      take("setState").reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
      await loading;
      const openMs = performance.now() - t0;
      const memBefore = wasm.memory.buffer.byteLength;
      const rssBefore = process.memoryUsage().rss;
      const snapshot = editor.snapshot();
      const row: Record<string, unknown> = { sample: path.split("/").pop(), fmt, status: editor.status, fileBytes: statSync(join(ROOT, path)).size, openMs: +openMs.toFixed(0),
        historyEnabled: snapshot.history !== null, historyLimited: snapshot.historyLimited, pages: editor.pages.length };
      if (snapshot.history) {
        const groupStart: number[] = [], extend: number[] = [];
        for (let k = 0; k < 12; k++) {
          editor.moveHorizontal(1, false); // 그룹을 끊는다 → 다음 글자가 그룹 시작(스냅숏)
          let t = performance.now();
          editor.typeText("가");
          groupStart.push(performance.now() - t);
          t = performance.now();
          editor.typeText("나"); // 같은 그룹(스냅숏 없음)
          extend.push(performance.now() - t);
        }
        const undo: number[] = [], redo: number[] = [];
        for (let k = 0; k < 8; k++) {
          let t = performance.now();
          expect(editor.undo()).toBe(true);
          undo.push(performance.now() - t);
          t = performance.now();
          expect(editor.redo()).toBe(true);
          redo.push(performance.now() - t);
        }
        Object.assign(row, { groupStartMs: stats(groupStart), extendMs: stats(extend), undoMs: stats(undo), redoMs: stats(redo),
          wasmMemoryGrowthBytes: wasm.memory.buffer.byteLength - memBefore, rssGrowthBytes: process.memoryUsage().rss - rssBefore });
      }
      rows.push(row);
      console.log(JSON.stringify(row));
      editor.dispose();
    }
    if (process.env.GEUL_PERF_OUT) writeFileSync(process.env.GEUL_PERF_OUT, JSON.stringify({ environment: "node + jsdom, 실제 WASM, 그리기 없음(WebView 아님)", rows }, null, 1) + "\n");
  }, 900_000);
});
