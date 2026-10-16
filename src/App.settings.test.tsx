import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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

const storedJson = () => JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "null");

function expectKorean() {
  expect(document.documentElement.lang).toBe("ko");
  expect(screen.getByRole("banner", { name: "제목 표시줄" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "홈" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "글꼴" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "굵게" })).toHaveAttribute("title", "굵게 — 사용할 수 없음 — 문서 엔진 연결 전");
  expect(screen.getByRole("complementary", { name: "탐색" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "열린 문서가 없습니다" })).toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "속성" })).toBeInTheDocument();
  expect(screen.getByRole("contentinfo", { name: "상태 표시줄" })).toHaveTextContent("준비됨");
  expect(screen.getByRole("separator", { name: "탐색 창 너비 조절" })).toBeInTheDocument();
}

function expectEnglish({ ready = true } = {}) {
  expect(document.documentElement.lang).toBe("en");
  expect(screen.getByRole("banner", { name: "Title bar" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Home" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Font" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Bold" }))
    .toHaveAttribute("title", "Bold — Unavailable — no document engine connected yet");
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
    expect(message()).toHaveTextContent("굵게: 문서 엔진이 아직 연결되지 않아 사용할 수 없습니다.");
    await user.selectOptions(screen.getByRole("combobox", { name: "화면 언어" }), "en");
    expect(message()).toHaveTextContent("Bold: unavailable until a document engine is connected.");
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
    expectKorean();
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
