import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { DocumentError, SessionId } from "../../adapters/contract";
import type { Message, MessageKey, Translate } from "../../language";
import { useTranslation } from "../../language/LanguageContext";
import type { DocumentWorkspace, RecoveryCheckpointStatus } from "./documentWorkspace";
import type { RecoveryCandidate } from "./recoveryPort";

interface RecoveryCenterProps {
  workspace: DocumentWorkspace;
  notify?: ((message: Message) => void) | undefined;
  errorMessage: (error: DocumentError) => Message;
}

const NO_BUSY = () => false;

function candidateLabel(candidate: RecoveryCandidate, stale: boolean, t: Translate) {
  if (!candidate.valid) return t("recovery.invalidCandidate");
  return stale ? t("recovery.staleCandidate", { name: candidate.name }) : candidate.name;
}

function checkpointText(status: RecoveryCheckpointStatus, t: Translate, format: (message: Message) => string, errorMessage: (error: DocumentError) => Message) {
  if (status.kind === "failed" || status.kind === "unsupported") {
    return `${t(`recovery.checkpoint.${status.kind}`, { revision: status.revision })} ${format(errorMessage(status.error))}`;
  }
  return t(`recovery.checkpoint.${status.kind}` as MessageKey, { revision: status.revision });
}

export function RecoveryCenter({ workspace, notify, errorMessage }: RecoveryCenterProps) {
  const { t, format } = useTranslation();
  const [, refreshView] = useReducer((tick: number) => tick + 1, 0);
  const fileBusy = useSyncExternalStore(workspace.subscribe, workspace.fileBusySnapshot, NO_BUSY);
  const [candidates, setCandidates] = useState<RecoveryCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<DocumentError | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const listSerial = useRef(0);
  const checkpointStatuses = workspace.recoveryCheckpointStatuses;

  useEffect(() => workspace.subscribeRecovery(refreshView), [workspace]);

  const refresh = useCallback(async () => {
    const serial = ++listSerial.current;
    setLoading(true);
    setListError(null);
    const result = await workspace.listRecovery();
    if (serial !== listSerial.current) return;
    setLoading(false);
    if (result.ok) setCandidates(result.value);
    else setListError(result.error);
  }, [workspace]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void refresh(); });
    return () => {
      active = false;
      listSerial.current += 1;
    };
  }, [refresh]);

  if (!workspace.supportsRecovery) return null;

  const restore = async (candidate: RecoveryCandidate) => {
    if (!candidate.valid || !candidate.format || fileBusy) return;
    const result = await workspace.restoreRecovery(candidate, {
      title: t("recovery.restoreTitle"), accept: t("recovery.restore"), cancel: t("document.cancel"),
    });
    if (result === null) return;
    if (!result.ok) {
      notify?.(result.error.code === "FileConflict" ? { key: "recovery.restoreConflict" } : errorMessage(result.error));
      return;
    }
    notify?.({ key: "recovery.restored", vars: { name: result.value.displayName } });
    void refresh(); // restore deliberately leaves the private candidate in the store.
  };

  const discard = async (candidate: RecoveryCandidate) => {
    if (fileBusy) return;
    if (confirmingId !== candidate.id) {
      setConfirmingId(candidate.id);
      return;
    }
    const result = await workspace.discardRecovery(candidate.id);
    setConfirmingId(null);
    if (!result.ok) {
      notify?.(errorMessage(result.error));
      return;
    }
    void refresh();
  };

  const retry = (sessionId: SessionId) => {
    if (fileBusy) return;
    void workspace.retryRecoveryCheckpoint(sessionId);
  };

  const live = candidates.filter(candidate => candidate.valid && !candidate.stale);
  const stale = candidates.filter(candidate => candidate.valid && candidate.stale);
  const invalid = candidates.filter(candidate => !candidate.valid);

  return (
    <section className="recovery-center" aria-labelledby="recovery-center-title" data-testid="recovery-center">
      <header className="recovery-center__header">
        <h2 id="recovery-center-title">{t("recovery.title")}</h2>
        <button type="button" className="document-bar__button" data-testid="recovery-refresh" disabled={loading || fileBusy} onClick={() => void refresh()}>
          {t("recovery.refresh")}
        </button>
      </header>
      <p className="panel__note">{t("recovery.supportNote")}</p>
      <p className="panel__note">{t("recovery.retentionNote")}</p>
      {loading && <p role="status" data-testid="recovery-loading">{t("recovery.loading")}</p>}
      {listError && <p role="alert" data-testid="recovery-list-error">{format(errorMessage(listError))}</p>}

      {checkpointStatuses.length > 0 && (
        <section aria-label={t("recovery.checkpoints")} data-testid="recovery-checkpoint-list">
          <h3>{t("recovery.checkpoints")}</h3>
          {checkpointStatuses.map(status => (
            <CheckpointStatus
              key={status.sessionId}
              status={status}
              workspace={workspace}
              fileBusy={fileBusy}
              errorMessage={errorMessage}
              onRetry={() => retry(status.sessionId)}
            />
          ))}
        </section>
      )}

      <div data-testid="recovery-candidate-list">
        <CandidateGroup
          testId="recovery-valid-list"
          title={t("recovery.available")}
          candidates={live}
          stale={false}
          confirmingId={confirmingId}
          busy={fileBusy}
          onRestore={restore}
          onDiscard={discard}
          onCancelDiscard={() => setConfirmingId(null)}
          label={candidateLabel}
        />
        <CandidateGroup
          testId="recovery-stale-list"
          title={t("recovery.stale")}
          candidates={stale}
          stale
          confirmingId={confirmingId}
          busy={fileBusy}
          onRestore={restore}
          onDiscard={discard}
          onCancelDiscard={() => setConfirmingId(null)}
          label={candidateLabel}
        />
        <CandidateGroup
          testId="recovery-invalid-list"
          title={t("recovery.invalid")}
          candidates={invalid}
          stale={false}
          confirmingId={confirmingId}
          busy={fileBusy}
          onRestore={restore}
          onDiscard={discard}
          onCancelDiscard={() => setConfirmingId(null)}
          label={candidateLabel}
        />
      </div>
      {!loading && !listError && candidates.length === 0 && <p role="status" data-testid="recovery-empty">{t("recovery.empty")}</p>}
    </section>
  );
}

function CheckpointStatus({ status, workspace, fileBusy, errorMessage, onRetry }: {
  status: RecoveryCheckpointStatus;
  workspace: DocumentWorkspace;
  fileBusy: boolean;
  errorMessage: (error: DocumentError) => Message;
  onRetry: () => void;
}) {
  const { t, format } = useTranslation();
  const session = workspace.sessions.get(status.sessionId);
  return (
    <div
      className="recovery-center__checkpoint"
      data-testid={`recovery-checkpoint-${status.sessionId}`}
      data-session={status.sessionId}
      data-revision={status.revision}
      data-state={status.kind}
    >
      <span>{session?.displayName ?? t("recovery.unknownDocument")}</span>
      <span>{checkpointText(status, t, format, errorMessage)}</span>
      {status.kind === "failed" && (
        <button type="button" className="document-bar__button" data-testid={`recovery-retry-${status.sessionId}`} disabled={fileBusy} onClick={onRetry}>
          {t("recovery.retry")}
        </button>
      )}
    </div>
  );
}

function CandidateGroup({ testId, title, candidates, stale, confirmingId, busy, onRestore, onDiscard, onCancelDiscard, label }: {
  testId: string;
  title: string;
  candidates: RecoveryCandidate[];
  stale: boolean;
  confirmingId: string | null;
  busy: boolean;
  onRestore: (candidate: RecoveryCandidate) => void;
  onDiscard: (candidate: RecoveryCandidate) => void;
  onCancelDiscard: () => void;
  label: (candidate: RecoveryCandidate, stale: boolean, t: Translate) => string;
}) {
  const { t } = useTranslation();
  if (candidates.length === 0) return null;
  return (
    <section aria-label={title} data-testid={testId}>
      <h3>{title}</h3>
      <ul data-testid="recovery-candidate-items">
        {candidates.map(candidate => (
          <li key={candidate.id} data-testid="recovery-candidate" data-recovery-id={candidate.id} data-valid={candidate.valid} data-stale={candidate.stale}>
            <span>{label(candidate, stale, t)}</span>
            {candidate.valid && <span>{t("recovery.revision", { revision: candidate.revision ?? 0 })}</span>}
            {candidate.valid && candidate.format && (
              <button type="button" className="document-bar__button" data-testid={`recovery-restore-${candidate.id}`} disabled={busy} onClick={() => onRestore(candidate)}>
                {t("recovery.restore")}
              </button>
            )}
            <button type="button" className="document-bar__button" data-testid={`recovery-discard-${candidate.id}`} disabled={busy} onClick={() => onDiscard(candidate)}>
              {t(confirmingId === candidate.id ? "recovery.discardPrompt" : "recovery.discard")}
            </button>
            {confirmingId === candidate.id && (
              <div role="group" aria-label={t("recovery.discardConfirmLabel")} data-testid={`recovery-discard-confirmation-${candidate.id}`}>
                <p>{t("recovery.discardConfirm")}</p>
                <button type="button" className="document-bar__button" data-testid={`recovery-discard-confirm-${candidate.id}`} disabled={busy} onClick={() => onDiscard(candidate)}>
                  {t("recovery.discardConfirmButton")}
                </button>
                <button type="button" className="document-bar__button" data-testid={`recovery-discard-cancel-${candidate.id}`} disabled={busy} onClick={onCancelDiscard}>
                  {t("document.cancel")}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
