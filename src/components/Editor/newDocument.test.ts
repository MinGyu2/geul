import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentBackend } from "../../adapters/backend";
import type { DocumentFormat, Result, SessionInfo } from "../../adapters/contract";
import { DocumentSessions } from "../../adapters/sessions";
import { DocumentWorkspace } from "./documentWorkspace";
import type { FilePort } from "./filePort";
import { createRhwpBlank } from "./rhwp/createBlank";
import { RhwpEditorSession } from "./rhwp/RhwpEditorSession";
import { DocxEditorSession } from "./wordcraft/DocxEditorSession";
import { FakeDocx } from "./wordcraft/testing";
import { captureSurfaceFocus, claimSurfaceFocus, releaseSurfaceFocus, setSurfaceFocusLease } from "./surfaceFocus";

vi.mock("./rhwp/createBlank", () => ({ createRhwpBlank: vi.fn(() => ({ bytes: new Uint8Array([1]), contentLoss: {} })) }));
const text = { title: "New", accept: "Create", cancel: "Cancel" };
const info = (format: DocumentFormat, sessionId = 1): SessionInfo => ({ sessionId, format,
  engine: format === "docx" ? "wordcraft" : "rhwp", state: "identified", revision: 0, sequence: 0,
  loadGeneration: 0, dirty: false, displayName: `new.${format}` });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(reply => { resolve = reply; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

function setup(format: DocumentFormat = "hwp") {
  const created = info(format);
  const backend = { close: vi.fn(async (sessionId: number) => ({ ok: true, value: { sessionId, alreadyClosed: false } })) } as unknown as DocumentBackend;
  const files: FilePort = {
    chooseFile: vi.fn(async () => ({ ok: true as const, value: `/docs/new.${format}` })),
    createDocument: vi.fn(async () => ({ ok: true as const, value: created })),
  };
  const sessions = new DocumentSessions(backend);
  const module = { openDocument: vi.fn(), createEmptyDocument: vi.fn() };
  const workspace = new DocumentWorkspace(sessions, backend, async () => module, undefined, new FakeDocx(), undefined, files);
  return { created, backend, files, sessions, workspace };
}
beforeEach(() => {
  vi.mocked(createRhwpBlank).mockClear();
  vi.spyOn(RhwpEditorSession.prototype, "load").mockResolvedValue({ ok: true, value: null });
  vi.spyOn(DocxEditorSession.prototype, "load").mockResolvedValue({ ok: true, value: null });
});

describe("format-aware creation ownership", () => {
  it.each(["hwp", "hwpx", "docx"] as const)("reports an unconfirmed %s publication without treating it as an engine failure or loading it", async format => {
    const { workspace, files, sessions, created } = setup(format);
    const unconfirmed = { ...created, dirty: true };
    vi.mocked(files.createDocument).mockResolvedValue({ ok: true, value: unconfirmed });
    if (format !== "docx") {
      vi.mocked(RhwpEditorSession.prototype.load).mockRestore();
      vi.spyOn(RhwpEditorSession.prototype, "load");
    }
    expect(await workspace.newDocument(text, async () => format)).toEqual({ ok: true, value: unconfirmed });
    expect(sessions.get(1)).toMatchObject({ state: "identified", dirty: true, loadGeneration: 0 });
    expect(format === "docx" ? DocxEditorSession.prototype.load : RhwpEditorSession.prototype.load).not.toHaveBeenCalled();
  });
  it.each(["docx", "hwp", "hwpx"] as const)("routes %s through one serialized destination/create/load pipeline", async format => {
    const { workspace, files, sessions, created } = setup(format);
    expect(await workspace.newDocument(text, async () => format)).toEqual({ ok: true, value: created });
    expect(files.chooseFile).toHaveBeenCalledWith({ mode: "save", format, ...text });
    expect(files.createDocument).toHaveBeenCalledWith(format, `/docs/new.${format}`, format === "docx" ? undefined : expect.objectContaining({ bytes: expect.any(Uint8Array) }));
    expect(sessions.snapshot()).toMatchObject({ activeId: 1, sessions: [{ format, engine: created.engine }] });
    expect(createRhwpBlank).toHaveBeenCalledTimes(format === "docx" ? 0 : 1);
    releaseSurfaceFocus(workspace.anyEditorFor(1)!);
  });

  it("format and destination cancellation publish nothing and reserve no session", async () => {
    const { workspace, files, sessions } = setup();
    expect(await workspace.newDocument(text, async () => null)).toBeNull();
    expect(files.chooseFile).not.toHaveBeenCalled();
    vi.mocked(files.chooseFile).mockResolvedValue({ ok: true, value: null });
    expect(await workspace.newDocument(text, async () => "hwp")).toBeNull();
    expect(files.createDocument).not.toHaveBeenCalled();
    expect(createRhwpBlank).not.toHaveBeenCalled();
    expect(sessions.snapshot().sessions).toEqual([]);
    expect(workspace.fileBusy).toBe(false);
  });

  it("duplicate New requests share no chooser or publication while selection is pending", async () => {
    const { workspace, files } = setup();
    const selection = deferred<DocumentFormat | null>();
    const first = workspace.newDocument(text, () => selection.promise);
    const duplicate = vi.fn(async () => "hwp" as const);
    expect((await workspace.newDocument(text, duplicate))?.ok).toBe(false);
    expect(duplicate).not.toHaveBeenCalled();
    selection.resolve(null);
    expect(await first).toBeNull();
    expect(files.createDocument).not.toHaveBeenCalled();
  });

  it("a selection made during publication retains the active tab", async () => {
    const { workspace, files, sessions, created } = setup();
    sessions.acceptOpen(sessions.beginOpen(), { ok: true, value: info("docx", 2) });
    const pending = deferred<Result<SessionInfo>>();
    vi.mocked(files.createDocument).mockReturnValue(pending.promise);
    const creating = workspace.newDocument(text, async () => "hwp");
    await flush();
    sessions.select(2);
    pending.resolve({ ok: true, value: created });
    await creating;
    expect(sessions.snapshot().activeId).toBe(2);
    expect(sessions.snapshot().sessions).toHaveLength(2);
    releaseSurfaceFocus(workspace.anyEditorFor(1)!);
  });

  it("closing during format selection cancels before any native chooser or publication", async () => {
    const { workspace, files } = setup();
    const creating = workspace.newDocument(text, () => new Promise(() => {}));
    workspace.setWindowClosing(true);
    await workspace.waitForFiles();
    expect(await creating).toBeNull();
    expect(files.chooseFile).not.toHaveBeenCalled();
    expect(files.createDocument).not.toHaveBeenCalled();
  });

  it.each(["hwp", "docx"] as const)("a %s publication registered while the window closes stays an owned session, not a registration failure", async format => {
    const { workspace, files, sessions, backend, created } = setup(format);
    const pending = deferred<Result<SessionInfo>>();
    vi.mocked(files.createDocument).mockReturnValue(pending.promise);
    const creating = workspace.newDocument(text, async () => format);
    await flush();
    workspace.setWindowClosing(true);
    const waiting = workspace.waitForFiles();
    pending.resolve({ ok: true, value: created });
    // The truthful file outcome: published and registered, owned by the tab list like any open document.
    expect(await creating).toEqual({ ok: true, value: created });
    await waiting;
    expect(files.createDocument).toHaveBeenCalledTimes(1);
    expect(backend.close).not.toHaveBeenCalled();
    expect(sessions.get(created.sessionId)).toMatchObject({ format, dirty: false });
    expect(workspace.hasUnpreservedChanges).toBe(false);
    // No engine load or focus lease for a window that is being destroyed.
    expect(format === "docx" ? DocxEditorSession.prototype.load : RhwpEditorSession.prototype.load).not.toHaveBeenCalled();
    expect(workspace.fileBusy).toBe(false);
  });

  it("a genuine registration failure during window close keeps its published-unregistered meaning and no session", async () => {
    const { workspace, files, sessions, backend } = setup();
    const pending = deferred<Result<SessionInfo>>();
    vi.mocked(files.createDocument).mockReturnValue(pending.promise);
    const creating = workspace.newDocument(text, async () => "hwp");
    await flush();
    workspace.setWindowClosing(true);
    pending.resolve({ ok: false, error: { code: "FilePublishedUnregistered" } });
    expect(await creating).toEqual({ ok: false, error: { code: "FilePublishedUnregistered" } });
    expect(backend.close).not.toHaveBeenCalled();
    expect(sessions.snapshot().sessions).toEqual([]);
    expect(workspace.fileBusy).toBe(false);
  });

  it("editor load failure keeps the registered file/session and reports the distinct failure", async () => {
    const { workspace, sessions } = setup();
    vi.mocked(RhwpEditorSession.prototype.load).mockResolvedValue({ ok: false, error: { code: "EngineFailure", engine: "rhwp", stage: "parse" } });
    expect(await workspace.newDocument(text, async () => "hwp")).toEqual({ ok: false, error: { code: "FileCreatedEditorFailed", sessionId: 1 } });
    expect(sessions.get(1)?.format).toBe("hwp");
  });

  it("export failure never calls the publishing port", async () => {
    const { workspace, files, sessions } = setup();
    vi.mocked(createRhwpBlank).mockImplementationOnce(() => { throw new Error("export"); });
    expect(await workspace.newDocument(text, async () => "hwp")).toMatchObject({ ok: false, error: { code: "EngineFailure", stage: "export" } });
    expect(files.createDocument).not.toHaveBeenCalled();
    expect(sessions.snapshot().sessions).toEqual([]);
  });
});

describe("RHWP creation availability", () => {
  it("engine initialization failure is reported as init, not export, and publishes nothing", async () => {
    const { files, sessions } = setup();
    const workspace = new DocumentWorkspace(sessions, {} as DocumentBackend, async () => { throw new Error("wasm"); }, undefined, new FakeDocx(), undefined, files);
    expect(await workspace.newDocument(text, async () => "hwp")).toEqual({ ok: false, error: { code: "EngineFailure", engine: "rhwp", stage: "init" } });
    expect(createRhwpBlank).not.toHaveBeenCalled();
    expect(files.createDocument).not.toHaveBeenCalled();
    // Possibly transient: the format stays offered.
    expect(workspace.creationUnavailable("hwp")).toBeNull();
  });

  it("a runtime without the creation API is reported and not attempted again; DOCX is unaffected", async () => {
    const { files, sessions, created } = setup("docx");
    const workspace = new DocumentWorkspace(sessions, {} as DocumentBackend, async () => ({ openDocument: vi.fn() }), undefined, new FakeDocx(), undefined, files);
    const unavailable = { ok: false, error: { code: "CreationUnavailable", format: "hwpx" } };
    expect(await workspace.newDocument(text, async () => "hwpx")).toEqual(unavailable);
    expect(createRhwpBlank).not.toHaveBeenCalled();
    expect(files.createDocument).not.toHaveBeenCalled();
    expect(files.chooseFile).toHaveBeenCalledTimes(1);
    // The blank-model factory is shared: HWP is unavailable too, without its own attempt or chooser.
    expect(workspace.creationUnavailable("hwp")).toEqual({ code: "CreationUnavailable", format: "hwp" });
    expect(workspace.creationUnavailable("docx")).toBeNull();
    expect(await workspace.newDocument(text, async () => "hwpx")).toEqual(unavailable);
    expect(await workspace.newDocument(text, async () => "hwp")).toEqual({ ok: false, error: { code: "CreationUnavailable", format: "hwp" } });
    expect(files.chooseFile).toHaveBeenCalledTimes(1); // no destination chooser for a known-unavailable format
    expect(await workspace.newDocument(text, async () => "docx")).toEqual({ ok: true, value: created });
    releaseSurfaceFocus(workspace.anyEditorFor(1)!);
  });

  it("an unverified RHWP output rejected by Rust blocks that format only and never retries publication", async () => {
    const { workspace, files, sessions } = setup();
    const unverified = { ok: false as const, error: { code: "CreationUnverified" as const, format: "hwp" as const } };
    vi.mocked(files.createDocument).mockResolvedValueOnce(unverified);
    expect(await workspace.newDocument(text, async () => "hwp")).toEqual(unverified);
    expect(sessions.snapshot().sessions).toEqual([]);
    expect(workspace.creationUnavailable("hwp")).toEqual(unverified.error);
    expect(workspace.creationUnavailable("hwpx")).toBeNull();
    expect(await workspace.newDocument(text, async () => "hwp")).toEqual(unverified);
    expect(files.createDocument).toHaveBeenCalledTimes(1);
    expect(createRhwpBlank).toHaveBeenCalledTimes(1);
    // A frontend export that succeeds can still never authorize publication: Rust decided above.
    expect((await workspace.newDocument(text, async () => "hwpx"))?.ok).toBe(true);
    releaseSurfaceFocus(workspace.anyEditorFor(1)!);
  });
});

describe("independent per-format output verification", () => {
  it("an HWPX-only digest rejection blocks HWPX only; HWP and DOCX still create", async () => {
    const { workspace, files } = setup("hwp");
    const unverified = { ok: false as const, error: { code: "CreationUnverified" as const, format: "hwpx" as const } };
    vi.mocked(files.createDocument).mockResolvedValueOnce(unverified);
    expect(await workspace.newDocument(text, async () => "hwpx")).toEqual(unverified);
    expect(workspace.creationUnavailable("hwpx")).toEqual(unverified.error);
    expect(workspace.creationUnavailable("hwp")).toBeNull();
    expect((await workspace.newDocument(text, async () => "hwp"))?.ok).toBe(true);
    expect(files.createDocument).toHaveBeenLastCalledWith("hwp", "/docs/new.hwp", expect.objectContaining({ bytes: expect.any(Uint8Array) }));
    releaseSurfaceFocus(workspace.anyEditorFor(1)!);
  });

  it("a rejection for another format than requested does not block the requested format", async () => {
    const { workspace, files } = setup("hwp");
    vi.mocked(files.createDocument).mockResolvedValueOnce({ ok: false, error: { code: "CreationUnverified", format: "hwpx" } });
    await workspace.newDocument(text, async () => "hwp");
    expect(workspace.creationUnavailable("hwp")).toBeNull();
    expect(workspace.creationUnavailable("hwpx")).toBeNull();
  });
});

describe("creation focus lease", () => {
  it.each(["pointerdown", "keydown", "modal"])("late readiness cannot reclaim focus after %s", event => {
    const editor = {};
    setSurfaceFocusLease(editor, captureSurfaceFocus());
    if (event === "modal") {
      const dialog = document.createElement("div");
      dialog.setAttribute("aria-modal", "true");
      const input = document.createElement("input");
      dialog.append(input); document.body.append(dialog); input.focus(); dialog.remove();
    } else document.dispatchEvent(new Event(event, { bubbles: true }));
    expect(claimSurfaceFocus(editor)).toBe(false);
  });
  it("an unchallenged intent can claim focus, and disposal releases listeners", () => {
    const editor = {};
    setSurfaceFocusLease(editor, captureSurfaceFocus());
    expect(claimSurfaceFocus(editor)).toBe(true);
    setSurfaceFocusLease(editor, captureSurfaceFocus());
    releaseSurfaceFocus(editor);
  });
});
