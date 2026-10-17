#!/usr/bin/env node
// T007 저장·재열기 PoC(파일 수준). 앱의 저장 기능이 아니라(저장은 T009) 고정 커밋 rhwp WASM으로
// 픽스처를 열어 같은 편집("한글 입력 테스트" 삽입, 표 셀 입력)을 한 뒤 원본 형식으로 *_with_report 내보내기를 하고,
// 지정한 임시 디렉터리에 쓴 다음 다시 열어 구조·텍스트를 비교한다. 원본 파일은 바꾸지 않는다.
//
// 사용법: node tests/integration/rhwp/roundtrip.mjs <픽스처 디렉터리> <출력 디렉터리>
// 출력: <형식>-edited.<확장자>와 결과 JSON(표준 출력). 형식마다 `passed`는 손실 보고가 계약 모양({count, losses[]},
// count = losses 수)이고 0건이며, 다시 연 문서가 편집한 문서와 같을 때만 true다. 하나라도 통과가 아니면 종료 코드 1.
// 내보내기·다시 열기 중 예외가 나도 WASM 객체를 놓고 그 형식을 실패로 보고한다.
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

/** 손실 보고를 엄격히 읽는다(앱의 RhwpEditorSession과 같은 규칙). 모양이 다르면 null. */
function parseLoss(json) {
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { count, losses } = value;
  if (!Number.isSafeInteger(count) || count < 0 || !Array.isArray(losses) || losses.length !== count) return null;
  return value;
}

function roundTrip(format) {
  const result = { failure: "open", passed: false };
  let doc = null;
  let exported = null;
  let reopened = null;
  try {
    doc = new rhwp.HwpDocument(readFileSync(join(fixtures, `basic-ko.${format}`)));
    const before = snapshot(doc);
    result.failure = "edit";
    const len = doc.getParagraphLength(0, 0);
    doc.insertText(0, 0, len, INSERT);
    doc.insertTextInCell(0, meta.table.paragraph, meta.table.control, 3, 0, 0, "★");
    const edited = snapshot(doc);
    result.failure = "export";
    exported = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
    const lossJson = exported.contentLoss();
    const loss = parseLoss(lossJson);
    const bytes = exported.takeBytes();
    const file = join(out, `${format}-edited.${format}`);
    writeFileSync(file, bytes);
    result.failure = "reopen";
    reopened = new rhwp.HwpDocument(readFileSync(file));
    const after = snapshot(reopened);
    Object.assign(result, {
      failure: null,
      sourceFormat: reopened.getSourceFormat(),
      bytes: bytes.length,
      lossValid: loss !== null,
      contentLoss: loss ?? lossJson,
      insertedText: after.text.includes(INSERT) && after.text.includes("★Fourth"),
      equalToEdited: JSON.stringify(after) === JSON.stringify(edited),
      textEqual: after.text === edited.text,
      controlsEqual: JSON.stringify(after.controls) === JSON.stringify(edited.controls),
      pagesEqual: after.pages === edited.pages,
      boldKept: after.bold === true,
      before,
      after,
      file,
    });
    result.passed = result.lossValid && loss.count === 0 && result.insertedText && result.equalToEdited && result.boldKept;
  } catch (error) {
    result.error = error instanceof Error ? error.name : "unknown"; // 엔진 메시지는 문서 내용을 담을 수 있어 남기지 않는다
  } finally {
    reopened?.free();
    exported?.free();
    doc?.free();
  }
  return result;
}

const results = {};
for (const format of ["hwp", "hwpx"]) results[format] = roundTrip(format);
console.log(JSON.stringify(results));
if (!Object.values(results).every((result) => result.passed)) process.exitCode = 1;
