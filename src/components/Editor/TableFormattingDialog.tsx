// Stage 2 Phase 3 (P3-1): table cell shading and borders dialogs.
// Only format-supported border styles and widths offered in request.context.tableBorders are exposed.
import { useLayoutEffect, useRef, useState } from "react";
import type { CommandInputRequest } from "../../commands/commands";
import { normalizeHexRgb, validateCommandArgs } from "../../commands/parameters";
import type { DocumentCommandArgs } from "../../commands/target";
import type { MessageKey } from "../../language";
import { useTranslation } from "../../language/LanguageContext";

type BorderKind = "all" | "outside" | "inside" | "none" | "top" | "bottom" | "left" | "right";
type HorizontalAlign = "left" | "center" | "right" | "justify";
type VerticalAlign = "top" | "middle" | "bottom";

const SHADING_PRESETS = ["#FEF08A", "#DBEAFE", "#DCFCE7", "#FEE2E2", "#F3E8FF", "#F1F5F9", "#E2E8F0", "#FFFFFF"] as const;
const BORDER_COLOR_PRESETS = ["#000000", "#475569", "#1E40AF", "#DC2626", "#15803D"] as const;
const HORIZONTAL_ALIGNS: readonly { value: HorizontalAlign; labelKey: MessageKey }[] = [
  { value: "left", labelKey: "tableFormat.alignment.left" },
  { value: "center", labelKey: "tableFormat.alignment.center" },
  { value: "right", labelKey: "tableFormat.alignment.right" },
  { value: "justify", labelKey: "tableFormat.alignment.justify" },
];
const VERTICAL_ALIGNS: readonly { value: VerticalAlign; labelKey: MessageKey }[] = [
  { value: "top", labelKey: "tableFormat.alignment.top" },
  { value: "middle", labelKey: "tableFormat.alignment.middle" },
  { value: "bottom", labelKey: "tableFormat.alignment.bottom" },
];
const BORDER_KINDS: readonly { kind: BorderKind; labelKey: MessageKey }[] = [
  { kind: "all", labelKey: "tableFormat.borders.all" },
  { kind: "outside", labelKey: "tableFormat.borders.outside" },
  { kind: "inside", labelKey: "tableFormat.borders.inside" },
  { kind: "top", labelKey: "tableFormat.borders.top" },
  { kind: "bottom", labelKey: "tableFormat.borders.bottom" },
  { kind: "left", labelKey: "tableFormat.borders.left" },
  { kind: "right", labelKey: "tableFormat.borders.right" },
  { kind: "none", labelKey: "tableFormat.borders.none" },
];

export function TableFormattingDialog({ request, suspended, onCancel, onConfirm }: {
  request: CommandInputRequest;
  suspended?: boolean;
  onCancel: () => void;
  onConfirm: (args: DocumentCommandArgs) => void;
}) {
  const { t } = useTranslation();
  const isShading = request.command === "table.shading";
  const isAlignment = request.command === "table.alignment";
  const isColWidth = request.command === "table.columnWidth";
  const isRowHeight = request.command === "table.rowHeight";
  const isCellMargins = request.command === "table.cellMargins";
  const isPositioning = request.command === "table.positioning";
  const isRepeatHeader = request.command === "table.repeatHeader";
  const isRowBreak = request.command === "table.rowBreak";
  const shadingCtx = request.context.tableShading;
  const bordersCtx = request.context.tableBorders;
  const alignCtx = request.context.tableAlignment;
  const colWidthCtx = request.context.tableColumnWidth;
  const rowHeightCtx = request.context.tableRowHeight;
  const marginsCtx = request.context.tableCellMargins;
  const posCtx = request.context.tablePositioning;
  const repeatHeaderCtx = request.context.tableRepeatHeader;
  const rowBreakCtx = request.context.tableRowBreak;
  const sampleEdge = bordersCtx?.current?.top ?? bordersCtx?.current?.bottom ?? bordersCtx?.current?.left ?? bordersCtx?.current?.right;
  const initialStyle = sampleEdge && bordersCtx?.supportedStyles.includes(sampleEdge.style) && sampleEdge.style !== "none"
    ? sampleEdge.style
    : bordersCtx?.supportedStyles.find((s) => s !== "none") ?? "single";
  const initialWidth = sampleEdge && bordersCtx?.supportedWidths.some((w) => Math.abs(w - sampleEdge.width) < 1e-6)
    ? sampleEdge.width
    : bordersCtx?.defaultWidth ?? 0.5;
  const initialBorderColor = sampleEdge?.color ?? "#000000";

  const [shadeColor, setShadeColor] = useState(shadingCtx?.color ?? "#FEF08A");
  const [borderKind, setBorderKind] = useState<BorderKind>("all");
  const [borderStyle, setBorderStyle] = useState(initialStyle);
  const [borderWidth, setBorderWidth] = useState(String(initialWidth));
  const [borderColor, setBorderColor] = useState(initialBorderColor);
  const [hAlign, setHAlign] = useState<HorizontalAlign | null>(alignCtx?.horizontal ?? null);
  const [vAlign, setVAlign] = useState<VerticalAlign | null>(alignCtx?.vertical ?? null);
  const [colWidthText, setColWidthText] = useState(colWidthCtx?.width != null ? String(colWidthCtx.width) : "");
  const [rowHeightText, setRowHeightText] = useState(rowHeightCtx?.height != null ? String(rowHeightCtx.height) : "");
  const [rowRule, setRowRule] = useState<"atLeast" | "exact">(
    rowHeightCtx?.rule && rowHeightCtx.supportedRules.includes(rowHeightCtx.rule)
      ? rowHeightCtx.rule
      : rowHeightCtx?.supportedRules[0] ?? "atLeast",
  );
  const [marginScope, setMarginScope] = useState<"cell" | "table">("cell");
  const [marginTop, setMarginTop] = useState(marginsCtx?.cell.top != null ? String(marginsCtx.cell.top) : "");
  const [marginRight, setMarginRight] = useState(marginsCtx?.cell.right != null ? String(marginsCtx.cell.right) : "");
  const [marginBottom, setMarginBottom] = useState(marginsCtx?.cell.bottom != null ? String(marginsCtx.cell.bottom) : "");
  const [marginLeft, setMarginLeft] = useState(marginsCtx?.cell.left != null ? String(marginsCtx.cell.left) : "");
  const [posAlign, setPosAlign] = useState<"left" | "center" | "right">(posCtx?.align ?? "left");
  const [posIndentText, setPosIndentText] = useState(String(posCtx?.indentPt ?? 0));
  const [posTreatAsChar, setPosTreatAsChar] = useState(posCtx?.treatAsChar ?? false);
  const [outerTop, setOuterTop] = useState(String(posCtx?.outerMargins?.top ?? 0));
  const [outerRight, setOuterRight] = useState(String(posCtx?.outerMargins?.right ?? 0));
  const [outerBottom, setOuterBottom] = useState(String(posCtx?.outerMargins?.bottom ?? 0));
  const [outerLeft, setOuterLeft] = useState(String(posCtx?.outerMargins?.left ?? 0));
  const [repeatHeaderOn, setRepeatHeaderOn] = useState(repeatHeaderCtx?.repeat ?? false);
  const [rowBreakMode, setRowBreakMode] = useState<"cell" | "row" | "none">(
    rowBreakCtx?.mode ?? rowBreakCtx?.supportedModes[0] ?? "cell",
  );
  const [error, setError] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFocusRef = useRef<HTMLInputElement | HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!suspended) firstFocusRef.current?.focus();
    return () => {
      const target = previousFocus.current;
      if (target && target.isConnected && !document.querySelector('[role="dialog"]')) target.focus();
    };
  }, [suspended]);

  const submitShading = (color: string | null) => {
    const args: DocumentCommandArgs = { command: "table.shading", color };
    if (!validateCommandArgs("table.shading", args, request.context)) {
      setError(true);
      return;
    }
    onConfirm(args);
  };

  const submitBorders = () => {
    const args: DocumentCommandArgs = borderKind === "none"
      ? { command: "table.borders", kind: "none" }
      : {
          command: "table.borders",
          kind: borderKind,
          style: borderStyle,
          width: Number(borderWidth),
          color: normalizeHexRgb(borderColor) ?? "",
        };
    if (!validateCommandArgs("table.borders", args, request.context)) {
      setError(true);
      return;
    }
    onConfirm(args);
  };

  const submitAlignment = () => {
    const args: DocumentCommandArgs = {
      command: "table.alignment",
      ...(hAlign !== null ? { horizontal: hAlign } : {}),
      ...(vAlign !== null ? { vertical: vAlign } : {}),
    };
    if (!validateCommandArgs("table.alignment", args, request.context)) {
      setError(true);
      return;
    }
    onConfirm(args);
  };

  const submitColWidth = (distribute = false) => {
    const trimmed = colWidthText.trim();
    const args: DocumentCommandArgs = distribute
      ? { command: "table.columnWidth", distribute: true }
      : { command: "table.columnWidth", width: trimmed === "" ? NaN : Number(trimmed) };
    if (!validateCommandArgs("table.columnWidth", args, request.context)) {
      setError(true);
      return;
    }
    onConfirm(args);
  };

  const submitRowHeight = (mode: "set" | "auto" | "distribute" = "set") => {
    const trimmed = rowHeightText.trim();
    const args: DocumentCommandArgs = mode === "distribute"
      ? { command: "table.rowHeight", distribute: true }
      : mode === "auto"
        ? { command: "table.rowHeight", height: null }
        : {
            command: "table.rowHeight",
            height: trimmed === "" ? NaN : Number(trimmed),
            rule: rowRule,
          };
    if (!validateCommandArgs("table.rowHeight", args, request.context)) {
      setError(true);
      return;
    }
    onConfirm(args);
  };

  const switchMarginScope = (nextScope: "cell" | "table") => {
    setMarginScope(nextScope);
    setError(false);
    if (nextScope === "table" && marginsCtx) {
      setMarginTop(String(marginsCtx.table.top));
      setMarginRight(String(marginsCtx.table.right));
      setMarginBottom(String(marginsCtx.table.bottom));
      setMarginLeft(String(marginsCtx.table.left));
    } else if (marginsCtx) {
      setMarginTop(marginsCtx.cell.top != null ? String(marginsCtx.cell.top) : "");
      setMarginRight(marginsCtx.cell.right != null ? String(marginsCtx.cell.right) : "");
      setMarginBottom(marginsCtx.cell.bottom != null ? String(marginsCtx.cell.bottom) : "");
      setMarginLeft(marginsCtx.cell.left != null ? String(marginsCtx.cell.left) : "");
    }
  };

  const submitCellMargins = (reset = false) => {
    let args: DocumentCommandArgs;
    if (reset) {
      args = { command: "table.cellMargins", scope: "cell", reset: true };
    } else {
      const parseSide = (raw: string): number | undefined => {
        const s = raw.trim();
        return s === "" ? undefined : Number(s);
      };
      const top = parseSide(marginTop);
      const right = parseSide(marginRight);
      const bottom = parseSide(marginBottom);
      const left = parseSide(marginLeft);
      args = {
        command: "table.cellMargins",
        scope: marginScope,
        ...(top !== undefined ? { top } : {}),
        ...(right !== undefined ? { right } : {}),
        ...(bottom !== undefined ? { bottom } : {}),
        ...(left !== undefined ? { left } : {}),
      };
    }
    if (!validateCommandArgs("table.cellMargins", args, request.context)) {
      setError(true);
      return;
    }
    onConfirm(args);
  };

  const submitPositioning = () => {
    const indentNum = Number(posIndentText.trim() === "" ? "NaN" : posIndentText.trim());
    const args: DocumentCommandArgs = {
      command: "table.positioning",
      align: posAlign,
      ...(posCtx?.supportsIndent ? { indentPt: indentNum } : {}),
      ...(posCtx?.treatAsCharSupported ? { treatAsChar: posTreatAsChar } : {}),
      ...(posCtx?.outerMargins
        ? {
            outerMargins: {
              top: outerTop.trim() === "" ? NaN : Number(outerTop.trim()),
              right: outerRight.trim() === "" ? NaN : Number(outerRight.trim()),
              bottom: outerBottom.trim() === "" ? NaN : Number(outerBottom.trim()),
              left: outerLeft.trim() === "" ? NaN : Number(outerLeft.trim()),
            },
          }
        : {}),
    };
    if (!validateCommandArgs("table.positioning", args, request.context)) {
      setError(true);
      return;
    }
    onConfirm(args);
  };

  const submitRepeatHeader = () => {
    const args: DocumentCommandArgs = { command: "table.repeatHeader", repeat: repeatHeaderOn };
    if (!validateCommandArgs("table.repeatHeader", args, request.context)) {
      setError(true);
      return;
    }
    onConfirm(args);
  };

  const submitRowBreak = () => {
    const args: DocumentCommandArgs = { command: "table.rowBreak", mode: rowBreakMode };
    if (!validateCommandArgs("table.rowBreak", args, request.context)) {
      setError(true);
      return;
    }
    onConfirm(args);
  };

  const submit = () => {
    if (isShading) {
      const normalized = normalizeHexRgb(shadeColor);
      if (!normalized) {
        setError(true);
        return;
      }
      submitShading(normalized);
    } else if (isAlignment) {
      submitAlignment();
    } else if (isColWidth) {
      submitColWidth(false);
    } else if (isRowHeight) {
      submitRowHeight("set");
    } else if (isCellMargins) {
      submitCellMargins(false);
    } else if (isPositioning) {
      submitPositioning();
    } else if (isRepeatHeader) {
      submitRepeatHeader();
    } else if (isRowBreak) {
      submitRowBreak();
    } else {
      submitBorders();
    }
  };

  const normalizedShade = normalizeHexRgb(shadeColor);
  const normalizedBorder = normalizeHexRgb(borderColor);

  return (
    <div className="discard-dialog__backdrop" onMouseDown={(event) => {
      if (event.target instanceof Element && event.target.closest("button, input, label, select")) return;
      event.preventDefault();
    }}>
      <div
        ref={dialogRef}
        className="discard-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="table-format-dialog-title"
        data-testid="table-format-dialog"
        data-command={request.command}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") { event.preventDefault(); onCancel(); }
          if (event.key === "Enter" && event.target instanceof HTMLInputElement) { event.preventDefault(); submit(); }
        }}
      >
        <h2 id="table-format-dialog-title" className="discard-dialog__title">{t(request.labelKey)}</h2>
        {isShading ? (
          <div style={{ display: "grid", gap: "10px" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              {SHADING_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="document-bar__button"
                  data-testid={`shading-swatch-${preset.slice(1)}`}
                  aria-label={preset}
                  style={{ width: "26px", height: "26px", padding: 0, backgroundColor: preset, border: normalizedShade === preset ? "2px solid currentColor" : undefined }}
                  onClick={() => { setShadeColor(preset); setError(false); }}
                />
              ))}
            </div>
            <div className="stage1-dialog__grid">
              <label htmlFor="table-shading-color">{t("tableFormat.shading.color")}</label>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <input
                  ref={firstFocusRef as React.RefObject<HTMLInputElement>}
                  id="table-shading-color"
                  data-testid="table-shading-color"
                  value={shadeColor}
                  onChange={(e) => { setShadeColor(e.target.value); setError(false); }}
                />
                <input
                  type="color"
                  aria-label={t("tableFormat.shading.color")}
                  value={normalizedShade ?? "#FEF08A"}
                  onChange={(e) => { setShadeColor(e.target.value.toUpperCase()); setError(false); }}
                />
              </div>
            </div>
            {shadingCtx?.supportsClear && (
              <div>
                <button
                  type="button"
                  className="document-bar__button"
                  data-testid="table-shading-clear"
                  onClick={() => submitShading(null)}
                >
                  {t("tableFormat.shading.clear")}
                </button>
              </div>
            )}
          </div>
        ) : isAlignment ? (
          <div style={{ display: "grid", gap: "12px" }}>
            <div style={{ display: "grid", gap: "6px" }}>
              <span>
                {t("tableFormat.alignment.horizontal")}
                {alignCtx?.horizontalMixed && hAlign === null ? ` (${t("tableFormat.alignment.mixed")})` : ""}
              </span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {HORIZONTAL_ALIGNS.map(({ value, labelKey }, index) => (
                  <button
                    key={value}
                    ref={index === 0 ? firstFocusRef as React.RefObject<HTMLButtonElement> : undefined}
                    type="button"
                    aria-pressed={hAlign === value}
                    className="document-bar__button"
                    data-testid={`align-h-${value}`}
                    style={{ fontWeight: hAlign === value ? 700 : 400 }}
                    onClick={() => { setHAlign(value); setError(false); }}
                  >
                    {t(labelKey)}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: "grid", gap: "6px" }}>
              <span>
                {t("tableFormat.alignment.vertical")}
                {alignCtx?.verticalMixed && vAlign === null ? ` (${t("tableFormat.alignment.mixed")})` : ""}
              </span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {VERTICAL_ALIGNS.map(({ value, labelKey }) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={vAlign === value}
                    className="document-bar__button"
                    data-testid={`align-v-${value}`}
                    style={{ fontWeight: vAlign === value ? 700 : 400 }}
                    onClick={() => { setVAlign(value); setError(false); }}
                  >
                    {t(labelKey)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : isColWidth ? (
          <div style={{ display: "grid", gap: "10px" }}>
            <div className="stage1-dialog__grid">
              <label htmlFor="table-col-width">
                {t("tableFormat.dimensions.widthPt")}
                {colWidthCtx?.mixed ? ` (${t("tableFormat.alignment.mixed")})` : ""}
              </label>
              <input
                ref={firstFocusRef as React.RefObject<HTMLInputElement>}
                id="table-col-width"
                data-testid="table-col-width"
                type="number"
                step="0.5"
                min={colWidthCtx?.minPt ?? 6}
                max={colWidthCtx?.maxPt ?? 1584}
                value={colWidthText}
                onChange={(e) => { setColWidthText(e.target.value); setError(false); }}
              />
            </div>
            {(colWidthCtx?.totalCols ?? 1) >= 2 && (
              <div>
                <button
                  type="button"
                  className="document-bar__button"
                  data-testid="table-distribute-cols"
                  onClick={() => submitColWidth(true)}
                >
                  {t("tableFormat.dimensions.distributeColumns")}
                </button>
              </div>
            )}
          </div>
        ) : isRowHeight ? (
          <div style={{ display: "grid", gap: "10px" }}>
            <div className="stage1-dialog__grid">
              <label htmlFor="table-row-height">
                {t("tableFormat.dimensions.heightPt")}
                {rowHeightCtx?.mixed ? ` (${t("tableFormat.alignment.mixed")})` : ""}
              </label>
              <input
                ref={firstFocusRef as React.RefObject<HTMLInputElement>}
                id="table-row-height"
                data-testid="table-row-height"
                type="number"
                step="0.5"
                min={rowHeightCtx?.minPt ?? 1}
                max={rowHeightCtx?.maxPt ?? 1584}
                value={rowHeightText}
                onChange={(e) => { setRowHeightText(e.target.value); setError(false); }}
              />
              {(rowHeightCtx?.supportedRules.length ?? 0) > 1 && (
                <>
                  <label htmlFor="table-row-rule">{t("tableFormat.dimensions.rule")}</label>
                  <select
                    id="table-row-rule"
                    data-testid="table-row-rule"
                    value={rowRule}
                    onChange={(e) => { setRowRule(e.target.value as "atLeast" | "exact"); setError(false); }}
                  >
                    {rowHeightCtx!.supportedRules.map((rule) => (
                      <option key={rule} value={rule}>
                        {t(`tableFormat.dimensions.rule.${rule}` as MessageKey)}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {(rowHeightCtx?.totalRows ?? 1) >= 2 && (
                <button
                  type="button"
                  className="document-bar__button"
                  data-testid="table-distribute-rows"
                  onClick={() => submitRowHeight("distribute")}
                >
                  {t("tableFormat.dimensions.distributeRows")}
                </button>
              )}
              {rowHeightCtx?.supportsAuto && (
                <button
                  type="button"
                  className="document-bar__button"
                  data-testid="table-auto-row-height"
                  onClick={() => submitRowHeight("auto")}
                >
                  {t("tableFormat.dimensions.autoHeight")}
                </button>
              )}
            </div>
          </div>
        ) : isCellMargins ? (
          <div style={{ display: "grid", gap: "10px" }}>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              <button
                ref={firstFocusRef as React.RefObject<HTMLButtonElement>}
                type="button"
                aria-pressed={marginScope === "cell"}
                className="document-bar__button"
                data-testid="margin-scope-cell"
                style={{ fontWeight: marginScope === "cell" ? 700 : 400 }}
                onClick={() => switchMarginScope("cell")}
              >
                {t("tableFormat.margins.scopeCell")}
              </button>
              {marginsCtx?.scopeDefaultSupported && (
                <button
                  type="button"
                  aria-pressed={marginScope === "table"}
                  className="document-bar__button"
                  data-testid="margin-scope-table"
                  style={{ fontWeight: marginScope === "table" ? 700 : 400 }}
                  onClick={() => switchMarginScope("table")}
                >
                  {t("tableFormat.margins.scopeTable")}
                </button>
              )}
            </div>
            <div className="stage1-dialog__grid">
              <label htmlFor="table-margin-top">{t("tableFormat.margins.top")}</label>
              <input id="table-margin-top" data-testid="table-margin-top" type="number" step="0.5" min={marginsCtx?.minPt ?? 0} max={marginsCtx?.maxPt ?? 144} value={marginTop} onChange={(e) => { setMarginTop(e.target.value); setError(false); }} />
              <label htmlFor="table-margin-right">{t("tableFormat.margins.right")}</label>
              <input id="table-margin-right" data-testid="table-margin-right" type="number" step="0.5" min={marginsCtx?.minPt ?? 0} max={marginsCtx?.maxPt ?? 144} value={marginRight} onChange={(e) => { setMarginRight(e.target.value); setError(false); }} />
              <label htmlFor="table-margin-bottom">{t("tableFormat.margins.bottom")}</label>
              <input id="table-margin-bottom" data-testid="table-margin-bottom" type="number" step="0.5" min={marginsCtx?.minPt ?? 0} max={marginsCtx?.maxPt ?? 144} value={marginBottom} onChange={(e) => { setMarginBottom(e.target.value); setError(false); }} />
              <label htmlFor="table-margin-left">{t("tableFormat.margins.left")}</label>
              <input id="table-margin-left" data-testid="table-margin-left" type="number" step="0.5" min={marginsCtx?.minPt ?? 0} max={marginsCtx?.maxPt ?? 144} value={marginLeft} onChange={(e) => { setMarginLeft(e.target.value); setError(false); }} />
            </div>
            {marginScope === "cell" && !marginsCtx?.cell.usesTableDefault && (
              <div>
                <button
                  type="button"
                  className="document-bar__button"
                  data-testid="table-margin-reset"
                  onClick={() => submitCellMargins(true)}
                >
                  {t("tableFormat.margins.reset")}
                </button>
              </div>
            )}
          </div>
        ) : isPositioning ? (
          <div style={{ display: "grid", gap: "10px" }}>
            <div style={{ display: "grid", gap: "6px" }}>
              <span>{t("tableFormat.positioning.align")}</span>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                {(["left", "center", "right"] as const).map((value, index) => (
                  <button
                    key={value}
                    ref={index === 0 ? firstFocusRef as React.RefObject<HTMLButtonElement> : undefined}
                    type="button"
                    aria-pressed={posAlign === value}
                    className="document-bar__button"
                    data-testid={`table-pos-align-${value}`}
                    style={{ fontWeight: posAlign === value ? 700 : 400 }}
                    onClick={() => { setPosAlign(value); setError(false); }}
                  >
                    {t(`tableFormat.alignment.${value}` as MessageKey)}
                  </button>
                ))}
              </div>
            </div>
            {posCtx?.supportsIndent && (
              <div className="stage1-dialog__grid">
                <label htmlFor="table-pos-indent">{t("tableFormat.positioning.indentPt")}</label>
                <input
                  id="table-pos-indent"
                  data-testid="table-pos-indent"
                  type="number"
                  step="1"
                  min={posCtx.minIndentPt}
                  max={posCtx.maxIndentPt}
                  value={posIndentText}
                  onChange={(e) => { setPosIndentText(e.target.value); setError(false); }}
                />
              </div>
            )}
            {posCtx?.treatAsCharSupported && (
              <label style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <input
                  type="checkbox"
                  data-testid="table-pos-treat-as-char"
                  checked={posTreatAsChar}
                  onChange={(e) => { setPosTreatAsChar(e.target.checked); setError(false); }}
                />
                <span>{t("tableFormat.positioning.treatAsChar")}</span>
              </label>
            )}
            {posCtx?.outerMargins && (
              <div style={{ display: "grid", gap: "6px" }}>
                <span>{t("tableFormat.positioning.outerMargins")}</span>
                <div className="stage1-dialog__grid">
                  <label htmlFor="table-outer-margin-top">{t("tableFormat.margins.top")}</label>
                  <input id="table-outer-margin-top" data-testid="table-outer-margin-top" type="number" step="0.5" min={0} max={144} value={outerTop} onChange={(e) => { setOuterTop(e.target.value); setError(false); }} />
                  <label htmlFor="table-outer-margin-right">{t("tableFormat.margins.right")}</label>
                  <input id="table-outer-margin-right" data-testid="table-outer-margin-right" type="number" step="0.5" min={0} max={144} value={outerRight} onChange={(e) => { setOuterRight(e.target.value); setError(false); }} />
                  <label htmlFor="table-outer-margin-bottom">{t("tableFormat.margins.bottom")}</label>
                  <input id="table-outer-margin-bottom" data-testid="table-outer-margin-bottom" type="number" step="0.5" min={0} max={144} value={outerBottom} onChange={(e) => { setOuterBottom(e.target.value); setError(false); }} />
                  <label htmlFor="table-outer-margin-left">{t("tableFormat.margins.left")}</label>
                  <input id="table-outer-margin-left" data-testid="table-outer-margin-left" type="number" step="0.5" min={0} max={144} value={outerLeft} onChange={(e) => { setOuterLeft(e.target.value); setError(false); }} />
                </div>
              </div>
            )}
          </div>
        ) : isRepeatHeader ? (
          <div style={{ display: "grid", gap: "10px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <input
                ref={firstFocusRef as React.RefObject<HTMLInputElement>}
                type="checkbox"
                data-testid="table-repeat-header-toggle"
                checked={repeatHeaderOn}
                disabled={repeatHeaderCtx?.canEnableHeader === false && !repeatHeaderOn}
                onChange={(e) => { setRepeatHeaderOn(e.target.checked); setError(false); }}
              />
              <span>
                {t("tableFormat.repeatHeader.enabled")}
                {repeatHeaderCtx?.mixed ? ` (${t("tableFormat.alignment.mixed")})` : ""}
              </span>
            </label>
            <p style={{ margin: 0, fontSize: "0.9em" }}>
              {t("tableFormat.repeatHeader.leadingCount")}: {repeatHeaderCtx?.leadingHeaderRows ?? 0}
            </p>
            {repeatHeaderCtx?.canEnableHeader === false && (
              <p role="note" data-testid="table-repeat-header-notice" style={{ margin: 0, fontSize: "0.9em" }}>
                {t("tableFormat.repeatHeader.nonLeadingNotice")}
              </p>
            )}
          </div>
        ) : isRowBreak ? (
          <div style={{ display: "grid", gap: "10px" }}>
            <div className="stage1-dialog__grid">
              <label htmlFor="table-row-break-mode">{t("tableFormat.rowBreak.mode")}</label>
              <select
                ref={firstFocusRef as unknown as React.RefObject<HTMLSelectElement>}
                id="table-row-break-mode"
                data-testid="table-row-break-mode"
                value={rowBreakMode}
                onChange={(e) => { setRowBreakMode(e.target.value as "cell" | "row" | "none"); setError(false); }}
              >
                {(rowBreakCtx?.supportedModes ?? ["cell", "row"]).map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`tableFormat.rowBreak.${mode}` as MessageKey)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: "10px" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              {BORDER_KINDS.map(({ kind, labelKey }, index) => {
                const disabled = kind === "inside" && !bordersCtx?.hasInsideBorders;
                return (
                  <button
                    key={kind}
                    ref={index === 0 ? firstFocusRef as React.RefObject<HTMLButtonElement> : undefined}
                    type="button"
                    disabled={disabled}
                    aria-pressed={borderKind === kind}
                    className="document-bar__button"
                    data-testid={`border-kind-${kind}`}
                    style={{ fontWeight: borderKind === kind ? 700 : 400 }}
                    onClick={() => { setBorderKind(kind); setError(false); }}
                  >
                    {t(labelKey)}
                  </button>
                );
              })}
            </div>
            {borderKind !== "none" && (
              <div className="stage1-dialog__grid">
                <label htmlFor="table-border-style">{t("tableFormat.borders.style")}</label>
                <select
                  id="table-border-style"
                  data-testid="table-border-style"
                  value={borderStyle}
                  onChange={(e) => { setBorderStyle(e.target.value); setError(false); }}
                >
                  {(bordersCtx?.supportedStyles ?? ["single"]).map((style) => (
                    <option key={style} value={style}>
                      {t(`tableFormat.style.${style}` as MessageKey)}
                    </option>
                  ))}
                </select>
                <label htmlFor="table-border-width">{t("tableFormat.borders.width")}</label>
                <select
                  id="table-border-width"
                  data-testid="table-border-width"
                  value={borderWidth}
                  onChange={(e) => { setBorderWidth(e.target.value); setError(false); }}
                >
                  {(bordersCtx?.supportedWidths ?? [0.5]).map((w) => (
                    <option key={w} value={String(w)}>
                      {w} {bordersCtx?.widthUnit ?? "mm"}
                    </option>
                  ))}
                </select>
                <label htmlFor="table-border-color">{t("tableFormat.borders.color")}</label>
                <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                  {BORDER_COLOR_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className="document-bar__button"
                      aria-label={preset}
                      style={{ width: "22px", height: "22px", padding: 0, backgroundColor: preset, border: normalizedBorder === preset ? "2px solid currentColor" : undefined }}
                      onClick={() => { setBorderColor(preset); setError(false); }}
                    />
                  ))}
                  <input
                    id="table-border-color"
                    data-testid="table-border-color"
                    value={borderColor}
                    onChange={(e) => { setBorderColor(e.target.value); setError(false); }}
                    style={{ width: "84px" }}
                  />
                  <input
                    type="color"
                    aria-label={t("tableFormat.borders.color")}
                    value={normalizedBorder ?? "#000000"}
                    onChange={(e) => { setBorderColor(e.target.value.toUpperCase()); setError(false); }}
                  />
                </div>
              </div>
            )}
          </div>
        )}
        {error && <p role="alert" data-testid="table-format-error">{t("stage1.invalid")}</p>}
        <div className="discard-dialog__actions">
          <button type="button" className="document-bar__button" onClick={onCancel}>{t("document.cancel")}</button>
          <button type="button" className="document-bar__button" data-testid="table-format-confirm" onClick={submit}>{t("commandInput.apply")}</button>
        </div>
      </div>
    </div>
  );
}
