import { describe, expect, it } from "vitest";
import { DocumentSessions } from "../../../adapters/sessions";
import { RhwpEditorSession } from "./RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
import { base, controlledBackend, fail, FakeDocument, flush, info, ok, loaded, readySession } from "./testing";

describe("rhwp 편집 세션: 불러오기", () => {
  it("백엔드가 준 바이트로 엔진 문서를 만들고 ready를 확정한 뒤에야 편집할 수 있다", async () => {
    const { editor, sessions } = await readySession();
    expect(editor.status).toEqual({ kind: "ready" });
    expect(editor.editable).toBe(true);
    expect(sessions.get(1)).toMatchObject({ state: "ready", revision: 0, sequence: 2 });
    expect(editor.pages).toEqual([{ width: 800, height: 1000 }]);
  });

  it("엔진이 문서를 읽지 못하면 failed로 돌리고, 다시 불러와 회복할 수 있다", async () => {
    const { backend, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const opening = sessions.open("/a.hwp");
    take("open").reply(ok(base));
    await opening;
    let attempt = 0;
    const module: RhwpModule = {
      openDocument: () => {
        attempt += 1;
        if (attempt === 1) throw new Error("parse");
        return new FakeDocument(["x"]) as unknown as RhwpDocument;
      },
    };
    const editor = new RhwpEditorSession(1, backend, sessions, async () => module);
    const first = editor.load();
    take("load").reply(loaded());
    await flush();
    take("session").reply(ok(info({ state: "loading", sequence: 1 })));
    const failed = take("setState");
    expect(failed.args).toEqual([1, 1, "loading", "failed"]);
    failed.reply(ok(info({ state: "failed", sequence: 2 })));
    await first;
    expect(editor.status).toEqual({ kind: "failed", error: { code: "EngineFailure", engine: "rhwp", stage: "parse" } });
    expect(editor.typeText("a")).toBe(false);

    const second = editor.load();
    take("load").reply(loaded(new Uint8Array([1]), 2));
    await flush();
    take("session").reply(ok(info({ state: "loading", sequence: 3, loadGeneration: 2 })));
    const ready = take("setState");
    expect(ready.args).toEqual([1, 2, "loading", "ready"]); // 새 시도의 번호로만 전이한다
    ready.reply(ok(info({ state: "ready", sequence: 4, loadGeneration: 2 })));
    await second;
    expect(editor.status).toEqual({ kind: "ready" });
  });

  it("불러오는 중에 닫으면 늦은 응답이 세션을 되살리지 않고 엔진 문서를 버린다", async () => {
    const { backend, take, calls } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const opening = sessions.open("/a.hwp");
    take("open").reply(ok(base));
    await opening;
    const doc = new FakeDocument(["x"]);
    const editor = new RhwpEditorSession(1, backend, sessions, async () => ({ openDocument: () => doc as unknown as RhwpDocument }));
    const loading = editor.load();
    take("load").reply(loaded());
    await flush();
    take("session").reply(ok(info({ state: "loading", sequence: 1 })));
    editor.dispose();
    take("setState").reply(fail({ code: "StaleSession", sessionId: 1 }));
    await loading;
    expect(editor.status).toEqual({ kind: "closed" });
    expect(doc.freed).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("rhwp 편집 세션: revision 확정", () => {
  it("성공한 변경마다 정확히 1씩, 기다리는 동안의 변경은 다음 확정에 묶어 순서대로 보낸다", async () => {
    const { editor, sessions, take, calls } = await readySession();
    expect(editor.typeText("한")).toBe(true);
    const first = take("commit");
    expect(first.args).toEqual([1, 1, 0, 1]);
    // 첫 확정을 기다리는 동안 두 번 더 바꿈 → 다음 확정은 base 1, count 2 하나뿐(중복·순서 바뀜 없음)
    editor.typeText("글");
    editor.backspace();
    expect(calls.filter((call) => call.method === "commit")).toHaveLength(0);
    first.reply(ok(info({ state: "ready", revision: 1, dirty: true, sequence: 3 })));
    await flush();
    const second = take("commit");
    expect(second.args).toEqual([1, 1, 1, 2]);
    second.reply(ok(info({ state: "ready", revision: 3, dirty: true, sequence: 4 })));
    await flush();
    expect(sessions.get(1)).toMatchObject({ revision: 3, dirty: true });
    expect(editor.localRevision).toBe(3);
  });

  it("커서 이동·선택·문맥 처음의 Backspace·엔진이 거부한 변경은 revision을 올리지 않는다", async () => {
    const { editor, doc, calls } = await readySession();
    editor.moveHorizontal(1, false);
    editor.moveHorizontal(1, true);
    editor.moveVertical(1, false);
    editor.moveLineEdge("end", false);
    editor.pointAt(0, 0, 0, false);
    expect(editor.backspace()).toBe(false); // 문서 처음
    expect(calls.filter((call) => call.method === "commit")).toEqual([]);
    expect(editor.localRevision).toBe(0);

    doc.failNext = true;
    expect(editor.typeText("x")).toBe(false);
    await flush();
    expect(editor.status).toEqual({ kind: "failed", error: { code: "EngineFailure", engine: "rhwp", stage: "edit" } });
    expect(calls.map((call) => [call.method, call.args])).toEqual([["setState", [1, 1, "ready", "failed"]]]);
    expect(editor.localRevision).toBe(0);
  });

  it("백엔드가 기준 revision을 거부하면(다른 쓰는 쪽·중복) 조용히 이어 가지 않고 세션을 failed로 돌린다", async () => {
    const { editor, take } = await readySession();
    editor.typeText("a");
    take("commit").reply(fail({ code: "RevisionMismatch", sessionId: 1, revision: 5 }));
    await flush();
    expect(editor.status).toMatchObject({ kind: "failed", error: { code: "RevisionMismatch" } });
    expect(take("setState").args).toEqual([1, 1, "ready", "failed"]);
    expect(editor.typeText("b")).toBe(false);
  });

  it("확정을 기다리는 동안 닫으면 늦은 응답을 무시하고 문서를 버린다", async () => {
    const { editor, doc, take, sessions } = await readySession();
    editor.typeText("a");
    const pending = take("commit");
    editor.dispose();
    pending.reply(ok(info({ state: "ready", revision: 1, dirty: true, sequence: 3 })));
    await flush();
    expect(doc.freed).toBe(true);
    expect(sessions.get(1)?.revision).toBe(0); // 닫은 뒤의 응답은 투영에 반영하지 않음
  });

  it("세션마다 revision이 따로이며, 활성 문서를 바꿔도 다른 세션의 확정은 그 세션에만 반영된다", async () => {
    const one = await readySession(["one"]);
    one.sessions.applyUpdate(info({ state: "ready", sequence: 2 }));
    one.editor.typeText("x");
    const commit = one.take("commit");
    // 같은 투영에 두 번째 세션을 열고 활성으로 바꿈
    const opening = one.sessions.open("/b.hwp");
    one.take("open").reply(ok(info({ sessionId: 2, displayName: "b.hwp" })));
    await opening;
    expect(one.sessions.snapshot().activeId).toBe(2);
    commit.reply(ok(info({ state: "ready", revision: 1, dirty: true, sequence: 3 })));
    await flush();
    expect(one.sessions.get(1)).toMatchObject({ revision: 1, dirty: true });
    expect(one.sessions.get(2)).toMatchObject({ revision: 0, dirty: false });
    expect(one.sessions.snapshot().activeId).toBe(2);
  });
});

describe("rhwp 편집 세션: IME 조합과 키보드", () => {
  it("조합 중 갱신은 문서에 보이되 확정하지 않고, 조합이 끝날 때 한 번만 변경으로 센다", async () => {
    const { editor, doc, take, calls } = await readySession(["", ""]);
    editor.beginComposition();
    for (const step of ["ㅎ", "하", "한"]) editor.updateComposition(step);
    expect(doc.paragraphs[0]).toBe("한");
    expect(editor.compositionRects()).toHaveLength(1);
    expect(calls.filter((call) => call.method === "commit")).toEqual([]);
    expect(editor.endComposition("한")).toBe("한");
    expect(take("commit").args).toEqual([1, 1, 0, 1]);
    expect(doc.paragraphs[0]).toBe("한");
    expect(editor.caret).toMatchObject({ paragraph: 0, offset: 1 });
  });

  it("조합 중 마지막 갱신과 확정 문자열이 달라도 문서에는 확정 문자열 하나만 남는다", async () => {
    const { editor, doc } = await readySession(["ab"]);
    editor.moveHorizontal(1, false);
    editor.beginComposition();
    editor.updateComposition("글");
    editor.endComposition("글자");
    expect(doc.paragraphs[0]).toBe("a글자b");
  });

  it("글자 없이 끝난 조합(취소)은 넣었던 글자를 지우고 변경이 아니다", async () => {
    const { editor, doc, calls } = await readySession(["ab"]);
    editor.beginComposition();
    editor.updateComposition("ㅎ");
    expect(editor.endComposition("")).toBe("");
    expect(doc.paragraphs[0]).toBe("ab");
    expect(calls.filter((call) => call.method === "commit")).toEqual([]);
  });

  it("선택을 지우고 시작한 조합은 취소돼도 변경 하나다", async () => {
    const { editor, doc, take } = await readySession(["abcd"]);
    editor.moveHorizontal(1, false);
    editor.moveHorizontal(1, true);
    editor.moveHorizontal(1, true);
    editor.beginComposition();
    editor.endComposition("");
    expect(doc.paragraphs[0]).toBe("ad");
    expect(take("commit").args).toEqual([1, 1, 0, 1]);
  });

  it("Enter·Backspace·Delete·선택 삭제가 문단과 커서를 올바르게 바꾼다", async () => {
    const { editor, doc } = await readySession(["가나다", "abc"]);
    editor.moveHorizontal(1, false);
    editor.enter();
    expect(doc.paragraphs).toEqual(["가", "나다", "abc"]);
    expect(editor.caret).toMatchObject({ paragraph: 1, offset: 0 });
    editor.backspace(); // 문단 처음: 앞 문단과 합침
    expect(doc.paragraphs).toEqual(["가나다", "abc"]);
    expect(editor.caret).toMatchObject({ paragraph: 0, offset: 1 });
    editor.moveLineEdge("end", false);
    editor.deleteForward(); // 문단 끝: 다음 문단을 붙임
    expect(doc.paragraphs).toEqual(["가나다abc"]);
    editor.moveLineEdge("start", false);
    editor.moveHorizontal(1, true);
    editor.moveHorizontal(1, true);
    expect(editor.selectionRects()).toHaveLength(1);
    editor.typeText("X");
    expect(doc.paragraphs).toEqual(["X다abc"]);
    expect(editor.hasSelection).toBe(false);
  });
});

describe("rhwp 편집 세션: 내보내기 검사", () => {
  it("메모리에서 내보내고 다시 열어 비교하며 파일을 쓰지 않는다", async () => {
    const { backend, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const opening = sessions.open("/a.hwp");
    take("open").reply(ok(base));
    await opening;
    const module: RhwpModule = {
      openDocument: (bytes) => new FakeDocument(new TextDecoder().decode(bytes).split("\n").filter(Boolean).length ? new TextDecoder().decode(bytes).split("\n") : ["가"]) as unknown as RhwpDocument,
    };
    const editor = new RhwpEditorSession(1, backend, sessions, async () => module);
    const loading = editor.load();
    take("load").reply(loaded(new TextEncoder().encode("가\nb")));
    await flush();
    take("session").reply(ok(info({ state: "loading", sequence: 1 })));
    take("setState").reply(ok(info({ state: "ready", sequence: 2 })));
    await loading;
    const report = editor.roundTrip("hwp");
    expect(report).toMatchObject({ format: "hwp", lossCount: 0, pagesEqual: true, textEqual: true, controlsEqual: true });
    expect(Object.keys(backend)).not.toContain("save");
  });
});
