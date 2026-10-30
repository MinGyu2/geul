fn main() {
    // A release package must also reject stale dist/ assets when a caller
    // overrides/skips Tauri's frontend hook or invokes Cargo directly.
    println!("cargo:rerun-if-changed=../scripts/rhwp-artifacts.py");
    println!("cargo:rerun-if-changed=../dist/rhwp");
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let status = std::process::Command::new("python3")
            .arg(root.join("scripts/rhwp-artifacts.py"))
            .arg("--verify-product")
            .arg(root.join("dist/rhwp"))
            .args(["--profile", "release"])
            .status()
            .expect("Python 3 is required to validate Release RHWP assets");
        assert!(
            status.success(),
            "Release RHWP assets missing, corrupt, or Debug"
        );
    }
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
        "docx_preflight",
        "docx_save",
        "document_original",
        "document_preflight",
        "document_save",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("Tauri 빌드 설정을 만들지 못했습니다");
}
