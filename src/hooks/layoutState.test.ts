import { describe, expect, it } from "vitest";
import {
  EDITOR_MIN_WIDTH,
  effectivePanelWidths,
  initialLayout,
  layoutReducer,
  PANEL_LIMITS,
  panelMaxWidth,
} from "./layoutState";

describe("layoutReducer", () => {
  it("패널 너비를 최소·최대 범위로 제한한다", () => {
    const narrow = layoutReducer(initialLayout, { type: "resizePanel", panel: "navigation", width: 10 });
    expect(narrow.navigationWidth).toBe(PANEL_LIMITS.navigation.min);
    const wide = layoutReducer(initialLayout, { type: "resizePanel", panel: "properties", width: 9999 });
    expect(wide.propertiesWidth).toBe(PANEL_LIMITS.properties.max);
  });

  it("두 패널의 표시 상태는 서로 독립적이다", () => {
    const state = layoutReducer(initialLayout, { type: "togglePanel", panel: "navigation" });
    expect(state.navigationVisible).toBe(false);
    expect(state.propertiesVisible).toBe(true);
  });

  it("확대/축소는 정해진 단계 안에서만 움직인다", () => {
    let state = initialLayout;
    for (let i = 0; i < 20; i += 1) state = layoutReducer(state, { type: "zoom", direction: "in" });
    expect(state.zoom).toBe(200);
    state = layoutReducer(state, { type: "zoom", direction: "reset" });
    expect(state.zoom).toBe(100);
  });
});

describe("좁은 창의 패널 너비", () => {
  it("편집 영역 최소 너비를 남기도록 오른쪽 패널부터 줄인다", () => {
    const widths = effectivePanelWidths(initialLayout, 960);
    expect(widths.navigation + widths.properties + EDITOR_MIN_WIDTH).toBeLessThanOrEqual(960);
    expect(widths.properties).toBeGreaterThanOrEqual(PANEL_LIMITS.properties.min);
  });

  it("넓은 창에서는 사용자가 정한 너비를 그대로 쓴다", () => {
    expect(effectivePanelWidths(initialLayout, 1600)).toEqual({
      navigation: initialLayout.navigationWidth,
      properties: initialLayout.propertiesWidth,
    });
  });

  it("숨긴 패널은 너비 계산에서 빠진다", () => {
    const hidden = { ...initialLayout, propertiesVisible: false };
    expect(panelMaxWidth(hidden, "navigation", 900)).toBe(PANEL_LIMITS.navigation.max);
  });
});
