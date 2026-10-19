import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type MutableRefObject,
} from "react";
import type { DocumentError, SessionId, SessionInfo } from "../../adapters/contract";
import { EMPTY_SESSIONS, type SessionsState } from "../../adapters/sessions";
import type { Message, MessageKey } from "../../language";
import { useTranslation } from "../../language/LanguageContext";
import type { DocumentWorkspace, EngineEditor } from "./documentWorkspace";
import { RhwpEditorSession } from "./rhwp/RhwpEditorSession";
import { ImeContext } from "./rhwp/imeInput";
import { RhwpSurface } from "./rhwp/RhwpSurface";
import type { DocxEditorSession } from "./wordcraft/DocxEditorSession";
import { DocxSurface } from "./wordcraft/DocxSurface";

interface EditorProps {
  zoom: number;
  /** 문서 세션(Tauri 앱). 없으면(테스트·브라우저) 빈 편집 영역만 보인다. */
  workspace?: DocumentWorkspace | null;
  notify?: ((message: Message) => void) | undefined;
}

const NO_SUBSCRIBE = () => () => {};
const NO_SESSIONS = () => EMPTY_SESSIONS;

/**
 * 자동 검사용 진단(커서 문단의 글자)을 DOM에 노출할지. 문서 내용이므로 일반 빌드에는 넣지 않고, 검사용 빌드
 * (`VITE_GEUL_TEST_HOOKS=1 npm run build`, tests/integration/rhwp/rhwp_poc.py)에서만 켠다. 빌드 때 상수로 바뀌어
 * 일반 빌드에서는 해당 코드가 빠진다.
 */
const TEST_HOOKS = import.meta.env.VITE_GEUL_TEST_HOOKS === "1";

/** 저장하지 않은 편집을 버릴지 묻는 중인 작업. */
type DiscardRequest = { action: "close" | "reload"; sessionId: SessionId; name: string } | { action: "window" };

/** 오류 code를 화면 문구 키로. 세부 값(경로·내용)은 보여 주지 않는다. */
export function documentErrorMessage(error: DocumentError): Message {
  return { key: `document.error.${error.code}` as MessageKey };
}

/**
 * 중앙 편집 영역. 열린 문서가 없으면 안내와 빈 페이지 자리표시자를 보여 준다.
 * HWP/HWPX 세션은 rhwp WASM 편집 표면(T007 R-A), DOCX 세션은 백엔드 WordCraft 엔진의 편집 표면(T008 W-A)을 붙인다.
 * 문서 열기는 경로 입력(PoC, 열기 대화상자는 T009)이며 저장은 없다.
 */
export function Editor({ zoom, workspace = null, notify }: EditorProps) {
  const { t } = useTranslation();
  const sessions = workspace?.sessions;
  const state: SessionsState = useSyncExternalStore(sessions?.subscribe ?? NO_SUBSCRIBE, sessions?.snapshot ?? NO_SESSIONS);
  const active = state.sessions.find((session) => session.sessionId === state.activeId) ?? null;
  const pageStyle = { "--zoom": zoom / 100 } as CSSProperties;
  const [discard, setDiscard] = useState<DiscardRequest | null>(null);
  // IME 입력 문맥은 WebView에 하나다. 탭마다 표면이 바뀌어도 끊긴 조합 상태는 함께 쓴다(imeInput.ts).
  const [imeContext] = useState(() => new ImeContext());
  const discardTarget = discard && discard.action !== "window" && state.sessions.find((session) => session.sessionId === discard.sessionId);
  // 확인 창이 닫힌 뒤 돌려줄 초점. 창이 다른 창으로 바뀌어도(탭 → 창 닫기) 처음 창을 연 요소를 이어받는다.
  const discardFocusReturnRef = useRef<HTMLElement | null>(null);
  const closingWindow = useRef(false);
  const closeWindow = useCallback(async () => {
    if (!workspace?.windowClose || closingWindow.current) return;
    closingWindow.current = true;
    workspace.setWindowClosing(true); // 승인 뒤 native destroy가 끝날 때까지 새 편집을 막는다
    try {
      await workspace.windowClose.close();
    } catch {
      closingWindow.current = false;
      workspace.setWindowClosing(false);
      notify?.({ key: "document.error.Protocol" });
    }
  }, [workspace, notify]);
  useEffect(() => {
    if (!workspace?.windowClose) return;
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void workspace.windowClose.listen(() => {
      if (stopped || closingWindow.current) return;
      if (workspace.hasUnpreservedChanges) setDiscard(current => current?.action === "window" ? current : { action: "window" });
      else void closeWindow();
    }).then(stop => { if (stopped) stop(); else unlisten = stop; }).catch(() => notify?.({ key: "document.error.Protocol" }));
    return () => { stopped = true; unlisten?.(); };
  }, [workspace, closeWindow, notify]);

  // 닫기·다시 불러오기: 저장하지 않은 편집이 있으면(UnpreservedChanges) 버릴지 묻고, 버리기를 고른 경우에만 진행한다.
  const close = async (session: SessionInfo, confirmed = false) => {
    if (!workspace) return;
    const result = await workspace.close(session.sessionId, { discard: confirmed });
    if (result.ok) return;
    if (result.error.code === "UnpreservedChanges") setDiscard({ action: "close", sessionId: session.sessionId, name: session.displayName });
    else notify?.(documentErrorMessage(result.error));
  };
  const reload = async (session: SessionInfo, confirmed = false) => {
    const editor = workspace?.anyEditorFor(session.sessionId);
    if (!editor) return;
    const result = await editor.load({ discard: confirmed });
    if (!result.ok && result.error.code === "UnpreservedChanges") {
      setDiscard({ action: "reload", sessionId: session.sessionId, name: session.displayName });
    } else if (confirmed && result.ok) notify?.({ key: "document.discardedReloaded", vars: { name: session.displayName } });
  };
  const confirmDiscard = () => {
    if (!discard) return;
    setDiscard(null);
    if (discard.action === "window") { void closeWindow(); return; }
    if (!discardTarget) return;
    void (discard.action === "close" ? close(discardTarget, true) : reload(discardTarget, true));
  };

  return (
    <main className="editor" aria-label={t("editor.label")}>
      {workspace && <DocumentBar workspace={workspace} state={state} notify={notify} onClose={(session) => void close(session)} />}
      {active === null ? (
        <>
          <div className="editor__notice" role="note">
            <h1 className="editor__notice-title">{t("editor.emptyTitle")}</h1>
            <p>{t("editor.emptyBody")}</p>
          </div>
          <div className="editor__scroll">
            <div className="editor__canvas">
              <div className="editor__page" style={pageStyle} title={t("editor.emptyHint")} aria-hidden="true" />
            </div>
          </div>
        </>
      ) : active.engine === "rhwp" && workspace ? (
        <RhwpPanel
          key={active.sessionId}
          editor={workspace.editorFor(active.sessionId)}
          info={active}
          zoom={zoom}
          imeContext={imeContext}
          onReload={() => void reload(active)}
        />
      ) : active.engine === "wordcraft" && workspace?.docxEditorFor(active.sessionId) ? (
        <DocxPanel
          key={active.sessionId}
          editor={workspace.docxEditorFor(active.sessionId)!}
          info={active}
          zoom={zoom}
          imeContext={imeContext}
          onReload={() => void reload(active)}
        />
      ) : (
        <div className="editor__notice" role="note" data-testid="editor-unsupported">
          <h1 className="editor__notice-title">{t("editor.unsupportedTitle", { name: active.displayName })}</h1>
        </div>
      )}
      {discard && (discard.action === "window" || discardTarget) && (
        <DiscardDialog key={discard.action === "window" ? "window" : `${discard.action}:${discard.sessionId}`} request={discard} focusReturnRef={discardFocusReturnRef} onCancel={() => setDiscard(null)} onConfirm={confirmDiscard} />
      )}
    </main>
  );
}

/**
 * 저장하지 않은 편집을 버릴지 묻는 확인 창(alertdialog). 처음 초점은 취소에 두고, Escape는 취소, Tab은 창 안에서만
 * 돈다. 닫히면 초점을 열기 전 요소로 돌려준다.
 * 초점 순서(6차): 처음 초점은 창이 DOM에 들어오는 commit 안(layout effect)에서 옮긴다. passive effect로 옮기면 창이 보인 뒤
 * 그 effect가 돌 때까지 초점이 뒤의 편집 입력에 남아 그 사이의 키가 문서로 간다(재현: 창이 보이는 순간 초점이 textarea).
 * 닫힌 뒤의 복원은 전과 같이 passive cleanup에서 한다. 창이 다른 확인 창으로 바뀌면(탭 → 창 닫기) 옛 창은 복원하지 않고
 * (새 창이 이미 가진 초점을 빼앗지 않음) 처음 연 요소를 `focusReturnRef`로 새 창에 넘긴다.
 * (5차 실험의 native 창 닫기 실패는 앱 동작이 아니라 시험기가 WebDriver 명령 안에서 승인을 눌러 그 응답이 창 파괴와 경합한
 * 것이었다: 6차에 Rust 창 이벤트를 기록해 CloseRequested·확정 1회·Destroyed 1회로 기준 코드와 같음을 확인.)
 */
function DiscardDialog({ request, focusReturnRef, onCancel, onConfirm }: {
  request: DiscardRequest;
  focusReturnRef: MutableRefObject<HTMLElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!focusReturnRef.current && document.activeElement instanceof HTMLElement) focusReturnRef.current = document.activeElement;
    cancelRef.current?.focus();
  }, [focusReturnRef]);
  useEffect(() => () => {
    if (document.querySelector("[role='alertdialog'][aria-modal='true']")) return; // 이어 열린 확인 창이 초점을 가진다
    const opener = focusReturnRef.current;
    focusReturnRef.current = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }, [focusReturnRef]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Tab") {
      const target = document.activeElement === cancelRef.current ? confirmRef.current : cancelRef.current;
      event.preventDefault();
      target?.focus();
    }
  };
  return (
    <div className="discard-dialog__backdrop">
      <div
        className="discard-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="discard-dialog-title"
        aria-describedby="discard-dialog-body"
        data-testid="discard-dialog"
        data-action={request.action}
        onKeyDown={onKeyDown}
      >
        <h2 id="discard-dialog-title" className="discard-dialog__title">
          {request.action === "window" ? t("document.discard.windowTitle") : t(request.action === "close" ? "document.discard.closeTitle" : "document.discard.reloadTitle", { name: request.name })}
        </h2>
        <p id="discard-dialog-body">{t(request.action === "window" ? "document.discard.windowBody" : "document.discard.body")}</p>
        <div className="discard-dialog__actions">
          <button ref={cancelRef} type="button" className="document-bar__button" data-testid="discard-cancel" onClick={onCancel}>
            {t("document.discard.cancel")}
          </button>
          <button ref={confirmRef} type="button" className="document-bar__button" data-testid="discard-confirm" onClick={onConfirm}>
            {t(request.action === "window" ? "document.discard.windowConfirm" : request.action === "close" ? "document.discard.closeConfirm" : "document.discard.reloadConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

function DocumentBar({ workspace, state, notify, onClose }: {
  workspace: DocumentWorkspace;
  state: SessionsState;
  notify: ((message: Message) => void) | undefined;
  onClose: (session: SessionInfo) => void;
}) {
  const { t } = useTranslation();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const open = async (event: FormEvent) => {
    event.preventDefault();
    if (!path.trim() || busy) return;
    setBusy(true);
    const result = await workspace.open(path.trim());
    setBusy(false);
    if (result.ok) {
      setPath("");
      notify?.({ key: "document.opened", vars: { name: result.value.displayName } });
    } else notify?.(documentErrorMessage(result.error));
  };
  return (
    <div className="document-bar">
      <form className="document-bar__open" onSubmit={open}>
        <label className="visually-hidden" htmlFor="document-path">{t("document.pathLabel")}</label>
        <input
          id="document-path"
          className="document-bar__path"
          value={path}
          placeholder={t("document.pathPlaceholder")}
          onChange={(event) => setPath(event.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <button type="submit" className="document-bar__button" disabled={busy || !path.trim()}>{t("document.open")}</button>
      </form>
      <div className="document-tabs" role="tablist" aria-label={t("document.tabs")}>
        {state.sessions.map((session) => (
          <DocumentTab
            key={session.sessionId}
            session={session}
            active={session.sessionId === state.activeId}
            editor={workspace.anyEditorFor(session.sessionId)}
            onSelect={() => workspace.sessions.select(session.sessionId)}
            onClose={() => onClose(session)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 문서 탭 하나. 수정 표시(●)는 백엔드 dirty뿐 아니라 아직 확정하지 않았거나 조합 중인 편집도 반영한다
 * (백엔드 dirty가 false여도 저장하지 않은 편집이 있을 수 있음).
 */
function DocumentTab({ session, active, editor, onSelect, onClose }: {
  session: SessionInfo;
  active: boolean;
  editor: EngineEditor | null;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  useEditorUpdates(editor);
  const modified = session.dirty || (editor?.hasUnpreservedChanges ?? false);
  return (
    <div className="document-tab" data-active={active}>
      <button
        type="button"
        role="tab"
        className="document-tab__select"
        aria-selected={active}
        data-session={session.sessionId}
        data-state={session.state}
        data-modified={modified}
        onClick={onSelect}
      >
        {modified ? <span aria-label={t("document.modified")}>● </span> : null}
        {session.displayName}
        <span className="document-tab__state">{t(`document.state.${session.state}` as MessageKey)}</span>
      </button>
      <button type="button" className="document-tab__close" aria-label={t("document.close", { name: session.displayName })} onClick={onClose}>
        ×
      </button>
    </div>
  );
}

/** 마지막으로 SETTLE_MS 동안 바뀌지 않은 글자(처음 값은 바로). 입력 중에는 이전 글자를 그대로 둔다. */
const SETTLE_MS = 500;
function useSettledText(text: string): string {
  const [shown, setShown] = useState(text);
  useEffect(() => {
    if (text === shown) return;
    const timer = window.setTimeout(() => setShown(text), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [text, shown]);
  return shown;
}

/** 편집 세션이 바뀔 때마다(상태·커서·revision·측정) 다시 그린다. */
function useEditorUpdates(editor: { subscribe(listener: () => void): () => void } | null) {
  const [, update] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => editor?.subscribe(update), [editor]);
}

function RhwpPanel({ editor, info, zoom, imeContext, onReload }: {
  editor: RhwpEditorSession | null;
  info: SessionInfo;
  zoom: number;
  imeContext: ImeContext;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  useEditorUpdates(editor);
  const latency = editor?.latency() ?? null;
  // 진단 글자(판·입력 반영)는 입력이 멈춘 뒤에 바꾼다. 편집 영역 위의 글자를 키마다 바꾸면 WebKitGTK가 frame마다 다시
  // 그려 실제 IME 입력이 밀렸다(소프트웨어 렌더링 실측). data-* 속성은 바로 바뀐다(검사·진단용).
  const revisionText = useSettledText(t("editor.rhwp.revision", { revision: info.revision }));
  const latencyText = useSettledText(latency ? t("editor.rhwp.latency", { p95: latency.p95.toFixed(1), count: latency.count }) : "");
  if (!editor) return null;
  const status = editor.status;
  const roundTrip = editor.lastRoundTrip;
  const unpreserved = editor.hasUnpreservedChanges;
  return (
    <>
      <div
        className="editor__notice editor__poc"
        role="status"
        data-testid="rhwp-status"
        data-status={status.kind}
        data-revision={info.revision}
        data-local-revision={editor.localRevision}
        data-dirty={info.dirty}
        data-first-paint-ms={editor.firstPaintMs === null ? "" : editor.firstPaintMs.toFixed(1)}
        data-latency-count={latency?.count ?? 0}
        data-latency-p95={latency ? latency.p95.toFixed(1) : ""}
        data-latency-max={latency ? latency.max.toFixed(1) : ""}
        data-caret={RhwpEditorSession.positionKey(editor.caret)}
        data-selection={editor.hasSelection ? `${RhwpEditorSession.positionKey(editor.anchor)}|${RhwpEditorSession.positionKey(editor.caret)}` : ""}
        data-composing={editor.composing}
        data-unpreserved={unpreserved}
        data-uncertain={editor.hasUncertainChanges}
        data-paragraph-text={TEST_HOOKS ? editor.caretParagraphText() : undefined}
        data-pages={editor.pages.length}
      >
        <h1 className="editor__notice-title">{info.displayName}</h1>
        <p>{t(`editor.rhwp.${status.kind}` as MessageKey)}</p>
        {status.kind === "failed" && (
          <>
            <p data-testid="rhwp-error">{t(documentErrorMessage(status.error).key)}</p>
            {/* 편집한 모델이 남아 있으면 복구 기능이 없다는 것과 다시 불러오면 버려진다는 것을 숨기지 않는다. */}
            {unpreserved && <p data-testid="rhwp-unpreserved-warning">{t("editor.rhwp.failedUnpreserved")}</p>}
            {/* 엔진 편집이 도중에 실패했으면 모델이 일부만 바뀌었을 수 있다는 것을 따로 알린다(성공한 편집과 구분). */}
            {editor.hasUncertainChanges && <p data-testid="rhwp-uncertain-warning">{t("editor.rhwp.failedUncertain")}</p>}
            <button type="button" className="document-bar__button" data-testid="rhwp-load" onClick={onReload}>
              {t("editor.rhwp.reload")}
            </button>
          </>
        )}
        {status.kind === "idle" && (
          // 엔진에 아직 불러오지 않은 세션(예: WebView를 다시 시작한 뒤 남은 세션). 자동으로 불러오지 않는다.
          <button type="button" className="document-bar__button" data-testid="rhwp-load" onClick={onReload}>
            {t(info.state === "failed" ? "editor.rhwp.reload" : "editor.rhwp.load")}
          </button>
        )}
        {status.kind === "ready" && (
          <>
            <span>{revisionText}</span>
            {latencyText && <span>{latencyText}</span>}
            <button
              type="button"
              className="document-bar__button"
              data-testid="rhwp-roundtrip"
              onClick={() => editor.roundTrip(info.format === "hwpx" ? "hwpx" : "hwp")}
            >
              {t("editor.rhwp.roundTrip")}
            </button>
            {/* 결과는 검사한 그 모델에 대한 것이다. 문서를 바꾸면 편집 세션이 지우므로 이전 통과가 남지 않는다. */}
            {roundTrip && (
              <output
                data-testid="rhwp-roundtrip-result"
                data-format={roundTrip.format}
                data-reopened-format={roundTrip.reopenedFormat ?? ""}
                data-format-equal={roundTrip.formatEqual}
                data-passed={roundTrip.passed}
                data-failure={roundTrip.failure ?? ""}
                data-loss-valid={roundTrip.lossValid}
                data-loss-count={roundTrip.lossCount}
                data-pages-equal={roundTrip.pagesEqual}
                data-text-equal={roundTrip.textEqual}
                data-controls-equal={roundTrip.controlsEqual}
              >
                {t("editor.rhwp.roundTripResult", {
                  verdict: t(roundTrip.passed ? "editor.rhwp.roundTripPassed" : "editor.rhwp.roundTripFailed"),
                  loss: roundTrip.lossValid ? roundTrip.lossCount : t("editor.rhwp.lossInvalid"),
                  same: roundTrip.formatEqual && roundTrip.textEqual && roundTrip.controlsEqual && roundTrip.pagesEqual ? "✓" : "✗",
                })}
              </output>
            )}
          </>
        )}
      </div>
      <div className="editor__scroll">
        {status.kind === "ready" ? <RhwpSurface session={editor} zoom={zoom} imeContext={imeContext} /> : null}
      </div>
    </>
  );
}

/**
 * DOCX(WordCraft) 편집 패널(T008). 상태·진단 속성(검사·측정용)과 다시 불러오기·메모리 내보내기 검사를 보이고, ready면
 * 편집 표면을 붙인다. WebView를 다시 시작한 뒤 백엔드에 모델이 남은 세션은 자동으로 다시 붙는다(백엔드 모델이 권한).
 */
function DocxPanel({ editor, info, zoom, imeContext, onReload }: {
  editor: DocxEditorSession;
  info: SessionInfo;
  zoom: number;
  imeContext: ImeContext;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  useEditorUpdates(editor);
  useEffect(() => {
    if (editor.status.kind === "idle" && (info.state === "ready" || info.state === "loading")) void editor.resume();
  }, [editor, info.state]);
  const latency = editor.latency();
  const revisionText = useSettledText(t("editor.docx.revision", { revision: info.revision }));
  const latencyText = useSettledText(latency ? t("editor.docx.latency", { p95: latency.p95.toFixed(1), count: latency.count }) : "");
  const status = editor.status;
  const view = editor.view;
  const roundTrip = editor.roundTripCurrent ? editor.lastRoundTrip : null;
  const unpreserved = editor.hasUnpreservedChanges;
  const mark = (flag: boolean) => (flag ? "✓" : "✗");
  return (
    <>
      <div
        className="editor__notice editor__poc"
        role="status"
        data-testid="docx-status"
        data-status={status.kind}
        data-revision={info.revision}
        data-generation={editor.loadGeneration}
        data-dirty={info.dirty}
        data-first-paint-ms={editor.firstPaintMs === null ? "" : editor.firstPaintMs.toFixed(1)}
        data-latency-count={latency?.count ?? 0}
        data-latency-p50={latency ? latency.p50.toFixed(1) : ""}
        data-latency-p95={latency ? latency.p95.toFixed(1) : ""}
        data-latency-max={latency ? latency.max.toFixed(1) : ""}
        data-latency-samples={TEST_HOOKS ? editor.latencySamples().map((ms) => ms.toFixed(1)).join(",") : undefined}
        data-caret={view?.caretKey ?? ""}
        data-selection={view && !view.collapsed ? `${view.anchorKey}|${view.caretKey}` : ""}
        data-caret-offset={view?.caretOffset ?? ""}
        data-in-table={view?.inTable ?? false}
        data-composing={editor.composing}
        data-composition={TEST_HOOKS ? editor.compositionText : undefined}
        data-pending={editor.pendingOps}
        data-rejected={editor.rejectedOps}
        data-input-notice={editor.inputNotice ?? ""}
        data-render-failed={editor.renderFailedPages.join(",")}
        data-unpreserved={unpreserved}
        data-paragraph-text={TEST_HOOKS ? view?.paragraphText ?? "" : undefined}
        data-pages={view?.pages.length ?? 0}
      >
        <h1 className="editor__notice-title">{info.displayName}</h1>
        <p>{t(`editor.docx.${status.kind}` as MessageKey)}</p>
        {status.kind === "failed" && (
          <>
            <p data-testid="docx-error">{t(documentErrorMessage(status.error).key)}</p>
            {unpreserved && <p data-testid="docx-unpreserved-warning">{t("editor.docx.failedUnpreserved")}</p>}
            <button type="button" className="document-bar__button" data-testid="docx-load" onClick={onReload}>
              {t("editor.docx.reload")}
            </button>
          </>
        )}
        {status.kind === "idle" && info.state !== "ready" && info.state !== "loading" && (
          <button type="button" className="document-bar__button" data-testid="docx-load" onClick={onReload}>
            {t(info.state === "failed" ? "editor.docx.reload" : "editor.docx.load")}
          </button>
        )}
        {status.kind === "ready" && (
          <>
            <span>{revisionText}</span>
            {latencyText && <span>{latencyText}</span>}
            {editor.rejectedOps > 0 && <span>{t("editor.docx.rejected", { count: editor.rejectedOps })}</span>}
            <button type="button" className="document-bar__button" data-testid="docx-roundtrip" onClick={() => void editor.roundTrip()}>
              {t("editor.docx.roundTrip")}
            </button>
            {/* 결과는 검사한 판에 대한 것이다. 문서가 바뀌면 보이지 않는다. */}
            {roundTrip && (
              <output
                data-testid="docx-roundtrip-result"
                data-revision={roundTrip.revision}
                data-passed={roundTrip.passed}
                data-bytes={roundTrip.bytes}
                data-pages-equal={roundTrip.pagesEqual}
                data-text-equal={roundTrip.textEqual}
                data-model-equal={roundTrip.modelEqual}
              >
                {t("editor.docx.roundTripResult", {
                  verdict: t(roundTrip.passed ? "editor.docx.roundTripPassed" : "editor.docx.roundTripFailed"),
                  pages: mark(roundTrip.pagesEqual),
                  text: mark(roundTrip.textEqual),
                  model: mark(roundTrip.modelEqual),
                })}
              </output>
            )}
          </>
        )}
      </div>
      <div className="editor__scroll">
        {status.kind === "ready" ? <DocxSurface session={editor} zoom={zoom} imeContext={imeContext} /> : null}
      </div>
    </>
  );
}
