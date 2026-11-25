import { describe, expect, it, vi } from "vitest";
import type { RhwpDocument } from "./rhwpModule";
import { flush, info, ok, readySession } from "./testing";

function installEndnote(doc: RhwpDocument, ownerPath: { sourceType: "body" } | {
  sourceType: "table"; cellIndex: number; cellParaIndex: number; cellControlIndex: number;
} = { sourceType: "body" }) {
  const renderedDocument = doc as RhwpDocument & { paragraphs: string[] };
  let noteTexts = ["  note text"];
  const snapshots = new Map<number, string[]>();
  let nextSnapshot = 0;
  const hit = (patch: Record<string, unknown> = {}) => JSON.stringify({
    hit: true, kind: "endnote", section: 0, anchorParagraph: 0, control: 1,
    ownerPath, instanceId: 52, number: 1, noteParagraph: 0, noteOffset: 2,
    renderSection: 0, renderParagraph: 1, renderParagraphBase: 1,
    renderPrefixLength: 3, sourceLeadingSpaces: 2, viewPage: 0, ...patch,
  });
  const noteInfo = () => JSON.stringify({
    ok: true, kind: "endnote", instanceId: 52, number: 1, paraCount: noteTexts.length,
    totalTextLen: noteTexts.reduce((sum, text) => sum + Array.from(text).length, 0),
    texts: noteTexts, editableStarts: noteTexts.map(() => 2), controlStates: noteTexts.map(() => []),
  });
  Object.assign(doc, {
    getParagraphCount: vi.fn(() => 1),
    hitTest: vi.fn(() => JSON.stringify({ sectionIndex: 0, paragraphIndex: 1, charOffset: 3 })),
    getEndnoteHitInfo: vi.fn((_section: number, _paragraph: number, renderOffset: number, _page: number) => hit({
      noteOffset: renderOffset <= 3 ? 2 : 2 + renderOffset - 3,
    })),
    getNoteInfo: vi.fn(noteInfo),
    getEndnoteEditInfo: vi.fn((_section: number, _paragraph: number, _control: number, path: string) =>
      JSON.stringify({ ok: true, kind: "endnote", pageNum: 0, virtualParaIndex: 1, ownerPath: JSON.parse(path) })),
    insertTextInNote: vi.fn((_kind: string, _section: number, _paragraph: number, _control: number,
      _ownerPath: string, _instanceId: number, _number: number, noteParagraph: number, offset: number, text: string) => {
      const chars = Array.from(noteTexts[noteParagraph]!);
      chars.splice(offset, 0, ...Array.from(text));
      noteTexts[noteParagraph] = chars.join("");
      renderedDocument.paragraphs[1] = `1) ${noteTexts[0]!.slice(2)}`;
      return "{\"ok\":true}";
    }),
    getCursorRectInNote: vi.fn(() => JSON.stringify({ pageIndex: 0, x: 50, y: 40, height: 12 })),
    getCursorRectInOwnedEndnote: vi.fn(() => JSON.stringify({ pageIndex: 0, x: 50, y: 40, height: 12 })),
    moveVertical: vi.fn(() => JSON.stringify({
      sectionIndex: 0, paragraphIndex: 1, charOffset: 9, pageIndex: 0, preferredX: 35,
    })),
    snapshotCapacity: () => 100,
    saveSnapshot: () => {
      const id = nextSnapshot++;
      snapshots.set(id, [...noteTexts]);
      return id;
    },
    restoreSnapshot: (id: number) => {
      const saved = snapshots.get(id);
      if (!saved) throw new Error("missing endnote test snapshot");
      noteTexts = [...saved];
      renderedDocument.paragraphs[1] = `1) ${noteTexts[0]!.slice(2)}`;
      return "{\"ok\":true}";
    },
    discardSnapshot: (id: number) => { snapshots.delete(id); },
  });
  return {
    get texts() { return [...noteTexts]; },
    setHit: (patch: Record<string, unknown>) => {
      (doc.getEndnoteHitInfo as ReturnType<typeof vi.fn>).mockImplementation(() => hit(patch));
    },
  };
}

describe("RHWP endnote editor routing", () => {
  it("edits the exact virtual endnote owner and restores it through Undo/Redo", async () => {
    const { editor, doc, take } = await readySession(["body stays put", "1) note text"]);
    const note = installEndnote(doc as unknown as RhwpDocument);
    const engine = doc as unknown as RhwpDocument;
    const bodyInsert = vi.spyOn(doc, "insertText");

    expect(editor.pointAt(0, 50, 40, false)).toBe(true);
    expect(editor.caret.note).toMatchObject({ kind: "endnote", anchorParagraph: 0, control: 1, instanceId: 52, number: 1 });
    expect(editor.typeText("X")).toBe(true);
    expect(note.texts).toEqual(["  Xnote text"]);
    expect(doc.paragraphs[0]).toBe("body stays put");
    expect(bodyInsert).not.toHaveBeenCalled();
    expect(engine.insertTextInNote).toHaveBeenCalledWith("endnote", 0, 0, 1, '{"sourceType":"body"}', 52, 1, 0, 2, "X");
    expect(editor.moveVertical(1, false)).toBe(true);
    expect(editor.caret.offset).toBe(8);
    expect(engine.moveVertical).toHaveBeenCalledWith(0, 1, 4, 1, -1, 0xffffffff, 0, 0, 0);
    expect(editor.moveLineEdge("end", false)).toBe(true);
    expect(editor.caret.offset).toBe(note.texts[0]!.length);
    expect(editor.moveLineEdge("start", false)).toBe(true);
    expect(editor.caret.offset).toBe(2);

    take("commit").reply(ok(info({ state: "ready", revision: 1, dirty: true, sequence: 3, loadGeneration: 1 })));
    await flush();
    expect(editor.undo()).toBe(true);
    expect(note.texts).toEqual(["  note text"]);
    take("commit").reply(ok(info({ state: "ready", revision: 2, dirty: true, sequence: 4, loadGeneration: 1 })));
    await flush();
    expect(editor.redo()).toBe(true);
    expect(note.texts).toEqual(["  Xnote text"]);
    take("commit").reply(ok(info({ state: "ready", revision: 3, dirty: true, sequence: 5, loadGeneration: 1 })));
    await flush();
  });

  it("edits a table-owned endnote through its exact owner path", async () => {
    const ownerPath = { sourceType: "table" as const, cellIndex: 2, cellParaIndex: 0, cellControlIndex: 0 };
    const { editor, doc } = await readySession(["body stays put", "3) table note text"]);
    const note = installEndnote(doc as unknown as RhwpDocument, ownerPath);
    const engine = doc as unknown as RhwpDocument;
    const bodyInsert = vi.spyOn(doc, "insertText");

    expect(editor.pointAt(0, 50, 40, false)).toBe(true);
    expect(editor.caret.note).toMatchObject({ kind: "endnote", ownerPath, instanceId: 52, number: 1 });
    expect(editor.caretRect()).toMatchObject({ page: 0, x: 50, y: 40, height: 12 });
    expect(engine.getCursorRectInOwnedEndnote).toHaveBeenCalledWith(0, 0, 1,
      JSON.stringify(ownerPath), 0, 2);
    expect(editor.typeText("X")).toBe(true);
    expect(engine.insertTextInNote).toHaveBeenCalledWith("endnote", 0, 0, 1,
      JSON.stringify(ownerPath), 52, 1, 0, 2, "X");
    expect(doc.paragraphs[0]).toBe("body stays put");
    expect(bodyInsert).not.toHaveBeenCalled();
    expect(note.texts).toEqual(["  Xnote text"]);
  });

  it.each([
    ["footnote kind", { kind: "footnote" }],
    ["malformed table owner", { ownerPath: { sourceType: "table", cellIndex: 0, cellParaIndex: 0 } }],
  ])("rejects a %s hit without falling through to body text", async (_label, hit) => {
    const { editor, doc } = await readySession(["body stays put", "1) note text"]);
    const note = installEndnote(doc as unknown as RhwpDocument);
    note.setHit(hit);
    const bodyInsert = vi.spyOn(doc, "insertText");

    expect(editor.pointAt(0, 50, 40, false)).toBe(false);
    expect(editor.caret.note).toBeUndefined();
    expect(doc.paragraphs[0]).toBe("body stays put");
    expect(note.texts).toEqual(["  note text"]);
    expect(bodyInsert).not.toHaveBeenCalled();
  });
});
