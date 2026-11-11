import { readFileSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APPROVED_PATH, digest, identities, loadApproval, validateSupplied, validateSources, validateMeasurements } from "./hwpApprovedCorpus";

const approved = loadApproval();
const supplied = () => ({ documents: structuredClone(approved) });
function fixture() {
  const docs = Array.from({ length: 108 }, (_, i) => ({ name: `${i}.hwp`, sha256: digest(`original${i}`) }));
  const artifacts = new Map<string, { proof: unknown; original: Buffer; edited: Buffer; published: Buffer }>();
  const publications: Record<string, unknown>[] = [], records: Record<string, unknown>[] = [];
  const rows = docs.map((doc, i) => ({ ...doc, operations: Object.fromEntries(["text", "table", "picture", "bullets"].map(op => {
    const id = `S${i + 1}-${op}`, edited = Buffer.from(`edited-${id}`), published = Buffer.from(`published-${id}`);
    const stages = { publication: { status: "PASS" }, finalReopen: { status: "PASS" }, preview: { status: "PASS" }, verified: "VERIFIED_PUBLISHED_REOPEN" };
    artifacts.set(id, { proof: { source: doc.name, operation: op, originalSha256: doc.sha256, editedSha256: digest(edited) }, original: Buffer.from(`original${i}`), edited, published });
    publications.push({ id, source: doc.name, sourceSha256: doc.sha256, operation: op, editedSha256: digest(edited), publishedSha256: digest(published), ...stages });
    records.push({ id, durable: true, dirty: false, savedFileCheck: { outcome: "safe" }, publishedSha256: digest(published) });
    return [op, { corpusId: id, ...stages }];
  })) }));
  return { docs, matrix: { rows }, publications, records, artifacts, check() {
    return validateMeasurements(this.docs, this.matrix, this.publications, this.records, id => this.artifacts.get(id)!);
  } };
}
describe("approved HWP corpus identity", () => {
  it("reproduces the old empty and repeated-document false acceptance", () => {
    const f = fixture();
    // Faithful old acceptance loop: counts supplied entries, finds the first row,
    // trusts reported hashes and only checks evidence ID cardinality.
    const oldGate = (docs: typeof f.docs) => {
      const failures = []; let verified = 0;
      for (const doc of docs) {
        const row = f.matrix.rows.find(r => r.name === doc.name);
        if (!row || row.sha256 !== doc.sha256) { failures.push("identity"); continue; }
        for (const op of ["text", "table", "picture", "bullets"]) {
          const e = row.operations[op]!, id = e.corpusId;
          if (e.verified === "VERIFIED_PUBLISHED_REOPEN" && f.records.filter(r => r.id === id).length === 1
            && f.publications.filter(p => p.id === id).length === 1) verified++;
          else failures.push("publication");
        }
      }
      return { failures, verified };
    };
    expect(oldGate([])).toEqual({ failures: [], verified: 0 });
    const substituted = Array(108).fill(f.docs[0]);
    expect(oldGate(substituted)).toEqual({ failures: [], verified: 432 });
    expect(() => validateSupplied({ documents: substituted })).toThrow();
  });
  it("accepts only the locked 108 mapping", () => {
    expect(identities(supplied())).toHaveLength(108);
    expect(validateSupplied(supplied())).toEqual(approved);
  });
  it.each([0, 1])("rejects a %i-document list", count => expect(() => validateSupplied({ documents: approved.slice(0, count) })).toThrow());
  it("rejects 108 copies of one document", () => expect(() => validateSupplied({ documents: Array(108).fill(approved[0]) })).toThrow());
  it("rejects duplicate names with a different hash", () => {
    const v = supplied(); v.documents[1]!.name = v.documents[0]!.name;
    expect(() => validateSupplied(v)).toThrow();
  });
  it("rejects duplicate source bytes under another name", () => {
    const v = supplied(); v.documents[1]!.sha256 = v.documents[0]!.sha256;
    expect(() => validateSupplied(v)).toThrow("duplicate");
  });
  it("rejects substituted, unauthorized and additional identities", () => {
    const v = supplied(); v.documents[0]!.sha256 = "a".repeat(64); expect(() => validateSupplied(v)).toThrow();
    v.documents[0]!.name = "unauthorized.hwp"; expect(() => validateSupplied(v)).toThrow();
    v.documents.push({ name: "extra.hwp", sha256: "b".repeat(64) }); expect(() => validateSupplied(v)).toThrow();
  });
  it.each(["../a.hwp", "/a.hwp", "x/a.hwp", "x\\a.hwp", "a.hwp.", "a\0.hwp", "./a.hwp", "a:hwp.hwp"])("rejects filename %s", name => {
    const v = supplied(); v.documents[0]!.name = name; expect(() => validateSupplied(v)).toThrow();
  });
  it("rejects malformed hashes and modified approval bytes", () => {
    const v = supplied(); v.documents[0]!.sha256 = "bad"; expect(() => validateSupplied(v)).toThrow();
    expect(() => loadApproval(Buffer.from(JSON.stringify(v)))).toThrow("lock mismatch");
    const bytes = readFileSync(APPROVED_PATH); bytes[bytes.length - 2] = 32;
    expect(() => loadApproval(bytes)).toThrow("lock mismatch");
  });
  it("hashes actual regular source files and fails missing/replaced/hash-mismatched inputs", () => {
    const folder = mkdtempSync(join(tmpdir(), "geul-identity-"));
    const doc = { name: "a.hwp", sha256: digest("original") };
    try {
      expect(() => validateSources(folder, [doc])).toThrow("missing/incorrect");
      writeFileSync(join(folder, doc.name), "original"); expect(() => validateSources(folder, [doc])).not.toThrow();
      expect(() => validateSources(folder, [{ ...doc, sha256: "0".repeat(64) }])).toThrow("mismatch");
      writeFileSync(join(folder, doc.name), "replacement"); expect(() => validateSources(folder, [doc])).toThrow("mismatch");
      rmSync(join(folder, doc.name)); symlinkSync("missing", join(folder, doc.name)); expect(() => validateSources(folder, [doc])).toThrow();
      rmSync(join(folder, doc.name)); mkdirSync(join(folder, doc.name)); expect(() => validateSources(folder, [doc])).toThrow();
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});
describe("432 unique publication identities", () => {
  it("accepts 108 × 4 distinct authenticated synthetic combinations", () => expect(fixture().check()).toBe(432));
  it("rejects result IDs aliased by an ineligible discovery row", () => {
    const f = fixture();
    f.matrix.rows.push({ name: "ineligible.hwp", sha256: digest("ineligible"), operations: structuredClone(f.matrix.rows[0]!.operations) });
    expect(() => f.check()).toThrow("measurement result ID");
  });
  it("rejects unreferenced verified publications", () => {
    const f = fixture(); f.publications.push({ ...f.publications[0], id: "S999-text" });
    expect(() => f.check()).toThrow("exactly 432");
  });
  it.each(["missing row", "duplicate row", "missing operation", "duplicate result ID", "duplicate publication ID", "duplicate canvas ID", "wrong source", "wrong operation", "reused evidence", "wrong original", "wrong published hash", "unverified reopen"])("rejects %s", kind => {
    const f = fixture();
    switch (kind) {
      case "missing row": f.matrix.rows.pop(); break;
      case "duplicate row": f.matrix.rows.push(f.matrix.rows[0]!); break;
      case "missing operation": delete f.matrix.rows[0]!.operations.text; break;
      case "duplicate result ID": f.matrix.rows[1]!.operations.text!.corpusId = "S1-text"; break;
      case "duplicate publication ID": f.publications.push(f.publications[0]!); break;
      case "duplicate canvas ID": f.records.push(f.records[0]!); break;
      case "wrong source": f.publications[0]!.sourceSha256 = approved[0]!.sha256; break;
      case "wrong operation": f.publications[0]!.operation = "table"; break;
      case "reused evidence": f.artifacts.set("S2-text", f.artifacts.get("S1-text")!); break;
      case "wrong original": f.artifacts.get("S1-text")!.original = Buffer.from("wrong"); break;
      case "wrong published hash": f.records[0]!.publishedSha256 = "a".repeat(64); break;
      case "unverified reopen": f.publications[0]!.finalReopen = { status: "FAIL" }; break;
    }
    expect(() => f.check()).toThrow();
  });
});
