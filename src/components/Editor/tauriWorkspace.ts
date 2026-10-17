// 앱(Tauri WebView) 안에서만 문서 세션 작업 공간을 만든다. 브라우저·테스트(jsdom)에는 IPC가 없으므로 null.
//
// Tauri 2의 `window.__TAURI_INTERNALS__.invoke`는 @tauri-apps/api `core.invoke`가 감싸는 함수와 같다. 의존성을 늘리지
// 않으려고 직접 쓴다(npm 패키지 추가 없음). 권한은 capabilities/default.json의 문서 명령만 허용된다.
import { createTauriBackend, type Invoke } from "../../adapters/backend";
import { DocumentSessions } from "../../adapters/sessions";
import { DocumentWorkspace } from "./documentWorkspace";

interface TauriInternals {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export function createTauriWorkspace(): DocumentWorkspace | null {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (typeof internals?.invoke !== "function") return null;
  const invoke: Invoke = (command, args) => internals.invoke(command, args);
  const backend = createTauriBackend(invoke);
  return new DocumentWorkspace(new DocumentSessions(backend), backend);
}
