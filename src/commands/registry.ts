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

/** 문서와 무관하게 실행하는 화면 배치·정보 명령. */
export type LayoutCommandId =
  | "view.navigation" | "view.properties" | "view.ribbon"
  | "view.theme.system" | "view.theme.light" | "view.theme.dark"
  | "view.zoomOut" | "view.zoomIn" | "view.zoomReset"
  | "help.about";

/** Native file workflows implemented by the application. */
export type FileCommandId = "file.new" | "file.open" | "file.saveAs";

/** 열린 문서에 대한 명령 중 이 앱이 엔진에 연결한 것. */
export type DocumentCommandId =
  | "edit.undo" | "edit.redo" | "edit.copy" | "edit.cut" | "edit.paste"
  | "format.bold" | "format.italic" | "format.underline" | "format.strikethrough"
  | "hangul.charWidth" | "hangul.charSpacing" | "hangul.tableFormula" | "hangul.insertTableFormula"
  | "review.comment"
  | "references.footnote" | "references.endnote"
  | "references.toc" | "references.updateToc"
  | "review.trackChanges" | "review.acceptChange" | "review.rejectChange" | "review.acceptAll" | "review.rejectAll"
  | "insert.table" | "insert.image" | "paragraph.bullets"
  | "file.save";

/** 엔진 하나에서 명령의 지원. */
export type EngineSupport =
  | { level: "supported"; historyScope?: "advanced" }
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
  kind: "layout" | "document" | "file" | "planned";
  /** 문서 명령의 엔진별 지원. */
  engines?: Record<EngineId, EngineSupport>;
  /** 단축키(예: "Mod+Z", "Mod+Shift+Z", "Mod+F1"). 첫 것이 안내에 보인다. */
  shortcuts?: readonly string[];
  scope?: CommandScope;
}

const SUPPORTED: EngineSupport = { level: "supported" };
const UNSUPPORTED: EngineSupport = { level: "unsupported" };

/** General RHWP typing/IME history (T010). Runtime availability still follows the session's actual
 * history state (ready, no IME transaction, entries present, limits, generation). The former test-only
 * activation flag is no longer required; T012 advanced commands keep their own session-level bounds. */
const RHWP_HISTORY: EngineSupport = SUPPORTED;

/**
 * 시험 빌드 전용 rhwp 글자 서식(T010 서식): 검사 훅 빌드이면서 `VITE_GEUL_TEST_RHWP_FORMAT=1`일 때만 지원으로 본다(위와 같은 빌드 상수).
 * 세션은 HWPX이고 선택이 있고 실행 취소 기록이 켜져 있을 때만 서식 상태를 내므로 HWP·선택 없음·기록 없음은 계속 막힌다.
 */
const RHWP_FORMAT: EngineSupport =
  import.meta.env.VITE_GEUL_TEST_HOOKS === "1" && import.meta.env.VITE_GEUL_TEST_RHWP_FORMAT === "1"
    ? (console.info("geul-test-build: rhwp-format-commands"), SUPPORTED)
    : UNSUPPORTED;

/**
 * 엔진별 지원(근거: docs/architecture/command-registry.md).
 * - WordCraft: 실행 취소·다시 실행은 엔진(`Session`)의 기록, 글자 서식은 WordCraft `format.*` 명령(Rust 시험·보존 검사 통과).
 * - rhwp: 일반 입력·IME history의 실행 취소·다시 실행(T010 제품 활성화 2026-11-12). 가용성은 세션 기록 상태로 정한다.
 *   일반 굵게·기울임 등의 서식은 여전히 시험 구성 전용이다.
 * - 저장은 두 엔진 모두 기존 T009 저장 절차(사전 검사·출력 검사·게시)를 그대로 부른다.
 * - 장평·자간(T012): 독립 제품 capability. HWP/HWPX 단일 문단 선택·실제 문자 모양 ownership API·고급 기록이 필요하다.
 *   WordCraft에는 같은 의미의 명령을 연결하지 않았다.
 * - 표 계산(T012): rhwp `evaluateTableFormula(writeResult=false)` — 문서를 바꾸지 않는 읽기 전용 계산이라 HWP·HWPX 모두 제품에서
 *   지원한다. 영속 계산식은 별도 `hangul.insertTableFormula`의 검증된 field API로만 생성/교체/명시적 재계산한다.
 *   값만 쓰는 `writeResult=true`는 연결하지 않는다.
 * - 새 메모(T013): WordCraft `review.newComment`(앱 ID `review.comment`, 고정 DocxOp `comment`). 저장은 메모 부분을 새로 더하거나 기존
 *   메모 끝에 덧붙인 출력만 T009가 받는다. rhwp에는 연결하지 않았다.
 * - 각주·미주(T013): WordCraft `references.footnote`·`references.endnote`(고정 DocxOp `footnote`·`endnote`, 글 한 줄). 본문 최상위
 *   문단의 커서(선택 없음)에서만 하고, 실행 뒤 커서는 본문의 표지 뒤로 돌아온다. 저장은 각주·미주 부분을 새로 더하거나(목록·관계·
 *   settings 구분선 참조 두 개만 함께) 기존 각주를 그대로 둔 채 새 각주만 더한 출력만 T009가 받는다.
 * - 목차(T013 Stage 2): WordCraft `references.toc`·`references.updateToc`(고정 DocxOp `toc`·`updateToc`, 인자 없음). 넣기는 본문 최상위
 *   문단의 커서(선택 없음)에서, 갱신은 본문에 목차가 있을 때(엔진 보기 `hasToc`)만. 엔진 왕복 수정(WordCraft `af80638`) 뒤 출력은
 *   본문 부분만 바뀌어 T009 기존 규칙을 그대로 통과한다.
 * - 변경 내용 추적(T013 Stage 3): WordCraft `review.trackChanges`(값 명시)·`review.accept`·`review.reject`·`review.acceptAll`·
 *   `review.rejectAll`(고정 DocxOp). 수정 기록 색인 일대일 비교(WordCraft `b74830b`) 뒤 추적 편집·IME 교정·수락·거절 출력이 저장 검증을
 *   통과해 이미 추적 중인 문서의 읽기 전용 정책도 풀었다. 저장은 settings의 맨 `w:trackRevisions` 하나의 있고 없음만 더 받는다.
 */
// Production advanced mutations require actual session capabilities and a history transaction
// within the conditional T012 bounds. General RHWP formatting remains test-only.
const RHWP_ADVANCED: EngineSupport = SUPPORTED;

const DOCUMENT_COMMANDS: Record<DocumentCommandId, Omit<CommandDefinition, "id" | "labelKey" | "kind">> = {
  "edit.copy": { engines: { wordcraft: SUPPORTED, rhwp: SUPPORTED }, shortcuts: ["Mod+C"], scope: "document" },
  "edit.cut": { engines: { wordcraft: SUPPORTED, rhwp: SUPPORTED }, shortcuts: ["Mod+X"], scope: "document" },
  "edit.paste": { engines: { wordcraft: SUPPORTED, rhwp: SUPPORTED }, shortcuts: ["Mod+V"], scope: "document" },
  "edit.undo": { engines: { wordcraft: SUPPORTED, rhwp: RHWP_HISTORY }, shortcuts: ["Mod+Z"], scope: "document" },
  "edit.redo": { engines: { wordcraft: SUPPORTED, rhwp: RHWP_HISTORY }, shortcuts: ["Mod+Y", "Mod+Shift+Z"], scope: "document" },
  "format.bold": { engines: { wordcraft: SUPPORTED, rhwp: RHWP_FORMAT }, shortcuts: ["Mod+B"], scope: "document" },
  "format.italic": { engines: { wordcraft: SUPPORTED, rhwp: RHWP_FORMAT }, shortcuts: ["Mod+I"], scope: "document" },
  "format.underline": { engines: { wordcraft: SUPPORTED, rhwp: RHWP_FORMAT }, shortcuts: ["Mod+U"], scope: "document" },
  "format.strikethrough": { engines: { wordcraft: SUPPORTED, rhwp: RHWP_FORMAT } },
  "hangul.charWidth": { engines: { wordcraft: UNSUPPORTED, rhwp: RHWP_ADVANCED } },
  "hangul.charSpacing": { engines: { wordcraft: UNSUPPORTED, rhwp: RHWP_ADVANCED } },
  "hangul.tableFormula": { engines: { wordcraft: UNSUPPORTED, rhwp: SUPPORTED } },
  "hangul.insertTableFormula": { engines: { wordcraft: UNSUPPORTED, rhwp: RHWP_ADVANCED } },
  "review.comment": { engines: { wordcraft: SUPPORTED, rhwp: UNSUPPORTED } },
  "references.footnote": { engines: { wordcraft: SUPPORTED, rhwp: UNSUPPORTED } },
  "references.endnote": { engines: { wordcraft: SUPPORTED, rhwp: UNSUPPORTED } },
  "references.toc": { engines: { wordcraft: SUPPORTED, rhwp: UNSUPPORTED } },
  "references.updateToc": { engines: { wordcraft: SUPPORTED, rhwp: UNSUPPORTED } },
  "review.trackChanges": { engines: { wordcraft: SUPPORTED, rhwp: UNSUPPORTED } },
  "review.acceptChange": { engines: { wordcraft: SUPPORTED, rhwp: UNSUPPORTED } },
  "review.rejectChange": { engines: { wordcraft: SUPPORTED, rhwp: UNSUPPORTED } },
  "review.acceptAll": { engines: { wordcraft: SUPPORTED, rhwp: UNSUPPORTED } },
  "review.rejectAll": { engines: { wordcraft: SUPPORTED, rhwp: UNSUPPORTED } },
  "paragraph.bullets": { engines: { wordcraft: SUPPORTED, rhwp: SUPPORTED } },
  "insert.image": { engines: { wordcraft: SUPPORTED, rhwp: SUPPORTED } },
  "insert.table": { engines: { wordcraft: SUPPORTED, rhwp: SUPPORTED } },
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

const FILE_COMMANDS: Record<FileCommandId, Omit<CommandDefinition, "id" | "labelKey" | "kind">> = {
  "file.new": { shortcuts: ["Mod+N"], scope: "global" },
  "file.open": { shortcuts: ["Mod+O"], scope: "global" },
  "file.saveAs": { shortcuts: ["Mod+Shift+S"], scope: "global" },
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
  files: Declarations = {},
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
  const declare = (kind: "layout" | "document" | "file", declarations: Declarations) => {
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
  declare("file", files);
  return { commands: registry, problems };
}

const BUILT = buildRegistry(RIBBON_TABS, LAYOUT_COMMANDS, DOCUMENT_COMMANDS, FILE_COMMANDS);

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
