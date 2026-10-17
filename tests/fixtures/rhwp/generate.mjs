#!/usr/bin/env node
// T007 PoC 픽스처 생성기. 고정 커밋 rhwp WASM(scripts/build-rhwp-wasm.sh 산출물 public/rhwp/)의 API만으로
// 한·영 문단, 굵게, 2×2 표가 있는 문서를 만들어 HWP·HWPX로 내보낸다. 바이너리 픽스처를 저장소에 넣지 않고
// 테스트가 실행할 때 이 스크립트로 만든다(tests/fixtures/README.md 정책, 생성 방법 기록).
//
// 사용법: node tests/fixtures/rhwp/generate.mjs <출력 디렉터리>
// 출력: basic-ko.hwp, basic-ko.hwpx, basic-ko.json(넣은 문장·표 위치 — 검사 기준)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = process.argv[2];
if (!out) {
  console.error("출력 디렉터리를 지정하세요");
  process.exit(2);
}
const rhwp = await import(pathToFileURL(join(root, "public/rhwp/rhwp.js")).href);
rhwp.initSync({ module: readFileSync(join(root, "public/rhwp/rhwp_bg.wasm")) });

export const CONTENT = {
  paragraphs: ["한글 문단입니다. Korean paragraph.", "굵은 글씨 Bold text"],
  bold: { paragraph: 1, start: 0, end: 5 },
  cells: ["셀 하나", "Cell two", "셋째 칸", "Fourth"],
  after: "표 다음 문단 End.",
};

const doc = rhwp.HwpDocument.createEmpty();
doc.createBlankDocument();
const len = (text) => Array.from(text).length;
doc.insertText(0, 0, 0, CONTENT.paragraphs[0]);
doc.splitParagraph(0, 0, len(CONTENT.paragraphs[0]));
doc.insertText(0, 1, 0, CONTENT.paragraphs[1]);
doc.applyCharFormat(0, 1, CONTENT.bold.start, CONTENT.bold.end, JSON.stringify({ bold: true }));
doc.splitParagraph(0, 1, len(CONTENT.paragraphs[1]));
const table = JSON.parse(doc.createTable(0, 2, 0, 2, 2));
const tablePara = table.paraIdx ?? 2;
const control = table.controlIdx ?? 0;
CONTENT.cells.forEach((text, cell) => doc.insertTextInCell(0, tablePara, control, cell, 0, 0, text));
const lastPara = doc.getParagraphCount(0) - 1;
doc.insertText(0, lastPara, doc.getParagraphLength(0, lastPara), CONTENT.after);

mkdirSync(out, { recursive: true });
const write = (name, exported) => {
  const loss = exported.contentLoss();
  writeFileSync(join(out, name), exported.takeBytes());
  exported.free();
  return JSON.parse(loss);
};
const report = {
  rhwpCommit: JSON.parse(readFileSync(join(root, "public/rhwp/BUILD.json"), "utf8")).commit,
  createTable: table,
  table: { paragraph: tablePara, control },
  lastParagraph: lastPara,
  content: CONTENT,
  contentLoss: { hwp: write("basic-ko.hwp", doc.exportHwpWithReport()), hwpx: write("basic-ko.hwpx", doc.exportHwpxWithReport()) },
};
doc.free();
writeFileSync(join(out, "basic-ko.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
