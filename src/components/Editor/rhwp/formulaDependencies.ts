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

/**
 * An existing formula field command `={expression}??{format},;;{cached value}`. Only result formats whose cached value
 * is fully determined are recognized: `%g` (geul/RHWP writes) and Hancom's fixed-point `%.Nf`, N = 0..9 (genuine
 * calc-cell.hwp stores `=AVG(ABOVE)??%.2f,;;2.00`), with the cached value having exactly N decimals. The format only
 * affects display; dependency analysis uses the expression. Any other format stays unknown (fail closed).
 */
export function cachedFormula(command: unknown): { expression: string; value: string } | null {
  if (typeof command !== "string") return null;
  const general = /^(=.{1,256})\?\?%g,;;([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/.exec(command);
  if (general) return { expression: general[1]!, value: general[2]! };
  const fixed = /^(=.{1,256})\?\?%\.([0-9])f,;;(-?\d+(?:\.(\d+))?)$/.exec(command);
  if (!fixed) return null;
  const decimals = Number(fixed[2]);
  if ((fixed[4]?.length ?? 0) !== decimals) return null;
  return { expression: fixed[1]!, value: fixed[3]! };
}

export function tableFormulaSafety(doc: RhwpDocument, at: DocPosition, proposed: string): FormulaSafety {
  try { return project(doc, at, proposed); }
  catch (error) {
    if (error instanceof WebAssembly.RuntimeError) throw error;
    return "unknown";
  }
}
/** Read access to the explicitly owned table of `at`: body-level by (paragraph, control), nested by path. */
function tableAccess(doc: RhwpDocument, at: DocPosition) {
  const cell = at.cell!, levels = [cell, ...(cell.nested ?? [])], inner = levels[levels.length - 1]!;
  const s = at.section, host = cell.parentParagraph;
  if (levels.length === 1) {
    if (!doc.getCellInfo || !doc.validateTableFormulaField) return null;
    return { levels, inner,
      dims: () => doc.getTableDimensions(s, host, cell.control),
      info: (k: number) => doc.getCellInfo!(s, host, cell.control, k),
      paraCount: (k: number) => doc.getCellParagraphCount(s, host, cell.control, k),
      paraLength: (k: number, p: number) => doc.getCellParagraphLength(s, host, cell.control, k, p),
      text: (k: number, p: number, o: number, n: number) => doc.getTextInCell(s, host, cell.control, k, p, o, n),
      validate: (r: number, c: number, f: string) => doc.validateTableFormulaField!(s, host, cell.control, r, c, f) };
  }
  if (!doc.getTableDimensionsByPath || !doc.getCellInfoByPath || !doc.getCellParagraphCountByPath || !doc.getCellParagraphLengthByPath
    || !doc.getTextInCellByPath || !doc.validateTableFormulaFieldByPath) return null;
  const path = (k: number, p = 0) => JSON.stringify(levels.map((l, i) => i === levels.length - 1
    ? { controlIndex: l.control, cellIndex: k, cellParaIndex: p } : { controlIndex: l.control, cellIndex: l.cell, cellParaIndex: l.cellParagraph }));
  return { levels, inner,
    dims: () => doc.getTableDimensionsByPath!(s, host, path(0)),
    info: (k: number) => doc.getCellInfoByPath!(s, host, path(k)),
    paraCount: (k: number) => doc.getCellParagraphCountByPath!(s, host, path(k)),
    paraLength: (k: number, p: number) => doc.getCellParagraphLengthByPath!(s, host, path(k, p)),
    text: (k: number, p: number, o: number, n: number) => doc.getTextInCellByPath!(s, host, path(k, p), o, n),
    validate: (r: number, c: number, f: string) => doc.validateTableFormulaFieldByPath!(s, host, path(0), r, c, f) };
}

function project(doc: RhwpDocument, at: DocPosition, proposed: string): FormulaSafety {
  const cell = at.cell;
  if (!cell || !doc.getCursorModel || !doc.getControls || !doc.getFieldList) return "unknown";
  const table = tableAccess(doc, at);
  if (!table || table.inner.cellParagraph !== 0) return "unknown";
  const { levels, inner } = table;
  const dimensions = read(table.dims());
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
  // The table's host cursor list: the root (body table) or the parent cell's list, resolved level by
  // level through explicit ownership (never by list number alone).
  let hostList = 0, hostPara = cell.parentParagraph;
  for (const level of levels.slice(0, -1)) {
    const owner = model.lists.filter(l => l.isCell === true && l.sectionIndex === at.section && l.hostListId === hostList
      && l.hostPara === hostPara && l.controlIndex === level.control && l.cellIndex === level.cell);
    if (owner.length !== 1) return "unknown";
    hostList = owner[0]!.listId as number; hostPara = level.cellParagraph;
  }
  const lists = model.lists.filter(l => l.sectionIndex === at.section && l.hostListId === hostList
    && l.hostPara === hostPara && l.controlIndex === inner.control);
  if (lists.length !== count) return "unknown";
  const cellLists = new Map<number, number>(), coordinates = new Map<number, number>();
  const listIds = new Set<number>(), coordinateKeys = new Set<number>();
  const coverage = new Set<number>();
  let paragraphs = 0;
  for (const l of lists) {
    const physical = l.cellIndex as number;
    if (l.isCell !== true || (!index(l.paraCount) || l.paraCount === 0) || physical >= count || cellLists.has(physical)
      || !index(l.listId) || l.listId < 2 || listIds.has(l.listId)) return "unknown";
    const geometry = read(table.info(physical));
    if (!record(geometry) || !index(geometry.row) || !index(geometry.col) || geometry.row >= rows || geometry.col >= cols
      || !index(geometry.rowSpan) || !index(geometry.colSpan) || !geometry.rowSpan || !geometry.colSpan
      || geometry.row + geometry.rowSpan > rows || geometry.col + geometry.colSpan > cols
      || l.row !== geometry.row || l.col !== geometry.col
      || l.rowSpan !== geometry.rowSpan || l.colSpan !== geometry.colSpan || l.cellCount !== count
      || table.paraCount(physical) !== l.paraCount) return "unknown";
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
  const destination = coordinates.get(inner.cell);
  if (destination === undefined) return "unknown";
  const tableFields = new Map<number, RecordValue>();
  const tailFields = new Set<string>();
  const ids = new Set<number>();
  for (const f of fields) {
    const loc = f.location as RecordValue;
    if (loc.sectionIndex !== at.section || loc.paraIndex !== cell.parentParagraph) continue;
    if (loc.path === undefined) continue; // a body field is not a cell value
    if (!Array.isArray(loc.path) || !loc.path.every(record)) return "unknown";
    // Fields of other controls are not cell values; a field below this table's cells (deeper
    // nesting) still falls through to the exact-shape checks and fails closed.
    if (loc.path.length === 0) return "unknown";
    if (loc.path.length < levels.length) continue;
    if (!levels.slice(0, -1).every((level, i) => {
      const entry = (loc.path as RecordValue[])[i]!;
      return entry.type === "cell" && entry.controlIndex === level.control && entry.cellIndex === level.cell && entry.paraIndex === level.cellParagraph;
    })) continue;
    const part = loc.path[levels.length - 1] as RecordValue;
    if (!part || !index(part.controlIndex)) return "unknown";
    if (part.controlIndex !== inner.control) continue;
    // A field inside a child table of one of these cells belongs to that table's own grid and lives in its
    // cell lists (not this table's), so it never contributes to this table's cell values.
    const deeper = (loc.path as RecordValue[])[levels.length];
    if (deeper && deeper.type === "cell" && part.type === "cell") continue;
    // RHWP evaluates and replaces paragraph zero only. Only independently
    // identified ordinary ClickHere tails are admitted here; unfamiliar/nested
    // controls still require additional preservation implementation/evidence.
    if (part.type === "cell" && index(part.paraIndex) && part.paraIndex > 0
      && index(part.cellIndex) && cellLists.has(part.cellIndex)) {
      const key = `${f.listId}/${part.paraIndex}`;
      if (loc.path.length !== levels.length || f.fieldType !== "clickhere" || f.cellField !== false || f.paraInList !== part.paraIndex
        || f.listId !== cellLists.get(part.cellIndex) || !index(f.fieldId) || f.fieldId === 0 || ids.has(f.fieldId)
        || typeof f.command !== "string" || !f.command.startsWith("Clickhere:") || tailFields.has(key)
        || ![f.name, f.guide, f.value].every(v => typeof v === "string") || typeof f.editableInForm !== "boolean"
        || !index(f.startCharIdx) || !index(f.endCharIdx) || f.startCharIdx > f.endCharIdx
        || part.paraIndex >= table.paraCount(part.cellIndex)) return "unknown";
      const length = table.paraLength(part.cellIndex, part.paraIndex);
      if (f.endCharIdx > length || Array.from(f.value as string).length !== f.endCharIdx - f.startCharIdx
        || table.text(part.cellIndex, part.paraIndex, f.startCharIdx, f.endCharIdx - f.startCharIdx) !== f.value) return "unknown";
      ids.add(f.fieldId); tailFields.add(key);
      continue;
    }
    if (loc.path.length !== levels.length || part.type !== "cell" || part.paraIndex !== 0 || !index(part.cellIndex)
      || !cellLists.has(part.cellIndex) || tableFields.has(part.cellIndex) || f.fieldType !== "formula" || f.cellField !== false
      || !index(f.fieldId) || f.fieldId === 0 || ids.has(f.fieldId) || f.listId !== cellLists.get(part.cellIndex)
      || f.paraInList !== 0) return "unknown";
    ids.add(f.fieldId); tableFields.set(part.cellIndex, f);
  }
  const inventory = new Map<number, RecordValue[]>();
  const observedTails = new Set<string>();
  const reverseLists = new Map([...cellLists].map(([physical, list]) => [list, physical]));
  // Stage 2: identified child tables and drawing objects own no paragraph text (RHWP get_cell parses the
  // paragraph text only), so they never change a cell's value. Blank-id (field) controls still need an exact
  // field-list identity; any other control kind stays unknown.
  const objectOnly = (c: RecordValue) => (c.ctrlId === "tbl" || c.ctrlId === "gso") && c.ctrlCh === 11;
  for (const c of controls) {
    const physical = reverseLists.get(c.list as number);
    if (physical === undefined) continue;
    if (objectOnly(c)) {
      if (tableFields.has(physical) && c.para === 0) return "unknown"; // a formula cell holds only its field
      continue;
    }
    if ((c.para as number) > 0) {
      const key = `${c.list}/${c.para}`;
      if (!tailFields.has(key) || observedTails.has(key) || c.ctrlId !== "" || c.ctrlCh !== 0 || c.userDesc !== ""
        || c.controlIndex !== 0 || c.pos !== 0 || !record(c.props) || Object.keys(c.props).length) return "unknown";
      observedTails.add(key);
      continue;
    }
    const prior = inventory.get(physical) ?? [];
    prior.push(c); inventory.set(physical, prior);
  }
  if (observedTails.size !== tailFields.size) return "unknown";
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
    const match = cachedFormula(field.command);
    if (!match || match.value !== field.value || !Number.isFinite(Number(field.value))) return "unknown";
    const length = table.paraLength(physical, 0);
    if (length !== field.value.length || table.text(physical, 0, 0, length) !== field.value) return "unknown";
    const row = Math.floor(coordinate / cols), col = coordinate % cols;
    // The existing read-only engine validator proves sole full-paragraph formula
    // ownership, including field range/control linkage not exposed in the list.
    const probe = read(table.validate(row, col, "=0"));
    if (!record(probe) || Object.keys(probe).sort().join(",") !== "changed,command,fieldId,ok,text"
      || typeof probe.changed !== "boolean" || probe.ok !== true || probe.fieldId !== field.fieldId || probe.text !== "0" || probe.command !== "=0??%g,;;0") return "unknown";
    const rawEdges = formulaDependencies(match.expression, { row, col, rows, cols });
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
