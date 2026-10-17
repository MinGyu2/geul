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
//!
//! 엔진 불러오기와 변경 확정(T007, rhwp R-A: 문서 모델은 WebView의 WASM에 있다):
//! - 수명주기: `identified` →(`begin_load`)→ `loading` →(`transition`)→ `ready` | `failed`, `ready` → `failed`(엔진 오류·
//!   WebView 재시작으로 모델을 잃음), `failed` →(`begin_load`)→ `loading`(다시 불러오기). 다른 전이는 `InvalidRequest`,
//!   지금 상태가 요청의 `from`과 다르면 `InvalidState`. 닫힌 세션의 늦은 요청은 `StaleSession`이라 닫힌 세션이 되살아나지
//!   않는다.
//! - revision의 권한은 백엔드에만 있다. WASM 모델을 바꾸는 쪽(세션마다 하나인 프런트엔드 편집기)은 변경이 성공한 뒤
//!   `commit(기준 revision, 개수)`로 알리며, 기준이 지금 기록과 같고 상태가 `ready`일 때만 revision이 정확히 그 개수만큼
//!   는다. 다르면 아무것도 바꾸지 않고 `RevisionMismatch`(중복·순서 뒤바뀐 확정, 다른 쓰는 쪽)로 거부한다. 편집기는
//!   이때 모델이 기록과 어긋났다고 보고 세션을 `failed`로 돌린다. 다시 그리기·선택·실패한 변경은 확정하지 않는다.
//! - `dirty`는 `ready`가 된 뒤 확정한 변경이 있는지다(저장은 T009). 다시 불러오면 지금 revision을 기준으로 깨끗하다.
//! - `sequence`는 세션 기록이 바뀔 때마다(상태·revision) 1씩 는다. 프런트엔드는 더 작거나 같은 sequence의 응답을
//!   버려, 늦게 도착한 응답이 새 상태를 덮지 못하게 한다.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use super::error::{DocumentError, LimitKind};
use super::open::{FileFingerprint, FileIdentity, IdentifiedFile, LoadSource};
use super::{Engine, Format};

pub type SessionId = u64;

/// 세션 수명주기. `Identified`는 형식만 확정했다는 뜻이며 엔진이 문서를 읽었다는 뜻이 아니다. `Ready`는 엔진이
/// 문서를 불러와 편집할 수 있다는 프런트엔드의 확인을 받은 상태다.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Identified,
    Loading,
    Ready,
    Failed,
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
    /// `ready`가 된 뒤 확정한 변경이 있음(아직 저장 기능 없음).
    pub dirty: bool,
    /// 이 세션 기록이 바뀐 횟수(늦게 온 응답을 가려내는 데 쓴다).
    pub sequence: u64,
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
    fingerprint: FileFingerprint,
    clean_revision: u64,
}

/// 한 번에 확정할 수 있는 변경 수 상한(프런트엔드가 묶어 보내는 수).
pub const MAX_COMMIT_COUNT: u64 = 1 << 20;

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
            dirty: false,
            sequence: 0,
        };
        inner.sessions.insert(
            session_id,
            Session {
                info: info.clone(),
                identity: file.identity,
                fingerprint: file.fingerprint,
                clean_revision: 0,
            },
        );
        Ok(info)
    }

    /// 세션 하나를 잠금 안에서 바꾼다. 성공하면 sequence가 1 는다.
    fn update<T>(
        &self,
        session_id: SessionId,
        change: impl FnOnce(&mut Session) -> Result<T, DocumentError>,
    ) -> Result<(T, SessionInfo), DocumentError> {
        let mut inner = self.lock()?;
        let missing = Self::missing(&inner, session_id);
        let session = inner.sessions.get_mut(&session_id).ok_or(missing)?;
        let value = change(session)?;
        session.info.sequence += 1;
        session.info.dirty = session.info.revision != session.clean_revision;
        Ok((value, session.info.clone()))
    }

    /// 엔진 불러오기를 시작한다(`identified`·`failed` → `loading`). 다시 열 파일 정보를 돌려준다.
    pub fn begin_load(&self, session_id: SessionId) -> Result<LoadSource, DocumentError> {
        self.update(session_id, |session| match session.info.state {
            SessionState::Identified | SessionState::Failed => {
                session.info.state = SessionState::Loading;
                Ok(LoadSource {
                    identity: session.identity.clone(),
                    fingerprint: session.fingerprint,
                    format: session.info.format,
                })
            }
            state => Err(DocumentError::InvalidState { session_id, state }),
        })
        .map(|(source, _)| source)
    }

    /// 상태 전이. 허용: `loading`→`ready`, `loading`→`failed`, `ready`→`failed`.
    pub fn transition(
        &self,
        session_id: SessionId,
        from: SessionState,
        to: SessionState,
    ) -> Result<SessionInfo, DocumentError> {
        use SessionState::{Failed, Loading, Ready};
        if !matches!(
            (from, to),
            (Loading, Ready) | (Loading, Failed) | (Ready, Failed)
        ) {
            return Err(DocumentError::InvalidRequest);
        }
        self.update(session_id, |session| {
            if session.info.state != from {
                return Err(DocumentError::InvalidState {
                    session_id,
                    state: session.info.state,
                });
            }
            session.info.state = to;
            if to == Ready {
                session.clean_revision = session.info.revision;
            }
            Ok(())
        })
        .map(|(_, info)| info)
    }

    /// 엔진 모델에서 성공한 변경 `count`개를 확정한다. 기준 revision이 지금 기록과 같고 `ready`일 때만.
    pub fn commit(
        &self,
        session_id: SessionId,
        base_revision: u64,
        count: u64,
    ) -> Result<SessionInfo, DocumentError> {
        if count == 0 || count > MAX_COMMIT_COUNT {
            return Err(DocumentError::InvalidRequest);
        }
        self.update(session_id, |session| {
            if session.info.state != SessionState::Ready {
                return Err(DocumentError::InvalidState {
                    session_id,
                    state: session.info.state,
                });
            }
            if session.info.revision != base_revision {
                return Err(DocumentError::RevisionMismatch {
                    session_id,
                    revision: session.info.revision,
                });
            }
            session.info.revision = base_revision
                .checked_add(count)
                .ok_or(DocumentError::InvalidRequest)?;
            Ok(())
        })
        .map(|(_, info)| info)
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
