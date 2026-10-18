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
  onPatch: ((canvas: HTMLCanvasElement) => void) | null = null;
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
  getPageLayerTreeWithProfile(page: number) {
    const leaves = page === 0
      ? this.paragraphs.map((text, i) => ({ kind: "leaf", sourceNodeId: 10 + i, ops: [{ type: "textRun", text, bbox: { x: 0, y: 20 * i + 3, width: 10 * text.length, height: 14 } }] }))
      : [{ kind: "leaf", sourceNodeId: 10, ops: [{ type: "textRun", text: `${page}:${this.paragraphs.join("/")}`, bbox: { x: 0, y: 500, width: 100, height: 14 } }] }];
    return JSON.stringify({ root: { kind: "group", sourceNodeId: 0, children: leaves } });
  }
  renderPageToCanvas(page = 0, canvas?: HTMLCanvasElement, scale = 1) {
    canvas!.width = Math.ceil(800 * scale);
    canvas!.height = Math.ceil(1000 * scale);
    this.draws.push({ kind: "full", page, text: this.paragraphs.join("/"), task: this.taskId() });
  }
  renderPagePatchToCanvasFilteredWithProfile(page: number, canvas: HTMLCanvasElement, _scale: number, _layer: string, _profile: string,
    x: number, y: number, width: number, height: number) {
    this.onPatch?.(canvas);
    this.draws.push({ kind: "patch", page, text: this.paragraphs.join("/"), rect: [x, y, width, height], task: this.taskId() });
  }
}

async function mounted({ pages = 1, zoom = 100, text = ["가나다"] } = {}) {
  const { backend, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwp");
  take("open").reply(ok(base));
  await opening;
  const doc = new LayeredDocument(text);
  doc.pages = pages;
  const module: RhwpModule = { openDocument: () => doc as unknown as RhwpDocument };
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module);
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

afterEach(() => {
  vi.useRealTimers();
});

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

describe("여러 쪽 그리기 순서", () => {
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
    expect(pagesDrawn(t.doc.draws).sort()).toEqual([2, 3]);
    expect(t.doc.draws.every((d) => d.text === "a가나다")).toBe(true);
    advance(260);
    expect(pagesDrawn(t.doc.draws).sort()).toEqual([2, 3]); // 이미 그린 쪽을 또 그리지 않음
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
