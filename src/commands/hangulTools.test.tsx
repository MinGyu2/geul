// T012 한글 도구(장평·자간·표 계산) 명령 경계. 편집 세션(RhwpEditorSession)은 실제 코드이고 rhwp 문서는 가짜(FakeDocument +
// 아래 표·글자 모양 흉내)다: 가짜의 계산·글자 모양은 엔진 동작의 증거가 아니다(실제 WASM은 tests/integration/rhwp/hangul-tools
// 시험, 저장 보존은 Rust 시험). 여기서 확인하는 것은 값 검증, 가용성·이유, 제품 빌드 관문, 읽기 전용 계산이 문서·revision을 바꾸지
// 않음, 조합·모달·낡은 요청에서 아무것도 바꾸지 않음이다.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocumentSessions } from "../adapters/sessions";
import { initialLayout } from "../hooks/layoutState";
import type { Message } from "../language";
import { CommandInputDialog, columnLetters } from "../components/Editor/CommandInputDialog";
import { RhwpEditorSession } from "../components/Editor/rhwp/RhwpEditorSession";
import type { RhwpDocument, RhwpModule } from "../components/Editor/rhwp/rhwpModule";
import {
  base, controlledBackend, FakeDocument, FIXED_MEMORY_BYTES, flush, info, loaded, ok,
} from "../components/Editor/rhwp/testing";
import { LanguageProvider } from "../language/LanguageContext";
import { commandState, executeCommand, type CommandContext, type CommandInputRequest } from "./commands";
import { formulaProblem, formulaReadsOwnCell, parsePercent, validateCommandArgs } from "./parameters";
import { commandDefinition } from "./registry";
import type { DocumentCommandTarget } from "./target";

/** 표 하나(문단 0의 컨트롤 0, 2×2, 셀 값 1·2 / 3·4)와 글자 모양을 흉내 낸 가짜 문서. */
class TableDocument extends FakeDocument {
  cells = [["1", "2"], ["3", "4"]];
  ratios = 100;
  spacings = 0;
  formulaCalls: unknown[][] = [];
  shapeCalls: unknown[][] = [];
  trap = false;
  getTableDimensions() { return JSON.stringify({ rowCount: 2, colCount: 2, cellCount: 4 }); }
  getCellInfo(_s: number, _pp: number, _c: number, cell: number) {
    if (cell > 3) throw new Error("셀 인덱스 범위 초과");
    return JSON.stringify({ row: Math.floor(cell / 2), col: cell % 2, rowSpan: 1, colSpan: 1 });
  }
  getCharPropertiesAt() {
    return JSON.stringify({ bold: false, italic: false, underline: false, strikethrough: false,
      ratios: Array(7).fill(this.ratios), spacings: Array(7).fill(this.spacings) });
  }
  compactCalls: number[] = [];
  /** 정리 흉내(T012 Stage 5): 기준 수를 기록하고 바뀐 것 없음을 돌려준다. */
  charShapeCount() { return 4; }
  compactAppendedCharShapes(baseline: number) {
    this.compactCalls.push(baseline);
    return JSON.stringify({ ok: true, before: 5, after: 5, skipped: null });
  }
  applyCharFormat(...args: unknown[]) {
    this.shapeCalls.push(args);
    const props = JSON.parse(args[4] as string) as { ratios?: number[]; spacings?: number[] };
    if (props.ratios) this.ratios = props.ratios[0]!;
    if (props.spacings) this.spacings = props.spacings[0]!;
    return '{"ok":true}';
  }
  /** 고정 rhwp `evaluate_table_formula` 흉내: SUM(범위)와 나눗셈만, 0으로 나누면 오류. writeResult=false만 받는다. */
  evaluateTableFormula(...args: unknown[]) {
    this.formulaCalls.push(args);
    if (this.trap) throw new WebAssembly.RuntimeError("unreachable");
    const [, , , , , formula, write] = args as [number, number, number, number, number, string, boolean];
    if (write) throw new Error("write not expected");
    if (formula.includes("/0")) throw new Error("계산식 오류: 0으로 나눌 수 없음");
    const total = this.cells.flat().map(Number).reduce((a, b) => a + b, 0);
    return JSON.stringify({ ok: true, result: formula.includes("SUM") ? total : 2.5, formula });
  }
}

async function ready(format: "hwp" | "hwpx", options: { history?: boolean; format?: boolean } = {}) {
  const { backend, calls, take } = controlledBackend();
  const sessions = new DocumentSessions(backend);
  const opening = sessions.open(`/a.${format}`);
  take("open").reply(ok({ ...base, format }));
  await opening;
  const doc = new TableDocument(["가나다라", "abc"]);
  doc.format = format;
  const module: RhwpModule = { openDocument: () => doc as unknown as RhwpDocument, memoryBytes: () => FIXED_MEMORY_BYTES };
  const editor = new RhwpEditorSession(1, backend, sessions, async () => module, options);
  const loading = editor.load();
  take("load").reply(loaded());
  await flush();
  take("session").reply(ok(info({ format, state: "loading", sequence: 1, loadGeneration: 1 })));
  take("setState").reply(ok(info({ format, state: "ready", sequence: 2, loadGeneration: 1 })));
  await loading;
  return { editor, doc, sessions, calls, take };
}

const CELL = { parentParagraph: 0, control: 0, cell: 3, cellParagraph: 0 };

function contextFor(document: DocumentCommandTarget | null, requests: CommandInputRequest[] = []) {
  const notices: Message[] = [];
  const context: CommandContext = {
    layout: initialLayout, dispatch: () => {}, notify: (message) => notices.push(message), document,
    requestInput: (request) => requests.push(request),
  };
  return { context, notices, requests };
}

describe("값 검증(src/commands/parameters.ts)", () => {
  it("장평 50–200·자간 −50–50 정수만 받고, 범위 밖·소수·여분 필드는 말없이 고치지 않고 거부한다", () => {
    expect(validateCommandArgs("hangul.charWidth", { command: "hangul.charWidth", percent: 50 }, {})).toBe(true);
    expect(validateCommandArgs("hangul.charWidth", { command: "hangul.charWidth", percent: 200 }, {})).toBe(true);
    for (const percent of [49, 201, 100.5, Number.NaN, "100", -0.1]) {
      expect(validateCommandArgs("hangul.charWidth", { command: "hangul.charWidth", percent }, {}), String(percent)).toBe(false);
    }
    expect(validateCommandArgs("hangul.charSpacing", { command: "hangul.charSpacing", percent: -50 }, {})).toBe(true);
    expect(validateCommandArgs("hangul.charSpacing", { command: "hangul.charSpacing", percent: 51 }, {})).toBe(false);
    expect(validateCommandArgs("hangul.charSpacing", { command: "hangul.charSpacing", percent: 10, extra: 1 }, {})).toBe(false);
    expect(validateCommandArgs("hangul.charSpacing", { command: "hangul.charWidth", percent: 10 }, {})).toBe(false);
    expect(validateCommandArgs("hangul.charWidth", null, {})).toBe(false);
    expect(parsePercent(" 120 ")).toBe(120);
    expect(parsePercent("-5")).toBe(-5);
    for (const text of ["", "1.5", "1e2", "abc", "12345"]) expect(parsePercent(text), text).toBeNull();
  });

  it("표 계산식: 길이·글자·괄호 깊이·함수 이름·표 밖 참조를 엔진에 넘기기 전에 거부한다", () => {
    const table = { rows: 2, cols: 2 };
    for (const formula of ["=SUM(A1:B2)", "A1+B2*2", "=avg(left)", "@SUM(?1:?2)", "=(A1+B1)/2", "=ROUND(A1)"]) {
      expect(formulaProblem(formula, table), formula).toBeNull();
    }
    expect(formulaProblem("", table)).toBe("empty");
    expect(formulaProblem("=", table)).toBe("empty");
    expect(formulaProblem(`=${"1+".repeat(200)}1`, table)).toBe("tooLong");
    expect(formulaProblem("=A1;B1", table)).toBe("characters");
    expect(formulaProblem("=가1", table)).toBe("characters");
    expect(formulaProblem(`=${"(".repeat(17)}1${")".repeat(17)}`, table)).toBe("depth");
    expect(formulaProblem("=SUM(A1:B2", table)).toBe("syntax");
    for (const formula of ["=ROUND(A1,2)", "=LOG(A1,2)", "=SUM", "=SUM()", "=SUM(A1,,B1)", "=1+", "=A1:", "=SUM(1.2.3)", "=SUM(A1:B1)2"]) {
      expect(formulaProblem(formula, table), formula).toBe("syntax");
    }
    expect(formulaProblem("=NOPE(A1)", table)).toBe("syntax");
    expect(formulaProblem("=FOO", table)).toBe("syntax");
    expect(formulaProblem("=C1", table)).toBe("reference");
    expect(formulaProblem("=A3", table)).toBe("reference");
    expect(formulaProblem("=A0", table)).toBe("reference");
    expect(formulaProblem("=SUM(A1:ZZZ999999)", table)).toBe("reference");
    expect(validateCommandArgs("hangul.tableFormula", { command: "hangul.tableFormula", formula: "=A1" }, {})).toBe(false);
    // Persistent fields must not read their own result cell; the read-only calculation may.
    const b1 = { row: 0, col: 1, rows: 2, cols: 2 };
    for (const formula of ["=B1", "=b1+1", "=SUM(A1:B1)", "=SUM(B2:B1)", "=SUM(A1 : B2)", "=?1", "=B?", "=??", "=SUM(A?:B?)"]) {
      expect(formulaReadsOwnCell(formula, b1), formula).toBe(true);
      expect(validateCommandArgs("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula }, { tableCell: b1 }), formula).toBe(false);
    }
    expect(validateCommandArgs("hangul.tableFormula", { command: "hangul.tableFormula", formula: "=SUM(A1:B1)" }, { tableCell: b1 })).toBe(true);
    for (const formula of ["=A1", "=SUM(A1:A2)", "=SUM(A2:B2)", "=SUM(LEFT)", "=SUM(RIGHT)+SUM(BELOW)", "=A?", "=?2", "=ABS(A1)", "=2"]) {
      expect(formulaReadsOwnCell(formula, b1), formula).toBe(false);
      expect(validateCommandArgs("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula }, { tableCell: b1 }), formula).toBe(true);
    }
    expect(formulaReadsOwnCell("=LOG10(A1)", b1)).toBe(false);
    // Function names and longer identifiers must never be split into cell references.
    expect(formulaReadsOwnCell("=LOG10(A1)", { row: 9, col: 8508 })).toBe(false);
    for (const formula of ["=XB1", "=B1_OTHER", "=UNKNOWN_B1(A1)"]) {
      expect(formulaReadsOwnCell(formula, b1), formula).toBe(false);
    }
    for (const formula of ["=B1_OTHER", "=B1:", "=B0", "=C1", "=A3"]) {
      expect(validateCommandArgs("hangul.insertTableFormula", { command: "hangul.insertTableFormula", formula }, { tableCell: b1 }), formula).toBe(false);
    }
    expect(columnLetters(0)).toBe("A");
    expect(columnLetters(26)).toBe("AA");
  });

  it("recognizes LOG10 calls before cell-shaped identifiers without loosening grammar", () => {
    const table = { rows: 2, cols: 2 };
    for (const formula of ["=LOG10(100)", "=LOG10(A1)", "=log10(100)", "=LOG(100)", "=SUM(A1:B1)", "=A1"]) {
      expect(formulaProblem(formula, table), formula).toBeNull();
    }
    for (const formula of ["=LOG10(", "=LOG10()", "=LOG10(A1", "=LOG10(A1,B1)", "=NOPE(100)"]) {
      expect(formulaProblem(formula, table), formula).toBe("syntax");
    }
    expect(formulaProblem("=LOG10", table)).toBe("reference");
    expect(formulaProblem(`=LOG10(${"(".repeat(16)}100${")".repeat(16)})`, table)).toBe("depth");
    expect(formulaProblem("=LOG10(SUM(LEFT,RIGHT,A1))", { rows: 1, cols: 2048 })).toBe("cost");
  });
});

describe("레지스트리", () => {
  it("rhwp 고급 명령은 지원하고 WordCraft에는 연결하지 않는다", () => {
    for (const id of ["hangul.charWidth", "hangul.charSpacing", "hangul.insertTableFormula"]) {
      expect(commandDefinition(id)).toMatchObject({ kind: "document", engines: { rhwp: { level: "supported" }, wordcraft: { level: "unsupported" } } });
    }
    expect(commandDefinition("hangul.tableFormula")).toMatchObject({ kind: "document", engines: { rhwp: { level: "supported" }, wordcraft: { level: "unsupported" } } });
    expect(commandDefinition("hangul.charWidth")?.shortcuts).toBeUndefined();
  });
});

describe("rhwp 세션의 장평·자간", () => {
  it("controlled 세션 경계: 명령이 입력을 받고, 확인한 장평을 한 번 적용해 revision을 확정한다", async () => {
    const { editor, doc, take } = await ready("hwpx", { history: true, format: true });
    editor.anchor = { section: 0, paragraph: 0, offset: 0 };
    editor.caret = { section: 0, paragraph: 0, offset: 2 };
    // 가짜 문서·선형 메모리로 제어하는 세션 경계 시험이며, 실제 WASM 동작의 증거는 아니다.
    expect(editor.snapshot().parameters?.["hangul.charWidth"]).toEqual({ charShape: { width: 100, spacing: 0 } });
    const { context, notices, requests } = contextFor(editor);
    expect(commandState("hangul.charWidth", context)).toEqual({ available: true });
    expect(executeCommand("hangul.charWidth", undefined, context)).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ command: "hangul.charWidth", sessionId: 1, loadGeneration: 1, revision: 0,
      context: { charShape: { width: 100, spacing: 0 } } });
    expect(doc.shapeCalls).toEqual([]);
    expect(editor.snapshot()).toMatchObject({ revision: 0, pending: false, history: { undo: false, redo: false } });

    expect(executeCommand("hangul.charWidth", undefined, context, { command: "hangul.charWidth", percent: 120 })).toBe(true);
    expect(doc.shapeCalls).toHaveLength(1);
    expect(JSON.parse(doc.shapeCalls[0]![4] as string)).toEqual({ ratios: Array(7).fill(120) });
    expect(doc.ratios).toBe(120);
    expect(editor.snapshot()).toMatchObject({ revision: 0, pending: true, history: { undo: true, redo: false } });
    const commit = take("commit");
    expect(commit.args).toEqual([1, 1, 0, 1]);
    commit.reply(ok(info({ state: "ready", sequence: 3, revision: 1, dirty: true })));
    await flush();
    expect(editor.snapshot()).toMatchObject({ revision: 1, pending: false, history: { undo: true, redo: false } });
    expect(notices).toEqual([]);
  });

  it("문맥: HWPX·기록·한 문단 선택일 때만 값이 있고, 선택 없음·여러 문단은 selectionRequired, HWP·기록 없음은 문맥 없음", async () => {
    const hwpx = await ready("hwpx", { history: true, format: true });
    expect(hwpx.editor.snapshot().parameterReasons?.["hangul.charWidth"]).toBe("selectionRequired");
    hwpx.editor.anchor = { section: 0, paragraph: 0, offset: 1 };
    hwpx.editor.caret = { section: 0, paragraph: 1, offset: 1 };
    expect(hwpx.editor.snapshot().parameters?.["hangul.charWidth"]).toBeUndefined();
    expect(hwpx.editor.snapshot().parameterReasons?.["hangul.charSpacing"]).toBe("selectionRequired");
    hwpx.editor.caret = { section: 0, paragraph: 0, offset: 3 };
    expect(hwpx.editor.snapshot().parameters?.["hangul.charSpacing"]).toEqual({ charShape: { width: 100, spacing: 0 } });
    hwpx.editor.beginComposition();
    hwpx.editor.updateComposition("한");
    expect(hwpx.editor.snapshot().parameters?.["hangul.charSpacing"]).toBeUndefined();

    // HWP: 엔진이 덧붙인 글자 모양 정리를 지원하면 문맥이 있다(T012 Stage 5).
    const hwp = await ready("hwp", { history: true, format: true });
    hwp.editor.anchor = { section: 0, paragraph: 0, offset: 0 };
    hwp.editor.caret = { section: 0, paragraph: 0, offset: 2 };
    expect(hwp.editor.snapshot().parameters?.["hangul.charWidth"]).toEqual({ charShape: { width: 100, spacing: 0 } });
    const legacy = await ready("hwp", { history: true, format: true });
    (legacy.doc as unknown as { compactAppendedCharShapes?: unknown }).compactAppendedCharShapes = undefined;
    legacy.editor.anchor = { section: 0, paragraph: 0, offset: 0 };
    legacy.editor.caret = { section: 0, paragraph: 0, offset: 2 };
    expect(legacy.editor.snapshot().parameters?.["hangul.charWidth"], "정리를 모르는 세대의 HWP").toBeUndefined();
    for (const [format, options] of [["hwpx", { history: false, format: true }], ["hwpx", { history: true }]] as const) {
      const { editor } = await ready(format, options);
      editor.anchor = { section: 0, paragraph: 0, offset: 0 };
      editor.caret = { section: 0, paragraph: 0, offset: 2 };
      expect(editor.snapshot().parameters?.["hangul.charWidth"], `${format} ${JSON.stringify(options)}`).toBeUndefined();
    }
  });
});

describe("rhwp 세션의 표 계산(읽기 전용)", () => {
  it("셀 밖은 notInTable. 셀 안이면 입력 창 요청 → 계산 결과를 알리고 문서·revision·기록은 그대로다(writeResult=false)", async () => {
    for (const format of ["hwp", "hwpx"] as const) {
      const { editor, doc, calls } = await ready(format, {});
      const { context, notices, requests } = contextFor(editor);
      expect(commandState("hangul.tableFormula", context)).toEqual({ available: false, reason: "notInTable" });
      expect(executeCommand("hangul.tableFormula", undefined, context)).toBe(false);
      expect(notices.at(-1)?.key).toBe("command.unavailable.notInTable");

      editor.caret = editor.anchor = { section: 0, paragraph: 0, offset: 0, cell: CELL };
      expect(commandState("hangul.tableFormula", context)).toEqual({ available: true });
      expect(executeCommand("hangul.tableFormula", undefined, context)).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ command: "hangul.tableFormula", sessionId: 1, loadGeneration: 1, revision: 0,
        context: { tableCell: { row: 1, col: 1, rows: 2, cols: 2 } } });
      expect(doc.formulaCalls).toEqual([]);

      const before = { text: [...doc.paragraphs], revision: editor.localRevision, version: editor.modelVersion, calls: calls.length };
      expect(executeCommand("hangul.tableFormula", undefined, context, { command: "hangul.tableFormula", formula: "=SUM(A1:B2)" })).toBe(true);
      expect(doc.formulaCalls).toEqual([[0, 0, 0, 1, 1, "=SUM(A1:B2)", false]]);
      expect(notices.at(-1)).toMatchObject({ key: "command.result.tableFormula", vars: { result: "10", formula: "=SUM(A1:B2)" } });
      expect({ text: doc.paragraphs, revision: editor.localRevision, version: editor.modelVersion, calls: calls.length }).toEqual(before);
      expect(editor.hasUnpreservedChanges).toBe(false);

      // 엔진 계산 오류(0으로 나누기): 실패를 알리고 바뀐 것 없음, 편집은 계속 가능.
      expect(executeCommand("hangul.tableFormula", undefined, context, { command: "hangul.tableFormula", formula: "=A1/0" })).toBe(false);
      expect(notices.at(-1)?.key).toBe("command.result.tableFormulaFailed");
      expect(editor.editable).toBe(true);
      // 계약 밖 값(표 밖 참조·거대 범위)은 엔진에 넘기지 않는다.
      for (const formula of ["=C9", "=SUM(A1:ZZZ999999)", "", "=A1;"]) {
        expect(editor.execute("hangul.tableFormula", { command: "hangul.tableFormula", formula })).toEqual({ accepted: false });
      }
      expect(doc.formulaCalls).toHaveLength(2);
      // 다른 명령의 값·값 없는 실행은 거부.
      expect(editor.execute("hangul.tableFormula")).toEqual({ accepted: false });
      expect(editor.execute("hangul.tableFormula", { command: "hangul.charWidth", percent: 100 })).toEqual({ accepted: false });
      expect(doc.formulaCalls).toHaveLength(2);
    }
  });

  it("조합 중·모달에서는 창을 열지도 계산하지도 않는다. WASM trap이면 편집을 멈춘다(모듈 상태를 알 수 없음)", async () => {
    const { editor, doc } = await ready("hwpx", {});
    const { context, notices, requests } = contextFor(editor);
    // 가짜 문서에는 셀 넣기 API가 없어 본문에서 조합한다(조합 검사가 표 문맥보다 먼저다).
    editor.beginComposition();
    editor.updateComposition("한");
    expect(commandState("hangul.tableFormula", context)).toEqual({ available: false, reason: "composing" });
    expect(executeCommand("hangul.tableFormula", undefined, context)).toBe(false);
    expect(editor.execute("hangul.tableFormula", { command: "hangul.tableFormula", formula: "=A1" })).toEqual({ accepted: false });
    expect(notices.at(-1)?.key).toBe("command.unavailable.composing");
    editor.endComposition("한");
    await flush();
    editor.caret = editor.anchor = { section: 0, paragraph: 0, offset: 0, cell: CELL };
    expect(commandState("hangul.tableFormula", { ...context, modal: true })).toEqual({ available: false, reason: "dialogOpen" });
    expect(executeCommand("hangul.tableFormula", undefined, { ...context, modal: true }, { command: "hangul.tableFormula", formula: "=A1" })).toBe(false);
    expect(requests).toEqual([]);
    expect(doc.formulaCalls).toEqual([]);

    doc.trap = true;
    expect(editor.execute("hangul.tableFormula", { command: "hangul.tableFormula", formula: "=A1" })).toEqual({ accepted: false });
    expect(editor.editable).toBe(false);
    expect(commandState("hangul.tableFormula", context).available).toBe(false);
  });
});

describe("입력 창(CommandInputDialog)", () => {
  const request = (command: CommandInputRequest["command"], context: CommandInputRequest["context"]): CommandInputRequest => ({
    command, labelKey: `command.${command}` as CommandInputRequest["labelKey"], sessionId: 1, loadGeneration: 1, revision: 0, context,
  });

  it("장평: 지금 값으로 시작하고, 범위 밖·정수 아님은 창 안에서 알리며 확인하지 않는다. Escape는 취소", () => {
    const confirmed: unknown[] = [];
    let cancelled = 0;
    render(<LanguageProvider language="ko" onLanguageChange={() => {}}><CommandInputDialog request={request("hangul.charWidth", { charShape: { width: 90, spacing: 0 } })}
      onCancel={() => cancelled++} onConfirm={(args) => confirmed.push(args)} /></LanguageProvider>);
    const input = screen.getByTestId("command-input-value") as HTMLInputElement;
    expect(input.value).toBe("90");
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "250" } });
    fireEvent.click(screen.getByTestId("command-input-confirm"));
    expect(screen.getByTestId("command-input-error")).toHaveTextContent("50부터 200 사이의 정수를 입력하세요.");
    fireEvent.change(input, { target: { value: "1.5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("command-input-error")).toHaveTextContent("정수를 입력하세요.");
    expect(confirmed).toEqual([]);
    fireEvent.change(input, { target: { value: "120" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(confirmed).toEqual([{ command: "hangul.charWidth", percent: 120 }]);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(cancelled).toBe(1);
  });

  it("표 계산: 셀 위치를 안내하고, 표 밖 참조는 확인하지 않는다", () => {
    const confirmed: unknown[] = [];
    render(<LanguageProvider language="ko" onLanguageChange={() => {}}><CommandInputDialog request={request("hangul.tableFormula", { tableCell: { row: 1, col: 1, rows: 2, cols: 2 } })}
      onCancel={() => {}} onConfirm={(args) => confirmed.push(args)} /></LanguageProvider>);
    expect(screen.getByTestId("command-input-dialog")).toHaveTextContent("B2 셀 기준");
    const input = screen.getByTestId("command-input-value");
    fireEvent.change(input, { target: { value: "=C1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("command-input-error")).toHaveTextContent("이 표 밖의 셀");
    fireEvent.change(input, { target: { value: " =SUM(A1:B2) " } });
    act(() => { fireEvent.click(screen.getByTestId("command-input-confirm")); });
    expect(confirmed).toEqual([{ command: "hangul.tableFormula", formula: "=SUM(A1:B2)" }]);
  });
});

describe("formula aggregate resource bound", () => {
  it("refuses million-cell expansion before WASM", () => {
    expect(formulaProblem("=SUM(A1:ALL1000)", { rows: 1000, cols: 1000 })).toBe("cost");
  });
});

it("counts repeated, reversed, wildcard, nested ranges and directions conservatively", () => {
  const table = { rows: 32, cols: 32 };
  for (const f of ["=SUM(A1:B2,B2:A1,A?:?2, SUM(A1:B2))", "=SUM(LEFT,RIGHT,ABOVE,BELOW)"]) {
    expect(formulaProblem(f, table)).toBe(f.includes(":") ? "cost" : null);
  }
  expect(formulaProblem("=SUM(A1:B2,A1:B2,A1:B2)", table)).toBeNull();
  expect(formulaProblem("=SUM(LEFT,RIGHT)", { rows: 1, cols: 2048 })).toBeNull();
  expect(formulaProblem("=SUM(LEFT,RIGHT,A1)", { rows: 1, cols: 2048 })).toBe("cost");
  for (const n of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) {
    expect(formulaProblem("=1", { rows: n, cols: 1 })).toBe("reference");
  }
});

it("over-budget formulas never enter the WASM API or change session state", async () => {
  const { editor, doc, sessions } = await ready("hwpx");
  doc.getTableDimensions = () => JSON.stringify({ rowCount: 1000, colCount: 1000, cellCount: 1000000 });
  editor.caret = editor.anchor = { section: 0, paragraph: 0, offset: 0, cell: CELL };
  const before = sessions.get(1);
  expect(editor.execute("hangul.tableFormula", { command: "hangul.tableFormula", formula: "=SUM(A1:ALL1000)" })).toEqual({ accepted: false });
  expect(doc.formulaCalls).toEqual([]);
  expect(sessions.get(1)).toEqual(before);
});

describe("덧붙인 글자 모양 정리(T012 Stage 5)", () => {
  it("서식 적용 뒤 불러온 직후의 글자 모양 수로 정리를 부르고, 계약과 다른 응답은 엔진 오류로 던진다", async () => {
    const { RhwpText } = await import("../components/Editor/rhwp/rhwpText");
    const doc = new TableDocument(["가나다라"]);
    const text = new RhwpText(doc as unknown as RhwpDocument);
    const at = (offset: number) => ({ section: 0, paragraph: 0, offset });
    text.charShapeFormat(at(0), at(2), "ratios", 150);
    text.charShapeFormat(at(0), at(2), "spacings", -10);
    expect(doc.compactCalls).toEqual([4, 4]);
    for (const bad of ['{"ok":false}', '{"ok":true,"before":5,"after":6,"skipped":null}',
      '{"ok":true,"before":5,"after":4}', '{"ok":true,"before":5,"after":4,"skipped":"unknown"}',
      '{"ok":true,"before":5,"after":3,"skipped":null}', '{"ok":true,"before":5,"after":4,"skipped":"dangling"}',
      '{"ok":true,"before":5,"after":4,"skipped":null,"extra":1}', "not json"]) {
      doc.compactAppendedCharShapes = () => bad;
      expect(() => text.charShapeFormat(at(0), at(2), "ratios", 120), bad).toThrow();
    }
    // 기준 수를 알 수 없는 엔진(이전 세대)은 정리를 부르지 않는다.
    const legacy = new TableDocument(["가나다라"]);
    (legacy as unknown as { charShapeCount?: unknown }).charShapeCount = undefined;
    new RhwpText(legacy as unknown as RhwpDocument).charShapeFormat(at(0), at(2), "ratios", 150);
    expect(legacy.compactCalls).toEqual([]);
  });
});

it("rejects malformed persistent formula results before a mutation transaction", async () => {
  const { RhwpText } = await import("../components/Editor/rhwp/rhwpText");
  let value = "3";
  const doc = {
    charShapeCount: () => 4,
    validateTableFormulaField: () => JSON.stringify({ ok: true, changed: true, fieldId: 1, text: value, command: `=1+2??%g,;;${value}` }),
    insertTableFormulaField: () => { throw new Error("validation must not insert"); },
  } as unknown as RhwpDocument;
  const text = new RhwpText(doc);
  const at = { section: 0, paragraph: 0, offset: 0, cell: CELL };
  expect(text.prepareFormula(at, 0, 0, "=1+2")?.text).toBe("3");
  for (const bad of [" ", "\t", "0x10", "Infinity", "NaN", "3 trailing"]) {
    value = bad;
    expect(() => text.prepareFormula(at, 0, 0, "=1+2"), bad).toThrow("formula field response invalid");
  }
});
