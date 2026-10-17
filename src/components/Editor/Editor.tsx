import { useEffect, useReducer, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from "react";
import type { DocumentError, SessionInfo } from "../../adapters/contract";
import { EMPTY_SESSIONS, type SessionsState } from "../../adapters/sessions";
import type { Message, MessageKey } from "../../language";
import { useTranslation } from "../../language/LanguageContext";
import type { DocumentWorkspace } from "./documentWorkspace";
import { RhwpEditorSession } from "./rhwp/RhwpEditorSession";
import { RhwpSurface } from "./rhwp/RhwpSurface";

interface EditorProps {
  zoom: number;
  /** 문서 세션(Tauri 앱). 없으면(테스트·브라우저) 빈 편집 영역만 보인다. */
  workspace?: DocumentWorkspace | null;
  notify?: ((message: Message) => void) | undefined;
}

const NO_SUBSCRIBE = () => () => {};
const NO_SESSIONS = () => EMPTY_SESSIONS;

/** 오류 code를 화면 문구 키로. 세부 값(경로·내용)은 보여 주지 않는다. */
export function documentErrorMessage(error: DocumentError): Message {
  return { key: `document.error.${error.code}` as MessageKey };
}

/**
 * 중앙 편집 영역. 열린 문서가 없으면 안내와 빈 페이지 자리표시자를 보여 준다.
 * T007: HWP/HWPX 세션은 rhwp WASM 편집 표면(R-A)을 붙이고, DOCX 세션은 WordCraft 연결(T008) 전이라 사용할 수 없다고
 * 표시한다. 문서 열기는 경로 입력(PoC, 열기 대화상자는 T009)이며 저장은 없다.
 */
export function Editor({ zoom, workspace = null, notify }: EditorProps) {
  const { t } = useTranslation();
  const sessions = workspace?.sessions;
  const state: SessionsState = useSyncExternalStore(sessions?.subscribe ?? NO_SUBSCRIBE, sessions?.snapshot ?? NO_SESSIONS);
  const active = state.sessions.find((session) => session.sessionId === state.activeId) ?? null;
  const pageStyle = { "--zoom": zoom / 100 } as CSSProperties;
  return (
    <main className="editor" aria-label={t("editor.label")}>
      {workspace && <DocumentBar workspace={workspace} state={state} notify={notify} />}
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
        <RhwpPanel key={active.sessionId} editor={workspace.editorFor(active.sessionId)} info={active} zoom={zoom} />
      ) : (
        <div className="editor__notice" role="note" data-testid="editor-unsupported">
          <h1 className="editor__notice-title">{t("editor.unsupportedTitle", { name: active.displayName })}</h1>
          <p>{t("editor.wordcraftPending")}</p>
        </div>
      )}
    </main>
  );
}

function DocumentBar({ workspace, state, notify }: { workspace: DocumentWorkspace; state: SessionsState; notify: ((message: Message) => void) | undefined }) {
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
          <div key={session.sessionId} className="document-tab" data-active={session.sessionId === state.activeId}>
            <button
              type="button"
              role="tab"
              className="document-tab__select"
              aria-selected={session.sessionId === state.activeId}
              data-session={session.sessionId}
              data-state={session.state}
              onClick={() => workspace.sessions.select(session.sessionId)}
            >
              {session.dirty ? "● " : ""}{session.displayName}
              <span className="document-tab__state">{t(`document.state.${session.state}` as MessageKey)}</span>
            </button>
            <button
              type="button"
              className="document-tab__close"
              aria-label={t("document.close", { name: session.displayName })}
              onClick={() => void workspace.close(session.sessionId).then((result) => {
                if (!result.ok) notify?.(documentErrorMessage(result.error));
              })}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 편집 세션이 바뀔 때마다(상태·커서·revision·측정) 다시 그린다. */
function useEditorUpdates(editor: RhwpEditorSession | null) {
  const [, update] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => editor?.subscribe(update), [editor]);
}

function RhwpPanel({ editor, info, zoom }: { editor: RhwpEditorSession | null; info: SessionInfo; zoom: number }) {
  const { t } = useTranslation();
  useEditorUpdates(editor);
  if (!editor) return null;
  const status = editor.status;
  const latency = editor.latency();
  const roundTrip = editor.lastRoundTrip;
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
        data-paragraph-text={editor.caretParagraphText()}
        data-pages={editor.pages.length}
      >
        <h1 className="editor__notice-title">{info.displayName}</h1>
        <p>{t(`editor.rhwp.${status.kind}` as MessageKey)}</p>
        {status.kind === "failed" && (
          <>
            <p data-testid="rhwp-error">{t(documentErrorMessage(status.error).key)}</p>
            <button type="button" className="document-bar__button" data-testid="rhwp-load" onClick={() => void editor.load()}>
              {t("editor.rhwp.reload")}
            </button>
          </>
        )}
        {status.kind === "idle" && (
          // 엔진에 아직 불러오지 않은 세션(예: WebView를 다시 시작한 뒤 남은 세션). 자동으로 불러오지 않는다.
          <button type="button" className="document-bar__button" data-testid="rhwp-load" onClick={() => void editor.load()}>
            {t(info.state === "failed" ? "editor.rhwp.reload" : "editor.rhwp.load")}
          </button>
        )}
        {status.kind === "ready" && (
          <>
            <span>{t("editor.rhwp.revision", { revision: info.revision })}</span>
            {latency && <span>{t("editor.rhwp.latency", { p95: latency.p95.toFixed(1), count: latency.count })}</span>}
            <button
              type="button"
              className="document-bar__button"
              data-testid="rhwp-roundtrip"
              onClick={() => editor.roundTrip(info.format === "hwpx" ? "hwpx" : "hwp")}
            >
              {t("editor.rhwp.roundTrip")}
            </button>
            {roundTrip && (
              <output
                data-testid="rhwp-roundtrip-result"
                data-format={roundTrip.format}
                data-loss-count={roundTrip.lossCount}
                data-pages-equal={roundTrip.pagesEqual}
                data-text-equal={roundTrip.textEqual}
                data-controls-equal={roundTrip.controlsEqual}
              >
                {t("editor.rhwp.roundTripResult", {
                  loss: roundTrip.lossCount,
                  same: roundTrip.textEqual && roundTrip.controlsEqual && roundTrip.pagesEqual ? "✓" : "✗",
                })}
              </output>
            )}
          </>
        )}
      </div>
      <div className="editor__scroll">
        {status.kind === "ready" ? <RhwpSurface session={editor} zoom={zoom} /> : null}
      </div>
    </>
  );
}
