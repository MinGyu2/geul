// UI 설정 저장·복원(FR-002, SC-001).
//
// 저장 위치: WebView의 localStorage, 키 `geul.settings`. 민감하지 않은 화면 설정만 담는다. Tauri는 앱 식별자
// (io.github.mingyu2.geul)별 WebView 데이터 디렉터리에 이를 보관한다. 실제 재시작 후 복원은
// tests/e2e/tauri_smoke.py로 확인한다(jsdom 테스트만으로는 증명되지 않음).
//
// 형식(버전 1): { version: 1, language, layout: { navigationVisible, propertiesVisible, navigationWidth,
// propertiesWidth, ribbonCollapsed, theme, zoom } }
// - 너비는 사용자가 정한 선호 너비다. 창 크기에 맞춰 줄어든 실제 너비(computePanelLayout 결과)는 저장하지 않는다.
// - 읽을 때 항목별로 검사한다. 잘못된 항목만 기본값으로 바꾸고 나머지 올바른 항목은 유지한다.
// - 더 새로운 버전(정수 version > 1)의 저장값과 읽지 못한 저장소는 덮어쓰지 않는다(canPersist). 이번 실행에서
//   바꾼 설정은 메모리에만 적용된다. 이전 버전으로 바꾸거나 지우는 작업은 별도로 정의하기 전에는 하지 않는다.
import { DEFAULT_LANGUAGE, isLanguage, type Language, type MessageKey } from "../language";
import { initialLayout, PANEL_LIMITS, THEMES, ZOOM_STEPS, type LayoutState, type Theme } from "../hooks/layoutState";

export const SETTINGS_KEY = "geul.settings";
export const SETTINGS_VERSION = 1;

export interface Settings {
  language: Language;
  layout: LayoutState;
}

export const DEFAULT_SETTINGS: Settings = { language: DEFAULT_LANGUAGE, layout: initialLayout };

/**
 * 복원 결과.
 * - absent: 저장값 없음(첫 실행). restored: 그대로 복원. recovered: 버전 1이지만 일부 항목을 기본값·범위로 고침.
 * - malformed: JSON 오류·객체가 아님·version이 올바르지 않음 → 기본값. 다음 변경 때 새로 저장한다.
 * - unsupported: 더 새로운 버전 → 기본값, 저장하지 않음. unreadable: 저장소를 읽지 못함 → 기본값, 저장하지 않음.
 */
export type RestoreStatus = "absent" | "restored" | "recovered" | "malformed" | "unsupported" | "unreadable";

export interface ParsedSettings {
  settings: Settings;
  status: RestoreStatus;
  /** 기본값으로 대신한 항목 등 복원 중 발견한 문제(진단용, 저장된 값 자체는 담지 않는다). */
  issues: string[];
}

/** 이 결과에서 설정을 저장해도 되는가. 미지원 버전·읽지 못한 저장값은 남아 있을 수 있으므로 덮어쓰지 않는다. */
export function canPersist(status: RestoreStatus): boolean {
  return status !== "unsupported" && status !== "unreadable";
}

/** 시작할 때 상태 표시줄에 보여 줄 알림. 첫 실행과 정상 복원은 알리지 않는다. */
export const RESTORE_NOTICE: Record<RestoreStatus, MessageKey | null> = {
  absent: null,
  restored: null,
  recovered: "settings.restore.recovered",
  malformed: "settings.restore.malformed",
  unsupported: "settings.restore.unsupported",
  unreadable: "settings.restore.unreadable",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSettings(raw: string | null): ParsedSettings {
  if (raw === null) return { settings: DEFAULT_SETTINGS, status: "absent", issues: [] };
  const malformed = (issue: string): ParsedSettings => ({ settings: DEFAULT_SETTINGS, status: "malformed", issues: [issue] });
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return malformed("JSON 형식 오류");
  }
  if (!isRecord(data)) return malformed("객체가 아님");
  if (Number.isInteger(data.version) && (data.version as number) > SETTINGS_VERSION) {
    return { settings: DEFAULT_SETTINGS, status: "unsupported", issues: [`지원하지 않는 새 버전 ${String(data.version)}`] };
  }
  if (data.version !== SETTINGS_VERSION) return malformed("version 값이 올바르지 않음");

  const issues: string[] = [];
  const pick = <T,>(name: string, value: unknown, valid: (v: unknown) => v is T, fallback: T): T => {
    if (valid(value)) return value;
    if (value !== undefined) issues.push(`${name} 값이 올바르지 않음`);
    else issues.push(`${name} 없음`);
    return fallback;
  };
  const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
  const isTheme = (v: unknown): v is Theme => THEMES.includes(v as Theme);
  const isZoom = (v: unknown): v is number => ZOOM_STEPS.includes(v as (typeof ZOOM_STEPS)[number]);
  const width = (name: "navigation" | "properties", value: unknown): number => {
    const fallback = PANEL_LIMITS[name].initial;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push(`${name}Width ${value === undefined ? "없음" : "값이 올바르지 않음"}`);
      return fallback;
    }
    const { min, max } = PANEL_LIMITS[name];
    if (value < min || value > max) issues.push(`${name}Width 범위 밖(${min}~${max})으로 보정`);
    return Math.round(Math.min(max, Math.max(min, value)));
  };

  const layout = isRecord(data.layout) ? data.layout : {};
  if (!isRecord(data.layout)) issues.push("layout 없음");
  const defaults = DEFAULT_SETTINGS.layout;
  const settings: Settings = {
    language: pick("language", data.language, isLanguage, DEFAULT_SETTINGS.language),
    layout: {
      navigationVisible: pick("navigationVisible", layout.navigationVisible, isBoolean, defaults.navigationVisible),
      propertiesVisible: pick("propertiesVisible", layout.propertiesVisible, isBoolean, defaults.propertiesVisible),
      navigationWidth: width("navigation", layout.navigationWidth),
      propertiesWidth: width("properties", layout.propertiesWidth),
      ribbonCollapsed: pick("ribbonCollapsed", layout.ribbonCollapsed, isBoolean, defaults.ribbonCollapsed),
      theme: pick("theme", layout.theme, isTheme, defaults.theme),
      zoom: pick("zoom", layout.zoom, isZoom, defaults.zoom),
    },  };
  return { settings, status: issues.length > 0 ? "recovered" : "restored", issues };
}

/** 저장 형식으로 바꾼다. 알려진 항목만 같은 순서로 쓰므로 같은 설정은 같은 문자열이 된다. */
export function serializeSettings({ language, layout }: Settings): string {
  return JSON.stringify({
    version: SETTINGS_VERSION,
    language,
    layout: {
      navigationVisible: layout.navigationVisible,
      propertiesVisible: layout.propertiesVisible,
      navigationWidth: layout.navigationWidth,
      propertiesWidth: layout.propertiesWidth,
      ribbonCollapsed: layout.ribbonCollapsed,
      theme: layout.theme,
      zoom: layout.zoom,
    },
  });
}

export interface SettingsStore {
  /** 저장된 문자열. 없으면 null. 저장소를 읽을 수 없으면 예외를 던진다(첫 실행과 구별하기 위해). */
  read(): string | null;
  /** 저장에 성공하면 true. */
  write(value: string): boolean;
}

/**
 * localStorage 기반 저장소. 저장소를 쓸 수 없는 환경(접근 거부 등)에서는 읽기가 예외를 던지고 쓰기는 false.
 * 읽기 예외는 loadSettings가 unreadable로 바꾼다.
 */
export function createLocalStorageStore(key = SETTINGS_KEY): SettingsStore {
  const storage = (): Storage | null => {
    try {
      return typeof window === "undefined" ? null : window.localStorage;
    } catch {
      return null; // 접근 자체가 SecurityError를 던지는 환경
    }
  };
  return {
    read() {
      const target = storage();
      if (!target) throw new Error("localStorage를 사용할 수 없음");
      return target.getItem(key); // 접근 거부 예외는 그대로 전달한다
    },
    write(value) {
      try {
        const target = storage();
        if (!target) return false;
        target.setItem(key, value);
        return true;
      } catch {
        return false; // 용량 초과, 쓰기 거부
      }
    },
  };
}

/** 저장소에서 읽어 검사한다. 읽기 예외는 unreadable이 되며 앱을 멈추지 않는다(예외 내용은 담지 않는다). */
export function loadSettings(store: SettingsStore): ParsedSettings {
  let raw: string | null;
  try {
    raw = store.read();
  } catch {
    return { settings: DEFAULT_SETTINGS, status: "unreadable", issues: ["저장소를 읽지 못함"] };
  }
  return parseSettings(raw);
}
