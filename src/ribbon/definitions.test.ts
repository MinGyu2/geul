import { describe, expect, it } from "vitest";
import { commandState, isUiCommand } from "../commands/commands";
import { isDocumentCommandId } from "../commands/registry";
import { initialLayout } from "../hooks/layoutState";
import { isMessageKey } from "../language";
import { RIBBON_TABS } from "./definitions";

const commands = RIBBON_TABS.flatMap((tab) => tab.groups.flatMap((group) => group.commands));

describe("리본 정의", () => {
  it("FR-008의 공통 탭과 한글 도구 탭을 모두 포함한다", () => {
    expect(RIBBON_TABS.map((tab) => tab.id)).toEqual([
      "file", "home", "insert", "draw", "design", "layout", "hangulTools", "references", "mailings", "review",
      "view", "help",
    ]);
  });

  it("모든 탭·그룹·명령 라벨은 번역 키로 존재한다", () => {
    const keys = RIBBON_TABS.flatMap((tab) => [tab.labelKey, ...tab.groups.map((group) => group.labelKey)]);
    keys.push(...commands.map((command) => command.labelKey));
    expect(keys.filter((key) => !isMessageKey(key))).toEqual([]);
  });

  it("명령 ID는 중복되지 않는다", () => {
    const ids = commands.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("열린 문서가 없으면 화면 배치·정보 명령 외에는 쓸 수 없다(연결한 문서 명령은 noDocument, 나머지는 notImplemented)", () => {
    const documentCommands = commands.filter((command) => !isUiCommand(command.id));
    expect(documentCommands.length).toBeGreaterThan(30);
    for (const command of documentCommands) {
      expect(commandState(command.id, { layout: initialLayout, document: null })).toEqual({
        available: false,
        reason: isDocumentCommandId(command.id) ? "noDocument" : "notImplemented",
      });
    }
    expect(commands.filter((command) => isUiCommand(command.id)).map((command) => command.id.split(".")[0]))
      .toSatisfy((prefixes: string[]) => prefixes.every((prefix) => prefix === "view" || prefix === "help"));
  });
});
