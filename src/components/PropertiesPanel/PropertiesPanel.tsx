import type { GraphicProperties } from "../../commands/graphicProperties";
import { useState } from "react";
import type { ObjectSelection, PictureProperties, PictureResizeRequest } from "../../commands/objectSelection";
import type { DocumentPanelState } from "../Editor/documentPanels";
import { Icon } from "../../assets/icons";
import { useTranslation } from "../../language/LanguageContext";

interface PropertiesPanelProps {
  state: DocumentPanelState;
  onClose: () => void;
  onPictureResize?: (request: PictureResizeRequest) => void;
}

const FORMAT_FLAGS = ["bold", "italic", "underline", "strikethrough"] as const;

export function PropertiesPanel({ state, onClose, onPictureResize }: PropertiesPanelProps) {
  const { t } = useTranslation();
  const info = state.info;
  const object = state.objectSelection;
  const picture = object?.picture;
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
              {object ? (
                <>
                  <p>{t(`editor.object.kind.${object.kind}`)}</p>
                  {picture && <dl>
                    <dt>{t("properties.picture.width")}</dt><dd>{t("properties.picture.points", { value: picture.widthPt.toFixed(2) })}</dd>
                    <dt>{t("properties.picture.height")}</dt><dd>{t("properties.picture.points", { value: picture.heightPt.toFixed(2) })}</dd>
                    <dt>{t("properties.picture.wrap")}</dt><dd>{t(`properties.picture.wrap.${picture.wrap}`)}</dd>
                    {picture.description && <><dt>{t("properties.picture.description")}</dt><dd>{picture.description}</dd></>}
                  </dl>}
                  {object.graphic && <GraphicDetails graphic={object.graphic} />}
                  {picture && onPictureResize && object.operations.includes("resize") && (
                    <PictureSizeFields key={`${object.sessionId}:${object.loadGeneration}:${object.revision}:${object.epoch}`}
                      selection={object} picture={picture} onApply={onPictureResize}
                      disabled={state.pending || state.composing} />
                  )}
                </>
              ) : <>
              <p>{state.selection === "selected" ? t("properties.selectionPresent")
                : state.selection === "none" ? t("properties.noSelection") : t("properties.selectionUnavailable")}</p>
              {state.caret !== null && <p>{t("properties.caret", { position: state.caret })}</p>}
              <p className="panel__note">{t("properties.selectedTextLabel")}</p>
              <pre className="panel__note">{selectionText}</pre>
              </>}
            </section>
            {!object && <>
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
            </>}
          </>
        )}
      </div>
    </aside>
  );
}

function PictureSizeFields({ selection, picture, onApply, disabled }: {
  selection: ObjectSelection;
  picture: PictureProperties;
  onApply: (request: PictureResizeRequest) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(String(picture.widthPt));
  const [height, setHeight] = useState(String(picture.heightPt));
  const [locked, setLocked] = useState(true);
  const widthPt = Number(width), heightPt = Number(height);
  const valid = [widthPt, heightPt].every(value => Number.isFinite(value) && value >= 2 && value <= 4000);
  return (
    <form onSubmit={event => {
      event.preventDefault();
      if (disabled || !valid) return;
      onApply({
        selectionEpoch: selection.epoch, sessionId: selection.sessionId, loadGeneration: selection.loadGeneration,
        revision: selection.revision, widthPt, heightPt,
      });
    }}>
      <label className="picture-size-field">{t("properties.picture.widthInput")}
        <input type="number" min={2} max={4000} step={0.01} value={width} disabled={disabled}
          onChange={event => {
            const value = event.target.value;
            setWidth(value);
            if (locked) setHeight(value ? (Number(value) * picture.heightPt / picture.widthPt).toFixed(2) : "");
          }} />
      </label>
      <label className="picture-size-field">{t("properties.picture.heightInput")}
        <input type="number" min={2} max={4000} step={0.01} value={height} disabled={disabled || locked}
          onChange={event => setHeight(event.target.value)} />
      </label>
      <label className="picture-size-field"><input type="checkbox" checked={locked} disabled={disabled}
        onChange={event => {
          setLocked(event.target.checked);
          if (event.target.checked && width) setHeight((widthPt * picture.heightPt / picture.widthPt).toFixed(2));
        }} />{t("properties.picture.lockAspect")}</label>
      <button type="submit" className="document-bar__button" disabled={disabled || !valid
        || (widthPt === picture.widthPt && heightPt === picture.heightPt)}>{t("command.picture.size")}</button>
    </form>
  );
}

function GraphicDetails({ graphic }: { graphic: GraphicProperties }) {
  const { t } = useTranslation();
  if (graphic.kind === "smartArt") return (
    <>
      <dl><dt>{t("properties.graphic.layout")}</dt><dd>{graphic.layout}</dd></dl>
      <ul>{graphic.items.map((item, index) => (
        <li key={index} style={{ marginInlineStart: item.level * 10 }}>{item.text}</li>
      ))}</ul>
    </>
  );
  return (
    <>
      <dl>
        <dt>{t("properties.graphic.plot")}</dt><dd>{graphic.plot}</dd>
        {graphic.title && <><dt>{t("properties.graphic.title")}</dt><dd>{graphic.title}</dd></>}
      </dl>
      <details>
        <summary>{t("properties.graphic.data")}</summary>
        {graphic.labels.length > 0 && <p>{graphic.labels.join(" · ")}</p>}
        <dl>{graphic.series.map((series, index) => (
          <div key={index}>
            <dt>{series.name || t("properties.graphic.series", { number: index + 1 })}</dt>
            <dd>{series.values.map(value => value ?? "—").join(" · ")}</dd>
          </div>
        ))}</dl>
      </details>
    </>
  );
}
