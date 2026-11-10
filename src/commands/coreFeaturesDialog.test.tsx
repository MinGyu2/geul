import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandInputDialog } from "../components/Editor/CommandInputDialog";
import { LanguageProvider } from "../language/LanguageContext";
import type { CommandInputRequest } from "./commands";
import { validateCommandArgs } from "./parameters";
import type { DocumentCommandArgs } from "./target";

const request: CommandInputRequest = {
  command: "insert.table", labelKey: "command.insert.table", sessionId: 1, loadGeneration: 1, revision: 0, context: {},
};

function renderDialog(language: "ko" | "en", onConfirm: (args: DocumentCommandArgs) => void = () => {}, onCancel = () => {}) {
  return render(
    <LanguageProvider language={language} onLanguageChange={() => {}}>
      <CommandInputDialog request={request} onConfirm={onConfirm} onCancel={onCancel} />
    </LanguageProvider>,
  );
}

describe.each([
  ["ko", "표", "행", "열", "표 삽입"],
  ["en", "Table", "Rows", "Columns", "Insert table"],
] as const)("table input dialog (%s)", (language, title, rowLabel, columnLabel, confirmLabel) => {
  it("starts at 2×2, shows translated labels, and inserts on Enter", () => {
    const confirmed: DocumentCommandArgs[] = [];
    renderDialog(language, args => confirmed.push(args));

    const dialog = screen.getByRole("dialog", { name: title });
    const rows = screen.getByLabelText(rowLabel) as HTMLInputElement;
    const cols = screen.getByLabelText(columnLabel) as HTMLInputElement;
    expect(rows.value).toBe("2");
    expect(cols.value).toBe("2");
    expect(screen.getByText(language === "ko" ? /최대 256칸/ : /limited to 256 cells/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: confirmLabel })).toBeInTheDocument();

    fireEvent.keyDown(rows, { key: "Enter" });
    expect(confirmed).toEqual([{ command: "insert.table", rows: 2, cols: 2 }]);
    expect(dialog).toBeInTheDocument();
  });

  it.each([
    ["33", "2", "dimensions"],
    ["2", "17", "dimensions"],
    ["32", "16", "tooManyCells"],
    ["2.5", "2", "dimensions"],
  ])("rejects rows=%s cols=%s before dispatch", (rowValue, colValue, error) => {
    const confirmed = vi.fn();
    renderDialog(language, confirmed);
    fireEvent.change(screen.getByLabelText(rowLabel), { target: { value: rowValue } });
    fireEvent.change(screen.getByLabelText(columnLabel), { target: { value: colValue } });
    fireEvent.click(screen.getByRole("button", { name: confirmLabel }));
    const expectedError = error === "dimensions"
      ? language === "ko" ? "행은 1–32, 열은 1–16 사이의 정수여야 합니다." : "Rows must be 1–32 and columns 1–16."
      : language === "ko" ? "표는 최대 256칸까지 만들 수 있습니다." : "A table can contain at most 256 cells.";
    expect(screen.getByRole("alert")).toHaveTextContent(expectedError);
    expect(confirmed).not.toHaveBeenCalled();
  });

  it("keeps keyboard focus inside the dialog and Escape cancels", () => {
    const cancel = vi.fn();
    renderDialog(language, () => {}, cancel);
    const rows = screen.getByLabelText(rowLabel);
    const cols = screen.getByLabelText(columnLabel);
    const cancelButton = screen.getByRole("button", { name: language === "ko" ? "취소" : "Cancel" });
    const confirm = screen.getByRole("button", { name: confirmLabel });
    expect(document.activeElement).toBe(rows);

    fireEvent.keyDown(rows, { key: "Tab" });
    expect(document.activeElement).toBe(cols);
    fireEvent.keyDown(cols, { key: "Tab" });
    expect(document.activeElement).toBe(cancelButton);
    fireEvent.keyDown(cancelButton, { key: "Tab" });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(document.activeElement).toBe(rows);

    fireEvent.keyDown(rows, { key: "Escape" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("table command argument boundary", () => {
  it("rejects decimals, unknown fields, dimensions outside bounds, and excessive cell counts", () => {
    expect(validateCommandArgs("insert.table", { command: "insert.table", rows: 2, cols: 2 }, {})).toBe(true);
    for (const args of [
      { command: "insert.table", rows: 2.5, cols: 2 },
      { command: "insert.table", rows: 2, cols: 2, style: "Grid" },
      { command: "insert.table", rows: 33, cols: 1 },
      { command: "insert.table", rows: 1, cols: 17 },
      { command: "insert.table", rows: 32, cols: 16 },
    ]) expect(validateCommandArgs("insert.table", args, {})).toBe(false);
  });
});
