// Stage 1 F: document font embedding dialog. The user picks a family and style from the shared font catalog (the
// same faces the font picker offers; nothing is embedded automatically). The dialog shows the backend's embedding
// verdict for that face: license permission (OS/2 fsType), license text and the per-format result. "Embed" runs the
// active session's executeEmbedFont, which resolves only after the document model holds the resource.
import { useEffect, useMemo, useRef, useState } from "react";
import type { FontCatalog, FontEmbedInfo } from "../../adapters/fonts";
import type { DocumentCommandTarget } from "../../commands/target";
import type { Message, MessageKey } from "../../language";
import { useTranslation } from "../../language/LanguageContext";
import { embedFontInfo } from "../../fonts/embedding";

interface Props {
  target: DocumentCommandTarget;
  /** The document's format: decides which per-format verdict applies. */
  format: "docx" | "hwp" | "hwpx";
  catalog: FontCatalog | null;
  /** The selection's family, if any (initial choice). */
  initialFamily: string | null;
  suspended: boolean;
  notify: (message: Message) => void;
  onClose: () => void;
}

const regular = (styles: { name: string }[]) => styles.find((s) => /^regular$/i.test(s.name))?.name ?? styles[0]?.name ?? "";

export function EmbedFontDialog({ target, format, catalog, initialFamily, suspended, notify, onClose }: Props) {
  const { t } = useTranslation();
  const families = useMemo(() => (catalog?.families ?? []).filter((f) => f.available && f.styles.length > 0), [catalog]);
  const [family, setFamily] = useState(() => families.find((f) => f.family === initialFamily)?.family ?? families[0]?.family ?? "");
  const styles = useMemo(() => families.find((f) => f.family === family)?.styles ?? [], [families, family]);
  const [style, setStyle] = useState(() => regular(styles));
  const [answer, setAnswer] = useState<{ key: string; info: FontEmbedInfo } | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector("select")?.focus(); }, []);
  const chosen = styles.some((s) => s.name === style) ? style : regular(styles);
  // The verdict belongs to the exact face it was asked for; a stale answer is never shown for another choice.
  const key = `${family}\u0000${chosen}`;
  useEffect(() => {
    let live = true;
    if (!family || !chosen) return;
    void embedFontInfo(family, chosen).then((r) => { if (live && r?.ok) setAnswer({ key: `${family}\u0000${chosen}`, info: r.value }); });
    return () => { live = false; };
  }, [family, chosen]);
  const info = answer?.key === key ? answer.info : null;
  const verdict = info ? info[format] : null;
  const embedded = target.snapshot().embeddedFonts ?? [];
  const submit = async () => {
    if (!info || verdict !== null || busy || !target.executeEmbedFont) return;
    setBusy(true);
    const result = await target.executeEmbedFont(family, chosen);
    setBusy(false);
    notify({ key: `embedFont.${result}` as MessageKey, vars: { family } });
    if (result === "embedded" || result === "unchanged") onClose();
  };
  return (
    <div className="discard-dialog__backdrop" onMouseDown={(event) => {
      if (event.target instanceof Element && event.target.closest("button, input, label, select")) return;
      event.preventDefault();
    }}>
      <div ref={ref} className="discard-dialog" role="dialog" aria-modal="true" aria-labelledby="embed-font-title" data-testid="embed-font-dialog"
        aria-hidden={suspended || undefined}
        onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); onClose(); } }}>
        <h2 id="embed-font-title" className="discard-dialog__title">{t("embedFont.title")}</h2>
        <div className="stage1-dialog__grid">
          <label htmlFor="embed-font-family">{t("embedFont.family")}</label>
          <select id="embed-font-family" data-testid="embed-font-family" value={family} onChange={(e) => setFamily(e.target.value)}>
            {families.map((f) => <option key={f.id} value={f.family}>{f.family}</option>)}
          </select>
          <label htmlFor="embed-font-style">{t("embedFont.style")}</label>
          <select id="embed-font-style" data-testid="embed-font-style" value={chosen} onChange={(e) => setStyle(e.target.value)}>
            {styles.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </div>
        <div className="embed-font__info" data-testid="embed-font-info" aria-live="polite">
          {!info ? <p>{t("embedFont.checking")}</p> : <>
            {info.program && <p data-testid="embed-font-permission">{t("embedFont.permission")}: {t(`embedFont.permission.${info.program.permission}` as MessageKey)}
              {` (0x${info.program.fsType.toString(16).padStart(4, "0")})`}</p>}
            {info.program?.license && <p><strong>{t("embedFont.license")}:</strong> {info.program.license.slice(0, 600)}</p>}
            {verdict && <p role="alert" data-testid="embed-font-refusal">{t(`embedFont.refusal.${verdict}` as MessageKey)}</p>}
            <p className="embed-font__notice">{t("embedFont.licenseNotice")}</p>
          </>}
          {embedded.length > 0 && <p data-testid="embed-font-present">{t("embedFont.present")}: {[...new Set(embedded.map((e) => e.family))].join(", ")}</p>}
        </div>
        <div className="discard-dialog__actions">
          <button type="button" className="document-bar__button" onClick={onClose}>{t("embedFont.cancel")}</button>
          <button type="button" className="document-bar__button" data-testid="embed-font-confirm" disabled={!info || verdict !== null || busy}
            onClick={() => void submit()}>{t("embedFont.embed")}</button>
        </div>
      </div>
    </div>
  );
}
