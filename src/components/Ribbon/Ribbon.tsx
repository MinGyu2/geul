import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../assets/icons";
import type { CommandContext } from "../../commands/commands";
import { useRovingFocus } from "../../hooks/useRovingFocus";
import { useTranslation } from "../../language/LanguageContext";
import { RIBBON_TABS } from "../../ribbon/definitions";
import { CommandButton } from "../CommandButton/CommandButton";

interface RibbonProps {
  context: CommandContext;
}

const PANEL_ID = "ribbon-panel";

export function Ribbon({ context }: RibbonProps) {
  const { t } = useTranslation();
  const { layout, dispatch } = context;
  const collapsed = layout.ribbonCollapsed;
  const [activeId, setActiveId] = useState("home");
  const active = RIBBON_TABS.find((tab) => tab.id === activeId) ?? RIBBON_TABS[0]!;
  const collapseRef = useRef<HTMLButtonElement>(null);

  const onTabKeyDown = useRovingFocus('[role="tab"]', "horizontal", (element) => {
    if (element.dataset.tabId) setActiveId(element.dataset.tabId);
  });
  const onToolbarKeyDown = useRovingFocus(".command", "horizontal");

  // 리본 안에 초점이 있는 상태에서 접히면 초점이 사라지므로 접기 버튼으로 옮긴다.
  useLayoutEffect(() => {
    if (collapsed && (document.activeElement === document.body || document.activeElement === null)) {
      collapseRef.current?.focus();
    }
  }, [collapsed]);

  const selectTab = (id: string) => {
    setActiveId(id);
    if (collapsed) dispatch({ type: "setRibbonCollapsed", collapsed: false });
  };

  return (
    <section className={`ribbon${collapsed ? " ribbon--collapsed" : ""}`} aria-label={t("ribbon.label")}>
      <div className="ribbon__bar">
        <div className="ribbon__tabs" role="tablist" aria-label={t("ribbon.tabs")} onKeyDown={onTabKeyDown}>
          {RIBBON_TABS.map((tab) => {
            const selected = tab.id === active.id;
            return (
              <button
                key={tab.id}
                id={`ribbon-tab-${tab.id}`}
                type="button"
                role="tab"
                data-tab-id={tab.id}
                className="ribbon__tab"
                aria-selected={selected}
                aria-controls={collapsed ? undefined : PANEL_ID}
                tabIndex={selected ? 0 : -1}
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
          aria-label={collapsed ? t("ribbon.expand") : t("ribbon.collapse")}
          title={`${collapsed ? t("ribbon.expand") : t("ribbon.collapse")} (Ctrl+F1)`}
          onClick={() => dispatch({ type: "toggleRibbon" })}
        >
          <Icon name={collapsed ? "chevronDown" : "chevronUp"} />
        </button>
      </div>
      {!collapsed && (
        <div id={PANEL_ID} className="ribbon__panel" role="tabpanel" aria-labelledby={`ribbon-tab-${active.id}`}>
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
