#!/usr/bin/env node
// T010 Phase 1 설계 경계 시험(시험 전용): history_model.mjs의 고친 알고리즘을 실제 rhwp WASM 스냅숏(고정 public/rhwp)과 흉내
// 엔진(고정 rhwp의 상한·말없는 넘침 지우기·"없음" 오류를 그대로 흉내)에서 돌린다. 이전 설계의 반례도 재현한다.
//
//   node tests/poc/t010-phase0/history_boundary.mjs [--out 결과.json]
//
// 실제 WASM 시험은 엔진 스냅숏의 보존·버림·넘침을 본다. 흉내 엔진 시험은 알고리즘 불변식만 본다(엔진 증거가 아님).
// 실패가 하나라도 있으면 종료 코드 1. 픽스처는 tests/fixtures/rhwp/generate.mjs가 임시 디렉터리에 만든다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HistoryRefused, PreviousDesignHistory, SnapshotHistory, historyBudget, previousDepthLimit } from "./history_model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const rhwp = await import(pathToFileURL(join(root, "public/rhwp/rhwp.js")).href);
rhwp.initSync({ module: readFileSync(join(root, "public/rhwp/rhwp_bg.wasm")) });
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "geul-t010-hist-"));
execFileSync("node", [join(root, "tests/fixtures/rhwp/generate.mjs"), scratch]);
const FIXTURE = { hwp: readFileSync(join(scratch, "basic-ko.hwp")), hwpx: readFileSync(join(scratch, "basic-ko.hwpx")) };
const outArg = process.argv.indexOf("--out");
const results = [];

function test(name, kind, body) {
  try {
    const detail = body() ?? {};
    results.push({ name, kind, status: "PASS", detail });
    console.log(`[PASS] ${kind} ${name}`);
  } catch (error) {
    results.push({ name, kind, status: "FAIL", error: String(error?.stack ?? error).slice(0, 800) });
    console.log(`[FAIL] ${kind} ${name}\n  ${String(error?.message ?? error)}`);
  }
}

// ---- 엔진 ----

/** 실제 rhwp 문서 + 문서 글을 상태로 보는 도우미. 편집은 문단 0 처음에 글자를 넣는다(문서마다 다른 글). */
function realEngine(fmt = "hwp") {
  const doc = new rhwp.HwpDocument(FIXTURE[fmt]);
  return {
    doc,
    kind: "real-wasm",
    saveSnapshot: () => doc.saveSnapshot(),
    restoreSnapshot: (id) => doc.restoreSnapshot(id),
    discardSnapshot: (id) => doc.discardSnapshot(id),
    snapshotCapacity: () => doc.snapshotCapacity(),
    text: () => doc.getTextFileText(),
    edit: (k) => doc.insertText(0, 0, 0, String.fromCharCode(0xac00 + (k % 400))),
    free: () => doc.free(),
  };
}

/** 고정 rhwp save/restore/discard_snapshot_native를 흉내(상한 100, 넘치면 가장 오래된 것을 말없이 지움). 상태는 정수. */
function fakeEngine(capacity = 100) {
  let state = 0;
  let next = 0;
  const store = [];
  return {
    kind: "simulated",
    saveSnapshot: () => {
      store.push([next, state]);
      while (store.length > capacity) store.shift();
      return next++;
    },
    restoreSnapshot: (id) => {
      const hit = store.find(([sid]) => sid === id);
      if (!hit) throw new Error(`렌더링 오류: 스냅샷 ${id} 없음`);
      state = hit[1];
      return '{"ok":true}';
    },
    discardSnapshot: (id) => {
      const i = store.findIndex(([sid]) => sid === id);
      if (i >= 0) store.splice(i, 1);
    },
    snapshotCapacity: () => capacity,
    text: () => String(state),
    edit: (k) => {
      state = state * 31 + k + 1;
    },
    storeSize: () => store.length,
    free: () => {},
  };
}

/** 그룹 하나 = 트랜잭션 시작 → 편집 → 셈. 시작 커서를 매번 다르게 해 이어 쓰지 않는다. */
function editGroup(history, engine, k) {
  history.mutationStarting("other", `g${k}`);
  engine.edit(k);
  history.committed(`g${k}-end`);
}

/** 모든 참조 ID를 복원해 그 상태의 글과 같은지(끝에서 한 번, 복원하므로 파괴적), 버린 ID는 "없음"인지. */
function verifyStore(history, engine, texts) {
  const referenced = history.referenced();
  for (const id of referenced) {
    engine.restoreSnapshot(id);
    assert.equal(engine.text(), texts.get(id), `참조 ID ${id}의 상태`);
  }
  let discardedChecked = 0;
  for (const id of history.discarded) {
    const before = engine.text();
    assert.throws(() => engine.restoreSnapshot(id), /없음/, `버린 ID ${id}가 남아 있음`);
    assert.equal(engine.text(), before, "실패한 복원이 문서를 바꿈");
    discardedChecked += 1;
  }
  return { referenced: referenced.length, discardedChecked };
}

/** 기록 + 각 ID가 찍힌 상태의 글(시험 쪽 그림자). 엔진의 saveSnapshot을 감싸 글을 기록한다. */
function tracked(engine, options) {
  const texts = new Map();
  const wrapped = { ...engine, saveSnapshot: () => { const id = engine.saveSnapshot(); texts.set(id, engine.text()); return id; } };
  const history = new SnapshotHistory(wrapped, options);
  return { history, texts, wrapped };
}

function noViolations(history, where) {
  const errors = history.check();
  assert.deepEqual(errors, [], `${where}: ${errors.join(", ")}`);
}

// ---- 7.1 용량 경계 ----

for (const depth of [4, 5]) {
  test(`depth=${depth}: 10그룹 편집 → 한도까지 실행 취소 → 모두 다시 실행, 글이 그 시점과 같음`, "real-wasm", () => {
    const engine = realEngine();
    const { history, texts } = tracked(engine, { depth });
    const timeline = [engine.text()];
    for (let k = 0; k < 10; k++) {
      editGroup(history, engine, k);
      timeline.push(engine.text());
      noViolations(history, `edit ${k}`);
      assert.ok(history.live <= history.limit - 1);
    }
    let undone = 0;
    while (history.canUndo) {
      history.undo();
      undone += 1;
      noViolations(history, `undo ${undone}`);
      assert.equal(engine.text(), timeline[10 - undone], `undo ${undone}`);
    }
    assert.equal(undone, depth, "논리 단계 = depth");
    assert.throws(() => history.undo(), HistoryRefused);
    let redone = 0;
    while (history.canRedo) {
      history.redo();
      redone += 1;
      noViolations(history, `redo ${redone}`);
      assert.equal(engine.text(), timeline[10 - depth + redone]);
    }
    assert.equal(redone, depth);
    assert.throws(() => history.redo(), HistoryRefused);
    const store = verifyStore(history, engine, texts);
    engine.free();
    return { depth, limit: history.limit, undone, redone, allocations: history.allocations, ...store };
  });
}

test("정확한 상한(depth = capacity − 3 = 97, 스냅숏 98): 누적 할당 130회 뒤에도 참조 ID가 모두 그 상태로 복원됨", "real-wasm", () => {
  const engine = realEngine("hwpx");
  const capacity = engine.snapshotCapacity();
  const { history, texts } = tracked(engine, { depth: capacity - 3 });
  assert.equal(history.limit, capacity - 2);
  const timeline = [engine.text()];
  for (let k = 0; k < 120; k++) {
    editGroup(history, engine, k);
    timeline.push(engine.text());
  }
  noViolations(history, "120 edits");
  for (let k = 0; k < 10; k++) history.undo();
  for (let k = 0; k < 10; k++) history.redo();
  for (let k = 0; k < 97; k++) history.undo();
  assert.equal(engine.text(), timeline[120 - 97]);
  assert.ok(!history.canUndo);
  noViolations(history, "undo all");
  assert.ok(history.allocations > 100, `누적 할당 ${history.allocations}`);
  assert.ok(history.live <= capacity - 2);
  const store = verifyStore(history, engine, texts);
  engine.free();
  return { capacity, limit: history.limit, allocations: history.allocations, live: history.live, ...store };
});

test("실행 취소 뒤 새 편집: 다시 실행을 버리고 버린 ID는 엔진에 남지 않음", "real-wasm", () => {
  const engine = realEngine();
  const { history, texts } = tracked(engine, { depth: 5 });
  for (let k = 0; k < 4; k++) editGroup(history, engine, k);
  history.undo();
  history.undo();
  assert.ok(history.canRedo);
  const futureIds = history.states.slice(history.cursor + 1);
  editGroup(history, engine, 99);
  assert.ok(!history.canRedo);
  for (const id of futureIds) assert.ok(history.discarded.has(id));
  noViolations(history, "after new edit");
  return { discardedFuture: futureIds.length, ...verifyStore(history, engine, texts) };
});

test("실행 취소·다시 실행 200회 번갈아: 처음 실행 취소의 지금 상태 찍기 뒤로 새 할당 없음", "real-wasm", () => {
  const engine = realEngine("hwpx");
  const { history } = tracked(engine, { depth: 4 });
  for (let k = 0; k < 3; k++) editGroup(history, engine, k);
  const a = engine.text();
  history.undo();
  const b = engine.text();
  const allocations = history.allocations;
  for (let k = 0; k < 200; k++) {
    if (k % 2 === 0) history.redo(); else history.undo();
    assert.equal(engine.text(), k % 2 === 0 ? a : b);
  }
  assert.equal(history.allocations, allocations);
  noViolations(history, "alternating");
  engine.free();
  return { allocations };
});

test("보호: 상한이 줄어 실행 취소에 지울 자리가 필요할 때 대상은 지우지 않고 가장 오래된 과거를 지움", "real-wasm", () => {
  const engine = realEngine();
  const { history, texts } = tracked(engine, { depth: 5 });
  const timeline = [engine.text()];
  for (let k = 0; k < 3; k++) {
    editGroup(history, engine, k);
    timeline.push(engine.text());
  }
  // states = [s0, s1, s2, null], live 3. 상한을 3으로 줄이면 지금 상태를 찍으려면 1개를 지워야 한다.
  history.setLimitForTest(3);
  const target = history.states[history.cursor - 1];
  history.undo();
  assert.equal(engine.text(), timeline[2], "대상 상태로 복원");
  assert.ok(!history.discarded.has(target), "대상은 남음");
  assert.equal(history.discarded.size, 1, "가장 오래된 과거 하나만 지움");
  return { evicted: [...history.discarded].length, ...verifyStore(history, engine, texts) };
});

test("보호: 다시 실행은 할당하지 않는다 — 상한이 줄어도 다시 실행 대상이 남고 성공", "real-wasm", () => {
  const engine = realEngine();
  const { history } = tracked(engine, { depth: 5 });
  const timeline = [engine.text()];
  for (let k = 0; k < 3; k++) {
    editGroup(history, engine, k);
    timeline.push(engine.text());
  }
  history.undo();
  history.undo();
  history.setLimitForTest(2);
  const allocations = history.allocations;
  history.redo();
  history.redo();
  assert.equal(engine.text(), timeline[3]);
  assert.equal(history.allocations, allocations);
  engine.free();
  return {};
});

test("거부: 지울 수 있는 후보가 없으면 실행 취소를 거부하고 문서·기록이 그대로", "real-wasm", () => {
  const engine = realEngine();
  const { history } = tracked(engine, { depth: 5 });
  editGroup(history, engine, 0);
  history.setLimitForTest(1); // states = [s0(대상), null], live 1: 지금 상태를 찍으려면 대상을 지워야 함
  const before = { text: engine.text(), states: [...history.states], cursor: history.cursor, allocations: history.allocations };
  assert.throws(() => history.undo(), (e) => e instanceof HistoryRefused && e.message === "reserve");
  assert.equal(engine.text(), before.text);
  assert.deepEqual([...history.states], before.states);
  assert.equal(history.cursor, before.cursor);
  assert.equal(history.allocations, before.allocations, "엔진 호출 전에 거부");
  assert.equal(history.state, "ok");
  engine.free();
  return {};
});

// ---- 7.4 이전 설계의 반례 재현 ----

test("이전 설계 반례: limit 3에서 편집 2 → 실행 취소 2 — 두 번째 실행 취소의 reserve가 자기 대상을 지움", "real-wasm", () => {
  const engine = realEngine();
  const old = new PreviousDesignHistory(engine, { limit: 3 });
  old.edit(() => engine.edit(0));
  old.edit(() => engine.edit(1));
  old.undo();
  let failure = null;
  try {
    old.undo();
  } catch (error) {
    failure = String(error.message);
  }
  assert.ok(failure, "이전 설계는 실패해야 한다(반례)");
  // 같은 순서를 고친 알고리즘으로(같은 스냅숏 상한 3 = depth 2).
  const engine2 = realEngine();
  const { history } = tracked(engine2, { depth: 2 });
  const start = engine2.text();
  editGroup(history, engine2, 0);
  editGroup(history, engine2, 1);
  history.undo();
  history.undo();
  assert.equal(engine2.text(), start);
  engine.free();
  engine2.free();
  return { previousDesignFailure: failure };
});

test("이전 설계 깊이 식: 아주 큰 문서에서도 4로 올려 '4 미만이면 끔' 규칙이 걸리지 않음 / 고친 순서는 끔", "arithmetic", () => {
  const MB = 1024 * 1024;
  const old = previousDepthLimit(256 * MB, 300 * MB, 100);
  assert.equal(old, 4, "이전 식은 floor=0을 4로 올린다");
  const fixed = historyBudget({ budget: 256 * MB, estimate: 300 * MB, capacity: 100 });
  assert.equal(fixed.enabled, false);
  // 경계: raw = floor(B/e) − 2. raw 5(=minDepth+1)면 켜짐 depth 4, raw 4면 끔.
  const at = (n) => historyBudget({ budget: n * 10 * MB, estimate: 10 * MB, capacity: 100 });
  assert.deepEqual(at(7), { enabled: true, depth: 4, snapshots: 5, raw: 5 });
  assert.equal(at(6).enabled, false);
  assert.deepEqual(at(8), { enabled: true, depth: 5, snapshots: 6, raw: 6 });
  // 상한: 작은 문서는 maxDepth+1, 용량 − 여유를 넘지 않음.
  const small = historyBudget({ budget: 256 * MB, estimate: 0.01 * MB, capacity: 100 });
  assert.deepEqual(small, { enabled: true, depth: 50, snapshots: 51, raw: Math.floor(256 / 0.01) - 2 });
  const tightCapacity = historyBudget({ budget: 256 * MB, estimate: 0.01 * MB, capacity: 6, maxDepth: 50 });
  assert.equal(tightCapacity.enabled, false, "용량 6 − 여유 2 = 4 < 최소 5");
  return { old, fixed, at7: at(7), at6: at(6), small, tightCapacity };
});

// ---- 7.3 실패 주입 ----

test("실패 주입: saveSnapshot 예외는 불확실(trap 가정) — 기록 broken, 다른 명령 거부", "real-wasm+fault", () => {
  const engine = realEngine();
  let fail = false;
  const faulty = { ...engine, saveSnapshot: () => { if (fail) throw new Error("RuntimeError: unreachable"); return engine.saveSnapshot(); } };
  const history = new SnapshotHistory(faulty, { depth: 5 });
  editGroup(history, engine, 0);
  fail = true;
  let caught = null;
  try {
    history.mutationStarting("other", "x");
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.message, "snapshot-failed");
  assert.equal(caught.uncertain, true);
  assert.equal(history.state, "broken");
  assert.ok(!history.canUndo && !history.canRedo);
  engine.free();
  return {};
});

test("실패 주입: 기록 밖에서 버려진 ID의 실행 취소는 '없음' — 문서 그대로, 불확실 아님, 기록 broken", "real-wasm+fault", () => {
  const engine = realEngine();
  const history = new SnapshotHistory(engine, { depth: 5 });
  editGroup(history, engine, 0);
  const before = engine.text();
  engine.discardSnapshot(history.states[history.cursor - 1]);
  let caught = null;
  try {
    history.undo();
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.message, "snapshot-missing");
  assert.equal(caught.uncertain, false);
  assert.equal(engine.text(), before, "문서 그대로(엔진은 찾기 전에 바꾸지 않음)");
  assert.equal(history.state, "broken");
  engine.free();
  return {};
});

test("실패 주입: 그 밖의 복원 예외는 불확실", "real-wasm+fault", () => {
  const engine = realEngine();
  const faulty = { ...engine, restoreSnapshot: () => { throw new Error("RuntimeError: unreachable"); } };
  const history = new SnapshotHistory(faulty, { depth: 5 });
  editGroup(history, engine, 0);
  let caught = null;
  try {
    history.undo();
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.message, "restore-failed");
  assert.equal(caught.uncertain, true);
  engine.free();
  return {};
});

test("트랜잭션 중(조합·대기 최종 글자) 실행 취소·다시 실행 거부", "simulated", () => {
  const engine = fakeEngine();
  const history = new SnapshotHistory(engine, { depth: 4 });
  editGroup(history, engine, 0);
  history.mutationStarting("typing", "c");
  assert.throws(() => history.undo(), (e) => e.message === "transaction");
  history.canceled();
  history.undo();
  assert.throws(() => history.redo() || history.mutationStarting("typing", "d") || history.undo(), (e) => e.message === "transaction");
  return {};
});

test("취소한 트랜잭션은 찍은 스냅숏만 버리고 기록 단계를 만들지 않음", "real-wasm", () => {
  const engine = realEngine();
  const { history, texts } = tracked(engine, { depth: 4 });
  editGroup(history, engine, 0);
  const steps = history.cursor;
  history.mutationStarting("typing", "new");
  const captured = history.states[history.cursor];
  history.canceled();
  assert.equal(history.cursor, steps);
  assert.equal(history.states[history.cursor], null);
  assert.ok(history.discarded.has(captured));
  return verifyStore(history, engine, texts);
});

// ---- 무작위 불변식(흉내 엔진: 고정 rhwp의 상한·넘침 지우기 흉내) ----

for (const depth of [4, 5, 97]) {
  test(`무작위 2만 단계(depth=${depth}): 모든 단계에서 불변식, 끝에 참조 ID가 엔진에 남음`, "simulated", () => {
    const engine = fakeEngine();
    const { history, texts } = tracked(engine, { depth });
    let seed = 12345 + depth;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const counts = { edit: 0, extend: 0, cancel: 0, undo: 0, redo: 0, refused: 0 };
    let end = 0;
    for (let step = 0; step < 20000; step++) {
      const r = rand();
      try {
        if (r < 0.35) {
          history.mutationStarting("typing", `p${end}`);
          engine.edit(step);
          end += 1;
          history.committed(`p${end}`);
          counts.extend += 1;
        } else if (r < 0.5) {
          history.boundary();
          editGroup(history, engine, step);
          counts.edit += 1;
        } else if (r < 0.55) {
          history.mutationStarting("other", `c${step}`);
          history.canceled();
          counts.cancel += 1;
        } else if (r < 0.8) {
          if (history.canUndo) { history.undo(); counts.undo += 1; } else counts.refused += 1;
        } else if (history.canRedo) { history.redo(); counts.redo += 1; } else counts.refused += 1;
      } catch (error) {
        if (!(error instanceof HistoryRefused)) throw error;
        counts.refused += 1;
      }
      noViolations(history, `step ${step}`);
      assert.ok(engine.storeSize() <= engine.snapshotCapacity() - 2, "엔진 저장소가 상한 − 여유 이하");
    }
    const store = verifyStore(history, engine, texts);
    return { depth, counts, allocations: history.allocations, ...store };
  });
}

rmSync(scratch, { recursive: true, force: true });
const failed = results.filter((r) => r.status !== "PASS");
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
if (outArg > 0) writeFileSync(process.argv[outArg + 1], JSON.stringify({ rhwpCommit: JSON.parse(readFileSync(join(root, "public/rhwp/BUILD.json"), "utf8")).commit, results }, null, 1) + "\n");
process.exit(failed.length ? 1 : 0);
