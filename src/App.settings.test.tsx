import { act, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import { initialLayout } from "./hooks/layoutState";
import { SETTINGS_KEY, type SettingsStore } from "./settings/settings";

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

function memoryStore(initial: string | null = null, writable = true) {
  const writes: string[] = [];
  let value = initial;
  const store: SettingsStore = {
    read: () => value,
    write: (next) => {
      if (!writable) return false;
      writes.push(next);
      value = next;
      return true;
    },
  };
  return { store, writes, current: () => value };
}

const statusMessage = () => screen.getAllByRole("status").find((element) => !element.hasAttribute("aria-label"))!;
const storedJson = () => JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "null");

function expectKorean({ ready = true } = {}) {
  expect(document.documentElement.lang).toBe("ko");
  expect(screen.getByRole("banner", { name: "제목 표시줄" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "홈" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "글꼴" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "굵게" })).toHaveAttribute("title", "굵게 (Ctrl+B) — 열린 문서 없음");
  expect(screen.getByRole("complementary", { name: "탐색" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "열린 문서가 없습니다" })).toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "속성" })).toBeInTheDocument();
  if (ready) expect(screen.getByRole("contentinfo", { name: "상태 표시줄" })).toHaveTextContent("준비됨");
  expect(screen.getByRole("separator", { name: "탐색 창 너비 조절" })).toBeInTheDocument();
}

function expectEnglish({ ready = true } = {}) {
  expect(document.documentElement.lang).toBe("en");
  expect(screen.getByRole("banner", { name: "Title bar" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Home" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Font" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Bold" }))
    .toHaveAttribute("title", "Bold (Ctrl+B) — No open document");
  expect(screen.getByRole("complementary", { name: "Navigation" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "No document is open" })).toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "Properties" })).toBeInTheDocument();
  if (ready) expect(screen.getByRole("contentinfo", { name: "Status bar" })).toHaveTextContent("Ready");
  expect(screen.getByRole("separator", { name: "Resize navigation pane" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Collapse ribbon" })).toBeInTheDocument();
  expect(screen.queryByText(/[가-힣]/, { ignore: "option, script, style" })).toBeNull(); // 한국어가 남지 않음
  const koreanAttributes = [...document.querySelectorAll("[aria-label], [title]")]
    .flatMap((element) => [element.getAttribute("aria-label"), element.getAttribute("title")])
    .filter((value) => value && /[가-힣]/.test(value));
  expect(koreanAttributes).toEqual([]); // 접근성 이름·툴팁에도 한국어가 남지 않음
}

describe("첫 실행과 언어 전환", () => {
  it("저장된 설정이 없으면 한국어·기본 배치로 시작하고 시작할 때 저장소에 쓰지 않는다", () => {
    setViewport(1400);
    const { store, writes } = memoryStore();
    render(<App settingsStore={store} />);
    expectKorean();
    expect(screen.getByRole("combobox", { name: "화면 언어" })).toHaveValue("ko");
    expect(document.documentElement.dataset.theme).toBe("system");
    expect(writes).toEqual([]);
  });

  it("영어로 바꾸면 모든 영역이 바로 바뀌고, 다시 한국어로 돌아온다", async () => {
    setViewport(1400);
    const user = userEvent.setup();
    render(<App settingsStore={memoryStore().store} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "화면 언어" }), "en");
    expectEnglish();
    await user.selectOptions(screen.getByRole("combobox", { name: "Display language" }), "ko");
    expectKorean();
  });

  it("상태 표시줄 알림도 언어를 바꾸면 다시 번역된다", async () => {
    setViewport(1400);
    const user = userEvent.setup();
    render(<App settingsStore={memoryStore().store} />);
    await user.click(screen.getByRole("button", { name: "굵게" }));
    const message = () => screen.getAllByRole("status").find((element) => !element.hasAttribute("aria-label"))!;
    expect(message()).toHaveTextContent("굵게: 열린 문서가 없어 사용할 수 없습니다.");
    await user.selectOptions(screen.getByRole("combobox", { name: "화면 언어" }), "en");
    expect(message()).toHaveTextContent("Bold: no document is open.");
    await user.click(screen.getByRole("tab", { name: "Help" }));
    await user.click(screen.getByRole("button", { name: "About geul" }));
    expect(message()).toHaveTextContent(/^geul \S+ — UI layout stage\./);
    await user.selectOptions(screen.getByRole("combobox", { name: "Display language" }), "ko");
    expect(message()).toHaveTextContent("화면 구성 단계입니다");
  });

  it("영어에서도 문서 명령은 비활성이며 실행되지 않는다", async () => {
    setViewport(1400);
    const user = userEvent.setup();
    render(<App settingsStore={memoryStore().store} initialLanguage="en" />);
    await user.click(screen.getByRole("tab", { name: "File" }));
    const toolbar = screen.getByRole("toolbar", { name: "File" });
    for (const button of within(toolbar).getAllByRole("button")) {
      expect(button).toHaveAttribute("aria-disabled", "true");
    }
    const editor = screen.getByRole("main").innerHTML;
    await user.click(within(toolbar).getByRole("button", { name: "Open" }));
    expect(screen.getByRole("main").innerHTML).toBe(editor);
  });

  it("언어 선택은 키보드로 닿고, 바꾼 뒤에도 초점이 유지되며 기존 패널 초점 동작을 깨지 않는다", async () => {
    setViewport(1400);
    const user = userEvent.setup();
    render(<App settingsStore={memoryStore().store} />);
    within(screen.getByRole("group", { name: "빠른 실행" })).getByRole("button", { name: "다시 실행" }).focus();
    await user.tab();
    const select = screen.getByRole("combobox", { name: "화면 언어" });
    expect(select).toHaveFocus();
    await user.selectOptions(select, "en");
    expect(screen.getByRole("combobox", { name: "Display language" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Show navigation pane" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Close navigation pane" }));
    expect(screen.getByRole("button", { name: "Show navigation pane" })).toHaveFocus();
  });
});

describe("설정 저장과 복원", () => {
  it("언어와 화면 설정을 저장하고 다시 시작하면 복원한다(localStorage, 다시 마운트)", async () => {
    setViewport(1400);
    const user = userEvent.setup();
    const first = render(<App />);
    await user.selectOptions(screen.getByRole("combobox", { name: "화면 언어" }), "en");
    await user.click(screen.getByRole("button", { name: "Close navigation pane" }));
    const handle = screen.getByRole("separator", { name: "Resize properties pane" });
    handle.focus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    await user.click(screen.getByRole("button", { name: "Collapse ribbon" }));
    await user.click(screen.getByRole("button", { name: "Theme: System" }));
    await user.click(screen.getByRole("button", { name: "Theme: Light" }));
    await user.click(within(screen.getByRole("contentinfo")).getByRole("button", { name: "Zoom In" }));
    expect(storedJson()).toEqual({
      version: 1,
      language: "en",
      layout: { navigationVisible: false, propertiesVisible: true, navigationWidth: 240, propertiesWidth: 312,
        ribbonCollapsed: true, theme: "dark", zoom: 110 },
    });
    first.unmount();

    render(<App />);
    expectEnglishAfterRestart();
    expect(screen.queryByRole("complementary", { name: "Navigation" })).not.toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize properties pane" })).toHaveAttribute("aria-valuenow", "312");
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("status", { name: "Zoom level" })).toHaveTextContent("110%");
  });

  function expectEnglishAfterRestart() {
    expect(document.documentElement.lang).toBe("en");
    expect(screen.getByRole("combobox", { name: "Display language" })).toHaveValue("en");
    expect(screen.getByRole("banner", { name: "Title bar" })).toBeInTheDocument();
  }

  it("좁은 창에서 줄어든 실제 너비가 아니라 사용자가 정한 너비를 저장한다", async () => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      version: 1, language: "ko",
      layout: { ...initialLayout, navigationWidth: 420, propertiesWidth: 460 },
    }));
    setViewport(960);
    const user = userEvent.setup();
    render(<App />);
    const navigation = screen.getByRole("separator", { name: "탐색 창 너비 조절" });
    const properties = screen.getByRole("separator", { name: "속성 창 너비 조절" });
    expect(navigation).toHaveAttribute("aria-valuenow", "380");
    expect(properties).toHaveAttribute("aria-valuenow", "220");
    for (const handle of [navigation, properties]) {
      expect(Number(handle.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(Number(handle.getAttribute("aria-valuemax")));
      expect(Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(Number(handle.getAttribute("aria-valuemin")));
    }
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    expect(storedJson().layout).toMatchObject({ navigationWidth: 420, propertiesWidth: 460, theme: "light" });
  });

  it("손상된 저장값이 있어도 기본값으로 시작하고, 사용자가 바꾸기 전에는 덮어쓰지 않는다", async () => {
    setViewport(1400);
    const { store, writes, current } = memoryStore("{corrupt");
    const user = userEvent.setup();
    render(<App settingsStore={store} />);
    expectKorean({ ready: false }); // 리뷰 수정: 손상 사실을 알린다(아래 "설정 복원 문제 알림" 참고)
    expect(statusMessage()).toHaveTextContent("저장된 설정을 읽을 수 없어 기본값으로 시작했습니다.");
    expect(writes).toEqual([]);
    expect(current()).toBe("{corrupt");
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    expect(JSON.parse(current()!).layout.theme).toBe("light");
  });

  it("일부 항목이 잘못되어도 올바른 항목은 복원한다", () => {
    setViewport(1400);
    const { store } = memoryStore(JSON.stringify({ version: 1, language: "xx", layout: { ...initialLayout, theme: "dark", zoom: "big" } }));
    render(<App settingsStore={store} />);
    expect(document.documentElement.lang).toBe("ko");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("status", { name: "확대/축소 비율" })).toHaveTextContent("100%");
  });

  it("저장소에 쓸 수 없어도 화면은 동작하고 한 번만 알린다", async () => {
    setViewport(1400);
    const user = userEvent.setup();
    render(<App settingsStore={memoryStore(null, false).store} />);
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    const message = screen.getAllByRole("status").find((element) => !element.hasAttribute("aria-label"))!;
    expect(message).toHaveTextContent("설정을 저장하지 못했습니다");
    await user.selectOptions(screen.getByRole("combobox", { name: "화면 언어" }), "en");
    expect(message).toHaveTextContent("Settings could not be saved.");
    expectEnglish({ ready: false });
  });

  it("주입한 초기 상태는 저장된 값보다 우선한다", () => {
    setViewport(1400);
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, language: "en", layout: { ...initialLayout, ribbonCollapsed: true } }));
    render(<App initialState={initialLayout} initialLanguage="ko" />);
    expectKorean();
    expect(screen.getByRole("tabpanel")).toBeInTheDocument();
  });

  it("테스트마다 저장소가 비어 있다(앞 테스트의 설정이 새지 않음)", () => {
    expect(window.localStorage.getItem(SETTINGS_KEY)).toBeNull();
  });
});

// ---- 리뷰 수정(T005 후속): 미지원 버전 보호, 복원 문제 알림, 저장 실패 알림 해제 ----

/** 쓰기 가능 여부를 테스트 중에 바꿀 수 있는 저장소. 시도한 쓰기를 모두 기록한다. */
function switchableStore(initial: string | null = null) {
  const attempts: string[] = [];
  let value = initial;
  const state = { writable: true };
  const store: SettingsStore = {
    read: () => value,
    write: (next) => {
      attempts.push(next);
      if (!state.writable) return false;
      value = next;
      return true;
    },
  };
  return { store, attempts, state, current: () => value };
}

const futureSettings = JSON.stringify({
  version: 2,
  language: "en",
  layout: { ...initialLayout, theme: "dark", zoom: 150, density: "compact" },
  sync: { enabled: true, profile: "work" },
});

describe("미지원 버전 설정 보호", () => {
  it("더 새로운 버전의 저장값은 화면 설정을 바꿔도 한 바이트도 덮어쓰지 않고, 알리며, 화면은 계속 동작한다", async () => {
    setViewport(1400);
    window.localStorage.setItem(SETTINGS_KEY, futureSettings);
    window.localStorage.setItem("other.key", "keep");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    render(<App />);
    expectKorean({ ready: false });
    expect(statusMessage()).toHaveTextContent("저장된 설정이 더 새로운 버전의 형식이라 그대로 두었습니다");

    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "화면 언어" }), "en");
    await user.click(screen.getByRole("button", { name: "Collapse ribbon" }));
    await user.click(within(screen.getByRole("contentinfo")).getByRole("button", { name: "Zoom In" }));

    expect(document.documentElement.dataset.theme).toBe("light"); // 이번 실행에는 적용됨
    expect(document.documentElement.lang).toBe("en");
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Zoom level" })).toHaveTextContent("110%");
    expect(window.localStorage.getItem(SETTINGS_KEY)).toBe(futureSettings);
    expect(window.localStorage.getItem("other.key")).toBe("keep");
    expect(setItem).not.toHaveBeenCalled();
    expect(statusMessage()).toHaveTextContent("Saved settings use a newer format and were left unchanged. Changes apply to this session only.");
    expect(statusMessage()).not.toHaveTextContent("Ready"); // 저장된 것처럼 보이지 않음
  });

  it("미지원 버전이면 쓰기를 시도조차 하지 않는다(저장 성공·실패로 보고하지 않음)", async () => {
    setViewport(1400);
    const { store, attempts, current } = switchableStore(futureSettings);
    const user = userEvent.setup();
    render(<App settingsStore={store} />);
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    await user.click(screen.getByRole("button", { name: "굵게" })); // 더 최근 알림
    await user.click(screen.getByRole("button", { name: "테마: 밝게" }));
    expect(attempts).toEqual([]);
    expect(current()).toBe(futureSettings);
    expect(statusMessage()).toHaveTextContent("굵게: 열린 문서가 없어 사용할 수 없습니다.");
    expect(statusMessage()).not.toHaveTextContent("설정을 저장하지 못했습니다");
  });

  it("버전 1 저장값은 계속 저장된다", async () => {
    setViewport(1400);
    const { store, attempts } = switchableStore(JSON.stringify({ version: 1, language: "ko", layout: initialLayout }));
    const user = userEvent.setup();
    render(<App settingsStore={store} />);
    expect(statusMessage()).toHaveTextContent("준비됨");
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    expect(attempts).toHaveLength(1);
    expect(JSON.parse(attempts[0]!)).toMatchObject({ version: 1, layout: { theme: "light" } });
  });
});

describe("설정 복원 문제 알림", () => {
  it("저장값이 없으면 보통의 첫 실행이다: 알림 없음, 쓰기 없음", () => {
    setViewport(1400);
    const { store, attempts } = switchableStore(null);
    render(<App settingsStore={store} />);
    expect(statusMessage()).toHaveTextContent("준비됨");
    expect(attempts).toEqual([]);
  });

  it("올바른 버전 1 저장값은 알림 없이 복원한다", () => {
    setViewport(1400);
    const raw = JSON.stringify({ version: 1, language: "en", layout: { ...initialLayout, theme: "dark", zoom: 125 } });
    const { store, attempts } = switchableStore(raw);
    render(<App settingsStore={store} />);
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(statusMessage()).toHaveTextContent("Ready");
    expect(attempts).toEqual([]);
  });

  it("일부 항목이 잘못되면 올바른 항목은 유지하고 복구했다고 알린다; 바꾸면 고친 값으로 저장한다", async () => {
    setViewport(1400);
    const raw = JSON.stringify({ version: 1, language: "en", layout: { ...initialLayout, theme: "neon", zoom: 150 } });
    const { store, attempts, current } = switchableStore(raw);
    const user = userEvent.setup();
    render(<App settingsStore={store} />);
    expect(document.documentElement.lang).toBe("en");
    expect(screen.getByRole("status", { name: "Zoom level" })).toHaveTextContent("150%");
    expect(document.documentElement.dataset.theme).toBe("system");
    expect(statusMessage()).toHaveTextContent("Some saved settings were adjusted or restored to defaults.");
    expect(attempts).toEqual([]);
    expect(current()).toBe(raw); // 시작할 때 덮어쓰지 않음
    await user.click(screen.getByRole("button", { name: "Theme: System" }));
    expect(JSON.parse(current()!)).toMatchObject({ version: 1, language: "en", layout: { theme: "light", zoom: 150 } });
  });

  it("JSON 형식이 깨졌으면 기본값으로 시작하고 알린다", () => {
    setViewport(1400);
    const { store, attempts } = switchableStore('{"version":1,"language":"en",');
    render(<App settingsStore={store} />);
    expect(document.documentElement.lang).toBe("ko");
    expect(statusMessage()).toHaveTextContent("저장된 설정을 읽을 수 없어 기본값으로 시작했습니다.");
    expect(statusMessage()).not.toHaveTextContent('"version"'); // 저장 내용을 그대로 보여 주지 않음
    expect(attempts).toEqual([]);
  });

  it("저장소를 읽지 못하면 첫 실행과 구별해 알리고, 남아 있을 수 있는 기존 값을 덮어쓰지 않는다", async () => {
    setViewport(1400);
    const attempts: string[] = [];
    const store: SettingsStore = {
      read: () => { throw new DOMException("blocked", "SecurityError"); },
      write: (next) => { attempts.push(next); return true; },
    };
    const user = userEvent.setup();
    render(<App settingsStore={store} />);
    expectKorean({ ready: false });
    expect(statusMessage()).toHaveTextContent("설정 저장소에 접근할 수 없어 기본값으로 시작했습니다.");
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(attempts).toEqual([]);
  });

  it("localStorage 읽기가 예외를 던지면 첫 실행이 아니라 읽기 실패로 처리한다", () => {
    setViewport(1400);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    render(<App />);
    expect(statusMessage()).toHaveTextContent("설정 저장소에 접근할 수 없어");
  });

  it("복원 알림은 언어를 바꾸면 다시 번역된다", async () => {
    setViewport(1400);
    const { store } = switchableStore(JSON.stringify({ version: 1, language: "ko", layout: { ...initialLayout, zoom: 7 } }));
    const user = userEvent.setup();
    render(<App settingsStore={store} />);
    expect(statusMessage()).toHaveTextContent("저장된 설정 일부를 조정하거나 기본값으로 복구했습니다.");
    await user.selectOptions(screen.getByRole("combobox", { name: "화면 언어" }), "en");
    expect(statusMessage()).toHaveTextContent("Some saved settings were adjusted or restored to defaults.");
  });

  it("StrictMode와 다시 그리기에서도 알림이 중복되거나 더 최근 알림을 덮어쓰지 않는다", async () => {
    setViewport(1400);
    const { store, attempts } = switchableStore("{corrupt");
    const user = userEvent.setup();
    const view = render(<StrictMode><App settingsStore={store} /></StrictMode>);
    expect(screen.getAllByText("저장된 설정을 읽을 수 없어 기본값으로 시작했습니다.")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "굵게" }));
    view.rerender(<StrictMode><App settingsStore={store} /></StrictMode>);
    view.rerender(<StrictMode><App settingsStore={store} /></StrictMode>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(statusMessage()).toHaveTextContent("굵게: 열린 문서가 없어 사용할 수 없습니다.");
    expect(screen.queryByText(/저장된 설정을 읽을 수 없어/)).toBeNull();
    expect(attempts).toEqual([]);
  });
});

describe("저장 실패 알림", () => {
  it("실패하면 알리고, 다시 저장에 성공하면 지난 실패 알림을 지운다", async () => {
    setViewport(1400);
    const { store, state, current } = switchableStore();
    state.writable = false;
    const user = userEvent.setup();
    render(<App settingsStore={store} />);
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    expect(statusMessage()).toHaveTextContent("설정을 저장하지 못했습니다. 이번 실행 동안만 적용됩니다.");
    state.writable = true;
    await user.click(screen.getByRole("button", { name: "테마: 밝게" }));
    expect(JSON.parse(current()!).layout.theme).toBe("dark");
    expect(statusMessage()).toHaveTextContent("준비됨");
    expect(statusMessage()).not.toHaveTextContent("설정을 저장하지 못했습니다");
  });

  it("성공해도 그 사이에 나온 더 최근 알림은 지우지 않는다", async () => {
    setViewport(1400);
    const { store, state } = switchableStore();
    state.writable = false;
    const user = userEvent.setup();
    render(<App settingsStore={store} />);
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    await user.click(screen.getByRole("button", { name: "굵게" }));
    state.writable = true;
    await user.click(screen.getByRole("button", { name: "테마: 밝게" }));
    expect(statusMessage()).toHaveTextContent("굵게: 열린 문서가 없어 사용할 수 없습니다.");
  });

  it("연속 실패는 한 번만 알리고, 성공 뒤의 새 실패는 다시 알린다", async () => {
    setViewport(1400);
    const { store, state, attempts } = switchableStore();
    state.writable = false;
    const user = userEvent.setup();
    render(<App settingsStore={store} />);
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    expect(statusMessage()).toHaveTextContent("설정을 저장하지 못했습니다");
    await user.click(screen.getByRole("button", { name: "굵게" }));
    const zoomIn = within(screen.getByRole("contentinfo")).getByRole("button", { name: "확대" });
    await user.click(zoomIn); // 같은 실패 구간: 다시 알리지 않음
    await user.click(zoomIn);
    expect(statusMessage()).toHaveTextContent("굵게:");
    expect(attempts).toHaveLength(3); // 바뀔 때마다 다시 시도한다

    state.writable = true;
    await user.click(screen.getByRole("button", { name: "테마: 밝게" })); // 성공: 실패 구간 끝
    expect(attempts).toHaveLength(4);
    state.writable = false;
    await user.click(zoomIn);
    expect(statusMessage()).toHaveTextContent("설정을 저장하지 못했습니다"); // 새 실패 구간
    await user.selectOptions(screen.getByRole("combobox", { name: "화면 언어" }), "en");
    expect(statusMessage()).toHaveTextContent("Settings could not be saved. Changes apply to this session only.");
  });

  it("실패 중에 마지막 저장값으로 되돌리면 저장 실패 알림을 지운다", async () => {
    setViewport(1400);
    const { store, state, attempts } = switchableStore(JSON.stringify({ version: 1, language: "ko", layout: initialLayout }));
    state.writable = false;
    const user = userEvent.setup();
    render(<App settingsStore={store} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "화면 언어" }), "en");
    expect(statusMessage()).toHaveTextContent("Settings could not be saved.");
    await user.selectOptions(screen.getByRole("combobox", { name: "Display language" }), "ko");
    expect(statusMessage()).toHaveTextContent("준비됨");
    expect(attempts).toHaveLength(1);
  });

  it("다시 그려도 같은 설정을 다시 쓰지 않는다(효과 반복 없음)", async () => {
    setViewport(1400);
    const { store, attempts } = switchableStore();
    const user = userEvent.setup();
    const view = render(<StrictMode><App settingsStore={store} /></StrictMode>);
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    for (let i = 0; i < 3; i += 1) view.rerender(<StrictMode><App settingsStore={store} /></StrictMode>);
    expect(attempts).toHaveLength(1);
  });
});

// ---- 2차 안정화(T005): 저장 근거 없는 회복(A), 실행 중 외부 변경(B), 진단 노출(D) ----

/** 여러 클라이언트가 함께 쓰는 저장소. 외부 변경·읽기 실패·쓰기 실패를 흉내 낸다(원자적 교차 프로세스 보장의 증명은 아님). */
function sharedBacking(initial: string | null) {
  const backing = { value: initial, readable: true, writable: true };
  const attempts: string[] = [];
  const client = (): SettingsStore => ({
    read: () => {
      if (!backing.readable) throw new Error("synthetic-read-error-marker");
      return backing.value;
    },
    write: (next) => {
      attempts.push(next);
      if (!backing.writable) return false;
      backing.value = next;
      return true;
    },
  });
  return { backing, attempts, client };
}

const v1 = (layout: Record<string, unknown> = {}, language = "ko") =>
  JSON.stringify({ version: 1, language, layout: { ...initialLayout, ...layout } });

describe("저장 근거 없는 회복 알림 금지(A)", () => {
  it("손상된 저장값: 쓰기 실패 뒤 기본값으로 되돌려도 저장된 것으로 보지 않는다", async () => {
    setViewport(1400);
    const { backing, attempts, client } = sharedBacking("{corrupt");
    backing.writable = false;
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    expect(statusMessage()).toHaveTextContent("설정을 저장하지 못했습니다");
    await user.click(screen.getByRole("button", { name: "테마: 밝게" }));
    await user.click(screen.getByRole("button", { name: "테마: 어둡게" })); // → 시스템(초기 기본값)
    expect(document.documentElement.dataset.theme).toBe("system");
    expect(statusMessage()).toHaveTextContent("설정을 저장하지 못했습니다");
    expect(statusMessage()).not.toHaveTextContent("준비됨");
    expect(backing.value).toBe("{corrupt");
    expect(attempts.length).toBeGreaterThanOrEqual(3); // 기본값으로 돌아왔을 때도 실제로 저장을 시도한다

    backing.writable = true;
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    expect(statusMessage()).toHaveTextContent("준비됨"); // 실제 저장 성공 뒤에만 지운다
    expect(JSON.parse(backing.value!).layout.theme).toBe("light");
  });

  it("일부 복구한 버전 1: 쓰기 실패 뒤 보정된 초기 상태로 돌아가도 원래 저장값은 그대로이고 실패 알림이 남는다", async () => {
    setViewport(1400);
    const raw = v1({ theme: "neon", zoom: 150 });
    const { backing, client } = sharedBacking(raw);
    backing.writable = false;
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    await user.click(screen.getByRole("button", { name: "테마: 밝게" }));
    await user.click(screen.getByRole("button", { name: "테마: 어둡게" }));
    expect(document.documentElement.dataset.theme).toBe("system");
    expect(statusMessage()).toHaveTextContent("설정을 저장하지 못했습니다");
    expect(backing.value).toBe(raw);
  });

  it("올바른 버전 1: 쓰기 실패 뒤 실제로 저장돼 있는 값으로 돌아오면 실패 알림을 지운다", async () => {
    setViewport(1400);
    const raw = v1();
    const { backing, attempts, client } = sharedBacking(raw);
    backing.writable = false;
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "화면 언어" }), "en");
    expect(statusMessage()).toHaveTextContent("Settings could not be saved.");
    await user.selectOptions(screen.getByRole("combobox", { name: "Display language" }), "ko");
    expect(statusMessage()).toHaveTextContent("준비됨");
    expect(attempts).toHaveLength(1); // 저장소에 이미 있는 값은 다시 쓰지 않는다
    expect(backing.value).toBe(raw);
  });

  it("저장값 없음: 쓰기 실패 뒤 기본값으로 돌아와도 저장된 것은 없으므로 실패 알림이 남는다", async () => {
    setViewport(1400);
    const { backing, client } = sharedBacking(null);
    backing.writable = false;
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "화면 언어" }), "en");
    await user.selectOptions(screen.getByRole("combobox", { name: "Display language" }), "ko");
    expect(statusMessage()).toHaveTextContent("설정을 저장하지 못했습니다");
    expect(backing.value).toBeNull();
  });

  it("실패·성공을 반복해도 실제 결과대로 알리고, 그 사이의 다른 알림은 지우지 않는다", async () => {
    setViewport(1400);
    const { backing, client } = sharedBacking("{corrupt");
    const user = userEvent.setup();
    render(<StrictMode><App settingsStore={client()} /></StrictMode>);
    const zoomIn = within(screen.getByRole("contentinfo")).getByRole("button", { name: "확대" });
    const zoomOut = within(screen.getByRole("contentinfo")).getByRole("button", { name: "축소" });
    for (let round = 0; round < 2; round += 1) {
      backing.writable = false;
      await user.click(zoomIn);
      expect(statusMessage()).toHaveTextContent("설정을 저장하지 못했습니다");
      backing.writable = true;
      await user.click(zoomOut);
      expect(statusMessage()).toHaveTextContent("준비됨");
    }
    backing.writable = false;
    await user.click(zoomIn);
    await user.click(screen.getByRole("button", { name: "굵게" }));
    backing.writable = true;
    await user.click(zoomOut);
    expect(statusMessage()).toHaveTextContent("굵게:");
    expect(JSON.parse(backing.value!).layout.zoom).toBe(100);
  });
});

describe("소수 너비 복원(C)", () => {
  it("소수 너비는 반올림해 그리고 일부 복구로 알리며, 시작할 때 쓰지 않는다", () => {
    setViewport(1400);
    const raw = v1({ navigationWidth: 240.5 });
    const { backing, attempts, client } = sharedBacking(raw);
    render(<App settingsStore={client()} />);
    expect(screen.getByRole("separator", { name: "탐색 창 너비 조절" })).toHaveAttribute("aria-valuenow", "241");
    expect(statusMessage()).toHaveTextContent("저장된 설정 일부를 조정하거나 기본값으로 복구했습니다.");
    expect(attempts).toEqual([]);
    expect(backing.value).toBe(raw);
  });
});

describe("실행 중 외부 변경 보호(B)", () => {
  const conflictKo = "저장된 설정이 다른 곳에서 바뀌어 그대로 두었습니다. 바꾼 설정은 이번 실행 동안만 적용됩니다.";

  it("실행 중 버전 2로 바뀐 저장값을 덮어쓰지 않고, 이후 변경도 쓰지 않으며, 알린다", async () => {
    setViewport(1400);
    const { backing, attempts, client } = sharedBacking(v1());
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    backing.value = futureSettings; // 다른 인스턴스·외부 도구가 씀
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(backing.value).toBe(futureSettings);
    expect(statusMessage()).toHaveTextContent(conflictKo);
    await user.selectOptions(screen.getByRole("combobox", { name: "화면 언어" }), "en");
    await user.click(screen.getByRole("button", { name: "Collapse ribbon" }));
    expect(attempts).toEqual([]);
    expect(backing.value).toBe(futureSettings);
    expect(statusMessage()).toHaveTextContent("Saved settings were changed elsewhere and were left unchanged.");
  });

  it("다른 올바른 버전 1 값으로 바뀌어도 덮어쓰지 않는다(병합하지 않음)", async () => {
    setViewport(1400);
    const { backing, attempts, client } = sharedBacking(v1());
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    await user.click(screen.getByRole("button", { name: "테마: 시스템" })); // 정상 저장 1회
    expect(attempts).toHaveLength(1);
    const external = v1({ zoom: 200, theme: "dark" }, "en");
    backing.value = external;
    await user.click(screen.getByRole("button", { name: "테마: 밝게" }));
    await user.click(screen.getByRole("button", { name: "굵게" }));
    await user.click(screen.getByRole("button", { name: "테마: 어둡게" }));
    expect(attempts).toHaveLength(1);
    expect(backing.value).toBe(external);
    expect(statusMessage()).toHaveTextContent("굵게:"); // 충돌 상태에서 또 바꿔도 알림을 반복하지 않음
  });

  it("이 앱이 연속으로 쓰는 것은 충돌로 보지 않는다", async () => {
    setViewport(1400);
    const { backing, attempts, client } = sharedBacking(v1());
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    const zoomIn = within(screen.getByRole("contentinfo")).getByRole("button", { name: "확대" });
    for (let i = 0; i < 4; i += 1) await user.click(zoomIn);
    expect(attempts).toHaveLength(4);
    expect(JSON.parse(backing.value!).layout.zoom).toBe(175);
    expect(statusMessage()).toHaveTextContent("준비됨");
  });

  it("두 클라이언트가 같은 저장소를 쓰면 나중에 쓰려는 쪽이 앞선 쪽의 값을 덮어쓰지 않는다", async () => {
    setViewport(1400);
    const { backing, client } = sharedBacking(v1());
    const user = userEvent.setup();
    const first = render(<App settingsStore={client()} />);
    const second = render(<App settingsStore={client()} />);
    await user.click(within(first.container).getByRole("button", { name: "테마: 시스템" }));
    const written = backing.value;
    expect(JSON.parse(written!).layout.theme).toBe("light");
    await user.selectOptions(within(second.container).getByRole("combobox", { name: "화면 언어" }), "en");
    expect(backing.value).toBe(written);
    expect(within(second.container).getAllByRole("status").find((e) => !e.hasAttribute("aria-label")))
      .toHaveTextContent("Saved settings were changed elsewhere");
  });

  it("쓰기 전 확인에서 읽기가 실패하면 쓰지 않고 저장 실패로 알리며, 다시 읽히면 이어서 저장한다", async () => {
    setViewport(1400);
    const raw = v1();
    const { backing, attempts, client } = sharedBacking(raw);
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    backing.readable = false;
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    expect(attempts).toEqual([]);
    expect(backing.value).toBe(raw);
    expect(statusMessage()).toHaveTextContent("설정을 저장하지 못했습니다");
    expect(document.body.textContent).not.toContain("synthetic-read-error-marker");
    backing.readable = true;
    await user.click(screen.getByRole("button", { name: "테마: 밝게" }));
    expect(JSON.parse(backing.value!).layout.theme).toBe("dark");
    expect(statusMessage()).toHaveTextContent("준비됨");
  });

  it("쓰기 실패 중에 외부 변경이 생기면 저장 실패가 아니라 충돌로 알린다", async () => {
    setViewport(1400);
    const { backing, attempts, client } = sharedBacking(v1());
    backing.writable = false;
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    expect(statusMessage()).toHaveTextContent("설정을 저장하지 못했습니다");
    backing.value = futureSettings;
    backing.writable = true;
    await user.click(screen.getByRole("button", { name: "테마: 밝게" }));
    expect(statusMessage()).toHaveTextContent(conflictKo);
    expect(backing.value).toBe(futureSettings);
    expect(attempts).toHaveLength(1);
  });

  it("실제 localStorage에서도 실행 중 바뀐 값을 덮어쓰지 않고 다른 키도 건드리지 않는다", async () => {
    setViewport(1400);
    window.localStorage.setItem(SETTINGS_KEY, v1());
    window.localStorage.setItem("other.key", "keep");
    const user = userEvent.setup();
    render(<App />);
    window.localStorage.setItem(SETTINGS_KEY, futureSettings);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(SETTINGS_KEY)).toBe(futureSettings);
    expect(window.localStorage.getItem("other.key")).toBe("keep");
  });
});

describe("저장된 값이 화면·진단에 나오지 않음(D)", () => {
  it("손상·미지원·읽기 실패 어느 경우에도 저장값과 예외 문구가 화면과 콘솔에 나오지 않는다", async () => {
    setViewport(1400);
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const marker = "synthetic-stored-marker";
    const cases: SettingsStore[] = [
      { read: () => `{"version":1,"language":"${marker}`, write: () => true },
      { read: () => JSON.stringify({ version: marker }), write: () => true },
      { read: () => JSON.stringify({ version: 1e21, note: marker }), write: () => true },
      { read: () => { throw new Error(marker); }, write: () => true },
    ];
    const user = userEvent.setup();
    for (const store of cases) {
      const view = render(<App settingsStore={store} />);
      await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
      expect(document.body.textContent).not.toContain(marker);
      expect(document.body.innerHTML).not.toContain(marker);
      view.unmount();
    }
    const logged = [...warn.mock.calls, ...error.mock.calls].flat().map(String).join(" ");
    expect(logged).not.toContain(marker);
  });
});

// ---- 최종 정리(T005): 저장된 설정의 의미 동등성(A), 일부 복구 알림 문구(B) ----

/** 들여쓰기·항목 순서만 다르게 쓴 올바른 버전 1 저장값(다른 도구나 사람이 고쳐 쓴 경우). */
const prettyV1 = (layout: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, language: "ko", layout: { ...initialLayout, ...layout }, ...extra }, null, 2);
const reorderedV1 = () => {
  const layout = Object.fromEntries(Object.entries(initialLayout).reverse());
  return JSON.stringify({ layout, language: "ko", version: 1 });
};

describe("저장된 설정의 의미 동등성(최종 정리 A)", () => {
  /** 쓰기가 실패하는 동안 테마를 한 바퀴 돌려(시스템→밝게→어둡게→시스템) 시작 값으로 돌아온다. */
  async function failThenReturn(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    expect(statusMessage()).toHaveTextContent("설정을 저장하지 못했습니다");
    await user.click(screen.getByRole("button", { name: "테마: 밝게" }));
    await user.click(screen.getByRole("button", { name: "테마: 어둡게" }));
    expect(document.documentElement.dataset.theme).toBe("system");
  }

  it("A1·A10 들여쓴 버전 1: 쓰기 실패 뒤 저장된 값으로 돌아오면 다시 쓰지 않고 실패 알림을 지우며, 원문을 기준으로 외부 변경을 계속 감지한다", async () => {
    setViewport(1400);
    const raw = prettyV1();
    const { backing, attempts, client } = sharedBacking(raw);
    backing.writable = false;
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    expect(statusMessage()).toHaveTextContent("준비됨");
    await failThenReturn(user);
    expect(statusMessage()).toHaveTextContent("준비됨");
    expect(attempts).toHaveLength(2); // 돌아온 값은 쓰지 않는다
    expect(backing.value).toBe(raw); // 원문 그대로(압축 형식으로 다시 쓰지 않음)

    // 원문 기준은 그대로다: 같은 설정을 압축 형식으로 바꿔 쓴 외부 변경도 충돌이다.
    backing.writable = true;
    backing.value = v1();
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    expect(statusMessage()).toHaveTextContent("저장된 설정이 다른 곳에서 바뀌어 그대로 두었습니다");
    expect(attempts).toHaveLength(2);
    expect(backing.value).toBe(v1());
  });

  it("A2 항목 순서가 다른 버전 1도 같은 설정이면 저장된 것으로 본다", async () => {
    setViewport(1400);
    const raw = reorderedV1();
    const { backing, attempts, client } = sharedBacking(raw);
    backing.writable = false;
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    await failThenReturn(user);
    expect(statusMessage()).toHaveTextContent("준비됨");
    expect(attempts).toHaveLength(2);
    expect(backing.value).toBe(raw);
  });

  it("A3 모르는 항목이 있는 버전 1: 쓰기 전 확인이 실패한 뒤 같은 설정으로 돌아오면 쓰지 않아 모르는 항목이 지워지지 않는다", async () => {
    setViewport(1400);
    const raw = prettyV1({ density: "compact" }, { sync: { enabled: false } });
    const { backing, attempts, client } = sharedBacking(raw);
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    backing.readable = false; // 쓰기 전 확인 실패: 쓰지 않고 실패로 알림
    await user.selectOptions(screen.getByRole("combobox", { name: "화면 언어" }), "en");
    expect(statusMessage()).toHaveTextContent("Settings could not be saved.");
    backing.readable = true;
    await user.selectOptions(screen.getByRole("combobox", { name: "Display language" }), "ko");
    expect(statusMessage()).toHaveTextContent("준비됨");
    expect(attempts).toEqual([]);
    expect(backing.value).toBe(raw);
  });

  it("A3 모르는 항목이 있는 버전 1: 쓰기 실패 뒤 같은 설정으로 돌아오면 원문과 모르는 항목을 그대로 둔다", async () => {
    setViewport(1400);
    const raw = prettyV1({ density: "compact" }, { sync: { enabled: false } });
    const { backing, attempts, client } = sharedBacking(raw);
    backing.writable = false;
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    await failThenReturn(user);
    expect(statusMessage()).toHaveTextContent("준비됨");
    expect(attempts).toHaveLength(2);
    expect(backing.value).toBe(raw);
    expect(JSON.parse(backing.value!)).toMatchObject({ layout: { density: "compact" }, sync: { enabled: false } });
  });

  it("A4 알려진 항목 값이 하나라도 다르면 같은 설정으로 보지 않는다", async () => {
    setViewport(1400);
    const raw = prettyV1({ zoom: 150 });
    const { backing, client } = sharedBacking(raw);
    backing.writable = false;
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    await user.click(within(screen.getByRole("contentinfo")).getByRole("button", { name: "축소" })); // 150 → 125
    expect(statusMessage()).toHaveTextContent("설정을 저장하지 못했습니다");
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    await user.click(screen.getByRole("button", { name: "테마: 밝게" }));
    await user.click(screen.getByRole("button", { name: "테마: 어둡게" })); // 테마만 같아짐, 배율은 다름
    expect(statusMessage()).toHaveTextContent("설정을 저장하지 못했습니다");
    expect(backing.value).toBe(raw);
  });

  it("A5 형식이 올바르지 않은 저장값(version이 문자열)은 알려진 항목이 기본값과 같아도 저장된 것으로 보지 않는다", async () => {
    setViewport(1400);
    const raw = JSON.stringify({ version: "1", language: "ko", layout: initialLayout }, null, 2);
    const { backing, client } = sharedBacking(raw);
    backing.writable = false;
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    expect(statusMessage()).toHaveTextContent("저장된 설정을 읽을 수 없어 기본값으로 시작했습니다.");
    await failThenReturn(user);
    expect(statusMessage()).toHaveTextContent("설정을 저장하지 못했습니다");
    expect(backing.value).toBe(raw);
  });

  it("A6 항목이 빠진 버전 1은 보정한 설정으로 돌아와도 저장된 것으로 보지 않는다", async () => {
    setViewport(1400);
    const withoutZoom = Object.fromEntries(Object.entries(initialLayout).filter(([key]) => key !== "zoom"));
    const raw = JSON.stringify({ version: 1, language: "ko", layout: withoutZoom }, null, 2);
    const { backing, client } = sharedBacking(raw);
    backing.writable = false;
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    await failThenReturn(user);
    expect(statusMessage()).toHaveTextContent("설정을 저장하지 못했습니다");
    expect(backing.value).toBe(raw);
  });

  it("A7 저장값 없음: 기본값으로 돌아와도 기본값을 쓴 것으로 보지 않는다", async () => {
    setViewport(1400);
    const { backing, client } = sharedBacking(null);
    backing.writable = false;
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    await failThenReturn(user);
    expect(statusMessage()).toHaveTextContent("설정을 저장하지 못했습니다");
    expect(backing.value).toBeNull();
  });

  it("A8 버전 2는 알려진 항목이 같아도 버전 1 설정과 같다고 보지 않고 쓰지 않는다", async () => {
    setViewport(1400);
    const raw = JSON.stringify({ version: 2, language: "ko", layout: initialLayout }, null, 2);
    const { backing, attempts, client } = sharedBacking(raw);
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    await user.click(screen.getByRole("button", { name: "테마: 밝게" }));
    await user.click(screen.getByRole("button", { name: "테마: 어둡게" }));
    expect(statusMessage()).toHaveTextContent("저장된 설정이 더 새로운 버전의 형식이라 그대로 두었습니다");
    expect(statusMessage()).not.toHaveTextContent("준비됨");
    expect(attempts).toEqual([]);
    expect(backing.value).toBe(raw);
  });

  it("A9 원문이 바뀌었으면 같은 설정을 들여 써 바꾼 것이라도 충돌로 보고 쓰지 않는다", async () => {
    setViewport(1400);
    const { backing, attempts, client } = sharedBacking(v1());
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    const external = prettyV1();
    backing.value = external;
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    await user.click(screen.getByRole("button", { name: "테마: 밝게" }));
    await user.click(screen.getByRole("button", { name: "테마: 어둡게" })); // 저장값과 같은 설정으로 돌아와도
    expect(statusMessage()).toHaveTextContent("저장된 설정이 다른 곳에서 바뀌어 그대로 두었습니다");
    expect(attempts).toEqual([]);
    expect(backing.value).toBe(external);
  });

  it("A10 들여쓴 버전 1: 실패 뒤 다른 설정을 실제로 저장하면 알림을 지우고, 그 뒤로는 쓴 값을 기준으로 삼는다", async () => {
    setViewport(1400);
    const { backing, attempts, client } = sharedBacking(prettyV1());
    backing.writable = false;
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    backing.writable = true;
    await user.click(screen.getByRole("button", { name: "테마: 밝게" }));
    expect(statusMessage()).toHaveTextContent("준비됨");
    expect(backing.value).toBe(v1({ theme: "dark" }));
    await user.click(screen.getByRole("button", { name: "테마: 어둡게" })); // 이어서 쓴다(충돌 아님)
    expect(backing.value).toBe(v1());
    expect(attempts).toHaveLength(3);
  });

  it("A11 같은 설정으로 돌아와도 그 사이에 나온 더 최근 알림은 지우지 않는다", async () => {
    setViewport(1400);
    const raw = prettyV1();
    const { backing, client } = sharedBacking(raw);
    backing.writable = false;
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    await user.click(screen.getByRole("button", { name: "굵게" }));
    await user.click(screen.getByRole("button", { name: "테마: 밝게" }));
    await user.click(screen.getByRole("button", { name: "테마: 어둡게" }));
    expect(statusMessage()).toHaveTextContent("굵게: 열린 문서가 없어 사용할 수 없습니다.");
    expect(backing.value).toBe(raw);
  });

  it("A12 StrictMode와 다시 그리기에서도 같은 설정을 다시 쓰거나 알림을 반복하지 않는다", async () => {
    setViewport(1400);
    const raw = prettyV1();
    const { backing, attempts, client } = sharedBacking(raw);
    backing.writable = false;
    const store = client();
    const user = userEvent.setup();
    const view = render(<StrictMode><App settingsStore={store} /></StrictMode>);
    await failThenReturn(user);
    for (let i = 0; i < 3; i += 1) view.rerender(<StrictMode><App settingsStore={store} /></StrictMode>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(attempts).toHaveLength(2);
    expect(screen.getAllByText("준비됨")).toHaveLength(1);
    expect(screen.queryByText(/설정을 저장하지 못했습니다/)).toBeNull();
    expect(backing.value).toBe(raw);
  });
});

describe("일부 복구 알림 문구(최종 정리 B)", () => {
  const recoveredKo = "저장된 설정 일부를 조정하거나 기본값으로 복구했습니다.";
  const recoveredEn = "Some saved settings were adjusted or restored to defaults.";
  const withoutZoom = Object.fromEntries(Object.entries(initialLayout).filter(([key]) => key !== "zoom"));

  it("B1~B3 반올림·범위 보정·빠진 항목·잘못된 항목 모두 같은 일부 복구 알림이고, 시작할 때 쓰지 않는다", () => {
    setViewport(1400);
    const cases = [
      v1({ navigationWidth: 240.5 }), // 반올림
      v1({ propertiesWidth: 99999 }), // 범위 보정
      v1({ navigationWidth: 1 }),
      JSON.stringify({ version: 1, language: "ko", layout: withoutZoom }), // 빠진 항목
      v1({ ribbonCollapsed: "yes" }), // 잘못된 항목
    ];
    for (const raw of cases) {
      const { backing, attempts, client } = sharedBacking(raw);
      const view = render(<App settingsStore={client()} />);
      expect(statusMessage(), raw).toHaveTextContent(recoveredKo);
      expect(screen.getAllByRole("status").find((e) => !e.hasAttribute("aria-label"))!.textContent, raw).toBe(recoveredKo);
      expect(attempts, raw).toEqual([]);
      expect(backing.value, raw).toBe(raw);
      view.unmount();
    }
  });

  it("B4 일부 복구 알림은 영어로 바꾸면 전체 문장이 바뀌고 다시 한국어로 돌아온다", async () => {
    setViewport(1400);
    const { client } = sharedBacking(v1({ propertiesWidth: 99999 }));
    const user = userEvent.setup();
    render(<App settingsStore={client()} />);
    expect(statusMessage().textContent).toBe(recoveredKo);
    await user.selectOptions(screen.getByRole("combobox", { name: "화면 언어" }), "en");
    expect(statusMessage().textContent).toBe(recoveredEn);
    await user.selectOptions(screen.getByRole("combobox", { name: "Display language" }), "ko");
    expect(statusMessage().textContent).toBe(recoveredKo);
  });

  it("B5·B6 첫 실행·정상 복원은 준비됨, 형식 오류·미지원 버전·읽기 실패는 각자의 알림을 그대로 쓴다", () => {
    setViewport(1400);
    const cases: [SettingsStore, string][] = [
      [sharedBacking(null).client(), "준비됨"],
      [sharedBacking(v1()).client(), "준비됨"],
      [sharedBacking(prettyV1()).client(), "준비됨"],
      [sharedBacking("{corrupt").client(), "저장된 설정을 읽을 수 없어 기본값으로 시작했습니다."],
      [sharedBacking(futureSettings).client(),
        "저장된 설정이 더 새로운 버전의 형식이라 그대로 두었습니다. 바꾼 설정은 이번 실행 동안만 적용됩니다."],
      [{ read: () => { throw new Error("synthetic-read-error-marker"); }, write: () => true },
        "설정 저장소에 접근할 수 없어 기본값으로 시작했습니다. 바꾼 설정은 이번 실행 동안만 적용됩니다."],
    ];
    for (const [store, expected] of cases) {
      const view = render(<App settingsStore={store} />);
      expect(statusMessage().textContent).toBe(expected);
      view.unmount();
    }
  });
});
