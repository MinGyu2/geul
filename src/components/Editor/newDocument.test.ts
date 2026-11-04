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
  const module = { openDocument: vi.fn() };
  const workspace = new DocumentWorkspace(sessions, backend, async () => module, undefined, new FakeDocx(), undefined, files);
  return { created, backend, files, sessions, workspace };
}
beforeEach(() => {
  vi.mocked(createRhwpBlank).mockClear();
  vi.spyOn(RhwpEditorSession.prototype, "load").mockResolvedValue({ ok: true, value: null });
  vi.spyOn(DocxEditorSession.prototype, "load").mockResolvedValue({ ok: true, value: null });
});

describe("format-aware creation ownership", () => {
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

  it("closing during publication retains the file outcome and closes the late backend session", async () => {
    const { workspace, files, sessions, backend, created } = setup();
    const pending = deferred<Result<SessionInfo>>();
    vi.mocked(files.createDocument).mockReturnValue(pending.promise);
    const creating = workspace.newDocument(text, async () => "hwp");
    await flush();
    workspace.setWindowClosing(true);
    pending.resolve({ ok: true, value: created });
    expect(await creating).toEqual({ ok: false, error: { code: "FilePublishedUnregistered" } });
    expect(backend.close).toHaveBeenCalledWith(created.sessionId);
    expect(sessions.snapshot().sessions).toEqual([]);
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
