//! Generated, compact HWP contract fixtures. No binary or upstream sample is committed.
use super::*;
use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};

type Records = Vec<(u16, u16, Vec<u8>)>;
fn w(b: &mut [u8], at: usize, v: u16) {
    b[at..at + 2].copy_from_slice(&v.to_le_bytes());
}
fn d(b: &mut [u8], at: usize, v: u32) {
    b[at..at + 4].copy_from_slice(&v.to_le_bytes());
}
fn pack(rs: &Records) -> Vec<u8> {
    rs.iter()
        .flat_map(|(t, l, b)| hwp_record(*t, *l, b))
        .collect()
}
fn border(solid: bool) -> Vec<u8> {
    let mut b = vec![0; 40];
    if solid {
        for at in [2, 8, 14, 20] {
            b[at] = 1;
            b[at + 1] = 1;
        }
        b[26] = 1;
    }
    b
}
fn bullet(ch: u16) -> Vec<u8> {
    let mut b = vec![0; 24];
    b[0] = 8;
    b[6] = 50;
    w(&mut b, 12, ch);
    b
}
fn para_shape(bullet: bool) -> Vec<u8> {
    let mut b = vec![0; 58];
    d(&mut b, 0, if bullet { 3 << 23 } else { 0 });
    w(&mut b, 30, if bullet { 2 } else { 0 });
    w(&mut b, 32, 1);
    b
}
fn bin(id: u16) -> Vec<u8> {
    let mut b = vec![0; 12];
    w(&mut b, 0, 0x101);
    w(&mut b, 2, id);
    w(&mut b, 4, 3);
    for (i, c) in "png".encode_utf16().enumerate() {
        w(&mut b, 6 + i * 2, c);
    }
    b
}
fn encoded_image(format: image::ImageFormat) -> Vec<u8> {
    let mut b = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(3, 2)
        .write_to(&mut b, format)
        .unwrap();
    b.into_inner()
}
fn docinfo_records(edited: bool) -> Records {
    let mut map = vec![0; 72];
    for (i, n) in [
        (0, if edited { 2 } else { 1 }),
        (8, if edited { 2 } else { 1 }),
        (9, 1),
        (10, 1),
        (12, if edited { 2 } else { 1 }),
        (13, if edited { 3 } else { 2 }),
        (14, 1),
    ] {
        d(&mut map, i * 4, n);
    }
    let mut props = vec![0; 26];
    w(&mut props, 0, 1);
    let mut rs = vec![(16, 0, props), (17, 0, map), (18, 1, bin(1))];
    if edited {
        rs.push((18, 1, bin(2)));
    }
    rs.push((20, 1, border(false)));
    if edited {
        rs.push((20, 1, border(true)));
    }
    rs.extend([
        (21, 1, char_shape_record(100, 0, 7)),
        (22, 1, vec![0; 8]),
        (24, 1, bullet(0x25c6)),
    ]);
    if edited {
        rs.push((24, 1, bullet(0x2022)));
    }
    let mut other = para_shape(false);
    other[0] = 4;
    rs.extend([(25, 1, para_shape(false)), (25, 1, other)]);
    if edited {
        rs.push((25, 1, para_shape(true)));
    }
    rs.push((26, 1, vec![0; 20]));
    rs
}
fn paragraph_records(level: u16, ps: u16, text: &str, objects: &[Records]) -> Records {
    let mut bytes = Vec::new();
    for o in objects
        .iter()
        .filter(|o| o[0].2.starts_with(b"dces") || o[0].2.starts_with(b"dloc"))
    {
        bytes.extend(2u16.to_le_bytes());
        bytes.extend(&o[0].2[..4]);
        bytes.extend([0; 8]);
        bytes.extend(2u16.to_le_bytes());
    }
    bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
    for o in objects
        .iter()
        .filter(|o| !(o[0].2.starts_with(b"dces") || o[0].2.starts_with(b"dloc")))
    {
        bytes.extend(11u16.to_le_bytes());
        bytes.extend(&o[0].2[..4]);
        bytes.extend([0; 8]);
        bytes.extend(11u16.to_le_bytes());
    }
    bytes.extend(13u16.to_le_bytes());
    let mut head = vec![0; 24];
    d(&mut head, 0, (bytes.len() / 2) as u32);
    w(&mut head, 8, ps);
    w(&mut head, 12, 1);
    w(&mut head, 16, 1);
    d(
        &mut head,
        4,
        (if objects
            .iter()
            .any(|o| o[0].2.starts_with(b"dces") || o[0].2.starts_with(b"dloc"))
        {
            1 << 2
        } else {
            0
        }) | (if objects
            .iter()
            .any(|o| !(o[0].2.starts_with(b"dces") || o[0].2.starts_with(b"dloc")))
        {
            1 << 11
        } else {
            0
        }),
    );
    let mut rs = vec![
        (66, level, head),
        (67, level + 1, bytes),
        (68, level + 1, vec![0; 8]),
        (69, level + 1, vec![0; 36]),
    ];
    for object in objects {
        rs.extend(object.clone());
    }
    rs
}
fn section_control() -> Records {
    let mut head = b"dces".to_vec();
    head.extend([0; 40]);
    let mut page = vec![0; 40];
    d(&mut page, 0, 59528);
    d(&mut page, 4, 84188);
    vec![(71, 1, head), (73, 2, page)]
}
fn table_control() -> Records {
    let mut h = vec![0; 42];
    h[..4].copy_from_slice(b" lbt");
    d(&mut h, 4, 0x082a2210);
    d(&mut h, 16, 20000);
    d(&mut h, 20, 2564);
    d(&mut h, 36, 1);
    let mut t = vec![0; 26];
    w(&mut t, 4, 2);
    w(&mut t, 6, 2);
    w(&mut t, 18, 2);
    w(&mut t, 20, 2);
    w(&mut t, 22, 2);
    let mut rs = vec![(71, 1, h), (77, 2, t)];
    for cell in 0..4 {
        let mut c = vec![0; 47];
        w(&mut c, 0, 1);
        d(&mut c, 2, 0x00200000);
        w(&mut c, 6, 0x400);
        d(&mut c, 34, 10000);
        w(&mut c, 8, cell % 2);
        w(&mut c, 10, cell / 2);
        w(&mut c, 12, 1);
        w(&mut c, 14, 1);
        d(&mut c, 16, 10000);
        d(&mut c, 20, 282);
        w(&mut c, 32, 2);
        rs.push((72, 2, c));
        rs.extend(paragraph_records(2, 0, &format!("cell {cell}"), &[]));
    }
    rs
}
fn picture_control() -> Records {
    let mut h = vec![0; 46];
    h[..4].copy_from_slice(b" osg");
    d(&mut h, 4, 0xa0311);
    d(&mut h, 16, 7200);
    d(&mut h, 20, 4800);
    d(&mut h, 24, 1);
    let mut shape = vec![0; 52];
    shape[..8].copy_from_slice(b"cip$cip$");
    w(&mut shape, 18, 1);
    for (at, v) in [(20, 7200), (24, 4800), (28, 7200), (32, 4800)] {
        d(&mut shape, at, v);
    }
    w(&mut shape, 50, 1);
    for _ in 0..3 {
        for f in [1f64, 0., 0., 0., 1., 0.] {
            shape.extend(f.to_le_bytes());
        }
    }
    let mut pic = vec![0; 91];
    for (at, v) in [
        (20, 7200),
        (28, 7200),
        (32, 4800),
        (40, 4800),
        (52, 225),
        (56, 150),
        (82, 225),
        (86, 150),
    ] {
        d(&mut pic, at, v);
    }
    w(&mut pic, 71, 2);
    vec![(71, 1, h), (76, 2, shape), (85, 3, pic)]
}
fn fixture(edited: bool) -> Vec<u8> {
    let mut objects = vec![section_control()];
    if edited {
        objects.extend([table_control(), picture_control()]);
    }
    let body = pack(&paragraph_records(
        0,
        if edited { 2 } else { 0 },
        "Keep 한글",
        &objects,
    ));
    let info = pack(&docinfo_records(edited));
    let png = encoded_image(image::ImageFormat::Png);
    let mut extras = vec![
        ("/PrvText", b"\r\0\n\0".as_slice()),
        ("/PrvImage", b"".as_slice()),
        ("/BinData/BIN0001.png", png.as_slice()),
    ];
    if edited {
        extras.push(("/BinData/BIN0002.png", png.as_slice()));
    }
    hwp_doc(0, &info, &body, &extras)
}
fn stream_map(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    let mut f = cfb::CompoundFile::open(Cursor::new(bytes)).unwrap();
    let paths: Vec<_> = f
        .walk()
        .filter(|e| e.is_stream())
        .map(|e| e.path().to_string_lossy().into_owned())
        .collect();
    paths
        .into_iter()
        .map(|p| {
            let mut b = Vec::new();
            f.open_stream(&p).unwrap().read_to_end(&mut b).unwrap();
            (p, b)
        })
        .collect()
}
fn from_map(map: &BTreeMap<String, Vec<u8>>) -> Vec<u8> {
    cfb(&map
        .iter()
        .map(|(p, b)| (p.as_str(), b.as_slice()))
        .collect::<Vec<_>>())
}
fn edit_records(bytes: &[u8], name: &str, change: impl FnOnce(&mut Records)) -> Vec<u8> {
    let mut map = stream_map(bytes);
    let compressed = map["/FileHeader"][36] & 1 == 1;
    let raw = if compressed {
        let mut out = Vec::new();
        flate2::read::DeflateDecoder::new(map[name].as_slice())
            .read_to_end(&mut out)
            .unwrap();
        out
    } else {
        map[name].clone()
    };
    let mut rs = hwp_records(&raw);
    change(&mut rs);
    let raw = pack(&rs);
    let stored = if compressed {
        let mut z = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        z.write_all(&raw).unwrap();
        z.finish().unwrap()
    } else {
        raw
    };
    map.insert(name.to_owned(), stored);
    from_map(&map)
}
fn nth(rs: &mut Records, tag: u16, index: usize) -> &mut (u16, u16, Vec<u8>) {
    rs.iter_mut().filter(|r| r.0 == tag).nth(index).unwrap()
}
fn raster() -> crate::services::save::preview::PreviewRaster {
    let (width, height) =
        crate::services::save::preview::preview_dimensions(59528, 84188, false).unwrap();
    let mut rgb = vec![255; (width * height * 3) as usize];
    rgb[0..3].fill(0);
    crate::services::save::preview::PreviewRaster::new(width, height, rgb).unwrap()
}
fn publish(
    original: &[u8],
    output: &[u8],
    render: Option<&crate::services::save::preview::PreviewRaster>,
) -> (Result<SaveOutcome, DocumentError>, Vec<u8>, SessionInfo) {
    let dir = TempDir::new();
    let state = DocumentState::default();
    let info = rhwp_session(&state, &dir, "a.hwp", original);
    let registry = state.registry();
    let source = registry
        .preflight_source(info.session_id, info.load_generation)
        .unwrap();
    let loss = report("hwp", json!([]));
    let pre = service::preflight(Format::Hwp, original, original, Some(&loss));
    assert!(pre.is_safe(), "{pre:?}");
    registry
        .record_preflight(
            info.session_id,
            info.load_generation,
            source.content_hash,
            pre,
        )
        .unwrap();
    registry
        .commit(info.session_id, info.load_generation, 0, 1)
        .unwrap();
    let ticket = registry
        .begin_save(info.session_id, info.load_generation, 1)
        .unwrap();
    let result = service::save_with_options(
        registry,
        &ticket,
        &Limits::default(),
        output,
        Some(&loss),
        true,
        service::SaveOptions {
            destination: None,
            recovery: None,
            preview: render,
        },
    );
    let bytes = std::fs::read(dir.path().join("a.hwp")).unwrap();
    let info = registry.get(info.session_id).unwrap();
    (result, bytes, info)
}
#[test]
fn hwp_contract_mixed_structures_publish_and_stale_preview_does_not() {
    let original = fixture(false);
    let output = fixture(true);
    let loss = report("hwp", json!([]));
    let raw = service::check_saved(Format::Hwp, &original, &output, Some(&loss), true);
    assert_eq!(
        raw.findings,
        vec![Finding::at(FindingCode::PreviewStale, "PrvImage")]
    );
    let (refused, bytes, info) = publish(&original, &output, None);
    assert!(matches!(refused, Err(DocumentError::UnsafeSave { .. })));
    assert_eq!(bytes, original);
    assert!(info.dirty);
    let raster = raster();
    let refreshed = hwp::refresh_previews(&original, &output, Some(&raster)).unwrap();
    assert!(refreshed.output.is_some());
    let final_check = service::check_saved_with_preview(
        Format::Hwp,
        &original,
        refreshed.output.as_ref().unwrap(),
        Some(&loss),
        true,
        refreshed.image.as_deref(),
    );
    assert!(final_check.is_safe(), "{final_check:?}");
    let (saved, bytes, info) = publish(&original, &output, Some(&raster));
    let saved = saved.unwrap();
    assert!(saved.durable);
    assert!(!info.dirty);
    assert_eq!(Some(bytes), refreshed.output);
    let opaque_original = edit_records(&original, "/DocInfo", |r| {
        r.push((1000, 1, b"opaque tail".to_vec()))
    });
    let opaque_output = edit_records(&output, "/DocInfo", |r| {
        r.push((1000, 1, b"opaque tail".to_vec()))
    });
    let (saved, _, info) = publish(&opaque_original, &opaque_output, Some(&raster));
    assert!(saved.unwrap().durable);
    assert!(!info.dirty);
}

/// Every mutation is checked AND sent through the production publication service.
/// The true reopen argument is deliberately adversarial here, not fabricated engine evidence.
#[test]
fn hwp_contract_mutations_cannot_publish_even_with_reopen_true() {
    let original = fixture(false);
    let good = fixture(true);
    let mut cases: Vec<(&str, Vec<u8>, FindingCode, &str)> = Vec::new();
    macro_rules! doc {
        ($name:expr,$code:expr,$edit:expr) => {
            cases.push((
                $name,
                edit_records(&good, "/DocInfo", $edit),
                $code,
                "DocInfo",
            ));
        };
    }
    macro_rules! body {
        ($name:expr,$code:expr,$edit:expr) => {
            cases.push((
                $name,
                edit_records(&good, "/BodyText/Section0", $edit),
                $code,
                "BodyText/Section0",
            ));
        };
    }
    use FindingCode::{OutputMalformed as Bad, RecordsChanged as Changed, ReferenceInvalid as Ref};
    doc!("count without definition", Changed, |r| d(
        &mut nth(r, 17, 0).2,
        32,
        3
    ));
    doc!("definition without count", Changed, |r| {
        let at = r.iter().position(|r| r.0 == 21).unwrap();
        r.insert(at, (20, 1, border(true)));
    });
    doc!("existing border rewrite", Changed, |r| nth(r, 20, 0).2
        [0] ^= 1);
    doc!("existing bullet rewrite", Changed, |r| nth(r, 24, 0).2
        [12] ^= 1);
    doc!("existing para deletion", Changed, |r| {
        let at = r.iter().position(|r| r.0 == 25).unwrap();
        r.remove(at);
    });
    doc!("existing definitions reordered", Changed, |r| {
        let at = r.iter().position(|r| r.0 == 25).unwrap();
        r.swap(at, at + 1);
    });
    doc!("64 to 72 unknown layout", Changed, |r| nth(r, 17, 0)
        .2
        .truncate(64));
    doc!("unrelated mapping tail", Changed, |r| d(
        &mut nth(r, 17, 0).2,
        64,
        1
    ));
    doc!("unsupported mapping extra", Changed, |r| nth(r, 17, 0)
        .2
        .extend([0; 4]));
    doc!("sparse storage allocation", Changed, |r| w(
        &mut nth(r, 18, 1).2,
        2,
        7
    ));
    doc!("duplicate storage", Changed, |r| w(
        &mut nth(r, 18, 1).2,
        2,
        1
    ));
    doc!("new advanced numbering refused", Changed, |r| {
        d(&mut nth(r, 25, 2).2, 0, 2 << 23);
        w(&mut nth(r, 25, 2).2, 30, 0);
    });
    doc!("dangling bullet", Ref, |r| w(&mut nth(r, 25, 2).2, 30, 9));
    doc!("invalid head numbering", Ref, |r| d(
        &mut nth(r, 25, 2).2,
        0,
        0
    ));
    doc!("wrong bullet reuse", Changed, |r| {
        let b = nth(r, 24, 0).2.clone();
        nth(r, 24, 1).2 = b;
    });
    doc!("bullet charshape dangling", Ref, |r| d(
        &mut nth(r, 24, 1).2,
        8,
        9
    ));
    doc!("para unrelated alignment", Changed, |r| nth(r, 25, 2).2
        [0] = 4);
    body!("zero rows", Bad, |r| w(&mut nth(r, 77, 0).2, 4, 0));
    body!("columns out of range", Bad, |r| w(
        &mut nth(r, 77, 0).2,
        6,
        17
    ));
    body!("duplicate coordinate", Bad, |r| w(
        &mut nth(r, 72, 1).2,
        8,
        0
    ));
    body!("column widths inconsistent", Bad, |r| {
        d(&mut nth(r, 72, 2).2, 16, 9999);
        d(&mut nth(r, 72, 2).2, 34, 9999);
    });
    body!("table width inconsistent", Bad, |r| d(
        &mut nth(r, 71, 1).2,
        16,
        19000
    ));
    body!("row heights inconsistent", Bad, |r| d(
        &mut nth(r, 72, 1).2,
        20,
        300
    ));
    body!("cell height exceeds table", Bad, |r| {
        for c in 0..4 {
            d(&mut nth(r, 72, c).2, 20, u32::MAX);
        }
    });
    body!("cell paragraph metadata reordered", Bad, |r| {
        let at = r.iter().position(|r| r.0 == 67 && r.1 == 3).unwrap();
        r.swap(at, at + 1);
    });
    body!("duplicate line segment record", Bad, |r| {
        let at = r.iter().position(|r| r.0 == 69 && r.1 == 3).unwrap();
        let extra = r[at].clone();
        r.insert(at, extra);
        w(&mut nth(r, 66, 1).2, 16, 2);
    });
    body!("invalid span", Bad, |r| w(&mut nth(r, 72, 0).2, 12, 2));
    body!("missing cell", Bad, |r| {
        let at = r.iter().position(|r| r.0 == 72).unwrap();
        r.remove(at);
    });
    body!("broken hierarchy", Bad, |r| nth(r, 72, 0).1 = 1);
    body!("dangling table border", Ref, |r| w(
        &mut nth(r, 77, 0).2,
        22,
        99
    ));
    body!("dangling cell border", Ref, |r| w(
        &mut nth(r, 72, 0).2,
        32,
        99
    ));
    body!("TBL001 raw state", Changed, |r| d(
        &mut nth(r, 71, 1).2,
        4,
        0x002a0310
    ));
    body!("floating picture", Changed, |r| d(
        &mut nth(r, 71, 2).2,
        4,
        0xa0310
    ));
    body!("picture id dangling", Ref, |r| w(
        &mut nth(r, 85, 0).2,
        71,
        99
    ));
    body!("picture points at old resource", Ref, |r| w(
        &mut nth(r, 85, 0).2,
        71,
        1
    ));
    body!("picture effect", Bad, |r| nth(r, 85, 0).2[70] = 1);
    body!("picture transform", Bad, |r| nth(r, 76, 0).2[60] ^= 1);
    body!("paragraph ref dangling", Ref, |r| w(
        &mut nth(r, 66, 0).2,
        8,
        99
    ));
    body!("char ref dangling", Ref, |r| d(&mut nth(r, 68, 0).2, 4, 99));
    body!("surrounding text overwritten", Changed, |r| {
        let text = &mut nth(r, 67, 0).2;
        let at = text.windows(2).position(|w| w == b"K\0").unwrap();
        text[at] = b'X';
    });
    body!("surrounding text genuinely deleted", Changed, |r| {
        let text = &mut nth(r, 67, 0).2;
        text.drain(16..18);
        let n = (text.len() / 2) as u32;
        d(&mut nth(r, 66, 0).2, 0, n);
    });
    body!("new paragraph break on old text", Changed, |r| nth(
        r, 66, 0
    )
    .2[11] = 4);
    body!("invalid UTF16", Bad, |r| {
        let b = &mut nth(r, 67, 0).2;
        w(b, 16, 0xd800);
    });
    body!("old section definition changed", Changed, |r| nth(
        r, 71, 0
    )
    .2[6] ^= 1);
    for (name, new) in [
        ("bad PNG signature", vec![0; 20]),
        (
            "truncated PNG",
            encoded_image(image::ImageFormat::Png)[..20].to_vec(),
        ),
    ] {
        let mut map = stream_map(&good);
        map.insert("/BinData/BIN0002.png".into(), new);
        cases.push((name, from_map(&map), Bad, "BinData/BIN0002.png"));
    }
    let mut map = stream_map(&good);
    map.remove("/BinData/BIN0002.png");
    cases.push(("missing stream", from_map(&map), Ref, "BinData/BIN0002.png"));
    let mut map = stream_map(&good);
    map.insert(
        "/BinData/BIN0003.png".into(),
        encoded_image(image::ImageFormat::Png),
    );
    cases.push((
        "orphan stream",
        from_map(&map),
        Ref,
        "/BinData/BIN0003.png".trim_start_matches('/'),
    ));
    let mut map = stream_map(&good);
    map.insert("/BinData/BIN0001.png".into(), b"changed".to_vec());
    cases.push((
        "existing image replacement",
        from_map(&map),
        FindingCode::PartChanged,
        "BinData/BIN0001.png",
    ));
    let invalid_compression =
        edit_records(&good, "/DocInfo", |r| w(&mut nth(r, 18, 1).2, 0, 0x131));
    cases.push((
        "reserved compression",
        invalid_compression,
        Bad,
        "BinData/BIN0002.png",
    ));
    let invalid_deflate = edit_records(&good, "/DocInfo", |r| w(&mut nth(r, 18, 1).2, 0, 0x111));
    cases.push((
        "invalid deflate",
        invalid_deflate,
        Bad,
        "BinData/BIN0002.png",
    ));
    // JPEG must decode completely and agree with its declaration, too.
    let jpeg = encoded_image(image::ImageFormat::Jpeg);
    let jpeg_good = edit_records(&good, "/DocInfo", |r| {
        let decl = &mut nth(r, 18, 1).2;
        for (i, c) in "jpg".encode_utf16().enumerate() {
            w(decl, 6 + i * 2, c);
        }
    });
    let mut jpeg_map = stream_map(&jpeg_good);
    jpeg_map.remove("/BinData/BIN0002.png");
    jpeg_map.insert("/BinData/BIN0002.jpg".into(), jpeg.clone());
    let jpeg_good = from_map(&jpeg_map);
    let verdict = service::check_saved(
        Format::Hwp,
        &original,
        &jpeg_good,
        Some(&report("hwp", json!([]))),
        true,
    );
    assert_eq!(
        verdict.findings,
        vec![Finding::at(FindingCode::PreviewStale, "PrvImage")]
    );
    jpeg_map.insert(
        "/BinData/BIN0002.jpg".into(),
        jpeg[..jpeg.len() / 2].to_vec(),
    );
    assert_rejected(
        "truncated JPEG",
        &original,
        &from_map(&jpeg_map),
        Bad,
        "BinData/BIN0002.jpg",
    );
    jpeg_map.insert(
        "/BinData/BIN0002.jpg".into(),
        encoded_image(image::ImageFormat::Png),
    );
    assert_rejected(
        "JPEG extension with PNG bytes",
        &original,
        &from_map(&jpeg_map),
        Bad,
        "BinData/BIN0002.jpg",
    );
    let old64 = edit_records(&original, "/DocInfo", |r| nth(r, 17, 0).2.truncate(64));
    assert_rejected(
        "64 to 72 extension rejected",
        &old64,
        &good,
        Changed,
        "DocInfo",
    );
    // Unknown payload/order must match in context, not just in a bag of hashes.
    let opaque_original = edit_records(&original, "/DocInfo", |r| {
        r.insert(2, (1000, 1, b"opaque".to_vec()))
    });
    let relocated = edit_records(&good, "/DocInfo", |r| r.push((1000, 1, b"opaque".to_vec())));
    assert_rejected(
        "opaque relocation",
        &opaque_original,
        &relocated,
        Changed,
        "DocInfo",
    );
    let opaque_changed = edit_records(&good, "/DocInfo", |r| {
        r.insert(2, (1000, 1, b"changed".to_vec()))
    });
    assert_rejected(
        "opaque payload",
        &opaque_original,
        &opaque_changed,
        Changed,
        "DocInfo",
    );
    let opaque_body = edit_records(&original, "/BodyText/Section0", |r| {
        r.push((1000, 1, b"opaque body".to_vec()))
    });
    assert_rejected(
        "opaque body cannot disappear",
        &opaque_body,
        &good,
        Changed,
        "BodyText/Section0",
    );
    let reindexed = edit_records(&good, "/DocInfo", |r| {
        let at = r.iter().position(|r| r.0 == 24).unwrap();
        r.remove(at);
        d(&mut nth(r, 17, 0).2, 48, 1);
    });
    assert_rejected(
        "removal must not reindex existing bullet IDs",
        &good,
        &reindexed,
        Changed,
        "DocInfo",
    );
    let no_table = edit_records(&good, "/BodyText/Section0", |r| {
        nth(r, 72, 0).2[12] = 2;
    });
    assert_rejected(
        "pre-existing table cannot acquire invalid span",
        &good,
        &no_table,
        Changed,
        "BodyText/Section0",
    );
    let bad_existing = edit_records(&good, "/BodyText/Section0", |r| {
        w(&mut nth(r, 72, 0).2, 12, 2)
    });
    let changed_list = edit_records(&bad_existing, "/BodyText/Section0", |r| {
        w(&mut nth(r, 66, 0).2, 8, 0)
    });
    assert_rejected(
        "pre-existing malformed cell grid is not ignored",
        &bad_existing,
        &changed_list,
        Bad,
        "BodyText/Section0",
    );
    for (name, output, code, part) in &cases {
        assert_rejected(name, &original, output, *code, part);
    }
    // These same mixed cases exercise independently valid other features during each corruption.
    assert!(cases.len() >= 40);
}
fn assert_rejected(name: &str, original: &[u8], output: &[u8], code: FindingCode, part: &str) {
    let expected = Finding::at(code, part);
    let result = service::check_saved(
        Format::Hwp,
        original,
        output,
        Some(&report("hwp", json!([]))),
        true,
    );
    assert_eq!(result.outcome, Outcome::Unsafe, "{name} {result:?}");
    assert!(
        result.findings.contains(&expected),
        "{name}: expected {expected:?}, actual {result:?}"
    );
    let render = raster();
    let (result, bytes, info) = publish(original, output, Some(&render));
    let Err(DocumentError::UnsafeSave { preservation }) = result else {
        panic!("{name}: unexpectedly published or wrong error {result:?}")
    };
    assert!(
        preservation.findings.contains(&expected),
        "{name}: {preservation:?}"
    );
    assert_eq!(bytes, original, "{name}: original modified");
    assert!(info.dirty);
    assert_eq!(info.revision, 1);
    println!(
        "HWP_CONTRACT_NEGATIVE {}",
        json!({"mutation":name,"expected":expected,"actual":preservation,"publicationPrevented":true,"originalIntact":true})
    );
}

#[test]
#[ignore = "explicit asset generation for the approved-WASM integration driver"]
fn hwp_contract_generate_image_inputs() {
    let root = std::path::PathBuf::from(
        std::env::var_os("GEUL_HWP_CONTRACT_DIR").expect("evidence directory"),
    );
    std::fs::create_dir_all(&root).unwrap();
    for (name, format, color) in [
        ("input.png", image::ImageFormat::Png, [0, 40, 255]),
        ("input.jpg", image::ImageFormat::Jpeg, [255, 120, 0]),
    ] {
        let image = image::RgbImage::from_pixel(3, 2, image::Rgb(color));
        let mut out = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut out, format)
            .unwrap();
        std::fs::write(root.join(name), out.into_inner()).unwrap();
    }
}

#[test]
#[ignore = "requires fresh authenticated WASM exports/model proofs and SVG page-1 renders"]
fn hwp_contract_real_engine_publication() {
    use sha2::{Digest, Sha256};
    let root = std::path::PathBuf::from(
        std::env::var_os("GEUL_HWP_CONTRACT_DIR").expect("evidence directory"),
    );
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(root.join("cases.json")).unwrap()).unwrap();
    let mut results = Vec::new();
    for case in manifest.as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let folder = root.join(id);
        let read = |name: &str| std::fs::read(folder.join(name)).unwrap();
        let original = read("original.hwp");
        let output = read("edited.hwp");
        let noop = read("noop.hwp");
        let loss: Value = serde_json::from_slice(&read("loss.json")).unwrap();
        let loss0: Value = serde_json::from_slice(&read("noop-loss.json")).unwrap();
        let proof: Value = serde_json::from_slice(&read("proof.json")).unwrap();
        assert_eq!(
            proof["originalSha256"],
            format!("{:x}", Sha256::digest(&original))
        );
        assert_eq!(
            proof["editedSha256"],
            format!("{:x}", Sha256::digest(&output))
        );
        let preflight = service::preflight(Format::Hwp, &original, &noop, Some(&loss0));
        assert!(preflight.is_safe(), "{id} preflight {preflight:?}");
        let raw = service::check_saved(
            Format::Hwp,
            &original,
            &output,
            Some(&loss),
            proof["reopenEqual"].as_bool().unwrap(),
        );
        let png = image::ImageReader::new(Cursor::new(read(
            if std::env::var_os("GEUL_HWP_CANVAS").is_some() {
                "canvas-render.png"
            } else {
                "render.png"
            },
        )))
        .with_guessed_format()
        .unwrap()
        .decode()
        .unwrap()
        .to_rgba8();
        let (w, h) = png.dimensions();
        let rgb = png
            .pixels()
            .flat_map(|pixel| {
                let a = u32::from(pixel[3]);
                [0, 1, 2].map(|i| ((u32::from(pixel[i]) * a + 255 * (255 - a) + 127) / 255) as u8)
            })
            .collect();
        let render = crate::services::save::preview::PreviewRaster::new(w, h, rgb).unwrap();
        if std::env::var_os("GEUL_HWP_CANVAS").is_some() {
            let evidence: Value = serde_json::from_slice(&read("canvas-proof.json")).unwrap();
            assert_eq!(evidence["editedSha256"], proof["editedSha256"]);
            assert_eq!(
                evidence["rgbSha256"],
                format!("{:x}", Sha256::digest(&render.rgb))
            );
            assert_eq!(evidence["generation"], proof["engineGeneration"]);
        }
        let expected_failure = case["negative"].as_bool().unwrap_or(false);
        if expected_failure {
            assert!(!raw.is_safe(), "{id} negative accepted");
            let expected = case["expectedCode"].as_str().unwrap();
            assert!(
                serde_json::to_value(&raw).unwrap()["findings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|f| f["code"] == expected),
                "{id} {raw:?}"
            );
            let (result, bytes, info) = publish(&original, &output, Some(&render));
            assert!(result.is_err(), "{id} published");
            assert_eq!(bytes, original);
            assert!(info.dirty);
            results.push(json!({"id":id,"preflight":preflight,"raw":raw,"publicationPrevented":true,"originalIntact":true}));
            continue;
        }
        assert_eq!(proof["reopenEqual"], true, "{id}");
        assert!(
            raw.findings
                .iter()
                .all(|f| f.code == FindingCode::PreviewStale),
            "{id} structural {raw:?}"
        );
        let refreshed = hwp::refresh_previews(&original, &output, Some(&render)).unwrap();
        let validated = refreshed.output.as_deref().unwrap_or(&output);
        let saved_check = service::check_saved_with_preview(
            Format::Hwp,
            &original,
            validated,
            Some(&loss),
            true,
            refreshed.image.as_deref(),
        );
        assert!(saved_check.is_safe(), "{id} {saved_check:?}");
        let dir = TempDir::new();
        let state = DocumentState::default();
        let info = rhwp_session(&state, &dir, "actual.hwp", &original);
        let registry = state.registry();
        let source = registry
            .preflight_source(info.session_id, info.load_generation)
            .unwrap();
        registry
            .record_preflight(
                info.session_id,
                info.load_generation,
                source.content_hash,
                preflight.clone(),
            )
            .unwrap();
        registry
            .commit(info.session_id, info.load_generation, 0, 1)
            .unwrap();
        let ticket = registry
            .begin_save(info.session_id, info.load_generation, 1)
            .unwrap();
        let saved = service::save_with_options(
            registry,
            &ticket,
            &Limits::default(),
            &output,
            Some(&loss),
            true,
            service::SaveOptions {
                destination: None,
                recovery: None,
                preview: Some(&render),
            },
        )
        .unwrap();
        assert!(saved.durable && !saved.session.dirty, "{id}");
        let published = std::fs::read(dir.path().join("actual.hwp")).unwrap();
        assert_eq!(published, validated);
        std::fs::write(folder.join("published.hwp"), &published).unwrap();
        results.push(json!({"id":id,"preflight":preflight,"raw":raw,"savedFileCheck":saved_check,"durable":saved.durable,"dirty":saved.session.dirty,"publishedSha256":format!("{:x}",Sha256::digest(&published)),"previewRegenerated":refreshed.image.is_some(),"exitCode":0}));
    }
    let name = match (
        std::env::var_os("GEUL_HWP_CANVAS").is_some(),
        std::env::var_os("GEUL_HWP_REPEAT").is_some(),
    ) {
        (true, true) => "publication-repeat-canvas.json",
        (true, false) => "publication-canvas.json",
        (false, true) => "publication-repeat.json",
        (false, false) => "publication.json",
    };
    std::fs::write(
        root.join(name),
        serde_json::to_vec_pretty(&results).unwrap(),
    )
    .unwrap();
}

#[test]
fn hwp_contract_initial_section_marker_only_reduces() {
    let original = fixture(false);
    let good = fixture(true);
    let mut cold = vec![0; 16];
    cold[..4].copy_from_slice(b"dloc");
    let orig_body = pack(&paragraph_records(
        0,
        0,
        "Keep 한글",
        &[section_control(), vec![(71, 1, cold.clone())]],
    ));
    let out_body = pack(&paragraph_records(
        0,
        2,
        "Keep 한글",
        &[
            section_control(),
            vec![(71, 1, cold)],
            table_control(),
            picture_control(),
        ],
    ));
    let original = cfb_replace(&original, &[("/BodyText/Section0", &orig_body)]);
    let good = cfb_replace(&good, &[("/BodyText/Section0", &out_body)]);
    let with_initial = edit_records(&original, "/BodyText/Section0", |r| nth(r, 66, 0).2[11] = 3);
    let render = raster();
    let (saved, _, _) = publish(&with_initial, &good, Some(&render));
    assert!(saved.unwrap().durable);
    let invented = edit_records(&good, "/BodyText/Section0", |r| nth(r, 66, 0).2[11] = 3);
    assert_rejected(
        "initial section marker cannot be invented",
        &original,
        &invented,
        FindingCode::RecordsChanged,
        "BodyText/Section0",
    );
}
