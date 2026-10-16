import type { CommandContext } from "../../commands/commands";
import { t } from "../../language";
import { CommandButton } from "../CommandButton/CommandButton";

interface StatusBarProps {
  context: CommandContext;
  message: string;
}

export function StatusBar({ context, message }: StatusBarProps) {
  return (
    <footer className="statusbar" aria-label={t("status.label")}>
      <span className="statusbar__item">{t("app.noDocument")}</span>
      <span className="statusbar__item">{t("status.page")}</span>
      <span className="statusbar__message" role="status" aria-live="polite">{message}</span>
      <span className="statusbar__item statusbar__engines">{t("status.engines")}</span>
      <div className="statusbar__zoom" role="group" aria-label={t("ribbon.group.zoom")}>
        <CommandButton id="view.zoomOut" labelKey="command.view.zoomOut" icon="zoomOut" context={context} variant="icon" />
        <output className="statusbar__zoom-value" aria-label={t("status.zoomLevel")}>{context.layout.zoom}%</output>
        <CommandButton id="view.zoomIn" labelKey="command.view.zoomIn" icon="zoomIn" context={context} variant="icon" />
      </div>
    </footer>
  );
}
