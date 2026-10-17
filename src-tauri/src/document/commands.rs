//! 문서 세션 Tauri 명령(IPC). `build.rs`의 앱 매니페스트와 `capabilities/default.json`에서 이 명령만 허용한다.
//!
//! - 경로는 프런트엔드가 보낸 문자열이므로 그대로 믿지 않고 `open::identify`에서 검사한다. 지원 확장자가 아닌 파일은
//!   내용을 읽지 않으며, 응답과 오류에는 경로·문서 내용·운영체제 오류 문구를 담지 않는다. 지금은 열기 대화상자가 없어
//!   경로를 IPC로 받는다. 대화상자를 백엔드가 띄우는 흐름(T009)이 생기면 이 경로 입력을 다시 검토한다.
//! - 판별(파일 읽기)은 차단 작업 스레드에서 하고, 동시에 실행하는 판별 수를 제한한다. 자리는 차단 작업이 끝날 때
//!   돌려준다. 명령 future가 취소돼도 이미 시작한 차단 작업은 멈추지 않으므로, 자리를 future가 아니라 작업이 쥔다.
//! - 셸 실행이나 임의 파일 시스템 접근 명령은 없다.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tauri::State;

use super::error::{DocumentError, LimitKind};
use super::open::{identify, IdentifiedFile, Limits};
use super::session::{CloseOutcome, SessionId, SessionInfo, SessionRegistry};

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

    /// 판별(`identify`)을 차단 작업 스레드에서 실행하고 결과를 등록한다.
    async fn open_with<F>(&self, identify: F) -> Result<SessionInfo, DocumentError>
    where
        F: FnOnce() -> Result<IdentifiedFile, DocumentError> + Send + 'static,
    {
        let pending = self.begin_open()?;
        let identified = tauri::async_runtime::spawn_blocking(move || {
            let _pending = pending;
            identify()
        })
        .await
        .map_err(|_| DocumentError::Internal)??; // 판별 중 패닉은 내부 오류로만 알린다
        self.registry.register(identified)
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
    use crate::document::testutil::{docx, TempDir};
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
}
