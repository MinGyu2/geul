//! 내용으로 형식을 정한다. 확장자는 보지 않는다(확장자 정책은 `open.rs`).

use std::io::{Read, Seek, SeekFrom};

use super::error::{DocumentError, ParseProblem, ReadProblem, UnsupportedKind};
use super::zip::{self, ZipLimits};
use super::{ole, package, Format};

const OLE_MAGIC: &[u8] = &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const ZIP_MAGIC: &[u8] = b"PK\x03\x04";
const EMPTY_ZIP_MAGIC: &[u8] = b"PK\x05\x06";
const HWP3_SIGNATURE: &[u8] = b"HWP Document File";
/// rhwp `parser/mod.rs`가 감지하는 DRM 컨테이너(Fasoo, SoftCamp SCDSA).
const DRM_SIGNATURES: [&[u8]; 2] = [b"\x9b DRMONE", b"SCDSA"];

pub const DEFAULT_ZIP_LIMITS: ZipLimits = ZipLimits {
    max_entries: 20_000,
    max_directory_bytes: 8 * 1024 * 1024,
    max_name_bytes: 4096,
};

/// `source`(길이 `len`)의 형식을 정한다. 첫 32바이트, ZIP 중앙 디렉터리와 작은 XML 몇 개, 또는 OLE 디렉터리와
/// FileHeader만 읽는다.
pub fn detect<R: Read + Seek>(source: &mut R, len: u64) -> Result<Format, DocumentError> {
    detect_with(source, len, &DEFAULT_ZIP_LIMITS)
}

pub(crate) fn detect_with<R: Read + Seek>(
    source: &mut R,
    len: u64,
    zip_limits: &ZipLimits,
) -> Result<Format, DocumentError> {
    if len == 0 {
        return Err(DocumentError::parse(None, ParseProblem::Empty));
    }
    let mut head = Vec::with_capacity(32);
    source
        .seek(SeekFrom::Start(0))
        .and_then(|_| source.by_ref().take(32).read_to_end(&mut head))
        .map_err(|_| DocumentError::Unreadable {
            reason: ReadProblem::Io,
        })?;

    if DRM_SIGNATURES
        .iter()
        .any(|signature| head.starts_with(signature))
    {
        return Err(DocumentError::Encrypted { format: None });
    }
    if head.starts_with(OLE_MAGIC) {
        return ole::inspect(&mut *source, len);
    }
    if head.starts_with(ZIP_MAGIC) || head.starts_with(EMPTY_ZIP_MAGIC) {
        let archive = zip::read_directory(source, len, zip_limits)
            .map_err(|problem| package::zip_error(None, problem))?;
        return package::inspect(source, &archive);
    }
    if head.starts_with(HWP3_SIGNATURE) {
        return Err(DocumentError::unsupported(UnsupportedKind::Hwp3));
    }
    // 서명보다 짧은 파일이 알려진 서명의 앞부분이면 잘린 것으로 본다.
    if [OLE_MAGIC, ZIP_MAGIC]
        .iter()
        .any(|magic| head.len() < magic.len() && magic.starts_with(&head))
    {
        return Err(DocumentError::parse(None, ParseProblem::Truncated));
    }
    Err(DocumentError::unsupported(UnsupportedKind::Unknown))
}
