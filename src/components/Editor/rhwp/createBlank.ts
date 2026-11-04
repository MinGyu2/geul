import type { RhwpDocument, RhwpModule } from "./rhwpModule";

export type RhwpFormat = "hwp" | "hwpx";
export interface BlankExport {
  bytes: Uint8Array;
  contentLoss: unknown;
}

// A creation-specific bound, independent of the limits for user documents.
export const MAX_BLANK_BYTES = 64 * 1024;

function exportBlank(doc: RhwpDocument, format: RhwpFormat): BlankExport {
  const result = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
  try {
    const raw = result.contentLoss();
    if (raw.length > 1024) throw new Error("blank loss report limit");
    const loss: unknown = JSON.parse(raw);
    if (typeof loss !== "object" || loss === null || Array.isArray(loss)) throw new Error("blank loss report");
    const report = loss as Record<string, unknown>;
    if (Object.keys(report).sort().join(",") !== "count,losses,outputFormat,schemaVersion"
      || report.schemaVersion !== 1 || report.outputFormat !== format || report.count !== 0
      || !Array.isArray(report.losses) || report.losses.length !== 0) throw new Error("blank content loss");
    const bytes = result.takeBytes();
    if (bytes.length === 0 || bytes.length > MAX_BLANK_BYTES) throw new Error("blank size limit");
    const signature = format === "hwp" ? [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] : [0x50, 0x4b, 3, 4];
    if (!signature.every((value, at) => bytes[at] === value)) throw new Error("blank format");
    return { bytes, contentLoss: loss };
  } finally {
    result.free();
  }
}

function blankState(doc: RhwpDocument, format: RhwpFormat): string {
  const inspect = doc as RhwpDocument & {
    getSectionCount(): number; getControls(): string; getTextFileText(): string;
  };
  if (doc.getSourceFormat() !== format || doc.pageCount() !== 1 || inspect.getSectionCount() !== 1
    || doc.getParagraphCount(0) !== 1 || doc.getParagraphLength(0, 0) !== 0
    || JSON.parse(inspect.getTextFileText()) !== "") throw new Error("blank model");
  const controls: unknown = JSON.parse(inspect.getControls());
  if (!Array.isArray(controls) || controls.length !== 2
    || controls.some((value: { ctrlId?: unknown; list?: unknown; para?: unknown }, at) =>
      value.ctrlId !== ["secd", "cold"][at] || value.list !== 0 || value.para !== 0)) throw new Error("blank controls");
  return JSON.stringify({ page: JSON.parse(doc.getPageInfo(0)), controls });
}

/**
 * No bundled user template: initialize explicit defaults in an isolated minimal
 * model, serialize/reopen the internal HWPX seed to establish a valid HWP5 header
 * and section controls, then export and reopen the requested format independently.
 * Rust still authorizes the exact audited blank content before any file write.
 */
export function createRhwpBlank(module: RhwpModule, format: RhwpFormat): BlankExport {
  if (!module.createEmptyDocument) throw new Error("RHWP creation API unavailable");
  const fresh = module.createEmptyDocument();
  let initialized: RhwpDocument | undefined;
  let reopened: RhwpDocument | undefined;
  try {
    if (fresh.findOrCreateFontId("Noto Sans CJK KR") !== 0) throw new Error("blank font");
    for (const result of [
      fresh.applyCharFormat(0, 0, 0, 0, '{"fontSize":1000,"fontIds":[0,0,0,0,0,0,0]}'),
      fresh.applyParaFormat(0, 0, '{"lineSpacing":160,"tabStops":[]}'),
    ]) {
      if ((JSON.parse(result) as { ok?: unknown }).ok !== true) throw new Error("blank defaults");
    }
    if (fresh.createStyle('{"name":"바탕글","englishName":"Normal","type":0,"nextStyleId":0}') !== 0) throw new Error("blank style");
    initialized = module.openDocument(exportBlank(fresh, "hwpx").bytes);
    blankState(initialized, "hwpx");
    const output = exportBlank(initialized, format);
    reopened = module.openDocument(output.bytes);
    const before = blankState(reopened, format);
    // Check a further same-format round trip, without conflating the internal
    // seed's source format with the newly created session's final source format.
    const again = module.openDocument(exportBlank(reopened, format).bytes);
    try {
      if (blankState(again, format) !== before) throw new Error("blank reopen mismatch");
    } finally { again.free(); }
    return output;
  } finally {
    reopened?.free();
    initialized?.free();
    fresh.free();
  }
}
