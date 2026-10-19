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
    // 압축 플래그만 다른 출력(레코드·데이터는 같음)도 같다.
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
        vec![Finding::at(FindingCode::PartChanged, "FileHeader")],
        "FileHeader 플래그가 다르면 다르다"
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
    let state = DocumentState::default();
    let dir = TempDir::new();
    let path = dir.write("a.docx", bytes);
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
    /// 디렉터리에 남은 임시 파일(저장 실패 뒤 없어야 한다).
    fn leftovers(&self) -> Vec<String> {
        std::fs::read_dir(self.dir.path())
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
            Ok((identity.clone(), *fingerprint))
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
        Ok((identity.clone(), *fingerprint))
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
    // 하드 링크가 둘인 파일.
    let mut doc = open_docx(&original);
    doc.edit(edits());
    doc.preflight().unwrap();
    std::fs::hard_link(&doc.path, doc.dir.path().join("other.docx")).unwrap();
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
