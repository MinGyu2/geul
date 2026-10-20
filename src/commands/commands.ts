// 리본·빠른 실행·단축키가 함께 쓰는 명령 실행 경계(T010 명령 레지스트리, src/commands/registry.ts).
//
// - 화면 배치·정보 명령(창·리본·테마·확대/축소·정보)은 여기서 실행한다.
// - 문서 명령은 활성 문서의 편집 세션(DocumentCommandTarget)에 보낸다. 가용성은 레지스트리의 엔진 지원과 그 세션의 지금
//   상태로 정하고(capability.ts), 세션이 실행 직전에 다시 확인한다. 엔진이 지원하지 않거나 아직 연결하지 않은 명령은
//   아무것도 바꾸지 않고 이유를 알린다(가짜 성공 없음).
import type { Message, MessageKey } from "../language";
import type { LayoutAction, LayoutState, Theme } from "../hooks/layoutState";
import { documentCommandState, ENABLED, unavailable, type CommandState } from "./capability";
import { commandDefinition, isDocumentCommandId } from "./registry";
import type { DocumentCommandTarget } from "./target";

export type { CommandState, UnavailableReason } from "./capability";

export interface CommandContext {
  layout: LayoutState;
  dispatch: (action: LayoutAction) => void;
  /** 상태 표시줄 알림. 번역된 문자열이 아니라 Message를 넘겨 언어가 바뀌어도 다시 번역되게 한다. */
  notify: (message: Message) => void;
  /** 활성 문서의 편집 세션(없으면 null). 문서 명령은 이 세션에만 간다. */
  document: DocumentCommandTarget | null;
}

interface UiCommand {
  state: (layout: LayoutState) => CommandState;
  run: (context: CommandContext) => void;
}

function themeCommand(theme: Theme): UiCommand {
  return {
    state: (layout) => ({ available: true, pressed: layout.theme === theme }),
    run: ({ dispatch }) => dispatch({ type: "setTheme", theme }),
  };
}

const UI_COMMANDS: Record<string, UiCommand> = {
  "view.navigation": {
    state: (layout) => ({ available: true, pressed: layout.navigationVisible }),
    run: ({ dispatch }) => dispatch({ type: "togglePanel", panel: "navigation" }),
  },
  "view.properties": {
    state: (layout) => ({ available: true, pressed: layout.propertiesVisible }),
    run: ({ dispatch }) => dispatch({ type: "togglePanel", panel: "properties" }),
  },
  "view.ribbon": {
    state: (layout) => ({ available: true, pressed: layout.ribbonCollapsed }),
    run: ({ dispatch }) => dispatch({ type: "toggleRibbon" }),
  },
  "view.theme.system": themeCommand("system"),
  "view.theme.light": themeCommand("light"),
  "view.theme.dark": themeCommand("dark"),
  "view.zoomOut": {
    state: (layout) => (layout.zoom > 50 ? ENABLED : unavailable("limit")),
    run: ({ dispatch }) => dispatch({ type: "zoom", direction: "out" }),
  },
  "view.zoomIn": {
    state: (layout) => (layout.zoom < 200 ? ENABLED : unavailable("limit")),
    run: ({ dispatch }) => dispatch({ type: "zoom", direction: "in" }),
  },
  "view.zoomReset": {
    state: () => ENABLED,
    run: ({ dispatch }) => dispatch({ type: "zoom", direction: "reset" }),
  },
  "help.about": {
    state: () => ENABLED,
    run: ({ notify }) => notify({ key: "command.about.message", vars: { version: __APP_VERSION__ } }),
  },
};

/** 화면 배치·정보 명령(객체의 상속 속성 이름은 명령이 아님). */
const uiCommand = (id: string): UiCommand | undefined =>
  Object.prototype.hasOwnProperty.call(UI_COMMANDS, id) ? UI_COMMANDS[id] : undefined;

export function commandState(id: string, context: Pick<CommandContext, "layout" | "document">): CommandState {
  const ui = uiCommand(id);
  if (ui) return ui.state(context.layout);
  if (isDocumentCommandId(id)) return documentCommandState(id, context.document?.snapshot() ?? null);
  return unavailable("notImplemented");
}

export function isUiCommand(id: string): boolean {
  return uiCommand(id) !== undefined;
}

/**
 * 명령을 실행한다. 사용할 수 없는 명령은 아무것도 바꾸지 않고 이유를 알린 뒤 false를 반환한다. 문서 명령은 활성 편집 세션의
 * 편집 경로에 넣었으면 true다(결과는 세션이 화면에 보인다). `labelKey`는 명령 이름의 번역 키다(알림에 참조로 넣어 그릴 때
 * 번역한다). 없으면 레지스트리의 라벨을 쓴다.
 */
export function executeCommand(id: string, labelKey: MessageKey | undefined, context: CommandContext): boolean {
  const label = labelKey ?? commandDefinition(id)?.labelKey;
  const reject = (state: CommandState) => {
    if (!state.available && label) {
      context.notify({ key: `command.unavailable.${state.reason}` as MessageKey, vars: { command: { key: label } } });
    }
    return false;
  };
  const state = commandState(id, context);
  if (!state.available) return reject(state);
  const ui = uiCommand(id);
  if (ui) {
    ui.run(context);
    return true;
  }
  if (!isDocumentCommandId(id) || !context.document) return reject(unavailable("notImplemented"));
  if (context.document.execute(id).accepted) return true;
  // 세션이 다시 확인해 거절했다(그 사이 상태가 바뀜): 지금 이유를 알린다.
  const now = commandState(id, context);
  return reject(now.available ? unavailable("notReady") : now);
}
