import { afterEach, describe, expect, it } from "vitest";
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
