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
});
