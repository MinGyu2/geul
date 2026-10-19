//! T009 저장 검사 도구(시험용 예제). 앱과 같은 판정 함수(`services::save::service::{preflight, check_saved}`)를 파일에
//! 적용해 보존 판정을 JSON으로 출력한다. rhwp(WASM) 왕복 시험(`tests/roundtrip/roundtrip.py`)이 쓴다. 파일을 쓰지 않는다.
//!
//!     cargo run --example save_check -- preflight <hwp|hwpx|docx> <원본> <편집 없는 출력> [손실 보고 JSON 파일]
//!     cargo run --example save_check -- saved <hwp|hwpx|docx> <원본> <편집한 출력> <손실 보고 JSON 파일|-> <reopen: true|false>

use std::process::ExitCode;

use geul_lib::document::Format;
use geul_lib::services::save::service;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let usage = || {
        eprintln!(
            "사용법: save_check preflight|saved <hwp|hwpx|docx> <원본> <출력> [손실 보고] [reopen]"
        );
        ExitCode::from(2)
    };
    let (Some(mode), Some(format), Some(original), Some(output)) =
        (args.first(), args.get(1), args.get(2), args.get(3))
    else {
        return usage();
    };
    let format = match format.as_str() {
        "hwp" => Format::Hwp,
        "hwpx" => Format::Hwpx,
        "docx" => Format::Docx,
        _ => return usage(),
    };
    let read = |path: &str| std::fs::read(path).map_err(|_| eprintln!("읽지 못함: {path}"));
    let (Ok(original), Ok(output)) = (read(original), read(output)) else {
        return ExitCode::from(2);
    };
    let report = match args.get(4).map(String::as_str) {
        None | Some("-") => None,
        Some(path) => match read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
        {
            Some(value) => Some(value),
            None => return ExitCode::from(2),
        },
    };
    let preservation = match mode.as_str() {
        "preflight" => service::preflight(format, &original, &output, report.as_ref()),
        "saved" => {
            let reopen = args.get(5).map(String::as_str) == Some("true");
            service::check_saved(format, &original, &output, report.as_ref(), reopen)
        }
        _ => return usage(),
    };
    println!(
        "{}",
        serde_json::to_string(&preservation).unwrap_or_default()
    );
    ExitCode::SUCCESS
}
