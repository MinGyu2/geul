import { describe, expect, it, vi } from "vitest";
import type { Invoke } from "../../adapters/backend";
import type { SessionInfo } from "../../adapters/contract";
import { createTauriFilePort, newDocumentFrame } from "./filePort";

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
    expect(await files.createDocument("docx", "/docs/new.docx")).toEqual({ ok: false, error: { code: "Protocol" } });
  });

  it("creates DOCX through the format-aware frame and keeps the backend conflict error", async () => {
    const invoke = vi.fn<Invoke>().mockResolvedValueOnce({ ...created, dirty: true }).mockRejectedValueOnce({ code: "FileConflict" });
    const files = createTauriFilePort(invoke);
    expect(await files.createDocument("docx", "/docs/new.docx")).toEqual({ ok: true, value: { ...created, dirty: true } });
    expect(await files.createDocument("docx", "/docs/existing.docx")).toEqual({ ok: false, error: { code: "FileConflict" } });
    expect(invoke.mock.calls).toEqual([
      ["document_new", newDocumentFrame("docx", "/docs/new.docx")],
      ["document_new", newDocumentFrame("docx", "/docs/existing.docx")],
    ]);
  });

  it.each([
    ["wrong format", { ...created, format: "hwp" }],
    ["wrong engine", { ...created, engine: "rhwp" }],
    ["wrong initial state", { ...created, state: "loading" }],
    ["nonzero revision", { ...created, revision: 1 }],
    ["nonzero sequence", { ...created, sequence: 1 }],
    ["nonzero load generation", { ...created, loadGeneration: 1 }],
    ["wrong extension", { ...created, displayName: "Untitled.hwp" }],
  ])("rejects created-session response with %s", async (_case, response) => {
    const invoke = vi.fn<Invoke>().mockResolvedValue(response);
    const files = createTauriFilePort(invoke);
    expect(await files.createDocument("docx", "/docs/new.docx")).toEqual({ ok: false, error: { code: "Protocol" } });
  });
});
