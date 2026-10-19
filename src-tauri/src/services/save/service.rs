//! 저장 절차(T009). Tauri와 무관한 함수라 시험이 직접 부른다(IPC는 `commands.rs`).
//!
//! 순서: 원본 다시 읽기(같은 파일·지문·해시, 아니면 `FileConflict`) → 사전 검사 결과가 그 원본에 대해 `safe`인지 →
//! 출력 검사(손실 보고·형식 판별·패키지 무결성·편집 부분 밖이 원본과 같음, 다시 열기 비교는 호출하는 쪽) → 같은
//! 디렉터리 임시 파일 쓰기·되읽기 → 원본 해시 다시 확인 → 기록 잠금 안에서 세션·지문 다시 확인 뒤 교체 → 깨끗한 판 기록.
//! 어느 단계든 실패하면 원본은 바뀌지 않는다(교체가 마지막 단계).

use std::io::Cursor;

use serde::Serialize;
use serde_json::Value;

use super::preserve::{Finding, FindingCode, Preservation};
use super::{hwp, loss, package, publish};
use crate::document::{
    content_hash, detect, read_identified, unchanged, DocumentError, Format, Limits, SaveSource,
    SaveTicket, SessionInfo, SessionRegistry,
};

/// 저장 결과.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    pub session: SessionInfo,
    pub bytes: usize,
    /// 교체 뒤 디렉터리 `fsync`까지 됐는지(아니면 교체는 됐으나 정전 내구성을 확인하지 못함).
    pub durable: bool,
}

/// 사전 검사 응답: 보존 판정과 이 플랫폼에서 원본을 바꿀 수 있는지.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCheck {
    pub preservation: Preservation,
    pub platform_supported: bool,
}

pub const PLATFORM_SUPPORTED: bool = cfg!(target_os = "linux");

/// 기록한 원본을 다시 읽는다: 같은 객체·지문이고 내용 해시가 불러올 때와 같을 때만(아니면 `FileConflict`).
pub fn read_original(source: &SaveSource, limits: &Limits) -> Result<Vec<u8>, DocumentError> {
    let bytes = read_identified(&source.load, limits).map_err(|error| match error {
        DocumentError::FileChanged => DocumentError::FileConflict,
        other => other,
    })?;
    if content_hash(&bytes) != source.content_hash {
        return Err(DocumentError::FileConflict);
    }
    Ok(bytes)
}

fn same_format(bytes: &[u8], format: Format) -> bool {
    detect(&mut Cursor::new(bytes), bytes.len() as u64).is_ok_and(|detected| detected == format)
}

/// 손실 보고 근거: rhwp 형식(HWP·HWPX)은 보고가 반드시 있어야 하고(없으면 unknown), DOCX는 보고를 받지 않는다(WordCraft는
/// 보고를 만들지 않으므로 들어온 보고는 잘못된 요청이다, unknown).
fn report_findings(format: Format, report: Option<&Value>) -> Vec<Finding> {
    match (format, report) {
        (Format::Hwp | Format::Hwpx, Some(report)) => loss::check(report, format),
        (Format::Docx, None) => Vec::new(),
        _ => vec![Finding::new(FindingCode::LossReportInvalid)],
    }
}

/// 사전 검사: 원본과 편집 없는 엔진 출력을 비교한다(rhwp는 그 출력의 손실 보고도).
pub fn preflight(
    format: Format,
    original: &[u8],
    unedited: &[u8],
    report: Option<&Value>,
) -> Preservation {
    let mut findings = report_findings(format, report);
    if !same_format(unedited, format) {
        findings.push(Finding::at(FindingCode::OutputMalformed, "container"));
    }
    match format {
        Format::Hwp => findings.extend(hwp::compare(original, unedited)),
        Format::Hwpx | Format::Docx => match (
            package::open(original, package::Side::Original),
            package::open(unedited, package::Side::Output),
        ) {
            (Ok(before), Ok(after)) => {
                findings.extend(package::malformed_xml(&before, package::Side::Original));
                findings.extend(package::compare(&before, &after, &|_| false));
            }
            (Err(finding), _) | (_, Err(finding)) => findings.push(finding),
        },
    }
    Preservation::from_findings(findings)
}

/// 저장 출력 검사: 손실 보고(rhwp), 형식 판별, 패키지 무결성, 편집 부분 밖이 원본과 같음. 본문이 편집 모델과 같은지
/// (다시 열기)는 엔진을 가진 쪽이 따로 확인해 `reopen_equal`로 넘긴다.
pub fn check_saved(
    format: Format,
    original: &[u8],
    output: &[u8],
    report: Option<&Value>,
    reopen_equal: bool,
) -> Preservation {
    let mut findings = report_findings(format, report);
    if !reopen_equal {
        findings.push(Finding::new(FindingCode::ReopenMismatch));
    }
    if !same_format(output, format) {
        findings.push(Finding::at(FindingCode::OutputMalformed, "container"));
        return Preservation::from_findings(findings);
    }
    match format {
        Format::Hwp => findings.extend(hwp::compare_saved(original, output)),
        Format::Hwpx | Format::Docx => match (
            package::open(original, package::Side::Original),
            package::open(output, package::Side::Output),
        ) {
            (Ok(before), Ok(after)) if format == Format::Hwpx => {
                findings.extend(package::validate_hwpx(&before, &after));
                findings.extend(package::compare_saved_hwpx(&before, &after));
            }
            (Ok(before), Ok(after)) => {
                findings.extend(package::validate_docx(&after));
                findings.extend(package::compare_saved_docx(&before, &after));
            }
            (Err(finding), _) | (_, Err(finding)) => findings.push(finding),
        },
    }
    Preservation::from_findings(findings)
}

/// 저장 표로 출력을 검사하고 원본을 바꾼다. `report`·`reopen_equal`은 엔진 쪽 근거다.
pub fn save(
    registry: &SessionRegistry,
    ticket: &SaveTicket<'_>,
    limits: &Limits,
    output: &[u8],
    report: Option<&Value>,
    reopen_equal: bool,
) -> Result<SaveOutcome, DocumentError> {
    let format = ticket.source.load.format;
    let original = read_original(&ticket.source, limits)?;
    match &ticket.source.preflight {
        Some(preflight) if preflight.is_safe() => {}
        Some(preflight) => {
            return Err(DocumentError::UnsafeSave {
                preservation: preflight.clone(),
            })
        }
        None => {
            return Err(DocumentError::UnsafeSave {
                preservation: Preservation::from_findings(vec![Finding::new(
                    FindingCode::PreflightMissing,
                )]),
            })
        }
    }
    let checked = check_saved(format, &original, output, report, reopen_equal);
    if !checked.is_safe() {
        return Err(DocumentError::UnsafeSave {
            preservation: checked,
        });
    }
    let target = ticket.source.load.identity.path().to_path_buf();
    let mut staged = publish::stage(&target, output)?;
    // 쓰는 동안 원본이 바뀌었는지 내용으로 다시 확인한다(같은 크기·수정 시각으로 바뀐 경우). 교체 직전의 객체·지문
    // 확인은 기록 잠금 안에서 한다.
    read_original(&ticket.source, limits)?;
    #[cfg(test)]
    publish::before_check(&target, &staged);
    let mut durable = false;
    let session = registry.finish_save(ticket, content_hash(output), |identity, fingerprint| {
        #[cfg(test)]
        if publish::fault() == Some(publish::Fault::BeforePublish) {
            return Err(DocumentError::FileConflict);
        }
        if !unchanged(identity, fingerprint) {
            return Err(DocumentError::FileConflict);
        }
        let published = publish::publish(&mut staged, identity.path())?;
        durable = published.durable;
        Ok(published)
    })?;
    Ok(SaveOutcome {
        session,
        bytes: output.len(),
        durable,
    })
}
