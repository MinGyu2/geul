import type { Message, MessageKey } from "../../language";

/** Publication warnings need deliberate acknowledgement, even if later commands report status. */
export function isPublicationWarning(message: Message): boolean {
  return message.key === "document.error.RestoredUnopenedAlreadyOpen"
    || message.key === "document.error.RestoredUnopened"
    || message.key === "document.error.FilePublishedUnregistered"
    || message.key === "document.error.FilePublishedUnconfirmed"
    || message.key === "document.createdUnconfirmed";
}

// Inspected callers: documentErrorMessage reports failed document operations; native
// workflow conflicts and persistence failures have no other reliable notification UI.
// Command-unavailable explanations and settings defaults/recovery notices stay transient.
const ACTIONABLE = new Set<MessageKey>([
  "document.error.InvalidPath",
  "document.error.Unreadable",
  "document.error.UnsupportedFormat",
  "document.error.ExtensionMismatch",
  "document.error.Encrypted",
  "document.error.ParseFailure",
  "document.error.ResourceLimit",
  "document.error.AlreadyOpen",
  "document.error.UnknownSession",
  "document.error.StaleSession",
  "document.error.InvalidState",
  "document.error.RevisionMismatch",
  "document.error.StaleLoad",
  "document.error.FileChanged",
  "document.error.UnsafeSave",
  "document.error.SaveUnsupported",
  "document.error.SaveFailure",
  "document.error.FileConflict",
  "document.error.SaveInProgress",
  "document.error.SaveNotReady",
  "document.error.InvalidRequest",
  "document.error.Internal",
  "document.error.EngineFailure",
  "document.error.Protocol",
  "document.error.UnpreservedChanges",
  "document.error.RenderLimit",
  "document.error.FilePublishedUnconfirmed",
  "document.error.FilePublishedUnregistered",
  "document.error.RestoredUnopened",
  "document.error.RestoredUnopenedAlreadyOpen",
  "document.error.CreationUnverified",
  "document.error.CreationUnavailable",
  "document.error.FileCreatedEditorFailed",
  "document.createdUnconfirmed", "document.saveAsConflict", "document.newConflict",
  "recovery.restoreConflict", "settings.saveFailed", "settings.conflict",
  "settings.restore.unsupported", "settings.restore.unreadable",
]);

export function isRetainedNotice(message: Message): boolean {
  return ACTIONABLE.has(message.key);
}

export interface Notice {
  id: number;
  message: Message;
  /** A previous settings-write failure remains reviewable after the current settings are confirmed in storage. */
  resolved?: boolean;
}

export interface NotificationState {
  transient: Message;
  pending: readonly Notice[];
  nextId: number;
}

type NotificationAction = { type: "notify"; message: Message }
  | { type: "acknowledge"; id: number }
  | { type: "settingsRecovered" };

export function createNotificationState(message: Message): NotificationState {
  return notificationReducer({ transient: { key: "status.ready" }, pending: [], nextId: 1 }, { type: "notify", message });
}

export function notificationReducer(state: NotificationState, action: NotificationAction): NotificationState {
  if (action.type === "settingsRecovered") {
    return { ...state, pending: state.pending.map(notice => notice.message.key === "settings.saveFailed"
      ? { ...notice, resolved: true } : notice) };
  }
  if (action.type === "acknowledge") {
    // Only the notice actually presented may be acknowledged. Repeated/stale handlers
    // cannot acknowledge its successor, even if the successor has exactly the same text.
    return state.pending[0]?.id === action.id ? { ...state, pending: state.pending.slice(1) } : state;
  }
  const message = action.message;
  if (!isRetainedNotice(message)) return { ...state, transient: message };
  const snapshot: Message = { ...message, ...(message.vars ? { vars: Object.fromEntries(
    Object.entries(message.vars).map(([key, value]) => [key, typeof value === "object" ? { ...value } : value]),
  ) } : {}) };
  return { ...state, pending: [...state.pending, { id: state.nextId, message: snapshot }], nextId: state.nextId + 1 };
}
