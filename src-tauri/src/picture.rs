//! A native chooser owns the path. No frontend-supplied path can be read.
use crate::document::DocumentError;
use image::{ImageFormat, ImageReader, Limits};
use std::io::{Cursor, Read};
pub const MAX_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 16 * 1024 * 1024;

pub fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return None;
    }
    let Ok(mut reader) = ImageReader::new(Cursor::new(bytes)).with_guessed_format() else {
        return None;
    };
    if !matches!(reader.format(), Some(ImageFormat::Png | ImageFormat::Jpeg)) {
        return None;
    }
    if reader.format() == Some(ImageFormat::Jpeg) && !bytes.ends_with(b"\xff\xd9") {
        return None;
    }
    if reader.format() == Some(ImageFormat::Png) && !bytes.ends_with(b"\0\0\0\0IEND\xaeB`\x82") {
        return None;
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let Ok((w, h)) = ImageReader::with_format(
        Cursor::new(bytes),
        reader.format().unwrap_or(ImageFormat::Png),
    )
    .into_dimensions() else {
        return None;
    };
    if w == 0 || h == 0 || u64::from(w) * u64::from(h) > MAX_PIXELS {
        return None;
    }
    reader.decode().ok().map(|_| (w, h))
}

pub fn valid(bytes: &[u8]) -> bool {
    dimensions(bytes).is_some()
}

#[derive(serde::Serialize)]
pub struct ImportedPicture {
    data: String,
    width: u32,
    height: u32,
}

fn read_picture(path: &std::path::Path) -> Result<ImportedPicture, DocumentError> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|_| DocumentError::InvalidRequest)?;
    let meta = file.metadata().map_err(|_| DocumentError::InvalidRequest)?;
    if !meta.is_file() || meta.len() > MAX_BYTES as u64 {
        return Err(DocumentError::InvalidRequest);
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| DocumentError::InvalidRequest)?;
    let (width, height) = dimensions(&bytes).ok_or(DocumentError::InvalidRequest)?;
    Ok(ImportedPicture {
        data: wordcraft_engine::cmd::insert::base64_encode(&bytes),
        width,
        height,
    })
}

#[tauri::command]
pub async fn picture_import(
    window: tauri::WebviewWindow,
    title: String,
    accept: String,
    cancel: String,
) -> Result<Option<ImportedPicture>, DocumentError> {
    #[cfg(target_os = "linux")]
    {
        let path = crate::services::files::document_file_dialog(
            window,
            "open".into(),
            Some("image".into()),
            title,
            accept,
            cancel,
        )
        .await?;
        let Some(path) = path else {
            return Ok(None);
        };
        tauri::async_runtime::spawn_blocking(move || {
            read_picture(std::path::Path::new(&path)).map(Some)
        })
        .await
        .map_err(|_| DocumentError::Internal)?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, title, accept, cancel);
        Err(DocumentError::InvalidRequest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn core_picture_validates_encoded_content_and_budgets() {
        for format in [ImageFormat::Png, ImageFormat::Jpeg] {
            let mut out = Cursor::new(Vec::new());
            image::DynamicImage::new_rgb8(3, 2)
                .write_to(&mut out, format)
                .unwrap();
            assert!(valid(out.get_ref()));
            assert!(!valid(&out.get_ref()[..out.get_ref().len() / 2]));
        }
        assert!(!valid(b"not an image.png"));
        assert!(!valid(&vec![0; MAX_BYTES + 1]));
        let mut out = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(8193, 1)
            .write_to(&mut out, ImageFormat::Png)
            .unwrap();
        assert!(!valid(out.get_ref()));
        let dir = crate::document::testutil::TempDir::new();
        assert!(read_picture(dir.path()).is_err());
    }
}
