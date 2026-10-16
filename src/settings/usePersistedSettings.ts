import { useEffect, useRef } from "react";
import { serializeSettings, type Settings, type SettingsStore } from "./settings";

interface PersistOptions {
  /** false면 쓰지 않는다: 미지원 버전·읽지 못한 저장값을 지켜야 할 때(canPersist). 바뀐 설정은 저장되지 않은 것으로 본다. */
  enabled: boolean;
  /** 저장되지 않은 구간이 시작될 때 한 번 부른다(쓰기 실패, 또는 enabled가 false인데 설정이 바뀜). */
  onNotSaved: () => void;
  /** 저장되지 않은 구간 뒤 다시 저장에 성공했거나 마지막 저장값으로 돌아왔을 때 부른다. */
  onRecovered: () => void;
}

/**
 * 설정이 바뀔 때만 저장한다. 처음 그릴 때는 쓰지 않는다: 시작 시점의 값은 저장소에서 읽은 값(또는 그 값을
 * 검사해 보정한 값)이므로 기본값으로 덮어써 기존 설정을 잃는 일이 없다. 같은 직렬화 결과는 다시 쓰지 않는다
 * (패널을 끄는 중에는 바뀐 너비마다 한 번씩 쓴다 — 작은 문자열이며 비정상 종료에도 마지막 값이 남는다).
 * 실패가 이어지는 동안에는 바뀔 때마다 다시 시도하되 알림은 한 번만 보낸다.
 */
export function usePersistedSettings(store: SettingsStore, settings: Settings, options: PersistOptions): void {
  const { enabled, onNotSaved, onRecovered } = options;
  const serialized = serializeSettings(settings);
  const lastWritten = useRef(serialized);
  const notSaved = useRef(false);

  useEffect(() => {
    let saved: boolean;
    if (serialized === lastWritten.current) {
      // 마지막으로 저장한 값과 같다: 저장되지 않은 변경이 없다. 단 쓰지 않는 상태에서는 저장소에 다른 값(미지원
      // 버전 등)이 남아 있으므로 회복으로 보지 않는다. 처음 그릴 때도 여기서 끝난다(쓰기 없음).
      if (!enabled || !notSaved.current) return;
      saved = true;
    } else {
      saved = enabled && store.write(serialized);
      if (saved) lastWritten.current = serialized;
    }
    if (saved && notSaved.current) {
      notSaved.current = false;
      onRecovered();
    } else if (!saved && !notSaved.current) {
      notSaved.current = true;
      onNotSaved();
    }
  }, [serialized, store, enabled, onNotSaved, onRecovered]);
}
