//! OLE(CFB) 컨테이너 검사: HWP 5와 암호화된 OOXML을 다른 OLE 문서와 구별한다.
//!
//! HWP 5로 보는 조건(rhwp `parser/header.rs`의 FileHeader 구조): 루트의 `FileHeader` 스트림이 256바이트 이상이고
//! "HWP Document File" 서명과 주 버전 5를 가지며, `DocInfo` 스트림과 `BodyText`(배포용 문서는 `ViewText`)
//! 저장소가 있다. rhwp의 `detect_format`은 OLE 서명만 보고 HWP로 분류하므로 그대로 쓰지 않는다.
//! FileHeader 속성의 암호(0x02)·DRM(0x10) 플래그는 `Encrypted`로 거부한다.
//!
//! cfb는 열 때 디렉터리와 FAT만 읽으므로, 파일 끝이 잘려 일부 스트림의 섹터가 없어도 열린다. 그래서 HWP로 인정하기
//! 전에 모든 스트림의 마지막 바이트를 한 번씩 읽어 섹터가 파일 안에 있는지 확인한다(스트림 수 상한 안에서).
//! 스트림 내용의 올바름은 확인하지 않는다(엔진 몫).

use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use super::error::{DocumentError, LimitKind, ParseProblem, UnsupportedKind};
use super::Format;

const SIGNATURE: &[u8] = b"HWP Document File";
const FILE_HEADER_LEN: u64 = 256;
const FLAG_PASSWORD: u32 = 0x02;
const FLAG_DRM: u32 = 0x10;
/// 끝까지 읽어 보는 스트림 수 상한.
pub const MAX_STREAMS: usize = 20_000;

pub fn inspect<F: Read + Seek>(source: F, len: u64) -> Result<Format, DocumentError> {
    if len < 512 {
        return Err(DocumentError::parse(None, ParseProblem::Truncated));
    }
    let mut file = cfb::CompoundFile::open(source)
        .map_err(|_| DocumentError::parse(None, ParseProblem::CorruptContainer))?;

    if file.is_stream("/FileHeader") {
        inspect_hwp(&mut file)?;
        check_streams(&mut file, len)?;
        return Ok(Format::Hwp);
    }
    if file.is_stream("/EncryptionInfo") && file.is_stream("/EncryptedPackage") {
        // MS-OFFCRYPTO로 암호화된 OOXML. 풀기 전에는 docx·xlsx 등을 구별할 수 없다.
        return Err(DocumentError::Encrypted { format: None });
    }
    if file.is_stream("/WordDocument") {
        return Err(DocumentError::unsupported(UnsupportedKind::LegacyWord));
    }
    Err(DocumentError::unsupported(UnsupportedKind::OtherOle))
}

fn inspect_hwp<F: Read + Seek>(file: &mut cfb::CompoundFile<F>) -> Result<(), DocumentError> {
    let corrupt = || DocumentError::parse(Some(Format::Hwp), ParseProblem::CorruptContainer);
    let mut header = Vec::with_capacity(FILE_HEADER_LEN as usize);
    file.open_stream("/FileHeader")
        .map_err(|_| corrupt())?
        .take(FILE_HEADER_LEN)
        .read_to_end(&mut header)
        .map_err(|_| corrupt())?;
    if !header.starts_with(SIGNATURE) {
        return Err(DocumentError::unsupported(UnsupportedKind::OtherOle)); // 이름만 같은 다른 OLE 문서
    }
    if (header.len() as u64) < FILE_HEADER_LEN {
        return Err(DocumentError::parse(
            Some(Format::Hwp),
            ParseProblem::InvalidPart,
        ));
    }
    let major = header[35];
    if major != 5 {
        return Err(DocumentError::unsupported(UnsupportedKind::HwpVersion));
    }
    let flags = u32::from_le_bytes([header[36], header[37], header[38], header[39]]);
    if flags & (FLAG_PASSWORD | FLAG_DRM) != 0 {
        return Err(DocumentError::Encrypted {
            format: Some(Format::Hwp),
        });
    }
    let has_body = file.is_storage("/BodyText") || file.is_storage("/ViewText");
    if !file.is_stream("/DocInfo") || !has_body {
        return Err(DocumentError::parse(
            Some(Format::Hwp),
            ParseProblem::MissingPart,
        ));
    }
    Ok(())
}

fn check_streams<F: Read + Seek>(
    file: &mut cfb::CompoundFile<F>,
    len: u64,
) -> Result<(), DocumentError> {
    let streams: Vec<PathBuf> = file
        .walk()
        .filter(|entry| entry.is_stream())
        .take(MAX_STREAMS + 1)
        .map(|entry| entry.path().to_path_buf())
        .collect();
    if streams.len() > MAX_STREAMS {
        return Err(DocumentError::ResourceLimit {
            limit: LimitKind::EntryCount,
        });
    }
    // 섹터 경계가 아닌 길이는 잘린 파일일 가능성이 크다. 경계에서 잘렸으면 구조 손상과 구별할 수 없다.
    let reason = if !len.is_multiple_of(512) {
        ParseProblem::Truncated
    } else {
        ParseProblem::CorruptContainer
    };
    for path in streams {
        let mut stream = file
            .open_stream(&path)
            .map_err(|_| DocumentError::parse(Some(Format::Hwp), reason))?;
        if stream.is_empty() {
            continue;
        }
        let mut last = [0u8; 1];
        stream
            .seek(SeekFrom::End(-1))
            .and_then(|_| stream.read_exact(&mut last))
            .map_err(|_| DocumentError::parse(Some(Format::Hwp), reason))?;
    }
    Ok(())
}
