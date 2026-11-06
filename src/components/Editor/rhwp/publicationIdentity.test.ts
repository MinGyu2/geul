import { describe, expect, it } from "vitest";
import type { CharShapePrefix, RhwpDocument } from "./rhwpModule";
import { RhwpText } from "./rhwpText";

type FakePrefix = CharShapePrefix & { id: string };
type TestDoc = Partial<RhwpDocument> & {
  charShapeCount?: () => number;
  captureCharShapePrefix?: () => CharShapePrefix;
  reconcileCharShapePrefix?: (prefix: CharShapePrefix, originalCount: number) => string;
  capturePublishingCharShapePrefix?: (exported: RhwpDocument) => CharShapePrefix;
  compactAppendedCharShapes?: (baseline: number) => string;
};

function fixture(options: {
  count?: number;
  initialCapture?: () => CharShapePrefix;
  publishCapture?: (exported: RhwpDocument) => CharShapePrefix;
  reconcile?: (prefix: CharShapePrefix, originalCount: number) => string;
  withPublicationApi?: boolean;
} = {}) {
  let count = options.count ?? 3;
  let next = 0;
  const compacted: number[] = [];
  const initial = options.initialCapture ?? (() => ({ id: "initial", free() { initialFrees += 1; } } as FakePrefix));
  let initialFrees = 0;
  const doc: TestDoc = {
    charShapeCount: () => count,
    captureCharShapePrefix: initial,
    reconcileCharShapePrefix: options.reconcile ?? (() => '{"ok":true}'),
    compactAppendedCharShapes: baseline => {
      compacted.push(baseline);
      return JSON.stringify({ ok: true, before: count, after: count, skipped: null });
    },
  };
  if (options.withPublicationApi !== false) {
    doc.capturePublishingCharShapePrefix = options.publishCapture ?? (() => ({
      id: `published-${++next}`,
      free() { publishedFrees += 1; },
    } as FakePrefix));
  }
  let publishedFrees = 0;
  const text = new RhwpText(doc as RhwpDocument);
  const exported = (exportedCount = count): RhwpDocument => ({ charShapeCount: () => exportedCount } as unknown as RhwpDocument);
  const protect = (reportedCount: number | null, snapshot: RhwpDocument = exported()) =>
    (text.protectPublishingCharShapes as unknown as (count: number | null, exported: RhwpDocument) => () => void)(reportedCount, snapshot);
  return {
    text, doc, protect, exported,
    setCount(value: number) { count = value; },
    compacted,
    get initialFrees() { return initialFrees; },
    get publishedFrees() { return publishedFrees; },
  };
}

describe("RHWP publication prefix identity contract", () => {
  it("does not advance the numeric baseline without an active identity lease", () => {
    const f = fixture();
    f.text.markPublishedCharShapes(5);
    f.setCount(5);
    f.text.prepareExport();
    expect(f.compacted.at(-1)).toBe(3);
    f.text.release();
  });

  it.each([2, 4])("rejects an exported definition count %i when the live count is 3", count => {
    const f = fixture();
    expect(() => f.protect(count, f.exported(count))).toThrow();
    expect(f.publishedFrees).toBe(0);
    f.text.release();
  });

  it("rejects equal counts when the engine reports different definition identity", () => {
    const f = fixture({ publishCapture: () => { throw new Error("identity mismatch"); } });
    expect(() => f.protect(3, f.exported(3))).toThrow("identity mismatch");
    expect(f.publishedFrees).toBe(0);
    f.text.release();
    expect(f.initialFrees).toBe(1);
  });

  it("fails closed when publication identity validation is unavailable", () => {
    const f = fixture({ withPublicationApi: false });
    expect(() => f.protect(3, f.exported(3))).toThrow();
    f.text.release();
  });

  it("rejects a malformed publishing prefix and keeps ownership bounded", () => {
    const f = fixture({ publishCapture: () => ({}) as CharShapePrefix });
    expect(() => f.protect(3, f.exported(3))).toThrow();
    expect(f.publishedFrees).toBe(0);
    f.text.release();
    expect(f.initialFrees).toBe(1);
  });

  it("promotes a validated lease even when later edits increase the live count", () => {
    const f = fixture();
    const release = f.protect(3, f.exported(3));
    f.setCount(5); // Subsequent edits do not invalidate the already exported revision.
    f.text.markPublishedCharShapes(3);
    f.text.prepareExport();
    expect(f.compacted.at(-1)).toBe(3);
    release();
    expect(f.publishedFrees).toBe(0); // The captured prefix is now owned by publication.
    f.text.release();
    expect(f.publishedFrees).toBe(1); // Final cleanup freed the transferred prefix once.
    expect(f.initialFrees).toBe(1);
  });

  it("does not promote a different count or a released failed-save lease", () => {
    const f = fixture();
    const release = f.protect(3, f.exported(3));
    release(); // Backend publication failed.
    f.text.markPublishedCharShapes(5);
    f.setCount(5);
    f.text.prepareExport();
    expect(f.compacted.at(-1)).toBe(3);
    f.text.release();
    expect(f.publishedFrees).toBe(1);
  });

  it("releases the superseded published prefix after a successful second save", () => {
    const f = fixture();
    const first = f.protect(3, f.exported(3));
    f.text.markPublishedCharShapes(3);
    first();
    const second = f.protect(3, f.exported(3));
    f.text.markPublishedCharShapes(3);
    expect(f.publishedFrees).toBe(1);
    second();
    f.text.release();
    expect(f.publishedFrees).toBe(2);
    expect(f.initialFrees).toBe(1);
  });
});
