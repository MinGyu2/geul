// T008 DOCX 기본 픽스처를 WordCraft 엔진 명령으로 만든다(저장소에 바이너리를 두지 않는다, tests/fixtures/README.md).
// 내용은 T007 rhwp 픽스처(tests/fixtures/rhwp/generate.mjs)와 같다: 한·영 문단, 굵게, 2×2 표, 표 다음 문단.
// Rust 시험(src-tauri/src/adapters/wordcraft/tests.rs)과 생성기(generate.rs)가 `#[path]`로 함께 쓴다.

use serde_json::json;
use wordcraft_engine::doc::{Path, Pos, StoryRef};
use wordcraft_engine::{blank_document, io, Session};

pub const PARAGRAPHS: [&str; 2] = ["한글 문단입니다. Korean paragraph.", "굵은 글씨 Bold text"];
/// 둘째 문단에서 굵게 한 범위(문자 단위 [0, 5)).
pub const BOLD_CHARS: usize = 5;
pub const CELLS: [&str; 4] = ["셀 하나", "Cell two", "셋째 칸", "Fourth"];
pub const AFTER: &str = "표 다음 문단 End.";
/// 문단 경로(WordCraft `Path`): 본문 [0], [1], 표 [2](셀 문단 [2, 행, 열, 0]), 표 다음 [3].
pub const TABLE_BLOCK: u32 = 2;
pub const AFTER_BLOCK: u32 = 3;

fn run(session: &mut Session, id: &str, params: serde_json::Value) -> Result<(), String> {
    session
        .run(id, &params)
        .map(|_| ())
        .map_err(|error| format!("{id}: {error}"))
}

fn body(path: &[u32], off: usize) -> Pos {
    Pos::new(StoryRef::Body, Path(path.to_vec()), off)
}

fn byte_len(text: &str, chars: usize) -> usize {
    text.char_indices()
        .nth(chars)
        .map_or(text.len(), |(at, _)| at)
}

/// 픽스처 DOCX 바이트. 만든 문서가 기대한 구조가 아니면 오류다.
pub fn basic_ko() -> Result<Vec<u8>, String> {
    let mut s = Session::new(blank_document(&Default::default()));
    let insert =
        |s: &mut Session, text: &str| run(s, "text.insert", json!({ "text": text, "raw": true }));
    insert(&mut s, PARAGRAPHS[0])?;
    run(&mut s, "text.newParagraph", json!({}))?;
    insert(&mut s, PARAGRAPHS[1])?;
    let bold = byte_len(PARAGRAPHS[1], BOLD_CHARS);
    run(
        &mut s,
        "select.range",
        json!({ "anchor": body(&[1], 0), "focus": body(&[1], bold) }),
    )?;
    run(&mut s, "format.bold", json!({}))?;
    run(
        &mut s,
        "caret.set",
        json!({ "pos": body(&[1], PARAGRAPHS[1].len()) }),
    )?;
    run(&mut s, "text.newParagraph", json!({}))?;
    run(&mut s, "insert.table", json!({ "rows": 2, "cols": 2 }))?;
    for (index, text) in CELLS.iter().enumerate() {
        if index > 0 {
            run(&mut s, "text.tab", json!({}))?;
        }
        insert(&mut s, text)?;
    }
    run(&mut s, "caret.docEnd", json!({}))?;
    insert(&mut s, AFTER)?;

    let doc = &s.doc;
    let text = |path: &[u32]| {
        doc.para(StoryRef::Body, &Path(path.to_vec()))
            .map(|p| p.text.clone())
    };
    let mut expected = vec![
        (vec![0], PARAGRAPHS[0]),
        (vec![1], PARAGRAPHS[1]),
        (vec![AFTER_BLOCK], AFTER),
    ];
    for (index, cell) in CELLS.iter().enumerate() {
        expected.push((
            vec![TABLE_BLOCK, (index / 2) as u32, (index % 2) as u32, 0],
            cell,
        ));
    }
    for (path, want) in expected {
        if text(&path).as_deref() != Some(want) {
            return Err(format!("픽스처 구조가 다름: {path:?}"));
        }
    }
    io::save_bytes("basic-ko.docx", doc)
}

/// T010 안정화: 문서 보호(Restrict Editing)를 건 픽스처. 기본 픽스처를 읽어 `mode`(readOnly 등)로 보호하고, `exception`이면 첫
/// 문단의 처음 두 글자를 모두가 편집할 수 있는 영역으로 둔다(엔진 `review.restrict`).
pub fn protected_ko(mode: &str, exception: bool) -> Result<Vec<u8>, String> {
    let doc = io::open_bytes("basic-ko.docx", &basic_ko()?)?;
    let mut s = Session::new(doc);
    if exception {
        let end = byte_len(PARAGRAPHS[0], 2);
        run(
            &mut s,
            "select.range",
            json!({ "anchor": body(&[0], 0), "focus": body(&[0], end) }),
        )?;
        run(&mut s, "review.restrict", json!({ "exception": "add" }))?;
    }
    run(&mut s, "review.restrict", json!({ "mode": mode }))?;
    io::save_bytes("protected.docx", &s.doc)
}
