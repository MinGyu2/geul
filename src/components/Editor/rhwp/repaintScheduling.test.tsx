// 8차: 바뀐 띠만 다시 그리기(레이어 트리 비교)와 여러 쪽 그리기 순서의 회귀(합성 이벤트·가짜 엔진). 실제 픽셀 동일성·지연·
// long task는 실제 앱에서 따로 잰다(editor-surface-decision.md "T007 8차").
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentSessions } from "../../../adapters/sessions";
import { LanguageProvider } from "../../../language/LanguageContext";
import { RhwpEditorSession } from "./RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
import { RhwpSurface } from "./RhwpSurface";
import { base, controlledBackend, FakeDocument, flush, info, loaded, ok } from "./testing";

type Draw = { kind: "full" | "patch"; page: number; text: string; rect?: number[]; task: number };

/**
 * rhwp처럼 레이어 트리를 준다. 0쪽은 문단마다 잎 하나(문단 i의 글자는 y = 20i + 3, 높이 14). 다른 쪽은 문서 전체 글에 따라
 * 바뀌는 연산 하나(앞 쪽 편집이 뒤 쪽을 다시 흘리는 것).
 */
class LayeredDocument extends FakeDocument {
  draws: Draw[] = [];
  pages = 1;
  /** 쪽 크기(CSS px). */
  size = { width: 800, height: 1000 };
  onPatch: ((canvas: HTMLCanvasElement) => void) | null = null;
  treeError = false;
  /** 같은 동기 실행(한 task) 안의 그리기는 같은 번호. */
  private task = 0;
  private inTask = false;
  private taskId() {
    if (!this.inTask) {
      this.inTask = true;
      this.task += 1;
      queueMicrotask(() => { this.inTask = false; });
    }
    return this.task;
  }

  pageCount() { return this.pages; }
  override getPageInfo(page: number) { return JSON.stringify({ pageIndex: page, sectionIndex: 0, ...this.size }); }
  /** pinned rhwp normalize_canvas_scale: 0.25..12, 각 변 16,384 px 이하. */
  engineScale(scale: number) {
    return Math.min(Math.max(0.25, Math.min(12, scale)), 16_384 / this.size.width, 16_384 / this.size.height);
  }
  getPageLayerTreeWithProfile(page: number) {
    if (this.treeError) throw new Error("portable metrics");
    const leaves = page === 0
      ? this.paragraphs.map((text, i) => ({ kind: "leaf", sourceNodeId: 10 + i, ops: [{ type: "textRun", text, bbox: { x: 0, y: 20 * i + 3, width: 10 * text.length, height: 14 } }] }))
      : [{ kind: "leaf", sourceNodeId: 10, ops: [{ type: "textRun", text: `${page}:${this.paragraphs.join("/")}`, bbox: { x: 0, y: 500, width: 100, height: 14 } }] }];
    return JSON.stringify({ root: { kind: "group", sourceNodeId: 0, children: leaves } });
  }
  renderPageToCanvas(page = 0, canvas?: HTMLCanvasElement, scale = 1) {
    canvas!.width = Math.ceil(this.size.width * this.engineScale(scale));
    canvas!.height = Math.ceil(this.size.height * this.engineScale(scale));
    this.draws.push({ kind: "full", page, text: this.paragraphs.join("/"), task: this.taskId() });
  }
  renderPagePatchToCanvasFilteredWithProfile(page: number, canvas: HTMLCanvasElement, _scale: number, _layer: string, _profile: string,
    x: number, y: number, width: number, height: number) {
    this.onPatch?.(canvas);
    this.draws.push({ kind: "patch", page, text: this.paragraphs.join("/"), rect: [x, y, width, height], task: this.taskId() });
  }
}

async function mounted({ pages = 1, zoom = 100, text = ["가나다"], size = { width: 800, height: 1000 } } = {}) {
  const { backend, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwp");
  take("open").reply(ok(base));
  await opening;
  const doc = new LayeredDocument(text);
  doc.pages = pages;
  doc.size = size;
  const module: RhwpModule = { openDocument: () => doc as unknown as RhwpDocument, memoryBytes: () => 64 * 1024 * 1024 };
  // Undo/Redo 그리기 순서를 보는 시험이 있어 기록을 켠 구성(시험 활성화 빌드와 같음)으로 연다.
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module, { history: true });
  const loading = editor.load();
  take("load").reply(loaded());
  await flush();
  take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
  take("setState").reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
  await loading;
  const view = render(
    <LanguageProvider language="ko" onLanguageChange={() => {}}>
      <div className="editor__scroll"><RhwpSurface session={editor} zoom={zoom} /></div>
    </LanguageProvider>,
  );
  const input = view.container.querySelector<HTMLTextAreaElement>(".rhwp-input")!;
  const fire = (event: Event) => act(() => void input.dispatchEvent(event));
  const type = (text: string) => {
    fire(new InputEvent("beforeinput", { inputType: "insertText", data: text, cancelable: true }));
    input.value += text;
    fire(new InputEvent("input", { inputType: "insertText", data: text }));
  };
  const scroller = view.container.querySelector<HTMLDivElement>(".editor__scroll")!;
  return { editor, doc, view, input, fire, type, scroller };
}

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const pagesDrawn = (draws: Draw[]) => draws.map((d) => d.page);
/** 처음 그리기가 모든 쪽에 닿을 때까지 기다린다(실행 부하와 관계없이). */
async function converged(doc: LayeredDocument) {
  for (let i = 0; i < 400 && new Set(pagesDrawn(doc.draws)).size < doc.pages; i++) await wait(5);
  expect(new Set(pagesDrawn(doc.draws)).size).toBe(doc.pages);
}
/** 가짜 시계로 ms만큼 진행(입력 사이 간격이 실행 부하로 늘어나지 않게). */
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
/** Run one queued viewport-render timer without advancing the idle delay. */
const nextRenderTask = () => act(async () => { vi.advanceTimersToNextTimer(); await Promise.resolve(); });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** jsdom에는 ResizeObserver가 없다. 크기가 바뀐 것처럼 콜백을 부를 수 있는 흉내. */
function fakeResizeObserver() {
  const observers: { callback: ResizeObserverCallback; targets: Element[]; live: boolean }[] = [];
  vi.stubGlobal("ResizeObserver", class {
    private entry: (typeof observers)[number];
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: [], live: true };
      observers.push(this.entry);
    }
    observe(target: Element) { this.entry.targets.push(target); }
    unobserve() {}
    disconnect() { this.entry.live = false; }
  });
  return {
    observers,
    resized: () => act(() => {
      for (const o of observers) if (o.live) o.callback([], o as unknown as ResizeObserver);
    }),
  };
}

/** 스크롤 영역에 [top, bottom)이 보이고, 쪽 p는 세로로 [1010p, 1010p + 1000)에 있다고 둔다. */
function layout(view: { top: number; bottom: number }) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const box = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 800, x: 0, y: top, width: 800, height: bottom - top, toJSON: () => ({}) }) as DOMRect;
    if (this.classList.contains("editor__scroll")) return box(view.top, view.bottom);
    const page = this.dataset.page;
    if (page !== undefined) return box(1010 * Number(page), 1010 * Number(page) + 1000);
    return box(0, 0);
  });
}

describe("바뀐 띠만 다시 그리기", () => {
  it("한 문단 안의 편집은 그 문단 띠만(Canvas 픽셀 경계에 맞춰 바깥쪽으로) 다시 그린다", async () => {
    const t = await mounted({ zoom: 150, text: ["가나다", "abc", "def"] });
    await wait(10);
    t.doc.draws = [];
    act(() => void t.editor.moveVertical(1, false));
    t.type("x");
    const patch = t.doc.draws.find((d) => d.kind === "patch")!;
    expect(patch).toBeTruthy();
    const [x, y, width, height] = patch.rect as [number, number, number, number];
    expect([x, width]).toEqual([0, 800]);
    // 문단 1: 23..37, 여유 14 → 9..51. 1.5배에서 위아래가 정수 Canvas 픽셀.
    expect(y).toBeLessThanOrEqual(9);
    expect(y + height).toBeGreaterThanOrEqual(51);
    expect(height).toBeLessThan(1000);
    for (const edge of [y * 1.5, (y + height) * 1.5]) expect(Math.abs(edge - Math.round(edge))).toBeLessThan(1e-6);
    expect(t.editor.documentText()).toBe("가나다\r\nxabc\r\ndef");
  });

  it("문단이 생기면(구조가 바뀜) 쪽 전체를 다시 그린다", async () => {
    const t = await mounted({ text: ["가나다", "abc"] });
    await wait(10);
    t.doc.draws = [];
    t.fire(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(t.doc.paragraphs).toHaveLength(3);
    expect(t.doc.draws.at(-1)).toMatchObject({ kind: "patch", page: 0, rect: [0, 0, 800, 1000] });
  });

  it("그린 입력이 지금과 같은 쪽은 다시 그리지 않는다", async () => {
    const t = await mounted({ pages: 2 });
    await converged(t.doc);
    const canvas = t.view.container.querySelectorAll("canvas")[1]!;
    t.doc.draws = [];
    expect(t.editor.renderPage(1, canvas, 1)).toBe(true);
    expect(t.doc.draws).toEqual([]);
  });

  it("띠 다시 그리기 동안 Canvas의 fillRect는 띠와 겹치는 부분만 칠하고, 끝나면 원래대로 돌아간다", async () => {
    const fills: number[][] = [];
    const context = {
      fillRect(x: number, y: number, width: number, height: number) { fills.push([x, y, width, height]); },
      getTransform: () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }),
    };
    const original = context.fillRect;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const t = await mounted({ zoom: 200, text: ["가나다", "abc", "def"] });
    await wait(10);
    t.doc.onPatch = (canvas) => (canvas.getContext("2d") as unknown as typeof context).fillRect(0, 0, 800, 1000); // rhwp: 쪽 배경
    act(() => void t.editor.moveVertical(1, false));
    t.type("x");
    const patch = t.doc.draws.find((d) => d.kind === "patch")!;
    const [, y, , height] = patch.rect as [number, number, number, number];
    expect(fills).toEqual([[0, y, 800, height]]);
    expect(context.fillRect).toBe(original);
  });
});

describe("엔진 배율과 띠 좌표(9차)", () => {
  /** Canvas 2D 문맥 흉내: fillRect를 모으고, 변환은 엔진 배율(begin_page의 setTransform + scale). */
  function fakeContext(scale: () => number) {
    const fills: number[][] = [];
    const context = {
      fillRect(x: number, y: number, width: number, height: number) { fills.push([x, y, width, height]); },
      getTransform: () => ({ a: scale(), b: 0, c: 0, d: scale(), e: 0, f: 0 }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    return { context, fills, original: context.fillRect };
  }
  const withRatio = (ratio: number) => {
    const previous = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    Object.defineProperty(window, "devicePixelRatio", { value: ratio, configurable: true });
    return () => {
      if (previous) Object.defineProperty(window, "devicePixelRatio", previous);
      else delete (window as { devicePixelRatio?: number }).devicePixelRatio;
    };
  };
  async function editSecondParagraph(options: { zoom: number; ratio: number; size: { width: number; height: number } }) {
    const restoreRatio = withRatio(options.ratio);
    try {
      let engine = 1;
      const fake = fakeContext(() => engine);
      const t = await mounted({ zoom: options.zoom, size: options.size, text: ["가나다", "abc", "def"] });
      engine = t.doc.engineScale((options.zoom / 100) * options.ratio);
      await wait(10);
      t.doc.onPatch = (canvas) => (canvas.getContext("2d") as unknown as typeof fake.context).fillRect(0, 0, options.size.width, options.size.height);
      t.doc.draws = [];
      act(() => void t.editor.moveVertical(1, false));
      t.type("x");
      expect(t.editor.documentText()).toBe("가나다\r\nxabc\r\ndef");
      expect(fake.context.fillRect).toBe(fake.original);
      const patch = t.doc.draws.find((d) => d.kind === "patch");
      return { draws: t.doc.draws, rect: patch?.rect as [number, number, number, number], fills: fake.fills, engine };
    } finally {
      restoreRatio();
    }
  }

  const a4 = { width: 793.7, height: 1122.5 };
  it.each([
    [50, 1], [100, 1], [200, 1], [50, 2], [100, 2], [200, 2], [67, 1.25], [110, 1.25], [175, 1.5],
  ])("요청 배율 그대로 그리는 쪽(A4, zoom %i, DPR %f): 띠만, 경계는 정수 Canvas 픽셀, fillRect는 띠 안", async (zoom, ratio) => {
    const { draws, rect: [x, y, width, height], fills, engine } = await editSecondParagraph({ zoom, ratio, size: a4 });
    expect(engine).toBe((zoom / 100) * ratio);
    expect(draws.map((d) => d.kind)).toEqual(["patch"]);
    expect([x, width]).toEqual([0, a4.width]);
    expect(y).toBeLessThanOrEqual(9);
    expect(y + height).toBeGreaterThanOrEqual(51);
    expect(height).toBeLessThan(a4.height);
    for (const edge of [y * engine, (y + height) * engine]) expect(Math.abs(edge - Math.round(edge))).toBeLessThan(1e-6);
    expect(fills).toHaveLength(1);
    expect(fills[0]![1]).toBeCloseTo(y, 9);
    expect(fills[0]![3]).toBeCloseTo(height, 9);
  });

  it("좁고 긴 쪽도 한 변이 한도 안이면 띠만 그린다(300×6000, 배율 2)", async () => {
    const { draws, rect, fills } = await editSecondParagraph({ zoom: 200, ratio: 1, size: { width: 300, height: 6000 } });
    expect(draws.map((d) => d.kind)).toEqual(["patch"]);
    expect(rect[3]).toBeLessThan(6000);
    expect(fills).toHaveLength(1);
  });

  it.each([
    ["좁고 긴 쪽, 한 변이 16,384 px를 넘음", 200, 2, { width: 300, height: 6000 }],
    ["넓고 짧은 쪽, 한 변이 16,384 px를 넘음", 200, 2, { width: 6000, height: 80 }],
    ["한도 바로 위(1 CSS px 여유 안)", 200, 2, { width: 200, height: 4096 }],
    ["엔진 최대 배율 12를 넘는 요청", 200, 6.5, { width: 100, height: 100 }],
    ["엔진 최소 배율 0.25보다 작은 요청", 50, 0.4, { width: 800, height: 1000 }],
  ])("엔진이 배율을 바꾸는 쪽(%s)은 띠·그 자리 패치 없이 처음 그리기와 같은 전체 그리기를 쓴다", async (_name, zoom, ratio, size) => {
    const { draws, fills, engine } = await editSecondParagraph({ zoom, ratio, size });
    if (size.height !== 4096) expect(engine).not.toBe((zoom / 100) * ratio);
    expect(draws.map((d) => [d.kind, d.page, d.text])).toEqual([["full", 0, "가나다/xabc/def"]]);
    expect(fills).toEqual([]); // fillRect를 바꾸지 않았다(전체 그리기는 가짜 엔진이 칠하지 않음)
  });

  it("엔진이 그리다 던져도 fillRect를 돌려놓고, 전체 그리기로 다시 그린다", async () => {
    const fake = fakeContext(() => 2);
    const t = await mounted({ zoom: 200, text: ["가나다", "abc", "def"] });
    await wait(10);
    t.doc.onPatch = (canvas) => {
      (canvas.getContext("2d") as unknown as typeof fake.context).fillRect(0, 0, 800, 1000);
      throw new Error("render");
    };
    t.doc.draws = [];
    act(() => void t.editor.moveVertical(1, false));
    t.type("x");
    expect(fake.context.fillRect).toBe(fake.original);
    expect(t.doc.draws.map((d) => d.kind)).toEqual(["full"]);
    expect(fake.fills).toHaveLength(1);
    expect(fake.fills[0]![3]).toBeLessThan(1000); // 던지기 전의 칠하기만 제한됐다
    expect(t.editor.status.kind).toBe("ready");
  });

  it("레이어 트리를 읽지 못하면 비교하지 않고 쪽 전체를 다시 그린다", async () => {
    const fake = fakeContext(() => 1);
    const t = await mounted({ text: ["가나다", "abc"] });
    await wait(10);
    t.doc.treeError = true;
    t.doc.onPatch = (canvas) => (canvas.getContext("2d") as unknown as typeof fake.context).fillRect(0, 0, 800, 1000);
    t.doc.draws = [];
    t.type("x");
    expect(t.doc.draws).toMatchObject([{ kind: "patch", rect: [0, 0, 800, 1000] }]);
    expect(fake.fills).toEqual([[0, 0, 800, 1000]]);
  });
});

describe("여러 쪽 그리기 순서", () => {
  it("입력 뒤 먼 쪽은 dirty로 보존하고, 스크롤·resize에서 최신 판만 그린다", async () => {
    const ro = fakeResizeObserver();
    const view = { top: 0, bottom: 1500 };
    layout(view);
    const t = await mounted({ pages: 12 });
    await converged(t.doc);
    vi.useFakeTimers();
    t.doc.draws = [];
    t.type("a");
    advance(1000);
    expect(new Set(pagesDrawn(t.doc.draws))).toEqual(new Set([0, 1, 2, 3]));
    t.type("b");
    advance(20);
    view.top = 8080; view.bottom = 9580; // 먼 8·9쪽은 idle 순회가 아니라 보이는 즉시 갱신
    act(() => void t.scroller.dispatchEvent(new Event("scroll")));
    expect(t.doc.draws.filter(d => d.page === 8 || d.page === 9)).toEqual([]);
    await nextRenderTask(); await nextRenderTask();
    expect(t.doc.draws.filter(d => d.page === 8 || d.page === 9).map(d => d.text)).toEqual(["ab가나다", "ab가나다"]);
    advance(1000);
    expect(t.doc.draws.some(d => d.page === 4 || d.page === 5)).toBe(false);
    expect(t.doc.draws.filter(d => d.page >= 6).every(d => d.text === "ab가나다")).toBe(true);
    t.type("c");
    advance(20);
    view.top = 4040; view.bottom = 5540;
    ro.resized();
    expect(t.doc.draws.filter(d => d.page === 4 || d.page === 5)).toEqual([]);
    await nextRenderTask(); await nextRenderTask();
    expect(t.doc.draws.filter(d => d.page === 4 || d.page === 5).map(d => d.text)).toEqual(["abc가나다", "abc가나다"]);
    t.view.unmount();
    const before = t.doc.draws.length;
    advance(1000);
    expect(t.doc.draws).toHaveLength(before);
  });

  it("처음 그리기: 커서 쪽을 바로, 나머지는 커서 쪽에서 가까운 쪽부터 한 task에 한 쪽씩 그린다", async () => {
    const t = await mounted({ pages: 5 });
    expect(pagesDrawn(t.doc.draws)).toEqual([0]);
    await converged(t.doc);
    expect(pagesDrawn(t.doc.draws)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(t.doc.draws.map((d) => d.task)).size).toBe(5); // 한 task가 여러 쪽을 그리지 않음
  });

  it("입력 중: 보이는 쪽은 바로, 화면 밖 쪽은 입력이 멈춘 뒤 마지막 모델로 그린다", async () => {
    layout({ top: 0, bottom: 1500 }); // 0·1쪽이 보임
    const t = await mounted({ pages: 4 });
    await converged(t.doc);
    vi.useFakeTimers();
    t.doc.draws = [];
    for (const key of ["a", "b", "c"]) {
      t.type(key);
      advance(30);
    }
    const early = [...t.doc.draws];
    expect(new Set(pagesDrawn(early))).toEqual(new Set([0, 1]));
    expect(early.filter((d) => d.page === 1).at(-1)!.text).toBe("abc가나다"); // 보이는 쪽은 옛 그림으로 남지 않음
    advance(260);
    const late = t.doc.draws.slice(early.length);
    expect(pagesDrawn(late)).toEqual([2, 3]);
    expect(late.every((d) => d.text === "abc가나다")).toBe(true);
  });

  it("처음 그리기를 입력이 끊으면: 아직 그림이 없는 화면 밖 쪽도 바로 그리지 않고 쉬는 시간에, 보이면 바로 그린다", async () => {
    const view = { top: 0, bottom: 1500 }; // 0·1쪽이 보임
    layout(view);
    const t = await mounted({ pages: 5 });
    expect(pagesDrawn(t.doc.draws)).toEqual([0]); // 나머지는 아직 그림이 없다(다음 task부터)
    t.doc.draws = [];
    t.type("a"); // 처음 그리기 작업을 취소하고 다시 정한다
    await wait(30);
    // 보이는 쪽만 바로. 그림이 없는 화면 밖 쪽(2·3·4)을 키 직후 전체 그리기로 그리면 다음 키가 그만큼 늦는다(T010 실측).
    expect(new Set(pagesDrawn(t.doc.draws))).toEqual(new Set([0, 1]));
    view.top = 2000; view.bottom = 3500; // 2·3쪽이 보이게 됨
    act(() => void t.scroller.dispatchEvent(new Event("scroll")));
    await wait(10);
    expect(new Set(pagesDrawn(t.doc.draws))).toEqual(new Set([0, 1, 2, 3]));
    for (let i = 0; i < 100 && !pagesDrawn(t.doc.draws).includes(4); i++) await wait(10);
    const latest = (page: number) => t.doc.draws.filter((d) => d.page === page).at(-1)?.text;
    expect([0, 1, 2, 3, 4].map(latest)).toEqual(Array(5).fill("a가나다")); // 화면 밖 쪽도 결국 마지막 모델로
  });

  it("Undo/Redo도 보이는 쪽부터 그리고, 화면 밖 작업은 마지막 모델로 한 번만 수행", async () => {
    const view = { top: 0, bottom: 1500 };
    layout(view);
    const t = await mounted({ pages: 4 });
    await converged(t.doc);
    t.type("a"); await wait(260);
    vi.useFakeTimers(); t.doc.draws = [];
    act(() => { expect(t.editor.undo()).toBe(true); });
    advance(30);
    expect(new Set(pagesDrawn(t.doc.draws))).toEqual(new Set([0, 1]));
    expect(t.doc.draws.every(d => d.text === "가나다")).toBe(true);
    // Undo된 모델을 화면 밖 쪽에도 실제로 그린 뒤 Redo한다. 이미 같은 픽셀이면 재그리기를 생략하는
    // paint cache의 정상 동작을 강제로 호출하게 만들지 않는다.
    let early=t.doc.draws.length;
    view.top=2000;view.bottom=3500;
    act(() => void t.scroller.dispatchEvent(new Event("scroll")));
    await nextRenderTask(); await nextRenderTask();
    expect(pagesDrawn(t.doc.draws.slice(early))).toEqual([2,3]);
    expect(t.doc.draws.slice(early).every(d => d.text === "가나다")).toBe(true);
    view.top=0;view.bottom=1500;
    act(() => void t.scroller.dispatchEvent(new Event("scroll")));
    await nextRenderTask(); await nextRenderTask();
    t.doc.draws=[];
    act(() => { expect(t.editor.redo()).toBe(true); });
    advance(30);
    expect(new Set(pagesDrawn(t.doc.draws))).toEqual(new Set([0, 1]));
    early=t.doc.draws.length;
    view.top=2000;view.bottom=3500;
    act(() => void t.scroller.dispatchEvent(new Event("scroll")));
    await nextRenderTask(); await nextRenderTask();
    expect(pagesDrawn(t.doc.draws.slice(early))).toEqual([2,3]);
    expect(t.doc.draws.slice(early).every(d => d.text === "a가나다")).toBe(true);
    advance(260);
    expect(t.doc.draws.length).toBe(early+2); // 옛 Undo 작업·중복 늦은 그리기 없음
  });

  it("그리기를 기다리던 쪽이 스크롤로 보이게 되면 바로 그린다", async () => {
    const view = { top: 0, bottom: 1500 };
    layout(view);
    const t = await mounted({ pages: 4 });
    await converged(t.doc);
    vi.useFakeTimers();
    t.type("a");
    advance(20);
    t.doc.draws = [];
    view.top = 2000;
    view.bottom = 3500; // 2·3쪽이 보임
    act(() => void t.scroller.dispatchEvent(new Event("scroll")));
    expect(t.doc.draws).toEqual([]);
    await nextRenderTask(); await nextRenderTask();
    expect(pagesDrawn(t.doc.draws).sort()).toEqual([2, 3]);
    expect(t.doc.draws.every((d) => d.text === "a가나다")).toBe(true);
    advance(260);
    expect(pagesDrawn(t.doc.draws).sort()).toEqual([2, 3]); // 이미 그린 쪽을 또 그리지 않음
  });

  it("스크롤 없이 스크롤 영역이 커져(창 크기·리본·패널) 보이게 된 쪽은 바로 지금 모델로 그린다", async () => {
    const ro = fakeResizeObserver();
    const view = { top: 0, bottom: 1500 };
    layout(view);
    const t = await mounted({ pages: 4 });
    await converged(t.doc);
    expect(ro.observers.some((o) => o.targets.includes(t.scroller))).toBe(true);
    vi.useFakeTimers();
    t.type("a");
    advance(20);
    t.doc.draws = [];
    view.bottom = 2600; // 2쪽이 보이게 됨(스크롤 이벤트 없음)
    ro.resized();
    expect(t.doc.draws).toEqual([]);
    await nextRenderTask();
    expect(pagesDrawn(t.doc.draws)).toEqual([2]);
    expect(t.doc.draws[0]!.text).toBe("a가나다");
    advance(260);
    expect(pagesDrawn(t.doc.draws)).toEqual([2, 3]); // 기다리던 3쪽만 더(2쪽을 또 그리지 않음)
    ro.resized();
    expect(pagesDrawn(t.doc.draws)).toEqual([2, 3]); // 기다리는 쪽이 없으면 그리지 않음
  });

  it("보이게 된 쪽을 그린 뒤 새 키가 오면 다시 그 키의 모델로 그리고, 옛 작업이 새 모델을 덮지 않는다", async () => {
    const ro = fakeResizeObserver();
    const view = { top: 0, bottom: 1500 };
    layout(view);
    const t = await mounted({ pages: 4 });
    await converged(t.doc);
    vi.useFakeTimers();
    t.type("a");
    advance(20);
    view.bottom = 2600;
    const beforeResize = t.doc.draws.length;
    ro.resized();
    expect(t.doc.draws).toHaveLength(beforeResize);
    await nextRenderTask();
    t.type("b");
    advance(20);
    t.type("c");
    advance(400);
    for (const page of [0, 1, 2, 3]) expect(t.doc.draws.filter((d) => d.page === page).at(-1)!.text).toBe("abc가나다");
    const afterC = t.doc.draws.findIndex((d) => d.text === "abc가나다");
    expect(t.doc.draws.slice(afterC).every((d) => d.text === "abc가나다")).toBe(true);
  });

  it("scroll queues multiple dirty pages without synchronous draws and publishes one latest-version page per timer task", async () => {
    const view = { top: 0, bottom: 500 };
    layout(view);
    const t = await mounted({ pages: 12 });
    await converged(t.doc);
    vi.useFakeTimers();
    t.doc.draws = [];

    t.type("a");
    t.type("b"); // 최신 모델이 되기 전에 예약된 그리기는 실행하지 않는다
    advance(20);
    const beforeScroll = t.doc.draws.length;
    view.top = 8080; view.bottom = 10000; // pages 8 and 9 are both newly visible
    act(() => void t.scroller.dispatchEvent(new Event("scroll")));
    expect(t.doc.draws).toHaveLength(beforeScroll);

    await nextRenderTask();
    expect(t.doc.draws).toHaveLength(beforeScroll + 1);
    await nextRenderTask();
    expect(t.doc.draws).toHaveLength(beforeScroll + 2);
    const visible = t.doc.draws.slice(beforeScroll);
    expect(pagesDrawn(visible).sort()).toEqual([8, 9]);
    expect(visible.map(d => d.text)).toEqual(["ab가나다", "ab가나다"]);
    expect(new Set(visible.map(d => d.task)).size).toBe(visible.length);
  });

  it("keeps a failed viewport render dirty and retries it when that viewport is requested again", async () => {
    const view = { top: 0, bottom: 500 };
    layout(view);
    const t = await mounted({ pages: 8 });
    await converged(t.doc);
    vi.useFakeTimers();
    t.doc.draws = [];
    t.type("a");
    advance(20);
    const original = t.editor.renderPage.bind(t.editor);
    const render = vi.spyOn(t.editor, "renderPage");
    let rejectOnce = true;
    render.mockImplementation((page, canvas, scale) => {
      if (page === 4 && rejectOnce) { rejectOnce = false; return false; }
      return original(page, canvas, scale);
    });

    view.top = 4040; view.bottom = 4540;
    act(() => void t.scroller.dispatchEvent(new Event("scroll")));
    expect(t.doc.draws.some(d => d.page === 4)).toBe(false);
    await nextRenderTask();
    expect(render).toHaveBeenCalledWith(4, expect.any(HTMLCanvasElement), 1);
    expect(t.doc.draws.some(d => d.page === 4)).toBe(false);

    act(() => void t.scroller.dispatchEvent(new Event("scroll")));
    await nextRenderTask();
    expect(t.doc.draws.filter(d => d.page === 4).at(-1)?.text).toBe("a가나다");
    expect(render).toHaveBeenCalledTimes(2);
    render.mockRestore();
  });

  describe("caret-page (first) draw failure", () => {
    /** Reject renderPage for page 0 (the fake caret page) `times` times; later calls draw normally. */
    function rejectFirst(t: Awaited<ReturnType<typeof mounted>>, times: number) {
      const original = t.editor.renderPage.bind(t.editor);
      const render = vi.spyOn(t.editor, "renderPage");
      let remaining = times;
      render.mockImplementation((page, canvas, scale) => {
        if (page === 0 && remaining > 0) { remaining -= 1; return false; }
        return original(page, canvas, scale);
      });
      return { render, firstCalls: () => render.mock.calls.filter(([page]) => page === 0).length };
    }
    const lastText = (t: Awaited<ReturnType<typeof mounted>>, page: number) => t.doc.draws.filter(d => d.page === page).at(-1)?.text;

    it("retries a recoverable failure at the same revision without another edit, then stops", async () => {
      layout({ top: 0, bottom: 1500 });
      const t = await mounted({ pages: 4 });
      await converged(t.doc);
      vi.useFakeTimers();
      const { render, firstCalls } = rejectFirst(t, 1);
      t.type("a");
      expect(firstCalls()).toBe(1);
      expect(lastText(t, 0)).toBe("가나다");
      await nextRenderTask(); // the failed caret page is queued ahead of the other visible page
      expect(firstCalls()).toBe(2);
      expect(lastText(t, 0)).toBe("a가나다");
      advance(1000);
      expect(firstCalls()).toBe(2);
      for (const page of [0, 1, 2, 3]) expect(lastText(t, page)).toBe("a가나다");
      expect(vi.getTimerCount()).toBe(0);
      render.mockRestore();
    });

    it("bounds retries of a persistent failure: one queued attempt, then only on a new viewport request", async () => {
      layout({ top: 0, bottom: 1500 });
      const t = await mounted({ pages: 4 });
      await converged(t.doc);
      vi.useFakeTimers();
      const { render, firstCalls } = rejectFirst(t, Infinity);
      t.type("a");
      advance(5000);
      expect(firstCalls()).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
      act(() => void t.scroller.dispatchEvent(new Event("scroll")));
      advance(5000);
      expect(firstCalls()).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
      expect(lastText(t, 1)).toBe("a가나다");
      render.mockRestore();
    });

    it("does not retry after a terminal engine failure", async () => {
      layout({ top: 0, bottom: 1500 });
      const t = await mounted({ pages: 4 });
      await converged(t.doc);
      vi.useFakeTimers();
      const render = vi.spyOn(t.editor, "renderPage");
      const throwing = () => { throw new Error("engine"); };
      t.doc.renderPageToCanvas = throwing;
      t.doc.renderPagePatchToCanvasFilteredWithProfile = throwing;
      t.type("a");
      expect(t.editor.status.kind).toBe("failed");
      const calls = render.mock.calls.filter(([page]) => page === 0).length;
      advance(5000);
      act(() => void t.scroller.dispatchEvent(new Event("scroll")));
      advance(5000);
      expect(render.mock.calls.filter(([page]) => page === 0).length).toBe(calls);
      render.mockRestore();
    });

    it("a newer revision supersedes a queued retry; the old revision is never painted", async () => {
      layout({ top: 0, bottom: 1500 });
      const t = await mounted({ pages: 4 });
      await converged(t.doc);
      vi.useFakeTimers();
      const { render } = rejectFirst(t, 1);
      t.doc.draws = [];
      t.type("a");
      t.type("b");
      advance(1000);
      expect(t.doc.draws.filter(d => d.page === 0).map(d => d.text)).toEqual(["ab가나다"]);
      for (const page of [0, 1, 2, 3]) expect(lastText(t, page)).toBe("ab가나다");
      render.mockRestore();
    });

    it("unmount during a queued retry cancels it and releases the canvases", async () => {
      layout({ top: 0, bottom: 1500 });
      const t = await mounted({ pages: 4 });
      await converged(t.doc);
      vi.useFakeTimers();
      const { render, firstCalls } = rejectFirst(t, 1);
      t.type("a");
      const canvases = [...t.view.container.querySelectorAll("canvas")];
      t.view.unmount();
      advance(5000);
      expect(firstCalls()).toBe(1);
      expect(canvases.every(c => c.width === 0 && c.height === 0)).toBe(true);
      render.mockRestore();
    });

    it("a failed caret page after a geometry change is retried at the new scale (canvases re-created)", async () => {
      layout({ top: 0, bottom: 1500 });
      const t = await mounted({ pages: 4 });
      await converged(t.doc);
      vi.useFakeTimers();
      const { render, firstCalls } = rejectFirst(t, 1);
      t.doc.draws = [];
      const rerender = (zoom: number) => t.view.rerender(
        <LanguageProvider language="ko" onLanguageChange={() => {}}>
          <div className="editor__scroll"><RhwpSurface session={t.editor} zoom={zoom} /></div>
        </LanguageProvider>,
      );
      rerender(400); // 4 × 801·4 × 1001·4 px exceeds the surface budget: canvases removed
      expect(t.editor.renderLimit).not.toBeNull();
      expect(firstCalls()).toBe(0);
      rerender(150);
      expect(t.editor.renderLimit).toBeNull();
      advance(10);
      expect(firstCalls()).toBe(2);
      const canvas = t.view.container.querySelector("canvas")!;
      expect(canvas.width).toBe(Math.ceil(800 * 1.5));
      expect(new Set(pagesDrawn(t.doc.draws))).toEqual(new Set([0, 1, 2, 3]));
      render.mockRestore();
    });
  });

  describe("latency sample ownership and terminal failure", () => {
    /** Controlled animation frames: `frame()` runs the callbacks queued before it (one display frame). */
    function frames() {
      let queued: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { queued.push(callback); return queued.length; });
      return {
        frame: () => act(() => { const run = queued; queued = []; for (const callback of run) callback(performance.now()); }),
        pending: () => queued.length,
      };
    }
    function rejectFirst(t: Awaited<ReturnType<typeof mounted>>, times: number) {
      const original = t.editor.renderPage.bind(t.editor);
      let remaining = times;
      return vi.spyOn(t.editor, "renderPage").mockImplementation((page, canvas, scale) => {
        if (page === 0 && remaining > 0) { remaining -= 1; return false; }
        return original(page, canvas, scale);
      });
    }
    /** Real fake-engine paints of the caret page (not merely a true return value). */
    const painted = (t: Awaited<ReturnType<typeof mounted>>, text: string) => t.doc.draws.filter(d => d.page === 0 && d.text === text).length;
    async function setup(pages = 4) {
      layout({ top: 0, bottom: 1500 });
      const t = await mounted({ pages });
      await converged(t.doc);
      vi.useFakeTimers();
      const raf = frames();
      const record = vi.spyOn(t.editor, "recordLatency");
      return { t, raf, record };
    }

    it("records exactly one sample after the caret page is painted and two frames pass", async () => {
      const { t, raf, record } = await setup();
      t.type("a");
      expect(painted(t, "a가나다")).toBe(1);
      raf.frame();
      expect(record).not.toHaveBeenCalled();
      raf.frame();
      expect(record).toHaveBeenCalledTimes(1);
      expect(t.editor.latency()?.count).toBe(1);
      // harmless React renders and the remaining page tasks do not record the same input again
      act(() => t.view.rerender(
        <LanguageProvider language="ko" onLanguageChange={() => {}}>
          <div className="editor__scroll"><RhwpSurface session={t.editor} zoom={100} /></div>
        </LanguageProvider>,
      ));
      advance(1000);
      raf.frame(); raf.frame();
      expect(record).toHaveBeenCalledTimes(1);
    });

    it("a failed caret-page draw records nothing until its same-revision retry paints, then one sample", async () => {
      const { t, raf, record } = await setup();
      const render = rejectFirst(t, 1);
      t.type("a");
      expect(painted(t, "a가나다")).toBe(0);
      raf.frame(); raf.frame();
      expect(record).not.toHaveBeenCalled();
      expect(raf.pending()).toBe(0);
      await nextRenderTask();
      expect(painted(t, "a가나다")).toBe(1);
      raf.frame();
      expect(record).not.toHaveBeenCalled();
      raf.frame();
      expect(record).toHaveBeenCalledTimes(1);
      advance(1000);
      raf.frame(); raf.frame();
      expect(record).toHaveBeenCalledTimes(1);
      render.mockRestore();
    });

    it("a persistent recoverable failure stays bounded and never records a sample", async () => {
      const { t, raf, record } = await setup();
      const render = rejectFirst(t, Infinity);
      t.type("a");
      advance(5000);
      raf.frame(); raf.frame();
      act(() => void t.scroller.dispatchEvent(new Event("scroll")));
      advance(5000);
      raf.frame(); raf.frame();
      expect(render.mock.calls.filter(([page]) => page === 0)).toHaveLength(3);
      expect(painted(t, "a가나다")).toBe(0);
      expect(record).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      render.mockRestore();
    });

    it("a newer revision invalidates the older input's pending frames", async () => {
      const { t, raf, record } = await setup();
      t.type("a");
      raf.frame(); // input a: first frame passed, second pending
      t.type("b");
      raf.frame(); // a's second frame (dropped) + b's first frame
      expect(record).not.toHaveBeenCalled();
      raf.frame();
      expect(record).toHaveBeenCalledTimes(1);
      expect(painted(t, "ab가나다")).toBe(1);
    });

    it("unmount drops a pending sample", async () => {
      const { t, raf, record } = await setup();
      t.type("a");
      raf.frame();
      t.view.unmount();
      raf.frame(); raf.frame();
      expect(record).not.toHaveBeenCalled();
    });

    it("session replacement drops the old session's pending sample", async () => {
      const u = await mounted({ pages: 1 });
      const other = await mounted({ pages: 1 });
      vi.useFakeTimers();
      const raf = frames();
      const recordU = vi.spyOn(u.editor, "recordLatency");
      const recordOther = vi.spyOn(other.editor, "recordLatency");
      u.type("a");
      expect(painted(u, "a가나다")).toBe(1);
      raf.frame();
      act(() => u.view.rerender(
        <LanguageProvider language="ko" onLanguageChange={() => {}}>
          <div className="editor__scroll"><RhwpSurface session={other.editor} zoom={100} /></div>
        </LanguageProvider>,
      ));
      raf.frame(); raf.frame();
      expect(recordU).not.toHaveBeenCalled();
      expect(recordOther).not.toHaveBeenCalled();
    });

    it("a terminal failure in a queued page stops the remaining queue, drops the sample, and scroll/resize do not restart it", async () => {
      const resize = fakeResizeObserver();
      const { t, raf, record } = await setup();
      const original = t.editor.renderPage.bind(t.editor);
      const render = vi.spyOn(t.editor, "renderPage").mockImplementation((page, canvas, scale) => {
        if (page === 1) {
          const throwing = () => { throw new Error("engine"); };
          t.doc.renderPageToCanvas = throwing;
          t.doc.renderPagePatchToCanvasFilteredWithProfile = throwing;
        }
        return original(page, canvas, scale);
      });
      t.type("a");
      expect(painted(t, "a가나다")).toBe(1);
      await nextRenderTask(); // visible page 1 throws: engine failure
      expect(t.editor.status.kind).toBe("failed");
      expect(vi.getTimerCount()).toBe(0);
      const calls = render.mock.calls.length;
      raf.frame(); raf.frame();
      expect(record).not.toHaveBeenCalled();
      act(() => void t.scroller.dispatchEvent(new Event("scroll")));
      resize.resized();
      advance(5000);
      expect(render.mock.calls.length).toBe(calls);
      expect(render.mock.calls.some(([page]) => page === 2 || page === 3)).toBe(false);
      render.mockRestore();
    });

    it("a queued task does not draw once the session has failed for another reason", async () => {
      const { t, raf, record } = await setup();
      t.type("a");
      const render = vi.spyOn(t.editor, "renderPage");
      // an engine failure outside drawing (e.g. a failed edit) while page tasks are queued
      const failing = t.editor as unknown as { markFailed(error: unknown): void };
      act(() => failing.markFailed({ code: "EngineFailure", engine: "rhwp", stage: "edit" }));
      advance(5000);
      act(() => void t.scroller.dispatchEvent(new Event("scroll")));
      advance(5000);
      raf.frame(); raf.frame();
      expect(render).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      render.mockRestore();
    });
  });

  it("배율·DPR이 바뀌면 기다리지 않고 모든 쪽을 새 배율로 다시 그린다", async () => {
    layout({ top: 0, bottom: 1500 });
    const t = await mounted({ pages: 4 });
    await converged(t.doc);
    vi.useFakeTimers();
    t.type("a");
    advance(20);
    t.doc.draws = [];
    const rerender = () => t.view.rerender(
      <LanguageProvider language="ko" onLanguageChange={() => {}}>
        <div className="editor__scroll"><RhwpSurface session={t.editor} zoom={150} /></div>
      </LanguageProvider>,
    );
    rerender();
    advance(10);
    expect(new Set(pagesDrawn(t.doc.draws))).toEqual(new Set([0, 1, 2, 3]));
    expect(t.doc.draws.every((d) => d.kind === "full" && d.text === "a가나다")).toBe(true);
    const canvas = t.view.container.querySelector("canvas")!;
    expect(canvas.width).toBe(Math.ceil(800 * 1.5));
    const previous = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    try {
      t.doc.draws = [];
      rerender();
      advance(10);
      expect(new Set(pagesDrawn(t.doc.draws))).toEqual(new Set([0, 1, 2, 3]));
      expect(canvas.width).toBe(Math.ceil(800 * 3));
    } finally {
      if (previous) Object.defineProperty(window, "devicePixelRatio", previous);
      else delete (window as { devicePixelRatio?: number }).devicePixelRatio;
    }
  });

  it("표시 한도·unmount 뒤의 크기 변경은 그리지 않고, 관찰도 끝낸다", async () => {
    const ro = fakeResizeObserver();
    const view = { top: 0, bottom: 1500 };
    layout(view);
    const t = await mounted({ pages: 4 });
    await converged(t.doc);
    vi.useFakeTimers();
    t.type("a");
    advance(20);
    t.view.rerender(
      <LanguageProvider language="ko" onLanguageChange={() => {}}>
        <div className="editor__scroll"><RhwpSurface session={t.editor} zoom={400} /></div>
      </LanguageProvider>,
    ); // 4쪽 × 801·4 × 1001·4 px는 표면 예산(32 Mi px)을 넘는다
    expect(t.editor.renderLimit).not.toBeNull();
    expect(t.view.container.querySelectorAll("canvas")).toHaveLength(0);
    t.doc.draws = [];
    view.bottom = 4000;
    ro.resized();
    advance(400);
    expect(t.doc.draws).toEqual([]);
    t.view.unmount();
    expect(ro.observers.every((o) => !o.live)).toBe(true);
    ro.resized();
    expect(t.doc.draws).toEqual([]);
  });

  it("긴 문서(46쪽): 처음·입력·viewport 갱신은 task마다 한 쪽씩, 방문한 모든 쪽이 마지막 모델로 수렴한다", async () => {
    layout({ top: 0, bottom: 1500 });
    const t = await mounted({ pages: 46, size: { width: 400, height: 500 } }); // 800×1000 46쪽은 표면 예산을 넘는다
    await converged(t.doc);
    expect(new Set(t.doc.draws.map((d) => d.task)).size).toBe(t.doc.draws.length);
    t.doc.draws = [];
    t.type("a");
    await wait(20); // 키 하나가 한 task(같은 동기 실행에 두 키를 넣지 않음)
    t.type("b");
    const latest = () => Array.from({ length: 46 }, (_, page) => t.doc.draws.filter((d) => d.page === page).at(-1)?.text);
    // 먼 쪽은 dirty로 유지한다. 모든 viewport를 방문해 각 쪽이 마지막 판으로 갱신됨을 검사한다.
    // 원래의 모든 쪽 내용·task당 한 쪽 단언은 그대로 유지한다.
    for (let page = 0; page < 46; page++) {
      layout({ top: page * 1010, bottom: page * 1010 + 900 });
      act(() => void t.scroller.dispatchEvent(new Event("scroll")));
      await wait(5);
    }
    for (let i = 0; i < 400 && !latest().every((text) => text === "ab가나다"); i++) await wait(5);
    expect(latest().every((text) => text === "ab가나다")).toBe(true);
    const tasks = new Map<number, number>();
    for (const d of t.doc.draws) tasks.set(d.task, (tasks.get(d.task) ?? 0) + 1);
    expect(Math.max(...tasks.values())).toBe(1);
  });

  it("새 변경이 오면 기다리던 그리기를 취소하고, unmount 뒤에는 그리지 않는다", async () => {
    const t = await mounted({ pages: 4 });
    await converged(t.doc);
    t.doc.draws = [];
    t.type("a");
    t.view.unmount();
    const drawn = t.doc.draws.length;
    await wait(260);
    expect(t.doc.draws).toHaveLength(drawn);
  });
});
