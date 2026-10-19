//! WordCraft(DOCX) 세션 IPC(T008, W-A). `build.rs`의 앱 매니페스트와 `capabilities/default.json`에서 허용한다.
//!
//! - 경로 인자는 없다. 문서 바이트는 T007과 같은 `load_bytes`(판별한 파일만 다시 열어 같은지 확인)로 읽어 백엔드의
//!   엔진에 넣고, 프런트엔드로 보내지 않는다.
//! - 수명주기·revision의 권한은 `SessionRegistry` 하나다. WordCraft 세션은 백엔드만 바꾼다: 불러오기가 `loading → ready |
//!   failed`를 정하고, 편집은 모델 잠금 안에서 기준 revision 확인 → 실행 → 실제로 바뀐 연산 수만큼 확정을 한 번에 한다.
//!   그래서 프런트엔드의 `document_load`·`document_set_state`·`document_commit`은 WordCraft 세션을 거부한다.
//! - 모든 엔진 작업은 차단 작업 스레드에서 한다(동기 명령은 주 스레드에서 돌아 창을 멈춘다). 같은 세션의 작업은 모델
//!   잠금으로 차례로 실행된다.
//! - 엔진 패닉은 잡아서 세션을 `failed`로 돌리고 그 모델을 놓는다(모델이 일부만 바뀌었을 수 있음). 엔진이 연산을
//!   거부한 것(`rejected`)은 실패가 아니다: WordCraft가 그 명령 전으로 되돌리므로 성공한 연산만 센다.
//! - 다시 불러오기(`docx_load`의 `reload_generation`)는 사용자가 편집을 버리기로 한 뒤에만 프런트엔드가 보낸다. 그 시도의
//!   `ready` 세션을 백엔드가 `failed`로 돌리고 모델을 놓은 뒤 처음부터 불러온다(`failed → loading`).
//! - 응답과 오류에는 경로·엔진 메시지를 담지 않는다. 보기(`DocxView`)의 문단 글자는 편집 표면이 이미 그리는 문서 내용이다.
//! - 저장(T009): `docx_preflight`는 원본을 다시 읽어(같은 파일·지문·해시) 새 WordCraft 모델로 편집 없이 왕복한 출력과
//!   부분마다 비교해 보존 판정을 기록한다. `docx_save`는 모델 잠금 안에서(기록의 revision이 요청한 판일 때) 내보내고
//!   다시 읽은 모델이 편집 모델과 같은지 본 뒤, 저장 서비스(`crate::services::save::service::save`)가 검사·교체한다.
//!   내보내기 중 엔진 패닉은 `SaveFailure{export}`로만 알리고 모델은 놓지 않는다(편집을 버리지 않음, 내보내기는 모델을
//!   바꾸지 않는다). 경로 인자는 없고 원본 형식(DOCX)으로만 쓴다.

use std::panic::{catch_unwind, AssertUnwindSafe};

use serde::Serialize;
use tauri::ipc::Response;
use tauri::State;

use super::engine::{validate, DocxModel, DocxOp, DocxView, RoundTrip};
use crate::document::commands::{DocumentState, LoadingGuard};
use crate::document::{
    DocumentError, Engine, EngineStage, Format, SaveStage, SessionId, SessionInfo, SessionRegistry,
    SessionState,
};
use crate::services::save::preserve::{Finding, FindingCode, Preservation};
use crate::services::save::service::{
    self, read_original, SaveCheck, SaveOutcome, PLATFORM_SUPPORTED,
};

/// 불러오기·보기 응답.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxState {
    pub session: SessionInfo,
    pub view: DocxView,
}

/// 편집 응답. `rejected`는 엔진이 거부해 없던 일이 된 연산의 위치(나머지는 실행함).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxEdited {
    pub session: SessionInfo,
    pub view: DocxView,
    pub applied: usize,
    pub rejected: Vec<usize>,
}

/// 메모리 안 왕복 검사 결과. 검사한 모델의 판(`revision`)을 함께 보낸다.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxRoundTrip {
    pub session_id: SessionId,
    pub revision: u64,
    #[serde(flatten)]
    pub result: RoundTrip,
}

/// `docx_render` 응답 머리(24바이트, little-endian): 그린 모델의 revision(u64), 띠의 기준 판(u64, `u64::MAX`면 쪽 전체),
/// 띠의 첫 줄(u32), 줄 수(u32). 그 뒤가 PNG(줄 수 0이면 없음: 기준 판과 같은 그림).
pub const RENDER_HEADER_LEN: usize = 24;
/// 머리의 "쪽 전체" 표시.
pub const FULL_PAGE: u64 = u64::MAX;

fn engine_failure(stage: EngineStage) -> DocumentError {
    DocumentError::EngineFailure {
        engine: Engine::Wordcraft,
        stage,
    }
}

/// WordCraft 세션의 기록. 다른 엔진의 세션이면 `InvalidRequest`.
fn wordcraft_session(
    registry: &SessionRegistry,
    session_id: SessionId,
) -> Result<SessionInfo, DocumentError> {
    let info = registry.get(session_id)?;
    if info.engine != Engine::Wordcraft {
        return Err(DocumentError::InvalidRequest);
    }
    Ok(info)
}

fn check_ready(info: &SessionInfo, generation: u64) -> Result<(), DocumentError> {
    if info.load_generation != generation {
        return Err(DocumentError::StaleLoad {
            session_id: info.session_id,
            load_generation: info.load_generation,
        });
    }
    if info.state != SessionState::Ready {
        return Err(DocumentError::InvalidState {
            session_id: info.session_id,
            state: info.state,
        });
    }
    Ok(())
}

fn check_revision(info: &SessionInfo, revision: u64) -> Result<(), DocumentError> {
    if info.revision != revision {
        return Err(DocumentError::RevisionMismatch {
            session_id: info.session_id,
            revision: info.revision,
        });
    }
    Ok(())
}

/// 모델 하나로 하는 작업의 공통 경로: 시도 번호·ready 확인 → 차단 작업 스레드에서 모델 잠금 → 기록 다시 확인 → `work`.
/// `work` 안의 엔진 패닉은 세션을 `failed`로 돌리고 그 시도의 모델을 놓은 뒤 `EngineFailure(stage)`로 알린다.
pub(super) async fn with_model<T, F>(
    state: &DocumentState,
    session_id: SessionId,
    generation: u64,
    stage: EngineStage,
    work: F,
) -> Result<T, DocumentError>
where
    T: Send + 'static,
    F: FnOnce(&mut DocxModel, &SessionRegistry, SessionInfo) -> Result<T, DocumentError>
        + Send
        + 'static,
{
    let info = wordcraft_session(state.registry(), session_id)?;
    check_ready(&info, generation)?;
    let model =
        state
            .wordcraft()
            .get(session_id, generation)
            .ok_or(DocumentError::InvalidState {
                session_id,
                state: info.state,
            })?;
    let registry = state.registry().clone();
    let models = state.wordcraft().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 잠금 안의 패닉은 아래에서 잡으므로 잠금이 오염됐다면 계약 밖의 내부 오류다.
        let mut model = model.lock().map_err(|_| DocumentError::Internal)?;
        let info = registry.get(session_id)?;
        check_ready(&info, generation)?;
        match catch_unwind(AssertUnwindSafe(|| work(&mut model, &registry, info))) {
            Ok(result) => result,
            Err(_) => {
                let _ = registry.transition(
                    session_id,
                    generation,
                    SessionState::Ready,
                    SessionState::Failed,
                );
                models.release_if(session_id, generation);
                Err(engine_failure(stage))
            }
        }
    })
    .await
    .map_err(|_| DocumentError::Internal)?
}

/// 세션의 파일을 엔진에 불러온다(`identified`·`failed` → `loading` → `ready` | `failed`). `reload_generation`이 있으면
/// 그 시도로 `ready`인 모델을 먼저 버린다(`ready → failed`, 버리기는 프런트엔드가 사용자에게 확인한 뒤).
pub(crate) async fn load(
    state: &DocumentState,
    session_id: SessionId,
    reload_generation: Option<u64>,
) -> Result<DocxState, DocumentError> {
    if let Some(generation) = reload_generation {
        discard_ready(state, session_id, generation)?;
    }
    load_with(state, session_id, DocxModel::open).await
}

/// 그 시도로 `ready`인 세션을 `failed`로 돌리고 모델을 놓는다. 이미 `failed`면 그대로 둔다.
fn discard_ready(
    state: &DocumentState,
    session_id: SessionId,
    generation: u64,
) -> Result<(), DocumentError> {
    let info = wordcraft_session(state.registry(), session_id)?;
    if info.state == SessionState::Failed {
        return Ok(());
    }
    check_ready(&info, generation)?;
    // 진행 중인 편집은 이 전이 뒤에 확정하지 못하고(InvalidState) 놓인 모델과 함께 버려진다.
    state.registry().transition(
        session_id,
        generation,
        SessionState::Ready,
        SessionState::Failed,
    )?;
    state.wordcraft().release_if(session_id, generation);
    Ok(())
}

// 엔진 읽기만 주입한다(기록·시도 번호·가드·보관 순서는 같다). 시험은 읽기를 gate 뒤에서 실행한다.
pub(super) async fn load_with<F>(
    state: &DocumentState,
    session_id: SessionId,
    open: F,
) -> Result<DocxState, DocumentError>
where
    F: FnOnce(&[u8]) -> Result<DocxModel, EngineStage> + Send + 'static,
{
    wordcraft_session(state.registry(), session_id)?;
    let (generation, bytes) = state.load_bytes(session_id).await?;
    // 엔진이 읽는 동안 실패하거나 이 future가 버려지면 세션을 loading에 남기지 않는다.
    let guard = LoadingGuard::arm(state.registry(), session_id, generation);
    let (model, view) = state
        .run_blocking(move || {
            catch_unwind(AssertUnwindSafe(|| {
                let mut model = open(&bytes)?;
                let view = model.view();
                Ok((model, view))
            }))
            .unwrap_or(Err(EngineStage::Parse))
            .map_err(engine_failure)
        })
        .await?;
    // 모델을 먼저 넣고 전이한다. 전이가 실패하면(그사이 닫힘·새 시도) 이 시도의 모델만 뺀다.
    state.wordcraft().insert(session_id, generation, model);
    match state.registry().transition(
        session_id,
        generation,
        SessionState::Loading,
        SessionState::Ready,
    ) {
        Ok(session) => {
            guard.disarm();
            Ok(DocxState { session, view })
        }
        Err(error) => {
            state.wordcraft().release_if(session_id, generation);
            Err(error)
        }
    }
}

pub(crate) async fn view(
    state: &DocumentState,
    session_id: SessionId,
    generation: u64,
) -> Result<DocxState, DocumentError> {
    with_model(
        state,
        session_id,
        generation,
        EngineStage::Render,
        |model, _, session| {
            Ok(DocxState {
                session,
                view: model.view(),
            })
        },
    )
    .await
}

pub(crate) async fn edit(
    state: &DocumentState,
    session_id: SessionId,
    generation: u64,
    base_revision: u64,
    ops: Vec<DocxOp>,
) -> Result<DocxEdited, DocumentError> {
    if !validate(&ops) {
        return Err(DocumentError::InvalidRequest);
    }
    with_model(
        state,
        session_id,
        generation,
        EngineStage::Edit,
        move |model, registry, info| {
            check_revision(&info, base_revision)?;
            let outcome = model.apply(&ops);
            let session = if outcome.changed > 0 {
                registry.commit(session_id, generation, base_revision, outcome.changed)?
            } else {
                info
            };
            Ok(DocxEdited {
                session,
                view: model.view(),
                applied: outcome.applied,
                rejected: outcome.rejected,
            })
        },
    )
    .await
}

pub(crate) async fn render(
    state: &DocumentState,
    session_id: SessionId,
    generation: u64,
    revision: u64,
    page: usize,
    scale: f32,
    base: Option<u64>,
) -> Result<Vec<u8>, DocumentError> {
    with_model(
        state,
        session_id,
        generation,
        EngineStage::Render,
        move |model, _, info| {
            check_revision(&info, revision)?;
            let out = model
                .render_page(page, scale, revision, base)
                .ok_or(DocumentError::InvalidRequest)?;
            let mut framed = Vec::with_capacity(RENDER_HEADER_LEN + out.png.len());
            framed.extend_from_slice(&revision.to_le_bytes());
            framed.extend_from_slice(&out.base.unwrap_or(FULL_PAGE).to_le_bytes());
            framed.extend_from_slice(&out.y.to_le_bytes());
            framed.extend_from_slice(&out.height.to_le_bytes());
            framed.extend_from_slice(&out.png);
            Ok(framed)
        },
    )
    .await
}

pub(crate) async fn round_trip(
    state: &DocumentState,
    session_id: SessionId,
    generation: u64,
    revision: u64,
) -> Result<DocxRoundTrip, DocumentError> {
    with_model(
        state,
        session_id,
        generation,
        EngineStage::Export,
        move |model, _, info| {
            check_revision(&info, revision)?;
            let result = model
                .round_trip()
                .ok_or(engine_failure(EngineStage::Export))?;
            Ok(DocxRoundTrip {
                session_id,
                revision,
                result,
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn docx_load(
    state: State<'_, DocumentState>,
    session_id: SessionId,
    reload_generation: Option<u64>,
) -> Result<DocxState, DocumentError> {
    load(&state, session_id, reload_generation).await
}

#[tauri::command]
pub async fn docx_view(
    state: State<'_, DocumentState>,
    session_id: SessionId,
    load_generation: u64,
) -> Result<DocxState, DocumentError> {
    view(&state, session_id, load_generation).await
}

#[tauri::command]
pub async fn docx_edit(
    state: State<'_, DocumentState>,
    session_id: SessionId,
    load_generation: u64,
    base_revision: u64,
    ops: Vec<DocxOp>,
) -> Result<DocxEdited, DocumentError> {
    edit(&state, session_id, load_generation, base_revision, ops).await
}

/// 쪽 하나의 그림(원시 응답: 머리 24바이트 + PNG, `RENDER_HEADER_LEN`). `scale`은 pt당 픽셀, `base`는 받는 쪽이 이미 가진
/// 같은 배율 그림의 판(있으면 바뀐 띠만 받는다).
#[tauri::command]
pub async fn docx_render(
    state: State<'_, DocumentState>,
    session_id: SessionId,
    load_generation: u64,
    revision: u64,
    page: usize,
    scale: f32,
    base: Option<u64>,
) -> Result<Response, DocumentError> {
    render(
        &state,
        session_id,
        load_generation,
        revision,
        page,
        scale,
        base,
    )
    .await
    .map(Response::new)
}

#[tauri::command]
pub async fn docx_roundtrip(
    state: State<'_, DocumentState>,
    session_id: SessionId,
    load_generation: u64,
    revision: u64,
) -> Result<DocxRoundTrip, DocumentError> {
    round_trip(&state, session_id, load_generation, revision).await
}

/// 저장 사전 검사(T009, 모듈 설명).
pub(crate) async fn preflight(
    state: &DocumentState,
    session_id: SessionId,
    generation: u64,
) -> Result<SaveCheck, DocumentError> {
    wordcraft_session(state.registry(), session_id)?;
    let source = state.registry().preflight_source(session_id, generation)?;
    let limits = state.limits();
    let (preservation, hash) = state
        .run_blocking(move || {
            let original = read_original(&source, &limits)?;
            let unedited = catch_unwind(AssertUnwindSafe(|| {
                DocxModel::open(&original)
                    .ok()
                    .and_then(|model| model.export())
            }))
            .ok()
            .flatten();
            let preservation = match unedited {
                Some(bytes) => service::preflight(Format::Docx, &original, &bytes, None),
                None => Preservation::from_findings(vec![Finding::at(
                    FindingCode::OriginalMalformed,
                    "container",
                )]),
            };
            Ok((preservation, source.content_hash))
        })
        .await?;
    state
        .registry()
        .record_preflight(session_id, generation, hash, preservation.clone())?;
    Ok(SaveCheck {
        preservation,
        platform_supported: PLATFORM_SUPPORTED,
    })
}

/// 원본 형식 저장(T009, 모듈 설명).
pub(crate) async fn save(
    state: &DocumentState,
    session_id: SessionId,
    generation: u64,
    revision: u64,
) -> Result<SaveOutcome, DocumentError> {
    let info = wordcraft_session(state.registry(), session_id)?;
    check_ready(&info, generation)?;
    let model =
        state
            .wordcraft()
            .get(session_id, generation)
            .ok_or(DocumentError::InvalidState {
                session_id,
                state: info.state,
            })?;
    let registry = state.registry().clone();
    let limits = state.limits();
    state
        .run_blocking(move || {
            let ticket = registry.begin_save(session_id, generation, revision)?;
            let (output, reopen_equal) = {
                let model = model.lock().map_err(|_| DocumentError::Internal)?;
                // 편집은 모델 잠금 안에서 확정한다: 잠금을 쥔 지금 기록이 그 판이면 모델도 그 판이다.
                let info = registry.get(session_id)?;
                check_ready(&info, generation)?;
                check_revision(&info, revision)?;
                let exported = catch_unwind(AssertUnwindSafe(|| {
                    model.export().map(|bytes| {
                        let same = model.same_as(&bytes);
                        (bytes, same)
                    })
                }));
                match exported {
                    Ok(Some(result)) => result,
                    _ => {
                        return Err(DocumentError::SaveFailure {
                            stage: SaveStage::Export,
                            io: None,
                        })
                    }
                }
            };
            service::save(&registry, &ticket, &limits, &output, None, reopen_equal)
        })
        .await
}

#[tauri::command]
pub async fn docx_preflight(
    state: State<'_, DocumentState>,
    session_id: SessionId,
    load_generation: u64,
) -> Result<SaveCheck, DocumentError> {
    preflight(&state, session_id, load_generation).await
}

#[tauri::command]
pub async fn docx_save(
    state: State<'_, DocumentState>,
    session_id: SessionId,
    load_generation: u64,
    revision: u64,
) -> Result<SaveOutcome, DocumentError> {
    save(&state, session_id, load_generation, revision).await
}
