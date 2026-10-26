//! 본문을 바꾼 저장에서 원본 그대로 남는 미리보기가 문서 내용과 무관함을 증명한다(T009 안정화 F, 4차 안정화 C).
//!
//! rhwp는 미리보기를 문서에서 다시 만들지 않고 원본 것을 그대로 쓴다(고정 커밋 `serializer/cfb_writer.rs`
//! `supplement_preview`: HWP `PrvText`는 비었을 때만 본문으로 채움, `serializer/hwpx/mod.rs`: HWPX `Preview/*`는 원본 항목이
//! 있으면 그대로, 없으면 엔진 상수 `PRV_TEXT`·`PRV_IMAGE_PNG`). 그래서 본문을 바꾼 저장에서 원본 미리보기가 남으면 지운·바꾼
//! 내용이 파일에 남을 수 있다. 미리보기를 대신 만들거나 지울 수단이 없다.
//!
//! 보장(4차 안정화 C): 남는 미리보기는 그 **바이트 전체가** 문서 내용과 무관함을 증명할 수 있을 때만 받는다. "보이는 픽셀이
//! 한 색"·"글자가 공백뿐"은 이 증명이 아니다(3차 안정화의 엄격한 한 색 PNG 증명을 대신한다): 구조가 올바른 한 색 PNG도
//! 투명 픽셀의 RGB, 보조 덩어리 값, 줄 필터 선택, deflate 블록 나누기·채움 비트·허프만 표, 크기에 정보를 담을 수 있고
//! (deflate 쪽은 길이 제한이 없다), 공백 글도 공백·탭·줄바꿈의 무늬와 길이에 담을 수 있다(합성 픽스처로 시연, 시험 `c4_`).
//! 그래서 내용과 무관함이 알려진 바이트와 정확히 같을 때만 받는다:
//! - 글: 빈 값, 또는 줄바꿈 하나 `\r\n`(고정 rhwp `serializer/hwpx/static_assets.rs` `PRV_TEXT`; HWP `PrvText`는 그 UTF-16 LE,
//!   `parser/hwpx/blank2010_assets/prvtext.bin`과 같은 바이트).
//! - 그림: 고정 rhwp가 HWPX에 넣는 빈 미리보기 `PRV_IMAGE_PNG`(68바이트)와 정확히 같을 때. 그 밖의 PNG는 한 색이어도 출처와
//!   부호화를 알 수 없어 받지 않는다.
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
    data == RHWP_BLANK_PREVIEW_PNG
}
