// 값 입력 문서 명령(T012·T013)의 입력 창. 값의 검증은 세션과 같은 함수(src/commands/parameters.ts)이고, 확인하면 검증한 값만
// onConfirm으로 넘긴다(실행·낡은 요청 판정은 부르는 쪽). 창이 열린 동안은 명령 문맥이 모달이라 다른 명령은 실행되지 않는다.
// 초점: 열 때 입력 칸, 닫을 때 연 쪽(리본 단추 등)으로 돌려준다(NewDocumentDialog와 같은 규칙).
import { useLayoutEffect, useRef, useState } from "react";
import type { CommandInputRequest } from "../../commands/commands";
import {
  CHAR_SPACING_RANGE, CHAR_WIDTH_RANGE, MAX_COMMENT_CHARS, MAX_FORMULA_LENGTH, commentProblem, formulaProblem, formulaReadsOwnCell, parsePercent,
  validateCommandArgs,
} from "../../commands/parameters";
import type { DocumentCommandArgs } from "../../commands/target";
import type { MessageKey } from "../../language";
import { useTranslation } from "../../language/LanguageContext";

/** 0부터의 열 번호를 표 계산식의 열 글자로(A, B, …, Z, AA). */
export function columnLetters(col: number): string {
  let value = col + 1;
  let out = "";
  while (value > 0) {
    const rem = (value - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

function initialText(request: CommandInputRequest): string {
  if (request.command === "insert.table") return "2";
  const shape = request.context.charShape;
  if (request.command === "hangul.charWidth") return shape ? String(shape.width) : "100";
  if (request.command === "hangul.charSpacing") return shape ? String(shape.spacing) : "0";
  if (request.command === "hangul.insertTableFormula") return request.context.formula ?? "";
  // New comments and formulas start empty.
  return "";
}

export function CommandInputDialog({ request, onCancel, onConfirm, suspended = false }: {
  request: CommandInputRequest;
  onCancel(): void;
  onConfirm(args: DocumentCommandArgs): void;
  /** 다른 확인 창(창 닫기 등)이 모달 층을 가진 동안은 그리지 않는다(값은 유지). */
  suspended?: boolean;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(() => initialText(request));
  const [tableCols, setTableCols] = useState("2");
  const [error, setError] = useState<MessageKey | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (suspended) return;
    if (!openerRef.current && document.activeElement instanceof HTMLElement) openerRef.current = document.activeElement;
    const dialog = ref.current;
    dialog?.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected
        && (!document.activeElement || document.activeElement === document.body || dialog?.contains(document.activeElement))) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [suspended]);
  if (suspended) return null;

  const table = request.command === "insert.table";
  const formula = request.command === "hangul.tableFormula" || request.command === "hangul.insertTableFormula";
  const comment = request.command === "review.comment";
  const note = request.command === "references.footnote" || request.command === "references.endnote";
  const textual = formula || comment || note;
  const range = request.command === "hangul.charWidth" ? CHAR_WIDTH_RANGE : CHAR_SPACING_RANGE;
  const cell = request.context.tableCell;
  const submit = () => {
    let args: DocumentCommandArgs;
    if (table) {
      const rows = /^\d{1,2}$/.test(text.trim()) ? Number(text.trim()) : NaN;
      const cols = /^\d{1,2}$/.test(tableCols.trim()) ? Number(tableCols.trim()) : NaN;
      if (!Number.isSafeInteger(rows) || rows < 1 || rows > 32 || !Number.isSafeInteger(cols) || cols < 1 || cols > 16) {
        return setError("commandInput.table.dimensions");
      }
      if (rows * cols > 256) return setError("commandInput.table.tooManyCells");
      args = { command: "insert.table", rows, cols };
    } else if (comment) {
      const problem = commentProblem(text);
      if (problem) return setError(`commandInput.comment.${problem}` as MessageKey);
      args = { command: "review.comment", text: text.trim() };
    } else if (note) {
      const problem = commentProblem(text);
      if (problem) return setError(`commandInput.note.${problem}` as MessageKey);
      args = request.command === "references.endnote"
        ? { command: "references.endnote", text: text.trim() }
        : { command: "references.footnote", text: text.trim() };
    } else if (formula) {
      const problem = !cell ? "reference" : formulaProblem(text, cell)
        ?? (request.command === "hangul.insertTableFormula" && formulaReadsOwnCell(text, cell) ? "selfReference" : null);
      if (problem) return setError(`commandInput.formula.${problem}` as MessageKey);
      args = { command: request.command as "hangul.tableFormula" | "hangul.insertTableFormula", formula: text.trim() };
    } else {
      const percent = parsePercent(text);
      if (percent === null) return setError("commandInput.percent.notInteger");
      args = request.command === "hangul.charWidth"
        ? { command: "hangul.charWidth", percent }
        : { command: "hangul.charSpacing", percent };
    }
    if (!validateCommandArgs(request.command, args, request.context)) return setError("commandInput.percent.range");
    onConfirm(args);
  };
  const titleId = "command-input-title";
  const hintId = "command-input-hint";
  const errorId = "command-input-error";
  return (
    <div className="discard-dialog__backdrop" onMouseDown={event => {
      if (event.target instanceof Element && event.target.closest("button, input, label")) return;
      event.preventDefault();
    }}>
      <div ref={ref} className="discard-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
        data-testid="command-input-dialog" data-command={request.command}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") { event.preventDefault(); onCancel(); }
          if (event.key === "Enter" && event.target instanceof HTMLInputElement) { event.preventDefault(); submit(); }
          if (event.key === "Tab") {
            const controls = [...(ref.current?.querySelectorAll<HTMLElement>("input, button") ?? [])];
            const index = controls.indexOf(document.activeElement as HTMLElement);
            event.preventDefault();
            controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length]?.focus();
          }
        }}>
        <h2 id={titleId} className="discard-dialog__title">{t(request.labelKey)}</h2>
        {table ? <>
          <label style={{ display: "block" }}>
            {t("commandInput.table.rows.label")}{" "}
            <input type="text" inputMode="numeric" pattern="[0-9]*" data-testid="command-input-rows" value={text}
              maxLength={2} autoComplete="off" aria-invalid={error !== null || undefined}
              aria-describedby={error ? `${hintId} ${errorId}` : hintId}
              onChange={event => { setText(event.target.value); setError(null); }} />
          </label>
          <label style={{ display: "block" }}>
            {t("commandInput.table.cols.label")}{" "}
            <input type="text" inputMode="numeric" pattern="[0-9]*" data-testid="command-input-cols" value={tableCols}
              maxLength={2} autoComplete="off" aria-invalid={error !== null || undefined}
              aria-describedby={error ? `${hintId} ${errorId}` : hintId}
              onChange={event => { setTableCols(event.target.value); setError(null); }} />
          </label>
        </> : <label style={{ display: "block" }}>
          {t(comment ? "commandInput.comment.label" : note ? "commandInput.note.label" : formula ? "commandInput.formula.label" : "commandInput.percent.label")}{" "}
          <input
            type="text"
            inputMode={textual ? "text" : "numeric"}
            data-testid="command-input-value"
            value={text}
            maxLength={comment || note ? MAX_COMMENT_CHARS * 2 : formula ? MAX_FORMULA_LENGTH : 5}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error !== null || undefined}
            aria-describedby={error ? `${hintId} ${errorId}` : hintId}
            onChange={event => { setText(event.target.value); setError(null); }}
          />
          {!textual && <span aria-hidden="true"> %</span>}
        </label>}
        <p id={hintId} className="discard-dialog__hint">
          {table ? t("commandInput.table.hint") : comment ? t("commandInput.comment.hint") : note ? t("commandInput.note.hint") : formula && cell
            ? t((request.command === "hangul.insertTableFormula" ? "commandInput.persistentFormula.hint" : "commandInput.formula.hint"), { cell: `${columnLetters(cell.col)}${cell.row + 1}`, rows: cell.rows, cols: cell.cols })
            : t(request.command === "hangul.charWidth" ? "commandInput.charWidth.hint" : "commandInput.charSpacing.hint",
              { min: range.min, max: range.max })}
        </p>
        {error && <p id={errorId} role="alert" data-testid="command-input-error">{t(error, { min: range.min, max: range.max, length: comment || note ? MAX_COMMENT_CHARS : MAX_FORMULA_LENGTH })}</p>}
        <div className="discard-dialog__actions">
          <button type="button" className="document-bar__button" onClick={onCancel}>{t("document.cancel")}</button>
          <button type="button" className="document-bar__button" data-testid="command-input-confirm" onClick={submit}>
            {t(table ? "commandInput.table.confirm" : comment ? "commandInput.comment.confirm" : note ? "commandInput.note.confirm" : formula ? "commandInput.formula.confirm" : "commandInput.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}
