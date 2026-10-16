// 리본·빠른 실행·단축키가 함께 쓰는 명령 실행 경계.
//
// 지금 동작하는 명령은 화면 배치(창·리본·테마·확대/축소)와 정보 표시뿐이다. 문서 명령(열기, 저장,
// 실행 취소, 서식 등)은 모두 "사용할 수 없음"을 보고하고 실행되지 않는다. 엔진별 capability, 선택 영역,
// 실행 취소 연결은 T006(어댑터·세션), T010(명령 레지스트리)에서 이 경계 뒤에 붙인다.
import type { Message, MessageKey } from "../language";
import type { LayoutAction, LayoutState, Theme } from "../hooks/layoutState";

export type CommandState =
  | { available: true; pressed?: boolean }
  | { available: false; reason: MessageKey };

export interface CommandContext {
  layout: LayoutState;
  dispatch: (action: LayoutAction) => void;
  /** 상태 표시줄 알림. 번역된 문자열이 아니라 Message를 넘겨 언어가 바뀌어도 다시 번역되게 한다. */
  notify: (message: Message) => void;
}

interface UiCommand {
  state: (layout: LayoutState) => CommandState;
  run: (context: CommandContext) => void;
}

const enabled: CommandState = { available: true };

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
    state: (layout) => (layout.zoom > 50 ? enabled : { available: false, reason: "command.unavailable.hint" }),
    run: ({ dispatch }) => dispatch({ type: "zoom", direction: "out" }),
  },
  "view.zoomIn": {
    state: (layout) => (layout.zoom < 200 ? enabled : { available: false, reason: "command.unavailable.hint" }),
    run: ({ dispatch }) => dispatch({ type: "zoom", direction: "in" }),
  },
  "view.zoomReset": {
    state: () => enabled,
    run: ({ dispatch }) => dispatch({ type: "zoom", direction: "reset" }),
  },
  "help.about": {
    state: () => enabled,
    run: ({ notify }) => notify({ key: "command.about.message", vars: { version: __APP_VERSION__ } }),
  },
};

const NO_ENGINE: CommandState = { available: false, reason: "command.unavailable.noEngine" };

export function commandState(id: string, layout: LayoutState): CommandState {
  return UI_COMMANDS[id]?.state(layout) ?? NO_ENGINE;
}

export function isUiCommand(id: string): boolean {
  return id in UI_COMMANDS;
}

/**
 * 명령을 실행한다. 사용할 수 없는 명령은 아무것도 바꾸지 않고 이유를 알린 뒤 false를 반환한다.
 * `labelKey`는 명령 이름의 번역 키다(알림에 참조로 넣어 그릴 때 번역한다).
 */
export function executeCommand(id: string, labelKey: MessageKey, context: CommandContext): boolean {
  const command = UI_COMMANDS[id];
  const state = commandState(id, context.layout);
  if (!command || !state.available) {
    if (!state.available && state.reason === "command.unavailable.noEngine") {
      context.notify({ key: "command.unavailable.noEngine", vars: { command: { key: labelKey } } });
    }
    return false;
  }
  command.run(context);
  return true;
}
