//! geul 데스크톱 앱 호스트.
//!
//! 6영역 UI 창과 문서 세션 명령(`document` 모듈, T006: 형식 판별·세션 등록·조회·닫기, T007: 엔진에 넘길 바이트 읽기·
//! 상태 전이·revision 확정)을 제공한다. rhwp는 WebView의 WASM으로 연결한다(T007).
//! Linux WebView의 IME 조합 문자열 전달은 `ime` 모듈이 되돌린다. WordCraft(DOCX)는 백엔드에 링크한 네이티브 엔진이
//! 모델을 가진다(T008 W-A, `adapters::wordcraft`). 파일 쓰기 서비스는 T009/T014에서 추가한다.

pub mod adapters;
pub mod document;
mod ime;
mod window_close;

pub fn run() {
    tauri::Builder::default()
        .manage(document::commands::DocumentState::default())
        .on_window_event(window_close::on_window_event)
        .on_page_load(ime::on_page_load)
        .invoke_handler(tauri::generate_handler![
            window_close::window_close_confirmed,
            document::commands::document_open,
            document::commands::document_close,
            document::commands::document_session,
            document::commands::document_sessions,
            document::commands::document_load,
            document::commands::document_set_state,
            document::commands::document_commit,
            adapters::wordcraft::commands::docx_load,
            adapters::wordcraft::commands::docx_view,
            adapters::wordcraft::commands::docx_edit,
            adapters::wordcraft::commands::docx_render,
            adapters::wordcraft::commands::docx_roundtrip,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 애플리케이션을 시작하지 못했습니다");
}
