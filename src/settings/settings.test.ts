import { afterEach, describe, expect, it, vi } from "vitest";
import { initialLayout, PANEL_LIMITS } from "../hooks/layoutState";
import {
  createLocalStorageStore,
  canPersist,
  DEFAULT_SETTINGS,
  loadSettings,
  parseSettings,
  serializeSettings,
  SETTINGS_KEY,
  storedSettingsMatch,
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
    expect(parseSettings(null)).toEqual({ settings: DEFAULT_SETTINGS, status: "absent", issues: [] });
    expect(DEFAULT_SETTINGS.language).toBe("ko");
  });

  it("저장 형식과 왕복해도 같은 설정이 된다", () => {
    expect(parseSettings(serializeSettings(custom))).toEqual({ settings: custom, status: "restored", issues: [] });
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

  // 리뷰 수정: 읽기 실패를 "없음"(null)과 구별하도록 읽기는 예외를 던진다. loadSettings가 unreadable로 바꾼다.
  it("저장소가 예외를 던지면 읽기는 예외를 전달하고, 쓰기는 false를 반환한다", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    const store = createLocalStorageStore();
    expect(() => store.read()).toThrow();
    expect(store.write("value")).toBe(false);
  });

  it("localStorage 접근 자체가 막혀도 읽기는 예외, 쓰기는 false다", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    const store = createLocalStorageStore();
    expect(() => store.read()).toThrow();
    expect(store.write("value")).toBe(false);
  });
});

// ---- 리뷰 수정(T005 후속): 복원 결과 구분 ----

describe("복원 결과 구분(status)", () => {
  it("없음·정상·일부 복구·형식 오류·미지원 버전을 구별한다", () => {
    expect(parseSettings(null).status).toBe("absent");
    expect(parseSettings(serializeSettings(custom)).status).toBe("restored");
    expect(parseSettings(stored({ language: "jp" })).status).toBe("recovered");
    expect(parseSettings(stored({}, { navigationWidth: 9000 })).status).toBe("recovered");
    for (const raw of ["{not json", "[]", "null", "42", '"text"', stored({ version: "1" }), stored({ version: undefined }),
                       stored({ version: 0 }), stored({ version: 1.5 }), stored({ version: -3 })]) {
      expect(parseSettings(raw).status, raw).toBe("malformed");
    }
    for (const version of [2, 3, 99]) {
      expect(parseSettings(stored({ version })).status).toBe("unsupported");
    }
  });

  it("미지원 버전은 일반적인 항목 손상으로 취급하지 않는다(저장 금지)", () => {
    expect(canPersist("unsupported")).toBe(false);
    expect(canPersist("unreadable")).toBe(false);
    for (const status of ["absent", "restored", "recovered", "malformed"] as const) expect(canPersist(status), status).toBe(true);
  });

  it("진단 문구에 저장된 값을 그대로 담지 않는다", () => {
    const marked = stored({ version: "stored-marker-value" });
    expect(parseSettings(marked).issues.join(" ")).not.toContain("stored-marker-value");
  });
});

describe("loadSettings", () => {
  afterEach(() => vi.restoreAllMocks());

  it("읽기 실패는 첫 실행(absent)과 구별한다", () => {
    const failing = { read: () => { throw new Error("denied"); }, write: () => true };
    expect(loadSettings(failing)).toMatchObject({ status: "unreadable", settings: DEFAULT_SETTINGS });
    expect(loadSettings({ read: () => null, write: () => true })).toMatchObject({ status: "absent", settings: DEFAULT_SETTINGS });
  });

  it("localStorage가 읽기 중 예외를 던지면 unreadable이다", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(loadSettings(createLocalStorageStore()).status).toBe("unreadable");
  });

  it("localStorage 접근 자체가 막히면 unreadable이다", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    expect(loadSettings(createLocalStorageStore()).status).toBe("unreadable");
  });
});

// ---- 2차 안정화(T005): 너비 정규화 분류(C), 진단 문구 정책(D) ----

describe("너비 정규화(C)", () => {
  const widths = (navigationWidth: unknown, propertiesWidth: unknown = PANEL_LIMITS.properties.initial) =>
    parseSettings(stored({}, { navigationWidth, propertiesWidth }));

  it("정수이고 범위 안이면 그대로 복원한다", () => {
    const result = widths(240, 300);
    expect(result.settings.layout).toMatchObject({ navigationWidth: 240, propertiesWidth: 300 });
    expect(result.status).toBe("restored");
    expect(result.issues).toEqual([]);
  });

  it("값이 바뀌면(반올림·범위 보정·기본값) recovered이고 항목마다 진단은 하나다", () => {
    const cases: [unknown, unknown, number, number][] = [
      [240.5, 280, 241, 280],
      [420.4, 280, 420, 280],
      [240, 300.6, 240, 301],
      [10, 280, PANEL_LIMITS.navigation.min, 280],
      [9000, 280, PANEL_LIMITS.navigation.max, 280],
      [9000.7, 280, PANEL_LIMITS.navigation.max, 280], // 반올림과 범위 보정이 함께 필요해도 진단 하나
      [240, 100.2, 240, PANEL_LIMITS.properties.min],
      [240, 9999, 240, PANEL_LIMITS.properties.max],
      ["300", 280, PANEL_LIMITS.navigation.initial, 280],
      [240, null, 240, PANEL_LIMITS.properties.initial],
    ];
    for (const [nav, props, expectedNav, expectedProps] of cases) {
      const result = widths(nav, props);
      const label = JSON.stringify([nav, props]);
      expect(result.settings.layout.navigationWidth, label).toBe(expectedNav);
      expect(result.settings.layout.propertiesWidth, label).toBe(expectedProps);
      expect(result.status, label).toBe("recovered");
      expect(result.issues, label).toHaveLength(1);
    }
    const nonFinite = parseSettings(stored().replace('"navigationWidth":240', '"navigationWidth":1e999'));
    expect(nonFinite.settings.layout.navigationWidth).toBe(PANEL_LIMITS.navigation.initial);
    expect(nonFinite.status).toBe("recovered");
    expect(nonFinite.issues).toHaveLength(1);
  });
});

describe("진단 문구 정책(D): 저장된 값을 담지 않는다", () => {
  it("미지원 정수 버전·아주 큰 버전·표식이 든 문자열 버전·깨진 JSON에서 저장값이 진단에 나오지 않는다", () => {
    const marker = "synthetic-stored-marker";
    const cases = [
      stored({ version: 7 }),
      stored({ version: 1e21 }),
      stored({ version: `${marker}-2` }),
      `{"version":1,"language":"${marker}`,
      stored({ language: marker }, { theme: marker }),
    ];
    for (const raw of cases) {
      const text = parseSettings(raw).issues.join(" ");
      expect(text, raw).not.toContain(marker);
      expect(text, raw).not.toMatch(/\d/); // 버전 번호 등 저장된 숫자도 넣지 않는다
    }
    expect(parseSettings(stored({ version: 1e21 })).status).toBe("unsupported");
  });

  it("읽기 예외 문구는 진단에 담지 않는다", () => {
    const failing = { read: () => { throw new Error("synthetic-read-error-marker"); }, write: () => true };
    expect(loadSettings(failing).issues.join(" ")).not.toContain("synthetic");
  });
});

// ---- 최종 정리(T005): 저장값과 현재 설정의 의미 동등성 ----

describe("storedSettingsMatch", () => {
  const serialized = serializeSettings(custom);
  const object = JSON.parse(serialized) as { layout: Record<string, unknown> } & Record<string, unknown>;

  it("공백·항목 순서·모르는 항목만 다른 올바른 버전 1은 같은 설정이다", () => {
    const reordered = JSON.stringify({ layout: Object.fromEntries(Object.entries(object.layout).reverse()), language: "en", version: 1 });
    for (const raw of [serialized, JSON.stringify(object, null, 2), reordered,
                       stored({ sync: { enabled: false } }, { density: "compact" })]) {
      expect(storedSettingsMatch(raw, serialized), raw).toBe(true);
    }
  });

  it("알려진 항목 값이 하나라도 다르면 같지 않다", () => {
    const changed: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ language: "ko" }, {}],
      [{}, { navigationVisible: true }],
      [{}, { propertiesVisible: false }],
      [{}, { navigationWidth: 241 }],
      [{}, { propertiesWidth: 401 }],
      [{}, { ribbonCollapsed: false }],
      [{}, { theme: "light" }],
      [{}, { zoom: 175 }],
    ];
    for (const [top, layout] of changed) {
      const raw = stored(top, layout);
      expect(parseSettings(raw).status, raw).toBe("restored");
      expect(storedSettingsMatch(raw, serialized), raw).toBe(false);
    }
  });

  it("저장값 없음·형식 오류·일부 복구·미지원 버전은 보정한 설정이 같아도 같지 않다", () => {
    const defaults = serializeSettings(DEFAULT_SETTINGS);
    const withoutZoom = Object.fromEntries(Object.entries(initialLayout).filter(([key]) => key !== "zoom"));
    const cases: (string | null)[] = [
      null,
      "{corrupt",
      JSON.stringify({ version: "1", language: "ko", layout: initialLayout }),
      JSON.stringify({ version: 1, language: "ko", layout: withoutZoom }),
      JSON.stringify({ version: 1, language: "ko", layout: { ...initialLayout, theme: "neon" } }),
      JSON.stringify({ version: 1, language: "ko", layout: { ...initialLayout, navigationWidth: initialLayout.navigationWidth + 0.4 } }),
      JSON.stringify({ version: 1, language: "ko", layout: { ...initialLayout, propertiesWidth: 99999 } }),
      JSON.stringify({ version: 2, language: "ko", layout: initialLayout }),
    ];
    for (const raw of cases) {
      const normalized = serializeSettings(parseSettings(raw).settings); // 이 저장값을 읽어 화면에 그린 설정
      expect(storedSettingsMatch(raw, normalized), String(raw)).toBe(false);
    }
    expect(storedSettingsMatch(null, defaults)).toBe(false);
  });
});
