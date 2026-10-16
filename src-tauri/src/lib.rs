//! geul 데스크톱 앱 호스트.
//!
//! 지금은 6영역 UI를 띄우는 창만 제공하며 등록된 Tauri 명령(IPC)이 없다. 문서 형식 판별·세션·엔진 어댑터는
//! T006, 파일 쓰기 서비스는 T009/T014에서 `commands`, `document`, `adapters`, `services` 모듈로 추가한다.
//! 두 엔진(external/rhwp, external/wordcraft)은 아직 의존성으로 연결하지 않았다.

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Tauri 애플리케이션을 시작하지 못했습니다");
}
