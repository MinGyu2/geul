import { describe, expect, it } from "vitest";
import {
  computePanelLayout,
  EDITOR_MIN_WIDTH,
  initialLayout,
  layoutReducer,
  PANEL_LIMITS,
  type LayoutState,
  type PanelLayout,
} from "./layoutState";

const wide: LayoutState = { ...initialLayout, navigationWidth: 420, propertiesWidth: 460 };

function expectConsistent(layout: PanelLayout, viewport: number) {
  for (const panel of [layout.navigation, layout.properties]) {
    if (!panel.visible) {
      expect(panel.width).toBe(0);
      continue;
    }
    expect(panel.width).toBeGreaterThanOrEqual(panel.min);
    expect(panel.width).toBeLessThanOrEqual(panel.max);
  }
  expect(layout.navigation.width + layout.properties.width + layout.editorWidth).toBe(viewport);
  expect(layout.editorWidth).toBeGreaterThanOrEqual(EDITOR_MIN_WIDTH);
}

describe("layoutReducer", () => {
  it("패널 너비를 최소·최대 범위로 제한한다", () => {
    const narrow = layoutReducer(initialLayout, { type: "resizePanel", panel: "navigation", width: 10 });
    expect(narrow.navigationWidth).toBe(PANEL_LIMITS.navigation.min);
    const large = layoutReducer(initialLayout, { type: "resizePanel", panel: "properties", width: 9999 });
    expect(large.propertiesWidth).toBe(PANEL_LIMITS.properties.max);
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

describe("computePanelLayout", () => {
  it("기본 창 너비에서는 사용자가 정한 너비를 그대로 쓴다", () => {
    const layout = computePanelLayout(initialLayout, 1280);
    expect(layout.navigation.width).toBe(240);
    expect(layout.properties.width).toBe(280);
    expect(layout.editorWidth).toBe(760);
    expectConsistent(layout, 1280);
  });

  it("두 패널이 최대 너비일 때 좁은 창에서도 aria 범위가 모순되지 않는다(리뷰 재현 사례)", () => {
    const layout = computePanelLayout(wide, 960);
    expect(layout.navigation).toMatchObject({ width: 380, min: 180, max: 380 });
    expect(layout.properties).toMatchObject({ width: 220, min: 220, max: 220 });
    expect(layout.editorWidth).toBe(360);
    expectConsistent(layout, 960);
  });

  it("넓은 창 → 좁은 창 → 다시 넓은 창에서 사용자가 정한 너비를 되살린다", () => {
    expect(computePanelLayout(wide, 1600).navigation.width).toBe(420);
    expect(computePanelLayout(wide, 960).navigation.width).toBe(380);
    const regrown = computePanelLayout(wide, 1600);
    expect(regrown.navigation.width).toBe(420);
    expect(regrown.properties.width).toBe(460);
    expectConsistent(regrown, 1600);
  });

  it("한쪽 패널만 보이면 그 패널이 남는 공간을 쓴다", () => {
    const navigationOnly = computePanelLayout({ ...wide, propertiesVisible: false }, 960);
    expect(navigationOnly.navigation).toMatchObject({ width: 420, max: 420 });
    expect(navigationOnly.properties.width).toBe(0);
    expectConsistent(navigationOnly, 960);

    const propertiesOnly = computePanelLayout({ ...wide, navigationVisible: false }, 960);
    expect(propertiesOnly.properties).toMatchObject({ width: 460, max: 460 });
    expectConsistent(propertiesOnly, 960);
  });

  it("두 패널을 모두 숨기면 편집 영역이 창 전체를 쓴다", () => {
    const layout = computePanelLayout({ ...wide, navigationVisible: false, propertiesVisible: false }, 960);
    expect(layout.editorWidth).toBe(960);
    expectConsistent(layout, 960);
  });

  it("지원하는 창 너비와 모든 패널 너비·표시 조합에서 min ≤ width ≤ max, 편집 영역 ≥ 360px", () => {
    for (let viewport = 960; viewport <= 2000; viewport += 40) {
      for (let navigation = 180; navigation <= 420; navigation += 40) {
        for (let properties = 220; properties <= 460; properties += 40) {
          for (const [navigationVisible, propertiesVisible] of [[true, true], [true, false], [false, true], [false, false]]) {
            const state = { ...initialLayout, navigationWidth: navigation, propertiesWidth: properties,
              navigationVisible: navigationVisible!, propertiesVisible: propertiesVisible! };
            expectConsistent(computePanelLayout(state, viewport), viewport);
          }
        }
      }
    }
  });

  it("최대 너비까지 늘리면 그 너비가 그대로 그려진다(되돌아가는 점프 없음)", () => {
    for (const viewport of [960, 1100, 1280]) {
      let state = wide;
      const before = computePanelLayout(state, viewport);
      state = layoutReducer(state, { type: "resizePanel", panel: "navigation", width: before.navigation.max });
      const after = computePanelLayout(state, viewport);
      expect(after.navigation.width).toBe(before.navigation.max);
      expect(after.properties.width).toBeGreaterThanOrEqual(before.properties.width);
      expectConsistent(after, viewport);
    }
  });
});
