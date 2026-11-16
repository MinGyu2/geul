// Stage 1 find/replace bar (non-modal). Every request goes to the active document session (`search`), whose engine
// searches its own document model; the count and current result shown here come back from the engine's snapshot.
// Replacing applies only while the engine still sees the selected text as a current match (stale results never edit).
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { commandState, type CommandContext } from "../../commands/commands";
import { MAX_REPLACE_CHARS, MAX_SEARCH_CHARS, searchTextProblem, type SearchOptions } from "../../commands/stage1";
import { useTranslation } from "../../language/LanguageContext";

export function FindBar({ context, replace, onClose }: { context: CommandContext; replace: boolean; onClose(): void }) {
  const { t } = useTranslation();
  const target = context.document;
  const snapshot = target?.snapshot() ?? null;
  const [text, setText] = useState(() => snapshot?.search?.text ?? "");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(snapshot?.search?.matchCase ?? false);
  const [wholeWord, setWholeWord] = useState(snapshot?.search?.wholeWord ?? false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, [replace]);
  const query: SearchOptions = { text, matchCase, wholeWord };
  const valid = searchTextProblem(text) === null;
  const canReplace = commandState("edit.replace", context).available && valid
    && searchTextProblem(replacement, true, MAX_REPLACE_CHARS) === null;
  const blocked = !!context.modal || !target?.search;
  const send = (request: Parameters<NonNullable<typeof target>["search"] & object>[0]) => {
    if (blocked || !target?.search) return;
    if (!target.search(request)) context.notify({ key: "find.rejected" });
  };
  const find = (backward = false) => { if (valid) send({ kind: "find", query, backward }); };
  const search = snapshot?.search ?? null;
  const sameQuery = !!search && search.text === text && search.matchCase === matchCase && search.wholeWord === wholeWord;
  const status = !valid ? "" : !sameQuery ? t("find.pending")
    : search!.count === 0 ? t("find.none")
    : t("find.count", { current: search!.current === null ? "-" : search!.current + 1, count: search!.count });
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Enter" && event.target === inputRef.current) { event.preventDefault(); find(event.shiftKey); }
  };
  const close = () => {
    if (target?.search && !context.modal) target.search({ kind: "clear" });
    onClose();
  };
  return (
    <div className="find-bar" role="search" aria-label={t(replace ? "command.edit.replace" : "command.edit.find")} onKeyDown={onKeyDown}
      data-testid="find-bar">
      <input ref={inputRef} type="text" aria-label={t("find.text")} placeholder={t("find.text")} value={text} maxLength={MAX_SEARCH_CHARS * 2}
        spellCheck={false} autoComplete="off" data-testid="find-text" onChange={(e) => setText(e.target.value)} />
      <button type="button" className="document-bar__button" disabled={blocked || !valid} onClick={() => find(true)} data-testid="find-previous">
        {t("find.previous")}
      </button>
      <button type="button" className="document-bar__button" disabled={blocked || !valid} onClick={() => find(false)} data-testid="find-next">
        {t("find.next")}
      </button>
      <label><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} data-testid="find-case" /> {t("find.matchCase")}</label>
      <label><input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} data-testid="find-word" /> {t("find.wholeWord")}</label>
      <span className="find-bar__count" role="status" aria-live="polite" data-testid="find-count">{status}</span>
      {replace && <>
        <input type="text" aria-label={t("find.replaceWith")} placeholder={t("find.replaceWith")} value={replacement}
          maxLength={MAX_REPLACE_CHARS * 2} spellCheck={false} autoComplete="off" data-testid="replace-text" onChange={(e) => setReplacement(e.target.value)} />
        <button type="button" className="document-bar__button" disabled={blocked || !canReplace || !sameQuery || search?.current == null}
          onClick={() => send({ kind: "replace", query, with: replacement })} data-testid="replace-one">{t("find.replace")}</button>
        <button type="button" className="document-bar__button" disabled={blocked || !canReplace}
          onClick={() => send({ kind: "replaceAll", query, with: replacement })} data-testid="replace-all">{t("find.replaceAll")}</button>
      </>}
      <button type="button" className="document-bar__button" onClick={close} aria-label={t("find.close")} data-testid="find-close">×</button>
    </div>
  );
}
