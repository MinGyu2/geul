// 8차: 레이어 트리 비교(다시 그릴 띠)의 단위 회귀. 실제 엔진에서의 픽셀 동일성은 실제 앱에서 따로 잰다
// (editor-surface-decision.md "T007 8차").
import { describe, expect, it } from "vitest";
import { changedBand, summarizeLayerTree, type PaintBox } from "./paintDiff";

type Op = { type: string; text?: string; bbox: PaintBox };
const op = (text: string, y: number, height = 10): Op => ({ type: "textRun", text, bbox: { x: 10, y, width: 50, height } });
const leaf = (id: number, ops: Op[]) => ({ kind: "leaf", sourceNodeId: id, ops });
const tree = (...children: unknown[]) => JSON.stringify({
  root: { kind: "group", sourceNodeId: 0, groupKind: "page", children: [{ kind: "clipRect", sourceNodeId: 1, clip: { x: 0, y: 0, width: 800, height: 1000 }, child: { kind: "group", sourceNodeId: 2, children } }] },
});
const summary = (json: string) => {
  const result = summarizeLayerTree(json);
  expect(result).not.toBeNull();
  return result!;
};

describe("summarizeLayerTree", () => {
  it("비교할 수 없는 트리는 null(쪽 전체를 그림)", () => {
    expect(summarizeLayerTree("not json")).toBeNull();
    expect(summarizeLayerTree(JSON.stringify({}))).toBeNull();
    expect(summarizeLayerTree(tree({ kind: "image", sourceNodeId: 3 }))).toBeNull(); // 모르는 노드 종류
    expect(summarizeLayerTree(tree({ kind: "leaf", sourceNodeId: 3, ops: [{ type: "textRun" }] }))).toBeNull(); // 사각형 없음
    expect(summarizeLayerTree(tree({ kind: "leaf", sourceNodeId: 3, ops: [{ type: "x", bbox: { x: 0, y: 0, width: -1, height: 1 } }] }))).toBeNull();
  });

  it("잎마다 연산과 사각형을 남긴다", () => {
    const result = summary(tree(leaf(3, [op("가", 100), op("나", 120)])));
    expect(result.leaves).toHaveLength(1);
    expect(result.leaves[0]!.boxes.map((box) => box.y)).toEqual([100, 120]);
  });
});

describe("changedBand", () => {
  const before = summary(tree(leaf(3, [op("가", 100), op("나", 300)]), leaf(4, [op("표", 600)])));

  it("같으면 null(다시 그리지 않음)", () => {
    expect(changedBand(before, summary(tree(leaf(3, [op("가", 100), op("나", 300)]), leaf(4, [op("표", 600)]))), 800, 1000)).toBeNull();
  });

  it("바뀐 연산(이전·지금)만 위아래 여유를 두고 쪽 너비 띠로 합친다", () => {
    const after = summary(tree(leaf(3, [op("가", 100), op("나다", 300)]), leaf(4, [op("표", 600)])));
    // 300..310, 여유 max(8, 10) = 10
    expect(changedBand(before, after, 800, 1000)).toEqual({ x: 0, y: 290, width: 800, height: 30 });
  });

  it("뒤 문단·표가 움직이면 그 연산의 이전·지금 자리를 모두 포함한다", () => {
    const after = summary(tree(leaf(3, [op("가", 100), op("나", 300)]), leaf(4, [op("표", 640)])));
    expect(changedBand(before, after, 800, 1000)).toEqual({ x: 0, y: 590, width: 800, height: 70 });
  });

  it("같은 연산이 순서만 바뀌면 그 잎 전체", () => {
    const swapped = summary(tree(leaf(3, [op("나", 300), op("가", 100)]), leaf(4, [op("표", 600)])));
    expect(changedBand(before, swapped, 800, 1000)).toEqual({ x: 0, y: 90, width: 800, height: 230 });
  });

  it("구조(노드·잘라내기)가 다르면 쪽 전체", () => {
    expect(changedBand(before, summary(tree(leaf(3, [op("가", 100), op("나", 300)]))), 800, 1000)).toBe("page");
    expect(changedBand(before, summary(tree(leaf(3, [op("가", 100), op("나", 300)]), leaf(5, [op("표", 600)]))), 800, 1000)).toBe("page");
  });

  it("띠는 쪽 안으로 자르고, 쪽 높이를 덮으면 쪽 전체", () => {
    const top = summary(tree(leaf(3, [op("가", 2)])));
    expect(changedBand(top, summary(tree(leaf(3, [op("나", 2)]))), 800, 1000)).toEqual({ x: 0, y: 0, width: 800, height: 22 });
    const tall = summary(tree(leaf(3, [op("가", 0, 1000)])));
    expect(changedBand(tall, summary(tree(leaf(3, [op("나", 0, 1000)]))), 800, 1000)).toBe("page");
  });
});
