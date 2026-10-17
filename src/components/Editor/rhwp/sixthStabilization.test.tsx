// 6차 안정화 회귀(합성 이벤트·제어된 IPC). 실제 WASM/WebView/native 창 닫기·IME 증거는 tests/integration/에서 따로 확인한다.
import { act, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentBackend } from "../../../adapters/backend";
import type { Result, SessionInfo } from "../../../adapters/contract";
import { DocumentSessions } from "../../../adapters/sessions";
import { LanguageProvider } from "../../../language/LanguageContext";
import { DocumentWorkspace } from "../documentWorkspace";
import { Editor } from "../Editor";
import { RhwpEditorSession } from "./RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
import { controlledBackend, FakeDocument, fail, flush, info, loaded, ok, type Call } from "./testing";

const methods = (calls: Call[]) => calls.map(call => call.method);

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------
describe("P1: 불러오기 실패의 loading → failed 전이도 확인한 뒤에만 다시 불러온다", () => {
  /** 열린 세션 하나와 편집 세션. 엔진 문서는 테스트가 고른 방식으로 실패하거나 성공한다. */
  async function opened(open: () => FakeDocument) {
    const { backend, calls, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const opening = sessions.open("/a.hwp");
    take("open").reply(ok(info({})));
    await opening;
    const docs: FakeDocument[] = [];
    const module: RhwpModule = { openDocument: () => {
      const doc = open();
      docs.push(doc);
      return doc as unknown as RhwpDocument;
    } };
    const editor = new RhwpEditorSession(1, backend, sessions, async () => module);
    return { backend, calls, take, sessions, editor, docs };
  }
  type Opened = Awaited<ReturnType<typeof opened>>;

  /** 첫 불러오기(generation 1)를 엔진 단계에서 실패시키고 그 failed 전이 요청을 돌려준다(응답은 테스트가 줌). */
  async function failFirstLoad(t: Opened) {
    const loading = t.editor.load();
    t.take("load").reply(loaded(undefined, 1));
    await flush();
    t.take("session").reply(ok(info({ state: "loading", loadGeneration: 1, sequence: 1 })));
    const transition = t.take("setState");
    expect(transition.args).toEqual([1, 1, "loading", "failed"]);
    return { loading, transition };
  }

  /** 다시 불러오기(generation 2)를 끝까지 성공시킨다. */
  async function finishReload(t: Opened, loading: Promise<Result<null>>) {
    t.take("load").reply(loaded(undefined, 2));
    await flush();
    t.take("session").reply(ok(info({ state: "loading", loadGeneration: 2, sequence: 10 })));
    const ready = t.take("setState");
    expect(ready.args).toEqual([1, 2, "loading", "ready"]);
    ready.reply(ok(info({ state: "ready", loadGeneration: 2, sequence: 11 })));
    expect(await loading).toEqual({ ok: true, value: null });
  }

  const parseFailure = () => { throw Error("parse"); };
  const pageFailure = () => {
    const doc = new FakeDocument(["ab"]);
    doc.getPageInfo = () => { throw Error("page"); };
    return doc;
  };
  let reopened = 0;
  /** 첫 문서는 실패시키고(stage), 다시 열면 정상 문서. */
  const failOnce = (stage: "parse" | "render") => () => {
    reopened += 1;
    if (reopened === 1) return stage === "parse" ? parseFailure() : pageFailure();
    return new FakeDocument(["ab"]);
  };

  for (const stage of ["parse", "render"] as const) {
    it(`${stage} 실패 + 전이 Protocol: reload는 document_load 전에 전이를 한 번 다시 보내고, 확인 뒤에만 불러온다`, async () => {
      reopened = 0;
      const t = await opened(failOnce(stage));
      const { loading, transition } = await failFirstLoad(t);
      transition.reply(fail({ code: "Protocol" })); // Rust 상태는 그대로 loading
      expect(await loading).toEqual({ ok: false, error: { code: "EngineFailure", engine: "rhwp", stage } });
      expect(t.editor.status).toEqual({ kind: "failed", error: { code: "EngineFailure", engine: "rhwp", stage } });
      if (stage === "render") expect(t.docs[0]!.freed).toBe(true); // 쓰지 못한 임시 문서는 놓음
      const reload = t.editor.load();
      await flush();
      expect(methods(t.calls)).toEqual(["setState"]); // document_load가 먼저 가지 않음
      const retry = t.take("setState");
      expect(retry.args).toEqual([1, 1, "loading", "failed"]);
      retry.reply(ok(info({ state: "failed", loadGeneration: 1, sequence: 2 })));
      await flush();
      expect(methods(t.calls)).toEqual(["load"]);
      await finishReload(t, reload);
      expect(t.editor.status.kind).toBe("ready");
      expect(t.docs.at(-1)!.freed).toBe(false); // 지금 세대의 모델은 놓지 않음
    });
  }

  it("전이가 InvalidState(loading)이면 백엔드가 알려 준 상태에서 한 번 다시 전이한다", async () => {
    reopened = 0;
    const t = await opened(failOnce("parse"));
    const { loading, transition } = await failFirstLoad(t);
    transition.reply(fail({ code: "InvalidState", sessionId: 1, state: "loading" }));
    await loading;
    const reload = t.editor.load();
    await flush();
    const retry = t.take("setState");
    expect(retry.args).toEqual([1, 1, "loading", "failed"]);
    retry.reply(ok(info({ state: "failed", loadGeneration: 1, sequence: 2 })));
    await flush();
    await finishReload(t, reload);
  });

  it("첫 전이가 오류여도 백엔드가 이미 failed면(InvalidState failed) 확인된 것으로 보고 진행한다", async () => {
    reopened = 0;
    const t = await opened(failOnce("parse"));
    const { loading, transition } = await failFirstLoad(t);
    transition.reply(fail({ code: "Protocol" }));
    await loading;
    const reload = t.editor.load();
    await flush();
    t.take("setState").reply(fail({ code: "InvalidState", sessionId: 1, state: "failed" }));
    await flush();
    await finishReload(t, reload);
  });

  it("다시 보낸 전이도 실패하면 거짓 성공 없이 그 오류로 끝나고, 다음 reload가 다시 확인한다(무한 재시도 없음)", async () => {
    reopened = 0;
    const t = await opened(failOnce("parse"));
    const { loading, transition } = await failFirstLoad(t);
    transition.reply(fail({ code: "Protocol" }));
    await loading;
    const reload = t.editor.load();
    await flush();
    t.take("setState").reply(fail({ code: "Internal" }));
    expect(await reload).toEqual({ ok: false, error: { code: "Internal" } });
    expect(t.editor.status).toEqual({ kind: "failed", error: { code: "Internal" } });
    expect(methods(t.calls)).toEqual([]);
    const again = t.editor.load();
    await flush();
    expect(methods(t.calls)).toEqual(["setState"]); // 이번 reload에서 한 번
    t.take("setState").reply(ok(info({ state: "failed", loadGeneration: 1, sequence: 2 })));
    await flush();
    await finishReload(t, again);
  });

  it("같은 확인을 기다리는 두 reload는 전이 재전송·document_load가 각각 하나다", async () => {
    reopened = 0;
    const t = await opened(failOnce("parse"));
    const { loading, transition } = await failFirstLoad(t);
    transition.reply(fail({ code: "Protocol" }));
    await loading;
    const first = t.editor.load();
    const second = t.editor.load();
    expect(second).toBe(first);
    await flush();
    expect(methods(t.calls)).toEqual(["setState"]);
    t.take("setState").reply(ok(info({ state: "failed", loadGeneration: 1, sequence: 2 })));
    await flush();
    expect(methods(t.calls)).toEqual(["load"]);
    await finishReload(t, first);
  });

  it("전이 응답 전에 닫으면 불러오기는 닫힘으로 끝나고 늦은 응답은 투영·상태를 바꾸지 않는다", async () => {
    reopened = 0;
    const t = await opened(failOnce("parse"));
    const { loading, transition } = await failFirstLoad(t);
    const projection = t.sessions.get(1);
    t.editor.dispose();
    transition.reply(ok(info({ state: "failed", loadGeneration: 1, sequence: 5 })));
    expect(await loading).toMatchObject({ ok: false });
    expect(t.editor.status.kind).toBe("closed");
    expect(t.sessions.get(1)).toEqual(projection);
    expect(await t.editor.load()).toEqual({ ok: false, error: { code: "StaleSession", sessionId: 1 } });
    expect(methods(t.calls)).toEqual([]);
  });

  it("전이가 StaleLoad(더 새 시도)면 이 시도의 상태를 고치지 않고 reload를 진행한다", async () => {
    reopened = 0;
    const t = await opened(failOnce("parse"));
    const { loading, transition } = await failFirstLoad(t);
    transition.reply(fail({ code: "StaleLoad", sessionId: 1, loadGeneration: 2 }));
    await loading;
    const reload = t.editor.load();
    await flush();
    expect(methods(t.calls)).toEqual(["load"]);
    await finishReload(t, reload);
  });

  it("전이 요청 Promise가 거부돼도(전송 예외) 상태가 loading에 멈추지 않고 reload가 다시 확인한다", async () => {
    reopened = 0;
    const t = await opened(failOnce("parse"));
    const original = t.backend.setState.bind(t.backend);
    let reject = true;
    (t.backend as { setState: DocumentBackend["setState"] }).setState = (...args) => {
      if (reject) { reject = false; return Promise.reject(Error("transport")); }
      return original(...args);
    };
    const loading = t.editor.load();
    t.take("load").reply(loaded(undefined, 1));
    await flush();
    t.take("session").reply(ok(info({ state: "loading", loadGeneration: 1, sequence: 1 })));
    expect(await loading).toEqual({ ok: false, error: { code: "EngineFailure", engine: "rhwp", stage: "parse" } });
    expect(t.editor.status.kind).toBe("failed");
    const reload = t.editor.load();
    await flush();
    t.take("setState").reply(ok(info({ state: "failed", loadGeneration: 1, sequence: 2 })));
    await flush();
    await finishReload(t, reload);
  });

  it("정상 불러오기는 그대로 ready이고 실패 전이 기록이 없다", async () => {
    const t = await opened(() => new FakeDocument(["ab"]));
    const loading = t.editor.load();
    t.take("load").reply(loaded());
    await flush();
    t.take("session").reply(ok(info({ state: "loading", loadGeneration: 1, sequence: 1 })));
    t.take("setState").reply(ok(info({ state: "ready", loadGeneration: 1, sequence: 2 })));
    expect(await loading).toEqual({ ok: true, value: null });
    t.editor.typeText("x");
    expect(t.take("commit").args).toEqual([1, 1, 0, 1]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
async function workspaceSetup(count = 1) {
  const { backend, calls, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const docs: FakeDocument[] = [];
  const module: RhwpModule = { openDocument: () => {
    const doc = new FakeDocument(["ab"]);
    docs.push(doc);
    return doc as unknown as RhwpDocument;
  } };
  const workspace = new DocumentWorkspace(sessions, backend, async () => module);
  const at = (id: number, patch: Partial<SessionInfo>) => info({ sessionId: id, displayName: `doc${id}.hwp`, ...patch });
  for (let id = 1; id <= count; id++) {
    const opening = workspace.open(`/doc${id}.hwp`);
    take("open").reply(ok(at(id, {})));
    await opening;
    take("load").reply(loaded());
    await flush();
    take("session").reply(ok(at(id, { state: "loading", loadGeneration: 1, sequence: 1 })));
    take("setState").reply(ok(at(id, { state: "ready", loadGeneration: 1, sequence: 2 })));
    await flush();
  }
  return { backend, calls, take, sessions, workspace, docs, editor: workspace.editorFor(1)!, at };
}

describe("P2-A: 취소한 IME 조합의 수정 표시(보수적 정책 유지)", () => {
  // 고정 rhwp에서 insertText·deleteText는 구역의 원본 raw stream을 버리고 다시 흐르게 한다(text_editing.rs). 실제 샘플
  // 200개(HWP 120·HWPX 80)에서 미리보기 한 글자를 넣고 지우면 글자·컨트롤은 모두 같아도 내보낸 바이트가 155개(113·42)에서
  // 달랐다(tests/integration/rhwp/preedit_reversibility.mjs). 그래서 취소해도 모델을 '깨끗함'으로 되돌리지 않는다.
  it("깨끗한 문서에서 선택 없이 조합을 취소: revision·확정 없음, 글자 그대로, 모델은 미보존으로 보호", async () => {
    const t = await workspaceSetup();
    t.editor.beginComposition(); t.editor.updateComposition("가");
    expect(t.editor.endComposition("")).toBe("");
    expect(t.editor.documentText()).toBe("ab");
    expect(t.editor.localRevision).toBe(0);
    expect(methods(t.calls)).toEqual([]);
    expect(t.editor.hasUncertainChanges).toBe(false);
    expect(t.editor.hasUnpreservedChanges).toBe(true);
    expect(await t.workspace.close(1)).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    expect(await t.editor.load()).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
  });

  it("미리보기 없이 시작만 하고 끝난 조합(엔진 변경 없음)은 미보존으로 만들지 않는다", async () => {
    const t = await workspaceSetup();
    t.editor.beginComposition();
    expect(t.editor.endComposition("")).toBe("");
    expect(t.editor.hasUnpreservedChanges).toBe(false);
  });

  it("이미 확정한 편집이 있는 문서의 조합 취소는 revision을 그대로 두고 미보존 상태를 유지한다", async () => {
    const t = await workspaceSetup();
    t.editor.typeText("x");
    const commit = t.take("commit");
    t.editor.beginComposition(); t.editor.updateComposition("가");
    t.editor.endComposition(""); // 확정 응답 대기 중의 취소
    expect(t.editor.localRevision).toBe(1);
    commit.reply(ok(t.at(1, { state: "ready", revision: 1, loadGeneration: 1, sequence: 3, dirty: true })));
    await flush();
    expect(methods(t.calls)).toEqual([]); // 취소는 확정을 만들지 않음
    expect(t.sessions.get(1)?.revision).toBe(1);
    expect(t.editor.documentText()).toBe("xab");
    expect(t.editor.hasUnpreservedChanges).toBe(true);
  });

  it("미리보기 뒤 취소(지우기)가 예외면 uncertain·failed로 보호하고 revision은 그대로다", async () => {
    const t = await workspaceSetup();
    t.editor.beginComposition(); t.editor.updateComposition("가");
    t.docs[0]!.failNext = true;
    expect(t.editor.endComposition("")).toBe("");
    expect(t.editor.status).toMatchObject({ kind: "failed", error: { stage: "edit" } });
    expect(t.editor.hasUncertainChanges).toBe(true);
    expect(t.editor.localRevision).toBe(0);
    expect(await t.workspace.close(1)).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
  });

  it("선택을 지우고 취소하면 지운 것만 변경 하나(기존 계약)", async () => {
    const t = await workspaceSetup();
    t.editor.moveHorizontal(1, true);
    t.editor.beginComposition(); t.editor.updateComposition("가");
    t.editor.endComposition("");
    expect(t.editor.documentText()).toBe("b");
    expect(t.editor.localRevision).toBe(1);
    expect(t.take("commit").args).toEqual([1, 1, 0, 1]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("P2-B: 확인 창 초점 소유", () => {
  function mountEditor(t: Awaited<ReturnType<typeof workspaceSetup>>) {
    return render(<LanguageProvider language="ko" onLanguageChange={() => {}}><Editor workspace={t.workspace} zoom={100} /></LanguageProvider>);
  }

  /**
   * act 밖에서(앱처럼 React scheduler로) 갱신을 돌린다. act는 passive effect를 바로 실행해 commit과 effect 사이의 틈을
   * 가리므로, 실제 순서를 보려면 act 환경을 끈다.
   */
  async function outsideAct(run: () => void, until: () => boolean) {
    const global = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
    const previous = global.IS_REACT_ACT_ENVIRONMENT;
    global.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      run();
      for (let i = 0; i < 50 && !until(); i++) await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      global.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  }

  /** 확인 창이 DOM에 들어오는 순간의 초점(MutationObserver는 그 commit 직후 microtask에서 돈다). */
  function focusWhenDialogAppears() {
    const seen: (string | null)[] = [];
    const observer = new MutationObserver(() => {
      if (seen.length === 0 && document.querySelector("[role=alertdialog]")) {
        seen.push(document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? null);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return { seen, stop: () => observer.disconnect() };
  }

  it("탭 닫기 확인 창은 보이는 그 순간 이미 취소 버튼에 초점이 있다", async () => {
    const t = await workspaceSetup();
    const view = mountEditor(t);
    act(() => void t.editor.typeText("x"));
    expect(document.activeElement?.tagName).toBe("TEXTAREA");
    const probe = focusWhenDialogAppears();
    const button = view.getByRole("button", { name: "doc1.hwp 닫기" });
    await outsideAct(() => button.click(), () => probe.seen.length > 0);
    probe.stop();
    expect(probe.seen).toEqual(["discard-cancel"]);
    expect(document.activeElement?.getAttribute("data-testid")).toBe("discard-cancel");
    view.unmount();
  });

  it("창 닫기 확인 창도 보이는 그 순간 취소 버튼에 초점이 있고, 반복 요청은 창 하나다", async () => {
    const t = await workspaceSetup();
    let request = () => {};
    const close = vi.fn(async () => {});
    Object.defineProperty(t.workspace, "windowClose", { value: { listen: async (handler: () => void) => { request = handler; return () => {}; }, close } });
    const view = mountEditor(t);
    await act(flush);
    act(() => void t.editor.typeText("x"));
    const probe = focusWhenDialogAppears();
    await outsideAct(() => { request(); request(); }, () => probe.seen.length > 0);
    probe.stop();
    expect(probe.seen).toEqual(["discard-cancel"]);
    expect(view.getAllByRole("alertdialog")).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
    view.unmount();
  });

  it("확인 창이 열린 동안 뒤의 편집 표면이 다시 편집 가능해져도 초점을 가져가지 않는다", async () => {
    const t = await workspaceSetup();
    const view = mountEditor(t);
    act(() => void t.editor.typeText("x"));
    fireEvent.click(view.getByRole("button", { name: "doc1.hwp 닫기" }));
    await act(flush);
    const cancel = view.getByTestId("discard-cancel");
    expect(document.activeElement).toBe(cancel);
    act(() => { t.editor.setClosing(true); }); // 예: 창 닫기 시도 실패로 편집 잠금이 풀림·늦게 끝난 불러오기
    act(() => { t.editor.setClosing(false); });
    await act(flush);
    expect(document.activeElement).toBe(cancel);
    view.unmount();
  });

  it("Tab·Shift+Tab은 창 안에서 돌고, Escape는 취소하며 초점을 편집 입력으로 돌려주고 모델을 그대로 둔다", async () => {
    const t = await workspaceSetup();
    const view = mountEditor(t);
    act(() => void t.editor.typeText("x"));
    fireEvent.click(view.getByRole("button", { name: "doc1.hwp 닫기" }));
    await act(flush);
    const dialog = view.getByRole("alertdialog");
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(within(dialog).getByTestId("discard-confirm"));
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(within(dialog).getByTestId("discard-cancel"));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await act(flush);
    expect(view.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement?.tagName).toBe("TEXTAREA");
    expect(t.editor.documentText()).toBe("xab");
    expect(t.docs[0]!.freed).toBe(false);
    expect(methods(t.calls).filter(m => m === "close")).toEqual([]);
    view.unmount();
  });

  it("탭 확인 창이 창 닫기 확인 창으로 바뀌면 새 창이 초점을 갖고, 취소하면 처음 연 편집 입력으로 돌아온다", async () => {
    const t = await workspaceSetup();
    let request = () => {};
    const close = vi.fn(async () => {});
    Object.defineProperty(t.workspace, "windowClose", { value: { listen: async (handler: () => void) => { request = handler; return () => {}; }, close } });
    const view = mountEditor(t);
    await act(flush);
    act(() => void t.editor.typeText("x"));
    const textarea = view.container.querySelector("textarea")!;
    expect(document.activeElement).toBe(textarea);
    fireEvent.click(view.getByRole("button", { name: "doc1.hwp 닫기" }));
    await act(flush);
    expect(view.getByRole("alertdialog").dataset.action).toBe("close");
    act(() => request());
    await act(flush);
    expect(view.getByRole("alertdialog").dataset.action).toBe("window");
    expect(document.activeElement).toBe(view.getByTestId("discard-cancel"));
    fireEvent.click(view.getByTestId("discard-cancel"));
    await act(flush);
    expect(view.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(textarea);
    expect(close).not.toHaveBeenCalled();
    expect(t.docs[0]!.freed).toBe(false);
    view.unmount();
  });

  it("탭 닫기 확인은 백엔드 닫기를 한 번만 보내고 모델을 놓는다", async () => {
    const t = await workspaceSetup();
    const view = mountEditor(t);
    act(() => void t.editor.typeText("x"));
    fireEvent.click(view.getByRole("button", { name: "doc1.hwp 닫기" }));
    await act(flush);
    fireEvent.click(view.getByTestId("discard-confirm"));
    fireEvent.click(view.getByRole("button", { name: "doc1.hwp 닫기" }));
    await act(flush);
    const closes = t.calls.filter(call => call.method === "close");
    expect(closes).toHaveLength(1);
    closes[0]!.reply(ok({ sessionId: 1, alreadyClosed: false }));
    await act(flush);
    expect(t.docs[0]!.freed).toBe(true);
    view.unmount();
  });
});
