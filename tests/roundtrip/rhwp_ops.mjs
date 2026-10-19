#!/usr/bin/env node
// T009 rhwp 왕복 시험의 엔진 작업(고정 커밋 rhwp WASM, public/rhwp/). 앱(RhwpEditorSession)과 같은 API만 쓴다.
//   node tests/roundtrip/rhwp_ops.mjs unedited <원본> <출력> <손실 보고 JSON>   편집 없이 원본 형식으로 내보내기(사전 검사 입력)
//   node tests/roundtrip/rhwp_ops.mjs edit <원본> <출력> <손실 보고 JSON> <다시 열기 JSON>   편집 → 내보내기 → 다시 열어 비교
//   node tests/roundtrip/rhwp_ops.mjs open <원본>   열리는지·쪽 수·본문 길이(JSON)
// 형식은 원본 확장자(hwp·hwpx)로 정한다. 문서 내용은 출력하지 않는다(편집 글자 포함 여부만).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rhwp = await import(pathToFileURL(join(root, "public/rhwp/rhwp.js")).href);
rhwp.initSync({ module: readFileSync(join(root, "public/rhwp/rhwp_bg.wasm")) });

const [command, input, output, lossOut, reopenOut] = process.argv.slice(2);
const format = input.toLowerCase().endsWith(".hwpx") ? "hwpx" : "hwp";
const EDIT = "저장 시험 ";

function exportWithReport(doc) {
  const exported = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
  try {
    return { report: exported.contentLoss(), bytes: exported.takeBytes() };
  } finally {
    exported.free();
  }
}

/** 앱(RhwpEditorSession.roundTrip)과 같은 서명 확인. */
function hasSignature(bytes) {
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return format === "hwp" ? ole.every((b, i) => bytes[i] === b) : bytes[0] === 0x50 && bytes[1] === 0x4b;
}

const doc = new rhwp.HwpDocument(readFileSync(input));
try {
  if (command === "open") {
    console.log(JSON.stringify({ ok: true, pages: doc.pageCount(), textLength: doc.getTextFileText().length }));
  } else if (command === "unedited") {
    const { report, bytes } = exportWithReport(doc);
    writeFileSync(output, bytes);
    writeFileSync(lossOut, report);
  } else if (command === "edit") {
    doc.insertText(0, 0, 0, EDIT);
    doc.splitParagraph(0, 0, Array.from(EDIT).length);
    const { report, bytes } = exportWithReport(doc);
    writeFileSync(output, bytes);
    writeFileSync(lossOut, report);
    const reopened = new rhwp.HwpDocument(bytes);
    try {
      const reopen = {
        formatEqual: reopened.getSourceFormat() === format && hasSignature(bytes),
        pagesEqual: reopened.pageCount() === doc.pageCount(),
        textEqual: reopened.getTextFileText() === doc.getTextFileText(),
        controlsEqual: reopened.getControls() === doc.getControls(),
      };
      writeFileSync(reopenOut, JSON.stringify(reopen));
      // getTextFileText는 JSON 문자열 표기(따옴표 포함)를 돌려준다.
      console.log(JSON.stringify({ editPresent: reopened.getTextFileText().includes(EDIT.trimEnd()) }));
    } finally {
      reopened.free();
    }
  } else {
    console.error("알 수 없는 명령");
    process.exit(2);
  }
} finally {
  doc.free();
}
