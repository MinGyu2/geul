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
        detect_bytes(&with_rels("<Relationships/>")),
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
        r#"<Relationships><Relationship Type="{OFFICE_DOCUMENT}" Target="word/document.xml"/><Relationship Type="{OFFICE_DOCUMENT}" Target="word/other.xml"/></Relationships>"#
    );
    assert_eq!(
        detect_bytes(&with_rels(&two)),
        parse(None, ParseProblem::InvalidPart)
    );
    let external = format!(
        r#"<Relationships><Relationship Type="{OFFICE_DOCUMENT}" Target="https://example.invalid/d.xml" TargetMode="External"/></Relationships>"#
    );
    assert_eq!(
        detect_bytes(&with_rels(&external)),
        parse(None, ParseProblem::InvalidPart)
    );

    let mut no_type = docx_entries();
    no_type[0] = entry("[Content_Types].xml", b"<Types/>");
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
    manifest.push(entry("META-INF/manifest.xml", b"<odf:manifest><odf:file-entry full-path=\"Contents/header.xml\"><odf:encryption-data/></odf:file-entry></odf:manifest>"));
    assert_eq!(
        detect_bytes(&zip(&manifest, false)),
        Err(DocumentError::Encrypted {
            format: Some(Format::Hwpx)
        })
    );
    let mut plain_manifest = hwpx_entries();
    plain_manifest.push(entry("META-INF/manifest.xml", b"<odf:manifest/>"));
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
