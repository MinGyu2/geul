// T010 Phase 1 설계 검증(시험 전용, 제품 코드 아님): docs/architecture/rhwp-undo-redo.md §5의 스냅숏 기록 알고리즘을 그대로
// 옮긴 모델. 엔진은 { saveSnapshot, restoreSnapshot, discardSnapshot, snapshotCapacity } 네 함수만 쓴다(실제 rhwp HwpDocument
// 또는 시험용 흉내). 제품 세션(RhwpEditorSession)에 들어가는 코드가 아니며, Phase 2 구현이 지켜야 할 불변식을 실행해 보는 용도다.
//
// 상태 시간선: states[i]는 i번째 상태의 스냅숏 ID(null = 아직 찍지 않은 지금 상태). cursor는 지금 문서가 어느 상태인지.
//   불변식 I1 states[cursor] 밖의 칸은 모두 ID를 가진다(닿을 수 있는 기록은 이어져 있다).
//   불변식 I2 live(ID 수) ≤ limit − (states[cursor] === null ? 1 : 0): 지금 상태를 찍을 자리가 언제나 남는다.
//   불변식 I3 limit ≤ capacity − headroom: 엔진의 말없는 넘침 지우기가 일어나지 않는다.

export class HistoryRefused extends Error {}

/** 이어 쓸 수 있는 그룹 종류(설계 §5): 넣기(조합 확정 포함), 앞 지우기, 뒤 지우기. 같은 종류가 바로 그 끝에서 이어질 때만. */
export const EXTENDABLE = new Set(["typing", "deleteBack", "deleteForward"]);

export class SnapshotHistory {
  /**
   * @param engine 스냅숏 네 함수.
   * @param depth 논리 단계 상한(실행 취소할 수 있는 그룹 수). 스냅숏 상한은 depth + 1.
   */
  constructor(engine, { depth, headroom = 2 } = {}) {
    this.engine = engine;
    this.capacity = engine.snapshotCapacity();
    this.limit = Math.min(this.capacity - headroom, depth + 1);
    if (!(this.limit >= 2)) throw new HistoryRefused("limit"); // 실행 취소 한 번에 2개(대상·지금)가 든다
    this.states = [null];
    this.cursor = 0;
    this.pending = null; // { captured: boolean, extending: boolean, kind, start }
    this.group = null; // 이어 쓸 수 있는 마지막 그룹 { kind, end }
    this.state = "ok"; // ok | broken(엔진 상태 불확실 — 더 쓰지 않음)
    this.discarded = new Set();
    this.allocations = 0;
  }

  get live() {
    return this.states.filter((id) => id !== null).length;
  }
  /** 시험 전용: 고정 엔진 판이 바뀌어 상한이 줄어든 것처럼 limit을 바꾼다(거부·보호 경로 시험). */
  setLimitForTest(limit) {
    this.limit = limit;
  }
  get canUndo() {
    return this.state === "ok" && this.pending === null && this.cursor > 0;
  }
  get canRedo() {
    return this.state === "ok" && this.pending === null && this.cursor < this.states.length - 1;
  }
  referenced() {
    return this.states.filter((id) => id !== null);
  }

  /** 불변식 검사(시험이 매 단계 부른다). */
  check() {
    const errors = [];
    this.states.forEach((id, i) => {
      if (i !== this.cursor && id === null) errors.push(`I1 states[${i}] 비어 있음`);
    });
    const allowed = this.limit - (this.states[this.cursor] === null ? 1 : 0);
    if (this.live > allowed) errors.push(`I2 live ${this.live} > ${allowed}`);
    if (this.limit > this.capacity - 2) errors.push("I3");
    for (const id of this.referenced()) if (this.discarded.has(id)) errors.push(`버린 ID ${id}를 참조`);
    if (new Set(this.referenced()).size !== this.live) errors.push("ID 중복");
    return errors;
  }

  // ---- 자원 ----

  #save() {
    try {
      this.allocations += 1;
      return this.engine.saveSnapshot();
    } catch (error) {
      // saveSnapshot은 Result가 없다(u32 반환): 던졌다면 WASM trap이고, 찍기 전 flush_cell_format_vpos가 모델을 이미 바꿨을 수 있다.
      this.state = "broken";
      throw Object.assign(new Error("snapshot-failed"), { uncertain: true, cause: error });
    }
  }
  #discard(id) {
    this.engine.discardSnapshot(id);
    this.discarded.add(id);
  }
  // protect는 스냅숏 ID 집합이다(칸 번호가 아님: 과거를 지우면 번호가 당겨진다 — 처음 초안의 결함).

  /** 가장 오래된 과거 상태 하나를 버린다(보호 대상이 아니면). */
  #evictOldestPast(protect) {
    if (this.cursor === 0 || protect.has(this.states[0])) return false;
    this.#discard(this.states.shift());
    this.cursor -= 1;
    return true;
  }
  /** 가장 먼 미래 상태 하나를 버린다. */
  #evictFarthestFuture(protect) {
    const last = this.states.length - 1;
    if (last <= this.cursor || protect.has(this.states[last])) return false;
    this.#discard(this.states.pop());
    return true;
  }
  /**
   * n개를 새로 찍을 자리를 엔진 호출 전에 만든다. protect = 지울 수 없는 스냅숏 ID. order = 지울 방향. 끝에서만 지우므로
   * 닿을 수 있는 기록은 이어진 채다. 자리를 못 만들면 아무것도 바꾸지 않고(지우기 전에 먼저 셈) 거부한다.
   */
  reserve(n, protect, order) {
    // 먼저 지울 수 있는 수를 센다: 지우다가 실패하면 이미 지운 것을 되살릴 수 없으므로.
    let removable = 0;
    const last = this.states.length - 1;
    if (order.includes("past")) for (let i = 0; i < this.cursor && !protect.has(this.states[i]); i++) removable += 1;
    if (order.includes("future")) for (let i = last; i > this.cursor && !protect.has(this.states[i]); i--) removable += 1;
    const need = this.live + n - this.limit;
    if (need > removable) throw new HistoryRefused("reserve");
    for (let k = 0; k < need; k++) {
      const done = order.some((dir) => (dir === "future" ? this.#evictFarthestFuture(protect) : this.#evictOldestPast(protect)));
      if (!done) throw new Error("내부: 셈과 다름");
    }
  }

  // ---- 편집 트랜잭션 ----

  /**
   * 바꾸는 첫 엔진 호출 직전(설계 §5 "트랜잭션 시작"). kind·start(시작 커서)로 마지막 그룹을 이어 쓸지 정한다.
   */
  mutationStarting(kind, start) {
    if (this.state !== "ok" || this.pending) return;
    const extending = this.group !== null && EXTENDABLE.has(kind) && this.group.kind === kind && this.group.end === start;
    let captured = false;
    if (!extending && this.states[this.cursor] === null) {
      // 지금 상태 = 새 그룹의 before. 다시 실행 기록이 있으면 지금 상태는 이미 찍혀 있다(실행 취소가 찍음).
      this.reserve(1, new Set(), ["past"]);
      this.states[this.cursor] = this.#save();
      captured = true;
    }
    this.pending = { captured, extending, kind, start };
  }

  /** 세션이 변경 1개를 셌다(recordMutation). 열린 트랜잭션이 기록 단계가 된다. end = 끝 커서. */
  committed(end) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (!pending.extending) {
      // 새 그룹: 다시 실행 기록을 버리고(닿을 수 없게 됨) 지금 상태 칸을 새로 연다.
      while (this.states.length - 1 > this.cursor) this.#discard(this.states.pop());
      this.states.push(null);
      this.cursor += 1;
      // depth 초과: 가장 오래된 과거를 버린다(I2 유지).
      while (this.live > this.limit - 1) if (!this.#evictOldestPast(new Set())) throw new Error("내부: 깊이 초과를 줄일 수 없음");
    }
    this.group = { kind: pending.kind, end };
  }

  /** 트랜잭션이 세지 않고 끝났다(선택 없이 취소한 조합 등). 이 트랜잭션이 찍은 것만 버린다. */
  canceled() {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (pending.captured) {
      this.#discard(this.states[this.cursor]);
      this.states[this.cursor] = null;
    }
  }

  /** 이동·클릭·선택·포커스·명령: 타자 그룹을 끊는다(기록은 그대로). */
  boundary() {
    this.group = null;
  }

  // ---- 실행 취소·다시 실행 ----

  undo() {
    if (!this.canUndo) throw new HistoryRefused(this.pending ? "transaction" : "nothingToUndo");
    this.group = null;
    const target = this.cursor - 1;
    if (this.states[this.cursor] === null) {
      // 대상(target)과 지금 칸은 보호. 미래가 먼저, 그다음 과거(대상 제외).
      this.reserve(1, new Set([this.states[target]]), ["future", "past"]);
      this.states[this.cursor] = this.#save();
    }
    const index = this.cursor - 1; // reserve가 과거를 지웠으면 번호가 당겨졌다
    this.#restore(this.states[index]);
    this.cursor = index;
  }

  redo() {
    if (!this.canRedo) throw new HistoryRefused(this.pending ? "transaction" : "nothingToRedo");
    this.group = null;
    this.#restore(this.states[this.cursor + 1]);
    this.cursor += 1;
  }

  #restore(id) {
    try {
      this.engine.restoreSnapshot(id);
    } catch (error) {
      // "스냅샷 N 없음"은 문서를 바꾸기 전의 오류(고정 rhwp restore_snapshot_native의 position 검색), 그 밖은 알 수 없음.
      const missing = /없음/.test(String(error));
      this.state = "broken";
      throw Object.assign(new Error(missing ? "snapshot-missing" : "restore-failed"), { uncertain: !missing, cause: error });
    }
  }

  dispose() {
    for (const id of this.referenced()) {
      try {
        this.#discard(id);
      } catch {
        // 엔진이 이미 쓸 수 없음(trap 뒤): 문서를 free하면 함께 사라진다.
      }
    }
    this.states = [null];
    this.cursor = 0;
    this.pending = null;
    this.group = null;
  }
}

/**
 * 이전 설계(rhwp-undo-redo.md 2026-10-21판 §5)의 할당·전이를 그대로 옮긴 것: 반례를 재현하는 용도. undo/redo 스택의 항목
 * {before, after}, reserve는 "가장 오래된 undo 항목(없으면 가장 먼 redo 항목)"을 버린다.
 */
export class PreviousDesignHistory {
  constructor(engine, { limit }) {
    this.engine = engine;
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }
  get live() {
    return [...this.undoStack, ...this.redoStack].reduce((n, e) => n + (e.before !== null) + (e.after !== null), 0);
  }
  #drop(entry) {
    for (const id of [entry.before, entry.after]) if (id !== null) this.engine.discardSnapshot(id);
  }
  reserve(n) {
    while (this.live + n > this.limit) {
      if (this.undoStack.length) this.#drop(this.undoStack.shift());
      else if (this.redoStack.length) this.#drop(this.redoStack.shift());
      else return false;
    }
    return true;
  }
  edit(apply) {
    this.reserve(1);
    const before = this.engine.saveSnapshot();
    apply();
    this.undoStack.push({ before, after: null });
    for (const e of this.redoStack) this.#drop(e);
    this.redoStack = [];
  }
  undo() {
    this.reserve(1);
    const after = this.engine.saveSnapshot();
    const entry = this.undoStack.pop();
    if (!entry) throw new Error("이전 설계: 되돌릴 항목이 reserve에서 지워짐");
    this.engine.restoreSnapshot(entry.before);
    entry.after = after;
    this.redoStack.push(entry);
  }
}

/** 이전 설계의 깊이 식(§10): clamp(floor(BUDGET / estimate), 4, capacity − HEADROOM). */
export function previousDepthLimit(budget, estimate, capacity, headroom = 2) {
  return Math.min(Math.max(Math.floor(budget / estimate), 4), capacity - headroom);
}

/**
 * 고친 순서(설계 §10): 자르지 않은 추정 → 최소 확인 → 그 뒤에만 상한. 반환 { enabled, depth, snapshots, raw }.
 * 메모리 추정: 살아 있는 문서 1 + 복원 중 임시 복제 1 + 스냅숏 수. 추정은 파일 크기 대용이고 보장이 아니다.
 */
export function historyBudget({ budget, estimate, capacity, headroom = 2, minDepth = 4, maxDepth = 50 }) {
  const raw = Math.floor(budget / estimate) - 2; // 살아 있는 문서·복원 임시 복제
  const minSnapshots = minDepth + 1;
  if (!(raw >= minSnapshots)) return { enabled: false, depth: 0, snapshots: 0, raw };
  const snapshots = Math.min(raw, capacity - headroom, maxDepth + 1);
  if (snapshots < minSnapshots) return { enabled: false, depth: 0, snapshots: 0, raw };
  return { enabled: true, depth: snapshots - 1, snapshots, raw };
}
