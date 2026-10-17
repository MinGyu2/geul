// 합성 이벤트·제어된 IPC 회귀. 실제 WASM/WebView/IME 증거는 rhwp_poc.py로 별도 확인한다.
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentSessions } from "../../../adapters/sessions";
import { LanguageProvider } from "../../../language/LanguageContext";
import { DocumentWorkspace } from "../documentWorkspace";
import { Editor } from "../Editor";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
import { RhwpSurface } from "./RhwpSurface";
import { controlledBackend, FakeDocument, fail, flush, info, loaded, ok, type Call } from "./testing";

function imeOn(input: () => HTMLTextAreaElement) {
  const fire = (event: Event) => act(() => void input().dispatchEvent(event));
  return {
    start: () => fire(new CompositionEvent("compositionstart")),
    end: (text: string) => { input().value = text; fire(new CompositionEvent("compositionend", { data: text })); },
    input: (text: string, inputType = "insertFromComposition", isComposing = false) => {
      input().value = text;
      fire(new InputEvent("input", { data: text, inputType, isComposing }));
    },
    key: () => fire(new KeyboardEvent("keydown", { key: "Unidentified", keyCode: 229 })),
  };
}

async function setup(count = 1, holdRefresh = false, pageCount = 1) {
  const { backend, calls, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const docs: FakeDocument[] = [];
  const module: RhwpModule = { openDocument: () => {
    const doc = new FakeDocument(["ab"]);
    doc.pageCount = () => pageCount;
    docs.push(doc);
    return doc as unknown as RhwpDocument;
  } };
  const workspace = new DocumentWorkspace(sessions, backend, async () => module);
  for (let id = 1; id <= count; id++) {
    const opening = workspace.open(`/doc${id}.hwp`);
    take("open").reply(ok(info({ sessionId: id, displayName: `doc${id}.hwp` })));
    await opening;
    take("load").reply(loaded());
    await flush();
    if (!holdRefresh) take("session").reply(ok(info({ sessionId: id, displayName: `doc${id}.hwp`, state: "loading", loadGeneration: 1, sequence: 1 })));
    take("setState").reply(ok(info({ sessionId: id, displayName: `doc${id}.hwp`, state: "ready", loadGeneration: 1, sequence: 2 })));
    await flush();
  }
  const editor = workspace.editorFor(1)!;
  return { backend, calls, take, sessions, workspace, editor, docs };
}

async function reload(t: Awaited<ReturnType<typeof setup>>) {
  const doc = t.docs[0]!;
  vi.spyOn(doc, "renderPageToCanvas").mockImplementation(() => { throw Error("render"); });
  t.editor.renderPage(0, document.createElement("canvas"), 1);
  const oldFailed = t.take("setState"); // 응답도 보류: markFailed continuation의 소유권 검증
  const loading = t.editor.load({ discard: true });
  t.take("load").reply(loaded(undefined, 2));
  await flush();
  const refresh = t.take("session");
  t.take("setState").reply(ok(info({ state: "ready", loadGeneration: 2, revision: 1, sequence: 6, dirty: true })));
  await loading;
  expect(t.editor.status.kind).toBe("ready");
  return { oldFailed, refresh };
}

async function answerCommits(calls: Call[], sessionId: number) {
  let count = 0;
  for (let i = 0; i < 10; i++) {
    const at = calls.findIndex(c => c.method === "commit" && c.args[0] === sessionId);
    if (at < 0) break;
    const call = calls.splice(at, 1)[0]!;
    count += call.args[3] as number;
    const revision = (call.args[2] as number) + (call.args[3] as number);
    call.reply(ok(info({ sessionId, revision, state: "ready", loadGeneration: 1, sequence: 10 + revision, dirty: true })));
    await act(flush);
  }
  return count;
}

function mount(workspace: DocumentWorkspace) {
  const view = render(<LanguageProvider language="ko" onLanguageChange={() => {}}><Editor workspace={workspace} zoom={100} /></LanguageProvider>);
  return { view, ime: imeOn(() => view.container.querySelector("textarea")!) };
}

describe("P1-A async generation ownership", () => {
  for (const code of ["success", "StaleLoad", "RevisionMismatch", "InvalidState", "StaleSession", "UnknownSession"] as const) {
    it(`ignores obsolete commit ${code} after reload`, async () => {
      const t = await setup();
      t.editor.typeText("x");
      const old = t.take("commit");
      await reload(t);
      const projection = t.sessions.get(1);
      old.reply(code === "success" ? ok(info({ state: "ready", revision: 1, loadGeneration: 1, sequence: 3 }))
        : fail(code === "StaleLoad" ? { code, sessionId: 1, loadGeneration: 2 }
          : code === "RevisionMismatch" ? { code, sessionId: 1, revision: 1 }
          : code === "InvalidState" ? { code, sessionId: 1, state: "failed" }
          : { code, sessionId: 1 }));
      await flush();
      expect(t.editor.status.kind).toBe("ready");
      expect(t.editor.localRevision).toBe(1);
      expect(t.editor.documentText()).toBe("ab");
      expect(t.sessions.get(1)).toEqual(projection);
      expect(t.calls.filter(c => c.method === "commit")).toHaveLength(0);
    });
  }
  for (const oldFirst of [true, false]) {
    it(`dispatches new commits while old unresolved; oldFirst=${oldFirst}`, async () => {
      const t = await setup();
      t.editor.typeText("x");
      const old = t.take("commit");
      await reload(t);
      t.editor.typeText("y");
      const current = t.take("commit");
      expect(current.args).toEqual([1, 2, 1, 1]);
      const finishOld = async () => { old.reply(ok(info({ state: "ready", revision: 1, loadGeneration: 1, sequence: 3 }))); await flush(); };
      if (oldFirst) await finishOld();
      t.editor.typeText("z"); // 同世代 batching 유지
      current.reply(ok(info({ state: "ready", revision: 2, loadGeneration: 2, sequence: 7, dirty: true })));
      await flush();
      const next = t.take("commit");
      expect(next.args).toEqual([1, 2, 2, 1]);
      next.reply(ok(info({ state: "ready", revision: 3, loadGeneration: 2, sequence: 8, dirty: true })));
      await flush();
      if (!oldFirst) await finishOld();
      expect(t.editor.localRevision).toBe(3);
      expect(t.editor.documentText()).toBe("yzab");
      expect(t.editor.status.kind).toBe("ready");
    });
  }
  it("ignores old markFailed and refresh responses including session removal", async () => {
    const t = await setup(1, true);
    const refresh = t.take("session");
    const { oldFailed } = await reload(t);
    const projection = t.sessions.get(1);
    oldFailed.reply(ok(info({ state: "failed", loadGeneration: 1, sequence: 4 })));
    refresh.reply(fail({ code: "StaleSession", sessionId: 1 }));
    await flush();
    expect(t.sessions.get(1)).toEqual(projection);
    expect(t.editor.status.kind).toBe("ready");
  });
  it("late commit after close cannot resurrect disposed editor", async () => {
    const t = await setup();
    t.editor.typeText("x");
    const old = t.take("commit");
    const closing = t.workspace.close(1, { discard: true });
    t.take("close").reply(ok({ sessionId: 1 }));
    await closing;
    old.reply(ok(info({ state: "ready", revision: 1, sequence: 3 })));
    await flush();
    expect(t.sessions.get(1)).toBeNull();
    expect(t.editor.status.kind).toBe("closed");
    expect(t.docs[0]!.freed).toBe(true);
  });
});

describe("P1-B terminal IME transaction", () => {
  for (const sequence of ["end-end", "end-input", "end-input-end", "input-end", "input-end-input-end"]) {
    it(`one insertion, revision, caret and selection: ${sequence}`, async () => {
      const t = await setup();
      const { ime } = mount(t.workspace);
      ime.start();
      for (const event of sequence.split("-")) {
        if (event === "end") ime.end("가"); else ime.input("가");
      }
      expect(t.editor.documentText()).toBe("가ab");
      expect(t.editor.localRevision).toBe(1);
      expect(t.editor.caret.offset).toBe(1);
      expect(t.editor.anchor).toEqual(t.editor.caret);
      expect(await answerCommits(t.calls, 1)).toBe(1);
    });
  }
  it("new identical composition, ordinary input and paste are retained", async () => {
    const t = await setup();
    const { ime } = mount(t.workspace);
    ime.start(); ime.end("가"); ime.input("가"); ime.end("가");
    ime.start(); ime.end("가");
    ime.input("가", "insertText");
    ime.input("가", "insertFromPaste");
    expect(t.editor.documentText()).toBe("가가가가ab");
    expect(t.editor.caret.offset).toBe(4);
    expect(await answerCommits(t.calls, 1)).toBe(4);
  });
  it("cancelled composition stays cancelled through trailing end/input", async () => {
    const t = await setup();
    const { ime } = mount(t.workspace);
    ime.start(); ime.input("가", "insertCompositionText", true); ime.end(""); ime.input(""); ime.end("");
    expect(t.editor.documentText()).toBe("ab");
    expect(t.editor.localRevision).toBe(0);
    expect(t.editor.caret.offset).toBe(0);
    expect(await answerCommits(t.calls, 1)).toBe(0);
  });
});

describe("P1-C normal terminal notifications shared across documents", () => {
  for (const trailing of ["input", "end", "input-end"]) {
    it(`old ${trailing} does not insert into B or consume selection; new same syllable allowed`, async () => {
      const t = await setup(2);
      t.sessions.select(1);
      const { ime } = mount(t.workspace);
      ime.start(); ime.end("하");
      act(() => { t.sessions.select(2); });
      const b = t.workspace.editorFor(2)!;
      act(() => { b.moveHorizontal(1, true); }); // B의 기존 선택도 보호
      const caret = { ...b.caret }, anchor = { ...b.anchor };
      for (const event of trailing.split("-")) { if (event === "end") ime.end("하"); else ime.input("하"); }
      expect(b.documentText()).toBe("ab");
      expect(b.caret).toEqual(caret);
      expect(b.anchor).toEqual(anchor);
      expect(b.localRevision).toBe(0);
      ime.start(); ime.input("하", "insertCompositionText", true); ime.end("하");
      expect(b.documentText()).toBe("하b");
      expect(b.caret.offset).toBe(1);
      expect(await answerCommits(t.calls, 1)).toBe(1);
      expect(await answerCommits(t.calls, 2)).toBe(1);
    });
  }
});

describe("P2-B bitmap resource budget", () => {
  for (const [name, pages, width, height] of [
    ["wide", 1, 16384, 4096], ["tall", 1, 4096, 16384],
    ["near extent limit", 1, 16384, 16384], ["aggregate", 9, 2048, 2048],
  ] as const) {
    it(`rejects valid metadata with unsafe 100% allocation: ${name}`, async () => {
      const { backend, take } = controlledBackend();
      const sessions = new DocumentSessions(backend);
      const doc = new FakeDocument(["ab"]);
      doc.pageCount = () => pages;
      doc.getPageInfo = page => JSON.stringify({ pageIndex: page, width, height });
      const draw = vi.spyOn(doc, "renderPageToCanvas");
      const { RhwpEditorSession } = await import("./RhwpEditorSession");
      const editor = new RhwpEditorSession(1, backend, sessions, async () => ({ openDocument: () => doc as unknown as RhwpDocument }));
      const loading = editor.load();
      take("load").reply(loaded());
      await flush();
      const state = take("setState");
      expect(state.args).toEqual([1, 1, "loading", "failed"]);
      state.reply(ok(info({ state: "failed", loadGeneration: 1, sequence: 2 })));
      await loading;
      expect(editor.status.kind).toBe("failed");
      expect(doc.freed).toBe(true);
      expect(draw).not.toHaveBeenCalled();
    });
  }
  it("refuses high-DPI unsafe zoom before drawing and preserves pending edit", async () => {
    const t = await setup();
    t.editor.typeText("x");
    const draw = vi.spyOn(t.docs[0]!, "renderPageToCanvas");
    expect(t.editor.renderPage(0, document.createElement("canvas"), 8)).toBe(false);
    expect(draw).not.toHaveBeenCalled();
    expect(t.editor.status.kind).toBe("failed");
    expect(t.editor.hasUnpreservedChanges).toBe(true);
  });
});

describe("P2-A workspace window close", () => {
  async function withClose(count = 1) {
    const t = await setup(count);
    let request = () => {};
    let finish!: () => void;
    const close = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const stop = vi.fn();
    Object.defineProperty(t.workspace, "windowClose", { value: {
      listen: async (callback: () => void) => { request = callback; return stop; }, close,
    } });
    const mounted = mount(t.workspace);
    await act(flush);
    const click = (id: string) => act(() => { (mounted.view.container.querySelector(`[data-testid=${id}]`) as HTMLButtonElement).click(); });
    return { ...t, ...mounted, close, stop, request: () => act(() => request()), finish: () => finish(), click };
  }
  it("clean workspace closes once without a dialog", async () => {
    const t = await withClose();
    t.request(); t.request();
    expect(t.close).toHaveBeenCalledTimes(1);
    expect(t.view.queryByRole("alertdialog")).toBeNull();
    expect(t.editor.editable).toBe(false);
    t.finish(); await act(flush);
    t.request(); expect(t.close).toHaveBeenCalledTimes(1);
    t.view.unmount(); expect(t.stop).toHaveBeenCalledTimes(1);
  });
  for (const changes of ["pending", "committed", "composing", "uncertain", "inactive dirty"] as const) {
    it(`guards ${changes}; cancel preserves models, confirm destroys once`, async () => {
      const t = await withClose(changes === "inactive dirty" ? 2 : 1);
      if (changes === "uncertain") {
        vi.spyOn(t.docs[0]!, "insertText").mockImplementation(() => { throw Error("partial edit"); });
        act(() => { t.editor.typeText("x"); });
      } else if (changes === "composing") {
        t.ime.start(); t.ime.input("하", "insertCompositionText", true);
      } else {
        act(() => { t.editor.typeText("x"); });
        if (changes === "committed") await answerCommits(t.calls, 1);
      }
      t.request(); t.request();
      expect(t.view.getAllByRole("alertdialog")).toHaveLength(1);
      expect(t.view.getByRole("alertdialog").getAttribute("data-action")).toBe("window");
      expect(document.activeElement?.getAttribute("data-testid")).toBe("discard-cancel");
      expect(t.close).not.toHaveBeenCalled();
      const text = t.editor.documentText();
      t.click("discard-cancel");
      expect(t.editor.documentText()).toBe(text);
      expect(t.docs.every(doc => !doc.freed)).toBe(true);
      expect(t.close).not.toHaveBeenCalled();
      t.request(); t.click("discard-confirm"); t.request();
      expect(t.close).toHaveBeenCalledTimes(1);
      expect(t.view.queryByRole("alertdialog")).toBeNull();
      t.finish(); await act(flush);
    });
  }
  it("failed tab close cannot reopen editing while confirmed window destruction is pending", async () => {
    const t = await withClose();
    act(() => { t.editor.typeText("x"); });
    const tabClose = t.workspace.close(1, { discard: true });
    t.request(); t.click("discard-confirm");
    t.take("close").reply(fail({ code: "Protocol" }));
    await act(async () => { await tabClose; });
    expect(t.editor.editable).toBe(false);
    t.finish(); await act(flush);
  });
  it("window close replaces an existing tab discard dialog as one group decision", async () => {
    const t = await withClose();
    act(() => { t.editor.typeText("x"); });
    act(() => t.view.getByRole("button", { name: "doc1.hwp 닫기" }).click());
    await act(flush);
    expect(t.view.getByRole("alertdialog").getAttribute("data-action")).toBe("close");
    (t.view.getByTestId("discard-confirm") as HTMLButtonElement).focus();
    t.request();
    expect(document.activeElement?.getAttribute("data-testid")).toBe("discard-cancel");
    expect(t.view.getAllByRole("alertdialog")).toHaveLength(1);
    expect(t.view.getByRole("alertdialog").getAttribute("data-action")).toBe("window");
    t.click("discard-cancel");
    expect(t.sessions.get(1)).not.toBeNull();
    expect(t.docs[0]!.freed).toBe(false);
    expect(t.calls.some(call => call.method === "close")).toBe(false);
  });
});


describe("render lifecycle and standard pages", () => {
  for (const ratio of [1, 2]) {
    it(`normal pages at 100/200%, DPR ${ratio}, zoom cancellation and unmount release`, async () => {
      const t = await setup();
      const doc = t.docs[0]!;
      const dimensions: number[][] = [];
      vi.spyOn(doc, "renderPageToCanvas").mockImplementation((...args: unknown[]) => {
        const canvas = args[1] as HTMLCanvasElement;
        const scale = args[2] as number;
        dimensions.push([canvas.width, canvas.height]);
        canvas.width = Math.ceil(800 * scale); canvas.height = Math.ceil(1000 * scale);
      });
      const previous = window.devicePixelRatio;
      Object.defineProperty(window, "devicePixelRatio", { value: ratio, configurable: true });
      const surface = (zoom: number) => <LanguageProvider language="ko" onLanguageChange={() => {}}><RhwpSurface session={t.editor} zoom={zoom} /></LanguageProvider>;
      const view = render(surface(100));
      const canvas = view.container.querySelector("canvas")!;
      expect([canvas.width, canvas.height]).toEqual([800 * ratio, 1000 * ratio]);
      for (const zoom of [200, 100, 200]) view.rerender(surface(zoom));
      expect([canvas.width, canvas.height]).toEqual([1600 * ratio, 2000 * ratio]);
      expect(dimensions.every(([width, height]) => width === 0 && height === 0)).toBe(true);
      expect(t.editor.status.kind).toBe("ready");
      view.unmount();
      expect([canvas.width, canvas.height]).toEqual([0, 0]);
      t.editor.dispose(); expect(doc.freed).toBe(true);
      Object.defineProperty(window, "devicePixelRatio", { value: previous, configurable: true });
    });
  }
  it("DPR change re-renders at the new bitmap scale", async () => {
    const t = await setup();
    const draw = vi.spyOn(t.docs[0]!, "renderPageToCanvas");
    const previous = window.devicePixelRatio;
    const surface = () => <LanguageProvider language="ko" onLanguageChange={() => {}}><RhwpSurface session={t.editor} zoom={100} /></LanguageProvider>;
    Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
    const view = render(surface());
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    view.rerender(surface());
    expect((draw.mock.calls as unknown as unknown[][]).at(-1)?.[2]).toBe(2);
    view.unmount();
    Object.defineProperty(window, "devicePixelRatio", { value: previous, configurable: true });
  });
  it("tab switching releases the detached document's canvas", async () => {
    const t = await setup(2);
    const { view } = mount(t.workspace);
    const canvas = view.container.querySelector("canvas")!;
    canvas.width = 800; canvas.height = 1000;
    act(() => { t.sessions.select(1); });
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
  });
});


it("post-composition click preserves a new selection through duplicate terminal events", async () => {
  const t = await setup();
  const { ime, view } = mount(t.workspace);
  ime.start(); ime.end("가");
  act(() => {
    view.container.querySelector(".rhwp-page")!.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, button: 0, shiftKey: true, clientX: 30, clientY: 5,
    }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  });
  const anchor = { ...t.editor.anchor }, caret = { ...t.editor.caret };
  ime.input("가"); ime.end("가");
  expect(t.editor.documentText()).toBe("가ab");
  expect(t.editor.anchor).toEqual(anchor); expect(t.editor.caret).toEqual(caret);
  expect(await answerCommits(t.calls, 1)).toBe(1);
});

it("composition input before end without start is one transaction; a new key allows identical input", async () => {
  const t = await setup();
  const { ime } = mount(t.workspace);
  ime.input("가"); ime.end("가");
  ime.key(); ime.input("가"); ime.end("가");
  expect(t.editor.documentText()).toBe("가가ab");
  expect(t.editor.caret.offset).toBe(2);
  expect(t.editor.anchor).toEqual(t.editor.caret);
  expect(await answerCommits(t.calls, 1)).toBe(2);
});


it("first-paint notification does not cancel rendering of remaining pages", async () => {
  const t = await setup(1, false, 2);
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++id, callback); return id; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(frame => { frames.delete(frame); });
  const draw = vi.spyOn(t.docs[0]!, "renderPageToCanvas");
  const { view } = mount(t.workspace);
  await act(flush); // first-paint notification causes a React update before the scheduled frame
  act(() => { for (const callback of frames.values()) callback(performance.now()); frames.clear(); });
  expect((draw.mock.calls as unknown as unknown[][]).map(args => args[0])).toContain(1);
  view.unmount();
  vi.restoreAllMocks();
});

it("a duplicate terminal end cannot create a second transaction from changed data alone", async () => {
  const t = await setup();
  const { ime } = mount(t.workspace);
  ime.start(); ime.end("가"); ime.input("가"); ime.end("각");
  expect(t.editor.documentText()).toBe("가ab");
  ime.key(); ime.end("각");
  expect(t.editor.documentText()).toBe("가각ab");
  expect(await answerCommits(t.calls, 1)).toBe(2);
});

it("an empty trailing composition input does not erase the terminal transaction", async () => {
  const t = await setup();
  const { ime } = mount(t.workspace);
  ime.start(); ime.end("가"); ime.input(""); ime.end("가");
  expect(t.editor.documentText()).toBe("가ab");
  expect(t.editor.caret.offset).toBe(1);
  expect(await answerCommits(t.calls, 1)).toBe(1);
});

it("remaining pages render even while the WebView frame clock is suspended", async () => {
  const t = await setup(1, false, 2);
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(123); // scheduled, neither fired nor cancelled
  const draw = vi.spyOn(t.docs[0]!, "renderPageToCanvas");
  const { view } = mount(t.workspace);
  await act(flush);
  expect((draw.mock.calls as unknown as unknown[][]).map(args => args[0])).toContain(1);
  view.unmount();
});
