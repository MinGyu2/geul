//! Linux WebKitGTK denies async reads of native/external clipboard ownership
//! even from a trusted ribbon click. Expose only bounded plain-text reading;
//! no formats, paths, shell access or document operations cross this endpoint.

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

#[cfg(test)]
mod tests {
    use super::*;

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
