//! 문서 세션 Tauri 명령(IPC). `build.rs`의 앱 매니페스트와 `capabilities/default.json`에서 이 명령만 허용한다.
//!
//! - 경로는 프런트엔드가 보낸 문자열이므로 그대로 믿지 않고 `open::identify`에서 검사한다. 지원 확장자가 아닌 파일은
//!   내용을 읽지 않으며, 응답과 오류에는 경로·문서 내용·운영체제 오류 문구를 담지 않는다. 지금은 열기 대화상자가 없어
//!   경로를 IPC로 받는다. 대화상자를 백엔드가 띄우는 흐름(T009)이 생기면 이 경로 입력을 다시 검토한다.
//! - 판별(파일 읽기)은 차단 작업 스레드에서 하고, 동시에 실행하는 판별 수를 제한한다. 자리는 차단 작업이 끝날 때
//!   돌려준다. 명령 future가 취소돼도 이미 시작한 차단 작업은 멈추지 않으므로, 자리를 future가 아니라 작업이 쥔다.
//! - 셸 실행이나 임의 파일 시스템 접근 명령은 없다.
//! - T007 엔진 불러오기·확정: `document_load`는 세션에 기록한 파일만 다시 읽어 판별 때와 같은지 확인한 바이트를
//!   돌려준다(경로 인자 없음, 원시 바이트 응답 — 앞 8바이트는 불러오기 시도 번호). 읽기는 열기와 같은 동시 실행 상한을 쓴다. 명령 future가 끝나기 전에
//!   버려지면 세션을 `loading`에 남기지 않고 `failed`로 돌린다. `document_set_state`·`document_commit`은
//!   `SessionRegistry`의 상태 전이·revision 확정 규칙을 그대로 따른다. 쓰기 명령은 없다(저장은 T009).
//! - T008: 이 세 명령은 문서 모델이 WebView에 있는 엔진(rhwp)의 세션만 받는다. WordCraft 세션은 모델·수명주기·revision을
//!   백엔드(`crate::adapters::wordcraft`)가 직접 바꾸므로, 프런트엔드가 그 세션의 바이트를 받거나 상태·revision을 바꾸는
//!   요청은 `InvalidRequest`로 거부한다(revision 권한이 둘이 되지 않게). 닫기는 그 세션의 엔진 모델도 놓는다.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tauri::ipc::Response;
use tauri::State;

use super::error::{DocumentError, LimitKind};
use super::open::{identify, read_identified, IdentifiedFile, Limits, LoadSource};
use super::session::{CloseOutcome, SessionId, SessionInfo, SessionRegistry, SessionState};
use super::Engine;
use crate::adapters::wordcraft::WordcraftModels;

pub const MAX_PENDING_OPENS: usize = 8;

#[derive(Default)]
pub struct DocumentState {
    // 백엔드 엔진 작업(T008)이 차단 작업 스레드에서 확인·확정까지 하므로 함께 쥘 수 있게 Arc로 둔다.
    registry: Arc<SessionRegistry>,
    limits: Limits,
    pending_opens: Arc<AtomicUsize>,
    /// 백엔드가 가진 WordCraft 문서 모델(T008). 세션을 닫으면 놓는다.
    wordcraft: WordcraftModels,
}

/// 진행 중인 판별 하나의 자리. 차단 작업과 함께 버려질 때(성공·실패·패닉, 작업이 시작되지 못한 경우 포함) 수를
/// 돌려놓는다.
struct PendingOpen(Arc<AtomicUsize>);

impl Drop for PendingOpen {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl DocumentState {
    pub(crate) fn registry(&self) -> &Arc<SessionRegistry> {
        &self.registry
    }

    pub(crate) fn wordcraft(&self) -> &WordcraftModels {
        &self.wordcraft
    }

    /// 프런트엔드가 모델을 가진 엔진(rhwp)의 세션인지. 아니면 `InvalidRequest`(T008, 모듈 설명).
    pub(crate) fn frontend_model(&self, session_id: SessionId) -> Result<(), DocumentError> {
        match self.registry.get(session_id)?.engine {
            Engine::Rhwp => Ok(()),
            Engine::Wordcraft => Err(DocumentError::InvalidRequest),
        }
    }

    fn begin_open(&self) -> Result<PendingOpen, DocumentError> {
        let previous = self.pending_opens.fetch_add(1, Ordering::AcqRel);
        let pending = PendingOpen(self.pending_opens.clone());
        if previous >= MAX_PENDING_OPENS {
            return Err(DocumentError::ResourceLimit {
                limit: LimitKind::PendingOpens,
            });
        }
        Ok(pending)
    }

    /// 파일을 읽는 작업을 차단 작업 스레드에서 실행한다. 자리는 작업이 끝날 때 돌려준다.
    pub(crate) async fn run_blocking<T, F>(&self, work: F) -> Result<T, DocumentError>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, DocumentError> + Send + 'static,
    {
        let pending = self.begin_open()?;
        tauri::async_runtime::spawn_blocking(move || {
            let _pending = pending;
            work()
        })
        .await
        .map_err(|_| DocumentError::Internal)? // 작업 중 패닉은 내부 오류로만 알린다
    }

    /// 판별(`identify`)을 차단 작업 스레드에서 실행하고 결과를 등록한다.
    async fn open_with<F>(&self, identify: F) -> Result<SessionInfo, DocumentError>
    where
        F: FnOnce() -> Result<IdentifiedFile, DocumentError> + Send + 'static,
    {
        let identified = self.run_blocking(identify).await?;
        self.registry.register(identified)
    }

    /// 세션의 파일을 엔진에 넘길 바이트로 읽는다(`identified`·`failed` → `loading`). 실패하거나 끝나기 전에 버려지면
    /// 이 시도가 아직 지금 시도일 때만 `failed`로 돌린다. 읽는 동안 세션이 닫히거나 새 시도가 시작되면 바이트를
    /// 버리고 오류를 돌려준다. 성공하면 (시도 번호, 바이트).
    pub(crate) async fn load_bytes(
        &self,
        session_id: SessionId,
    ) -> Result<(u64, Vec<u8>), DocumentError> {
        self.load_bytes_with(session_id, read_identified).await
    }

    // 읽기만 주입한다(등록·generation·가드·검증 경로는 동일). 테스트는 실제 파일 읽기를 gate 뒤에서 실행한다.
    async fn load_bytes_with<F>(
        &self,
        session_id: SessionId,
        read: F,
    ) -> Result<(u64, Vec<u8>), DocumentError>
    where
        F: FnOnce(&LoadSource, &Limits) -> Result<Vec<u8>, DocumentError> + Send + 'static,
    {
        let source = self.registry.begin_load(session_id)?;
        let generation = source.generation;
        let guard = LoadingGuard::arm(&self.registry, session_id, generation);
        let limits = self.limits;
        let bytes = self.run_blocking(move || read(&source, &limits)).await?;
        let info = self.registry.get(session_id)?;
        if info.load_generation != generation {
            return Err(DocumentError::StaleLoad {
                session_id,
                load_generation: info.load_generation,
            });
        }
        if info.state != SessionState::Loading {
            return Err(DocumentError::InvalidState {
                session_id,
                state: info.state,
            });
        }
        guard.disarm();
        Ok((generation, bytes))
    }
}

/// `document_load` 응답: 앞 8바이트는 불러오기 시도 번호(u64 little-endian), 나머지는 문서 바이트.
pub const LOAD_HEADER_LEN: usize = 8;

fn load_response(generation: u64, bytes: Vec<u8>) -> Vec<u8> {
    let mut framed = Vec::with_capacity(LOAD_HEADER_LEN + bytes.len());
    framed.extend_from_slice(&generation.to_le_bytes());
    framed.extend_from_slice(&bytes);
    framed
}

/// 불러오기가 성공해 바이트를 넘기기 전에 끝나면(오류·future 취소) 세션을 `loading`에 남기지 않는다. 백엔드가 엔진에
/// 불러오는 경우(T008)에는 엔진이 문서를 읽고 `ready`로 전이할 때까지 같은 가드를 쓴다.
pub(crate) struct LoadingGuard<'a> {
    registry: &'a SessionRegistry,
    session_id: SessionId,
    generation: u64,
    armed: bool,
}

impl<'a> LoadingGuard<'a> {
    pub(crate) fn arm(
        registry: &'a SessionRegistry,
        session_id: SessionId,
        generation: u64,
    ) -> Self {
        LoadingGuard {
            registry,
            session_id,
            generation,
            armed: true,
        }
    }

    /// 불러오기가 끝까지 갔다(이 시도의 결과는 호출한 쪽이 정한다).
    pub(crate) fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for LoadingGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            // 이미 닫혔거나 다른 상태이거나 새 불러오기 시도가 시작됐으면 바꾸지 않는다.
            let _ = self.registry.transition(
                self.session_id,
                self.generation,
                SessionState::Loading,
                SessionState::Failed,
            );
        }
    }
}

#[tauri::command]
pub async fn document_open(
    state: State<'_, DocumentState>,
    path: String,
) -> Result<SessionInfo, DocumentError> {
    let limits = state.limits;
    state.open_with(move || identify(&path, &limits)).await
}

/// 세션의 문서 바이트(원시 응답, 앞 8바이트는 불러오기 시도 번호). 경로는 받지 않는다.
#[tauri::command]
pub async fn document_load(
    state: State<'_, DocumentState>,
    session_id: SessionId,
) -> Result<Response, DocumentError> {
    state.frontend_model(session_id)?;
    let (generation, bytes) = state.load_bytes(session_id).await?;
    Ok(Response::new(load_response(generation, bytes)))
}

#[tauri::command]
pub fn document_set_state(
    state: State<'_, DocumentState>,
    session_id: SessionId,
    load_generation: u64,
    from: SessionState,
    to: SessionState,
) -> Result<SessionInfo, DocumentError> {
    state.frontend_model(session_id)?;
    state
        .registry
        .transition(session_id, load_generation, from, to)
}

#[tauri::command]
pub fn document_commit(
    state: State<'_, DocumentState>,
    session_id: SessionId,
    load_generation: u64,
    base_revision: u64,
    count: u64,
) -> Result<SessionInfo, DocumentError> {
    state.frontend_model(session_id)?;
    state
        .registry
        .commit(session_id, load_generation, base_revision, count)
}

#[tauri::command]
pub fn document_close(
    state: State<'_, DocumentState>,
    session_id: SessionId,
) -> Result<CloseOutcome, DocumentError> {
    let outcome = state.registry.close(session_id)?;
    // 기록에서 빠진 뒤에 놓는다. 그사이 끝난 엔진 작업은 확정(StaleSession)·상태 전이를 하지 못하고 결과를 버린다.
    state.wordcraft.release(session_id);
    Ok(outcome)
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

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::task::{Context, Poll, Waker};
    use std::time::{Duration, Instant};

    use super::*;
    use crate::document::testutil::{docx, hwp, hwpx, TempDir};
    use crate::document::ReadProblem;

    /// 테스트가 직접 폴링하는 불러오기 작업(시도 번호, 바이트).
    type LoadFuture<'a> = Pin<Box<dyn Future<Output = Result<(u64, Vec<u8>), DocumentError>> + 'a>>;

    type Open<'a> = Pin<Box<dyn Future<Output = Result<SessionInfo, DocumentError>> + 'a>>;
    type Identify = Box<dyn FnOnce() -> Result<IdentifiedFile, DocumentError> + Send>;

    const WAIT: Duration = Duration::from_secs(20);

    fn poll_once(open: &mut Open<'_>) -> Poll<Result<SessionInfo, DocumentError>> {
        open.as_mut().poll(&mut Context::from_waker(Waker::noop()))
    }

    fn pending(state: &DocumentState) -> usize {
        state.pending_opens.load(Ordering::Acquire)
    }

    /// 실제로 실행 중인 판별 수와 그 최댓값.
    #[derive(Default)]
    struct Probe {
        running: AtomicUsize,
        peak: AtomicUsize,
    }

    /// 시작을 알리고, 테스트가 풀어 줄 때까지 멈춰 있다가 `then`을 실행하는 판별 작업.
    fn gated(
        probe: &Arc<Probe>,
        started: &Sender<()>,
        then: impl FnOnce() -> Result<IdentifiedFile, DocumentError> + Send + 'static,
    ) -> (Identify, Sender<()>) {
        let (release, released) = mpsc::channel::<()>();
        let (probe, started) = (probe.clone(), started.clone());
        let op: Identify = Box::new(move || {
            let now = probe.running.fetch_add(1, Ordering::AcqRel) + 1;
            probe.peak.fetch_max(now, Ordering::AcqRel);
            started.send(()).unwrap();
            let _ = released.recv();
            probe.running.fetch_sub(1, Ordering::AcqRel);
            then()
        });
        (op, release)
    }

    const IO: DocumentError = DocumentError::Unreadable {
        reason: ReadProblem::Io,
    };

    fn io_error() -> Result<IdentifiedFile, DocumentError> {
        Err(IO)
    }

    fn wait_started(started: &Receiver<()>, count: usize) {
        for _ in 0..count {
            started
                .recv_timeout(WAIT)
                .expect("판별 작업이 시작되지 않음");
        }
    }

    fn saturated() -> Result<SessionInfo, DocumentError> {
        Err(DocumentError::ResourceLimit {
            limit: LimitKind::PendingOpens,
        })
    }

    #[test]
    fn 기다리기를_그만둔_열기도_판별이_끝날_때까지_자리를_차지한다() {
        let state = DocumentState::default();
        let probe = Arc::new(Probe::default());
        let (started, started_rx) = mpsc::channel();
        let mut releases = Vec::new();
        let mut opens: Vec<Open<'_>> = Vec::new();
        for _ in 0..MAX_PENDING_OPENS {
            let (op, release) = gated(&probe, &started, io_error);
            releases.push(release);
            let mut open: Open<'_> = Box::pin(state.open_with(op));
            assert!(poll_once(&mut open).is_pending());
            opens.push(open);
        }
        wait_started(&started_rx, MAX_PENDING_OPENS);

        // 비동기 호출자가 모두 사라져도(명령 future 취소) 차단 작업은 계속 실행 중이다.
        drop(opens);
        assert_eq!(probe.running.load(Ordering::Acquire), MAX_PENDING_OPENS);
        assert_eq!(pending(&state), MAX_PENDING_OPENS);
        let (op, _release) = gated(&probe, &started, io_error);
        let mut excess: Open<'_> = Box::pin(state.open_with(op));
        assert_eq!(poll_once(&mut excess), Poll::Ready(saturated()));
        assert!(
            started_rx.try_recv().is_err(),
            "거부한 열기의 판별이 시작됨"
        );
        assert_eq!(probe.peak.load(Ordering::Acquire), MAX_PENDING_OPENS);

        // 판별이 끝나면 자리를 돌려주고, 취소된 열기는 세션을 남기지 않는다.
        for release in releases {
            release.send(()).unwrap();
        }
        let deadline = Instant::now() + WAIT;
        while pending(&state) != 0 {
            assert!(Instant::now() < deadline, "자리를 돌려주지 않음");
            std::thread::yield_now();
        }
        assert_eq!(state.registry.list().unwrap(), vec![]);
        let dir = TempDir::new();
        let path = dir.write("a.docx", &docx()).to_str().unwrap().to_owned();
        let opened = tauri::async_runtime::block_on(
            state.open_with(move || identify(&path, &Limits::default())),
        )
        .unwrap();
        assert_eq!(opened.session_id, 1);
        assert_eq!(pending(&state), 0);
    }

    #[test]
    fn 포화·실패·패닉·성공_뒤에_자리를_정확히_돌려준다() {
        let state = DocumentState::default();
        let probe = Arc::new(Probe::default());
        let (started, started_rx) = mpsc::channel();
        let dir = TempDir::new();
        let path = dir.write("ok.docx", &docx()).to_str().unwrap().to_owned();
        let mut thens = [
            Box::new(|| -> Result<IdentifiedFile, DocumentError> {
                panic!("판별 중 패닉 재현")
            }) as Identify,
            Box::new(io_error),
            Box::new(move || identify(&path, &Limits::default())),
        ]
        .into_iter();
        let mut releases = Vec::new();
        let mut opens: Vec<Open<'_>> = Vec::new();
        for _ in 0..MAX_PENDING_OPENS {
            let then = thens.next().unwrap_or_else(|| Box::new(io_error));
            let (op, release) = gated(&probe, &started, then);
            releases.push(release);
            let mut open: Open<'_> = Box::pin(state.open_with(op));
            assert!(poll_once(&mut open).is_pending());
            opens.push(open);
        }
        wait_started(&started_rx, MAX_PENDING_OPENS);
        // 포화: 넘친 요청은 거부되고 자리를 쓰지 않는다(여러 번 거부해도 그대로).
        for _ in 0..3 {
            let (op, _release) = gated(&probe, &started, io_error);
            let mut excess: Open<'_> = Box::pin(state.open_with(op));
            assert_eq!(poll_once(&mut excess), Poll::Ready(saturated()));
            assert_eq!(pending(&state), MAX_PENDING_OPENS);
        }
        assert!(started_rx.try_recv().is_err());

        let expected = [
            DocumentError::Internal, // 패닉은 내부 오류로만 알린다
            IO,
        ];
        let mut opens = opens.into_iter();
        let mut releases = releases.into_iter();
        for (left, expected) in (1..).zip(expected) {
            releases.next().unwrap().send(()).unwrap();
            let result = tauri::async_runtime::block_on(opens.next().unwrap());
            assert_eq!(result, Err(expected));
            assert_eq!(pending(&state), MAX_PENDING_OPENS - left);
        }
        releases.next().unwrap().send(()).unwrap();
        let opened = tauri::async_runtime::block_on(opens.next().unwrap()).unwrap();
        assert_eq!(opened.session_id, 1);
        assert_eq!(pending(&state), MAX_PENDING_OPENS - 3);
        for (open, release) in opens.zip(releases) {
            release.send(()).unwrap();
            assert!(tauri::async_runtime::block_on(open).is_err());
        }
        assert_eq!(pending(&state), 0);
        assert_eq!(probe.peak.load(Ordering::Acquire), MAX_PENDING_OPENS);
        assert_eq!(state.registry.list().unwrap(), vec![opened]);
    }

    fn opened(state: &DocumentState, dir: &TempDir, name: &str, bytes: &[u8]) -> SessionInfo {
        let path = dir.write(name, bytes).to_str().unwrap().to_owned();
        tauri::async_runtime::block_on(state.open_with(move || identify(&path, &Limits::default())))
            .unwrap()
    }

    #[test]
    fn 불러오기는_세션의_파일_바이트를_돌려주고_실패하면_failed로_돌린다() {
        let state = DocumentState::default();
        let dir = TempDir::new();
        let ok = opened(&state, &dir, "ok.hwpx", &hwpx());
        let (generation, bytes) =
            tauri::async_runtime::block_on(state.load_bytes(ok.session_id)).unwrap();
        assert_eq!((generation, bytes), (1, hwpx()));
        assert_eq!(
            state.registry.get(ok.session_id).unwrap().state,
            SessionState::Loading
        );
        assert_eq!(pending(&state), 0);

        let gone = opened(&state, &dir, "gone.hwpx", &hwpx());
        std::fs::remove_file(dir.path().join("gone.hwpx")).unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(state.load_bytes(gone.session_id)),
            Err(DocumentError::Unreadable {
                reason: ReadProblem::NotFound
            })
        );
        assert_eq!(
            state.registry.get(gone.session_id).unwrap().state,
            SessionState::Failed
        );
        assert_eq!(pending(&state), 0);
    }

    /// 파일 작업이 끝나기 전에만 취소·닫기·교체한다. 첫 poll 결과를 무시하면 빠른 파일 읽기가 이미
    /// Ready여서 완료된 future를 다시 poll하거나 취소 가드가 전혀 동작하지 않는 거짓 검증이 된다.
    fn gated_load(state: &DocumentState, id: SessionId) -> (LoadFuture<'_>, Sender<()>) {
        let (release, released) = mpsc::channel();
        let (started, started_rx) = mpsc::channel();
        let mut load: LoadFuture<'_> =
            Box::pin(state.load_bytes_with(id, move |source, limits| {
                started.send(()).unwrap();
                released
                    .recv_timeout(WAIT)
                    .expect("불러오기 gate 해제 안 됨");
                read_identified(source, limits)
            }));
        assert!(load
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending());
        wait_started(&started_rx, 1);
        (load, release)
    }

    fn wait_no_pending(state: &DocumentState) {
        let deadline = Instant::now() + WAIT;
        while pending(state) != 0 {
            assert!(
                Instant::now() < deadline,
                "불러오기 작업이 자리를 돌려주지 않음"
            );
            std::thread::yield_now();
        }
    }

    #[test]
    fn 기다리기를_그만둔_불러오기는_세션을_loading에_남기지_않는다() {
        let state = DocumentState::default();
        let dir = TempDir::new();
        let info = opened(&state, &dir, "a.hwpx", &hwpx());
        let (load, release) = gated_load(&state, info.session_id);
        assert_eq!(
            state.registry.get(info.session_id).unwrap().state,
            SessionState::Loading
        );
        drop(load);
        release.send(()).unwrap();
        wait_no_pending(&state);
        assert_eq!(
            state.registry.get(info.session_id).unwrap().state,
            SessionState::Failed
        );
        // 다시 불러올 수 있다.
        assert!(tauri::async_runtime::block_on(state.load_bytes(info.session_id)).is_ok());
    }

    #[test]
    fn 불러오는_중에_닫은_세션은_되살아나지_않는다() {
        let state = DocumentState::default();
        let dir = TempDir::new();
        let info = opened(&state, &dir, "a.hwp", &hwp());
        let (load, release) = gated_load(&state, info.session_id);
        state.registry.close(info.session_id).unwrap();
        release.send(()).unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(load),
            Err(DocumentError::StaleSession {
                session_id: info.session_id
            })
        );
        assert_eq!(state.registry.list().unwrap(), vec![]);
        assert_eq!(pending(&state), 0);
    }

    #[test]
    fn 늦게_끝난_옛_불러오기는_새_불러오기의_상태를_바꾸지_않는다() {
        for complete in [false, true] {
            let state = DocumentState::default();
            let dir = TempDir::new();
            let info = opened(&state, &dir, "a.hwpx", &hwpx());
            let id = info.session_id;
            let (a, release) = gated_load(&state, id);
            state
                .registry
                .transition_any_generation(id, SessionState::Loading, SessionState::Failed)
                .unwrap();
            let b = tauri::async_runtime::block_on(state.load_bytes(id));
            assert!(b.is_ok());
            assert_eq!(state.registry.get(id).unwrap().state, SessionState::Loading);
            // A가 늦게 완료되든 취소되든 B의 loading을 failed로 바꾸지 않는다.
            if complete {
                release.send(()).unwrap();
                assert_eq!(
                    tauri::async_runtime::block_on(a),
                    Err(DocumentError::StaleLoad {
                        session_id: id,
                        load_generation: 2
                    })
                );
            } else {
                drop(a);
                release.send(()).unwrap();
            }
            wait_no_pending(&state);
            assert_eq!(state.registry.get(id).unwrap().state, SessionState::Loading);
        }
    }

    #[test]
    fn 불러오기_응답은_시도_번호_8바이트_뒤에_문서_바이트() {
        let framed = load_response(0x0102_0304_0506_0708, vec![0xAA, 0xBB]);
        assert_eq!(framed.len(), LOAD_HEADER_LEN + 2);
        assert_eq!(&framed[..8], &0x0102_0304_0506_0708u64.to_le_bytes());
        assert_eq!(&framed[8..], &[0xAA, 0xBB]);
    }
}
