// 작업 공간·편집 영역에서 DOCX 세션(T008): 열면 백엔드 엔진에 불러오고, 미보존 편집 보호와 패널 진단·검사를 보인다.
import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DocumentBackend } from "../../../adapters/backend";
import type { Result, SessionInfo } from "../../../adapters/contract";
import { DocumentSessions } from "../../../adapters/sessions";
import { LanguageProvider } from "../../../language/LanguageContext";
import { DocumentWorkspace } from "../documentWorkspace";
import { Editor } from "../Editor";
import type { FilePort } from "../filePort";
import { DocxEditorSession } from "./DocxEditorSession";
import { decodeFake, docxInfo, FakeDocx, flush } from "./testing";

function workspace(filePort?: FilePort, openResult?: Result<SessionInfo>) {
  const fake = new FakeDocx();
  const ok = <T,>(value: T): Promise<Result<T>> => Promise.resolve({ ok: true, value });
  const backend = {
    open: () => Promise.resolve(openResult ?? { ok: true, value: { ...fake.info } }),
    session: () => ok({ ...fake.info }),
    sessions: () => ok([]),
    close: (sessionId: number) => ok({ sessionId, alreadyClosed: false }),
  } as unknown as DocumentBackend;
  const sessions = new DocumentSessions(backend);
  const space = new DocumentWorkspace(sessions, backend, undefined, undefined, fake, decodeFake, filePort);
  return { fake, sessions, space };
}

describe("DOCX 작업 공간", () => {
  it("offers native file workflow controls and routes Save As for the active session", async () => {
    const { space } = workspace();
    const fileActions = { busy: false, open: vi.fn(), newDocument: vi.fn(), saveAs: vi.fn() };
    const view = render(
      <LanguageProvider language="ko" onLanguageChange={() => {}}>
        <Editor zoom={100} workspace={space} fileActions={fileActions} />
      </LanguageProvider>,
    );
    await act(async () => {
      await space.open("/a.docx");
      await flush();
    });
    fireEvent.click(view.getByTestId("document-open-dialog"));
    fireEvent.click(view.getByTestId("document-new-docx"));
    fireEvent.click(view.getByTestId("docx-save-as"));
    expect(fileActions.open).toHaveBeenCalledOnce();
    expect(fileActions.newDocument).toHaveBeenCalledOnce();
    expect(fileActions.saveAs).toHaveBeenCalledWith(1);
  });

  it("native Open cancellation leaves the session list and selection unchanged", async () => {
    const filePort: FilePort = {
      chooseFile: async () => ({ ok: true, value: null }),
      createDocx: async () => ({ ok: false, error: { code: "Protocol" } }),
    };
    const { space, sessions } = workspace(filePort);
    expect(await space.openDialog({ title: "Open", accept: "Open", cancel: "Cancel" })).toBeNull();
    expect(sessions.snapshot()).toEqual({ sessions: [], activeId: null });
    expect(space.fileBusy).toBe(false);
  });

  it("native Open routes unsupported extensions through backend validation without adopting a session", async () => {
    const filePort: FilePort = {
      chooseFile: async () => ({ ok: true, value: "/docs/unsupported.rtf" }),
      createDocx: async () => ({ ok: false, error: { code: "Protocol" } }),
    };
    const { space, sessions } = workspace(filePort, { ok: false, error: { code: "UnsupportedFormat", kind: "extension" } });
    expect(await space.openDialog({ title: "Open", accept: "Open", cancel: "Cancel" }))
      .toEqual({ ok: false, error: { code: "UnsupportedFormat", kind: "extension" } });
    expect(sessions.snapshot()).toEqual({ sessions: [], activeId: null });
  });

  it("New DOCX adopts the backend-created session and loads its WordCraft model", async () => {
    const created = docxInfo({ sessionId: 2, displayName: "new.docx" });
    const fake = new FakeDocx();
    fake.info = created;
    const filePort: FilePort = {
      chooseFile: async (request) => {
        expect(request).toMatchObject({ mode: "save", format: "docx" });
        return { ok: true, value: "/docs/new.docx" };
      },
      createDocx: async (path) => {
        expect(path).toBe("/docs/new.docx");
        return { ok: true, value: created };
      },
    };
    const ok = <T,>(value: T): Promise<Result<T>> => Promise.resolve({ ok: true, value });
    const backend = {
      open: () => ok(created), session: () => ok(created), sessions: () => ok([created]),
      close: (sessionId: number) => ok({ sessionId, alreadyClosed: false }),
    } as unknown as DocumentBackend;
    const sessions = new DocumentSessions(backend);
    const space = new DocumentWorkspace(sessions, backend, undefined, undefined, fake, decodeFake, filePort);
    const result = await space.newDocx({ title: "New", accept: "Create", cancel: "Cancel" });
    await flush();
    expect(result).toEqual({ ok: true, value: created });
    expect(sessions.snapshot()).toMatchObject({ sessions: [{ sessionId: 2, state: "ready", loadGeneration: 1 }], activeId: 2 });
    expect(space.docxEditorFor(2)?.status.kind).toBe("ready");
    expect(fake.calls.filter((call) => call.method === "load")).toHaveLength(1);
  });

  it("Save As sends the selected destination through the normal save guard and preserves dirty state on conflict", async () => {
    const filePort: FilePort = {
      chooseFile: async (request) => {
        expect(request).toMatchObject({ mode: "save", format: "docx" });
        return { ok: true, value: "/docs/already-exists.docx" };
      },
      createDocx: async () => ({ ok: false, error: { code: "Protocol" } }),
    };
    const { fake, space, sessions } = workspace(filePort);
    await space.open("/docs/source.docx");
    await flush();
    const editor = space.docxEditorFor(1)!;
    editor.typeText("!");
    await flush();
    fake.saveError = { code: "FileConflict" };
    const result = await space.saveAs(1, { title: "Save As", accept: "Save", cancel: "Cancel" });
    expect(result).toEqual({ ok: false, error: { code: "FileConflict" } });
    expect(editor.saveState).toMatchObject({ kind: "failed", error: { code: "FileConflict" } });
    expect(sessions.get(1)?.dirty).toBe(true);
  });

  it("Save As cancellation preserves dirty edits and successful publication keeps the session for later normal saves", async () => {
    const destinations: (string | undefined)[] = [];
    const selectedDestination: { value: string | null } = { value: null };
    const filePort: FilePort = {
      chooseFile: async () => ({ ok: true, value: selectedDestination.value }),
      createDocx: async () => ({ ok: false, error: { code: "Protocol" } }),
    };
    const { fake, space, sessions } = workspace(filePort);
    await space.open("/docs/source.docx");
    await flush();
    const editor = space.docxEditorFor(1)!;
    editor.typeText("!");
    await flush();
    expect(await space.saveAs(1, { title: "Save As", accept: "Save", cancel: "Cancel" })).toBeNull();
    expect(sessions.get(1)?.dirty).toBe(true);
    expect(fake.calls.some((call) => call.method === "save")).toBe(false);

    const save = fake.save.bind(fake);
    fake.save = ((sessionId: number, generation: number, revision: number, destination?: string) => {
      destinations.push(destination);
      return save(sessionId, generation, revision);
    }) as typeof fake.save;
    selectedDestination.value = "/docs/new-name.docx";
    expect((await space.saveAs(1, { title: "Save As", accept: "Save", cancel: "Cancel" }))?.ok).toBe(true);
    expect(destinations).toEqual(["/docs/new-name.docx"]);
    expect(sessions.get(1)?.sessionId).toBe(1);
    expect(sessions.get(1)?.dirty).toBe(false);
    editor.typeText("?");
    await flush();
    expect((await editor.save()).ok).toBe(true);
    expect(destinations).toEqual(["/docs/new-name.docx", undefined]);
  });

  it("열면 WordCraft 편집 세션으로 불러오고, 미보존 편집은 버리기 확인 없이 닫지 않는다", async () => {
    const { fake, space, sessions } = workspace();
    await space.open("/a.docx");
    await flush();
    const editor = space.docxEditorFor(1)!;
    expect(editor).toBeInstanceOf(DocxEditorSession);
    expect(space.editorFor(1)).toBeNull(); // rhwp 편집 세션이 아님
    expect(editor.status.kind).toBe("ready");
    editor.typeText("가");
    await flush();
    expect(space.hasUnpreservedChanges).toBe(true);
    expect(await space.close(1)).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    expect((await space.close(1, { discard: true })).ok).toBe(true);
    expect(sessions.get(1)).toBeNull();
    expect(editor.status.kind).toBe("closed");
    expect(fake.calls.filter((call) => call.method === "load")).toHaveLength(1);
  });

  it("편집 영역: 상태·진단 속성과 메모리 왕복 검사 결과를 보인다", async () => {
    const { space } = workspace();
    const view = render(
      <LanguageProvider language="ko" onLanguageChange={() => {}}>
        <Editor zoom={100} workspace={space} />
      </LanguageProvider>,
    );
    await act(async () => {
      await space.open("/a.docx");
      await flush();
    });
    const status = view.getByTestId("docx-status");
    expect(status.dataset.status).toBe("ready");
    expect(status.dataset.revision).toBe("0");
    expect(status.dataset.caret).toBe("body:0:0");
    // 검사 훅이 없는 빌드에서는 문서 글자를 화면 속성에 넣지 않는다.
    expect(status.dataset.paragraphText).toBeUndefined();
    await act(async () => {
      fireEvent.click(view.getByTestId("docx-roundtrip"));
      await flush();
    });
    expect(view.getByTestId("docx-roundtrip-result").dataset.passed).toBe("true");
    expect(view.container.querySelector(".docx-page")).not.toBeNull();
  });
});
