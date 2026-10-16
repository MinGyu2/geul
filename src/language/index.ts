// UI 문자열 조회 경계(FR-002). 화면 문자열은 모두 안정적인 키로 조회한다.
//
// - en.json이 기준(canonical) 사전이다. 키 목록(MessageKey)은 en.json에서 만들어 컴파일 시점에 검사한다.
// - 선택한 언어에 번역이 없거나 비어 있으면 영어로 대신한다. 영어에도 없으면 키 자체를 보여 주고 진단을 남긴다.
// - 컴포넌트는 언어 컨텍스트의 `useTranslation()`으로 받은 `t`를 쓴다. 언어가 바뀌면 다시 그려진다.
// - 상태에는 번역된 문자열이 아니라 `Message`(키 + 변수)를 저장하고, 그릴 때 번역한다.
import en from "./en.json";
import ko from "./ko.json";

export type MessageKey = keyof typeof en;
export type Language = "ko" | "en";
export type Dictionary = Partial<Record<string, string>>;

/** 변수 값: 문자열·숫자는 그대로 쓰는 리터럴, `{ key }`는 현재 언어로 번역해 넣는 참조. */
export type MessageVar = string | number | { key: MessageKey };
export type MessageVars = Record<string, MessageVar>;

/** 번역할 메시지. 상태에 저장해 두었다가 그릴 때 현재 언어로 바꾼다. */
export interface Message {
  key: MessageKey;
  vars?: MessageVars;
}

export const DEFAULT_LANGUAGE: Language = "ko";
export const FALLBACK_LANGUAGE: Language = "en";

/** 언어 선택 목록. 이름은 각 언어 자체 표기로 보여 준다(번역하지 않음). */
export const LANGUAGES: readonly { code: Language; nativeName: string }[] = [
  { code: "ko", nativeName: "한국어" },
  { code: "en", nativeName: "English" },
];

export const DICTIONARIES: Record<Language, Dictionary> = { ko, en };

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((language) => language.code === value);
}

export function isMessageKey(value: string): value is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, value);
}

export type TranslationIssue =
  | { kind: "fallback"; language: Language; key: string }
  | { kind: "missing"; key: string }
  | { kind: "variable"; language: Language; key: string; name: string };

export type Translate = (key: MessageKey, vars?: MessageVars) => string;

const PLACEHOLDER = /\{(\w+)\}/g;

function usable(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * 사전과 진단 함수로 번역 함수를 만든다. 순수 함수라 테스트에서 사전을 바꿔 끼울 수 있다.
 * 변수 안의 `{ key }` 참조는 한 단계만 번역한다(재귀 없음).
 */
export function createTranslator(
  language: Language,
  dictionaries: Record<Language, Dictionary> = DICTIONARIES,
  report: (issue: TranslationIssue) => void = reportIssue,
): Translate {
  const lookup = (key: string): string => {
    const own = dictionaries[language][key];
    if (usable(own)) return own;
    const fallback = dictionaries[FALLBACK_LANGUAGE][key];
    if (usable(fallback)) {
      if (language !== FALLBACK_LANGUAGE) report({ kind: "fallback", language, key });
      return fallback;
    }
    report({ kind: "missing", key });
    return key;
  };
  return (key, vars) => {
    const template = lookup(key);
    if (!vars) return template;
    return template.replace(PLACEHOLDER, (match, name: string) => {
      if (!(name in vars)) {
        report({ kind: "variable", language, key, name });
        return match;
      }
      const value = vars[name]!;
      return typeof value === "object" ? lookup(value.key) : String(value);
    });
  };
}

export function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]!).sort();
}

const reported = new Set<string>();

/** 기본 진단: 개발 빌드에서만 같은 문제를 한 번씩 콘솔에 알린다. */
function reportIssue(issue: TranslationIssue): void {
  if (!import.meta.env.DEV) return;
  const id = JSON.stringify(issue);
  if (reported.has(id)) return;
  reported.add(id);
  console.warn(`[i18n] ${issue.kind}: ${JSON.stringify(issue)}`);
}
