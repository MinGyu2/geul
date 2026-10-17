//! 형식 판별·경로 검사·세션 테스트. 입력은 testutil의 합성 컨테이너다.

use std::io::Cursor;
use std::sync::Arc;

use super::detect::detect_with;
use super::error::{
    DocumentError, LimitKind, ParseProblem, PathProblem, ReadProblem, UnsupportedKind,
};
use super::open::{identify, Limits};
use super::session::{CloseOutcome, SessionRegistry, SessionState};
use super::testutil::*;
use super::zip::ZipLimits;
use super::{detect, Engine, Format};

fn detect_bytes(bytes: &[u8]) -> Result<Format, DocumentError> {
    detect(&mut Cursor::new(bytes), bytes.len() as u64)
}

fn parse(format: Option<Format>, reason: ParseProblem) -> Result<Format, DocumentError> {
    Err(DocumentError::ParseFailure { format, reason })
}

fn unsupported(kind: UnsupportedKind) -> Result<Format, DocumentError> {
    Err(DocumentError::UnsupportedFormat { kind })
}

// ---- 형식 판별 ----

#[test]
fn 세_형식을_내용으로_구별한다() {
    assert_eq!(detect_bytes(&hwp()), Ok(Format::Hwp));
    assert_eq!(detect_bytes(&hwpx()), Ok(Format::Hwpx));
    assert_eq!(detect_bytes(&docx()), Ok(Format::Docx));
    assert_eq!(Format::Hwp.engine(), Engine::Rhwp);
    assert_eq!(Format::Hwpx.engine(), Engine::Rhwp);
    assert_eq!(Format::Docx.engine(), Engine::Wordcraft);
}

#[test]
fn 배포용_hwp는_viewtext로도_인정하고_mimetype_없는_hwpx도_필수_항목으로_인정한다() {
    let header = hwp_file_header(5, 0x04);
    assert_eq!(
        detect_bytes(&cfb(&[
            ("/FileHeader", &header),
            ("/DocInfo", b"d"),
            ("/ViewText/Section0", b"s")
        ])),
        Ok(Format::Hwp)
    );
    let entries: Vec<_> = hwpx_entries()
        .into_iter()
        .filter(|item| item.name != "mimetype")
        .collect();
    assert_eq!(detect_bytes(&zip(&entries, false)), Ok(Format::Hwpx));
}

#[test]
fn hwpx와_docx는_zip_표식으로_구별하고_섞이면_정하지_않는다() {
    let mut both = hwpx_entries();
    both.extend(docx_entries());
    assert_eq!(
        detect_bytes(&zip(&both, false)),
        unsupported(UnsupportedKind::Ambiguous)
    );

    // 다른 mimetype을 선언한 패키지에 HWPX 항목이 있으면 정하지 않는다.
    let mut other_mimetype = hwpx_entries();
    other_mimetype[0] = stored("mimetype", b"application/vnd.oasis.opendocument.text");
    assert_eq!(
        detect_bytes(&zip(&other_mimetype, false)),
        unsupported(UnsupportedKind::Ambiguous)
    );
}

#[test]
fn ole_문서라도_hwp_구조가_아니면_hwp가_아니다() {
    assert_eq!(
        detect_bytes(&cfb(&[("/WordDocument", b"w"), ("/1Table", b"t")])),
        unsupported(UnsupportedKind::LegacyWord)
    );
    assert_eq!(
        detect_bytes(&cfb(&[("/Workbook", b"x")])),
        unsupported(UnsupportedKind::OtherOle)
    );
    // 이름만 FileHeader인 다른 OLE 문서
    assert_eq!(
        detect_bytes(&cfb(&[("/FileHeader", &[7u8; 256]), ("/DocInfo", b"d")])),
        unsupported(UnsupportedKind::OtherOle)
    );
    // HWP 서명이지만 필수 스트림이 없음
    let header = hwp_file_header(5, 0);
    assert_eq!(
        detect_bytes(&cfb(&[("/FileHeader", &header)])),
        parse(Some(Format::Hwp), ParseProblem::MissingPart)
    );
    assert_eq!(
        detect_bytes(&cfb(&[("/FileHeader", &header), ("/DocInfo", b"d")])),
        parse(Some(Format::Hwp), ParseProblem::MissingPart)
    );
    assert_eq!(
        detect_bytes(&cfb(&[
            ("/FileHeader", &header[..100]),
            ("/DocInfo", b"d"),
            ("/BodyText/S", b"s")
        ])),
        parse(Some(Format::Hwp), ParseProblem::InvalidPart)
    );
    assert_eq!(
        detect_bytes(&hwp_with(4, 0)),
        unsupported(UnsupportedKind::HwpVersion)
    );
}

#[test]
fn zip이라도_hwpx나_docx가_아니면_구별해_거부한다() {
    assert_eq!(
        detect_bytes(&zip(&[entry("readme.txt", b"hello")], false)),
        unsupported(UnsupportedKind::OtherZip)
    );
    assert_eq!(
        detect_bytes(&zip(&[], false)),
        unsupported(UnsupportedKind::OtherZip)
    );
    let odt = [
        stored("mimetype", b"application/vnd.oasis.opendocument.text"),
        entry("content.xml", b"<x/>"),
    ];
    assert_eq!(
        detect_bytes(&zip(&odt, false)),
        unsupported(UnsupportedKind::OtherZip)
    );

    let ooxml = |part: &str, kind: &str| {
        zip(
            &[
                entry("[Content_Types].xml", content_types(part, kind).as_bytes()),
                entry("_rels/.rels", package_rels(part).as_bytes()),
                entry(part, b"<x/>"),
            ],
            false,
        )
    };
    let xlsx = ooxml(
        "xl/workbook.xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    );
    assert_eq!(
        detect_bytes(&xlsx),
        unsupported(UnsupportedKind::OtherOoxml)
    );
    let docm = ooxml(
        "word/document.xml",
        "application/vnd.ms-word.document.macroEnabled.main+xml",
    );
    assert_eq!(
        detect_bytes(&docm),
        unsupported(UnsupportedKind::WordVariant)
    );
    let dotx = ooxml(
        "word/document.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
    );
    assert_eq!(
        detect_bytes(&dotx),
        unsupported(UnsupportedKind::WordVariant)
    );
    // 본문 부분 이름이 표준과 달라도 관계와 내용 형식이 맞으면 docx다.
    assert_eq!(
        detect_bytes(&ooxml("doc/main.xml", DOCX_MAIN)),
        Ok(Format::Docx)
    );
}

#[test]
fn 필수_항목이_없거나_잘못된_패키지는_구조_오류다() {
    let without = |name: &str| {
        zip(
            &docx_entries()
                .into_iter()
                .filter(|item| item.name != name)
                .collect::<Vec<_>>(),
            false,
        )
    };
    assert_eq!(
        detect_bytes(&without("word/document.xml")),
        parse(Some(Format::Docx), ParseProblem::MissingPart)
    );
    assert_eq!(
        detect_bytes(&without("_rels/.rels")),
        parse(None, ParseProblem::MissingPart)
    );
    assert_eq!(
        detect_bytes(&without("[Content_Types].xml")),
        parse(None, ParseProblem::MissingPart)
    );

    let with_rels = |rels: &str| {
        let mut entries = docx_entries();
        entries[1] = entry("_rels/.rels", rels.as_bytes());
        zip(&entries, false)
    };
    assert_eq!(
        detect_bytes(&with_rels(&format!(
            r#"<Relationships xmlns="{OPC_RELATIONSHIPS}"/>"#
        ))),
        parse(None, ParseProblem::MissingPart)
    );
    assert_eq!(
        detect_bytes(&with_rels("<Relationships><Relationship")),
        parse(None, ParseProblem::InvalidPart)
    );
    assert_eq!(
        detect_bytes(&with_rels(&package_rels("../word/document.xml"))),
        parse(None, ParseProblem::InvalidPart)
    );
    let two = format!(
        r#"<Relationships xmlns="{OPC_RELATIONSHIPS}"><Relationship Id="rId1" Type="{OFFICE_DOCUMENT}" Target="word/document.xml"/><Relationship Id="rId2" Type="{OFFICE_DOCUMENT}" Target="word/other.xml"/></Relationships>"#
    );
    assert_eq!(
        detect_bytes(&with_rels(&two)),
        parse(None, ParseProblem::InvalidPart)
    );
    let external = format!(
        r#"<Relationships xmlns="{OPC_RELATIONSHIPS}"><Relationship Id="rId1" Type="{OFFICE_DOCUMENT}" Target="https://example.invalid/d.xml" TargetMode="External"/></Relationships>"#
    );
    assert_eq!(
        detect_bytes(&with_rels(&external)),
        parse(None, ParseProblem::InvalidPart)
    );

    let mut no_type = docx_entries();
    no_type[0] = entry(
        "[Content_Types].xml",
        format!(r#"<Types xmlns="{OPC_CONTENT_TYPES}"/>"#).as_bytes(),
    );
    assert_eq!(
        detect_bytes(&zip(&no_type, false)),
        parse(None, ParseProblem::InvalidPart)
    );

    let hwpx_without = |name: &str| {
        zip(
            &hwpx_entries()
                .into_iter()
                .filter(|item| item.name != name)
                .collect::<Vec<_>>(),
            false,
        )
    };
    assert_eq!(
        detect_bytes(&hwpx_without("Contents/header.xml")),
        parse(Some(Format::Hwpx), ParseProblem::MissingPart)
    );
    assert_eq!(
        detect_bytes(&hwpx_without("Contents/content.hpf")),
        parse(Some(Format::Hwpx), ParseProblem::MissingPart)
    );
}

#[test]
fn 빈_파일과_잘린_파일을_구별한다() {
    assert_eq!(detect_bytes(b""), parse(None, ParseProblem::Empty));
    assert_eq!(
        detect_bytes(b"PK\x03"),
        parse(None, ParseProblem::Truncated)
    );
    assert_eq!(
        detect_bytes(&[0xD0, 0xCF, 0x11]),
        parse(None, ParseProblem::Truncated)
    );
    for bytes in [docx(), hwpx()] {
        for cut in [4, 30, bytes.len() / 2, bytes.len() - 1] {
            assert_eq!(
                detect_bytes(&bytes[..cut]),
                parse(None, ParseProblem::Truncated),
                "cut {cut}"
            );
        }
    }
    let hwp = hwp();
    assert_eq!(
        detect_bytes(&hwp[..300]),
        parse(None, ParseProblem::Truncated)
    );
    // 스트림 데이터가 잘리면 HWP로 인정하지 않는다. 큰 스트림(일반 섹터에 저장)의 마지막 바이트 앞에서 자른다.
    let header = hwp_file_header(5, 0);
    let body = vec![0xAB; 6000];
    let big = cfb(&[
        ("/FileHeader", &header),
        ("/DocInfo", b"d"),
        ("/BodyText/Section0", &body),
    ]);
    assert_eq!(detect_bytes(&big), Ok(Format::Hwp));
    let last = big.iter().rposition(|&byte| byte == 0xAB).unwrap();
    assert_eq!(
        detect_bytes(&big[..last]),
        parse(Some(Format::Hwp), ParseProblem::Truncated)
    );
    // 어디서 잘라도 결과는 HWP(쓰지 않는 끝 공간만 잘림)이거나 구조 오류다.
    for cut in (512..big.len()).step_by(61) {
        match detect_bytes(&big[..cut]) {
            Ok(Format::Hwp) | Err(DocumentError::ParseFailure { .. }) => {}
            other => panic!("cut {cut}: {other:?}"),
        }
    }
}

#[test]
fn 지원_확장자에_다른_내용이_들어_있으면_형식을_알_수_없다() {
    assert_eq!(
        detect_bytes(b"plain text, not a document"),
        unsupported(UnsupportedKind::Unknown)
    );
    assert_eq!(
        detect_bytes(b"<?xml version=\"1.0\"?><HWPML/>"),
        unsupported(UnsupportedKind::Unknown)
    );
    let mut hwp3 = b"HWP Document File V3.00 \x1a\x01\x02\x03\x04\x05".to_vec();
    hwp3.resize(128, 0);
    assert_eq!(detect_bytes(&hwp3), unsupported(UnsupportedKind::Hwp3));
}

#[test]
fn 암호화와_drm_문서를_거부한다() {
    let encrypted = Err(DocumentError::Encrypted {
        format: Some(Format::Hwp),
    });
    assert_eq!(detect_bytes(&hwp_with(5, 0x02)), encrypted);
    assert_eq!(detect_bytes(&hwp_with(5, 0x10)), encrypted);
    assert_eq!(
        detect_bytes(&cfb(&[
            ("/EncryptionInfo", b"i"),
            ("/EncryptedPackage", b"p")
        ])),
        Err(DocumentError::Encrypted { format: None })
    );
    assert_eq!(
        detect_bytes(b"\x9b DRMONE  This Document is encrypted"),
        Err(DocumentError::Encrypted { format: None })
    );
    assert_eq!(
        detect_bytes(b"SCDSA002........"),
        Err(DocumentError::Encrypted { format: None })
    );

    let mut manifest = hwpx_entries();
    manifest.push(entry("META-INF/manifest.xml", format!("<odf:manifest xmlns:odf=\"{ODF_MANIFEST}\"><odf:file-entry full-path=\"Contents/header.xml\"><odf:encryption-data/></odf:file-entry></odf:manifest>").as_bytes()));
    assert_eq!(
        detect_bytes(&zip(&manifest, false)),
        Err(DocumentError::Encrypted {
            format: Some(Format::Hwpx)
        })
    );
    let mut plain_manifest = hwpx_entries();
    plain_manifest.push(entry(
        "META-INF/manifest.xml",
        format!("<odf:manifest xmlns:odf=\"{ODF_MANIFEST}\"/>").as_bytes(),
    ));
    assert_eq!(detect_bytes(&zip(&plain_manifest, false)), Ok(Format::Hwpx));

    let mut flagged = hwpx_entries();
    flagged[3].flags = 1;
    assert_eq!(
        detect_bytes(&zip(&flagged, false)),
        Err(DocumentError::Encrypted {
            format: Some(Format::Hwpx)
        })
    );
    let mut flagged_docx = docx_entries();
    flagged_docx[2].flags = 1;
    assert_eq!(
        detect_bytes(&zip(&flagged_docx, false)),
        Err(DocumentError::Encrypted {
            format: Some(Format::Docx)
        })
    );
    let mut flagged_types = docx_entries();
    flagged_types[0].flags = 1;
    assert_eq!(
        detect_bytes(&zip(&flagged_types, false)),
        Err(DocumentError::Encrypted { format: None })
    );
}

#[test]
fn zip64_끝_레코드를_읽는다() {
    assert_eq!(detect_bytes(&zip(&docx_entries(), true)), Ok(Format::Docx));
    assert_eq!(detect_bytes(&zip(&hwpx_entries(), true)), Ok(Format::Hwpx));
}

#[test]
fn 손상된_zip_구조를_거부한다() {
    let corrupt = parse(None, ParseProblem::CorruptContainer);
    // 대소문자만 다른 중복 이름
    let mut duplicate = docx_entries();
    duplicate.push(entry("[content_types].xml", b"<Types/>"));
    assert_eq!(detect_bytes(&zip(&duplicate, false)), corrupt);
    // CRC 불일치
    let mut crc = docx_entries();
    crc[0].crc = Some(0);
    assert_eq!(detect_bytes(&zip(&crc, false)), corrupt);
    // 선언 크기보다 크게 풀림
    let mut size = docx_entries();
    size[1].declared_size = Some(10);
    assert_eq!(detect_bytes(&zip(&size, false)), corrupt);
    // 로컬 헤더 이름이 중앙 디렉터리와 다름
    let mut name = docx_entries();
    name[0].local_name = Some("[Content_Types].xmX".into());
    assert_eq!(detect_bytes(&zip(&name, false)), corrupt);
    // 중앙 디렉터리 위치가 파일 밖
    let mut bytes = docx();
    let at = bytes.len() - 6;
    bytes[at..at + 4].copy_from_slice(&0x00FF_FFFFu32.to_le_bytes());
    assert_eq!(detect_bytes(&bytes), corrupt);
    // 여러 디스크
    let mut bytes = docx();
    let at = bytes.len() - 18;
    bytes[at..at + 2].copy_from_slice(&1u16.to_le_bytes());
    assert_eq!(detect_bytes(&bytes), corrupt);
    // 지원하지 않는 압축 방식
    let mut method = docx();
    let directory = method
        .windows(4)
        .position(|w| w == 0x0201_4b50u32.to_le_bytes())
        .unwrap();
    method[directory + 10] = 12; // bzip2
    assert_eq!(
        detect_bytes(&method),
        parse(None, ParseProblem::InvalidPart)
    );
}

#[test]
fn 자원_상한을_넘으면_검사를_멈춘다() {
    let limits = ZipLimits {
        max_entries: 4,
        max_directory_bytes: 8 * 1024 * 1024,
        max_name_bytes: 4096,
    };
    let mut many = docx_entries();
    many.extend((0..2).map(|i| entry(&format!("word/media/{i}.bin"), b"x")));
    let bytes = zip(&many, false);
    assert_eq!(
        detect_with(&mut Cursor::new(&bytes), bytes.len() as u64, &limits),
        Err(DocumentError::ResourceLimit {
            limit: LimitKind::EntryCount
        })
    );

    let small_directory = ZipLimits {
        max_directory_bytes: 64,
        ..limits
    };
    let bytes = docx();
    assert_eq!(
        detect_with(
            &mut Cursor::new(&bytes),
            bytes.len() as u64,
            &small_directory
        ),
        Err(DocumentError::ResourceLimit {
            limit: LimitKind::MetadataSize
        })
    );
    let short_names = ZipLimits {
        max_name_bytes: 8,
        max_entries: 100,
        ..small_directory
    };
    let short_names = ZipLimits {
        max_directory_bytes: 8 * 1024 * 1024,
        ..short_names
    };
    assert_eq!(
        detect_with(&mut Cursor::new(&bytes), bytes.len() as u64, &short_names),
        Err(DocumentError::ResourceLimit {
            limit: LimitKind::MetadataSize
        })
    );

    // 압축 폭탄: 1 MiB 상한을 넘는 XML 항목은 선언 크기로 거부하고, 선언을 속여도 상한까지만 풀고 멈춘다.
    let huge = vec![b' '; 3 * 1024 * 1024];
    let mut bomb = docx_entries();
    bomb[0] = entry("[Content_Types].xml", &huge);
    assert_eq!(
        detect_bytes(&zip(&bomb, false)),
        Err(DocumentError::ResourceLimit {
            limit: LimitKind::PartSize
        })
    );
    bomb[0].declared_size = Some(100);
    assert_eq!(
        detect_bytes(&zip(&bomb, false)),
        Err(DocumentError::ResourceLimit {
            limit: LimitKind::PartSize
        })
    );
    // 문서 본문은 판별에 풀지 않으므로 커도 상관없다.
    let mut big_body = docx_entries();
    big_body[2] = entry("word/document.xml", &huge);
    assert_eq!(detect_bytes(&zip(&big_body, false)), Ok(Format::Docx));
}

#[test]
fn 손상된_입력에서_멈추거나_패닉하지_않는다() {
    // 결정적 변형: 바이트 덮어쓰기와 자르기. 결과는 올바른 형식이거나 오류여야 하며, 다른 형식으로 바뀌면 안 된다.
    let mut rng = Rng::new(0x5EED_6E01);
    for (format, original) in [
        (Format::Docx, docx()),
        (Format::Hwpx, hwpx()),
        (Format::Hwp, hwp()),
    ] {
        for _ in 0..400 {
            let mut bytes = original.clone();
            for _ in 0..1 + rng.below(8) {
                let at = rng.below(bytes.len());
                bytes[at] = rng.next() as u8;
            }
            if rng.below(4) == 0 {
                bytes.truncate(rng.below(bytes.len()));
            }
            if let Ok(found) = detect_bytes(&bytes) {
                assert_eq!(found, format);
            }
        }
    }
}

// ---- 경로 검사와 확장자 정책 ----

fn open(path: &str) -> Result<Format, DocumentError> {
    identify(path, &Limits::default()).map(|file| file.format)
}

fn path_str(path: &std::path::Path) -> &str {
    path.to_str().unwrap()
}

#[test]
fn 경로_문자열을_검사한다() {
    let invalid = |reason| Err(DocumentError::InvalidPath { reason });
    assert_eq!(open(""), invalid(PathProblem::Empty));
    assert_eq!(open("relative/a.docx"), invalid(PathProblem::Relative));
    assert_eq!(open("a.docx"), invalid(PathProblem::Relative));
    assert_eq!(open("/tmp/a\0.docx"), invalid(PathProblem::ContainsNul));
    assert_eq!(
        open(&format!("/{}", "a".repeat(5000))),
        invalid(PathProblem::TooLong)
    );
}

#[test]
fn 파일을_읽을_수_없는_경우를_구별한다() {
    let dir = TempDir::new();
    let missing = dir.path().join("missing.docx");
    assert_eq!(
        open(path_str(&missing)),
        Err(DocumentError::Unreadable {
            reason: ReadProblem::NotFound
        })
    );
    let folder = dir.path().join("folder.docx");
    std::fs::create_dir(&folder).unwrap();
    assert_eq!(
        open(path_str(&folder)),
        Err(DocumentError::Unreadable {
            reason: ReadProblem::NotAFile
        })
    );
    let empty = dir.write("empty.hwp", b"");
    assert_eq!(open(path_str(&empty)), parse(None, ParseProblem::Empty));
}

#[cfg(unix)]
#[test]
fn 권한이_없거나_특수_파일이면_읽지_않는다() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new();
    let fifo = dir.path().join("pipe.docx");
    let name = std::ffi::CString::new(path_str(&fifo)).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert_eq!(
        open(path_str(&fifo)),
        Err(DocumentError::Unreadable {
            reason: ReadProblem::NotAFile
        })
    );

    let locked = dir.write("locked.docx", &docx());
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::File::open(&locked).is_err() {
        assert_eq!(
            open(path_str(&locked)),
            Err(DocumentError::Unreadable {
                reason: ReadProblem::PermissionDenied
            })
        );
    } // root로 실행하면 권한 검사가 적용되지 않아 확인할 수 없다
}

#[cfg(unix)]
#[test]
fn 심볼릭_링크는_실제_파일의_이름과_내용으로_판단한다() {
    let dir = TempDir::new();
    let target = dir.write("real.hwpx", &hwpx());
    let link = dir.path().join("link.docx");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let file = identify(path_str(&link), &Limits::default()).unwrap();
    assert_eq!(file.format, Format::Hwpx);
    assert_eq!(file.display_name, "real.hwpx");

    let dangling = dir.path().join("dangling.docx");
    std::os::unix::fs::symlink(dir.path().join("nothing.docx"), &dangling).unwrap();
    assert_eq!(
        open(path_str(&dangling)),
        Err(DocumentError::Unreadable {
            reason: ReadProblem::NotFound
        })
    );
    let to_dir = dir.path().join("dir.hwp");
    std::os::unix::fs::symlink(dir.path(), &to_dir).unwrap();
    assert_eq!(
        open(path_str(&to_dir)),
        Err(DocumentError::Unreadable {
            reason: ReadProblem::NotAFile
        })
    );
}

#[test]
fn 확장자_정책() {
    let dir = TempDir::new();
    for (name, bytes, format) in [
        ("a.hwp", hwp(), Format::Hwp),
        ("b.HWPX", hwpx(), Format::Hwpx),
        ("c.Docx", docx(), Format::Docx),
    ] {
        assert_eq!(
            open(path_str(&dir.write(name, &bytes))),
            Ok(format),
            "{name}"
        );
    }
    // 이름을 바꾼 올바른 문서: 내용대로 다시 해석하지 않고 불일치로 거부
    let mismatch =
        |declared, detected| Err(DocumentError::ExtensionMismatch { declared, detected });
    assert_eq!(
        open(path_str(&dir.write("renamed.docx", &hwpx()))),
        mismatch(Format::Docx, Format::Hwpx)
    );
    assert_eq!(
        open(path_str(&dir.write("renamed.hwp", &docx()))),
        mismatch(Format::Hwp, Format::Docx)
    );
    assert_eq!(
        open(path_str(&dir.write("renamed.hwpx", &hwp()))),
        mismatch(Format::Hwpx, Format::Hwp)
    );
    // 지원하지 않는 확장자는 내용이 올바른 문서여도 읽지 않는다
    for name in ["doc.zip", "noextension", "x.doc", "x.hwp.txt", ".docx"] {
        assert_eq!(
            open(path_str(&dir.write(name, &docx()))),
            unsupported(UnsupportedKind::Extension),
            "{name}"
        );
    }
    // 지원 확장자에 다른 내용
    assert_eq!(
        open(path_str(&dir.write("text.docx", b"hello"))),
        unsupported(UnsupportedKind::Unknown)
    );
    assert_eq!(
        open(path_str(&dir.write("cut.docx", &docx()[..40]))),
        parse(None, ParseProblem::Truncated)
    );
}

#[test]
fn 파일_크기_상한() {
    let dir = TempDir::new();
    let path = dir.write("big.docx", &docx());
    let limits = Limits {
        max_file_bytes: 100,
        ..Limits::default()
    };
    assert_eq!(
        identify(path_str(&path), &limits).map(|file| file.format),
        Err(DocumentError::ResourceLimit {
            limit: LimitKind::FileSize
        })
    );
}

// ---- 세션 ----

fn identified(dir: &TempDir, name: &str, bytes: &[u8]) -> super::open::IdentifiedFile {
    identify(path_str(&dir.write(name, bytes)), &Limits::default()).unwrap()
}

#[test]
fn 세션마다_고유한_id와_형식별_엔진을_가진다() {
    let dir = TempDir::new();
    let registry = SessionRegistry::default();
    let a = registry
        .register(identified(&dir, "a.hwp", &hwp()))
        .unwrap();
    let b = registry
        .register(identified(&dir, "b.hwpx", &hwpx()))
        .unwrap();
    let c = registry
        .register(identified(&dir, "c.docx", &docx()))
        .unwrap();
    assert_eq!([a.session_id, b.session_id, c.session_id], [1, 2, 3]);
    assert_eq!(
        [a.engine, b.engine, c.engine],
        [Engine::Rhwp, Engine::Rhwp, Engine::Wordcraft]
    );
    for info in [&a, &b, &c] {
        assert_eq!(info.revision, 0);
        assert_eq!(info.state, SessionState::Identified);
    }
    assert_eq!(c.display_name, "c.docx");
    assert_eq!(
        registry.list().unwrap(),
        vec![a.clone(), b.clone(), c.clone()]
    );
    assert_eq!(registry.get(2).unwrap(), b);
}

#[test]
fn 하나를_닫아도_다른_세션은_그대로이고_닫힌_id는_다시_쓰지_않는다() {
    let dir = TempDir::new();
    let registry = SessionRegistry::default();
    let a = registry
        .register(identified(&dir, "a.docx", &docx()))
        .unwrap();
    let b = registry
        .register(identified(&dir, "b.docx", &docx()))
        .unwrap();
    assert_eq!(
        registry.close(a.session_id),
        Ok(CloseOutcome {
            session_id: a.session_id,
            already_closed: false
        })
    );
    assert_eq!(registry.get(b.session_id), Ok(b.clone()));
    assert_eq!(
        registry.get(a.session_id),
        Err(DocumentError::StaleSession {
            session_id: a.session_id
        })
    );
    assert_eq!(
        registry.close(a.session_id),
        Ok(CloseOutcome {
            session_id: a.session_id,
            already_closed: true
        })
    );
    for unknown in [0, 3, 99, u64::MAX] {
        assert_eq!(
            registry.get(unknown),
            Err(DocumentError::UnknownSession {
                session_id: unknown
            })
        );
        assert_eq!(
            registry.close(unknown),
            Err(DocumentError::UnknownSession {
                session_id: unknown
            })
        );
    }
    // 닫은 파일을 다시 열면 새 ID를 받는다.
    let again = registry
        .register(identified(&dir, "a.docx", &docx()))
        .unwrap();
    assert_eq!(again.session_id, 3);
    assert_eq!(
        registry
            .list()
            .unwrap()
            .iter()
            .map(|info| info.session_id)
            .collect::<Vec<_>>(),
        vec![2, 3]
    );
}

#[test]
fn 같은_파일은_두_번_열지_않는다() {
    let dir = TempDir::new();
    let registry = SessionRegistry::default();
    let first = registry
        .register(identified(&dir, "a.docx", &docx()))
        .unwrap();
    let again = identify(path_str(&dir.path().join("a.docx")), &Limits::default()).unwrap();
    assert_eq!(
        registry.register(again),
        Err(DocumentError::AlreadyOpen {
            session_id: first.session_id
        })
    );
    #[cfg(unix)]
    {
        let link = dir.path().join("hard.docx");
        std::fs::hard_link(dir.path().join("a.docx"), &link).unwrap();
        let hard = identify(path_str(&link), &Limits::default()).unwrap();
        assert_eq!(
            registry.register(hard),
            Err(DocumentError::AlreadyOpen {
                session_id: first.session_id
            })
        );
    }
    assert_eq!(registry.list().unwrap().len(), 1);
}

#[test]
fn 세션_수_상한() {
    let dir = TempDir::new();
    let registry = SessionRegistry::new(2);
    registry
        .register(identified(&dir, "a.docx", &docx()))
        .unwrap();
    registry
        .register(identified(&dir, "b.docx", &docx()))
        .unwrap();
    assert_eq!(
        registry.register(identified(&dir, "c.docx", &docx())),
        Err(DocumentError::ResourceLimit {
            limit: LimitKind::SessionCount
        })
    );
    registry.close(1).unwrap();
    assert_eq!(
        registry
            .register(identified(&dir, "c.docx", &docx()))
            .unwrap()
            .session_id,
        3
    );
}

#[test]
fn 판별에_실패한_열기는_세션을_남기지_않는다() {
    let dir = TempDir::new();
    let registry = SessionRegistry::default();
    for (name, bytes) in [
        ("bad.docx", b"nope".to_vec()),
        ("cut.hwpx", hwpx()[..50].to_vec()),
        ("x.hwp", docx()),
    ] {
        let path = dir.write(name, &bytes);
        assert!(identify(path_str(&path), &Limits::default())
            .and_then(|file| registry.register(file))
            .is_err());
    }
    assert_eq!(registry.list().unwrap(), vec![]);
    // 실패는 ID를 쓰지 않으므로 첫 성공이 1이다.
    assert_eq!(
        registry
            .register(identified(&dir, "ok.docx", &docx()))
            .unwrap()
            .session_id,
        1
    );
}

#[test]
fn 동시에_열어도_id가_겹치지_않고_같은_파일은_하나만_등록된다() {
    let dir = Arc::new(TempDir::new());
    for i in 0..8 {
        dir.write(&format!("d{i}.docx"), &docx());
    }
    dir.write("same.hwpx", &hwpx());
    let registry = Arc::new(SessionRegistry::default());
    let threads: Vec<_> = (0..16)
        .map(|i| {
            let (dir, registry) = (dir.clone(), registry.clone());
            std::thread::spawn(move || {
                let name = if i < 8 {
                    format!("d{i}.docx")
                } else {
                    "same.hwpx".to_owned()
                };
                let file = identify(path_str(&dir.path().join(name)), &Limits::default()).unwrap();
                registry.register(file)
            })
        })
        .collect();
    let results: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    let mut ids: Vec<_> = results
        .iter()
        .filter_map(|result| result.as_ref().ok())
        .map(|info| info.session_id)
        .collect();
    ids.sort();
    assert_eq!(ids, (1..=9).collect::<Vec<_>>()); // 서로 다른 8개 + 같은 파일 1개
    let duplicates = results
        .iter()
        .filter(|result| matches!(result, Err(DocumentError::AlreadyOpen { .. })))
        .count();
    assert_eq!(duplicates, 7);
}

// ---- T006 안정화: 리뷰 지적 A~D 회귀 ----

const ODF_MANIFEST: &str = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0";
const OPC_RELATIONSHIPS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const OPC_CONTENT_TYPES: &str = "http://schemas.openxmlformats.org/package/2006/content-types";

fn hwpx_with(name: &str, item: ZipEntry) -> Vec<u8> {
    let mut entries: Vec<_> = hwpx_entries()
        .into_iter()
        .filter(|entry| entry.name != name)
        .collect();
    entries.push(item);
    zip(&entries, false)
}

fn hwpx_manifest(manifest: &[u8]) -> Result<Format, DocumentError> {
    detect_bytes(&hwpx_with(
        "META-INF/manifest.xml",
        entry("META-INF/manifest.xml", manifest),
    ))
}

fn utf16(text: &str, little: bool) -> Vec<u8> {
    let mut bytes = if little {
        vec![0xFF, 0xFE]
    } else {
        vec![0xFE, 0xFF]
    };
    bytes.extend(text.encode_utf16().flat_map(|unit| {
        if little {
            unit.to_le_bytes()
        } else {
            unit.to_be_bytes()
        }
    }));
    bytes
}

/// A: 암호화 표식은 ODF manifest 이름공간의 `encryption-data` 요소일 때만 인정한다(부분 문자열이 아님).
#[test]
fn hwpx_manifest의_암호화_요소만_암호화로_본다() {
    let encrypted = Err(DocumentError::Encrypted {
        format: Some(Format::Hwpx),
    });
    let genuine = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><odf:manifest xmlns:odf="{ODF_MANIFEST}"><odf:file-entry full-path="Contents/header.xml" media-type="text/xml"><odf:encryption-data checksum-type="sha256-1k" checksum="AA=="><odf:algorithm algorithm-name="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/></odf:encryption-data></odf:file-entry></odf:manifest>"#
    );
    assert_eq!(hwpx_manifest(genuine.as_bytes()), encrypted);
    // 접두사가 달라도(LibreOffice식 `manifest:`, 기본 이름공간) 같은 요소다.
    for variant in [
        format!(
            r#"<manifest:manifest xmlns:manifest="{ODF_MANIFEST}"><manifest:file-entry manifest:full-path="a"><manifest:encryption-data/></manifest:file-entry></manifest:manifest>"#
        ),
        format!(
            r#"<manifest xmlns="{ODF_MANIFEST}"><file-entry full-path="a"><encryption-data/></file-entry></manifest>"#
        ),
    ] {
        assert_eq!(hwpx_manifest(variant.as_bytes()), encrypted, "{variant}");
    }
    // UTF-8 BOM, UTF-16 LE/BE로 쓴 manifest도 같은 결과(원래 부분 문자열 검사는 UTF-16을 놓침)
    let mut bom = b"\xEF\xBB\xBF".to_vec();
    bom.extend(genuine.as_bytes());
    assert_eq!(hwpx_manifest(&bom), encrypted);
    let genuine16 = genuine.replace("UTF-8", "UTF-16");
    assert_eq!(hwpx_manifest(&utf16(&genuine16, true)), encrypted);
    assert_eq!(hwpx_manifest(&utf16(&genuine16, false)), encrypted);

    // 주석·텍스트·속성·CDATA·다른 이름공간의 같은 이름은 암호화 표식이 아니다.
    for incidental in [
        format!(
            r#"<odf:manifest xmlns:odf="{ODF_MANIFEST}"><!-- encryption-data --><odf:file-entry full-path="Contents/header.xml"/></odf:manifest>"#
        ),
        format!(
            r#"<odf:manifest xmlns:odf="{ODF_MANIFEST}"><odf:file-entry full-path="encryption-data.xml" media-type="encryption-data"/></odf:manifest>"#
        ),
        format!(
            r#"<odf:manifest xmlns:odf="{ODF_MANIFEST}" xmlns:x="urn:example" x:encryption-data="1"><odf:file-entry full-path="a"/></odf:manifest>"#
        ),
        format!(
            r#"<odf:manifest xmlns:odf="{ODF_MANIFEST}"><x:note xmlns:x="urn:example">encryption-data</x:note></odf:manifest>"#
        ),
        format!(
            r#"<odf:manifest xmlns:odf="{ODF_MANIFEST}"><x:note xmlns:x="urn:example"><![CDATA[<odf:encryption-data/>]]></x:note></odf:manifest>"#
        ),
        format!(
            r#"<odf:manifest xmlns:odf="{ODF_MANIFEST}"><x:encryption-data xmlns:x="urn:example"/></odf:manifest>"#
        ),
    ] {
        assert_eq!(
            hwpx_manifest(incidental.as_bytes()),
            Ok(Format::Hwpx),
            "{incidental}"
        );
    }
    assert_eq!(
        hwpx_manifest(format!(r#"<odf:manifest xmlns:odf="{ODF_MANIFEST}"/>"#).as_bytes()),
        Ok(Format::Hwpx)
    );

    // 읽을 수 없는 manifest는 암호화 여부를 판단할 수 없으므로 통과시키지 않는다(구조 오류).
    let invalid = parse(Some(Format::Hwpx), ParseProblem::InvalidPart);
    for malformed in [
        format!(r#"<odf:manifest xmlns:odf="{ODF_MANIFEST}"><odf:file-entry full-path="a">"#),
        format!(r#"<odf:manifest xmlns:odf="{ODF_MANIFEST}"></odf:file-entry>"#),
        "<odf:manifest><odf:file-entry><odf:encryption-data/></odf:file-entry></odf:manifest>"
            .to_owned(), // 접두사 선언 없음
        r#"<manifest xmlns="urn:example"><file-entry/></manifest>"#.to_owned(), // ODF manifest가 아님
        format!(
            r#"<?xml version="1.0" encoding="ISO-8859-1"?><odf:manifest xmlns:odf="{ODF_MANIFEST}"/>"#
        ),
        format!(
            r#"<odf:manifest xmlns:odf="{ODF_MANIFEST}"/><odf:manifest xmlns:odf="{ODF_MANIFEST}"/>"#
        ),
        String::new(),
    ] {
        assert_eq!(hwpx_manifest(malformed.as_bytes()), invalid, "{malformed}");
    }
    assert_eq!(hwpx_manifest(&[0xFF, 0xFE, 0x3C]), invalid); // 홀수 길이 UTF-16
                                                             // 크기 상한은 그대로다.
    let mut huge = format!(r#"<odf:manifest xmlns:odf="{ODF_MANIFEST}">"#).into_bytes();
    huge.resize(2 * 1024 * 1024, b' ');
    assert_eq!(
        hwpx_manifest(&huge),
        Err(DocumentError::ResourceLimit {
            limit: LimitKind::PartSize
        })
    );
}

/// B: DOCX로 인정하기 전에 패키지의 모든 항목에서 ZIP 암호화 플래그를 확인한다.
#[test]
fn docx의_어느_항목이든_zip_암호화면_암호화_문서다() {
    let encrypted = Err(DocumentError::Encrypted {
        format: Some(Format::Docx),
    });
    for (name, data) in [
        ("word/media/image1.png", &b"\x89PNG"[..]),
        ("docProps/core.xml", b"<cp:coreProperties/>"),
        ("word/_rels/document.xml.rels", b"<Relationships/>"),
    ] {
        let mut entries = docx_entries();
        let mut extra = entry(name, data);
        extra.flags = 1;
        entries.push(extra);
        assert_eq!(detect_bytes(&zip(&entries, false)), encrypted, "{name}");
        assert_eq!(
            detect_bytes(&zip(&entries, true)),
            encrypted,
            "{name} zip64"
        );
    }
    // 읽는 항목의 로컬 헤더와 중앙 디렉터리의 암호화 비트가 다르면 손상으로 본다.
    let mut local_only = docx_entries();
    local_only[0].local_flags = Some(1);
    assert_eq!(
        detect_bytes(&zip(&local_only, false)),
        parse(None, ParseProblem::CorruptContainer)
    );
    // 읽지 않는 항목은 중앙 디렉터리 플래그로 판단한다(엔진의 ZIP 판독기도 중앙 디렉터리를 따른다).
    let mut unread_local_only = docx_entries();
    let mut media = entry("word/media/image1.png", b"\x89PNG");
    media.local_flags = Some(1);
    unread_local_only.push(media);
    assert_eq!(
        detect_bytes(&zip(&unread_local_only, false)),
        Ok(Format::Docx)
    );
    // DOCX가 아닌 패키지는 암호화 항목이 있어도 형식 판정을 바꾸지 않는다.
    let mut xlsx = vec![
        entry(
            "[Content_Types].xml",
            content_types(
                "xl/workbook.xml",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
            )
            .as_bytes(),
        ),
        entry("_rels/.rels", package_rels("xl/workbook.xml").as_bytes()),
        entry("xl/workbook.xml", b"<x/>"),
    ];
    xlsx[2].flags = 1;
    assert_eq!(
        detect_bytes(&zip(&xlsx, false)),
        unsupported(UnsupportedKind::OtherOoxml)
    );
    let mut other = entry("readme.txt", b"x");
    other.flags = 1;
    assert_eq!(
        detect_bytes(&zip(&[other], false)),
        unsupported(UnsupportedKind::OtherZip)
    );
    assert_eq!(detect_bytes(&docx()), Ok(Format::Docx));
}

/// C: HWPX 필수 항목(content.hpf, header.xml)은 있기만 하면 안 되고 압축 해제·크기·CRC가 맞아야 한다.
#[test]
fn hwpx_필수_항목의_손상을_거부한다() {
    let corrupt = parse(Some(Format::Hwpx), ParseProblem::CorruptContainer);
    for name in ["Contents/content.hpf", "Contents/header.xml"] {
        let original = hwpx_entries()
            .into_iter()
            .find(|item| item.name == name)
            .unwrap();
        let mut crc = original.clone();
        crc.crc = Some(0x1234_5678);
        assert_eq!(detect_bytes(&hwpx_with(name, crc)), corrupt, "{name} crc");
        let mut garbage = original.clone();
        garbage.body = Some(vec![0xFF; 40]); // 올바른 deflate 스트림이 아님
        assert_eq!(
            detect_bytes(&hwpx_with(name, garbage)),
            corrupt,
            "{name} deflate"
        );
        let mut larger = original.clone();
        larger.declared_size = Some(original.data.len() as u32 + 7);
        assert_eq!(
            detect_bytes(&hwpx_with(name, larger)),
            corrupt,
            "{name} size+"
        );
        let mut smaller = original.clone();
        smaller.declared_size = Some(3);
        assert_eq!(
            detect_bytes(&hwpx_with(name, smaller)),
            corrupt,
            "{name} size-"
        );
        let mut local = original.clone();
        local.local_name = Some(name.replace("Contents", "Contentz"));
        assert_eq!(
            detect_bytes(&hwpx_with(name, local)),
            corrupt,
            "{name} local"
        );
        let mut method = stored(name, &original.data);
        method.body = Some(original.data[..original.data.len() - 1].to_vec());
        assert_eq!(
            detect_bytes(&hwpx_with(name, method)),
            corrupt,
            "{name} stored"
        );
    }
    // content.hpf는 OPF 패키지 문서여야 한다(주 패키지 표식). header.xml의 XML 내용은 엔진이 검사한다.
    let invalid = parse(Some(Format::Hwpx), ParseProblem::InvalidPart);
    for hpf in [
        "<opf:package xmlns:opf=\"http://www.idpf.org/2007/opf/\">",
        "<package/>",
        "<x:package xmlns:x=\"urn:example\"/>",
        "not xml",
    ] {
        assert_eq!(
            detect_bytes(&hwpx_with(
                "Contents/content.hpf",
                entry("Contents/content.hpf", hpf.as_bytes())
            )),
            invalid,
            "{hpf}"
        );
    }
    assert_eq!(
        detect_bytes(&hwpx_with(
            "Contents/content.hpf",
            entry(
                "Contents/content.hpf",
                b"<package xmlns=\"http://www.idpf.org/2007/opf\" version=\"2.0\"><manifest/><spine/></package>"
            )
        )),
        Ok(Format::Hwpx)
    );
    // 실제 문서의 header.xml은 1 MiB를 넘을 수 있다(rhwp 표본 최대 약 3.2 MB). 스트림으로 확인하므로 받아들인다.
    let mut big_header = b"<hh:head xmlns:hh=\"http://www.hancom.co.kr/hwpml/2011/head\">".to_vec();
    big_header.resize(3 * 1024 * 1024, b' ');
    big_header.extend(b"</hh:head>");
    assert_eq!(
        detect_bytes(&hwpx_with(
            "Contents/header.xml",
            entry("Contents/header.xml", &big_header)
        )),
        Ok(Format::Hwpx)
    );
    // 선언 크기를 속인 압축 폭탄은 선언 크기 너머로 풀지 않고 손상으로 거부한다.
    let mut bomb = entry("Contents/header.xml", &vec![b' '; 3 * 1024 * 1024]);
    bomb.declared_size = Some(100);
    assert_eq!(
        detect_bytes(&hwpx_with("Contents/header.xml", bomb)),
        corrupt
    );
    // 선언 크기가 확인 상한을 넘으면 풀지 않고 거부한다.
    let mut declared_huge = entry("Contents/header.xml", b"<hh:head/>");
    declared_huge.declared_size = Some(u32::MAX - 1);
    assert_eq!(
        detect_bytes(&hwpx_with("Contents/header.xml", declared_huge)),
        Err(DocumentError::ResourceLimit {
            limit: LimitKind::PartSize
        })
    );
    // mimetype 없는 HWPX, ZIP64, 본문(section) 손상은 판별 범위 밖(엔진 몫)이라 그대로 인정한다.
    let without_mimetype: Vec<_> = hwpx_entries()
        .into_iter()
        .filter(|item| item.name != "mimetype")
        .collect();
    assert_eq!(
        detect_bytes(&zip(&without_mimetype, true)),
        Ok(Format::Hwpx)
    );
    let mut section = entry("Contents/section0.xml", b"<hs:sec/>");
    section.crc = Some(0);
    assert_eq!(
        detect_bytes(&hwpx_with("Contents/section0.xml", section)),
        Ok(Format::Hwpx)
    );
}

fn docx_with(name: &str, data: &str) -> Vec<u8> {
    let mut entries = docx_entries();
    for item in &mut entries {
        if item.name == name {
            *item = entry(name, data.as_bytes());
        }
    }
    zip(&entries, false)
}

fn rels(body: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="{OPC_RELATIONSHIPS}">{body}</Relationships>"#
    )
}

fn types(body: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="{OPC_CONTENT_TYPES}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>{body}</Types>"#
    )
}

/// D: OPC 관계·내용 형식 항목은 이름공간·루트·위치·중복을 확인한다.
#[test]
fn opc_관계와_내용_형식의_구조를_확인한다() {
    let invalid = parse(None, ParseProblem::InvalidPart);
    let main =
        format!(r#"<Relationship Id="rId1" Type="{OFFICE_DOCUMENT}" Target="word/document.xml"/>"#);
    let main_override =
        format!(r#"<Override PartName="/word/document.xml" ContentType="{DOCX_MAIN}"/>"#);
    assert_eq!(
        detect_bytes(&docx_with("_rels/.rels", &rels(&main))),
        Ok(Format::Docx)
    );
    assert_eq!(
        detect_bytes(&docx_with("[Content_Types].xml", &types(&main_override))),
        Ok(Format::Docx)
    );

    for bad_rels in [
        // 루트 이름공간이 없거나 다름
        format!(r#"<Relationships>{main}</Relationships>"#),
        format!(r#"<Relationships xmlns="urn:example">{main}</Relationships>"#),
        format!(r#"<Other xmlns="{OPC_RELATIONSHIPS}">{main}</Other>"#),
        // 관계가 루트의 자식이 아님, 다른 이름공간의 관계 요소, 모르는 자식
        rels(&format!(r#"<x:wrap xmlns:x="urn:example">{main}</x:wrap>"#)),
        rels(&format!(
            r#"<Relationship Id="rId9" Type="t" Target="a.xml">{main}</Relationship>"#
        )),
        format!(
            r#"<Relationships xmlns="{OPC_RELATIONSHIPS}"><r:Relationship xmlns:r="urn:example" Id="rId1" Type="{OFFICE_DOCUMENT}" Target="word/document.xml"/></Relationships>"#
        ),
        rels(&format!(r#"{main}<Extra/>"#)),
        rels(&format!(r#"{main}text"#)),
        // Id 없음·중복, 잘못된 TargetMode, 접두사가 붙은 Type
        rels(&format!(
            r#"<Relationship Type="{OFFICE_DOCUMENT}" Target="word/document.xml"/>"#
        )),
        rels(&format!(
            r#"{main}<Relationship Id="rId1" Type="t" Target="a.xml"/>"#
        )),
        rels(&format!(
            r#"<Relationship Id="rId1" Type="{OFFICE_DOCUMENT}" Target="word/document.xml" TargetMode="Elsewhere"/>"#
        )),
        rels(&format!(
            r#"<Relationship xmlns:x="urn:example" Id="rId1" x:Type="{OFFICE_DOCUMENT}" Target="word/document.xml"/>"#
        )),
        // 루트가 둘, DTD
        format!(r#"{}{}"#, rels(&main), rels("")),
        format!(
            r#"<!DOCTYPE Relationships><Relationships xmlns="{OPC_RELATIONSHIPS}">{main}</Relationships>"#
        ),
        format!(
            r#"<?xml version="1.0" encoding="windows-1252"?><Relationships xmlns="{OPC_RELATIONSHIPS}">{main}</Relationships>"#
        ),
    ] {
        assert_eq!(
            detect_bytes(&docx_with("_rels/.rels", &bad_rels)),
            invalid,
            "{bad_rels}"
        );
    }

    for bad_types in [
        format!(r#"<Types>{main_override}</Types>"#),
        format!(r#"<Types xmlns="urn:example">{main_override}</Types>"#),
        // 다른 이름공간의 Override, 모르는 자식, 중첩
        types(&format!(
            r#"<x:Override xmlns:x="urn:example" PartName="/word/document.xml" ContentType="{DOCX_MAIN}"/>"#
        )),
        types(&format!(r#"{main_override}<Extra/>"#)),
        types(&format!(
            r#"<Default Extension="xml" ContentType="application/xml">{main_override}</Default>"#
        )),
        // 같은 부분 이름의 Override 둘(대소문자 무시), 같은 확장자의 Default 둘
        types(&format!(
            r#"{main_override}<Override PartName="/WORD/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/>"#
        )),
        types(&format!(r#"{main_override}{main_override}"#)),
        types(&format!(
            r#"{main_override}<Default Extension="RELS" ContentType="application/xml"/>"#
        )),
        // 잘못된 부분 이름·빈 확장자
        types(&format!(
            r#"<Override PartName="word/document.xml" ContentType="{DOCX_MAIN}"/>"#
        )),
        types(&format!(
            r#"{main_override}<Default Extension="" ContentType="application/xml"/>"#
        )),
        format!(r#"<!DOCTYPE Types><Types xmlns="{OPC_CONTENT_TYPES}">{main_override}</Types>"#),
    ] {
        assert_eq!(
            detect_bytes(&docx_with("[Content_Types].xml", &bad_types)),
            invalid,
            "{bad_types}"
        );
    }

    // 확장자는 마지막 경로 조각에서만 찾는다(`word.d/document`에는 확장자가 없다).
    let mut odd = docx_entries();
    odd[0] = entry(
        "[Content_Types].xml",
        types(&format!(
            r#"<Default Extension="d/document" ContentType="{DOCX_MAIN}"/>"#
        ))
        .as_bytes(),
    );
    odd[1] = entry("_rels/.rels", package_rels("word.d/document").as_bytes());
    odd[2] = entry("word.d/document", b"<w:document/>");
    assert_eq!(detect_bytes(&zip(&odd, false)), invalid);

    // 올바른 변형: 접두사를 쓴 OPC 이름공간, Default로만 정한 본문 형식, Strict 관계 형식, UTF-16, ZIP64
    let prefixed_rels = format!(
        r#"<pr:Relationships xmlns:pr="{OPC_RELATIONSHIPS}"><pr:Relationship Id="rId1" Type="{OFFICE_DOCUMENT}" Target="/word/document.xml"/></pr:Relationships>"#
    );
    let prefixed_types = format!(
        r#"<ct:Types xmlns:ct="{OPC_CONTENT_TYPES}"><ct:Default Extension="xml" ContentType="{DOCX_MAIN}"/></ct:Types>"#
    );
    let mut entries = docx_entries();
    entries[0] = entry("[Content_Types].xml", prefixed_types.as_bytes());
    entries[1] = entry("_rels/.rels", prefixed_rels.as_bytes());
    assert_eq!(detect_bytes(&zip(&entries, false)), Ok(Format::Docx));
    let strict = rels(
        r#"<Relationship Id="rId1" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://example.invalid/ext" Target="https://example.invalid/" TargetMode="External"/>"#,
    );
    assert_eq!(
        detect_bytes(&docx_with("_rels/.rels", &strict)),
        Ok(Format::Docx)
    );
    let mut utf16_entries = docx_entries();
    utf16_entries[0] = entry(
        "[Content_Types].xml",
        &utf16(&types(&main_override).replace("UTF-8", "UTF-16"), true),
    );
    utf16_entries[1] = entry(
        "_rels/.rels",
        &utf16(&rels(&main).replace("UTF-8", "UTF-16"), false),
    );
    assert_eq!(detect_bytes(&zip(&utf16_entries, false)), Ok(Format::Docx));
    assert_eq!(detect_bytes(&zip(&utf16_entries, true)), Ok(Format::Docx));
}
