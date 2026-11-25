import { describe, expect, it, vi } from "vitest";
import type { RhwpDocument } from "./rhwpModule";
import { inspectRhwpHeaderFooterPicture, inspectRhwpPicture } from "./pictureProperties";

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
      width: 4050, height: 2025, originalWidth: 4050, originalHeight: 2025,
      treatAsChar: true, sizeProtect: false, hasCaption: false,
      horzFlip: false, vertFlip: false, rotationAngle: 0, horzOffset: 0, vertOffset: 0,
      cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0,
    };
    const read = (values: Record<string, unknown>) =>
      inspectRhwpPicture({ getPictureProperties: () => JSON.stringify(values) }, [0, 0, 2])?.simpleInline;
    expect(read(raw)).toBe(true);
    expect(read({ ...raw, rotationAngle: 30 })).toBe(true);
    expect(read({ ...raw, rotationAngle: 30, originalWidth: 0 })).toBe(false);
    expect(read({ ...raw, rotationAngle: 400 })).toBe(false);
    expect(read({ ...raw, horzFlip: true, rotationAngle: 30 })).toBe(false);
    expect(read({ ...raw, sizeProtect: true })).toBe(false);
    expect(read({ ...raw, cropRight: 1 })).toBe(false);
    expect(read({ ...raw, externalPath: "picture.png" })).toBe(false);
    // B5: Captioned pictures permit safe outer-object edits, while deletion stays blocked.
    expect(read({ ...raw, hasCaption: true })).toBe(true);
    const inspectedCaption = inspectRhwpPicture(
      { getPictureProperties: () => JSON.stringify({ ...raw, hasCaption: true }) },
      [0, 0, 2],
    );
    expect(inspectedCaption?.plain).toBe(true);
    expect(inspectedCaption?.deletable).toBe(false);
    const floatingCaption = inspectRhwpPicture(
      {
        getPictureProperties: () => JSON.stringify({
          ...raw, treatAsChar: false, textWrap: "Square", hasCaption: true,
          horzAlign: "Left", vertAlign: "Top", horzOffset: 100, vertOffset: 200,
        }),
      },
      [0, 0, 2],
    );
    expect(floatingCaption?.movable).toEqual({ horzOffset: 100, vertOffset: 200 });
    const deletable = (values: Record<string, unknown>) =>
      inspectRhwpPicture({ getPictureProperties: () => JSON.stringify(values) }, [0, 0, 2])?.deletable;
    expect(deletable(raw)).toBe(true);
    expect(deletable({ ...raw, sizeProtect: true })).toBe(true);
    expect(deletable({ ...raw, hasCaption: true })).toBe(false);
    expect(deletable({ ...raw, externalPath: "picture.png" })).toBe(false);
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

  it("reads a header picture only through its exact section, outer owner, and inner picture address", () => {
    const getHeaderFooterPictureProperties = vi.fn(() => JSON.stringify({
      width: 7200, height: 3600, treatAsChar: false, textWrap: "Square",
      horzAlign: "Left", vertAlign: "Top", horzOffset: 100, vertOffset: 200,
      sizeProtect: false, hasCaption: false, rotationAngle: 0, horzFlip: false, vertFlip: false,
    }));
    const doc = {
      getSectionCount: () => 2,
      getParagraphCount: (section: number) => section === 0 ? 5 : 8,
      getControls: () => JSON.stringify([{ ctrlId: "head", userDesc: "머리말", list: 0, para: 7, controlIndex: 9 }]),
      getHeaderFooterPictureProperties,
    } as unknown as RhwpDocument;
    const address = {
      section: 1, kind: "header" as const, outerParagraph: 2, outerControl: 9,
      innerParagraph: 3, innerControl: 4,
    };

    expect(inspectRhwpHeaderFooterPicture(doc, address)?.movable).toEqual({ horzOffset: 100, vertOffset: 200 });
    expect(getHeaderFooterPictureProperties).toHaveBeenCalledOnce();
    expect(getHeaderFooterPictureProperties).toHaveBeenCalledWith(1, 2, 9, 3, 4);
  });

  it.each([
    ["wrong story kind", [{ ctrlId: "foot", userDesc: "꼬리말", list: 0, para: 7, controlIndex: 9 }]],
    ["duplicate owner", [
      { ctrlId: "head", userDesc: "머리말", list: 0, para: 7, controlIndex: 9 },
      { ctrlId: "head", userDesc: "머리말", list: 0, para: 7, controlIndex: 9 },
    ]],
    ["non-body-list alias", [{ ctrlId: "head", userDesc: "머리말", list: 1, para: 7, controlIndex: 9 }]],
  ])("refuses a header/footer address with %s", (_name, controls) => {
    const getHeaderFooterPictureProperties = vi.fn(() => JSON.stringify({
      width: 7200, height: 3600, treatAsChar: false, textWrap: "Square",
    }));
    const doc = {
      getSectionCount: () => 2,
      getParagraphCount: (section: number) => section === 0 ? 5 : 8,
      getControls: () => JSON.stringify(controls),
      getHeaderFooterPictureProperties,
    } as unknown as RhwpDocument;
    expect(inspectRhwpHeaderFooterPicture(doc, {
      section: 1, kind: "header", outerParagraph: 2, outerControl: 9,
      innerParagraph: 3, innerControl: 4,
    })).toBeUndefined();
    expect(getHeaderFooterPictureProperties).not.toHaveBeenCalled();
  });
});
