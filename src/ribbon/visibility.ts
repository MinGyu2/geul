// 리본 탭의 표시 여부(T011, FR-008). 표시는 활성 문서의 형식(백엔드 SessionRegistry가 정한 SessionInfo.format)으로만 정한다.
//
// - 형식과 엔진은 다르다: rhwp는 HWP·HWPX를 함께 다루고 WordCraft는 DOCX다. 엔진 ID로 형식을 추측하지 않는다.
// - 파일 이름·확장자로 형식을 추측하지 않는다. 모르는 값이면 형식 전용 탭을 하나도 보이지 않는다(공통 탭만).
// - 표시는 실행 가능을 뜻하지 않는다. 보이는 탭의 명령도 가용성은 src/commands/(레지스트리·capability·실행 경계)가 정한다.
// - 선택 문맥(표·그림 선택)으로 여는 상황 탭은 아직 없다: 엔진 보기가 표·그림 개체 선택을 믿을 만하게 알려 주지 않고, 그런 탭에
//   둘 검증된 명령도 없다(docs/architecture/command-registry.md "T011 리본"). 관측하지 못한 선택으로 탭을 열지 않는다.
import type { DocumentFormat } from "../adapters/contract";
import { RIBBON_TABS, type RibbonTabDefinition } from "./definitions";

/** 형식 전용 탭이 가리키는 문서 묶음: "hwp"는 HWP·HWPX(한글 도구), "docx"는 DOCX. */
export type RibbonFormat = NonNullable<RibbonTabDefinition["format"]>;

const RIBBON_FORMAT: Readonly<Record<DocumentFormat, RibbonFormat>> = { hwp: "hwp", hwpx: "hwp", docx: "docx" };

/** 문서 형식의 리본 묶음. 문서가 없거나 알 수 없는 형식이면 null(공통 탭만). */
export function ribbonFormatFor(format: DocumentFormat | null | undefined): RibbonFormat | null {
  if (typeof format !== "string" || !Object.prototype.hasOwnProperty.call(RIBBON_FORMAT, format)) return null;
  return RIBBON_FORMAT[format];
}

/** 지금 보일 탭(정의 순서 유지). 공통 탭은 언제나, 형식 전용 탭은 활성 문서가 그 형식일 때만. */
export function visibleRibbonTabs(
  format: DocumentFormat | null | undefined,
  tabs: readonly RibbonTabDefinition[] = RIBBON_TABS,
): RibbonTabDefinition[] {
  const target = ribbonFormatFor(format);
  return tabs.filter((tab) => tab.format === undefined || tab.format === target);
}

/** 기본으로 고를 탭. */
export const DEFAULT_RIBBON_TAB = "home";

/**
 * 고른 탭이 보이면 그 탭, 사라졌으면(문서 전환·닫기로 형식 전용 탭이 숨음) 기본 탭, 그것도 없으면 첫 보이는 탭.
 * 보이는 탭이 없으면 null.
 */
export function resolveActiveRibbonTab(
  selectedId: string,
  visible: readonly RibbonTabDefinition[],
): RibbonTabDefinition | null {
  return visible.find((tab) => tab.id === selectedId)
    ?? visible.find((tab) => tab.id === DEFAULT_RIBBON_TAB)
    ?? visible[0]
    ?? null;
}
