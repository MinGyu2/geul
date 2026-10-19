//! ZIP+XML 패키지(HWPX·DOCX) 원본과 엔진 출력의 비교.
//!
//! 엔진은 패키지를 읽어 자기 모델로 바꾸고 다시 쓴다. WordCraft 판독기는 모르는 표시를 건너뛰고(`docx/src/lib.rs`),
//! 다시 내보내는 XML은 모르는 이름공간의 요소·속성을 버린다(`docx/src/xml.rs`). 그래서 열기·저장의 성공은 보존의
//! 근거가 아니며, 원본과 출력을 부분마다 비교한다:
//! - 항목 이름 집합(빠지거나 생긴 부분),
//! - XML 부분(이름이 `.xml`·`.rels`·`.hpf`로 끝나거나 내용이 XML 선언으로 시작): 정규화한 사건 열(`document::xml::
//!   canonical` — 이름공간 URI·지역 이름·정렬한 속성·문자 데이터, 접두사·속성 순서·XML 선언 무시)이 같은지,
//! - 그 밖의 부분: 압축을 푼 바이트가 같은지.
//!
//! 원본 XML을 끝까지 읽지 못하면(끊긴 본문 등) 비교하지 않고 판단 불가로 둔다(엔진이 끊긴 곳까지 읽어 여는 문서,
//! T008 J). ZIP은 형식 판별과 같은 판독기로 읽는다(로컬 헤더 대조·CRC·크기 상한·암호화 항목 거부).

use std::collections::BTreeMap;
use std::io::Cursor;

use crate::document::xml;
use crate::document::zip::{self, ZipLimits, ZipProblem};

use super::preserve::{Finding, FindingCode};
use super::preview;

/// 패키지 항목 수·이름·중앙 디렉터리·부분 하나·전체 압축 해제 상한.
const LIMITS: ZipLimits = ZipLimits {
    max_entries: 20_000,
    max_directory_bytes: 8 * 1024 * 1024,
    max_name_bytes: 4096,
};
const MAX_PART_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;

/// 읽어 둔 패키지: 항목 이름(중앙 디렉터리 순서)과 압축을 푼 내용, 압축 방식.
pub struct Package {
    pub order: Vec<String>,
    pub parts: BTreeMap<String, (u16, Vec<u8>)>,
}

impl Package {
    pub fn get(&self, name: &str) -> Option<&[u8]> {
        self.parts.get(name).map(|(_, data)| data.as_slice())
    }
}

/// 원본·출력 중 어느 쪽인지(근거 코드가 다르다).
#[derive(Clone, Copy)]
pub enum Side {
    Original,
    Output,
}

impl Side {
    pub fn malformed(self) -> FindingCode {
        match self {
            Side::Original => FindingCode::OriginalMalformed,
            Side::Output => FindingCode::OutputMalformed,
        }
    }
}

/// 패키지 전체를 상한 안에서 읽는다.
pub fn open(bytes: &[u8], side: Side) -> Result<Package, Finding> {
    let limit = |problem: ZipProblem| match problem {
        ZipProblem::EntryCount | ZipProblem::MetadataSize | ZipProblem::PartSize => {
            Finding::new(FindingCode::LimitExceeded)
        }
        ZipProblem::Encrypted | ZipProblem::UnsupportedMethod => {
            Finding::at(FindingCode::Unsupported, "container")
        }
        _ => Finding::at(side.malformed(), "container"),
    };
    let mut reader = Cursor::new(bytes);
    let archive = zip::read_directory(&mut reader, bytes.len() as u64, &LIMITS).map_err(limit)?;
    let mut package = Package {
        order: Vec::new(),
        parts: BTreeMap::new(),
    };
    let mut total = 0u64;
    for entry in archive.entries() {
        let name = String::from_utf8(entry.name().to_vec())
            .map_err(|_| Finding::at(side.malformed(), "container"))?;
        if name.ends_with('/') {
            continue; // 디렉터리 항목
        }
        total = total.saturating_add(entry.uncompressed_size());
        if total > MAX_TOTAL_BYTES {
            return Err(Finding::new(FindingCode::LimitExceeded));
        }
        let data =
            archive
                .read(&mut reader, entry, MAX_PART_BYTES)
                .map_err(|problem| match problem {
                    ZipProblem::PartSize => Finding::at(FindingCode::LimitExceeded, &name),
                    ZipProblem::Encrypted | ZipProblem::UnsupportedMethod => {
                        Finding::at(FindingCode::Unsupported, &name)
                    }
                    _ => Finding::at(side.malformed(), &name),
                })?;
        package.order.push(name.clone());
        package.parts.insert(name, (entry.method(), data));
    }
    Ok(package)
}

/// XML로 비교할 부분인지.
pub fn is_xml(name: &str, data: &[u8]) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".xml")
        || lower.ends_with(".rels")
        || lower.ends_with(".hpf")
        || data.starts_with(b"<?xml")
        || data.starts_with(b"\xEF\xBB\xBF<?xml")
}

/// 부분 하나를 비교한다(같으면 None).
fn compare_part(name: &str, before: &[u8], after: &[u8]) -> Option<Finding> {
    if before == after {
        return None;
    }
    if !is_xml(name, before) {
        return Some(Finding::at(FindingCode::PartChanged, name));
    }
    let Ok(before) = xml::canonical(before) else {
        return Some(Finding::at(FindingCode::OriginalMalformed, name));
    };
    let Ok(after) = xml::canonical(after) else {
        return Some(Finding::at(FindingCode::OutputMalformed, name));
    };
    (before != after).then(|| Finding::at(FindingCode::PartChanged, name))
}

/// 원본과 엔진 출력(같은 형식)을 비교한 근거. `skip`의 부분은 비교하지 않는다(편집한 저장에서 본문처럼 바뀌어야
/// 하는 부분 — 그 부분은 엔진 다시 읽기로 따로 확인한다). 비어 있으면 같다.
pub fn compare(original: &Package, output: &Package, skip: &dyn Fn(&str) -> bool) -> Vec<Finding> {
    let mut findings = Vec::new();
    for name in output.parts.keys() {
        if !original.parts.contains_key(name) {
            findings.push(Finding::at(FindingCode::PartAdded, name));
        }
    }
    for (name, (_, before)) in &original.parts {
        let Some((_, after)) = output.parts.get(name) else {
            findings.push(Finding::at(FindingCode::PartMissing, name));
            continue;
        };
        if skip(name) {
            continue;
        }
        if let Some(finding) = compare_part(name, before, after) {
            findings.push(finding);
        }
    }
    findings
}

/// 원본의 XML 부분을 모두 끝까지 읽을 수 있는지(끊긴 본문 XML을 엔진이 일부만 읽어 여는 문서를 가려낸다).
pub fn malformed_xml(package: &Package, side: Side) -> Vec<Finding> {
    package
        .parts
        .iter()
        .filter(|(name, (_, data))| is_xml(name, data) && xml::canonical(data).is_err())
        .map(|(name, _)| Finding::at(side.malformed(), name))
        .collect()
}

// ---- 저장 출력 검사 ----

const CONTENT_TYPES: &str = "[Content_Types].xml";
const EXTENDED_PROPERTIES: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
/// `docProps/app.xml`에서 문서에서 계산하는 통계(편집하면 바뀌어야 한다). WordCraft는 `Words`·`Paragraphs`를 쓴다.
const STATISTICS: [&str; 7] = [
    "Pages",
    "Words",
    "Characters",
    "CharactersWithSpaces",
    "Lines",
    "Paragraphs",
    "TotalTime",
];
const HWPX_MIMETYPE: &[u8] = b"application/hwp+zip";
const OPF: [&str; 2] = [
    "http://www.idpf.org/2007/opf/",
    "http://www.idpf.org/2007/opf",
];

/// 관계 대상(상대 경로)을 원본 부분 기준으로 푼다. 패키지 밖으로 나가거나 이상한 이름이면 None.
fn resolve(source: &str, target: &str) -> Option<String> {
    let mut parts: Vec<&str> = if target.starts_with('/') {
        Vec::new()
    } else {
        // `_rels/x.rels`의 원본 부분은 `x`(`word/_rels/document.xml.rels` → `word/document.xml`): 원본 디렉터리 기준.
        let dir = source.rsplit_once("_rels/").map_or("", |(dir, _)| dir);
        dir.split('/').filter(|part| !part.is_empty()).collect()
    };
    let target = target.split(['#', '?']).next()?;
    for segment in target.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            name => parts.push(name),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// OPC 부분 이름 비교(대소문자 무시)로 있는지.
fn has_part(package: &Package, name: &str) -> bool {
    package
        .parts
        .keys()
        .any(|part| part.eq_ignore_ascii_case(name))
}

/// DOCX(OPC) 출력 무결성: 내용 형식이 모든 부분을 덮고, 관계 항목이 올바르며 내부 대상이 있고, XML 부분을 모두 끝까지
/// 읽을 수 있다. 형식 판별(본문 부분·패키지 관계)은 따로 한다.
pub fn validate_docx(package: &Package) -> Vec<Finding> {
    let mut findings = malformed_xml(package, Side::Output);
    let Some(types) = package
        .get(CONTENT_TYPES)
        .and_then(|bytes| xml::content_types(bytes).ok())
    else {
        findings.push(Finding::at(FindingCode::PackageInvalid, CONTENT_TYPES));
        return findings;
    };
    for name in package.parts.keys() {
        if name == CONTENT_TYPES {
            continue;
        }
        if types.of(&format!("/{name}")).is_none() {
            findings.push(Finding::at(FindingCode::PackageInvalid, name));
        }
        if name.ends_with(".rels") {
            let Ok(relationships) = xml::relationships(package.get(name).unwrap_or_default())
            else {
                findings.push(Finding::at(FindingCode::PackageInvalid, name));
                continue;
            };
            for relationship in relationships.iter().filter(|r| !r.external) {
                if !resolve(name, &relationship.target)
                    .is_some_and(|target| has_part(package, &target))
                {
                    findings.push(Finding::at(FindingCode::PackageInvalid, name));
                    break;
                }
            }
        }
    }
    findings
}

/// HWPX 출력 무결성: 첫 항목이 압축하지 않은 `mimetype`(원본도 그랬다면), XML 부분을 모두 끝까지 읽을 수 있고,
/// `Contents/content.hpf`의 manifest 항목(`item href`)이 패키지에 있다.
pub fn validate_hwpx(original: &Package, output: &Package) -> Vec<Finding> {
    let mut findings = malformed_xml(output, Side::Output);
    if original.order.first().map(String::as_str) == Some("mimetype") {
        let first = output.order.first().map(String::as_str) == Some("mimetype");
        let stored = output
            .parts
            .get("mimetype")
            .is_some_and(|(method, data)| *method == 0 && data == HWPX_MIMETYPE);
        if !first || !stored {
            findings.push(Finding::at(FindingCode::PackageInvalid, "mimetype"));
        }
    }
    let Some(manifest) = output
        .get("Contents/content.hpf")
        .and_then(|bytes| xml::canonical(bytes).ok())
    else {
        findings.push(Finding::at(
            FindingCode::PackageInvalid,
            "Contents/content.hpf",
        ));
        return findings;
    };
    for event in &manifest {
        let xml::Canonical::Start {
            namespace: Some(namespace),
            name,
            attributes,
        } = event
        else {
            continue;
        };
        if name != "item" || !OPF.contains(&namespace.as_str()) {
            continue;
        }
        let href = attributes
            .iter()
            .find(|(ns, key, _)| ns.is_none() && key == "href")
            .map(|(_, _, value)| value.as_str());
        // HWPX manifest의 href는 패키지 뿌리 기준이다(한컴·rhwp). content.hpf 기준 상대 경로도 받아 준다.
        let present = href.is_some_and(|href| {
            has_part(output, href)
                || resolve("Contents/_rels/content.hpf", href).is_some_and(|p| has_part(output, &p))
        });
        if !present {
            findings.push(Finding::at(
                FindingCode::PackageInvalid,
                "Contents/content.hpf",
            ));
            break;
        }
    }
    findings
}

/// `docProps/app.xml`이 통계 값만 다른지(정규화한 사건 열이 같고, 다른 문자 데이터는 통계 요소 안에만 있다).
fn same_except_statistics(before: &[u8], after: &[u8]) -> Option<bool> {
    let (before, after) = (xml::canonical(before).ok()?, xml::canonical(after).ok()?);
    if before.len() != after.len() {
        return Some(false);
    }
    let mut stack: Vec<(Option<&str>, &str)> = Vec::new();
    for (a, b) in before.iter().zip(&after) {
        match (a, b) {
            (
                xml::Canonical::Start {
                    namespace, name, ..
                },
                _,
            ) if a == b => stack.push((namespace.as_deref(), name.as_str())),
            (xml::Canonical::End, xml::Canonical::End) => {
                stack.pop();
            }
            (xml::Canonical::Text(_), xml::Canonical::Text(_)) if a != b => {
                let statistic = stack.last().is_some_and(|(namespace, name)| {
                    *namespace == Some(EXTENDED_PROPERTIES) && STATISTICS.contains(name)
                });
                if !statistic {
                    return Some(false);
                }
            }
            _ if a == b => {}
            _ => return Some(false),
        }
    }
    Some(true)
}

/// HWPX 본문 부분(`Contents/section<N>.xml`): 편집이 바꾸는 부분이며 엔진 다시 열기가 확인한다.
pub fn hwpx_body(name: &str) -> bool {
    // 고정 rhwp가 쓰는 이름 `Contents/section{i}.xml`만(0으로 시작하는 번호 등은 본문으로 면제하지 않는다, T009 3차 안정화).
    name.strip_prefix("Contents/section")
        .and_then(|rest| rest.strip_suffix(".xml"))
        .is_some_and(super::hwp::canonical_number)
}

/// DOCX 편집 저장 비교: `word/document.xml`(본문, 엔진 다시 읽기가 확인)을 빼고 원본과 같아야 하며, `docProps/app.xml`은
/// 통계 값만 다를 수 있다.
pub fn compare_saved_docx(original: &Package, output: &Package) -> Vec<Finding> {
    const BODY: &str = "word/document.xml";
    const APP: &str = "docProps/app.xml";
    let mut findings = compare(original, output, &|name| name == BODY || name == APP);
    if let (Some(before), Some(after)) = (original.get(APP), output.get(APP)) {
        if before != after && same_except_statistics(before, after) != Some(true) {
            findings.push(Finding::at(FindingCode::PartChanged, APP));
        }
    }
    // 본문을 바꿨는데 원본 썸네일이 그대로 남으면 편집 전 내용이 보인다. 그림 내용이 없음을 증명할 수 없으므로(JPEG·EMF
    // 등) 썸네일이 있으면 막는다.
    if original.get(BODY) != output.get(BODY) {
        for name in thumbnails(original) {
            if output
                .get(&name)
                .is_some_and(|data| original.get(&name) == Some(data))
            {
                findings.push(Finding::at(FindingCode::PreviewStale, &name));
            }
        }
    }
    findings
}

/// DOCX 썸네일 부분: 패키지 관계(`_rels/.rels`)의 thumbnail 대상과 관례 이름 `docProps/thumbnail.*`.
fn thumbnails(package: &Package) -> Vec<String> {
    const THUMBNAIL: &str = "/metadata/thumbnail";
    let mut names: Vec<String> = package
        .parts
        .keys()
        .filter(|name| name.starts_with("docProps/thumbnail"))
        .cloned()
        .collect();
    if let Some(relationships) = package
        .get("_rels/.rels")
        .and_then(|bytes| xml::relationships(bytes).ok())
    {
        for relationship in relationships {
            if !relationship.external && relationship.kind.ends_with(THUMBNAIL) {
                if let Some(target) = resolve("_rels/.rels", &relationship.target) {
                    if package.parts.contains_key(&target) && !names.contains(&target) {
                        names.push(target);
                    }
                }
            }
        }
    }
    names
}

/// HWPX 편집 저장 비교: 본문 부분을 빼고 원본과 같아야 한다. 본문을 바꿨다면 원본 그대로 남는 `Preview/*`는 내용이
/// 없음을 증명해야 한다(빈 글 미리보기, 한 색 PNG). 그 밖의 미리보기 부분은 증명할 수 없어 막는다.
pub fn compare_saved_hwpx(original: &Package, output: &Package) -> Vec<Finding> {
    let mut findings = compare(original, output, &hwpx_body);
    let body = |package: &Package| -> Vec<(String, Vec<u8>)> {
        package
            .parts
            .iter()
            .filter(|(name, _)| hwpx_body(name))
            .map(|(name, (_, data))| (name.clone(), data.clone()))
            .collect()
    };
    if body(original) != body(output) {
        for (name, (_, data)) in &original.parts {
            if !name.starts_with("Preview/") || output.get(name) != Some(data.as_slice()) {
                continue;
            }
            let empty = match name.as_str() {
                "Preview/PrvText.txt" => preview::blank_utf8(data),
                "Preview/PrvImage.png" => preview::uniform_png(data),
                _ => false,
            };
            if !empty {
                findings.push(Finding::at(FindingCode::PreviewStale, name));
            }
        }
    }
    findings
}
