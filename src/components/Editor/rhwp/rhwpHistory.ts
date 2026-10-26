// rhwp 실행 취소·다시 실행 기록(T010 Phase 2, docs/architecture/rhwp-undo-redo.md). 문서 내용과 스냅숏 내용은 rhwp 문서(엔진)가
// 갖고, 이 기록은 스냅숏 ID·상태 시간선·커서 체크포인트·타자 그룹 경계만 든다(두 번째 문서 모델이 아님). 백엔드 revision은 세지
// 않는다: 실행 취소·다시 실행 한 번은 세션이 변경 1개로 센다(RhwpEditorSession).
//
// 상태 시간선: states[i]는 i번째 상태의 스냅숏 ID(null = 아직 찍지 않은 지금 상태), cursor는 지금 문서의 상태.
//   I1 states[cursor] 밖의 칸은 모두 ID를 가진다(닿을 수 있는 기록은 이어져 있다). 끝에서만 지운다.
//   I2 live ≤ limit − (states[cursor] === null ? 1 : 0): 지금 상태를 찍을 자리가 언제나 남는다.
//   I3 limit ≤ snapshotCapacity() − HEADROOM: 엔진의 말없는 넘침 지우기(가장 오래된 것부터)가 일어나지 않는다. 이 기록이 그 문서의
//      유일한 스냅숏 호출자다.
// 시험 전용 모델(tests/poc/t010-phase0/history_model.mjs)과 같은 알고리즘이며, 그 경계 시험을 이 구현에도 돌린다(rhwpHistory.test.ts).
import type { DocPosition, RhwpText } from "./rhwpText";

/** 고정 rhwp `HwpDocument`의 스냅숏 함수(`src/wasm_api.rs`, `document_core/commands/document.rs`). */
export interface SnapshotEngine {
  /** 지금 문서를 복제해 저장하고 ID를 준다(Result 없음: 던지면 WASM trap이고 그 전에 모델이 바뀌었을 수 있다). */
  saveSnapshot(): number;
  /** 그 ID의 스냅숏을 복제해 문서를 바꾼다(스냅숏은 남는다). 없으면 바꾸기 전에 "스냅샷 N 없음" 오류. */
  restoreSnapshot(id: number): string;
  discardSnapshot(id: number): void;
  /** 저장소 상한(고정 판 100). 넘치면 가장 오래된 것을 알림 없이 지운다. */
  snapshotCapacity(): number;
}

export const HISTORY_HEADROOM = 2;
export const HISTORY_MIN_DEPTH = 4;
export const HISTORY_MAX_DEPTH = 50;
/**
 * 기록 메모리 예산(회계 값이지 RSS·바이트 정확한 상한이 아님: 엔진에 스냅숏 크기 질의가 없고 WASM 선형 메모리는 줄지 않는다). 두 곳에
 * 쓴다: 깊이를 정하는 어림(`historyBudget`)과, 기록을 켠 뒤 선형 메모리 상한선이 이만큼 넘게 자라면 새 그룹을 찍지 않고 기록을 끄는
 * 감시(`RhwpHistory` memory). 감시는 기록 밖의 증가(그리기·조판 캐시)도 세므로 보수적이다.
 */
export const HISTORY_BUDGET_BYTES = 256 * 1024 * 1024;
/** 타자 그룹을 이어 쓰는 최대 쉼(ms). 그보다 오래 쉬고 친 글자는 새 단계다(긴 문장이 한 번에 사라지지 않게). */
export const HISTORY_IDLE_MS = 1500;

export type HistoryKind = "typing" | "deleteBack" | "deleteForward" | "other";
const EXTENDABLE = new Set<HistoryKind>(["typing", "deleteBack", "deleteForward"]);

/**
 * 기록 깊이(설계 §10). 자르지 않은 추정을 먼저 보고 최소 깊이를 확인한 뒤에만 상한을 건다. estimate는 스냅숏 하나의 바이트 대용으로
 * 세션은 원본 파일 크기를 준다. 이 대용은 보수적이지 않다(공개 예제 1189개 실측: 스냅숏당 선형 메모리 증가가 파일 크기의 p50 2.4배·
 * 최대 62배). 문서를 열 때의 선형 메모리 증가는 그 표본 모두에서 스냅숏당 증가 이상이었지만 그림이 많은 문서에서 수십 배 과대(12MB
 * HWP: 열기 38.6MB, 스냅숏 24개에 증가 0)라 쓰지 않는다. 어림의 부족은 `RhwpHistory`의 선형 메모리 증가 감시가 받친다.
 * 살아 있는 문서 1 + 복원 중 임시 복제 1을 뺀다.
 */
export function historyBudget(estimate: number, capacity: number): { enabled: boolean; depth: number; snapshots: number } {
  const raw = Math.floor(HISTORY_BUDGET_BYTES / Math.max(1, estimate)) - 2;
  const min = HISTORY_MIN_DEPTH + 1;
  if (!(raw >= min)) return { enabled: false, depth: 0, snapshots: 0 };
  const snapshots = Math.min(raw, capacity - HISTORY_HEADROOM, HISTORY_MAX_DEPTH + 1);
  if (!(snapshots >= min)) return { enabled: false, depth: 0, snapshots: 0 };
  return { enabled: true, depth: snapshots - 1, snapshots };
}

// ---- 커서 체크포인트(선행 PoC B2: tests/poc/t010-phase0/checkpoint.poc.test.ts) ----

interface Mark { before: string; after: string; paragraphs: number; cells: number | null }
export interface Checkpoint { caret: DocPosition; anchor: DocPosition; marks: { caret: Mark; anchor: Mark } }
const FINGER = 8;

function mark(text: RhwpText, at: DocPosition): Mark {
  const start = Math.max(0, at.offset - FINGER);
  return {
    before: text.text({ ...at, offset: start }, at.offset - start),
    after: text.text(at, Math.max(0, Math.min(FINGER, text.paragraphLength(at) - at.offset))),
    paragraphs: text.paragraphCount(at),
    cells: text.cellCount(at),
  };
}

/** 지금 커서·선택과 그 주변 글 지문. 엔진 질의가 실패하면 null(그 상태는 정확히 되돌릴 자리 정보가 없음). */
export function captureCheckpoint(text: RhwpText, caret: DocPosition, anchor: DocPosition): Checkpoint | null {
  try {
    return { caret, anchor, marks: { caret: mark(text, caret), anchor: mark(text, anchor) } };
  } catch {
    return null;
  }
}

function structurallyValid(text: RhwpText, at: DocPosition): boolean {
  try {
    if (at.cell) {
      const cells = text.cellCount(at);
      if (cells === null || at.cell.cell >= cells || at.cell.cellParagraph >= text.paragraphCount(at)) return false;
    } else if (at.paragraph >= text.paragraphCount(at)) return false;
    return at.offset >= 0 && at.offset <= text.paragraphLength(at);
  } catch {
    return false;
  }
}

const DOCUMENT_START: DocPosition = { section: 0, paragraph: 0, offset: 0 };

/**
 * 복원한 문서에 체크포인트를 둔다. 구조(문단·셀 경로·오프셋 범위)와 지문(앞뒤 글·문단 수·셀 수)이 모두 같으면 그 자리(exact),
 * 아니면 문서 처음·선택 없음(fallback). 어느 쪽도 문서 내용을 바꾸지 않는다. 숫자 범위 안이라는 것만으로 정확하다고 보지 않는다.
 */
export function placeCheckpoint(text: RhwpText, checkpoint: Checkpoint | null): { exact: boolean; caret: DocPosition; anchor: DocPosition } {
  if (checkpoint) {
    const fits = (["caret", "anchor"] as const).every((key) => {
      if (!structurallyValid(text, checkpoint[key])) return false;
      try {
        return JSON.stringify(mark(text, checkpoint[key])) === JSON.stringify(checkpoint.marks[key]);
      } catch {
        return false;
      }
    });
    if (fits) return { exact: true, caret: checkpoint.caret, anchor: checkpoint.anchor };
  }
  return { exact: false, caret: DOCUMENT_START, anchor: DOCUMENT_START };
}

// ---- 기록 ----

/** 엔진을 부르기 전에 거절함(문서·기록 그대로). */
export class HistoryRefused extends Error {
  constructor(readonly reason: "nothingToUndo" | "nothingToRedo" | "transaction" | "limit" | "unavailable") {
    super(reason);
  }
}

/** 엔진 스냅숏 호출이 실패함. uncertain이면 엔진이 문서를 바꿨는지 알 수 없다(trap): 세션이 편집을 멈춘다. */
export class HistoryFailure extends Error {
  constructor(readonly kind: "snapshot-failed" | "snapshot-missing" | "restore-failed" | "discard-failed", readonly uncertain: boolean) {
    super(kind);
  }
}

interface Pending {
  captured: boolean; extending: boolean; kind: HistoryKind; start: string | null;
  /** 같은 내용의 기존 snapshot을 쓰더라도 이번 편집의 before caret은 새로 잡는다. 취소하면 되돌린다. */
  previousCheckpoint: { id: number; value: Checkpoint | null } | null;
}

export class RhwpHistory {
  private states: (number | null)[] = [null];
  private cursor = 0;
  private pending: Pending | null = null;
  private group: { kind: HistoryKind; end: string; at: number } | null = null;
  /** 열린 트랜잭션 동안 받은 그룹 끊기: 그 트랜잭션이 닫힐 때(조합·provisional 정리) 끊는다. */
  private breakAfterCommit = false;
  private readonly checkpoints = new Map<number, Checkpoint | null>();
  /** ok | broken(엔진 상태를 믿을 수 없거나 셈이 어긋남 — 더 쓰지 않음). */
  state: "ok" | "broken" = "ok";
  /** 시험·진단용: 이 기록이 찍은 수(saveSnapshot 호출). */
  allocations = 0;
  /** 기록을 켤 때의 WASM 선형 메모리 크기와 마지막으로 읽은 값(단조성 확인). */
  private readonly memoryAtStart: number;
  private memoryLast: number;

  /**
   * memory는 모듈 WASM 선형 메모리 크기(줄지 않는 상한선)를 읽는 함수다 — 필수(감시 없는 기록은 만들지 않는다). 읽은 값은
   * `readMemory`의 계약(0 이상의 안전한 정수, 줄지 않음, 예외 없음)을 지켜야 하고, 아니면 측정 불가(unavailable)다.
   * 스냅숏을 새로 찍는 경로(새 그룹의 before, 실행 취소의 지금 상태)는 엔진을 부르기 전에 읽는다:
   * - 측정 불가: unavailable로 거절(세션은 기록을 끄고 편집은 계속). 0 같은 그럴듯한 값으로 바꾸지 않는다.
   * - 새 그룹에서 켠 뒤 증가가 HISTORY_BUDGET_BYTES를 넘음: limit으로 거절. 실행 취소의 지금 상태 찍기는 I2의 자리 안이라
   *   예산 초과로는 막지 않는다(되돌릴 수 있는 기록을 쓸 수 있게).
   * 할당하지 않는 전이(이어 쓰기, 찍혀 있는 상태의 실행 취소·다시 실행·새 편집 시작)는 읽지 않는다.
   */
  constructor(
    private readonly engine: SnapshotEngine,
    private readonly depth: number,
    private readonly now: () => number,
    private readonly memory: () => number,
  ) {
    if (!(this.limit >= 2)) throw new HistoryRefused("limit");
    this.memoryLast = -1;
    this.memoryAtStart = this.readMemory();
  }

  /** 측정 계약. 어긋나면 HistoryRefused("unavailable") — 예산 초과(limit)로 보고하지 않는다. */
  private readMemory(): number {
    let value: unknown;
    try {
      value = this.memory();
    } catch {
      throw new HistoryRefused("unavailable");
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value < this.memoryLast) {
      throw new HistoryRefused("unavailable");
    }
    this.memoryLast = value;
    return value;
  }

  /**
   * 살아 있는 스냅숏 상한. 엔진 상한을 매번 읽는다(I3): 고정 판이 바뀌어 상한이 줄면 다음 할당이 그만큼 먼저 지우거나 거절한다
   * (지운 뒤에 알아내는 방법에 기대지 않는다).
   */
  get limit(): number {
    return Math.min(this.engine.snapshotCapacity() - HISTORY_HEADROOM, this.depth + 1);
  }

  get live() {
    return this.states.filter((id) => id !== null).length;
  }
  get transactionOpen() {
    return this.pending !== null;
  }
  get canUndo() {
    return this.state === "ok" && this.pending === null && this.cursor > 0;
  }
  get canRedo() {
    return this.state === "ok" && this.pending === null && this.cursor < this.states.length - 1;
  }
  /** 실행 취소·다시 실행할 수 있는 단계 수(시험·진단). */
  get steps() {
    return { undo: this.cursor, redo: this.states.length - 1 - this.cursor };
  }
  referenced(): number[] {
    return this.states.filter((id): id is number => id !== null);
  }

  /** 불변식 위반 목록(시험이 매 단계 확인). */
  violations(): string[] {
    const errors: string[] = [];
    this.states.forEach((id, i) => {
      if (i !== this.cursor && id === null) errors.push(`I1 states[${i}]`);
    });
    const allowed = this.limit - (this.states[this.cursor] === null ? 1 : 0);
    if (this.live > allowed) errors.push(`I2 live ${this.live} > ${allowed}`);
    if (this.limit > this.engine.snapshotCapacity() - HISTORY_HEADROOM) errors.push("I3");
    if (new Set(this.referenced()).size !== this.live) errors.push("중복 ID");
    return errors;
  }

  // ---- 자원 ----

  private save(checkpoint: Checkpoint | null): number {
    this.allocations += 1;
    let id: number;
    try {
      id = this.engine.saveSnapshot();
    } catch {
      this.state = "broken";
      throw new HistoryFailure("snapshot-failed", true);
    }
    this.checkpoints.set(id, checkpoint);
    return id;
  }

  private discard(id: number) {
    this.checkpoints.delete(id);
    try {
      this.engine.discardSnapshot(id);
    } catch {
      // discard는 Result가 없다: 던졌다면 엔진을 믿을 수 없다. 문서를 놓을 때 스냅숏도 함께 사라진다.
      this.state = "broken";
      throw new HistoryFailure("discard-failed", true);
    }
  }

  /**
   * n개를 새로 찍을 자리를 엔진 호출 전에 만든다. protect는 지울 수 없는 스냅숏 ID(칸 번호가 아님: 과거를 지우면 번호가 당겨진다).
   * 끝에서만 지우고, 먼저 지울 수 있는 수를 세어 모자라면 아무것도 지우지 않고 거절한다.
   */
  private reserve(n: number, protect: ReadonlySet<number>, order: readonly ("past" | "future")[]) {
    let removable = 0;
    const last = this.states.length - 1;
    if (order.includes("past")) for (let i = 0; i < this.cursor && !protect.has(this.states[i]!); i++) removable += 1;
    if (order.includes("future")) for (let i = last; i > this.cursor && !protect.has(this.states[i]!); i--) removable += 1;
    const need = this.live + n - this.limit;
    if (need > removable) throw new HistoryRefused("limit");
    for (let k = 0; k < need; k++) {
      const done = order.some((dir) => (dir === "future" ? this.evictFarthestFuture(protect) : this.evictOldestPast(protect)));
      if (!done) throw new Error("rhwp 기록: 지울 수 있는 수를 잘못 셈");
    }
  }

  private evictOldestPast(protect: ReadonlySet<number>) {
    const id = this.states[0];
    if (this.cursor === 0 || id === null || id === undefined || protect.has(id)) return false;
    this.states.shift();
    this.cursor -= 1;
    this.discard(id);
    return true;
  }

  private evictFarthestFuture(protect: ReadonlySet<number>) {
    const last = this.states.length - 1;
    const id = this.states[last];
    if (last <= this.cursor || id === null || id === undefined || protect.has(id)) return false;
    this.states.pop();
    this.discard(id);
    return true;
  }

  // ---- 편집 트랜잭션 ----

  /**
   * 바꾸는 첫 엔진 호출 직전. start는 이어 쓰기 판단용 시작 자리 열쇠(null = 이어 쓰지 않음, 예: 선택 바꾸기). 이미 열려 있으면 그대로
   * (조합 갱신·provisional 고치기는 그 조합의 트랜잭션이다). checkpoint는 지금 상태를 찍게 되면 함께 둘 커서.
   */
  begin(kind: HistoryKind, start: string | null, checkpoint: () => Checkpoint | null) {
    if (this.state !== "ok") throw new HistoryRefused("unavailable");
    if (this.pending) return;
    const group = this.group;
    const extending = group !== null && start !== null && EXTENDABLE.has(kind) && group.kind === kind && group.end === start
      && this.now() - group.at <= HISTORY_IDLE_MS;
    let captured = false;
    let previousCheckpoint: Pending["previousCheckpoint"] = null;
    if (!extending && this.states[this.cursor] === null) {
      // 지금 상태 = 새 그룹의 before. 다시 실행 기록이 있으면 지금 상태는 이미 찍혀 있다(실행 취소가 찍음).
      if (this.readMemory() - this.memoryAtStart > HISTORY_BUDGET_BYTES) throw new HistoryRefused("limit");
      this.reserve(1, new Set(), ["past"]);
      this.states[this.cursor] = this.save(checkpoint());
      captured = true;
    } else if (!extending) {
      // Undo/Redo 뒤에는 지금 내용의 snapshot이 이미 있다. 내용은 같아도 그 뒤의 이동/선택으로
      // 편집 시작 위치가 달라진다: 새 branch를 Undo하면 이번 before로 돌아가야 한다.
      const id = this.states[this.cursor];
      if (id !== null && id !== undefined) {
        previousCheckpoint = { id, value: this.checkpoints.get(id) ?? null };
        this.checkpoints.set(id, checkpoint());
      }
    }
    this.pending = { captured, extending, kind, start, previousCheckpoint };
  }

  /** 세션이 변경 1개를 셌다(recordMutation). 열린 트랜잭션이 기록 단계가 된다(이어 쓰기면 같은 단계). end = 끝 자리 열쇠. */
  commit(end: string) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (!pending.extending) {
      // 새 그룹: 다시 실행 기록은 닿을 수 없게 됐다.
      while (this.states.length - 1 > this.cursor) this.discard(this.states.pop()!);
      this.states.push(null);
      this.cursor += 1;
      while (this.live > this.limit - 1) if (!this.evictOldestPast(new Set())) break;
    }
    this.group = { kind: pending.kind, end, at: this.now() };
    if (this.breakAfterCommit) {
      // 트랜잭션 중에 끊기를 받았다(조합 중 초점 잃음 등): 이 트랜잭션은 그대로 단계가 되고, 그 뒤 트랜잭션은 이어 쓰지 않는다.
      this.breakAfterCommit = false;
      this.group = null;
    }
  }

  /** 트랜잭션이 세지 않고 끝났다(선택 없이 취소한 조합). 이 트랜잭션이 찍은 것만 버린다. */
  cancel() {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (pending.previousCheckpoint) {
      const { id, value } = pending.previousCheckpoint;
      this.checkpoints.set(id, value);
    }
    this.breakAfterCommit = false; // 그룹은 이미 끊겼다(아래 boundary가 group을 비움)
    if (pending.captured) {
      const id = this.states[this.cursor];
      this.states[this.cursor] = null;
      if (id !== null && id !== undefined) this.discard(id);
    }
  }

  /**
   * 이동·클릭·선택·명령·초점 잃음: 타자 그룹을 끊는다(기록은 그대로). 트랜잭션(조합·provisional)이 열려 있으면 그 트랜잭션이 닫힐
   * 때 끊는다 — 지금 그룹만 비우면 조합이 나중에 닫히며 그룹을 다시 만들어 다음 타자가 끊기를 넘어 이어 쓴다.
   */
  boundary() {
    this.group = null;
    if (this.pending) this.breakAfterCommit = true;
  }

  // ---- 실행 취소·다시 실행 ----

  /** 이전 상태로 복원하고 그 상태의 커서 체크포인트를 준다. current는 지금 상태를 찍게 되면 함께 둘 커서. */
  undo(current: () => Checkpoint | null): Checkpoint | null {
    if (this.state !== "ok") throw new HistoryRefused("unavailable");
    if (this.pending) throw new HistoryRefused("transaction");
    if (this.cursor === 0) throw new HistoryRefused("nothingToUndo");
    if (this.states[this.cursor] === null) {
      this.readMemory(); // 측정 불가면 지우거나 찍기 전에 거절(예산 초과는 I2 자리라 받는다)
      this.reserve(1, new Set([this.states[this.cursor - 1]!]), ["future", "past"]);
      this.states[this.cursor] = this.save(current());
    }
    this.group = null;
    const target = this.states[this.cursor - 1]!;
    this.restore(target);
    this.cursor -= 1;
    return this.checkpoints.get(target) ?? null;
  }

  /** 다음 상태로 복원한다(할당하지 않는다: 복원은 스냅숏을 남긴다). */
  redo(): Checkpoint | null {
    if (this.state !== "ok") throw new HistoryRefused("unavailable");
    if (this.pending) throw new HistoryRefused("transaction");
    if (this.cursor >= this.states.length - 1) throw new HistoryRefused("nothingToRedo");
    this.group = null;
    const target = this.states[this.cursor + 1]!;
    this.restore(target);
    this.cursor += 1;
    return this.checkpoints.get(target) ?? null;
  }

  private restore(id: number) {
    try {
      this.engine.restoreSnapshot(id);
    } catch (error) {
      this.state = "broken";
      // "스냅샷 N 없음"은 고정 rhwp가 문서를 바꾸기 전(찾기)에 내는 오류. 그 밖은 문서 상태를 알 수 없다.
      const missing = /스냅샷 \d+ 없음/.test(String(error));
      throw new HistoryFailure(missing ? "snapshot-missing" : "restore-failed", !missing);
    }
  }

  /** 기록을 비운다. discard면 참조 ID를 엔진에서도 버린다(엔진을 믿을 수 있을 때만; 문서를 곧 놓으면 함께 사라진다). */
  release(discard: boolean) {
    try {
      if (discard && this.state === "ok") for (const id of this.referenced()) this.discard(id);
    } finally {
      // 실패한 ID도 재시도하지 않는다. trap 뒤 남은 저장소는 문서 free()가 소유한다.
      this.states = [null];
      this.cursor = 0;
      this.pending = null;
      this.group = null;
      this.breakAfterCommit = false;
      this.checkpoints.clear();
      this.state = "broken";
    }
  }
}
