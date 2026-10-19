//! 문서 형식 판별과 문서 세션(T006).
//!
//! 소유 범위:
//! - 이 모듈(백엔드)이 파일 접근, 컨테이너 검사, 형식 확정, 세션 식별자·수명주기의 권한 있는 기록을 맡는다.
//! - 프런트엔드(`src/adapters/`)는 이 기록의 투영(목록·활성 선택)만 가지며 세션을 만들거나 형식을 정하지 않는다.
//!
//! 형식 판별은 "어느 엔진으로 보낼지"만 정한다. 엔진이 그 문서를 안전하게 열거나 편집·저장할 수 있다는 증거가
//! 아니며, 세션을 만들어도 엔진에 문서를 불러오지 않는다(`SessionState::Identified`). 엔진 연결은 T007(rhwp),
//! T008(WordCraft)에서 한다. 두 엔진의 문서 모델은 합치지 않는다(FR-004).

pub mod commands;
mod detect;
mod error;
mod ole;
mod open;
mod package;
mod session;
pub(crate) mod xml;
pub(crate) mod zip;

#[cfg(test)]
mod tests;
#[cfg(test)]
pub(crate) mod testutil;

use serde::Serialize;

pub use detect::detect;
pub use error::{
    DocumentError, EngineStage, IoProblem, LimitKind, ParseProblem, PathProblem, ReadProblem,
    SaveStage, SaveUnsupportedReason, UnsupportedKind,
};
pub(crate) use open::{describe_staged, unchanged};
pub use open::{
    identify, read_identified, FileFingerprint, FileIdentity, IdentifiedFile, Limits, LoadSource,
};
pub use session::{
    content_hash, CloseOutcome, SaveSource, SaveTicket, SessionId, SessionInfo, SessionRegistry,
    SessionState, MAX_COMMIT_COUNT,
};

/// 이 앱이 다루는 문서 형식. 확장자가 아니라 내용 검사로 확정한다.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Hwp,
    Hwpx,
    Docx,
}

/// 문서 모델·렌더링·편집 이력을 소유하는 엔진.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    /// external/rhwp (HWP, HWPX)
    Rhwp,
    /// external/wordcraft (DOCX)
    Wordcraft,
}

impl Format {
    /// 형식별 엔진. 라우팅은 여기서만 정한다.
    pub fn engine(self) -> Engine {
        match self {
            Format::Hwp | Format::Hwpx => Engine::Rhwp,
            Format::Docx => Engine::Wordcraft,
        }
    }

    /// 확장자(점 없이, 대소문자 무시)가 가리키는 형식.
    pub fn from_extension(extension: &str) -> Option<Format> {
        match extension.to_ascii_lowercase().as_str() {
            "hwp" => Some(Format::Hwp),
            "hwpx" => Some(Format::Hwpx),
            "docx" => Some(Format::Docx),
            _ => None,
        }
    }
}
