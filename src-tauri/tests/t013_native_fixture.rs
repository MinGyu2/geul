//! Optional native-test input normalization through the pinned WordCraft engine.
//! The input is a deliberately generated fixture, never a user document. This
//! grants no publication authority; the real save service still validates it.
use std::io::Write;

#[test]
#[ignore = "set GEUL_NATIVE_DOCX_INPUT and GEUL_NATIVE_DOCX_OUTPUT to new fixture paths"]
fn normalize_generated_native_fixture() {
    let input = std::env::var_os("GEUL_NATIVE_DOCX_INPUT").expect("generated input required");
    let output = std::env::var_os("GEUL_NATIVE_DOCX_OUTPUT").expect("new output required");
    let bytes = std::fs::read(input).unwrap();
    let doc = wordcraft_engine::io::open_bytes("fixture.docx", &bytes).unwrap();
    let normalized = wordcraft_engine::io::save_bytes("fixture.docx", &doc).unwrap();
    wordcraft_engine::io::open_bytes("fixture.docx", &normalized).unwrap();
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .unwrap();
    file.write_all(&normalized).unwrap();
    file.sync_all().unwrap();
}
