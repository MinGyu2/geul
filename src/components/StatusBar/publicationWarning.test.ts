import { describe, expect, it } from "vitest";
import en from "../../language/en.json";
import { createTranslator, type Message, type MessageKey } from "../../language";
import { parseBackendError, parsePdfExported } from "../../adapters/contract";
import { documentErrorMessage } from "../Editor/Editor";
import { createNotificationState, isPublicationWarning, isRetainedNotice, notificationReducer, pdfExportMessages } from "./publicationWarning";

const publication: Message = { key: "document.error.RestoredUnopenedAlreadyOpen" };
const add = (state: ReturnType<typeof createNotificationState>, message: Message) => notificationReducer(state, { type: "notify", message });

describe("notification ownership", () => {
  it("explicitly retains document failures and native workflow/settings conflicts", () => {
    const keys = Object.keys(en).filter(key => key.startsWith("document.error.")) as MessageKey[];
    for (const key of [...keys, "document.saveAsConflict", "document.newConflict", "recovery.restoreConflict", "settings.saveFailed", "settings.conflict"] as const) {
      expect(isRetainedNotice({ key }), key).toBe(true);
    }
    for (const key of ["status.ready", "document.created", "command.unavailable.noDocument", "settings.restore.recovered", "settings.restore.malformed"] as const) {
      expect(isRetainedNotice({ key }), key).toBe(false);
    }
  });

  it("retains FIFO outcomes while remembering only the latest ordinary status", () => {
    let state = createNotificationState(publication);
    state = add(state, { key: "document.saveAsConflict" });
    state = add(state, { key: "document.error.Protocol" });
    state = add(state, { key: "document.opened", vars: { name: "latest.docx" } });
    state = add(state, { key: "status.ready" });
    expect(state.pending.map(notice => notice.message.key)).toEqual([publication.key, "document.saveAsConflict", "document.error.Protocol"]);
    expect(state.transient).toEqual({ key: "status.ready" });
  });

  it("a stale or repeated acknowledgement cannot erase a successor or newly arriving notice", () => {
    const first = createNotificationState(publication);
    const id = first.pending[0]!.id;
    const acknowledged = notificationReducer(first, { type: "acknowledge", id });
    const next = add(acknowledged, publication);
    expect(next.pending[0]!.id).not.toBe(id);
    expect(notificationReducer(next, { type: "acknowledge", id })).toBe(next);
    const withPending = add(first, publication);
    const advanced = notificationReducer(withPending, { type: "acknowledge", id });
    expect(advanced.pending).toHaveLength(1);
    expect(notificationReducer(advanced, { type: "acknowledge", id })).toBe(advanced);
  });

  it("does not acknowledge a notice that has not been presented", () => {
    const state = add(createNotificationState(publication), publication);
    expect(notificationReducer(state, { type: "acknowledge", id: state.pending[1]!.id })).toBe(state);
  });

  it("snapshots each occurrence's variables and translates pending data at review time", () => {
    const message: Message = { key: "document.error.RestoredUnopened", vars: { reason: { key: "document.error.Protocol" } } };
    const state = add(createNotificationState(message), message);
    message.vars!["reason"] = { key: "document.error.ResourceLimit" };
    expect(state.pending).toHaveLength(2);
    for (const language of ["ko", "en"] as const) {
      const t = createTranslator(language);
      for (const notice of state.pending) expect(t(notice.message.key, notice.message.vars)).toContain(t("document.error.Protocol"));
    }
  });

  it("marks resumed settings saving without removing any unreviewed error", () => {
    const state = add(createNotificationState({ key: "settings.saveFailed" }), publication);
    const recovered = notificationReducer(state, { type: "settingsRecovered" });
    expect(recovered.pending.map(notice => notice.id)).toEqual(state.pending.map(notice => notice.id));
    expect(recovered.pending[0]!.resolved).toBe(true);
    expect(recovered.pending[1]).toBe(state.pending[1]);
  });

  it("queues both PDF cleanup and durability warnings, including unverified cleanup", () => {
    const base = { sessionId: 3, loadGeneration: 2, revision: 9, pages: 1, bytes: 100, raster: true };
    const retainedAndUnconfirmed = parsePdfExported({
      ...base, durable: false, retainedReplaced: ".geul-save-1-old.tmp",
    }, 3, 2, 9)!;
    let state = createNotificationState({ key: "status.ready" });
    for (const message of pdfExportMessages(retainedAndUnconfirmed)) state = add(state, message);
    state = add(state, { key: "status.ready" });
    expect(state.pending.map(notice => notice.message.key)).toEqual([
      "document.pdfExportedRetained", "document.pdfExportedUnconfirmed",
    ]);
    expect(state.transient.key).toBe("status.ready");
    for (const language of ["ko", "en"] as const) {
      const t = createTranslator(language);
      const retained = t(state.pending[0]!.message.key, state.pending[0]!.message.vars);
      const durability = t(state.pending[1]!.message.key);
      expect(retained).toContain(language === "ko" ? "자동으로 지우지 않음" : "never deleted automatically");
      expect(durability).toContain(language === "ko" ? "확인하지 못했습니다" : "could not be confirmed");
    }

    const uncertain = parsePdfExported({
      ...base, durable: false, retainedReplaced: null, cleanupUncertain: true,
    }, 3, 2, 9)!;
    const uncertainMessages = pdfExportMessages(uncertain);
    expect(uncertainMessages.map(message => message.key)).toEqual([
      "document.pdfCleanupUncertain", "document.pdfExportedUnconfirmed",
    ]);
    for (const language of ["ko", "en"] as const) {
      const t = createTranslator(language);
      const cleanup = t(uncertainMessages[0]!.key);
      expect(cleanup).toContain(language === "ko" ? "남아 있는지는 확인되지 않았으며" : "remains is unknown");
      expect(t(uncertainMessages[1]!.key)).toContain(language === "ko" ? "확인하지 못했습니다" : "could not be confirmed");
    }
  });

  it("retains unverified PDF replacement as a partial publication error", async () => {
    const error = parseBackendError({ code: "PdfReplacementUnverified" });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("PdfReplacementUnverified");
    if (!error) return;

    // Exercise the newly affected Workspace path too: a pending close must see a publication notice,
    // and the existing grant-finally cleanup must still run for this backend outcome.
    const { DocumentSessions } = await import("../../adapters/sessions");
    const { DocumentWorkspace } = await import("../Editor/documentWorkspace");
    const { FakeDocx, decodeFake, flush } = await import("../Editor/wordcraft/testing");
    const fake = new FakeDocx(["PDF"]);
    fake.exportPdfError = error;
    const backend = {
      open: async () => ({ ok: true, value: { ...fake.info } }),
      sessions: async () => ({ ok: true, value: [] }),
      close: async (sessionId: number) => ({ ok: true, value: { sessionId, alreadyClosed: false } }),
    } as unknown as import("../../adapters/backend").DocumentBackend;
    const token = "1".repeat(32);
    const released: [number, string][] = [];
    const files = {
      chooseFile: async () => ({ ok: true as const, value: null }),
      choosePdfDestination: async () => ({ ok: true as const, value: { path: "/docs/out.pdf", overwriteGrant: token } }),
      releasePdfGrant: async (sessionId: number, grant: string) => {
        released.push([sessionId, grant]);
        return { ok: true as const, value: null };
      },
      createDocument: async () => ({ ok: false as const, error: { code: "Protocol" as const } }),
    };
    const sessions = new DocumentSessions(backend);
    const workspace = new DocumentWorkspace(sessions, backend, undefined, undefined, fake, decodeFake, files);
    await workspace.open("/docs/a.docx");
    await flush();
    expect(await workspace.exportPdf(1, { title: "PDF", accept: "Export", cancel: "Cancel" }))
      .toEqual({ ok: false, error });
    expect(workspace.publicationNoticeCount).toBe(1);
    expect(released).toEqual([[1, token]]);
    expect(workspace.fileBusy).toBe(false);
    workspace.docxEditorFor(1)?.dispose();

    const message = documentErrorMessage(error);
    expect(message.key).toBe("document.error.PdfReplacementUnverified");
    expect(isPublicationWarning(message)).toBe(true);
    expect(isRetainedNotice(message)).toBe(true);

    let state = createNotificationState(message);
    state = add(state, { key: "status.ready" });
    expect(state.pending.map(notice => notice.message.key)).toEqual([message.key]);
    for (const language of ["ko", "en"] as const) {
      const text = createTranslator(language)(state.pending[0]!.message.key);
      expect(text).toContain(language === "ko" ? "이미 보일 수 있습니다" : "may already be visible");
      expect(text).toContain(language === "ko" ? "보존되었는지는 확인되지 않았습니다" : "Preservation of the original file is unconfirmed");
      expect(text.toLowerCase()).not.toContain("cleanup");
    }
    expect(state.pending[0]!.message.key).not.toBe("document.pdfCleanupUncertain");
    state = notificationReducer(state, { type: "acknowledge", id: state.pending[0]!.id });
    expect(state.pending).toHaveLength(0);
  });
});
