import { act, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import App from "../../App";
import type { DocumentBackend } from "../../adapters/backend";
import { DocumentSessions } from "../../adapters/sessions";
import { documentPanelState, navigateDocumentPage } from "./documentPanels";
import { DocumentWorkspace } from "./documentWorkspace";
import { info as rhwpInfo, ok, readySession } from "./rhwp/testing";
import { decodeFake, FakeDocx, flush, readyDocx, stubScreenContext } from "./wordcraft/testing";

describe("authoritative panel projection and navigation", () => {
  it.each(["hwp", "hwpx"] as const)("uses actual %s pagination and caret without dirty/revision changes", async (format) => {
    const { editor, sessions, doc } = await readySession(["가나다"], {});
    const info = { ...sessions.get(1)!, format };
    const before = sessions.snapshot();
    const point = vi.spyOn(editor, "pointAt");
    expect(documentPanelState(editor, info).pageCount).toBe(editor.pages.length);
    expect(navigateDocumentPage(editor, info, 0)).toBe(true);
    expect(point).toHaveBeenCalledWith(0, 0, 0, false);
    expect(documentPanelState(editor, info).page).toBe(editor.caretRect()?.page);
    expect(sessions.snapshot()).toBe(before);
    expect(doc.paragraphs).toEqual(["가나다"]);
    editor.dispose();
  });

  it("rejects stale identity, out of bounds, pending input and live IME without forcing a commit", async () => {
    const { editor, sessions } = await readyDocx();
    const point = vi.spyOn(editor, "pointAt");
    expect(navigateDocumentPage(editor, { ...sessions.get(1)!, sessionId: 2 }, 0)).toBe(false);
    for (const page of [-1, 1, 0.5, NaN]) expect(navigateDocumentPage(editor, sessions.get(1), page)).toBe(false);
    editor.beginComposition();
    expect(documentPanelState(editor, sessions.get(1)).composing).toBe(true);
    expect(navigateDocumentPage(editor, sessions.get(1), 0)).toBe(false);
    expect(point).not.toHaveBeenCalled();
    expect(sessions.get(1)?.dirty).toBe(false);
    editor.dispose();
  });

  it("blocks navigation against an unacknowledged WordCraft edit", async () => {
    const { editor, sessions, fake } = await readyDocx();
    fake.hold = true;
    editor.typeText("pending");
    expect(documentPanelState(editor, sessions.get(1)).pending).toBe(true);
    expect(navigateDocumentPage(editor, sessions.get(1), 0)).toBe(false);
    fake.hold = false;
    fake.release(); await flush();
    editor.dispose();
  });

  it("reads bounded real RHWP selection and never presents first-character formatting as uniform", async () => {
    const { editor, sessions } = await readySession(["가나다"], {});
    for (let i = 0; i < 3; i++) editor.moveHorizontal(1, true);
    const state = documentPanelState(editor, sessions.get(1));
    expect(state.selection).toBe("selected");
    expect(state.selectedText).toBe("가나다");
    expect(state.format).toBeNull();
    editor.dispose();
    expect(documentPanelState(editor, sessions.get(1)).pageCount).toBeNull();
  });

  it("updates WordCraft engine formatting and distinguishes unknown selection flags", async () => {
    const { editor, sessions } = await readyDocx(["abc"]);
    editor.selectAll(); await flush();
    expect(documentPanelState(editor, sessions.get(1)).format?.bold).toBeNull();
    expect(editor.execute("format.bold").accepted).toBe(true); await flush();
    expect(documentPanelState(editor, sessions.get(1)).format?.bold).toBe(true);
    expect(documentPanelState(editor, sessions.get(1)).info?.dirty).toBe(true);
    editor.dispose();
  });

  it("keeps snapshots stable between events and removes listeners", async () => {
    const { editor } = await readyDocx();
    const listener = vi.fn(); const unsubscribe = editor.subscribe(listener);
    const version = editor.changeSnapshot();
    expect(editor.changeSnapshot()).toBe(version);
    editor.pointAt(0, 80, 72, false); await flush();
    expect(editor.changeSnapshot()).toBeGreaterThan(version);
    unsubscribe(); listener.mockClear();
    editor.pointAt(0, 90, 72, false); await flush();
    expect(listener).not.toHaveBeenCalled();
    editor.dispose();
  });

  it("App subscribes in StrictMode, clears closed data, and ignores disposed editor events", async () => {
    stubScreenContext();
    const fake = new FakeDocx(["abc"]);
    const backend = {
      open: async () => ({ ok: true, value: { ...fake.info } }),
      sessions: async () => ({ ok: true, value: [] }),
      close: async (sessionId: number) => ({ ok: true, value: { sessionId, alreadyClosed: false } }),
    } as unknown as DocumentBackend;
    const sessions = new DocumentSessions(backend);
    const workspace = new DocumentWorkspace(sessions, backend, undefined, undefined, fake, decodeFake);
    const app = render(<StrictMode><App initialLanguage="en" settingsStore={{ read: () => null, write: () => true }} documentWorkspace={workspace} /></StrictMode>);
    await act(async () => { await workspace.open("/a.docx"); await flush(); });
    expect(screen.getByRole("contentinfo").textContent).toContain("a.docx");
    const editor = workspace.docxEditorFor(1)!;
    await act(async () => { editor.typeText("x"); await flush(); });
    expect(screen.getByRole("contentinfo").textContent).toContain("*");
    await act(async () => { await workspace.close(1, { discard: true }); });
    expect(screen.getByRole("contentinfo").textContent).not.toContain("a.docx");
    await act(async () => { editor.pointAt(0, 0, 0, false); await flush(); });
    expect(screen.getByRole("contentinfo").textContent).not.toContain("a.docx");
    app.unmount();
  });
});

describe("unpreserved-change projection", () => {
  const observe = (editor: Parameters<typeof documentPanelState>[0], sessions: DocumentSessions) => {
    const before = { session: sessions.snapshot(), revision: editor?.snapshot().revision, version: editor?.changeSnapshot() };
    const state = documentPanelState(editor, sessions.get(1) ?? null);
    // Reading the projection has no side effects on the session, revision, or editor event version.
    expect(sessions.snapshot()).toBe(before.session);
    expect(editor?.snapshot().revision).toBe(before.revision);
    expect(editor?.changeSnapshot()).toBe(before.version);
    return state;
  };

  it("matches the tab/close contract for WordCraft pending, committed, durable and unconfirmed saves", async () => {
    const { editor, sessions, fake } = await readyDocx();
    expect(observe(editor, sessions)).toMatchObject({ unpreserved: false, pending: false, composing: false });
    expect(observe(editor, sessions).info?.dirty).toBe(false);
    fake.hold = true;
    editor.typeText("x");
    const pending = observe(editor, sessions);
    expect(pending).toMatchObject({ unpreserved: true, pending: true });
    expect(pending.info?.dirty).toBe(false); // not acknowledged by the backend yet
    expect(pending.unpreserved).toBe(editor.hasUnpreservedChanges);
    fake.hold = false;
    fake.release(); await flush();
    const committed = observe(editor, sessions);
    expect(committed).toMatchObject({ unpreserved: true, pending: false });
    expect(committed.info?.dirty).toBe(true);
    fake.durable = false;
    expect((await editor.save()).ok).toBe(true);
    const unconfirmed = observe(editor, sessions);
    expect(unconfirmed.info?.dirty).toBe(true);
    expect(unconfirmed.unpreserved).toBe(true);
    fake.durable = true;
    expect((await editor.save()).ok).toBe(true);
    expect(observe(editor, sessions)).toMatchObject({ unpreserved: false, pending: false, composing: false });
    expect(editor.hasUnpreservedChanges).toBe(false);
    editor.dispose();
  });

  it("protects an unsettled Korean composition without committing it, then follows the committed edit", async () => {
    const { editor, sessions, fake } = await readyDocx();
    editor.beginComposition();
    editor.updateComposition("ㄱ");
    const composing = observe(editor, sessions);
    expect(composing).toMatchObject({ unpreserved: true, composing: true });
    expect(composing.info?.dirty).toBe(false);
    expect(editor.composing).toBe(true); // observing did not finish the composition
    expect(fake.calls.filter((call) => call.method === "edit")).toHaveLength(0);
    editor.endComposition("가"); await flush();
    const committed = observe(editor, sessions);
    expect(committed).toMatchObject({ unpreserved: true, composing: false, pending: false });
    expect(committed.info?.dirty).toBe(true);
    editor.dispose();
  });

  it("reports RHWP unacknowledged and uncertain engine edits even while the editor is unavailable", async () => {
    const { editor, sessions, take, doc } = await readySession(["ab"], {});
    editor.typeText("가");
    const waiting = observe(editor, sessions);
    expect(waiting.info?.dirty).toBe(false);
    expect(waiting.unpreserved).toBe(true);
    take("commit").reply(ok(rhwpInfo({ state: "ready", revision: 1, dirty: true, sequence: 3 })));
    await flush();
    expect(observe(editor, sessions)).toMatchObject({ unpreserved: true });
    doc.failNext = true;
    editor.backspace();
    await flush();
    const failed = observe(editor, sessions);
    expect(failed.unpreserved).toBe(true);
    expect(failed.unpreserved).toBe(editor.hasUnpreservedChanges);
    editor.dispose();
  });

  it("never attributes another document's unpreserved state to the active session", async () => {
    const { editor, sessions, fake } = await readyDocx();
    fake.hold = true;
    editor.typeText("x");
    const other = { ...sessions.get(1)!, sessionId: 2, dirty: false, displayName: "b.docx" };
    expect(documentPanelState(editor, other)).toMatchObject({ unpreserved: false, pending: false });
    expect(documentPanelState(null, { ...other, dirty: true }).unpreserved).toBe(true);
    expect(documentPanelState(editor, null).unpreserved).toBe(false);
    fake.hold = false; fake.release(); await flush();
    editor.dispose();
  });

  it("App tab marker, status bar and properties panel agree for pending edits and clear on close", async () => {
    stubScreenContext();
    const fake = new FakeDocx(["abc"]);
    const backend = {
      open: async () => ({ ok: true, value: { ...fake.info } }),
      sessions: async () => ({ ok: true, value: [] }),
      close: async (sessionId: number) => ({ ok: true, value: { sessionId, alreadyClosed: false } }),
    } as unknown as DocumentBackend;
    const sessions = new DocumentSessions(backend);
    const workspace = new DocumentWorkspace(sessions, backend, undefined, undefined, fake, decodeFake);
    const app = render(<App initialLanguage="en" settingsStore={{ read: () => null, write: () => true }} documentWorkspace={workspace} />);
    await act(async () => { await workspace.open("/a.docx"); await flush(); });
    const status = () => screen.getByTestId("status-document");
    const row = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling;
    const tab = () => screen.getByRole("tab", { name: /a\.docx/ });
    expect(tab()).toHaveAttribute("data-modified", "false");
    expect(status().textContent).not.toContain("*");
    expect(row("Unsaved edits")).toHaveTextContent("No");
    const editor = workspace.docxEditorFor(1)!;
    fake.hold = true;
    await act(async () => { editor.typeText("x"); await flush(); });
    expect(tab()).toHaveAttribute("data-modified", "true");
    expect(workspace.hasUnpreservedChanges).toBe(true);
    expect(sessions.get(1)?.dirty).toBe(false);
    expect(status().textContent).toContain("*");
    expect(row("Unsaved edits")).toHaveTextContent("Yes");
    expect(row("Committed changes without a confirmed save")).toHaveTextContent("No");
    expect(row("Edits awaiting confirmation")).toHaveTextContent("Yes");
    fake.hold = false;
    await act(async () => { fake.release(); await flush(); });
    expect(row("Committed changes without a confirmed save")).toHaveTextContent("Yes");
    expect(row("Edits awaiting confirmation")).toHaveTextContent("No");
    await act(async () => { await workspace.close(1, { discard: true }); });
    expect(status().textContent).not.toContain("*");
    expect(screen.queryByText("Unsaved edits", { selector: "dt" })).toBeNull();
    app.unmount();
  });
});

describe("pending navigation versus unpreserved edits (WordCraft)", () => {
  const navigations: [string, (editor: Awaited<ReturnType<typeof readyDocx>>["editor"]) => boolean][] = [
    ["caret movement", (editor) => editor.move("right", false)],
    ["selection movement", (editor) => editor.move("right", true)],
    ["select all", (editor) => editor.selectAll()],
    ["pointer caret movement", (editor) => editor.pointAt(0, 90, 72, false)],
  ];

  it.each(navigations)("clean document with pending %s shows no unsaved marker and keeps revision/dirty", async (_, act) => {
    const { editor, sessions, fake } = await readyDocx(["abc"]);
    const before = { revision: sessions.get(1)!.revision, paragraphs: [...fake.paragraphs] };
    expect(sessions.get(1)?.dirty).toBe(false);
    fake.hold = true;
    expect(act(editor)).toBe(true);
    const pending = documentPanelState(editor, sessions.get(1));
    expect(pending.pending).toBe(true); // still reported as an in-flight operation
    expect(pending.unpreserved).toBe(false);
    expect(editor.hasUnpreservedChanges).toBe(false);
    fake.hold = false; fake.release(); await flush();
    expect(sessions.get(1)).toMatchObject({ revision: before.revision, dirty: false });
    expect(fake.paragraphs).toEqual(before.paragraphs);
    expect(documentPanelState(editor, sessions.get(1))).toMatchObject({ pending: false, unpreserved: false });
    editor.dispose();
  });

  it("keeps a pending insert protected behind later navigation until the backend accounts for it", async () => {
    const { editor, sessions, fake } = await readyDocx(["abc"]);
    fake.hold = true;
    editor.typeText("x");
    expect(editor.hasUnpreservedChanges).toBe(true);
    editor.move("left", false); // queued behind the in-flight insert
    editor.selectAll();
    expect(documentPanelState(editor, sessions.get(1)).unpreserved).toBe(true);
    fake.release(); await flush(); // insert acknowledged → backend dirty, navigation batch now in flight
    expect(sessions.get(1)?.dirty).toBe(true);
    expect(editor.hasUnpreservedChanges).toBe(true);
    fake.hold = false; fake.release(); await flush();
    expect(editor.hasUnpreservedChanges).toBe(true);
    editor.dispose();
  });

  it("treats a queued navigation+edit mix and conservative ops as unpreserved", async () => {
    const { editor, fake } = await readyDocx(["abc"]);
    fake.hold = true;
    editor.move("right", false); // in flight, navigation only
    expect(editor.hasUnpreservedChanges).toBe(false);
    editor.backspace(); // queued mutation behind navigation
    expect(editor.hasUnpreservedChanges).toBe(true);
    fake.hold = false; fake.release(); await flush(); await flush();
    const formatted = await readyDocx(["abc"]);
    formatted.fake.hold = true;
    expect(formatted.editor.execute("format.bold").accepted).toBe(true);
    expect(formatted.editor.hasUnpreservedChanges).toBe(true); // format/undo/redo are never assumed harmless
    formatted.fake.hold = false; formatted.fake.release(); await flush();
    editor.dispose(); formatted.editor.dispose();
  });

  it("backend dirty stays authoritative under a pending read-only operation", async () => {
    const { editor, sessions, fake } = await readyDocx(["abc"]);
    editor.typeText("x"); await flush();
    expect(sessions.get(1)?.dirty).toBe(true);
    fake.hold = true;
    editor.move("left", false);
    expect(documentPanelState(editor, sessions.get(1)).unpreserved).toBe(true);
    fake.hold = false; fake.release(); await flush();
    editor.dispose();
  });

  it("a failed edit leaves backend dirty authoritative: earlier committed edits stay protected", async () => {
    const { editor, sessions, fake } = await readyDocx(["abc"]);
    editor.typeText("x"); await flush();
    fake.hold = true;
    fake.failNext = { code: "EngineFailure", engine: "wordcraft", stage: "edit" };
    editor.typeText("y");
    expect(editor.hasUnpreservedChanges).toBe(true); // pending mutation before the failure response
    fake.hold = false; fake.release(); await flush();
    expect(editor.status.kind).toBe("failed");
    expect(sessions.get(1)?.dirty).toBe(true);
    expect(documentPanelState(editor, sessions.get(1)).unpreserved).toBe(true);
    expect((await editor.load()).ok).toBe(false); // reload still needs explicit discard
    editor.dispose();
  });

  it("a navigation that fails does not invent unpreserved content", async () => {
    const { editor, sessions, fake } = await readyDocx(["abc"]);
    fake.failNext = { code: "EngineFailure", stage: "edit" } as never;
    editor.move("right", false); await flush();
    expect(editor.status.kind).toBe("failed");
    expect(sessions.get(1)?.dirty).toBe(false);
    expect(editor.hasUnpreservedChanges).toBe(false);
    editor.dispose();
  });

  it("App tab, properties panel and status bar agree on pending navigation versus a pending edit", async () => {
    stubScreenContext();
    const fake = new FakeDocx(["abc"]);
    const backend = {
      open: async () => ({ ok: true, value: { ...fake.info } }),
      sessions: async () => ({ ok: true, value: [] }),
      close: async (sessionId: number) => ({ ok: true, value: { sessionId, alreadyClosed: false } }),
    } as unknown as DocumentBackend;
    const sessions = new DocumentSessions(backend);
    const workspace = new DocumentWorkspace(sessions, backend, undefined, undefined, fake, decodeFake);
    const app = render(<App initialLanguage="en" settingsStore={{ read: () => null, write: () => true }} documentWorkspace={workspace} />);
    await act(async () => { await workspace.open("/a.docx"); await flush(); });
    const status = () => screen.getByTestId("status-document");
    const row = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling;
    const tab = () => screen.getByRole("tab", { name: /a\.docx/ });
    const editor = workspace.docxEditorFor(1)!;
    fake.hold = true;
    await act(async () => { editor.move("right", false); await flush(); });
    expect(row("Edits awaiting confirmation")).toHaveTextContent("Yes"); // the subscriber did refresh
    expect(tab()).toHaveAttribute("data-modified", "false");
    expect(status().textContent).not.toContain("*");
    expect(row("Unsaved edits")).toHaveTextContent("No");
    expect(workspace.hasUnpreservedChanges).toBe(false);
    await act(async () => { fake.release(); await flush(); });
    await act(async () => { editor.typeText("x"); await flush(); });
    expect(tab()).toHaveAttribute("data-modified", "true");
    expect(status().textContent).toContain("*");
    expect(row("Unsaved edits")).toHaveTextContent("Yes");
    fake.hold = false;
    await act(async () => { fake.release(); await flush(); });
    await act(async () => { await workspace.close(1, { discard: true }); });
    expect(status().textContent).not.toContain("*");
    app.unmount();
  });
});
