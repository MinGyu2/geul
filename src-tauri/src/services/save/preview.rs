//! 본문을 바꾼 저장에서 원본 그대로 남는 미리보기가 문서 내용과 무관함을 증명한다(T009 안정화 F, 4차 안정화 C).
//!
//! rhwp는 미리보기를 문서에서 다시 만들지 않고 원본 것을 그대로 쓴다(고정 커밋 `serializer/cfb_writer.rs`
//! `supplement_preview`: HWP `PrvText`는 비었을 때만 본문으로 채움, `serializer/hwpx/mod.rs`: HWPX `Preview/*`는 원본 항목이
//! 있으면 그대로, 없으면 엔진 상수 `PRV_TEXT`·`PRV_IMAGE_PNG`). 그래서 본문을 바꾼 저장에서 원본 미리보기가 남으면 지운·바꾼
//! 내용이 파일에 남을 수 있다. 공개 WASM API에는 미리보기 설정 수단이 없다. HWP 저장 서비스는 현재 지원하는 본문
//! 레코드에서 PrvText를 다시 만들고 최종 검사를 수행한다(`hwp::refresh_text_preview`). 2026-11-08부터는 프런트엔드가 다시 연
//! 원시 내보내기의 1쪽 렌더를 보내면 PrvImage도 정규 PNG로 다시 만든다(`hwp::refresh_previews`, 아래 PrvImage regeneration 절).
//! 렌더가 없거나 맞지 않으면 남은 원본 PrvImage는 계속 차단한다.
//!
//! 보장(4차 안정화 C): 남는 미리보기는 그 **바이트 전체가** 문서 내용과 무관함을 증명할 수 있을 때만 받는다. "보이는 픽셀이
//! 한 색"·"글자가 공백뿐"은 이 증명이 아니다(3차 안정화의 엄격한 한 색 PNG 증명을 대신한다): 구조가 올바른 한 색 PNG도
//! 투명 픽셀의 RGB, 보조 덩어리 값, 줄 필터 선택, deflate 블록 나누기·채움 비트·허프만 표, 크기에 정보를 담을 수 있고
//! (deflate 쪽은 길이 제한이 없다), 공백 글도 공백·탭·줄바꿈의 무늬와 길이에 담을 수 있다(합성 픽스처로 시연, 시험 `c4_`).
//! 그래서 내용과 무관함이 알려진 바이트와 정확히 같을 때만 받는다:
//! - 글: 빈 값, 또는 줄바꿈 하나 `\r\n`(고정 rhwp `serializer/hwpx/static_assets.rs` `PRV_TEXT`; HWP `PrvText`는 그 UTF-16 LE,
//!   `parser/hwpx/blank2010_assets/prvtext.bin`과 같은 바이트).
//! - 그림: 고정 rhwp가 HWPX에 넣는 빈 미리보기 `PRV_IMAGE_PNG`(68바이트), 또는 아래에서 바이트 전체를 감사한
//!   `종이기준.hwpx`의 빈 흰색 미리보기와 정확히 같을 때. 그 밖의 PNG는 한 색이어도 출처와 부호화를 알 수 없어 받지 않는다.
//!
//! 이 판정은 숨긴 정보를 찾는 검사기가 아니다: 무관함을 증명할 수 없으면 받지 않을 뿐이다(저장을 막음, `previewStale`).

/// 고정 rhwp(`1a76570`, `src/serializer/hwpx/static_assets.rs` `PRV_IMAGE_PNG`)가 HWPX `Preview/PrvImage.png`로 쓰는 1×1
/// 회색조+알파 투명 PNG, 바이트 그대로(일반 시험은 독립 골든, 선택적 검증은 고정 소스와 대조한다). IDAT CRC(`6F6867BC`, 맞는 값 `386A482B`)와
/// Adler-32(`00050001`, 맞는 값 `00060002`)가 틀리다. 문서와 무관한 엔진 상수이므로 정확히 이 바이트일 때만 받는다.
pub const RHWP_BLANK_PREVIEW_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xB5, 0x1C, 0x0C,
    0x02, 0x00, 0x00, 0x00, 0x0B, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x64, 0x60, 0x00, 0x00,
    0x00, 0x05, 0x00, 0x01, 0x6F, 0x68, 0x67, 0xBC, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
    0xAE, 0x42, 0x60, 0x82,
];

/// 고정 rhwp 빈 글 미리보기(`static_assets.rs` `PRV_TEXT`): 줄바꿈 하나.
pub const RHWP_BLANK_PREVIEW_TEXT: &[u8] = b"\r\n";

/// `external/rhwp/samples/종이기준.hwpx` (SHA-256
/// 2903b6f7a261005fa9a191cc7caa66d8307438b9cb93410f79fc61fd1fa0d9d8)의
/// `Preview/PrvImage.png`. 샘플 본문은 빈 문단 하나이고 `PrvText.txt`는 CRLF 하나다.
/// 이 정확한 PNG는 CRC와 zlib checksum이 유효하며 IHDR(724×1024, RGB8), sRGB,
/// gAMA, pHYs, IDAT, IEND 순서다. 디코딩된 매 행은 filter 0 + 모든 채널 255,
/// 총 2,225,152바이트이고 끝에 추가 바이트가 없다. 즉 이 *검토된 고정 바이트열*은
/// 편집 전 본문을 그린 이미지가 아니다. 임의의 단색 PNG에 이 판정을 확대하지 않는다.
const EXTERNAL_BLANK_PREVIEW_LEN: usize = 4502;
const EXTERNAL_BLANK_PREVIEW_SHA256: [u8; 32] = [
    0xca, 0x5d, 0x23, 0xcd, 0x1a, 0xad, 0x28, 0x53, 0x67, 0x2c, 0xdb, 0x0d, 0x11, 0x61, 0x37, 0xa0,
    0xbd, 0xc2, 0xff, 0x62, 0x14, 0x8d, 0xa9, 0x88, 0x6c, 0x26, 0x43, 0x05, 0xd0, 0x02, 0x5f, 0x3d,
];

/// HWP `PrvText`(UTF-16 LE)가 내용과 무관한 값인지: 빈 값이거나 `\r\n` 하나.
pub fn blank_utf16(data: &[u8]) -> bool {
    data.is_empty() || data == b"\r\0\n\0"
}

/// HWPX `Preview/PrvText.txt`(UTF-8)가 내용과 무관한 값인지: 빈 값이거나 `\r\n` 하나.
pub fn blank_utf8(data: &[u8]) -> bool {
    data.is_empty() || data == RHWP_BLANK_PREVIEW_TEXT
}

/// 그림 미리보기가 고정 rhwp의 빈 미리보기와 바이트가 정확히 같은지.
pub fn known_blank_png(data: &[u8]) -> bool {
    use sha2::{Digest, Sha256};
    data == RHWP_BLANK_PREVIEW_PNG
        || (data.len() == EXTERNAL_BLANK_PREVIEW_LEN
            && Sha256::digest(data)[..] == EXTERNAL_BLANK_PREVIEW_SHA256)
}

/// HWPX→HWP contract fallback: the pinned engine's document-independent blank2010
/// image (724×1024 white RGBA PNG). Match the *entire encoding*, not rendered pixels.
/// No source include is needed, so packaged geul builds do not require RHWP sources.
pub fn known_blank_hwp_image(data: &[u8]) -> bool {
    use sha2::{Digest, Sha256};
    const HASH: [u8; 32] = [
        0x21, 0x03, 0xd5, 0x1f, 0xb8, 0x63, 0x76, 0x9a, 0xfc, 0xe0, 0x86, 0xd2, 0xaa, 0x45, 0xed,
        0xa3, 0x43, 0x80, 0x8e, 0x1c, 0x47, 0x85, 0x27, 0xa9, 0xd4, 0x0b, 0x3d, 0xfb, 0xeb, 0xe5,
        0x13, 0xc6,
    ];
    known_blank_png(data) || (data.len() == 5126 && Sha256::digest(data)[..] == HASH)
}

// ---------------------------------------------------------------------------
// HWP PrvImage regeneration (2026-11-08).
//
// Evidence (target/preview-tables-toc-20261108/a/survey.json, 626 sample HWP files): genuine
// Hancom previews are GIF fit to a 250 px longest side (HWP 5.0.0–5.0.4) or PNG fit to a
// 1024 px longest side (HWP 5.0.5+). The size follows Section0's first PAGE_DEF: width/height
// swapped when attribute bit 0 (landscape) is set, the other side rounded half-up. That rule
// reproduces all 563 genuine 250/1024 previews. geul writes the newer convention: PNG, RGB8,
// 1024 px longest side, in one *canonical* encoding (see `encode_png`). Pixels come from the
// frontend's render of page 1 of the reopened raw export (same trust as the `reopen` evidence);
// the backend only resamples to the PAGE_DEF size and encodes. Final validation accepts a
// changed PrvImage only when it is exactly the image encoded for this save (`hwp`).

/// Longest preview side used by current Hancom PNG previews.
pub const PREVIEW_LONG_SIDE: u32 = 1024;
/// Largest accepted rendered raster side: the target plus canvas `ceil` slack.
pub const MAX_RASTER_SIDE: u32 = PREVIEW_LONG_SIDE + 8;
/// Accepted difference between the rendered raster and the PAGE_DEF size (canvas `ceil`,
/// 0.1 px rounding of getPageInfo). Anything larger means a different page geometry.
const RASTER_SLACK: u32 = 2;

/// Rendered first page delivered by the frontend: RGB8, row-major, top-down, alpha already
/// composited onto white.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewRaster {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

impl PreviewRaster {
    /// Validate shape only; geometry is validated against the output document.
    pub fn new(width: u32, height: u32, rgb: Vec<u8>) -> Option<Self> {
        let valid = (1..=MAX_RASTER_SIDE).contains(&width)
            && (1..=MAX_RASTER_SIDE).contains(&height)
            && rgb.len() as u64 == u64::from(width) * u64::from(height) * 3;
        valid.then_some(Self { width, height, rgb })
    }
}

/// Preview size for a first page of `width`×`height` HWPUNIT (Section0 PAGE_DEF).
pub fn preview_dimensions(width: u32, height: u32, landscape: bool) -> Option<(u32, u32)> {
    if width == 0 || height == 0 {
        return None;
    }
    let (w, h) = if landscape {
        (u64::from(height), u64::from(width))
    } else {
        (u64::from(width), u64::from(height))
    };
    let long = u64::from(PREVIEW_LONG_SIDE);
    let (major, minor) = (w.max(h), w.min(h));
    let short = ((2 * long * minor + major) / (2 * major)).max(1) as u32;
    Some(if w >= h {
        (PREVIEW_LONG_SIDE, short)
    } else {
        (short, PREVIEW_LONG_SIDE)
    })
}

/// Area-weighted resampling of the rendered raster to the canonical size. Identity when
/// sizes match. Refuses rasters whose size is not the expected page geometry.
pub fn fit_raster(raster: &PreviewRaster, width: u32, height: u32) -> Option<Vec<u8>> {
    if raster.width.abs_diff(width) > RASTER_SLACK || raster.height.abs_diff(height) > RASTER_SLACK
    {
        return None;
    }
    if raster.width == width && raster.height == height {
        return Some(raster.rgb.clone());
    }
    let (sw, sh) = (raster.width as usize, raster.height as usize);
    let (dw, dh) = (width as usize, height as usize);
    // Source extent covered by one destination pixel; spans are computed in exact rationals
    // scaled by dw (x) or dh (y) so the result is integer-deterministic.
    let spans = |src: usize, dst: usize| -> Vec<Vec<(usize, u64)>> {
        (0..dst)
            .map(|d| {
                let (start, end) = ((d * src) as u64, ((d + 1) * src) as u64); // in 1/dst units
                let mut parts = Vec::new();
                let mut s = start / dst as u64;
                while (s * dst as u64) < end {
                    let lo = (s * dst as u64).max(start);
                    let hi = ((s + 1) * dst as u64).min(end);
                    if hi > lo {
                        parts.push((s as usize, hi - lo));
                    }
                    s += 1;
                }
                parts
            })
            .collect()
    };
    let (xs, ys) = (spans(sw, dw), spans(sh, dh));
    let total = (sw * sh) as u64; // sum of weights per destination pixel
    let mut out = Vec::with_capacity(dw * dh * 3);
    for yparts in &ys {
        for xparts in &xs {
            let mut acc = [0u64; 3];
            for &(sy, wy) in yparts {
                for &(sx, wx) in xparts {
                    let at = (sy * sw + sx) * 3;
                    for (sum, value) in acc.iter_mut().zip(&raster.rgb[at..at + 3]) {
                        *sum += u64::from(*value) * wy * wx;
                    }
                }
            }
            for value in acc {
                out.push(((value + total / 2) / total) as u8);
            }
        }
    }
    Some(out)
}

fn png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc = flate2::Crc::new();
    crc.update(kind);
    crc.update(data);
    out.extend_from_slice(&crc.sum().to_be_bytes());
}

fn png_ihdr(width: u32, height: u32) -> [u8; 13] {
    let mut ihdr = [0u8; 13];
    ihdr[..4].copy_from_slice(&width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // truecolour RGB; compression, filter, interlace = 0
    ihdr
}

/// The one canonical geul preview encoding: signature, IHDR (RGB8, no interlace), a single
/// IDAT holding the pinned flate2 zlib stream (level 6) of filter-0 scanlines, IEND. No
/// ancillary chunks, so the bytes are a pure function of the pixels.
pub fn encode_png(width: u32, height: u32, rgb: &[u8]) -> Option<Vec<u8>> {
    use std::io::Write as _;
    let row = width as usize * 3;
    if width == 0 || height == 0 || rgb.len() != row * height as usize {
        return None;
    }
    let mut zlib = flate2::write::ZlibEncoder::new(
        Vec::with_capacity(rgb.len() / 8),
        flate2::Compression::new(6),
    );
    for line in rgb.chunks_exact(row) {
        zlib.write_all(&[0]).ok()?;
        zlib.write_all(line).ok()?;
    }
    let idat = zlib.finish().ok()?;
    let mut out = Vec::with_capacity(idat.len() + 64);
    out.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    png_chunk(&mut out, b"IHDR", &png_ihdr(width, height));
    png_chunk(&mut out, b"IDAT", &idat);
    png_chunk(&mut out, b"IEND", &[]);
    Some(out)
}

/// Strictly decode a canonical geul preview: exactly IHDR/IDAT/IEND with valid CRCs, a
/// complete zlib stream with no trailing data, filter 0 on every row, and bytes identical to
/// re-encoding the decoded pixels. Returns (width, height, rgb).
pub fn decode_canonical_png(data: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    use std::io::Read as _;
    let rest = data.strip_prefix(b"\x89PNG\r\n\x1a\n")?;
    let mut chunks = Vec::new();
    let mut at = 0usize;
    while at < rest.len() {
        let len = u32::from_be_bytes(rest.get(at..at + 4)?.try_into().ok()?) as usize;
        let kind = rest.get(at + 4..at + 8)?;
        let body = rest.get(at + 8..at.checked_add(8)?.checked_add(len)?)?;
        let crc = rest.get(at + 8 + len..at + 12 + len)?;
        let mut check = flate2::Crc::new();
        check.update(kind);
        check.update(body);
        if check.sum().to_be_bytes() != crc {
            return None;
        }
        chunks.push((kind, body));
        at += 12 + len;
    }
    let [(b"IHDR", ihdr), (b"IDAT", idat), (b"IEND", [])] = chunks.as_slice() else {
        return None;
    };
    let width = u32::from_be_bytes(ihdr.get(..4)?.try_into().ok()?);
    let height = u32::from_be_bytes(ihdr.get(4..8)?.try_into().ok()?);
    if !(1..=PREVIEW_LONG_SIDE).contains(&width)
        || !(1..=PREVIEW_LONG_SIDE).contains(&height)
        || *ihdr != png_ihdr(width, height)
    {
        return None;
    }
    let row = width as usize * 3;
    let expected = (row + 1) * height as usize;
    let mut raw = Vec::with_capacity(expected);
    let mut decoder = flate2::read::ZlibDecoder::new(*idat);
    decoder
        .by_ref()
        .take(expected as u64 + 1)
        .read_to_end(&mut raw)
        .ok()?;
    if raw.len() != expected || decoder.total_in() != idat.len() as u64 {
        return None;
    }
    let mut rgb = Vec::with_capacity(row * height as usize);
    for line in raw.chunks_exact(row + 1) {
        if line[0] != 0 {
            return None;
        }
        rgb.extend_from_slice(&line[1..]);
    }
    (encode_png(width, height, &rgb)? == data).then_some((width, height, rgb))
}
