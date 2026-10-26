// T010 교정 D: 제품 기본 구성과 기록을 켠 구성을 실제 WASM과 앱의 모듈 로더(rhwpModule.ts loadRhwpModule)로 나눠 본다.
// - 로더가 wasm-bindgen 초기화 결과의 memory로 memoryBytes를 만든다(가짜 모듈이 아님).
// - 제품 기본(세션 선택 없음 → 이 빌드의 레지스트리, rhwp 실행 취소 unsupported): 실제 편집에서 saveSnapshot을 부르지 않는다.
// - 기록을 켠 구성({ history: true }, 시험 활성화 빌드와 같음): 같은 명령 경로(execute → 재확인)는 레지스트리가 막고, 세션 기록은
//   찍고 되돌리며 감시는 실제 선형 메모리를 읽는다.
// - 한 모듈의 두 문서: 한 문서를 닫아도 다른 문서의 스냅숏·실행 취소는 그대로다.
//   npx vitest run --config tests/integration/rhwp/vitest.config.ts history-config
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentSessions } from "../../../src/adapters/sessions";
import { commandDefinition } from "../../../src/commands/registry";
import { RhwpEditorSession } from "../../../src/components/Editor/rhwp/RhwpEditorSession";
import { loadRhwpModule, RHWP_MODULE_URL, type RhwpDocument, type RhwpModule } from "../../../src/components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, flush, info, loaded, ok } from "../../../src/components/Editor/rhwp/testing";
import { loadTestEngine, testPackage } from "./test-package";

const ROOT = resolve(__dirname, "../../..");
type Doc = RhwpDocument & { getTextFileText(): string };
let scratch: string;
let fixture: Uint8Array;
let module: RhwpModule;
const opened: { doc: Doc; saves: number }[] = [];

beforeAll(async () => {
  scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "geul-t010-config-"));
  execFileSync("node", [join(ROOT, "tests/fixtures/rhwp/generate.mjs"), scratch]);
  fixture = new Uint8Array(readFileSync(join(scratch, "basic-ko.hwpx")));
  const generated = loadTestEngine(ROOT);
  const wasm = readFileSync(join(testPackage(ROOT), "rhwp_bg.wasm"));
  // 앱 로더를 그대로 쓰되 같은 출처 URL 대신 바이트로 초기화한다(node에는 앱 서버가 없다). 반환값은 실제 wasm-bindgen exports다.
  const loaded = await loadRhwpModule(async (url) => {
    expect(url).toBe(RHWP_MODULE_URL);
    return { default: () => generated.default({ module_or_path: wasm }), HwpDocument: generated.HwpDocument };
  });
  // 스냅숏 호출을 세려고 문서만 감싼다(측정은 로더가 만든 것 그대로).
  module = {
    openDocument: (bytes) => {
      const doc = loaded.openDocument(bytes) as Doc;
      const entry = { doc, saves: 0 };
      const save = doc.saveSnapshot.bind(doc);
      doc.saveSnapshot = () => { entry.saves += 1; return save(); };
      opened.push(entry);
      return doc;
    },
    ...(loaded.memoryBytes ? { memoryBytes: loaded.memoryBytes } : {}),
  };
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function open(options?: { history?: boolean }) {
  const { backend, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwpx");
  take("open").reply(ok({ ...base, format: "hwpx" }));
  await opening;
  const first = opened.length;
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module, options);
  const loading = editor.load();
  take("load").reply(loaded(fixture));
  await flush();
  take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
  take("setState").reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
  await loading;
  const entry = opened[first]!;
  return { editor, entry };
}

function edit(editor: RhwpEditorSession) {
  editor.typeText("가");
  editor.moveHorizontal(1, false);
  editor.typeText("나");
  editor.backspace();
  editor.enter();
}

describe("실제 WASM: 제품 기본과 기록을 켠 구성", () => {
  it("앱 로더의 memoryBytes는 실제 WebAssembly.Memory에서 읽고 0 이상 안전 정수·줄지 않음", async () => {
    expect(typeof module.memoryBytes).toBe("function");
    const a = module.memoryBytes!();
    expect(Number.isSafeInteger(a) && a > 0).toBe(true);
    const { editor } = await open({ history: true });
    edit(editor);
    expect(module.memoryBytes!()).toBeGreaterThanOrEqual(a);
    editor.dispose();
  });

  it("이 시험 빌드의 레지스트리는 rhwp 실행 취소·다시 실행·서식을 지원하지 않는다(전제)", () => {
    for (const id of ["edit.undo", "edit.redo", "format.bold", "format.italic", "format.underline", "format.strikethrough"]) {
      expect(commandDefinition(id)?.engines?.rhwp.level).toBe("unsupported");
    }
  });

  it("제품 기본(세션 선택 없음): 기록 없음, 실제 편집에서 saveSnapshot 0회, 명령 경로 거절", async () => {
    const { editor, entry } = await open();
    edit(editor);
    expect(entry.saves).toBe(0);
    expect(editor.snapshot().history).toBeNull();
    expect(editor.snapshot().historyLimited).toBe(false);
    expect(editor.execute("edit.undo")).toEqual({ accepted: false });
    expect(editor.undo()).toBe(false);
    expect(entry.doc.getTextFileText()).toContain("가");
    editor.dispose();
  });

  it("기록을 켠 구성: 그룹 시작마다 찍고 실행 취소·다시 실행이 실제 문서를 되돌림, 명령 경로는 레지스트리가 계속 막음", async () => {
    const { editor, entry } = await open({ history: true });
    const before = entry.doc.getTextFileText();
    editor.typeText("가");
    expect(entry.saves).toBe(1);
    expect(editor.snapshot().history).toEqual({ undo: true, redo: false });
    expect(editor.execute("edit.undo")).toEqual({ accepted: false }); // 레지스트리 unsupported(시험 활성화 빌드가 아님)
    const after = entry.doc.getTextFileText();
    expect(editor.undo()).toBe(true);
    expect(entry.doc.getTextFileText()).toBe(before);
    expect(editor.redo()).toBe(true);
    expect(entry.doc.getTextFileText()).toBe(after);
    editor.dispose();
  });

  it("한 모듈의 두 문서: 한 문서를 닫아도 다른 문서의 기록·스냅숏은 그대로", async () => {
    const a = await open({ history: true });
    const b = await open({ history: true });
    a.editor.typeText("A");
    b.editor.typeText("B");
    const bBefore = b.entry.doc.getTextFileText();
    a.editor.dispose();
    expect(b.editor.snapshot().history).toEqual({ undo: true, redo: false });
    expect(b.editor.undo()).toBe(true);
    expect(b.entry.doc.getTextFileText()).not.toBe(bBefore);
    expect(b.editor.redo()).toBe(true);
    expect(b.entry.doc.getTextFileText()).toBe(bBefore);
    b.editor.dispose();
  });
});
