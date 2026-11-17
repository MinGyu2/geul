import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CommandInputRequest } from "../../commands/commands";
import type { DocumentCommandArgs } from "../../commands/target";
import { LanguageProvider } from "../../language/LanguageContext";
import { TableFormattingDialog } from "./TableFormattingDialog";

function renderFormattingDialog(request: CommandInputRequest, language: "ko" | "en" = "ko", onConfirm: (args: DocumentCommandArgs) => void = () => {}, onCancel = () => {}) {
  return render(
    <LanguageProvider language={language} onLanguageChange={() => {}}>
      <TableFormattingDialog request={request} onConfirm={onConfirm} onCancel={onCancel} />
    </LanguageProvider>,
  );
}

describe("TableFormattingDialog", () => {
  it("supports presets, custom #RRGGBB, validation and clear shading", () => {
    const confirmed: DocumentCommandArgs[] = [];
    const req: CommandInputRequest = {
      command: "table.shading",
      labelKey: "command.table.shading",
      sessionId: 1,
      loadGeneration: 1,
      revision: 0,
      context: {
        tableShading: { color: "#FEF08A", mixed: false, hasShading: true, selectedCells: 1, supportsClear: true },
      },
    };
    renderFormattingDialog(req, "ko", (a) => confirmed.push(a));

    fireEvent.click(screen.getByTestId("shading-swatch-DBEAFE"));
    fireEvent.click(screen.getByTestId("table-format-confirm"));
    expect(confirmed[0]).toEqual({ command: "table.shading", color: "#DBEAFE" });

    fireEvent.change(screen.getByTestId("table-shading-color"), { target: { value: "invalid" } });
    fireEvent.click(screen.getByTestId("table-format-confirm"));
    expect(screen.getByTestId("table-format-error")).toBeTruthy();

    fireEvent.click(screen.getByTestId("table-shading-clear"));
    expect(confirmed[1]).toEqual({ command: "table.shading", color: null });
  });

  it("exposes only format-supported styles/widths and disables Inside on single cell", () => {
    const confirmed: DocumentCommandArgs[] = [];
    const req: CommandInputRequest = {
      command: "table.borders",
      labelKey: "command.table.borders",
      sessionId: 1,
      loadGeneration: 1,
      revision: 0,
      context: {
        tableBorders: {
          hasInsideBorders: false,
          supportedStyles: ["single", "double", "dotted", "dashed", "none"],
          widthUnit: "mm",
          supportedWidths: [0.12, 0.4, 0.7],
          defaultWidth: 0.12,
          current: null,
        },
      },
    };
    renderFormattingDialog(req, "en", (a) => confirmed.push(a));

    expect((screen.getByTestId("border-kind-inside") as HTMLButtonElement).disabled).toBe(true);
    const styleOptions = [...(screen.getByTestId("table-border-style") as HTMLSelectElement).options].map((o) => o.value);
    expect(styleOptions).toEqual(["single", "double", "dotted", "dashed", "none"]);

    fireEvent.click(screen.getByTestId("border-kind-outside"));
    fireEvent.change(screen.getByTestId("table-border-style"), { target: { value: "double" } });
    fireEvent.change(screen.getByTestId("table-border-width"), { target: { value: "0.7" } });
    fireEvent.change(screen.getByTestId("table-border-color"), { target: { value: "#DC2626" } });
    fireEvent.click(screen.getByTestId("table-format-confirm"));

    expect(confirmed[0]).toEqual({
      command: "table.borders",
      kind: "outside",
      style: "double",
      width: 0.7,
      color: "#DC2626",
    });

    fireEvent.click(screen.getByTestId("border-kind-none"));
    fireEvent.click(screen.getByTestId("table-format-confirm"));
    expect(confirmed[1]).toEqual({ command: "table.borders", kind: "none" });
  });

  it("supports independent horizontal/vertical cell alignment and mixed states", () => {
    const confirmed: DocumentCommandArgs[] = [];
    const req: CommandInputRequest = {
      command: "table.alignment",
      labelKey: "command.table.alignment",
      sessionId: 1,
      loadGeneration: 1,
      revision: 0,
      context: {
        tableAlignment: {
          horizontal: null,
          horizontalMixed: true,
          vertical: "top",
          verticalMixed: false,
          selectedCells: 2,
        },
      },
    };
    renderFormattingDialog(req, "en", (a) => confirmed.push(a));

    fireEvent.click(screen.getByTestId("align-v-bottom"));
    fireEvent.click(screen.getByTestId("table-format-confirm"));
    expect(confirmed[0]).toEqual({ command: "table.alignment", vertical: "bottom" });

    fireEvent.click(screen.getByTestId("align-h-justify"));
    fireEvent.click(screen.getByTestId("table-format-confirm"));
    expect(confirmed[1]).toEqual({ command: "table.alignment", horizontal: "justify", vertical: "bottom" });
  });
});
