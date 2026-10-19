// T009 편집 세션의 저장: 확정한 판만, 사전 검사가 safe일 때만 저장하고, 저장한 판 뒤의 편집은 저장하지 않은 편집으로 남는다.
// 거부·실패는 원본을 바꾸지 않고 이유를 보인다. 가짜 백엔드는 Rust 저장 서비스의 계약을 흉내 낸다(실제 판정·교체는
// src-tauri/src/services/save/의 시험과 tests/roundtrip/, 실제 앱 시험).
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DocumentError, Result, SaveCheck, SaveOutcome } from "../../adapters/contract";
import { DocumentSessions } from "../../adapters/sessions";
import { LanguageProvider } from "../../language/LanguageContext";
import { RhwpEditorSession } from "./rhwp/RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "./rhwp/rhwpModule";
import { base, controlledBackend, FakeDocument, flush as flushRhwp, info, loaded, ok } from "./rhwp/testing";
import { SaveControls, type SaveEditor } from "./SaveControls";
import type { SaveState } from "./saveState";
import { flush, readyDocx } from "./wordcraft/testing";

const saves = (calls: { method: string; args: unknown[] }[]) => calls.filter((call) => call.method === "save");
const preflights = (calls: { method: string; args: unknown[] }[]) => calls.filter((call) => call.method === "preflight");

describe("DOCX 편집 세션 저장", () => {
  it("편집한 판을 사전 검사 뒤 저장하면 dirty가 풀리고 닫기에 버리기 확인이 필요 없다", async () => {
    const { editor, fake, sessions } = await readyDocx();
    editor.typeText("가");
    await flush();
    expect(editor.hasUnpreservedChanges).toBe(true);
    const result = await editor.save();
    expect(result.ok).toBe(true);
    expect(preflights(fake.calls)).toHaveLength(1);
    expect(saves(fake.calls)[0]!.args).toEqual([1, 1, 1]);
    expect(fake.saved).toEqual(["가가나다", "abc"]);
    expect(sessions.get(1)).toMatchObject({ revision: 1, dirty: false });
    expect(editor.saveState).toEqual({ kind: "saved", revision: 1, durable: true, changedSince: false });
    expect(editor.hasUnpreservedChanges).toBe(false);
    // 저장하면 원본이 바뀐다: 다음 저장은 사전 검사를 다시 한다.
    editor.typeText("나");
    await flush();
    await editor.save();
    expect(preflights(fake.calls)).toHaveLength(2);
  });

  it.each([
    ["unsafe", { outcome: "unsafe", findings: [{ code: "partMissing", part: "customXml/item1.xml" }] }],
    ["unknown", { outcome: "unknown", findings: [{ code: "originalMalformed", part: "word/document.xml" }] }],
  ] as const)("사전 검사가 %s면 저장 요청을 보내지 않고 이유를 보이며 편집은 저장하지 않은 채 남는다", async (_, preservation) => {
    const { editor, fake, sessions } = await readyDocx();
    fake.preservation = structuredClone(preservation) as unknown as SaveCheck["preservation"];
    editor.typeText("가");
    await flush();
    const result = await editor.save();
    expect(result).toEqual({ ok: false, error: { code: "UnsafeSave", preservation } });
    expect(saves(fake.calls)).toHaveLength(0);
    expect(fake.saved).toBeNull();
    expect(sessions.get(1)?.dirty).toBe(true);
    expect(editor.hasUnpreservedChanges).toBe(true);
    expect(editor.saveState).toEqual({ kind: "failed", error: { code: "UnsafeSave", preservation } });
  });

  it("원본 교체를 검증하지 않은 플랫폼에서는 저장하지 않는다", async () => {
    const { editor, fake } = await readyDocx();
    fake.platformSupported = false;
    editor.typeText("가");
    await flush();
    expect(await editor.save()).toEqual({ ok: false, error: { code: "SaveUnsupported", reason: "platform" } });
    expect(saves(fake.calls)).toHaveLength(0);
  });

  it("보내는 중인 편집·조합이 있으면 시작하지 않고, 저장 중 다시 저장하면 SaveInProgress", async () => {
    const { editor, fake } = await readyDocx();
    fake.hold = true;
    editor.typeText("가");
    expect(await editor.save()).toEqual({ ok: false, error: { code: "SaveNotReady", reason: "pending" } });
    fake.hold = false;
    fake.release();
    await flush();
    editor.beginComposition();
    editor.updateComposition("ㄱ");
    expect(await editor.save()).toEqual({ ok: false, error: { code: "SaveNotReady", reason: "composing" } });
    editor.endComposition("가");
    await flush();
    fake.hold = true;
    const first = editor.save();
    expect(await editor.save()).toEqual({ ok: false, error: { code: "SaveInProgress", sessionId: 1 } });
    fake.release();
    await flush();
    fake.release();
    await flush();
    expect((await first).ok).toBe(true);
    expect(saves(fake.calls)).toHaveLength(1);
  });

  it("저장하는 사이 편집하면 그 편집은 저장하지 않은 편집(dirty)으로 남는다", async () => {
    const { editor, fake, sessions } = await readyDocx();
    editor.typeText("가");
    await flush();
    await editor.checkSave();
    fake.hold = true;
    const saving = editor.save();
    await flush();
    editor.typeText("나"); // 저장 요청이 가는 중의 편집: 백엔드는 저장(판 1)을 먼저 처리하고 이 편집을 그 뒤에 확정한다
    fake.hold = false;
    fake.release();
    const result = await saving;
    expect(result.ok).toBe(true);
    expect(fake.saved).toEqual(["가가나다", "abc"]);
    expect(editor.saveState).toMatchObject({ kind: "saved", revision: 1, changedSince: true });
    await flush();
    expect(sessions.get(1)).toMatchObject({ revision: 2, dirty: true });
    expect(editor.hasUnpreservedChanges).toBe(true);
  });

  it("저장 실패(외부 수정 등)는 편집을 그대로 두고, 다시 불러오면 사전 검사를 버린다", async () => {
    const { editor, fake, sessions } = await readyDocx();
    editor.typeText("가");
    await flush();
    fake.saveError = { code: "FileConflict" };
    expect(await editor.save()).toEqual({ ok: false, error: { code: "FileConflict" } });
    expect(sessions.get(1)?.dirty).toBe(true);
    expect(fake.paragraphs[0]).toBe("가가나다");
    expect(editor.saveCheck).not.toBeNull();
    await editor.load({ discard: true });
    expect(editor.saveCheck).toBeNull();
    expect(editor.saveState).toEqual({ kind: "idle" });
  });
});

/** 첫 열기는 편집 모델, 그 뒤 열기(사전 검사의 새 문서)는 새 가짜 문서를 돌려주는 모듈. */
async function rhwpSession() {
  const { backend, calls, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwp");
  take("open").reply(ok(base));
  await opening;
  const doc = new FakeDocument(["가나다", "abc"]);
  const fresh: FakeDocument[] = [];
  const module: RhwpModule = {
    openDocument: (bytes: Uint8Array) => {
      if (fresh.length === 0 && !(doc as unknown as { opened?: boolean }).opened) {
        (doc as unknown as { opened: boolean }).opened = true;
        return doc as unknown as RhwpDocument;
      }
      // FakeDocument.exportHwpWithReport의 출력(서명 8바이트 + 문단)을 다시 열면 그 문단, 그 밖(원본 바이트)은 처음 문서.
      const exported = bytes.length > 8 && bytes[0] === 0xd0;
      const other = new FakeDocument(exported ? new TextDecoder().decode(bytes.subarray(8)).split("\n") : ["가나다", "abc"]);
      fresh.push(other);
      return other as unknown as RhwpDocument;
    },
  };
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module);
  const loading = editor.load();
  take("load").reply(loaded());
  await flushRhwp();
  take("session").reply(ok(info({ state: "loading", sequence: 1, loadGeneration: 1 })));
  take("setState").reply(ok(info({ state: "ready", sequence: 2, loadGeneration: 1 })));
  await loading;
  return { editor, doc, fresh, sessions, calls, take };
}

describe("rhwp 편집 세션 저장", () => {
  it("원본을 새 문서로 열어 편집 없이 내보낸 출력으로 사전 검사하고, 확정한 판을 내보내 다시 연 비교와 함께 저장한다", async () => {
    const t = await rhwpSession();
    t.editor.typeText("x");
    await flushRhwp();
    t.take("commit").reply(ok(info({ state: "ready", revision: 1, dirty: true, sequence: 3, loadGeneration: 1 })));
    await flushRhwp();
    const saving = t.editor.save();
    t.take("original").reply(ok(new Uint8Array([1, 2, 3])));
    await flushRhwp();
    expect(t.fresh[0]!.freed).toBe(true); // 사전 검사용 문서는 놓는다
    expect(t.doc.freed).toBe(false);
    const preflight = t.take("preflight");
    expect(preflight.args.slice(0, 2)).toEqual([1, 1]);
    expect(preflight.args[3]).toEqual({ count: 0, losses: [] });
    preflight.reply(ok({ preservation: { outcome: "safe", findings: [] }, platformSupported: true }));
    await flushRhwp();
    const save = t.take("save");
    expect(save.args.slice(0, 3)).toEqual([1, 1, 1]);
    expect(new TextDecoder().decode((save.args[3] as Uint8Array).subarray(8))).toBe("x가나다\nabc");
    expect(save.args[5]).toEqual({ formatEqual: true, pagesEqual: true, textEqual: true, controlsEqual: true });
    save.reply(ok({ session: info({ state: "ready", revision: 1, dirty: false, sequence: 4, loadGeneration: 1 }), bytes: 20, durable: true } satisfies SaveOutcome));
    expect((await saving).ok).toBe(true);
    expect(t.sessions.get(1)?.dirty).toBe(false);
    expect(t.editor.hasUnpreservedChanges).toBe(false);
    expect(t.editor.saveState).toEqual({ kind: "saved", revision: 1, durable: true, changedSince: false });
  });

  it("확정을 기다리는 편집·불확실한 모델은 저장하지 않는다", async () => {
    const t = await rhwpSession();
    t.editor.typeText("x");
    expect(await t.editor.save()).toEqual({ ok: false, error: { code: "SaveNotReady", reason: "pending" } });
    await flushRhwp();
    t.take("commit").reply(ok(info({ state: "ready", revision: 1, dirty: true, sequence: 3, loadGeneration: 1 })));
    await flushRhwp();
    t.doc.failNext = true;
    t.editor.typeText("y"); // 엔진 예외: 모델을 믿을 수 없음
    await flushRhwp();
    const result = await t.editor.save();
    expect(result.ok).toBe(false);
    expect((result as { error: DocumentError }).error.code).toBe("SaveNotReady");
    expect(t.calls.some((call) => call.method === "original" || call.method === "save")).toBe(false);
  });

  it("사전 검사가 unsafe면 저장 요청을 보내지 않는다", async () => {
    const t = await rhwpSession();
    const saving = t.editor.save();
    t.take("original").reply(ok(new Uint8Array([1])));
    await flushRhwp();
    const preservation = { outcome: "unsafe" as const, findings: [{ code: "partChanged" as const, part: "Contents/section0.xml" }] };
    t.take("preflight").reply(ok({ preservation, platformSupported: true }));
    expect(await saving).toEqual({ ok: false, error: { code: "UnsafeSave", preservation } });
    expect(t.calls.some((call) => call.method === "save")).toBe(false);
  });
});

describe("저장 단추와 결과", () => {
  const view = (state: SaveState, check: SaveCheck | null = null) => {
    const editor: SaveEditor = {
      saveState: state,
      saveCheck: check ? { generation: 1, check } : null,
      save: async () => ({ ok: false, error: { code: "Internal" } }) as Result<SaveOutcome>,
      checkSave: async () => ({ ok: false, error: { code: "Internal" } }) as Result<SaveCheck>,
    };
    return render(
      <LanguageProvider language="ko" onLanguageChange={() => {}}>
        <SaveControls editor={editor} prefix="docx" />
      </LanguageProvider>,
    );
  };

  it("막힌 저장은 이유와 부분 이름을 보이고 원본이 그대로라고 알린다", () => {
    const preservation = { outcome: "unsafe" as const, findings: [{ code: "partMissing" as const, part: "customXml/item1.xml" }, { code: "reopenMismatch" as const }] };
    const t = view({ kind: "failed", error: { code: "UnsafeSave", preservation } });
    const result = t.getByTestId("docx-save-result");
    expect(result.dataset).toMatchObject({ state: "failed", outcome: "unsafe", error: "UnsafeSave", findings: "partMissing:customXml/item1.xml,reopenMismatch" });
    expect(result.textContent).toContain("저장하지 않았습니다");
    expect(result.textContent).toContain("원본 파일은 바뀌지 않았습니다");
    expect(t.getByTestId("save-findings").textContent).toContain("customXml/item1.xml: 저장하면 사라집니다.");
  });

  it("사전 검사만 한 상태에서도 막히는 형식이면 이유를 보이고, 저장한 뒤의 편집이 있으면 알린다", () => {
    const blocked = view({ kind: "idle" }, { preservation: { outcome: "unknown", findings: [{ code: "unsupported", part: "FileHeader" }] }, platformSupported: true });
    expect(blocked.getByTestId("docx-save-result").dataset).toMatchObject({ state: "idle", outcome: "unknown", error: "UnsafeSave" });
    blocked.unmount();
    const saved = view({ kind: "saved", revision: 3, durable: false, changedSince: true });
    const text = saved.getByTestId("docx-save-result").textContent;
    expect(text).toContain("저장했습니다(판 3)");
    expect(text).toContain("저장한 뒤의 편집은 아직 저장하지 않았습니다");
    expect(text).toContain("디렉터리 동기화");
    saved.unmount();
    const io = view({ kind: "failed", error: { code: "SaveFailure", stage: "write", io: "storage-full" } });
    expect(io.getByTestId("docx-save-result").textContent).toContain("저장 공간이 부족합니다");
    act(() => {});
  });
});
