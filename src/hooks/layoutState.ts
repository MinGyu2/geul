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

export interface PanelBounds {
  visible: boolean;
  /** 실제로 그리는 너비(숨김이면 0). 크기 조절 핸들의 aria-valuenow. */
  width: number;
  min: number;
  /** 다른 패널의 실제 너비와 편집 영역 최소 너비를 뺀 최대 너비. 크기 조절 핸들의 aria-valuemax. */
  max: number;
}

export interface PanelLayout {
  navigation: PanelBounds;
  properties: PanelBounds;
  editorWidth: number;
}

/**
 * 화면 배치의 단일 계산. 그리는 너비와 크기 조절 범위를 같은 값에서 구하므로
 * min <= width <= max가 항상 성립한다(지원하는 최소 창 너비 960px 이상에서 편집 영역도 360px 이상).
 *
 * 창이 좁으면 오른쪽 속성 창부터 최소 너비까지 줄이고, 그래도 모자라면 탐색 창을 줄인다.
 * 사용자가 정한 너비(state)는 바꾸지 않으므로 창이 다시 넓어지면 원래 너비로 돌아간다.
 */
export function computePanelLayout(state: LayoutState, viewportWidth: number): PanelLayout {
  const viewport = Math.max(0, viewportWidth);
  let navigation = state.navigationVisible ? state.navigationWidth : 0;
  let properties = state.propertiesVisible ? state.propertiesWidth : 0;
  let overflow = navigation + properties + EDITOR_MIN_WIDTH - viewport;
  if (overflow > 0 && properties > 0) {
    const reduced = Math.max(PANEL_LIMITS.properties.min, properties - overflow);
    overflow -= properties - reduced;
    properties = reduced;
  }
  if (overflow > 0 && navigation > 0) {
    navigation = Math.max(PANEL_LIMITS.navigation.min, navigation - overflow);
  }
  const widths: Record<SidePanel, number> = { navigation, properties };

  const bounds = (panel: SidePanel, other: SidePanel): PanelBounds => {
    const { min, max } = PANEL_LIMITS[panel];
    const visible = panel === "navigation" ? state.navigationVisible : state.propertiesVisible;
    const available = viewport - EDITOR_MIN_WIDTH - widths[other];
    return { visible, width: widths[panel], min, max: Math.max(min, Math.min(max, available)) };
  };
  return {
    navigation: bounds("navigation", "properties"),
    properties: bounds("properties", "navigation"),
    editorWidth: Math.max(0, viewport - navigation - properties),
  };
}
