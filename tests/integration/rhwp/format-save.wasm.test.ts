// T010 서식 D3 입력(선택 실행, GEUL_FORMAT_SAVE_OUT=<디렉터리>): 서식 명령을 받는 세션(실제 WASM, 기록 켬)으로 HWPX에 글자 서식을
// 적용한 모델을 앱과 같은 방식(내보내기 + 손실 보고 + 다시 열기 값)으로 파일에 쓰고, 다시 연 문서에서 범위별 서식을 확인한다.
// HWP 음성 대조는 세션이 막으므로 엔진에 직접 서식을 적용한다. 판정·저장은 tests/integration/rhwp/format_save.py가 실제
// service::save(Rust 시험 t010_phase0_save_service)로 한다.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentSessions } from "../../../src/adapters/sessions";
import { RhwpEditorSession } from "../../../src/components/Editor/rhwp/RhwpEditorSession";
import type { DocPosition } from "../../../src/components/Editor/rhwp/rhwpText";
import type { RhwpDocument, RhwpModule } from "../../../src/components/Editor/rhwp/rhwpModule";
import { base, controlledBackend, flush, info, loaded, ok } from "../../../src/components/Editor/rhwp/testing";
import { loadTestEngine, testPackage, wasmMemoryBytes } from "./test-package";

const ROOT = resolve(__dirname, "../../..");
const OUT = process.env.GEUL_FORMAT_SAVE_OUT;
type Doc = RhwpDocument & {
  getTextFileText(): string; getControls(): string;
  getCharPropertiesAt(s: number, p: number, o: number): string;
  getCellCharPropertiesAt(s: number, pp: number, c: number, cell: number, cp: number, o: number): string;
  applyCharFormat(s: number, p: number, a: number, b: number, props: string): string;
  exportHwpWithReport(): { contentLoss(): string; takeBytes(): Uint8Array; free(): void };
  exportHwpxWithReport(): { contentLoss(): string; takeBytes(): Uint8Array; free(): void };
};
type Probe = { at: DocPosition; prop: "bold" | "italic" | "underline" | "strikethrough"; value: boolean };

describe.runIf(OUT)("서식 D3 입력: 서식을 적용한 실제 세션 모델의 내보내기", () => {
  it("HWPX 서식 사례와 HWP 음성 대조", async () => {
    const out = OUT!;
    mkdirSync(join(out, "fixtures"), { recursive: true });
    execFileSync("node", [join(ROOT, "tests/fixtures/rhwp/generate.mjs"), join(out, "fixtures")]);
    const meta = JSON.parse(readFileSync(join(out, "fixtures", "basic-ko.json"), "utf8")) as { table: { paragraph: number; control: number } };
    const mod = loadTestEngine(ROOT);
    const memoryBytes = wasmMemoryBytes(mod.initSync({ module: readFileSync(join(testPackage(ROOT), "rhwp_bg.wasm")) }));
    const body = (paragraph: number, offset: number): DocPosition => ({ section: 0, paragraph, offset });
    const cell = { parentParagraph: meta.table.paragraph, control: meta.table.control, cell: 0, cellParagraph: 0 };
    const inCell = (offset: number): DocPosition => ({ section: 0, paragraph: meta.table.paragraph, offset, cell });
    const read = (d: Doc, p: Probe) => {
      const c = p.at.cell;
      const v = JSON.parse(c ? d.getCellCharPropertiesAt(0, c.parentParagraph, c.control, c.cell, c.cellParagraph, p.at.offset)
        : d.getCharPropertiesAt(0, p.at.paragraph, p.at.offset)) as Record<string, unknown>;
      return v[p.prop];
    };
    type Case = { name: string; fmt: "hwp" | "hwpx"; run(editor: RhwpEditorSession, doc: Doc): boolean; probes: Probe[] };
    const select = (editor: RhwpEditorSession, from: DocPosition, to: DocPosition) => { editor.anchor = from; editor.caret = to; };
    const cases: Case[] = [
      { name: "body-bold", fmt: "hwpx", run: (e) => (select(e, body(0, 0), body(0, 3)), e.execute("format.bold").accepted),
        probes: [{ at: body(0, 0), prop: "bold", value: true }, { at: body(0, 2), prop: "bold", value: true }, { at: body(0, 3), prop: "bold", value: false }] },
      { name: "multi-italic", fmt: "hwpx", run: (e) => (select(e, body(0, 3), body(1, 2)), e.execute("format.italic").accepted),
        probes: [{ at: body(0, 2), prop: "italic", value: false }, { at: body(0, 3), prop: "italic", value: true }, { at: body(1, 1), prop: "italic", value: true }, { at: body(1, 2), prop: "italic", value: false }] },
      { name: "cell-underline", fmt: "hwpx", run: (e) => (select(e, inCell(0), inCell(2)), e.execute("format.underline").accepted),
        probes: [{ at: inCell(0), prop: "underline", value: true }, { at: inCell(2), prop: "underline", value: false }] },
      { name: "bold-off", fmt: "hwpx", run: (e) => (select(e, body(1, 0), body(1, 3)), e.execute("format.bold").accepted),
        probes: [{ at: body(1, 0), prop: "bold", value: false }, { at: body(1, 3), prop: "bold", value: true }] },
      { name: "strike", fmt: "hwpx", run: (e) => (select(e, body(0, 5), body(0, 9)), e.execute("format.strikethrough").accepted),
        probes: [{ at: body(0, 5), prop: "strikethrough", value: true }, { at: body(0, 9), prop: "strikethrough", value: false }] },
      { name: "bold-undone", fmt: "hwpx", run: (e) => (select(e, body(0, 0), body(0, 3)), e.execute("format.bold").accepted && e.execute("edit.undo").accepted),
        probes: [{ at: body(0, 0), prop: "bold", value: false }] },
      // 음성 대조: 세션은 HWP 서식을 받지 않는다(거부 확인). 엔진에 직접 적용한 모델은 T009가 저장을 막아야 한다.
      { name: "hwp-engine-bold", fmt: "hwp", run: (e, d) => (select(e, body(0, 0), body(0, 3)), !e.execute("format.bold").accepted && (d.applyCharFormat(0, 0, 0, 3, '{"bold":true}'), true)),
        probes: [{ at: body(0, 0), prop: "bold", value: true }] },
    ];
    const results: unknown[] = [];
    for (const c of cases) {
      const { backend, take } = controlledBackend();
      const sessions = new DocumentSessions(backend);
      const opening = sessions.open(`/a.${c.fmt}`);
      take("open").reply(ok({ ...base, format: c.fmt }));
      await opening;
      let doc: Doc | null = null;
      const module: RhwpModule = { openDocument: (b) => { const d = new mod.HwpDocument(b) as Doc; doc ??= d; return d; }, memoryBytes };
      const editor = new RhwpEditorSession(1, backend, sessions, async () => module, { history: true, format: true });
      const original = join(out, "fixtures", `basic-ko.${c.fmt}`);
      const loading = editor.load();
      take("load").reply(loaded(new Uint8Array(readFileSync(original))));
      await flush();
      take("session").reply(ok(info({ format: c.fmt, state: "loading", sequence: 1, loadGeneration: 1 })));
      take("setState").reply(ok(info({ format: c.fmt, state: "ready", sequence: 2, loadGeneration: 1 })));
      await loading;
      const emit = (name: string) => {
        const e = c.fmt === "hwp" ? doc!.exportHwpWithReport() : doc!.exportHwpxWithReport();
        const loss = e.contentLoss();
        const bytes = e.takeBytes();
        e.free();
        const re = new mod.HwpDocument(bytes) as Doc;
        const reopen = { formatEqual: re.getSourceFormat() === c.fmt, pagesEqual: re.pageCount() === doc!.pageCount(),
          textEqual: re.getTextFileText() === doc!.getTextFileText(), controlsEqual: re.getControls() === doc!.getControls() };
        const reopenFormat = c.probes.map((p) => ({ ...p, model: read(doc!, p), reopened: read(re, p) }));
        re.free();
        const file = join(out, `${c.name}-${name}.${c.fmt}`);
        writeFileSync(file, bytes);
        writeFileSync(`${file}.loss.json`, loss);
        return { file, reopen, reopenFormat };
      };
      const unedited = emit("unedited");
      const ran = c.run(editor, doc!);
      expect(ran, c.name).toBe(true);
      const output = emit("output");
      for (const p of output.reopenFormat) {
        expect(p.model, `${c.name} model ${p.prop}`).toBe(p.value);
        expect(p.reopened, `${c.name} reopened ${p.prop}`).toBe(p.value);
      }
      results.push({ name: c.name, fmt: c.fmt, original, unedited, output, revision: editor.localRevision, unpreserved: editor.hasUnpreservedChanges });
      editor.dispose();
    }
    writeFileSync(join(out, "cases.json"), JSON.stringify(results, null, 1));
  });
});
