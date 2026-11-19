import type { GraphicProperties } from "../../commands/graphicProperties";
import { useState } from "react";
import { CHART_PLOTS, MAX_ALT_TEXT_CHARS, MAX_CROP_FRACTION, MAX_GRAPHIC_TEXT_CHARS, SMART_ART_LAYOUTS, validObjectEdit, PICTURE_WRAPS, POSITION_PRESETS, objectEditRequest, validAltText, type ObjectEdit, type ObjectEditRequest, type ObjectSelection, type PictureProperties, type PictureWrap, type PositionPreset, type ShapeProperties } from "../../commands/objectSelection";
import type { DocumentPanelState } from "../Editor/documentPanels";
import { Icon } from "../../assets/icons";
import { useTranslation } from "../../language/LanguageContext";

interface PropertiesPanelProps {
  state: DocumentPanelState;
  onClose: () => void;
  onObjectEdit?: (request: { command: "object.edit" } & ObjectEditRequest) => void;
}

const FORMAT_FLAGS = ["bold", "italic", "underline", "strikethrough"] as const;

export function PropertiesPanel({ state, onClose, onObjectEdit }: PropertiesPanelProps) {
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
                  {onObjectEdit && (
                    <ObjectTools key={`${object.sessionId}:${object.loadGeneration}:${object.revision}:${object.epoch}`}
                      selection={object} picture={picture} disabled={state.pending || state.composing}
                      onEdit={edit => onObjectEdit(objectEditRequest(object, edit))} />
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

/** Engine-owned object values with the edits the selected object admits; values refresh from the engine after each edit. */
function ObjectTools({ selection, picture, disabled, onEdit }: {
  selection: ObjectSelection;
  picture: PictureProperties | undefined;
  disabled: boolean;
  onEdit: (edit: ObjectEdit) => void;
}) {
  const { t } = useTranslation();
  const can = (op: ObjectSelection["operations"][number]) => selection.operations.includes(op);
  return (
    <div className="object-tools">
      {picture && can("resize") && <PictureSizeFields picture={picture} disabled={disabled}
        onApply={(width, height) => onEdit({ kind: "bounds", width, height })} />}
      {picture?.crop && can("crop") && <PictureCropFields crop={picture.crop} disabled={disabled} onApply={onEdit} />}
      {picture && can("wrap") && (
        <label className="picture-size-field">{t("properties.picture.wrapInput")}
          <select value={picture.wrap} disabled={disabled}
            onChange={event => onEdit({ kind: "wrap", wrap: event.target.value as PictureWrap })}>
            {PICTURE_WRAPS.map(wrap => <option key={wrap} value={wrap}>{t(`properties.picture.wrap.${wrap}`)}</option>)}
          </select>
        </label>
      )}
      {can("altText") && <AltTextField value={picture?.description ?? ""} disabled={disabled} onApply={text => onEdit({ kind: "altText", text })} />}
      {(can("position") || (can("move") && selection.address.engine === "wordcraft")) && (
        <label className="picture-size-field">{t("properties.object.position")}
          <select value="" disabled={disabled}
            onChange={event => { if (event.target.value) onEdit({ kind: "position", preset: event.target.value as PositionPreset }); }}>
            <option value="">{t("properties.object.position.none")}</option>
            {POSITION_PRESETS.map(preset => <option key={preset} value={preset}>{t(`properties.object.position.${preset}`)}</option>)}
          </select>
        </label>
      )}
      {selection.graphic?.kind === "chart" && can("chart") && <ChartFields chart={selection.graphic} disabled={disabled} onEdit={onEdit} />}
      {selection.graphic?.kind === "smartArt" && can("smartArt") && <SmartArtFields art={selection.graphic} disabled={disabled} onEdit={onEdit} />}
      {selection.shape && <ShapeFields shape={selection.shape} disabled={disabled} can={can}
        outlineWidth={selection.address.engine === "wordcraft" ? 0 : selection.shape.outlineWidthEditable ? 0.01 : null} onEdit={onEdit} />}
      {can("delete") && <button type="button" className="document-bar__button" disabled={disabled}
        onClick={() => onEdit({ kind: "delete" })}>{t("properties.object.delete")}</button>}
    </div>
  );
}

type ChartGraphic = Extract<GraphicProperties, { kind: "chart" }>;
type SmartArtGraphic = Extract<GraphicProperties, { kind: "smartArt" }>;

function ChartFields({ chart, disabled, onEdit }: { chart: ChartGraphic; disabled: boolean; onEdit: (edit: ObjectEdit) => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(chart.title ?? "");
  const [labels, setLabels] = useState(chart.labels);
  const [names, setNames] = useState(chart.series.map(s => s.name ?? ""));
  const [values, setValues] = useState(chart.series.map(s => s.values.map(v => v ?? "")));
  const plot = CHART_PLOTS.find(p => p === chart.plot);
  const numbers = values.map(row => row.map(v => v.trim() === "" ? null : Number(v)));
  const data: ObjectEdit = { kind: "chartData", categories: labels, series: names.map((name, i) => ({ name, values: numbers[i]! })) };
  const dataValid = validObjectEdit(data);
  const titleEdit: ObjectEdit = { kind: "chartTitle", text: title };
  return (
    <div className="chart-tools">
      <form onSubmit={event => { event.preventDefault(); if (!disabled && validObjectEdit(titleEdit) && title !== chart.title) onEdit(titleEdit); }}>
        <label className="picture-size-field">{t("properties.chart.title")}
          <input type="text" value={title} maxLength={MAX_GRAPHIC_TEXT_CHARS} disabled={disabled} onChange={event => setTitle(event.target.value)} />
        </label>
        <button type="submit" className="document-bar__button" disabled={disabled || !validObjectEdit(titleEdit) || title === chart.title}>{t("properties.chart.titleApply")}</button>
        <button type="button" className="document-bar__button" disabled={disabled || chart.title === null}
          onClick={() => onEdit({ kind: "chartTitle", text: null })}>{t("properties.chart.titleRemove")}</button>
      </form>
      {plot && <label className="picture-size-field">{t("properties.chart.plot")}
        <select value={plot} disabled={disabled} onChange={event => onEdit({ kind: "chartType", plot: event.target.value as typeof CHART_PLOTS[number] })}>
          {CHART_PLOTS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>}
      <form onSubmit={event => { event.preventDefault(); if (!disabled && dataValid) onEdit(data); }}>
        <fieldset className="chart-data-fields">
          <legend>{t("properties.chart.data")}</legend>
          {labels.map((label, c) => (
            <input key={`c${c}`} type="text" aria-label={t("properties.chart.category", { index: c + 1 })} value={label} disabled={disabled}
              onChange={event => setLabels(current => current.map((v, i) => i === c ? event.target.value : v))} />
          ))}
          {names.map((name, r) => (
            <div key={`s${r}`} className="chart-data-row">
              <input type="text" aria-label={t("properties.chart.seriesName", { index: r + 1 })} value={name} disabled={disabled}
                onChange={event => setNames(current => current.map((v, i) => i === r ? event.target.value : v))} />
              {values[r]!.map((value, c) => (
                <input key={c} type="text" inputMode="decimal" aria-label={t("properties.chart.value", { series: r + 1, category: c + 1 })}
                  value={value} disabled={disabled}
                  onChange={event => setValues(current => current.map((row, i) => i !== r ? row : row.map((v, j) => j === c ? event.target.value : v)))} />
              ))}
            </div>
          ))}
        </fieldset>
        <button type="submit" className="document-bar__button" disabled={disabled || !dataValid}>{t("properties.chart.dataApply")}</button>
      </form>
    </div>
  );
}

function SmartArtFields({ art, disabled, onEdit }: { art: SmartArtGraphic; disabled: boolean; onEdit: (edit: ObjectEdit) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(art.items.map(item => `${"  ".repeat(item.level)}${item.text}`).join("\n"));
  const items = text.split("\n").filter(line => line.trim() !== "").map(line => {
    const indent = line.length - line.trimStart().length;
    return { text: line.trim(), level: Math.floor(indent / 2) };
  });
  const edit: ObjectEdit = { kind: "smartArtItems", items };
  const layout = SMART_ART_LAYOUTS.find(l => l === art.layout);
  return (
    <div className="smart-art-tools">
      <form onSubmit={event => { event.preventDefault(); if (!disabled && validObjectEdit(edit)) onEdit(edit); }}>
        <label className="picture-size-field">{t("properties.smartArt.items")}
          <textarea rows={Math.min(12, Math.max(3, items.length + 1))} value={text} disabled={disabled} onChange={event => setText(event.target.value)} />
        </label>
        <button type="submit" className="document-bar__button" disabled={disabled || !validObjectEdit(edit)}>{t("properties.smartArt.itemsApply")}</button>
      </form>
      {layout && <label className="picture-size-field">{t("properties.smartArt.layout")}
        <select value={layout} disabled={disabled} onChange={event => onEdit({ kind: "smartArtLayout", layout: event.target.value as typeof SMART_ART_LAYOUTS[number] })}>
          {SMART_ART_LAYOUTS.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      </label>}
    </div>
  );
}

function ShapeFields({ shape, disabled, can, outlineWidth, onEdit }: {
  shape: ShapeProperties;
  disabled: boolean;
  can: (op: ObjectSelection["operations"][number]) => boolean;
  /** Minimum supported width in points, or null when only color is editable. */
  outlineWidth: number | null;
  onEdit: (edit: ObjectEdit) => void;
}) {
  const { t } = useTranslation();
  const [outline, setOutline] = useState(`#${shape.outline ?? "000000"}`);
  const [width, setWidth] = useState(String(shape.outlineWidth));
  const [rotation, setRotation] = useState(String(shape.rotation));
  const [flipH, setFlipH] = useState(shape.flipH);
  const [flipV, setFlipV] = useState(shape.flipV);
  const hex = (value: string) => value.replace(/^#/, "").toUpperCase();
  const widthValue = Number(width), rotationValue = Number(rotation);
  const widthValid = outlineWidth === null || (width.trim() !== "" && Number.isFinite(widthValue) && widthValue >= outlineWidth && widthValue <= 72);
  const rotationValid = rotation.trim() !== "" && Number.isFinite(rotationValue) && Math.abs(rotationValue) <= 3600;
  return (
    <div className="shape-tools">
      {can("fill") && <>
        <label className="picture-size-field">{t("properties.shape.fill")}
          <input type="color" value={`#${shape.fill ?? "FFFFFF"}`} disabled={disabled}
            onChange={event => onEdit({ kind: "fill", color: hex(event.target.value) })} />
        </label>
        <button type="button" className="document-bar__button" disabled={disabled || shape.fill === null}
          onClick={() => onEdit({ kind: "fill", color: null })}>{t("properties.shape.noFill")}</button>
      </>}
      {can("outline") && <form onSubmit={event => {
        event.preventDefault();
        if (disabled || !widthValid) return;
        onEdit(outlineWidth !== null ? { kind: "outline", color: hex(outline), width: widthValue } : { kind: "outline", color: hex(outline) });
      }}>
        <label className="picture-size-field">{t("properties.shape.outline")}
          <input type="color" value={outline} disabled={disabled} onChange={event => setOutline(event.target.value)} />
        </label>
        {outlineWidth !== null && <label className="picture-size-field">{t("properties.shape.outlineWidth")}
          <input type="number" min={outlineWidth} max={72} step={outlineWidth === 0 ? 0.25 : 0.01} value={width} disabled={disabled} onChange={event => setWidth(event.target.value)} />
        </label>}
        <button type="submit" className="document-bar__button" disabled={disabled || !widthValid}>{t("properties.shape.outlineApply")}</button>
      </form>}
      {can("rotate") && <form onSubmit={event => {
        event.preventDefault();
        if (!disabled && rotationValid) onEdit({ kind: "rotate", degrees: rotationValue, flipH, flipV });
      }}>
        <label className="picture-size-field">{t("properties.shape.rotation")}
          <input type="number" min={-3600} max={3600} step={1} value={rotation} disabled={disabled} onChange={event => setRotation(event.target.value)} />
        </label>
        <label className="picture-size-field"><input type="checkbox" checked={flipH} disabled={disabled} onChange={event => setFlipH(event.target.checked)} />{t("properties.shape.flipH")}</label>
        <label className="picture-size-field"><input type="checkbox" checked={flipV} disabled={disabled} onChange={event => setFlipV(event.target.checked)} />{t("properties.shape.flipV")}</label>
        <button type="submit" className="document-bar__button" disabled={disabled || !rotationValid}>{t("properties.shape.rotationApply")}</button>
      </form>}
      {can("zOrder") && <>
        <button type="button" className="document-bar__button" disabled={disabled} onClick={() => onEdit({ kind: "layer", front: true })}>{t("properties.shape.front")}</button>
        <button type="button" className="document-bar__button" disabled={disabled} onClick={() => onEdit({ kind: "layer", front: false })}>{t("properties.shape.back")}</button>
      </>}
    </div>
  );
}

function PictureCropFields({ crop, disabled, onApply }: {
  crop: readonly [number, number, number, number];
  disabled: boolean;
  onApply: (edit: ObjectEdit) => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState(() => crop.map(side => String(Math.round(side * 10000) / 100)));
  const numbers = values.map(Number);
  const max = MAX_CROP_FRACTION * 100;
  const valid = numbers.every(value => values.every(v => v.trim() !== "") && Number.isFinite(value) && value >= 0 && value <= max);
  const sides = ["left", "top", "right", "bottom"] as const;
  const edit = (fractions: number[]): ObjectEdit => ({ kind: "crop", left: fractions[0]!, top: fractions[1]!, right: fractions[2]!, bottom: fractions[3]! });
  return (
    <form onSubmit={event => { event.preventDefault(); if (!disabled && valid) onApply(edit(numbers.map(value => value / 100))); }}>
      <fieldset className="picture-crop-fields">
        <legend>{t("properties.picture.crop")}</legend>
        {sides.map((side, index) => (
          <label key={side} className="picture-size-field">{t(`properties.picture.crop.${side}`)}
            <input type="number" min={0} max={max} step={0.01} value={values[index]} disabled={disabled}
              onChange={event => setValues(current => current.map((value, i) => i === index ? event.target.value : value))} />
          </label>
        ))}
      </fieldset>
      <button type="submit" className="document-bar__button" disabled={disabled || !valid}>{t("properties.picture.crop.apply")}</button>
      <button type="button" className="document-bar__button" disabled={disabled || crop.every(side => side === 0) || crop.some(side => side > MAX_CROP_FRACTION)}
        onClick={() => onApply(edit([0, 0, 0, 0]))}>{t("properties.picture.crop.reset")}</button>
    </form>
  );
}

function AltTextField({ value, disabled, onApply }: { value: string; disabled: boolean; onApply: (text: string) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(value);
  const valid = validAltText(text);
  return (
    <form onSubmit={event => { event.preventDefault(); if (!disabled && valid && text !== value) onApply(text); }}>
      <label className="picture-size-field">{t("properties.picture.descriptionInput")}
        <input type="text" value={text} maxLength={MAX_ALT_TEXT_CHARS} disabled={disabled} onChange={event => setText(event.target.value)} />
      </label>
      <button type="submit" className="document-bar__button" disabled={disabled || !valid || text === value}>{t("properties.picture.descriptionApply")}</button>
    </form>
  );
}

function PictureSizeFields({ picture, onApply, disabled }: {
  picture: PictureProperties;
  onApply: (widthPt: number, heightPt: number) => void;
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
      onApply(widthPt, heightPt);
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
