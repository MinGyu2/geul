// Window-close confirmation wording per state (frontend). dirty at revision 0 / loadGeneration 0 is an
// unconfirmed initial publication (never loaded into an engine), not an in-memory edit.
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentBackend } from "../../adapters/backend";
import type { SessionInfo } from "../../adapters/contract";
import { DocumentSessions } from "../../adapters/sessions";
import { LanguageProvider } from "../../language/LanguageContext";
import ko from "../../language/ko.json";
import en from "../../language/en.json";
import { DocumentWorkspace } from "./documentWorkspace";
import { Editor } from "./Editor";
import { RhwpEditorSession } from "./rhwp/RhwpEditorSession";

const info = (sessionId: number, patch: Partial<SessionInfo>): SessionInfo => ({ sessionId, format: "hwp", engine: "rhwp",
  state: "identified", revision: 0, sequence: 0, loadGeneration: 0, dirty: false, displayName: `doc${sessionId}.hwp`, ...patch });
const edited = (id: number) => info(id, { state: "ready", revision: 2, sequence: 3, loadGeneration: 1, dirty: true });
const unconfirmed = (id: number) => info(id, { dirty: true });
const clean = (id: number) => info(id, { state: "ready", revision: 1, sequence: 2, loadGeneration: 1 });
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

let unmount: (() => void) | undefined;
afterEach(() => { unmount?.(); unmount = undefined; document.body.innerHTML = ""; vi.restoreAllMocks(); });

async function setup(language: "ko" | "en", sessionsInfo: SessionInfo[]) {
  vi.spyOn(RhwpEditorSession.prototype, "load").mockResolvedValue({ ok: true, value: null });
  const backend = { close: vi.fn() } as unknown as DocumentBackend;
  const sessions = new DocumentSessions(backend);
  for (const value of sessionsInfo) sessions.acceptOpen(sessions.beginOpen(), { ok: true, value });
  let request = () => {};
  const windowClose = { listen: vi.fn(async (handler: () => void) => { request = handler; return () => {}; }), close: vi.fn(async () => {}) };
  const workspace = new DocumentWorkspace(sessions, backend, async () => ({ openDocument: vi.fn() }), windowClose);
  const opener = document.createElement("button");
  document.body.append(opener); opener.focus();
  const view = render(<LanguageProvider language={language} onLanguageChange={() => {}}><Editor workspace={workspace} zoom={100} /></LanguageProvider>);
  unmount = () => view.unmount();
  await act(flush);
  opener.focus();
  return { view, windowClose, workspace, opener, request: () => request() };
}

describe.each([["ko", ko], ["en", en]] as const)("window-close wording (%s)", (language, text) => {
  it.each([
    ["edits", [edited(1)], text["document.discard.windowTitle"], text["document.discard.windowBody"], text["document.discard.windowConfirm"]],
    ["durability", [unconfirmed(1)], text["document.discard.windowDurabilityTitle"], text["document.discard.windowDurabilityBody"], text["document.discard.windowDurabilityConfirm"]],
    ["mixed", [edited(1), unconfirmed(2)], text["document.discard.windowTitle"], text["document.discard.windowMixedBody"], text["document.discard.windowConfirm"]],
  ] as const)("%s: shows its own wording, cancels with focus restored, and confirms once", async (kind, sessions, title, body, confirm) => {
    const t = await setup(language, [...sessions]);
    act(() => { t.request(); t.request(); });
    await act(flush);
    const dialogs = t.view.getAllByRole("alertdialog");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.dataset.windowKind).toBe(kind);
    expect(dialogs[0]).toHaveAccessibleName(title);
    expect(dialogs[0]).toHaveAccessibleDescription(body);
    expect(t.view.getByTestId("discard-confirm")).toHaveTextContent(confirm);
    expect(document.activeElement).toBe(t.view.getByTestId("discard-cancel"));
    fireEvent.keyDown(dialogs[0]!, { key: "Tab" });
    expect(document.activeElement).toBe(t.view.getByTestId("discard-confirm"));
    fireEvent.keyDown(dialogs[0]!, { key: "Escape" });
    await act(flush);
    expect(t.view.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(t.opener);
    expect(t.windowClose.close).not.toHaveBeenCalled();
    act(() => t.request());
    await act(flush);
    fireEvent.click(t.view.getByTestId("discard-confirm"));
    await act(flush);
    expect(t.windowClose.close).toHaveBeenCalledTimes(1);
  });
});

describe("window-close classification", () => {
  it("a clean window closes without a confirmation", async () => {
    const t = await setup("ko", [clean(1)]);
    act(() => t.request());
    await act(flush);
    expect(t.view.queryByRole("alertdialog")).toBeNull();
    expect(t.windowClose.close).toHaveBeenCalledTimes(1);
  });

  it("durability wording never claims edits will be lost or that the file is durable", () => {
    for (const text of [ko, en]) {
      expect(text["document.discard.windowDurabilityBody"]).not.toMatch(/메모리|in-memory|discard/i);
      expect(text["document.discard.windowDurabilityConfirm"]).not.toMatch(/버리|Discard/);
    }
  });

  it("only revision 0 / loadGeneration 0 dirty sessions count as unconfirmed publication", async () => {
    const t = await setup("ko", [unconfirmed(1), edited(2), clean(3), info(4, { dirty: true, loadGeneration: 1 })]);
    expect(t.workspace.windowCloseKind([1])).toBe("durability");
    expect(t.workspace.windowCloseKind([2])).toBe("edits");
    expect(t.workspace.windowCloseKind([4])).toBe("edits"); // loaded once: treat as edits (conservative)
    expect(t.workspace.windowCloseKind([1, 2])).toBe("mixed");
    expect(t.workspace.windowCloseKind([3])).toBeNull();
  });
});
