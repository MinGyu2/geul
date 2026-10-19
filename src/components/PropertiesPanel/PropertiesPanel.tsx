import { Icon } from "../../assets/icons";
import { useTranslation } from "../../language/LanguageContext";

interface PropertiesPanelProps {
  onClose: () => void;
}

// 형식별 담당 엔진(FR-004). 두 엔진은 독립적으로 연결된다. rhwp는 T007, WordCraft는 T008 편집 PoC(원본 형식 저장은 T009, 보존 검사를 통과할 때만).
const FORMATS = [
  { format: "HWP", engine: "rhwp", status: "properties.format.editingPoc" },
  { format: "HWPX", engine: "rhwp", status: "properties.format.editingPoc" },
  { format: "DOCX", engine: "WordCraft", status: "properties.format.editingPoc" },
] as const;

export function PropertiesPanel({ onClose }: PropertiesPanelProps) {
  const { t } = useTranslation();
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
        <section className="panel__section" aria-labelledby="properties-selection">
          <h3 id="properties-selection" className="panel__section-title">{t("properties.selection")}</h3>
          <p className="panel__empty">{t("properties.selectionEmpty")}</p>
        </section>
        <section className="panel__section" aria-labelledby="properties-formats">
          <h3 id="properties-formats" className="panel__section-title">{t("properties.formats")}</h3>
          <table className="format-table">
            <thead>
              <tr>
                <th scope="col"><span className="visually-hidden">{t("status.document")}</span></th>
                <th scope="col">{t("properties.format.engine")}</th>
                <th scope="col">{t("properties.format.status")}</th>
              </tr>
            </thead>
            <tbody>
              {FORMATS.map(({ format, engine, status }) => (
                <tr key={format}>
                  <th scope="row">{format}</th>
                  <td>{engine}</td>
                  <td><span className="badge">{t(status)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="panel__note">{t("properties.formatsNote")}</p>
        </section>
      </div>
    </aside>
  );
}
