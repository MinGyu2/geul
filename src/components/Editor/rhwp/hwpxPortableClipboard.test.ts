import { describe, expect, it, vi } from "vitest";
import type { HwpxPortableShape } from "../../../commands/objectClipboard";
import type { RhwpDocument } from "./rhwpModule";
import { insertDocxPortableShapeIntoHwp5 } from "./hwpxPortableClipboard";

const portable: HwpxPortableShape = {
  kind: "shape", shapeType: "ellipse", width: 7761, height: 4586, horzOffset: 0, vertOffset: 0,
  treatAsChar: true, textWrap: "Square", rotationAngle: 90, horzFlip: false, vertFlip: true,
  borderColor: 0x00332211, borderWidth: 35, lineType: 1, fillType: "solid", fillBgColor: 0x004488cc,
  description: "Transfer shape",
};

function target(options: { ownerCount?: number; paragraphCount?: number; paragraphCountAfterInsert?: number } = {}) {
  const insertedProperties: Record<string, unknown> = {
    shapeType: portable.shapeType,
    width: portable.width,
    height: portable.height,
    horzOffset: portable.horzOffset,
    vertOffset: portable.vertOffset,
    treatAsChar: portable.treatAsChar,
    textWrap: portable.textWrap,
    lineEndShape: 1,
    arrowStart: 0,
    arrowEnd: 0,
    borderOutlineStyle: 0,
    roundRate: 0,
    shadowType: 0,
    fillAlpha: 0,
    fillPatType: 0,
    hasCaption: false,
  };
  let ownerCount = options.ownerCount ?? 1;
  let paragraphCount = options.paragraphCount ?? 1;
  const createShapeControl = vi.fn((serialized: string) => {
    const input = JSON.parse(serialized) as Record<string, unknown>;
    Object.assign(insertedProperties, {
      shapeType: input.shapeType,
      width: input.width,
      height: input.height,
      horzOffset: input.horzOffset,
      vertOffset: input.vertOffset,
      treatAsChar: input.treatAsChar,
      textWrap: input.textWrap,
    });
    if (options.paragraphCountAfterInsert !== undefined) paragraphCount = options.paragraphCountAfterInsert;
    return JSON.stringify({ ok: true, paraIdx: 0, controlIdx: 3 });
  });
  const setShapeProperties = vi.fn((_section: number, _paragraph: number, _control: number, serialized: string) => {
    Object.assign(insertedProperties, JSON.parse(serialized));
    return '{"ok":true}';
  });
  const getControls = vi.fn(() => JSON.stringify(Array.from({ length: ownerCount }, () => ({
    list: 0, para: 0, controlIndex: 3, ctrlId: "gso", userDesc: "타원",
    section: 0, props: { Width: portable.width, Height: portable.height, TreatAsChar: 1 },
  }))));
  const doc = {
    createShapeControl, setShapeProperties, getControls,
    getParagraphCount: () => paragraphCount,
    getShapeProperties: () => JSON.stringify(insertedProperties),
  } as unknown as RhwpDocument;
  return { doc, createShapeControl, setShapeProperties, getControls, setOwnerCount: (count: number) => { ownerCount = count; } };
}

describe("DOCX portable shape to HWP5", () => {
  it("creates one body-owned HWP5 drawing and verifies geometry, transform and style before accepting it", () => {
    const fixture = target();
    const result = insertDocxPortableShapeIntoHwp5(fixture.doc, { section: 0, paragraph: 0, offset: 1 }, portable);

    expect(fixture.createShapeControl).toHaveBeenCalledOnce();
    expect(fixture.setShapeProperties).toHaveBeenCalledWith(0, 0, 3, expect.stringContaining('"rotationAngle":90'));
    expect(result).toEqual({ paraIdx: 0, controlIdx: 3 });
    expect(fixture.getControls).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-body, unsupported shape, changed paragraph owner, or ambiguous HWP5 owner", () => {
    const fixture = target();
    expect(() => insertDocxPortableShapeIntoHwp5(fixture.doc, { section: 1, paragraph: 0, offset: 1 }, portable)).toThrow();
    expect(fixture.createShapeControl).not.toHaveBeenCalled();

    expect(() => insertDocxPortableShapeIntoHwp5(fixture.doc, { section: 0, paragraph: 0, offset: 1 }, {
      ...portable, shapeType: "polygon",
    })).toThrow();
    expect(fixture.createShapeControl).not.toHaveBeenCalled();

    const changedParagraphs = target({ paragraphCountAfterInsert: 2 });
    expect(() => insertDocxPortableShapeIntoHwp5(
      changedParagraphs.doc, { section: 0, paragraph: 0, offset: 1 }, portable,
    )).toThrow(/paragraph ownership/);

    fixture.setOwnerCount(2);
    expect(() => insertDocxPortableShapeIntoHwp5(fixture.doc, { section: 0, paragraph: 0, offset: 1 }, portable)).toThrow(/owner/);
  });
});
