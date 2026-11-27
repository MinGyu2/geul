import { describe, expect, it } from "vitest";
import { inspectHwp5CaptionLayout } from "./hwp5CaptionLayout";

const properties = (overrides: Record<string, unknown> = {}) => ({
  hasCaption: true,
  captionDirection: "Bottom",
  captionVertAlign: "Top",
  captionWidth: 2400,
  captionSpacing: 100,
  captionMaxWidth: 6000,
  captionIncludeMargin: false,
  width: 6000,
  treatAsChar: false,
  textWrap: "Square",
  rotationAngle: 0,
  horzFlip: false,
  vertFlip: false,
  ...overrides,
});

describe("HWP5 caption layout inspection", () => {
  it("admits modeled caption direction and lateral alignment on a plain floating owner", () => {
    expect(inspectHwp5CaptionLayout(properties())).toEqual({
      side: "Bottom", verticalAlign: "Top", lateral: true,
    });
  });

  it.each([
    { treatAsChar: true },
    { textWrap: "Through" },
    { rotationAngle: 90 },
    { horzFlip: true },
    { captionIncludeMargin: true },
    { captionWidth: 0 },
    { captionSpacing: -1 },
    { width: 0x7fff_ffff },
  ])("keeps lateral placement unavailable for an unproven geometry envelope %#", overrides => {
    expect(inspectHwp5CaptionLayout(properties(overrides))).toMatchObject({ side: "Bottom", lateral: false });
  });

  it.each([
    { hasCaption: false },
    { captionDirection: "Diagonal" },
    { captionVertAlign: "Middle" },
    { captionSpacing: 32768 },
    { externalPath: "external.emf" },
  ])("rejects incomplete or unsupported caption state %#", overrides => {
    expect(inspectHwp5CaptionLayout(properties(overrides))).toBeUndefined();
  });
});
