// T010 마무리 안정화: 대기 중인 실행 취소·다시 실행의 가용성(queuedHistory). 편집 세션·레지스트리는 실제 코드이고 백엔드는
// FakeDocx 흉내다(WordCraft 기록 규칙 — 성공한 바꾸는 연산마다 기록 지점, 타자 묶기, 거부는 기록 그대로 — 을 따르지만 엔진 동작의
// 증거는 아님: 그것은 src-tauri adapters::wordcraft 시험). 각 시험은 중간의 가용성·대기열에 받았는지와 응답 뒤의 모델·기록·revision을
// 함께 본다.
import { describe, expect, it } from "vitest";
import { initialLayout } from "../hooks/layoutState";
import type { Message } from "../language";
import { FakeDocx, flush, readyDocx } from "../components/Editor/wordcraft/testing";
import type { DocxEditorSession } from "../components/Editor/wordcraft/DocxEditorSession";
import { commandState, executeCommand, type CommandContext } from "./commands";

const sentOps = (fake: FakeDocx) =>
  (fake.calls.filter((call) => call.method === "edit").flatMap((call) => call.args[3]) as { op: string }[]).map((op) => op.op);

async function harness(text?: string[]) {
  const { editor, fake } = await readyDocx(text);
  const notices: Message[] = [];
  const context: CommandContext = { layout: initialLayout, dispatch: () => {}, notify: (message) => notices.push(message), document: editor };
  return {
    editor, fake, notices,
    run: (id: string) => executeCommand(id, undefined, context),
    state: (id: string) => commandState(id, context),
    reasons: () => notices.map((notice) => notice.key.replace("command.unavailable.", "")),
  };
}

const release = async (fake: FakeDocx) => {
  for (let i = 0; i < 8; i++) {
    fake.release();
    await flush();
  }
};

const view = (editor: DocxEditorSession) => editor.snapshot().history;

describe("대기 중인 실행 취소·다시 실행의 가용성", () => {
  it("1–3. 기록이 빈 문서에서 이동·선택·표지만 대기 중이면 어느 쪽도 쓸 수 없고 대기열에 넣지 않는다", async () => {
    const t = await harness();
    t.fake.hold = true;
    t.editor.move("right", false);
    expect(t.editor.snapshot().queuedHistory).toEqual({ undo: "none", redo: "none" });
    t.editor.move("right", true);
    t.editor.selectAll();
    t.editor.markCaret();
    expect(t.editor.snapshot().queuedHistory).toEqual({ undo: "none", redo: "none" });
    expect([t.run("edit.undo"), t.run("edit.redo")]).toEqual([false, false]);
    expect(t.reasons()).toEqual(["nothingToUndo", "nothingToRedo"]);
    await release(t.fake);
    expect(sentOps(t.fake)).not.toContain("undo");
    expect(sentOps(t.fake)).not.toContain("redo");
    expect(t.fake.info.revision).toBe(0);
  });

  it("4. 기록이 빈 문서에서 넣기가 대기 중이면 실행 취소 하나만 그 뒤에 받고, 응답 뒤 문서·기록이 처음과 같다", async () => {
    const t = await harness();
    t.fake.hold = true;
    t.editor.typeText("가");
    expect(t.state("edit.undo")).toEqual({ available: true });
    expect(t.run("edit.undo")).toBe(true);
    // 넣기가 만든 단계를 실행 취소가 썼다. 남은 단계는 응답 전에 모른다 → 더 받지 않는다. 다시 실행은 하나 생긴다.
    expect(t.editor.snapshot().queuedHistory).toEqual({ undo: "unknown", redo: "available" });
    expect(t.run("edit.undo")).toBe(false);
    expect(t.reasons()).toEqual(["pendingEdits"]);
    await release(t.fake);
    expect(sentOps(t.fake)).toEqual(["insertText", "undo"]);
    expect(t.fake.paragraphs[0]).toBe("가나다");
    expect(t.fake.info.revision).toBe(2);
    expect(view(t.editor)).toEqual({ undo: false, redo: true });
    expect(t.state("edit.undo")).toEqual({ available: false, reason: "nothingToUndo" });
  });

  it("5. 엔진이 거부할 넣기 뒤의 실행 취소는(엔진만 거부를 앎) 받지만 엔진이 아무것도 바꾸지 않는다", async () => {
    const t = await harness();
    t.fake.refuseText = () => true;
    t.fake.hold = true;
    t.editor.typeText("가");
    expect(t.run("edit.undo")).toBe(true);
    expect(t.run("edit.undo")).toBe(false);
    await release(t.fake);
    expect(sentOps(t.fake)).toEqual(["insertText", "undo"]);
    expect(t.fake.paragraphs[0]).toBe("가나다");
    expect(t.fake.info.revision).toBe(0);
    expect(view(t.editor)).toEqual({ undo: false, redo: false });
  });

  it("6–7. 실행 취소 단계가 하나일 때 대기 중인 실행 취소 뒤의 실행 취소는 응답까지 받지 않는다(되풀이해도)", async () => {
    const t = await harness();
    t.editor.typeText("가");
    await flush();
    expect(view(t.editor)).toEqual({ undo: true, redo: false });
    t.fake.hold = true;
    expect([t.run("edit.undo"), t.run("edit.undo"), t.run("edit.undo")]).toEqual([true, false, false]);
    expect(t.state("edit.redo")).toEqual({ available: true });
    expect(t.reasons()).toEqual(["pendingEdits", "pendingEdits"]);
    await release(t.fake);
    expect(sentOps(t.fake)).toEqual(["insertText", "undo"]);
    expect(t.fake.paragraphs[0]).toBe("가나다");
    expect(t.fake.info.revision).toBe(2);
    expect(t.state("edit.undo")).toEqual({ available: false, reason: "nothingToUndo" });
  });

  it("8–9. 다시 실행 단계가 하나일 때 대기 중인 다시 실행 뒤의 다시 실행은 받지 않는다", async () => {
    const t = await harness();
    t.editor.typeText("가");
    await flush();
    t.run("edit.undo");
    await flush();
    expect(view(t.editor)).toEqual({ undo: false, redo: true });
    t.fake.hold = true;
    expect([t.run("edit.redo"), t.run("edit.redo"), t.run("edit.redo")]).toEqual([true, false, false]);
    expect(t.editor.snapshot().queuedHistory).toEqual({ undo: "available", redo: "unknown" });
    await release(t.fake);
    expect(sentOps(t.fake)).toEqual(["insertText", "undo", "redo"]);
    expect(t.fake.paragraphs[0]).toBe("가가나다");
    expect(t.fake.info.revision).toBe(3);
    expect(view(t.editor)).toEqual({ undo: true, redo: false });
  });

  it("10. 단계가 여럿이어도 빠른 실행 취소는 응답마다 하나씩 받는다(단계 수를 엔진이 알려 주지 않으므로)", async () => {
    const t = await harness();
    for (const text of ["가", "나", "다"]) {
      t.editor.typeText(text);
      t.editor.move("left", false); // 타자 묶음을 닫아 단계를 나눈다
    }
    await flush();
    expect(view(t.editor)).toEqual({ undo: true, redo: false });
    t.fake.hold = true;
    let accepted = 0;
    for (let round = 0; round < 4; round++) {
      expect([t.run("edit.undo"), t.run("edit.undo")]).toEqual([round < 3, false]);
      if (round < 3) accepted += 1;
      await release(t.fake);
    }
    expect(accepted).toBe(3);
    expect(sentOps(t.fake).filter((op) => op === "undo")).toHaveLength(3);
    expect(t.fake.paragraphs[0]).toBe("가나다");
    expect(t.fake.info.revision).toBe(6);
    expect(view(t.editor)).toEqual({ undo: false, redo: true });
  });

  it("11. 응답 전 실행 취소 → 다시 실행은 받고, 그 뒤의 다시 실행은 없다고 알며 실행 취소는 다시 쓸 수 있다", async () => {
    const t = await harness();
    t.editor.typeText("가");
    await flush();
    t.fake.hold = true;
    expect([t.run("edit.undo"), t.run("edit.redo")]).toEqual([true, true]);
    expect(t.editor.snapshot().queuedHistory).toEqual({ undo: "available", redo: "none" });
    expect(t.state("edit.redo")).toEqual({ available: false, reason: "nothingToRedo" });
    await release(t.fake);
    expect(t.fake.paragraphs[0]).toBe("가가나다");
    expect(view(t.editor)).toEqual({ undo: true, redo: false });
  });

  it("12. 실행 취소 → 새 편집(응답 전) 뒤 다시 실행은 받지 않는다(새 편집이 다시 실행 기록을 버림)", async () => {
    const t = await harness();
    t.editor.typeText("가");
    await flush();
    t.fake.hold = true;
    expect(t.run("edit.undo")).toBe(true);
    t.editor.typeText("나");
    expect(t.editor.snapshot().queuedHistory).toEqual({ undo: "available", redo: "none" });
    expect(t.run("edit.redo")).toBe(false);
    expect(t.reasons()).toEqual(["nothingToRedo"]);
    await release(t.fake);
    expect(t.fake.paragraphs[0]).toBe("나가나다");
    expect(view(t.editor)).toEqual({ undo: true, redo: false });
  });

  it("13. 커서만 둔 서식은 revision 없이 기록 단계를 만들고, 그 실행 취소도 revision 없이 다음 입력 서식만 되돌린다", async () => {
    const t = await harness();
    expect(t.run("format.bold")).toBe(true);
    await flush();
    expect(t.fake.info.revision).toBe(0);
    expect(view(t.editor)).toEqual({ undo: true, redo: false });
    expect(t.state("format.bold")).toEqual({ available: true, pressed: true });
    expect(t.run("edit.undo")).toBe(true);
    await flush();
    expect(t.fake.info).toMatchObject({ revision: 0, dirty: false });
    expect(t.state("format.bold")).toEqual({ available: true, pressed: false });
    expect(view(t.editor)).toEqual({ undo: false, redo: true });
  });

  it("14. 문서를 바꾸지 않은 바꾸는 명령(문서 처음의 Backspace)은 기록 단계만 만들고 revision은 그대로다", async () => {
    const t = await harness();
    t.fake.hold = true;
    t.editor.backspace();
    expect(t.run("edit.undo")).toBe(true);
    await release(t.fake);
    expect(sentOps(t.fake)).toEqual(["backspace", "undo"]);
    expect(t.fake.paragraphs[0]).toBe("가나다");
    expect(t.fake.info.revision).toBe(0);
    expect(view(t.editor)).toEqual({ undo: false, redo: true });
  });

  it("15. 대기 중인 실행 취소는 다시 불러오기·닫기 뒤에 보내지 않고, 예상도 버린다", async () => {
    const t = await harness();
    t.editor.typeText("가");
    await flush();
    t.fake.hold = true;
    t.editor.typeText("나");
    expect(t.run("edit.undo")).toBe(true);
    const reloading = t.editor.load({ discard: true });
    await release(t.fake);
    expect((await reloading).ok).toBe(true);
    await release(t.fake);
    expect(sentOps(t.fake)).toEqual(["insertText", "insertText"]);
    expect(t.editor.snapshot()).toMatchObject({ loadGeneration: 2, queuedHistory: null, history: { undo: false, redo: false } });
    t.editor.setClosing(true);
    expect(t.state("edit.undo")).toEqual({ available: false, reason: "notReady" });
  });

  it("16. 엔진이 거부한 서식(편집 가능 영역 밖) 뒤에 받은 실행 취소는 엔진 기록대로만 실행되고 거부를 알린다", async () => {
    const t = await harness();
    t.fake.formatAccess = "regions";
    t.fake.refuseFormat = true;
    t.editor.typeText("가");
    t.editor.move("right", true);
    await flush();
    t.fake.hold = true;
    expect(t.run("format.bold")).toBe(true);
    expect(t.editor.snapshot().queuedHistory).toEqual({ undo: "available", redo: "none" });
    expect(t.run("edit.undo")).toBe(true);
    await release(t.fake);
    expect(t.editor.inputNotice).toBe("commandRejected");
    // 서식은 기록을 만들지 않았으므로 실행 취소는 앞선 넣기를 되돌린다(엔진 기록이 권한).
    expect(t.fake.paragraphs[0]).toBe("가나다");
    expect(t.fake.info.revision).toBe(2);
    expect(view(t.editor)).toEqual({ undo: false, redo: true });
  });

  it("17. 두 문서에 번갈아 보낸 빠른 실행 취소는 각 문서의 기록만 쓴다", async () => {
    const a = await harness(["첫"]);
    const b = await harness(["둘"]);
    a.editor.typeText("가");
    b.editor.typeText("나");
    await flush();
    a.fake.hold = true;
    b.fake.hold = true;
    expect([a.run("edit.undo"), b.run("edit.undo"), a.run("edit.undo"), b.run("edit.undo")]).toEqual([true, true, false, false]);
    await release(a.fake);
    await release(b.fake);
    expect([sentOps(a.fake), sentOps(b.fake)]).toEqual([["insertText", "undo"], ["insertText", "undo"]]);
    expect([a.fake.paragraphs[0], b.fake.paragraphs[0]]).toEqual(["첫", "둘"]);
  });
});
