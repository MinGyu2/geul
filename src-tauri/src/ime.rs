//! Linux WebView의 IME 조합 문자열(preedit)을 페이지로 보내게 한다(T007 한국어 IME).
//!
//! wry 0.57.0은 WebKitGTK WebView를 만들 때마다 `set_enable_preedit(false)`를 호출한다(`src/webkitgtk/mod.rs`).
//! 그러면 입력기가 조합 문자열을 자기 창에만 보이고 페이지에는 확정만 보낸다: compositionstart·compositionupdate가
//! 없고, 조합만 바꾸는 키는 keydown도 없으며, 조합 중 클릭에서 입력기가 확정한 음절이 사라진다. 같은 WebKitGTK
//! 2.54.1을 tao/wry 없이 띄운 탐침에서 이 호출 하나로 같은 실패가 재현되고, 호출하지 않으면(WebKitGTK 기본값)
//! 조합 이벤트와 조합 중 클릭 확정이 정상으로 온다(editor-surface-decision.md "T007 IME 원인 규명").
//!
//! 페이지 로드마다 WebKitGTK 기본값(preedit 사용)으로 되돌린다. 입력기·키 이벤트는 바꾸지 않고, 편집 표면은
//! 표준 DOM 조합 이벤트만 받는다(이벤트를 만들거나 번역하지 않음). 다른 플랫폼은 해당 없음.
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{Runtime, Webview};

pub fn on_page_load<R: Runtime>(webview: &Webview<R>, payload: &PageLoadPayload<'_>) {
    if payload.event() == PageLoadEvent::Started {
        enable_preedit(webview);
    }
}

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
fn enable_preedit<R: Runtime>(webview: &Webview<R>) {
    use webkit2gtk::{InputMethodContextExt, WebViewExt};
    // 실패하면(WebView가 이미 사라짐) 할 일이 없다. 입력 자체는 preedit 없이 계속 동작한다.
    let _ = webview.with_webview(|platform| {
        if let Some(context) = platform.inner().input_method_context() {
            context.set_enable_preedit(true);
        }
    });
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
)))]
fn enable_preedit<R: Runtime>(_webview: &Webview<R>) {}
