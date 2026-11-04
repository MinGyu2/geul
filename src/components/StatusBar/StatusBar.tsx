import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { CommandContext } from "../../commands/commands";
import type { Message } from "../../language";
import type { DocumentPanelState } from "../Editor/documentPanels";
import { useTranslation } from "../../language/LanguageContext";
import { CommandButton } from "../CommandButton/CommandButton";
import { keepEditorFocusOnPointerDown } from "../CommandButton/editorFocus";
import { isPublicationWarning, isRetainedNotice } from "./publicationWarning";

interface StatusBarProps {
  context: CommandContext;
  message: Message;
  state: DocumentPanelState;
  onDismissMessage?: (() => void) | undefined;
  noticeId?: number | undefined;
  pendingCount?: number | undefined;
  noticeResolved?: boolean | undefined;
}

export function StatusBar({ context, message, state, onDismissMessage, noticeId, pendingCount = 1, noticeResolved = false }: StatusBarProps) {
  const { t, format } = useTranslation();
  const [expandedNotice, setExpandedNotice] = useState<number | Message | null>(null);
  const identity = noticeId ?? message;
  const id = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const footer = useRef<HTMLElement>(null);
  const acknowledgedFocus = useRef<{ element: HTMLButtonElement; identity: number | Message } | null>(null);
  const important = isRetainedNotice(message);
  const publication = isPublicationWarning(message);
  const blocked = Boolean(context.modal || context.files?.busy);
  const open = important && expandedNotice === identity && !blocked;
  useLayoutEffect(() => {
    const request = acknowledgedFocus.current;
    if (!request) return;
    if (blocked) { acknowledgedFocus.current = null; return; }
    if (request.identity === identity) return;
    acknowledgedFocus.current = null;
    const active = document.activeElement;
    // Respect a different focus owner (including a modal) and pointer/IME ownership.
    if (active !== request.element && active !== document.body && active?.isConnected) return;
    const destination = important ? toggle.current : footer.current;
    if (destination?.isConnected && !destination.hasAttribute("disabled")) destination.focus({ preventScroll: true });
  }, [identity, blocked, important]);
  const warningKey = publication ? "status.warningDetails" : "status.noticeDetails";
  const onNoticeKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Notification controls do not dispatch editor shortcuts through App's window listener.
    event.stopPropagation();
    if (event.key !== "Escape" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    setExpandedNotice(null);
    if (!blocked) toggle.current?.focus({ preventScroll: true });
  };
  const page = state.page === null || state.pageCount === null
    ? t("status.pageUnavailable") : t("status.pageOf", { page: state.page + 1, count: state.pageCount });
  return (
    <footer ref={footer} tabIndex={-1} className="statusbar" aria-label={t("status.label")}>
      <span className="statusbar__item" data-testid="status-document">
        {state.info ? <>{state.info.displayName}{state.unpreserved ? <span title={t("document.modified")}> *</span> : ""}{state.pending ? ` ${t("status.pending")}` : ""}</> : t("app.noDocument")}
      </span>
      <span className="statusbar__item" data-testid="status-page">{page}</span>
      <span className="statusbar__message" id={`${id}-message`} role="status" aria-live="polite" aria-atomic="true">{format(message)}{noticeResolved ? ` ${t("status.settingsRecovered")}` : ""}</span>
      {important && <>
        {pendingCount > 1 && <span className="statusbar__pending" role="status" aria-live="polite"
          aria-label={t("status.pendingNotices", { count: pendingCount })}>{t("status.pendingNotices", { count: pendingCount })}</span>}
        <button ref={toggle} type="button" className="statusbar__details-toggle"
          aria-expanded={open} aria-controls={`${id}-details`} aria-describedby={`${id}-message`}
          disabled={blocked} onMouseDown={keepEditorFocusOnPointerDown}
          onKeyDown={onNoticeKeyDown}
          onClick={() => setExpandedNotice(open ? null : identity)}>{t("status.messageDetails")}</button>
        <section id={`${id}-details`} className="statusbar__details" hidden={!open}
          role="region" aria-label={t(warningKey)} tabIndex={0}
          onMouseDown={keepEditorFocusOnPointerDown}
          onKeyDown={onNoticeKeyDown}>
          <p>{format(message)}</p>
          {noticeResolved && <p>{t("status.settingsRecovered")}</p>}
          <button type="button" disabled={blocked} onClick={event => {
            if (blocked) return;
            if (document.activeElement === event.currentTarget) {
              acknowledgedFocus.current = { element: event.currentTarget, identity };
            }
            onDismissMessage?.();
          }}>{t(publication ? "status.dismissWarning" : "status.acknowledgeNotice")}</button>
        </section>
      </>}
      <span className="statusbar__item statusbar__engines">{state.info
        ? t("status.activeEngine", { engine: state.info.engine === "rhwp" ? "RHWP" : "WordCraft" })
        : t("status.engines")}</span>
      <div className="statusbar__zoom" role="group" aria-label={t("ribbon.group.zoom")}>
        <CommandButton id="view.zoomOut" labelKey="command.view.zoomOut" icon="zoomOut" context={context} variant="icon" />
        <output className="statusbar__zoom-value" aria-label={t("status.zoomLevel")}>{context.layout.zoom}%</output>
        <CommandButton id="view.zoomIn" labelKey="command.view.zoomIn" icon="zoomIn" context={context} variant="icon" />
      </div>
    </footer>
  );
}
