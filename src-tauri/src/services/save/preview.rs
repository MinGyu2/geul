//! 미리보기에 문서 내용이 없음을 증명한다(T009 안정화, 낡은 미리보기의 정보 노출).
//!
//! rhwp는 미리보기를 문서에서 다시 만들지 않고 원본 것을 그대로 쓴다(고정 커밋 `parser/hwpx/contract_streams.rs`: 없으면
//! 빈 문서 `blank2010`의 것). 그래서 본문을 바꾼 저장에서 원본 미리보기가 남으면 지운·바꾼 글자가 파일에 남을 수 있다.
//! 미리보기를 대신 만들 수단이 없으므로, 본문을 바꾼 저장은 미리보기가 **내용이 없음을 증명할 수 있을 때만** 원본 그대로
//! 둔다. 그 밖(글자가 있음, 한 색이 아닌 그림, 해석할 수 없는 그림)은 낡은 미리보기로 보고 저장하지 않는다.
//!
//! - 글자: 공백·제어 문자뿐(HWP `PrvText`는 UTF-16 LE, HWPX `Preview/PrvText.txt`는 UTF-8).
//! - 그림: PNG(8비트, 비월 없음, 회색조·RGB·회색조+알파·RGBA)를 풀어 모든 픽셀이 같다(한 색). 다른 형식·깨진 PNG·크기 한도
//!   초과는 증명하지 못한 것으로 본다. zlib 검사합은 보지 않는다(내용이 없음을 보는 것이지 그림이 올바른지가 아니다 —
//!   rhwp가 만든 1×1 미리보기의 검사합이 틀림, 실측).

use std::io::Read;

use flate2::read::DeflateDecoder;

/// 그림 픽셀 수·풀어낸 크기 상한.
const MAX_PIXELS: u64 = 64 * 1024 * 1024;
const MAX_RAW_BYTES: u64 = 512 * 1024 * 1024;

/// HWP `PrvText`(UTF-16 LE)가 공백뿐인지. 홀수 길이·서러게이트 오류는 증명 못 함.
pub fn blank_utf16(data: &[u8]) -> bool {
    let (pairs, rest) = data.as_chunks::<2>();
    if !rest.is_empty() {
        return false;
    }
    let units: Vec<u16> = pairs.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
    String::from_utf16(&units).is_ok_and(|text| blank(&text))
}

/// UTF-8 글자가 공백뿐인지(BOM 허용).
pub fn blank_utf8(data: &[u8]) -> bool {
    let data = data.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(data);
    std::str::from_utf8(data).is_ok_and(blank)
}

fn blank(text: &str) -> bool {
    text.chars()
        .all(|c| c.is_whitespace() || c.is_control() || c == '\u{FEFF}')
}

/// PNG가 한 색인지(모든 픽셀이 같음)이고 픽셀 밖에 내용을 담을 자리가 없는지. 증명할 수 없으면 false: 글자를 담을 수
/// 있는 보조 덩어리(`tEXt`·`zTXt`·`iTXt`·`eXIf` 등, 아래 목록 밖 전부), `IEND` 뒤 바이트, 픽셀보다 긴 압축 해제 내용,
/// deflate 뒤에 남는 바이트가 있으면 증명하지 않는다. 검사합(CRC·Adler-32)은 보지 않는다(값이 틀려도 숨길 자리는 아님).
pub fn uniform_png(data: &[u8]) -> bool {
    uniform(data).unwrap_or(false)
}

fn uniform(data: &[u8]) -> Option<bool> {
    let mut at = data.strip_prefix(b"\x89PNG\r\n\x1a\n").map(|_| 8)?;
    let (mut header, mut idat, mut ended) = (None, Vec::new(), false);
    while at < data.len() {
        let len = u32::from_be_bytes(data.get(at..at + 4)?.try_into().ok()?) as usize;
        let kind = data.get(at + 4..at + 8)?;
        let body = data.get(at + 8..at.checked_add(8)?.checked_add(len)?)?;
        data.get(at + 8 + len..at + 12 + len)?; // CRC 자리(값은 보지 않음)
        at += 12 + len;
        match kind {
            b"IHDR" if header.is_none() => header = Some(body.to_vec()),
            b"IDAT" => idat.extend_from_slice(body),
            b"IEND" => {
                ended = true;
                break;
            }
            // 색·감마·해상도·배경·시각: 글을 담지 않는 고정 모양의 보조 덩어리.
            b"sRGB" | b"gAMA" | b"cHRM" | b"pHYs" | b"bKGD" | b"tIME" if body.len() <= 32 => {}
            _ => return None,
        }
    }
    let header = header?;
    if !ended || at != data.len() || header.len() != 13 {
        return None;
    }
    let width = u64::from(u32::from_be_bytes(header[0..4].try_into().ok()?));
    let height = u64::from(u32::from_be_bytes(header[4..8].try_into().ok()?));
    let (depth, color, interlace) = (header[8], header[9], header[12]);
    let channels: u64 = match color {
        0 => 1,
        2 => 3,
        4 => 2,
        6 => 4,
        _ => return None, // 팔레트(3) 등은 증명하지 않는다
    };
    if depth != 8 || interlace != 0 || header[10] != 0 || header[11] != 0 {
        return None;
    }
    if width == 0 || height == 0 || width.checked_mul(height)? > MAX_PIXELS {
        return None;
    }
    // zlib 머리(2바이트)를 건너뛰고 deflate로 푼다. 뒤에는 Adler-32 4바이트만 있어야 한다(값은 보지 않음).
    let stream = idat.get(2..)?;
    let mut decoder = DeflateDecoder::new(stream);
    let mut raw = Vec::new();
    (&mut decoder)
        .take(MAX_RAW_BYTES + 1)
        .read_to_end(&mut raw)
        .ok()?;
    if decoder.total_in().checked_add(4)? != stream.len() as u64 {
        return None;
    }
    let stride = usize::try_from(width.checked_mul(channels)?).ok()?;
    let expected = (stride + 1).checked_mul(usize::try_from(height).ok()?)?;
    if raw.len() != expected {
        return None;
    }
    let bpp = channels as usize;
    let mut previous = vec![0u8; stride];
    let mut first: Option<Vec<u8>> = None;
    for row in raw.chunks_exact(stride + 1) {
        let (filter, line) = (row[0], &row[1..]);
        let mut current = vec![0u8; stride];
        for i in 0..stride {
            let a = if i >= bpp { current[i - bpp] } else { 0 };
            let b = previous[i];
            let c = if i >= bpp { previous[i - bpp] } else { 0 };
            let predictor = match filter {
                0 => 0,
                1 => a,
                2 => b,
                3 => ((u16::from(a) + u16::from(b)) / 2) as u8,
                4 => {
                    let p = i16::from(a) + i16::from(b) - i16::from(c);
                    let (pa, pb, pc) = (
                        (p - i16::from(a)).abs(),
                        (p - i16::from(b)).abs(),
                        (p - i16::from(c)).abs(),
                    );
                    if pa <= pb && pa <= pc {
                        a
                    } else if pb <= pc {
                        b
                    } else {
                        c
                    }
                }
                _ => return None,
            };
            current[i] = line[i].wrapping_add(predictor);
        }
        let pixel = current[..bpp].to_vec();
        if current.chunks_exact(bpp).any(|p| p != pixel.as_slice()) {
            return Some(false);
        }
        match &first {
            None => first = Some(pixel),
            Some(seen) if *seen != pixel => return Some(false),
            _ => {}
        }
        previous = current;
    }
    Some(true)
}
