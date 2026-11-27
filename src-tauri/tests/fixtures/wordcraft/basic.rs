// Small deterministic DOCX fixture generator shared by geul's Rust unit tests.
// Keep the structure stable: the adapter and save tests address the two opening
// paragraphs, a 2×2 table, and the paragraph following that table by path.

use serde_json::json;
use wordcraft_engine::doc::{Path, Pos, StoryRef};
use wordcraft_engine::{blank_document, io, Session};

pub const PARAGRAPHS: [&str; 2] = ["한글 문단입니다. Korean paragraph.", "굵은 글씨 Bold text"];
pub const BOLD_CHARS: usize = 5;
pub const CELLS: [&str; 4] = ["셀 하나", "Cell two", "셋째 칸", "Fourth"];
pub const AFTER: &str = "표 다음 문단 End.";
pub const TABLE_BLOCK: u32 = 2;
pub const AFTER_BLOCK: u32 = 3;

fn run(session: &mut Session, command: &str, args: serde_json::Value) -> Result<(), String> {
    session
        .run(command, &args)
        .map(|_| ())
        .map_err(|error| format!("{command}: {error}"))
}

fn body(path: &[u32], offset: usize) -> Pos {
    Pos::new(StoryRef::Body, Path(path.to_vec()), offset)
}

fn byte_offset(text: &str, chars: usize) -> usize {
    text.char_indices()
        .nth(chars)
        .map_or(text.len(), |(offset, _)| offset)
}

fn insert_text(session: &mut Session, text: &str) -> Result<(), String> {
    run(session, "text.insert", json!({ "text": text, "raw": true }))
}

pub fn basic_ko() -> Result<Vec<u8>, String> {
    let mut session = Session::new(blank_document(&Default::default()));

    insert_text(&mut session, PARAGRAPHS[0])?;
    run(&mut session, "text.newParagraph", json!({}))?;
    insert_text(&mut session, PARAGRAPHS[1])?;

    let bold_end = byte_offset(PARAGRAPHS[1], BOLD_CHARS);
    run(
        &mut session,
        "select.range",
        json!({
            "anchor": body(&[1], 0),
            "focus": body(&[1], bold_end),
        }),
    )?;
    run(&mut session, "format.bold", json!({}))?;
    run(
        &mut session,
        "caret.set",
        json!({ "pos": body(&[1], PARAGRAPHS[1].len()) }),
    )?;
    run(&mut session, "text.newParagraph", json!({}))?;
    run(
        &mut session,
        "insert.table",
        json!({ "rows": 2, "cols": 2 }),
    )?;

    for (index, cell) in CELLS.iter().enumerate() {
        if index != 0 {
            run(&mut session, "text.tab", json!({}))?;
        }
        insert_text(&mut session, cell)?;
    }
    run(&mut session, "caret.docEnd", json!({}))?;
    insert_text(&mut session, AFTER)?;

    let document = &session.doc;
    let paragraph_text = |path: &[u32]| {
        document
            .para(StoryRef::Body, &Path(path.to_vec()))
            .map(|paragraph| paragraph.text.as_str())
    };

    let expected = [
        (vec![0], PARAGRAPHS[0]),
        (vec![1], PARAGRAPHS[1]),
        (vec![AFTER_BLOCK], AFTER),
    ];
    for (path, text) in expected {
        if paragraph_text(&path) != Some(text) {
            return Err(format!("fixture paragraph mismatch at {path:?}"));
        }
    }
    for (index, cell) in CELLS.iter().enumerate() {
        let path = [TABLE_BLOCK, (index / 2) as u32, (index % 2) as u32, 0];
        if paragraph_text(&path) != Some(*cell) {
            return Err(format!("fixture cell mismatch at {path:?}"));
        }
    }

    io::save_bytes("basic-ko.docx", document)
}

pub fn protected_ko(mode: &str, exception: bool) -> Result<Vec<u8>, String> {
    let document = io::open_bytes("basic-ko.docx", &basic_ko()?)?;
    let mut session = Session::new(document);

    if exception {
        let end = byte_offset(PARAGRAPHS[0], 2);
        run(
            &mut session,
            "select.range",
            json!({
                "anchor": body(&[0], 0),
                "focus": body(&[0], end),
            }),
        )?;
        run(
            &mut session,
            "review.restrict",
            json!({ "exception": "add" }),
        )?;
    }

    run(&mut session, "review.restrict", json!({ "mode": mode }))?;
    io::save_bytes("protected.docx", &session.doc)
}
