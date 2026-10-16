// 6영역 화면의 UI 상태. 문서 상태와 분리되어 있으며 T005에서 설정 저장·복원 대상이 된다.

export type Theme = "system" | "light" | "dark";
export type SidePanel = "navigation" | "properties";

export interface LayoutState {
  navigationVisible: boolean;
  propertiesVisible: boolean;
  navigationWidth: number;
  propertiesWidth: number;
  ribbonCollapsed: boolean;
  theme: Theme;
  zoom: number;
}

export const PANEL_LIMITS: Record<SidePanel, { min: number; max: number; initial: number }> = {
  navigation: { min: 180, max: 420, initial: 240 },
  properties: { min: 220, max: 460, initial: 280 },
};
/** 패널을 넓혀도 중앙 편집 영역이 이보다 좁아지지 않는다. */
export const EDITOR_MIN_WIDTH = 360;
export const ZOOM_STEPS = [50, 67, 75, 90, 100, 110, 125, 150, 175, 200] as const;
export const THEMES: readonly Theme[] = ["system", "light", "dark"];

export const initialLayout: LayoutState = {
  navigationVisible: true,
  propertiesVisible: true,
  navigationWidth: PANEL_LIMITS.navigation.initial,
  propertiesWidth: PANEL_LIMITS.properties.initial,
  ribbonCollapsed: false,
  theme: "system",
  zoom: 100,
};

export type LayoutAction =
  | { type: "togglePanel"; panel: SidePanel }
  | { type: "setPanelVisible"; panel: SidePanel; visible: boolean }
  | { type: "resizePanel"; panel: SidePanel; width: number }
  | { type: "toggleRibbon" }
  | { type: "setRibbonCollapsed"; collapsed: boolean }
  | { type: "setTheme"; theme: Theme }
  | { type: "cycleTheme" }
  | { type: "zoom"; direction: "in" | "out" | "reset" };

export function clampPanelWidth(panel: SidePanel, width: number): number {
  const { min, max } = PANEL_LIMITS[panel];
  return Math.round(Math.min(max, Math.max(min, width)));
}

function nextZoom(current: number, direction: "in" | "out" | "reset"): number {
  if (direction === "reset") return 100;
  if (direction === "in") return ZOOM_STEPS.find((step) => step > current) ?? current;
  return [...ZOOM_STEPS].reverse().find((step) => step < current) ?? current;
}

export function layoutReducer(state: LayoutState, action: LayoutAction): LayoutState {
  switch (action.type) {
    case "togglePanel":
      return action.panel === "navigation"
        ? { ...state, navigationVisible: !state.navigationVisible }
        : { ...state, propertiesVisible: !state.propertiesVisible };
    case "setPanelVisible":
      return action.panel === "navigation"
        ? { ...state, navigationVisible: action.visible }
        : { ...state, propertiesVisible: action.visible };
    case "resizePanel": {
      const width = clampPanelWidth(action.panel, action.width);
      return action.panel === "navigation"
        ? { ...state, navigationWidth: width }
        : { ...state, propertiesWidth: width };
    }
    case "toggleRibbon":
      return { ...state, ribbonCollapsed: !state.ribbonCollapsed };
    case "setRibbonCollapsed":
      return { ...state, ribbonCollapsed: action.collapsed };
    case "setTheme":
      return { ...state, theme: action.theme };
    case "cycleTheme":
      return { ...state, theme: THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length] ?? "system" };
    case "zoom":
      return { ...state, zoom: nextZoom(state.zoom, action.direction) };
  }
}

/**
 * 창 너비가 좁을 때 실제로 그릴 패널 너비. 중앙 편집 영역이 EDITOR_MIN_WIDTH 이상이 되도록
 * 패널을 줄이되 각 패널의 최소 너비보다 작게 만들지는 않는다(창 최소 크기는 tauri.conf.json에서 보장).
 */
export function effectivePanelWidths(state: LayoutState, viewportWidth: number) {
  let navigation = state.navigationVisible ? state.navigationWidth : 0;
  let properties = state.propertiesVisible ? state.propertiesWidth : 0;
  let overflow = navigation + properties + EDITOR_MIN_WIDTH - viewportWidth;
  if (overflow > 0 && properties > 0) {
    const reduced = Math.max(PANEL_LIMITS.properties.min, properties - overflow);
    overflow -= properties - reduced;
    properties = reduced;
  }
  if (overflow > 0 && navigation > 0) {
    navigation = Math.max(PANEL_LIMITS.navigation.min, navigation - overflow);
  }
  return { navigation, properties };
}

/** 다른 패널과 편집 영역 최소 너비를 고려한 패널 최대 너비(크기 조절 핸들의 aria-valuemax). */
export function panelMaxWidth(state: LayoutState, panel: SidePanel, viewportWidth: number): number {
  const other = panel === "navigation"
    ? (state.propertiesVisible ? state.propertiesWidth : 0)
    : (state.navigationVisible ? state.navigationWidth : 0);
  const { min, max } = PANEL_LIMITS[panel];
  return Math.max(min, Math.min(max, viewportWidth - other - EDITOR_MIN_WIDTH));
}
