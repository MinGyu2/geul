//! Native CloseRequested는 WebView가 파괴되기 전에 취소한다. 프런트엔드가 모든 문서를 확인한 뒤에만 destroy한다.
//! JS가 준비되지 않았거나 이벤트 전송이 실패해도 창은 남는다. force-kill/crash/power loss는 다루지 않는다.
use tauri::{Emitter, Window, WindowEvent};

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.emit("geul-close-requested", ());
    }
}

#[tauri::command]
pub fn window_close_confirmed(window: Window) -> Result<(), String> {
    // close()는 다시 CloseRequested를 만들어 재귀한다. destroy()는 그 이벤트 없이 이 창만 종료한다.
    window.destroy().map_err(|_| "window close failed".into())
}
