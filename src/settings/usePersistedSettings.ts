import { useEffect, useRef } from "react";
import { serializeSettings, type Settings, type SettingsStore } from "./settings";

/**
 * 설정이 바뀔 때만 저장한다. 처음 그릴 때는 쓰지 않는다: 시작 시점의 값은 저장소에서 읽은 값(또는 그 값을
 * 검사해 보정한 값)이므로 기본값으로 덮어써 기존 설정을 잃는 일이 없다. 같은 직렬화 결과는 다시 쓰지 않는다
 * (패널을 끄는 중에는 바뀐 너비마다 한 번씩 쓴다 — 작은 문자열이며 비정상 종료에도 마지막 값이 남는다).
 */
export function usePersistedSettings(store: SettingsStore, settings: Settings, onWriteFailed: () => void): void {
  const serialized = serializeSettings(settings);
  const lastWritten = useRef(serialized);
  const failureReported = useRef(false);

  useEffect(() => {
    if (serialized === lastWritten.current) return;
    if (store.write(serialized)) {
      lastWritten.current = serialized;
      failureReported.current = false;
    } else if (!failureReported.current) {
      failureReported.current = true;
      onWriteFailed();
    }
  }, [serialized, store, onWriteFailed]);
}
