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

use super::docx_diagnostics::{
    assert_reopen_mismatch_only, link, paragraph, position_package, rich_fixture,
};
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
    assert!(saved.durable);
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
    assert!(saved.durable);
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

/// 이미 추적 중인 문서(Stage 3 정책 해제 뒤): 앱의 IME 연산 열이 받아들여지고 추적되며, 저장 전에는 원본 파일이 그대로다. 낡은
/// revision의 요청은 여전히 거부된다.
#[test]
fn tracked_document_ipc_edits_are_tracked_and_saved() {
    let mut seed = reopen(&basic::basic_ko().unwrap());
    seed.settings.track_changes = true;
    let original = written(&seed);
    let mut doc = open_docx(&original);
    assert!(doc.preflight().unwrap().preservation.is_safe());
    let before = doc.state.registry().get(doc.info.session_id).unwrap();
    let result = block_on(docx::edit(
        &doc.state,
        before.session_id,
        before.load_generation,
        before.revision,
        vec![
            DocxOp::Mark { id: 1 },
            DocxOp::InsertText { text: "가".into() },
            DocxOp::ReplaceInserted {
                expected: "가".into(),
                text: "각".into(),
            },
            DocxOp::InsertAt {
                mark: 1,
                text: "한".into(),
            },
            DocxOp::Backspace,
            DocxOp::Undo {},
            DocxOp::Redo {},
        ],
    ))
    .unwrap();
    assert!(result.rejected.is_empty(), "{:?}", result.rejected);
    assert!(result.view.has_revisions && !result.view.tracked_read_only);
    assert!(result.session.revision > before.revision && result.session.dirty);
    doc.info = result.session.clone();
    assert_eq!(doc.bytes(), original, "nothing written before save");
    let stale = block_on(docx::edit(
        &doc.state,
        before.session_id,
        before.load_generation,
        before.revision,
        vec![DocxOp::Backspace],
    ));
    assert!(stale.is_err());
    assert_eq!(
        doc.state.registry().get(before.session_id).unwrap(),
        result.session
    );
    let saved = publish_notes(&mut doc);
    assert!(reopen(&saved).settings.track_changes);
    ticket_released(&doc);
}

/// Stage 1B: wrapper metadata (`w:type`, `w:id`, other attributes), duplicate/missing separator
/// ids, ordering and settings references of an **existing** notes part, through the actual
/// WordCraft reader/writer (pinned `b39a8fb`) and the actual save path.
///
/// Observed contract: the default-separator normalizer only looks at the separator's own
/// paragraph subtree, but wrapper metadata cannot be lost silently because (1) the writer never
/// emits wrapper attributes other than `w:type`/`w:id` and always numbers separators -1/0(/1),
/// and (2) the save check compares existing separators (wrapper included) exactly and settings
/// canonically. Every such original is refused by preflight and by save, original unchanged.
/// Namespace-prefix aliasing is not a change (canonical XML), so it stays safe.
#[test]
fn separator_wrapper_and_settings_variants_are_classified() {
    for endnote in [false, true] {
        let tag = if endnote { "w:endnote" } else { "w:footnote" };
        let part = if endnote {
            "word/endnotes.xml"
        } else {
            "word/footnotes.xml"
        };
        let mut doc = open_docx(&basic::basic_ko().unwrap());
        assert!(doc.preflight().unwrap().preservation.is_safe());
        insert_note(&mut doc, endnote, true, "기존 각주");
        let base = publish_notes(&mut doc);
        let refs = format!(r#"<{tag} w:id="-1"/><{tag} w:id="0"/>"#);
        let sep = format!(r#"<{tag} w:type="separator" w:id="-1">"#);
        let cont = format!(r#"<{tag} w:type="continuationSeparator" w:id="0">"#);
        let close = format!("</{tag}>");
        let default_body = r#"<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p>"#;
        let custom_body = r#"<w:p><w:r><w:t>custom</w:t></w:r></w:p>"#;
        {
            let package = package::open(&base, package::Side::Original).unwrap();
            let settings = std::str::from_utf8(&package.parts["word/settings.xml"].1).unwrap();
            assert!(settings.contains(&refs), "writer settings references");
            let notes = std::str::from_utf8(&package.parts[part].1).unwrap();
            assert!(
                notes.contains(&format!("{sep}{default_body}{close}")) && notes.contains(&cont)
            );
        }
        let notes_patch = |f: &dyn Fn(&str) -> String| byte_patch(&base, part, f);
        let both = |notes: &dyn Fn(&str) -> String, set: &dyn Fn(&str) -> String| {
            byte_patch(&notes_patch(notes), "word/settings.xml", set)
        };
        let custom_sep = format!(r#"<{tag} w:type="separator" w:id="7">{custom_body}{close}"#);
        let unknown = format!(r#"<{tag} w:type="foo" w:id="9">{custom_body}{close}"#);
        let swap = |x: &str| {
            let a = x.find(&sep).unwrap();
            let b = x.find(&cont).unwrap();
            let c = b + x[b..].find(&close).unwrap() + close.len();
            format!("{}{}{}{}", &x[..a], &x[b..c], &x[a..b], &x[c..])
        };
        // (name, original, model has an own separator, safe)
        let variants: Vec<(&str, Vec<u8>, bool, bool)> = vec![
            ("control", base.clone(), false, true),
            (
                "namespace alias",
                notes_patch(&|x| x.replace("xmlns:w=", "xmlns:n=").replace("w:", "n:")),
                false,
                true,
            ),
            (
                "wrapper foreign attr",
                notes_patch(&|x| {
                    x.replacen(&sep, &format!(r#"<{tag} xmlns:x="urn:geul-test" x:keep="1" w:type="separator" w:id="-1">"#), 1)
                }),
                false,
                false,
            ),
            (
                "wrapper wml attr",
                notes_patch(&|x| {
                    x.replacen(
                        &sep,
                        &format!(r#"<{tag} w:type="separator" w:id="-1" w:extra="1">"#),
                        1,
                    )
                }),
                false,
                false,
            ),
            (
                "separator renumbered with settings",
                both(
                    &|x| x.replacen(&sep, &format!(r#"<{tag} w:type="separator" w:id="5">"#), 1),
                    &|x| {
                        x.replacen(
                            &format!(r#"<{tag} w:id="-1"/>"#),
                            &format!(r#"<{tag} w:id="5"/>"#),
                            1,
                        )
                    },
                ),
                false,
                false,
            ),
            (
                "separator id missing",
                notes_patch(&|x| x.replacen(&sep, &format!(r#"<{tag} w:type="separator">"#), 1)),
                false,
                false,
            ),
            // The reader keeps the first separator of a kind and does not follow settings
            // references (limitation): the referenced custom one is not in the model, but the
            // save path refuses, so nothing is dropped from the file.
            (
                "duplicate separator, custom referenced second",
                both(
                    &|x| x.replacen(&cont, &format!("{custom_sep}{cont}"), 1),
                    &|x| {
                        x.replacen(
                            &format!(r#"<{tag} w:id="-1"/>"#),
                            &format!(r#"<{tag} w:id="7"/>"#),
                            1,
                        )
                    },
                ),
                false,
                false,
            ),
            (
                "custom separator first",
                notes_patch(&|x| x.replacen(&sep, &format!("{custom_sep}{sep}"), 1)),
                true,
                false,
            ),
            (
                "custom separator only",
                notes_patch(&|x| x.replacen(default_body, custom_body, 1)),
                true,
                false,
            ),
            (
                "unknown wrapper type",
                notes_patch(&|x| x.replacen(&cont, &format!("{unknown}{cont}"), 1)),
                false,
                false,
            ),
            ("separator order swapped", notes_patch(&swap), false, false),
            (
                "settings references missing",
                byte_patch(&base, "word/settings.xml", |x| x.replacen(&refs, "", 1)),
                false,
                false,
            ),
        ];
        for (name, original, own, safe) in variants {
            let name = format!("{tag} {name}");
            assert!(
                name.ends_with("control") || original != base,
                "{name}: mutation applied"
            );
            let model = reopen(&original);
            let seps = if endnote {
                &model.endnote_separators
            } else {
                &model.footnote_separators
            };
            assert_eq!(seps.separator.is_some(), own, "{name}");
            assert!(
                seps.continuation_separator.is_none() && seps.continuation_notice.is_none(),
                "{name}"
            );
            let mut edited = open_docx(&original);
            assert_eq!(
                edited.preflight().unwrap().preservation.is_safe(),
                safe,
                "{name}: preflight"
            );
            insert_note(&mut edited, endnote, false, "새 각주");
            let output = model_of(&edited).lock().unwrap().export().unwrap();
            let same = model_of(&edited).lock().unwrap().same_as(&output);
            assert!(same, "{name}: engine model round trip");
            let verdict = service::check_saved(Format::Docx, &original, &output, None, same);
            assert_eq!(verdict.is_safe(), safe, "{name}: {verdict:?}");
            if safe {
                publish_notes(&mut edited);
            } else {
                assert!(
                    verdict
                        .findings
                        .iter()
                        .all(|f| f.code == FindingCode::PartChanged),
                    "{name}: {verdict:?}"
                );
                let error = edited.save().expect_err(&name);
                assert!(
                    matches!(error, DocumentError::UnsafeSave { .. }),
                    "{name}: {error:?}"
                );
                assert_eq!(
                    Sha256::digest(edited.bytes()),
                    Sha256::digest(&original),
                    "{name}"
                );
                assert!(
                    edited
                        .state
                        .registry()
                        .get(edited.info.session_id)
                        .unwrap()
                        .dirty,
                    "{name}"
                );
                assert!(edited.leftovers().is_empty(), "{name}");
                ticket_released(&edited);
            }
        }
    }
}

/// T013 목차: 실제 저장 절차(production `same_as`, 강제 없음) 두 회차. 타입 연산 `toc`로 넣고 게시 → 디스크의 게시 파일로 다시
/// 열어 본문 편집 + `updateToc` → 둘째 게시 → 다시 열기. 제목 없는 문서(빈 목차)와 제목이 있는 문서.
#[test]
fn toc_first_and_second_published_saves() {
    use wordcraft_engine::doc::{Path, Pos};
    let headed = {
        let mut s = basic_session();
        for (i, style) in [(0u32, "Heading 1"), (1, "Heading 2")] {
            s.run(
                "caret.set",
                &serde_json::json!({"pos": Pos::new(StoryRef::Body, Path(vec![i]), 0)}),
            )
            .unwrap();
            s.run("styles.apply", &serde_json::json!({"style": style}))
                .unwrap();
        }
        io::save_bytes("h.docx", &s.doc).unwrap()
    };
    let entries = |d: &Document| -> Vec<String> {
        d.body
            .iter()
            .filter_map(|b| b.as_para())
            .filter(|p| {
                p.props
                    .style
                    .as_deref()
                    .is_some_and(|s| s.starts_with("TOC"))
            })
            .map(|p| p.plain_text())
            .collect()
    };
    let edit = |doc: &mut Docx, ops: Vec<DocxOp>| {
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
        edited.view
    };
    for (name, original) in [("basic", basic::basic_ko().unwrap()), ("headed", headed)] {
        let mut doc = open_docx(&original);
        assert!(doc.preflight().unwrap().preservation.is_safe(), "{name}");
        let view = edit(
            &mut doc,
            vec![
                DocxOp::Move {
                    to: MoveTarget::DocStart,
                    extend: false,
                },
                DocxOp::Toc {},
            ],
        );
        assert!(view.has_toc && doc.info.dirty, "{name}");
        let first = publish_notes(&mut doc);
        let mut doc = reload(doc);
        let reopened = reopen(&first);
        let before = entries(&reopened);
        assert_eq!(before[0], "Contents", "{name}");
        if name == "headed" {
            assert_eq!(before.len(), 3, "{name}: {before:?}");
            assert!(before[1].starts_with(basic::PARAGRAPHS[0]), "{name}");
        } else {
            assert_eq!(before.len(), 1, "{name}: empty TOC keeps only the heading");
        }
        // 둘째 회차: 다시 연 게시 파일에서 끝에 글자 + 목차 갱신.
        let view = edit(
            &mut doc,
            vec![
                DocxOp::Move {
                    to: MoveTarget::DocEnd,
                    extend: false,
                },
                DocxOp::InsertText {
                    text: " 끝".into()
                },
                DocxOp::UpdateToc {},
            ],
        );
        assert!(view.has_toc);
        let second = publish_notes(&mut doc);
        let doc = reload(doc);
        assert_eq!(entries(&reopen(&second)), before, "{name}");
        ticket_released(&doc);
        eprintln!("TOC {name}: two published saves, reloaded from disk");
    }
}

/// T013 Stage 3: 변경 내용 추적 켜기 → 추적 편집 → 실제 게시 → 디스크의 게시 파일을 다시 열어 수락·거절 + 끄기 → 둘째 게시. settings의
/// `w:trackRevisions` 규칙은 그 요소 하나의 있고 없음만 받는다(합성 출력 주입 음성 대조).
#[test]
fn tracking_toggle_tracked_edits_and_review_publish_twice() {
    let edit = |doc: &mut Docx, ops: Vec<DocxOp>| {
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
        edited.view
    };
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    assert!(doc.preflight().unwrap().preservation.is_safe());
    let view = edit(
        &mut doc,
        vec![
            DocxOp::TrackChanges { value: true },
            DocxOp::Move {
                to: MoveTarget::DocStart,
                extend: false,
            },
            DocxOp::InsertText { text: "가".into() },
            DocxOp::ReplaceInserted {
                expected: "가".into(),
                text: "각".into(),
            },
            DocxOp::Move {
                to: MoveTarget::DocEnd,
                extend: false,
            },
            DocxOp::Backspace,
        ],
    );
    assert!(view.tracking && view.has_revisions && !view.tracked_read_only);
    // 음성 대조: 첫 출력의 settings 변이.
    let output = model_of(&doc).lock().unwrap().export().unwrap();
    let ok = |out: &[u8]| service::check_saved(Format::Docx, &original, out, None, true);
    assert!(ok(&output).is_safe());
    let settings = |f: &dyn Fn(&str) -> String| byte_patch(&output, "word/settings.xml", f);
    for (name, corrupt) in [
        (
            "val attribute",
            settings(&|x| {
                x.replacen(
                    "<w:trackRevisions/>",
                    r#"<w:trackRevisions w:val="true"/>"#,
                    1,
                )
            }),
        ),
        (
            "twice",
            settings(&|x| {
                x.replacen(
                    "<w:trackRevisions/>",
                    "<w:trackRevisions/><w:trackRevisions/>",
                    1,
                )
            }),
        ),
        (
            "other setting too",
            settings(&|x| {
                x.replacen(
                    "<w:trackRevisions/>",
                    "<w:trackRevisions/><w:doNotTrackMoves/>",
                    1,
                )
            }),
        ),
        (
            "unrelated change too",
            settings(&|x| x.replacen(r#"w:val="720""#, r#"w:val="360""#, 1)),
        ),
        (
            "other namespace",
            settings(&|x| {
                x.replacen(
                    "<w:trackRevisions/>",
                    r#"<x:trackRevisions xmlns:x="urn:x"/>"#,
                    1,
                )
            }),
        ),
    ] {
        assert_ne!(corrupt, output, "{name}: mutation applied");
        let verdict = ok(&corrupt);
        assert!(
            verdict
                .findings
                .contains(&Finding::at(FindingCode::PartChanged, "word/settings.xml")),
            "{name}: {verdict:?}"
        );
        refuse_note_output(
            &doc,
            &corrupt,
            Finding::at(FindingCode::PartChanged, "word/settings.xml"),
        );
    }
    let first = publish_notes(&mut doc);
    let mut doc = reload(doc);
    let reopened = reopen(&first);
    assert!(reopened.settings.track_changes);
    // 둘째 회차: 커서 자리 수락, 나머지 거절, 추적 끄기, 추적 없는 편집.
    let view = edit(
        &mut doc,
        vec![
            DocxOp::Move {
                to: MoveTarget::DocStart,
                extend: false,
            },
            DocxOp::AcceptChange {},
            DocxOp::RejectAll {},
            DocxOp::TrackChanges { value: false },
            DocxOp::Move {
                to: MoveTarget::DocEnd,
                extend: false,
            },
            DocxOp::InsertText { text: "!".into() },
        ],
    );
    assert!(!view.tracking && !view.has_revisions);
    let second = publish_notes(&mut doc);
    let doc = reload(doc);
    let fin = reopen(&second);
    assert!(!fin.settings.track_changes && fin.revisions.is_empty());
    assert!(fin.plain_text(StoryRef::Body).starts_with("각"));
    assert!(
        fin.plain_text(StoryRef::Body).ends_with("End.!"),
        "rejected deletion restored the last character"
    );
    ticket_released(&doc);
}

// ---- T013 Stage 4: comments on part of a hyperlink ----

/// "Before " + hyperlink "Link text" (external relationship linkA) + " after.", re-saved by WordCraft.
fn hyperlink_original() -> Vec<u8> {
    let body = paragraph(&format!(
        r#"<w:r><w:t xml:space="preserve">Before </w:t></w:r>{}<w:r><w:t xml:space="preserve"> after.</w:t></w:r>"#,
        link("Link text", r#"r:id="linkA""#)
    ));
    io::save_bytes(
        "fixture.docx",
        &io::open_bytes(
            "fixture.docx",
            &zip(&position_package(&body, false, false), false),
        )
        .unwrap(),
    )
    .unwrap()
}

/// A comment on characters [from, from + len) of the first paragraph, through typed operations.
fn comment_chars(doc: &mut Docx, from: usize, len: usize, text: &str) {
    let mut ops = vec![DocxOp::Move {
        to: MoveTarget::DocStart,
        extend: false,
    }];
    ops.extend((0..from).map(|_| DocxOp::Move {
        to: MoveTarget::Right,
        extend: false,
    }));
    ops.extend((0..len).map(|_| DocxOp::Move {
        to: MoveTarget::Right,
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
}

/// The hyperlink's target and every run carrying it, read back from a file.
fn link_runs(bytes: &[u8]) -> (String, Vec<String>) {
    let d = reopen(bytes);
    let p = d.body[0].as_para().unwrap();
    let mut runs = Vec::new();
    let mut target = String::new();
    for (range, props) in p.run_ranges() {
        if let Some(l) = &props.link {
            target = l.clone();
            runs.push(p.text[range].replace('\u{FFFC}', ""));
        }
    }
    (target, runs.into_iter().filter(|t| !t.is_empty()).collect())
}

#[test]
fn hyperlink_comments_on_any_part_publish_twice() {
    const START: usize = "Before ".len();
    const LINK: usize = "Link text".len();
    let original = hyperlink_original();
    let (target, runs) = link_runs(&original);
    assert_eq!(
        (target.as_str(), runs.concat().as_str()),
        ("https://example.org/A", "Link text")
    );
    for (name, from, len) in [
        ("full", START, LINK),
        ("middle", START + 2, 3),
        ("start", START, 4),
        ("end", START + 5, LINK - 5),
        ("into plain text", START + 5, LINK - 5 + 3),
        ("from plain text", START - 3, 5),
    ] {
        let mut doc = open_docx(&original);
        assert!(doc.preflight().unwrap().preservation.is_safe(), "{name}");
        comment_chars(&mut doc, from, len, name);
        let first = publish_notes(&mut doc);
        let (t, r) = link_runs(&first);
        assert_eq!(
            (t.as_str(), r.concat().as_str()),
            ("https://example.org/A", "Link text"),
            "{name}: link text and target"
        );
        let d = reopen(&first);
        assert_eq!(d.comments.len(), 1, "{name}");
        // Comment boundaries: the commented text is exactly the selection.
        let p = d.body[0].as_para().unwrap();
        let (mut a, mut b) = (None, None);
        for (off, o) in p.object_offsets().into_iter().zip(&p.objects) {
            match o {
                InlineObject::CommentStart { .. } => a = Some(off),
                InlineObject::CommentEnd { .. } => b = Some(off),
                _ => {}
            }
        }
        let quoted: String = p.text[a.unwrap()..b.unwrap()]
            .chars()
            .filter(|c| *c != '\u{FFFC}')
            .collect();
        let plain: String = "Before Link text after."
            .chars()
            .skip(from)
            .take(len)
            .collect();
        assert_eq!(quoted, plain, "{name}: comment boundaries");
        // Second round on the published file: a second comment elsewhere in the link.
        let mut doc = reload(doc);
        assert!(doc.preflight().unwrap().preservation.is_safe(), "{name}");
        comment_chars(&mut doc, START + 1, 1, "second");
        let second = publish_notes(&mut doc);
        assert_eq!(reopen(&second).comments.len(), 2, "{name}");
        assert_eq!(link_runs(&second).1.concat(), "Link text", "{name}");
        ticket_released(&reload(doc));
    }
    // Two comments in one save, then undo/redo of the second.
    let mut doc = open_docx(&original);
    assert!(doc.preflight().unwrap().preservation.is_safe());
    comment_chars(&mut doc, START, 2, "one");
    comment_chars(&mut doc, START + 4, 2, "two");
    let edited = block_on(docx::edit(
        &doc.state,
        doc.info.session_id,
        doc.info.load_generation,
        doc.info.revision,
        vec![DocxOp::Undo {}],
    ))
    .unwrap();
    doc.info = edited.session;
    assert_eq!(
        model_of(&doc)
            .lock()
            .unwrap()
            .diagnostic_document()
            .comments
            .len(),
        1
    );
    let edited = block_on(docx::edit(
        &doc.state,
        doc.info.session_id,
        doc.info.load_generation,
        doc.info.revision,
        vec![DocxOp::Redo {}],
    ))
    .unwrap();
    doc.info = edited.session;
    let out = publish_notes(&mut doc);
    assert_eq!(reopen(&out).comments.len(), 2);
}

/// Narrow contract: only the split itself is accepted (injected outputs, real `same_as`).
#[test]
fn hyperlink_comment_relationship_mutations_are_refused() {
    let original = hyperlink_original();
    let mut doc = open_docx(&original);
    assert!(doc.preflight().unwrap().preservation.is_safe());
    comment_chars(&mut doc, "Before ".len() + 2, 3, "middle");
    let output = model_of(&doc).lock().unwrap().export().unwrap();
    let ok = |out: &[u8]| service::check_saved(Format::Docx, &original, out, None, true);
    assert!(ok(&output).is_safe());
    let package = package::open(&output, package::Side::Original).unwrap();
    let body = String::from_utf8(package.parts["word/document.xml"].1.clone()).unwrap();
    let id = {
        let at = body.find("<w:hyperlink r:id=\"").unwrap() + "<w:hyperlink r:id=\"".len();
        body[at..at + body[at..].find('"').unwrap()].to_owned()
    };
    assert_eq!(
        body.matches(&format!("r:id=\"{id}\"")).count(),
        3,
        "split into three halves around the comment"
    );
    let doc_patch = |f: &dyn Fn(&str) -> String| byte_patch(&output, "word/document.xml", f);
    let rels_patch =
        |f: &dyn Fn(&str) -> String| byte_patch(&output, "word/_rels/document.xml.rels", f);
    let second = |x: &str, with: &str| {
        let first = x.find(&format!("r:id=\"{id}\"")).unwrap() + 1;
        let at = first + x[first..].find(&format!("r:id=\"{id}\"")).unwrap();
        format!(
            "{}{}{}",
            &x[..at],
            with,
            &x[at + format!("r:id=\"{id}\"").len()..]
        )
    };
    let strict = "http://purl.oclc.org/ooxml/officeDocument/relationships";
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("second half: unrelated new external target", {
            let d = doc_patch(&|x| second(x, r#"r:id="evil""#));
            byte_patch(&d, "word/_rels/document.xml.rels", |x| {
                x.replace("</Relationships>", r#"<Relationship Id="evil" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://attacker.example/" TargetMode="External"/></Relationships>"#)
            })
        }),
        (
            "second half: missing relationship",
            doc_patch(&|x| second(x, r#"r:id="missing""#)),
        ),
        (
            "second half: strict namespace",
            doc_patch(&|x| second(x, &format!(r#"xmlns:s="{strict}" s:id="{id}""#))),
        ),
        (
            "target changed",
            rels_patch(&|x| x.replace("https://example.org/A", "https://example.org/B")),
        ),
        (
            "type changed",
            rels_patch(&|x| x.replacen("relationships/hyperlink\"", "relationships/image\"", 1)),
        ),
        (
            "duplicated hyperlink content",
            doc_patch(&|x| {
                let at = x.find("<w:hyperlink").unwrap();
                let end = at + x[at..].find("</w:hyperlink>").unwrap() + "</w:hyperlink>".len();
                format!("{}{}{}", &x[..end], &x[at..end], &x[end..])
            }),
        ),
        (
            "hyperlink removed",
            doc_patch(&|x| {
                let at = x.rfind("<w:hyperlink").unwrap();
                let end = at + x[at..].find("</w:hyperlink>").unwrap() + "</w:hyperlink>".len();
                format!("{}{}", &x[..at], &x[end..])
            }),
        ),
    ];
    for (name, corrupt) in cases {
        assert_ne!(corrupt, output, "{name}: mutation applied");
        let verdict = ok(&corrupt);
        let same = model_of(&doc).lock().unwrap().same_as(&corrupt);
        assert!(
            !(verdict.is_safe() && same),
            "{name}: accepted: {verdict:?}"
        );
        eprintln!(
            "HYPERLINK REFUSAL {name}: same_as={same} findings={:?}",
            verdict.findings
        );
        refuse_note_output(
            &doc,
            &corrupt,
            verdict
                .findings
                .first()
                .cloned()
                .unwrap_or(Finding::new(FindingCode::ReopenMismatch)),
        );
    }
}

// ---- T013 mixed-feature acceptance, actual publication rather than a ZIP-only oracle ----
fn mixed_original() -> Vec<u8> {
    let mut d = reopen(&hyperlink_original());
    d.body.push(para_block(
        Paragraph::with_text("First heading", Default::default()).styled("Heading1"),
    ));
    d.body.push(para_block(
        Paragraph::with_text("Second heading", Default::default()).styled("Heading2"),
    ));
    d.body.push(para_block(Paragraph::with_text(
        "Untouched sentinel 한글.",
        CharProps {
            bold: Some(true),
            ..Default::default()
        },
    )));
    d.body.push(para_block(Paragraph::with_text(
        "Editable tail.",
        Default::default(),
    )));
    io::save_bytes("mixed.docx", &d).unwrap()
}

#[track_caller]
fn mixed_edit(doc: &mut Docx, ops: Vec<DocxOp>) {
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
}

fn mixed_move(to: MoveTarget, extend: bool) -> DocxOp {
    DocxOp::Move { to, extend }
}
fn mixed_insert(text: &str) -> DocxOp {
    DocxOp::InsertText { text: text.into() }
}

fn mixed_assert_parts(bytes: &[u8], sentinel: &Block) {
    let d = reopen(bytes);
    assert!(
        d.body.iter().any(|b| &**b == sentinel),
        "unrelated styled paragraph"
    );
    assert_eq!(d.comments.len(), 2);
    assert_eq!(notes(&d, PartKind::Footnote), ["mixed footnote"]);
    assert_eq!(notes(&d, PartKind::Endnote), ["mixed endnote"]);
    let mut links = Vec::new();
    let mut toc = false;
    for p in d.body.iter().filter_map(|b| b.as_para()) {
        for (_, props) in p.run_ranges() {
            if let Some(link) = &props.link {
                if !link.starts_with('#') {
                    links.push(link.as_str());
                }
            }
        }
        toc |= p.objects.iter().any(|o| matches!(o, InlineObject::Field { instr, .. } | InlineObject::FieldStart { instr, .. } if instr.starts_with("TOC ")));
    }
    assert!(!links.is_empty());
    assert!(links.iter().all(|l| *l == "https://example.org/A"));
    assert!(toc, "TOC instruction retained");
    assert!(d
        .body
        .iter()
        .filter_map(|b| b.as_para())
        .any(|p| p.props.style.as_deref() == Some("Heading1")));
    assert!(d
        .body
        .iter()
        .filter_map(|b| b.as_para())
        .any(|p| p.props.style.as_deref() == Some("Heading2")));
}

#[test]
fn mixed_toc_hyperlink_comments_notes_tracking_publish_reopen_edit_publish() {
    let original = mixed_original();
    let sentinel = reopen(&original).body[3].clone();
    for resolution in ["keep", "accept", "reject"] {
        let mut doc = open_docx(&original);
        assert!(doc.preflight().unwrap().preservation.is_safe());
        // Ordinary-text comment, then comment on the middle of a hyperlink (writer splits it).
        comment_chars(&mut doc, 0, 3, "ordinary comment");
        comment_chars(&mut doc, 10, 2, "split hyperlink comment");
        mixed_edit(
            &mut doc,
            vec![
                mixed_move(MoveTarget::DocEnd, false),
                DocxOp::Footnote {
                    text: "mixed footnote".into(),
                },
                DocxOp::Endnote {
                    text: "mixed endnote".into(),
                },
                DocxOp::Undo {},
                DocxOp::Redo {},
                mixed_move(MoveTarget::DocStart, false),
                DocxOp::Toc {},
                DocxOp::Undo {},
                DocxOp::Redo {},
                DocxOp::UpdateToc {},
                DocxOp::TrackChanges { value: true },
            ],
        );
        // Tracked edit of the split hyperlink, followed by IME-style Korean correction.
        // Resolve the current paragraph position from the real model; editing still uses typed ops.
        let (link_index, link_offset) = model_of(&doc)
            .lock()
            .unwrap()
            .diagnostic_document()
            .body
            .iter()
            .enumerate()
            .find_map(|(i, b)| {
                let p = b.as_para()?;
                p.run_ranges().find_map(|(range, props)| {
                    (props.link.as_deref() == Some("https://example.org/A"))
                        .then(|| {
                            p.text[range.clone()]
                                .char_indices()
                                .find(|(_, c)| *c != '\u{FFFC}')
                                .map(|(off, _)| (i, range.start + off + 1))
                        })
                        .flatten()
                })
            })
            .unwrap();
        let caret = model_of(&doc)
            .lock()
            .unwrap()
            .caret_of(&Pos::body(link_index, link_offset))
            .unwrap();
        mixed_edit(
            &mut doc,
            vec![
                DocxOp::Pointer {
                    page: caret.page as u32,
                    x: caret.x + 0.5,
                    y: caret.y + caret.height / 2.0,
                    extend: false,
                    before_insert: false,
                },
                DocxOp::DeleteForward,
                mixed_insert("가"),
                DocxOp::ReplaceInserted {
                    expected: "가".into(),
                    text: "한".into(),
                },
                mixed_insert("글"),
                DocxOp::Undo {},
                DocxOp::Redo {},
            ],
        );
        // A tracked heading deletion coexists with TOC, and an updated TOC reflects heading edits.
        let heading_index = model_of(&doc)
            .lock()
            .unwrap()
            .diagnostic_document()
            .body
            .iter()
            .position(|b| {
                b.as_para()
                    .is_some_and(|p| p.props.style.as_deref() == Some("Heading2"))
            })
            .unwrap();
        let caret = model_of(&doc)
            .lock()
            .unwrap()
            .caret_of(&Pos::body(
                heading_index,
                wordcraft_engine::doc::para::OBJ.len_utf8() + 2,
            ))
            .unwrap();
        mixed_edit(
            &mut doc,
            vec![
                DocxOp::Pointer {
                    page: caret.page as u32,
                    x: caret.x + 0.5,
                    y: caret.y + caret.height / 2.0,
                    extend: false,
                    before_insert: false,
                },
                DocxOp::DeleteForward,
                mixed_insert("변경 "),
                DocxOp::UpdateToc {},
            ],
        );
        assert!(
            model_of(&doc)
                .lock()
                .unwrap()
                .diagnostic_document()
                .body
                .iter()
                .filter_map(|b| b.as_para())
                .any(|p| p.props.style.as_deref() == Some("TOC2")
                    && p.plain_text().contains("변경 ")),
            "TOC update includes changed heading text"
        );
        let first = publish_notes(&mut doc);
        mixed_assert_parts(&first, &sentinel);
        assert!(!reopen(&first).revisions.is_empty());
        println!(
            "mixed {resolution} first sha256={:x}",
            Sha256::digest(&first)
        );
        // Actual disk reopen, then another edit and second durable atomic publication.
        let mut doc = reload(doc);
        if resolution != "keep" {
            let (index, offset) = model_of(&doc)
                .lock()
                .unwrap()
                .diagnostic_document()
                .body
                .iter()
                .enumerate()
                .find_map(|(i, b)| {
                    let p = b.as_para()?;
                    p.run_ranges()
                        .find_map(|(r, props)| props.ins.map(|_| (i, r.start)))
                })
                .unwrap();
            let c = model_of(&doc)
                .lock()
                .unwrap()
                .caret_of(&Pos::body(index, offset))
                .unwrap();
            mixed_edit(
                &mut doc,
                vec![
                    DocxOp::Pointer {
                        page: c.page as u32,
                        x: c.x + 0.5,
                        y: c.y + c.height / 2.0,
                        extend: false,
                        before_insert: false,
                    },
                    if resolution == "accept" {
                        DocxOp::AcceptChange {}
                    } else {
                        DocxOp::RejectChange {}
                    },
                    DocxOp::Undo {},
                    DocxOp::Redo {},
                ],
            );
        }
        match resolution {
            "accept" => mixed_edit(
                &mut doc,
                vec![DocxOp::AcceptAll {}, DocxOp::Undo {}, DocxOp::Redo {}],
            ),
            "reject" => mixed_edit(
                &mut doc,
                vec![DocxOp::RejectAll {}, DocxOp::Undo {}, DocxOp::Redo {}],
            ),
            _ => {}
        }
        if resolution != "keep" {
            assert!(!model_of(&doc).lock().unwrap().view().has_revisions);
            mixed_edit(&mut doc, vec![DocxOp::TrackChanges { value: false }]);
        }
        mixed_edit(
            &mut doc,
            vec![
                mixed_move(MoveTarget::DocStart, false),
                mixed_insert("재개 "),
                DocxOp::UpdateToc {},
            ],
        );
        let second = publish_notes(&mut doc);
        mixed_assert_parts(&second, &sentinel);
        println!(
            "mixed {resolution} second sha256={:x}",
            Sha256::digest(&second)
        );
        let mut doc = reload(doc);
        assert!(!doc.info.dirty);
        mixed_edit(
            &mut doc,
            vec![
                mixed_move(MoveTarget::DocEnd, false),
                mixed_insert("pending"),
            ],
        );
        // T009 must still reject unrelated authoritative-output corruption and preserve original.
        let authoritative_output = model_of(&doc).lock().unwrap().export().unwrap();
        assert!(model_of(&doc)
            .lock()
            .unwrap()
            .same_as(&authoritative_output));
        let corrupt = byte_patch(&authoritative_output, "word/_rels/document.xml.rels", |x| {
            x.replace("https://example.org/A", "https://example.org/evil")
        });
        assert_ne!(corrupt, authoritative_output);
        let same = model_of(&doc).lock().unwrap().same_as(&corrupt);
        assert!(!same);
        assert_save_refused("mixed relationship target", &doc, &corrupt, same);
    }
}

#[test]
fn tracked_toc_boundary_resolution_durable_two_rounds() {
    for (mode, resolution) in [
        DocxOp::AcceptChange {},
        DocxOp::RejectChange {},
        DocxOp::AcceptAll {},
        DocxOp::RejectAll {},
    ]
    .into_iter()
    .enumerate()
    {
        let original = mixed_original();
        let sentinel = reopen(&original).body[3].clone();
        let mut doc = open_docx(&original);
        assert!(doc.preflight().unwrap().preservation.is_safe());
        comment_chars(&mut doc, 0, 3, "ordinary comment");
        comment_chars(&mut doc, 10, 2, "split hyperlink comment");
        mixed_edit(
            &mut doc,
            vec![
                mixed_move(MoveTarget::DocEnd, false),
                DocxOp::Footnote {
                    text: "mixed footnote".into(),
                },
                DocxOp::Endnote {
                    text: "mixed endnote".into(),
                },
                mixed_move(MoveTarget::DocStart, false),
                DocxOp::Toc {},
                DocxOp::TrackChanges { value: true },
            ],
        );
        let index = model_of(&doc)
            .lock()
            .unwrap()
            .diagnostic_document()
            .body
            .iter()
            .position(|b| {
                b.as_para()
                    .is_some_and(|p| p.props.style.as_deref() == Some("Heading2"))
            })
            .unwrap();
        assert!(model_of(&doc)
            .lock()
            .unwrap()
            .run_engine("caret.set", json!({"pos": Pos::body(index, 0)})));
        mixed_edit(&mut doc, vec![DocxOp::DeleteForward]);
        mixed_edit(
            &mut doc,
            vec![
                resolution.clone(),
                DocxOp::Undo {},
                DocxOp::Redo {},
                DocxOp::UpdateToc {},
                DocxOp::UpdateToc {},
            ],
        );
        let first = publish_notes(&mut doc);
        mixed_assert_parts(&first, &sentinel);
        let mut doc = reload(doc);
        mixed_edit(
            &mut doc,
            vec![
                mixed_move(MoveTarget::DocEnd, false),
                mixed_insert(" follow-up"),
                DocxOp::UpdateToc {},
            ],
        );
        let second = publish_notes(&mut doc);
        mixed_assert_parts(&second, &sentinel);
        let doc = reload(doc);
        assert!(doc.preflight().unwrap().preservation.is_safe());
        assert!(reopen(&second)
            .plain_text(StoryRef::Body)
            .contains("follow-up"));
        for bytes in [&first, &second] {
            let model = reopen(bytes);
            let mut markers = std::collections::BTreeMap::<String, (usize, usize)>::new();
            for p in model.body.iter().filter_map(|b| b.as_para()) {
                for obj in &p.objects {
                    match obj {
                        InlineObject::BookmarkStart { name } => {
                            markers.entry(name.clone()).or_default().0 += 1
                        }
                        InlineObject::BookmarkEnd { name } => {
                            markers.entry(name.clone()).or_default().1 += 1
                        }
                        _ => {}
                    }
                }
            }
            assert!(!markers.is_empty());
            assert!(markers.values().all(|pair| *pair == (1, 1)));
            for p in model.body.iter().filter_map(|b| b.as_para()) {
                for target in p
                    .runs
                    .iter()
                    .filter_map(|r| r.props.link.as_deref())
                    .filter_map(|l| l.strip_prefix('#'))
                {
                    assert!(markers.contains_key(target));
                }
            }
        }
        if let Some(folder) = std::env::var_os("GEUL_TRACKED_TOC_OUT") {
            let folder = std::path::PathBuf::from(folder);
            assert!(folder.is_absolute());
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join(format!("mode-{mode}-first.docx")), &first).unwrap();
            std::fs::write(folder.join(format!("mode-{mode}-second.docx")), &second).unwrap();
        }
        println!(
            "tracked TOC {resolution:?} first={:x} second={:x}",
            Sha256::digest(&first),
            Sha256::digest(&second)
        );
    }
}
