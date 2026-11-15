// Read-only projection of validated top-level table geometry and paragraph ownership.
// Authoritative contracts: field_query.rs collect_fields_and_lists, hwpctrl_sets.rs
// collect_controls, table_ops.rs get_cell (first paragraph, exact anchor coordinate).
// No field-list omission is interpreted as "plain": the complete control inventory
// must independently be empty. Unknown/nested structures fail closed. Covered merged
// coordinates have no value in RHWP (table_ops.rs exact-anchor lookup), not an alias.
import { formulaDependencies, MAX_FORMULA_CELL_VISITS } from "../../../commands/parameters";
import { paragraphFieldMap } from "./fieldOwnership";
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

export function tableFormulaSafety(doc: RhwpDocument, at: DocPosition, proposed: string, fieldId = 0): FormulaSafety {
  try { return project(doc, at, proposed, fieldId); }
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

function project(doc: RhwpDocument, at: DocPosition, proposed: string, fieldId: number): FormulaSafety {
  const cell = at.cell;
  if (!cell || !doc.getCursorModel || !doc.getControls || !doc.getFieldList) return "unknown";
  const table = tableAccess(doc, at);
  if (!table) return "unknown";
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
  // Every field has exact control/range ownership, including partial fields and later paragraphs.
  const allIds = new Set<number>();
  for (const f of fields) {
    if (!index(f.fieldId) || f.fieldId === 0 || allIds.has(f.fieldId)) return "unknown";
    allIds.add(f.fieldId);
  }
  const formulas: { id: number; coordinate: number; expression: string }[] = [];
  const ambiguous = new Set<number>();
  const reverseLists = new Map([...cellLists].map(([physical, list]) => [list, physical]));
  for (const [physical, list] of cellLists) {
    const coordinate = coordinates.get(physical)!;
    for (let p = 0; p < table.paraCount(physical); p++) {
      const mapping = paragraphFieldMap(controls, fields, list, p);
      const length = table.paraLength(physical, p);
      for (const f of mapping.values()) {
        const loc = f.location;
        if (!record(loc) || loc.sectionIndex !== at.section || loc.paraIndex !== cell.parentParagraph
          || !Array.isArray(loc.path) || loc.path.length !== levels.length
          || !levels.every((level, i) => {
            const entry: unknown = (loc.path as unknown[])[i];
            return record(entry) && entry.type === "cell" && entry.controlIndex === level.control
              && entry.cellIndex === (i === levels.length - 1 ? physical : level.cell)
              && entry.paraIndex === (i === levels.length - 1 ? p : level.cellParagraph);
          }) || !index(f.startCharIdx) || !index(f.endCharIdx) || f.endCharIdx > length
          || table.text(physical, p, f.startCharIdx, f.endCharIdx - f.startCharIdx) !== f.value) return "unknown";
        if (f.fieldType === "formula") {
          const cache = cachedFormula(f.command);
          if (!cache || cache.value !== f.value || !Number.isFinite(Number(cache.value))) return "unknown";
          formulas.push({ id: f.fieldId as number, coordinate, expression: cache.expression });
          if (p > 0) ambiguous.add(coordinate);
        } else if (f.fieldType !== "clickhere") return "unknown";
      }
      const owned = controls.filter(c => c.list === list && c.para === p);
      if (owned.some(c => !mapping.has(c) && !((c.ctrlId === "tbl" || c.ctrlId === "gso") && c.ctrlCh === 11))) return "unknown";
      if (p === 0 && mapping.size && !(mapping.size === 1 && owned.length === 1
        && [...mapping.values()][0]!.fieldType === "formula" && [...mapping.values()][0]!.startCharIdx === 0
        && [...mapping.values()][0]!.endCharIdx === length)) ambiguous.add(coordinate);
    }
  }
  if (fields.some(f => reverseLists.has(f.listId as number) && !index(f.paraInList))) return "unknown";
  if (formulas.length > MAX_FORMULA_CELL_VISITS) return "unknown";
  const target = formulas.filter(f => f.id === fieldId);
  if (fieldId && (target.length !== 1 || target[0]!.coordinate !== destination)) return "unknown";
  if (inner.cellParagraph > 0) ambiguous.add(destination);
  if (inner.cellParagraph === 0 && !fieldId && (table.paraLength(inner.cell, 0) !== 0
    || formulas.some(f => f.coordinate === destination))) ambiguous.add(destination);
  const roots = [...formulas.filter(f => f.id !== fieldId), { id: fieldId, coordinate: destination, expression: proposed }];
  // Cell coordinates group dependencies, never establish field identity. Multiple/partial fields
  // can be roots, but a referenced formula cell must have a single established numeric value.
  const graph = new Map<number, Set<number>>();
  let budget = count;
  for (const f of roots) {
    const edges = formulaDependencies(f.expression, { row: Math.floor(f.coordinate / cols), col: f.coordinate % cols, rows, cols });
    if (!edges || (budget += edges.length) > MAX_FORMULA_CELL_VISITS) return "unknown";
    const set = graph.get(f.coordinate) ?? new Set<number>();
    for (const edge of edges) {
      if (edge === f.coordinate) return "cycle";
      if (!coordinateKeys.has(edge) || ambiguous.has(edge)) return "unknown";
      set.add(edge);
    }
    graph.set(f.coordinate, set);
  }
  const colors = new Map<number, number>();
  for (const root of graph.keys()) {
    if (colors.get(root) === 2) continue;
    const stack = [{ node: root, edges: [...(graph.get(root) ?? [])], next: 0 }]; colors.set(root, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      if (frame.next === frame.edges.length) { colors.set(frame.node, 2); stack.pop(); continue; }
      const child = frame.edges[frame.next++]!;
      if (colors.get(child) === 1) return "cycle";
      if (colors.get(child) === 2) continue;
      colors.set(child, 1); stack.push({ node: child, edges: [...(graph.get(child) ?? [])], next: 0 });
    }
  }
  return "safe";
}

interface PublicationFormula {
  at: DocPosition;
  field: RecordValue;
  inputs: string;
  identity: string;
}
/** Snapshot the owning table's operand text/geometry, not just the formula's paragraph.
 * Unchanged legacy tables remain opaque. Budgets bound the additional publication proof.
 */
export function publicationFormulas(doc: RhwpDocument): Map<number, PublicationFormula> {
  const result = new Map<number, PublicationFormula>();
  if (!doc.getFieldList) return result;
  const fields = read(doc.getFieldList());
  if (!entries(fields)) throw new Error("formula inventory unavailable");
  const tables = new Map<string, string>();
  let visits = 0, chars = 0;
  for (const field of fields) {
    if (field.fieldType !== "formula") continue;
    const loc = field.location;
    if (!index(field.fieldId) || !field.fieldId || result.has(field.fieldId) || !record(loc)
      || !index(loc.sectionIndex) || !index(loc.paraIndex) || !Array.isArray(loc.path)
      || !loc.path.length || loc.path.length > 64) throw new Error("formula owner unavailable");
    const levels = loc.path.map((p: unknown) => {
      if (!record(p) || p.type !== "cell" || !index(p.controlIndex) || !index(p.cellIndex) || !index(p.paraIndex))
        throw new Error("formula cell unavailable");
      return { control: p.controlIndex, cell: p.cellIndex, cellParagraph: p.paraIndex };
    });
    const at: DocPosition = { section: loc.sectionIndex, paragraph: loc.paraIndex, offset: 0,
      cell: { parentParagraph: loc.paraIndex, ...levels[0]!, nested: levels.slice(1) } };
    const table = tableAccess(doc, at);
    if (!table) throw new Error("formula table unavailable");
    const key = JSON.stringify([at.section, at.paragraph, levels.map((p, i) => i === levels.length - 1 ? p.control : p)]);
    let inputs = tables.get(key);
    if (inputs === undefined) {
      const dims = read(table.dims());
      if (!record(dims) || !index(dims.cellCount) || !dims.cellCount
        || dims.cellCount > MAX_FORMULA_CELL_VISITS) throw new Error("formula table budget");
      const cells: unknown[] = [];
      for (let cell = 0; cell < dims.cellCount; cell++) {
        const count = table.paraCount(cell);
        if (!index(count) || !count || (visits += count + 1) > MAX_FORMULA_CELL_VISITS) throw new Error("formula paragraph budget");
        const texts: string[] = [];
        for (let p = 0; p < count; p++) {
          const length = table.paraLength(cell, p);
          if (!index(length) || (chars += length) > MAX_METADATA_BYTES) throw new Error("formula text budget");
          texts.push(table.text(cell, p, 0, length));
        }
        cells.push([read(table.info(cell)), texts]);
      }
      inputs = JSON.stringify([dims, cells]); tables.set(key, inputs);
    }
    result.set(field.fieldId, { at, field, inputs, identity: JSON.stringify(field) });
  }
  return result;
}

/** A publication refusal because a changed formula cache cannot be proven current (explicit recalculation needed). */
export class FormulaCacheRefusal extends Error {}

/** Publication never silently persists a dependent cache after its source changed.
 * Read-only validation reuses the engine evaluator and exact field owner; no ID/range is rewritten.
 * Unsupported legacy formats can still be preserved unchanged, but changed tables fail closed.
 */
export function validatePublicationFormulaCaches(doc: RhwpDocument, baseline: Map<number, PublicationFormula> | null): void {
  for (const [id, current] of publicationFormulas(doc)) {
    const prior = baseline?.get(id);
    if (prior?.inputs === current.inputs && prior.identity === current.identity) continue;
    const { at, field } = current, cache = cachedFormula(field.command);
    if (!cache || !String(field.command).includes("??%g,;;") || field.value !== cache.value
      || !index(field.startCharIdx) || !doc.validateTableFormulaAt) throw new FormulaCacheRefusal("formula cache unverified");
    if (tableFormulaSafety(doc, at, cache.expression, id) !== "safe") throw new FormulaCacheRefusal("formula dependencies unverified");
    const path = [at.cell!, ...(at.cell!.nested ?? [])].map(p => ({ controlIndex: p.control, cellIndex: p.cell, cellParaIndex: p.cellParagraph }));
    const check = read(doc.validateTableFormulaAt(at.section, at.paragraph, JSON.stringify(path), field.startCharIdx, id, cache.expression));
    if (!record(check) || check.ok !== true || check.fieldId !== id || check.changed !== false
      || check.text !== field.value || check.command !== field.command) throw new FormulaCacheRefusal("stale formula cache");
  }
}
