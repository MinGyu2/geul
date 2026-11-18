// @vitest-environment jsdom
// Focused Stage 2 implementation regression; product defaults, actual Release WASM.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import { DocumentSessions } from "../../src/adapters/sessions";
import { documentCommandState } from "../../src/commands/capability";
import { clearStructuredClipboard, TABLE_CLIPBOARD_MIME } from "../../src/commands/tableClipboard";
import type { PlainClipboard } from "../../src/commands/clipboard";
import type { DocumentCommandArgs } from "../../src/commands/target";
import type { DocumentCommandId } from "../../src/commands/registry";
import { RhwpEditorSession } from "../../src/components/Editor/rhwp/RhwpEditorSession";
import { HWP_TABLE_NORMALIZATION } from "../../src/components/Editor/rhwp/hwpReopenModel";
import { RhwpText, pathJson, withCell, type DocPosition } from "../../src/components/Editor/rhwp/rhwpText";
import { preserveSourceCaret, type RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";
import { ordinarySplitLimits, ordinarySplitValid, planTableOp, rectangularRange } from "../../src/components/Editor/rhwp/tableStructure";
import { base, controlledBackend, fail, flush, info, loaded, ok } from "../../src/components/Editor/rhwp/testing";

vi.mock("../../src/components/Editor/rhwp/previewRaster", async actual => {
  const real = await actual<typeof import("../../src/components/Editor/rhwp/previewRaster")>();
  // jsdom has no 2D canvas; the Rust service regenerates/validates HWP previews (only previewStale is tolerated below).
  return { ...real, capturePreviewRaster: () => ({ width: 1, height: 1, rgb: new Uint8Array([1, 2, 3]) }) };
});

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
const wasm = engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });
const out = process.env.GEUL_STAGE2_DIR ?? join(root, "target/stage2-focused"); mkdirSync(out, { recursive: true });
type Doc = RhwpDocument & { createBlankDocument(): void; getTextFileText(): string; getPageRenderTree(page: number): string; renderPageSvg(page: number): string };
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
// Generated solid 48×64 PNG/JPEG, large enough to occupy more than a text line.
const CELL_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAADAAAABACAIAAADTQmMRAAAATklEQVR4nO3OMQ0AIBAAsVfCjH8pKMIFx9CkAjpnr69MPhASEhKqB0JCQkL1QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF4XmIMR3l0LcAAAAAElFTkSuQmCC"), c => c.charCodeAt(0));
const CELL_JPEG = Uint8Array.from(atob("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCABAADADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+5PnwooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP/9k="), c => c.charCodeAt(0));
const importedCellImage = (bytes: Uint8Array) => ({ data: btoa(String.fromCharCode(...bytes)), width: 48, height: 64 });
function exported(d: RhwpDocument, format: "hwp" | "hwpx") {
  const e = format === "hwp" ? d.exportHwpWithReport() : d.exportHwpxWithReport();
  try { return { loss: e.contentLoss(), bytes: e.takeBytes() }; } finally { e.free(); }
}
/** Text of a deep fixture's innermost cell: numbered words, so dropped or duplicated page fragments are detectable. */
const DEEP_WORDS = Array.from({ length: 1000 }, (_, i) => `w${i}`).join(" ");
function fixture(format: "hwp" | "hwpx", emptyWrapper = false, nestedGuard = false, rich = false, multiFields = false, deep = 0, rowWords = DEEP_WORDS, inlineFormulas = false) {
  const d = engine.HwpDocument.createEmpty() as Doc;
  try {
    d.createBlankDocument();
    const t = JSON.parse(d.createTable!(0, 0, 0, emptyWrapper ? 1 : rich ? 3 : 2, emptyWrapper ? 1 : 2));
    d.setTableProperties!(0, t.paraIdx, t.controlIdx, JSON.stringify(format === "hwp" ? HWP_TABLE_NORMALIZATION : { textWrap: "TopAndBottom" }));
    // Rich: column A holds 1, 2 and an empty formula target; B1 holds a picture.
    const texts = rich ? ["1", "", "2", "", "", ""] : emptyWrapper ? [] : ["outer0", "outer1", "outer2", "outer3"];
    texts.forEach((value, i) => value && d.insertTextInCell(0, t.paraIdx, t.controlIdx, i, 0, 0, value));
    if (rich && format === "hwp") {
      // HWP field-rich original: a formula (B3 = A1+A2) and a ClickHere field (B1).
      expect(JSON.parse(d.insertTableFormulaField!(0, t.paraIdx, t.controlIdx, 2, 1, "=SUM(A1:A2)")).ok).toBe(true);
      expect(JSON.parse((d as unknown as Record<string, (...a: unknown[]) => string>).insertClickHereFieldInCell!(0, t.paraIdx, t.controlIdx, 1, 0, 0, false, "guide", "memo", "nm", true)).ok).toBe(true);
    }
    if (multiFields) {
      // Two disjoint recognized fields in the same paragraph, on either side of a space.
      const api = d as unknown as Record<string, (...a: unknown[]) => string>;
      const first = (JSON.parse(d.getFieldList!()) as { fieldId: number; fieldType: string }[]).find(f => f.fieldType === "clickhere")!;
      api.setFieldValue!(first.fieldId, "first");
      d.insertTextInCell(0, t.paraIdx, t.controlIdx, 1, 0, 5, " ");
      const second = JSON.parse(api.insertClickHereFieldInCell!(0, t.paraIdx, t.controlIdx, 1, 0, 6, false, "second", "note", "nm2", true));
      expect(second.ok).toBe(true); api.setFieldValue!(second.fieldId, "second");
    }
    if (rich && format === "hwpx") {
      // The engine's cell picture is Hancom's floating sibling of the table paragraph (not a cell control).
      expect(JSON.parse(d.insertPicture!(0, t.paraIdx, 0, JSON.stringify([{ controlIndex: t.controlIdx, cellIndex: 1, cellParaIndex: 0 }]),
        PNG, 600, 600, 1, 1, "png", "")).ok).toBe(true);
    }
    if (rich) {
      d.setTableProperties!(0, t.paraIdx, t.controlIdx, JSON.stringify({ hasCaption: true }));
      d.insertTextInCellByPath!(0, t.paraIdx, JSON.stringify([{ controlIndex: t.controlIdx, cellIndex: 65534, cellParaIndex: 0 }]), 0, "Cap");
    }
    if (deep) {
      // An existing document with `deep` table levels: every level is labelled, the innermost holds DEEP_WORDS.
      let path = [{ controlIndex: t.controlIdx, cellIndex: 0, cellParaIndex: 0 }];
      for (let level = 2; level <= deep; level++) {
        const child = JSON.parse(d.createTableInCellByPath!(0, t.paraIdx, JSON.stringify(path), 0, 1, 1));
        path = [...path, { controlIndex: child.controlIdx, cellIndex: 0, cellParaIndex: 0 }];
      }
      for (let level = 1; level < deep; level++) d.insertTextInCellByPath!(0, t.paraIdx, JSON.stringify(path.slice(0, level)), 0, `L${level}`);
      d.insertTextInCellByPath!(0, t.paraIdx, JSON.stringify(path), 0, rowWords);
    }
    if (nestedGuard) {
      const host = [{ controlIndex: t.controlIdx, cellIndex: 0, cellParaIndex: 0 }];
      const child = JSON.parse(d.createTableInCellByPath!(0, t.paraIdx, JSON.stringify(host), 3, 2, 2));
      d.insertTextInCellByPath!(0, t.paraIdx, JSON.stringify([...host,
        { controlIndex: child.controlIdx, cellIndex: 0, cellParaIndex: 0 }]), 0, "guard");
    }
    if (inlineFormulas) {
      const path = JSON.stringify([{ controlIndex: t.controlIdx, cellIndex: 5, cellParaIndex: 0 }]);
      if (format === "hwpx") expect(JSON.parse(d.insertTableFormulaAt!(0, t.paraIdx, path, 0, 0, "=SUM(A1:A2)")).ok).toBe(true);
      d.insertTextInCell(0, t.paraIdx, t.controlIdx, 5, 0, 0, "Sum😀: ");
      d.insertTextInCell(0, t.paraIdx, t.controlIdx, 5, 0, 7, ", Double:  won");
      expect(JSON.parse(d.insertTableFormulaAt!(0, t.paraIdx, path, 17, 0, "=A1*2")).ok).toBe(true);
    }
    return exported(d, format).bytes;
  } finally { d.free(); }
}
async function open(format: "hwp" | "hwpx" = "hwpx", emptyWrapper = false, nestedGuard = false, rich = false, multiFields = false, deep = 0, rowWords = DEEP_WORDS,
  sessionOptions: { history?: boolean; format?: boolean; inlineFormulas?: boolean; original?: Uint8Array } = {}) {
  const original = sessionOptions.original ?? fixture(format, emptyWrapper, nestedGuard, rich, multiFields, deep, rowWords, sessionOptions.inlineFormulas), { backend, take, calls } = controlledBackend();
  const sessions = new DocumentSessions(backend), opening = sessions.open(`/stage2.${format}`);
  take("open").reply(ok({ ...base, format })); await opening;
  let doc!: Doc;
  const editor = new RhwpEditorSession(1, backend, sessions, async () => ({
    openDocument: bytes => { const d = preserveSourceCaret(new engine.HwpDocument(bytes)) as Doc; doc ??= d; return d; },
    memoryBytes: () => wasm.memory.buffer.byteLength,
  }), sessionOptions);
  const loading = editor.load(); take("load").reply(loaded(original)); await flush();
  take("session").reply(ok(info({ format, state: "loading", sequence: 1 })));
  take("setState").reply(ok(info({ format, state: "ready", sequence: 2 }))); await loading;
  if (format === "hwp" && calls.some(c => c.method === "original")) {
    take("original").reply(ok(original)); await flush();
    const call = take("preflight");
    writeFileSync(join(out, "original.hwp"), original);
    writeFileSync(join(out, "noop.hwp"), call.args[2] as Uint8Array);
    writeFileSync(join(out, "noop-loss.json"), JSON.stringify(call.args[3]));
    const proof = JSON.parse(execFileSync(join(root, "src-tauri/target/debug/examples/save_check"),
      ["preflight", "hwp", join(out, "original.hwp"), join(out, "noop.hwp"), join(out, "noop-loss.json")], { encoding: "utf8" }));
    expect(proof.outcome, JSON.stringify(proof)).toBe("safe");
    call.reply(ok({ preservation: proof, platformSupported: true })); await flush();
  }
  const t = JSON.parse(doc.getControls!()).find((c: { ctrlId: string; list: number }) => c.ctrlId === "tbl" && c.list === 0);
  const at: DocPosition = { section: 0, paragraph: t.para, offset: 0,
    cell: { parentParagraph: t.para, control: t.controlIndex, cell: 0, cellParagraph: 0 } };
  const place = (p: DocPosition) => { editor.anchor = editor.caret = p; };
  let sequence = 2;
  const settle = async () => { await flush(); while (calls.some(c => c.method === "commit")) {
    const c = take("commit"); c.reply(ok(info({ format, state: "ready", dirty: true,
      revision: Number(c.args[2]) + Number(c.args[3]), sequence: ++sequence }))); await flush();
  } };
  const run = async (command: DocumentCommandId, args?: DocumentCommandArgs) => {
    expect(documentCommandState(command, editor.snapshot()).available, command).toBe(true);
    expect(editor.execute(command, args).accepted, command).toBe(true); await settle();
    expect(editor.snapshot().editable).toBe(true);
  };
  /** Product Save: the session's own export, loss report and live/reopen comparison, judged by the real T009 checker. */
  const save = async (drainPreflight = false) => {
    const saving = editor.save(); await flush();
    // A successful HWP save starts a background original probe. A subsequent save
    // may also request its own preflight; answer both bounded requests in this scenario.
    // HWPX sessions also run a background original probe (font ownership), so its save always has two bounded requests.
    for (let attempt = 0; attempt < (drainPreflight || format === "hwpx" ? 4 : 1) && calls.some(c => c.method === "original"); attempt++) {
      take("original").reply(ok(original)); await flush();
      const pf = take("preflight");
      pf.reply(ok({ preservation: check(format, "preflight", original, pf.args[2] as Uint8Array, JSON.stringify(pf.args[3])), platformSupported: true }));
      await flush();
    }
    if (!calls.some(c => c.method === "save")) {
      await saving;
      const diagnostic = exported(doc, format);
      return { output: diagnostic.bytes, reopen: { formatEqual: false },
        raw: check(format, "saved", original, diagnostic.bytes, diagnostic.loss),
        publishable: false, contentLoss: JSON.parse(diagnostic.loss), refusedBeforeBackend: true };
    }
    const call = take("save");
    const [, , revision, output, contentLoss, reopen] = call.args as [number, number, number, Uint8Array, unknown, Record<string, boolean>];
    const reopenEqual = Object.values(reopen).every(Boolean);
    const raw = check(format, "saved", original, output, JSON.stringify(contentLoss), reopenEqual);
    // The service regenerates stale HWP previews; anything else is a real refusal.
    const publishable = reopenEqual && raw.findings.every(f => f.code === "previewStale") && (format === "hwp" || raw.outcome === "safe");
    if (publishable) call.reply(ok({ session: info({ format, state: "ready", revision, dirty: false, sequence: ++sequence }), durable: true }));
    else call.reply(fail({ code: "UnsafeSave", preservation: raw as never }));
    await saving;
    return { output, reopen, raw, publishable, contentLoss, refusedBeforeBackend: false };
  };
  return { original, editor, doc, at, place, settle, run, save };
}
function check(format: "hwp" | "hwpx", mode: "preflight" | "saved", original: Uint8Array, output: Uint8Array, loss: string, reopen = true) {
  writeFileSync(join(out, `a.${format}`), original); writeFileSync(join(out, `b.${format}`), output); writeFileSync(join(out, "check-loss.json"), loss);
  return JSON.parse(execFileSync(join(root, "src-tauri/target/debug/examples/save_check"), [mode, format, join(out, `a.${format}`),
    join(out, `b.${format}`), join(out, "check-loss.json"), ...(mode === "saved" ? [String(reopen)] : [])], { encoding: "utf8" })) as
    { outcome: string; findings: { code: string; part?: string }[] };
}

function checkHwpx(original: Uint8Array, doc: Doc) {
  const e = exported(doc, "hwpx");
  writeFileSync(join(out, "original.hwpx"), original); writeFileSync(join(out, "edited.hwpx"), e.bytes);
  writeFileSync(join(out, "loss.json"), e.loss);
  const result = JSON.parse(execFileSync(join(root, "src-tauri/target/debug/examples/save_check"),
    ["saved", "hwpx", join(out, "original.hwpx"), join(out, "edited.hwpx"), join(out, "loss.json"), "true"], { encoding: "utf8" }));
  expect(result.outcome, JSON.stringify(result)).toBe("safe");
  const reopened = new engine.HwpDocument(new Uint8Array(readFileSync(join(out, "edited.hwpx")))) as Doc;
  expect(reopened.getTextFileText()).toBe(doc.getTextFileText());
  return reopened;
}

async function inlineCellPicture(options: { history?: boolean } = {}, contents = "ABCD", pictureOffset = 2) {
  const c = await open("hwpx", false, false, false, false, 0, DEEP_WORDS, options);
  const { editor, doc, at, place, settle } = c;
  const target = { ...at, offset: pictureOffset };
  const path = pathJson(target.cell!);
  const text = new RhwpText(doc);
  place({ ...at, offset: 0 }); editor.caret = { ...at, offset: 6 };
  expect(editor.typeText(contents)).toBe(true); await settle();
  place(target);
  expect(await editor.executeImage(() => true, async () => importedCellImage(CELL_PNG))).toBe("inserted"); await settle();
  const owner = () => JSON.parse(doc.getCellPictureByPath!(0, at.paragraph, path, 0));
  expect(doc.getTextInCell(0, at.paragraph, at.cell!.control, at.cell!.cell, at.cell!.cellParagraph, 0, Array.from(contents).length)).toBe(contents);
  expect(text.paragraphLength(target)).toBe(Array.from(contents).length + 1);
  expect(owner()).toMatchObject({ ok: true, path: JSON.parse(path), position: pictureOffset,
    sha256: createHash("sha256").update(CELL_PNG).digest("hex"), byteLength: CELL_PNG.length });
  return { ...c, target, path, text, owner };
}

describe("Stage 2 table paths", () => {
  it("cell-inline picture stabilization safely refuses Backspace after the picture and keeps editing available", async () => {
    const { editor, doc, at, target, text, owner, place, settle } = await inlineCellPicture();
    try {
      place({ ...target, offset: 3 }); // AB[picture]|CD
      const caret = editor.caret, anchor = editor.anchor, beforeText = doc.getTextFileText(), controls = doc.getControls!();
      const picture = owner(), state = editor.snapshot(), dirty = editor.hasUnpreservedChanges;
      const snapshots = vi.spyOn(doc, "saveSnapshot");
      expect(editor.backspace()).toBe(false);
      expect(snapshots).not.toHaveBeenCalled(); expect(editor.hasUncertainChanges).toBe(false);
      expect(editor.snapshot().editable).toBe(true);
      expect(editor.caret).toEqual(caret); expect(editor.anchor).toEqual(anchor);
      expect(doc.getTextFileText()).toBe(beforeText); expect(doc.getControls!()).toBe(controls);
      expect(owner()).toEqual(picture); expect(text.paragraphLength(target)).toBe(5);
      expect(editor.snapshot().revision).toBe(state.revision); expect(editor.snapshot().history).toEqual(state.history);
      expect(editor.hasUnpreservedChanges).toBe(dirty);
      expect(editor.typeText("Z")).toBe(true); await settle();
      expect(doc.getTextInCell(0, at.paragraph, at.cell!.control, at.cell!.cell, at.cell!.cellParagraph, 0, 5)).toBe("ABZCD");
      expect(owner()).toEqual(picture); expect(editor.snapshot().editable).toBe(true);
    } finally { editor.dispose(); }
  });

  it.each(["forward", "selection"] as const)("cell-inline picture stabilization safely refuses %s deletion", async operation => {
    const { editor, doc, target, path, text, owner, place, settle } = await inlineCellPicture();
    try {
      if (operation === "forward") place({ ...target, offset: 2 }); // AB|[picture]CD
      else { editor.anchor = { ...target, offset: 1 }; editor.caret = { ...target, offset: 4 }; } // B[picture]C
      const caret = editor.caret, anchor = editor.anchor, beforeText = doc.getTextFileText(), controls = doc.getControls!();
      const picture = owner(), state = editor.snapshot(), dirty = editor.hasUnpreservedChanges;
      const snapshots = vi.spyOn(doc, "saveSnapshot");
      expect(operation === "forward" ? editor.deleteForward() : editor.backspace()).toBe(false);
      if (operation === "selection") {
        expect(editor.deleteForward()).toBe(false);
        expect(editor.typeText("X")).toBe(false); expect(editor.enter()).toBe(false);
        editor.beginComposition(); expect(editor.snapshot().composing).toBeFalsy();
        expect(editor.execute("format.bold").accepted).toBe(false);
        expect(documentCommandState("hangul.charWidth", editor.snapshot()).available).toBe(false);
      }
      expect(snapshots).not.toHaveBeenCalled(); expect(editor.hasUncertainChanges).toBe(false);
      expect(editor.snapshot().editable).toBe(true);
      expect(editor.caret).toEqual(caret); expect(editor.anchor).toEqual(anchor);
      expect(doc.getTextFileText()).toBe(beforeText); expect(doc.getControls!()).toBe(controls);
      expect(owner()).toEqual(picture); expect(text.paragraphLength(target)).toBe(5);
      expect(pathJson(editor.caret.cell!)).toBe(path);
      expect(editor.snapshot().revision).toBe(state.revision); expect(editor.snapshot().history).toEqual(state.history);
      expect(editor.hasUnpreservedChanges).toBe(dirty);
      place({ ...target, offset: 3 }); expect(editor.typeText("Z")).toBe(true); await settle();
      expect(text.text({ ...target, offset: 3 }, 1)).toBe("Z"); expect(owner()).toEqual(picture);
    } finally { editor.dispose(); }
  });

  it("cell-inline picture stabilization keeps adjacent text deletion and history positions correct", async () => {
    const { editor, doc, at, target, text, owner, place, run, settle } = await inlineCellPicture();
    const cellText = () => doc.getTextInCell(0, at.paragraph, at.cell!.control, at.cell!.cell, at.cell!.cellParagraph, 0, 4);
    try {
      const picture = owner();
      place({ ...target, offset: 4 }); // delete C, immediately after the picture
      expect(editor.backspace()).toBe(true); await settle();
      expect(cellText()).toBe("ABD"); expect(owner()).toEqual(picture); expect(owner().position).toBe(2);
      await run("edit.undo"); expect(cellText()).toBe("ABCD"); expect(owner()).toEqual(picture);
      await run("edit.redo"); expect(cellText()).toBe("ABD"); expect(owner()).toEqual(picture);
      place({ ...target, offset: 1 }); // delete B, immediately before the picture
      expect(editor.deleteForward()).toBe(true); await settle();
      expect(cellText()).toBe("AD"); expect(owner().position).toBe(1);
      await run("edit.undo"); expect(cellText()).toBe("ABD"); expect(owner()).toEqual(picture);
      await run("edit.redo"); expect(cellText()).toBe("AD"); expect(owner().position).toBe(1);
      expect(text.paragraphLength(target)).toBe(3);
      // A text-only selection uses the same logical-to-text deletion bridge.
      place({ ...target, offset: 2 }); editor.caret = { ...target, offset: 3 };
      expect(editor.deleteForward()).toBe(true); await settle();
      expect(cellText()).toBe("A"); expect(owner().position).toBe(1);
      expect(owner().instanceId).toBe(picture.instanceId); expect(owner().sha256).toBe(picture.sha256);
      await run("edit.undo"); expect(cellText()).toBe("AD"); expect(owner().position).toBe(1);
    } finally { editor.dispose(); }
  });

  it.each(["before", "after"] as const)("cell-inline picture stabilization formats text %s the picture in text coordinates", async side => {
    const { editor, doc, at, target, path, owner, place, run } = await inlineCellPicture();
    const shape = (offset: number) => JSON.parse(doc.getCellCharPropertiesAt!(0, at.paragraph,
      at.cell!.control, at.cell!.cell, at.cell!.cellParagraph, offset));
    const pictureRun = () => execFileSync("python3", ["-c", `import sys,io,zipfile,xml.etree.ElementTree as E,json
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); root=E.fromstring(z.read('Contents/section0.xml'))
print(json.dumps([(r.attrib.get('charPrIDRef'),E.tostring(p,encoding='unicode')) for r in root.iter() for p in list(r) if p.tag=='{http://www.hancom.co.kr/hwpml/2011/paragraph}pic']))`], { input: exported(doc, "hwpx").bytes, encoding: "utf8" });
    try {
      const picture = owner(), slot = doc.getCellInlineContextByPath!(0, at.paragraph, path, 2, 1), runBefore = pictureRun();
      if (side === "before") {
        place({ ...target, offset: 0 }); editor.caret = { ...target, offset: 2 };
        await run("format.bold");
        expect(shape(0).bold).toBe(true); expect(shape(1).bold).toBe(true);
        expect(shape(2).bold).toBe(false); expect(shape(3).bold).toBe(false);
      } else {
        place({ ...target, offset: 3 }); editor.caret = { ...target, offset: 5 };
        await run("format.italic");
        expect(shape(0).italic).toBe(false); expect(shape(1).italic).toBe(false);
        expect(shape(2).italic).toBe(true); expect(shape(3).italic).toBe(true);
      }
      expect(doc.getCellInlineContextByPath!(0, at.paragraph, path, 2, 1)).toBe(slot);
      expect(owner()).toEqual(picture); expect(pictureRun()).toBe(runBefore);
      editor.anchor = { ...target, offset: 1 }; editor.caret = { ...target, offset: 4 };
      expect(editor.execute("format.bold").accepted).toBe(false); expect(editor.hasUncertainChanges).toBe(false);
    } finally { editor.dispose(); }
  });

  it.each([
    { side: "before", start: 0, end: 2, expected: "AB" },
    { side: "after", start: 3, end: 5, expected: "CD" },
  ])("cell-inline picture stabilization copies text $side the picture", async ({ start, end, expected }) => {
    const { editor, target, text, place } = await inlineCellPicture();
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      place({ ...target, offset: start }); editor.caret = { ...target, offset: end };
      expect(text.selectedText(editor.anchor, editor.caret)).toBe(expected);
      expect(documentCommandState("edit.copy", editor.snapshot()).available).toBe(true);
      expect(await editor.executeClipboard("edit.copy", () => true, { readText: async () => "", writeText })).toBe(true);
      expect(writeText).toHaveBeenLastCalledWith(expected);
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
      else delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
      editor.dispose();
    }
  });

  it("cell-inline picture stabilization refuses copy selections that include the picture", async () => {
    const { editor, target, text } = await inlineCellPicture();
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => {}) } });
    try {
      editor.anchor = { ...target, offset: 1 }; editor.caret = { ...target, offset: 4 };
      expect(text.selectedText(editor.anchor, editor.caret)).toBeNull();
      expect(documentCommandState("edit.copy", editor.snapshot()).available).toBe(false);
      expect(await editor.executeClipboard("edit.copy", () => true, { readText: async () => "", writeText: async () => {} })).toBe(false);
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
      else delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
      editor.dispose();
    }
  });

  it("cell-inline picture stabilization preserves scalar offsets around a non-BMP character", async () => {
    const { editor, target, text, place } = await inlineCellPicture({}, "A😀BCD", 3);
    try {
      expect(text.paragraphLength(target)).toBe(6);
      place({ ...target, offset: 0 }); editor.caret = { ...target, offset: 3 };
      expect(text.text(editor.anchor, editor.caret.offset - editor.anchor.offset)).toBe("A😀B");
      expect(text.selectedText(editor.anchor, editor.caret)).toBe("A😀B");
      place({ ...target, offset: 4 }); editor.caret = { ...target, offset: 6 };
      expect(text.text(editor.anchor, editor.caret.offset - editor.anchor.offset)).toBe("CD");
      expect(text.selectedText(editor.anchor, editor.caret)).toBe("CD");
    } finally { editor.dispose(); }
  });

  it.each(["unexpected", "wasm"] as const)("cell-inline picture stabilization keeps %s mutation failures fail closed", async failure => {
    const { editor, doc, target, place } = await inlineCellPicture();
    const remove = doc.deleteTextInCell.bind(doc);
    try {
      place({ ...target, offset: 4 });
      doc.deleteTextInCell = (...args) => {
        remove(...args); // A real partial mutation must never be mistaken for a harmless refusal.
        throw failure === "wasm" ? new WebAssembly.RuntimeError("test trap") : new Error("test engine failure");
      };
      expect(editor.backspace()).toBe(false);
      expect(editor.hasUncertainChanges).toBe(true); expect(editor.snapshot().editable).toBe(false);
      expect(editor.typeText("X")).toBe(false);
    } finally { doc.deleteTextInCell = remove; editor.dispose(); }
  });

  it("cell-inline picture stabilization keeps body image insertion available without history", async () => {
    const { editor, doc, at, settle } = await open("hwpx", false, false, false, false, 0, DEEP_WORDS, { history: false });
    try {
      expect(editor.snapshot().history).toBeNull();
      expect(documentCommandState("insert.image", editor.snapshot()).available).toBe(true);
      const revision = editor.snapshot().revision;
      expect(await editor.executeImage(() => true, async () => importedCellImage(CELL_PNG))).toBe("inserted"); await settle();
      expect(editor.snapshot().revision).toBe(revision + 1); expect(editor.hasUnpreservedChanges).toBe(true);
      expect(editor.snapshot().history).toBeNull();
      expect(documentCommandState("edit.undo", editor.snapshot()).available).toBe(false);
      expect(JSON.parse(doc.getControls!()).some((control: { list: number; ctrlId: string }) => control.list === 0 && control.ctrlId === "gso")).toBe(true);
      editor.anchor = editor.caret = at;
      expect(documentCommandState("insert.image", editor.snapshot()).available).toBe(false);
      expect(await editor.executeImage(() => true, async () => importedCellImage(CELL_PNG))).toBe("stale");
    } finally { editor.dispose(); }
  });

  it.each(["hwpx", "hwp"] as const)("cell-inline picture Release command: %s ownership, layout, history and product save", async format => {
    // HWP also crosses pages through an existing supported depth; HWPX is an ordinary cell with text.
    const depth = format === "hwp" ? 16 : 0;
    const c = await open(format, depth > 0, false, false, false, depth), { editor, doc, at, place, run, settle } = c;
    const bytes = format === "hwp" ? CELL_JPEG : CELL_PNG;
    const target = { ...at, offset: 3, cell: { ...at.cell!, ...(depth ? { nested: Array.from({ length: depth - 1 }, () => ({ control: 0, cell: 0, cellParagraph: 0 })) } : {}) } };
    const path = pathJson(target.cell), text = new RhwpText(doc);
    const owner = () => JSON.parse(doc.getCellPictureByPath!(0, at.paragraph, path, 0));
    try {
      place(target);
      const originalText = doc.getTextFileText(), originalLength = text.paragraphLength(target), revision = editor.snapshot().revision;
      const originalRootControls = JSON.parse(doc.getControls!()).filter((x: { list: number }) => x.list === 0);
      expect(documentCommandState("insert.image", editor.snapshot()).available).toBe(true);
      expect(await editor.executeImage(() => true, async () => importedCellImage(bytes))).toBe("inserted"); await settle();
      expect(editor.caret).toEqual({ ...target, offset: 4 });
      expect(editor.snapshot().revision).toBe(revision + 1);
      expect(editor.hasUnpreservedChanges).toBe(true);
      expect(text.paragraphLength(target)).toBe(originalLength + 1);
      expect(doc.getTextFileText()).toBe(originalText);
      const picture = owner();
      expect(picture).toMatchObject({ ok: true, path: JSON.parse(path), position: 3, treatAsChar: true,
        width: 3600, height: 4800, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      expect(picture.instanceId).toBeGreaterThan(0);
      expect(JSON.parse(doc.getControls!()).filter((x: { list: number }) => x.list === 0)).toEqual(originalRootControls);
      const before = text.caret(target)!, after = text.caret(editor.caret)!;
      expect(before).toBeTruthy(); expect(after).toBeTruthy();
      expect(editor.pointAt(after.page, after.x + 1, after.y + after.height / 2, false)).toBe(true);
      expect(editor.caret.cell).toEqual(target.cell);
      const rendered = (expectedImages = 1) => {
        type N = { type: string; text?: string; bbox: { x: number; y: number; w: number; h: number }; children?: N[] };
        let images = 0; const renderedText: string[] = [];
        for (let page = 0; page < doc.pageCount(); page++) {
          const walk = (n: N, cells: N[]) => {
            if (n.type === "Cell") cells = [...cells, n];
            if (n.type === "TextRun" && n.text) renderedText.push(n.text);
            if (n.type === "Image") {
              images++; expect(cells).toHaveLength(depth || 1);
              expect(n.bbox.w).toBeGreaterThan(40); expect(n.bbox.h).toBeGreaterThan(60);
              for (const cell of cells) {
                expect(n.bbox.y).toBeGreaterThanOrEqual(cell.bbox.y - 0.5);
                expect(n.bbox.y + n.bbox.h).toBeLessThanOrEqual(cell.bbox.y + cell.bbox.h + 0.5);
              }
            }
            for (const child of n.children ?? []) walk(child, cells);
          };
          walk(JSON.parse(doc.getPageRenderTree(page)), []);
          const svg = doc.renderPageSvg(page);
          expect(svg).toContain("<svg");
          if (page === 0 || page === doc.pageCount() - 1) writeFileSync(join(out, `cell-inline-${format}-${page}.svg`), svg);
        }
        expect(images).toBe(expectedImages);
        // An inline picture can split one word across TextRuns. Compare the complete rendered text stream.
        if (depth) expect(renderedText.join("").replace(/\s+/g, " ").trim()).toBe(
          Array.from({ length: depth - 1 }, (_, i) => `L${i + 1}`).join("") + DEEP_WORDS);
      };
      rendered();
      if (depth) expect(doc.pageCount()).toBeGreaterThan(1);
      await run("edit.undo"); expect(() => owner()).toThrow();
      expect(doc.getTextFileText()).toBe(originalText); expect(text.paragraphLength(target)).toBe(originalLength);
      await run("edit.redo"); expect(owner()).toEqual(picture); rendered();
      // Logical caret slots must also type on each side without moving/loss of the picture.
      place({ ...target, offset: 4 }); expect(editor.typeText("X")).toBe(true); await settle();
      expect(owner().position).toBe(3); expect(text.text({ ...target, offset: 4 }, 1)).toBe("X");
      await run("edit.undo"); expect(owner()).toEqual(picture);
      place(target); expect(editor.typeText("Y")).toBe(true); await settle();
      expect(owner().position).toBe(4); expect(text.text(target, 1)).toBe("Y");
      await run("edit.undo"); expect(owner()).toEqual(picture);
      // A second picture before the first preserves control order and all resource identities.
      place({ ...target, offset: 1 });
      expect(await editor.executeImage(() => true, async () => importedCellImage(bytes))).toBe("inserted"); await settle();
      expect(owner().position).toBe(1);
      expect(JSON.parse(doc.getCellPictureByPath!(0, at.paragraph, path, 1))).toMatchObject({ instanceId: picture.instanceId, position: 4, sha256: picture.sha256 });
      await run("edit.undo"); expect(owner()).toEqual(picture);
      let boundaryPicture: unknown = null;
      if (depth) {
        // Insert immediately before the existing first page break; the taller line must reflow as one owner.
        let lo = 0, hi = text.paragraphLength(target);
        while (lo < hi) { const mid = (lo + hi) >>> 1;
          if (text.caret({ ...target, offset: mid })!.page === 0) lo = mid + 1; else hi = mid;
        }
        const boundary = Math.max(4, lo - 2);
        place({ ...target, offset: boundary });
        expect(await editor.executeImage(() => true, async () => importedCellImage(bytes))).toBe("inserted"); await settle();
        boundaryPicture = JSON.parse(doc.getCellPictureByPath!(0, at.paragraph, path, 1));
        expect(boundaryPicture).toMatchObject({ position: boundary, sha256: picture.sha256 });
        rendered(2);
      }
      const saved = await c.save();
      expect(saved.publishable, JSON.stringify({ raw: saved.raw, reopen: saved.reopen })).toBe(true);
      if (format === "hwp") {
        // One authenticated current-product case for the existing native publication contract.
        const evidence = join(out, "cell-inline-publication"), folder = join(evidence, "nested-cell-jpeg");
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(evidence, "cases.json"), JSON.stringify([{ id: "nested-cell-jpeg" }]));
        writeFileSync(join(folder, "original.hwp"), c.original);
        writeFileSync(join(folder, "edited.hwp"), saved.output);
        writeFileSync(join(folder, "noop.hwp"), readFileSync(join(out, "noop.hwp")));
        writeFileSync(join(folder, "noop-loss.json"), readFileSync(join(out, "noop-loss.json")));
        writeFileSync(join(folder, "loss.json"), JSON.stringify(saved.contentLoss));
        writeFileSync(join(folder, "render.svg"), readFileSync(join(out, "cell-inline-hwp-0.svg")));
        writeFileSync(join(folder, "proof.json"), JSON.stringify({
          originalSha256: createHash("sha256").update(c.original).digest("hex"),
          editedSha256: createHash("sha256").update(saved.output).digest("hex"),
          reopenEqual: Object.values(saved.reopen).every(Boolean), engineGeneration: build.generation,
          section: 0, paragraph: at.paragraph, path: JSON.parse(path), pictures: [picture, boundaryPicture],
        }));
      }
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        expect(JSON.parse(reopened.getCellPictureByPath!(0, at.paragraph, path, 0))).toEqual(picture);
        expect(reopened.getTextFileText()).toBe(originalText);
        if (boundaryPicture) expect(JSON.parse(reopened.getCellPictureByPath!(0, at.paragraph, path, 1))).toEqual(boundaryPicture);
        expect(reopened.pageCount()).toBe(doc.pageCount());
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  it("cell-inline picture rejects invalid ownership/resources, rolls back false owner, and drops stale picker results", async () => {
    const { editor, doc, at, place, settle } = await open();
    try {
      place({ ...at, offset: 2 });
      const before = doc.getTextFileText(), controls = doc.getControls!(), revision = editor.snapshot().revision;
      expect(() => doc.insertPictureInCellByPath!(0, at.paragraph, "[]", 2, CELL_PNG, 3600, 4800, 48, 64, "png", "")).toThrow();
      expect(() => doc.insertPictureInCellByPath!(0, at.paragraph, pathJson(at.cell!), 999, CELL_PNG, 3600, 4800, 48, 64, "png", "")).toThrow();
      expect(await editor.executeImage(() => true, async () => importedCellImage(CELL_PNG.slice(0, 40)))).toBe("failed");
      const insert = doc.insertPictureInCellByPath!.bind(doc);
      doc.insertPictureInCellByPath = (...args) => JSON.stringify({ ...JSON.parse(insert(...args)), path: [] });
      expect(await editor.executeImage(() => true, async () => importedCellImage(CELL_PNG))).toBe("failed"); await settle();
      expect(doc.getTextFileText()).toBe(before); expect(doc.getControls!()).toBe(controls);
      expect(editor.snapshot().revision).toBe(revision);
      expect(() => doc.getCellPictureByPath!(0, at.paragraph, pathJson(at.cell!), 0)).toThrow();
      doc.insertPictureInCellByPath = insert;
      let release!: (value: ReturnType<typeof importedCellImage>) => void;
      const picking = editor.executeImage(() => true, () => new Promise(resolve => { release = resolve; }));
      place(withCell(at, 1)); release(importedCellImage(CELL_PNG));
      expect(await picking).toBe("stale"); expect(doc.getControls!()).toBe(controls);
      // Existing body command remains independent of the new explicit cell API.
      place({ section: 0, paragraph: 0, offset: 0 });
      expect(await editor.executeImage(() => true, async () => importedCellImage(CELL_PNG))).toBe("inserted"); await settle();
      expect(JSON.parse(doc.getControls!()).some((x: { list: number; ctrlId: string }) => x.list === 0 && x.ctrlId === "gso")).toBe(true);
      // Other clients retain the legacy floating-cell API, distinct from product inline creation.
      const legacy = JSON.parse(doc.insertPicture!(0, at.paragraph, 2, pathJson(at.cell!), CELL_PNG, 3600, 4800, 48, 64, "png", ""));
      expect(legacy.ok).toBe(true);
      expect(JSON.parse(doc.getPictureProperties!(0, at.paragraph, legacy.controlIdx)).treatAsChar).toBe(false);
      expect(() => doc.getCellPictureByPath!(0, at.paragraph, pathJson(at.cell!), 0)).toThrow();
    } finally { editor.dispose(); }
  });

  it("product nested creation/structure/range merge/formatting/history and HWPX preservation", async () => {
    const c = await open(), { editor, doc, at, place, run, settle } = c;
    try {
      place({ ...at, offset: 4 }); editor.caret = { ...at, offset: 6 };
      await run("format.bold");
      place({ ...at, offset: 3 });
      await run("insert.table", { command: "insert.table", rows: 2, cols: 2 });
      const nested = editor.caret;
      expect(nested.cell!.nested).toHaveLength(1);
      expect(doc.getTextInCell(0, at.paragraph, at.cell!.control, 0, 0, 0, 6)).toBe("outer0");
      for (let i = 0; i < 6; i++) expect(JSON.parse(doc.getCellCharPropertiesAt!(0, at.paragraph,
        at.cell!.control, 0, 0, i)).bold).toBe(i >= 4);
      const text = new RhwpText(doc);
      expect(text.ownsNestedCell(nested)).toBe(true);
      for (let i = 0; i < 4; i++) {
        place(withCell(nested, i)); expect(editor.typeText(`n${i}`)).toBe(true); await settle();
      }
      place(nested);
      for (const op of ["insertRowAbove", "insertRowBelow", "insertColumnLeft", "insertColumnRight", "deleteRow", "deleteColumn"] as const) {
        await run(`table.${op}`); await run("edit.undo");
      }
      for (const op of ["mergeRight", "mergeBelow"] as const) {
        place(nested); await run(`table.${op}`); await run("edit.undo");
      }
      // Real Shift+pointAt routes the selection through ownership checks, without
      // substituting geometry for the target of the subsequent engine mutation.
      place(nested);
      const rect = text.caret(withCell(nested, 3))!;
      expect(editor.pointAt(rect.page, rect.x + 1, rect.y + rect.height / 2, true)).toBe(true);
      expect(editor.selectionRects().length).toBeGreaterThan(0);
      const beforeMerge = doc.getTextFileText();
      expect(editor.typeText("must not replace a cell range")).toBe(false);
      editor.beginComposition(); expect(editor.composing).toBe(false);
      await run("table.mergeCells");
      expect(JSON.parse(doc.getTableDimensionsByPath!(0, at.paragraph, pathJson(editor.caret.cell!))).cellCount).toBe(1);
      expect(Array.from({ length: text.paragraphCount(editor.caret) }, (_, p) => text.text({ ...editor.caret,
        cell: { ...editor.caret.cell!, nested: [{ ...editor.caret.cell!.nested![0]!, cellParagraph: p }] } }, 2))).toEqual(["n0", "n1", "n2", "n3"]);
      await run("edit.undo"); expect(doc.getTextFileText()).toBe(beforeMerge);
      await run("edit.redo");
      for (const op of ["deleteRow", "deleteColumn"] as const) {
        await run(`table.${op}`); await run("edit.undo");
      }
      await run("table.splitCell");
      place(nested); editor.caret = { ...nested, offset: 2 };
      for (const flag of ["bold", "italic", "underline", "strikethrough"] as const) await run(`format.${flag}`);
      await run("hangul.charWidth", { command: "hangul.charWidth", percent: 120 });
      await run("hangul.charSpacing", { command: "hangul.charSpacing", percent: 5 });
      expect(JSON.parse(doc.getCellCharPropertiesAtByPath!(0, at.paragraph, pathJson(nested.cell!), 0))).toMatchObject({
        bold: true, italic: true, underline: true, strikethrough: true, ratios: [120,120,120,120,120,120,120] });
      for (let cell = 0; cell < 4; cell++) expect(doc.getTextInCell(0, at.paragraph,
        at.cell!.control, cell, 0, 0, 6)).toBe(`outer${cell}`);
      const reopened = checkHwpx(c.original, doc);
      try {
        expect(new RhwpText(reopened).ownsNestedCell(nested)).toBe(true);
        expect(JSON.parse(reopened.getCellCharPropertiesAtByPath!(0, at.paragraph, pathJson(nested.cell!), 0)).bold).toBe(true);
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  it("depth fifteen, line-aware Home/End, strict path budget and HWP/HWPX engine roundtrip", async () => {
    const c = await open("hwpx", true), { editor, doc, at, place, run, settle } = c;
    try {
      place(at);
      for (let depth = 1; depth < 15; depth++) await run("insert.table", { command: "insert.table", rows: 1, cols: 1 });
      const deep = editor.caret;
      expect(deep.cell!.nested).toHaveLength(14);
      // Creation stops at the HWPX reader envelope (15 table levels) so the result reopens in both formats.
      expect(documentCommandState("insert.table", editor.snapshot()).available).toBe(false);
      expect(editor.typeText("long paragraph repeated words ".repeat(20))).toBe(true); await settle();
      const text = new RhwpText(doc), line = text.line({ ...deep, offset: 10 })!;
      expect(line.end).toBeLessThan(text.paragraphLength(deep));
      place({ ...deep, offset: 10 }); expect(editor.moveLineEdge("end", false)).toBe(true);
      expect(editor.caret.offset).toBe(line.end);
      expect(editor.moveLineEdge("start", false)).toBe(true); expect(editor.caret.offset).toBe(line.start);
      const rect = text.caret(editor.caret)!;
      expect(rect).not.toBeNull();
      expect(editor.pointAt(rect.page, rect.x + 1, rect.y + rect.height / 2, false)).toBe(true);
      expect(editor.caret.cell!.nested).toHaveLength(14);
      const content = doc.getTextFileText();
      for (const path of ['[{"controlIndex":0}]', 'garbage', JSON.stringify(Array.from({ length: 65 }, () => ({ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 })))]) {
        expect(() => doc.insertTextInCellByPath!(0, at.paragraph, path, 0, "bad")).toThrow();
        expect(doc.getTextFileText()).toBe(content);
      }
      for (const format of ["hwp", "hwpx"] as const) {
        const e = exported(doc, format); writeFileSync(join(out, `deep.${format}`), e.bytes);
        const re = new engine.HwpDocument(new Uint8Array(readFileSync(join(out, `deep.${format}`)))) as Doc;
        try {
          expect(re.getTextFileText()).toBe(content);
          expect(new RhwpText(re).ownsNestedCell(deep)).toBe(true);
          expect(new RhwpText(re).paragraphLength(deep)).toBe(text.paragraphLength(deep));
        } finally { re.free(); }
      }
    } finally { editor.dispose(); }
  });

  type RowDoc = Doc & {
    getPageRenderTree(page: number): string;
    getPageDef(section: number): string;
    getPageLayerTree(page: number): string;
    insertParagraph(section: number, paragraph: number): string;
    setPageDef(section: number, json: string): string;
  };
  type Box = { x: number; y: number; w: number; h: number };
  type RenderNode = { type: string; text?: string; bbox: Box; children?: RenderNode[] };
  const numbered = (count: number) => Array.from({ length: count }, (_, i) => `w${i}`).join(" ");
  /** Check the visible body and every owning cell/table, not merely raw JSON text. */
  function visibleRow(d: RowDoc, expected: string) {
    const pages: { words: string[]; tables: Box[]; body: Box; hasText: boolean; labels: string[] }[] = [];
    for (let page = 0; page < d.pageCount(); page++) {
      const tree = JSON.parse(d.getPageRenderTree(page)) as RenderNode;
      const body = tree.children!.find(n => n.type === "Body")!;
      let text = "", hasText = false; const tables: Box[] = [];
      const inside = (b: Box, owner: Box) => {
        expect(b.y).toBeGreaterThanOrEqual(owner.y - 0.5);
        expect(b.y + b.h).toBeLessThanOrEqual(owner.y + owner.h + 0.5);
        expect(b.x).toBeGreaterThanOrEqual(owner.x - 0.5);
        expect(b.x + b.w).toBeLessThanOrEqual(owner.x + owner.w + 0.5);
      };
      const walk = (n: RenderNode, owners: Box[]) => {
        if (n.type === "Table") {
          tables.push(n.bbox); inside(n.bbox, body.bbox);
          for (const owner of owners) inside(n.bbox, owner);
        }
        if (n.type === "Table" || n.type === "Cell") owners = [...owners, n.bbox];
        if (n.type === "TextRun" && n.text?.trim()) {
          // Partial nested paint retains translated lines outside the cell clip.
          // They are not visible content; require every visible line to fit fully.
          if (owners.some(owner => n.bbox.y + n.bbox.h <= owner.y || n.bbox.y >= owner.y + owner.h)) return;
          hasText = true; text += n.text; inside(n.bbox, body.bbox);
          for (const owner of owners) inside(n.bbox, owner);
        }
        for (const child of n.children ?? []) walk(child, owners);
      };
      walk(body, []);
      pages.push({ words: text.match(/w\d+/g) ?? [], tables, body: body.bbox, hasText, labels: text.match(/L\d+/g) ?? [] });
    }
    expect(pages.flatMap(p => p.words)).toEqual(expected.split(" "));
    expect(d.getTextFileText().match(/w\d+/g)).toEqual(expected.split(" "));
    expect(pages.flatMap(p => p.labels)).toEqual(d.getTextFileText().match(/L\d+/g) ?? []);
    expect(pages.every(p => p.hasText)).toBe(true);
    expect(pages.length).toBeLessThan(6);
    return pages;
  }

  it.each([[1, 600], [4, 500], [4, 1000]])("row pagination boundary depth %i words %i: visible fragments and continuation ownership", (depth, count) => {
    const words = numbered(count), d = new engine.HwpDocument(fixture("hwpx", true, false, false, false, depth, words)) as RowDoc;
    try {
      const pages = visibleRow(d, words);
      expect(pages.length).toBeGreaterThan(1);
      const control = JSON.parse(d.getControls!()).find((c: { ctrlId: string; list: number }) => c.ctrlId === "tbl" && c.list === 0);
      const at: DocPosition = { section: 0, paragraph: control.para, offset: words.length,
        cell: { parentParagraph: control.para, control: control.controlIndex, cell: 0, cellParagraph: 0,
          ...(depth > 1 ? { nested: Array.from({ length: depth - 1 }, () => ({ control: 0, cell: 0, cellParagraph: 0 })) } : {}) } };
      const text = new RhwpText(d), caret = text.caret(at)!;
      expect(text.ownsNestedCell(at)).toBe(true);
      expect(caret.page).toBe(pages.length - 1);
      expect(caret.y + caret.height).toBeLessThanOrEqual(pages[caret.page]!.body.y + pages[caret.page]!.body.h + 0.5);
      if (depth === 1) for (const pageBreak of [1, 2]) {
        d.setTableProperties!(0, control.para, control.controlIndex, JSON.stringify({ pageBreak }));
        expect(visibleRow(d, words).length).toBe(2);
      }
    } finally { d.free(); }
  });

  it("row pagination boundary sweep uses measured physical height, including midpage insertion", () => {
    const words = numbered(600), d = new engine.HwpDocument(fixture("hwpx", true, false, false, false, 1, words)) as RowDoc;
    try {
      const pageDef = JSON.parse(d.getPageDef(0)) as { height: number };
      d.setPageDef(0, JSON.stringify({ height: pageDef.height + 75000 }));
      visibleRow(d, words);
      // The render-tree summary rounds to 0.1px, which can put the nominal
      // equality case below the true boundary. Use the product paint layer's
      // 0.001px boxes and round the page size upward to a real HWPUNIT (1/75px).
      type Layer = { bounds: { y: number; height: number }; groupKind?: { kind: string }; child?: Layer; children?: Layer[] };
      const layer = JSON.parse(d.getPageLayerTree(0)) as { root: Layer };
      const find = (n: Layer, kind: string): Layer | undefined => n.groupKind?.kind === kind ? n
        : [n.child, ...(n.children ?? [])].filter((c): c is Layer => !!c).map(c => find(c, kind)).find(Boolean);
      const body = find(layer.root, "body")!.bounds, table = find(layer.root, "table")!.bounds;
      const bottom = table.y + table.height - body.y;
      const nonBodyHeight = (pageDef.height + 75000) / 75 - body.height;
      for (const slack of [0.6, 0, -0.6, -20]) {
        const height = Math.ceil((nonBodyHeight + bottom + slack) * 75);
        d.setPageDef(0, JSON.stringify({ height }));
        const layout = visibleRow(d, words);
        expect(layout.length, JSON.stringify({ slack, height, bottom, nonBodyHeight })).toBe(slack >= 0 ? 1 : 2);
      }
      d.setPageDef(0, JSON.stringify({ height: pageDef.height }));
      // Preceding text occupies half the page; a smaller row that fits a fresh
      // page must defer intact under None instead of forcing an in-row cut.
      const small = new engine.HwpDocument(fixture("hwpx", true, false, false, false, 1, numbered(350))) as RowDoc;
      try {
        small.insertParagraph(0, 0);
        small.insertText(0, 0, 0, "prefix\n".repeat(20));
        const deferred = visibleRow(small, numbered(350));
        expect(deferred.map(page => page.words.length)).toEqual([0, 350]);
        expect(deferred[0]!.tables).toHaveLength(0);
        expect(deferred[1]!.tables).toHaveLength(1);
      } finally { small.free(); }
    } finally { d.free(); }
  });

  it.each(["hwp", "hwpx"] as const)("row pagination boundary product edit/reflow/history and %s preservation", async format => {
    const words = numbered(580), c = await open(format, true, false, false, false, 1, words);
    const { editor, doc, at, place, settle, run } = c;
    try {
      const before = visibleRow(doc as RowDoc, words);
      expect(before.length).toBe(1);
      const tail = " " + numbered(40).replace(/w(\d+)/g, (_, i: string) => `w${580 + Number(i)}`);
      place({ ...at, offset: words.length });
      const revision = editor.snapshot().revision;
      expect(editor.typeText(tail)).toBe(true); await settle();
      expect(editor.snapshot().revision).toBeGreaterThan(revision);
      const after = visibleRow(doc as RowDoc, words + tail);
      expect(after.length).toBe(2);
      const caret = new RhwpText(doc).caret(editor.caret)!;
      expect(caret.page).toBe(1);
      expect(editor.pointAt(caret.page, caret.x, caret.y + caret.height / 2, false)).toBe(true);
      expect(editor.caret.cell).toMatchObject(at.cell!);
      await run("edit.undo"); expect(visibleRow(doc as RowDoc, words).length).toBe(1);
      await run("edit.redo"); expect(visibleRow(doc as RowDoc, words + tail).length).toBe(2);
      const saved = await c.save();
      expect(saved.publishable, JSON.stringify(saved.raw)).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as RowDoc;
      try {
        expect(visibleRow(reopened, words + tail).length).toBe(2);
        expect(new RhwpText(reopened).ownsNestedCell(at)).toBe(true);
        expect(JSON.parse(reopened.getTableDimensionsByPath!(0, at.paragraph, pathJson(at.cell!)))).toMatchObject({ rowCount: 1, colCount: 1 });
      } finally { reopened.free(); }
    } finally { doc.free(); }
  });

  /** Every page's render tree: deepest Table nesting, and the numbered deep words in page order. */
  function deepLayout(d: RhwpDocument & { pageCount(): number; getPageRenderTree(page: number): string }) {
    type Node = { type: string; text?: string; bbox: { x: number; y: number; w: number; h: number }; children?: Node[] };
    let nesting = 0; const words: string[] = [], tables: Node["bbox"][][] = [];
    for (let page = 0; page < d.pageCount(); page++) {
      /** Returns whether `n` contains a Table; a Table without a descendant Table ends one bounds chain. */
      const walk = (n: Node, depth: number, chain: Node["bbox"][]): boolean => {
        if (n.type === "Table") { depth++; chain = [...chain, n.bbox]; if (depth > nesting) nesting = depth; }
        if (n.type === "TextRun" && n.text) words.push(...n.text.split(/\s+/).filter(w => /^w\d+$/.test(w)));
        let inner = false;
        for (const c of n.children ?? []) inner = walk(c, depth, chain) || inner;
        if (n.type === "Table" && !inner) tables.push(chain);
        return inner || n.type === "Table";
      };
      walk(JSON.parse(d.getPageRenderTree(page)), 0, []);
    }
    return { pages: d.pageCount(), nesting, words, tables };
  }

  it("existing 16-level HWP document: full layout, deep editing/IME/Undo/Redo, product T009 save and reopen", async () => {
    const DEPTH = 16, c = await open("hwp", true, false, false, false, DEPTH), { editor, doc, at, place, run, settle } = c;
    try {
      const nested = Array.from({ length: DEPTH - 1 }, () => ({ control: 0, cell: 0, cellParagraph: 0 }));
      const deep: DocPosition = { ...at, offset: 0, cell: { ...at.cell!, nested } };
      const text = new RhwpText(doc);
      expect(text.ownsNestedCell(deep)).toBe(true);
      expect(text.text(deep, 6)).toBe("w0 w1 ");
      // Measured and paginated from real content: all 16 levels, every word exactly once in order, across pages.
      const layout = deepLayout(doc as never);
      expect(layout.nesting).toBe(DEPTH);
      expect(layout.pages).toBeGreaterThan(1);
      expect(layout.words).toEqual(DEEP_WORDS.split(" "));
      // Parent/child bounds nest on every page (no zero-height or escaping child).
      for (const chain of layout.tables) for (let i = 1; i < chain.length; i++) {
        const [o, n] = [chain[i - 1]!, chain[i]!];
        expect(n.h).toBeGreaterThan(0);
        expect(n.x).toBeGreaterThanOrEqual(o.x); expect(n.x + n.w).toBeLessThanOrEqual(o.x + o.w + 0.5);
        expect(n.y).toBeGreaterThanOrEqual(o.y - 0.5); expect(n.y + n.h).toBeLessThanOrEqual(o.y + o.h + 0.5);
      }
      const last = text.caret({ ...deep, offset: text.paragraphLength(deep) })!;
      expect(last.page).toBeGreaterThan(0);
      // Caret by pointer: the hit resolves to the same explicit 16-level path.
      const first = text.caret({ ...deep, offset: 1 })!;
      expect(editor.pointAt(first.page, first.x + 1, first.y + first.height / 2, false)).toBe(true);
      expect(editor.caret.cell!.nested).toEqual(nested);
      // Insert/delete, Undo/Redo, IME and formatting at level 16.
      const before = doc.getTextFileText(), length = text.paragraphLength(deep);
      place({ ...deep, offset: 2 }); expect(editor.typeText("XY")).toBe(true); await settle();
      expect(text.text(deep, 6)).toBe("w0XY w");
      expect(editor.caret).toMatchObject({ offset: 4, cell: { nested } });
      expect(editor.backspace()).toBe(true); await settle();
      expect(text.text(deep, 5)).toBe("w0X w");
      await run("edit.undo"); await run("edit.undo");
      expect(doc.getTextFileText()).toBe(before);
      await run("edit.redo"); await run("edit.redo");
      expect(text.text(deep, 5)).toBe("w0X w");
      place({ ...deep, offset: 3 });
      editor.beginComposition(); expect(editor.composing).toBe(true);
      editor.updateComposition("가"); editor.endComposition("가"); await settle();
      expect(text.text(deep, 6)).toBe("w0X가 w");
      expect(text.paragraphLength(deep)).toBe(length + 2);
      place({ ...deep, offset: 0 }); editor.caret = { ...deep, offset: 2 };
      expect(editor.selectionRects().length).toBeGreaterThan(0);
      await run("format.bold");
      expect(JSON.parse(doc.getCellCharPropertiesAtByPath!(0, at.paragraph, pathJson(deep.cell!), 0)).bold).toBe(true);
      expect(new RhwpText(doc).ownsNestedCell(deep)).toBe(true);
      const edited = doc.getTextFileText(), relaid = deepLayout(doc as never);
      expect(relaid.nesting).toBe(DEPTH);
      // "w0X가" no longer matches the word pattern (the bold "w0" may form its own run); every other word stays once, in order.
      expect(relaid.words.filter(w => w !== "w0")).toEqual(DEEP_WORDS.split(" ").slice(1));
      // Product save: live/reopen comparison and the real T009 checker; then an independent engine reopen.
      const saved = await c.save();
      expect(saved.publishable, JSON.stringify(saved.raw)).toBe(true);
      const re = new engine.HwpDocument(saved.output) as Doc;
      try {
        expect(re.getTextFileText()).toBe(edited);
        const rt = new RhwpText(re);
        expect(rt.ownsNestedCell(deep)).toBe(true);
        expect(rt.text(deep, 6)).toBe("w0X가 w");
        expect(JSON.parse(re.getTableDimensionsByPath!(0, at.paragraph, pathJson(deep.cell!)))).toMatchObject({ rowCount: 1, colCount: 1 });
        expect(JSON.parse(re.getCellCharPropertiesAtByPath!(0, at.paragraph, pathJson(deep.cell!), 0)).bold).toBe(true);
        expect(deepLayout(re as never).nesting).toBe(DEPTH);
      } finally { re.free(); }
    } finally { editor.dispose(); }
  }, 30_000);

  it("existing 12-level HWPX document edits and saves; a 16-level HWPX is refused instead of opening empty", async () => {
    const DEPTH = 12, c = await open("hwpx", true, false, false, false, DEPTH), { editor, doc, at, place, settle } = c;
    try {
      const nested = Array.from({ length: DEPTH - 1 }, () => ({ control: 0, cell: 0, cellParagraph: 0 }));
      const deep: DocPosition = { ...at, offset: 0, cell: { ...at.cell!, nested } };
      const layout = deepLayout(doc as never);
      expect(layout.nesting).toBe(DEPTH);
      expect(layout.words).toEqual(DEEP_WORDS.split(" "));
      place({ ...deep, offset: 2 }); expect(editor.typeText("Z")).toBe(true); await settle();
      const reopened = checkHwpx(c.original, doc);
      try { expect(new RhwpText(reopened).text(deep, 4)).toBe("w0Z "); } finally { reopened.free(); }
    } finally { editor.dispose(); }
    // Beyond the HWPX reader envelope: an explicit nesting refusal, never a silently empty section.
    const over = fixture("hwpx", true, false, false, false, 16);
    expect(() => new engine.HwpDocument(over)).toThrow(/nesting/i);
  }, 30_000);

  it.each(["hwp", "hwpx"] as const)("%s: product body-table rectangular merge invokes the engine and reopens", async format => {
    const { editor, doc, at, place, run } = await open(format);
    try {
      place(at); editor.caret = withCell(at, 3);
      await run("table.mergeCells");
      expect(JSON.parse(doc.getTableDimensions(0, at.paragraph, at.cell!.control)).cellCount).toBe(1);
      expect(doc.getCellParagraphCount(0, at.paragraph, at.cell!.control, 0)).toBe(4);
      const saved = exported(doc, format);
      writeFileSync(join(out, `range.${format}`), saved.bytes);
      const reopened = new engine.HwpDocument(new Uint8Array(readFileSync(join(out, `range.${format}`)))) as Doc;
      try {
        expect(reopened.getTextFileText()).toBe(doc.getTextFileText());
        expect(JSON.parse(reopened.getTableDimensions(0, at.paragraph, at.cell!.control))).toMatchObject({ rowCount: 2, colCount: 2, cellCount: 1 });
        expect(reopened.getCellParagraphCount(0, at.paragraph, at.cell!.control, 0)).toBe(4);
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  it("HWP: original nested table evolves, new nested table, nested metrics; product save passes T009 and reopens", async () => {
    const { editor, doc, at, place, run, settle, save } = await open("hwp", false, true);
    try {
      // The original nested table (created in cell 0 before export) is part of a complete reopen baseline.
      const child = { ...at, cell: { ...at.cell!, nested: [{ control: 0, cell: 0, cellParagraph: 0 }] } };
      place(child); editor.caret = { ...child, offset: 5 };
      await run("hangul.charWidth", { command: "hangul.charWidth", percent: 120 });
      place(child); await run("table.insertRowBelow");
      place(withCell(child, 3)); expect(editor.typeText("셀")).toBe(true); await settle();
      // A new nested table in another outer cell, edited and restructured before the save.
      place(withCell(at, 1)); await run("insert.table", { command: "insert.table", rows: 2, cols: 2 });
      const created = editor.caret;
      expect(created.cell!.nested).toHaveLength(1);
      expect(editor.typeText("new")).toBe(true); await settle();
      await run("table.insertColumnRight");
      // HWP nested formula: persistent insertion, replacement, recalculation after a nested structure change.
      place(withCell(created, 2));
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=1+2" });
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=2*3" });
      const nestedFormula = () => (JSON.parse(doc.getFieldList!()) as { fieldId: number; fieldType: string; command: string; location: { path: unknown[] } }[])
        .filter(f => f.fieldType === "formula");
      expect(nestedFormula().map(f => [f.command, f.location.path.length])).toEqual([["=2*3??%g,;;6", 2]]);
      const formulaId = nestedFormula()[0]!.fieldId;
      place(withCell(created, 0)); await run("table.insertRowAbove");
      expect(nestedFormula().map(f => [f.fieldId, f.command])).toEqual([[formulaId, "=2*3??%g,;;6"]]);
      // A newly inserted outer cell can own a newly created child; it cannot
      // borrow an original child merely because its bytes still occur globally.
      place(withCell(at, 3)); await run("table.insertRowBelow");
      place(withCell(at, 4)); await run("insert.table", { command: "insert.table", rows: 1, cols: 1 });
      const fresh = editor.caret;
      place(withCell(at, 5)); await run("table.insertColumnRight");
      const freshMoved = { ...fresh, cell: { ...fresh.cell!, cell: 6 } };
      expect(JSON.parse(doc.getTableDimensionsByPath!(0, at.paragraph, pathJson(freshMoved.cell)))).toMatchObject({ rowCount: 1, colCount: 1 });
      const saved = await save();
      expect(Object.values(saved.reopen).every(Boolean), JSON.stringify(saved.reopen)).toBe(true);
      expect(saved.raw.findings.every(f => f.code === "previewStale"), JSON.stringify(saved.raw)).toBe(true);
      expect(saved.publishable).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        expect(reopened.getTextFileText()).toBe(doc.getTextFileText());
        expect(JSON.parse(reopened.getTableDimensionsByPath!(0, at.paragraph, pathJson(child.cell)))).toMatchObject({ rowCount: 3, colCount: 2 });
        expect(JSON.parse(reopened.getCellCharPropertiesAtByPath!(0, at.paragraph, pathJson(child.cell), 0)).ratios[0]).toBe(120);
        expect(JSON.parse(reopened.getTableDimensionsByPath!(0, at.paragraph, pathJson(created.cell!)))).toMatchObject({ rowCount: 3, colCount: 3 });
        expect((JSON.parse(reopened.getFieldList!()) as { fieldId: number; fieldType: string; command: string; location: { path: unknown[] } }[])
          .filter(f => f.fieldType === "formula").map(f => [f.fieldId, f.command, f.location.path.length])).toEqual([[formulaId, "=2*3??%g,;;6", 2]]);
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  it("A1/A2: empty nested cells select and merge; a refused cross-context extension reports false and keeps state", async () => {
    const { editor, doc, at, place, run } = await open();
    try {
      place(at); await run("insert.table", { command: "insert.table", rows: 2, cols: 2 });
      const nested = editor.caret, text = new RhwpText(doc);
      // No text anywhere in the nested table: ownership comes from table/cell provenance, not TextRuns.
      const rect = text.caret(withCell(nested, 3))!;
      expect(editor.pointAt(rect.page, rect.x + 1, rect.y + rect.height / 2, true)).toBe(true);
      expect(editor.selectionRects()).toHaveLength(4);
      // Shift+click outside the anchor's table (the trailing body paragraph): refused, reported, no state change.
      const body = text.caret({ section: 0, paragraph: at.paragraph + 1, offset: 0 });
      const before = [editor.anchor, editor.caret];
      if (body) expect(editor.pointAt(body.page, body.x + 1, body.y + body.height / 2, true)).toBe(false);
      expect([editor.anchor, editor.caret]).toEqual(before);
      await run("table.mergeCells");
      expect(JSON.parse(doc.getTableDimensionsByPath!(0, at.paragraph, pathJson(editor.caret.cell!))).cellCount).toBe(1);
    } finally { editor.dispose(); }
  });

  it("HWPX rich table: picture, child table, ClickHere-free formulas relocate; nested formula; save and reopen", async () => {
    const c = await open("hwpx", false, false, true), { editor, doc, at, place, run, settle } = c;
    try {
      const control = at.cell!.control, para = at.paragraph;
      place(withCell(at, 3)); await run("insert.table", { command: "insert.table", rows: 1, cols: 2 });
      const child = editor.caret;
      expect(editor.typeText("7")).toBe(true); await settle();
      // Nested formula through the product: same evaluator/field model, explicit path ownership.
      const nestedCell = withCell(child, 1);
      place(nestedCell);
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=A1*2" });
      expect(doc.getTextInCellByPath!(0, para, pathJson(nestedCell.cell!), 0, 2)).toBe("14");
      // Body formula in A3 reading A1:A2.
      place(withCell(at, 4));
      const caption = () => doc.getTableCaptionByPath!(0, para, JSON.stringify([{ controlIndex: control, cellIndex: 0, cellParaIndex: 0 }]));
      const captionBefore = caption();
      expect(captionBefore).toContain("Cap");
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=SUM(A1:A2)" });
      expect(doc.getTextInCell(0, para, control, 4, 0, 0, 1)).toBe("3");
      // Insert a row above the first row: the formula moves to A4, references become A2:A3, value is recalculated.
      place(withCell(at, 0)); await run("table.insertRowAbove");
      const fields = () => (JSON.parse(doc.getFieldList!()) as { fieldType: string; command: string; value: string; location: { path: unknown[] } }[])
        .filter(f => f.fieldType === "formula");
      expect(fields().map(f => f.command).sort()).toEqual(["=A1*2??%g,;;14", "=SUM(A2:A3)??%g,;;3"]);
      expect(JSON.parse(doc.getTableDimensions(0, para, control))).toMatchObject({ rowCount: 4, colCount: 2 });
      // The caption is kept; the floating picture and the child table are preserved (the child moved row 1 → row 2).
      expect(caption()).toBe(captionBefore);
      const ctl = JSON.parse(doc.getControls!()) as { ctrlId: string; userDesc: string }[];
      expect(ctl.filter(x => x.ctrlId === "gso").length).toBe(1);
      expect(ctl.filter(x => x.ctrlId === "tbl").length).toBe(2);
      // A deletion whose formula references would dangle is refused before any engine call.
      place(withCell(at, 2));
      expect(documentCommandState("table.deleteRow", editor.snapshot()).available).toBe(true);
      const beforeRefusal = doc.getTextFileText();
      expect(editor.execute("table.deleteRow").accepted).toBe(false);
      expect(doc.getTextFileText()).toBe(beforeRefusal);
      // Deleting the inserted empty first row restores the references; Undo/Redo stays coherent.
      place(withCell(at, 0)); await run("table.deleteRow");
      expect(fields().map(f => f.command).sort()).toEqual(["=A1*2??%g,;;14", "=SUM(A1:A2)??%g,;;3"]);
      await run("edit.undo"); expect(fields().map(f => f.command).sort()).toEqual(["=A1*2??%g,;;14", "=SUM(A2:A3)??%g,;;3"]);
      await run("edit.redo");
      // Nested structure change rewrites the nested formula's references (column inserted left of A).
      place(withCell(child, 0)); await run("table.insertColumnLeft");
      expect(fields().map(f => f.command).sort()).toEqual(["=B1*2??%g,;;14", "=SUM(A1:A2)??%g,;;3"]);
      const reopened = checkHwpx(c.original, doc);
      try {
        expect((JSON.parse(reopened.getFieldList!()) as { fieldType: string; command: string }[]).filter(f => f.fieldType === "formula")
          .map(f => f.command).sort()).toEqual(["=B1*2??%g,;;14", "=SUM(A1:A2)??%g,;;3"]);
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  it("T009 HWP: child tables follow an explicit cell correspondence; unjustified loss is refused", () => {
    // Original: 2x2 body table, child table in cell (0,0). Outputs are produced by the engine's own operations.
    const original = fixture("hwp", false, true);
    const variant = (edit: (d: Doc, para: number, control: number) => void) => {
      const d = new engine.HwpDocument(original) as Doc;
      try {
        const t = JSON.parse(d.getControls!()).find((c: { ctrlId: string; list: number }) => c.ctrlId === "tbl" && c.list === 0);
        edit(d, t.para, t.controlIndex);
        const e = exported(d, "hwp");
        return check("hwp", "saved", original, e.bytes, e.loss, true);
      } finally { d.free(); }
    };
    const accepted = (r: ReturnType<typeof check>) => r.findings.every(f => f.code === "previewStale");
    const host = (control: number) => JSON.stringify([{ controlIndex: control, cellIndex: 0, cellParaIndex: 0 }]);
    // 1. Deleting the other row keeps the child in its surviving cell.
    { const r = variant((d, p, c) => d.deleteTableRow!(0, p, c, 1)); expect(accepted(r), JSON.stringify(r)).toBe(true); }
    // 2. Deleting the row that owns the child legitimately removes it.
    expect(accepted(variant((d, p, c) => d.deleteTableRow(0, p, c, 0))), "owner deleted").toBe(true);
    // 3. Same cell-count reduction, but the child disappears from its surviving cell: refused.
    const lost = variant((d, p, c) => { d.deleteTableRow(0, p, c, 1); (d as unknown as Record<string, (...a: unknown[]) => string>).deleteCellTableControlByPath!(0, p, host(c), 0); });
    expect(accepted(lost), JSON.stringify(lost)).toBe(false);
    expect(lost.outcome).toBe("unsafe");
    // 4. A merge keeps the absorbed/anchor children; losing the child during the merge is refused.
    expect(accepted(variant((d, p, c) => d.mergeTableCells!(0, p, c, 0, 0, 0, 1))), "merge retained").toBe(true);
    expect(accepted(variant((d, p, c) => { d.mergeTableCells!(0, p, c, 0, 0, 0, 1);
      (d as unknown as Record<string, (...a: unknown[]) => string>).deleteCellTableControlByPath!(0, p, host(c), 0); })), "merge lost").toBe(false);
  });

  it("HWP field-rich captioned table: structure ops move formula/ClickHere fields and rewrite references; T009 save and reopen", async () => {
    const { editor, doc, at, place, run, save } = await open("hwp", false, false, true);
    try {
      const control = at.cell!.control, para = at.paragraph;
      const caption = () => doc.getTableCaptionByPath!(0, para, JSON.stringify([{ controlIndex: control, cellIndex: 0, cellParaIndex: 0 }]));
      const fields = (d: RhwpDocument) => (JSON.parse(d.getFieldList!()) as { fieldId: number; fieldType: string; command: string; value: string; location: unknown }[])
        .map(f => ({ id: f.fieldId, type: f.fieldType, command: f.command, location: f.location })).sort((a, b) => a.id - b.id);
      const captionBefore = caption(), clickBefore = fields(doc).find(f => f.type === "clickhere")!;
      expect(captionBefore).toContain("Cap");
      place(withCell(at, 0)); await run("table.insertRowAbove");
      place(withCell(at, 0)); editor.caret = withCell(at, 1); await run("table.mergeCells");
      await run("table.splitCell");
      place(withCell(at, 0)); await run("table.insertColumnLeft");
      const formula = fields(doc).find(f => f.type === "formula")!;
      expect(formula.command).toBe("=SUM(B2:B3)??%g,;;3");
      const click = fields(doc).find(f => f.type === "clickhere")!;
      expect([click.id, click.command]).toEqual([clickBefore.id, clickBefore.command]);
      expect(caption()).toBe(captionBefore);
      // A reference that would dangle refuses the deletion before any engine call.
      place(withCell(at, 3)); const unchanged = doc.getTextFileText();
      expect(editor.execute("table.deleteRow").accepted).toBe(false);
      expect(doc.getTextFileText()).toBe(unchanged);
      const saved = await save();
      expect(Object.values(saved.reopen).every(Boolean), JSON.stringify(saved.reopen)).toBe(true);
      expect(saved.raw.findings.every(f => f.code === "previewStale"), JSON.stringify(saved.raw)).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        expect(fields(reopened)).toEqual(fields(doc));
        expect(reopened.getTableCaptionByPath!(0, para, JSON.stringify([{ controlIndex: control, cellIndex: 0, cellParaIndex: 0 }]))).toBe(captionBefore);
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  for (const format of ["hwp", "hwpx"] as const) it(`dependent cache ${format}: numeric source edit cannot publish a stale formula`, async () => {
    const seed = engine.HwpDocument.createEmpty() as Doc;
    let original: Uint8Array;
    try {
      seed.createBlankDocument();
      const t = JSON.parse(seed.createTable!(0, 0, 0, 1, 2));
      seed.setTableProperties!(0, t.paraIdx, t.controlIdx, JSON.stringify(format === "hwp" ? HWP_TABLE_NORMALIZATION : { textWrap: "TopAndBottom" }));
      seed.insertTextInCell(0, t.paraIdx, t.controlIdx, 0, 0, 0, "10");
      expect(JSON.parse(seed.insertTableFormulaField!(0, t.paraIdx, t.controlIdx, 0, 1, "=A1*2")).ok).toBe(true);
      original = exported(seed, format).bytes;
    } finally { seed.free(); }
    const c = await open(format, false, false, false, false, 0, DEEP_WORDS, { original });
    const { editor, doc, at, place, settle, save } = c;
    const fields = (d: RhwpDocument = doc) => JSON.parse(d.getFieldList!());
    try {
      const before = fields(); expect(before[0]).toMatchObject({ value: "20", command: "=A1*2??%g,;;20" });
      place({ ...at, offset: 1 }); editor.anchor = { ...at, offset: 2 };
      expect(editor.typeText("1")).toBe(true); await settle();
      expect(new RhwpText(doc).text(at, 2)).toBe("11");
      const revision = editor.snapshot().revision;
      const saved = await save(true);
      writeFileSync(join(out, `dependent-original.${format}`), original);
      writeFileSync(join(out, `dependent-edited.${format}`), saved.output);
      writeFileSync(join(out, `dependent-${format}.json`), JSON.stringify({ generation: build.generation, before, after: fields(), text: doc.getTextFileText(), ...saved }, (_, v) => v instanceof Uint8Array ? undefined : v, 2));
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        writeFileSync(join(out, `dependent-reopen-${format}.json`), JSON.stringify({ fields: fields(reopened), text: reopened.getTextFileText() }, null, 2));
        expect(saved.publishable, "stale dependent cache must not publish").toBe(false);
        expect(saved.refusedBeforeBackend).toBe(true);
        // Stage 4: the refusal is reported as an unrecalculated formula, not as an engine export failure.
        expect(editor.saveState).toEqual({ kind: "failed", error: { code: "SaveFailure", stage: "export", reason: "formulaCache" } });
        expect(fields(reopened)[0].value).toBe("20"); // raw engine export is diagnostic, never published
        expect(editor.hasUnpreservedChanges).toBe(true);
        expect(editor.snapshot().revision).toBe(revision);
        expect(fields()).toEqual(before); // refusal never rewrites ID/range/cache
        if (format === "hwp") {
          expect(saved.raw.findings.some(f => f.code === "outputMalformed")).toBe(true);
          const evidence = join(out, "publication"), folder = join(evidence, "source-only-stale");
          mkdirSync(folder, { recursive: true });
          writeFileSync(join(evidence, "cases.json"), JSON.stringify([{ id: "source-only-stale", negative: true, expectedCode: "outputMalformed" }]));
          writeFileSync(join(folder, "original.hwp"), original); writeFileSync(join(folder, "edited.hwp"), saved.output);
          for (const name of ["noop.hwp", "noop-loss.json"]) writeFileSync(join(folder, name), readFileSync(join(out, name)));
          writeFileSync(join(folder, "loss.json"), JSON.stringify(saved.contentLoss));
          writeFileSync(join(folder, "render.svg"), doc.renderPageSvg(0));
          execFileSync("rsvg-convert", ["--width", "724", "--height", "1024", "--output", join(folder, "render.png"), join(folder, "render.svg")]);
          writeFileSync(join(folder, "proof.json"), JSON.stringify({ originalSha256: createHash("sha256").update(original).digest("hex"),
            editedSha256: createHash("sha256").update(saved.output).digest("hex"), reopenEqual: true, engineGeneration: build.generation }));
        }
      } finally { reopened.free(); }
      await c.run("edit.undo");
      expect(new RhwpText(doc).text(at, 2)).toBe("10");
      expect((await save(true)).publishable).toBe(true);
      await c.run("edit.redo");
      expect((await save(true)).refusedBeforeBackend).toBe(true);
      // Existing explicit formula replacement recalculates without a new field ID.
      place(withCell(at, 1));
      await c.run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=A1*2" });
      expect(fields()[0]).toMatchObject({ fieldId: before[0].fieldId, value: "22", command: "=A1*2??%g,;;22" });
      const corrected = await save(true); expect(corrected.publishable, JSON.stringify(corrected.raw)).toBe(true);
      const fresh = new engine.HwpDocument(corrected.output) as Doc;
      try {
        expect(fields(fresh)[0].value).toBe("22");
        writeFileSync(join(out, `dependent-corrected.${format}`), corrected.output);
        writeFileSync(join(out, `dependent-corrected-${format}.json`), JSON.stringify({ fields: fields(fresh), text: fresh.getTextFileText(), raw: corrected.raw }, null, 2));
      } finally { fresh.free(); }
    } finally { editor.dispose(); }
  });

  for (const format of ["hwp", "hwpx"] as const) it(`inline formulas ${format}: exact second replacement, text, dependencies, structure, history and save`, async () => {
    const c = await open(format, false, false, true, false, 0, DEEP_WORDS, { inlineFormulas: true });
    const { editor, doc, at, place, run, settle, save } = c;
    type Formula = { fieldId: number; command: string; value: string; startCharIdx: number; endCharIdx: number; controlIndex: number; controlPos: number; location: unknown };
    const fields = (d: RhwpDocument = doc) => (JSON.parse(d.getFieldList!()) as (Formula & { fieldType: string })[]).filter(f => f.fieldType === "formula");
    const target = { ...withCell(at, 5), offset: 17 };
    const text = () => new RhwpText(doc).text({ ...target, offset: 0 }, new RhwpText(doc).paragraphLength(target));
    try {
      const initial = fields();
      expect(initial).toHaveLength(2);
      expect(new Set(initial.map(f => f.fieldId)).size).toBe(2);
      expect(initial.map(f => [f.startCharIdx, f.endCharIdx, f.controlIndex])).toEqual([[6, 7, 0], [17, 18, 1]]);
      expect(text()).toBe("Sum😀: 3, Double: 2 won");
      place(target);
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=A1*30" });
      expect(fields()[0]).toEqual(initial[0]);
      expect(fields()[1]).toMatchObject({ fieldId: initial[1]!.fieldId, command: "=A1*30??%g,;;30", value: "30" });
      expect(editor.caret.offset).toBe(19);
      await run("edit.undo"); expect(fields()).toEqual(initial);
      await run("edit.redo"); expect(text()).toBe("Sum😀: 3, Double: 30 won");
      // Replacing the first partial SUM field also leaves the second formula exact.
      const second = fields()[1]; place({ ...target, offset: 6 });
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=A1*3" });
      expect(fields()[0]!.fieldId).toBe(initial[0]!.fieldId); expect(fields()[1]).toEqual(second);
      expect(text()).toBe("Sum😀: 3, Double: 30 won");
      // Ordinary text at both field boundaries is outside the formula, with stable ID.
      place({ ...target, offset: 6 }); expect(editor.typeText("prefix ")).toBe(true); await settle();
      place({ ...target, offset: new RhwpText(doc).paragraphLength(target) }); expect(editor.typeText(" suffix")).toBe(true); await settle();
      expect(fields().map(f => f.fieldId)).toEqual(initial.map(f => f.fieldId));
      const textBeforeDelete = doc.getTextFileText(), fieldsBeforeDelete = fields();
      place({ ...target, offset: 6 }); editor.anchor = { ...editor.caret, offset: 13 }; // ordinary prefix only
      expect(editor.deleteForward()).toBe(true); await settle();
      expect(text()).toBe("Sum😀: 3, Double: 30 won suffix");
      expect(fields().map(f => f.fieldId)).toEqual(initial.map(f => f.fieldId));
      await run("edit.undo"); expect(fields()).toEqual(fieldsBeforeDelete); expect(doc.getTextFileText()).toBe(textBeforeDelete);
      await run("edit.redo"); expect(text()).toBe("Sum😀: 3, Double: 30 won suffix");
      await run("edit.undo");
      place({ ...target, offset: fields()[0]!.endCharIdx });
      expect(editor.moveHorizontal(1, false)).toBe(true); expect(editor.caret.offset).toBe(fields()[0]!.endCharIdx + 1);
      expect(editor.moveHorizontal(-1, false)).toBe(true); expect(editor.caret.offset).toBe(fields()[0]!.endCharIdx);
      const readonly = { revision: editor.snapshot().revision, history: editor.snapshot().history, dirty: editor.hasUnpreservedChanges, text: doc.getTextFileText(), fields: fields() };
      expect(editor.execute("hangul.tableFormula", { command: "hangul.tableFormula", formula: "=A1+A2" }).accepted).toBe(true);
      expect({ revision: editor.snapshot().revision, history: editor.snapshot().history, dirty: editor.hasUnpreservedChanges, text: doc.getTextFileText(), fields: fields() }).toEqual(readonly);
      const before = doc.getTextFileText(), inventory = fields();
      // Unsupported formula-result deletion is an ordinary refusal, never uncertainty.
      place({ ...target, offset: inventory[0]!.startCharIdx });
      editor.anchor = { ...editor.caret, offset: inventory[0]!.endCharIdx };
      expect(editor.deleteForward()).toBe(false);
      expect(editor.snapshot().editable).toBe(true); expect(editor.hasUncertainChanges).toBe(false); expect(fields()).toEqual(inventory);
      place({ ...target, offset: inventory[1]!.startCharIdx + 1 });
      expect(editor.typeText("X")).toBe(false); expect(editor.enter()).toBe(false);
      editor.beginComposition(); expect(editor.snapshot().composing).toBeFalsy();
      expect(fields()).toEqual(inventory);
      // Direct self-reference through an inactive IF branch is also refused atomically.
      place({ ...target, offset: inventory[1]!.startCharIdx });
      expect(editor.execute("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=IF(1,2,B3)" }).accepted).toBe(false);
      expect(doc.getTextFileText()).toBe(before); expect(fields()).toEqual(inventory);
      // Another cell must not treat mixed text/formulas as an arbitrary numeric operand.
      place(withCell(at, 4));
      expect(editor.execute("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=B3+1" }).accepted).toBe(false);
      place(withCell(at, 0)); await run("table.insertRowAbove");
      expect(fields().map(f => [f.fieldId, f.command])).toEqual([[initial[0]!.fieldId,"=A2*3??%g,;;3"],[initial[1]!.fieldId,"=A2*30??%g,;;30"]]);
      // Insert before existing fields, shifting their control slots without changing identity.
      place(withCell(at, 7));
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=4+1" });
      expect(fields()).toHaveLength(3);
      expect(fields().map(f => f.controlIndex)).toEqual([0,1,2]);
      expect(fields().slice(1).map(f => f.fieldId)).toEqual(initial.map(f => f.fieldId));
      expect(new Set(fields().map(f => f.fieldId)).size).toBe(3);
      const saved = await save();
      expect(saved.publishable, JSON.stringify({ raw: saved.raw, reopen: saved.reopen })).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try { expect(fields(reopened)).toEqual(fields()); expect(reopened.getTextFileText()).toBe(doc.getTextFileText()); } finally { reopened.free(); }
      const movedTarget = withCell(at, 7), textModel = new RhwpText(doc);
      const expectedText = textModel.text(movedTarget, textModel.paragraphLength(movedTarget));
      const rendered: string[] = [];
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (!v || typeof v !== "object") return;
        const n = v as Record<string, unknown>;
        if (n.type === "TextRun" && typeof n.text === "string") rendered.push(n.text);
        Object.values(n).forEach(walk);
      };
      for (let page = 0; page < doc.pageCount(); page++) walk(JSON.parse(doc.getPageRenderTree(page)));
      expect(rendered.join("")).toContain(expectedText);
      for (const offset of [0, ...fields().flatMap(f => [f.startCharIdx,f.endCharIdx]), textModel.paragraphLength(movedTarget)])
        expect(textModel.caret({ ...movedTarget, offset })).not.toBeNull();
      const svg = doc.renderPageSvg(0);
      // SVG emits separate visible glyphs and represents spaces by advances; render-tree text above retains all whitespace.
      const svgText = [...svg.matchAll(/<text\b[^>]*>(.*?)<\/text>/gs)].map(m => m[1]!.replace(/<[^>]*>/g, "")).join("");
      expect(svgText.replace(/\s/g, "")).toContain(expectedText.replace(/\s/g, ""));
      if (format === "hwp") {
        const evidence = join(out, "inline-formula-publication"), folder = join(evidence, "multiple-partial");
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(evidence, "cases.json"), JSON.stringify([{ id: "multiple-partial" }]));
        writeFileSync(join(folder, "original.hwp"), c.original);
        writeFileSync(join(folder, "edited.hwp"), saved.output);
        for (const name of ["noop.hwp", "noop-loss.json"]) writeFileSync(join(folder, name), readFileSync(join(out, name)));
        writeFileSync(join(folder, "loss.json"), JSON.stringify(saved.contentLoss));
        writeFileSync(join(folder, "render.svg"), svg);
        execFileSync("rsvg-convert", ["--width", "724", "--height", "1024", "--output", join(folder, "render.png"), join(folder, "render.svg")]);
        writeFileSync(join(folder, "proof.json"), JSON.stringify({ originalSha256: createHash("sha256").update(c.original).digest("hex"),
          editedSha256: createHash("sha256").update(saved.output).digest("hex"), reopenEqual: Object.values(saved.reopen).every(Boolean),
          engineGeneration: build.generation, fields: fields() }));
      }
    } finally { editor.dispose(); }
  });

  for (const format of ["hwp", "hwpx"] as const) it(`inline formulas nested ${format}: product insertion into a later paragraph, exact ownership and history`, async () => {
    const { editor, doc, at, place, run, settle, save } = await open(format, false, true);
    try {
      const child = { ...at, cell: { ...at.cell!, nested: [{ control: 0, cell: 1, cellParagraph: 0 }] } };
      place(child); expect(editor.typeText("Before ")).toBe(true); await settle();
      expect(editor.enter()).toBe(true); await settle();
      const paragraph = editor.caret;
      expect(paragraph.cell!.nested![0]!.cellParagraph).toBe(1);
      expect(editor.typeText("Sum:  / Double:  won")).toBe(true); await settle();
      place({ ...paragraph, offset: 5 });
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=10+20" });
      place({ ...paragraph, offset: 18 });
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=10*2" });
      const fields = () => (JSON.parse(doc.getFieldList!()) as Record<string, unknown>[]).filter(f => f.fieldType === "formula");
      expect(fields().map(f => [f.value, f.startCharIdx, f.endCharIdx])).toEqual([["30",5,7],["20",18,20]]);
      expect(fields().every(f => (f.location as { path: { paraIndex: number }[] }).path.length === 2
        && (f.location as { path: { paraIndex: number }[] }).path[1]!.paraIndex === 1)).toBe(true);
      expect(new RhwpText(doc).text({ ...paragraph, offset: 0 }, 25)).toBe("Sum: 30 / Double: 20 won");
      const inserted = fields();
      await run("edit.undo"); expect(fields()).toHaveLength(1);
      await run("edit.redo"); expect(fields()).toEqual(inserted);
      // A later-paragraph formula cell is mixed too; neither product nor native may read paragraph zero as an arbitrary operand.
      const other = withCell(child,0), beforeReference = doc.getFieldList!(); place(other);
      expect(editor.execute("hangul.insertTableFormula", { command:"hangul.insertTableFormula",formula:"=B1" }).accepted).toBe(false);
      expect(JSON.parse(doc.validateTableFormulaAt!(0,at.paragraph,pathJson(other.cell!),0,0,"=B1"))).toEqual({ ok:false });
      expect(doc.getFieldList!()).toBe(beforeReference);
      const saved = await save();
      expect(saved.publishable, JSON.stringify({ raw: saved.raw, reopen: saved.reopen })).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try { expect(JSON.parse(reopened.getFieldList!())).toEqual(JSON.parse(doc.getFieldList!())); } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  for (const format of ["hwp", "hwpx"] as const) it(`Stage 4 integration ${format}: a general character format and a table structure change publish in one save`, async () => {
    const { editor, at, place, run, save } = await open(format);
    place({ ...at, offset: 0 }); editor.caret = { ...at, offset: 6 };
    await run("format.bold");
    place({ ...at, offset: 0 });
    await run("table.insertRowBelow");
    const saved = await save(true);
    expect(saved.publishable, JSON.stringify(saved.raw)).toBe(true);
  });

  it("inline formulas preserve ClickHere neighbors and refuse an ambiguous empty-field boundary before mutation", () => {
    const doc = new engine.HwpDocument(fixture("hwp", true)) as Doc;
    try {
      const t = JSON.parse(doc.getControls!()).find((c: { ctrlId: string; list: number }) => c.ctrlId === "tbl" && c.list === 0);
      const path = JSON.stringify([{ controlIndex: t.controlIndex, cellIndex: 0, cellParaIndex: 0 }]);
      const api = doc as unknown as Record<string, (...a: unknown[]) => string>;
      const click = JSON.parse(api.insertClickHereFieldInCell!(0,t.para,t.controlIndex,0,0,0,false,"guide","","",true));
      const state = () => [doc.getFieldList!(),doc.getControls!(),doc.getTextFileText()];
      const before = state();
      expect(JSON.parse(doc.validateTableFormulaAt!(0,t.para,path,0,0,"=1"))).toEqual({ ok:false });
      let rejected = false;
      try { doc.insertTableFormulaAt!(0,t.para,path,0,0,"=1"); } catch (error) { rejected=true; expect(error).not.toBeInstanceOf(WebAssembly.RuntimeError); }
      expect(rejected).toBe(true); expect(state()).toEqual(before);
      api.setFieldValue!(click.fieldId,"memo");
      const neighbor = JSON.parse(doc.getFieldList!())[0];
      const originals = { hwp:exported(doc,"hwp").bytes, hwpx:exported(doc,"hwpx").bytes };
      const inserted = JSON.parse(doc.insertTableFormulaAt!(0,t.para,path,4,0,"=1+1"));
      expect(inserted).toMatchObject({ ok:true, start:4,end:5,controlIndex:1,text:"2" });
      expect(JSON.parse(doc.getFieldList!())[0]).toEqual(neighbor);
      expect(inserted.fieldId).not.toBe(click.fieldId);
      for (const format of ["hwp","hwpx"] as const) {
        const output=exported(doc,format), verdict=check(format,"saved",originals[format],output.bytes,output.loss,true);
        expect(verdict.findings.every(f=>f.code==="previewStale"),JSON.stringify(verdict)).toBe(true);
        if (format==="hwpx") expect(verdict.outcome).toBe("safe");
        const reopened=new engine.HwpDocument(output.bytes) as Doc;
        try { expect(JSON.parse(reopened.getFieldList!())).toEqual(JSON.parse(doc.getFieldList!())); expect(reopened.getTextFileText()).toBe(doc.getTextFileText()); }
        finally { reopened.free(); }
      }
    } finally { doc.free(); }
  });

  it("HWP field-only replacement uses real T009 and persists identity/cache", async () => {
    const { editor, doc, at, place, run, save } = await open("hwp");
    try {
      const fields = () => JSON.parse(doc.getFieldList!()) as { fieldId: number; fieldType: string; command: string; value: string }[];
      place(withCell(at, 0));
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=1+2" });
      const id = fields().find(f => f.fieldType === "formula")!.fieldId;
      place(withCell(at, 0)); // Exact field-start affinity; the old ordinary cell text is retained.
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=SUM(B?:B?)+6" });
      const saved = await save();
      expect(saved.publishable, JSON.stringify(saved)).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        const field = (JSON.parse(reopened.getFieldList!()) as { fieldId: number; fieldType: string; command: string; value: string }[]).find(f => f.fieldType === "formula")!;
        expect([field.fieldId, field.command, field.value]).toEqual([id, "=SUM(B?:B?)+6??%g,;;6", "6"]);
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  it("HWP multiple fields: explicit control positions/ranges survive composite product save/reopen", async () => {
    const { editor, doc, at, place, run, save } = await open("hwp", false, false, true, true);
    const clickFields = (d: RhwpDocument) => (JSON.parse(d.getFieldList!()) as Record<string, unknown>[]).filter(f => f.fieldType === "clickhere").sort((a, b) => Number(a.controlIndex) - Number(b.controlIndex));
    const metadata = (d: RhwpDocument) => clickFields(d).map(f => ({ ...f, location: undefined, listId: undefined }));
    try {
      const initial = metadata(doc);
      expect(initial).toHaveLength(2);
      expect(new Set(initial.map(f => f.fieldId)).size).toBe(2);
      expect(initial.map(f => f.controlIndex)).toEqual([0, 1]);
      expect(initial[0]!.endCharIdx).toBeLessThanOrEqual(initial[1]!.startCharIdx as number);
      place(withCell(at, 0)); await run("table.insertRowAbove");
      place(withCell(at, 0)); await run("table.insertColumnLeft");
      expect(metadata(doc)).toEqual(initial);
      await run("edit.undo"); await run("edit.redo");
      expect(metadata(doc)).toEqual(initial);
      const saved = await save();
      expect(saved.publishable, JSON.stringify(saved)).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try { expect(clickFields(reopened)).toEqual(clickFields(doc)); } finally { reopened.free(); }
      // A partial engine mutation that drops exactly one of the two fields must
      // fail the digest proof and restore both independent identities/ranges.
      const before = clickFields(doc), text = doc.getTextFileText();
      const insert = doc.insertTableRow!.bind(doc);
      doc.insertTableRow = (...args) => {
        const result = insert(...args);
        const api = doc as unknown as Record<string, (...a: unknown[]) => string>;
        api.removeFieldAtInCell!(0, at.paragraph, at.cell!.control, 8, 0, 0, false);
        return result;
      };
      place(withCell(at, 0));
      expect(editor.execute("table.insertRowAbove").accepted).toBe(false);
      expect(clickFields(doc)).toEqual(before);
      expect(doc.getTextFileText()).toBe(text);
    } finally { editor.dispose(); }
  });

  it("T009 HWP: a field lost from a surviving cell during a structure change is refused", () => {
    const original = fixture("hwp", false, false, true);
    const d = new engine.HwpDocument(original) as Doc;
    try {
      const t = JSON.parse(d.getControls!()).find((c: { ctrlId: string; list: number }) => c.ctrlId === "tbl" && c.list === 0);
      d.insertTableRow!(0, t.para, t.controlIndex, 0, false);
      // The ClickHere field of B1 (now B2) disappears although its cell survives.
      (d as unknown as Record<string, (...a: unknown[]) => string>).removeFieldAtInCell!(0, t.para, t.controlIndex, 3, 0, 0, false);
      expect((JSON.parse(d.getFieldList!()) as { fieldType: string }[]).some(f => f.fieldType === "clickhere")).toBe(false);
      const e = exported(d, "hwp");
      const result = check("hwp", "saved", original, e.bytes, e.loss, true);
      expect(result.outcome, JSON.stringify(result)).toBe("unsafe");
      expect(result.findings.some(f => f.code !== "previewStale")).toBe(true);
    } finally { d.free(); }
  });

  it("formula rewrite success without the applied final state is detected and rolled back", async () => {
    const { editor, doc, at, place, run } = await open("hwpx", false, false, true);
    try {
      place(withCell(at, 4));
      await run("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula: "=SUM(A1:A2)" });
      const before = doc.getTextFileText(), fields = doc.getFieldList!();
      // The engine answers like a successful replacement (same response shape) but leaves the field unchanged.
      doc.insertTableFormulaAt = (...args) => doc.validateTableFormulaAt!(...args);
      place(withCell(at, 0));
      expect(documentCommandState("table.insertRowAbove", editor.snapshot()).available).toBe(true);
      expect(editor.execute("table.insertRowAbove").accepted).toBe(false);
      expect(doc.getTextFileText()).toBe(before);
      expect(doc.getFieldList!()).toBe(fields);
      expect(JSON.parse(doc.getTableDimensions(0, at.paragraph, at.cell!.control)).rowCount).toBe(3);
    } finally { editor.dispose(); }
  });

  it("a partial nested engine failure restores the exact before snapshot", async () => {
    const c = await open(), { editor, doc, at, place, run } = c;
    try {
      place(at); await run("insert.table", { command: "insert.table", rows: 2, cols: 2 });
      const before = doc.getTextFileText(), path = pathJson(editor.caret.cell!);
      const dimensions = doc.getTableDimensionsByPath!(0, at.paragraph, path);
      const apply = doc.editTableByPath!.bind(doc);
      doc.editTableByPath = (...args) => { apply(...args); throw new Error("after mutation"); };
      expect(editor.execute("table.insertRowAbove").accepted).toBe(false);
      expect(doc.getTextFileText()).toBe(before);
      expect(doc.getTableDimensionsByPath!(0, at.paragraph, path)).toBe(dimensions);
      expect(editor.snapshot().editable).toBe(false);
    } finally { editor.dispose(); }
  });

  it("bounds structural proof reads before allocating a large cell string", () => {
    const doc = { getCellParagraphCount: () => 1, getCellParagraphLength: () => 4 * 1024 * 1024 + 1,
      getTextInCell: () => { throw new Error("must not allocate an over-budget string"); },
      getControls: () => "[]", getFieldList: () => "[]", getTableCaptionByPath: () => '{"paragraphs":null}',
      getCursorModel: () => JSON.stringify({ lists: [{ listId: 2, isCell: true, hostListId: 0, sectionIndex: 0, hostPara: 0, controlIndex: 0, cellIndex: 0 }] }),
    } as unknown as RhwpDocument;
    const grid = { rows: 1, cols: 1, cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1 }] };
    expect(planTableOp(doc, { section: 0, paragraph: 0, control: 0 }, grid, 0, "insertRowBelow")).toBe("limit");
  });

  it("rectangles reject partial merged spans and accept whole spans", () => {
    const grid = { rows: 2, cols: 3, cells: [
      { row: 0, col: 0, rowSpan: 1, colSpan: 2 }, { row: 0, col: 2, rowSpan: 1, colSpan: 1 },
      { row: 1, col: 0, rowSpan: 1, colSpan: 1 }, { row: 1, col: 1, rowSpan: 1, colSpan: 1 }, { row: 1, col: 2, rowSpan: 1, colSpan: 1 },
    ] };
    expect(rectangularRange(grid, 1, 3)).toBeNull();
    expect(rectangularRange(grid, 0, 4)).toEqual({ startRow: 0, startCol: 0, endRow: 1, endCol: 2 });
  });
});

/** Every cell of a table in engine order: [row, col, rowSpan, colSpan, paragraph texts joined by "|"]. */
function gridOf(d: Doc, paragraph: number, control: number, path?: string): [number, number, number, number, string][] {
  const dims = JSON.parse(path ? d.getTableDimensionsByPath!(0, paragraph, path) : d.getTableDimensions(0, paragraph, control));
  const out: [number, number, number, number, string][] = [];
  for (let cell = 0; cell < dims.cellCount; cell++) {
    const cellPath = path ? JSON.stringify((JSON.parse(path) as { controlIndex: number; cellIndex: number; cellParaIndex: number }[])
      .map((l, i, a) => i === a.length - 1 ? { ...l, cellIndex: cell, cellParaIndex: 0 } : l)) : null;
    const info = JSON.parse(cellPath ? d.getCellInfoByPath!(0, paragraph, cellPath) : d.getCellInfo!(0, paragraph, control, cell));
    const count = cellPath ? d.getCellParagraphCountByPath!(0, paragraph, cellPath) : d.getCellParagraphCount(0, paragraph, control, cell);
    const texts: string[] = [];
    for (let p = 0; p < count; p++) {
      if (cellPath) {
        const pp = JSON.stringify((JSON.parse(cellPath) as { cellParaIndex: number }[]).map((l, i, a) => i === a.length - 1 ? { ...l, cellParaIndex: p } : l));
        texts.push(d.getTextInCellByPath!(0, paragraph, pp, 0, d.getCellParagraphLengthByPath!(0, paragraph, pp)));
      } else texts.push(d.getTextInCell(0, paragraph, control, cell, p, 0, d.getCellParagraphLength(0, paragraph, control, cell, p)));
    }
    out.push([info.row, info.col, info.rowSpan, info.colSpan, texts.join("|")]);
  }
  return out;
}

describe("Stage 2 Phase 2: ordinary cell split", () => {
  it.each(["hwp", "hwpx"] as const)("%s: 1x2, 2x1 and 2x2 product splits keep geometry, Undo/Redo, T009 save and reopen", async format => {
    const { editor, doc, at, place, run, save, settle } = await open(format);
    try {
      const para = at.paragraph, control = at.cell!.control, grid = () => gridOf(doc, para, control);
      const original = grid();
      expect(original).toEqual([[0, 0, 1, 1, "outer0"], [0, 1, 1, 1, "outer1"], [1, 0, 1, 1, "outer2"], [1, 1, 1, 1, "outer3"]]);
      place(at);
      const context = editor.snapshot().parameters?.["table.splitCell"]?.tableSplit;
      expect(context, "ordinary cell offers the dimension dialog").toBeDefined();
      expect(context!.maxRows).toBeGreaterThanOrEqual(2); expect(context!.maxColumns).toBeGreaterThanOrEqual(2);
      expect(context!.maxCells).toBe(4096 - 4 + 1);
      // An ordinary cell is never split without explicit dimensions.
      expect(editor.execute("table.splitCell").accepted).toBe(false);
      expect(grid()).toEqual(original);
      await run("table.splitCell", { command: "table.splitCell", rows: 1, columns: 2 });
      const horizontal = [[0, 0, 1, 1, "outer0"], [0, 1, 1, 1, ""], [0, 2, 1, 1, "outer1"], [1, 0, 1, 2, "outer2"], [1, 2, 1, 1, "outer3"]];
      expect(grid()).toEqual(horizontal);
      expect(JSON.parse(doc.getTableDimensions(0, para, control))).toMatchObject({ rowCount: 2, colCount: 3, cellCount: 5 });
      expect(editor.caret.cell!.cell).toBe(0);
      const widths = [0, 1].map(i => JSON.parse(doc.getCellProperties!(0, para, control, i)).width as number);
      expect(Math.abs(widths[0]! - widths[1]!)).toBeLessThanOrEqual(1);
      await run("edit.undo"); expect(grid()).toEqual(original);
      await run("edit.redo"); expect(grid()).toEqual(horizontal);
      // Vertical split of outer3, then a rectangular 2x2 split of outer1.
      place(withCell(at, 4)); await run("table.splitCell", { command: "table.splitCell", rows: 2, columns: 1 });
      expect(grid()).toEqual([[0, 0, 1, 1, "outer0"], [0, 1, 1, 1, ""], [0, 2, 1, 1, "outer1"], [1, 0, 2, 2, "outer2"], [1, 2, 1, 1, "outer3"], [2, 2, 1, 1, ""]]);
      place(withCell(at, 2)); await run("table.splitCell", { command: "table.splitCell", rows: 2, columns: 2 });
      const rectangular = [[0, 0, 2, 1, "outer0"], [0, 1, 2, 1, ""], [0, 2, 1, 1, "outer1"], [0, 3, 1, 1, ""], [1, 2, 1, 1, ""], [1, 3, 1, 1, ""],
        [2, 0, 2, 2, "outer2"], [2, 2, 1, 2, "outer3"], [3, 2, 1, 2, ""]];
      expect(grid()).toEqual(rectangular);
      expect(editor.caret.cell!.cell).toBe(2);
      // Typing lands in a new sub-cell.
      place(withCell(at, 5)); expect(editor.typeText("새칸")).toBe(true); await settle();
      const saved = await save(true);
      expect(Object.values(saved.reopen).every(Boolean), JSON.stringify(saved.reopen)).toBe(true);
      expect(saved.raw.findings.every(f => f.code === "previewStale"), JSON.stringify(saved.raw)).toBe(true);
      expect(saved.publishable).toBe(true);
      writeFileSync(join(out, `split-product.${format}`), saved.output);
      const reopened = new engine.HwpDocument(new Uint8Array(readFileSync(join(out, `split-product.${format}`)))) as Doc;
      try {
        expect(gridOf(reopened, para, control)).toEqual(rectangular.map((c, i) => i === 5 ? [...c.slice(0, 4), "새칸"] : c));
        expect(reopened.getTextFileText()).toBe(doc.getTextFileText());
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  }, 120_000);

  it.each(["hwp", "hwpx"] as const)("%s: multi-paragraph formatted cell beside a merged cell; merged restore regression; invalid and stale requests", async format => {
    const { editor, doc, at, place, run, settle, save } = await open(format);
    try {
      const para = at.paragraph, control = at.cell!.control, grid = () => gridOf(doc, para, control);
      place({ ...at, offset: 6 }); expect(editor.enter()).toBe(true); await settle();
      expect(editor.typeText("둘째 줄")).toBe(true); await settle();
      place({ ...at, offset: 0 }); editor.caret = { ...at, offset: 3 }; await run("format.bold");
      place(withCell(at, 2)); await run("table.mergeRight");
      expect(grid()).toEqual([[0, 0, 1, 1, "outer0|둘째 줄"], [0, 1, 1, 1, "outer1"], [1, 0, 1, 2, "outer2|outer3"]]);
      // Merged cell: restore action only (no dimension dialog); dimensions are refused.
      expect(editor.snapshot().parameters?.["table.splitCell"]).toBeUndefined();
      expect(documentCommandState("table.splitCell", editor.snapshot()).available).toBe(true);
      const mergedBefore = grid();
      expect(editor.execute("table.splitCell", { command: "table.splitCell", rows: 1, columns: 2 }).accepted).toBe(false);
      expect(grid()).toEqual(mergedBefore);
      place(at);
      const max = editor.snapshot().parameters!["table.splitCell"]!.tableSplit!;
      for (const args of [{ rows: 0, columns: 2 }, { rows: 1, columns: 1 }, { rows: 1, columns: max.maxColumns + 1 }, { rows: max.maxRows + 1, columns: 1 }, { rows: 1.5, columns: 2 }]) {
        expect(editor.execute("table.splitCell", { command: "table.splitCell", ...args }).accepted, JSON.stringify(args)).toBe(false);
      }
      expect(editor.execute("table.splitCell", { command: "table.splitCell", rows: 1, columns: 2, extra: 1 } as unknown as DocumentCommandArgs).accepted).toBe(false);
      expect(grid()).toEqual(mergedBefore);
      await run("table.splitCell", { command: "table.splitCell", rows: 1, columns: 3 });
      expect(grid()).toEqual([[0, 0, 1, 1, "outer0|둘째 줄"], [0, 1, 1, 1, ""], [0, 2, 1, 1, ""], [0, 3, 1, 1, "outer1"], [1, 0, 1, 4, "outer2|outer3"]]);
      for (let i = 0; i < 6; i++) expect(JSON.parse(doc.getCellCharPropertiesAt!(0, para, control, 0, 0, i)).bold, `bold ${i}`).toBe(i < 3);
      // The widened merged cell still restores into constituent cells.
      place(withCell(at, 4)); await run("table.splitCell");
      const restored = [[0, 0, 1, 1, "outer0|둘째 줄"], [0, 1, 1, 1, ""], [0, 2, 1, 1, ""], [0, 3, 1, 1, "outer1"],
        [1, 0, 1, 1, "outer2|outer3"], [1, 1, 1, 1, ""], [1, 2, 1, 1, ""], [1, 3, 1, 1, ""]];
      expect(grid()).toEqual(restored);
      const saved = await save(true);
      expect(Object.values(saved.reopen).every(Boolean), JSON.stringify(saved.reopen)).toBe(true);
      expect(saved.raw.findings.every(f => f.code === "previewStale"), JSON.stringify(saved.raw)).toBe(true);
      expect(saved.publishable).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        expect(gridOf(reopened, para, control)).toEqual(restored);
        for (let i = 0; i < 6; i++) expect(JSON.parse(reopened.getCellCharPropertiesAt!(0, para, control, 0, 0, i)).bold).toBe(i < 3);
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  }, 120_000);

  it.each(["hwp", "hwpx"] as const)("%s: nested table cell split keeps the parent table and nested ownership; save and reopen", async format => {
    const { editor, doc, at, place, run, save } = await open(format, false, true);
    try {
      const para = at.paragraph, control = at.cell!.control;
      const child = { ...at, cell: { ...at.cell!, nested: [{ control: 0, cell: 0, cellParagraph: 0 }] } };
      const childPath = pathJson(child.cell!);
      const parentBefore = gridOf(doc, para, control);
      expect(gridOf(doc, para, control, childPath)).toEqual([[0, 0, 1, 1, "guard"], [0, 1, 1, 1, ""], [1, 0, 1, 1, ""], [1, 1, 1, 1, ""]]);
      place(child);
      expect(editor.snapshot().parameters?.["table.splitCell"]?.tableSplit).toBeDefined();
      await run("table.splitCell", { command: "table.splitCell", rows: 2, columns: 2 });
      const nested = [[0, 0, 1, 1, "guard"], [0, 1, 1, 1, ""], [0, 2, 2, 1, ""], [1, 0, 1, 1, ""], [1, 1, 1, 1, ""], [2, 0, 1, 2, ""], [2, 2, 1, 1, ""]];
      expect(gridOf(doc, para, control, childPath)).toEqual(nested);
      expect(gridOf(doc, para, control)).toEqual(parentBefore);
      expect(new RhwpText(doc).ownsNestedCell(editor.caret)).toBe(true);
      await run("edit.undo"); expect(gridOf(doc, para, control, childPath)).toHaveLength(4);
      await run("edit.redo"); expect(gridOf(doc, para, control, childPath)).toEqual(nested);
      const saved = await save(true);
      expect(Object.values(saved.reopen).every(Boolean), JSON.stringify(saved.reopen)).toBe(true);
      expect(saved.raw.findings.every(f => f.code === "previewStale"), JSON.stringify(saved.raw)).toBe(true);
      expect(saved.publishable).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        expect(gridOf(reopened, para, control, childPath)).toEqual(nested);
        expect(gridOf(reopened, para, control)).toEqual(parentBefore);
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  }, 120_000);

  it("HWP field-rich captioned table: splitting cells keeps formula/ClickHere identity, caption and references; T009 save and reopen", async () => {
    const { editor, doc, at, place, run, save } = await open("hwp", false, false, true);
    try {
      const para = at.paragraph, control = at.cell!.control;
      const fields = () => (JSON.parse(doc.getFieldList!()) as { fieldId: number; fieldType: string; command: string; name: string }[])
        .map(f => [f.fieldId, f.fieldType, f.command, f.name]).sort();
      const caption = () => doc.getTableCaptionByPath!(0, para, JSON.stringify([{ controlIndex: control, cellIndex: 0, cellParaIndex: 0 }]));
      const fieldsBefore = fields(), captionBefore = caption();
      expect(fieldsBefore.some(f => f[1] === "formula") && fieldsBefore.some(f => f[1] === "clickhere")).toBe(true);
      // Split A1 (an operand of B3 = SUM(A1:A2)) horizontally: the formula moves B3 → C3 with an unchanged expression.
      place(at); await run("table.splitCell", { command: "table.splitCell", rows: 1, columns: 2 });
      expect(fields()).toEqual(fieldsBefore);
      // The ClickHere cell itself splits horizontally; its field keeps id, command, name and paragraph ownership.
      place(withCell(at, 2)); await run("table.splitCell", { command: "table.splitCell", rows: 1, columns: 2 });
      expect(fields()).toEqual(fieldsBefore);
      expect(caption()).toBe(captionBefore);
      expect(gridOf(doc, para, control).map(c => c.slice(0, 4))).toEqual([[0, 0, 1, 1], [0, 1, 1, 1], [0, 2, 1, 1], [0, 3, 1, 1],
        [1, 0, 1, 2], [1, 2, 1, 2], [2, 0, 1, 2], [2, 2, 1, 2]]);
      const fieldCell = (type: string) => {
        const f = (JSON.parse(doc.getFieldList!()) as { fieldType: string; location: { path: { cellIndex: number }[] } }[]).find(x => x.fieldType === type)!;
        const info = JSON.parse(doc.getCellInfo!(0, para, control, f.location.path[0]!.cellIndex));
        return [info.row, info.col];
      };
      expect(fieldCell("formula")).toEqual([2, 2]);
      expect(fieldCell("clickhere")).toEqual([0, 2]);
      const saved = await save(true);
      expect(Object.values(saved.reopen).every(Boolean), JSON.stringify(saved.reopen)).toBe(true);
      expect(saved.raw.findings.every(f => f.code === "previewStale"), JSON.stringify(saved.raw)).toBe(true);
      expect(saved.publishable).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        expect(gridOf(reopened, para, control)).toEqual(gridOf(doc, para, control));
        expect((JSON.parse(reopened.getFieldList!()) as { fieldId: number; fieldType: string; command: string; name: string }[])
          .map(f => [f.fieldId, f.fieldType, f.command, f.name]).sort()).toEqual(fieldsBefore);
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  }, 120_000);

  it("T009 HWP: fields leave only with the cells a proven column deletion removes", async () => {
    // Positive (product): deleting column B removes the ClickHere (B1) and formula (B3) fields with their cells.
    const { editor, doc, at, place, run, save } = await open("hwp", false, false, true);
    try {
      const para = at.paragraph, control = at.cell!.control;
      place(withCell(at, 3)); await run("table.deleteColumn");
      expect(gridOf(doc, para, control)).toEqual([[0, 0, 1, 1, "1"], [1, 0, 1, 1, "2"], [2, 0, 1, 1, ""]]);
      expect(JSON.parse(doc.getFieldList!())).toEqual([]);
      const saved = await save(true);
      expect(saved.raw.findings.every(f => f.code === "previewStale"), JSON.stringify(saved.raw)).toBe(true);
      expect(saved.publishable).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        expect(gridOf(reopened, para, control)).toEqual(gridOf(doc, para, control));
        expect(JSON.parse(reopened.getFieldList!())).toEqual([]);
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
    // Negative (engine-level corruption): row 3 is deleted, which legitimately removes the formula field (B3) with
    // its cell, but the ClickHere field of surviving B1 disappears too. Only the deleted cell's child may leave.
    const original = fixture("hwp", false, false, true);
    const d = new engine.HwpDocument(original) as Doc;
    try {
      const t = JSON.parse(d.getControls!()).find((c: { ctrlId: string; list: number }) => c.ctrlId === "tbl" && c.list === 0);
      d.deleteTableRow!(0, t.para, t.controlIndex, 2);
      expect((JSON.parse(d.getFieldList!()) as { fieldType: string }[]).map(f => f.fieldType)).toEqual(["clickhere"]);
      // Control: the row deletion alone is a provable save.
      const clean = exported(d, "hwp");
      const accepted = check("hwp", "saved", original, clean.bytes, clean.loss, true);
      expect(accepted.findings.every(f => f.code === "previewStale"), JSON.stringify(accepted)).toBe(true);
      (d as unknown as Record<string, (...a: unknown[]) => string>).removeFieldAtInCell!(0, t.para, t.controlIndex, 1, 0, 0, false);
      expect(JSON.parse(d.getFieldList!())).toEqual([]);
      const e = exported(d, "hwp");
      const result = check("hwp", "saved", original, e.bytes, e.loss, true);
      expect(result.outcome, JSON.stringify(result)).toBe("unsafe");
      expect(result.findings.some(f => f.code !== "previewStale")).toBe(true);
    } finally { d.free(); }
  }, 120_000);

  it("HWP field-rich table: a split whose formula range would read through a widened merge is refused before mutation", async () => {
    const { editor, doc, at, place, run } = await open("hwp", false, false, true);
    try {
      const para = at.paragraph, control = at.cell!.control;
      place(at); await run("table.splitCell", { command: "table.splitCell", rows: 1, columns: 2 });
      // A vertical split of the ClickHere cell (C1) shifts A2 below the widened A1 region, so the rewritten range
      // A1:A3 would read a covered cell. The plan applies the engine's anchor rule and refuses before any engine
      // call: no history step, no mutation, editing continues.
      const before = [doc.getTextFileText(), doc.getFieldList!(), JSON.stringify(gridOf(doc, para, control))];
      place(withCell(at, 2));
      expect(documentCommandState("table.splitCell", editor.snapshot()).available).toBe(true);
      const editTable = doc.editTableByPath!.bind(doc);
      let engineCalls = 0;
      doc.editTableByPath = (...args) => { engineCalls++; return editTable(...args); };
      expect(editor.execute("table.splitCell", { command: "table.splitCell", rows: 2, columns: 1 }).accepted).toBe(false);
      expect(engineCalls).toBe(0);
      expect([doc.getTextFileText(), doc.getFieldList!(), JSON.stringify(gridOf(doc, para, control))]).toEqual(before);
      expect(editor.snapshot().editable).toBe(true);
      // The same field table still accepts a valid split afterwards.
      await run("table.splitCell", { command: "table.splitCell", rows: 1, columns: 2 });
      expect(engineCalls).toBe(1);
    } finally { editor.dispose(); }
  }, 120_000);

  it("limits: bounds from table size, cell budget and width; engine refuses out-of-contract requests without mutation", () => {
    const one = (rows: number, cols: number, cells = rows * cols) => ({ rows, cols, cells: Array.from({ length: cells }, (_, i) =>
      ({ row: Math.floor(i / cols), col: i % cols, rowSpan: 1, colSpan: 1 })) });
    expect(ordinarySplitLimits(one(1, 1), 0, 30000)).toEqual({ maxRows: 99, maxColumns: 50, maxCells: 4096 });
    expect(ordinarySplitLimits(one(1, 64), 0, 30000)).toMatchObject({ maxColumns: 1, maxRows: 99 });
    expect(ordinarySplitLimits(one(512, 1), 0, 30000)).toMatchObject({ maxRows: 1, maxColumns: 50 });
    expect(ordinarySplitLimits(one(512, 64, 4096), 0, 30000)).toBeNull();
    expect(ordinarySplitLimits(one(1, 1), 0, 1199)).toMatchObject({ maxColumns: 1 });
    expect(ordinarySplitLimits({ rows: 1, cols: 2, cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }] }, 0, 30000)).toBeNull();
    const limits = { maxRows: 10, maxColumns: 10, maxCells: 20 };
    expect(ordinarySplitValid({ rows: 4, columns: 5 }, limits)).toBe(true);
    expect(ordinarySplitValid({ rows: 5, columns: 5 }, limits)).toBe(false);
    expect(ordinarySplitValid({ rows: 1, columns: 1 }, limits)).toBe(false);
    const d = new engine.HwpDocument(fixture("hwpx")) as Doc;
    try {
      const t = JSON.parse(d.getControls!()).find((c: { ctrlId: string; list: number }) => c.ctrlId === "tbl" && c.list === 0);
      const path = JSON.stringify([{ controlIndex: t.controlIndex, cellIndex: 0, cellParaIndex: 0 }]);
      const before = gridOf(d, t.para, t.controlIndex);
      for (const args of [[0, 0, 1, 1], [0, 0, 0, 2], [0, 0, 1, 64], [0, 0, 513, 1], [0, 0, 1, 40], [9, 9, 1, 2], [0, 0, 2]]) {
        expect(() => d.editTableByPath!(0, t.para, path, "splitCellInto", JSON.stringify(args)), JSON.stringify(args)).toThrow();
        expect(gridOf(d, t.para, t.controlIndex)).toEqual(before);
      }
      expect(JSON.parse(d.editTableByPath!(0, t.para, path, "mergeRight", "[0,0,0,1]")).ok).toBe(true);
      const merged = gridOf(d, t.para, t.controlIndex);
      expect(() => d.editTableByPath!(0, t.para, path, "splitCellInto", "[0,0,1,2]")).toThrow();
      expect(gridOf(d, t.para, t.controlIndex)).toEqual(merged);
    } finally { d.free(); }
  });
});

/**
 * Stage 2 Phase 2 audit matrix: every table structure command (and Enter/typing) on tables whose cells hold a
 * cell-inline picture, a nested table, partial character formatting, formula + ClickHere fields with a caption
 * (HWP; HWPX: floating picture + caption) or a prior structure change — each in a fresh product session, saved
 * through the real T009 checker and reopened. Results are written to `probe-<format>.tsv`.
 */
describe("Stage 2 Phase 2: complex content matrix", () => {
  const OPS = ["insertRowAbove", "insertRowBelow", "insertColumnLeft", "insertColumnRight", "deleteRow", "deleteColumn",
    "mergeRight", "mergeBelow", "mergeCells", "splitCell", "splitMerged", "typeOnly", "mergeTypeOnly", "enterOnly"] as const;
  const KINDS = ["picture", "nested", "bold", "fields", "twice"] as const;
  // Refused before any engine call (editing continues): each would delete or absorb A2, an operand of B3 = SUM(A1:A2).
  const REFUSED = new Set(["hwp/fields/deleteRow", "hwp/fields/mergeBelow", "hwp/fields/mergeCells"]);
  it.each(["hwp", "hwpx"] as const)("%s matrix", async format => {
    const rows: string[] = [];
    for (const kind of KINDS) for (const op of OPS) {
      const c = await open(format, false, kind === "nested", kind === "fields");
      const { editor, doc, at, place, run, settle } = c;
      let result = "";
      try {
        if (kind === "picture") {
          place({ ...at, offset: 3 });
          if (await editor.executeImage(() => true, async () => importedCellImage(format === "hwp" ? CELL_JPEG : CELL_PNG)) !== "inserted") { result = "setup-failed"; continue; }
          await settle();
        } else if (kind === "bold" || kind === "twice") {
          place({ ...at, offset: 0 }); editor.caret = { ...at, offset: 3 }; await run("format.bold");
        }
        if (kind === "twice") { place(withCell(at, 1)); await run("table.insertRowBelow"); }
        const deleteTarget = op === "deleteRow" || op === "deleteColumn" ? withCell(at, 3) : at;
        place(deleteTarget);
        let command = `table.${op}` as DocumentCommandId, args: DocumentCommandArgs | undefined;
        if (op === "mergeCells") editor.caret = withCell(at, 3);
        if (op === "splitCell") args = { command: "table.splitCell", rows: 2, columns: 2 };
        if (op === "splitMerged") { await run("table.mergeRight"); place(at); command = "table.splitCell"; }
        if (op === "enterOnly") {
          place({ ...withCell(at, 3), offset: 0 }); expect(editor.typeText("Y")).toBe(true); await settle();
          expect(editor.enter()).toBe(true); await settle();
          const saved = await c.save(true);
          result = `enter save=${saved.publishable ? "PUBLISH" : "REFUSED"} findings=${saved.raw.findings.filter(f => f.code !== "previewStale").map(f => f.code).join("+") || "-"}`;
          continue;
        }
        if (op === "typeOnly" || op === "mergeTypeOnly") {
          if (op === "mergeTypeOnly") { await run("table.mergeRight"); }
          place({ ...withCell(at, op === "mergeTypeOnly" ? 2 : 3), offset: 0 }); expect(editor.typeText("Z")).toBe(true); await settle();
          const saved = await c.save(true);
          result = `typed save=${saved.publishable ? "PUBLISH" : "REFUSED"} findings=${saved.raw.findings.filter(f => f.code !== "previewStale").map(f => f.code).join("+") || "-"}`;
          continue;
        }
        const state = documentCommandState(command, editor.snapshot());
        if (!state.available) { result = `unavailable:${(state as { reason: string }).reason}`; continue; }
        const accepted = editor.execute(command, args).accepted; await settle();
        if (!accepted) { result = `refused editable=${editor.snapshot().editable}`; continue; }
        const saved = await c.save(true);
        const findings = saved.raw.findings.filter(f => f.code !== "previewStale").map(f => f.code).join("+");
        let reopenText = "n/a";
        if (saved.publishable) { const r = new engine.HwpDocument(saved.output) as Doc; try { reopenText = String(r.getTextFileText() === doc.getTextFileText()); } finally { r.free(); } }
        result = `ok save=${saved.publishable ? "PUBLISH" : "REFUSED"} reopenEq=${Object.values(saved.reopen).every(Boolean)} findings=${findings || "-"} reopenText=${reopenText}`;
      } catch (error) { result = `error:${String(error).slice(0, 120)}`; }
      finally { rows.push(`${format}\t${kind}\t${op}\t${result}`); editor.dispose(); }
    }
    writeFileSync(join(out, `probe-${format}.tsv`), rows.join("\n") + "\n");
    const unexpected = rows.filter(row => {
      const [, kind, op, result] = row.split("\t");
      if (REFUSED.has(`${format}/${kind}/${op}`)) return result !== "refused editable=true";
      return !/^(ok save=PUBLISH reopenEq=true findings=- reopenText=true|typed save=PUBLISH findings=-|enter save=PUBLISH findings=-)$/.test(result!);
    });
    expect(unexpected).toEqual([]);
    expect(rows).toHaveLength(KINDS.length * OPS.length);
  }, 900_000);

  it.each(["hwp", "hwpx"] as const)("%s P3-1: cell shading, borders (rect/merged/nested), Undo/Redo, negatives, T009 save & reopen", async format => {
    const { editor, doc, at, place, run, save, original } = await open(format, false, true, false);
    try {
      const bfBaseline = doc.borderFillCount!();
      expect(bfBaseline).toBeGreaterThan(0);

      // Single cell (0,0): notInTable / inside border rejected before mutation.
      place(at);
      expect(documentCommandState("table.shading", editor.snapshot())).toEqual({ available: true });
      expect(documentCommandState("table.borders", editor.snapshot())).toEqual({ available: true });
      expect(editor.snapshot().parameters?.["table.borders"]?.tableBorders?.hasInsideBorders).toBe(false);
      expect(editor.execute("table.borders", {
        command: "table.borders", kind: "inside", style: "single", width: 0.12, color: "#000000",
      }).accepted).toBe(false);
      expect(editor.execute("table.borders", {
        command: "table.borders", kind: "all", style: "thick", width: 0.12, color: "#000000",
      }).accepted).toBe(false);
      expect(editor.execute("table.shading", { command: "table.shading", color: "invalid" }).accepted).toBe(false);

      // Cell shading set + Undo + Redo + Clear.
      await run("table.shading", { command: "table.shading", color: "#FEF08A" });
      expect(editor.snapshot().parameters?.["table.shading"]?.tableShading?.color).toBe("#FEF08A");
      const midBf = doc.borderFillCount!();
      await run("edit.undo");
      expect(doc.borderFillCount!()).toBe(bfBaseline);
      expect(editor.snapshot().parameters?.["table.shading"]?.tableShading?.color).toBeNull();
      await run("edit.redo");
      expect(doc.borderFillCount!()).toBe(midBf);
      expect(editor.snapshot().parameters?.["table.shading"]?.tableShading?.color).toBe("#FEF08A");
      await run("table.shading", { command: "table.shading", color: null });
      expect(editor.snapshot().parameters?.["table.shading"]?.tableShading?.color).toBeNull();
      // Compaction returns unused appended borderFills back to baseline!
      expect(doc.borderFillCount!()).toBe(bfBaseline);

      // Rectangular multi-cell selection (0..1, 0..1) on 2x2 table -> shading + outside + inside borders.
      place(at);
      editor.caret = withCell(at, 3);
      expect(editor.snapshot().parameters?.["table.borders"]?.tableBorders?.hasInsideBorders).toBe(true);
      await run("table.shading", { command: "table.shading", color: "#DBEAFE" });
      await run("table.borders", {
        command: "table.borders", kind: "outside", style: "double", width: 0.5, color: "#DC2626",
      });
      await run("table.borders", {
        command: "table.borders", kind: "inside", style: "dashed", width: 0.4, color: "#1E40AF",
      });

      // Individual edge (`bottom`) + `none` on cell (0,1).
      place(withCell(at, 1));
      await run("table.borders", {
        command: "table.borders", kind: "bottom", style: "dotted", width: 0.7, color: "#15803D",
      });

      // Nested child table formatting inside cell 0 (nested fixture created 1 child table in cell 0).
      const nested = { ...at, cell: { ...at.cell!, nested: [{ control: 0, cell: 0, cellParagraph: 0 }] } };
      place(nested);
      expect(documentCommandState("table.shading", editor.snapshot())).toEqual({ available: true });
      await run("table.shading", { command: "table.shading", color: "#DCFCE7" });

      // T009 save + independent reopen verification!
      const saved = await save();
      expect(saved.publishable, JSON.stringify(saved.raw)).toBe(true);
      expect(saved.raw.findings.every(f => f.code === "previewStale"), JSON.stringify(saved.raw)).toBe(true);
      expect(Object.values(saved.reopen).every(Boolean), JSON.stringify(saved.reopen)).toBe(true);

      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        expect(reopened.getTextFileText()).toBe(doc.getTextFileText());
        const fmt00 = JSON.parse(reopened.getTableCellFormattingByPath!(
          0, at.paragraph, JSON.stringify([{ controlIndex: at.cell!.control, cellIndex: 0, cellParaIndex: 0 }]),
          0, 0, 0, 0,
        ));
        expect(fmt00.shading).toEqual({ uniform: true, color: "DBEAFE" });
        const fmtNested = JSON.parse(reopened.getTableCellFormattingByPath!(
          0, at.paragraph, JSON.stringify([
            { controlIndex: at.cell!.control, cellIndex: 0, cellParaIndex: 0 },
            { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 },
          ]),
          0, 0, 0, 0,
        ));
        expect(fmtNested.shading).toEqual({ uniform: true, color: "DCFCE7" });
      } finally { reopened.free(); }
      void original;
    } finally { editor.dispose(); }
  });

  it.each(["hwp", "hwpx"] as const)("%s P3-1 rich table: caption, formulas & ClickHere stay intact after cell shading & borders", async format => {
    const { editor, doc, at, place, run, save } = await open(format, false, false, true);
    try {
      const fieldsBefore = doc.getFieldList!();
      place(withCell(at, 0));
      await run("table.shading", { command: "table.shading", color: "#FEE2E2" });
      await run("table.borders", {
        command: "table.borders", kind: "outside", style: "double", width: 0.5, color: "#1E40AF",
      });
      expect(doc.getFieldList!()).toBe(fieldsBefore);
      const saved = await save();
      expect(saved.publishable, JSON.stringify(saved.raw)).toBe(true);
      expect(saved.raw.findings.every(f => f.code === "previewStale"), JSON.stringify(saved.raw)).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        expect(reopened.getFieldList!()).toBe(fieldsBefore);
        const fmt = JSON.parse(reopened.getTableCellFormattingByPath!(
          0, at.paragraph, JSON.stringify([{ controlIndex: at.cell!.control, cellIndex: 0, cellParaIndex: 0 }]),
          0, 0, 0, 0,
        ));
        expect(fmt.shading).toEqual({ uniform: true, color: "FEE2E2" });
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  it.each(["hwp", "hwpx"] as const)("%s P3-2 cell alignment: single/rect/nested/merged, mixed state, Undo/Redo, T009 save & reopen", async format => {
    const { editor, doc, at, place, run, save } = await open(format, false, true, false);
    try {
      // Negative: invalid alignment parameters or empty payload reject cleanly.
      place(withCell(at, 0));
      expect(documentCommandState("table.alignment", editor.snapshot())).toEqual({ available: true });
      expect(editor.execute("table.alignment", { command: "table.alignment" }).accepted).toBe(false);

      // Single cell (0,0): horizontal center -> Undo -> Redo -> vertical bottom.
      const beforeH = editor.snapshot().parameters?.["table.alignment"]?.tableAlignment?.horizontal;
      await run("table.alignment", { command: "table.alignment", horizontal: "center" });
      expect(editor.snapshot().parameters?.["table.alignment"]?.tableAlignment?.horizontal).toBe("center");
      await run("edit.undo");
      expect(editor.snapshot().parameters?.["table.alignment"]?.tableAlignment?.horizontal).toBe(beforeH);
      await run("edit.redo");
      expect(editor.snapshot().parameters?.["table.alignment"]?.tableAlignment?.horizontal).toBe("center");

      await run("table.alignment", { command: "table.alignment", vertical: "bottom" });
      expect(editor.snapshot().parameters?.["table.alignment"]?.tableAlignment?.horizontal).toBe("center");
      expect(editor.snapshot().parameters?.["table.alignment"]?.tableAlignment?.vertical).toBe("bottom");

      // Multi-cell mixed reporting: cell 0 is center+bottom while cell 1 has default alignment.
      place(at);
      editor.caret = withCell(at, 1);
      const mixed = editor.snapshot().parameters?.["table.alignment"]?.tableAlignment;
      expect(mixed?.horizontalMixed).toBe(true);
      expect(mixed?.verticalMixed).toBe(true);
      // Applying only horizontal=justify unifies horizontal while preserving bottom/default vertical or setting rect.
      await run("table.alignment", { command: "table.alignment", horizontal: "justify" });
      expect(editor.snapshot().parameters?.["table.alignment"]?.tableAlignment?.horizontal).toBe("justify");

      // Nested table cell formatting inside cell 0.
      const nested = { ...at, cell: { ...at.cell!, nested: [{ control: 0, cell: 0, cellParagraph: 0 }] } };
      place(nested);
      await run("table.alignment", { command: "table.alignment", horizontal: "right", vertical: "middle" });

      // Rich/merged table check + T009 save & independent reopen.
      const saved = await save();
      expect(saved.publishable, JSON.stringify(saved.raw)).toBe(true);
      expect(saved.raw.findings.every(f => f.code === "previewStale"), JSON.stringify(saved.raw)).toBe(true);
      expect(Object.values(saved.reopen).every(Boolean), JSON.stringify(saved.reopen)).toBe(true);

      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        expect(reopened.getTextFileText()).toBe(doc.getTextFileText());
        const fmt00 = JSON.parse(reopened.getTableCellFormattingByPath!(
          0, at.paragraph, JSON.stringify([{ controlIndex: at.cell!.control, cellIndex: 0, cellParaIndex: 0 }]),
          0, 0, 0, 0,
        ));
        expect(fmt00.alignment).toEqual({
          horizontal: "justify",
          horizontalMixed: false,
          vertical: "bottom",
          verticalMixed: false,
        });
        const fmt01 = JSON.parse(reopened.getTableCellFormattingByPath!(
          0, at.paragraph, JSON.stringify([{ controlIndex: at.cell!.control, cellIndex: 0, cellParaIndex: 0 }]),
          0, 1, 0, 1,
        ));
        expect(fmt01.alignment.horizontal).toBe("justify");
        const fmtNested = JSON.parse(reopened.getTableCellFormattingByPath!(
          0, at.paragraph, JSON.stringify([
            { controlIndex: at.cell!.control, cellIndex: 0, cellParaIndex: 0 },
            { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 },
          ]),
          0, 0, 0, 0,
        ));
        expect(fmtNested.alignment).toEqual({
          horizontal: "right",
          horizontalMixed: false,
          vertical: "middle",
          verticalMixed: false,
        });
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  it.each(["hwp", "hwpx"] as const)("%s P3-2 rich table: caption, formulas & ClickHere stay intact after cell alignment", async format => {
    const { editor, doc, at, place, run, save } = await open(format, false, false, true);
    try {
      const fieldsBefore = doc.getFieldList!();
      place(withCell(at, 0));
      await run("table.alignment", { command: "table.alignment", horizontal: "right", vertical: "bottom" });
      expect(doc.getFieldList!()).toBe(fieldsBefore);
      const saved = await save();
      expect(saved.publishable, JSON.stringify(saved.raw)).toBe(true);
      expect(saved.raw.findings.every(f => f.code === "previewStale"), JSON.stringify(saved.raw)).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        expect(reopened.getFieldList!()).toBe(fieldsBefore);
        const fmt = JSON.parse(reopened.getTableCellFormattingByPath!(
          0, at.paragraph, JSON.stringify([{ controlIndex: at.cell!.control, cellIndex: 0, cellParaIndex: 0 }]),
          0, 0, 0, 0,
        ));
        expect(fmt.alignment).toEqual({
          horizontal: "right",
          horizontalMixed: false,
          vertical: "bottom",
          verticalMixed: false,
        });
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  it.each(["hwp", "hwpx"] as const)("%s P3-3 column widths & row heights: single/rect/nested/merged, distribute, Undo/Redo, T009 save & reopen", async format => {
    const { editor, doc, at, place, run, save } = await open(format, false, true, false);
    try {
      // Invalid width/height or unsupported `exact` rule / `null` height must be refused.
      place(withCell(at, 0));
      expect(documentCommandState("table.columnWidth", editor.snapshot())).toEqual({ available: true });
      expect(documentCommandState("table.rowHeight", editor.snapshot())).toEqual({ available: true });
      expect(editor.execute("table.columnWidth", { command: "table.columnWidth", width: 2 }).accepted).toBe(false);
      expect(editor.execute("table.rowHeight", { command: "table.rowHeight", height: 30, rule: "exact" }).accepted).toBe(false);
      expect(editor.execute("table.rowHeight", { command: "table.rowHeight", height: null }).accepted).toBe(false);

      // Column 0 width 125pt -> Undo -> Redo.
      const beforeW = editor.snapshot().parameters?.["table.columnWidth"]?.tableColumnWidth?.width;
      await run("table.columnWidth", { command: "table.columnWidth", width: 125 });
      expect(editor.snapshot().parameters?.["table.columnWidth"]?.tableColumnWidth?.width).toBe(125);
      await run("edit.undo");
      expect(editor.snapshot().parameters?.["table.columnWidth"]?.tableColumnWidth?.width).toBe(beforeW);
      await run("edit.redo");
      expect(editor.snapshot().parameters?.["table.columnWidth"]?.tableColumnWidth?.width).toBe(125);

      // Row 0 height 36pt, then distribute columns & rows across whole table.
      await run("table.rowHeight", { command: "table.rowHeight", height: 36, rule: "atLeast" });
      expect(editor.snapshot().parameters?.["table.rowHeight"]?.tableRowHeight?.height).toBe(36);

      // Merged cell (0,0)-(0,1) cannot be partially selected; full merge span or whole rect succeeds.
      await run("table.columnWidth", { command: "table.columnWidth", distribute: true });
      place(at);
      editor.caret = withCell(at, 1);
      expect(editor.snapshot().parameters?.["table.columnWidth"]?.tableColumnWidth?.mixed).toBe(false);
      await run("table.rowHeight", { command: "table.rowHeight", distribute: true });

      // Nested table dimension formatting inside cell 0.
      const nested = { ...at, cell: { ...at.cell!, nested: [{ control: 0, cell: 0, cellParagraph: 0 }] } };
      place(nested);
      await run("table.columnWidth", { command: "table.columnWidth", width: 70 });
      await run("table.rowHeight", { command: "table.rowHeight", height: 28 });

      const saved = await save();
      expect(saved.publishable, JSON.stringify(saved.raw)).toBe(true);
      expect(saved.raw.findings.every(f => f.code === "previewStale"), JSON.stringify(saved.raw)).toBe(true);
      expect(Object.values(saved.reopen).every(Boolean), JSON.stringify(saved.reopen)).toBe(true);

      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        expect(reopened.getTextFileText()).toBe(doc.getTextFileText());
        const outerFmt = JSON.parse(reopened.getTableCellFormattingByPath!(
          0, at.paragraph, JSON.stringify([{ controlIndex: at.cell!.control, cellIndex: 0, cellParaIndex: 0 }]),
          0, 0, 1, 1,
        ));
        expect(outerFmt.dimensions.colWidthMixed).toBe(false);
        expect(outerFmt.dimensions.rowHeightPt).toBe(36);
        const nestedFmt = JSON.parse(reopened.getTableCellFormattingByPath!(
          0, at.paragraph, JSON.stringify([
            { controlIndex: at.cell!.control, cellIndex: 0, cellParaIndex: 0 },
            { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 },
          ]),
          0, 0, 0, 0,
        ));
        expect(nestedFmt.dimensions.colWidthPt).toBe(70);
        expect(nestedFmt.dimensions.rowHeightPt).toBe(28);
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  it.each(["hwp", "hwpx"] as const)("%s P3-3 rich table: caption, formulas & ClickHere stay intact after width/height changes", async format => {
    const { editor, doc, at, place, run, save } = await open(format, false, false, true);
    try {
      const fieldsBefore = doc.getFieldList!();
      place(withCell(at, 0));
      await run("table.columnWidth", { command: "table.columnWidth", width: 110 });
      await run("table.rowHeight", { command: "table.rowHeight", height: 34 });
      expect(doc.getFieldList!()).toBe(fieldsBefore);
      const saved = await save();
      expect(saved.publishable, JSON.stringify(saved.raw)).toBe(true);
      expect(saved.raw.findings.every(f => f.code === "previewStale"), JSON.stringify(saved.raw)).toBe(true);
      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        expect(reopened.getFieldList!()).toBe(fieldsBefore);
        const fmt = JSON.parse(reopened.getTableCellFormattingByPath!(
          0, at.paragraph, JSON.stringify([{ controlIndex: at.cell!.control, cellIndex: 0, cellParaIndex: 0 }]),
          0, 0, 0, 0,
        ));
        expect(fmt.dimensions.colWidthPt).toBe(110);
        expect(fmt.dimensions.rowHeightPt).toBe(34);
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });
});

describe("RHWP Release WASM Stage 2 P4-1 — multi-cell structural clipboard", () => {
  const makeClipboard = () => {
    let osText = "";
    const clip: PlainClipboard = {
      readText: async () => osText,
      writeText: async (t: string) => { osText = t; },
    };
    return {
      clip,
      getText: () => osText,
      setExternalText: (t: string) => { osText = t; },
    };
  };

  it.each(["hwp", "hwpx"] as const)("%s P4-1 multi-cell copy/cut/paste preserves formatting, nested tables, Undo/Redo, T009 save & reopen", async format => {
    clearStructuredClipboard();
    const { clip, getText } = makeClipboard();
    const { editor, doc, at, place, settle, run, save } = await open(format, false, true, false);
    const clipExec = async (cmd: "edit.copy" | "edit.cut" | "edit.paste", c = clip) => {
      const ok = await editor.executeClipboard(cmd, () => true, c);
      await settle();
      return ok;
    };
    try {
      // Wait for HWP structural proof or insert rows: row 0 cell 0 holds nested table, so format & copy row 1 (cells 2, 3) onto row 2 (cells 4, 5).
      place(withCell(at, 2));
      await run("table.insertRowBelow");
      // Format row 1 cells (2 and 3): shading FEF08A, center align, bold text.
      place(withCell(at, 2));
      editor.anchor = withCell(at, 2);
      editor.caret = withCell(at, 3);
      await run("table.shading", { command: "table.shading", color: "FEF08A" });
      await run("table.alignment", { command: "table.alignment", horizontal: "center", vertical: "middle" });
      place(withCell(at, 2));
      editor.anchor = withCell(at, 2);
      editor.caret = { ...withCell(at, 2), offset: 6 };
      await run("format.bold");

      // Multi-cell copy (cells 2 and 3 -> 1x2)
      editor.anchor = withCell(at, 2);
      editor.caret = withCell(at, 3);
      expect(editor.snapshot().clipboard?.selection).toBe(true);
      expect(await clipExec("edit.copy")).toBe(true);
      expect(getText()).toBe("outer2\touter3");
      // Copy never mutates source
      expect(doc.getTextInCell(0, at.paragraph, at.cell!.control, 2, 0, 0, 20)).toBe("outer2");

      // Paste onto row 2 (cell 4 = row 2 col 0)
      place(withCell(at, 4));
      expect(await clipExec("edit.paste")).toBe(true);
      expect(doc.getTextInCell(0, at.paragraph, at.cell!.control, 4, 0, 0, 20)).toBe("outer2");
      expect(doc.getTextInCell(0, at.paragraph, at.cell!.control, 5, 0, 0, 20)).toBe("outer3");
      const pastedFmt = JSON.parse(doc.getTableCellFormattingByPath!(
        0, at.paragraph, JSON.stringify([{ controlIndex: at.cell!.control, cellIndex: 0, cellParaIndex: 0 }]),
        2, 0, 2, 1,
      ));
      expect(pastedFmt.shading).toEqual({ uniform: true, color: "FEF08A" });
      expect(pastedFmt.alignment).toMatchObject({ horizontal: "center", vertical: "middle" });

      // Undo restores pre-paste state cleanly, Redo re-applies
      await run("edit.undo");
      expect(doc.getTextInCell(0, at.paragraph, at.cell!.control, 4, 0, 0, 20)).toBe("");
      await run("edit.redo");
      expect(doc.getTextInCell(0, at.paragraph, at.cell!.control, 4, 0, 0, 20)).toBe("outer2");

      // Multi-cell Cut on row 1 (cells 2 and 3 = outer2, outer3)
      editor.anchor = withCell(at, 2);
      editor.caret = withCell(at, 3);
      const deniedClip: PlainClipboard = {
        readText: async () => "",
        writeText: async () => { throw new Error("permission denied"); },
      };
      // Write failure must not mutate source
      expect(await clipExec("edit.cut", deniedClip)).toBe(false);
      expect(doc.getTextInCell(0, at.paragraph, at.cell!.control, 2, 0, 0, 20)).toBe("outer2");

      // Valid cut clears source as one undoable step
      expect(await clipExec("edit.cut")).toBe(true);
      expect(doc.getTextInCell(0, at.paragraph, at.cell!.control, 2, 0, 0, 20)).toBe("");
      expect(doc.getTextInCell(0, at.paragraph, at.cell!.control, 3, 0, 0, 20)).toBe("");
      await run("edit.undo");
      expect(doc.getTextInCell(0, at.paragraph, at.cell!.control, 2, 0, 0, 20)).toBe("outer2");

      // Copy formatted nested 1x2 and paste within nested 2x2 table inside cell 0
      const nested0 = { ...at, cell: { ...at.cell!, nested: [{ control: 0, cell: 0, cellParagraph: 0 }] } };
      const nested1 = { ...at, cell: { ...at.cell!, nested: [{ control: 0, cell: 1, cellParagraph: 0 }] } };
      const nested2 = { ...at, cell: { ...at.cell!, nested: [{ control: 0, cell: 2, cellParagraph: 0 }] } };
      place(nested0);
      await run("table.shading", { command: "table.shading", color: "DBEAFE" });
      editor.anchor = nested0;
      editor.caret = nested1;
      expect(await clipExec("edit.copy")).toBe(true);
      place(nested2);
      expect(await clipExec("edit.paste")).toBe(true);

      // Copy nested cell (contains nested table in outer cell 0) rejects complex multi-cell copy without mutating
      editor.anchor = withCell(at, 0);
      editor.caret = withCell(at, 1);
      expect(await clipExec("edit.copy")).toBe(false);

      // Paste at right edge (col 1) of a 2-col table refuses out-of-bounds 1x2 paste without mutating
      place(withCell(at, 5));
      expect(await clipExec("edit.paste")).toBe(false);

      // T009 save & independent reopen
      const saved = await save();
      expect(saved.publishable, JSON.stringify({ raw: saved.raw, reopen: saved.reopen })).toBe(true);
      expect(saved.raw.findings.every(f => f.code === "previewStale"), JSON.stringify(saved.raw)).toBe(true);
      expect(Object.values(saved.reopen).every(Boolean), JSON.stringify(saved.reopen)).toBe(true);

      const reopened = new engine.HwpDocument(saved.output) as Doc;
      try {
        expect(reopened.getTextFileText()).toBe(doc.getTextFileText());
        const reopenedFmt = JSON.parse(reopened.getTableCellFormattingByPath!(
          0, at.paragraph, JSON.stringify([{ controlIndex: at.cell!.control, cellIndex: 0, cellParaIndex: 0 }]),
          2, 0, 2, 1,
        ));
        expect(reopenedFmt.shading).toEqual({ uniform: true, color: "FEF08A" });
      } finally { reopened.free(); }
    } finally { editor.dispose(); }
  });

  it("HWPX P4-1 preserves & rewrites merged cells, HWP rejects mismatched merges, and cross-format DOCX payload pastes cleanly", async () => {
    clearStructuredClipboard();
    const { clip, setExternalText } = makeClipboard();

    // HWPX: 3x3 table, merge row 0 cols 0..1, copy row 0 (1x3), paste onto row 2 -> merges rewritten & saved
    const hwpx = await open("hwpx");
    try {
      hwpx.place(withCell(hwpx.at, 0));
      await hwpx.run("table.insertColumnRight");
      await hwpx.run("table.insertRowBelow");
      hwpx.editor.anchor = withCell(hwpx.at, 0);
      hwpx.editor.caret = withCell(hwpx.at, 1);
      await hwpx.run("table.mergeCells");
      hwpx.place(withCell(hwpx.at, 0));
      hwpx.editor.anchor = withCell(hwpx.at, 0);
      hwpx.editor.caret = withCell(hwpx.at, 1); // logical row 0 spans (0,0..1) + (0,2) -> 2 cells
      expect(hwpx.editor.snapshot().clipboard?.selection).toBe(true);
      expect(await hwpx.editor.executeClipboard("edit.copy", () => true, clip)).toBe(true);
      await hwpx.settle();

      // Paste onto row 2 (cell 5 = row 2 col 0 after row 0 merge left 2 cells and row 1 has 3 cells)
      hwpx.place(withCell(hwpx.at, 5));
      expect(await hwpx.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true);
      await hwpx.settle();
      const dims = JSON.parse(hwpx.doc.getTableDimensions(0, hwpx.at.paragraph, hwpx.at.cell!.control));
      expect(dims.cellCount).toBe(7); // row0 merged (2) + row1 (3) + row2 merged (2)

      // External OS clipboard text change invalidates stored structured payload and falls back cleanly
      setExternalText("ExternalPlain");
      hwpx.place(withCell(hwpx.at, 2));
      expect(await hwpx.editor.executeClipboard("edit.paste", () => true, clip)).toBe(true);
      await hwpx.settle();
      expect(hwpx.doc.getTextInCell(0, hwpx.at.paragraph, hwpx.at.cell!.control, 2, 0, 0, 30)).toContain("ExternalPlain");

      // Cross-format paste: simulate valid DOCX structured clipboard payload (1x2) into HWPX
      const docxPayload = {
        kind: "geul.tableCells",
        version: 1,
        sourceFormat: "docx",
        rows: 1,
        cols: 2,
        cells: [
          {
            row: 0, col: 0, rowSpan: 1, colSpan: 1,
            paragraphs: [{ align: "center", runs: [{ text: "FromDocx1", bold: true }] }],
            formatting: { shadingColor: "#DBEAFE", verticalAlign: "middle" },
          },
          {
            row: 0, col: 1, rowSpan: 1, colSpan: 1,
            paragraphs: [{ align: "right", runs: [{ text: "FromDocx2" }] }],
          },
        ],
        plainText: "FromDocx1\tFromDocx2",
      };
      const docxClip: PlainClipboard = {
        readText: async () => "FromDocx1\tFromDocx2",
        writeText: async () => {},
        readStructured: async mime => (mime === TABLE_CLIPBOARD_MIME ? JSON.stringify(docxPayload) : null),
      };
      hwpx.place(withCell(hwpx.at, 2)); // row 1 col 0
      expect(await hwpx.editor.executeClipboard("edit.paste", () => true, docxClip)).toBe(true);
      await hwpx.settle();
      expect(hwpx.doc.getTextInCell(0, hwpx.at.paragraph, hwpx.at.cell!.control, 2, 0, 0, 20)).toBe("FromDocx1");
      expect(hwpx.doc.getTextInCell(0, hwpx.at.paragraph, hwpx.at.cell!.control, 3, 0, 0, 20)).toBe("FromDocx2");

      const saved = await hwpx.save();
      expect(saved.publishable, JSON.stringify({ raw: saved.raw, reopen: saved.reopen })).toBe(true);
    } finally { hwpx.editor.dispose(); }

    // HWP: pasting a merged 1x2+1 payload onto an unmerged row is rejected without mutating
    const hwp = await open("hwp");
    try {
      const mergedFromHwpx: PlainClipboard = {
        readText: async () => "M1\tM2",
        writeText: async () => {},
        readStructured: async mime => mime === TABLE_CLIPBOARD_MIME ? JSON.stringify({
          kind: "geul.tableCells",
          version: 1,
          sourceFormat: "hwpx",
          rows: 1,
          cols: 2,
          cells: [
            { row: 0, col: 0, rowSpan: 1, colSpan: 2, paragraphs: [{ runs: [{ text: "M1" }] }] },
            { row: 0, col: 0, rowSpan: 1, colSpan: 1, paragraphs: [{ runs: [{ text: "" }] }] },
          ].slice(0, 1), // invalid single-cell also rejected!
          plainText: "M1\tM2",
        }) : null,
      };
      hwp.place(withCell(hwp.at, 0));
      expect(await hwp.editor.executeClipboard("edit.paste", () => true, mergedFromHwpx)).toBe(false);

      // Valid merged 1x3 payload rejected on 1x3 unmerged HWP row
      await hwp.run("table.insertColumnRight");
      const validMerged3: PlainClipboard = {
        readText: async () => "M1\tM2",
        writeText: async () => {},
        readStructured: async mime => mime === TABLE_CLIPBOARD_MIME ? JSON.stringify({
          kind: "geul.tableCells",
          version: 1,
          sourceFormat: "hwpx",
          rows: 1,
          cols: 3,
          cells: [
            { row: 0, col: 0, rowSpan: 1, colSpan: 2, paragraphs: [{ runs: [{ text: "M1" }] }] },
            { row: 0, col: 2, rowSpan: 1, colSpan: 1, paragraphs: [{ runs: [{ text: "M2" }] }] },
          ],
          plainText: "M1\tM2",
        }) : null,
      };
      hwp.place(withCell(hwp.at, 0));
      expect(await hwp.editor.executeClipboard("edit.paste", () => true, validMerged3)).toBe(false);
      expect(hwp.doc.getTextInCell(0, hwp.at.paragraph, hwp.at.cell!.control, 0, 0, 0, 20)).toBe("outer0");
    } finally { hwp.editor.dispose(); }
  });
});
