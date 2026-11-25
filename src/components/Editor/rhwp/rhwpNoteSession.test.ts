import { describe, expect, it, vi } from "vitest";
import { TABLE_CLIPBOARD_MIME } from "../../../commands/tableClipboard";
import type { RhwpDocument } from "./rhwpModule";
import { flush, info, ok, readySession } from "./testing";

function installFootnote(doc: RhwpDocument, initial = ["각주 본문"], sourceType = "body") {
  let noteTexts = [...initial];
  const owner = {
    ok: true, kind: "footnote", sectionIdx: 0, paraIdx: 0, controlIdx: 1,
    sourceType, ownerPath: sourceType === "table"
      ? { sourceType: "table", cellIndex: 0, cellParaIndex: 0, cellControlIndex: 0 }
      : { sourceType: "body" },
    editable: true, noteInstanceId: 41, noteNumber: 1, noteParaCount: noteTexts.length,
  };
  const info = () => JSON.stringify({
    ok: true, kind: "footnote", instanceId: 41, number: 1, paraCount: noteTexts.length,
    totalTextLen: noteTexts.reduce((sum, text) => sum + Array.from(text).length, 0), texts: noteTexts,
    editableStarts: noteTexts.map(() => 0),
    controlStates: noteTexts.map(() => []),
  });
  const snapshots = new Map<number, string[]>();
  let nextSnapshot = 0;
  Object.assign(doc, {
    hitTestInFootnote: vi.fn(() => JSON.stringify({ hit: true, fnParaIndex: 0, charOffset: 2, footnoteIndex: 0,
      cursorRect: { pageIndex: 0, x: 20, y: 40, height: 12 } })),
    getPageFootnoteInfo: vi.fn(() => JSON.stringify(owner)),
    getNoteInfo: vi.fn(info),
    getFootnoteViewAddress: vi.fn((section: number, paragraph: number, control: number,
      instanceId: number, number: number, noteParaIdx: number, _offset: number, preferredPage: number) => JSON.stringify({
      ok: true, pageNum: preferredPage, footnoteIndex: 0, sectionIdx: section, paraIdx: paragraph, controlIdx: control,
      instanceId, noteParaIdx, number, ownerPath: owner.ownerPath,
    })),
    getCursorRectInFootnote: vi.fn(() => JSON.stringify({ pageIndex: 0, x: 20, y: 40, height: 12 })),
    getSelectionRectsInFootnote: vi.fn(() => "[]"),
    insertTextInNote: vi.fn((_kind: string, _section: number, _paragraph: number, _control: number,
      _ownerPath: string, _instanceId: number, _number: number, noteParagraph: number, offset: number, text: string) => {
      const chars = Array.from(noteTexts[noteParagraph]!);
      chars.splice(offset, 0, ...Array.from(text));
      noteTexts[noteParagraph] = chars.join("");
      return "{\"ok\":true}";
    }),
    deleteTextInNote: vi.fn((_kind: string, _section: number, _paragraph: number, _control: number,
      _ownerPath: string, _instanceId: number, _number: number, noteParagraph: number, offset: number, count: number) => {
      const chars = Array.from(noteTexts[noteParagraph]!);
      chars.splice(offset, count);
      noteTexts[noteParagraph] = chars.join("");
      return "{\"ok\":true}";
    }),
    splitParagraphInNote: vi.fn(() => "{\"ok\":true}"),
    mergeParagraphInNote: vi.fn(() => "{\"ok\":true}"),
    snapshotCapacity: () => 100,
    saveSnapshot: () => {
      const id = nextSnapshot++;
      snapshots.set(id, [...noteTexts]);
      return id;
    },
    restoreSnapshot: (id: number) => {
      const saved = snapshots.get(id);
      if (!saved) throw new Error("missing note test snapshot");
      noteTexts = [...saved];
      return "{\"ok\":true}";
    },
    discardSnapshot: (id: number) => { snapshots.delete(id); },
  });
  return { get texts() { return [...noteTexts]; } };
}

describe("RHWP footnote editor routing", () => {
  it("resolves a footnote hit before the current-canvas object-selection path", async () => {
    const { editor, doc } = await readySession(["body stays put"]);
    installFootnote(doc as unknown as RhwpDocument);

    expect(editor.pointAt(0, 20, 40, false, false, true)).toBe(true);
    expect(editor.caret.note).toMatchObject({ section: 0, anchorParagraph: 0, control: 1, instanceId: 41, number: 1 });
    expect(doc.paragraphs).toEqual(["body stays put"]);
  });

  it("edits the exact note address and restores the same note through Undo/Redo", async () => {
    const { editor, doc, take } = await readySession(["body stays put"]);
    const note = installFootnote(doc as unknown as RhwpDocument);
    const engine = doc as unknown as RhwpDocument;
    const bodyInsert = vi.spyOn(doc, "insertText");

    expect(editor.pointAt(0, 20, 40, false)).toBe(true);
    expect(editor.caret.note).toMatchObject({ section: 0, anchorParagraph: 0, control: 1, instanceId: 41, number: 1 });
    expect(editor.typeText("X")).toBe(true);
    expect(note.texts).toEqual(["각주X 본문"]);
    expect(doc.paragraphs).toEqual(["body stays put"]);
    expect(engine.insertTextInNote).toHaveBeenCalledWith("footnote", 0, 0, 1, '{"sourceType":"body"}', 41, 1, 0, 2, "X");
    expect(bodyInsert).not.toHaveBeenCalled();

    const typed = take("commit");
    typed.reply(ok(info({ state: "ready", revision: 1, dirty: true, sequence: 3, loadGeneration: 1 })));
    await flush();
    expect(editor.undo()).toBe(true);
    expect(note.texts).toEqual(["각주 본문"]);
    const undone = take("commit");
    undone.reply(ok(info({ state: "ready", revision: 2, dirty: true, sequence: 4, loadGeneration: 1 })));
    await flush();
    expect(editor.redo()).toBe(true);
    expect(note.texts).toEqual(["각주X 본문"]);
    const redone = take("commit");
    redone.reply(ok(info({ state: "ready", revision: 3, dirty: true, sequence: 5, loadGeneration: 1 })));
    await flush();
  });

  it("rejects inconsistent note ownership without falling through to a body hit", async () => {
    const { editor, doc } = await readySession(["body stays put"]);
    installFootnote(doc as unknown as RhwpDocument, ["malformed owner"], "unknown");
    expect(editor.pointAt(0, 20, 40, false)).toBe(false);
    expect(editor.caret.note).toBeUndefined();
    expect(editor.caret).toMatchObject({ section: 0, paragraph: 0, offset: 0 });
    expect(doc.paragraphs).toEqual(["body stays put"]);
  });

  it("edits a table-cell footnote by its exact cell control path", async () => {
    const { editor, doc, take } = await readySession(["body stays put"]);
    const note = installFootnote(doc as unknown as RhwpDocument, ["표 각주"], "table");
    const engine = doc as unknown as RhwpDocument;
    expect(editor.pointAt(0, 20, 40, false)).toBe(true);
    expect(editor.caret.note?.ownerPath).toEqual({ sourceType: "table", cellIndex: 0, cellParaIndex: 0, cellControlIndex: 0 });
    expect(editor.typeText("T")).toBe(true);
    expect(note.texts).toEqual(["표 T각주"]);
    expect(doc.paragraphs).toEqual(["body stays put"]);
    expect(engine.insertTextInNote).toHaveBeenCalledWith("footnote", 0, 0, 1,
      '{"sourceType":"table","cellIndex":0,"cellParaIndex":0,"cellControlIndex":0}', 41, 1, 0, 2, "T");
    const typed = take("commit");
    typed.reply(ok(info({ state: "ready", revision: 1, dirty: true, sequence: 3, loadGeneration: 1 })));
    await flush();
    expect(editor.undo()).toBe(true);
    expect(note.texts).toEqual(["표 각주"]);
    const undone = take("commit");
    undone.reply(ok(info({ state: "ready", revision: 2, dirty: true, sequence: 4, loadGeneration: 1 })));
    await flush();
    expect(editor.redo()).toBe(true);
    expect(note.texts).toEqual(["표 T각주"]);
    const redone = take("commit");
    redone.reply(ok(info({ state: "ready", revision: 3, dirty: true, sequence: 5, loadGeneration: 1 })));
    await flush();
  });

  it("blocks direct image and structured paste entry points at a note caret", async () => {
    const { editor, doc } = await readySession(["body stays put"]);
    installFootnote(doc as unknown as RhwpDocument);
    expect(editor.pointAt(0, 20, 40, false)).toBe(true);
    const pickImage = vi.fn(async () => null);
    expect(await editor.executeImage(() => true, pickImage)).toBe("stale");
    expect(pickImage).not.toHaveBeenCalled();

    const insertCells = (editor as unknown as { insertStructuredCells(mime: string, data: string): string }).insertStructuredCells;
    const table = JSON.stringify({
      kind: "geul.tableCells", version: 1, sourceFormat: "hwpx", rows: 1, cols: 2,
      cells: [
        { row: 0, col: 0, rowSpan: 1, colSpan: 1, paragraphs: [{ runs: [{ text: "one" }] }] },
        { row: 0, col: 1, rowSpan: 1, colSpan: 1, paragraphs: [{ runs: [{ text: "two" }] }] },
      ],
      plainText: "one\ttwo",
    });
    expect(insertCells.call(editor, TABLE_CLIPBOARD_MIME, table)).toBe("rejected");

    const insertObject = (editor as unknown as { insertStructuredObject(data: string): string }).insertStructuredObject;
    const object = JSON.stringify({
      kind: "geul.object", version: 3, sourceFormat: "hwpx", object: "shape",
      sourceSessionId: 0, sourceGeneration: 0, token: "000000000000000000000001",
    });
    expect(insertObject.call(editor, object)).toBe("rejected");
    expect(doc.paragraphs).toEqual(["body stays put"]);
  });
});
