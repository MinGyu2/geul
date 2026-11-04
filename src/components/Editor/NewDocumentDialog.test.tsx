import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../../language/LanguageContext";
import { NewDocumentDialog } from "./NewDocumentDialog";

function renderDialog(language: "ko" | "en", onChoose = vi.fn()) {
  const view = render(
    <LanguageProvider language={language} onLanguageChange={() => {}}>
      <NewDocumentDialog onChoose={onChoose} />
    </LanguageProvider>,
  );
  return { ...view, onChoose };
}

describe("새 문서 형식 선택 dialog", () => {
  it.each([
    ["ko", "Word 문서 (.docx)", "한글 문서 (.hwp)", "한글 XML 문서 (.hwpx)"],
    ["en", "Word document (.docx)", "HWP document (.hwp)", "HWPX document (.hwpx)"],
  ] as const)("shows %s format choices and focuses the initial choice", (language, ...labels) => {
    renderDialog(language);
    const radios = labels.map(label => screen.getByRole("radio", { name: label }));
    expect(radios).toHaveLength(3);
    expect(radios[0]).toBeChecked();
    expect(radios[0]).toHaveFocus();
  });

  it("cycles format selection with ArrowDown and ArrowUp", () => {
    renderDialog("ko");
    const docx = screen.getByRole("radio", { name: "Word 문서 (.docx)" });
    const hwp = screen.getByRole("radio", { name: "한글 문서 (.hwp)" });
    const hwpx = screen.getByRole("radio", { name: "한글 XML 문서 (.hwpx)" });

    fireEvent.keyDown(docx, { key: "ArrowDown" });
    expect(hwp).toBeChecked();
    expect(hwp).toHaveFocus();
    fireEvent.keyDown(hwp, { key: "ArrowUp" });
    expect(docx).toBeChecked();
    expect(docx).toHaveFocus();
    fireEvent.keyDown(docx, { key: "ArrowUp" });
    expect(hwpx).toBeChecked();
    expect(hwpx).toHaveFocus();
  });

  it("traps Tab focus in the dialog in both directions", () => {
    renderDialog("en");
    const docx = screen.getByRole("radio", { name: "Word document (.docx)" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const choose = screen.getByRole("button", { name: "Choose destination" });

    fireEvent.keyDown(docx, { key: "Tab" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(docx).toHaveFocus();
    choose.focus();
    fireEvent.keyDown(choose, { key: "Tab" });
    expect(docx).toHaveFocus();
  });

  it("returns null for Escape or cancel and returns the selected format", () => {
    const { onChoose } = renderDialog("en");
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onChoose).toHaveBeenLastCalledWith(null);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChoose).toHaveBeenLastCalledWith(null);

    fireEvent.click(screen.getByRole("radio", { name: "HWPX document (.hwpx)" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
    expect(onChoose).toHaveBeenLastCalledWith("hwpx");
  });
});
