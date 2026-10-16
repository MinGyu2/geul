import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import type { CommandContext } from "./commands/commands";
import { Editor } from "./components/Editor/Editor";
import { NavigationPanel } from "./components/NavigationPanel/NavigationPanel";
import { PropertiesPanel } from "./components/PropertiesPanel/PropertiesPanel";
import { Ribbon } from "./components/Ribbon/Ribbon";
import { Splitter } from "./components/Splitter/Splitter";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { TitleBar } from "./components/TitleBar/TitleBar";
import {
  effectivePanelWidths,
  initialLayout,
  layoutReducer,
  PANEL_LIMITS,
  panelMaxWidth,
  type LayoutState,
  type SidePanel,
} from "./hooks/layoutState";
import { useViewportWidth } from "./hooks/useViewportWidth";
import { t } from "./language";

interface AppProps {
  initialState?: LayoutState;
}

export default function App({ initialState = initialLayout }: AppProps) {
  const [layout, dispatch] = useReducer(layoutReducer, initialState);
  const [message, setMessage] = useState(() => t("status.ready"));
  const viewportWidth = useViewportWidth();
  const navigationToggleRef = useRef<HTMLButtonElement>(null);
  const propertiesToggleRef = useRef<HTMLButtonElement>(null);

  const context = useMemo<CommandContext>(() => ({ layout, dispatch, notify: setMessage }), [layout]);

  useEffect(() => {
    document.documentElement.dataset.theme = layout.theme;
  }, [layout.theme]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.key === "F1") {
        event.preventDefault();
        dispatch({ type: "toggleRibbon" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 패널 안의 닫기 버튼으로 숨기면 초점이 사라지므로 제목 표시줄의 해당 토글로 옮긴다.
  const closePanel = (panel: SidePanel) => {
    dispatch({ type: "setPanelVisible", panel, visible: false });
    (panel === "navigation" ? navigationToggleRef : propertiesToggleRef).current?.focus();
  };

  const widths = effectivePanelWidths(layout, viewportWidth);
  const workspaceStyle = {
    "--navigation-width": `${widths.navigation}px`,
    "--properties-width": `${widths.properties}px`,
  } as CSSProperties;

  const splitter = (panel: SidePanel) => (
    <Splitter
      label={t(panel === "navigation" ? "navigation.resize" : "properties.resize")}
      controls={`${panel}-panel`}
      side={panel === "navigation" ? "left" : "right"}
      value={widths[panel]}
      min={PANEL_LIMITS[panel].min}
      max={panelMaxWidth(layout, panel, viewportWidth)}
      initial={PANEL_LIMITS[panel].initial}
      onResize={(width) => dispatch({ type: "resizePanel", panel, width })}
    />
  );

  return (
    <div className="app">
      <TitleBar
        context={context}
        navigationToggleRef={navigationToggleRef}
        propertiesToggleRef={propertiesToggleRef}
      />
      <Ribbon context={context} />
      <div className="workspace" style={workspaceStyle}>
        {layout.navigationVisible && (
          <>
            <NavigationPanel onClose={() => closePanel("navigation")} />
            {splitter("navigation")}
          </>
        )}
        <Editor zoom={layout.zoom} />
        {layout.propertiesVisible && (
          <>
            {splitter("properties")}
            <PropertiesPanel onClose={() => closePanel("properties")} />
          </>
        )}
      </div>
      <StatusBar context={context} message={message} />
    </div>
  );
}
