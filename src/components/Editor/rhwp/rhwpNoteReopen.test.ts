import { describe, expect, it } from "vitest";
import type { RhwpDocument } from "./rhwpModule";
import { rhwpNoteReopenEqual } from "./rhwpNoteReopen";

function document(note: Record<string, unknown> = {}) {
  const info = {
    section: 0, anchorParagraph: 3, control: 2, ownerPath: { sourceType: "body" },
    kind: "footnote", instanceId: 91, number: 1, paraCount: 2,
    totalTextLen: 12, texts: ["  note", "detail"], editableStarts: [2, 0],
    controlStates: [[{ AutoNumber: { number: 1 } }], []],
    ...note,
  };
  return {
    getNoteInventory: () => JSON.stringify([info]),
  } as unknown as RhwpDocument;
}

describe("RHWP note reopen evidence", () => {
  it("requires stable owner identity, numbering, text, and internal control state to survive reopen", () => {
    expect(rhwpNoteReopenEqual(document(), document())).toBe(true);
    expect(rhwpNoteReopenEqual(document(), document({ instanceId: 92 }))).toBe(false);
    expect(rhwpNoteReopenEqual(document(), document({ number: 2 }))).toBe(false);
    expect(rhwpNoteReopenEqual(document(), document({ texts: ["  note", "changed"], totalTextLen: 13 }))).toBe(false);
    expect(rhwpNoteReopenEqual(document(), document({ controlStates: [[], []] }))).toBe(false);
  });

  it("fails closed when a note response omits internal paragraph evidence", () => {
    const incomplete = document({ controlStates: undefined });
    expect(rhwpNoteReopenEqual(document(), incomplete)).toBe(false);
  });
});
