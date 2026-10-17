import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Rust가 native CloseRequested를 동기적으로 취소한 뒤 보내는 통지. 미등록/등록 실패 시에도 창은 보호된다. */
export interface WindowClosePort {
  listen(handler: () => void): Promise<() => void>;
  close(): Promise<void>;
}

export const tauriWindowClose: WindowClosePort = {
  listen: handler => listen("geul-close-requested", handler),
  close: () => invoke("window_close_confirmed"),
};
