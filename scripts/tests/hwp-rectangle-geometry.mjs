// Probe the Release engine using the canonical and noncanonical fixtures prepared
// by the Stage 3 WASM and Rust GSO tests. Report each independently reopened edit.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const directory = process.env.GEUL_RECT_PROOF;
assert(directory, "set GEUL_RECT_PROOF to the rectangle fixture directory");
const assets = resolve("public/rhwp");
const identity = JSON.parse(readFileSync(resolve(assets, "RELEASE.json"), "utf8"));
const generation = resolve(assets, "generations", identity.generation);
const { HwpDocument, initSync } = createRequire(import.meta.url)(resolve(generation, "rhwp.js"));
initSync({ module: readFileSync(resolve(generation, "rhwp_bg.wasm")) });

const cases = {
  noop: null,
  border: { borderColor: 0x112233 },
  fill: { fillType: "solid", fillBgColor: 0x223344 },
  rotate: { rotationAngle: 27, horzFlip: true },
  move: { horzOffset: 4500 },
  width: { width: 8200 },
  height: { height: 4500 },
  both: { width: 8200, height: 4500 },
};
const address = [0, 0, 4];
for (const kind of ["canonical", "noncanonical"]) {
  const source = readFileSync(resolve(directory, `${kind}.hwp`));
  for (const [name, props] of Object.entries(cases)) {
    const doc = new HwpDocument(source);
    const target = resolve(directory, `${kind}-${name}`);
    try {
      if (props) assert.equal(JSON.parse(doc.setShapeProperties(...address, JSON.stringify(props))).ok, true);
      const live = JSON.parse(doc.getShapeProperties(...address));
      for (const [key, value] of Object.entries(props ?? {})) assert.equal(live[key], value, key);
      const exported = doc.exportHwpWithReport();
      try {
        const bytes = exported.takeBytes(), report = exported.contentLoss();
        assert.equal(JSON.parse(report).count, 0);
        const reopened = new HwpDocument(bytes);
        try {
          assert.deepEqual(JSON.parse(reopened.getShapeProperties(...address)), live);
          assert.equal(reopened.getControls(), doc.getControls());
          assert.equal(reopened.getTextFileText(), doc.getTextFileText());
          writeFileSync(`${target}.hwp`, bytes);
          writeFileSync(`${target}-report.json`, report);
        } finally { reopened.free(); }
      } finally { exported.free(); }
      if (name === "noop") writeFileSync(resolve(directory, `${kind}-layout.json`), doc.getPageControlLayout(0));
    console.log(`${kind}-${name}: independent RHWP reopen PASS`);
    } finally { doc.free(); }
  }
}

// B2 extra: multi-step resize avoids double-rounding drift against the source file,
// Undo/Redo via engine snapshot preserves original and resized geometry + reopen,
// and out-of-bounds resize fails without mutating the document.
{
  const source = readFileSync(resolve(directory, "noncanonical.hwp"));
  const origPropsDoc = new HwpDocument(source);
  let origProps;
  try {
    origProps = JSON.parse(origPropsDoc.getShapeProperties(...address));
  } finally { origPropsDoc.free(); }
  const doc = new HwpDocument(source);
  try {
    const snapBefore = doc.saveSnapshot();
    assert.equal(JSON.parse(doc.setShapeProperties(...address, JSON.stringify({ width: 7240 }))).ok, true);
    assert.equal(JSON.parse(doc.setShapeProperties(...address, JSON.stringify({ width: 8200 }))).ok, true);
    const snapAfter = doc.saveSnapshot();
    const live = JSON.parse(doc.getShapeProperties(...address));
    const singleDoc = new HwpDocument(readFileSync(resolve(directory, "noncanonical-width.hwp")));
    let singleStep;
    try {
      singleStep = JSON.parse(singleDoc.getShapeProperties(...address));
    } finally { singleDoc.free(); }
    assert.deepEqual(live, singleStep);
    const exported = doc.exportHwpWithReport();
    try {
      const bytes = exported.takeBytes();
      assert.equal(JSON.parse(exported.contentLoss()).count, 0);
      writeFileSync(resolve(directory, "noncanonical-multistep.hwp"), bytes);
    } finally { exported.free(); }
    doc.restoreSnapshot(snapBefore);
    assert.deepEqual(JSON.parse(doc.getShapeProperties(...address)), origProps);
    const undoneExp = doc.exportHwpWithReport();
    try {
      const undoneBytes = undoneExp.takeBytes();
      const undoneReopen = new HwpDocument(undoneBytes);
      try { assert.deepEqual(JSON.parse(undoneReopen.getShapeProperties(...address)), origProps); } finally { undoneReopen.free(); }
    } finally { undoneExp.free(); }
    doc.restoreSnapshot(snapAfter);
    assert.deepEqual(JSON.parse(doc.getShapeProperties(...address)), live);
    assert.throws(() => doc.setShapeProperties(...address, JSON.stringify({ width: 2500000 })));
    assert.deepEqual(JSON.parse(doc.getShapeProperties(...address)), live);
    console.log("noncanonical-multistep & undo/redo & bounds-reject: PASS");
  } finally { doc.free(); }
}
