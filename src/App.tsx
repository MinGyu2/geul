import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { executeCommand, type CommandContext, type CommandInputRequest, type FileCommandActions } from "./commands/commands";
import type { DocumentCommandArgs } from "./commands/target";
import { CommandInputDialog } from "./components/Editor/CommandInputDialog";
import { handleShortcut } from "./commands/shortcuts";
import type { DocumentWorkspace } from "./components/Editor/documentWorkspace";
import { documentPanelState, navigateDocumentPage } from "./components/Editor/documentPanels";
import { documentErrorMessage, Editor } from "./components/Editor/Editor";
import { createTauriWorkspace } from "./components/Editor/tauriWorkspace";
import { NavigationPanel } from "./components/NavigationPanel/NavigationPanel";
import { PropertiesPanel } from "./components/PropertiesPanel/PropertiesPanel";
import { Ribbon } from "./components/Ribbon/Ribbon";
import { Splitter } from "./components/Splitter/Splitter";
import { createNotificationState, notificationReducer, type Notice } from "./components/StatusBar/publicationWarning";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { TitleBar } from "./components/TitleBar/TitleBar";
import { NewDocumentDialog } from "./components/Editor/NewDocumentDialog";
import type { DocumentFormat } from "./adapters/contract";
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
  // App owns retained outcomes separately from the latest lightweight status.
  const [notifications, dispatchNotification] = useReducer(notificationReducer,
    { key: RESTORE_NOTICE[boot.status] ?? "status.ready" } as Message, createNotificationState);
  const notice = notifications.pending[0];
  const message = notice?.message ?? notifications.transient;
  const notify = useCallback((incoming: Message) => dispatchNotification({ type: "notify", message: incoming }), []);
  const dismissMessage = useCallback((id: number) => dispatchNotification({ type: "acknowledge", id }), []);

  // 저장하지 못하면 이유를 알린다: 쓰기 실패, 실행 중 외부 변경(충돌), 시작할 때부터 쓰지 않는 상태(미지원 버전·읽기 실패).
  const blockedNotice = RESTORE_NOTICE[boot.status] ?? "settings.saveFailed";
  const onNotSaved = useCallback(
    (reason: NotSavedReason) => notify({
      key: reason === "conflict" ? "settings.conflict" : reason === "blocked" ? blockedNotice : "settings.saveFailed",
    }),
    [blockedNotice, notify],
  );
  // Resolving persistence does not acknowledge an error the user has not reviewed.
  const onRecovered = useCallback(() => dispatchNotification({ type: "settingsRecovered" }), []);
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
      <Workspace layout={layout} dispatch={dispatch} message={message} notice={notice} pendingCount={notifications.pending.length} notify={notify} onDismissMessage={dismissMessage} documents={documents} />
    </LanguageProvider>
  );
}

const NO_SUBSCRIBE = () => () => {};
const NO_FILE_BUSY = () => false;

/** Formats the workspace already knows it cannot create with the current RHWP runtime (Rust stays authoritative). */
function creationUnavailable(documents: DocumentWorkspace) {
  const result: Partial<Record<DocumentFormat, "CreationUnverified" | "CreationUnavailable">> = {};
  for (const format of ["hwp", "hwpx"] as const) {
    const error = documents.creationUnavailable(format);
    if (error?.code === "CreationUnverified" || error?.code === "CreationUnavailable") result[format] = error.code;
  }
  return result;
}

/**
 * 활성 문서의 편집 세션(명령 대상). 활성 세션은 DocumentSessions(백엔드 투영)가 정하고, 편집 세션은 작업 공간이 세션마다 하나
 * 만든다. 그 편집 세션이 바뀔 때(기록·서식·조합·저장 상태)마다 다시 그려 명령 가용성을 새로 정한다.
 */
function useActiveDocument(documents: DocumentWorkspace | null) {
  const sessions = documents?.sessions;
  const state = useSyncExternalStore(sessions?.subscribe ?? NO_SUBSCRIBE, () => sessions?.snapshot() ?? null);
  const info = state?.sessions.find((item) => item.sessionId === state.activeId) ?? null;
  const editor = info ? documents?.anyEditorFor(info.sessionId) ?? null : null;
  const subscribe = useCallback((listener: () => void) => editor?.subscribe(listener) ?? (() => {}), [editor]);
  const version = useSyncExternalStore(subscribe, editor?.changeSnapshot ?? NO_VERSION);
  // The version is stable between emissions; useSyncExternalStore also closes the render/subscribe gap.
  const panel = useMemo(() => {
    void version; // Mutable engine state is invalidated by its stable event version.
    return documentPanelState(editor, info);
  }, [editor, info, version]);
  return { editor, panel };
}
const NO_VERSION = () => 0;

interface WorkspaceProps {
  layout: LayoutState;
  dispatch: CommandContext["dispatch"];
  message: Message;
  notify: (message: Message) => void;
  onDismissMessage: (id: number) => void;
  notice: Notice | undefined;
  pendingCount: number;
  documents: DocumentWorkspace | null;
}

function Workspace({ layout, dispatch, message, notice, pendingCount, notify, onDismissMessage, documents }: WorkspaceProps) {
  const { t } = useTranslation();
  const viewportWidth = useViewportWidth();
  const navigationToggleRef = useRef<HTMLButtonElement>(null);
  const propertiesToggleRef = useRef<HTMLButtonElement>(null);

  // 명령 단추는 그릴 때마다 활성 편집 세션의 지금 상태로 가용성을 정한다(세션이 바뀌면 다시 그림).
  const { editor: activeEditor, panel } = useActiveDocument(documents);
  // 확인 창이 열린 동안은 어떤 명령도 실행하지 않는다(T010 안정화 P1-B, Editor가 창의 표시를 알림).
  const [modal, setModal] = useState(false);
  const [formatChoice, setFormatChoice] = useState<((format: DocumentFormat | null) => void) | null>(null);
  const formatResolver = useRef<((format: DocumentFormat | null) => void) | null>(null);
  useEffect(() => () => formatResolver.current?.(null), []);
  const fileBusy = useSyncExternalStore(documents?.subscribe ?? NO_SUBSCRIBE, documents?.fileBusySnapshot ?? NO_FILE_BUSY);
  useEffect(() => { if (!fileBusy) formatChoice?.(null); }, [fileBusy, formatChoice]);
  const fileActions = useMemo<FileCommandActions | undefined>(() => {
    if (!documents?.supportsNativeFiles) return undefined;
    const handleOpen = async () => {
      const result = await documents.openDialog({ title: t("document.openTitle"), accept: t("document.open"), cancel: t("document.cancel") });
      if (result === null) return;
      if (result.ok) notify({ key: "document.opened", vars: { name: result.value.displayName } });
      else notify(documentErrorMessage(result.error));
    };
    const handleNew = async () => {
      const result = await documents.newDocument({ title: t("document.newTitle"), accept: t("document.create"), cancel: t("document.cancel") },
        () => new Promise(resolve => {
          const finish = (format: DocumentFormat | null) => { formatResolver.current = null; setFormatChoice(null); resolve(format); };
          formatResolver.current = finish;
          setFormatChoice(() => finish);
        }));
      if (result === null) return;
      if (result.ok) notify({ key: result.value.dirty ? "document.createdUnconfirmed" : "document.created", vars: { name: result.value.displayName } });
      else if (result.error.code === "FileConflict") notify({ key: "document.newConflict" });
      else notify(documentErrorMessage(result.error));
    };
    const handleSaveAs = async (sessionId: number | null) => {
      if (sessionId === null) return;
      const editor = documents.anyEditorFor(sessionId);
      const priorSaveState = editor?.saveState;
      const result = await documents.saveAs(sessionId, {
        title: t("document.saveAsTitle"), accept: t("document.save"), cancel: t("document.cancel"),
      });
      if (result === null || result.ok) return;
      if (result.error.code === "FileConflict") notify({ key: "document.saveAsConflict" });
      else if (!editor || editor.saveState === priorSaveState) notify(documentErrorMessage(result.error));
    };
    return {
      busy: fileBusy,
      open: () => { void handleOpen(); },
      newDocument: () => { void handleNew(); },
      saveAs: (sessionId) => { void handleSaveAs(sessionId); },
    };
  }, [documents, fileBusy, notify, t]);
  // 값 입력 명령(T012·T013)의 입력 창. 요청은 연 순간의 세션·불러오기 번호·revision을 담는다.
  const [inputRequest, setInputRequest] = useState<CommandInputRequest | null>(null);
  const requestInput = useCallback((request: CommandInputRequest) => setInputRequest(request), []);
  const clipboardOwnership = useRef(0);
  const imageOwnership = useRef(0);
  useLayoutEffect(() => { imageOwnership.current += 1; }, [activeEditor, modal, formatChoice, inputRequest, fileBusy]);
  useLayoutEffect(() => { clipboardOwnership.current += 1; }, [activeEditor, modal, formatChoice, inputRequest, fileBusy]);
  useEffect(() => {
    const invalidate = () => { clipboardOwnership.current += 1; };
    window.addEventListener("blur", invalidate);
    return () => window.removeEventListener("blur", invalidate);
  }, []);
  useEffect(() => {
    if (!documents) return;
    let active = documents.sessions.snapshot().activeId;
    return documents.sessions.subscribe(() => {
      const next = documents.sessions.snapshot().activeId;
      if (next !== active) { active = next; clipboardOwnership.current += 1; imageOwnership.current += 1; }
    });
  }, [documents]);
  const context: CommandContext = useMemo<CommandContext>(
    () => ({
      layout, dispatch, notify, document: activeEditor, modal: modal || formatChoice !== null || inputRequest !== null,
      files: fileActions, requestInput,
      pickImage: () => invoke<import("./commands/target").ImportedPicture | null>("picture_import", { title: t("command.insert.image"), accept: t("document.open"), cancel: t("document.cancel") }),
      imageOwner: target => {
        const epoch = imageOwnership.current;
        return () => imageOwnership.current === epoch && contextRef.current.document === target
          && !contextRef.current.modal && !contextRef.current.files?.busy
          && (!documents || documents.sessions.snapshot().activeId === target.sessionId);
      },
      clipboardOwner: target => {
        const epoch = clipboardOwnership.current;
        return (): boolean => clipboardOwnership.current === epoch && contextRef.current.document === target
          && !contextRef.current.modal && !contextRef.current.files?.busy
          && (!documents || documents.sessions.snapshot().activeId === target.sessionId)
          && document.hasFocus();
      },
    }),
    [layout, dispatch, notify, activeEditor, modal, formatChoice, inputRequest, fileActions, requestInput, documents, t],
  );
  // 입력 창이 열린 동안 활성 문서가 바뀌거나 닫히면 창을 버린다(다른 문서에 값을 적용하지 않음 — 그리는 중 상태 조정).
  if (inputRequest && activeEditor?.sessionId !== inputRequest.sessionId) setInputRequest(null);
  const confirmInput = (args: DocumentCommandArgs) => {
    const request = inputRequest;
    setInputRequest(null);
    if (!request) return;
    // 창을 연 뒤 문서·세션이 바뀌었으면(다른 문서, 다시 불러오기, 그 사이 편집) 실행하지 않는다: 값은 연 순간의 문맥에서 고른 것이다.
    const snapshot = activeEditor?.sessionId === request.sessionId ? activeEditor.snapshot() : null;
    if (!snapshot || snapshot.loadGeneration !== request.loadGeneration || snapshot.revision !== request.revision
      || (request.selectionKey !== undefined && snapshot.clipboard?.key !== request.selectionKey)) {
      notify({ key: "commandInput.stale", vars: { command: { key: request.labelKey } } });
      return;
    }
    executeCommand(request.command, request.labelKey, { ...context, modal: modal || formatChoice !== null }, args);
  };

  // 단축키(T010): 레지스트리가 정한 명령만. 최신 문맥을 쓰도록 ref로 넘긴다(리스너는 한 번만 붙임).
  const contextRef = useRef(context);
  useLayoutEffect(() => {
    contextRef.current = context;
  }, [context]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => void handleShortcut(event, contextRef.current);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
      <Ribbon context={context} format={panel.info?.format ?? null} />
      <div className="workspace" style={workspaceStyle}>
        {layout.navigationVisible && (
          <>
            <NavigationPanel key={panel.info?.sessionId ?? "none"} state={panel} onNavigate={(page) => {
              const info = documents?.sessions.get(activeEditor?.sessionId ?? -1) ?? null;
              if (modal || documents?.fileBusy || documents?.sessions.snapshot().activeId !== activeEditor?.sessionId) return;
              if (navigateDocumentPage(activeEditor, info, page)) {
                document.querySelector<HTMLTextAreaElement>(".editor__scroll textarea.rhwp-input")?.focus({ preventScroll: true });
              }
            }} blocked={modal || fileBusy} onClose={() => closePanel("navigation")} />
            {splitter("navigation")}
          </>
        )}
        <Editor zoom={layout.zoom} workspace={documents} fileActions={fileActions} notify={notify} onModalChange={setModal} />
        {layout.propertiesVisible && (
          <>
            {splitter("properties")}
            <PropertiesPanel state={panel} onClose={() => closePanel("properties")} />
          </>
        )}
      </div>
      <StatusBar context={context} message={message} state={panel} noticeId={notice?.id} pendingCount={pendingCount} noticeResolved={notice?.resolved}
        onDismissMessage={notice ? () => onDismissMessage(notice.id) : undefined} />
      {inputRequest && <CommandInputDialog key={`${inputRequest.sessionId}:${inputRequest.command}`} request={inputRequest}
        suspended={modal} onCancel={() => setInputRequest(null)} onConfirm={confirmInput} />}
      {formatChoice && <NewDocumentDialog onChoose={formatChoice} suspended={modal} unavailable={documents ? creationUnavailable(documents) : {}} />}
    </div>
  );
}
