import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentSessions } from "../../../adapters/sessions";
import type { SaveOutcome } from "../../../adapters/contract";
import { RhwpEditorSession } from "./RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
import { base, controlledBackend, fail, FakeDocument, flush, info, loaded, ok } from "./testing";

const safeCheck = { preservation: { outcome: "safe" as const, findings: [] }, platformSupported: true };
const observations: (() => unknown)[] = [];
afterEach(() => {
  for (const observe of observations.splice(0)) console.info("save-cleanup-state", JSON.stringify(observe()));
});
const cleanupTrap = new Error("injected cleanup trap");

function tracked(doc: FakeDocument, options: { documentFree?: (() => void) | undefined; prefixFree?: (() => void) | undefined } = {}) {
  Object.assign(doc, {
    charShapeCount: () => 1,
    reconcileCharShapePrefix: () => '{"ok":true}',
    captureCharShapePrefix: () => ({ free: () => options.prefixFree?.() }),
    capturePublishingCharShapePrefix: () => ({ free() {} }),
    free: () => { options.documentFree?.(); doc.freed = true; },
  });
  return doc as unknown as RhwpDocument;
}

async function savingSession(options: {
  reopenedFree?: () => void;
  initialPrefixFree?: () => void;
  leaseFree?: () => void;
} = {}) {
  const { backend, calls, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwp");
  take("open").reply(ok(base));
  await opening;
  const live = new FakeDocument(["before"]);
  tracked(live, { prefixFree: options.initialPrefixFree });
  let openCount = 0;
  const module: RhwpModule = {
    openDocument: () => {
      openCount += 1;
      if (openCount === 1) return live as unknown as RhwpDocument;
      const reopened = new FakeDocument(["before"]);
      const doc = tracked(reopened, { documentFree: openCount === 3 ? options.reopenedFree : undefined });
      // The lease is captured from the live document; its release is independently injectable.
      if (openCount === 3 && options.leaseFree) {
        Object.assign(live, {
          capturePublishingCharShapePrefix: () => ({ free: options.leaseFree }),
        });
      }
      return doc;
    },
  };
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module, { history: false });
  const loading = editor.load();
  take("load").reply(loaded());
  await flush();
  take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
  take("setState").reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
  await loading;
  observations.push(() => {
    const internals = editor as unknown as { text: null | { charShapeBaseline: number; publishedPrefix: unknown; publishingPrefix: unknown }; checkSerial: number; generation: number; epoch: number };
    return { saveState: editor.saveState, saving: editor.snapshot().saving, dirty: editor.hasUnpreservedChanges,
      uncertain: editor.hasUncertainChanges, status: editor.status, session: sessions.get(1),
      baseline: internals.text?.charShapeBaseline, publishedPrefixOwned: !!internals.text?.publishedPrefix,
      pendingLeaseOwned: !!internals.text?.publishingPrefix, saveCheck: editor.saveCheck,
      checkSerial: internals.checkSerial, generation: internals.generation, epoch: internals.epoch,
      localRevision: editor.localRevision, modelText: live.paragraphs, originalBackendBytes: [1],
      backendCalled: calls.some(call => call.method === "save"), cleanupErrors: editor.saveCleanupErrors.map(String) };
  });
  return { editor, live, sessions, calls, take, module, backend };
}

async function advanceToSave(t: Awaited<ReturnType<typeof savingSession>>) {
  const pending = t.editor.save();
  t.take("original").reply(ok(new Uint8Array([1])));
  await flush();
  t.take("preflight").reply(ok(safeCheck));
  await flush();
  return { pending };
}

const durable = (isDurable = true) =>
  ok({ session: info({ state: "ready", revision: 0, dirty: !isDurable, sequence: 3, loadGeneration: 1 }), bytes: 8, durable: isDurable } satisfies SaveOutcome);

describe("RHWP save cleanup exception safety", () => {
  it("keeps a durable success and resets saving when the superseded published prefix throws", async () => {
    const t = await savingSession({ initialPrefixFree: () => { throw cleanupTrap; } });
    const { pending: first } = await advanceToSave(t);
    t.take("save").reply(durable());
    expect(await first).toMatchObject({ ok: true, value: { durable: true } });
    expect(t.editor.snapshot().saving).toBe(false);
    expect(t.editor.saveCleanupErrors).toContain(cleanupTrap);
    expect(t.editor.saveState.kind).toBe("saved");
    expect(t.editor.status.kind).toBe("failed"); // Engine ownership is uncertain, disk result remains successful.
    expect(t.sessions.get(1)?.revision).toBe(0);
  });

  it("preserves a refusal when lease cleanup throws", async () => {
    const freed: string[] = [];
    const t = await savingSession({ leaseFree: () => { freed.push("lease"); throw cleanupTrap; } });
    const { pending } = await advanceToSave(t);
    const refusal = { code: "SaveFailure", stage: "write" } as const;
    t.take("save").reply(fail(refusal));
    expect(await pending).toEqual({ ok: false, error: refusal });
    expect(t.editor.snapshot().saving).toBe(false);
    expect(t.editor.saveState).toMatchObject({ kind: "failed", error: refusal });
    expect(t.editor.saveCleanupErrors).toContain(cleanupTrap);
    expect(t.sessions.get(1)?.dirty).toBe(false);
  });

  it("returns the second durable save result when replacing an older published lease throws", async () => {
    const t = await savingSession({ leaseFree: () => { throw cleanupTrap; } });
    const first = await advanceToSave(t);
    t.take("save").reply(durable());
    expect(await first.pending).toMatchObject({ ok: true, value: { durable: true } });

    const second = t.editor.save();
    t.take("original").reply(ok(new Uint8Array([2])));
    await flush();
    t.take("preflight").reply(ok(safeCheck));
    await flush();
    t.take("save").reply(durable());
    expect(await second).toMatchObject({ ok: true, value: { durable: true } });
    expect(t.editor.snapshot().saving).toBe(false);
    expect(t.editor.saveState).toMatchObject({ kind: "saved", durable: true });
    expect(t.editor.saveCleanupErrors).toContain(cleanupTrap);
    expect(t.editor.status.kind).toBe("failed");
  });

  it("returns export lease ownership and fail closes if reopened document free throws", async () => {
    const t = await savingSession({ reopenedFree: () => { throw cleanupTrap; } });
    const result = t.editor.save();
    t.take("original").reply(ok(new Uint8Array([1])));
    await flush();
    t.take("preflight").reply(ok(safeCheck));
    expect(await result).toMatchObject({ ok: false, error: { code: "SaveFailure", stage: "export" } });
    expect(t.editor.snapshot().saving).toBe(false);
    expect(t.editor.status.kind).toBe("failed");
    expect(t.editor.saveCleanupErrors).toContain(cleanupTrap);
    expect(t.calls.some(call => call.method === "save")).toBe(false);
  });

  it("retains both reopened-document and lease cleanup errors while resetting saving", async () => {
    const t = await savingSession({ reopenedFree: () => { throw new Error("document cleanup"); }, leaseFree: () => { throw new Error("lease cleanup"); } });
    // The lease is acquired before reopened-document cleanup, so both owners must be released independently.
    const result = t.editor.save();
    t.take("original").reply(ok(new Uint8Array([1])));
    await flush();
    t.take("preflight").reply(ok(safeCheck));
    expect(await result).toMatchObject({ ok: false, error: { code: "SaveFailure", stage: "export" } });
    expect(t.editor.snapshot().saving).toBe(false);
    expect(t.editor.saveCleanupErrors.map(error => error instanceof Error ? error.message : String(error))).toEqual(["document cleanup", "lease cleanup"]);
    expect(t.calls.some(call => call.method === "save")).toBe(false);
  });

  it("keeps later local edits dirty when the saved revision is durable", async () => {
    const t = await savingSession();
    const { pending } = await advanceToSave(t);
    t.editor.typeText("after");
    t.take("save").reply(durable());
    expect(await pending).toMatchObject({ ok: true, value: { durable: true } });
    expect(t.editor.saveState).toMatchObject({ kind: "saved", changedSince: true });
    expect(t.editor.hasUnpreservedChanges).toBe(true);
  });

  it("does not mark the document clean after a non-durable replacement", async () => {
    const t = await savingSession();
    const { pending } = await advanceToSave(t);
    t.take("save").reply(durable(false));
    expect(await pending).toMatchObject({ ok: true, value: { durable: false } });
    expect(t.editor.hasUnpreservedChanges).toBe(true);
    expect(t.editor.saveState).toMatchObject({ kind: "saved", durable: false });
  });

  it("returns backend rejection as primary and releases the lock", async () => {
    const t = await savingSession({ leaseFree: () => { throw cleanupTrap; } });
    const rejection = new Error("backend transport");
    t.backend.save = (() => Promise.reject(rejection)) as typeof t.backend.save;
    const pending = t.editor.save().then(value => value, error => error);
    t.take("original").reply(ok(new Uint8Array([1])));
    await flush();
    t.take("preflight").reply(ok(safeCheck));
    expect(await pending).toBe(rejection);
    // Publication outcome is unknown: not a structured write failure, which the UI reports as "original kept".
    expect(t.editor.saveState).toEqual({ kind: "failed", error: { code: "Protocol" } });
    expect(t.editor.saveTransportErrors).toEqual([rejection]);
    expect(t.editor.saveCleanupErrors).toContain(cleanupTrap);
    expect(t.editor.snapshot().saving).toBe(false);
  });

  it("does not let a stale save mutate the replacement session state", async () => {
    let leaseFrees = 0;
    const t = await savingSession({ leaseFree: () => { leaseFrees += 1; throw cleanupTrap; } });
    const { pending } = await advanceToSave(t);
    expect(() => t.editor.dispose()).toThrow(AggregateError);
    expect(leaseFrees).toBe(1);
    t.take("save").reply(durable());
    expect(await pending).toMatchObject({ ok: true, value: { durable: true } });
    expect(t.editor.status).toEqual({ kind: "closed" });
    expect(t.editor.snapshot().saving).toBe(false);
    expect(t.editor.saveCleanupErrors).toEqual([]); // dispose already released the pending prefix.
    expect(leaseFrees).toBe(1); // stale save finally did not free the lease twice.
  });

  it("fails closed after cleanup error so a repeated save cannot reuse the lease", async () => {
    const t = await savingSession({ initialPrefixFree: () => { throw cleanupTrap; } });
    const { pending: first } = await advanceToSave(t);
    t.take("save").reply(durable());
    expect((await first).ok).toBe(true);
    expect(t.editor.snapshot().saving).toBe(false);
    const second = await t.editor.save();
    expect(second).toMatchObject({ ok: false, error: { code: "SaveNotReady", reason: "state" } });
    expect(t.calls.some(call => call.method === "save")).toBe(false);
  });
});

describe("RHWP post-publication ownership", () => {
  const SAVED_SEQUENCE = 3;
  const counting = () => {
    const frees = { initial: 0, lease: 0 };
    return { frees, initialPrefixFree: () => { frees.initial += 1; }, leaseFree: () => { frees.lease += 1; } };
  };
  /** 백엔드가 저장을 끝낸 세션 정보를 반영할 때(applyUpdate) 한 번만 동기로 부른다. */
  const onSavedUpdate = (t: Awaited<ReturnType<typeof savingSession>>, action: () => void) => {
    let done = false;
    t.sessions.subscribe(() => {
      if (done || t.sessions.get(1)?.sequence !== SAVED_SEQUENCE) return;
      done = true;
      action();
    });
  };
  const onEditor = (t: Awaited<ReturnType<typeof savingSession>>, when: () => boolean, action: () => void) => {
    let done = false;
    t.editor.subscribe(() => {
      if (done || !when()) return;
      done = true;
      action();
    });
  };
  const failed = (t: Awaited<ReturnType<typeof savingSession>>) => t.editor.status.kind === "failed";
  const finishLoad = async (t: Awaited<ReturnType<typeof savingSession>>, loading: Promise<unknown>) => {
    t.take("load").reply(loaded(new Uint8Array([1]), 2));
    await flush();
    t.take("session").reply(ok(info({ state: "loading", sequence: 4, loadGeneration: 2 })));
    t.take("setState").reply(ok(info({ state: "ready", sequence: 5, loadGeneration: 2 })));
    await expect(loading).resolves.toEqual({ ok: true, value: null });
  };
  const durableResult = { ok: true, value: { durable: true } };

  it("case 1: dispose in the cleanup-failure notification cannot write saved into the closed session", async () => {
    const c = counting();
    const t = await savingSession({ initialPrefixFree: () => { c.initialPrefixFree(); throw cleanupTrap; }, leaseFree: c.leaseFree });
    onEditor(t, () => failed(t), () => t.editor.dispose());
    const { pending } = await advanceToSave(t);
    t.take("save").reply(durable());
    expect(await pending).toMatchObject(durableResult);
    expect(t.editor.status).toEqual({ kind: "closed" });
    expect(t.editor.saveState).toEqual({ kind: "saving" });
    expect(t.editor.snapshot().saving).toBe(false);
    expect(t.editor.saveCleanupErrors).toEqual([cleanupTrap]);
    expect(c.frees).toEqual({ initial: 1, lease: 1 });
  });

  it("case 2: dispose in the session update stops every later step on the released model", async () => {
    const c = counting();
    const t = await savingSession(c);
    const internals = t.editor as unknown as { text: { markPublishedCharShapes(count: number | null): void }; checkSerial: number };
    const mark = vi.spyOn(internals.text, "markPublishedCharShapes");
    let serialAtDispose = -1;
    onSavedUpdate(t, () => { t.editor.dispose(); serialAtDispose = internals.checkSerial; });
    const { pending } = await advanceToSave(t);
    t.take("save").reply(durable());
    expect(await pending).toMatchObject(durableResult);
    expect(t.editor.status).toEqual({ kind: "closed" });
    expect(t.editor.saveState).toEqual({ kind: "saving" });
    expect(internals.checkSerial).toBe(serialAtDispose);
    expect(mark).not.toHaveBeenCalled();
    expect(t.editor.snapshot().saving).toBe(false);
    expect(c.frees).toEqual({ initial: 1, lease: 1 });
  });

  it("case 2b: a throwing dispose in the session update cannot replace the durable result", async () => {
    const t = await savingSession({ initialPrefixFree: () => { throw cleanupTrap; } });
    onSavedUpdate(t, () => t.editor.dispose());
    const { pending } = await advanceToSave(t);
    t.take("save").reply(durable());
    await expect(pending).resolves.toMatchObject(durableResult);
    expect(t.editor.status).toEqual({ kind: "closed" });
    expect(t.editor.saveState).toEqual({ kind: "saving" });
    expect(t.editor.snapshot().saving).toBe(false);
    expect(t.editor.saveCleanupErrors).toHaveLength(1);
    expect(t.editor.saveCleanupErrors[0]).toBeInstanceOf(AggregateError);
  });

  it("a throwing dispose in the cleanup-failure notification cannot replace the durable result", async () => {
    const lease = new Error("lease cleanup");
    const t = await savingSession({ initialPrefixFree: () => { throw cleanupTrap; }, leaseFree: () => { throw lease; } });
    onEditor(t, () => failed(t), () => t.editor.dispose());
    const { pending } = await advanceToSave(t);
    t.take("save").reply(durable());
    await expect(pending).resolves.toMatchObject(durableResult);
    expect(t.editor.status).toEqual({ kind: "closed" });
    expect(t.editor.saveState).toEqual({ kind: "saving" });
    expect(t.editor.saveCleanupErrors[0]).toBe(cleanupTrap);
    expect((t.editor.saveCleanupErrors[1] as AggregateError).errors).toEqual([lease]);
    expect(t.editor.snapshot().saving).toBe(false);
  });

  it("a throwing dispose in the saved notification cannot replace the durable result", async () => {
    const lease = new Error("lease cleanup");
    const t = await savingSession({ leaseFree: () => { throw lease; } });
    onEditor(t, () => t.editor.saveState.kind === "saved", () => t.editor.dispose());
    const { pending } = await advanceToSave(t);
    t.take("save").reply(durable());
    await expect(pending).resolves.toMatchObject(durableResult);
    expect(t.editor.status).toEqual({ kind: "closed" });
    expect(t.editor.saveCleanupErrors).toHaveLength(1);
    expect((t.editor.saveCleanupErrors[0] as AggregateError).errors).toEqual([lease]);
    expect(t.editor.snapshot().saving).toBe(false);
  });

  it("a subscriber error without an ownership change is recorded and the publication still completes", async () => {
    const c = counting();
    const t = await savingSession(c);
    const listenerError = new Error("listener");
    onSavedUpdate(t, () => { throw listenerError; });
    const { pending } = await advanceToSave(t);
    t.take("save").reply(durable());
    await expect(pending).resolves.toMatchObject(durableResult);
    expect(t.editor.saveState).toEqual({ kind: "saved", revision: 0, durable: true, changedSince: false });
    expect(t.editor.saveCleanupErrors).toEqual([listenerError]);
    expect(t.editor.status.kind).toBe("ready");
    expect(t.editor.hasUncertainChanges).toBe(false);
    expect(c.frees).toEqual({ initial: 1, lease: 0 }); // 임대가 새 게시 기준으로 넘어갔다
  });

  it("case 3: a reload in the session update owns the state from that point on", async () => {
    const c = counting();
    const t = await savingSession(c);
    const internals = t.editor as unknown as { checkSerial: number; generation: number };
    let reloading!: Promise<unknown>;
    let serialAtReload = -1;
    onSavedUpdate(t, () => { reloading = t.editor.load({ discard: true }); serialAtReload = internals.checkSerial; });
    const { pending } = await advanceToSave(t);
    t.take("save").reply(durable());
    expect(await pending).toMatchObject(durableResult);
    // 새 시도가 이미 시작됐다: 옛 저장은 그 상태를 건드리지 않는다.
    expect(t.editor.status).toEqual({ kind: "loading" });
    expect(t.editor.saveState).toEqual({ kind: "idle" });
    expect(internals.checkSerial).toBe(serialAtReload);
    expect(t.editor.snapshot().saving).toBe(false);
    expect(c.frees).toEqual({ initial: 1, lease: 1 });
    await finishLoad(t, reloading);
    expect(t.editor.status).toEqual({ kind: "ready" });
    expect(t.editor.saveState).toEqual({ kind: "idle" });
    expect(t.editor.saveCheck).toBeNull();
    expect(internals.generation).toBe(2);
    expect(t.editor.hasUnpreservedChanges).toBe(false);
    expect(c.frees).toEqual({ initial: 1, lease: 1 }); // 새 문서로 옛 prefix를 넘기거나 다시 놓지 않는다
  });

  it("case 3b: a reload only requested from the failure notification leaves the old model's result until it is active", async () => {
    const t = await savingSession({ initialPrefixFree: () => { throw cleanupTrap; } });
    let reloading!: Promise<unknown>;
    onEditor(t, () => failed(t), () => { reloading = t.editor.load({ discard: true }); });
    const { pending } = await advanceToSave(t);
    t.take("save").reply(durable());
    expect(await pending).toMatchObject(durableResult);
    // load는 failed 전이를 확인할 때까지 옛 모델을 놓지 않으므로 아직 옛 세대의 표시다.
    expect((t.editor as unknown as { generation: number }).generation).toBe(1);
    expect(t.editor.saveState).toMatchObject({ kind: "saved", durable: true });
    t.take("setState").reply(ok(info({ state: "failed", sequence: 4, loadGeneration: 1 })));
    await flush();
    t.take("load").reply(loaded(new Uint8Array([1]), 2));
    await flush();
    t.take("session").reply(ok(info({ state: "loading", sequence: 5, loadGeneration: 2 })));
    t.take("setState").reply(ok(info({ state: "ready", sequence: 6, loadGeneration: 2 })));
    await expect(reloading).resolves.toEqual({ ok: true, value: null });
    expect(t.editor.saveState).toEqual({ kind: "idle" });
    expect(t.editor.status).toEqual({ kind: "ready" });
    expect(t.editor.hasUncertainChanges).toBe(false);
  });

  it("case 4: a clean durable save keeps the ordinary saved state and result", async () => {
    const c = counting();
    const t = await savingSession(c);
    const { pending } = await advanceToSave(t);
    t.take("save").reply(durable());
    expect(await pending).toMatchObject(durableResult);
    expect(t.editor.saveState).toEqual({ kind: "saved", revision: 0, durable: true, changedSince: false });
    expect(t.editor.status).toEqual({ kind: "ready" });
    expect(t.editor.saveCleanupErrors).toEqual([]);
    expect(t.editor.hasUnpreservedChanges).toBe(false);
    expect(t.editor.saveCheck).toBeNull();
    expect(c.frees).toEqual({ initial: 1, lease: 0 });
    expect(t.editor.snapshot().saving).toBe(false);
  });

  it("case 5: cleanup failure in the same session fails closed and keeps the publication result", async () => {
    const t = await savingSession({ initialPrefixFree: () => { throw cleanupTrap; } });
    const { pending } = await advanceToSave(t);
    t.take("save").reply(durable());
    expect(await pending).toMatchObject(durableResult);
    expect(t.editor.saveState).toMatchObject({ kind: "saved", durable: true });
    expect(t.editor.status).toEqual({ kind: "failed", error: { code: "EngineFailure", engine: "rhwp", stage: "edit" } });
    expect(t.editor.hasUncertainChanges).toBe(true);
    expect(t.editor.hasUnpreservedChanges).toBe(true);
    expect(t.editor.saveCleanupErrors).toEqual([cleanupTrap]);
  });

  it("case 6: a non-durable publication does not claim durability, also when disposed", async () => {
    const a = await savingSession();
    const first = await advanceToSave(a);
    a.take("save").reply(durable(false));
    expect(await first.pending).toMatchObject({ ok: true, value: { durable: false } });
    expect(a.editor.saveState).toMatchObject({ kind: "saved", durable: false });
    expect(a.editor.hasUnpreservedChanges).toBe(true);
    expect(a.sessions.get(1)?.dirty).toBe(true);

    const b = await savingSession();
    onSavedUpdate(b, () => b.editor.dispose());
    const second = await advanceToSave(b);
    b.take("save").reply(durable(false));
    expect(await second.pending).toMatchObject({ ok: true, value: { durable: false } });
    expect(b.editor.saveState).toEqual({ kind: "saving" });
  });

  it("case 7: edits made during the save stay unpreserved", async () => {
    const t = await savingSession();
    const { pending } = await advanceToSave(t);
    t.editor.typeText("after");
    t.take("save").reply(durable());
    expect(await pending).toMatchObject(durableResult);
    expect(t.editor.saveState).toEqual({ kind: "saved", revision: 0, durable: true, changedSince: true });
    expect(t.editor.hasUnpreservedChanges).toBe(true);
    expect(t.editor.localRevision).toBe(1);
  });

  it("case 8: the lease is released once and saving ends even when a later dispose throws in its cleanup notification", async () => {
    const lease = new Error("lease cleanup");
    let leaseFrees = 0;
    const t = await savingSession({
      leaseFree: () => { leaseFrees += 1; throw lease; },
      initialPrefixFree: () => { throw cleanupTrap; },
    });
    onEditor(t, () => failed(t), () => t.editor.dispose());
    const { pending } = await advanceToSave(t);
    const refusal = { code: "SaveFailure", stage: "write" } as const;
    t.take("save").reply(fail(refusal));
    await expect(pending).resolves.toEqual({ ok: false, error: refusal });
    expect(leaseFrees).toBe(1);
    expect(t.editor.snapshot().saving).toBe(false);
    expect(t.editor.status).toEqual({ kind: "closed" });
    expect(t.editor.saveCleanupErrors[0]).toBe(lease);
    expect(t.editor.saveCleanupErrors).toHaveLength(2);
  });

  it("case 9: a backend refusal does not advance the published baseline", async () => {
    const c = counting();
    const t = await savingSession(c);
    const internals = t.editor as unknown as { text: { publishedPrefix: unknown; publishingPrefix: unknown } };
    const published = internals.text.publishedPrefix;
    const { pending } = await advanceToSave(t);
    const refusal = { code: "FileConflict" } as const;
    t.take("save").reply(fail(refusal));
    await expect(pending).resolves.toEqual({ ok: false, error: refusal });
    expect(t.editor.saveState).toEqual({ kind: "failed", error: refusal });
    expect(internals.text.publishedPrefix).toBe(published);
    expect(internals.text.publishingPrefix).toBeNull();
    expect(c.frees).toEqual({ initial: 0, lease: 1 });
    expect(t.editor.status).toEqual({ kind: "ready" });
    expect(t.calls.filter(call => call.method === "save")).toEqual([]);
  });
});
