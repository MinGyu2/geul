// T010 Phase 2 Gate D3 입력(선택 실행, GEUL_UNDO_SAVE_OUT=<디렉터리>): 제품 RhwpEditorSession(실제 WASM)에서 편집 → 실행 취소 →
// 다시 실행한 모델을 앱과 같은 방식(내보내기 + 손실 보고 + 다시 열기 네 값 — exportAndCompare와 같은 비교)으로 파일에 쓴다.
// 판정·저장은 tests/integration/rhwp/undo_save.py가 실제 service::save(Rust 시험 t010_phase0_save_service)로 한다.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { DocumentSessions } from "../../../src/adapters/sessions";
import { RhwpEditorSession } from "../../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "../../../src/components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, flush, info, loaded, ok } from "../../../src/components/Editor/rhwp/testing";

const ROOT = resolve(__dirname, "../../..");
const OUT = process.env.GEUL_UNDO_SAVE_OUT;
type Doc = RhwpDocument & { getTextFileText(): string; getControls(): string };

describe.runIf(OUT)("D3 입력: 실행 취소·다시 실행한 실제 세션 모델의 내보내기", () => {
  it("HWP·HWPX(생성 픽스처·여러 구역 공개 예제)", async () => {
    const out = OUT!;
    mkdirSync(join(out, "fixtures"), { recursive: true });
    execFileSync("node", [join(ROOT, "tests/fixtures/rhwp/generate.mjs"), join(out, "fixtures")]);
    const mod = await import(/* @vite-ignore */ pathToFileURL(join(ROOT, "public/rhwp/rhwp.js")).href);
    mod.initSync({ module: readFileSync(join(ROOT, "public/rhwp/rhwp_bg.wasm")) });
    const cases: unknown[] = [];
    // 생성 픽스처 둘 + 여러 구역 공개 예제 둘(사본 — 원본 예제는 읽기만).
    const multi = [["aift.hwp", "external/rhwp/samples/aift.hwp"], ["assets.hwpx", "external/rhwp/samples/issue6031/3249937_asset_management_rules.hwpx"]];
    for (const [name, path] of multi) writeFileSync(join(out, "fixtures", name), readFileSync(join(ROOT, path)));
    const inputs = [["basic", "hwp"], ["basic", "hwpx"], ["multi", "hwp"], ["multi", "hwpx"]] as const;
    for (const [kind, fmt] of inputs) {
      const original = kind === "basic" ? join(out, "fixtures", `basic-ko.${fmt}`) : join(out, "fixtures", fmt === "hwp" ? "aift.hwp" : "assets.hwpx");
      const tag = `${kind}-${fmt}`;
      const { backend, take } = controlledBackend();
      const sessions = new DocumentSessions(backend);
      const opening = sessions.open(`/a.${fmt}`);
      take("open").reply(ok({ ...base, format: fmt }));
      await opening;
      let doc: Doc | null = null;
      const module: RhwpModule = { openDocument: (b) => { const d = new mod.HwpDocument(b) as Doc; doc ??= d; return d; } };
      const editor = new RhwpEditorSession(1, backend, sessions, async () => module);
      const loading = editor.load();
      take("load").reply(loaded(new Uint8Array(readFileSync(original))));
      await flush();
      take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
      take("setState").reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
      await loading;
      /** 앱 exportAndCompare와 같은 내보내기·다시 열기 네 값. */
      const emit = (name: string) => {
        const e = fmt === "hwp" ? doc!.exportHwpWithReport() : doc!.exportHwpxWithReport();
        const loss = e.contentLoss();
        const bytes = e.takeBytes();
        e.free();
        const re = new mod.HwpDocument(bytes) as Doc;
        const reopen = { formatEqual: re.getSourceFormat() === fmt, pagesEqual: re.pageCount() === doc!.pageCount(),
          textEqual: re.getTextFileText() === doc!.getTextFileText(), controlsEqual: re.getControls() === doc!.getControls() };
        re.free();
        const file = join(out, `${tag}-${name}.${fmt}`);
        writeFileSync(file, bytes);
        writeFileSync(`${file}.loss.json`, loss);
        return { file, reopen, revision: editor.localRevision, modified: editor.hasUnpreservedChanges };
      };
      const unedited = emit("unedited");
      editor.typeText("가");
      editor.enter();
      editor.typeText("나");
      const edited = emit("edited");
      while (editor.undo());
      const undone = emit("undone");
      editor.redo();
      editor.redo();
      const redone = emit("redone");
      // 실행 취소 뒤 새 편집: 다시 실행 기록을 버리고 새 단계(그 모델의 내보내기).
      editor.undo();
      editor.typeText("다");
      const newAfterUndo = emit("newAfterUndo");
      expect(editor.redo()).toBe(false);
      expect(undone.revision).toBeGreaterThan(edited.revision);
      expect(undone.modified).toBe(true); // 내용이 원본과 같아도 저장하지 않은 편집으로 남는다
      cases.push({ kind, fmt, tag, original, unedited, edited, undone, redone, newAfterUndo });
      editor.dispose();
    }
    writeFileSync(join(out, "cases.json"), JSON.stringify(cases, null, 1));
  });
});
