#!/usr/bin/env node
// T010 Phase 0 PoC(시험 전용): 편집 없는 사전 검사가 safe인 실제 문서 하나에 서식 하나씩을 걸고 내보내, DocInfo/header 차이와
// T009 저장 검사 입력(출력·손실 보고·다시 열기 근거)을 만든다. 문서 내용은 기록하지 않는다(문단 번호·길이·모양 ID·바이트 수만).
//
//   node tests/poc/t010-phase0/real_format.mjs <원본(hwp|hwpx)> <출력 디렉터리>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { docinfoDiff, sectionDiff, hwpxDiff } from "./analysis.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const rhwp = await import(pathToFileURL(join(root, "public/rhwp/rhwp.js")).href);
rhwp.initSync({ module: readFileSync(join(root, "public/rhwp/rhwp_bg.wasm")) });
const [input, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const fmt = input.toLowerCase().endsWith(".hwpx") ? "hwpx" : "hwp";
const src = readFileSync(input);
const result = { fmt, bytes: src.length, cases: [] };

const probe = new rhwp.HwpDocument(src);
let target = null;
for (let p = 0; p < probe.getParagraphCount(0) && !target; p++) if (probe.getParagraphLength(0, p) >= 8) target = p;
probe.free();
result.paragraph = target;

for (const attr of ["bold", "italic", "underline", "strikethrough"]) {
  const d = new rhwp.HwpDocument(src);
  const before = JSON.parse(d.getCharPropertiesAt(0, target, 1));
  const t0 = performance.now();
  const ret = d.applyCharFormat(0, target, 0, 4, JSON.stringify({ [attr]: true }));
  const applyMs = performance.now() - t0;
  const after = JSON.parse(d.getCharPropertiesAt(0, target, 1));
  const e = fmt === "hwp" ? d.exportHwpWithReport() : d.exportHwpxWithReport();
  const loss = e.contentLoss(), bytes = e.takeBytes();
  e.free();
  const file = join(out, `real-${attr}.${fmt}`);
  writeFileSync(file, bytes);
  writeFileSync(`${file}.loss.json`, loss);
  const re = new rhwp.HwpDocument(bytes);
  const reopen = { formatEqual: re.getSourceFormat() === fmt, pagesEqual: re.pageCount() === d.pageCount(),
    textEqual: re.getTextFileText() === d.getTextFileText(), controlsEqual: re.getControls() === d.getControls() };
  const reAfter = JSON.parse(re.getCharPropertiesAt(0, target, 1));
  re.free();
  d.free();
  const diff = fmt === "hwp" ? { docinfo: docinfoDiff(src, bytes), sections: sectionDiff(src, bytes) } : hwpxDiff(src, bytes);
  result.cases.push({ attr, ret, applyMs: +applyMs.toFixed(1), ids: [before.charShapeId, after.charShapeId, reAfter.charShapeId],
    target: [before[attr], after[attr], reAfter[attr]], file, reopen, diff });
  console.log(attr, JSON.stringify({ ids: [before.charShapeId, after.charShapeId, reAfter.charShapeId], reopen }));
}
writeFileSync(join(out, "real-results.json"), JSON.stringify(result, null, 1));
