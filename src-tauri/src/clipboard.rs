//! Linux WebKitGTK denies async reads of native/external clipboard ownership
//! even from a trusted ribbon click. Expose bounded text and geul MIME
//! transport without granting access to other clipboard formats.

#[cfg(any(target_os = "linux", test))]
const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;

#[cfg(any(target_os = "linux", test))]
fn bounded_text(text: Option<&str>) -> Result<String, &'static str> {
    let text = text.unwrap_or("");
    if text.len() > MAX_TEXT_BYTES || text.chars().count() > 1024 * 1024 {
        return Err("TooLarge");
    }
    Ok(text.to_owned())
}

#[tauri::command]
pub async fn clipboard_read_text(app: tauri::AppHandle) -> Result<String, &'static str> {
    #[cfg(target_os = "linux")]
    {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        // GTK APIs belong to the UI thread. request_text is asynchronous: an
        // unresponsive external clipboard owner must never block that thread.
        // Resource bound (P3-B): GTK3 offers no streaming or size-limited
        // selection transfer; GDK receives the owner's whole payload (including
        // X11 INCR transfers) and converts it to UTF-8 before this callback runs.
        // `bounded_text` limits what the application keeps and uses, not that
        // transient GTK allocation, which is released when the callback returns.
        app.run_on_main_thread(move || {
            gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).request_text(move |_, text| {
                let _ = send.try_send(bounded_text(text));
            });
        })
        .map_err(|_| "Unavailable")?;
        tauri::async_runtime::spawn_blocking(move || {
            receive
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap_or(Err("Unavailable"))
        })
        .await
        .map_err(|_| "Unavailable")?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Err("Unsupported")
    }
}

#[cfg(any(target_os = "linux", test))]
fn structured_limit(mime: &str) -> Result<usize, &'static str> {
    match mime {
        "application/x-geul-object+json" => Ok(12 * 1024 * 1024),
        "application/x-geul-table-cells+json" => Ok(2 * 1024 * 1024),
        _ => Err("UnsupportedFormat"),
    }
}

#[tauri::command]
pub async fn clipboard_read_structured(
    app: tauri::AppHandle,
    mime: String,
) -> Result<Option<String>, &'static str> {
    #[cfg(target_os = "linux")]
    {
        let limit = structured_limit(&mime)?;
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let target = gtk::gdk::Atom::intern(&mime);
            gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).request_contents(
                &target,
                move |_, selection| {
                    let result = if selection.length() < 0 {
                        Ok(None)
                    } else if selection.length() as usize > limit {
                        Err("TooLarge")
                    } else if selection.format() != 8 || selection.data_type() != target {
                        Err("InvalidData")
                    } else {
                        String::from_utf8(selection.data())
                            .map(Some)
                            .map_err(|_| "InvalidData")
                    };
                    let _ = send.try_send(result);
                },
            );
        })
        .map_err(|_| "Unavailable")?;
        tauri::async_runtime::spawn_blocking(move || {
            receive
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap_or(Err("Unavailable"))
        })
        .await
        .map_err(|_| "Unavailable")?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, mime);
        Err("Unsupported")
    }
}

#[tauri::command]
pub async fn clipboard_write_structured(
    app: tauri::AppHandle,
    mime: String,
    data: String,
    plain_text: String,
) -> Result<(), &'static str> {
    #[cfg(target_os = "linux")]
    {
        if data.len() > structured_limit(&mime)? {
            return Err("TooLarge");
        }
        if data.is_empty()
            || plain_text.is_empty()
            || data.contains('\0')
            || plain_text.contains('\0')
        {
            return Err("InvalidData");
        }
        let plain_text = bounded_text(Some(&plain_text))?;
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
            let targets = [
                gtk::TargetEntry::new(&mime, gtk::TargetFlags::empty(), 0),
                gtk::TargetEntry::new("UTF8_STRING", gtk::TargetFlags::empty(), 1),
                gtk::TargetEntry::new("text/plain;charset=utf-8", gtk::TargetFlags::empty(), 1),
                gtk::TargetEntry::new("text/plain", gtk::TargetFlags::empty(), 1),
            ];
            let atom = gtk::gdk::Atom::intern(&mime);
            let offered = clipboard.set_with_data(&targets, move |_, selection, info| {
                if info == 0 {
                    selection.set(&atom, 8, data.as_bytes());
                } else {
                    selection.set_text(&plain_text);
                }
            });
            let _ = send.try_send(offered.then_some(()).ok_or("Unavailable"));
        })
        .map_err(|_| "Unavailable")?;
        tauri::async_runtime::spawn_blocking(move || {
            receive
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap_or(Err("Unavailable"))
        })
        .await
        .map_err(|_| "Unavailable")?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, mime, data, plain_text);
        Err("Unsupported")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_clipboard_accepts_only_bounded_geul_formats() {
        assert_eq!(
            structured_limit("application/x-geul-object+json"),
            Ok(12 * 1024 * 1024)
        );
        assert_eq!(
            structured_limit("application/x-geul-table-cells+json"),
            Ok(2 * 1024 * 1024)
        );
        assert_eq!(structured_limit("text/html"), Err("UnsupportedFormat"));
        assert_eq!(structured_limit("image/png"), Err("UnsupportedFormat"));
    }

    #[test]
    fn plain_text_is_complete_and_empty_is_not_an_error() {
        assert_eq!(bounded_text(None), Ok(String::new()));
        let text = format!("{}\n끝\t", "한😀글".repeat(300));
        assert_eq!(bounded_text(Some(&text)), Ok(text));
    }

    #[test]
    fn exact_scalar_and_byte_boundaries() {
        // 1,048,576 scalars is accepted; one more is refused.
        let scalars = "a".repeat(1024 * 1024);
        assert_eq!(
            bounded_text(Some(&scalars)).map(|t| t.len()),
            Ok(scalars.len())
        );
        assert_eq!(bounded_text(Some(&format!("{scalars}a"))), Err("TooLarge"));
        // 1,048,576 four-byte scalars is exactly 4 MiB: accepted. One more byte is
        // refused before any scalar counting.
        let bytes = "😀".repeat(1024 * 1024);
        assert_eq!(bytes.len(), MAX_TEXT_BYTES);
        assert_eq!(
            bounded_text(Some(&bytes)).map(|t| t.len()),
            Ok(MAX_TEXT_BYTES)
        );
        assert_eq!(bounded_text(Some(&format!("{bytes}a"))), Err("TooLarge"));
    }

    #[test]
    fn oversized_clipboard_is_refused_without_truncation() {
        assert_eq!(
            bounded_text(Some(&"a".repeat(1024 * 1024 + 1))),
            Err("TooLarge")
        );
        assert_eq!(
            bounded_text(Some(&"😀".repeat(1024 * 1024 + 1))),
            Err("TooLarge")
        );
    }
}
