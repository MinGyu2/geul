// T008 2차 안정화 회귀 시험: 화면 canvas 그리기 실패(A), 표면을 놓은 뒤 늦게 온 그림 응답(B), 비동기 그림 경로의 예외(D).
// 가짜 canvas·디코드로 실패 지점과 완료 순서를 정한다. 합성 시험이므로 실제 WebKit canvas·GPU의 증거가 아니다
// (실제 앱: tests/integration/wordcraft/wordcraft_poc.py).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocxRender } from "../../../adapters/docx";
import type { Result } from "../../../adapters/contract";
import { DocxEditorSession, MAX_RENDER_ATTEMPTS, MAX_RETAINED_PIXELS, RENDER_RETRY_MS, type DecodeImage } from "./DocxEditorSession";
import { decodeFake, docxSessions, FakeDocx, flush, recordingCanvas } from "./testing";

const renders = (fake: FakeDocx) => fake.calls.filter((call) => call.method === "render");

/** 시각을 정하는 performance.now(다시 시도 간격). */
function clock() {
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return { advance: (ms = RENDER_RETRY_MS * MAX_RENDER_ATTEMPTS) => (now += ms) };
}

/** 닫힘을 기록하는 디코드. hold면 끝내기를 release(i)·fail(i)까지 미룬다. */
function trackedDecode() {
  const bitmaps: { closed: boolean; png: number[] }[] = [];
  const pending: { resolve: () => void; reject: () => void }[] = [];
  let hold = false;
  const decode: DecodeImage = (png) => {
    const settle = () => decodeFake(png).then((bitmap) => {
      const tracked = { width: bitmap.width, height: bitmap.height, closed: false, png: [...png], close() { tracked.closed = true; } };
      bitmaps.push(tracked);
      return tracked as unknown as ImageBitmap;
    });
    if (!hold) return settle();
    return new Promise((resolve, reject) => pending.push({ resolve: () => resolve(settle()), reject: () => reject(new Error("decode")) }));
  };
  return { decode, bitmaps, pending, hold: (value: boolean) => (hold = value) };
}

/** 응답을 하나씩 풀어 주는 그림 요청(백엔드는 풀 때 그 시점의 모델로 답한다). */
function heldRenders(fake: FakeDocx) {
  const original = fake.render.bind(fake);
  const held: { args: Parameters<FakeDocx["render"]>; go: () => void; reject: (error: unknown) => void }[] = [];
  const spy = vi.spyOn(fake, "render").mockImplementation((...args) => new Promise<Result<DocxRender>>((resolve, reject) => {
    held.push({ args, go: () => resolve(original(...args)), reject });
  }));
  return { held, issued: () => spy.mock.calls.length };
}

/** 화면 canvas: 문맥 있음·없음(null)·문맥 예외·그리기 예외를 바꿀 수 있다. */
function screenCanvas() {
  const draws: unknown[][] = [];
  let mode: "ok" | "null" | "throw" | "drawThrows" = "ok";
  let contexts = 0;
  const context = {
    drawImage: (...args: unknown[]) => {
      if (mode === "drawThrows") throw new Error("draw");
      draws.push(args);
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => {
      contexts += 1;
      if (mode === "null") return null;
      if (mode === "throw") throw new Error("context");
      return context;
    },
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, draws, set: (value: typeof mode) => (mode = value), contexts: () => contexts };
}

async function setup(options: { decode?: DecodeImage; createCanvas?: () => HTMLCanvasElement; text?: string[] } = {}) {
  const fake = new FakeDocx(options.text);
  const sessions = docxSessions(fake);
  await sessions.open("/a.docx");
  const backings: ReturnType<typeof recordingCanvas>[] = [];
  const createCanvas = options.createCanvas ?? (() => {
    const backing = recordingCanvas();
    backings.push(backing);
    return backing.canvas;
  });
  const editor = new DocxEditorSession(1, fake, sessions, options.decode ?? decodeFake, createCanvas);
  const loaded = await editor.load();
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
  return { fake, sessions, editor, backings };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);
beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
});

describe("A 화면 canvas 그리기 실패", () => {
  it.each([
    ["문맥 없음(null)", "null"],
    ["getContext 예외", "throw"],
    ["drawImage 예외", "drawThrows"],
  ] as const)("%s: 그린 것으로 기록하지 않고 첫 그림 시간도 남기지 않으며, 쓸 수 있게 되면 다시 받지 않고 쪽 전체를 그린다", async (_, mode) => {
    const time = clock();
    const { editor, fake, backings } = await setup();
    editor.requestPages([0], 1);
    await flush();
    const screen = screenCanvas();
    screen.set(mode);
    expect(() => editor.paint(0, screen.canvas)).not.toThrow();
    expect(screen.draws).toHaveLength(0);
    expect(editor.firstPaintMs).toBeNull();
    expect(editor.isCurrent(0, 1)).toBe(true); // 화면 밖 래스터는 지금 판(백엔드 그림과 화면 그리기는 다른 실패)
    expect(editor.isShown(0, 1)).toBe(false);
    expect(editor.status.kind).toBe("ready");
    expect(editor.editable).toBe(true); // 한 번의 실패로 편집을 멈추지 않음
    screen.set("ok");
    editor.paint(0, screen.canvas); // 간격 전: 다시 그려 보지 않음
    expect(screen.draws).toHaveLength(0);
    time.advance();
    editor.paint(0, screen.canvas);
    expect(screen.draws).toEqual([[backings[0]!.canvas, 0, 0]]);
    expect(editor.firstPaintMs).not.toBeNull();
    expect(editor.isShown(0, 1)).toBe(true);
    expect(renders(fake)).toHaveLength(1); // PNG를 다시 받지 않음
  });

  it("앞 판을 보이던 canvas가 새 판의 띠를 옮기다 실패하면 그 판을 보인다고 기록하지 않고, 다음에는 쪽 전체를 옮긴다", async () => {
    const time = clock();
    const { editor, backings } = await setup();
    editor.requestPages([0], 1);
    await flush();
    const screen = screenCanvas();
    editor.paint(0, screen.canvas);
    const first = editor.firstPaintMs;
    expect(first).not.toBeNull();
    editor.typeText("가");
    await flush();
    editor.requestPages([0], 1);
    await flush();
    expect(editor.pageRevision(0)).toBe(1);
    screen.set("drawThrows");
    expect(() => editor.paint(0, screen.canvas)).not.toThrow();
    expect(editor.isShown(0, 1)).toBe(false);
    screen.set("ok");
    time.advance();
    editor.paint(0, screen.canvas);
    // 띠만 옮기면 실패한 동안 지워졌을 수 있는 나머지가 남지 않는다: 쪽 전체.
    expect(screen.draws.at(-1)).toEqual([backings[0]!.canvas, 0, 0]);
    expect(editor.isShown(0, 1)).toBe(true);
    expect(editor.firstPaintMs).toBe(first); // 첫 그림 시간은 처음 한 번
  });

  it("계속 실패하면 몇 번만 다시 그려 보고 그 쪽을 그리지 못했다고 보이며 편집을 멈춘다. 편집·세션은 그대로이고 다시 그리기로 이어 간다", async () => {
    const time = clock();
    const { editor, fake, sessions } = await setup();
    editor.typeText("가");
    await flush();
    editor.requestPages([0], 1);
    await flush();
    const screen = screenCanvas();
    screen.set("null");
    for (let i = 0; i < MAX_RENDER_ATTEMPTS + 2; i++) {
      editor.paint(0, screen.canvas);
      time.advance();
    }
    expect(screen.contexts()).toBe(MAX_RENDER_ATTEMPTS); // 다시 그려 보기에 한도
    expect(editor.renderFailedPages).toEqual([0]);
    expect(editor.editable).toBe(false);
    expect(editor.status.kind).toBe("ready");
    expect(editor.hasUnpreservedChanges).toBe(true);
    expect(sessions.get(1)).toMatchObject({ revision: 1, dirty: true });
    expect(fake.paragraphs[0]).toBe("가가나다");
    expect(editor.typeText("x")).toBe(false); // 멈춘 동안 넣지 않음
    // 문맥이 돌아와도 사용자가 다시 그리기를 고르기 전에는 그대로(한도를 다 씀).
    screen.set("ok");
    editor.paint(0, screen.canvas);
    expect(screen.draws).toHaveLength(0);
    editor.retryRendering();
    editor.paint(0, screen.canvas);
    expect(screen.draws).toHaveLength(1);
    expect(editor.renderFailedPages).toEqual([]);
    expect(editor.editable).toBe(true);
    expect(renders(fake)).toHaveLength(1);
    expect(editor.typeText("x")).toBe(true);
  });

  it("멈춘 동안 판이 바뀌어도(멈추며 확정한 조합) 새 판을 화면에 그려야 풀린다", async () => {
    const time = clock();
    const { editor, fake } = await setup();
    editor.requestPages([0], 1);
    await flush();
    const screen = screenCanvas();
    editor.beginComposition();
    editor.updateComposition("하");
    screen.set("null");
    for (let i = 0; i < MAX_RENDER_ATTEMPTS; i++) {
      editor.paint(0, screen.canvas);
      time.advance();
    }
    // 멈추며 보이던 조합을 한 번 확정했다(편집 멈춤과 같은 규칙).
    expect(editor.composing).toBe(false);
    await flush();
    expect(fake.paragraphs[0]).toBe("하가나다");
    editor.requestPages([0], 1);
    await flush();
    expect(editor.pageRevision(0)).toBe(1);
    editor.paint(0, screen.canvas); // 새 판: 한 번 더 그려 보지만 실패
    expect(editor.renderFailedPages).toEqual([0]);
    expect(editor.editable).toBe(false);
    screen.set("ok");
    time.advance();
    editor.paint(0, screen.canvas);
    expect(editor.renderFailedPages).toEqual([]);
    expect(editor.isShown(0, 1)).toBe(true);
  });

  it("보이지 않는 쪽의 화면 그리기 실패는 편집을 멈추지 않고 알리지도 않는다", async () => {
    clock();
    const { editor, fake } = await setup();
    fake.pageCount = 2;
    editor.typeText("가");
    await flush();
    editor.requestPages([0, 1], 1);
    await flush();
    editor.requestPages([0], 1); // 1쪽은 보이지 않게 됨(래스터는 예산 안이라 남음)
    const screen = screenCanvas();
    screen.set("null");
    const updates = vi.fn();
    editor.subscribe(updates);
    for (let i = 0; i < MAX_RENDER_ATTEMPTS + 1; i++) editor.paint(1, screen.canvas);
    expect(editor.renderFailedPages).toEqual([]);
    expect(editor.editable).toBe(true);
    expect(updates).not.toHaveBeenCalled();
  });
});

describe("B 표면을 놓은 뒤 늦게 온 그림", () => {
  it("백엔드 응답 전에 놓으면 늦은 응답은 래스터를 다시 만들지 않는다", async () => {
    const { editor, fake, backings } = await setup();
    const { held } = heldRenders(fake);
    editor.requestPages([0], 1);
    editor.releaseRendering();
    held[0]!.go();
    await flush();
    expect(editor.pageRevision(0)).toBeNull();
    expect(backings).toHaveLength(0);
    expect(editor.renderFailedPages).toEqual([]);
  });

  it("PNG 디코드 중에 놓으면 디코드가 끝나도 래스터를 만들지 않고 그림은 닫는다", async () => {
    const decoder = trackedDecode();
    const { editor, backings } = await setup({ decode: decoder.decode });
    decoder.hold(true);
    editor.requestPages([0], 1);
    await flush();
    expect(decoder.pending).toHaveLength(1);
    editor.releaseRendering();
    decoder.pending[0]!.resolve();
    await flush();
    expect(editor.pageRevision(0)).toBeNull();
    expect(backings).toHaveLength(0);
    expect(decoder.bitmaps.map((bitmap) => bitmap.closed)).toEqual([true]);
  });

  it("놓기 전 요청이 같은 키의 새 요청보다 늦게 끝나도 새 요청의 기록을 지우지 않고(중복 요청 없음), 실패 상태도 바꾸지 않는다", async () => {
    const time = clock();
    const decoder = trackedDecode();
    const { editor, fake } = await setup({ decode: decoder.decode });
    const requests = heldRenders(fake);
    editor.requestPages([0], 1); // 옛 표면
    editor.releaseRendering();
    editor.requestPages([0], 1); // 곧바로 다시 들어온 표면: 같은 쪽·판·배율
    expect(requests.issued()).toBe(2);
    // 옛 요청이 먼저 끝나고 그 PNG는 디코드에 실패한다.
    fake.renderPng = new Uint8Array([0xff, 0, 0, 0]);
    requests.held[0]!.go();
    await flush();
    fake.renderPng = null;
    expect(editor.renderFailedPages).toEqual([]);
    time.advance();
    editor.requestPages([0], 1); // 새 요청이 아직 보내는 중: 다시 보내지 않음
    expect(requests.issued()).toBe(2);
    requests.held[1]!.go();
    await flush();
    expect(editor.pageRevision(0)).toBe(0);
    expect(editor.isCurrent(0, 1)).toBe(true);
    editor.requestPages([0], 1);
    expect(requests.issued()).toBe(2);
  });

  it("놓은 뒤 늦게 온 거부 응답은 다시 들어온 표면의 요청을 미루지 않는다(실패 기록 없음)", async () => {
    const { editor, fake } = await setup();
    const requests = heldRenders(fake);
    fake.renderError = { code: "InvalidRequest" };
    editor.requestPages([0], 1);
    editor.releaseRendering();
    requests.held[0]!.go();
    await flush();
    fake.renderError = null;
    editor.requestPages([0], 1);
    expect(requests.issued()).toBe(2);
    requests.held[1]!.go();
    await flush();
    expect(editor.isCurrent(0, 1)).toBe(true);
    expect(editor.status.kind).toBe("ready");
  });

  it("놓은 뒤 늦게 온 세션 오류는 편집기를 failed로 돌리지 않는다(다음 요청이 판단)", async () => {
    const { editor, fake } = await setup();
    const requests = heldRenders(fake);
    editor.requestPages([0], 1);
    editor.releaseRendering();
    fake.renderError = { code: "InvalidState", sessionId: 1, state: "failed" };
    requests.held[0]!.go();
    await flush();
    expect(editor.status.kind).toBe("ready");
    expect(unhandled).toEqual([]);
  });

  it("탭을 빠르게 여러 번 오가도 놓은 수명의 응답은 모두 버리고 그림은 모두 닫으며, 마지막 표면만 그린다", async () => {
    const decoder = trackedDecode();
    const { editor, fake, backings } = await setup({ decode: decoder.decode });
    const requests = heldRenders(fake);
    for (let i = 0; i < 5; i++) {
      editor.requestPages([0], 1);
      editor.releaseRendering();
    }
    editor.requestPages([0], 1);
    expect(requests.issued()).toBe(6);
    for (const request of requests.held.slice(0, 5)) request.go();
    await flush();
    expect(backings).toHaveLength(0);
    expect(decoder.bitmaps).toHaveLength(0); // 놓은 수명의 응답은 디코드하지 않는다
    requests.held[5]!.go();
    await flush();
    expect(backings).toHaveLength(1);
    expect(editor.isCurrent(0, 1)).toBe(true);
    expect(decoder.bitmaps.map((bitmap) => bitmap.closed)).toEqual([true]);
  });

  it("놓기는 편집 상태를 바꾸지 않는다: 보내는 중인 편집·조합·revision은 그대로이고 다시 들어오면 지금 판을 그린다", async () => {
    const { editor, fake, sessions } = await setup();
    const requests = heldRenders(fake);
    editor.requestPages([0], 1);
    fake.hold = true;
    editor.typeText("가");
    editor.beginComposition();
    editor.updateComposition("나");
    editor.releaseRendering();
    expect(editor.busy).toBe(true);
    expect(editor.composing).toBe(true);
    expect(editor.compositionText).toBe("나");
    fake.hold = false;
    fake.release();
    requests.held[0]!.go();
    await flush();
    expect(editor.revision).toBe(1);
    expect(sessions.get(1)).toMatchObject({ revision: 1, dirty: true });
    expect(editor.pageRevision(0)).toBeNull();
    expect(editor.composing).toBe(true);
    editor.endComposition("나");
    await flush();
    expect(fake.paragraphs[0]).toBe("가나가나다");
    editor.requestPages([0], 1);
    requests.held.at(-1)!.go();
    await flush();
    expect(editor.isCurrent(0, 1)).toBe(true);
    expect(editor.pageRevision(0)).toBe(2);
  });

  it("다시 불러오기·버리기 중에 남은 그림 응답도 새 모델에 반영하지 않는다", async () => {
    const { editor, fake, backings } = await setup();
    const requests = heldRenders(fake);
    editor.requestPages([0], 1);
    await editor.load({ discard: true });
    requests.held[0]!.go();
    await flush();
    expect(editor.pageRevision(0)).toBeNull();
    editor.requestPages([0], 1);
    editor.dispose();
    requests.held[1]!.go();
    await flush();
    expect(editor.pageRevision(0)).toBeNull();
    expect(backings).toHaveLength(0);
  });
});

describe("D 비동기 그림 경로의 예외", () => {
  it.each([
    ["canvas 만들기", "create"],
    ["크기 정하기", "size"],
    ["화면 밖 getContext", "context"],
    ["화면 밖 drawImage", "draw"],
  ] as const)("%s 예외는 처리되지 않은 거부가 아니라 그 쪽의 그림 실패로 세고, 다시 받아 그린다", async (_, where) => {
    const time = clock();
    const decoder = trackedDecode();
    let broken = true;
    const created: HTMLCanvasElement[] = [];
    const createCanvas = () => {
      if (broken && where === "create") throw new Error("create");
      const backing = { width: 0, height: 0, getContext: () => ({ drawImage: () => {} }) } as unknown as HTMLCanvasElement;
      if (where === "size") {
        let width = 0;
        Object.defineProperty(backing, "width", { get: () => width, set: (value: number) => {
          if (broken && value > 0) throw new Error("size");
          width = value;
        } });
      }
      if (where === "context") backing.getContext = (() => {
        if (broken) throw new Error("context");
        return { drawImage: () => {} };
      }) as unknown as HTMLCanvasElement["getContext"];
      if (where === "draw") backing.getContext = (() => ({ drawImage: () => {
        if (broken) throw new Error("draw");
      } })) as unknown as HTMLCanvasElement["getContext"];
      created.push(backing);
      return backing;
    };
    const { editor, fake } = await setup({ decode: decoder.decode, createCanvas });
    editor.requestPages([0], 1);
    await flush();
    expect(unhandled).toEqual([]);
    expect(editor.pageRevision(0)).toBeNull(); // 지금 판으로 표시하지 않음
    expect(editor.status.kind).toBe("ready");
    expect(decoder.bitmaps.every((bitmap) => bitmap.closed)).toBe(true);
    expect(created.every((canvas) => canvas.width === 0)).toBe(true); // 반쯤 만든 래스터를 남기지 않음
    broken = false;
    time.advance();
    editor.requestPages([0], 1);
    await flush();
    expect(renders(fake)).toHaveLength(2);
    expect(editor.isCurrent(0, 1)).toBe(true);
    const screen = screenCanvas();
    editor.paint(0, screen.canvas);
    expect(editor.firstPaintMs).not.toBeNull(); // 회복한 첫 그림을 기록
  });

  it("띠를 덮다 예외가 나면 그 래스터를 버리고 다음에는 쪽 전체를 받는다", async () => {
    const time = clock();
    let broken = false;
    const backing = { width: 0, height: 0, getContext: () => ({ drawImage: (_: unknown, __: number, y: number) => {
      if (broken && y > 0) throw new Error("draw");
    } }) } as unknown as HTMLCanvasElement;
    const { editor, fake } = await setup({ createCanvas: () => backing });
    editor.requestPages([0], 1);
    await flush();
    editor.typeText("가");
    await flush();
    broken = true;
    editor.requestPages([0], 1);
    await flush();
    expect(unhandled).toEqual([]);
    expect(renders(fake).at(-1)!.args[5]).toBe(0); // 띠 요청이었다
    expect(editor.pageRevision(0)).toBeNull();
    broken = false;
    time.advance();
    editor.requestPages([0], 1);
    await flush();
    expect(renders(fake).at(-1)!.args[5]).toBeUndefined(); // 쪽 전체
    expect(editor.isCurrent(0, 1)).toBe(true);
  });

  it("계속 예외가 나면 MAX_RENDER_ATTEMPTS번만 받고 멈춘다. 처리되지 않은 거부·끝없는 재시도 없음", async () => {
    const time = clock();
    const decoder = trackedDecode();
    const { editor, fake } = await setup({ decode: decoder.decode, createCanvas: () => { throw new Error("create"); } });
    for (let i = 0; i < MAX_RENDER_ATTEMPTS + 2; i++) {
      editor.requestPages([0], 1);
      await flush();
      time.advance();
    }
    expect(renders(fake)).toHaveLength(MAX_RENDER_ATTEMPTS);
    expect(editor.renderFailedPages).toEqual([0]);
    expect(editor.editable).toBe(false);
    expect(decoder.bitmaps).toHaveLength(MAX_RENDER_ATTEMPTS);
    expect(decoder.bitmaps.every((bitmap) => bitmap.closed)).toBe(true);
    expect(unhandled).toEqual([]);
  });

  it("디코드가 동기 예외를 던져도 디코드 실패로 센다", async () => {
    const { editor } = await setup({ decode: () => { throw new Error("sync"); } });
    editor.requestPages([0], 1);
    await flush();
    expect(unhandled).toEqual([]);
    expect(editor.pageRevision(0)).toBeNull();
    expect(editor.status.kind).toBe("ready");
  });

  it("백엔드 호출이 거부(reject)해도 처리되지 않은 거부가 되지 않고, 실패로 세어 다시 받는다", async () => {
    const time = clock();
    const { editor, fake } = await setup();
    const requests = heldRenders(fake);
    editor.requestPages([0], 1);
    requests.held[0]!.reject(new Error("IPC"));
    await flush();
    expect(unhandled).toEqual([]);
    expect(editor.status.kind).toBe("ready");
    expect(editor.pageRevision(0)).toBeNull();
    // 실패로 세어 간격 뒤 다시 받는다(기록이 남아 막히지 않음).
    time.advance();
    editor.requestPages([0], 1);
    expect(requests.issued()).toBe(2);
    requests.held[1]!.go();
    await flush();
    expect(editor.isCurrent(0, 1)).toBe(true);
  });
});

// ---- T008 3차 안정화 ----

describe("A(3차) 화면에 보임은 활성 화면 canvas에 실제로 옮긴 판이다", () => {
  it("래스터가 지금 판이어도 화면 canvas에 옮기기 전에는 보이지 않고, 옮긴 뒤에야 보이며 첫 그림 시간도 그때 남는다", async () => {
    const { editor } = await setup();
    editor.requestPages([0], 1);
    await flush();
    expect(editor.isCurrent(0, 1)).toBe(true);
    expect(editor.isShown(0, 1)).toBe(false);
    expect(editor.firstPaintMs).toBeNull();
    const screen = screenCanvas();
    editor.paint(0, screen.canvas);
    expect(editor.isShown(0, 1)).toBe(true);
    expect(editor.isShown(0, 2)).toBe(false); // 다른 배율
    expect(editor.firstPaintMs).not.toBeNull();
  });

  it("다른 canvas로 바뀌면 앞 canvas의 기록은 새 canvas가 보인다는 근거가 아니다(새 canvas에 옮긴 뒤에야 보임)", async () => {
    const time = clock();
    const { editor } = await setup();
    editor.requestPages([0], 1);
    await flush();
    const first = screenCanvas();
    editor.paint(0, first.canvas);
    const second = screenCanvas();
    second.set("null");
    editor.paint(0, second.canvas);
    expect(editor.isShown(0, 1)).toBe(false);
    second.set("ok");
    time.advance();
    editor.paint(0, second.canvas);
    expect(editor.isShown(0, 1)).toBe(true);
    expect(second.draws).toHaveLength(1);
  });

  it("새 판의 띠를 받아도 화면에 옮기기 전에는 그 판이 보인다고 하지 않는다(띠만 옮기기는 그대로)", async () => {
    const { editor, backings } = await setup();
    editor.requestPages([0], 1);
    await flush();
    const screen = screenCanvas();
    editor.paint(0, screen.canvas);
    editor.typeText("가");
    await flush();
    editor.requestPages([0], 1);
    await flush();
    expect(editor.isCurrent(0, 1)).toBe(true);
    expect(editor.isShown(0, 1)).toBe(false);
    editor.paint(0, screen.canvas);
    expect(editor.isShown(0, 1)).toBe(true);
    expect(screen.draws.at(-1)).toEqual([backings[0]!.canvas, 0, 100, 816, 20, 0, 100, 816, 20]);
  });

  it("놓은 뒤 다시 받은 래스터는 옛 canvas 기록으로 보이지 않고, 새로 옮긴 뒤 보인다", async () => {
    const { editor } = await setup();
    editor.requestPages([0], 1);
    await flush();
    const old = screenCanvas();
    editor.paint(0, old.canvas);
    editor.releaseRendering();
    expect(editor.isShown(0, 1)).toBe(false);
    editor.requestPages([0], 1);
    await flush();
    expect(editor.isShown(0, 1)).toBe(false);
    const fresh = screenCanvas();
    editor.paint(0, fresh.canvas);
    expect(editor.isShown(0, 1)).toBe(true);
  });

  it("보이지 않는 쪽의 화면 그리기 실패도 그 쪽을 보인다고 하지 않는다(편집은 멈추지 않음)", async () => {
    const { editor, fake } = await setup();
    fake.pageCount = 2;
    editor.typeText("가");
    await flush();
    editor.requestPages([0, 1], 1);
    await flush();
    editor.requestPages([0], 1);
    const screen = screenCanvas();
    screen.set("drawThrows");
    editor.paint(1, screen.canvas);
    expect(editor.isShown(1, 1)).toBe(false);
    expect(editor.editable).toBe(true);
  });
});

describe("C(3차) 그림 경로의 정리·알림 예외", () => {
  /** 크기를 0으로 놓을 때 예외를 내는 화면 밖 canvas. */
  const brokenRelease = () => {
    const draws: unknown[][] = [];
    let width = 0;
    let height = 0;
    const canvas = {
      get width() { return width; },
      set width(value: number) { if (value === 0 && width > 0) throw new Error("release"); width = value; },
      get height() { return height; },
      set height(value: number) { if (value === 0 && height > 0) throw new Error("release"); height = value; },
      getContext: () => ({ drawImage: (...args: unknown[]) => void draws.push(args) }),
    };
    return canvas as unknown as HTMLCanvasElement;
  };

  it("래스터 예산으로 놓다가 canvas가 예외를 내도 예산 밖의 래스터는 기억에서 빼고, 받은 쪽은 반영하고 알린다", async () => {
    const { editor, fake } = await setup({ createCanvas: brokenRelease });
    fake.pageCount = 45;
    editor.typeText("가");
    await flush();
    const updates = vi.fn();
    editor.subscribe(updates);
    for (let page = 0; page < 45; page++) {
      editor.requestPages([page], 1);
      await flush();
    }
    expect(unhandled).toEqual([]);
    expect(editor.isCurrent(44, 1)).toBe(true);
    const held = Array.from({ length: 45 }, (_, page) => editor.pageRevision(page)).filter((revision) => revision !== null);
    expect(held.length * 816 * 1056).toBeLessThanOrEqual(MAX_RETAINED_PIXELS);
    expect(editor.pageRevision(0)).toBeNull();
    expect(updates).toHaveBeenCalledTimes(45);
  });

  it("놓기(releaseRendering)는 canvas 하나가 예외를 내도 나머지·요청·실패 기록을 모두 놓고, 다시 요청하면 그린다", async () => {
    const { editor, fake } = await setup({ createCanvas: brokenRelease });
    fake.pageCount = 2;
    editor.typeText("가");
    await flush();
    editor.requestPages([0, 1], 1);
    await flush();
    expect(() => editor.releaseRendering()).not.toThrow();
    expect([editor.pageRevision(0), editor.pageRevision(1)]).toEqual([null, null]);
    editor.requestPages([0, 1], 1);
    await flush();
    expect(editor.isCurrent(0, 1) && editor.isCurrent(1, 1)).toBe(true);
  });

  it("놓은 쪽의 화면 canvas를 비우다 예외가 나도 paint는 예외를 내지 않는다", async () => {
    const { editor } = await setup();
    const screen = brokenRelease();
    screen.width = 816;
    screen.height = 1056;
    expect(() => editor.paint(0, screen)).not.toThrow();
  });

  it("알림 구독자 하나가 예외를 내도 다른 구독자는 알림을 받고 그림은 반영되며, 예외는 숨기지 않고 보고한다", async () => {
    const reported: unknown[] = [];
    vi.stubGlobal("reportError", (error: unknown) => void reported.push(error));
    try {
      const { editor } = await setup();
      const boom = new Error("listener");
      editor.subscribe(() => { throw boom; });
      const updates = vi.fn();
      editor.subscribe(updates);
      editor.requestPages([0], 1);
      await flush();
      expect(editor.isCurrent(0, 1)).toBe(true);
      expect(updates).toHaveBeenCalled();
      expect(reported).toContain(boom);
      expect(unhandled).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
