// Opt-in measurement (GEUL_HWP_SAMPLE_MATRIX=<output.json>): for every single-section RHWP sample HWP of at
// most 120 KB, the load-time reopen-model completeness, the real T009 original preflight verdict, and the raw
// T009 verdict of one isolated text / bullet / inline picture / normalized table insertion (engine-direct).
// It documents which originals the restricted HWP insertion subset can publish; it is not a pass/fail gate.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { HWP_TABLE_NORMALIZATION, hwpReopenModel } from "../../src/components/Editor/rhwp/hwpReopenModel";
import type { RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";

const target = process.env.GEUL_HWP_SAMPLE_MATRIX;
const root = resolve(__dirname, "../..");
type Doc = RhwpDocument & { exportHwpWithReport(): { takeBytes(): Uint8Array; contentLoss(): string; free(): void } };

describe.runIf(!!target)("HWP sample insertion matrix (measurement)", () => {
  it("measures every eligible sample", async () => {
    const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
    const folder = join(root, "public/rhwp/generations", build.generation);
    const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
    engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
    const checker = join(root, "src-tauri/target/debug/examples/save_check");
    const png = readFileSync(join(root, "src-tauri/target/core-evidence/blue.png"));
    const scratch = join(dirname(resolve(target!)), ".matrix");
    const verdict = (mode: "preflight" | "saved", original: Uint8Array, output: Uint8Array, loss: string) => {
      writeFileSync(scratch + ".a", original); writeFileSync(scratch + ".b", output); writeFileSync(scratch + ".l", loss);
      return JSON.parse(execFileSync(checker, [mode, "hwp", scratch + ".a", scratch + ".b", scratch + ".l", ...(mode === "saved" ? ["true"] : [])], { encoding: "utf8" })) as { outcome: string; findings: { code: string; part: string }[] };
    };
    const exported = (d: Doc) => { const e = d.exportHwpWithReport(); try { return { bytes: e.takeBytes(), loss: e.contentLoss() }; } finally { e.free(); } };
    const ops: Record<string, (d: Doc) => void> = {
      text: d => { d.insertText(0, 0, 0, "가"); },
      bullets: d => { const id = d.ensureDefaultBullet!("•"); d.applyParaFormat!(0, 0, JSON.stringify({ headType: "Bullet", numberingId: id, paraLevel: 0 })); },
      picture: d => { const p = JSON.parse(d.insertPicture!(0, 0, 0, "[]", png, 900, 600, 12, 8, "png", "")); d.setPictureProperties!(0, p.paraIdx, p.controlIdx, JSON.stringify({ treatAsChar: true })); },
      table: d => { const t = JSON.parse(d.createTable!(0, 0, 0, 2, 2)); d.setTableProperties!(0, t.paraIdx, t.controlIdx, JSON.stringify(HWP_TABLE_NORMALIZATION)); },
    };
    const dir = join(root, "external/rhwp/samples"), rows: Record<string, unknown>[] = [];
    for (const name of readdirSync(dir).filter(f => f.endsWith(".hwp")).sort()) {
      const size = statSync(join(dir, name)).size;
      if (size > 120_000) continue;
      const original = new Uint8Array(readFileSync(join(dir, name)));
      const row: Record<string, unknown> = { name, size };
      try {
        const d = new engine.HwpDocument(original) as Doc;
        try {
          if (d.getSectionCount!() !== 1) continue;
          row.complete = hwpReopenModel(d).complete;
          const noop = exported(d); row.preflight = verdict("preflight", original, noop.bytes, noop.loss).outcome;
        } finally { d.free(); }
        if (row.complete === true && row.preflight === "safe") for (const [op, apply] of Object.entries(ops)) {
          const d = new engine.HwpDocument(original) as Doc;
          try { apply(d); const out = exported(d); row[op] = verdict("saved", original, out.bytes, out.loss).findings.map(f => `${f.code}@${f.part}`); }
          catch (error) { row[op] = ["error:" + String(error).slice(0, 80)]; } finally { d.free(); }
        }
      } catch (error) { row.error = String(error).slice(0, 120); }
      rows.push(row);
    }
    const publishable = (v: unknown) => Array.isArray(v) && v.every((f: string) => f.startsWith("previewStale@"));
    const eligible = rows.filter(r => r.complete === true && r.preflight === "safe");
    const summary = { engineGeneration: build.generation, measured: rows.length, completeAndSafe: eligible.length,
      publishable: Object.fromEntries(Object.keys(ops).map(op => [op, eligible.filter(r => publishable(r[op])).length])),
      allThreeStructural: eligible.filter(r => ["bullets", "picture", "table"].every(op => publishable(r[op]))).map(r => r.name) };
    writeFileSync(resolve(target!), JSON.stringify({ summary, rows }, null, 1));
  }, 1_200_000);
});
