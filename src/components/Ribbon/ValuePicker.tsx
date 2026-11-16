// Stage 1 ribbon value pickers (font size, font color, highlight, list style, orientation, paper size, columns).
// The shown value is the engine's actual current value from the session snapshot (empty when mixed — never invented).
// Choosing applies only through the common command boundary (`executeCommand` with validated arguments).
import type { ChangeEvent } from "react";
import { commandState, executeCommand, type CommandContext } from "../../commands/commands";
import {
  FONT_COLORS, FONT_SIZES, HIGHLIGHT_COLORS, LIST_STYLES, MAX_COLUMNS, PAPER_NAMES, type HighlightColor, type ListStyle, type PaperName,
  type Stage1Args,
} from "../../commands/stage1";
import type { MessageKey } from "../../language";
import { useTranslation } from "../../language/LanguageContext";

export const VALUE_PICKERS = new Set([
  "format.fontSize", "format.fontColor", "format.highlight", "paragraph.listStyle", "layout.orientation", "layout.size", "layout.columns",
]);

interface Option { value: string; label: string }

export function ValuePicker({ id, labelKey, context, tabIndex }: { id: string; labelKey: MessageKey; context: CommandContext; tabIndex: number }) {
  const { t } = useTranslation();
  const state = commandState(id, context);
  const snapshot = context.document?.snapshot() ?? null;
  const chars = snapshot?.chars ?? null, page = snapshot?.page ?? null;
  let options: Option[] = [];
  let current = "";
  let toArgs: (value: string) => Stage1Args | null = () => null;
  switch (id) {
    case "format.fontSize":
      options = FONT_SIZES.map((size) => ({ value: String(size), label: String(size) }));
      current = chars?.size != null ? String(chars.size) : "";
      if (current && !options.some((o) => o.value === current)) options = [{ value: current, label: current }, ...options];
      toArgs = (v) => ({ command: "format.fontSize", size: Number(v) });
      break;
    case "format.fontColor":
      options = FONT_COLORS.map((color) => ({ value: color, label: color === "auto" ? t("stage1.color.auto") : `#${color}` }));
      current = chars?.color ?? "";
      if (current && !options.some((o) => o.value === current)) options = [{ value: current, label: `#${current}` }, ...options];
      toArgs = (v) => ({ command: "format.fontColor", color: v });
      break;
    case "format.highlight":
      options = (Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((name) => ({ value: name, label: t(`stage1.highlight.${name}` as MessageKey) }));
      current = (Object.entries(HIGHLIGHT_COLORS).find(([, rgb]) => rgb !== null && rgb === chars?.highlight)?.[0]) ?? "";
      toArgs = (v) => ({ command: "format.highlight", color: v as HighlightColor });
      break;
    case "paragraph.listStyle":
      options = LIST_STYLES.map((style) => ({ value: style, label: t(`stage1.list.${style}` as MessageKey) }));
      toArgs = (v) => ({ command: "paragraph.listStyle", style: v as ListStyle });
      break;
    case "layout.orientation":
      options = [{ value: "portrait", label: t("stage1.orientation.portrait") }, { value: "landscape", label: t("stage1.orientation.landscape") }];
      current = page ? (page.landscape ? "landscape" : "portrait") : "";
      toArgs = (v) => ({ command: "layout.orientation", landscape: v === "landscape" });
      break;
    case "layout.size":
      options = PAPER_NAMES.map((name) => ({ value: name, label: name }));
      current = page?.paper ?? "";
      toArgs = (v) => ({ command: "layout.size", name: v as PaperName });
      break;
    case "layout.columns":
      options = Array.from({ length: MAX_COLUMNS }, (_, i) => ({ value: String(i + 1), label: t("stage1.columns.count", { count: i + 1 }) }));
      current = page ? String(page.columns) : "";
      toArgs = (v) => ({ command: "layout.columns", count: Number(v), space: page?.columnSpace && page.columnSpace > 0 ? page.columnSpace : 36 });
      break;
  }
  const label = t(labelKey);
  const title = state.available ? label : `${label} — ${t(`command.reason.${state.reason}` as MessageKey)}`;
  const onChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const args = toArgs(event.target.value);
    if (args) executeCommand(id, labelKey, context, args);
  };
  return (
    <label className="value-picker" title={title} data-command={id}>
      <span className="value-picker__label">{label}</span>
      <select className="command value-picker__select" aria-label={label} value={current} tabIndex={tabIndex}
        aria-disabled={!state.available || undefined} disabled={!!context.modal || !state.available} onChange={onChange}>
        <option value="" disabled>{id === "paragraph.listStyle" ? t("stage1.list.choose") : current === "" && snapshot ? t("stage1.mixed") : ""}</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}
