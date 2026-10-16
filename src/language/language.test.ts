import { describe, expect, it, vi } from "vitest";
import en from "./en.json";
import ko from "./ko.json";
import { createTranslator, isMessageKey, placeholders, type Dictionary, type TranslationIssue } from ".";

const enKeys = Object.keys(en).sort();
const koKeys = Object.keys(ko).sort();

describe("번역 사전", () => {
  it("영어(기준) 사전과 한국어 사전의 키가 같다(누락·남는 키 없음)", () => {
    expect(koKeys.filter((key) => !isMessageKey(key))).toEqual([]);
    expect(enKeys.filter((key) => !(key in ko))).toEqual([]);
  });

  it("빈 문자열이나 공백뿐인 번역이 없다", () => {
    for (const [name, dictionary] of Object.entries({ en, ko })) {
      const blank = Object.entries(dictionary).filter(([, value]) => value.trim() === "").map(([key]) => key);
      expect(blank, name).toEqual([]);
    }
  });

  it("두 언어의 변수 자리표시자가 키마다 같다", () => {
    const mismatched = enKeys.filter(
      (key) => JSON.stringify(placeholders(en[key as keyof typeof en])) !== JSON.stringify(placeholders(ko[key as keyof typeof ko])),
    );
    expect(mismatched).toEqual([]);
  });
});

describe("createTranslator", () => {
  const dictionaries: Record<"ko" | "en", Dictionary> = {
    en: { greet: "Hello {name}", only: "English only", blank: "Blank in Korean", label: "Bold", empty: "" },
    ko: { greet: "안녕하세요, {name}님", blank: "   ", label: "굵게" },
  };

  function translator(language: "ko" | "en") {
    const issues: TranslationIssue[] = [];
    const t = createTranslator(language, dictionaries, (issue) => issues.push(issue));
    return { t: t as (key: string, vars?: Record<string, unknown>) => string, issues };
  }

  it("선택한 언어의 번역과 변수를 쓰고 한글·문장부호를 보존한다", () => {
    const { t, issues } = translator("ko");
    expect(t("greet", { name: "김·민수!" })).toBe("안녕하세요, 김·민수!님");
    expect(issues).toEqual([]);
  });

  it("한국어 번역이 없거나 공백뿐이면 영어로 대신하고 진단을 남긴다", () => {
    const { t, issues } = translator("ko");
    expect(t("only")).toBe("English only");
    expect(t("blank")).toBe("Blank in Korean");
    expect(issues).toEqual([
      { kind: "fallback", language: "ko", key: "only" },
      { kind: "fallback", language: "ko", key: "blank" },
    ]);
  });

  it("영어에도 없거나 비어 있으면 키를 보여 주고 missing 진단을 남긴다(무한 반복 없음)", () => {
    const { t, issues } = translator("ko");
    expect(t("nope")).toBe("nope");
    expect(t("empty")).toBe("empty");
    expect(issues.map((issue) => issue.kind)).toEqual(["missing", "missing"]);
  });

  it("빠진 변수는 자리표시자를 그대로 두고 진단을 남긴다", () => {
    const { t, issues } = translator("en");
    expect(t("greet", {})).toBe("Hello {name}");
    expect(issues).toEqual([{ kind: "variable", language: "en", key: "greet", name: "name" }]);
  });

  it("변수의 { key } 참조는 현재 언어로 번역하고 리터럴은 그대로 넣는다", () => {
    expect(translator("ko").t("greet", { name: { key: "label" } })).toBe("안녕하세요, 굵게님");
    expect(translator("en").t("greet", { name: { key: "label" } })).toBe("Hello Bold");
    expect(translator("en").t("greet", { name: "{label}" })).toBe("Hello {label}"); // 리터럴은 다시 해석하지 않음
  });

  it("기본 진단은 개발 빌드에서 같은 문제를 한 번만 경고한다", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = createTranslator("ko", dictionaries) as (key: string) => string;
    t("only");
    t("only");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
