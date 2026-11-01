//! Native file selection and create-only publication. Format conversion is never implicit.
use crate::document::commands::DocumentState;
use crate::document::{DocumentError, Format, Limits, PathProblem, SessionInfo};
use crate::services::save::{publish, service};
use std::path::{Path, PathBuf};

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
    path: String,
) -> Result<SessionInfo, DocumentError> {
    let target = destination(Path::new(&path), Format::Docx)?;
    let limits: Limits = state.limits();
    let registry = state.registry().clone();
    state
        .run_blocking(move || {
            let bytes = blank_docx()?;
            let mut staged = publish::stage_new(&target, &bytes, None)?;
            let published = publish::publish_new(&mut staged, &target)?;
            let file = crate::document::identify(
                target.to_str().ok_or(DocumentError::InvalidRequest)?,
                &limits,
            )?;
            registry.register_created(file, published.durable)
        })
        .await
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
