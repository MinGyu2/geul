//! 문서 세션 Tauri 명령(IPC). `build.rs`의 앱 매니페스트와 `capabilities/default.json`에서 이 명령만 허용한다.
//!
//! - 경로는 프런트엔드가 보낸 문자열이므로 그대로 믿지 않고 `open::identify`에서 검사한다. 지원 확장자가 아닌 파일은
//!   내용을 읽지 않으며, 응답과 오류에는 경로·문서 내용·운영체제 오류 문구를 담지 않는다. 지금은 열기 대화상자가 없어
//!   경로를 IPC로 받는다. 대화상자를 백엔드가 띄우는 흐름(T009)이 생기면 이 경로 입력을 다시 검토한다.
//! - 판별(파일 읽기)은 차단 작업 스레드에서 하고, 동시에 실행하는 판별 수를 제한한다. 자리는 차단 작업이 끝날 때
//!   돌려준다. 명령 future가 취소돼도 이미 시작한 차단 작업은 멈추지 않으므로, 자리를 future가 아니라 작업이 쥔다.
//! - 셸 실행이나 임의 파일 시스템 접근 명령은 없다.
//! - T007 엔진 불러오기·확정: `document_load`는 세션에 기록한 파일만 다시 읽어 판별 때와 같은지 확인한 바이트를
//!   돌려준다(경로 인자 없음, 원시 바이트 응답). 읽기는 열기와 같은 동시 실행 상한을 쓴다. 명령 future가 끝나기 전에
//!   버려지면 세션을 `loading`에 남기지 않고 `failed`로 돌린다. `document_set_state`·`document_commit`은
//!   `SessionRegistry`의 상태 전이·revision 확정 규칙을 그대로 따른다. 쓰기 명령은 없다(저장은 T009).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tauri::ipc::Response;
use tauri::State;

use super::error::{DocumentError, LimitKind};
use super::open::{identify, read_identified, IdentifiedFile, Limits};
use super::session::{CloseOutcome, SessionId, SessionInfo, SessionRegistry, SessionState};

pub const MAX_PENDING_OPENS: usize = 8;

#[derive(Default)]
pub struct DocumentState {
    registry: SessionRegistry,
    limits: Limits,
    pending_opens: Arc<AtomicUsize>,
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
    async fn run_blocking<T, F>(&self, work: F) -> Result<T, DocumentError>
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
    /// `failed`로 돌린다. 읽는 동안 세션이 닫히면 바이트를 버리고 그 오류를 돌려준다.
    async fn load_bytes(&self, session_id: SessionId) -> Result<Vec<u8>, DocumentError> {
        let source = self.registry.begin_load(session_id)?;
        let mut guard = LoadingGuard {
            registry: &self.registry,
            session_id,
            armed: true,
        };
        let limits = self.limits;
        let bytes = self
            .run_blocking(move || read_identified(&source, &limits))
            .await?;
        let info = self.registry.get(session_id)?;
        if info.state != SessionState::Loading {
            return Err(DocumentError::InvalidState {
                session_id,
                state: info.state,
            });
        }
        guard.armed = false;
        Ok(bytes)
    }
}

/// 불러오기가 성공해 바이트를 넘기기 전에 끝나면(오류·future 취소) 세션을 `loading`에 남기지 않는다.
struct LoadingGuard<'a> {
    registry: &'a SessionRegistry,
    session_id: SessionId,
    armed: bool,
}

impl Drop for LoadingGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            // 이미 닫혔거나 다른 상태면 바꾸지 않는다.
            let _ = self.registry.transition(
                self.session_id,
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

/// 세션의 문서 바이트(원시 응답). 경로는 받지 않는다.
#[tauri::command]
pub async fn document_load(
    state: State<'_, DocumentState>,
    session_id: SessionId,
) -> Result<Response, DocumentError> {
    state.load_bytes(session_id).await.map(Response::new)
}

#[tauri::command]
pub fn document_set_state(
    state: State<'_, DocumentState>,
    session_id: SessionId,
    from: SessionState,
    to: SessionState,
) -> Result<SessionInfo, DocumentError> {
    state.registry.transition(session_id, from, to)
}

#[tauri::command]
pub fn document_commit(
    state: State<'_, DocumentState>,
    session_id: SessionId,
    base_revision: u64,
    count: u64,
) -> Result<SessionInfo, DocumentError> {
    state.registry.commit(session_id, base_revision, count)
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
        let bytes = tauri::async_runtime::block_on(state.load_bytes(ok.session_id)).unwrap();
        assert_eq!(bytes, hwpx());
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

    #[test]
    fn 기다리기를_그만둔_불러오기는_세션을_loading에_남기지_않는다() {
        let state = DocumentState::default();
        let dir = TempDir::new();
        let info = opened(&state, &dir, "a.hwpx", &hwpx());
        let mut load: Pin<Box<dyn Future<Output = Result<Vec<u8>, DocumentError>> + '_>> =
            Box::pin(state.load_bytes(info.session_id));
        let _ = load.as_mut().poll(&mut Context::from_waker(Waker::noop()));
        assert_eq!(
            state.registry.get(info.session_id).unwrap().state,
            SessionState::Loading
        );
        drop(load);
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
        let mut load: Pin<Box<dyn Future<Output = Result<Vec<u8>, DocumentError>> + '_>> =
            Box::pin(state.load_bytes(info.session_id));
        let _ = load.as_mut().poll(&mut Context::from_waker(Waker::noop()));
        state.registry.close(info.session_id).unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(load),
            Err(DocumentError::StaleSession {
                session_id: info.session_id
            })
        );
        assert_eq!(state.registry.list().unwrap(), vec![]);
        assert_eq!(pending(&state), 0);
    }
}
