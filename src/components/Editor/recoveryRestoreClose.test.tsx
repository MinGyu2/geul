// Recovery restore while a native window-close decision is pending (frontend simulation with controlled
// IPC ordering). Rust publishes the restore destination before the separate document_open; here both
// ports are deferred so each linearization point can be ordered explicitly.
import { act, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import type { Language } from "../../language";
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

function setup(options: { chooser?: Promise<Result<string | null>>; existing?: SessionInfo[]; candidates?: RecoveryCandidate[]; appLanguage?: Language } = {}) {
  vi.spyOn(DocxEditorSession.prototype, "load").mockResolvedValue({ ok: true, value: null });
  const opened = deferred<Result<SessionInfo>>();
  // session(): editor panels of pre-existing tabs refresh their backend record.
  const known = new Map((options.existing ?? []).map(value => [value.sessionId, value]));
  const backend = { sessions: vi.fn(async () => ({ ok: true, value: [...known.values()] })), close: vi.fn(), open: vi.fn(() => opened.promise),
    session: vi.fn(async (sessionId: number) => known.has(sessionId)
      ? { ok: true as const, value: known.get(sessionId)! } : { ok: false as const, error: { code: "UnknownSession" as const, sessionId } }) } as unknown as DocumentBackend;
  const restored = deferred<Result<string>>();
  const files: FilePort = { chooseFile: vi.fn(options.chooser ? () => options.chooser! : async () => ({ ok: true as const, value: "/docs/restored.docx" })), createDocument: vi.fn() };
  const recovery = { list: vi.fn(async () => ({ ok: true as const, value: options.candidates ?? [] })), restore: vi.fn(() => restored.promise),
    discard: vi.fn(), forgetSession: vi.fn() };
  let request = () => {};
  const windowClose = { listen: vi.fn(async (handler: () => void) => { request = handler; return () => {}; }), close: vi.fn(async () => {}) };
  const sessions = new DocumentSessions(backend);
  for (const value of options.existing ?? []) sessions.acceptOpen(sessions.beginOpen(), { ok: true, value });
  const workspace = new DocumentWorkspace(sessions, backend, async () => ({ openDocument: vi.fn() }), windowClose, new FakeDocx(), undefined, files, recovery);
  const notify = vi.fn();
  const view = render(options.appLanguage ? <App documentWorkspace={workspace} initialLanguage={options.appLanguage} /> : <LanguageProvider language="ko" onLanguageChange={() => {}}><Editor workspace={workspace} zoom={100} notify={notify} /></LanguageProvider>);
  unmount = () => view.unmount();
  return { notify, backend, files, recovery, windowClose, sessions, workspace, view, opened, restored, request: () => request() };
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

// Boundary A/B: the native destination chooser is still pending when the window close is decided.
describe("window close while the recovery destination chooser is pending", () => {
  const edited: SessionInfo = { ...info, sessionId: 3, state: "ready", revision: 2, sequence: 3, loadGeneration: 1, dirty: true, displayName: "edited.docx" };

  async function choosing(existing: SessionInfo[] = []) {
    const chooser = deferred<Result<string | null>>();
    const t = setup({ chooser: chooser.promise, existing });
    await act(flush);
    // An open reserved before the restore: it must become newest again once the restore's ticket is released.
    const earlier = t.sessions.beginOpen();
    const restoring = t.workspace.restoreRecovery(candidate, text);
    await act(flush);
    expect(t.files.chooseFile).toHaveBeenCalledTimes(1);
    expect(t.workspace.fileBusy).toBe(true);
    return { t, chooser, restoring, earlier };
  }

  it("A: a close confirmed without a prompt stops restore before publication; the window closes once", async () => {
    const { t, chooser, restoring, earlier } = await choosing();
    act(() => t.request());
    await act(flush);
    expect(t.workspace.fileBusy).toBe(true);
    chooser.resolve({ ok: true, value: "/docs/restored.docx" });
    await act(flush);
    expect(await restoring).toBeNull();
    expect(t.recovery.restore).not.toHaveBeenCalled();
    expect(t.backend.open).not.toHaveBeenCalled();
    expect(t.recovery.discard).not.toHaveBeenCalled();
    expect(t.workspace.publicationNoticeCount).toBe(0);
    expect(t.windowClose.close).toHaveBeenCalledTimes(1);
    // The restore's open ticket was released: the earlier reservation is newest again.
    t.sessions.acceptOpen(earlier, { ok: true, value: { ...info, sessionId: 9 } });
    expect(t.sessions.snapshot().activeId).toBe(9);
  });

  it("A: a close confirmed through the unsaved-edits prompt also stops restore before publication", async () => {
    const { t, chooser, restoring } = await choosing([edited]);
    act(() => t.request());
    await act(flush);
    fireEvent.click(t.view.getByTestId("discard-confirm"));
    await act(flush);
    expect(t.windowClose.close).not.toHaveBeenCalled(); // still waiting for the chooser
    chooser.resolve({ ok: true, value: "/docs/restored.docx" });
    await act(flush);
    expect(await restoring).toBeNull();
    expect(t.recovery.restore).not.toHaveBeenCalled();
    expect(t.windowClose.close).toHaveBeenCalledTimes(1);
  });

  it("B: cancelling the close prompt keeps restore usable; the chosen destination is then restored once", async () => {
    const { t, chooser, restoring } = await choosing([edited]);
    act(() => t.request());
    await act(flush);
    fireEvent.click(t.view.getByTestId("discard-cancel"));
    await act(flush);
    expect(t.view.queryByRole("alertdialog")).toBeNull();
    // No duplicate operation while the first chooser is pending.
    expect(await t.workspace.restoreRecovery(candidate, text)).toEqual({ ok: false, error: { code: "Protocol" } });
    expect(t.files.chooseFile).toHaveBeenCalledTimes(1);
    chooser.resolve({ ok: true, value: "/docs/restored.docx" });
    await act(flush);
    expect(t.recovery.restore).toHaveBeenCalledTimes(1);
    t.restored.resolve({ ok: true, value: "/docs/restored.docx" });
    await act(flush);
    t.opened.resolve({ ok: true, value: info });
    expect(await restoring).toEqual({ ok: true, value: info });
    expect(t.sessions.get(7)).toBeTruthy();
    expect(t.windowClose.close).not.toHaveBeenCalled();
  });

  it("C: chooser cancellation publishes nothing, opens nothing and records no notice, with or without closing", async () => {
    for (const closing of [false, true]) {
      unmount?.();
      const { t, chooser, restoring } = await choosing();
      if (closing) { act(() => t.request()); await act(flush); }
      chooser.resolve({ ok: true, value: null });
      await act(flush);
      expect(await restoring).toBeNull();
      expect(t.recovery.restore).not.toHaveBeenCalled();
      expect(t.backend.open).not.toHaveBeenCalled();
      expect(t.workspace.publicationNoticeCount).toBe(0);
      expect(t.workspace.fileBusy).toBe(false);
      expect(t.windowClose.close).toHaveBeenCalledTimes(closing ? 1 : 0);
    }
  });

  it("F: repeated close requests while choosing produce one wait, no publication and one destroy", async () => {
    const { t, chooser, restoring } = await choosing();
    act(() => { t.request(); t.request(); });
    await act(flush);
    act(() => t.request());
    chooser.resolve({ ok: true, value: "/docs/restored.docx" });
    await act(flush);
    expect(await restoring).toBeNull();
    expect(t.recovery.restore).not.toHaveBeenCalled();
    expect(t.view.queryByRole("alertdialog")).toBeNull();
    expect(t.windowClose.close).toHaveBeenCalledTimes(1);
  });
});

// AlreadyOpen after a restore publication names an earlier document whose identity now matches the
// destination (only reachable through an external replacement, see the Rust recovery test). It is
// never the restored content, so the restore must not adopt or select it.
describe("AlreadyOpen after restore publication", () => {
  const other: SessionInfo = { ...info, sessionId: 3, state: "ready", revision: 1, sequence: 2, loadGeneration: 1, displayName: "other.docx" };
  const unrelated: SessionInfo = { ...info, sessionId: 4, state: "ready", revision: 1, sequence: 2, loadGeneration: 1, displayName: "unrelated.docx" };

  async function restoredThenAlreadyOpen(sessionId: number, closing: boolean) {
    const t = setup({ existing: [other, unrelated] });
    await act(flush);
    const before = t.sessions.snapshot();
    const restoring = t.workspace.restoreRecovery(candidate, text);
    await act(flush);
    if (closing) { act(() => t.request()); await act(flush); }
    t.restored.resolve({ ok: true, value: "/docs/restored.docx" });
    await act(flush);
    t.opened.resolve({ ok: false, error: { code: "AlreadyOpen", sessionId } });
    await act(flush);
    return { t, before, result: await restoring };
  }

  it.each([
    ["A: a session the frontend already owns", 3],
    ["B/C: a backend session missing from the projection (or already gone)", 99],
  ])("%s is not adopted; the published file is reported and noticed", async (_label, sessionId) => {
    const { t, before, result } = await restoredThenAlreadyOpen(sessionId, false);
    expect(result).toEqual({ ok: false, error: { code: "RestoredUnopened", cause: { code: "AlreadyOpen", sessionId } } });
    // No duplicate, no fabricated session, no selection change, unrelated tabs untouched.
    expect(t.sessions.snapshot()).toEqual(before);
    expect(t.workspace.publicationNoticeCount).toBe(1);
    expect(t.recovery.discard).not.toHaveBeenCalled();
  });

  it("D: during a pending close, AlreadyOpen keeps the window instead of hiding the publication", async () => {
    const { t, result } = await restoredThenAlreadyOpen(3, true);
    expect(result).toMatchObject({ ok: false, error: { code: "RestoredUnopened" } });
    expect(t.windowClose.close).not.toHaveBeenCalled();
    expect(t.workspace.fileBusy).toBe(false);
    act(() => t.request());
    await act(flush);
    expect(t.windowClose.close).toHaveBeenCalledTimes(1);
  });
});

describe("RestoredUnopened wording", () => {
  const render = (language: "ko" | "en", error: DocumentError) => {
    const message = documentErrorMessage(error);
    return createTranslator(language)(message.key, message.vars);
  };
  const alreadyOpen: DocumentError = { code: "RestoredUnopened", cause: { code: "AlreadyOpen", sessionId: 3 } };

  it.each([
    ["ko", /확인할 수 없습니다/, /원래 복구 사본은 그대로 남아/, /다른 위치를 골라 다시 복원/, /직접 열어|삭제/],
    ["en", /cannot be confirmed/, /original recovery copy remains/, /choose another location and restore again/, /open it yourself|deleted/i],
  ] as const)("AlreadyOpen (%s): no promise that the restored content is still at the destination", (language, uncertain, retained, retry, forbidden) => {
    const text = render(language, alreadyOpen);
    expect(documentErrorMessage(alreadyOpen)).toEqual({ key: "document.error.RestoredUnopenedAlreadyOpen" });
    expect(text).toMatch(uncertain);
    expect(text).toMatch(retained);
    expect(text).toMatch(retry);
    expect(text).not.toMatch(forbidden); // neither "open the file yourself" nor a deletion claim
    expect(text).not.toMatch(/\/|\{|session/i); // no path, placeholder or session id
  });

  it.each([
    { code: "ResourceLimit", limit: "session-count" },
    { code: "Unreadable", reason: "permission-denied" },
    { code: "ParseFailure", reason: "corrupt-container" },
    { code: "Protocol" },
  ] as DocumentError[])("other open failures keep the generic message with their cause: $code", cause => {
    for (const language of ["ko", "en"] as const) {
      const text = render(language, { code: "RestoredUnopened", cause });
      expect(documentErrorMessage({ code: "RestoredUnopened", cause }).key).toBe("document.error.RestoredUnopened");
      expect(text).toContain(createTranslator(language)(`document.error.${cause.code}` as never));
      expect(text).not.toMatch(/바뀌었을 수|may have changed/);
    }
  });

  it("a plain AlreadyOpen outside restore keeps its existing message", () => {
    expect(documentErrorMessage({ code: "AlreadyOpen", sessionId: 3 })).toEqual({ key: "document.error.AlreadyOpen" });
  });

  it("the Recovery Center shows the specific warning without adopting a session or changing close behavior", async () => {
    const other: SessionInfo = { ...info, sessionId: 3, state: "ready", revision: 1, sequence: 2, loadGeneration: 1, displayName: "other.docx" };
    const t = setup({ existing: [other], candidates: [candidate] });
    await act(flush);
    const before = t.sessions.snapshot();
    fireEvent.click(t.view.getByTestId("recovery-restore-r1"));
    await act(flush);
    t.restored.resolve({ ok: true, value: "/docs/restored.docx" });
    await act(flush);
    t.opened.resolve({ ok: false, error: { code: "AlreadyOpen", sessionId: 3 } });
    await act(flush);
    expect(t.notify).toHaveBeenCalledWith({ key: "document.error.RestoredUnopenedAlreadyOpen" });
    expect(t.sessions.snapshot()).toEqual(before); // no selection change, no duplicate
    expect(t.workspace.publicationNoticeCount).toBe(1);
    expect(t.recovery.discard).not.toHaveBeenCalled();
    expect(t.view.queryByRole("alertdialog")).toBeNull();
    // The notice preceded this close decision: a clean window closes normally, once.
    act(() => t.request());
    await act(flush);
    expect(t.windowClose.close).toHaveBeenCalledTimes(1);
  });
});


// Exercise the entire RecoveryCenter -> App notification -> StatusBar path.
it.each(["ko", "en"] as const)("publication warning survives ordinary status and preserves the selected editor (%s)", async language => {
  const existing = { ...info, sessionId: 3, state: "ready" as const, revision: 1, sequence: 2, loadGeneration: 1 };
  const t = setup({ existing: [existing], candidates: [candidate], appLanguage: language });
  await act(flush);
  const before = t.sessions.snapshot();
  fireEvent.click(t.view.getByTestId("recovery-restore-r1"));
  await act(flush);
  t.restored.resolve({ ok: true, value: "/private/restored.docx" });
  await act(flush);
  t.opened.resolve({ ok: false, error: { code: "AlreadyOpen", sessionId: 3 } });
  await act(flush);
  const translate = createTranslator(language);
  const warning = translate("document.error.RestoredUnopenedAlreadyOpen");
  const toggle = t.view.getByRole("button", { name: translate("status.messageDetails") });
  fireEvent.click(t.view.getByRole("button", { name: translate("command.view.zoomIn") }));
  expect(within(t.view.getByRole("contentinfo")).getByRole("status", { name: "" })).toHaveTextContent(warning);
  fireEvent.click(toggle);
  const details = t.view.getByRole("region", { name: translate("status.warningDetails") });
  expect(details).toHaveTextContent(warning);
  expect(details).not.toHaveTextContent("/private/");
  expect(t.sessions.snapshot()).toEqual(before);
  expect(t.workspace.publicationNoticeCount).toBe(1);
  expect(t.recovery.discard).not.toHaveBeenCalled();
  expect(t.view.queryByRole("alertdialog")).toBeNull();
  fireEvent.click(within(details).getByRole("button", { name: translate("status.dismissWarning") }));
  expect(t.view.queryByRole("button", { name: translate("status.messageDetails") })).toBeNull();
  expect(t.workspace.publicationNoticeCount).toBe(1);
  expect(t.sessions.snapshot()).toEqual(before); // acknowledgement changes only the notification
  expect(t.recovery.discard).not.toHaveBeenCalled();
  act(() => t.request());
  await act(flush);
  expect(t.windowClose.close).toHaveBeenCalledTimes(1);
});
