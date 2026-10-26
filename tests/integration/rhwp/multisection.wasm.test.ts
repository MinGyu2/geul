import { loadTestEngine, testPackage, wasmMemoryBytes } from "./test-package";
// 여러 구역 문서의 쪽 계약(T010 Phase 2 안정화 A): 고정 rhwp는 getPageInfo(page)의 pageIndex를 구역 안 순번으로 주고, 쪽 번호 인자·
// 그리기·hit test·커서·선택 사각형은 문서 전체 물리 순번을 쓴다. 제품 RhwpEditorSession을 실제 WASM으로 열어 공개 예제(external/rhwp/
// samples)의 여러 구역 HWP·HWPX가 열리고, 구역 경계 앞뒤 쪽에서 클릭한 쪽·커서 쪽·선택 쪽이 같은 물리 쪽이며, 편집·실행 취소 뒤에도
// 쪽 정보가 맞는지 본다. 이 시험은 고치기 전 readPages(pageIndex === page)에서 여러 구역 문서가 열리지 않아 실패한다.
//   npx vitest run --config tests/integration/rhwp/vitest.config.ts multisection
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DocumentSessions } from "../../../src/adapters/sessions";
import { RhwpEditorSession } from "../../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "../../../src/components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, flush, info, loaded, ok } from "../../../src/components/Editor/rhwp/testing";

const ROOT = resolve(__dirname, "../../..");
type Doc = RhwpDocument & { getTextFileText(): string };
let engine: { HwpDocument: new (bytes: Uint8Array) => Doc };
let memoryBytes: () => number;
beforeAll(async () => {
  const mod = loadTestEngine(ROOT);
  memoryBytes = wasmMemoryBytes(mod.initSync({ module: readFileSync(join(testPackage(ROOT), "rhwp_bg.wasm")) }));
  engine = mod;
});

const S = "external/rhwp/samples";
/** 공개 예제: (경로, 기대 불러오기 결과). 쪽 수·구역 수·쪽 크기 종류는 고정 rhwp 1a76570 실측. */
const MULTI = [
  [`${S}/issue6782/1480000-201900042-chemical-product-labeling-study.hwp`, "hwp"], // 103쪽, 7구역, 쪽 크기 2종
  [`${S}/aift.hwp`, "hwp"], // 74쪽, 3구역
  [`${S}/issue6031/3249937_asset_management_rules.hwpx`, "hwpx"], // 60쪽, 3구역, 쪽 크기 2종
  [`${S}/issue2006/1790387_prep_final_report.hwpx`, "hwpx"], // 140쪽, 4구역(20MB)
] as const;
/** 진짜 그리기 예산 초과(모든 쪽 비트맵 합 > MAX_RENDER_PIXELS, 최소 배율): 쪽 번호 해석과 별개로 RenderLimit이어야 한다. */
const OVER_BUDGET = [
  [`${S}/issue6764/1613000-202200037-air-traffic-controller-cbta.hwp`, "hwp"], // 202쪽, 5구역
  [`${S}/정책연구용역사업 중간진도보고서(살아있는 간장 기증자의 의학적 선별기준 연구).hwpx`, "hwpx"], // 215쪽, 1구역
] as const;

async function open(path: string, fmt: "hwp" | "hwpx") {
  const { backend, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open(`/m.${fmt}`);
  take("open").reply(ok({ ...base, format: fmt }));
  await opening;
  let doc: Doc | null = null;
  const module: RhwpModule = { openDocument: (b) => { const d = new engine.HwpDocument(b); doc ??= d; return d; }, memoryBytes: () => memoryBytes() };
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module, { history: true }); // 실행 취소 기록을 켠 구성(시험 활성화 빌드와 같음)
  const loading = editor.load();
  take("load").reply(loaded(new Uint8Array(readFileSync(join(ROOT, path)))));
  await flush();
  take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
  const ready = take("setState");
  ready.reply(ok(info({ state: ready.args[3] === "ready" ? "ready" : "failed", sequence: 2, loadGeneration: 1 })));
  await loading;
  return { editor, doc: () => doc! };
}

/** 문서의 구역 경계(물리 쪽 번호): 각 구역의 첫 쪽. */
function boundaries(doc: Doc): number[] {
  const firsts: number[] = [];
  let last = -1;
  for (let p = 0; p < doc.pageCount(); p++) {
    const s = JSON.parse(doc.getPageInfo(p)).sectionIndex as number;
    if (s !== last) firsts.push(p);
    last = s;
  }
  return firsts;
}

/** 쪽의 본문 어딘가를 클릭해 커서를 둔다(쪽 높이의 여러 자리를 차례로). 커서 쪽을 돌려준다. */
function clickPage(editor: RhwpEditorSession, page: number): number | null {
  const size = editor.pages[page]!;
  for (const y of [0.3, 0.5, 0.2, 0.7, 0.4, 0.6]) {
    if (!editor.pointAt(page, size.width / 2, size.height * y, false)) continue;
    const rect = editor.caretRect();
    if (rect) return rect.page;
  }
  return null;
}

describe.each(MULTI)("여러 구역 문서 %s", (path, fmt) => {
  it("열리고, 구역 경계 앞뒤 쪽의 클릭·커서·선택이 같은 물리 쪽이며, 편집·실행 취소 뒤에도 쪽 정보가 맞음", async () => {
    const { editor, doc } = await open(path, fmt);
    expect(editor.status).toEqual({ kind: "ready" });
    const d = doc();
    expect(editor.pages.length).toBe(d.pageCount());
    for (let p = 0; p < d.pageCount(); p++) {
      const i = JSON.parse(d.getPageInfo(p));
      expect(editor.pages[p]).toEqual({ width: i.width, height: i.height });
    }
    const firsts = boundaries(d);
    expect(firsts.length).toBeGreaterThan(1);
    const checked: number[] = [];
    for (const first of firsts.slice(1)) {
      for (const page of [first - 1, first]) {
        const caretPage = clickPage(editor, page);
        if (caretPage === null) continue; // 그 쪽에 클릭할 본문이 없음(빈 쪽·그림만)
        expect(caretPage).toBe(page);
        checked.push(page);
        // 선택: 한 글자 넓힌 선택 사각형도 같은 물리 쪽(줄 끝이면 다음 줄일 수 있어 쪽은 같거나 다음).
        if (editor.moveHorizontal(1, true)) {
          for (const rect of editor.selectionRects()) expect([page, page + 1]).toContain(rect.page);
          editor.moveHorizontal(-1, false);
        }
      }
    }
    expect(checked.length).toBeGreaterThan(0);
    // 뒤 구역 첫 쪽에서 편집 → 쪽 정보 다시 읽기(구역 계약 그대로) → 실행 취소 → 같은 쪽 수·같은 본문.
    const target = firsts[1]!;
    expect(clickPage(editor, target)).toBe(target);
    const text = d.getTextFileText();
    const pages = editor.pages.length;
    expect(editor.typeText("가")).toBe(true);
    expect(editor.status).toEqual({ kind: "ready" });
    expect(editor.caretRect()?.page).toBe(target);
    expect(editor.enter()).toBe(true);
    expect(editor.status).toEqual({ kind: "ready" });
    expect(editor.undo()).toBe(true);
    expect(editor.undo()).toBe(true);
    expect(d.getTextFileText()).toBe(text);
    expect(editor.pages.length).toBe(pages);
    expect(editor.caretRect()?.page).toBe(target);
    expect(editor.redo()).toBe(true);
    expect(editor.status).toEqual({ kind: "ready" });
    // 위·아래 이동은 엔진 이동(구역을 넘을 수 있음): 커서 쪽이 늘 엔진의 커서 사각형과 같은 물리 쪽.
    for (let k = 0; k < 6; k++) {
      editor.moveVertical(-1, false);
      const rect = editor.caretRect();
      expect(rect).not.toBeNull();
      expect(rect!.page).toBeLessThanOrEqual(target);
    }
    editor.dispose();
    expect(editor.status).toEqual({ kind: "closed" });
  });
});

it("표가 아닌 컨트롤을 셀로 돌려주는 hit test(exam_kor.hwp, 구역 경계 쪽)는 커서를 옮기지 않고 문서를 바꾸지 않음", async () => {
  const { editor, doc } = await open(`${S}/exam_kor.hwp`, "hwp");
  expect(editor.status).toEqual({ kind: "ready" });
  const d = doc();
  const text = d.getTextFileText();
  const page = boundaries(d)[1]!;
  const size = editor.pages[page]!;
  const raw = JSON.parse(d.hitTest(page, size.width / 2, size.height * 0.3));
  expect(raw.parentParaIndex).toBeDefined(); // 엔진은 셀 위치처럼 돌려주지만
  expect(() => d.getTableDimensions(raw.sectionIndex, raw.parentParaIndex, raw.controlIndex)).toThrow(); // 표가 아니다
  const caret = editor.caret;
  expect(editor.pointAt(page, size.width / 2, size.height * 0.3, false)).toBe(false);
  expect(editor.caret).toEqual(caret);
  expect(editor.typeText("가")).toBe(true); // 원래 커서 자리(문서 처음)에 들어가고 편집은 계속된다
  expect(editor.status).toEqual({ kind: "ready" });
  expect(editor.undo()).toBe(true);
  expect(d.getTextFileText()).toBe(text);
  editor.dispose();
});

describe.each(OVER_BUDGET)("그리기 예산 초과 %s", (path, fmt) => {
  it("쪽 정보 해석은 통과하고 RenderLimit으로 거부(EngineFailure가 아님)", async () => {
    const { editor } = await open(path, fmt);
    expect(editor.status).toEqual({ kind: "failed", error: { code: "RenderLimit" } });
  });
});
