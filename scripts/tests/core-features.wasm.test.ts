// @vitest-environment jsdom
// Real approved WASM + independent serialized bytes + production T009 checker.
// Session commit responses are controlled. The generated proof/files also feed
// the explicit ignored Rust publication test; Linux GUI acceptance remains separate.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";
const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const out = join(root, "target/core-features/wasm"); mkdirSync(out, { recursive: true });
async function open(source?: Uint8Array) {
  const seed = engine.HwpDocument.createEmpty(); seed.createBlankDocument(); seed.insertText(0, 0, 0, "원본 한글 Preserve");
  const exp = seed.exportHwpxWithReport(), bytes = source ?? exp.takeBytes(); exp.free(); seed.free();
  const { backend, take, calls } = controlledBackend(), sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwpx"); take("open").reply(ok({ ...base, format: "hwpx" })); await opening;
  let doc!: RhwpDocument;
  const editor = new RhwpEditorSession(1, backend, sessions, async () => ({ openDocument: b => (doc = new engine.HwpDocument(b)) }));
  const loading = editor.load(); take("load").reply(loaded(bytes)); await flush();
  take("session").reply(ok(info({ format: "hwpx", state: "loading", sequence: 1 })));
  take("setState").reply(ok(info({ format: "hwpx", state: "ready", sequence: 2 }))); await loading;
  let sequence = 2;
  const settle = async () => { await flush(); while (calls.some(c => c.method === "commit")) {
    const call = take("commit"); call.reply(ok(info({ format: "hwpx", state: "ready", revision: Number(call.args[2]) + Number(call.args[3]), dirty: true, sequence: ++sequence }))); await flush();
  }};
  return { editor, doc, bytes, settle };
}
function saveCheck(original: Uint8Array, doc: RhwpDocument, stem: string) {
  const exp = doc.exportHwpxWithReport(), loss = exp.contentLoss(), bytes = exp.takeBytes(); exp.free();
  writeFileSync(join(out, stem + "-original.hwpx"), original); writeFileSync(join(out, stem + ".hwpx"), bytes); writeFileSync(join(out, stem + ".loss.json"), loss);
  const fresh = new engine.HwpDocument(original), plain = fresh.exportHwpxWithReport();
  writeFileSync(join(out, stem + "-preflight.hwpx"), plain.takeBytes()); writeFileSync(join(out, stem + "-preflight.loss.json"), plain.contentLoss()); plain.free(); fresh.free();
  const reopened = new engine.HwpDocument(bytes);
  const proof = { text: doc.getTextFileText!(), controls: doc.getControls!(), pages: doc.pageCount(), format: doc.getSourceFormat(), sha256: createHash("sha256").update(bytes).digest("hex"),
    reopen: reopened.getSourceFormat() === doc.getSourceFormat() && reopened.pageCount() === doc.pageCount()
      && reopened.getTextFileText() === doc.getTextFileText!() && reopened.getControls() === doc.getControls!() };
  expect(proof.reopen).toBe(true); writeFileSync(join(out, stem + ".proof.json"), JSON.stringify(proof));
  expect(reopened.getTextFileText()).toBe(doc.getTextFileText!());
  expect(reopened.getControls()).toBe(doc.getControls!());
  const verdict = JSON.parse(execFileSync(join(root, "src-tauri/target/debug/examples/save_check"), ["saved", "hwpx", join(out, stem + "-original.hwpx"), join(out, stem + ".hwpx"), join(out, stem + ".loss.json"), "true"], { encoding: "utf8" }));
  expect(verdict).toEqual({ outcome: "safe", findings: [] });
  return { reopened, bytes };
}
it("HWPX table insertion, cell editing/navigation, revision and serialization", async () => {
  const { editor, doc, bytes, settle } = await open();
  expect(editor.execute("insert.table", { command: "insert.table", rows: 2, cols: 3 }).accepted).toBe(true); await settle();
  expect(editor.caret.cell).toBeDefined();
  expect(editor.typeText("첫 셀")).toBe(true); expect(editor.moveCell(1)).toBe(true); expect(editor.typeText("Second")).toBe(true); await settle();
  expect(editor.snapshot().revision).toBe(3);
  const { reopened } = saveCheck(bytes, doc, "table");
  expect(reopened.getTextFileText()).toContain("첫 셀"); expect(reopened.getTextFileText()).toContain("원본 한글 Preserve");
  const at = editor.caret.cell!;
  expect(JSON.parse(reopened.getTableDimensions(0, at.parentParagraph, at.control))).toMatchObject({ rowCount: 2, colCount: 3 });
  reopened.free(); editor.dispose();
});
it.each(["png", "jpg"])("HWPX %s is embedded inline, preserves text and survives reopen", async ext => {
  const { editor, doc, bytes, settle } = await open();
  const encoded = readFileSync(join(root, "src-tauri/target/core-evidence", ext === "png" ? "blue.png" : "orange.jpg"));
  expect(await editor.executeImage(() => true, async () => ({ data: encoded.toString("base64"), width: 12, height: 8 }))).toBe("inserted"); await settle();
  expect(editor.snapshot().revision).toBe(1);
  const { reopened } = saveCheck(bytes, doc, "image-" + ext);
  const pictures = JSON.parse(reopened.getControls()).filter((c: { userDesc: string }) => c.userDesc === "그림");
  expect(pictures).toHaveLength(1); expect(pictures[0].props.TreatAsChar).toBe(1);
  expect(reopened.getTextFileText()).toContain("원본 한글 Preserve"); reopened.free(); editor.dispose();
});

it("HWPX bullets continue/terminate with rapid Enter and toggle selected paragraphs", async () => {
  const { editor, doc, bytes, settle } = await open();
  editor.moveLineEdge("end", false); expect(editor.enter()).toBe(true); await settle();
  expect(editor.execute("paragraph.bullets").accepted).toBe(true); await settle();
  expect(editor.typeText("첫 항목")).toBe(true); expect(editor.enter()).toBe(true);
  expect(editor.typeText("Second 😀")).toBe(true); expect(editor.enter()).toBe(true); expect(editor.enter()).toBe(true);
  expect(editor.typeText("일반 문단")).toBe(true); await settle();
  const props = (p: number) => JSON.parse(doc.getParaPropertiesAt!(0, p));
  expect(props(1).headType).toBe("Bullet"); expect(props(2).headType).toBe("Bullet"); expect(props(3).headType).toBe("None");
  let saved = saveCheck(bytes, doc, "bullets");
  expect(JSON.parse(saved.reopened.getParaPropertiesAt(0, 1)).headType).toBe("Bullet");
  expect(JSON.parse(saved.reopened.getParaPropertiesAt(0, 2)).headType).toBe("Bullet");
  expect(JSON.parse(saved.reopened.getParaPropertiesAt(0, 3)).headType).toBe("None");
  saved.reopened.free();
  editor.moveLineEdge("start", false); editor.moveHorizontal(-1, false);
  while (editor.caret.paragraph > 1 || editor.caret.offset > 0) expect(editor.moveHorizontal(-1, true)).toBe(true);
  expect(editor.execute("paragraph.bullets").accepted).toBe(true); await settle();
  expect(props(1).headType).toBe("None"); expect(props(2).headType).toBe("None");
  saved = saveCheck(bytes, doc, "bullets-off"); expect(JSON.parse(saved.reopened.getParaPropertiesAt(0, 1)).headType).toBe("None"); saved.reopened.free(); editor.dispose();
});
it("HWPX mixed table/picture/bullets and preservation rejection controls", async () => {
  const { editor, doc, bytes, settle } = await open();
  expect(editor.execute("paragraph.bullets").accepted).toBe(true); await settle();
  const encoded = readFileSync(join(root, "src-tauri/target/core-evidence/blue.png"));
  expect(await editor.executeImage(() => true, async () => ({ data: encoded.toString("base64"), width: 12, height: 8 }))).toBe("inserted"); await settle();
  expect(editor.execute("insert.table", { command: "insert.table", rows: 2, cols: 2 }).accepted).toBe(true); await settle();
  expect(editor.typeText("Mixed 셀")).toBe(true); await settle();
  const { reopened } = saveCheck(bytes, doc, "mixed");
  expect(JSON.parse(reopened.getParaPropertiesAt(0, 0)).headType).toBe("Bullet"); reopened.free();
  const source = join(out, "mixed.hwpx");
  const mutations = [
    ["Contents/header.xml", 'char="•"', 'char="◆"'],
    ["Contents/header.xml", 'width="0.12 mm"', 'width="0.13 mm"'],
    ["Contents/header.xml", 'horizontal="JUSTIFY"', 'horizontal="LEFT"'],
    ["Contents/section0.xml", 'binaryItemIDRef="image1"', 'binaryItemIDRef="missing"'],
    ["Contents/content.hpf", 'media-type="image/png"', 'media-type="image/jpeg"'],
    ["BinData/image1.png", "", "invalid"],
  ];
  for (const [index, [part, from, to]] of mutations.entries()) {
    const bad = join(out, `mixed-bad-${index}.hwpx`);
    execFileSync("python3", ["-c", `import sys,zipfile
src,dst,part,old,new=sys.argv[1:]
with zipfile.ZipFile(src) as a,zipfile.ZipFile(dst,'w') as b:
 for i in a.infolist():
  data=a.read(i.filename)
  if i.filename==part:
   if old:
    assert old.encode() in data
    data=data.replace(old.encode(),new.encode(),1)
   else: data=new.encode()
  b.writestr(i,data)
`, source, bad, part!, from!, to!]);
    const verdict = JSON.parse(execFileSync(join(root, "src-tauri/target/debug/examples/save_check"), ["saved", "hwpx", join(out, "mixed-original.hwpx"), bad, join(out, "mixed.loss.json"), "true"], { encoding: "utf8" }));
    expect(verdict.outcome, part).not.toBe("safe");
  }
  editor.dispose();
});

it("HWPX reopen-edit cycle preserves existing images, tables and list definitions", async () => {
  const original = readFileSync(join(out, "mixed.hwpx"));
  const { editor, doc, bytes, settle } = await open(original);
  const encoded = readFileSync(join(root, "src-tauri/target/core-evidence/orange.jpg"));
  expect(await editor.executeImage(() => true, async () => ({ data: encoded.toString("base64"), width: 12, height: 8 }))).toBe("inserted"); await settle();
  expect(editor.execute("paragraph.bullets").accepted).toBe(true); await settle();
  expect(editor.execute("insert.table", { command: "insert.table", rows: 1, cols: 2 }).accepted).toBe(true); await settle();
  expect(editor.typeText("둘째 표")).toBe(true); await settle();
  const { reopened } = saveCheck(bytes, doc, "second-cycle");
  const controls = JSON.parse(reopened.getControls());
  expect(controls.filter((c: {ctrlId: string}) => c.ctrlId === "tbl")).toHaveLength(2);
  expect(controls.filter((c: {userDesc: string}) => c.userDesc === "그림")).toHaveLength(2);
  expect(reopened.getTextFileText()).toContain("Mixed 셀"); expect(reopened.getTextFileText()).toContain("둘째 표");
  reopened.free(); editor.dispose();
});
