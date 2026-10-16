// UI 문자열 조회 경계. 화면 문자열은 모두 안정적인 키로 조회한다.
//
// 지금은 기본 언어(ko) 하나만 있다. 영어 파일, fallback, 실행 중 언어 전환과 선택 언어 복원,
// 누락 키 검사는 T005에서 이 모듈 뒤에 추가한다. 컴포넌트는 `t(key)`만 사용하므로 그때 바꿀 필요가 없다.
import ko from "./ko.json";

export type MessageKey = keyof typeof ko;
export type MessageVars = Record<string, string | number>;

const messages: Record<MessageKey, string> = ko;

export function t(key: MessageKey, vars?: MessageVars): string {
  const template = messages[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export function isMessageKey(value: string): value is MessageKey {
  return Object.prototype.hasOwnProperty.call(messages, value);
}
