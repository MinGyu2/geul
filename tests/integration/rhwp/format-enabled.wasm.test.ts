// T010 서식: 시험 활성화 빌드(VITE_GEUL_TEST_HOOKS=1 VITE_GEUL_TEST_RHWP_HISTORY=1 VITE_GEUL_TEST_RHWP_FORMAT=1)에서만 실행한다.
// 실제 rhwp WASM 문서에 앱 명령 경로(documentCommandState → 세션 execute 재확인)로 글자 서식을 적용하고, 실행 취소·다시 실행·
// 형식(HWP 거부)·선택 없음·조합 중·revision 경계를 본다. 일반 실행에서는 건너뛴다.
//   VITE_GEUL_TEST_HOOKS=1 VITE_GEUL_TEST_RHWP_HISTORY=1 VITE_GEUL_TEST_RHWP_FORMAT=1 npx vitest run --config tests/integration/rhwp/vitest.config.ts format-enabled
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentSessions } from "../../../src/adapters/sessions";
import { documentCommandState } from "../../../src/commands/capability";
import { commandDefinition } from "../../../src/commands/registry";
import { RhwpEditorSession } from "../../../src/components/Editor/rhwp/RhwpEditorSession";
import { loadRhwpModule, type RhwpDocument, type RhwpModule } from "../../../src/components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, flush, info, loaded, ok } from "../../../src/components/Editor/rhwp/testing";
import { loadTestEngine, testPackage } from "./test-package";

const ROOT = resolve(__dirname, "../../..");
const ENABLED = import.meta.env.VITE_GEUL_TEST_HOOKS === "1" && import.meta.env.VITE_GEUL_TEST_RHWP_HISTORY === "1"
  && import.meta.env.VITE_GEUL_TEST_RHWP_FORMAT === "1";
type Doc = RhwpDocument & { getTextFileText(): string; getCharPropertiesAt(s: number, p: number, o: number): string; exportHwpx?(): Uint8Array };
const FLAGS = ["format.bold", "format.italic", "format.underline", "format.strikethrough"] as const;
const PROP = { "format.bold": "bold", "format.italic": "italic", "format.underline": "underline", "format.strikethrough": "strikethrough" } as const;

describe.runIf(ENABLED)("rhwp 글자 서식(시험 활성화 구성, 실제 WASM, 앱 명령 경로)", () => {
  let scratch: string;
  let module: RhwpModule;
  beforeAll(async () => {
    scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "geul-t010-format-"));
    execFileSync("node", [join(ROOT, "tests/fixtures/rhwp/generate.mjs"), scratch]);
    const generated = loadTestEngine(ROOT);
    const wasm = readFileSync(join(testPackage(ROOT), "rhwp_bg.wasm"));
    module = await loadRhwpModule(async () => ({ default: () => generated.default({ module_or_path: wasm }), HwpDocument: generated.HwpDocument }));
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  async function open(format: "hwp" | "hwpx") {
    const fixture = new Uint8Array(readFileSync(join(scratch, `basic-ko.${format}`)));
    const { backend, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const opening = sessions.open(`/a.${format}`);
    take("open").reply(ok({ ...base, format }));
    await opening;
    let doc: Doc | null = null;
    const editor = new RhwpEditorSession(1, backend, sessions, async () => ({
      ...module, openDocument: (b: Uint8Array) => { const d = module.openDocument(b) as Doc; doc ??= d; return d; },
    }));
    const loading = editor.load();
    take("load").reply(loaded(fixture));
    await flush();
    take("session").reply(ok(info({ format, state: "loading", sequence: 1, loadGeneration: 1 })));
    take("setState").reply(ok(info({ format, state: "ready", sequence: 2, loadGeneration: 1 })));
    await loading;
    return { editor, doc: doc!, take };
  }
  const props = (doc: Doc, offset: number) => JSON.parse(doc.getCharPropertiesAt(0, 0, offset)) as Record<string, unknown>;
  const select = (editor: RhwpEditorSession, count: number) => {
    editor.moveLineEdge("start", false);
    for (let i = 0; i < count; i += 1) editor.moveHorizontal(1, true);
  };

  it("레지스트리 선언은 네 서식 모두 지원이다", () => {
    for (const id of FLAGS) expect(commandDefinition(id)?.engines?.rhwp.level).toBe("supported");
  });

  it("HWPX: 선택 없음·조합 중에는 막히고, 선택에 서식을 켜고 끄며 실행 취소·다시 실행이 한 단계로 되돌린다", async () => {
    const { editor, doc } = await open("hwpx");
    expect(documentCommandState("format.bold", editor.snapshot())).toEqual({ available: false, reason: "engineUnsupported" });
    select(editor, 2);
    const text = doc.getTextFileText();
    for (const id of FLAGS) {
      const prop = PROP[id];
      expect(props(doc, 0)[prop]).toBe(false);
      expect(documentCommandState(id, editor.snapshot())).toEqual({ available: true, pressed: false });
      const version = editor.modelVersion;
      expect(editor.execute(id)).toEqual({ accepted: true });
      expect(editor.modelVersion).toBe(version + 1);
      expect(editor.snapshot().pending).toBe(true);
      expect(props(doc, 0)[prop]).toBe(true);
      expect(props(doc, 1)[prop]).toBe(true);
      expect(props(doc, 2)[prop]).toBe(false); // 선택 밖 글자는 그대로
      expect(documentCommandState(id, editor.snapshot())).toEqual({ available: true, pressed: true });
      expect(doc.getTextFileText()).toBe(text); // 글자는 바뀌지 않음
      expect(editor.execute("edit.undo")).toEqual({ accepted: true });
      expect(props(doc, 0)[prop]).toBe(false);
      expect(editor.execute("edit.redo")).toEqual({ accepted: true });
      expect(props(doc, 0)[prop]).toBe(true);
      select(editor, 2);
      expect(editor.execute(id)).toEqual({ accepted: true }); // 다시 누르면 끈다
      expect(props(doc, 0)[prop]).toBe(false);
      select(editor, 2);
    }
    editor.beginComposition();
    editor.updateComposition("ㄱ");
    expect(documentCommandState("format.bold", editor.snapshot())).toEqual({ available: false, reason: "composing" });
    expect(editor.execute("format.bold")).toEqual({ accepted: false });
    editor.endComposition("");
    editor.dispose();
  });

  it("HWPX: 여러 문단 선택·이미 굵은 첫 글자(끄기)·표 셀 선택이 그 범위에만 적용된다", async () => {
    const { editor, doc } = await open("hwpx");
    const meta = JSON.parse(readFileSync(join(scratch, "basic-ko.json"), "utf8")) as { table: { paragraph: number; control: number } };
    const at = (paragraph: number, offset: number) => ({ section: 0, paragraph, offset });
    const p = (paragraph: number, offset: number) => JSON.parse(doc.getCharPropertiesAt(0, paragraph, offset)) as Record<string, unknown>;
    // 문단 0의 3번째 글자부터 문단 1의 2번째 글자 앞까지 기울임
    editor.anchor = at(0, 3);
    editor.caret = at(1, 2);
    expect(editor.execute("format.italic")).toEqual({ accepted: true });
    expect([p(0, 2).italic, p(0, 3).italic, p(0, 10).italic, p(1, 0).italic, p(1, 1).italic, p(1, 2).italic]).toEqual([false, true, true, true, true, false]);
    // 문단 1의 0..5는 픽스처에서 이미 굵게: 첫 글자가 굵으므로 누르면 끈다
    editor.anchor = at(1, 0);
    editor.caret = at(1, 3);
    expect(documentCommandState("format.bold", editor.snapshot())).toEqual({ available: true, pressed: true });
    expect(editor.execute("format.bold")).toEqual({ accepted: true });
    expect([p(1, 0).bold, p(1, 2).bold, p(1, 3).bold]).toEqual([false, false, true]);
    // 표 셀 0 문단 0의 처음 두 글자에 밑줄
    const cell = { parentParagraph: meta.table.paragraph, control: meta.table.control, cell: 0, cellParagraph: 0 };
    editor.anchor = { section: 0, paragraph: meta.table.paragraph, offset: 0, cell };
    editor.caret = { section: 0, paragraph: meta.table.paragraph, offset: 2, cell };
    expect(editor.execute("format.underline")).toEqual({ accepted: true });
    const c = (offset: number) => JSON.parse((doc as unknown as { getCellCharPropertiesAt(...a: number[]): string })
      .getCellCharPropertiesAt(0, cell.parentParagraph, cell.control, cell.cell, 0, offset)) as Record<string, unknown>;
    expect([c(0).underline, c(1).underline, c(2).underline]).toEqual([true, true, false]);
    expect(editor.execute("edit.undo")).toEqual({ accepted: true });
    expect(c(0).underline).toBe(false);
    editor.dispose();
  });

  it("HWP: 선택이 있어도 서식은 막힌다(DocInfo·미리보기 보존 규칙상 저장 불가)", async () => {
    const { editor, doc } = await open("hwp");
    select(editor, 2);
    for (const id of FLAGS) {
      expect(documentCommandState(id, editor.snapshot())).toEqual({ available: false, reason: "engineUnsupported" });
      expect(editor.execute(id)).toEqual({ accepted: false });
    }
    expect(props(doc, 0).bold).toBe(false);
    editor.dispose();
  });
});
