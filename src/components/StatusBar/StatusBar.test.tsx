import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../commands/commands";
import { initialLayout } from "../../hooks/layoutState";
import { LanguageProvider } from "../../language/LanguageContext";
import en from "../../language/en.json";
import ko from "../../language/ko.json";
import { createNotificationState, notificationReducer } from "./publicationWarning";
import type { MessageKey } from "../../language";
import type { DocumentPanelState } from "../Editor/documentPanels";
import { StatusBar } from "./StatusBar";

const state: DocumentPanelState = {
  info: null, status: "idle", pageCount: null, page: null, caret: null,
  selection: "unavailable", selectedText: null, paragraphStyle: null, format: null,
  canNavigate: false, pending: false, composing: false, unpreserved: false,
};

function setup(language: "ko" | "en", options: { message?: MessageKey; modal?: boolean; busy?: boolean } = {}) {
  const dispatch = vi.fn();
  const onDismissMessage = vi.fn();
  const context = {
    layout: { ...initialLayout, zoom: 125 }, dispatch, notify: vi.fn(), document: null,
    modal: options.modal ?? false, files: { busy: options.busy ?? false, open: vi.fn(), newDocument: vi.fn(), saveAs: vi.fn() },
  } satisfies CommandContext;
  const message = { key: options.message ?? "document.error.RestoredUnopenedAlreadyOpen" } as const;
  const view = render(
    <LanguageProvider language={language} onLanguageChange={vi.fn()}>
      <StatusBar context={context} message={message} state={state} onDismissMessage={onDismissMessage} />
    </LanguageProvider>,
  );
  return { ...view, dispatch, onDismissMessage, context };
}

const fullStatusMessage = () => screen.getAllByRole("status").find((element) => !element.hasAttribute("aria-label"))!;
const warning = (language: "ko" | "en") => (language === "ko" ? ko : en)["document.error.RestoredUnopenedAlreadyOpen"];

describe.each([["ko"], ["en"]] as const)("recovery warning details (%s)", (language) => {
  it("exposes the full translated warning through a named keyboard disclosure", async () => {
    const user = userEvent.setup();
    setup(language);
    const status = fullStatusMessage();
    const toggle = screen.getByRole("button", { name: /details|전문|자세히/i });

    expect(status).toHaveTextContent(warning(language)!);
    expect(toggle).toHaveAttribute("aria-describedby", status.id);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls");
    expect(toggle).toHaveAccessibleName();
    expect(document.activeElement).not.toBe(toggle);

    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const region = screen.getByRole("region");
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveAccessibleName();
    expect(within(region).getByText(warning(language)!)).toBeInTheDocument();
    expect(document.activeElement).toBe(toggle);

    region.focus();
    fireEvent.keyDown(region, { key: "Escape", isComposing: true });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(region, { key: "Escape" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(toggle);
  });
});

describe("status bar notification behavior", () => {
  it("keeps details reachable at a narrow viewport and dismisses only on explicit acknowledgement", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    const user = userEvent.setup();
    const view = setup("en");
    const toggle = screen.getByRole("button", { name: /details/i });
    expect(toggle).toBeVisible();
    await user.click(toggle);
    const region = screen.getByRole("region");
    await user.click(within(region).getByRole("button", { name: /dismiss/i }));
    expect(view.onDismissMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary messages compact and leaves zoom commands operational", async () => {
    const view = setup("en", { message: "status.ready" });
    expect(fullStatusMessage()).toHaveTextContent("Ready");
    expect(screen.queryByRole("button", { name: /details/i })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Zoom Out" }));
    expect(view.dispatch).toHaveBeenCalledWith({ type: "zoom", direction: "out" });
  });

  it.each([{ modal: true }, { busy: true }])("does not open details while another native/modal workflow is active (%o)", async (options) => {
    const user = userEvent.setup();
    setup("en", options);
    const toggle = screen.getByRole("button", { name: /details/i });
    expect(toggle).toBeDisabled();
    await user.click(toggle);
    expect(screen.queryByRole("region")).toBeNull();
  });
});

// The disclosure uses the same pointer-focus guard as editor commands.
it("does not take focus from a composing editor when opening publication details", async () => {
  setup("ko");
  const input = document.createElement("textarea");
  input.className = "rhwp-input";
  document.body.append(input);
  try {
    input.focus();
    input.setSelectionRange(0, 0);
    fireEvent.compositionStart(input);
    await userEvent.setup().click(screen.getByRole("button", { name: /전문/ }));
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(screen.getByRole("region")).toBeVisible();
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(screen.getByRole("region")).toBeVisible();
  } finally { input.remove(); }
});

it.each([
  "document.error.RestoredUnopened", "document.error.FilePublishedUnconfirmed",
  "document.error.FilePublishedUnregistered", "document.createdUnconfirmed",
] as const)("keeps %s accessible until acknowledged", key => {
  const message = { key };
  setup("en", { message: key });
  expect(screen.getByRole("button", { name: /details/i })).toBeEnabled();
  const notifications = notificationReducer(createNotificationState(message), { type: "notify", message: { key: "status.ready" } });
  expect(notifications.pending[0]?.message).toEqual(message);
});

it.each(["{Enter}", " "])("acknowledgement keeps keyboard focus connected (%s)", async key => {
  const user = userEvent.setup();
  function Harness() {
    const [message, setMessage] = useState<{ key: MessageKey }>({ key: "document.error.RestoredUnopenedAlreadyOpen" });
    const context: CommandContext = { layout: initialLayout, dispatch: vi.fn(), notify: vi.fn(), document: null };
    return <LanguageProvider language="en" onLanguageChange={() => {}}>
      <StatusBar context={context} message={message} state={state} onDismissMessage={() => setMessage({ key: "status.ready" })} />
    </LanguageProvider>;
  }
  render(<Harness />);
  const toggle = screen.getByRole("button", { name: "View details" });
  toggle.focus();
  await user.keyboard("{Enter}");
  await user.tab(); // scrollable region
  await user.tab(); // acknowledge
  expect(screen.getByRole("button", { name: "Dismiss warning" })).toHaveFocus();
  await user.keyboard(key);
  expect(screen.queryByRole("button", { name: "View details" })).toBeNull();
  expect(screen.getByRole("contentinfo")).toHaveFocus();
  expect(document.activeElement?.isConnected).toBe(true);
});
