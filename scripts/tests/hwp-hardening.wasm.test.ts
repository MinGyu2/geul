// @vitest-environment jsdom
// Fresh selected-WASM exports + the actual product exportAndCompare path.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { hwpReopenEqual, hwpReopenModel } from "../../src/components/Editor/rhwp/hwpReopenModel";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import { DocumentSessions } from "../../src/adapters/sessions";
import { base, controlledBackend, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";
const build = await readRhwpGeneration(resolve("public/rhwp"), "release");
const folder = resolve("public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const out = resolve(process.env.GEUL_HWP_CONTRACT_DIR!);
const cases = JSON.parse(readFileSync(join(out, "cases-first.json"), "utf8")) as { id: string; negative?: boolean }[];
const results: unknown[] = [];
for (const { id, negative } of cases) if (!negative) it(`product HWP detailed reopen ${id}`, async () => {
  const bytes = new Uint8Array(readFileSync(join(out, id, "edited.hwp")));
  const { backend, take } = controlledBackend(); const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwp"); take("open").reply(ok(base)); await opening;
  const editor = new RhwpEditorSession(1, backend, sessions, async () => ({ openDocument: b => new engine.HwpDocument(b) }));
  try {
    const loading = editor.load(); take("load").reply(loaded(bytes)); await flush();
    take("session").reply(ok(info({ state: "loading", sequence: 1 })));
    take("setState").reply(ok(info({ state: "ready", sequence: 2 }))); await loading;
    const report = editor.roundTrip("hwp"); expect(report, id).toMatchObject({ passed: true, controlsEqual: true });
    // Full required detailed API availability on the authenticated artifact.
    const doc = new engine.HwpDocument(bytes);
    try { expect(hwpReopenModel(doc).complete).toBe(true); } finally { doc.free(); }
    results.push({ id, report, sha256: createHash("sha256").update(bytes).digest("hex") });
    writeFileSync(join(out, "product-model.json"), JSON.stringify({ build, results }, null, 2));
  } finally { editor.dispose(); }
});
it("real boundary mutation is observable independently of asserted reopen_equal", () => {
  const original = new engine.HwpDocument(readFileSync(join(out, "boundary-shift/original.hwp")));
  const shifted = new engine.HwpDocument(readFileSync(join(out, "boundary-shift/edited.hwp")));
  try {
    const a = hwpReopenModel(original), b = hwpReopenModel(shifted);
    expect(hwpReopenEqual(a, b, a.structure)).toBe(false);
    expect(original.getParagraphCount(0)).toBe(shifted.getParagraphCount(0));
    expect([0, 1].map(p => original.getTextRange(0, p, 0, original.getParagraphLength(0, p))).join(""))
      .toBe([0, 1].map(p => shifted.getTextRange(0, p, 0, shifted.getParagraphLength(0, p))).join(""));
  } finally { original.free(); shifted.free(); }
});
