//! rhwp(HWP·HWPX) 저장 IPC(T009). 문서 모델이 WebView의 WASM에 있으므로(T007 R-A) 엔진 출력은 프런트엔드가 만들고,
//! 백엔드가 원본을 다시 읽어 검사·교체한다. `build.rs`의 앱 매니페스트와 `capabilities/default.json`에서 허용한다.
//!
//! - `document_original(sessionId, loadGeneration)`: 사전 검사용 원본 바이트(같은 파일·지문·해시일 때만, 원시 응답).
//!   경로 인자 없음. 프런트엔드는 이것으로 새 WASM 문서를 열어 편집 없이 내보낸다.
//! - `document_preflight`·`document_save`: 원시 요청 본문 프레임(`frame`). 백엔드가 받는 것은 세션·시도·판, 엔진 손실
//!   보고, (저장은) 다시 열기 비교 결과, 엔진 출력 바이트뿐이다. 쓰는 곳은 세션에 기록한 원본 경로 하나다(경로를 받지
//!   않고 원본 형식으로만 쓴다).
//! - WordCraft 세션은 거부한다(`InvalidRequest`, 그 저장은 `docx_preflight`·`docx_save`).

use serde_json::Value;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

use super::service::{self, read_original, SaveCheck, SaveOutcome, PLATFORM_SUPPORTED};
use crate::document::commands::DocumentState;
use crate::document::{DocumentError, SessionId};

/// 요청 프레임: `GSV1` · 세션(u64) · 시도(u64) · 판(u64) · 메타 길이(u32) · 메타(JSON, UTF-8) · 엔진 출력 바이트(나머지).
/// 정수는 little-endian.
pub const FRAME_MAGIC: &[u8; 4] = b"GSV1";
const FRAME_HEADER: usize = 4 + 8 * 3 + 4;
/// 메타(손실 보고·비교 결과) 상한. 손실 목록이 길면 보고서가 커지지만 손실이 있으면 어차피 저장하지 않는다.
const MAX_META_BYTES: usize = 1024 * 1024;

pub struct Frame {
    pub session_id: SessionId,
    pub generation: u64,
    pub revision: u64,
    pub meta: Value,
    pub payload: Vec<u8>,
}

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    let mut word = [0u8; 8];
    word.copy_from_slice(&bytes[at..at + 8]);
    u64::from_le_bytes(word)
}

/// 프레임을 읽는다. 모양이 맞지 않으면 `InvalidRequest`, 출력이 문서 크기 상한을 넘으면 `ResourceLimit`.
pub fn parse_frame(body: &[u8], max_payload: u64) -> Result<Frame, DocumentError> {
    if body.len() < FRAME_HEADER || &body[..4] != FRAME_MAGIC {
        return Err(DocumentError::InvalidRequest);
    }
    let meta_len = u32::from_le_bytes([body[28], body[29], body[30], body[31]]) as usize;
    if meta_len > MAX_META_BYTES || body.len() < FRAME_HEADER + meta_len {
        return Err(DocumentError::InvalidRequest);
    }
    let meta: Value = serde_json::from_slice(&body[FRAME_HEADER..FRAME_HEADER + meta_len])
        .map_err(|_| DocumentError::InvalidRequest)?;
    let payload = &body[FRAME_HEADER + meta_len..];
    if payload.is_empty() {
        return Err(DocumentError::InvalidRequest);
    }
    if payload.len() as u64 > max_payload {
        return Err(DocumentError::ResourceLimit {
            limit: crate::document::LimitKind::FileSize,
        });
    }
    // Refuse oversized frames before duplicating their potentially large IPC payload.
    let payload = payload.to_vec();
    Ok(Frame {
        session_id: u64_at(body, 4),
        generation: u64_at(body, 12),
        revision: u64_at(body, 20),
        meta,
        payload,
    })
}

/// 메타가 정확히 `keys`만 가진 객체인지.
fn exactly<'a>(meta: &'a Value, keys: &[&str]) -> Option<&'a serde_json::Map<String, Value>> {
    meta.as_object().filter(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}

/// 다시 열기 비교 결과(`reopen`): 정확히 네 값이 모두 참일 때만 같다고 본다. 모양이 다르면 같지 않다.
pub fn reopen_equal(reopen: &Value) -> bool {
    const KEYS: [&str; 4] = ["formatEqual", "pagesEqual", "textEqual", "controlsEqual"];
    exactly(reopen, &KEYS).is_some_and(|object| {
        KEYS.iter()
            .all(|key| object.get(*key) == Some(&Value::Bool(true)))
    })
}

fn raw(request: &Request<'_>) -> Result<Vec<u8>, DocumentError> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(_) => Err(DocumentError::InvalidRequest),
    }
}

#[tauri::command]
pub async fn document_original(
    state: State<'_, DocumentState>,
    session_id: SessionId,
    load_generation: u64,
) -> Result<Response, DocumentError> {
    state.frontend_model(session_id)?;
    let source = state
        .registry()
        .preflight_source(session_id, load_generation)?;
    let limits = state.limits();
    let bytes = state
        .run_blocking(move || read_original(&source, &limits))
        .await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn document_preflight(
    state: State<'_, DocumentState>,
    request: Request<'_>,
) -> Result<SaveCheck, DocumentError> {
    let frame = parse_frame(&raw(&request)?, state.limits().max_file_bytes)?;
    state.frontend_model(frame.session_id)?;
    let report = exactly(&frame.meta, &["contentLoss"])
        .and_then(|meta| meta.get("contentLoss"))
        .cloned()
        .ok_or(DocumentError::InvalidRequest)?;
    let source = state
        .registry()
        .preflight_source(frame.session_id, frame.generation)?;
    let limits = state.limits();
    let format = source.load.format;
    let (preservation, hash) = state
        .run_blocking(move || {
            let original = read_original(&source, &limits)?;
            Ok((
                service::preflight(format, &original, &frame.payload, Some(&report)),
                source.content_hash,
            ))
        })
        .await?;
    state.registry().record_preflight(
        frame.session_id,
        frame.generation,
        hash,
        preservation.clone(),
    )?;
    Ok(SaveCheck {
        preservation,
        platform_supported: PLATFORM_SUPPORTED,
    })
}

#[tauri::command]
pub async fn document_save(
    state: State<'_, DocumentState>,
    request: Request<'_>,
) -> Result<SaveOutcome, DocumentError> {
    let frame = parse_frame(&raw(&request)?, state.limits().max_file_bytes)?;
    state.frontend_model(frame.session_id)?;
    let meta =
        exactly(&frame.meta, &["contentLoss", "reopen"]).ok_or(DocumentError::InvalidRequest)?;
    let report = meta.get("contentLoss").cloned().unwrap_or(Value::Null);
    let equal = meta.get("reopen").is_some_and(reopen_equal);
    let registry = state.registry().clone();
    let limits = state.limits();
    state
        .run_blocking(move || {
            let ticket = registry.begin_save(frame.session_id, frame.generation, frame.revision)?;
            service::save(
                &registry,
                &ticket,
                &limits,
                &frame.payload,
                Some(&report),
                equal,
            )
        })
        .await
}
