// Recovery restore while a native window-close decision is pending (frontend simulation with controlled
// IPC ordering). Rust publishes the restore destination before the separate document_open; here both
// ports are deferred so each linearization point can be ordered explicitly.
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentBackend } from "../../adapters/backend";
import type { DocumentError, Result, SessionInfo } from "../../adapters/contract";
import { DocumentSessions } from "../../adapters/sessions";
import { createTranslator } from "../../language";
import { LanguageProvider } from "../../language/LanguageContext";
import { DocumentWorkspace } from "./documentWorkspace";
import { documentErrorMessage, Editor } from "./Editor";
import type { FilePort } from "./filePort";
import type { RecoveryCandidate } from "./recoveryPort";
import { DocxEditorSession } from "./wordcraft/DocxEditorSession";
import { FakeDocx } from "./wordcraft/testing";

const text = { title: "Restore", accept: "Restore", cancel: "Cancel" };
const candidate: RecoveryCandidate = { id: "r1", valid: true, name: "a.docx", revision: 1, format: "docx", createdAt: 1, stale: false };
const info: SessionInfo = { sessionId: 7, format: "docx", engine: "wordcraft", state: "identified", revision: 0, sequence: 0,
  loadGeneration: 0, dirty: false, displayName: "restored.docx" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(reply => { resolve = reply; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

let unmount: (() => void) | undefined;
afterEach(() => { unmount?.(); unmount = undefined; vi.restoreAllMocks(); });

function setup() {
  vi.spyOn(DocxEditorSession.prototype, "load").mockResolvedValue({ ok: true, value: null });
  const opened = deferred<Result<SessionInfo>>();
  const backend = { close: vi.fn(), open: vi.fn(() => opened.promise) } as unknown as DocumentBackend;
  const restored = deferred<Result<string>>();
  const files: FilePort = { chooseFile: vi.fn(async () => ({ ok: true as const, value: "/docs/restored.docx" })), createDocument: vi.fn() };
  const recovery = { list: vi.fn(async () => ({ ok: true as const, value: [] })), restore: vi.fn(() => restored.promise),
    discard: vi.fn(), forgetSession: vi.fn() };
  let request = () => {};
  const windowClose = { listen: vi.fn(async (handler: () => void) => { request = handler; return () => {}; }), close: vi.fn(async () => {}) };
  const sessions = new DocumentSessions(backend);
  const workspace = new DocumentWorkspace(sessions, backend, async () => ({ openDocument: vi.fn() }), windowClose, new FakeDocx(), undefined, files, recovery);
  const view = render(<LanguageProvider language="ko" onLanguageChange={() => {}}><Editor workspace={workspace} zoom={100} /></LanguageProvider>);
  unmount = () => view.unmount();
  return { backend, recovery, windowClose, sessions, workspace, view, opened, restored, request: () => request() };
}

/** Restore is pending in Rust when the native close request arrives. */
async function closeDuringRestore() {
  const t = setup();
  await act(flush);
  const restoring = t.workspace.restoreRecovery(candidate, text);
  await act(flush);
  expect(t.recovery.restore).toHaveBeenCalledWith("r1", "/docs/restored.docx");
  act(() => t.request());
  await act(flush);
  expect(t.workspace.fileBusy).toBe(true);
  return { t, restoring };
}

describe("recovery restore during window close", () => {
  it("a published restore whose open fails is reported as a created-but-unopened file and keeps the window", async () => {
    const { t, restoring } = await closeDuringRestore();
    t.restored.resolve({ ok: true, value: "/docs/restored.docx" }); // destination published (durable)
    await act(flush);
    expect(t.backend.open).toHaveBeenCalledWith("/docs/restored.docx");
    const capacity: DocumentError = { code: "ResourceLimit", limit: "session-count" };
    t.opened.resolve({ ok: false, error: capacity });
    await act(flush);
    // The open failure keeps its meaning as the cause; the result also says a file now exists.
    expect(await restoring).toEqual({ ok: false, error: { code: "RestoredUnopened", cause: capacity } });
    expect(t.sessions.snapshot().sessions).toEqual([]);
    expect(t.workspace.publicationNoticeCount).toBe(1);
    expect(t.windowClose.close).not.toHaveBeenCalled();
    expect(t.workspace.fileBusy).toBe(false);
    expect(t.view.queryByRole("alertdialog")).toBeNull();
    // The private candidate is never consumed or discarded by this path.
    expect(t.recovery.discard).not.toHaveBeenCalled();
    // A later close request (the notice has been shown) closes once; repeated requests stay single.
    act(() => { t.request(); t.request(); });
    await act(flush);
    expect(t.windowClose.close).toHaveBeenCalledTimes(1);
  });

  it("explains the created file and the open failure together", () => {
    const translate = createTranslator("ko");
    const message = documentErrorMessage({ code: "RestoredUnopened", cause: { code: "ResourceLimit", limit: "session-count" } });
    const rendered = translate(message.key, message.vars);
    expect(rendered).toContain(translate("document.error.ResourceLimit"));
    expect(rendered).toMatch(/만들어졌/);
  });

  it("negative control: restore and open both succeed during close; the session is owned and the window closes", async () => {
    const { t, restoring } = await closeDuringRestore();
    t.restored.resolve({ ok: true, value: "/docs/restored.docx" });
    await act(flush);
    t.opened.resolve({ ok: true, value: info });
    await act(flush);
    expect(await restoring).toEqual({ ok: true, value: info });
    expect(t.sessions.get(7)).toMatchObject({ dirty: false });
    expect(t.workspace.publicationNoticeCount).toBe(0);
    expect(t.windowClose.close).toHaveBeenCalledTimes(1);
  });

  it("negative control: a restore refused before publication creates nothing and does not block closing", async () => {
    const { t, restoring } = await closeDuringRestore();
    t.restored.resolve({ ok: false, error: { code: "FileConflict" } });
    await act(flush);
    expect(await restoring).toEqual({ ok: false, error: { code: "FileConflict" } });
    expect(t.backend.open).not.toHaveBeenCalled();
    expect(t.workspace.publicationNoticeCount).toBe(0);
    expect(t.windowClose.close).toHaveBeenCalledTimes(1);
  });

  it("outside closing, a published restore whose open fails is still reported as created-but-unopened", async () => {
    const t = setup();
    await act(flush);
    const restoring = t.workspace.restoreRecovery(candidate, text);
    t.restored.resolve({ ok: true, value: "/docs/restored.docx" });
    await act(flush);
    t.opened.resolve({ ok: false, error: { code: "Unreadable", reason: "permission-denied" } });
    expect(await restoring).toEqual({ ok: false, error: { code: "RestoredUnopened", cause: { code: "Unreadable", reason: "permission-denied" } } });
    expect(t.windowClose.close).not.toHaveBeenCalled();
  });
});
