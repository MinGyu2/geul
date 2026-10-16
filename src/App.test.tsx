import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";
import { initialLayout, PANEL_LIMITS } from "./hooks/layoutState";

function setup(width = 1400) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  const user = userEvent.setup();
  const view = render(<App />);
  return { user, ...view };
}

// 상태 표시줄의 알림 영역(이름 없는 role=status). 배율 표시 <output>도 role=status이므로 구분한다.
const statusMessage = () => {
  const region = screen.getAllByRole("status").find((element) => !element.hasAttribute("aria-label"));
  if (!region) throw new Error("알림 영역 없음");
  return region;
};

describe("6영역 레이아웃", () => {
  it("제목 표시줄, 리본, 탐색 창, 편집 영역, 속성 창, 상태 표시줄을 모두 그린다", () => {
    setup();
    expect(screen.getByRole("banner", { name: "제목 표시줄" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "리본" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "탐색" })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "문서 편집 영역" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "속성" })).toBeInTheDocument();
    expect(screen.getByRole("contentinfo", { name: "상태 표시줄" })).toBeInTheDocument();
  });

  it("문서가 없다는 사실을 숨기지 않는다", () => {
    setup();
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { name: "열린 문서가 없습니다" })).toBeInTheDocument();
    expect(within(main).queryByRole("textbox")).not.toBeInTheDocument();
    expect(main.querySelector("[contenteditable]")).toBeNull();
    const formats = within(screen.getByRole("complementary", { name: "속성" })).getAllByText("통합 전");
    expect(formats).toHaveLength(3);
  });
});

describe("패널 표시와 숨기기", () => {
  it("탐색 창을 닫기 버튼으로 숨기고 제목 표시줄 토글로 되살리며 초점을 잃지 않는다", async () => {
    const { user } = setup();
    const toggle = screen.getByRole("button", { name: "탐색 창 표시" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "탐색 창 닫기" }));
    expect(screen.queryByRole("complementary", { name: "탐색" })).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.getByRole("complementary", { name: "탐색" })).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("속성 창도 독립적으로 숨기고 되살린다", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "속성 창 닫기" }));
    expect(screen.queryByRole("complementary", { name: "속성" })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "탐색" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "속성 창 표시" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "속성 창 표시" }));
    expect(screen.getByRole("complementary", { name: "속성" })).toBeInTheDocument();
  });

  it("보기 탭의 창 명령으로도 패널을 바꾼다", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "보기" }));
    const command = screen.getByRole("button", { name: "탐색 창" });
    expect(command).toHaveAttribute("aria-pressed", "true");
    await user.click(command);
    expect(screen.queryByRole("complementary", { name: "탐색" })).not.toBeInTheDocument();
    expect(command).toHaveAttribute("aria-pressed", "false");
  });
});

describe("패널 크기 조절", () => {
  it("키보드로 탐색 창 너비를 바꾸고 최소·최대 값에서 멈춘다", async () => {
    const { user } = setup();
    const handle = screen.getByRole("separator", { name: "탐색 창 너비 조절" });
    expect(handle).toHaveAttribute("aria-valuenow", String(PANEL_LIMITS.navigation.initial));
    handle.focus();
    await user.keyboard("{ArrowRight}");
    expect(handle).toHaveAttribute("aria-valuenow", String(PANEL_LIMITS.navigation.initial + 16));
    await user.keyboard("{Home}");
    expect(handle).toHaveAttribute("aria-valuenow", String(PANEL_LIMITS.navigation.min));
    await user.keyboard("{ArrowLeft}");
    expect(handle).toHaveAttribute("aria-valuenow", String(PANEL_LIMITS.navigation.min));
    await user.keyboard("{End}");
    expect(handle).toHaveAttribute("aria-valuenow", String(PANEL_LIMITS.navigation.max));
    await user.keyboard("{Enter}");
    expect(handle).toHaveAttribute("aria-valuenow", String(PANEL_LIMITS.navigation.initial));
  });

  it("오른쪽 속성 창은 왼쪽 화살표로 넓어진다", async () => {
    const { user } = setup();
    const handle = screen.getByRole("separator", { name: "속성 창 너비 조절" });
    handle.focus();
    await user.keyboard("{ArrowLeft}");
    expect(handle).toHaveAttribute("aria-valuenow", String(PANEL_LIMITS.properties.initial + 16));
  });

  it("포인터로 끌어 너비를 바꾼다", () => {
    setup();
    const handle = screen.getByRole("separator", { name: "탐색 창 너비 조절" });
    handle.setPointerCapture = () => undefined;
    handle.hasPointerCapture = () => true;
    handle.releasePointerCapture = () => undefined;
    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 240, pointerId: 1 }));
      handle.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 300, pointerId: 1 }));
      handle.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 300, pointerId: 1 }));
    });
    expect(handle).toHaveAttribute("aria-valuenow", "300");
  });

  it("좁은 창에서는 편집 영역 최소 너비를 위해 패널 최대 너비를 줄인다", () => {
    setup(960);
    const handle = screen.getByRole("separator", { name: "탐색 창 너비 조절" });
    expect(Number(handle.getAttribute("aria-valuemax"))).toBe(960 - PANEL_LIMITS.properties.initial - 360);
  });
});

describe("리본", () => {
  it("접기 버튼과 Ctrl+F1로 접고 펼친다", async () => {
    const { user } = setup();
    const collapse = screen.getByRole("button", { name: "리본 접기" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("tabpanel")).toBeInTheDocument();

    await user.click(collapse);
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "리본 펼치기" })).toHaveAttribute("aria-expanded", "false");

    await user.keyboard("{Control>}{F1}{/Control}");
    expect(screen.getByRole("tabpanel")).toBeInTheDocument();
  });

  it("접힌 상태에서 탭을 누르면 해당 탭으로 펼친다", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "리본 접기" }));
    await user.click(screen.getByRole("tab", { name: "삽입" }));
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("삽입");
  });

  it("리본 안에서 접으면 초점을 접기 버튼으로 옮긴다", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "보기" }));
    await user.click(screen.getByRole("button", { name: "리본 접기", pressed: false }));
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "리본 펼치기" })).toHaveFocus();
  });

  it("탭 목록은 화살표·Home·End로 이동하고 탭 정지점은 하나다", async () => {
    const { user } = setup();
    const home = screen.getByRole("tab", { name: "홈" });
    expect(home).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab").filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
    home.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "삽입" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "삽입" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "도움말" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "파일" })).toHaveAttribute("aria-selected", "true");
  });

  it("도구 모음 안은 화살표로 이동한다", async () => {
    const { user } = setup();
    const toolbar = screen.getByRole("toolbar", { name: "홈" });
    const buttons = within(toolbar).getAllByRole("button");
    await user.click(buttons[0]!);
    await user.keyboard("{ArrowRight}");
    expect(buttons[1]).toHaveFocus();
    await user.keyboard("{End}");
    expect(buttons.at(-1)).toHaveFocus();
  });

  it("형식 전용 탭은 대상 형식을 안내한다", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "한글 도구" }));
    expect(screen.getByText("HWP/HWPX 문서 전용 도구입니다.")).toBeInTheDocument();
  });
});

describe("지원하지 않는 문서 명령", () => {
  it("저장·실행 취소·서식은 비활성으로 표시되고 눌러도 아무것도 바꾸지 않는다", async () => {
    const { user } = setup();
    const quick = screen.getByRole("group", { name: "빠른 실행" });
    for (const name of ["저장", "실행 취소", "다시 실행"]) {
      expect(within(quick).getByRole("button", { name })).toHaveAttribute("aria-disabled", "true");
    }
    const bold = screen.getByRole("button", { name: "굵게" });
    expect(bold).toHaveAttribute("aria-disabled", "true");
    expect(bold).not.toHaveAttribute("aria-pressed");

    const before = document.body.innerHTML.replace(/<span class="statusbar__message".*?<\/span>/, "");
    await user.click(bold);
    expect(statusMessage()).toHaveTextContent("굵게: 문서 엔진이 아직 연결되지 않아 사용할 수 없습니다.");
    expect(bold).not.toHaveAttribute("aria-pressed");
    const after = document.body.innerHTML.replace(/<span class="statusbar__message".*?<\/span>/, "");
    expect(after).toBe(before);
  });

  it("파일 탭의 열기·저장은 실행되지 않는다", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "파일" }));
    const toolbar = screen.getByRole("toolbar", { name: "파일" });
    for (const button of within(toolbar).getAllByRole("button")) {
      expect(button).toHaveAttribute("aria-disabled", "true");
    }
    await user.click(within(toolbar).getByRole("button", { name: "열기" }));
    expect(statusMessage()).toHaveTextContent("열기: 문서 엔진이 아직 연결되지 않아");
  });
});

describe("테마와 확대/축소", () => {
  it("제목 표시줄에서 시스템 → 밝게 → 어둡게 순서로 바꾼다", async () => {
    const { user } = setup();
    expect(document.documentElement.dataset.theme).toBe("system");
    await user.click(screen.getByRole("button", { name: "테마: 시스템" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    await user.click(screen.getByRole("button", { name: "테마: 밝게" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await user.click(screen.getByRole("tab", { name: "보기" }));
    expect(screen.getByRole("button", { name: "어두운 테마" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "시스템 테마" }));
    expect(document.documentElement.dataset.theme).toBe("system");
  });

  it("상태 표시줄에서 빈 페이지 배율을 바꾸고 한계에서 멈춘다", async () => {
    const { user } = setup();
    const zoom = screen.getByRole("status", { name: "확대/축소 비율" });
    const zoomIn = within(screen.getByRole("contentinfo")).getByRole("button", { name: "확대" });
    const zoomOut = within(screen.getByRole("contentinfo")).getByRole("button", { name: "축소" });
    await user.click(zoomIn);
    expect(zoom).toHaveTextContent("110%");
    for (let i = 0; i < 10; i += 1) await user.click(zoomIn);
    expect(zoom).toHaveTextContent("200%");
    expect(zoomIn).toHaveAttribute("aria-disabled", "true");
    for (let i = 0; i < 12; i += 1) await user.click(zoomOut);
    expect(zoom).toHaveTextContent("50%");
    expect(zoomOut).toHaveAttribute("aria-disabled", "true");
  });

  it("도움말 정보는 현재 단계의 한계를 알린다", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "도움말" }));
    await user.click(screen.getByRole("button", { name: "geul 정보" }));
    expect(statusMessage()).toHaveTextContent("문서 열기·편집·저장은 아직 지원하지 않습니다");
  });
});

describe("초기 상태 주입", () => {
  it("저장된 배치(T005에서 복원할 값)를 그대로 그린다", () => {
    render(<App initialState={{ ...initialLayout, navigationVisible: false, ribbonCollapsed: true }} />);
    expect(screen.queryByRole("complementary", { name: "탐색" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
  });
});
