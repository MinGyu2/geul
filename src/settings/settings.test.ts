import { afterEach, describe, expect, it, vi } from "vitest";
import { initialLayout, PANEL_LIMITS } from "../hooks/layoutState";
import {
  createLocalStorageStore,
  DEFAULT_SETTINGS,
  parseSettings,
  serializeSettings,
  SETTINGS_KEY,
  type Settings,
} from "./settings";

const custom: Settings = {
  language: "en",
  layout: { ...initialLayout, navigationVisible: false, propertiesWidth: 400, ribbonCollapsed: true, theme: "dark", zoom: 150 },
};

function stored(overrides: Record<string, unknown> = {}, layout: Record<string, unknown> = {}): string {
  const base = JSON.parse(serializeSettings(custom)) as Record<string, unknown>;
  return JSON.stringify({ ...base, ...overrides, layout: { ...(base.layout as object), ...layout } });
}

describe("parseSettings", () => {
  it("저장된 값이 없으면 기본값을 쓰고 문제를 보고하지 않는다", () => {
    expect(parseSettings(null)).toEqual({ settings: DEFAULT_SETTINGS, issues: [] });
    expect(DEFAULT_SETTINGS.language).toBe("ko");
  });

  it("저장 형식과 왕복해도 같은 설정이 된다", () => {
    expect(parseSettings(serializeSettings(custom))).toEqual({ settings: custom, issues: [] });
  });

  it("JSON 오류·객체가 아닌 값·지원하지 않는 버전은 기본값으로 돌아간다", () => {
    for (const raw of ["{not json", "[]", "null", "42", '"text"', stored({ version: 2 }), stored({ version: "1" }),
                       stored({ version: undefined })]) {
      const result = parseSettings(raw);
      expect(result.settings, raw).toEqual(DEFAULT_SETTINGS);
      expect(result.issues.length, raw).toBeGreaterThan(0);
    }
  });

  it("잘못된 항목만 기본값으로 바꾸고 나머지 올바른 항목은 유지한다", () => {
    const result = parseSettings(stored({ language: "jp" }, { theme: "neon", ribbonCollapsed: "yes" }));
    expect(result.settings.language).toBe("ko");
    expect(result.settings.layout.theme).toBe("system");
    expect(result.settings.layout.ribbonCollapsed).toBe(false);
    expect(result.settings.layout.navigationVisible).toBe(false); // 올바른 값 유지
    expect(result.settings.layout.zoom).toBe(150);
    expect(result.issues).toHaveLength(3);
  });

  it("숫자가 아니거나 유한하지 않은 너비는 기본값, 범위 밖 너비는 범위 안으로 보정한다", () => {
    const nonFinite = parseSettings(stored({}, { navigationWidth: "300" }).replace('"propertiesWidth":400', '"propertiesWidth":1e999'));
    expect(nonFinite.settings.layout.navigationWidth).toBe(PANEL_LIMITS.navigation.initial);
    expect(nonFinite.settings.layout.propertiesWidth).toBe(PANEL_LIMITS.properties.initial);
    const clamped = parseSettings(stored({}, { navigationWidth: 10, propertiesWidth: 9000 }));
    expect(clamped.settings.layout.navigationWidth).toBe(PANEL_LIMITS.navigation.min);
    expect(clamped.settings.layout.propertiesWidth).toBe(PANEL_LIMITS.properties.max);
  });

  it("지원하지 않는 확대/축소 값은 100%로 돌아간다", () => {
    for (const zoom of [133, 0, -50, "150", null]) {
      expect(parseSettings(stored({}, { zoom })).settings.layout.zoom).toBe(100);
    }
  });

  it("빠진 항목은 기본값, 모르는 항목은 무시한다", () => {
    const raw = JSON.stringify({ version: 1, language: "en", layout: { zoom: 75, extra: true }, extra: 1 });
    const result = parseSettings(raw);
    expect(result.settings).toEqual({ language: "en", layout: { ...initialLayout, zoom: 75 } });
    expect(serializeSettings(result.settings)).not.toContain("extra");
    const noLayout = parseSettings(JSON.stringify({ version: 1, language: "en" }));
    expect(noLayout.settings).toEqual({ language: "en", layout: initialLayout });
  });
});

describe("createLocalStorageStore", () => {
  afterEach(() => vi.restoreAllMocks());

  it("localStorage에 읽고 쓴다", () => {
    const store = createLocalStorageStore();
    expect(store.read()).toBeNull();
    expect(store.write("value")).toBe(true);
    expect(window.localStorage.getItem(SETTINGS_KEY)).toBe("value");
    expect(store.read()).toBe("value");
  });

  it("저장소가 예외를 던져도 읽기는 null, 쓰기는 false를 반환한다", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    const store = createLocalStorageStore();
    expect(store.read()).toBeNull();
    expect(store.write("value")).toBe(false);
  });

  it("localStorage 접근 자체가 막혀도 동작한다", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    const store = createLocalStorageStore();
    expect(store.read()).toBeNull();
    expect(store.write("value")).toBe(false);
  });
});
