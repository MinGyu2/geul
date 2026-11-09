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
