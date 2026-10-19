//! WordCraft(DOCX) 어댑터(T008, W-A: 백엔드의 네이티브 엔진).
//!
//! - `engine`: WordCraft 세션 하나를 감싼 모델. 허용한 편집 연산만 WordCraft 명령으로 바꾸고, 보기(쪽 크기·커서·선택)·
//!   쪽 그림(PNG)·메모리 안 왕복 검사를 만든다.
//! - `store`: 세션별 모델 보관소(세션 ID + 불러오기 시도 번호).
//! - `commands`: Tauri 명령. 세션 기록(`crate::document`)의 수명주기·revision 규칙을 모델 잠금 안에서 함께 적용한다.
//!
//! IME 조합은 엔진이 모른다. 조합 중 글자는 프런트엔드가 커서 자리에 겹쳐 그리고, 확정한 글자만 `InsertText`로 온다.

pub mod commands;
pub mod engine;
mod store;

#[cfg(test)]
pub(crate) mod tests;

pub use store::WordcraftModels;
