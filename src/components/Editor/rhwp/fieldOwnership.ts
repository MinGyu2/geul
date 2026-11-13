/** Explicit field-range/control linkage from RHWP. A paragraph may own several
 * non-overlapping fields; neither kind nor inventory order establishes ownership. */
type Entry = Record<string, unknown>;
const index = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export function paragraphFieldMap(controls: Entry[], fields: Entry[], list: number, paragraph: number): Map<Entry, Entry> {
  const owned = controls.filter(c => c.list === list && c.para === paragraph);
  const ranges = fields.filter(f => f.listId === list && f.paraInList === paragraph && f.cellField === false);
  const result = new Map<Entry, Entry>(), ids = new Set<number>(), indices = new Set<number>();
  let end = 0, endPos = 0, previousControl = -1;
  for (const f of ranges.toSorted((a, b) => Number(a.controlIndex) - Number(b.controlIndex))) {
    if (!index(f.fieldId) || f.fieldId === 0 || ids.has(f.fieldId) || !index(f.controlIndex) || indices.has(f.controlIndex)
      || !index(f.controlPos) || !index(f.startPos) || !index(f.endPos) || !index(f.startCharIdx) || !index(f.endCharIdx)
      || f.controlIndex <= previousControl || f.startCharIdx < end || f.endCharIdx < f.startCharIdx
      || f.controlPos < endPos || f.startPos !== f.controlPos + 8 || f.endPos < f.startPos
      || typeof f.value !== "string" || Array.from(f.value).length !== f.endCharIdx - f.startCharIdx) throw new Error("field range linkage");
    const matches = owned.filter(c => c.ctrlId === "" && c.controlIndex === f.controlIndex && c.pos === f.controlPos);
    if (matches.length !== 1) throw new Error("field control linkage");
    ids.add(f.fieldId); indices.add(f.controlIndex); result.set(matches[0]!, f);
    end = f.endCharIdx; endPos = f.endPos + 8; previousControl = f.controlIndex;
  }
  if (owned.some(c => c.ctrlId === "" && !result.has(c))) throw new Error("unmatched field control");
  return result;
}
