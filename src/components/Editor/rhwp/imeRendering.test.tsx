// 7차: 실제 IME 입력 지연을 줄인 그리기 정책의 회귀(합성 이벤트·가짜 엔진). 실제 지연은 실제 앱에서 따로 잰다
// (editor-surface-decision.md "T007 7차").
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocumentSessions } from "../../../adapters/sessions";
import { LanguageProvider } from "../../../language/LanguageContext";
import { RhwpEditorSession } from "./RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
import { RhwpSurface } from "./RhwpSurface";
import { base, controlledBackend, FakeDocument, flush, info, loaded, ok } from "./testing";

type Draw = { kind: "full" | "patch"; page: number; text: string; rect?: number[] };

/** rhwp처럼 전체 그리기는 Canvas 크기를 정하고, 그 자리 다시 그리기는 크기가 같을 때만 그린다. */
class PaintingDocument extends FakeDocument {
  draws: Draw[] = [];
  pages = 1;
  patchFails = false;

  pageCount() { return this.pages; }
  renderPageToCanvas(page = 0, canvas?: HTMLCanvasElement, scale = 1) {
    canvas!.width = Math.ceil(800 * scale);
    canvas!.height = Math.ceil(1000 * scale);
    this.draws.push({ kind: "full", page, text: this.paragraphs.join("/") });
  }
  renderPagePatchToCanvasFilteredWithProfile(page: number, canvas: HTMLCanvasElement, scale: number, layer: string, profile: string,
    x: number, y: number, width: number, height: number) {
    if (this.patchFails || canvas.width !== Math.ceil(800 * scale) || layer !== "all" || profile !== "screen") throw Error("patch");
    this.draws.push({ kind: "patch", page, text: this.paragraphs.join("/"), rect: [x, y, width, height] });
  }
}

async function mounted(pages = 1) {
  const { backend, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwp");
  take("open").reply(ok(base));
  await opening;
  const doc = new PaintingDocument(["가나다"]);
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
      <RhwpSurface session={editor} zoom={100} />
    </LanguageProvider>,
  );
  await act(flush);
  const input = view.container.querySelector<HTMLTextAreaElement>(".rhwp-input")!;
  const fire = (event: Event) => act(() => void input.dispatchEvent(event));
  const compose = (text: string, start = false) => {
    if (start) fire(new CompositionEvent("compositionstart", { data: "" }));
    input.value = text;
    fire(new InputEvent("input", { data: text, inputType: "insertCompositionText", isComposing: true }));
  };
  const end = (text: string) => {
    input.value = text;
    fire(new CompositionEvent("compositionend", { data: text }));
  };
  return { editor, doc, view, input, compose, end };
}

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
/** 처음 그리기가 모든 쪽에 닿을 때까지(8차: 한 task에 한 쪽씩 그리므로 실행 부하에 따라 걸리는 시간이 다르다). */
async function converged(doc: PaintingDocument) {
  for (let i = 0; i < 400 && new Set(doc.draws.map((d) => d.page)).size < doc.pages; i++) await wait(5);
}

describe("조합 갱신의 그리기", () => {
  it("크기가 같은 쪽은 Canvas를 다시 잡지 않고 그 자리에서 다시 그린다(조합 키마다 bitmap 재할당 없음)", async () => {
    const t = await mounted();
    expect(t.doc.draws.map((d) => d.kind)).toEqual(["full"]);
    const canvas = t.view.container.querySelector("canvas")!;
    t.compose("ㅎ", true);
    t.compose("하");
    // 쪽 전체를 그 자리에서(Canvas 크기를 다시 정하지 않고) 다시 그린다. 부분 띠만 그리는 것은 실제 엔진에서 표·뒤 문단이
    // 어긋나 쓰지 않는다(editor-surface-decision.md "T007 7차").
    expect(t.doc.draws.slice(1)).toEqual([
      { kind: "patch", page: 0, text: "ㅎ가나다", rect: [0, 0, 800, 1000] },
      { kind: "patch", page: 0, text: "하가나다", rect: [0, 0, 800, 1000] },
    ]);
    expect([canvas.width, canvas.height]).toEqual([800, 1000]);
  });

  it("그 자리 다시 그리기를 엔진이 거부하면 원래의 전체 그리기로 그리고 편집은 이어진다", async () => {
    const t = await mounted();
    t.doc.patchFails = true;
    t.compose("ㅎ", true);
    expect(t.doc.draws.at(-1)).toEqual({ kind: "full", page: 0, text: "ㅎ가나다" });
    expect(t.editor.status.kind).toBe("ready");
  });

  it("여러 쪽: 입력 중에는 커서 쪽만 바로 그리고, 다른 쪽은 입력이 멈춘 뒤 마지막 모델로 한 번 그린다", async () => {
    const t = await mounted(3);
    await converged(t.doc);
    t.doc.draws = [];
    t.compose("ㅎ", true);
    t.compose("하");
    t.end("하");
    await wait(20);
    expect(t.doc.draws.every((d) => d.page === 0)).toBe(true); // 아직 다른 쪽은 그리지 않음(이전 그림 유지)
    await wait(260);
    const others = t.doc.draws.filter((d) => d.page !== 0);
    expect(others.map((d) => d.page).sort()).toEqual([1, 2]);
    expect(others.every((d) => d.text === "하가나다")).toBe(true); // 중간 상태가 아니라 마지막 모델
  });

  it("입력이 아닌 그리기(처음 그리기)는 다른 쪽도 바로 그린다(빈 쪽을 남기지 않음)", async () => {
    const t = await mounted(3);
    await converged(t.doc);
    const pages = new Set(t.doc.draws.map((d) => d.page));
    expect([...pages].sort()).toEqual([0, 1, 2]);
    for (const canvas of t.view.container.querySelectorAll("canvas")) expect(canvas.width).toBe(800);
  });

  it("조합 밑줄 요소는 조합이 없을 때도 쪽마다 하나(숨김)이고 조합 중에는 같은 요소가 보인다", async () => {
    const t = await mounted();
    const underline = () => t.view.container.querySelectorAll<HTMLDivElement>(".rhwp-composition");
    expect(underline()).toHaveLength(1);
    const element = underline()[0]!;
    expect(element.style.visibility).toBe("hidden");
    t.compose("ㅎ", true);
    expect(underline()[0]).toBe(element);
    expect(element.style.visibility).toBe("");
    t.end("ㅎ");
    expect(underline()[0]).toBe(element);
    expect(element.style.visibility).toBe("hidden");
  });
});

describe("숨긴 textarea 값", () => {
  it("조합·확정·공백에서는 값을 비우지 않고 글자를 이벤트(data)에서 읽는다(앞서 확정한 글자가 값에 남아 있어도)", async () => {
    const t = await mounted();
    t.compose("ㅎ", true);
    t.compose("하");
    t.end("하");
    expect(t.input.value).toBe("하"); // 앱이 비우지 않음
    t.input.value = "하ㄱ"; // WebKit: 새 조합이 쌓인 값 뒤에 붙는다
    act(() => void t.input.dispatchEvent(new CompositionEvent("compositionstart", { data: "" })));
    act(() => void t.input.dispatchEvent(new InputEvent("input", { data: "ㄱ", inputType: "insertCompositionText", isComposing: true })));
    t.input.value = "하가";
    act(() => void t.input.dispatchEvent(new InputEvent("input", { data: "가", inputType: "insertCompositionText", isComposing: true })));
    act(() => void t.input.dispatchEvent(new CompositionEvent("compositionend", { data: "가" })));
    t.input.value = "하가 ";
    act(() => void t.input.dispatchEvent(new InputEvent("input", { data: " ", inputType: "insertText", isComposing: false })));
    expect(t.editor.documentText()).toBe("하가 가나다");
    expect(t.editor.localRevision).toBe(3);
    expect(t.input.value).toBe("하가 ");
  });

  it("글자를 알려 주지 않는 입력(붙여넣기, data 없음)은 beforeinput 때의 값과 비교해 새 글자만 넣는다(8차)", async () => {
    const t = await mounted();
    act(() => void t.input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertFromPaste", cancelable: true })));
    t.input.value = "abc";
    act(() => void t.input.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", isComposing: false })));
    expect(t.editor.documentText()).toBe("abc가나다");
    expect(t.input.value).toBe("abc"); // 값은 비우지 않는다(문서의 근거가 아님)
    // 바뀌기 전 상태(beforeinput)가 없으면 무엇이 새로 들어왔는지 모르므로 넣지 않는다(쌓인 값을 넣지 않음).
    t.input.value = "abcd";
    act(() => void t.input.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", isComposing: false })));
    expect(t.editor.documentText()).toBe("abc가나다");
  });

  it("쌓인 값은 조합이 없을 때 TRIM_LENGTH를 넘으면 비운다", async () => {
    const t = await mounted();
    t.input.value = "x".repeat(300);
    act(() => void t.input.dispatchEvent(new InputEvent("input", { data: "x", inputType: "insertText", isComposing: false })));
    expect(t.editor.documentText()).toBe("x가나다");
    expect(t.input.value).toBe("");
  });
});
