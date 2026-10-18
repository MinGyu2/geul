fn main() {
    // 앱 명령을 매니페스트에 올려 capabilities/default.json에서 명시적으로 허용한 것만 쓰게 한다.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "window_close_confirmed",
        "document_open",
        "document_close",
        "document_session",
        "document_sessions",
        "document_load",
        "document_set_state",
        "document_commit",
        "docx_load",
        "docx_view",
        "docx_edit",
        "docx_render",
        "docx_roundtrip",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("Tauri 빌드 설정을 만들지 못했습니다");
}
