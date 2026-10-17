#!/usr/bin/env node
// T007 저장·재열기 PoC(파일 수준). 앱의 저장 기능이 아니라(저장은 T009) 고정 커밋 rhwp WASM으로
// 픽스처를 열어 같은 편집("한글 입력 테스트" 삽입, 표 셀 입력)을 한 뒤 원본 형식으로 *_with_report 내보내기를 하고,
// 지정한 임시 디렉터리에 쓴 다음 다시 열어 구조·텍스트를 비교한다. 원본 파일은 바꾸지 않는다.
//
// 사용법: node tests/integration/rhwp/roundtrip.mjs <픽스처 디렉터리> <출력 디렉터리>
// 출력: <형식>-edited.<확장자>와 결과 JSON(표준 출력).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [fixtures, out] = process.argv.slice(2);
if (!fixtures || !out) {
  console.error("사용법: roundtrip.mjs <픽스처 디렉터리> <출력 디렉터리>");
  process.exit(2);
}
const rhwp = await import(pathToFileURL(join(root, "public/rhwp/rhwp.js")).href);
rhwp.initSync({ module: readFileSync(join(root, "public/rhwp/rhwp_bg.wasm")) });
const meta = JSON.parse(readFileSync(join(fixtures, "basic-ko.json"), "utf8"));
const INSERT = "한글 입력 테스트";
mkdirSync(out, { recursive: true });

const snapshot = (doc) => ({
  pages: doc.pageCount(),
  paragraphs: doc.getParagraphCount(0),
  text: doc.getTextFileText(),
  controls: JSON.parse(doc.getControls()).map(({ ctrlId, para, pos }) => ({ ctrlId, para, pos })),
  bold: JSON.parse(doc.getCharPropertiesAt(0, meta.content.bold.paragraph, 1)).bold ?? null,
});

const results = {};
for (const format of ["hwp", "hwpx"]) {
  const original = readFileSync(join(fixtures, `basic-ko.${format}`));
  const doc = new rhwp.HwpDocument(original);
  const before = snapshot(doc);
  const len = doc.getParagraphLength(0, 0);
  doc.insertText(0, 0, len, INSERT);
  doc.insertTextInCell(0, meta.table.paragraph, meta.table.control, 3, 0, 0, "★");
  const edited = snapshot(doc);
  const exported = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
  const loss = JSON.parse(exported.contentLoss());
  const bytes = exported.takeBytes();
  exported.free();
  doc.free();
  const file = join(out, `${format}-edited.${format}`);
  writeFileSync(file, bytes);
  const reopened = new rhwp.HwpDocument(readFileSync(file));
  const after = snapshot(reopened);
  results[format] = {
    sourceFormat: reopened.getSourceFormat(),
    bytes: bytes.length,
    contentLoss: loss,
    insertedText: after.text.includes(INSERT) && after.text.includes("★Fourth"),
    equalToEdited: JSON.stringify(after) === JSON.stringify(edited),
    textEqual: after.text === edited.text,
    controlsEqual: JSON.stringify(after.controls) === JSON.stringify(edited.controls),
    pagesEqual: after.pages === edited.pages,
    boldKept: after.bold === true,
    before,
    after,
    file,
  };
  reopened.free();
}
console.log(JSON.stringify(results));
