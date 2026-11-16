// Stage 1 value dialogs: paragraph formatting (line spacing, spacing before/after, left/right/first-line/hanging
// indents) and page margins. Initial values are the engine's current values from the request context (empty when
// mixed: an empty field is left unchanged). Values are validated by the shared `validStage1Args`; the session
// validates again before queueing. Lengths are entered in millimetres (points for spacing) and stored natively.
import { useLayoutEffect, useRef, useState } from "react";
import type { CommandInputRequest } from "../../commands/commands";
import { fromMm, toMm, validStage1Args, type ParagraphFormatArgs, type Stage1Args } from "../../commands/stage1";
import type { DocumentCommandArgs } from "../../commands/target";
import type { MessageKey } from "../../language";
import { useTranslation } from "../../language/LanguageContext";

type Fields = Record<string, string>;
const text = (value: number | null | undefined, convert: (v: number) => number = (v) => v) =>
  value === null || value === undefined ? "" : String(Math.round(convert(value) * 100) / 100);

function initial(request: CommandInputRequest): Fields {
  const { paragraph, page } = request.context;
  if (request.command === "layout.margins") {
    return {
      top: text(page?.marginTop, toMm), bottom: text(page?.marginBottom, toMm),
      left: text(page?.marginLeft, toMm), right: text(page?.marginRight, toMm),
    };
  }
  const first = paragraph?.indentFirst ?? null;
  return {
    rule: paragraph?.lineSpacing?.rule ?? "", line: text(paragraph?.lineSpacing?.value),
    before: text(paragraph?.spaceBefore), after: text(paragraph?.spaceAfter),
    left: text(paragraph?.indentLeft, toMm), right: text(paragraph?.indentRight, toMm),
    special: first === null ? "" : first < 0 ? "hanging" : first > 0 ? "firstLine" : "none",
    by: first === null ? "" : text(Math.abs(first), toMm),
  };
}

/** Parses an optional decimal ("" → undefined, invalid → NaN so validation fails). */
const number = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
};

export function buildStage1Args(command: string, fields: Fields): Stage1Args | null {
  if (command === "layout.margins") {
    const [top, bottom, left, right] = ["top", "bottom", "left", "right"].map((k) => number(fields[k] ?? ""));
    if ([top, bottom, left, right].some((v) => v === undefined || Number.isNaN(v))) return null;
    const args = { command: "layout.margins", top: fromMm(top!), bottom: fromMm(bottom!), left: fromMm(left!), right: fromMm(right!) } as const;
    return validStage1Args(command, { ...args }) ? args : null;
  }
  if (command !== "paragraph.settings") return null;
  const format: ParagraphFormatArgs = {};
  const line = number(fields.line ?? "");
  if (fields.rule && line !== undefined) format.lineSpacing = { rule: fields.rule as "multiple" | "atLeast" | "exactly", value: line };
  else if (fields.rule && line === undefined) return null;
  const set = (key: keyof ParagraphFormatArgs, value: number | undefined, convert = (v: number) => v) => {
    if (value !== undefined) (format as Record<string, number>)[key] = Number.isNaN(value) ? Number.NaN : convert(value);
  };
  set("spaceBefore", number(fields.before ?? ""));
  set("spaceAfter", number(fields.after ?? ""));
  set("indentLeft", number(fields.left ?? ""), fromMm);
  set("indentRight", number(fields.right ?? ""), fromMm);
  if (fields.special === "none") format.indentFirst = 0;
  else if (fields.special === "firstLine" || fields.special === "hanging") {
    const by = number(fields.by ?? "");
    if (by === undefined || Number.isNaN(by) || by < 0) return null;
    format.indentFirst = fields.special === "hanging" ? -fromMm(by) : fromMm(by);
  }
  const args = { command: "paragraph.settings", format } as const;
  return validStage1Args(command, { ...args }) ? args : null;
}

export function Stage1Dialog({ request, onCancel, onConfirm, suspended = false }: {
  request: CommandInputRequest;
  onCancel(): void;
  onConfirm(args: DocumentCommandArgs): void;
  suspended?: boolean;
}) {
  const { t } = useTranslation();
  const [fields, setFields] = useState(() => initial(request));
  const [error, setError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (suspended) return;
    if (!openerRef.current && document.activeElement instanceof HTMLElement) openerRef.current = document.activeElement;
    const dialog = ref.current;
    dialog?.querySelector<HTMLElement>("input, select")?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body || dialog?.contains(document.activeElement)))
        opener.focus({ preventScroll: true });
    };
  }, [suspended]);
  if (suspended) return null;
  const set = (key: string) => (event: { target: { value: string } }) => { setFields((f) => ({ ...f, [key]: event.target.value })); setError(false); };
  const submit = () => {
    const args = buildStage1Args(request.command, fields);
    if (!args) return setError(true);
    onConfirm(args);
  };
  const input = (key: string, labelKey: MessageKey) => (
    <>
      <label htmlFor={`stage1-${key}`}>{t(labelKey)}</label>
      <input id={`stage1-${key}`} type="text" inputMode="decimal" autoComplete="off" value={fields[key] ?? ""}
        data-testid={`stage1-${key}`} onChange={set(key)} aria-invalid={error || undefined} />
    </>
  );
  const margins = request.command === "layout.margins";
  return (
    <div className="discard-dialog__backdrop" onMouseDown={(event) => {
      if (event.target instanceof Element && event.target.closest("button, input, label, select")) return;
      event.preventDefault();
    }}>
      <div ref={ref} className="discard-dialog" role="dialog" aria-modal="true" aria-labelledby="stage1-dialog-title"
        data-testid="stage1-dialog" data-command={request.command}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") { event.preventDefault(); onCancel(); }
          if (event.key === "Enter" && event.target instanceof HTMLInputElement) { event.preventDefault(); submit(); }
        }}>
        <h2 id="stage1-dialog-title" className="discard-dialog__title">{t(request.labelKey)}</h2>
        <div className="stage1-dialog__grid">
          {margins ? <>
            {input("top", "stage1.margin.top")}
            {input("bottom", "stage1.margin.bottom")}
            {input("left", "stage1.margin.left")}
            {input("right", "stage1.margin.right")}
          </> : <>
            <label htmlFor="stage1-rule">{t("stage1.lineSpacing")}</label>
            <select id="stage1-rule" value={fields.rule ?? ""} onChange={set("rule")} data-testid="stage1-rule">
              <option value="">{t("stage1.unchanged")}</option>
              <option value="multiple">{t("stage1.lineSpacing.multiple")}</option>
              <option value="atLeast">{t("stage1.lineSpacing.atLeast")}</option>
              <option value="exactly">{t("stage1.lineSpacing.exactly")}</option>
            </select>
            {input("line", "stage1.lineSpacing.value")}
            {input("before", "stage1.spaceBefore")}
            {input("after", "stage1.spaceAfter")}
            {input("left", "stage1.indentLeft")}
            {input("right", "stage1.indentRight")}
            <label htmlFor="stage1-special">{t("stage1.special")}</label>
            <select id="stage1-special" value={fields.special ?? ""} onChange={set("special")} data-testid="stage1-special">
              <option value="">{t("stage1.unchanged")}</option>
              <option value="none">{t("stage1.special.none")}</option>
              <option value="firstLine">{t("stage1.special.firstLine")}</option>
              <option value="hanging">{t("stage1.special.hanging")}</option>
            </select>
            {input("by", "stage1.special.by")}
          </>}
        </div>
        <p className="discard-dialog__hint">{t(margins ? "stage1.margin.hint" : "stage1.paragraph.hint")}</p>
        {error && <p role="alert" data-testid="stage1-error">{t("stage1.invalid")}</p>}
        <div className="discard-dialog__actions">
          <button type="button" className="document-bar__button" onClick={onCancel}>{t("document.cancel")}</button>
          <button type="button" className="document-bar__button" data-testid="stage1-confirm" onClick={submit}>{t("commandInput.apply")}</button>
        </div>
      </div>
    </div>
  );
}
