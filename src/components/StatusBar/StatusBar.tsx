import type { CommandContext } from "../../commands/commands";
import type { Message } from "../../language";
import type { DocumentPanelState } from "../Editor/documentPanels";
import { useTranslation } from "../../language/LanguageContext";
import { CommandButton } from "../CommandButton/CommandButton";

interface StatusBarProps {
  context: CommandContext;
  message: Message;
  state: DocumentPanelState;
}

export function StatusBar({ context, message, state }: StatusBarProps) {
  const { t, format } = useTranslation();
  const page = state.page === null || state.pageCount === null
    ? t("status.pageUnavailable") : t("status.pageOf", { page: state.page + 1, count: state.pageCount });
  return (
    <footer className="statusbar" aria-label={t("status.label")}>
      <span className="statusbar__item" data-testid="status-document">
        {state.info ? <>{state.info.displayName}{state.unpreserved ? <span title={t("document.modified")}> *</span> : ""}{state.pending ? ` ${t("status.pending")}` : ""}</> : t("app.noDocument")}
      </span>
      <span className="statusbar__item" data-testid="status-page">{page}</span>
      <span className="statusbar__message" role="status" aria-live="polite">{format(message)}</span>
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
