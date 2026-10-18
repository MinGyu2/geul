//! 엔진 어댑터(T008~).
//!
//! 문서 세션 기록(`crate::document`)은 엔진과 무관하게 형식·세션·수명주기·revision을 가진다. 이 모듈은 문서 모델을
//! 백엔드가 가지는 엔진을 그 기록에 연결한다. 지금은 WordCraft(DOCX, W-A: editor-surface-decision.md)뿐이다. rhwp는
//! 모델이 WebView의 WASM에 있으므로(T007) 이 모듈에 없다. 두 엔진의 문서 모델은 합치지 않는다(FR-004).

pub mod wordcraft;
