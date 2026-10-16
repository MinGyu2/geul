import { Icon } from "../../assets/icons";
import { t } from "../../language";

interface NavigationPanelProps {
  onClose: () => void;
}

export function NavigationPanel({ onClose }: NavigationPanelProps) {
  return (
    <aside id="navigation-panel" className="panel panel--navigation" aria-labelledby="navigation-title">
      <div className="panel__header">
        <h2 id="navigation-title" className="panel__title">{t("navigation.title")}</h2>
        <button type="button" className="command command--icon" aria-label={t("navigation.close")}
                title={t("navigation.close")} onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="panel__body">
        <section className="panel__section" aria-labelledby="navigation-outline">
          <h3 id="navigation-outline" className="panel__section-title">{t("navigation.outline")}</h3>
          <p className="panel__empty">{t("navigation.empty")}</p>
        </section>
      </div>
    </aside>
  );
}
