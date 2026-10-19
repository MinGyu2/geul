//! 프런트엔드로 보내는 안정적인 오류 계약.
//!
//! 오류는 `code`와 고정된 세부 값(kebab-case 문자열)만 담는다. 파일 경로, 문서 내용, 운영체제·라이브러리의 오류
//! 문구는 담지 않는다(번역은 프런트엔드가 code로 한다). JSON 예: `{"code":"ExtensionMismatch","declared":"docx",
//! "detected":"hwpx"}`.

use serde::Serialize;

use super::session::{SessionId, SessionState};
use super::{Engine, Format};
use crate::services::save::preserve::Preservation;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all_fields = "camelCase")]
pub enum DocumentError {
    /// IPC로 받은 경로 문자열 자체가 받아들일 수 없는 값.
    InvalidPath { reason: PathProblem },
    /// 경로는 올바르지만 파일을 읽을 수 없음.
    Unreadable { reason: ReadProblem },
    /// 지원하지 않는 확장자이거나, 내용이 세 형식 중 어느 것도 아님.
    UnsupportedFormat { kind: UnsupportedKind },
    /// 내용은 지원 형식이지만 확장자가 다른 형식을 가리킴. 다시 해석해 열지 않는다.
    ExtensionMismatch { declared: Format, detected: Format },
    /// 암호·DRM으로 보호된 문서. 형식을 알 수 없으면 `format`이 없다(예: 암호화된 OOXML).
    Encrypted {
        #[serde(skip_serializing_if = "Option::is_none")]
        format: Option<Format>,
    },
    /// 지원 형식(또는 그 컨테이너)으로 보이지만 구조가 깨졌거나 필수 항목이 없음.
    ParseFailure {
        #[serde(skip_serializing_if = "Option::is_none")]
        format: Option<Format>,
        reason: ParseProblem,
    },
    /// 크기·개수 상한을 넘음. 검사를 멈추고 거부한다.
    ResourceLimit { limit: LimitKind },
    /// 같은 파일이 이미 열려 있음.
    AlreadyOpen { session_id: SessionId },
    /// 이 실행에서 발급한 적 없는 세션.
    UnknownSession { session_id: SessionId },
    /// 이미 닫힌 세션.
    StaleSession { session_id: SessionId },
    /// 세션이 그 요청을 받을 수 있는 상태가 아님(예: 불러오는 중에 다시 불러오기, 준비되지 않은 세션의 변경 확정).
    InvalidState {
        session_id: SessionId,
        state: SessionState,
    },
    /// 변경 확정의 기준 revision이 백엔드 기록과 다름. `revision`은 지금 기록된 판이다.
    RevisionMismatch {
        session_id: SessionId,
        revision: u64,
    },
    /// 지금 불러오기 시도가 아닌 옛 시도의 상태 전이·확정. `load_generation`은 지금 시도 번호다.
    StaleLoad {
        session_id: SessionId,
        load_generation: u64,
    },
    /// 판별한 뒤 파일이 바뀌거나 교체됨. 다시 열어야 한다.
    FileChanged,
    /// 백엔드가 모델을 가진 엔진(T008 WordCraft)이 그 단계에서 실패함. 엔진 메시지는 담지 않는다(문서 내용이 섞일 수
    /// 있음). 형식 판별을 통과한 문서도 엔진이 열지 못할 수 있다.
    EngineFailure { engine: Engine, stage: EngineStage },
    /// 저장하면 원본의 내용이 바뀌거나 사라질 수 있거나(`unsafe`), 판단할 근거가 없다(`unknown`). 저장하지 않았고
    /// 원본은 그대로다(T009). 근거는 코드와 패키지 안 부분 이름뿐이다.
    UnsafeSave { preservation: Preservation },
    /// 이 환경·파일에서는 원본을 안전하게 바꿀 수 없어 저장하지 않는다(원본 그대로).
    SaveUnsupported { reason: SaveUnsupportedReason },
    /// 저장 단계가 실패함. 원본은 그대로다(임시 파일은 지운다).
    SaveFailure {
        stage: SaveStage,
        #[serde(skip_serializing_if = "Option::is_none")]
        io: Option<IoProblem>,
    },
    /// 불러온 뒤 디스크의 파일이 바뀌거나 교체됨(외부 수정). 저장하지 않았다(덮어쓰지 않음).
    FileConflict,
    /// 같은 세션의 저장이 이미 진행 중이다.
    SaveInProgress { session_id: SessionId },
    /// 계약에 맞지 않는 요청 값(허용하지 않는 상태 전이, 범위 밖 개수 등).
    InvalidRequest,
    /// 내부 오류(세부 내용은 내보내지 않는다).
    Internal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PathProblem {
    Empty,
    Relative,
    TooLong,
    ContainsNul,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReadProblem {
    NotFound,
    PermissionDenied,
    /// 디렉터리, FIFO, 장치 파일 등 일반 파일이 아님.
    NotAFile,
    Io,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnsupportedKind {
    /// 확장자가 hwp·hwpx·docx가 아니거나 없음(내용을 읽지 않는다).
    Extension,
    /// HWP 3.x 이하 바이너리.
    Hwp3,
    /// HWP 5 FileHeader이지만 주 버전이 5가 아님.
    HwpVersion,
    /// Word 97-2003(.doc) 등 HWP가 아닌 OLE 문서.
    LegacyWord,
    OtherOle,
    /// 매크로 사용(docm)·서식 파일(dotx/dotm) 등 docx가 아닌 Word 패키지.
    WordVariant,
    /// 스프레드시트·프레젠테이션 등 다른 OOXML 패키지.
    OtherOoxml,
    /// HWPX·OOXML이 아닌 ZIP.
    OtherZip,
    /// HWPX와 OOXML 표식이 함께 있거나 서로 어긋나 하나로 정할 수 없음.
    Ambiguous,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ParseProblem {
    Empty,
    Truncated,
    CorruptContainer,
    MissingPart,
    InvalidPart,
}

/// 저장을 지원하지 않는 이유(T009).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SaveUnsupportedReason {
    /// 원자적 교체를 검증한 플랫폼이 아니다(지금은 Linux만).
    Platform,
    /// 파일에 하드 링크가 여럿이다(교체하면 다른 이름은 옛 내용을 가리킨다).
    HardLink,
    /// 파일 소유자·그룹이 이 프로세스와 달라 교체하면 소유가 바뀐다.
    Ownership,
    /// 원본이 읽기 전용이다(소유자 쓰기 비트가 없거나 커널이 쓰기를 거부: 변경 불가 플래그·읽기 전용 마운트 등).
    /// 디렉터리 쓰기 권한으로 이름만 바꿔 읽기 전용 파일을 바꾸지 않는다(T009 안정화).
    ReadOnly,
    /// 교체하면 잃는 메타데이터가 있다(확장 속성·ACL·inode 플래그·권한 비트가 새 파일과 다름), 또는 그것을 확인할 수
    /// 없다(T009 안정화).
    Metadata,
    /// 원본을 이 사용자 밖의 사용자(그룹·그 밖)도 쓸 수 있다: 검증한 임시 파일을 게시 전에 그들이 바꿀 수 있다(T009 3차 안정화).
    SharedFile,
    /// 원본이 있는 디렉터리를 이 사용자·root 밖의 사용자가 바꿀 수 있다(그룹·그 밖 쓰기 비트에 sticky 없음, 다른 소유자,
    /// 접근 ACL): 검증한 임시 파일의 이름을 게시 전에 다른 파일·링크로 바꿀 수 있다(T009 3차 안정화).
    SharedDirectory,
}

/// 저장 단계.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SaveStage {
    /// 엔진 내보내기.
    Export,
    /// 출력 검증(형식·패키지·다시 열기).
    Validate,
    /// 임시 파일 쓰기·되읽기 확인.
    Write,
    /// 원본 교체.
    Publish,
}

/// 저장 중 입출력 문제의 종류(운영체제 문구는 담지 않는다).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum IoProblem {
    PermissionDenied,
    StorageFull,
    ReadOnly,
    Other,
}

/// 엔진 작업 단계(프런트엔드 `EngineStage`의 부분 집합).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineStage {
    /// 문서 바이트를 엔진 모델로 읽기.
    Parse,
    /// 쪽 배치·그리기.
    Render,
    /// 편집 명령.
    Edit,
    /// 메모리 안 내보내기·다시 읽기 검사.
    Export,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LimitKind {
    FileSize,
    EntryCount,
    MetadataSize,
    PartSize,
    SessionCount,
    PendingOpens,
}

impl DocumentError {
    pub(crate) fn parse(format: Option<Format>, reason: ParseProblem) -> Self {
        DocumentError::ParseFailure { format, reason }
    }

    pub(crate) fn unsupported(kind: UnsupportedKind) -> Self {
        DocumentError::UnsupportedFormat { kind }
    }
}
