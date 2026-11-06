// 백엔드 저장 Promise가 거부될 때(정상 어댑터는 Result로 바꾸므로 예외적인 전송 실패) 직접 호출과 분리 실행 경로의 책임을 본다.
// 직접 호출(await save())은 원본 거부를 받고, 끝을 기다리지 않는 경로(file.save 명령·저장 단추·다른 이름으로 저장)는 처리되지 않은
// 거부 없이 끝난다. 어느 쪽이든 게시 여부를 모르므로 "원본 유지"나 저장 성공을 말하지 않는다.
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result, SaveOutcome } from "../../../adapters/contract";
import { commandState, executeCommand, type CommandContext } from "../../../commands/commands";
import { initialLayout } from "../../../hooks/layoutState";
import { LanguageProvider } from "../../../language/LanguageContext";
import type { Message } from "../../../language";
import { DocumentWorkspace } from "../documentWorkspace";
import type { FilePort } from "../filePort";
import { SaveControls } from "../SaveControls";
import { flush, info, ok, readySession } from "./testing";

const safeCheck = { preservation: { outcome: "safe" as const, findings: [] }, platformSupported: true };
const PROTOCOL_STATE = { kind: "failed", error: { code: "Protocol" } };
const durable: Result<SaveOutcome> = ok({ session: info({ state: "ready", revision: 0, sequence: 3, loadGeneration: 1 }), bytes: 8, durable: true });

/** 사전 검사까지 통과하고 백엔드 저장만 거부하는 세션. */
async function rejectingSave() {
  const t = await readySession(["본문"], { history: false });
  const rejection = new Error("backend transport");
  const realSave = t.backend.save;
  let rejections = 0;
  t.backend.save = (() => { rejections += 1; return Promise.reject(rejection); }) as typeof t.backend.save;
  const notices: Message[] = [];
  const context: CommandContext = { layout: initialLayout, dispatch: () => {}, notify: (message) => notices.push(message), document: t.editor };
  const passPreflight = async () => {
    await flush();
    t.take("original").reply(ok(new Uint8Array([1])));
    await flush();
    t.take("preflight").reply(ok(safeCheck));
    await flush();
  };
  return { ...t, rejection, realSave, notices, context, passPreflight, rejected: () => rejections };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  process.on("unhandledRejection", onUnhandled);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await flush();
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled.splice(0)).toEqual([]);
  vi.restoreAllMocks();
});

describe("저장 거부의 소유", () => {
  it("직접 await save()는 원본 거부를 받고 상태는 게시 여부를 단정하지 않는다", async () => {
    const t = await rejectingSave();
    const checking = t.editor.checkSave();
    t.take("original").reply(ok(new Uint8Array([1])));
    await flush();
    t.take("preflight").reply(ok(safeCheck));
    await checking;
    expect(t.editor.saveCheck).not.toBeNull();
    await expect(t.editor.save()).rejects.toBe(t.rejection);
    expect(t.editor.saveState).toEqual(PROTOCOL_STATE);
    expect(t.editor.saveTransportErrors).toEqual([t.rejection]);
    expect(t.editor.snapshot().saving).toBe(false);
    // 게시 여부를 모르므로 이전 사전 검사를 다시 쓰지 않는다.
    expect(t.editor.saveCheck).toBeNull();
    expect(consoleError).not.toHaveBeenCalled(); // 호출한 쪽이 책임진다
  });

  it("file.save 명령은 받아들여지고 처리되지 않은 거부 없이 실패 상태로 끝나며 다시 시도할 수 있다", async () => {
    const t = await rejectingSave();
    expect(executeCommand("file.save", undefined, t.context)).toBe(true);
    expect(commandState("file.save", t.context)).toEqual({ available: false, reason: "saving" });
    await t.passPreflight();
    expect(t.rejected()).toBe(1);
    expect(t.editor.saveState).toEqual(PROTOCOL_STATE);
    expect(t.editor.snapshot().saving).toBe(false);
    expect(t.notices).toEqual([]); // 결과는 저장 표시 한 곳에만 보인다
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]).toContain(t.rejection);
    expect(t.editor.status.kind).toBe("ready");
    expect(t.editor.hasUncertainChanges).toBe(false);

    t.backend.save = t.realSave;
    expect(executeCommand("file.save", undefined, t.context)).toBe(true);
    await flush();
    t.take("original").reply(ok(new Uint8Array([1])));
    await flush();
    t.take("preflight").reply(ok(safeCheck));
    await flush();
    t.take("save").reply(durable);
    await flush();
    expect(t.editor.saveState).toMatchObject({ kind: "saved", durable: true });
  });

  it("거부 뒤 편집한 판은 저장되지 않은 채 남는다", async () => {
    const t = await rejectingSave();
    t.editor.typeText("가");
    t.take("commit").reply(ok(info({ state: "ready", revision: 1, dirty: true, sequence: 3, loadGeneration: 1 })));
    await flush();
    expect(executeCommand("file.save", undefined, t.context)).toBe(true);
    await t.passPreflight();
    expect(t.editor.saveState).toEqual(PROTOCOL_STATE);
    expect(t.editor.hasUnpreservedChanges).toBe(true);
    expect(t.sessions.get(1)?.dirty).toBe(true);
    expect(t.editor.localRevision).toBe(1);
  });

  it("닫힌 세션에 늦게 온 거부는 그 세션 상태를 바꾸지 않는다", async () => {
    const t = await rejectingSave();
    let reject!: (reason: unknown) => void;
    t.backend.save = (() => new Promise((_, r) => { reject = r; })) as typeof t.backend.save;
    expect(executeCommand("file.save", undefined, t.context)).toBe(true);
    await t.passPreflight();
    expect(t.editor.saveState).toEqual({ kind: "saving" });
    t.editor.dispose();
    reject(t.rejection);
    await flush();
    expect(t.editor.status).toEqual({ kind: "closed" });
    expect(t.editor.saveState).toEqual({ kind: "saving" }); // 닫힌 세션: 표시하지 않고 그대로 둔다
    expect(t.editor.snapshot().saving).toBe(false);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("저장 단추도 처리되지 않은 거부를 남기지 않고, 오류를 한 번만 보이며 원본 유지라고 말하지 않는다", async () => {
    const t = await rejectingSave();
    const view = render(<LanguageProvider language="ko" onLanguageChange={() => {}}><SaveControls editor={t.editor} prefix="rhwp" /></LanguageProvider>);
    fireEvent.click(screen.getByTestId("rhwp-save"));
    await t.passPreflight();
    view.rerender(<LanguageProvider language="ko" onLanguageChange={() => {}}><SaveControls editor={t.editor} prefix="rhwp" /></LanguageProvider>);
    const result = screen.getByTestId("rhwp-save-result");
    expect(result.getAttribute("data-state")).toBe("failed");
    expect(result.getAttribute("data-error")).toBe("Protocol");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(result.textContent).not.toMatch(/원본|original/i);
    expect((screen.getByTestId("rhwp-save") as HTMLButtonElement).disabled).toBe(false);
    expect(consoleError).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("다른 이름으로 저장은 거부를 Result로 돌려주고 파일 작업을 끝낸다", async () => {
    const t = await rejectingSave();
    const files = { chooseFile: async () => ok("/b.hwp") } as unknown as FilePort;
    const workspace = new DocumentWorkspace(t.sessions, t.backend, async () => ({ openDocument: vi.fn() }), undefined, undefined, undefined, files);
    (workspace as unknown as { editors: Map<number, unknown> }).editors.set(1, t.editor);
    const saving = workspace.saveAs(1, { title: "", accept: "", cancel: "" });
    await t.passPreflight();
    await expect(saving).resolves.toEqual({ ok: false, error: { code: "Protocol" } });
    expect(t.editor.saveState).toEqual(PROTOCOL_STATE);
    expect(workspace.fileBusy).toBe(false);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
