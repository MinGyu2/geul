//! Rich DOCX acceptance after the semantic round-trip integration (`DocxModel::same_as` →
//! `wordcraft_doc::roundtrip::roundtrip_equivalent`).
//!
//! Positive cases use the real production path only: geul session → typed `DocxOp::Comment` →
//! `docx::save` (export + `same_as` + preservation + atomic publication) → a new session on the
//! *published file on disk* → second comment → second publication → reload again.
//!
//! Adversarial cases are **injected-output boundary tests**: the authoritative model is a real
//! edited session, but the output bytes are a deliberately corrupted DOCX (written by the real
//! WordCraft writer from a mutated reopened model, or byte-patched). `same_as` is computed for real
//! on those bytes and its result is what `service::save` receives; nothing forces it.
use std::sync::{Arc, Mutex};

use super::docx_diagnostics::{assert_reopen_mismatch_only, rich_fixture};
use super::*;
use crate::adapters::wordcraft::engine::DocxModel;
use sha2::{Digest, Sha256};
use wordcraft_engine::doc::roundtrip::{
    compare_roundtrip, Difference, Equivalence, RoundTripError, RoundTripLimits, Side,
};
use wordcraft_engine::doc::{
    para_block, Block, CharProps, Document, InlineObject, Paragraph, PartKind, Pos, StoryRef,
    TextBody,
};
use wordcraft_engine::{io, Session};

fn reopen(bytes: &[u8]) -> Document {
    io::open_bytes("x.docx", bytes).unwrap()
}

fn model_of(doc: &Docx) -> Arc<Mutex<DocxModel>> {
    doc.state
        .wordcraft()
        .get(doc.info.session_id, doc.info.load_generation)
        .unwrap()
}

/// A comment through the typed IPC operation; every operation must be accepted.
fn comment(doc: &mut Docx, at_end: bool, text: &str) {
    let (to, dir) = if at_end {
        (MoveTarget::DocEnd, MoveTarget::Left)
    } else {
        (MoveTarget::DocStart, MoveTarget::Right)
    };
    let mut ops = vec![DocxOp::Move { to, extend: false }];
    ops.extend((0..3).map(|_| DocxOp::Move {
        to: dir,
        extend: true,
    }));
    ops.push(DocxOp::Comment { text: text.into() });
    let edited = block_on(docx::edit(
        &doc.state,
        doc.info.session_id,
        doc.info.load_generation,
        doc.info.revision,
        ops,
    ))
    .unwrap();
    assert!(edited.rejected.is_empty(), "{:?}", edited.rejected);
    doc.info = edited.session;
    assert!(doc.info.dirty);
}

/// A new session on the file at the same path, read from disk (the published file).
fn reload(doc: Docx) -> Docx {
    let Docx { dir, path, .. } = doc;
    let state = DocumentState::default();
    let file = identify(path.to_str().unwrap(), &Limits::default()).unwrap();
    let info = state.registry().register(file).unwrap();
    let loaded = block_on(docx::load(&state, info.session_id, None)).expect("reload published");
    let doc = Docx {
        state,
        dir,
        path,
        info: loaded.session,
    };
    assert!(doc.preflight().unwrap().preservation.is_safe());
    doc
}

fn ticket_released(doc: &Docx) {
    let current = doc.state.registry().get(doc.info.session_id).unwrap();
    assert!(doc
        .state
        .registry()
        .begin_save(
            current.session_id,
            current.load_generation,
            current.revision
        )
        .is_ok());
}

/// Real production save; returns the published bytes read back from disk.
fn publish(doc: &mut Docx, permuted: bool) -> Vec<u8> {
    let before = doc.bytes();
    let output = {
        let model = model_of(doc);
        let model = model.lock().unwrap();
        let output = model.export().unwrap();
        let reopened = reopen(&output);
        let authoritative = model.diagnostic_document();
        // The ID permutation is actually exercised where expected.
        assert_eq!(*authoritative != reopened, permuted, "structural equality");
        let v = compare_roundtrip(authoritative, &reopened, &RoundTripLimits::default());
        assert!(matches!(v, Ok(Equivalence::Equivalent(_))), "{v:?}");
        assert!(model.same_as(&output));
        assert!(service::check_saved(Format::Docx, &before, &output, None, true).is_safe());
        output
    };
    let saved = doc.save().expect("publication");
    assert!(!saved.session.dirty);
    doc.info = saved.session;
    let published = doc.bytes();
    // Export is deterministic: the published file is the verified output.
    assert_eq!(Sha256::digest(&published), Sha256::digest(&output));
    assert!(doc.leftovers().is_empty(), "{:?}", doc.leftovers());
    ticket_released(doc);
    published
}

fn images(doc: &Document) -> Vec<(String, u32, u32)> {
    let mut out = Vec::new();
    let mut scan = |blocks: &wordcraft_engine::doc::Blocks| {
        for b in blocks {
            if let Block::Para(p) = &**b {
                for o in &p.objects {
                    if let InlineObject::Image { media, w, h, .. } = o {
                        out.push((media.clone(), w.to_bits(), h.to_bits()));
                    }
                }
            }
        }
    };
    scan(&doc.body);
    for part in doc.parts.values() {
        scan(&part.blocks);
    }
    out.sort();
    out
}

fn rich_parts(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    package::open(bytes, package::Side::Original)
        .unwrap()
        .parts
        .into_iter()
        .filter(|(p, _)| {
            [
                "word/header",
                "word/footer",
                "word/media/",
                "word/_rels/header",
                "word/_rels/footer",
            ]
            .iter()
            .any(|prefix| p.starts_with(prefix))
        })
        .map(|(p, (_, bytes))| (p, bytes))
        .collect()
}

const MATRIX: [(&str, bool, bool, bool, bool, bool); 11] = [
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
];

#[test]
fn rich_docx_first_and_second_published_saves() {
    for (name, h, f, bi, hi, fi) in MATRIX {
        let generated = rich_fixture(h, f, bi, hi, fi).doc;
        let original = io::save_bytes("fixture.docx", &generated).unwrap();
        let mut doc = open_docx(&original);
        assert!(
            doc.preflight().unwrap().preservation.is_safe(),
            "{name} preflight"
        );

        comment(&mut doc, false, "first comment");
        let first = publish(&mut doc, h || f);
        let mut doc = reload(doc);
        assert_eq!(doc.bytes(), first);
        assert_eq!(
            model_of(&doc)
                .lock()
                .unwrap()
                .diagnostic_document()
                .comments
                .len(),
            1,
            "{name}"
        );

        comment(&mut doc, true, "second comment");
        let second = publish(&mut doc, h || f);
        let doc = reload(doc);
        let model = model_of(&doc);
        let model = model.lock().unwrap();
        let fin = model.diagnostic_document();

        // Both comments, their text and author.
        let mut texts: Vec<String> = fin
            .comments
            .values()
            .map(|c| {
                assert_eq!(c.author, crate::adapters::wordcraft::engine::COMMENT_AUTHOR);
                fin.plain_text(StoryRef::Part(c.part)).trim().to_owned()
            })
            .collect();
        texts.sort();
        assert_eq!(texts, ["first comment", "second comment"], "{name}");
        // Header/footer stories, and every original image's bytes and size.
        for (present, set, text) in [
            (h, fin.last_section.headers.default, "preserved header"),
            (f, fin.last_section.footers.default, "preserved footer"),
        ] {
            assert_eq!(set.is_some(), present, "{name}");
            if let Some(id) = set {
                assert!(fin.plain_text(StoryRef::Part(id)).contains(text), "{name}");
            }
        }
        assert_eq!(fin.media, generated.media, "{name} media bytes");
        assert_eq!(images(fin), images(&generated), "{name} image size");
        // Unrelated rich package parts are byte-identical to the original.
        assert_eq!(rich_parts(&second), rich_parts(&original), "{name}");
        assert!(doc.leftovers().is_empty());
        drop(model);
        ticket_released(&doc);
        eprintln!("ACCEPT {name}: first+second publication, reload from disk, 2 comments");
    }
}

// ---- alias / link fixtures ----

fn basic_session() -> Session {
    Session::new(io::open_bytes("fixture.docx", &basic::basic_ko().unwrap()).unwrap())
}

fn header_story(s: &Session) -> u32 {
    s.doc.last_section.headers.default.unwrap()
}

/// First-page header either shared with the default header or a distinct identical copy.
fn title_page_fixture(shared: bool) -> Vec<u8> {
    let mut s = basic_session();
    s.run("insert.header", &json!({"text": "preserved header"}))
        .unwrap();
    s.run("insert.closeHeader", &json!({})).unwrap();
    let default = header_story(&s);
    s.doc.last_section.title_page = true;
    let first = if shared {
        default
    } else {
        let blocks = s.doc.parts[&default].blocks.clone();
        s.doc.add_part(PartKind::Header, blocks)
    };
    s.doc.last_section.headers.first = Some(first);
    io::save_bytes("fixture.docx", &s.doc).unwrap()
}

fn linked_boxes_fixture() -> Vec<u8> {
    let mut s = basic_session();
    s.run("insert.header", &json!({"text": "preserved header"}))
        .unwrap();
    s.run("insert.closeHeader", &json!({})).unwrap();
    s.run("caret.set", &json!({"pos": Pos::body(0, 0)}))
        .unwrap();
    s.run(
        "insert.textBox",
        &json!({"text": "Some text that flows on"}),
    )
    .unwrap();
    s.run("caret.set", &json!({"pos": Pos::body(1, 0)}))
        .unwrap();
    s.run("insert.textBox", &json!({})).unwrap();
    s.run("select.objects", &json!({"index": 0})).unwrap();
    s.run("shape.link", &json!({"target": 1})).unwrap();
    assert_eq!(s.doc.text_box_chains().len(), 1);
    io::save_bytes("fixture.docx", &s.doc).unwrap()
}

/// ID-independent graph of every non-comment story: header/footer roles, text box shapes at
/// stable anchors, and `TextBody::next` edges. Parts get canonical indices in discovery order
/// (roles, then shapes in document order, then link targets), so raw part ids never compare.
#[derive(Debug, PartialEq)]
struct StoryGraph {
    /// (role, node): `header.default`, `footer.first`, …
    roles: Vec<(String, usize)>,
    /// (anchor `story:block@byte`, the shape without its story id, node).
    shapes: Vec<(String, InlineObject, usize)>,
    /// Per node: kind, plain text, blocks, text body without `next`, `next` node.
    nodes: Vec<(
        PartKind,
        String,
        wordcraft_engine::doc::Blocks,
        TextBody,
        Option<usize>,
    )>,
    /// `Document::text_box_chains` in node indices: entry points, order, termination.
    chains: Vec<Vec<usize>>,
}

fn story_graph(d: &Document) -> StoryGraph {
    let mut ids: Vec<u32> = Vec::new();
    let node = |id: u32, ids: &mut Vec<u32>| match ids.iter().position(|x| *x == id) {
        Some(i) => i,
        None => {
            ids.push(id);
            ids.len() - 1
        }
    };
    let mut roles = Vec::new();
    for (role, set) in [
        ("header", d.last_section.headers),
        ("footer", d.last_section.footers),
    ] {
        for (slot, id) in [
            ("default", set.default),
            ("first", set.first),
            ("even", set.even),
        ] {
            if let Some(id) = id {
                roles.push((format!("{role}.{slot}"), node(id, &mut ids)));
            }
        }
    }
    let mut shapes = Vec::new();
    let mut stories = vec![("body".to_owned(), d.body.clone())];
    for (role, n) in &roles {
        stories.push((role.clone(), d.parts[&ids[*n]].blocks.clone()));
    }
    for (name, blocks) in stories {
        for (bi, b) in blocks.iter().enumerate() {
            let Block::Para(p) = &**b else { continue };
            let offsets: Vec<usize> = p
                .text
                .char_indices()
                .filter(|(_, c)| *c == '\u{FFFC}')
                .map(|(i, _)| i)
                .collect();
            // Anchor = byte offset with comment markers removed: the edits under test add only
            // comments, and their U+FFFC markers must not move an otherwise unchanged shape.
            let mut markers = 0;
            for (oi, o) in p.objects.iter().enumerate() {
                assert!(
                    !matches!(o, InlineObject::Group { .. }),
                    "fixture has no groups"
                );
                if matches!(
                    o,
                    InlineObject::CommentStart { .. } | InlineObject::CommentEnd { .. }
                ) {
                    markers += 1;
                    continue;
                }
                if let InlineObject::Shape {
                    story: Some(id), ..
                } = o
                {
                    let mut bare = o.clone();
                    if let InlineObject::Shape { story, .. } = &mut bare {
                        *story = None;
                    }
                    let at = offsets[oi] - markers * '\u{FFFC}'.len_utf8();
                    shapes.push((format!("{name}:{bi}@{at}"), bare, node(*id, &mut ids)));
                }
            }
        }
    }
    let mut nodes = Vec::new();
    let mut i = 0;
    while i < ids.len() {
        let part = &d.parts[&ids[i]];
        let next = part.body.next.map(|n| node(n, &mut ids));
        let body = TextBody {
            next: None,
            ..part.body
        };
        nodes.push((
            part.kind,
            d.plain_text(StoryRef::Part(ids[i])),
            part.blocks.clone(),
            body,
            next,
        ));
        i += 1;
    }
    // Coverage: every non-comment part is in the graph.
    assert_eq!(
        d.parts
            .values()
            .filter(|p| p.kind != PartKind::Comment)
            .count(),
        ids.len(),
        "unreached story"
    );
    let chains = d
        .text_box_chains()
        .iter()
        .map(|c| {
            c.iter()
                .map(|id| {
                    ids.iter()
                        .position(|x| x == id)
                        .expect("chained box in graph")
                })
                .collect()
        })
        .collect();
    StoryGraph {
        roles,
        shapes,
        nodes,
        chains,
    }
}

fn graph_of(doc: &Docx) -> StoryGraph {
    story_graph(model_of(doc).lock().unwrap().diagnostic_document())
}

/// Shared and distinct first-page headers and linked text boxes publish twice; their full story
/// graph (roles, shape anchors, story identity/sharing, link edges, chains, contents) is the same
/// in the original, both published files and every reopened model.
#[test]
fn aliases_and_linked_text_boxes_publish_twice() {
    for (name, original) in [
        ("shared title-page header", title_page_fixture(true)),
        ("distinct title-page header", title_page_fixture(false)),
        ("linked text boxes", linked_boxes_fixture()),
    ] {
        let expected = story_graph(&reopen(&original));
        let mut doc = open_docx(&original);
        assert!(doc.preflight().unwrap().preservation.is_safe(), "{name}");
        assert_eq!(graph_of(&doc), expected, "{name}: loaded");
        comment(&mut doc, false, "first comment");
        let first = publish(&mut doc, true);
        assert_eq!(story_graph(&reopen(&first)), expected, "{name}: first file");
        let mut doc = reload(doc);
        assert_eq!(graph_of(&doc), expected, "{name}: first reopened");
        comment(&mut doc, true, "second comment");
        let second = publish(&mut doc, true);
        assert_eq!(
            story_graph(&reopen(&second)),
            expected,
            "{name}: second file"
        );
        let doc = reload(doc);
        assert_eq!(graph_of(&doc), expected, "{name}: final reopened");
        assert_eq!(
            model_of(&doc)
                .lock()
                .unwrap()
                .diagnostic_document()
                .comments
                .len(),
            2,
            "{name}"
        );
        // The fixtures are what they claim to be (independent of the round trip).
        match name {
            "shared title-page header" => {
                assert_eq!(expected.roles.len(), 2);
                assert_eq!(expected.roles[0].1, expected.roles[1].1, "one shared story");
            }
            "distinct title-page header" => {
                assert_ne!(expected.roles[0].1, expected.roles[1].1, "two stories");
                assert_eq!(
                    expected.nodes[0].2, expected.nodes[1].2,
                    "identical content"
                );
            }
            _ => {
                assert_eq!(expected.shapes.len(), 2);
                let (a, b) = (expected.shapes[0].2, expected.shapes[1].2);
                assert_ne!(a, b, "two distinct box stories");
                assert_eq!(expected.nodes[a].4, Some(b), "first links to second");
                assert_eq!(expected.nodes[b].4, None, "chain terminates");
                assert_eq!(expected.chains, vec![vec![a, b]]);
                assert_eq!(expected.nodes[a].1.trim(), "Some text that flows on");
            }
        }
        eprintln!(
            "GRAPH {name}: {} roles, {} shapes, {} nodes, chains {:?}",
            expected.roles.len(),
            expected.shapes.len(),
            expected.nodes.len(),
            expected.chains
        );
    }
}

// ---- adversarial (injected-output boundary) ----

/// A real edited session (one comment, so header/footer ids are permuted) and the model the
/// production export reopens to.
fn edited(original: &[u8]) -> (Docx, Document) {
    let mut doc = open_docx(original);
    assert!(doc.preflight().unwrap().preservation.is_safe());
    comment(&mut doc, false, "first comment");
    let output = model_of(&doc).lock().unwrap().export().unwrap();
    let reopened = reopen(&output);
    (doc, reopened)
}

fn rich_original() -> Vec<u8> {
    io::save_bytes(
        "fixture.docx",
        &rich_fixture(true, true, true, true, false).doc,
    )
    .unwrap()
}

/// The real save service refuses `corrupt` given the production `same_as` result: exactly
/// `[ReopenMismatch]` from the evidence gate, original bytes unchanged, still dirty, no staging
/// files, ticket released.
fn assert_save_refused(name: &str, doc: &Docx, corrupt: &[u8], same: bool) {
    assert!(!same, "{name}: same_as must not be true");
    let original = doc.bytes();
    let registry = doc.state.registry();
    let result = {
        let ticket = registry
            .begin_save(
                doc.info.session_id,
                doc.info.load_generation,
                doc.info.revision,
            )
            .unwrap();
        service::save(registry, &ticket, &Limits::default(), corrupt, None, same)
    };
    let error = result.expect_err(name);
    assert_reopen_mismatch_only(name, &error);
    assert_eq!(
        Sha256::digest(doc.bytes()),
        Sha256::digest(&original),
        "{name}"
    );
    assert!(registry.get(doc.info.session_id).unwrap().dirty, "{name}");
    assert!(doc.leftovers().is_empty(), "{name}");
    ticket_released(doc);
}

/// Category 2 — semantic comparator rejection. The output MUST reopen; `compare_roundtrip` is
/// called explicitly and must give exactly `expected`; then `same_as` and the save service.
fn refuse_semantic(
    name: &str,
    doc: &Docx,
    corrupt: &[u8],
    expected: Result<Equivalence, RoundTripError>,
) {
    assert!(
        !matches!(expected, Ok(Equivalence::Equivalent(_))),
        "{name}: bad expectation"
    );
    let model = model_of(doc);
    let same = {
        let model = model.lock().unwrap();
        let reopened = io::open_bytes("x.docx", corrupt)
            .unwrap_or_else(|e| panic!("{name}: must be parseable, reopen failed: {e}"));
        let verdict = compare_roundtrip(
            model.diagnostic_document(),
            &reopened,
            &RoundTripLimits::default(),
        );
        assert_eq!(verdict, expected, "{name}");
        model.same_as(corrupt)
    };
    assert_save_refused(name, doc, corrupt, same);
    eprintln!("REFUSE(semantic) {name}: {expected:?}");
}

/// Category 1 — parser rejection. The output MUST fail to reopen, so the comparator never ran;
/// `same_as` is false and publication is refused. The package layer is classified separately
/// (with the engine bit forced true) to show which non-engine finding would also refuse it; the
/// caller asserts the expected package findings.
fn refuse_parser(name: &str, doc: &Docx, corrupt: &[u8]) -> Vec<Finding> {
    assert!(
        io::open_bytes("x.docx", corrupt).is_err(),
        "{name}: must be refused by the parser"
    );
    let same = model_of(doc).lock().unwrap().same_as(corrupt);
    let package = service::check_saved(Format::Docx, &doc.bytes(), corrupt, None, true);
    assert!(!package.is_safe(), "{name}: package layer {package:?}");
    assert!(
        !package
            .findings
            .iter()
            .any(|f| f.code == FindingCode::ReopenMismatch),
        "{name}: the package-layer evaluation must not carry the engine finding"
    );
    assert_save_refused(name, doc, corrupt, same);
    eprintln!(
        "REFUSE(parser) {name}: package findings {:?}",
        package.findings
    );
    package.findings
}

fn field(what: &'static str) -> Result<Equivalence, RoundTripError> {
    Ok(Equivalence::Different(Difference::Field(what)))
}

fn para(text: &str) -> Arc<Block> {
    para_block(Paragraph::with_text(text, CharProps::default()))
}

fn set_text(d: &mut Document, id: u32, text: &str) {
    d.parts.get_mut(&id).unwrap().blocks = vec![para(text)];
}

fn written(d: &Document) -> Vec<u8> {
    io::save_bytes("x.docx", d).unwrap()
}

fn byte_patch(output: &[u8], name: &str, f: impl Fn(&str) -> String) -> Vec<u8> {
    let package = package::open(output, package::Side::Original).unwrap();
    let entries: Vec<_> = package
        .order
        .iter()
        .filter_map(|n| {
            let data = &package.parts.get(n)?.1;
            if n == name {
                Some(entry(n, f(std::str::from_utf8(data).unwrap()).as_bytes()))
            } else {
                Some(entry(n, data))
            }
        })
        .collect();
    zip(&entries, false)
}

fn without(output: &[u8], name: &str) -> Vec<u8> {
    let package = package::open(output, package::Side::Original).unwrap();
    let entries: Vec<_> = package
        .order
        .iter()
        .filter(|n| *n != name)
        .filter_map(|n| Some(entry(n, &package.parts.get(n)?.1)))
        .collect();
    zip(&entries, false)
}

/// Category 2 (semantic) A–H, L, O, K, M, P on the B10 rich fixture; category 1 (parser) R1, R3;
/// and R2, refused only by the package layer. Every category-2 output reopens: none of A–P is a
/// parser rejection (the reader turns a missing header part or relationship into a model that the
/// comparator then rejects), and a malformed main part is tolerated by the reader (R2).
#[test]
fn adversarial_rich_outputs_are_refused() {
    let original = rich_original();
    type Mutation = Box<dyn Fn(&mut Document)>;
    type Expected = Result<Equivalence, RoundTripError>;
    // Each mutated model is written by the real WordCraft writer, so every output is parseable;
    // the expected verdict is the first difference in the comparator's documented walk order.
    let cases: Vec<(&str, Mutation, Expected)> = vec![
        (
            "A header text",
            Box::new(|d| {
                let h = d.last_section.headers.default.unwrap();
                set_text(d, h, "preserved headeR")
            }),
            field("paragraph"),
        ),
        (
            "B footer text",
            Box::new(|d| {
                let f = d.last_section.footers.default.unwrap();
                set_text(d, f, "preserved footeR")
            }),
            field("paragraph"),
        ),
        (
            "C image bytes",
            Box::new(|d| {
                for v in d.media.values_mut() {
                    let mut bytes = (**v).clone();
                    bytes.push(0);
                    *v = Arc::new(bytes);
                }
            }),
            field("media"),
        ),
        (
            "D image dimensions",
            Box::new(|d| {
                for b in d.body.iter_mut() {
                    if let Block::Para(p) = Arc::make_mut(b) {
                        for o in &mut p.objects {
                            if let InlineObject::Image { w, .. } = o {
                                *w += 10.0;
                            }
                        }
                    }
                }
            }),
            field("inline object"),
        ),
        (
            "E comment text",
            Box::new(|d| {
                let c = d.comments.values().next().unwrap().part;
                set_text(d, c, "other comment")
            }),
            field("paragraph"),
        ),
        (
            "F comment author",
            Box::new(|d| d.comments.values_mut().next().unwrap().author = "mallory".into()),
            field("comment"),
        ),
        (
            "G comment anchor moved",
            Box::new(|d| {
                let id = *d.comments.keys().next().unwrap();
                for b in d.body.iter_mut() {
                    let Block::Para(p) = Arc::make_mut(b) else {
                        continue;
                    };
                    let Some(k) = p
                        .objects
                        .iter()
                        .position(|o| matches!(o, InlineObject::CommentEnd { .. }))
                    else {
                        continue;
                    };
                    let off = p
                        .text
                        .char_indices()
                        .filter(|(_, c)| *c == '\u{FFFC}')
                        .nth(k)
                        .unwrap()
                        .0;
                    p.delete(off, off + 3).unwrap();
                    let end = p.text.len();
                    p.insert_object(end, InlineObject::CommentEnd { id }, &CharProps::default())
                        .unwrap();
                    return;
                }
                panic!("no comment end");
            }),
            field("paragraph"),
        ),
        (
            "H header/footer references exchanged",
            Box::new(|d| {
                let s = &mut d.last_section;
                std::mem::swap(&mut s.headers.default, &mut s.footers.default);
            }),
            field("paragraph"),
        ),
        (
            "L unexpected part introduced (even header)",
            Box::new(|d| {
                let id = d.add_part(PartKind::Header, vec![para("stray")]);
                d.last_section.headers.even = Some(id);
            }),
            field("parts.len"),
        ),
        (
            "O permutation plus unrelated body change",
            Box::new(|d| {
                if let Block::Para(p) = Arc::make_mut(d.body.last_mut().unwrap()) {
                    let end = p.text.len();
                    p.insert_text(end, " tampered", &CharProps::default())
                        .unwrap();
                }
            }),
            field("paragraph"),
        ),
    ];
    for (name, mutate, expected) in cases {
        let (doc, mut reopened) = edited(&original);
        mutate(&mut reopened);
        refuse_semantic(name, &doc, &written(&reopened), expected);
    }
    // Byte-level cases on the real export: still parseable, so still category 2.
    let (doc, _) = edited(&original);
    let output = model_of(&doc).lock().unwrap().export().unwrap();
    let pkg = package::open(&output, package::Side::Original).unwrap();
    let header = pkg
        .order
        .iter()
        .find(|n| n.starts_with("word/header"))
        .unwrap()
        .clone();
    refuse_semantic(
        "K referenced part removed (header part file deleted)",
        &doc,
        &without(&output, &header),
        field("paragraph"),
    );
    refuse_semantic(
        "M part kind changed (header reference read as footer)",
        &doc,
        &byte_patch(&output, "word/document.xml", |x| {
            x.replace("<w:headerReference ", "<w:footerReference ")
        }),
        Ok(Equivalence::Different(Difference::ReferencePresence(
            "header/footer default",
        ))),
    );
    refuse_semantic(
        "P malformed reference (missing relationship id)",
        &doc,
        &byte_patch(&output, "word/document.xml", |x| {
            let at = x.find("<w:headerReference ").unwrap();
            let id = at + x[at..].find("r:id=\"").unwrap() + "r:id=\"".len();
            let end = id + x[id..].find('"').unwrap();
            format!("{}rIdMissing{}", &x[..id], &x[end..])
        }),
        field("parts.len"),
    );
    // Category 1: packages WordCraft cannot reopen at all. Both fail format detection in
    // `check_saved` (R1: ZIP directory unreadable; R3: no main part), whose contract is
    // `OutputMalformed` at "container" (a resource failure could add `LimitExceeded`, so the
    // finding is required to be present, not to be the only one).
    let malformed = Finding::at(FindingCode::OutputMalformed, "container");
    let truncated = &output[..output.len() / 2];
    let r1 = refuse_parser("R1 truncated package", &doc, truncated);
    assert!(r1.contains(&malformed), "R1: {r1:?}");
    let r3 = refuse_parser(
        "R3 main part missing",
        &doc,
        &without(&output, "word/document.xml"),
    );
    assert!(r3.contains(&malformed), "R3: {r3:?}");
    // R2 — neither category: the WordCraft reader *tolerates* a malformed main part and reopens
    // it to an equivalent model, so the engine gate passes (as the old derived equality did). The
    // package layer is what refuses it. Asserted as such, not counted as engine evidence.
    for (name, corrupt) in [
        (
            "R2 mismatched end tag",
            byte_patch(&output, "word/document.xml", |x| {
                x.replacen("</w:body>", "</w:bodyX>", 1)
            }),
        ),
        (
            "R2 broken start tag",
            byte_patch(&output, "word/document.xml", |x| {
                x.replacen("<w:body>", "<w:body><w:p <<", 1)
            }),
        ),
    ] {
        let model = model_of(&doc);
        let same = {
            let model = model.lock().unwrap();
            let reopened = io::open_bytes("x.docx", &corrupt).expect("reader is lenient");
            assert!(matches!(
                compare_roundtrip(
                    model.diagnostic_document(),
                    &reopened,
                    &RoundTripLimits::default()
                ),
                Ok(Equivalence::Equivalent(_))
            ));
            model.same_as(&corrupt)
        };
        assert!(same, "{name}: the engine gate alone does not catch it");
        let before = doc.bytes();
        let registry = doc.state.registry();
        let result = {
            let ticket = registry
                .begin_save(
                    doc.info.session_id,
                    doc.info.load_generation,
                    doc.info.revision,
                )
                .unwrap();
            service::save(registry, &ticket, &Limits::default(), &corrupt, None, same)
        };
        match result {
            Err(DocumentError::UnsafeSave { preservation }) => {
                let codes: Vec<_> = preservation.findings.iter().map(|f| f.code).collect();
                assert!(
                    codes.contains(&FindingCode::OutputMalformed),
                    "{name}: {codes:?}"
                );
                assert!(
                    !codes.contains(&FindingCode::ReopenMismatch),
                    "{name}: {codes:?}"
                );
            }
            other => panic!("{name}: {other:?}"),
        }
        assert_eq!(Sha256::digest(doc.bytes()), Sha256::digest(&before));
        assert!(registry.get(doc.info.session_id).unwrap().dirty);
        assert!(doc.leftovers().is_empty());
        ticket_released(&doc);
        eprintln!("REFUSE(package) {name}: engine equivalent, package OutputMalformed");
    }
}

/// Title-page fixture with a footer, so a part can be removed elsewhere to keep the part count
/// equal and reach the alias check itself.
fn title_page_with_footer(shared: bool) -> Vec<u8> {
    let mut s = reopen(&title_page_fixture(shared));
    let footer = s.add_part(PartKind::Footer, vec![para("preserved footer")]);
    s.last_section.footers.default = Some(footer);
    io::save_bytes("fixture.docx", &s).unwrap()
}

/// I split / J merge (identical content throughout) and N linked text box. I and J are run both
/// plainly (caught by the part count) and count-balanced (caught by the bijection itself).
#[test]
fn adversarial_alias_and_link_outputs_are_refused() {
    let split = |r: &mut Document| {
        let default = r.last_section.headers.default.unwrap();
        assert_eq!(r.last_section.headers.first, Some(default), "shared");
        let copy = r.parts[&default].blocks.clone();
        r.last_section.headers.first = Some(r.add_part(PartKind::Header, copy));
    };
    let (doc, mut r) = edited(&title_page_fixture(true));
    split(&mut r);
    refuse_semantic(
        "I shared part split",
        &doc,
        &written(&r),
        field("parts.len"),
    );
    let (doc, mut r) = edited(&title_page_with_footer(true));
    let authoritative_default = model_of(&doc)
        .lock()
        .unwrap()
        .diagnostic_document()
        .last_section
        .headers
        .default
        .unwrap();
    split(&mut r);
    let f = r.last_section.footers.default.take().unwrap();
    r.parts.remove(&f);
    refuse_semantic(
        "I shared part split (count-balanced)",
        &doc,
        &written(&r),
        Ok(Equivalence::Different(Difference::Split {
            authoritative: authoritative_default,
        })),
    );

    let merge = |r: &mut Document| {
        let (d, f) = (
            r.last_section.headers.default.unwrap(),
            r.last_section.headers.first.unwrap(),
        );
        assert_ne!(d, f);
        assert_eq!(r.parts[&d].blocks, r.parts[&f].blocks, "identical content");
        r.last_section.headers.first = Some(d);
        r.parts.remove(&f);
    };
    let (doc, mut r) = edited(&title_page_fixture(false));
    merge(&mut r);
    refuse_semantic(
        "J distinct parts merged",
        &doc,
        &written(&r),
        field("parts.len"),
    );
    let (doc, mut r) = edited(&title_page_with_footer(false));
    merge(&mut r);
    // Balance the count with an even-page header; `first` is compared before `even`.
    let even = r.add_part(PartKind::Header, vec![para("even")]);
    r.last_section.headers.even = Some(even);
    let written_j = written(&r);
    let reopened_default = reopen(&written_j).last_section.headers.default.unwrap();
    refuse_semantic(
        "J distinct parts merged (count-balanced)",
        &doc,
        &written_j,
        Ok(Equivalence::Different(Difference::Merge {
            reopened: reopened_default,
        })),
    );

    let (doc, mut r) = edited(&linked_boxes_fixture());
    assert_eq!(r.text_box_chains().len(), 1);
    let before = story_graph(&r);
    for part in r.parts.values_mut() {
        part.body.next = None;
    }
    // The ID-independent graph used by the positive test also sees this change.
    assert_ne!(story_graph(&r), before);
    refuse_semantic(
        "N linked text box reference changed",
        &doc,
        &written(&r),
        Ok(Equivalence::Different(Difference::ReferencePresence(
            "text box link",
        ))),
    );
}

/// Q — **authoritative-model corruption boundary**, not an output mutation and not a user edit:
/// the test-only `diagnostic_document_mut` relabels the authoritative header story as a footer
/// part, then the real export is used. The comparator can't prove that structure (`Err`), and an
/// error is a refusal, never equivalence. No output-only `Err` fixture exists: the reader never
/// produces dangling or mis-kinded references (K, M, P above reopen to plain differences).
#[test]
fn authoritative_model_corruption_is_refused() {
    let (doc, _) = edited(&rich_original());
    let model = model_of(&doc);
    let output = {
        let mut m = model.lock().unwrap();
        let d = m.diagnostic_document_mut();
        let h = d.last_section.headers.default.unwrap();
        d.parts.get_mut(&h).unwrap().kind = PartKind::Footer;
        m.export().unwrap()
    };
    let h = model
        .lock()
        .unwrap()
        .diagnostic_document()
        .last_section
        .headers
        .default
        .unwrap();
    refuse_semantic(
        "Q authoritative model corruption (mislabelled part kind)",
        &doc,
        &output,
        Err(RoundTripError::UnexpectedPartKind {
            side: Side::Authoritative,
            id: h,
            expected: PartKind::Header,
            found: PartKind::Footer,
        }),
    );
    // Resource refusal is the same `Err` path (LimitExceeded) and is never equivalence.
    let m = model.lock().unwrap();
    let tight = RoundTripLimits {
        max_steps: 2,
        ..Default::default()
    };
    assert_eq!(
        compare_roundtrip(m.diagnostic_document(), &reopen(&output), &tight),
        Err(RoundTripError::LimitExceeded)
    );
}

/// Measurement only (`--ignored --nocapture`): structural `==` vs semantic comparison, with the
/// DOCX reopen cost for scale. Debug build; numbers are indicative, not limits.
#[test]
#[ignore]
fn measure_semantic_vs_structural_comparison() {
    use std::time::Instant;
    let large = || {
        let mut s = basic_session();
        let text: Vec<String> = (0..2000)
            .map(|i| format!("Paragraph {i} with some ordinary words in it"))
            .collect();
        s.run("document.setText", &json!({"text": text.join("\n")}))
            .unwrap();
        s.run("insert.header", &json!({"text": "preserved header"}))
            .unwrap();
        s.run("insert.footer", &json!({"text": "preserved footer"}))
            .unwrap();
        s.run("insert.closeHeader", &json!({})).unwrap();
        s
    };
    let cases: Vec<(&str, Session, usize)> = vec![
        ("basic", basic_session(), 1),
        (
            "header+footer",
            rich_fixture(true, true, false, false, false),
            1,
        ),
        (
            "header+footer+images",
            rich_fixture(true, true, true, true, true),
            1,
        ),
        (
            "rich, two comments",
            rich_fixture(true, true, true, true, false),
            2,
        ),
        ("2000 paragraphs, 40 comments", large(), 40),
    ];
    for (name, mut s, comments) in cases {
        for i in 0..comments {
            let pos = |off| {
                Pos::new(
                    StoryRef::Body,
                    wordcraft_engine::doc::Path(vec![i as u32]),
                    off,
                )
            };
            s.run("select.range", &json!({"anchor": pos(0), "focus": pos(3)}))
                .unwrap();
            s.run("review.newComment", &json!({"text": format!("c{i}")}))
                .unwrap();
        }
        let bytes = io::save_bytes("m.docx", &s.doc).unwrap();
        let t = Instant::now();
        let reopened = reopen(&bytes);
        let parse = t.elapsed();
        let (mut structural, mut semantic) = (std::time::Duration::ZERO, std::time::Duration::ZERO);
        let mut equal = (false, false);
        for _ in 0..20 {
            let t = Instant::now();
            equal.0 = s.doc == reopened;
            structural += t.elapsed();
            let t = Instant::now();
            equal.1 =
                wordcraft_engine::doc::roundtrip::roundtrip_equivalent(&s.doc, &reopened).unwrap();
            semantic += t.elapsed();
        }
        assert!(equal.1);
        eprintln!(
            "MEASURE {name}: bytes={} blocks={} parts={} comments={} reopen_ms={:.2} structural_eq={} structural_ms={:.3} semantic_ms={:.3}",
            bytes.len(),
            s.doc.body.len(),
            s.doc.parts.len(),
            s.doc.comments.len(),
            parse.as_secs_f64() * 1e3,
            equal.0,
            structural.as_secs_f64() * 1e3 / 20.0,
            semantic.as_secs_f64() * 1e3 / 20.0
        );
    }
}

// ---- T013 각주·미주: 실제 저장 절차 두 회차와 저장 규칙의 적대적 변이 ----

fn note_op(endnote: bool, text: &str) -> DocxOp {
    if endnote {
        DocxOp::Endnote { text: text.into() }
    } else {
        DocxOp::Footnote { text: text.into() }
    }
}

/// 타입 연산으로 각주·미주를 넣는다(문서 처음 또는 끝의 커서). 모든 연산이 받아들여져야 한다.
fn insert_note(doc: &mut Docx, endnote: bool, at_end: bool, text: &str) {
    let to = if at_end {
        MoveTarget::DocEnd
    } else {
        MoveTarget::DocStart
    };
    let edited = block_on(docx::edit(
        &doc.state,
        doc.info.session_id,
        doc.info.load_generation,
        doc.info.revision,
        vec![DocxOp::Move { to, extend: false }, note_op(endnote, text)],
    ))
    .unwrap();
    assert!(edited.rejected.is_empty(), "{:?}", edited.rejected);
    doc.info = edited.session;
    assert!(doc.info.dirty);
}

fn notes(d: &Document, kind: PartKind) -> Vec<String> {
    // 본문 참조 순서(문서 순서)대로 각주 글.
    let mut out = Vec::new();
    for b in &d.body {
        if let Block::Para(p) = &**b {
            for o in &p.objects {
                if let InlineObject::NoteRef { id, .. } = o {
                    if d.parts.get(id).is_some_and(|part| part.kind == kind) {
                        out.push(d.plain_text(StoryRef::Part(*id)).trim().to_owned());
                    }
                }
            }
        }
    }
    out
}

/// 실제 저장(production `same_as`, 강제 없음) 뒤 디스크의 게시 파일.
fn publish_notes(doc: &mut Docx) -> Vec<u8> {
    let before = doc.bytes();
    let output = model_of(doc).lock().unwrap().export().unwrap();
    assert!(model_of(doc).lock().unwrap().same_as(&output));
    let verdict = service::check_saved(Format::Docx, &before, &output, None, true);
    assert!(verdict.is_safe(), "{verdict:?}");
    let saved = doc.save().expect("publication");
    assert!(!saved.session.dirty);
    doc.info = saved.session;
    assert_eq!(Sha256::digest(doc.bytes()), Sha256::digest(&output));
    assert!(doc.leftovers().is_empty());
    ticket_released(doc);
    doc.bytes()
}

#[test]
fn notes_first_and_second_published_saves() {
    for (endnote, kind) in [(false, PartKind::Footnote), (true, PartKind::Endnote)] {
        for (fixture, original) in [
            ("basic", basic::basic_ko().unwrap()),
            ("rich B10", rich_original()),
        ] {
            let name = format!("{fixture} {kind:?}");
            let mut doc = open_docx(&original);
            assert!(doc.preflight().unwrap().preservation.is_safe(), "{name}");
            insert_note(&mut doc, endnote, true, "끝 각주");
            let first = publish_notes(&mut doc);
            assert!(package::open(&first, package::Side::Original)
                .unwrap()
                .parts
                .contains_key(if endnote {
                    "word/endnotes.xml"
                } else {
                    "word/footnotes.xml"
                }));
            let mut doc = reload(doc);
            assert_eq!(notes(&reopen(&doc.bytes()), kind), ["끝 각주"], "{name}");
            // 둘째 회차: 기존 각주 **앞**에 새 각주(번호가 다시 매겨짐) + 메모.
            insert_note(&mut doc, endnote, false, "앞 각주");
            comment(&mut doc, true, "각주 뒤 메모");
            let second = publish_notes(&mut doc);
            let doc = reload(doc);
            let fin = reopen(&second);
            assert_eq!(notes(&fin, kind), ["앞 각주", "끝 각주"], "{name}");
            assert_eq!(fin.comments.len(), 1, "{name}");
            // 원본의 머리글·바닥글·미디어는 그대로.
            assert_eq!(rich_parts(&second), rich_parts(&original), "{name}");
            ticket_released(&doc);
            eprintln!("NOTES {name}: two published saves, reloaded from disk");
        }
    }
}

/// Injected output at the existing service boundary, with real model equivalence.
/// This deliberately bypasses export, not verification or atomic publication.
fn refuse_note_output(doc: &Docx, corrupt: &[u8], expected: Finding) {
    let original = doc.bytes();
    let registry = doc.state.registry();
    let before = registry.get(doc.info.session_id).unwrap();
    let same = model_of(doc).lock().unwrap().same_as(corrupt);
    let recovery_dir = TempDir::new();
    let recovery =
        crate::services::recovery::RecoveryStore::new(recovery_dir.path().join("records"));
    let valid_output = model_of(doc).lock().unwrap().export().unwrap();
    let candidate;
    let result = {
        let ticket = registry
            .begin_save(before.session_id, before.load_generation, before.revision)
            .unwrap();
        candidate = recovery
            .snapshot(&ticket, &original, &doc.path, &valid_output)
            .unwrap();
        service::save_with_options(
            registry,
            &ticket,
            &Limits::default(),
            corrupt,
            None,
            same,
            service::SaveOptions {
                destination: None,
                recovery: Some(&recovery),
            },
        )
    };
    let Err(DocumentError::UnsafeSave { preservation }) = result else {
        panic!("expected unsafe save: {result:?}")
    };
    let expected_service = if same {
        expected
    } else {
        Finding::new(FindingCode::ReopenMismatch)
    };
    assert!(
        preservation.findings.contains(&expected_service),
        "{preservation:?}"
    );
    eprintln!(
        "NOTE REFUSAL same_as={same} sha256={:x} findings={:?}",
        Sha256::digest(&original),
        preservation.findings
    );
    assert_eq!(doc.bytes(), original);
    assert_eq!(Sha256::digest(doc.bytes()), Sha256::digest(&original));
    assert_eq!(registry.get(before.session_id).unwrap(), before);
    assert!(before.dirty);
    assert!(doc.leftovers().is_empty());
    let candidates = recovery.list().unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].id, candidate.id);
    assert!(candidates[0].valid);
    assert_eq!(candidates[0].revision, Some(before.revision));
    recovery.forget_session(before.session_id).unwrap();
    assert!(
        recovery.list().unwrap().is_empty(),
        "recovery ownership must survive refusal"
    );
    ticket_released(doc);
}

/// 첫 각주 출력의 package 변이는 모두 거부된다(합성 출력 주입 — 저장 규칙 증거, 엔진 성공 증거 아님).
#[test]
fn note_preservation_rule_rejects_unrelated_changes() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    assert!(doc.preflight().unwrap().preservation.is_safe());
    insert_note(&mut doc, false, false, "각주");
    let output = model_of(&doc).lock().unwrap().export().unwrap();
    let ok = |out: &[u8]| service::check_saved(Format::Docx, &original, out, None, true);
    assert!(ok(&output).is_safe());
    let settings = |f: &dyn Fn(&str) -> String| byte_patch(&output, "word/settings.xml", f);
    let types = |f: &dyn Fn(&str) -> String| byte_patch(&output, "[Content_Types].xml", f);
    let rels = |f: &dyn Fn(&str) -> String| byte_patch(&output, "word/_rels/document.xml.rels", f);
    let cases: Vec<(&str, Vec<u8>, FindingCode, &str)> = vec![
        (
            "settings: other id",
            settings(&|x| x.replacen(r#"<w:footnote w:id="0"/>"#, r#"<w:footnote w:id="1"/>"#, 1)),
            FindingCode::PartChanged,
            "word/settings.xml",
        ),
        (
            "settings: unrelated change too",
            settings(&|x| x.replacen(r#"w:val="720""#, r#"w:val="360""#, 1)),
            FindingCode::PartChanged,
            "word/settings.xml",
        ),
        (
            "settings: references missing",
            settings(&|x| x.replacen(r#"<w:footnote w:id="-1"/><w:footnote w:id="0"/>"#, "", 1)),
            // settings then equals the original, so the note rule fails as a whole and the
            // new part itself is the finding.
            FindingCode::PartAdded,
            "word/footnotes.xml",
        ),
        (
            "content type: wrong type",
            types(&|x| x.replacen("footnotes+xml", "endnotes+xml", 1)),
            FindingCode::PartChanged,
            "[Content_Types].xml",
        ),
        (
            "relationship: external target",
            rels(&|x| {
                x.replacen(
                    r#"Target="footnotes.xml"/>"#,
                    r#"Target="footnotes.xml" TargetMode="External"/>"#,
                    1,
                )
            }),
            FindingCode::PartChanged,
            "word/_rels/document.xml.rels",
        ),
        (
            "relationship: other target",
            rels(&|x| x.replacen(r#"Target="footnotes.xml""#, r#"Target="other.xml""#, 1)),
            FindingCode::PartChanged,
            "word/_rels/document.xml.rels",
        ),
    ];
    for (name, corrupt, code, part) in cases {
        assert_ne!(corrupt, output, "{name}: mutation applied");
        refuse_note_output(&doc, &corrupt, Finding::at(code, part));
        let verdict = ok(&corrupt);
        assert!(
            verdict.findings.contains(&Finding::at(code, part)),
            "{name}: {verdict:?}"
        );
    }
    // 덧붙인 부분이 각주 말고도 있으면 거부.
    let package = package::open(&output, package::Side::Original).unwrap();
    let mut entries: Vec<_> = package
        .order
        .iter()
        .map(|n| entry(n, &package.parts[n].1))
        .collect();
    entries.push(entry("word/extra.xml", b"<x/>"));
    let extra = zip(&entries, false);
    refuse_note_output(
        &doc,
        &extra,
        Finding::at(FindingCode::PartAdded, "word/extra.xml"),
    );
    let verdict = ok(&extra);
    assert!(
        verdict
            .findings
            .contains(&Finding::at(FindingCode::PartAdded, "word/extra.xml")),
        "{verdict:?}"
    );
    assert!(
        verdict
            .findings
            .contains(&Finding::at(FindingCode::PartAdded, "word/footnotes.xml")),
        "{verdict:?}"
    );

    // 둘째 회차(기존 각주 부분): 원본 각주 글·구분선 변경과 각주 삭제는 거부.
    publish_notes(&mut doc);
    let mut doc = reload(doc);
    insert_note(&mut doc, false, true, "둘째");
    let second = model_of(&doc).lock().unwrap().export().unwrap();
    let ok2 = |out: &[u8]| service::check_saved(Format::Docx, &output, out, None, true);
    assert!(ok2(&second).is_safe());
    let notes_xml = |f: &dyn Fn(&str) -> String| byte_patch(&second, "word/footnotes.xml", f);
    for (name, corrupt) in [
        (
            "existing note text",
            notes_xml(&|x| x.replacen(" 각주<", " 각주!<", 1)),
        ),
        (
            "separator changed",
            notes_xml(&|x| x.replacen(r#"w:after="0""#, r#"w:after="120""#, 1)),
        ),
        (
            "existing note removed",
            notes_xml(&|x| {
                let at = x.find(r#"<w:footnote w:id="1">"#).unwrap();
                let end = at + x[at..].find("</w:footnote>").unwrap() + "</w:footnote>".len();
                format!("{}{}", &x[..at], &x[end..])
            }),
        ),
    ] {
        assert_ne!(corrupt, second, "{name}: mutation applied");
        refuse_note_output(
            &doc,
            &corrupt,
            Finding::at(FindingCode::PartChanged, "word/footnotes.xml"),
        );
        let verdict = ok2(&corrupt);
        assert!(
            verdict
                .findings
                .contains(&Finding::at(FindingCode::PartChanged, "word/footnotes.xml")),
            "{name}: {verdict:?}"
        );
    }
    publish_notes(&mut doc);
}

/// Independent adversarial audit of the pinned reader, for both note families and marks.
#[test]
fn pinned_reader_separator_mutations_remain_explicit() {
    let mut doc = open_docx(&basic::basic_ko().unwrap());
    insert_note(&mut doc, false, false, "foot");
    insert_note(&mut doc, true, true, "end");
    let bytes = model_of(&doc).lock().unwrap().export().unwrap();
    let defaults = reopen(&bytes);
    assert!(defaults.footnote_separators.is_empty());
    assert!(defaults.endnote_separators.is_empty());
    for (part, foot) in [("word/footnotes.xml", true), ("word/endnotes.xml", false)] {
        let aliased = byte_patch(&bytes, part, |xml| {
            xml.replace("xmlns:w=", "xmlns:n=").replace("w:", "n:")
        });
        let parsed = reopen(&aliased);
        assert!(if foot {
            parsed.footnote_separators.is_empty()
        } else {
            parsed.endnote_separators.is_empty()
        });
        let notice = byte_patch(&bytes, part, |xml| {
            xml.replacen("w:type=\"separator\"", "w:type=\"continuationNotice\"", 1)
        });
        let parsed = reopen(&notice);
        assert!(if foot {
            parsed.footnote_separators.continuation_notice.is_some()
        } else {
            parsed.endnote_separators.continuation_notice.is_some()
        });
        for mark in ["separator", "continuationSeparator"] {
            let bare = format!("<w:r><w:{mark}/></w:r>");
            for (name, replacement) in [
                ("spacing", "<w:pPr><w:spacing w:after=\"120\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr>".to_owned()),
                ("line", "<w:pPr><w:spacing w:after=\"0\" w:line=\"241\" w:lineRule=\"auto\"/></w:pPr>".to_owned()),
                ("format", format!("<w:r><w:rPr><w:b/></w:rPr><w:{mark}/></w:r>")),
                ("paragraph", format!("{bare}</w:p><w:p>")),
                ("run", format!("{bare}<w:r><w:t>custom</w:t></w:r>")),
                ("object", format!("<w:r><w:{}/></w:r>", if mark == "separator" { "continuationSeparator" } else { "separator" })),
                ("mark attr", format!("<w:r><w:{mark} w:val=\"custom\"/></w:r>")),
                ("order", format!("{bare}<w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr>")),
            ] {
                let changed = byte_patch(&bytes, part, |xml| {
                    let tag = if foot { "footnote" } else { "endnote" };
                    let start = xml.find(&format!("<w:{tag} w:type=\"{mark}\" ")).unwrap();
                    let end = start + xml[start..].find(&format!("</w:{tag}>")).unwrap();
                    let sep = &xml[start..end];
                    let altered = if name == "spacing" || name == "line" {
                        sep.replace("<w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr>", &replacement)
                    } else if name == "order" {
                        sep.replace("<w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr>", "").replace(&bare, &replacement)
                    } else { sep.replace(&bare, &replacement) };
                    assert_ne!(sep, altered, "{name}");
                    format!("{}{}{}", &xml[..start], altered, &xml[end..])
                });
                let parsed = reopen(&changed);
                let seps = if foot { &parsed.footnote_separators } else { &parsed.endnote_separators };
                assert!(if mark == "separator" { seps.separator.is_some() } else { seps.continuation_separator.is_some() }, "{part} {mark} {name}");
            }
        }
    }
}

#[test]
fn tracked_policy_ipc_preserves_session_and_original() {
    let mut seed = reopen(&basic::basic_ko().unwrap());
    seed.settings.track_changes = true;
    let original = written(&seed);
    let doc = open_docx(&original);
    let before = doc.state.registry().get(doc.info.session_id).unwrap();
    let result = block_on(docx::edit(
        &doc.state,
        before.session_id,
        before.load_generation,
        before.revision,
        vec![
            DocxOp::InsertText { text: "가".into() },
            DocxOp::Backspace,
            DocxOp::Undo {},
            DocxOp::Redo {},
            DocxOp::ReplaceInserted {
                expected: "가".into(),
                text: "각".into(),
            },
            DocxOp::InsertAt {
                mark: 1,
                text: "한".into(),
            },
        ],
    ))
    .unwrap();
    assert_eq!(result.rejected, [0, 1, 2, 3, 4, 5]);
    assert_eq!(result.session, before);
    assert!(result.view.tracked_read_only);
    assert_eq!(doc.bytes(), original);
    assert!(doc.leftovers().is_empty());
    ticket_released(&doc);
    let stale = block_on(docx::edit(
        &doc.state,
        before.session_id,
        before.load_generation,
        before.revision + 1,
        vec![DocxOp::Backspace],
    ));
    assert!(stale.is_err());
    assert_eq!(doc.state.registry().get(before.session_id).unwrap(), before);
}
