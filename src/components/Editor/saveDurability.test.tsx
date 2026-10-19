// T009 3차 안정화 A: 교체는 됐지만 내구성(디렉터리 fsync)을 확인하지 못한 저장 뒤의 보호. 백엔드 SessionRegistry는 이
// 상태를 dirty로 남긴다(unconfirmed). 편집 모델이 바뀌지 않았어도(로컬 modified 없음) 다시 불러오기·탭 닫기·창 닫기는 버리기
// 확인 없이 진행하지 않아야 한다. 가짜 백엔드 응답은 테스트가 직접 준다(실제 교체·fsync 실패는 src-tauri 저장 시험).
import { describe, expect, it } from "vitest";
import type { SaveOutcome, SessionInfo } from "../../adapters/contract";
import { DocumentSessions } from "../../adapters/sessions";
import { DocumentWorkspace } from "./documentWorkspace";
import type { RhwpDocument, RhwpModule } from "./rhwp/rhwpModule";
import { base, controlledBackend, FakeDocument, flush, info, loaded, ok } from "./rhwp/testing";

const hwpx = (patch: Partial<SessionInfo>): SessionInfo => info({ format: "hwpx", displayName: "a.hwpx", ...patch });
const safeCheck = { preservation: { outcome: "safe" as const, findings: [] }, platformSupported: true };

/** HWPX 세션을 연 작업 공간(편집 세션은 작업 공간이 만든다). */
async function hwpxWorkspace() {
  const { backend, calls, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open("/a.hwpx");
  take("open").reply(ok({ ...base, format: "hwpx", displayName: "a.hwpx" }));
  await opening;
  const doc = new FakeDocument(["가나다", "abc"]);
  doc.format = "hwpx";
  let first = true;
  const module: RhwpModule = {
    openDocument: (bytes: Uint8Array) => {
      if (first) {
        first = false;
        return doc as unknown as RhwpDocument;
      }
      // 사전 검사(원본)·다시 열기(내보낸 출력)용 새 문서.
      const exported = bytes.length > 4 && bytes[0] === 0x50;
      const other = new FakeDocument(exported ? new TextDecoder().decode(bytes.subarray(4)).split("\n") : ["가나다", "abc"]);
      other.format = "hwpx";
      return other as unknown as RhwpDocument;
    },
  };
  const workspace = new DocumentWorkspace(sessions, backend, async () => module);
  const editor = workspace.editorFor(1)!;
  const loading = editor.load();
  take("load").reply(loaded());
  await flush();
  take("session").reply(ok(hwpx({ state: "loading", sequence: 1, loadGeneration: 1 })));
  take("setState").reply(ok(hwpx({ state: "ready", sequence: 2, loadGeneration: 1 })));
  await loading;
  return { workspace, editor, sessions, doc, calls, take };
}

type Harness = Awaited<ReturnType<typeof hwpxWorkspace>>;

/** 저장: 원본·사전 검사·저장 응답을 차례로 준다. `session`은 저장 응답의 세션 기록. */
async function save(t: Harness, durable: boolean, session: SessionInfo) {
  const saving = t.editor.save();
  t.take("original").reply(ok(new Uint8Array([1])));
  await flush();
  t.take("preflight").reply(ok(safeCheck));
  await flush();
  t.take("save").reply(ok({ session, bytes: 9, durable } satisfies SaveOutcome));
  const result = await saving;
  expect(result.ok).toBe(true);
}

const loads = (t: Harness) => t.calls.filter((call) => call.method === "load").length;

describe("내구성을 확인하지 못한 저장 뒤의 보호(HWPX)", () => {
  it("편집하지 않은 문서도 다시 불러오기·탭 닫기·창 닫기가 버리기 확인을 요구하고 모델을 그대로 둔다", async () => {
    const t = await hwpxWorkspace();
    // 편집 없이 저장(판 0) → 교체됨·내구성 미확인: 백엔드는 dirty로 남긴다.
    await save(t, false, hwpx({ state: "ready", revision: 0, dirty: true, sequence: 3, loadGeneration: 1 }));
    expect(t.sessions.get(1)?.dirty).toBe(true);
    expect(t.editor.hasUnpreservedChanges).toBe(true);
    expect(await t.editor.load()).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    expect(loads(t)).toBe(0);
    expect(t.doc.freed).toBe(false);
    expect(t.editor.status.kind).toBe("ready");
    expect(await t.workspace.close(1)).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    expect(t.calls.some((call) => call.method === "close")).toBe(false);
    expect(t.workspace.hasUnpreservedChanges).toBe(true); // 창 닫기 요청은 버리기 확인을 띄운다
  });

  it("편집한 문서도 같고, 사용자가 버리기를 확인하면 다시 불러온다", async () => {
    const t = await hwpxWorkspace();
    t.editor.typeText("x");
    await flush();
    t.take("commit").reply(ok(hwpx({ state: "ready", revision: 1, dirty: true, sequence: 3, loadGeneration: 1 })));
    await flush();
    await save(t, false, hwpx({ state: "ready", revision: 1, dirty: true, sequence: 4, loadGeneration: 1 }));
    expect(await t.editor.load()).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    expect(loads(t)).toBe(0);
    const reloading = t.editor.load({ discard: true });
    await flush();
    expect(loads(t)).toBe(1);
    t.take("load").reply(loaded(new Uint8Array([1]), 2));
    await flush();
    t.take("session").reply(ok(hwpx({ state: "loading", revision: 1, dirty: true, sequence: 5, loadGeneration: 2 })));
    t.take("setState").reply(ok(hwpx({ state: "ready", revision: 1, dirty: false, sequence: 6, loadGeneration: 2 })));
    expect((await reloading).ok).toBe(true);
    expect(t.editor.hasUnpreservedChanges).toBe(false);
  });

  it("늦게 온 옛 세션 기록은 보호를 풀지 못하고, 내구성을 확인한 다시 저장 뒤에는 확인 없이 다시 불러올 수 있다", async () => {
    const t = await hwpxWorkspace();
    await save(t, false, hwpx({ state: "ready", revision: 0, dirty: true, sequence: 4, loadGeneration: 1 }));
    // 저장 전에 보낸 요청의 늦은 응답(옛 sequence, dirty false)은 투영을 바꾸지 않는다.
    t.sessions.applyUpdate(hwpx({ state: "ready", revision: 0, dirty: false, sequence: 3, loadGeneration: 1 }));
    expect(t.sessions.get(1)?.dirty).toBe(true);
    expect(await t.editor.load()).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    // 다시 저장: 새 원본으로 다시 검사하고 이번에는 내구성까지 확인.
    await save(t, true, hwpx({ state: "ready", revision: 0, dirty: false, sequence: 5, loadGeneration: 1 }));
    expect(t.editor.hasUnpreservedChanges).toBe(false);
    expect(t.workspace.hasUnpreservedChanges).toBe(false);
    void t.editor.load();
    await flush();
    expect(loads(t)).toBe(1);
  });

  it("내구성을 확인한 저장은 바로 깨끗하다(확인 없이 다시 불러오기·닫기)", async () => {
    const t = await hwpxWorkspace();
    t.editor.typeText("x");
    await flush();
    t.take("commit").reply(ok(hwpx({ state: "ready", revision: 1, dirty: true, sequence: 3, loadGeneration: 1 })));
    await flush();
    await save(t, true, hwpx({ state: "ready", revision: 1, dirty: false, sequence: 4, loadGeneration: 1 }));
    expect(t.editor.hasUnpreservedChanges).toBe(false);
    expect(t.workspace.hasUnpreservedChanges).toBe(false);
    const closing = t.workspace.close(1);
    await flush();
    expect(t.calls.some((call) => call.method === "close")).toBe(true);
    t.take("close").reply(ok({ sessionId: 1, alreadyClosed: false }));
    expect((await closing).ok).toBe(true);
  });
});
