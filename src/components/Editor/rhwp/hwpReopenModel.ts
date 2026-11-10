import type { RhwpDocument } from "./rhwpModule";
import { canonical } from "./rhwpArtifactIdentity";

type JsonObject = Record<string, unknown>;
export interface HwpReopenModel { model: string; structure: string; complete: boolean }

/** Supplement the raw controls/text comparison with the supported HWP model.
 * No mutation, image hash supplied by the caller, or inferred WASM API is used.
 * Optional APIs may be absent for legacy edits; a changed structural inventory
 * requires complete evidence. The Rust preservation proof remains authoritative.
 */
export function hwpReopenModel(doc: RhwpDocument): HwpReopenModel {
  let budget = 32 * 1024 * 1024;
  let nodes = 100_000;
  let complete = !!doc.getSectionCount && !!doc.getParaPropertiesAt;
  const spend = (n: number) => { budget -= n; if (budget < 0) throw new Error("HWP comparison budget"); };
  const count = (n: unknown, max = 100_000): number => {
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > max) throw new Error("HWP model count");
    return n;
  };
  const node = () => { if (--nodes < 0) throw new Error("HWP comparison nodes"); };
  const json = (raw: string): unknown => { spend(raw.length * 2); return JSON.parse(raw); };
  const object = (v: unknown): JsonObject => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("HWP model object");
    return v as JsonObject;
  };
  const optional = (read: (() => string) | undefined) => {
    if (!read) { complete = false; return null; }
    return object(json(read()));
  };
  const controls = json(doc.getControls!());
  if (!Array.isArray(controls) || controls.length > 100_000) throw new Error("HWP controls");
  const bullets = doc.getBulletList ? json(doc.getBulletList()) : null;
  if (bullets !== null && !Array.isArray(bullets)) throw new Error("HWP bullets");
  const bulletById = new Map<number, JsonObject>();
  if (Array.isArray(bullets)) for (const value of bullets) {
    const b = object(value); const id = count(b.id);
    if (bulletById.has(id) || typeof b.char !== "string" || typeof b.rawCode !== "number") throw new Error("HWP bullet definition");
    const definition = { ...b }; delete definition.id;
    bulletById.set(id, definition);
  }
  const headings: unknown[] = [];
  const sections: unknown[] = [];
  const sectionCount = doc.getSectionCount ? count(doc.getSectionCount(), 4096) : 1;
  for (let s = 0; s < sectionCount; s++) {
    const paragraphs: unknown[] = [];
    for (let p = 0, n = count(doc.getParagraphCount(s)); p < n; p++) {
      node();
      const properties = optional(doc.getParaPropertiesAt && (() => doc.getParaPropertiesAt!(s, p)));
      if (properties) {
        // Serialization may intern equivalent ParaShapes under another index.
        delete properties.paraShapeId;
        if (properties.headType === "Bullet") {
          const definition = bulletById.get(count(properties.numberingId));
          if (!definition) complete = false;
          else { delete properties.numberingId; properties.bullet = definition; }
        }
        if (properties.headType !== "None") headings.push(properties);
      }
      const length = count(doc.getParagraphLength(s, p), 2_000_000);
      const text = doc.getTextRange(s, p, 0, length); spend(text.length * 2);
      paragraphs.push({ text, properties });
    }
    sections.push(paragraphs);
  }
  const tables: unknown[] = [];
  const pictures: unknown[] = [];
  const inventory: unknown[] = [];
  let paragraphBase = 0;
  const sectionEnds = Array.from({ length: sectionCount }, (_, s) => {
    paragraphBase += count(doc.getParagraphCount(s)); return paragraphBase;
  });
  for (const value of controls) {
    node(); const c = object(value);
    if (c.ctrlId === "secd" || c.ctrlId === "cold") continue;
    inventory.push({ kind: c.ctrlId, type: c.userDesc, list: c.list, props: c.props });
    if (c.list !== 0) { complete = false; continue; } // legacy nested controls retain raw comparison
    const global = count(c.para);
    // getControls uses global root paragraph numbers; table APIs use section-local ones.
    let low = 0, high = sectionEnds.length;
    while (low < high) { const mid = (low + high) >>> 1; if (global < sectionEnds[mid]!) high = mid; else low = mid + 1; }
    const section = low;
    if (section === sectionEnds.length) throw new Error("HWP control location");
    const p = global - (section === 0 ? 0 : sectionEnds[section - 1]!);
    const control = count(c.controlIndex);
    if (c.ctrlId === "tbl") {
      const dimensions = object(json(doc.getTableDimensions(section, p, control)));
      count(dimensions.rowCount, 4096); count(dimensions.colCount, 4096);
      const cells: unknown[] = [];
      for (let cell = 0, n = count(dimensions.cellCount); cell < n; cell++) {
        node(); const paragraphs: string[] = [];
        for (let cp = 0, n = count(doc.getCellParagraphCount(section, p, control, cell)); cp < n; cp++) {
          node(); const length = count(doc.getCellParagraphLength(section, p, control, cell, cp), 2_000_000);
          const text = doc.getTextInCell(section, p, control, cell, cp, 0, length); spend(text.length * 2); paragraphs.push(text);
        }
        const coordinates = optional(doc.getCellInfo && (() => doc.getCellInfo!(section, p, control, cell)));
        const properties = optional(doc.getCellProperties && (() => doc.getCellProperties!(section, p, control, cell)));
        // Resolved border/fill attributes, rather than a serialization-local ID.
        if (properties) delete properties.borderFillId;
        cells.push({ coordinates, properties, paragraphs });
      }
      const properties = optional(doc.getTableProperties && (() => doc.getTableProperties!(section, p, control)));
      if (properties) delete properties.borderFillId;
      tables.push({ dimensions, properties, cells });
    } else if (c.ctrlId === "gso" && c.userDesc === "그림") {
      pictures.push(optional(doc.getPictureProperties && (() => doc.getPictureProperties!(section, p, control))));
    } else complete = false;
  }
  return { model: canonical({ sections, tables, pictures }), structure: canonical({ inventory, headings }), complete };
}

export function hwpReopenEqual(live: HwpReopenModel, reopened: HwpReopenModel, baseline: string | null): boolean {
  const changed = baseline === null || live.structure !== baseline;
  return live.model === reopened.model && live.structure === reopened.structure
    && (!changed || (live.complete && reopened.complete));
}
