import { describe, expect, it, vi } from "vitest";
import type { Invoke } from "../../adapters/backend";
import type { SessionInfo } from "../../adapters/contract";
import { createTauriFilePort } from "./filePort";

const created: SessionInfo = {
  sessionId: 4, format: "docx", engine: "wordcraft", revision: 0, state: "identified",
  displayName: "Untitled.docx", dirty: false, sequence: 0, loadGeneration: 0,
};

describe("Tauri file port", () => {
  it("strictly parses native selection and preserves cancellation as null", async () => {
    const invoke = vi.fn<Invoke>().mockResolvedValueOnce("/docs/a.hwpx").mockResolvedValueOnce(null);
    const files = createTauriFilePort(invoke);
    const request = { mode: "open" as const, title: "Open", accept: "Open", cancel: "Cancel" };
    expect(await files.chooseFile(request)).toEqual({ ok: true, value: "/docs/a.hwpx" });
    expect(await files.chooseFile(request)).toEqual({ ok: true, value: null });
    expect(invoke.mock.calls).toEqual([
      ["document_file_dialog", { mode: "open", title: "Open", accept: "Open", cancel: "Cancel" }],
      ["document_file_dialog", { mode: "open", title: "Open", accept: "Open", cancel: "Cancel" }],
    ]);
  });

  it("rejects malformed selection and created-session responses", async () => {
    const invoke = vi.fn<Invoke>().mockResolvedValueOnce({ path: "/docs/a.docx" }).mockResolvedValueOnce({ ...created, format: "hwpx", engine: "rhwp" });
    const files = createTauriFilePort(invoke);
    expect(await files.chooseFile({ mode: "open", title: "Open", accept: "Open", cancel: "Cancel" }))
      .toEqual({ ok: false, error: { code: "Protocol" } });
    expect(await files.createDocx("/docs/new.docx")).toEqual({ ok: false, error: { code: "Protocol" } });
  });

  it("requires a new DOCX destination and keeps the backend conflict error", async () => {
    const invoke = vi.fn<Invoke>().mockResolvedValueOnce(created).mockRejectedValueOnce({ code: "FileConflict" });
    const files = createTauriFilePort(invoke);
    expect(await files.createDocx("/docs/new.docx")).toEqual({ ok: true, value: created });
    expect(await files.createDocx("/docs/existing.docx")).toEqual({ ok: false, error: { code: "FileConflict" } });
    expect(invoke.mock.calls).toEqual([
      ["document_new", { path: "/docs/new.docx" }],
      ["document_new", { path: "/docs/existing.docx" }],
    ]);
  });
});
