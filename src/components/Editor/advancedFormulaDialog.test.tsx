import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CommandInputRequest } from "../../commands/commands";
import type { DocumentCommandArgs } from "../../commands/target";
import { LanguageProvider } from "../../language/LanguageContext";
import { CommandInputDialog } from "./CommandInputDialog";

const formula = "=SUM(A1:B1)+1";
const request = (existingFormula?: string): CommandInputRequest => ({
  command: "hangul.insertTableFormula",
  labelKey: "command.hangul.insertTableFormula",
  sessionId: 1,
  loadGeneration: 1,
  revision: 0,
  context: {
    tableCell: { row: 1, col: 1, rows: 2, cols: 2 },
    ...(existingFormula === undefined ? {} : { formula: existingFormula }),
  },
});

describe.each([
  ["ko", "다시 계산", "표 계산식 편집"],
  ["en", "recalculate", "Edit Table Formula"],
] as const)("persistent formula input dialog (%s)", (language, recalculationHint, title) => {
  const renderDialog = (existingFormula?: string, onConfirm: (args: DocumentCommandArgs) => void = () => {}) => render(
    <LanguageProvider language={language} onLanguageChange={() => {}}>
      <CommandInputDialog request={request(existingFormula)} onCancel={() => {}} onConfirm={onConfirm} />
    </LanguageProvider>,
  );

  it("prefills the stored expression and confirms the same typed command on Enter", () => {
    const confirmed: DocumentCommandArgs[] = [];
    renderDialog(formula, args => confirmed.push(args));

    const dialog = screen.getByTestId("command-input-dialog");
    const input = screen.getByTestId("command-input-value") as HTMLInputElement;
    expect(dialog).toHaveAttribute("aria-labelledby", "command-input-title");
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/test.only|test hooks/i);
    expect(input.value).toBe(formula);
    expect(screen.getByText(new RegExp(recalculationHint, "i"))).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(confirmed).toEqual([{ command: "hangul.insertTableFormula", formula }]);
  });

  it("starts empty for a new field and keeps malformed edits in the dialog", () => {
    const confirmed: DocumentCommandArgs[] = [];
    renderDialog(undefined, args => confirmed.push(args));
    const input = screen.getByTestId("command-input-value") as HTMLInputElement;
    expect(input.value).toBe("");

    fireEvent.change(input, { target: { value: "=1+" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByTestId("command-input-dialog")).toBeInTheDocument();
    expect(confirmed).toEqual([]);
  });

  it("keeps a formula reading its own cell in the dialog with a specific error", () => {
    const confirmed: DocumentCommandArgs[] = [];
    renderDialog(undefined, args => confirmed.push(args));
    const input = screen.getByTestId("command-input-value") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "=SUM(A1:B2)" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent(language === "ko" ? "이 셀을 빼고" : "Leave this cell out");
    expect(confirmed).toEqual([]);
  });
});
