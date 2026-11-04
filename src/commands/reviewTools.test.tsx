// T013 검토·참조 명령 경계. 편집 세션(DocxEditorSession·RhwpEditorSession)은 실제 코드이고 백엔드는 가짜(FakeDocx)다: 가짜의 메모는
// 엔진 동작의 증거가 아니다(엔진·저장 보존은 src-tauri adapters::wordcraft·services::save 시험). 여기서 확인하는 것은 명령이 고정
// DocxOp `comment` 하나로 같은 세션 대기열에 들어가는지, 값·선택·조합·대기·모달에서 아무것도 보내지 않는지, 연결하지 않은 명령이
// 계획 명령으로 남는지다.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialLayout } from "../hooks/layoutState";
import type { Message } from "../language";
import { LanguageProvider } from "../language/LanguageContext";
import { CommandInputDialog } from "../components/Editor/CommandInputDialog";
import { readySession } from "../components/Editor/rhwp/testing";
import { FakeDocx, flush, readyDocx } from "../components/Editor/wordcraft/testing";
import { commandState, executeCommand, type CommandContext, type CommandInputRequest } from "./commands";
import { commentProblem, MAX_COMMENT_CHARS, validateCommandArgs } from "./parameters";
import { commandDefinition } from "./registry";
import type { DocumentCommandTarget } from "./target";

const edits = (fake: FakeDocx) => fake.calls.filter((call) => call.method === "edit").map((call) => call.args[3]);

function contextFor(document: DocumentCommandTarget | null) {
  const notices: Message[] = [];
  const requests: CommandInputRequest[] = [];
  const context: CommandContext = {
    layout: initialLayout, dispatch: () => {}, notify: (message) => notices.push(message), document,
    requestInput: (request) => requests.push(request),
  };
  return { context, notices, requests };
}

describe("레지스트리(T013)", () => {
  it("새 메모만 WordCraft에 연결하고, 각주·미주·목차·변경 내용 추적은 계획 명령으로 남긴다", () => {
    expect(commandDefinition("review.comment")).toMatchObject({ kind: "document", engines: { wordcraft: { level: "supported" }, rhwp: { level: "unsupported" } } });
    for (const id of ["references.toc", "references.footnote", "references.endnote", "review.trackChanges"]) {
      expect(commandDefinition(id)?.kind, id).toBe("planned");
      expect(commandState(id, { layout: initialLayout, document: null })).toEqual({ available: false, reason: "notImplemented" });
    }
  });
});

describe("메모 값 검증", () => {
  it("빈 글·공백만·줄바꿈·탭·제어 문자·개체 글자·상한 초과를 거부한다", () => {
    expect(commentProblem("검토 필요")).toBeNull();
    expect(commentProblem("가".repeat(MAX_COMMENT_CHARS))).toBeNull();
    expect(commentProblem("😀".repeat(MAX_COMMENT_CHARS))).toBeNull();
    expect(commentProblem("")).toBe("empty");
    expect(commentProblem("   ")).toBe("empty");
    expect(commentProblem("a\nb")).toBe("characters");
    expect(commentProblem("a\tb")).toBe("characters");
    expect(commentProblem("a\u0085b")).toBe("characters");
    expect(commentProblem("￼")).toBe("characters");
    expect(commentProblem("가".repeat(MAX_COMMENT_CHARS + 1))).toBe("tooLong");
    expect(validateCommandArgs("review.comment", { command: "review.comment", text: "a" }, {})).toBe(true);
    expect(validateCommandArgs("review.comment", { command: "review.comment", text: "a", author: "x" }, {})).toBe(false);
    expect(validateCommandArgs("review.comment", { command: "review.comment", text: 1 }, {})).toBe(false);
  });
});

describe("WordCraft 세션의 새 메모(가짜 백엔드)", () => {
  it("선택 없음은 selectionRequired. 선택이 있으면 창 요청 → 확인한 글로 comment 연산 하나를 보내고 revision이 는다", async () => {
    const { editor, fake, sessions } = await readyDocx();
    const { context, notices, requests } = contextFor(editor);
    expect(commandState("review.comment", context)).toEqual({ available: false, reason: "selectionRequired" });
    expect(executeCommand("review.comment", undefined, context)).toBe(false);
    expect(notices.at(-1)?.key).toBe("command.unavailable.selectionRequired");

    editor.move("right", true);
    editor.move("right", true);
    await flush();
    expect(commandState("review.comment", context)).toEqual({ available: true });
    const before = edits(fake).length;
    expect(executeCommand("review.comment", undefined, context)).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ command: "review.comment", sessionId: 1, context: {} });
    expect(edits(fake)).toHaveLength(before);

    expect(executeCommand("review.comment", undefined, context, { command: "review.comment", text: "검토 필요" })).toBe(true);
    await flush();
    expect(edits(fake).at(-1)).toEqual([{ op: "comment", text: "검토 필요" }]);
    expect(fake.comments).toHaveLength(1);
    expect(sessions.get(1)).toMatchObject({ revision: 1, dirty: true });
    expect(commandState("edit.undo", context)).toEqual({ available: true });
  });

  it("값이 틀리거나 다른 명령의 값이면 보내지 않는다. 조합 중·보낼 편집이 있는 동안은 창을 열지 않는다", async () => {
    const { editor, fake } = await readyDocx();
    const { context, requests } = contextFor(editor);
    editor.move("right", true);
    await flush();
    const before = edits(fake).length;
    for (const args of [{ command: "review.comment", text: "" }, { command: "review.comment", text: "a\nb" }, { command: "hangul.tableFormula", formula: "=1" }] as const) {
      expect(editor.execute("review.comment", args)).toEqual({ accepted: false });
    }
    expect(editor.execute("review.comment")).toEqual({ accepted: false });
    expect(editor.execute("format.bold", { command: "review.comment", text: "a" })).toEqual({ accepted: false });
    expect(edits(fake)).toHaveLength(before);

    fake.hold = true;
    editor.move("right", true);
    expect(commandState("review.comment", context)).toEqual({ available: false, reason: "pendingEdits" });
    fake.hold = false;
    fake.release();
    await flush();

    editor.beginComposition();
    editor.updateComposition("한");
    expect(commandState("review.comment", context)).toEqual({ available: false, reason: "composing" });
    expect(executeCommand("review.comment", undefined, context)).toBe(false);
    expect(editor.execute("review.comment", { command: "review.comment", text: "a" })).toEqual({ accepted: false });
    expect(commandState("review.comment", { ...context, modal: true })).toEqual({ available: false, reason: "dialogOpen" });
    expect(requests).toEqual([]);
  });

  it("rhwp 세션에는 연결하지 않았다(engineUnsupported, 아무것도 보내지 않음)", async () => {
    const { editor, doc } = await readySession();
    const { context } = contextFor(editor);
    const before = [...doc.paragraphs];
    expect(commandState("review.comment", context)).toEqual({ available: false, reason: "engineUnsupported" });
    expect(editor.execute("review.comment", { command: "review.comment", text: "a" })).toEqual({ accepted: false });
    expect(doc.paragraphs).toEqual(before);
  });
});

describe("메모 입력 창", () => {
  it("빈 칸에서 시작하고 빈 글은 확인하지 않으며 앞뒤 공백을 뺀 글을 넘긴다", () => {
    const confirmed: unknown[] = [];
    const request: CommandInputRequest = { command: "review.comment", labelKey: "command.review.comment", sessionId: 1, loadGeneration: 1, revision: 0, context: {} };
    render(<LanguageProvider language="ko" onLanguageChange={() => {}}><CommandInputDialog request={request} onCancel={() => {}} onConfirm={(args) => confirmed.push(args)} /></LanguageProvider>);
    const input = screen.getByTestId("command-input-value") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(screen.getByTestId("command-input-dialog")).toHaveTextContent("작성자는 \"geul\"로 기록됩니다");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("command-input-error")).toHaveTextContent("메모 내용을 입력하세요.");
    fireEvent.change(input, { target: { value: "  검토 필요  " } });
    fireEvent.click(screen.getByTestId("command-input-confirm"));
    expect(confirmed).toEqual([{ command: "review.comment", text: "검토 필요" }]);
  });
});
