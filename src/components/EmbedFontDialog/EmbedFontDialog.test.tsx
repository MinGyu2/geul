// @vitest-environment jsdom
// Stage 1 F: the font embedding dialog shows the backend verdict (permission, license, per-format refusal), keeps
// "Embed" disabled for refused faces, and reports success only from the session's resolved result.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FontBackend, FontCatalog, FontEmbedInfo } from "../../adapters/fonts";
import { parseDocxView } from "../../adapters/docx";
import type { DocumentCommandTarget, EmbedFontResult } from "../../commands/target";
import { configureEmbedding } from "../../fonts/embedding";
import { LanguageProvider } from "../../language/LanguageContext";
import { EmbedFontDialog } from "./EmbedFontDialog";

const catalog = {
  status: {} as FontCatalog["status"], generics: [], userFonts: [],
  families: [
    { id: "bundled:inter", family: "Inter", localized: [], styles: [{ name: "Regular", weight: 400, italic: false }, { name: "Medium", weight: 500, italic: false }], source: "bundled", available: true, renderable: true },
    { id: "user:locked", family: "Locked Sans", localized: [], styles: [{ name: "Regular", weight: 400, italic: false }], source: "user", available: true, renderable: true },
  ],
} as FontCatalog;
const info = (family: string, style: string): FontEmbedInfo => family === "Locked Sans"
  ? { family, style, program: { permission: "restricted", fsType: 2, noSubsetting: false, families: [family], license: "All rights reserved", licenseUrl: null },
      refusal: "permission", docx: "permission", hwpx: "permission", hwp: "formatUnsupported" }
  : { family, style, program: { permission: "installable", fsType: 0, noSubsetting: false, families: [family], license: "SIL Open Font License 1.1", licenseUrl: null },
      refusal: null, docx: style === "Regular" ? null : "style", hwpx: null, hwp: "formatUnsupported" };

function target(result: EmbedFontResult) {
  const executeEmbedFont = vi.fn(async () => result);
  return { t: { sessionId: 1, engine: "wordcraft", snapshot: () => ({ embeddedFonts: [] }), execute: () => ({ accepted: false }), executeEmbedFont } as unknown as DocumentCommandTarget, executeEmbedFont };
}

const show = (t: DocumentCommandTarget, format: "docx" | "hwp" | "hwpx", notify = vi.fn(), onClose = vi.fn()) => {
  render(<LanguageProvider language="en" onLanguageChange={() => {}}>
    <EmbedFontDialog target={t} format={format} catalog={catalog} initialFamily="Inter" suspended={false} notify={notify} onClose={onClose} /></LanguageProvider>);
  return { notify, onClose };
};

afterEach(() => configureEmbedding(null));

describe("EmbedFontDialog", () => {
  configureEmbedding({ embedInfo: async (f: string, s: string) => ({ ok: true, value: info(f, s) }) } as unknown as FontBackend);
  it("embeds a permitted face only after the session reports the model change", async () => {
    configureEmbedding({ embedInfo: async (f: string, s: string) => ({ ok: true, value: info(f, s) }) } as unknown as FontBackend);
    const { t, executeEmbedFont } = target("embedded");
    const { notify, onClose } = show(t, "docx");
    await screen.findByText(/Installable/);
    expect(screen.getByText(/Open Font License/)).toBeTruthy();
    const confirm = screen.getByTestId("embed-font-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    await act(async () => { fireEvent.click(confirm); });
    expect(executeEmbedFont).toHaveBeenCalledWith("Inter", "Regular");
    expect(notify).toHaveBeenCalledWith({ key: "embedFont.embedded", vars: { family: "Inter" } });
    expect(onClose).toHaveBeenCalled();
  });
  it("refuses restricted licenses, DOCX styles without a slot and HWP documents", async () => {
    configureEmbedding({ embedInfo: async (f: string, s: string) => ({ ok: true, value: info(f, s) }) } as unknown as FontBackend);
    const { t, executeEmbedFont } = target("failed");
    show(t, "docx");
    await screen.findByText(/Installable/);
    fireEvent.change(screen.getByTestId("embed-font-family"), { target: { value: "Locked Sans" } });
    await screen.findByText(/Restricted license/);
    expect(screen.getByTestId("embed-font-refusal").textContent).toMatch(/does not allow editable embedding/);
    expect((screen.getByTestId("embed-font-confirm") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("embed-font-family"), { target: { value: "Inter" } });
    await screen.findByText(/Installable/);
    fireEvent.change(screen.getByTestId("embed-font-style"), { target: { value: "Medium" } });
    await waitFor(() => expect(screen.getByTestId("embed-font-refusal").textContent).toMatch(/regular, bold, italic/));
    expect(executeEmbedFont).not.toHaveBeenCalled();
  });
  it("shows the HWP format limitation", async () => {
    configureEmbedding({ embedInfo: async (f: string, s: string) => ({ ok: true, value: info(f, s) }) } as unknown as FontBackend);
    show(target("failed").t, "hwp");
    await waitFor(() => expect(screen.getByTestId("embed-font-refusal").textContent).toMatch(/HWP 5.0 format has no font-embedding/));
    expect((screen.getByTestId("embed-font-confirm") as HTMLButtonElement).disabled).toBe(true);
  });
  it("DOCX view parsing accepts the embedded font list and rejects malformed entries", () => {
    expect(parseDocxView({ embeddedFonts: [{ family: "Inter", slot: "embedRegular", fontKey: null, part: null, extra: 1 }] })).toBeNull();
  });
});
