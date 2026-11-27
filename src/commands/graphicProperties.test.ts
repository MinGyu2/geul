import { describe, expect, it } from "vitest";
import { parseGraphicProperties } from "./graphicProperties";

describe("graphic inspection boundary", () => {
  it("keeps the written numeric strings and allows empty chart points", () => {
    const chart = { kind: "chart", plot: "bar", title: "Chart", labels: ["A", "B"], series: [{ name: null, values: ["3.20", null] }] };
    expect(parseGraphicProperties(chart)).toEqual(chart);
    expect(parseGraphicProperties({ ...chart, series: [{ name: null, values: [3.2] }] })).toBeUndefined();
    expect(parseGraphicProperties({ ...chart, labels: Array(129).fill("label") })).toBeUndefined();
  });

  it("retains bounded SmartArt outline order and levels", () => {
    const art = { kind: "smartArt", layout: "hierarchy", items: [{ text: "Main", level: 0 }, { text: "Child", level: 1 }] };
    expect(parseGraphicProperties(art)).toEqual(art);
    expect(parseGraphicProperties({ ...art, items: [{ text: "invalid", level: -1 }] })).toBeUndefined();
  });

  it("treats a null SmartArt model id as omitted", () => {
    const art = { kind: "smartArt", layout: "process", modelId: null, colors: "accent1", items: [{ text: "Plan", level: 0 }] };
    expect(parseGraphicProperties(art)).toEqual({
      kind: "smartArt", layout: "process", colors: "accent1", items: [{ text: "Plan", level: 0 }],
    });
  });

  it("preserves stable SmartArt point identities, supported properties and node styling", () => {
    const id = "{10000000-0000-4000-8000-000000000001}";
    const art = {
      kind: "smartArt", layout: "basicList", modelId: id, colors: "colorful",
      items: [{
        text: "Main", level: 0,
        additionalData: {
          modelId: id, connectionId: "{10000000-0000-4000-8000-000000000002}",
          parentTransitionId: "{10000000-0000-4000-8000-000000000003}",
          siblingTransitionId: "{10000000-0000-4000-8000-000000000004}",
          properties: { presName: "Primary", presStyleIdx: "2", phldr: "0" },
        },
        style: { fill: "AABBCC", line: "scheme:tx1", lineWidth: 9525,
          text: { color: "scheme:lt1", bold: true, italic: false, fontSize: 1400, language: "ko-KR" } },
      }],
    };
    expect(parseGraphicProperties(art)).toEqual(art);
    expect(parseGraphicProperties({ ...art, items: [{ ...art.items[0]!, style: { ...art.items[0]!.style, glow: true } }] })).toBeUndefined();
    expect(parseGraphicProperties({ ...art, items: [{ ...art.items[0]!, additionalData: { properties: { undocumented: "x" } } }] })).toBeUndefined();
  });
});
