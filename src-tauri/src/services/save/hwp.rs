//! HWP 5(CFB) 원본과 엔진 출력의 구조 비교.
//!
//! rhwp는 문서를 공통 IR로 읽고 다시 직렬화한다. 손실 보고(`content_loss.rs`)는 직렬화가 스스로 안 손실만 적으므로
//! 빈 보고서는 보존의 근거가 아니다(실측: 업스트림 예제 HWP 58개 모두 보고 0건인데 바이트가 다름). 그래서 원본과
//! 출력을 HWP의 단위로 비교한다:
//! - 스트림 이름 집합(빠지거나 생긴 스트림),
//! - `FileHeader` 256바이트,
//! - 레코드 스트림(`DocInfo`, `BodyText/Section*`): 압축을 풀고 레코드(태그·수준·내용)를 끝까지 읽어 같은 열인지. 바이트가
//!   같아도 양쪽을 끝까지 읽는다(같은 바이트의 깨진 레코드는 보존의 근거가 아니다, T009 안정화).
//! - DocInfo BIN_DATA 선언이 가리키는 `BinData/BIN{XXXX}.{ext}`(이름은 대소문자 무시): 양쪽 선언의 저장 형태가 같고,
//!   압축이면 **바이트가 같아도** 원본이 끝 블록까지(남는 바이트 없이) 풀려야 하며(같은 바이트의 깨진 스트림은 근거가
//!   아니다, T009 4차 안정화 B) 출력도 풀려 같은 내용, 비압축이면 바이트가 같아야 한다. 형태를 정할 수 없는 선언(예약
//!   압축 값, 형태가 다른 중복 선언)·해석할 수 없는 BIN_DATA 레코드·ASCII가 아닌 BinData 이름은 판단하지 않는다(unknown).
//! - 그 밖의 스트림(선언이 없는 BinData — 엔진이 그대로 옮긴다 —, 미리보기·스크립트·요약 정보 등): 저장한 바이트가 같아야
//!   한다. 한쪽만 풀리는 쌍을 풀린 내용으로 같다고 보지 않는다(읽는 쪽이 압축 여부를 스트림 바이트로 정하지 않으므로, T009 안정화).
//!
//! 섹터 배치처럼 스트림 내용이 아닌 차이는 같다고 본다. 암호·DRM·배포용 문서는 비교하지 않는다(unknown).
//! 본문을 바꾼 저장에서 `PrvText`·`PrvImage`가 원본 그대로이면 문서 내용과 무관함을 증명해야 한다(`preview`).
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

/// 스트림을 풀 수 없는 까닭.
#[derive(Clone, Copy)]
enum Unpack {
    /// 끝 블록까지 풀리지 않거나 뒤에 받지 않는 바이트가 있다.
    Malformed,
    /// 풀어낸 크기가 상한을 넘는다(판단하지 않는다).
    Limit,
}

impl Side {
    /// 풀 수 없는 스트림의 근거: 깨졌으면 원본은 unknown·출력은 unsafe, 상한 초과는 어느 쪽이든 unknown.
    fn unpack_finding(self, problem: Unpack, part: &str) -> Finding {
        match problem {
            Unpack::Malformed => Finding::at(self.malformed(), part),
            Unpack::Limit => Finding::at(FindingCode::LimitExceeded, part),
        }
    }
}

#[cfg(test)]
thread_local! {
    /// 시험용: 풀어낸 크기 상한을 낮춘다(상한을 넘는 입력을 실제 크기로 만들지 않고 시험한다).
    pub static INFLATE_LIMIT: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

fn inflate_limit() -> u64 {
    #[cfg(test)]
    if let Some(limit) = INFLATE_LIMIT.with(std::cell::Cell::get) {
        return limit;
    }
    MAX_INFLATED_BYTES
}

/// deflate를 끝 블록까지 푼다(고정 flate2 1.1.10의 읽기는 끝 블록 전에 입력이 끝나면 `UnexpectedEof` 오류다 — 시험
/// `b4_`가 잘린·끝 블록 없는 스트림으로 지킨다). 뒤에 남는 바이트는 없거나, 한컴 오피스가 붙이는 8바이트 꼬리(푼 내용의
/// CRC-32·길이, gzip 꼬리와 같은 배치, 실측)로서 푼 내용과 맞아야 한다. 그 밖의 남는 바이트는 읽는 쪽마다 다르게 다룰 수
/// 있어 받지 않는다.
fn inflate(data: &[u8]) -> Result<Vec<u8>, Unpack> {
    let limit = inflate_limit();
    let mut decoder = DeflateDecoder::new(data);
    let mut out = Vec::new();
    (&mut decoder)
        .take(limit + 1)
        .read_to_end(&mut out)
        .map_err(|_| Unpack::Malformed)?;
    if out.len() as u64 > limit {
        return Err(Unpack::Limit);
    }
    let tail = usize::try_from(decoder.total_in())
        .ok()
        .and_then(|at| data.get(at..))
        .ok_or(Unpack::Malformed)?;
    match tail.len() {
        0 => Ok(out),
        8 => {
            let mut crc = flate2::Crc::new();
            crc.update(&out);
            let size = (out.len() as u32).to_le_bytes();
            if tail[..4] == crc.sum().to_le_bytes() && tail[4..] == size {
                Ok(out)
            } else {
                Err(Unpack::Malformed)
            }
        }
        _ => Err(Unpack::Malformed),
    }
}

/// HWPTAG_BIN_DATA(HWPTAG_BEGIN + 2).
const TAG_BIN_DATA: u16 = 18;
/// BinData 스트림 이름의 저장소 부분(대문자). CFB 이름은 대소문자를 가리지 않는다(`cfb` `compare_names`, 엔진도 그렇게 찾는다).
const BIN_DATA_PREFIX: &str = "BINDATA/";

/// DocInfo BIN_DATA 선언으로 정한 BinData 스트림의 저장 형태.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Storage {
    Compressed,
    Stored,
    /// 압축 값이 예약(3)이거나 같은 이름에 형태가 다른 선언이 둘 이상: 정할 수 없다(판단하지 않는다).
    Undetermined,
}

/// BinData 스트림 이름(ASCII 대문자) → 저장 형태. DocInfo BIN_DATA 속성(비트 0–3 형식: 0 연결·1 내장·2 저장소, 비트 4–5
/// 압축: 0 문서 플래그를 따름·1 압축·2 비압축)과 FileHeader 압축 플래그로 정한다. 고정 rhwp의 읽기
/// (`parser/mod.rs` `bin_data_stream_is_compressed`, `parser/doc_info.rs` `parse_bin_data`)·쓰기(`serializer/cfb_writer.rs`
/// `find_bin_data_info_with_compress`)와 같은 이름 규칙(`BIN{아이디:04X}.{확장자}`, 확장자가 없는 저장소는 `OLE`).
///
/// 선언 자체를 해석할 수 없으면(T009 4차 안정화 B) 어느 스트림을 어떻게 읽는지 정할 수 없으므로 근거를 돌려준다: 아이디·
/// 확장자가 레코드 끝을 넘거나 확장자가 UTF-16이 아니면 그 쪽의 깨짐(`DocInfo`), 예약 형식(3–15)·ASCII가 아닌 확장자는
/// `Unsupported`(엔진은 예약 형식을 연결로, 예약 압축 값을 문서 플래그로 읽지만 규격의 뜻이 아니다). DocInfo를 풀거나
/// 레코드로 읽을 수 없으면 빈 표(그 근거는 레코드 비교가 낸다).
fn bin_data_storage(
    container: &Container,
    side: Side,
) -> Result<BTreeMap<String, Storage>, Finding> {
    let mut out = BTreeMap::new();
    let Some(data) = container
        .streams
        .get("DocInfo")
        .and_then(|data| unpack(container, data).ok())
    else {
        return Ok(out);
    };
    let malformed = || Finding::at(side.malformed(), "DocInfo");
    let unsupported = || Finding::at(FindingCode::Unsupported, "DocInfo");
    for (tag, _, body) in records(&data).unwrap_or_default() {
        if tag != TAG_BIN_DATA {
            continue;
        }
        let attr = u16::from_le_bytes(
            body.get(..2)
                .ok_or_else(malformed)?
                .try_into()
                .map_err(|_| malformed())?,
        );
        let kind = attr & 0x000F;
        match kind {
            0 => continue, // 연결(외부 파일): 스트림이 없다
            1 | 2 => {}
            _ => return Err(unsupported()),
        }
        let id = u16::from_le_bytes(
            body.get(2..4)
                .ok_or_else(malformed)?
                .try_into()
                .map_err(|_| malformed())?,
        );
        let extension = match body.get(4..6) {
            // 규격의 저장소 선언에는 확장자가 없다: 엔진처럼 `OLE`.
            None if kind == 2 && body.len() == 4 => "OLE".to_owned(),
            None => return Err(malformed()),
            Some(len) => {
                let len = usize::from(u16::from_le_bytes([len[0], len[1]]));
                let units: Vec<u16> = body
                    .get(6..6 + len * 2)
                    .ok_or_else(malformed)?
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|pair| u16::from_le_bytes(*pair))
                    .collect();
                String::from_utf16(&units).map_err(|_| malformed())?
            }
        };
        if !extension.is_ascii() {
            return Err(unsupported());
        }
        let storage = match (attr >> 4) & 0x0003 {
            0 if container.compressed => Storage::Compressed,
            0 | 2 => Storage::Stored,
            1 => Storage::Compressed,
            _ => Storage::Undetermined,
        };
        let name = format!("BinData/BIN{id:04X}.{extension}").to_ascii_uppercase();
        let entry = out.entry(name).or_insert(storage);
        if *entry != storage {
            *entry = Storage::Undetermined;
        }
    }
    Ok(out)
}

/// 비레코드 스트림 비교. `storage`는 양쪽 BIN_DATA 선언으로 정한 저장 형태(선언이 없는 스트림은 None: 엔진이 그대로 옮기는
/// 불투명 바이트라 바이트가 같아야 한다).
fn compare_stream(
    name: &str,
    before: &[u8],
    after: &[u8],
    storage: (Option<Storage>, Option<Storage>),
) -> Option<Finding> {
    let changed = || Some(Finding::at(FindingCode::PartChanged, name));
    match storage {
        (a, b) if a != b => changed(),
        (Some(Storage::Undetermined), _) => Some(Finding::at(FindingCode::Unsupported, name)),
        (Some(Storage::Compressed), _) => {
            // 압축으로 정해진 스트림은 바이트가 같아도 원본이 끝까지 풀려야 한다(같은 바이트의 깨진 스트림은 보존의 근거가
            // 아니다, T009 4차 안정화 B). 같은 바이트면 출력도 방금 확인한 그 스트림이라 다시 풀지 않는다.
            let a = match inflate(before) {
                Ok(data) => data,
                Err(problem) => return Some(Side::Original.unpack_finding(problem, name)),
            };
            if before == after {
                return None;
            }
            let b = match inflate(after) {
                Ok(data) => data,
                Err(problem) => return Some(Side::Output.unpack_finding(problem, name)),
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
fn unpack(container: &Container, data: &[u8]) -> Result<Vec<u8>, Unpack> {
    if container.compressed {
        inflate(data)
    } else {
        Ok(data.to_vec())
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
    // 원본의 선언을 해석할 수 없으면 판정은 이미 unknown이다: 양쪽 다 선언 없이(불투명 바이트로) 비교한다.
    let (bin_before, bin_after) = match bin_data_storage(&original, Side::Original) {
        Ok(before) => match bin_data_storage(&output, Side::Output) {
            Ok(after) => (before, after),
            Err(finding) => {
                findings.push(finding);
                (before, BTreeMap::new())
            }
        },
        Err(finding) => {
            findings.push(finding);
            (BTreeMap::new(), BTreeMap::new())
        }
    };
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
            let key = name.to_ascii_uppercase();
            if key.starts_with(BIN_DATA_PREFIX) && !name.is_ascii() {
                // ASCII가 아닌 BinData 이름은 CFB의 대소문자 규칙으로 어느 선언과 짝인지 확실히 정할 수 없다.
                findings.push(Finding::at(FindingCode::Unsupported, name));
                continue;
            }
            let storage = (bin_before.get(&key).copied(), bin_after.get(&key).copied());
            findings.extend(compare_stream(name, before, after, storage));
            continue;
        }
        // 레코드 스트림: 바이트가 같아도 양쪽을 끝까지 읽는다(원본이 깨졌으면 unknown, 출력이 깨졌으면 unsafe).
        let before_data = match unpack(&original, before) {
            Ok(data) => data,
            Err(problem) => {
                findings.push(Side::Original.unpack_finding(problem, name));
                continue;
            }
        };
        let Some(before_records) = records(&before_data) else {
            findings.push(Finding::at(FindingCode::OriginalMalformed, name));
            continue;
        };
        let after_data = if before == after && original.compressed == output.compressed {
            None // 같은 바이트·같은 압축: 위에서 읽은 것과 같다
        } else {
            match unpack(&output, after) {
                Ok(data) => Some(data),
                Err(problem) => {
                    findings.push(Side::Output.unpack_finding(problem, name));
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
    // 본문을 바꾼 저장: 원본 그대로 남는 미리보기는 문서 내용과 무관함을 증명해야 한다(지운 내용이 남지 않게).
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
        if stale("PrvImage", preview::known_blank_png) {
            findings.push(Finding::at(FindingCode::PreviewStale, "PrvImage"));
        }
    }
    if mode == Mode::Edited {
        findings.extend(references(&output));
    }
    findings
}

const TAG_CHAR_SHAPE: u16 = 21;
const TAG_PARA_SHAPE: u16 = 25;
const TAG_PARA_HEADER: u16 = 66;
const TAG_PARA_CHAR_SHAPE: u16 = 68;
/// `PARA_HEADER`의 문단 모양 ID 자리: 글자 수(u32)·컨트롤 마스크(u32) 뒤 u16(고정 rhwp `parser/body_text.rs` `parse_para_header`).
const PARA_HEADER_SHAPE_AT: usize = 8;

/// 출력 본문의 모양 참조 무결성(T009, T010 Phase 0 Stage B 결함 수정): 모든 구역 스트림(표 셀·글상자 등 중첩 문단도 같은 스트림의
/// 레코드)의 `PARA_HEADER` 문단 모양 ID와 `PARA_CHAR_SHAPE`(위치 u32·글자 모양 ID u32 쌍의 열) 글자 모양 ID가 출력 DocInfo의
/// 정의 개수(`PARA_SHAPE`·`CHAR_SHAPE` 레코드 수 — HWP 5 모양 ID는 DocInfo 등장 순서의 번호, 고정 rhwp `parser/doc_info.rs`)보다
/// 작아야 한다. 고정 rhwp는 없는 ID를 기본 모양으로 말없이 그린다. 미리보기 규칙과 따로 판정한다(`referenceInvalid`, unsafe).
/// - 모양 ID 자리가 없는 `PARA_HEADER`, 비었거나 8의 배수가 아닌 `PARA_CHAR_SHAPE`(엔진은 남는 바이트를 버리고 빈 열은 기본
///   모양으로 읽는다)도 맞지 않는 참조로 본다.
/// - DocInfo·구역을 풀거나 읽을 수 없으면 비교(`compare_with`)가 이미 근거를 냈으므로 여기서는 더하지 않는다.
fn references(output: &Container) -> Vec<Finding> {
    let Some(docinfo) = output.streams.get("DocInfo") else {
        return Vec::new();
    };
    let Ok(docinfo) = unpack(output, docinfo) else {
        return Vec::new();
    };
    let Some(docinfo) = records(&docinfo) else {
        return Vec::new();
    };
    let count = |tag: u16| docinfo.iter().filter(|r| r.0 == tag).count() as u64;
    let (char_shapes, para_shapes) = (count(TAG_CHAR_SHAPE), count(TAG_PARA_SHAPE));
    let mut findings = Vec::new();
    for (name, data) in &output.streams {
        if !section_stream(name) {
            continue;
        }
        let Ok(data) = unpack(output, data) else {
            continue;
        };
        let Some(section) = records(&data) else {
            continue;
        };
        let invalid = section.iter().any(|(tag, _, body)| match *tag {
            TAG_PARA_HEADER => body
                .get(PARA_HEADER_SHAPE_AT..PARA_HEADER_SHAPE_AT + 2)
                .is_none_or(|id| u64::from(u16::from_le_bytes([id[0], id[1]])) >= para_shapes),
            TAG_PARA_CHAR_SHAPE => {
                body.is_empty()
                    || body.len() % 8 != 0
                    || body.as_chunks::<8>().0.iter().any(|pair| {
                        u64::from(u32::from_le_bytes([pair[4], pair[5], pair[6], pair[7]]))
                            >= char_shapes
                    })
            }
            _ => false,
        });
        if invalid {
            findings.push(Finding::at(FindingCode::ReferenceInvalid, name));
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
