// 공통 명령 레지스트리(T010, FR-007). 명령마다 변하지 않는 ID, 번역 라벨 키, 단축키, 엔진별 지원을 한곳에 둔다.
//
// - 명령 ID 목록은 리본 정의(src/ribbon/definitions.ts)와 제목 표시줄이 쓰는 것이다. 리본은 화면 배치만 정하고 실행·가용성은
//   이 레지스트리를 거친다(T011이 상황별 리본을 붙인다).
// - 엔진 지원은 그 엔진에서 실제 동작을 확인한 명령만 "supported"다. 확인하지 못했거나 엔진에 기능이 없으면 "unsupported"(이
//   빌드에서 영구), 아직 이 앱에 구현하지 않은 명령은 "planned"(T011–T013 등)이며 둘 다 실행하지 않는다.
// - 단축키는 키보드 배열과 무관하게 물리 키(`KeyboardEvent.code`)로 맞춘다(한글 입력 상태에서도 Ctrl+Z가 같다). 모든 단축키는
//   Mod(Linux·Windows는 Ctrl, macOS는 Cmd)를 포함하거나 기능 키다(일반 글자 입력과 겹치지 않음). 같은 키를 둘이 쓰면 시험이 실패한다.
import type { EngineId } from "../adapters/contract";
import type { MessageKey } from "../language";
import { RIBBON_TABS, type RibbonTabDefinition } from "../ribbon/definitions";

/** 화면 배치·정보 명령(문서와 무관, src/commands/commands.ts의 UI 명령). */
export type LayoutCommandId =
  | "view.navigation" | "view.properties" | "view.ribbon"
  | "view.theme.system" | "view.theme.light" | "view.theme.dark"
  | "view.zoomOut" | "view.zoomIn" | "view.zoomReset"
  | "help.about";

/** 열린 문서에 대한 명령 중 이 앱이 엔진에 연결한 것. */
export type DocumentCommandId =
  | "edit.undo" | "edit.redo"
  | "format.bold" | "format.italic" | "format.underline" | "format.strikethrough"
  | "file.save";

/** 엔진 하나에서 명령의 지원. */
export type EngineSupport =
  | { level: "supported" }
  /** 이 빌드에서 그 엔진으로는 하지 않는다(엔진에 기능이 없거나, 쓰면 보존 규칙상 저장할 수 없는 문서가 됨). */
  | { level: "unsupported" };

export type CommandScope =
  /** 문서 입력·문서 밖 어디서나(입력 칸 안에서도) 받는 단축키. */
  | "global"
  /** 편집 표면의 입력이나 입력 칸 밖에서만 받는 단축키(입력 칸의 Ctrl+Z 등은 그 칸이 처리). */
  | "document";

export interface CommandDefinition {
  id: string;
  labelKey: MessageKey;
  kind: "layout" | "document" | "planned";
  /** 문서 명령의 엔진별 지원. */
  engines?: Record<EngineId, EngineSupport>;
  /** 단축키(예: "Mod+Z", "Mod+Shift+Z", "Mod+F1"). 첫 것이 안내에 보인다. */
  shortcuts?: readonly string[];
  scope?: CommandScope;
}

const SUPPORTED: EngineSupport = { level: "supported" };
const UNSUPPORTED: EngineSupport = { level: "unsupported" };

/**
 * 엔진별 지원(근거: docs/architecture/command-registry.md).
 * - WordCraft: 실행 취소·다시 실행은 엔진(`Session`)의 기록, 글자 서식은 WordCraft `format.*` 명령(Rust 시험·보존 검사 통과).
 * - rhwp: 고정 rhwp에는 실행 취소 기록이 없다(스냅숏 함수만 있고 기록은 rhwp studio 화면이 만든다). 앱이 따로 기록을 만들지
 *   않으므로 하지 않는다. 글자 서식은 HWP DocInfo 글자 모양·HWPX header.xml을 바꿔 T009 보존 검사가 저장을 막으므로 하지 않는다.
 * - 저장은 두 엔진 모두 기존 T009 저장 절차(사전 검사·출력 검사·게시)를 그대로 부른다.
 */
const DOCUMENT_COMMANDS: Record<DocumentCommandId, Omit<CommandDefinition, "id" | "labelKey" | "kind">> = {
  "edit.undo": { engines: { wordcraft: SUPPORTED, rhwp: UNSUPPORTED }, shortcuts: ["Mod+Z"], scope: "document" },
  "edit.redo": { engines: { wordcraft: SUPPORTED, rhwp: UNSUPPORTED }, shortcuts: ["Mod+Y", "Mod+Shift+Z"], scope: "document" },
  "format.bold": { engines: { wordcraft: SUPPORTED, rhwp: UNSUPPORTED }, shortcuts: ["Mod+B"], scope: "document" },
  "format.italic": { engines: { wordcraft: SUPPORTED, rhwp: UNSUPPORTED }, shortcuts: ["Mod+I"], scope: "document" },
  "format.underline": { engines: { wordcraft: SUPPORTED, rhwp: UNSUPPORTED }, shortcuts: ["Mod+U"], scope: "document" },
  "format.strikethrough": { engines: { wordcraft: SUPPORTED, rhwp: UNSUPPORTED } },
  "file.save": { engines: { wordcraft: SUPPORTED, rhwp: SUPPORTED }, shortcuts: ["Mod+S"], scope: "document" },
};

const LAYOUT_COMMANDS: Record<LayoutCommandId, Omit<CommandDefinition, "id" | "labelKey" | "kind">> = {
  "view.navigation": {},
  "view.properties": {},
  "view.ribbon": { shortcuts: ["Mod+F1"], scope: "global" },
  "view.theme.system": {},
  "view.theme.light": {},
  "view.theme.dark": {},
  "view.zoomOut": {},
  "view.zoomIn": {},
  "view.zoomReset": {},
  "help.about": {},
};

const label = (id: string) => `command.${id}` as MessageKey;

type Declarations = Record<string, Omit<CommandDefinition, "id" | "labelKey" | "kind">>;

/**
 * 레지스트리를 만든다. 같은 ID를 두 번 선언하면 덮어쓰지 않고(처음 것을 둠) 문제로 적는다: 리본 안의 중복, 배치·문서 명령
 * 표 사이의 중복, 리본이 연결한 명령과 다른 라벨로 선언한 경우. 문제는 비어 있어야 한다(시험).
 */
export function buildRegistry(
  tabs: readonly RibbonTabDefinition[],
  layout: Declarations,
  document: Declarations,
): { commands: ReadonlyMap<string, CommandDefinition>; problems: string[] } {
  const registry = new Map<string, CommandDefinition>();
  const problems: string[] = [];
  // 리본에 있는 명령 모두(아직 연결하지 않은 것은 planned).
  for (const tab of tabs) {
    for (const group of tab.groups) {
      for (const command of group.commands) {
        if (registry.has(command.id)) problems.push(`${command.id}: duplicate ribbon command (${tab.id}/${group.id})`);
        else registry.set(command.id, { id: command.id, labelKey: command.labelKey, kind: "planned" });
      }
    }
  }
  const connected = new Set<string>();
  const declare = (kind: "layout" | "document", declarations: Declarations) => {
    for (const [id, definition] of Object.entries(declarations)) {
      if (connected.has(id)) {
        problems.push(`${id}: declared as more than one kind of command`);
        continue;
      }
      connected.add(id);
      const ribbon = registry.get(id);
      if (ribbon && ribbon.labelKey !== label(id)) problems.push(`${id}: ribbon label ${ribbon.labelKey} differs from ${label(id)}`);
      registry.set(id, { id, labelKey: label(id), kind, ...definition });
    }
  };
  declare("layout", layout);
  declare("document", document);
  return { commands: registry, problems };
}

const BUILT = buildRegistry(RIBBON_TABS, LAYOUT_COMMANDS, DOCUMENT_COMMANDS);

export const COMMANDS: ReadonlyMap<string, CommandDefinition> = BUILT.commands;

/** 명령 정의 오류(중복 ID·다른 종류로 두 번 선언·리본과 다른 라벨). 비어 있어야 한다(시험). */
export const COMMAND_PROBLEMS: readonly string[] = BUILT.problems;

export function commandDefinition(id: string): CommandDefinition | undefined {
  return COMMANDS.get(id);
}

export function isDocumentCommandId(id: string): id is DocumentCommandId {
  return Object.prototype.hasOwnProperty.call(DOCUMENT_COMMANDS, id);
}

// ---- 단축키 ----

/** 정규화한 단축키: "Mod+Alt+Shift+<code>" 순서(있는 것만). code는 KeyboardEvent.code(KeyZ, F1 등). */
export type ShortcutKey = string;

const MODIFIERS = ["Mod", "Alt", "Shift"] as const;

/** 선언("Mod+Shift+Z")을 정규화한다. 글자 하나는 그 물리 키(KeyZ), 그 밖(F1 등)은 그대로. 형식이 틀리면 null. */
export function parseShortcut(text: string): ShortcutKey | null {
  const parts = text.split("+");
  const key = parts.pop() ?? "";
  if (parts.some((part) => !MODIFIERS.includes(part as (typeof MODIFIERS)[number])) || new Set(parts).size !== parts.length) {
    return null;
  }
  const code = /^[A-Z]$/.test(key) ? `Key${key}` : /^F([1-9]|1[0-2])$/.test(key) ? key : null;
  if (!code) return null;
  return [...MODIFIERS.filter((modifier) => parts.includes(modifier)), code].join("+");
}

/**
 * 물리 키를 알려 주지 않는 키 입력(code가 비었거나 "Unidentified"·"Unknown")만 key로 대신한다: 기능 키와 로마자 한 글자. 한글 배열 등
 * 로마자가 아닌 글자는 맞추지 않는다(실제 WebView 키 입력은 code가 있다).
 */
function codeFromKey(event: Pick<KeyboardEvent, "code" | "key">): string | null {
  if (event.code && event.code !== "Unidentified" && event.code !== "Unknown") return null;
  if (/^F([1-9]|1[0-2])$/.test(event.key)) return event.key;
  return /^[a-zA-Z]$/.test(event.key) ? `Key${event.key.toUpperCase()}` : null;
}

/** 키 입력을 정규화한다. Mod가 아닌 쪽의 Ctrl/Cmd가 눌렸거나 단축키가 될 수 없으면 null. */
export function eventShortcut(
  event: Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  mac: boolean,
): ShortcutKey | null {
  const mod = mac ? event.metaKey : event.ctrlKey;
  const other = mac ? event.ctrlKey : event.metaKey;
  if (other) return null;
  const code = /^Key[A-Z]$/.test(event.code) || /^F([1-9]|1[0-2])$/.test(event.code) ? event.code : codeFromKey(event);
  if (!code) return null;
  return [mod && "Mod", event.altKey && "Alt", event.shiftKey && "Shift", code].filter(Boolean).join("+");
}

function buildShortcuts(): { map: ReadonlyMap<ShortcutKey, string>; conflicts: string[] } {
  const map = new Map<ShortcutKey, string>();
  const conflicts: string[] = [];
  for (const definition of COMMANDS.values()) {
    for (const text of definition.shortcuts ?? []) {
      const key = parseShortcut(text);
      if (!key) {
        conflicts.push(`${definition.id}: invalid ${text}`);
        continue;
      }
      const owner = map.get(key);
      if (owner) conflicts.push(`${key}: ${owner}, ${definition.id}`);
      else map.set(key, definition.id);
    }
  }
  return { map, conflicts };
}

const SHORTCUTS = buildShortcuts();

/** 정의 오류(형식이 틀린 단축키, 같은 키를 둘이 씀). 비어 있어야 한다(시험). */
export const SHORTCUT_PROBLEMS: readonly string[] = SHORTCUTS.conflicts;

/** 정규화한 단축키의 명령. */
export function commandForShortcut(key: ShortcutKey): CommandDefinition | undefined {
  const id = SHORTCUTS.map.get(key);
  return id ? COMMANDS.get(id) : undefined;
}

/** 안내용 단축키 글자(예: "Ctrl+Shift+Z", macOS는 "⌘⇧Z" 대신 "Cmd+Shift+Z"). */
export function shortcutLabel(text: string, mac: boolean): string {
  return text.replace(/^Mod\+/, mac ? "Cmd+" : "Ctrl+");
}
