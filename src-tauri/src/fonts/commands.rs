//! Font IPC commands (Stage 5-A): catalog, refresh, user font registration and removal, and user font
//! bytes for the RHWP WebView bridge.
//!
//! No command takes a path. Registration reads only the file the user picked in the native chooser
//! (`services::files::native_file_dialog`, the same trusted boundary documents and pictures use). Errors
//! carry a code only: no file paths, folder names or library messages reach the WebView.

use serde::Serialize;
use tauri::ipc::Response;
use wordcraft_fonts::{FontDb, UserFontError, MAX_FONT_FILE_BYTES};

use super::catalog::{self, FontCatalog, UserFontEntry};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all_fields = "camelCase")]
pub enum FontError {
    /// Not a TrueType/OpenType/collection/WOFF/WOFF2 font, or no usable face.
    UnsupportedFont,
    /// A web font that could not be unwrapped, or a font whose faces do not parse.
    DamagedFont,
    /// Larger than the input or decoded size limit.
    FontTooLarge,
    /// Every face in the file is already available.
    AlreadyAvailable {
        families: Vec<String>,
    },
    /// Too many user fonts.
    TooManyFonts,
    /// The family is not a user font (system and bundled fonts cannot be removed).
    NotUserFont,
    /// Registration through the native chooser is not available on this platform yet.
    PlatformUnsupported,
    InvalidRequest,
    Internal,
}

impl FontError {
    pub(crate) fn from_user(e: UserFontError) -> FontError {
        map_user_error(e)
    }
}

fn map_user_error(e: UserFontError) -> FontError {
    match e {
        UserFontError::Empty | UserFontError::NotAFont => FontError::UnsupportedFont,
        UserFontError::TooLarge { .. } => FontError::FontTooLarge,
        UserFontError::BadWebFont(_) | UserFontError::Unusable(_) => FontError::DamagedFont,
        UserFontError::AlreadyAvailable(families) => FontError::AlreadyAvailable { families },
        UserFontError::TooMany => FontError::TooManyFonts,
        UserFontError::NotUserFont(_) => FontError::NotUserFont,
    }
}

/// The outcome of a registration.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Registered {
    pub font: UserFontEntry,
    /// The font is usable now but could not be stored: it will not survive a restart.
    pub storage_failed: bool,
    pub catalog: FontCatalog,
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, FontError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| FontError::Internal)
}

/// The current catalog.
#[tauri::command]
pub async fn font_catalog() -> Result<FontCatalog, FontError> {
    blocking(|| catalog::build(&super::service())).await
}

/// Reload the system font configuration, rescan, and return the catalog.
#[tauri::command]
pub async fn font_refresh() -> Result<FontCatalog, FontError> {
    blocking(|| {
        super::refresh();
        catalog::build(&super::service())
    })
    .await
}

/// Validate and register font `bytes` named `name` (file name only, for the stored copy).
pub fn register_bytes(name: &str, bytes: &[u8]) -> Result<Registered, FontError> {
    let installed = FontDb::global()
        .install_font(name, bytes)
        .map_err(FontError::from_user)?;
    let service = super::service();
    Ok(Registered {
        storage_failed: installed.warning.is_some()
            || (service.persistent() && installed.font.path.is_none()),
        font: catalog::user_entry(&installed.font),
        catalog: catalog::build(&service),
    })
}

/// Read a font file the user picked, bounded by the input size limit, without following it into a FIFO
/// or device.
pub fn read_font_file(path: &std::path::Path) -> Result<Vec<u8>, FontError> {
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| FontError::InvalidRequest)?;
    let meta = file.metadata().map_err(|_| FontError::InvalidRequest)?;
    if !meta.is_file() {
        return Err(FontError::InvalidRequest);
    }
    if meta.len() > MAX_FONT_FILE_BYTES as u64 {
        return Err(FontError::FontTooLarge);
    }
    let mut bytes = Vec::new();
    file.take(MAX_FONT_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| FontError::InvalidRequest)?;
    if bytes.len() > MAX_FONT_FILE_BYTES {
        return Err(FontError::FontTooLarge);
    }
    Ok(bytes)
}

/// Pick a font file in the native chooser and register it. `None` when the user cancelled.
#[tauri::command]
pub async fn font_register(
    window: tauri::WebviewWindow,
    title: String,
    accept: String,
    cancel: String,
) -> Result<Option<Registered>, FontError> {
    #[cfg(target_os = "linux")]
    {
        let path = crate::services::files::native_file_dialog(
            window,
            "open".into(),
            Some("font".into()),
            title,
            accept,
            cancel,
            None,
        )
        .await
        .map_err(|_| FontError::Internal)?;
        let Some(path) = path else { return Ok(None) };
        blocking(move || {
            let path = std::path::PathBuf::from(path);
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "font".into());
            let bytes = read_font_file(&path)?;
            register_bytes(&name, &bytes).map(Some)
        })
        .await?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, title, accept, cancel);
        Err(FontError::PlatformUnsupported)
    }
}

/// Remove the user fonts that added `family`; returns the catalog. Bundled and system fonts are refused.
#[tauri::command]
pub async fn font_remove(family: String) -> Result<FontCatalog, FontError> {
    if family.trim().is_empty() || family.len() > 256 {
        return Err(FontError::InvalidRequest);
    }
    blocking(move || {
        FontDb::global()
            .remove_user_font(family.trim())
            .map_err(FontError::from_user)?;
        Ok(catalog::build(&super::service()))
    })
    .await?
}

/// Most bytes one user font file may send to the WebView (the decoded-size limit of a registration).
const MAX_BRIDGE_BYTES: usize = 128 << 20;

/// The font file bytes behind one registered user face (`family`, `style`), for the WebView's
/// `FontFace` (RHWP Canvas rendering). Only user fonts are served — system fonts reach the WebView
/// through its own platform font configuration — and bytes come from the loaded face, never from a
/// path named by the caller. Response: 4-byte little-endian face index, then the font file.
pub fn user_face_bytes(family: &str, style: &str) -> Result<Vec<u8>, FontError> {
    let db = FontDb::global();
    let owned = db.user_fonts().iter().any(|u| {
        u.faces
            .iter()
            .any(|(f, s)| f.eq_ignore_ascii_case(family) && s.eq_ignore_ascii_case(style))
    });
    if !owned {
        return Err(FontError::NotUserFont);
    }
    let face = db.face(family, style);
    if !face.family.eq_ignore_ascii_case(family) || !face.style.eq_ignore_ascii_case(style) {
        return Err(FontError::NotUserFont);
    }
    let data = face.data();
    if data.len() > MAX_BRIDGE_BYTES {
        return Err(FontError::FontTooLarge);
    }
    let mut out = Vec::with_capacity(4 + data.len());
    out.extend_from_slice(&face.index().to_le_bytes());
    out.extend_from_slice(data);
    Ok(out)
}

#[tauri::command]
pub async fn font_user_face(family: String, style: String) -> Result<Response, FontError> {
    if family.is_empty() || family.len() > 256 || style.is_empty() || style.len() > 256 {
        return Err(FontError::InvalidRequest);
    }
    blocking(move || user_face_bytes(&family, &style).map(Response::new)).await?
}
