//! PDF export (Stage 5-A, S5-4). PDF is an output, never a format conversion of the session (FR-015):
//! the open document, its file, dirty/revision state and history are never changed.
//!
//! - DOCX (WordCraft): the engine's own PDF writer (`wordcraft-pdf`, krilla) over the engine's print
//!   layout: vector pages with embedded font subsets, so text is selectable. Run under the model lock for
//!   the exact requested load generation and committed revision (`docx_export_pdf`).
//! - HWP/HWPX (RHWP): the RHWP model lives in the WebView, and the pinned RHWP WASM has no PDF writer. The
//!   frontend paints every page with the same `renderPageToCanvas` used by the editor surface and sends one
//!   PNG per page (`document_export_pdf`, frame `GPD1`). This module decodes every PNG completely (bounded),
//!   checks its declared pixel size, and writes one PDF page per raster at the page's physical size. These
//!   pages are images: no selectable or searchable text is claimed.
//! - Destination: an absolute `.pdf` path chosen in the native dialog. The extension can never name an open
//!   document (sessions only open `.hwp`/`.hwpx`/`.docx`). A new name is published create-only
//!   (`RENAME_NOREPLACE`); an existing regular file the user confirmed to replace goes through the same
//!   verified staging/atomic rename as a save (`publish::stage`/`publish::publish`). A failure never leaves a
//!   partial PDF at the destination.
use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::{ImageFormat, ImageReader, Limits as ImageLimits};
use serde::Serialize;

use crate::document::{DocumentError, PathProblem, Published, SaveStage, SessionId};
use crate::services::save::publish;

/// Request frame for RHWP raster pages: `GPD1` · session (u64) · load generation (u64) · revision (u64) ·
/// meta length (u32) · meta (JSON) · page PNGs back to back. Integers are little-endian.
pub const FRAME_MAGIC: &[u8; 4] = b"GPD1";
const FRAME_HEADER: usize = 4 + 8 * 3 + 4;
const MAX_META_BYTES: usize = 512 * 1024;
/// Pages per export (the frontend refuses longer documents before rendering).
pub const MAX_PAGES: usize = 2000;
/// All page PNGs of one request.
pub const MAX_PAYLOAD_BYTES: usize = 768 * 1024 * 1024;
/// One page raster.
pub const MAX_PAGE_PIXELS: u64 = 24 * 1024 * 1024;
pub const MAX_RASTER_SIDE: u32 = 12_000;
/// Largest PDF page side in points (200 in, the PDF implementation limit).
pub const MAX_PAGE_POINTS: f64 = 14_400.0;

/// Result of an export. `raster` = pages are images (RHWP); false = vector pages with text (WordCraft).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfExported {
    pub session_id: SessionId,
    pub load_generation: u64,
    pub revision: u64,
    pub pages: usize,
    pub bytes: usize,
    pub durable: bool,
    pub raster: bool,
    /// After a confirmed replacement, the previous file could not be removed: its current file name in the
    /// destination directory (the PDF itself is published). `None` normally.
    pub retained_replaced: Option<String>,
}

/// One page of the RHWP request: physical size (points) and its decoded-and-checked PNG.
#[derive(Debug)]
pub struct RasterPage {
    pub width_pt: f64,
    pub height_pt: f64,
    pub png: Vec<u8>,
}

pub struct RasterRequest {
    pub session_id: SessionId,
    pub generation: u64,
    pub revision: u64,
    pub destination: String,
    /// Token from the PDF chooser's overwrite confirmation, if the destination existed.
    pub overwrite_grant: Option<String>,
    pub pages: Vec<RasterPage>,
}

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    let mut word = [0u8; 8];
    word.copy_from_slice(&bytes[at..at + 8]);
    u64::from_le_bytes(word)
}

fn finite_positive(value: &serde_json::Value, max: f64) -> Option<f64> {
    value
        .as_f64()
        .filter(|v| v.is_finite() && *v > 0.0 && *v <= max)
}

/// Parse and fully validate a `GPD1` frame. Meta is exactly
/// `{"destination": string, "overwriteGrant": null | token, "pages": [{"widthPt", "heightPt", "pixelWidth", "pixelHeight", "length"}...]}`;
/// the PNG lengths must add up to the payload exactly. Every PNG is decoded here (bounded) and must have
/// the declared pixel size. Anything else is `InvalidRequest` (or `ResourceLimit` for size limits).
pub fn parse_raster_request(body: &[u8]) -> Result<RasterRequest, DocumentError> {
    if body.len() < FRAME_HEADER || &body[..4] != FRAME_MAGIC {
        return Err(DocumentError::InvalidRequest);
    }
    let meta_len = u32::from_le_bytes([body[28], body[29], body[30], body[31]]) as usize;
    if meta_len > MAX_META_BYTES || body.len() < FRAME_HEADER + meta_len {
        return Err(DocumentError::InvalidRequest);
    }
    let payload = &body[FRAME_HEADER + meta_len..];
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(DocumentError::ResourceLimit {
            limit: crate::document::LimitKind::FileSize,
        });
    }
    let meta: serde_json::Value =
        serde_json::from_slice(&body[FRAME_HEADER..FRAME_HEADER + meta_len])
            .map_err(|_| DocumentError::InvalidRequest)?;
    let object = meta
        .as_object()
        .filter(|o| o.len() == 3)
        .ok_or(DocumentError::InvalidRequest)?;
    let overwrite_grant = match object
        .get("overwriteGrant")
        .ok_or(DocumentError::InvalidRequest)?
    {
        serde_json::Value::Null => None,
        serde_json::Value::String(token)
            if token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit()) =>
        {
            Some(token.clone())
        }
        _ => return Err(DocumentError::InvalidRequest),
    };
    let destination = object
        .get("destination")
        .and_then(serde_json::Value::as_str)
        .ok_or(DocumentError::InvalidRequest)?
        .to_owned();
    let declared = object
        .get("pages")
        .and_then(serde_json::Value::as_array)
        .ok_or(DocumentError::InvalidRequest)?;
    if declared.is_empty() || declared.len() > MAX_PAGES {
        return Err(DocumentError::InvalidRequest);
    }
    let mut pages = Vec::with_capacity(declared.len());
    let mut at = 0usize;
    for page in declared {
        let fields = page
            .as_object()
            .filter(|o| o.len() == 5)
            .ok_or(DocumentError::InvalidRequest)?;
        let get = |key: &str| fields.get(key).ok_or(DocumentError::InvalidRequest);
        let width_pt = finite_positive(get("widthPt")?, MAX_PAGE_POINTS)
            .ok_or(DocumentError::InvalidRequest)?;
        let height_pt = finite_positive(get("heightPt")?, MAX_PAGE_POINTS)
            .ok_or(DocumentError::InvalidRequest)?;
        let dimension = |key: &str| -> Result<u32, DocumentError> {
            get(key)?
                .as_u64()
                .filter(|v| (1..=u64::from(MAX_RASTER_SIDE)).contains(v))
                .map(|v| v as u32)
                .ok_or(DocumentError::InvalidRequest)
        };
        let (pixel_width, pixel_height) = (dimension("pixelWidth")?, dimension("pixelHeight")?);
        let length = get("length")?
            .as_u64()
            .filter(|v| *v > 0)
            .and_then(|v| usize::try_from(v).ok())
            .ok_or(DocumentError::InvalidRequest)?;
        let end = at
            .checked_add(length)
            .ok_or(DocumentError::InvalidRequest)?;
        let png = payload.get(at..end).ok_or(DocumentError::InvalidRequest)?;
        check_png(png, pixel_width, pixel_height)?;
        check_aspect(width_pt, height_pt, pixel_width, pixel_height)?;
        pages.push(RasterPage {
            width_pt,
            height_pt,
            png: png.to_vec(),
        });
        at = end;
    }
    if at != payload.len() {
        return Err(DocumentError::InvalidRequest);
    }
    Ok(RasterRequest {
        session_id: u64_at(body, 4),
        generation: u64_at(body, 12),
        revision: u64_at(body, 20),
        destination,
        overwrite_grant,
        pages,
    })
}

/// A complete PNG (signature through IEND) that decodes fully, within bounds, to exactly `width`×`height`.
pub fn check_png(png: &[u8], width: u32, height: u32) -> Result<(), DocumentError> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    const IEND: &[u8] = b"\0\0\0\0IEND\xaeB`\x82";
    if !png.starts_with(SIGNATURE) || !png.ends_with(IEND) {
        return Err(DocumentError::InvalidRequest);
    }
    if u64::from(width) * u64::from(height) > MAX_PAGE_PIXELS {
        return Err(DocumentError::ResourceLimit {
            limit: crate::document::LimitKind::FileSize,
        });
    }
    let mut reader = ImageReader::with_format(Cursor::new(png), ImageFormat::Png);
    let mut limits = ImageLimits::default();
    limits.max_image_width = Some(MAX_RASTER_SIDE);
    limits.max_image_height = Some(MAX_RASTER_SIDE);
    limits.max_alloc = Some(MAX_PAGE_PIXELS * 4 + 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| DocumentError::InvalidRequest)?;
    if (decoded.width(), decoded.height()) != (width, height) {
        return Err(DocumentError::InvalidRequest);
    }
    Ok(())
}

/// The raster must have the page's proportions (within rounding of whole pixels), so a page is never
/// stretched or cropped silently.
fn check_aspect(width_pt: f64, height_pt: f64, px_w: u32, px_h: u32) -> Result<(), DocumentError> {
    // Each side is ceil(side × scale): at most 1 px of rounding, plus 0.5 % for engine rounding.
    let expected_h = height_pt * f64::from(px_w) / width_pt;
    if (expected_h - f64::from(px_h)).abs() > 1.0 + f64::from(px_h) * 0.005 {
        return Err(DocumentError::InvalidRequest);
    }
    Ok(())
}

/// Write one PDF page per raster, the image covering the page at its physical size.
pub fn raster_pdf(pages: &[RasterPage], title: Option<&str>) -> Result<Vec<u8>, DocumentError> {
    use krilla::geom::Size;
    use krilla::image::Image;
    use krilla::metadata::Metadata;
    use krilla::page::PageSettings;
    use krilla::Document;
    if pages.is_empty() {
        return Err(DocumentError::InvalidRequest);
    }
    let export = || DocumentError::SaveFailure {
        stage: SaveStage::Export,
        io: None,
    };
    let mut document = Document::new();
    let mut metadata = Metadata::new().creator("geul".to_owned());
    if let Some(title) = title.filter(|t| !t.is_empty()) {
        metadata = metadata.title(title.to_owned());
    }
    document.set_metadata(metadata);
    for page in pages {
        let (w, h) = (page.width_pt as f32, page.height_pt as f32);
        let settings = PageSettings::from_wh(w, h).ok_or_else(export)?;
        let size = Size::from_wh(w, h).ok_or_else(export)?;
        let image = Image::from_png(page.png.clone().into(), true).map_err(|_| export())?;
        let mut current = document.start_page_with(settings);
        let mut surface = current.surface();
        surface.draw_image(image, size);
        surface.finish();
        current.finish();
    }
    let bytes = document.finish().map_err(|_| export())?;
    check_pdf_envelope(&bytes)?;
    Ok(bytes)
}

/// Minimal self-check before publication: a PDF header and trailer. Independent page-count and visual
/// checks are acceptance tests (see docs/quality-matrix.md), not this function.
pub fn check_pdf_envelope(bytes: &[u8]) -> Result<(), DocumentError> {
    let tail = &bytes[bytes.len().saturating_sub(1024)..];
    if bytes.starts_with(b"%PDF-") && tail.windows(5).any(|w| w == b"%%EOF") {
        Ok(())
    } else {
        Err(DocumentError::SaveFailure {
            stage: SaveStage::Validate,
            io: None,
        })
    }
}

/// The export destination: absolute, at most 4096 bytes, no NUL, a `.pdf` file name (any case), in an
/// existing directory (canonicalized). Never a session format.
pub fn destination(path: &str) -> Result<PathBuf, DocumentError> {
    if path.is_empty() {
        return Err(DocumentError::InvalidPath {
            reason: PathProblem::Empty,
        });
    }
    if path.len() > 4096 {
        return Err(DocumentError::InvalidPath {
            reason: PathProblem::TooLong,
        });
    }
    if path.contains('\0') {
        return Err(DocumentError::InvalidPath {
            reason: PathProblem::ContainsNul,
        });
    }
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(DocumentError::InvalidPath {
            reason: PathProblem::Relative,
        });
    }
    let pdf = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
    let name = path
        .file_name()
        .filter(|_| pdf)
        .ok_or(DocumentError::InvalidRequest)?;
    let parent = path
        .parent()
        .ok_or(DocumentError::InvalidRequest)?
        .canonicalize()
        .map_err(|_| DocumentError::InvalidRequest)?;
    Ok(parent.join(name))
}

/// How long an overwrite confirmation from the native dialog stays usable.
pub const OVERWRITE_GRANT_TTL: std::time::Duration = std::time::Duration::from_secs(10 * 60);
/// Outstanding grants kept at most (oldest dropped first); a grant is normally used within seconds.
const MAX_GRANTS: usize = 32;

#[derive(Clone)]
struct OverwriteGrant {
    target: PathBuf,
    expected: publish::Snapshot,
    session_id: SessionId,
    generation: u64,
    issued: std::time::Instant,
}

/// One-time overwrite authorizations keyed by an unpredictable 128-bit token. A grant is issued only by
/// [`issue_overwrite_grant`] — called by the backend's own PDF chooser after GTK's overwrite confirmation,
/// never an IPC command — and is bound to the canonical destination, the observed file snapshot, and the
/// exporting session and load generation. Only the export that received the token can present it.
fn grants() -> std::sync::MutexGuard<'static, std::collections::HashMap<String, OverwriteGrant>> {
    static GRANTS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, OverwriteGrant>>,
    > = std::sync::OnceLock::new();
    GRANTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn new_token() -> Option<String> {
    let mut random = [0u8; 16];
    let mut at = 0;
    while at < random.len() {
        // SAFETY: the buffer slice is valid for the requested length; flags 0 waits for entropy.
        let got =
            unsafe { libc::getrandom(random[at..].as_mut_ptr().cast(), random.len() - at, 0) };
        if got <= 0 {
            return None;
        }
        at += got as usize;
    }
    Some(random.iter().map(|b| format!("{b:02x}")).collect())
}

/// The user confirmed replacing the file now at `chosen` for the PDF export of `session_id`/`generation`
/// (the backend PDF chooser ran with GTK overwrite confirmation and returned it). Returns the token of a new
/// grant bound to the canonical destination and the observed status snapshot (device, inode, size, mtime,
/// ctime, mode) of that regular file, or `None` when the path is missing, not a regular file, not a PDF
/// destination, or no randomness is available (an existing file then cannot be replaced).
/// Residual: GTK checks existence before asking; a file created between that check and this snapshot is
/// granted without having been shown — only this user (or root) can create it in the trusted directory.
pub(crate) fn issue_overwrite_grant(
    chosen: &str,
    session_id: SessionId,
    generation: u64,
) -> Option<String> {
    let target = destination(chosen).ok()?;
    let meta = std::fs::symlink_metadata(&target)
        .ok()
        .filter(|m| m.file_type().is_file())?;
    let token = new_token()?;
    let now = std::time::Instant::now();
    let mut grants = grants();
    grants.retain(|_, g| now.saturating_duration_since(g.issued) <= OVERWRITE_GRANT_TTL);
    while grants.len() >= MAX_GRANTS {
        let oldest = grants
            .iter()
            .min_by_key(|(_, g)| g.issued)
            .map(|(k, _)| k.clone());
        grants.remove(&oldest?);
    }
    grants.insert(
        token.clone(),
        OverwriteGrant {
            target,
            expected: publish::snapshot(&meta),
            session_id,
            generation,
            issued: now,
        },
    );
    Some(token)
}

/// Claim the grant `token` for this export. `None` → no overwrite authorization. A token that is unknown or
/// expired is removed and refused; a grant bound to another destination, session or load generation is
/// refused and left for its own export (another export cannot consume it). On success the grant is removed
/// (one use) and its confirmed snapshot returned.
fn claim_overwrite(
    token: Option<&str>,
    target: &Path,
    session_id: SessionId,
    generation: u64,
    now: std::time::Instant,
) -> Result<Option<publish::Snapshot>, DocumentError> {
    let Some(token) = token else { return Ok(None) };
    let mut grants = grants();
    let Some(grant) = grants.get(token).cloned() else {
        return Err(DocumentError::FileConflict);
    };
    if now.saturating_duration_since(grant.issued) > OVERWRITE_GRANT_TTL {
        grants.remove(token);
        return Err(DocumentError::FileConflict);
    }
    if grant.target != target || grant.session_id != session_id || grant.generation != generation {
        return Err(DocumentError::FileConflict);
    }
    grants.remove(token);
    Ok(Some(grant.expected))
}

/// Drop the grant `token` of this export when the export is refused before publication (a failed export must
/// not leave its confirmation usable). Only the owning session's grant is dropped.
pub(crate) fn release_overwrite_grant(token: Option<&str>, session_id: SessionId) {
    if let Some(token) = token {
        let mut grants = grants();
        if grants
            .get(token)
            .is_some_and(|g| g.session_id == session_id)
        {
            grants.remove(token);
        }
    }
}

/// A staged PDF ready to be committed at its destination.
pub struct PdfPublication {
    target: PathBuf,
    staged: publish::Staged,
    replace: Option<publish::Snapshot>,
}

/// Result of a committed publication. `retained_replaced`: after a confirmed replacement the previous file
/// could not be removed and is still in the destination directory under this (staging) file name.
#[derive(Debug)]
pub struct PdfPublished {
    pub published: Published,
    pub retained_replaced: Option<String>,
}

/// Stage `bytes` for `target` (from [`destination`]) outside any session lock.
/// - `expected` = `None`: the destination must not exist; it will be created without replacing anything
///   (`RENAME_NOREPLACE`).
/// - `expected` = the confirmed snapshot of a claimed grant: the destination must still be that regular file
///   (otherwise `FileConflict`, including a confirmed file that was deleted meanwhile — never turned into a
///   new-file publication). Verified staging (`publish::stage`: same owner, no hard link, no shared
///   file/directory, metadata kept).
/// - An existing file without a grant, symbolic links, directories and other non-regular files: `FileConflict`.
pub fn prepare_pdf(
    target: &Path,
    bytes: &[u8],
    expected: Option<publish::Snapshot>,
) -> Result<PdfPublication, DocumentError> {
    check_pdf_envelope(bytes)?;
    crate::document::resources::active()?;
    let staged = match (std::fs::symlink_metadata(target), expected) {
        (Ok(existing), Some(expected)) if existing.file_type().is_file() => {
            if publish::snapshot(&existing) != expected {
                return Err(DocumentError::FileConflict);
            }
            publish::stage(target, bytes)?
        }
        (Err(error), None) if error.kind() == std::io::ErrorKind::NotFound => {
            publish::stage_new(target, bytes, None)?
        }
        (Err(error), _) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err(DocumentError::SaveFailure {
                stage: SaveStage::Write,
                io: None,
            })
        }
        _ => return Err(DocumentError::FileConflict),
    };
    Ok(PdfPublication {
        target: target.to_path_buf(),
        staged,
        replace: expected,
    })
}

impl PdfPublication {
    /// The final atomic step only: create-only rename or identity-conditional exchange (with directory fsync).
    /// Meant to run inside [`crate::document::SessionRegistry::publish_for_current`].
    pub fn commit(mut self) -> Result<PdfPublished, DocumentError> {
        let target = self.target.clone();
        crate::document::resources::publication(|| match self.replace {
            None => publish::publish_new(&mut self.staged, &target).map(|published| PdfPublished {
                published,
                retained_replaced: None,
            }),
            Some(expected) => {
                publish::publish_exchange(&mut self.staged, &target, &expected).map(|outcome| {
                    PdfPublished {
                        published: outcome.published,
                        retained_replaced: outcome.retained_replaced,
                    }
                })
            }
        })
    }
}

/// Stage and commit without a session (tests and callers that own no document session).
#[cfg(test)]
pub fn publish_pdf(
    target: &Path,
    bytes: &[u8],
    expected: Option<publish::Snapshot>,
) -> Result<PdfPublished, DocumentError> {
    prepare_pdf(target, bytes, expected)?.commit()
}

/// Publish an export of `session_id` at `generation`/`revision` (both engines). The overwrite grant `grant`
/// (if any) is claimed first, the PDF is staged outside any lock, and the final atomic step runs inside
/// [`SessionRegistry::publish_for_current`]: a close, reload, failure or edit that reaches the registry first
/// refuses the publication; one that comes after it finds the PDF already committed.
#[allow(clippy::too_many_arguments)]
pub(crate) fn publish_session_pdf(
    registry: &crate::document::SessionRegistry,
    engine: crate::document::Engine,
    session_id: SessionId,
    generation: u64,
    revision: u64,
    target: &Path,
    bytes: &[u8],
    grant: Option<&str>,
) -> Result<PdfPublished, DocumentError> {
    let expected = claim_overwrite(
        grant,
        target,
        session_id,
        generation,
        std::time::Instant::now(),
    )?;
    let prepared = prepare_pdf(target, bytes, expected)?;
    #[cfg(test)]
    call_before_publication();
    registry.publish_for_current(session_id, engine, generation, revision, || {
        prepared.commit()
    })
}

#[cfg(test)]
thread_local! {
    /// Test hook: runs after staging, before the registry publication point (deterministic race injection).
    pub(crate) static BEFORE_PUBLICATION: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn call_before_publication() {
    BEFORE_PUBLICATION.with(|hook| {
        if let Some(hook) = hook.borrow().as_ref() {
            hook();
        }
    });
}

/// The RHWP session must be open, ready, of an RHWP format, at exactly this load generation and
/// committed revision (the frontend sends no uncommitted edits).
fn check_rhwp_session(
    registry: &crate::document::SessionRegistry,
    session_id: SessionId,
    generation: u64,
    revision: u64,
) -> Result<crate::document::SessionInfo, DocumentError> {
    use crate::document::{Engine, SessionState};
    let info = registry.get(session_id)?;
    if info.engine != Engine::Rhwp {
        return Err(DocumentError::InvalidRequest);
    }
    if info.load_generation != generation {
        return Err(DocumentError::StaleLoad {
            session_id,
            load_generation: info.load_generation,
        });
    }
    if info.state != SessionState::Ready {
        return Err(DocumentError::InvalidState {
            session_id,
            state: info.state,
        });
    }
    if info.revision != revision {
        return Err(DocumentError::RevisionMismatch {
            session_id,
            revision: info.revision,
        });
    }
    Ok(info)
}

/// `document_export_pdf`: raw `GPD1` frame of an RHWP session's page rasters (module docs).
#[tauri::command]
pub async fn document_export_pdf(
    state: tauri::State<'_, crate::document::commands::DocumentState>,
    request: tauri::ipc::Request<'_>,
) -> Result<PdfExported, DocumentError> {
    use crate::document::resources::Category;
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err(DocumentError::InvalidRequest);
    };
    if body.len() > FRAME_HEADER + MAX_META_BYTES + MAX_PAYLOAD_BYTES {
        return Err(DocumentError::ResourceLimit {
            limit: crate::document::LimitKind::FileSize,
        });
    }
    let pending = state.begin_open()?;
    pending.1.charge(Category::Ipc, body.len())?;
    pending.1.charge(Category::Payload, body.len())?;
    let body = body.clone();
    let registry = state.registry().clone();
    state
        .run_admitted(pending, move || {
            let request = parse_raster_request(&body)?;
            drop(body);
            let target = destination(&request.destination)?;
            let grant = request.overwrite_grant.as_deref();
            let checked = (|| {
                let info = check_rhwp_session(
                    &registry,
                    request.session_id,
                    request.generation,
                    request.revision,
                )?;
                let title = info
                    .display_name
                    .rsplit_once('.')
                    .map_or(info.display_name.as_str(), |(stem, _)| stem);
                raster_pdf(&request.pages, Some(title))
            })();
            let pdf =
                checked.inspect_err(|_| release_overwrite_grant(grant, request.session_id))?;
            let published = publish_session_pdf(
                &registry,
                crate::document::Engine::Rhwp,
                request.session_id,
                request.generation,
                request.revision,
                &target,
                &pdf,
                grant,
            )?;
            Ok(PdfExported {
                session_id: request.session_id,
                load_generation: request.generation,
                revision: request.revision,
                pages: request.pages.len(),
                bytes: pdf.len(),
                durable: published.published.durable,
                raster: true,
                retained_replaced: published.retained_replaced,
            })
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut out = Vec::new();
        let image = image::RgbaImage::from_fn(width, height, |x, y| {
            image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255])
        });
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    fn frame(destination: &str, pages: &[(f64, f64, u32, u32, Vec<u8>)]) -> Vec<u8> {
        let meta = serde_json::json!({
            "destination": destination,
            "overwriteGrant": null,
            "pages": pages.iter().map(|(w, h, pw, ph, data)| serde_json::json!({
                "widthPt": w, "heightPt": h, "pixelWidth": pw, "pixelHeight": ph, "length": data.len()
            })).collect::<Vec<_>>(),
        });
        let meta = serde_json::to_vec(&meta).unwrap();
        let mut body = Vec::new();
        body.extend_from_slice(FRAME_MAGIC);
        body.extend_from_slice(&7u64.to_le_bytes());
        body.extend_from_slice(&2u64.to_le_bytes());
        body.extend_from_slice(&5u64.to_le_bytes());
        body.extend_from_slice(&(meta.len() as u32).to_le_bytes());
        body.extend_from_slice(&meta);
        for page in pages {
            body.extend_from_slice(&page.4);
        }
        body
    }

    #[test]
    fn raster_frame_round_trips_to_a_pdf_with_one_page_per_raster() {
        // A4 at 96 px/in in points, rendered at scale 1 and 0.5.
        let a = png(794, 1123);
        let b = png(397, 562);
        let body = frame(
            "/tmp/x.pdf",
            &[(595.5, 842.25, 794, 1123, a), (595.5, 842.25, 397, 562, b)],
        );
        let request = parse_raster_request(&body).unwrap();
        assert_eq!(
            (request.session_id, request.generation, request.revision),
            (7, 2, 5)
        );
        assert_eq!(request.destination, "/tmp/x.pdf");
        assert_eq!(request.pages.len(), 2);
        let pdf = raster_pdf(&request.pages, Some("제목")).unwrap();
        assert!(pdf.starts_with(b"%PDF-"));
        let pretty = {
            // krilla compresses content streams but page dictionaries stay plain objects.
            String::from_utf8_lossy(&pdf).into_owned()
        };
        assert!(pretty.contains("/MediaBox"), "page boxes are written");
    }

    #[test]
    fn malformed_frames_and_rasters_are_refused() {
        let good = png(100, 141);
        let ok = |pages: &[(f64, f64, u32, u32, Vec<u8>)]| {
            parse_raster_request(&frame("/tmp/x.pdf", pages))
        };
        assert!(ok(&[(100.0, 141.0, 100, 141, good.clone())]).is_ok());
        // Signature-only / truncated PNG.
        let mut truncated = good.clone();
        truncated.truncate(good.len() / 2);
        truncated.extend_from_slice(b"\0\0\0\0IEND\xaeB`\x82");
        assert!(ok(&[(100.0, 141.0, 100, 141, truncated)]).is_err());
        let mut signature_only = b"\x89PNG\r\n\x1a\n".to_vec();
        signature_only.extend_from_slice(b"\0\0\0\0IEND\xaeB`\x82");
        assert!(ok(&[(100.0, 141.0, 100, 141, signature_only)]).is_err());
        // Declared size differs from the decoded raster.
        assert!(ok(&[(100.0, 141.0, 101, 141, good.clone())]).is_err());
        // Aspect ratio does not match the page (would stretch).
        assert!(ok(&[(100.0, 70.0, 100, 141, good.clone())]).is_err());
        // Non-finite / zero / oversized page sizes.
        for bad in [0.0, -1.0, f64::INFINITY, 20_000.0] {
            assert!(ok(&[(bad, 141.0, 100, 141, good.clone())]).is_err());
        }
        // Trailing bytes after the declared PNGs; no pages; bad magic; extra meta keys.
        let mut body = frame("/tmp/x.pdf", &[(100.0, 141.0, 100, 141, good.clone())]);
        body.push(0);
        assert!(parse_raster_request(&body).is_err());
        assert!(parse_raster_request(&frame("/tmp/x.pdf", &[])).is_err());
        let mut magic = frame("/tmp/x.pdf", &[(100.0, 141.0, 100, 141, good.clone())]);
        magic[3] = b'2';
        assert!(parse_raster_request(&magic).is_err());
        assert!(parse_raster_request(b"GPD1").is_err());
    }

    #[test]
    fn destinations_must_be_absolute_pdf_names_in_existing_directories() {
        let dir = std::env::temp_dir();
        let ok = dir.join("geul-export-test.PDF");
        assert_eq!(
            destination(ok.to_str().unwrap()).unwrap(),
            dir.canonicalize().unwrap().join("geul-export-test.PDF")
        );
        for bad in [
            "",
            "relative.pdf",
            "/tmp/doc.hwp",
            "/tmp/doc.docx",
            "/tmp/doc.hwpx",
            "/tmp/pdf",
            "/tmp/a.pdf\0x",
            "/nonexistent-geul-dir/a.pdf",
        ] {
            assert!(destination(bad).is_err(), "{bad:?} refused");
        }
        assert!(destination(&format!("/tmp/{}.pdf", "a".repeat(5000))).is_err());
    }

    #[cfg(target_os = "linux")]
    fn private_dir(tag: &str) -> PathBuf {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("geul-pdf-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .unwrap();
        dir
    }

    fn sample_pdf() -> Vec<u8> {
        raster_pdf(
            &[RasterPage {
                width_pt: 100.0,
                height_pt: 141.0,
                png: png(100, 141),
            }],
            None,
        )
        .unwrap()
    }

    /// Claim `token` for session 1 / generation 1 (the default owner in these tests).
    fn claim(
        token: &Option<String>,
        target: &Path,
    ) -> Result<Option<publish::Snapshot>, DocumentError> {
        claim_overwrite(token.as_deref(), target, 1, 1, std::time::Instant::now())
    }

    fn grant(target: &Path) -> Option<String> {
        issue_overwrite_grant(target.to_str().unwrap(), 1, 1)
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn new_names_are_created_only_and_existing_or_special_targets_need_a_claimed_grant() {
        let dir = private_dir("publish");
        let pdf = sample_pdf();
        let conflict = Some(DocumentError::FileConflict);
        let target = destination(dir.join("out.pdf").to_str().unwrap()).unwrap();
        publish_pdf(&target, &pdf, None).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), pdf);
        // Existing file without a claimed grant: refused, untouched.
        std::fs::write(&target, b"%PDF-old\n%%EOF").unwrap();
        assert_eq!(publish_pdf(&target, &pdf, None).err(), conflict);
        assert_eq!(std::fs::read(&target).unwrap(), b"%PDF-old\n%%EOF");
        let token = grant(&target);
        let expected = claim(&token, &target).unwrap();
        publish_pdf(&target, &pdf, expected).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), pdf);
        // Symbolic link and directory: refused (no grant is ever issued for them either).
        std::fs::write(dir.join("victim.hwp"), b"original").unwrap();
        let link = dir.join("link.pdf");
        std::os::unix::fs::symlink(dir.join("victim.hwp"), &link).unwrap();
        assert!(grant(&link).is_none());
        assert_eq!(publish_pdf(&link, &pdf, None).err(), conflict);
        assert_eq!(std::fs::read(dir.join("victim.hwp")).unwrap(), b"original");
        let folder = dir.join("folder.pdf");
        std::fs::create_dir_all(&folder).unwrap();
        assert!(grant(&folder).is_none());
        assert_eq!(publish_pdf(&folder, &pdf, None).err(), conflict);
        assert!(publish_pdf(&dir.join("bad.pdf"), b"not a pdf", None).is_err());
        assert!(!dir.join("bad.pdf").exists());
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 4, "{names:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn overwrite_grants_authorize_only_their_own_export() {
        let dir = private_dir("grant");
        let pdf = sample_pdf();
        let old: &[u8] = b"%PDF-1.7\nold\n%%EOF";
        let fresh = |name: &str| {
            let path = destination(dir.join(name).to_str().unwrap()).unwrap();
            std::fs::write(&path, old).unwrap();
            path
        };
        let conflict = Err(DocumentError::FileConflict);
        let now = std::time::Instant::now();

        // Tokens are unpredictable 128-bit values; none is issued for a missing path.
        let a = fresh("a.pdf");
        let token = grant(&a).unwrap();
        assert_eq!(token.len(), 32);
        assert_ne!(
            Some(token.clone()),
            grant(&a),
            "every confirmation gets its own token"
        );
        assert!(issue_overwrite_grant(dir.join("missing.pdf").to_str().unwrap(), 1, 1).is_none());

        // Another session, load generation or destination cannot consume it; it stays for its owner.
        let some = Some(token.clone());
        assert_eq!(claim_overwrite(some.as_deref(), &a, 2, 1, now), conflict);
        assert_eq!(claim_overwrite(some.as_deref(), &a, 1, 2, now), conflict);
        assert_eq!(
            claim_overwrite(some.as_deref(), &fresh("other.pdf"), 1, 1, now),
            conflict
        );
        release_overwrite_grant(some.as_deref(), 2); // another session cannot drop it either
        assert_eq!(
            claim_overwrite(Some("0123456789abcdef0123456789abcdef"), &a, 1, 1, now),
            conflict,
            "unknown token"
        );
        let expected = claim(&some, &a).unwrap();
        assert!(expected.is_some());
        assert_eq!(claim(&some, &a), conflict, "one use only");
        publish_pdf(&a, &pdf, expected).unwrap();

        // Expired: refused and removed.
        let b = fresh("b.pdf");
        let late = grant(&b);
        let after = now + OVERWRITE_GRANT_TTL + std::time::Duration::from_secs(5);
        assert_eq!(claim_overwrite(late.as_deref(), &b, 1, 1, after), conflict);
        assert_eq!(claim(&late, &b), conflict, "an expired grant is consumed");

        // A failed or refused export releases its own grant.
        let c = fresh("c.pdf");
        let released = grant(&c);
        release_overwrite_grant(released.as_deref(), 1);
        assert_eq!(claim(&released, &c), conflict);

        // Two overlapping exports confirmed for the same file: each holds its own token; the first
        // replacement changes the file, so the second one's confirmed identity no longer matches.
        let d = fresh("d.pdf");
        let (first, second) = (grant(&d), grant(&d));
        let (e1, e2) = (claim(&first, &d).unwrap(), claim(&second, &d).unwrap());
        publish_pdf(&d, &pdf, e1).unwrap();
        assert_eq!(
            publish_pdf(&d, &pdf, e2).err(),
            Some(DocumentError::FileConflict)
        );

        // A confirmed file deleted after confirmation is not turned into a new-file publication.
        let e = fresh("e.pdf");
        let confirmed = claim(&grant(&e), &e).unwrap();
        std::fs::remove_file(&e).unwrap();
        assert_eq!(
            publish_pdf(&e, &pdf, confirmed).err(),
            Some(DocumentError::FileConflict)
        );
        assert!(!e.exists());
        // …nor re-created, modified, renamed over, swapped for a symlink, or hard-linked.
        type Mutation = (&'static str, fn(&Path));
        let mutations: [Mutation; 5] = [
            ("recreated.pdf", |p| {
                std::fs::remove_file(p).unwrap();
                std::fs::write(p, b"%PDF-1.7\nold\n%%EOF").unwrap();
            }),
            ("modified.pdf", |p| {
                std::fs::write(p, b"%PDF-1.7\nchanged by someone\n%%EOF").unwrap()
            }),
            ("renamed.pdf", |p| {
                let t = p.with_extension("tmp");
                std::fs::write(&t, b"%PDF-1.7\nold\n%%EOF").unwrap();
                std::fs::rename(&t, p).unwrap();
            }),
            ("symlinked.pdf", |p| {
                std::fs::remove_file(p).unwrap();
                std::os::unix::fs::symlink("/dev/null", p).unwrap();
            }),
            ("linked.pdf", |p| {
                std::fs::hard_link(p, p.with_extension("link")).unwrap()
            }),
        ];
        for (name, mutate) in mutations {
            let path = fresh(name);
            let confirmed = claim(&grant(&path), &path).unwrap();
            mutate(&path);
            assert!(
                publish_pdf(&path, &pdf, confirmed).is_err(),
                "{name} must be refused"
            );
        }
        // A genuinely new destination still works without any grant.
        let n = destination(dir.join("new.pdf").to_str().unwrap()).unwrap();
        publish_pdf(&n, &pdf, None).unwrap();
        assert_eq!(std::fs::read(&n).unwrap(), pdf);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn exchange_races_are_rolled_back_and_failures_before_publication_keep_the_file() {
        use crate::services::save::publish::{Fault, BEFORE_RENAME, FAULT};
        let dir = private_dir("race");
        let pdf = sample_pdf();
        let old: &[u8] = b"%PDF-1.7\nold\n%%EOF";
        let fresh = |name: &str| {
            let path = destination(dir.join(name).to_str().unwrap()).unwrap();
            std::fs::write(&path, old).unwrap();
            path
        };
        // Failure before the exchange: destination untouched, staged file removed.
        let i = fresh("i.pdf");
        let expected = claim(&grant(&i), &i).unwrap();
        FAULT.with(|f| f.set(Some(Fault::Rename(std::io::ErrorKind::Other))));
        assert!(matches!(
            publish_pdf(&i, &pdf, expected),
            Err(DocumentError::SaveFailure { .. })
        ));
        FAULT.with(|f| f.set(None));
        assert_eq!(std::fs::read(&i).unwrap(), old);
        // Destination replaced, or written in place, after the final pre-check: swapped back.
        for (name, intruder) in [("j.pdf", true), ("k.pdf", false)] {
            let path = fresh(name);
            let expected = claim(&grant(&path), &path).unwrap();
            BEFORE_RENAME.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move |target: &Path, _staged: &Path| {
                    if intruder {
                        let tmp = target.with_file_name("race-intruder");
                        std::fs::write(&tmp, b"%PDF-1.7\nintruder\n%%EOF").unwrap();
                        std::fs::rename(&tmp, target).unwrap();
                    } else {
                        use std::io::Write;
                        std::fs::OpenOptions::new()
                            .append(true)
                            .open(target)
                            .unwrap()
                            .write_all(b"x")
                            .unwrap();
                    }
                }));
            });
            let raced = publish_pdf(&path, &pdf, expected);
            BEFORE_RENAME.with(|hook| *hook.borrow_mut() = None);
            assert_eq!(raced.err(), Some(DocumentError::FileConflict));
            let want: Vec<u8> = if intruder {
                b"%PDF-1.7\nintruder\n%%EOF".to_vec()
            } else {
                [old, b"x"].concat()
            };
            assert_eq!(std::fs::read(&path).unwrap(), want);
        }
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".geul-save-")
            })
            .count();
        assert_eq!(leftovers, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn exchange_cleanup_failure_is_reported_and_never_deletes_the_previous_file() {
        use crate::services::save::journal;
        use crate::services::save::publish::{Fault, FAULT};
        let dir = private_dir("cleanup");
        let journal_dir = dir.join("journal");
        journal::TEST_ROOT.with(|root| *root.borrow_mut() = Some(journal_dir.clone()));
        let docs = dir.join("docs");
        std::fs::create_dir(&docs).unwrap();
        std::fs::set_permissions(&docs, std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .unwrap();
        std::fs::write(docs.join("unrelated.txt"), b"keep me").unwrap();
        let pdf = sample_pdf();
        let old: &[u8] = b"%PDF-1.7\nprevious content\n%%EOF";
        let target = destination(docs.join("out.pdf").to_str().unwrap()).unwrap();
        std::fs::write(&target, old).unwrap();
        let records = || {
            std::fs::read_dir(&journal_dir)
                .map(|d| {
                    d.filter(|e| {
                        e.as_ref()
                            .unwrap()
                            .file_name()
                            .to_string_lossy()
                            .ends_with(".save")
                    })
                    .count()
                })
                .unwrap_or(0)
        };

        // Cleanup (unlink of the swapped-out file) fails after a successful exchange.
        let expected = claim(&grant(&target), &target).unwrap();
        FAULT.with(|f| f.set(Some(Fault::UnlinkReplaced)));
        let outcome = publish_pdf(&target, &pdf, expected);
        FAULT.with(|f| f.set(None));
        let outcome = outcome.expect("the PDF is published even though cleanup failed");
        assert_eq!(
            std::fs::read(&target).unwrap(),
            pdf,
            "the PDF is visible at the destination"
        );
        let retained = outcome
            .retained_replaced
            .clone()
            .expect("the retained file is reported");
        assert!(retained.starts_with(".geul-save-") && !retained.contains('/'));
        assert_eq!(
            std::fs::read(docs.join(&retained)).unwrap(),
            old,
            "the previous file is kept, not deleted"
        );
        assert_eq!(
            records(),
            1,
            "the ownership record is kept (released), not retired"
        );
        // A later cleanup pass finds a different inode under the recorded staging name: it retires the record
        // and keeps the file. Nothing unrelated is touched.
        let report = journal::cleanup();
        assert_eq!((report.removed, report.retired), (0, 1), "{report:?}");
        assert_eq!(std::fs::read(docs.join(&retained)).unwrap(), old);
        assert_eq!(
            std::fs::read(docs.join("unrelated.txt")).unwrap(),
            b"keep me"
        );
        assert_eq!(records(), 0);

        // Normal cleanup: the swapped-out file is removed and the record retired.
        std::fs::remove_file(docs.join(&retained)).unwrap();
        let expected = claim(&grant(&target), &target).unwrap();
        let outcome = publish_pdf(&target, &pdf, expected).unwrap();
        assert!(outcome.retained_replaced.is_none() && outcome.published.durable);
        assert_eq!(records(), 0);

        // Directory fsync failure after the exchange: published, reported as not durable.
        let expected = claim(&grant(&target), &target).unwrap();
        FAULT.with(|f| f.set(Some(Fault::DirSync)));
        let outcome = publish_pdf(&target, &pdf, expected);
        FAULT.with(|f| f.set(None));
        assert!(!outcome.unwrap().published.durable);
        let staging = std::fs::read_dir(&docs)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".geul-save-")
            })
            .count();
        assert_eq!(staging, 0);
        journal::TEST_ROOT.with(|root| *root.borrow_mut() = None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "linux")]
    fn rhwp_session(dir: &Path) -> (crate::document::SessionRegistry, SessionId) {
        let path = dir.join("doc.hwpx");
        std::fs::write(&path, crate::document::testutil::hwpx()).unwrap();
        let registry = crate::document::SessionRegistry::new(8);
        let file =
            crate::document::identify(path.to_str().unwrap(), &crate::document::Limits::default())
                .unwrap();
        let id = registry.register(file).unwrap().session_id;
        registry.begin_load(id).unwrap();
        registry
            .transition(
                id,
                1,
                crate::document::SessionState::Loading,
                crate::document::SessionState::Ready,
            )
            .unwrap();
        (registry, id)
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rhwp_publication_is_linearized_with_session_changes_at_the_registry() {
        use crate::document::{Engine, SessionState};
        let dir = private_dir("linearize");
        let pdf = sample_pdf();
        let out = |name: &str| destination(dir.join(name).to_str().unwrap()).unwrap();
        let publish = |registry: &crate::document::SessionRegistry, id, gen, rev, target: &Path| {
            publish_session_pdf(registry, Engine::Rhwp, id, gen, rev, target, &pdf, None)
        };
        let (registry, id) = rhwp_session(&dir);

        // The publication runs while the registry lock is held (no close/reload/commit can interleave).
        let target = out("current.pdf");
        let probe = std::cell::Cell::new(false);
        registry
            .publish_for_current(id, Engine::Rhwp, 1, 0, || {
                probe.set(registry.locked());
                Ok(())
            })
            .unwrap();
        assert!(probe.get(), "publication point holds the registry lock");
        publish(&registry, id, 1, 0, &target).unwrap();

        // Invalidation after staging, before the publication point (deterministic hook): refused, no file.
        type Invalidation = (
            &'static str,
            fn(&crate::document::SessionRegistry, SessionId),
        );
        let cases: [Invalidation; 3] = [
            ("edited.pdf", |r, id| {
                r.commit(id, 1, 0, 1).unwrap();
            }),
            ("failed.pdf", |r, id| {
                r.transition(id, 1, SessionState::Ready, SessionState::Failed)
                    .unwrap();
            }),
            ("closed.pdf", |r, id| {
                r.close(id).unwrap();
            }),
        ];
        for (name, invalidate) in cases {
            let (registry, id) = rhwp_session(&dir);
            let target = out(name);
            let shared = std::rc::Rc::new(registry);
            let hook_registry = shared.clone();
            BEFORE_PUBLICATION.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move || invalidate(&hook_registry, id)))
            });
            let result = publish(&shared, id, 1, 0, &target);
            BEFORE_PUBLICATION.with(|hook| *hook.borrow_mut() = None);
            assert!(result.is_err(), "{name}: {result:?}");
            assert!(!target.exists(), "{name}: nothing published");
            let staging = std::fs::read_dir(&dir)
                .unwrap()
                .filter(|e| {
                    e.as_ref()
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".geul-save-")
                })
                .count();
            assert_eq!(staging, 0, "{name}: staged file removed");
        }
        // Reload (new load generation) before the publication point.
        let (registry, id) = rhwp_session(&dir);
        registry
            .transition(id, 1, SessionState::Ready, SessionState::Failed)
            .unwrap();
        registry.begin_load(id).unwrap();
        registry
            .transition(id, 2, SessionState::Loading, SessionState::Ready)
            .unwrap();
        let target = out("reloaded.pdf");
        assert!(matches!(
            publish(&registry, id, 1, 0, &target),
            Err(DocumentError::StaleLoad {
                load_generation: 2,
                ..
            })
        ));
        assert!(!target.exists());
        // Wrong engine.
        assert_eq!(
            registry.publish_for_current(id, Engine::Wordcraft, 2, 0, || Ok(())),
            Err(DocumentError::InvalidRequest)
        );

        // A change ordered after the publication point does not invalidate the committed PDF, and PDF export
        // never changes the session record (revision, dirty, sequence).
        let (registry, id) = rhwp_session(&dir);
        let before = registry.get(id).unwrap();
        let target = out("committed.pdf");
        publish(&registry, id, 1, 0, &target).unwrap();
        assert_eq!(registry.get(id).unwrap(), before);
        registry.commit(id, 1, 0, 1).unwrap();
        registry.close(id).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), pdf);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
