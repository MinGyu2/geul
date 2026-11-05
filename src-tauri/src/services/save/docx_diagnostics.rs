//! Generated diagnostic evidence; no production equality or preservation policy changes.
use super::*;
use crate::document::xml;
use sha2::{Digest, Sha256};
use wordcraft_engine::{io, Session};

const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";

fn xml_text(entries: &[ZipEntry], name: &str) -> String {
    String::from_utf8(pkg(entries).get(name).unwrap().to_vec()).unwrap()
}
fn document(inner: &str, strict: bool) -> String {
    let w = if strict { STRICT_W } else { W };
    let r = if strict { STRICT_R } else { TRANSITIONAL_R };
    let inner = inner.replacen(
        "</w:p>",
        r#"<w:bookmarkStart w:id="0" w:name="bookmark"/><w:bookmarkEnd w:id="0"/></w:p>"#,
        1,
    );
    format!(
        r#"<w:document xmlns:w="{w}" xmlns:r="{r}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>{inner}</w:body></w:document>"#
    )
}
pub(super) fn link(text: &str, attrs: &str) -> String {
    format!(r#"<w:hyperlink {attrs}><w:r><w:t>{text}</w:t></w:r></w:hyperlink>"#)
}
pub(super) fn paragraph(inner: &str) -> String {
    format!("<w:p>{inner}</w:p>")
}
pub(super) fn position_package(body: &str, output: bool, strict: bool) -> Vec<ZipEntry> {
    let mut entries = if output {
        memo_output(&["new"])
    } else {
        memo_original()
    };
    entries = replace(&entries, "word/document.xml", &document(body, strict));
    let rels = xml_text(&entries, "word/_rels/document.xml.rels");
    let extra = format!(
        r#"<Relationship Id="linkA" Type="{TRANSITIONAL_R}/hyperlink" Target="https://example.org/A" TargetMode="External"/><Relationship Id="linkB" Type="{TRANSITIONAL_R}/hyperlink" Target="https://example.org/B" TargetMode="External"/>"#
    );
    replace(
        &entries,
        "word/_rels/document.xml.rels",
        &rels.replace("</Relationships>", &(extra + "</Relationships>")),
    )
}

/// Synthetic package + actual engine comparisons. Position-only body changes are
/// expected to pass this additional binding gate, not the authoritative model gate.
#[test]
fn diagnostic_a_position_matrix() {
    let first = link("First", r#"r:id="linkA""#);
    let second = link("Second", r#"w:anchor="bookmark""#);
    let before_body = paragraph(&(first.clone() + &second));
    let moved =
        paragraph(&(link("First", r#"w:anchor="bookmark""#) + &link("Second", r#"r:id="linkA""#)));
    let two = paragraph(&(first.clone() + &link("Second", r#"r:id="linkB""#)));
    let swapped =
        paragraph(&(link("First", r#"r:id="linkB""#) + &link("Second", r#"r:id="linkA""#)));
    let cases = [
        (
            "A1",
            before_body.clone(),
            before_body.clone(),
            false,
            false,
            true,
            true,
        ),
        (
            "A2",
            before_body.clone(),
            moved.clone(),
            false,
            false,
            true,
            false,
        ),
        (
            "A3",
            paragraph(&first) + &paragraph(&second),
            paragraph(&link("First", r#"w:anchor="bookmark""#))
                + &paragraph(&link("Second", r#"r:id="linkA""#)),
            false,
            false,
            true,
            false,
        ),
        (
            "A4",
            before_body.clone(),
            moved.replace("linkA", "renumbered"),
            true,
            false,
            true,
            false,
        ),
        (
            "A5",
            before_body.clone(),
            moved.replace("linkA", "linkB"),
            false,
            false,
            false,
            false,
        ),
        ("A6", two, swapped, false, false, false, false),
        ("A9", before_body, moved, false, true, true, false),
    ];
    for (name, body, changed, renumber, strict, binding_expected, engine_expected) in cases {
        let before = position_package(&body, false, strict);
        let mut after = position_package(&changed, true, strict);
        if renumber {
            let rels =
                xml_text(&after, "word/_rels/document.xml.rels").replace("linkA", "renumbered");
            after = replace(&after, "word/_rels/document.xml.rels", &rels);
        }
        let a = pkg(&before);
        let b = pkg(&after);
        assert!(package::validate_docx(&a).is_empty(), "{name}");
        assert!(package::validate_docx(&b).is_empty(), "{name}");
        let xml_equal = xml::relationship_references_equal(
            a.get("word/document.xml").unwrap(),
            b.get("word/document.xml").unwrap(),
            |x, y| x == y || (renumber && x == "linkA" && y == "renumbered"),
        )
        .unwrap();
        assert_eq!(xml_equal, binding_expected, "{name} xml");
        assert_eq!(
            package::comment_parts_added(&a, &b),
            binding_expected,
            "{name} package"
        );
        assert_eq!(
            service::check_saved(
                Format::Docx,
                &zip(&before, false),
                &zip(&after, false),
                None,
                true
            )
            .is_safe(),
            binding_expected,
            "{name} injected check"
        );
        // Remove comment additions as a confounder: same comment-free document,
        // only relationship position/ID differs in the engine comparison.
        let mut engine_after = replace(&before, "word/document.xml", &document(&changed, strict));
        if renumber {
            engine_after = replace(
                &engine_after,
                "word/_rels/document.xml.rels",
                &xml_text(&before, "word/_rels/document.xml.rels").replace("linkA", "renumbered"),
            );
        }
        let model = DocxModel::open(&zip(&before, false)).unwrap();
        let same = model.same_as(&zip(&engine_after, false));
        eprintln!("POSITION {name} xml={xml_equal} package={binding_expected} integrity=true injected_check={binding_expected} model={same}");
        assert_eq!(same, engine_expected, "{name} model");
        injected_publication(
            &zip(&before, false),
            &zip(&after, false),
            true,
            binding_expected,
        );
    }
}

fn injected_publication(original: &[u8], output: &[u8], reopen: bool, accepted: bool) -> TempDir {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let info = rhwp_session(&state, &dir, "a.docx", original);
    let registry = state.registry();
    let source = registry
        .preflight_source(info.session_id, info.load_generation)
        .unwrap();
    let check = service::preflight(Format::Docx, original, original, None);
    assert!(check.is_safe());
    registry
        .record_preflight(
            info.session_id,
            info.load_generation,
            source.content_hash,
            check,
        )
        .unwrap();
    registry
        .commit(info.session_id, info.load_generation, 0, 1)
        .unwrap();
    let result = {
        let ticket = registry
            .begin_save(info.session_id, info.load_generation, 1)
            .unwrap();
        service::save(registry, &ticket, &Limits::default(), output, None, reopen)
    };
    if accepted {
        assert!(result.is_ok(), "{result:?}");
    } else {
        assert!(
            matches!(result, Err(DocumentError::UnsafeSave { .. })),
            "{result:?}"
        );
    }
    let bytes = std::fs::read(dir.path().join("a.docx")).unwrap();
    assert_eq!(
        Sha256::digest(bytes),
        Sha256::digest(if accepted { output } else { original })
    );
    assert_eq!(registry.get(info.session_id).unwrap().dirty, !accepted);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    assert!(registry
        .begin_save(info.session_id, info.load_generation, 1)
        .is_ok());
    dir
}

fn generated_drawing() -> (String, Vec<u8>) {
    let mut s = Session::new(wordcraft_engine::blank_document(&Default::default()));
    s.run("insert.picture", &json!({"data": PNG})).unwrap();
    let bytes = io::save_bytes("fixture.docx", &s.doc).unwrap();
    let pkg = package::open(&bytes, package::Side::Original).unwrap();
    let xml = std::str::from_utf8(pkg.get("word/document.xml").unwrap()).unwrap();
    let start = xml.find("<w:drawing>").unwrap();
    let end = xml.find("</w:drawing>").unwrap() + "</w:drawing>".len();
    let drawing = &xml[start..end];
    let at = drawing.find("r:embed=\"").unwrap() + "r:embed=\"".len();
    let id = &drawing[at..at + drawing[at..].find('"').unwrap()];
    let media = pkg
        .parts
        .iter()
        .find(|(name, _)| name.starts_with("word/media/"))
        .unwrap()
        .1
         .1
        .clone();
    (
        drawing.replace(&format!(r#"r:embed="{id}""#), r#"r:embed="image""#),
        media,
    )
}
fn add_image(entries: &[ZipEntry], bytes: &[u8]) -> Vec<ZipEntry> {
    let types = xml_text(entries, "[Content_Types].xml").replace(
        "</Types>",
        r#"<Default Extension="png" ContentType="image/png"/></Types>"#,
    );
    let mut entries = replace(entries, "[Content_Types].xml", &types);
    let rels = xml_text(&entries, "word/_rels/document.xml.rels").replace("</Relationships>", &format!(r#"<Relationship Id="image" Type="{TRANSITIONAL_R}/image" Target="media/pixel.png"/></Relationships>"#));
    entries = replace(&entries, "word/_rels/document.xml.rels", &rels);
    entries.push(entry("word/media/pixel.png", bytes));
    entries
}
#[test]
fn diagnostic_a_drawing_positions() {
    let (drawing, media) = generated_drawing();
    let empty = drawing
        .replace(r#" r:embed="image""#, "")
        .replace(r#"id="1""#, r#"id="2""#);
    let at = drawing.find("<wp:docPr").unwrap();
    let end = at + drawing[at..].find("/>").unwrap();
    let mut click = drawing.clone();
    click.replace_range(end..end + 2, r#"><a:hlinkClick r:id="linkA"/></wp:docPr>"#);
    for (name, before_body, after_body) in [
        (
            "A7",
            paragraph(&(link("First", r#"r:id="linkA""#) + &format!("<w:r>{drawing}</w:r>"))),
            paragraph(&(link("First", r#"w:anchor="bookmark""#) + &format!("<w:r>{click}</w:r>"))),
        ),
        (
            "A8",
            paragraph(&format!("<w:r>{drawing}</w:r>"))
                + &paragraph(&format!("<w:r>{empty}</w:r>")),
            paragraph(&format!("<w:r>{empty}</w:r>"))
                + &paragraph(&format!("<w:r>{drawing}</w:r>")),
        ),
    ] {
        let before = add_image(&position_package(&before_body, false, false), &media);
        let after = add_image(&position_package(&after_body, true, false), &media);
        let a = pkg(&before);
        let b = pkg(&after);
        assert!(package::validate_docx(&a).is_empty());
        assert!(package::validate_docx(&b).is_empty());
        assert!(xml::relationship_references_equal(
            a.get("word/document.xml").unwrap(),
            b.get("word/document.xml").unwrap(),
            |x, y| x == y
        )
        .unwrap());
        assert!(package::comment_parts_added(&a, &b));
        assert!(service::check_saved(
            Format::Docx,
            &zip(&before, false),
            &zip(&after, false),
            None,
            true
        )
        .is_safe());
        let engine_after = replace(&before, "word/document.xml", &document(&after_body, false));
        assert!(!DocxModel::open(&zip(&before, false))
            .unwrap()
            .same_as(&zip(&engine_after, false)));
        injected_publication(&zip(&before, false), &zip(&after, false), true, true);
        eprintln!("POSITION {name} xml=true package=true integrity=true injected_save=true engine_same=false");
    }
}

#[test]
fn diagnostic_a_real_model_gate_and_authorized_move() {
    let first = link("First", r#"r:id="linkA""#);
    let second = link("Second", r#"w:anchor="bookmark""#);
    let seed = zip(
        &position_package(&paragraph(&(first + &second)), false, false),
        false,
    );
    let seed = io::open_bytes("fixture.docx", &seed).unwrap();
    let original = io::save_bytes("fixture.docx", &seed).unwrap();
    let mut doc = open_docx(&original);
    assert!(doc.preflight().unwrap().preservation.is_safe());
    let mut ops = vec![DocxOp::Move {
        to: MoveTarget::DocStart,
        extend: false,
    }];
    ops.extend((0..5).map(|_| DocxOp::Move {
        to: MoveTarget::Right,
        extend: true,
    }));
    ops.push(DocxOp::Comment {
        text: "anchor evidence".into(),
    });
    doc.edit(ops);
    let model = doc
        .state
        .wordcraft()
        .get(doc.info.session_id, doc.info.load_generation)
        .unwrap();
    let output = model.lock().unwrap().export().unwrap();
    assert!(model.lock().unwrap().same_as(&output));
    let pkg = package::open(&output, package::Side::Output).unwrap();
    let entries: Vec<_> = pkg
        .parts
        .iter()
        .map(|(name, (_, bytes))| entry(name, bytes))
        .collect();
    let xml = xml_text(&entries, "word/document.xml");
    let starts = xml::element_starts(xml.as_bytes()).unwrap();
    let id = starts
        .iter()
        .find(|e| e.name == "hyperlink")
        .unwrap()
        .attributes
        .iter()
        .find(|(_, key, _)| key == "id")
        .unwrap()
        .2
        .clone();
    let changed = xml.replacen(&format!(r#"r:id="{id}""#), r#"w:anchor="bookmark""#, 1);
    let at = changed.rfind("w:anchor=\"bookmark\"").unwrap();
    let mut changed = changed;
    changed.replace_range(
        at..at + "w:anchor=\"bookmark\"".len(),
        &format!(r#"r:id="{id}""#),
    );
    let corrupt = zip(&replace(&entries, "word/document.xml", &changed), false);
    assert!(!model.lock().unwrap().same_as(&corrupt));
    let preservation = service::check_saved(Format::Docx, &original, &corrupt, None, true);
    assert!(preservation.is_safe(), "{preservation:?}");
    let registry = doc.state.registry();
    let result = {
        let ticket = registry
            .begin_save(
                doc.info.session_id,
                doc.info.load_generation,
                doc.info.revision,
            )
            .unwrap();
        service::save(
            registry,
            &ticket,
            &Limits::default(),
            &corrupt,
            None,
            model.lock().unwrap().same_as(&corrupt),
        )
    };
    assert!(
        matches!(result,Err(DocumentError::UnsafeSave{preservation}) if preservation.findings.iter().any(|f|f.code==FindingCode::ReopenMismatch))
    );
    assert_eq!(Sha256::digest(doc.bytes()), Sha256::digest(&original));
    assert!(doc.info.dirty);
    assert!(doc.leftovers().is_empty());
    // A represented movement is a legitimate editable-body transformation:
    // load that model, canonicalize/export it and compare to its own output.
    let represented = DocxModel::open(&corrupt).unwrap();
    let represented_output = represented.export().unwrap();
    assert!(represented.same_as(&represented_output));
    assert!(
        service::check_saved(Format::Docx, &original, &represented_output, None, true).is_safe()
    );
    assert!(!doc.save().unwrap().session.dirty); // ordinary output remains publishable.
}

/// Number of relationship references (`r:*`) in `word/document.xml`.
fn body_reference_count(bytes: &[u8]) -> usize {
    let package = package::open(bytes, package::Side::Original).unwrap();
    let body = package.get("word/document.xml").unwrap();
    let mut n = 0;
    assert!(xml::relationship_references_equal(body, body, |_, _| {
        n += 1;
        true
    })
    .unwrap());
    n
}

/// Comments on part of a hyperlink: see `docx_semantic_acceptance::hyperlink_comments_*` (T013 Stage 4). Until
/// 2026-11-05 Stage 4 this diagnostic pinned a conservative refusal (body r:* reference count 1 → 2).
#[test]
fn diagnostic_a_comment_split_reuses_one_relationship() {
    let body = paragraph(&link("First", r#"r:id="linkA""#));
    let original = io::save_bytes(
        "fixture.docx",
        &io::open_bytes(
            "fixture.docx",
            &zip(&position_package(&body, false, false), false),
        )
        .unwrap(),
    )
    .unwrap();
    let mut session = Session::new(io::open_bytes("x.docx", &original).unwrap());
    session
        .run(
            "select.range",
            &serde_json::json!({
                "anchor": wordcraft_engine::doc::Pos::body(0, 0),
                "focus": wordcraft_engine::doc::Pos::body(0, 1),
            }),
        )
        .unwrap();
    session
        .run("review.newComment", &serde_json::json!({"text": "split"}))
        .unwrap();
    let output = io::save_bytes("x.docx", &session.doc).unwrap();
    assert_eq!(
        (
            body_reference_count(&original),
            body_reference_count(&output)
        ),
        (1, 2)
    );
    let rels = |bytes: &[u8]| {
        let p = package::open(bytes, package::Side::Original).unwrap();
        String::from_utf8(p.parts["word/_rels/document.xml.rels"].1.clone())
            .unwrap()
            .matches("/hyperlink\"")
            .count()
    };
    assert_eq!(
        (rels(&original), rels(&output)),
        (1, 1),
        "both halves reuse one relationship"
    );
}

/// The refusal must be `UnsafeSave` whose only finding is `ReopenMismatch`
/// (DOCX takes no loss report, so the evidence gate emits exactly that code).
pub(super) fn assert_reopen_mismatch_only(name: &str, error: &DocumentError) {
    match error {
        DocumentError::UnsafeSave { preservation } => {
            assert_eq!(preservation.outcome, Outcome::Unsafe, "{name}");
            assert_eq!(
                preservation.findings,
                vec![Finding::new(FindingCode::ReopenMismatch)],
                "{name}: unrelated failure classification"
            );
        }
        other => panic!("{name}: expected UnsafeSave(ReopenMismatch), got {other:?}"),
    }
}

fn body_end(session: &mut Session) {
    session.run("caret.set", &json!({"pos":wordcraft_engine::doc::Pos::new(wordcraft_engine::doc::StoryRef::Body,wordcraft_engine::doc::Path(vec![3]),basic::AFTER.len())})).unwrap();
}
fn picture(session: &mut Session) {
    session.run("insert.picture", &json!({"data":PNG})).unwrap();
}
pub(super) fn rich_fixture(
    header: bool,
    footer: bool,
    body_image: bool,
    header_image: bool,
    footer_image: bool,
) -> Session {
    let mut s = Session::new(io::open_bytes("fixture.docx", &basic::basic_ko().unwrap()).unwrap());
    if header {
        s.run("insert.header", &json!({"text":"preserved header"}))
            .unwrap();
        if header_image {
            picture(&mut s);
        }
    }
    if footer {
        s.run("insert.footer", &json!({"text":"preserved footer"}))
            .unwrap();
        if footer_image {
            picture(&mut s);
        }
    }
    if body_image {
        body_end(&mut s);
        picture(&mut s);
    }
    s
}
fn snapshot(doc: &wordcraft_engine::doc::Document) -> Value {
    let mut value = serde_json::to_value(doc).unwrap();
    // Document's derived PartialEq includes these serde-skipped fields. Compare
    // content hashes/lengths and exact keys, not Arc identity or binary dumps.
    for (key, map) in [("media", &doc.media), ("passthrough", &doc.passthrough)] {
        value[key]=json!(map.iter().map(|(name,bytes)|(name.clone(), json!({"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes.as_slice()))}))).collect::<std::collections::BTreeMap<_,_>>());
    }
    value
}
fn differing_paths(a: &Value, b: &Value, path: &str, out: &mut Vec<String>) {
    if a == b || out.len() >= 24 {
        return;
    }
    match (a, b) {
        (Value::Object(a), Value::Object(b)) => {
            let keys: std::collections::BTreeSet<_> = a.keys().chain(b.keys()).collect();
            for key in keys {
                differing_paths(
                    a.get(key).unwrap_or(&Value::Null),
                    b.get(key).unwrap_or(&Value::Null),
                    &format!("{path}/{key}"),
                    out,
                );
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                differing_paths(a, b, &format!("{path}/{i}"), out);
            }
        }
        _ => out.push(format!(
            "{path}: {} -> {}",
            a.to_string().chars().take(180).collect::<String>(),
            b.to_string().chars().take(180).collect::<String>()
        )),
    }
}
fn model_diff(
    a: &wordcraft_engine::doc::Document,
    b: &wordcraft_engine::doc::Document,
) -> Vec<String> {
    let mut out = Vec::new();
    differing_paths(&snapshot(a), &snapshot(b), "", &mut out);
    out
}

#[test]
fn diagnostic_b_feature_matrix() {
    for (name, h, f, bi, hi, fi) in [
        ("B0", false, false, false, false, false),
        ("B1", true, false, false, false, false),
        ("B2", false, true, false, false, false),
        ("B3", false, false, true, false, false),
        ("B4", true, false, false, true, false),
        ("B5", false, true, false, false, true),
        ("B6", true, true, false, false, false),
        ("B7", true, false, true, false, false),
        ("B8", false, true, true, false, false),
        ("B9", true, true, true, false, false),
        ("B10", true, true, true, true, false),
    ] {
        let generated = rich_fixture(h, f, bi, hi, fi);
        use wordcraft_engine::doc::{Block, InlineObject};
        let has_image = |blocks: &wordcraft_engine::doc::Blocks| {
            blocks.iter().any(|block| matches!(&**block, Block::Para(p) if p.objects.iter().any(|o| matches!(o, InlineObject::Image{..}))))
        };
        assert_eq!(generated.doc.last_section.headers.default.is_some(), h);
        assert_eq!(generated.doc.last_section.footers.default.is_some(), f);
        assert_eq!(has_image(&generated.doc.body), bi);
        if let Some(id) = generated.doc.last_section.headers.default {
            assert_eq!(has_image(&generated.doc.parts[&id].blocks), hi);
        }
        if let Some(id) = generated.doc.last_section.footers.default {
            assert_eq!(has_image(&generated.doc.parts[&id].blocks), fi);
        }
        let original = io::save_bytes("fixture.docx", &generated.doc).unwrap();
        let loaded = io::open_bytes("fixture.docx", &original).unwrap();
        let b1 = generated.doc == loaded;
        assert!(b1, "{name}: initial export/reopen");
        let d1 = model_diff(&generated.doc, &loaded);
        let unedited = io::save_bytes("fixture.docx", &loaded).unwrap();
        let preflight = service::preflight(Format::Docx, &original, &unedited, None);
        let mut doc = open_docx(&original);
        assert_eq!(
            doc.preflight().unwrap().preservation.is_safe(),
            preflight.is_safe()
        );
        doc.edit(vec![
            DocxOp::Move {
                to: MoveTarget::DocStart,
                extend: false,
            },
            DocxOp::Move {
                to: MoveTarget::Right,
                extend: true,
            },
            DocxOp::Comment {
                text: "matrix comment".into(),
            },
        ]);
        let model = doc
            .state
            .wordcraft()
            .get(doc.info.session_id, doc.info.load_generation)
            .unwrap();
        let model = model.lock().unwrap();
        let output = model.export().unwrap();
        let reopened = io::open_bytes("fixture.docx", &output).unwrap();
        let b3 = model.same_as(&output);
        let d3 = model_diff(model.diagnostic_document(), &reopened);
        // Historical evidence (before semantic integration): the derived structural
        // equality still sees the Part ID permutation for every header/footer case.
        let structural = *model.diagnostic_document() == reopened;
        assert_eq!(structural, !(h || f), "{name}: structural ID boundary");
        // Production contract since the semantic round-trip integration: same_as()
        // tolerates only that permutation.
        assert!(b3, "{name}: semantic round-trip equivalence");
        let relabeled = relabel_fixture_parts(model.diagnostic_document(), &reopened);
        assert_eq!(
            relabeled, reopened,
            "{name}: no semantic difference may be hidden by the fixture-specific ID relabeling"
        );
        let original_pkg = package::open(&original, package::Side::Original).unwrap();
        let output_pkg = package::open(&output, package::Side::Output).unwrap();
        for part in original_pkg.parts.keys().filter(|p| {
            p.starts_with("word/header")
                || p.starts_with("word/footer")
                || p.starts_with("word/media/")
                || p.starts_with("word/_rels/header")
                || p.starts_with("word/_rels/footer")
        }) {
            assert_eq!(
                original_pkg.get(part),
                output_pkg.get(part),
                "{name} unchanged rich package part {part}"
            );
        }

        let preserve = service::check_saved(Format::Docx, &original, &output, None, true);
        assert!(preflight.is_safe());
        assert!(preserve.is_safe());
        drop(model);
        assert!(
            doc.info.dirty,
            "{name}: edited session must be dirty before save"
        );
        let saved = doc.save();
        let save_ok = saved.is_ok();
        // Before integration B1/B2/B4-B10 were refused with exactly [ReopenMismatch]
        // (commit ad89e53); now every case publishes through the real save path.
        match &saved {
            Ok(saved) => {
                assert!(!saved.session.dirty);
                assert!(!doc.state.registry().get(doc.info.session_id).unwrap().dirty);
                assert_eq!(saved.bytes, output.len());
                assert_eq!(Sha256::digest(doc.bytes()), Sha256::digest(&output));
            }
            Err(error) => panic!("{name}: unexpected failure {error:?}"),
        }
        assert!(doc.leftovers().is_empty(), "{name}: {:?}", doc.leftovers());
        let current = doc.state.registry().get(doc.info.session_id).unwrap();
        assert!(
            doc.state
                .registry()
                .begin_save(
                    current.session_id,
                    current.load_generation,
                    current.revision
                )
                .is_ok(),
            "{name}: save ticket must be released"
        );
        eprintln!("MATRIX {name} B1={b1} preflight={} structural_equal={structural} semantic_equal={b3} package={} save={save_ok} error={:?}\n INITIAL_DIFF={d1:?}\n EDIT_DIFF={d3:?}",preflight.is_safe(),preserve.is_safe(),saved.err());
    }
}

/// Diagnostic counterfactual for THESE generated fixtures only. Map by semantic
/// roots (header/footer roles and comment IDs), require a complete bijection and
/// exact Part equality, then require full derived Document equality. This is
/// deliberately not a production semantic-comparison implementation.
fn relabel_fixture_parts(
    a: &wordcraft_engine::doc::Document,
    b: &wordcraft_engine::doc::Document,
) -> wordcraft_engine::doc::Document {
    let mut map = std::collections::BTreeMap::new();
    for (a, b) in [
        (
            a.last_section.headers.default,
            b.last_section.headers.default,
        ),
        (a.last_section.headers.first, b.last_section.headers.first),
        (a.last_section.headers.even, b.last_section.headers.even),
        (
            a.last_section.footers.default,
            b.last_section.footers.default,
        ),
        (a.last_section.footers.first, b.last_section.footers.first),
        (a.last_section.footers.even, b.last_section.footers.even),
    ] {
        assert_eq!(a.is_some(), b.is_some());
        if let (Some(a), Some(b)) = (a, b) {
            if let Some(old) = map.insert(a, b) {
                assert_eq!(old, b);
            }
        }
    }
    for (id, comment) in &a.comments {
        assert!(map
            .insert(comment.part, b.comments.get(id).unwrap().part)
            .is_none());
    }
    assert_eq!(map.len(), a.parts.len());
    assert_eq!(map.len(), b.parts.len());
    assert_eq!(
        map.values()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        map.len()
    );
    for (old, new) in &map {
        assert_eq!(a.parts.get(old), b.parts.get(new));
    }
    let mut out = a.clone();
    out.parts = a
        .parts
        .iter()
        .map(|(id, part)| (map[id], part.clone()))
        .collect();
    for field in [
        &mut out.last_section.headers.default,
        &mut out.last_section.headers.first,
        &mut out.last_section.headers.even,
        &mut out.last_section.footers.default,
        &mut out.last_section.footers.first,
        &mut out.last_section.footers.even,
    ]
    .into_iter()
    .flatten()
    {
        *field = map[field];
    }
    for comment in out.comments.values_mut() {
        comment.part = map[&comment.part];
    }
    out
}

/// Hyperlink assignment of body paragraph `index` from WordCraft's actual
/// representation: `Run { len (UTF-8 bytes), props.link }` over `Paragraph.text`.
/// Adjacent runs with the same target are merged; returns (byte range, text, target).
fn body_links(
    doc: &wordcraft_engine::doc::Document,
    index: usize,
) -> Vec<(std::ops::Range<usize>, String, Option<String>)> {
    use wordcraft_engine::doc::Block;
    let Block::Para(para) = &*doc.body[index] else {
        panic!("body block {index} is not a paragraph")
    };
    assert_eq!(
        para.runs.iter().map(|r| r.len).sum::<usize>(),
        para.text.len(),
        "runs cover the paragraph text exactly"
    );
    let mut out: Vec<(std::ops::Range<usize>, String, Option<String>)> = Vec::new();
    let mut at = 0;
    for run in &para.runs {
        let range = at..at + run.len;
        at = range.end;
        match out.last_mut() {
            Some(last) if last.2 == run.props.link && last.0.end == range.start => {
                last.0.end = range.end
            }
            _ => out.push((range, String::new(), run.props.link.clone())),
        }
    }
    for (range, text, _) in &mut out {
        *text = para.text[range.clone()].to_string();
    }
    out
}

#[test]
fn diagnostic_a_engine_authorized_link_edit() {
    use wordcraft_engine::doc::{Path, Pos, StoryRef};
    let body =
        paragraph(&(link("First", r#"r:id="linkA""#) + &link("Second", r#"w:anchor="bookmark""#)));
    let seed = io::open_bytes(
        "fixture.docx",
        &zip(&position_package(&body, false, false), false),
    )
    .unwrap();
    let original = io::save_bytes("fixture.docx", &seed).unwrap();
    let opened = io::open_bytes("fixture.docx", &original).unwrap();
    let external = Some("https://example.org/A".to_string());
    let internal = Some("#bookmark".to_string());
    // 11..17: two U+FFFC object markers (bookmarkStart/End), never linked.
    let markers = (11..17, "\u{FFFC}\u{FFFC}".to_string(), None);
    let before = vec![
        (0..5, "First".to_string(), external.clone()),
        (5..11, "Second".to_string(), internal.clone()),
        markers.clone(),
    ];
    let after = vec![
        (0..5, "First".to_string(), internal.clone()),
        (5..11, "Second".to_string(), external.clone()),
        markers,
    ];
    assert_eq!(body_links(&opened, 0), before, "source assignment");
    let mut session = Session::new(opened);
    for (start, end, url) in [(0, 5, "#bookmark"), (5, 11, "https://example.org/A")] {
        session.run("select.range",&json!({"anchor":Pos::new(StoryRef::Body,Path(vec![0]),start),"focus":Pos::new(StoryRef::Body,Path(vec![0]),end)})).unwrap();
        session.run("insert.link", &json!({"url":url})).unwrap();
    }
    // The authorized edit exchanged the two targets over the same byte ranges.
    assert_eq!(body_links(&session.doc, 0), after, "edited model");
    assert_ne!(before, after);
    let output = io::save_bytes("fixture.docx", &session.doc).unwrap();
    let reopened = io::open_bytes("fixture.docx", &output).unwrap();
    assert_eq!(body_links(&reopened, 0), after, "export/reopen");
    let same = session.doc == reopened;
    assert!(same);
    assert!(service::check_saved(Format::Docx, &original, &output, None, same).is_safe());
    // Actual engine command changes are represented; source/export is canonical.
    // Unlike forced-reopen adversarial calls, this bool comes from model equality.
    let dir = injected_publication(&original, &output, same, true);
    let published = std::fs::read(dir.path().join("a.docx")).unwrap();
    let saved = io::open_bytes("fixture.docx", &published).unwrap();
    assert_eq!(body_links(&saved, 0), after, "published document");
}
