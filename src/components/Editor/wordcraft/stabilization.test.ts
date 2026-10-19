// T008 안정화 회귀 시험: 긴·여러 줄 입력(P1-A), 그림 실패의 가시성(P1-B), 선택과 IME 조합(P1-C), 쪽 래스터 예산(P2-A),
// 닫기 보호(P2-C). 가짜 백엔드(testing.ts)는 Rust 어댑터의 요청 검사(validate)·연산 계약을 흉내 낸다. 합성 시험이므로
// 실제 엔진·native IME 통과의 증거가 아니다(Rust 시험과 tests/integration/wordcraft/).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentBackend } from "../../../adapters/backend";
import type { Result } from "../../../adapters/contract";
import { MAX_DOCX_PASTE_CHARS, MAX_DOCX_TEXT_CHARS, type DocxOp } from "../../../adapters/docx";
import { DocumentSessions } from "../../../adapters/sessions";
import { DocumentWorkspace } from "../documentWorkspace";
import { ImeContext, ImeInput } from "../rhwp/imeInput";
import { DocxEditorSession, MAX_RENDER_ATTEMPTS, MAX_RETAINED_PIXELS, RENDER_RETRY_MS } from "./DocxEditorSession";
import { decodeFake, docxInfo, docxSessions, FakeDocx, flush, readyDocx, recordingCanvas } from "./testing";

const edits = (fake: FakeDocx) => fake.calls.filter((call) => call.method === "edit");
const sentOps = (fake: FakeDocx) => edits(fake).flatMap((call) => call.args[3] as DocxOp[]);
const renders = (fake: FakeDocx) => fake.calls.filter((call) => call.method === "render");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("P1-A 긴 글자·여러 줄 붙여넣기", () => {
  it.each([
    ["LF", "첫 줄\n둘째 줄"],
    ["CRLF", "첫 줄\r\n둘째 줄"],
    ["CR", "첫 줄\r둘째 줄"],
    ["U+2029", "첫 줄\u2029둘째 줄"],
  ])("%s 줄바꿈은 문단 나누기로 들어가고 편집이 멈추지 않는다", async (_, text) => {
    const { editor, fake, sessions } = await readyDocx();
    expect(editor.typeText(text)).toBe(true);
    await flush();
    expect(editor.status.kind).toBe("ready");
    expect(fake.paragraphs).toEqual(["첫 줄", "둘째 줄가나다", "abc"]);
    expect(sentOps(fake)).toEqual([{ op: "pasteText", text: "첫 줄\n둘째 줄", chain: false }]);
    expect(sessions.get(1)).toMatchObject({ revision: 1, dirty: true });
    expect(editor.inputNotice).toBeNull();
  });

  it("여러 문단·빈 줄·탭은 순서대로 그대로 들어가고, 탭은 표 이동 연산이 되지 않는다", async () => {
    const { editor, fake } = await readyDocx();
    editor.typeText("하나\t1\n\n셋 three\t3\n");
    await flush();
    expect(fake.paragraphs).toEqual(["하나\t1", "", "셋 three\t3", "가나다", "abc"]);
    expect(sentOps(fake).some((op) => op.op === "tab")).toBe(false);
    expect(editor.status.kind).toBe("ready");
  });

  it("4096자를 넘는 글자(한글·ASCII·이모지)는 글자 경계에서 나눈 조각으로 순서대로 모두 들어간다", async () => {
    const { editor, fake, sessions } = await readyDocx([""]);
    const unit = "한글 ASCII 😀𝄞 ";
    const text = unit.repeat(Math.ceil((MAX_DOCX_TEXT_CHARS * 2.5) / [...unit].length));
    editor.typeText(text);
    await flush();
    const ops = sentOps(fake);
    expect(ops.length).toBe(Math.ceil([...text].length / MAX_DOCX_TEXT_CHARS));
    for (const [index, op] of ops.entries()) {
      expect(op).toMatchObject({ op: "pasteText", chain: index > 0 });
      const value = (op as { text: string }).text;
      expect([...value].length).toBeLessThanOrEqual(MAX_DOCX_TEXT_CHARS);
      expect(/\p{Cs}/u.test(value)).toBe(false); // 서러게이트 쌍을 나누지 않음
    }
    expect(fake.paragraphs[0]).toBe(text);
    expect(sessions.get(1)?.revision).toBe(ops.length);
    expect(editor.status.kind).toBe("ready");
  });

  it("한도 바로 아래·같음은 넣기 하나, 하나 넘으면 두 조각이다", async () => {
    const { editor, fake } = await readyDocx([""]);
    editor.typeText("가".repeat(MAX_DOCX_TEXT_CHARS));
    await flush();
    editor.typeText("나".repeat(MAX_DOCX_TEXT_CHARS + 1));
    await flush();
    expect(sentOps(fake).map((op) => [op.op, [...(op as { text: string }).text].length])).toEqual([
      ["insertText", MAX_DOCX_TEXT_CHARS],
      ["pasteText", MAX_DOCX_TEXT_CHARS],
      ["pasteText", 1],
    ]);
    expect(fake.paragraphs[0]).toBe("가".repeat(MAX_DOCX_TEXT_CHARS) + "나".repeat(MAX_DOCX_TEXT_CHARS + 1));
  });

  it("보내는 중에 이어 붙여넣은 것도 순서대로 들어가고, 연산 수 한도로 요청을 나눈다", async () => {
    const { editor, fake } = await readyDocx([""]);
    fake.hold = true;
    editor.typeText("a\nb");
    for (let i = 0; i < 300; i++) editor.typeText(i % 2 ? "c" : "d\te");
    for (let i = 0; i < 4; i++) {
      fake.release();
      await flush();
    }
    expect(edits(fake).length).toBe(3);
    expect(edits(fake).every((call) => (call.args[3] as unknown[]).length <= 256)).toBe(true);
    expect(fake.paragraphs).toEqual(["a", "b" + "d\tec".repeat(150)]);
    expect(editor.status.kind).toBe("ready");
  });

  it.each([
    ["제어 문자", "줄\u0007"],
    ["NUL", "a\u0000b"],
    ["U+FFFC", "a\uFFFCb"],
    ["고립 서러게이트", "a\uD800b"],
  ])("넣을 수 없는 %s가 있으면 아무것도 넣지 않고 알리며 편집은 이어 간다", async (_, text) => {
    const { editor, fake } = await readyDocx();
    expect(editor.typeText(text)).toBe(false);
    await flush();
    expect(edits(fake)).toHaveLength(0);
    expect(fake.paragraphs).toEqual(["가나다", "abc"]);
    expect(editor.inputNotice).toBe("pasteUnsupported");
    expect(editor.status.kind).toBe("ready");
    expect(editor.typeText("x")).toBe(true);
    expect(editor.inputNotice).toBeNull();
  });

  it("총량 한도를 넘는 붙여넣기는 넣지 않고 알린다", async () => {
    const { editor, fake } = await readyDocx();
    expect(editor.typeText("a".repeat(MAX_DOCX_PASTE_CHARS + 1))).toBe(false);
    expect(edits(fake)).toHaveLength(0);
    expect(editor.inputNotice).toBe("pasteTooLarge");
    expect(editor.status.kind).toBe("ready");
  });

  it("엔진이 조각 하나를 거부하면 그 뒤 조각은 넣지 않고(같은 요청·다음 요청 모두) 일부만 들어갔다고 알린다", async () => {
    const { editor, fake, sessions } = await readyDocx([""]);
    const chunk = (c: string) => c.repeat(MAX_DOCX_TEXT_CHARS);
    fake.refuseText = (text) => text.startsWith("b");
    fake.hold = true;
    editor.typeText("x"); // 보내는 중
    for (let i = 0; i < 10; i++) editor.typeText("y");
    // 250조각: 둘째 요청에 10 + 246개(a, b에서 거부, 나머지 건너뜀), 남은 4개는 다음 요청으로 보내지 않는다.
    editor.typeText(chunk("a") + chunk("b") + chunk("c").repeat(248));
    editor.typeText("뒤"); // 따로 친 입력은 그대로 들어간다
    for (let i = 0; i < 4; i++) {
      fake.release();
      await flush();
    }
    expect(fake.paragraphs[0]).toBe("x" + "y".repeat(10) + chunk("a") + "뒤");
    expect(sessions.get(1)?.revision).toBe(13);
    expect(editor.inputNotice).toBe("pasteIncomplete");
    expect(editor.status.kind).toBe("ready");
    expect(editor.busy).toBe(false);
    expect(sentOps(fake).filter((op) => op.op === "pasteText")).toHaveLength(246);
  });
});

describe("P1-B 그림 실패", () => {
  const canvases = () => {
    const made: { canvas: HTMLCanvasElement; draws: unknown[][] }[] = [];
    return { made, create: () => { const c = recordingCanvas(); made.push(c); return c.canvas; } };
  };

  async function editedDocx() {
    const fake = new FakeDocx();
    const sessions = docxSessions(fake);
    await sessions.open("/a.docx");
    const { create } = canvases();
    const editor = new DocxEditorSession(1, fake, sessions, decodeFake, create);
    await editor.load();
    editor.setScale(1);
    editor.requestPages([0], 1);
    await flush();
    expect(editor.isCurrent(0, 1)).toBe(true);
    editor.typeText("가");
    await flush();
    return { fake, sessions, editor };
  }

  /** 다시 시도 간격을 지나 쪽을 다시 요청한다(표면이 알림·스크롤 때 하는 것). */
  const retry = async (editor: DocxEditorSession, clock: { now: number }) => {
    clock.now += RENDER_RETRY_MS * MAX_RENDER_ATTEMPTS;
    editor.requestPages([0], 1);
    await flush();
  };
  const fakeClock = () => {
    const clock = { now: 1000 };
    vi.spyOn(performance, "now").mockImplementation(() => clock.now);
    return clock;
  };

  it("편집 뒤 지금 판의 그림이 계속 실패하면 몇 번만 다시 시도하고, 실패를 보이며 편집을 멈춘다(ready로 숨기지 않음)", async () => {
    const clock = fakeClock();
    const { fake, editor } = await editedDocx();
    fake.renderError = { code: "InvalidRequest" };
    editor.requestPages([0], 1);
    await flush();
    for (let i = 0; i < MAX_RENDER_ATTEMPTS + 2; i++) await retry(editor, clock);
    expect(renders(fake).filter((call) => call.args[2] === 1)).toHaveLength(MAX_RENDER_ATTEMPTS);
    expect(editor.renderFailedPages).toEqual([0]);
    expect(editor.isCurrent(0, 1)).toBe(false);
    expect(editor.pageRevision(0)).toBe(0); // 옛 그림을 지금 판으로 표시하지 않음
    expect(editor.editable).toBe(false);
    expect(editor.typeText("x")).toBe(false);
    expect(editor.hasUnpreservedChanges).toBe(true); // 확정한 '가'는 그대로 보호
    // 백엔드가 회복하면 다시 그리기로 이어 간다.
    fake.renderError = null;
    editor.retryRendering();
    editor.requestPages([0], 1);
    await flush();
    expect(editor.isCurrent(0, 1)).toBe(true);
    expect(editor.renderFailedPages).toEqual([]);
    expect(editor.editable).toBe(true);
  });

  it("한 번 실패한 뒤 다시 그려지면(일시 실패) 실패로 남지 않는다", async () => {
    const clock = fakeClock();
    const { fake, editor } = await editedDocx();
    fake.renderPng = new Uint8Array([0xff]);
    editor.requestPages([0], 1);
    await flush();
    expect(editor.isCurrent(0, 1)).toBe(false);
    expect(editor.renderFailedPages).toEqual([]);
    expect(editor.editable).toBe(true);
    fake.renderPng = null;
    await retry(editor, clock);
    expect(editor.isCurrent(0, 1)).toBe(true);
  });

  it("PNG 디코드 실패도 실패로 센다", async () => {
    const clock = fakeClock();
    const { fake, editor } = await editedDocx();
    fake.renderPng = new Uint8Array([0xff]);
    editor.requestPages([0], 1);
    await flush();
    for (let i = 0; i < MAX_RENDER_ATTEMPTS; i++) await retry(editor, clock);
    expect(editor.renderFailedPages).toEqual([0]);
    expect(editor.isCurrent(0, 1)).toBe(false);
  });

  it("canvas 2D 문맥을 얻지 못하면 그 그림을 지금 판으로 표시하지 않는다", async () => {
    const fake = new FakeDocx();
    const sessions = docxSessions(fake);
    await sessions.open("/a.docx");
    const broken = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement;
    const editor = new DocxEditorSession(1, fake, sessions, decodeFake, () => broken);
    await editor.load();
    editor.requestPages([0], 1);
    await flush();
    expect(editor.isCurrent(0, 1)).toBe(false);
    expect(editor.pageRevision(0)).toBeNull();
  });

  it("편집이 보내는 중일 때의 옛 판(RevisionMismatch) 응답은 실패가 아니다", async () => {
    const { fake, editor } = await editedDocx();
    fake.hold = true;
    editor.typeText("나"); // 보내는 중(백엔드는 먼저 바뀜을 흉내: 판을 직접 올림)
    fake.info = { ...fake.info, revision: fake.info.revision + 1 };
    editor.requestPages([0], 1);
    await flush();
    expect(editor.renderFailedPages).toEqual([]);
    expect(editor.status.kind).toBe("ready");
  });

  it("세션을 잃은 그림 오류(InvalidState·EngineFailure)는 편집기를 failed로 돌린다", async () => {
    const { fake, editor, sessions } = await editedDocx();
    // 엔진 패닉: 백엔드가 세션을 failed로 돌리고 EngineFailure를 돌려준다.
    fake.renderError = { code: "EngineFailure", engine: "wordcraft", stage: "render" };
    fake.info = { ...fake.info, state: "failed", sequence: fake.info.sequence + 1 };
    fake.renderError = null; // 그 뒤 요청은 check()가 InvalidState
    editor.requestPages([0], 1);
    await flush();
    expect(editor.status.kind).toBe("failed");
    expect(sessions.get(1)?.state).toBe("failed");
    expect(editor.hasUnpreservedChanges).toBe(true);
  });

  it("조합 중에 그림 실패로 편집이 멈추면 보이던 조합을 그 자리에 한 번 확정하고, 늦은 끝은 다시 넣지 않는다", async () => {
    const clock = fakeClock();
    const { fake, editor } = await editedDocx();
    const ime = new ImeInput(editor, new ImeContext());
    ime.input("하", "insertCompositionText", true);
    fake.renderError = { code: "InvalidRequest" };
    editor.requestPages([0], 1);
    await flush();
    for (let i = 0; i < MAX_RENDER_ATTEMPTS; i++) await retry(editor, clock);
    expect(editor.composing).toBe(false);
    ime.input("한", "insertCompositionText", true);
    ime.compositionEnd("한");
    await flush();
    expect(fake.paragraphs[0]).toBe("가하가나다");
  });

  it("이미 failed인 편집기에 늦게 온 그림 오류는 원래 오류를 덮지 않는다", async () => {
    const { fake, editor } = await editedDocx();
    fake.hold = true;
    editor.typeText("나");
    editor.requestPages([0], 1); // 판 1 그림 요청(보내는 중)
    fake.failNext = { code: "EngineFailure", engine: "wordcraft", stage: "edit" };
    fake.release();
    await flush();
    expect(editor.status).toEqual({ kind: "failed", error: { code: "EngineFailure", engine: "wordcraft", stage: "edit" } });
  });

  it("띠 크기가 래스터와 맞지 않으면 덮지 않는다", async () => {
    const fake = new FakeDocx();
    const sessions = docxSessions(fake);
    await sessions.open("/a.docx");
    const backing = recordingCanvas();
    const wide = (png: Uint8Array) => decodeFake(png).then((bitmap) => (png.length === 3 ? ({ ...bitmap, width: 400, close() {} } as unknown as ImageBitmap) : bitmap));
    const editor = new DocxEditorSession(1, fake, sessions, wide, () => backing.canvas);
    await editor.load();
    editor.requestPages([0], 1);
    await flush();
    editor.typeText("가");
    await flush();
    const draws = backing.draws.length;
    editor.requestPages([0], 1);
    await flush();
    expect(backing.draws).toHaveLength(draws);
    expect(editor.isCurrent(0, 1)).toBe(false);
  });
});

describe("P1-C 선택과 IME 조합", () => {
  it("선택을 바꾸는 연산이 보내는 중일 때 시작한 조합은 옛 보기로 글자를 지우지 않는다", async () => {
    const { editor, fake } = await readyDocx();
    editor.move("right", true);
    editor.move("right", true);
    await flush();
    expect(editor.view?.collapsed).toBe(false);
    fake.hold = true;
    editor.move("lineEnd", false); // 선택을 접음(응답 전: 보기는 아직 선택)
    const ime = new ImeInput(editor, new ImeContext());
    ime.input("마", "insertCompositionText", true);
    ime.compositionEnd("마");
    for (let i = 0; i < 3; i++) {
      fake.release();
      await flush();
    }
    expect(fake.paragraphs[0]).toBe("가나다마");
  });

  it("보내는 중인 연산이 선택을 만들면 조합 확정은 그 선택을 바꾼다", async () => {
    const { editor, fake } = await readyDocx();
    fake.hold = true;
    editor.selectAll(); // 응답 전: 보기는 접힌 커서
    const ime = new ImeInput(editor, new ImeContext());
    ime.input("마", "insertCompositionText", true);
    ime.compositionEnd("마");
    for (let i = 0; i < 3; i++) {
      fake.release();
      await flush();
    }
    expect(fake.paragraphs).toEqual(["마"]);
  });

  it("미리보기가 보이기 전에 끝난 빈 조합은 선택을 지우지 않는다(연산·revision 없음)", async () => {
    const { editor, fake, sessions } = await readyDocx();
    editor.move("right", true);
    await flush();
    const before = edits(fake).length;
    const ime = new ImeInput(editor, new ImeContext());
    ime.compositionStart();
    ime.compositionEnd("");
    await flush();
    expect(edits(fake)).toHaveLength(before);
    expect(fake.paragraphs[0]).toBe("가나다");
    expect(editor.view?.collapsed).toBe(false);
    expect(sessions.get(1)).toMatchObject({ revision: 0, dirty: false });
  });

  it("계약: 미리보기가 보인 뒤 취소하면 선택을 지운 것만 변경 하나로 남는다(T007 rhwp와 같은 계약)", async () => {
    const { editor, fake, sessions } = await readyDocx();
    editor.move("right", true);
    editor.move("right", true);
    await flush();
    const ime = new ImeInput(editor, new ImeContext());
    ime.compositionStart();
    ime.input("ㄱ", "insertCompositionText", true);
    ime.input("가", "insertCompositionText", true);
    ime.compositionEnd("");
    await flush();
    expect(fake.paragraphs[0]).toBe("다");
    expect(sessions.get(1)).toMatchObject({ revision: 1, dirty: true });
    expect(sentOps(fake).filter((op) => op.op === "insertText")).toHaveLength(0);
    expect(editor.composing).toBe(false);
  });

  it("문단을 건너는 선택에서 확정하면 한 번만 바꾼다", async () => {
    const { editor, fake, sessions } = await readyDocx();
    editor.move("right", false);
    editor.move("down", true);
    await flush();
    const ime = new ImeInput(editor, new ImeContext());
    ime.input("하", "insertCompositionText", true);
    ime.input("한", "insertCompositionText", true);
    ime.compositionEnd("한");
    await flush();
    expect(fake.paragraphs).toEqual(["가한bc"]);
    expect(sessions.get(1)?.revision).toBe(2); // 선택 지우기 + 넣기(따로 한 연산씩)
    expect(sentOps(fake).filter((op) => op.op === "insertText")).toEqual([{ op: "insertText", text: "한" }]);
  });

  it("선택 없이 조합하면 조합 시작에 요청을 보내지 않는다(조합 하나 = 연산 하나)", async () => {
    const { editor, fake } = await readyDocx();
    const ime = new ImeInput(editor, new ImeContext());
    ime.input("하", "insertCompositionText", true);
    await flush();
    expect(edits(fake)).toHaveLength(0);
    ime.compositionEnd("하");
    await flush();
    expect(sentOps(fake)).toEqual([{ op: "insertText", text: "하" }]);
  });
});

describe("P2-A 쪽 래스터 예산", () => {
  it("여러 쪽을 스크롤하면 보이지 않는 쪽의 래스터는 예산 안에서 놓는다", async () => {
    const fake = new FakeDocx();
    fake.pageCount = 120;
    const sessions = docxSessions(fake);
    await sessions.open("/a.docx");
    const made: HTMLCanvasElement[] = [];
    const editor = new DocxEditorSession(1, fake, sessions, decodeFake, () => {
      const canvas = recordingCanvas().canvas;
      made.push(canvas);
      return canvas;
    });
    await editor.load();
    for (let page = 0; page + 1 < fake.pageCount; page++) {
      editor.requestPages([page, page + 1], 1);
      await flush();
    }
    const live = made.filter((canvas) => canvas.width > 0);
    const pixels = live.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0);
    expect(pixels).toBeLessThanOrEqual(MAX_RETAINED_PIXELS);
    expect(editor.isCurrent(fake.pageCount - 1, 1)).toBe(true);
    expect(editor.isCurrent(fake.pageCount - 2, 1)).toBe(true);
    expect(editor.pageRevision(0)).toBeNull(); // 놓은 쪽
    // 다시 보이면 새로 그린다.
    editor.requestPages([0], 1);
    await flush();
    expect(editor.isCurrent(0, 1)).toBe(true);
  });

  it("표면이 놓으면(releaseRendering) 모든 래스터를 놓고, 다시 요청하면 그린다", async () => {
    const backing = recordingCanvas();
    const fake = new FakeDocx();
    const sessions = docxSessions(fake);
    await sessions.open("/a.docx");
    const editor = new DocxEditorSession(1, fake, sessions, decodeFake, () => backing.canvas);
    await editor.load();
    editor.requestPages([0], 1);
    await flush();
    expect(backing.canvas.width).toBe(816);
    editor.releaseRendering();
    expect(backing.canvas.width).toBe(0);
    expect(editor.pageRevision(0)).toBeNull();
    editor.requestPages([0], 1);
    await flush();
    expect(editor.isCurrent(0, 1)).toBe(true);
  });
});

describe("P2-C 닫기 보호", () => {
  function workspace(info = docxInfo()) {
    const fake = new FakeDocx();
    fake.info = info;
    const ok = <T,>(value: T): Promise<Result<T>> => Promise.resolve({ ok: true, value });
    const closes: number[] = [];
    const backend = {
      open: () => ok({ ...fake.info }),
      session: () => ok({ ...fake.info }),
      sessions: () => ok([{ ...fake.info }]),
      close: (sessionId: number) => {
        closes.push(sessionId);
        return ok({ sessionId, alreadyClosed: false });
      },
    } as unknown as DocumentBackend;
    const sessions = new DocumentSessions(backend);
    const space = new DocumentWorkspace(sessions, backend, undefined, undefined, fake, decodeFake);
    return { fake, sessions, space, closes };
  }

  it("편집 객체가 아직 없어도 백엔드가 dirty인 세션은 버리기 확인 없이 닫지 않는다(WebView 재시작 뒤 비활성 탭)", async () => {
    const { space, sessions, closes } = workspace(docxInfo({ state: "ready", loadGeneration: 1, revision: 3, dirty: true, sequence: 5 }));
    await sessions.reconcile();
    expect(sessions.get(1)?.dirty).toBe(true);
    expect(space.hasUnpreservedChanges).toBe(true);
    expect(await space.close(1)).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    expect(closes).toEqual([]);
    expect((await space.close(1, { discard: true })).ok).toBe(true);
    expect(closes).toEqual([1]);
  });

  it("편집 중(보내는 중)·조합 중 닫기도 확인을 요구하고, 같은 닫기를 되풀이하면 하나를 기다린다", async () => {
    const { space, fake, closes } = workspace();
    await space.open("/a.docx");
    await flush();
    const editor = space.docxEditorFor(1)!;
    fake.hold = true;
    editor.typeText("가");
    expect(await space.close(1)).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    fake.release();
    await flush();
    fake.hold = false;
    const ime = new ImeInput(editor, new ImeContext());
    ime.input("나", "insertCompositionText", true);
    expect(await space.close(1)).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    const first = space.close(1, { discard: true });
    const second = space.close(1, { discard: true });
    expect(second).toBe(first);
    expect((await first).ok).toBe(true);
    expect(closes).toEqual([1]);
  });
});
