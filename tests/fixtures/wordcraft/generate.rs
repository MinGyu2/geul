// T008 DOCX 픽스처 생성기. 실행할 때 출력 디렉터리에 basic-ko.docx와 내용 설명(basic-ko.json), 문서 보호 픽스처(T010 안정화:
// protected-readonly.docx·protected-regions.docx)를 만든다.
//
//     cargo run --manifest-path src-tauri/Cargo.toml --example wordcraft_fixture -- <출력 디렉터리>
//
// 문서는 고정 커밋 WordCraft(external/wordcraft)의 엔진 명령으로 만든다(basic.rs). 실제 앱 시험
// (tests/integration/wordcraft/wordcraft_poc.py)이 이 생성기를 부른다.

#[path = "basic.rs"]
mod basic;

use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let Some(out) = std::env::args_os().nth(1).map(PathBuf::from) else {
        eprintln!("출력 디렉터리를 지정하세요");
        return ExitCode::from(2);
    };
    let bytes = match basic::basic_ko() {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("픽스처를 만들지 못함: {error}");
            return ExitCode::FAILURE;
        }
    };
    let report = serde_json::json!({
        "content": {
            "paragraphs": basic::PARAGRAPHS,
            "boldChars": basic::BOLD_CHARS,
            "cells": basic::CELLS,
            "after": basic::AFTER,
        },
        "paths": { "tableBlock": basic::TABLE_BLOCK, "afterBlock": basic::AFTER_BLOCK },
        "bytes": bytes.len(),
    });
    // T010 안정화: 문서 보호 픽스처(읽기 전용, 읽기 전용 + 첫 두 글자 편집 가능 영역).
    let protected = match (
        basic::protected_ko("readOnly", false),
        basic::protected_ko("readOnly", true),
    ) {
        (Ok(read_only), Ok(regions)) => (read_only, regions),
        (Err(error), _) | (_, Err(error)) => {
            eprintln!("보호 픽스처를 만들지 못함: {error}");
            return ExitCode::FAILURE;
        }
    };
    let written = std::fs::create_dir_all(&out)
        .and_then(|_| std::fs::write(out.join("basic-ko.docx"), &bytes))
        .and_then(|_| std::fs::write(out.join("protected-readonly.docx"), &protected.0))
        .and_then(|_| std::fs::write(out.join("protected-regions.docx"), &protected.1))
        .and_then(|_| std::fs::write(out.join("basic-ko.json"), report.to_string()));
    if let Err(error) = written {
        eprintln!("쓰지 못함: {error}");
        return ExitCode::FAILURE;
    }
    println!("{report}");
    ExitCode::SUCCESS
}
