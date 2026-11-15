// Stage 5-A font picker: catalog browsing, keyboard selection, application only through `format.font` on the active
// session, mixed selections, user font management and localized labels. The catalog/engines are fakes here; the real
// font database and WordCraft formatting are tested in Rust (src-tauri/src/fonts/tests.rs, adapters/wordcraft/font_tests.rs).
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parseFontCatalog } from "../../adapters/fonts";
import { catalogWire } from "../../adapters/fonts.fixture";
import type { CommandContext } from "../../commands/commands";
import type { DocumentCommandArgs, DocumentCommandSnapshot, DocumentCommandTarget } from "../../commands/target";
import type { FontController } from "../../fonts/useFonts";
import { initialLayout } from "../../hooks/layoutState";
import type { Language, Message } from "../../language";
import { LanguageProvider } from "../../language/LanguageContext";
import { FontPicker } from "./FontPicker";

const snapshot = (patch: Partial<DocumentCommandSnapshot> = {}): DocumentCommandSnapshot => ({
  sessionId: 1, engine: "wordcraft", loadGeneration: 1, revision: 0, loaded: true, editable: true, composing: false,
  pending: false, queuedHistory: null, saving: false, history: { undo: false, redo: false },
  format: { bold: false, italic: false, underline: false, strikethrough: false }, formatAccess: "allowed",
  font: { family: "Source Sans 3" }, parameters: { "format.font": { font: { family: "Source Sans 3" } } },
  ...patch,
});

function setup(options: { state?: DocumentCommandSnapshot; language?: Language; modal?: boolean } = {}) {
  const executed: [string, DocumentCommandArgs | undefined, number][] = [];
  const state = options.state ?? snapshot();
  const target: DocumentCommandTarget = {
    sessionId: state.sessionId, engine: state.engine, snapshot: () => state,
    execute: (command, args) => { executed.push([command, args, state.sessionId]); return { accepted: true }; },
  };
  const fonts: FontController = {
    catalog: parseFontCatalog(catalogWire), busy: false,
    refresh: vi.fn(async () => {}), register: vi.fn(async () => {}), remove: vi.fn(async () => {}),
  };
  const notices: Message[] = [];
  const context: CommandContext = { layout: initialLayout, dispatch: () => {}, notify: (m) => notices.push(m), document: target, fonts, modal: options.modal ?? false };
  render(
    <LanguageProvider language={options.language ?? "en"} onLanguageChange={() => {}}>
      <FontPicker context={context} tabIndex={0} />
    </LanguageProvider>,
  );
  return { executed, fonts, notices, input: screen.getByRole("combobox") as HTMLInputElement };
}

describe("FontPicker", () => {
  it("shows the selection's font and lists user, system and bundled fonts without editing the document", () => {
    const { input, executed } = setup();
    expect(input.value).toBe("Source Sans 3");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const list = screen.getByRole("listbox", { name: "Available fonts" });
    expect(within(list).getAllByRole("option").map((o) => o.dataset.fontId)).toEqual(["user:geul test", "system:nanumgothic", "bundled:source sans 3"]);
    expect(within(list).getByText("User fonts")).toBeInTheDocument();
    expect(within(list).getByText("System fonts")).toBeInTheDocument();
    expect(executed).toEqual([]);
  });

  it("filters by family or localized name and applies the chosen family to the active session only", () => {
    const { input, executed } = setup();
    fireEvent.change(input, { target: { value: "나눔" } });
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options.map((o) => o.dataset.fontId)).toEqual(["system:nanumgothic"]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(executed).toEqual([["format.font", { command: "format.font", family: "NanumGothic" }, 1]]);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("navigates with the keyboard and closes with Escape", () => {
    const { input, executed } = setup();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1]!.id);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(executed).toEqual([]);
  });

  it("does not present a single family for a mixed selection", () => {
    const { input } = setup({ state: snapshot({ font: { family: null }, parameters: { "format.font": { font: { family: null } } } }) });
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("(Mixed fonts)");
  });

  it("refuses font changes where the engine does not support them (HWP/HWPX) and says why", () => {
    const { input, executed, notices } = setup({ state: snapshot({ engine: "rhwp", parameters: {} }) });
    expect(input.title).toBe("Font — Not supported for this document format");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(executed).toEqual([]);
    expect(notices.map((n) => n.key)).toEqual(["command.unavailable.engineUnsupported"]);
  });

  it("adds, removes (user fonts only) and refreshes fonts", () => {
    const { input, fonts } = setup();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "Add font…" }));
    expect(fonts.register).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.queryByRole("button", { name: "Remove NanumGothic" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove Geul Test" }));
    expect(fonts.remove).toHaveBeenCalledWith("Geul Test");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh fonts" }));
    expect(fonts.refresh).toHaveBeenCalledOnce();
  });

  it("is labelled in Korean and blocked while a dialog is open", () => {
    const { input } = setup({ language: "ko", modal: true });
    expect(input).toHaveAccessibleName("글꼴");
    expect(input).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("button", { name: "글꼴 목록 보기" })).toHaveAttribute("aria-disabled", "true");
  });
});
