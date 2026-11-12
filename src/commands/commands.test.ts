// 명령 레지스트리·단축키·가용성 결정(T010). 순수 함수와 가짜 명령 대상만 쓴다(엔진 동작 확인은 sessions.test.ts의 가짜
// 백엔드 흉내와 Rust 시험·통합 시험이 따로 한다).
import { describe, expect, it, vi } from "vitest";
import { initialLayout } from "../hooks/layoutState";
import { isMessageKey, type Message } from "../language";
import { RIBBON_TABS } from "../ribbon/definitions";
import { documentCommandState } from "./capability";
import { commandState, executeCommand, type CommandContext } from "./commands";
import {
  buildRegistry, COMMAND_PROBLEMS, COMMANDS, commandDefinition, commandForShortcut, eventShortcut, isDocumentCommandId, parseShortcut, SHORTCUT_PROBLEMS,
  shortcutLabel, type DocumentCommandId,
} from "./registry";
import { handleShortcut, isDocumentShortcutTarget } from "./shortcuts";
import type { DocumentCommandSnapshot, DocumentCommandTarget, QueuedStep } from "./target";

const DOCUMENT_IDS: DocumentCommandId[] = [
  "edit.undo", "edit.redo", "format.bold", "format.italic", "format.underline", "format.strikethrough", "file.save",
];

const snapshot = (patch: Partial<DocumentCommandSnapshot> = {}): DocumentCommandSnapshot => ({
  sessionId: 1, engine: "wordcraft", loadGeneration: 1, revision: 0,
  loaded: true, editable: true, composing: false, pending: false, queuedHistory: null, saving: false,
  history: { undo: false, redo: false },
  format: { bold: false, italic: false, underline: false, strikethrough: false },
  formatAccess: "allowed",
  ...patch,
});

/** 받은 명령을 기록하는 가짜 대상(엔진 아님). */
function fakeTarget(state: DocumentCommandSnapshot, accept = true) {
  const executed: string[] = [];
  const target: DocumentCommandTarget = {
    sessionId: state.sessionId,
    engine: state.engine,
    snapshot: () => state,
    execute: (command) => {
      executed.push(command);
      return { accepted: accept };
    },
  };
  return { target, executed };
}

function context(document: DocumentCommandTarget | null) {
  const notices: Message[] = [];
  const dispatch = vi.fn();
  const value: CommandContext = { layout: initialLayout, dispatch, notify: (message) => notices.push(message), document };
  return { value, notices, dispatch };
}

describe("명령 레지스트리", () => {
  it("리본의 모든 명령과 연결한 명령이 한 번씩 있고 라벨 키가 번역 사전에 있다", () => {
    const ribbon = RIBBON_TABS.flatMap((tab) => tab.groups.flatMap((group) => group.commands.map((command) => command.id)));
    for (const id of ribbon) expect(COMMANDS.has(id)).toBe(true);
    for (const id of DOCUMENT_IDS) expect(commandDefinition(id)?.kind).toBe("document");
    for (const id of ["file.new", "file.open", "file.saveAs"]) expect(commandDefinition(id)?.kind).toBe("file");
    for (const definition of COMMANDS.values()) expect(isMessageKey(definition.labelKey)).toBe(true);
    // 문서 명령은 두 엔진의 지원을 모두 밝힌다.
    for (const id of DOCUMENT_IDS) expect(Object.keys(commandDefinition(id)!.engines!).sort()).toEqual(["rhwp", "wordcraft"]);
  });

  it("명령 ID는 한 번만 선언된다: 중복은 덮어쓰지 않고 문제로 적는다(안정화 P3)", () => {
    expect(COMMAND_PROBLEMS).toEqual([]);
    const cmd = (id: string, labelKey = `command.${id}`) => ({ id, labelKey: labelKey as never, icon: "bold" as const });
    const tabs = [
      { id: "a", labelKey: "ribbon.tab.home" as never, groups: [{ id: "g1", labelKey: "ribbon.group.font" as never, commands: [cmd("x.one"), cmd("x.two")] }] },
      { id: "b", labelKey: "ribbon.tab.file" as never, groups: [{ id: "g2", labelKey: "ribbon.group.font" as never, commands: [cmd("x.one", "command.other")] }] },
    ];
    const { commands, problems } = buildRegistry(tabs, { "x.two": {} }, { "x.two": {}, "x.three": {} });
    expect(problems).toEqual([
      "x.one: duplicate ribbon command (b/g2)",
      "x.two: declared as more than one kind of command",
    ]);
    // 처음 선언이 남는다(나중 것이 조용히 덮지 않음).
    expect(commands.get("x.one")).toMatchObject({ labelKey: "command.x.one", kind: "planned" });
    expect(commands.get("x.two")?.kind).toBe("layout");
    expect(commands.get("x.three")?.kind).toBe("document");
    const mislabeled = buildRegistry([{ ...tabs[0]!, groups: [{ ...tabs[0]!.groups[0]!, commands: [cmd("x.four", "command.wrong")] }] }], { "x.four": {} }, {});
    expect(mislabeled.problems).toEqual(["x.four: ribbon label command.wrong differs from command.x.four"]);
    // 실제 리본 정의 자체에도 중복이 없다(덮어쓰기 전 원본 목록).
    const ribbon = RIBBON_TABS.flatMap((tab) => tab.groups.flatMap((group) => group.commands.map((command) => command.id)));
    expect(new Set(ribbon).size).toBe(ribbon.length);
  });

  it("엔진별 지원: rhwp 실행 취소·다시 실행은 일반 기록으로 지원(시험 flag 없이), 서식은 계속 미지원", () => {
    const supported = (engine: "rhwp" | "wordcraft") =>
      DOCUMENT_IDS.filter((id) => commandDefinition(id)!.engines![engine].level === "supported");
    expect(supported("wordcraft")).toEqual(DOCUMENT_IDS);
    expect(supported("rhwp")).toEqual(["edit.undo", "edit.redo", "file.save"]);
    expect(commandDefinition("edit.undo")?.engines?.rhwp).toEqual({ level: "supported" });
    expect(commandDefinition("edit.redo")?.engines?.rhwp).toEqual({ level: "supported" });
  });

  it("단축키는 형식이 맞고 겹치지 않으며 모두 Mod 또는 기능 키를 쓴다(글자 입력과 겹치지 않음)", () => {
    expect(SHORTCUT_PROBLEMS).toEqual([]);
    for (const definition of COMMANDS.values()) {
      for (const text of definition.shortcuts ?? []) {
        const key = parseShortcut(text)!;
        expect(key.startsWith("Mod+") || /(^|\+)F\d+$/.test(key)).toBe(true);
        expect(definition.scope).toBeDefined();
      }
    }
    expect(commandForShortcut("Mod+KeyZ")?.id).toBe("edit.undo");
    expect(commandForShortcut("Mod+KeyY")?.id).toBe("edit.redo");
    expect(commandForShortcut("Mod+Shift+KeyZ")?.id).toBe("edit.redo");
    expect(commandForShortcut("Mod+KeyB")?.id).toBe("format.bold");
    expect(commandForShortcut("Mod+KeyS")?.id).toBe("file.save");
    expect(commandForShortcut("Mod+KeyO")?.id).toBe("file.open");
    expect(commandForShortcut("Mod+KeyN")?.id).toBe("file.new");
    expect(commandForShortcut("Mod+Shift+KeyS")?.id).toBe("file.saveAs");
    expect(commandForShortcut("Mod+F1")?.id).toBe("view.ribbon");
    // Clipboard shortcuts belong to the shared registry; Select All stays on the surface.
    for (const [key, id] of [["C", "copy"], ["V", "paste"], ["X", "cut"]]) expect(commandForShortcut(`Mod+Key${key}`)?.id).toBe(`edit.${id}`);
    expect(commandForShortcut("Mod+KeyA")).toBeUndefined();
  });

  it("단축키 선언 정규화: 수식 키 순서를 맞추고 틀린 형식은 거부한다", () => {
    expect(parseShortcut("Shift+Mod+Z")).toBe("Mod+Shift+KeyZ");
    expect(parseShortcut("Mod+F1")).toBe("Mod+F1");
    for (const bad of ["Mod+", "Ctrl+Z", "Mod+Mod+Z", "Mod+ZZ", "Mod+F13", "Mod+z"]) expect(parseShortcut(bad)).toBeNull();
    expect(shortcutLabel("Mod+Shift+Z", false)).toBe("Ctrl+Shift+Z");
    expect(shortcutLabel("Mod+B", true)).toBe("Cmd+B");
  });

  it("키 입력 정규화: 물리 키로 맞춰 한글 입력 상태에서도 같고, macOS는 Cmd가 Mod다", () => {
    const key = (patch: Partial<KeyboardEvent>) =>
      ({ code: "", key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...patch }) as KeyboardEvent;
    expect(eventShortcut(key({ code: "KeyZ", key: "ㅋ", ctrlKey: true }), false)).toBe("Mod+KeyZ");
    expect(eventShortcut(key({ code: "KeyZ", key: "Z", ctrlKey: true, shiftKey: true }), false)).toBe("Mod+Shift+KeyZ");
    expect(eventShortcut(key({ code: "KeyZ", key: "z", metaKey: true }), true)).toBe("Mod+KeyZ");
    expect(eventShortcut(key({ code: "KeyZ", key: "z", ctrlKey: true }), true)).toBeNull(); // macOS의 Ctrl+Z는 명령이 아님
    expect(eventShortcut(key({ code: "KeyZ", key: "z", metaKey: true }), false)).toBeNull();
    expect(eventShortcut(key({ code: "KeyZ", key: "z" }), false)).toBe("KeyZ"); // 수식 키 없는 글자: 단축키 아님
    expect(commandForShortcut("KeyZ")).toBeUndefined();
    expect(eventShortcut(key({ code: "Digit1", key: "1", ctrlKey: true }), false)).toBeNull();
    // 물리 키를 모르는 입력만 key로 대신한다(로마자·기능 키).
    expect(eventShortcut(key({ code: "Unidentified", key: "b", ctrlKey: true }), false)).toBe("Mod+KeyB");
    expect(eventShortcut(key({ code: "", key: "ㅠ", ctrlKey: true }), false)).toBeNull();
  });
});

describe("가용성 결정", () => {
  it("열린 문서가 없으면 noDocument, 연결하지 않은 리본 명령은 notImplemented", () => {
    for (const id of DOCUMENT_IDS) expect(commandState(id, { layout: initialLayout, document: null })).toEqual({ available: false, reason: "noDocument" });
    expect(commandState("paragraph.alignCenter", { layout: initialLayout, document: null })).toEqual({ available: false, reason: "notImplemented" });
    for (const id of ["no.such.command", "toString", "constructor"]) {
      expect(commandState(id, { layout: initialLayout, document: null })).toEqual({ available: false, reason: "notImplemented" });
    }
  });

  it("rhwp 문서: 일반·advanced 기록 모두 실제 기록 상태를 따르고, 기록이 없으면 하지 않는다", () => {
    const rhwp = snapshot({ engine: "rhwp", history: null, format: null });
    for (const id of DOCUMENT_IDS.filter((id) => id !== "file.save")) {
      expect(documentCommandState(id, rhwp)).toEqual({ available: false, reason: "engineUnsupported" });
    }
    expect(documentCommandState("file.save", rhwp)).toEqual({ available: true });
    expect(documentCommandState("edit.undo", snapshot({ engine: "rhwp", history: null, historyLimited: true }))).toEqual({ available: false, reason: "limit" });
    // 일반 기록(범위 표시 없음): 단계가 있을 때만, 조합·편집 불가에서는 하지 않는다.
    const general = snapshot({ engine: "rhwp", history: { undo: true, redo: false } });
    expect(documentCommandState("edit.undo", general)).toEqual({ available: true });
    expect(documentCommandState("edit.redo", general)).toEqual({ available: false, reason: "nothingToRedo" });
    expect(documentCommandState("edit.undo", snapshot({ engine: "rhwp", history: { undo: true, redo: true }, composing: true }))).toEqual({ available: false, reason: "composing" });
    expect(documentCommandState("edit.undo", snapshot({ engine: "rhwp", history: { undo: true, redo: true }, editable: false }))).toEqual({ available: false, reason: "notReady" });
    const advanced = snapshot({ engine: "rhwp", historyScope: "advanced", history: { undo: true, redo: true } });
    expect(documentCommandState("edit.undo", advanced)).toEqual({ available: true });
    expect(documentCommandState("edit.redo", advanced)).toEqual({ available: true });
    expect(documentCommandState("edit.undo", snapshot({ engine: "rhwp", historyScope: "advanced", history: { undo: false, redo: false } })))
      .toEqual({ available: false, reason: "nothingToUndo" });
  });

  it("WordCraft 문서: 엔진 기록·서식으로 정한다", () => {
    expect(documentCommandState("edit.undo", snapshot())).toEqual({ available: false, reason: "nothingToUndo" });
    expect(documentCommandState("edit.redo", snapshot())).toEqual({ available: false, reason: "nothingToRedo" });
    expect(documentCommandState("edit.undo", snapshot({ history: { undo: true, redo: false } }))).toEqual({ available: true });
    expect(documentCommandState("edit.redo", snapshot({ history: { undo: false, redo: true } }))).toEqual({ available: true });
    // 대기 연산이 있으면 엔진 기록에 적용한 예상으로 정한다(안정화 P2-A). 남은 단계를 응답 전에 모르면(unknown) 기다린다(마무리 안정화).
    const queued = (undo: QueuedStep, redo: QueuedStep) => snapshot({ pending: true, queuedHistory: { undo, redo } });
    expect(documentCommandState("edit.undo", queued("available", "none"))).toEqual({ available: true });
    expect(documentCommandState("edit.undo", queued("none", "none"))).toEqual({ available: false, reason: "nothingToUndo" });
    expect(documentCommandState("edit.undo", queued("unknown", "none"))).toEqual({ available: false, reason: "pendingEdits" });
    expect(documentCommandState("edit.redo", queued("available", "none"))).toMatchObject({ reason: "nothingToRedo" });
    expect(documentCommandState("edit.redo", queued("none", "available"))).toEqual({ available: true });
    expect(documentCommandState("edit.redo", queued("none", "unknown"))).toEqual({ available: false, reason: "pendingEdits" });
    // 대기 예상이 엔진 보기보다 앞선다(낡은 보기의 기록으로 정하지 않음).
    expect(documentCommandState("edit.redo", snapshot({ history: { undo: true, redo: true }, queuedHistory: { undo: "available", redo: "none" } })))
      .toMatchObject({ reason: "nothingToRedo" });
    // 문서 보호(안정화 P2-B): 언제나 거부하는 보호면 쓸 수 없고, 편집 가능 영역만 허용하면 엔진이 판정하도록 보낸다.
    expect(documentCommandState("format.bold", snapshot({ formatAccess: "protected" }))).toEqual({ available: false, reason: "protected" });
    expect(documentCommandState("format.bold", snapshot({ formatAccess: "regions" }))).toEqual({ available: true, pressed: false });
    expect(documentCommandState("edit.undo", snapshot({ formatAccess: "protected", history: { undo: true, redo: false } }))).toEqual({ available: true });
    expect(documentCommandState("format.bold", snapshot())).toEqual({ available: true, pressed: false });
    expect(documentCommandState("format.italic", snapshot({ format: { bold: false, italic: true, underline: false, strikethrough: false } })))
      .toEqual({ available: true, pressed: true });
    // 엔진이 기록·서식을 알려 주지 않으면 화면에서 만들지 않고 하지 않는다.
    expect(documentCommandState("edit.undo", snapshot({ history: null }))).toMatchObject({ reason: "engineUnsupported" });
    expect(documentCommandState("format.bold", snapshot({ format: null }))).toMatchObject({ reason: "engineUnsupported" });
  });

  it("조합 중·편집할 수 없음·저장 중", () => {
    const ready = { history: { undo: true, redo: true } };
    for (const id of DOCUMENT_IDS.filter((id) => id !== "file.save")) {
      expect(documentCommandState(id, snapshot({ ...ready, composing: true }))).toMatchObject({ reason: "composing" });
      expect(documentCommandState(id, snapshot({ ...ready, editable: false }))).toMatchObject({ reason: "notReady" });
    }
    expect(documentCommandState("file.save", snapshot({ loaded: false, editable: false }))).toMatchObject({ reason: "notReady" });
    expect(documentCommandState("file.save", snapshot({ saving: true }))).toMatchObject({ reason: "saving" });
    // 그림 예산 초과 등으로 편집만 멈춘 문서도 저장 절차에는 넘긴다(그 절차가 검사).
    expect(documentCommandState("file.save", snapshot({ editable: false }))).toEqual({ available: true });
  });
});

describe("명령 실행", () => {
  it("native 파일 명령은 같은 작업 흐름을 호출하고 작업 중 중복 실행을 막는다", () => {
    const files = { busy: false, open: vi.fn(), newDocument: vi.fn(), saveAs: vi.fn() };
    const { target } = fakeTarget(snapshot());
    const value: CommandContext = { layout: initialLayout, dispatch: () => {}, notify: () => {}, document: target, files };
    for (const id of ["file.open", "file.new", "file.saveAs"]) expect(commandState(id, value)).toEqual({ available: true });
    expect(executeCommand("file.open", undefined, value)).toBe(true);
    expect(executeCommand("file.new", undefined, value)).toBe(true);
    expect(executeCommand("file.saveAs", undefined, value)).toBe(true);
    expect(files.open).toHaveBeenCalledOnce();
    expect(files.newDocument).toHaveBeenCalledOnce();
    expect(files.saveAs).toHaveBeenCalledWith(target.sessionId);

    const busy: CommandContext = { ...value, files: { ...files, busy: true } };
    expect(commandState("file.open", busy)).toEqual({ available: false, reason: "dialogOpen" });
    expect(commandState("file.save", busy)).toEqual({ available: false, reason: "dialogOpen" });
    expect(executeCommand("file.open", "command.file.open", busy)).toBe(false);
  });

  it("native New/Open without a connected file port report unavailable rather than succeeding", () => {
    const { value, notices } = context(null);
    expect(commandState("file.open", value)).toEqual({ available: false, reason: "notImplemented" });
    expect(executeCommand("file.new", "command.file.new", value)).toBe(false);
    expect(notices).toHaveLength(1);
  });

  it("쓸 수 있는 문서 명령만 활성 세션에 보낸다", () => {
    const { target, executed } = fakeTarget(snapshot({ history: { undo: true, redo: false } }));
    const { value, notices } = context(target);
    expect(executeCommand("edit.undo", undefined, value)).toBe(true);
    expect(executed).toEqual(["edit.undo"]);
    expect(notices).toEqual([]);
  });

  it("쓸 수 없는 명령은 세션에 보내지 않고 이유를 알린다(가짜 성공 없음)", () => {
    const { target, executed } = fakeTarget(snapshot({ engine: "rhwp", history: null, format: null }));
    const { value, notices } = context(target);
    expect(executeCommand("format.bold", undefined, value)).toBe(false);
    expect(executeCommand("edit.undo", "command.edit.undo", value)).toBe(false);
    expect(executeCommand("paragraph.alignCenter", "command.paragraph.alignCenter", value)).toBe(false);
    expect(executed).toEqual([]);
    expect(notices).toEqual([
      { key: "command.unavailable.engineUnsupported", vars: { command: { key: "command.format.bold" } } },
      { key: "command.unavailable.engineUnsupported", vars: { command: { key: "command.edit.undo" } } },
      { key: "command.unavailable.notImplemented", vars: { command: { key: "command.paragraph.alignCenter" } } },
    ]);
  });

  it("세션이 다시 확인해 거절하면 실패로 알린다", () => {
    const { target, executed } = fakeTarget(snapshot(), false);
    const { value, notices } = context(target);
    expect(executeCommand("format.bold", undefined, value)).toBe(false);
    expect(executed).toEqual(["format.bold"]);
    expect(notices).toEqual([{ key: "command.unavailable.notReady", vars: { command: { key: "command.format.bold" } } }]);
  });

  it("화면 배치 명령은 문서와 무관하게 실행된다", () => {
    const { value, dispatch } = context(null);
    expect(executeCommand("view.ribbon", undefined, value)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleRibbon" });
  });
});

describe("단축키 처리", () => {
  const keydown = (target: EventTarget, init: KeyboardEventInit & { keyCode?: number }) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
    Object.defineProperty(event, "target", { value: target });
    return event;
  };
  const editorInput = () => Object.assign(document.createElement("textarea"), { className: "rhwp-input" });

  it("편집 표면 입력의 Ctrl+B는 명령으로 실행하고 기본 동작을 막는다", () => {
    const { target, executed } = fakeTarget(snapshot());
    const { value } = context(target);
    const event = keydown(editorInput(), { code: "KeyB", key: "b", ctrlKey: true });
    expect(handleShortcut(event, value, false)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(executed).toEqual(["format.bold"]);
  });

  it("IME 조합 중 키(isComposing·229)는 보지 않는다", () => {
    const { target, executed } = fakeTarget(snapshot({ history: { undo: true, redo: false } }));
    const { value } = context(target);
    const composing = keydown(editorInput(), { code: "KeyZ", key: "z", ctrlKey: true, isComposing: true });
    const process = keydown(editorInput(), { code: "KeyZ", key: "Process", ctrlKey: true, keyCode: 229 });
    expect(handleShortcut(composing, value, false)).toBe(false);
    expect(handleShortcut(process, value, false)).toBe(false);
    expect(composing.defaultPrevented || process.defaultPrevented).toBe(false);
    expect(executed).toEqual([]);
  });

  it("다른 입력 칸의 문서 단축키는 그 칸에 맡기고, 전역 단축키(Ctrl+F1)는 받는다", () => {
    const { target, executed } = fakeTarget(snapshot({ history: { undo: true, redo: false } }));
    const { value, dispatch } = context(target);
    const field = document.createElement("input");
    const undo = keydown(field, { code: "KeyZ", key: "z", ctrlKey: true });
    expect(handleShortcut(undo, value, false)).toBe(false);
    expect(undo.defaultPrevented).toBe(false);
    expect(executed).toEqual([]);
    const ribbon = keydown(field, { code: "F1", key: "F1", ctrlKey: true });
    expect(handleShortcut(ribbon, value, false)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleRibbon" });
    expect(isDocumentShortcutTarget(document.body)).toBe(true);
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isDocumentShortcutTarget(editable)).toBe(false);
  });

  it("쓸 수 없는 명령의 단축키도 기본 동작(숨긴 입력의 되돌리기·저장 대화상자)을 막고 이유만 알린다", () => {
    const { target, executed } = fakeTarget(snapshot({ engine: "rhwp", history: null, format: null }));
    const { value, notices } = context(target);
    const event = keydown(editorInput(), { code: "KeyZ", key: "z", ctrlKey: true });
    expect(handleShortcut(event, value, false)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(executed).toEqual([]);
    expect(notices).toEqual([{ key: "command.unavailable.engineUnsupported", vars: { command: { key: "command.edit.undo" } } }]);
  });

  it("레지스트리에 없는 키(Ctrl+Q·글자)는 건드리지 않는다", () => {
    const { target, executed } = fakeTarget(snapshot());
    const { value } = context(target);
    for (const init of [{ code: "KeyQ", key: "q", ctrlKey: true }, { code: "KeyB", key: "b" }, { code: "KeyB", key: "b", ctrlKey: true, altKey: true }]) {
      const event = keydown(editorInput(), init);
      expect(handleShortcut(event, value, false)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(executed).toEqual([]);
  });

  it("문서 명령 ID 판별", () => {
    for (const id of DOCUMENT_IDS) expect(isDocumentCommandId(id)).toBe(true);
    expect(isDocumentCommandId("view.ribbon")).toBe(false);
    expect(isDocumentCommandId("toString")).toBe(false);
  });
});
