import { describe, expect, it, vi } from "vitest";
import type { RhwpDocument } from "./rhwpModule";
import { RhwpText, sameContext, type DocPosition } from "./rhwpText";

const noteOwner = {
  ok: true, kind: "footnote", sectionIdx: 1, paraIdx: 4, controlIdx: 2,
  sourceType: "body", ownerPath: { sourceType: "body" }, editable: true, noteInstanceId: 77, noteNumber: 1, noteParaCount: 2,
};
const noteInfo = JSON.stringify({
  ok: true, kind: "footnote", instanceId: 77, number: 1, paraCount: 2,
  totalTextLen: 5, texts: ["abc", "de"], editableStarts: [0, 0], controlStates: [[], []],
});
const hit = JSON.stringify({
  hit: true, fnParaIndex: 0, charOffset: 1, footnoteIndex: 0,
  cursorRect: { pageIndex: 3, x: 10, y: 20, height: 12 },
});

function fixture(owner: Record<string, unknown> = noteOwner, info = noteInfo) {
  const doc = {
    getPageFootnoteInfo: vi.fn(() => JSON.stringify(owner)),
    getNoteInfo: vi.fn(() => info),
    getFootnoteViewAddress: vi.fn((section: number, paragraph: number, control: number,
      instanceId: number, number: number, noteParaIdx: number, _offset: number, _preferredPage: number, ownerPath: string) => JSON.stringify({
      ok: true, pageNum: 3, footnoteIndex: 0, sectionIdx: section, paraIdx: paragraph, controlIdx: control,
      instanceId, number, noteParaIdx, ownerPath: JSON.parse(ownerPath),
    })),
    insertTextInNote: vi.fn(() => "{\"ok\":true}"),
    insertText: vi.fn(() => "{\"ok\":true}"),
  };
  return { doc, text: new RhwpText(doc as unknown as RhwpDocument) };
}

describe("RHWP footnote owner addressing", () => {
  it("resolves the page-local hit through the exact direct-body note and preserves note-local offsets", () => {
    const { doc, text } = fixture();
    const at = text.footnotePosition(hit, 3);
    expect(at).toMatchObject({ section: 1, paragraph: 0, offset: 1, note: {
      kind: "footnote", section: 1, anchorParagraph: 4, control: 2, instanceId: 77, number: 1,
    } });
    expect(at && text.paragraphCount(at)).toBe(2);
    expect(at && text.paragraphLength(at)).toBe(3);
    expect(at && text.text(at, 2)).toBe("bc");
    expect(doc.getNoteInfo).toHaveBeenCalledWith("footnote", 1, 4, 2, '{"sourceType":"body"}');
    expect(doc.getFootnoteViewAddress).toHaveBeenCalledWith(1, 4, 2, 77, 1, 0, 1, 3, '{"sourceType":"body"}');
  });

  it("rejects non-body sources, stale identities, invalid paragraphs, and body/note context aliases", () => {
    const nested = fixture({ ...noteOwner, sourceType: "table" });
    expect(nested.text.footnotePosition(hit, 3)).toBeNull();
    const mismatch = fixture({ ...noteOwner, noteInstanceId: 78 });
    expect(mismatch.text.footnotePosition(hit, 3)).toBeNull();
    const badNumber = fixture({ ...noteOwner, noteNumber: 2 });
    expect(badNumber.text.footnotePosition(hit, 3)).toBeNull();
    const protectedControl = fixture(noteOwner, JSON.stringify({
      ...JSON.parse(noteInfo), editableStarts: [null, 0],
    }));
    expect(protectedControl.text.footnotePosition(hit, 3)).toBeNull();
    const numbered = fixture(noteOwner, JSON.stringify({
      ...JSON.parse(noteInfo), editableStarts: [2, 0],
    }));
    expect(numbered.text.footnotePosition(hit, 3)).toBeNull();
    expect(numbered.text.footnotePosition(JSON.stringify({ ...JSON.parse(hit), charOffset: 2 }), 3)).not.toBeNull();
    const badPara = fixture();
    expect(badPara.text.footnotePosition(JSON.stringify({
      ...JSON.parse(hit), fnParaIndex: 2,
    }), 3)).toBeNull();

    const first = nested.text.footnotePosition(hit, 3) ?? fixture().text.footnotePosition(hit, 3)!;
    const sameNote: DocPosition = { ...first, note: { ...first.note! } };
    const otherNote: DocPosition = { ...first, note: { ...first.note!, instanceId: 78 } };
    const otherOwnerPath: DocPosition = { ...first, note: { ...first.note!, ownerPath: {
      sourceType: "table", cellIndex: 0, cellParaIndex: 0, cellControlIndex: 0,
    } } };
    const wrongSection: DocPosition = { ...first, section: 2 };
    const body: DocPosition = { section: first.section, paragraph: first.paragraph, offset: first.offset };
    expect(fixture().text.ownsNote(wrongSection)).toBe(false);
    expect(sameContext(first, sameNote)).toBe(true);
    expect(sameContext(first, otherNote)).toBe(false);
    expect(sameContext(first, otherOwnerPath)).toBe(false);
    expect(sameContext(first, wrongSection)).toBe(false);
    expect(sameContext(first, body)).toBe(false);
  });

  it("dispatches edits with note identity and never falls through to the body API", () => {
    const { doc, text } = fixture();
    const at = text.footnotePosition(hit, 3)!;
    text.insert(at, "X");
    expect(doc.insertTextInNote).toHaveBeenCalledWith("footnote", 1, 4, 2, '{"sourceType":"body"}', 77, 1, 0, 1, "X");
    expect(doc.insertText).not.toHaveBeenCalled();

    const protectedControl = fixture(noteOwner, JSON.stringify({
      ...JSON.parse(noteInfo), editableStarts: [null, 0],
    }));
    const protectedAt = { ...at, note: { ...at.note! } };
    expect(protectedControl.text.canInsertText(protectedAt)).toBe(false);
    expect(() => protectedControl.text.insert(protectedAt, "X")).toThrow();
    expect(protectedControl.doc.insertTextInNote).not.toHaveBeenCalled();

    const stale = { ...at, note: { ...at.note!, instanceId: 78 } };
    expect(text.canInsertText(stale)).toBe(false);
    expect(() => text.insert(stale, "Y")).toThrow();
    expect(doc.insertText).not.toHaveBeenCalled();
  });

  it("retains a table-cell footnote path from hit test through its typed mutation", () => {
    const ownerPath = { sourceType: "table", cellIndex: 2, cellParaIndex: 1, cellControlIndex: 3 };
    const owner = { ...noteOwner, sourceType: "table", ownerPath };
    const { doc, text } = fixture(owner);
    const at = text.footnotePosition(hit, 3);
    expect(at?.note?.ownerPath).toEqual(ownerPath);
    expect(at && text.ownsNote(at)).toBe(true);
    text.insert(at!, "T");
    expect(doc.getNoteInfo).toHaveBeenCalledWith("footnote", 1, 4, 2, JSON.stringify(ownerPath));
    expect(doc.insertTextInNote).toHaveBeenCalledWith("footnote", 1, 4, 2, JSON.stringify(ownerPath), 77, 1, 0, 1, "T");
  });
});
