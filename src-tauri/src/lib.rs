//! geul 데스크톱 앱 호스트.
//!
//! 6영역 UI 창과 문서 세션 명령(`document` 모듈, T006: 형식 판별·세션 등록·조회·닫기)을 제공한다. 두 엔진
//! (external/rhwp, external/wordcraft)은 아직 의존성으로 연결하지 않았으며, 세션은 형식과 담당 엔진만 정한다.
//! 엔진 연결은 T007/T008, 파일 쓰기 서비스는 T009/T014에서 추가한다.

pub mod document;

pub fn run() {
    tauri::Builder::default()
        .manage(document::commands::DocumentState::default())
        .invoke_handler(tauri::generate_handler![
            document::commands::document_open,
            document::commands::document_close,
            document::commands::document_session,
            document::commands::document_sessions,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 애플리케이션을 시작하지 못했습니다");
}
