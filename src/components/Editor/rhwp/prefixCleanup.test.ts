import { describe, expect, it } from "vitest";
import { DocumentSessions } from "../../../adapters/sessions";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
import { base, controlledBackend, fail, FakeDocument, flush, info, ok, loaded } from "./testing";
import { RhwpEditorSession } from "./RhwpEditorSession";

function ownedDocument(options: { prefixThrows?: boolean; documentThrows?: boolean; countThrows?: boolean } = {}) {
  const model = new FakeDocument(["x"]);
  let documentFrees = 0, prefixFrees = 0;
  Object.assign(model, {
    charShapeCount: () => {
      if (options.countThrows) throw new Error("count trap");
      return 1;
    },
    reconcileCharShapePrefix: () => '{"ok":true}',
    captureCharShapePrefix: () => ({
      free() { prefixFrees += 1; if (options.prefixThrows) throw new Error("prefix free trap"); },
    }),
    free: () => { documentFrees += 1; model.freed = true; if (options.documentThrows) throw new Error("document free trap"); },
  });
  return { model, freeCounts: () => ({ document: documentFrees, prefix: prefixFrees }) };
}

async function begin(owned: ReturnType<typeof ownedDocument>) {
  const { backend, take, calls } = controlledBackend();
  const normalSetState = backend.setState.bind(backend);
  let rejectReady!: (reason: Error) => void;
  let resolveReady!: (value: Awaited<ReturnType<typeof backend.setState>>) => void;
  let readyRequests = 0;
  backend.setState = ((sessionId, generation, from, to) => {
    if (to === "ready" && readyRequests++ === 0) return new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    return normalSetState(sessionId, generation, from, to);
  }) as typeof backend.setState;
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwp");
  take("open").reply(ok(base));
  await opening;
  let openCount = 0;
  const module: RhwpModule = { openDocument: () => {
    openCount += 1;
    return openCount === 1 ? owned.model as unknown as RhwpDocument : new FakeDocument(["reloaded"]) as unknown as RhwpDocument;
  } };
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module, { history: false });
  const loading = editor.load();
  void loading.catch(() => {});
  take("load").reply(loaded(new Uint8Array([1]), 1));
  await flush();
  take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
  await flush();
  return { editor, backend, take, calls, loading, resolveReady, rejectReady };
}

async function failTransition(take: ReturnType<typeof controlledBackend>["take"], generation = 1, sequence = 2) {
  await flush();
  const failed = take("setState");
  expect(failed.args).toEqual([1, generation, "loading", "failed"]);
  failed.reply(ok(info({ state: "failed", sequence, loadGeneration: generation })));
}

describe("RHWP prefix cleanup when ready transition fails", () => {
  it("normalizes a raw ready rejection, releases once, blocks save/edit, then reloads", async () => {
    const owned = ownedDocument();
    const { editor, take, calls, loading, rejectReady } = await begin(owned);
    const resultPromise = loading.then(value => value, error => ({ thrown: error }));
    rejectReady(new Error("transport rejected"));
    await flush();
    if (calls.some(c => c.method === "setState")) await failTransition(take);
    const result = await resultPromise;
    expect(result).toMatchObject({ ok: false, error: { code: "EngineFailure", engine: "rhwp", stage: "init" } });
    expect(editor.status).toMatchObject({ kind: "failed", error: { code: "EngineFailure", engine: "rhwp", stage: "init" } });
    expect(editor.typeText("unsafe")).toBe(false);
    expect((await editor.save()).ok).toBe(false);
    expect(owned.freeCounts()).toEqual({ document: 1, prefix: 1 });

    const retry = editor.load();
    take("load").reply(loaded(new Uint8Array([2]), 2));
    await flush();
    take("session").reply(ok(info({ state: "loading", sequence: 3, loadGeneration: 2 })));
    await flush();
    const ready = take("setState");
    expect(ready.args).toEqual([1, 2, "loading", "ready"]);
    ready.reply(ok(info({ state: "ready", sequence: 4, loadGeneration: 2 })));
    await expect(retry).resolves.toMatchObject({ ok: true });
    editor.dispose();
    expect(owned.freeCounts()).toEqual({ document: 1, prefix: 1 });
  });

  it.each([
    ["prefix cleanup throws", { prefixThrows: true }],
    ["document cleanup throws", { documentThrows: true }],
    ["both cleanups throw", { prefixThrows: true, documentThrows: true }],
  ] as const)("preserves structured StaleLoad and attempts both releases when %s", async (_name, faults) => {
    const owned = ownedDocument(faults);
    const { editor, take, loading, resolveReady } = await begin(owned);
    resolveReady(fail({ code: "StaleLoad", sessionId: 1, loadGeneration: 2 }));
    await expect(loading).resolves.toMatchObject({ ok: false, error: { code: "StaleLoad", loadGeneration: 2 } });
    expect(editor.status).toMatchObject({ kind: "failed", error: { code: "StaleLoad" } });
    expect(editor.status).toMatchObject({ cleanupFailed: true });
    expect(editor.hasUncertainChanges).toBe(false); // The failed model was detached, not retained as dirty.
    expect(owned.freeCounts()).toEqual({ document: 1, prefix: 1 });
    editor.dispose();
    expect(owned.freeCounts()).toEqual({ document: 1, prefix: 1 });
    expect(take).toBeDefined();
  });

  it("keeps EngineFailure primary when raw rejection and both cleanup operations fail", async () => {
    const owned = ownedDocument({ prefixThrows: true, documentThrows: true });
    const { editor, take, calls, loading, rejectReady } = await begin(owned);
    const resultPromise = loading.then(value => value, error => ({ thrown: error }));
    rejectReady(new Error("transport rejected"));
    await flush();
    if (calls.some(c => c.method === "setState")) await failTransition(take);
    const result = await resultPromise;
    expect(result).toMatchObject({ ok: false, error: { code: "EngineFailure", engine: "rhwp", stage: "init" } });
    expect(editor.status).toMatchObject({ kind: "failed", error: { code: "EngineFailure", engine: "rhwp", stage: "init" } });
    expect(editor.status).toMatchObject({ cleanupFailed: true });
    expect(editor.hasUncertainChanges).toBe(false); // The failed model was detached, not retained as dirty.
    expect(owned.freeCounts()).toEqual({ document: 1, prefix: 1 });
    editor.dispose();
    expect(owned.freeCounts()).toEqual({ document: 1, prefix: 1 });
  });

  it("stays closed and frees local resources once when disposed before raw rejection", async () => {
    const owned = ownedDocument();
    const { editor, loading, rejectReady } = await begin(owned);
    const resultPromise = loading.then(value => value, error => ({ thrown: error }));
    editor.dispose();
    rejectReady(new Error("late transport rejection"));
    expect(await resultPromise).toMatchObject({ ok: false, error: { code: "StaleSession", sessionId: 1 } });
    expect(editor.status).toEqual({ kind: "closed" });
    expect(owned.freeCounts()).toEqual({ document: 1, prefix: 1 });
    editor.dispose();
    expect(owned.freeCounts()).toEqual({ document: 1, prefix: 1 });
  });

  it("normalizes count initialization failure even when document cleanup throws", async () => {
    const owned = ownedDocument({ countThrows: true, documentThrows: true });
    const { editor, take, loading } = await begin(owned);
    await failTransition(take);
    await expect(loading).resolves.toMatchObject({ ok: false, error: { code: "EngineFailure", engine: "rhwp", stage: "init" } });
    expect(editor.status).toMatchObject({ kind: "failed", error: { code: "EngineFailure", engine: "rhwp", stage: "init" } });
    expect(editor.status).toMatchObject({ cleanupFailed: true });
    expect(editor.hasUncertainChanges).toBe(false); // The failed model was detached, not retained as dirty.
    expect(owned.freeCounts()).toEqual({ document: 1, prefix: 0 });
    editor.dispose();
    expect(owned.freeCounts()).toEqual({ document: 1, prefix: 0 });
  });
  it("retains a page initialization error when document cleanup also throws", async () => {
    const owned = ownedDocument({ documentThrows: true });
    owned.model.getPageInfo = () => { throw new Error("page info trap"); };
    const { editor, take, calls, loading } = await begin(owned);
    const outcome = loading.then(value => value, error => ({ thrown: error }));
    if (calls.some(call => call.method === "setState")) await failTransition(take);
    expect(await outcome).toMatchObject({ ok: false, error: { code: "EngineFailure", stage: "render" } });
    expect(editor.status).toMatchObject({ kind: "failed", cleanupFailed: true });
    expect(owned.freeCounts()).toEqual({ document: 1, prefix: 0 });
    expect(editor.typeText("unsafe")).toBe(false);
    editor.dispose();
    expect(owned.freeCounts()).toEqual({ document: 1, prefix: 0 });
  });

});
