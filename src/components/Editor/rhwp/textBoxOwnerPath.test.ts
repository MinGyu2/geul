import { describe, expect, it } from "vitest";
import { hasUnlockedTextBoxOwnerPath, type TextBoxOwnerControl, type TextBoxOwnerList } from "./textBoxOwnerPath";

const control = (list: number, para: number, controlIndex: number, patch: Partial<TextBoxOwnerControl> = {}): TextBoxOwnerControl => ({
  list, para, controlIndex, ctrlId: "gso", userDesc: "사각형", props: { Lock: 0 }, ...patch,
});

const ownerList = (patch: Partial<TextBoxOwnerList> = {}): TextBoxOwnerList => ({
  listId: 2, isCell: false, hostListId: 0, sectionIndex: 0, hostPara: 0, controlIndex: 3, cellIndex: 0, paraCount: 2,
  ...patch,
});

describe("HWPX textbox owner paths", () => {
  it("requires every nested owner to be an unlocked textbox in the exact source list", () => {
    const entries = [
      { controlIndex: 3, cellIndex: 0, cellParaIndex: 1 },
      { controlIndex: 4, cellIndex: 0, cellParaIndex: 0 },
    ];
    const lists = [
      ownerList(),
      ownerList({ listId: 5, hostListId: 2, hostPara: 1, controlIndex: 4, paraCount: 1 }),
    ];
    const controls = [control(0, 0, 3), control(2, 1, 4)];
    expect(hasUnlockedTextBoxOwnerPath(0, 0, 0, entries, lists, controls)).toBe(true);

    expect(hasUnlockedTextBoxOwnerPath(0, 0, 0, entries, lists, [
      control(0, 0, 3, { props: { Lock: 1 } }), controls[1]!,
    ])).toBe(false);
    expect(hasUnlockedTextBoxOwnerPath(0, 0, 0, entries, [
      ...lists.slice(0, 1), lists[1]!, ownerList({ ...lists[1], listId: 5 }),
    ], controls)).toBe(false);
    expect(hasUnlockedTextBoxOwnerPath(0, 0, 0, entries, [
      lists[0]!, { ...lists[1]!, isCell: true },
    ], controls)).toBe(false);
    expect(hasUnlockedTextBoxOwnerPath(0, 0, 0, [
      { ...entries[0]!, cellIndex: 1 }, entries[1]!,
    ], lists, controls)).toBe(false);
  });

  it("accounts for preceding section paragraphs and rejects a wrong host paragraph", () => {
    const entries = [{ controlIndex: 3, cellIndex: 0, cellParaIndex: 1 }];
    const lists = [ownerList({ sectionIndex: 1, hostPara: 0 })];
    const controls = [control(0, 7, 3)];
    expect(hasUnlockedTextBoxOwnerPath(1, 0, 7, entries, lists, controls)).toBe(true);
    expect(hasUnlockedTextBoxOwnerPath(1, 0, 6, entries, lists, controls)).toBe(false);
    expect(hasUnlockedTextBoxOwnerPath(0, 0, 7, entries, lists, controls)).toBe(false);
  });
});
