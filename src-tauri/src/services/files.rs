//! Native file selection and create-only publication. Format conversion is never implicit.
use crate::document::commands::DocumentState;
use crate::document::{DocumentError, Format, Limits, PathProblem, SessionInfo};
use crate::services::save::{publish, service};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request};

const NEW_HEADER: usize = 8;
const MAX_NEW_META: usize = 8192;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NewMeta {
    path: String,
    format: String,
    content_loss: Option<serde_json::Value>,
}

/// GNC1 + metadata length (u32 LE) + strict JSON metadata + optional RHWP bytes.
/// Bound the raw IPC body before any payload duplication or parsing.
fn parse_new(body: &[u8]) -> Result<(NewMeta, Format, &[u8]), DocumentError> {
    if body.len() < NEW_HEADER
        || &body[..4] != b"GNC1"
        || body.len() > NEW_HEADER + MAX_NEW_META + super::creation::MAX_BLANK_BYTES
    {
        return Err(DocumentError::InvalidRequest);
    }
    let len = u32::from_le_bytes(body[4..8].try_into().unwrap()) as usize;
    if len > MAX_NEW_META || NEW_HEADER + len > body.len() {
        return Err(DocumentError::InvalidRequest);
    }
    let meta: NewMeta = serde_json::from_slice(&body[NEW_HEADER..NEW_HEADER + len])
        .map_err(|_| DocumentError::InvalidRequest)?;
    let format = match meta.format.as_str() {
        "docx" => Format::Docx,
        "hwp" => Format::Hwp,
        "hwpx" => Format::Hwpx,
        _ => return Err(DocumentError::InvalidRequest),
    };
    let payload = &body[NEW_HEADER + len..];
    if (format == Format::Docx && (!payload.is_empty() || meta.content_loss.is_some()))
        || (format != Format::Docx && (payload.is_empty() || meta.content_loss.is_none()))
    {
        return Err(DocumentError::InvalidRequest);
    }
    Ok((meta, format, payload))
}

pub fn destination(path: &Path, format: Format) -> Result<PathBuf, DocumentError> {
    if !path.is_absolute() {
        return Err(DocumentError::InvalidPath {
            reason: PathProblem::Relative,
        });
    }
    if path.as_os_str().len() > 4096 {
        return Err(DocumentError::InvalidPath {
            reason: PathProblem::TooLong,
        });
    }
    let declared = path
        .extension()
        .and_then(|e| e.to_str())
        .and_then(Format::from_extension)
        .ok_or(DocumentError::InvalidRequest)?;
    if declared != format {
        return Err(DocumentError::ExtensionMismatch {
            declared,
            detected: format,
        });
    }
    if path.as_os_str().as_encoded_bytes().contains(&0) {
        return Err(DocumentError::InvalidPath {
            reason: PathProblem::ContainsNul,
        });
    }
    let name = path.file_name().ok_or(DocumentError::InvalidRequest)?;
    let parent = path
        .parent()
        .ok_or(DocumentError::InvalidRequest)?
        .canonicalize()
        .map_err(|_| DocumentError::InvalidRequest)?;
    Ok(parent.join(name))
}

/// A real WordCraft blank model, serialized and independently reopened before publication.
pub fn blank_docx() -> Result<Vec<u8>, DocumentError> {
    let doc = wordcraft_engine::blank_document(&Default::default());
    let bytes = wordcraft_engine::io::save_bytes("document.docx", &doc)
        .map_err(|_| DocumentError::Internal)?;
    let model = crate::adapters::wordcraft::engine::DocxModel::open(&bytes)
        .map_err(|_| DocumentError::Internal)?;
    let again = model.export().ok_or(DocumentError::Internal)?;
    let checked = service::preflight(Format::Docx, &bytes, &again, None);
    if !checked.is_safe() || !model.same_as(&again) {
        return Err(DocumentError::UnsafeSave {
            preservation: checked,
        });
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn document_new(
    state: tauri::State<'_, DocumentState>,
    request: Request<'_>,
) -> Result<SessionInfo, DocumentError> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err(DocumentError::InvalidRequest);
    };
    let (meta, format, payload) = parse_new(body)?;
    let target = destination(Path::new(&meta.path), format)?;
    let pending = state.begin_open()?;
    pending
        .1
        .charge(crate::document::resources::Category::Ipc, body.len())?;
    pending
        .1
        .charge(crate::document::resources::Category::Payload, payload.len())?;
    let payload = payload.to_vec();
    let limits: Limits = state.limits();
    let registry = state.registry().clone();
    state
        .run_admitted(pending, move || {
            let bytes = if format == Format::Docx {
                blank_docx()?
            } else {
                super::creation::prepare_rhwp_blank(
                    format,
                    &payload,
                    meta.content_loss
                        .as_ref()
                        .ok_or(DocumentError::InvalidRequest)?,
                )?
            };
            create_validated(&registry, &target, format, &bytes, &limits)
        })
        .await
}

/// Publication and registration have separate outcomes: once published, never report "nothing written".
pub fn create_docx(
    registry: &crate::document::SessionRegistry,
    target: &Path,
    limits: &Limits,
) -> Result<SessionInfo, DocumentError> {
    let bytes = blank_docx()?;
    create_validated(registry, target, Format::Docx, &bytes, limits)
}

fn create_validated(
    registry: &crate::document::SessionRegistry,
    target: &Path,
    format: Format,
    bytes: &[u8],
    limits: &Limits,
) -> Result<SessionInfo, DocumentError> {
    let mut staged = publish::stage_new(target, bytes, None)?;
    let published = publish::publish_new(&mut staged, target)?;
    register_published(registry, target, format, bytes, limits, published)
}

fn register_published(
    registry: &crate::document::SessionRegistry,
    target: &Path,
    format: Format,
    bytes: &[u8],
    limits: &Limits,
    published: crate::document::Published,
) -> Result<SessionInfo, DocumentError> {
    let register = || {
        let file = crate::document::identify(
            target.to_str().ok_or(DocumentError::InvalidRequest)?,
            limits,
        )?;
        // Bind registration to the exact inode/fingerprint and final bytes we
        // published. A same-path replacement is not our created document.
        if file.format != format
            || file.identity != published.identity
            || file.fingerprint != published.fingerprint
        {
            return Err(DocumentError::FileChanged);
        }
        let source = crate::document::LoadSource {
            identity: file.identity.clone(),
            fingerprint: file.fingerprint,
            format,
            generation: 0,
        };
        if crate::document::read_identified(&source, limits)? != bytes {
            return Err(DocumentError::FileChanged);
        }
        registry.register_created(file, published.durable)
    };
    register().map_err(|_| DocumentError::FilePublishedUnregistered)
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn document_file_dialog(
    window: tauri::WebviewWindow,
    mode: String,
    format: Option<String>,
    title: String,
    accept: String,
    cancel: String,
) -> Result<Option<String>, DocumentError> {
    use gtk::prelude::*;
    use tauri::Manager;
    if !matches!(mode.as_str(), "open" | "save")
        || [&title, &accept, &cancel].iter().any(|v| v.len() > 256)
    {
        return Err(DocumentError::InvalidRequest);
    }
    let extensions: Vec<&str> = match format.as_deref() {
        Some("hwp") => vec!["hwp"],
        Some("hwpx") => vec!["hwpx"],
        Some("docx") => vec!["docx"],
        None if mode == "open" => vec!["hwp", "hwpx", "docx"],
        _ => return Err(DocumentError::InvalidRequest),
    };
    let extensions: Vec<String> = extensions.into_iter().map(str::to_owned).collect();
    let (tx, rx) = std::sync::mpsc::channel();
    let app = window.app_handle().clone();
    app.run_on_main_thread(move || {
        let parent = match window.gtk_window() {
            Ok(parent) => parent,
            Err(_) => {
                let _ = tx.send(Err(DocumentError::Internal));
                return;
            }
        };
        let action = if mode == "open" {
            gtk::FileChooserAction::Open
        } else {
            gtk::FileChooserAction::Save
        };
        let chooser = gtk::FileChooserNative::new(
            Some(&title),
            Some(&parent),
            action,
            Some(&accept),
            Some(&cancel),
        );
        chooser.set_modal(true);
        let filter = gtk::FileFilter::new();
        for ext in &extensions {
            filter.add_pattern(&format!("*.{ext}"));
            filter.add_pattern(&format!("*.{}", ext.to_uppercase()));
        }
        chooser.add_filter(filter);
        if mode == "save" {
            chooser.set_current_name(&format!("Untitled.{}", extensions[0]));
        }
        let response = chooser.run();
        let value = if response == gtk::ResponseType::Accept {
            chooser
                .filename()
                .and_then(|p| p.to_str().map(str::to_owned))
        } else {
            None
        };
        chooser.destroy();
        let _ = tx.send(Ok(value));
    })
    .map_err(|_| DocumentError::Internal)?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|_| DocumentError::Internal)?)
        .await
        .map_err(|_| DocumentError::Internal)?
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub async fn document_file_dialog() -> Result<Option<String>, DocumentError> {
    Err(DocumentError::SaveUnsupported {
        reason: crate::document::SaveUnsupportedReason::Platform,
    })
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::document::{testutil::TempDir, SessionRegistry};

    fn frame(format: &str, payload: &[u8], loss: serde_json::Value) -> Vec<u8> {
        let meta = serde_json::to_vec(
            &serde_json::json!({"format":format,"path":"/document.docx","contentLoss":loss}),
        )
        .unwrap();
        let mut bytes = b"GNC1".to_vec();
        bytes.extend_from_slice(&(meta.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&meta);
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn creation_frame_is_bounded_and_format_specific() {
        assert!(parse_new(&frame("docx", &[], serde_json::Value::Null)).is_ok());
        for bytes in [
            frame("DOCX", &[], serde_json::Value::Null),
            frame("docx", b"arbitrary", serde_json::Value::Null),
            frame("hwp", &[], serde_json::json!({})),
            frame("hwpx", b"PK", serde_json::Value::Null),
            vec![0; MAX_NEW_META + super::super::creation::MAX_BLANK_BYTES + 9],
            b"GNC1\xff\xff\xff\xff".to_vec(),
        ] {
            assert!(parse_new(&bytes).is_err());
        }
        let mut unknown = frame("docx", &[], serde_json::Value::Null);
        unknown.extend_from_slice(b"extra");
        assert!(parse_new(&unknown).is_err());
    }

    #[test]
    fn creation_destination_checks_extension_and_path_before_writing() {
        let dir = TempDir::new();
        assert!(destination(Path::new("relative.hwp"), Format::Hwp).is_err());
        assert!(destination(&dir.path().join("wrong.docx"), Format::Hwp).is_err());
        assert!(destination(&dir.path().join("document.hwpx"), Format::Hwpx).is_ok());
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
    }

    #[test]
    fn existing_files_and_symlinks_are_never_replaced() {
        let dir = TempDir::new();
        let original = dir.write("original.docx", b"keep exact user data");
        let link = dir.path().join("link.docx");
        std::os::unix::fs::symlink(&original, &link).unwrap();
        let registry = SessionRegistry::default();
        for target in [&original, &link] {
            assert_eq!(
                create_docx(&registry, target, &Limits::default()),
                Err(DocumentError::FileConflict)
            );
        }
        assert_eq!(std::fs::read(&original).unwrap(), b"keep exact user data");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(registry.list().unwrap().is_empty());
    }

    #[test]
    fn a_replaced_published_inode_is_not_registered_even_with_identical_bytes() {
        let dir = TempDir::new();
        let target = dir.path().join("new.docx");
        let bytes = blank_docx().unwrap();
        let mut staged = publish::stage_new(&target, &bytes, None).unwrap();
        let published = publish::publish_new(&mut staged, &target).unwrap();
        let replacement = dir.write("replacement.docx", &bytes);
        std::fs::rename(replacement, &target).unwrap();
        let registry = SessionRegistry::default();
        assert_eq!(
            register_published(
                &registry,
                &target,
                Format::Docx,
                &bytes,
                &Limits::default(),
                published
            ),
            Err(DocumentError::FilePublishedUnregistered)
        );
        assert!(registry.list().unwrap().is_empty());
        assert_eq!(std::fs::read(target).unwrap(), bytes);
    }

    #[test]
    #[ignore = "Current WASM creation integration: GEUL_NEW_DOCUMENT_DIR from T021 runtime probe"]
    fn all_formats_publish_register_and_reject_repeat_creation() {
        let root = std::path::PathBuf::from(std::env::var_os("GEUL_NEW_DOCUMENT_DIR").unwrap());
        let dir = TempDir::new();
        let registry = SessionRegistry::default();
        for (format, ext) in [
            (Format::Docx, "docx"),
            (Format::Hwp, "hwp"),
            (Format::Hwpx, "hwpx"),
        ] {
            let bytes = if format == Format::Docx {
                blank_docx().unwrap()
            } else {
                let raw = std::fs::read(root.join(format!("blank.{ext}"))).unwrap();
                let report = serde_json::from_slice(
                    &std::fs::read(root.join(format!("blank.{ext}.loss.json"))).unwrap(),
                )
                .unwrap();
                super::super::creation::prepare_rhwp_blank(format, &raw, &report).unwrap()
            };
            let path = destination(&dir.path().join(format!("created.{ext}")), format).unwrap();
            let info =
                create_validated(&registry, &path, format, &bytes, &Limits::default()).unwrap();
            assert_eq!((info.format, info.engine), (format, format.engine()));
            assert_eq!(
                (info.revision, info.sequence, info.load_generation),
                (0, 0, 0)
            );
            assert!(!info.dirty);
            assert_eq!(info.state, crate::document::SessionState::Identified);
            assert_eq!(
                create_validated(&registry, &path, format, &bytes, &Limits::default()),
                Err(DocumentError::FileConflict)
            );
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
        assert_eq!(registry.list().unwrap().len(), 3);
    }

    #[test]
    fn published_docx_with_full_registry_has_distinct_error_and_remains_openable() {
        let dir = TempDir::new();
        let target = dir.path().join("new.docx");
        let registry = SessionRegistry::new(0);
        assert_eq!(
            create_docx(&registry, &target, &Limits::default()).unwrap_err(),
            DocumentError::FilePublishedUnregistered
        );
        let bytes = std::fs::read(&target).unwrap();
        assert!(crate::adapters::wordcraft::engine::DocxModel::open(&bytes).is_ok());
        assert_eq!(
            create_docx(&registry, &target, &Limits::default()).unwrap_err(),
            DocumentError::FileConflict
        );
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
    }
}
