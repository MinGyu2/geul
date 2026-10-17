// T007 안정화 회귀 테스트. 관찰 가능한 결과(문서 글자, 확정한 revision, 세션 상태)로 판단한다.
// IME 테스트는 브라우저가 보내는 이벤트 순서를 DOM에 재현한 것이며, 실제 한국어 IME 실행 검증을 대신하지 않는다
// (실제 검증: tests/integration/rhwp/rhwp_poc.py --ime).
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentSessions } from "../../../adapters/sessions";
import { LanguageProvider } from "../../../language/LanguageContext";
import { DocumentWorkspace } from "../documentWorkspace";
import { Editor } from "../Editor";
import { RhwpEditorSession } from "./RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
import { RhwpSurface } from "./RhwpSurface";
import { base, CFB_SIGNATURE, controlledBackend, fail, FakeDocument, flush, info, ok, loaded, readySession } from "./testing";

async function mounted(text = ["ab", "cd"]) {
  const ready = await readySession(text);
  const view = render(
    <LanguageProvider language="ko" onLanguageChange={() => {}}>
      <RhwpSurface session={ready.editor} zoom={100} />
    </LanguageProvider>,
  );
  const input = view.container.querySelector("textarea") as HTMLTextAreaElement;
  const page = view.container.querySelector(".rhwp-page") as HTMLDivElement;
  const commits = () => ready.calls.filter((call) => call.method === "commit");
  const fire = (event: Event) => act(() => void input.dispatchEvent(event));
  const ime = {
    start: () => fire(new CompositionEvent("compositionstart", { data: "" })),
    composing: (text: string) => {
      input.value = text;
      fire(new InputEvent("input", { data: text, inputType: "insertCompositionText", isComposing: true }));
    },
    end: (text: string) => {
      input.value = text;
      fire(new CompositionEvent("compositionend", { data: text }));
    },
    input: (text: string, inputType: string) => {
      input.value = text;
      fire(new InputEvent("input", { data: text, inputType, isComposing: false }));
    },
    key: (key: string, code = key) => fire(new KeyboardEvent("keydown", { key, code, bubbles: true })),
    /** IME가 처리한 키(실측 WebKitGTK: key "Unidentified", keyCode 229). 확정을 일으키는 키마다 먼저 온다. */
    imeKey: () => fire(new KeyboardEvent("keydown", { key: "Unidentified", keyCode: 229, bubbles: true })),
    blur: () => act(() => input.blur()),
  };
  // 가짜 문서: 글자 하나 = 가로 10px, 문단 하나 = 세로 20px(canvas 사각형은 jsdom에서 0,0).
  const click = (offset: number, paragraph: number) =>
    act(() => {
      page.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: offset * 10, clientY: paragraph * 20 + 5 }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    });
  return { ...ready, view, input, ime, click, commits };
}

/** 확정 응답을 차례로 준다(편집 세션은 확정을 하나씩 보낸다). */
async function answerCommits(ready: Awaited<ReturnType<typeof mounted>>) {
  let revision = 0;
  for (let i = 0; i < 20; i++) {
    const call = ready.calls.find((c) => c.method === "commit");
    if (!call) break;
    ready.calls.splice(ready.calls.indexOf(call), 1);
    revision = (call.args[2] as number) + (call.args[3] as number);
    call.reply(ok(info({ state: "ready", revision, dirty: true, sequence: 10 + revision })));
    await flush();
  }
  return revision;
}

describe("A. 같은 글자를 다시 입력해도 버리지 않는다", () => {
  it("IME로 '가'를 확정한 뒤 붙여넣은 '가'와 일반 입력 '가'가 모두 남는다", async () => {
    const t = await mounted([""]);
    t.ime.start();
    t.ime.composing("가");
    t.ime.end("가");
    t.ime.input("가", "insertFromPaste");
    t.ime.input("가", "insertText");
    expect(t.doc.paragraphs[0]).toBe("가가가");
    expect(await answerCommits(t)).toBe(3);
  });

  it("WebKitGTK 순서(시작 이벤트 없이 조합 입력·확정)로 같은 음절을 연달아 확정해도 둘 다 남는다", async () => {
    const t = await mounted([""]);
    for (let i = 0; i < 2; i++) {
      t.ime.imeKey();
      t.ime.composing("가");
      t.ime.end("가");
    }
    expect(t.doc.paragraphs[0]).toBe("가가");
    expect(await answerCommits(t)).toBe(2);
  });

  it("조합 끝 직후 같은 조합 글자로 오는 입력(Safari식 뒤따르는 입력)은 한 번만 넣는다", async () => {
    const t = await mounted([""]);
    t.ime.start();
    t.ime.composing("가");
    t.ime.end("가");
    t.ime.input("가", "insertFromComposition");
    expect(t.doc.paragraphs[0]).toBe("가");
    expect(await answerCommits(t)).toBe(1);
  });

  it("조합을 확정하고 이동한 뒤 같은 음절을 다시 확정해도 둘 다 남는다", async () => {
    const t = await mounted([""]);
    t.ime.imeKey();
    t.ime.composing("가");
    t.ime.end("가");
    t.ime.key("ArrowLeft");
    t.ime.imeKey();
    t.ime.composing("가");
    t.ime.end("가");
    expect(t.doc.paragraphs[0]).toBe("가가");
  });
});

describe("B. 조합 하나는 끝이 한 번뿐이다", () => {
  it("조합 끝 이벤트가 두 번 와도 한 번만 넣고 revision도 1이다", async () => {
    const t = await mounted([""]);
    t.ime.start();
    t.ime.composing("한");
    t.ime.end("한");
    t.ime.end("한");
    expect(t.doc.paragraphs[0]).toBe("한");
    expect(await answerCommits(t)).toBe(1);
  });

  it("조합 중 클릭: 보이는 조합 글자를 원래 자리에 확정하고, 늦게 온 조합 끝은 다시 넣거나 옮기지 않는다", async () => {
    const t = await mounted(["ab", "cd"]);
    t.click(1, 0); // a|b
    t.ime.start();
    t.ime.composing("하");
    t.click(2, 1); // 둘째 문단 cd 끝
    t.ime.end("하"); // 플랫폼이 늦게 보낸 조합 끝
    expect(t.doc.paragraphs).toEqual(["a하b", "cd"]);
    expect(t.editor.caret).toMatchObject({ paragraph: 1, offset: 2 });
    expect(await answerCommits(t)).toBe(1);
  });

  it("조합 중 클릭(페이지가 조합 글자를 받지 못한 경우): 클릭 뒤 다음 키 전에 온 확정은 원래 자리에 넣는다", async () => {
    const t = await mounted(["ab", "cd"]);
    t.click(1, 0); // a|b — IME는 아직 페이지에 아무것도 보내지 않음(실측 WebKitGTK)
    t.click(2, 1);
    t.ime.composing("하"); // 초점 이동으로 IME가 내보낸 확정
    t.ime.end("하");
    expect(t.doc.paragraphs).toEqual(["a하b", "cd"]);
    expect(t.editor.caret).toMatchObject({ paragraph: 1, offset: 2 });
    t.ime.imeKey(); // 새 입력이 시작되면 그 뒤 조합은 새 위치에
    t.ime.composing("나");
    t.ime.end("나");
    expect(t.doc.paragraphs).toEqual(["a하b", "cd나"]);
  });

  it("같은 문단에서 원래 자리 뒤를 클릭했으면 늦은 확정만큼 커서가 밀린다", async () => {
    const t = await mounted(["abcd"]);
    t.click(1, 0);
    t.click(3, 0); // abc|d
    t.ime.composing("하");
    t.ime.end("하");
    expect(t.doc.paragraphs).toEqual(["a하bcd"]);
    expect(t.editor.caret).toMatchObject({ paragraph: 0, offset: 4 }); // 같은 글자 c 뒤
  });

  it("조합 취소는 글자도 revision도 남기지 않는다", async () => {
    const t = await mounted(["ab"]);
    t.ime.start();
    t.ime.composing("ㅎ");
    t.ime.end("");
    expect(t.doc.paragraphs).toEqual(["ab"]);
    expect(t.commits()).toEqual([]);
  });

  it("조합 끝 없이 초점을 잃으면 보이는 조합 글자를 그 자리에 한 번 확정하고, 늦은 끝은 다시 넣지 않는다", async () => {
    const t = await mounted(["ab"]);
    t.ime.start();
    t.ime.composing("가");
    t.ime.blur(); // 플랫폼이 compositionend를 보내지 않음
    expect(t.editor.composing).toBe(false);
    t.input.focus();
    t.ime.end("가"); // 늦게 온 끝
    expect(t.doc.paragraphs).toEqual(["가ab"]);
    expect(await answerCommits(t)).toBe(1);
    t.ime.key("x", "KeyX");
    t.ime.input("b", "insertText");
    expect(t.doc.paragraphs).toEqual(["가bab"]);
  });

  it("조합 중 초점을 잃으면 그 자리에서 끝나고, 돌아와도 다시 넣지 않는다", async () => {
    const t = await mounted(["ab"]);
    t.ime.start();
    t.ime.composing("가");
    t.ime.end("가"); // 초점을 잃을 때 브라우저가 보내는 확정
    t.ime.blur();
    t.input.focus();
    expect(t.doc.paragraphs).toEqual(["가ab"]);
    expect(await answerCommits(t)).toBe(1);
  });
});

describe("편집한 내용을 모르게 버리지 않는다", () => {
  async function workspaceWithEdit() {
    const { backend, calls, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const doc = new FakeDocument(["ab"]);
    const module: RhwpModule = { openDocument: () => doc as unknown as RhwpDocument };
    const workspace = new DocumentWorkspace(sessions, backend, async () => module);
    const opening = workspace.open("/a.hwp");
    take("open").reply(ok(base));
    await flush();
    take("load").reply(loaded());
    await flush();
    take("session").reply(ok(info({ state: "loading", sequence: 1 })));
    take("setState").reply(ok(info({ state: "ready", sequence: 2 })));
    await opening;
    await flush();
    const editor = workspace.editorFor(1)!;
    return { workspace, editor, doc, calls, take, sessions };
  }

  it("수정한 문서는 확인 없이 닫히지 않고, 취소하면 모델이 그대로다", async () => {
    const w = await workspaceWithEdit();
    expect(w.editor.status.kind).toBe("ready");
    w.editor.typeText("X"); // 확정을 기다리는 중(백엔드 dirty는 아직 false)
    const result = await w.workspace.close(1);
    expect(result).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    expect(w.calls.some((call) => call.method === "close")).toBe(false);
    expect(w.doc.freed).toBe(false);
    expect(w.editor.typeText("Y")).toBe(true);
  });

  it("버리기로 확인하면 정확히 한 번 닫고 정리한다(되풀이한 닫기도 한 번)", async () => {
    const w = await workspaceWithEdit();
    w.editor.typeText("X");
    const first = w.workspace.close(1, { discard: true });
    const second = w.workspace.close(1, { discard: true });
    const closes = w.calls.filter((call) => call.method === "close");
    expect(closes).toHaveLength(1);
    closes[0]!.reply(ok({ sessionId: 1, alreadyClosed: false }));
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(w.doc.freed).toBe(true);
    expect(w.sessions.get(1)).toBeNull();
  });

  it("백엔드 닫기가 실패하면 모델을 버리지 않고 계속 편집할 수 있다", async () => {
    const w = await workspaceWithEdit();
    w.editor.typeText("X");
    const closing = w.workspace.close(1, { discard: true });
    w.take("close").reply({ ok: false, error: { code: "Internal" } });
    expect((await closing).ok).toBe(false);
    expect(w.doc.freed).toBe(false);
    expect(w.editor.typeText("Y")).toBe(true);
  });

  it("수정하지 않은 문서는 확인 없이 닫힌다", async () => {
    const w = await workspaceWithEdit();
    const closing = w.workspace.close(1);
    w.take("close").reply(ok({ sessionId: 1, alreadyClosed: false }));
    expect((await closing).ok).toBe(true);
  });

  it("조합 중인 문서도 닫기 전에 확인한다", async () => {
    const w = await workspaceWithEdit();
    w.editor.beginComposition();
    w.editor.updateComposition("가");
    expect((await w.workspace.close(1)).ok).toBe(false);
  });

  it("편집한 모델을 다시 불러오려면 버리기 확인이 있어야 한다", async () => {
    const w = await workspaceWithEdit();
    w.editor.typeText("X");
    expect(await w.editor.load()).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    expect(w.doc.paragraphs).toEqual(["Xab"]);
    expect(w.calls.some((call) => call.method === "load")).toBe(false);
  });
});

describe("화면: 버리기 확인·수정 표시·진단", () => {
  async function app() {
    const { backend, calls, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const doc = new FakeDocument(["ab"]);
    const workspace = new DocumentWorkspace(sessions, backend, async () => ({ openDocument: () => doc as unknown as RhwpDocument }));
    const view = render(
      <LanguageProvider language="ko" onLanguageChange={() => {}}>
        <Editor zoom={100} workspace={workspace} />
      </LanguageProvider>,
    );
    const opening = act(() => workspace.open("/a.hwp"));
    take("open").reply(ok(base));
    await act(flush);
    take("load").reply(loaded());
    await act(flush);
    take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
    take("setState").reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
    await opening;
    await act(flush);
    const editor = workspace.editorFor(1)!;
    const tab = () => view.container.querySelector("[role=tab]") as HTMLElement;
    const closeButton = () => screen.getByRole("button", { name: "a.hwp 닫기" });
    return { view, workspace, editor, doc, calls, take, sessions, tab, closeButton };
  }

  it("확정 전 편집도 탭에 수정 표시하고, 닫기는 확인 창을 띄우며 Escape(취소)면 모델이 그대로다", async () => {
    const a = await app();
    expect(a.tab().dataset.modified).toBe("false");
    act(() => void a.editor.typeText("X")); // 확정 응답 전: 백엔드 dirty는 false
    expect(a.sessions.get(1)?.dirty).toBe(false);
    expect(a.tab().dataset.modified).toBe("true");
    fireEvent.click(a.closeButton());
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.dataset.action).toBe("close");
    expect(document.activeElement).toBe(within(dialog).getByTestId("discard-cancel")); // 처음 초점은 취소
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(a.calls.some((call) => call.method === "close")).toBe(false);
    expect(a.doc.freed).toBe(false);
    expect(a.doc.paragraphs).toEqual(["Xab"]);
  });

  it("확인 창에서 버리기를 고르면 백엔드 닫기를 한 번 보내고 정리한다", async () => {
    const a = await app();
    act(() => void a.editor.typeText("X"));
    fireEvent.click(a.closeButton());
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByTestId("discard-confirm"));
    await act(flush);
    const closes = a.calls.filter((call) => call.method === "close");
    expect(closes).toHaveLength(1);
    closes[0]!.reply(ok({ sessionId: 1, alreadyClosed: false }));
    await act(flush);
    expect(a.doc.freed).toBe(true);
    expect(a.view.container.querySelector("[role=tab]")).toBeNull();
  });

  it("편집 뒤 실패한 문서는 복구가 없다고 알리고, 다시 불러오기도 버리기 확인을 거친다", async () => {
    const a = await app();
    act(() => void a.editor.typeText("X"));
    a.take("commit").reply(fail({ code: "RevisionMismatch", sessionId: 1, revision: 5 }));
    await act(flush);
    expect(a.view.getByTestId("rhwp-status").dataset.status).toBe("failed");
    expect(a.view.getByTestId("rhwp-unpreserved-warning")).toBeTruthy();
    fireEvent.click(a.view.getByTestId("rhwp-load"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.dataset.action).toBe("reload");
    expect(a.calls.some((call) => call.method === "load")).toBe(false);
    fireEvent.click(within(dialog).getByTestId("discard-confirm"));
    await act(flush);
    expect(a.calls.some((call) => call.method === "load")).toBe(true);
    expect(a.doc.freed).toBe(true); // 버리기를 고른 뒤에만 이전 모델을 놓는다
  });

  it("일반 빌드(검사 훅 없음)에서는 문서 글자를 진단 속성에 넣지 않는다", async () => {
    const a = await app();
    const status = a.view.getByTestId("rhwp-status");
    expect(status.dataset.status).toBe("ready");
    expect(status.hasAttribute("data-paragraph-text")).toBe(false);
    expect(status.outerHTML).not.toContain("ab");
  });

  it("통과한 내보내기 검사 결과는 문서를 바꾸면 화면에서 사라진다", async () => {
    const a = await app();
    fireEvent.click(a.view.getByTestId("rhwp-roundtrip"));
    expect(a.view.getByTestId("rhwp-roundtrip-result").dataset.passed).toBe("true");
    act(() => void a.editor.typeText("X"));
    expect(a.view.queryByTestId("rhwp-roundtrip-result")).toBeNull();
  });
});

describe("불러오기 시도와 늦은 응답", () => {
  it("새 불러오기 시도가 대신한 모델의 확정이 StaleLoad로 거부되면 편집만 멈추고 상태 전이를 보내지 않는다", async () => {
    const r = await readySession(["ab"]);
    r.editor.typeText("X");
    r.take("commit").reply(fail({ code: "StaleLoad", sessionId: 1, loadGeneration: 2 }));
    await flush();
    expect(r.editor.status).toMatchObject({ kind: "failed", error: { code: "StaleLoad" } });
    expect(r.editor.typeText("Y")).toBe(false);
    expect(r.calls.some((call) => call.method === "setState")).toBe(false);
  });

  it("동시에 두 번 불러오면 백엔드 불러오기는 한 번이다", async () => {
    const { backend, take, calls } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const opening = sessions.open("/a.hwp");
    take("open").reply(ok(base));
    await opening;
    const editor = new RhwpEditorSession(1, backend, sessions, async () => ({ openDocument: () => new FakeDocument(["x"]) as unknown as RhwpDocument }));
    const first = editor.load();
    const second = editor.load();
    expect(calls.filter((call) => call.method === "load")).toHaveLength(1);
    expect(second).toBe(first);
  });

  it("불러오는 중에 작업 공간에서 닫으면 늦은 응답이 세션·모델을 되살리지 않는다", async () => {
    const { backend, take, calls } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const doc = new FakeDocument(["x"]);
    const workspace = new DocumentWorkspace(sessions, backend, async () => ({ openDocument: () => doc as unknown as RhwpDocument }));
    const opening = workspace.open("/a.hwp");
    take("open").reply(ok(base));
    await opening;
    const editor = workspace.editorFor(1)!;
    expect(editor.status.kind).toBe("loading");
    const closing = workspace.close(1); // 모델이 아직 없으므로 확인 없이 닫힌다
    take("close").reply(ok({ sessionId: 1, alreadyClosed: false }));
    expect((await closing).ok).toBe(true);
    take("load").reply(loaded()); // 닫은 뒤에 도착한 불러오기 응답
    await flush();
    expect(editor.status.kind).toBe("closed");
    expect(sessions.get(1)).toBeNull();
    expect(calls.filter((call) => call.method === "setState")).toEqual([]);
    expect(doc.freed).toBe(false); // 엔진에 열지도 않았다
  });
});

describe("엔진 초기화·렌더·변경 뒤 실패", () => {
  async function loading(doc: FakeDocument) {
    const { backend, calls, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const opening = sessions.open("/a.hwp");
    take("open").reply(ok(base));
    await opening;
    const editor = new RhwpEditorSession(1, backend, sessions, async () => ({ openDocument: () => doc as unknown as RhwpDocument }));
    const done = editor.load();
    take("load").reply(loaded());
    await flush();
    take("session").reply(ok(info({ state: "loading", sequence: 1 })));
    return { editor, calls, take, done };
  }

  it("페이지 정보 API가 실패하면 백엔드를 ready로 만들지 않고 failed로 끝낸다", async () => {
    const doc = new FakeDocument(["ab"]);
    doc.getPageInfo = () => {
      throw new Error("page info");
    };
    const l = await loading(doc);
    await flush();
    const transition = l.take("setState");
    expect(transition.args).toEqual([1, 1, "loading", "failed"]);
    transition.reply(ok(info({ state: "failed", sequence: 2 })));
    await l.done;
    // 문서는 읽었지만 그릴 준비(페이지 정보)가 안 됨: parse가 아니라 render 단계(3차 안정화에서 구분).
    expect(l.editor.status).toMatchObject({ kind: "failed", error: { code: "EngineFailure", stage: "render" } });
    expect(doc.freed).toBe(true);
  });

  it("페이지 그리기가 실패하면 빈 편집 영역을 정상처럼 두지 않고 failed가 된다", async () => {
    const ready = await readySession(["ab"]);
    ready.doc.renderPageToCanvas = () => {
      throw new Error("render");
    };
    expect(ready.editor.renderPage(0, document.createElement("canvas"), 1)).toBe(false);
    await flush();
    expect(ready.editor.status).toMatchObject({ kind: "failed", error: { code: "EngineFailure", stage: "render" } });
    expect(ready.take("setState").args).toEqual([1, 1, "ready", "failed"]);
  });

  it("엔진 변경은 성공했는데 화면 갱신 준비가 실패하면 그 변경을 세고 편집을 멈춘다", async () => {
    const ready = await readySession(["ab"]);
    const original = ready.doc.getPageInfo.bind(ready.doc);
    ready.doc.getPageInfo = () => {
      throw new Error("after mutation");
    };
    expect(() => ready.editor.typeText("X")).not.toThrow();
    expect(ready.doc.paragraphs).toEqual(["Xab"]);
    expect(ready.editor.localRevision).toBe(1); // 바뀐 모델을 확정 대기열에 넣었다
    await flush();
    expect(ready.editor.status).toMatchObject({ kind: "failed", error: { code: "EngineFailure", stage: "render" } });
    expect(ready.editor.typeText("Y")).toBe(false);
    ready.doc.getPageInfo = original;
  });
});

describe("내보내기 검사", () => {
  async function withExport(loss: string, takeBytes?: () => Uint8Array<ArrayBuffer>) {
    const ready = await readySession(["ab"]);
    const freed = { exported: 0 };
    ready.doc.exportHwpWithReport = () => ({
      contentLoss: () => loss,
      takeBytes: takeBytes ?? (() => new Uint8Array([...CFB_SIGNATURE, 0x61, 0x62])),
      free: () => void (freed.exported += 1),
    });
    return { ...ready, freed };
  }

  it("손실 보고가 1건 이상이면 통과가 아니다", async () => {
    const r = await withExport(JSON.stringify({ count: 1, losses: [{ code: "ControlOmitted" }] }));
    expect(r.editor.roundTrip("hwp")).toMatchObject({ lossCount: 1, passed: false });
  });

  it("손실 보고가 없거나 형식이 틀리면 통과가 아니다", async () => {
    for (const loss of ["not json", JSON.stringify({ losses: [] }), JSON.stringify({ count: "0", losses: [] }), "null"]) {
      const r = await withExport(loss);
      expect(r.editor.roundTrip("hwp"), loss).toMatchObject({ lossValid: false, passed: false });
    }
  });

  it("손실 0·구조 같음이면 통과이고, 그 뒤 문서를 바꾸면 이전 결과를 보이지 않는다", async () => {
    const r = await withExport(JSON.stringify({ count: 0, losses: [] }));
    expect(r.editor.roundTrip("hwp")).toMatchObject({ passed: true });
    expect(r.editor.lastRoundTrip?.passed).toBe(true);
    r.editor.typeText("X");
    expect(r.editor.lastRoundTrip).toBeNull();
  });

  it("바이트를 꺼내다 실패해도 내보낸 객체를 놓고 실패로 보고한다", async () => {
    const r = await withExport(JSON.stringify({ count: 0, losses: [] }), () => {
      throw new Error("take");
    });
    expect(r.editor.roundTrip("hwp")).toMatchObject({ passed: false });
    expect(r.freed.exported).toBe(1);
  });

  it("다시 열기가 실패해도 내보낸 객체를 놓는다", async () => {
    const r = await withExport(JSON.stringify({ count: 0, losses: [] }));
    const spy = vi.fn(() => {
      throw new Error("reopen");
    });
    (r.editor as unknown as { module: RhwpModule }).module = { openDocument: spy };
    expect(r.editor.roundTrip("hwp")).toMatchObject({ passed: false });
    expect(spy).toHaveBeenCalled();
    expect(r.freed.exported).toBe(1);
  });
});
