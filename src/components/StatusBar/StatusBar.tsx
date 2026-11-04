import { useId, useRef, useState } from "react";
import type { CommandContext } from "../../commands/commands";
import type { Message } from "../../language";
import type { DocumentPanelState } from "../Editor/documentPanels";
import { useTranslation } from "../../language/LanguageContext";
import { CommandButton } from "../CommandButton/CommandButton";
import { keepEditorFocusOnPointerDown } from "../CommandButton/editorFocus";
import { isPublicationWarning } from "./publicationWarning";

interface StatusBarProps {
  context: CommandContext;
  message: Message;
  state: DocumentPanelState;
  onDismissMessage?: () => void;
}

export function StatusBar({ context, message, state, onDismissMessage }: StatusBarProps) {
  const { t, format } = useTranslation();
  const [expandedMessage, setExpandedMessage] = useState<Message | null>(null);
  const id = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const important = isPublicationWarning(message);
  const blocked = Boolean(context.modal || context.files?.busy);
  const open = important && expandedMessage === message && !blocked;
  const page = state.page === null || state.pageCount === null
    ? t("status.pageUnavailable") : t("status.pageOf", { page: state.page + 1, count: state.pageCount });
  return (
    <footer className="statusbar" aria-label={t("status.label")}>
      <span className="statusbar__item" data-testid="status-document">
        {state.info ? <>{state.info.displayName}{state.unpreserved ? <span title={t("document.modified")}> *</span> : ""}{state.pending ? ` ${t("status.pending")}` : ""}</> : t("app.noDocument")}
      </span>
      <span className="statusbar__item" data-testid="status-page">{page}</span>
      <span className="statusbar__message" id={`${id}-message`} role="status" aria-live="polite" aria-atomic="true">{format(message)}</span>
      {important && <>
        <button ref={toggle} type="button" className="statusbar__details-toggle"
          aria-expanded={open} aria-controls={`${id}-details`} aria-describedby={`${id}-message`}
          disabled={blocked} onMouseDown={keepEditorFocusOnPointerDown}
          onClick={() => setExpandedMessage(open ? null : message)}>{t("status.messageDetails")}</button>
        <section id={`${id}-details`} className="statusbar__details" hidden={!open}
          role="region" aria-label={t("status.warningDetails")} tabIndex={0}
          onMouseDown={keepEditorFocusOnPointerDown}
          onKeyDown={event => {
            if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
            event.stopPropagation();
            setExpandedMessage(null);
            toggle.current?.focus({ preventScroll: true });
          }}>
          <p>{format(message)}</p>
          <button type="button" onClick={onDismissMessage}>{t("status.dismissWarning")}</button>
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
