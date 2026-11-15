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
/// `{"destination": string, "pages": [{"widthPt", "heightPt", "pixelWidth", "pixelHeight", "length"}...]}`;
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
        .filter(|o| o.len() == 2)
        .ok_or(DocumentError::InvalidRequest)?;
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

/// Publish `bytes` at `target` (from [`destination`]). A missing name is created without replacing
/// anything; an existing regular file is replaced atomically after verified staging. Symbolic links,
/// directories and other non-regular files are refused (`FileConflict`) and left untouched.
pub fn publish_pdf(target: &Path, bytes: &[u8]) -> Result<Published, DocumentError> {
    check_pdf_envelope(bytes)?;
    crate::document::resources::active()?;
    match std::fs::symlink_metadata(target) {
        Ok(existing) if existing.file_type().is_file() => {
            let mut staged = publish::stage(target, bytes)?;
            crate::document::resources::publication(|| publish::publish(&mut staged, target))
        }
        Ok(_) => Err(DocumentError::FileConflict),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut staged = publish::stage_new(target, bytes, None)?;
            crate::document::resources::publication(|| publish::publish_new(&mut staged, target))
        }
        Err(_) => Err(DocumentError::SaveFailure {
            stage: SaveStage::Write,
            io: None,
        }),
    }
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
            let info = check_rhwp_session(
                &registry,
                request.session_id,
                request.generation,
                request.revision,
            )?;
            let target = destination(&request.destination)?;
            let title = info
                .display_name
                .rsplit_once('.')
                .map_or(info.display_name.as_str(), |(stem, _)| stem);
            let pdf = raster_pdf(&request.pages, Some(title))?;
            // The session may have been closed or reloaded meanwhile: only publish for the same state.
            check_rhwp_session(
                &registry,
                request.session_id,
                request.generation,
                request.revision,
            )?;
            let published = publish_pdf(&target, &pdf)?;
            Ok(PdfExported {
                session_id: request.session_id,
                load_generation: request.generation,
                revision: request.revision,
                pages: request.pages.len(),
                bytes: pdf.len(),
                durable: published.durable,
                raster: true,
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
    #[test]
    fn publication_creates_replaces_and_refuses_links_without_partial_output() {
        // A private directory: the protected test sandbox's /tmp is a shared 1777 tmpfs, which publication
        // correctly refuses (`shared-directory`).
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("geul-pdf-publish-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .unwrap();
        let pdf = raster_pdf(
            &[RasterPage {
                width_pt: 100.0,
                height_pt: 141.0,
                png: png(100, 141),
            }],
            None,
        )
        .unwrap();
        let target = destination(dir.join("out.pdf").to_str().unwrap()).unwrap();
        let _ = std::fs::remove_file(&target);
        publish_pdf(&target, &pdf).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), pdf);
        // Replace an existing regular file atomically.
        std::fs::write(&target, b"%PDF-old\n%%EOF").unwrap();
        publish_pdf(&target, &pdf).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), pdf);
        // A symbolic link destination is refused and its target untouched.
        let victim = dir.join("victim.hwp");
        std::fs::write(&victim, b"original").unwrap();
        let link = dir.join("link.pdf");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&victim, &link).unwrap();
        assert_eq!(
            publish_pdf(&link, &pdf).err(),
            Some(DocumentError::FileConflict)
        );
        assert_eq!(std::fs::read(&victim).unwrap(), b"original");
        // A directory named *.pdf is refused.
        let folder = dir.join("folder.pdf");
        std::fs::create_dir_all(&folder).unwrap();
        assert_eq!(
            publish_pdf(&folder, &pdf).err(),
            Some(DocumentError::FileConflict)
        );
        // Non-PDF bytes are never published.
        assert!(publish_pdf(&dir.join("bad.pdf"), b"not a pdf").is_err());
        assert!(!dir.join("bad.pdf").exists());
        // No staging leftovers.
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 4, "{names:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
