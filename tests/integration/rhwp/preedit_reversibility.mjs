#!/usr/bin/env node
// T007 6차: IME 미리보기를 취소하면 문서 모델이 원래대로 돌아오는지(조합 취소 뒤 '수정 없음'으로 볼 수 있는지)의 근거.
// 고정 커밋 rhwp WASM(public/rhwp/)으로 실제 샘플을 열어 원본 형식으로 내보낸 뒤, 앱의 조합 미리보기·취소와 같은 호출
// (insertText → deleteText, 한 글자)을 하고 다시 내보내 바이트를 비교한다. 파일은 읽기만 하고 쓰지 않는다.
//
// 사용법: node tests/integration/rhwp/preedit_reversibility.mjs <샘플 디렉터리> <최대 개수> <hwp|hwpx>
//   예: node tests/integration/rhwp/preedit_reversibility.mjs external/rhwp/samples 120 hwp
// 출력(JSON 한 줄): opened(비교한 문서 수)·textEqual·controlsDiffer·bytesEqual·bytesDiffer 등. bytesDiffer가 0이 아니면
// 글자·컨트롤이 같아도 내보낼 내용이 바뀐 것이므로 취소한 조합을 '깨끗함'으로 되돌릴 근거가 없다(종료 코드는 항상 0, 관측 도구).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [dir, limit, format] = process.argv.slice(2);
if (!dir || !limit || (format !== "hwp" && format !== "hwpx")) {
  console.error("사용법: preedit_reversibility.mjs <샘플 디렉터리> <최대 개수> <hwp|hwpx>");
  process.exit(2);
}
const rhwp = await import(pathToFileURL(join(root, "public/rhwp/rhwp.js")).href);
rhwp.initSync({ module: readFileSync(join(root, "public/rhwp/rhwp_bg.wasm")) });

const exported = (doc) => {
  const result = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
  try { return result.takeBytes(); } finally { result.free(); }
};
const same = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);
const counts = { format, opened: 0, skipped: 0, nondeterministic: 0, textEqual: 0, controlsDiffer: 0, bytesEqual: 0, bytesDiffer: 0 };
for (const name of readdirSync(dir).filter((file) => file.toLowerCase().endsWith(`.${format}`)).sort()) {
  if (counts.opened >= Number(limit)) break;
  let doc;
  try {
    doc = new rhwp.HwpDocument(readFileSync(join(dir, name)));
  } catch {
    counts.skipped += 1; // 엔진이 열지 못함
    continue;
  }
  try {
    if (doc.getSourceFormat() !== format) { counts.skipped += 1; continue; }
    const before = exported(doc);
    if (!same(before, exported(doc))) { counts.nondeterministic += 1; continue; } // 같은 모델의 내보내기가 매번 같아야 비교 의미가 있음
    const text = doc.getTextFileText();
    const controls = doc.getControls();
    doc.insertText(0, 0, 0, "가"); // 조합 미리보기
    doc.deleteText(0, 0, 0, 1); // 취소
    const after = exported(doc);
    counts.opened += 1;
    if (doc.getTextFileText() === text) counts.textEqual += 1;
    if (doc.getControls() !== controls) counts.controlsDiffer += 1;
    if (same(before, after)) counts.bytesEqual += 1; else counts.bytesDiffer += 1;
  } catch {
    counts.skipped += 1;
  } finally {
    doc.free();
  }
}
console.log(JSON.stringify(counts));
