//! HWP 5(CFB) 원본과 엔진 출력의 구조 비교.
//!
//! rhwp는 문서를 공통 IR로 읽고 다시 직렬화한다. 손실 보고(`content_loss.rs`)는 직렬화가 스스로 안 손실만 적으므로
//! 빈 보고서는 보존의 근거가 아니다(실측: 업스트림 예제 HWP 58개 모두 보고 0건인데 바이트가 다름). 그래서 원본과
//! 출력을 HWP의 단위로 비교한다:
//! - 스트림 이름 집합(빠지거나 생긴 스트림),
//! - `FileHeader` 256바이트,
//! - 레코드 스트림(`DocInfo`, `BodyText/Section*`): 압축을 풀고 레코드(태그·수준·내용)를 끝까지 읽어 같은 열인지,
//! - 그 밖의 스트림: 바이트가 같거나, 둘 다 압축을 풀었을 때 같은지.
//!
//! 압축 방식·섹터 배치처럼 레코드 내용이 아닌 차이는 같다고 본다. 암호·DRM·배포용 문서는 비교하지 않는다(unknown).
//! 이 비교는 HWP 레코드 수준의 동일성이며 한컴 오피스에서 같게 보인다는 증거가 아니다.

use std::collections::BTreeMap;
use std::io::{Cursor, Read};

use flate2::read::DeflateDecoder;

use super::preserve::{Finding, FindingCode};

const SIGNATURE: &[u8] = b"HWP Document File";
const FILE_HEADER_LEN: usize = 256;
const FLAG_COMPRESSED: u32 = 0x01;
const FLAG_PASSWORD: u32 = 0x02;
const FLAG_DISTRIBUTABLE: u32 = 0x04;
const FLAG_DRM: u32 = 0x10;
/// 스트림 수·스트림 하나·풀어낸 크기·레코드 수 상한.
const MAX_STREAMS: usize = 20_000;
const MAX_STREAM_BYTES: u64 = 256 * 1024 * 1024;
const MAX_INFLATED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RECORDS: usize = 8_000_000;

/// 읽어 둔 HWP 컨테이너.
struct Container {
    header: Vec<u8>,
    compressed: bool,
    streams: BTreeMap<String, Vec<u8>>,
}

/// 원본·출력 중 어느 쪽인지(근거 코드가 다르다).
#[derive(Clone, Copy)]
enum Side {
    Original,
    Output,
}

impl Side {
    fn malformed(self) -> FindingCode {
        match self {
            Side::Original => FindingCode::OriginalMalformed,
            Side::Output => FindingCode::OutputMalformed,
        }
    }
}

fn open(bytes: &[u8], side: Side) -> Result<Container, Finding> {
    let malformed = |part: &str| Finding::at(side.malformed(), part);
    let mut file =
        cfb::CompoundFile::open(Cursor::new(bytes)).map_err(|_| malformed("container"))?;
    let paths: Vec<String> = file
        .walk()
        .filter(|entry| entry.is_stream())
        .take(MAX_STREAMS + 1)
        .map(|entry| entry.path().to_string_lossy().into_owned())
        .collect();
    if paths.len() > MAX_STREAMS {
        return Err(Finding::new(FindingCode::LimitExceeded));
    }
    let mut streams = BTreeMap::new();
    for path in paths {
        let name = path.trim_start_matches('/').to_owned();
        let mut stream = file.open_stream(&path).map_err(|_| malformed(&name))?;
        if stream.len() > MAX_STREAM_BYTES {
            return Err(Finding::at(FindingCode::LimitExceeded, &name));
        }
        let mut data = Vec::new();
        stream
            .read_to_end(&mut data)
            .map_err(|_| malformed(&name))?;
        streams.insert(name, data);
    }
    let header = streams
        .get("FileHeader")
        .filter(|h| h.len() >= FILE_HEADER_LEN && h.starts_with(SIGNATURE))
        .cloned()
        .ok_or_else(|| malformed("FileHeader"))?;
    let flags = u32::from_le_bytes([header[36], header[37], header[38], header[39]]);
    if header[35] != 5 || flags & (FLAG_PASSWORD | FLAG_DISTRIBUTABLE | FLAG_DRM) != 0 {
        return Err(Finding::at(FindingCode::Unsupported, "FileHeader"));
    }
    Ok(Container {
        header,
        compressed: flags & FLAG_COMPRESSED != 0,
        streams,
    })
}

fn inflate(data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    DeflateDecoder::new(data)
        .take(MAX_INFLATED_BYTES + 1)
        .read_to_end(&mut out)
        .ok()?;
    (out.len() as u64 <= MAX_INFLATED_BYTES).then_some(out)
}

/// 레코드 하나: (태그, 수준, 내용).
type Record<'a> = (u16, u16, &'a [u8]);

/// 레코드 스트림을 끝까지 읽는다. 머리·크기가 스트림 끝을 넘으면 None.
fn records(data: &[u8]) -> Option<Vec<Record<'_>>> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while at < data.len() {
        let head = u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?);
        at += 4;
        let mut size = (head >> 20) as usize;
        if size == 0xFFF {
            size = u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?) as usize;
            at += 4;
        }
        let body = data.get(at..at.checked_add(size)?)?;
        at += size;
        out.push(((head & 0x3FF) as u16, ((head >> 10) & 0x3FF) as u16, body));
        if out.len() > MAX_RECORDS {
            return None;
        }
    }
    Some(out)
}

fn record_stream(name: &str) -> bool {
    name == "DocInfo" || name.starts_with("BodyText/")
}

/// 레코드 스트림의 압축을 푼다(컨테이너의 압축 플래그를 따른다).
fn unpack(container: &Container, data: &[u8]) -> Option<Vec<u8>> {
    if container.compressed {
        inflate(data)
    } else {
        Some(data.to_vec())
    }
}

/// HWPTAG_DOCUMENT_PROPERTIES(DocInfo 첫 레코드): 구역 수(2)·시작 번호 6개(12) 뒤의 12바이트가 캐럿 자리다.
const TAG_DOCUMENT_PROPERTIES: u16 = 16;
const DOCUMENT_PROPERTIES_CARET: usize = 14;

/// 편집한 저장에서 DocInfo가 같은지: 레코드 열이 같고, 다를 수 있는 것은 문서 속성 레코드의 캐럿 자리뿐이다(rhwp가
/// 편집 뒤 커서 위치를 쓴다, 실측). 구역 수·시작 번호·그 밖의 레코드(글꼴·글자 모양·스타일·그림 목록 등)는 같아야 한다.
fn same_docinfo(before: &[Record<'_>], after: &[Record<'_>]) -> bool {
    before.len() == after.len()
        && before.iter().zip(after).all(|(a, b)| {
            a == b
                || (a.0 == TAG_DOCUMENT_PROPERTIES
                    && a.0 == b.0
                    && a.1 == b.1
                    && a.2.len() == b.2.len()
                    && a.2.len() >= DOCUMENT_PROPERTIES_CARET
                    && a.2[..DOCUMENT_PROPERTIES_CARET] == b.2[..DOCUMENT_PROPERTIES_CARET])
        })
}

/// 비교 방식.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// 편집 없는 왕복(사전 검사): 모든 스트림이 같아야 한다.
    Unedited,
    /// 편집한 저장: 본문(`BodyText/*`)은 엔진 다시 열기가 따로 확인하므로 레코드로 끝까지 읽히는지만 보고, DocInfo는
    /// 캐럿 자리만 다를 수 있다. 그 밖은 원본과 같아야 한다.
    Edited,
}

fn compare_with(original: &[u8], output: &[u8], mode: Mode) -> Vec<Finding> {
    let original = match open(original, Side::Original) {
        Ok(container) => container,
        Err(finding) => return vec![finding],
    };
    let output = match open(output, Side::Output) {
        Ok(container) => container,
        Err(finding) => return vec![finding],
    };
    let mut findings = Vec::new();
    if original.header[..FILE_HEADER_LEN] != output.header[..FILE_HEADER_LEN] {
        findings.push(Finding::at(FindingCode::PartChanged, "FileHeader"));
    }
    for name in output.streams.keys() {
        if !original.streams.contains_key(name) {
            findings.push(Finding::at(FindingCode::PartAdded, name));
        }
    }
    for (name, before) in &original.streams {
        let Some(after) = output.streams.get(name) else {
            findings.push(Finding::at(FindingCode::PartMissing, name));
            continue;
        };
        if name == "FileHeader" {
            continue;
        }
        if record_stream(name) {
            let body = name.starts_with("BodyText/");
            if before == after && !(mode == Mode::Edited && body) {
                continue;
            }
            let Some(after) = unpack(&output, after) else {
                findings.push(Finding::at(FindingCode::OutputMalformed, name));
                continue;
            };
            let Some(after_records) = records(&after) else {
                findings.push(Finding::at(FindingCode::OutputMalformed, name));
                continue;
            };
            if mode == Mode::Edited && body {
                continue; // 본문 내용은 다시 열기 비교 몫
            }
            let Some(before) = unpack(&original, before) else {
                findings.push(Finding::at(FindingCode::OriginalMalformed, name));
                continue;
            };
            let Some(before_records) = records(&before) else {
                findings.push(Finding::at(FindingCode::OriginalMalformed, name));
                continue;
            };
            let same = if mode == Mode::Edited && name == "DocInfo" {
                same_docinfo(&before_records, &after_records)
            } else {
                before_records == after_records
            };
            if !same {
                findings.push(Finding::at(FindingCode::RecordsChanged, name));
            }
            continue;
        }
        if before == after {
            continue;
        }
        // 그 밖의 스트림: 압축 상태만 다를 수 있다(BinData 등). 둘 다 풀어 같으면 같다.
        let same = match (inflate(before), inflate(after)) {
            (Some(a), Some(b)) => a == b,
            (Some(a), None) => a == *after,
            (None, Some(b)) => *before == b,
            (None, None) => false,
        };
        if !same {
            findings.push(Finding::at(FindingCode::PartChanged, name));
        }
    }
    findings
}

/// 사전 검사: 원본과 편집 없는 엔진 출력을 비교한 근거. 비어 있으면 레코드 수준에서 같다.
pub fn compare(original: &[u8], output: &[u8]) -> Vec<Finding> {
    compare_with(original, output, Mode::Unedited)
}

/// 저장 검사: 원본과 편집한 엔진 출력을 비교한 근거(본문 밖이 원본과 같은지, 본문이 레코드로 읽히는지).
pub fn compare_saved(original: &[u8], output: &[u8]) -> Vec<Finding> {
    compare_with(original, output, Mode::Edited)
}
