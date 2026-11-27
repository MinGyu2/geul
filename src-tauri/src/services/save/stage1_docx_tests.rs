//! Stage 1 DOCX common editing: actual engine mutation through the production IPC path (`docx::edit`), undo/redo,
//! T009 preflight + publish, and independent reopen of the written file.
use super::*;
use crate::adapters::wordcraft::engine::stage1::{
    LineSpacingOp, ListStyle, PageSetupOp, ParagraphAlign, ParagraphFormat, ScriptValue,
    SearchQuery,
};
use crate::adapters::wordcraft::engine::DocxView;
use wordcraft_engine::doc::props::{Align, LineSpacing, Rgb, TextColor, VertAlign};

fn run(doc: &mut Docx, ops: Vec<DocxOp>) -> (DocxView, Vec<usize>) {
    let edited = block_on(docx::edit(
        &doc.state,
        doc.info.session_id,
        doc.info.load_generation,
        doc.info.revision,
        ops,
    ))
    .unwrap();
    doc.info = edited.session;
    (edited.view, edited.rejected)
}

fn save_reopen(doc: &mut Docx, original: &[u8]) -> wordcraft_engine::doc::Document {
    let check = doc.preflight().unwrap();
    assert!(check.preservation.is_safe(), "{:?}", check.preservation);
    let saved = doc.save();
    assert!(saved.is_ok(), "{saved:?}");
    doc.info = saved.unwrap().session;
    let written = doc.bytes();
    let findings = package::compare_saved_docx(
        &package::open(original, package::Side::Original).unwrap(),
        &package::open(&written, package::Side::Output).unwrap(),
    );
    assert!(findings.is_empty(), "{findings:?}");
    let mut model = DocxModel::open(&written).unwrap();
    assert!(model.round_trip().unwrap().passed);
    // No unrelated content loss.
    for text in basic::CELLS {
        assert!(model.body_text().contains(text));
    }
    wordcraft_engine::io::open_bytes("x.docx", &written).unwrap()
}

fn rendered_page(doc: &Docx) -> Vec<u8> {
    let frame = block_on(docx::render(
        &doc.state,
        doc.info.session_id,
        doc.info.load_generation,
        doc.info.revision,
        0,
        1.0,
        None,
    ))
    .expect("render current committed DOCX revision");
    assert!(frame.len() > docx::RENDER_HEADER_LEN);
    frame[docx::RENDER_HEADER_LEN..].to_vec()
}

fn paras(doc: &wordcraft_engine::doc::Document) -> Vec<&wordcraft_engine::doc::Paragraph> {
    doc.body.iter().filter_map(|b| b.as_para()).collect()
}

fn select_first_paragraph() -> Vec<DocxOp> {
    vec![
        DocxOp::Move {
            to: MoveTarget::DocStart,
            extend: false,
        },
        DocxOp::Move {
            to: MoveTarget::LineEnd,
            extend: true,
        },
    ]
}

#[test]
fn stage1_docx_alignment_mixed_state_undo_redo_save_reopen() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    let (view, _) = run(
        &mut doc,
        vec![DocxOp::Move {
            to: MoveTarget::DocStart,
            extend: false,
        }],
    );
    assert_eq!(view.paragraph.align, Some(ParagraphAlign::Left));
    let (view, rejected) = run(
        &mut doc,
        vec![DocxOp::Align {
            value: ParagraphAlign::Center,
        }],
    );
    assert!(rejected.is_empty());
    assert_eq!(view.paragraph.align, Some(ParagraphAlign::Center));
    assert_eq!(doc.info.revision, 1);
    // Mixed selection over the centered and a left paragraph reports no uniform state.
    let (view, _) = run(
        &mut doc,
        vec![DocxOp::Move {
            to: MoveTarget::Down,
            extend: true,
        }],
    );
    assert_eq!(view.paragraph.align, None);
    // Selected paragraphs: both justified in one step; undo restores both, redo reapplies.
    let (view, _) = run(
        &mut doc,
        vec![DocxOp::Align {
            value: ParagraphAlign::Justify,
        }],
    );
    assert_eq!(view.paragraph.align, Some(ParagraphAlign::Justify));
    let (view, _) = run(&mut doc, vec![DocxOp::Undo {}]);
    assert_eq!(view.paragraph.align, None);
    let (view, _) = run(&mut doc, vec![DocxOp::Redo {}]);
    assert_eq!(view.paragraph.align, Some(ParagraphAlign::Justify));
    let (view, _) = run(
        &mut doc,
        vec![
            DocxOp::Move {
                to: MoveTarget::DocEnd,
                extend: false,
            },
            DocxOp::Align {
                value: ParagraphAlign::Right,
            },
        ],
    );
    assert_eq!(view.paragraph.align, Some(ParagraphAlign::Right));
    let reopened = save_reopen(&mut doc, &original);
    let p = paras(&reopened);
    assert_eq!(p[0].props.align, Some(Align::Justify));
    assert_eq!(p[1].props.align, Some(Align::Justify));
    assert_eq!(p.last().unwrap().props.align, Some(Align::Right));
    // Unrelated character formatting (the bold run) is preserved.
    assert!(p[1].runs.iter().any(|r| r.props.bold == Some(true)));
}

#[test]
fn stage1_docx_character_formatting_save_reopen() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    let mut ops = select_first_paragraph();
    ops.extend([
        DocxOp::FontSize { size: 18.0 },
        DocxOp::FontColor {
            color: "C00000".into(),
        },
        DocxOp::Highlight {
            color: "yellow".into(),
        },
        DocxOp::Script {
            value: ScriptValue::Superscript,
        },
    ]);
    let (view, rejected) = run(&mut doc, ops);
    assert!(rejected.is_empty());
    assert_eq!(doc.info.revision, 4);
    assert_eq!(view.chars.size, Some(18.0));
    assert_eq!(view.chars.color.as_deref(), Some("C00000"));
    assert_eq!(view.chars.highlight.as_deref(), Some("FFFF00"));
    assert!(view.chars.superscript && !view.chars.subscript);
    // Explicit subscript replaces superscript; baseline clears it; undo returns to subscript.
    let (view, _) = run(
        &mut doc,
        vec![DocxOp::Script {
            value: ScriptValue::Subscript,
        }],
    );
    assert!(view.chars.subscript && !view.chars.superscript);
    let (view, _) = run(
        &mut doc,
        vec![DocxOp::Script {
            value: ScriptValue::Baseline,
        }],
    );
    assert!(!view.chars.subscript && !view.chars.superscript);
    let (view, _) = run(&mut doc, vec![DocxOp::Undo {}]);
    assert!(view.chars.subscript);
    // Mixed size: extend into the next (unformatted) paragraph.
    let (view, _) = run(
        &mut doc,
        vec![DocxOp::Move {
            to: MoveTarget::Down,
            extend: true,
        }],
    );
    assert_eq!(view.chars.size, None);
    let reopened = save_reopen(&mut doc, &original);
    let p = paras(&reopened);
    let run0 = &p[0].runs[0].props;
    assert_eq!(run0.size, Some(18.0));
    assert_eq!(run0.vert_align, Some(VertAlign::Subscript));
    assert!(run0.color.is_some() && run0.highlight.is_some());
    // The second paragraph's bold is untouched and it has no size override.
    assert!(p[1].runs.iter().any(|r| r.props.bold == Some(true)));
    assert!(p[1].runs.iter().all(|r| r.props.size.is_none()));
    assert_eq!(p[0].text, basic::PARAGRAPHS[0]);
}

#[test]
fn stage1_docx_collapsed_font_size_survives_focus_return_at_same_caret() {
    const PENDING_FONT: &str = "Geul Pending Font";
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);

    let mut ops = select_first_paragraph();
    ops.extend([
        DocxOp::FontSize { size: 10.0 },
        // Collapse the formatted selection at its end, then set the next-input size.
        DocxOp::Move {
            to: MoveTarget::Right,
            extend: false,
        },
        DocxOp::FontSize { size: 24.0 },
        DocxOp::FontColor {
            color: "C00000".into(),
        },
        DocxOp::Highlight {
            color: "yellow".into(),
        },
        DocxOp::Script {
            value: ScriptValue::Superscript,
        },
        DocxOp::Font {
            name: PENDING_FONT.into(),
        },
    ]);
    let (view, rejected) = run(&mut doc, ops);
    assert!(rejected.is_empty());
    assert!(view.collapsed);
    assert_eq!(view.chars.size, Some(24.0));
    assert_eq!(view.chars.color.as_deref(), Some("C00000"));
    assert_eq!(view.chars.highlight.as_deref(), Some("FFFF00"));
    assert!(view.chars.superscript && !view.chars.subscript);
    assert_eq!(view.format.font.as_deref(), Some(PENDING_FONT));

    // Returning focus from the ribbon clicks the already active caret. The pointer hit must
    // not be treated as deliberate navigation and discard its next-input formatting.
    let caret = view.caret.expect("caret");
    let (view, rejected) = run(
        &mut doc,
        vec![DocxOp::Pointer {
            page: caret.page as u32,
            x: caret.x,
            y: caret.y + caret.height * 0.5,
            extend: false,
            before_insert: false,
            drag: false,
            select_object: false,
        }],
    );
    assert!(rejected.is_empty());
    assert_eq!(view.chars.size, Some(24.0));
    assert_eq!(view.chars.color.as_deref(), Some("C00000"));
    assert_eq!(view.chars.highlight.as_deref(), Some("FFFF00"));
    assert!(view.chars.superscript && !view.chars.subscript);
    assert_eq!(view.format.font.as_deref(), Some(PENDING_FONT));

    let (_, rejected) = run(
        &mut doc,
        vec![DocxOp::InsertText {
            text: "한글".into(),
        }],
    );
    assert!(rejected.is_empty());
    let (view, rejected) = run(
        &mut doc,
        vec![DocxOp::Script {
            value: ScriptValue::Subscript,
        }],
    );
    assert!(rejected.is_empty());
    assert_eq!(view.chars.size, Some(24.0));
    assert_eq!(view.chars.color.as_deref(), Some("C00000"));
    assert_eq!(view.chars.highlight.as_deref(), Some("FFFF00"));
    assert!(!view.chars.superscript && view.chars.subscript);
    assert_eq!(view.format.font.as_deref(), Some(PENDING_FONT));

    // A second focus return and a separate committed input preserve the accumulated size and
    // other next-input properties while the script property changes independently.
    let caret = view.caret.expect("caret after first input");
    let (view, rejected) = run(
        &mut doc,
        vec![DocxOp::Pointer {
            page: caret.page as u32,
            x: caret.x,
            y: caret.y + caret.height * 0.5,
            extend: false,
            before_insert: false,
            drag: false,
            select_object: false,
        }],
    );
    assert!(rejected.is_empty());
    assert_eq!(view.chars.size, Some(24.0));
    assert_eq!(view.chars.color.as_deref(), Some("C00000"));
    assert_eq!(view.chars.highlight.as_deref(), Some("FFFF00"));
    assert!(!view.chars.superscript && view.chars.subscript);
    let (view, rejected) = run(
        &mut doc,
        vec![DocxOp::InsertText {
            text: " ABC".into(),
        }],
    );
    assert!(rejected.is_empty());
    assert!(view.paragraph_text.contains("한글 ABC"));
    assert_eq!(view.format.font.as_deref(), Some(PENDING_FONT));

    let (view, rejected) = run(&mut doc, vec![DocxOp::Undo {}]);
    assert!(rejected.is_empty());
    assert!(!view.paragraph_text.contains("한글 ABC"));
    let (view, rejected) = run(&mut doc, vec![DocxOp::Redo {}]);
    assert!(rejected.is_empty());
    assert!(view.paragraph_text.contains("한글 ABC"));

    let reopened = save_reopen(&mut doc, &original);
    let paragraph = &paras(&reopened)[0];
    let byte_start = paragraph.text.find("한글 ABC").expect("typed text");
    let byte_end = byte_start + "한글 ABC".len();
    let mut covered = byte_start;
    for (range, props) in paragraph.run_ranges() {
        if range.start < byte_end && range.end > byte_start {
            assert_eq!(props.size, Some(24.0), "run {range:?}");
            assert_eq!(
                props.color,
                Some(TextColor::Rgb(Rgb(0xC0, 0, 0))),
                "run {range:?}"
            );
            assert!(props.highlight.is_some(), "run {range:?}");
            assert_eq!(props.font.as_deref(), Some(PENDING_FONT), "run {range:?}");
            if range.start < byte_start + "한글".len() {
                assert_eq!(
                    props.vert_align,
                    Some(VertAlign::Superscript),
                    "run {range:?}"
                );
            } else {
                assert_eq!(
                    props.vert_align,
                    Some(VertAlign::Subscript),
                    "run {range:?}"
                );
            }
            covered = covered.max(range.end.min(byte_end));
        }
    }
    assert_eq!(
        covered, byte_end,
        "all typed bytes have reopened character formatting"
    );

    // Inspect the actual durable DrawingML run properties instead of relying on appearance.
    let output = package::open(&doc.bytes(), package::Side::Output).expect("saved OPC package");
    let xml = String::from_utf8(
        output
            .get("word/document.xml")
            .expect("document part")
            .to_vec(),
    )
    .unwrap();
    for (marker, script) in [("한글", "superscript"), (" ABC", "subscript")] {
        let text_at = xml.rfind(marker).expect("serialized typed text");
        let run_start = xml[..text_at]
            .rmatch_indices("<w:r")
            .find(|(at, _)| matches!(xml.as_bytes().get(at + 4), Some(b'>' | b' ')))
            .map(|(at, _)| at)
            .expect("serialized run start");
        let run_end =
            text_at + xml[text_at..].find("</w:r>").expect("serialized run end") + "</w:r>".len();
        let run = &xml[run_start..run_end];
        assert!(run.contains("w:sz w:val=\"48\""), "{marker}: {run}");
        assert!(run.contains("w:color w:val=\"C00000\""), "{marker}: {run}");
        assert!(
            run.contains("w:highlight w:val=\"yellow\""),
            "{marker}: {run}"
        );
        assert!(
            run.contains(&format!("w:ascii=\"{PENDING_FONT}\"")),
            "{marker}: {run}"
        );
        assert!(
            run.contains(&format!("w:val=\"{script}\"")),
            "{marker}: {run}"
        );
    }
}

#[test]
fn stage1_docx_selection_font_size_replaces_only_selected_text_and_navigation_clears_pending() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    let (view, rejected) = run(
        &mut doc,
        vec![
            DocxOp::Move {
                to: MoveTarget::DocStart,
                extend: false,
            },
            DocxOp::Move {
                to: MoveTarget::Right,
                extend: true,
            },
            DocxOp::Move {
                to: MoveTarget::Right,
                extend: true,
            },
            DocxOp::FontSize { size: 24.0 },
            DocxOp::InsertText {
                text: "대체".into(),
            },
        ],
    );
    assert!(rejected.is_empty());
    assert!(view.paragraph_text.starts_with("대체"));
    assert_eq!(
        doc.info.revision, 2,
        "selection formatting plus replacement"
    );
    let reopened = save_reopen(&mut doc, &original);
    let first = &paras(&reopened)[0];
    let end = "대체".len();
    let mut covered = 0;
    for (range, props) in first.run_ranges() {
        if range.start < end && range.end > 0 {
            assert_eq!(props.size, Some(24.0), "{range:?}");
            covered = covered.max(range.end.min(end));
        }
    }
    assert_eq!(covered, end, "replacement text is serialized at 24 pt");

    // A deliberate keyboard navigation retains the established policy: pending next-input
    // formatting is discarded and the destination's effective formatting is reported.
    let mut navigation = open_docx(&original);
    let (view, rejected) = run(
        &mut navigation,
        vec![
            DocxOp::Move {
                to: MoveTarget::DocEnd,
                extend: false,
            },
            DocxOp::FontSize { size: 24.0 },
        ],
    );
    assert!(rejected.is_empty());
    assert_eq!(view.chars.size, Some(24.0));
    let (view, rejected) = run(
        &mut navigation,
        vec![DocxOp::Move {
            to: MoveTarget::Left,
            extend: false,
        }],
    );
    assert!(rejected.is_empty());
    assert_eq!(view.chars.size, Some(12.0));
}

#[test]
fn stage1_docx_next_input_size_changes_layout_and_rendered_page() {
    let original = basic::basic_ko().unwrap();
    let typed_width = |size| {
        let mut doc = open_docx(&original);
        let mut ops = select_first_paragraph();
        ops.extend([
            DocxOp::FontSize { size: 10.0 },
            DocxOp::Move {
                to: MoveTarget::Right,
                extend: false,
            },
        ]);
        if size != 10.0 {
            ops.push(DocxOp::FontSize { size });
        }
        ops.push(DocxOp::InsertText {
            text: "한글 ABC".into(),
        });
        let (view, rejected) = run(&mut doc, ops);
        assert!(rejected.is_empty());
        assert_eq!(view.chars.size, Some(size));
        assert!(view.paragraph_text.contains("한글 ABC"));
        let x = view.caret.expect("rendered caret").x;
        let page = rendered_page(&doc);
        (x, page)
    };

    let (ten_pt_x, ten_pt_page) = typed_width(10.0);
    let (twenty_four_pt_x, twenty_four_pt_page) = typed_width(24.0);
    assert!(
        twenty_four_pt_x > ten_pt_x + 20.0,
        "caret geometry: {ten_pt_x} → {twenty_four_pt_x}"
    );
    assert_ne!(
        ten_pt_page, twenty_four_pt_page,
        "rendered page raster reflects the effective font size"
    );
}

#[test]
fn stage1_docx_paragraph_spacing_indents_save_reopen() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    let format = ParagraphFormat {
        line_spacing: Some(LineSpacingOp::Exactly { value: 20.0 }),
        space_before: Some(12.0),
        space_after: Some(6.0),
        indent_left: Some(36.0),
        indent_right: Some(18.0),
        indent_first: Some(-18.0),
    };
    let (view, rejected) = run(
        &mut doc,
        vec![
            DocxOp::Move {
                to: MoveTarget::DocStart,
                extend: false,
            },
            DocxOp::Move {
                to: MoveTarget::Down,
                extend: true,
            },
            DocxOp::Move {
                to: MoveTarget::LineEnd,
                extend: true,
            },
            DocxOp::Paragraph { format },
        ],
    );
    assert!(rejected.is_empty());
    assert_eq!(doc.info.revision, 1, "one undo step / revision");
    assert_eq!(view.paragraph.indent_first, Some(-18.0));
    assert_eq!(view.paragraph.space_before, Some(12.0));
    // Only the line spacing of the caret paragraph changes afterwards; other values stay.
    let (view, _) = run(
        &mut doc,
        vec![
            DocxOp::Move {
                to: MoveTarget::DocStart,
                extend: false,
            },
            DocxOp::Paragraph {
                format: ParagraphFormat {
                    line_spacing: Some(LineSpacingOp::Multiple { value: 1.5 }),
                    ..Default::default()
                },
            },
        ],
    );
    assert_eq!(view.paragraph.indent_left, Some(36.0));
    let lines = view.paragraph.line_spacing.unwrap();
    assert_eq!((lines.rule, lines.value), ("multiple", 1.5));
    let reopened = save_reopen(&mut doc, &original);
    let p = paras(&reopened);
    let r0 = reopened.styles.resolve_para(&p[0].props);
    let r1 = reopened.styles.resolve_para(&p[1].props);
    assert_eq!(r0.line_spacing, LineSpacing::Multiple(1.5));
    assert_eq!(r1.line_spacing, LineSpacing::Exactly(20.0));
    for r in [&r0, &r1] {
        assert_eq!(
            (r.indent_left, r.indent_right, r.indent_first),
            (36.0, 18.0, -18.0)
        );
        assert_eq!((r.space_before, r.space_after), (12.0, 6.0));
    }
    assert!(p[1].runs.iter().any(|r| r.props.bold == Some(true)));
}

#[test]
fn stage1_docx_lists_numbered_multilevel_custom_restart_save_reopen() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    let (view, rejected) = run(
        &mut doc,
        vec![
            DocxOp::Move {
                to: MoveTarget::DocEnd,
                extend: false,
            },
            DocxOp::NewParagraph,
            DocxOp::List {
                style: ListStyle::Numbered,
                off: false,
            },
            DocxOp::InsertText {
                text: "하나".into(),
            },
            DocxOp::NewParagraph, // continues the list
            DocxOp::InsertText { text: "둘".into() },
            DocxOp::ListIndent { outdent: false }, // demote to level 2
        ],
    );
    assert!(rejected.is_empty(), "{rejected:?}");
    let list = view.paragraph.list.unwrap();
    assert!(list.numbering && list.level == 1);
    let (view, _) = run(&mut doc, vec![DocxOp::ListIndent { outdent: true }]);
    assert_eq!(view.paragraph.list.unwrap().level, 0);
    let (view, rejected) = run(
        &mut doc,
        vec![
            DocxOp::NewParagraph,
            DocxOp::InsertText { text: "셋".into() },
            DocxOp::RestartNumbering {},
            DocxOp::NewParagraph,
            DocxOp::NewParagraph, // Enter on an empty item ends the list
            DocxOp::InsertText {
                text: "보통 문단".into(),
            },
        ],
    );
    assert!(rejected.is_empty(), "{rejected:?}");
    assert!(view.paragraph.list.is_none());
    let (view, rejected) = run(
        &mut doc,
        vec![
            DocxOp::NewParagraph,
            DocxOp::List {
                style: ListStyle::Multilevel,
                off: false,
            },
            DocxOp::InsertText {
                text: "1.1 다단계".into(),
            },
            DocxOp::NewParagraph,
            DocxOp::List {
                style: ListStyle::BulletCircle,
                off: false,
            },
            DocxOp::InsertText {
                text: "사용자 글머리".into(),
            },
        ],
    );
    assert!(rejected.is_empty(), "{rejected:?}");
    assert!(view.paragraph.list.unwrap().bullets);
    // A list inside a table cell is a supported context.
    let (view, rejected) = run(
        &mut doc,
        vec![
            DocxOp::Move {
                to: MoveTarget::DocStart,
                extend: false,
            },
            DocxOp::Move {
                to: MoveTarget::Down,
                extend: false,
            },
            DocxOp::Move {
                to: MoveTarget::LineEnd,
                extend: false,
            },
            DocxOp::Move {
                to: MoveTarget::Right,
                extend: false,
            },
            DocxOp::List {
                style: ListStyle::LowerRoman,
                off: false,
            },
        ],
    );
    assert!(rejected.is_empty(), "{rejected:?}");
    assert!(view.in_table && view.paragraph.list.unwrap().numbering);
    let reopened = save_reopen(&mut doc, &original);
    let label = |text: &str| {
        let p = paras(&reopened)
            .into_iter()
            .find(|p| p.text == text)
            .map(|p| p.props.numbering);
        p.flatten()
    };
    let one = label("하나").unwrap();
    let two = label("둘").unwrap();
    let three = label("셋").unwrap();
    assert_eq!(one.num, two.num, "continuation");
    assert_ne!(three.num, one.num, "restart instance");
    assert_eq!(
        reopened.numbering.num(three.num).unwrap().abstract_id,
        reopened.numbering.num(one.num).unwrap().abstract_id
    );
    assert!(!reopened
        .numbering
        .num(three.num)
        .unwrap()
        .start_overrides
        .is_empty());
    assert!(label("보통 문단").is_none_or(|n| n.num == 0));
    assert!(label("1.1 다단계").is_some());
    assert!(label("사용자 글머리").is_some());
    // Editing existing list items afterwards reuses the saved definitions (no new numbering resources).
    let before = reopened.numbering.clone();
    run(
        &mut doc,
        vec![
            DocxOp::Move {
                to: MoveTarget::DocEnd,
                extend: false,
            },
            DocxOp::InsertText {
                text: " 끝".into()
            },
        ],
    );
    let again = save_reopen(&mut doc, &original);
    assert_eq!(again.numbering, before);
}

#[test]
fn stage1_docx_numbering_proof_rejects_foreign_definitions() {
    let original = basic::basic_ko().unwrap();
    let mut seed = wordcraft_engine::io::open_bytes("x.docx", &original).unwrap();
    let id = seed
        .numbering
        .add_list(wordcraft_engine::doc::numbering::ListKind::Numbered);
    // Tamper: a definition no engine command creates.
    let a = seed.numbering.num(id).unwrap().abstract_id;
    seed.numbering
        .abstracts
        .iter_mut()
        .find(|x| x.id == a)
        .unwrap()
        .levels[0]
        .text = "%1>".into();
    let tampered = wordcraft_engine::io::save_bytes("x.docx", &seed).unwrap();
    let findings = package::compare_saved_docx(
        &package::open(&original, package::Side::Original).unwrap(),
        &package::open(&tampered, package::Side::Output).unwrap(),
    );
    assert!(
        findings
            .iter()
            .any(|f| f.part.as_deref() == Some("word/numbering.xml")),
        "{findings:?}"
    );
}

#[test]
fn stage1_docx_page_setup_save_reopen() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    let (view, rejected) = run(
        &mut doc,
        vec![
            DocxOp::PageSetup {
                setup: PageSetupOp::Size { name: "A5".into() },
            },
            DocxOp::PageSetup {
                setup: PageSetupOp::Orientation { landscape: true },
            },
            DocxOp::PageSetup {
                setup: PageSetupOp::Margins {
                    top: 36.0,
                    bottom: 40.0,
                    left: 50.0,
                    right: 54.0,
                },
            },
            DocxOp::PageSetup {
                setup: PageSetupOp::Columns {
                    count: 2,
                    space: 24.0,
                },
            },
        ],
    );
    assert!(rejected.is_empty(), "{rejected:?}");
    assert_eq!(doc.info.revision, 4);
    assert!(view.page.landscape);
    assert_eq!(view.page.paper, Some("A5"));
    assert_eq!((view.page.columns, view.page.margin_left), (2, 50.0));
    assert!(
        view.pages[0].width > view.pages[0].height,
        "repaginated landscape"
    );
    let (view, _) = run(&mut doc, vec![DocxOp::Undo {}]);
    assert_eq!(view.page.columns, 1);
    let (view, _) = run(&mut doc, vec![DocxOp::Redo {}]);
    assert_eq!(view.page.columns, 2);
    // Margins leaving no text room are refused by the engine (nothing changes).
    let (_, rejected) = run(
        &mut doc,
        vec![DocxOp::PageSetup {
            setup: PageSetupOp::Margins {
                top: 300.0,
                bottom: 300.0,
                left: 10.0,
                right: 10.0,
            },
        }],
    );
    assert_eq!(rejected, vec![0]);
    let reopened = save_reopen(&mut doc, &original);
    let (_, s) = reopened.sections()[0];
    assert!(s.landscape && s.page_w > s.page_h);
    assert!(
        (s.page_w - 595.3).abs() < 0.1 && (s.page_h - 419.55).abs() < 0.1,
        "{} {}",
        s.page_w,
        s.page_h
    );
    assert_eq!(
        (s.margin_top, s.margin_bottom, s.margin_left, s.margin_right),
        (36.0, 40.0, 50.0, 54.0)
    );
    assert_eq!((s.columns.count, s.columns.space), (2, 24.0));
}

#[test]
fn stage1_docx_find_replace_model_owned_save_reopen() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    let q = |text: &str, match_case: bool, whole_word: bool| SearchQuery {
        text: text.into(),
        match_case,
        whole_word,
    };
    // "문단" occurs in two paragraphs (Korean, model text).
    let (view, _) = run(
        &mut doc,
        vec![DocxOp::Find {
            query: q("문단", false, false),
            backward: false,
        }],
    );
    let search = view.search.clone().unwrap();
    assert_eq!(search.count, 2);
    assert_eq!(search.current, Some(0));
    assert_eq!(view.selection_text.as_deref(), Some("문단"));
    let (view, _) = run(
        &mut doc,
        vec![DocxOp::Find {
            query: q("문단", false, false),
            backward: false,
        }],
    );
    assert_eq!(view.search.unwrap().current, Some(1));
    let (view, _) = run(
        &mut doc,
        vec![DocxOp::Find {
            query: q("문단", false, false),
            backward: false,
        }],
    );
    assert_eq!(view.search.unwrap().current, Some(0), "wraps");
    let (view, _) = run(
        &mut doc,
        vec![DocxOp::Find {
            query: q("문단", false, false),
            backward: true,
        }],
    );
    assert_eq!(view.search.unwrap().current, Some(1), "previous wraps");
    // Match case and whole word.
    let (view, _) = run(
        &mut doc,
        vec![DocxOp::Find {
            query: q("korean", true, false),
            backward: false,
        }],
    );
    assert_eq!(view.search.unwrap().count, 0);
    let (view, _) = run(
        &mut doc,
        vec![DocxOp::Find {
            query: q("Korean", true, true),
            backward: false,
        }],
    );
    assert_eq!(view.search.unwrap().count, 1);
    let (view, _) = run(
        &mut doc,
        vec![DocxOp::Find {
            query: q("Kor", false, true),
            backward: false,
        }],
    );
    assert_eq!(view.search.unwrap().count, 0);
    assert_eq!(doc.info.revision, 0, "search never changes the document");
    // Replace selected match; a stale selection (moved caret) is refused without change.
    let (_, _) = run(
        &mut doc,
        vec![DocxOp::Find {
            query: q("문단", false, false),
            backward: false,
        }],
    );
    let (view, rejected) = run(
        &mut doc,
        vec![DocxOp::Replace {
            query: q("문단", false, false),
            with: "단락 😀".into(),
        }],
    );
    assert!(rejected.is_empty());
    assert_eq!(doc.info.revision, 1);
    assert_eq!(view.search.clone().unwrap().count, 1);
    let (_, rejected) = run(
        &mut doc,
        vec![
            DocxOp::Move {
                to: MoveTarget::DocStart,
                extend: false,
            },
            DocxOp::Replace {
                query: q("문단", false, false),
                with: "X".into(),
            },
        ],
    );
    assert_eq!(rejected, vec![1]);
    assert_eq!(doc.info.revision, 1);
    // Replace all is one undo step; the replacement is literal (no special codes).
    let (view, rejected) = run(
        &mut doc,
        vec![DocxOp::ReplaceAll {
            query: q("셀", false, false),
            with: "^&칸".into(),
        }],
    );
    assert!(rejected.is_empty());
    assert_eq!(doc.info.revision, 2);
    assert_eq!(view.search.clone().unwrap().count, 0);
    let (view, _) = run(&mut doc, vec![DocxOp::Undo {}]);
    assert_eq!(view.search.unwrap().count, 1);
    let (_, _) = run(&mut doc, vec![DocxOp::Redo {}]);
    let (_, rejected) = run(
        &mut doc,
        vec![DocxOp::ReplaceAll {
            query: q("없는말", false, false),
            with: "y".into(),
        }],
    );
    assert_eq!(rejected, vec![0], "no match is not a success");
    let (view, _) = run(&mut doc, vec![DocxOp::ClearSearch {}]);
    assert!(view.search.is_none());
    let written = {
        let check = doc.preflight().unwrap();
        assert!(check.preservation.is_safe());
        doc.info = doc.save().unwrap().session;
        doc.bytes()
    };
    let text = DocxModel::open(&written).unwrap().body_text();
    assert!(text.contains("표 다음 단락 😀 End."), "{text}");
    assert!(text.contains(basic::PARAGRAPHS[0]), "{text}");
    assert!(text.contains("^&칸 하나"), "{text}");
    assert!(text.contains("굵은 글씨"));
}

#[test]
fn stage1_docx_invalid_parameters_reject_whole_request() {
    let original = basic::basic_ko().unwrap();
    let doc = open_docx(&original);
    let q = SearchQuery {
        text: String::new(),
        match_case: false,
        whole_word: false,
    };
    for op in [
        DocxOp::FontColor {
            color: "red".into(),
        },
        DocxOp::FontSize { size: f32::NAN },
        DocxOp::Highlight {
            color: "orange".into(),
        },
        DocxOp::Paragraph {
            format: ParagraphFormat::default(),
        },
        DocxOp::Paragraph {
            format: ParagraphFormat {
                space_before: Some(-1.0),
                ..Default::default()
            },
        },
        DocxOp::PageSetup {
            setup: PageSetupOp::Size { name: "A9".into() },
        },
        DocxOp::PageSetup {
            setup: PageSetupOp::Columns {
                count: 13,
                space: 0.0,
            },
        },
        DocxOp::Find {
            query: q.clone(),
            backward: false,
        },
        DocxOp::ReplaceAll {
            query: SearchQuery {
                text: "a\u{fffc}".into(),
                ..q.clone()
            },
            with: String::new(),
        },
    ] {
        let result = block_on(docx::edit(
            &doc.state,
            doc.info.session_id,
            doc.info.load_generation,
            doc.info.revision,
            vec![op.clone()],
        ));
        assert!(
            matches!(result, Err(DocumentError::InvalidRequest)),
            "{op:?}"
        );
    }
}
