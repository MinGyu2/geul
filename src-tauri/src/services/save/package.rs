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

fn resource_code(epoch: usize, otherwise: FindingCode) -> FindingCode {
    if crate::document::resources::failure_epoch() != epoch {
        FindingCode::LimitExceeded
    } else {
        otherwise
    }
}

/// 부분 하나를 비교한다(같으면 None).
fn compare_part(name: &str, before: &[u8], after: &[u8]) -> Option<Finding> {
    if before == after {
        return None;
    }
    if !is_xml(name, before) {
        return Some(Finding::at(FindingCode::PartChanged, name));
    }
    match xml::canonical_equal(before, after) {
        Ok(true) => None,
        Ok(false) => Some(Finding::at(FindingCode::PartChanged, name)),
        Err(_) => {
            let original = xml::canonical_checked(before);
            let output = xml::canonical_checked(after);
            let code = match (original, output) {
                (Err(xml::CanonicalFailure::Invalid), _) => FindingCode::OriginalMalformed,
                (Err(_), _) => FindingCode::LimitExceeded,
                (_, Err(xml::CanonicalFailure::Invalid)) => FindingCode::OutputMalformed,
                _ => FindingCode::LimitExceeded,
            };
            Some(Finding::at(code, name))
        }
    }
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
        .filter(|(name, (_, data))| is_xml(name, data))
        .filter_map(|(name, (_, data))| match xml::canonical_checked(data) {
            Ok(()) => None,
            Err(xml::CanonicalFailure::Invalid) => Some(Finding::at(side.malformed(), name)),
            Err(_) => Some(Finding::at(FindingCode::LimitExceeded, name)),
        })
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
    let epoch = crate::document::resources::failure_epoch();
    let Some(types) = package
        .get(CONTENT_TYPES)
        .and_then(|bytes| xml::content_types(bytes).ok())
    else {
        findings.push(Finding::at(
            resource_code(epoch, FindingCode::PackageInvalid),
            CONTENT_TYPES,
        ));
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
            let epoch = crate::document::resources::failure_epoch();
            let Ok(relationships) = xml::relationships(package.get(name).unwrap_or_default())
            else {
                findings.push(Finding::at(
                    resource_code(epoch, FindingCode::PackageInvalid),
                    name,
                ));
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
    let epoch = crate::document::resources::failure_epoch();
    let Some(manifest) = output
        .get("Contents/content.hpf")
        .and_then(|bytes| xml::canonical(bytes).ok())
    else {
        findings.push(Finding::at(
            resource_code(epoch, FindingCode::PackageInvalid),
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
pub(super) fn same_except_statistics(before: &[u8], after: &[u8]) -> Option<bool> {
    xml::canonical_equal_except_text(before, after, |namespace, name| {
        namespace == Some(EXTENDED_PROPERTIES) && STATISTICS.contains(&name)
    })
    .ok()
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
    // T013 메모·각주·미주: 원본에 없던 덧붙일 수 있는 부분(메모 부분, 각주·미주 부분)을 엔진이 새로 만들었고 패키지 목록·관계(각주·
    // 미주면 settings의 구분선 참조 두 개도)는 정확히 그 덧붙임뿐일 때만, 그 부분과 목록들을 엔진 다시 읽기(모델 비교)가 확인하는 편집
    // 부분으로 본다(`parts_added`, `note_settings_added`). 아니면 지금처럼 부분마다 비교한다.
    let added = parts_added(original, output).filter(|added| {
        let notes: Vec<&str> = added
            .iter()
            .map(|(part, ..)| *part)
            .filter(|part| NOTE_PARTS.iter().any(|(note, ..)| note == part))
            .collect();
        notes.is_empty() || note_settings_added(original, output, &notes)
    });
    let notes_added = added.as_ref().is_some_and(|added| {
        added
            .iter()
            .any(|(part, ..)| NOTE_PARTS.iter().any(|(note, ..)| note == part))
    });
    let appended = added.is_none() && comment_parts_appended(original, output);
    // 원본에 이미 있던 각주·미주 부분: 구분선 그대로, 원본 각주는 번호(`w:id`)만 다시 매겨질 수 있고 순서·내용 그대로, 새 각주만 더함.
    let extended: Vec<&str> = NOTE_PARTS
        .iter()
        .zip(NOTE_CHILDREN)
        .filter_map(|((part, ..), child)| {
            let (before, after) = (original.get(part)?, output.get(part)?);
            (before != after && note_part_extended(before, after, child)).then_some(*part)
        })
        .collect();
    let mut findings = compare(original, output, &|name| {
        name == BODY
            || name == APP
            || (added.is_some() && (name == CONTENT_TYPES || name == DOCUMENT_RELS))
            || (notes_added && name == SETTINGS)
            || (appended && COMMENT_PARTS.iter().any(|(part, ..)| *part == name))
            || extended.contains(&name)
    });
    if let Some(added) = &added {
        findings.retain(|finding| {
            !(finding.code == FindingCode::PartAdded
                && finding
                    .part
                    .as_deref()
                    .is_some_and(|part| added.iter().any(|(name, ..)| *name == part)))
        });
    }
    if let (Some(before), Some(after)) = (original.get(APP), output.get(APP)) {
        if before != after {
            let epoch = crate::document::resources::failure_epoch();
            if same_except_statistics(before, after) != Some(true) {
                findings.push(Finding::at(
                    resource_code(epoch, FindingCode::PartChanged),
                    APP,
                ));
            }
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

/// 본문 관계 항목.
const DOCUMENT_RELS: &str = "word/_rels/document.xml.rels";
const OPC_CONTENT_TYPES: &str = "http://schemas.openxmlformats.org/package/2006/content-types";
const OPC_RELATIONSHIPS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
/// WordCraft가 새 메모에 만드는 부분(실측 2026-11-05, 고정 WordCraft `fc41918…`): (부분, 본문 관계 대상, 관계 형식, 내용 형식).
const COMMENT_PARTS: [(&str, &str, &str, &str); 2] = [
    (
        "word/comments.xml",
        "comments.xml",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
    ),
    (
        "word/commentsExtended.xml",
        "commentsExtended.xml",
        "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml",
    ),
];

/// 문서 설정 부분.
const SETTINGS: &str = "word/settings.xml";
/// WordprocessingML 이름공간.
const WML: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
/// WordCraft가 첫 각주·미주에 만드는 부분(실측 2026-11-05, WordCraft `42e8a67` + 구분선 읽기 수정): (부분, 본문 관계 대상, 관계 형식,
/// 내용 형식). `COMMENT_PARTS`와 같은 모양.
const NOTE_PARTS: [(&str, &str, &str, &str); 2] = [
    (
        "word/footnotes.xml",
        "footnotes.xml",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",
    ),
    (
        "word/endnotes.xml",
        "endnotes.xml",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml",
    ),
];
/// 각주·미주 부분의 자식 지역 이름이자 settings의 구분선 참조 이름. `NOTE_PARTS`와 같은 순서.
const NOTE_CHILDREN: [&str; 2] = ["footnote", "endnote"];
/// settings에서 구분선 참조를 담는 요소. `NOTE_PARTS`와 같은 순서.
const NOTE_SETTINGS: [&str; 2] = ["footnotePr", "endnotePr"];

/// 속성 목록 하나(이름순 (이름, 값)).
type Attrs = Vec<(String, String)>;
/// 평평한 목록 부분: 뿌리 사건과 자식들의 속성 목록.
type FlatList = (xml::Canonical, Vec<Attrs>);

/// 정규화한 사건 열이 `뿌리(ns, 이름) → 내용 없는 자식(ns, 이름)들 → 끝`이면 뿌리 사건과 자식 속성 목록(`skip` 속성을 뺀 것, 정렬)을
/// 돌려준다. 글·주석·다른 깊이의 요소가 있으면 None(이 규칙을 쓰지 않음).
fn flat_children(
    bytes: &[u8],
    namespace: &str,
    root: &str,
    child: &str,
    skip: &str,
) -> Option<FlatList> {
    // This exception retains relationship metadata only. Bound its canonical
    // payload to 4 MiB (thousands of ordinary OPC relationships); refuse larger
    // exceptions rather than permitting an unbounded retained representation.
    let events = if namespace == OPC_RELATIONSHIPS {
        xml::canonical_with_payload_limit(bytes, Some(4 * 1024 * 1024))
            .map(|(events, _)| events)
            .map_err(|error| {
                if error != xml::CanonicalFailure::Invalid {
                    crate::document::resources::allocation_refused();
                }
            })
            .ok()?
    } else {
        xml::canonical(bytes).ok()?
    };
    let mut iter = events.into_iter();
    let first = iter.next()?;
    if !matches!(&first, xml::Canonical::Start { namespace: Some(ns), name, .. } if *ns == namespace && *name == root)
    {
        return None;
    }
    let mut children = Vec::new();
    loop {
        match iter.next()? {
            xml::Canonical::End => break,
            xml::Canonical::Start {
                namespace: Some(ns),
                name,
                attributes,
            } if ns == namespace && name == child => {
                if iter.next()? != xml::Canonical::End {
                    return None;
                }
                let mut attrs = Vec::with_capacity(attributes.len());
                for (ns, key, value) in attributes {
                    if ns.is_some() {
                        return None;
                    }
                    if key != skip {
                        attrs.push((key.to_string(), value.to_string()));
                    }
                }
                attrs.sort();
                children.push(attrs);
            }
            _ => return None,
        }
    }
    iter.next().is_none().then_some((first, children))
}

/// `after`가 `before`(순서 무관 목록)에 `added`를 더한 것과 정확히 같은지(여러 벌도 개수까지).
fn multiset_plus(
    before: &[Vec<(String, String)>],
    after: &[Vec<(String, String)>],
    added: &[Vec<(String, String)>],
) -> bool {
    let mut want: Vec<&Vec<(String, String)>> = before.iter().chain(added).collect();
    let mut have: Vec<&Vec<(String, String)>> = after.iter().collect();
    want.sort();
    have.sort();
    want == have
}

// Only document.xml is exempt from ordinary part comparison. Header/footer XML
// and their source-owned .rels remain protected by compare_saved_docx.
fn comment_reference_bindings_equal(
    original: &Package,
    output: &Package,
    before: &[Attrs],
    after: &[Attrs],
) -> Option<bool> {
    fn index(relations: &[Attrs]) -> Option<Vec<(&str, &Attrs)>> {
        crate::document::resources::charge(
            crate::document::resources::Category::Comparison,
            relations
                .len()
                .checked_mul(std::mem::size_of::<(&str, &Attrs)>())?,
        )
        .ok()?;
        let mut ids = Vec::new();
        ids.try_reserve_exact(relations.len())
            .map_err(|_| crate::document::resources::allocation_refused())
            .ok()?;
        for attrs in relations {
            let id = attrs.iter().find(|(key, _)| key == "Id")?.1.as_str();
            if id.is_empty() {
                return None;
            }
            ids.push((id, attrs));
        }
        ids.sort_unstable_by_key(|(id, _)| *id);
        if ids.windows(2).any(|pair| pair[0].0 == pair[1].0) {
            return None;
        }
        Some(ids)
    }
    let a = index(before)?;
    let b = index(after)?;
    let lookup =
        |ids: &[(&str, &Attrs)], id: &str| ids.binary_search_by_key(&id, |(key, _)| *key).ok();
    xml::relationship_references_equal(
        original.get("word/document.xml")?,
        output.get("word/document.xml")?,
        |left, right| {
            let (Some(i), Some(j)) = (lookup(&a, left), lookup(&b, right)) else {
                return false;
            };
            a[i].1
                .iter()
                .filter(|(key, _)| key != "Id")
                .eq(b[j].1.iter().filter(|(key, _)| key != "Id"))
        },
    )
    .ok()
}

/// T013: 편집 저장 출력이 원본에 **메모 부분을 새로 더한 것뿐**인지. 모두 성립해야 한다.
/// - 원본에는 `COMMENT_PARTS`가 하나도 없고(대소문자 무시), 출력에 새로 생긴 부분은 `COMMENT_PARTS`의 부분뿐(하나 이상),
/// - `[Content_Types].xml`: 뿌리가 같고, 출력 자식 = 원본 자식(순서 무관) + 새 메모 부분마다 그 내용 형식의 `Override` 하나,
/// - `word/_rels/document.xml.rels`: 뿌리가 같고, `Id`를 뺀 출력 관계 = 원본 관계(순서 무관) + 새 메모 부분마다 `Type`·`Target`이 그
///   부분인 내부 관계 하나(`TargetMode` 없음). WordCraft는 관계 `Id`를 다시 매기므로(실측: 메모 관계가 rId1, styles가 rId1→rId3)
///   번호 변경은 본문 XML의 모든 r:* 참조가 같은 관계 속성으로 연결되는 경우만 허용한다.
///
/// 메모 부분 내용(메모 글·작성자·날짜·완료 표시)은 엔진 모델의 일부라 다시 읽기 비교가 확인한다. 원본에 메모가 이미 있으면 이
/// 규칙을 쓰지 않는다(기존 메모 부분이 바뀌면 지금처럼 partChanged).
pub fn comment_parts_added(original: &Package, output: &Package) -> bool {
    parts_added(original, output).is_some_and(|added| {
        added
            .iter()
            .all(|part| COMMENT_PARTS.iter().any(|comment| comment == *part))
    })
}

/// 덧붙일 수 있는 부분 하나: (부분, 본문 관계 대상, 관계 형식, 내용 형식).
type Addable = (&'static str, &'static str, &'static str, &'static str);

/// `comment_parts_added`의 일반형: 메모 부분(원본에 메모 부분이 하나도 없을 때)과 각주·미주 부분(원본에 그 부분이 없을 때) 가운데
/// 출력에 새로 생긴 것들(하나 이상)만 더했고, 내용 형식 목록·본문 관계가 정확히 그 덧붙임뿐이면 그 부분들. 규칙은 위와 같다.
/// 각주·미주를 더했으면 호출하는 쪽이 `note_settings_added`도 확인한다.
fn parts_added(original: &Package, output: &Package) -> Option<Vec<&'static Addable>> {
    let present = |package: &Package, name: &str| has_part(package, name);
    let comments_absent = !COMMENT_PARTS
        .iter()
        .any(|(name, ..)| present(original, name));
    let added: Vec<&String> = output
        .parts
        .keys()
        .filter(|name| !original.parts.contains_key(*name))
        .collect();
    let comment_added: Vec<&'static Addable> = COMMENT_PARTS
        .iter()
        .filter(|_| comments_absent)
        .chain(
            NOTE_PARTS
                .iter()
                .filter(|(name, ..)| !present(original, name)),
        )
        .filter(|(name, ..)| output.parts.contains_key(*name))
        .collect();
    if comment_added.is_empty()
        || added.len() != comment_added.len()
        || !added.iter().all(|name| {
            comment_added
                .iter()
                .any(|(part, ..)| *part == name.as_str())
        })
    {
        return None;
    }
    let pair = |name: &str| Some((original.get(name)?, output.get(name)?));
    let (types_before, types_after) = pair(CONTENT_TYPES)?;
    let (rels_before, rels_after) = pair(DOCUMENT_RELS)?;
    // 내용 형식 목록은 `Default`와 `Override`가 섞이므로 자식 이름까지 속성처럼 담아 비교한다.
    let typed = |bytes: &[u8]| -> Option<FlatList> {
        let events = xml::canonical(bytes).ok()?;
        let mut iter = events.into_iter();
        let first = iter.next()?;
        if !matches!(&first, xml::Canonical::Start { namespace: Some(ns), name, .. } if *ns == OPC_CONTENT_TYPES && *name == "Types")
        {
            return None;
        }
        let mut children = Vec::new();
        loop {
            match iter.next()? {
                xml::Canonical::End => break,
                xml::Canonical::Start {
                    namespace: Some(ns),
                    name,
                    attributes,
                } if ns == OPC_CONTENT_TYPES && (name == "Default" || name == "Override") => {
                    if iter.next()? != xml::Canonical::End {
                        return None;
                    }
                    let mut attrs = vec![("".to_owned(), name.to_string())];
                    for (ns, key, value) in attributes {
                        if ns.is_some() {
                            return None;
                        }
                        attrs.push((key.to_string(), value.to_string()));
                    }
                    attrs.sort();
                    children.push(attrs);
                }
                _ => return None,
            }
        }
        iter.next().is_none().then_some((first, children))
    };
    let (Some((root_a, kids_a)), Some((root_b, kids_b))) =
        (typed(types_before), typed(types_after))
    else {
        return None;
    };
    let overrides: Vec<Vec<(String, String)>> = comment_added
        .iter()
        .map(|(part, _, _, content)| {
            let mut attrs = vec![
                ("".to_owned(), "Override".to_owned()),
                ("ContentType".to_owned(), (*content).to_owned()),
                ("PartName".to_owned(), format!("/{part}")),
            ];
            attrs.sort();
            attrs
        })
        .collect();
    if root_a != root_b || !multiset_plus(&kids_a, &kids_b, &overrides) {
        return None;
    }
    let (Some((root_a, mut rels_a)), Some((root_b, mut rels_b))) = (
        flat_children(
            rels_before,
            OPC_RELATIONSHIPS,
            "Relationships",
            "Relationship",
            "",
        ),
        flat_children(
            rels_after,
            OPC_RELATIONSHIPS,
            "Relationships",
            "Relationship",
            "",
        ),
    ) else {
        return None;
    };
    let bindings_equal = comment_reference_bindings_equal(original, output, &rels_a, &rels_b);
    for attrs in rels_a.iter_mut().chain(rels_b.iter_mut()) {
        attrs.retain(|(key, _)| key != "Id");
    }
    let relations: Vec<Vec<(String, String)>> = comment_added
        .iter()
        .map(|(_, target, kind, _)| {
            let mut attrs = vec![
                ("Target".to_owned(), (*target).to_owned()),
                ("Type".to_owned(), (*kind).to_owned()),
            ];
            attrs.sort();
            attrs
        })
        .collect();
    (root_a == root_b
        && multiset_plus(&rels_a, &rels_b, &relations)
        && bindings_equal == Some(true))
    .then_some(comment_added)
}

/// 메모 부분마다 덧붙일 수 있는 자식(이름공간, 지역 이름). `COMMENT_PARTS`와 같은 순서.
const COMMENT_CHILDREN: [(&str, &str); 2] = [
    (
        "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
        "comment",
    ),
    (
        "http://schemas.microsoft.com/office/word/2012/wordml",
        "commentEx",
    ),
];

/// T013: 원본에 이미 있던 메모 부분에 **새 메모만 끝에 덧붙인** 출력인지. 모두 성립해야 한다: 출력에 새로 생긴 부분이 없고(그
/// 경우는 `comment_parts_added`), 원본에 있는 메모 부분은 출력에도 있고, 바뀐 메모 부분이 하나 이상이며, 바뀐 부분마다 정규화한
/// 사건 열이 `원본 사건(마지막 뿌리 끝 전까지) + 완결된 자식 요소 하나 이상(그 부분의 메모 요소, COMMENT_CHILDREN) + 뿌리 끝`이다.
/// 원본 메모의 내용·순서·속성은 그대로여야 한다(편집하지 않은 원본 왕복이 같다는 사전 검사가 먼저다). 덧붙인 메모의 내용은 엔진
/// 다시 읽기가 모델로 확인한다. 목록·관계 부분은 바뀌면 안 된다(부분마다 비교에 남음).
pub fn comment_parts_appended(original: &Package, output: &Package) -> bool {
    if output
        .parts
        .keys()
        .any(|name| !original.parts.contains_key(name))
    {
        return false;
    }
    let mut changed = 0usize;
    for ((name, ..), (namespace, local)) in COMMENT_PARTS.iter().zip(COMMENT_CHILDREN) {
        let (before, after) = match (original.get(name), output.get(name)) {
            (None, None) => continue,
            (Some(before), Some(after)) => (before, after),
            _ => return false,
        };
        if before == after {
            continue;
        }
        let (Ok(a), Ok(b)) = (xml::canonical(before), xml::canonical(after)) else {
            return false;
        };
        if a.len() < 2
            || b.len() <= a.len()
            || a.last() != Some(&xml::Canonical::End)
            || b.last() != Some(&xml::Canonical::End)
        {
            return false;
        }
        let keep = a.len() - 1;
        if a.get(..keep) != b.get(..keep) {
            return false;
        }
        let Some(extra) = b.get(keep..b.len() - 1) else {
            return false;
        };
        let mut depth = 0usize;
        for event in extra {
            match event {
                xml::Canonical::Start {
                    namespace: ns,
                    name,
                    ..
                } => {
                    if depth == 0 && !(ns.as_deref() == Some(namespace) && *name == local) {
                        return false;
                    }
                    depth += 1;
                }
                xml::Canonical::End => {
                    let Some(next) = depth.checked_sub(1) else {
                        return false;
                    };
                    depth = next;
                }
                _ if depth == 0 => return false,
                _ => {}
            }
        }
        if depth != 0 || extra.is_empty() {
            return false;
        }
        changed += 1;
    }
    changed > 0
}

/// T013 각주·미주: 출력 settings가 원본 settings에, 새로 더한 각주·미주 부분(`notes`)마다 그 설정 요소(`w:footnotePr`·
/// `w:endnotePr`, 뿌리 바로 아래)의 끝에 구분선 참조 `<w:footnote w:id="-1"/><w:footnote w:id="0"/>`(미주는 `w:endnote`)만 더한 것인지.
/// WordCraft가 구분선 부분(`-1`·`0`)을 쓸 때 함께 쓰는 참조다(실측). 설정 요소가 원본에 없거나 다른 무엇이라도 다르면 아니다.
fn note_settings_added(original: &Package, output: &Package, notes: &[&str]) -> bool {
    let (Some(before), Some(after)) = (original.get(SETTINGS), output.get(SETTINGS)) else {
        return false;
    };
    let (Ok(a), Ok(mut b)) = (xml::canonical(before), xml::canonical(after)) else {
        return false;
    };
    for (((part, ..), child), pr) in NOTE_PARTS.iter().zip(NOTE_CHILDREN).zip(NOTE_SETTINGS) {
        if !notes.contains(part) {
            continue;
        }
        // 뿌리 바로 아래 `pr` 요소의 끝 사건 위치.
        let mut depth = 0usize;
        let mut inside = false;
        let mut end = None;
        for (i, event) in b.iter().enumerate() {
            match event {
                xml::Canonical::Start {
                    namespace, name, ..
                } => {
                    if depth == 1 && namespace.as_ref().is_some_and(|ns| *ns == WML) && *name == pr
                    {
                        if inside || end.is_some() {
                            return false;
                        }
                        inside = true;
                    }
                    depth += 1;
                }
                xml::Canonical::End => {
                    let Some(next) = depth.checked_sub(1) else {
                        return false;
                    };
                    depth = next;
                    if inside && depth == 1 {
                        end = Some(i);
                        inside = false;
                    }
                }
                _ => {}
            }
        }
        let Some(end) = end else { return false };
        let Some(start) = end.checked_sub(4) else {
            return false;
        };
        let reference = |event: &xml::Canonical, id: &str| {
            matches!(event, xml::Canonical::Start { namespace, name, attributes }
                if namespace.as_ref().is_some_and(|ns| *ns == WML)
                    && *name == child
                    && attributes.len() == 1
                    && attributes[0].0.as_ref().is_some_and(|ns| *ns == WML)
                    && attributes[0].1 == "id"
                    && attributes[0].2 == id)
        };
        let tail = &b[start..end];
        if !(reference(&tail[0], "-1")
            && tail[1] == xml::Canonical::End
            && reference(&tail[2], "0")
            && tail[3] == xml::Canonical::End)
        {
            return false;
        }
        b.drain(start..end);
    }
    a == b
}

/// T013 각주·미주: 원본에 이미 있던 각주·미주 부분(`child`: `footnote`·`endnote`)에 **새 각주만 더한** 출력인지. 뿌리 시작이 같고,
/// 뿌리 바로 아래는 그 요소들뿐이며, 구분선류(`w:type` separator·continuationSeparator·continuationNotice)는 순서·번호까지 그대로,
/// 보통 각주(형식 없음 또는 `normal`)는 원본 것이 순서·내용 그대로 출력에 남고(본문 순서로 다시 매기므로 뿌리의 `w:id`만 다를 수
/// 있음) 하나 이상이 더해졌을 때만이다. 더한 각주의 내용과 본문 참조 대상은 엔진 다시 읽기(모델 비교)가 확인한다. 각주 부분 관계
/// (`word/_rels/footnotes.xml.rels`)·목록은 바뀌면 안 된다(부분마다 비교에 남음).
fn note_part_extended(before: &[u8], after: &[u8], child: &str) -> bool {
    /// (구분선류, 보통 각주(뿌리 `w:id`를 뺀 사건 열)).
    type Split = (Vec<Vec<xml::Canonical>>, Vec<Vec<xml::Canonical>>);
    fn split(events: Vec<xml::Canonical>, child: &str) -> Option<(xml::Canonical, Split)> {
        let mut iter = events.into_iter();
        let root = iter.next()?;
        let mut specials = Vec::new();
        let mut normal = Vec::new();
        let mut current: Vec<xml::Canonical> = Vec::new();
        let mut depth = 0usize;
        let mut closed = false;
        for event in iter {
            if closed {
                return None;
            }
            match &event {
                xml::Canonical::Start { .. } => depth += 1,
                xml::Canonical::End if depth == 0 => {
                    closed = true;
                    continue;
                }
                xml::Canonical::End => depth -= 1,
                _ if depth == 0 => return None,
                _ => {}
            }
            current.push(event);
            if depth == 0 {
                let mut item = std::mem::take(&mut current);
                let Some(xml::Canonical::Start {
                    namespace,
                    name,
                    attributes,
                }) = item.first_mut()
                else {
                    return None;
                };
                if !(namespace.as_ref().is_some_and(|ns| *ns == WML) && *name == child) {
                    return None;
                }
                let kind = attributes
                    .iter()
                    .find(|(ns, key, _)| ns.as_ref().is_some_and(|ns| *ns == WML) && *key == "type")
                    .map(|(.., value)| value.to_string());
                match kind.as_deref() {
                    Some("separator" | "continuationSeparator" | "continuationNotice") => {
                        specials.push(item)
                    }
                    None | Some("normal") => {
                        attributes.retain(|(ns, key, _)| {
                            !(ns.as_ref().is_some_and(|ns| *ns == WML) && *key == "id")
                        });
                        normal.push(item);
                    }
                    Some(_) => return None,
                }
            }
        }
        (closed && depth == 0 && current.is_empty()).then_some((root, (specials, normal)))
    }
    let (Ok(a), Ok(b)) = (xml::canonical(before), xml::canonical(after)) else {
        return false;
    };
    let (Some((root_a, (special_a, normal_a))), Some((root_b, (special_b, normal_b)))) =
        (split(a, child), split(b, child))
    else {
        return false;
    };
    if root_a != root_b || special_a != special_b || normal_b.len() <= normal_a.len() {
        return false;
    }
    // 원본 각주가 순서대로 출력의 부분 열이어야 한다.
    let mut rest = normal_b.iter();
    normal_a
        .iter()
        .all(|note| rest.by_ref().any(|candidate| candidate == note))
}

/// DOCX 썸네일 부분:/// DOCX 썸네일 부분: 패키지 관계(`_rels/.rels`)의 thumbnail 대상과 관례 이름 `docProps/thumbnail.*`.
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
/// 문서 내용과 무관함을 증명해야 한다(빈 값·고정 rhwp 빈 미리보기 상수와 바이트가 같음, `preview`). 그 밖의 미리보기 부분은
/// 증명할 수 없어 막는다.
pub fn compare_saved_hwpx(original: &Package, output: &Package) -> Vec<Finding> {
    let mut findings = compare(original, output, &|name| {
        hwpx_body(name) || name == HWPX_HEADER
    });
    // header는 원본과 같거나, 글자 서식이 덧붙인 글자 모양 정의만 다를 수 있다(T010 Phase 3B, `hwpx_char_shapes_appended`).
    // 빠지거나 생긴 header는 위 `compare`가 이미 적었다.
    // Validate both complete inputs first; then compare semantic pieces and the narrow append rule without retained trees.
    if let (Some(before), Some(after)) = (original.get(HWPX_HEADER), output.get(HWPX_HEADER)) {
        if before != after {
            match (
                xml::canonical_checked(before),
                xml::canonical_checked(after),
            ) {
                (Err(xml::CanonicalFailure::Invalid), _) => {
                    findings.push(Finding::at(FindingCode::OriginalMalformed, HWPX_HEADER))
                }
                (Err(_), _) => findings.push(Finding::at(FindingCode::LimitExceeded, HWPX_HEADER)),
                (_, Err(xml::CanonicalFailure::Invalid)) => {
                    findings.push(Finding::at(FindingCode::OutputMalformed, HWPX_HEADER))
                }
                (_, Err(_)) => findings.push(Finding::at(FindingCode::LimitExceeded, HWPX_HEADER)),
                (Ok(()), Ok(())) => {
                    let epoch = crate::document::resources::failure_epoch();
                    if !super::special::header_equal_or_appended(before, after, output) {
                        findings.push(Finding::at(
                            resource_code(epoch, FindingCode::PartChanged),
                            HWPX_HEADER,
                        ));
                    }
                }
            }
        }
    }
    // 본문 부분 바이트를 복사하지 않고 비교한다.
    let body = |package| -> Vec<(&String, &Vec<u8>)> {
        let package: &Package = package;
        package
            .parts
            .iter()
            .filter(|(name, _)| hwpx_body(name))
            .map(|(name, (_, data))| (name, data))
            .collect()
    };
    if body(original) != body(output) {
        for (name, (_, data)) in &original.parts {
            if !name.starts_with("Preview/") || output.get(name) != Some(data.as_slice()) {
                continue;
            }
            let empty = match name.as_str() {
                "Preview/PrvText.txt" => preview::blank_utf8(data),
                "Preview/PrvImage.png" => preview::known_blank_png(data),
                _ => false,
            };
            if !empty {
                findings.push(Finding::at(FindingCode::PreviewStale, name));
            }
        }
    }
    findings
}

/// HWPX 글자·문단 모양 정의를 읽는 부분(고정 rhwp `parser/hwpx/reader.rs` `DOCUMENT_HEADER_PATH`).
const HWPX_HEADER: &str = "Contents/header.xml";
/// 고정 rhwp가 정의를 넣는 id 상한(`parser/hwpx/header.rs` `MAX_RESOURCE_ID`): 넘는 id의 정의는 말없이 버려진다.
pub(super) const HWPX_MAX_RESOURCE_ID: u32 = 65_535;
/// 본문이 가리키는 모양 이름공간: (참조 속성, 정의 요소). 본문 어느 요소의 참조 속성이든 같은 이름공간을 가리킨다
/// (고정 rhwp: `hp:run`·`hp:formCharPr`의 `charPrIDRef`, `hp:p`의 `paraPrIDRef`).
const HWPX_SHAPE_REFERENCES: [(&str, &str); 2] =
    [("charPrIDRef", "charPr"), ("paraPrIDRef", "paraPr")];

/// 참조·정의 id의 글자 모양: 10진 숫자만(부호·공백·빈 값 없음), u32 범위. 고정 rhwp는 그 밖의 값을 말없이 0으로 읽는다
/// (`parser/hwpx/utils.rs` `parse_u32`·`parse_u16`의 `unwrap_or(0)`)이므로 받지 않는다.
pub(super) fn hwpx_id(text: &str) -> Option<u32> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// HWPML head 이름공간(고정 rhwp가 쓰는 `hh:` — `serializer/hwpx/header.rs`, 한컴 출력과 같음).
pub(super) const HWPML_HEAD: &str = "http://www.hancom.co.kr/hwpml/2011/head";
/// 정의 요소 → 그 정의를 담는 목록 요소(`hh:charProperties`·`hh:paraProperties`).
pub(super) const HWPX_SHAPE_LISTS: [&str; 2] = ["charProperties", "paraProperties"];

/// HWPML paragraph 이름공간(고정 rhwp `hp:` — `serializer/hwpx/content.rs`, 한컴 출력과 같음).
const HWPML_PARAGRAPH: &str = "http://www.hancom.co.kr/hwpml/2011/paragraph";

/// 선 모양 토큰 13종(고정 rhwp `serializer/hwpx/char_shape_tables/line_shape.rs` `LINE_SHAPE_HWPX` — 파서
/// `parser/hwpx/header.rs`의 밑줄·취소선 `shape` 표와 같다).
const HWPX_LINE_SHAPES: [&str; 13] = [
    "SOLID",
    "DASH",
    "DOT",
    "DASH_DOT",
    "DASH_DOT_DOT",
    "LONG_DASH",
    "CIRCLE",
    "DOUBLE_SLIM",
    "SLIM_THICK",
    "THICK_SLIM",
    "SLIM_THICK_SLIM",
    "WAVE",
    "DOUBLE_WAVE",
];

/// 글자 서식이 바꿀 수 있는 글자 모양 정의의 자식(T010 Phase 3B): 모두 내용 없는 `hh` 요소다.
pub(super) const HWPX_FORMAT_CHILDREN: [&str; 4] = ["bold", "italic", "underline", "strikeout"];

/// 장평·자간(T012)이 바꾸는 글자 모양 정의의 자식: 내용 없는 `hh` 요소, 7개 언어 속성.
pub(super) const HWPX_METRIC_CHILDREN: [&str; 2] = ["ratio", "spacing"];
/// 고정 rhwp `serializer/hwpx/char_shapes.rs` `LANG_ATTRS`(그리고 `parser/hwpx/header.rs`가 읽는 이름).
const HWPX_LANG_ATTRS: [&str; 7] = [
    "hangul", "latin", "hanja", "japanese", "other", "symbol", "user",
];

/// 덧붙인 정의의 `hh:ratio`·`hh:spacing`이 고정 rhwp 직렬화기(`write_lang_attrs`)가 쓰는 모양이고 값이 앱이 쓰는 범위인지(T012):
/// 이름공간 없는 7개 언어 속성 정확히 하나씩, 값은 부호(음수만)와 0으로 시작하지 않는 10진 정수, 장평 50–200·자간 −50–50
/// (CharShape 계약 `model/style.rs`). 고정 rhwp 판독기(`parse_u8`·`parse_i8`)가 말없이 다른 값으로 읽을 수 있는 모양은 받지 않는다.
pub(super) fn serializer_metric_child(
    local: &str,
    attributes: &[(Option<xml::Atom>, xml::Atom, xml::Atom)],
) -> bool {
    let range = match local {
        "ratio" => 50..=200,
        "spacing" => -50..=50,
        _ => return false,
    };
    let canonical = |value: &str| {
        let digits = value.strip_prefix('-').unwrap_or(value);
        !digits.is_empty()
            && digits.len() <= 3
            && digits.bytes().all(|b| b.is_ascii_digit())
            && (digits == "0" || !digits.starts_with('0'))
            && value != "-0"
    };
    attributes.len() == HWPX_LANG_ATTRS.len()
        && HWPX_LANG_ATTRS.iter().all(|key| {
            let mut found = attributes
                .iter()
                .filter(|(ns, name, _)| ns.is_none() && name == key);
            match (found.next(), found.next()) {
                (Some((_, _, value)), None) => {
                    canonical(value)
                        && value
                            .parse::<i32>()
                            .is_ok_and(|number| range.contains(&number))
                }
                _ => false,
            }
        })
}

/// 고정 rhwp 직렬화기 `color_hex`가 쓰는 색: `none`, `#RRGGBB`, `#AARRGGBB`(대문자 16진).
fn serializer_color(value: &str) -> bool {
    value == "none"
        || value.strip_prefix('#').is_some_and(|hex| {
            (hex.len() == 6 || hex.len() == 8)
                && hex
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
        })
}

/// 덧붙인 정의의 서식 자식 하나가 고정 rhwp 직렬화기(`serializer/hwpx/char_shapes.rs` `write_char_pr`)가 쓰는 모양과 값인지(T010
/// 교정 C1). 굵게·기울임은 속성 없음, 밑줄은 `type`(NONE·BOTTOM·TOP)·`shape`(선 모양 13종)·`color` 셋 모두, 취소선은
/// `shape`(NONE 또는 선 모양 13종)·`color` 둘 모두 — 빠지거나 더한 속성, 이름공간 붙은 속성, 그 밖의 값은 받지 않는다(엔진이 모르는
/// 값을 말없이 기본값으로 읽어 서식 의미를 증명할 수 없음).
pub(super) fn serializer_format_child(
    local: &str,
    attributes: &[(Option<xml::Atom>, xml::Atom, xml::Atom)],
) -> bool {
    let value = |key: &str| {
        attributes
            .iter()
            .find(|(ns, name, _)| ns.is_none() && name == key)
            .map(|(_, _, value)| value.as_str())
    };
    let exactly = |keys: &[&str]| {
        attributes.len() == keys.len()
            && attributes
                .iter()
                .all(|(ns, name, _)| ns.is_none() && keys.contains(&name.as_str()))
    };
    match local {
        "bold" | "italic" => attributes.is_empty(),
        "underline" => {
            exactly(&["type", "shape", "color"])
                && value("type").is_some_and(|t| ["NONE", "BOTTOM", "TOP"].contains(&t))
                && value("shape").is_some_and(|s| HWPX_LINE_SHAPES.contains(&s))
                && value("color").is_some_and(serializer_color)
        }
        "strikeout" => {
            exactly(&["shape", "color"])
                && value("shape").is_some_and(|s| s == "NONE" || HWPX_LINE_SHAPES.contains(&s))
                && value("color").is_some_and(serializer_color)
        }
        _ => false,
    }
}

pub(super) fn is_head(event: &xml::Canonical, local: &str) -> bool {
    matches!(event, xml::Canonical::Start { namespace, name, .. }
        if namespace.as_deref() == Some(HWPML_HEAD) && name == local)
}

pub(super) fn plain_attribute<'a>(event: &'a xml::Canonical, key: &str) -> Option<&'a str> {
    let xml::Canonical::Start { attributes, .. } = event else {
        return None;
    };
    attributes
        .iter()
        .find(|(ns, name, _)| ns.is_none() && name == key)
        .map(|(_, _, value)| value.as_str())
}

/// 서식 자식을 어떻게 다루나: 덧붙인 정의는 직렬화기 정책(`serializer_format_child`)을 지켜야 하고, 원본 정의는 소급해 거부하지
/// 않는다(내용 없는 서식 자식이면 값과 관계없이 뺀다).
#[derive(Clone, Copy, PartialEq)]
pub(super) enum FormatPolicy {
    Appended,
    Original,
}

/// HWPML section 이름공간(구역 뿌리 `hs:sec`).
const HWPML_SECTION: &str = "http://www.hancom.co.kr/hwpml/2011/section";
/// 고정 rhwp 문단 본문 루프가 `parse_form_object`로 읽는 양식 요소(`parser/hwpx/section.rs` `parse_paragraph_body`).
const HWPX_FORM_OBJECTS: [&str; 5] = ["btn", "checkBtn", "radioBtn", "comboBox", "edit"];

/// 출력 본문 구역들에서 엔진이 **글자 모양 참조로 읽는** 자리의 id(T010 교정 B, 2026-10-26 강화). 고정 rhwp 구역 파서
/// (`parser/hwpx/section.rs`)의 실제 경로만 센다(그 파서는 지역 이름만 보지만 판정은 `hp`/`hs` 이름공간까지 요구해 더 좁다):
/// - `run`(내용 있는 것·자기 닫힘 모두)의 `charPrIDRef`: 그 run의 부모가 **읽히는 문단**일 때.
/// - `formCharPr`의 `charPrIDRef`: 자기 닫힘(Empty — Start는 `parse_form_object`가 `skip_element`)이고, 부모가 내용 있는 양식 요소
///   (`HWPX_FORM_OBJECTS`, 문단 루프가 Start에서만 `parse_form_object`를 부름)이며, 그 양식의 부모가 읽히는 문단의 `run`일 때
///   (직렬화기는 양식을 `hp:run` 바로 아래에 쓴다. `hp:ctrl` 안은 `parse_ctrl`이 건너뛴다).
/// - 읽히는 문단 = 구역 뿌리 `hs:sec` 바로 아래 `hp:p`, 또는 `hp:subList` ← `hp:tc` ← `hp:tr` ← `hp:tbl` ← `hp:run` ← 읽히는 문단
///   (표 셀, 중첩 표 포함 — 실제 엔진 서식 출력의 경로). 글상자·머리말·각주 등 그 밖의 문단은 세지 않는다(fail-closed: 그 자리의
///   덧붙임 저장은 거부된다).
///
/// 이름공간 없는 `charPrIDRef` 속성만 보고, 주석·글은 세지 않는다. 읽을 수 없는 구역이면 None.
pub(super) fn hwpx_char_shape_uses(output: &Package) -> Option<std::collections::BTreeSet<u32>> {
    let mut used = std::collections::BTreeSet::new();
    for (name, (_, data)) in &output.parts {
        if !hwpx_body(name) {
            continue;
        }
        struct Ancestor {
            index: usize,
            namespace: Option<String>,
            name: String,
            paragraph: bool,
        }
        let mut stack: Vec<Ancestor> = Vec::new();
        let mut index = 0;
        xml::visit_element_starts(data, |element| {
            while stack.last().map(|a| a.index) != element.parent_index {
                if stack.pop().is_none() {
                    return Err(xml::Invalid);
                }
            }
            let is = |back: usize, ns: &str, name: &str| {
                stack
                    .len()
                    .checked_sub(back + 1)
                    .and_then(|i| stack.get(i))
                    .is_some_and(|a| a.namespace.as_deref() == Some(ns) && a.name == name)
            };
            let parent_paragraph = stack.last().is_some_and(|a| a.paragraph);
            let paragraph = !element.self_closing
                && element.namespace.as_deref() == Some(HWPML_PARAGRAPH)
                && element.name == "p"
                && ((stack.len() == 1 && is(0, HWPML_SECTION, "sec"))
                    || (is(0, HWPML_PARAGRAPH, "subList")
                        && is(1, HWPML_PARAGRAPH, "tc")
                        && is(2, HWPML_PARAGRAPH, "tr")
                        && is(3, HWPML_PARAGRAPH, "tbl")
                        && is(4, HWPML_PARAGRAPH, "run")
                        && stack
                            .len()
                            .checked_sub(6)
                            .and_then(|i| stack.get(i))
                            .is_some_and(|a| a.paragraph)));
            let reads = element.namespace.as_deref() == Some(HWPML_PARAGRAPH)
                && ((element.name == "run" && parent_paragraph)
                    || (element.name == "formCharPr"
                        && element.self_closing
                        && stack.last().is_some_and(|a| {
                            a.namespace.as_deref() == Some(HWPML_PARAGRAPH)
                                && HWPX_FORM_OBJECTS.contains(&a.name.as_str())
                        })
                        && is(1, HWPML_PARAGRAPH, "run")
                        && stack
                            .len()
                            .checked_sub(3)
                            .and_then(|i| stack.get(i))
                            .is_some_and(|a| a.paragraph)));
            if reads {
                for (ns, key, value) in &element.attributes {
                    if ns.is_none() && key == "charPrIDRef" {
                        if let Some(id) = hwpx_id(value) {
                            // Only ids within the approved resource space can be appended.
                            // Invalid references are still independently rejected below.
                            if id <= HWPX_MAX_RESOURCE_ID {
                                used.insert(id);
                            }
                        }
                    }
                }
            }
            if !element.self_closing {
                stack.try_reserve(1).map_err(|_| {
                    crate::document::resources::allocation_refused();
                    xml::Invalid
                })?;
                stack.push(Ancestor {
                    index,
                    namespace: element.namespace,
                    name: element.name,
                    paragraph,
                });
            }
            index += 1;
            Ok(())
        })
        .ok()?;
    }
    Some(used)
}

/// header의 모양 정의 id 집합(이름공간마다) — 고정 rhwp가 실제로 등록하는 정의만(2026-10-22 2차 고침).
///
/// 엔진(`parser/hwpx/header.rs` `parse_hwpx_header_with_plain_margin_units`)은 지역 이름이 `charPr`·`paraPr`인 요소를 이름공간·위치와
/// 관계없이 `Event::Start`(내용이 있는 요소)에서만 등록하고, 자기 닫힘(`Event::Empty`)은 건너뛴다(실측: 자기 닫힘 정의를 가리키면 엔진은
/// 그 id를 보고하며 기본 모양으로 그리고, 내보내기는 그 정의를 빼고 쓴다). 그래서:
/// - 정의 = 내용이 있는 요소이고 `hh` 이름공간이며 부모가 같은 이름공간의 목록 요소(`charProperties`·`paraProperties`)인 것.
/// - 자기 닫힘 `charPr`·`paraPr`는 정의가 아니다(가리키면 `referenceInvalid`). 쓰지 않는 자기 닫힘 요소만으로는 막지 않는다.
/// - 엔진이 등록하지만 정의로 확인할 수 없는 요소(다른 이름공간·다른 위치의 내용 있는 `charPr`/`paraPr` — 엔진은 그것도 같은 배열에
///   넣어 정의를 덮을 수 있다), id가 없거나 숫자가 아님(엔진은 등장 순서·0으로 넣는다), 등록되는 요소끼리 같은 id(뒤의 것이 덮는다)이면
///   None: 참조가 무엇을 가리키는지 증명할 수 없다.
fn hwpx_definitions(header: &[u8]) -> Option<[std::collections::BTreeSet<u32>; 2]> {
    let mut sets = [
        std::collections::BTreeSet::new(),
        std::collections::BTreeSet::new(),
    ];
    xml::visit_element_starts(header, |element| {
        let Some(slot) = HWPX_SHAPE_REFERENCES
            .iter()
            .position(|(_, name)| *name == element.name)
        else {
            return Ok(());
        };
        if element.self_closing {
            return Ok(()); // 엔진이 등록하지 않는다
        }
        let in_list = element.namespace.as_deref() == Some(HWPML_HEAD)
            && element.parent.as_ref().is_some_and(|(namespace, name)| {
                namespace.as_deref() == Some(HWPML_HEAD) && name == HWPX_SHAPE_LISTS[slot]
            });
        if !in_list {
            return Err(xml::Invalid);
        }
        let id = element
            .attributes
            .iter()
            .find(|(ns, key, _)| ns.is_none() && key == "id")
            .and_then(|(_, _, value)| hwpx_id(value))
            .ok_or(xml::Invalid)?;
        if !sets[slot].insert(id) {
            return Err(xml::Invalid);
        }
        Ok(())
    })
    .ok()?;
    // 엔진이 버리는 id의 정의는 정의가 아니다(가리키면 기본 모양으로 대체된다).
    for set in &mut sets {
        set.retain(|id| *id <= HWPX_MAX_RESOURCE_ID);
    }
    Some(sets)
}

/// HWPX 출력의 모양 참조 무결성(T009, T010 Phase 0 Stage B 결함 수정): 출력 본문 부분(`Contents/section<N>.xml`, 표 셀·구역
/// 정의 run 등 중첩 포함 모든 요소)의 `charPrIDRef`·`paraPrIDRef`가 10진 숫자이고 출력 header에 정의된 id를 가리켜야 한다.
/// 고정 rhwp는 없는 id를 기본 모양으로, 숫자가 아닌 값을 0으로 말없이 바꿔 다시 열기 비교(쪽·글·컨트롤)로는 드러나지 않는다.
/// - 맞지 않는 참조: `referenceInvalid`(unsafe, 부분 이름).
/// - header가 없음·정의 id를 정할 수 없음: `unsupported`(unknown, `Contents/header.xml`) — 증명할 수 없으면 저장하지 않는다.
///   읽을 수 없는 header·본문은 `validate_hwpx`가 이미 `outputMalformed`로 막는다.
///
/// id가 이어져야 한다고 요구하지 않는다(엔진은 id를 배열 위치로 쓰고 빈 번호는 정의가 아니다).
pub fn validate_hwpx_references(output: &Package) -> Vec<Finding> {
    let sections: Vec<(&String, &Vec<u8>)> = output
        .parts
        .iter()
        .filter(|(name, _)| hwpx_body(name))
        .map(|(name, (_, data))| (name, data))
        .collect();
    if sections.is_empty() {
        return Vec::new();
    }
    let Some(header) = output.get(HWPX_HEADER) else {
        return vec![Finding::at(FindingCode::Unsupported, HWPX_HEADER)];
    };
    // 읽을 수 없는 header는 malformed_xml(validate_hwpx)이 이미 `outputMalformed`로 막는다(같은 까닭을 두 번 적지 않음).
    if xml::canonical_valid(header).is_err() {
        return Vec::new();
    }
    let Some(definitions) = hwpx_definitions(header) else {
        return vec![Finding::at(FindingCode::Unsupported, HWPX_HEADER)];
    };
    let mut findings = Vec::new();
    for (name, data) in sections {
        // 읽을 수 없는 본문은 malformed_xml(validate_hwpx)이 이미 막는다.
        let Ok(events) = xml::canonical(data) else {
            continue;
        };
        let invalid = events.iter().any(|event| {
            let xml::Canonical::Start { attributes, .. } = event else {
                return false;
            };
            attributes.iter().any(|(ns, key, value)| {
                ns.is_none()
                    && HWPX_SHAPE_REFERENCES.iter().zip(&definitions).any(
                        |((attribute, _), set)| {
                            key == attribute && !hwpx_id(value).is_some_and(|id| set.contains(&id))
                        },
                    )
            })
        });
        if invalid {
            findings.push(Finding::at(FindingCode::ReferenceInvalid, name));
        }
    }
    findings
}

#[cfg(test)]
#[path = "package_special_legacy_test.rs"]
pub(super) mod special_legacy;

#[cfg(test)]
pub(super) fn legacy_statistics(before: &[u8], after: &[u8]) -> Option<bool> {
    special_legacy::same_except_statistics(before, after)
}
