import type { Ref } from "react";
import { Icon } from "../../assets/icons";
import type { CommandContext } from "../../commands/commands";
import { isLanguage, LANGUAGES } from "../../language";
import { useTranslation } from "../../language/LanguageContext";
import { CommandButton } from "../CommandButton/CommandButton";

interface TitleBarProps {
  context: CommandContext;
  navigationToggleRef: Ref<HTMLButtonElement>;
  propertiesToggleRef: Ref<HTMLButtonElement>;
}

const THEME_ICON = { system: "monitor", light: "sun", dark: "moon" } as const;

export function TitleBar({ context, navigationToggleRef, propertiesToggleRef }: TitleBarProps) {
  const { layout, dispatch } = context;
  const { t, language, setLanguage } = useTranslation();
  return (
    <header className="titlebar" aria-label={t("titleBar.label")}>
      <div className="titlebar__brand">
        <span className="titlebar__mark"><Icon name="appMark" size={18} /></span>
        <span className="titlebar__name">{t("app.name")}</span>
        <span className="titlebar__document">{t("app.noDocument")}</span>
      </div>
      <div className="titlebar__quick" role="group" aria-label={t("titleBar.quickActions")}>
        <CommandButton id="file.save" labelKey="command.file.save" icon="save" context={context} variant="icon" />
        <CommandButton id="edit.undo" labelKey="command.edit.undo" icon="undo" context={context} variant="icon" />
        <CommandButton id="edit.redo" labelKey="command.edit.redo" icon="redo" context={context} variant="icon" />
      </div>
      <div className="titlebar__view" role="group" aria-label={t("ribbon.tab.view")}>
        <select
          className="titlebar__language"
          aria-label={t("titleBar.language")}
          title={t("titleBar.language")}
          value={language}
          onChange={(event) => {
            if (isLanguage(event.target.value)) setLanguage(event.target.value);
          }}
        >
          {LANGUAGES.map(({ code, nativeName }) => (
            <option key={code} value={code} lang={code}>{nativeName}</option>
          ))}
        </select>
        <button
          ref={navigationToggleRef}
          type="button"
          className="command command--icon"
          aria-pressed={layout.navigationVisible}
          aria-controls="navigation-panel"
          aria-label={t("titleBar.toggleNavigation")}
          title={t("titleBar.toggleNavigation")}
          onClick={() => dispatch({ type: "togglePanel", panel: "navigation" })}
        >
          <Icon name="sidebarLeft" />
        </button>
        <button
          ref={propertiesToggleRef}
          type="button"
          className="command command--icon"
          aria-pressed={layout.propertiesVisible}
          aria-controls="properties-panel"
          aria-label={t("titleBar.toggleProperties")}
          title={t("titleBar.toggleProperties")}
          onClick={() => dispatch({ type: "togglePanel", panel: "properties" })}
        >
          <Icon name="sidebarRight" />
        </button>
        <button
          type="button"
          className="command command--icon"
          aria-label={t("titleBar.theme", { theme: t(`theme.${layout.theme}`) })}
          title={t("titleBar.theme", { theme: t(`theme.${layout.theme}`) })}
          onClick={() => dispatch({ type: "cycleTheme" })}
        >
          <Icon name={THEME_ICON[layout.theme]} />
        </button>
      </div>
    </header>
  );
}
