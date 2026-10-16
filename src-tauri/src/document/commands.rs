//! 문서 세션 Tauri 명령(IPC). `build.rs`의 앱 매니페스트와 `capabilities/default.json`에서 이 명령만 허용한다.
//!
//! - 경로는 프런트엔드가 보낸 문자열이므로 그대로 믿지 않고 `open::identify`에서 검사한다. 지원 확장자가 아닌 파일은
//!   내용을 읽지 않으며, 응답과 오류에는 경로·문서 내용·운영체제 오류 문구를 담지 않는다. 지금은 열기 대화상자가 없어
//!   경로를 IPC로 받는다. 대화상자를 백엔드가 띄우는 흐름(T009)이 생기면 이 경로 입력을 다시 검토한다.
//! - 판별(파일 읽기)은 차단 작업 스레드에서 하고, 동시에 진행하는 열기 수를 제한한다.
//! - 셸 실행이나 임의 파일 시스템 접근 명령은 없다.

use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::State;

use super::error::{DocumentError, LimitKind};
use super::open::{identify, Limits};
use super::session::{CloseOutcome, SessionId, SessionInfo, SessionRegistry};

pub const MAX_PENDING_OPENS: usize = 8;

#[derive(Default)]
pub struct DocumentState {
    registry: SessionRegistry,
    limits: Limits,
    pending_opens: AtomicUsize,
}

/// 진행 중인 열기 하나. 끝나면(실패·패닉 포함) 수를 돌려놓는다.
struct PendingOpen<'a>(&'a AtomicUsize);

impl Drop for PendingOpen<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl DocumentState {
    fn begin_open(&self) -> Result<PendingOpen<'_>, DocumentError> {
        let previous = self.pending_opens.fetch_add(1, Ordering::AcqRel);
        let pending = PendingOpen(&self.pending_opens);
        if previous >= MAX_PENDING_OPENS {
            return Err(DocumentError::ResourceLimit {
                limit: LimitKind::PendingOpens,
            });
        }
        Ok(pending)
    }
}

#[tauri::command]
pub async fn document_open(
    state: State<'_, DocumentState>,
    path: String,
) -> Result<SessionInfo, DocumentError> {
    let _pending = state.begin_open()?;
    let limits = state.limits;
    let identified = tauri::async_runtime::spawn_blocking(move || identify(&path, &limits))
        .await
        .map_err(|_| DocumentError::Internal)??; // 판별 중 패닉은 내부 오류로만 알린다
    state.registry.register(identified)
}

#[tauri::command]
pub fn document_close(
    state: State<'_, DocumentState>,
    session_id: SessionId,
) -> Result<CloseOutcome, DocumentError> {
    state.registry.close(session_id)
}

#[tauri::command]
pub fn document_session(
    state: State<'_, DocumentState>,
    session_id: SessionId,
) -> Result<SessionInfo, DocumentError> {
    state.registry.get(session_id)
}

#[tauri::command]
pub fn document_sessions(
    state: State<'_, DocumentState>,
) -> Result<Vec<SessionInfo>, DocumentError> {
    state.registry.list()
}
