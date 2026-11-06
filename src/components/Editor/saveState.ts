// 편집 세션의 저장 상태(T009, 화면 표시). rhwp·WordCraft 편집 세션이 함께 쓴다. 저장 판정·교체는 백엔드가 하고
// (src-tauri/src/services/save/), 이 상태는 마지막 저장 시도의 결과를 투영할 뿐이다.
import type { DocumentError, SaveCheck } from "../../adapters/contract";

export type SaveState =
  | { kind: "idle" }
  /** 보존 사전 검사 중. */
  | { kind: "checking" }
  /** 내보내기·검사·교체 중. */
  | { kind: "saving" }
  /** 저장함. changedSince: 저장한 판 뒤에 편집이 더 있다(그 편집은 아직 저장하지 않음). */
  | { kind: "saved"; revision: number; durable: boolean; changedSince: boolean }
  | { kind: "failed"; error: DocumentError };

/** 사전 검사 결과와 그것을 받은 불러오기 시도(다시 불러오면 버린다). */
export interface SaveCheckRecord {
  generation: number;
  check: SaveCheck;
}

/**
 * 끝을 기다리지 않는 저장 호출(명령·단추)의 거부를 받는 곳. 사용자에게 보일 결과는 세션의 저장 상태가 이미 가지므로 여기서 다시
 * 알리지 않고, 원인을 숨기지 않게 기록만 남긴다. `save()`를 직접 기다리는 호출은 거부를 그대로 받는다.
 */
export function reportDetachedSaveRejection(reason: unknown): void {
  console.error("detached document save rejected", reason);
}

/** 사전 검사가 저장을 허용하지 않으면 그 오류(아니면 null). */
export function blockedBy(check: SaveCheck): DocumentError | null {
  if (check.preservation.outcome !== "safe") return { code: "UnsafeSave", preservation: check.preservation };
  if (!check.platformSupported) return { code: "SaveUnsupported", reason: "platform" };
  return null;
}
