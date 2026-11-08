// Read-only projection of validated top-level table geometry and paragraph ownership.
// Authoritative contracts: field_query.rs collect_fields_and_lists, hwpctrl_sets.rs
// collect_controls, table_ops.rs get_cell (first paragraph, exact anchor coordinate).
// No field-list omission is interpreted as "plain": the complete control inventory
// must independently be empty. Unknown/nested structures fail closed. Covered merged
// coordinates have no value in RHWP (table_ops.rs exact-anchor lookup), not an alias.
import { formulaDependencies, MAX_FORMULA_CELL_VISITS } from "../../../commands/parameters";
import type { RhwpDocument } from "./rhwpModule";
import type { DocPosition } from "./rhwpText";

type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => typeof v === "object" && v !== null && !Array.isArray(v);
const index = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
function read(text: string): unknown {
  if (text.length > MAX_METADATA_BYTES) return null;
  return JSON.parse(text) as unknown;
}
function entries(v: unknown): v is RecordValue[] {
  return Array.isArray(v) && v.length <= MAX_FORMULA_CELL_VISITS && v.every(record);
}
export type FormulaSafety = "safe" | "cycle" | "unknown";

export function tableFormulaSafety(doc: RhwpDocument, at: DocPosition, proposed: string): FormulaSafety {
  try { return project(doc, at, proposed); }
  catch (error) {
    if (error instanceof WebAssembly.RuntimeError) throw error;
    return "unknown";
  }
}
function project(doc: RhwpDocument, at: DocPosition, proposed: string): FormulaSafety {
  const cell = at.cell;
  if (!cell || cell.cellParagraph !== 0 || !doc.getCursorModel || !doc.getControls || !doc.getFieldList
    || !doc.getCellInfo || !doc.validateTableFormulaField) return "unknown";
  const dimensions = read(doc.getTableDimensions(at.section, cell.parentParagraph, cell.control));
  if (!record(dimensions)) return "unknown";
  const { rowCount: rows, colCount: cols, cellCount: count } = dimensions;
  if (!index(rows) || !index(cols) || !index(count) || !rows || !cols || rows > MAX_FORMULA_CELL_VISITS / cols
    || !count || count > rows * cols) return "unknown";
  const model = read(doc.getCursorModel()), controls = read(doc.getControls()), fields = read(doc.getFieldList());
  if (!record(model) || !entries(model.lists) || !entries(controls) || !entries(fields)) return "unknown";
  // Reject malformed identities even when their ownership cannot be located.
  if (!model.lists.every(l => [l.listId, l.hostListId, l.sectionIndex, l.hostPara, l.controlIndex, l.cellIndex, l.paraCount].every(index))
    || !controls.every(c => [c.list, c.para, c.controlIndex].every(index))
    || !fields.every(f => record(f.location) && index(f.location.sectionIndex) && index(f.location.paraIndex))) return "unknown";
  const lists = model.lists.filter(l => l.sectionIndex === at.section && l.hostListId === 0
    && l.hostPara === cell.parentParagraph && l.controlIndex === cell.control);
  if (lists.length !== count) return "unknown";
  const cellLists = new Map<number, number>(), coordinates = new Map<number, number>();
  const listIds = new Set<number>(), coordinateKeys = new Set<number>();
  const coverage = new Set<number>();
  let paragraphs = 0;
  for (const l of lists) {
    const physical = l.cellIndex as number;
    if (l.isCell !== true || (!index(l.paraCount) || l.paraCount === 0) || physical >= count || cellLists.has(physical)
      || !index(l.listId) || l.listId < 2 || listIds.has(l.listId)) return "unknown";
    const geometry = read(doc.getCellInfo(at.section, cell.parentParagraph, cell.control, physical));
    if (!record(geometry) || !index(geometry.row) || !index(geometry.col) || geometry.row >= rows || geometry.col >= cols
      || !index(geometry.rowSpan) || !index(geometry.colSpan) || !geometry.rowSpan || !geometry.colSpan
      || geometry.row + geometry.rowSpan > rows || geometry.col + geometry.colSpan > cols
      || l.row !== geometry.row || l.col !== geometry.col
      || l.rowSpan !== geometry.rowSpan || l.colSpan !== geometry.colSpan || l.cellCount !== count
      || doc.getCellParagraphCount(at.section, cell.parentParagraph, cell.control, physical) !== l.paraCount) return "unknown";
    paragraphs += l.paraCount as number;
    if (paragraphs > MAX_FORMULA_CELL_VISITS) return "unknown";
    for (let row = geometry.row; row < geometry.row + geometry.rowSpan; row++) {
      for (let col = geometry.col; col < geometry.col + geometry.colSpan; col++) {
        const covered = row * cols + col;
        if (coverage.has(covered)) return "unknown";
        coverage.add(covered);
      }
    }
    const coordinate = geometry.row * cols + geometry.col;
    if (coordinateKeys.has(coordinate)) return "unknown";
    listIds.add(l.listId); coordinateKeys.add(coordinate);
    cellLists.set(physical, l.listId); coordinates.set(physical, coordinate);
  }
  if (coverage.size !== rows * cols) return "unknown";
  const destination = coordinates.get(cell.cell);
  if (destination === undefined) return "unknown";
  const tableFields = new Map<number, RecordValue>();
  const ids = new Set<number>();
  for (const f of fields) {
    const loc = f.location as RecordValue;
    if (loc.sectionIndex !== at.section || loc.paraIndex !== cell.parentParagraph) continue;
    if (loc.path === undefined) continue; // a body field is not a cell value
    if (!Array.isArray(loc.path) || !loc.path.every(record)) return "unknown";
    const part = loc.path[0];
    if (!part || !index(part.controlIndex)) return "unknown";
    if (part.controlIndex !== cell.control) continue;
    if (loc.path.length !== 1 || part.type !== "cell" || part.paraIndex !== 0 || !index(part.cellIndex)
      || !cellLists.has(part.cellIndex) || tableFields.has(part.cellIndex) || f.fieldType !== "formula" || f.cellField !== false
      || !index(f.fieldId) || f.fieldId === 0 || ids.has(f.fieldId) || f.listId !== cellLists.get(part.cellIndex)
      || f.paraInList !== 0) return "unknown";
    ids.add(f.fieldId); tableFields.set(part.cellIndex, f);
  }
  const inventory = new Map<number, RecordValue[]>();
  const reverseLists = new Map([...cellLists].map(([physical, list]) => [list, physical]));
  for (const c of controls) {
    const physical = reverseLists.get(c.list as number);
    if (physical === undefined) continue;
    const prior = inventory.get(physical) ?? [];
    prior.push(c); inventory.set(physical, prior);
  }
  const graph = new Map<number, number[]>();
  let budget = count;
  for (const [physical, coordinate] of coordinates) {
    const owned = inventory.get(physical) ?? [], field = tableFields.get(physical);
    if (!field) {
      if (owned.length !== 0) return "unknown";
      continue; // no controls AND no field ranges: proven plain cached value
    }
    if (owned.length !== 1 || owned[0]!.para !== 0 || owned[0]!.controlIndex !== 0 || owned[0]!.ctrlId !== ""
      || typeof field.command !== "string" || typeof field.value !== "string" || field.startCharIdx !== 0
      || field.endCharIdx !== field.value.length) return "unknown";
    const match = /^(=.{1,256})\?\?%g,;;([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/.exec(field.command);
    if (!match || match[2] !== field.value || !Number.isFinite(Number(field.value))) return "unknown";
    const length = doc.getCellParagraphLength(at.section, cell.parentParagraph, cell.control, physical, 0);
    if (length !== field.value.length || doc.getTextInCell(at.section, cell.parentParagraph, cell.control, physical, 0, 0, length) !== field.value) return "unknown";
    const row = Math.floor(coordinate / cols), col = coordinate % cols;
    // The existing read-only engine validator proves sole full-paragraph formula
    // ownership, including field range/control linkage not exposed in the list.
    const probe = read(doc.validateTableFormulaField(at.section, cell.parentParagraph, cell.control, row, col, "=0"));
    if (!record(probe) || Object.keys(probe).sort().join(",") !== "changed,command,fieldId,ok,text"
      || typeof probe.changed !== "boolean" || probe.ok !== true || probe.fieldId !== field.fieldId || probe.text !== "0" || probe.command !== "=0??%g,;;0") return "unknown";
    const rawEdges = formulaDependencies(match[1]!, { row, col, rows, cols });
    const edges = rawEdges?.filter(edge => coordinateKeys.has(edge));
    if (!edges) return "unknown";
    if (coordinate !== destination) { budget += rawEdges!.length; graph.set(coordinate, edges); }
    if (budget > MAX_FORMULA_CELL_VISITS) return "unknown";
  }
  const rawEdges = formulaDependencies(proposed, { row: Math.floor(destination / cols), col: destination % cols, rows, cols });
  const edges = rawEdges?.filter(edge => coordinateKeys.has(edge));
  if (!edges || budget + rawEdges!.length > MAX_FORMULA_CELL_VISITS) return "unknown";
  graph.set(destination, edges); // replace, never append the old destination edges
  // Iterative DFS over dependencies reachable from the destination. An already
  // imported cycle reached by the new expression is unsafe too. Bounded V+E.
  const colors = new Map<number, number>();
  const stack = [{ node: destination, next: 0 }]; colors.set(destination, 1);
  while (stack.length) {
    const frame = stack[stack.length - 1]!, children = graph.get(frame.node) ?? [];
    if (frame.next === children.length) { colors.set(frame.node, 2); stack.pop(); continue; }
    const child = children[frame.next++]!;
    if (colors.get(child) === 1) return "cycle";
    if (colors.get(child) === 2) continue;
    colors.set(child, 1); stack.push({ node: child, next: 0 });
  }
  return "safe";
}
