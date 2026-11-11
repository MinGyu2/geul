// Approval authority is reviewed Git content plus this separately maintained lock, never measurement output.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APPROVED_COUNT = 108;
export const APPROVAL_SHA256 = "37d4f08020cc3505e8ca638f3af5978152d3f1a59d8ffde7e9247374f9ec9f7c";
export const APPROVED_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures/hwp-approved-corpus-108.json");
export const REQUIRED_OPERATIONS = ["text", "table", "picture", "bullets"] as const;
export const digest = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
export interface Identity { name: string; sha256: string }
type ObjectValue = Record<string, unknown>;
export function object(v: unknown): ObjectValue {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected object");
  return v as ObjectValue;
}
function requireIdentity(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
export function identities(value: unknown): Identity[] {
  const docs = object(value).documents;
  requireIdentity(Array.isArray(docs) && docs.length === APPROVED_COUNT, "expected exactly 108 documents");
  const names = new Set<string>(), hashes = new Set<string>();
  return docs.map(value => {
    const { name, sha256 } = object(value);
    requireIdentity(typeof name === "string" && name.normalize("NFC") === name && !/[\\/:]/u.test(name) && ![...name].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      && !/^\.|[. ]$/u.test(name) && name.endsWith(".hwp"), "invalid corpus filename");
    requireIdentity(typeof sha256 === "string" && /^[a-f0-9]{64}$/u.test(sha256), "invalid SHA-256");
    requireIdentity(!names.has(name) && !hashes.has(sha256), "duplicate document identity");
    names.add(name); hashes.add(sha256);
    return { name, sha256 };
  });
}
export function loadApproval(bytes = readFileSync(APPROVED_PATH)): Identity[] {
  requireIdentity(digest(bytes) === APPROVAL_SHA256, "approval manifest lock mismatch");
  const manifest = object(JSON.parse(bytes.toString()));
  requireIdentity(manifest.schemaVersion === 1 && manifest.approvalId === "geul-hwp-original-108-233555b", "approval schema/identity mismatch");
  return identities(manifest);
}
export function validateSupplied(value: unknown, approved = loadApproval()): Identity[] {
  const docs = identities(value), expected = new Map(approved.map(d => [d.name, d.sha256]));
  for (const d of docs) requireIdentity(expected.get(d.name) === d.sha256, `unauthorized identity: ${d.name}`);
  return docs;
}
export function regularBytes(folder: string, name: string): Buffer {
  const base = realpathSync(folder), path = join(base, name);
  requireIdentity(lstatSync(path).isFile() && realpathSync(path) === path, `not a regular direct input: ${name}`);
  return readFileSync(path);
}
export function validateSources(folder: string, approved = loadApproval()): void {
  const failures: string[] = [];
  for (const d of approved) {
    try { requireIdentity(digest(regularBytes(folder, d.name)) === d.sha256, `SHA-256 mismatch: ${d.name}`); }
    catch (error) { failures.push(`${d.name}: ${String(error)}`); }
  }
  requireIdentity(!failures.length, `missing/incorrect corpus inputs (${failures.length}):\n${failures.join("\n")}`);
}
function uniqueRows(values: unknown, field: string): Map<unknown, ObjectValue> {
  requireIdentity(Array.isArray(values), "expected evidence array");
  const map = new Map<unknown, ObjectValue>();
  for (const value of values) {
    const row = object(value), key = row[field];
    requireIdentity(typeof key === "string" && key.length > 0 && !map.has(key), `missing/duplicate ${field}`);
    map.set(key, row);
  }
  return map;
}
const pass = (value: unknown) => object(value).status === "PASS";
export function validateMeasurements(approved: Identity[], matrix: unknown, publications: unknown, records: unknown,
  evidence: (id: string) => { proof: unknown; original: Uint8Array; edited: Uint8Array; published: Uint8Array }): number {
  const rows = uniqueRows(object(matrix).rows, "name"), pubs = uniqueRows(publications, "id"), canvas = uniqueRows(records, "id");
  // Discovery includes ineligible rows too: no result ID may alias an approved result.
  const measuredIds = new Set<string>();
  for (const row of rows.values()) {
    if (row.operations === undefined) continue;
    for (const entry of Object.values(object(row.operations))) {
      const id = object(entry).corpusId;
      if (id === undefined) continue;
      requireIdentity(typeof id === "string" && !measuredIds.has(id), "duplicate/invalid measurement result ID");
      measuredIds.add(id);
    }
  }
  const used = new Set<string>(), artifacts = new Set<string>();
  let verified = 0;
  for (const doc of approved) {
    const row = rows.get(doc.name);
    requireIdentity(row?.sha256 === doc.sha256, `missing/mismatched measurement: ${doc.name}`);
    const ops = object(row.operations);
    requireIdentity(Object.keys(ops).length === 4 && REQUIRED_OPERATIONS.every(op => op in ops), "operation set mismatch");
    for (const op of REQUIRED_OPERATIONS) {
      const e = object(ops[op]), id = e.corpusId;
      requireIdentity(typeof id === "string" && /^S[1-9][0-9]*-(text|table|picture|bullets)$/u.test(id) && !used.has(id), "missing/duplicate/invalid publication ID");
      used.add(id);
      const p = pubs.get(id), c = canvas.get(id);
      requireIdentity(p && c && p.source === doc.name && p.sourceSha256 === doc.sha256 && p.operation === op, "publication identity mismatch");
      requireIdentity(e.verified === "VERIFIED_PUBLISHED_REOPEN" && p.verified === e.verified
        && pass(e.publication) && pass(e.finalReopen) && pass(e.preview) && pass(p.publication) && pass(p.finalReopen) && pass(p.preview), "unverified publication/reopen");
      const a = evidence(id), proof = object(a.proof), hash = digest(a.published);
      requireIdentity(proof.source === doc.name && proof.operation === op && proof.originalSha256 === doc.sha256
        && digest(a.original) === doc.sha256 && proof.editedSha256 === digest(a.edited) && p.editedSha256 === proof.editedSha256, "artifact source/operation mismatch");
      requireIdentity(c.durable === true && c.dirty === false && c.publicationPrevented !== true && object(c.savedFileCheck).outcome === "safe"
        && c.publishedSha256 === hash && p.publishedSha256 === hash && !artifacts.has(hash), "missing/mismatched/reused published artifact");
      artifacts.add(hash); verified++;
    }
  }
  requireIdentity(verified === 432 && used.size === 432
    && [...pubs.values()].filter(p => p.verified === "VERIFIED_PUBLISHED_REOPEN").length === 432, "expected exactly 432 unique verified combinations");
  return verified;
}

// Identity-only command: no WASM, Rust, Canvas, publication or baseline writes.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const approved = loadApproval();
    validateSources(resolve(process.argv[2] ?? "external/rhwp/samples"), approved);
    console.log(`PASS ${approved.length}/108 approved source identities`);
  } catch (error) { console.error(`FAIL/MISSING_INPUT: ${String(error)}`); process.exitCode = 1; }
}
