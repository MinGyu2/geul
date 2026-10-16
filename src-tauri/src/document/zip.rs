//! 형식 판별 전용 ZIP 판독기.
//!
//! 중앙 디렉터리(항목 이름·크기·플래그)만 읽고, 판별에 필요한 작은 항목 몇 개만 상한 안에서 푼다. 문서 전체를
//! 풀지 않는다. 엔진이 문서를 열 때는 엔진의 판독기를 쓴다(T007/T008).
//!
//! 방어: 항목 수·중앙 디렉터리 크기·이름 길이 상한, 여러 디스크로 나뉜 ZIP 거부, 대소문자만 다른 중복 이름
//! 거부(판독기마다 다른 항목을 고르는 문제), 항목 범위가 중앙 디렉터리를 넘지 않는지 확인, 읽을 때 로컬 헤더
//! 이름 대조·압축 해제 크기 상한(`take`)·선언 크기·CRC 확인.

use std::collections::HashSet;
use std::io::{self, Read, Seek, SeekFrom};

use flate2::read::DeflateDecoder;
use flate2::Crc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZipProblem {
    /// 끝 레코드가 없거나 데이터가 중간에 끊김.
    Truncated,
    Corrupt,
    EntryCount,
    MetadataSize,
    PartSize,
    Encrypted,
    UnsupportedMethod,
    Io,
}

#[derive(Clone, Copy, Debug)]
pub struct ZipLimits {
    pub max_entries: u64,
    pub max_directory_bytes: u64,
    pub max_name_bytes: usize,
}

#[derive(Debug)]
pub struct Entry {
    name: Vec<u8>,
    flags: u16,
    method: u16,
    crc32: u32,
    compressed_size: u64,
    uncompressed_size: u64,
    local_offset: u64,
}

impl Entry {
    /// 전통 ZIP 암호·AES 등 암호화 플래그(비트 0).
    pub fn is_encrypted(&self) -> bool {
        self.flags & 1 != 0
    }
}

#[derive(Debug)]
pub struct Archive {
    entries: Vec<Entry>,
    directory_offset: u64,
}

const EOCD_SIG: u32 = 0x0605_4b50;
const EOCD_LEN: u64 = 22;
const MAX_COMMENT: u64 = 0xFFFF;
const ZIP64_LOCATOR_SIG: u32 = 0x0706_4b50;
const ZIP64_LOCATOR_LEN: u64 = 20;
const ZIP64_EOCD_SIG: u32 = 0x0606_4b50;
const ZIP64_EOCD_LEN: u64 = 56;
const CENTRAL_SIG: u32 = 0x0201_4b50;
const CENTRAL_LEN: usize = 46;
const LOCAL_SIG: u32 = 0x0403_4b50;
const LOCAL_LEN: u64 = 30;

fn le16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn le32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().expect("4바이트"))
}

fn le64(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().expect("8바이트"))
}

fn read_at<R: Read + Seek>(reader: &mut R, offset: u64, len: u64) -> Result<Vec<u8>, ZipProblem> {
    let len = usize::try_from(len).map_err(|_| ZipProblem::MetadataSize)?;
    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|_| ZipProblem::Io)?;
    let mut buffer = vec![0; len];
    reader
        .read_exact(&mut buffer)
        .map_err(|error| match error.kind() {
            io::ErrorKind::UnexpectedEof => ZipProblem::Truncated,
            _ => ZipProblem::Io,
        })?;
    Ok(buffer)
}

/// 끝 레코드(EOCD)를 찾아 중앙 디렉터리를 읽는다. `len`은 파일 길이다.
pub fn read_directory<R: Read + Seek>(
    reader: &mut R,
    len: u64,
    limits: &ZipLimits,
) -> Result<Archive, ZipProblem> {
    if len < EOCD_LEN {
        return Err(ZipProblem::Truncated);
    }
    let tail_len = len.min(EOCD_LEN + MAX_COMMENT);
    let tail_start = len - tail_len;
    let tail = read_at(reader, tail_start, tail_len)?;
    // 주석 길이가 정확히 파일 끝까지 닿는 마지막 서명만 끝 레코드로 본다(주석 속 우연한 서명 배제).
    let position = (0..=tail.len() - EOCD_LEN as usize)
        .rev()
        .find(|&at| {
            le32(&tail, at) == EOCD_SIG
                && at + EOCD_LEN as usize + le16(&tail, at + 20) as usize == tail.len()
        })
        .ok_or(ZipProblem::Truncated)?;
    let eocd_offset = tail_start + position as u64;
    let eocd = &tail[position..];
    let disk = le16(eocd, 4);
    let directory_disk = le16(eocd, 6);
    let entries_on_disk = le16(eocd, 8);
    let entries_total = le16(eocd, 10);
    let mut directory_size = u64::from(le32(eocd, 12));
    let mut directory_offset = u64::from(le32(eocd, 16));
    let mut count = u64::from(entries_total);
    let mut directory_end = eocd_offset;

    let zip64 = [disk, directory_disk, entries_on_disk, entries_total].contains(&0xFFFF)
        || directory_size == 0xFFFF_FFFF
        || directory_offset == 0xFFFF_FFFF;
    if zip64 {
        let locator_offset = eocd_offset
            .checked_sub(ZIP64_LOCATOR_LEN)
            .ok_or(ZipProblem::Corrupt)?;
        let locator = read_at(reader, locator_offset, ZIP64_LOCATOR_LEN)?;
        if le32(&locator, 0) != ZIP64_LOCATOR_SIG
            || le32(&locator, 4) != 0
            || le32(&locator, 16) != 1
        {
            return Err(ZipProblem::Corrupt);
        }
        let record_offset = le64(&locator, 8);
        if record_offset
            .checked_add(ZIP64_EOCD_LEN)
            .is_none_or(|end| end > locator_offset)
        {
            return Err(ZipProblem::Corrupt);
        }
        let record = read_at(reader, record_offset, ZIP64_EOCD_LEN)?;
        if le32(&record, 0) != ZIP64_EOCD_SIG
            || le32(&record, 16) != 0
            || le32(&record, 20) != 0
            || le64(&record, 24) != le64(&record, 32)
        {
            return Err(ZipProblem::Corrupt);
        }
        count = le64(&record, 32);
        directory_size = le64(&record, 40);
        directory_offset = le64(&record, 48);
        directory_end = record_offset;
    } else if disk != 0 || directory_disk != 0 || entries_on_disk != entries_total {
        return Err(ZipProblem::Corrupt); // 여러 디스크로 나뉜 ZIP
    }

    if count > limits.max_entries {
        return Err(ZipProblem::EntryCount);
    }
    if directory_size > limits.max_directory_bytes {
        return Err(ZipProblem::MetadataSize);
    }
    if directory_offset
        .checked_add(directory_size)
        .is_none_or(|end| end > directory_end)
    {
        return Err(ZipProblem::Corrupt);
    }
    let directory = read_at(reader, directory_offset, directory_size)?;
    let entries = parse_directory(&directory, count, directory_offset, limits)?;
    Ok(Archive {
        entries,
        directory_offset,
    })
}

fn parse_directory(
    directory: &[u8],
    count: u64,
    directory_offset: u64,
    limits: &ZipLimits,
) -> Result<Vec<Entry>, ZipProblem> {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    let mut at = 0usize;
    for _ in 0..count {
        let fixed = directory
            .get(at..at + CENTRAL_LEN)
            .ok_or(ZipProblem::Corrupt)?;
        if le32(fixed, 0) != CENTRAL_SIG {
            return Err(ZipProblem::Corrupt);
        }
        let name_len = le16(fixed, 28) as usize;
        let extra_len = le16(fixed, 30) as usize;
        let comment_len = le16(fixed, 32) as usize;
        if name_len > limits.max_name_bytes {
            return Err(ZipProblem::MetadataSize);
        }
        let name_start = at + CENTRAL_LEN;
        let extra_start = name_start + name_len;
        let next = extra_start + extra_len + comment_len;
        let name = directory
            .get(name_start..extra_start)
            .ok_or(ZipProblem::Corrupt)?
            .to_vec();
        let extra = directory
            .get(extra_start..extra_start + extra_len)
            .ok_or(ZipProblem::Corrupt)?;
        if next > directory.len() {
            return Err(ZipProblem::Corrupt);
        }

        let mut uncompressed_size = u64::from(le32(fixed, 24));
        let mut compressed_size = u64::from(le32(fixed, 20));
        let mut local_offset = u64::from(le32(fixed, 42));
        let mut disk_start = u32::from(le16(fixed, 34));
        if uncompressed_size == 0xFFFF_FFFF
            || compressed_size == 0xFFFF_FFFF
            || local_offset == 0xFFFF_FFFF
            || disk_start == 0xFFFF
        {
            let mut values = zip64_extra(extra).ok_or(ZipProblem::Corrupt)?;
            let mut next_u64 = || -> Result<u64, ZipProblem> {
                let (value, rest) = values.split_first_chunk::<8>().ok_or(ZipProblem::Corrupt)?;
                values = rest;
                Ok(u64::from_le_bytes(*value))
            };
            if uncompressed_size == 0xFFFF_FFFF {
                uncompressed_size = next_u64()?;
            }
            if compressed_size == 0xFFFF_FFFF {
                compressed_size = next_u64()?;
            }
            if local_offset == 0xFFFF_FFFF {
                local_offset = next_u64()?;
            }
            if disk_start == 0xFFFF {
                let (value, _) = values.split_first_chunk::<4>().ok_or(ZipProblem::Corrupt)?;
                disk_start = u32::from_le_bytes(*value);
            }
        }
        if disk_start != 0 {
            return Err(ZipProblem::Corrupt);
        }
        // 항목 데이터가 중앙 디렉터리 앞에서 끝나야 한다.
        let data_end = local_offset
            .checked_add(LOCAL_LEN)
            .and_then(|end| end.checked_add(compressed_size))
            .ok_or(ZipProblem::Corrupt)?;
        if data_end > directory_offset {
            return Err(ZipProblem::Corrupt);
        }
        if !seen.insert(name.to_ascii_lowercase()) {
            return Err(ZipProblem::Corrupt);
        }
        entries.push(Entry {
            name,
            flags: le16(fixed, 8),
            method: le16(fixed, 10),
            crc32: le32(fixed, 16),
            compressed_size,
            uncompressed_size,
            local_offset,
        });
        at = next;
    }
    if at != directory.len() {
        return Err(ZipProblem::Corrupt);
    }
    Ok(entries)
}

/// 확장 필드 중 ZIP64(0x0001) 값 부분.
fn zip64_extra(mut extra: &[u8]) -> Option<&[u8]> {
    while extra.len() >= 4 {
        let id = le16(extra, 0);
        let size = le16(extra, 2) as usize;
        let data = extra.get(4..4 + size)?;
        if id == 0x0001 {
            return Some(data);
        }
        extra = &extra[4 + size..];
    }
    None
}

impl Archive {
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// 이름이 정확히 같은 항목.
    pub fn find(&self, name: &str) -> Option<&Entry> {
        self.entries
            .iter()
            .find(|entry| entry.name == name.as_bytes())
    }

    /// OPC 부분 이름처럼 ASCII 대소문자를 무시하고 찾는다(중복은 read_directory에서 이미 거부).
    pub fn find_ignore_case(&self, name: &str) -> Option<&Entry> {
        self.entries
            .iter()
            .find(|entry| entry.name.eq_ignore_ascii_case(name.as_bytes()))
    }

    /// 항목 하나를 `max` 바이트 안에서 풀어 돌려준다.
    pub fn read<R: Read + Seek>(
        &self,
        reader: &mut R,
        entry: &Entry,
        max: u64,
    ) -> Result<Vec<u8>, ZipProblem> {
        if entry.is_encrypted() {
            return Err(ZipProblem::Encrypted);
        }
        // Deflate는 압축되지 않는 데이터에서 조금 커질 수 있다(64 KiB 블록마다 5바이트).
        if entry.uncompressed_size > max || entry.compressed_size > max + max / 64 + 1024 {
            return Err(ZipProblem::PartSize);
        }
        let local = read_at(reader, entry.local_offset, LOCAL_LEN)?;
        if le32(&local, 0) != LOCAL_SIG {
            return Err(ZipProblem::Corrupt);
        }
        let name_len = u64::from(le16(&local, 26));
        let extra_len = u64::from(le16(&local, 28));
        let local_name = read_at(reader, entry.local_offset + LOCAL_LEN, name_len)?;
        if local_name != entry.name {
            return Err(ZipProblem::Corrupt);
        }
        let data_start = entry.local_offset + LOCAL_LEN + name_len + extra_len;
        if data_start + entry.compressed_size > self.directory_offset {
            return Err(ZipProblem::Corrupt);
        }
        let compressed = read_at(reader, data_start, entry.compressed_size)?;
        let data = match entry.method {
            0 => compressed,
            8 => {
                let mut out = Vec::with_capacity(entry.uncompressed_size as usize);
                DeflateDecoder::new(compressed.as_slice())
                    .take(max + 1)
                    .read_to_end(&mut out)
                    .map_err(|_| ZipProblem::Corrupt)?;
                if out.len() as u64 > max {
                    return Err(ZipProblem::PartSize);
                }
                out
            }
            _ => return Err(ZipProblem::UnsupportedMethod),
        };
        if data.len() as u64 != entry.uncompressed_size {
            return Err(ZipProblem::Corrupt);
        }
        let mut crc = Crc::new();
        crc.update(&data);
        if crc.sum() != entry.crc32 {
            return Err(ZipProblem::Corrupt);
        }
        Ok(data)
    }
}
