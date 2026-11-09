// P3-A: native Paste (browser paste/beforeinput/input on the hidden textarea) versus
// ribbon/shortcut Paste (runClipboard: explicit read, async, ownership revalidation).
// Native Paste is synchronous input on the same path as ordinary typing, so it is
// ordered with queued typing and accepted while a commit or save is outstanding,
// exactly like typing. Command Paste reads asynchronously and therefore requires a
// settled, unsaved-in-flight state. Both refuse unsettled IME and protected targets.
// Synthetic DOM events: a state-machine/policy check, not native evidence.
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { documentCommandState } from "../../commands/capability";
import { LanguageProvider } from "../../language/LanguageContext";
import { RhwpSurface } from "./rhwp/RhwpSurface";
import { readySession } from "./rhwp/testing";
import { DocxSurface } from "./wordcraft/DocxSurface";
import { flush, readyDocx, stubScreenContext } from "./wordcraft/testing";

type Input = HTMLTextAreaElement;
const pasteReason = (snapshot: Parameters<typeof documentCommandState>[1]) => {
  const state = documentCommandState("edit.paste", snapshot);
  return state.available ? null : state.reason;
};
function driver(input: Input) {
  const fire = (event: Event) => act(() => void input.dispatchEvent(event));
  const native = (inputType: string, text: string | null, add: string) => {
    const before = new InputEvent("beforeinput", { inputType, data: text, cancelable: true });
    fire(before);
    if (!before.defaultPrevented) input.value += add;
    input.setSelectionRange(input.value.length, input.value.length);
    fire(new InputEvent("input", { inputType, data: text }));
    return before.defaultPrevented;
  };
  return {
    type: (text: string) => native("insertText", text, text),
    paste: (text: string) => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      fire(event);
      return { pasteBlocked: event.defaultPrevented, inputBlocked: native("insertFromPaste", null, text) };
    },
  };
}
const clip = (text: string) => {
  const reads: string[] = [];
  return { reads, clipboard: { readText: async () => { reads.push(text); return text; }, writeText: async () => {} } };
};

describe("RHWP native Paste vs command Paste", () => {
  async function mounted() {
    const t = await readySession(["가나다"]);
    const view = render(<LanguageProvider language="ko" onLanguageChange={() => {}}><RhwpSurface session={t.editor} zoom={100} /></LanguageProvider>);
    const input = view.container.querySelector<Input>(".rhwp-input")!;
    return { ...t, view, input, ...driver(input) };
  }
  const settle = async (t: Awaited<ReturnType<typeof mounted>>) => {
    await act(flush);
    while (t.calls.some(c => c.method === "commit")) {
      const call = t.take("commit");
      call.reply({ ok: true, value: { ...call.args[0] as object } } as never);
      await act(flush);
    }
  };

  it("pending ordinary typing: native Paste keeps queue order exactly once; command Paste refuses without reading", async () => {
    const t = await mounted();
    t.type("a");
    expect(t.editor.snapshot().pending).toBe(true);
    expect(pasteReason(t.editor.snapshot())).toBe("pendingEdits");
    const { reads, clipboard } = clip("WRONG");
    expect(await t.editor.executeClipboard("edit.paste", () => true, clipboard)).toBe(false);
    expect(reads).toEqual([]);
    expect(t.paste("bc")).toEqual({ pasteBlocked: false, inputBlocked: false });
    t.type("d");
    expect(t.editor.documentText()).toBe("abcd가나다");
    expect(t.editor.localRevision).toBe(3);
    void settle;
  });

  it("protected/read-only target: native Paste and command Paste both refuse", async () => {
    const t = await mounted();
    Object.defineProperty(t.editor, "editable", { configurable: true, get: () => false });
    expect(pasteReason(t.editor.snapshot())).toBe("protected");
    expect(t.paste("x")).toEqual({ pasteBlocked: true, inputBlocked: true });
    expect(t.editor.documentText()).toBe("가나다");
  });

  it("unsettled IME: both refuse and nothing replays after settlement", async () => {
    const t = await mounted();
    t.editor.setAwaitingCommit(true);
    const { reads, clipboard } = clip("LATE");
    expect(await t.editor.executeClipboard("edit.paste", () => true, clipboard)).toBe(false);
    expect(t.paste("x")).toEqual({ pasteBlocked: true, inputBlocked: true });
    t.editor.setAwaitingCommit(false);
    await act(flush);
    expect(reads).toEqual([]);
    expect(t.editor.documentText()).toBe("가나다");
  });

  it("save in progress: native Paste is ordinary input (like typing); command Paste refuses without reading", async () => {
    const t = await mounted();
    const saving = t.editor.save();
    await act(flush);
    expect(t.editor.snapshot().saving).toBe(true);
    expect(pasteReason(t.editor.snapshot())).toBe("saving");
    const { reads, clipboard } = clip("WRONG");
    expect(await t.editor.executeClipboard("edit.paste", () => true, clipboard)).toBe(false);
    expect(reads).toEqual([]);
    t.type("a");
    expect(t.paste("b")).toEqual({ pasteBlocked: false, inputBlocked: false });
    expect(t.editor.documentText()).toBe("ab가나다");
    // The save snapshot was taken before these edits: they remain dirty afterwards (T009 unchanged).
    t.take("original").reply({ ok: false, error: { code: "SaveFailure", stage: "preflight" } } as never);
    expect((await saving).ok).toBe(false);
    expect(t.editor.documentText()).toBe("ab가나다");
  });
});

describe("DOCX native Paste vs command Paste", () => {
  async function mounted() {
    stubScreenContext();
    const t = await readyDocx(["가나다"]);
    const view = render(<LanguageProvider language="ko" onLanguageChange={() => {}}><DocxSurface session={t.editor} zoom={100} /></LanguageProvider>);
    await act(flush);
    const input = view.container.querySelector<Input>(".rhwp-input")!;
    return { ...t, view, input, ...driver(input) };
  }

  it("pending backend commit: native Paste keeps order exactly once; command Paste refuses without reading", async () => {
    const t = await mounted();
    t.fake.hold = true;
    t.type("a");
    await act(flush);
    expect(t.editor.snapshot().pending).toBe(true);
    expect(pasteReason(t.editor.snapshot())).toBe("pendingEdits");
    const { reads, clipboard } = clip("WRONG");
    expect(await t.editor.executeClipboard("edit.paste", () => true, clipboard)).toBe(false);
    expect(reads).toEqual([]);
    expect(t.paste("bc")).toEqual({ pasteBlocked: false, inputBlocked: false });
    t.type("d");
    t.fake.hold = false;
    for (let i = 0; i < 10; i++) { t.fake.release(); await act(flush); }
    expect(t.fake.paragraphs).toEqual(["abcd가나다"]);
    expect(t.editor.snapshot().pending).toBe(false);
  });

  it("save in progress: command Paste refuses without reading; native Paste behaves exactly like typing", async () => {
    // The real backend binds a save to the requested revision (T009 ticket + check_revision); the fake does
    // not, so this proves parity with ordinary typing rather than the backend's save guarantee.
    const outcome = async (kind: "type" | "paste") => {
      const t = await mounted();
      t.fake.hold = true;
      const saving = t.editor.save();
      await act(flush);
      expect(t.editor.snapshot().saving).toBe(true);
      expect(pasteReason(t.editor.snapshot())).toBe("saving");
      const { reads, clipboard } = clip("WRONG");
      expect(await t.editor.executeClipboard("edit.paste", () => true, clipboard)).toBe(false);
      expect(reads).toEqual([]);
      if (kind === "type") t.type("b");
      else expect(t.paste("b")).toEqual({ pasteBlocked: false, inputBlocked: false });
      t.fake.hold = false;
      for (let i = 0; i < 10; i++) { t.fake.release(); await act(flush); }
      const result = await saving;
      const value = { ok: result.ok, paragraphs: t.fake.paragraphs, saved: t.fake.saved, dirty: t.sessions.get(1)?.dirty, revision: t.editor.snapshot().revision };
      t.view.unmount();
      return value;
    };
    const typed = await outcome("type");
    expect(typed.paragraphs).toEqual(["b가나다"]);
    expect(await outcome("paste")).toEqual(typed);
  });
});
