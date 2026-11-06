// 보존 사전 검사의 자원 정리·백엔드 거부 안전성(T009). 엔진이 던지는 정리 실패와 백엔드 전송 거부가 구조화된 Result를 덮거나,
// 진행 상태를 얼리거나, 안전을 확인하지 못한 검사로 저장을 허용하지 않는지 본다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentSessions } from "../../../adapters/sessions";
import type { SaveOutcome } from "../../../adapters/contract";
import { RhwpEditorSession } from "./RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
import { base, controlledBackend, fail, FakeDocument, flush, info, loaded, ok } from "./testing";

const safeCheck = { preservation: { outcome: "safe" as const, findings: [] }, platformSupported: true };
const EXPORT_FAILED = { code: "EngineFailure", engine: "rhwp", stage: "export" } as const;
const PROTOCOL = { code: "Protocol" } as const;
const UNCERTAIN = { code: "SaveNotReady", reason: "uncertain" } as const;
const durable = ok({ session: info({ state: "ready", revision: 0, sequence: 3, loadGeneration: 1 }), bytes: 8, durable: true } satisfies SaveOutcome);

interface FreshFaults {
  exportThrows?: boolean;
  takeBytesThrows?: boolean;
  exportedFreeThrows?: boolean;
  freshFreeThrows?: boolean;
  openThrows?: boolean;
  /** 결함을 넣을 openDocument 순번(기본 2: 첫 사전 검사). */
  atOpen?: number;
}

/** 두 번째 openDocument가 사전 검사의 독립 문서다(첫 번째는 편집 모델). 해제 시도를 순서대로 남긴다. */
async function session(faults: FreshFaults = {}) {
  const { backend, calls, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwp");
  take("open").reply(ok(base));
  await opening;
  const released: string[] = [];
  const live = new FakeDocument(["before"]);
  let opened = 0;
  const module: RhwpModule = {
    openDocument: () => {
      opened += 1;
      if (opened === 1) return live as unknown as RhwpDocument;
      const doc = new FakeDocument(["before"]);
      if (opened !== (faults.atOpen ?? 2) || !Object.keys(faults).length) return doc as unknown as RhwpDocument;
      if (faults.openThrows) throw new Error("open trap");
      const exportReport = doc.exportHwpWithReport.bind(doc);
      Object.assign(doc, {
        exportHwpWithReport: () => {
          if (faults.exportThrows) throw new Error("export trap");
          const exported = exportReport();
          return {
            contentLoss: exported.contentLoss,
            takeBytes: () => {
              if (faults.takeBytesThrows) throw new Error("takeBytes trap");
              return exported.takeBytes();
            },
            free: () => {
              released.push("exported");
              if (faults.exportedFreeThrows) throw new Error("exported cleanup");
            },
          };
        },
        free: () => {
          released.push("fresh");
          if (faults.freshFreeThrows) throw new Error("fresh cleanup");
          doc.freed = true;
        },
      });
      return doc as unknown as RhwpDocument;
    },
  };
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module, { history: false });
  const loading = editor.load();
  take("load").reply(loaded());
  await flush();
  take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
  take("setState").reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
  await loading;
  return { editor, calls, take, backend, sessions, released, opened: () => opened };
}
type Session = Awaited<ReturnType<typeof session>>;

const messages = (t: Session) => t.editor.saveCleanupErrors.map(error => (error as Error).message);
const called = (t: Session, method: string) => t.calls.some(call => call.method === method);

/** 원본 응답까지 넘겨 사전 검사의 엔진 단계를 끝낸다(결과는 호출한 쪽이 받는다). */
async function replyOriginal(t: Session) {
  t.take("original").reply(ok(new Uint8Array([1])));
  await flush();
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
process.on("unhandledRejection", onUnhandled);
afterEach(async () => {
  await flush();
  expect(unhandled.splice(0)).toEqual([]);
  vi.restoreAllMocks();
});

describe("RHWP preflight resource cleanup", () => {
  // 어느 쪽 entry point이든 같은 판정을 돌려줘야 한다.
  describe.each([
    ["checkSave", (t: Session) => t.editor.checkSave() as Promise<{ ok: boolean; error?: unknown }>],
    ["save", (t: Session) => t.editor.save() as Promise<{ ok: boolean; error?: unknown }>],
  ])("%s", (_name, start) => {
    it("fresh.free() after a successful export fails closed instead of rejecting", async () => {
      const t = await session({ freshFreeThrows: true });
      const pending = start(t);
      await replyOriginal(t);
      await expect(pending).resolves.toEqual({ ok: false, error: UNCERTAIN });
      expect(t.released).toEqual(["exported", "fresh"]);
      expect(messages(t)).toEqual(["fresh cleanup"]);
      expect(called(t, "preflight")).toBe(false);
      expect(called(t, "save")).toBe(false);
      expect(t.editor.saveCheck).toBeNull();
      expect(t.editor.saveState).toEqual({ kind: "failed", error: UNCERTAIN });
      expect(t.editor.snapshot().saving).toBe(false);
      expect(t.editor.hasUncertainChanges).toBe(true);
      expect(t.editor.hasUnpreservedChanges).toBe(true);
      expect(t.editor.status).toEqual({ kind: "failed", error: { code: "EngineFailure", engine: "rhwp", stage: "edit" } });
      // 재시도는 부분 해제된 모듈을 다시 쓰지 않고 멈춘다(열린 문서 수가 늘지 않음).
      const opened = t.opened();
      await expect(start(t)).resolves.toMatchObject({ ok: false, error: { code: "SaveNotReady", reason: "state" } });
      expect(t.opened()).toBe(opened);
    });

    it("fresh.free() after an export failure keeps the export failure primary", async () => {
      const t = await session({ exportThrows: true, freshFreeThrows: true });
      const pending = start(t);
      await replyOriginal(t);
      await expect(pending).resolves.toEqual({ ok: false, error: EXPORT_FAILED });
      expect(t.released).toEqual(["fresh"]);
      expect(messages(t)).toEqual(["fresh cleanup"]);
      expect(t.editor.saveState).toEqual({ kind: "failed", error: EXPORT_FAILED });
      expect(t.editor.hasUncertainChanges).toBe(true);
      expect(t.editor.status.kind).toBe("failed");
    });

    it("exported.free() does not authorize the output and still frees the document", async () => {
      const t = await session({ exportedFreeThrows: true });
      const pending = start(t);
      await replyOriginal(t);
      await expect(pending).resolves.toEqual({ ok: false, error: UNCERTAIN });
      expect(t.released).toEqual(["exported", "fresh"]);
      expect(messages(t)).toEqual(["exported cleanup"]);
      expect(called(t, "preflight")).toBe(false);
      expect(t.editor.hasUncertainChanges).toBe(true);
      expect(t.editor.saveState).toEqual({ kind: "failed", error: UNCERTAIN });
    });

    it("attempts both releases and retains both errors", async () => {
      const t = await session({ exportedFreeThrows: true, freshFreeThrows: true });
      const pending = start(t);
      await replyOriginal(t);
      await expect(pending).resolves.toEqual({ ok: false, error: UNCERTAIN });
      expect(t.released).toEqual(["exported", "fresh"]);
      expect(messages(t)).toEqual(["exported cleanup", "fresh cleanup"]);
      expect(t.editor.saveState).toEqual({ kind: "failed", error: UNCERTAIN });
    });

    it("takeBytes() failure stays an export failure and releases both owners", async () => {
      const t = await session({ takeBytesThrows: true });
      const pending = start(t);
      await replyOriginal(t);
      await expect(pending).resolves.toEqual({ ok: false, error: EXPORT_FAILED });
      expect(t.released).toEqual(["exported", "fresh"]);
      expect(messages(t)).toEqual([]);
      expect(t.editor.hasUncertainChanges).toBe(false);
      expect(t.editor.status.kind).toBe("ready");
      expect(t.editor.snapshot().saving).toBe(false);
    });

    it("export failure and openDocument failure leave the editing model usable for a retry", async () => {
      for (const faults of [{ exportThrows: true }, { openThrows: true }]) {
        const t = await session(faults);
        const pending = start(t);
        await replyOriginal(t);
        await expect(pending).resolves.toEqual({ ok: false, error: EXPORT_FAILED });
        expect(called(t, "preflight")).toBe(false);
        expect(t.editor.saveState).toEqual({ kind: "failed", error: EXPORT_FAILED });
        expect(t.editor.status.kind).toBe("ready");
        expect(t.editor.hasUncertainChanges).toBe(false);
        // 재시도는 정상 문서로 끝까지 간다.
        const retry = start(t);
        await replyOriginal(t);
        t.take("preflight").reply(ok(safeCheck));
        await flush();
        if (called(t, "save")) t.take("save").reply(durable);
        await expect(retry).resolves.toMatchObject({ ok: true });
      }
    });

    it("structured backend.original() and backend.preflight() errors stay structured", async () => {
      const refusal = { code: "FileChanged" } as const;
      const a = await session();
      const first = start(a);
      a.take("original").reply(fail(refusal));
      await expect(first).resolves.toEqual({ ok: false, error: refusal });
      expect(a.editor.saveState).toEqual({ kind: "failed", error: refusal });
      expect(a.editor.status.kind).toBe("ready");

      const b = await session();
      const second = start(b);
      await replyOriginal(b);
      b.take("preflight").reply(fail(refusal));
      await expect(second).resolves.toEqual({ ok: false, error: refusal });
      expect(b.editor.saveCheck).toBeNull();
      expect(b.editor.saveState).toEqual({ kind: "failed", error: refusal });
      expect(called(b, "save")).toBe(false);
      expect(b.editor.snapshot().saving).toBe(false);
    });

    it.each(["original", "preflight"] as const)("backend.%s() rejection becomes a Protocol result and a retry works", async (method) => {
      const t = await session();
      const rejection = new Error(`${method} transport`);
      const real = t.backend[method];
      t.backend[method] = (() => Promise.reject(rejection)) as never;
      const pending = start(t);
      if (method === "preflight") await replyOriginal(t);
      await expect(pending).resolves.toEqual({ ok: false, error: PROTOCOL });
      expect(t.editor.saveTransportErrors).toEqual([rejection]);
      expect(t.editor.saveCleanupErrors).toEqual([]);
      expect(t.editor.saveState).toEqual({ kind: "failed", error: PROTOCOL });
      expect(t.editor.saveCheck).toBeNull();
      expect(t.editor.snapshot().saving).toBe(false);
      expect(t.editor.status.kind).toBe("ready");
      expect(t.editor.hasUncertainChanges).toBe(false);
      expect(called(t, "save")).toBe(false);

      t.backend[method] = real as never;
      const retry = start(t);
      await replyOriginal(t);
      t.take("preflight").reply(ok(safeCheck));
      await flush();
      if (called(t, "save")) t.take("save").reply(durable);
      await expect(retry).resolves.toMatchObject({ ok: true });
    });
  });

  it("keeps edits dirty and their revision intact through a preflight rejection", async () => {
    const t = await session();
    t.editor.typeText("x");
    t.take("commit").reply(ok(info({ state: "ready", revision: 1, dirty: true, sequence: 3, loadGeneration: 1 })));
    await flush();
    t.backend.original = (() => Promise.reject(new Error("transport"))) as never;
    await expect(t.editor.save()).resolves.toEqual({ ok: false, error: PROTOCOL });
    expect(t.editor.hasUnpreservedChanges).toBe(true);
    expect(t.sessions.get(1)?.dirty).toBe(true);
    expect(t.editor.localRevision).toBe(1);
  });

  it("does not reuse an earlier safe check after a later check could not establish safety", async () => {
    const t = await session();
    const first = t.editor.checkSave();
    await replyOriginal(t);
    t.take("preflight").reply(ok(safeCheck));
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(t.editor.saveCheck).not.toBeNull();

    t.backend.original = (() => Promise.reject(new Error("transport"))) as never;
    await expect(t.editor.checkSave()).resolves.toEqual({ ok: false, error: PROTOCOL });
    expect(t.editor.saveCheck).toBeNull();
    await expect(t.editor.save()).resolves.toEqual({ ok: false, error: PROTOCOL });
    expect(called(t, "save")).toBe(false);
  });

  it("an older check's cleanup failure cannot be hidden by, or freeze, a newer check", async () => {
    const t = await session({ freshFreeThrows: true });
    const older = t.editor.checkSave();
    const newer = t.editor.checkSave();
    const [olderOriginal, newerOriginal] = [t.take("original"), t.take("original")];
    olderOriginal.reply(ok(new Uint8Array([1])));
    await flush();
    await expect(older).resolves.toEqual({ ok: false, error: UNCERTAIN });
    const opened = t.opened();
    newerOriginal.reply(ok(new Uint8Array([1])));
    await expect(newer).resolves.toEqual({ ok: false, error: { code: "SaveNotReady", reason: "state" } });
    expect(t.opened()).toBe(opened); // 멈춘 모듈에 문서를 새로 열지 않는다
    expect(t.editor.saveState.kind).toBe("failed");
    expect(t.editor.saveCheck).toBeNull();
  });

  describe("disposal and reload while pending", () => {
    it.each(["original", "preflight"] as const)("a rejection of %s after disposal is stale and changes nothing", async (method) => {
      const t = await session();
      let reject!: (reason: unknown) => void;
      t.backend[method] = (() => new Promise((_, r) => { reject = r; })) as never;
      const pending = t.editor.save();
      if (method === "preflight") await replyOriginal(t);
      t.editor.dispose();
      reject(new Error("late transport"));
      await expect(pending).resolves.toEqual({ ok: false, error: { code: "StaleSession", sessionId: 1 } });
      expect(t.editor.status).toEqual({ kind: "closed" });
      expect(t.editor.saveCleanupErrors).toEqual([]);
    });

    it("a structured original error after disposal is reported as stale", async () => {
      const t = await session();
      const pending = t.editor.checkSave();
      const original = t.take("original");
      t.editor.dispose();
      original.reply(fail({ code: "FileChanged" }));
      await expect(pending).resolves.toEqual({ ok: false, error: { code: "StaleSession", sessionId: 1 } });
      expect(t.editor.status).toEqual({ kind: "closed" });
    });

    it("a preflight superseded by reload neither touches the new model nor opens a document", async () => {
      const t = await session();
      const pending = t.editor.save();
      const original = t.take("original");
      const reloading = t.editor.load({ discard: true });
      await flush();
      const openedBefore = t.opened();
      original.reply(ok(new Uint8Array([1])));
      await expect(pending).resolves.toEqual({ ok: false, error: { code: "StaleSession", sessionId: 1 } });
      expect(t.opened()).toBe(openedBefore);
      t.take("load").reply(loaded(new Uint8Array([1]), 2));
      await flush();
      t.take("session").reply(ok(info({ state: "loading", sequence: 4, loadGeneration: 2 })));
      t.take("setState").reply(ok(info({ state: "ready", sequence: 5, loadGeneration: 2 })));
      await expect(reloading).resolves.toEqual({ ok: true, value: null });
      expect(t.editor.saveState).toEqual({ kind: "idle" });
      expect(t.editor.snapshot().saving).toBe(false);
    });
  });
});

/** 구독자가 동기로 일으키는 전이: 정리 실패 알림 안에서 세션을 닫거나 다시 불러오거나 새 검사를 시작한다. */
describe("RHWP preflight cleanup reentrancy", () => {
  type Internals = { epoch: number; checkSerial: number; generation: number };
  const internals = (t: Session) => t.editor as unknown as Internals;
  const observe = (t: Session, label: string, result?: unknown) => {
    const state = {
      label, result, saveState: t.editor.saveState, status: t.editor.status, epoch: internals(t).epoch,
      checkSerial: internals(t).checkSerial, generation: internals(t).generation, saveCheck: t.editor.saveCheck,
      saving: t.editor.snapshot().saving, uncertain: t.editor.hasUncertainChanges, unpreserved: t.editor.hasUnpreservedChanges,
      released: t.released, cleanupErrors: messages(t), backendSave: called(t, "save"),
    };
    console.info("preflight-reentrancy-state", JSON.stringify(state));
    return state;
  };
  /** 편집 멈춤을 처음 알릴 때 한 번만 동기로 action을 부른다. */
  const onFirstFailure = (t: Session, action: () => void) => {
    let done = false;
    t.editor.subscribe(() => {
      if (done || t.editor.status.kind !== "failed") return;
      done = true;
      action();
    });
  };
  const STALE = { code: "StaleSession", sessionId: 1 } as const;
  const entries = [
    ["checkSave", (t: Session) => t.editor.checkSave() as Promise<unknown>],
    ["save", (t: Session) => t.editor.save() as Promise<unknown>],
  ] as const;

  describe.each(entries)("%s", (name, start) => {
    it("a synchronous dispose in the failure notification keeps the closed session's state", async () => {
      const t = await session({ freshFreeThrows: true });
      let atDispose: unknown;
      onFirstFailure(t, () => { atDispose = t.editor.saveState; t.editor.dispose(); });
      const pending = start(t);
      await replyOriginal(t);
      const result = await pending;
      const state = observe(t, `${name}/dispose`, result);
      expect(result).toEqual({ ok: false, error: STALE });
      expect(atDispose).toEqual({ kind: "checking" });
      expect(state.saveState).toEqual({ kind: "checking" }); // 닫힌 세션은 표시를 더 바꾸지 않는다
      expect(state.status).toEqual({ kind: "closed" });
      expect(state.saving).toBe(false);
      expect(state.saveCheck).toBeNull();
      expect(state.released).toEqual(["exported", "fresh"]);
      expect(state.cleanupErrors).toEqual(["fresh cleanup"]);
      expect(state.backendSave).toBe(false);
      expect(called(t, "preflight")).toBe(false);
    });

    it("releases both owners before any subscriber runs, once each, and keeps both errors", async () => {
      const t = await session({ exportedFreeThrows: true, freshFreeThrows: true });
      let releasedAtNotification: string[] = [];
      onFirstFailure(t, () => { releasedAtNotification = [...t.released]; t.editor.dispose(); });
      const pending = start(t);
      await replyOriginal(t);
      await expect(pending).resolves.toEqual({ ok: false, error: STALE });
      expect(releasedAtNotification).toEqual(["exported", "fresh"]);
      expect(t.released).toEqual(["exported", "fresh"]);
      expect(messages(t)).toEqual(["exported cleanup", "fresh cleanup"]);
      observe(t, `${name}/dispose-both`);
    });

    it("an export failure whose cleanup disposes the session reports stale and keeps the closed state", async () => {
      const t = await session({ exportThrows: true, freshFreeThrows: true });
      onFirstFailure(t, () => t.editor.dispose());
      const pending = start(t);
      await replyOriginal(t);
      await expect(pending).resolves.toEqual({ ok: false, error: STALE });
      expect(t.editor.saveState).toEqual({ kind: "checking" });
      expect(t.editor.status).toEqual({ kind: "closed" });
      observe(t, `${name}/dispose-export-failed`);
    });

    it("a synchronous reload waits for the failure transition; the old attempt cannot reach the new model", async () => {
      const t = await session({ freshFreeThrows: true });
      let reloading: Promise<unknown> | null = null;
      onFirstFailure(t, () => { reloading = t.editor.load({ discard: true }); });
      const pending = start(t);
      await replyOriginal(t);
      const result = await pending;
      const old = observe(t, `${name}/reload-before-transition`, result);
      // load는 failed 전이를 확인할 때까지 옛 모델을 놓지 않는다: 이 시점의 옛 모델 실패는 아직 맞는 표시다.
      expect(result).toEqual({ ok: false, error: UNCERTAIN });
      expect(old.saveState).toEqual({ kind: "failed", error: UNCERTAIN });
      expect(old.generation).toBe(1);

      t.take("setState").reply(ok(info({ state: "failed", sequence: 3, loadGeneration: 1 })));
      await flush();
      t.take("load").reply(loaded(new Uint8Array([1]), 2));
      await flush();
      t.take("session").reply(ok(info({ state: "loading", sequence: 4, loadGeneration: 2 })));
      t.take("setState").reply(ok(info({ state: "ready", sequence: 5, loadGeneration: 2 })));
      await expect(reloading).resolves.toEqual({ ok: true, value: null });
      await flush();
      const fresh = observe(t, `${name}/reload-ready`);
      expect(fresh.status).toEqual({ kind: "ready" });
      expect(fresh.saveState).toEqual({ kind: "idle" });
      expect(fresh.generation).toBe(2);
      expect(fresh.uncertain).toBe(false);
      expect(fresh.unpreserved).toBe(false);
      expect(fresh.saveCheck).toBeNull();
      expect(fresh.saving).toBe(false);
      expect(fresh.backendSave).toBe(false);
    });

    it("keeps the cleanup failure visible when nothing superseded the attempt", async () => {
      const t = await session({ freshFreeThrows: true });
      const pending = start(t);
      await replyOriginal(t);
      const result = await pending;
      const state = observe(t, `${name}/plain`, result);
      expect(result).toEqual({ ok: false, error: UNCERTAIN });
      expect(state.saveState).toEqual({ kind: "failed", error: UNCERTAIN });
      expect(state.uncertain).toBe(true);
      expect(state.saving).toBe(false);
    });
  });

  it("a newer checkSave started in the notification is not overwritten by the older attempt", async () => {
    const t = await session({ freshFreeThrows: true });
    let newer: Promise<unknown> | null = null;
    onFirstFailure(t, () => { newer = t.editor.checkSave(); });
    const states: unknown[] = [];
    let newerStarted = false;
    t.editor.subscribe(() => { if (newer) newerStarted = true; if (newerStarted) states.push(t.editor.saveState); });
    const older = t.editor.checkSave();
    await replyOriginal(t);
    const oldResult = await older;
    await expect(newer).resolves.toEqual({ ok: false, error: { code: "SaveNotReady", reason: "state" } });
    const state = observe(t, "checkSave/newer-check", oldResult);
    expect(oldResult).toEqual({ ok: false, error: UNCERTAIN });
    expect(states).not.toContainEqual({ kind: "failed", error: UNCERTAIN }); // 옛 시도는 새 검사 자리에 쓰지 않는다
    expect(state.saveState).toEqual({ kind: "failed", error: { code: "SaveNotReady", reason: "state" } });
    expect(state.saveCheck).toBeNull();
    expect(state.uncertain).toBe(true);
    expect(state.backendSave).toBe(false);
  });

  it("a checkSave refused during save does not hide the save's own cleanup failure", async () => {
    const t = await session({ freshFreeThrows: true });
    let refused: Promise<unknown> | null = null;
    onFirstFailure(t, () => { refused = t.editor.checkSave(); });
    const saving = t.editor.save();
    await replyOriginal(t);
    const result = await saving;
    await expect(refused).resolves.toEqual({ ok: false, error: { code: "SaveInProgress", sessionId: 1 } });
    const state = observe(t, "save/refused-check", result);
    expect(result).toEqual({ ok: false, error: UNCERTAIN });
    expect(state.saveState).toEqual({ kind: "failed", error: UNCERTAIN });
    expect(state.saving).toBe(false);
    expect(state.backendSave).toBe(false);
  });

  it("an older check's cleanup failure still clears a newer safe result: the shared module is unsafe", async () => {
    // 번호만 비교하면 이 실패를 잃는다: 옛 시도는 더 이상 최신이 아니지만 편집 모델은 지금 모델이다.
    const t = await session({ freshFreeThrows: true, atOpen: 3 });
    const older = t.editor.checkSave();
    const olderOriginal = t.take("original");
    const newer = t.editor.checkSave();
    await replyOriginal(t);
    t.take("preflight").reply(ok(safeCheck));
    await expect(newer).resolves.toMatchObject({ ok: true });
    expect(t.editor.saveCheck).not.toBeNull();
    expect(t.editor.saveState).toEqual({ kind: "idle" });

    olderOriginal.reply(ok(new Uint8Array([1])));
    const result = await older;
    const state = observe(t, "checkSave/older-after-newer-safe", result);
    expect(result).toEqual({ ok: false, error: UNCERTAIN });
    expect(state.saveCheck).toBeNull();
    expect(state.saveState).toEqual({ kind: "failed", error: UNCERTAIN });
    expect(state.status.kind).toBe("failed");
    expect(state.uncertain).toBe(true);
    await expect(t.editor.save()).resolves.toMatchObject({ ok: false, error: { code: "SaveNotReady", reason: "state" } });
    expect(called(t, "save")).toBe(false);
  });

  it("an older safe answer cannot replace a newer check's result", async () => {
    const unsafe = { preservation: { outcome: "unsafe" as const, findings: [] }, platformSupported: true };
    const t = await session();
    const older = t.editor.checkSave();
    const olderOriginal = t.take("original");
    const newer = t.editor.checkSave();
    await replyOriginal(t);
    const newerPreflight = t.take("preflight");
    olderOriginal.reply(ok(new Uint8Array([1])));
    await flush();
    const olderPreflight = t.take("preflight");
    newerPreflight.reply(ok(unsafe));
    await newer;
    olderPreflight.reply(ok(safeCheck));
    await older;
    expect(t.editor.saveCheck?.check).toEqual(unsafe);
    expect(t.editor.saveState).toEqual({ kind: "idle" });
    await expect(t.editor.save()).resolves.toMatchObject({ ok: false, error: { code: "UnsafeSave" } });
    expect(called(t, "save")).toBe(false);
  });
});

describe("RHWP publishing export cleanup", () => {
  it("fails closed when the edited model's export object cannot be released", async () => {
    const { backend, calls, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const opening = sessions.open("/a.hwp");
    take("open").reply(ok(base));
    await opening;
    const live = new FakeDocument(["before"]);
    const exportReport = live.exportHwpWithReport.bind(live);
    Object.assign(live, {
      exportHwpWithReport: () => ({ ...exportReport(), free: () => { throw new Error("export object cleanup"); } }),
    });
    let opened = 0;
    const module: RhwpModule = {
      openDocument: () => (++opened === 1 ? live : new FakeDocument(["before"])) as unknown as RhwpDocument,
    };
    const editor = new RhwpEditorSession(1, backend, sessions, async () => module, { history: false });
    const loading = editor.load();
    take("load").reply(loaded());
    await flush();
    take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
    take("setState").reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
    await loading;
    const pending = editor.save();
    take("original").reply(ok(new Uint8Array([1])));
    await flush();
    take("preflight").reply(ok(safeCheck));
    await expect(pending).resolves.toEqual({ ok: false, error: { code: "SaveFailure", stage: "export" } });
    expect(calls.some(call => call.method === "save")).toBe(false);
    expect(editor.saveCleanupErrors.map(error => (error as Error).message)).toEqual(["export object cleanup"]);
    expect(editor.hasUncertainChanges).toBe(true);
    expect(editor.status.kind).toBe("failed");
    expect(editor.snapshot().saving).toBe(false);
  });
});
