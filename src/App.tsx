import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import type { CommandContext } from "./commands/commands";
import type { DocumentWorkspace } from "./components/Editor/documentWorkspace";
import { Editor } from "./components/Editor/Editor";
import { createTauriWorkspace } from "./components/Editor/tauriWorkspace";
import { NavigationPanel } from "./components/NavigationPanel/NavigationPanel";
import { PropertiesPanel } from "./components/PropertiesPanel/PropertiesPanel";
import { Ribbon } from "./components/Ribbon/Ribbon";
import { Splitter } from "./components/Splitter/Splitter";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { TitleBar } from "./components/TitleBar/TitleBar";
import {
  computePanelLayout,
  layoutReducer,
  PANEL_LIMITS,
  type LayoutState,
  type SidePanel,
} from "./hooks/layoutState";
import { useViewportWidth } from "./hooks/useViewportWidth";
import type { Language, Message } from "./language";
import { LanguageProvider, useTranslation } from "./language/LanguageContext";
import { canPersist, createLocalStorageStore, loadSettings, RESTORE_NOTICE, type SettingsStore } from "./settings/settings";
import { usePersistedSettings, type NotSavedReason } from "./settings/usePersistedSettings";

const defaultStore = createLocalStorageStore();

interface AppProps {
  /**
   * 테스트 주입용. 주면 저장된 값보다 우선한다(배치·언어 각각). 바뀐 값은 settingsStore에 저장된다.
   */
  initialState?: LayoutState;
  initialLanguage?: Language;
  settingsStore?: SettingsStore;
  /** 테스트 주입용 문서 작업 공간. 주지 않으면 Tauri 앱에서만 만든다(T007). */
  documentWorkspace?: DocumentWorkspace | null;
}

export default function App({ initialState, initialLanguage, settingsStore = defaultStore, documentWorkspace }: AppProps) {
  const [documents] = useState(() => (documentWorkspace === undefined ? createTauriWorkspace() : documentWorkspace));
  useEffect(() => documents?.start(), [documents]);
  // 처음 그리기 전에 한 번만 읽는다. 저장된 언어·배치로 첫 화면을 그리므로 기본값이 잠깐 보이지 않는다.
  const [boot] = useState(() => loadSettings(settingsStore));
  const [language, setLanguage] = useState<Language>(initialLanguage ?? boot.settings.language);
  const [layout, dispatch] = useReducer(layoutReducer, initialState ?? boot.settings.layout);
  // 복원 문제는 첫 메시지로만 보여 준다(효과에서 늦게 넣지 않으므로 StrictMode에서도 한 번이고, 그 뒤의 알림을
  // 덮어쓰지 않는다). 첫 실행과 정상 복원은 "준비됨".
  const [message, setMessage] = useState<Message>(() => ({ key: RESTORE_NOTICE[boot.status] ?? "status.ready" }));

  // 저장하지 못하면 이유를 알린다: 쓰기 실패, 실행 중 외부 변경(충돌), 시작할 때부터 쓰지 않는 상태(미지원 버전·읽기 실패).
  const blockedNotice = RESTORE_NOTICE[boot.status] ?? "settings.saveFailed";
  const onNotSaved = useCallback(
    (reason: NotSavedReason) => setMessage({
      key: reason === "conflict" ? "settings.conflict" : reason === "blocked" ? blockedNotice : "settings.saveFailed",
    }),
    [blockedNotice],
  );
  // 다시 저장되면 남아 있는 저장 실패 알림만 지운다. 그 사이에 나온 다른 알림은 그대로 둔다.
  const onRecovered = useCallback(
    () => setMessage((current) => (current.key === "settings.saveFailed" ? { key: "status.ready" } : current)),
    [],
  );
  usePersistedSettings(settingsStore, { language, layout }, {
    baseline: boot.raw,
    enabled: canPersist(boot.status),
    onNotSaved,
    onRecovered,
  });

  // 화면에 그리기 전에 반영해 테마·언어가 바뀌는 깜박임을 막는다.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = layout.theme;
  }, [layout.theme]);
  useLayoutEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return (
    <LanguageProvider language={language} onLanguageChange={setLanguage}>
      <Workspace layout={layout} dispatch={dispatch} message={message} notify={setMessage} documents={documents} />
    </LanguageProvider>
  );
}

interface WorkspaceProps {
  layout: LayoutState;
  dispatch: CommandContext["dispatch"];
  message: Message;
  notify: (message: Message) => void;
  documents: DocumentWorkspace | null;
}

function Workspace({ layout, dispatch, message, notify, documents }: WorkspaceProps) {
  const { t } = useTranslation();
  const viewportWidth = useViewportWidth();
  const navigationToggleRef = useRef<HTMLButtonElement>(null);
  const propertiesToggleRef = useRef<HTMLButtonElement>(null);

  const context = useMemo<CommandContext>(() => ({ layout, dispatch, notify }), [layout, dispatch, notify]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.key === "F1") {
        event.preventDefault();
        dispatch({ type: "toggleRibbon" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch]);

  // 패널 안의 닫기 버튼으로 숨기면 초점이 사라지므로 제목 표시줄의 해당 토글로 옮긴다.
  const closePanel = (panel: SidePanel) => {
    dispatch({ type: "setPanelVisible", panel, visible: false });
    (panel === "navigation" ? navigationToggleRef : propertiesToggleRef).current?.focus();
  };

  // 그리는 너비와 크기 조절 범위를 같은 계산에서 얻는다.
  const panels = computePanelLayout(layout, viewportWidth);
  const workspaceStyle = {
    "--navigation-width": `${panels.navigation.width}px`,
    "--properties-width": `${panels.properties.width}px`,
  } as CSSProperties;

  const splitter = (panel: SidePanel) => (
    <Splitter
      label={t(panel === "navigation" ? "navigation.resize" : "properties.resize")}
      controls={`${panel}-panel`}
      side={panel === "navigation" ? "left" : "right"}
      value={panels[panel].width}
      min={panels[panel].min}
      max={panels[panel].max}
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
        <Editor zoom={layout.zoom} workspace={documents} notify={notify} />
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
