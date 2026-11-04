import { useLayoutEffect, useRef, useState } from "react";
import type { DocumentFormat } from "../../adapters/contract";
import { useTranslation } from "../../language/LanguageContext";

const FORMATS = ["docx", "hwp", "hwpx"] as const;

export function NewDocumentDialog({ onChoose, suspended = false }: {
  onChoose(format: DocumentFormat | null): void;
  /** Window-close confirmation owns the modal layer without losing this choice. */
  suspended?: boolean;
}) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<DocumentFormat>("docx");
  const ref = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (suspended) return;
    if (!openerRef.current && document.activeElement instanceof HTMLElement) openerRef.current = document.activeElement;
    const dialog = ref.current;
    ref.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected
        && (!document.activeElement || document.activeElement === document.body || dialog?.contains(document.activeElement))) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [suspended]);
  if (suspended) return null;
  return (
    <div className="discard-dialog__backdrop" onMouseDown={event => {
      if (event.target instanceof Element && event.target.closest("button, input, label")) return;
      event.preventDefault();
    }}>
      <div ref={ref} className="discard-dialog" role="dialog" aria-modal="true" aria-labelledby="new-document-title"
        data-testid="new-document-dialog" onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); onChoose(null); }
          if (event.key === "Tab") {
            const controls = [...(ref.current?.querySelectorAll<HTMLElement>("input:checked, button") ?? [])];
            const index = controls.indexOf(document.activeElement as HTMLElement);
            event.preventDefault();
            controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length]?.focus();
          }
          if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key) && event.target instanceof HTMLInputElement) {
            event.preventDefault();
            const next = FORMATS[(FORMATS.indexOf(format) + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : 2)) % 3]!;
            setFormat(next);
            ref.current?.querySelector<HTMLInputElement>(`input[value='${next}']`)?.focus();
          }
        }}>
        <h2 id="new-document-title" className="discard-dialog__title">{t("document.newTitle")}</h2>
        <fieldset>
          <legend>{t("document.formatLabel")}</legend>
          {FORMATS.map(value => <label key={value} style={{ display: "block" }}>
            <input type="radio" name="new-document-format" value={value} checked={format === value}
              onChange={() => setFormat(value)} /> {t(`document.format.${value}`)}
          </label>)}
        </fieldset>
        <div className="discard-dialog__actions">
          <button type="button" className="document-bar__button" onClick={() => onChoose(null)}>{t("document.cancel")}</button>
          <button type="button" className="document-bar__button" data-testid="new-document-next" onClick={() => onChoose(format)}>{t("document.chooseDestination")}</button>
        </div>
      </div>
    </div>
  );
}
