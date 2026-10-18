// 작업 공간·편집 영역에서 DOCX 세션(T008): 열면 백엔드 엔진에 불러오고, 미보존 편집 보호와 패널 진단·검사를 보인다.
import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DocumentBackend } from "../../../adapters/backend";
import type { Result } from "../../../adapters/contract";
import { DocumentSessions } from "../../../adapters/sessions";
import { LanguageProvider } from "../../../language/LanguageContext";
import { DocumentWorkspace } from "../documentWorkspace";
import { Editor } from "../Editor";
import { DocxEditorSession } from "./DocxEditorSession";
import { decodeFake, FakeDocx, flush } from "./testing";

function workspace() {
  const fake = new FakeDocx();
  const ok = <T,>(value: T): Promise<Result<T>> => Promise.resolve({ ok: true, value });
  const backend = {
    open: () => ok({ ...fake.info }),
    session: () => ok({ ...fake.info }),
    sessions: () => ok([]),
    close: (sessionId: number) => ok({ sessionId, alreadyClosed: false }),
  } as unknown as DocumentBackend;
  const sessions = new DocumentSessions(backend);
  const space = new DocumentWorkspace(sessions, backend, undefined, undefined, fake, decodeFake);
  return { fake, sessions, space };
}

describe("DOCX 작업 공간", () => {
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
