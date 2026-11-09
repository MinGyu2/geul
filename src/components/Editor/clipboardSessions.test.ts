import { describe, expect, it, vi } from "vitest";
import { readyDocx, flush as docxFlush } from "./wordcraft/testing";
import { readySession, flush } from "./rhwp/testing";
import { RhwpText, type DocPosition } from "./rhwp/rhwpText";
import type { RhwpDocument } from "./rhwp/rhwpModule";
import type { PlainClipboard } from "../../commands/clipboard";

const clipboard = (text = ""): PlainClipboard => ({ readText: vi.fn(async () => text), writeText: vi.fn(async () => {}) });
const owner = () => true;

describe("DOCX clipboard uses session queue", () => {
  it("reads complete multi-paragraph selection and cuts only after writing", async () => {
    const text = ["한😀".repeat(400), "끝\t글"];
    const { editor, fake } = await readyDocx(text); editor.selectAll(); await docxFlush();
    const clip = clipboard(), before = editor.revision;
    expect(await editor.executeClipboard("edit.copy", owner, clip)).toBe(true);
    expect(clip.writeText).toHaveBeenCalledWith(text.join("\n")); expect(editor.revision).toBe(before);
    expect(fake.paragraphs).toEqual(text);
    expect(await editor.executeClipboard("edit.cut", owner, clip)).toBe(true); await docxFlush();
    expect(fake.paragraphs).toEqual([""]); expect(editor.revision).toBe(before + 1);
  });
  it("selection movement during write cancels deletion even if selection returns", async () => {
    const { editor, fake } = await readyDocx(["한글"]); editor.selectAll(); await docxFlush();
    let finish!: () => void;
    const clip = clipboard(); clip.writeText = vi.fn(() => new Promise<void>(r => { finish = r; }));
    const result = editor.executeClipboard("edit.cut", owner, clip); await docxFlush();
    editor.move("docStart", false); editor.selectAll(); await docxFlush(); finish();
    expect(await result).toBe(false); expect(fake.paragraphs).toEqual(["한글"]);
  });
  it("clipboard failure preserves selection and revision", async () => {
    const { editor, fake } = await readyDocx(["keep"]); editor.selectAll(); await docxFlush();
    const before = editor.snapshot(); const clip = clipboard(); clip.writeText = vi.fn(async () => { throw Error("denied"); });
    expect(await editor.executeClipboard("edit.cut", owner, clip)).toBe(false);
    expect(editor.snapshot()).toEqual(before); expect(fake.paragraphs).toEqual(["keep"]);
  });
  it("paste normalizes breaks, replaces selection once, retains tabs/Unicode and rejects controls", async () => {
    const { editor, fake } = await readyDocx(["replace"]); editor.selectAll(); await docxFlush();
    expect(await editor.executeClipboard("edit.paste", owner, clipboard("한😀\r\n\t둘\r셋\n"))).toBe(true); await docxFlush();
    expect(fake.paragraphs).toEqual(["한😀", "\t둘", "셋", ""]);
    const before = [...fake.paragraphs];
    expect(await editor.executeClipboard("edit.paste", owner, clipboard("\uFFFC"))).toBe(false); expect(fake.paragraphs).toEqual(before);
  });
});

describe("RHWP complete text and paragraph-aware paste", () => {
  it("copies forward and backward multi-paragraph Unicode >500 chars without revision/dirty mutation", async () => {
    const text = ["한😀".repeat(400), "끝글"];
    const { editor, doc } = await readySession(text);
    editor.anchor = { section: 0, paragraph: 0, offset: 1 }; editor.caret = { section: 0, paragraph: 1, offset: 1 };
    const before = editor.localRevision; const clip = clipboard();
    expect(await editor.executeClipboard("edit.copy", owner, clip)).toBe(true);
    expect(clip.writeText).toHaveBeenLastCalledWith([...text[0]!].slice(1).join("") + "\n끝");
    [editor.anchor, editor.caret] = [editor.caret, editor.anchor];
    expect(await editor.executeClipboard("edit.copy", owner, clip)).toBe(true);
    expect(editor.localRevision).toBe(before); expect(doc.paragraphs).toEqual(text);
  });
  it("cut retains data on failure and deletes via one existing mutation on success", async () => {
    const { editor, doc } = await readySession(["한글", "둘"]);
    editor.caret = { section: 0, paragraph: 1, offset: 1 };
    const clip = clipboard(); clip.writeText = vi.fn(async () => { throw Error(); });
    expect(await editor.executeClipboard("edit.cut", owner, clip)).toBe(false); expect(doc.paragraphs).toEqual(["한글", "둘"]);
    expect(await editor.executeClipboard("edit.cut", owner, clipboard())).toBe(true);
    expect(doc.paragraphs).toEqual([""]); expect(editor.localRevision).toBe(1);
  });
  it("normalizes paragraph breaks and replaces selection with one revision", async () => {
    const { editor, doc } = await readySession(["abc", "def"]);
    editor.anchor = { section: 0, paragraph: 0, offset: 1 }; editor.caret = { section: 0, paragraph: 1, offset: 2 };
    expect(await editor.executeClipboard("edit.paste", owner, clipboard("한😀\r\n\t둘\r셋\n"))).toBe(true);
    expect(doc.paragraphs).toEqual(["a한😀", "\t둘", "셋", "f"]); expect(editor.localRevision).toBe(1);
    await flush();
  });
  it("empty/cross-context/object selection is unavailable", async () => {
    const { editor, doc } = await readySession(["abc", "def"]);
    expect(await editor.executeClipboard("edit.copy", owner, clipboard())).toBe(false);
    editor.caret = { section: 1, paragraph: 0, offset: 1 };
    expect(await editor.executeClipboard("edit.copy", owner, clipboard())).toBe(false);
    editor.caret = { section: 0, paragraph: 1, offset: 1 };
    doc.getControls = () => JSON.stringify([{ list: 0, para: 1, controlIndex: 0, ctrlId: "tbl" }]);
    expect(await editor.executeClipboard("edit.cut", owner, clipboard())).toBe(false); expect(doc.paragraphs).toEqual(["abc", "def"]);
  });
  it("supports multi-paragraph text within the same cell and rejects other/nested contexts", () => {
    const cell = { parentParagraph: 0, control: 0, cell: 1, cellParagraph: 0 };
    const a: DocPosition = { section: 0, paragraph: 0, offset: 1, cell };
    const b: DocPosition = { ...a, offset: 1, cell: { ...cell, cellParagraph: 1 } };
    const doc = {
      getControls: () => "[]", getCursorModel: () => JSON.stringify({ lists: [{ listId: 2, isCell: true, sectionIndex: 0, hostListId: 0, hostPara: 0, controlIndex: 0, cellIndex: 1 }] }),
      getCellParagraphCount: () => 2, getCellParagraphLength: () => 2,
      getTextInCell: (_s: number, _p: number, _c: number, _cell: number, p: number, off: number, n: number) => [...["한😀", "글끝"][p]!].slice(off, off + n).join(""),
    } as unknown as RhwpDocument;
    const text = new RhwpText(doc);
    expect(text.selectedText(a, b)).toBe("😀\n글"); expect(text.selectedText(b, a)).toBe("😀\n글");
    expect(text.selectedText(a, { ...b, cell: { ...cell, cell: 2 } })).toBeNull();
  });
});
