import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { displayName, type FontFamily, type FontSource } from "../../adapters/fonts";
import { Icon } from "../../assets/icons";
import { commandState, executeCommand, type CommandContext } from "../../commands/commands";
import { useTranslation } from "../../language/LanguageContext";
import type { MessageKey } from "../../language";

/** Most options rendered at once (the list filters as the user types). */
const MAX_OPTIONS = 300;
type FontGroup = { kind: "catalog"; source: FontSource; labelKey: MessageKey } | { kind: "document"; labelKey: MessageKey };
type PickerOption = { kind: "catalog"; font: FontFamily } | { kind: "document"; family: string };
const GROUPS: readonly FontGroup[] = [
  { kind: "catalog", source: "user", labelKey: "font.userFonts" },
  { kind: "catalog", source: "system", labelKey: "font.systemFonts" },
  { kind: "catalog", source: "bundled", labelKey: "font.bundledFonts" },
  { kind: "document", labelKey: "font.documentFonts" },
];

interface FontPickerProps {
  context: CommandContext;
  tabIndex: number;
}

/**
 * Stage 5-A font picker (ARIA combobox + listbox). Shows the selection's stored font (or "mixed"), lists system, user and
 * bundled fonts from the shared catalog, filters by family or localized name, and applies a family only through the common
 * `format.font` command (availability, session ownership and engine checks are the command layer's). Browsing never edits.
 * Also adds, removes (user fonts only) and refreshes fonts.
 */
export function FontPicker({ context, tabIndex }: FontPickerProps) {
  const { t, language } = useTranslation();
  const fonts = context.fonts;
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const state = commandState("format.font", context);
  // A dialog blocks the whole picker (browsing included), like every ribbon command.
  const blocked = !!context.modal;
  // Same title form as CommandButton: "Font — <reason>".
  const title = state.available ? t("font.label") : `${t("font.label")} — ${t(`command.reason.${state.reason}` as MessageKey)}`;
  const snapshot = context.document?.snapshot() ?? null;
  const current = snapshot?.font ?? null;
  const shown = current === null ? "" : current.family ?? "";
  const catalog = fonts?.catalog ?? null;
  const documentFamilies = snapshot?.font?.documentFamilies ?? [];

  const options = useMemo(() => {
    const q = (query ?? "").trim().toLowerCase();
    const match = (family: string) => q === "" || family.toLowerCase().includes(q);
    const out: PickerOption[] = [];
    const availableFamilies = new Set((catalog?.families ?? []).filter((f) => f.available).map((f) => f.family));
    for (const group of GROUPS) {
      if (group.kind === "catalog") {
        for (const font of catalog?.families ?? []) {
          if (font.source === group.source && font.available
            && (match(font.family) || font.localized.some((l) => l.name.toLowerCase().includes(q)))) out.push({ kind: "catalog", font });
          if (out.length >= MAX_OPTIONS) return out;
        }
      } else {
        for (const family of documentFamilies.slice(0, MAX_OPTIONS)) {
          if (!availableFamilies.has(family) && match(family)) out.push({ kind: "document", family });
          if (out.length >= MAX_OPTIONS) return out;
        }
      }
    }
    return out;
  }, [catalog, documentFamilies, query]);

  const close = () => { setOpen(false); setQuery(null); };
  const choose = (family: string) => {
    close();
    executeCommand("format.font", "command.format.font", context, { command: "format.font", family });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    // Left/Right edit the text; at the ends they move to the neighbouring ribbon command (roving focus).
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
      const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
      const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
      if (!((event.key === "ArrowLeft" && atStart) || (event.key === "ArrowRight" && atEnd))) event.stopPropagation();
      return;
    }
    if (blocked) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!open) { setOpen(true); setActive(0); return; }
      setActive((i) => Math.max(0, Math.min(options.length - 1, i + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = options[active];
      if (open && option) choose(option.kind === "catalog" ? option.font.family : option.family);
      else setOpen(true);
    } else if (event.key === "Escape") {
      if (open) { event.preventDefault(); event.stopPropagation(); close(); }
    }
  };

  const optionId = (i: number) => `${listId}-o${i}`;
  return (
    <div className="font-picker" onBlur={(event) => {
      if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) close();
    }}>
      <input
        ref={inputRef}
        className="command font-picker__input"
        role="combobox"
        aria-label={t("font.label")}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? optionId(active) : undefined}
        aria-disabled={!fonts || blocked || undefined}
        readOnly={blocked}
        title={title}
        placeholder={current && current.family === null ? t("font.mixed") : t("font.search")}
        value={query ?? shown}
        tabIndex={tabIndex}
        onChange={(event) => { if (blocked) return; setQuery(event.target.value); setOpen(true); setActive(0); }}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={onKeyDown}
        data-font-current={shown}
      />
      <button type="button" className="font-picker__toggle" tabIndex={-1} aria-label={t("font.openList")}
        aria-disabled={blocked || undefined} title={title} data-command="format.font"
        onClick={() => { if (blocked) return; setOpen((o) => !o); inputRef.current?.focus(); }}>
        <Icon name="chevronDown" />
      </button>
      {open && !blocked && (
        <div className="font-picker__popup">
          <ul id={listId} role="listbox" aria-label={t("font.list")} className="font-picker__list">
            {!fonts?.catalog && <li role="presentation" className="font-picker__note">{t("font.loading")}</li>}
            {fonts?.catalog && options.length === 0 && <li role="presentation" className="font-picker__note">{t("font.noMatch", { query: query ?? "" })}</li>}
            {GROUPS.map((group) => {
              const members = options.filter((option) => group.kind === "catalog"
                ? option.kind === "catalog" && option.font.source === group.source
                : option.kind === "document");
              if (members.length === 0) return null;
              return [
                <li key={`h-${group.kind === "catalog" ? group.source : "document"}`} role="presentation" className="font-picker__heading">{t(group.labelKey)}</li>,
                ...members.map((option) => {
                  const i = options.indexOf(option);
                  const font = option.kind === "catalog" ? option.font : null;
                  const family = option.kind === "catalog" ? option.font.family : option.family;
                  const id = font?.id ?? `document:${family}`;
                  const name = font ? displayName(font, language) : family;
                  return (
                    <li key={id} id={optionId(i)} role="option" aria-selected={i === active}
                      className={`font-picker__option${i === active ? " font-picker__option--active" : ""}`}
                      data-font-id={id}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(family)}>
                      <span className="font-picker__name" style={{ fontFamily: `"${family.replace(/"/g, "")}"` }}>{name}</span>
                      {font && name !== family && <span className="font-picker__alt">{family}</span>}
                      {font && font.styles.length > 1 && <span className="font-picker__meta">{t("font.styles", { count: font.styles.length })}</span>}
                      {(!font || !font.renderable) && <span className="font-picker__meta">{t("font.unavailable")}</span>}
                    </li>
                  );
                }),
              ];
            })}
          </ul>
          <div className="font-picker__actions" role="group" aria-label={t("font.userFonts")}>
            <button type="button" className="font-picker__action" disabled={!fonts || fonts.busy} onClick={() => { close(); void fonts?.register(); }}>
              {t("font.add")}
            </button>
            <button type="button" className="font-picker__action" disabled={!fonts || fonts.busy} onClick={() => { close(); void fonts?.refresh(); }}>
              {t("font.refresh")}
            </button>
            {(fonts?.catalog?.userFonts ?? []).flatMap((file) => file.families).map((family) => (
              <button key={family} type="button" className="font-picker__action font-picker__remove" disabled={!fonts || fonts.busy}
                aria-label={t("font.removeFamily", { family })} onClick={() => { close(); void fonts?.remove(family); }}>
                {t("font.remove")}: {family}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
