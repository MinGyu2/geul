import { useEffect, useRef } from "react";
import { serializeSettings, type Settings, type SettingsStore } from "./settings";

/**
 * 저장하지 못한 이유.
 * - failed: 쓰기 실패, 또는 쓰기 전 확인에서 저장소를 읽지 못함(쓰지 않음). 다음 변경 때 다시 시도한다.
 * - conflict: 저장소 값이 이 앱이 마지막으로 확인한 값과 달라짐(다른 인스턴스·외부 도구). 이번 실행 동안 쓰지 않는다.
 * - blocked: 시작할 때부터 쓰지 않는 상태(미지원 버전·읽기 실패, canPersist)이거나 충돌 뒤의 변경.
 */
export type NotSavedReason = "failed" | "conflict" | "blocked";

interface PersistOptions {
  /** 시작할 때 저장소에 있던 그대로의 값(loadSettings의 raw). 처음 값만 쓴다. */
  baseline: string | null;
  /** false면 처음부터 쓰지 않는다(canPersist). 처음 값만 쓴다. */
  enabled: boolean;
  /** 저장되지 않은 구간이 시작될 때 한 번, 충돌은 생길 때 한 번 부른다. */
  onNotSaved: (reason: NotSavedReason) => void;
  /** 저장되지 않은 구간 뒤 현재 설정이 실제로 저장소에 있게 됐을 때 부른다. */
  onRecovered: () => void;
}

/**
 * 설정이 바뀔 때만 저장한다. 처음 그릴 때는 쓰지 않는다(저장소의 기존 값을 기본값으로 덮어쓰지 않음).
 *
 * 저장소에 있다고 확인한 값(baseline: 시작 시 읽은 원문, 이후 쓰기에 성공한 값)과 화면의 현재 설정을 따로 둔다.
 * 시작할 때 보정·기본값으로 바꾼 설정은 저장소에 없으므로, 그 값으로 돌아와도 저장된 것으로 보지 않는다.
 * 쓰기 전에 저장소를 다시 읽어 baseline과 다르면 충돌로 보고 쓰지 않는다. 읽은 값이 이미 현재 설정과 같으면
 * 쓰지 않고 저장된 것으로 본다.
 *
 * 한계: localStorage에는 비교 후 쓰기(compare-and-swap)가 없어, 다시 읽은 뒤 쓰기 전 사이의 외부 변경은 막지
 * 못한다. 또 WebKitGTK에서는 동시에 실행 중인 다른 geul 프로세스의 변경이 이 프로세스의 localStorage에 보이지
 * 않아 감지하지 못한다(tasks.md T005 2차 안정화 기록).
 */
export function usePersistedSettings(store: SettingsStore, settings: Settings, options: PersistOptions): void {
  const { onNotSaved, onRecovered } = options;
  const serialized = serializeSettings(settings);
  const baseline = useRef(options.baseline);
  const handled = useRef(serialized); // 마지막으로 처리한 설정. 처음 그린 값은 처리하지 않는다.
  const blocked = useRef(!options.enabled);
  const notSaved = useRef(false); // 화면 설정 중 저장소에 없는 변경이 있고 이미 알렸는가

  useEffect(() => {
    if (serialized === handled.current) return; // 다시 그리기·StrictMode의 효과 재실행
    handled.current = serialized;

    const save = (): "saved" | NotSavedReason => {
      if (blocked.current) return "blocked";
      let current: string | null;
      try {
        current = store.read();
      } catch {
        return "failed"; // 지금 저장소 내용을 모르면 쓰지 않는다
      }
      if (current !== baseline.current) {
        blocked.current = true;
        return "conflict";
      }
      if (current === serialized) return "saved";
      if (!store.write(serialized)) return "failed";
      baseline.current = serialized;
      return "saved";
    };

    const outcome = save();
    if (outcome === "saved") {
      if (notSaved.current) {
        notSaved.current = false;
        onRecovered();
      }
    } else if (outcome === "conflict" || !notSaved.current) {
      notSaved.current = true;
      onNotSaved(outcome);
    }
  }, [serialized, store, onNotSaved, onRecovered]);
}
