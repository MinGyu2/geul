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
use std::io::{Cursor, Read, Write};

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
    before.len() == after.len() && before.iter().zip(after).all(|(a, b)| same_record(a, b))
}

/// 레코드가 같거나, 문서 속성 레코드의 캐럿 12바이트만 다르다.
fn same_record(a: &Record<'_>, b: &Record<'_>) -> bool {
    a == b
        || (a.0 == TAG_DOCUMENT_PROPERTIES
            && a.0 == b.0
            && a.1 == b.1
            && a.2.len() == DOCUMENT_PROPERTIES_LEN
            && b.2.len() == DOCUMENT_PROPERTIES_LEN
            && a.2[..DOCUMENT_PROPERTIES_CARET] == b.2[..DOCUMENT_PROPERTIES_CARET])
}

const TAG_ID_MAPPINGS: u16 = 17;
/// `ID_MAPPINGS` 안 글자 모양 수(u32) 자리: BIN_DATA 1개·글꼴 7개·BORDER_FILL 1개 뒤(고정 rhwp `serialize_id_mappings`,
/// `surgical_insert_record`의 표 오프셋 36과 같음).
const ID_MAPPINGS_CHAR_SHAPES_AT: usize = 36;
/// `CHAR_SHAPE`의 장평(u8 ×7)·자간(i8 ×7) 자리: 글꼴 ID u16 ×7(14바이트) 뒤(고정 rhwp `serializer/char_shape.rs`).
const CHAR_SHAPE_RATIOS: std::ops::Range<usize> = 14..21;
const CHAR_SHAPE_SPACINGS: std::ops::Range<usize> = 21..28;

/// T012 장평·자간(Stage 5): 편집한 HWP DocInfo가 원본에 **글자 모양 덧붙임만** 더한 것인지. 성립하면 (원본 글자 모양 수, 덧붙인 수).
///
/// 실측(한컴 저장 `KTX.hwp`, DocInfo 1195 레코드, 장평·자간 + 정리 `compactAppendedCharShapes`): 차이는 `ID_MAPPINGS`와 마지막 원본
/// `CHAR_SHAPE` 바로 뒤에 끼운 `CHAR_SHAPE` 하나뿐이고 나머지 레코드는 바이트까지 같다. 그래서 다음을 모두 요구한다.
/// - 원본 `CHAR_SHAPE` 레코드는 이어져 있고, 출력 = 원본 앞부분 + 같은 수준의 새 `CHAR_SHAPE` k개(k ≥ 1) + 원본 뒷부분.
/// - `ID_MAPPINGS`는 길이·나머지 바이트가 같고 글자 모양 수만 정확히 k만큼 늘었다. 그 밖의 레코드는 같다(문서 속성 캐럿만 예외).
/// - 새 레코드마다 같은 길이의 **원본** 글자 모양 하나와 장평·자간 14바이트 밖이 모두 같고, 장평 7개는 같은 값 50–200, 자간 7개는
///   같은 값 −50–50이다(앱이 쓰는 값 — 굵게 등 다른 속성 변경은 받지 않음).
///
/// 새 모양이 모두 본문에서 쓰이는지는 `appended_char_shapes_referenced`가 따로 본다.
fn docinfo_char_shapes_appended(
    before: &[Record<'_>],
    after: &[Record<'_>],
) -> Option<(usize, usize)> {
    let positions: Vec<usize> = before
        .iter()
        .enumerate()
        .filter(|(_, r)| r.0 == TAG_CHAR_SHAPE)
        .map(|(i, _)| i)
        .collect();
    let (&first, &last) = (positions.first()?, positions.last()?);
    if last - first + 1 != positions.len() {
        return None;
    }
    let k = after.len().checked_sub(before.len()).filter(|k| *k > 0)?;
    let level = before[first].1;
    let originals = &before[first..=last];
    let inserted = &after[last + 1..last + 1 + k];
    let metric = |data: &[u8], range: std::ops::Range<usize>, ok: &dyn Fn(u8) -> bool| {
        data.get(range)
            .is_some_and(|v| v.iter().all(|b| *b == v[0]) && ok(v[0]))
    };
    let valid = |r: &Record<'_>| {
        r.0 == TAG_CHAR_SHAPE
            && r.1 == level
            && matches!(r.2.len(), 68 | 70 | 74)
            && metric(r.2, CHAR_SHAPE_RATIOS, &|v| (50..=200).contains(&v))
            && metric(r.2, CHAR_SHAPE_SPACINGS, &|v| {
                (-50..=50).contains(&(v as i8))
            })
            && originals.iter().any(|o| {
                o.2.len() == r.2.len()
                    && o.2[..CHAR_SHAPE_RATIOS.start] == r.2[..CHAR_SHAPE_RATIOS.start]
                    && o.2[CHAR_SHAPE_SPACINGS.end..] == r.2[CHAR_SHAPE_SPACINGS.end..]
            })
    };
    if !inserted.iter().all(valid) {
        return None;
    }
    let rest_same = before[..=last]
        .iter()
        .zip(&after[..=last])
        .chain(before[last + 1..].iter().zip(&after[last + 1 + k..]))
        .all(|(a, b)| {
            if a.0 == TAG_ID_MAPPINGS {
                // 수가 정확히 k만큼 늘어야 한다(그대로인 레코드는 받지 않음).
                b.0 == TAG_ID_MAPPINGS
                    && a.1 == b.1
                    && a.2
                        .get(ID_MAPPINGS_CHAR_SHAPES_AT..ID_MAPPINGS_CHAR_SHAPES_AT + 4)
                        .is_some_and(|v| {
                            u32::from_le_bytes([v[0], v[1], v[2], v[3]]) as usize == positions.len()
                        })
                    && id_mappings_grew(a.2, b.2, k)
            } else {
                same_record(a, b)
            }
        });
    let id_mappings = before.iter().filter(|r| r.0 == TAG_ID_MAPPINGS).count();
    (rest_same && id_mappings == 1).then_some((positions.len(), k))
}

/// `ID_MAPPINGS`가 글자 모양 수만 `k`만큼 늘고 나머지 바이트는 같은지.
fn id_mappings_grew(a: &[u8], b: &[u8], k: usize) -> bool {
    let at = ID_MAPPINGS_CHAR_SHAPES_AT;
    let count = |d: &[u8]| {
        d.get(at..at + 4)
            .map(|v| u32::from_le_bytes([v[0], v[1], v[2], v[3]]) as usize)
    };
    a.len() >= at + 4
        && a.len() == b.len()
        && a[..at] == b[..at]
        && a.get(at + 4..) == b.get(at + 4..)
        && matches!((count(a), count(b)), (Some(x), Some(y)) if x.checked_add(k) == Some(y))
}

/// 덧붙인 글자 모양(`base..base+k`)이 모두 출력 본문의 `PARA_CHAR_SHAPE`에서 쓰이는지(쓰이지 않는 정의를 남기지 않음, T010 덧붙임 규칙의
/// HWP판). 본문을 읽을 수 없으면 아니다.
fn appended_char_shapes_referenced(output: &Container, base: usize, k: usize) -> bool {
    let mut used = vec![false; k];
    for (name, data) in &output.streams {
        if !section_stream(name) {
            continue;
        }
        let Ok(data) = unpack(output, data) else {
            return false;
        };
        let Some(section) = records(&data) else {
            return false;
        };
        for (tag, _, body) in section {
            if tag == TAG_PARA_CHAR_SHAPE && body.len() % 8 == 0 {
                for pair in body.as_chunks::<8>().0 {
                    let id = u32::from_le_bytes([pair[4], pair[5], pair[6], pair[7]]) as usize;
                    if let Some(slot) = id.checked_sub(base).and_then(|i| used.get_mut(i)) {
                        *slot = true;
                    }
                }
            }
        }
    }
    used.iter().all(|u| *u)
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

fn compare_with(
    original: &[u8],
    output: &[u8],
    mode: Mode,
    expected_image: Option<&[u8]>,
) -> Vec<Finding> {
    // A regenerated PrvImage is judged after the loop, against this save's own encoding.
    let expected_image = expected_image.filter(|_| mode == Mode::Edited);
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
            // Validate regenerated text against the actual exported body below.
            if mode == Mode::Edited && name == "PrvText" {
                continue;
            }
            if expected_image.is_some() && name == "PrvImage" {
                continue;
            }
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
                || docinfo_char_shapes_appended(&before_records, &after_records)
                    .is_some_and(|(base, k)| appended_char_shapes_referenced(&output, base, k))
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
        if stale("PrvText", preview::blank_utf16)
            && text_preview(&output).as_ref() != output.streams.get("PrvText")
        {
            findings.push(Finding::at(FindingCode::PreviewStale, "PrvText"));
        }
        if expected_image.is_none() && stale("PrvImage", preview::known_blank_hwp_image) {
            findings.push(Finding::at(FindingCode::PreviewStale, "PrvImage"));
        }
    }
    // Regenerated PrvImage: only with a changed body, only the exact bytes encoded for this
    // save, and only if they independently decode as the canonical preview at the size the
    // output's own first PAGE_DEF requires. Anything else stays a changed part (unsafe).
    if let Some(expected) = expected_image {
        let accepted = body_changed
            && original.streams.contains_key("PrvImage")
            && output.streams.get("PrvImage").map(Vec::as_slice) == Some(expected)
            && regenerated_image_valid(&output, expected);
        if !accepted {
            findings.push(Finding::at(FindingCode::PartChanged, "PrvImage"));
        }
    }
    if mode == Mode::Edited {
        if let (Some(before), Some(after)) = (
            original.streams.get("PrvText"),
            output.streams.get("PrvText"),
        ) {
            if before != after && (!body_changed || text_preview(&output).as_ref() != Some(after)) {
                findings.push(Finding::at(FindingCode::PartChanged, "PrvText"));
            }
        }
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
    compare_with(original, output, Mode::Unedited, None)
}

/// 저장 검사: 원본과 편집한 엔진 출력을 비교한 근거(본문 밖이 원본과 같은지, 본문이 레코드로 읽히는지).
pub fn compare_saved(original: &[u8], output: &[u8]) -> Vec<Finding> {
    compare_with(original, output, Mode::Edited, None)
}

/// 저장 검사(미리보기 그림을 이번 저장에서 다시 만든 경우): `expected_image`는 이 저장이 부호화한 PrvImage 바이트다.
pub fn compare_saved_with_preview(
    original: &[u8],
    output: &[u8],
    expected_image: Option<&[u8]>,
) -> Vec<Finding> {
    compare_with(original, output, Mode::Edited, expected_image)
}

const TAG_PAGE_DEF: u16 = 73;

/// Section0's first PAGE_DEF: (width, height, landscape). HWP 5 layout: width u32, height
/// u32, seven margin u32, attribute u32 (bit 0 = landscape) — 40 bytes.
fn first_page_def(container: &Container) -> Option<(u32, u32, bool)> {
    let data = unpack(container, container.streams.get("BodyText/Section0")?).ok()?;
    let (_, _, body) = records(&data)?
        .into_iter()
        .find(|(tag, _, _)| *tag == TAG_PAGE_DEF)?;
    let word = |at: usize| {
        body.get(at..at + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    };
    Some((word(0)?, word(4)?, word(36)? & 1 == 1))
}

fn preview_size(container: &Container) -> Option<(u32, u32)> {
    let (width, height, landscape) = first_page_def(container)?;
    preview::preview_dimensions(width, height, landscape)
}

fn regenerated_image_valid(output: &Container, image: &[u8]) -> bool {
    match (preview::decode_canonical_png(image), preview_size(output)) {
        (Some((w, h, _)), Some(size)) => (w, h) == size,
        _ => false,
    }
}

/// Reconstruct the pinned serializer's first 1000 body characters, excluding nested
/// table/textbox paragraphs. Decode only verified HWP5 controls; unknown layouts
/// cannot authorize a preview update. Section order is numeric, not lexical.
fn text_preview(output: &Container) -> Option<Vec<u8>> {
    let mut sections: Vec<_> = output
        .streams
        .iter()
        .filter(|(name, _)| section_stream(name))
        .map(|(name, data)| (name["BodyText/Section".len()..].parse::<usize>().ok(), data))
        .collect();
    sections.sort_by_key(|(number, _)| *number);
    if sections.is_empty() {
        return None;
    }
    let mut text = String::new();
    let mut characters = 0;
    for (index, (number, data)) in sections.into_iter().enumerate() {
        if number != Some(index) {
            return None;
        }
        let data = unpack(output, data).ok()?;
        for (tag, level, body) in records(&data)? {
            if tag != 67 || level != 1 {
                continue;
            }
            if body.len() % 2 != 0 {
                return None;
            }
            // Decode without per-paragraph UTF-16/String allocations. Continue
            // validating all controls and surrogate pairs after the prefix fills.
            let unit = |at: usize| {
                body.get(at * 2..at * 2 + 2)
                    .map(|b| u16::from_le_bytes([b[0], b[1]]))
            };
            let mut at = 0;
            let mut invalid = false;
            let units = std::iter::from_fn(|| {
                while let Some(ch) = unit(at) {
                    at += 1;
                    let value = match ch {
                        0 => continue,
                        13 if at * 2 == body.len() => return None,
                        10 => 10,
                        2 | 9 | 11 => {
                            if unit(at + 6) != Some(ch) {
                                invalid = true;
                                return None;
                            }
                            at += 7;
                            if ch != 9 {
                                continue;
                            }
                            9
                        }
                        24 => 0x00ad,
                        30 => 0x00a0,
                        31 => 0x2007,
                        0x20..=0xffff => ch,
                        _ => {
                            invalid = true;
                            return None;
                        }
                    };
                    return Some(value);
                }
                None
            });
            let mut nonempty = false;
            for ch in char::decode_utf16(units) {
                let ch = ch.ok()?;
                nonempty = true;
                if characters < 1000 {
                    text.push(ch);
                    characters += 1;
                }
            }
            if invalid {
                return None;
            }
            if nonempty {
                for ch in ['\r', '\n'] {
                    if characters < 1000 {
                        text.push(ch);
                        characters += 1;
                    }
                }
            }
        }
    }
    // An empty PrvText stream is not round-trippable: pinned RHWP reads it as no preview text
    // (`cfb_reader::read_preview_text`) and then omits the stream on export, so the next
    // session's preflight reports `partMissing:PrvText` (observed in native run
    // target/preview-tables-toc-20261108/a/native1). Use Hancom's/RHWP's content-free blank
    // `\r\n` instead (`preview::blank_utf16`), which RHWP re-exports byte-identically.
    if text.is_empty() {
        text.push_str("\r\n");
    }
    Some(text.encode_utf16().flat_map(u16::to_le_bytes).collect())
}

#[cfg(test)]
thread_local! {
    pub(super) static REFRESH_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Refresh only an otherwise valid output whose sole finding is stale/changed PrvText.
/// The fresh CFB avoids retaining deleted preview bytes in free/slack sectors.
/// Every other stream, storage, CLSID, state bit and timestamp is copied; no
/// engine sources/gitlinks change. Caller must still run all final save gates.
pub fn refresh_text_preview(
    original: &[u8],
    output: &[u8],
) -> Result<Option<Vec<u8>>, crate::document::DocumentError> {
    #[cfg(test)]
    REFRESH_CALLS.with(|calls| calls.set(calls.get() + 1));
    let findings = compare_saved(original, output);
    if findings != [Finding::at(FindingCode::PreviewStale, "PrvText")]
        && findings != [Finding::at(FindingCode::PartChanged, "PrvText")]
    {
        return Ok(None);
    }
    let Ok(container) = open(output, Side::Output) else {
        return Ok(None);
    };
    let Some(text) = text_preview(&container) else {
        return Ok(None);
    };
    crate::document::resources::charge(
        crate::document::resources::Category::Staging,
        output.len(),
    )?;
    rebuild_preview(output, &container, &[("PrvText", &text)])
        .map(Some)
        .map_err(|_| crate::document::DocumentError::Internal)
}

/// Result of [`refresh_previews`]: the rebuilt output (if any) and the PrvImage bytes it
/// encoded, which final validation must find unchanged in the published output.
#[derive(Debug, Default)]
pub struct RefreshedPreviews {
    pub output: Option<Vec<u8>>,
    pub image: Option<Vec<u8>>,
}

/// HWP5 control ids are stored little-endian: `secd`/`cold` (section and column definitions).
const CTRL_SECTION: [u8; 4] = *b"dces";
const CTRL_COLUMN: [u8; 4] = *b"dloc";

/// Decode only whitespace and understood non-painting controls. Extended
/// control 2 must name a matching section/column header; other extended/inline
/// controls are not blank evidence, even when their header is absent.
fn blank_paragraph_text(body: &[u8]) -> Option<Vec<[u8; 4]>> {
    if !body.len().is_multiple_of(2) {
        return None;
    }
    let units: Vec<u16> = body
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| u16::from_le_bytes(*b))
        .collect();
    // PARA_TEXT includes exactly one paragraph terminator, at its end.
    if units.last() != Some(&13) || units[..units.len() - 1].contains(&13) {
        return None;
    }
    let mut controls = Vec::new();
    let mut at = 0;
    while at < units.len() {
        match units[at] {
            2 | 9 => {
                let code = units[at];
                if units.get(at + 7) != Some(&code) {
                    return None;
                }
                if code == 2 {
                    let id: [u8; 4] = body.get(at * 2 + 2..at * 2 + 6)?.try_into().ok()?;
                    if id != CTRL_SECTION && id != CTRL_COLUMN {
                        return None;
                    }
                    controls.push(id);
                } else if units[at + 1..at + 7].iter().any(|unit| *unit != 0) {
                    // A tab can carry leader/fill parameters. Only the empty
                    // parameter form is proven non-painting here.
                    return None;
                }
                at += 8;
            }
            10 | 13 | 30 | 31 => at += 1,
            0..=31 => return None,
            unit => {
                // Surrogates, including malformed UTF-16, and all visible
                // characters refuse. No lossy decoding/replacement characters.
                if !char::from_u32(u32::from(unit)).is_some_and(char::is_whitespace) {
                    return None;
                }
                at += 1;
            }
        }
    }
    Some(controls)
}

/// Whether Section0's first top-level paragraph — which always starts page 1 — can show
/// anything: a visible character, or any control other than the section/column definitions
/// (tables, drawings, pictures, headers/footers, page numbers, fields…). Undecodable or
/// missing structure counts as visible (fail closed). This is a necessary condition for a
/// blank page 1, not a proof: later paragraphs may still reach page 1, which only layout knows.
fn first_paragraph_visible(container: &Container) -> bool {
    let Some(data) = container.streams.get("BodyText/Section0") else {
        return true;
    };
    let Ok(data) = unpack(container, data) else {
        return true;
    };
    let Some(records) = records(&data) else {
        return true;
    };
    // HWP5 §4.3: Section starts with a level-0 PARA_HEADER, whose direct
    // children own text/shapes/line segments and controls. Never search past an
    // unexplained prefix or skip a child merely because RHWP preserves it raw.
    let Some(&(TAG_PARA_HEADER, 0, header)) = records.first() else {
        return true;
    };
    if !matches!(header.len(), 22 | 24) {
        return true;
    }
    let mut text_controls = Vec::new();
    let mut headers = Vec::new();
    let mut text_seen = false;
    let mut section_owner = false;
    for &(tag, level, body) in records.iter().skip(1) {
        if tag == TAG_PARA_HEADER && level == 0 {
            break;
        }
        match (tag, level) {
            (67, 1) if !text_seen => {
                text_seen = true;
                let Some(controls) = blank_paragraph_text(body) else {
                    return true;
                };
                text_controls = controls;
                let count =
                    u32::from_le_bytes(header[..4].try_into().unwrap_or_default()) & 0x7fff_ffff;
                if body.len() / 2 != count as usize {
                    return true;
                }
                section_owner = false;
            }
            // PARA_SHAPE is in DocInfo, referenced by PARA_HEADER (not a body
            // record). Its reference and CHAR_SHAPE references are checked by
            // `references`. These direct children carry positions, not content.
            (68, 1) if !body.is_empty() && body.len().is_multiple_of(8) => {
                section_owner = false;
            }
            (69, 1) if body.len().is_multiple_of(36) => section_owner = false,
            // Nonempty range tags may annotate/highlight text. Do not assume
            // arbitrary tag parameters are invisible.
            (70, 1) if body.is_empty() => section_owner = false,
            (71, 1) => {
                let Some(id) = body.get(..4) else {
                    return true;
                };
                section_owner = id == CTRL_SECTION;
                if section_owner {
                    // 24-byte base, optional language, and the genuine Hancom
                    // fixture's zero-padded extension. Refuse other extensions.
                    if !matches!(body.len(), 28 | 30 | 38)
                        || (body.len() == 38 && body[30..].iter().any(|b| *b != 0))
                    {
                        return true;
                    }
                } else if id == CTRL_COLUMN {
                    // RHWP's variable-width layout: attr/attr2, width+gap per
                    // column, then separator. A column separator can paint.
                    let Some(bytes) = body.get(4..6) else {
                        return true;
                    };
                    let attr = u16::from_le_bytes([bytes[0], bytes[1]]);
                    let count = (attr >> 2) & 0xff;
                    let unequal = attr & 0x1000 == 0 && count > 1;
                    let size = if unequal {
                        14 + usize::from(count) * 4
                    } else {
                        16
                    };
                    if count == 0
                        || attr & 3 == 3
                        || (attr >> 10) & 3 == 3
                        || body.len() != size
                        || body[size - 6] != 0
                    {
                        return true;
                    }
                } else {
                    return true; // Table, drawing, field, header/footer, etc.
                }
                let Ok(id) = <[u8; 4]>::try_from(id) else {
                    return true;
                };
                headers.push(id);
            }
            // Only direct children of secd, never of cold or arbitrary nested
            // controls: PAGE_DEF, FOOTNOTE_SHAPE (28 in real HWP/RHWP, despite
            // the older spec's 26), PAGE_BORDER_FILL. They configure layout;
            // page-1 painting (including borders) is still frontend evidence.
            (73, 2) if section_owner && body.len() == 40 => {}
            (74, 2) if section_owner && body.len() == 28 => {}
            (75, 2) if section_owner && body.len() == 14 => {}
            // Includes CTRL_DATA/ParameterSets, LIST_HEADER/master pages,
            // nested paragraphs, unknown future tags, and misplaced metadata.
            _ => return true,
        }
    }
    !text_seen || text_controls != headers
}

/// Regenerate PrvText *and* PrvImage when the only obstacles to an otherwise valid edited
/// output are its stale previews and the frontend supplied a render of page 1 of the reopened
/// raw export. Without a raster, or when PrvImage is not stale, this is exactly
/// [`refresh_text_preview`]. Refusals return no output; the caller's final gates then reject.
/// - The size comes from the output's own Section0 PAGE_DEF (`preview::preview_dimensions`);
///   a raster outside canvas rounding slack of it is refused (wrong page geometry).
/// - A uniform raster is a failed render unless page 1 is proven blank by two independent
///   pieces of evidence: the frontend's page-1 paint list held only a plain background and
///   empty text runs (`raster.blank_page`), and Section0's first paragraph — always on page 1 —
///   shows nothing (`first_paragraph_visible`). The serialized PrvText is not that evidence:
///   it is the content-free CRLF for an empty body and may summarize later pages.
/// - The new CFB must differ from the raw export only in PrvText/PrvImage (`verify_preview_rebuild`).
pub fn refresh_previews(
    original: &[u8],
    output: &[u8],
    raster: Option<&preview::PreviewRaster>,
) -> Result<RefreshedPreviews, crate::document::DocumentError> {
    let text_only = || {
        refresh_text_preview(original, output).map(|output| RefreshedPreviews {
            output,
            image: None,
        })
    };
    let Some(raster) = raster else {
        return text_only();
    };
    let findings = compare_saved(original, output);
    let image = Finding::at(FindingCode::PreviewStale, "PrvImage");
    let allowed = [
        Finding::at(FindingCode::PreviewStale, "PrvText"),
        Finding::at(FindingCode::PartChanged, "PrvText"),
        image.clone(),
    ];
    if !findings.contains(&image) || !findings.iter().all(|f| allowed.contains(f)) {
        return text_only();
    }
    let refused = Ok(RefreshedPreviews::default());
    let Ok(container) = open(output, Side::Output) else {
        return refused;
    };
    let (Some(text), Some((width, height))) = (text_preview(&container), preview_size(&container))
    else {
        return refused;
    };
    let Some(rgb) = preview::fit_raster(raster, width, height) else {
        return refused;
    };
    let uniform = rgb
        .as_chunks::<3>()
        .0
        .iter()
        .all(|pixel| pixel[..] == rgb[..3]);
    if uniform && !(raster.blank_page && !first_paragraph_visible(&container)) {
        return refused;
    }
    let Some(png) = preview::encode_png(width, height, &rgb) else {
        return refused;
    };
    crate::document::resources::charge(
        crate::document::resources::Category::Staging,
        output.len() + png.len(),
    )?;
    let bytes = rebuild_preview(
        output,
        &container,
        &[("PrvText", &text), ("PrvImage", &png)],
    )
    .map_err(|_| crate::document::DocumentError::Internal)?;
    Ok(RefreshedPreviews {
        output: Some(bytes),
        image: Some(png),
    })
}

fn rebuild_preview(
    output: &[u8],
    container: &Container,
    replaced: &[(&str, &[u8])],
) -> std::io::Result<Vec<u8>> {
    let source = cfb::CompoundFile::open(Cursor::new(output))?;
    let entries: Vec<_> = source.walk().collect();
    let mut fresh =
        cfb::CompoundFile::create_with_version(source.version(), Cursor::new(Vec::new()))?;
    for entry in &entries {
        let path = entry.path();
        if entry.is_storage() {
            if !entry.is_root() {
                fresh.create_storage_all(path)?;
            }
            fresh.set_storage_clsid(path, *entry.clsid())?;
        } else {
            let name = path
                .to_str()
                .ok_or(std::io::ErrorKind::InvalidData)?
                .trim_start_matches('/');
            let data: &[u8] = if let Some((_, data)) = replaced.iter().find(|(n, _)| *n == name) {
                data
            } else {
                container
                    .streams
                    .get(name)
                    .ok_or(std::io::ErrorKind::InvalidData)?
            };
            fresh.create_stream(path)?.write_all(data)?;
        }
    }
    // Restore metadata after writes, which can touch parent storage timestamps.
    for entry in entries {
        fresh.set_state_bits(entry.path(), entry.state_bits())?;
        fresh.set_created_time(entry.path(), entry.created())?;
        fresh.set_modified_time(entry.path(), entry.modified())?;
    }
    fresh.flush()?;
    let bytes = fresh.into_inner().into_inner();
    verify_preview_rebuild(output, &bytes, container, replaced)?;
    Ok(bytes)
}

/// Raw-export reopen evidence transfers to the final output only if the complete
/// logical CFB differs solely in the replaced preview streams (each of which must already
/// exist). Physical allocation is deliberately new.
fn verify_preview_rebuild(
    raw: &[u8],
    bytes: &[u8],
    container: &Container,
    replaced: &[(&str, &[u8])],
) -> std::io::Result<()> {
    let invalid = || std::io::Error::from(std::io::ErrorKind::InvalidData);
    let before = cfb::CompoundFile::open(Cursor::new(raw))?;
    let mut after = cfb::CompoundFile::open(Cursor::new(bytes))?;
    if before.version() != after.version() {
        return Err(invalid());
    }
    let entries: Vec<_> = before.walk().collect();
    if entries.len() != after.walk().count() {
        return Err(invalid());
    }
    for entry in entries {
        let actual = after.entry(entry.path())?;
        if entry.is_stream() != actual.is_stream()
            || entry.clsid() != actual.clsid()
            || entry.state_bits() != actual.state_bits()
            || entry.created() != actual.created()
            || entry.modified() != actual.modified()
        {
            return Err(invalid());
        }
        if entry.is_stream() {
            let name = entry
                .path()
                .to_str()
                .ok_or_else(invalid)?
                .trim_start_matches('/');
            let expected = if let Some((_, data)) = replaced.iter().find(|(n, _)| *n == name) {
                data
            } else {
                container.streams.get(name).ok_or_else(invalid)?.as_slice()
            };
            let mut stream = after.open_stream(entry.path())?;
            if stream.len() != expected.len() as u64 {
                return Err(invalid());
            }
            let mut buffer = [0; 8192];
            for chunk in expected.chunks(buffer.len()) {
                stream.read_exact(&mut buffer[..chunk.len()])?;
                if &buffer[..chunk.len()] != chunk {
                    return Err(invalid());
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod id_mapping_tests {
    use super::id_mappings_grew;

    #[test]
    fn id_mappings_count_boundary_and_exact_growth() {
        let payload = |count: u32| {
            let mut data = vec![0; 40];
            data[36..40].copy_from_slice(&count.to_le_bytes());
            data
        };
        for length in 0..40 {
            assert!(!id_mappings_grew(&vec![0; length], &vec![0; length], 1));
        }
        assert!(id_mappings_grew(&payload(2), &payload(3), 1));
        assert!(!id_mappings_grew(&payload(2), &payload(4), 1));
        assert!(!id_mappings_grew(&payload(2), &payload(2), 1));
        assert!(!id_mappings_grew(&payload(u32::MAX), &payload(0), 1));
        assert!(!id_mappings_grew(&payload(2), &payload(3), usize::MAX));
        let mut changed = payload(3);
        changed[0] = 1;
        assert!(!id_mappings_grew(&payload(2), &changed, 1));
        let mut longer = payload(3);
        longer.push(0);
        assert!(!id_mappings_grew(&payload(2), &longer, 1));
        assert!(!id_mappings_grew(&longer, &payload(3), 1));
        let mut original = payload(2);
        original.push(0);
        longer[40] = 1;
        assert!(!id_mappings_grew(&original, &longer, 1));
    }
}
