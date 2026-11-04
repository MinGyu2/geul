import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DocumentFormat } from "../../adapters/contract";
import { Icon } from "../../assets/icons";
import type { CommandContext } from "../../commands/commands";
import { commandDefinition, shortcutLabel } from "../../commands/registry";
import { isMac } from "../../commands/shortcuts";
import { useRovingFocus } from "../../hooks/useRovingFocus";
import { useTranslation } from "../../language/LanguageContext";
import { DEFAULT_RIBBON_TAB, resolveActiveRibbonTab, visibleRibbonTabs } from "../../ribbon/visibility";
import { CommandButton } from "../CommandButton/CommandButton";
import { keepEditorFocusOnPointerDown } from "../CommandButton/editorFocus";

interface RibbonProps {
  context: CommandContext;
  /**
   * 활성 문서의 형식(백엔드 SessionRegistry의 SessionInfo.format 투영). 문서가 없으면 null. 형식 전용 탭(한글 도구·참조·편지)의
   * 표시만 정하고, 명령 가용성은 context(레지스트리·capability)가 정한다(T011).
   */
  format: DocumentFormat | null;
}

const PANEL_ID = "ribbon-panel";
const tabElementId = (id: string) => `ribbon-tab-${id}`;

/**
 * 공통 리본(FR-008, T011). 화면 배치만 맡는다: 명령은 CommandButton → 공통 실행 경계(executeCommand)로만 실행하고 엔진 모델을
 * 직접 바꾸지 않는다.
 *
 * - 보이는 탭은 활성 문서 형식으로 정한다(src/ribbon/visibility.ts). 고른 탭이 사라지면(문서 전환·닫기) 기본 탭으로 바꾼다.
 * - 사라진 탭이나 그 도구 모음에 초점이 있었으면 초점을 고른 탭으로 옮긴다(초점이 사라지지 않게). 초점이 리본 밖(편집 입력 등)에
 *   있었으면 건드리지 않는다.
 * - 탭·접기 단추도 명령 단추처럼 편집 입력의 초점을 포인터 누름으로 가져가지 않는다(경계 C, editorFocus.ts).
 */
export function Ribbon({ context, format }: RibbonProps) {
  const { t } = useTranslation();
  const { layout, dispatch } = context;
  const collapsed = layout.ribbonCollapsed;
  const [selectedId, setSelectedId] = useState(DEFAULT_RIBBON_TAB);
  const visible = useMemo(() => visibleRibbonTabs(format), [format]);
  // 공통 탭은 언제나 보이므로 null이 아니다(정의 시험).
  const active = resolveActiveRibbonTab(selectedId, visible)!;
  // 고른 탭이 사라졌으면 대신 보인 탭을 고른 것으로 둔다(형식이 돌아와도 사용자가 다시 고르기 전에는 바꾸지 않음).
  if (active.id !== selectedId) setSelectedId(active.id);
  const sectionRef = useRef<HTMLElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  /** 리본 안에 초점이 있음(사라진 요소의 초점은 blur 없이 사라지므로 마지막 상태를 기억한다). */
  const focusInside = useRef(false);

  const onTabKeyDown = useRovingFocus('[role="tab"]', "horizontal", (element) => {
    if (element.dataset.tabId) setSelectedId(element.dataset.tabId);
  });
  const onToolbarKeyDown = useRovingFocus(".command", "horizontal");

  // 리본 안에 초점이 있는 상태에서 접히면 초점이 사라지므로 접기 버튼으로 옮긴다.
  useLayoutEffect(() => {
    if (collapsed && (document.activeElement === document.body || document.activeElement === null)) {
      collapseRef.current?.focus();
    }
  }, [collapsed]);

  // 탭이 사라지며 초점도 사라졌으면(리본 안에 있던 초점만) 지금 고른 탭으로 옮긴다.
  const visibleKey = visible.map((tab) => tab.id).join(" ");
  useLayoutEffect(() => {
    if (!focusInside.current) return;
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body && focused.isConnected) return;
    sectionRef.current?.querySelector<HTMLElement>(`#${tabElementId(active.id)}`)?.focus();
  }, [active.id, visibleKey]);

  const selectTab = (id: string) => {
    setSelectedId(id);
    if (collapsed) dispatch({ type: "setRibbonCollapsed", collapsed: false });
  };

  const ribbonShortcut = commandDefinition("view.ribbon")?.shortcuts?.[0];
  const collapseLabel = collapsed ? t("ribbon.expand") : t("ribbon.collapse");

  return (
    <section
      ref={sectionRef}
      className={`ribbon${collapsed ? " ribbon--collapsed" : ""}`}
      aria-label={t("ribbon.label")}
      data-ribbon-format={format ?? "none"}
      onFocus={() => {
        focusInside.current = true;
      }}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) focusInside.current = false;
      }}
    >
      <div className="ribbon__bar">
        <div className="ribbon__tabs" role="tablist" aria-label={t("ribbon.tabs")} onKeyDown={onTabKeyDown}>
          {visible.map((tab) => {
            const selected = tab.id === active.id;
            return (
              <button
                key={tab.id}
                id={tabElementId(tab.id)}
                type="button"
                role="tab"
                data-tab-id={tab.id}
                className="ribbon__tab"
                aria-selected={selected}
                aria-controls={collapsed || !selected ? undefined : PANEL_ID}
                tabIndex={selected ? 0 : -1}
                onMouseDown={keepEditorFocusOnPointerDown}
                onClick={() => selectTab(tab.id)}
              >
                {t(tab.labelKey)}
              </button>
            );
          })}
        </div>
        <button
          ref={collapseRef}
          type="button"
          className="command command--icon ribbon__collapse"
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : PANEL_ID}
          aria-label={collapseLabel}
          title={ribbonShortcut ? `${collapseLabel} (${shortcutLabel(ribbonShortcut, isMac())})` : collapseLabel}
          onMouseDown={keepEditorFocusOnPointerDown}
          onClick={() => dispatch({ type: "toggleRibbon" })}
        >
          <Icon name={collapsed ? "chevronDown" : "chevronUp"} />
        </button>
      </div>
      {!collapsed && (
        <div id={PANEL_ID} className="ribbon__panel" role="tabpanel" aria-labelledby={tabElementId(active.id)}>
          <div
            key={active.id}
            className="ribbon__toolbar"
            role="toolbar"
            aria-label={t(active.labelKey)}
            onKeyDown={onToolbarKeyDown}
          >
            {active.groups.map((group, groupIndex) => (
              <div key={group.id} className="ribbon__group" role="group" aria-label={t(group.labelKey)}>
                <div className="ribbon__group-commands">
                  {group.commands.map((command, commandIndex) => (
                    <CommandButton
                      key={command.id}
                      id={command.id}
                      labelKey={command.labelKey}
                      icon={command.icon}
                      variant={command.size ?? "small"}
                      context={context}
                      tabIndex={groupIndex === 0 && commandIndex === 0 ? 0 : -1}
                    />
                  ))}
                </div>
                <div className="ribbon__group-label" aria-hidden="true">{t(group.labelKey)}</div>
              </div>
            ))}
          </div>
          {active.format && (
            <p className="ribbon__note">
              {t(active.format === "hwp" ? "ribbon.formatOnly.hwp" : "ribbon.formatOnly.docx")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
