//! Stage 5-A font package: focused tests.
//!
//! The process-wide font database is shared by every test in the binary, so these tests use the real
//! fontconfig provider through [`super::service`] (the configuration of the machine running them) and
//! check properties that do not depend on which fonts are installed, plus a fake provider for contract
//! checks on a private service.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::*;

/// The bundled Source Sans 3 Regular (OFL), from the WordCraft assets.
fn bundled_ttf() -> Vec<u8> {
    std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../external/wordcraft/assets/fonts/SourceSans3-Regular.ttf"),
    )
    .unwrap()
}

/// `font` renamed to `family` (same byte length as "Source Sans 3") in its name table.
fn renamed(font: &[u8], family: &str) -> Vec<u8> {
    assert_eq!(family.len(), "Source Sans 3".len());
    let mut data = font.to_vec();
    let utf16 = |s: &str| {
        s.encode_utf16()
            .flat_map(u16::to_be_bytes)
            .collect::<Vec<u8>>()
    };
    for (from, to) in [
        (utf16("Source Sans 3"), utf16(family)),
        (b"Source Sans 3".to_vec(), family.as_bytes().to_vec()),
    ] {
        let mut i = 0;
        while let Some(at) = data[i..].windows(from.len()).position(|w| w == from) {
            data[i + at..i + at + to.len()].copy_from_slice(&to);
            i += at + to.len();
        }
    }
    data
}

/// The tables of an sfnt font: (tag, bytes), in directory order.
fn tables(font: &[u8]) -> Vec<([u8; 4], Vec<u8>)> {
    let n = u16::from_be_bytes([font[4], font[5]]) as usize;
    (0..n)
        .map(|i| {
            let r = &font[12 + i * 16..28 + i * 16];
            let off = u32::from_be_bytes(r[8..12].try_into().unwrap()) as usize;
            let len = u32::from_be_bytes(r[12..16].try_into().unwrap()) as usize;
            (r[..4].try_into().unwrap(), font[off..off + len].to_vec())
        })
        .collect()
}

/// `font` as WOFF 1.0 with zlib-compressed tables (independent encoder: flate2, not the decoder under test).
fn woff1(font: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut t = tables(font);
    t.sort_by_key(|x| x.0);
    let dir_end = 44 + 20 * t.len();
    let (mut dir, mut body) = (Vec::new(), Vec::new());
    let mut sfnt_size = 12 + 16 * t.len();
    for (tag, data) in &t {
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        z.write_all(data).unwrap();
        let mut packed = z.finish().unwrap();
        if packed.len() >= data.len() {
            packed = data.clone();
        }
        let off = dir_end + body.len();
        dir.extend_from_slice(tag);
        for v in [off, packed.len(), data.len(), 0] {
            dir.extend_from_slice(&(v as u32).to_be_bytes());
        }
        body.extend_from_slice(&packed);
        body.resize(body.len().next_multiple_of(4), 0);
        sfnt_size += data.len().next_multiple_of(4);
    }
    let mut out = b"wOFF".to_vec();
    out.extend_from_slice(&font[..4]);
    out.extend_from_slice(&((dir_end + body.len()) as u32).to_be_bytes());
    out.extend_from_slice(&(t.len() as u16).to_be_bytes());
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&(sfnt_size as u32).to_be_bytes());
    out.extend_from_slice(&[0; 24]); // version, metadata and private blocks: none
    out.extend_from_slice(&dir);
    out.extend_from_slice(&body);
    out
}

/// An OFL font file shipped in the RHWP submodule (licence files beside them there). The Rust CI checks out
/// only WordCraft, so tests needing these are `#[ignore]` and run explicitly where RHWP is present.
fn rhwp_ofl(rel: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../external/rhwp")
        .join(rel);
    std::fs::read(&path)
        .unwrap_or_else(|_| panic!("RHWP OFL fixture {rel} is required for this test"))
}

struct FakeProvider {
    faces: std::sync::Mutex<Vec<SystemFace>>,
}

impl SystemFontProvider for FakeProvider {
    fn kind(&self) -> &'static str {
        "fake"
    }
    fn available(&self) -> bool {
        true
    }
    fn version(&self) -> Option<String> {
        None
    }
    fn error(&self) -> Option<String> {
        None
    }
    fn reload(&self) -> bool {
        true
    }
    fn faces(&self) -> Vec<SystemFace> {
        self.faces.lock().unwrap().clone()
    }
    fn resolve_family(&self, family: &str) -> Option<String> {
        (family == "sans-serif").then(|| "Fake Sans".into())
    }
    fn fallback_families(&self, _c: char) -> Vec<String> {
        vec![]
    }
}

fn face(
    file: &str,
    families: &[(&str, Option<&str>)],
    style: &str,
    weight: u16,
    italic: bool,
) -> SystemFace {
    SystemFace {
        file: PathBuf::from(file),
        index: 0,
        families: families
            .iter()
            .map(|(f, l)| (f.to_string(), l.map(str::to_string)))
            .collect(),
        style: style.into(),
        weight,
        italic,
    }
}

// --- A. System discovery --------------------------------------------------------------------

#[test]
fn fontconfig_discovers_configured_fonts_through_its_configuration() {
    let p = fontconfig::Provider::load();
    if !p.available() {
        // A machine without fontconfig: the provider must say so instead of failing.
        assert!(p.faces().is_empty() && p.error().is_some());
        eprintln!("fontconfig unavailable: {:?}", p.error());
        return;
    }
    let faces = p.faces();
    assert!(!faces.is_empty(), "the active configuration lists fonts");
    assert!(faces
        .iter()
        .all(|f| f.file.is_absolute() && !f.families.is_empty() && !f.style.is_empty()));
    assert!(p.version().is_some_and(|v| v.starts_with("2.")));
    // Generic families resolve through the configuration's rules to a listed family.
    for generic in ["sans-serif", "serif", "monospace"] {
        let fam = p
            .resolve_family(generic)
            .unwrap_or_else(|| panic!("{generic} resolves"));
        assert!(
            faces
                .iter()
                .any(|f| f.families.iter().any(|(n, _)| n.eq_ignore_ascii_case(&fam))),
            "{generic} → {fam} is listed"
        );
    }
    // An unconfigured name reaches no family (no catch-all default).
    assert_eq!(p.resolve_family("Geul No Such Family 7f3a"), None);
    // A reload keeps working.
    assert!(p.reload());
    assert_eq!(p.faces().len(), faces.len());
}

#[test]
fn css_weights_follow_the_fontconfig_scale() {
    assert_eq!(
        [0, 40, 50, 80, 100, 180, 200, 205, 210].map(css_weight),
        [100, 200, 300, 400, 500, 600, 700, 800, 900]
    );
}

#[test]
fn catalog_folds_styles_aliases_and_localized_names_into_families() {
    let dir = crate::document::testutil::TempDir::new();
    let file = dir.path().join("x.ttf");
    std::fs::write(&file, bundled_ttf()).unwrap();
    let f = file.to_str().unwrap();
    let provider = Arc::new(FakeProvider {
        faces: std::sync::Mutex::new(vec![
            face(
                f,
                &[("NanumGothic", Some("en")), ("나눔고딕", Some("ko"))],
                "Regular",
                400,
                false,
            ),
            face(
                f,
                &[
                    ("NanumGothic", Some("en")),
                    ("나눔고딕", Some("ko")),
                    ("NanumGothic Light", Some("en")),
                    ("나눔고딕 Light", Some("ko")),
                ],
                "Light",
                300,
                false,
            ),
            face(f, &[("NanumGothic", Some("en"))], "Bold", 700, false),
            face(
                "/nonexistent/geul-vanished.ttf",
                &[("Vanished Sans", None)],
                "Regular",
                400,
                false,
            ),
        ]),
    });
    let service = FontService::new(provider);
    let cat = catalog::build(&service);
    let nanum: Vec<_> = cat
        .families
        .iter()
        .filter(|e| e.family == "NanumGothic")
        .collect();
    assert_eq!(
        nanum.len(),
        1,
        "one entry per family, not per style or legacy name"
    );
    let e = nanum[0];
    assert_eq!(e.id, "system:nanumgothic");
    assert_eq!(
        e.styles
            .iter()
            .map(|s| (s.name.as_str(), s.weight))
            .collect::<Vec<_>>(),
        [("Light", 300), ("Regular", 400), ("Bold", 700)]
    );
    assert_eq!(
        e.localized,
        vec![catalog::LocalizedName {
            lang: "ko".into(),
            name: "나눔고딕".into()
        }]
    );
    assert!(!cat.families.iter().any(|e| e.family == "NanumGothic Light"));
    let vanished = cat
        .families
        .iter()
        .find(|e| e.family == "Vanished Sans")
        .unwrap();
    assert!(
        !vanished.available,
        "a face whose file is gone is reported unavailable"
    );
    // Bundled families appear once each, by typographic name.
    let bundled: Vec<_> = cat
        .families
        .iter()
        .filter(|e| e.source == catalog::FontSource::Bundled)
        .map(|e| e.family.as_str())
        .collect();
    assert!(
        bundled.contains(&"Source Sans 3") && !bundled.contains(&"Source Sans 3 Semibold"),
        "{bundled:?}"
    );
    assert!(cat
        .families
        .iter()
        .filter(|e| e.source == catalog::FontSource::Bundled)
        .all(|e| e.renderable));
    assert_eq!(cat.generics[0].family.as_deref(), Some("Fake Sans"));
    assert_eq!(cat.status.provider, "fake");
}

#[test]
fn the_shared_database_uses_the_installed_provider_and_refresh_updates_the_catalog() {
    let s = service();
    let db = FontDb::global();
    let cat = catalog::build(&s);
    if s.provider().available() {
        assert_eq!(db.system_font_source_name().as_deref(), Some("fontconfig"));
        assert_eq!(cat.status.provider, "fontconfig");
        assert!(cat.status.fontconfig_available && cat.status.system_faces > 0);
        // Every system family the catalog lists as available is one the font database resolves (no
        // second database for layout).
        let system: Vec<_> = cat
            .families
            .iter()
            .filter(|e| e.source == catalog::FontSource::System && e.available)
            .collect();
        assert!(!system.is_empty());
        let unresolved: Vec<_> = system
            .iter()
            .filter(|e| !e.renderable)
            .map(|e| e.family.as_str())
            .collect();
        assert!(
            unresolved.is_empty(),
            "system families the engine cannot resolve: {unresolved:?}"
        );
        // Paths come from fontconfig, not a fixed folder list.
        assert!(s.faces().iter().all(|f| f.file.is_absolute()));
    } else {
        assert_eq!(cat.status.provider, "none");
        assert_eq!(cat.status.system_faces, 0);
    }
    let g = db.generation();
    let n = refresh();
    assert!(db.generation() > g, "a refresh invalidates layout caches");
    assert_eq!(n == 0, !s.provider().available() || s.faces().is_empty());
}

#[test]
fn fallback_covers_hangul_from_the_configuration_when_a_korean_font_is_installed() {
    let s = service();
    if !s.provider().available() {
        return;
    }
    let korean = s.provider().fallback_families('한');
    if korean.is_empty() {
        eprintln!("no installed font covers Hangul; fallback check skipped");
        return;
    }
    let db = FontDb::global();
    // A document font this machine lacks keeps its requested name; layout finds a covering face.
    let face = db.face("Geul Missing Hangul Font", "Regular");
    assert!(!face.covers('한'), "the bundled fallback has no Hangul");
    let fb = db
        .fallback_for('한', face.id())
        .expect("a Hangul fallback face");
    assert!(fb.covers('한') && fb.covers('글'));
    // Symbols and Latin are covered too.
    assert!(db.fallback_for('A', u32::MAX).is_some());
}

// --- B. User font registration ---------------------------------------------------------------

#[test]
fn user_fonts_register_in_all_formats_persist_and_remove() {
    let s = service();
    let db = FontDb::global();
    let ttf = renamed(&bundled_ttf(), "GeulTest TTF1");
    // TTF
    let r = commands::register_bytes("geul-test.ttf", &ttf).unwrap();
    assert_eq!(r.font.families, ["GeulTest TTF1"]);
    assert!(r
        .catalog
        .families
        .iter()
        .any(|e| e.family == "GeulTest TTF1"
            && e.source == catalog::FontSource::User
            && e.renderable));
    assert_eq!(db.face("GeulTest TTF1", "Regular").family, "GeulTest TTF1");
    // Duplicate: every face already available.
    assert!(matches!(
        commands::register_bytes("again.ttf", &ttf),
        Err(commands::FontError::AlreadyAvailable { .. })
    ));
    // WOFF (zlib tables written by an independent encoder). OTF (CFF) and WOFF2 (Brotli): see
    // `user_fonts_register_cff_otf_and_brotli_woff2`.
    let woff = woff1(&renamed(&bundled_ttf(), "GeulTest WOF1"));
    assert_eq!(&woff[..4], b"wOFF");
    commands::register_bytes("geul-test.woff", &woff).unwrap();
    assert_eq!(db.face("GeulTest WOF1", "Regular").family, "GeulTest WOF1");
    // Invalid and damaged files change nothing.
    let before = db.user_fonts().len();
    let g = db.generation();
    for bad in [
        b"not a font at all".to_vec(),
        ttf[..ttf.len() / 3].to_vec(),
        woff[..woff.len() / 2].to_vec(),
        b"wOF2\0\0\0\0garbage".to_vec(),
        Vec::new(),
    ] {
        assert!(commands::register_bytes("bad.ttf", &bad).is_err());
    }
    assert!(matches!(
        commands::register_bytes(
            "big.ttf",
            &vec![0u8; wordcraft_fonts::MAX_FONT_FILE_BYTES + 1]
        ),
        Err(commands::FontError::FontTooLarge)
    ));
    assert_eq!(
        (db.user_fonts().len(), db.generation()),
        (before, g),
        "rejections leave the catalog unchanged"
    );
    // The bridge serves registered user faces only.
    let bytes = commands::user_face_bytes("GeulTest TTF1", "Regular").unwrap();
    assert_eq!(&bytes[..4], &0u32.to_le_bytes());
    assert_eq!(&bytes[4..], &ttf[..]);
    assert!(matches!(
        commands::user_face_bytes("Source Sans 3", "Regular"),
        Err(commands::FontError::NotUserFont)
    ));
    // Natural-metric face data: exact family/style of any database face, never a fallback face.
    let data = commands::face_data_bytes("GeulTest TTF1", "Regular").unwrap();
    assert_eq!(data, bytes);
    let web = commands::face_data_bytes("GeulTest WOF1", "Regular").unwrap();
    assert_ne!(
        &web[4..8],
        b"wOFF",
        "web fonts are served as the decoded sfnt the engines use"
    );
    assert!(commands::face_data_bytes("Source Sans 3", "Regular").is_ok());
    assert!(matches!(
        commands::face_data_bytes("No Such Family 42", "Regular"),
        Err(commands::FontError::InvalidRequest)
    ));
    assert!(matches!(
        commands::face_data_bytes("GeulTest TTF1", "Black Condensed"),
        Err(commands::FontError::InvalidRequest)
    ));
    // Removal: user fonts only; the catalog and the database forget it.
    assert!(matches!(
        FontDb::global()
            .remove_user_font("Source Sans 3")
            .map_err(commands::FontError::from_user),
        Err(commands::FontError::NotUserFont)
    ));
    db.remove_user_font("GeulTest TTF1").unwrap();
    assert_ne!(db.face("GeulTest TTF1", "Regular").family, "GeulTest TTF1");
    assert!(matches!(
        commands::face_data_bytes("GeulTest TTF1", "Regular"),
        Err(commands::FontError::InvalidRequest)
    ));
    assert!(!catalog::build(&s)
        .families
        .iter()
        .any(|e| e.family == "GeulTest TTF1"));
    db.remove_user_font("GeulTest WOF1").unwrap();
}

#[test]
#[ignore = "needs the OFL fixtures in external/rhwp (not checked out by the Rust CI)"]
fn user_fonts_register_cff_otf_and_brotli_woff2() {
    // CFF-flavoured OpenType and WOFF2 (Brotli, transformed tables) of the same OFL face, each in a
    // private database: the two decode to the same family.
    for rel in [
        "ttfs/opensource/SourceHanSerifK-OldHangul-subset.otf",
        "assets/fonts/SourceHanSerifK-OldHangul-subset.woff2",
    ] {
        let bytes = rhwp_ofl(rel);
        let expected = if rel.ends_with(".otf") {
            *b"OTTO"
        } else {
            *b"wOF2"
        };
        assert_eq!(bytes[..4], expected, "{rel}");
        let db = FontDb::with_font_dirs(vec![]);
        let r = db
            .install_font(rel.rsplit('/').next().unwrap(), &bytes)
            .unwrap();
        let family = r.font.families().first().cloned().expect("a family");
        let f = db.face(&family, &r.font.faces[0].1);
        assert_eq!(f.family, family, "{rel}");
        // An Old Hangul subset: its initial-consonant jamo map to real glyphs.
        assert!(
            f.covers('\u{1100}') && f.glyph_for('\u{1100}') != 0,
            "{rel}: Hangul jamo map to a real glyph"
        );
        assert_eq!(
            &f.data()[..4],
            b"OTTO",
            "{rel}: stored and loaded as CFF OpenType"
        );
    }
}

#[test]
fn stored_user_fonts_reload_in_a_new_database_after_restart() {
    // A "restart": a fresh database pointed at the same private folder loads what was stored.
    let dir = crate::document::testutil::TempDir::new();
    let fonts = dir.path().join("fonts");
    let first = FontDb::with_font_dirs(vec![]);
    first.load_user_fonts(&fonts);
    let woff = woff1(&renamed(&bundled_ttf(), "GeulPersist 1"));
    let installed = first.install_font("persist.woff", &woff).unwrap();
    assert!(installed.warning.is_none());
    let stored = installed.font.path.clone().unwrap();
    assert!(
        stored.starts_with(&fonts) && stored.extension().unwrap() == "ttf",
        "stored unwrapped, in the private folder"
    );
    let second = FontDb::with_font_dirs(vec![]);
    let (loaded, skipped) = second.load_user_fonts(&fonts);
    assert!(skipped.is_empty());
    assert_eq!(loaded.len(), 1);
    assert_eq!(
        second.face("GeulPersist 1", "Regular").family,
        "GeulPersist 1"
    );
    // Removal deletes the stored copy; the next start no longer has it.
    second.remove_user_font("GeulPersist 1").unwrap();
    assert!(!stored.exists());
    let third = FontDb::with_font_dirs(vec![]);
    assert!(third.load_user_fonts(&fonts).0.is_empty());
}

#[test]
fn storage_failure_is_reported_and_the_font_stays_usable_for_the_session() {
    let dir = crate::document::testutil::TempDir::new();
    // The "folder" is a regular file: creating it fails.
    let blocked = dir.path().join("fonts");
    std::fs::write(&blocked, b"x").unwrap();
    let db = FontDb::with_font_dirs(vec![]);
    db.load_user_fonts(&blocked);
    let r = db
        .install_font("x.ttf", &renamed(&bundled_ttf(), "GeulNoStore 1"))
        .unwrap();
    assert!(r.warning.is_some() && r.font.path.is_none());
    assert_eq!(db.face("GeulNoStore 1", "Regular").family, "GeulNoStore 1");
}

#[test]
fn reading_a_picked_font_file_is_bounded_and_refuses_non_files() {
    let dir = crate::document::testutil::TempDir::new();
    assert!(matches!(
        commands::read_font_file(dir.path()),
        Err(commands::FontError::InvalidRequest)
    ));
    let big = dir.path().join("big.ttf");
    std::fs::File::create(&big)
        .unwrap()
        .set_len(wordcraft_fonts::MAX_FONT_FILE_BYTES as u64 + 1)
        .unwrap();
    assert!(matches!(
        commands::read_font_file(&big),
        Err(commands::FontError::FontTooLarge)
    ));
    let ok = dir.path().join("ok.ttf");
    std::fs::write(&ok, b"abc").unwrap();
    assert_eq!(commands::read_font_file(&ok).unwrap(), b"abc");
}

#[test]
fn font_errors_carry_codes_without_paths() {
    let e = serde_json::to_value(commands::FontError::AlreadyAvailable {
        families: vec!["X".into()],
    })
    .unwrap();
    assert_eq!(
        e,
        serde_json::json!({"code": "AlreadyAvailable", "families": ["X"]})
    );
    assert_eq!(
        serde_json::to_value(commands::FontError::DamagedFont).unwrap(),
        serde_json::json!({"code": "DamagedFont"})
    );
}
