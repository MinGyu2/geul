// 입력·붙여넣기 글자 → 허용한 DocxOp(T008 안정화 P1-A). 백엔드는 한 연산의 글자를 4096자(MAX_TEXT_CHARS)로 묶고 제어 문자를
// 거부하며(validate, engine.rs), 거부는 요청 전체를 InvalidRequest로 만들어 편집을 멈춘다. 그래서 보내기 전에 여기서 맞춘다:
// - 줄바꿈(CRLF·CR·LF·U+2029)은 문단 나누기 "\n" 하나로 맞춘다. 탭은 글자로 둔다(표 셀 이동 tab 연산으로 바꾸지 않음).
// - 문단 나누기·탭이 있거나 한도를 넘으면 pasteText 조각(유니코드 문자 경계, 4096자 이하)으로 나눈다. 둘째 조각부터 chain:
//   앞 조각을 엔진이 거부하면 백엔드가 건너뛴다(앞 조각 없이 뒤 조각만 들어가 내용 순서가 어긋나지 않음).
// - 그 밖의 제어 문자·U+FFFC(엔진의 개체 자리)·고립 서러게이트는 넣을 수 없다. 지우거나 바꾸지 않고 붙여넣기 전체를 넣지 않는다.
// - 붙여넣기 하나는 MAX_DOCX_PASTE_CHARS까지다(넘으면 넣지 않음).
import { MAX_DOCX_PASTE_CHARS, MAX_DOCX_TEXT_CHARS, type DocxOp } from "../../../adapters/docx";

export type TextPlan =
  | { ok: true; ops: DocxOp[] }
  | { ok: false; reason: "pasteUnsupported" | "pasteTooLarge" };

const PARAGRAPH_BREAK = /\r\n?|\u2029/g;
/** 넣을 수 없는 글자: \n·\t 밖의 제어 문자(Rust char::is_control = Cc), U+FFFC, 고립 서러게이트. */
const UNSUPPORTED = /[^\P{Cc}\n\t]|\uFFFC|\p{Cs}/u;

export function textOps(text: string): TextPlan {
  const normalized = text.replace(PARAGRAPH_BREAK, "\n");
  if (UNSUPPORTED.test(normalized)) return { ok: false, reason: "pasteUnsupported" };
  const chars = [...normalized];
  if (chars.length > MAX_DOCX_PASTE_CHARS) return { ok: false, reason: "pasteTooLarge" };
  if (chars.length <= MAX_DOCX_TEXT_CHARS && !/[\n\t]/.test(normalized)) return { ok: true, ops: [{ op: "insertText", text: normalized }] };
  const ops: DocxOp[] = [];
  for (let at = 0; at < chars.length; at += MAX_DOCX_TEXT_CHARS) {
    ops.push({ op: "pasteText", text: chars.slice(at, at + MAX_DOCX_TEXT_CHARS).join(""), chain: at > 0 });
  }
  return { ok: true, ops };
}
