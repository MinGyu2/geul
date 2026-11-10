// Counterexamples for the HWP compatibility matrix v2 evidence stages: none of these may be counted as a
// verified mutation, a verified reopen, a raw T009 candidate or a production publication.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { hwpReopenModel } from "../../src/components/Editor/rhwp/hwpReopenModel";
import {
  TEXT_MARKER, classifyPublication, classifyT009, exportStage, reopenStage, runOperation, sha256, type MatrixDocument,
} from "./hwpCompatibilityMatrix";

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const png = new Uint8Array(readFileSync(join(root, "src-tauri/target/core-evidence/blue.png")));
const jpg = new Uint8Array(readFileSync(join(root, "src-tauri/target/core-evidence/orange.jpg")));
const open = (b: Uint8Array) => new engine.HwpDocument(b) as MatrixDocument;
type Edit = (d: MatrixDocument & Record<string, unknown>) => void;
function doc(edit?: Edit): MatrixDocument & Record<string, unknown> {
  const d = engine.HwpDocument.createEmpty(); d.createBlankDocument(); d.insertText(0, 0, 0, "본문 Body"); d.splitParagraph(0, 0, 3);
  edit?.(d); return d;
}
const stub = (d: Record<string, unknown>, name: string, value: unknown) => { d[name] = typeof value === "function" ? value : () => value; };
const PASS = { status: "PASS" } as const;
function use<T>(d: MatrixDocument, f: (d: MatrixDocument) => T): T { try { return f(d); } finally { d.free(); } }

describe("operation results are proven, not assumed", () => {
  it("an API returning {ok:false} is an engine FAIL and never a mutation", () => use(doc(d => stub(d, "insertText", "{\"ok\":false}")), d => {
    const r = runOperation(d, "text", png);
    expect(r.engine).toMatchObject({ status: "FAIL", reason: "apiResult" });
    expect(r.mutation.status).toBe("NOT_RUN");
    expect(classifyT009(r.mutation, PASS, []).class).toBe("NOT_ELIGIBLE");
  }));
  it("an ok result without the required indices is invalid", () => use(doc(d => stub(d, "createTable", "{\"ok\":true}")), d => {
    expect(runOperation(d, "table", png).engine).toMatchObject({ status: "FAIL", reason: "apiResult" });
  }));
  it("an ok result that changed nothing is a missing mutation", () => use(doc(d => stub(d, "insertText", "{\"ok\":true,\"charOffset\":0}")), d => {
    expect(runOperation(d, "text", png)).toMatchObject({ engine: { status: "PASS" }, mutation: { status: "FAIL", reason: "textNotAtLocation" } });
  }));
  it("an engine throw is ERROR, not a failed or successful mutation", () => use(doc(d => stub(d, "insertPicture", () => { throw new Error("trap"); })), d => {
    expect(runOperation(d, "picture", png)).toMatchObject({ engine: { status: "ERROR", reason: "engineThrew" }, mutation: { status: "NOT_RUN" } });
  }));
  it("bullets skip an already-bulleted paragraph and are UNSUPPORTED when none is left", () => {
    use(doc(d => { const id = d.ensureDefaultBullet!("•"); d.applyParaFormat!(0, 0, JSON.stringify({ headType: "Bullet", numberingId: id, paraLevel: 0 })); }), d => {
      expect(runOperation(d, "bullets", png).mutation).toMatchObject({ status: "PASS", detail: { paragraph: 1 } });
    });
    use(doc(d => { const id = d.ensureDefaultBullet!("•"); for (const p of [0, 1]) d.applyParaFormat!(0, p, JSON.stringify({ headType: "Bullet", numberingId: id, paraLevel: 0 })); }), d => {
      expect(runOperation(d, "bullets", png)).toMatchObject({ engine: { status: "NOT_RUN" }, mutation: { status: "UNSUPPORTED", reason: "noUnbulletedParagraph" } });
    });
  });
  it("an ok bullet application pointing at no definition is not a bullet mutation", () => use(doc(d => stub(d, "ensureDefaultBullet", 7)), d => {
    expect(runOperation(d, "bullets", png).mutation).toMatchObject({ status: "FAIL", reason: "definitionUnresolved" });
  }));
  it("an ok createTable that adds no table (existing table indices) is a missing table", () => {
    use(doc(d => { const t = JSON.parse(d.createTable!(0, 0, 0, 2, 2)); stub(d, "createTable", JSON.stringify({ ok: true, paraIdx: t.paraIdx, controlIdx: t.controlIdx })); }), d => {
      expect(runOperation(d, "table", png).mutation).toMatchObject({ status: "FAIL", reason: "noNewTable" });
    });
  });
  it("an ok insertPicture that adds no picture is a missing picture", () => {
    use(doc(d => { const p = JSON.parse(d.insertPicture!(0, 0, 0, "[]", png, 900, 600, 12, 8, "png", "")); stub(d, "insertPicture", JSON.stringify({ ok: true, paraIdx: p.paraIdx, controlIdx: p.controlIdx })); }), d => {
      expect(runOperation(d, "picture", png).mutation).toMatchObject({ status: "FAIL", reason: "noNewPicture" });
    });
  });
  it("a picture whose embedded resource is not the input is a resource mismatch", () => use(doc(d => stub(d, "getControlImageData", jpg)), d => {
    expect(runOperation(d, "picture", png).mutation).toMatchObject({ status: "FAIL", reason: "resourceMismatch" });
  }));
  it("valid operations pass all proofs (control case)", () => {
    for (const op of ["text", "table", "picture", "bullets"] as const) use(doc(), d => expect(runOperation(d, op, png).mutation.status, op).toBe("PASS"));
  });
});

describe("independent reopen is established, not asserted", () => {
  const baselineOf = (d: MatrixDocument) => hwpReopenModel(d).structure;
  it("live/export disagreement is a reopen FAIL", () => use(doc(), d => {
    const baseline = baselineOf(d); runOperation(d, "table", png);
    const exported = exportStage(d); d.insertText(0, 0, 0, TEXT_MARKER); // live moves on after export
    const r = reopenStage(d, exported.bytes!, open, baseline);
    expect(r).toMatchObject({ status: "FAIL", reason: "textMismatch" });
    expect(classifyT009({ status: "PASS" }, r, []).class).toBe("NOT_VERIFIED");
  }));
  it("incomplete reopen evidence (missing detailed getter) is a reopen FAIL", () => use(doc(), d => {
    const baseline = baselineOf(d); runOperation(d, "table", png);
    const exported = exportStage(d);
    const r = reopenStage(d, exported.bytes!, b => { const f = open(b) as MatrixDocument & Record<string, unknown>; f.getCellInfo = undefined; return f; }, baseline);
    expect(r).toMatchObject({ status: "FAIL", reason: "modelIncomplete" });
  }));
  it("a fresh reopen that cannot open the bytes is ERROR", () => use(doc(), d => {
    const exported = exportStage(d);
    const r = reopenStage(d, exported.bytes!, () => { throw new Error("corrupt"); }, baselineOf(d));
    expect(r).toMatchObject({ status: "ERROR", reason: "freshOpenFailed" });
    expect(classifyT009({ status: "PASS" }, r, null).class).toBe("NOT_VERIFIED");
  }));
  it("a valid mutation reopens equal (control case)", () => use(doc(), d => {
    const baseline = baselineOf(d); runOperation(d, "picture", png);
    expect(reopenStage(d, exportStage(d).bytes!, open, baseline).status).toBe("PASS");
  }));
});

describe("raw T009 and publication classes", () => {
  it.each(["recordsChanged", "partAdded", "outputMalformed", "referenceInvalid", "reopenMismatch"])("%s is T009_REJECTED even next to previewStale", code => {
    const r = classifyT009(PASS, PASS, [{ code, part: "DocInfo" }, { code: "previewStale", part: "PrvImage" }]);
    expect(r.class).toBe("T009_REJECTED"); expect(r.stage).toMatchObject({ status: "FAIL", detail: { codes: [code, "previewStale"].sort() } });
  });
  it("previewStale-only is a preview candidate, not a publication", () => {
    expect(classifyT009(PASS, PASS, [{ code: "previewStale", part: "PrvImage" }]).class).toBe("RAW_T009_CANDIDATE_PREVIEW");
    expect(classifyPublication(undefined, null)).toMatchObject({ status: "NOT_RUN", reason: "publicationNotRun" });
  });
  it("empty findings count only with a verified mutation and reopen", () => {
    expect(classifyT009(PASS, PASS, []).class).toBe("RAW_T009_CANDIDATE");
    expect(classifyT009({ status: "FAIL", reason: "noNewTable" }, PASS, []).class).toBe("NOT_ELIGIBLE");
    expect(classifyT009(PASS, { status: "FAIL", reason: "modelMismatch" }, []).class).toBe("NOT_VERIFIED");
  });
  const bytes = new Uint8Array([1, 2, 3]);
  const durable = { id: "x", durable: true, dirty: false, previewRegenerated: true, savedFileCheck: { outcome: "safe" }, publishedSha256: sha256(bytes) };
  it("a refused publication (e.g. stale preview) is FAIL and records original preservation", () => {
    expect(classifyPublication({ id: "x", publicationPrevented: true, originalIntact: true }, null)).toMatchObject({ status: "FAIL", reason: "publicationRefused", detail: { originalIntact: true } });
  });
  it("a non-durable or unchecked publication is FAIL", () => {
    expect(classifyPublication({ ...durable, durable: false }, bytes)).toMatchObject({ status: "FAIL", reason: "publicationNotDurable" });
    expect(classifyPublication({ ...durable, savedFileCheck: { outcome: "unsafe" } }, bytes)).toMatchObject({ status: "FAIL", reason: "publicationNotDurable" });
  });
  it("a successful export/record without the published file, or with another file, is FAIL", () => {
    expect(classifyPublication(durable, null)).toMatchObject({ status: "FAIL", reason: "noPublishedFile" });
    expect(classifyPublication(durable, new Uint8Array([9]))).toMatchObject({ status: "FAIL", reason: "publishedFileMismatch" });
    expect(classifyPublication(durable, bytes).status).toBe("PASS");
  });
});
