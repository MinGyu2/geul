// DOCX 편집 세션(T008)의 순서·수명주기·IME 계약. 가짜 백엔드(testing.ts)는 Rust 어댑터의 계약을 흉내 낸다.
import { describe, expect, it } from "vitest";
import { ImeContext, ImeInput } from "../rhwp/imeInput";
import { DocxEditorSession } from "./DocxEditorSession";
import { decodeFake, docxSessions, FakeDocx, flush, readyDocx, recordingCanvas } from "./testing";

const edits = (fake: FakeDocx) => fake.calls.filter((call) => call.method === "edit");

describe("DocxEditorSession", () => {
  it("불러오면 백엔드가 ready로 전이하고 투영·보기가 맞는다", async () => {
    const { editor, sessions } = await readyDocx();
    expect(editor.status.kind).toBe("ready");
    expect(sessions.get(1)).toMatchObject({ state: "ready", loadGeneration: 1, revision: 0, dirty: false });
    expect(editor.view?.paragraphText).toBe("가나다");
    expect(editor.editable).toBe(true);
  });

  it("요청은 한 번에 하나이고 기다리는 동안의 입력은 다음 요청에 순서대로 묶인다", async () => {
    const { editor, fake, sessions } = await readyDocx();
    fake.hold = true;
    editor.typeText("한");
    editor.typeText("글");
    editor.backspace();
    editor.typeText("국");
    expect(edits(fake)).toHaveLength(1);
    expect(editor.pendingOps).toBe(4);
    fake.release();
    await flush();
    fake.release();
    await flush();
    expect(edits(fake)).toHaveLength(2);
    expect(edits(fake)[1]!.args[2]).toBe(1); // 둘째 요청의 기준 = 첫 응답의 판
    expect(edits(fake)[1]!.args[3]).toEqual([{ op: "insertText", text: "글" }, { op: "backspace" }, { op: "insertText", text: "국" }]);
    expect(fake.paragraphs[0]).toBe("한국가나다");
    expect(sessions.get(1)).toMatchObject({ revision: 4, dirty: true });
    expect(editor.revision).toBe(4);
    expect(editor.busy).toBe(false);
  });

  it("문서를 바꾸지 않은 연산은 revision을 늘리지 않는다(백엔드 판정)", async () => {
    const { editor, sessions } = await readyDocx();
    editor.move("docStart", false);
    editor.backspace(); // 처음의 Backspace
    await flush();
    expect(sessions.get(1)?.revision).toBe(0);
    expect(editor.hasUnpreservedChanges).toBe(false);
  });

  it("끌기의 연속 위치는 마지막 것만 보낸다", async () => {
    const { editor, fake } = await readyDocx();
    fake.hold = true;
    editor.typeText("x");
    editor.pointAt(0, 80, 80, true);
    editor.pointAt(0, 90, 80, true);
    editor.pointAt(0, 100, 80, true);
    fake.release();
    await flush();
    fake.release();
    await flush();
    expect(edits(fake)[1]!.args[3]).toEqual([{ op: "pointer", page: 0, x: 100, y: 80, extend: true, beforeInsert: false }]);
  });

  it("IME: 조합 중에는 모델을 바꾸지 않고, 끝에 확정 글자 하나를 연산 하나로 보낸다. 취소는 연산 없음", async () => {
    const { editor, fake, sessions } = await readyDocx();
    const ime = new ImeInput(editor, new ImeContext());
    ime.input("ㅎ", "insertCompositionText", true); // WebKitGTK: compositionstart 없이 시작
    ime.input("하", "insertCompositionText", true);
    ime.input("한", "insertCompositionText", true);
    expect(editor.composing).toBe(true);
    expect(editor.compositionText).toBe("한");
    expect(edits(fake)).toHaveLength(0);
    ime.compositionEnd("한");
    await flush();
    expect(fake.paragraphs[0]).toBe("한가나다");
    expect(sessions.get(1)?.revision).toBe(1);
    ime.keyDown(false);
    ime.compositionStart();
    ime.input("ㄱ", "insertCompositionText", true);
    ime.compositionEnd("");
    await flush();
    expect(edits(fake)).toHaveLength(1);
    expect(editor.composing).toBe(false);
  });

  it("IME: 선택이 있을 때 시작한 조합은 시작할 때 선택을 지운다", async () => {
    const { editor, fake } = await readyDocx();
    editor.move("right", true);
    editor.move("right", true);
    await flush();
    editor.beginComposition();
    editor.updateComposition("마");
    editor.endComposition("마");
    await flush();
    expect(fake.paragraphs[0]).toBe("마다");
  });

  it("조합 중 클릭: 보이던 조합을 원래 자리에 넣고, 클릭은 넣기 전 화면의 좌표로 찾는다. 입력기 최종 글자가 다르면 고친다", async () => {
    const { editor, fake, sessions } = await readyDocx();
    const ime = new ImeInput(editor, new ImeContext());
    ime.input("하", "insertCompositionText", true);
    ime.pointerDown();
    // 넣기 전 화면에서 1번째 문단 '가나다'의 2번째 글자 앞(x = 72 + 20).
    editor.pointAt(0, 92, 80, false);
    await flush();
    expect(fake.paragraphs[0]).toBe("하가나다");
    expect(fake.caret).toEqual({ p: 0, o: 3 }); // 넣은 한 글자만큼 밀림
    expect(edits(fake).flatMap((call) => call.args[3] as unknown[])).toEqual([
      { op: "insertText", text: "하" },
      { op: "pointer", page: 0, x: 92, y: 80, extend: false, beforeInsert: true },
    ]);
    // 입력기의 꼬리: 빈 끝 → 최종 글자 '한'.
    ime.keyDown(true);
    ime.input("", "deleteCompositionText", true);
    ime.compositionEnd("");
    ime.keyDown(true);
    ime.input("한", "insertFromComposition", true);
    ime.compositionEnd("한");
    await flush();
    expect(fake.paragraphs[0]).toBe("한가나다");
    expect(fake.caret).toEqual({ p: 0, o: 3 });
    expect(sessions.get(1)?.revision).toBe(2);
    // 같은 글자로 끝나면 고치지 않는다.
    const before = edits(fake).length;
    ime.keyDown(false);
    ime.input("ㄱ", "insertCompositionText", true);
    ime.pointerDown();
    editor.pointAt(0, 72, 100, false);
    ime.keyDown(true);
    ime.input("", "deleteCompositionText", true);
    ime.compositionEnd("");
    ime.keyDown(true);
    ime.input("ㄱ", "insertFromComposition", true);
    ime.compositionEnd("ㄱ");
    await flush();
    expect(edits(fake).slice(before).flatMap((call) => call.args[3] as unknown[]).some((op) => (op as { op: string }).op === "replaceInserted")).toBe(false);
    expect(fake.paragraphs).toEqual(["한가나ㄱ다", "abc"]);
    expect(fake.caret).toEqual({ p: 1, o: 0 });
  });

  it("미리보기 없는 조합 중 클릭: 클릭 전 커서를 기억하고 늦은 확정을 그 자리에 한 번 넣는다", async () => {
    const { editor, fake } = await readyDocx();
    const ime = new ImeInput(editor, new ImeContext());
    editor.move("right", false);
    ime.pointerDown(); // 조합이 보이지 않음(페이지가 조합 입력을 받지 못한 플랫폼)
    editor.pointAt(0, 72, 100, false); // 둘째 문단 처음
    ime.compositionEnd("글");
    await flush();
    expect(fake.paragraphs).toEqual(["가글나다", "abc"]);
    expect(fake.caret).toEqual({ p: 1, o: 0 });
    expect(edits(fake).flatMap((call) => call.args[3] as { op: string }[]).map((op) => op.op)).toEqual(["move", "mark", "pointer", "insertAt"]);
  });

  it("기대하지 않은 거부는 편집을 멈추고 보내지 못한 입력을 버리며, 다시 불러오기는 버리기 확인 뒤 백엔드가 모델을 새로 읽는다", async () => {
    const { editor, fake, sessions } = await readyDocx();
    editor.typeText("가");
    await flush();
    fake.failNext = { code: "RevisionMismatch", sessionId: 1, revision: 9 };
    editor.typeText("나");
    await flush();
    expect(editor.status).toEqual({ kind: "failed", error: { code: "RevisionMismatch", sessionId: 1, revision: 9 } });
    expect(editor.editable).toBe(false);
    expect(editor.typeText("x")).toBe(false);
    expect(editor.hasUnpreservedChanges).toBe(true); // 확정한 '가'(dirty)
    expect(await editor.load()).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    const reloaded = await editor.load({ discard: true });
    expect(reloaded.ok).toBe(true);
    expect(fake.calls.filter((call) => call.method === "load").at(-1)!.args).toEqual([1, 1]); // 시도 1의 ready 모델을 버림
    expect(sessions.get(1)).toMatchObject({ state: "ready", loadGeneration: 2, dirty: false });
    expect(fake.paragraphs[0]).toBe("가나다");
    expect(editor.status.kind).toBe("ready");
  });

  it("엔진 실패는 failed와 세션 기록 다시 읽기", async () => {
    const { editor, fake, sessions } = await readyDocx();
    fake.failNext = { code: "EngineFailure", engine: "wordcraft", stage: "edit" };
    editor.typeText("가");
    await flush();
    expect(editor.status.kind).toBe("failed");
    expect(sessions.get(1)?.state).toBe("failed");
    // failed 세션은 버릴 것이 없으면 확인 없이 다시 불러온다(시도 번호 없이).
    expect((await editor.load()).ok).toBe(true);
    expect(fake.calls.filter((call) => call.method === "load").at(-1)!.args).toEqual([1, undefined]);
  });

  it("닫힌 뒤 늦게 온 응답은 무시한다", async () => {
    const { editor, fake } = await readyDocx();
    fake.hold = true;
    editor.typeText("가");
    editor.dispose();
    fake.release();
    await flush();
    expect(editor.status.kind).toBe("closed");
    expect(editor.view).toBeNull();
  });

  it("쪽 그림은 판·배율마다 한 번만 받고, 판이 바뀌면 새로 받는다", async () => {
    const { editor, fake } = await readyDocx();
    const renders = () => fake.calls.filter((call) => call.method === "render");
    editor.requestPages([0], 2);
    editor.requestPages([0], 2);
    await flush();
    expect(renders()).toHaveLength(1);
    expect(editor.isCurrent(0, 2)).toBe(true);
    editor.typeText("가");
    await flush();
    expect(editor.isCurrent(0, 2)).toBe(false);
    expect(editor.pageRevision(0)).toBe(0); // 새 그림 전까지 옛 그림을 보인다
    editor.requestPages([0], 2);
    await flush();
    expect(editor.pageRevision(0)).toBe(1);
    expect(renders()).toHaveLength(2);
    expect(renders()[1]!.args[5]).toBe(0); // 판 0 그림을 기준으로 바뀐 띠만 요청
  });

  it("바뀐 띠는 화면 밖 래스터에 덮고, 화면 canvas에는 보이던 판 뒤의 띠만 옮긴다. 새 canvas는 전체를 옮긴다", async () => {
    const fake = new FakeDocx();
    const sessions = docxSessions(fake);
    await sessions.open("/a.docx");
    const backing = recordingCanvas();
    const editor = new DocxEditorSession(1, fake, sessions, decodeFake, () => backing.canvas);
    await editor.load();
    editor.requestPages([0], 1);
    await flush();
    const screen = recordingCanvas();
    editor.paint(0, screen.canvas);
    expect([screen.canvas.width, screen.canvas.height]).toEqual([816, 1056]);
    expect(screen.draws).toEqual([[backing.canvas, 0, 0]]);
    editor.typeText("가");
    await flush();
    editor.requestPages([0], 1);
    await flush();
    expect(backing.draws.at(-1)!.slice(1)).toEqual([0, 100]); // 띠를 래스터의 y=100에 덮음
    editor.paint(0, screen.canvas);
    expect(screen.draws.at(-1)).toEqual([backing.canvas, 0, 100, 816, 20, 0, 100, 816, 20]);
    editor.paint(0, screen.canvas); // 이미 지금 판
    expect(screen.draws).toHaveLength(2);
    const other = recordingCanvas();
    editor.paint(0, other.canvas);
    expect(other.draws).toEqual([[backing.canvas, 0, 0]]);
    expect(editor.isCurrent(0, 1)).toBe(true);
  });

  it("그림 예산을 넘는 배율은 그리지 않고 편집을 멈추며, 낮추면 이어 간다", async () => {
    const { editor } = await readyDocx();
    expect(editor.setScale(20)).toBe(false);
    expect(editor.renderLimit).toBe(20);
    expect(editor.editable).toBe(false);
    expect(editor.setScale(2)).toBe(true);
    expect(editor.editable).toBe(true);
  });

  it("메모리 왕복 검사 결과는 검사한 판에만 보이고, 보내는 중에는 하지 않는다", async () => {
    const { editor, fake } = await readyDocx();
    expect((await editor.roundTrip()).ok).toBe(true);
    expect(editor.roundTripCurrent).toBe(true);
    editor.typeText("가");
    expect((await editor.roundTrip()).ok).toBe(false); // busy
    await flush();
    expect(editor.roundTripCurrent).toBe(false);
    expect(fake.calls.filter((call) => call.method === "roundTrip")).toHaveLength(1);
  });

  it("WebView를 다시 시작한 뒤 백엔드에 남은 ready 모델에 다시 붙는다", async () => {
    const { fake, sessions } = await readyDocx();
    fake.paragraphs[0] = "남은 편집";
    const fresh = new DocxEditorSession(1, fake, sessions, decodeFake);
    await fresh.resume();
    expect(fresh.status.kind).toBe("ready");
    expect(fresh.view?.paragraphText).toBe("남은 편집");
    expect(fake.calls.filter((call) => call.method === "load")).toHaveLength(1);
  });

  it("reconcile은 WordCraft 세션을 failed로 돌리지 않는다", async () => {
    const fake = new FakeDocx();
    fake.info = { ...fake.info, state: "ready", loadGeneration: 1, sequence: 3 };
    const sessions = docxSessions(fake);
    const result = await sessions.reconcile();
    expect(result.ok && result.value[0]?.state).toBe("ready");
  });
});
