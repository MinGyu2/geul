//! rhwp 손실 보고(`exportHwp(x)WithReport().contentLoss()`) 엄격 검사.
//!
//! 계약(고정 rhwp `src/serializer/content_loss.rs`, `CONTENT_LOSS_SCHEMA_VERSION` 1): `{"schemaVersion":1,
//! "outputFormat":"hwp"|"hwpx","count":n,"losses":[{code, subject, path, reason, resourceId?}]}`. 이 모양이 아니면
//! (필드가 더 있거나 없음, 판이 다름, 형식이 요청과 다름, count와 목록 수가 다름, 정수가 아님) 판단 근거가 없다고 보고
//! (`LossReportInvalid`), 손실이 하나라도 있으면 `LossReported`(그 IR 경로만, 128자 안). 빈 보고서도 보존의 근거는 아니다
//! (직렬화가 스스로 안 손실만 적는다) — 보존은 `hwp`·`package` 비교가 따로 판단한다.

use serde_json::Value;

use super::preserve::{Finding, FindingCode};
use crate::document::Format;

const SCHEMA_VERSION: u64 = 1;
const LOSS_FIELDS: [&str; 5] = ["code", "subject", "path", "reason", "resourceId"];
const LOSS_CODES: [&str; 3] = ["binaryContentEmptied", "controlOmitted", "metadataReduced"];

/// 손실 보고를 검사한 근거. 비어 있으면 계약 모양이고 손실 0건이다.
pub fn check(report: &Value, format: Format) -> Vec<Finding> {
    let invalid = || vec![Finding::new(FindingCode::LossReportInvalid)];
    let expected = match format {
        Format::Hwp => "hwp",
        Format::Hwpx => "hwpx",
        Format::Docx => return invalid(), // DOCX에는 rhwp 보고서가 없다
    };
    let Some(object) = report.as_object() else {
        return invalid();
    };
    if object.len() != 4 {
        return invalid();
    }
    let (Some(version), Some(output), Some(count), Some(losses)) = (
        object.get("schemaVersion").and_then(Value::as_u64),
        object.get("outputFormat").and_then(Value::as_str),
        object.get("count").and_then(Value::as_u64),
        object.get("losses").and_then(Value::as_array),
    ) else {
        return invalid();
    };
    if version != SCHEMA_VERSION || output != expected || count != losses.len() as u64 {
        return invalid();
    }
    let mut findings = Vec::new();
    for loss in losses {
        let Some(loss) = loss.as_object() else {
            return invalid();
        };
        let well_formed = loss.keys().all(|key| LOSS_FIELDS.contains(&key.as_str()))
            && loss
                .get("code")
                .and_then(Value::as_str)
                .is_some_and(|code| LOSS_CODES.contains(&code))
            && ["subject", "path", "reason"]
                .iter()
                .all(|key| loss.get(*key).is_some_and(Value::is_string))
            && loss.get("resourceId").is_none_or(Value::is_u64);
        if !well_formed {
            return invalid();
        }
        let path = loss.get("path").and_then(Value::as_str).unwrap_or_default();
        findings.push(Finding::at(FindingCode::LossReported, path));
    }
    findings
}
