//! T009 저장 서비스 시험. 합성 컨테이너(HWP 레코드·OPC·HWPX)로 비교·검사 규칙을, 실제 WordCraft 엔진과 임시
//! 디렉터리로 열기→편집→사전 검사→저장→다시 열기 전체 경로와 실패 경로(원본 그대로)를 확인한다. rhwp 실제 엔진 왕복은
//! WASM이라 `tests/roundtrip/`(node + `save_check` 예제)와 실제 앱 시험에서 한다.

use std::future::Future;
use std::path::Path;

use serde_json::{json, Value};

use super::preserve::{Finding, FindingCode, Outcome, Preservation};
use super::publish::{Fault, FAULT};
use super::service::{self, SaveOutcome};
use super::{commands as frame, hwp, loss, package};
use crate::adapters::wordcraft::commands as docx;
use crate::adapters::wordcraft::engine::{DocxModel, DocxOp, MoveTarget};
use crate::adapters::wordcraft::tests::basic;
use crate::document::commands::DocumentState;
use crate::document::testutil::{
    cfb, content_types, entry, hwp_file_header, package_rels, stored, zip, TempDir, ZipEntry,
};
use crate::document::{
    identify, DocumentError, Format, IoProblem, Limits, SaveStage, SaveUnsupportedReason,
    SessionInfo, SessionState,
};

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

fn codes(findings: &[Finding]) -> Vec<FindingCode> {
    findings.iter().map(|f| f.code).collect()
}

// ---- 손실 보고 ----

fn report(format: &str, losses: Value) -> Value {
    let count = losses.as_array().map_or(0, Vec::len);
    json!({"schemaVersion": 1, "outputFormat": format, "count": count, "losses": losses})
}

#[test]
fn 손실_보고는_계약_모양의_0건만_통과하고_손실은_unsafe_모양이_다르면_unknown() {
    assert_eq!(loss::check(&report("hwp", json!([])), Format::Hwp), vec![]);
    assert_eq!(
        loss::check(&report("hwpx", json!([])), Format::Hwpx),
        vec![]
    );
    let lost = json!([{"code": "controlOmitted", "subject": "control", "path": "section0/para3/ctrl0", "reason": "unsupportedByOutputFormat"}]);
    let found = loss::check(&report("hwp", lost), Format::Hwp);
    assert_eq!(codes(&found), vec![FindingCode::LossReported]);
    assert_eq!(Preservation::from_findings(found).outcome, Outcome::Unsafe);
    let image = json!([{"code": "binaryContentEmptied", "subject": "binaryData", "path": "BinData/BIN0001.png", "reason": "resourceReadFailedOrLimitExceeded", "resourceId": 1}]);
    assert_eq!(
        codes(&loss::check(&report("hwpx", image), Format::Hwpx)),
        vec![FindingCode::LossReported]
    );
    let ok_loss = json!({"code": "metadataReduced", "subject": "fieldParameters", "path": "p", "reason": "unsupportedByOutputFormat"});
    let malformed = [
        json!(null),
        json!([]),
        json!({"schemaVersion": 2, "outputFormat": "hwp", "count": 0, "losses": []}),
        json!({"schemaVersion": 1, "outputFormat": "hwpx", "count": 0, "losses": []}), // 형식이 요청과 다름
        json!({"schemaVersion": 1, "outputFormat": "hwp", "count": 1, "losses": []}), // count 불일치
        json!({"schemaVersion": 1, "outputFormat": "hwp", "count": "0", "losses": []}),
        json!({"schemaVersion": 1, "outputFormat": "hwp", "count": 0.0, "losses": []}),
        json!({"schemaVersion": 1, "outputFormat": "hwp", "count": 0}),
        json!({"schemaVersion": 1, "outputFormat": "hwp", "count": 0, "losses": [], "extra": true}),
        json!({"schemaVersion": 1, "outputFormat": "hwp", "count": 1, "losses": [{"code": "somethingNew", "subject": "x", "path": "p", "reason": "r"}]}),
        json!({"schemaVersion": 1, "outputFormat": "hwp", "count": 1, "losses": [{"code": "controlOmitted", "subject": "x", "path": "p"}]}),
        json!({"schemaVersion": 1, "outputFormat": "hwp", "count": 1, "losses": [{"code": "controlOmitted", "subject": "x", "path": "p", "reason": "r", "resourceId": "1"}]}),
        json!({"schemaVersion": 1, "outputFormat": "hwp", "count": 1, "losses": [{"code": "controlOmitted", "subject": "x", "path": "p", "reason": "r", "more": 1}]}),
        json!({"schemaVersion": 1, "outputFormat": "hwp", "count": 2, "losses": [ok_loss.clone(), 5]}),
    ];
    for value in malformed {
        let found = loss::check(&value, Format::Hwp);
        assert_eq!(
            codes(&found),
            vec![FindingCode::LossReportInvalid],
            "{value}"
        );
        assert_eq!(Preservation::from_findings(found).outcome, Outcome::Unknown);
    }
    assert_eq!(
        codes(&loss::check(&report("hwp", json!([])), Format::Docx)),
        vec![FindingCode::LossReportInvalid]
    );
}

// ---- HWP 레코드 비교 ----

fn record(tag: u16, level: u16, payload: &[u8]) -> Vec<u8> {
    let head = u32::from(tag) | (u32::from(level) << 10) | ((payload.len() as u32) << 20);
    let mut out = head.to_le_bytes().to_vec();
    out.extend_from_slice(payload);
    out
}

/// 문서 속성(tag 16, 26바이트: 구역 수·시작 번호·캐럿) + 글꼴(tag 19) + 글자 모양 하나(tag 21)·문단 모양 하나(tag 25):
/// `section()`의 문단(모양 ID 0)이 가리킬 정의(T009 모양 참조 무결성).
fn docinfo(caret: u32, font: &[u8]) -> Vec<u8> {
    let mut properties = vec![1, 0];
    properties.extend_from_slice(&[1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    properties.extend_from_slice(&0u32.to_le_bytes());
    properties.extend_from_slice(&0u32.to_le_bytes());
    properties.extend_from_slice(&caret.to_le_bytes());
    [
        record(16, 0, &properties),
        record(19, 1, font),
        record(21, 1, b"char shape"),
        record(25, 1, b"para shape"),
    ]
    .concat()
}

fn section(text: &str) -> Vec<u8> {
    let utf16: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
    [record(66, 0, &[0; 22]), record(67, 1, &utf16)].concat()
}

/// 압축하지 않은 HWP 5(flags 0). `extra`는 그 밖의 스트림.
fn hwp_doc(flags: u32, docinfo: &[u8], body: &[u8], extra: &[(&str, &[u8])]) -> Vec<u8> {
    let header = hwp_file_header(5, flags);
    let mut streams: Vec<(&str, &[u8])> = vec![
        ("/FileHeader", &header),
        ("/DocInfo", docinfo),
        ("/BodyText/Section0", body),
    ];
    streams.extend_from_slice(extra);
    cfb(&streams)
}

#[test]
fn hwp_편집_없는_왕복은_레코드_수준에서_같을_때만_safe() {
    let original = hwp_doc(
        0,
        &docinfo(0, b"font"),
        &section("hello"),
        &[
            ("/PrvText", b"preview"),
            ("/BinData/BIN0001.png", b"\x89PNG data"),
        ],
    );
    assert_eq!(hwp::compare(&original, &original), vec![]);
    // 압축 플래그만 다른 출력: 레코드 스트림은 풀어서 같으면 같지만, 헤더 플래그는 다르고 비레코드 스트림(BinData)은
    // 한쪽만 압축된 바이트라 다르다(T009 안정화 D: 압축 여부가 스트림마다 정해지므로 풀어서 같다고 보지 않는다).
    let deflated = |data: &[u8]| crate::document::testutil::deflate(data);
    let (di, body) = (deflated(&docinfo(0, b"font")), deflated(&section("hello")));
    let compressed = hwp_doc(
        1,
        &di,
        &body,
        &[
            ("/PrvText", b"preview"),
            ("/BinData/BIN0001.png", &deflated(b"\x89PNG data")),
        ],
    );
    let found = hwp::compare(&original, &compressed);
    assert_eq!(
        found,
        vec![
            Finding::at(FindingCode::PartChanged, "FileHeader"),
            Finding::at(FindingCode::PartChanged, "BinData/BIN0001.png"),
        ],
        "FileHeader 플래그와 압축이 바뀐 BinData는 다르다"
    );
    // 레코드·스트림 차이.
    let cases: [(Vec<u8>, FindingCode, &str); 5] = [
        (
            hwp_doc(
                0,
                &docinfo(0, b"other"),
                &section("hello"),
                &[
                    ("/PrvText", b"preview"),
                    ("/BinData/BIN0001.png", b"\x89PNG data"),
                ],
            ),
            FindingCode::RecordsChanged,
            "DocInfo",
        ),
        (
            hwp_doc(
                0,
                &docinfo(7, b"font"),
                &section("hello"),
                &[
                    ("/PrvText", b"preview"),
                    ("/BinData/BIN0001.png", b"\x89PNG data"),
                ],
            ),
            FindingCode::RecordsChanged,
            "DocInfo",
        ),
        (
            hwp_doc(
                0,
                &docinfo(0, b"font"),
                &section("hello"),
                &[("/PrvText", b"preview")],
            ),
            FindingCode::PartMissing,
            "BinData/BIN0001.png",
        ),
        (
            hwp_doc(
                0,
                &docinfo(0, b"font"),
                &section("hello"),
                &[
                    ("/PrvText", b"other"),
                    ("/BinData/BIN0001.png", b"\x89PNG data"),
                ],
            ),
            FindingCode::PartChanged,
            "PrvText",
        ),
        (
            hwp_doc(
                0,
                &docinfo(0, b"font"),
                &section("hello"),
                &[
                    ("/PrvText", b"preview"),
                    ("/BinData/BIN0001.png", b"\x89PNG data"),
                    ("/Scripts/X", b"x"),
                ],
            ),
            FindingCode::PartAdded,
            "Scripts/X",
        ),
    ];
    for (output, code, part) in cases {
        let found = hwp::compare(&original, &output);
        assert_eq!(found, vec![Finding::at(code, part)]);
        assert_eq!(Preservation::from_findings(found).outcome, Outcome::Unsafe);
    }
}

#[test]
fn hwp_검사할_수_없는_원본은_unknown() {
    let good = hwp_doc(0, &docinfo(0, b"font"), &section("hello"), &[]);
    for flags in [0x02u32, 0x04, 0x10] {
        let protected = hwp_doc(flags, &docinfo(0, b"font"), &section("hello"), &[]);
        let verdict = Preservation::from_findings(hwp::compare(&protected, &good));
        assert_eq!(verdict.outcome, Outcome::Unknown, "flags {flags:#x}");
        assert_eq!(codes(&verdict.findings), vec![FindingCode::Unsupported]);
    }
    // 끊긴 레코드(머리가 선언한 길이보다 짧음).
    let mut broken = docinfo(0, b"font");
    broken.truncate(broken.len() - 2);
    let original = hwp_doc(0, &broken, &section("hello"), &[]);
    let verdict = Preservation::from_findings(hwp::compare(&original, &good));
    assert_eq!(
        verdict.findings,
        vec![Finding::at(FindingCode::OriginalMalformed, "DocInfo")]
    );
    assert_eq!(verdict.outcome, Outcome::Unknown);
    let verdict = Preservation::from_findings(hwp::compare(b"not a cfb", &good));
    assert_eq!(verdict.outcome, Outcome::Unknown);
}

#[test]
fn hwp_편집한_저장은_본문과_캐럿만_달라도_되고_그_밖은_원본과_같아야_한다() {
    let extra: [(&str, &[u8]); 1] = [("/BinData/BIN0001.png", b"\x89PNG data")];
    let original = hwp_doc(0, &docinfo(0, b"font"), &section("hello"), &extra);
    let edited = hwp_doc(0, &docinfo(42, b"font"), &section("hello, edited"), &extra);
    assert_eq!(hwp::compare_saved(&original, &edited), vec![]);
    // 편집 없는 비교는 캐럿·본문 차이도 다르다고 본다(사전 검사는 엄격).
    assert_eq!(
        codes(&hwp::compare(&original, &edited)),
        vec![FindingCode::RecordsChanged, FindingCode::RecordsChanged]
    );
    // 글꼴 레코드·그림·구역 수가 바뀌면 안 된다.
    let font = hwp_doc(0, &docinfo(42, b"changed"), &section("x"), &extra);
    assert_eq!(
        hwp::compare_saved(&original, &font),
        vec![Finding::at(FindingCode::RecordsChanged, "DocInfo")]
    );
    let image = hwp_doc(
        0,
        &docinfo(42, b"font"),
        &section("x"),
        &[("/BinData/BIN0001.png", b"\x89PNG other")],
    );
    assert_eq!(
        hwp::compare_saved(&original, &image),
        vec![Finding::at(FindingCode::PartChanged, "BinData/BIN0001.png")]
    );
    let mut sections = docinfo(42, b"font");
    sections[4] = 2; // 구역 수
    let sections = hwp_doc(0, &sections, &section("x"), &extra);
    assert_eq!(
        hwp::compare_saved(&original, &sections),
        vec![Finding::at(FindingCode::RecordsChanged, "DocInfo")]
    );
    // 본문을 레코드로 읽을 수 없는 출력.
    let mut body = section("x");
    body.truncate(body.len() - 1);
    let broken = hwp_doc(0, &docinfo(42, b"font"), &body, &extra);
    assert_eq!(
        hwp::compare_saved(&original, &broken),
        vec![Finding::at(
            FindingCode::OutputMalformed,
            "BodyText/Section0"
        )]
    );
}

// ---- ZIP·XML 패키지 비교 ----

fn pkg(entries: &[ZipEntry]) -> package::Package {
    package::open(&zip(entries, false), package::Side::Original).unwrap()
}

const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

#[test]
fn 패키지_비교는_접두사와_속성_순서는_무시하고_요소_속성_글자_부분의_차이는_잡는다() {
    let a = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="{W}"><w:body><w:p w:a="1" w:b="2"><w:t xml:space="preserve"> hi &amp; </w:t></w:p></w:body></w:document>"#
    );
    let same = format!(
        r#"<x:document xmlns:x="{W}" xmlns:unused="urn:unused"><x:body><x:p x:b="2" x:a="1"><x:t xml:space="preserve"> hi &#38; </x:t></x:p></x:body></x:document>"#
    );
    let original = pkg(&[
        entry("word/document.xml", a.as_bytes()),
        entry("media/a.png", b"png"),
    ]);
    assert_eq!(
        package::compare(
            &original,
            &pkg(&[
                entry("word/document.xml", same.as_bytes()),
                stored("media/a.png", b"png")
            ]),
            &|_| false
        ),
        vec![]
    );
    let changes = [
        format!(
            r#"<w:document xmlns:w="{W}"><w:body><w:p w:a="1"><w:t xml:space="preserve"> hi &amp; </w:t></w:p></w:body></w:document>"#
        ),
        format!(
            r#"<w:document xmlns:w="{W}"><w:body><w:p w:a="1" w:b="2"><w:t xml:space="preserve">hi &amp; </w:t></w:p></w:body></w:document>"#
        ),
        format!(
            r#"<w:document xmlns:w="{W}"><w:body><w:p w:a="1" w:b="2"/></w:body></w:document>"#
        ),
        r#"<w:document xmlns:w="urn:other"><w:body><w:p w:a="1" w:b="2"><w:t xml:space="preserve"> hi &amp; </w:t></w:p></w:body></w:document>"#
            .to_string(),
    ];
    for changed in changes {
        let output = pkg(&[
            entry("word/document.xml", changed.as_bytes()),
            entry("media/a.png", b"png"),
        ]);
        assert_eq!(
            package::compare(&original, &output, &|_| false),
            vec![Finding::at(FindingCode::PartChanged, "word/document.xml")],
            "{changed}"
        );
    }
    let output = pkg(&[
        entry("word/document.xml", a.as_bytes()),
        entry("media/a.png", b"PNG"),
    ]);
    assert_eq!(
        package::compare(&original, &output, &|_| false),
        vec![Finding::at(FindingCode::PartChanged, "media/a.png")]
    );
    let output = pkg(&[entry("word/document.xml", a.as_bytes())]);
    assert_eq!(
        package::compare(&original, &output, &|_| false),
        vec![Finding::at(FindingCode::PartMissing, "media/a.png")]
    );
    let output = pkg(&[
        entry("word/document.xml", a.as_bytes()),
        entry("media/a.png", b"png"),
        entry("customXml/item1.xml", b"<a/>"),
    ]);
    assert_eq!(
        package::compare(&original, &output, &|_| false),
        vec![Finding::at(FindingCode::PartAdded, "customXml/item1.xml")]
    );
}

#[test]
fn 끝까지_읽을_수_없는_원본_xml은_unknown이고_dtd도_받지_않는다() {
    let truncated = format!(r#"<w:document xmlns:w="{W}"><w:body><w:p><w:t>잘린"#);
    let doctype = r#"<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>"#;
    for broken in [truncated.as_str(), doctype, "<a></b>", "<a/><b/>", "<p:a/>"] {
        let original = pkg(&[entry("word/document.xml", broken.as_bytes())]);
        let found = package::malformed_xml(&original, package::Side::Original);
        assert_eq!(
            found,
            vec![Finding::at(
                FindingCode::OriginalMalformed,
                "word/document.xml"
            )],
            "{broken}"
        );
        assert_eq!(Preservation::from_findings(found).outcome, Outcome::Unknown);
    }
    let good = pkg(&[entry("word/document.xml", b"<a/>")]);
    let bad = pkg(&[entry("word/document.xml", b"<a>")]);
    assert_eq!(
        package::compare(&good, &bad, &|_| false),
        vec![Finding::at(
            FindingCode::OutputMalformed,
            "word/document.xml"
        )]
    );
    // 잘린 ZIP·암호화 항목.
    let bytes = zip(&[entry("a.xml", b"<a/>")], false);
    assert_eq!(
        package::open(&bytes[..bytes.len() - 10], package::Side::Original)
            .err()
            .map(|f| f.code),
        Some(FindingCode::OriginalMalformed)
    );
    let mut encrypted = entry("a.xml", b"<a/>");
    encrypted.flags = 1;
    assert_eq!(
        package::open(&zip(&[encrypted], false), package::Side::Original)
            .err()
            .map(|f| f.code),
        Some(FindingCode::Unsupported)
    );
}

const DOCX_MAIN: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

fn docx_package(
    document: &str,
    extra: Vec<ZipEntry>,
    document_rels: Option<&str>,
) -> Vec<ZipEntry> {
    let mut entries = vec![
        entry(
            "[Content_Types].xml",
            content_types("word/document.xml", DOCX_MAIN).as_bytes(),
        ),
        entry("_rels/.rels", package_rels("word/document.xml").as_bytes()),
        entry("word/document.xml", document.as_bytes()),
    ];
    if let Some(rels) = document_rels {
        entries.push(entry("word/_rels/document.xml.rels", rels.as_bytes()));
    }
    entries.extend(extra);
    entries
}

#[test]
fn docx_출력은_내용_형식과_관계_대상과_xml을_모두_검사한다() {
    let document = format!(r#"<w:document xmlns:w="{W}"><w:body><w:p/></w:body></w:document>"#);
    assert_eq!(
        package::validate_docx(&pkg(&docx_package(&document, vec![], None))),
        vec![]
    );
    // 관계 대상이 없는 부분.
    let rels = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="t" Target="styles.xml"/><Relationship Id="r2" Type="h" Target="https://example.invalid/" TargetMode="External"/></Relationships>"#;
    let found = package::validate_docx(&pkg(&docx_package(&document, vec![], Some(rels))));
    assert_eq!(
        found,
        vec![Finding::at(
            FindingCode::PackageInvalid,
            "word/_rels/document.xml.rels"
        )]
    );
    let styles = entry(
        "word/styles.xml",
        format!(r#"<w:styles xmlns:w="{W}"/>"#).as_bytes(),
    );
    assert_eq!(
        package::validate_docx(&pkg(&docx_package(&document, vec![styles], Some(rels)))),
        vec![]
    );
    // 내용 형식이 없는 부분(.bin은 Default도 Override도 없음).
    let found = package::validate_docx(&pkg(&docx_package(
        &document,
        vec![entry("word/media/x.bin", b"x")],
        None,
    )));
    assert_eq!(
        found,
        vec![Finding::at(FindingCode::PackageInvalid, "word/media/x.bin")]
    );
    // 패키지 밖을 가리키는 관계.
    let escape = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="t" Target="../../x.xml"/></Relationships>"#;
    assert_eq!(
        codes(&package::validate_docx(&pkg(&docx_package(
            &document,
            vec![],
            Some(escape)
        )))),
        vec![FindingCode::PackageInvalid]
    );
}

#[test]
fn docx_편집한_저장은_본문과_통계만_달라도_된다() {
    let app = |words: &str, extra: &str| {
        format!(
            r#"<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>WordCraft</Application><Words>{words}</Words><Paragraphs>2</Paragraphs>{extra}</Properties>"#
        )
    };
    let doc = |text: &str| {
        format!(
            r#"<w:document xmlns:w="{W}"><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>"#
        )
    };
    let styles = format!(r#"<w:styles xmlns:w="{W}"><w:style w:styleId="a"/></w:styles>"#);
    let make = |text: &str, words: &str, extra: &str, styles: &str| {
        pkg(&[
            entry("word/document.xml", doc(text).as_bytes()),
            entry("docProps/app.xml", app(words, extra).as_bytes()),
            entry("word/styles.xml", styles.as_bytes()),
        ])
    };
    let original = make("a", "1", "", &styles);
    assert_eq!(
        package::compare_saved_docx(&original, &make("a b c", "3", "", &styles)),
        vec![]
    );
    assert_eq!(
        package::compare_saved_docx(&original, &make("a", "1", "<Company>x</Company>", &styles)),
        vec![Finding::at(FindingCode::PartChanged, "docProps/app.xml")]
    );
    let other_styles = format!(r#"<w:styles xmlns:w="{W}"/>"#);
    assert_eq!(
        package::compare_saved_docx(&original, &make("a b", "2", "", &other_styles)),
        vec![Finding::at(FindingCode::PartChanged, "word/styles.xml")]
    );
}

const HWPX_HPF: &str = r#"<opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/></opf:manifest></opf:package>"#;

fn hwpx_package(
    section: &str,
    header: &str,
    mimetype_first: bool,
    mimetype_stored: bool,
) -> Vec<ZipEntry> {
    let mimetype = if mimetype_stored {
        stored("mimetype", b"application/hwp+zip")
    } else {
        entry("mimetype", b"application/hwp+zip")
    };
    let mut entries = vec![
        entry("Contents/content.hpf", HWPX_HPF.as_bytes()),
        entry("Contents/header.xml", header.as_bytes()),
        entry("Contents/section0.xml", section.as_bytes()),
    ];
    if mimetype_first {
        entries.insert(0, mimetype)
    } else {
        entries.push(mimetype)
    }
    entries
}

#[test]
fn hwpx_출력은_mimetype_첫_항목과_manifest를_검사하고_본문_밖은_원본과_같아야_한다() {
    let original = pkg(&hwpx_package("<sec><p>a</p></sec>", "<head/>", true, true));
    let edited = pkg(&hwpx_package(
        "<sec><p>a b</p><p>c</p></sec>",
        "<head/>",
        true,
        true,
    ));
    assert_eq!(package::validate_hwpx(&original, &edited), vec![]);
    assert_eq!(package::compare_saved_hwpx(&original, &edited), vec![]);
    let header = pkg(&hwpx_package(
        "<sec><p>a</p></sec>",
        "<head x=\"1\"/>",
        true,
        true,
    ));
    assert_eq!(
        package::compare_saved_hwpx(&original, &header),
        vec![Finding::at(FindingCode::PartChanged, "Contents/header.xml")]
    );
    for (first, stored) in [(false, true), (true, false)] {
        let output = pkg(&hwpx_package("<sec/>", "<head/>", first, stored));
        assert_eq!(
            package::validate_hwpx(&original, &output),
            vec![Finding::at(FindingCode::PackageInvalid, "mimetype")]
        );
    }
    let mut missing = hwpx_package("<sec/>", "<head/>", true, true);
    missing.retain(|e| e.name != "Contents/section0.xml");
    assert_eq!(
        package::validate_hwpx(&original, &pkg(&missing)),
        vec![Finding::at(
            FindingCode::PackageInvalid,
            "Contents/content.hpf"
        )]
    );
    assert!(package::hwpx_body("Contents/section12.xml"));
    assert!(
        !package::hwpx_body("Contents/section.xml")
            && !package::hwpx_body("Contents/header.xml")
            && !package::hwpx_body("Contents/sectionX.xml")
    );
}

// ---- 요청 프레임 ----

fn frame_bytes(
    session: u64,
    generation: u64,
    revision: u64,
    meta: &Value,
    payload: &[u8],
) -> Vec<u8> {
    let meta = serde_json::to_vec(meta).unwrap();
    let mut out = frame::FRAME_MAGIC.to_vec();
    for value in [session, generation, revision] {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    out.extend_from_slice(&meta);
    out.extend_from_slice(payload);
    out
}

#[test]
fn 저장_요청_프레임은_정확한_모양만_받는다() {
    let meta = json!({"a": 1});
    let parsed = frame::parse_frame(&frame_bytes(3, 2, 9, &meta, b"doc"), 100).unwrap();
    assert_eq!(
        (
            parsed.session_id,
            parsed.generation,
            parsed.revision,
            parsed.meta,
            parsed.payload
        ),
        (3, 2, 9, meta.clone(), b"doc".to_vec())
    );
    let mut bad_magic = frame_bytes(3, 2, 9, &meta, b"doc");
    bad_magic[0] = b'X';
    let mut long_meta = frame_bytes(3, 2, 9, &meta, b"doc");
    long_meta[28..32].copy_from_slice(&u32::MAX.to_le_bytes());
    for body in [
        bad_magic,
        long_meta,
        frame_bytes(3, 2, 9, &meta, b""),
        b"GSV1".to_vec(),
    ] {
        assert_eq!(
            frame::parse_frame(&body, 100).err(),
            Some(DocumentError::InvalidRequest)
        );
    }
    assert!(matches!(
        frame::parse_frame(&frame_bytes(3, 2, 9, &meta, &[0; 101]), 100),
        Err(DocumentError::ResourceLimit { .. })
    ));
    let reopen =
        json!({"formatEqual": true, "pagesEqual": true, "textEqual": true, "controlsEqual": true});
    assert!(frame::reopen_equal(&reopen));
    for bad in [
        json!({"formatEqual": true, "pagesEqual": true, "textEqual": false, "controlsEqual": true}),
        json!({"formatEqual": true, "pagesEqual": true, "textEqual": true}),
        json!({"formatEqual": true, "pagesEqual": true, "textEqual": true, "controlsEqual": true, "x": true}),
        json!({"formatEqual": "true", "pagesEqual": true, "textEqual": true, "controlsEqual": true}),
        json!(null),
    ] {
        assert!(!frame::reopen_equal(&bad), "{bad}");
    }
}

// ---- 실제 WordCraft 엔진: 열기 → 편집 → 사전 검사 → 저장 → 다시 열기 ----

struct Docx {
    state: DocumentState,
    dir: TempDir,
    path: std::path::PathBuf,
    info: SessionInfo,
}

fn open_docx(bytes: &[u8]) -> Docx {
    open_docx_prepared(bytes, |_| {})
}

/// 불러오기 전에 파일을 `prepare`(권한·링크·확장 속성)한 DOCX 세션.
fn open_docx_prepared(bytes: &[u8], prepare: impl FnOnce(&Path)) -> Docx {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let path = dir.write("a.docx", bytes);
    prepare(&path);
    let file = identify(path.to_str().unwrap(), &Limits::default()).unwrap();
    let info = state.registry().register(file).unwrap();
    let loaded = block_on(docx::load(&state, info.session_id, None)).expect("불러오기");
    Docx {
        state,
        dir,
        path,
        info: loaded.session,
    }
}

impl Docx {
    fn edit(&mut self, ops: Vec<DocxOp>) {
        let edited = block_on(docx::edit(
            &self.state,
            self.info.session_id,
            self.info.load_generation,
            self.info.revision,
            ops,
        ))
        .unwrap();
        self.info = edited.session;
    }
    fn preflight(&self) -> Result<service::SaveCheck, DocumentError> {
        block_on(docx::preflight(
            &self.state,
            self.info.session_id,
            self.info.load_generation,
        ))
    }
    fn save(&self) -> Result<SaveOutcome, DocumentError> {
        block_on(docx::save(
            &self.state,
            self.info.session_id,
            self.info.load_generation,
            self.info.revision,
        ))
    }
    fn bytes(&self) -> Vec<u8> {
        std::fs::read(&self.path).unwrap()
    }
    /// 원본 디렉터리에 남은 임시 파일(저장 실패 뒤 없어야 한다).
    fn leftovers(&self) -> Vec<String> {
        std::fs::read_dir(self.path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n != "a.docx")
            .collect()
    }
}

fn edits() -> Vec<DocxOp> {
    vec![
        DocxOp::InsertText {
            text: "저장 ".into(),
        },
        DocxOp::NewParagraph,
        DocxOp::Move {
            to: MoveTarget::DocEnd,
            extend: false,
        },
        DocxOp::InsertText {
            text: " 끝".into()
        },
    ]
}

#[test]
fn docx_대표_문서를_편집해_저장하면_다시_열어도_같고_dirty가_풀린다() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    doc.edit(edits());
    assert!(doc.info.dirty);
    let check = doc.preflight().unwrap();
    assert_eq!(
        check.preservation,
        Preservation {
            outcome: Outcome::Safe,
            findings: vec![]
        }
    );
    assert_eq!(check.platform_supported, cfg!(target_os = "linux"));
    let saved = doc.save().unwrap();
    assert_eq!(
        (saved.session.revision, saved.session.dirty),
        (doc.info.revision, false)
    );
    assert!(saved.durable);
    let written = doc.bytes();
    assert_ne!(written, original);
    assert_eq!(saved.bytes, written.len());
    assert!(doc.leftovers().is_empty());
    // 다시 연 파일이 편집한 모델과 같고(본문), 편집 밖 부분은 원본과 같다.
    let reopened = DocxModel::open(&written).unwrap();
    let mut model = DocxModel::open(&original).unwrap();
    model.apply(&edits());
    assert!(model.same_as(&written));
    assert!(reopened.body_text().starts_with("저장 \n한글 문단입니다."));
    let (a, b) = (
        package::open(&original, package::Side::Original).unwrap(),
        package::open(&written, package::Side::Output).unwrap(),
    );
    assert_eq!(package::compare_saved_docx(&a, &b), vec![]);
    // 저장한 파일이 새 원본: 사전 검사는 다시 해야 하고, 다시 하면 그 파일에 대해 safe다.
    let mut doc = doc;
    doc.info = saved.session;
    doc.edit(vec![DocxOp::InsertText {
        text: "둘째 ".into(),
    }]);
    assert!(
        matches!(doc.save(), Err(DocumentError::UnsafeSave { preservation }) if preservation.findings == vec![Finding::new(FindingCode::PreflightMissing)])
    );
    assert_eq!(doc.bytes(), written);
    assert!(doc.preflight().unwrap().preservation.is_safe());
    assert!(!doc.save().unwrap().session.dirty);
    let text = DocxModel::open(&doc.bytes()).unwrap().body_text();
    assert!(
        text.starts_with("저장 \n한글 문단입니다.") && text.contains("끝둘째 "),
        "{text}"
    );
}

#[test]
fn docx_사전_검사_없이_또는_보존이_안전하지_않으면_저장하지_않고_원본은_그대로다() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    doc.edit(edits());
    let error = doc.save().unwrap_err();
    assert!(
        matches!(&error, DocumentError::UnsafeSave { preservation } if preservation.outcome == Outcome::Unknown)
    );
    assert_eq!(doc.bytes(), original);
    // WordCraft가 모르는 표시·부분이 있는 Word식 패키지: 왕복에서 사라지므로 unsafe.
    let word = format!(
        r#"<w:document xmlns:w="{W}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body><w:p w:rsidR="00AB12CD" w14:paraId="1A2B3C4D"><w:r><w:t>Hello</w:t></w:r></w:p><w:sectPr/></w:body></w:document>"#
    );
    let wordlike = zip(
        &docx_package(
            &word,
            vec![entry(
                "customXml/item1.xml",
                b"<root xmlns=\"urn:x\"><v>1</v></root>",
            )],
            None,
        ),
        false,
    );
    let mut doc = open_docx(&wordlike);
    doc.edit(vec![DocxOp::InsertText { text: "x".into() }]);
    let check = doc.preflight().unwrap();
    assert_eq!(check.preservation.outcome, Outcome::Unsafe);
    assert!(check.preservation.findings.contains(&Finding::at(
        FindingCode::PartMissing,
        "customXml/item1.xml"
    )));
    assert!(check
        .preservation
        .findings
        .contains(&Finding::at(FindingCode::PartChanged, "word/document.xml")));
    assert!(
        matches!(doc.save(), Err(DocumentError::UnsafeSave { preservation }) if preservation.outcome == Outcome::Unsafe)
    );
    assert_eq!(doc.bytes(), wordlike);
    assert!(doc.leftovers().is_empty());
    assert!(doc.state.registry().get(doc.info.session_id).unwrap().dirty);
}

#[test]
fn docx_끊긴_본문_xml을_wordcraft가_일부만_읽어_열어도_보존은_unknown이고_저장하지_않는다() {
    let full = format!(
        r#"<w:document xmlns:w="{W}"><w:body><w:p><w:r><w:t>앞 문단</w:t></w:r></w:p><w:p><w:r><w:t>뒤 문단</w:t></w:r></w:p></w:body></w:document>"#
    );
    let cut = &full[..full.find("뒤").unwrap()];
    let truncated = zip(&docx_package(cut, vec![], None), false);
    let mut doc = open_docx(&truncated); // T008 J: WordCraft는 끊긴 곳까지 읽어 연다
    doc.edit(vec![DocxOp::InsertText { text: "x".into() }]);
    let check = doc.preflight().unwrap();
    assert_eq!(check.preservation.outcome, Outcome::Unknown);
    assert!(check.preservation.findings.contains(&Finding::at(
        FindingCode::OriginalMalformed,
        "word/document.xml"
    )));
    assert!(
        matches!(doc.save(), Err(DocumentError::UnsafeSave { preservation }) if preservation.outcome == Outcome::Unknown)
    );
    assert_eq!(doc.bytes(), truncated);
}

#[test]
fn docx_저장은_판_시도_세션이_지금_것이어야_한다() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    let (id, generation, revision) = (
        doc.info.session_id,
        doc.info.load_generation,
        doc.info.revision,
    );
    assert_eq!(
        block_on(docx::save(&doc.state, id, generation, revision - 1)).err(),
        Some(DocumentError::RevisionMismatch {
            session_id: id,
            revision
        })
    );
    assert_eq!(
        block_on(docx::save(&doc.state, id, generation + 1, revision)).err(),
        Some(DocumentError::StaleLoad {
            session_id: id,
            load_generation: generation
        })
    );
    assert_eq!(doc.bytes(), original);
    // 다시 불러오기(편집을 버림) 뒤 옛 시도의 저장은 StaleLoad.
    let reloaded = block_on(docx::load(&doc.state, id, Some(generation))).unwrap();
    assert_eq!(
        block_on(docx::save(&doc.state, id, generation, revision)).err(),
        Some(DocumentError::StaleLoad {
            session_id: id,
            load_generation: reloaded.session.load_generation
        })
    );
    // 닫은 세션.
    doc.state.registry().close(id).unwrap();
    assert_eq!(
        block_on(docx::save(
            &doc.state,
            id,
            reloaded.session.load_generation,
            0
        ))
        .err(),
        Some(DocumentError::StaleSession { session_id: id })
    );
    assert_eq!(doc.bytes(), original);
}

#[test]
fn 불러온_뒤_디스크의_파일이_바뀌면_사전_검사도_저장도_덮어쓰지_않는다() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    doc.edit(edits());
    // 사전 검사 전에 바뀜.
    std::fs::write(&doc.path, b"external").unwrap();
    assert_eq!(doc.preflight().err(), Some(DocumentError::FileConflict));
    assert_eq!(doc.bytes(), b"external");
    // 사전 검사 뒤, 같은 크기·수정 시각으로 내용만 바뀜(지문으로는 못 잡음 → 해시).
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    let metadata = std::fs::metadata(&doc.path).unwrap();
    let mut changed = original.clone();
    let last = changed.len() - 30;
    changed[last] ^= 0x01;
    std::fs::write(&doc.path, &changed).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&doc.path)
        .unwrap()
        .set_modified(metadata.modified().unwrap())
        .unwrap();
    assert_eq!(doc.save().err(), Some(DocumentError::FileConflict));
    assert_eq!(doc.bytes(), changed);
    assert!(doc.leftovers().is_empty());
}

// ---- 레지스트리 저장 프로토콜 ----

/// rhwp처럼 프런트엔드가 모델을 가진 세션(registry만): 불러오고 ready.
fn rhwp_session(state: &DocumentState, dir: &TempDir, name: &str, bytes: &[u8]) -> SessionInfo {
    let path = dir.write(name, bytes);
    let file = identify(path.to_str().unwrap(), &Limits::default()).unwrap();
    let info = state.registry().register(file).unwrap();
    let (generation, _) = block_on(state.load_bytes(info.session_id)).unwrap();
    state
        .registry()
        .transition(
            info.session_id,
            generation,
            SessionState::Loading,
            SessionState::Ready,
        )
        .unwrap()
}

#[test]
fn 저장은_세션마다_하나이고_표가_버려지면_다시_할_수_있다() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let original = hwp_doc(0, &docinfo(0, b"font"), &section("hello"), &[]);
    let info = rhwp_session(&state, &dir, "a.hwp", &original);
    let registry = state.registry();
    let (id, generation) = (info.session_id, info.load_generation);
    let ticket = registry.begin_save(id, generation, 0).unwrap();
    assert_eq!(
        registry.begin_save(id, generation, 0).err(),
        Some(DocumentError::SaveInProgress { session_id: id })
    );
    drop(ticket);
    let ticket = registry.begin_save(id, generation, 0).unwrap();
    // 저장 중의 편집 확정은 받는다(편집을 막지 않음). 저장이 끝나도 그 편집은 dirty로 남는다.
    let committed = registry.commit(id, generation, 0, 2).unwrap();
    assert!(committed.dirty);
    let finished = registry
        .finish_save(&ticket, 7, |identity, fingerprint| {
            Ok(crate::document::Published {
                identity: identity.clone(),
                fingerprint: *fingerprint,
                durable: true,
            })
        })
        .unwrap();
    assert_eq!((finished.revision, finished.dirty), (2, true));
    drop(ticket);
    // 교체가 실패하면 기록은 그대로이고 저장 중 표시도 풀린다.
    let ticket = registry.begin_save(id, generation, 2).unwrap();
    let before = registry.get(id).unwrap();
    assert_eq!(
        registry
            .finish_save(&ticket, 9, |_, _| Err(DocumentError::FileConflict))
            .err(),
        Some(DocumentError::FileConflict)
    );
    drop(ticket);
    assert_eq!(registry.get(id).unwrap(), before);
    assert!(registry.begin_save(id, generation, 2).is_ok());
}

#[test]
fn 저장_중_닫거나_다시_불러오거나_실패로_돌린_세션은_원본을_바꾸지_않는다() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let original = hwp_doc(0, &docinfo(0, b"font"), &section("hello"), &[]);
    let registry = state.registry();
    let publish_called = std::cell::Cell::new(false);
    let publish = |identity: &crate::document::FileIdentity,
                   fingerprint: &crate::document::FileFingerprint| {
        publish_called.set(true);
        Ok(crate::document::Published {
            identity: identity.clone(),
            fingerprint: *fingerprint,
            durable: true,
        })
    };
    // 닫힘.
    let info = rhwp_session(&state, &dir, "a.hwp", &original);
    let ticket = registry
        .begin_save(info.session_id, info.load_generation, 0)
        .unwrap();
    registry.close(info.session_id).unwrap();
    assert_eq!(
        registry.finish_save(&ticket, 1, publish).err(),
        Some(DocumentError::StaleSession {
            session_id: info.session_id
        })
    );
    // 편집 실패로 failed가 되고 다시 불러옴.
    let info = rhwp_session(&state, &dir, "b.hwp", &original);
    let ticket = registry
        .begin_save(info.session_id, info.load_generation, 0)
        .unwrap();
    registry
        .transition(
            info.session_id,
            info.load_generation,
            SessionState::Ready,
            SessionState::Failed,
        )
        .unwrap();
    assert!(matches!(
        registry.finish_save(&ticket, 1, publish),
        Err(DocumentError::InvalidState { .. })
    ));
    drop(ticket);
    let (generation, _) = block_on(state.load_bytes(info.session_id)).unwrap();
    assert!(matches!(
        registry.begin_save(info.session_id, info.load_generation, 0),
        Err(DocumentError::StaleLoad { .. })
    ));
    assert!(matches!(
        registry.begin_save(info.session_id, generation, 0),
        Err(DocumentError::InvalidState { .. })
    ));
    assert!(!publish_called.get());
}

// ---- 저장 실패 주입: 원본 그대로, 임시 파일 없음, 다시 저장하면 된다 ----

/// 편집한 DOCX와 그 출력(엔진 내보내기)을 준비해 서비스 저장을 이 스레드에서 부른다(실패 주입은 스레드 로컬).
fn save_with_fault(doc: &Docx, fault: Option<Fault>) -> Result<SaveOutcome, DocumentError> {
    let registry = doc.state.registry();
    let model = doc
        .state
        .wordcraft()
        .get(doc.info.session_id, doc.info.load_generation)
        .unwrap();
    let output = model.lock().unwrap().export().unwrap();
    let ticket = registry.begin_save(
        doc.info.session_id,
        doc.info.load_generation,
        doc.info.revision,
    )?;
    FAULT.with(|cell| cell.set(fault));
    let result = service::save(registry, &ticket, &Limits::default(), &output, None, true);
    FAULT.with(|cell| cell.set(None));
    result
}

#[test]
fn 쓰기_권한_공간_되읽기_교체_외부_수정_실패는_원본을_보존하고_임시_파일을_남기지_않는다() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    let io = |stage, problem| DocumentError::SaveFailure {
        stage,
        io: Some(problem),
    };
    let cases = [
        (
            Fault::Create(std::io::ErrorKind::PermissionDenied),
            io(SaveStage::Write, IoProblem::PermissionDenied),
        ),
        (
            Fault::Write(std::io::ErrorKind::StorageFull),
            io(SaveStage::Write, IoProblem::StorageFull),
        ),
        (
            Fault::Write(std::io::ErrorKind::ReadOnlyFilesystem),
            io(SaveStage::Write, IoProblem::ReadOnly),
        ),
        (
            Fault::Verify,
            DocumentError::SaveFailure {
                stage: SaveStage::Write,
                io: None,
            },
        ),
        (
            Fault::Rename(std::io::ErrorKind::Other),
            io(SaveStage::Publish, IoProblem::Other),
        ),
        (Fault::BeforePublish, DocumentError::FileConflict),
    ];
    for (fault, expected) in cases {
        assert_eq!(
            save_with_fault(&doc, Some(fault)).err(),
            Some(expected),
            "{fault:?}"
        );
        assert_eq!(doc.bytes(), original, "{fault:?}: 원본 그대로");
        assert!(
            doc.leftovers().is_empty(),
            "{fault:?}: 임시 파일 {:?}",
            doc.leftovers()
        );
        let info = doc.state.registry().get(doc.info.session_id).unwrap();
        assert!(info.dirty, "{fault:?}: 편집은 저장되지 않았다");
    }
    // 실패 뒤에도 저장 중 표시가 풀려 다시 저장된다.
    let saved = save_with_fault(&doc, None).unwrap();
    assert!(!saved.session.dirty);
    assert_ne!(doc.bytes(), original);
}

// 시험용 이름 원천(`with_names`)과 원본 교체는 Linux에서만 있다.
#[cfg(target_os = "linux")]
#[test]
fn 중단된_저장이_남긴_임시_파일은_지우거나_다시_쓰지_않고_원본만_바꾼다() {
    // 교체 전에 프로세스가 끝나면 `.geul-save-*.tmp`가 남을 수 있다(원본 그대로). 그 정리·복구는 T014이며, 다음 저장은 그 파일을
    // 지우거나 덮어쓰지 않는다(O_EXCL + 새 이름). 시험용 이름 원천으로 처음 네 후보가 정확히 남은 파일과 겹치게 한다.
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    let (saved, names) = with_names(
        &doc,
        |i| (i < 4).then_some(Squat::File(b"interrupted")),
        || save_with_fault(&doc, None),
    );
    let saved = saved.unwrap();
    assert!(!saved.session.dirty);
    assert_eq!(names.len(), 5, "네 번 겹치고 다섯 번째에 만듦");
    assert_ne!(doc.bytes(), original);
    // 남은 것은 미리 둔 네 파일뿐이고 내용도 그대로다.
    let mut left = doc.leftovers();
    left.sort();
    let mut squatted = names[..4].to_vec();
    squatted.sort();
    assert_eq!(left, squatted);
    assert!(left
        .iter()
        .all(|file| std::fs::read(doc.dir.path().join(file)).unwrap() == b"interrupted"));
}

#[cfg(target_os = "linux")]
#[test]
fn 실제_권한_하드_링크_심볼릭_링크와_권한_비트() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let original = basic::basic_ko().unwrap();
    // 쓸 수 없는 디렉터리(root로 실행하면 권한 검사가 없으므로 건너뛴다).
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    std::fs::set_permissions(doc.dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
    let probe = std::fs::File::create(doc.dir.path().join("probe"));
    if probe.is_err() {
        assert_eq!(
            doc.save().err(),
            Some(DocumentError::SaveFailure {
                stage: SaveStage::Write,
                io: Some(IoProblem::PermissionDenied)
            })
        );
        assert_eq!(doc.bytes(), original);
    } else {
        let _ = std::fs::remove_file(doc.dir.path().join("probe"));
    }
    std::fs::set_permissions(doc.dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    // 불러온 뒤 하드 링크가 생긴 파일: 링크 수가 지문과 달라 외부 변경으로 막는다(T009 안정화).
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    std::fs::hard_link(&doc.path, doc.dir.path().join("other.docx")).unwrap();
    assert_eq!(doc.save().err(), Some(DocumentError::FileConflict));
    assert_eq!(doc.bytes(), original);
    // 불러오기 전부터 하드 링크가 둘인 파일: 교체하면 다른 이름이 옛 내용을 가리키므로 막는다.
    let mut doc = open_docx_prepared(&original, |path| {
        std::fs::hard_link(path, path.with_extension("other")).unwrap()
    });
    doc.edit(edits());
    doc.preflight().unwrap();
    assert_eq!(
        doc.save().err(),
        Some(DocumentError::SaveUnsupported {
            reason: SaveUnsupportedReason::HardLink
        })
    );
    assert_eq!(doc.bytes(), original);
    // 심볼릭 링크로 연 파일: 대상 파일을 바꾸고 링크는 링크로 남는다. 권한 비트는 원본 그대로.
    let state = DocumentState::default();
    let dir = TempDir::new();
    let target = dir.write("real.docx", &original);
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
    let link = dir.path().join("link.docx");
    symlink(&target, &link).unwrap();
    let file = identify(link.to_str().unwrap(), &Limits::default()).unwrap();
    let info = state.registry().register(file).unwrap();
    let loaded = block_on(docx::load(&state, info.session_id, None))
        .unwrap()
        .session;
    let edited = block_on(docx::edit(
        &state,
        loaded.session_id,
        loaded.load_generation,
        0,
        edits(),
    ))
    .unwrap()
    .session;
    block_on(docx::preflight(
        &state,
        edited.session_id,
        edited.load_generation,
    ))
    .unwrap();
    block_on(docx::save(
        &state,
        edited.session_id,
        edited.load_generation,
        edited.revision,
    ))
    .unwrap();
    assert!(std::fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_ne!(std::fs::read(&target).unwrap(), original);
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode() & 0o7777,
        0o640
    );
    let _ = Path::new("");
}

#[test]
fn rhwp_세션의_저장_명령과_docx_세션은_서로의_경로를_쓰지_않는다() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let info = rhwp_session(
        &state,
        &dir,
        "a.hwp",
        &hwp_doc(0, &docinfo(0, b"font"), &section("hello"), &[]),
    );
    assert_eq!(
        block_on(docx::preflight(
            &state,
            info.session_id,
            info.load_generation
        ))
        .err(),
        Some(DocumentError::InvalidRequest)
    );
    assert_eq!(
        block_on(docx::save(&state, info.session_id, info.load_generation, 0)).err(),
        Some(DocumentError::InvalidRequest)
    );
    let doc = open_docx(&basic::basic_ko().unwrap());
    assert_eq!(
        doc.state.frontend_model(doc.info.session_id).err(),
        Some(DocumentError::InvalidRequest)
    );
}

#[test]
fn rhwp_저장_서비스는_사전_검사와_손실_보고와_다시_열기_비교를_모두_요구한다() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let extra: [(&str, &[u8]); 1] = [("/BinData/BIN0001.png", b"\x89PNG data")];
    let original = hwp_doc(0, &docinfo(0, b"font"), &section("hello"), &extra);
    let info = rhwp_session(&state, &dir, "a.hwp", &original);
    let registry = state.registry();
    let (id, generation) = (info.session_id, info.load_generation);
    let source = registry.preflight_source(id, generation).unwrap();
    let original_read = service::read_original(&source, &Limits::default()).unwrap();
    // 사전 검사: 편집 없는 출력이 원본과 같고 손실 0건.
    let check = service::preflight(
        Format::Hwp,
        &original_read,
        &original,
        Some(&report("hwp", json!([]))),
    );
    assert!(check.is_safe());
    registry
        .record_preflight(id, generation, source.content_hash, check)
        .unwrap();
    registry.commit(id, generation, 0, 1).unwrap();
    let edited = hwp_doc(0, &docinfo(9, b"font"), &section("hello, edited"), &extra);
    let lost = report(
        "hwp",
        json!([{"code": "binaryContentEmptied", "subject": "binaryData", "path": "BinData/BIN0001.png", "reason": "rawPassthroughUnavailable", "resourceId": 1}]),
    );
    let attempts: [(Value, bool, Outcome); 4] = [
        (lost, true, Outcome::Unsafe),
        (json!({"schemaVersion": 1}), true, Outcome::Unknown),
        (report("hwp", json!([])), false, Outcome::Unsafe),
        (report("hwpx", json!([])), true, Outcome::Unknown),
    ];
    for (loss_report, reopen, outcome) in attempts {
        let ticket = registry.begin_save(id, generation, 1).unwrap();
        let error = service::save(
            registry,
            &ticket,
            &Limits::default(),
            &edited,
            Some(&loss_report),
            reopen,
        )
        .unwrap_err();
        assert!(
            matches!(&error, DocumentError::UnsafeSave { preservation } if preservation.outcome == outcome),
            "{loss_report} {error:?}"
        );
        assert_eq!(std::fs::read(dir.path().join("a.hwp")).unwrap(), original);
    }
    // 형식이 다른 출력(HWPX 바이트).
    let ticket = registry.begin_save(id, generation, 1).unwrap();
    let hwpx = zip(&hwpx_package("<sec/>", "<head/>", true, true), false);
    let error = service::save(
        registry,
        &ticket,
        &Limits::default(),
        &hwpx,
        Some(&report("hwp", json!([]))),
        true,
    )
    .unwrap_err();
    assert!(
        matches!(&error, DocumentError::UnsafeSave { preservation } if preservation.findings.contains(&Finding::at(FindingCode::OutputMalformed, "container")))
    );
    drop(ticket);
    // 모두 맞으면 저장한다.
    let ticket = registry.begin_save(id, generation, 1).unwrap();
    let saved = service::save(
        registry,
        &ticket,
        &Limits::default(),
        &edited,
        Some(&report("hwp", json!([]))),
        true,
    )
    .unwrap();
    assert!(!saved.session.dirty);
    assert_eq!(std::fs::read(dir.path().join("a.hwp")).unwrap(), edited);
}

/// 탐침(로컬 탐색용, 기본 실행 안 함): `GEUL_HWP_PROBE`=목록 파일(줄마다 `원본\t출력`)의 HWP 비교 근거와 합계를 출력한다.
/// 업스트림 예제(external/rhwp/samples, 자동 시험 입력이 아님)의 편집 없는 rhwp 왕복 통계를 이것으로 쟀다.
#[test]
#[ignore]
fn hwp_비교_탐침() {
    let Ok(list) = std::env::var("GEUL_HWP_PROBE") else {
        return;
    };
    let text = std::fs::read_to_string(list).unwrap();
    let mut summary = std::collections::BTreeMap::<String, usize>::new();
    for line in text.lines() {
        let (a, b) = line.split_once('\t').unwrap();
        let findings = hwp::compare(&std::fs::read(a).unwrap(), &std::fs::read(b).unwrap());
        let verdict = Preservation::from_findings(findings.clone());
        println!(
            "{:?} {:?}",
            verdict.outcome,
            findings.iter().take(6).collect::<Vec<_>>()
        );
        for f in &findings {
            let part = f.part.clone().unwrap_or_default();
            let part = if part.starts_with("BodyText/") {
                "BodyText/*".into()
            } else if part.starts_with("BinData/") {
                "BinData/*".into()
            } else {
                part
            };
            *summary.entry(format!("{:?} {}", f.code, part)).or_default() += 1;
        }
        let _ = (FindingCode::PartMissing, Outcome::Safe);
    }
    println!("{summary:#?}");
}

/// 탐침(로컬 탐색용): `GEUL_ZIP_PROBE` 목록(원본\t출력)의 패키지 비교 근거를 출력한다.
#[test]
#[ignore]
fn 패키지_비교_탐침() {
    use super::package;
    let Ok(list) = std::env::var("GEUL_ZIP_PROBE") else {
        return;
    };
    let text = std::fs::read_to_string(list).unwrap();
    let mut summary = std::collections::BTreeMap::<String, usize>::new();
    for line in text.lines().filter(|l| !l.is_empty()) {
        let (a, b) = line.split_once('\t').unwrap();
        let findings = match (
            package::open(&std::fs::read(a).unwrap(), package::Side::Original),
            package::open(&std::fs::read(b).unwrap(), package::Side::Output),
        ) {
            (Ok(x), Ok(y)) => {
                let mut f = package::malformed_xml(&x, package::Side::Original);
                f.extend(package::compare(&x, &y, &|_| false));
                f
            }
            (Err(e), _) | (_, Err(e)) => vec![e],
        };
        let verdict = Preservation::from_findings(findings.clone());
        println!(
            "{:?} {:?}",
            verdict.outcome,
            findings.iter().take(6).collect::<Vec<_>>()
        );
        for f in &findings {
            *summary
                .entry(format!(
                    "{:?} {}",
                    f.code,
                    f.part.clone().unwrap_or_default()
                ))
                .or_default() += 1;
        }
    }
    println!("{summary:#?}");
}

// ---- T009 안정화 ----

/// 문서 속성 레코드(tag 16) 본문: 구역 수·시작 번호 6개·캐럿 3개, `extra`는 뒤에 붙는 바이트.
fn properties(sections: u16, starts: [u16; 6], caret: [u32; 3], extra: &[u8]) -> Vec<u8> {
    let mut out = sections.to_le_bytes().to_vec();
    for start in starts {
        out.extend_from_slice(&start.to_le_bytes());
    }
    for value in caret {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out.extend_from_slice(extra);
    out
}

fn docinfo_with(properties: &[u8]) -> Vec<u8> {
    [
        record(16, 0, properties),
        record(19, 1, b"font"),
        record(21, 1, b"char shape"),
        record(25, 1, b"para shape"),
    ]
    .concat()
}

#[test]
fn a_문서_속성은_26바이트의_캐럿_12바이트만_다를_수_있다() {
    let base = properties(1, [1; 6], [0, 0, 0], b"");
    let original = hwp_doc(0, &docinfo_with(&base), &section("hello"), &[]);
    let saved = |props: &[u8]| {
        hwp::compare_saved(
            &original,
            &hwp_doc(0, &docinfo_with(props), &section("hi"), &[]),
        )
    };
    assert_eq!(
        saved(&properties(1, [1; 6], [3, 7, 42], b"")),
        vec![],
        "캐럿만 다름"
    );
    let changed = vec![Finding::at(FindingCode::RecordsChanged, "DocInfo")];
    assert_eq!(
        saved(&properties(2, [1; 6], [3, 7, 42], b"")),
        changed,
        "구역 수"
    );
    assert_eq!(
        saved(&properties(1, [1, 1, 1, 9, 1, 1], [0, 0, 0], b"")),
        changed,
        "시작 번호"
    );
    assert_eq!(
        saved(&properties(1, [1; 6], [0, 0, 0], b"\x00\x00\x00\x00")),
        changed,
        "뒤에 붙은 바이트"
    );
    // 26바이트가 아닌 배치(뒤에 모르는 바이트가 있는 레코드)는 해석할 수 없으므로 캐럿도 면제하지 않는다.
    let long = |caret: [u32; 3], tail: &[u8]| properties(1, [1; 6], caret, tail);
    let original_long = hwp_doc(
        0,
        &docinfo_with(&long([0, 0, 0], b"ABCD")),
        &section("hello"),
        &[],
    );
    let saved_long = |props: &[u8]| {
        hwp::compare_saved(
            &original_long,
            &hwp_doc(0, &docinfo_with(props), &section("hi"), &[]),
        )
    };
    assert_eq!(
        saved_long(&long([0, 0, 0], b"ABCX")),
        changed,
        "캐럿 바로 뒤 바이트 변경"
    );
    assert_eq!(
        saved_long(&long([1, 2, 3], b"ABCD")),
        changed,
        "모르는 배치의 캐럿 면제 없음"
    );
    assert_eq!(saved_long(&long([0, 0, 0], b"ABCD")), vec![]);
    // 짧은 레코드.
    let short = hwp_doc(0, &docinfo_with(&[1, 0, 1, 0]), &section("hello"), &[]);
    assert_eq!(
        hwp::compare_saved(
            &short,
            &hwp_doc(0, &docinfo_with(&[1, 0, 2, 0]), &section("hi"), &[])
        ),
        changed
    );
    assert_eq!(
        hwp::compare_saved(
            &short,
            &hwp_doc(0, &docinfo_with(&[1, 0, 1, 0]), &section("hi"), &[])
        ),
        vec![]
    );
}

#[test]
fn d_비레코드_스트림은_바이트가_같을_때만_같다() {
    let deflate = crate::document::testutil::deflate;
    let doc = |extra: &[(&str, &[u8])]| hwp_doc(0, &docinfo(0, b"font"), &section("hello"), extra);
    let png = b"\x89PNG image bytes".to_vec();
    let same = doc(&[("/BinData/BIN0001.png", &png)]);
    assert_eq!(
        hwp::compare(&same, &doc(&[("/BinData/BIN0001.png", &png)])),
        vec![]
    );
    let packed = deflate(&png);
    assert_eq!(
        hwp::compare(
            &doc(&[("/BinData/BIN0001.png", &packed)]),
            &doc(&[("/BinData/BIN0001.png", &packed)])
        ),
        vec![]
    );
    let changed = vec![Finding::at(FindingCode::PartChanged, "BinData/BIN0001.png")];
    // 한쪽만 압축: 같은 BinData 속성(DocInfo 그대로)이면 읽는 쪽은 둘을 다르게 읽는다.
    assert_eq!(
        hwp::compare(
            &doc(&[("/BinData/BIN0001.png", &packed)]),
            &doc(&[("/BinData/BIN0001.png", &png)])
        ),
        changed
    );
    assert_eq!(
        hwp::compare(
            &doc(&[("/BinData/BIN0001.png", &png)]),
            &doc(&[("/BinData/BIN0001.png", &packed)])
        ),
        changed
    );
    // 압축하지 않은 데이터가 우연히 deflate로 풀리는 경우.
    let looks = deflate(b"abc");
    assert_eq!(
        hwp::compare(
            &doc(&[("/Scripts/X", &looks)]),
            &doc(&[("/Scripts/X", b"abc")])
        ),
        vec![Finding::at(FindingCode::PartChanged, "Scripts/X")]
    );
    // 같은 내용의 다른 deflate 인코딩(압축 수준)도 바이트가 다르면 다르다고 본다(동치를 증명하지 않음).
    let mut fast = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
    std::io::Write::write_all(&mut fast, &png.repeat(50)).unwrap();
    let fast = fast.finish().unwrap();
    let best = {
        let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
        std::io::Write::write_all(&mut e, &png.repeat(50)).unwrap();
        e.finish().unwrap()
    };
    if fast != best {
        assert_eq!(
            hwp::compare(
                &doc(&[("/BinData/BIN0001.png", &fast)]),
                &doc(&[("/BinData/BIN0001.png", &best)])
            ),
            changed
        );
    }
    // 깨진 압축 데이터.
    assert_eq!(
        hwp::compare(
            &doc(&[("/BinData/BIN0001.png", b"\xff\xff\xff")]),
            &doc(&[("/BinData/BIN0001.png", b"\xff\xff\xfe")])
        ),
        changed
    );
}

/// DocInfo BIN_DATA 레코드(내장, 압축 속성 `compression`: 0 문서·1 압축·2 비압축·3 예약).
fn bin_data(id: u16, extension: &str, compression: u16) -> Vec<u8> {
    let mut body = (1u16 | (compression << 4)).to_le_bytes().to_vec();
    body.extend_from_slice(&id.to_le_bytes());
    body.extend_from_slice(&(extension.encode_utf16().count() as u16).to_le_bytes());
    body.extend_from_slice(&utf16(extension));
    record(18, 1, &body)
}

#[test]
fn d_bindata는_속성으로_정한_저장_형태가_같을_때만_풀어서_비교한다() {
    let deflate = crate::document::testutil::deflate;
    let image = b"\x89PNG image bytes ".repeat(40);
    let encode = |level: u32, data: &[u8]| {
        let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::new(level));
        std::io::Write::write_all(&mut e, data).unwrap();
        e.finish().unwrap()
    };
    let (fast, best) = (encode(1, &image), encode(9, &image));
    assert_ne!(fast, best, "시험 전제: 다른 인코딩");
    let name = "BinData/BIN0001.png";
    let path = "/BinData/BIN0001.png";
    // flags: 문서 압축 플래그. 레코드 스트림은 플래그에 맞춰 압축한다.
    let doc = |flags: u32, compression: u16, stream: &[u8]| {
        let di = [docinfo(0, b"font"), bin_data(1, "png", compression)].concat();
        let (di, body) = if flags & 1 != 0 {
            (deflate(&di), deflate(&section("hello")))
        } else {
            (di, section("hello"))
        };
        hwp_doc(flags, &di, &body, &[(path, stream)])
    };
    let changed = vec![Finding::at(FindingCode::PartChanged, name)];
    // 압축(속성 1, 또는 속성 0 + 압축 문서): 다른 인코딩도 끝까지 풀어 같으면 같다.
    assert_eq!(hwp::compare(&doc(0, 1, &fast), &doc(0, 1, &best)), vec![]);
    assert_eq!(hwp::compare(&doc(1, 0, &fast), &doc(1, 0, &best)), vec![]);
    // 풀어서 다르면 다르다.
    assert_eq!(
        hwp::compare(&doc(0, 1, &fast), &doc(0, 1, &encode(9, b"other"))),
        changed
    );
    // 비압축(속성 2, 또는 속성 0 + 비압축 문서): 바이트가 같아야 한다(풀리는 바이트라도 풀지 않는다).
    assert_eq!(hwp::compare(&doc(0, 2, &fast), &doc(0, 2, &best)), changed);
    assert_eq!(hwp::compare(&doc(0, 0, &fast), &doc(0, 0, &best)), changed);
    assert_eq!(hwp::compare(&doc(1, 2, &image), &doc(1, 2, &fast)), changed);
    // 예약 속성(3): 형태를 정할 수 없으므로 판단하지 않는다(4차 안정화 B 전에는 바이트 비교라 같은 바이트면 safe).
    assert_eq!(
        hwp::compare(&doc(0, 3, &fast), &doc(0, 3, &best)),
        vec![Finding::at(FindingCode::Unsupported, name)]
    );
    // 문서 플래그가 바뀌어 속성 0의 형태가 달라짐: 같은 내용이라도 다르다.
    let found = hwp::compare(&doc(1, 0, &fast), &doc(0, 0, &image));
    assert!(found.contains(&changed[0]), "{found:?}");
    // 압축이어야 하는데 원본이 안 풀림: unknown. 출력이 안 풀리거나 뒤에 남는 바이트: unsafe.
    assert_eq!(
        hwp::compare(&doc(0, 1, b"\xff\xff"), &doc(0, 1, &best)),
        vec![Finding::at(FindingCode::OriginalMalformed, name)]
    );
    assert_eq!(
        hwp::compare(&doc(0, 1, &fast), &doc(0, 1, b"\xff\xff")),
        vec![Finding::at(FindingCode::OutputMalformed, name)]
    );
    let trailing = [best.clone(), b"tail".to_vec()].concat();
    assert_eq!(
        hwp::compare(&doc(0, 1, &fast), &doc(0, 1, &trailing)),
        vec![Finding::at(FindingCode::OutputMalformed, name)]
    );
    let mut truncated = best.clone();
    truncated.truncate(best.len() / 2);
    assert_eq!(
        hwp::compare(&doc(0, 1, &fast), &doc(0, 1, &truncated)),
        vec![Finding::at(FindingCode::OutputMalformed, name)]
    );
    // 한컴 꼬리(푼 내용의 CRC-32·길이 8바이트): 맞으면 받고, 맞지 않으면 원본을 해석할 수 없다.
    let mut crc = flate2::Crc::new();
    crc.update(&image);
    let tail = [crc.sum().to_le_bytes(), (image.len() as u32).to_le_bytes()].concat();
    let hancom = [fast.clone(), tail.clone()].concat();
    assert_eq!(hwp::compare(&doc(0, 1, &hancom), &doc(0, 1, &best)), vec![]);
    let mut wrong = tail.clone();
    wrong[0] ^= 1;
    assert_eq!(
        hwp::compare(
            &doc(0, 1, &[fast.clone(), wrong].concat()),
            &doc(0, 1, &best)
        ),
        vec![Finding::at(FindingCode::OriginalMalformed, name)]
    );
    // 레코드 스트림도 같은 규칙: 꼬리가 맞으면 같고, 그 밖의 남는 바이트는 해석할 수 없다.
    let records = |di_tail: &[u8]| {
        let di = deflate(&docinfo(0, b"font"));
        hwp_doc(
            1,
            &[di, di_tail.to_vec()].concat(),
            &deflate(&section("hello")),
            &[],
        )
    };
    let mut crc = flate2::Crc::new();
    crc.update(&docinfo(0, b"font"));
    let di_tail = [
        crc.sum().to_le_bytes(),
        (docinfo(0, b"font").len() as u32).to_le_bytes(),
    ]
    .concat();
    assert_eq!(hwp::compare(&records(&di_tail), &records(&[])), vec![]);
    assert_eq!(
        hwp::compare(&records(b"junk"), &records(&[])),
        vec![Finding::at(FindingCode::OriginalMalformed, "DocInfo")]
    );
    assert_eq!(
        hwp::compare(&records(&[]), &records(b"junk")),
        vec![Finding::at(FindingCode::OutputMalformed, "DocInfo")]
    );
    // 속성이 가리키지 않는 이름(확장자 다름)은 바이트 비교.
    let other = |stream: &[u8]| {
        let di = [docinfo(0, b"font"), bin_data(1, "jpg", 1)].concat();
        hwp_doc(0, &di, &section("hello"), &[(path, stream)])
    };
    assert_eq!(hwp::compare(&other(&fast), &other(&best)), changed);
    // 같은 이름에 형태가 둘인 속성: 정할 수 없으므로 판단하지 않는다(4차 안정화 B 전에는 바이트 비교).
    let twice = |stream: &[u8]| {
        let di = [
            docinfo(0, b"font"),
            bin_data(1, "png", 1),
            bin_data(1, "png", 2),
        ]
        .concat();
        hwp_doc(0, &di, &section("hello"), &[(path, stream)])
    };
    assert_eq!(
        hwp::compare(&twice(&fast), &twice(&best)),
        vec![Finding::at(FindingCode::Unsupported, name)]
    );
}

#[test]
fn e_같은_바이트의_깨진_레코드는_보존의_근거가_아니다() {
    let mut broken = docinfo(0, b"font");
    broken.truncate(broken.len() - 2);
    let original = hwp_doc(0, &broken, &section("hello"), &[]);
    let verdict = Preservation::from_findings(hwp::compare(&original, &original));
    assert_eq!(
        verdict.findings,
        vec![Finding::at(FindingCode::OriginalMalformed, "DocInfo")]
    );
    assert_eq!(verdict.outcome, Outcome::Unknown);
    let mut body = section("hello");
    body.truncate(body.len() - 1);
    let original = hwp_doc(0, &docinfo(0, b"font"), &body, &[]);
    assert_eq!(
        hwp::compare(&original, &original),
        vec![Finding::at(
            FindingCode::OriginalMalformed,
            "BodyText/Section0"
        )]
    );
    // 편집 저장: 원본 DocInfo가 깨졌으면 출력이 같아도 unknown.
    let original = hwp_doc(0, &broken, &section("hello"), &[]);
    let output = hwp_doc(0, &broken, &section("hello, edited"), &[]);
    assert_eq!(
        hwp::compare_saved(&original, &output),
        vec![Finding::at(FindingCode::OriginalMalformed, "DocInfo")]
    );
    // 압축 플래그인데 같은 바이트가 deflate가 아님.
    let original = hwp_doc(1, b"not deflate", b"not deflate", &[]);
    assert!(codes(&hwp::compare(&original, &original)).contains(&FindingCode::OriginalMalformed));
}

/// 한 색(모든 픽셀이 같은) 또는 두 색 RGBA PNG.
fn png(width: u32, height: u32, uniform: bool) -> Vec<u8> {
    fn chunk(out: &mut Vec<u8>, kind: &[u8], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut crc = flate2::Crc::new();
        crc.update(kind);
        crc.update(data);
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        out.extend_from_slice(&crc.sum().to_be_bytes());
    }
    let mut raw = Vec::new();
    for y in 0..height {
        raw.push(0);
        for x in 0..width {
            let ink = !uniform && x == width / 2 && y == height / 2;
            raw.extend_from_slice(if ink {
                &[0, 0, 0, 255]
            } else {
                &[255, 255, 255, 255]
            });
        }
    }
    let mut zlib = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut zlib, &raw).unwrap();
    let mut ihdr = width.to_be_bytes().to_vec();
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &zlib.finish().unwrap());
    chunk(&mut out, b"IEND", b"");
    out
}

fn utf16(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(u16::to_le_bytes).collect()
}

#[test]
fn f_본문을_바꾼_hwp_저장은_내용이_없음을_증명한_미리보기만_그대로_둘_수_있다() {
    let stale = vec![Finding::at(FindingCode::PreviewStale, "PrvText")];
    let doc = |body: &str, prv_text: Option<&[u8]>, prv_image: Option<&[u8]>| {
        let mut extra: Vec<(&str, &[u8])> = Vec::new();
        if let Some(text) = prv_text {
            extra.push(("/PrvText", text));
        }
        if let Some(image) = prv_image {
            extra.push(("/PrvImage", image));
        }
        hwp_doc(0, &docinfo(0, b"font"), &section(body), &extra)
    };
    let blank_text = utf16("\r\n");
    let blank_image = super::preview::RHWP_BLANK_PREVIEW_PNG.to_vec();
    // 미리보기 없음·내용과 무관한 미리보기(빈 값·엔진 상수): 본문을 바꿔도 된다.
    assert_eq!(
        hwp::compare_saved(&doc("비밀 문장", None, None), &doc("공개", None, None)),
        vec![]
    );
    assert_eq!(
        hwp::compare_saved(
            &doc("비밀", Some(&blank_text), Some(&blank_image)),
            &doc("공개", Some(&blank_text), Some(&blank_image))
        ),
        vec![]
    );
    // 글자가 있는 미리보기: 지우거나 바꾼 본문이 미리보기에 남는다.
    let text = utf16("비밀 문장");
    for edited in ["", "다른 문장"] {
        assert_eq!(
            hwp::compare_saved(
                &doc("비밀 문장", Some(&text), None),
                &doc(edited, Some(&text), None)
            ),
            stale,
            "{edited:?}"
        );
    }
    // 한 색이어도 출처를 모르는 그림(4차 안정화 C 전에는 받음), 그림이 있는 미리보기, 해석할 수 없는 그림.
    let uniform = png(8, 4, true);
    assert_eq!(
        hwp::compare_saved(
            &doc("a", None, Some(&uniform)),
            &doc("b", None, Some(&uniform))
        ),
        vec![Finding::at(FindingCode::PreviewStale, "PrvImage")]
    );
    let image = png(8, 4, false);
    assert_eq!(
        hwp::compare_saved(&doc("a", None, Some(&image)), &doc("b", None, Some(&image))),
        vec![Finding::at(FindingCode::PreviewStale, "PrvImage")]
    );
    let bmp = b"BM\x00\x00 not a png".to_vec();
    assert_eq!(
        hwp::compare_saved(&doc("a", None, Some(&bmp)), &doc("b", None, Some(&bmp))),
        vec![Finding::at(FindingCode::PreviewStale, "PrvImage")]
    );
    // 본문이 그대로면 미리보기도 낡지 않았다.
    assert_eq!(
        hwp::compare_saved(
            &doc("a", Some(&text), Some(&image)),
            &doc("a", Some(&text), Some(&image))
        ),
        vec![]
    );
    // 편집 없는 사전 검사는 미리보기를 문제 삼지 않는다(본문이 같음).
    assert_eq!(
        hwp::compare(
            &doc("a", Some(&text), Some(&image)),
            &doc("a", Some(&text), Some(&image))
        ),
        vec![]
    );
}

#[test]
fn f_hwpx와_docx도_본문을_바꾼_저장은_미리보기가_비었음을_증명해야_한다() {
    let with_preview = |section: &str, text: &[u8], image: &[u8]| {
        let mut entries = hwpx_package(section, "<head/>", true, true);
        entries.push(entry("Preview/PrvText.txt", text));
        entries.push(entry("Preview/PrvImage.png", image));
        pkg(&entries)
    };
    let blank = super::preview::RHWP_BLANK_PREVIEW_PNG.to_vec();
    let original = with_preview("<sec><p>비밀</p></sec>", b"\r\n", &blank);
    assert_eq!(
        package::compare_saved_hwpx(
            &original,
            &with_preview("<sec><p>공개</p></sec>", b"\r\n", &blank)
        ),
        vec![]
    );
    let original = with_preview("<sec><p>비밀</p></sec>", "비밀".as_bytes(), &blank);
    assert_eq!(
        package::compare_saved_hwpx(
            &original,
            &with_preview("<sec><p>공개</p></sec>", "비밀".as_bytes(), &blank)
        ),
        vec![Finding::at(
            FindingCode::PreviewStale,
            "Preview/PrvText.txt"
        )]
    );
    // 미리보기 항목이 없는 HWPX: 남는 것이 없다.
    let bare = |section: &str| pkg(&hwpx_package(section, "<head/>", true, true));
    assert_eq!(
        package::compare_saved_hwpx(
            &bare("<sec><p>비밀</p></sec>"),
            &bare("<sec><p>공개</p></sec>")
        ),
        vec![]
    );
    // 한 색이어도 엔진 상수가 아닌 그림·공백 무늬 글(4차 안정화 C 전에는 받음).
    for (text, image, part) in [
        (&b"\r\n"[..], png(1, 1, true), "Preview/PrvImage.png"),
        (&b"\r\n\r\n"[..], blank.clone(), "Preview/PrvText.txt"),
        (&b" \t\r\n"[..], blank.clone(), "Preview/PrvText.txt"),
    ] {
        let original = with_preview("<sec><p>a</p></sec>", text, &image);
        assert_eq!(
            package::compare_saved_hwpx(
                &original,
                &with_preview("<sec><p>b</p></sec>", text, &image)
            ),
            vec![Finding::at(FindingCode::PreviewStale, part)],
            "{part}"
        );
    }
    let inked = png(4, 4, false);
    let original = with_preview("<sec><p>a</p></sec>", b"\r\n", &inked);
    assert_eq!(
        package::compare_saved_hwpx(
            &original,
            &with_preview("<sec><p>b</p></sec>", b"\r\n", &inked)
        ),
        vec![Finding::at(
            FindingCode::PreviewStale,
            "Preview/PrvImage.png"
        )]
    );
    // DOCX 썸네일.
    let doc = |text: &str| {
        format!(
            r#"<w:document xmlns:w="{W}"><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>"#
        )
    };
    let thumb = |text: &str| {
        pkg(&[
            entry("word/document.xml", doc(text).as_bytes()),
            entry("docProps/thumbnail.jpeg", b"\xff\xd8 jpeg"),
        ])
    };
    assert_eq!(
        package::compare_saved_docx(&thumb("비밀"), &thumb("공개")),
        vec![Finding::at(
            FindingCode::PreviewStale,
            "docProps/thumbnail.jpeg"
        )]
    );
    assert_eq!(
        package::compare_saved_docx(&thumb("같음"), &thumb("같음")),
        vec![]
    );
}

#[test]
fn g_rhwp_형식은_손실_보고가_반드시_있어야_하고_docx는_받지_않는다() {
    let hwp = hwp_doc(0, &docinfo(0, b"font"), &section("hello"), &[]);
    let invalid = Finding::new(FindingCode::LossReportInvalid);
    let verdict = service::preflight(Format::Hwp, &hwp, &hwp, None);
    assert_eq!(
        (verdict.outcome, verdict.findings.contains(&invalid)),
        (Outcome::Unknown, true)
    );
    let verdict = service::check_saved(Format::Hwp, &hwp, &hwp, None, true);
    assert_eq!(
        (verdict.outcome, verdict.findings.contains(&invalid)),
        (Outcome::Unknown, true)
    );
    let hwpx = zip(&hwpx_package("<sec/>", "<head/>", true, true), false);
    assert!(service::preflight(Format::Hwpx, &hwpx, &hwpx, None)
        .findings
        .contains(&invalid));
    assert!(service::check_saved(Format::Hwpx, &hwpx, &hwpx, None, true)
        .findings
        .contains(&invalid));
    assert!(service::preflight(Format::Hwp, &hwp, &hwp, Some(&report("hwp", json!([])))).is_safe());
    // DOCX는 rhwp 보고서를 쓰지 않는다: 들어오면 계약 위반(unknown).
    let docx = basic::basic_ko().unwrap();
    assert!(service::preflight(Format::Docx, &docx, &docx, None).is_safe());
    let verdict = service::preflight(Format::Docx, &docx, &docx, Some(&report("hwp", json!([]))));
    assert_eq!(
        (verdict.outcome, verdict.findings),
        (Outcome::Unknown, vec![invalid])
    );
}

/// 시험용: 확장 속성을 단다(파일 시스템이 지원하지 않으면 false).
#[cfg(target_os = "linux")]
fn set_xattr(path: &Path, name: &str, value: &[u8]) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    let name = std::ffi::CString::new(name).unwrap();
    // SAFETY: NUL로 끝나는 경로·이름, 값 포인터·길이 짝.
    unsafe {
        libc::setxattr(
            path.as_ptr(),
            name.as_ptr(),
            value.as_ptr().cast(),
            value.len(),
            0,
        ) == 0
    }
}

/// 시험용: 저장 중(임시 파일을 다 쓴 뒤·교체 직전 확인 전)에 원본 경로로 `hook`을 부르며 저장한다(같은 스레드에서
/// 서비스를 직접 부른다: 훅은 스레드 지역 값).
#[cfg(target_os = "linux")]
fn save_hooked(
    doc: &Docx,
    hook: impl Fn(&Path, &Path) + 'static,
) -> Result<SaveOutcome, DocumentError> {
    super::publish::BEFORE_CHECK.with(|cell| *cell.borrow_mut() = Some(Box::new(hook)));
    let result = save_with_fault(doc, None);
    super::publish::BEFORE_CHECK.with(|cell| *cell.borrow_mut() = None);
    result
}

#[cfg(target_os = "linux")]
#[test]
fn b_읽기_전용_원본은_디렉터리에_쓸_수_있어도_바꾸지_않는다() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let original = basic::basic_ko().unwrap();
    let mode = |path: &Path| std::fs::metadata(path).unwrap().mode() & 0o7777;
    let read_only = Some(DocumentError::SaveUnsupported {
        reason: SaveUnsupportedReason::ReadOnly,
    });
    // 0444·0400·0464(소유자 쓰기 없음, 그룹 쓰기는 있음): 디렉터리는 쓸 수 있지만 원본은 그대로.
    for bits in [0o444, 0o400, 0o464] {
        let mut doc = open_docx_prepared(&original, |path| {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(bits)).unwrap()
        });
        doc.edit(edits());
        doc.preflight().unwrap();
        assert_eq!(doc.save().err(), read_only, "{bits:o}");
        assert_eq!((doc.bytes(), mode(&doc.path)), (original.clone(), bits));
        assert_eq!(doc.leftovers(), Vec::<String>::new());
        assert!(doc.state.registry().get(doc.info.session_id).unwrap().dirty);
    }
    // 0644는 바꾼다(권한 그대로).
    let mut doc = open_docx_prepared(&original, |path| {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644)).unwrap()
    });
    doc.edit(edits());
    doc.preflight().unwrap();
    assert!(!doc.save().unwrap().session.dirty);
    assert_eq!(mode(&doc.path), 0o644);
    // 저장 중에 읽기 전용으로 바뀜: 교체 직전 확인(권한·ctime)이 막는다.
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    let saved = save_hooked(&doc, |path, _| {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o444)).unwrap()
    });
    assert_eq!(saved.err(), Some(DocumentError::FileConflict));
    assert_eq!((doc.bytes(), mode(&doc.path)), (original.clone(), 0o444));
    assert_eq!(doc.leftovers(), Vec::<String>::new());
    // 다른 그룹 소유(이 프로세스가 속한 보조 그룹으로 chgrp): 교체하면 그룹이 바뀌므로 막는다.
    let primary = std::fs::metadata(&doc.path).unwrap().gid();
    // SAFETY: 크기를 물은 뒤 그만큼의 버퍼로 다시 부른다.
    let groups = unsafe {
        let count = libc::getgroups(0, std::ptr::null_mut());
        let mut groups = vec![0; count.max(0) as usize];
        let got = libc::getgroups(count, groups.as_mut_ptr());
        groups.truncate(got.max(0) as usize);
        groups
    };
    match groups.into_iter().find(|group| *group != primary) {
        Some(group) => {
            let mut doc = open_docx_prepared(&original, |path| {
                std::os::unix::fs::chown(path, None, Some(group)).unwrap()
            });
            doc.edit(edits());
            doc.preflight().unwrap();
            assert_eq!(
                doc.save().err(),
                Some(DocumentError::SaveUnsupported {
                    reason: SaveUnsupportedReason::Ownership
                })
            );
            assert_eq!(doc.bytes(), original);
            assert_eq!(doc.leftovers(), Vec::<String>::new());
        }
        None => eprintln!("NOT RUN: 다른 그룹 소유(보조 그룹 없음)"),
    }
}

#[cfg(target_os = "linux")]
#[test]
fn c_교체로_잃을_메타데이터가_있거나_저장_중_바뀌면_막는다() {
    use std::os::unix::fs::PermissionsExt;
    let original = basic::basic_ko().unwrap();
    let metadata = Some(DocumentError::SaveUnsupported {
        reason: SaveUnsupportedReason::Metadata,
    });
    let check = |doc: &Docx| {
        assert_eq!(doc.bytes(), original);
        assert_eq!(doc.leftovers(), Vec::<String>::new());
    };
    // 저장 중 원본의 권한·링크 수·확장 속성이 바뀜: 지문(ctime·mode·nlink)이 달라 충돌.
    let probe = TempDir::new();
    let xattr_supported = set_xattr(&probe.write("probe", b""), "user.geul-probe", b"");
    let mut hooks: Vec<(&str, super::publish::Hook)> = vec![
        (
            "chmod",
            Box::new(|path: &Path, _: &Path| {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap()
            }),
        ),
        (
            "link",
            Box::new(|path: &Path, _: &Path| {
                std::fs::hard_link(path, path.with_extension("link")).unwrap()
            }),
        ),
    ];
    if xattr_supported {
        hooks.push((
            "xattr",
            Box::new(|path: &Path, _: &Path| assert!(set_xattr(path, "user.geul-test", b"x"))),
        ));
    } else {
        eprintln!("NOT RUN: 저장 중 확장 속성 변경(파일 시스템이 user xattr를 지원하지 않음)");
    }
    for (name, hook) in hooks {
        let mut doc = open_docx(&original);
        doc.edit(edits());
        doc.preflight().unwrap();
        let saved = save_hooked(&doc, hook);
        assert_eq!(saved.err(), Some(DocumentError::FileConflict), "{name}");
        assert_eq!(doc.bytes(), original, "{name}");
        let left: Vec<String> = doc
            .leftovers()
            .into_iter()
            .filter(|file| !file.ends_with(".link"))
            .collect();
        assert_eq!(left, Vec::<String>::new(), "{name}");
    }
    // 불러오기 전부터 확장 속성이 있는 원본: 새 파일에 없으므로 막는다.
    if xattr_supported {
        let mut doc = open_docx_prepared(&original, |path| {
            assert!(set_xattr(path, "user.geul-tag", b"keep"))
        });
        doc.edit(edits());
        doc.preflight().unwrap();
        assert_eq!(doc.save().err(), metadata);
        check(&doc);
    } else {
        eprintln!("NOT RUN: 원본 user xattr(파일 시스템이 지원하지 않음)");
    }
    // POSIX ACL(이름 붙은 사용자 항목): 새 파일에 없으므로 막는다.
    let uid = std::fs::metadata(probe.path())
        .map(|m| std::os::unix::fs::MetadataExt::uid(&m))
        .unwrap();
    let mut applied = false;
    let mut doc = open_docx_prepared(&original, |path| {
        applied = std::process::Command::new("setfacl")
            .args(["-m", &format!("u:{uid}:r")])
            .arg(path)
            .status()
            .is_ok_and(|status| status.success());
    });
    if applied {
        doc.edit(edits());
        doc.preflight().unwrap();
        assert_eq!(doc.save().err(), metadata);
        check(&doc);
    } else {
        eprintln!("NOT RUN: POSIX ACL(setfacl 없음 또는 파일 시스템 미지원)");
    }
    // 메타데이터를 읽지 못함: 막는다.
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    assert_eq!(save_with_fault(&doc, Some(Fault::Inspect)).err(), metadata);
    check(&doc);
    // 메타데이터가 없는(같은) 원본은 저장한다.
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    assert!(doc.save().is_ok());
}

/// 다시 불러오기 전 단계(편집기가 세션을 failed로 돌림).
fn registry_fail(doc: &Docx) {
    doc.state
        .registry()
        .transition(
            doc.info.session_id,
            doc.info.load_generation,
            SessionState::Ready,
            SessionState::Failed,
        )
        .unwrap();
}

#[test]
fn i_교체_뒤_fsync_실패는_교체됨_내구성_미확인으로_남기고_다시_저장할_수_있다() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    let saved = save_with_fault(&doc, Some(Fault::DirSync)).unwrap();
    // 교체는 됐다(되돌리지 않음): 디스크는 새 파일이고 임시 파일은 없다.
    assert!(!saved.durable);
    let written = doc.bytes();
    assert_ne!(written, original);
    assert_eq!(doc.leftovers(), Vec::<String>::new());
    // 판은 그대로이고 dirty로 남는다(닫기·다시 불러오기가 버리기를 확인한다).
    assert_eq!(saved.session.revision, doc.info.revision);
    assert!(saved.session.dirty);
    let registry = doc.state.registry();
    assert!(registry.get(doc.info.session_id).unwrap().dirty);
    // 기록은 새 파일을 원본으로 한다: 다시 검사·저장하면 충돌 없이 교체하고 깨끗해진다.
    let check = doc.preflight().unwrap();
    assert!(check.preservation.is_safe(), "{:?}", check.preservation);
    let again = doc.save().unwrap();
    assert!(again.durable);
    assert!(!again.session.dirty);
    assert_eq!(again.session.revision, doc.info.revision);
    // 내구성 미확인 뒤 다시 불러오면(디스크에서 읽음) 깨끗하다.
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    assert!(!save_with_fault(&doc, Some(Fault::DirSync)).unwrap().durable);
    registry_fail(&doc);
    let reloaded = block_on(docx::load(&doc.state, doc.info.session_id, None)).unwrap();
    assert!(!reloaded.session.dirty);
}

#[test]
fn 안정화_오류와_근거의_직렬화_형식() {
    fn json(value: &impl serde::Serialize) -> String {
        serde_json::to_string(value).unwrap()
    }
    for (reason, name) in [
        (SaveUnsupportedReason::ReadOnly, "read-only"),
        (SaveUnsupportedReason::Metadata, "metadata"),
        (SaveUnsupportedReason::SharedFile, "shared-file"),
        (SaveUnsupportedReason::SharedDirectory, "shared-directory"),
    ] {
        assert_eq!(
            json(&DocumentError::SaveUnsupported { reason }),
            format!(r#"{{"code":"SaveUnsupported","reason":"{name}"}}"#)
        );
    }
    assert_eq!(
        json(&Finding::at(FindingCode::PreviewStale, "PrvText")),
        r#"{"code":"previewStale","part":"PrvText"}"#
    );
}

#[test]
fn f_한_색_png도_글을_숨길_자리가_있는_구조도_엔진_상수가_아니면_받지_않는다() {
    use super::preview::{blank_utf16, blank_utf8, known_blank_png};
    // 4차 안정화 C: 한 색 PNG는 증명이 아니다(3차의 엄격한 검사가 받던 것도 받지 않는다).
    let blank = png(6, 3, true);
    assert!(!known_blank_png(&blank));
    assert!(!known_blank_png(&png(6, 3, false)));
    // IHDR(8 + 25바이트) 뒤에 덩어리를 끼운다.
    let with_chunk =
        |kind: &[u8], body: &[u8]| [&blank[..33], &png_chunk(kind, body), &blank[33..]].concat();
    for kind in [b"pHYs", b"tEXt", b"zTXt", b"iTXt", b"eXIf", b"prVt"] {
        assert!(
            !known_blank_png(&with_chunk(kind, b"Comment\0secret")),
            "{:?}",
            std::str::from_utf8(kind)
        );
    }
    assert!(!known_blank_png(
        &[blank.clone(), b"secret".to_vec()].concat()
    ));
    // 글 미리보기: 빈 값과 `\r\n` 하나만(공백 무늬·BOM·제어 문자는 받지 않는다).
    assert!(
        blank_utf16(b"") && blank_utf16(&utf16("\r\n")) && blank_utf8(b"") && blank_utf8(b"\r\n")
    );
    for text in [" \r\n\t", "\u{FEFF}\r\n", "\r\n\r\n", " ", "\n", "a"] {
        assert!(
            !blank_utf16(&utf16(text)) && !blank_utf8(text.as_bytes()),
            "{text:?}"
        );
    }
    assert!(!blank_utf16(&[0x20]));
}

// ---- T009 3차 안정화 B·E: 검증한 임시 파일이 게시되는 파일이다(위협 모델: 이 사용자·root 밖의 사용자는 믿지 않음) ----

/// 저장 앞뒤의 원본 바이트·권한과 남은 파일.
#[cfg(target_os = "linux")]
fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(path).unwrap().mode() & 0o7777
}

#[cfg(target_os = "linux")]
#[test]
fn b_다른_사용자가_쓸_수_있는_원본_디렉터리는_저장하지_않고_sticky와_비공유는_저장한다() {
    use std::os::unix::fs::PermissionsExt;
    let original = basic::basic_ko().unwrap();
    let set = |path: &Path, bits: u32| {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(bits)).unwrap()
    };
    let unsupported = |reason| Some(DocumentError::SaveUnsupported { reason });
    // 원본 권한: 소유자만 쓰면 저장하고 권한 그대로, 그룹·그 밖이 쓸 수 있으면 막는다.
    for (bits, expected) in [
        (0o600, None),
        (0o644, None),
        (0o664, unsupported(SaveUnsupportedReason::SharedFile)),
        (0o646, unsupported(SaveUnsupportedReason::SharedFile)),
        (0o666, unsupported(SaveUnsupportedReason::SharedFile)),
    ] {
        let mut doc = open_docx_prepared(&original, |path| set(path, bits));
        doc.edit(edits());
        doc.preflight().unwrap();
        let saved = doc.save();
        assert_eq!(saved.as_ref().err().cloned(), expected, "{bits:o}");
        assert_eq!(mode_of(&doc.path), bits, "{bits:o}");
        assert_eq!(doc.bytes() == original, expected.is_some(), "{bits:o}");
        assert_eq!(doc.leftovers(), Vec::<String>::new(), "{bits:o}");
    }
    // 디렉터리 권한: 그룹·그 밖 쓰기(sticky 없음)는 막고, sticky(1777, 이 사용자 소유)·0700·0755는 저장한다.
    for (bits, expected) in [
        (0o700, None),
        (0o755, None),
        (0o1777, None),
        (0o775, unsupported(SaveUnsupportedReason::SharedDirectory)),
        (0o757, unsupported(SaveUnsupportedReason::SharedDirectory)),
        (0o777, unsupported(SaveUnsupportedReason::SharedDirectory)),
    ] {
        let mut doc = open_docx_prepared(&original, |path| set(path.parent().unwrap(), bits));
        doc.edit(edits());
        doc.preflight().unwrap();
        let saved = doc.save();
        assert_eq!(saved.as_ref().err().cloned(), expected, "dir {bits:o}");
        assert_eq!(doc.bytes() == original, expected.is_some(), "dir {bits:o}");
        assert_eq!(doc.leftovers(), Vec::<String>::new(), "dir {bits:o}");
        set(doc.dir.path(), 0o755);
    }
    // 디렉터리 접근 ACL(다른 사용자 항목): 막는다.
    let uid = std::fs::metadata(TempDir::new().path())
        .map(|m| std::os::unix::fs::MetadataExt::uid(&m))
        .unwrap();
    let mut applied = false;
    let mut doc = open_docx_prepared(&original, |path| {
        applied = std::process::Command::new("setfacl")
            .args(["-m", &format!("u:{uid}:rwx")])
            .arg(path.parent().unwrap())
            .status()
            .is_ok_and(|status| status.success());
    });
    if applied {
        doc.edit(edits());
        doc.preflight().unwrap();
        assert_eq!(
            doc.save().err(),
            unsupported(SaveUnsupportedReason::SharedDirectory)
        );
        assert_eq!(doc.bytes(), original);
        assert_eq!(doc.leftovers(), Vec::<String>::new());
    } else {
        eprintln!("NOT RUN: 디렉터리 ACL(setfacl 없음 또는 파일 시스템 미지원)");
    }
}

#[cfg(target_os = "linux")]
#[test]
fn b_검증한_뒤_임시_파일이_바뀌거나_이름이_다른_것으로_바뀌면_게시하지_않고_남의_것은_지우지_않는다(
) {
    use std::io::Write;
    let original = basic::basic_ko().unwrap();
    let not_published = Some(DocumentError::SaveFailure {
        stage: SaveStage::Publish,
        io: None,
    });
    type Case = (&'static str, Box<dyn Fn(&Path, &Path)>, &'static [u8]);
    let cases: Vec<Case> = vec![
        // 같은 inode의 내용이 바뀜(검증 뒤 쓰기).
        (
            "modified",
            Box::new(|_: &Path, staged: &Path| {
                std::fs::OpenOptions::new()
                    .append(true)
                    .open(staged)
                    .unwrap()
                    .write_all(b"tail")
                    .unwrap()
            }),
            b"",
        ),
        // 이름이 다른 일반 파일로 바뀜(검증한 inode가 아님): 그 파일은 남의 것이라 지우지 않는다.
        (
            "replaced",
            Box::new(|_: &Path, staged: &Path| {
                let other = staged.with_extension("other");
                std::fs::write(&other, b"someone else").unwrap();
                std::fs::rename(&other, staged).unwrap();
            }),
            b"someone else",
        ),
        // 이름이 심볼릭 링크로 바뀜: 링크도 지우지 않는다.
        (
            "symlink",
            Box::new(|target: &Path, staged: &Path| {
                std::fs::remove_file(staged).unwrap();
                std::os::unix::fs::symlink(target.with_extension("elsewhere"), staged).unwrap();
            }),
            b"link",
        ),
        // 이름이 사라짐.
        (
            "removed",
            Box::new(|_: &Path, staged: &Path| std::fs::remove_file(staged).unwrap()),
            b"",
        ),
    ];
    for (name, hook, kept) in cases {
        let mut doc = open_docx(&original);
        doc.edit(edits());
        doc.preflight().unwrap();
        assert_eq!(save_hooked(&doc, hook).err(), not_published, "{name}");
        assert_eq!(doc.bytes(), original, "{name}: 원본 그대로");
        let left = doc.leftovers();
        match kept {
            b"" => assert_eq!(
                left,
                Vec::<String>::new(),
                "{name}: 이 저장의 임시 파일은 지운다"
            ),
            b"link" => {
                assert_eq!(left.len(), 1, "{name}: {left:?}");
                assert!(std::fs::symlink_metadata(doc.dir.path().join(&left[0]))
                    .unwrap()
                    .file_type()
                    .is_symlink());
            }
            content => {
                assert_eq!(left.len(), 1, "{name}: {left:?}");
                assert_eq!(
                    std::fs::read(doc.dir.path().join(&left[0])).unwrap(),
                    content,
                    "{name}: 남의 파일 그대로"
                );
            }
        }
        // 다시 저장할 수 있다(원본 기록 그대로).
        for file in left {
            std::fs::remove_file(doc.dir.path().join(file)).unwrap();
        }
        assert!(doc.save().is_ok(), "{name}");
    }
    // 저장 중 원본 이름이 다른 파일로 바뀜: 충돌, 바뀐 파일 그대로, 이 저장의 임시 파일은 지운다.
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    let saved = save_hooked(&doc, |target, _| {
        let other = target.with_extension("swap");
        std::fs::write(&other, b"replacement").unwrap();
        std::fs::rename(&other, target).unwrap();
    });
    assert_eq!(saved.err(), Some(DocumentError::FileConflict));
    assert_eq!(doc.bytes(), b"replacement");
    assert_eq!(doc.leftovers(), Vec::<String>::new());
}

#[cfg(target_os = "linux")]
#[test]
fn b_게시한_파일은_검증한_inode와_내용이고_권한은_원본_그대로다() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx_prepared(&original, |path| {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o640)).unwrap()
    });
    doc.edit(edits());
    doc.preflight().unwrap();
    let seen = std::rc::Rc::new(std::cell::Cell::new((0u64, 0u64, 0u32)));
    let record = seen.clone();
    let saved = save_hooked(&doc, move |_, staged| {
        let meta = std::fs::symlink_metadata(staged).unwrap();
        record.set((meta.dev(), meta.ino(), meta.mode() & 0o7777));
    })
    .unwrap();
    assert!(saved.durable);
    let published = std::fs::symlink_metadata(&doc.path).unwrap();
    let (dev, ino, staged_mode) = seen.get();
    assert_eq!(
        (published.dev(), published.ino()),
        (dev, ino),
        "검증한 임시 파일의 inode가 게시됨"
    );
    // 게시 전 임시 파일은 이 사용자만 쓸 수 있고, 게시한 파일은 원본 권한.
    assert_eq!(staged_mode & 0o022, 0);
    assert_eq!(published.mode() & 0o7777, 0o640);
    let model = doc
        .state
        .wordcraft()
        .get(doc.info.session_id, doc.info.load_generation)
        .unwrap();
    assert_eq!(doc.bytes(), model.lock().unwrap().export().unwrap());
    assert_eq!(doc.leftovers(), Vec::<String>::new());
}

#[cfg(target_os = "linux")]
#[test]
fn e_임시_파일을_만든_직후의_실패도_이_저장의_임시_파일만_지운다() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    // 첫 후보 이름을 미리 차지한다(남의 파일·중단된 저장): 그 파일은 그대로, 이 저장이 만든 파일은 지운다.
    let (failed, names) = with_names(
        &doc,
        |i| (i == 0).then_some(Squat::File(b"earlier")),
        || save_with_fault(&doc, Some(Fault::AfterCreate)),
    );
    let taken = names[0].clone();
    assert_eq!(names.len(), 2);
    assert_eq!(
        failed.err(),
        Some(DocumentError::SaveFailure {
            stage: SaveStage::Write,
            io: Some(IoProblem::Other)
        })
    );
    assert_eq!(doc.bytes(), original);
    assert_eq!(doc.leftovers(), vec![taken.clone()]);
    assert_eq!(
        std::fs::read(doc.dir.path().join(&taken)).unwrap(),
        b"earlier"
    );
    // 쓰기·되읽기·교체 실패도 이 저장의 파일만 지운다.
    for fault in [
        Fault::Write(std::io::ErrorKind::StorageFull),
        Fault::Verify,
        Fault::Rename(std::io::ErrorKind::PermissionDenied),
    ] {
        assert!(save_with_fault(&doc, Some(fault)).is_err(), "{fault:?}");
        assert_eq!(doc.bytes(), original, "{fault:?}");
        assert_eq!(doc.leftovers(), vec![taken.clone()], "{fault:?}");
    }
    // 성공한 게시는 게시한 파일을 지우지 않는다.
    std::fs::remove_file(doc.dir.path().join(&taken)).unwrap();
    assert!(doc.save().is_ok());
    assert_ne!(doc.bytes(), original);
    assert_eq!(doc.leftovers(), Vec::<String>::new());
}

#[cfg(target_os = "linux")]
#[test]
fn b_교체_직후_원본_이름이_이_저장의_파일이_아니면_내구성_미확인이고_다음_저장은_충돌이다() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    let saved = save_with_fault(&doc, Some(Fault::SwapAfterRename)).unwrap();
    assert!(!saved.durable);
    assert!(saved.session.dirty);
    assert_eq!(doc.bytes(), b"swapped");
    // 기록한 파일은 이 저장이 쓴 inode다: 이름의 파일은 다르므로 덮어쓰지 않는다.
    assert_eq!(doc.preflight().err(), Some(DocumentError::FileConflict));
    assert_eq!(doc.save().err(), Some(DocumentError::FileConflict));
    assert_eq!(doc.bytes(), b"swapped");
}

// ---- T009 3차 안정화 C: 내용이 없는 미리보기의 증명은 PNG 전체가 엄격한 규칙을 만족할 때만 ----

/// PNG 덩어리 하나(올바른 CRC).
fn png_chunk(kind: &[u8], body: &[u8]) -> Vec<u8> {
    let mut crc = flate2::Crc::new();
    crc.update(kind);
    crc.update(body);
    [
        &(body.len() as u32).to_be_bytes()[..],
        kind,
        body,
        &crc.sum().to_be_bytes(),
    ]
    .concat()
}

/// IHDR 본문(8비트, 압축·필터·비월 0).
fn ihdr(width: u32, height: u32, color: u8) -> Vec<u8> {
    [
        &width.to_be_bytes()[..],
        &height.to_be_bytes(),
        &[8, color, 0, 0, 0],
    ]
    .concat()
}

/// 흰색 RGBA `width`×`height`의 필터 0 줄들.
fn white_rows(width: usize, height: usize) -> Vec<u8> {
    (0..height)
        .flat_map(|_| std::iter::once(0).chain(std::iter::repeat_n(255u8, width * 4)))
        .collect()
}

fn zlib_of(raw: &[u8]) -> Vec<u8> {
    let mut zlib = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut zlib, raw).unwrap();
    zlib.finish().unwrap()
}

fn png_of(chunks: &[Vec<u8>]) -> Vec<u8> {
    [b"\x89PNG\r\n\x1a\n".to_vec(), chunks.concat()].concat()
}

#[test]
fn c_미리보기_png는_구조가_올바른_한_색이어도_깨졌어도_엔진_상수가_아니면_받지_않는다() {
    // 4차 안정화 C: 3차의 엄격한 구조 검사를 통과하던 한 색 PNG(첫 묶음)도, 깨진 PNG(나머지)도 받지 않는다.
    use super::preview::known_blank_png;
    let head = png_chunk(b"IHDR", &ihdr(4, 2, 6));
    let data = png_chunk(b"IDAT", &zlib_of(&white_rows(4, 2)));
    let end = png_chunk(b"IEND", b"");
    let ok = png_of(&[head.clone(), data.clone(), end.clone()]);
    assert!(!known_blank_png(&ok));
    // RGB·회색조, 허용 보조 덩어리(정확한 길이·값, 한 번, IDAT 앞).
    let rgb_rows: Vec<u8> = (0..2)
        .flat_map(|_| std::iter::once(0).chain([7u8; 12]))
        .collect();
    assert!(!known_blank_png(&png_of(&[
        png_chunk(b"IHDR", &ihdr(4, 2, 2)),
        png_chunk(b"IDAT", &zlib_of(&rgb_rows)),
        end.clone()
    ])));
    let srgb = png_chunk(b"sRGB", &[0]);
    let gama = png_chunk(b"gAMA", &45455u32.to_be_bytes());
    let phys = png_chunk(b"pHYs", &[0, 0, 0x0e, 0xc3, 0, 0, 0x0e, 0xc3, 1]);
    assert!(!known_blank_png(&png_of(&[
        head.clone(),
        srgb.clone(),
        gama.clone(),
        phys.clone(),
        data.clone(),
        end.clone()
    ])));
    // 나눠 쓴 IDAT(이어져 있음).
    let z = zlib_of(&white_rows(4, 2));
    let (a, b) = z.split_at(z.len() / 2);
    assert!(!known_blank_png(&png_of(&[
        head.clone(),
        png_chunk(b"IDAT", a),
        png_chunk(b"IDAT", b),
        end.clone()
    ])));
    let rejected: Vec<(&str, Vec<u8>)> = vec![
        (
            "IHDR 길이",
            png_of(&[
                png_chunk(b"IHDR", &[ihdr(4, 2, 6), vec![0]].concat()),
                data.clone(),
                end.clone(),
            ]),
        ),
        (
            "IHDR 너비 0",
            png_of(&[
                png_chunk(b"IHDR", &ihdr(0, 2, 6)),
                data.clone(),
                end.clone(),
            ]),
        ),
        (
            "IHDR 너비 2^31",
            png_of(&[
                png_chunk(b"IHDR", &ihdr(1 << 31, 1, 6)),
                data.clone(),
                end.clone(),
            ]),
        ),
        (
            "너무 큰 크기",
            png_of(&[
                png_chunk(b"IHDR", &ihdr(100_000, 100_000, 6)),
                data.clone(),
                end.clone(),
            ]),
        ),
        (
            "IHDR 압축 방법",
            png_of(&[
                png_chunk(b"IHDR", &[&ihdr(4, 2, 6)[..10], &[1, 0, 0]].concat()),
                data.clone(),
                end.clone(),
            ]),
        ),
        (
            "IHDR가 처음이 아님",
            png_of(&[srgb.clone(), head.clone(), data.clone(), end.clone()]),
        ),
        (
            "IHDR 두 번",
            png_of(&[head.clone(), head.clone(), data.clone(), end.clone()]),
        ),
        (
            "sRGB 길이 2",
            png_of(&[
                head.clone(),
                png_chunk(b"sRGB", &[0, 0]),
                data.clone(),
                end.clone(),
            ]),
        ),
        (
            "sRGB 값 9",
            png_of(&[
                head.clone(),
                png_chunk(b"sRGB", &[9]),
                data.clone(),
                end.clone(),
            ]),
        ),
        (
            "gAMA 길이 8",
            png_of(&[
                head.clone(),
                png_chunk(b"gAMA", &[0, 0, 0xb1, 0x8f, 0, 0, 0, 0]),
                data.clone(),
                end.clone(),
            ]),
        ),
        (
            "pHYs 단위 7",
            png_of(&[
                head.clone(),
                png_chunk(b"pHYs", &[0, 0, 0x0e, 0xc3, 0, 0, 0x0e, 0xc3, 7]),
                data.clone(),
                end.clone(),
            ]),
        ),
        (
            "pHYs 두 번",
            png_of(&[
                head.clone(),
                phys.clone(),
                phys.clone(),
                data.clone(),
                end.clone(),
            ]),
        ),
        (
            "보조 덩어리가 IDAT 뒤",
            png_of(&[head.clone(), data.clone(), srgb.clone(), end.clone()]),
        ),
        (
            "IDAT 사이 덩어리",
            png_of(&[
                head.clone(),
                png_chunk(b"IDAT", a),
                srgb.clone(),
                png_chunk(b"IDAT", b),
                end.clone(),
            ]),
        ),
        (
            "cHRM(32바이트 자유 값)",
            png_of(&[
                head.clone(),
                png_chunk(b"cHRM", &[0; 32]),
                data.clone(),
                end.clone(),
            ]),
        ),
        (
            "bKGD",
            png_of(&[
                head.clone(),
                png_chunk(b"bKGD", &[0; 6]),
                data.clone(),
                end.clone(),
            ]),
        ),
        (
            "tIME",
            png_of(&[
                head.clone(),
                png_chunk(b"tIME", &[7, 232, 1, 1, 0, 0, 0]),
                data.clone(),
                end.clone(),
            ]),
        ),
        (
            "tEXt",
            png_of(&[
                head.clone(),
                png_chunk(b"tEXt", b"Comment\0deleted"),
                data.clone(),
                end.clone(),
            ]),
        ),
        (
            "모르는 보조 덩어리",
            png_of(&[
                head.clone(),
                png_chunk(b"geUl", b""),
                data.clone(),
                end.clone(),
            ]),
        ),
        (
            "IEND 길이",
            png_of(&[head.clone(), data.clone(), png_chunk(b"IEND", b"x")]),
        ),
        ("IEND 없음", png_of(&[head.clone(), data.clone()])),
        ("IEND 뒤 바이트", [ok.clone(), b"x".to_vec()].concat()),
        ("잘림", ok[..ok.len() - 3].to_vec()),
        (
            "덩어리 길이가 끝을 넘음",
            png_of(&[
                head.clone(),
                [&0x7fff_ffffu32.to_be_bytes()[..], b"IDAT"].concat(),
            ]),
        ),
        (
            "덩어리 길이 2^31 이상",
            png_of(&[
                head.clone(),
                [&0xffff_fff0u32.to_be_bytes()[..], b"IDAT"].concat(),
                end.clone(),
            ]),
        ),
    ];
    for (name, png) in &rejected {
        assert!(!known_blank_png(png), "{name}");
    }
    // CRC 하나만 틀림.
    for at in [
        head.len() - 1,
        head.len() + data.len() - 1,
        ok.len() - 1 - 8,
    ] {
        let mut bad = ok.clone();
        bad[8 + at] ^= 1;
        assert!(!known_blank_png(&bad), "CRC at {at}");
    }
    // zlib: 머리 검사 값, 사전, 창 크기, Adler-32, deflate 뒤 바이트, 픽셀보다 긴·짧은 내용.
    let with_zlib = |z: Vec<u8>| png_of(&[head.clone(), png_chunk(b"IDAT", &z), end.clone()]);
    let good = zlib_of(&white_rows(4, 2));
    let mut check = good.clone();
    check[1] ^= 1;
    let mut dict = good.clone();
    dict[1] |= 0x20;
    let mut adler = good.clone();
    *adler.last_mut().unwrap() ^= 1;
    let window = [&[0x88u8, 0x1c][..], &good[2..]].concat(); // CINFO 8(창 64 KiB, 규격 밖), FCHECK는 맞음
    assert_eq!((0x88u16 * 256 + 0x1c) % 31, 0);
    let tail = [&good[..good.len() - 4], b"xx", &good[good.len() - 4..]].concat();
    for (name, z) in [
        ("FCHECK", check),
        ("FDICT", dict),
        ("CINFO", window),
        ("Adler-32", adler),
        ("deflate 뒤 바이트", tail),
        ("긴 내용", zlib_of(&[white_rows(4, 2), vec![0]].concat())),
        ("짧은 내용", zlib_of(&white_rows(4, 1))),
        (
            "필터 5",
            zlib_of(&[vec![5], vec![255; 16], vec![0], vec![255; 16]].concat()),
        ),
    ] {
        assert!(!known_blank_png(&with_zlib(z)), "{name}");
    }
    // 한 색이 아님.
    let mut rows = white_rows(4, 2);
    rows[3] = 0;
    assert!(!known_blank_png(&png_of(&[
        head.clone(),
        png_chunk(b"IDAT", &zlib_of(&rows)),
        end.clone()
    ])));
}

#[test]
fn c_고정_rhwp가_만드는_빈_hwpx_미리보기는_그_바이트일_때만_받는다() {
    use super::preview::{
        blank_utf16, blank_utf8, known_blank_png, RHWP_BLANK_PREVIEW_PNG, RHWP_BLANK_PREVIEW_TEXT,
    };
    // 고정 upstream Git 객체에서 추출한 독립 골든. 출처·SHA-256은 fixture의 provenance.json 참조.
    // include_str!: RHWP checkout 없이 실행하며 골든 누락은 컴파일 실패, 손상은 비교 실패다.
    // hex 표현은 원본 CRLF/바이너리를 변형 없이 추적하면서 보안 검사도 가능하게 한다.
    let decode = |hex: &str| -> Vec<u8> {
        let hex = hex.trim_end_matches('\n');
        assert_eq!(hex.len() % 2, 0);
        hex.as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    };
    let png = decode(include_str!(
        "../../../../tests/fixtures/rhwp/blank-preview/prv-image.hex"
    ));
    let text = decode(include_str!(
        "../../../../tests/fixtures/rhwp/blank-preview/prv-text-utf8.hex"
    ));
    let hwp_text = decode(include_str!(
        "../../../../tests/fixtures/rhwp/blank-preview/prv-text-utf16le.hex"
    ));
    assert_eq!(png, RHWP_BLANK_PREVIEW_PNG);
    assert_eq!(text, RHWP_BLANK_PREVIEW_TEXT);
    assert_eq!(text, b"\r\n");
    assert_eq!(hwp_text, utf16("\r\n"));
    assert_eq!(png.len(), 68);
    assert_eq!(RHWP_BLANK_PREVIEW_PNG.len(), 68);
    assert!(known_blank_png(RHWP_BLANK_PREVIEW_PNG));
    // 한 바이트·한 비트라도 다르면(같은 그림으로 풀리더라도) 받지 않는다.
    for at in [0, 20, 45, 52, 67] {
        let mut changed = RHWP_BLANK_PREVIEW_PNG.to_vec();
        changed[at] ^= 1;
        assert!(!known_blank_png(&changed), "{at}");
    }
    assert!(!known_blank_png(&[RHWP_BLANK_PREVIEW_PNG, b"x"].concat()));
    assert!(!known_blank_png(&RHWP_BLANK_PREVIEW_PNG[..67]));
    // 글 미리보기: 빈 값·줄바꿈 하나만. 그 밖의 제어 문자는 물론 공백 무늬도 받지 않는다.
    assert!(blank_utf8(b"\r\n") && blank_utf16(&utf16("\r\n")));
    for text in [
        "\u{1}",
        "\u{0}",
        "\u{7}\r\n",
        " \u{1F}",
        "\u{200B}",
        "\u{3000}",
        " \u{FEFF}",
        "\u{FEFF}\r\n",
        "  ",
    ] {
        assert!(
            !blank_utf16(&utf16(text)) && !blank_utf8(text.as_bytes()),
            "{text:?}"
        );
    }
}

// ---- T009 3차 안정화 D·F: 편집 면제는 구역 스트림만, FileHeader는 전체 ----

/// FileHeader 바이트를 직접 준 HWP(비압축).
fn hwp_doc_header(header: &[u8], extra: &[(&str, &[u8])]) -> Vec<u8> {
    let docinfo = docinfo(0, b"font");
    let body = section("hello");
    let mut streams: Vec<(&str, &[u8])> = vec![
        ("/FileHeader", header),
        ("/DocInfo", &docinfo),
        ("/BodyText/Section0", &body),
    ];
    streams.extend_from_slice(extra);
    crate::document::testutil::cfb(&streams)
}

#[test]
fn d_편집_저장에서_바뀔_수_있는_본문은_bodytext_section_n뿐이다() {
    let doc = |extra: &[(&str, &[u8])]| hwp_doc(0, &docinfo(0, b"font"), &section("hello"), extra);
    let (a, b) = (section("first"), section("second"));
    // 구역 스트림(Section0·Section12): 레코드로 끝까지 읽히면 내용은 다시 열기 몫.
    assert_eq!(
        hwp::compare_saved(
            &doc(&[("/BodyText/Section12", &a)]),
            &doc(&[("/BodyText/Section12", &b)])
        ),
        vec![]
    );
    assert_eq!(
        hwp::compare_saved(
            &hwp_doc(0, &docinfo(0, b"font"), &a, &[]),
            &hwp_doc(0, &docinfo(0, b"font"), &b, &[])
        ),
        vec![]
    );
    // 구역이 아닌 BodyText 아래 스트림: 레코드로 읽되 면제하지 않는다(바뀌면 RecordsChanged).
    for name in [
        "BodyText/CustomData",
        "BodyText/SectionX",
        "BodyText/Section.xml",
        "BodyText/Section01",
        "BodyText/Sub/Section0",
        "BodyText/Section",
    ] {
        let path = format!("/{name}");
        assert_eq!(
            hwp::compare_saved(&doc(&[(&path, &a)]), &doc(&[(&path, &b)])),
            vec![Finding::at(FindingCode::RecordsChanged, name)],
            "{name}"
        );
        // 같은 바이트라도 레코드가 깨졌으면 근거가 아니다(unknown).
        assert_eq!(
            hwp::compare_saved(&doc(&[(&path, b"\xff\xff")]), &doc(&[(&path, b"\xff\xff")])),
            vec![Finding::at(FindingCode::OriginalMalformed, name)],
            "{name}"
        );
    }
    // 구역이 생기거나 빠짐.
    assert_eq!(
        hwp::compare_saved(&doc(&[]), &doc(&[("/BodyText/Section1", &a)])),
        vec![Finding::at(FindingCode::PartAdded, "BodyText/Section1")]
    );
    assert_eq!(
        hwp::compare_saved(&doc(&[("/BodyText/Section1", &a)]), &doc(&[])),
        vec![Finding::at(FindingCode::PartMissing, "BodyText/Section1")]
    );
    // 구역이 아닌 스트림의 바뀜은 미리보기 낡음의 근거(본문 바뀜)가 아니다: 미리보기가 있어도 RecordsChanged 하나.
    let text = utf16("미리보기");
    assert_eq!(
        hwp::compare_saved(
            &doc(&[("/PrvText", &text), ("/BodyText/CustomData", &a)]),
            &doc(&[("/PrvText", &text), ("/BodyText/CustomData", &b)])
        ),
        vec![Finding::at(
            FindingCode::RecordsChanged,
            "BodyText/CustomData"
        )]
    );
}

#[test]
fn f_fileheader는_256바이트_전체를_비교하고_모르는_배치와_플래그는_판단하지_않는다() {
    use crate::document::testutil::hwp_file_header;
    let header = hwp_file_header(5, 0);
    let same = hwp_doc_header(&header, &[]);
    assert_eq!(hwp::compare(&same, &same), vec![]);
    let unsupported = vec![Finding::at(FindingCode::Unsupported, "FileHeader")];
    // 256바이트보다 긴 FileHeader: 바이트가 같아도, 뒤가 바뀌어도 판단하지 않는다(rhwp는 256바이트 배치만 안다).
    let long = [header.clone(), vec![7; 44]].concat();
    assert_eq!(
        hwp::compare(&hwp_doc_header(&long, &[]), &hwp_doc_header(&long, &[])),
        unsupported
    );
    let mut changed = long.clone();
    changed[299] ^= 1;
    assert_eq!(
        hwp::compare(&hwp_doc_header(&long, &[]), &hwp_doc_header(&changed, &[])),
        unsupported
    );
    // 출력만 길어짐: 출력이 올바르지 않다.
    assert_eq!(
        hwp::compare(&same, &hwp_doc_header(&long, &[])),
        vec![Finding::at(FindingCode::OutputMalformed, "FileHeader")]
    );
    // 짧음·서명 틀림: 원본을 읽을 수 없다.
    assert_eq!(
        hwp::compare(&hwp_doc_header(&header[..200], &[]), &same),
        vec![Finding::at(FindingCode::OriginalMalformed, "FileHeader")]
    );
    let mut signature = header.clone();
    signature[0] = b'X';
    assert_eq!(
        hwp::compare(&hwp_doc_header(&signature, &[]), &same),
        vec![Finding::at(FindingCode::OriginalMalformed, "FileHeader")]
    );
    // 예약 영역 바이트 하나만 달라도 다르다.
    let mut reserved = header.clone();
    reserved[200] = 1;
    assert_eq!(
        hwp::compare(&same, &hwp_doc_header(&reserved, &[])),
        vec![Finding::at(FindingCode::PartChanged, "FileHeader")]
    );
    // 판 5가 아님.
    let v4 = hwp_doc_header(&hwp_file_header(4, 0), &[]);
    assert_eq!(hwp::compare(&v4, &v4), unsupported);
    // 플래그: 압축(0x01)·스크립트(0x08)만 받는다. 암호·배포·DRM·XML 서식·문서 이력·전자 서명·공개키 암호·인증서·배포 준비·
    // 모르는 비트는 판단하지 않는다(편집하면 서명이 깨지는 등 지킬 수 없는 속성).
    let script = hwp_doc_header(&hwp_file_header(5, 0x08), &[]);
    assert_eq!(hwp::compare(&script, &script), vec![]);
    for flag in [
        0x02,
        0x04,
        0x10,
        0x20,
        0x40,
        0x80,
        0x100,
        0x200,
        0x400,
        0x800,
        0x8000_0000,
    ] {
        let flagged = hwp_doc_header(&hwp_file_header(5, flag), &[]);
        assert_eq!(hwp::compare(&flagged, &flagged), unsupported, "{flag:#x}");
        assert_eq!(
            hwp::compare_saved(&flagged, &flagged),
            unsupported,
            "{flag:#x}"
        );
    }
    // 지원하는 플래그가 바뀜(압축 → 비압축): FileHeader가 다르다.
    assert_eq!(
        hwp::compare(&same, &hwp_doc_header(&hwp_file_header(5, 0x08), &[])),
        vec![Finding::at(FindingCode::PartChanged, "FileHeader")]
    );
}

#[test]
fn d_hwpx_편집_면제도_rhwp가_쓰는_구역_이름만이다() {
    assert!(
        package::hwpx_body("Contents/section0.xml") && package::hwpx_body("Contents/section12.xml")
    );
    for name in [
        "Contents/section01.xml",
        "Contents/section.xml",
        "Contents/sectionX.xml",
        "Contents/section0.xml.bak",
        "Contents/sub/section0.xml",
    ] {
        assert!(!package::hwpx_body(name), "{name}");
    }
    let with = |text: &str| {
        let mut entries = hwpx_package("<sec/>", "<head/>", true, true);
        entries.push(entry("Contents/section01.xml", text.as_bytes()));
        pkg(&entries)
    };
    assert_eq!(
        package::compare_saved_hwpx(&with("<a>1</a>"), &with("<a>2</a>")),
        vec![Finding::at(
            FindingCode::PartChanged,
            "Contents/section01.xml"
        )]
    );
}

// ---- T009 4차 안정화 B: 압축으로 정해진 BinData는 바이트가 같아도 끝까지 풀려야 한다 ----

#[test]
fn b4_압축으로_정해진_bindata는_바이트가_같아도_끝까지_풀려야_한다() {
    let image = b"\x89PNG image bytes ".repeat(40);
    let encode = |level: u32, data: &[u8]| {
        let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::new(level));
        std::io::Write::write_all(&mut e, data).unwrap();
        e.finish().unwrap()
    };
    let (fast, best) = (encode(1, &image), encode(9, &image));
    let name = "BinData/BIN0001.png";
    // 압축 속성(`compression`)과 문서 압축 플래그(`flags`)로 BIN0001.png를 선언한 HWP. `stream_name`의 스트림을 둔다.
    let doc_named = |flags: u32, records: &[Vec<u8>], stream_name: &str, stream: &[u8]| {
        let mut di = docinfo(0, b"font");
        for record in records {
            di.extend_from_slice(record);
        }
        let (di, body) = if flags & 1 != 0 {
            (
                crate::document::testutil::deflate(&di),
                crate::document::testutil::deflate(&section("hello")),
            )
        } else {
            (di, section("hello"))
        };
        hwp_doc(flags, &di, &body, &[(stream_name, stream)])
    };
    let doc = |flags: u32, compression: u16, stream: &[u8]| {
        doc_named(
            flags,
            &[bin_data(1, "png", compression)],
            "/BinData/BIN0001.png",
            stream,
        )
    };
    let at = |code: FindingCode, part: &str| vec![Finding::at(code, part)];
    let original_malformed = at(FindingCode::OriginalMalformed, name);
    // 잘린 deflate(앞 절반), 끝 블록 표시(BFINAL) 없이 끝나는 저장 블록.
    let truncated = fast[..fast.len() / 2].to_vec();
    let unfinished = [&[0x00u8, 0x04, 0x00, 0xFB, 0xFF][..], b"data"].concat();
    let mut crc = flate2::Crc::new();
    crc.update(&image);
    let tail = |crc_value: u32, len: u32| [crc_value.to_le_bytes(), len.to_le_bytes()].concat();
    let hancom = [fast.clone(), tail(crc.sum(), image.len() as u32)].concat();
    let bad_crc = [fast.clone(), tail(crc.sum() ^ 1, image.len() as u32)].concat();
    let bad_len = [fast.clone(), tail(crc.sum(), image.len() as u32 + 1)].concat();
    let junk = [fast.clone(), b"tail".to_vec()].concat();
    let long_tail = [hancom.clone(), vec![0]].concat();
    // BIN_DATA 레코드: 형식 비트(0–3)·압축 비트(4–5)를 직접 정한다.
    let raw_bin = |attr: u16, rest: &[u8]| record(18, 1, &[&attr.to_le_bytes()[..], rest].concat());
    type Case = (&'static str, Vec<u8>, Vec<u8>, Vec<Finding>);
    let cases: Vec<Case> = vec![
        // 1. 같은 바이트의 올바른 압축 BinData.
        (
            "identical-valid",
            doc(0, 1, &fast),
            doc(0, 1, &fast),
            vec![],
        ),
        // 2·3. 같은 바이트의 깨진·잘린·끝나지 않은 deflate: 원본을 해석할 수 없다(unknown).
        (
            "identical-malformed",
            doc(0, 1, b"\xff\xff"),
            doc(0, 1, b"\xff\xff"),
            original_malformed.clone(),
        ),
        (
            "identical-truncated",
            doc(0, 1, &truncated),
            doc(0, 1, &truncated),
            original_malformed.clone(),
        ),
        (
            "identical-unfinished",
            doc(0, 1, &unfinished),
            doc(0, 1, &unfinished),
            original_malformed.clone(),
        ),
        (
            "identical-empty",
            doc(0, 1, b""),
            doc(0, 1, b""),
            original_malformed.clone(),
        ),
        // 4. 같은 내용의 다른 deflate 표현: 같다.
        ("equivalent", doc(0, 1, &fast), doc(0, 1, &best), vec![]),
        // 5. 푼 내용이 다름.
        (
            "different",
            doc(0, 1, &fast),
            doc(0, 1, &encode(9, b"other")),
            at(FindingCode::PartChanged, name),
        ),
        // 6·7. 한쪽만 깨짐.
        (
            "output-malformed",
            doc(0, 1, &fast),
            doc(0, 1, &truncated),
            at(FindingCode::OutputMalformed, name),
        ),
        (
            "original-malformed",
            doc(0, 1, &truncated),
            doc(0, 1, &fast),
            original_malformed.clone(),
        ),
        (
            "original-unfinished",
            doc(0, 1, &unfinished),
            doc(0, 1, &fast),
            original_malformed.clone(),
        ),
        // 8·9·10. 한컴 8바이트 꼬리: 맞으면 받고, CRC·길이가 틀리거나 그 밖의 남는 바이트는 같은 바이트여도 받지 않는다.
        (
            "identical-hancom-tail",
            doc(0, 1, &hancom),
            doc(0, 1, &hancom),
            vec![],
        ),
        (
            "hancom-tail-vs-plain",
            doc(0, 1, &hancom),
            doc(0, 1, &best),
            vec![],
        ),
        (
            "identical-bad-crc",
            doc(0, 1, &bad_crc),
            doc(0, 1, &bad_crc),
            original_malformed.clone(),
        ),
        (
            "identical-bad-length",
            doc(0, 1, &bad_len),
            doc(0, 1, &bad_len),
            original_malformed.clone(),
        ),
        (
            "identical-junk-tail",
            doc(0, 1, &junk),
            doc(0, 1, &junk),
            original_malformed.clone(),
        ),
        (
            "identical-long-tail",
            doc(0, 1, &long_tail),
            doc(0, 1, &long_tail),
            original_malformed.clone(),
        ),
        (
            "output-bad-crc",
            doc(0, 1, &fast),
            doc(0, 1, &bad_crc),
            at(FindingCode::OutputMalformed, name),
        ),
        // 12. 문서 압축 플래그를 따르는 속성(0): 압축 문서면 검사하고, 비압축(속성 2·비압축 문서의 0)은 불투명 바이트로 같다.
        (
            "default-compressed-malformed",
            doc(1, 0, b"\xff\xff"),
            doc(1, 0, b"\xff\xff"),
            original_malformed.clone(),
        ),
        (
            "explicit-stored",
            doc(1, 2, b"\xff\xff"),
            doc(1, 2, b"\xff\xff"),
            vec![],
        ),
        (
            "default-stored",
            doc(0, 0, b"\xff\xff"),
            doc(0, 0, b"\xff\xff"),
            vec![],
        ),
        // 13. 예약 압축 값(3): 저장 형태를 정할 수 없다(unknown).
        (
            "reserved-compression",
            doc(0, 3, &fast),
            doc(0, 3, &fast),
            at(FindingCode::Unsupported, name),
        ),
        // 14. 같은 이름의 선언이 둘: 형태가 같으면 그 형태로 검사, 다르면 정할 수 없다.
        (
            "duplicate-consistent",
            doc_named(
                0,
                &[bin_data(1, "png", 1), bin_data(1, "png", 1)],
                "/BinData/BIN0001.png",
                b"\xff\xff",
            ),
            doc_named(
                0,
                &[bin_data(1, "png", 1), bin_data(1, "png", 1)],
                "/BinData/BIN0001.png",
                b"\xff\xff",
            ),
            original_malformed.clone(),
        ),
        (
            "duplicate-conflicting",
            doc_named(
                0,
                &[bin_data(1, "png", 1), bin_data(1, "png", 2)],
                "/BinData/BIN0001.png",
                &fast,
            ),
            doc_named(
                0,
                &[bin_data(1, "png", 1), bin_data(1, "png", 2)],
                "/BinData/BIN0001.png",
                &fast,
            ),
            at(FindingCode::Unsupported, name),
        ),
        // 15. 이름: CFB 이름은 대소문자를 가리지 않는다(엔진도 그렇게 찾는다). 선언이 없는 스트림(확장자 다름)은 엔진이
        //     그대로 옮기는 불투명 바이트, 선언만 있고 스트림이 없으면 비교할 것이 없다.
        (
            "case-insensitive-name",
            doc_named(
                0,
                &[bin_data(1, "PNG", 1)],
                "/BinData/BIN0001.png",
                b"\xff\xff",
            ),
            doc_named(
                0,
                &[bin_data(1, "PNG", 1)],
                "/BinData/BIN0001.png",
                b"\xff\xff",
            ),
            original_malformed.clone(),
        ),
        (
            "undeclared-stream",
            doc_named(
                0,
                &[bin_data(1, "jpg", 1)],
                "/BinData/BIN0001.png",
                b"\xff\xff",
            ),
            doc_named(
                0,
                &[bin_data(1, "jpg", 1)],
                "/BinData/BIN0001.png",
                b"\xff\xff",
            ),
            vec![],
        ),
        (
            "declared-missing",
            doc_named(
                0,
                &[bin_data(2, "png", 1)],
                "/BinData/BIN0001.png",
                b"\xff\xff",
            ),
            doc_named(
                0,
                &[bin_data(2, "png", 1)],
                "/BinData/BIN0001.png",
                b"\xff\xff",
            ),
            vec![],
        ),
        (
            "non-ascii-name",
            doc_named(
                0,
                &[bin_data(1, "png", 1)],
                "/BinData/BIN0001.pñg",
                b"\xff\xff",
            ),
            doc_named(
                0,
                &[bin_data(1, "png", 1)],
                "/BinData/BIN0001.pñg",
                b"\xff\xff",
            ),
            at(FindingCode::Unsupported, "BinData/BIN0001.pñg"),
        ),
        // 해석할 수 없는 BIN_DATA 레코드(확장자가 레코드 끝을 넘음·짝이 맞지 않는 UTF-16·예약 형식): 어느 스트림을 어떻게
        // 읽는지 정할 수 없다.
        (
            "truncated-declaration",
            doc_named(
                0,
                &[raw_bin(0x11, &[1, 0, 3, 0, b'p', 0])],
                "/BinData/BIN0001.png",
                &fast,
            ),
            doc_named(
                0,
                &[raw_bin(0x11, &[1, 0, 3, 0, b'p', 0])],
                "/BinData/BIN0001.png",
                &fast,
            ),
            at(FindingCode::OriginalMalformed, "DocInfo"),
        ),
        (
            "invalid-utf16-declaration",
            doc_named(
                0,
                &[raw_bin(0x11, &[1, 0, 1, 0, 0x00, 0xD8])],
                "/BinData/BIN0001.png",
                &fast,
            ),
            doc_named(
                0,
                &[raw_bin(0x11, &[1, 0, 1, 0, 0x00, 0xD8])],
                "/BinData/BIN0001.png",
                &fast,
            ),
            at(FindingCode::OriginalMalformed, "DocInfo"),
        ),
        (
            "reserved-type",
            doc_named(
                0,
                &[raw_bin(0x13, &[1, 0, 3, 0, b'p', 0, b'n', 0, b'g', 0])],
                "/BinData/BIN0001.png",
                &fast,
            ),
            doc_named(
                0,
                &[raw_bin(0x13, &[1, 0, 3, 0, b'p', 0, b'n', 0, b'g', 0])],
                "/BinData/BIN0001.png",
                &fast,
            ),
            at(FindingCode::Unsupported, "DocInfo"),
        ),
        // 저장소(OLE) 형식은 확장자가 없으면 엔진처럼 `OLE`로 정한다.
        (
            "storage-default-extension",
            doc_named(
                0,
                &[raw_bin(0x12, &[1, 0])],
                "/BinData/BIN0001.OLE",
                b"\xff\xff",
            ),
            doc_named(
                0,
                &[raw_bin(0x12, &[1, 0])],
                "/BinData/BIN0001.OLE",
                b"\xff\xff",
            ),
            at(FindingCode::OriginalMalformed, "BinData/BIN0001.OLE"),
        ),
    ];
    let mut wrong = Vec::new();
    for (case, original, output, expected) in &cases {
        let found = hwp::compare(original, output);
        if &found != expected {
            wrong.push(format!("{case}: {found:?} != {expected:?}"));
        }
        // 편집한 저장의 비교도 같은 규칙(본문 밖).
        let saved = hwp::compare_saved(original, output);
        if &saved != expected {
            wrong.push(format!("{case} (saved): {saved:?} != {expected:?}"));
        }
    }
    // 11. 풀어낸 크기 상한: 넘으면 어느 쪽이든 판단하지 않는다(unknown). 상한은 시험에서만 낮춘다.
    hwp::INFLATE_LIMIT.with(|limit| limit.set(Some(image.len() as u64 - 1)));
    let limited = [
        (
            "limit-identical",
            hwp::compare(&doc(0, 1, &fast), &doc(0, 1, &fast)),
        ),
        (
            "limit-original",
            hwp::compare(&doc(0, 1, &fast), &doc(0, 1, &encode(9, b"small"))),
        ),
        (
            "limit-output",
            hwp::compare(&doc(0, 1, &encode(9, b"small")), &doc(0, 1, &fast)),
        ),
    ];
    hwp::INFLATE_LIMIT.with(|limit| limit.set(None));
    for (case, found) in limited {
        if found != at(FindingCode::LimitExceeded, name) {
            wrong.push(format!("{case}: {found:?}"));
        }
    }
    // 레코드 스트림도 끝까지 끝나야 한다: 끝 블록 없이 끝난 DocInfo는 같은 바이트여도 unknown.
    let unfinished_docinfo = |_: ()| {
        let di = docinfo(0, b"font");
        let mut stored = vec![0x00u8];
        stored.extend_from_slice(&(di.len() as u16).to_le_bytes());
        stored.extend_from_slice(&(!(di.len() as u16)).to_le_bytes());
        stored.extend_from_slice(&di);
        hwp_doc(
            1,
            &stored,
            &crate::document::testutil::deflate(&section("hello")),
            &[],
        )
    };
    let found = hwp::compare(&unfinished_docinfo(()), &unfinished_docinfo(()));
    if found != at(FindingCode::OriginalMalformed, "DocInfo") {
        wrong.push(format!("unfinished-docinfo: {found:?}"));
    }
    let found = hwp::compare(&unfinished_docinfo(()), &doc(1, 0, &fast));
    if !found.contains(&Finding::at(FindingCode::OriginalMalformed, "DocInfo")) {
        wrong.push(format!("unfinished-docinfo vs valid: {found:?}"));
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

// ---- T009 4차 안정화 A: 원본까지의 모든 상위 디렉터리를 다른 사용자가 바꿀 수 없어야 한다 ----

/// 불러오기 전에 `dir` 아래 `relative`에 둔 DOCX 세션(상위 디렉터리를 시험마다 만든다).
#[cfg(target_os = "linux")]
fn open_docx_in(dir: TempDir, relative: &str, bytes: &[u8]) -> Docx {
    let path = dir.path().join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, bytes).unwrap();
    let state = DocumentState::default();
    let file = identify(path.to_str().unwrap(), &Limits::default()).unwrap();
    let info = state.registry().register(file).unwrap();
    let loaded = block_on(docx::load(&state, info.session_id, None)).expect("불러오기");
    Docx {
        state,
        dir,
        path,
        info: loaded.session,
    }
}

/// 같은 부모 안의 두 디렉터리 항목을 맞바꾼다(그 부모에 쓸 수 있는 사용자가 할 수 있는 일).
#[cfg(target_os = "linux")]
fn exchange(a: &Path, b: &Path) {
    let parked = a.with_extension("parked");
    std::fs::rename(a, &parked).unwrap();
    std::fs::rename(b, a).unwrap();
    std::fs::rename(&parked, b).unwrap();
}

/// 시험용 훅 자리(`publish`의 스레드 지역 값)와 거기 걸 훅들.
#[cfg(target_os = "linux")]
type HookSlot = &'static std::thread::LocalKey<std::cell::RefCell<Option<super::publish::Hook>>>;
#[cfg(target_os = "linux")]
type Hooks = Vec<(HookSlot, Box<dyn Fn(&Path, &Path)>)>;
/// 경합 사례: 이름, 공유 디렉터리를 받아 훅을 만드는 함수, 기대 오류.
#[cfg(target_os = "linux")]
type RaceCase = (&'static str, Box<dyn Fn(&Path) -> Hooks>, DocumentError);
/// 미리보기 운반체: 이름, 바이트, 그 바이트에서 비밀을 꺼내는 함수.
type Carrier = (&'static str, Vec<u8>, Box<dyn Fn(&[u8]) -> Vec<u8>>);

/// 시험용 훅을 걸고 저장한다(같은 스레드). 훅이 불린 횟수를 돌려준다.
#[cfg(target_os = "linux")]
fn save_with_hooks(doc: &Docx, hooks: Hooks) -> (Result<SaveOutcome, DocumentError>, usize) {
    let calls = std::rc::Rc::new(std::cell::Cell::new(0usize));
    let keys: Vec<_> = hooks.iter().map(|(key, _)| *key).collect();
    for (key, hook) in hooks {
        let calls = calls.clone();
        key.with(|cell| {
            *cell.borrow_mut() = Some(Box::new(move |a: &Path, b: &Path| {
                calls.set(calls.get() + 1);
                hook(a, b)
            }))
        });
    }
    let result = save_with_fault(doc, None);
    for key in keys {
        key.with(|cell| *cell.borrow_mut() = None);
    }
    (result, calls.get())
}

#[cfg(target_os = "linux")]
#[test]
fn a4_다른_사용자가_이름을_바꿀_수_있는_상위_디렉터리_아래의_원본은_저장하지_않는다() {
    use super::publish::{AFTER_STAGE, BEFORE_CREATE, BEFORE_RENAME};
    use std::os::unix::fs::PermissionsExt;
    let original = basic::basic_ko().unwrap();
    // root/shared(0777, sticky 없음)/docs(0700)/a.docx, 같은 부모의 root/shared/other(0755)/a.docx(남의 것).
    let root = TempDir::new();
    let shared = root.path().join("shared");
    let docs = shared.join("docs");
    let other = shared.join("other");
    let mut doc = open_docx_in(root, "shared/docs/a.docx", &original);
    std::fs::create_dir(&other).unwrap();
    std::fs::write(other.join("a.docx"), b"unrelated").unwrap();
    std::fs::set_permissions(&docs, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();
    doc.edit(edits());
    doc.preflight().unwrap();
    // 다른 사용자(shared에 쓸 수 있다)가 docs와 other를 맞바꾸는 흉내: 임시 파일을 만들기 전, 임시 파일을 다 쓴 뒤
    // (되돌림: 원본 다시 읽기·확인은 진짜 docs를 본다), 교체 직전.
    let (d1, o1) = (docs.clone(), other.clone());
    let (d2, o2) = (docs.clone(), other.clone());
    let (d3, o3) = (docs.clone(), other.clone());
    let (saved, calls) = save_with_hooks(
        &doc,
        vec![
            (&BEFORE_CREATE, Box::new(move |_, _| exchange(&d1, &o1))),
            (&AFTER_STAGE, Box::new(move |_, _| exchange(&d2, &o2))),
            (&BEFORE_RENAME, Box::new(move |_, _| exchange(&d3, &o3))),
        ],
    );
    // 관찰: 어느 디렉터리 객체의 a.docx가 바뀌었나(맞바꾼 횟수가 홀수면 docs 경로에 other가 있다).
    let (real, unrelated) = if calls % 2 == 1 {
        (other.join("a.docx"), docs.join("a.docx"))
    } else {
        (docs.join("a.docx"), other.join("a.docx"))
    };
    let observed = format!(
        "saved={:?} hooks={calls} 원본_그대로={} 남의_파일_그대로={}",
        saved.as_ref().map(|o| (o.durable, o.session.dirty)),
        std::fs::read(&real).unwrap() == original,
        std::fs::read(&unrelated).unwrap() == b"unrelated",
    );
    assert_eq!(
        saved.as_ref().err(),
        Some(&DocumentError::SaveUnsupported {
            reason: SaveUnsupportedReason::SharedDirectory
        }),
        "{observed}"
    );
    assert_eq!(calls, 0, "임시 파일을 만들기 전에 거부: {observed}");
    assert_eq!(std::fs::read(&doc.path).unwrap(), original);
    assert_eq!(std::fs::read(other.join("a.docx")).unwrap(), b"unrelated");
    assert_eq!(doc.leftovers(), Vec::<String>::new());
    let others: Vec<_> = std::fs::read_dir(&other)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(others, vec![std::ffi::OsString::from("a.docx")]);
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o755)).unwrap();
    doc.edit(edits());
    assert!(doc.info.dirty);
}

/// 저장에 성공했으면 세션이 깨끗하고, 기록한 파일(새 inode·지문)이 디스크와 같아 사전 검사를 다시 할 수 있다.
#[cfg(target_os = "linux")]
fn assert_published(doc: &mut Docx, saved: SaveOutcome, label: &str) {
    assert!(saved.durable, "{label}");
    assert!(!saved.session.dirty, "{label}");
    doc.info = saved.session;
    assert!(
        doc.preflight()
            .is_ok_and(|check| check.preservation.is_safe()),
        "{label}: 기록한 지문이 게시한 파일과 같다"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn a4_상위_디렉터리는_권한과_acl로_다른_사용자가_항목을_바꿀_수_없을_때만_저장한다() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let original = basic::basic_ko().unwrap();
    let set = |path: &Path, bits: u32| {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(bits)).unwrap()
    };
    let shared = Some(DocumentError::SaveUnsupported {
        reason: SaveUnsupportedReason::SharedDirectory,
    });
    // 시험 디렉터리의 실제 상위(뿌리·임시 디렉터리)는 root나 이 사용자 소유다(root 소유 상위를 믿는 경우).
    let probe = TempDir::new();
    assert!(probe
        .path()
        .ancestors()
        .skip(1)
        .any(|dir| std::fs::metadata(dir).unwrap().uid() == 0));
    // 원본에서 두 단계 위(level1) 권한: 소유자만 쓰기(0700·0755·0711·읽기 없는 0311), 이 사용자 소유 sticky(1777)는 저장,
    // 그룹·그 밖 쓰기(sticky 없음)는 막는다.
    for (bits, expected) in [
        (0o700, None),
        (0o755, None),
        (0o711, None),
        (0o311, None),
        (0o1777, None),
        (0o775, shared.clone()),
        (0o770, shared.clone()),
        (0o757, shared.clone()),
        (0o777, shared.clone()),
    ] {
        let mut doc = open_docx_in(TempDir::new(), "level1/level2/a.docx", &original);
        let level1 = doc.path.parent().unwrap().parent().unwrap().to_path_buf();
        set(&level1, bits);
        doc.edit(edits());
        doc.preflight().unwrap();
        let saved = doc.save();
        assert_eq!(saved.as_ref().err(), expected.as_ref(), "{bits:o}");
        assert_eq!(doc.bytes() == original, expected.is_some(), "{bits:o}");
        assert_eq!(doc.leftovers(), Vec::<String>::new(), "{bits:o}");
        match saved {
            Ok(saved) => assert_published(&mut doc, saved, &format!("{bits:o}")),
            Err(_) => assert!(doc.info.dirty, "{bits:o}: 거부한 저장은 dirty 그대로"),
        }
        set(&level1, 0o755);
    }
    // 상위의 접근 ACL: 다른 사용자에게 읽기·찾기만 주면 저장, 쓰기 항목이 있으면 마스크가 막아도(보수적) 막는다.
    let acl = |path: &Path, spec: &str| {
        std::process::Command::new("setfacl")
            .args(["-m", spec])
            .arg(path)
            .status()
            .is_ok_and(|status| status.success())
    };
    for (spec, expected) in [
        ("u:65534:r-x", None),
        ("g:65534:--x", None),
        ("u:65534:rwx,m::r-x", shared.clone()),
        ("u:65534:rwx", shared.clone()),
    ] {
        let mut doc = open_docx_in(TempDir::new(), "level1/level2/a.docx", &original);
        let level1 = doc.path.parent().unwrap().parent().unwrap().to_path_buf();
        if !acl(&level1, spec) {
            eprintln!("NOT RUN: 상위 디렉터리 ACL {spec}(setfacl 없음 또는 파일 시스템 미지원)");
            continue;
        }
        doc.edit(edits());
        doc.preflight().unwrap();
        let saved = doc.save();
        assert_eq!(saved.as_ref().err(), expected.as_ref(), "{spec}");
        assert_eq!(doc.bytes() == original, expected.is_some(), "{spec}");
        assert_eq!(doc.leftovers(), Vec::<String>::new(), "{spec}");
        if let Ok(saved) = saved {
            assert_published(&mut doc, saved, spec);
        }
    }
}

#[cfg(target_os = "linux")]
#[test]
fn a4_믿는_경로가_저장_중_움직이면_확인한_디렉터리에서만_일하고_게시하지_않는다() {
    use super::publish::{AFTER_STAGE, BEFORE_CREATE, BEFORE_RENAME};
    let original = basic::basic_ko().unwrap();
    let not_published = DocumentError::SaveFailure {
        stage: SaveStage::Publish,
        io: None,
    };
    let missing = DocumentError::Unreadable {
        reason: crate::document::ReadProblem::NotFound,
    };
    // root/shared(0755)/docs(0700)/a.docx와 같은 부모의 root/shared/other(0755)/a.docx(남의 것). 믿는 쪽(이 사용자)의
    // 경합 흉내: 위협 모델 밖이지만 결과는 정직해야 한다(다른 디렉터리에 게시하지 않고, 이 저장의 임시 파일만 지운다).
    let cases: Vec<RaceCase> = vec![
        (
            "parent-moved-before-create",
            Box::new(|shared: &Path| -> Hooks {
                let (docs, moved) = (shared.join("docs"), shared.join("moved"));
                vec![(
                    &BEFORE_CREATE,
                    Box::new(move |_, _| std::fs::rename(&docs, &moved).unwrap()),
                )]
            }),
            missing.clone(),
        ),
        (
            "parent-exchanged-before-create",
            Box::new(|shared: &Path| -> Hooks {
                let (docs, other) = (shared.join("docs"), shared.join("other"));
                vec![(
                    &BEFORE_CREATE,
                    Box::new(move |_, _| exchange(&docs, &other)),
                )]
            }),
            DocumentError::FileConflict,
        ),
        (
            "exchanged-create-restored-exchanged-rename",
            Box::new(|shared: &Path| -> Hooks {
                let pair = || (shared.join("docs"), shared.join("other"));
                let ((d1, o1), (d2, o2), (d3, o3)) = (pair(), pair(), pair());
                vec![
                    (&BEFORE_CREATE, Box::new(move |_, _| exchange(&d1, &o1))),
                    (&AFTER_STAGE, Box::new(move |_, _| exchange(&d2, &o2))),
                    (&BEFORE_RENAME, Box::new(move |_, _| exchange(&d3, &o3))),
                ]
            }),
            not_published.clone(),
        ),
        (
            "ancestor-moved-after-create",
            Box::new(|shared: &Path| -> Hooks {
                let (from, to) = (shared.to_path_buf(), shared.with_extension("moved"));
                vec![(
                    &AFTER_STAGE,
                    Box::new(move |_, _| std::fs::rename(&from, &to).unwrap()),
                )]
            }),
            missing.clone(),
        ),
        (
            "ancestor-replaced-before-rename",
            Box::new(|shared: &Path| -> Hooks {
                let (from, to) = (shared.to_path_buf(), shared.with_extension("moved"));
                vec![(
                    &BEFORE_RENAME,
                    Box::new(move |_, _| {
                        std::fs::rename(&from, &to).unwrap();
                        std::fs::create_dir_all(from.join("docs")).unwrap();
                    }),
                )]
            }),
            not_published.clone(),
        ),
    ];
    for (name, hooks, expected) in cases {
        let root = TempDir::new();
        let base = root.path().to_path_buf();
        let mut doc = open_docx_in(root, "shared/docs/a.docx", &original);
        let shared = base.join("shared");
        std::fs::create_dir(shared.join("other")).unwrap();
        std::fs::write(shared.join("other/a.docx"), b"unrelated").unwrap();
        doc.edit(edits());
        doc.preflight().unwrap();
        let (saved, _) = save_with_hooks(&doc, hooks(&shared));
        assert_eq!(saved.err(), Some(expected), "{name}");
        // 원본은 어디로 옮겨졌든 그대로, 남의 파일 그대로, 어느 디렉터리에도 임시 파일이 남지 않는다.
        let mut originals = 0;
        let mut unrelated = 0;
        for dir in walk_dirs(&base) {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let entry = entry.unwrap();
                let file_name = entry.file_name().to_string_lossy().into_owned();
                assert!(
                    !file_name.starts_with(".geul-save-"),
                    "{name}: {dir:?}/{file_name}"
                );
                if entry.file_type().unwrap().is_file() {
                    let bytes = std::fs::read(entry.path()).unwrap();
                    originals += usize::from(bytes == original);
                    unrelated += usize::from(bytes == b"unrelated");
                }
            }
        }
        assert_eq!((originals, unrelated), (1, 1), "{name}");
        assert!(doc.info.dirty, "{name}");
    }
    // 경로에 심볼릭 링크가 생긴 상위(불러온 정규화 경로가 바뀜): 같은 파일로 이어져도 따라가지 않고 충돌로 막는다.
    let root = TempDir::new();
    let base = root.path().to_path_buf();
    let mut doc = open_docx_in(root, "shared/docs/a.docx", &original);
    doc.edit(edits());
    doc.preflight().unwrap();
    std::fs::rename(base.join("shared/docs"), base.join("shared/real")).unwrap();
    std::os::unix::fs::symlink("real", base.join("shared/docs")).unwrap();
    assert_eq!(doc.save().err(), Some(DocumentError::FileConflict));
    assert_eq!(
        std::fs::read(base.join("shared/real/a.docx")).unwrap(),
        original
    );
    assert_eq!(doc.leftovers(), Vec::<String>::new());
    // 경로를 되돌리면 같은 세션으로 저장할 수 있다(기록한 원본 그대로).
    std::fs::remove_file(base.join("shared/docs")).unwrap();
    std::fs::rename(base.join("shared/real"), base.join("shared/docs")).unwrap();
    let saved = doc.save().unwrap();
    assert_published(&mut doc, saved, "restored");
}

/// `root` 아래 모든 디렉터리(자신 포함).
#[cfg(target_os = "linux")]
fn walk_dirs(root: &Path) -> Vec<std::path::PathBuf> {
    let mut out = vec![root.to_path_buf()];
    let mut at = 0;
    while at < out.len() {
        for entry in std::fs::read_dir(&out[at]).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                out.push(entry.path());
            }
        }
        at += 1;
    }
    out
}

// ---- T009 후속 강화 A: 다중 사용자 탐침은 보안 불변식을 판정으로 강제한다 ----
//
// 탐침은 피해자 쪽에서 믿을 수 있는 값(저장 결과, 거부 뒤 레지스트리 dirty, 경로가 가리키는 디렉터리 inode의 표본, 끝난 뒤
// inode로 찾은 두 디렉터리의 항목·내용, 남의 파일, 공격을 멈춘 뒤의 사전 검사)을 모으고 판정한다. 공격 쪽 보고는 이번 실행의
// 무작위 표지(nonce)가 맞을 때만 쓰고, 공격 쪽 보고만으로 통과시키지 않는다(노출 보고는 실패의 근거로만 쓴다).

/// 탐침 판정.
#[derive(Debug, PartialEq, Eq)]
enum ProbeVerdict {
    /// 준비가 됐고 공격이 실제로 일어났으며 모든 불변식을 지켰다.
    Pass,
    /// 불변식이 깨졌다.
    Fail(Vec<String>),
    /// 실행했지만 판단할 수 없다(공격이 일어나지 않음, 동기화·측정 실패, 의도한 조건이 아님).
    Inconclusive(Vec<String>),
    /// 실행 조건이 없다(환경 변수·준비 실패).
    NotRun(String),
}

/// 실행 배치: 공격 쪽이 `docs`·`other`를 맞바꿀 수 있는(믿지 않는 사용자가 쓸 수 있는 공유 상위) 배치인지.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProbeLayout {
    /// 공유 상위에 그 밖 쓰기, sticky 없음: 저장은 모두 거부돼야 하고 공격(맞바꿈)이 관찰돼야 한다.
    Swappable,
    /// 믿는 쪽만 바꿀 수 있는 상위(0755 root·1777 sticky): 저장이 모두 되고 맞바꿈은 일어나지 않아야 한다.
    Locked,
}

/// 저장 한 번의 결과(피해자 쪽 측정).
#[derive(Debug, Clone)]
enum ProbeSave {
    /// 사전 검사가 실패(경로가 맞바뀐 때 등).
    PreflightFailed,
    /// 저장됨: 내구성, 저장 직후 세션 dirty.
    Saved { durable: bool, dirty: bool },
    /// 거부됨: 오류, 거부 직후 레지스트리 dirty.
    Rejected { error: DocumentError, dirty: bool },
}

/// 공격 쪽 보고(이번 실행의 표지가 맞을 때만).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct AttackerReport {
    attempts: u64,
    swaps: u64,
    /// 공격 쪽이 읽을 수 있었던, 문서(ZIP) 내용이 든 파일 수.
    readable_documents: u64,
}

/// 원본 디렉터리의 a.docx 측정(디렉터리를 inode로 확인한 뒤).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProbeRealFile {
    /// 파일이 있다(없음은 그 디렉터리에서 `NotFound`로 확인됨).
    present: bool,
    is_original: bool,
    inode_is_original: bool,
    is_last_saved: bool,
}

/// 판정의 입력: 피해자 쪽 측정과 확인된 공격 쪽 보고. `None`은 "측정하지 못함"이며 깨끗한 관찰이 아니다(시험 기반 안정화 B):
/// 판정은 측정한 값으로만 위반을 찾고, 측정하지 못한 필수 값이 있으면 판단 불가로 둔다.
#[derive(Debug, Clone)]
struct ProbeObservation {
    layout: ProbeLayout,
    saves: Vec<ProbeSave>,
    /// 경로 `shared/docs`가 처음의 `docs` 디렉터리가 아닌 것을 본(측정에 성공한) 회차 수.
    swaps_seen: usize,
    /// 경로 표본을 재지 못한 횟수.
    sample_failures: usize,
    attacker: Option<AttackerReport>,
    /// 공격을 멈춘 뒤 원래 배치로 돌아왔는지(두 경로 모두 inode로 확인). 두 디렉터리를 찾지 못하면 None.
    restored: Option<bool>,
    /// inode로 찾은 원래 `docs`·`other` 디렉터리의 항목(목록을 끝까지 읽고 그 사이 디렉터리가 바뀌지 않았을 때만).
    real_entries: Option<Vec<String>>,
    wrong_entries: Option<Vec<String>>,
    real_file: Option<ProbeRealFile>,
    /// 남의 파일이 그대로인지(같은 inode·내용). 없어진 것은 그 디렉터리에서 `NotFound`로 확인됐을 때만 `Some(false)`.
    sentinel_intact: Option<bool>,
    /// 공격을 멈춘 뒤 같은 세션의 사전 검사가 기록한 원본과 맞는지(`FileConflict`는 Some(false), 그 밖의 오류는 None).
    final_preflight_ok: Option<bool>,
}

const PROBE_SENTINEL: &str = "unrelated.txt";

fn probe_verdict(o: &ProbeObservation) -> ProbeVerdict {
    let mut fail = Vec::new();
    let mut unknown = Vec::new();
    let saved: Vec<(bool, bool)> = o
        .saves
        .iter()
        .filter_map(|s| match s {
            ProbeSave::Saved { durable, dirty } => Some((*durable, *dirty)),
            _ => None,
        })
        .collect();
    let rejected_clean = o
        .saves
        .iter()
        .filter(|s| matches!(s, ProbeSave::Rejected { dirty: false, .. }))
        .count();
    // 1·2·3·4: 다른 디렉터리에 게시·남은 임시 파일·남의 파일 변경·노출. 측정한 것으로만 위반을 찾는다.
    match &o.wrong_entries {
        Some(entries) => {
            if entries.iter().any(|n| n != PROBE_SENTINEL) {
                let extra = entries.iter().filter(|n| *n != PROBE_SENTINEL).count();
                fail.push(format!("다른 디렉터리에 항목이 생김: {extra}"));
            }
        }
        None => unknown.push("측정 실패: 다른 디렉터리 항목".into()),
    }
    match &o.real_entries {
        Some(entries) => {
            if entries.iter().any(|n| n != "a.docx") || !entries.iter().any(|n| n == "a.docx") {
                fail.push(format!(
                    "원본 디렉터리 항목이 a.docx 하나가 아님: {}",
                    entries.len()
                ));
            }
        }
        None => unknown.push("측정 실패: 원본 디렉터리 항목".into()),
    }
    match o.sentinel_intact {
        Some(false) => fail.push("남의 파일이 바뀌거나 사라짐".into()),
        Some(true) => {}
        None => unknown.push("측정 실패: 남의 파일".into()),
    }
    if let Some(attacker) = &o.attacker {
        if attacker.readable_documents > 0 {
            fail.push(format!(
                "공격 쪽이 문서 내용 파일을 읽음: {}",
                attacker.readable_documents
            ));
        }
    }
    // 5·6·7·8: 원본 보호, 게시 식별, 내구성·dirty의 정직함.
    if rejected_clean > 0 {
        fail.push(format!("거부된 저장 뒤 dirty가 풀림: {rejected_clean}"));
    }
    match o.real_file {
        None => unknown.push("측정 실패: 원본 파일".into()),
        Some(file) if !file.present => fail.push("원본 파일이 없음".into()),
        Some(file) if saved.is_empty() => {
            if !(file.is_original && file.inode_is_original) {
                fail.push("저장이 하나도 되지 않았는데 원본이 바뀜".into());
            }
        }
        Some(file) => {
            if !file.is_last_saved {
                fail.push("마지막으로 저장한 내용이 원본 경로에 없음".into());
            }
        }
    }
    if !saved.is_empty() {
        match o.final_preflight_ok {
            Some(false) => fail.push("저장한 세션의 파일 기록이 원본 경로의 파일과 다름".into()),
            Some(true) => {}
            None => unknown.push("측정 실패: 공격을 멈춘 뒤 사전 검사".into()),
        }
    }
    match o.layout {
        ProbeLayout::Swappable => {
            if !saved.is_empty() {
                fail.push(format!(
                    "믿지 않는 사용자가 바꿀 수 있는 상위 아래에서 저장됨: {}",
                    saved.len()
                ));
            }
            if o.swaps_seen == 0 {
                unknown.push("피해자 쪽에서 맞바꿈을 한 번도 보지 못함".into());
            }
            let checked = o.saves.iter().any(|s| {
                matches!(
                    s,
                    ProbeSave::Rejected {
                        error: DocumentError::SaveUnsupported {
                            reason: SaveUnsupportedReason::SharedDirectory
                        },
                        ..
                    }
                )
            });
            if !checked {
                unknown.push("상위 디렉터리 확인까지 간 저장이 없음".into());
            }
        }
        ProbeLayout::Locked => {
            if saved.len() != o.saves.len() || saved.iter().any(|&(d, dirty)| !d || dirty) {
                fail.push(format!(
                    "믿는 배치에서 저장이 모두 durable·깨끗하지 않음: {}/{}",
                    saved.iter().filter(|&&(d, dirty)| d && !dirty).count(),
                    o.saves.len()
                ));
            }
            if o.swaps_seen > 0 || o.attacker.as_ref().is_some_and(|a| a.swaps > 0) {
                unknown.push("믿는 배치인데 맞바꿈이 일어남(실행 환경이 의도와 다름)".into());
            }
        }
    }
    if o.sample_failures > 0 {
        unknown.push(format!("측정 실패: 경로 표본 {}", o.sample_failures));
    }
    // 9·10: 공격이 실제로 일어났고 표지가 이번 실행의 것인지.
    match &o.attacker {
        None => unknown.push("공격 쪽 완료 표지가 없거나 이번 실행의 것이 아님".into()),
        Some(attacker) if attacker.attempts == 0 => unknown.push("공격 쪽 시도가 0번".into()),
        Some(_) => {}
    }
    match o.restored {
        Some(true) => {}
        Some(false) => unknown.push("공격을 멈춘 뒤 원래 배치로 돌아오지 않음".into()),
        None => unknown.push("측정 실패: 공격을 멈춘 뒤 두 디렉터리를 찾지 못함".into()),
    }
    if o.saves.is_empty() {
        unknown.push("저장을 한 번도 하지 않음".into());
    }
    if !fail.is_empty() {
        ProbeVerdict::Fail(fail)
    } else if !unknown.is_empty() {
        ProbeVerdict::Inconclusive(unknown)
    } else {
        ProbeVerdict::Pass
    }
}

/// 공격 쪽 완료 표지: `nonce=<이번 실행 값> attempts=<n> swaps=<n> readable=<n>`. 표지가 다르거나 모양이 틀리면 None.
fn parse_attacker_report(text: &str, nonce: &str) -> Option<AttackerReport> {
    let mut fields = std::collections::BTreeMap::new();
    for part in text.split_whitespace() {
        let (key, value) = part.split_once('=')?;
        if fields.insert(key, value).is_some() {
            return None;
        }
    }
    if fields.len() != 4 || fields.get("nonce") != Some(&nonce) {
        return None;
    }
    let number = |key: &str| fields.get(key)?.parse::<u64>().ok();
    Some(AttackerReport {
        attempts: number("attempts")?,
        swaps: number("swaps")?,
        readable_documents: number("readable")?,
    })
}

/// 난수 원천 한 번 호출: `buf`에 채운 바이트 수 또는 오류(`getrandom(2)`와 같은 뜻).
type RandomCall<'a> = &'a mut dyn FnMut(&mut [u8]) -> std::io::Result<usize>;

/// 운영체제 난수 한 번 호출(`getrandom(2)`, 플래그 없음).
#[cfg(target_os = "linux")]
fn os_getrandom(buf: &mut [u8]) -> std::io::Result<usize> {
    // SAFETY: 포인터·길이는 buf다.
    let got = unsafe { libc::getrandom(buf.as_mut_ptr().cast(), buf.len(), 0) };
    if got < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(got as usize)
    }
}

/// `buf`를 끝까지 난수로 채운다: 짧게 읽히면 이어 읽고, EINTR는 다시 부르며, 0바이트·요청보다 많은 바이트·그 밖의 오류는
/// 실패다(일부만 채운 값을 쓰거나 짐작할 수 있는 값으로 대신하지 않는다).
fn fill_nonce(buf: &mut [u8], call: RandomCall<'_>) -> std::io::Result<()> {
    let mut filled = 0;
    while filled < buf.len() {
        let rest = &mut buf[filled..];
        match call(rest) {
            Ok(0) => return Err(std::io::Error::other("random source returned no bytes")),
            Ok(got) if got > rest.len() => {
                return Err(std::io::Error::other("random source over-reported"))
            }
            Ok(got) => filled += got,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// 이번 실행의 표지(난수 128비트, 소문자 hex 32자). 난수를 얻지 못하면 오류(호출하는 쪽이 NOT-RUN으로 낸다).
fn probe_nonce(call: RandomCall<'_>) -> std::io::Result<String> {
    let mut bytes = [0u8; 16];
    fill_nonce(&mut bytes, call)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// 탐침 실행 설정. `step`은 각 회차 전에 불리는 시험용 공격(같은 프로세스)이고, 실제 다중 사용자 실행에서는 아무것도 하지 않는다.
#[cfg(target_os = "linux")]
struct ProbeRun<'a> {
    shared: std::path::PathBuf,
    rounds: usize,
    layout: ProbeLayout,
    ready: std::path::PathBuf,
    stop: std::path::PathBuf,
    done: std::path::PathBuf,
    step: &'a mut dyn FnMut(usize),
    /// 공격을 멈추고 판정 전에 부른다(시험용 위반·측정 실패 주입).
    before_examine: &'a mut dyn FnMut(&Path, &Path),
    /// 표지용 난수 원천(실제 실행은 `os_getrandom`, 시험은 실패를 주입).
    random: RandomCall<'a>,
    /// 시험용: 디렉터리 목록을 (원본 쪽이면 true, n개를 읽은 뒤) 오류로 끊는다.
    list_fault: Option<(bool, usize)>,
}

/// `path`가 `expected` inode의 디렉터리일 때 그 목록을 끝까지 읽는다(정렬). 처음·끝의 inode가 다르거나(그 사이 바뀜·없어짐)
/// 목록을 열거나 읽다가 오류가 나면 None — 빈 목록으로 대신하지 않는다. `fault_after`는 시험용 중간 오류.
#[cfg(target_os = "linux")]
fn measure_dir(path: &Path, expected: u64, fault_after: Option<usize>) -> Option<Vec<String>> {
    use std::os::unix::fs::MetadataExt;
    let same = || std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir() && m.ino() == expected);
    if !same() {
        return None;
    }
    let mut names = Vec::new();
    for entry in std::fs::read_dir(path).ok()? {
        if fault_after == Some(names.len()) {
            return None;
        }
        names.push(entry.ok()?.file_name().to_string_lossy().into_owned());
    }
    if !same() {
        return None;
    }
    names.sort();
    Some(names)
}

/// 탐침을 실행하고 판정한다. 준비가 안 되면 `NotRun`.
#[cfg(target_os = "linux")]
fn run_probe(run: ProbeRun<'_>) -> (ProbeVerdict, String) {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let ProbeRun {
        shared,
        rounds,
        layout,
        ready,
        stop,
        done,
        step,
        before_examine,
        random,
        list_fault,
    } = run;
    for marker in [&ready, &stop, &done] {
        if std::fs::symlink_metadata(marker).is_ok() {
            return (
                ProbeVerdict::NotRun("이전 실행의 표지 파일이 남아 있음".into()),
                String::new(),
            );
        }
    }
    // 표지는 시작 전에 정한다: 난수를 얻지 못하면 실행하지 않는다(짐작할 수 있는 표지로 대신하지 않음).
    let Ok(nonce) = probe_nonce(random) else {
        return (
            ProbeVerdict::NotRun("표지용 난수를 얻지 못함".into()),
            String::new(),
        );
    };
    let original = basic::basic_ko().unwrap();
    let (docs, other) = (shared.join("docs"), shared.join("other"));
    let prepared = (|| -> std::io::Result<(u64, u64, u64, u64)> {
        // 공유 디렉터리에 만들 권한이 없으면(믿는 쪽 소유 0755 등) 실행 절차가 미리 만들어 준다.
        std::fs::create_dir_all(&docs)?;
        std::fs::create_dir_all(&other)?;
        std::fs::set_permissions(&docs, std::fs::Permissions::from_mode(0o700))?;
        std::fs::set_permissions(&other, std::fs::Permissions::from_mode(0o755))?;
        if std::fs::read_dir(&docs)?.next().is_some() || std::fs::read_dir(&other)?.next().is_some()
        {
            return Err(std::io::Error::other("비어 있지 않은 시험 디렉터리"));
        }
        let path = docs.join("a.docx");
        std::fs::write(&path, &original)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))?;
        std::fs::write(other.join(PROBE_SENTINEL), b"unrelated")?;
        Ok((
            std::fs::metadata(&docs)?.ino(),
            std::fs::metadata(&other)?.ino(),
            std::fs::metadata(&path)?.ino(),
            std::fs::metadata(other.join(PROBE_SENTINEL))?.ino(),
        ))
    })();
    // 선언한 배치가 실제 공유 디렉터리 권한과 맞는지 잰다(설정 실수를 보안 위반이나 통과로 읽지 않게).
    let measured = std::fs::metadata(&shared).map(|m| {
        if m.mode() & 0o022 != 0 && m.mode() & 0o1000 == 0 {
            ProbeLayout::Swappable
        } else {
            ProbeLayout::Locked
        }
    });
    if measured.as_ref().ok() != Some(&layout) {
        return (
            ProbeVerdict::Inconclusive(vec![format!(
                "선언한 배치 {layout:?}가 공유 디렉터리 권한({:?})과 다름",
                measured.ok()
            )]),
            String::new(),
        );
    }
    let Ok((docs_ino, other_ino, original_ino, sentinel_ino)) = prepared else {
        return (
            ProbeVerdict::NotRun(format!("준비 실패: {:?}", prepared.err().map(|e| e.kind()))),
            String::new(),
        );
    };
    let path = docs.join("a.docx");
    let state = DocumentState::default();
    let Ok(file) = identify(path.to_str().unwrap(), &Limits::default()) else {
        return (
            ProbeVerdict::NotRun("원본을 열 수 없음".into()),
            String::new(),
        );
    };
    let info = state.registry().register(file).unwrap();
    let Ok(loaded) = block_on(docx::load(&state, info.session_id, None)) else {
        return (
            ProbeVerdict::NotRun("원본을 불러올 수 없음".into()),
            String::new(),
        );
    };
    let mut info = loaded.session;
    if std::fs::write(&ready, &nonce).is_err() {
        return (
            ProbeVerdict::NotRun("시작 표지를 쓸 수 없음".into()),
            String::new(),
        );
    }
    let ino_at = |path: &Path| std::fs::symlink_metadata(path).map(|m| m.ino());
    let (mut swaps_seen, mut sample_failures) = (0, 0);
    let mut saves = Vec::new();
    let mut last_saved = None;
    for round in 0..rounds {
        step(round);
        // 회차마다 경로 표본 16개: 재지 못한 표본은 맞바꿈의 근거가 아니다.
        let samples: Vec<_> = (0..16).map(|_| ino_at(&docs)).collect();
        sample_failures += samples.iter().filter(|s| s.is_err()).count();
        swaps_seen += usize::from(
            samples
                .iter()
                .any(|s| s.as_ref().is_ok_and(|ino| *ino != docs_ino)),
        );
        info = block_on(docx::edit(
            &state,
            info.session_id,
            info.load_generation,
            info.revision,
            vec![DocxOp::InsertText { text: "a".into() }],
        ))
        .unwrap()
        .session;
        if block_on(docx::preflight(
            &state,
            info.session_id,
            info.load_generation,
        ))
        .is_err()
        {
            saves.push(ProbeSave::PreflightFailed);
            continue;
        }
        match block_on(docx::save(
            &state,
            info.session_id,
            info.load_generation,
            info.revision,
        )) {
            Ok(outcome) => {
                saves.push(ProbeSave::Saved {
                    durable: outcome.durable,
                    dirty: outcome.session.dirty,
                });
                info = outcome.session;
                let model = state
                    .wordcraft()
                    .get(info.session_id, info.load_generation)
                    .unwrap();
                last_saved = Some(model.lock().unwrap().export().unwrap());
            }
            Err(error) => {
                let dirty = state.registry().get(info.session_id).unwrap().dirty;
                saves.push(ProbeSave::Rejected { error, dirty });
            }
        }
    }
    // 멈춤 표지를 쓰지 못하면 공격 쪽이 끝나지 않으므로 완료 표지를 기다리지 않는다(판단 불가).
    let stopped = std::fs::write(&stop, b"").is_ok();
    let mut attacker_text = None;
    for _ in 0..if stopped { 1000 } else { 0 } {
        if let Ok(text) = std::fs::read_to_string(&done) {
            if !text.is_empty() {
                attacker_text = Some(text);
                break;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let attacker = attacker_text
        .as_deref()
        .and_then(|text| parse_attacker_report(text, &nonce));
    // 두 디렉터리를 inode로 찾는다: 원래 배치·맞바뀐 배치가 아니면(재지 못함·없어짐·바뀜) 찾지 못함.
    let arrangement = match (ino_at(&docs), ino_at(&other)) {
        (Ok(d), Ok(o)) if (d, o) == (docs_ino, other_ino) => Some(true),
        (Ok(d), Ok(o)) if (d, o) == (other_ino, docs_ino) => Some(false),
        _ => None,
    };
    let (real, wrong) = match arrangement {
        Some(false) => (other.clone(), docs.clone()),
        _ => (docs.clone(), other.clone()),
    };
    before_examine(&real, &wrong);
    let fault =
        |real_side: bool| list_fault.and_then(|(side, after)| (side == real_side).then_some(after));
    let found = arrangement.is_some();
    let real_entries = found
        .then(|| measure_dir(&real, docs_ino, fault(true)))
        .flatten();
    let wrong_entries = found
        .then(|| measure_dir(&wrong, other_ino, fault(false)))
        .flatten();
    // 원본 파일·남의 파일: 그 디렉터리가 지금도 그 inode일 때만 잰다. `NotFound`만 "없음"으로 확인된 것으로 본다.
    let dir_is = |dir: &Path, ino: u64| found && ino_at(dir).is_ok_and(|now| now == ino);
    let real_file = dir_is(&real, docs_ino)
        .then(|| match std::fs::symlink_metadata(real.join("a.docx")) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(ProbeRealFile {
                present: false,
                is_original: false,
                inode_is_original: false,
                is_last_saved: false,
            }),
            Err(_) => None,
            Ok(meta) => {
                let bytes = std::fs::read(real.join("a.docx")).ok()?;
                Some(ProbeRealFile {
                    present: true,
                    is_original: bytes == original,
                    inode_is_original: meta.ino() == original_ino,
                    is_last_saved: last_saved.as_deref() == Some(bytes.as_slice()),
                })
            }
        })
        .flatten();
    let sentinel_intact = dir_is(&wrong, other_ino)
        .then(
            || match std::fs::symlink_metadata(wrong.join(PROBE_SENTINEL)) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(false),
                Err(_) => None,
                Ok(meta) if !meta.is_file() || meta.ino() != sentinel_ino => Some(false),
                Ok(_) => std::fs::read(wrong.join(PROBE_SENTINEL))
                    .ok()
                    .map(|bytes| bytes == b"unrelated"),
            },
        )
        .flatten();
    let final_preflight_ok = (arrangement == Some(true))
        .then(|| {
            match block_on(docx::preflight(
                &state,
                info.session_id,
                info.load_generation,
            )) {
                Ok(_) => Some(true),
                Err(DocumentError::FileConflict) => Some(false),
                Err(_) => None,
            }
        })
        .flatten();
    let observation = ProbeObservation {
        layout,
        saves,
        swaps_seen,
        sample_failures,
        attacker,
        restored: arrangement,
        real_entries,
        wrong_entries,
        real_file,
        sentinel_intact,
        final_preflight_ok,
    };
    let mut tally = std::collections::BTreeMap::<String, usize>::new();
    for save in &observation.saves {
        let key = match save {
            ProbeSave::PreflightFailed => "preflight-failed".to_owned(),
            ProbeSave::Saved { durable, dirty } => format!("saved durable={durable} dirty={dirty}"),
            ProbeSave::Rejected { error, .. } => format!("{error:?}"),
        };
        *tally.entry(key).or_default() += 1;
    }
    // 진단: 경로·문서 내용 없이 개수·결과만(None은 측정 실패).
    let summary = format!(
        "layout={:?} rounds={} tally={tally:?} swaps_seen={} sample_failures={} attacker={:?} restored={:?} real_entries={:?} wrong_entries={:?}",
        observation.layout,
        rounds,
        observation.swaps_seen,
        observation.sample_failures,
        observation.attacker,
        observation.restored,
        observation.real_entries.as_ref().map(Vec::len),
        observation.wrong_entries.as_ref().map(Vec::len),
    );
    (probe_verdict(&observation), summary)
}

/// 판정을 한 줄로 내고 PASS가 아니면 시험을 실패시킨다(실패·판단 불가·실행 안 됨을 통과로 보이지 않게). 실행 절차는 이 줄의
/// `verdict=`로 PASS(0)·FAIL(1)·INCONCLUSIVE/NOT-RUN(2)을 구분한다.
#[cfg(target_os = "linux")]
fn report_probe(verdict: &ProbeVerdict, summary: &str) {
    let (label, reasons) = match verdict {
        ProbeVerdict::Pass => ("PASS", Vec::new()),
        ProbeVerdict::Fail(reasons) => ("FAIL", reasons.clone()),
        ProbeVerdict::Inconclusive(reasons) => ("INCONCLUSIVE", reasons.clone()),
        ProbeVerdict::NotRun(reason) => ("NOT-RUN", vec![reason.clone()]),
    };
    eprintln!("A4PROBE verdict={label} reasons={reasons:?} {summary}");
    assert_eq!(label, "PASS", "A4PROBE verdict={label} reasons={reasons:?}");
}

/// 4차 안정화 A 다중 사용자 탐침(로컬, 기본 실행 안 함 — 실제 다른 uid가 필요하다): 다른 uid가 공유 상위 디렉터리
/// (`GEUL_A4_SHARED`)의 `docs`·`other`를 계속 맞바꾸는 동안 `docs/a.docx`를 `GEUL_A4_ROUNDS`번 편집·저장하고 판정한다.
/// `GEUL_A4_LAYOUT`은 `swappable`(그 밖 쓰기·sticky 없는 상위) 또는 `locked`(믿는 쪽만 바꿀 수 있는 상위). 공격 쪽은
/// `GEUL_A4_READY`(이번 실행 표지)를 기다려 시작하고, `GEUL_A4_STOP`이 생기면 원래 배치로 되돌린 뒤 `GEUL_A4_DONE`에 표지와
/// 시도·맞바꿈·읽은 문서 수를 쓴다. 명시적으로 실행했는데 조건이 없으면 NOT-RUN으로 실패한다(조용히 통과하지 않음). 사용자
/// 이름공간 실행 절차는 `docs/architecture/save-preservation.md`.
#[cfg(target_os = "linux")]
#[test]
#[ignore]
fn a4_다중_사용자_탐침() {
    let var = |name: &str| std::env::var(name).ok().map(std::path::PathBuf::from);
    let layout = match std::env::var("GEUL_A4_LAYOUT").as_deref() {
        Ok("swappable") => Some(ProbeLayout::Swappable),
        Ok("locked") => Some(ProbeLayout::Locked),
        _ => None,
    };
    let rounds = std::env::var("GEUL_A4_ROUNDS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|rounds| *rounds > 0);
    let (Some(shared), Some(ready), Some(stop), Some(done), Some(layout), Some(rounds)) = (
        var("GEUL_A4_SHARED"),
        var("GEUL_A4_READY"),
        var("GEUL_A4_STOP"),
        var("GEUL_A4_DONE"),
        layout,
        rounds,
    ) else {
        report_probe(
            &ProbeVerdict::NotRun(
                "GEUL_A4_SHARED·READY·STOP·DONE·LAYOUT·ROUNDS가 모두 있어야 함".into(),
            ),
            "",
        );
        return;
    };
    let (verdict, summary) = run_probe(ProbeRun {
        shared,
        rounds,
        layout,
        ready,
        stop,
        done,
        step: &mut |_| {},
        before_examine: &mut |_, _| {},
        random: &mut os_getrandom,
        list_fault: None,
    });
    report_probe(&verdict, &summary);
}

// ---- T009 4차 안정화 C: 남는 미리보기는 내용과 무관함이 증명된 엔진 상수일 때만 ----

/// 비밀 8바이트를 담은, 지금까지의 "한 색 PNG·빈 글" 증명을 통과할 수 있는 미리보기들(정보 용량 시연, 합성 픽스처).
fn preview_carriers(secret: &[u8; 8]) -> Vec<Carrier> {
    let end = png_chunk(b"IEND", b"");
    let gray = |rows: Vec<u8>, height: u32| {
        png_of(&[
            png_chunk(b"IHDR", &ihdr(1, height, 0)),
            png_chunk(b"IDAT", &zlib_of(&rows)),
            end.clone(),
        ])
    };
    let bits: Vec<u8> = secret
        .iter()
        .flat_map(|byte| (0..8).rev().map(move |bit| (byte >> bit) & 1))
        .collect();
    // 1. 완전히 투명한 RGBA 픽셀의 RGB(1×1, 알파 0): 3바이트.
    let transparent = png_of(&[
        png_chunk(b"IHDR", &ihdr(1, 1, 6)),
        png_chunk(b"IDAT", &zlib_of(&[0, secret[0], secret[1], secret[2], 0])),
        end.clone(),
    ]);
    // 2. 허용 보조 덩어리의 값(pHYs 8바이트 + 단위 0).
    let phys = png_of(&[
        png_chunk(b"IHDR", &ihdr(1, 1, 0)),
        png_chunk(b"pHYs", &[&secret[..], &[0]].concat()),
        png_chunk(b"IDAT", &zlib_of(&[0, 255])),
        end.clone(),
    ]);
    // 3. 같은 픽셀(1×64 흰색 회색조)의 줄 필터 선택: 줄마다 필터 0(비트 0)·2(비트 1).
    let filtered: Vec<u8> = bits
        .iter()
        .enumerate()
        .flat_map(|(row, bit)| {
            let previous = if row == 0 { 0u8 } else { 255 };
            if *bit == 0 {
                [0u8, 255]
            } else {
                [2u8, 255u8.wrapping_sub(previous)]
            }
        })
        .collect();
    let filters = gray(filtered, 64);
    // 4. 같은 픽셀(1×1 흰색)의 deflate 표현: 빈 저장 블록 머리의 채움 비트(블록마다 5비트, 읽는 쪽이 보지 않음).
    let mut deflate = Vec::new();
    for chunk in bits.chunks(5) {
        let value = chunk.iter().fold(0u8, |acc, bit| (acc << 1) | bit) << (5 - chunk.len());
        deflate.extend_from_slice(&[value << 3, 0x00, 0x00, 0xFF, 0xFF]);
    }
    deflate.extend_from_slice(&[0x01, 0x02, 0x00, 0xFD, 0xFF, 0, 255]);
    let raw = [0u8, 255];
    let (mut a, mut b) = (1u32, 0u32);
    for byte in raw {
        a = (a + u32::from(byte)) % 65521;
        b = (b + a) % 65521;
    }
    let zlib = [
        &[0x78u8, 0x01][..],
        &deflate,
        &((b << 16) | a).to_be_bytes(),
    ]
    .concat();
    let padding = png_of(&[
        png_chunk(b"IHDR", &ihdr(1, 1, 0)),
        png_chunk(b"IDAT", &zlib),
        end.clone(),
    ]);
    // 5. 빈 글 미리보기의 공백 무늬: 공백(0)·탭(1) 64글자 + 줄바꿈.
    let whitespace: Vec<u8> = bits
        .iter()
        .map(|bit| if *bit == 0 { b' ' } else { b'\t' })
        .chain(*b"\r\n")
        .collect();
    let idat = |png: &[u8]| -> Vec<u8> {
        // IHDR(8 + 25바이트) 다음 덩어리들에서 IDAT 본문.
        let mut at = 33;
        let mut out = Vec::new();
        while at + 8 <= png.len() {
            let len = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
            if &png[at + 4..at + 8] == b"IDAT" {
                out.extend_from_slice(&png[at + 8..at + 8 + len]);
            }
            at += 12 + len;
        }
        out
    };
    let to_bytes = |bits: Vec<u8>| -> Vec<u8> {
        bits.chunks(8)
            .map(|byte| byte.iter().fold(0u8, |acc, bit| (acc << 1) | bit))
            .collect()
    };
    vec![
        (
            "transparent-rgb",
            transparent,
            Box::new(move |png: &[u8]| {
                let mut raw = Vec::new();
                std::io::Read::read_to_end(
                    &mut flate2::read::ZlibDecoder::new(&idat(png)[..]),
                    &mut raw,
                )
                .unwrap();
                raw[1..4].to_vec()
            }),
        ),
        (
            "phys-values",
            phys,
            Box::new(|png: &[u8]| png[33 + 8..33 + 16].to_vec()),
        ),
        (
            "row-filters",
            filters,
            Box::new(move |png: &[u8]| {
                let mut raw = Vec::new();
                std::io::Read::read_to_end(
                    &mut flate2::read::ZlibDecoder::new(&idat(png)[..]),
                    &mut raw,
                )
                .unwrap();
                to_bytes(raw.chunks(2).map(|row| u8::from(row[0] == 2)).collect())
            }),
        ),
        (
            "deflate-padding",
            padding,
            Box::new(move |png: &[u8]| {
                let stream = idat(png);
                let bits: Vec<u8> = stream[2..]
                    .chunks(5)
                    .take_while(|block| block.len() == 5 && block[0] & 1 == 0)
                    .flat_map(|block| (0..5).rev().map(move |bit| (block[0] >> (3 + bit)) & 1))
                    .take(64)
                    .collect();
                to_bytes(bits)
            }),
        ),
        (
            "whitespace-text",
            whitespace,
            Box::new(move |text: &[u8]| {
                to_bytes(text[..64].iter().map(|c| u8::from(*c == b'\t')).collect())
            }),
        ),
    ]
}

#[test]
fn c4_한_색_그림과_빈_글도_내용을_담을_수_있어_남는_미리보기는_엔진_상수만_받는다() {
    use super::preview::{blank_utf16, blank_utf8, known_blank_png};
    let secret = *b"SECRET-1";
    let mut wrong = Vec::new();
    for (name, carrier, extract) in preview_carriers(&secret) {
        // 시연: 그 바이트에서 비밀을 다시 꺼낼 수 있다(전부 또는 앞부분).
        let back = extract(&carrier);
        assert!(
            secret.starts_with(&back) && !back.is_empty(),
            "{name}: {back:?}"
        );
        let accepted = if name == "whitespace-text" {
            let utf16: Vec<u8> = carrier.iter().flat_map(|c| [*c, 0]).collect();
            blank_utf8(&carrier) || blank_utf16(&utf16)
        } else {
            known_blank_png(&carrier)
        };
        if accepted {
            wrong.push(format!("{name}: 내용이 없다고 받음"));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

// ---- T009 후속 강화 B: 임시 파일 이름은 미리 알 수 없어야 한다(sticky 디렉터리의 다른 사용자가 이름을 미리 차지하는 것) ----

/// 다른 사용자가 프로세스 번호(`/proc`으로 보임)와 0부터 늘어나는 번호로 짐작할 수 있는 이름을 미리 만든다.
#[cfg(target_os = "linux")]
fn precreate_predictable(dir: &Path, count: u64) -> Vec<String> {
    let start = super::publish::next_name_number();
    (start..start + count)
        .map(|n| {
            let name = format!(".geul-save-{}-{n}.tmp", std::process::id());
            std::fs::write(dir.join(&name), b"squatter").unwrap();
            name
        })
        .collect()
}

#[cfg(target_os = "linux")]
#[test]
fn h5_짐작할_수_있는_이름을_미리_차지해도_저장은_막히지_않고_그_파일은_그대로다() {
    use std::os::unix::fs::PermissionsExt;
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    // sticky 1777(이 사용자 소유): 지원하는 배치. 다른 사용자도 여기에 자기 항목을 만들 수 있다.
    std::fs::set_permissions(doc.dir.path(), std::fs::Permissions::from_mode(0o1777)).unwrap();
    doc.edit(edits());
    doc.preflight().unwrap();
    let squatted = precreate_predictable(doc.dir.path(), 1024);
    let saved = doc.save();
    let outcome = saved.as_ref().map(|o| o.durable).map_err(Clone::clone);
    std::fs::set_permissions(doc.dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(outcome == Ok(true), "저장이 막힘: {outcome:?}");
    assert_ne!(doc.bytes(), original);
    // 미리 만든 파일은 하나도 지우거나 덮지 않았다.
    let mut left = doc.leftovers();
    left.sort();
    let mut expected = squatted.clone();
    expected.sort();
    assert_eq!(left, expected);
    assert!(squatted
        .iter()
        .all(|name| std::fs::read(doc.dir.path().join(name)).unwrap() == b"squatter"));
}

/// 시험용 이름 원천이 후보마다 할 일: 그 이름에 남의 파일·심볼릭 링크를 미리 만들거나, 난수 실패를 흉내.
#[derive(Clone, Copy)]
#[cfg(target_os = "linux")]
enum Squat {
    File(&'static [u8]),
    Link,
    Fail,
}

/// 시험용 이름 원천을 걸고 `run`을 같은 스레드에서 실행한다. 후보 `i`번째에 `decide(i)`를 적용하고, 원천이 정한 후보 이름들을
/// 돌려준다(무작위 부분은 결정적인 값, 이름에는 실제 순번이 들어간다).
#[cfg(target_os = "linux")]
fn with_names<T>(
    doc: &Docx,
    decide: impl Fn(usize) -> Option<Squat> + 'static,
    run: impl FnOnce() -> T,
) -> (T, Vec<String>) {
    let dir = doc.path.parent().unwrap().to_path_buf();
    let names = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let seen = names.clone();
    super::publish::NAME_SOURCE.with(|cell| {
        *cell.borrow_mut() = Some(Box::new(move |counter, random| {
            let index = seen.borrow().len();
            *random = [0x5a ^ index as u8; 16];
            let name = super::publish::name_for(counter, random);
            seen.borrow_mut().push(name.clone());
            match decide(index) {
                Some(Squat::File(content)) => std::fs::write(dir.join(&name), content).unwrap(),
                Some(Squat::Link) => {
                    std::os::unix::fs::symlink(dir.join("victim-target"), dir.join(&name)).unwrap()
                }
                Some(Squat::Fail) => return Err(std::io::Error::other("no entropy")),
                None => {}
            }
            Ok(())
        }))
    });
    let result = run();
    super::publish::NAME_SOURCE.with(|cell| *cell.borrow_mut() = None);
    let names = names.borrow().clone();
    (result, names)
}

/// `.geul-save-{이 프로세스}-{순번}-{32 hex}.tmp`인지.
#[cfg(target_os = "linux")]
fn random_temp_name(name: &str) -> Option<&str> {
    let rest = name.strip_prefix(&format!(".geul-save-{}-", std::process::id()))?;
    let rest = rest.strip_suffix(".tmp")?;
    let (counter, random) = rest.split_once('-')?;
    (counter.bytes().all(|b| b.is_ascii_digit())
        && random.len() == 32
        && random
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
    .then_some(random)
}

/// 이 세션이 지금 dirty인지(레지스트리 기준).
#[cfg(target_os = "linux")]
fn dirty_now(doc: &Docx) -> bool {
    doc.state.registry().get(doc.info.session_id).unwrap().dirty
}

#[cfg(target_os = "linux")]
#[test]
fn h5_임시_파일_이름은_운영체제_난수로_정하고_충돌_소진_난수_실패는_원본을_지킨다() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let original = basic::basic_ko().unwrap();
    let write_failure = Some(DocumentError::SaveFailure {
        stage: SaveStage::Write,
        io: Some(IoProblem::Other),
    });
    // A·L. 제품 난수로 만든 이름, 검증한 그 inode가 게시된다.
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    let staged = std::rc::Rc::new(std::cell::RefCell::new((String::new(), 0u64)));
    let record = staged.clone();
    super::publish::BEFORE_RENAME.with(|cell| {
        *cell.borrow_mut() = Some(Box::new(move |_, path: &Path| {
            let ino = std::fs::symlink_metadata(path).unwrap().ino();
            *record.borrow_mut() = (
                path.file_name().unwrap().to_string_lossy().into_owned(),
                ino,
            );
        }))
    });
    let saved = save_with_fault(&doc, None);
    super::publish::BEFORE_RENAME.with(|cell| *cell.borrow_mut() = None);
    assert!(saved.unwrap().durable);
    let (name, ino) = staged.borrow().clone();
    assert!(random_temp_name(&name).is_some(), "{name}");
    assert_eq!(std::fs::metadata(&doc.path).unwrap().ino(), ino);
    assert_eq!(doc.leftovers(), Vec::<String>::new());
    // C. 같은 문서를 여러 번 저장해도 이름의 무작위 부분이 겹치지 않는다.
    let randoms = std::rc::Rc::new(std::cell::RefCell::new(std::collections::HashSet::new()));
    let record = randoms.clone();
    super::publish::BEFORE_RENAME.with(|cell| {
        *cell.borrow_mut() = Some(Box::new(move |_, path: &Path| {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            record
                .borrow_mut()
                .insert(random_temp_name(&name).unwrap().to_owned());
        }))
    });
    for round in 0..100 {
        doc.info = doc.state.registry().get(doc.info.session_id).unwrap();
        doc.edit(vec![DocxOp::InsertText { text: "a".into() }]);
        doc.preflight().unwrap();
        assert!(save_with_fault(&doc, None).is_ok(), "{round}");
    }
    super::publish::BEFORE_RENAME.with(|cell| *cell.borrow_mut() = None);
    assert_eq!(randoms.borrow().len(), 100);
    assert_eq!(doc.leftovers(), Vec::<String>::new());

    // D·E·F·M. 첫 후보에 남의 파일, 둘째에 심볼릭 링크: 건드리지 않고 셋째 이름으로 저장한다.
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    std::fs::write(doc.dir.path().join("victim-target"), b"target").unwrap();
    let (saved, names) = with_names(
        &doc,
        |i| match i {
            0 => Some(Squat::File(b"someone else")),
            1 => Some(Squat::Link),
            _ => None,
        },
        || save_with_fault(&doc, None),
    );
    assert!(saved.unwrap().durable);
    assert_eq!(names.len(), 3);
    assert_eq!(
        std::fs::read(doc.dir.path().join(&names[0])).unwrap(),
        b"someone else"
    );
    assert!(std::fs::symlink_metadata(doc.dir.path().join(&names[1]))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        std::fs::read(doc.dir.path().join("victim-target")).unwrap(),
        b"target"
    );
    assert!(
        !doc.dir.path().join(&names[2]).exists(),
        "게시해서 이름이 사라짐"
    );
    assert_ne!(doc.bytes(), original);

    // G. 모든 후보(64개)가 이미 있음: 안전하게 실패하고, 남의 파일은 그대로, 원본·dirty 그대로.
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    let (failed, names) = with_names(
        &doc,
        |_| Some(Squat::File(b"squat")),
        || save_with_fault(&doc, None),
    );
    assert_eq!(failed.err(), write_failure);
    assert_eq!(names.len(), 64);
    assert_eq!(doc.bytes(), original);
    assert!(dirty_now(&doc));
    let mut left = doc.leftovers();
    left.sort();
    let mut squatted = names.clone();
    squatted.sort();
    assert_eq!(left, squatted);
    for name in &names {
        std::fs::remove_file(doc.dir.path().join(name)).unwrap();
    }

    // H. 난수 실패: 처음부터, 한 번 겹친 뒤. 짐작할 수 있는 이름으로 대신하지 않고 만들지 않는다.
    for (label, fail_at) in [("first", 0usize), ("after-collision", 1)] {
        let (failed, names) = with_names(
            &doc,
            move |i| {
                if i == fail_at {
                    Some(Squat::Fail)
                } else {
                    Some(Squat::File(b"squat"))
                }
            },
            || save_with_fault(&doc, None),
        );
        assert_eq!(failed.err(), write_failure, "{label}");
        assert_eq!(names.len(), fail_at + 1, "{label}");
        assert_eq!(doc.bytes(), original, "{label}");
        assert!(dirty_now(&doc), "{label}");
        let left = doc.leftovers();
        assert_eq!(
            left,
            names[..fail_at].to_vec(),
            "{label}: 겹친 남의 파일만 남음"
        );
        for name in left {
            std::fs::remove_file(doc.dir.path().join(name)).unwrap();
        }
    }

    // I·J·K·N. 만든 직후 실패, 검증 뒤 원본 바뀜, 교체 실패, 되읽기 실패: 이 저장의 임시 파일만 지우고 남의 파일은 둔다.
    for fault in [
        Fault::AfterCreate,
        Fault::Verify,
        Fault::BeforePublish,
        Fault::Rename(std::io::ErrorKind::PermissionDenied),
    ] {
        let (failed, names) = with_names(
            &doc,
            |i| (i == 0).then_some(Squat::File(b"other")),
            || save_with_fault(&doc, Some(fault)),
        );
        assert!(failed.is_err(), "{fault:?}");
        assert_eq!(names.len(), 2, "{fault:?}");
        assert_eq!(doc.bytes(), original, "{fault:?}");
        assert!(dirty_now(&doc), "{fault:?}");
        assert_eq!(doc.leftovers(), vec![names[0].clone()], "{fault:?}");
        assert_eq!(
            std::fs::read(doc.dir.path().join(&names[0])).unwrap(),
            b"other"
        );
        std::fs::remove_file(doc.dir.path().join(&names[0])).unwrap();
    }

    // O·P. sticky 1777(이 사용자 소유)은 저장, sticky 없는 공유(0777)는 이름을 만들기 전에 막는다.
    std::fs::set_permissions(doc.dir.path(), std::fs::Permissions::from_mode(0o1777)).unwrap();
    let (saved, names) = with_names(&doc, |_| None, || save_with_fault(&doc, None));
    assert!(saved.unwrap().durable);
    assert_eq!(names.len(), 1);
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    std::fs::set_permissions(doc.dir.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
    let (failed, names) = with_names(&doc, |_| None, || save_with_fault(&doc, None));
    std::fs::set_permissions(doc.dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        failed.err(),
        Some(DocumentError::SaveUnsupported {
            reason: SaveUnsupportedReason::SharedDirectory
        })
    );
    assert!(names.is_empty(), "이름을 만들기 전에 막음");
    assert_eq!(doc.bytes(), original);
    assert_eq!(doc.leftovers(), Vec::<String>::new());
}

#[cfg(target_os = "linux")]
#[test]
fn h5_동시에_저장하는_두_문서는_서로_다른_무작위_이름을_쓴다() {
    // B. 두 스레드에서 동시에(제품 난수로) 저장한다. 각 스레드의 교체 직전 훅으로 이름을 모은다.
    let original = basic::basic_ko().unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let original = original.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut doc = open_docx(&original);
                doc.edit(edits());
                doc.preflight().unwrap();
                let name = std::rc::Rc::new(std::cell::RefCell::new(String::new()));
                let record = name.clone();
                super::publish::BEFORE_RENAME.with(|cell| {
                    *cell.borrow_mut() = Some(Box::new(move |_, path: &Path| {
                        *record.borrow_mut() =
                            path.file_name().unwrap().to_string_lossy().into_owned();
                    }))
                });
                barrier.wait();
                let saved = save_with_fault(&doc, None);
                super::publish::BEFORE_RENAME.with(|cell| *cell.borrow_mut() = None);
                assert!(saved.unwrap().durable);
                assert_eq!(doc.leftovers(), Vec::<String>::new());
                let name = name.borrow().clone();
                random_temp_name(&name).unwrap().to_owned()
            })
        })
        .collect();
    let randoms: Vec<String> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_ne!(randoms[0], randoms[1]);
}

/// 불변식을 모두 지킨 관찰(배치별). 판정 시험의 기준.
fn clean_observation(layout: ProbeLayout) -> ProbeObservation {
    let shared_rejection = ProbeSave::Rejected {
        error: DocumentError::SaveUnsupported {
            reason: SaveUnsupportedReason::SharedDirectory,
        },
        dirty: true,
    };
    let (saves, swaps_seen, real_is_original, real_is_last_saved) = match layout {
        ProbeLayout::Swappable => (
            vec![shared_rejection, ProbeSave::PreflightFailed],
            3,
            true,
            false,
        ),
        ProbeLayout::Locked => (
            vec![
                ProbeSave::Saved {
                    durable: true,
                    dirty: false
                };
                2
            ],
            0,
            false,
            true,
        ),
    };
    ProbeObservation {
        layout,
        saves,
        swaps_seen,
        attacker: Some(AttackerReport {
            attempts: 10,
            swaps: if layout == ProbeLayout::Swappable {
                10
            } else {
                0
            },
            readable_documents: 0,
        }),
        sample_failures: 0,
        restored: Some(true),
        real_entries: Some(vec!["a.docx".into()]),
        wrong_entries: Some(vec![PROBE_SENTINEL.into()]),
        real_file: Some(ProbeRealFile {
            present: true,
            is_original: real_is_original,
            inode_is_original: real_is_original,
            is_last_saved: real_is_last_saved,
        }),
        sentinel_intact: Some(true),
        final_preflight_ok: Some(true),
    }
}

#[test]
fn a5_다중_사용자_탐침_판정은_위반을_실패로_조건_부족을_판단_불가로_낸다() {
    let fail = |v: &ProbeVerdict| matches!(v, ProbeVerdict::Fail(_));
    let unknown = |v: &ProbeVerdict| matches!(v, ProbeVerdict::Inconclusive(_));
    for layout in [ProbeLayout::Swappable, ProbeLayout::Locked] {
        assert_eq!(
            probe_verdict(&clean_observation(layout)),
            ProbeVerdict::Pass,
            "{layout:?}"
        );
        type Inject = (&'static str, fn(&mut ProbeObservation));
        let violations: [Inject; 9] = [
            ("wrong-dir publish", |o| {
                o.wrong_entries.as_mut().unwrap().push("a.docx".into())
            }),
            ("wrong-dir temp", |o| {
                o.wrong_entries
                    .as_mut()
                    .unwrap()
                    .push(".geul-save-1-2-ab.tmp".into())
            }),
            ("real-dir temp", |o| {
                o.real_entries
                    .as_mut()
                    .unwrap()
                    .push(".geul-save-1-2-ab.tmp".into())
            }),
            ("original missing", |o| {
                o.real_entries.as_mut().unwrap().clear()
            }),
            ("sentinel", |o| o.sentinel_intact = Some(false)),
            ("disclosure", |o| {
                o.attacker.as_mut().unwrap().readable_documents = 1
            }),
            ("dirty cleared on rejection", |o| {
                o.saves.push(ProbeSave::Rejected {
                    error: DocumentError::FileConflict,
                    dirty: false,
                })
            }),
            ("stale record", |o| {
                o.saves.push(ProbeSave::Saved {
                    durable: true,
                    dirty: false,
                });
                o.final_preflight_ok = Some(false);
            }),
            ("content", |o| {
                o.real_file = Some(ProbeRealFile {
                    present: true,
                    is_original: false,
                    inode_is_original: false,
                    is_last_saved: false,
                });
            }),
        ];
        for (name, inject) in violations {
            let mut o = clean_observation(layout);
            inject(&mut o);
            assert!(
                fail(&probe_verdict(&o)),
                "{layout:?} {name}: {:?}",
                probe_verdict(&o)
            );
        }
    }
    // 배치별 위반: 공유 상위 아래 저장(내구성 확인이어도), 믿는 배치에서 durable false·dirty.
    let mut o = clean_observation(ProbeLayout::Swappable);
    o.saves.push(ProbeSave::Saved {
        durable: true,
        dirty: false,
    });
    o.real_file = Some(ProbeRealFile {
        present: true,
        is_original: false,
        inode_is_original: false,
        is_last_saved: true,
    });
    assert!(fail(&probe_verdict(&o)));
    for (durable, dirty) in [(false, true), (true, true), (false, false)] {
        let mut o = clean_observation(ProbeLayout::Locked);
        o.saves.push(ProbeSave::Saved { durable, dirty });
        assert!(fail(&probe_verdict(&o)), "{durable} {dirty}");
    }
    // 판단 불가: 공격이 없음·표지 없음·시도 0·배치가 돌아오지 않음·맞바꿈을 못 봄·확인까지 간 저장 없음·저장 없음·믿는
    // 배치에서 맞바꿈.
    type Inject = (&'static str, ProbeLayout, fn(&mut ProbeObservation));
    let inconclusive: [Inject; 8] = [
        ("no report", ProbeLayout::Swappable, |o| o.attacker = None),
        ("no attempts", ProbeLayout::Locked, |o| {
            o.attacker.as_mut().unwrap().attempts = 0
        }),
        ("not restored", ProbeLayout::Swappable, |o| {
            o.restored = Some(false)
        }),
        ("no swap seen", ProbeLayout::Swappable, |o| o.swaps_seen = 0),
        ("never checked", ProbeLayout::Swappable, |o| {
            o.saves = vec![ProbeSave::PreflightFailed]
        }),
        ("no saves", ProbeLayout::Locked, |o| {
            o.saves.clear();
            o.real_file = Some(ProbeRealFile {
                present: true,
                is_original: true,
                inode_is_original: true,
                is_last_saved: false,
            });
        }),
        ("swap in locked", ProbeLayout::Locked, |o| o.swaps_seen = 1),
        ("attacker swaps in locked", ProbeLayout::Locked, |o| {
            o.attacker.as_mut().unwrap().swaps = 2
        }),
    ];
    for (name, layout, inject) in inconclusive {
        let mut o = clean_observation(layout);
        inject(&mut o);
        assert!(
            unknown(&probe_verdict(&o)),
            "{name}: {:?}",
            probe_verdict(&o)
        );
    }
    // 실패가 판단 불가보다 앞선다(공격 표지가 없어도 다른 디렉터리 게시는 실패).
    let mut o = clean_observation(ProbeLayout::Swappable);
    o.attacker = None;
    o.wrong_entries.as_mut().unwrap().push("a.docx".into());
    assert!(fail(&probe_verdict(&o)));
    // 완료 표지: 이번 실행의 표지·정확한 모양만.
    let nonce = "0123abcd";
    assert_eq!(
        parse_attacker_report("nonce=0123abcd attempts=5 swaps=4 readable=0\n", nonce),
        Some(AttackerReport {
            attempts: 5,
            swaps: 4,
            readable_documents: 0
        })
    );
    for text in [
        "nonce=ffff attempts=5 swaps=4 readable=0",
        "nonce=0123abcd attempts=5 swaps=4",
        "nonce=0123abcd attempts=5 swaps=4 readable=0 extra=1",
        "nonce=0123abcd attempts=5 attempts=6 readable=0",
        "nonce=0123abcd attempts=-1 swaps=4 readable=0",
        "",
    ] {
        assert_eq!(parse_attacker_report(text, nonce), None, "{text}");
    }
}

/// 같은 프로세스 안의 시험용 공격: 회차마다 `docs`·`other`를 맞바꾸고(공유 상위가 허락하면), 원래 `other` 디렉터리 객체에서
/// 문서(ZIP) 내용이 든 파일을 센다. 멈춤 표지가 생기면 원래 배치로 되돌리고 완료 표지를 쓴다(`nonce`를 `answer`로 바꿔 쓸 수 있다).
#[cfg(target_os = "linux")]
fn in_process_probe(
    shared: &Path,
    layout: ProbeLayout,
    swap: bool,
    answer: fn(&str, u64, u64, u64) -> String,
    before_examine: &mut dyn FnMut(&Path, &Path),
) -> (ProbeVerdict, String) {
    use std::os::unix::fs::MetadataExt;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    let markers = shared.parent().unwrap().join("markers");
    std::fs::create_dir_all(&markers).unwrap();
    let (ready, stop, done) = (
        markers.join("ready"),
        markers.join("stop"),
        markers.join("done"),
    );
    let counts = Arc::new([AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)]);
    let (docs, other) = (shared.join("docs"), shared.join("other"));
    let responder = {
        let (counts, ready, stop, done) =
            (counts.clone(), ready.clone(), stop.clone(), done.clone());
        let (docs, other) = (docs.clone(), other.clone());
        std::thread::spawn(move || {
            while !stop.exists() {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            if counts[1].load(Ordering::SeqCst) % 2 == 1 {
                exchange(&docs, &other);
                counts[1].fetch_add(1, Ordering::SeqCst);
            }
            let nonce = std::fs::read_to_string(&ready).unwrap_or_default();
            let [a, s, r] = &*counts;
            let text = answer(
                &nonce,
                a.load(Ordering::SeqCst),
                s.load(Ordering::SeqCst),
                r.load(Ordering::SeqCst),
            );
            std::fs::write(&done, text).unwrap();
        })
    };
    let mut other_ino = None;
    let mut step = |_round: usize| {
        let other_ino = *other_ino.get_or_insert_with(|| std::fs::metadata(&other).unwrap().ino());
        counts[0].fetch_add(1, Ordering::SeqCst);
        if swap {
            exchange(&docs, &other);
            counts[1].fetch_add(1, Ordering::SeqCst);
        }
        // 원래 other 객체(지금 어느 이름이든)에서 문서 내용 파일을 센다.
        for dir in [&docs, &other] {
            if std::fs::metadata(dir).is_ok_and(|m| m.ino() == other_ino) {
                for entry in std::fs::read_dir(dir).unwrap().flatten() {
                    if std::fs::read(entry.path()).is_ok_and(|b| b.starts_with(b"PK")) {
                        counts[2].fetch_add(1, Ordering::SeqCst);
                    }
                }
            }
        }
    };
    let result = run_probe(ProbeRun {
        shared: shared.to_path_buf(),
        rounds: 6,
        layout,
        ready,
        stop,
        done,
        step: &mut step,
        before_examine,
        random: &mut os_getrandom,
        list_fault: None,
    });
    responder.join().unwrap();
    result
}

#[cfg(target_os = "linux")]
#[test]
fn a5_탐침은_실제_저장_경로에서_통과하고_주입한_위반을_실패로_잡는다() {
    use std::os::unix::fs::PermissionsExt;
    let honest = |nonce: &str, a: u64, s: u64, r: u64| {
        format!("nonce={nonce} attempts={a} swaps={s} readable={r}")
    };
    let set = |path: &Path, bits: u32| {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(bits)).unwrap()
    };
    // 공유 상위(0777, 같은 uid가 공격을 흉내): 저장은 모두 거부되고 판정은 PASS.
    let run = |layout: ProbeLayout,
               swap: bool,
               answer: fn(&str, u64, u64, u64) -> String,
               inject: &mut dyn FnMut(&Path, &Path)| {
        let root = TempDir::new();
        let shared = root.path().join("shared");
        std::fs::create_dir(&shared).unwrap();
        set(
            &shared,
            if layout == ProbeLayout::Swappable {
                0o777
            } else {
                0o755
            },
        );
        let result = in_process_probe(&shared, layout, swap, answer, inject);
        set(&shared, 0o755);
        result
    };
    let (verdict, summary) = run(ProbeLayout::Swappable, true, honest, &mut |_, _| {});
    assert_eq!(verdict, ProbeVerdict::Pass, "{summary}");
    let (verdict, summary) = run(ProbeLayout::Locked, false, honest, &mut |_, _| {});
    assert_eq!(verdict, ProbeVerdict::Pass, "{summary}");
    // 음성 대조: 판정 직전에 위반을 디스크에 주입한다(측정 코드가 실제로 잡는지).
    type Inject = (&'static str, fn(&Path, &Path));
    let injections: [Inject; 4] = [
        ("published into other", |_real, wrong| {
            std::fs::copy(_real.join("a.docx"), wrong.join("a.docx"))
                .map(|_| ())
                .unwrap()
        }),
        ("leftover temp", |real, _| {
            std::fs::write(real.join(".geul-save-1-1-00.tmp"), b"PK").unwrap()
        }),
        ("unrelated changed", |_, wrong| {
            std::fs::write(wrong.join(PROBE_SENTINEL), b"changed").unwrap()
        }),
        ("original replaced", |real, _| {
            let tmp = real.join("replacement");
            std::fs::write(&tmp, b"PK replaced").unwrap();
            std::fs::rename(&tmp, real.join("a.docx")).unwrap();
        }),
    ];
    for (name, inject) in injections {
        let (verdict, summary) = run(ProbeLayout::Swappable, true, honest, &mut |real, wrong| {
            inject(real, wrong)
        });
        assert!(
            matches!(verdict, ProbeVerdict::Fail(_)),
            "{name}: {verdict:?} {summary}"
        );
    }
    // 공격 쪽이 노출을 보고하면 실패.
    let leaked = |nonce: &str, a: u64, s: u64, _: u64| {
        format!("nonce={nonce} attempts={a} swaps={s} readable=1")
    };
    let (verdict, _) = run(ProbeLayout::Swappable, true, leaked, &mut |_, _| {});
    assert!(matches!(verdict, ProbeVerdict::Fail(_)), "{verdict:?}");
    // 판단 불가: 다른 실행의 표지, 공격이 맞바꾸지 않음(공유 상위인데 맞바꿈을 못 봄).
    let foreign =
        |_: &str, a: u64, s: u64, r: u64| format!("nonce=00 attempts={a} swaps={s} readable={r}");
    let (verdict, _) = run(ProbeLayout::Swappable, true, foreign, &mut |_, _| {});
    assert!(
        matches!(verdict, ProbeVerdict::Inconclusive(_)),
        "{verdict:?}"
    );
    let (verdict, _) = run(ProbeLayout::Swappable, false, honest, &mut |_, _| {});
    assert!(
        matches!(verdict, ProbeVerdict::Inconclusive(_)),
        "{verdict:?}"
    );
    // 판단 불가: 선언한 배치가 실제 권한과 다름(0755인데 swappable이라 함).
    let root = TempDir::new();
    let shared = root.path().join("shared");
    std::fs::create_dir(&shared).unwrap();
    let markers = root.path().join("markers");
    std::fs::create_dir(&markers).unwrap();
    let (verdict, _) = run_probe(ProbeRun {
        shared,
        rounds: 2,
        layout: ProbeLayout::Swappable,
        ready: markers.join("ready"),
        stop: markers.join("stop"),
        done: markers.join("done"),
        step: &mut |_| {},
        before_examine: &mut |_, _| {},
        random: &mut os_getrandom,
        list_fault: None,
    });
    assert!(
        matches!(verdict, ProbeVerdict::Inconclusive(_)),
        "{verdict:?}"
    );
    // 실행 안 됨: 이전 실행의 표지가 남아 있음.
    let root = TempDir::new();
    let shared = root.path().join("shared");
    std::fs::create_dir(&shared).unwrap();
    let markers = root.path().join("markers");
    std::fs::create_dir(&markers).unwrap();
    std::fs::write(
        markers.join("done"),
        b"nonce=old attempts=9 swaps=9 readable=0",
    )
    .unwrap();
    let (verdict, _) = run_probe(ProbeRun {
        shared,
        rounds: 2,
        layout: ProbeLayout::Swappable,
        ready: markers.join("ready"),
        stop: markers.join("stop"),
        done: markers.join("done"),
        step: &mut |_| {},
        before_examine: &mut |_, _| {},
        random: &mut os_getrandom,
        list_fault: None,
    });
    assert!(matches!(verdict, ProbeVerdict::NotRun(_)), "{verdict:?}");
}

// ---- T009 시험 기반 안정화 B: 측정하지 못한 것은 깨끗한 관찰이 아니다 ----

/// 시험 디렉터리 권한을 되돌린다(정리할 수 있게, 없어진 경로는 건너뜀).
#[cfg(target_os = "linux")]
fn restore_probe_dirs(shared: &Path) {
    use std::os::unix::fs::PermissionsExt;
    for dir in [shared.join("docs"), shared.join("other")] {
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755));
    }
}

#[cfg(target_os = "linux")]
#[test]
fn a6_측정하지_못한_디렉터리는_통과의_근거가_아니고_확인된_위반은_실패다() {
    use std::os::unix::fs::PermissionsExt;
    let honest = |nonce: &str, a: u64, s: u64, r: u64| {
        format!("nonce={nonce} attempts={a} swaps={s} readable={r}")
    };
    fn unreadable(dir: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o311)).unwrap()
    }
    type Inject = (&'static str, fn(&Path, &Path), &'static str);
    let cases: [Inject; 7] = [
        // 측정 실패만: 판단 불가.
        (
            "other unreadable",
            |_, wrong| unreadable(wrong),
            "INCONCLUSIVE",
        ),
        (
            "real unreadable",
            |real, _| unreadable(real),
            "INCONCLUSIVE",
        ),
        (
            "other unreadable with hidden publication",
            |real, wrong| {
                std::fs::copy(real.join("a.docx"), wrong.join("a.docx")).unwrap();
                unreadable(wrong);
            },
            "INCONCLUSIVE",
        ),
        (
            "other disappeared",
            |_, wrong| std::fs::rename(wrong, wrong.with_extension("gone")).unwrap(),
            "INCONCLUSIVE",
        ),
        (
            "other replaced",
            |_, wrong| {
                std::fs::rename(wrong, wrong.with_extension("gone")).unwrap();
                std::fs::create_dir(wrong).unwrap();
            },
            "INCONCLUSIVE",
        ),
        // 측정 실패가 있어도 따로 확인한 위반은 실패.
        (
            "real unreadable but publication seen in other",
            |real, wrong| {
                std::fs::write(wrong.join("a.docx"), b"PK published").unwrap();
                unreadable(real);
            },
            "FAIL",
        ),
        (
            "other unreadable but temp left in real",
            |real, wrong| {
                std::fs::write(real.join(".geul-save-1-1-00.tmp"), b"PK").unwrap();
                unreadable(wrong);
            },
            "FAIL",
        ),
    ];
    let mut wrong_results = Vec::new();
    for (name, inject, expected) in cases {
        let root = TempDir::new();
        let shared = root.path().join("shared");
        std::fs::create_dir(&shared).unwrap();
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();
        let (verdict, _) = in_process_probe(
            &shared,
            ProbeLayout::Swappable,
            true,
            honest,
            &mut |real, wrong| inject(real, wrong),
        );
        restore_probe_dirs(&shared);
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o755)).unwrap();
        let label = match verdict {
            ProbeVerdict::Pass => "PASS",
            ProbeVerdict::Fail(_) => "FAIL",
            ProbeVerdict::Inconclusive(_) => "INCONCLUSIVE",
            ProbeVerdict::NotRun(_) => "NOT-RUN",
        };
        if label != expected {
            wrong_results.push(format!("{name}: {label} (기대 {expected}) {verdict:?}"));
        }
    }
    assert!(wrong_results.is_empty(), "{}", wrong_results.join("\n"));
}

#[cfg(target_os = "linux")]
#[test]
fn a6_목록_측정은_빈_디렉터리와_측정_실패를_구분하고_중간_오류도_실패로_본다() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let root = TempDir::new();
    let dir = root.path().join("d");
    std::fs::create_dir(&dir).unwrap();
    let ino = std::fs::metadata(&dir).unwrap().ino();
    // A. 빈 디렉터리는 성공한 측정(빈 목록).
    assert_eq!(measure_dir(&dir, ino, None), Some(vec![]));
    std::fs::write(dir.join("b"), b"").unwrap();
    std::fs::write(dir.join("a"), b"").unwrap();
    assert_eq!(
        measure_dir(&dir, ino, None),
        Some(vec!["a".into(), "b".into()])
    );
    // B·C. 읽을 수 없음, 하나 읽은 뒤 오류: 측정 실패(빈 목록이나 일부 목록이 아님).
    assert_eq!(measure_dir(&dir, ino, Some(1)), None);
    assert_eq!(measure_dir(&dir, ino, Some(0)), None);
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o311)).unwrap();
    assert_eq!(measure_dir(&dir, ino, None), None);
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    // D. 다른 inode(바뀜)·없어짐·디렉터리가 아님.
    assert_eq!(measure_dir(&dir, ino + 1, None), None);
    std::fs::rename(&dir, root.path().join("gone")).unwrap();
    assert_eq!(measure_dir(&dir, ino, None), None);
    std::fs::write(&dir, b"file").unwrap();
    assert_eq!(measure_dir(&dir, ino, None), None);
}

#[cfg(target_os = "linux")]
#[test]
fn a6_목록이_중간에_끊기면_통과하지_않고_다른_쪽에서_본_위반은_실패다() {
    use std::os::unix::fs::PermissionsExt;
    let honest = |nonce: &str, a: u64, s: u64, r: u64| {
        format!("nonce={nonce} attempts={a} swaps={s} readable={r}")
    };
    let run = |list_fault: (bool, usize), inject: fn(&Path, &Path)| {
        let root = TempDir::new();
        let shared = root.path().join("shared");
        std::fs::create_dir(&shared).unwrap();
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();
        let markers = root.path().join("markers");
        std::fs::create_dir(&markers).unwrap();
        // 공격 쪽 흉내: 회차마다 맞바꾸고, 멈춤 표지에 원래 배치로 되돌린 뒤 완료 표지를 쓴다.
        let (docs, other) = (shared.join("docs"), shared.join("other"));
        let swaps = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let responder = {
            let (swaps, markers, docs, other) =
                (swaps.clone(), markers.clone(), docs.clone(), other.clone());
            std::thread::spawn(move || {
                while !markers.join("stop").exists() {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                let mut n = swaps.load(std::sync::atomic::Ordering::SeqCst);
                if n % 2 == 1 {
                    exchange(&docs, &other);
                    n += 1;
                }
                let nonce = std::fs::read_to_string(markers.join("ready")).unwrap_or_default();
                std::fs::write(markers.join("done"), honest(&nonce, n, n, 0)).unwrap();
            })
        };
        let mut step = |_| {
            exchange(&docs, &other);
            swaps.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        };
        let (verdict, summary) = run_probe(ProbeRun {
            shared: shared.clone(),
            rounds: 4,
            layout: ProbeLayout::Swappable,
            ready: markers.join("ready"),
            stop: markers.join("stop"),
            done: markers.join("done"),
            step: &mut step,
            before_examine: &mut |real, wrong| inject(real, wrong),
            random: &mut os_getrandom,
            list_fault: Some(list_fault),
        });
        responder.join().unwrap();
        restore_probe_dirs(&shared);
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o755)).unwrap();
        (verdict, summary)
    };
    // 목록을 읽다가 오류(원본 쪽·다른 쪽): 판단 불가(통과 아님). 항목 하나를 읽은 뒤 끊기는 경우는 `measure_dir` 시험이 본다.
    let (verdict, summary) = run((true, 0), |_, _| {});
    assert!(
        matches!(verdict, ProbeVerdict::Inconclusive(_)),
        "{verdict:?} {summary}"
    );
    assert!(summary.contains("real_entries=None"), "{summary}");
    let (verdict, _) = run((false, 0), |_, _| {});
    assert!(
        matches!(verdict, ProbeVerdict::Inconclusive(_)),
        "{verdict:?}"
    );
    // 원본 쪽 측정이 끊겨도 다른 디렉터리에서 본 게시는 실패(E).
    let (verdict, _) = run((true, 0), |_, wrong| {
        std::fs::write(wrong.join("a.docx"), b"PK").unwrap()
    });
    assert!(matches!(verdict, ProbeVerdict::Fail(_)), "{verdict:?}");
}

#[test]
fn a6_판정은_측정하지_못한_값을_깨끗하다고_보지_않는다() {
    let unknown = |v: &ProbeVerdict| matches!(v, ProbeVerdict::Inconclusive(_));
    let fail = |v: &ProbeVerdict| matches!(v, ProbeVerdict::Fail(_));
    type Inject = (&'static str, ProbeLayout, fn(&mut ProbeObservation));
    // J. 나머지가 깨끗해도 필수 측정이 하나라도 없으면 판단 불가.
    let missing: [Inject; 8] = [
        ("real entries", ProbeLayout::Swappable, |o| {
            o.real_entries = None
        }),
        ("wrong entries", ProbeLayout::Swappable, |o| {
            o.wrong_entries = None
        }),
        ("real file", ProbeLayout::Swappable, |o| o.real_file = None),
        ("sentinel", ProbeLayout::Locked, |o| {
            o.sentinel_intact = None
        }),
        ("final preflight after save", ProbeLayout::Locked, |o| {
            o.final_preflight_ok = None
        }),
        ("arrangement", ProbeLayout::Swappable, |o| o.restored = None),
        ("path samples", ProbeLayout::Swappable, |o| {
            o.sample_failures = 3
        }),
        ("path samples (locked)", ProbeLayout::Locked, |o| {
            o.sample_failures = 1
        }),
    ];
    for (name, layout, inject) in missing {
        let mut o = clean_observation(layout);
        inject(&mut o);
        let verdict = probe_verdict(&o);
        assert!(unknown(&verdict), "{name}: {verdict:?}");
        assert!(
            format!("{verdict:?}").contains("측정 실패"),
            "{name}: {verdict:?}"
        );
    }
    // 저장이 없으면 공격을 멈춘 뒤 사전 검사는 필수가 아니다.
    let mut o = clean_observation(ProbeLayout::Swappable);
    o.final_preflight_ok = None;
    assert_eq!(probe_verdict(&o), ProbeVerdict::Pass);
    // E·F·G·H. 다른 측정이 없어도 확인한 위반은 실패.
    let confirmed: [Inject; 5] = [
        (
            "publication with missing real entries",
            ProbeLayout::Swappable,
            |o| {
                o.real_entries = None;
                o.wrong_entries.as_mut().unwrap().push("a.docx".into());
            },
        ),
        (
            "temp with missing other entries",
            ProbeLayout::Swappable,
            |o| {
                o.wrong_entries = None;
                o.real_entries
                    .as_mut()
                    .unwrap()
                    .push(".geul-save-1-1-ab.tmp".into());
            },
        ),
        (
            "unrelated changed with missing real file",
            ProbeLayout::Locked,
            |o| {
                o.real_file = None;
                o.sentinel_intact = Some(false);
            },
        ),
        (
            "original missing (confirmed absent)",
            ProbeLayout::Swappable,
            |o| {
                o.real_entries = None;
                o.real_file = Some(ProbeRealFile {
                    present: false,
                    is_original: false,
                    inode_is_original: false,
                    is_last_saved: false,
                });
            },
        ),
        (
            "record mismatch with missing samples",
            ProbeLayout::Locked,
            |o| {
                o.sample_failures = 2;
                o.final_preflight_ok = Some(false);
            },
        ),
    ];
    for (name, layout, inject) in confirmed {
        let mut o = clean_observation(layout);
        inject(&mut o);
        assert!(fail(&probe_verdict(&o)), "{name}: {:?}", probe_verdict(&o));
    }
    // I. 완전하고 깨끗한 관찰은 통과.
    for layout in [ProbeLayout::Swappable, ProbeLayout::Locked] {
        assert_eq!(
            probe_verdict(&clean_observation(layout)),
            ProbeVerdict::Pass
        );
    }
}

#[test]
fn c6_표지_난수는_짧은_읽기와_eintr를_이어_받고_0바이트와_오류는_실패한다() {
    use std::io::{Error, ErrorKind};
    // 정해진 순서로 응답하는 원천: Ok(n)이면 그만큼 0xab로 채운다.
    fn scripted(
        script: Vec<std::io::Result<usize>>,
    ) -> impl FnMut(&mut [u8]) -> std::io::Result<usize> {
        let mut script = script.into_iter();
        move |buf: &mut [u8]| match script.next().expect("원천을 더 부름") {
            Ok(n) => {
                let len = n.min(buf.len());
                buf[..len].fill(0xab);
                Ok(n)
            }
            Err(error) => Err(error),
        }
    }
    let mut buf = [0u8; 16];
    // 1. 한 번에 다 채움.
    assert!(fill_nonce(&mut buf, &mut scripted(vec![Ok(16)])).is_ok());
    // 2. 여러 번 짧게 읽힘.
    let mut buf = [0u8; 16];
    assert!(fill_nonce(&mut buf, &mut scripted(vec![Ok(5), Ok(1), Ok(10)])).is_ok());
    assert_eq!(buf, [0xab; 16]);
    // 3. EINTR 뒤 성공(사이에 짧은 읽기도).
    let interrupted = || Err(Error::from(ErrorKind::Interrupted));
    assert!(fill_nonce(
        &mut [0u8; 16],
        &mut scripted(vec![interrupted(), Ok(8), interrupted(), Ok(8)])
    )
    .is_ok());
    // 4. 0바이트, 5. 다시 시도할 수 없는 오류, 6. 일부 읽은 뒤 오류, 요청보다 많다고 함: 실패.
    for script in [
        vec![Ok(0)],
        vec![Err(Error::from(ErrorKind::Unsupported))],
        vec![Ok(7), Err(Error::other("boom"))],
        vec![Ok(4), Ok(0)],
        vec![Ok(17)],
    ] {
        assert!(fill_nonce(&mut [0u8; 16], &mut scripted(script)).is_err());
    }
    // 7·8. 표지: 실패하면 값이 없고(대신하는 값 없음), 성공하면 소문자 hex 32자.
    assert!(probe_nonce(&mut scripted(vec![Ok(3), Err(Error::other("x"))])).is_err());
    let nonce = probe_nonce(&mut scripted(vec![Ok(10), Ok(6)])).unwrap();
    assert_eq!(nonce, "ab".repeat(16));
    assert!(
        nonce.len() == 32
            && nonce
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    );
}

#[cfg(target_os = "linux")]
#[test]
fn c6_실제_난수로_만든_표지는_매번_다르고_난수_실패는_not_run이다() {
    use std::os::unix::fs::PermissionsExt;
    let a = probe_nonce(&mut os_getrandom).unwrap();
    let b = probe_nonce(&mut os_getrandom).unwrap();
    assert_ne!(a, b);
    // 9. 난수를 얻지 못하면 실행하지 않는다(NOT-RUN, 표지·시험 디렉터리를 만들지 않음).
    let root = TempDir::new();
    let shared = root.path().join("shared");
    std::fs::create_dir(&shared).unwrap();
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();
    let markers = root.path().join("markers");
    std::fs::create_dir(&markers).unwrap();
    let mut failing =
        |_: &mut [u8]| -> std::io::Result<usize> { Err(std::io::Error::other("no entropy")) };
    let (verdict, _) = run_probe(ProbeRun {
        shared: shared.clone(),
        rounds: 2,
        layout: ProbeLayout::Swappable,
        ready: markers.join("ready"),
        stop: markers.join("stop"),
        done: markers.join("done"),
        step: &mut |_| {},
        before_examine: &mut |_, _| {},
        random: &mut failing,
        list_fault: None,
    });
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(verdict, ProbeVerdict::NotRun(_)), "{verdict:?}");
    assert!(!markers.join("ready").exists());
    assert_eq!(std::fs::read_dir(&shared).unwrap().count(), 0);
}

// ---- T010: 명령(실행 취소·글자 서식)으로 바꾼 DOCX도 같은 보존 검사로 저장한다 ----

#[cfg(target_os = "linux")]
#[test]
fn t010_굵게와_실행_취소로_바꾼_docx는_보존_검사를_통과해_저장되고_다시_열면_같다() {
    use crate::adapters::wordcraft::engine::CharFormat;
    let original = basic::basic_ko().unwrap();
    // 첫 두 글자 굵게.
    let mut doc = open_docx(&original);
    doc.edit(vec![
        DocxOp::Move {
            to: MoveTarget::Right,
            extend: true,
        },
        DocxOp::Move {
            to: MoveTarget::Right,
            extend: true,
        },
        DocxOp::Format {
            format: CharFormat::Bold,
        },
    ]);
    assert!(doc.info.dirty);
    doc.preflight().unwrap();
    let saved = doc.save().unwrap();
    assert!(saved.durable && !saved.session.dirty);
    let mut reopened = DocxModel::open(&doc.bytes()).unwrap();
    reopened.apply(&[
        DocxOp::Move {
            to: MoveTarget::Right,
            extend: true,
        },
        DocxOp::Move {
            to: MoveTarget::Right,
            extend: true,
        },
    ]);
    assert!(reopened.view().format.bold, "저장한 파일에 굵게가 남음");
    // 글자를 넣고 실행 취소: 본문이 원본과 같아져도 revision은 올랐으므로 dirty이며, 저장은 보존 검사를 거쳐 된다.
    let mut doc = open_docx(&original);
    doc.edit(vec![DocxOp::InsertText {
        text: "취소".into(),
    }]);
    doc.edit(vec![DocxOp::Undo {}]);
    assert!(doc.info.dirty);
    assert_eq!(doc.info.revision, 2);
    doc.preflight().unwrap();
    let saved = doc.save().unwrap();
    assert!(saved.durable && !saved.session.dirty);
    assert_eq!(
        DocxModel::open(&doc.bytes()).unwrap().body_text(),
        DocxModel::open(&original).unwrap().body_text()
    );
}

// ---- T009 모양 참조 무결성(T010 Phase 0 Stage B 결함 수정) ----

/// 고정 rhwp 출력과 같은 이름공간·이름·구조(`hh:charProperties` 안의 `hh:charPr`, `hh:paraProperties` 안의 `hh:paraPr`, 본문
/// `hp:run`·`hp:p`)의 header. 정의는 **내용이 있는 요소**다: 고정 rhwp는 `Event::Start`에서만 정의를 등록하고 자기 닫힘은 건너뛴다
/// (2026-10-22 2차 고침 — 처음 판의 이 상수는 자기 닫힘 정의를 써서 엔진이 등록하지 않는 정의를 양성 대조로 썼다). 글자 모양 id는
/// 12·0·7 순서(빈 번호가 있고 순서가 바뀐 정상 header — id가 이어지거나 차례일 필요는 없다), 문단 모양 id는 0.
const REF_HEADER: &str = r#"<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"><hh:refList><hh:charProperties itemCnt="3"><hh:charPr id="12" height="900"><hh:fontRef hangul="0"/></hh:charPr><hh:charPr id="0" height="1000"><hh:fontRef hangul="0"/></hh:charPr><hh:charPr id="7" height="1000"><hh:bold/></hh:charPr></hh:charProperties><hh:paraProperties itemCnt="1"><hh:paraPr id="0"><hh:align horizontal="JUSTIFY"/></hh:paraPr></hh:paraProperties></hh:refList></hh:head>"#;

/// 본문: 구역 정의 run, 글 run 둘, 표 셀 안 문단 run, 양식 글자 모양(고정 rhwp가 읽는 참조 자리 모두).
fn ref_section(
    secpr: &str,
    body: &str,
    second: &str,
    cell: &str,
    para: &str,
    form: &str,
) -> String {
    format!(
        r#"<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p id="0" paraPrIDRef="{para}" styleIDRef="0"><hp:run charPrIDRef="{secpr}"><hp:secPr/></hp:run><hp:run charPrIDRef="{body}"><hp:t>a</hp:t></hp:run><hp:run charPrIDRef="{second}"><hp:t>b</hp:t></hp:run></hp:p><hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:tbl><hp:tr><hp:tc><hp:subList><hp:p id="2" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="{cell}"><hp:t>c</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p><hp:p id="3" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:ctrl><hp:checkBtn><hp:formCharPr charPrIDRef="{form}"/></hp:checkBtn></hp:ctrl></hp:run></hp:p></hs:sec>"#
    )
}

fn ref_pkg(section: &str, header: &str) -> Vec<ZipEntry> {
    hwpx_package(section, header, true, true)
}

#[test]
fn hwpx_모양_참조는_10진_숫자이고_header에_정의된_id여야_한다() {
    let valid = ref_section("0", "7", "12", "0", "0", "0");
    assert_eq!(
        package::validate_hwpx_references(&pkg(&ref_pkg(&valid, REF_HEADER))),
        vec![],
        "있는 모양(빈 번호 뒤의 12 포함)"
    );
    let invalid = vec![Finding::at(
        FindingCode::ReferenceInvalid,
        "Contents/section0.xml",
    )];
    let bad_values = [
        "9999",
        "8",
        "1",
        "70000",
        "abc",
        "-1",
        "",
        "+7",
        " 7",
        "7 ",
        "4294967296",
    ];
    for value in bad_values {
        for (slot, section) in [
            ("글 run", ref_section("0", value, "12", "0", "0", "0")),
            ("둘째 글 run", ref_section("0", "7", value, "0", "0", "0")),
            (
                "구역 정의 run",
                ref_section(value, "7", "12", "0", "0", "0"),
            ),
            ("표 셀 run", ref_section("0", "7", "12", value, "0", "0")),
            (
                "문단 paraPrIDRef",
                ref_section("0", "7", "12", "0", value, "0"),
            ),
            (
                "양식 글자 모양",
                ref_section("0", "7", "12", "0", "0", value),
            ),
        ] {
            assert_eq!(
                package::validate_hwpx_references(&pkg(&ref_pkg(&section, REF_HEADER))),
                invalid,
                "{slot} = {value:?}"
            );
        }
    }
    // 문단 모양 이름공간은 글자 모양과 따로다: paraPr에는 7이 없다.
    assert_eq!(
        package::validate_hwpx_references(&pkg(&ref_pkg(
            &ref_section("0", "7", "12", "0", "7", "0"),
            REF_HEADER
        ))),
        invalid
    );
    // 엔진이 버리는 id(65535 초과)의 정의는 정의가 아니다.
    let big = REF_HEADER.replace(r#"<hh:charPr id="12""#, r#"<hh:charPr id="70000""#);
    assert_eq!(
        package::validate_hwpx_references(&pkg(&ref_pkg(
            &ref_section("0", "7", "70000", "0", "0", "0"),
            &big
        ))),
        invalid
    );
}

#[test]
fn hwpx_정의를_정할_수_없는_header는_unknown이고_없는_header도_막는다() {
    let section = ref_section("0", "7", "12", "0", "0", "0");
    let unsupported = vec![Finding::at(FindingCode::Unsupported, "Contents/header.xml")];
    for (label, header) in [
        (
            "id 없음",
            REF_HEADER.replace(r#"<hh:charPr id="7""#, "<hh:charPr"),
        ),
        ("id 중복", REF_HEADER.replace(r#"id="12""#, r#"id="7""#)),
        (
            "숫자 아닌 id",
            REF_HEADER.replace(r#"id="12""#, r#"id="x""#),
        ),
        (
            "문단 모양 id 없음",
            REF_HEADER.replace(r#"<hh:paraPr id="0">"#, "<hh:paraPr>"),
        ),
        // 엔진이 등록하지만 정의로 확인할 수 없는 위치·이름공간의 내용 있는 charPr(엔진 배열에 들어가 정의를 덮을 수 있다).
        (
            "목록 밖 charPr",
            REF_HEADER.replace(
                "</hh:refList>",
                r#"</hh:refList><hh:extra><hh:charPr id="40"><hh:bold/></hh:charPr></hh:extra>"#,
            ),
        ),
        (
            "다른 이름공간의 charPr",
            REF_HEADER.replace(
                "</hh:charProperties>",
                r#"<x:charPr xmlns:x="urn:other" id="41"><x:bold/></x:charPr></hh:charProperties>"#,
            ),
        ),
        (
            "같은 id의 내용 있는 charPr 둘",
            REF_HEADER.replace(
                "</hh:charProperties>",
                r#"<hh:charPr id="0" height="2000"><hh:bold/></hh:charPr></hh:charProperties>"#,
            ),
        ),
    ] {
        assert_eq!(
            package::validate_hwpx_references(&pkg(&ref_pkg(&section, &header))),
            unsupported,
            "{label}"
        );
    }
    let mut missing = ref_pkg(&section, REF_HEADER);
    missing.retain(|e| e.name != "Contents/header.xml");
    assert_eq!(
        package::validate_hwpx_references(&pkg(&missing)),
        unsupported
    );
    // 읽을 수 없는 header는 malformed_xml이 막는다(같은 까닭을 두 번 적지 않음).
    assert_eq!(
        package::validate_hwpx_references(&pkg(&ref_pkg(&section, "<hh:head>"))),
        vec![]
    );
}

#[test]
fn hwpx_자기_닫힘_모양_정의는_엔진이_등록하지_않으므로_가리킬_수_없다() {
    // 실측(고정 rhwp WASM, tests/poc/t010-phase0/selfclosing.py): 자기 닫힘 `<hh:charPr id="13" .../>`를 가리키면 엔진은 id 13을 보고하며
    // 기본 모양(크기 1000)으로 그리고, 그 문서의 내보내기는 "미등록 ID 참조"로 실패한다. 자기 닫힘 `paraPr`은 내보내기도 통과해 정의
    // 없는 참조를 쓴다.
    let header = REF_HEADER
        .replace(
            "</hh:charProperties>",
            r#"<hh:charPr id="13" height="2300"/><hh:charPr id="14" height="900"/></hh:charProperties>"#,
        )
        .replace(
            "</hh:paraProperties>",
            r#"<hh:paraPr id="22"/></hh:paraProperties>"#,
        );
    let invalid = vec![Finding::at(
        FindingCode::ReferenceInvalid,
        "Contents/section0.xml",
    )];
    let check =
        |section: String| package::validate_hwpx_references(&pkg(&ref_pkg(&section, &header)));
    assert_eq!(
        check(ref_section("0", "13", "12", "0", "0", "0")),
        invalid,
        "자기 닫힘 글자 모양"
    );
    assert_eq!(
        check(ref_section("0", "7", "12", "13", "0", "0")),
        invalid,
        "표 셀에서 자기 닫힘"
    );
    assert_eq!(
        check(ref_section("0", "7", "12", "0", "22", "0")),
        invalid,
        "자기 닫힘 문단 모양"
    );
    // 쓰지 않는 자기 닫힘 정의는 막지 않는다. 내용 있는 정의(빈 번호·순서 바뀜 포함)는 그대로 풀린다.
    assert_eq!(
        check(ref_section("0", "7", "12", "0", "0", "0")),
        vec![],
        "쓰지 않는 자기 닫힘"
    );
    // `<a></a>`(내용 없는 시작·끝 쌍)는 엔진에 `Event::Start`라 정의다.
    let explicit = REF_HEADER.replace(
        "</hh:charProperties>",
        r#"<hh:charPr id="30" height="900"></hh:charPr></hh:charProperties>"#,
    );
    assert_eq!(
        package::validate_hwpx_references(&pkg(&ref_pkg(
            &ref_section("0", "30", "12", "0", "0", "0"),
            &explicit
        ))),
        vec![]
    );
    // 정의 목록 밖에 같은 이름의 자기 닫힘 요소가 있어도(엔진이 건너뜀) 정의를 만들지 않고 막지도 않는다.
    let stray = REF_HEADER.replace(
        "</hh:refList>",
        r#"</hh:refList><hh:extra><hh:charPr id="50"/></hh:extra>"#,
    );
    assert_eq!(
        package::validate_hwpx_references(&pkg(&ref_pkg(
            &ref_section("0", "7", "12", "0", "0", "0"),
            &stray
        ))),
        vec![]
    );
    assert_eq!(
        package::validate_hwpx_references(&pkg(&ref_pkg(
            &ref_section("0", "50", "12", "0", "0", "0"),
            &stray
        ))),
        invalid
    );
}

#[test]
fn hwpx_저장_검사는_없는_모양_참조를_막고_올바른_참조는_받는다() {
    let original = zip(
        &ref_pkg(&ref_section("0", "0", "0", "0", "0", "0"), REF_HEADER),
        false,
    );
    let saved = |section: &str| {
        let output = zip(&ref_pkg(section, REF_HEADER), false);
        service::check_saved(
            Format::Hwpx,
            &original,
            &output,
            Some(&report("hwpx", json!([]))),
            true,
        )
    };
    // 있는 모양을 가리키는 본문 편집(기존 모양 재사용 서식과 같은 모양)은 safe.
    assert!(saved(&ref_section("0", "7", "12", "0", "0", "0")).is_safe());
    let rejected = saved(&ref_section("0", "9999", "0", "0", "0", "0"));
    assert_eq!(rejected.outcome, Outcome::Unsafe);
    assert_eq!(
        rejected.findings,
        vec![Finding::at(
            FindingCode::ReferenceInvalid,
            "Contents/section0.xml"
        )]
    );
}

/// 구역 스트림: 문단 머리(모양 ID `para`) + 글 + 글자 모양 열(`shapes`; None이면 레코드 없음). `level`은 중첩(표 셀 문단 등).
fn ref_paragraph(level: u16, para: u16, shapes: Option<&[u8]>) -> Vec<u8> {
    let mut header = vec![0u8; 22];
    header[8..10].copy_from_slice(&para.to_le_bytes());
    let mut out = [record(66, level, &header), record(67, level + 1, b"a\0")].concat();
    if let Some(shapes) = shapes {
        out.extend(record(68, level + 1, shapes));
    }
    out
}

fn shape_pairs(ids: &[u32]) -> Vec<u8> {
    ids.iter()
        .enumerate()
        .flat_map(|(i, id)| [(i as u32).to_le_bytes(), id.to_le_bytes()].concat())
        .collect()
}

#[test]
fn hwp_본문의_모양_id는_docinfo_정의_수보다_작아야_하고_미리보기와_따로_판정한다() {
    // DocInfo: 글자 모양 2개(ID 0·1), 문단 모양 1개(ID 0).
    let info = [docinfo(0, b"font"), record(21, 1, b"second char shape")].concat();
    let original = hwp_doc(
        0,
        &info,
        &ref_paragraph(0, 0, Some(&shape_pairs(&[0]))),
        &[],
    );
    let saved = |body: &[u8]| hwp::compare_saved(&original, &hwp_doc(0, &info, body, &[]));
    let ok_body = [
        ref_paragraph(0, 0, Some(&shape_pairs(&[0, 1]))),
        ref_paragraph(2, 0, Some(&shape_pairs(&[1]))),
        ref_paragraph(0, 0, None),
    ]
    .concat();
    assert_eq!(
        saved(&ok_body),
        vec![],
        "있는 모양·중첩 문단·글자 모양 열 없음"
    );
    let invalid = vec![Finding::at(
        FindingCode::ReferenceInvalid,
        "BodyText/Section0",
    )];
    let bad_shapes: [(&str, Vec<u8>); 6] = [
        ("없는 글자 모양 9999", shape_pairs(&[0, 9999])),
        ("정의 수와 같은 ID", shape_pairs(&[2])),
        ("u32 최댓값", shape_pairs(&[u32::MAX])),
        ("빈 열", Vec::new()),
        (
            "8의 배수가 아님",
            [shape_pairs(&[0]), vec![0, 0, 0, 0]].concat(),
        ),
        ("한 쌍보다 짧음", vec![0, 0, 0, 0]),
    ];
    for (label, shapes) in &bad_shapes {
        let body = [
            ref_paragraph(0, 0, Some(&shape_pairs(&[0]))),
            ref_paragraph(0, 0, Some(shapes)),
        ]
        .concat();
        assert_eq!(saved(&body), invalid, "{label}");
        // 표 셀 등 중첩 문단도 같은 스트림의 레코드다.
        let nested = [
            ref_paragraph(0, 0, Some(&shape_pairs(&[0]))),
            ref_paragraph(2, 0, Some(shapes)),
        ]
        .concat();
        assert_eq!(saved(&nested), invalid, "중첩 {label}");
    }
    assert_eq!(
        saved(&ref_paragraph(0, 1, Some(&shape_pairs(&[0])))),
        invalid,
        "없는 문단 모양"
    );
    assert_eq!(
        saved(&[record(66, 0, &[0; 9]), record(67, 1, b"a\0")].concat()),
        invalid,
        "문단 모양 ID 자리가 없는 문단 머리"
    );
    // 미리보기가 원본 그대로여도 참조 근거는 따로 나온다(previewStale에 기대지 않음).
    let preview: [(&str, &[u8]); 1] = [("/PrvText", b"t\0e\0x\0t\0")];
    let original_with_preview = hwp_doc(
        0,
        &info,
        &ref_paragraph(0, 0, Some(&shape_pairs(&[0]))),
        &preview,
    );
    let both = hwp::compare_saved(
        &original_with_preview,
        &hwp_doc(
            0,
            &info,
            &ref_paragraph(0, 0, Some(&shape_pairs(&[9999]))),
            &preview,
        ),
    );
    assert_eq!(
        both,
        vec![
            Finding::at(FindingCode::PreviewStale, "PrvText"),
            Finding::at(FindingCode::ReferenceInvalid, "BodyText/Section0"),
        ]
    );
    // 사전 검사(편집 없는 왕복)는 바이트 같음만 본다: 참조 검사는 편집한 저장에만.
    assert_eq!(hwp::compare(&original, &original), vec![]);
}

#[test]
fn 실제_저장_서비스는_없는_모양_참조의_hwpx를_게시하지_않고_원본을_지킨다() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let original = zip(
        &ref_pkg(&ref_section("0", "0", "0", "0", "0", "0"), REF_HEADER),
        false,
    );
    let info = rhwp_session(&state, &dir, "a.hwpx", &original);
    let registry = state.registry();
    let (id, generation) = (info.session_id, info.load_generation);
    let source = registry.preflight_source(id, generation).unwrap();
    let read = service::read_original(&source, &Limits::default()).unwrap();
    let check = service::preflight(
        Format::Hwpx,
        &read,
        &original,
        Some(&report("hwpx", json!([]))),
    );
    assert!(check.is_safe(), "{check:?}");
    registry
        .record_preflight(id, generation, source.content_hash, check)
        .unwrap();
    registry.commit(id, generation, 0, 1).unwrap();
    let dangling = zip(
        &ref_pkg(&ref_section("0", "0", "0", "9999", "0", "0"), REF_HEADER),
        false,
    );
    let ticket = registry.begin_save(id, generation, 1).unwrap();
    let error = service::save(
        registry,
        &ticket,
        &Limits::default(),
        &dangling,
        Some(&report("hwpx", json!([]))),
        true,
    )
    .unwrap_err();
    drop(ticket);
    assert!(
        matches!(&error, DocumentError::UnsafeSave { preservation }
            if preservation.findings == vec![Finding::at(FindingCode::ReferenceInvalid, "Contents/section0.xml")]),
        "{error:?}"
    );
    assert_eq!(std::fs::read(dir.path().join("a.hwpx")).unwrap(), original);
    let names: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names.len(), 1, "임시 파일이 남지 않는다: {names:?}");
    assert!(registry.get(id).unwrap().dirty);
    // 올바른 참조로 고친 출력은 같은 세션에서 저장된다.
    let valid = zip(
        &ref_pkg(&ref_section("0", "7", "12", "0", "0", "0"), REF_HEADER),
        false,
    );
    let ticket = registry.begin_save(id, generation, 1).unwrap();
    let saved = service::save(
        registry,
        &ticket,
        &Limits::default(),
        &valid,
        Some(&report("hwpx", json!([]))),
        true,
    )
    .unwrap();
    assert!(!saved.session.dirty);
    assert_eq!(std::fs::read(dir.path().join("a.hwpx")).unwrap(), valid);
}

// ---- T010 Phase 3B: HWPX 글자 서식의 좁은 header 규칙 ----

/// 고정 rhwp HWPX header와 같은 모양의 글자 모양 정의 목록(id 0..n). `extra`는 목록 끝에 덧붙일 정의, `count`는 `itemCnt`.
fn fmt_header(count: usize, defs: &[&str], extra: &[&str], para: &str) -> String {
    format!(
        r#"<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"><hh:refList><hh:charProperties itemCnt="{count}">{}{}</hh:charProperties><hh:paraProperties itemCnt="1"><hh:paraPr id="0"><hh:align horizontal="{para}"/></hh:paraPr></hh:paraProperties></hh:refList></hh:head>"#,
        defs.concat(),
        extra.concat()
    )
}

/// 엔진이 쓰는 순서의 정의 하나(fontRef → 서식 자식 → 그림자). `format`은 서식 자식 자리.
fn fmt_def(id: u32, height: u32, format: &str) -> String {
    format!(
        r##"<hh:charPr id="{id}" height="{height}" textColor="#000000"><hh:fontRef hangul="1" latin="1"/>{format}<hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:shadow type="NONE" color="#B2B2B2"/></hh:charPr>"##
    )
}

/// 정의 셋(0 보통, 1 큰 글자, 2 굵게)의 원본 header.
fn fmt_original() -> (Vec<String>, String) {
    let defs = vec![
        fmt_def(0, 1000, ""),
        fmt_def(1, 1600, ""),
        fmt_def(2, 1000, "<hh:bold/>"),
    ];
    let refs: Vec<&str> = defs.iter().map(String::as_str).collect();
    let header = fmt_header(3, &refs, &[], "JUSTIFY");
    (defs, header)
}

fn fmt_body(refs: &[u32]) -> String {
    let runs: String = refs
        .iter()
        .map(|id| format!(r#"<hp:run charPrIDRef="{id}"><hp:t>a</hp:t></hp:run>"#))
        .collect();
    format!(
        r#"<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p id="0" paraPrIDRef="0" styleIDRef="0">{runs}</hp:p></hs:sec>"#
    )
}

/// 엔진 기울임 출력 모양: 정의 0을 복제해 `hh:italic`을 더한 id 3.
fn italic_of_zero() -> String {
    fmt_def(3, 1000, "<hh:italic/>")
}

fn fmt_check(header: &str, body: &str) -> Vec<Finding> {
    let (_, original) = fmt_original();
    let before = pkg(&hwpx_package(&fmt_body(&[0, 1]), &original, true, true));
    let after = pkg(&hwpx_package(body, header, true, true));
    let mut findings = package::compare_saved_hwpx(&before, &after);
    findings.extend(package::validate_hwpx_references(&after));
    findings
}

#[test]
fn hwpx_header는_서식이_덧붙인_참조되는_글자_모양만_다를_수_있다() {
    let (defs, original) = fmt_original();
    let d: Vec<&str> = defs.iter().map(String::as_str).collect();
    // 바뀌지 않은 header(대조).
    assert_eq!(fmt_check(&original, &fmt_body(&[0, 1])), vec![]);
    // 덧붙임 하나: 기울임(엔진 실측 모양).
    let italic = italic_of_zero();
    assert_eq!(
        fmt_check(
            &fmt_header(4, &d, &[&italic], "JUSTIFY"),
            &fmt_body(&[3, 1])
        ),
        vec![]
    );
    // 서식 자식을 바꾸거나 빼서 만든 덧붙임 둘(밑줄 모양 바꿈, 굵게 정의에서 굵게 뺌 + 취소선).
    let underline = fmt_def(3, 1600, "").replace(
        r#"<hh:underline type="NONE""#,
        r#"<hh:underline type="BOTTOM""#,
    );
    let unbold_strike = fmt_def(4, 1000, "").replace(
        r#"<hh:strikeout shape="NONE""#,
        r#"<hh:strikeout shape="SOLID""#,
    );
    assert_eq!(
        fmt_check(
            &fmt_header(5, &d, &[&underline, &unbold_strike], "JUSTIFY"),
            &fmt_body(&[3, 4, 0])
        ),
        vec![]
    );
    // 접두사·속성 순서만 다른 header는 지금처럼 같다.
    let prefixed = original
        .replace("hh:", "x:")
        .replace("xmlns:hh=", "xmlns:x=");
    assert_eq!(fmt_check(&prefixed, &fmt_body(&[0])), vec![]);
}

#[test]
fn hwpx_header의_서식_덧붙임_밖_변경은_계속_partchanged다() {
    let (defs, _) = fmt_original();
    let d: Vec<&str> = defs.iter().map(String::as_str).collect();
    let italic = italic_of_zero();
    let changed = vec![Finding::at(FindingCode::PartChanged, "Contents/header.xml")];
    let cases: Vec<(&str, String, String)> = vec![
        (
            "쓰이지 않는 덧붙임",
            fmt_header(4, &d, &[&italic], "JUSTIFY"),
            fmt_body(&[0, 1]),
        ),
        (
            "itemCnt 그대로",
            fmt_header(3, &d, &[&italic], "JUSTIFY"),
            fmt_body(&[3]),
        ),
        (
            "itemCnt +2",
            fmt_header(5, &d, &[&italic], "JUSTIFY"),
            fmt_body(&[3]),
        ),
        (
            "id가 n이 아님",
            fmt_header(4, &d, &[&fmt_def(4, 1000, "<hh:italic/>")], "JUSTIFY"),
            fmt_body(&[4]),
        ),
        (
            "서식 밖 속성(height) 다름",
            fmt_header(4, &d, &[&fmt_def(3, 1200, "")], "JUSTIFY"),
            fmt_body(&[3]),
        ),
        (
            "서식 밖 자식 값 다름",
            fmt_header(
                4,
                &d,
                &[&italic.replace(r#"latin="1""#, r#"latin="2""#)],
                "JUSTIFY",
            ),
            fmt_body(&[3]),
        ),
        (
            "서식 밖 자식 더함",
            fmt_header(
                4,
                &d,
                &[&italic.replace("<hh:italic/>", "<hh:italic/><hh:outline type=\"SOLID\"/>")],
                "JUSTIFY",
            ),
            fmt_body(&[3]),
        ),
        (
            "서식 자식에 내용",
            fmt_header(
                4,
                &d,
                &[&fmt_def(3, 1000, "<hh:italic>x</hh:italic>")],
                "JUSTIFY",
            ),
            fmt_body(&[3]),
        ),
        (
            "서식 자식의 모르는 속성",
            fmt_header(
                4,
                &d,
                &[&fmt_def(3, 1000, r#"<hh:italic x="1"/>"#)],
                "JUSTIFY",
            ),
            fmt_body(&[3]),
        ),
        (
            "서식 자식 값에 다른 글자",
            fmt_header(
                4,
                &d,
                &[&fmt_def(3, 1000, "").replace(
                    r##"<hh:underline type="NONE" shape="SOLID" color="#000000"/>"##,
                    r##"<hh:underline type="NONE" shape="SOLID" color="#00 00;0"/>"##,
                )],
                "JUSTIFY",
            ),
            fmt_body(&[3]),
        ),
        (
            "같은 서식 자식 둘",
            fmt_header(
                4,
                &d,
                &[&fmt_def(3, 1000, "<hh:italic/><hh:italic/>")],
                "JUSTIFY",
            ),
            fmt_body(&[3]),
        ),
        (
            "다른 header 부분도 바뀜",
            fmt_header(4, &d, &[&italic], "LEFT"),
            fmt_body(&[3]),
        ),
        (
            "기존 정의도 바뀜",
            fmt_header(
                4,
                &[d[0], d[1], &fmt_def(2, 1000, "")],
                &[&italic],
                "JUSTIFY",
            ),
            fmt_body(&[3]),
        ),
        (
            "가운데 끼움",
            fmt_header(4, &[d[0], &italic, d[1], d[2]], &[], "JUSTIFY"),
            fmt_body(&[3]),
        ),
        (
            "덧붙임 사이 글",
            fmt_header(
                5,
                &d,
                &[&italic, " ", &fmt_def(4, 1600, "<hh:italic/>")],
                "JUSTIFY",
            ),
            fmt_body(&[3, 4]),
        ),
        (
            "글자 모양이 아닌 덧붙임",
            fmt_header(
                4,
                &d,
                &[r#"<hh:paraPr id="3"><hh:align horizontal="LEFT"/></hh:paraPr>"#],
                "JUSTIFY",
            ),
            fmt_body(&[0]),
        ),
        (
            "다른 이름공간의 덧붙임",
            fmt_header(
                4,
                &d,
                &[&italic
                    .replace("<hh:charPr ", r#"<o:charPr xmlns:o="urn:o" "#)
                    .replace("</hh:charPr>", "</o:charPr>")],
                "JUSTIFY",
            ),
            fmt_body(&[0]),
        ),
    ];
    for (label, header, body) in &cases {
        let findings = fmt_check(header, body);
        assert!(findings.contains(&changed[0]), "{label}: {findings:?}");
    }
    // 원본 정의 id가 0..n이 아니면(빈 번호) 덧붙임 규칙을 쓰지 않는다.
    let gap = [fmt_def(0, 1000, ""), fmt_def(2, 1000, "")];
    let gap: Vec<&str> = gap.iter().map(String::as_str).collect();
    let before = pkg(&hwpx_package(
        &fmt_body(&[0]),
        &fmt_header(2, &gap, &[], "JUSTIFY"),
        true,
        true,
    ));
    let after = pkg(&hwpx_package(
        &fmt_body(&[3]),
        &fmt_header(3, &gap, &[&fmt_def(3, 1000, "<hh:italic/>")], "JUSTIFY"),
        true,
        true,
    ));
    assert_eq!(package::compare_saved_hwpx(&before, &after), changed);
    // 목록이 둘이면 받지 않는다.
    let (_, original) = fmt_original();
    let twice = original.replace(
        "<hh:paraProperties",
        r#"<hh:charProperties itemCnt="0"></hh:charProperties><hh:paraProperties"#,
    );
    let before = pkg(&hwpx_package(&fmt_body(&[0]), &twice, true, true));
    let after = pkg(&hwpx_package(
        &fmt_body(&[3]),
        &twice
            .replacen(r#"itemCnt="3">"#, r#"itemCnt="4">"#, 1)
            .replacen(
                "</hh:charProperties>",
                &format!("{italic}</hh:charProperties>"),
                1,
            ),
        true,
        true,
    ));
    assert_eq!(package::compare_saved_hwpx(&before, &after), changed);
    // 읽을 수 없는 출력 header는 지금처럼 outputMalformed.
    let (_, original) = fmt_original();
    let before = pkg(&hwpx_package(&fmt_body(&[0]), &original, true, true));
    let after = pkg(&hwpx_package(&fmt_body(&[0]), "<hh:head", true, true));
    assert_eq!(
        package::compare_saved_hwpx(&before, &after),
        vec![Finding::at(
            FindingCode::OutputMalformed,
            "Contents/header.xml"
        )]
    );
}

#[test]
fn hwpx_덧붙인_정의가_자기_닫힘이면_참조_무결성이_막는다() {
    let (defs, _) = fmt_original();
    let d: Vec<&str> = defs.iter().map(String::as_str).collect();
    // 정규화한 사건 열로는 `<a/>`와 `<a></a>`가 같아 덧붙임 규칙은 통과하지만, 엔진이 등록하지 않는 정의라 참조가 막힌다.
    let empty = r##"<hh:charPr id="3" height="1000" textColor="#000000"/>"##;
    let base = r##"<hh:charPr id="0" height="1000" textColor="#000000"></hh:charPr>"##;
    let header = fmt_header(2, &[base, d[1]], &[empty], "JUSTIFY")
        .replace(r#"itemCnt="2""#, r#"itemCnt="3""#)
        .replace(r#"id="3""#, r#"id="2""#);
    let original = fmt_header(2, &[base, d[1]], &[], "JUSTIFY");
    let before = pkg(&hwpx_package(&fmt_body(&[0]), &original, true, true));
    let after = pkg(&hwpx_package(&fmt_body(&[2]), &header, true, true));
    assert_eq!(package::compare_saved_hwpx(&before, &after), vec![]);
    assert_eq!(
        package::validate_hwpx_references(&after),
        vec![Finding::at(
            FindingCode::ReferenceInvalid,
            "Contents/section0.xml"
        )]
    );
}

#[test]
fn 실제_저장_서비스는_서식_덧붙임_hwpx를_게시하고_다른_header_변경은_원본을_지킨다() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let (defs, header) = fmt_original();
    let d: Vec<&str> = defs.iter().map(String::as_str).collect();
    let original = zip(
        &hwpx_package(&fmt_body(&[0, 1]), &header, true, true),
        false,
    );
    let info = rhwp_session(&state, &dir, "a.hwpx", &original);
    let registry = state.registry();
    let (id, generation) = (info.session_id, info.load_generation);
    let source = registry.preflight_source(id, generation).unwrap();
    let read = service::read_original(&source, &Limits::default()).unwrap();
    let check = service::preflight(
        Format::Hwpx,
        &read,
        &original,
        Some(&report("hwpx", json!([]))),
    );
    assert!(check.is_safe(), "{check:?}");
    registry
        .record_preflight(id, generation, source.content_hash, check)
        .unwrap();
    registry.commit(id, generation, 0, 1).unwrap();
    // 서식 덧붙임 + 다른 header 변경: 거부, 원본·디렉터리 그대로.
    let italic = italic_of_zero();
    let mixed = zip(
        &hwpx_package(
            &fmt_body(&[3, 1]),
            &fmt_header(4, &d, &[&italic], "LEFT"),
            true,
            true,
        ),
        false,
    );
    let ticket = registry.begin_save(id, generation, 1).unwrap();
    let error = service::save(
        registry,
        &ticket,
        &Limits::default(),
        &mixed,
        Some(&report("hwpx", json!([]))),
        true,
    )
    .unwrap_err();
    drop(ticket);
    assert!(
        matches!(&error, DocumentError::UnsafeSave { preservation }
            if preservation.findings == vec![Finding::at(FindingCode::PartChanged, "Contents/header.xml")]),
        "{error:?}"
    );
    assert_eq!(std::fs::read(dir.path().join("a.hwpx")).unwrap(), original);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    assert!(registry.get(id).unwrap().dirty);
    // 서식 덧붙임만: 게시.
    let formatted = zip(
        &hwpx_package(
            &fmt_body(&[3, 1]),
            &fmt_header(4, &d, &[&italic], "JUSTIFY"),
            true,
            true,
        ),
        false,
    );
    let ticket = registry.begin_save(id, generation, 1).unwrap();
    let saved = service::save(
        registry,
        &ticket,
        &Limits::default(),
        &formatted,
        Some(&report("hwpx", json!([]))),
        true,
    )
    .unwrap();
    assert!(!saved.session.dirty);
    assert_eq!(std::fs::read(dir.path().join("a.hwpx")).unwrap(), formatted);
}

// ---- T010 교정 B: 덧붙인 글자 모양의 "쓰임"은 엔진이 글자 모양으로 읽는 참조만 ----

const HP_SECTION_OPEN: &str = r#"<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">"#;

/// 본문 `hp:p` 하나에 임의 내용을 둔 구역.
fn sec_with(inner: &str) -> String {
    format!(
        r#"{HP_SECTION_OPEN}<hp:p id="0" paraPrIDRef="0" styleIDRef="0">{inner}</hp:p></hs:sec>"#
    )
}

fn appended_italic_header() -> String {
    let (defs, _) = fmt_original();
    let d: Vec<&str> = defs.iter().map(String::as_str).collect();
    fmt_header(4, &d, &[&italic_of_zero()], "JUSTIFY")
}

fn header_changed() -> Finding {
    Finding::at(FindingCode::PartChanged, "Contents/header.xml")
}

#[test]
fn 덧붙인_글자_모양은_가짜_charpridref로_쓰임을_증명할_수_없다() {
    let header = appended_italic_header();
    let run0 = r#"<hp:run charPrIDRef="0"><hp:t>a</hp:t></hp:run>"#;
    let cases: Vec<(&str, String, Vec<Finding>)> = vec![
        (
            "본문 hp 이름공간의 다른 요소",
            sec_with(&format!(r#"{run0}<hp:fake charPrIDRef="3"/>"#)),
            vec![header_changed()],
        ),
        (
            "구역 뿌리 요소의 속성",
            format!(
                r#"<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" charPrIDRef="3"><hp:p id="0" paraPrIDRef="0" styleIDRef="0">{run0}</hp:p></hs:sec>"#
            ),
            vec![header_changed()],
        ),
        (
            "다른 이름공간의 run",
            sec_with(&format!(
                r#"{run0}<o:run xmlns:o="urn:other" charPrIDRef="3"><hp:t>b</hp:t></o:run>"#
            )),
            vec![header_changed()],
        ),
        (
            "hp:p 밖의 hp:run(구역 바로 아래)",
            format!(
                r#"{HP_SECTION_OPEN}<hp:run charPrIDRef="3"/><hp:p id="0" paraPrIDRef="0" styleIDRef="0">{run0}</hp:p></hs:sec>"#
            ),
            vec![header_changed()],
        ),
        (
            "이름공간이 있는 같은 지역 이름 속성",
            sec_with(
                r#"<hp:run xmlns:x="urn:x" x:charPrIDRef="3" charPrIDRef="0"><hp:t>a</hp:t></hp:run>"#,
            ),
            vec![header_changed()],
        ),
        (
            "주석·글 안의 참조 모양 문자열",
            sec_with(&format!(
                r#"{run0}<!-- charPrIDRef="3" --><hp:run charPrIDRef="0"><hp:t>charPrIDRef="3"</hp:t></hp:run>"#
            )),
            vec![header_changed()],
        ),
        ("쓰이지 않는 덧붙임", sec_with(run0), vec![header_changed()]),
        (
            "숫자가 아닌 참조(엔진은 0으로 읽음)",
            sec_with(r#"<hp:run charPrIDRef="3x"><hp:t>a</hp:t></hp:run>"#),
            vec![
                header_changed(),
                Finding::at(FindingCode::ReferenceInvalid, "Contents/section0.xml"),
            ],
        ),
        (
            "쓰였지만 없는 정의도 가리킴",
            sec_with(
                r#"<hp:run charPrIDRef="3"><hp:t>a</hp:t></hp:run><hp:run charPrIDRef="4"><hp:t>b</hp:t></hp:run>"#,
            ),
            vec![Finding::at(
                FindingCode::ReferenceInvalid,
                "Contents/section0.xml",
            )],
        ),
    ];
    for (label, body, expected) in &cases {
        assert_eq!(&fmt_check(&header, body), expected, "{label}");
    }
    // 덧붙인 id 중복: 덧붙임 규칙과 정의를 정할 수 없음이 함께.
    let (defs, _) = fmt_original();
    let d: Vec<&str> = defs.iter().map(String::as_str).collect();
    let italic = italic_of_zero();
    let duplicate = fmt_header(5, &d, &[&italic, &italic], "JUSTIFY");
    assert_eq!(
        fmt_check(
            &duplicate,
            &sec_with(r#"<hp:run charPrIDRef="3"><hp:t>a</hp:t></hp:run>"#)
        ),
        vec![
            header_changed(),
            Finding::at(FindingCode::Unsupported, "Contents/header.xml")
        ]
    );
}

#[test]
fn 덧붙인_글자_모양은_엔진이_읽는_본문_참조로_쓰인다() {
    let header = appended_italic_header();
    let ok_cases: Vec<(&str, String)> = vec![
        (
            "본문 run",
            sec_with(r#"<hp:run charPrIDRef="3"><hp:t>a</hp:t></hp:run>"#),
        ),
        (
            "내용 없는 run(엔진이 빈 문단 모양으로 읽음)",
            sec_with(r#"<hp:run charPrIDRef="3"/>"#),
        ),
        (
            "표 셀 안 문단의 run",
            sec_with(
                r#"<hp:run charPrIDRef="0"><hp:tbl><hp:tr><hp:tc><hp:subList><hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="3"><hp:t>c</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run>"#,
            ),
        ),
        // (2026-10-26 교정: 이전 판의 `hp:run/hp:ctrl/hp:checkBtn/hp:formCharPr` 양성 사례는 고정 rhwp `parse_ctrl`이 모르는 자식을
        // `skip_element`로 건너뛰어 엔진이 읽지 않는 자리였다 — 음성으로 옮김, `formcharpr는_엔진이_읽는_양식_자리만_쓰임이다`.)
        (
            "양식 개체(hp:run 바로 아래)의 formCharPr",
            sec_with(
                r#"<hp:run charPrIDRef="0"><hp:checkBtn><hp:formCharPr charPrIDRef="3"/></hp:checkBtn></hp:run>"#,
            ),
        ),
    ];
    for (label, body) in &ok_cases {
        assert_eq!(fmt_check(&header, body), vec![], "{label}");
    }
    // 여러 구역: 덧붙인 둘을 서로 다른 구역에서 쓴다.
    let (defs, original) = fmt_original();
    let d: Vec<&str> = defs.iter().map(String::as_str).collect();
    let two = fmt_header(
        5,
        &d,
        &[&italic_of_zero(), &fmt_def(4, 1600, "<hh:italic/>")],
        "JUSTIFY",
    );
    let package_with = |header: &str, s0: &str, s1: &str| {
        let mut entries = hwpx_package(s0, header, true, true);
        entries.push(entry("Contents/section1.xml", s1.as_bytes()));
        pkg(&entries)
    };
    let before = package_with(&original, &fmt_body(&[0]), &fmt_body(&[1]));
    let after = package_with(&two, &fmt_body(&[3]), &fmt_body(&[4]));
    assert_eq!(package::compare_saved_hwpx(&before, &after), vec![]);
    assert_eq!(package::validate_hwpx_references(&after), vec![]);
    let half = package_with(&two, &fmt_body(&[3]), &fmt_body(&[1]));
    assert_eq!(
        package::compare_saved_hwpx(&before, &half),
        vec![header_changed()]
    );
}

// ---- T010 교정 C1: 덧붙인 정의의 서식 자식 값은 고정 rhwp 직렬화기가 쓰는 값만 ----

#[test]
fn 덧붙인_서식_자식은_고정_rhwp가_쓰는_속성_집합과_값만_받는다() {
    let (defs, _) = fmt_original();
    let d: Vec<&str> = defs.iter().map(String::as_str).collect();
    let body = fmt_body(&[3]);
    let with = |format: &str, underline: &str, strike: &str| {
        let def = fmt_def(3, 1000, format)
            .replace(
                r##"<hh:underline type="NONE" shape="SOLID" color="#000000"/>"##,
                underline,
            )
            .replace(r##"<hh:strikeout shape="NONE" color="#000000"/>"##, strike);
        fmt_header(4, &d, &[&def], "JUSTIFY")
    };
    let u = |attrs: &str| format!("<hh:underline {attrs}/>");
    let s = |attrs: &str| format!("<hh:strikeout {attrs}/>");
    let un = u(r##"type="NONE" shape="SOLID" color="#000000""##);
    let sn = s(r##"shape="NONE" color="#000000""##);
    let accepted = [
        (
            "밑줄 BOTTOM·물결·RGB",
            "",
            u(r##"type="BOTTOM" shape="WAVE" color="#1A2B3C""##),
            sn.clone(),
        ),
        (
            "밑줄 TOP·이중 물결·ARGB",
            "",
            u(r##"type="TOP" shape="DOUBLE_WAVE" color="#801A2B3C""##),
            sn.clone(),
        ),
        (
            "밑줄 색 none",
            "<hh:italic/>",
            u(r#"type="BOTTOM" shape="SOLID" color="none""#),
            sn.clone(),
        ),
        (
            "취소선 SLIM_THICK_SLIM",
            "",
            un.clone(),
            s(r##"shape="SLIM_THICK_SLIM" color="#FF0000""##),
        ),
        (
            "굵게+기울임",
            "<hh:italic/><hh:bold/>",
            un.clone(),
            sn.clone(),
        ),
    ];
    for (label, format, underline, strike) in &accepted {
        assert_eq!(
            fmt_check(&with(format, underline, strike), &body),
            vec![],
            "{label}"
        );
    }
    let rejected = [
        (
            "모르는 밑줄 위치",
            "",
            u(r##"type="CENTER" shape="SOLID" color="#000000""##),
            sn.clone(),
        ),
        (
            "소문자 열거 값",
            "",
            u(r##"type="bottom" shape="SOLID" color="#000000""##),
            sn.clone(),
        ),
        (
            "모르는 선 모양",
            "",
            u(r##"type="BOTTOM" shape="ZIGZAG" color="#000000""##),
            sn.clone(),
        ),
        (
            "취소선 3D(엔진이 무시하는 자리표시)",
            "",
            un.clone(),
            s(r##"shape="3D" color="#000000""##),
        ),
        (
            "밑줄 속성 빠짐",
            "",
            u(r#"type="BOTTOM" shape="SOLID""#),
            sn.clone(),
        ),
        ("취소선 속성 빠짐", "", un.clone(), s(r#"shape="SOLID""#)),
        (
            "밑줄 속성 더함",
            "",
            u(r##"type="BOTTOM" shape="SOLID" color="#000000" extra="1""##),
            sn.clone(),
        ),
        (
            "소문자 색",
            "",
            u(r##"type="BOTTOM" shape="SOLID" color="#00ff00""##),
            sn.clone(),
        ),
        (
            "짧은 색",
            "",
            u(r##"type="BOTTOM" shape="SOLID" color="#FFF""##),
            sn.clone(),
        ),
        (
            "# 없는 색",
            "",
            u(r#"type="BOTTOM" shape="SOLID" color="000000""#),
            sn.clone(),
        ),
        (
            "7자리 색",
            "",
            u(r##"type="BOTTOM" shape="SOLID" color="#0000000""##),
            sn.clone(),
        ),
        (
            "굵게 속성",
            r#"<hh:bold value="1"/>"#,
            un.clone(),
            sn.clone(),
        ),
        (
            "기울임 내용",
            "<hh:italic>1</hh:italic>",
            un.clone(),
            sn.clone(),
        ),
        (
            "이름공간 붙은 속성",
            "",
            u(r##"xmlns:x="urn:x" x:type="BOTTOM" type="BOTTOM" shape="SOLID" color="#000000""##),
            sn.clone(),
        ),
    ];
    for (label, format, underline, strike) in &rejected {
        assert_eq!(
            fmt_check(&with(format, underline, strike), &body),
            vec![header_changed()],
            "{label}"
        );
    }
}

#[test]
fn 원본_정의의_예전_서식_값은_덧붙임_규칙을_막지_않는다() {
    // 원본(편집하지 않은 정의)은 덧붙임 정책보다 느슨한 값을 가질 수 있다(소문자 색 등): 소급해서 거부하지 않는다.
    let legacy = fmt_def(0, 1000, "").replace(
        r##"<hh:underline type="NONE" shape="SOLID" color="#000000"/>"##,
        r##"<hh:underline type="NONE" shape="SOLID" color="#00ff00"/>"##,
    );
    let other = fmt_def(1, 1600, "");
    let original = fmt_header(2, &[&legacy, &other], &[], "JUSTIFY");
    let appended = fmt_def(2, 1600, "<hh:italic/>");
    let after_header = fmt_header(3, &[&legacy, &other], &[&appended], "JUSTIFY");
    let before = pkg(&hwpx_package(&fmt_body(&[0]), &original, true, true));
    let after = pkg(&hwpx_package(&fmt_body(&[2]), &after_header, true, true));
    assert_eq!(package::compare_saved_hwpx(&before, &after), vec![]);
    // 원본 0에서 만든 덧붙임은 원본 색(소문자)을 그대로 가질 수 없다: 덧붙임 정책은 엄격하다.
    let from_legacy = legacy
        .replace(r#"id="0""#, r#"id="2""#)
        .replace("<hh:underline", "<hh:italic/><hh:underline");
    let after_header = fmt_header(3, &[&legacy, &other], &[&from_legacy], "JUSTIFY");
    let after = pkg(&hwpx_package(&fmt_body(&[2]), &after_header, true, true));
    assert_eq!(
        package::compare_saved_hwpx(&before, &after),
        vec![header_changed()]
    );
}

// ---- T010 교정 C2: 큰 정의 집합의 비용(측정, 명시 실행) ----

/// n개 원본 정의(높이로 서로 다름)와 k개 덧붙임(가장 뒤 원본부터 기울임을 더함 — 선형 검색의 나쁜 경우).
fn large_header_pair(n: u32, k: u32) -> (Vec<u8>, Vec<u8>) {
    let originals: Vec<String> = (0..n).map(|i| fmt_def(i, 1000 + i, "")).collect();
    let appended: Vec<String> = (0..k)
        .map(|j| fmt_def(n + j, 1000 + (n - 1 - (j % n)), "<hh:italic/>"))
        .collect();
    let o: Vec<&str> = originals.iter().map(String::as_str).collect();
    let a: Vec<&str> = appended.iter().map(String::as_str).collect();
    let refs: Vec<u32> = (n..n + k).collect();
    let before = zip(
        &hwpx_package(
            &fmt_body(&[0]),
            &fmt_header(n as usize, &o, &[], "JUSTIFY"),
            true,
            true,
        ),
        false,
    );
    let after = zip(
        &hwpx_package(
            &fmt_body(&refs),
            &fmt_header((n + k) as usize, &o, &a, "JUSTIFY"),
            true,
            true,
        ),
        false,
    );
    (before, after)
}

#[test]
#[ignore = "측정: cargo test --lib -- --ignored --nocapture hwpx_큰_정의_집합_측정"]
fn hwpx_큰_정의_집합_측정() {
    for (n, k) in [
        (100u32, 10u32),
        (1_000, 100),
        (2_000, 2_000),
        (5_000, 1_000),
        (10_000, 5_000),
        (30_000, 10_000),
        (60_000, 5_535),
    ] {
        let (before, after) = large_header_pair(n, k);
        let (b, a) = (
            package::open(&before, package::Side::Original).unwrap(),
            package::open(&after, package::Side::Output).unwrap(),
        );
        let header_bytes = a.get("Contents/header.xml").unwrap().len();
        let started = std::time::Instant::now();
        let findings = package::compare_saved_hwpx(&b, &a);
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        println!(
            "{}",
            json!({"original": n, "appended": k, "headerBytes": header_bytes, "zipBytes": after.len(), "compareMs": (ms * 10.0).round() / 10.0, "accepted": findings.is_empty()})
        );
        assert!(findings.is_empty(), "{n}/{k}: {findings:?}");
    }
}

// ---- T010 교정 C3: 경계·자원 ----

#[test]
fn hwpx_덧붙임_규칙의_경계는_패닉_없이_막는다() {
    let changed = vec![header_changed()];
    let check = |original: &str, header: &str, body: &str| {
        let before = pkg(&hwpx_package(&fmt_body(&[0]), original, true, true));
        let after = pkg(&hwpx_package(body, header, true, true));
        package::compare_saved_hwpx(&before, &after)
    };
    // 원본 정의가 없으면 덧붙임의 바탕이 없다.
    let empty = fmt_header(0, &[], &[], "JUSTIFY");
    let from_nothing = fmt_header(1, &[], &[&fmt_def(0, 1000, "<hh:italic/>")], "JUSTIFY");
    assert_eq!(
        check(&empty, &from_nothing, &fmt_body(&[0])),
        changed,
        "빈 원본"
    );
    // itemCnt가 u32 밖이거나 실제 수와 다름, 더하기 넘침.
    let (defs, original) = fmt_original();
    let d: Vec<&str> = defs.iter().map(String::as_str).collect();
    let italic = italic_of_zero();
    let ok_header = fmt_header(4, &d, &[&italic], "JUSTIFY");
    for (label, header) in [
        (
            "u32 밖 itemCnt",
            ok_header.replace(r#"itemCnt="4">"#, r#"itemCnt="99999999999">"#),
        ),
        (
            "u32 최댓값 itemCnt",
            ok_header.replace(r#"itemCnt="4">"#, r#"itemCnt="4294967295">"#),
        ),
        (
            "부호 있는 itemCnt",
            ok_header.replace(r#"itemCnt="4">"#, r#"itemCnt="+4">"#),
        ),
    ] {
        assert_eq!(
            check(&original, &header, &fmt_body(&[3])),
            changed,
            "{label}"
        );
    }
    let wrapped = original.replace(r#"itemCnt="3">"#, r#"itemCnt="4294967295">"#);
    assert_eq!(
        check(
            &wrapped,
            &ok_header.replace(r#"itemCnt="4">"#, r#"itemCnt="0">"#),
            &fmt_body(&[3])
        ),
        vec![header_changed()],
        "원본 itemCnt 불일치·넘침"
    );
    // 잘린 출력 header는 읽을 수 없음(규칙을 쓰지 않음).
    let truncated = &ok_header[..ok_header.len() / 2];
    assert_eq!(
        check(&original, truncated, &fmt_body(&[3])),
        vec![Finding::at(
            FindingCode::OutputMalformed,
            "Contents/header.xml"
        )]
    );
    // 깊게 중첩한 서식 밖 자식(원본에도 같은 것): 반복 순회라 그대로 받는다.
    let nested = format!("{}{}", "<hh:x>".repeat(400), "</hh:x>".repeat(400));
    let deep_base = fmt_def(0, 1000, "").replace("<hh:fontRef", &format!("{nested}<hh:fontRef"));
    let deep_original = fmt_header(1, &[&deep_base], &[], "JUSTIFY");
    let deep_appended = deep_base
        .replace(r#"id="0""#, r#"id="1""#)
        .replace("<hh:underline", "<hh:italic/><hh:underline");
    let deep_header = fmt_header(2, &[&deep_base], &[&deep_appended], "JUSTIFY");
    assert_eq!(
        check(&deep_original, &deep_header, &fmt_body(&[1])),
        vec![],
        "깊은 중첩"
    );
    // 같은 바탕에서 같은 덧붙임 둘(엔진은 다시 쓰지만 판정은 각각 바탕과 같으면 받는다 — 둘 다 쓰여야 함).
    let twice = fmt_header(
        5,
        &d,
        &[&italic, &fmt_def(4, 1000, "<hh:italic/>")],
        "JUSTIFY",
    );
    assert_eq!(
        check(&original, &twice, &fmt_body(&[3, 4])),
        vec![],
        "같은 모양 둘(둘 다 쓰임)"
    );
    assert_eq!(
        check(&original, &twice, &fmt_body(&[3])),
        changed,
        "같은 모양 둘(하나만 쓰임)"
    );
}

#[test]
#[ignore = "큰 입력: cargo test --release --lib -- --ignored --nocapture hwpx_id_상한_경계"]
fn hwpx_id_상한_경계() {
    // 덧붙인 마지막 id 65535는 받고(엔진 MAX_RESOURCE_ID), 65536은 막는다.
    for (n, accepted) in [(65_535u32, true), (65_536u32, false)] {
        let (before, after) = large_header_pair(n, 1);
        let (b, a) = (
            package::open(&before, package::Side::Original).unwrap(),
            package::open(&after, package::Side::Output).unwrap(),
        );
        let started = std::time::Instant::now();
        let findings = package::compare_saved_hwpx(&b, &a);
        println!(
            "{}",
            json!({"original": n, "appended": 1, "lastId": n, "compareMs": started.elapsed().as_millis() as u64, "accepted": findings.is_empty()})
        );
        assert_eq!(findings.is_empty(), accepted, "{n}: {findings:?}");
    }
}

#[test]
#[ignore = "실제 엔진 출력 판정: GEUL_T010_FORMAT_CASES='원본|출력|safe 여부;…' cargo test --lib -- --ignored --nocapture 실제_엔진_서식_출력_판정"]
fn 실제_엔진_서식_출력_판정() {
    let cases = std::env::var("GEUL_T010_FORMAT_CASES").expect("GEUL_T010_FORMAT_CASES");
    let mut ran = 0;
    for case in cases.split(';').filter(|c| !c.is_empty()) {
        let parts: Vec<&str> = case.split('|').collect();
        let [original, output, expected] = parts[..] else {
            panic!("case: {case}")
        };
        let (o, out) = (
            std::fs::read(original).unwrap(),
            std::fs::read(output).unwrap(),
        );
        let checked = service::check_saved(
            Format::Hwpx,
            &o,
            &out,
            Some(&report("hwpx", json!([]))),
            true,
        );
        let safe = checked.is_safe();
        println!(
            "{}",
            json!({"output": Path::new(output).file_name().unwrap().to_string_lossy(), "safe": safe, "findings": format!("{:?}", checked)})
        );
        assert_eq!(safe.to_string(), expected, "{output}");
        ran += 1;
    }
    assert!(ran > 0, "실행한 사례 0건");
}

// ---- T010 강화: formCharPr·run의 "쓰임"은 고정 rhwp 파서가 실제로 읽는 자리만 ----
//
// 근거(고정 rhwp `parser/hwpx/section.rs`): 문단 본문 루프는 `btn`·`checkBtn`·`radioBtn`·`comboBox`·`edit`의 Start에서만
// `parse_form_object`를 부르고, 그 안에서 `formCharPr`는 양식 요소의 **바로 아래 Empty**(자기 닫힘)일 때만 읽는다(Start 자식은
// `text` 말고 `skip_element`). `hp:ctrl`은 `parse_ctrl`이 모르는 자식을 `skip_element`로 건너뛴다. 직렬화기는 양식을 `hp:run`의
// 바로 아래에 쓴다(`serializer/hwpx/section.rs` "폼은 <hp:run> 직접 자식"). 실제 엔진 출력의 서식 run 경로: 본문
// `sec/p/run`, 표 셀 `sec/p/run/tbl/tr/tc/subList/p/run`.

fn form_in_run(form: &str, inner: &str) -> String {
    sec_with(&format!(
        r#"<hp:run charPrIDRef="0"><hp:{form}>{inner}</hp:{form}></hp:run>"#
    ))
}

#[test]
fn formcharpr는_엔진이_읽는_양식_자리만_쓰임이다() {
    let header = appended_italic_header();
    let ok = vec![];
    let changed = vec![header_changed()];
    let empty_form =
        r#"<hp:formCharPr charPrIDRef="3" followContext="0" autoSz="0" wordWrap="0"/>"#;
    // 양성: 다섯 양식 종류 모두, hp:run 바로 아래 양식의 바로 아래 자기 닫힘 formCharPr.
    for form in ["btn", "checkBtn", "radioBtn", "comboBox", "edit"] {
        assert_eq!(
            fmt_check(&header, &form_in_run(form, empty_form)),
            ok,
            "{form}"
        );
    }
    // 표 셀 안 문단의 양식.
    let in_cell = sec_with(&format!(
        r#"<hp:run charPrIDRef="0"><hp:tbl><hp:tr><hp:tc><hp:subList><hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:edit>{empty_form}<hp:text/></hp:edit></hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run>"#
    ));
    assert_eq!(fmt_check(&header, &in_cell), ok, "표 셀 안 양식");
    let negative: Vec<(&str, String, Vec<Finding>)> = vec![
        (
            "A hp:p 바로 아래",
            sec_with(&format!(
                r#"<hp:run charPrIDRef="0"><hp:t>a</hp:t></hp:run>{empty_form}"#
            )),
            changed.clone(),
        ),
        (
            "B 양식이 아닌 hp 요소 아래",
            form_in_run("fake", empty_form),
            changed.clone(),
        ),
        (
            "C hp:ctrl 안의 양식(parse_ctrl이 건너뜀)",
            sec_with(&format!(
                r#"<hp:run charPrIDRef="0"><hp:ctrl><hp:checkBtn>{empty_form}</hp:checkBtn></hp:ctrl></hp:run>"#
            )),
            changed.clone(),
        ),
        (
            "C2 hp:p 바로 아래 양식(run 밖)",
            sec_with(&format!(
                r#"<hp:run charPrIDRef="0"><hp:t>a</hp:t></hp:run><hp:checkBtn>{empty_form}</hp:checkBtn>"#
            )),
            changed.clone(),
        ),
        (
            "D 내용 있는 formCharPr(Start — skip_element)",
            form_in_run(
                "checkBtn",
                r#"<hp:formCharPr charPrIDRef="3"></hp:formCharPr>"#,
            ),
            changed.clone(),
        ),
        (
            "D2 양식 자식 안에 둔 formCharPr",
            form_in_run("edit", &format!("<hp:text>{empty_form}</hp:text>")),
            changed.clone(),
        ),
        (
            "E 다른 이름공간의 formCharPr",
            form_in_run(
                "checkBtn",
                r#"<o:formCharPr xmlns:o="urn:other" charPrIDRef="3"/>"#,
            ),
            changed.clone(),
        ),
        (
            "E2 다른 이름공간의 양식",
            sec_with(&format!(
                r#"<hp:run charPrIDRef="0"><o:checkBtn xmlns:o="urn:other">{empty_form}</o:checkBtn></hp:run>"#
            )),
            changed.clone(),
        ),
        (
            "F 이름공간 붙은 charPrIDRef",
            form_in_run(
                "checkBtn",
                r#"<hp:formCharPr xmlns:x="urn:x" x:charPrIDRef="3" charPrIDRef="0"/>"#,
            ),
            changed.clone(),
        ),
        (
            "G 건너뛰는 컨테이너 안 문단의 run",
            sec_with(
                r#"<hp:run charPrIDRef="0"><hp:ctrl><hp:unknown><hp:subList><hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="3"><hp:t>b</hp:t></hp:run></hp:p></hp:subList></hp:unknown></hp:ctrl></hp:run>"#,
            ),
            changed.clone(),
        ),
        (
            "G2 표 셀이 아닌 subList(글상자 — 이 규칙 밖, fail-closed)",
            sec_with(
                r#"<hp:run charPrIDRef="0"><hp:rect><hp:drawText><hp:subList><hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="3"><hp:t>b</hp:t></hp:run></hp:p></hp:subList></hp:drawText></hp:rect></hp:run>"#,
            ),
            changed.clone(),
        ),
        (
            "G3 tbl 구조가 아닌 tc 경로",
            sec_with(
                r#"<hp:run charPrIDRef="0"><hp:fake><hp:tr><hp:tc><hp:subList><hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="3"/></hp:p></hp:subList></hp:tc></hp:tr></hp:fake></hp:run>"#,
            ),
            changed.clone(),
        ),
        (
            "J 숫자가 아닌 formCharPr 참조",
            form_in_run("checkBtn", r#"<hp:formCharPr charPrIDRef="x3"/>"#),
            vec![
                header_changed(),
                Finding::at(FindingCode::ReferenceInvalid, "Contents/section0.xml"),
            ],
        ),
        (
            "J2 참조 없는 formCharPr",
            form_in_run("checkBtn", r#"<hp:formCharPr followContext="0"/>"#),
            changed.clone(),
        ),
    ];
    let wrong: Vec<String> = negative
        .iter()
        .filter_map(|(label, body, expected)| {
            let got = fmt_check(&header, body);
            (&got != expected).then(|| format!("{label}: {got:?}"))
        })
        .collect();
    assert!(
        wrong.is_empty(),
        "판정이 다른 음성 사례:\n{}",
        wrong.join("\n")
    );
    // I: 덧붙임 둘 중 하나는 진짜 run, 하나는 무시되는 양식 자리에서만 쓰임.
    let (defs, _) = fmt_original();
    let d: Vec<&str> = defs.iter().map(String::as_str).collect();
    let two = fmt_header(
        5,
        &d,
        &[&italic_of_zero(), &fmt_def(4, 1600, "<hh:italic/>")],
        "JUSTIFY",
    );
    let body = sec_with(
        r#"<hp:run charPrIDRef="3"><hp:ctrl><hp:checkBtn><hp:formCharPr charPrIDRef="4"/></hp:checkBtn></hp:ctrl></hp:run>"#,
    );
    assert_eq!(
        fmt_check(&two, &body),
        changed,
        "I 하나는 무시되는 자리에서만"
    );
    let body = sec_with(
        r#"<hp:run charPrIDRef="3"><hp:checkBtn><hp:formCharPr charPrIDRef="4"/></hp:checkBtn></hp:run>"#,
    );
    assert_eq!(fmt_check(&two, &body), ok, "I 대조: 둘 다 읽히는 자리");
    // 표 안 표의 셀(중첩)도 엔진이 읽는다.
    let nested = sec_with(
        r#"<hp:run charPrIDRef="0"><hp:tbl><hp:tr><hp:tc><hp:subList><hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:tbl><hp:tr><hp:tc><hp:subList><hp:p id="2" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="3"><hp:t>c</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run>"#,
    );
    assert_eq!(fmt_check(&header, &nested), ok, "표 안 표");
}

#[test]
fn 실제_저장_서비스는_무시되는_formcharpr_자리로_덧붙임을_게시하지_않는다() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let (_, header) = fmt_original();
    let original = zip(
        &hwpx_package(&fmt_body(&[0, 1]), &header, true, true),
        false,
    );
    let info = rhwp_session(&state, &dir, "a.hwpx", &original);
    let registry = state.registry();
    let (id, generation) = (info.session_id, info.load_generation);
    let source = registry.preflight_source(id, generation).unwrap();
    let read = service::read_original(&source, &Limits::default()).unwrap();
    let check = service::preflight(
        Format::Hwpx,
        &read,
        &original,
        Some(&report("hwpx", json!([]))),
    );
    assert!(check.is_safe(), "{check:?}");
    registry
        .record_preflight(id, generation, source.content_hash, check)
        .unwrap();
    registry.commit(id, generation, 0, 1).unwrap();
    let appended = appended_italic_header();
    let empty_form = r#"<hp:formCharPr charPrIDRef="3"/>"#;
    for (label, body) in [
        (
            "hp:p 바로 아래",
            sec_with(&format!(
                r#"<hp:run charPrIDRef="0"><hp:t>a</hp:t></hp:run>{empty_form}"#
            )),
        ),
        (
            "hp:ctrl 안 양식",
            sec_with(&format!(
                r#"<hp:run charPrIDRef="0"><hp:ctrl><hp:checkBtn>{empty_form}</hp:checkBtn></hp:ctrl></hp:run>"#
            )),
        ),
        (
            "내용 있는 formCharPr",
            form_in_run(
                "checkBtn",
                r#"<hp:formCharPr charPrIDRef="3"></hp:formCharPr>"#,
            ),
        ),
    ] {
        let output = zip(&hwpx_package(&body, &appended, true, true), false);
        let ticket = registry.begin_save(id, generation, 1).unwrap();
        let error = service::save(
            registry,
            &ticket,
            &Limits::default(),
            &output,
            Some(&report("hwpx", json!([]))),
            true,
        )
        .unwrap_err();
        drop(ticket);
        assert!(
            matches!(&error, DocumentError::UnsafeSave { preservation }
                if preservation.findings == vec![header_changed()]),
            "{label}: {error:?}"
        );
        assert_eq!(
            std::fs::read(dir.path().join("a.hwpx")).unwrap(),
            original,
            "{label}"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "{label}");
        assert!(registry.get(id).unwrap().dirty);
    }
    // 대조: 엔진이 읽는 양식 자리는 게시.
    let valid = zip(
        &hwpx_package(&form_in_run("checkBtn", empty_form), &appended, true, true),
        false,
    );
    let ticket = registry.begin_save(id, generation, 1).unwrap();
    let saved = service::save(
        registry,
        &ticket,
        &Limits::default(),
        &valid,
        Some(&report("hwpx", json!([]))),
        true,
    )
    .unwrap();
    assert!(!saved.session.dirty);
    assert_eq!(std::fs::read(dir.path().join("a.hwpx")).unwrap(), valid);
}

// ---- T010 강화 P2-C: HWPX 저장 판정 전체 경로의 자원(측정, 명시 실행) ----

/// 명시 실행하는 측정 도구. reset 실패 시 단계 peak는 null, 읽힌 HWM은 process-wide로만 표시한다.
fn peak_reset() -> Result<(), String> {
    if !cfg!(target_os = "linux") {
        return Err("Linux /proc unavailable".into());
    }
    let path = Path::new("/proc/self/clear_refs");
    if !path.is_file() {
        return Err("clear_refs unavailable".into());
    }
    std::fs::write(path, "5").map_err(|error| format!("clear_refs reset failed: {error}"))
}

fn parse_peak_kib(status: &str) -> Result<(u64, u64), String> {
    let field = |key: &str| {
        let mut words = status
            .lines()
            .find(|line| line.starts_with(key))
            .ok_or_else(|| format!("missing {key}"))?
            .split_whitespace();
        let _key = words.next();
        let value = words.next().and_then(|word| word.parse::<u64>().ok());
        match (value, words.next(), words.next()) {
            (Some(value), Some("kB"), None) if value > 0 => Ok(value),
            _ => Err(format!("invalid {key}")),
        }
    };
    let (hwm, rss) = (field("VmHWM:")?, field("VmRSS:")?);
    if hwm < rss {
        return Err("VmHWM below VmRSS".into());
    }
    Ok((hwm, rss))
}

fn peak_kib() -> Result<(u64, u64), String> {
    if !cfg!(target_os = "linux") {
        return Err("Linux /proc unavailable".into());
    }
    let status = std::fs::read_to_string("/proc/self/status")
        .map_err(|error| format!("status read failed: {error}"))?;
    parse_peak_kib(&status)
}

fn peak_evidence(
    reset: Result<(), String>,
    reading: Result<(u64, u64), String>,
) -> serde_json::Value {
    let method = match (&reset, &reading) {
        (_, Err(_)) => "unavailable",
        (Ok(()), Ok(_)) => "linux-clear_refs-5-stage",
        (Err(_), Ok(_)) => "linux-process-high-water-no-reset",
    };
    let (hwm, rss) = reading
        .as_ref()
        .map_or((None, None), |&(hwm, rss)| (Some(hwm), Some(rss)));
    json!({
        "rssMethod": method,
        "peakRssKiB": if reset.is_ok() { hwm } else { None },
        "processPeakRssKiB": if reset.is_err() { hwm } else { None },
        "rssAfterKiB": rss,
        "peakResetError": reset.err(),
        "rssReadError": reading.err(),
    })
}

#[test]
fn rss_측정_실패는_영이나_단계_peak로_보이지_않는다() {
    // 합성 status·결과만 사용: 일반 테스트는 /proc 또는 Linux를 요구하지 않는다.
    assert_eq!(parse_peak_kib("VmHWM: 42 kB\nVmRSS: 21 kB\n"), Ok((42, 21)));
    for status in [
        "",
        "VmHWM: 0 kB\nVmRSS: 1 kB",
        "VmHWM: 9 MB\nVmRSS: 1 kB",
        "VmHWM: nope kB\nVmRSS: 1 kB",
        "VmHWM: 9 kB",
        "VmHWM: 9 kB\nVmRSS: 10 kB",
        "VmHWM: 18446744073709551616 kB\nVmRSS: 1 kB",
    ] {
        assert!(parse_peak_kib(status).is_err(), "{status}");
    }
    for reason in ["not Linux", "clear_refs missing", "write denied"] {
        let value = peak_evidence(Err(reason.into()), Ok((42, 21)));
        assert!(value["peakRssKiB"].is_null());
        assert_eq!(value["processPeakRssKiB"], 42);
        assert_eq!(value["rssMethod"], "linux-process-high-water-no-reset");
        assert_eq!(value["peakResetError"], reason);
    }
    for reset in [Ok(()), Err("write denied".into())] {
        let value = peak_evidence(reset, Err("status unreadable".into()));
        assert!(value["peakRssKiB"].is_null() && value["rssAfterKiB"].is_null());
        assert!(value["processPeakRssKiB"].is_null());
        assert_eq!(value["rssMethod"], "unavailable");
    }
    let value = peak_evidence(Ok(()), Ok((42, 21)));
    assert_eq!(value["peakRssKiB"], 42);
    assert_eq!(value["rssMethod"], "linux-clear_refs-5-stage");
}

#[test]
#[ignore = "측정: GEUL_T010_STAGE_CASE=n,k[,mode] cargo test --release --lib -- --ignored --nocapture hwpx_저장_판정_단계별_자원"]
fn hwpx_저장_판정_단계별_자원() {
    let case = std::env::var("GEUL_T010_STAGE_CASE").expect("GEUL_T010_STAGE_CASE");
    let fields: Vec<&str> = case.split(',').collect();
    let (n, k): (u32, u32) = (fields[0].parse().unwrap(), fields[1].parse().unwrap());
    let mode = fields.get(2).copied().unwrap_or("valid");
    let (before, mut after) = large_header_pair(n, k);
    if mode == "rejected" {
        // 같은 크기에서 독립된 까닭(쓰이지 않는 덧붙임)으로 거부되는 출력.
        let a = package::open(&after, package::Side::Output).unwrap();
        let header = a.get("Contents/header.xml").unwrap().to_vec();
        after = zip(
            &hwpx_package(
                &fmt_body(&[0]),
                std::str::from_utf8(&header).unwrap(),
                true,
                true,
            ),
            false,
        );
    } else if mode == "malformed" {
        // 같은 크기 header를 끝 근처에서 잘라 읽을 수 없게 만든 출력.
        let a = package::open(&after, package::Side::Output).unwrap();
        let header = a.get("Contents/header.xml").unwrap();
        let cut = std::str::from_utf8(&header[..header.len() - 64])
            .unwrap()
            .to_string();
        after = zip(&hwpx_package(&fmt_body(&[0]), &cut, true, true), false);
    } else {
        assert_eq!(mode, "valid", "모르는 측정 모드");
    }
    let mut stages = Vec::new();
    let mut stage = |name: &str, run: &mut dyn FnMut() -> String| {
        let reset = peak_reset();
        let started = std::time::Instant::now();
        let result = run();
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        let mut measurement = peak_evidence(reset, peak_kib());
        measurement["stage"] = json!(name);
        measurement["ms"] = json!((ms * 10.0).round() / 10.0);
        measurement["result"] = json!(result);
        stages.push(measurement);
    };
    let mut opened = None;
    stage("package::open 둘(압축 풀기)", &mut || {
        opened = Some((
            package::open(&before, package::Side::Original).unwrap(),
            package::open(&after, package::Side::Output).unwrap(),
        ));
        String::new()
    });
    let (b, a) = opened.unwrap();
    let header_bytes = a.get("Contents/header.xml").unwrap().len();
    let expanded: usize = a.parts.values().map(|(_, d)| d.len()).sum();
    stage("validate_hwpx", &mut || {
        format!("{:?}", package::validate_hwpx(&b, &a))
    });
    stage("compare_saved_hwpx", &mut || {
        format!("{:?}", package::compare_saved_hwpx(&b, &a))
    });
    stage("validate_hwpx_references", &mut || {
        format!("{:?}", package::validate_hwpx_references(&a))
    });
    drop((b, a));
    stage("service::check_saved 전체", &mut || {
        format!(
            "{:?}",
            service::check_saved(
                Format::Hwpx,
                &before,
                &after,
                Some(&report("hwpx", json!([]))),
                true
            )
            .outcome
        )
    });
    println!(
        "{}",
        json!({"original": n, "appended": k, "mode": mode, "zipBytes": after.len(), "headerBytes": header_bytes, "expandedOutputBytes": expanded, "fixtureCreationIncluded": false, "stages": stages})
    );
}

#[test]
#[ignore = "isolated retained XML payload accounting; GEUL_T010_STAGE_CASE=n,k"]
fn hwpx_header_canonical_payload() {
    let case = std::env::var("GEUL_T010_STAGE_CASE").unwrap();
    let fields: Vec<_> = case.split(',').collect();
    let (n, k) = (fields[0].parse().unwrap(), fields[1].parse().unwrap());
    let (_, output) = large_header_pair(n, k);
    let package = package::open(&output, package::Side::Output).unwrap();
    let header = package.get("Contents/header.xml").unwrap();
    let reset = peak_reset();
    let started = std::time::Instant::now();
    let (events, m) = crate::document::xml::canonical_with_payload_limit(header, None).unwrap();
    let mut evidence = peak_evidence(reset, peak_kib());
    evidence["headerBytes"] = json!(header.len());
    evidence["events"] = json!(m.events);
    evidence["retainedPayloadBytes"] = json!(m.retained_payload_bytes);
    evidence["eventCapacityBytes"] = json!(m.event_capacity_bytes);
    evidence["attributeCapacityBytes"] = json!(m.attribute_capacity_bytes);
    evidence["atomPayloadBytes"] = json!(m.atom_payload_bytes);
    evidence["textCapacityBytes"] = json!(m.text_capacity_bytes);
    evidence["excluded"] = json!("Arc/allocator/hash metadata, parser/decoded transients, package/input buffers, vector reallocation overlap");
    evidence["ms"] = json!(started.elapsed().as_secs_f64() * 1000.0);
    assert_eq!(events.len(), m.events);
    println!("{evidence}");
}

#[test]
fn overlapping_hwpx_checks_keep_independent_canonical_state() {
    let (before, after) = large_header_pair(100, 5);
    let loss = report("hwpx", json!([]));
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| {
                assert_eq!(
                    service::check_saved(Format::Hwpx, &before, &after, Some(&loss), true).outcome,
                    Outcome::Safe
                )
            });
        }
    });
}

#[test]
fn resource_refusal_in_save_service_preserves_bytes_hash_dirty_and_ticket_release() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let original = hwp_doc(0, &docinfo(0, b"font"), &section("hello"), &[]);
    let info = rhwp_session(&state, &dir, "resource.hwp", &original);
    let registry = state.registry();
    registry
        .commit(info.session_id, info.load_generation, 0, 1)
        .unwrap();
    let before = registry.get(info.session_id).unwrap();
    let limits = Limits {
        max_file_bytes: original.len() as u64 - 1,
        ..Limits::default()
    };
    let hash = crate::document::content_hash(&original);
    for _ in 0..2 {
        let ticket = registry
            .begin_save(info.session_id, info.load_generation, 1)
            .unwrap();
        assert_eq!(
            service::save(
                registry,
                &ticket,
                &limits,
                &original,
                Some(&report("hwp", json!([]))),
                true
            )
            .unwrap_err(),
            DocumentError::ResourceLimit {
                limit: crate::document::LimitKind::FileSize
            }
        );
        drop(ticket);
        let bytes = std::fs::read(dir.path().join("resource.hwp")).unwrap();
        assert_eq!(bytes, original);
        assert_eq!(crate::document::content_hash(&bytes), hash);
        assert_eq!(registry.get(info.session_id).unwrap(), before);
        assert!(before.dirty);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}

// Frozen service dispatch from 308961c; special comparator bodies are frozen separately.
fn special_legacy_check_saved(
    format: Format,
    original: &[u8],
    output: &[u8],
    report: Option<&Value>,
    reopen_equal: bool,
) -> Preservation {
    let mut findings = match (format, report) {
        (Format::Hwp | Format::Hwpx, Some(r)) => loss::check(r, format),
        (Format::Docx, None) => vec![],
        _ => vec![Finding::new(FindingCode::LossReportInvalid)],
    };
    if !reopen_equal {
        findings.push(Finding::new(FindingCode::ReopenMismatch));
    }
    if !crate::document::detect(&mut std::io::Cursor::new(output), output.len() as u64)
        .is_ok_and(|detected| detected == format)
    {
        findings.push(Finding::at(FindingCode::OutputMalformed, "container"));
        return Preservation::from_findings(findings);
    }
    match format {
        Format::Hwp => findings.extend(hwp::compare_saved(original, output)),
        Format::Hwpx | Format::Docx => match (
            package::open(original, package::Side::Original),
            package::open(output, package::Side::Output),
        ) {
            (Ok(before), Ok(after)) if format == Format::Hwpx => {
                findings.extend(package::validate_hwpx(&before, &after));
                findings.extend(package::special_legacy::compare_saved_hwpx(&before, &after));
                findings.extend(package::special_legacy::validate_hwpx_references(&after));
            }
            (Ok(before), Ok(after)) => {
                findings.extend(package::validate_docx(&after));
                findings.extend(package::special_legacy::compare_saved_docx(&before, &after));
            }
            (Err(finding), _) | (_, Err(finding)) => findings.push(finding),
        },
    }
    Preservation::from_findings(findings)
}

#[test]
fn special_header_full_findings_match_frozen_oracle() {
    let (defs, original) = fmt_original();
    let d: Vec<_> = defs.iter().map(String::as_str).collect();
    let good = fmt_header(4, &d, &[&italic_of_zero()], "JUSTIFY");
    let other = fmt_def(4, 1100, "<hh:bold/>");
    let mut headers = vec![
        original.clone(),
        good.clone(),
        fmt_header(5, &d, &[&italic_of_zero(), &other], "JUSTIFY"),
        good.replace("hh:", "h:").replace("xmlns:hh", "xmlns:h"),
        good.replace("height=\"1000\"", "height=\"999\""),
        good.replace("id=\"3\"", "id=\"65536\""),
        good.replace("id=\"3\"", "id=\"0\""),
        good.replace(
            "<hh:italic/>",
            "<hh:underline type=\"CENTER\" shape=\"SOLID\" color=\"none\"/>",
        ),
        good.replace(
            "<hh:italic/>",
            "<hh:strikeout shape=\"3D\" color=\"none\"/>",
        ),
        good.replace("<hh:italic/>", "<hh:italic/><hh:italic/>"),
        good.replace("<hh:italic/>", "<hh:unknown/>"),
        good.replace("<hh:italic/>", "<hh:italic>text</hh:italic>"),
        good.replace("itemCnt=\"4\"", "itemCnt=\"3\""),
        good.replace("JUSTIFY", "LEFT"),
        good.replace("http://www.hancom.co.kr/hwpml/2011/head", "wrong"),
        format!("{good}<bad"),
        format!("{good}<!--unfinished"),
        good.replace(
            "</hh:charProperties>",
            "<hh:charProperties/></hh:charProperties>",
        ),
    ];
    for text in ["a<![CDATA[b]]>&amp;", "x< hh:bad", "", "a< hh:bad"] {
        headers.push(good.replace("<hh:italic/>", text));
    }
    let loss = report("hwpx", json!([]));
    for before_header in [&original, &format!("{original}<bad")] {
        let before = zip(
            &hwpx_package(&fmt_body(&[0]), before_header, true, true),
            false,
        );
        for (i, header) in headers.iter().enumerate() {
            for body in [
                fmt_body(&[3, 4]),
                fmt_body(&[0]),
                fmt_body(&[65536]),
                format!(
                    r#"<hs:sec xmlns:hs="{}" xmlns:hp="{}"><hp:p><hp:run><hp:ctrl><hp:edit><hp:formCharPr charPrIDRef="3"/></hp:edit></hp:ctrl></hp:run></hp:p></hs:sec>"#,
                    "http://www.hancom.co.kr/hwpml/2011/section",
                    "http://www.hancom.co.kr/hwpml/2011/paragraph"
                ),
            ] {
                let after = zip(&hwpx_package(&body, header, true, true), false);
                assert_eq!(
                    service::check_saved(Format::Hwpx, &before, &after, Some(&loss), true),
                    special_legacy_check_saved(Format::Hwpx, &before, &after, Some(&loss), true),
                    "header case {i}"
                );
            }
        }
    }
    // Large local text and attributes are not retained in a definition event vector.
    for text in ["a<![CDATA[b]]>&amp;".to_string(), "x".repeat(256 * 1024)] {
        let old = fmt_def(0, 1000, &text);
        let new = fmt_def(1, 1000, &format!("{text}<hh:italic/>"));
        let before = pkg(&hwpx_package(
            &fmt_body(&[0]),
            &fmt_header(1, &[&old], &[], "JUSTIFY"),
            true,
            true,
        ));
        let after = pkg(&hwpx_package(
            &fmt_body(&[1]),
            &fmt_header(2, &[&old], &[&new], "JUSTIFY"),
            true,
            true,
        ));
        assert_eq!(
            package::compare_saved_hwpx(&before, &after),
            package::special_legacy::compare_saved_hwpx(&before, &after)
        );
    }
}

#[test]
fn special_statistics_full_findings_match_frozen_oracle() {
    let ns = "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
    let wrap = |body: &str| format!(r#"<p:Properties xmlns:p="{ns}">{body}</p:Properties>"#);
    let mut cases = vec![
        wrap("<p:Words>1</p:Words><p:Company>A</p:Company>"),
        wrap("<p:Words>222</p:Words><p:Company>A</p:Company>"),
        wrap("<p:Words>1</p:Words><p:Company>B</p:Company>"),
        wrap("<p:Words/><p:Company>A</p:Company>"),
        wrap("<p:Words><![CDATA[]]></p:Words><p:Company>A</p:Company>"),
        wrap("<p:Words>&#49;</p:Words><p:Company><![CDATA[A]]></p:Company>"),
        wrap("<p:Words><p:Company>1</p:Company></p:Words>"),
        wrap("<p:Words><p:Company>2</p:Company></p:Words>"),
        wrap("<p:Words id=\"1\">1</p:Words>"),
        wrap("<p:Words id=\"2\">1</p:Words>"),
        wrap("<p:Words xmlns:p=\"wrong\">2</p:Words>"),
        wrap("<p:Words>&unknown;</p:Words>"),
        format!("{}<bad", wrap("<p:Words>2</p:Words>")),
        wrap("<p:Words>1</p:Words><p:Pages>2</p:Pages>"),
        wrap("<p:Words>3</p:Words><p:Pages>4</p:Pages>"),
    ];
    cases.push(wrap(&format!(
        "<p:Words>{}</p:Words>",
        "x".repeat(128 * 1024)
    )));
    for a in &cases {
        for b in &cases {
            let before = pkg(&[stored("docProps/app.xml", a.as_bytes())]);
            let after = pkg(&[stored("docProps/app.xml", b.as_bytes())]);
            assert_eq!(
                package::compare_saved_docx(&before, &after),
                package::special_legacy::compare_saved_docx(&before, &after)
            );
            assert_eq!(
                package::same_except_statistics(a.as_bytes(), b.as_bytes()),
                package::legacy_statistics(a.as_bytes(), b.as_bytes())
            );
        }
    }
    let value = wrap("<p:Words>123</p:Words><p:Company>a&amp;b</p:Company>");
    let mut utf16 = vec![0xff, 0xfe];
    for unit in value.encode_utf16() {
        utf16.extend(unit.to_le_bytes());
    }
    assert_eq!(
        package::same_except_statistics(value.as_bytes(), &utf16),
        Some(true)
    );
    assert_eq!(
        package::same_except_statistics(value.as_bytes(), value.replace("123", "9").as_bytes()),
        Some(true)
    );
}

#[test]
fn reservation_refusal_preserves_real_save_and_allows_retry() {
    use crate::document::resources::{self, Category, Pool};
    let pool = Pool::limited(usize::MAX);
    let state = DocumentState::with_resource_pool(pool.clone());
    let dir = TempDir::new();
    let original = hwp_doc(0, &docinfo(0, b"font"), &section("hello"), &[]);
    let info = rhwp_session(&state, &dir, "reserved.hwp", &original);
    let registry = state.registry();
    let loss = report("hwp", json!([]));
    let preflight = service::preflight(Format::Hwp, &original, &original, Some(&loss));
    assert!(preflight.is_safe());
    registry
        .record_preflight(
            info.session_id,
            info.load_generation,
            crate::document::content_hash(&original),
            preflight,
        )
        .unwrap();
    registry
        .commit(info.session_id, info.load_generation, 0, 1)
        .unwrap();
    let before = registry.get(info.session_id).unwrap();
    let bytes_hash = crate::document::content_hash(&original);
    for category in [
        Category::Original,
        Category::Parsing,
        Category::Comparison,
        Category::BeforePublication,
        Category::Staging,
    ] {
        pool.deny(Some(category));
        let result = resources::scope(pool.operation(), || {
            let ticket = registry
                .begin_save(info.session_id, info.load_generation, 1)
                .unwrap();
            service::save(
                registry,
                &ticket,
                &Limits::default(),
                &original,
                Some(&loss),
                true,
            )
        });
        if matches!(category, Category::Parsing | Category::Comparison) {
            assert!(
                matches!(&result,Err(DocumentError::UnsafeSave{preservation}) if preservation.findings==vec![Finding::new(FindingCode::LimitExceeded)]),
                "{category:?}: {result:?}"
            );
        } else {
            assert_eq!(result.unwrap_err(), resources::refused(), "{category:?}");
        }
        assert_eq!(pool.usage().0, 0, "{category:?}");
        let bytes = std::fs::read(dir.path().join("reserved.hwp")).unwrap();
        assert_eq!(bytes, original);
        if let Some(path) = std::env::var_os("GEUL_T009_RESOURCE_AUDIT") {
            let path = std::path::PathBuf::from(path);
            std::fs::write(path.join("original.hwp"), &original).unwrap();
            std::fs::write(path.join(format!("after-{category:?}.hwp")), &bytes).unwrap();
        }
        assert_eq!(crate::document::content_hash(&bytes), bytes_hash);
        assert_eq!(registry.get(info.session_id).unwrap(), before);
        assert!(before.dirty);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        // Ticket must already have released even after stage-created temporary-file refusal.
        drop(
            registry
                .begin_save(info.session_id, info.load_generation, 1)
                .unwrap(),
        );
    }
    pool.deny(None);
    let saved = resources::scope(pool.operation(), || {
        let ticket = registry
            .begin_save(info.session_id, info.load_generation, 1)
            .unwrap();
        service::save(
            registry,
            &ticket,
            &Limits::default(),
            &original,
            Some(&loss),
            true,
        )
        .unwrap()
    });
    assert!(!saved.session.dirty);
    assert_eq!(pool.usage().0, 0);
}

#[test]
fn reservation_xml_index_and_expansion_refusal_are_resource_not_malformed() {
    use crate::document::resources::{self, Category, Pool};
    let pool = Pool::limited(usize::MAX);
    let (before, after) = large_header_pair(4, 2);
    let loss = report("hwpx", json!([]));
    for category in [Category::Expanded, Category::Index] {
        pool.deny(Some(category));
        let result = resources::scope(pool.operation(), || {
            service::check_saved(Format::Hwpx, &before, &after, Some(&loss), true)
        });
        assert_eq!(
            result.findings,
            vec![Finding::at(
                FindingCode::LimitExceeded,
                if category == Category::Expanded {
                    "container"
                } else {
                    "Contents/header.xml"
                }
            )]
        );
        assert_eq!(pool.usage().0, 0);
    }
    pool.deny(None);
    assert!(resources::scope(pool.operation(), || service::check_saved(
        Format::Hwpx,
        &before,
        &after,
        Some(&loss),
        true
    ))
    .is_safe());
    assert_eq!(pool.usage().0, 0);
}

#[test]
fn canceled_save_and_closed_session_keep_reservation_until_worker_exits() {
    use crate::document::resources::{self, Category, Pool};
    use std::{
        pin::Pin,
        sync::mpsc,
        task::{Context, Poll, Waker},
    };
    for close in [false, true] {
        let pool = Pool::limited(usize::MAX);
        let state = DocumentState::with_resource_pool(pool.clone());
        let dir = TempDir::new();
        let original = hwp_doc(0, &docinfo(0, b"font"), &section("hello"), &[]);
        let info = rhwp_session(&state, &dir, "cancel-reserved.hwp", &original);
        let registry = state.registry().clone();
        let loss = report("hwp", json!([]));
        registry
            .record_preflight(
                info.session_id,
                info.load_generation,
                crate::document::content_hash(&original),
                service::preflight(Format::Hwp, &original, &original, Some(&loss)),
            )
            .unwrap();
        registry
            .commit(info.session_id, info.load_generation, 0, 1)
            .unwrap();
        let (started, rx) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let (finished, done) = mpsc::channel();
        let bytes = original.clone();
        let mut future = Box::pin(state.run_blocking(move || {
            resources::charge(Category::Payload, bytes.capacity())?;
            let ticket = registry.begin_save(info.session_id, info.load_generation, 1)?;
            started.send(()).unwrap();
            released.recv().unwrap();
            let result = service::save(
                &registry,
                &ticket,
                &Limits::default(),
                &bytes,
                Some(&loss),
                true,
            );
            finished.send(result.clone()).unwrap();
            result
        }));
        assert!(matches!(
            Pin::as_mut(&mut future).poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        rx.recv_timeout(std::time::Duration::from_secs(20)).unwrap();
        drop(future);
        assert_eq!(pool.usage().0, original.len());
        if close {
            state.registry().close(info.session_id).unwrap();
        }
        assert_eq!(
            pool.usage().0,
            original.len(),
            "closing cannot release worker-owned buffers"
        );
        release.send(()).unwrap();
        assert!(done
            .recv_timeout(std::time::Duration::from_secs(20))
            .unwrap()
            .is_err());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while pool.usage().0 != 0 {
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        assert_eq!(
            std::fs::read(dir.path().join("cancel-reserved.hwp")).unwrap(),
            original
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        if !close {
            assert!(state.registry().get(info.session_id).unwrap().dirty);
        }
    }
}

#[test]
#[ignore = "independent-process matched special comparator probe; GEUL_SPECIAL_CASE=header/stats/text/utf16/events and GEUL_SPECIAL_MODE=legacy/new"]
fn special_resource_probe() {
    use crate::document::resources::{self, Pool};
    let case = std::env::var("GEUL_SPECIAL_CASE").unwrap();
    let mode = std::env::var("GEUL_SPECIAL_MODE").unwrap();
    let (format, before, after, xml_bytes) = match case.as_str() {
        "header" | "maxid" => {
            let (a, b) = if case == "maxid" {
                large_header_pair(65535, 1)
            } else {
                large_header_pair(60000, 5535)
            };
            let xml_bytes = package::open(&b, package::Side::Output)
                .unwrap()
                .get("Contents/header.xml")
                .unwrap()
                .len();
            (Format::Hwpx, a, b, xml_bytes)
        }
        "stats" | "utf16" => {
            let size = std::env::var("GEUL_SPECIAL_MIB")
                .unwrap_or("16".into())
                .parse::<usize>()
                .unwrap()
                * 1024
                * 1024;
            let ns = "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
            let a = format!(
                r#"<Properties xmlns="{ns}"><Words>{}</Words><Company>A</Company></Properties>"#,
                "x".repeat(size)
            );
            let b = format!(
                r#"<Properties xmlns="{ns}"><Words>{}</Words><Company>A</Company></Properties>"#,
                "y".repeat(size)
            );
            let encode = |s: &str| {
                if case == "utf16" {
                    let mut v = vec![0xff, 0xfe];
                    for u in s.encode_utf16() {
                        v.extend(u.to_le_bytes());
                    }
                    v
                } else {
                    s.as_bytes().to_vec()
                }
            };
            let (a, b) = (encode(&a), encode(&b));
            let n = b.len();
            let before = zip(
                &docx_package("<d/>", vec![entry("docProps/app.xml", &a)], None),
                false,
            );
            let after = zip(
                &docx_package("<d/>", vec![entry("docProps/app.xml", &b)], None),
                false,
            );
            (Format::Docx, before, after, n)
        }
        "text" | "text-component" | "events" => {
            let text = if case == "events" {
                "<hh:x/>".repeat(500000)
            } else {
                "x".repeat(
                    std::env::var("GEUL_SPECIAL_MIB")
                        .unwrap_or("255".into())
                        .parse::<usize>()
                        .unwrap()
                        * 1024
                        * 1024,
                )
            };
            let old = fmt_def(0, 1000, "");
            let new = fmt_def(1, 1000, "<hh:italic/>");
            let prefix = format!("<hh:note>{text}</hh:note>");
            let a = fmt_header(1, &[&old], &[], "JUSTIFY")
                .replace("<hh:refList>", &format!("{prefix}<hh:refList>"));
            let b = fmt_header(2, &[&old], &[&new], "JUSTIFY")
                .replace("<hh:refList>", &format!("{prefix}<hh:refList>"));
            let size = b.len();
            (
                Format::Hwpx,
                zip(&hwpx_package(&fmt_body(&[0]), &a, true, true), false),
                zip(&hwpx_package(&fmt_body(&[1]), &b, true, true), false),
                size,
            )
        }
        _ => panic!("unknown case"),
    };
    let baseline_rss = peak_kib().ok().map(|(_, r)| r);
    let reset = peak_reset();
    let start = std::time::Instant::now();
    let pool = Pool::limited(usize::MAX);
    let loss = report("hwpx", json!([]));
    let report = (format == Format::Hwpx).then_some(&loss);
    let result = resources::scope(pool.operation(), || {
        if case == "text-component" {
            let a = package::open(&before, package::Side::Original).unwrap();
            let b = package::open(&after, package::Side::Output).unwrap();
            Preservation::from_findings(match mode.as_str() {
                "legacy" => package::special_legacy::compare_saved_hwpx(&a, &b),
                "new" => package::compare_saved_hwpx(&a, &b),
                _ => panic!("unknown mode"),
            })
        } else {
            match mode.as_str() {
                "legacy" => special_legacy_check_saved(format, &before, &after, report, true),
                "new" => service::check_saved(format, &before, &after, report, true),
                _ => panic!("unknown mode"),
            }
        }
    });
    let ms = start.elapsed().as_secs_f64() * 1000.0;
    let mut measure = peak_evidence(reset, peak_kib());
    if case == "text" {
        assert_eq!(
            result.findings,
            vec![Finding::at(FindingCode::OutputMalformed, "container")]
        );
    } else {
        assert!(result.is_safe(), "{result:?}");
    }
    assert_eq!(pool.usage().0, 0);
    measure["case"] = json!(case);
    measure["mode"] = json!(mode);
    measure["xmlBytes"] = json!(xml_bytes);
    measure["compressedInputBytes"] = json!(before.len());
    measure["compressedOutputBytes"] = json!(after.len());
    measure["ms"] = json!(ms);
    measure["rssBeforeKiB"] = json!(baseline_rss);
    measure["findings"] = json!(result);
    measure["controlledReservationPeakBytes"] = json!(pool.usage().1);
    measure["categoryReservationPeakBytes"] = json!([
        "borrowedIpcLength",
        "ownedPayload",
        "originalReadCapacity",
        "expandedBufferReservation",
        "utf16DecodedBytes",
        "indexSlotEstimate",
        "stagingReadCapacity",
        "parseBoundary",
        "comparisonBoundary",
        "beforePublication"
    ]
    .into_iter()
    .zip(pool.category_peaks())
    .collect::<std::collections::BTreeMap<_, _>>());
    measure["scope"] = json!(if case == "text-component" {
        "matched package open + special HWPX comparison only; exceeds existing format detector 64MiB; not full service acceptance"
    } else {
        "matched full check_saved; fixture creation excluded; conservative reservations not total heap/RSS"
    });
    println!("{measure}");
}

#[test]
#[ignore = "special full-findings real corpus; GEUL_XML_CORPUS path list"]
fn special_real_corpus_differential() {
    let paths = std::env::var_os("GEUL_XML_CORPUS").unwrap();
    let mut packages = 0;
    let mut parts = 0;
    for path in std::env::split_paths(&paths) {
        let data = std::fs::read(&path).unwrap();
        let format =
            crate::document::detect(&mut std::io::Cursor::new(&data), data.len() as u64).unwrap();
        let package = package::open(&data, package::Side::Original).unwrap();
        for (name, (_, bytes)) in &package.parts {
            if package::is_xml(name, bytes) {
                parts += 1;
            }
        }
        let loss = report("hwpx", json!([]));
        let report = (format == Format::Hwpx).then_some(&loss);
        assert_eq!(
            service::check_saved(format, &data, &data, report, true),
            special_legacy_check_saved(format, &data, &data, report, true),
            "{}",
            path.file_name().unwrap().to_string_lossy()
        );
        let changed: Vec<ZipEntry> = package
            .order
            .iter()
            .map(|name| {
                let (method, bytes) = &package.parts[name];
                let bytes = if package::is_xml(name, bytes) {
                    let text = crate::document::xml::decode(bytes).unwrap();
                    let body = if text.starts_with("<?xml") {
                        &text[text.find("?>").unwrap() + 2..]
                    } else {
                        &text
                    };
                    format!("<?xml version='1.0' encoding='utf-8'?>{body}").into_bytes()
                } else {
                    bytes.clone()
                };
                if *method == 0 {
                    stored(name, &bytes)
                } else {
                    entry(name, &bytes)
                }
            })
            .collect();
        let serialized = zip(&changed, false);
        assert_eq!(
            service::check_saved(format, &data, &serialized, report, true),
            special_legacy_check_saved(format, &data, &serialized, report, true),
            "declaration-only {}",
            path.file_name().unwrap().to_string_lossy()
        );
        packages += 1;
    }
    println!(
        "{}",
        json!({"packages":packages,"xmlParts":parts,"fullFindingsEqual":true})
    );
}

#[test]
fn reservation_real_save_exact_budget_and_one_byte_refusal() {
    use crate::document::resources::{self, Pool};
    let original = hwp_doc(0, &docinfo(0, b"font"), &section("hello"), &[]);
    for extra in [0usize, 1] {
        let pool = Pool::limited(3 * (original.len() + 1) - extra);
        let state = DocumentState::with_resource_pool(pool.clone());
        let dir = TempDir::new();
        let info = rhwp_session(&state, &dir, "exact.hwp", &original);
        let registry = state.registry();
        let loss = report("hwp", json!([]));
        registry
            .record_preflight(
                info.session_id,
                info.load_generation,
                crate::document::content_hash(&original),
                service::preflight(Format::Hwp, &original, &original, Some(&loss)),
            )
            .unwrap();
        registry
            .commit(info.session_id, info.load_generation, 0, 1)
            .unwrap();
        let result = resources::scope(pool.operation(), || {
            let ticket = registry
                .begin_save(info.session_id, info.load_generation, 1)
                .unwrap();
            service::save(
                registry,
                &ticket,
                &Limits::default(),
                &original,
                Some(&loss),
                true,
            )
        });
        if extra == 0 {
            assert!(result.is_ok());
            assert!(!registry.get(info.session_id).unwrap().dirty);
        } else {
            assert_eq!(result.unwrap_err(), resources::refused());
            assert!(registry.get(info.session_id).unwrap().dirty);
        }
        assert_eq!(pool.usage().0, 0);
        assert_eq!(
            std::fs::read(dir.path().join("exact.hwp")).unwrap(),
            original
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        drop(
            registry
                .begin_save(info.session_id, info.load_generation, 1)
                .unwrap(),
        );
    }
}

#[test]
fn reservation_utf16_decoder_refusal_in_preflight_and_save_is_not_malformed() {
    use crate::document::resources::{self, Category, Pool};
    let (_, header) = fmt_original();
    let mut utf16 = vec![0xff, 0xfe];
    for unit in header.encode_utf16() {
        utf16.extend(unit.to_le_bytes());
    }
    let a = zip(&hwpx_package(&fmt_body(&[0]), &header, true, true), false);
    let mut entries = hwpx_package(&fmt_body(&[0]), &header, true, true);
    entries.retain(|entry| entry.name != "Contents/header.xml");
    entries.push(entry("Contents/header.xml", &utf16));
    let b = zip(&entries, false);
    let loss = report("hwpx", json!([]));
    let pool = Pool::limited(usize::MAX);
    pool.deny(Some(Category::Decoder));
    for save in [false, true] {
        let result = resources::scope(pool.operation(), || {
            if save {
                service::check_saved(Format::Hwpx, &a, &b, Some(&loss), true)
            } else {
                service::preflight(Format::Hwpx, &a, &b, Some(&loss))
            }
        });
        assert_eq!(
            result.findings,
            vec![Finding::at(
                FindingCode::LimitExceeded,
                "Contents/header.xml"
            )]
        );
        assert_eq!(pool.usage().0, 0);
    }
    pool.deny(None);
    assert!(resources::scope(pool.operation(), || service::check_saved(
        Format::Hwpx,
        &a,
        &b,
        Some(&loss),
        true
    ))
    .is_safe());
}

#[test]
fn special_header_hash_collision_still_requires_full_semantic_equality() {
    let (defs, _) = fmt_original();
    let d: Vec<_> = defs.iter().map(String::as_str).collect();
    let good = fmt_header(4, &d, &[&italic_of_zero()], "JUSTIFY");
    let bad = fmt_header(4, &d, &[&fmt_def(3, 1200, "<hh:italic/>")], "JUSTIFY");
    super::special::with_colliding_hashes(|| {
        assert!(fmt_check(&good, &fmt_body(&[3])).is_empty());
        assert_eq!(fmt_check(&bad, &fmt_body(&[3])), vec![header_changed()]);
    });
}

#[test]
fn reservation_output_refusal_does_not_hide_original_malformed_precedence() {
    use crate::document::resources::{self, Category, Pool};
    let (_, header) = fmt_original();
    let mut encoded = vec![0xff, 0xfe];
    for c in header.encode_utf16() {
        encoded.extend(c.to_le_bytes());
    }
    let bad = format!("{header}<bad");
    let before = zip(&hwpx_package(&fmt_body(&[0]), &bad, true, true), false);
    let mut entries = hwpx_package(&fmt_body(&[0]), &header, true, true);
    entries.retain(|part| part.name != "Contents/header.xml");
    entries.push(entry("Contents/header.xml", &encoded));
    let after = zip(&entries, false);
    let pool = Pool::limited(usize::MAX);
    pool.deny(Some(Category::Decoder));
    let result = resources::scope(pool.operation(), || {
        service::check_saved(
            Format::Hwpx,
            &before,
            &after,
            Some(&report("hwpx", json!([]))),
            true,
        )
    });
    assert_eq!(
        result.findings,
        vec![
            Finding::at(FindingCode::LimitExceeded, "Contents/header.xml"),
            Finding::at(FindingCode::OriginalMalformed, "Contents/header.xml")
        ]
    );
    assert_eq!(pool.usage().0, 0);
}

#[test]
fn special_header_sibling_namespace_restoration_and_large_attributes() {
    let attrs = (0..512)
        .map(|i| format!(" a{i}=\"value{i}\""))
        .collect::<String>();
    let first = fmt_def(0, 1000, "")
        .replacen("height=", &format!("{attrs} height="), 1)
        .replace(
            "<hh:charPr",
            r#"<hh:charPr xmlns:l="http://www.hancom.co.kr/hwpml/2011/head""#,
        )
        .replace("hh:fontRef", "l:fontRef");
    let second = fmt_def(1, 1100, "").replace("<hh:charPr", r#"<hh:charPr xmlns:l="wrong-unused""#);
    let new = first
        .replace(r#"id="0""#, r#"id="2""#)
        .replace("<hh:shadow", "<hh:italic/><hh:shadow");
    let a = pkg(&hwpx_package(
        &fmt_body(&[0]),
        &fmt_header(2, &[&first, &second], &[], "JUSTIFY"),
        true,
        true,
    ));
    let b = pkg(&hwpx_package(
        &fmt_body(&[2]),
        &fmt_header(3, &[&first, &second], &[&new], "JUSTIFY"),
        true,
        true,
    ));
    assert!(package::compare_saved_hwpx(&a, &b).is_empty());
    assert_eq!(
        package::compare_saved_hwpx(&a, &b),
        package::special_legacy::compare_saved_hwpx(&a, &b)
    );
}

#[test]
#[ignore = "independent shared-pool concurrent real save probe"]
fn concurrent_save_resource_probe() {
    use crate::document::resources::{self, Category, Pool};
    use std::sync::Arc;
    let pool = Pool::limited(usize::MAX);
    let state = Arc::new(DocumentState::with_resource_pool(pool.clone()));
    let dir = TempDir::new();
    let large = std::env::var_os("GEUL_CONCURRENT_HEADER").is_some();
    let (format, extension, original, output) = if large {
        let (a, b) = large_header_pair(60000, 5535);
        (Format::Hwpx, "hwpx", a, b)
    } else {
        let a = hwp_doc(0, &docinfo(0, b"font"), &section("hello"), &[]);
        (Format::Hwp, "hwp", a.clone(), a)
    };
    let original = Arc::new(original);
    let output = Arc::new(output);
    let mut infos = Vec::new();
    for i in 0..4 {
        let info = rhwp_session(
            &state,
            &dir,
            &format!("concurrent-{i}.{extension}"),
            &original,
        );
        let preflight = service::preflight(
            format,
            &original,
            &original,
            Some(&report(extension, json!([]))),
        );
        assert!(preflight.is_safe());
        state
            .registry()
            .record_preflight(
                info.session_id,
                info.load_generation,
                crate::document::content_hash(&original),
                preflight,
            )
            .unwrap();
        state
            .registry()
            .commit(info.session_id, info.load_generation, 0, 1)
            .unwrap();
        infos.push(info);
    }
    let barrier = Arc::new(std::sync::Barrier::new(4));
    let reset = peak_reset();
    let start = std::time::Instant::now();
    std::thread::scope(|threads| {
        for info in &infos {
            let state = state.clone();
            let output = output.clone();
            let barrier = barrier.clone();
            let pool = pool.clone();
            threads.spawn(move || {
                resources::scope(pool.operation(), || {
                    // The service API borrows this caller-owned payload; explicitly account
                    // the retained request for this direct service (not Tauri IPC) probe.
                    resources::charge(Category::Payload, output.len()).unwrap();
                    barrier.wait();
                    let ticket = state
                        .registry()
                        .begin_save(info.session_id, info.load_generation, 1)
                        .unwrap();
                    let result = service::save(
                        state.registry(),
                        &ticket,
                        &Limits::default(),
                        &output,
                        Some(&report(extension, json!([]))),
                        true,
                    )
                    .unwrap();
                    assert!(!result.session.dirty);
                });
            });
        }
    });
    assert_eq!(pool.usage().0, 0);
    for i in 0..4 {
        assert_eq!(
            std::fs::read(dir.path().join(format!("concurrent-{i}.{extension}"))).unwrap(),
            *output
        );
    }
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 4);
    println!(
        "{}",
        json!({"operations":4,"fixtureBytes":original.len(),"largeHeader":large,"rss":peak_evidence(reset, peak_kib()),"ms":start.elapsed().as_secs_f64()*1000.0,
        "reservationPeakBytes":pool.usage().1,"releasedBytes":pool.usage().0,"outputBytesVerified":true,"dirtyCleared":true,
        "scope":"four direct real-service saves; caller payload deliberately accounted; not IPC throughput or RSS bound"})
    );
}
