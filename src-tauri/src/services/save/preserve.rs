//! 보존 판정의 공통 형식. 판정은 safe·unsafe·unknown 셋이고, 모르면 안전하지 않은 것으로 다룬다(저장 차단).
//!
//! 근거(`Finding`)는 기계가 읽는 코드와 패키지 안 이름(부분 경로)만 담는다. 문서 본문·사용자 경로·운영체제 오류 문구는
//! 담지 않는다. 부분 경로도 길면 자른다.

use serde::Serialize;

/// 보존 판정.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// 원본의 모든 부분이 엔진 왕복 뒤에도 같다는 근거가 있다.
    Safe,
    /// 원본의 어떤 부분이 바뀌거나 사라진다는 근거가 있다.
    Unsafe,
    /// 판단할 근거가 없다(검사할 수 없는 형식·구조·한도 초과). 저장하지 않는다.
    Unknown,
}

/// 판정 근거의 종류.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FindingCode {
    /// 원본의 부분(스트림·패키지 항목)이 출력에 없다.
    PartMissing,
    /// 출력에 원본에 없던 부분이 생겼다.
    PartAdded,
    /// 부분의 내용(정규화한 XML·바이트)이 다르다.
    PartChanged,
    /// HWP 레코드 열(태그·수준·내용)이 다르다.
    RecordsChanged,
    /// 원본의 부분을 끝까지 해석할 수 없다(깨진 XML·레코드, 압축 해제 실패).
    OriginalMalformed,
    /// 출력의 부분을 끝까지 해석할 수 없다.
    OutputMalformed,
    /// 패키지 무결성: 필수 부분·내용 형식·관계 대상이 없거나 맞지 않는다.
    PackageInvalid,
    /// 엔진 손실 보고가 손실을 적었다.
    LossReported,
    /// 엔진 손실 보고가 계약 모양이 아니다(판단 근거 없음).
    LossReportInvalid,
    /// 다시 연 문서가 편집 모델과 다르다(엔진 비교).
    ReopenMismatch,
    /// 검사 한도(크기·개수)를 넘었다.
    LimitExceeded,
    /// 이 형식·변종은 보존을 검사할 수 없다(HWP 3·HML·배포용·암호 문서 등).
    Unsupported,
    /// 이 원본에 대한 사전 검사 결과가 없다(검사 전이거나 원본이 바뀜).
    PreflightMissing,
}

/// 판정 근거 하나.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub code: FindingCode,
    /// 패키지 안 이름(예: `word/styles.xml`, `BodyText/Section0`). 문서 본문이 아니다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part: Option<String>,
}

/// 응답에 담는 부분 이름 길이 상한(문자). 넘으면 자른다.
const MAX_PART_CHARS: usize = 128;
/// 응답에 담는 근거 수 상한. 넘으면 앞의 것만.
pub const MAX_FINDINGS: usize = 32;

impl Finding {
    pub fn new(code: FindingCode) -> Self {
        Finding { code, part: None }
    }

    pub fn at(code: FindingCode, part: &str) -> Self {
        Finding {
            code,
            part: Some(
                part.chars()
                    .take(MAX_PART_CHARS)
                    .map(|c| if c.is_control() { '?' } else { c })
                    .collect(),
            ),
        }
    }

    /// 이 근거가 판정을 unknown으로 만드는지(판단 불가). 나머지는 unsafe.
    fn unknown(&self) -> bool {
        matches!(
            self.code,
            FindingCode::OriginalMalformed
                | FindingCode::LossReportInvalid
                | FindingCode::LimitExceeded
                | FindingCode::Unsupported
                | FindingCode::PreflightMissing
        )
    }
}

/// 보존 검사 결과.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preservation {
    pub outcome: Outcome,
    pub findings: Vec<Finding>,
}

impl Preservation {
    /// 근거로 판정한다: 없으면 safe, 판단 불가 근거가 하나라도 있으면 unknown, 그 밖은 unsafe.
    pub fn from_findings(mut findings: Vec<Finding>) -> Self {
        let mut seen = std::collections::HashSet::new();
        findings.retain(|finding| seen.insert(finding.clone()));
        let outcome = if findings.is_empty() {
            Outcome::Safe
        } else if findings.iter().any(Finding::unknown) {
            Outcome::Unknown
        } else {
            Outcome::Unsafe
        };
        findings.truncate(MAX_FINDINGS);
        Preservation { outcome, findings }
    }

    pub fn is_safe(&self) -> bool {
        self.outcome == Outcome::Safe
    }
}
