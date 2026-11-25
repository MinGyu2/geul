import type { RhwpDocument } from "./rhwpModule";
import { canonical } from "./rhwpArtifactIdentity";

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const isIndex = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;

/** Compare every addressable note owner and its complete internal paragraphs across an independent reopen. */
export function rhwpNoteReopenEqual(before: RhwpDocument, after: RhwpDocument): boolean {
  const inventory = (doc: RhwpDocument): string | null => {
    if (!doc.getNoteInventory) return null;
    try {
      const raw = doc.getNoteInventory();
      if (raw.length > 8 * 1024 * 1024) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.every(isObject)) return null;
      const result: JsonObject[] = [];
      const seen = new Set<string>();
      for (const note of parsed as JsonObject[]) {
        if (Object.keys(note).sort().join(",") !== "anchorParagraph,control,controlStates,editableStarts,instanceId,kind,number,ownerPath,paraCount,section,texts,totalTextLen"
          || !isIndex(note.section, 0xffff) || !isIndex(note.anchorParagraph, 0xffff_ffff)
          || !isIndex(note.control, 0xffff) || (note.kind !== "footnote" && note.kind !== "endnote")
          || !isIndex(note.instanceId, 0xffff_ffff) || !isIndex(note.number, 0xffff) || note.number < 1
          || !isIndex(note.paraCount, 100_000) || note.paraCount < 1
          || !isIndex(note.totalTextLen, 2_000_000) || !Array.isArray(note.texts)
          || note.texts.length !== note.paraCount || !note.texts.every(text => typeof text === "string")
          || !Array.isArray(note.editableStarts) || note.editableStarts.length !== note.paraCount
          || !note.editableStarts.every(start => start === null || isIndex(start, 2_000_000))
          || !Array.isArray(note.controlStates) || note.controlStates.length !== note.paraCount
          || !note.controlStates.every(Array.isArray) || !isObject(note.ownerPath)) return null;
        const path = note.ownerPath;
        let pathKey: string;
        if (path.sourceType === "body" && Object.keys(path).sort().join(",") === "sourceType") pathKey = "body";
        else if (path.sourceType === "table" && Object.keys(path).sort().join(",") === "cellControlIndex,cellIndex,cellParaIndex,sourceType"
          && isIndex(path.cellIndex, 0xffff_ffff) && isIndex(path.cellParaIndex, 0xffff_ffff)
          && isIndex(path.cellControlIndex, 0xffff_ffff)) pathKey = `table/${path.cellIndex}/${path.cellParaIndex}/${path.cellControlIndex}`;
        else if (path.sourceType === "shape" && Object.keys(path).sort().join(",") === "sourceType,tbControlIndex,tbParaIndex"
          && isIndex(path.tbParaIndex, 0xffff_ffff) && isIndex(path.tbControlIndex, 0xffff_ffff)) pathKey = `shape/${path.tbParaIndex}/${path.tbControlIndex}`;
        else return null;
        const address = `${note.section}/${note.anchorParagraph}/${note.control}/${pathKey}/${note.kind}`;
        if (seen.has(address)) return null;
        seen.add(address);
        const texts = note.texts as string[];
        if (texts.reduce((sum, text) => sum + Array.from(text).length, 0) !== note.totalTextLen) return null;
        result.push(note);
      }
      return canonical(result);
    } catch { return null; }
  };
  const left = inventory(before), right = inventory(after);
  return left !== null && right !== null && left === right;
}
