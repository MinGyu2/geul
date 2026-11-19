// DOCX 편집 세션(T008)의 순서·수명주기·IME 계약. 가짜 백엔드(testing.ts)는 Rust 어댑터의 계약을 흉내 낸다.
import { describe, expect, it, vi } from "vitest";
import { documentCommandState } from "../../../commands/capability";
import { executeCommand } from "../../../commands/commands";
import { objectEditRequest } from "../../../commands/objectSelection";
import { initialLayout } from "../../../hooks/layoutState";
import { ImeContext, ImeInput } from "../rhwp/imeInput";
import { DocxEditorSession } from "./DocxEditorSession";
import { decodeFake, docxSessions, FakeDocx, flush, readyDocx, recordingCanvas } from "./testing";

const edits = (fake: FakeDocx) => fake.calls.filter((call) => call.method === "edit");

describe("DocxEditorSession", () => {
  it("불러오면 백엔드가 ready로 전이하고 투영·보기가 맞는다", async () => {
    const { editor, sessions } = await readyDocx();
    expect(editor.status.kind).toBe("ready");
    expect(sessions.get(1)).toMatchObject({ state: "ready", loadGeneration: 1, revision: 0, dirty: false });
    expect(editor.view?.paragraphText).toBe("가나다");
    expect(editor.editable).toBe(true);
  });

  it("요청은 한 번에 하나이고 기다리는 동안의 입력은 다음 요청에 순서대로 묶인다", async () => {
    const { editor, fake, sessions } = await readyDocx();
    fake.hold = true;
    editor.typeText("한");
    editor.typeText("글");
    editor.backspace();
    editor.typeText("국");
    expect(edits(fake)).toHaveLength(1);
    expect(editor.pendingOps).toBe(4);
    fake.release();
    await flush();
    fake.release();
    await flush();
    expect(edits(fake)).toHaveLength(2);
    expect(edits(fake)[1]!.args[2]).toBe(1); // 둘째 요청의 기준 = 첫 응답의 판
    expect(edits(fake)[1]!.args[3]).toEqual([{ op: "insertText", text: "글" }, { op: "backspace" }, { op: "insertText", text: "국" }]);
    expect(fake.paragraphs[0]).toBe("한국가나다");
    expect(sessions.get(1)).toMatchObject({ revision: 4, dirty: true });
    expect(editor.revision).toBe(4);
    expect(editor.busy).toBe(false);
  });

  it("문서를 바꾸지 않은 연산은 revision을 늘리지 않는다(백엔드 판정)", async () => {
    const { editor, sessions } = await readyDocx();
    editor.move("docStart", false);
    editor.backspace(); // 처음의 Backspace
    await flush();
    expect(sessions.get(1)?.revision).toBe(0);
    expect(editor.hasUnpreservedChanges).toBe(false);
  });

  it("끌기의 연속 위치는 마지막 것만 보낸다", async () => {
    const { editor, fake } = await readyDocx();
    fake.hold = true;
    editor.typeText("x");
    editor.pointAt(0, 80, 80, true, true);
    editor.pointAt(0, 90, 80, true, true);
    editor.pointAt(0, 100, 80, true, true);
    fake.release();
    await flush();
    fake.release();
    await flush();
    expect(edits(fake)[1]!.args[3]).toEqual([{ op: "pointer", page: 0, x: 100, y: 80, extend: true, beforeInsert: false, drag: true }]);
  });

  it("IME: 조합 중에는 모델을 바꾸지 않고, 끝에 확정 글자 하나를 연산 하나로 보낸다. 취소는 연산 없음", async () => {
    const { editor, fake, sessions } = await readyDocx();
    const ime = new ImeInput(editor, new ImeContext());
    ime.input("ㅎ", "insertCompositionText", true); // WebKitGTK: compositionstart 없이 시작
    ime.input("하", "insertCompositionText", true);
    ime.input("한", "insertCompositionText", true);
    expect(editor.composing).toBe(true);
    expect(editor.compositionText).toBe("한");
    expect(edits(fake)).toHaveLength(0);
    ime.compositionEnd("한");
    await flush();
    expect(fake.paragraphs[0]).toBe("한가나다");
    expect(sessions.get(1)?.revision).toBe(1);
    ime.keyDown(false);
    ime.compositionStart();
    ime.input("ㄱ", "insertCompositionText", true);
    ime.compositionEnd("");
    await flush();
    expect(edits(fake)).toHaveLength(1);
    expect(editor.composing).toBe(false);
  });

  it("IME: 선택이 있을 때 시작한 조합은 시작할 때 선택을 지운다", async () => {
    const { editor, fake } = await readyDocx();
    editor.move("right", true);
    editor.move("right", true);
    await flush();
    editor.beginComposition();
    editor.updateComposition("마");
    editor.endComposition("마");
    await flush();
    expect(fake.paragraphs[0]).toBe("마다");
  });

  it("조합 중 클릭: 보이던 조합을 원래 자리에 넣고, 클릭은 넣기 전 화면의 좌표로 찾는다. 입력기 최종 글자가 다르면 고친다", async () => {
    const { editor, fake, sessions } = await readyDocx();
    const ime = new ImeInput(editor, new ImeContext());
    ime.input("하", "insertCompositionText", true);
    ime.pointerDown();
    // 넣기 전 화면에서 1번째 문단 '가나다'의 2번째 글자 앞(x = 72 + 20).
    editor.pointAt(0, 92, 80, false);
    await flush();
    expect(fake.paragraphs[0]).toBe("하가나다");
    expect(fake.caret).toEqual({ p: 0, o: 3 }); // 넣은 한 글자만큼 밀림
    expect(edits(fake).flatMap((call) => call.args[3] as unknown[])).toEqual([
      { op: "insertText", text: "하" },
      { op: "pointer", page: 0, x: 92, y: 80, extend: false, beforeInsert: true },
    ]);
    // 입력기의 꼬리: 빈 끝 → 최종 글자 '한'.
    ime.keyDown(true);
    ime.input("", "deleteCompositionText", true);
    ime.compositionEnd("");
    ime.keyDown(true);
    ime.input("한", "insertFromComposition", true);
    ime.compositionEnd("한");
    await flush();
    expect(fake.paragraphs[0]).toBe("한가나다");
    expect(fake.caret).toEqual({ p: 0, o: 3 });
    expect(sessions.get(1)?.revision).toBe(2);
    // 같은 글자로 끝나면 고치지 않는다.
    const before = edits(fake).length;
    ime.keyDown(false);
    ime.input("ㄱ", "insertCompositionText", true);
    ime.pointerDown();
    editor.pointAt(0, 72, 100, false);
    ime.keyDown(true);
    ime.input("", "deleteCompositionText", true);
    ime.compositionEnd("");
    ime.keyDown(true);
    ime.input("ㄱ", "insertFromComposition", true);
    ime.compositionEnd("ㄱ");
    await flush();
    expect(edits(fake).slice(before).flatMap((call) => call.args[3] as unknown[]).some((op) => (op as { op: string }).op === "replaceInserted")).toBe(false);
    expect(fake.paragraphs).toEqual(["한가나ㄱ다", "abc"]);
    expect(fake.caret).toEqual({ p: 1, o: 0 });
  });

  it("미리보기 없는 조합 중 클릭: 클릭 전 커서를 기억하고 늦은 확정을 그 자리에 한 번 넣는다", async () => {
    const { editor, fake } = await readyDocx();
    const ime = new ImeInput(editor, new ImeContext());
    editor.move("right", false);
    ime.pointerDown(); // 조합이 보이지 않음(페이지가 조합 입력을 받지 못한 플랫폼)
    editor.pointAt(0, 72, 100, false); // 둘째 문단 처음
    ime.compositionEnd("글");
    await flush();
    expect(fake.paragraphs).toEqual(["가글나다", "abc"]);
    expect(fake.caret).toEqual({ p: 1, o: 0 });
    expect(edits(fake).flatMap((call) => call.args[3] as { op: string }[]).map((op) => op.op)).toEqual(["move", "mark", "pointer", "insertAt"]);
  });

  it("기대하지 않은 거부는 편집을 멈추고 보내지 못한 입력을 버리며, 다시 불러오기는 버리기 확인 뒤 백엔드가 모델을 새로 읽는다", async () => {
    const { editor, fake, sessions } = await readyDocx();
    editor.typeText("가");
    await flush();
    fake.failNext = { code: "RevisionMismatch", sessionId: 1, revision: 9 };
    editor.typeText("나");
    await flush();
    expect(editor.status).toEqual({ kind: "failed", error: { code: "RevisionMismatch", sessionId: 1, revision: 9 } });
    expect(editor.editable).toBe(false);
    expect(editor.typeText("x")).toBe(false);
    expect(editor.hasUnpreservedChanges).toBe(true); // 확정한 '가'(dirty)
    expect(await editor.load()).toEqual({ ok: false, error: { code: "UnpreservedChanges", sessionId: 1 } });
    const reloaded = await editor.load({ discard: true });
    expect(reloaded.ok).toBe(true);
    expect(fake.calls.filter((call) => call.method === "load").at(-1)!.args).toEqual([1, 1]); // 시도 1의 ready 모델을 버림
    expect(sessions.get(1)).toMatchObject({ state: "ready", loadGeneration: 2, dirty: false });
    expect(fake.paragraphs[0]).toBe("가나다");
    expect(editor.status.kind).toBe("ready");
  });

  it("엔진 실패는 failed와 세션 기록 다시 읽기", async () => {
    const { editor, fake, sessions } = await readyDocx();
    fake.failNext = { code: "EngineFailure", engine: "wordcraft", stage: "edit" };
    editor.typeText("가");
    await flush();
    expect(editor.status.kind).toBe("failed");
    expect(sessions.get(1)?.state).toBe("failed");
    // failed 세션은 버릴 것이 없으면 확인 없이 다시 불러온다(시도 번호 없이).
    expect((await editor.load()).ok).toBe(true);
    expect(fake.calls.filter((call) => call.method === "load").at(-1)!.args).toEqual([1, undefined]);
  });

  it("닫힌 뒤 늦게 온 응답은 무시한다", async () => {
    const { editor, fake } = await readyDocx();
    fake.hold = true;
    editor.typeText("가");
    editor.dispose();
    fake.release();
    await flush();
    expect(editor.status.kind).toBe("closed");
    expect(editor.view).toBeNull();
  });

  it("쪽 그림은 판·배율마다 한 번만 받고, 판이 바뀌면 새로 받는다", async () => {
    const { editor, fake } = await readyDocx();
    const renders = () => fake.calls.filter((call) => call.method === "render");
    editor.requestPages([0], 2);
    editor.requestPages([0], 2);
    await flush();
    expect(renders()).toHaveLength(1);
    expect(editor.isCurrent(0, 2)).toBe(true);
    editor.typeText("가");
    await flush();
    expect(editor.isCurrent(0, 2)).toBe(false);
    expect(editor.pageRevision(0)).toBe(0); // 새 그림 전까지 옛 그림을 보인다
    editor.requestPages([0], 2);
    await flush();
    expect(editor.pageRevision(0)).toBe(1);
    expect(renders()).toHaveLength(2);
    expect(renders()[1]!.args[5]).toBe(0); // 판 0 그림을 기준으로 바뀐 띠만 요청
  });

  it("바뀐 띠는 화면 밖 래스터에 덮고, 화면 canvas에는 보이던 판 뒤의 띠만 옮긴다. 새 canvas는 전체를 옮긴다", async () => {
    const fake = new FakeDocx();
    const sessions = docxSessions(fake);
    await sessions.open("/a.docx");
    const backing = recordingCanvas();
    const editor = new DocxEditorSession(1, fake, sessions, decodeFake, () => backing.canvas);
    await editor.load();
    editor.requestPages([0], 1);
    await flush();
    const screen = recordingCanvas();
    editor.paint(0, screen.canvas);
    expect([screen.canvas.width, screen.canvas.height]).toEqual([816, 1056]);
    expect(screen.draws).toEqual([[backing.canvas, 0, 0]]);
    editor.typeText("가");
    await flush();
    editor.requestPages([0], 1);
    await flush();
    expect(backing.draws.at(-1)!.slice(1)).toEqual([0, 100]); // 띠를 래스터의 y=100에 덮음
    editor.paint(0, screen.canvas);
    expect(screen.draws.at(-1)).toEqual([backing.canvas, 0, 100, 816, 20, 0, 100, 816, 20]);
    editor.paint(0, screen.canvas); // 이미 지금 판
    expect(screen.draws).toHaveLength(2);
    const other = recordingCanvas();
    editor.paint(0, other.canvas);
    expect(other.draws).toEqual([[backing.canvas, 0, 0]]);
    expect(editor.isCurrent(0, 1)).toBe(true);
  });

  it("그림 예산을 넘는 배율은 그리지 않고 편집을 멈추며, 낮추면 이어 간다", async () => {
    const { editor } = await readyDocx();
    expect(editor.setScale(20)).toBe(false);
    expect(editor.renderLimit).toBe(20);
    expect(editor.editable).toBe(false);
    expect(editor.setScale(2)).toBe(true);
    expect(editor.editable).toBe(true);
  });

  it("메모리 왕복 검사 결과는 검사한 판에만 보이고, 보내는 중에는 하지 않는다", async () => {
    const { editor, fake } = await readyDocx();
    expect((await editor.roundTrip()).ok).toBe(true);
    expect(editor.roundTripCurrent).toBe(true);
    editor.typeText("가");
    expect((await editor.roundTrip()).ok).toBe(false); // busy
    await flush();
    expect(editor.roundTripCurrent).toBe(false);
    expect(fake.calls.filter((call) => call.method === "roundTrip")).toHaveLength(1);
  });

  it("WebView를 다시 시작한 뒤 백엔드에 남은 ready 모델에 다시 붙는다", async () => {
    const { fake, sessions } = await readyDocx();
    fake.paragraphs[0] = "남은 편집";
    const fresh = new DocxEditorSession(1, fake, sessions, decodeFake);
    await fresh.resume();
    expect(fresh.status.kind).toBe("ready");
    expect(fresh.view?.paragraphText).toBe("남은 편집");
    expect(fake.calls.filter((call) => call.method === "load")).toHaveLength(1);
  });

  it("reconcile은 WordCraft 세션을 failed로 돌리지 않는다", async () => {
    const fake = new FakeDocx();
    fake.info = { ...fake.info, state: "ready", loadGeneration: 1, sequence: 3 };
    const sessions = docxSessions(fake);
    const result = await sessions.reconcile();
    expect(result.ok && result.value[0]?.state).toBe("ready");
  });

  it("DOCX 표 구조 10개 명령의 가용성·거절 사유·실행 대상 검증을 반영한다", async () => {
    const { documentCommandState } = await import("../../../commands/capability");
    const { editor, fake } = await readyDocx(["본문"]);
    const ALL_TABLE = [
      "table.insertRowAbove", "table.insertRowBelow", "table.insertColumnLeft", "table.insertColumnRight",
      "table.deleteRow", "table.deleteColumn", "table.mergeRight", "table.mergeBelow", "table.mergeCells", "table.splitCell",
    ] as const;
    for (const id of ALL_TABLE) {
      expect(documentCommandState(id, editor.snapshot())).toEqual({ available: false, reason: "notInTable" });
      expect(editor.execute(id).accepted).toBe(false);
    }
    const BASE_FORMAT_FIELDS = {
      hasInsideBorders: false,
      cellShadingRefusal: null,
      cellBordersRefusal: null,
      cellShading: null,
      cellShadingMixed: false,
      hasCellShading: false,
      cellBorders: null,
      supportedBorderStyles: ["single", "double", "dotted", "dashed", "thick", "triple", "dotDash", "wave", "none"],
      cellAlignHorizontal: "left",
      cellAlignHorizontalMixed: false,
      cellAlignVertical: "top",
      cellAlignVerticalMixed: false,
      cellAlignmentRefusal: null,
      colWidth: 100,
      colWidthMixed: false,
      rowHeight: 24,
      rowHeightMixed: false,
      rowHeightRule: "atLeast",
      selectedCols: 1,
      selectedRows: 1,
      columnWidthRefusal: null,
      rowHeightRefusal: null,
      tableCellMargins: { top: 0, right: 5.4, bottom: 0, left: 5.4 },
      cellMargins: { top: 0, right: 5.4, bottom: 0, left: 5.4 },
      cellMarginsMixed: false,
      cellMarginsUsesDefault: true,
      cellMarginsOverrideMixed: false,
      cellMarginsRefusal: null,
      tableAlign: "left",
      tableIndentPt: 0,
      tablePositioningRefusal: null,
      leadingHeaderRows: 0,
      rowHeader: false,
      rowHeaderMixed: false,
      canEnableHeader: true,
      repeatHeaderRefusal: null,
      rowBreakMode: "cell",
      rowBreakMixed: false,
      rowBreakRefusal: null,
    } as const;
    fake.tableView = {
      rows: 2, cols: 2, row: 0, col: 0, rowSpan: 1, colSpan: 1, selectedCells: 1,
      insertRowAbove: null, insertRowBelow: null, insertColumnLeft: null, insertColumnRight: null,
      deleteRow: null, deleteColumn: null, mergeRight: null, mergeBelow: null,
      mergeCells: "tableShape", splitCell: "tableShape", maxSplitRows: 1, maxSplitColumns: 1,
      ...BASE_FORMAT_FIELDS, supportedBorderStyles: [...BASE_FORMAT_FIELDS.supportedBorderStyles],
    };
    await editor.load({ discard: true });
    expect(documentCommandState("table.insertRowBelow", editor.snapshot())).toEqual({ available: true });
    expect(documentCommandState("table.mergeRight", editor.snapshot())).toEqual({ available: true });
    expect(documentCommandState("table.mergeCells", editor.snapshot())).toEqual({ available: false, reason: "tableShape" });
    expect(documentCommandState("table.splitCell", editor.snapshot())).toEqual({ available: false, reason: "tableShape" });
    expect(editor.execute("table.mergeCells").accepted).toBe(false);
    expect(editor.execute("table.insertRowBelow").accepted).toBe(true);
    const editCall = fake.calls.find((c) => c.method === "edit");
    expect(editCall?.args[3]).toEqual([{ op: "tableStructure", action: "insertRowBelow", target: { anchorKey: "body:0:0", caretKey: "body:0:0" } }]);
    // Pending edit blocks table commands until committed.
    expect(documentCommandState("table.insertRowBelow", editor.snapshot())).toEqual({ available: false, reason: "pendingEdits" });
    await flush();
    // Unmerged 1x1 cell with split capacity exposes tableSplit parameter context and requires explicit dims;
    // merged cell executes directly with no parameters.
    fake.tableView = {
      rows: 2, cols: 2, row: 0, col: 0, rowSpan: 1, colSpan: 1, selectedCells: 1,
      insertRowAbove: null, insertRowBelow: null, insertColumnLeft: null, insertColumnRight: null,
      deleteRow: null, deleteColumn: null, mergeRight: null, mergeBelow: null,
      mergeCells: "tableShape", splitCell: null, maxSplitRows: 16, maxSplitColumns: 4,
      ...BASE_FORMAT_FIELDS, supportedBorderStyles: [...BASE_FORMAT_FIELDS.supportedBorderStyles],
    };
    await editor.load({ discard: true });
    expect(documentCommandState("table.splitCell", editor.snapshot())).toEqual({ available: true });
    expect(editor.snapshot().parameters?.["table.splitCell"]).toEqual({ tableSplit: { maxRows: 16, maxColumns: 4 } });
    expect(editor.execute("table.splitCell").accepted).toBe(false);
    expect(editor.execute("table.splitCell", { command: "table.splitCell", rows: 1, columns: 5 }).accepted).toBe(false);
    expect(editor.execute("table.splitCell", { command: "table.splitCell", rows: 1, columns: 3 }).accepted).toBe(true);
    expect(fake.calls.filter((c) => c.method === "edit").pop()?.args[3]).toEqual([
      { op: "tableStructure", action: "splitCell", target: { anchorKey: "body:0:0", caretKey: "body:0:0" }, rows: 1, columns: 3 },
    ]);
    await flush();
    // Merged cell (rowSpan > 1) omits tableSplit parameter context and splits directly without args.
    fake.tableView = {
      rows: 2, cols: 2, row: 0, col: 0, rowSpan: 2, colSpan: 1, selectedCells: 1,
      insertRowAbove: null, insertRowBelow: null, insertColumnLeft: null, insertColumnRight: null,
      deleteRow: null, deleteColumn: null, mergeRight: null, mergeBelow: "tableShape",
      mergeCells: "tableShape", splitCell: null, maxSplitRows: 1, maxSplitColumns: 1,
      ...BASE_FORMAT_FIELDS, supportedBorderStyles: [...BASE_FORMAT_FIELDS.supportedBorderStyles],
    };
    await editor.load({ discard: true });
    expect(documentCommandState("table.splitCell", editor.snapshot())).toEqual({ available: true });
    expect(editor.snapshot().parameters?.["table.splitCell"]).toBeUndefined();
    expect(editor.execute("table.splitCell").accepted).toBe(true);
    expect(fake.calls.filter((c) => c.method === "edit").pop()?.args[3]).toEqual([
      { op: "tableStructure", action: "splitCell", target: { anchorKey: "body:0:0", caretKey: "body:0:0" } },
    ]);
    await flush();
    // Protected document blocks structural commands.
    fake.formatAccess = "protected";
    await editor.load({ discard: true });
    expect(documentCommandState("table.insertRowBelow", editor.snapshot())).toEqual({ available: false, reason: "protected" });
  });

  it("P4 안정화: 대기 중인 tableRepeatHeader·tableRowBreak는 바꾸는 연산으로 예상 기록에 들어가고, 응답 뒤에는 엔진 기록으로 맞춘다", async () => {
    const { documentCommandState } = await import("../../../commands/capability");
    const { editor, fake } = await readyDocx(["본문"]);
    fake.tableView = {
      rows: 2, cols: 2, row: 0, col: 0, rowSpan: 1, colSpan: 1, selectedCells: 1,
      insertRowAbove: null, insertRowBelow: null, insertColumnLeft: null, insertColumnRight: null,
      deleteRow: null, deleteColumn: null, mergeRight: null, mergeBelow: null,
      mergeCells: "tableShape", splitCell: null, maxSplitRows: 16, maxSplitColumns: 4,
      hasInsideBorders: false, cellShadingRefusal: null, cellBordersRefusal: null,
      cellShading: null, cellShadingMixed: false, hasCellShading: false, cellBorders: null,
      supportedBorderStyles: ["single"], cellAlignHorizontal: "left", cellAlignHorizontalMixed: false,
      cellAlignVertical: "top", cellAlignVerticalMixed: false, cellAlignmentRefusal: null,
      colWidth: 100, colWidthMixed: false, rowHeight: 24, rowHeightMixed: false, rowHeightRule: "atLeast",
      selectedCols: 1, selectedRows: 1, columnWidthRefusal: null, rowHeightRefusal: null,
      tableCellMargins: { top: 0, right: 5.4, bottom: 0, left: 5.4 }, cellMargins: { top: 0, right: 5.4, bottom: 0, left: 5.4 },
      cellMarginsMixed: false, cellMarginsUsesDefault: true, cellMarginsOverrideMixed: false,
      cellMarginsRefusal: null, tableAlign: "left", tableIndentPt: 0, tablePositioningRefusal: null,
      leadingHeaderRows: 0, rowHeader: false, rowHeaderMixed: false, canEnableHeader: true, repeatHeaderRefusal: null,
      rowBreakMode: "cell", rowBreakMixed: false, rowBreakRefusal: null,
    };
    await editor.load({ discard: true });
    editor.typeText("x");
    await flush();
    expect(editor.execute("edit.undo").accepted).toBe(true);
    await flush();
    expect(editor.snapshot().history).toEqual({ undo: false, redo: true });
    const queued: [import("../../../commands/registry").DocumentCommandId, import("../../../commands/target").DocumentCommandArgs][] = [
      ["table.repeatHeader", { command: "table.repeatHeader", repeat: true }],
      ["table.rowBreak", { command: "table.rowBreak", mode: "row" }],
    ];
    for (const [command, args] of queued) {
      fake.hold = true;
      expect(editor.execute(command, args).accepted, command).toBe(true);
      // Pending mutation: Undo becomes available, the Redo branch is projected as discarded.
      expect(editor.snapshot().queuedHistory, command).toEqual({ undo: "available", redo: "none" });
      expect(documentCommandState("edit.redo", editor.snapshot()).available, command).toBe(false);
      fake.release();
      await flush();
      // The fake engine refuses these table ops: no completed step, authoritative history restored.
      expect(editor.snapshot().queuedHistory, command).toBeNull();
      expect(editor.snapshot().history, command).toEqual({ undo: false, redo: true });
      fake.hold = false;
    }
    // Navigation stays non-mutating while pending.
    fake.hold = true;
    editor.move("docStart", false);
    expect(editor.snapshot().queuedHistory).toEqual({ undo: "none", redo: "available" });
    fake.release();
    await flush();
  });

  it("DOCX 표 셀 배경색과 테두리 명령의 파라미터 검증·거절·실행을 확인한다", async () => {
    const { documentCommandState } = await import("../../../commands/capability");
    const { editor, fake } = await readyDocx(["본문"]);
    expect(documentCommandState("table.shading", editor.snapshot())).toEqual({ available: false, reason: "notInTable" });
    expect(documentCommandState("table.borders", editor.snapshot())).toEqual({ available: false, reason: "notInTable" });
    expect(documentCommandState("table.alignment", editor.snapshot())).toEqual({ available: false, reason: "notInTable" });
    expect(documentCommandState("table.columnWidth", editor.snapshot())).toEqual({ available: false, reason: "notInTable" });
    expect(documentCommandState("table.rowHeight", editor.snapshot())).toEqual({ available: false, reason: "notInTable" });
    fake.tableView = {
      rows: 2, cols: 2, row: 0, col: 0, rowSpan: 1, colSpan: 1, selectedCells: 1,
      insertRowAbove: null, insertRowBelow: null, insertColumnLeft: null, insertColumnRight: null,
      deleteRow: null, deleteColumn: null, mergeRight: null, mergeBelow: null,
      mergeCells: "tableShape", splitCell: null, maxSplitRows: 16, maxSplitColumns: 4,
      hasInsideBorders: false, cellShadingRefusal: null, cellBordersRefusal: null,
      cellShading: null, cellShadingMixed: false, hasCellShading: false, cellBorders: null,
      supportedBorderStyles: ["single", "double", "dotted", "dashed", "thick", "triple", "dotDash", "wave", "none"],
      cellAlignHorizontal: "left", cellAlignHorizontalMixed: false,
      cellAlignVertical: "top", cellAlignVerticalMixed: false, cellAlignmentRefusal: null,
      colWidth: 100, colWidthMixed: false, rowHeight: 24, rowHeightMixed: false, rowHeightRule: "atLeast",
      selectedCols: 1, selectedRows: 1, columnWidthRefusal: null, rowHeightRefusal: null,
      tableCellMargins: { top: 0, right: 5.4, bottom: 0, left: 5.4 },
      cellMargins: { top: 0, right: 5.4, bottom: 0, left: 5.4 },
      cellMarginsMixed: false, cellMarginsUsesDefault: true, cellMarginsOverrideMixed: false,
      cellMarginsRefusal: null, tableAlign: "left", tableIndentPt: 0, tablePositioningRefusal: null,
      leadingHeaderRows: 0, rowHeader: false, rowHeaderMixed: false, canEnableHeader: true, repeatHeaderRefusal: null,
      rowBreakMode: "cell", rowBreakMixed: false, rowBreakRefusal: null,
    };
    await editor.load({ discard: true });
    expect(documentCommandState("table.shading", editor.snapshot())).toEqual({ available: true });
    expect(documentCommandState("table.borders", editor.snapshot())).toEqual({ available: true });
    expect(documentCommandState("table.alignment", editor.snapshot())).toEqual({ available: true });
    expect(documentCommandState("table.columnWidth", editor.snapshot())).toEqual({ available: true });
    expect(documentCommandState("table.rowHeight", editor.snapshot())).toEqual({ available: true });
    // Invalid hex or unsupported style/inside-on-single-cell must reject before queueing.
    expect(editor.execute("table.shading", { command: "table.shading", color: "not-a-color" }).accepted).toBe(false);
    expect(editor.execute("table.borders", { command: "table.borders", kind: "inside", style: "single", width: 0.5, color: "#000000" }).accepted).toBe(false);
    expect(editor.execute("table.borders", { command: "table.borders", kind: "outside", style: "circle", width: 0.5, color: "#000000" }).accepted).toBe(false);
    expect(editor.execute("table.shading", { command: "table.shading", color: "#FEF08A" }).accepted).toBe(true);
    expect(fake.calls.filter((c) => c.method === "edit").pop()?.args[3]).toEqual([
      { op: "tableShading", target: { anchorKey: "body:0:0", caretKey: "body:0:0" }, color: "#FEF08A" },
    ]);
    await flush();
    expect(editor.execute("table.shading", { command: "table.shading", color: null }).accepted).toBe(true);
    expect(fake.calls.filter((c) => c.method === "edit").pop()?.args[3]).toEqual([
      { op: "tableShading", target: { anchorKey: "body:0:0", caretKey: "body:0:0" }, color: null },
    ]);
    await flush();
    fake.tableView.hasInsideBorders = true;
    await editor.load({ discard: true });
    expect(editor.execute("table.borders", {
      command: "table.borders", kind: "inside", style: "dashed", width: 1.5, color: "#1E40AF",
    }).accepted).toBe(true);
    expect(fake.calls.filter((c) => c.method === "edit").pop()?.args[3]).toEqual([
      { op: "tableBorders", target: { anchorKey: "body:0:0", caretKey: "body:0:0" }, kind: "inside", style: "dashed", width: 1.5, color: "#1E40AF" },
    ]);
    await flush();
    expect(editor.execute("table.alignment", { command: "table.alignment" }).accepted).toBe(false);
    expect(editor.execute("table.alignment", { command: "table.alignment", horizontal: "center", vertical: "bottom" }).accepted).toBe(true);
    expect(fake.calls.filter((c) => c.method === "edit").pop()?.args[3]).toEqual([
      { op: "tableAlignment", target: { anchorKey: "body:0:0", caretKey: "body:0:0" }, horizontal: "center", vertical: "bottom" },
    ]);
    await flush();
    expect(editor.execute("table.columnWidth", { command: "table.columnWidth", width: 2 }).accepted).toBe(false);
    expect(editor.execute("table.columnWidth", { command: "table.columnWidth", width: 120 }).accepted).toBe(true);
    expect(fake.calls.filter((c) => c.method === "edit").pop()?.args[3]).toEqual([
      { op: "tableColumnWidth", target: { anchorKey: "body:0:0", caretKey: "body:0:0" }, width: 120, distribute: false },
    ]);
    await flush();
    expect(editor.execute("table.rowHeight", { command: "table.rowHeight", height: 36, rule: "exact" }).accepted).toBe(true);
    expect(fake.calls.filter((c) => c.method === "edit").pop()?.args[3]).toEqual([
      { op: "tableRowHeight", target: { anchorKey: "body:0:0", caretKey: "body:0:0" }, height: 36, rule: "exact", clear: false, distribute: false },
    ]);
    await flush();
    expect(editor.execute("table.cellMargins", { command: "table.cellMargins", scope: "cell", top: 6, left: 12 }).accepted).toBe(true);
    expect(fake.calls.filter((c) => c.method === "edit").pop()?.args[3]).toEqual([
      { op: "tableCellMargins", target: { anchorKey: "body:0:0", caretKey: "body:0:0" }, scope: "cell", top: 6, left: 12, reset: false },
    ]);
    await flush();
    expect(editor.execute("table.cellMargins", { command: "table.cellMargins", scope: "cell", reset: true }).accepted).toBe(true);
    expect(fake.calls.filter((c) => c.method === "edit").pop()?.args[3]).toEqual([
      { op: "tableCellMargins", target: { anchorKey: "body:0:0", caretKey: "body:0:0" }, scope: "cell", reset: true },
    ]);
    await flush();
    expect(editor.execute("table.positioning", { command: "table.positioning", align: "center", indentPt: 18 }).accepted).toBe(true);
    expect(fake.calls.filter((c) => c.method === "edit").pop()?.args[3]).toEqual([
      { op: "tablePositioning", target: { anchorKey: "body:0:0", caretKey: "body:0:0" }, align: "center", indentPt: 18 },
    ]);
    expect(editor.execute("table.positioning", { command: "table.positioning", align: "center", treatAsChar: false }).accepted).toBe(false);
    await flush();
    expect(editor.execute("table.repeatHeader", { command: "table.repeatHeader", repeat: true }).accepted).toBe(true);
    expect(fake.calls.filter((c) => c.method === "edit").pop()?.args[3]).toEqual([
      { op: "tableRepeatHeader", target: { anchorKey: "body:0:0", caretKey: "body:0:0" }, repeat: true },
    ]);
    await flush();
    expect(editor.execute("table.rowBreak", { command: "table.rowBreak", mode: "row" }).accepted).toBe(true);
    expect(fake.calls.filter((c) => c.method === "edit").pop()?.args[3]).toEqual([
      { op: "tableRowBreak", target: { anchorKey: "body:0:0", caretKey: "body:0:0" }, mode: "row" },
    ]);
    expect(editor.execute("table.rowBreak", { command: "table.rowBreak", mode: "none" }).accepted).toBe(false);
  });

  it("차트·SmartArt object.edit: 가용성·선택·신원 검증을 거쳐 실제 DocxEditorSession 편집 경로로 전달된다", async () => {
    const { editor, fake } = await readyDocx();
    const chartObject: NonNullable<typeof fake.objectView> = {
      kind: "chart",
      address: { engine: "wordcraft", position: "body:0:0" },
      frame: { page: 0, x: 72, y: 72, width: 240, height: 140 },
      epoch: 1,
      operations: ["chart"],
      graphic: {
        kind: "chart",
        plot: "column",
        title: "Before",
        labels: ["Q1", "Q2"],
        series: [{ name: "S1", values: ["1", "2"] }],
      },
    };
    fake.objectView = chartObject;
    await editor.load({ discard: true });

    expect(documentCommandState("object.edit", editor.snapshot())).toEqual({ available: true });
    const chartSel = editor.objectSelection!;
    expect(chartSel.operations).toEqual(["deselect", "chart"]);

    // Chart cannot execute a SmartArt-only edit.
    const wrongKind = objectEditRequest(chartSel, { kind: "smartArtLayout", layout: "cycle" });
    expect(editor.execute("object.edit", wrongKind).accepted).toBe(false);

    // Stale identity (sessionId, loadGeneration, revision, selectionEpoch) must be refused.
    const validTitle = objectEditRequest(chartSel, { kind: "chartTitle", text: "After" });
    expect(editor.execute("object.edit", { ...validTitle, selectionEpoch: chartSel.epoch + 1 }).accepted).toBe(false);
    expect(editor.execute("object.edit", { ...validTitle, revision: chartSel.revision + 1 }).accepted).toBe(false);
    expect(editor.execute("object.edit", { ...validTitle, loadGeneration: chartSel.loadGeneration + 1 }).accepted).toBe(false);
    expect(editor.execute("object.edit", { ...validTitle, sessionId: (chartSel.sessionId + 1) as never }).accepted).toBe(false);
    expect(fake.objectEdits).toHaveLength(0);

    // Command dispatcher routes chart edit through DocxEditorSession to the backend.
    const notices: unknown[] = [];
    const ctx = { layout: initialLayout, dispatch: vi.fn(), notify: (m: unknown) => notices.push(m), document: editor };
    expect(executeCommand("object.edit", undefined, ctx, validTitle)).toBe(true);
    await flush();
    expect(fake.objectEdits).toEqual([
      { position: "body:0:0", epoch: 1, edit: { kind: "chartTitle", text: "After" } },
    ]);
    expect(notices).toEqual([]);

    // Protected document or pending edit refuses object.edit.
    fake.formatAccess = "protected";
    await editor.load({ discard: true });
    expect(documentCommandState("object.edit", editor.snapshot())).toEqual({ available: false, reason: "protected" });
    expect(executeCommand("object.edit", undefined, ctx, objectEditRequest(editor.objectSelection!, { kind: "chartType", plot: "line" }))).toBe(false);

    fake.formatAccess = "allowed";
    fake.objectView = {
      kind: "smartArt",
      address: { engine: "wordcraft", position: "body:1:0" },
      frame: { page: 0, x: 72, y: 240, width: 300, height: 180 },
      epoch: 2,
      operations: ["smartArt"],
      graphic: {
        kind: "smartArt",
        layout: "process",
        items: [{ text: "Plan", level: 0 }, { text: "Build", level: 0 }],
      },
    };
    await editor.load({ discard: true });
    expect(documentCommandState("object.edit", editor.snapshot())).toEqual({ available: true });
    const saSel = editor.objectSelection!;

    fake.hold = true;
    editor.typeText("a"); // pending mutation
    expect(documentCommandState("object.edit", editor.snapshot())).toEqual({ available: false, reason: "pendingEdits" });
    expect(editor.execute("object.edit", objectEditRequest(saSel, { kind: "smartArtLayout", layout: "cycle" })).accepted).toBe(false);
    fake.hold = false;
    fake.release();
    await flush();

    // Refresh selection after revision bump and send SmartArt layout edit through command dispatcher.
    const freshSa = editor.objectSelection!;
    expect(executeCommand("object.edit", undefined, ctx, objectEditRequest(freshSa, { kind: "smartArtLayout", layout: "cycle" }))).toBe(true);
    await flush();
    expect(fake.objectEdits.at(-1)).toEqual({
      position: "body:1:0",
      epoch: 2,
      edit: { kind: "smartArtLayout", layout: "cycle" },
    });
  });
});
