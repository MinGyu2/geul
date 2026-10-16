import { describe, expect, it, vi } from "vitest";
import { createTauriBackend, type DocumentBackend, type Invoke } from "./backend";
import { parseBackendError, parseSessionInfo, type DocumentError, type Result, type SessionInfo } from "./contract";
import { adapterFor } from "./engines";
import { DocumentSessions, EMPTY_SESSIONS, reduceSessions } from "./sessions";

// Rust serde 직렬화 형식(src-tauri/src/document/)과 같은 값. 실제 IPC 응답은 tests/e2e/tauri_smoke.py가 확인한다.
const docx: SessionInfo = { sessionId: 1, format: "docx", engine: "wordcraft", revision: 0, state: "identified", displayName: "a.docx" };
const hwpx: SessionInfo = { sessionId: 2, format: "hwpx", engine: "rhwp", revision: 0, state: "identified", displayName: "b.hwpx" };
const hwp: SessionInfo = { sessionId: 3, format: "hwp", engine: "rhwp", revision: 0, state: "identified", displayName: "c.hwp" };

describe("IPC 계약 검사", () => {
  it("세션 정보를 받아들이고, 라우팅 규칙과 어긋나거나 모양이 다른 응답은 거부한다", () => {
    for (const info of [docx, hwpx, hwp]) expect(parseSessionInfo(JSON.parse(JSON.stringify(info)))).toEqual(info);
    const broken: unknown[] = [
      null, [], "x",
      { ...docx, engine: "rhwp" }, // docx를 rhwp로 보냄
      { ...hwp, engine: "wordcraft" },
      { ...docx, format: "doc" },
      { ...docx, sessionId: 0 }, { ...docx, sessionId: 1.5 }, { ...docx, sessionId: "1" },
      { ...docx, revision: -1 }, { ...docx, state: "ready" }, { ...docx, displayName: 3 },
      { ...docx, path: "/somewhere/a.docx" }, // 경로 같은 계약 밖 필드
    ];
    for (const value of broken) expect(parseSessionInfo(value), JSON.stringify(value)).toBeNull();
  });

  it("백엔드 오류를 code별 세부 값까지 검사한다", () => {
    const valid = [
      { code: "InvalidPath", reason: "relative" },
      { code: "Unreadable", reason: "not-a-file" },
      { code: "UnsupportedFormat", kind: "extension" },
      { code: "ExtensionMismatch", declared: "docx", detected: "hwpx" },
      { code: "Encrypted" },
      { code: "Encrypted", format: "hwp" },
      { code: "ParseFailure", reason: "truncated" },
      { code: "ParseFailure", format: "docx", reason: "missing-part" },
      { code: "ResourceLimit", limit: "part-size" },
      { code: "AlreadyOpen", sessionId: 3 },
      { code: "StaleSession", sessionId: 1 },
      { code: "Internal" },
    ];
    for (const error of valid) expect(parseBackendError(error)).toEqual(error);
    const invalid = [
      "denied", { code: "Nope" }, { code: "InvalidPath", reason: "weird" }, { code: "ExtensionMismatch", declared: "docx" },
      { code: "Internal", detail: "synthetic-detail-marker" }, { code: "ParseFailure", reason: "truncated", message: "os error 2" },
      { code: "toString" }, { code: "StaleSession", sessionId: -1 },
    ];
    for (const error of invalid) expect(parseBackendError(error), JSON.stringify(error)).toBeNull();
  });
});

describe("Tauri 백엔드 클라이언트", () => {
  it("명령 이름과 인자(camelCase)를 보내고 응답을 검사한다", async () => {
    const invoke = vi.fn<Invoke>(async (command) => {
      if (command === "document_open") return docx;
      if (command === "document_close") return { sessionId: 1, alreadyClosed: false };
      if (command === "document_session") return docx;
      return [docx, hwpx];
    });
    const backend = createTauriBackend(invoke);
    expect(await backend.open("/docs/a.docx")).toEqual({ ok: true, value: docx });
    expect(await backend.close(1)).toEqual({ ok: true, value: { sessionId: 1, alreadyClosed: false } });
    expect(await backend.session(1)).toEqual({ ok: true, value: docx });
    expect(await backend.sessions()).toEqual({ ok: true, value: [docx, hwpx] });
    expect(invoke.mock.calls).toEqual([
      ["document_open", { path: "/docs/a.docx" }],
      ["document_close", { sessionId: 1 }],
      ["document_session", { sessionId: 1 }],
      ["document_sessions", undefined],
    ]);
  });

  it("계약에 있는 오류는 그대로, 계약 밖의 거부와 응답은 Protocol로 바꾸고 원문을 버린다", async () => {
    const reject = (reason: unknown): Invoke => () => Promise.reject(reason);
    const mismatch = { code: "ExtensionMismatch", declared: "docx", detected: "hwp" };
    expect(await createTauriBackend(reject(mismatch)).open("/a.docx")).toEqual({ ok: false, error: mismatch });
    const raw = "invalid args `sessionId` for command `document_close`: synthetic-secret-marker";
    const result = await createTauriBackend(reject(raw)).close(1);
    expect(result).toEqual({ ok: false, error: { code: "Protocol" } });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret-marker");

    const answer = (value: unknown): Invoke => () => Promise.resolve(value);
    expect(await createTauriBackend(answer({ ...docx, sessionId: 2 })).session(1)).toEqual({ ok: false, error: { code: "Protocol" } });
    expect(await createTauriBackend(answer({ sessionId: 9, alreadyClosed: true })).close(1)).toEqual({ ok: false, error: { code: "Protocol" } });
    expect(await createTauriBackend(answer([docx, docx])).sessions()).toEqual({ ok: false, error: { code: "Protocol" } });
    expect(await createTauriBackend(answer(undefined)).open("/a.docx")).toEqual({ ok: false, error: { code: "Protocol" } });
  });
});

describe("엔진 어댑터 경계", () => {
  it("세션의 엔진으로 어댑터를 고르고, 엔진 연결 전에는 모든 명령을 사용할 수 없다고 보고한다", () => {
    expect(adapterFor(docx).engine).toBe("wordcraft");
    expect(adapterFor(hwpx).engine).toBe("rhwp");
    expect(adapterFor(hwp).formats).toEqual(["hwp", "hwpx"]);
    expect(adapterFor(docx).formats).toEqual(["docx"]);
    for (const session of [docx, hwpx, hwp]) {
      for (const command of ["format.bold", "file.save", "edit.undo"]) {
        expect(adapterFor(session).capability(session, command)).toEqual({ state: "unavailable", reason: "engine-not-integrated" });
      }
    }
  });

  it("불러오기·명령·저장은 가짜 성공 없이 EngineUnavailable이고 세션을 바꾸지 않는다", async () => {
    const session = { ...hwpx };
    const adapter = adapterFor(session);
    expect(await adapter.load(session)).toEqual({ ok: false, error: { code: "EngineUnavailable", engine: "rhwp", operation: "load" } });
    expect(await adapter.execute({ sessionId: 2, revision: 0, commandId: "format.bold" }))
      .toEqual({ ok: false, error: { code: "EngineUnavailable", engine: "rhwp", operation: "execute" } });
    expect(await adapterFor(docx).save(docx)).toEqual({ ok: false, error: { code: "EngineUnavailable", engine: "wordcraft", operation: "save" } });
    expect(session).toEqual(hwpx);
  });
});

// ---- 세션 투영 ----

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** 요청마다 응답 시점을 테스트가 정하는 백엔드. */
function controlledBackend() {
  const pending: { method: string; args: unknown[]; reply: (value: Result<unknown>) => void }[] = [];
  const queue = (method: string) => (...args: unknown[]) => {
    const { promise, resolve } = deferred<Result<unknown>>();
    pending.push({ method, args, reply: resolve });
    return promise;
  };
  const backend = { open: queue("open"), close: queue("close"), session: queue("session"), sessions: queue("sessions") } as unknown as DocumentBackend;
  const take = (method: string, first?: unknown) => {
    const at = pending.findIndex((call) => call.method === method && (first === undefined || call.args[0] === first));
    return pending.splice(at, 1)[0]!;
  };
  return { backend, pending, take };
}

const ok = <T,>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: DocumentError): Result<never> => ({ ok: false, error });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("세션 투영", () => {
  it("열기 결과를 목록에 넣고 활성으로 만든다. 세션 존재와 활성 선택은 별개다", async () => {
    const { backend, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const listener = vi.fn();
    sessions.subscribe(listener);
    const first = sessions.open("/a.docx");
    take("open").reply(ok(docx));
    await first;
    const second = sessions.open("/b.hwpx");
    take("open").reply(ok(hwpx));
    await second;
    expect(sessions.snapshot()).toEqual({ sessions: [docx, hwpx], activeId: 2 });
    expect(sessions.select(1)).toBe(true);
    expect(sessions.snapshot()).toEqual({ sessions: [docx, hwpx], activeId: 1 }); // 선택은 세션·revision을 바꾸지 않음
    expect(sessions.select(99)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("동시에 연 두 문서가 거꾸로 끝나도 마지막 요청만 활성이 되고, 둘 다 목록에 남는다", async () => {
    for (const order of [["a", "b"], ["b", "a"]]) {
      const { backend, pending } = controlledBackend();
      const sessions = new DocumentSessions(backend);
      const a = sessions.open("/a.docx");
      const b = sessions.open("/b.hwpx");
      const [callA, callB] = [pending[0]!, pending[1]!];
      for (const name of order) (name === "a" ? callA : callB).reply(ok(name === "a" ? docx : hwpx));
      await Promise.all([a, b]);
      expect(sessions.snapshot(), order.join()).toEqual({ sessions: [docx, hwpx], activeId: 2 });
    }
  });

  it("열기를 기다리는 동안 사용자가 다른 문서를 고르면 끝난 열기가 선택을 빼앗지 않는다", async () => {
    const { backend, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const first = sessions.open("/a.docx");
    take("open").reply(ok(docx));
    await first;
    const second = sessions.open("/b.hwpx");
    const third = sessions.open("/c.hwp");
    take("open", "/c.hwp").reply(ok(hwp));
    await third;
    expect(sessions.snapshot().activeId).toBe(3);
    sessions.select(1);
    take("open", "/b.hwpx").reply(ok(hwpx));
    await second;
    expect(sessions.snapshot()).toEqual({ sessions: [docx, hwpx, hwp], activeId: 1 });
  });

  it("세션 A의 늦은 응답은 활성 문서가 B로 바뀐 뒤에도 A에만 반영되고, 옛 판은 새 판을 덮지 않는다", async () => {
    const { backend, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    for (const [path, info] of [["/a.docx", docx], ["/b.hwpx", hwpx]] as const) {
      const opening = sessions.open(path);
      take("open").reply(ok(info));
      await opening;
    }
    sessions.select(1);
    const older = sessions.refresh(1);
    const newer = sessions.refresh(1);
    sessions.select(2); // 응답을 기다리는 동안 활성 문서를 바꿈
    take("session", 1).reply(ok({ ...docx, revision: 2 }));
    await older;
    take("session", 1).reply(ok({ ...docx, revision: 1 })); // 늦게 도착한 옛 판
    await newer;
    expect(sessions.snapshot()).toEqual({ sessions: [{ ...docx, revision: 2 }, hwpx], activeId: 2 });
  });

  it("닫은 세션의 늦은 응답은 버리고, 하나를 닫아도 다른 세션은 그대로다", async () => {
    const { backend, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    for (const [path, info] of [["/a.docx", docx], ["/b.hwpx", hwpx], ["/c.hwp", hwp]] as const) {
      const opening = sessions.open(path);
      take("open").reply(ok(info));
      await opening;
    }
    sessions.select(2);
    const late = sessions.refresh(2);
    const closing = sessions.close(2);
    take("close", 2).reply(ok({ sessionId: 2, alreadyClosed: false }));
    await closing;
    expect(sessions.snapshot()).toEqual({ sessions: [docx, hwp], activeId: 3 }); // 닫은 자리의 다음 문서
    take("session", 2).reply(ok({ ...hwpx, revision: 5 }));
    await late;
    expect(sessions.snapshot()).toEqual({ sessions: [docx, hwp], activeId: 3 });
    sessions.applyUpdate({ ...hwpx, revision: 9 });
    expect(sessions.snapshot().sessions).toEqual([docx, hwp]);
  });

  it("되풀이한 닫기와 이미 닫힌·모르는 세션 오류는 목록에서 빼고, 다른 실패에서는 남긴다", async () => {
    const { backend, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    for (const [path, info] of [["/a.docx", docx], ["/b.hwpx", hwpx], ["/c.hwp", hwp]] as const) {
      const opening = sessions.open(path);
      take("open").reply(ok(info));
      await opening;
    }
    const repeated = sessions.close(1);
    take("close").reply(ok({ sessionId: 1, alreadyClosed: true }));
    await repeated;
    const stale = sessions.refresh(2);
    take("session").reply(fail({ code: "StaleSession", sessionId: 2 }));
    await stale;
    const broken = sessions.close(3);
    take("close").reply(fail({ code: "Protocol" }));
    expect(await broken).toEqual(fail({ code: "Protocol" }));
    expect(sessions.snapshot()).toEqual({ sessions: [hwp], activeId: 3 });
  });

  it("이미 열린 파일을 다시 열면 그 세션을 활성으로 만들고, 실패한 열기는 아무것도 남기지 않는다", async () => {
    const { backend, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    for (const [path, info] of [["/a.docx", docx], ["/b.hwpx", hwpx]] as const) {
      const opening = sessions.open(path);
      take("open").reply(ok(info));
      await opening;
    }
    const again = sessions.open("/a.docx");
    take("open").reply(fail({ code: "AlreadyOpen", sessionId: 1 }));
    await again;
    expect(sessions.snapshot().activeId).toBe(1);
    const bad = sessions.open("/x.docx");
    take("open").reply(fail({ code: "UnsupportedFormat", kind: "unknown" }));
    await bad;
    expect(sessions.snapshot()).toEqual({ sessions: [docx, hwpx], activeId: 1 });
    await flush();
  });

  it("리듀서는 형식·엔진이 바뀐 응답과 목록에 없는 세션의 선택을 무시한다", () => {
    const state = reduceSessions(EMPTY_SESSIONS, { type: "opened", session: docx, activate: true });
    expect(reduceSessions(state, { type: "updated", session: { ...docx, format: "hwpx", engine: "rhwp", revision: 3 } })).toBe(state);
    expect(reduceSessions(state, { type: "selected", sessionId: 7 })).toBe(state);
    expect(reduceSessions(state, { type: "closed", sessionId: 7 })).toBe(state);
    expect(reduceSessions(state, { type: "closed", sessionId: 1 })).toEqual(EMPTY_SESSIONS);
    const same = reduceSessions(state, { type: "updated", session: { ...docx } });
    expect(same.sessions[0]).toEqual(docx); // 같은 판은 반영(상태 변화용)
  });
});
