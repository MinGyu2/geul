import type { ShapeProperties } from "../../commands/objectSelection";

export interface PathOverlayGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
  transform: string;
}

/** Geometry of the unturned shape, centered in the selected frame's visible bounds. */
export function pathOverlayGeometry(
  frameWidth: number,
  frameHeight: number,
  scale: number,
  shape?: Pick<ShapeProperties, "rotation" | "flipH" | "flipV" | "widthPt" | "heightPt">,
): PathOverlayGeometry {
  const validShape = shape && [shape.rotation, shape.widthPt, shape.heightPt, scale].every(Number.isFinite)
    && shape.widthPt > 0 && shape.heightPt > 0 && scale > 0;
  const width = validShape ? shape.widthPt * scale : frameWidth;
  const height = validShape ? shape.heightPt * scale : frameHeight;
  const rotation = validShape ? shape.rotation : 0;
  const flipH = validShape && shape.flipH;
  const flipV = validShape && shape.flipV;
  return {
    left: (frameWidth - width) / 2,
    top: (frameHeight - height) / 2,
    width,
    height,
    transform: `rotate(${rotation}deg) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1})`,
  };
}

/** Map pointer travel in rendered page axes back into the source path's integer lattice. */
export function pathPointFromClientDelta(
  point: { x: number; y: number },
  deltaX: number,
  deltaY: number,
  scale: number,
  viewportWidth: number,
  viewportHeight: number,
  shape?: Pick<ShapeProperties, "rotation" | "flipH" | "flipV" | "widthPt" | "heightPt">,
): { x: number; y: number } {
  const widthPt = shape && Number.isFinite(shape.widthPt) && shape.widthPt > 0 ? shape.widthPt : 1;
  const heightPt = shape && Number.isFinite(shape.heightPt) && shape.heightPt > 0 ? shape.heightPt : 1;
  const rotation = shape && Number.isFinite(shape.rotation) ? shape.rotation : 0;
  const radians = rotation * Math.PI / 180;
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  const flipX = shape?.flipH ? -1 : 1, flipY = shape?.flipV ? -1 : 1;
  const a = cosine * flipX, b = sine * flipX;
  const c = -sine * flipY, d = cosine * flipY;
  const pageX = deltaX / scale, pageY = deltaY / scale;
  // The drawing transform is R·F. Its inverse is F·R⁻¹, represented by the matrix transpose.
  const localX = a * pageX + b * pageY;
  const localY = c * pageX + d * pageY;
  return {
    x: Math.round(point.x + localX * viewportWidth / widthPt),
    y: Math.round(point.y + localY * viewportHeight / heightPt),
  };
}
