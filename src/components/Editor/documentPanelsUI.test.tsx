import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../../adapters/contract";
import type { CommandContext } from "../../commands/commands";
import { initialLayout } from "../../hooks/layoutState";
import { LanguageProvider } from "../../language/LanguageContext";
import { NavigationPanel } from "../NavigationPanel/NavigationPanel";
import { PropertiesPanel } from "../PropertiesPanel/PropertiesPanel";
import { StatusBar } from "../StatusBar/StatusBar";
import type { DocumentPanelState } from "./documentPanels";

const info = (sessionId: number, overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId, format: "docx", engine: "wordcraft", revision: 3, state: "ready",
  displayName: `draft-${sessionId}.docx`, dirty: false, sequence: 1, loadGeneration: 1,
  ...overrides,
});
const state = (overrides: Partial<DocumentPanelState> = {}): DocumentPanelState => ({
  info: null, status: "idle", pageCount: null, page: null, caret: null,
  selection: "unavailable", selectedText: null, paragraphStyle: null, format: null,
  canNavigate: false, pending: false, composing: false, unpreserved: false, ...overrides,
});
const context: CommandContext = {
  layout: { ...initialLayout, zoom: 125 }, dispatch: vi.fn(), notify: vi.fn(), document: null,
};
function AppPanels({ panelState, onNavigate = vi.fn() }: {
  panelState: DocumentPanelState;
  onNavigate?: (page: number) => void;
}) {
  return <LanguageProvider language="en" onLanguageChange={vi.fn()}>
    <NavigationPanel state={panelState} onNavigate={onNavigate} blocked={false} onClose={vi.fn()} />
    <PropertiesPanel state={panelState} onClose={vi.fn()} />
    <StatusBar context={context} message={{ key: "status.ready" }} state={panelState} />
  </LanguageProvider>;
}

describe("active document panels", () => {
  it("shows explicit no-document and unavailable pagination state while retaining zoom", () => {
    render(<AppPanels panelState={state()} />);
    expect(screen.getAllByText("No active document.").length).toBeGreaterThan(0);
    expect(screen.getByTestId("status-document")).toHaveTextContent("No document open");
    expect(screen.getByTestId("status-page")).toHaveTextContent("Page —");
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("125%");
    expect(screen.queryByRole("button", { name: "Page 1" })).toBeNull();
  });

  it("updates document identity, dirty flag and actual page when switching sessions", () => {
    const { rerender } = render(<AppPanels panelState={state({ info: info(1), status: "ready", pageCount: 4, page: 2 })} />);
    expect(screen.getByTestId("status-document")).toHaveTextContent("draft-1.docx");
    expect(screen.getByTestId("status-page")).toHaveTextContent("Page 3 of 4");
    expect(screen.getAllByText("draft-1.docx").length).toBeGreaterThan(1);
    rerender(<AppPanels panelState={state({ info: info(2, { format: "hwpx", engine: "rhwp", dirty: true }),
      status: "ready", pageCount: 8, page: 0, unpreserved: true })} />);
    expect(screen.getByTestId("status-document")).toHaveTextContent("draft-2.docx *");
    expect(screen.getByTestId("status-page")).toHaveTextContent("Page 1 of 8");
    expect(screen.getByText("HWPX")).toBeInTheDocument();
    expect(screen.getByText("RHWP")).toBeInTheDocument();
  });

  it("navigates only to in-range pages, keeps pointer focus, and disables navigation during composition", () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<AppPanels onNavigate={onNavigate} panelState={state({ info: info(1), status: "ready",
      pageCount: 140, page: 4, canNavigate: true })} />);
    expect(screen.getAllByRole("button", { name: /^Page \d+$/ })).toHaveLength(100);
    const pageFive = screen.getByRole("button", { name: "Page 5" });
    expect(pageFive).toHaveAttribute("aria-current", "page");
    expect(fireEvent.mouseDown(pageFive)).toBe(false);
    fireEvent.click(pageFive);
    expect(onNavigate).toHaveBeenCalledWith(4);
    fireEvent.change(screen.getByLabelText("Page number"), { target: { value: "141" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    rerender(<AppPanels onNavigate={onNavigate} panelState={state({ info: info(1), status: "ready", pageCount: 2,
      page: 0, canNavigate: false, composing: true })} />);
    expect(screen.getByRole("button", { name: "Page 1" })).toBeDisabled();
    expect(screen.getByLabelText("Page number")).toBeDisabled();
  });

  it("keeps actual false distinct from true and labels mixed or unavailable values honestly", () => {
    render(<AppPanels panelState={state({ info: info(1), status: "ready", selection: "selected", selectedText: "sample",
      caret: "main:0:2", format: { bold: null, italic: false, underline: true, strikethrough: null } })} />);
    expect(screen.getByText("sample")).toBeInTheDocument();
    expect(screen.getByText("Caret position: main:0:2")).toBeInTheDocument();
    expect(screen.getAllByText("Off, mixed or unavailable (the engine does not distinguish these states)")).toHaveLength(2);
    expect(screen.getByText("Italic").parentElement).toHaveTextContent("No");
    expect(screen.getByText("Underline").parentElement).toHaveTextContent("Yes");
    expect(screen.getByText("Other paragraph properties are not exposed by the current adapter APIs.")).toBeInTheDocument();
  });
});
