// 저장 단추와 결과(T009). rhwp·WordCraft 편집 패널이 함께 쓴다. 저장 판정·교체는 백엔드가 하고, 여기서는 시작과 결과
// 표시만 한다. 막힌 저장은 이유(보존 판정의 근거: 코드와 패키지 안 부분 이름)를 숨기지 않는다. 원본 경로·문서 내용은
// 보이지 않는다. data-* 속성은 시험·진단용이다.
import type { DocumentError, Preservation, Result, SaveCheck, SaveOutcome } from "../../adapters/contract";
import type { MessageKey } from "../../language";
import { useTranslation } from "../../language/LanguageContext";
import { blockedBy, type SaveCheckRecord, type SaveState } from "./saveState";

export interface SaveEditor {
  saveState: SaveState;
  saveCheck: SaveCheckRecord | null;
  save(): Promise<Result<SaveOutcome>>;
  checkSave(): Promise<Result<SaveCheck>>;
}

/** 오류의 세부 안내 키(있으면). */
function detailKey(error: DocumentError): MessageKey | null {
  switch (error.code) {
    case "UnsafeSave": return `editor.save.outcome.${error.preservation.outcome}` as MessageKey;
    case "SaveUnsupported": return `editor.save.unsupported.${error.reason}` as MessageKey;
    case "SaveFailure": return `editor.save.stage.${error.stage}` as MessageKey;
    case "SaveNotReady": return `editor.save.notReady.${error.reason}` as MessageKey;
    default: return null;
  }
}

function Findings({ preservation }: { preservation: Preservation }) {
  const { t } = useTranslation();
  if (preservation.findings.length === 0) return null;
  return (
    <ul className="editor__save-findings" data-testid="save-findings">
      {preservation.findings.map((finding, index) => (
        <li key={index} data-code={finding.code} data-part={finding.part ?? ""}>
          {t(`editor.save.finding.${finding.code}` as MessageKey, { part: finding.part ?? "" })}
        </li>
      ))}
    </ul>
  );
}

export function SaveControls({ editor, prefix }: { editor: SaveEditor; prefix: "rhwp" | "docx" }) {
  const { t } = useTranslation();
  const state = editor.saveState;
  const check = editor.saveCheck?.check ?? null;
  const busy = state.kind === "checking" || state.kind === "saving";
  const error = state.kind === "failed" ? state.error : null;
  // 결과가 없으면 마지막 사전 검사가 저장을 막는지 보인다(형식별 저장 가능 여부).
  const blocked = !error && state.kind === "idle" && check ? blockedBy(check) : null;
  const shown = error ?? blocked;
  const preservation = shown?.code === "UnsafeSave" ? shown.preservation : null;
  const outcome = preservation?.outcome ?? (check && state.kind !== "saved" ? check.preservation.outcome : "");
  const findings = (preservation?.findings ?? []).map((f) => (f.part ? `${f.code}:${f.part}` : f.code)).join(",");
  const detail = shown ? detailKey(shown) : null;
  return (
    <>
      <button type="button" className="document-bar__button" data-testid={`${prefix}-save`} disabled={busy} onClick={() => void editor.save()}>
        {t("editor.save.button")}
      </button>
      <button type="button" className="document-bar__button" data-testid={`${prefix}-save-check`} disabled={busy} onClick={() => void editor.checkSave()}>
        {t("editor.save.check")}
      </button>
      <output
        className="editor__save-result"
        data-testid={`${prefix}-save-result`}
        data-state={state.kind}
        data-outcome={outcome}
        data-error={shown?.code ?? ""}
        data-findings={findings}
        data-revision={state.kind === "saved" ? state.revision : ""}
        data-synced={state.kind === "saved" ? state.durable : ""}
        data-changed-since={state.kind === "saved" ? state.changedSince : ""}
      >
        {state.kind === "checking" && t("editor.save.checking")}
        {state.kind === "saving" && t("editor.save.saving")}
        {state.kind === "saved" && (
          <>
            {t("editor.save.saved", { revision: state.revision })}
            {state.changedSince && ` ${t("editor.save.changedSince")}`}
            {!state.durable && ` ${t("editor.save.notDurable")}`}
          </>
        )}
        {state.kind === "idle" && check && !blocked && t("editor.save.safe")}
        {shown && (
          <span role="alert">
            {t(`document.error.${shown.code}` as MessageKey)}
            {detail && ` ${t(detail)}`}
            {shown.code === "SaveFailure" && shown.io && ` ${t(`editor.save.io.${shown.io}` as MessageKey)}`}
            {(shown.code === "UnsafeSave" || shown.code === "SaveFailure" || shown.code === "SaveUnsupported" || shown.code === "FileConflict")
              && ` ${t("editor.save.originalKept")}`}
          </span>
        )}
      </output>
      {preservation && <Findings preservation={preservation} />}
    </>
  );
}
