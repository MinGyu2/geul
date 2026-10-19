// 앱(Tauri WebView) 안에서만 문서 세션 작업 공간을 만든다. 브라우저·테스트(jsdom)에는 IPC가 없으므로 null.
//
// Tauri 2의 `window.__TAURI_INTERNALS__.invoke`는 @tauri-apps/api `core.invoke`가 감싸는 함수와 같아 문서 IPC는
// 직접 쓴다. 창 닫기에는 공식 event API를 사용한다. 권한은 capabilities/default.json의 문서 명령·창 종료 확인에 한정한다.
import { createTauriBackend, type Invoke } from "../../adapters/backend";
import { createDocxBackend } from "../../adapters/docx";
import { DocumentSessions } from "../../adapters/sessions";
import { DocumentWorkspace } from "./documentWorkspace";
import { tauriWindowClose } from "./windowClose";

interface TauriInternals {
  /** args가 Uint8Array면 원시 요청 본문으로 보낸다(Tauri 2 IPC, 저장 요청 T009). */
  invoke: (command: string, args?: Record<string, unknown> | Uint8Array) => Promise<unknown>;
}

export function createTauriWorkspace(): DocumentWorkspace | null {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (typeof internals?.invoke !== "function") return null;
  const invoke: Invoke = (command, args) => internals.invoke(command, args);
  const backend = createTauriBackend(invoke);
  return new DocumentWorkspace(new DocumentSessions(backend), backend, undefined, tauriWindowClose, createDocxBackend(invoke));
}
