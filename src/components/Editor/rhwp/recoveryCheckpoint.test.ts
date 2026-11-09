// T014 B: automatic recovery checkpoints of RHWP (HWP/HWPX) sessions. The fake backend imitates the Rust contract
// (document_checkpoint validates like a save and writes only a private record; dirty/original never change). Real
// validation and record publication are covered by src-tauri/src/services/save/tests.rs (rhwp_checkpoint).
import { act, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentBackend } from "../../../adapters/backend";
import type { DocumentError, Result, SaveOutcome, SessionInfo } from "../../../adapters/contract";
import { DocumentSessions } from "../../../adapters/sessions";
import { LanguageProvider } from "../../../language/LanguageContext";
import { DocumentWorkspace } from "../documentWorkspace";
import { documentErrorMessage } from "../Editor";
import type { FilePort } from "../filePort";
import { RecoveryCenter } from "../RecoveryCenter";
import type { RecoveryCandidate, RecoveryPort } from "../recoveryPort";
import { RhwpEditorSession } from "./RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "./rhwpModule";
import { FakeDocument, ok } from "./testing";

type Call = { method: string; args: unknown[] };
const SAFE = { preservation: { outcome: "safe" as const, findings: [] }, platformSupported: true };

/** Auto-replying RHWP backend; `checkpointReply` decides each document_checkpoint response (may stay pending). */
function autoBackend(format: "hwp" | "hwpx" = "hwp") {
  const calls: Call[] = [];
  let info: SessionInfo = {
    sessionId: 1, format, engine: "rhwp", revision: 0, state: "identified", displayName: `a.${format}`,
    dirty: false, sequence: 0, loadGeneration: 0,
  };
  let generation = 0;
  const bump = (patch: Partial<SessionInfo>) => {
    info = { ...info, ...patch, sequence: info.sequence + 1 };
    return info;
  };
  const control = {
    calls,
    preflight: SAFE as unknown,
    checkpointReply: null as null | ((args: unknown[]) => Promise<Result<SaveOutcome>>),
    saveReply: null as null | ((args: unknown[]) => Promise<Result<SaveOutcome>>),
    current: () => info,
  };
  const record = (method: string, args: unknown[]) => calls.push({ method, args });
  const backend: DocumentBackend = {
    open: async (path) => { record("open", [path]); return ok(bump({})); },
    close: async () => ok({ sessionId: 1, closed: true } as never),
    session: async () => ok(info),
    sessions: async () => ok([info]),
    load: async () => { generation += 1; record("load", []); bump({ state: "loading", loadGeneration: generation, revision: 0, dirty: false }); return ok({ generation, bytes: new Uint8Array([1]) }); },
    setState: async (_id, _generation, _from, to) => ok(bump({ state: to })),
    commit: async (_id, _generation, base, count) => { record("commit", [base, count]); return ok(bump({ revision: base + count, dirty: true })); },
    original: async () => { record("original", []); return ok(new Uint8Array([1])); },
    preflight: async () => { record("preflight", []); return ok(control.preflight as typeof SAFE); },
    save: async (...args) => {
      record("save", args.slice(0, 3));
      if (control.saveReply) return control.saveReply(args);
      return ok({ session: bump({ dirty: false }), bytes: 1, durable: true });
    },
    checkpoint: async (...args) => {
      record("checkpoint", args);
      if (control.checkpointReply) return control.checkpointReply(args);
      const [, gen, revision] = args;
      return ok({ session: { ...info, loadGeneration: gen, revision }, bytes: (args[3] as Uint8Array).length, durable: true });
    },
  };
  return { backend, control };
}

function moduleFor(format: "hwp" | "hwpx" = "hwp", text = ["가나다", "abc"]) {
  const docs: FakeDocument[] = [];
  const module: RhwpModule = {
    openDocument: (bytes: Uint8Array) => {
      // The first open is the editing model; later opens are preflight originals and reopened exports.
      const exported = bytes.length > 4 && (bytes[0] === 0xd0 || bytes[0] === 0x50);
      const doc = new FakeDocument(exported ? new TextDecoder().decode(bytes.subarray(bytes[0] === 0xd0 ? 8 : 4)).split("\n") : text);
      doc.format = format;
      docs.push(doc);
      return doc as unknown as RhwpDocument;
    },
  };
  return { module, docs };
}

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

async function readyEditor(format: "hwp" | "hwpx" = "hwp") {
  const { backend, control } = autoBackend(format);
  const sessions = new DocumentSessions(backend);
  await sessions.open(`/docs/a.${format}`);
  const { module, docs } = moduleFor(format);
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module);
  expect((await editor.load()).ok).toBe(true);
  return { editor, sessions, control, docs, backend };
}

const of = (calls: Call[], method: string) => calls.filter((call) => call.method === method);

describe("RHWP recovery checkpoint (editor session)", () => {
  it.each(["hwp", "hwpx"] as const)("captures the committed %s revision with save evidence but never acts like a save", async (format) => {
    const t = await readyEditor(format);
    t.editor.typeText("x");
    await tick();
    expect(t.sessions.get(1)).toMatchObject({ revision: 1, dirty: true });
    const result = await t.editor.checkpoint(1);
    expect(result.ok).toBe(true);
    const [call] = of(t.control.calls, "checkpoint");
    expect(call!.args.slice(0, 3)).toEqual([1, 1, 1]);
    const bytes = call!.args[3] as Uint8Array;
    expect([...bytes.subarray(0, 4)]).toEqual(format === "hwp" ? [0xd0, 0xcf, 0x11, 0xe0] : [0x50, 0x4b, 0x03, 0x04]);
    expect(new TextDecoder().decode(bytes.subarray(format === "hwp" ? 8 : 4))).toBe("x가나다\nabc");
    expect(call!.args[4]).toEqual({ count: 0, losses: [] });
    expect(call!.args[5]).toEqual({ formatEqual: true, pagesEqual: true, textEqual: true, controlsEqual: true });
    // No publication, no saved state, dirty and unpreserved edits remain.
    expect(of(t.control.calls, "save")).toHaveLength(0);
    expect(t.editor.saveState).toEqual({ kind: "idle" });
    expect(t.sessions.get(1)?.dirty).toBe(true);
    expect(t.editor.hasUnpreservedChanges).toBe(true);
    // The preflight is reused by a later checkpoint and by the explicit save.
    expect(of(t.control.calls, "preflight")).toHaveLength(1);
    expect((await t.editor.save()).ok).toBe(true);
    expect(of(t.control.calls, "preflight")).toHaveLength(1);
  });

  it("does not capture composing, pending, uncertain or stale-revision models", async () => {
    const t = await readyEditor();
    t.editor.typeText("x");
    expect(await t.editor.checkpoint(0)).toEqual({ ok: false, error: { code: "SaveNotReady", reason: "pending" } });
    await tick();
    t.editor.beginComposition();
    t.editor.updateComposition("ㄱ");
    expect(await t.editor.checkpoint(1)).toEqual({ ok: false, error: { code: "SaveNotReady", reason: "composing" } });
    t.editor.endComposition("가");
    await tick();
    expect(await t.editor.checkpoint(1)).toEqual({ ok: false, error: { code: "RevisionMismatch", sessionId: 1, revision: 2 } });
    expect(of(t.control.calls, "checkpoint")).toHaveLength(0);
    expect(of(t.control.calls, "original")).toHaveLength(0);
  });

  it("rechecks after the preflight await: an edit committed meanwhile is not captured as the old revision", async () => {
    const t = await readyEditor();
    t.editor.typeText("x");
    await tick();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = t.backend.original;
    t.backend.original = async (...args) => { await gate; return original(...args); };
    const capturing = t.editor.checkpoint(1);
    t.editor.typeText("y");
    await tick();
    release();
    expect(await capturing).toEqual({ ok: false, error: { code: "RevisionMismatch", sessionId: 1, revision: 2 } });
    expect(of(t.control.calls, "checkpoint")).toHaveLength(0);
  });

  it.each([
    ["unsafe", { preservation: { outcome: "unsafe", findings: [{ code: "previewStale", part: "PrvImage" }] }, platformSupported: true }],
    ["platform", { preservation: { outcome: "safe", findings: [] }, platformSupported: false }],
  ] as const)("refuses a %s preflight without sending an export", async (_, preflight) => {
    const t = await readyEditor();
    t.control.preflight = preflight;
    t.editor.typeText("x");
    await tick();
    const result = await t.editor.checkpoint(1);
    expect(result.ok).toBe(false);
    expect(["UnsafeSave", "SaveUnsupported"]).toContain((result as { error: DocumentError }).error.code);
    expect(of(t.control.calls, "checkpoint")).toHaveLength(0);
    expect(t.sessions.get(1)?.dirty).toBe(true);
  });

  it("rejects a failed export instead of sending partial bytes", async () => {
    const t = await readyEditor();
    t.editor.typeText("x");
    await tick();
    expect((await t.editor.checkSave()).ok).toBe(true);
    const doc = t.docs[0]!;
    doc.exportHwpWithReport = () => { throw new Error("wasm export"); };
    expect(await t.editor.checkpoint(1)).toEqual({ ok: false, error: { code: "SaveFailure", stage: "export" } });
    expect(of(t.control.calls, "checkpoint")).toHaveLength(0);
  });

  it("a late response after reload or close is reported stale, never as this model's checkpoint", async () => {
    const t = await readyEditor();
    t.editor.typeText("x");
    await tick();
    let respond!: (value: Result<SaveOutcome>) => void;
    t.control.checkpointReply = () => new Promise((resolve) => { respond = resolve; });
    const capturing = t.editor.checkpoint(1);
    await tick();
    expect(of(t.control.calls, "checkpoint")).toHaveLength(1);
    const reloading = t.editor.load({ discard: true });
    await tick();
    respond(ok({ session: { ...t.control.current(), loadGeneration: 1, revision: 1 }, bytes: 1, durable: true }));
    expect(await capturing).toEqual({ ok: false, error: { code: "StaleSession", sessionId: 1 } });
    await reloading;
    // Close (dispose) during capture.
    t.editor.typeText("z");
    await tick();
    t.control.checkpointReply = () => new Promise((resolve) => { respond = resolve; });
    const second = t.editor.checkpoint(t.editor.snapshot().revision);
    await tick();
    t.editor.dispose();
    respond(ok({ session: t.control.current(), bytes: 1, durable: true }));
    expect(await second).toEqual({ ok: false, error: { code: "StaleSession", sessionId: 1 } });
  });

  it("an explicit save started during a checkpoint waits for it, then saves normally", async () => {
    const t = await readyEditor();
    t.editor.typeText("x");
    await tick();
    let respond!: (value: Result<SaveOutcome>) => void;
    t.control.checkpointReply = () => new Promise((resolve) => { respond = resolve; });
    const capturing = t.editor.checkpoint(1);
    await tick();
    const saving = t.editor.save();
    await tick();
    expect(of(t.control.calls, "save")).toHaveLength(0);
    respond(ok({ session: { ...t.control.current(), revision: 1 }, bytes: 1, durable: true }));
    expect((await capturing).ok).toBe(true);
    expect((await saving).ok).toBe(true);
    expect(of(t.control.calls, "save")).toHaveLength(1);
    expect(t.sessions.get(1)?.dirty).toBe(false);
  });
});

describe("RHWP recovery checkpoint (workspace scheduling)", () => {
  afterEach(() => { vi.useRealTimers(); });

  async function workspace(format: "hwp" | "hwpx" = "hwp") {
    vi.useFakeTimers();
    const { backend, control } = autoBackend(format);
    const sessions = new DocumentSessions(backend);
    const { module } = moduleFor(format);
    const recoveryPort: RecoveryPort = {
      list: async () => ok([]),
      restore: async () => ({ ok: false, error: { code: "Protocol" } }),
      discard: async () => ok(null),
      forgetSession: async () => ok(null),
    };
    const space = new DocumentWorkspace(sessions, backend, async () => module, undefined, undefined, undefined, undefined, recoveryPort);
    await space.open(`/docs/a.${format}`);
    await vi.advanceTimersByTimeAsync(0);
    const editor = space.editorFor(1)!;
    await editor.load();
    return { space, sessions, control, editor };
  }

  const status = (space: DocumentWorkspace) => space.recoveryCheckpointStatuses[0];

  it.each(["hwp", "hwpx"] as const)("debounces a dirty %s revision and reports protected only after the durable response", async (format) => {
    const w = await workspace(format);
    w.editor.typeText("x");
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(status(w.space)).toMatchObject({ kind: "waiting", revision: 1 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(of(w.control.calls, "checkpoint")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(of(w.control.calls, "checkpoint").map((call) => call.args.slice(0, 3))).toEqual([[1, w.editor.checkpointState().loadGeneration, 1]]);
    expect(status(w.space)).toMatchObject({ kind: "protected", revision: 1 });
    expect(w.sessions.get(1)?.dirty).toBe(true);
    // A newer edit is not claimed protected by the older record.
    w.editor.typeText("y");
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(status(w.space)).toMatchObject({ kind: "waiting", revision: 2 });
  });

  it("waits for IME composition to settle before scheduling", async () => {
    const w = await workspace();
    w.editor.typeText("x");
    await vi.advanceTimersByTimeAsync(0);
    w.editor.beginComposition();
    w.editor.updateComposition("ㅎ");
    await vi.advanceTimersByTimeAsync(5000);
    expect(of(w.control.calls, "checkpoint")).toHaveLength(0);
    w.editor.endComposition("한");
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(of(w.control.calls, "checkpoint").map((call) => call.args[2])).toEqual([2]);
  });

  it("an unsafe revision is shown as unsupported and is not retried automatically; a failure stays retryable", async () => {
    const w = await workspace();
    w.control.preflight = { preservation: { outcome: "unknown", findings: [{ code: "recordUnknown", part: "BodyText/Section0" }] }, platformSupported: true };
    w.editor.typeText("x");
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(status(w.space)).toMatchObject({ kind: "unsupported", revision: 1, error: { code: "UnsafeSave" } });
    await vi.advanceTimersByTimeAsync(10000);
    expect(of(w.control.calls, "preflight")).toHaveLength(1);
    // Backend record failure (e.g. unconfirmed directory fsync) is a retryable failure, not protection.
    // The verdict belongs to the source, not the revision: only a fresh preflight can change it.
    w.control.preflight = SAFE;
    expect((await w.editor.checkSave()).ok).toBe(true);
    w.control.checkpointReply = async () => ({ ok: false, error: { code: "SaveFailure", stage: "write" } });
    w.editor.typeText("y");
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(status(w.space)).toMatchObject({ kind: "failed", revision: 2 });
    w.control.checkpointReply = null;
    await w.space.retryRecoveryCheckpoint(1);
    expect(status(w.space)).toMatchObject({ kind: "protected", revision: 2 });
  });

  /** Hold the explicit save until `finish` resolves it with the outcome built from the then-current info. */
  function heldSave(w: Awaited<ReturnType<typeof workspace>>) {
    let finish!: (outcome: (info: SessionInfo) => Result<SaveOutcome>) => void;
    // The outcome carries a newer sequence, as the backend's would (older sequences are ignored by sessions).
    w.control.saveReply = () => new Promise((resolve) => {
      finish = (make) => { const info = w.control.current(); resolve(make({ ...info, sequence: info.sequence + 1 })); };
    });
    return (make: (info: SessionInfo) => Result<SaveOutcome>) => finish(make);
  }

  it("resumes scheduling for edits committed during a save once the save ends (no further edit needed)", async () => {
    const w = await workspace();
    w.editor.typeText("x");
    await vi.advanceTimersByTimeAsync(0);
    const finish = heldSave(w);
    const saving = w.editor.save();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(of(w.control.calls, "save")).toHaveLength(1);
    w.editor.typeText("y"); // revision 2 committed while saving
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(w.editor.checkpointState()).toMatchObject({ saving: true, revision: 2 });
    // Save of revision 1 publishes durably; revision 2 stays dirty.
    finish((info) => ok({ session: { ...info, revision: 2, dirty: true }, bytes: 1, durable: true }));
    expect((await saving).ok).toBe(true);
    await flush();
    expect(w.sessions.get(1)?.dirty).toBe(true);
    expect(status(w.space)).toMatchObject({ kind: "waiting", revision: 2 });
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(of(w.control.calls, "checkpoint").map((call) => call.args[2])).toEqual([2]);
    expect(status(w.space)).toMatchObject({ kind: "protected", revision: 2 });
  });

  it.each([
    ["failed", (): Result<SaveOutcome> => ({ ok: false, error: { code: "FileConflict" } }), true],
    ["unconfirmed", (info: SessionInfo): Result<SaveOutcome> => ok({ session: { ...info, dirty: true }, bytes: 1, durable: false }), true],
    ["durable clean", (info: SessionInfo): Result<SaveOutcome> => ok({ session: { ...info, dirty: false }, bytes: 1, durable: true }), false],
  ] as const)("after a %s save the remaining state is re-evaluated without another edit", async (_, make, dirty) => {
    const w = await workspace();
    w.editor.typeText("x");
    await vi.advanceTimersByTimeAsync(0);
    const finish = heldSave(w);
    const saving = w.editor.save();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    finish(make);
    await saving;
    await flush();
    expect(w.sessions.get(1)?.dirty).toBe(dirty);
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    if (dirty) {
      expect(of(w.control.calls, "checkpoint").map((call) => call.args[2])).toEqual([1]);
      expect(status(w.space)).toMatchObject({ kind: "protected", revision: 1 });
    } else {
      expect(of(w.control.calls, "checkpoint")).toHaveLength(0);
      expect(w.space.recoveryCheckpointStatuses).toEqual([]);
    }
  });

  it("a save interrupted by close never schedules a checkpoint for the disposed editor", async () => {
    const w = await workspace();
    w.editor.typeText("x");
    await vi.advanceTimersByTimeAsync(0);
    const finish = heldSave(w);
    const saving = w.editor.save();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    await w.space.close(1, { discard: true });
    finish((info) => ok({ session: { ...info, dirty: true }, bytes: 1, durable: false }));
    await saving;
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(of(w.control.calls, "checkpoint")).toHaveLength(0);
    expect(w.space.recoveryCheckpointStatuses).toEqual([]);
  });

  it("closing the session during a capture drops its status and ignores the late result", async () => {
    const w = await workspace();
    let respond!: (value: Result<SaveOutcome>) => void;
    w.control.checkpointReply = () => new Promise((resolve) => { respond = resolve; });
    w.editor.typeText("x");
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(status(w.space)).toMatchObject({ kind: "capturing", revision: 1 });
    const closing = w.space.close(1, { discard: true });
    await vi.advanceTimersByTimeAsync(0);
    await closing;
    expect(w.space.recoveryCheckpointStatuses).toEqual([]);
    respond(ok({ session: w.control.current(), bytes: 1, durable: true }));
    await flush();
    expect(w.space.recoveryCheckpointStatuses).toEqual([]);
  });
});

describe("RHWP recovery restore and status presentation", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("restores an HWPX candidate only to a new chosen destination and opens it with the RHWP engine", async () => {
    const { backend, control } = autoBackend("hwpx");
    const sessions = new DocumentSessions(backend);
    const { module } = moduleFor("hwpx");
    const candidate: RecoveryCandidate = { id: `${"a".repeat(32)}.recovery`, valid: true, name: "a.hwpx", revision: 3, format: "hwpx", createdAt: 1, stale: false };
    let destination = "/docs/existing.hwpx";
    const chooseFile = vi.fn(async () => ({ ok: true as const, value: destination }));
    const filePort: FilePort = { chooseFile, createDocument: async () => ({ ok: false, error: { code: "Protocol" } }) };
    const restore = vi.fn(async (_id: string, path: string) =>
      path === "/docs/existing.hwpx" ? ({ ok: false, error: { code: "FileConflict" } } as const) : ok(path));
    const recoveryPort: RecoveryPort = { list: async () => ok([candidate]), restore, discard: async () => ok(null), forgetSession: async () => ok(null) };
    const space = new DocumentWorkspace(sessions, backend, async () => module, undefined, undefined, undefined, filePort, recoveryPort);
    const text = { title: "복구", accept: "저장", cancel: "취소" };
    // Existing destination: refused by create-only publication, nothing opened, candidate untouched.
    expect(await space.restoreRecovery(candidate, text)).toEqual({ ok: false, error: { code: "FileConflict" } });
    expect(chooseFile).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "save", format: "hwpx" }));
    expect(of(control.calls, "open")).toHaveLength(0);
    destination = "/docs/restored.hwpx";
    const restored = await space.restoreRecovery(candidate, text);
    expect(restored?.ok).toBe(true);
    expect(restore).toHaveBeenLastCalledWith(candidate.id, "/docs/restored.hwpx");
    expect(of(control.calls, "open").map((call) => call.args)).toEqual([["/docs/restored.hwpx"]]);
    const editor = space.editorFor(1);
    expect(editor).toBeInstanceOf(RhwpEditorSession);
    await tick();
    expect(editor!.status.kind).toBe("ready");
    expect(editor!.documentText()).toBe("가나다\r\nabc");
  });

  it.each(["ko", "en"] as const)("shows an unsupported RHWP revision without a retry button (%s)", async (language) => {
    vi.useFakeTimers();
    const { backend, control } = autoBackend("hwp");
    control.preflight = { preservation: { outcome: "unknown", findings: [{ code: "recordUnknown", part: "BodyText/Section0" }] }, platformSupported: true };
    const sessions = new DocumentSessions(backend);
    const { module } = moduleFor("hwp");
    const recoveryPort: RecoveryPort = { list: async () => ok([]), restore: async () => ({ ok: false, error: { code: "Protocol" } }), discard: async () => ok(null), forgetSession: async () => ok(null) };
    const space = new DocumentWorkspace(sessions, backend, async () => module, undefined, undefined, undefined, undefined, recoveryPort);
    await space.open("/docs/a.hwp");
    await vi.advanceTimersByTimeAsync(0);
    const view = render(createElement(LanguageProvider, {
      language, onLanguageChange: () => {},
      children: createElement(RecoveryCenter, { workspace: space, errorMessage: documentErrorMessage }),
    }));
    await act(async () => {
      space.editorFor(1)!.typeText("x");
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
    });
    const row = view.getByTestId("recovery-checkpoint-1");
    expect(row.dataset).toMatchObject({ state: "unsupported", revision: "1" });
    expect(row.textContent).toContain(language === "ko" ? "보존 검사를 통과하지 못해" : "preservation checks did not pass");
    expect(view.queryByTestId("recovery-retry-1")).toBeNull();
    view.unmount();
  });
});
