//! Creation authority for the two audited, deterministic RHWP blank outputs.
//! This is deliberately narrower than a user-document validator: the digest
//! binds every byte (including metadata, defaults, previews and references) to
//! the independently audited runtime evidence. A new engine output fails closed
//! until it is audited. Frontend loss/reopen assertions alone never grant writes.
use crate::document::{detect, DocumentError, Format};
use crate::services::save::{loss, service};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};

pub const MAX_BLANK_BYTES: usize = 64 * 1024;

/// Complete the derived first-row geometry of the authenticated creation seed.
/// This is never applied to an opened document. The raw blank's whole-file
/// digest is checked before this function is called. Its explicit 10pt/160%
/// defaults and A4 body width yield this empty row (also the engine's measured
/// empty-row tuple). Keeping a real LINE_SEG lets the unchanged strict insertion
/// proof validate the original on its very first table/picture/list save.
fn complete_audited_blank_row(compressed: &[u8]) -> std::io::Result<Vec<u8>> {
    use std::io::{Error, ErrorKind};
    let invalid = || Error::new(ErrorKind::InvalidData, "unexpected audited blank paragraph");
    let mut body = Vec::new();
    flate2::read::DeflateDecoder::new(compressed)
        .take(MAX_BLANK_BYTES as u64 + 1)
        .read_to_end(&mut body)?;
    let word = |at: usize| -> Option<u32> {
        Some(u32::from_le_bytes(body.get(at..at + 4)?.try_into().ok()?))
    };
    // The audited seed has one empty paragraph with secd/cold anchors, one
    // default character run, and no stored rows. Reject any other framing.
    if body.len() > MAX_BLANK_BYTES
        || word(0) != Some((24 << 20) | 66)
        || word(4) != Some(0x8000_0011)
        || body.get(16..22) != Some(&[1, 0, 0, 0, 0, 0])
        || word(28) != Some((34 << 20) | (1 << 10) | 67)
        || word(66) != Some((8 << 20) | (1 << 10) | 68)
        || body.get(70..78) != Some(&[0; 8])
    {
        return Err(invalid());
    }
    body[20..22].copy_from_slice(&1u16.to_le_bytes());
    let mut row = ((36u32 << 20) | (1 << 10) | 69).to_le_bytes().to_vec();
    for value in [0u32, 0, 1000, 1000, 850, 600, 0, 42520, 0x8006_0000] {
        row.extend_from_slice(&value.to_le_bytes());
    }
    body.splice(78..78, row);
    let mut encoder =
        flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&body)?;
    encoder.finish()
}

/// Strip the HWPX parser's injected template extras from this *new* document.
/// Rebuild a fresh CFB so removed metadata cannot remain in unused sectors.
/// Native HWP reopen does not synthesize these HWPX-only defaults again.
pub fn prepare_rhwp_blank(
    format: Format,
    bytes: &[u8],
    report: &Value,
) -> Result<Vec<u8>, DocumentError> {
    validate_rhwp_blank(format, bytes, report)?;
    if format == Format::Hwpx {
        return Ok(bytes.to_vec());
    }
    let rebuild = || -> std::io::Result<Vec<u8>> {
        let mut source = cfb::CompoundFile::open(Cursor::new(bytes))?;
        let mut clean = cfb::CompoundFile::create(Cursor::new(Vec::new()))?;
        clean.create_storage("/BodyText")?;
        for name in [
            "FileHeader",
            "DocInfo",
            "BodyText/Section0",
            "PrvText",
            "PrvImage",
            "RhwpHwpxOrigin",
        ] {
            let path = format!("/{name}");
            let mut data = Vec::new();
            source.open_stream(&path)?.read_to_end(&mut data)?;
            if name == "BodyText/Section0" {
                data = complete_audited_blank_row(&data)?;
            }
            clean.create_stream(&path)?.write_all(&data)?;
        }
        clean.flush()?;
        Ok(clean.into_inner().into_inner())
    };
    let cleaned = rebuild().map_err(|_| DocumentError::Internal)?;
    // Only creation removes metadata. Ordinary preservation never receives an
    // exception for deleting a user's summary, script or document options.
    let checked = service::check_saved(format, &cleaned, &cleaned, Some(report), true);
    if !checked.is_safe() {
        return Err(DocumentError::UnsafeSave {
            preservation: checked,
        });
    }
    Ok(cleaned)
}

pub fn validate_rhwp_blank(
    format: Format,
    bytes: &[u8],
    report: &Value,
) -> Result<(), DocumentError> {
    let (size, digest) = match format {
        Format::Hwp => (
            6144,
            "d1a43b6c8b4e91bc6c76aec7f88adbfda36b267e25d8c933216286b677a6dae2",
        ),
        Format::Hwpx => (
            5472,
            "fca322f71a6ac3cb181fa7143efece5f2060ed3405f5f3c6ee774880f5f85816",
        ),
        Format::Docx => return Err(DocumentError::InvalidRequest),
    };
    if bytes.len() > MAX_BLANK_BYTES {
        return Err(DocumentError::ResourceLimit {
            limit: crate::document::LimitKind::FileSize,
        });
    }
    // The audited identity is the authority. Any other output (e.g. a future RHWP generation) is
    // reported as unverified rather than as a malformed request, and is never written.
    if bytes.len() != size || format!("{:x}", Sha256::digest(bytes)) != digest {
        return Err(DocumentError::CreationUnverified { format });
    }
    if !loss::check(report, format).is_empty()
        || detect(&mut Cursor::new(bytes), bytes.len() as u64)? != format
    {
        return Err(DocumentError::InvalidRequest);
    }
    // Defense in depth for the audited bytes. This self comparison is NOT the
    // proof of blankness: the fixed audited content identity above is.
    let checked = service::check_saved(format, bytes, bytes, Some(report), true);
    if !checked.is_safe() {
        return Err(DocumentError::UnsafeSave {
            preservation: checked,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{identify, testutil::TempDir, Limits, SessionRegistry, SessionState};

    #[test]
    fn audited_blank_row_is_completed_without_changing_text_or_controls() {
        let mut body = Vec::new();
        body.extend_from_slice(&((24u32 << 20) | 66).to_le_bytes());
        let mut header = [0u8; 24];
        header[..4].copy_from_slice(&0x8000_0011u32.to_le_bytes());
        header[12] = 1;
        body.extend_from_slice(&header);
        body.extend_from_slice(&((34u32 << 20) | (1 << 10) | 67).to_le_bytes());
        body.extend_from_slice(&[0; 34]);
        body.extend_from_slice(&((8u32 << 20) | (1 << 10) | 68).to_le_bytes());
        body.extend_from_slice(&[0; 8]);
        body.extend_from_slice(b"preserved-control-records");
        let compress = |bytes: &[u8]| {
            let mut e =
                flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            e.write_all(bytes).unwrap();
            e.finish().unwrap()
        };
        let result = complete_audited_blank_row(&compress(&body)).unwrap();
        let mut decoded = Vec::new();
        flate2::read::DeflateDecoder::new(result.as_slice())
            .read_to_end(&mut decoded)
            .unwrap();
        let mut expected_prefix = body[..78].to_vec();
        expected_prefix[20..22].copy_from_slice(&1u16.to_le_bytes());
        assert_eq!(&decoded[..78], expected_prefix);
        assert_eq!(&decoded[118..], &body[78..]);
        assert_eq!(
            u32::from_le_bytes(decoded[78..82].try_into().unwrap()),
            (36 << 20) | (1 << 10) | 69
        );
        assert_eq!(decoded.len(), body.len() + 40);
        assert_eq!(
            u32::from_le_bytes(decoded[90..94].try_into().unwrap()),
            1000
        );
        assert_eq!(
            u32::from_le_bytes(decoded[110..114].try_into().unwrap()),
            42520
        );
        // Never reinterpret an existing row or a different paragraph as this seed.
        body[20] = 1;
        assert!(complete_audited_blank_row(&compress(&body)).is_err());
        body[20] = 0;
        body[4] = 1;
        assert!(complete_audited_blank_row(&compress(&body)).is_err());
    }

    #[test]
    fn arbitrary_empty_or_oversized_content_never_authorizes_creation() {
        let report =
            serde_json::json!({"schemaVersion":1,"outputFormat":"hwpx","count":0,"losses":[]});
        assert!(validate_rhwp_blank(Format::Hwpx, &[], &report).is_err());
        assert!(validate_rhwp_blank(Format::Docx, b"PK", &report).is_err());
        assert!(matches!(
            validate_rhwp_blank(Format::Hwpx, &vec![0; MAX_BLANK_BYTES + 1], &report),
            Err(DocumentError::ResourceLimit { .. })
        ));
    }

    #[test]
    fn changed_engine_output_is_reported_unverified_and_never_authorized() {
        for (format, size, name) in [(Format::Hwp, 6144, "hwp"), (Format::Hwpx, 5472, "hwpx")] {
            let report =
                serde_json::json!({"schemaVersion":1,"outputFormat":name,"count":0,"losses":[]});
            // Same audited length but different bytes, and a different length: both are an
            // unaudited generation, not a request-shape error, and neither passes preparation.
            for bytes in [vec![0u8; size], vec![0u8; size + 1], Vec::new()] {
                assert_eq!(
                    validate_rhwp_blank(format, &bytes, &report),
                    Err(DocumentError::CreationUnverified { format })
                );
                assert_eq!(
                    prepare_rhwp_blank(format, &bytes, &report),
                    Err(DocumentError::CreationUnverified { format })
                );
            }
        }
        assert_eq!(
            serde_json::to_value(DocumentError::CreationUnverified {
                format: Format::Hwpx
            })
            .unwrap(),
            serde_json::json!({"code":"CreationUnverified","format":"hwpx"})
        );
    }

    /// Evidence outputs are created exclusively: an existing file (for example earlier
    /// prepared.hwp evidence) is never replaced. Rerun in a new run directory instead.
    fn write_new_evidence(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
        use std::io::Write;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?
            .write_all(bytes)
    }

    #[test]
    fn evidence_writer_never_replaces_existing_output() {
        let dir = TempDir::new();
        let path = dir.path().join("prepared.hwp");
        std::fs::write(&path, b"earlier evidence").unwrap();
        let error = write_new_evidence(&path, b"regenerated").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&path).unwrap(), b"earlier evidence");
        let fresh = dir.path().join("prepared.hwpx");
        write_new_evidence(&fresh, b"new").unwrap();
        assert_eq!(std::fs::read(&fresh).unwrap(), b"new");
    }

    #[test]
    #[ignore = "Generate fixtures with scripts/tests/new-document-runtime.mjs; set GEUL_NEW_DOCUMENT_DIR"]
    fn prepare_current_wasm_blanks() {
        let root = std::path::PathBuf::from(std::env::var_os("GEUL_NEW_DOCUMENT_DIR").unwrap());
        for (format, ext) in [(Format::Hwp, "hwp"), (Format::Hwpx, "hwpx")] {
            let bytes = std::fs::read(root.join(format!("blank.{ext}"))).unwrap();
            let report = serde_json::from_slice(
                &std::fs::read(root.join(format!("blank.{ext}.loss.json"))).unwrap(),
            )
            .unwrap();
            let cleaned = prepare_rhwp_blank(format, &bytes, &report).unwrap();
            write_new_evidence(&root.join(format!("prepared.{ext}")), &cleaned)
                .expect("prepared output already exists; use a new run directory");
        }
    }

    #[test]
    #[ignore = "Generate final fixtures with scripts/tests/new-document-runtime.mjs --prepared; set GEUL_NEW_DOCUMENT_DIR"]
    fn current_wasm_creation_and_two_real_safe_saves() {
        let root = std::path::PathBuf::from(std::env::var_os("GEUL_NEW_DOCUMENT_DIR").unwrap());
        for (format, ext) in [(Format::Hwp, "hwp"), (Format::Hwpx, "hwpx")] {
            let read = |stem: &str| std::fs::read(root.join(format!("{stem}.{ext}"))).unwrap();
            let report: Value = serde_json::from_slice(
                &std::fs::read(root.join(format!("blank.{ext}.loss.json"))).unwrap(),
            )
            .unwrap();
            let raw = read("blank");
            validate_rhwp_blank(format, &raw, &report).unwrap();
            assert!(validate_rhwp_blank(format, &read("first-save"), &report).is_err());
            let wrong =
                serde_json::json!({"schemaVersion":1,"outputFormat":ext,"count":1,"losses":[]});
            assert!(validate_rhwp_blank(format, &raw, &wrong).is_err());
            assert!(validate_rhwp_blank(format, &raw, &serde_json::json!({"safe":true})).is_err());
            let mut broken = raw.clone();
            broken[100] ^= 1;
            assert_eq!(
                validate_rhwp_blank(format, &broken, &report),
                Err(DocumentError::CreationUnverified { format })
            );

            let blank = read("prepared");
            let dir = TempDir::new();
            let target = dir.path().join(format!("created.{ext}"));
            let mut staged =
                crate::services::save::publish::stage_new(&target, &blank, None).unwrap();
            let published =
                crate::services::save::publish::publish_new(&mut staged, &target).unwrap();
            assert!(published.durable);
            let registry = SessionRegistry::default();
            let info = registry
                .register_created(
                    identify(target.to_str().unwrap(), &Limits::default()).unwrap(),
                    true,
                )
                .unwrap();
            let generation = registry.begin_load(info.session_id).unwrap().generation;
            registry
                .record_content(
                    info.session_id,
                    generation,
                    crate::document::content_hash(&blank),
                )
                .unwrap();
            registry
                .transition(
                    info.session_id,
                    generation,
                    SessionState::Loading,
                    SessionState::Ready,
                )
                .unwrap();
            let mut original = blank;
            for (index, stem) in ["first-save", "second-save"].into_iter().enumerate() {
                let unedited = if index == 0 {
                    read("unedited")
                } else {
                    original.clone()
                };
                let source = registry
                    .preflight_source(info.session_id, generation)
                    .unwrap();
                let checked = service::preflight(format, &original, &unedited, Some(&report));
                assert!(checked.is_safe(), "{ext}: {checked:?}");
                registry
                    .record_preflight(info.session_id, generation, source.content_hash, checked)
                    .unwrap();
                registry
                    .commit(info.session_id, generation, index as u64, 1)
                    .unwrap();
                let ticket = registry
                    .begin_save(info.session_id, generation, index as u64 + 1)
                    .unwrap();
                let output = read(stem);
                let saved = service::save(
                    &registry,
                    &ticket,
                    &Limits::default(),
                    &output,
                    Some(&report),
                    true,
                )
                .unwrap();
                assert!(saved.durable && !saved.session.dirty);
                original = std::fs::read(&target).unwrap();
                write_new_evidence(
                    &root.join(format!("published-{}.{ext}", index + 1)),
                    &original,
                )
                .expect("published output already exists; use a new run directory");
            }
        }
    }
}
