//! 문서 세션의 권한 있는 기록.
//!
//! 규칙:
//! - 세션 ID는 1부터 하나씩 늘어나며 이 실행 동안 다시 쓰지 않는다. 그래서 발급한 적 있는 ID가 목록에 없으면
//!   닫힌 세션(`StaleSession`), 발급한 적 없는 ID는 `UnknownSession`이다. ID는 등록에 성공했을 때만 발급한다.
//! - 활성 문서(화면에 보이는 문서)는 프런트엔드의 선택일 뿐 이 기록에 없다. 선택을 바꿔도 세션은 바뀌지 않는다.
//! - revision은 엔진 문서 모델의 판이다. 열 때 0이며 문서를 바꾸는 연산이 성공할 때만 늘어난다. 다시 그리기·선택
//!   변경·조회로는 늘지 않는다. T006에는 문서를 바꾸는 연산이 없으므로 0에서 바뀌지 않는다. 바꾸는 연산(T007/T008)은
//!   요청에 기대 revision을 담고, 다르면 실행하지 않아야 한다.
//! - 같은 파일(정규화 경로 또는 장치·inode)은 두 세션으로 열지 않는다(`AlreadyOpen`). 판별은 잠금 밖에서 하고 중복
//!   확인과 등록은 한 번의 잠금 안에서 한다.
//! - 닫기를 되풀이하면 두 번째부터 `already_closed: true`로 성공한다(오류가 아님). 발급한 적 없는 ID는 오류다.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;

use super::error::{DocumentError, LimitKind};
use super::open::{FileIdentity, IdentifiedFile};
use super::{Engine, Format};

pub type SessionId = u64;

/// 세션 수명주기. T006에서는 형식만 확정한 `Identified`뿐이다. 엔진에 문서를 불러오는 상태(불러오는 중·준비됨·
/// 실패)는 엔진을 연결하는 T007/T008에서 추가한다. `Identified`는 엔진이 문서를 읽었다는 뜻이 아니다.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Identified,
}

/// 프런트엔드로 보내는 세션 정보. 파일 경로는 담지 않는다.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: SessionId,
    pub format: Format,
    pub engine: Engine,
    pub revision: u64,
    pub state: SessionState,
    pub display_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseOutcome {
    pub session_id: SessionId,
    pub already_closed: bool,
}

struct Session {
    info: SessionInfo,
    identity: FileIdentity,
}

struct Inner {
    next_id: SessionId,
    sessions: BTreeMap<SessionId, Session>,
}

pub struct SessionRegistry {
    inner: Mutex<Inner>,
    max_sessions: usize,
}

pub const DEFAULT_MAX_SESSIONS: usize = 64;

impl Default for SessionRegistry {
    fn default() -> Self {
        SessionRegistry::new(DEFAULT_MAX_SESSIONS)
    }
}

impl SessionRegistry {
    pub fn new(max_sessions: usize) -> Self {
        SessionRegistry {
            inner: Mutex::new(Inner {
                next_id: 1,
                sessions: BTreeMap::new(),
            }),
            max_sessions,
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, Inner>, DocumentError> {
        self.inner.lock().map_err(|_| DocumentError::Internal)
    }

    /// 형식을 확정한 파일로 새 세션을 만든다.
    pub fn register(&self, file: IdentifiedFile) -> Result<SessionInfo, DocumentError> {
        let mut inner = self.lock()?;
        if let Some(existing) = inner
            .sessions
            .values()
            .find(|session| session.identity.same_file(&file.identity))
        {
            return Err(DocumentError::AlreadyOpen {
                session_id: existing.info.session_id,
            });
        }
        if inner.sessions.len() >= self.max_sessions {
            return Err(DocumentError::ResourceLimit {
                limit: LimitKind::SessionCount,
            });
        }
        let session_id = inner.next_id;
        inner.next_id += 1;
        let info = SessionInfo {
            session_id,
            format: file.format,
            engine: file.format.engine(),
            revision: 0,
            state: SessionState::Identified,
            display_name: file.display_name,
        };
        inner.sessions.insert(
            session_id,
            Session {
                info: info.clone(),
                identity: file.identity,
            },
        );
        Ok(info)
    }

    fn missing(inner: &Inner, session_id: SessionId) -> DocumentError {
        if session_id >= 1 && session_id < inner.next_id {
            DocumentError::StaleSession { session_id }
        } else {
            DocumentError::UnknownSession { session_id }
        }
    }

    pub fn get(&self, session_id: SessionId) -> Result<SessionInfo, DocumentError> {
        let inner = self.lock()?;
        inner
            .sessions
            .get(&session_id)
            .map(|session| session.info.clone())
            .ok_or_else(|| Self::missing(&inner, session_id))
    }

    /// 열린 세션 전체(ID 순).
    pub fn list(&self) -> Result<Vec<SessionInfo>, DocumentError> {
        Ok(self
            .lock()?
            .sessions
            .values()
            .map(|session| session.info.clone())
            .collect())
    }

    pub fn close(&self, session_id: SessionId) -> Result<CloseOutcome, DocumentError> {
        let mut inner = self.lock()?;
        if inner.sessions.remove(&session_id).is_some() {
            return Ok(CloseOutcome {
                session_id,
                already_closed: false,
            });
        }
        match Self::missing(&inner, session_id) {
            DocumentError::StaleSession { .. } => Ok(CloseOutcome {
                session_id,
                already_closed: true,
            }),
            error => Err(error),
        }
    }
}
