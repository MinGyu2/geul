import { act, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import App from "../../App";
import type { DocumentBackend } from "../../adapters/backend";
import { DocumentSessions } from "../../adapters/sessions";
import { documentPanelState, navigateDocumentPage } from "./documentPanels";
import { DocumentWorkspace } from "./documentWorkspace";
import { readySession } from "./rhwp/testing";
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
