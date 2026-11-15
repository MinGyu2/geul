//! Stage 5-A font package: DOCX font selection through the shared font database.

use std::path::Path;

use super::engine::{validate, DocxModel, DocxOp, MoveTarget};
use super::tests::basic;
use wordcraft_fonts::FontDb;

/// The bundled JetBrains Mono Regular (OFL) renamed to `family` (14 bytes, as "JetBrains Mono"): a
/// monospace user font whose metrics differ from every proportional fallback.
fn mono_named(family: &str) -> Vec<u8> {
    assert_eq!(family.len(), "JetBrains Mono".len());
    let mut data = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../external/wordcraft/assets/fonts/JetBrainsMono-Regular.ttf"),
    )
    .unwrap();
    let utf16 = |s: &str| {
        s.encode_utf16()
            .flat_map(u16::to_be_bytes)
            .collect::<Vec<u8>>()
    };
    for (from, to) in [
        (utf16("JetBrains Mono"), utf16(family)),
        (b"JetBrains Mono".to_vec(), family.as_bytes().to_vec()),
    ] {
        let mut i = 0;
        while let Some(at) = data[i..].windows(from.len()).position(|w| w == from) {
            data[i + at..i + at + to.len()].copy_from_slice(&to);
            i += at + to.len();
        }
    }
    data
}

fn ensure_user_font(family: &str) {
    crate::fonts::service();
    if FontDb::global().face(family, "Regular").family != family {
        FontDb::global()
            .install_font(&format!("{family}.ttf"), &mono_named(family))
            .unwrap();
    }
}

/// Caret x (pt) at the end of the first body paragraph ("한글 문단입니다. Korean paragraph.").
fn first_line_end_x(m: &mut DocxModel) -> f32 {
    m.apply(&[
        DocxOp::Move {
            to: MoveTarget::DocStart,
            extend: false,
        },
        DocxOp::Move {
            to: MoveTarget::LineEnd,
            extend: false,
        },
    ]);
    m.view().caret.unwrap().x
}

fn document_xml(docx: &[u8]) -> String {
    use crate::services::save::package::{open, Side};
    let package = open(docx, Side::Output).unwrap();
    String::from_utf8(package.get("word/document.xml").unwrap().to_vec()).unwrap()
}

#[test]
fn font_requests_are_validated_before_running() {
    assert!(validate(&[DocxOp::Font {
        name: "Noto Sans CJK KR".into()
    }]));
    assert!(validate(&[DocxOp::Font {
        name: "나눔고딕".into()
    }]));
    for bad in ["", "   ", "a\u{0}b", "x,y", "q\"", &"n".repeat(129)] {
        assert!(!validate(&[DocxOp::Font { name: bad.into() }]), "{bad:?}");
    }
}

#[test]
fn docx_font_change_lays_out_saves_and_reopens() {
    const FAMILY: &str = "GeulMono Test1";
    ensure_user_font(FAMILY);
    let mut m = DocxModel::open(&basic::basic_ko().unwrap()).unwrap();
    let before_x = first_line_end_x(&mut m);
    let before_rev = m.adapter_state().2;
    // Apply to the whole document.
    let out = m.apply(&[
        DocxOp::SelectAll,
        DocxOp::Font {
            name: FAMILY.into(),
        },
    ]);
    assert!(out.rejected.is_empty() && out.changed == 1, "{out:?}");
    assert_eq!(
        m.view().format.font.as_deref(),
        Some(FAMILY),
        "the selection reports the font"
    );
    // Latin text is now monospace: the line ends elsewhere (layout uses the font's metrics).
    let after_x = first_line_end_x(&mut m);
    assert!(
        (after_x - before_x).abs() > 5.0,
        "line end moved: {before_x} → {after_x}"
    );
    // The engine resolves the requested family to the user face; Hangul falls back to a covering face.
    let face = wordcraft_fonts::word::resolve(FAMILY, false, false);
    assert!(!face.substituted && face.face.family == FAMILY);
    assert!(!face.face.covers('한'));
    // Undo restores the previous formatting, Redo re-applies it.
    m.apply(&[DocxOp::Undo {}]);
    assert_eq!(first_line_end_x(&mut m), before_x);
    m.apply(&[DocxOp::Redo {}]);
    assert_eq!(first_line_end_x(&mut m), after_x);
    assert!(m.adapter_state().2 > before_rev);
    // Saved DOCX carries the requested family; reopening keeps the formatting and the same layout.
    let saved = m.export().unwrap();
    let xml = document_xml(&saved);
    assert!(
        xml.contains(&format!("w:ascii=\"{FAMILY}\"")),
        "w:rFonts ascii in document.xml"
    );
    let mut reopened = DocxModel::open(&saved).unwrap();
    reopened.apply(&[DocxOp::SelectAll]);
    assert_eq!(reopened.view().format.font.as_deref(), Some(FAMILY));
    assert_eq!(first_line_end_x(&mut reopened), after_x);
    assert_eq!(reopened.body_text(), m.body_text());
    // PDF export works with the same layout (independent PDF inspection: scripts/tests/font-pdf-inspect.mjs).
    let (_pdf, pages) = reopened.export_pdf().unwrap();
    assert_eq!(pages, reopened.view().pages.len());
}

#[test]
fn a_missing_family_is_preserved_in_the_document_and_rendered_with_a_fallback() {
    const MISSING: &str = "Geul Absent Family 9";
    let mut m = DocxModel::open(&basic::basic_ko().unwrap()).unwrap();
    let out = m.apply(&[
        DocxOp::SelectAll,
        DocxOp::Font {
            name: MISSING.into(),
        },
    ]);
    assert!(out.rejected.is_empty());
    assert_eq!(m.view().format.font.as_deref(), Some(MISSING));
    // Rendering works (fallback faces), and the saved document keeps the requested name.
    assert!(m.render_png(0, 1.0).is_some());
    let xml = document_xml(&m.export().unwrap());
    assert!(
        xml.contains(MISSING),
        "requested family preserved in the saved DOCX"
    );
    let r = wordcraft_fonts::word::resolve(MISSING, false, false);
    assert!(
        r.substituted,
        "rendered with a substitute, the name is not rewritten"
    );
}

#[test]
fn registering_a_font_relays_out_open_documents_without_a_new_revision() {
    const FAMILY: &str = "GeulLateFace01";
    let mut m = DocxModel::open(&basic::basic_ko().unwrap()).unwrap();
    m.apply(&[
        DocxOp::SelectAll,
        DocxOp::Font {
            name: FAMILY.into(),
        },
    ]);
    let fallback_x = first_line_end_x(&mut m);
    // Not a "Mono"-named family: Word's substitution rules would pick JetBrains Mono (same metrics).
    assert!(
        wordcraft_fonts::word::resolve(FAMILY, false, false)
            .face
            .family
            != "JetBrains Mono"
    );
    let rev = m.adapter_state().2;
    let g = m.font_generation();
    ensure_user_font(FAMILY);
    let x = first_line_end_x(&mut m);
    assert!(
        m.font_generation() > g,
        "the model noticed the font database change"
    );
    assert!(
        (x - fallback_x).abs() > 5.0,
        "the late font is used: {fallback_x} → {x}"
    );
    assert_eq!(
        m.adapter_state().2,
        rev,
        "fonts are render state: no document revision"
    );
    FontDb::global().remove_user_font(FAMILY).unwrap();
    assert_eq!(
        first_line_end_x(&mut m),
        fallback_x,
        "removal falls back again"
    );
}
