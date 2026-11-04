// 리본 탭 표시(T011): 형식 → 탭 묶음, 사라진 탭의 대신 고르기, 형식 전용 탭 명령과 단축키의 경계.
import { describe, expect, it } from "vitest";
import type { DocumentFormat } from "../adapters/contract";
import { commandState } from "../commands/commands";
import { COMMANDS, commandDefinition } from "../commands/registry";
import type { DocumentCommandSnapshot, DocumentCommandTarget } from "../commands/target";
import { initialLayout } from "../hooks/layoutState";
import { RIBBON_TABS } from "./definitions";
import { resolveActiveRibbonTab, ribbonFormatFor, visibleRibbonTabs } from "./visibility";

const ids = (format: DocumentFormat | null) => visibleRibbonTabs(format).map((tab) => tab.id);
const COMMON = ["file", "home", "insert", "draw", "design", "layout", "review", "view", "help"];

describe("형식 → 리본 묶음", () => {
  it("HWP·HWPX는 한글 묶음, DOCX는 DOCX 묶음, 문서 없음·모르는 값은 null(추측하지 않음)", () => {
    expect(ribbonFormatFor("hwp")).toBe("hwp");
    expect(ribbonFormatFor("hwpx")).toBe("hwp");
    expect(ribbonFormatFor("docx")).toBe("docx");
    expect(ribbonFormatFor(null)).toBeNull();
    expect(ribbonFormatFor(undefined)).toBeNull();
    // 계약 밖 값(확장자·엔진 ID·객체 속성 이름)은 형식으로 보지 않는다.
    for (const value of ["pdf", "doc", "rhwp", "wordcraft", "HWP", "toString", "__proto__", ""]) {
      expect(ribbonFormatFor(value as DocumentFormat)).toBeNull();
    }
  });
});

describe("보이는 탭", () => {
  it("A01 문서 없음: 공통 탭만(정의 순서)", () => {
    expect(ids(null)).toEqual(COMMON);
  });

  it("A02 DOCX: 공통 + 참조·편지, 한글 도구 없음", () => {
    expect(ids("docx")).toEqual(["file", "home", "insert", "draw", "design", "layout", "references", "mailings", "review", "view", "help"]);
  });

  it("A03/A04 HWP·HWPX: 공통 + 한글 도구(같은 탭 정의), 참조·편지 없음", () => {
    const hangul = ["file", "home", "insert", "draw", "design", "layout", "hangulTools", "review", "view", "help"];
    expect(ids("hwp")).toEqual(hangul);
    expect(ids("hwpx")).toEqual(hangul);
    expect(visibleRibbonTabs("hwp")).toEqual(visibleRibbonTabs("hwpx"));
  });

  it("모르는 형식은 공통 탭만 보인다", () => {
    expect(ids("odt" as DocumentFormat)).toEqual(COMMON);
  });

  it("모든 형식에서 공통 탭은 그대로이고 기본 탭(홈)이 보인다", () => {
    for (const format of [null, "hwp", "hwpx", "docx"] as const) {
      expect(ids(format).filter((id) => COMMON.includes(id))).toEqual(COMMON);
    }
  });
});

describe("A07 사라진 탭 대신 고르기", () => {
  it("고른 탭이 보이면 그대로, 사라지면 홈, 홈도 없으면 첫 탭, 탭이 없으면 null", () => {
    expect(resolveActiveRibbonTab("references", visibleRibbonTabs("docx"))?.id).toBe("references");
    expect(resolveActiveRibbonTab("references", visibleRibbonTabs("hwpx"))?.id).toBe("home");
    expect(resolveActiveRibbonTab("hangulTools", visibleRibbonTabs(null))?.id).toBe("home");
    expect(resolveActiveRibbonTab("missing", RIBBON_TABS.filter((tab) => tab.id !== "home"))?.id).toBe("file");
    expect(resolveActiveRibbonTab("home", [])).toBeNull();
  });
});

describe("형식 전용 탭의 명령", () => {
  const formatOnly = RIBBON_TABS.filter((tab) => tab.format).flatMap((tab) => tab.groups.flatMap((group) => group.commands));

  // T012에서 rhwp에 연결한 값 입력 명령. 세션이 문맥(parameters)을 내지 않으면 여전히 쓸 수 없다.
  const CONNECTED = new Set(["hangul.charWidth", "hangul.charSpacing", "hangul.tableFormula"]);

  it("A10/A13 연결하지 않은 명령은 계획 명령이라 어떤 문서 상태에서도 실행할 수 없고(notImplemented), 연결한 값 입력 명령도 세션 문맥 없이는 막힌다", () => {
    expect(formatOnly.length).toBeGreaterThan(0);
    // 편집 가능·조합 없음·기록·서식 상태까지 모두 있는 가장 너그러운 스냅숏이어도 막힌다.
    for (const engine of ["rhwp", "wordcraft"] as const) {
      const snapshot: DocumentCommandSnapshot = {
        sessionId: 1, engine, loadGeneration: 1, revision: 0, loaded: true, editable: true, composing: false, pending: false,
        queuedHistory: null, saving: false, history: { undo: true, redo: true },
        format: { bold: false, italic: false, underline: false, strikethrough: false }, formatAccess: "allowed",
      };
      const target: DocumentCommandTarget = { sessionId: 1, engine, snapshot: () => snapshot, execute: () => ({ accepted: true }) };
      for (const command of formatOnly) {
        if (CONNECTED.has(command.id)) {
          expect(commandDefinition(command.id)?.kind, command.id).toBe("document");
          expect(commandState(command.id, { layout: initialLayout, document: target }).available, command.id).toBe(false);
          continue;
        }
        expect(commandDefinition(command.id)?.kind, command.id).toBe("planned");
        expect(commandState(command.id, { layout: initialLayout, document: target })).toEqual({ available: false, reason: "notImplemented" });
      }
    }
  });

  it("A11 단축키가 있는 명령은 모두 공통 탭에 있거나 리본 밖이다(숨은 탭의 명령을 단축키로만 부를 수 없음)", () => {
    const formatOnlyIds = new Set(formatOnly.map((command) => command.id));
    const withShortcut = [...COMMANDS.values()].filter((definition) => (definition.shortcuts?.length ?? 0) > 0);
    expect(withShortcut.length).toBeGreaterThan(0);
    expect(withShortcut.filter((definition) => formatOnlyIds.has(definition.id)).map((definition) => definition.id)).toEqual([]);
  });
});
