// Window close while New is in flight (frontend simulation). The backend responses here are controlled
// SessionInfo values: `dirty: true` stands in for a durability-unconfirmed publication. Real directory
// fsync failure injection is Rust-only (services::files tests, Fault::DirSync) and is separate evidence.
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentBackend } from "../../adapters/backend";
import type { DocumentFormat, Result, SessionInfo } from "../../adapters/contract";
import { DocumentSessions } from "../../adapters/sessions";
import { LanguageProvider } from "../../language/LanguageContext";
import { DocumentWorkspace } from "./documentWorkspace";
import { Editor } from "./Editor";
import type { FilePort } from "./filePort";
import { RhwpEditorSession } from "./rhwp/RhwpEditorSession";

vi.mock("./rhwp/createBlank", () => ({ createRhwpBlank: vi.fn(() => ({ bytes: new Uint8Array([1]), contentLoss: {} })) }));

const text = { title: "New", accept: "Create", cancel: "Cancel" };
const info = (patch: Partial<SessionInfo> = {}): SessionInfo => ({ sessionId: 1, format: "hwp", engine: "rhwp",
  state: "identified", revision: 0, sequence: 0, loadGeneration: 0, dirty: false, displayName: "new.hwp", ...patch });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(reply => { resolve = reply; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

function setup() {
  const backend = { close: vi.fn(async (sessionId: number) => ({ ok: true, value: { sessionId, alreadyClosed: false } })) } as unknown as DocumentBackend;
  const publication = deferred<Result<SessionInfo>>();
  const chooser = deferred<Result<string | null>>();
  const files: FilePort = {
    chooseFile: vi.fn(() => chooser.promise),
    createDocument: vi.fn(() => publication.promise),
  };
  let request = () => {};
  const windowClose = { listen: vi.fn(async (handler: () => void) => { request = handler; return () => {}; }), close: vi.fn(async () => {}) };
  const sessions = new DocumentSessions(backend);
  const workspace = new DocumentWorkspace(sessions, backend, async () => ({ openDocument: vi.fn(), createEmptyDocument: vi.fn() }), windowClose, undefined, undefined, files);
  const notify = vi.fn();
  const view = render(<LanguageProvider language="ko" onLanguageChange={() => {}}><Editor workspace={workspace} zoom={100} notify={notify} /></LanguageProvider>);
  const creating = (format: DocumentFormat = "hwp") => workspace.newDocument(text, async () => format);
  return { backend, files, publication, chooser, windowClose, sessions, workspace, notify, view, creating, request: () => request() };
}

let current: ReturnType<typeof setup> | undefined;
beforeEach(() => { vi.spyOn(RhwpEditorSession.prototype, "load").mockResolvedValue({ ok: true, value: null }); });
afterEach(() => { current?.view.unmount(); current = undefined; vi.restoreAllMocks(); });

/** New is past the chooser and its publication is pending when the native close request arrives. */
async function closeDuringPublication() {
  const t = current = setup();
  await act(flush);
  const creating = t.creating();
  t.chooser.resolve({ ok: true, value: "/docs/new.hwp" });
  await act(flush);
  expect(t.files.createDocument).toHaveBeenCalledTimes(1);
  act(() => t.request());
  await act(flush);
  expect(t.workspace.fileBusy).toBe(true);
  expect(t.windowClose.close).not.toHaveBeenCalled();
  return { t, creating };
}

describe("window close with an in-flight New", () => {
  it("1. a close request before publication starts cancels New and destroys the window without publishing", async () => {
    const t = current = setup();
    await act(flush);
    const creating = t.creating();
    await act(flush);
    act(() => t.request());
    t.chooser.resolve({ ok: true, value: "/docs/new.hwp" });
    await act(flush);
    expect(await creating).toBeNull();
    expect(t.files.createDocument).not.toHaveBeenCalled();
    expect(t.windowClose.close).toHaveBeenCalledTimes(1);
  });

  it("3. a durable publication during close is owned as a clean tab and the window closes once", async () => {
    const { t, creating } = await closeDuringPublication();
    t.publication.resolve({ ok: true, value: info() });
    await act(flush);
    expect(await creating).toEqual({ ok: true, value: info() });
    expect(t.sessions.get(1)).toMatchObject({ dirty: false });
    expect(t.windowClose.close).toHaveBeenCalledTimes(1);
    expect(t.backend.close).not.toHaveBeenCalled();
    expect(t.view.queryByRole("alertdialog")).toBeNull();
  });

  it("4. a durability-unconfirmed publication during close aborts the stale decision and asks again", async () => {
    const { t, creating } = await closeDuringPublication();
    t.publication.resolve({ ok: true, value: info({ dirty: true }) });
    await act(flush);
    expect(await creating).toEqual({ ok: true, value: info({ dirty: true }) });
    // The window must not be destroyed on the decision made before this publication existed.
    expect(t.windowClose.close).not.toHaveBeenCalled();
    expect(t.backend.close).not.toHaveBeenCalled();
    expect(t.sessions.get(1)).toMatchObject({ dirty: true, loadGeneration: 0 });
    expect(t.workspace.hasUnpreservedChanges).toBe(true);
    const dialog = t.view.getByRole("alertdialog");
    expect(dialog.dataset.action).toBe("window");
    expect(document.activeElement).toBe(t.view.getByTestId("discard-cancel"));
    expect(t.view.getAllByRole("alertdialog")).toHaveLength(1);
    // Unconfirmed durability is never auto-loaded (which would clear the dirty guard).
    expect(RhwpEditorSession.prototype.load).not.toHaveBeenCalled();
  });

  it("7. cancelling the resulting confirmation keeps the protected session and reopens editing", async () => {
    const { t } = await closeDuringPublication();
    t.publication.resolve({ ok: true, value: info({ dirty: true }) });
    await act(flush);
    fireEvent.click(t.view.getByTestId("discard-cancel"));
    await act(flush);
    expect(t.view.queryByRole("alertdialog")).toBeNull();
    expect(t.windowClose.close).not.toHaveBeenCalled();
    expect(t.sessions.get(1)).toMatchObject({ dirty: true });
    // windowClosing was released, so a new file operation can start again.
    const again = t.workspace.newDocument(text, async () => null);
    expect(await again).toBeNull();
    // A later request asks again; confirming covers the now-visible session and closes exactly once.
    act(() => t.request());
    await act(flush);
    expect(t.view.getAllByRole("alertdialog")).toHaveLength(1);
    fireEvent.click(t.view.getByTestId("discard-confirm"));
    await act(flush);
    expect(t.windowClose.close).toHaveBeenCalledTimes(1);
    expect(t.backend.close).not.toHaveBeenCalled();
  });

  it("confirming the re-asked close destroys the window once without per-session cleanup", async () => {
    const { t } = await closeDuringPublication();
    t.publication.resolve({ ok: true, value: info({ dirty: true }) });
    await act(flush);
    fireEvent.click(t.view.getByTestId("discard-confirm"));
    await act(flush);
    expect(t.windowClose.close).toHaveBeenCalledTimes(1);
    expect(t.backend.close).not.toHaveBeenCalled();
  });

  it("5. a registration failure during close keeps its meaning and does not destroy the window over the notice", async () => {
    const { t, creating } = await closeDuringPublication();
    t.publication.resolve({ ok: false, error: { code: "FilePublishedUnregistered" } });
    await act(flush);
    expect(await creating).toEqual({ ok: false, error: { code: "FilePublishedUnregistered" } });
    expect(t.windowClose.close).not.toHaveBeenCalled();
    expect(t.sessions.snapshot().sessions).toEqual([]);
    expect(t.view.queryByRole("alertdialog")).toBeNull();
    // Nothing is left to protect: a fresh request closes normally.
    act(() => t.request());
    await act(flush);
    expect(t.windowClose.close).toHaveBeenCalledTimes(1);
  });

  it("6. a failed native destroy restores editing state and keeps the owned session", async () => {
    const { t } = await closeDuringPublication();
    t.windowClose.close.mockRejectedValueOnce(new Error("destroy"));
    t.publication.resolve({ ok: true, value: info() });
    await act(flush);
    expect(t.windowClose.close).toHaveBeenCalledTimes(1);
    expect(t.notify).toHaveBeenCalledWith({ key: "document.error.Protocol" });
    expect(t.sessions.get(1)).toMatchObject({ dirty: false });
    expect(await t.workspace.newDocument(text, async () => null)).toBeNull(); // windowClosing released
  });

  it("8. repeated native close requests while publication is pending produce one wait and one decision", async () => {
    const { t } = await closeDuringPublication();
    act(() => { t.request(); t.request(); });
    t.publication.resolve({ ok: true, value: info({ dirty: true }) });
    await act(flush);
    act(() => { t.request(); t.request(); });
    await act(flush);
    expect(t.view.getAllByRole("alertdialog")).toHaveLength(1);
    expect(t.windowClose.close).not.toHaveBeenCalled();
    fireEvent.click(t.view.getByTestId("discard-confirm"));
    await act(flush);
    act(() => t.request());
    await act(flush);
    expect(t.windowClose.close).toHaveBeenCalledTimes(1);
  });

  it("a recovery restore that published without a session during close also invalidates the stale decision", async () => {
    const backend = { close: vi.fn() } as unknown as DocumentBackend;
    const restore = deferred<Result<string>>();
    const files: FilePort = { chooseFile: vi.fn(async () => ({ ok: true as const, value: "/docs/restored.docx" })), createDocument: vi.fn() };
    const recovery = { list: vi.fn(async () => ({ ok: true as const, value: [] })), restore: vi.fn(() => restore.promise), discard: vi.fn(), forgetSession: vi.fn() };
    let request = () => {};
    const windowClose = { listen: vi.fn(async (handler: () => void) => { request = handler; return () => {}; }), close: vi.fn(async () => {}) };
    const workspace = new DocumentWorkspace(new DocumentSessions(backend), backend, async () => ({ openDocument: vi.fn(), createEmptyDocument: vi.fn() }), windowClose, undefined, undefined, files, recovery);
    const view = render(<LanguageProvider language="ko" onLanguageChange={() => {}}><Editor workspace={workspace} zoom={100} /></LanguageProvider>);
    try {
      await act(flush);
      const restoring = workspace.restoreRecovery({ id: "r1", valid: true, name: "a.docx", revision: 1, format: "docx", createdAt: 1, stale: false }, text);
      await act(flush);
      act(() => request());
      restore.resolve({ ok: false, error: { code: "FilePublishedUnconfirmed" } });
      await act(flush);
      expect(await restoring).toEqual({ ok: false, error: { code: "FilePublishedUnconfirmed" } });
      expect(workspace.publicationNoticeCount).toBe(1);
      expect(windowClose.close).not.toHaveBeenCalled();
      act(() => request());
      await act(flush);
      expect(windowClose.close).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); }
  });
});
