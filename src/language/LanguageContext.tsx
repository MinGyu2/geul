import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createTranslator, DEFAULT_LANGUAGE, type Language, type Message, type Translate } from ".";

interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: Translate;
  /** 저장해 둔 Message를 현재 언어로 그린다. */
  format: (message: Message) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

interface LanguageProviderProps {
  language: Language;
  onLanguageChange: (language: Language) => void;
  children: ReactNode;
}

/**
 * 언어 값은 App이 소유한다(설정 저장과 같은 곳). 이 provider는 그 값으로 번역 함수를 만들어 내려 주며,
 * 값이 바뀌면 이 함수를 쓰는 모든 컴포넌트가 다시 그려진다.
 */
export function LanguageProvider({ language, onLanguageChange, children }: LanguageProviderProps) {
  const value = useMemo<LanguageContextValue>(() => {
    const t = createTranslator(language);
    return { language, setLanguage: onLanguageChange, t, format: (message) => t(message.key, message.vars) };
  }, [language, onLanguageChange]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useTranslation(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) throw new Error(`useTranslation()은 LanguageProvider 안에서만 쓸 수 있습니다 (기본 언어 ${DEFAULT_LANGUAGE})`);
  return value;
}
