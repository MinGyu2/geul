//! geul 데스크톱 앱 호스트.
//!
//! 6영역 UI 창과 문서 세션 명령(`document` 모듈, T006: 형식 판별·세션 등록·조회·닫기, T007: 엔진에 넘길 바이트 읽기·
//! 상태 전이·revision 확정)을 제공한다. rhwp는 WebView의 WASM으로 연결한다(T007).
//! Linux WebView의 IME 조합 문자열 전달은 `ime` 모듈이 되돌린다. WordCraft(DOCX)는 백엔드에 링크한 네이티브 엔진이
//! 모델을 가진다(T008 W-A, `adapters::wordcraft`). 원본 형식 저장(T009)은 `services::save`가 맡는다(검사 뒤 같은 디렉터리
//! 임시 파일·교체, 충돌·복구의 넓은 범위는 T014).

pub mod adapters;
mod clipboard;
pub mod document;
mod ime;
mod picture;
pub mod services;
mod window_close;

pub fn run() {
    use tauri::Manager;
    tauri::Builder::default()
        .manage(document::commands::DocumentState::default())
        .setup(|app| {
            // WebKitGTK's overlay scrollbar hit region extends into visible page
            // content. Use its native non-overlay gutters so painted page pixels
            // and pointer targets share the same boundary. Process-local only;
            // no input interception or system settings/configuration changes.
            #[cfg(target_os = "linux")]
            if let Some(settings) = gtk::Settings::default() {
                use gtk::prelude::ObjectExt;
                // Access the verified GTK property without raising the locked
                // gtk crate's minimum-version feature requirement.
                if settings.find_property("gtk-overlay-scrolling").is_some() {
                    settings.set_property("gtk-overlay-scrolling", false);
                }
            }

            let data = app.path().app_local_data_dir().ok();
            // T014 A: staging ownership journal in the same private app-data area, then one bounded
            // background pass that removes only staging files proven to be abandoned by an earlier
            // geul save (services/save/journal.rs). Saving never waits for it.
            #[cfg(target_os = "linux")]
            if let Some(journal) = data.as_ref().map(|p| p.join("save-journal")) {
                services::save::journal::configure(journal);
                std::thread::Builder::new()
                    .name("geul-save-cleanup".into())
                    .spawn(|| {
                        let _ = services::save::journal::cleanup();
                    })
                    .ok();
            }
            let root = data.map(|p| p.join("recovery")).unwrap_or_default();
            app.manage(std::sync::Arc::new(services::recovery::RecoveryStore::new(
                root,
            )));
            Ok(())
        })
        .on_window_event(window_close::on_window_event)
        .on_page_load(ime::on_page_load)
        .invoke_handler(tauri::generate_handler![
            services::recovery::recovery_list,
            services::recovery::recovery_restore,
            services::recovery::recovery_discard,
            services::recovery::recovery_forget_session,
            adapters::wordcraft::commands::docx_checkpoint,
            services::files::document_file_dialog,
            services::files::document_new,
            services::save::commands::document_save_as,
            adapters::wordcraft::commands::docx_save_as,
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
            adapters::wordcraft::commands::docx_selection_text,
            clipboard::clipboard_read_text,
            picture::picture_import,
            adapters::wordcraft::commands::docx_edit,
            adapters::wordcraft::commands::docx_render,
            adapters::wordcraft::commands::docx_roundtrip,
            adapters::wordcraft::commands::docx_preflight,
            adapters::wordcraft::commands::docx_save,
            services::save::commands::document_original,
            services::save::commands::document_preflight,
            services::save::commands::document_save,
            services::save::commands::document_checkpoint,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 애플리케이션을 시작하지 못했습니다");
}
