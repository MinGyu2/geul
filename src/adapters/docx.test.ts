// WordCraft(DOCX) IPC 응답 검사(T008). Rust 직렬화 모양(src-tauri/src/adapters/wordcraft/)과 맞아야 한다.
import { describe, expect, it } from "vitest";
import { parseBackendError } from "./contract";
import { createDocxBackend, parseDocxEdited, parseDocxRender, parseDocxRoundTrip, parseDocxState, parseDocxView, RENDER_HEADER_LEN } from "./docx";

const view = {
  pages: [{ width: 612, height: 792 }],
  caret: { page: 0, x: 72, y: 72, height: 18.3 },
  selection: [],
  collapsed: true, inTable: false,
  caretKey: "body:0:0", anchorKey: "body:0:0", paragraphText: "가나", caretOffset: 0,
};
const session = { sessionId: 3, format: "docx", engine: "wordcraft", revision: 2, state: "ready", displayName: "a.docx", dirty: true, sequence: 5, loadGeneration: 1 };

describe("DOCX 응답 검사", () => {
  it("보기는 계약의 모양만 받는다", () => {
    expect(parseDocxView(view)).toEqual(view);
    expect(parseDocxView({ ...view, caret: null })?.caret).toBeNull();
    expect(parseDocxView({ ...view, extra: 1 })).toBeNull();
    expect(parseDocxView({ ...view, pages: [] })).toBeNull();
    expect(parseDocxView({ ...view, pages: [{ width: 0, height: 1 }] })).toBeNull();
    expect(parseDocxView({ ...view, caret: { page: 1, x: 0, y: 0, height: 1 } })).toBeNull(); // 없는 쪽
    expect(parseDocxView({ ...view, selection: [{ page: 0, x: 0, y: 0, width: -1, height: 1 }] })).toBeNull();
    expect(parseDocxView({ ...view, caretOffset: -1 })).toBeNull();
  });

  it("세션 정보는 요청한 WordCraft 세션의 것이어야 한다", () => {
    expect(parseDocxState({ session, view }, 3)?.session.revision).toBe(2);
    expect(parseDocxState({ session, view }, 4)).toBeNull();
    expect(parseDocxState({ session: { ...session, format: "hwp", engine: "rhwp" }, view }, 3)).toBeNull();
  });

  it("편집 응답: 실행 수 + 거부 수 = 보낸 연산 수, 거부 위치는 범위 안", () => {
    expect(parseDocxEdited({ session, view, applied: 2, rejected: [1] }, 3, 3)?.rejected).toEqual([1]);
    expect(parseDocxEdited({ session, view, applied: 3, rejected: [] }, 3, 3)?.applied).toBe(3);
    expect(parseDocxEdited({ session, view, applied: 3, rejected: [1] }, 3, 3)).toBeNull();
    expect(parseDocxEdited({ session, view, applied: 2, rejected: [3] }, 3, 3)).toBeNull();
    expect(parseDocxEdited({ session, view, applied: 1, rejected: [1, 1] }, 3, 3)).toBeNull();
  });

  it("왕복 결과: 검사한 판·세션이어야 하고 passed는 세 비교의 그리고다", () => {
    const result = { sessionId: 3, revision: 2, bytes: 10, pages: 1, reopenedPages: 1, pagesEqual: true, textEqual: true, modelEqual: false, passed: false };
    expect(parseDocxRoundTrip(result, 3, 2)?.passed).toBe(false);
    expect(parseDocxRoundTrip({ ...result, passed: true }, 3, 2)).toBeNull();
    expect(parseDocxRoundTrip(result, 3, 1)).toBeNull();
  });

  it("그림 응답: 머리 24바이트(revision, 기준 판, 첫 줄, 줄 수) + PNG", () => {
    const frame = (revision: number, base: number | "full", y: number, height: number, png: number[]) => {
      const raw = new Uint8Array(RENDER_HEADER_LEN + png.length);
      const view = new DataView(raw.buffer);
      view.setUint32(0, revision, true);
      if (base === "full") { view.setUint32(8, 0xffffffff, true); view.setUint32(12, 0xffffffff, true); } else view.setUint32(8, base, true);
      view.setUint32(16, y, true);
      view.setUint32(20, height, true);
      raw.set(png, RENDER_HEADER_LEN);
      return raw.buffer;
    };
    expect(parseDocxRender(frame(5, "full", 0, 10, [0x89, 0x50]))).toEqual({ revision: 5, base: null, y: 0, height: 10, png: new Uint8Array([0x89, 0x50]) });
    expect(parseDocxRender(frame(5, 3, 40, 12, [0x89]))).toMatchObject({ base: 3, y: 40, height: 12 });
    expect(parseDocxRender(frame(5, 5, 0, 0, []))).toMatchObject({ base: 5, height: 0 }); // 바뀐 줄 없음
    expect(parseDocxRender(frame(5, "full", 0, 10, []))).toBeNull(); // 쪽 전체인데 PNG 없음
    expect(parseDocxRender(frame(5, 3, 40, 0, [1]))).toBeNull(); // 줄 수 0인데 PNG
    expect(parseDocxRender(frame(5, 6, 0, 1, [1]))).toBeNull(); // 기준이 더 새 판
    expect(parseDocxRender(new Uint8Array(8))).toBeNull();
  });

  it("백엔드 EngineFailure 오류를 계약대로 읽는다", () => {
    expect(parseBackendError({ code: "EngineFailure", engine: "wordcraft", stage: "parse" })).toEqual({ code: "EngineFailure", engine: "wordcraft", stage: "parse" });
    expect(parseBackendError({ code: "EngineFailure", engine: "wordcraft", stage: "init" })).toBeNull();
    expect(parseBackendError({ code: "EngineFailure", engine: "wordcraft", stage: "edit", message: "x" })).toBeNull();
  });

  it("명령 이름·인자", async () => {
    const calls: [string, unknown][] = [];
    const invoke = (command: string, args?: Record<string, unknown> | Uint8Array) => {
      calls.push([command, args]);
      if (command === "docx_render") return Promise.resolve(new Uint8Array([7, 0, 0, 0, 0, 0, 0, 0, ...Array(8).fill(0xff), 0, 0, 0, 0, 1, 0, 0, 0, 1]).buffer);
      return Promise.resolve({ session, view, applied: 1, rejected: [] });
    };
    const backend = createDocxBackend(invoke);
    await backend.load(3);
    await backend.load(3, 1);
    await backend.edit(3, 1, 2, [{ op: "insertText", text: "가" }]);
    expect((await backend.render(3, 1, 9, 0, 1.5)).ok).toBe(false); // 다른 판의 그림은 계약 위반
    expect(calls).toEqual([
      ["docx_load", { sessionId: 3, reloadGeneration: null }],
      ["docx_load", { sessionId: 3, reloadGeneration: 1 }],
      ["docx_edit", { sessionId: 3, loadGeneration: 1, baseRevision: 2, ops: [{ op: "insertText", text: "가" }] }],
      ["docx_render", { sessionId: 3, loadGeneration: 1, revision: 9, page: 0, scale: 1.5, base: null }],
    ]);
  });
});
