// 진단 추적의 묶음 계약(T010 IME 경계): 순번은 늘기만 하고, 최근 max개만 두며, 버린 수를 정확히 센다.
import { describe, expect, it } from "vitest";
import { appendRecord, type TraceStore } from "./imeTrace";

describe("진단 추적 묶음", () => {
  it("넘치면 가장 오래된 것부터 버리고, 남은 첫 순번 = 버린 수 + 1", () => {
    const store: TraceStore = { seq: 0, dropped: 0, records: [] };
    for (let i = 0; i < 10; i++) appendRecord(store, i % 2 ? "dom:input" : "win:mousedown", { n: i }, i, 4);
    expect(store.seq).toBe(10);
    expect(store.records.map((record) => record[0])).toEqual([7, 8, 9, 10]);
    expect(store.dropped).toBe(6);
    expect(store.records[0]![0]).toBe(store.dropped + 1);
    // 순서는 넣은 순서 그대로다(창 쪽·앱 쪽이 같은 경로로 더함).
    expect(store.records.map((record) => record[2])).toEqual(["win:mousedown", "dom:input", "win:mousedown", "dom:input"]);
  });

  it("넘치지 않으면 버리지 않는다", () => {
    const store: TraceStore = { seq: 0, dropped: 0, records: [] };
    for (let i = 0; i < 3; i++) appendRecord(store, "k", null, i, 4);
    expect([store.seq, store.dropped, store.records.length]).toEqual([3, 0, 3]);
  });

  it("검사 훅이 없는 빌드(시험 환경)에서는 창에 추가 함수가 없다", () => {
    expect(window.__geulTraceRecord).toBeUndefined();
  });
});
