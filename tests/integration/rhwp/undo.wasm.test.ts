import { loadTestEngine, testPackage } from "./test-package";
// T010 Phase 2 실제 rhwp WASM 통합 시험: 제품 RhwpEditorSession(기록 rhwpHistory.ts 포함)을 고정 WASM 문서로 열고 세션 메서드로
// 편집·실행 취소·다시 실행한다. 백엔드는 시험 응답(controlledBackend), 입력은 세션 메서드 호출(입력기 아님 — 네이티브 ibus-hangul은
// tests/integration/rhwp/rhwp_poc.py). 픽스처는 generate.mjs가 임시 디렉터리에 만든다.
//   npx vitest run --config tests/integration/rhwp/vitest.config.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentSessions } from "../../../src/adapters/sessions";
import { RhwpEditorSession } from "../../../src/components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "../../../src/components/Editor/rhwp/rhwpModule";
import { ImeInput } from "../../../src/components/Editor/rhwp/imeInput";
import { base, controlledBackend, flush, info, loaded, ok } from "../../../src/components/Editor/rhwp/testing";

const ROOT = resolve(__dirname, "../../..");
type Doc = RhwpDocument & { getTextFileText(): string; getControls(): string };
let engine: { HwpDocument: new (bytes: Uint8Array) => Doc };
const fixtures: Record<"hwp" | "hwpx", Uint8Array> = {} as never;
let scratch: string;

beforeAll(async () => {
  scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "geul-t010-undo-"));
  execFileSync("node", [join(ROOT, "tests/fixtures/rhwp/generate.mjs"), scratch]);
  for (const fmt of ["hwp", "hwpx"] as const) fixtures[fmt] = new Uint8Array(readFileSync(join(scratch, `basic-ko.${fmt}`)));
  const mod = loadTestEngine(ROOT);
  mod.initSync({ module: readFileSync(join(testPackage(ROOT), "rhwp_bg.wasm")) });
  engine = mod;
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function open(fmt: "hwp" | "hwpx") {
  const { backend, take, calls } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open(`/a.${fmt}`);
  take("open").reply(ok({ ...base, format: fmt }));
  await opening;
  let doc: Doc | null = null;
  // 세션이 여는 첫 문서가 편집 모델이다(왕복 검사가 다시 여는 문서는 세션이 바로 놓는다 — 잡지 않음).
  const module: RhwpModule = {
    openDocument: (bytes) => {
      const opened = new engine.HwpDocument(bytes);
      doc ??= opened;
      return opened;
    },
  };
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module);
  const loading = editor.load();
  take("load").reply(loaded(fixtures[fmt]));
  await flush();
  take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
  take("setState").reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
  await loading;
  const state = () => ({ text: doc!.getTextFileText(), controls: doc!.getControls(), pages: editor.pages.length });
  const caret = () => ({ caret: editor.caret, anchor: editor.anchor });
  return { editor, doc: () => doc!, state, caret, take, calls };
}

describe.each(["hwp", "hwpx"] as const)("실제 WASM 세션 실행 취소(%s)", (fmt) => {
  it("넣기·나누기·합치기·선택 바꾸기·표 셀 편집: 단계마다 실행 취소가 그 시점의 문서·커서로, 다시 실행이 다음 시점으로", async () => {
    const s = await open(fmt);
    const timeline = [{ ...s.state(), ...s.caret() }];
    const step = (run: () => void) => {
      run();
      timeline.push({ ...s.state(), ...s.caret() });
    };
    // 표 셀(먼저 — 본문 나누기가 표 문단 번호를 바꾸기 전): 표 문단 2, 컨트롤 0, 셀 1에서 넣기 + 셀 문단 나누기.
    step(() => {
      (s.editor as unknown as { moveTo(p: unknown, e: boolean): void }).moveTo({ section: 0, paragraph: 2, offset: 1, cell: { parentParagraph: 2, control: 0, cell: 1, cellParagraph: 0 } }, false);
      s.editor.typeText("셀");
    });
    step(() => s.editor.enter());
    step(() => (s.editor as unknown as { moveTo(p: unknown, e: boolean): void }).moveTo({ section: 0, paragraph: 0, offset: 0 }, false));
    step(() => { for (const ch of "앞글") s.editor.typeText(ch); }); // 한 그룹
    step(() => s.editor.enter()); // 나누기
    step(() => { s.editor.moveHorizontal(1, false); s.editor.moveHorizontal(1, true); s.editor.moveHorizontal(1, true); s.editor.typeText("바"); }); // 선택 바꾸기
    step(() => { s.editor.moveHorizontal(-1, false); s.editor.moveHorizontal(-1, false); s.editor.moveHorizontal(-1, false); s.editor.backspace(); }); // 문단 처음 ⌫ = 합치기
    // 이동만 한 단계(세 번째)는 문서가 같다 — 기록 단계가 아니므로 시간선에서 뺀다.
    timeline.splice(3, 1);
    expect(new Set(timeline.map((t) => t.text)).size).toBe(timeline.length); // 단계마다 문서가 다르다
    const revision = s.editor.localRevision;
    for (let k = timeline.length - 1; k > 0; k--) {
      const version = s.editor.modelVersion;
      expect(s.editor.undo()).toBe(true);
      expect(s.state()).toEqual({ text: timeline[k - 1]!.text, controls: timeline[k - 1]!.controls, pages: timeline[k - 1]!.pages });
      expect(s.editor.modelVersion).toBeGreaterThan(version);
      expect(s.editor.caretRect()).not.toBeNull();
    }
    expect(s.editor.undo()).toBe(false);
    // 첫 그룹을 되돌리면 커서는 그 편집이 시작한 자리(셀 1, 오프셋 1)로 — 불러온 때의 자리가 아니다(체크포인트 = 그룹 시작 커서).
    const cellStart = { section: 0, paragraph: 2, offset: 1, cell: { parentParagraph: 2, control: 0, cell: 1, cellParagraph: 0 } };
    expect(s.caret()).toEqual({ caret: cellStart, anchor: cellStart });
    for (let k = 1; k < timeline.length; k++) {
      expect(s.editor.redo()).toBe(true);
      expect(s.state().text).toBe(timeline[k]!.text);
    }
    expect(s.editor.redo()).toBe(false);
    // 실행 취소·다시 실행 하나가 변경 1개: revision은 늘기만 한다.
    expect(s.editor.localRevision).toBe(revision + 2 * (timeline.length - 1));
    // 다시 모두 되돌린 뒤 복원한 커서(제품 placeCheckpoint, 셀 문맥)에서 바로 친 글자는 그 셀의 그 자리에 들어가고, 다시 실행 기록을 버린다.
    while (s.editor.undo());
    expect(s.caret()).toEqual({ caret: cellStart, anchor: cellStart });
    const cellText = () => s.doc().getTextInCell(0, 2, 0, 1, 0, 0, 20);
    const beforeType = cellText();
    expect(s.editor.typeText("Q")).toBe(true);
    expect(cellText()).toBe(beforeType.slice(0, 1) + "Q" + beforeType.slice(1, 19));
    expect(s.editor.redo()).toBe(false);
    expect(s.editor.undo()).toBe(true);
    expect(cellText()).toBe(beforeType);
    s.editor.dispose();
  });

  it("실행 취소한 상태를 왕복 검사하면 통과하고, 모두 되돌린 문서의 내보내기 바이트는 편집 전과 같음", async () => {
    const s = await open(fmt);
    const before = s.editor.roundTrip(fmt);
    expect(before?.passed).toBe(true);
    const exportBytes = () => {
      const d = s.doc();
      const e = fmt === "hwp" ? d.exportHwpWithReport() : d.exportHwpxWithReport();
      try { return Array.from(e.takeBytes()); } finally { e.free(); }
    };
    const pristine = exportBytes();
    s.editor.typeText("가");
    s.editor.enter();
    s.editor.typeText("나");
    expect(s.editor.roundTrip(fmt)?.passed).toBe(true);
    while (s.editor.undo());
    expect(s.editor.lastRoundTrip).toBeNull(); // 복원이 이전 검사를 지운다
    expect(s.editor.roundTrip(fmt)?.passed).toBe(true);
    expect(exportBytes()).toEqual(pristine);
    s.editor.dispose();
  });

  it("한국어 조합(세션 메서드): 갱신은 단계가 아니고, 선택 지운 뒤 취소는 실행 취소가 되살림, 조합 중 거절", async () => {
    const s = await open(fmt);
    const t0 = s.state().text;
    s.editor.moveHorizontal(1, true);
    s.editor.moveHorizontal(1, true);
    s.editor.beginComposition();
    expect(s.editor.undo()).toBe(false);
    s.editor.updateComposition("ㅎ");
    s.editor.updateComposition("하");
    s.editor.endComposition("");
    expect(s.state().text).not.toBe(t0);
    expect(s.editor.undo()).toBe(true);
    expect(s.state().text).toBe(t0);
    expect(s.editor.caret.offset - s.editor.anchor.offset).toBe(2); // 선택이 돌아옴
    s.editor.moveHorizontal(1, false);
    s.editor.beginComposition();
    s.editor.updateComposition("한");
    s.editor.endComposition("한");
    s.editor.beginComposition();
    s.editor.updateComposition("글");
    s.editor.endComposition("글");
    const typed = s.state().text;
    expect(s.editor.undo()).toBe(true); // 이어진 조합 둘 = 한 단계
    expect(s.state().text).toBe(t0);
    expect(s.editor.redo()).toBe(true);
    expect(s.state().text).toBe(typed);
    s.editor.dispose();
  });

  it("native 취소 trace 재생: 같은 셀/본문 모델에서 선택 복원과 late-tail 거부, revision은 증가", async () => {
    const s = await open(fmt);
    const original = s.state().text;
    s.editor.moveHorizontal(1, true); s.editor.moveHorizontal(1, true);
    const ime = new ImeInput(s.editor);
    ime.compositionStart(); ime.input("ㄱ", "insertCompositionText", true);
    ime.input("", "deleteCompositionText", true); ime.compositionEnd("");
    expect(s.editor.undo()).toBe(false);
    ime.keyUp("Backspace", 8, false, false);
    const revision = s.editor.localRevision;
    expect(s.editor.undo()).toBe(true);
    expect(s.state().text).toBe(original);
    expect(s.editor.localRevision).toBe(revision + 1);
    expect(s.editor.caret.offset - s.editor.anchor.offset).toBe(2);
    ime.input("간", "insertFromComposition", true); ime.compositionEnd("간");
    expect(s.state().text).toBe(original);
    expect(s.editor.redo()).toBe(true);
    expect(s.state().text).not.toBe(original);
    s.editor.dispose();
  });

  it.each(["reserve", "redo", "cancel", "release"] as const)("실제 WASM %s 폐기 후 예외: uncertain·편집/저장 차단", async boundary => {
    const s = await open(fmt);
    if (boundary === "reserve") {
      for (let k=0;k<50;k++) { s.editor.typeText("x");s.editor.endHistoryGroup(); }
      s.doc().snapshotCapacity=()=>52;
    } else s.editor.typeText("x");
    if (boundary === "redo") s.editor.undo();
    if (boundary === "cancel") {s.editor.endHistoryGroup();s.editor.beginComposition();s.editor.updateComposition("가");}
    const original=s.doc().discardSnapshot.bind(s.doc());
    s.doc().discardSnapshot=id=>{original(id);throw new Error("injected exception after actual discard");};
    if (boundary === "release") (s.editor as unknown as {dropHistory(r:"unavailable"):void}).dropHistory("unavailable");
    else if (boundary === "cancel") s.editor.endComposition("");
    else s.editor.typeText("y");
    expect(s.editor.status.kind).toBe("failed");expect(s.editor.hasUncertainChanges).toBe(true);
    expect(s.editor.snapshot().history).toBeNull();
    const text=s.state().text;
    expect(s.editor.typeText("unsafe")).toBe(false);expect(s.editor.undo()).toBe(false);
    expect((await s.editor.save()).ok).toBe(false);expect(s.state().text).toBe(text);
    s.editor.dispose();
  });

  it.each(["allocate-before", "allocate-after", "restore-undo", "restore-redo", "close-cleanup"] as const)(
    "실제 후보 WASM %s 실패 경계: 거짓 성공·revision rollback·disposed mutation 없음", async boundary => {
      const s = await open(fmt);
      const ids: number[] = [], discarded: number[] = [];
      let frees = 0;
      const free = s.doc().free.bind(s.doc());
      s.doc().free = () => { frees++; free(); };
      const save = s.doc().saveSnapshot.bind(s.doc());
      const discard = s.doc().discardSnapshot.bind(s.doc());
      s.doc().discardSnapshot = id => { discarded.push(id); discard(id); };
      const initial = s.editor.localRevision;
      if (boundary.startsWith("allocate")) {
        s.doc().saveSnapshot = () => {
          if (boundary === "allocate-after") ids.push(save());
          throw new Error("injected snapshot allocation failure");
        };
        expect(s.editor.typeText("x")).toBe(false);
        expect(s.editor.localRevision).toBe(initial);
      } else {
        s.editor.typeText("x"); s.editor.endHistoryGroup();
        if (boundary === "restore-redo") expect(s.editor.undo()).toBe(true);
        const revision = s.editor.localRevision;
        if (boundary === "close-cleanup") {
          s.doc().discardSnapshot = id => { discarded.push(id); discard(id); throw new Error("injected close cleanup failure"); };
          s.editor.dispose();
          expect(s.editor.status.kind).toBe("closed");
          expect(discarded).toEqual([]); // close frees the owning WASM document directly
        } else {
          const restore = s.doc().restoreSnapshot.bind(s.doc());
          s.doc().restoreSnapshot = id => { restore(id); throw new Error("injected after actual restore"); };
          expect(boundary === "restore-redo" ? s.editor.redo() : s.editor.undo()).toBe(false);
          expect(s.editor.hasUncertainChanges).toBe(true);
          expect(s.editor.status.kind).toBe("failed");
        }
        expect(s.editor.localRevision).toBe(revision);
      }
      if (boundary !== "close-cleanup") {
        expect(s.editor.hasUncertainChanges).toBe(true);
        expect(s.editor.status).toMatchObject({ kind: "failed", error: { code: "EngineFailure", engine: "rhwp", stage: "edit" } });
      }
      expect(s.editor.snapshot().history).toBeNull();
      expect(s.editor.undo()).toBe(false); expect(s.editor.redo()).toBe(false);
      expect((await s.editor.save()).ok).toBe(false);
      s.editor.dispose(); s.editor.dispose();
      expect(s.editor.typeText("disposed")).toBe(false);
      expect(new Set(discarded).size).toBe(discarded.length);
      expect(frees).toBe(1);
      // Unknown allocation IDs are owned by document disposal, never reused by history.
      expect(ids.length).toBe(boundary === "allocate-after" ? 1 : 0);
    });

  it("본문 Undo 뒤 셀로 이동한 새 편집: 같은 snapshot 재사용도 셀 caret/선택 checkpoint 갱신", async () => {
    const s=await open(fmt);
    s.editor.typeText("body");expect(s.editor.undo()).toBe(true);
    const at={section:0,paragraph:2,offset:1,cell:{parentParagraph:2,control:0,cell:1,cellParagraph:0}};
    (s.editor as unknown as {moveTo(p:unknown,e:boolean):void}).moveTo(at,false);
    const original=s.state();
    s.editor.typeText("셀");s.editor.enter();
    expect(s.editor.undo()).toBe(true);expect(s.editor.undo()).toBe(true);
    expect(s.state()).toEqual(original);expect(s.editor.caret).toEqual(at);expect(s.editor.anchor).toEqual(at);
    expect(s.editor.redo()).toBe(true);expect(s.editor.redo()).toBe(true);s.editor.dispose();
  });

  it("상한 경계: 그룹 60개(깊이 50) — 50단계만 되돌리고 가장 오래된 남은 상태가 정확히 그 시점", async () => {
    const s = await open(fmt);
    const texts = [s.state().text];
    for (let k = 0; k < 60; k++) {
      s.editor.moveHorizontal(-1, false); // 그룹을 끊는다(제자리로 돌아오는 이동 — 문서 끝에서도 이동이 일어난다)
      s.editor.moveHorizontal(1, false);
      s.editor.typeText(String.fromCharCode(0x3131 + (k % 14)));
      texts.push(s.state().text);
    }
    let undone = 0;
    while (s.editor.undo()) undone += 1;
    expect(undone).toBe(50);
    expect(s.state().text).toBe(texts[10]);
    for (let k = 0; k < 50; k++) expect(s.editor.redo()).toBe(true);
    expect(s.state().text).toBe(texts[60]);
    s.editor.dispose();
  });
});
