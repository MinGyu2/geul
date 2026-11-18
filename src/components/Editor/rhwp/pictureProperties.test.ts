import { describe, expect, it, vi } from "vitest";
import type { RhwpDocument } from "./rhwpModule";
import { inspectRhwpPicture } from "./pictureProperties";

describe("RHWP picture property inspection", () => {
  it("reads the selected body picture through its engine address and converts HWPUNIT to points", () => {
    const getPictureProperties = vi.fn(() => JSON.stringify({
      width: 7200,
      height: 3600,
      treatAsChar: false,
      textWrap: "Tight",
      description: "사진 설명",
    }));
    const doc = { getPictureProperties } as unknown as Pick<RhwpDocument, "getPictureProperties">;

    expect(inspectRhwpPicture(doc, [1, 7, 12])?.properties).toEqual({
      widthPt: 72,
      heightPt: 36,
      wrap: "tight",
      description: "사진 설명",
    });
    expect(getPictureProperties).toHaveBeenCalledOnce();
    expect(getPictureProperties).toHaveBeenCalledWith(1, 7, 12);
  });

  it("maps inline pictures to inline wrapping even when their floating wrap is not used", () => {
    const doc = {
      getPictureProperties: () => JSON.stringify({
        width: 7200, height: 3600, treatAsChar: true, textWrap: "Unknown",
      }),
    } as unknown as Pick<RhwpDocument, "getPictureProperties">;

    expect(inspectRhwpPicture(doc, [0, 0, 0])?.properties).toMatchObject({ widthPt: 72, heightPt: 36, wrap: "inline" });
  });

  it("admits only plain unprotected inline pictures for size editing", () => {
    const raw = {
      width: 4050, height: 2025, treatAsChar: true, sizeProtect: false, hasCaption: false,
      horzFlip: false, vertFlip: false, rotationAngle: 0, horzOffset: 0, vertOffset: 0,
      cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0,
    };
    const read = (values: Record<string, unknown>) =>
      inspectRhwpPicture({ getPictureProperties: () => JSON.stringify(values) }, [0, 0, 2])?.simpleInline;
    expect(read(raw)).toBe(true);
    expect(read({ ...raw, sizeProtect: true })).toBe(false);
    expect(read({ ...raw, cropRight: 1 })).toBe(false);
    expect(read({ ...raw, externalPath: "picture.png" })).toBe(false);
    expect(read({ ...raw, hasCaption: true })).toBe(false);
  });

  it.each([
    ["malformed JSON", "{\"width\":"],
    ["non-object JSON", "null"],
    ["array JSON", "[]"],
    ["non-finite width", '{"width":1e400,"height":3600,"treatAsChar":false,"textWrap":"Square"}'],
    ["zero width", JSON.stringify({ width: 0, height: 3600, treatAsChar: false, textWrap: "Square" })],
    ["negative height", JSON.stringify({ width: 7200, height: -1, treatAsChar: false, textWrap: "Square" })],
    ["fractional width", JSON.stringify({ width: 7200.5, height: 3600, treatAsChar: false, textWrap: "Square" })],
    ["oversized width", JSON.stringify({ width: 2 ** 32, height: 3600, treatAsChar: false, textWrap: "Square" })],
    ["unknown floating wrap", JSON.stringify({ width: 7200, height: 3600, treatAsChar: false, textWrap: "Around" })],
  ])("rejects %s", (_name, result) => {
    const doc = { getPictureProperties: () => result } as unknown as Pick<RhwpDocument, "getPictureProperties">;
    expect(inspectRhwpPicture(doc, [0, 2, 3])).toBeUndefined();
  });

  it("returns no properties when the engine getter is unavailable or fails", () => {
    expect(inspectRhwpPicture({}, [0, 2, 3])).toBeUndefined();
    expect(inspectRhwpPicture({ getPictureProperties: () => { throw new Error("unavailable"); } }, [0, 2, 3])).toBeUndefined();
  });
});
