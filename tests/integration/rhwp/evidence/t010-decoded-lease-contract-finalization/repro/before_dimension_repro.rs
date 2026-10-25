//! P2-A 재현: 이전 후보(94603ed3)의 decode_image_to_canvas는 헤더 예약이 있을 때 디코드 결과에 대해
//! `Some(r) if r.authorizes(actual).is_err() => Rejected`만 검사했다(헤더 width/height는 reserve_decode에서
//! RGBA bytes로 바뀐 뒤 버려졌다). 이 파일은 그 판정을 그대로 옮긴 `old_decode_path_accepts`에 대해
//! "이미지 크기가 헤더와 다르면 거절해야 한다"를 단언한다. 이전 판정에서는 더 큰 경우만 거절되고,
//! 더 작거나 모양만 다른 경우는 단언이 실패하는 것이 기대 재현 결과다. 실제 decoder가 이런 결과를
//! 냈다는 주장이 아니다(도달성은 canvas_rgba 시험 참조).
mod surface_cache;
use std::rc::Rc;
use surface_cache::{rgba_bytes, DecodedLedger};

fn old_decode_path_accepts(header: (u32, u32), decoded: (u32, u32)) -> bool {
    let ledger = Rc::new(DecodedLedger::default());
    let reservation = ledger
        .reserve(rgba_bytes(header.0, header.1), 0, 96 << 20, true)
        .unwrap();
    reservation.authorizes(rgba_bytes(decoded.0, decoded.1)).is_ok()
}

fn assert_refused(header: (u32, u32), decoded: (u32, u32)) {
    let accepted = old_decode_path_accepts(header, decoded);
    println!("header {header:?} decoded {decoded:?}: old decode path accepted = {accepted}");
    assert!(!accepted, "mismatched image {decoded:?} for header {header:?} was authorized");
}

#[test]
fn decoded_wider_than_header() {
    assert_refused((100, 100), (101, 100));
}
#[test]
fn decoded_taller_than_header() {
    assert_refused((100, 100), (100, 101));
}
#[test]
fn decoded_smaller_than_header() {
    assert_refused((100, 100), (90, 90));
}
#[test]
fn transposed_same_pixel_count() {
    assert_refused((100, 40), (40, 100));
}
#[test]
fn other_shape_identical_rgba_bytes() {
    assert_refused((200, 20), (100, 40));
}
#[test]
fn exact_dimensions_are_accepted() {
    assert!(old_decode_path_accepts((100, 100), (100, 100)));
}
