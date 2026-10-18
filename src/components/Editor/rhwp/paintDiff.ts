// 쪽 그리기 입력(rhwp 레이어 트리, `getPageLayerTreeWithProfile`)을 비교해 다시 그릴 곳을 정한다(T007 8차).
//
// rhwp는 본문 편집에서 바뀐 영역을 알려 주지 않는다. 대신 그리기(`renderPage…ToCanvas`)가 그대로 재생하는 레이어 트리를
// 직렬화해 준다. 마지막으로 그 Canvas에 그린 트리와 지금 트리를 비교하면:
// - 노드 구조(종류·순서·층·잘라내기 사각형)가 다르면 쪽 전체.
// - 구조가 같으면 잎(그리기 연산 묶음)마다 연산을 비교해, 사라지거나 생긴 연산의 사각형(bbox)을 합친 띠(쪽 너비 전체,
//   위아래 여유)만 다시 그린다. 그 띠에 걸친 다른 연산은 패치 그리기가 함께 다시 재생한다(같은 픽셀).
// - 같으면 다시 그리지 않는다.
// 모르는 노드 종류·사각형이 없는 연산·읽기 실패는 비교하지 않는다(쪽 전체). 커서 사각형으로 짐작한 띠는 실제 엔진에서
// 표·뒤 문단이 움직여 틀렸으므로(7차) 쓰지 않는다: 이 띠는 실제로 그린 입력의 차이다.

export interface PaintBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 한 번 그린 쪽의 그리기 입력 요약. */
export interface PaintedPage {
  structure: string;
  leaves: { ops: string[]; boxes: PaintBox[] }[];
}

type LayerNode = {
  kind?: unknown;
  sourceNodeId?: unknown;
  layer?: unknown;
  groupKind?: unknown;
  clip?: unknown;
  children?: unknown;
  child?: unknown;
  ops?: unknown;
};

const isBox = (value: unknown): value is PaintBox => {
  const box = value as PaintBox | null;
  return !!box && [box.x, box.y, box.width, box.height].every((n) => typeof n === "number" && Number.isFinite(n))
    && box.width >= 0 && box.height >= 0;
};

/** 레이어 트리 JSON을 요약한다. 비교할 수 없는 트리면 null(쪽 전체를 그림). */
export function summarizeLayerTree(json: string): PaintedPage | null {
  let tree: { root?: LayerNode };
  try {
    tree = JSON.parse(json);
  } catch {
    return null;
  }
  const parts: string[] = [];
  const leaves: PaintedPage["leaves"] = [];
  const walk = (node: LayerNode | undefined, depth: number): boolean => {
    if (!node || depth > 256) return false;
    const id = `${String(node.sourceNodeId)}:${JSON.stringify(node.layer ?? null)}`;
    switch (node.kind) {
      case "group": {
        parts.push(`g${id}:${JSON.stringify(node.groupKind ?? null)}`);
        const children = node.children ?? [];
        return Array.isArray(children) && children.every((child) => walk(child as LayerNode, depth + 1));
      }
      case "clipRect":
        parts.push(`c${id}:${JSON.stringify(node.clip ?? null)}`);
        return walk(node.child as LayerNode, depth + 1);
      case "leaf": {
        parts.push(`l${id}`);
        const ops = node.ops;
        if (!Array.isArray(ops)) return false;
        const boxes: PaintBox[] = [];
        for (const op of ops) {
          const box = (op as { bbox?: unknown }).bbox;
          if (!isBox(box)) return false;
          boxes.push(box);
        }
        leaves.push({ ops: ops.map((op) => JSON.stringify(op)), boxes });
        return true;
      }
      default:
        return false;
    }
  };
  return walk(tree?.root, 0) ? { structure: parts.join("|"), leaves } : null;
}

/**
 * 앞서 그린 것(previous)에서 지금(next)으로 바뀐 곳. null이면 바뀐 것이 없다. "page"면 쪽 전체.
 * 띠는 쪽 너비 전체이고, 바뀐 연산마다 위아래로 max(8, 높이)만큼 여유를 둔다(글자 잉크가 사각형 밖으로 나가는 것).
 */
export function changedBand(previous: PaintedPage, next: PaintedPage, pageWidth: number, pageHeight: number): PaintBox | "page" | null {
  if (previous.structure !== next.structure || previous.leaves.length !== next.leaves.length) return "page";
  let top = Infinity;
  let bottom = -Infinity;
  const include = (box: PaintBox) => {
    const margin = Math.max(8, box.height);
    top = Math.min(top, box.y - margin);
    bottom = Math.max(bottom, box.y + box.height + margin);
  };
  for (let index = 0; index < next.leaves.length; index++) {
    const before = previous.leaves[index]!;
    const after = next.leaves[index]!;
    if (before.ops.length === after.ops.length && before.ops.every((op, i) => op === after.ops[i])) continue;
    // 사라진 연산과 생긴 연산(같은 연산이 순서만 바뀌었으면 잎 전체).
    const remaining = new Map<string, number>();
    for (const op of before.ops) remaining.set(op, (remaining.get(op) ?? 0) + 1);
    let added = false;
    after.ops.forEach((op, i) => {
      const count = remaining.get(op) ?? 0;
      if (count > 0) remaining.set(op, count - 1);
      else {
        include(after.boxes[i]!);
        added = true;
      }
    });
    let removed = false;
    before.ops.forEach((op, i) => {
      const count = remaining.get(op) ?? 0;
      if (count > 0) {
        remaining.set(op, count - 1);
        include(before.boxes[i]!);
        removed = true;
      }
    });
    if (!added && !removed) {
      before.boxes.forEach(include);
      after.boxes.forEach(include);
    }
  }
  if (top === Infinity) return null;
  const y = Math.max(0, top);
  const end = Math.min(pageHeight, bottom);
  if (end <= y) return null;
  return end - y >= pageHeight ? "page" : { x: 0, y, width: pageWidth, height: end - y };
}
