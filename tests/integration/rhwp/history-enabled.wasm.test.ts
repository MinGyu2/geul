// T010 교정 D-C: 시험 활성화 빌드 구성(VITE_GEUL_TEST_HOOKS=1 VITE_GEUL_TEST_RHWP_HISTORY=1)에서만 실행한다. 레지스트리 선언이 지원일
// 때 세션은 선택 없이(documentWorkspace와 같은 4인자 생성) 기록을 켜고, 실행 취소·다시 실행이 앱과 같은 명령 경로
// (documentCommandState → 세션 execute 재확인)로 실제 WASM 문서를 되돌리며, 감시는 앱 로더의 실제 선형 메모리를 읽는다.
// 일반 실행에서는 건너뛴다(그 구성은 history-config.wasm.test.ts가 본다).
//   VITE_GEUL_TEST_HOOKS=1 VITE_GEUL_TEST_RHWP_HISTORY=1 npx vitest run --config tests/integration/rhwp/vitest.config.ts history-enabled
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
const ENABLED = import.meta.env.VITE_GEUL_TEST_HOOKS === "1" && import.meta.env.VITE_GEUL_TEST_RHWP_HISTORY === "1";
type Doc = RhwpDocument & { getTextFileText(): string };

describe.runIf(ENABLED)("시험 활성화 구성(실제 WASM, 앱 명령 경로)", () => {
  let scratch: string;
  let fixture: Uint8Array;
  let module: RhwpModule;
  let saves = 0;
  let reads = 0;
  beforeAll(async () => {
    scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "geul-t010-enabled-"));
    execFileSync("node", [join(ROOT, "tests/fixtures/rhwp/generate.mjs"), scratch]);
    fixture = new Uint8Array(readFileSync(join(scratch, "basic-ko.hwp")));
    const generated = loadTestEngine(ROOT);
    const wasm = readFileSync(join(testPackage(ROOT), "rhwp_bg.wasm"));
    const real = await loadRhwpModule(async () => ({ default: () => generated.default({ module_or_path: wasm }), HwpDocument: generated.HwpDocument }));
    module = {
      openDocument: (bytes) => {
        const doc = real.openDocument(bytes);
        const save = doc.saveSnapshot.bind(doc);
        doc.saveSnapshot = () => { saves += 1; return save(); };
        return doc;
      },
      memoryBytes: () => { reads += 1; return real.memoryBytes!(); },
    };
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("레지스트리 선언이 지원이고 세션은 선택 없이 기록을 켜며, 실행 취소·다시 실행이 명령 경로로 실제 문서를 되돌린다", async () => {
    expect(commandDefinition("edit.undo")?.engines?.rhwp.level).toBe("supported");
    expect(commandDefinition("format.bold")?.engines?.rhwp.level).toBe("unsupported");
    const { backend, take } = controlledBackend();
    const sessions = new DocumentSessions(backend);
    const opening = sessions.open("/a.hwp");
    take("open").reply(ok(base));
    await opening;
    let doc: Doc | null = null;
    const editor = new RhwpEditorSession(1, backend, sessions, async () => ({
      ...module, openDocument: (b: Uint8Array) => { const d = module.openDocument(b) as Doc; doc ??= d; return d; },
    }));
    const loading = editor.load();
    take("load").reply(loaded(fixture));
    await flush();
    take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
    take("setState").reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
    await loading;
    const before = doc!.getTextFileText();
    const readsAtStart = reads;
    expect(readsAtStart).toBeGreaterThan(0); // 시작 측정
    editor.typeText("가");
    const after = doc!.getTextFileText();
    expect(saves).toBe(1);
    expect(reads).toBeGreaterThan(readsAtStart); // 새 그룹 찍기 전 측정
    expect(documentCommandState("edit.undo", editor.snapshot())).toEqual({ available: true });
    expect(editor.execute("edit.undo")).toEqual({ accepted: true });
    expect(doc!.getTextFileText()).toBe(before);
    expect(editor.execute("edit.redo")).toEqual({ accepted: true });
    expect(doc!.getTextFileText()).toBe(after);
    expect(editor.execute("format.bold")).toEqual({ accepted: false });
    editor.dispose();
  });
});
