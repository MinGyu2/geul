// Opt-in HWP sample compatibility matrix v2 (GEUL_HWP_SAMPLE_MATRIX=<corpus dir under src-tauri/target>).
//   GEUL_HWP_MATRIX_PHASE=measure (default): every single-section RHWP sample HWP ≤ 120 KB — import,
//     baseline completeness, real original preflight; then for each of text/table/picture/bullets on a fresh
//     instance: API result, mutation proof, export, independent fresh reopen, raw T009 (reopen flag = the
//     actual reopen result). Raw candidates (+ one rejected output per T009 category) become a publication
//     corpus for scripts/tests/hwp-canvas/run.py and the Rust `hwp_contract_real_engine_publication`.
//   GEUL_HWP_MATRIX_PHASE=verify: classify the production publications and reopen every published file.
// Summary/evidence JSON go to GEUL_HWP_MATRIX_REPORT (default target/hwp-compatibility-matrix-v2).
// A measurement of this corpus with the selected engine, not a Hancom compatibility certification.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { hwpReopenEqual, hwpReopenModel } from "../../src/components/Editor/rhwp/hwpReopenModel";
import {
  OPERATIONS, classifyPublication, classifyT009, exportStage, reopenStage, runOperation, sha256,
  type Finding, type MatrixDocument, type Operation, type Stage,
} from "./hwpCompatibilityMatrix";

const corpus = process.env.GEUL_HWP_SAMPLE_MATRIX;
const phase = process.env.GEUL_HWP_MATRIX_PHASE ?? "measure";
const root = resolve(__dirname, "../..");
const report = resolve(process.env.GEUL_HWP_MATRIX_REPORT ?? join(root, "target/hwp-compatibility-matrix-v2"));
const MAX_BYTES = 120_000;
const json = (name: string, value: unknown) => writeFileSync(join(report, name), JSON.stringify(value, null, 1));

async function engineModule() {
  const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
  const folder = join(root, "public/rhwp/generations", build.generation);
  const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
  engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) }); // once per run
  return { build, open: (b: Uint8Array) => new engine.HwpDocument(b) as MatrixDocument };
}
function state(d: MatrixDocument) {
  return { format: d.getSourceFormat(), pages: d.pageCount(), text: d.getTextFileText(), controls: JSON.parse(d.getControls()),
    paragraphs: Array.from({ length: d.getParagraphCount(0) }, (_, p) => JSON.parse(d.getParaPropertiesAt!(0, p))), bullets: d.getBulletList!() };
}

describe.runIf(!!corpus && phase === "measure")("HWP sample matrix v2 — measure", () => {
  it("measures every bounded sample with mutation proof, independent reopen and raw T009", async () => {
    const { build, open } = await engineModule();
    const out = resolve(corpus!); mkdirSync(out, { recursive: true }); mkdirSync(report, { recursive: true });
    const checker = join(root, "src-tauri/target/debug/examples/save_check");
    const picture = new Uint8Array(readFileSync(join(root, "src-tauri/target/core-evidence/blue.png")));
    const scratch = join(report, ".check");
    const verdict = (mode: "preflight" | "saved", original: Uint8Array, output: Uint8Array, loss: string, reopen = false) => {
      writeFileSync(scratch + ".a", original); writeFileSync(scratch + ".b", output); writeFileSync(scratch + ".l", loss);
      return JSON.parse(execFileSync(checker, [mode, "hwp", scratch + ".a", scratch + ".b", scratch + ".l", ...(mode === "saved" ? [String(reopen)] : [])],
        { encoding: "utf8", timeout: 60_000 })) as { outcome: string; findings: Finding[] };
    };
    const dir = join(root, "external/rhwp/samples");
    const files = readdirSync(dir).filter(f => f.toLowerCase().endsWith(".hwp")).sort();
    const rows: Record<string, unknown>[] = [], cases: { id: string; negative?: boolean; expectedCode?: string }[] = [];
    const negativeCodes = new Set<string>();
    let index = 0;
    for (const name of files) {
      index += 1;
      const row: Record<string, unknown> = { name, index };
      rows.push(row);
      const size = statSync(join(dir, name)).size; row.size = size;
      if (size > MAX_BYTES) { row.excluded = "size"; continue; }
      const original = new Uint8Array(readFileSync(join(dir, name)));
      row.sha256 = sha256(original);
      let baseline: { structure: string; complete: boolean } | null = null, noop: ReturnType<typeof exportStage> | undefined;
      let d: MatrixDocument;
      try { d = open(original); } catch (cause) { row.import = { status: "ERROR", reason: String(cause).slice(0, 120) }; continue; }
      try {
        row.import = { status: "PASS" };
        const sections = d.getSectionCount!();
        if (sections !== 1) { row.excluded = "sections"; row.sections = sections; continue; }
        try { const m = hwpReopenModel(d); baseline = { structure: m.structure, complete: m.complete }; row.baseline = { status: m.complete ? "PASS" : "FAIL", reason: m.complete ? undefined : "incomplete" }; }
        catch (cause) { row.baseline = { status: "ERROR", reason: String(cause).slice(0, 120) }; }
        noop = exportStage(d);
      } finally { d.free(); }
      if (!noop?.bytes) { row.originalPreflight = { status: "ERROR", reason: "noopExportFailed" }; continue; }
      const preflight = verdict("preflight", original, noop.bytes, noop.loss!);
      row.originalPreflight = { status: preflight.outcome === "safe" ? "PASS" : "FAIL", outcome: preflight.outcome, codes: [...new Set(preflight.findings.map(f => f.code))] };
      const eligible = baseline?.complete === true && preflight.outcome === "safe";
      const ops: Record<string, unknown> = {};
      row.operations = ops;
      for (const op of OPERATIONS) {
        if (!eligible) { ops[op] = { engine: { status: "NOT_RUN", reason: "sampleNotEligible" } }; continue; }
        const live = open(original);
        try {
          const result = runOperation(live, op, picture);
          const entry: Record<string, unknown> = { engine: result.engine, mutation: result.mutation };
          ops[op] = entry;
          if (result.mutation.status !== "PASS") continue;
          const exported = exportStage(live); entry.export = exported.stage;
          if (exported.stage.status !== "PASS" || !exported.bytes) continue;
          const reopen = reopenStage(live, exported.bytes, open, baseline!.structure); entry.reopen = reopen;
          const raw = verdict("saved", original, exported.bytes, exported.loss!, reopen.status === "PASS");
          entry.rawFindings = raw.findings.map(f => `${f.code}@${f.part ?? ""}`);
          const t009 = classifyT009(result.mutation, reopen, raw.findings);
          entry.t009 = t009.stage; entry.class = t009.class;
          const candidate = t009.class === "RAW_T009_CANDIDATE" || t009.class === "RAW_T009_CANDIDATE_PREVIEW";
          const firstNegative = t009.class === "T009_REJECTED" && raw.findings.map(f => f.code).find(c => c !== "previewStale" && !negativeCodes.has(c));
          if (!candidate && !firstNegative) continue;
          const id = `S${index}-${op}`, folder = join(out, id); mkdirSync(folder, { recursive: true });
          writeFileSync(join(folder, "original.hwp"), original); writeFileSync(join(folder, "noop.hwp"), noop.bytes); writeFileSync(join(folder, "noop-loss.json"), noop.loss!);
          writeFileSync(join(folder, "edited.hwp"), exported.bytes); writeFileSync(join(folder, "loss.json"), exported.loss!);
          const model = hwpReopenModel(live);
          writeFileSync(join(folder, "proof.json"), JSON.stringify({ engineGeneration: build.generation, wasmSha256: build.artifacts["rhwp_bg.wasm"], source: name, operation: op,
            originalSha256: sha256(original), noopSha256: sha256(noop.bytes), editedSha256: sha256(exported.bytes), reopenEqual: reopen.status === "PASS",
            live: state(live), hwpModel: model.model, hwpStructure: model.structure, mutation: result.mutation, rawFindings: raw.findings,
            imageSha256: op === "picture" ? sha256(picture) : null }, null, 1));
          if (candidate) cases.push({ id });
          else { negativeCodes.add(firstNegative as string); cases.push({ id, negative: true, expectedCode: firstNegative as string }); }
          entry.corpusId = id;
        } finally { live.free(); }
      }
    }
    writeFileSync(join(out, "cases.json"), JSON.stringify(cases, null, 1));
    json("mutation-matrix.json", { engineGeneration: build.generation, maxBytes: MAX_BYTES, operations: OPERATIONS, rows });
    expect(rows.length).toBe(files.length);
  }, 1_800_000);
});

describe.runIf(!!corpus && phase === "verify")("HWP sample matrix v2 — publication and fresh reopen", () => {
  it("classifies production publication and reopens every published file", async () => {
    const { build, open } = await engineModule();
    const out = resolve(corpus!);
    const matrix = JSON.parse(readFileSync(join(report, "mutation-matrix.json"), "utf8")) as { rows: Record<string, unknown>[] };
    const records = (existsSync(join(out, "publication-canvas.json")) ? JSON.parse(readFileSync(join(out, "publication-canvas.json"), "utf8")) : []) as { id: string }[];
    const byId = new Map(records.map(r => [r.id, r]));
    const publications: Record<string, unknown>[] = [], reopens: Record<string, unknown>[] = [];
    for (const row of matrix.rows) for (const [op, value] of Object.entries((row.operations ?? {}) as Record<string, Record<string, unknown>>)) {
      const id = value.corpusId as string | undefined;
      if (!id) continue;
      const folder = join(out, id), proof = JSON.parse(readFileSync(join(folder, "proof.json"), "utf8"));
      const canvas = existsSync(join(folder, "canvas-proof.json")) ? JSON.parse(readFileSync(join(folder, "canvas-proof.json"), "utf8")) : null;
      const published = existsSync(join(folder, "published.hwp")) ? new Uint8Array(readFileSync(join(folder, "published.hwp"))) : null;
      const entry = byId.get(id) as Parameters<typeof classifyPublication>[0];
      const publication = classifyPublication(entry, published);
      value.preview = canvas && canvas.editedSha256 === proof.editedSha256 && canvas.generation === build.generation
        ? (entry && !(entry as { publicationPrevented?: boolean }).publicationPrevented ? { status: (entry as { previewRegenerated?: boolean }).previewRegenerated ? "PASS" : "FAIL", source: "product capturePreviewRaster, Firefox Canvas" } : { status: "NOT_RUN", reason: "publicationRefusedOrNotRun", canvasCaptured: true })
        : { status: "NOT_RUN", reason: "noCanvasProof" };
      value.publication = publication;
      let finalReopen: Stage = { status: "NOT_RUN", reason: "noPublication" };
      if (publication.status === "PASS" && published) {
        const fresh = open(published);
        try {
          const model = hwpReopenModel(fresh), current = state(fresh);
          const equal = model.complete && current.text === proof.live.text && JSON.stringify(current.controls) === JSON.stringify(proof.live.controls)
            && current.bullets === proof.live.bullets && hwpReopenEqual({ model: proof.hwpModel, structure: proof.hwpStructure, complete: true }, model, null);
          let image = true;
          if (proof.imageSha256) image = current.controls.filter((c: { userDesc: string }) => c.userDesc === "그림")
            .some((c: { para: number; controlIndex: number }) => sha256(fresh.getControlImageData!(0, c.para, "[]", c.controlIndex) as Uint8Array) === proof.imageSha256);
          finalReopen = equal && image ? { status: "PASS" } : { status: "FAIL", reason: equal ? "imageMissing" : "modelMismatch" };
        } catch (cause) { finalReopen = { status: "ERROR", reason: String(cause).slice(0, 120) }; }
        finally { fresh.free(); }
      }
      value.finalReopen = finalReopen;
      publications.push({ id, source: row.name, operation: op, class: value.class, editedSha256: proof.editedSha256, rawFindings: value.rawFindings,
        preview: value.preview, publication, publishedSha256: published ? sha256(published) : null, finalReopen,
        originalIntactOnRefusal: (entry as { originalIntact?: boolean } | undefined)?.originalIntact ?? null });
      reopens.push({ id, finalReopen });
    }
    // Summary
    const rows = matrix.rows;
    const st = (v: unknown) => (v as Stage | undefined)?.status;
    const opRows = (op: Operation) => rows.map(r => ((r.operations ?? {}) as Record<string, Record<string, unknown>>)[op]).filter(Boolean);
    const count = (list: Record<string, unknown>[], f: (e: Record<string, unknown>) => boolean) => list.filter(f).length;
    const perOperation = Object.fromEntries(OPERATIONS.map(op => {
      const list = opRows(op), attempted = list.filter(e => st(e.engine) !== "NOT_RUN" || st(e.mutation) === "UNSUPPORTED");
      return [op, {
        attempted: attempted.length,
        engineFailure: count(attempted, e => st(e.engine) === "FAIL"), engineError: count(attempted, e => st(e.engine) === "ERROR"),
        unsupportedInput: count(attempted, e => st(e.mutation) === "UNSUPPORTED"),
        missingMutation: count(attempted, e => st(e.mutation) === "FAIL"), verifiedMutation: count(attempted, e => st(e.mutation) === "PASS"),
        exportPass: count(attempted, e => st(e.export) === "PASS"), reopenPass: count(attempted, e => st(e.reopen) === "PASS"),
        reopenFail: count(attempted, e => st(e.reopen) === "FAIL" || st(e.reopen) === "ERROR"),
        rawCandidate: count(attempted, e => e.class === "RAW_T009_CANDIDATE"), rawCandidatePreview: count(attempted, e => e.class === "RAW_T009_CANDIDATE_PREVIEW"),
        t009Rejected: count(attempted, e => e.class === "T009_REJECTED"),
        publicationAttempted: count(attempted, e => !!e.corpusId && (e.class as string).startsWith("RAW") && st(e.publication) !== "NOT_RUN"),
        durablePublication: count(attempted, e => st(e.publication) === "PASS"),
        publishedReopenPass: count(attempted, e => st(e.finalReopen) === "PASS"),
        publicationNotRun: count(attempted, e => (e.class as string | undefined)?.startsWith("RAW") === true && st(e.publication) === "NOT_RUN"),
      }];
    }));
    const categories: Record<string, number> = {};
    for (const op of OPERATIONS) for (const e of opRows(op)) {
      for (const f of (e.rawFindings ?? []) as string[]) { const c = f.split("@")[0]!; categories[c] = (categories[c] ?? 0) + 1; }
      if (st(e.reopen) === "FAIL" || st(e.reopen) === "ERROR") categories["independentReopen:" + (e.reopen as Stage).reason] = (categories["independentReopen:" + (e.reopen as Stage).reason] ?? 0) + 1;
      if (st(e.engine) === "FAIL" || st(e.engine) === "ERROR") categories["engineOperationFailure"] = (categories["engineOperationFailure"] ?? 0) + 1;
      if (st(e.mutation) === "FAIL") categories["missingMutation:" + (e.mutation as Stage).reason] = (categories["missingMutation:" + (e.mutation as Stage).reason] ?? 0) + 1;
      if (st(e.mutation) === "UNSUPPORTED") categories["unsupportedInput:" + (e.mutation as Stage).reason] = (categories["unsupportedInput:" + (e.mutation as Stage).reason] ?? 0) + 1;
    }
    const files = {
      discovered: rows.length, excludedSize: count(rows, r => r.excluded === "size"), importError: count(rows, r => st(r.import) === "ERROR"),
      imported: count(rows, r => st(r.import) === "PASS"), excludedSections: count(rows, r => r.excluded === "sections"),
      measured: count(rows, r => !!r.baseline), completeBaseline: count(rows, r => st(r.baseline) === "PASS"), baselineError: count(rows, r => st(r.baseline) === "ERROR"),
      preflightSafe: count(rows, r => st(r.originalPreflight) === "PASS"),
      completeAndSafe: count(rows, r => st(r.baseline) === "PASS" && st(r.originalPreflight) === "PASS"),
    };
    const summary = { engineGeneration: build.generation, bounds: { maxBytes: MAX_BYTES, sections: 1, corpus: "external/rhwp/samples/*.hwp" }, files, perOperation, rejectionCategories: categories,
      verifiedPublishedReopen: publications.filter(p => (p.finalReopen as Stage).status === "PASS" && (p.class as string).startsWith("RAW")).map(p => `${p.source}:${p.operation}`) };
    json("publication-results.json", publications); json("reopen-results.json", reopens); json("matrix-summary.json", summary);
    json("mutation-matrix.json", { ...matrix, rows });
    // Every raw candidate either reached a verified published reopen or is explicitly not run/failed (never promoted).
    for (const p of publications) if ((p.publication as Stage).status !== "PASS") expect((p.finalReopen as Stage).status).not.toBe("PASS");
  }, 600_000);
});
