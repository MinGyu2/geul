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
      if (opened > 2 || !Object.keys(faults).length) return doc as unknown as RhwpDocument;
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
