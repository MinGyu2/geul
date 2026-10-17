//! ZIP 패키지 검사: HWPX와 DOCX를 서로, 그리고 다른 ZIP(XLSX·ODF 등)과 구별한다.
//!
//! - HWPX: `Contents/content.hpf`와 `Contents/header.xml`(rhwp `parser/hwpx/reader.rs`의 필수 항목). `mimetype`이
//!   있으면 `application/hwp+zip`이어야 한다. `META-INF/manifest.xml`이 있으면 ODF manifest여야 하고, 그 이름공간의
//!   `encryption-data` 요소가 있으면 암호화 문서다(읽을 수 없는 manifest는 암호화 여부를 알 수 없으므로 구조 오류).
//!   필수 항목은 있는지만 보지 않고 압축 해제·선언 크기·CRC를 확인하며, content.hpf는 OPF `package` 문서여야 한다.
//!   header.xml의 XML 내용과 본문(section) 항목은 확인하지 않는다(엔진이 읽을 때 확인, T007).
//! - DOCX: `[Content_Types].xml`과 `_rels/.rels`가 OPC 구조(이름공간·루트·위치·중복 없음)를 따르고, 패키지 관계의
//!   officeDocument 대상 부분이 존재하며 그 내용 형식이 WordprocessingML 문서 본문이다. 다른 OOXML(XLSX·PPTX)이나
//!   docm·dotx는 docx로 보지 않는다. 본문 부분은 풀지 않는다(엔진 몫, T008).
//! - 암호화: HWPX·DOCX 모두 ZIP 항목 중 하나라도 중앙 디렉터리 암호화 플래그가 있으면 `Encrypted`(풀지 않는다).
//! - 두 표식이 함께 있으면 하나로 정하지 않는다(`Ambiguous`).

use std::io::{Read, Seek};

use super::error::{DocumentError, LimitKind, ParseProblem, UnsupportedKind};
use super::xml;
use super::zip::{Archive, Entry, ZipProblem};
use super::Format;

const HWPX_MIMETYPE: &[u8] = b"application/hwp+zip";
const HWPX_MANIFEST: &str = "Contents/content.hpf";
const HWPX_HEADER: &str = "Contents/header.xml";
const HWPX_ENCRYPTION_MANIFEST: &str = "META-INF/manifest.xml";
const CONTENT_TYPES: &str = "[Content_Types].xml";
const PACKAGE_RELATIONSHIPS: &str = "_rels/.rels";
const OFFICE_DOCUMENT: [&str; 2] = [
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
    "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument", // Strict OOXML
];
const DOCX_MAIN: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const WORD_VARIANTS: [&str; 3] = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
    "application/vnd.ms-word.document.macroEnabled.main+xml",
    "application/vnd.ms-word.template.macroEnabledTemplate.main+xml",
];

/// 판별에 읽는 XML 항목 하나의 크기 상한.
pub const MAX_PART_BYTES: u64 = 1024 * 1024;
/// 내용을 모으지 않고 크기·CRC만 확인하는 필수 항목(HWPX header.xml)의 압축 해제 상한. 실제 문서의 header.xml은
/// 1 MiB를 넘을 수 있다(rhwp 표본 최대 약 3.2 MB).
pub const MAX_VERIFIED_PART_BYTES: u64 = 64 * 1024 * 1024;
const MAX_MIMETYPE_BYTES: u64 = 256;

/// ZIP 문제를 형식 문맥에 맞는 오류로 바꾼다.
pub fn zip_error(format: Option<Format>, problem: ZipProblem) -> DocumentError {
    match problem {
        ZipProblem::Truncated => DocumentError::parse(format, ParseProblem::Truncated),
        ZipProblem::Corrupt => DocumentError::parse(format, ParseProblem::CorruptContainer),
        ZipProblem::UnsupportedMethod => DocumentError::parse(format, ParseProblem::InvalidPart),
        ZipProblem::EntryCount => DocumentError::ResourceLimit {
            limit: LimitKind::EntryCount,
        },
        ZipProblem::MetadataSize => DocumentError::ResourceLimit {
            limit: LimitKind::MetadataSize,
        },
        ZipProblem::PartSize => DocumentError::ResourceLimit {
            limit: LimitKind::PartSize,
        },
        ZipProblem::Encrypted => DocumentError::Encrypted { format },
        ZipProblem::Io => DocumentError::Unreadable {
            reason: super::error::ReadProblem::Io,
        },
    }
}

struct Package<'a, R> {
    reader: &'a mut R,
    archive: &'a Archive,
}

impl<R: Read + Seek> Package<'_, R> {
    fn read(
        &mut self,
        format: Option<Format>,
        entry: &Entry,
        max: u64,
    ) -> Result<Vec<u8>, DocumentError> {
        self.archive
            .read(self.reader, entry, max)
            .map_err(|problem| zip_error(format, problem))
    }

    fn verify(
        &mut self,
        format: Option<Format>,
        entry: &Entry,
        max: u64,
    ) -> Result<(), DocumentError> {
        self.archive
            .verify(self.reader, entry, max)
            .map_err(|problem| zip_error(format, problem))
    }
}

pub fn inspect<R: Read + Seek>(reader: &mut R, archive: &Archive) -> Result<Format, DocumentError> {
    let mut package = Package { reader, archive };
    let mimetype = match archive.find("mimetype") {
        Some(entry) => Some(package.read(None, entry, MAX_MIMETYPE_BYTES)?),
        None => None,
    };
    let hwpx_mimetype = mimetype.as_deref() == Some(HWPX_MIMETYPE);
    let hwpx_parts = archive.find(HWPX_MANIFEST).is_some() && archive.find(HWPX_HEADER).is_some();
    let ooxml_parts = archive.find_ignore_case(CONTENT_TYPES).is_some()
        && archive.find_ignore_case(PACKAGE_RELATIONSHIPS).is_some();

    if (hwpx_mimetype || hwpx_parts) && ooxml_parts {
        return Err(DocumentError::unsupported(UnsupportedKind::Ambiguous));
    }
    if hwpx_parts && mimetype.is_some() && !hwpx_mimetype {
        return Err(DocumentError::unsupported(UnsupportedKind::Ambiguous)); // 다른 패키지 형식을 선언함
    }
    if hwpx_mimetype || hwpx_parts {
        return inspect_hwpx(&mut package);
    }
    if ooxml_parts {
        return inspect_ooxml(&mut package);
    }
    if archive.find_ignore_case(CONTENT_TYPES).is_some()
        || archive.find_ignore_case(PACKAGE_RELATIONSHIPS).is_some()
    {
        return Err(DocumentError::parse(None, ParseProblem::MissingPart)); // OPC 패키지의 필수 항목 중 하나가 없음
    }
    Err(DocumentError::unsupported(UnsupportedKind::OtherZip))
}

fn inspect_hwpx<R: Read + Seek>(package: &mut Package<'_, R>) -> Result<Format, DocumentError> {
    let format = Some(Format::Hwpx);
    let archive = package.archive;
    if archive.entries().iter().any(Entry::is_encrypted) {
        return Err(DocumentError::Encrypted { format });
    }
    let invalid = || DocumentError::parse(format, ParseProblem::InvalidPart);
    if let Some(manifest) = archive.find(HWPX_ENCRYPTION_MANIFEST) {
        let bytes = package.read(format, manifest, MAX_PART_BYTES)?;
        if xml::odf_manifest_encrypted(&bytes).map_err(|_| invalid())? {
            return Err(DocumentError::Encrypted { format });
        }
    }
    let (Some(content), Some(header)) = (archive.find(HWPX_MANIFEST), archive.find(HWPX_HEADER))
    else {
        return Err(DocumentError::parse(format, ParseProblem::MissingPart));
    };
    xml::opf_package(&package.read(format, content, MAX_PART_BYTES)?).map_err(|_| invalid())?;
    package.verify(format, header, MAX_VERIFIED_PART_BYTES)?;
    Ok(Format::Hwpx)
}

fn inspect_ooxml<R: Read + Seek>(package: &mut Package<'_, R>) -> Result<Format, DocumentError> {
    let archive = package.archive;
    let invalid = |format| DocumentError::parse(format, ParseProblem::InvalidPart);
    let relationships_entry = archive
        .find_ignore_case(PACKAGE_RELATIONSHIPS)
        .expect("확인한 항목");
    let content_types_entry = archive
        .find_ignore_case(CONTENT_TYPES)
        .expect("확인한 항목");
    let relationships =
        xml::relationships(&package.read(None, relationships_entry, MAX_PART_BYTES)?)
            .map_err(|_| invalid(None))?;
    let content_types =
        xml::content_types(&package.read(None, content_types_entry, MAX_PART_BYTES)?)
            .map_err(|_| invalid(None))?;

    let mut targets = relationships
        .iter()
        .filter(|relationship| OFFICE_DOCUMENT.contains(&relationship.kind.as_str()));
    let main = targets
        .next()
        .ok_or(DocumentError::parse(None, ParseProblem::MissingPart))?;
    if targets.next().is_some() || main.external {
        return Err(invalid(None));
    }
    let part = part_name(&main.target).ok_or(invalid(None))?;
    let kind = content_types.of(&format!("/{part}")).ok_or(invalid(None))?;
    if WORD_VARIANTS
        .iter()
        .any(|variant| variant.eq_ignore_ascii_case(kind))
    {
        return Err(DocumentError::unsupported(UnsupportedKind::WordVariant));
    }
    if !kind.eq_ignore_ascii_case(DOCX_MAIN) {
        return Err(DocumentError::unsupported(UnsupportedKind::OtherOoxml));
    }
    if archive.find_ignore_case(&part).is_none() {
        return Err(DocumentError::parse(
            Some(Format::Docx),
            ParseProblem::MissingPart,
        ));
    }
    // 관계·내용 형식 항목의 암호화는 위에서 읽을 때 `Encrypted { format: None }`으로 걸린다.
    if archive.entries().iter().any(Entry::is_encrypted) {
        return Err(DocumentError::Encrypted {
            format: Some(Format::Docx),
        });
    }
    Ok(Format::Docx)
}

/// 패키지 관계의 대상을 ZIP 항목 이름으로 바꾼다. 루트 관계이므로 상대 경로는 패키지 루트 기준이다.
/// 빈 조각·`.`·`..`·역슬래시·조각 식별자는 받지 않는다.
pub(super) fn part_name(target: &str) -> Option<String> {
    let path = target.strip_prefix('/').unwrap_or(target);
    if path.is_empty() || path.contains(['\\', '#', '?']) {
        return None;
    }
    if path
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return None;
    }
    Some(path.to_owned())
}

#[cfg(test)]
mod tests {
    use super::part_name;

    #[test]
    fn 관계_대상은_패키지_안의_부분_이름만_받는다() {
        assert_eq!(
            part_name("word/document.xml").as_deref(),
            Some("word/document.xml")
        );
        assert_eq!(
            part_name("/word/document.xml").as_deref(),
            Some("word/document.xml")
        );
        for bad in [
            "",
            "/",
            "../word/document.xml",
            "word/../x.xml",
            "word//x.xml",
            "word\\x.xml",
            "word/x.xml#a",
            "./x.xml",
        ] {
            assert_eq!(part_name(bad), None, "{bad}");
        }
    }
}
