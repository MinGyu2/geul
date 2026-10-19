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
//! - `load_generation`은 불러오기 시도 번호다(`begin_load`마다 1 증가). 상태 전이·변경 확정은 지금 시도의 번호를 담아야
//!   하며, 다르면 `StaleLoad`로 거부한다(늦게 끝난 옛 시도·옛 모델의 확정이 새 시도를 바꾸지 못함).
//! - `sequence`는 세션 기록이 바뀔 때마다(상태·revision) 1씩 는다. 프런트엔드는 더 작거나 같은 sequence의 응답을
//!   버려, 늦게 도착한 응답이 새 상태를 덮지 못하게 한다.
//!
//! 저장(T009, `crate::services::save`):
//! - 불러올 때 엔진에 넘긴 바이트의 해시를 기록한다(`record_content`). 저장은 디스크의 파일이 같은 객체·지문·해시일 때만
//!   한다(아니면 `FileConflict` — 외부 수정을 덮어쓰지 않음).
//! - 보존 사전 검사 결과는 그 원본 해시와 함께 둔다(`record_preflight`). 저장은 같은 원본의 결과가 `safe`일 때만.
//! - `begin_save`는 `ready`·지금 시도 번호·지금 revision이고 저장 중이 아닐 때만 표를 준다(아니면 `InvalidState`·
//!   `StaleLoad`·`RevisionMismatch`·`SaveInProgress`). 표는 버려지면(성공·실패·패닉) 저장 중 표시를 지운다.
//! - 원본 교체(`finish_save`의 `publish`)는 이 기록의 잠금 안에서, 세션이 아직 있고 같은 시도·`ready`이며 저장 중
//!   표시가 그 표의 것일 때만 실행한다. 그래서 그 사이 닫거나 다시 불러온 세션의 저장은 원본을 바꾸지 않는다.
//! - 성공하면 깨끗한 판을 표의 revision으로 둔다: 그 사이 확정한 편집이 있으면(revision이 더 큼) dirty가 남는다. 파일
//!   식별·지문·해시는 새 파일로 바꾸고, 사전 검사는 지운다(새 원본에 대해 다시 한다).
//! - 교체는 됐지만 내구성(디렉터리 `fsync`)을 확인하지 못했으면(`Published::durable` false) 파일 기록은 새 파일로 바꾸되
//!   (디스크에 지금 있는 것은 새 파일이다) 깨끗한 판은 올리지 않고 `unconfirmed`로 dirty를 남긴다: 닫기·다시 불러오기가
//!   버리기를 확인하고, 다시 저장하면 새 파일을 원본으로 다시 확인해 교체·`fsync`한다. 다시 불러오면(디스크에서 읽음) 풀린다.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use super::error::{DocumentError, LimitKind};
use super::open::{FileFingerprint, FileIdentity, IdentifiedFile, LoadSource};
use super::{Engine, Format};
use crate::services::save::preserve::Preservation;

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
    /// 엔진 불러오기 시도 번호. `begin_load`마다 1 늘고(0은 아직 불러온 적 없음), 상태 전이와 변경 확정은 지금
    /// 시도의 번호를 담아야 한다. 늦게 끝난 옛 시도가 새 시도의 상태·revision을 바꾸지 못하게 한다.
    pub load_generation: u64,
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
    /// 불러올 때 엔진에 넘긴 원본 바이트의 해시(T009).
    content_hash: Option<u64>,
    /// 보존 사전 검사 결과와 그 검사의 원본 해시(T009).
    preflight: Option<(u64, Preservation)>,
    /// 진행 중인 저장 표의 번호(T009).
    saving: Option<u64>,
    /// 마지막 교체의 내구성을 확인하지 못함(T009 안정화): dirty로 남긴다.
    unconfirmed: bool,
}

impl Session {
    fn refresh_dirty(&mut self) {
        self.info.dirty = self.info.revision != self.clean_revision || self.unconfirmed;
    }
}

/// 원본 교체 결과(T009): 교체한 파일의 식별·지문과 디렉터리 `fsync`까지 됐는지.
#[derive(Clone, Debug)]
pub struct Published {
    pub identity: FileIdentity,
    pub fingerprint: FileFingerprint,
    pub durable: bool,
}

/// 원본 바이트의 해시(같은 실행 안의 변경 감지용, 보안 용도 아님).
pub fn content_hash(bytes: &[u8]) -> u64 {
    use std::hash::Hasher;
    let mut hasher = std::hash::DefaultHasher::new();
    hasher.write(bytes);
    hasher.finish()
}

/// 저장·사전 검사가 다시 읽을 원본(T009).
#[derive(Clone, Debug)]
pub struct SaveSource {
    pub load: LoadSource,
    pub content_hash: u64,
    pub preflight: Option<Preservation>,
}

/// 진행 중인 저장 하나(T009). 버려지면 저장 중 표시를 지운다.
pub struct SaveTicket<'a> {
    registry: &'a SessionRegistry,
    pub session_id: SessionId,
    pub generation: u64,
    pub revision: u64,
    pub source: SaveSource,
    token: u64,
}

impl Drop for SaveTicket<'_> {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.registry.lock() {
            if let Some(session) = inner.sessions.get_mut(&self.session_id) {
                if session.saving == Some(self.token) {
                    session.saving = None;
                }
            }
        }
    }
}

/// 한 번에 확정할 수 있는 변경 수 상한(프런트엔드가 묶어 보내는 수).
pub const MAX_COMMIT_COUNT: u64 = 1 << 20;

struct Inner {
    next_id: SessionId,
    next_save: u64,
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
                next_save: 1,
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
            load_generation: 0,
        };
        inner.sessions.insert(
            session_id,
            Session {
                info: info.clone(),
                identity: file.identity,
                fingerprint: file.fingerprint,
                clean_revision: 0,
                content_hash: None,
                preflight: None,
                saving: None,
                unconfirmed: false,
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
        session.refresh_dirty();
        Ok((value, session.info.clone()))
    }

    /// 엔진 불러오기를 시작한다(`identified`·`failed` → `loading`). 다시 열 파일 정보를 돌려준다.
    pub fn begin_load(&self, session_id: SessionId) -> Result<LoadSource, DocumentError> {
        self.update(session_id, |session| match session.info.state {
            SessionState::Identified | SessionState::Failed => {
                session.info.state = SessionState::Loading;
                session.info.load_generation += 1;
                Ok(LoadSource {
                    identity: session.identity.clone(),
                    fingerprint: session.fingerprint,
                    format: session.info.format,
                    generation: session.info.load_generation,
                })
            }
            state => Err(DocumentError::InvalidState { session_id, state }),
        })
        .map(|(source, _)| source)
    }

    /// 상태 전이. 허용: `loading`→`ready`, `loading`→`failed`, `ready`→`failed`. `generation`이 지금 불러오기 시도가
    /// 아니면 `StaleLoad`(늦게 끝난 옛 시도)로 거부하고 아무것도 바꾸지 않는다.
    pub fn transition(
        &self,
        session_id: SessionId,
        generation: u64,
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
            Self::check_generation(session, session_id, generation)?;
            if session.info.state != from {
                return Err(DocumentError::InvalidState {
                    session_id,
                    state: session.info.state,
                });
            }
            session.info.state = to;
            if to == Ready {
                session.clean_revision = session.info.revision;
                session.unconfirmed = false;
            }
            Ok(())
        })
        .map(|(_, info)| info)
    }

    fn check_generation(
        session: &Session,
        session_id: SessionId,
        generation: u64,
    ) -> Result<(), DocumentError> {
        if session.info.load_generation != generation {
            return Err(DocumentError::StaleLoad {
                session_id,
                load_generation: session.info.load_generation,
            });
        }
        Ok(())
    }

    /// 테스트용: 지금 불러오기 시도의 번호로 전이한다(WebView 재시작 뒤 맞춤과 같은 경로).
    #[cfg(test)]
    pub fn transition_any_generation(
        &self,
        session_id: SessionId,
        from: SessionState,
        to: SessionState,
    ) -> Result<SessionInfo, DocumentError> {
        let generation = self.get(session_id)?.load_generation;
        self.transition(session_id, generation, from, to)
    }

    /// 엔진 모델에서 성공한 변경 `count`개를 확정한다. 기준 revision이 지금 기록과 같고 `ready`일 때만.
    pub fn commit(
        &self,
        session_id: SessionId,
        generation: u64,
        base_revision: u64,
        count: u64,
    ) -> Result<SessionInfo, DocumentError> {
        if count == 0 || count > MAX_COMMIT_COUNT {
            return Err(DocumentError::InvalidRequest);
        }
        self.update(session_id, |session| {
            // 다시 불러온 모델에는 옛 모델의 변경이 없으므로 옛 시도의 확정은 받지 않는다.
            Self::check_generation(session, session_id, generation)?;
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

    /// 이 시도에서 엔진에 넘긴 원본 바이트의 해시를 기록한다(T009). 옛 시도면 `StaleLoad`. sequence는 바꾸지 않는다.
    pub fn record_content(
        &self,
        session_id: SessionId,
        generation: u64,
        hash: u64,
    ) -> Result<(), DocumentError> {
        let mut inner = self.lock()?;
        let missing = Self::missing(&inner, session_id);
        let session = inner.sessions.get_mut(&session_id).ok_or(missing)?;
        Self::check_generation(session, session_id, generation)?;
        session.content_hash = Some(hash);
        Ok(())
    }

    fn ready_session(
        inner: &mut Inner,
        session_id: SessionId,
        generation: u64,
    ) -> Result<&mut Session, DocumentError> {
        let missing = Self::missing(inner, session_id);
        let session = inner.sessions.get_mut(&session_id).ok_or(missing)?;
        Self::check_generation(session, session_id, generation)?;
        if session.info.state != SessionState::Ready {
            return Err(DocumentError::InvalidState {
                session_id,
                state: session.info.state,
            });
        }
        Ok(session)
    }

    fn save_source(session: &Session, generation: u64) -> Result<SaveSource, DocumentError> {
        // 불러온 바이트의 해시가 없으면(기록 전) 디스크와 비교할 근거가 없다.
        let content_hash = session.content_hash.ok_or(DocumentError::InvalidState {
            session_id: session.info.session_id,
            state: session.info.state,
        })?;
        Ok(SaveSource {
            load: LoadSource {
                identity: session.identity.clone(),
                fingerprint: session.fingerprint,
                format: session.info.format,
                generation,
            },
            content_hash,
            preflight: session
                .preflight
                .as_ref()
                .filter(|(hash, _)| *hash == content_hash)
                .map(|(_, preservation)| preservation.clone()),
        })
    }

    /// 사전 검사가 읽을 원본(T009): `ready`·지금 시도일 때.
    pub fn preflight_source(
        &self,
        session_id: SessionId,
        generation: u64,
    ) -> Result<SaveSource, DocumentError> {
        let mut inner = self.lock()?;
        let session = Self::ready_session(&mut inner, session_id, generation)?;
        Self::save_source(session, generation)
    }

    /// 사전 검사 결과를 그 원본 해시와 함께 기록한다(지금 원본이 그 해시일 때만, 아니면 `FileConflict`).
    pub fn record_preflight(
        &self,
        session_id: SessionId,
        generation: u64,
        hash: u64,
        preservation: Preservation,
    ) -> Result<(), DocumentError> {
        let mut inner = self.lock()?;
        let session = Self::ready_session(&mut inner, session_id, generation)?;
        if session.content_hash != Some(hash) {
            return Err(DocumentError::FileConflict);
        }
        session.preflight = Some((hash, preservation));
        Ok(())
    }

    /// 저장을 시작한다(T009, 모듈 설명).
    pub fn begin_save(
        &self,
        session_id: SessionId,
        generation: u64,
        revision: u64,
    ) -> Result<SaveTicket<'_>, DocumentError> {
        let mut inner = self.lock()?;
        let token = inner.next_save;
        inner.next_save += 1;
        let session = Self::ready_session(&mut inner, session_id, generation)?;
        if session.info.revision != revision {
            return Err(DocumentError::RevisionMismatch {
                session_id,
                revision: session.info.revision,
            });
        }
        if session.saving.is_some() {
            return Err(DocumentError::SaveInProgress { session_id });
        }
        let source = Self::save_source(session, generation)?;
        session.saving = Some(token);
        Ok(SaveTicket {
            registry: self,
            session_id,
            generation,
            revision,
            source,
            token,
        })
    }

    /// 저장을 끝낸다: 잠금 안에서 세션·시도·상태·표를 다시 확인하고 `publish`(원본 교체)를 실행한다. `publish`는
    /// 교체한 파일의 새 식별·지문과 내구성을 돌려준다. 성공하면 파일 기록을 바꾼(내구성을 확인했으면 깨끗한 판도) 세션 정보.
    pub fn finish_save(
        &self,
        ticket: &SaveTicket<'_>,
        new_hash: u64,
        publish: impl FnOnce(&FileIdentity, &FileFingerprint) -> Result<Published, DocumentError>,
    ) -> Result<SessionInfo, DocumentError> {
        let mut inner = self.lock()?;
        let session = Self::ready_session(&mut inner, ticket.session_id, ticket.generation)?;
        if session.saving != Some(ticket.token) {
            return Err(DocumentError::InvalidRequest);
        }
        if session.identity.path() != ticket.source.load.identity.path()
            || session.fingerprint != ticket.source.load.fingerprint
            || session.content_hash != Some(ticket.source.content_hash)
        {
            return Err(DocumentError::FileConflict);
        }
        let published = publish(&session.identity, &session.fingerprint)?;
        session.identity = published.identity;
        session.fingerprint = published.fingerprint;
        session.content_hash = Some(new_hash);
        session.preflight = None;
        if published.durable {
            session.clean_revision = ticket.revision;
        }
        session.unconfirmed = !published.durable;
        session.saving = None;
        session.info.sequence += 1;
        session.refresh_dirty();
        Ok(session.info.clone())
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
