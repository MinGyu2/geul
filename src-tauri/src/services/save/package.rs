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

/// The loaded DOCX body must round-trip before enabling an operation on a
/// DrawingML preset that the reader can also produce by approximating others.
pub(crate) fn docx_body_source_roundtrips(source: &[u8], export: &[u8]) -> bool {
    fn body(bytes: &[u8]) -> Option<Vec<u8>> {
        let mut reader = Cursor::new(bytes);
        let archive = zip::read_directory(&mut reader, bytes.len() as u64, &LIMITS).ok()?;
        let mut matches = archive.entries().iter().filter(|entry| entry.name() == b"word/document.xml");
        let entry = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        archive.read(&mut reader, entry, MAX_PART_BYTES).ok()
    }
    let (Some(source), Some(export)) = (body(source), body(export)) else { return false };
    xml::canonical_equal(&source, &export) == Ok(true)
}

/// 읽어 둔 패키지: 항목 이름(중앙 디렉터리 순서)과 압축을 푼 내용, 압축 방식.
pub struct Package {
    pub order: Vec<String>,
    pub parts: BTreeMap<String, (u16, Vec<u8>)>,
}

/// Server-generated HWPX preview bytes accepted only after matching the rebuilt package exactly.
#[derive(Default)]
pub struct RefreshedHwpxPreviews {
    pub output: Option<Vec<u8>>,
    pub image: Option<Vec<u8>>,
    pub text: Option<Vec<u8>>,
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
pub(super) fn resolve(source: &str, target: &str) -> Option<String> {
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

/// DOCX load preflight remains exact except for WordCraft's proven no-op de-sharing of a shared
/// SmartArt graph and application statistics that it recomputes from that unchanged document.
pub(super) fn compare_preflight_docx(original: &Package, output: &Package) -> Vec<Finding> {
    const BODY: &str = "word/document.xml";
    const APP: &str = "docProps/app.xml";
    let graphics = super::docx_graphics::graphic_parts_unchanged_regenerated(original, output)
        .unwrap_or_default();
    let app_statistics_only = original
        .get(APP)
        .zip(output.get(APP))
        .is_some_and(|(before, after)| same_except_statistics(before, after) == Some(true));
    let mut findings = compare(original, output, &|name| {
        graphics.contains(name)
            || (graphics.contains(BODY) && name == BODY)
            || (app_statistics_only && name == APP)
    });
    findings.retain(|finding| {
        !(finding.code == FindingCode::PartAdded
            && finding.part.as_deref().is_some_and(|name| graphics.contains(name)))
    });
    findings
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
    let pictures = pictures_appended(original, output);
    // Stage 3 P4 / stabilization: narrow semantic proof for chart/SmartArt parts WordCraft
    // regenerates from an edited model (`docx_graphics`).
    let graphics = super::docx_graphics::graphic_parts_regenerated(original, output);
    let mut story_drawing_edits =
        super::docx_story_drawings::inline_picture_edits(original, output);
    story_drawing_edits.extend(super::docx_story_drawings::moved_note_picture_edits(original, output));
    story_drawing_edits.extend(
        super::docx_story_drawings::moved_header_footer_picture_edits(original, output),
    );
    story_drawing_edits.extend(
        super::docx_story_drawings::deleted_story_picture_edits(original, output),
    );
    let media_removed = if added.is_none() && pictures.is_none() {
        authorized_table_media_changes(original, output)
    } else {
        None
    };
    // Stage 1 F: embedded fonts (font table embeds + obfuscated font parts); not composed with other additions.
    let fonts = if added.is_none() && pictures.is_none() && media_removed.is_none() {
        super::docx_fonts::docx_fonts_embedded(original, output)
    } else {
        None
    };
    let numbering = numbering_appended(original, output) == Some(true);
    let notes_added = added.as_ref().is_some_and(|added| {
        added
            .iter()
            .any(|(part, ..)| NOTE_PARTS.iter().any(|(note, ..)| note == part))
    });
    let appended = added.is_none() && comment_parts_appended(original, output);
    // T013 Stage 3 변경 내용 추적 켜기·끄기: settings의 차이가 뿌리 바로 아래의 맨 `<w:trackRevisions/>` 하나의 있고 없음뿐일 때만.
    let tracking_toggled = track_revisions_toggled(original, output);
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
            || (numbering && name == NUMBERING)
            || name == APP
            || ((added.is_some() || pictures.is_some())
                && (name == CONTENT_TYPES || name == DOCUMENT_RELS))
            || media_removed.as_ref().is_some_and(|m| {
                name == DOCUMENT_RELS || (m.content_types_changed && name == CONTENT_TYPES)
            })
            || ((notes_added || tracking_toggled) && name == SETTINGS)
            || (appended && COMMENT_PARTS.iter().any(|(part, ..)| *part == name))
            || extended.contains(&name)
            || graphics.contains(name)
            || story_drawing_edits.contains(name)
            || fonts.as_ref().is_some_and(|f| {
                f.parts.contains(name) || name == CONTENT_TYPES || (f.document_rels && name == DOCUMENT_RELS)
            })
    });
    findings.retain(|finding| {
        !(finding.code == FindingCode::PartMissing
            && finding
                .part
                .as_deref()
                .is_some_and(|name| story_drawing_edits.contains(name)))
    });
    findings.retain(|finding| {
        !(finding.code == FindingCode::PartAdded
            && finding.part.as_deref().is_some_and(|name| graphics.contains(name)))
    });
    if let Some(media) = &media_removed {
        findings.retain(|f| {
            !(f.code == FindingCode::PartMissing
                && f.part
                    .as_deref()
                    .is_some_and(|name| media.removed_media.iter().any(|r| r == name)))
        });
    }
    if let Some(fonts) = &fonts {
        findings.retain(|f| {
            !(f.code == FindingCode::PartAdded && f.part.as_ref().is_some_and(|name| fonts.parts.contains(name)))
        });
    }
    if let Some(pictures) = &pictures {
        findings.retain(|f| {
            !(f.code == FindingCode::PartAdded
                && f.part.as_ref().is_some_and(|name| pictures.contains(name)))
        });
    }
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
    // T013 Stage 4: 메모 경계에서 하이퍼링크 하나가 같은 관계를 가리키는 여러 요소로 나뉜 출력은 받는다(바로 앞 하이퍼링크와 같은
    // r:* 속성만, 관계 목록은 그대로 — 다른 대상·형식·이름공간은 위 `index`·대조가 막음). 내용·메모 경계는 엔진 다시 읽기가 확인한다.
    xml::relationship_references_equal_with(
        original.get("word/document.xml")?,
        output.get("word/document.xml")?,
        true,
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
const DIAGRAM_RELS: [(&str, &str); 5] = [
    (
        "data",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData",
    ),
    (
        "layout",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramLayout",
    ),
    (
        "quickStyle",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramQuickStyle",
    ),
    (
        "colors",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramColors",
    ),
    (
        "drawing",
        "http://schemas.microsoft.com/office/2007/relationships/diagramDrawing",
    ),
];

/// Part names whose content WordCraft writes from a chart or SmartArt model (`word/charts/chartN.xml`,
/// `word/diagrams/{data,layout,quickStyle,colors,drawing}N.xml`).
pub fn regenerated_graphic_part(name: &str) -> bool {
    let numbered = |rest: &str| {
        rest.strip_suffix(".xml")
            .is_some_and(|n| !n.is_empty() && n.len() <= 6 && n.bytes().all(|b| b.is_ascii_digit()))
    };
    name.strip_prefix("word/charts/chart").is_some_and(numbered)
        || DIAGRAM_RELS.iter().any(|(kind, _)| {
            name.strip_prefix(&format!("word/diagrams/{kind}"))
                .is_some_and(numbered)
        })
}

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
        .chain(std::iter::once(&NUMBERING_PART).filter(|_| {
            numbering_appended(original, output) == Some(true) && !present(original, NUMBERING)
        }))
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

    let (Some((root_a, kids_a)), Some((root_b, kids_b))) = (
        content_type_children(types_before),
        content_type_children(types_after),
    ) else {
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
    a == b || track_revisions_only(&a, &b)
}

/// 뿌리 바로 아래의 맨 `w:trackRevisions`(속성·자식·글 없음)를 뺀 settings 사건 열과 그것이 있었는지. 둘 이상이거나 맨 요소가 아니면
/// (`w:val` 등) 판정하지 않는다(None).
fn without_track_revisions(events: &[xml::Canonical]) -> Option<(Vec<xml::Canonical>, bool)> {
    let mut out = Vec::with_capacity(events.len());
    let mut depth = 0usize;
    let mut found = false;
    let mut i = 0;
    while let Some(event) = events.get(i) {
        match event {
            xml::Canonical::Start {
                namespace,
                name,
                attributes,
            } => {
                if depth == 1
                    && namespace.as_ref().is_some_and(|ns| *ns == WML)
                    && *name == "trackRevisions"
                {
                    if found
                        || !attributes.is_empty()
                        || events.get(i + 1) != Some(&xml::Canonical::End)
                    {
                        return None;
                    }
                    found = true;
                    i += 2;
                    continue;
                }
                depth += 1;
            }
            xml::Canonical::End => depth = depth.checked_sub(1)?,
            _ => {}
        }
        out.push(event.clone());
        i += 1;
    }
    Some((out, found))
}

/// 두 settings 사건 열이 맨 `w:trackRevisions` 하나의 있고 없음만 다른지.
fn track_revisions_only(a: &[xml::Canonical], b: &[xml::Canonical]) -> bool {
    match (without_track_revisions(a), without_track_revisions(b)) {
        (Some((a, x)), Some((b, y))) => x != y && a == b,
        _ => false,
    }
}

fn track_revisions_toggled(original: &Package, output: &Package) -> bool {
    let (Some(before), Some(after)) = (original.get(SETTINGS), output.get(SETTINGS)) else {
        return false;
    };
    let (Ok(a), Ok(b)) = (xml::canonical(before), xml::canonical(after)) else {
        return false;
    };
    track_revisions_only(&a, &b)
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
const HWPX_PREVIEW_IMAGE: &str = "Preview/PrvImage.png";
const HWPX_PREVIEW_TEXT: &str = "Preview/PrvText.txt";

/// XML that differs only in its complete canonical event stream can be restored from source.
/// `canonical_equal` retains comments and processing instructions as well as element content.
fn same_hwpx_xml(name: &str, source: &[u8], exported: &[u8]) -> bool {
    source != exported
        && is_xml(name, source)
        && is_xml(name, exported)
        && xml::canonical_equal(source, exported) == Ok(true)
}

pub fn compare_saved_hwpx(original: &Package, output: &Package) -> Vec<Finding> {
    compare_saved_hwpx_with_previews(original, output, None, None)
}

/// Compare an HWPX output with only exact server-regenerated preview parts exempted from part
/// equality. The image must be this package's canonical page-sized PNG, and text may only become
/// the known content-independent CRLF value. Ordinary callers retain the strict comparator above.
pub fn compare_saved_hwpx_with_previews(
    original: &Package,
    output: &Package,
    regenerated_image: Option<&[u8]>,
    regenerated_text: Option<&[u8]>,
) -> Vec<Finding> {
    let image_proven = regenerated_image.is_some_and(|expected| {
        output.get(HWPX_PREVIEW_IMAGE) == Some(expected)
            && hwpx_preview_dimensions(output).is_some_and(|size| {
                preview::decode_canonical_png(expected)
                    .is_some_and(|(width, height, _)| (width, height) == size)
            })
    });
    let text_proven = regenerated_text.is_some_and(|expected| {
        expected == preview::RHWP_BLANK_PREVIEW_TEXT
            && output.get(HWPX_PREVIEW_TEXT) == Some(expected)
    });
    let pictures = hwpx_pictures_appended(original, output);
    // Stage 1 F: embedded fonts (manifest font items + hh:font references); not composed with pictures.
    let fonts = if pictures.is_none() { super::hwpx_fonts::hwpx_fonts_embedded(original, output) } else { None };
    let charts = super::hwpx_charts::hwpx_charts_edited(original, output).unwrap_or_default();
    let mut findings = compare(original, output, &|name| {
        (hwpx_body(name)
            || ((pictures.is_some() || fonts.is_some()) && name == "Contents/content.hpf")
            || charts.contains(name))
            || name == HWPX_HEADER
            || (name == HWPX_PREVIEW_IMAGE && image_proven)
            || (name == HWPX_PREVIEW_TEXT && text_proven)
    });
    if let Some(names) = &pictures {
        findings.retain(|f| {
            !(f.code == FindingCode::PartAdded
                && f.part.as_ref().is_some_and(|n| names.contains(n)))
        });
    }
    if let Some(fonts) = &fonts {
        findings.retain(|f| {
            !(f.code == FindingCode::PartAdded && f.part.as_ref().is_some_and(|n| fonts.parts.contains(n)))
        });
    }
    // header는 원본과 같거나, 글자 서식이 덧붙인 글자 모양 정의만 다를 수 있다(T010 Phase 3B, `hwpx_char_shapes_appended`).
    // 빠지거나 생긴 header는 위 `compare`가 이미 적었다.
    // Validate both complete inputs first; then compare semantic pieces and the narrow append rule without retained trees.
    // With embedded fonts the header rules see the output header with exactly those references made non-embedded
    // (the embeds themselves were proved by `hwpx_fonts_embedded`).
    let normalized = fonts.as_ref().map(|f| f.normalized_header.as_slice());
    if let (Some(before), Some(after)) = (original.get(HWPX_HEADER), normalized.or(output.get(HWPX_HEADER))) {
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
                    if !super::special::header_equal_or_appended(before, after, output)
                        && hwpx_table_border_appended(before, after, output) != Some(true)
                        && hwpx_bullets_appended(before, after, output) != Some(true)
                        && !hwpx_combined_appended(before, after, output)
                    {
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
    if body(original) != body(output) || !charts.is_empty() {
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

/// Geometry for the first HWPX page, from the exported package itself. The page dimensions are
/// already the effective width/height; canvas rounding may differ by at most the preview helper's
/// two-pixel slack. Unknown or repeated page definitions refuse preview regeneration.
fn hwpx_preview_dimensions(package: &Package) -> Option<(u32, u32)> {
    const HWPML_PARAGRAPH: &str = "http://www.hancom.co.kr/hwpml/2011/paragraph";
    let section = package.get("Contents/section0.xml")?;
    let mut dimensions = None;
    xml::visit_element_starts(section, |element| {
        if element.namespace.as_deref() == Some(HWPML_PARAGRAPH) && element.name == "pagePr" {
            if dimensions.is_some() {
                return Err(xml::Invalid);
            }
            let attr = |name: &str| {
                element.attributes.iter()
                    .find(|(namespace, key, _)| namespace.is_none() && key == name)
                    .map(|(_, _, value)| value.as_str())
            };
            let parse_dimension = |name: &str| {
                let text = attr(name)?;
                if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
                    return None;
                }
                text.parse::<u32>().ok().filter(|value| (1..=2_000_000).contains(value))
            };
            dimensions = Some((parse_dimension("width").ok_or(xml::Invalid)?,
                parse_dimension("height").ok_or(xml::Invalid)?));
        }
        Ok(())
    }).ok()?;
    let (width, height) = dimensions?;
    preview::preview_dimensions(width, height, false)
}

/// Regenerate only stale HWPX previews from the exact reopened export. A page-sized raster is
/// required for a stale image; stale text is replaced with RHWP's known content-independent CRLF
/// placeholder so no old preview text can survive. XML parts that differ only in their complete
/// canonical event stream are restored byte-for-byte from source; semantically changed body parts
/// remain the reopened export. Every reconstructed part is checked against that exact choice, and
/// final publication still runs the full T009 validator.
pub fn refresh_hwpx_previews(
    original: &[u8],
    output: &[u8],
    raster: Option<&preview::PreviewRaster>,
    max_file_bytes: u64,
) -> Result<RefreshedHwpxPreviews, crate::document::DocumentError> {
    use crate::document::resources::{self, Category};

    let (Ok(before), Ok(raw)) = (open(original, Side::Original), open(output, Side::Output)) else {
        return Ok(RefreshedHwpxPreviews::default());
    };
    let mut stale_image = false;
    let mut stale_text = false;
    let findings = validate_hwpx(&before, &raw)
        .into_iter()
        .chain(compare_saved_hwpx(&before, &raw))
        .chain(validate_hwpx_references(&raw));
    for finding in findings {
        if finding.code != FindingCode::PreviewStale {
            return Ok(RefreshedHwpxPreviews::default());
        }
        match finding.part.as_deref() {
            Some(HWPX_PREVIEW_IMAGE) => stale_image = true,
            Some(HWPX_PREVIEW_TEXT) => stale_text = true,
            _ => return Ok(RefreshedHwpxPreviews::default()),
        }
    }
    if !stale_image && !stale_text {
        return Ok(RefreshedHwpxPreviews::default());
    }

    let image = if stale_image {
        let Some(raster) = raster else { return Ok(RefreshedHwpxPreviews::default()) };
        let Some((width, height)) = hwpx_preview_dimensions(&raw) else {
            return Ok(RefreshedHwpxPreviews::default());
        };
        let Some(rgb) = preview::fit_raster(raster, width, height) else {
            return Ok(RefreshedHwpxPreviews::default());
        };
        let Some(first) = rgb.as_chunks::<3>().0.first() else {
            return Ok(RefreshedHwpxPreviews::default());
        };
        if rgb.as_chunks::<3>().0.iter().all(|pixel| pixel == first) {
            // Blank-page evidence is independently checked for HWP5. HWPX has no equivalent
            // backend proof yet, so a uniform client raster cannot authorize a regenerated image.
            return Ok(RefreshedHwpxPreviews::default());
        }
        let Some(png) = preview::encode_png(width, height, &rgb) else {
            return Ok(RefreshedHwpxPreviews::default());
        };
        Some(png)
    } else {
        None
    };
    let text = stale_text.then(|| preview::RHWP_BLANK_PREVIEW_TEXT.to_vec());

    let mut entries = Vec::new();
    entries.try_reserve_exact(raw.order.len()).map_err(|_| {
        resources::allocation_refused();
        crate::document::DocumentError::ResourceLimit { limit: crate::document::LimitKind::FileSize }
    })?;
    for name in &raw.order {
        let Some((method, data)) = raw.parts.get(name) else {
            return Ok(RefreshedHwpxPreviews::default());
        };
        let source_xml = before
            .parts
            .get(name)
            .filter(|(_, source)| same_hwpx_xml(name, source, data));
        let (selected_method, selected_data) = source_xml
            .map(|(source_method, source)| (*source_method, source.as_slice()))
            .unwrap_or((*method, data.as_slice()));
        let replacement = match name.as_str() {
            HWPX_PREVIEW_IMAGE => image.as_deref(),
            HWPX_PREVIEW_TEXT => text.as_deref(),
            _ => None,
        };
        entries.push(crate::document::zip::WriteEntry {
            name,
            data: replacement.unwrap_or(selected_data),
            method: selected_method,
        });
    }
    let reserve = output.len()
        .checked_add(image.as_ref().map_or(0, Vec::len))
        .and_then(|size| size.checked_add(text.as_ref().map_or(0, Vec::len)))
        .ok_or(crate::document::DocumentError::ResourceLimit { limit: crate::document::LimitKind::FileSize })?;
    resources::charge(Category::Staging, reserve)?;
    let rebuilt = match crate::document::zip::write_archive(&entries, max_file_bytes) {
        Ok(bytes) => bytes,
        Err(crate::document::zip::ZipProblem::EntryCount
            | crate::document::zip::ZipProblem::MetadataSize
            | crate::document::zip::ZipProblem::PartSize) => {
                return Err(crate::document::DocumentError::ResourceLimit {
                    limit: crate::document::LimitKind::FileSize,
                })
            }
        Err(_) => return Ok(RefreshedHwpxPreviews::default()),
    };
    if rebuilt.len() as u64 > max_file_bytes {
        return Err(crate::document::DocumentError::ResourceLimit {
            limit: crate::document::LimitKind::FileSize,
        });
    }
    let Ok(rebuilt_package) = open(&rebuilt, Side::Output) else {
        return Ok(RefreshedHwpxPreviews::default());
    };
    if rebuilt_package.order != raw.order {
        return Ok(RefreshedHwpxPreviews::default());
    }
    for name in &raw.order {
        let Some((raw_method, raw_data)) = raw.parts.get(name) else {
            return Ok(RefreshedHwpxPreviews::default());
        };
        let source_xml = before
            .parts
            .get(name)
            .filter(|(_, source)| same_hwpx_xml(name, source, raw_data));
        let (expected_method, expected_data) = source_xml
            .map(|(source_method, source)| (*source_method, source.as_slice()))
            .unwrap_or((*raw_method, raw_data.as_slice()));
        let expected = match name.as_str() {
            HWPX_PREVIEW_IMAGE => image.as_deref(),
            HWPX_PREVIEW_TEXT => text.as_deref(),
            _ => None,
        }
        .unwrap_or(expected_data);
        if rebuilt_package
            .parts
            .get(name)
            .is_none_or(|(method, data)| *method != expected_method || data.as_slice() != expected)
        {
            return Ok(RefreshedHwpxPreviews::default());
        }
    }
    let final_findings = validate_hwpx(&before, &rebuilt_package)
        .into_iter()
        .chain(compare_saved_hwpx_with_previews(
            &before, &rebuilt_package, image.as_deref(), text.as_deref(),
        ))
        .chain(validate_hwpx_references(&rebuilt_package));
    if final_findings.into_iter().next().is_some() {
        return Ok(RefreshedHwpxPreviews::default());
    }
    Ok(RefreshedHwpxPreviews { output: Some(rebuilt), image, text })
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
/// HWPML core namespace (`hc:` margin children of `hh:paraPr`).
const HWPML_CORE: &str = "http://www.hancom.co.kr/hwpml/2011/core";

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
pub(super) fn serializer_color(value: &str) -> bool {
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
            let ancestor_paragraph = |back: usize| {
                stack
                    .len()
                    .checked_sub(back + 1)
                    .and_then(|i| stack.get(i))
                    .is_some_and(|a| a.paragraph)
            };
            let shape_leaf = |back: usize| {
                stack
                    .len()
                    .checked_sub(back + 1)
                    .and_then(|i| stack.get(i))
                    .is_some_and(|a| {
                        a.namespace.as_deref() == Some(HWPML_PARAGRAPH)
                            && matches!(
                                a.name.as_str(),
                                "rect" | "ellipse" | "line" | "polygon" | "curve"
                            )
                    })
            };
            let parent_paragraph = stack.last().is_some_and(|a| a.paragraph);
            let paragraph = !element.self_closing
                && element.namespace.as_deref() == Some(HWPML_PARAGRAPH)
                && element.name == "p"
                && ((stack.len() == 1 && is(0, HWPML_SECTION, "sec"))
                    || (is(0, HWPML_PARAGRAPH, "subList")
                        && ((is(1, HWPML_PARAGRAPH, "tc")
                            && is(2, HWPML_PARAGRAPH, "tr")
                            && is(3, HWPML_PARAGRAPH, "tbl")
                            && is(4, HWPML_PARAGRAPH, "run")
                            && ancestor_paragraph(5))
                            || (((is(1, HWPML_PARAGRAPH, "caption")
                                && (is(2, HWPML_PARAGRAPH, "pic") || shape_leaf(2)))
                                || (is(1, HWPML_PARAGRAPH, "drawText") && shape_leaf(2)))
                                && is(3, HWPML_PARAGRAPH, "run")
                                && ancestor_paragraph(4)))));
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

fn content_type_children(bytes: &[u8]) -> Option<FlatList> {
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
}

/// Picture insertion may append validated media and exactly their package metadata.
/// Original media/parts are still compared byte-for-byte. Existing relationship
/// bindings (including their attribute names and order) must remain unchanged.
fn pictures_appended(original: &Package, output: &Package) -> Option<Vec<String>> {
    const IMAGE_REL: &str =
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
    const REL_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    let added: Vec<String> = output
        .parts
        .keys()
        .filter(|name| !original.parts.contains_key(*name))
        .cloned()
        .collect();
    if added.is_empty() || added.len() > 256 {
        return None;
    }
    let mut defaults = Vec::new();
    let new_numbering = added.iter().any(|n| n == NUMBERING);
    if new_numbering && numbering_appended(original, output) != Some(true) {
        return None;
    }
    for name in added.iter().filter(|n| n.as_str() != NUMBERING) {
        let tail = name.strip_prefix("word/media/")?;
        if tail.contains('/') || tail.contains("..") {
            return None;
        }
        let ext = tail.rsplit('.').next()?;
        let mime = match ext {
            "png" => "image/png",
            "jpeg" | "jpg" => "image/jpeg",
            _ => return None,
        };
        let bytes = output.get(name)?;
        if !crate::picture::valid(bytes)
            || (ext == "png") != bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        {
            return None;
        }
        let attrs = vec![
            ("".into(), "Default".into()),
            ("ContentType".into(), mime.into()),
            ("Extension".into(), ext.into()),
        ];
        if !defaults.contains(&attrs) {
            defaults.push(attrs);
        }
    }
    let (root_a, types_a) = content_type_children(original.get(CONTENT_TYPES)?)?;
    let (root_b, types_b) = content_type_children(output.get(CONTENT_TYPES)?)?;
    defaults.retain(|a| !types_a.contains(a));
    if new_numbering {
        defaults.push(vec![
            ("".into(), "Override".into()),
            ("ContentType".into(), NUMBERING_PART.3.into()),
            ("PartName".into(), format!("/{NUMBERING}")),
        ]);
    }
    if root_a != root_b || !multiset_plus(&types_a, &types_b, &defaults) {
        return None;
    }
    let (root_a, rels_a) = flat_children(
        original.get(DOCUMENT_RELS)?,
        OPC_RELATIONSHIPS,
        "Relationships",
        "Relationship",
        "",
    )?;
    let (root_b, rels_b) = flat_children(
        output.get(DOCUMENT_RELS)?,
        OPC_RELATIONSHIPS,
        "Relationships",
        "Relationship",
        "",
    )?;
    if root_a != root_b {
        return None;
    }
    let attr = |a: &Attrs, key: &str| a.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
    let without_ids = |rels: &[Attrs]| {
        rels.iter()
            .map(|a| a.iter().filter(|(k, _)| k != "Id").cloned().collect())
            .collect::<Vec<Attrs>>()
    };
    let expected: Vec<Attrs> = added
        .iter()
        .map(|name| {
            vec![
                (
                    "Target".into(),
                    name.strip_prefix("word/").unwrap_or("").into(),
                ),
                (
                    "Type".into(),
                    if name == NUMBERING {
                        NUMBERING_PART.2.into()
                    } else {
                        IMAGE_REL.into()
                    },
                ),
            ]
        })
        .collect();
    if !multiset_plus(&without_ids(&rels_a), &without_ids(&rels_b), &expected) {
        return None;
    }
    // Refuse duplicate/missing IDs before resolving any reference.
    for rels in [&rels_a, &rels_b] {
        let mut ids = std::collections::BTreeSet::new();
        for a in rels {
            let id = attr(a, "Id")?;
            if id.is_empty() || !ids.insert(id) {
                return None;
            }
        }
    }
    type Bindings = (
        Vec<(String, String, String, Attrs)>,
        std::collections::BTreeSet<String>,
    );
    let bindings = |pkg: &Package, rels: &[Attrs], ignore_new: bool| -> Option<Bindings> {
        let mut bindings = Vec::new();
        let mut used = std::collections::BTreeSet::new();
        for event in xml::canonical(pkg.get("word/document.xml")?).ok()? {
            if let xml::Canonical::Start {
                namespace,
                name,
                attributes,
            } = event
            {
                for (ns, key, id) in attributes {
                    if ns.as_deref() != Some(REL_NS) {
                        continue;
                    }
                    let rel = rels
                        .iter()
                        .find(|a| attr(a, "Id").as_deref() == Some(id.as_str()))?;
                    let target = format!("word/{}", attr(rel, "Target")?);
                    if ignore_new && added.contains(&target) {
                        if namespace.as_deref()
                            != Some("http://schemas.openxmlformats.org/drawingml/2006/main")
                            || name != "blip"
                            || key != "embed"
                        {
                            return None;
                        }
                        used.insert(target);
                        continue;
                    }
                    bindings.push((
                        namespace.as_deref().unwrap_or("").to_owned(),
                        name.to_string(),
                        key.to_string(),
                        rel.iter().filter(|(k, _)| k != "Id").cloned().collect(),
                    ));
                }
            }
        }
        Some((bindings, used))
    };
    let (before, _) = bindings(original, &rels_a, false)?;
    let (after, used) = bindings(output, &rels_b, true)?;
    (before == after
        && added
            .iter()
            .all(|name| name == NUMBERING || used.contains(name)))
    .then_some(added)
}

struct TableMediaChanges {
    removed_media: Vec<String>,
    content_types_changed: bool,
}

/// Narrow T009 proof for authorized media removal caused by deleting table rows/columns or (Stage 3)
/// deleting a body picture: permits removing `word/media/*` parts (and matching
/// `word/_rels/document.xml.rels` / `[Content_Types].xml` entries, or pure `IMAGE_REL` ID renumbering
/// when shared/unchanged media remain) only when every removed resource was bound exclusively by
/// `<a:blip r:embed="..."/>` inside `<w:tbl>` or inside a `<w:drawing>` of `original`'s
/// `word/document.xml`, no other `.rels` part references it, no
/// non-table/non-image bindings changed or were omitted, and no surviving `.rels` references it.
/// Validates removed-media ownership at the package XML/rels level (not independent UI command history);
/// when no media parts are removed, `[Content_Types].xml` is never exempted and non-image relationships
/// must retain exact IDs.
fn authorized_table_media_changes(original: &Package, output: &Package) -> Option<TableMediaChanges> {
    const IMAGE_REL: &str =
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
    const REL_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const WORD_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const DRAWING_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";

    if output.parts.keys().any(|n| !original.parts.contains_key(n)) {
        return None;
    }
    let removed: Vec<String> = original
        .parts
        .keys()
        .filter(|n| !output.parts.contains_key(*n))
        .cloned()
        .collect();
    if removed.len() > 256 {
        return None;
    }
    let mut removed_exts = std::collections::BTreeSet::new();
    for name in &removed {
        let tail = name.strip_prefix("word/media/")?;
        if tail.is_empty() || tail.contains('/') || tail.contains("..") {
            return None;
        }
        let ext = tail.rsplit('.').next()?.to_ascii_lowercase();
        if !matches!(
            ext.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "tif" | "tiff" | "svg" | "emf" | "wmf" | "ico"
        ) {
            return None;
        }
        removed_exts.insert(ext);
    }
    fn attr<'a>(a: &'a Attrs, key: &str) -> Option<&'a str> {
        a.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
    // Ensure no other .rels (headers, footers, comments, notes, etc.) references any removed media,
    // and no surviving .rels in output references any removed media.
    for (pkg, skip_doc) in [(original, true), (output, false)] {
        for (rels_name, (_, data)) in &pkg.parts {
            if !rels_name.ends_with(".rels") || (skip_doc && rels_name == DOCUMENT_RELS) {
                continue;
            }
            let rels = xml::relationships(data).ok()?;
            for r in rels.iter().filter(|r| !r.external) {
                if let Some(target) = resolve(rels_name, &r.target) {
                    if removed.iter().any(|m| m.eq_ignore_ascii_case(&target)) {
                        return None;
                    }
                }
            }
        }
    }
    // Validate [Content_Types].xml changes only when media parts are actually removed.
    // When no media is removed, content_types_changed stays false so compare() checks it strictly.
    let mut content_types_changed = false;
    if !removed.is_empty() {
        let (root_a, types_a) = content_type_children(original.get(CONTENT_TYPES)?)?;
        let (root_b, types_b) = content_type_children(output.get(CONTENT_TYPES)?)?;
        if root_a != root_b {
            return None;
        }
        let mut remaining_b = types_b.clone();
        let mut omitted_types = Vec::new();
        for entry in &types_a {
            if let Some(pos) = remaining_b.iter().position(|e| e == entry) {
                remaining_b.swap_remove(pos);
            } else {
                omitted_types.push(entry);
            }
        }
        if !remaining_b.is_empty() {
            return None;
        }
        content_types_changed = !omitted_types.is_empty();
        for entry in omitted_types {
            let tag = attr(entry, "");
            if tag == Some("Default") {
                let ext = attr(entry, "Extension")?.to_ascii_lowercase();
                if !removed_exts.contains(&ext) {
                    return None;
                }
                let ext_still_used = output
                    .parts
                    .keys()
                    .any(|p| p.rsplit('.').next().is_some_and(|e| e.eq_ignore_ascii_case(&ext)));
                if ext_still_used {
                    return None;
                }
            } else if tag == Some("Override") {
                let part = attr(entry, "PartName")?.strip_prefix('/')?;
                if !removed.iter().any(|r| r == part) {
                    return None;
                }
            } else {
                return None;
            }
        }
    }
    let (root_a, rels_a) = flat_children(
        original.get(DOCUMENT_RELS)?,
        OPC_RELATIONSHIPS,
        "Relationships",
        "Relationship",
        "",
    )?;
    let (root_b, rels_b) = flat_children(
        output.get(DOCUMENT_RELS)?,
        OPC_RELATIONSHIPS,
        "Relationships",
        "Relationship",
        "",
    )?;
    if root_a != root_b {
        return None;
    }
    // Check ID validity and verify only IMAGE_REL entries pointing at `removed` may leave document.xml.rels.
    for rels in [&rels_a, &rels_b] {
        let mut ids = std::collections::BTreeSet::new();
        for a in rels {
            let id = attr(a, "Id")?;
            if id.is_empty() || !ids.insert(id) {
                return None;
            }
        }
    }
    let without_id = |a: &Attrs| -> Attrs {
        a.iter().filter(|(k, _)| k != "Id").cloned().collect()
    };
    let mut rem_b: Vec<Attrs> = rels_b.iter().map(without_id).collect();
    let mut omitted_rels: Vec<Attrs> = Vec::new();
    for entry in rels_a.iter().map(without_id) {
        if let Some(pos) = rem_b.iter().position(|e| *e == entry) {
            rem_b.swap_remove(pos);
        } else {
            omitted_rels.push(entry);
        }
    }
    if !rem_b.is_empty() {
        return None;
    }
    for rel in &omitted_rels {
        let external = attr(rel, "TargetMode").is_some_and(|m| m.eq_ignore_ascii_case("External"));
        if external || attr(rel, "Type") != Some(IMAGE_REL) {
            return None;
        }
        let target = resolve(DOCUMENT_RELS, attr(rel, "Target")?)?;
        if !removed.iter().any(|m| m == &target) {
            return None;
        }
    }
    if removed.is_empty() {
        if original.get(DOCUMENT_RELS) == output.get(DOCUMENT_RELS) {
            return None;
        }
        // Pure relationship renumbering without media removal must keep non-image rels identical (including Id).
        for orig_rel in &rels_a {
            if attr(orig_rel, "Type") != Some(IMAGE_REL) && !rels_b.contains(orig_rel) {
                return None;
            }
        }
    }
    // Walk word/document.xml bindings with table nesting depth.
    type Binding = (String, String, String, Attrs);
    let doc_bindings = |pkg: &Package, rels: &[Attrs]| -> Option<Vec<(bool, Option<String>, Binding)>> {
        let mut out = Vec::new();
        // (is `w:tbl`, is `w:drawing`) per open element.
        let mut tbl_stack: Vec<(bool, bool)> = Vec::new();
        let mut tbl_depth = 0usize;
        let mut drawing_depth = 0usize;
        for event in xml::canonical(pkg.get("word/document.xml")?).ok()? {
            match event {
                xml::Canonical::Start {
                    namespace,
                    name,
                    attributes,
                } => {
                    let is_tbl = namespace.as_deref() == Some(WORD_NS) && name.as_str() == "tbl";
                    let is_drawing =
                        namespace.as_deref() == Some(WORD_NS) && name.as_str() == "drawing";
                    if is_tbl {
                        tbl_depth += 1;
                    }
                    if is_drawing {
                        drawing_depth += 1;
                    }
                    tbl_stack.push((is_tbl, is_drawing));
                    // A removable binding: in a table (row/column deletion) or in a drawing (picture deletion).
                    let in_tbl = tbl_depth > 0 || drawing_depth > 0;
                    for (ns, key, id) in attributes {
                        if ns.as_deref() != Some(REL_NS) {
                            continue;
                        }
                        let rel = rels.iter().find(|a| attr(a, "Id") == Some(id.as_str()))?;
                        let external =
                            attr(rel, "TargetMode").is_some_and(|m| m.eq_ignore_ascii_case("External"));
                        let resolved_img = (!external && attr(rel, "Type") == Some(IMAGE_REL))
                            .then(|| attr(rel, "Target").and_then(|t| resolve(DOCUMENT_RELS, t)))
                            .flatten();
                        out.push((
                            in_tbl,
                            resolved_img,
                            (
                                namespace.as_deref().unwrap_or("").to_string(),
                                name.as_str().to_string(),
                                key.as_str().to_string(),
                                without_id(rel),
                            ),
                        ));
                    }
                }
                xml::Canonical::End => {
                    let (was_tbl, was_drawing) = tbl_stack.pop().unwrap_or((false, false));
                    if was_tbl {
                        tbl_depth -= 1;
                    }
                    if was_drawing {
                        drawing_depth -= 1;
                    }
                }
                xml::Canonical::Text(_)
                | xml::Canonical::Comment(_)
                | xml::Canonical::Instruction(_) => {}
            }
        }
        Some(out)
    };
    let before = doc_bindings(original, &rels_a)?;
    let after = doc_bindings(output, &rels_b)?;
    let mut after_idx = 0usize;
    let mut removed_seen = std::collections::BTreeSet::new();
    for (in_tbl, resolved_img, binding) in &before {
        if after.get(after_idx).is_some_and(|(_, _, ab)| ab == binding) {
            after_idx += 1;
        } else {
            // Only `<a:blip r:embed="..."/>` inside `<w:tbl>` or `<w:drawing>` targeting `word/media/*` may be omitted.
            let target = resolved_img.as_deref()?;
            if !*in_tbl
                || binding.0 != DRAWING_NS
                || binding.1 != "blip"
                || binding.2 != "embed"
                || !target.starts_with("word/media/")
            {
                return None;
            }
            if removed.iter().any(|r| r == target) {
                removed_seen.insert(target.to_string());
            }
        }
    }
    if after_idx != after.len() {
        return None;
    }
    if !removed.iter().all(|r| removed_seen.contains(r)) {
        return None;
    }
    Some(TableMediaChanges {
        removed_media: removed,
        content_types_changed,
    })
}

const NUMBERING: &str = "word/numbering.xml";
const NUMBERING_PART: Addable = (
    NUMBERING,
    "numbering.xml",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
);

/// Only the pinned serializer's standard bullet definition/instance may be
/// appended. Every original XML definition remains exactly equal, including
/// unknown properties; the engine's parser alone cannot prove preservation.
fn numbering_appended(original: &Package, output: &Package) -> Option<bool> {
    if original.get(NUMBERING) == output.get(NUMBERING) {
        return Some(false);
    }
    type Unit = (String, u32, Vec<xml::Canonical>);
    fn units(bytes: &[u8]) -> Option<(xml::Canonical, Vec<Unit>)> {
        let (events, _) = xml::canonical_with_payload_limit(bytes, Some(4 * 1024 * 1024)).ok()?;
        let mut iter = events.into_iter();
        let root = iter.next()?;
        if !matches!(&root, xml::Canonical::Start { namespace: Some(ns), name, .. } if ns == WML && name == "numbering")
        {
            return None;
        }
        let mut units = Vec::new();
        let mut ids = std::collections::BTreeSet::new();
        loop {
            let event = iter.next()?;
            if event == xml::Canonical::End {
                break;
            }
            let xml::Canonical::Start {
                namespace: Some(ns),
                name,
                attributes,
            } = &event
            else {
                return None;
            };
            if ns != WML || !matches!(name.as_str(), "abstractNum" | "num") || attributes.len() != 1
            {
                return None;
            }
            let key = if name == "num" {
                "numId"
            } else {
                "abstractNumId"
            };
            let (ns, k, value) = attributes.first()?;
            if ns.as_deref() != Some(WML) || k != key {
                return None;
            }
            let id = value.parse::<u32>().ok()?;
            if value.as_str() != id.to_string() || !ids.insert((name.to_string(), id)) {
                return None;
            }
            let kind = name.to_string();
            let mut subtree = vec![event];
            let mut depth = 1;
            while depth > 0 {
                let e = iter.next()?;
                match &e {
                    xml::Canonical::Start { .. } => depth += 1,
                    xml::Canonical::End => depth -= 1,
                    _ => {}
                }
                subtree.push(e);
            }
            units.push((kind, id, subtree));
        }
        iter.next().is_none().then_some((root, units))
    }
    let (root, after) = units(output.get(NUMBERING)?)?;
    let before = match original.get(NUMBERING) {
        Some(bytes) => {
            let (old_root, old) = units(bytes)?;
            if old_root != root {
                return None;
            }
            old
        }
        None => Vec::new(),
    };
    if !before.iter().all(|old| after.contains(old)) {
        return None;
    }
    let extra: Vec<_> = after.iter().filter(|unit| !before.contains(unit)).collect();
    if extra.is_empty() {
        return Some(true);
    }
    // Stage 1: any bounded number of new definitions/instances, each exactly a pinned-serializer unit:
    // an abstract list is one of the engine's built-in list kinds (`levels_for`), and an instance points at an
    // existing or new abstract list, either plainly or as a restart (start overrides equal to that abstract's level
    // starts). Every new abstract list is used by an instance. Nothing else in the part may change.
    if extra.len() > 64 {
        return None;
    }
    use wordcraft_engine::doc::numbering::{levels_for, AbstractNum, ListKind, Num};
    let render = |abstracts: Vec<AbstractNum>, nums: Vec<Num>| -> Option<Vec<Unit>> {
        let mut template = wordcraft_engine::blank_document(&Default::default());
        template.numbering.abstracts = abstracts;
        template.numbering.nums = nums;
        let bytes = wordcraft_engine::io::save_bytes("x.docx", &template).ok()?;
        let pkg = open(&bytes, Side::Output).ok()?;
        Some(units(pkg.get(NUMBERING)?)?.1)
    };
    let mut kinds = vec![
        ListKind::Bullet,
        ListKind::Numbered,
        ListKind::NumberedParen,
        ListKind::Outline,
        ListKind::UpperLetter,
        ListKind::LowerLetter,
        ListKind::LowerLetterDot,
        ListKind::LowerRoman,
        ListKind::Legal,
    ];
    kinds.extend(['○', '▪', '–', '✓', '•'].map(ListKind::BulletChar));
    let mut used = std::collections::BTreeSet::new();
    for unit in &extra {
        match unit.0.as_str() {
            "abstractNum" => {
                let candidates: Vec<AbstractNum> = kinds
                    .iter()
                    .map(|kind| AbstractNum { id: unit.1, levels: levels_for(*kind), ..Default::default() })
                    .collect();
                // One rendering per kind (each in its own template: same id).
                if !candidates
                    .into_iter()
                    .any(|candidate| render(vec![candidate], Vec::new()).is_some_and(|u| u.contains(unit)))
                {
                    return None;
                }
            }
            "num" => {
                if unit.1 == 0 {
                    return None;
                }
                let (abstract_id, start_overrides) = num_unit_fields(&unit.2)?;
                if !after.iter().any(|u| u.0 == "abstractNum" && u.1 == abstract_id) {
                    return None;
                }
                let candidate = Num { id: unit.1, abstract_id, start_overrides, ..Default::default() };
                if !render(Vec::new(), vec![candidate]).is_some_and(|u| u.contains(unit)) {
                    return None;
                }
                used.insert(abstract_id);
            }
            _ => return None,
        }
    }
    for unit in after.iter().filter(|u| u.0 == "num") {
        used.insert(num_unit_fields(&unit.2)?.0);
    }
    if original.get(NUMBERING).is_none() {
        let mut template = wordcraft_engine::blank_document(&Default::default());
        template.numbering.abstracts = vec![AbstractNum { id: 0, levels: levels_for(ListKind::Bullet), ..Default::default() }];
        template.numbering.nums = vec![Num { id: 1, abstract_id: 0, ..Default::default() }];
        let bytes = wordcraft_engine::io::save_bytes("x.docx", &template).ok()?;
        let pkg = open(&bytes, Side::Output).ok()?;
        if root != units(pkg.get(NUMBERING)?)?.0 {
            return None;
        }
    }
    Some(
        extra
            .iter()
            .filter(|u| u.0 == "abstractNum")
            .all(|u| used.contains(&u.1)),
    )
}

/// `w:abstractNumId` and `w:lvlOverride/w:startOverride` values of a canonical `w:num` unit (bounded levels/values).
/// Other children are left to the exact serializer comparison.
fn num_unit_fields(events: &[xml::Canonical]) -> Option<(u32, Vec<(u8, u32)>)> {
    let value = |event: &xml::Canonical| -> Option<u32> {
        let xml::Canonical::Start { attributes, .. } = event else { return None };
        let (_, _, v) = attributes.iter().find(|(ns, k, _)| ns.as_deref() == Some(WML) && k == "val")?;
        v.parse().ok().filter(|n: &u32| v.as_str() == n.to_string())
    };
    let named = |event: &xml::Canonical, want: &str| {
        matches!(event, xml::Canonical::Start { namespace: Some(ns), name, .. } if ns == WML && name == want)
    };
    let mut abstract_id = None;
    let mut overrides = Vec::new();
    let mut level: Option<u8> = None;
    for event in events {
        if named(event, "abstractNumId") {
            abstract_id = Some(value(event)?);
        } else if named(event, "lvlOverride") {
            let xml::Canonical::Start { attributes, .. } = event else { return None };
            let (_, _, v) = attributes.iter().find(|(ns, k, _)| ns.as_deref() == Some(WML) && k == "ilvl")?;
            level = Some(v.parse::<u8>().ok().filter(|l| *l <= 8)?);
        } else if named(event, "startOverride") {
            let start = value(event).filter(|v| *v <= 32_767)?;
            overrides.push((level?, start));
        }
    }
    Some((abstract_id?, overrides))
}

/// RHWP createTable appends this one solid border when none can be reused.
/// Compare all original header events, not their lossy engine representation.
fn hwpx_table_border_appended(before: &[u8], after: &[u8], output: &Package) -> Option<bool> {
    fn split(bytes: &[u8]) -> Option<(Vec<xml::Canonical>, Vec<Vec<xml::Canonical>>, u32)> {
        let (mut events, _) =
            xml::canonical_with_payload_limit(bytes, Some(4 * 1024 * 1024)).ok()?;
        let index = events.iter().position(|e| is_head(e, "borderFills"))?;
        if events
            .iter()
            .skip(index + 1)
            .any(|e| is_head(e, "borderFills"))
        {
            return None;
        }
        let count = plain_attribute(&events[index], "itemCnt")?
            .parse::<u32>()
            .ok()?;
        if count > 65535 {
            return None;
        }
        if let xml::Canonical::Start { attributes, .. } = &mut events[index] {
            attributes.retain(|(ns, k, _)| !(ns.is_none() && k == "itemCnt"));
        }
        let mut end = index + 1;
        let mut defs = Vec::new();
        while events.get(end)? != &xml::Canonical::End {
            let start = end;
            if !is_head(events.get(start)?, "borderFill") {
                return None;
            }
            let id = plain_attribute(events.get(start)?, "id")?
                .parse::<u32>()
                .ok()?;
            if id != defs.len() as u32 + 1 {
                return None;
            }
            let mut depth = 1;
            end += 1;
            while depth > 0 {
                match events.get(end)? {
                    xml::Canonical::Start { .. } => depth += 1,
                    xml::Canonical::End => depth -= 1,
                    _ => {}
                }
                end += 1;
            }
            defs.push(events[start..end].to_vec());
        }
        if defs.len() != count as usize {
            return None;
        }
        events.drain(index + 1..end);
        Some((events, defs, count))
    }
    let (a, old, n) = split(before)?;
    let (b, new, total) = split(after)?;
    if a != b || total <= n || new.get(..old.len())? != old {
        return None;
    }
    verify_appended_border_fills(&old, &new[old.len()..], output)
}

fn hwpx_pictures_appended(original: &Package, output: &Package) -> Option<Vec<String>> {
    const MANIFEST: &str = "Contents/content.hpf";
    const OPF: &str = "http://www.idpf.org/2007/opf/";
    let added: Vec<String> = output
        .parts
        .keys()
        .filter(|n| !original.parts.contains_key(*n))
        .cloned()
        .collect();
    if added.is_empty() || added.len() > 256 {
        return None;
    }
    let (a, _) =
        xml::canonical_with_payload_limit(original.get(MANIFEST)?, Some(4 * 1024 * 1024)).ok()?;
    let (b, _) =
        xml::canonical_with_payload_limit(output.get(MANIFEST)?, Some(4 * 1024 * 1024)).ok()?;
    let mut expected = Vec::new();
    let mut ids = std::collections::BTreeSet::new();
    for e in &a {
        if let xml::Canonical::Start {
            namespace: Some(ns),
            name,
            ..
        } = e
        {
            if ns == OPF && name == "item" {
                ids.insert(plain_attribute(e, "id")?.to_owned());
            }
        }
    }
    for name in &added {
        let tail = name.strip_prefix("BinData/")?;
        let (id, ext) = tail.rsplit_once('.')?;
        if !id
            .strip_prefix("image")?
            .bytes()
            .all(|b| b.is_ascii_digit())
            || id.len() <= 5
            || !ids.insert(id.to_owned())
        {
            return None;
        }
        let mime = match ext {
            "png" => "image/png",
            "jpeg" | "jpg" => "image/jpeg",
            _ => return None,
        };
        let bytes = output.get(name)?;
        if !crate::picture::valid(bytes)
            || (ext == "png") != bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        {
            return None;
        }
        let item = format!(
            r#"<opf:item xmlns:opf="{OPF}" id="{id}" href="{name}" media-type="{mime}" isEmbeded="1"/>"#
        );
        expected.push((id.to_owned(), xml::canonical(item.as_bytes()).ok()?));
    }
    let mut rest = Vec::new();
    let mut iter = b.into_iter();
    let mut seen = std::collections::BTreeSet::new();
    let mut stack = Vec::new();
    while let Some(e) = iter.next() {
        let matching = expected
            .iter()
            .find(|(_, events)| events.first() == Some(&e));
        if let Some((id, _)) = matching {
            if stack.last() != Some(&true)
                || !seen.insert(id.clone())
                || iter.next()? != xml::Canonical::End
            {
                return None;
            }
        } else {
            match &e {
                xml::Canonical::Start {
                    namespace, name, ..
                } => stack.push(namespace.as_deref() == Some(OPF) && name == "manifest"),
                xml::Canonical::End => {
                    stack.pop()?;
                }
                _ => {}
            }
            rest.push(e);
        }
    }
    if rest != a || seen.len() != added.len() {
        return None;
    }
    let mut used = std::collections::BTreeSet::new();
    for (name, (_, bytes)) in &output.parts {
        if !hwpx_body(name) {
            continue;
        }
        for e in xml::canonical(bytes).ok()? {
            if let xml::Canonical::Start {
                namespace: Some(ns),
                name,
                ..
            } = &e
            {
                if ns == "http://www.hancom.co.kr/hwpml/2011/core" && name == "img" {
                    let id = plain_attribute(&e, "binaryItemIDRef")?;
                    if expected.iter().any(|(wanted, _)| id == wanted) {
                        used.insert(id.to_owned());
                    }
                }
            }
        }
    }
    expected
        .iter()
        .all(|(id, _)| used.contains(id))
        .then_some(added)
}

/// Standard bullets clone an existing paragraph shape, changing only its
/// heading. All original definitions and all other header content stay equal.
fn hwpx_bullets_appended(before: &[u8], after: &[u8], output: &Package) -> Option<bool> {
    type Lists = BTreeMap<String, Vec<Vec<xml::Canonical>>>;
    fn split(bytes: &[u8]) -> Option<(Vec<xml::Canonical>, Lists)> {
        let (events, _) = xml::canonical_with_payload_limit(bytes, Some(4 * 1024 * 1024)).ok()?;
        let mut iter = events.into_iter();
        let mut skeleton = Vec::new();
        let mut lists = BTreeMap::new();
        let mut parents = Vec::new();
        while let Some(event) = iter.next() {
            if let xml::Canonical::Start {
                namespace: Some(ns),
                name,
                attributes,
            } = &event
            {
                if ns == HWPML_HEAD
                    && matches!(name.as_str(), "paraProperties" | "bullets" | "borderFills" | "numberings")
                {
                    if parents.last() != Some(&true)
                        || attributes.len() != 1
                        || lists.contains_key(name.as_str())
                    {
                        return None;
                    }
                    let count = plain_attribute(&event, "itemCnt")?.parse::<usize>().ok()?;
                    if count > 65535 {
                        return None;
                    }
                    let child = match name.as_str() {
                        "bullets" => "bullet",
                        "borderFills" => "borderFill",
                        "numberings" => "numbering",
                        _ => "paraPr",
                    };
                    let first_id = if name == "paraProperties" { 0 } else { 1 };
                    let mut defs = Vec::new();
                    loop {
                        let e = iter.next()?;
                        if e == xml::Canonical::End {
                            break;
                        }
                        if !is_head(&e, child)
                            || plain_attribute(&e, "id")?.parse::<usize>().ok()?
                                != defs.len() + first_id
                        {
                            return None;
                        }
                        let mut subtree = vec![e];
                        let mut depth = 1;
                        while depth > 0 {
                            let e = iter.next()?;
                            match e {
                                xml::Canonical::Start { .. } => depth += 1,
                                xml::Canonical::End => depth -= 1,
                                _ => {}
                            }
                            subtree.push(e);
                        }
                        defs.push(subtree);
                    }
                    if defs.len() != count {
                        return None;
                    }
                    lists.insert(name.to_string(), defs);
                    continue;
                }
            }
            match &event {
                xml::Canonical::Start { .. } => parents.push(is_head(&event, "refList")),
                xml::Canonical::End => {
                    parents.pop()?;
                }
                _ => {}
            }
            skeleton.push(event);
        }
        Some((skeleton, lists))
    }
    fn signature(
        def: &[xml::Canonical],
        appended: bool,
        bullet_count: usize,
        numbering_count: usize,
    ) -> Option<Vec<xml::Canonical>> {
        let mut result = Vec::new();
        let mut iter = def.iter().cloned();
        let mut root = iter.next()?;
        if let xml::Canonical::Start { attributes, .. } = &mut root {
            attributes.retain(|(ns, k, _)| !(ns.is_none() && k == "id"));
        }
        result.push(root);
        let mut heading = false;
        while let Some(mut e) = iter.next() {
            // Stage 1 paragraph values: alignment, margins/indent/spacing and line spacing are values
            // of fixed elements; appended values must have the pinned serializer's form.
            if let xml::Canonical::Start { namespace: Some(ns), name, attributes } = &mut e {
                let integer = |v: &str| {
                    let digits = v.strip_prefix('-').unwrap_or(v);
                    !digits.is_empty() && digits.len() <= 7 && digits.bytes().all(|b| b.is_ascii_digit())
                        && (digits == "0" || !digits.starts_with('0')) && v != "-0"
                };
                let mut take = |key: &str, ok: &dyn Fn(&str) -> bool| -> Option<()> {
                    let mut found = attributes.iter().filter(|(n, k, _)| n.is_none() && k == key);
                    match (found.next(), found.next()) {
                        (Some((_, _, v)), None) if !appended || ok(v) => {}
                        (None, _) => {}
                        _ => return None,
                    }
                    attributes.retain(|(n, k, _)| !(n.is_none() && k == key));
                    Some(())
                };
                if ns == HWPML_HEAD && name == "align" {
                    take("horizontal", &|v| {
                        ["JUSTIFY", "LEFT", "RIGHT", "CENTER", "DISTRIBUTE", "DISTRIBUTE_SPACE"].contains(&v)
                    })?;
                } else if ns == HWPML_HEAD && name == "lineSpacing" {
                    take("type", &|v| ["PERCENT", "FIXED", "BETWEEN_LINES", "AT_LEAST"].contains(&v))?;
                    take("value", &integer)?;
                } else if ns == HWPML_CORE
                    && matches!(name.as_str(), "intent" | "left" | "right" | "prev" | "next")
                {
                    take("value", &integer)?;
                }
            }
            if is_head(&e, "heading") {
                if heading || iter.next()? != xml::Canonical::End {
                    return None;
                }
                heading = true;
                if appended {
                    let kind = plain_attribute(&e, "type")?;
                    let id = plain_attribute(&e, "idRef")?.parse::<usize>().ok()?;
                    let level = plain_attribute(&e, "level")?;
                    // Stage 1 lists: bullet or numbered heading at levels 0-6; none at level 0.
                    let level_ok = matches!(level, "0" | "1" | "2" | "3" | "4" | "5" | "6");
                    if !level_ok
                        || !((kind == "BULLET" && id > 0 && id <= bullet_count)
                            || (kind == "NUMBER" && id > 0 && id <= numbering_count)
                            || (kind == "NONE" && id == 0 && level == "0"))
                    {
                        return None;
                    }
                    let xml::Canonical::Start { attributes, .. } = &e else {
                        return None;
                    };
                    if attributes.len() != 3 {
                        return None;
                    }
                }
            } else {
                result.push(e);
            }
        }
        heading.then_some(result)
    }
    let (a, old) = split(before)?;
    let (b, new) = split(after)?;
    if a != b {
        return None;
    }
    // A new HWPX can omit the empty list entirely. Absence represents zero
    // definitions; the exact append shape, unchanged prefix and body-reference
    // Stage 2: borderFill definitions can grow monotonically either by one default
    // table border (tbl/tc) or by bounded cell-formatting borderFills (tc only).
    let empty = Vec::new();
    let old_borders = old.get("borderFills").unwrap_or(&empty);
    let borders = new.get("borderFills").unwrap_or(&empty);
    if borders.len() < old_borders.len()
        || borders.get(..old_borders.len())? != old_borders
    {
        return None;
    }
    if borders.len() > old_borders.len() {
        if verify_appended_border_fills(old_borders, &borders[old_borders.len()..], output)
            != Some(true)
        {
            return None;
        }
    }
    let old_bullets = old.get("bullets").unwrap_or(&empty);
    let bullets = new.get("bullets").unwrap_or(&empty);
    if bullets.len() < old_bullets.len()
        || bullets.len() > old_bullets.len() + 1
        || bullets.get(..old_bullets.len())? != old_bullets
    {
        return None;
    }
    if let Some(extra) = bullets.get(old_bullets.len()) {
        let id = bullets.len();
        // The standard bullet or one of the Stage 1 custom bullet characters, in the serializer's form.
        let matches = ["•", "○", "▪", "–", "✓"].iter().any(|ch| {
            let expected = format!(
                r#"<hh:bullet xmlns:hh="{HWPML_HEAD}" id="{id}" char="{ch}" useImage="0"><hh:paraHead level="0" align="LEFT" useInstWidth="0" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="0" checkable="0"/></hh:bullet>"#
            );
            xml::canonical(expected.as_bytes()).ok().as_ref() == Some(extra)
        });
        if !matches {
            return None;
        }
    }
    // Stage 1 numbering definitions: original ones unchanged, appended ones in the createNumbering serializer form.
    let old_numberings = old.get("numberings").unwrap_or(&empty);
    let numberings = new.get("numberings").unwrap_or(&empty);
    if numberings.len() < old_numberings.len()
        || numberings.len() - old_numberings.len() > 64
        || numberings.get(..old_numberings.len())? != old_numberings
    {
        return None;
    }
    for def in numberings.iter().skip(old_numberings.len()) {
        if !hwpx_appended_numbering(def) {
            return None;
        }
    }
    let old_paras = old.get("paraProperties")?;
    let paras = new.get("paraProperties")?;
    if paras.len() < old_paras.len()
        || paras.len() - old_paras.len() > 256
        || paras.get(..old_paras.len())? != old_paras
    {
        return None;
    }
    let bases: Vec<_> = old_paras
        .iter()
        .map(|p| signature(p, false, bullets.len(), numberings.len()))
        .collect::<Option<_>>()?;
    for p in paras.iter().skip(old_paras.len()) {
        if !bases.contains(&signature(p, true, bullets.len(), numberings.len())?) {
            return None;
        }
    }
    // The ordinary output reference validator checks paragraph shape references.
    Some(true)
}

/// Stage 1 (P1-C): character-shape/font appends and paragraph/list appends made before one save. Each half is proved
/// by its existing rule through an intermediate header `mid` = the output header with its `hh:fontfaces` and
/// `hh:charProperties` lists replaced by the original's (byte splice of those two `hh:refList` children only):
/// - `hwpx_bullets_appended(original, mid)`: everything except paragraph shapes, bullets, numberings and the first
///   table border is equal to the original (including both character lists, which are the original's), and every
///   appended paragraph shape/bullet/numbering has its authorized form and valid ids;
/// - `header_equal_or_appended(mid, output)`: everything except the font tables and character shapes is equal to
///   `mid` (so the paragraph/list lists are exactly the ones proved above), and the character/font changes are the
///   authorized appends to the original's lists.
///
/// Together the output differs from the original only by the union of the two authorized changes. Malformed,
/// duplicated or missing lists, and any other difference, refuse (fall back to the single-change rules).
fn hwpx_combined_appended(before: &[u8], after: &[u8], output: &Package) -> bool {
    let Some(mid) = hwpx_with_char_lists_of(before, after) else {
        return false;
    };
    mid != after
        && mid != before
        && hwpx_bullets_appended(before, &mid, output) == Some(true)
        && super::special::header_equal_or_appended(&mid, after, output)
}

/// `target` with its `hh:refList`/`hh:fontfaces` and `hh:refList`/`hh:charProperties` elements replaced by those of
/// `source` (each present exactly once in both, or absent from both). UTF-8 documents only.
fn hwpx_with_char_lists_of(source: &[u8], target: &[u8]) -> Option<Vec<u8>> {
    let (source, target) = (std::str::from_utf8(source).ok()?, std::str::from_utf8(target).ok()?);
    let (from, to) = (hwpx_ref_list_spans(source)?, hwpx_ref_list_spans(target)?);
    let mut pairs = Vec::new();
    for name in ["fontfaces", "charProperties"] {
        match (from.get(name), to.get(name)) {
            (Some(a), Some(b)) => pairs.push((a.clone(), b.clone())),
            (None, None) => {}
            _ => return None,
        }
    }
    pairs.sort_by_key(|(_, b)| std::cmp::Reverse(b.start));
    let mut out = target.to_string();
    for (a, b) in pairs {
        out.replace_range(b, source.get(a)?);
    }
    Some(out.into_bytes())
}

/// Byte ranges of the `hh:fontfaces` and `hh:charProperties` children of `hh:head`/`hh:refList` (whole elements).
/// A duplicate refuses.
fn hwpx_ref_list_spans(text: &str) -> Option<BTreeMap<&'static str, std::ops::Range<usize>>> {
    use quick_xml::events::Event;
    use quick_xml::name::ResolveResult;
    let mut reader = quick_xml::reader::NsReader::from_str(text);
    let mut stack: Vec<(bool, Option<(&'static str, usize)>)> = Vec::new(); // (is refList, open target)
    let mut spans = BTreeMap::new();
    loop {
        let start = usize::try_from(reader.buffer_position()).ok()?;
        let event = reader.read_event().ok()?;
        match &event {
            Event::Start(e) | Event::Empty(e) => {
                let (ns, local) = reader.resolver().resolve_element(e.name());
                let head = matches!(ns, ResolveResult::Bound(n) if n.as_ref() == HWPML_HEAD);
                let parent_ref_list = stack.last().is_some_and(|(r, _)| *r);
                let target = match local.as_ref() {
                    "fontfaces" if head && parent_ref_list => Some("fontfaces"),
                    "charProperties" if head && parent_ref_list => Some("charProperties"),
                    _ => None,
                };
                let is_ref_list = head && local.as_ref() == "refList";
                if matches!(event, Event::Empty(_)) {
                    if let Some(name) = target {
                        let end = usize::try_from(reader.buffer_position()).ok()?;
                        if spans.insert(name, start..end).is_some() {
                            return None;
                        }
                    }
                } else {
                    stack.push((is_ref_list, target.map(|n| (n, start))));
                }
            }
            Event::End(_) => {
                let (_, open) = stack.pop()?;
                if let Some((name, from)) = open {
                    let end = usize::try_from(reader.buffer_position()).ok()?;
                    if spans.insert(name, from..end).is_some() {
                        return None;
                    }
                }
            }
            Event::Eof => return stack.is_empty().then_some(spans),
            _ => {}
        }
    }
}

/// Stage 1: an appended `hh:numbering` exactly in the pinned serializer's fallback form (`write_numbering` without
/// original paraHead bytes): `start="1"`, ten `hh:paraHead` children (levels 1-10) with the fixed attribute set,
/// automatic indent, zero width/offset, character shape 0, a known number format and a level-placeholder text.
fn hwpx_appended_numbering(def: &[xml::Canonical]) -> bool {
    let mut iter = def.iter();
    let Some(root) = iter.next() else { return false };
    let xml::Canonical::Start { attributes, .. } = root else { return false };
    if attributes.len() != 2 || plain_attribute(root, "start") != Some("1") || plain_attribute(root, "id").is_none() {
        return false;
    }
    const KEYS: [&str; 11] = ["start", "level", "align", "useInstWidth", "autoIndent", "widthAdjust", "textOffsetType",
        "textOffset", "numFormat", "charPrIDRef", "checkable"];
    const FORMATS: [&str; 6] = ["DIGIT", "ROMAN_CAPITAL", "ROMAN_SMALL", "LATIN_CAPITAL", "LATIN_SMALL", "HANGUL_SYLLABLE"];
    let mut level = 0;
    loop {
        let Some(event) = iter.next() else { return false };
        if *event == xml::Canonical::End {
            return level == 10 && iter.next().is_none();
        }
        if !is_head(event, "paraHead") {
            return false;
        }
        let xml::Canonical::Start { attributes, .. } = event else { return false };
        level += 1;
        let fixed = [("start", "1"), ("align", "LEFT"), ("useInstWidth", "0"), ("autoIndent", "1"), ("widthAdjust", "0"),
            ("textOffset", "0"), ("charPrIDRef", "0"), ("checkable", "0")];
        if attributes.len() != KEYS.len()
            || !attributes.iter().all(|(ns, k, _)| ns.is_none() && KEYS.contains(&k.as_ref()))
            || plain_attribute(event, "level") != Some(level.to_string().as_str())
            || !fixed.iter().all(|(k, v)| plain_attribute(event, k) == Some(*v))
            || !plain_attribute(event, "numFormat").is_some_and(|f| FORMATS.contains(&f))
            || plain_attribute(event, "textOffsetType").is_none()
        {
            return false;
        }
        // Text content: level placeholders and `.`/`)` only.
        let mut text = String::new();
        loop {
            match iter.next() {
                Some(xml::Canonical::Text(t)) => text.push_str(t),
                Some(xml::Canonical::End) => break,
                _ => return false,
            }
        }
        let mut chars = text.chars();
        let mut ok = text.contains('^');
        while let Some(c) = chars.next() {
            ok &= match c {
                '^' => chars.next().is_some_and(|d| ('1'..='7').contains(&d)),
                '.' | ')' => true,
                _ => false,
            };
        }
        if !ok {
            return false;
        }
    }
}

fn default_table_border(total: u32) -> Option<Vec<xml::Canonical>> {
    let expected = format!(
        r##"<hh:borderFill xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" id="{total}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/><hh:leftBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:rightBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:topBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:bottomBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/></hh:borderFill>"##
    );
    xml::canonical(expected.as_bytes()).ok()
}

fn hwpx_border_line_type_ok(v: &str) -> bool {
    matches!(
        v,
        "NONE"
            | "SOLID"
            | "DOT"
            | "DASH"
            | "DASH_DOT"
            | "DASH_DOT_DOT"
            | "LONG_DASH"
            | "CIRCLE"
            | "DOUBLE_SLIM"
            | "SLIM_THICK"
            | "THICK_SLIM"
            | "SLIM_THICK_SLIM"
            | "WAVE"
            | "DOUBLE_WAVE"
            | "THICK3D"
            | "THICKREV3D"
            | "3D"
            | "REV3D"
    )
}

fn hwpx_border_width_ok(v: &str) -> bool {
    let Some(mm) = v.strip_suffix(" mm") else {
        return false;
    };
    matches!(
        mm,
        "0.1"
            | "0.12"
            | "0.15"
            | "0.2"
            | "0.25"
            | "0.3"
            | "0.4"
            | "0.5"
            | "0.6"
            | "0.7"
            | "1.0"
            | "1.5"
            | "2.0"
            | "3.0"
            | "4.0"
            | "5.0"
    )
}

fn hwpx_color_ok(v: &str) -> bool {
    if v == "none" {
        return true;
    }
    let Some(hex) = v.strip_prefix('#') else {
        return false;
    };
    matches!(hex.len(), 6 | 8) && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

fn hwpx_valid_border_line(events: &[xml::Canonical], expected_name: &str) -> bool {
    if events.len() != 2 || events[1] != xml::Canonical::End {
        return false;
    }
    let xml::Canonical::Start {
        namespace: Some(ns),
        name,
        attributes,
    } = &events[0]
    else {
        return false;
    };
    if ns != HWPML_HEAD || name != expected_name || attributes.len() != 3 {
        return false;
    }
    let attr = |k: &str| plain_attribute(&events[0], k);
    attr("type").is_some_and(hwpx_border_line_type_ok)
        && attr("width").is_some_and(hwpx_border_width_ok)
        && attr("color").is_some_and(hwpx_color_ok)
}

fn hwpx_valid_win_brush(events: &[xml::Canonical]) -> bool {
    if events.len() != 4 || events[2] != xml::Canonical::End || events[3] != xml::Canonical::End {
        return false;
    }
    if !matches!(
        &events[0],
        xml::Canonical::Start {
            namespace: Some(ns),
            name,
            attributes,
        } if ns == HWPML_CORE && name == "fillBrush" && attributes.is_empty()
    ) {
        return false;
    }
    let xml::Canonical::Start {
        namespace: Some(ns),
        name,
        attributes,
    } = &events[1]
    else {
        return false;
    };
    if ns != HWPML_CORE || name != "winBrush" || !matches!(attributes.len(), 3 | 4) {
        return false;
    }
    let attr = |k: &str| plain_attribute(&events[1], k);
    let hatch_ok = match attr("hatchStyle") {
        None => attributes.len() == 3,
        Some(h) => {
            attributes.len() == 4
                && matches!(
                    h,
                    "HORIZONTAL"
                        | "VERTICAL"
                        | "BACK_SLASH"
                        | "SLASH"
                        | "CROSS"
                        | "CROSS_DIAGONAL"
                )
        }
    };
    let alpha_ok = attr("alpha")
        .is_some_and(|a| a.parse::<f64>().is_ok_and(|v| v.is_finite() && (0.0..=1.0).contains(&v)));
    attr("faceColor").is_some_and(hwpx_color_ok)
        && attr("hatchColor").is_some_and(hwpx_color_ok)
        && hatch_ok
        && alpha_ok
}

struct BorderFillParts {
    root_attrs_no_id: Vec<xml::Canonical>,
    slash: Vec<xml::Canonical>,
    back_slash: Vec<xml::Canonical>,
    diagonal: Option<Vec<xml::Canonical>>,
    fill_brush: Option<Vec<xml::Canonical>>,
}

fn parse_border_fill_parts(
    events: &[xml::Canonical],
    expected_id: u32,
    validate_sides: bool,
) -> Option<BorderFillParts> {
    if events.last() != Some(&xml::Canonical::End) {
        return None;
    }
    let xml::Canonical::Start {
        namespace: Some(ns),
        name,
        attributes,
    } = events.first()?
    else {
        return None;
    };
    if ns != HWPML_HEAD || name != "borderFill" {
        return None;
    }
    if plain_attribute(&events[0], "id")? != expected_id.to_string() {
        return None;
    }
    let root_attrs_no_id = vec![xml::Canonical::Start {
        namespace: Some(ns.clone()),
        name: name.clone(),
        attributes: attributes
            .iter()
            .filter(|(ans, ak, _)| !(ans.is_none() && ak == "id"))
            .cloned()
            .collect(),
    }];
    // Split immediate children inside <hh:borderFill> ... </hh:borderFill>.
    let mut children: Vec<(Option<&str>, &str, &[xml::Canonical])> = Vec::new();
    let mut pos = 1usize;
    let body_end = events.len() - 1;
    while pos < body_end {
        let xml::Canonical::Start {
            namespace, name, ..
        } = &events[pos]
        else {
            return None;
        };
        let start = pos;
        let mut depth = 1usize;
        pos += 1;
        while depth > 0 {
            if pos >= body_end {
                return None;
            }
            match &events[pos] {
                xml::Canonical::Start { .. } => depth += 1,
                xml::Canonical::End => depth -= 1,
                _ => {}
            }
            pos += 1;
        }
        children.push((namespace.as_deref(), name.as_str(), &events[start..pos]));
    }
    let mut idx = 0usize;
    let take_head = |children: &[(Option<&str>, &str, &[xml::Canonical])], idx: &mut usize, expected: &str| -> Option<Vec<xml::Canonical>> {
        let (cns, cname, slice) = children.get(*idx)?;
        if *cns == Some(HWPML_HEAD) && *cname == expected {
            *idx += 1;
            Some(slice.to_vec())
        } else {
            None
        }
    };
    let slash = take_head(&children, &mut idx, "slash")?;
    let back_slash = take_head(&children, &mut idx, "backSlash")?;
    let left = take_head(&children, &mut idx, "leftBorder")?;
    let right = take_head(&children, &mut idx, "rightBorder")?;
    let top = take_head(&children, &mut idx, "topBorder")?;
    let bottom = take_head(&children, &mut idx, "bottomBorder")?;
    if validate_sides
        && (!hwpx_valid_border_line(&left, "leftBorder")
            || !hwpx_valid_border_line(&right, "rightBorder")
            || !hwpx_valid_border_line(&top, "topBorder")
            || !hwpx_valid_border_line(&bottom, "bottomBorder"))
    {
        return None;
    }
    let diagonal = take_head(&children, &mut idx, "diagonal");
    if validate_sides {
        if let Some(ref diag) = diagonal {
            if !hwpx_valid_border_line(diag, "diagonal") {
                return None;
            }
        }
    }
    let fill_brush = if let Some((cns, cname, slice)) = children.get(idx) {
        if *cns == Some(HWPML_CORE) && *cname == "fillBrush" {
            idx += 1;
            Some(slice.to_vec())
        } else {
            None
        }
    } else {
        None
    };
    if idx != children.len() {
        return None;
    }
    Some(BorderFillParts {
        root_attrs_no_id,
        slash,
        back_slash,
        diagonal,
        fill_brush,
    })
}

fn verify_appended_border_fills(
    old_borders: &[Vec<xml::Canonical>],
    appended: &[Vec<xml::Canonical>],
    output: &Package,
) -> Option<bool> {
    if appended.is_empty() {
        return Some(false);
    }
    let total = old_borders.len().checked_add(appended.len())?;
    if total > 65535 || appended.len() > 512 {
        return None;
    }
    let existing_parts: Vec<BorderFillParts> = old_borders
        .iter()
        .enumerate()
        .filter_map(|(idx, events)| parse_border_fill_parts(events, (idx + 1) as u32, false))
        .collect();
    let default_diag = default_table_border(1)?;
    let default_parts = parse_border_fill_parts(&default_diag, 1, false)?;

    let mut is_default_tbl_border = Vec::with_capacity(appended.len());
    for (idx, events) in appended.iter().enumerate() {
        let id = (old_borders.len() + idx + 1) as u32;
        if Some(events) == default_table_border(id).as_ref() {
            is_default_tbl_border.push(true);
            continue;
        }
        let parts = parse_border_fill_parts(events, id, true)?;
        let matches_base = |base: &BorderFillParts| {
            base.root_attrs_no_id == parts.root_attrs_no_id
                && base.slash == parts.slash
                && base.back_slash == parts.back_slash
                && base.diagonal == parts.diagonal
        };
        let diagonal_default_or_none = parts.diagonal.as_ref()
            == default_parts.diagonal.as_ref()
            || parts.diagonal.is_none();
        let skeleton_ok = (parts.root_attrs_no_id == default_parts.root_attrs_no_id
            && parts.slash == default_parts.slash
            && parts.back_slash == default_parts.back_slash
            && diagonal_default_or_none)
            || existing_parts.iter().any(&matches_base);
        if !skeleton_ok {
            return None;
        }
        let fill_ok = match &parts.fill_brush {
            None => true,
            Some(fb) => {
                hwpx_valid_win_brush(fb)
                    || existing_parts.iter().any(|base| {
                        matches_base(base) && base.fill_brush.as_ref() == Some(fb)
                    })
            }
        };
        if !fill_ok {
            return None;
        }
        is_default_tbl_border.push(false);
    }

    let mut used = vec![false; appended.len()];
    for (name, (_, bytes)) in &output.parts {
        if !hwpx_body(name) {
            continue;
        }
        for e in xml::canonical(bytes).ok()? {
            let Some(value) = plain_attribute(&e, "borderFillIDRef") else {
                continue;
            };
            let id = value.parse::<usize>().ok()?;
            // RHWP's blank page uses zero as the page-border "none"
            // sentinel. Zero on table/cell or foreign elements stays invalid.
            if id == 0
                && matches!(&e, xml::Canonical::Start { namespace: Some(ns), name, .. }
                    if ns == HWPML_PARAGRAPH && name == "pageBorderFill")
            {
                continue;
            }
            if id == 0 || id > total {
                return None;
            }
            if id > old_borders.len() {
                let app_idx = id - old_borders.len() - 1;
                let allowed_elem = if is_default_tbl_border[app_idx] {
                    matches!(&e, xml::Canonical::Start { namespace: Some(ns), name, .. }
                        if ns == HWPML_PARAGRAPH && matches!(name.as_str(), "tbl" | "tc"))
                } else {
                    matches!(&e, xml::Canonical::Start { namespace: Some(ns), name, .. }
                        if ns == HWPML_PARAGRAPH && name == "tc")
                };
                if !allowed_elem {
                    return None;
                }
                used[app_idx] = true;
            }
        }
    }
    Some(used.into_iter().all(|u| u))
}

#[cfg(test)]
mod omitted_hwpx_resource_lists {
    use super::*;

    fn header(extra: &str, heading: &str) -> Vec<u8> {
        format!(r#"<hh:head xmlns:hh="{HWPML_HEAD}"><hh:refList>{extra}<hh:paraProperties itemCnt="1"><hh:paraPr id="0"><hh:heading type="{heading}" idRef="0" level="0"/></hh:paraPr></hh:paraProperties></hh:refList></hh:head>"#).into_bytes()
    }

    fn output(body: &str) -> Package {
        Package {
            order: vec!["Contents/section0.xml".into()],
            parts: BTreeMap::from([(
                "Contents/section0.xml".into(),
                (0, body.as_bytes().to_vec()),
            )]),
        }
    }

    #[test]
    fn hwpx_omitted_border_list_accepts_only_used_standard_append() {
        let before = header("", "NONE");
        let border = r##"<hh:borderFills itemCnt="1"><hh:borderFill id="1" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/><hh:leftBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:rightBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:topBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:bottomBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/></hh:borderFill></hh:borderFills>"##;
        let table = output(
            r#"<hp:p xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:pageBorderFill borderFillIDRef="0"/><hp:tbl borderFillIDRef="1"/></hp:p>"#,
        );
        assert_eq!(
            hwpx_bullets_appended(&before, &header(border, "NONE"), &table),
            Some(true)
        );
        // Existing definitions, exact border shape, counts and actual references
        // remain mandatory when the original omitted the empty list.
        assert_ne!(
            hwpx_bullets_appended(&before, &header(border, "BULLET"), &table),
            Some(true)
        );
        assert_ne!(
            hwpx_bullets_appended(
                &before,
                &header(&border.replace("SOLID", "DASH"), "NONE"),
                &table
            ),
            Some(true)
        );
        assert_ne!(
            hwpx_bullets_appended(
                &before,
                &header(&border.replace("itemCnt=\"1\"", "itemCnt=\"2\""), "NONE"),
                &table
            ),
            Some(true)
        );
        assert_ne!(
            hwpx_bullets_appended(&before, &header(border, "NONE"), &output("<p/>")),
            Some(true)
        );
        let bad_use = output(
            r#"<hp:p xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" borderFillIDRef="1"/>"#,
        );
        assert_ne!(
            hwpx_bullets_appended(&before, &header(border, "NONE"), &bad_use),
            Some(true)
        );
        let zero_cell = output(
            r#"<hp:p xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:tbl borderFillIDRef="1"/><hp:tc borderFillIDRef="0"/></hp:p>"#,
        );
        assert_ne!(
            hwpx_bullets_appended(&before, &header(border, "NONE"), &zero_cell),
            Some(true)
        );
        let foreign = output(
            r#"<hp:p xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:tbl borderFillIDRef="1"/><pageBorderFill xmlns="urn:foreign" borderFillIDRef="0"/></hp:p>"#,
        );
        assert_ne!(
            hwpx_bullets_appended(&before, &header(border, "NONE"), &foreign),
            Some(true)
        );
    }

    #[test]
    fn hwpx_appended_cell_border_fill_accepts_valid_tc_and_rejects_bad_mutations() {
        let before = header(
            r##"<hh:borderFills itemCnt="1"><hh:borderFill id="1" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/><hh:leftBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:rightBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:topBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:bottomBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/></hh:borderFill></hh:borderFills>"##,
            "NONE",
        );
        let cell_bf_2 = r##"<hh:borderFill id="2" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/><hh:leftBorder type="DASH" width="0.4 mm" color="#1E40AF"/><hh:rightBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:topBorder type="DOUBLE_SLIM" width="0.5 mm" color="#DC2626"/><hh:bottomBorder type="NONE" width="0.12 mm" color="none"/><hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/><hc:fillBrush xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"><hc:winBrush faceColor="#FEF08A" hatchColor="#FF000000" alpha="0"/></hc:fillBrush></hh:borderFill>"##;
        let bf1 = r##"<hh:borderFill id="1" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/><hh:leftBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:rightBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:topBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:bottomBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/></hh:borderFill>"##;
        let after = header(&format!(r#"<hh:borderFills itemCnt="2">{bf1}{cell_bf_2}</hh:borderFills>"#), "NONE");
        let tc_body = output(
            r#"<hp:p xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:tbl borderFillIDRef="1"><hp:tr><hp:tc borderFillIDRef="2"/></hp:tr></hp:tbl></hp:p>"#,
        );
        assert_eq!(hwpx_bullets_appended(&before, &after, &tc_body), Some(true));
        // Non-default borderFill referenced only by <hp:tbl> or unused must be rejected.
        let tbl_only = output(
            r#"<hp:p xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:tbl borderFillIDRef="2"><hp:tr><hp:tc borderFillIDRef="1"/></hp:tr></hp:tbl></hp:p>"#,
        );
        assert_ne!(hwpx_bullets_appended(&before, &after, &tbl_only), Some(true));
        assert_ne!(
            hwpx_bullets_appended(
                &before,
                &header(
                    &format!(
                        r#"<hh:borderFills itemCnt="2">{bf1}{}</hh:borderFills>"#,
                        cell_bf_2.replace(r#"type="DASH""#, r#"type="BOGUS""#)
                    ),
                    "NONE"
                ),
                &tc_body
            ),
            Some(true)
        );
        assert_ne!(
            hwpx_bullets_appended(
                &before,
                &header(
                    &format!(
                        r#"<hh:borderFills itemCnt="2">{bf1}{}</hh:borderFills>"#,
                        cell_bf_2.replace(r#"width="0.4 mm""#, r#"width="9.9 mm""#)
                    ),
                    "NONE"
                ),
                &tc_body
            ),
            Some(true)
        );
    }

    #[test]
    fn hwpx_omitted_border_list_allows_standard_bullet_without_table() {
        let before = header("", "NONE");
        let bullet = r#"<hh:bullets itemCnt="1"><hh:bullet id="1" char="•" useImage="0"><hh:paraHead level="0" align="LEFT" useInstWidth="0" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="0" checkable="0"/></hh:bullet></hh:bullets>"#;
        assert_eq!(
            hwpx_bullets_appended(&before, &header(bullet, "NONE"), &output("<p/>")),
            Some(true)
        );
        assert_ne!(
            hwpx_bullets_appended(
                &before,
                &header(&bullet.replace("char=\"•\"", "char=\"X\""), "NONE"),
                &output("<p/>")
            ),
            Some(true)
        );
    }
}

/// P1-C: the combined character + paragraph/list proof over the actual Release-WASM export
/// (`hwpx-stage1-combined`: numbered list + size, multilevel + color, custom bullet + superscript, paragraph
/// settings, table-cell list + size, all before one save). Explicit opt-in (needs GEUL_FORMAT_DIR).
#[cfg(test)]
mod combined_hwpx_proof {
    use super::*;

    fn load(name: &str, side: Side) -> Package {
        let dir = std::path::PathBuf::from(std::env::var_os("GEUL_FORMAT_DIR").expect("GEUL_FORMAT_DIR"));
        open(&std::fs::read(dir.join("hwpx-stage1-combined").join(name)).unwrap(), side).unwrap()
    }

    fn with(base: &Package, part: &str, edit: impl Fn(&str) -> String) -> Package {
        let mut p = Package { order: base.order.clone(), parts: base.parts.clone() };
        let entry = p.parts.get_mut(part).unwrap();
        let changed = edit(std::str::from_utf8(&entry.1).unwrap());
        assert_ne!(changed.as_bytes(), entry.1.as_slice(), "mutation not applied to {part}");
        entry.1 = changed.into_bytes();
        p
    }

    /// The package-level checks the save service runs for HWPX (structure, preservation, body references).
    fn refused(original: &Package, output: &Package) -> bool {
        validate_hwpx(original, output)
            .into_iter()
            .chain(compare_saved_hwpx(original, output))
            .chain(validate_hwpx_references(output))
            .any(|f| f.code != FindingCode::PreviewStale)
    }

    #[test]
    #[ignore = "requires the Stage 1 Release-WASM exports (GEUL_FORMAT_DIR)"]
    fn stage1_hwpx_combined_proof_accepts_union_and_rejects_invalid() {
        let original = load("original.hwpx", Side::Original);
        let edited = load("edited.hwpx", Side::Output);
        let (before, after) = (original.get(HWPX_HEADER).unwrap(), edited.get(HWPX_HEADER).unwrap());
        // Reproduction: each earlier single-change rule refuses this header on its own.
        assert!(!super::super::special::header_equal_or_appended(before, after, &edited));
        assert_ne!(hwpx_bullets_appended(before, after, &edited), Some(true));
        assert!(hwpx_combined_appended(before, after, &edited));
        let findings = compare_saved_hwpx(&original, &edited);
        assert!(findings.iter().all(|f| f.code == FindingCode::PreviewStale), "{findings:?}");
        assert!(!refused(&original, &edited));

        let header = |from: &'static str, to: &'static str, nth_last: bool| {
            with(&edited, HWPX_HEADER, move |h| match nth_last {
                true => {
                    let at = h.rfind(from).expect(from);
                    format!("{}{}{}", &h[..at], to, &h[at + from.len()..])
                }
                false => h.replacen(from, to, 1),
            })
        };
        let section = |from: &'static str, to: &'static str| with(&edited, "Contents/section0.xml", move |s| s.replacen(from, to, 1));
        let cases: Vec<(&str, Package)> = vec![
            ("invalid character-shape reference", section(r#"charPrIDRef="10""#, r#"charPrIDRef="11""#)),
            ("invalid paragraph-shape reference", section(r#"paraPrIDRef="24""#, r#"paraPrIDRef="25""#)),
            ("invalid numbering id", header(r#"<hh:heading type="NUMBER" idRef="3" level="0"/>"#, r#"<hh:heading type="NUMBER" idRef="4" level="0"/>"#, true)),
            ("bullet heading beyond the bullet count", header(r#"<hh:heading type="BULLET" idRef="1" level="0"/>"#, r#"<hh:heading type="BULLET" idRef="2" level="0"/>"#, true)),
            ("altered original character definition", header(r#"<hh:charPr id="0" height="1000""#, r#"<hh:charPr id="0" height="1100""#, false)),
            ("incorrect character definition count", header(r#"<hh:charProperties itemCnt="11">"#, r#"<hh:charProperties itemCnt="12">"#, false)),
            ("incorrect numbering definition count", header(r#"<hh:numberings itemCnt="3">"#, r#"<hh:numberings itemCnt="4">"#, false)),
            ("appended numbering with a foreign start", header(r#"<hh:numbering id="3" start="1">"#, r#"<hh:numbering id="3" start="2">"#, false)),
            ("unrelated header change", header(r#"<hh:beginNum page="1""#, r#"<hh:beginNum page="2""#, false)),
        ];
        // Missing appended definition: drop the last appended character shape but keep the declared count.
        let missing = with(&edited, HWPX_HEADER, |h| {
            let start = h.rfind("<hh:charPr ").unwrap();
            let end = start + h[start..].find("</hh:charPr>").unwrap() + "</hh:charPr>".len();
            format!("{}{}", &h[..start], &h[end..])
        });
        for (name, output) in cases.iter().map(|(n, p)| (*n, p)).chain([("missing appended definition", &missing)]) {
            assert!(refused(&original, output), "{name}: accepted");
        }
    }

    #[test]
    fn char_list_splice_requires_one_list_each() {
        let head = |inner: &str| format!(r#"<hh:head xmlns:hh="{HWPML_HEAD}"><hh:refList>{inner}</hh:refList></hh:head>"#);
        let a = head(r#"<hh:charProperties itemCnt="0"/><hh:paraProperties itemCnt="0"/>"#);
        let b = head(r#"<hh:charProperties itemCnt="1"><hh:charPr id="0"/></hh:charProperties><hh:paraProperties itemCnt="0"/>"#);
        assert_eq!(hwpx_with_char_lists_of(a.as_bytes(), b.as_bytes()).unwrap(), a.as_bytes());
        let twice = head(r#"<hh:charProperties itemCnt="0"/><hh:charProperties itemCnt="0"/>"#);
        assert!(hwpx_with_char_lists_of(a.as_bytes(), twice.as_bytes()).is_none());
        let none = head(r#"<hh:paraProperties itemCnt="0"/>"#);
        assert!(hwpx_with_char_lists_of(a.as_bytes(), none.as_bytes()).is_none());
        // Outside hh:refList the name is not a character list.
        let foreign = format!(r#"<hh:head xmlns:hh="{HWPML_HEAD}"><hh:charProperties itemCnt="0"/></hh:head>"#);
        assert!(hwpx_with_char_lists_of(a.as_bytes(), foreign.as_bytes()).is_none());
    }
}
