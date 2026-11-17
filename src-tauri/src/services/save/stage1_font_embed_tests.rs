//! Stage 1 F: DOCX font embedding through the production IPC path (`docx::edit` → `DocxOp::EmbedFont`), undo/redo,
//! T009 preflight + publish, independent reopen of the written file, preservation of existing embedded fonts on a
//! second save, and the T009 proof's refusal of invalid embedding outputs.
use super::*;
use crate::adapters::wordcraft::engine::embed_font;
use crate::adapters::wordcraft::engine::DocxView;
use crate::fonts::embedding;
use std::collections::BTreeMap;

fn run(doc: &mut Docx, ops: Vec<DocxOp>) -> (DocxView, Vec<usize>) {
    let edited = block_on(docx::edit(&doc.state, doc.info.session_id, doc.info.load_generation, doc.info.revision, ops)).unwrap();
    doc.info = edited.session;
    (edited.view, edited.rejected)
}

fn embed(doc: &mut Docx, family: &str, style: &str) -> (DocxView, Vec<usize>) {
    run(doc, vec![DocxOp::EmbedFont { family: family.into(), style: style.into() }])
}

fn save(doc: &mut Docx, original: &[u8]) -> Vec<u8> {
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
    written
}

fn parts(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    package::open(bytes, package::Side::Output).unwrap().parts.into_iter().map(|(k, (_, v))| (k, v)).collect()
}

fn asset(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/../external/wordcraft/assets/fonts/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

/// The embedded program of `family`/`slot` in a written package, deobfuscated with its font key.
fn program(bytes: &[u8], family: &str, slot: &str) -> Vec<u8> {
    let model = wordcraft_engine::io::open_bytes("x.docx", bytes).unwrap();
    let e = embed_font::embedded(&model).into_iter().find(|e| e.family == family && e.slot == slot).expect("embedded");
    let p = parts(bytes);
    embedding::obfuscate(&p[e.part.as_ref().unwrap()], e.font_key.as_ref().unwrap()).unwrap()
}

#[test]
fn stage1_docx_font_embedding_undo_redo_save_reopen_and_preservation() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    assert!(embedding::info("Inter", "Regular").docx.is_none(), "{:?}", embedding::info("Inter", "Regular"));
    let (view, rejected) = embed(&mut doc, "Inter", "Regular");
    assert!(rejected.is_empty());
    assert_eq!(doc.info.revision, 1);
    assert_eq!(view.embedded_fonts.len(), 1);
    assert_eq!((view.embedded_fonts[0].family.as_str(), view.embedded_fonts[0].slot.as_str()), ("Inter", "embedRegular"));
    // Undo removes the resource from the model; redo restores it; the same font again changes nothing.
    let (view, _) = run(&mut doc, vec![DocxOp::Undo {}]);
    assert!(view.embedded_fonts.is_empty());
    let (view, _) = run(&mut doc, vec![DocxOp::Redo {}]);
    assert_eq!(view.embedded_fonts.len(), 1);
    let revision = doc.info.revision;
    let (view, rejected) = embed(&mut doc, "Inter", "Regular");
    assert!(rejected.is_empty());
    assert_eq!(doc.info.revision, revision);
    assert_eq!(view.embedded_fonts.len(), 1);
    // A style without a DOCX slot and an unavailable face are refused without changing the document.
    for (family, style) in [("Inter", "Medium"), ("No Such Family", "Regular")] {
        let (_, rejected) = embed(&mut doc, family, style);
        assert_eq!(rejected, vec![0], "{family} {style}");
    }
    assert_eq!(doc.info.revision, revision);
    // Save through T009 (preflight + publish) and reopen independently.
    let first = save(&mut doc, &original);
    let p = parts(&first);
    let table = String::from_utf8(p["word/fontTable.xml"].clone()).unwrap();
    assert!(table.contains(r#"<w:font w:name="Inter"><w:embedRegular"#), "{table}");
    let types = String::from_utf8(p["[Content_Types].xml"].clone()).unwrap();
    assert!(types.contains("application/vnd.openxmlformats-officedocument.obfuscatedFont"), "{types}");
    assert!(String::from_utf8(p["word/_rels/document.xml.rels"].clone()).unwrap().contains("fontTable.xml"));
    let inter = program(&first, "Inter", "embedRegular");
    assert_eq!(inter, embedding::candidate("Inter", "Regular").ok().unwrap().bytes);
    assert_eq!(embedding::inspect(&inter).unwrap().permission, embedding::Permission::Installable);
    let mut reopened = DocxModel::open(&first).unwrap();
    assert!(reopened.round_trip().unwrap().passed);
    // Second save from the reopened file: another font joins, the existing embedded font stays byte-identical.
    let mut second_doc = open_docx(&first);
    let (view, rejected) = embed(&mut second_doc, "JetBrains Mono", "Regular");
    assert!(rejected.is_empty());
    assert_eq!(view.embedded_fonts.len(), 2);
    let second = save(&mut second_doc, &first);
    let q = parts(&second);
    let first_part = p.keys().find(|k| k.ends_with(".odttf")).unwrap();
    assert_eq!(q[first_part], p[first_part], "existing embedded font preserved");
    assert_eq!(q.keys().filter(|k| k.ends_with(".odttf")).count(), 2, "no duplicate resources");
    assert_eq!(program(&second, "JetBrains Mono", "embedRegular"), embedding::candidate("JetBrains Mono", "Regular").ok().unwrap().bytes);
    assert_eq!(program(&second, "Inter", "embedRegular"), inter);
    let _ = asset("Inter-Regular.ttf");
}

#[test]
fn stage1_docx_font_embedding_proof_rejects_invalid_outputs() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    assert!(embed(&mut doc, "Inter", "Regular").1.is_empty());
    let good = save(&mut doc, &original);
    let before = package::open(&original, package::Side::Original).unwrap();
    let base = package::open(&good, package::Side::Output).unwrap();
    assert!(package::compare_saved_docx(&before, &base).is_empty());
    let font_part = base.parts.keys().find(|k| k.ends_with(".odttf")).unwrap().clone();
    let key = embed_font::embedded(&wordcraft_engine::io::open_bytes("x.docx", &good).unwrap())[0].font_key.clone().unwrap();
    let edit = |part: &str, f: &dyn Fn(Vec<u8>) -> Vec<u8>| {
        let mut p = package::Package { order: base.order.clone(), parts: base.parts.clone() };
        let entry = p.parts.get_mut(part).unwrap();
        let changed = f(entry.1.clone());
        assert_ne!(changed, entry.1, "mutation not applied to {part}");
        entry.1 = changed;
        p
    };
    let text = |from: &'static str, to: &'static str| move |b: Vec<u8>| String::from_utf8(b).unwrap().replacen(from, to, 1).into_bytes();
    let inter = embedding::candidate("Inter", "Regular").ok().unwrap().bytes;
    let restricted = embedding::obfuscate(&embedding::tests::with_fs_type(&inter, 0x0002), &key).unwrap();
    let preview = embedding::obfuscate(&embedding::tests::with_fs_type(&inter, 0x0004), &key).unwrap();
    let cases: Vec<(&str, package::Package)> = vec![
        ("restricted-license font program", edit(&font_part, &|_| restricted.clone())),
        ("preview & print font program", edit(&font_part, &|_| preview.clone())),
        ("not obfuscated with its key", edit(&font_part, &|_| inter.clone())),
        ("family name not in the font", edit("word/fontTable.xml", &text(r#"w:name="Inter""#, r#"w:name="Other""#))),
        ("malformed font key", edit("word/fontTable.xml", &text("w:fontKey=\"{", "w:fontKey=\"{X"))),
        ("extra attribute on the embed", edit("word/fontTable.xml", &text("<w:embedRegular ", r#"<w:embedRegular w:subsetted="1" "#))),
        ("duplicate slot", edit("word/fontTable.xml", &|b| {
            let s = String::from_utf8(b).unwrap();
            let start = s.find("<w:embedRegular").unwrap();
            let end = start + s[start..].find("/>").unwrap() + 2;
            let element = s[start..end].to_string();
            s.replacen(&element, &format!("{element}{element}"), 1).into_bytes()
        })),
        ("wrong content type", edit("[Content_Types].xml", &text("obfuscatedFont", "font-ttf"))),
        ("external font relationship", edit("word/_rels/fontTable.xml.rels", &text("Target=\"fonts/", "TargetMode=\"External\" Target=\"fonts/"))),
        ("relationship of another type", edit("word/_rels/fontTable.xml.rels", &text("relationships/font\"", "relationships/image\""))),
        ("unrelated font table content", edit("word/fontTable.xml", &text("<w:font w:name=\"Inter\">", "<w:font w:name=\"Inter\"><w:charset w:val=\"00\"/>"))),
    ];
    for (name, output) in &cases {
        assert!(!package::compare_saved_docx(&before, output).is_empty(), "{name}: accepted");
    }
}
