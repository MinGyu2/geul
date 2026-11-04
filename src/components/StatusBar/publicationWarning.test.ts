import { describe, expect, it } from "vitest";
import en from "../../language/en.json";
import { createTranslator, type Message, type MessageKey } from "../../language";
import { createNotificationState, isRetainedNotice, notificationReducer } from "./publicationWarning";

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
});
