// 값 입력 문서 명령(T012·T013)의 값 검증. 입력 창(화면 경계)과 편집 세션(엔진 호출 직전)이 같은 함수를 쓴다.
//
// - 장평·자간: 고정 rhwp 글자 모양 계약(`model/style.rs` CharShape — `ratios` u8 7개 "50%~200%", `spacings` i8 7개
//   "-50%~50%", HWPX `hh:ratio`·`hh:spacing`의 7개 언어 속성)의 정수 %. 범위 밖 값은 고치지 않고(말없이 자르지 않음) 거부한다:
//   rhwp `json_u8_array`·`json_i8_array`는 형식에 맞지 않는 원소를 버리고 7개가 아니면 그 변경 전체를 말없이 무시하므로, 엔진에
//   넘기기 전에 여기서 막아야 "적용했다"는 거짓 성공이 없다.
// - 표 계산식: 고정 rhwp `table_calc`(tokenizer·parser·evaluator)는 길이·괄호 깊이·범위 크기에 한도가 없다(재귀 하강 파서,
//   `A1:ZZZ999999` 범위는 좌표 목록을 다 만든다). 그래서 글자 종류·길이·괄호 깊이를 묶고, 모든 셀 참조가 지금 표 안인지 확인한다.
//   엔진의 결과 문자열은 계산 값일 뿐 표가 바뀌었다는 근거가 아니다(셀에 쓰기는 하지 않음).
import type { ActionCommandId, CommandParameterContext, DocumentCommandArgs, ParameterCommandId } from "./target";

export const CHAR_WIDTH_RANGE = { min: 50, max: 200 } as const;
export const CHAR_SPACING_RANGE = { min: -50, max: 50 } as const;
/** 표 계산식 글자 수 상한(UTF-16 단위, 허용 글자가 ASCII라 글자 수와 같음). */
export const MAX_FORMULA_LENGTH = 256;
/** 표 계산식 괄호 깊이 상한(엔진 재귀 하강 파서의 깊이를 묶음). */
export const MAX_FORMULA_DEPTH = 16;

const PARAMETER_COMMANDS: ReadonlySet<string> = new Set<ParameterCommandId>([
  "hangul.charWidth", "hangul.charSpacing", "hangul.tableFormula", "hangul.insertTableFormula", "review.comment",
  "references.footnote", "references.endnote",
]);
/** 메모 글자 수 상한(문자 단위, 백엔드 MAX_COMMENT_CHARS와 같음). */
export const MAX_COMMENT_CHARS = 1000;

/** 메모 글이 계약 안인지: 앞뒤 공백을 뺀 글이 비어 있지 않고, 문자 수 상한 이하, 제어 문자·개체 자리 글자(U+FFFC) 없음. */
export function commentProblem(text: string): "empty" | "tooLong" | "characters" | null {
  if (text.trim() === "") return "empty";
  if (Array.from(text).length > MAX_COMMENT_CHARS) return "tooLong";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\ufffc]/.test(text)) return "characters";
  return null;
}

const ACTION_COMMANDS: ReadonlySet<string> = new Set<ActionCommandId>([
  "references.toc", "references.updateToc",
  "review.trackChanges", "review.acceptChange", "review.rejectChange", "review.acceptAll", "review.rejectAll",
]);

/** 값 입력 없이 세션 문맥으로만 실행하는 명령(입력 창을 열지 않음). */
export function isActionCommandId(id: string): id is ActionCommandId {
  return ACTION_COMMANDS.has(id);
}

export function isParameterCommandId(id: string): id is ParameterCommandId {
  return PARAMETER_COMMANDS.has(id);
}

export type FormulaProblem = "empty" | "tooLong" | "characters" | "depth" | "reference" | "syntax" | "cost";

/** 열 글자(A, B, …, Z, AA)를 0부터의 번호로. 고정 rhwp `resolve_cell_ref`와 같은 셈. */
function columnIndex(letters: string): number {
  let value = 0;
  for (const ch of letters) {
    value = value * 26 + (ch.charCodeAt(0) - 64);
    if (value > 1_000_000) return Number.POSITIVE_INFINITY;
  }
  return value - 1;
}

/** At most 4096 cell visits: bounds coordinate + value vectors to roughly 128 KiB
 * (including geometric Vec growth on wasm32), with <=256 syntax characters.
 * Conservative token accounting: each colon is charged a whole table, each
 * direction a whole row/column. No competing parser or coordinate allocation.
 */
export const MAX_FORMULA_CELL_VISITS = 4096;

const DIRECTIONS = new Set(["LEFT", "RIGHT", "ABOVE", "BELOW"]);
/** 고정 rhwp `table_calc/evaluator.rs`가 아는 함수 이름(모르는 이름은 엔진 오류이므로 먼저 거부). */
const FUNCTIONS = new Set([
  "SUM", "AVG", "AVERAGE", "PRODUCT", "MIN", "MAX", "COUNT", "ABS", "SQRT", "INT", "ROUND", "CEILING", "FLOOR", "MOD",
  "SIGN", "EXP", "LOG", "LOG10", "SIN", "COS", "TAN", "ASIN", "ACOS", "ATAN", "RADIAN", "IF", "TRUNC",
]);

/** Exact grammar check; the engine independently repeats this before mutation. */
function formulaSyntax(body: string): boolean {
  const tokens: string[] = [];
  let at = 0;
  while (at < body.length) {
    if (body[at] === " ") { at += 1; continue; }
    const match = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+|[A-Za-z?][A-Za-z0-9?_]*|[()+*/,:-])/.exec(body.slice(at));
    if (!match) return false;
    tokens.push(match[0]); at += match[0].length;
  }
  let pos = 0;
  const cell = (token: string | undefined) => !!token && /^(?:[A-Za-z]+|\?)(?:[0-9]+|\?)$/.test(token);
  const take = (token: string) => tokens[pos] === token ? (pos += 1, true) : false;
  function factor(): boolean {
    const token = tokens[pos++];
    if (!token) return false;
    if (token === "-") return factor();
    if (token === "(") return expr() && take(")");
    if (/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(token)) return true;
    if (cell(token)) return !take(":") || cell(tokens[pos++]);
    if (DIRECTIONS.has(token.toUpperCase())) return true;
    if (!FUNCTIONS.has(token.toUpperCase()) || !take("(") || !expr()) return false;
    let count = 1;
    while (take(",")) { if (!expr()) return false; count += 1; }
    const name = token.toUpperCase();
    const arity = ["SUM", "AVG", "AVERAGE", "PRODUCT", "MIN", "MAX", "COUNT"].includes(name)
      || count === (name === "MOD" ? 2 : name === "IF" ? 3 : 1);
    return arity && take(")");
  }
  function term(): boolean {
    if (!factor()) return false;
    while (tokens[pos] === "*" || tokens[pos] === "/") { pos += 1; if (!factor()) return false; }
    return true;
  }
  function expr(): boolean {
    if (!term()) return false;
    while (tokens[pos] === "+" || tokens[pos] === "-") { pos += 1; if (!term()) return false; }
    return true;
  }
  return expr() && pos === tokens.length;
}

/**
 * 표 계산식이 계약 안인지. `table`은 커서가 있는 표의 크기(행·열 수)다. 문제가 없으면 null.
 * 받는 모양: 앞의 `=`·`@` 하나(선택), 숫자, 셀 참조(`A1`, `?1`, `A?`), 범위(`A1:B2`), 방향(`LEFT` 등), 함수 호출, `+ - * /`, 괄호, 쉼표, 공백.
 */
export function formulaProblem(formula: string, table: { rows: number; cols: number }): FormulaProblem | null {
  if (![table.rows, table.cols].every(n => Number.isSafeInteger(n) && n > 0 && n < 0xffffffff)) return "reference";
  const text = formula.trim();
  if (text === "" || text === "=" || text === "@") return "empty";
  if (formula.length > MAX_FORMULA_LENGTH) return "tooLong";
  const body = text.startsWith("=") || text.startsWith("@") ? text.slice(1) : text;
  if (!/^[A-Za-z0-9?_ .,:+\-*/()]+$/.test(body)) return "characters";
  let depth = 0;
  for (const ch of body) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth < 0) return "syntax";
    if (depth > MAX_FORMULA_DEPTH) return "depth";
  }
  if (depth !== 0) return "syntax";
  let visits = 0;
  const words = /[A-Za-z?][A-Za-z0-9?_]*/g;
  for (let match = words.exec(body); match; match = words.exec(body)) {
    const word = match[0].toUpperCase();
    const next = body.slice(match.index + match[0].length).trimStart()[0];
    if (next === "(") {
      if (!FUNCTIONS.has(word)) return "syntax";
      continue;
    }
    if (DIRECTIONS.has(word)) {
      visits += word === "LEFT" || word === "RIGHT" ? table.cols : table.rows;
      continue;
    }
    const ref = /^([A-Z]+|\?)([0-9]+|\?)$/.exec(word);
    if (!ref) return "syntax";
    visits += 1;
    const [, col, row] = ref;
    if (col !== "?" && !(columnIndex(col!) < table.cols)) return "reference";
    if (row !== "?") {
      const index = Number(row);
      if (!Number.isSafeInteger(index) || index < 1 || index > table.rows) return "reference";
    }
  }
  // A valid engine range has two cell tokens separated by a colon. Charging
  // every colon also overestimates malformed/trailing syntax the parser ignores.
  const ranges = (body.match(/:/g) ?? []).length;
  if (ranges > 0) {
    if (table.rows > MAX_FORMULA_CELL_VISITS / table.cols) return "cost";
    visits += ranges * table.rows * table.cols;
  }
  if (visits > MAX_FORMULA_CELL_VISITS) return "cost";
  return formulaSyntax(body) ? null : "syntax";
}

const integerIn = (value: unknown, range: { min: number; max: number }): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= range.min && value <= range.max;

/**
 * 실행 요청의 값이 그 명령의 계약에 맞는지. `context`는 세션이 지금 엔진에서 읽은 문맥이다(표 크기 등). 맞지 않으면 false —
 * 아무것도 바꾸지 않는다.
 */
export function validateCommandArgs(command: string, args: unknown, context: CommandParameterContext | undefined): args is DocumentCommandArgs {
  if (typeof args !== "object" || args === null || (args as { command?: unknown }).command !== command) return false;
  const value = args as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  switch (command) {
    case "hangul.charWidth":
      return keys === "command,percent" && integerIn(value.percent, CHAR_WIDTH_RANGE);
    case "hangul.charSpacing":
      return keys === "command,percent" && integerIn(value.percent, CHAR_SPACING_RANGE);
    // 각주·미주 글은 메모와 같은 한 줄 계약이다(백엔드 MAX_NOTE_CHARS = MAX_COMMENT_CHARS, 같은 글자 검사).
    case "review.comment":
    case "references.footnote":
    case "references.endnote":
      return keys === "command,text" && typeof value.text === "string" && commentProblem(value.text) === null;
    case "hangul.insertTableFormula":
      if (typeof value.formula !== "string" || !value.formula.trim().startsWith("=")) return false;
      // Same limits as read-only calculation; engine additionally validates full syntax and ownership.
      return keys === "command,formula" && !!context?.tableCell && formulaProblem(value.formula, context.tableCell) === null;
    case "hangul.tableFormula":
      return keys === "command,formula" && typeof value.formula === "string" && !!context?.tableCell
        && formulaProblem(value.formula, context.tableCell) === null;
    default:
      return false;
  }
}

/** 입력 창의 글자를 정수 %로 읽는다. 정수가 아니면(소수·빈 값·기호) null. */
export function parsePercent(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[+-]?\d{1,4}$/.test(trimmed)) return null;
  return Number(trimmed);
}
