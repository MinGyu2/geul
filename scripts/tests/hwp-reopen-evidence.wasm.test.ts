// Real selected Release RHWP getter output as the schema source for the HWP reopen
// evidence validator: valid insertions are complete; raw/empty evidence is not.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { HwpEvidenceError, hwpReopenEqual, hwpReopenModel } from "../../src/components/Editor/rhwp/hwpReopenModel";
import type { RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const png = readFileSync(join(root, "src-tauri/target/core-evidence/blue.png"));

function exportHwp(d: RhwpDocument): Uint8Array {
  const e = d.exportHwpWithReport(); try { return e.takeBytes(); } finally { e.free(); }
}
function blank(): Uint8Array {
  const d = engine.HwpDocument.createEmpty(); d.createBlankDocument(); d.insertText(0, 0, 0, "앞 문장 Before | 뒤 문장 After");
  try { return exportHwp(d); } finally { d.free(); }
}
// createTable leaves the live CommonObjAttr (wrap bits, horizontal reference, outer
// margins) different from the CTRL_HEADER bytes it serializes; the full normalization
// restates the serialized Hancom default so the live model matches its own export.
const FULL = { textWrap: "TopAndBottom", horzRelTo: "Column", outerLeft: 283, outerRight: 283, outerTop: 283, outerBottom: 283 };
function edited(normalize: "full" | "wrap" | "raw" = "full"): { live: RhwpDocument; baseline: string } {
  const live = new engine.HwpDocument(blank()) as RhwpDocument;
  const baseline = hwpReopenModel(live).structure;
  live.splitParagraph!(0, 0, 10);
  const id = live.ensureDefaultBullet!("•");
  for (const p of [0, 1]) expect(JSON.parse(live.applyParaFormat!(0, p, JSON.stringify({ headType: "Bullet", numberingId: id, paraLevel: 0 }))).ok).toBe(true);
  const t = JSON.parse(live.createTable!(0, 1, 3, 2, 3));
  if (normalize !== "raw") live.setTableProperties!(0, t.paraIdx, t.controlIdx, JSON.stringify(normalize === "full" ? FULL : { textWrap: "TopAndBottom" }));
  live.insertTextInCell!(0, t.paraIdx, t.controlIdx, 4, 0, 0, "셀 Cell");
  const p = JSON.parse(live.insertPicture!(0, 0, 0, "[]", png, 7200, 4800, 12, 8, "png", ""));
  live.setPictureProperties!(0, p.paraIdx, p.controlIdx, JSON.stringify({ treatAsChar: true }));
  return { live, baseline };
}

it("real table/picture/bullet insertion yields complete, equal evidence after reopen", () => {
  const { live, baseline } = edited();
  const reopened = new engine.HwpDocument(exportHwp(live)) as RhwpDocument;
  try {
    const a = hwpReopenModel(live), b = hwpReopenModel(reopened);
    expect(a.complete).toBe(true); expect(b.complete).toBe(true);
    expect(a.structure).not.toBe(baseline);
    expect(hwpReopenEqual(a, b, baseline)).toBe(true);
  } finally { live.free(); reopened.free(); }
});
it("raw createTable output (TBL-001) is incomplete evidence", () => {
  const { live, baseline } = edited("raw");
  try {
    const a = hwpReopenModel(live);
    expect(a.complete).toBe(false);
    expect(hwpReopenEqual(a, a, baseline)).toBe(false);
  } finally { live.free(); }
});
it("wrap-only normalization is detected as a live/reopen table difference", () => {
  const { live, baseline } = edited("wrap");
  const reopened = new engine.HwpDocument(exportHwp(live)) as RhwpDocument;
  try {
    const a = hwpReopenModel(live), b = hwpReopenModel(reopened);
    expect(a.complete && b.complete).toBe(true);
    expect(hwpReopenEqual(a, b, baseline)).toBe(false);
  } finally { live.free(); reopened.free(); }
});
it.each(["getCellInfo", "getCellProperties", "getTableProperties", "getPictureProperties", "getParaPropertiesAt"] as const)(
  "real document with %s returning {} is refused", name => {
    const { live } = edited();
    try {
      (live as unknown as Record<string, unknown>)[name] = () => "{}";
      expect(() => hwpReopenModel(live)).toThrow(HwpEvidenceError);
    } finally { live.free(); }
  });
it("unchanged legacy HWP without optional APIs keeps the raw comparison", () => {
  const live = new engine.HwpDocument(blank()) as RhwpDocument;
  try {
    const shadow = Object.create(live) as RhwpDocument;
    (shadow as unknown as Record<string, unknown>).getBulletList = undefined;
    (shadow as unknown as Record<string, unknown>).getCellInfo = undefined;
    const a = hwpReopenModel(shadow);
    expect(hwpReopenEqual(a, a, a.structure)).toBe(true);
  } finally { live.free(); }
});
