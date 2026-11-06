// @vitest-environment jsdom
// Actual Release WASM serializer identity and snapshot reconciliation; no mocked engine response.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRhwpGeneration } from "../rhwpAssets";
import type { CharShapePrefix, RhwpDocument } from "../../src/components/Editor/rhwp/rhwpModule";

const root = resolve(__dirname, "../..");
const build = await readRhwpGeneration(join(root, "public/rhwp"), "release");
const folder = join(root, "public/rhwp/generations", build.generation);
const engine = createRequire(import.meta.url)(join(folder, "rhwp.js"));
engine.initSync({ module: readFileSync(join(folder, "rhwp_bg.wasm")) });

type Format = "hwp" | "hwpx";
type Document = RhwpDocument & {
  createBlankDocument(): void;
  charShapeCount(): number;
  captureCharShapePrefix(): CharShapePrefix;
  capturePublishingCharShapePrefix(exported: RhwpDocument): CharShapePrefix;
  reconcileCharShapePrefix(prefix: CharShapePrefix, originalCount: number): string;
  compactAppendedCharShapes(baseline: number): string;
  createTable?(...args: number[]): string;
  insertTextInCell(...args: [number, number, number, number, number, number, string]): string;
  applyCharFormatInCell(...args: [number, number, number, number, number, number, number, string]): string;
  saveSnapshot(): number;
  restoreSnapshot(id: number): string;
  discardSnapshot(id: number): void;
  getControls(): string;
  getTextFileText(): string;
  getCellCharPropertiesAt(...args: [number, number, number, number, number, number]): string;
  getSourceFormat(): string;
};
const bytes = (doc: Document, format: Format) => {
  const exp = format === "hwp" ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
  try { return exp.takeBytes(); } finally { exp.free(); }
};
function seed(format: Format) {
  const doc = engine.HwpDocument.createEmpty() as Document;
  doc.createBlankDocument();
  const table = JSON.parse(doc.createTable!(0, 0, 0, 2, 2)) as { paraIdx: number; controlIdx: number };
  doc.insertTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, "10");
  doc.insertTextInCell(0, table.paraIdx, table.controlIdx, 1, 0, 0, "20");
  const source = bytes(doc, format);
  doc.free();
  return { source, parent: table.paraIdx, control: table.controlIdx };
}
function open(source: Uint8Array): Document { return new engine.HwpDocument(source) as Document; }
function props(doc: Document, parent: number, control: number) {
  return JSON.parse(doc.getCellCharPropertiesAt(0, parent, control, 0, 0, 0));
}
function identityState(doc: Document, parent: number, control: number) {
  return {
    count: doc.charShapeCount(),
    sourceFormat: doc.getSourceFormat(),
    text: doc.getTextFileText(),
    controls: doc.getControls(),
    properties: props(doc, parent, control),
  };
}
function edit(doc: Document, parent: number, control: number, format: Format, sequence: "width" | "spacing" | "bold" | "width-bold" | "bold-spacing") {
  const actions: Record<typeof sequence, Record<string, unknown>[]> = {
    width: [{ ratios: Array(7).fill(150) }],
    spacing: [{ spacings: Array(7).fill(10) }],
    bold: [{ bold: true }],
    "width-bold": [{ ratios: Array(7).fill(150) }, { bold: true }],
    "bold-spacing": [{ bold: true }, { spacings: Array(7).fill(10) }],
  };
  for (const action of actions[sequence]) {
    doc.applyCharFormatInCell(0, parent, control, 0, 0, 0, 1, JSON.stringify(action));
    const response = JSON.parse(doc.compactAppendedCharShapes(7));
    expect(response).toMatchObject({ ok: true });
  }
  expect(doc.getSourceFormat()).toBe(format);
}

describe(`Release WASM publication identity ${build.generation}`, () => {
  for (const format of ["hwp", "hwpx"] as const) {
    it.each(["width", "spacing", "bold", "width-bold", "bold-spacing"] as const)(`${format} validates serializer identity and reconciles an Undo snapshot after %s`, sequence => {
      const fixture = seed(format);
      const live = open(fixture.source);
      const initialCount = live.charShapeCount();
      const snapshot = live.saveSnapshot();
      let prefix: CharShapePrefix | null = null;
      let reopened: Document | null = null;
      try {
        edit(live, fixture.parent, fixture.control, format, sequence);
        const beforeExport = identityState(live, fixture.parent, fixture.control);
        const output = bytes(live, format);
        reopened = open(output);
        expect(reopened.getSourceFormat()).toBe(format);
        expect(reopened.getTextFileText()).toBe(beforeExport.text);
        expect(reopened.getControls()).toBe(beforeExport.controls);
        expect(props(reopened, fixture.parent, fixture.control)).toEqual(beforeExport.properties);

        // HWP raw/provenance may differ after serialization while effective writer bytes match;
        // the engine API validates the actual format-specific serializer projection.
        if (format === "hwp") {
          const rawPrefix = live.captureCharShapePrefix();
          try { expect(() => reopened!.reconcileCharShapePrefix(rawPrefix, live.charShapeCount())).toThrow(); }
          finally { rawPrefix.free(); }
        }
        prefix = live.capturePublishingCharShapePrefix(reopened);
        expect(prefix).toBeTruthy();
        live.restoreSnapshot(snapshot);
        expect(JSON.parse(live.reconcileCharShapePrefix(prefix, initialCount))).toEqual({ ok: true });
        expect(props(live, fixture.parent, fixture.control).ratios).toEqual(Array(7).fill(100));
        expect(props(live, fixture.parent, fixture.control).spacings).toEqual(Array(7).fill(0));
        expect(live.charShapeCount()).toBeGreaterThanOrEqual(reopened.charShapeCount());
      } finally {
        prefix?.free();
        reopened?.free();
        live.discardSnapshot(snapshot);
        live.free();
      }
    });

    it(`${format} rejects same-count semantically different tables before mutating either document`, () => {
      const fixture = seed(format);
      const left = open(fixture.source), right = open(fixture.source);
      try {
        edit(left, fixture.parent, fixture.control, format, "width");
        edit(right, fixture.parent, fixture.control, format, "bold");
        const leftBefore = identityState(left, fixture.parent, fixture.control);
        const rightBefore = identityState(right, fixture.parent, fixture.control);
        expect(left.charShapeCount()).toBe(right.charShapeCount());
        expect(leftBefore.properties.ratios).not.toEqual(rightBefore.properties.ratios);
        expect(() => left.capturePublishingCharShapePrefix(right)).toThrow();
        expect(identityState(left, fixture.parent, fixture.control)).toEqual(leftBefore);
        expect(identityState(right, fixture.parent, fixture.control)).toEqual(rightBefore);
      } finally { left.free(); right.free(); }
    });

    it(`${format} rejects shorter and longer exported tables without mutating the live document`, () => {
      const fixture = seed(format);
      const original = open(fixture.source), modified = open(fixture.source);
      try {
        edit(modified, fixture.parent, fixture.control, format, "width");
        const oldState = identityState(original, fixture.parent, fixture.control);
        const newState = identityState(modified, fixture.parent, fixture.control);
        expect(newState.count).toBeGreaterThan(oldState.count);
        expect(() => modified.capturePublishingCharShapePrefix(original)).toThrow();
        expect(() => original.capturePublishingCharShapePrefix(modified)).toThrow();
        expect(identityState(original, fixture.parent, fixture.control)).toEqual(oldState);
        expect(identityState(modified, fixture.parent, fixture.control)).toEqual(newState);
      } finally { original.free(); modified.free(); }
    });
  }

  it("rejects cross-format identity and leaves both documents unchanged", () => {
    const hwp = seed("hwp"), hwpx = seed("hwpx");
    const left = open(hwp.source), right = open(hwpx.source);
    try {
      const beforeLeft = identityState(left, hwp.parent, hwp.control);
      const beforeRight = identityState(right, hwpx.parent, hwpx.control);
      expect(() => left.capturePublishingCharShapePrefix(right)).toThrow();
      expect(identityState(left, hwp.parent, hwp.control)).toEqual(beforeLeft);
      expect(identityState(right, hwpx.parent, hwpx.control)).toEqual(beforeRight);
    } finally { left.free(); right.free(); }
  });
});
