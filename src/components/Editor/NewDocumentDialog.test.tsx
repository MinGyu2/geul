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
  it("yields its modal layer to window confirmation, preserving format and original focus ownership", () => {
    const opener = document.createElement("input");
    document.body.append(opener); opener.focus();
    const choose = vi.fn();
    const dialog = (suspended: boolean) => <LanguageProvider language="ko" onLanguageChange={() => {}}>
      <NewDocumentDialog onChoose={choose} suspended={suspended} />
    </LanguageProvider>;
    const view = render(dialog(false));
    fireEvent.click(screen.getByRole("radio", { name: "한글 XML 문서 (.hwpx)" }));
    view.rerender(dialog(true));
    expect(screen.queryByTestId("new-document-dialog")).toBeNull();
    const confirmation = document.createElement("div");
    confirmation.setAttribute("role", "alertdialog"); confirmation.setAttribute("aria-modal", "true");
    const cancel = document.createElement("button"); confirmation.append(cancel); document.body.append(confirmation); cancel.focus();
    expect(document.querySelectorAll("[aria-modal=true]")).toHaveLength(1);
    confirmation.remove();
    view.rerender(dialog(false));
    const selected = screen.getByRole("radio", { name: "한글 XML 문서 (.hwpx)" });
    expect(selected).toBeChecked(); expect(selected).toHaveFocus();
    expect(choose).not.toHaveBeenCalled();
    view.unmount(); expect(opener).toHaveFocus(); opener.remove();
  });
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

  it("does not offer a known-unavailable RHWP format and explains why", () => {
    const choose = vi.fn();
    render(<LanguageProvider language="ko" onLanguageChange={() => {}}>
      <NewDocumentDialog onChoose={choose} unavailable={{ hwp: "CreationUnverified" }} />
    </LanguageProvider>);
    const hwp = screen.getByRole("radio", { name: "한글 문서 (.hwp)" });
    expect(hwp).toBeDisabled();
    expect(hwp).toHaveAccessibleDescription(/현재 엔진 출력이 검증되지 않아 만들 수 없음/);
    const docx = screen.getByRole("radio", { name: "Word 문서 (.docx)" });
    fireEvent.keyDown(docx, { key: "ArrowDown" });
    const hwpx = screen.getByRole("radio", { name: "한글 XML 문서 (.hwpx)" });
    expect(hwpx).toBeChecked(); expect(hwpx).toHaveFocus();
    fireEvent.keyDown(hwpx, { key: "ArrowUp" });
    expect(docx).toBeChecked();
    fireEvent.click(screen.getByTestId("new-document-next"));
    expect(choose).toHaveBeenCalledWith("docx");
  });

  it("explains an unavailable creation API in English", () => {
    render(<LanguageProvider language="en" onLanguageChange={() => {}}>
      <NewDocumentDialog onChoose={vi.fn()} unavailable={{ hwp: "CreationUnavailable", hwpx: "CreationUnavailable" }} />
    </LanguageProvider>);
    expect(screen.getByRole("radio", { name: "HWPX document (.hwpx)" })).toHaveAccessibleDescription(/does not support creation/);
    fireEvent.keyDown(screen.getByRole("radio", { name: "Word document (.docx)" }), { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: "Word document (.docx)" })).toBeChecked();
  });
});
