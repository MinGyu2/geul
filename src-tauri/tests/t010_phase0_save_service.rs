//! T010 Phase 0 마무리(시험 전용, 기본 실행 안 함): 진짜 rhwp WASM 출력을 앱과 같은 세션 기록·저장 서비스 경로
//! (`SessionRegistry` → `service::preflight` → `record_preflight` → `commit` → `begin_save` → `service::save`)에 넣는다.
//! 입력 근거(출력 바이트·손실 보고·다시 열기 네 값)는 `tests/poc/t010-phase0/save_inputs.mjs`가 엔진에서 만든 것이고,
//! 이 시험은 그것을 꾸미지 않는다. 구동은 `tests/poc/t010-phase0/save_service.py`가 한다(임시 디렉터리만 쓴다).
//!
//!     GEUL_T010_MANIFEST=<manifest.json> GEUL_T010_RESULTS=<결과.json> cargo test --test t010_phase0_save_service -- --ignored
//!     GEUL_T010_HWP_MUTATE=<원본>\t<편집 출력>\t<출력 디렉터리> cargo test --test t010_phase0_save_service -- --ignored hwp_
//!
//! 변수가 없으면 실패한다(실행 대상 0건을 통과로 보지 않는다).

#![cfg(target_os = "linux")]

use std::io::{Cursor, Read, Write};
use std::path::Path;

use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use geul_lib::document::{
    content_hash, identify, read_identified, Format, Limits, SessionRegistry, SessionState,
};
use geul_lib::services::save::commands::reopen_equal;
use geul_lib::services::save::service;
use serde_json::{json, Value};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name}가 필요하다(모듈 설명)"))
}

fn format_of(name: &str) -> Format {
    match name {
        "hwp" => Format::Hwp,
        "hwpx" => Format::Hwpx,
        other => panic!("형식 {other}"),
    }
}

fn read_json(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn listing(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// 한 사례: 작업 디렉터리의 원본 사본(`target`)을 앱과 같은 순서로 열고 사전 검사·확정·저장한다.
fn save_case(case: &Value) -> Value {
    let format = format_of(case["fmt"].as_str().unwrap());
    let target = case["target"].as_str().unwrap();
    let dir = Path::new(target).parent().unwrap();
    let limits = Limits::default();
    let output = std::fs::read(case["output"].as_str().unwrap()).unwrap();
    let loss = read_json(case["outputLoss"].as_str().unwrap());
    let reopen = case["reopen"].clone();
    let reopen_ok = reopen_equal(&reopen);
    if case["mode"] == "check" {
        // 세션 없이 판정 함수만(원본 사본과 출력).
        let original = std::fs::read(target).unwrap();
        let checked = service::check_saved(format, &original, &output, Some(&loss), reopen_ok);
        return json!({"name": case["name"], "mode": "check", "reopenEqual": reopen_ok, "checkSaved": checked});
    }
    let registry = SessionRegistry::default();
    let info = registry
        .register(identify(target, &limits).unwrap())
        .unwrap();
    let id = info.session_id;
    let load = registry.begin_load(id).unwrap();
    let loaded = read_identified(&load, &limits).unwrap();
    registry
        .record_content(id, load.generation, content_hash(&loaded))
        .unwrap();
    let generation = load.generation;
    registry
        .transition(id, generation, SessionState::Loading, SessionState::Ready)
        .unwrap();
    // 사전 검사: 다시 읽은 원본과 편집 없는 엔진 출력(앱 preflight와 같은 함수).
    let source = registry.preflight_source(id, generation).unwrap();
    let original = service::read_original(&source, &limits).unwrap();
    let unedited = std::fs::read(case["unedited"].as_str().unwrap()).unwrap();
    let unedited_loss = read_json(case["uneditedLoss"].as_str().unwrap());
    let preflight = service::preflight(format, &original, &unedited, Some(&unedited_loss));
    registry
        .record_preflight(id, generation, source.content_hash, preflight.clone())
        .unwrap();
    let committed = registry.commit(id, generation, 0, 1).unwrap();
    // 같은 근거로 판정 함수만 따로(서비스 거부와 구별해 기록).
    let checked = service::check_saved(format, &original, &output, Some(&loss), reopen_ok);
    let before = listing(dir);
    let ticket = registry.begin_save(id, generation, 1).unwrap();
    let saved = service::save(&registry, &ticket, &limits, &output, Some(&loss), reopen_ok);
    drop(ticket);
    let after = listing(dir);
    let on_disk = std::fs::read(target).unwrap();
    let session = registry.get(id).unwrap();
    json!({
        "name": case["name"],
        "mode": "save",
        "preflight": preflight,
        "committedRevision": committed.revision,
        "dirtyBeforeSave": committed.dirty,
        "reopenEqual": reopen_ok,
        "checkSaved": checked,
        "save": match &saved {
            Ok(outcome) => json!({"ok": true, "bytes": outcome.bytes, "durable": outcome.durable}),
            Err(error) => json!({"ok": false, "error": error}),
        },
        "sessionAfter": {"revision": session.revision, "dirty": session.dirty, "state": session.state},
        "targetEqualsOriginal": on_disk == original,
        "targetEqualsOutput": on_disk == output,
        "dirBefore": before,
        "dirAfter": after,
    })
}

#[test]
#[ignore]
fn 진짜_엔진_출력을_저장_서비스에_넣는다() {
    let manifest = read_json(&env("GEUL_T010_MANIFEST"));
    let cases = manifest["cases"].as_array().unwrap();
    assert!(!cases.is_empty(), "사례 0건");
    let results: Vec<Value> = cases.iter().map(save_case).collect();
    std::fs::write(
        env("GEUL_T010_RESULTS"),
        serde_json::to_vec_pretty(&json!({"results": results})).unwrap(),
    )
    .unwrap();
}

// ---- Stage B HWP 대응: 본문 PARA_CHAR_SHAPE가 없는 글자 모양을 가리키게 고친 파일 ----

const TAG_PARA_CHAR_SHAPE: u32 = 68;

/// 레코드 열에서 첫 PARA_CHAR_SHAPE의 첫 모양 ID 자리(바이트 위치).
fn first_char_shape_ref(data: &[u8]) -> Option<usize> {
    let mut at = 0;
    while at + 4 <= data.len() {
        let header = u32::from_le_bytes(data[at..at + 4].try_into().unwrap());
        let (tag, mut size, mut body) = (header & 0x3ff, (header >> 20) as usize, at + 4);
        if size == 0xfff {
            size = u32::from_le_bytes(data[body..body + 4].try_into().unwrap()) as usize;
            body += 4;
        }
        if tag == TAG_PARA_CHAR_SHAPE && size >= 8 {
            return Some(body + 4); // (u32 위치, u32 모양 ID) 쌍의 첫 ID
        }
        at = body + size;
    }
    None
}

fn read_stream(file: &mut cfb::CompoundFile<Cursor<Vec<u8>>>, name: &str) -> Vec<u8> {
    let mut data = Vec::new();
    file.open_stream(name)
        .unwrap()
        .read_to_end(&mut data)
        .unwrap();
    data
}

/// 첫 구역의 첫 글자 모양 참조를 `id`로 바꾼(`None`이면 그대로 둔) 사본과 원래 ID. 압축 여부는 FileHeader 속성 비트
/// 0을 따른다. `drop_previews`면 `PrvText`·`PrvImage` 스트림을 뺀다.
fn with_char_shape_ref(bytes: &[u8], id: Option<u32>, drop_previews: bool) -> (Vec<u8>, u32) {
    let mut file = cfb::CompoundFile::open(Cursor::new(bytes.to_vec())).unwrap();
    let header = read_stream(&mut file, "/FileHeader");
    let compressed = header[36] & 1 == 1;
    let raw = read_stream(&mut file, "/BodyText/Section0");
    let mut data = if compressed {
        let mut out = Vec::new();
        DeflateDecoder::new(&raw[..]).read_to_end(&mut out).unwrap();
        out
    } else {
        raw
    };
    let at = first_char_shape_ref(&data).expect("PARA_CHAR_SHAPE 없음");
    let old = u32::from_le_bytes(data[at..at + 4].try_into().unwrap());
    if let Some(id) = id.filter(|id| *id != old) {
        data[at..at + 4].copy_from_slice(&id.to_le_bytes());
        let stored = if compressed {
            let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(&data).unwrap();
            encoder.finish().unwrap()
        } else {
            data
        };
        file.create_stream("/BodyText/Section0")
            .unwrap()
            .write_all(&stored)
            .unwrap();
    }
    if drop_previews {
        for name in ["/PrvText", "/PrvImage"] {
            if file.exists(name) {
                file.remove_stream(name).unwrap();
            }
        }
    }
    file.flush().unwrap();
    (file.into_inner().into_inner(), old)
}

#[test]
#[ignore]
fn hwp_없는_글자_모양_참조_사본을_만든다() {
    let spec = env("GEUL_T010_HWP_MUTATE");
    let [original, edited, out]: [&str; 3] =
        spec.split('\t').collect::<Vec<_>>().try_into().unwrap();
    let (original, edited, out) = (
        std::fs::read(original).unwrap(),
        std::fs::read(edited).unwrap(),
        Path::new(out),
    );
    let (dangling, old) = with_char_shape_ref(&edited, Some(9999), false);
    std::fs::write(out.join("hwp-b-dangling-9999.hwp"), dangling).unwrap();
    // 미리보기가 없는 쌍(합성): 미리보기 규칙에 가려지지 않을 때 참조 검사가 있는지 본다.
    let (bare_original, _) = with_char_shape_ref(&original, None, true);
    std::fs::write(out.join("hwp-b-nopreview-original.hwp"), bare_original).unwrap();
    let (bare_dangling, _) = with_char_shape_ref(&edited, Some(9999), true);
    std::fs::write(out.join("hwp-b-nopreview-dangling-9999.hwp"), bare_dangling).unwrap();
    let (bare_edited, _) = with_char_shape_ref(&edited, None, true);
    std::fs::write(out.join("hwp-b-nopreview-edited.hwp"), bare_edited).unwrap();
    std::fs::write(
        out.join("hwp-mutation.json"),
        serde_json::to_vec(&json!({"replacedCharShapeId": old, "with": 9999})).unwrap(),
    )
    .unwrap();
}
