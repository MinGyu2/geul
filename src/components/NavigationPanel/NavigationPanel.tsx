import { useState, type FormEvent } from "react";
import type { DocumentPanelState } from "../Editor/documentPanels";
import { Icon } from "../../assets/icons";
import { useTranslation } from "../../language/LanguageContext";

interface NavigationPanelProps {
  state: DocumentPanelState;
  onNavigate: (page: number) => void;
  blocked: boolean;
  onClose: () => void;
}

export function NavigationPanel({ state, onNavigate, blocked, onClose }: NavigationPanelProps) {
  const { t } = useTranslation();
  const [pageInput, setPageInput] = useState("");
  const disabled = !state.canNavigate || blocked;
  const pageCount = state.pageCount ?? 0;
  const navigateInput = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const page = Number(pageInput);
    if (!disabled && Number.isInteger(page) && page >= 1 && page <= pageCount) onNavigate(page - 1);
  };

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
          {state.info ? (
            <>
              <p className="panel__note">{t("navigation.document", { name: state.info.displayName })}</p>
              <p className="panel__empty">{t("navigation.headingsUnsupported")}</p>
              {pageCount === 0 ? <p className="panel__empty">{t("navigation.pagesUnavailable")}</p> : (
                <>
                  <form onSubmit={navigateInput}>
                    <label htmlFor="navigation-page-input">{t("navigation.goToPage", { count: pageCount })}</label>
                    <input id="navigation-page-input" aria-label={t("navigation.pageNumber")} type="number"
                      min={1} max={pageCount} step={1} inputMode="numeric" value={pageInput}
                      disabled={disabled} onChange={(event) => setPageInput(event.currentTarget.value)} />
                    <button type="submit" disabled={disabled || !Number.isInteger(Number(pageInput))
                      || Number(pageInput) < 1 || Number(pageInput) > pageCount}>{t("navigation.go")}</button>
                  </form>
                  <ol aria-label={t("navigation.pages")}>
                    {Array.from({ length: Math.min(pageCount, 100) }, (_, page) => (
                      <li key={page}>
                        <button type="button" aria-current={state.page === page ? "page" : undefined}
                          disabled={disabled} onMouseDown={(event) => event.preventDefault()}
                          onClick={() => onNavigate(page)}>
                          {t("navigation.pageItem", { page: page + 1 })}
                        </button>
                      </li>
                    ))}
                  </ol>
                  {pageCount > 100 && <p className="panel__note">{t("navigation.pageListLimit", { count: pageCount })}</p>}
                </>
              )}
              {state.composing && <p className="panel__note">{t("navigation.composing")}</p>}
              {state.status !== "ready" && <p className="panel__note">{t("navigation.editorUnavailable")}</p>}
            </>
          ) : <p className="panel__empty">{t("navigation.noDocument")}</p>}
        </section>
      </div>
    </aside>
  );
}
