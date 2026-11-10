// Evidence stages for the HWP sample compatibility matrix (v2). Pure helpers over an RHWP document:
// an operation is counted only after its API result is valid AND the intended effect is observed, a
// reopen only after a fresh instance of the exact exported bytes compares equal with complete evidence,
// and T009 / publication results are classified without promoting a weaker stage to a stronger one.
import { createHash } from "node:crypto";
import {
  HWP_TABLE_NORMALIZATION, hwpReopenEqual, hwpReopenModel, insertedBasicTable, insertedInlinePicture,
} from "../../src/components/Editor/rhwp/hwpReopenModel";
import type { RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";

export type Status = "PASS" | "FAIL" | "NOT_RUN" | "UNSUPPORTED" | "ERROR";
export interface Stage { status: Status; reason?: string; detail?: Record<string, unknown> }
export type Operation = "text" | "table" | "picture" | "bullets";
export const OPERATIONS: readonly Operation[] = ["text", "table", "picture", "bullets"];
export const TEXT_MARKER = "⟦geul-matrix⟧";
export const TABLE_SIZE = { rows: 2, cols: 2 } as const;
export type MatrixDocument = RhwpDocument & {
  getControls(): string; getTextFileText(): string;
  exportHwpWithReport(): { takeBytes(): Uint8Array; contentLoss(): string; free(): void };
};
const CFB = "d0cf11e0a1b11ae1";
const pass = (detail?: Record<string, unknown>): Stage => ({ status: "PASS", ...(detail ? { detail } : {}) });
const fail = (reason: string, detail?: Record<string, unknown>): Stage => ({ status: "FAIL", reason, ...(detail ? { detail } : {}) });
const error = (reason: string, cause: unknown): Stage => ({ status: "ERROR", reason, detail: { error: String(cause).slice(0, 160) } });
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Parse an engine JSON result; "valid" requires ok === true (and the given safe-integer fields). */
function engineResult(raw: unknown, fields: string[] = []): { valid: boolean; value: Record<string, unknown> | null } {
  let value: unknown;
  try { value = typeof raw === "string" ? JSON.parse(raw) : null; } catch { return { valid: false, value: null }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, value: null };
  const v = value as Record<string, unknown>;
  return { valid: v.ok === true && fields.every(f => Number.isSafeInteger(v[f]) && (v[f] as number) >= 0), value: v };
}
const controls = (d: MatrixDocument) => JSON.parse(d.getControls()) as { ctrlId: string; userDesc: string; para: number; controlIndex: number; list: number }[];
const paragraphText = (d: MatrixDocument, p: number) => d.getTextRange(0, p, 0, d.getParagraphLength(0, p));
const head = (d: MatrixDocument, p: number) => JSON.parse(d.getParaPropertiesAt!(0, p)) as { headType: string; numberingId: number; paraLevel: number };

export interface OperationResult { engine: Stage; mutation: Stage }
/**
 * Execute one operation on a fresh document and prove its intended effect. `engine` covers the API calls
 * and their result values; `mutation` the observable change (before/after). A thrown API is ERROR, an
 * invalid result FAIL; a sample with no applicable target is UNSUPPORTED (never counted as a success).
 */
export function runOperation(d: MatrixDocument, op: Operation, picture: Uint8Array): OperationResult {
  const notRun: Stage = { status: "NOT_RUN" };
  const before = { paragraphs: d.getParagraphCount(0), controls: controls(d), text0: paragraphText(d, 0) };
  try {
    if (op === "text") {
      const r = engineResult(d.insertText(0, 0, 0, TEXT_MARKER));
      if (!r.valid) return { engine: fail("apiResult", { result: r.value }), mutation: notRun };
      const after = paragraphText(d, 0);
      if (d.getParagraphCount(0) !== before.paragraphs) return { engine: pass(), mutation: fail("paragraphCountChanged") };
      return { engine: pass(), mutation: after === TEXT_MARKER + before.text0 ? pass() : fail("textNotAtLocation", { before: before.text0.slice(0, 40), after: after.slice(0, 60) }) };
    }
    if (op === "bullets") {
      let target = -1;
      for (let p = 0; p < before.paragraphs && target < 0; p++) if (head(d, p).headType === "None") target = p;
      if (target < 0) return { engine: notRun, mutation: { status: "UNSUPPORTED", reason: "noUnbulletedParagraph" } };
      const id: unknown = d.ensureDefaultBullet!("•");
      if (!Number.isSafeInteger(id) || (id as number) < 1 || (id as number) > 65535) return { engine: fail("bulletId", { id }), mutation: notRun };
      const r = engineResult(d.applyParaFormat!(0, target, JSON.stringify({ headType: "Bullet", numberingId: id, paraLevel: 0 })));
      if (!r.valid) return { engine: fail("apiResult", { result: r.value }), mutation: notRun };
      const after = head(d, target);
      const definition = (JSON.parse(d.getBulletList!()) as { id: number; char: string; rawCode: number }[]).find(b => b.id === after.numberingId);
      if (after.headType !== "Bullet" || after.paraLevel !== 0) return { engine: pass(), mutation: fail("headingNotApplied", { after }) };
      if (!definition || definition.rawCode !== 0x2022) return { engine: pass(), mutation: fail("definitionUnresolved", { numberingId: after.numberingId, definition }) };
      return { engine: pass(), mutation: pass({ paragraph: target, numberingId: after.numberingId }) };
    }
    if (op === "table") {
      const r = engineResult(d.createTable!(0, 0, 0, TABLE_SIZE.rows, TABLE_SIZE.cols), ["paraIdx", "controlIdx"]);
      if (!r.valid) return { engine: fail("apiResult", { result: r.value }), mutation: notRun };
      const { paraIdx, controlIdx } = r.value as { paraIdx: number; controlIdx: number };
      const n = engineResult(d.setTableProperties!(0, paraIdx, controlIdx, JSON.stringify(HWP_TABLE_NORMALIZATION)));
      if (!n.valid) return { engine: fail("normalizationResult", { result: n.value }), mutation: notRun };
      const tables = controls(d).filter(c => c.ctrlId === "tbl").length - before.controls.filter(c => c.ctrlId === "tbl").length;
      if (tables !== 1) return { engine: pass(), mutation: fail("noNewTable", { added: tables }) };
      return { engine: pass(), mutation: insertedBasicTable(d, 0, paraIdx, controlIdx, TABLE_SIZE.rows, TABLE_SIZE.cols)
        ? pass({ paraIdx, controlIdx }) : fail("tableNotBasicNormalized") };
    }
    const r = engineResult(d.insertPicture!(0, 0, 0, "[]", picture, 900, 600, 12, 8, "png", ""), ["paraIdx", "controlIdx"]);
    if (!r.valid) return { engine: fail("apiResult", { result: r.value }), mutation: notRun };
    const { paraIdx, controlIdx } = r.value as { paraIdx: number; controlIdx: number };
    const s = engineResult(d.setPictureProperties!(0, paraIdx, controlIdx, JSON.stringify({ treatAsChar: true })));
    if (!s.valid) return { engine: fail("inlineResult", { result: s.value }), mutation: notRun };
    const pictures = controls(d).filter(c => c.userDesc === "그림").length - before.controls.filter(c => c.userDesc === "그림").length;
    if (pictures !== 1) return { engine: pass(), mutation: fail("noNewPicture", { added: pictures }) };
    if (!insertedInlinePicture(d, 0, paraIdx, controlIdx)) return { engine: pass(), mutation: fail("pictureNotInline") };
    const stored = d.getControlImageData!(0, paraIdx, "[]", controlIdx) as Uint8Array;
    if (sha256(stored) !== sha256(picture)) return { engine: pass(), mutation: fail("resourceMismatch") };
    return { engine: pass(), mutation: pass({ paraIdx, controlIdx, imageSha256: sha256(stored) }) };
  } catch (cause) {
    return { engine: error("engineThrew", cause), mutation: notRun };
  }
}

export interface Exported { stage: Stage; bytes?: Uint8Array; loss?: string; lossCount?: number }
export function exportStage(d: MatrixDocument): Exported {
  try {
    const e = d.exportHwpWithReport();
    let bytes: Uint8Array, loss: string;
    try { loss = e.contentLoss(); bytes = e.takeBytes(); } finally { e.free(); }
    const report = JSON.parse(loss) as { count?: unknown };
    if (Buffer.from(bytes.subarray(0, 8)).toString("hex") !== CFB) return { stage: fail("notCfb"), bytes, loss };
    const lossCount = Number.isSafeInteger(report.count) ? report.count as number : -1;
    return { stage: lossCount === 0 ? pass({ sha256: sha256(bytes), bytes: bytes.length }) : fail("contentLoss", { lossCount }), bytes, loss, lossCount };
  } catch (cause) { return { stage: error("exportThrew", cause) }; }
}

/**
 * Open the exact bytes in a fresh instance and compare with the live model: format, pages, text, raw
 * controls and the detailed HWP model (hwpReopenEqual with the original's structure as baseline, so a
 * changed structure also needs complete evidence on both sides). Releases the fresh document.
 */
export function reopenStage(live: MatrixDocument, bytes: Uint8Array, open: (b: Uint8Array) => MatrixDocument, baseline: string): Stage {
  let fresh: MatrixDocument | null = null;
  try {
    try { fresh = open(bytes); } catch (cause) { return error("freshOpenFailed", cause); }
    if (fresh.getSourceFormat() !== "hwp") return fail("formatMismatch");
    if (fresh.pageCount() !== live.pageCount()) return fail("pagesMismatch");
    if (fresh.getTextFileText() !== live.getTextFileText()) return fail("textMismatch");
    if (fresh.getControls() !== live.getControls()) return fail("controlsMismatch");
    let a, b;
    try { a = hwpReopenModel(live); b = hwpReopenModel(fresh); } catch (cause) { return error("modelEvidenceInvalid", cause); }
    if (!a.complete || !b.complete) return fail("modelIncomplete", { live: a.complete, reopened: b.complete });
    return hwpReopenEqual(a, b, baseline) ? pass() : fail("modelMismatch");
  } finally { fresh?.free(); }
}

export type T009Class = "RAW_T009_CANDIDATE" | "RAW_T009_CANDIDATE_PREVIEW" | "T009_REJECTED" | "NOT_ELIGIBLE" | "NOT_VERIFIED";
export interface Finding { code: string; part?: string }
/** Raw T009 classification of a verified mutation; `findings` null = checker not run. */
export function classifyT009(mutation: Stage, reopen: Stage, findings: Finding[] | null): { class: T009Class; stage: Stage } {
  if (mutation.status !== "PASS") return { class: "NOT_ELIGIBLE", stage: { status: "NOT_RUN", reason: "mutationNotVerified" } };
  if (reopen.status !== "PASS") return { class: "NOT_VERIFIED", stage: { status: "NOT_RUN", reason: "reopenNotVerified" } };
  if (!findings) return { class: "NOT_VERIFIED", stage: { status: "NOT_RUN", reason: "checkerNotRun" } };
  const codes = findings.map(f => f.code);
  if (codes.length === 0) return { class: "RAW_T009_CANDIDATE", stage: pass() };
  if (codes.every(c => c === "previewStale")) return { class: "RAW_T009_CANDIDATE_PREVIEW", stage: pass({ previewStale: codes.length }) };
  return { class: "T009_REJECTED", stage: fail("t009Rejected", { codes: [...new Set(codes)].sort() }) };
}

export interface PublicationEntry { id: string; durable?: boolean; dirty?: boolean; previewRegenerated?: boolean; savedFileCheck?: { outcome?: string }; publishedSha256?: string; publicationPrevented?: boolean; originalIntact?: boolean }
/**
 * Classify the production publication of a raw candidate from the Rust service record and the published
 * file actually present. Only a durable, clean, safe-checked record whose published file exists and hashes
 * as recorded is PASS; a missing record is NOT_RUN; anything weaker is FAIL.
 */
export function classifyPublication(entry: PublicationEntry | undefined, published: Uint8Array | null): Stage {
  if (!entry) return { status: "NOT_RUN", reason: "publicationNotRun" };
  if (entry.publicationPrevented) return fail("publicationRefused", { originalIntact: entry.originalIntact === true });
  if (entry.durable !== true || entry.dirty !== false || entry.savedFileCheck?.outcome !== "safe") return fail("publicationNotDurable");
  if (!published) return fail("noPublishedFile");
  if (entry.publishedSha256 !== sha256(published)) return fail("publishedFileMismatch");
  return pass({ publishedSha256: entry.publishedSha256, previewRegenerated: entry.previewRegenerated === true });
}
