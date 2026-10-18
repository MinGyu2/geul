// 5차 안정화 회귀(합성 이벤트·제어된 IPC). 실제 WASM/WebView/IME 증거는 tests/integration/rhwp/에서 따로 확인한다.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../../../adapters/contract";
import { DocumentSessions } from "../../../adapters/sessions";
import { LanguageProvider } from "../../../language/LanguageContext";
import { DocumentWorkspace } from "../documentWorkspace";
import { Editor } from "../Editor";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
import { RhwpSurface } from "./RhwpSurface";
import { controlledBackend, FakeDocument, fail, flush, info, loaded, ok, type Call } from "./testing";

interface Options {
  format?: SessionInfo["format"];
  pages?: number;
  width?: number;
  height?: number;
}

/** 작업 공간 하나와 rhwp 세션 1개(ready). 다시 불러올 때마다 새 가짜 문서를 연다. */
async function setup(options: Options = {}) {
  const { format = "hwp", pages = 1, width = 800, height = 1000 } = options;
  const { backend, calls, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const docs: FakeDocument[] = [];
  const module: RhwpModule = { openDocument: () => {
    const doc = new FakeDocument(["ab"]);
    doc.pageCount = () => pages;
    doc.getPageInfo = page => JSON.stringify({ pageIndex: page, width, height });
    docs.push(doc);
    return doc as unknown as RhwpDocument;
  } };
  const workspace = new DocumentWorkspace(sessions, backend, async () => module);
  const at = (patch: Partial<SessionInfo>) => info({ format, displayName: `a.${format}`, ...patch });
  const opening = workspace.open(`/a.${format}`);
  take("open").reply(ok(at({})));
  await opening;
  take("load").reply(loaded());
  await flush();
  take("session").reply(ok(at({ state: "loading", loadGeneration: 1, sequence: 1 })));
  take("setState").reply(ok(at({ state: "ready", loadGeneration: 1, sequence: 2 })));
  await flush();
  const editor = workspace.editorFor(1)!;
  return { backend, calls, take, sessions, workspace, editor, docs, at };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const methods = (calls: Call[]) => calls.map(call => call.method);

async function answerCommits(t: Setup, generation = 1) {
  let count = 0;
  for (let i = 0; i < 10; i++) {
    const at = t.calls.findIndex(call => call.method === "commit");
    if (at < 0) break;
    const call = t.calls.splice(at, 1)[0]!;
    count += call.args[3] as number;
    const revision = (call.args[2] as number) + (call.args[3] as number);
    call.reply(ok(t.at({ revision, state: "ready", loadGeneration: generation, sequence: 10 + revision, dirty: true })));
    await act(flush);
  }
  return count;
}

/** 실제 엔진 그리기 예외로 ready → failed 전이를 시작한다(백엔드 응답은 보류). */
function failRendering(t: Setup) {
  vi.spyOn(t.docs.at(-1)!, "renderPageToCanvas").mockImplementationOnce(() => { throw Error("render"); });
  t.editor.renderPage(0, document.createElement("canvas"), 1);
  expect(t.editor.status).toEqual({ kind: "failed", error: { code: "EngineFailure", engine: "rhwp", stage: "render" } });
  const transition = t.take("setState");
  expect(transition.args).toEqual([1, 1, "ready", "failed"]);
  return transition;
}

/** 다시 불러오기의 백엔드 응답(generation 2)을 주고 ready까지 기다린다. */
async function finishReload(t: Setup, loading: Promise<unknown>, revision = 0) {
  t.take("load").reply(loaded(undefined, 2));
  await flush();
  t.take("session").reply(ok(t.at({ state: "loading", loadGeneration: 2, revision, sequence: 20 })));
  const ready = t.take("setState");
  expect(ready.args).toEqual([1, 2, "loading", "ready"]);
  ready.reply(ok(t.at({ state: "ready", loadGeneration: 2, revision, sequence: 21 })));
  await loading;
}

function imeOn(input: () => HTMLTextAreaElement) {
  const fire = (event: Event) => act(() => void input().dispatchEvent(event));
  return {
    start: () => fire(new CompositionEvent("compositionstart")),
    end: (text: string) => { input().value = text; fire(new CompositionEvent("compositionend", { data: text })); },
    compose: (text: string) => {
      input().value = text;
      fire(new InputEvent("input", { data: text, inputType: "insertCompositionText", isComposing: true }));
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------
describe("P1-A: 조합 확정 실패는 성공한 revision이 아니다", () => {
  it("선택 지우기는 성공하고 조합 글자 넣기가 예외면 pending·localRevision이 늘지 않고 uncertain으로 보호한다", async () => {
    const t = await setup();
    const doc = t.docs[0]!;
    t.editor.moveHorizontal(1, true); // "a" 선택
    t.editor.beginComposition(); // 선택 지우기(성공) → "b"
    expect(doc.paragraphs).toEqual(["b"]);
    doc.failNext = true; // 다음 엔진 편집(조합 글자 넣기)이 예외
    expect(t.editor.endComposition("가")).toBe("");
    await flush();
    expect(t.editor.localRevision).toBe(0);
    expect(methods(t.calls)).toEqual(["setState"]); // commit 없음, failed 전이만
    expect(t.take("setState").args).toEqual([1, 1, "ready", "failed"]);
    expect(t.editor.status).toEqual({ kind: "failed", error: { code: "EngineFailure", engine: "rhwp", stage: "edit" } });
    expect(t.editor.hasUncertainChanges).toBe(true);
    expect(t.editor.hasUnpreservedChanges).toBe(true);
    expect(t.editor.composing).toBe(false);
    expect(await t.editor.load()).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    expect(await t.workspace.close(1)).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    expect(methods(t.calls)).toEqual([]);
  });

  it("앞선 조합 입력은 성공하고 다음 조합 입력이 예외면 세지 않는다(뒤의 확정도 새 변경을 만들지 않음)", async () => {
    const t = await setup();
    const doc = t.docs[0]!;
    t.editor.beginComposition();
    t.editor.updateComposition("ㅎ");
    expect(doc.paragraphs).toEqual(["ㅎab"]);
    doc.failNext = true; // "ㅎ" 지우기에서 예외
    t.editor.updateComposition("하");
    expect(t.editor.composing).toBe(false);
    expect(t.editor.endComposition("하")).toBe("");
    expect(t.editor.insertCommittedAt({ section: 0, paragraph: 0, offset: 0 }, "하")).toBe(false);
    await flush();
    expect(t.editor.localRevision).toBe(0);
    expect(t.calls.filter(call => call.method === "commit")).toEqual([]);
    expect(t.editor.hasUncertainChanges).toBe(true);
  });

  it("조합 글자 넣기는 성공하고 그 뒤 페이지 정보 갱신이 실패하면 성공한 변경 하나로 센다", async () => {
    const t = await setup();
    const doc = t.docs[0]!;
    t.editor.beginComposition();
    t.editor.updateComposition("ㅎ");
    vi.spyOn(doc, "getPageInfo").mockImplementation(() => { throw Error("page"); });
    expect(t.editor.endComposition("하")).toBe("하");
    expect(doc.paragraphs).toEqual(["하ab"]);
    expect(t.editor.status).toMatchObject({ kind: "failed", error: { stage: "render" } });
    expect(t.editor.localRevision).toBe(1);
    expect(t.editor.hasUncertainChanges).toBe(false);
    expect(t.editor.hasUnpreservedChanges).toBe(true);
    expect(t.editor.endComposition("하")).toBe(""); // 중복 끝
    expect(t.editor.localRevision).toBe(1);
  });

  it("선택 지우기 뒤 화면 갱신이 실패해도 지운 것은 변경 하나이고 조합은 이어지지 않는다", async () => {
    const t = await setup();
    const doc = t.docs[0]!;
    t.editor.moveHorizontal(1, true);
    vi.spyOn(doc, "getPageInfo").mockImplementation(() => { throw Error("page"); });
    t.editor.beginComposition();
    expect(doc.paragraphs).toEqual(["b"]);
    expect(t.editor.composing).toBe(false);
    expect(t.editor.localRevision).toBe(1);
    expect(t.editor.endComposition("가")).toBe("");
    expect(t.editor.localRevision).toBe(1);
  });

  it("정상 조합·선택 바꾸기는 각각 정확히 하나, 취소는 선택 지우기만 하나(백엔드 revision까지)", async () => {
    const t = await setup();
    t.editor.beginComposition(); t.editor.updateComposition("ㅎ"); t.editor.updateComposition("하");
    expect(t.editor.endComposition("한")).toBe("한");
    expect(t.editor.localRevision).toBe(1);
    expect(await answerCommits(t)).toBe(1);
    t.editor.beginComposition(); t.editor.updateComposition("ㄱ");
    expect(t.editor.endComposition("")).toBe(""); // 선택 없는 취소: 변경 아님
    expect(t.editor.localRevision).toBe(1);
    expect(t.docs[0]!.paragraphs).toEqual(["한ab"]);
    t.editor.moveHorizontal(1, true); // "a"
    t.editor.beginComposition(); t.editor.updateComposition("가");
    expect(t.editor.endComposition("가")).toBe("가"); // 선택 바꾸기: 하나
    expect(t.editor.localRevision).toBe(2);
    t.editor.moveHorizontal(1, true); // "b"
    t.editor.beginComposition(); t.editor.updateComposition("나");
    expect(t.editor.endComposition("")).toBe(""); // 선택을 지우고 취소: 지운 것 하나
    expect(t.docs[0]!.paragraphs).toEqual(["한가"]);
    expect(t.editor.localRevision).toBe(3);
    expect(await answerCommits(t)).toBe(2);
    expect(t.sessions.get(1)?.revision).toBe(3);
    expect(t.editor.endComposition("가")).toBe(""); // 끝난 뒤의 중복 끝
    expect(t.editor.localRevision).toBe(3);
  });

  it("실제 표면: 실패한 조합의 늦은 확정 이벤트는 다시 불러온 새 모델에 넣지 않는다", async () => {
    const t = await setup();
    const view = render(<LanguageProvider language="ko" onLanguageChange={() => {}}><Editor workspace={t.workspace} zoom={100} /></LanguageProvider>);
    const ime = imeOn(() => view.container.querySelector("textarea")!);
    ime.start(); ime.compose("ㅎ");
    t.docs[0]!.failNext = true;
    ime.compose("하"); // 엔진 예외 → uncertain, failed
    await act(flush);
    expect(view.getByTestId("rhwp-status").dataset.status).toBe("failed");
    expect(view.getByTestId("rhwp-uncertain-warning")).toBeTruthy();
    t.take("setState").reply(ok(t.at({ state: "failed", loadGeneration: 1, sequence: 3 })));
    fireEvent.click(view.getByTestId("rhwp-load"));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByTestId("discard-confirm"));
    await act(flush);
    await act(() => finishReload(t, Promise.resolve()));
    await act(flush);
    expect(t.editor.status.kind).toBe("ready");
    ime.end("하"); // 끝난(실패한) 조합의 늦은 확정
    expect(t.editor.documentText()).toBe("ab");
    expect(t.editor.localRevision).toBe(0);
    view.unmount();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("P1-B: 백엔드 failed 전이와 다시 불러오기의 순서", () => {
  it("전이 응답 전의 다시 불러오기는 그 응답을 기다린 뒤에야 모델을 놓고 document_load를 보낸다", async () => {
    const t = await setup();
    const transition = failRendering(t);
    const loading = t.editor.load({ discard: true });
    await flush();
    expect(methods(t.calls)).toEqual([]); // document_load를 먼저 보내지 않음
    expect(t.docs[0]!.freed).toBe(false);
    expect(t.editor.status.kind).toBe("failed");
    transition.reply(ok(t.at({ state: "failed", loadGeneration: 1, sequence: 3 })));
    await flush();
    expect(methods(t.calls)).toEqual(["load"]);
    expect(t.docs[0]!.freed).toBe(true);
    expect(t.sessions.get(1)?.state).toBe("failed");
    await finishReload(t, loading);
    expect(await loading).toEqual({ ok: true, value: null });
    expect(t.editor.status.kind).toBe("ready");
    expect(t.docs).toHaveLength(2);
    t.editor.typeText("x");
    expect(t.take("commit").args).toEqual([1, 2, 0, 1]); // 새 generation의 확정은 그대로
  });

  it("전이가 이미 끝났으면 바로 다시 불러온다", async () => {
    const t = await setup();
    failRendering(t).reply(ok(t.at({ state: "failed", loadGeneration: 1, sequence: 3 })));
    await flush();
    const loading = t.editor.load();
    await flush();
    expect(methods(t.calls)).toEqual(["load"]);
    await finishReload(t, loading);
    expect(t.editor.status.kind).toBe("ready");
  });

  it("같은 전이를 기다리는 두 다시 불러오기는 document_load 하나다", async () => {
    const t = await setup();
    const transition = failRendering(t);
    const first = t.editor.load({ discard: true });
    const second = t.editor.load({ discard: true });
    expect(second).toBe(first);
    transition.reply(ok(t.at({ state: "failed", loadGeneration: 1, sequence: 3 })));
    await flush();
    expect(methods(t.calls)).toEqual(["load"]);
    await finishReload(t, first);
    expect(t.calls.filter(call => call.method === "load")).toEqual([]);
  });

  it("전이가 거부되면(응답 오류) 같은 전이를 한 번 다시 보내 확인한 뒤에만 진행한다", async () => {
    const t = await setup();
    failRendering(t).reply(fail({ code: "Protocol" }));
    await flush();
    const loading = t.editor.load();
    await flush();
    const retry = t.take("setState");
    expect(retry.args).toEqual([1, 1, "ready", "failed"]);
    expect(methods(t.calls)).toEqual([]);
    expect(t.docs[0]!.freed).toBe(false);
    // 첫 요청이 실제로는 반영됐었다면 백엔드는 이미 failed: InvalidState(failed)는 전제 충족
    retry.reply(fail({ code: "InvalidState", sessionId: 1, state: "failed" }));
    await flush();
    expect(methods(t.calls)).toEqual(["load"]);
    await finishReload(t, loading);
    expect(t.editor.status.kind).toBe("ready");
  });

  it("다시 보낸 전이도 실패하면 성공으로 보고하지 않고 모델·편집을 그대로 둔 채 오류를 알린다(무한 대기 없음)", async () => {
    const t = await setup();
    t.editor.typeText("x"); // 확정 대기 중인 편집
    const commit = t.take("commit");
    const transition = failRendering(t);
    const loading = t.editor.load({ discard: true });
    transition.reply(fail({ code: "Protocol" }));
    await flush();
    t.take("setState").reply(fail({ code: "Protocol" }));
    expect(await loading).toEqual({ ok: false, error: { code: "Protocol" } });
    expect(methods(t.calls)).toEqual([]);
    expect(t.editor.status).toEqual({ kind: "failed", error: { code: "Protocol" } });
    expect(t.docs[0]!.freed).toBe(false);
    expect(t.docs[0]!.paragraphs).toEqual(["xab"]);
    expect(t.editor.hasUnpreservedChanges).toBe(true);
    commit.reply(ok(t.at({ state: "ready", revision: 1, loadGeneration: 1, sequence: 3, dirty: true })));
    await flush();
    // 다음 다시 불러오기는 전이를 다시 확인한다(버리기 확인은 여전히 필요)
    expect(await t.editor.load()).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    const again = t.editor.load({ discard: true });
    await flush();
    t.take("setState").reply(ok(t.at({ state: "failed", loadGeneration: 1, revision: 1, sequence: 4, dirty: true })));
    await flush();
    await finishReload(t, again, 1);
    expect(t.editor.status.kind).toBe("ready");
    expect(t.editor.localRevision).toBe(1);
  });

  it("전이가 InvalidState(실제 상태 loading)로 거부되면 그 상태에서 한 번 다시 전이한다", async () => {
    const t = await setup();
    failRendering(t).reply(fail({ code: "InvalidState", sessionId: 1, state: "loading" }));
    const loading = t.editor.load();
    await flush();
    const retry = t.take("setState");
    expect(retry.args).toEqual([1, 1, "loading", "failed"]);
    retry.reply(ok(t.at({ state: "failed", loadGeneration: 1, sequence: 3 })));
    await flush();
    await finishReload(t, loading);
    expect(t.editor.status.kind).toBe("ready");
  });

  it("전이가 StaleLoad면(더 새 불러오기 시도가 있음) 이 시도의 상태를 건드리지 않고 다시 불러오기로 진행한다", async () => {
    const t = await setup();
    const transition = failRendering(t);
    const loading = t.editor.load();
    transition.reply(fail({ code: "StaleLoad", sessionId: 1, loadGeneration: 2 }));
    await flush();
    expect(methods(t.calls)).toEqual(["load"]);
    t.take("load").reply(fail({ code: "InvalidState", sessionId: 1, state: "loading" }));
    await flush();
    expect(await loading).toEqual({ ok: false, error: { code: "InvalidState", sessionId: 1, state: "loading" } });
    expect(t.editor.status).toMatchObject({ kind: "failed", error: { code: "InvalidState" } });
  });

  it("늦게 온 옛 전이 응답(낮은 sequence)은 투영을 되돌리지 않는다", async () => {
    const t = await setup();
    const transition = failRendering(t);
    const loading = t.editor.load();
    t.sessions.applyUpdate(t.at({ state: "failed", loadGeneration: 1, sequence: 5 })); // 다른 경로가 먼저 반영
    transition.reply(ok(t.at({ state: "failed", loadGeneration: 1, sequence: 3 })));
    await flush();
    expect(t.sessions.get(1)?.sequence).toBe(5);
    await finishReload(t, loading);
    expect(t.sessions.get(1)).toMatchObject({ state: "ready", loadGeneration: 2, sequence: 21 });
  });

  it("전이를 기다리는 동안 닫으면 다시 불러오기는 닫힘으로 끝나고 늦은 응답은 아무것도 바꾸지 않는다", async () => {
    const t = await setup();
    const transition = failRendering(t);
    const loading = t.editor.load({ discard: true });
    const closing = t.workspace.close(1, { discard: true });
    t.take("close").reply(ok({ sessionId: 1, alreadyClosed: false }));
    await closing;
    expect(t.editor.status.kind).toBe("closed");
    expect(t.docs[0]!.freed).toBe(true);
    transition.reply(fail({ code: "StaleSession", sessionId: 1 }));
    expect(await loading).toEqual({ ok: false, error: { code: "StaleSession", sessionId: 1 } });
    expect(methods(t.calls)).toEqual([]);
    expect(t.sessions.get(1)).toBeNull();
  });

  it("거부된 확정(RevisionMismatch) 뒤: 편집은 보호되고, 버리기 확인 뒤 전이를 기다려 다시 불러온다", async () => {
    const t = await setup();
    t.editor.typeText("x");
    t.take("commit").reply(fail({ code: "RevisionMismatch", sessionId: 1, revision: 5 }));
    await flush();
    const transition = t.take("setState");
    expect(transition.args).toEqual([1, 1, "ready", "failed"]);
    expect(await t.editor.load()).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    const loading = t.editor.load({ discard: true });
    await flush();
    expect(methods(t.calls)).toEqual([]);
    expect(t.docs[0]!.freed).toBe(false);
    transition.reply(ok(t.at({ state: "failed", loadGeneration: 1, revision: 5, sequence: 6 })));
    await flush();
    await finishReload(t, loading, 5);
    expect(t.editor.localRevision).toBe(5);
    expect(t.editor.hasUnpreservedChanges).toBe(false);
  });

  it("불러오는 중 ready 요청이 거부돼 failed로 돌린 전이도 다시 불러오기가 기다린다", async () => {
    const { backend, calls, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const opening = sessions.open("/a.hwp");
    take("open").reply(ok(info({})));
    await opening;
    const { RhwpEditorSession } = await import("./RhwpEditorSession");
    const editor = new RhwpEditorSession(1, backend, sessions, async () => ({ openDocument: () => new FakeDocument(["ab"]) as unknown as RhwpDocument }));
    const first = editor.load();
    take("load").reply(loaded());
    await flush();
    take("session").reply(ok(info({ state: "loading", loadGeneration: 1, sequence: 1 })));
    take("setState").reply(fail({ code: "Internal" })); // loading → ready 거부
    expect(await first).toEqual({ ok: false, error: { code: "Internal" } });
    const transition = take("setState");
    expect(transition.args).toEqual([1, 1, "loading", "failed"]);
    const second = editor.load();
    await flush();
    expect(methods(calls)).toEqual([]);
    transition.reply(ok(info({ state: "failed", loadGeneration: 1, sequence: 2 })));
    await flush();
    expect(methods(calls)).toEqual(["load"]);
    take("load").reply(fail({ code: "FileChanged" }));
    expect(await second).toEqual({ ok: false, error: { code: "FileChanged" } });
  });

  it("실제 화면: 실패 직후 다시 불러오기를 눌러도 InvalidState 없이 ready가 되고 성공 알림은 그 뒤에만", async () => {
    const t = await setup();
    const notify = vi.fn();
    const view = render(<LanguageProvider language="ko" onLanguageChange={() => {}}><Editor workspace={t.workspace} zoom={100} notify={notify} /></LanguageProvider>);
    act(() => void t.editor.typeText("x"));
    const commit = t.take("commit");
    let transition!: Call;
    act(() => { transition = failRendering(t); });
    fireEvent.click(view.getByTestId("rhwp-load"));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByTestId("discard-confirm"));
    await act(flush);
    expect(methods(t.calls)).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(view.getByTestId("rhwp-status").dataset.status).toBe("failed");
    commit.reply(ok(t.at({ state: "ready", revision: 1, loadGeneration: 1, sequence: 3, dirty: true })));
    transition.reply(ok(t.at({ state: "failed", loadGeneration: 1, revision: 1, sequence: 4, dirty: true })));
    await act(flush);
    await act(() => finishReload(t, Promise.resolve(), 1));
    await act(flush);
    expect(view.getByTestId("rhwp-status").dataset.status).toBe("ready");
    expect(notify).toHaveBeenCalledWith({ key: "document.discardedReloaded", vars: { name: "a.hwp" } });
    view.unmount();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("P2: 배율·DPR 픽셀 예산 초과는 복구할 수 있는 표시 한도다", () => {
  // 4000 × 4000 CSS px 쪽: 배율 1(100%·DPR 1)은 예산 안, 배율 2(200% 또는 DPR 2)는 쪽 하나가 64 MiB를 넘는다.
  const LARGE = { width: 4000, height: 4000 };

  function mountSurface(t: Setup, zoom: number) {
    const draws: number[] = [];
    vi.spyOn(t.docs.at(-1)!, "renderPageToCanvas").mockImplementation((...args: unknown[]) => {
      const canvas = args[1] as HTMLCanvasElement;
      const scale = args[2] as number;
      draws.push(scale);
      canvas.width = Math.ceil(LARGE.width * scale); canvas.height = Math.ceil(LARGE.height * scale);
    });
    const surface = (value: number) => <LanguageProvider language="ko" onLanguageChange={() => {}}><RhwpSurface session={t.editor} zoom={value} /></LanguageProvider>;
    const view = render(surface(zoom));
    const ime = imeOn(() => view.container.querySelector("textarea")!);
    return { view, draws, ime, zoom: (value: number) => view.rerender(surface(value)) };
  }

  const withRatio = async (ratio: number, run: () => Promise<void>) => {
    const previous = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { value: ratio, configurable: true });
    try { await run(); } finally { Object.defineProperty(window, "devicePixelRatio", { value: previous, configurable: true }); }
  };

  for (const format of ["hwp", "hwpx"] as const) {
    for (const ratio of [1, 2]) {
      it(`${format}, DPR ${ratio}: 안전한 배율 → 과한 배율 → 안전한 배율, 미확정 편집·revision 그대로`, () => withRatio(ratio, async () => {
        const t = await setup({ format, ...LARGE });
        act(() => void t.editor.typeText("x"));
        const commit = t.take("commit"); // 확정 응답 보류 중에 배율을 바꾼다
        const s = mountSurface(t, ratio === 1 ? 100 : 50);
        expect(s.draws).toEqual([1]);
        const canvas = s.view.container.querySelector("canvas")!;
        s.zoom(ratio === 1 ? 200 : 100); // 배율 2: 거부
        expect(s.draws).toEqual([1]); // 큰 bitmap을 할당하지 않음
        expect([canvas.width, canvas.height]).toEqual([0, 0]); // 이전 backing store는 놓음
        expect(t.editor.status.kind).toBe("ready"); // 엔진 실패가 아님
        expect(t.editor.editable).toBe(false);
        expect(s.view.queryByTestId("rhwp-render-limit")?.textContent).toContain(`${ratio === 1 ? 200 : 100}%`);
        expect(s.view.container.querySelector("canvas")).toBeNull();
        expect(s.view.container.querySelector("textarea")!.disabled).toBe(true);
        expect(t.editor.typeText("y")).toBe(false);
        commit.reply(ok(t.at({ state: "ready", revision: 1, loadGeneration: 1, sequence: 3, dirty: true })));
        await act(flush);
        expect(t.sessions.get(1)).toMatchObject({ revision: 1, state: "ready" });
        expect(t.calls.filter(call => call.method === "setState")).toEqual([]); // failed로 돌리지 않음
        s.zoom(ratio === 1 ? 100 : 50);
        expect(s.draws).toEqual([1, 1]);
        expect(s.view.queryByTestId("rhwp-render-limit")).toBeNull();
        expect(t.editor.editable).toBe(true);
        expect(t.editor.documentText()).toBe("xab");
        expect(t.editor.localRevision).toBe(1);
        act(() => void t.editor.typeText("z"));
        expect(t.editor.documentText()).toBe("xzab");
        expect(await answerCommits(t)).toBe(1);
        s.view.unmount();
      }));
    }
  }

  it("배율만 바꾸면 revision·dirty·확정 요청이 생기지 않는다(예산 안 100%↔200%)", async () => {
    const t = await setup();
    const draws: number[] = [];
    vi.spyOn(t.docs[0]!, "renderPageToCanvas").mockImplementation((...args: unknown[]) => void draws.push(args[2] as number));
    const surface = (zoom: number) => <LanguageProvider language="ko" onLanguageChange={() => {}}><RhwpSurface session={t.editor} zoom={zoom} /></LanguageProvider>;
    const view = render(surface(100));
    for (const zoom of [200, 100, 200, 50]) view.rerender(surface(zoom));
    expect(draws).toEqual([1, 2, 1, 2, 0.5]);
    expect(t.editor.localRevision).toBe(0);
    expect(methods(t.calls)).toEqual([]);
    expect(t.editor.hasUnpreservedChanges).toBe(false);
    view.unmount();
  });

  it("조합 중 거부된 배율: 보이던 조합을 그 자리에 한 번 확정하고, 늦은 끝 이벤트는 다시 넣지 않는다", async () => {
    const t = await setup(LARGE);
    const s = mountSurface(t, 100);
    s.ime.start(); s.ime.compose("하");
    expect(t.editor.composing).toBe(true);
    s.zoom(200);
    expect(t.editor.composing).toBe(false);
    expect(t.editor.documentText()).toBe("하ab");
    expect(t.editor.localRevision).toBe(1);
    s.ime.end("하"); // 끊긴 조합의 늦은 확정
    s.zoom(100);
    s.ime.end("하"); // 표면이 돌아온 뒤에도 같은 조합의 끝
    expect(t.editor.documentText()).toBe("하ab");
    expect(t.editor.localRevision).toBe(1);
    s.ime.start(); s.ime.compose("가"); s.ime.end("가"); // 새 조합은 받는다
    expect(t.editor.documentText()).toBe("하가ab");
    expect(await answerCommits(t)).toBe(2);
    s.view.unmount();
  });

  it("빠르게 되풀이한 배율 변경: 예산 밖 bitmap은 한 번도 그리지 않고 마지막 안전한 배율로 이어 간다", async () => {
    const t = await setup(LARGE);
    const s = mountSurface(t, 100);
    for (const zoom of [200, 100, 200, 175, 150, 125, 200, 100]) s.zoom(zoom);
    expect(s.draws.every(scale => scale <= 1)).toBe(true);
    expect(t.editor.editable).toBe(true);
    expect(s.view.container.querySelector("canvas")!.width).toBe(4000);
    s.view.unmount();
    expect(t.calls.filter(call => call.method === "setState")).toEqual([]);
  });

  it("실제 엔진 그리기 예외는 여전히 엔진 실패(render)다", async () => {
    const t = await setup();
    vi.spyOn(t.docs[0]!, "renderPageToCanvas").mockImplementation(() => { throw Error("wasm"); });
    const view = render(<LanguageProvider language="ko" onLanguageChange={() => {}}><RhwpSurface session={t.editor} zoom={100} /></LanguageProvider>);
    expect(t.editor.status).toEqual({ kind: "failed", error: { code: "EngineFailure", engine: "rhwp", stage: "render" } });
    expect(t.take("setState").args).toEqual([1, 1, "ready", "failed"]);
    view.unmount();
  });

  it("처음 배율에서 예산을 넘는 여러 쪽 문서: 엔진 실패가 아니라 표시 한도이고, 배율을 낮추면 편집할 수 있다", async () => {
    // A4(794 × 1123) 46쪽: 100% 합계 약 41M px(> 32M), 50%는 약 10M px
    const t = await setup({ pages: 46, width: 794, height: 1123 });
    expect(t.editor.status.kind).toBe("ready");
    const draws: number[] = [];
    vi.spyOn(t.docs[0]!, "renderPageToCanvas").mockImplementation((...args: unknown[]) => void draws.push(args[2] as number));
    const surface = (zoom: number) => <LanguageProvider language="ko" onLanguageChange={() => {}}><RhwpSurface session={t.editor} zoom={zoom} /></LanguageProvider>;
    const view = render(surface(100));
    expect(draws).toEqual([]);
    expect(view.getByTestId("rhwp-render-limit")).toBeTruthy();
    view.rerender(surface(50));
    // 커서 쪽 밖은 한 task에 한 쪽씩 그린다(8차): 모든 쪽이 그려질 때까지 기다린다.
    for (let i = 0; i < 20 && draws.length < 46; i++) await act(flush);
    expect(draws).toHaveLength(46);
    expect(t.editor.editable).toBe(true);
    view.unmount();
  });

  for (const [name, pages, width, height] of [
    ["가장 작은 배율에서도 쪽 하나가 넘음", 1, 16384, 16384], ["가장 작은 배율에서도 합계가 넘음", 200, 794, 1123],
  ] as const) {
    it(`지원하는 가장 작은 배율에서도 그릴 수 없는 문서는 ready 전에 RenderLimit(손상과 구분): ${name}`, async () => {
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
      expect(await loading).toEqual({ ok: false, error: { code: "RenderLimit" } });
      expect(editor.status).toEqual({ kind: "failed", error: { code: "RenderLimit" } });
      expect(doc.freed).toBe(true);
      expect(draw).not.toHaveBeenCalled();
    });
  }

  it("한도 표시는 화면 언어로 안내하고, 가장 작은 배율로도 안 되면 그렇게 알린다", async () => {
    // 2000 × 2000: 배율 1은 예산 안, DPR 4의 50%(배율 2)도 넘는다
    await withRatio(4, async () => {
      const t = await setup({ width: 2000, height: 4000 });
      const view = render(<LanguageProvider language="en" onLanguageChange={() => {}}><RhwpSurface session={t.editor} zoom={50} /></LanguageProvider>);
      const notice = view.getByTestId("rhwp-render-limit");
      expect(notice.getAttribute("role")).toBe("alert");
      expect(notice.textContent).toContain("50%");
      expect(notice.dataset.minimum).toBe("true");
      view.unmount();
    });
  });

  it("문서를 닫으면 표시 한도 중에도 backing store를 놓고 모델을 버린다", async () => {
    const t = await setup(LARGE);
    const s = mountSurface(t, 100);
    const canvas = s.view.container.querySelector("canvas")!;
    s.zoom(200);
    s.zoom(100);
    expect(canvas.isConnected).toBe(false);
    const current = s.view.container.querySelector("canvas")!;
    expect(current.width).toBe(4000);
    const closing = t.workspace.close(1);
    t.take("close").reply(ok({ sessionId: 1, alreadyClosed: false }));
    await act(async () => { await closing; });
    expect([current.width, current.height]).toEqual([0, 0]);
    expect(t.docs[0]!.freed).toBe(true);
    s.view.unmount();
  });
});
