// T007 3차 안정화 회귀 테스트(2차 코드 리뷰 지적). 관찰 가능한 결과(문서 글자, 커서·선택, 확정한 revision, 세션 상태)로
// 판단한다. IME 테스트는 DOM 이벤트 순서를 재현한 것이며 실제 한국어 IME 실행 검증을 대신하지 않는다.
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocumentSessions } from "../../../adapters/sessions";
import { LanguageProvider } from "../../../language/LanguageContext";
import { DocumentWorkspace } from "../documentWorkspace";
import { Editor } from "../Editor";
import { RhwpEditorSession } from "./RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
import { RhwpSurface } from "./RhwpSurface";
import { base, controlledBackend, FakeDocument, flush, info, loaded, ok, readySession, type Call } from "./testing";

/** textarea 하나에 IME·키 이벤트를 보내는 도구. */
function imeOn(input: () => HTMLTextAreaElement) {
  const fire = (event: Event) => act(() => void input().dispatchEvent(event));
  return {
    start: () => fire(new CompositionEvent("compositionstart", { data: "" })),
    composing: (text: string) => {
      input().value = text;
      fire(new InputEvent("input", { data: text, inputType: "insertCompositionText", isComposing: true }));
    },
    end: (text: string) => {
      input().value = text;
      fire(new CompositionEvent("compositionend", { data: text }));
    },
    input: (text: string, inputType: string) => {
      input().value = text;
      fire(new InputEvent("input", { data: text, inputType, isComposing: false }));
    },
    key: (key: string, code = key) => fire(new KeyboardEvent("keydown", { key, code, bubbles: true })),
    imeKey: () => fire(new KeyboardEvent("keydown", { key: "Unidentified", keyCode: 229, bubbles: true })),
  };
}

/** 확정 응답을 차례로 주고 마지막 revision을 돌려준다(세션 하나). */
async function answerCommits(calls: Call[], sessionId = 1) {
  let revision = 0;
  for (let i = 0; i < 20; i++) {
    const call = calls.find((c) => c.method === "commit" && c.args[0] === sessionId);
    if (!call) break;
    calls.splice(calls.indexOf(call), 1);
    revision = (call.args[2] as number) + (call.args[3] as number);
    call.reply(ok(info({ sessionId, state: "ready", revision, dirty: true, sequence: 10 + revision })));
    await act(flush);
  }
  return revision;
}

async function mounted(text = ["ab", "cd"]) {
  const ready = await readySession(text);
  const view = render(
    <LanguageProvider language="ko" onLanguageChange={() => {}}>
      <RhwpSurface session={ready.editor} zoom={100} />
    </LanguageProvider>,
  );
  const input = view.container.querySelector("textarea") as HTMLTextAreaElement;
  const page = view.container.querySelector(".rhwp-page") as HTMLDivElement;
  const click = (offset: number, paragraph: number) =>
    act(() => {
      page.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: offset * 10, clientY: paragraph * 20 + 5 }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    });
  /** 같은 문단에서 from을 누르고 to까지 끈다(누르기는 pointerDown 한 번). */
  const drag = (from: number, to: number, paragraph: number) =>
    act(() => {
      const y = paragraph * 20 + 5;
      page.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: from * 10, clientY: y }));
      page.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: to * 10, clientY: y }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    });
  return { ...ready, view, input, ime: imeOn(() => input), click, drag, revision: () => answerCommits(ready.calls) };
}

describe("P1-A 클릭으로 끊긴 조합의 늦은 이벤트", () => {
  it("리뷰 순서(클릭 → 조합 입력 → 조합 아닌 확정 입력 → 조합 끝): 원래 자리에 한 번만 넣는다", async () => {
    const t = await mounted(["ab", "cd"]);
    t.click(1, 0); // a|b (페이지는 조합 글자를 받지 못함)
    t.click(2, 1); // cd|
    t.ime.composing("하");
    t.ime.input("하", "insertFromComposition");
    t.ime.end("하");
    expect(t.doc.paragraphs).toEqual(["a하b", "cd"]);
    expect(t.editor.caret).toMatchObject({ paragraph: 1, offset: 2 });
    expect(await t.revision()).toBe(1);
  });

  it("보이는 조합을 클릭으로 확정한 뒤 늦게 온 조합 입력·확정 입력·끝은 모두 소비한다", async () => {
    const t = await mounted(["ab", "cd"]);
    t.click(1, 0);
    t.ime.start();
    t.ime.composing("하");
    t.click(2, 1);
    t.ime.composing("하");
    t.ime.input("하", "insertFromComposition");
    t.ime.end("하");
    expect(t.doc.paragraphs).toEqual(["a하b", "cd"]);
    expect(t.editor.caret).toMatchObject({ paragraph: 1, offset: 2 });
    expect(await t.revision()).toBe(1);
  });

  it("클릭 뒤 조합 입력 없이 온 확정 입력(insertFromComposition)과 끝도 원래 자리에 한 번", async () => {
    const t = await mounted(["ab", "cd"]);
    t.click(1, 0);
    t.click(2, 1);
    t.ime.input("하", "insertFromComposition");
    t.ime.end("하");
    expect(t.doc.paragraphs).toEqual(["a하b", "cd"]);
    expect(t.editor.caret).toMatchObject({ paragraph: 1, offset: 2 });
    expect(await t.revision()).toBe(1);
  });

  it("클릭 뒤 조합 입력 다음 빈 조합 끝(취소)은 글자를 남기지 않는다", async () => {
    const t = await mounted(["ab", "cd"]);
    t.click(1, 0);
    t.click(2, 1);
    t.ime.composing("하");
    t.ime.end("");
    expect(t.doc.paragraphs).toEqual(["ab", "cd"]);
    expect(t.calls.some((call) => call.method === "commit")).toBe(false);
  });

  it("클릭 뒤의 일반 입력(insertText)은 새 입력이라 클릭한 자리에 넣는다", async () => {
    const t = await mounted(["ab", "cd"]);
    t.click(1, 0);
    t.click(2, 1);
    t.ime.input("x", "insertText");
    expect(t.doc.paragraphs).toEqual(["ab", "cdx"]);
    expect(await t.revision()).toBe(1);
  });

  it("늦은 확정을 처리한 뒤의 새 조합(같은 음절)은 새 자리에 그대로 들어간다", async () => {
    const t = await mounted(["ab", "cd"]);
    t.click(1, 0);
    t.click(2, 1);
    t.ime.composing("하");
    t.ime.input("하", "insertFromComposition");
    t.ime.end("하");
    t.ime.imeKey();
    t.ime.composing("하");
    t.ime.end("하");
    t.ime.imeKey();
    t.ime.input("하", "insertFromComposition"); // Safari식: 끝 없이 확정 입력만
    expect(t.doc.paragraphs).toEqual(["a하b", "cd하하"]);
    expect(await t.revision()).toBe(3);
  });

  it("같은 문단의 선택(클릭한 뒤 끌기)은 원래 자리에 넣은 글자만큼 함께 밀린다", async () => {
    const t = await mounted(["abcd"]);
    t.click(1, 0); // a|bcd
    t.drag(2, 4, 0); // 선택 cd
    t.ime.composing("하");
    t.ime.input("하", "insertFromComposition");
    t.ime.end("하");
    expect(t.doc.paragraphs).toEqual(["a하bcd"]);
    expect(t.editor.anchor).toMatchObject({ paragraph: 0, offset: 3 });
    expect(t.editor.caret).toMatchObject({ paragraph: 0, offset: 5 });
    expect(await t.revision()).toBe(1);
  });

  it("보이는 조합을 클릭으로 확정한 뒤 Safari 순서(끝 → 같은 글자의 조합 아닌 확정 입력)로 와도 한 번", async () => {
    const t = await mounted(["ab", "cd"]);
    t.click(1, 0);
    t.ime.start();
    t.ime.composing("하");
    t.click(2, 1);
    t.ime.end("하");
    t.ime.input("하", "insertFromComposition");
    expect(t.doc.paragraphs).toEqual(["a하b", "cd"]);
    expect(await t.revision()).toBe(1);
  });

  it("조합 중 초점을 잃은 뒤 늦게 온 조합 입력·확정 입력·끝은 다시 넣지 않고, 다음 새 입력은 받는다", async () => {
    const t = await mounted(["ab"]);
    t.ime.start();
    t.ime.composing("가");
    act(() => t.input.blur());
    act(() => t.input.focus());
    t.ime.composing("가");
    t.ime.input("가", "insertFromComposition");
    t.ime.end("가");
    expect(t.doc.paragraphs).toEqual(["가ab"]);
    t.ime.imeKey();
    t.ime.composing("가");
    t.ime.end("가");
    expect(t.doc.paragraphs).toEqual(["가가ab"]);
    expect(await t.revision()).toBe(2);
  });

  it("클릭 뒤 키 입력이 먼저 오면 그 뒤 확정은 새 입력이다(어느 조합인지 알 수 없어 클릭한 자리에)", async () => {
    const t = await mounted(["ab", "cd"]);
    t.click(1, 0);
    t.click(2, 1);
    t.ime.imeKey();
    t.ime.composing("하");
    t.ime.input("하", "insertFromComposition");
    t.ime.end("하");
    expect(t.doc.paragraphs).toEqual(["ab", "cd하"]);
    expect(await t.revision()).toBe(1);
  });
});

describe("탭 전환과 조합", () => {
  async function twoDocuments() {
    const { backend, calls, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const docs = [new FakeDocument(["ab"]), new FakeDocument(["xy"])];
    let opened = 0;
    const module: RhwpModule = { openDocument: () => docs[opened++] as unknown as RhwpDocument };
    const workspace = new DocumentWorkspace(sessions, backend, async () => module);
    const view = render(
      <LanguageProvider language="ko" onLanguageChange={() => {}}>
        <Editor zoom={100} workspace={workspace} />
      </LanguageProvider>,
    );
    for (const [sessionId, format, name] of [[1, "hwp", "a.hwp"], [2, "hwpx", "b.hwpx"]] as const) {
      const opening = act(() => workspace.open(`/${name}`));
      take("open").reply(ok({ ...base, sessionId, format, displayName: name }));
      await act(flush);
      take("load").reply(loaded());
      await act(flush);
      take("session").reply(ok(info({ sessionId, format, displayName: name, state: "loading", sequence: 1, loadGeneration: 1 })));
      take("setState").reply(ok(info({ sessionId, format, displayName: name, state: "ready", sequence: 2, loadGeneration: 1 })));
      await opening;
      await act(flush);
    }
    const textarea = () => view.container.querySelector("textarea") as HTMLTextAreaElement;
    const select = (sessionId: number) => act(() => void sessions.select(sessionId));
    return { view, workspace, sessions, docs, calls, textarea, select, ime: imeOn(textarea), editor: (id: number) => workspace.editorFor(id)! };
  }

  it("조합 중 표면이 사라지면(초점 잃음 없이) 그 문서에 보이던 조합을 한 번 확정하고, 돌아와 입력하면 받는다", async () => {
    const d = await twoDocuments();
    d.select(1);
    d.ime.start();
    d.ime.composing("하");
    expect(d.docs[0]!.paragraphs).toEqual(["하ab"]);
    d.select(2); // 탭을 코드로 바꿈(예: 새 문서 열기) — textarea가 초점을 가진 채 사라짐
    expect(d.editor(1).composing).toBe(false);
    d.select(1);
    d.ime.key("z", "KeyZ");
    d.ime.input("z", "insertText");
    expect(d.docs[0]!.paragraphs).toEqual(["하zab"]);
    expect(await answerCommits(d.calls, 1)).toBe(2);
  });

  it("A에서 확정한 조합의 늦은 끝·확정 입력이 B 표면에 와도 B에 넣지 않는다", async () => {
    const d = await twoDocuments();
    d.select(1);
    d.ime.start();
    d.ime.composing("하");
    act(() => d.textarea().blur()); // 탭을 눌러 초점이 옮겨 감 → A에 그 자리 확정
    d.select(2);
    d.ime.input("하", "insertFromComposition"); // 플랫폼이 새로 초점을 받은 요소로 보낸 같은 조합의 확정
    d.ime.end("하");
    expect(d.docs[0]!.paragraphs).toEqual(["하ab"]);
    expect(d.docs[1]!.paragraphs).toEqual(["xy"]);
    d.ime.imeKey(); // B에서 새로 입력하면 B에 들어간다
    d.ime.composing("나");
    d.ime.end("나");
    expect(d.docs[1]!.paragraphs).toEqual(["나xy"]);
    expect(await answerCommits(d.calls, 1)).toBe(1);
    expect(await answerCommits(d.calls, 2)).toBe(1);
  });
});

describe("P1-B 엔진 변경이 일부만 된 뒤 예외", () => {
  async function workspaceReady(text: string[]) {
    const { backend, calls, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const doc = new FakeDocument(text);
    const workspace = new DocumentWorkspace(sessions, backend, async () => ({ openDocument: () => doc as unknown as RhwpDocument }));
    const opening = workspace.open("/a.hwp");
    take("open").reply(ok(base));
    await flush();
    take("load").reply(loaded());
    await flush();
    take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
    take("setState").reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
    await opening;
    await flush();
    return { workspace, editor: workspace.editorFor(1)!, doc, calls, take };
  }

  const selectFirstTwo = (editor: RhwpEditorSession) => {
    editor.moveHorizontal(1, true);
    editor.moveHorizontal(1, true);
  };

  it("선택을 지운 뒤 넣기가 실패한 수정 전 문서는 버리기 확인 없이 닫히거나 다시 불러와지지 않는다", async () => {
    const w = await workspaceReady(["abcd"]);
    selectFirstTwo(w.editor);
    w.doc.insertText = () => {
      throw new Error("insert");
    };
    expect(w.editor.typeText("X")).toBe(false);
    expect(w.doc.paragraphs).toEqual(["cd"]); // 엔진 모델은 이미 바뀌었다
    await flush();
    expect(w.editor.status).toMatchObject({ kind: "failed", error: { code: "EngineFailure", stage: "edit" } });
    expect(w.editor.hasUnpreservedChanges).toBe(true);
    expect(w.editor.hasUncertainChanges).toBe(true);
    expect(await w.workspace.close(1)).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    expect(await w.editor.load()).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    expect(w.doc.freed).toBe(false);
    expect(w.calls.filter((call) => ["close", "load", "commit"].includes(call.method))).toEqual([]);
    expect(w.editor.localRevision).toBe(0); // 실패한 변경은 revision으로 세지 않는다
    expect(w.calls.find((call) => call.method === "setState")?.args).toEqual([1, 1, "ready", "failed"]);
  });

  it("선택을 지운 뒤 문단 나누기가 실패해도 같은 보호를 받는다", async () => {
    const w = await workspaceReady(["abcd"]);
    selectFirstTwo(w.editor);
    w.doc.splitParagraph = () => {
      throw new Error("split");
    };
    expect(w.editor.enter()).toBe(false);
    expect(w.doc.paragraphs).toEqual(["cd"]);
    expect(w.editor.hasUnpreservedChanges).toBe(true);
    expect(w.editor.localRevision).toBe(0);
  });

  it("문단 합치기 예외도 모델을 알 수 없는 상태로 보고 보호한다", async () => {
    const w = await workspaceReady(["ab", "cd"]);
    w.editor.moveVertical(1, false);
    w.editor.moveLineEdge("start", false);
    w.doc.failNext = true;
    expect(w.editor.backspace()).toBe(false);
    expect(w.editor.hasUnpreservedChanges).toBe(true);
    expect(await w.workspace.close(1)).toMatchObject({ ok: false, error: { code: "UnpreservedChanges" } });
  });

  it("수정 전 문서에서 조합 갱신이 실패하면 보호하고, 그 실패는 revision이 아니다", async () => {
    const w = await workspaceReady(["ab"]);
    w.editor.beginComposition();
    w.doc.failNext = true;
    w.editor.updateComposition("가");
    expect(w.editor.composing).toBe(false);
    expect(w.editor.hasUnpreservedChanges).toBe(true);
    expect(w.editor.localRevision).toBe(0);
  });

  it("버리기를 확인하면 다시 불러오고 새 모델은 수정 전·확실한 상태다", async () => {
    const w = await workspaceReady(["abcd"]);
    selectFirstTwo(w.editor);
    w.doc.insertText = () => {
      throw new Error("insert");
    };
    w.editor.typeText("X");
    await flush();
    w.take("setState").reply(ok(info({ state: "failed", sequence: 3, loadGeneration: 1 })));
    const reloading = w.editor.load({ discard: true });
    await flush(); // 5차: failed 전이 결과를 확인한 뒤에 불러온다
    w.take("load").reply(loaded(new Uint8Array([1]), 2));
    await flush();
    w.take("session").reply(ok(info({ state: "loading", sequence: 4, loadGeneration: 2 })));
    w.take("setState").reply(ok(info({ state: "ready", sequence: 5, loadGeneration: 2 })));
    expect(await reloading).toEqual({ ok: true, value: null });
    expect(w.editor.hasUnpreservedChanges).toBe(false);
    expect(w.editor.hasUncertainChanges).toBe(false);
  });

  it("화면은 모델이 일부만 바뀌었을 수 있다고 알리고, 다시 불러오기는 버리기 확인을 거친다", async () => {
    const { backend, calls, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const doc = new FakeDocument(["abcd"]);
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
    expect(view.getByTestId("rhwp-status").dataset.uncertain).toBe("false");
    act(() => selectFirstTwo(editor));
    doc.insertText = () => {
      throw new Error("insert");
    };
    act(() => void editor.typeText("X"));
    await act(flush);
    const status = view.getByTestId("rhwp-status");
    expect(status.dataset.status).toBe("failed");
    expect(status.dataset.uncertain).toBe("true");
    expect(view.getByTestId("rhwp-uncertain-warning")).toBeTruthy();
    expect(view.getByTestId("rhwp-unpreserved-warning")).toBeTruthy();
    act(() => view.getByTestId("rhwp-load").click());
    await act(flush);
    expect(view.getByRole("alertdialog").dataset.action).toBe("reload");
    expect(calls.some((call) => call.method === "load")).toBe(false);
  });

  it("성공한 변경 여러 개는 여전히 확정 하나로 묶인다", async () => {
    const r = await readySession(["ab"]);
    r.editor.typeText("1");
    r.editor.typeText("2");
    r.editor.typeText("3");
    const first = r.take("commit");
    expect(first.args).toEqual([1, 1, 0, 1]);
    first.reply(ok(info({ state: "ready", revision: 1, dirty: true, sequence: 3, loadGeneration: 1 })));
    await flush();
    expect(r.take("commit").args).toEqual([1, 1, 1, 2]);
    expect(r.editor.hasUncertainChanges).toBe(false);
  });
});

describe("P2-A 내보내기 검사는 다시 연 문서의 실제 형식을 본다", () => {
  const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  const ZIP = [0x50, 0x4b, 0x03, 0x04];
  const NO_LOSS = JSON.stringify({ count: 0, losses: [] });

  /** 내보낸 바이트 앞 서명으로 형식을 정하는 가짜 다시 열기(실제 엔진의 detect_format과 같은 기준). */
  async function exporting(options: {
    hwpBytes?: number[];
    hwpxBytes?: number[];
    reopenedFormat?: () => string;
    loss?: string;
  } = {}) {
    const ready = await readySession(["ab"]);
    const freed = { exported: 0, reopened: 0 };
    const exportOf = (bytes: number[]) => () => ({
      contentLoss: () => options.loss ?? NO_LOSS,
      takeBytes: () => new Uint8Array([...bytes, 0, 0, 0, 0]),
      free: () => void (freed.exported += 1),
    });
    ready.doc.exportHwpWithReport = exportOf(options.hwpBytes ?? CFB);
    (ready.doc as unknown as { exportHwpxWithReport: unknown }).exportHwpxWithReport = exportOf(options.hwpxBytes ?? ZIP);
    const module: RhwpModule = {
      openDocument: (bytes) => {
        const reopened = new FakeDocument(ready.doc.paragraphs);
        const signature = bytes[0] === 0xd0 ? "hwp" : bytes[0] === 0x50 ? "hwpx" : "hwp";
        reopened.getSourceFormat = options.reopenedFormat ?? (() => signature);
        reopened.free = () => void (freed.reopened += 1);
        return reopened as unknown as RhwpDocument;
      },
    };
    (ready.editor as unknown as { module: RhwpModule }).module = module;
    return { ...ready, freed };
  }

  it("HWP로 내보내 다시 연 문서가 HWP(CFB)면 통과", async () => {
    const r = await exporting();
    expect(r.editor.roundTrip("hwp")).toMatchObject({ reopenedFormat: "hwp", formatEqual: true, passed: true });
    expect(r.freed).toEqual({ exported: 1, reopened: 1 });
  });

  it("HWPX로 내보내 다시 연 문서가 HWPX(ZIP)면 통과", async () => {
    const r = await exporting();
    expect(r.editor.roundTrip("hwpx")).toMatchObject({ reopenedFormat: "hwpx", formatEqual: true, passed: true });
    expect(r.freed).toEqual({ exported: 1, reopened: 1 });
  });

  it("다시 연 문서의 형식이 요청한 형식과 다르면 통과가 아니다", async () => {
    const r = await exporting({ hwpxBytes: CFB }); // HWPX를 요청했는데 HWP 바이트가 나옴
    expect(r.editor.roundTrip("hwpx")).toMatchObject({ reopenedFormat: "hwp", formatEqual: false, passed: false });
  });

  it("엔진이 같은 형식이라고 해도 바이트 서명이 그 형식이 아니면 통과가 아니다", async () => {
    // rhwp getSourceFormat은 HWP 5·HWP 3 등 HWPX·HML이 아닌 것을 모두 "hwp"라고 한다.
    const r = await exporting({ hwpBytes: [0x48, 0x57, 0x50, 0x20], reopenedFormat: () => "hwp" });
    expect(r.editor.roundTrip("hwp")).toMatchObject({ formatEqual: false, passed: false });
  });

  it("형식을 알 수 없거나(빈 값·hml) 형식 조회가 실패하면 통과가 아니고 다시 연 문서를 놓는다", async () => {
    for (const reopenedFormat of [() => "", () => "hml", () => { throw new Error("format"); }]) {
      const r = await exporting({ reopenedFormat });
      expect(r.editor.roundTrip("hwp")).toMatchObject({ formatEqual: false, passed: false });
      expect(r.freed.reopened).toBe(1);
    }
  });

  it("손실 보고가 1건 이상이거나 형식이 틀리면 형식이 같아도 통과가 아니다", async () => {
    for (const loss of [JSON.stringify({ count: 1, losses: [{}] }), JSON.stringify({ count: 0 }), "{"]) {
      const r = await exporting({ loss });
      expect(r.editor.roundTrip("hwp"), loss).toMatchObject({ formatEqual: true, passed: false });
    }
  });
});

describe("P2-B 페이지 정보가 올바를 때만 ready", () => {
  async function loadWith(patch: (doc: FakeDocument) => void) {
    const { backend, calls, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const opening = sessions.open("/a.hwp");
    take("open").reply(ok(base));
    await opening;
    const doc = new FakeDocument(["ab"]);
    patch(doc);
    const editor = new RhwpEditorSession(1, backend, sessions, async () => ({ openDocument: () => doc as unknown as RhwpDocument }));
    const done = editor.load();
    take("load").reply(loaded());
    await flush();
    take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
    await flush();
    const transition = take("setState");
    const target = transition.args[3];
    transition.reply(ok(info({ state: target as "ready" | "failed", sequence: 2, loadGeneration: 1 })));
    await done;
    return { editor, doc, calls, target };
  }

  it("올바른 페이지 정보(여러 쪽)는 ready", async () => {
    const l = await loadWith((doc) => {
      doc.pageCount = () => 2;
      doc.getPageInfo = (page: number) => JSON.stringify({ pageIndex: page, width: 793.7, height: 1122.5 });
    });
    expect(l.target).toBe("ready");
    expect(l.editor.pages).toEqual([{ width: 793.7, height: 1122.5 }, { width: 793.7, height: 1122.5 }]);
  });

  const invalidInfo: Array<[string, string]> = [
    ["JSON 아님", "{width:"],
    ["객체 아님", "[]"],
    ["너비 없음", JSON.stringify({ height: 1000 })],
    ["높이 null", JSON.stringify({ width: 800, height: null })],
    ["너비 0", JSON.stringify({ width: 0, height: 1000 })],
    ["높이 음수", JSON.stringify({ width: 800, height: -1 })],
    ["너비 문자열", JSON.stringify({ width: "800", height: 1000 })],
    ["무한대(1e400)", '{"width":1e400,"height":1000}'],
    ["엔진 캔버스 한도(16384px) 초과", JSON.stringify({ width: 16385, height: 1000 })],
    ["다른 쪽 번호", JSON.stringify({ pageIndex: 3, width: 800, height: 1000 })],
  ];
  for (const [name, json] of invalidInfo) {
    it(`페이지 정보가 잘못되면(${name}) ready가 아니라 failed(render)이고 문서를 놓는다`, async () => {
      const l = await loadWith((doc) => {
        doc.getPageInfo = () => json;
      });
      expect(l.target).toBe("failed");
      expect(l.editor.status).toMatchObject({ kind: "failed", error: { code: "EngineFailure", stage: "render" } });
      expect(l.editor.editable).toBe(false);
      expect(l.doc.freed).toBe(true);
    });
  }

  for (const count of [0, -1, 1.5, Number.NaN]) {
    it(`쪽 수가 엔진 계약(1 이상 정수)이 아니면(${count}) failed(render)`, async () => {
      const l = await loadWith((doc) => {
        doc.pageCount = () => count;
      });
      expect(l.target).toBe("failed");
      expect(l.editor.status).toMatchObject({ kind: "failed", error: { stage: "render" } });
    });
  }

  it("편집 뒤 페이지 정보가 잘못되면 그 변경은 세고 편집을 멈춘다", async () => {
    const r = await readySession(["ab"]);
    r.doc.getPageInfo = () => JSON.stringify({ width: 800, height: 0 });
    r.editor.typeText("X");
    expect(r.editor.localRevision).toBe(1);
    await flush();
    expect(r.editor.status).toMatchObject({ kind: "failed", error: { stage: "render" } });
  });
});
