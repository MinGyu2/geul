#!/usr/bin/env node
// T010 Phase 0 마무리(시험 전용): 실제 저장 서비스(service::save) 시험에 넣을 진짜 엔진 근거를 만든다. 고정 rhwp WASM으로
// 픽스처를 열어 편집 없는 출력(사전 검사 입력)과 서식·글자 편집 출력을 내보내고, 앱 RhwpEditorSession.exportAndCompare와
// 같은 네 값(형식·쪽 수·본문 글·컨트롤)으로 다시 열어 비교한다. 손실 보고는 엔진이 낸 JSON 그대로다(꾸미지 않음).
// 문서 내용은 기록하지 않는다(모양 ID·개수·바이트 수·참거짓만).
//
//   node tests/poc/t010-phase0/save_inputs.mjs <픽스처 디렉터리(generate.mjs 출력)> <출력 디렉터리>
//   node tests/poc/t010-phase0/save_inputs.mjs --probe <기준 파일> <조사할 파일>...   (Stage B: 고친 파일을 엔진으로 다시 열기)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hwpParts, zipEntries, charPrs, TAG } from "./analysis.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const rhwp = await import(pathToFileURL(join(root, "public/rhwp/rhwp.js")).href);
rhwp.initSync({ module: readFileSync(join(root, "public/rhwp/rhwp_bg.wasm")) });
const TABLE = { para: 2, control: 0 };
const tryCall = (f) => { try { return { ok: true, value: f() }; } catch (e) { return { ok: false, error: String(e).slice(0, 200) }; } };
const sigOk = (bytes, fmt) => (fmt === "hwp" ? bytes[0] === 0xd0 && bytes[1] === 0xcf : bytes[0] === 0x50 && bytes[1] === 0x4b);

function exportDoc(doc, fmt) {
  const e = fmt === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
  try { return { loss: e.contentLoss(), bytes: e.takeBytes() }; } finally { e.free(); }
}
/** 앱 exportAndCompare의 reopen 네 값. 다시 열기가 실패하면 모두 false(앱과 같다). */
function reopenEvidence(bytes, fmt, doc) {
  const r = tryCall(() => {
    const re = new rhwp.HwpDocument(bytes);
    try {
      return { formatEqual: re.getSourceFormat() === fmt && sigOk(bytes, fmt), pagesEqual: re.pageCount() === doc.pageCount(),
        textEqual: re.getTextFileText() === doc.getTextFileText(), controlsEqual: re.getControls() === doc.getControls() };
    } finally { re.free(); }
  });
  return r.ok ? r.value : { formatEqual: false, pagesEqual: false, textEqual: false, controlsEqual: false, error: r.error };
}
function shapeCount(bytes, fmt) {
  return fmt === "hwp" ? hwpParts(bytes).docinfo.filter((r) => r.tag === TAG.CHAR_SHAPE).length
    : charPrs(zipEntries(Buffer.from(bytes)).get("Contents/header.xml").toString("utf8")).length;
}
const bodyProps = (doc, p, o) => JSON.parse(doc.getCharPropertiesAt(0, p, o));
const cellProps = (doc, c, o) => JSON.parse(doc.getCellCharPropertiesAt(0, TABLE.para, TABLE.control, c, 0, o));
const pick = (p) => ({ id: p.charShapeId, fontSize: p.fontSize, fontFamily: p.fontFamily, bold: p.bold, italic: p.italic, underline: p.underline, strikethrough: p.strikethrough });

if (process.argv[2] === "--probe") {
  // Stage B: 기준(고치기 전) 파일과 고친 파일을 각각 열어 다시 열기 네 값과 영향받는 위치의 서식 질의를 비교한다.
  const [reference, ...targets] = process.argv.slice(3);
  const fmtOf = (f) => (f.toLowerCase().endsWith(".hwpx") ? "hwpx" : "hwp");
  const ref = new rhwp.HwpDocument(readFileSync(reference));
  const where = (d) => ({ body0: tryCall(() => pick(bodyProps(d, 0, 0))), body1: tryCall(() => pick(bodyProps(d, 1, 0))),
    cell0: tryCall(() => pick(cellProps(d, 0, 0))), runs0: tryCall(() => JSON.parse(d.getCharShapeRuns(0, 0, 0, 4))),
    render0: tryCall(() => d.renderPageSvg(0).length > 0) });
  const out = { reference: where(ref), targets: [] };
  for (const t of targets) {
    const bytes = readFileSync(t);
    const opened = tryCall(() => new rhwp.HwpDocument(bytes));
    if (!opened.ok) { out.targets.push({ file: t, opened: false, error: opened.error }); continue; }
    const d = opened.value;
    out.targets.push({ file: t, opened: true, reopen: reopenEvidence(bytes, fmtOf(t), ref), at: where(d) });
    d.free();
  }
  ref.free();
  console.log(JSON.stringify(out));
  process.exit(0);
}

const [fixtures, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const manifest = { rhwpCommit: JSON.parse(readFileSync(join(root, "public/rhwp/BUILD.json"), "utf8")).commit, cases: [] };

for (const fmt of ["hwp", "hwpx"]) {
  const original = join(fixtures, `basic-ko.${fmt}`);
  const src = readFileSync(original);
  // 사전 검사 입력: 편집 없는 출력과 그 손실 보고(앱이 불러온 뒤 내보내는 것과 같다).
  const base = new rhwp.HwpDocument(src);
  const unedited = exportDoc(base, fmt);
  base.free();
  const uneditedFile = join(out, `${fmt}-unedited.${fmt}`);
  writeFileSync(uneditedFile, unedited.bytes);
  writeFileSync(`${uneditedFile}.loss.json`, unedited.loss);
  const edits = {
    // 새 글자 모양을 만드는 서식(픽스처에 기울임 모양이 없다).
    "italic-body": (d) => ({ ret: d.applyCharFormat(0, 0, 0, 4, JSON.stringify({ italic: true })), at: () => pick(bodyProps(d, 0, 1)) }),
    // 픽스처에 이미 있는 굵게 모양(문단 1 앞부분)과 같은 모양: 엔진이 재사용하면 header가 그대로다.
    "bold-body": (d) => ({ ret: d.applyCharFormat(0, 0, 0, 4, JSON.stringify({ bold: true })), at: () => pick(bodyProps(d, 0, 1)) }),
    "underline-cell": (d) => ({ ret: d.applyCharFormatInCell(0, TABLE.para, TABLE.control, 0, 0, 0, 2, JSON.stringify({ underline: true })),
      at: () => pick(cellProps(d, 0, 1)) }),
    // 대조: 글자만 넣는 편집.
    "text-body": (d) => ({ ret: d.insertText(0, 0, 0, "가"), at: () => pick(bodyProps(d, 0, 1)) }),
    // 대조: 서식 뒤 스냅숏 복원(Phase 0 A와 같은 경로).
    "italic-restored": (d) => {
      const id = d.saveSnapshot();
      const ret = d.applyCharFormat(0, 0, 0, 4, JSON.stringify({ italic: true }));
      d.restoreSnapshot(id);
      d.discardSnapshot(id);
      return { ret, at: () => pick(bodyProps(d, 0, 1)) };
    },
  };
  for (const [name, edit] of Object.entries(edits)) {
    const d = new rhwp.HwpDocument(src);
    const probe = name.endsWith("-cell") ? () => pick(cellProps(d, 0, 1)) : () => pick(bodyProps(d, 0, 1));
    const before = probe();
    const { ret, at } = edit(d);
    const after = at();
    const { bytes, loss } = exportDoc(d, fmt);
    const file = join(out, `${fmt}-${name}.${fmt}`);
    writeFileSync(file, bytes);
    writeFileSync(`${file}.loss.json`, loss);
    const reopen = reopenEvidence(bytes, fmt, d);
    const re = new rhwp.HwpDocument(bytes);
    const reopened = name.endsWith("-cell") ? pick(cellProps(re, 0, 1)) : pick(bodyProps(re, 0, 1));
    re.free();
    d.free();
    manifest.cases.push({ name: `${fmt}-${name}`, fmt, mode: "save", provenance: "engine", original, unedited: uneditedFile,
      uneditedLoss: `${uneditedFile}.loss.json`, output: file, outputLoss: `${file}.loss.json`, reopen,
      engine: { ret: String(ret).slice(0, 80), before, after, reopened, shapes: [shapeCount(src, fmt), shapeCount(bytes, fmt)],
        lossCount: JSON.parse(loss).count, bytes: bytes.length } });
    console.log(`${fmt}-${name}`, JSON.stringify({ ids: [before.id, after.id, reopened.id], shapes: [shapeCount(src, fmt), shapeCount(bytes, fmt)], reopen }));
  }
}
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 1));
