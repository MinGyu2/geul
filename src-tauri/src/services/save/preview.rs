//! 미리보기에 문서 내용이 없음을 증명한다(T009 안정화, 낡은 미리보기의 정보 노출).
//!
//! rhwp는 미리보기를 문서에서 다시 만들지 않고 원본 것을 그대로 쓴다(고정 커밋 `serializer/cfb_writer.rs`
//! `supplement_preview`: HWP `PrvText`는 비었을 때만 본문으로 채움, `parser/hwpx/contract_streams.rs`: 없으면 빈 문서
//! `blank2010`의 것). 그래서 본문을 바꾼 저장에서 원본 미리보기가 남으면 지운·바꾼 글자가 파일에 남을 수 있다. 미리보기를
//! 대신 만들 수단이 없으므로, 본문을 바꾼 저장은 남는 미리보기 **전체가** 내용을 담을 수 없음을 증명할 때만 원본 그대로
//! 둔다. "보이는 픽셀이 한 색"과 "파일에 남은 바이트가 정보를 담지 않음"은 다른 주장이다: 아래는 뒤의 것을 확인한다.
//!
//! - 글자: 공백·탭·CR·LF뿐(맨 앞 BOM 하나 허용). 그 밖의 제어 문자·서식 문자는 정보를 담을 수 있어 받지 않는다(T009 3차).
//! - 그림(PNG): 모든 바이트의 뜻이 정해진 구조만 받는다(T009 3차 안정화, `uniform`).
//!   - 서명, 첫 덩어리 IHDR(정확히 13바이트, 너비·높이 1..2^31-1, 8비트, 회색조·RGB·회색조+알파·RGBA, 압축·필터·비월 0).
//!   - 보조 덩어리는 담을 수 있는 값이 작고 정해진 표시 정보만, 각각 한 번, IDAT 앞: `sRGB`(1바이트, 0~3), `gAMA`(4바이트,
//!     0이 아님), `pHYs`(9바이트, 단위 0·1). 그 밖(글 덩어리, `cHRM`·`bKGD`·`tIME`·`iCCP`, 모르는 덩어리)은 받지 않는다.
//!   - IDAT는 하나 이상 이어서, 끝은 길이 0인 IEND, 뒤에 바이트 없음. 모든 덩어리의 CRC가 맞음.
//!   - zlib 머리(CM 8, CINFO ≤ 7, FDICT 0, FCHECK), deflate가 끝까지 끝나고 뒤에는 Adler-32 4바이트만, 그 값이 맞음, 푼
//!     내용이 픽셀 줄 크기와 정확히 같음, 줄 필터 0~4, 모든 픽셀이 같음.
//!   - 예외 하나: 고정 rhwp가 HWPX에 넣는 빈 미리보기(`RHWP_BLANK_PREVIEW_PNG`)와 바이트가 정확히 같을 때. IDAT CRC와
//!     Adler-32가 틀린 그림이지만(실측) 모든 바이트를 알고 있다(1×1 투명 픽셀).
//!
//! 남는 것: deflate 부호화의 선택(블록 나누기·허프만 표)과 보조 덩어리의 값(합쳐 14바이트 이하)은 내용과 무관하게 남을 수
//! 있다. 문서 글자를 담기에는 너무 작고 정해진 뜻이 있는 값이라 받아들인다.

use std::io::Read;

use flate2::read::DeflateDecoder;

/// 그림 픽셀 수·풀어낸 크기 상한.
const MAX_PIXELS: u64 = 64 * 1024 * 1024;
const MAX_RAW_BYTES: u64 = 512 * 1024 * 1024;
/// PNG 정수(너비·높이·덩어리 길이)의 상한(규격: 2^31 - 1).
const PNG_MAX: u32 = 0x7fff_ffff;

/// 고정 rhwp(`1a76570`, `src/serializer/hwpx/static_assets.rs` `PRV_IMAGE_PNG`)가 HWPX `Preview/PrvImage.png`로 쓰는 1×1
/// 회색조+알파 투명 PNG, 바이트 그대로. IDAT CRC(`6F6867BC`, 맞는 값 `386A482B`)와 Adler-32(`00050001`, 맞는 값 `00060002`)가
/// 틀리다. 문서와 무관한 엔진 상수이므로 정확히 이 바이트일 때만 내용이 없다고 본다.
pub const RHWP_BLANK_PREVIEW_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xB5, 0x1C, 0x0C,
    0x02, 0x00, 0x00, 0x00, 0x0B, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x64, 0x60, 0x00, 0x00,
    0x00, 0x05, 0x00, 0x01, 0x6F, 0x68, 0x67, 0xBC, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
    0xAE, 0x42, 0x60, 0x82,
];

/// HWP `PrvText`(UTF-16 LE)가 비었는지(공백·탭·CR·LF뿐, 맨 앞 BOM 허용). 홀수 길이·서러게이트 오류는 증명 못 함.
pub fn blank_utf16(data: &[u8]) -> bool {
    let (pairs, rest) = data.as_chunks::<2>();
    if !rest.is_empty() {
        return false;
    }
    let units: Vec<u16> = pairs.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
    String::from_utf16(&units).is_ok_and(|text| blank(&text))
}

/// UTF-8 글자가 비었는지(공백·탭·CR·LF뿐, 맨 앞 BOM 허용).
pub fn blank_utf8(data: &[u8]) -> bool {
    std::str::from_utf8(data).is_ok_and(blank)
}

fn blank(text: &str) -> bool {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    text.chars().all(|c| matches!(c, ' ' | '\t' | '\r' | '\n'))
}

/// PNG가 한 색이고 픽셀 밖에 정보를 담을 자리가 없는지(모듈 설명의 규칙). 증명할 수 없으면 false.
pub fn uniform_png(data: &[u8]) -> bool {
    data == RHWP_BLANK_PREVIEW_PNG || uniform(data).unwrap_or(false)
}

/// `at`의 PNG 덩어리 하나: (종류, 본문, 다음 덩어리 위치). 길이가 규격 안이고 끝을 넘지 않으며 CRC가 맞아야 한다.
fn chunk(data: &[u8], at: usize) -> Option<(&[u8], &[u8], usize)> {
    let len = u32::from_be_bytes(data.get(at..at.checked_add(4)?)?.try_into().ok()?);
    if len > PNG_MAX {
        return None;
    }
    let body_at = at.checked_add(8)?;
    let end = body_at.checked_add(len as usize)?;
    let kind = data.get(at + 4..body_at)?;
    let body = data.get(body_at..end)?;
    let stored = u32::from_be_bytes(data.get(end..end.checked_add(4)?)?.try_into().ok()?);
    let mut crc = flate2::Crc::new();
    crc.update(kind);
    crc.update(body);
    (crc.sum() == stored).then_some((kind, body, end + 4))
}

fn adler32(data: &[u8]) -> u32 {
    const MOD: u32 = 65521;
    let (mut a, mut b) = (1u32, 0u32);
    for block in data.chunks(5552) {
        for &byte in block {
            a += u32::from(byte);
            b += a;
        }
        a %= MOD;
        b %= MOD;
    }
    (b << 16) | a
}

fn uniform(data: &[u8]) -> Option<bool> {
    let mut at = data.strip_prefix(b"\x89PNG\r\n\x1a\n").map(|_| 8)?;
    // IHDR: 처음, 정확히 13바이트.
    let (kind, header, next) = chunk(data, at)?;
    if kind != b"IHDR" || header.len() != 13 {
        return None;
    }
    at = next;
    let width = u32::from_be_bytes(header[0..4].try_into().ok()?);
    let height = u32::from_be_bytes(header[4..8].try_into().ok()?);
    let (depth, color) = (header[8], header[9]);
    let channels: u64 = match color {
        0 => 1,
        2 => 3,
        4 => 2,
        6 => 4,
        _ => return None, // 팔레트(3) 등은 증명하지 않는다
    };
    if depth != 8 || header[10..13] != [0, 0, 0] {
        return None;
    }
    if !(1..=PNG_MAX).contains(&width) || !(1..=PNG_MAX).contains(&height) {
        return None;
    }
    if u64::from(width).checked_mul(u64::from(height))? > MAX_PIXELS {
        return None;
    }
    // IDAT 앞의 보조 덩어리: 허용 목록만, 각각 한 번, 정확한 길이·값.
    let mut seen: Vec<&[u8]> = Vec::new();
    loop {
        let (kind, body, next) = chunk(data, at)?;
        if kind == b"IDAT" {
            break;
        }
        let valid = match kind {
            b"sRGB" => body.len() == 1 && body[0] <= 3,
            b"gAMA" => body.len() == 4 && body != [0; 4],
            b"pHYs" => body.len() == 9 && body[8] <= 1,
            _ => false,
        };
        if !valid || seen.contains(&kind) {
            return None;
        }
        seen.push(kind);
        at = next;
    }
    // IDAT: 하나 이상 이어서. 그 뒤는 길이 0인 IEND와 끝.
    let mut idat = Vec::new();
    loop {
        let (kind, body, next) = chunk(data, at)?;
        match kind {
            b"IDAT" => idat.extend_from_slice(body),
            b"IEND" if body.is_empty() && next == data.len() => break,
            _ => return None,
        }
        at = next;
    }
    // zlib: CM 8(deflate), CINFO ≤ 7(창 32 KiB 이하), FDICT 0, FCHECK.
    let (&cmf, &flg) = (idat.first()?, idat.get(1)?);
    if cmf & 0x0f != 8
        || cmf >> 4 > 7
        || flg & 0x20 != 0
        || (u16::from(cmf) * 256 + u16::from(flg)) % 31 != 0
    {
        return None;
    }
    let stride = usize::try_from(u64::from(width).checked_mul(channels)?).ok()?;
    let expected = (stride.checked_add(1)?).checked_mul(usize::try_from(height).ok()?)?;
    if expected as u64 > MAX_RAW_BYTES {
        return None;
    }
    // deflate가 끝까지 끝나고(더 읽을 것 없음) 뒤에는 Adler-32만, 푼 내용은 정확히 픽셀 줄 크기(넘으면 거기서 멈춤).
    let stream = idat.get(2..)?;
    let mut decoder = DeflateDecoder::new(stream);
    let mut raw = Vec::new();
    (&mut decoder)
        .take(expected as u64 + 1)
        .read_to_end(&mut raw)
        .ok()?;
    if raw.len() != expected || decoder.read(&mut [0u8; 1]).ok()? != 0 {
        return None;
    }
    let consumed = usize::try_from(decoder.total_in()).ok()?;
    let checksum: [u8; 4] = stream.get(consumed..)?.try_into().ok()?;
    if u32::from_be_bytes(checksum) != adler32(&raw) {
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
