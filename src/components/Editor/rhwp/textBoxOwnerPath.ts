export interface TextBoxPathEntry {
  controlIndex: number;
  cellIndex: number;
  cellParaIndex: number;
}

export interface TextBoxOwnerList {
  listId: number;
  isCell: boolean;
  hostListId: number;
  sectionIndex: number;
  hostPara: number;
  controlIndex: number;
  cellIndex: number;
  paraCount: number;
}

export interface TextBoxOwnerControl {
  list: number;
  para: number;
  controlIndex: number;
  ctrlId: string;
  userDesc: string;
  props?: { Lock?: number };
}

/** Prove a complete address chain belongs to unlocked textbox owners in one section. */
export function hasUnlockedTextBoxOwnerPath(
  section: number,
  paragraph: number,
  firstListParagraphOffset: number,
  entries: readonly TextBoxPathEntry[],
  lists: readonly TextBoxOwnerList[],
  controls: readonly TextBoxOwnerControl[],
): boolean {
  if (![section, paragraph, firstListParagraphOffset].every(Number.isSafeInteger)
    || section < 0 || paragraph < 0 || firstListParagraphOffset < 0
    || entries.length < 1 || entries.length > 64) return false;

  let currentList = 0;
  let currentPara = paragraph + firstListParagraphOffset;
  let localHostPara = paragraph;
  for (const owner of entries) {
    if (![owner.controlIndex, owner.cellParaIndex].every(Number.isSafeInteger)
      || owner.controlIndex < 0 || owner.cellIndex !== 0 || owner.cellParaIndex < 0) return false;

    const ownerControl = controls.filter(control => control.list === currentList
      && control.para === currentPara && control.controlIndex === owner.controlIndex);
    if (ownerControl.length !== 1 || ownerControl[0]!.ctrlId !== "gso"
      || ownerControl[0]!.props?.Lock !== 0
      || !["사각형", "글상자"].includes(ownerControl[0]!.userDesc)) return false;

    const ownerLists = lists.filter(list => !list.isCell && list.hostListId === currentList
      && list.sectionIndex === section && list.hostPara === localHostPara
      && list.controlIndex === owner.controlIndex && list.cellIndex === owner.cellIndex);
    if (ownerLists.length !== 1) return false;
    const childList = ownerLists[0]!;
    if (!Number.isSafeInteger(childList.listId) || childList.listId <= 0
      || !Number.isSafeInteger(childList.paraCount) || owner.cellParaIndex >= childList.paraCount
      || lists.filter(list => list.listId === childList.listId).length !== 1) return false;

    currentList = childList.listId;
    currentPara = owner.cellParaIndex;
    localHostPara = owner.cellParaIndex;
  }
  return true;
}
