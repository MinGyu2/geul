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

/// 문서 속성(tag 16, 26바이트: 구역 수·시작 번호·캐럿) + 글꼴(tag 19).
fn docinfo(caret: u32, font: &[u8]) -> Vec<u8> {
    let mut properties = vec![1, 0];
    properties.extend_from_slice(&[1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    properties.extend_from_slice(&0u32.to_le_bytes());
    properties.extend_from_slice(&0u32.to_le_bytes());
    properties.extend_from_slice(&caret.to_le_bytes());
    [record(16, 0, &properties), record(19, 1, font)].concat()
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

#[test]
fn 중단된_저장이_남긴_임시_파일은_지우거나_다시_쓰지_않고_원본만_바꾼다() {
    // 교체 전에 프로세스가 끝나면 `.geul-save-*.tmp`가 남을 수 있다(원본 그대로). 그 정리·복구는 T014이며, 다음 저장은 그 파일을
    // 지우거나 덮어쓰지 않는다(create_new + 새 이름).
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    // 다음에 만들 이름 몇 개를 미리 차지해 이름 충돌을 만든다(시험을 하나씩 실행하면 반드시 충돌한다).
    let next = super::publish::next_name_number();
    let name = |n: u64| format!(".geul-save-{}-{n}.tmp", std::process::id());
    for n in next..next + 4 {
        std::fs::write(doc.dir.path().join(name(n)), b"interrupted").unwrap();
    }
    let saved = doc.save().unwrap();
    assert!(!saved.session.dirty);
    assert_ne!(doc.bytes(), original);
    // 남은 것은 미리 둔 네 파일뿐이고 내용도 그대로다.
    let left = doc.leftovers();
    assert_eq!(left.len(), 4, "{left:?}");
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
    [record(16, 0, properties), record(19, 1, b"font")].concat()
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

#[test]
fn e_임시_파일을_만든_직후의_실패도_이_저장의_임시_파일만_지운다() {
    let original = basic::basic_ko().unwrap();
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    // 다음 이름 하나를 미리 차지한다(남의 파일·중단된 저장): 그 파일은 그대로, 이 저장이 만든 파일은 지운다.
    let taken = format!(
        ".geul-save-{}-{}.tmp",
        std::process::id(),
        super::publish::next_name_number()
    );
    std::fs::write(doc.dir.path().join(&taken), b"earlier").unwrap();
    assert_eq!(
        save_with_fault(&doc, Some(Fault::AfterCreate)).err(),
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
    // 출처: 고정 rhwp `serializer/hwpx/static_assets.rs`의 `PRV_IMAGE_PNG`·`PRV_TEXT`와 바이트가 같다(68바이트 1×1
    // 회색조+알파 투명, IDAT CRC와 zlib Adler-32가 틀림 — 실측). HWP 빈 글 미리보기는 blank2010 자산과 같다.
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../external/rhwp/src");
    let assets = std::fs::read_to_string(root.join("serializer/hwpx/static_assets.rs")).unwrap();
    let array = assets
        .split("pub const PRV_IMAGE_PNG: &[u8] = &[")
        .nth(1)
        .and_then(|rest| rest.split("];").next())
        .unwrap();
    let bytes: Vec<u8> = array
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter_map(|token| token.strip_prefix("0x"))
        .map(|hex| u8::from_str_radix(hex, 16).unwrap())
        .collect();
    assert_eq!(bytes, RHWP_BLANK_PREVIEW_PNG);
    assert!(assets.contains(r#"pub const PRV_TEXT: &[u8] = b"\r\n";"#));
    assert_eq!(RHWP_BLANK_PREVIEW_TEXT, b"\r\n");
    assert_eq!(
        std::fs::read(root.join("parser/hwpx/blank2010_assets/prvtext.bin")).unwrap(),
        utf16("\r\n")
    );
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
fn exchange(a: &Path, b: &Path) {
    let parked = a.with_extension("parked");
    std::fs::rename(a, &parked).unwrap();
    std::fs::rename(b, a).unwrap();
    std::fs::rename(&parked, b).unwrap();
}

/// 시험용 훅 자리(`publish`의 스레드 지역 값)와 거기 걸 훅들.
type HookSlot = &'static std::thread::LocalKey<std::cell::RefCell<Option<super::publish::Hook>>>;
type Hooks = Vec<(HookSlot, Box<dyn Fn(&Path, &Path)>)>;
/// 경합 사례: 이름, 공유 디렉터리를 받아 훅을 만드는 함수, 기대 오류.
type RaceCase = (&'static str, Box<dyn Fn(&Path) -> Hooks>, DocumentError);
/// 미리보기 운반체: 이름, 바이트, 그 바이트에서 비밀을 꺼내는 함수.
type Carrier = (&'static str, Vec<u8>, Box<dyn Fn(&[u8]) -> Vec<u8>>);

/// 시험용 훅을 걸고 저장한다(같은 스레드). 훅이 불린 횟수를 돌려준다.
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

/// 4차 안정화 A 다중 사용자 탐침(로컬, 기본 실행 안 함): 실제 다른 uid가 공유 상위 디렉터리(`GEUL_A4_SHARED`)의 `docs`·
/// `other` 항목을 계속 맞바꾸는 동안 `docs/a.docx`를 `GEUL_A4_ROUNDS`번 편집·저장하고 결과를 센다. 공격 쪽은 `GEUL_A4_READY`를
/// 기다려 시작하고 `GEUL_A4_STOP`이 생기면 원래 배치로 되돌린 뒤 `GEUL_A4_DONE`을 쓴다. 사용자 이름공간 실행 절차는
/// `docs/architecture/save-preservation.md`.
#[cfg(target_os = "linux")]
#[test]
#[ignore]
fn a4_다중_사용자_탐침() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let var = |name: &str| std::env::var(name).ok().map(std::path::PathBuf::from);
    let (Some(shared), Some(ready), Some(stop), Some(done)) = (
        var("GEUL_A4_SHARED"),
        var("GEUL_A4_READY"),
        var("GEUL_A4_STOP"),
        var("GEUL_A4_DONE"),
    ) else {
        eprintln!("GEUL_A4_* 없음");
        return;
    };
    let rounds: usize = std::env::var("GEUL_A4_ROUNDS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(200);
    let original = basic::basic_ko().unwrap();
    let (docs, other) = (shared.join("docs"), shared.join("other"));
    // 공유 디렉터리에 만들 권한이 없으면(믿는 쪽 소유 0755 등) 실행 절차가 미리 만들어 준다.
    std::fs::create_dir_all(&docs).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    std::fs::set_permissions(&docs, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::set_permissions(&other, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = docs.join("a.docx");
    std::fs::write(&path, &original).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let docs_ino = std::fs::metadata(&docs).unwrap().ino();
    let state = DocumentState::default();
    let file = identify(path.to_str().unwrap(), &Limits::default()).unwrap();
    let info = state.registry().register(file).unwrap();
    let mut info = block_on(docx::load(&state, info.session_id, None))
        .unwrap()
        .session;
    std::fs::write(&ready, b"").unwrap();
    let mut tally = std::collections::BTreeMap::<String, usize>::new();
    let mut last_saved = None;
    for _ in 0..rounds {
        info = block_on(docx::edit(
            &state,
            info.session_id,
            info.load_generation,
            info.revision,
            vec![DocxOp::InsertText { text: "a".into() }],
        ))
        .unwrap()
        .session;
        if let Err(error) = block_on(docx::preflight(
            &state,
            info.session_id,
            info.load_generation,
        )) {
            *tally.entry(format!("preflight {error:?}")).or_default() += 1;
            continue;
        }
        match block_on(docx::save(
            &state,
            info.session_id,
            info.load_generation,
            info.revision,
        )) {
            Ok(outcome) => {
                *tally
                    .entry(format!("ok durable={}", outcome.durable))
                    .or_default() += 1;
                info = outcome.session;
                let model = state
                    .wordcraft()
                    .get(info.session_id, info.load_generation)
                    .unwrap();
                last_saved = Some(model.lock().unwrap().export().unwrap());
            }
            Err(error) => *tally.entry(format!("{error:?}")).or_default() += 1,
        }
    }
    std::fs::write(&stop, b"").unwrap();
    for _ in 0..1000 {
        if done.exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let attacker = std::fs::read_to_string(&done).unwrap_or_default();
    // 디렉터리 객체로 판단한다(공격 쪽이 짝수 번 맞바꿔 원래 배치로 되돌렸어야 한다).
    let (real, wrong) = if std::fs::metadata(&docs).unwrap().ino() == docs_ino {
        (docs.clone(), other.clone())
    } else {
        (other.clone(), docs.clone())
    };
    let names = |dir: &Path| -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    };
    let real_bytes = std::fs::read(real.join("a.docx")).unwrap();
    eprintln!(
        "A4PROBE tally={tally:?} real_dir_entries={:?} wrong_dir_entries={:?} real_is_original={} real_is_last_saved={} attacker={attacker}",
        names(&real),
        names(&wrong),
        real_bytes == original,
        last_saved.as_deref() == Some(real_bytes.as_slice()),
    );
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
