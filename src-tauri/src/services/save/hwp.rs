//! HWP 5(CFB) 원본과 엔진 출력의 구조 비교.
//!
//! rhwp는 문서를 공통 IR로 읽고 다시 직렬화한다. 손실 보고(`content_loss.rs`)는 직렬화가 스스로 안 손실만 적으므로
//! 빈 보고서는 보존의 근거가 아니다(실측: 업스트림 예제 HWP 58개 모두 보고 0건인데 바이트가 다름). 그래서 원본과
//! 출력을 HWP의 단위로 비교한다:
//! - 스트림 이름 집합(빠지거나 생긴 스트림),
//! - `FileHeader` 256바이트,
//! - 레코드 스트림(`DocInfo`, `BodyText/Section*`): 압축을 풀고 레코드(태그·수준·내용)를 끝까지 읽어 같은 열인지. 바이트가
//!   같아도 양쪽을 끝까지 읽는다(같은 바이트의 깨진 레코드는 보존의 근거가 아니다, T009 안정화).
//! - `BinData/BIN{XXXX}.{ext}` 중 DocInfo BIN_DATA 속성으로 저장 형태(압축 여부)가 양쪽에서 하나로 정해지는 스트림: 그
//!   형태가 같고, 압축이면 양쪽이 끝까지(남는 바이트 없이) 풀려 같은 바이트, 비압축이면 바이트가 같아야 한다.
//! - 그 밖의 스트림(속성으로 정할 수 없는 BinData·미리보기·스크립트·요약 정보 등): 저장한 바이트가 같아야 한다. 한쪽만
//!   풀리는 쌍을 풀린 내용으로 같다고 보지 않는다(읽는 쪽이 압축 여부를 스트림 바이트로 정하지 않으므로, T009 안정화).
//!
//! 섹터 배치처럼 스트림 내용이 아닌 차이는 같다고 본다. 암호·DRM·배포용 문서는 비교하지 않는다(unknown).
//! 본문을 바꾼 저장에서 `PrvText`·`PrvImage`가 원본 그대로이면 내용이 없음을 증명해야 한다(`preview`).
//! 이 비교는 HWP 레코드 수준의 동일성이며 한컴 오피스에서 같게 보인다는 증거가 아니다.

use std::collections::BTreeMap;
use std::io::{Cursor, Read};

use flate2::read::DeflateDecoder;

use super::preserve::{Finding, FindingCode};
use super::preview;

const SIGNATURE: &[u8] = b"HWP Document File";
const FILE_HEADER_LEN: usize = 256;
const FLAG_COMPRESSED: u32 = 0x01;
const FLAG_PASSWORD: u32 = 0x02;
const FLAG_DISTRIBUTABLE: u32 = 0x04;
const FLAG_DRM: u32 = 0x10;
/// 보존을 판단할 수 있는 FileHeader 속성(T009 3차 안정화): 압축(0x01)·스크립트(0x08)만. 고정 rhwp `parser/header.rs`
/// `FileHeaderFlags`가 아는 나머지(XML 서식 0x20, 문서 이력 0x40, 전자 서명 0x80, 공개키 암호 0x100, 인증서 0x200, 배포 준비
/// 0x400)와 모르는 비트는 편집·다시 쓰기로 지킬 수 없거나(서명이 깨짐) 뜻을 모르므로 판단하지 않는다(unknown).
const FLAGS_SUPPORTED: u32 = FLAG_COMPRESSED | 0x08;
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
    // 고정 rhwp가 아는 배치는 정확히 256바이트다(`parser/header.rs` FILE_HEADER_SIZE). 더 긴 원본은 뒤 바이트의 뜻을 모르므로
    // 판단하지 않고, 더 긴 출력은 올바르지 않다(그 바이트를 무시하지 않는다, T009 3차 안정화).
    if header.len() != FILE_HEADER_LEN {
        return Err(match side {
            Side::Original => Finding::at(FindingCode::Unsupported, "FileHeader"),
            Side::Output => malformed("FileHeader"),
        });
    }
    let flags = u32::from_le_bytes([header[36], header[37], header[38], header[39]]);
    if header[35] != 5
        || flags & (FLAG_PASSWORD | FLAG_DISTRIBUTABLE | FLAG_DRM) != 0
        || flags & !FLAGS_SUPPORTED != 0
    {
        return Err(Finding::at(FindingCode::Unsupported, "FileHeader"));
    }
    Ok(Container {
        header,
        compressed: flags & FLAG_COMPRESSED != 0,
        streams,
    })
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

/// deflate를 끝까지 푼다. 뒤에 남는 바이트는 없거나, 한컴 오피스가 붙이는 8바이트 꼬리(푼 내용의 CRC-32·길이, gzip 꼬리와
/// 같은 배치, 실측)로서 푼 내용과 맞아야 한다. 그 밖의 남는 바이트는 읽는 쪽마다 다르게 다룰 수 있어 받지 않는다.
fn inflate(data: &[u8]) -> Option<Vec<u8>> {
    let mut decoder = DeflateDecoder::new(data);
    let mut out = Vec::new();
    (&mut decoder)
        .take(MAX_INFLATED_BYTES + 1)
        .read_to_end(&mut out)
        .ok()?;
    if out.len() as u64 > MAX_INFLATED_BYTES {
        return None;
    }
    let tail = data.get(usize::try_from(decoder.total_in()).ok()?..)?;
    match tail.len() {
        0 => Some(out),
        8 => {
            let mut crc = flate2::Crc::new();
            crc.update(&out);
            let size = (out.len() as u32).to_le_bytes();
            (tail[..4] == crc.sum().to_le_bytes() && tail[4..] == size).then_some(out)
        }
        _ => None,
    }
}

/// HWPTAG_BIN_DATA(HWPTAG_BEGIN + 2).
const TAG_BIN_DATA: u16 = 18;

/// BinData 스트림 이름 → 저장 형태(압축이면 true). DocInfo BIN_DATA 속성(비트 0–3 형식: 1 내장·2 저장소, 비트 4–5 압축:
/// 0 문서 플래그를 따름·1 압축·2 비압축)과 FileHeader 압축 플래그로 정한다. 고정 rhwp의 읽기
/// (`parser/mod.rs` `bin_data_stream_is_compressed`)·쓰기(`serializer/cfb_writer.rs` `find_bin_data_info_with_compress`)와
/// 같은 규칙. 레코드를 해석할 수 없거나, 속성이 예약 값(3)이거나, 같은 이름에 형태가 둘이면 None(바이트 비교로 돌아감).
fn bin_data_storage(container: &Container) -> BTreeMap<String, Option<bool>> {
    let mut out = BTreeMap::new();
    let Some(data) = container
        .streams
        .get("DocInfo")
        .and_then(|data| unpack(container, data))
    else {
        return out;
    };
    for (tag, _, body) in records(&data).unwrap_or_default() {
        if tag != TAG_BIN_DATA || body.len() < 6 {
            continue;
        }
        let attr = u16::from_le_bytes([body[0], body[1]]);
        if !matches!(attr & 0x000F, 1 | 2) {
            continue; // 연결(외부 파일)
        }
        let id = u16::from_le_bytes([body[2], body[3]]);
        let len = usize::from(u16::from_le_bytes([body[4], body[5]]));
        let Some(units) = body.get(6..6 + len * 2) else {
            continue;
        };
        let units: Vec<u16> = units
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        let Ok(extension) = String::from_utf16(&units) else {
            continue;
        };
        let compressed = match (attr >> 4) & 0x0003 {
            0 => Some(container.compressed),
            1 => Some(true),
            2 => Some(false),
            _ => None,
        };
        let name = format!("BinData/BIN{id:04X}.{extension}");
        let entry = out.entry(name).or_insert(compressed);
        if *entry != compressed {
            *entry = None;
        }
    }
    out
}

/// 비레코드 스트림 비교. `storage`는 양쪽 BinData 저장 형태(정해지면).
fn compare_stream(
    name: &str,
    before: &[u8],
    after: &[u8],
    storage: (Option<bool>, Option<bool>),
) -> Option<Finding> {
    let changed = || Some(Finding::at(FindingCode::PartChanged, name));
    match storage {
        (Some(a), Some(b)) if a != b => changed(),
        (Some(true), Some(true)) if before != after => {
            let Some(a) = inflate(before) else {
                return Some(Finding::at(FindingCode::OriginalMalformed, name));
            };
            let Some(b) = inflate(after) else {
                return Some(Finding::at(FindingCode::OutputMalformed, name));
            };
            (a != b).then(|| Finding::at(FindingCode::PartChanged, name))
        }
        _ if before != after => changed(),
        _ => None,
    }
}

/// 레코드로 읽는 스트림: `DocInfo`와 `BodyText` 아래 전부(구역이 아닌 것도 레코드로 끝까지 읽어 비교한다).
fn record_stream(name: &str) -> bool {
    name == "DocInfo" || name.starts_with("BodyText/")
}

/// 편집이 바꿀 수 있는 본문 구역 스트림: 고정 rhwp가 읽고 쓰는 `BodyText/Section<N>`(`parser/cfb_reader.rs`
/// `format!("/BodyText/Section{}", index)` — N은 0이거나 0으로 시작하지 않는 10진수). 그 밖의 `BodyText` 아래 스트림
/// (`Section01`·`SectionX`·하위 저장소 등)은 면제하지 않는다(T009 3차 안정화).
fn section_stream(name: &str) -> bool {
    name.strip_prefix("BodyText/Section")
        .is_some_and(canonical_number)
}

/// 0이거나 0으로 시작하지 않는 10진수(9자리까지).
pub(crate) fn canonical_number(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 9
        && text.bytes().all(|b| b.is_ascii_digit())
        && (text == "0" || !text.starts_with('0'))
}

/// 레코드 스트림의 압축을 푼다(컨테이너의 압축 플래그를 따른다).
fn unpack(container: &Container, data: &[u8]) -> Option<Vec<u8>> {
    if container.compressed {
        inflate(data)
    } else {
        Some(data.to_vec())
    }
}

/// HWPTAG_DOCUMENT_PROPERTIES(DocInfo 첫 레코드). 고정 rhwp(`parser/doc_info.rs` `parse_document_properties`,
/// `serializer/doc_info.rs` `serialize_document_properties_from_model`)의 배치는 26바이트: 구역 수·시작 번호 6개(u16 ×7,
/// 14바이트) 뒤 캐럿 목록·문단·글자 위치(u32 ×3, 12바이트).
const TAG_DOCUMENT_PROPERTIES: u16 = 16;
const DOCUMENT_PROPERTIES_LEN: usize = 26;
const DOCUMENT_PROPERTIES_CARET: usize = 14;

/// 편집한 저장에서 DocInfo가 같은지: 레코드 열이 같고, 다를 수 있는 것은 26바이트 문서 속성 레코드의 캐럿 12바이트뿐이다
/// (rhwp가 편집 뒤 커서 위치를 쓴다, 실측). 길이가 26이 아닌(뒤에 모르는 바이트가 있거나 짧은) 레코드는 배치를 해석할 수
/// 없으므로 캐럿도 면제하지 않는다(바이트가 같아야 함). 구역 수·시작 번호·그 밖의 레코드는 같아야 한다.
fn same_docinfo(before: &[Record<'_>], after: &[Record<'_>]) -> bool {
    before.len() == after.len()
        && before.iter().zip(after).all(|(a, b)| {
            a == b
                || (a.0 == TAG_DOCUMENT_PROPERTIES
                    && a.0 == b.0
                    && a.1 == b.1
                    && a.2.len() == DOCUMENT_PROPERTIES_LEN
                    && b.2.len() == DOCUMENT_PROPERTIES_LEN
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
    let (bin_before, bin_after) = (bin_data_storage(&original), bin_data_storage(&output));
    let mut body_changed = false;
    for (name, before) in &original.streams {
        let Some(after) = output.streams.get(name) else {
            findings.push(Finding::at(FindingCode::PartMissing, name));
            continue;
        };
        if name == "FileHeader" {
            continue;
        }
        if !record_stream(name) {
            let storage = (
                bin_before.get(name).copied().flatten(),
                bin_after.get(name).copied().flatten(),
            );
            findings.extend(compare_stream(name, before, after, storage));
            continue;
        }
        // 레코드 스트림: 바이트가 같아도 양쪽을 끝까지 읽는다(원본이 깨졌으면 unknown, 출력이 깨졌으면 unsafe).
        let before_data = unpack(&original, before);
        let Some(before_records) = before_data.as_deref().and_then(records) else {
            findings.push(Finding::at(FindingCode::OriginalMalformed, name));
            continue;
        };
        let after_data = if before == after && original.compressed == output.compressed {
            None // 같은 바이트·같은 압축: 위에서 읽은 것과 같다
        } else {
            match unpack(&output, after) {
                Some(data) => Some(data),
                None => {
                    findings.push(Finding::at(FindingCode::OutputMalformed, name));
                    continue;
                }
            }
        };
        let after_records = match &after_data {
            None => before_records.clone(),
            Some(data) => match records(data) {
                Some(records) => records,
                None => {
                    findings.push(Finding::at(FindingCode::OutputMalformed, name));
                    continue;
                }
            },
        };
        if mode == Mode::Edited && section_stream(name) {
            body_changed |= before_records != after_records;
            continue; // 본문 내용은 다시 열기 비교 몫
        }
        let same = if mode == Mode::Edited && name == "DocInfo" {
            same_docinfo(&before_records, &after_records)
        } else {
            before_records == after_records
        };
        if !same {
            findings.push(Finding::at(FindingCode::RecordsChanged, name));
        }
    }
    // 본문을 바꾼 저장: 원본 그대로 남는 미리보기는 내용이 없음을 증명해야 한다(지운 글자가 남지 않게).
    if body_changed {
        let stale = |name: &str, empty: fn(&[u8]) -> bool| {
            output
                .streams
                .get(name)
                .is_some_and(|data| original.streams.get(name) == Some(data) && !empty(data))
        };
        if stale("PrvText", preview::blank_utf16) {
            findings.push(Finding::at(FindingCode::PreviewStale, "PrvText"));
        }
        if stale("PrvImage", preview::uniform_png) {
            findings.push(Finding::at(FindingCode::PreviewStale, "PrvImage"));
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
