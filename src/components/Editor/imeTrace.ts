// IME·명령 진단 추적(T010 마무리 안정화). 검사 훅 빌드(`VITE_GEUL_TEST_HOOKS=1`)에서만 켜지고, 일반 빌드에서는 아무것도 하지 않는다
// (조건이 빌드 상수라 기록 코드가 실행되지 않음). 실제 IME 시험(tests/integration/wordcraft/wordcraft_poc.py --ime-commands)이
// `window.__geulTrace`를 읽어, 실패한 실행의 이벤트 순서를 보고서에 남긴다.
//
// 담는 것: 단조 시각·순번, 이벤트·연산 종류, inputType, isComposing·keyCode 229, 글자 수, 조합·provisional·끊긴 트랜잭션 상태,
// 명령 ID와 판정, 연산 종류, 세션 번호·불러오기 시도·revision·거부 수. 담지 않는 것: 문서 글자, 입력한 글자, 경로.
// 기록은 최근 MAX_RECORDS개로 묶고(넘치면 앞에서 버리고 dropped를 셈), 세부 값은 켜졌을 때만 만든다(꺼진 빌드의 비용 없음).

export type TraceValue = string | number | boolean | null;
export type TraceRecord = [seq: number, time: number, kind: string, detail: Record<string, TraceValue> | null];

export interface TraceStore {
  seq: number;
  dropped: number;
  records: TraceRecord[];
}

declare global {
  interface Window {
    __geulTrace?: TraceStore;
    /** 시험기가 창 쪽 이벤트를 같은 묶음·순번으로 더할 때 쓰는 추가 함수(검사 훅 빌드에서만 있음). */
    __geulTraceRecord?: (kind: string, detail: Record<string, TraceValue> | null) => void;
  }
}

const ENABLED = import.meta.env.VITE_GEUL_TEST_HOOKS === "1";
const MAX_RECORDS = 4000;

/**
 * 기록 하나를 더한다(하나뿐인 추가 경로). 순번은 1부터 늘고 줄지 않는다. 최근 `max`개만 두며, 넘치면 가장 오래된 것을 버리고
 * dropped를 센다 — 읽는 쪽은 첫 순번과 dropped로 원하는 구간이 빠졌는지 안다.
 */
export function appendRecord(store: TraceStore, kind: string, detail: Record<string, TraceValue> | null, time: number,
  max = MAX_RECORDS): void {
  store.seq += 1;
  store.records.push([store.seq, time, kind, detail]);
  if (store.records.length > max) {
    store.records.splice(0, store.records.length - max);
    store.dropped = store.seq - store.records.length;
  }
}

const now = () => Math.round(performance.now() * 10) / 10;
const store = () => (window.__geulTrace ??= { seq: 0, dropped: 0, records: [] });

if (ENABLED && typeof window !== "undefined") {
  window.__geulTraceRecord = (kind, detail) => appendRecord(store(), kind, detail, now());
}

export function trace(kind: string, detail?: () => Record<string, TraceValue>): void {
  if (!ENABLED || typeof window === "undefined") return;
  appendRecord(store(), kind, detail ? detail() : null, now());
}

/** 키의 종류(글자 자체는 남기지 않음). 수식 키와 함께 누른 키는 물리 키 이름(KeyZ 등, 단축키 판별용)을 남긴다. */
export function keyKind(event: KeyboardEvent): string {
  if (event.keyCode === 229 || event.key === "Process") return "ime";
  if (event.ctrlKey || event.metaKey || event.altKey) return `mod:${event.code}`;
  if (event.key.length === 1) return "char";
  return ["Control", "Shift", "Alt", "Meta"].includes(event.key) ? "modifier" : "named";
}
