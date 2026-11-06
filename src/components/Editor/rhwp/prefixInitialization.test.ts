import { describe, expect, it } from "vitest";
import { DocumentSessions } from "../../../adapters/sessions";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
import { base, controlledBackend, fail, FakeDocument, flush, info, ok, loaded } from "./testing";
import { RhwpEditorSession } from "./RhwpEditorSession";

function trackedDocument() {
  const doc = new FakeDocument(["x"]);
  let frees = 0;
  return {
    doc,
    freeCount: () => frees,
    free: () => { frees += 1; doc.free(); },
  };
}

async function openSession(openDocument: () => RhwpDocument) {
  const { backend, take, calls } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwp");
  take("open").reply(ok(base));
  await opening;
  const editor = new RhwpEditorSession(1, backend, sessions, async () => ({ openDocument } as RhwpModule), { history: false });
  return { editor, take, calls };
}

async function failInitialLoad(
  editor: RhwpEditorSession,
  take: ReturnType<typeof controlledBackend>["take"],
  generation = 1,
) {
  const loading = editor.load();
  take("load").reply(loaded(new Uint8Array([1]), generation));
  await flush();
  take("session").reply(ok(info({ state: "loading", sequence: generation * 2 - 1, loadGeneration: generation })));
  await flush();
  const failed = take("setState");
  if (failed.args[3] === "ready") {
    // Baseline reproduction: ready is committed before construction, then the
    // thrown prefix API rejects load() outside the lifecycle error handler.
    failed.reply(ok(info({ state: "ready", sequence: generation * 2, loadGeneration: generation })));
    await loading.then(
      () => undefined,
      () => undefined,
    );
  }
  expect(failed.args).toEqual([1, generation, "loading", "failed"]);
  failed.reply(ok(info({ state: "failed", sequence: generation * 2, loadGeneration: generation })));
  await expect(loading).resolves.toMatchObject({ ok: false, error: { code: "EngineFailure", engine: "rhwp", stage: "init" } });
  expect(editor.status).toEqual({ kind: "failed", error: { code: "EngineFailure", engine: "rhwp", stage: "init" } });
  expect(editor.typeText("unsafe")).toBe(false);
  expect(editor.localRevision).toBe(0);
}

describe("RHWP initial character-shape prefix transaction", () => {
  it.each([
    ["charShapeCount throws", (doc: FakeDocument) => { Object.assign(doc, { charShapeCount: () => { throw new Error("count trap"); } }); }],
    ["captureCharShapePrefix throws", (doc: FakeDocument) => {
      Object.assign(doc, {
        charShapeCount: () => 1,
        reconcileCharShapePrefix: () => '{"ok":true}',
        captureCharShapePrefix: () => { throw new Error("capture trap"); },
      });
    }],
    ["captureCharShapePrefix returns an unusable object", (doc: FakeDocument) => {
      Object.assign(doc, {
        charShapeCount: () => 1,
        reconcileCharShapePrefix: () => '{"ok":true}',
        captureCharShapePrefix: () => ({} as never),
      });
    }],
  ])("releases a partially initialized document and permits reload when %s", async (_case, injectFailure) => {
    const broken = trackedDocument();
    injectFailure(broken.doc);
    let opens = 0;
    const healthy = new FakeDocument(["recovered"]);
    let prefixFrees = 0;
    Object.assign(healthy, {
      charShapeCount: () => 1,
      reconcileCharShapePrefix: () => '{"ok":true}',
      captureCharShapePrefix: () => ({ free() { prefixFrees += 1; } }),
    });
    const { editor, take, calls } = await openSession(() => {
      opens += 1;
      if (opens === 1) {
        const owned = Object.create(broken.doc) as FakeDocument;
        owned.free = broken.free;
        return owned as unknown as RhwpDocument;
      }
      return healthy as unknown as RhwpDocument;
    });

    await failInitialLoad(editor, take);
    expect(broken.freeCount()).toBe(1);
    expect(calls.some(call => call.method === "save" || call.method === "commit")).toBe(false);

    const reload = editor.load();
    take("load").reply(loaded(new Uint8Array([2]), 2));
    await flush();
    take("session").reply(ok(info({ state: "loading", sequence: 3, loadGeneration: 2 })));
    await flush();
    const ready = take("setState");
    expect(ready.args).toEqual([1, 2, "loading", "ready"]);
    ready.reply(ok(info({ state: "ready", sequence: 4, loadGeneration: 2 })));
    await expect(reload).resolves.toMatchObject({ ok: true });
    expect(editor.status).toEqual({ kind: "ready" });
    expect(editor.localRevision).toBe(0);
    editor.dispose();
    expect(broken.freeCount()).toBe(1);
    expect(healthy.freed).toBe(true);
    expect(prefixFrees).toBe(1);
  });
});


async function pendingReady(doc: RhwpDocument) {
  const { editor, take } = await openSession(() => doc);
  const loading = editor.load();
  take("load").reply(loaded(new Uint8Array([1]), 1));
  await flush();
  take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
  await flush();
  return { editor, loading, ready: take("setState") };
}

describe("RHWP prefix cleanup at ready boundary", () => {
  it("frees document and captured prefix once when backend rejects ready", async () => {
    let prefixFrees = 0;
    const doc = trackedDocument();
    const model = Object.create(doc.doc) as FakeDocument;
    model.free = doc.free;
    Object.assign(model, {
      charShapeCount: () => 1,
      reconcileCharShapePrefix: () => '{"ok":true}',
      captureCharShapePrefix: () => ({ free() { prefixFrees += 1; } }),
    });
    const { editor, loading, ready } = await pendingReady(model as unknown as RhwpDocument);
    expect(ready.args).toEqual([1, 1, "loading", "ready"]);
    ready.reply(fail({ code: "StaleLoad", sessionId: 1, loadGeneration: 2 }));
    await expect(loading).resolves.toMatchObject({ ok: false, error: { code: "StaleLoad" } });
    expect(doc.freeCount()).toBe(1);
    expect(prefixFrees).toBe(1);
    expect(editor.status).toMatchObject({ kind: "failed", error: { code: "StaleLoad" } });
    editor.dispose();
    expect(doc.freeCount()).toBe(1);
    expect(prefixFrees).toBe(1);
  });

  it("frees document and prefix once when the session closes while ready is pending", async () => {
    let prefixFrees = 0;
    const doc = trackedDocument();
    const model = Object.create(doc.doc) as FakeDocument;
    model.free = doc.free;
    Object.assign(model, {
      charShapeCount: () => 1,
      reconcileCharShapePrefix: () => '{"ok":true}',
      captureCharShapePrefix: () => ({ free() { prefixFrees += 1; } }),
    });
    const { editor, loading, ready } = await pendingReady(model as unknown as RhwpDocument);
    editor.dispose();
    ready.reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
    await expect(loading).resolves.toMatchObject({ ok: false, error: { code: "StaleSession" } });
    expect(editor.status).toEqual({ kind: "closed" });
    expect(doc.freeCount()).toBe(1);
    expect(prefixFrees).toBe(1);
    editor.dispose();
    expect(doc.freeCount()).toBe(1);
    expect(prefixFrees).toBe(1);
  });

  it("keeps a healthy load usable when history initialization fails after prefix capture", async () => {
    let prefixFrees = 0;
    const doc = new FakeDocument(["x"]);
    Object.assign(doc, {
      charShapeCount: () => 1,
      reconcileCharShapePrefix: () => '{"ok":true}',
      captureCharShapePrefix: () => ({ free() { prefixFrees += 1; } }),
    });
    doc.snapshotCapacity = () => { throw new Error("history initialization trap"); };
    const { backend, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const opening = sessions.open("/a.hwp");
    take("open").reply(ok(base));
    await opening;
    const editor = new RhwpEditorSession(1, backend, sessions, async () => ({
      openDocument: () => doc as unknown as RhwpDocument,
      memoryBytes: () => 64 * 1024 * 1024,
    }), { history: true });
    const loading = editor.load();
    take("load").reply(loaded());
    await flush();
    take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
    await flush();
    const ready = take("setState");
    ready.reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
    await expect(loading).resolves.toMatchObject({ ok: true });
    expect(editor.status).toEqual({ kind: "ready" });
    expect(editor.editable).toBe(true);
    expect(editor.localRevision).toBe(0);
    expect(editor.snapshot().history).toBeNull();
    expect(editor.snapshot().historyLimited).toBe(false);
    editor.dispose();
    expect(doc.freed).toBe(true);
    expect(prefixFrees).toBe(1);
  });
});
