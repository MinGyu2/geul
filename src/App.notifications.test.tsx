import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "./language";
import en from "./language/en.json";
import ko from "./language/ko.json";
import App from "./App";

const ribbonBridge = vi.hoisted(() => ({
  notify: null as ((message: unknown) => void) | null,
}));

// Keep App, CommandContext, translations, and StatusBar real. The Ribbon mock only
// gives tests a deterministic way to exercise the same notify callback as commands.
vi.mock("./components/Ribbon/Ribbon", () => ({
  Ribbon: ({ context }: { context: { notify: (message: unknown) => void } }) => {
    ribbonBridge.notify = context.notify;
    return <div aria-label="test command source" />;
  },
}));

const noticeToggle = () => screen.getByRole("button", { name: /details|전문|알림/i });
const acknowledgeButton = () => screen.getByRole("button", { name: /acknowledge|dismiss|확인/i });
const detailsRegion = () => screen.getByRole("region", { name: /details|warning|알림|경고/i });
const statusMessage = () => {
  const region = screen.getAllByRole("status").find((element) => !element.hasAttribute("aria-label"));
  if (!region) throw new Error("알림 상태 영역이 없습니다");
  return region;
};

function emit(message: Message) {
  if (!ribbonBridge.notify) throw new Error("Ribbon 명령 알림 주입이 준비되지 않았습니다");
  act(() => ribbonBridge.notify!(message));
}

function setup(language: "ko" | "en" = "ko") {
  const user = userEvent.setup();
  render(<App initialLanguage={language} settingsStore={{ read: () => null, write: () => true }} documentWorkspace={null} />);
  return { user };
}

async function acknowledgeActive(user: ReturnType<typeof userEvent.setup>) {
  await user.click(noticeToggle());
  await user.click(acknowledgeButton());
}

afterEach(() => {
  ribbonBridge.notify = null;
});

describe("App publication and actionable notification ownership", () => {
  it("keeps an unacknowledged publication warning when ordinary status arrives", () => {
    setup("en");
    emit({ key: "document.error.RestoredUnopenedAlreadyOpen" });
    emit({ key: "status.ready" });

    expect(statusMessage()).toHaveTextContent(en["document.error.RestoredUnopenedAlreadyOpen"]);
    expect(noticeToggle()).toBeInTheDocument();
  });

  it("presents a Save As conflict and later document error in FIFO order after a publication warning", async () => {
    const { user } = setup("en");
    emit({ key: "document.error.RestoredUnopenedAlreadyOpen" });
    emit({ key: "document.saveAsConflict" });
    emit({ key: "document.error.FileConflict" });

    expect(statusMessage()).toHaveTextContent(en["document.error.RestoredUnopenedAlreadyOpen"]);
    await acknowledgeActive(user);
    expect(statusMessage()).toHaveTextContent(en["document.saveAsConflict"]);
    await acknowledgeActive(user);
    expect(statusMessage()).toHaveTextContent(en["document.error.FileConflict"]);
    await acknowledgeActive(user);
    expect(screen.queryByRole("button", { name: /details|전문|알림/i })).not.toBeInTheDocument();
  });

  it("retains consecutive publication warnings with their own message variables", async () => {
    const { user } = setup("en");
    emit({ key: "document.createdUnconfirmed", vars: { name: "first.docx" } });
    emit({ key: "document.error.RestoredUnopened", vars: { reason: { key: "document.error.ResourceLimit" } } });

    await user.click(noticeToggle());
    expect(detailsRegion()).toHaveTextContent("first.docx");
    await user.click(acknowledgeButton());
    expect(statusMessage()).toHaveTextContent("could not be opened (The document exceeds a processing limit.)");
    await user.click(noticeToggle());
    expect(detailsRegion()).toHaveTextContent(
      "could not be opened (The document exceeds a processing limit.)",
    );
    await user.click(acknowledgeButton());
    expect(screen.queryByRole("button", { name: /details|전문|알림/i })).not.toBeInTheDocument();
  });

  it("keeps repeated occurrences of the same key as separate reviewable notices", async () => {
    const { user } = setup("en");
    emit({ key: "document.createdUnconfirmed", vars: { name: "first.docx" } });
    emit({ key: "document.createdUnconfirmed", vars: { name: "second.docx" } });

    await user.click(noticeToggle());
    expect(detailsRegion()).toHaveTextContent("first.docx");
    await user.click(acknowledgeButton());
    expect(statusMessage()).toHaveTextContent("second.docx");
    await user.click(noticeToggle());
    expect(detailsRegion()).toHaveTextContent("second.docx");
    await user.click(acknowledgeButton());
    expect(screen.queryByRole("button", { name: /details|전문|알림/i })).not.toBeInTheDocument();
  });

  it("translates queued messages and their variables in the currently selected language", async () => {
    const { user } = setup("en");
    emit({ key: "document.createdUnconfirmed", vars: { name: "first.docx" } });
    emit({ key: "document.error.RestoredUnopened", vars: { reason: { key: "document.error.ResourceLimit" } } });

    await user.selectOptions(screen.getByRole("combobox", { name: "Display language" }), "ko");
    await user.click(noticeToggle());
    expect(detailsRegion()).toHaveTextContent(ko["document.createdUnconfirmed"].replace("{name}", "first.docx"));
    await user.click(acknowledgeButton());
    const restoredUnopened = ko["document.error.RestoredUnopened"].replace("{reason}", ko["document.error.ResourceLimit"]);
    expect(statusMessage()).toHaveTextContent(restoredUnopened);
    await user.click(noticeToggle());
    expect(detailsRegion()).toHaveTextContent(restoredUnopened);
    await user.click(acknowledgeButton());
  });

  it("keeps ordinary status messages compact when no actionable notice is pending", () => {
    setup("en");
    emit({ key: "status.ready" });

    expect(statusMessage()).toHaveTextContent(en["status.ready"]);
    expect(screen.queryByRole("button", { name: /details|전문|알림/i })).not.toBeInTheDocument();
  });
});

// Connected focus destinations are part of the notification interaction contract.
it.each(["{Enter}", " "])("acknowledges queued notices with usable keyboard focus (%s)", async key => {
  const { user } = setup("en");
  emit({ key: "document.error.FilePublishedUnconfirmed" });
  emit({ key: "document.saveAsConflict" });
  noticeToggle().focus();
  for (let i = 0; i < 2; i++) {
    await user.keyboard("{Enter}");
    await user.tab();
    await user.tab();
    expect(acknowledgeButton()).toHaveFocus();
    await user.keyboard(key);
    expect(document.activeElement?.isConnected).toBe(true);
    if (i === 0) {
      expect(noticeToggle()).toHaveFocus();
      expect(noticeToggle()).toHaveAttribute("aria-expanded", "false");
      expect(statusMessage()).toHaveTextContent(en["document.saveAsConflict"]);
    } else expect(screen.getByRole("contentinfo")).toHaveFocus();
  }
  await user.tab();
  expect(screen.getByRole("button", { name: "Zoom Out" })).toHaveFocus();
});

it("acknowledges through a pointer without taking composition ownership from the editor", async () => {
  const { user } = setup("ko");
  emit({ key: "document.error.RestoredUnopenedAlreadyOpen" });
  await user.click(noticeToggle());
  const input = document.createElement("textarea");
  input.className = "rhwp-input";
  input.value = "한글";
  document.body.append(input);
  try {
    input.focus();
    input.setSelectionRange(1, 2);
    const compositionEnd = vi.fn();
    input.addEventListener("compositionend", compositionEnd);
    await user.click(acknowledgeButton());
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 2]);
    expect(compositionEnd).not.toHaveBeenCalled();
  } finally { input.remove(); }
});

it("does not dispatch document or global commands from notice controls", async () => {
  const { user } = setup("en");
  emit({ key: "document.saveAsConflict" });
  noticeToggle().focus();
  await user.keyboard("{Control>}b{/Control}");
  await user.keyboard("{Enter}");
  await user.tab();
  await user.keyboard("{Control>}b{/Control}");
  await user.click(acknowledgeButton());
  // A leaked Ctrl+B would replace the transient status with command-unavailable text.
  expect(statusMessage()).toHaveTextContent("Ready");
});
