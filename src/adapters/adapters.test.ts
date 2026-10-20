import { describe, expect, it, vi } from "vitest";
import { createTauriBackend, type DocumentBackend, type Invoke } from "./backend";
import { parseBackendError, parseSessionInfo, type DocumentError, type Result, type SessionInfo } from "./contract";
import { DocumentSessions, EMPTY_SESSIONS, reduceSessions } from "./sessions";

// Rust serde 직렬화 형식(src-tauri/src/document/)과 같은 값. 실제 IPC 응답은 tests/e2e/tauri_smoke.py가 확인한다.
const base = { revision: 0, state: "identified", dirty: false, sequence: 0, loadGeneration: 0 } as const;
const docx: SessionInfo = { ...base, sessionId: 1, format: "docx", engine: "wordcraft", displayName: "a.docx" };
const hwpx: SessionInfo = { ...base, sessionId: 2, format: "hwpx", engine: "rhwp", displayName: "b.hwpx" };
const hwp: SessionInfo = { ...base, sessionId: 3, format: "hwp", engine: "rhwp", displayName: "c.hwp" };

describe("IPC 계약 검사", () => {
  it("세션 정보를 받아들이고, 라우팅 규칙과 어긋나거나 모양이 다른 응답은 거부한다", () => {
    for (const info of [docx, hwpx, hwp]) expect(parseSessionInfo(JSON.parse(JSON.stringify(info)))).toEqual(info);
    const broken: unknown[] = [
      null, [], "x",
      { ...docx, engine: "rhwp" }, // docx를 rhwp로 보냄
      { ...hwp, engine: "wordcraft" },
      { ...docx, format: "doc" },
      { ...docx, sessionId: 0 }, { ...docx, sessionId: 1.5 }, { ...docx, sessionId: "1" },
      { ...docx, revision: -1 }, { ...docx, state: "done" }, { ...docx, displayName: 3 },
      { ...docx, dirty: "no" }, { ...docx, sequence: -1 }, { ...docx, sequence: undefined },
      { ...docx, loadGeneration: -1 }, { ...docx, loadGeneration: 1.5 }, { ...docx, loadGeneration: undefined },
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
      { code: "InvalidState", sessionId: 2, state: "loading" },
      { code: "RevisionMismatch", sessionId: 2, revision: 7 },
      { code: "StaleLoad", sessionId: 3, loadGeneration: 2 },
      { code: "FileChanged" },
      { code: "InvalidRequest" },
      { code: "Internal" },
    ];
    for (const error of valid) expect(parseBackendError(error)).toEqual(error);
    const invalid = [
      "denied", { code: "Nope" }, { code: "InvalidPath", reason: "weird" }, { code: "ExtensionMismatch", declared: "docx" },
      { code: "Internal", detail: "synthetic-detail-marker" }, { code: "ParseFailure", reason: "truncated", message: "os error 2" },
      { code: "toString" }, { code: "StaleSession", sessionId: -1 },
      { code: "StaleLoad", sessionId: 3 }, { code: "StaleLoad", sessionId: 3, loadGeneration: "2" },
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
  const backend = {
    open: queue("open"), close: queue("close"), session: queue("session"), sessions: queue("sessions"),
    load: queue("load"), setState: queue("setState"), commit: queue("commit"),
  } as unknown as DocumentBackend;
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
    take("session", 1).reply(ok({ ...docx, revision: 2, sequence: 2 }));
    await older;
    take("session", 1).reply(ok({ ...docx, revision: 1, sequence: 1 })); // 늦게 도착한 옛 판
    await newer;
    expect(sessions.snapshot()).toEqual({ sessions: [{ ...docx, revision: 2, sequence: 2 }, hwpx], activeId: 2 });
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
    take("session", 2).reply(ok({ ...hwpx, revision: 5, sequence: 5 }));
    await late;
    expect(sessions.snapshot()).toEqual({ sessions: [docx, hwp], activeId: 3 });
    sessions.applyUpdate({ ...hwpx, revision: 9, sequence: 9 });
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
    expect(reduceSessions(state, { type: "updated", session: { ...docx, format: "hwpx", engine: "rhwp", revision: 3, sequence: 3 } })).toBe(state);
    expect(reduceSessions(state, { type: "selected", sessionId: 7 })).toBe(state);
    expect(reduceSessions(state, { type: "closed", sessionId: 7 })).toBe(state);
    expect(reduceSessions(state, { type: "closed", sessionId: 1 })).toEqual(EMPTY_SESSIONS);
    // 같은 sequence는 이미 반영한 응답이므로 무시하고, 더 큰 sequence의 상태 변화는 반영한다(revision이 같아도).
    expect(reduceSessions(state, { type: "updated", session: { ...docx, state: "loading" } })).toBe(state);
    const loading = reduceSessions(state, { type: "updated", session: { ...docx, state: "loading", sequence: 1 } });
    expect(loading.sessions[0]).toEqual({ ...docx, state: "loading", sequence: 1 });
    // revision이 줄어드는 응답은 sequence가 커도 계약 위반이라 버린다.
    const edited = reduceSessions(loading, { type: "updated", session: { ...docx, revision: 2, sequence: 3 } });
    expect(reduceSessions(edited, { type: "updated", session: { ...docx, revision: 1, sequence: 4 } })).toBe(edited);
  });
});

describe("T007 백엔드 클라이언트와 세션 투영", () => {
  it("불러오기는 세션 ID만 보내고 시도 번호(8바이트 LE)+원시 바이트를 받으며, 전이·확정은 그 번호를 보낸다", async () => {
    const calls: [string, unknown][] = [];
    const replies: Record<string, unknown> = {
      document_load: new Uint8Array([7, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3]).buffer,
      document_set_state: { ...hwpx, state: "ready", sequence: 2 },
      document_commit: { ...hwp, revision: 1, state: "ready", dirty: true, sequence: 3 }, // 다른 세션의 응답
    };
    const invoke: Invoke = async (command, args) => {
      calls.push([command, args]);
      return replies[command];
    };
    const backend = createTauriBackend(invoke);
    const loaded = await backend.load(2);
    expect(loaded.ok && loaded.value.generation).toBe(7);
    expect(loaded.ok && Array.from(loaded.value.bytes)).toEqual([1, 2, 3]);
    expect(await backend.setState(2, 7, "loading", "ready")).toEqual({ ok: true, value: { ...hwpx, state: "ready", sequence: 2 } });
    expect(await backend.commit(2, 7, 0, 1)).toEqual({ ok: false, error: { code: "Protocol" } });
    expect(calls).toEqual([
      ["document_load", { sessionId: 2 }],
      ["document_set_state", { sessionId: 2, loadGeneration: 7, from: "loading", to: "ready" }],
      ["document_commit", { sessionId: 2, loadGeneration: 7, baseRevision: 0, count: 1 }],
    ]);
    // 머리가 모자라거나, 시도 번호가 0이거나, JS 수로 정확히 나타낼 수 없으면 계약 위반
    const header = (bytes: number[]) => new Uint8Array(bytes).buffer;
    for (const bad of ["not bytes", header([1, 0, 0]), header([0, 0, 0, 0, 0, 0, 0, 0, 9]), header([0, 0, 0, 0, 0, 0, 0x20, 0])]) {
      replies.document_load = bad;
      expect(await backend.load(2)).toEqual({ ok: false, error: { code: "Protocol" } });
    }
    replies.document_load = header([1, 0, 0, 0, 0, 0, 0, 0]); // 빈 문서 바이트는 계약상 가능(엔진이 판단)
    expect(await backend.load(2)).toEqual({ ok: true, value: { generation: 1, bytes: new Uint8Array(0) } });
    replies.document_load = header([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0, 5]); // 2^53 - 1: 가장 큰 정확한 값
    expect(await backend.load(2)).toEqual({ ok: true, value: { generation: Number.MAX_SAFE_INTEGER, bytes: new Uint8Array([5]) } });
    replies.document_load = header([0, 0, 0, 0, 1, 0, 0, 0]); // 2^32: 위 32비트도 읽는다
    expect(await backend.load(2)).toEqual({ ok: true, value: { generation: 2 ** 32, bytes: new Uint8Array(0) } });
  });

  it("WebView가 다시 시작되면 남은 세션을 목록에 넣고 loading·ready 세션을 failed로 돌린다", async () => {
    const { backend, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const ready = { ...hwpx, state: "ready", revision: 4, dirty: true, sequence: 6, loadGeneration: 3 } as const;
    const reconciling = sessions.reconcile();
    take("sessions").reply(ok([docx, ready]));
    await flush();
    const transition = take("setState", 2);
    expect(transition.args).toEqual([2, 3, "ready", "failed"]); // 목록에서 본 시도의 번호로만
    transition.reply(ok({ ...ready, state: "failed", sequence: 7 }));
    await reconciling;
    expect(sessions.snapshot()).toEqual({ sessions: [docx, { ...ready, state: "failed", sequence: 7 }], activeId: 1 });
  });
});
