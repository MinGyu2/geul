import type { DocumentPanelState } from "../Editor/documentPanels";
import { Icon } from "../../assets/icons";
import { useTranslation } from "../../language/LanguageContext";

interface PropertiesPanelProps {
  state: DocumentPanelState;
  onClose: () => void;
}

const FORMAT_FLAGS = ["bold", "italic", "underline", "strikethrough"] as const;

export function PropertiesPanel({ state, onClose }: PropertiesPanelProps) {
  const { t } = useTranslation();
  const info = state.info;
  const selectionText = state.selection === "none" ? t("properties.noSelection")
    : state.selection === "unavailable" ? t("properties.selectionUnavailable")
      : state.selectedText === null ? t("properties.selectionTextUnavailable") : state.selectedText;
  return (
    <aside id="properties-panel" className="panel panel--properties" aria-labelledby="properties-title">
      <div className="panel__header">
        <h2 id="properties-title" className="panel__title">{t("properties.title")}</h2>
        <button type="button" className="command command--icon" aria-label={t("properties.close")}
          title={t("properties.close")} onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="panel__body">
        {!info ? <p className="panel__empty">{t("properties.noDocument")}</p> : (
          <>
            <section className="panel__section" aria-labelledby="properties-document">
              <h3 id="properties-document" className="panel__section-title">{t("properties.document")}</h3>
              <dl>
                <dt>{t("status.document")}</dt><dd>{info.displayName}</dd>
                <dt>{t("properties.format")}</dt><dd>{info.format.toUpperCase()}</dd>
                <dt>{t("properties.engine")}</dt><dd>{info.engine === "rhwp" ? "RHWP" : "WordCraft"}</dd>
                <dt>{t("properties.state")}</dt><dd>{t(`document.state.${info.state}`)}</dd>
                <dt>{t("properties.revision")}</dt><dd>{info.revision}</dd>
                <dt>{t("properties.modified")}</dt><dd>{state.unpreserved ? t("properties.yes") : t("properties.no")}</dd>
                <dt>{t("properties.committedDirty")}</dt><dd>{info.dirty ? t("properties.yes") : t("properties.no")}</dd>
                <dt>{t("properties.pendingOperations")}</dt><dd>{state.pending ? t("properties.yes") : t("properties.no")}</dd>
                <dt>{t("properties.composing")}</dt><dd>{state.composing ? t("properties.yes") : t("properties.no")}</dd>
              </dl>
            </section>
            <section className="panel__section" aria-labelledby="properties-selection">
              <h3 id="properties-selection" className="panel__section-title">{t("properties.selection")}</h3>
              <p>{state.selection === "selected" ? t("properties.selectionPresent")
                : state.selection === "none" ? t("properties.noSelection") : t("properties.selectionUnavailable")}</p>
              {state.caret !== null && <p>{t("properties.caret", { position: state.caret })}</p>}
              <p className="panel__note">{t("properties.selectedTextLabel")}</p>
              <pre className="panel__note">{selectionText}</pre>
            </section>
            <section className="panel__section" aria-labelledby="properties-character-format">
              <h3 id="properties-character-format" className="panel__section-title">{t("properties.characterFormat")}</h3>
              {state.format ? <dl>{FORMAT_FLAGS.map((flag) => (
                <div key={flag}><dt>{t(`properties.formatFlag.${flag}`)}</dt>
                  <dd>{state.format?.[flag] === null ? t("properties.formatMixedOrUnavailable")
                    : state.format?.[flag] ? t("properties.yes") : t("properties.no")}</dd></div>
              ))}</dl> : <p className="panel__note">{t("properties.formatUnavailable")}</p>}
            </section>
            <section className="panel__section" aria-labelledby="properties-paragraph-format">
              <h3 id="properties-paragraph-format" className="panel__section-title">{t("properties.paragraphFormat")}</h3>
              {state.paragraphStyle !== null && <p>{t("properties.paragraphStyle", { style: state.paragraphStyle })}</p>}
              <p className="panel__note">{t("properties.paragraphFormatUnavailable")}</p>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
